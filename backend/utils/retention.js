// Retenção dos registros técnicos (fase 2, H8b: SEG-13; decisão 4 do Alan).
//
// O que pode ter prazo, e só quando o administrador liga (settings.retention, padrão 0 =
// nunca apagar sozinho):
// - monitoramento da prova (proctoringDays): as teclas (db.keystrokes) e as saídas de tela
//   e de tela cheia (proctoringLogs). Contam do fim da aplicação: encerrada (finishedAt)
//   ou cancelada (cancelledAt, senão updatedAt). Aplicação aberta (rascunho, preparada,
//   em sala de espera, em andamento ou pausada) nunca perde nada. Registro sem aplicação,
//   ou de aplicação que não existe mais, conta da própria hora;
// - registros de acesso (loginLogsDays): pela hora do acesso (a última, nos agrupados);
// - lixeira (trash.retentionDays): o sweepTrash de 6 h do server.js (utils/storage.js); a
//   limpeza pedida pelo administrador também a esvazia pelo mesmo prazo.
// Nunca entram aqui: cadastro de aluno, notas, frequência, entregas, auditoria,
// observações e mensagens.
//
// Remove das mais antigas para as mais novas, no máximo 20 mil por coleção a cada vez
// (no banco de um ano, remover 84 mil linhas de uma vez travou o servidor por 2 s). O que
// sobra fica para a próxima hora. A limpeza automática (server.js, de hora em hora, fora
// do TEST_MODE) só roda sem prova aberta (ACTIVE_APPLICATION_STATUSES), com algum prazo
// ligado e quando a última tem mais de 23 h ou deixou sobra. Cada limpeza grava
// config.retentionLastRun e, quando apaga algo (ou quando o administrador pede), a
// auditoria 'retention_purge' (categoria privacy).
const { recordAudit } = require('./audit.js');
const { ACTIVE_APPLICATION_STATUSES } = require('./examApplications.js');
const { RETENTION_MAX_DAYS } = require('./settings.js');

const DAY_MS = 86400000;
const RETENTION_MAX_PER_RUN = 20000;
// A limpeza automática roda de novo depois de 23 h (o timer passa de hora em hora), ou
// na hora seguinte quando a anterior deixou sobra.
const RETENTION_RUN_INTERVAL_MS = 23 * 3600000;
const CLOSED_APPLICATION_STATUSES = new Set(['finished', 'cancelled']);
// Ids de aplicação por consulta de teclas (bem abaixo do teto do keystrokeStore).
const APPLICATION_ID_CHUNK = 5000;

// Limites de cada prazo, em dias. 0 desliga. Entre 1 e o mínimo, sobe para o mínimo:
// 30 dias para o monitoramento (dá tempo de rever uma prova contestada) e 180 para os
// acessos (Marco Civil da Internet, art. 15).
const RETENTION_LIMITS = Object.freeze({
    proctoringDays: Object.freeze({ min: 30, max: RETENTION_MAX_DAYS, label: 'monitoramento da prova' }),
    loginLogsDays: Object.freeze({ min: 180, max: RETENTION_MAX_DAYS, label: 'registros de acesso' }),
    trashDays: Object.freeze({ min: 1, max: RETENTION_MAX_DAYS, label: 'lixeira' }),
});
// Botão "Usar prazos recomendados" (só vale quando o administrador salva).
const RECOMMENDED_RETENTION = Object.freeze({ proctoringDays: 180, loginLogsDays: 365, trashDays: 30 });
const RETENTION_FIELDS = Object.freeze(Object.keys(RETENTION_LIMITS));

class RetentionInputError extends Error {
    constructor(message, field) {
        super(message);
        this.name = 'RetentionInputError';
        this.field = field;
    }
}

function fieldMessage(field) {
    const limit = RETENTION_LIMITS[field];
    return `Informe o prazo de ${limit.label} em dias inteiros, de 0 a ${limit.max.toLocaleString('pt-BR')} (0 = não apagar).`;
}

// Um prazo vindo do corpo (número) ou da URL (texto só com dígitos). Devolve o valor já
// no limite e se ele foi ajustado. Inválido lança RetentionInputError com o campo.
function parseDays(field, raw) {
    let value;
    if (typeof raw === 'number') value = raw;
    else if (typeof raw === 'string' && /^\s*\d{1,6}\s*$/.test(raw)) value = Number(raw.trim());
    else throw new RetentionInputError(fieldMessage(field), field);
    if (!Number.isInteger(value) || value < 0 || value > RETENTION_LIMITS[field].max) {
        throw new RetentionInputError(fieldMessage(field), field);
    }
    const { min } = RETENTION_LIMITS[field];
    if (value > 0 && value < min) return { value: min, adjusted: true };
    return { value, adjusted: false };
}

// Prazos pedidos: { values, adjusted }. Campo ausente fica com o de `current` quando
// `partial` (prévia), e é recusado quando não (gravação: os três vêm juntos).
function parseRetentionInput(input, { current = null, partial = false } = {}) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const values = {};
    const adjusted = [];
    RETENTION_FIELDS.forEach(field => {
        const raw = source[field];
        if (raw === undefined || raw === null || raw === '') {
            if (partial && current) {
                values[field] = current[field];
                return;
            }
            throw new RetentionInputError(fieldMessage(field), field);
        }
        const parsed = parseDays(field, raw);
        values[field] = parsed.value;
        if (parsed.adjusted) adjusted.push(field);
    });
    return { values, adjusted };
}

function timeOf(value) {
    if (value === undefined || value === null || value === '') return null;
    const number = typeof value === 'number' ? value : (/^\d+$/.test(String(value)) ? Number(value) : Date.parse(String(value)));
    return Number.isFinite(number) ? number : null;
}

// Fim da aplicação encerrada ou cancelada (o que conta o prazo do monitoramento).
function applicationEndTime(application) {
    if (!application || !CLOSED_APPLICATION_STATUSES.has(application.status)) return null;
    return timeOf(application.finishedAt) ?? timeOf(application.cancelledAt) ?? timeOf(application.updatedAt);
}

function hasAnyDeadline(values) {
    return !!values && RETENTION_FIELDS.some(field => Number(values[field]) > 0);
}

function activeApplicationCount(memory) {
    return (Array.isArray(memory.examApplications) ? memory.examApplications : [])
        .filter(application => application && ACTIVE_APPLICATION_STATUSES.has(application.status)).length;
}

function chunked(list, size = APPLICATION_ID_CHUNK) {
    const out = [];
    for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size));
    return out;
}

// Situação das aplicações para o prazo do monitoramento: as encerradas há mais do que o
// prazo (expired), as que existem (known) e quantas estão abertas.
function applicationScope(memory, cutoff) {
    const known = new Set();
    const expired = [];
    (Array.isArray(memory.examApplications) ? memory.examApplications : []).forEach(application => {
        if (!application || !application.id) return;
        const id = String(application.id);
        known.add(id);
        const end = applicationEndTime(application);
        if (end !== null && end < cutoff) expired.push(id);
    });
    return { known, expired: new Set(expired) };
}

// Saída de tela/tela cheia que o prazo já alcançou: pela aplicação, quando ela existe;
// senão pela própria hora.
function proctoringLogExpired(log, scope, cutoff) {
    if (!log || typeof log !== 'object') return false;
    const applicationId = log.applicationId ? String(log.applicationId) : '';
    if (applicationId && scope.known.has(applicationId)) return scope.expired.has(applicationId);
    const at = timeOf(log.serverTs) ?? timeOf(log.timestamp);
    return at !== null && at < cutoff;
}

function loginLogTime(log) {
    return timeOf(log && log.lastAt) ?? timeOf(log && log.timestamp);
}

// Teclas de aplicação que não existe mais (aplicação apagada, banco montado à mão): os
// contadores do store dizem quais aplicações têm teclas.
function orphanKeystrokeApplications(keystrokes, scope) {
    const ids = new Set();
    (typeof keystrokes.statsEntries === 'function' ? keystrokes.statsEntries() : []).forEach(entry => {
        const id = entry && entry.applicationId ? String(entry.applicationId) : '';
        if (id && !scope.known.has(id)) ids.add(id);
    });
    return [...ids];
}

// Filtros de teclas do prazo do monitoramento, na ordem em que são apagadas: as das
// aplicações vencidas (inteiras) e as sem aplicação ou de aplicação que não existe mais
// (pela hora em que chegaram).
function keystrokeFilters(keystrokes, scope, cutoff) {
    const filters = chunked([...scope.expired]).map(applicationIds => ({ applicationIds }));
    const orphans = orphanKeystrokeApplications(keystrokes, scope);
    chunked([null, ...orphans]).forEach(applicationIds => filters.push({ applicationIds, before: cutoff }));
    return filters;
}

function oldestFirst(list, timeFn) {
    return list
        .map((item, index) => ({ item, index, at: timeFn(item) ?? 0 }))
        .sort((a, b) => a.at - b.at || a.index - b.index)
        .map(entry => entry.item);
}

// Valores em vigor: settings.retention e trash.retentionDays (utils/settings.js
// retentionSettings) ou os de uma prévia.
function valuesOf(settings) {
    const source = settings || {};
    const out = {};
    RETENTION_FIELDS.forEach(field => {
        const number = Math.floor(Number(source[field]));
        out[field] = Number.isFinite(number) && number > 0 ? Math.min(RETENTION_MAX_DAYS, number) : 0;
    });
    return out;
}

// O que a limpeza apagaria agora com estes prazos (sem o teto por vez):
// { counts: { keystrokes, proctoringLogs, loginLogs, trash }, cutoffs }.
async function planRetention(memory, settings, now = Date.now(), { keystrokes = null, trash = null } = {}) {
    const values = valuesOf(settings);
    const counts = { keystrokes: 0, proctoringLogs: 0, loginLogs: 0, trash: 0 };
    const cutoffs = { proctoringDays: null, loginLogsDays: null, trashDays: null };
    if (values.proctoringDays > 0) {
        const cutoff = now - values.proctoringDays * DAY_MS;
        cutoffs.proctoringDays = cutoff;
        const scope = applicationScope(memory, cutoff);
        counts.proctoringLogs = (Array.isArray(memory.proctoringLogs) ? memory.proctoringLogs : [])
            .filter(log => proctoringLogExpired(log, scope, cutoff)).length;
        if (keystrokes) {
            for (const filter of keystrokeFilters(keystrokes, scope, cutoff)) counts.keystrokes += await keystrokes.countWhere(filter);
        }
    }
    if (values.loginLogsDays > 0) {
        const cutoff = now - values.loginLogsDays * DAY_MS;
        cutoffs.loginLogsDays = cutoff;
        counts.loginLogs = (Array.isArray(memory.loginLogs) ? memory.loginLogs : [])
            .filter(log => { const at = loginLogTime(log); return at !== null && at < cutoff; }).length;
    }
    if (values.trashDays > 0) {
        cutoffs.trashDays = now - values.trashDays * DAY_MS;
        if (trash && typeof trash.count === 'function') counts.trash = Number(trash.count(values.trashDays, now)) || 0;
    }
    return { values, counts, cutoffs };
}

// Apaga o que venceu, das mais antigas para as mais novas, até `max` por coleção. Mexe
// em memory.proctoringLogs e memory.loginLogs (quem chama faz o db.save() completo: são
// coleções append) e pede ao store a remoção das teclas (resolve depois do COMMIT).
// Devolve { counts, remaining }; remaining é o que ficou para a próxima vez.
async function applyRetention(memory, settings, now = Date.now(), { max = RETENTION_MAX_PER_RUN, keystrokes = null, trash = null, includeTrash = false } = {}) {
    const values = valuesOf(settings);
    const limit = Math.max(0, Math.floor(Number(max)) || 0);
    const counts = { keystrokes: 0, proctoringLogs: 0, loginLogs: 0, trash: 0 };
    const remaining = { keystrokes: 0, proctoringLogs: 0, loginLogs: 0 };
    let proctoringRemove = null;
    let loginRemove = null;

    if (values.proctoringDays > 0) {
        const cutoff = now - values.proctoringDays * DAY_MS;
        const scope = applicationScope(memory, cutoff);
        if (keystrokes) {
            let budget = limit;
            for (const filter of keystrokeFilters(keystrokes, scope, cutoff)) {
                const eligible = await keystrokes.countWhere(filter);
                if (!eligible) continue;
                const take = Math.min(eligible, budget);
                const { deleted } = take > 0 ? await keystrokes.deleteWhere({ ...filter, max: take }) : { deleted: 0 };
                counts.keystrokes += deleted;
                budget -= deleted;
                remaining.keystrokes += Math.max(0, eligible - deleted);
            }
        }
        // As saídas de tela são escolhidas por último, logo antes de mexer na memória (a
        // remoção das teclas espera a gravação): um registro novo nunca entra na conta.
        const expired = oldestFirst((Array.isArray(memory.proctoringLogs) ? memory.proctoringLogs : [])
            .filter(log => proctoringLogExpired(log, scope, cutoff)), log => timeOf(log.serverTs) ?? timeOf(log.timestamp));
        proctoringRemove = new Set(expired.slice(0, limit));
        remaining.proctoringLogs = expired.length - proctoringRemove.size;
    }
    if (values.loginLogsDays > 0) {
        const cutoff = now - values.loginLogsDays * DAY_MS;
        const expired = oldestFirst((Array.isArray(memory.loginLogs) ? memory.loginLogs : [])
            .filter(log => { const at = loginLogTime(log); return at !== null && at < cutoff; }), loginLogTime);
        loginRemove = new Set(expired.slice(0, limit));
        remaining.loginLogs = expired.length - loginRemove.size;
    }
    if (proctoringRemove && proctoringRemove.size) {
        memory.proctoringLogs = memory.proctoringLogs.filter(log => !proctoringRemove.has(log));
        counts.proctoringLogs = proctoringRemove.size;
    }
    if (loginRemove && loginRemove.size) {
        memory.loginLogs = memory.loginLogs.filter(log => !loginRemove.has(log));
        counts.loginLogs = loginRemove.size;
    }
    if (includeTrash && values.trashDays > 0 && trash && typeof trash.purge === 'function') {
        counts.trash = Number(trash.purge(values.trashDays)) || 0;
    }
    return { values, counts, remaining };
}

function totalOf(counts) {
    return Object.values(counts || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

// Última limpeza gravada (config.retentionLastRun), ou null.
function lastRetentionRun(memory) {
    const value = memory && memory.config && memory.config.retentionLastRun;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

// A limpeza automática deve rodar agora? (prazos, prova aberta e intervalo)
function retentionDue(memory, settings, now = Date.now()) {
    const values = valuesOf(settings);
    if (!hasAnyDeadline({ proctoringDays: values.proctoringDays, loginLogsDays: values.loginLogsDays })) return { due: false, reason: 'no_deadline' };
    const active = activeApplicationCount(memory);
    if (active) return { due: false, reason: 'active_application', activeApplications: active };
    const last = lastRetentionRun(memory);
    const lastAt = last ? timeOf(last.at) : null;
    const leftover = last ? totalOf(last.remaining) > 0 : false;
    if (lastAt !== null && now - lastAt < RETENTION_RUN_INTERVAL_MS && !leftover && lastAt <= now) return { due: false, reason: 'not_due' };
    return { due: true };
}

// Uma limpeza por vez (a automática e a pedida pelo administrador).
let runningRetention = null;

// Limpeza completa: confere, apaga, grava config.retentionLastRun e a auditoria e salva.
// trigger: 'automatic' (timer) ou 'manual' (administrador). Resposta:
// { ran: false, reason: 'busy'|'no_deadline'|'active_application'|'not_due' } ou
// { ran: true, counts, remaining, lastRun }.
async function runRetention({ memory, keystrokes, trash, settings, now = Date.now(), trigger = 'automatic', actor, req, save }) {
    if (runningRetention) return { ran: false, reason: 'busy' };
    const values = valuesOf(settings);
    const manual = trigger === 'manual';
    if (manual) {
        if (!hasAnyDeadline(values)) return { ran: false, reason: 'no_deadline' };
        const active = activeApplicationCount(memory);
        if (active) return { ran: false, reason: 'active_application', activeApplications: active };
    } else {
        const due = retentionDue(memory, values, now);
        if (!due.due) {
            const out = { ran: false, reason: due.reason };
            if (due.activeApplications) out.activeApplications = due.activeApplications;
            return out;
        }
    }
    const work = (async () => {
        const result = await applyRetention(memory, values, now, { keystrokes, trash, includeTrash: manual });
        const lastRun = {
            at: new Date(now).toISOString(),
            trigger: manual ? 'manual' : 'automatic',
            by: manual ? (actor && (actor.email || actor)) || null : null,
            settings: { ...values },
            counts: result.counts,
            remaining: result.remaining,
        };
        if (!memory.config || typeof memory.config !== 'object') memory.config = {};
        memory.config.retentionLastRun = lastRun;
        if (manual || totalOf(result.counts) > 0) {
            recordAudit(memory, {
                req,
                actor: manual ? actor : 'sistema',
                action: 'retention_purge',
                category: 'privacy',
                details: { trigger: lastRun.trigger, settings: lastRun.settings, counts: result.counts, remaining: result.remaining },
            });
        }
        if (typeof save === 'function') await save();
        return { ran: true, counts: result.counts, remaining: result.remaining, lastRun };
    })();
    runningRetention = work;
    try {
        return await work;
    } finally {
        runningRetention = null;
    }
}

module.exports = {
    RECOMMENDED_RETENTION,
    RETENTION_FIELDS,
    RETENTION_LIMITS,
    RETENTION_MAX_PER_RUN,
    RETENTION_RUN_INTERVAL_MS,
    RetentionInputError,
    activeApplicationCount,
    applicationEndTime,
    applyRetention,
    hasAnyDeadline,
    lastRetentionRun,
    parseRetentionInput,
    planRetention,
    retentionDue,
    runRetention,
};
