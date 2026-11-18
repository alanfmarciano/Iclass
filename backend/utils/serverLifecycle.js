// Servidor fora do ar durante a prova (H3b: CONF-03, OPS-06).
//
// O IClass não tinha como saber quanto tempo ficou parado: o cronômetro das provas
// corria com o servidor desligado (reinício, queda, falta de energia, notebook
// suspenso) e a varredura do boot finalizava quem teve o prazo vencido nesse tempo.
// Este módulo:
// - grava a cada 5 s DATA_DIR/runtime/heartbeat.json = { at, clean, reason, instanceId,
//   pid } (fora do banco e do backup). No boot seguinte, now - at é o tempo fora do ar
//   (a retomada das sessões do H3a-2 também usa: previousRun().downtimeMs);
// - detectGap: com o processo vivo, um intervalo de mais de 30 s sem nenhuma
//   verificação é tempo parado (notebook suspenso, processo congelado);
// - compensateServerOutage: o tempo fora do ar vira uma pausa fechada da aplicação em
//   andamento ({ pausedAt, resumedAt, reason: 'server_outage' }), que todas as contas de
//   prazo já descontam (extendDeadlineByPauses), e fica em application.outages (o
//   Monitor avisa o professor) e na auditoria da prova (exam_application_server_outage).
//   Acima de 15 min o tempo não é devolvido sozinho: fica só o registro, e o professor
//   decide se dá mais tempo. Aplicação em que ninguém tinha mais tempo de prova quando o
//   servidor parou (aplicação esquecida aberta, todos já entregaram) não ganha pausa,
//   registro nem auditoria: não havia tempo a devolver.
// A entrada de auditoria é gravada por recordExamAudit (utils/examFinish.js), como as
// outras entradas de prova lidas pelo registro da aplicação (buildApplicationAuditTrail,
// a exceção do contrato do recordAudit); o rótulo em pt-BR fica em ACTION_LABELS
// (utils/audit.js) e o detalhe em describeExamAudit (utils/gradebook.js).
// Processo (H3c: CONF-12, OPS-06, OPS-07). Também ficam aqui:
// - os códigos de saída do servidor (EXIT_CODES), que o supervisor (backend/supervisor.js)
//   e depois o launcher usam para decidir se religam;
// - o registro dos timers do servidor (registerTimer): todo setInterval do servidor entra
//   aqui com unref(), e o desligamento ordenado limpa todos de uma vez;
// - o desligamento ordenado único (requestShutdown), que o startServer liga aos sinais
//   (SIGINT, SIGTERM, SIGHUP, SIGBREAK), à mensagem {type:'shutdown'} do supervisor, ao
//   botão Reiniciar e à rota de controle do launcher; o fim dele chama
//   markCleanShutdown(reason);
// - o estado do boot (fase, ready, duração, sessões retomadas) e o modo "com problemas"
//   depois de uma exceção não tratada, lidos por /api/health (routes/systemHealth.js);
// - o token da rota de controle (runtime/control.token).
// A saída normal (código 0) sem o requestShutdown (os processos de teste que só sobem o
// prepareServer) continua marcando a parada limpa por um ouvinte de 'exit' daqui.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtimePaths = require('../runtimePaths.js');
const { SERVER_INSTANCE_ID } = require('./sessionConfig.js');
const {
    CLOSED_ATTEMPT_STATUSES,
    SERVER_OUTAGE_PAUSE_REASON,
    applicationPauses,
    extendDeadlineByPauses,
} = require('./examApplications.js');
const { setDeadlineCheck } = require('./examDeadline.js');
const { recordExamAudit } = require('./examFinish.js');
const { logError } = require('./errorLog.js');

const HEARTBEAT_INTERVAL_MS = 5000;
// Mais que isso sem nenhuma verificação com o processo vivo: o computador ficou parado.
// Uma gravação longa ou um pico de carga ficam bem abaixo.
const GAP_THRESHOLD_MS = 30 * 1000;
// Tempo fora do ar devolvido sozinho: até 15 min. Acima disso (servidor desligado entre
// turnos, heartbeat antigo) só fica o registro.
const OUTAGE_MAX_COMPENSATION_MS = 15 * 60 * 1000;
// Menos que 1 s não é queda (o próprio reinício leva mais que isso).
const OUTAGE_MIN_MS = 1000;
const MAX_OUTAGES_KEPT = 20;
// Heartbeat mais novo que isso, de outro processo ainda vivo: outro servidor do IClass
// está no ar com esta mesma pasta de dados (launcher aberto duas vezes). Três batidas.
const LIVE_HEARTBEAT_MAX_AGE_MS = 3 * HEARTBEAT_INTERVAL_MS;
// Teto do tempo adicional de acessibilidade (middlewares.js accessibilityExtraMinutes).
const MAX_ACCESSIBILITY_PERCENT = 200;
const OUTAGE_REASONS = new Set(['restart', 'crash', 'suspended']);
const HEARTBEAT_LOG_INTERVAL_MS = 60 * 1000;

// Para os registros do console.
const OUTAGE_REASON_TEXT = {
    restart: 'reinício',
    crash: 'queda do servidor',
    suspended: 'computador suspenso ou travado',
};

const state = {
    started: false,
    timer: null,
    lastTickAt: null,
    getMemory: null,
    save: null,
    previousRun: null,
    lastOutage: null,
    lastHeartbeatErrorAt: 0,
    // Outro servidor vivo grava o heartbeat desta pasta: este processo não grava o seu,
    // não devolve tempo e não marca parada limpa (o registro é do outro).
    passive: false,
    exitHookInstalled: false,
};

function runtimeDir() {
    return path.join(runtimePaths.DATA_DIR, 'runtime');
}

function heartbeatFile() {
    return path.join(runtimeDir(), 'heartbeat.json');
}

function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

// Hora em ms de um campo gravado como número ou texto ISO (savedAt das tentativas).
function timeValue(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
    if (typeof value !== 'string' || !value.trim()) return null;
    const parsed = /^\d+$/.test(value.trim()) ? Number(value) : Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// Lê o heartbeat deixado pela execução anterior. Nunca lança. found: false quando não
// há arquivo (primeiro boot desta versão, pasta runtime apagada) ou ele não abre;
// downtimeMs: null nesses casos. Relógio que voltou (at no futuro) conta como 0 fora do ar.
function readHeartbeat({ now = Date.now(), file = heartbeatFile() } = {}) {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        return { found: false, missing: !!err && err.code === 'ENOENT', at: null, clean: false, reason: null, instanceId: null, pid: null, downtimeMs: null, clockWentBack: false };
    }
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { data = null; }
    const at = data && typeof data === 'object' ? finiteNumber(data.at) : null;
    if (!(at > 0)) {
        return { found: false, missing: false, unreadable: true, at: null, clean: false, reason: null, instanceId: null, pid: null, downtimeMs: null, clockWentBack: false };
    }
    const elapsed = now - at;
    return {
        found: true,
        missing: false,
        at,
        clean: data.clean === true,
        reason: typeof data.reason === 'string' ? data.reason : null,
        instanceId: typeof data.instanceId === 'string' ? data.instanceId : null,
        pid: finiteNumber(data.pid),
        downtimeMs: Math.max(0, elapsed),
        clockWentBack: elapsed < 0,
    };
}

// O processo existe? process.kill(pid, 0) não envia sinal, só confere (também no
// Windows). EPERM: existe, de outro usuário.
function processAlive(pid) {
    if (!(pid > 0)) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return !!err && err.code === 'EPERM';
    }
}

// O heartbeat é de outro servidor que continua no ar com esta pasta de dados: gravado
// há menos de três batidas, sem parada limpa, por outro processo que ainda existe. Um
// segundo "node backend/server.js" (launcher aberto duas vezes) passa pelo boot inteiro
// antes de descobrir a porta ocupada; sem esta conferência ele gravava no banco uma
// queda que não houve (H3b). Depois de uma queda de verdade o processo antigo não existe
// mais (o supervisor e o launcher só religam depois que ele saiu).
function heartbeatFromLiveInstance(run, { pid = process.pid, isAlive = processAlive } = {}) {
    if (!run || !run.found || run.clean) return false;
    if (!(run.pid > 0) || run.pid === pid) return false;
    if (!(run.downtimeMs <= LIVE_HEARTBEAT_MAX_AGE_MS)) return false;
    return isAlive(run.pid) === true;
}

// Lê o heartbeat da execução anterior uma vez, no boot (antes do primeiro novo), e o
// guarda para previousRun(). otherInstanceAlive: outro servidor vivo usa esta pasta
// (heartbeatFromLiveInstance); este processo fica sem heartbeat próprio (passive).
function loadPreviousRun({ now = Date.now(), isAlive = processAlive } = {}) {
    const run = readHeartbeat({ now });
    run.otherInstanceAlive = heartbeatFromLiveInstance(run, { isAlive });
    state.previousRun = run;
    state.passive = run.otherInstanceAlive;
    if (run.otherInstanceAlive) {
        console.warn(`⚠️ Outro servidor do IClass (processo ${run.pid}) está no ar usando esta mesma pasta de dados: o tempo fora do ar das provas não foi recalculado por este processo. Feche esta janela e use a que já está aberta.`);
    } else if (run.clockWentBack) {
        console.warn('⚠️ O relógio do computador está antes do último registro do servidor: o tempo fora do ar foi contado como zero.');
    }
    return run;
}

function previousRun() {
    return state.previousRun;
}

function reportHeartbeatFailure(err) {
    const now = Date.now();
    if (now - state.lastHeartbeatErrorAt < HEARTBEAT_LOG_INTERVAL_MS) return;
    state.lastHeartbeatErrorAt = now;
    try { logError('[HEARTBEAT] Não foi possível gravar runtime/heartbeat.json', err); } catch (e) { /* nunca lança */ }
}

// Grava o heartbeat. Arquivo temporário e rename (o arquivo nunca fica pela metade); se
// o rename falhar (antivírus ou OneDrive segurando o arquivo no Windows: EPERM, EBUSY),
// escreve direto. Nunca lança: devolve se gravou.
function writeHeartbeat({ clean = false, reason = null, now = Date.now() } = {}) {
    const file = heartbeatFile();
    const payload = JSON.stringify({ at: now, clean: clean === true, reason: reason || null, instanceId: SERVER_INSTANCE_ID, pid: process.pid });
    try {
        fs.mkdirSync(runtimeDir(), { recursive: true });
    } catch (err) {
        reportHeartbeatFailure(err);
        return false;
    }
    const temporary = `${file}.tmp`;
    try {
        fs.writeFileSync(temporary, payload);
        fs.renameSync(temporary, file);
        return true;
    } catch (err) {
        try {
            fs.writeFileSync(file, payload);
            try { fs.rmSync(temporary, { force: true }); } catch (e) { /* fica para o próximo */ }
            return true;
        } catch (fallbackError) {
            reportHeartbeatFailure(fallbackError);
            return false;
        }
    }
}

// Início da aplicação em ms (startsAt; nas antigas, startedAt em ISO).
function applicationStartedAt(application) {
    const startsAt = finiteNumber(application && application.startsAt);
    if (startsAt > 0) return startsAt;
    return timeValue(application && application.startedAt);
}

// A aplicação estava correndo o cronômetro durante [from, to]: em andamento, ou na sala
// de espera que já tinha terminado (o aluno já podia responder). Pausada (cronômetro
// congelado), na sala de espera, encerrada e sem cronômetro ficam de fora.
function applicationTimerRunning(application, to) {
    if (!application || application.timerEnabled === false) return false;
    const startedAt = applicationStartedAt(application);
    if (!(startedAt > 0) || !(startedAt < to)) return false;
    if (application.status === 'running') return true;
    return application.status === 'waiting';
}

// Maior savedAt das tentativas em andamento da aplicação: o servidor estava no ar até ali.
function lastAttemptSaveAt(memory, applicationId) {
    let latest = null;
    Object.values((memory && memory.studentExamState) || {}).forEach(attempt => {
        if (!attempt || attempt.applicationId !== applicationId || CLOSED_ATTEMPT_STATUSES.has(attempt.status)) return;
        const savedAt = timeValue(attempt.savedAt);
        if (savedAt && (!latest || savedAt > latest)) latest = savedAt;
    });
    return latest;
}

// Maior tempo adicional de acessibilidade entre os alunos cadastrados, em minutos
// (mesma conta de middlewares.js accessibilityExtraMinutes). De todos os alunos, não só
// da turma: na dúvida, devolve o tempo.
function maxAccessibilityExtraMinutes(memory, durationMinutes) {
    const duration = Number(durationMinutes || 0);
    if (!(duration > 0)) return 0;
    return (Array.isArray(memory && memory.students) ? memory.students : []).reduce((max, student) => {
        const access = student && student.accessibility;
        if (!access || access.tempoAdicional !== true) return max;
        const percent = Number(access.tempoAdicionalPercent);
        if (!Number.isFinite(percent) || percent <= 0) return max;
        return Math.max(max, Math.ceil(duration * Math.min(percent, MAX_ACCESSIBILITY_PERCENT) / 100));
    }, 0);
}

// Alguém ainda tinha tempo de prova nesta aplicação no instante em que o servidor parou
// (at)? Mesma conta de prazo de examDeadline.computeAttemptDeadline (início + duração +
// ajustes + pausas), sem a pausa da queda:
// - uma tentativa aberta e já começada cujo prazo era depois de at;
// - no cronômetro coletivo, quem ainda vai começar conta do início da aplicação: o prazo
//   coletivo com o maior "+N min" individual guardado e o maior tempo de acessibilidade.
// No cronômetro por tentativa, quem ainda não começou não perde nada (o tempo dele só
// começa depois da queda). Sem duração, a prova não tem prazo: nada a devolver.
function someoneHadTimeLeft(memory, application, at) {
    const duration = Number(application.durationMinutes || 0);
    if (!(duration > 0)) return false;
    const global = Number(application.globalTimeAdjustment || 0) || 0;
    const deadlineFrom = (startedAt, extraMinutes) => {
        const base = startedAt + Math.max(0, duration + global + extraMinutes) * 60000;
        return extendDeadlineByPauses(application, startedAt, base, at);
    };
    const open = Object.values((memory && memory.studentExamState) || {}).some(attempt => {
        if (!attempt || attempt.applicationId !== application.id || CLOSED_ATTEMPT_STATUSES.has(attempt.status)) return false;
        const startedAt = Number(attempt.startedAt);
        if (!(startedAt > 0)) return false;
        const extra = (Number(attempt.individualTimeAdjustment || 0) || 0) + (Number(attempt.accessibilityExtraMinutes || 0) || 0);
        return deadlineFrom(startedAt, extra) > at;
    });
    if (open) return true;
    if (application.timerMode === 'per_attempt') return false;
    const startsAt = applicationStartedAt(application);
    if (!(startsAt > 0)) return false;
    const individual = Object.values(application.studentAdjustments && typeof application.studentAdjustments === 'object' ? application.studentAdjustments : {})
        .map(Number)
        .filter(Number.isFinite)
        .reduce((max, value) => Math.max(max, value), 0);
    return deadlineFrom(startsAt, individual + maxAccessibilityExtraMinutes(memory, duration)) > at;
}

function normalizedReason(reason) {
    return OUTAGE_REASONS.has(reason) ? reason : 'crash';
}

// Devolve às aplicações em andamento o tempo em que o servidor ficou fora do ar entre
// from e to. O início efetivo de cada uma é o mais tarde entre from, o início da
// aplicação, o fim da última pausa e o último salvamento de uma tentativa dela (o
// servidor estava no ar até ali: um heartbeat velho não devolve tempo a mais). Aplicação
// em que ninguém tinha mais tempo nesse início (someoneHadTimeLeft) fica como está: sem
// pausa, sem registro e sem auditoria a cada reinício. Só altera a memória (quem chama
// grava). Devolve { changed, applications: [...] }.
function compensateServerOutage(memory, { from, to, reason = 'crash', maxMs = OUTAGE_MAX_COMPENSATION_MS, minMs = OUTAGE_MIN_MS } = {}) {
    const result = { changed: false, applications: [] };
    const start = finiteNumber(from);
    const end = finiteNumber(to);
    if (!memory || !(start > 0) || !(end > 0) || !(end > start)) return result;
    const outageReason = normalizedReason(reason);
    (Array.isArray(memory.examApplications) ? memory.examApplications : []).forEach(application => {
        if (!applicationTimerRunning(application, end)) return;
        const pauses = applicationPauses(application);
        if (pauses.some(pause => !pause.resumedAt)) return;
        const lastPauseEnd = pauses.reduce((latest, pause) => Math.max(latest, pause.resumedAt || 0), 0);
        const effectiveFrom = Math.max(start, applicationStartedAt(application), lastPauseEnd, lastAttemptSaveAt(memory, application.id) || 0);
        const durationMs = end - effectiveFrom;
        if (!(durationMs >= minMs)) return;
        if (!someoneHadTimeLeft(memory, application, effectiveFrom)) return;
        const compensated = durationMs <= maxMs;
        if (compensated) {
            if (!Array.isArray(application.pauses)) application.pauses = [];
            application.pauses.push({ pausedAt: effectiveFrom, resumedAt: end, reason: SERVER_OUTAGE_PAUSE_REASON });
        }
        const outage = { from: effectiveFrom, to: end, durationMs, reason: outageReason, compensated };
        application.outages = [...(Array.isArray(application.outages) ? application.outages : []), outage].slice(-MAX_OUTAGES_KEPT);
        recordExamAudit(memory, 'exam_application_server_outage', application, 'sistema', {
            from: effectiveFrom,
            to: end,
            durationMs,
            reason: outageReason,
            compensated,
            maxMinutes: Math.round(maxMs / 60000),
        });
        result.changed = true;
        result.applications.push({
            applicationId: application.id,
            examKey: application.examKey,
            studentClass: application.studentClass,
            courseId: application.courseId || null,
            ...outage,
        });
    });
    if (result.changed) {
        state.lastOutage = { at: new Date(end).toISOString(), reason: outageReason, applications: result.applications };
    }
    return result;
}

function describeOutageLog(outcome, reason) {
    const compensated = outcome.applications.filter(item => item.compensated);
    const kept = outcome.applications.filter(item => !item.compensated);
    const seconds = item => Math.round(item.durationMs / 1000);
    const parts = [];
    if (compensated.length) parts.push(`tempo devolvido a ${compensated.length} prova(s) em andamento (${compensated.map(seconds).join(', ')} s)`);
    if (kept.length) parts.push(`${kept.length} prova(s) com mais de 15 min fora do ar ficaram sem devolução automática (veja o Monitor)`);
    return `⏸️  Servidor fora do ar (${OUTAGE_REASON_TEXT[reason] || reason}): ${parts.join('; ')}.`;
}

// Boot: o tempo desde o último heartbeat da execução anterior até agora. Sem heartbeat,
// não compensa (registra no console quando há prova em andamento com cronômetro).
function compensateBootOutage(memory, run = state.previousRun, { now = Date.now() } = {}) {
    // Outro servidor vivo nesta pasta: não houve queda (o aviso já saiu no console).
    if (run && run.otherInstanceAlive) return { changed: false, applications: [], otherInstanceAlive: true };
    if (!run || !run.found) {
        const running = (Array.isArray(memory && memory.examApplications) ? memory.examApplications : [])
            .some(application => applicationTimerRunning(application, now));
        if (running) console.warn('⚠️ Não há registro de quando o servidor parou (runtime/heartbeat.json): o tempo fora do ar não foi devolvido às provas em andamento. Se precisar, dê mais tempo pelo Monitor.');
        return { changed: false, applications: [] };
    }
    // Parada pedida é 'reinício'; a saída depois de uma exceção não tratada (reason
    // 'fatal', H3c) grava o heartbeat limpo, mas foi queda.
    const reason = run.clean && run.reason !== 'fatal' ? 'restart' : 'crash';
    const outcome = compensateServerOutage(memory, { from: run.at, to: now, reason });
    if (outcome.changed) console.log(describeOutageLog(outcome, reason));
    return outcome;
}

function persist() {
    if (typeof state.save !== 'function') return;
    try {
        const pending = state.save();
        if (pending && typeof pending.catch === 'function') {
            pending.catch(err => { if (!err || err.code !== 'ICLASS_DB_WRITE') logError('tempo fora do ar das provas', err); });
        }
    } catch (err) {
        logError('tempo fora do ar das provas', err);
    }
}

// Com o processo vivo: mais de 30 s desde a última verificação é tempo parado
// (computador suspenso, processo congelado), devolvido como queda 'suspended'. Roda a
// cada heartbeat, no início da varredura do fim do tempo e antes de toda conta de prazo
// (setDeadlineCheck). Relógio que voltou só reinicia a contagem. Devolve o resultado da
// compensação, ou null.
function detectGap(now = Date.now()) {
    if (!state.started || state.lastTickAt == null) return null;
    const previous = state.lastTickAt;
    state.lastTickAt = now;
    const elapsed = now - previous;
    if (!(elapsed > GAP_THRESHOLD_MS)) return null;
    const memory = typeof state.getMemory === 'function' ? state.getMemory() : null;
    const outcome = compensateServerOutage(memory, { from: previous, to: now, reason: 'suspended' });
    if (outcome.changed) {
        console.log(describeOutageLog(outcome, 'suspended'));
        persist();
    }
    return outcome;
}

function tick() {
    const now = Date.now();
    detectGap(now);
    writeHeartbeat({ now });
}

// Começa o heartbeat (no boot, depois da compensação e da primeira varredura): grava um
// agora e outro a cada 5 s, e liga a verificação de tempo parado antes das contas de
// prazo. getMemory: a memória do banco; save: grava (tarefa de fundo, { detached: true }).
// now: o "agora" da última verificação (só para testes).
function startHeartbeat({ getMemory, save, intervalMs = HEARTBEAT_INTERVAL_MS, now = Date.now() } = {}) {
    stopHeartbeat();
    // Outro servidor vivo grava o heartbeat desta pasta (loadPreviousRun): este processo
    // não escreve por cima dele nem devolve tempo (seria contado duas vezes).
    if (state.passive) return null;
    installExitHook();
    state.started = true;
    state.getMemory = getMemory || null;
    state.save = save || null;
    state.lastTickAt = now;
    writeHeartbeat({ now });
    state.timer = registerTimer('heartbeat', setInterval(tick, Math.max(1000, Number(intervalMs) || HEARTBEAT_INTERVAL_MS)));
    setDeadlineCheck(() => detectGap(Date.now()));
    return state.timer;
}

function stopHeartbeat() {
    if (state.timer) {
        clearInterval(state.timer);
        unregisterTimer('heartbeat', state.timer);
    }
    state.timer = null;
    state.started = false;
    state.lastTickAt = null;
    setDeadlineCheck(null);
}

// Fim do desligamento ordenado: o próximo boot sabe que foi parada pedida (reason
// 'stop', 'restart', 'admin_restart' ou 'fatal'), não queda. Só grava se o heartbeat foi
// iniciado (servidor de verdade, não o createApp dos testes).
function markCleanShutdown(reason = 'stop') {
    if (!state.started || state.passive) return false;
    stopHeartbeat();
    return writeHeartbeat({ clean: true, reason });
}

// Rede de segurança do requestShutdown (que já grava a parada limpa no fim do
// desligamento ordenado): o processo que sai com código 0 com o heartbeat ainda
// iniciado parou porque pediram (os processos de teste que só sobem o prepareServer e
// saem sozinhos), e o próximo boot registra "reinício", não "queda do servidor". O
// desligamento pedido durante o boot para o heartbeat antes de sair (stopHeartbeat) e
// não passa por aqui. Outro código (erro no boot, erro fatal) e o processo morto à força
// (kill -9, taskkill /f, falta de energia) também não, e contam como queda. Síncrono: no
// 'exit' só dá para gravar com writeFileSync.
function onProcessExit(code) {
    if (code !== 0) return;
    try { markCleanShutdown('stop'); } catch (e) { /* nunca lança na saída */ }
}

function installExitHook() {
    if (state.exitHookInstalled) return;
    state.exitHookInstalled = true;
    process.on('exit', onProcessExit);
}

// ---------------------------------------------------------------------------
// Processo (H3c)
// ---------------------------------------------------------------------------

// Códigos de saída do servidor (contrato da fase 2). O supervisor religa só no 1 (com
// espera crescente) e no 75 (na hora); 2 e 3 não adiantam repetir.
const EXIT_CODES = Object.freeze({
    OK: 0,          // parada normal (Ctrl+C, SIGTERM, fechar a janela, rota de controle)
    ERROR: 1,       // erro fatal em execução ou falha passageira ao abrir o banco
    CONFIG: 2,      // configuração: porta ocupada, build ausente ou desatualizado
    DB_CORRUPT: 3,  // banco danificado (ICLASS_DB_CORRUPT): restaurar um backup
    RESTART: 75,    // reinício pedido (botão Reiniciar ou launcher) sob o supervisor
});
// Teto do desligamento ordenado: passado isso, sai com 1 (algo travou).
const SHUTDOWN_TIMEOUT_MS = 10 * 1000;
const SHUTDOWN_REASONS = new Set(['stop', 'restart', 'admin_restart', 'fatal']);

const processState = {
    timers: new Map(),
    shutdownHandler: null,
    shutdownPromise: null,
    shutdownRequest: null,
    degraded: null,
    boot: { phase: 'loading', ready: false, startedAt: Date.now(), readyAt: null, bootDurationMs: null, sessionsRestored: null },
    controlToken: null,
};

// Registra um timer do servidor (setInterval) pelo nome: unref() (não segura o processo
// vivo) e o desligamento ordenado limpa todos (clearTimers). O mesmo nome substitui o
// anterior, que é parado. Devolve o próprio handle.
function registerTimer(name, handle) {
    if (!handle) return handle;
    const key = String(name || 'timer');
    const previous = processState.timers.get(key);
    if (previous && previous !== handle) clearInterval(previous);
    if (typeof handle.unref === 'function') handle.unref();
    processState.timers.set(key, handle);
    return handle;
}

function unregisterTimer(name, handle) {
    const key = String(name || 'timer');
    if (!handle || processState.timers.get(key) === handle) processState.timers.delete(key);
}

// Para todos os timers registrados (e o heartbeat). Devolve os nomes parados.
function clearTimers() {
    const names = [...processState.timers.keys()];
    processState.timers.forEach(handle => { try { clearInterval(handle); } catch (e) { /* já parado */ } });
    processState.timers.clear();
    // O heartbeat para de bater, mas continua "iniciado": o fim do desligamento ainda
    // grava a parada limpa nele (markCleanShutdown).
    if (state.timer) {
        try { clearInterval(state.timer); } catch (e) { /* já parado */ }
        state.timer = null;
    }
    return names;
}

function registeredTimers() {
    return [...processState.timers.keys()];
}

// O servidor roda sob o supervisor (backend/supervisor.js)?
function isSupervised(env = process.env) {
    return env.ICLASS_SUPERVISED === '1';
}

// O que o supervisor passou ao filho: quantos reinícios já houve, como o anterior saiu e
// quantas quedas fatais nos últimos 10 min.
function supervisorInfo(env = process.env) {
    const count = value => {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
    };
    const lastExit = String(env.ICLASS_SUPERVISOR_LAST_EXIT || '').trim();
    return {
        supervised: isSupervised(env),
        restarts: count(env.ICLASS_SUPERVISOR_RESTARTS),
        recentFatals: count(env.ICLASS_SUPERVISOR_RECENT_FATALS),
        lastExit: lastExit || null,
        // Este processo nasceu de um reinício (supervisor ou o Reiniciar sem supervisor):
        // a porta pode demorar um pouco a ser liberada pelo processo anterior.
        relaunched: env.ICLASS_RESTARTED === '1' || count(env.ICLASS_SUPERVISOR_RESTARTS) > 0,
    };
}

// Quem faz o desligamento de verdade (o startServer). fn({ restart, reason }) devolve uma
// promessa; null tira o registro.
function setShutdownHandler(fn) {
    processState.shutdownHandler = typeof fn === 'function' ? fn : null;
    if (!processState.shutdownHandler) {
        processState.shutdownPromise = null;
        processState.shutdownRequest = null;
    }
}

function hasShutdownHandler() {
    return typeof processState.shutdownHandler === 'function';
}

// Desligamento ordenado único (sinais, supervisor, Reiniciar, rota de controle, erro
// fatal). Idempotente: o segundo pedido recebe a mesma promessa do primeiro. Sem handler
// registrado (createApp nos testes) devolve false e não faz nada.
function requestShutdown({ restart = false, reason } = {}) {
    if (!hasShutdownHandler()) return false;
    if (processState.shutdownPromise) return processState.shutdownPromise;
    const normalized = SHUTDOWN_REASONS.has(reason) ? reason : (restart ? 'restart' : 'stop');
    processState.shutdownRequest = { restart: restart === true, reason: normalized, at: Date.now() };
    processState.shutdownPromise = Promise.resolve()
        .then(() => processState.shutdownHandler({ restart: restart === true, reason: normalized }));
    return processState.shutdownPromise;
}

function shutdownRequested() {
    return processState.shutdownRequest ? { ...processState.shutdownRequest } : null;
}

// Depois de uma exceção não tratada o processo continua no ar em estado incerto:
// /api/health responde 'degraded' (com problemas).
function markDegraded(reason) {
    processState.degraded = { at: new Date().toISOString(), reason: String(reason || 'erro') };
}

function degradedState() {
    return processState.degraded ? { ...processState.degraded } : null;
}

// Fases do boot para o /api/health de quem está esperando o servidor: 'loading'
// (lendo o banco), 'restoring' (sessões e tempo fora do ar), 'checking' (varredura do
// fim do tempo) e, no fim, ready.
function setBootPhase(phase) {
    processState.boot.phase = String(phase || 'loading');
}

function markReady({ sessionsRestored = null, now = Date.now() } = {}) {
    processState.boot.ready = true;
    processState.boot.phase = 'ready';
    processState.boot.readyAt = now;
    processState.boot.bootDurationMs = Math.max(0, now - processState.boot.startedAt);
    if (sessionsRestored) processState.boot.sessionsRestored = { ...sessionsRestored };
}

function bootState() {
    return { ...processState.boot, sessionsRestored: processState.boot.sessionsRestored ? { ...processState.boot.sessionsRestored } : null };
}

// Só para os testes que sobem o app sem o startServer.
function resetProcessState() {
    clearTimers();
    processState.shutdownHandler = null;
    processState.shutdownPromise = null;
    processState.shutdownRequest = null;
    processState.degraded = null;
    processState.boot = { phase: 'loading', ready: false, startedAt: Date.now(), readyAt: null, bootDurationMs: null, sessionsRestored: null };
}

function controlTokenFile() {
    return path.join(runtimeDir(), 'control.token');
}

// Token da rota de controle (POST /api/system/control): 32 bytes novos a cada boot em
// runtime/control.token, só legível pelo usuário (0600). O launcher lê o arquivo e manda o
// conteúdo no cabeçalho x-iclass-control, do próprio computador. Nunca lança: devolve o
// token ou null.
function writeControlToken() {
    const token = crypto.randomBytes(32).toString('hex');
    try {
        fs.mkdirSync(runtimeDir(), { recursive: true });
        const file = controlTokenFile();
        try { fs.rmSync(file, { force: true }); } catch (e) { /* escreve por cima */ }
        fs.writeFileSync(file, token, { mode: 0o600 });
        try { fs.chmodSync(file, 0o600); } catch (e) { /* Windows: sem modo Unix */ }
        processState.controlToken = token;
        return token;
    } catch (err) {
        try { logError('[CONTROLE] Não foi possível gravar runtime/control.token', err); } catch (e) { /* nunca lança */ }
        processState.controlToken = null;
        return null;
    }
}

// O token que vale agora: o do arquivo (o que o launcher lê). Sem arquivo, nenhum.
function readControlToken() {
    try {
        const value = fs.readFileSync(controlTokenFile(), 'utf8').trim();
        return /^[0-9a-f]{64}$/.test(value) ? value : null;
    } catch (e) {
        return null;
    }
}

function controlTokenMatches(candidate) {
    const expected = readControlToken();
    const given = typeof candidate === 'string' ? candidate.trim() : '';
    if (!expected || !given || given.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

// Apaga o token no desligamento: o arquivo velho não serve para o próximo processo.
function removeControlToken() {
    if (!processState.controlToken) return;
    try {
        if (readControlToken() === processState.controlToken) fs.rmSync(controlTokenFile(), { force: true });
    } catch (e) { /* o próximo boot escreve outro */ }
    processState.controlToken = null;
}

function supervisorPidFile() {
    return path.join(runtimeDir(), 'supervisor.pid');
}

// O servidor percebeu que o supervisor morreu (canal IPC fechado): apaga
// runtime/supervisor.pid se ele ainda tem o PID desse supervisor, para o launcher não
// encerrar a árvore de um PID velho (que o sistema pode ter dado a outro programa).
function removeSupervisorPid(pid) {
    try {
        if (fs.readFileSync(supervisorPidFile(), 'utf8').trim() === String(pid)) fs.rmSync(supervisorPidFile(), { force: true });
        return true;
    } catch (e) {
        return false;
    }
}

function status() {
    return {
        started: state.started,
        passive: state.passive,
        lastTickAt: state.lastTickAt,
        previousRun: state.previousRun ? { ...state.previousRun } : null,
        lastOutage: state.lastOutage ? { ...state.lastOutage, applications: state.lastOutage.applications.map(item => ({ ...item })) } : null,
        heartbeatFile: heartbeatFile(),
    };
}

module.exports = {
    EXIT_CODES,
    SHUTDOWN_TIMEOUT_MS,
    GAP_THRESHOLD_MS,
    HEARTBEAT_INTERVAL_MS,
    LIVE_HEARTBEAT_MAX_AGE_MS,
    MAX_OUTAGES_KEPT,
    OUTAGE_MAX_COMPENSATION_MS,
    OUTAGE_MIN_MS,
    compensateBootOutage,
    compensateServerOutage,
    detectGap,
    heartbeatFile,
    heartbeatFromLiveInstance,
    loadPreviousRun,
    markCleanShutdown,
    previousRun,
    readHeartbeat,
    someoneHadTimeLeft,
    startHeartbeat,
    status,
    stopHeartbeat,
    writeHeartbeat,
    // Processo (H3c).
    bootState,
    clearTimers,
    controlTokenFile,
    controlTokenMatches,
    degradedState,
    hasShutdownHandler,
    isSupervised,
    markDegraded,
    markReady,
    readControlToken,
    registerTimer,
    registeredTimers,
    removeControlToken,
    removeSupervisorPid,
    requestShutdown,
    resetProcessState,
    setBootPhase,
    setShutdownHandler,
    shutdownRequested,
    supervisorInfo,
    unregisterTimer,
    writeControlToken,
};
