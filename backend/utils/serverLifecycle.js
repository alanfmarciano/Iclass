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
//   decide se dá mais tempo.
// Os sinais, o desligamento ordenado (requestShutdown) e o registro dos timers ficam
// com o H3c, que chama markCleanShutdown(reason) no fim do desligamento.
const fs = require('fs');
const path = require('path');
const runtimePaths = require('../runtimePaths.js');
const { SERVER_INSTANCE_ID } = require('./sessionConfig.js');
const {
    CLOSED_ATTEMPT_STATUSES,
    SERVER_OUTAGE_PAUSE_REASON,
    applicationPauses,
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

// Lê o heartbeat da execução anterior uma vez, no boot (antes do primeiro novo), e o
// guarda para previousRun().
function loadPreviousRun({ now = Date.now() } = {}) {
    state.previousRun = readHeartbeat({ now });
    if (state.previousRun.clockWentBack) {
        console.warn('⚠️ O relógio do computador está antes do último registro do servidor: o tempo fora do ar foi contado como zero.');
    }
    return state.previousRun;
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

function normalizedReason(reason) {
    return OUTAGE_REASONS.has(reason) ? reason : 'crash';
}

// Devolve às aplicações em andamento o tempo em que o servidor ficou fora do ar entre
// from e to. O início efetivo de cada uma é o mais tarde entre from, o início da
// aplicação, o fim da última pausa e o último salvamento de uma tentativa dela (o
// servidor estava no ar até ali: um heartbeat velho não devolve tempo a mais). Só altera
// a memória (quem chama grava). Devolve { changed, applications: [...] }.
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
    if (!run || !run.found) {
        const running = (Array.isArray(memory && memory.examApplications) ? memory.examApplications : [])
            .some(application => applicationTimerRunning(application, now));
        if (running) console.warn('⚠️ Não há registro de quando o servidor parou (runtime/heartbeat.json): o tempo fora do ar não foi devolvido às provas em andamento. Se precisar, dê mais tempo pelo Monitor.');
        return { changed: false, applications: [] };
    }
    const reason = run.clean ? 'restart' : 'crash';
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
    state.started = true;
    state.getMemory = getMemory || null;
    state.save = save || null;
    state.lastTickAt = now;
    writeHeartbeat({ now });
    state.timer = setInterval(tick, Math.max(1000, Number(intervalMs) || HEARTBEAT_INTERVAL_MS));
    if (typeof state.timer.unref === 'function') state.timer.unref();
    setDeadlineCheck(() => detectGap(Date.now()));
    return state.timer;
}

function stopHeartbeat() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    state.started = false;
    state.lastTickAt = null;
    setDeadlineCheck(null);
}

// Fim do desligamento ordenado: o próximo boot sabe que foi parada pedida (reason
// 'stop', 'restart', 'admin_restart' ou 'fatal'), não queda. Só grava se o heartbeat foi
// iniciado (servidor de verdade, não o createApp dos testes).
function markCleanShutdown(reason = 'stop') {
    if (!state.started) return false;
    stopHeartbeat();
    return writeHeartbeat({ clean: true, reason });
}

function status() {
    return {
        started: state.started,
        lastTickAt: state.lastTickAt,
        previousRun: state.previousRun ? { ...state.previousRun } : null,
        lastOutage: state.lastOutage ? { ...state.lastOutage, applications: state.lastOutage.applications.map(item => ({ ...item })) } : null,
        heartbeatFile: heartbeatFile(),
    };
}

module.exports = {
    GAP_THRESHOLD_MS,
    HEARTBEAT_INTERVAL_MS,
    MAX_OUTAGES_KEPT,
    OUTAGE_MAX_COMPENSATION_MS,
    OUTAGE_MIN_MS,
    compensateBootOutage,
    compensateServerOutage,
    detectGap,
    heartbeatFile,
    loadPreviousRun,
    markCleanShutdown,
    previousRun,
    readHeartbeat,
    startHeartbeat,
    status,
    stopHeartbeat,
    writeHeartbeat,
};
