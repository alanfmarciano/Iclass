// Fase 2 — Utilitários de segurança/LGPD: parsing de user-agent, logs de login e aceites.

const crypto = require('crypto');

// Versões atuais dos termos e da política. Podem ser sobrescritas via config.
const DEFAULT_TERMS_VERSION = '1.0';
const DEFAULT_PRIVACY_VERSION = '1.0';

function getClientIp(req) {
    try {
        const raw = (req && (req.ip || (req.socket && req.socket.remoteAddress))) || '';
        return raw.startsWith('::ffff:') ? raw.substring(7) : (raw === '::1' ? '127.0.0.1' : raw);
    } catch (e) { return ''; }
}

// Parser simples de user-agent (sem dependências externas).
function parseUserAgent(ua) {
    ua = String(ua || '');
    let browser = 'Desconhecido';
    if (/Edg\//i.test(ua)) browser = 'Edge';
    else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
    else if (/Chrome\//i.test(ua)) browser = 'Chrome';
    else if (/Firefox\//i.test(ua)) browser = 'Firefox';
    else if (/Safari\//i.test(ua)) browser = 'Safari';

    let os = 'Desconhecido';
    if (/Windows NT 10/i.test(ua)) os = 'Windows 10/11';
    else if (/Windows/i.test(ua)) os = 'Windows';
    else if (/Android/i.test(ua)) os = 'Android';
    else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
    else if (/Mac OS X/i.test(ua)) os = 'macOS';
    else if (/Linux/i.test(ua)) os = 'Linux';

    const device = /Mobi|Android|iPhone|iPad|iPod/i.test(ua) ? 'Móvel' : 'Desktop';
    return { browser, os, device };
}

// Registra um evento de login (sucesso ou falha) na coleção em memória.
// Não persiste (chame db.save() depois, ou scheduleLoginLogSave() nas falhas). Mantém no
// máximo 5000 registros.
// status: 'success', 'fail' (senha errada), 'blocked' (conta inativa), 'throttled' (conta
// esperando o atraso do loginGuard, H5b) ou 'alert' (muitas falhas vindas do mesmo IP).
// role: 'student', 'admin', 'professor' ou 'instructor' (login de instrutor com e-mail que
// não é de conta nenhuma).
// aggregate: true (falhas e atrasos, H5b) soma na entrada anterior igual (mesmo e-mail,
// papel, situação, motivo e IP) quando ela é de menos de 60 s atrás: count conta as
// tentativas e lastAt diz a última. Uma rajada de senhas erradas não enche a coleção.
const LOGIN_LOG_AGGREGATE_MS = 60 * 1000;
const LOGIN_LOG_AGGREGATE_SCAN = 200;

function findAggregateEntry(list, entry, now) {
    const stop = Math.max(0, list.length - LOGIN_LOG_AGGREGATE_SCAN);
    for (let index = list.length - 1; index >= stop; index -= 1) {
        const item = list[index];
        if (!item || typeof item !== 'object') continue;
        const last = Number(item.lastAt || item.timestamp) || 0;
        if (now - last > LOGIN_LOG_AGGREGATE_MS) continue;
        if (item.email === entry.email && item.role === entry.role && item.status === entry.status
            && (item.reason || '') === entry.reason && (item.ip || '') === entry.ip) return item;
    }
    return null;
}

function recordLoginLog(memory, { email, role, status, reason, req, aggregate = false, count, now = Date.now() }) {
    if (!Array.isArray(memory.loginLogs)) memory.loginLogs = [];
    const ua = (req && req.headers && req.headers['user-agent']) || '';
    const { browser, os, device } = parseUserAgent(ua);
    const entry = {
        id: `login_${now}_${crypto.randomBytes(3).toString('hex')}`,
        email: String(email || '').trim().toLowerCase(),
        role: role || 'student',
        status: status || 'success',
        reason: reason || '',
        timestamp: now,
        ip: getClientIp(req),
        browser, os, device,
        userAgent: ua,
    };
    if (Number.isFinite(Number(count)) && Number(count) > 1) entry.count = Math.floor(Number(count));
    if (aggregate) {
        const previous = findAggregateEntry(memory.loginLogs, entry, now);
        if (previous) {
            previous.count = (Number(previous.count) > 0 ? Number(previous.count) : 1) + 1;
            previous.lastAt = now;
            return previous;
        }
    }
    memory.loginLogs.push(entry);
    if (memory.loginLogs.length > 5000) {
        memory.loginLogs.splice(0, memory.loginLogs.length - 5000);
    }
    return entry;
}

// Gravação agrupada das falhas de login (H5b, SEG-06): a falha não espera o banco. Antes,
// cada senha errada fazia um db.save() inteiro (cerca de 2 s no banco de um ano, com o
// servidor parado), e uma rajada de senhas erradas deixava o servidor parado quase o
// tempo todo. Agora a falha fica na memória e um único db.save() a cada 60 s, no máximo,
// leva o que se juntou (o primeiro sai 5 s depois, para juntar a rajada). É uma gravação
// de fundo ({ detached: true }, contrato da gravação): nenhuma resposta espera por ela.
// Qualquer outra gravação completa que aconteça antes também leva as falhas. Um
// desligamento brusco perde no máximo o último minuto de falhas registradas.
const LOGIN_LOG_SAVE_INTERVAL_MS = 60 * 1000;
const LOGIN_LOG_SAVE_MIN_DELAY_MS = 5 * 1000;
let loginLogSaveTimer = null;
let lastLoginLogSaveAt = 0;

function runLoginLogSave() {
    loginLogSaveTimer = null;
    lastLoginLogSaveAt = Date.now();
    try {
        const db = require('../database.js');
        Promise.resolve(db.save({ detached: true })).catch(error => {
            // A falha de gravação já vai para o crash.log pelo dbWriter; o próximo registro
            // agenda outra tentativa.
            if (error && error.code === 'ICLASS_DB_WRITE') return;
            try { require('./errorLog.js').logError('gravação agrupada dos registros de login', error); } catch (e) { /* sem registro */ }
        });
    } catch (error) {
        try { require('./errorLog.js').logError('gravação agrupada dos registros de login', error); } catch (e) { /* sem registro */ }
    }
}

// Agenda a gravação (uma só por vez). Devolve true quando agendou agora.
function scheduleLoginLogSave(now = Date.now()) {
    if (loginLogSaveTimer) return false;
    const delay = Math.max(LOGIN_LOG_SAVE_MIN_DELAY_MS, lastLoginLogSaveAt + LOGIN_LOG_SAVE_INTERVAL_MS - now);
    loginLogSaveTimer = setTimeout(runLoginLogSave, delay);
    if (typeof loginLogSaveTimer.unref === 'function') loginLogSaveTimer.unref();
    return true;
}

// Para os testes: há gravação agendada? E cancelar a que está agendada.
function loginLogSavePending() {
    return !!loginLogSaveTimer;
}

function cancelLoginLogSave() {
    if (loginLogSaveTimer) clearTimeout(loginLogSaveTimer);
    loginLogSaveTimer = null;
    lastLoginLogSaveAt = 0;
}

// Monta um objeto de aceite (termos ou política) com versão/data/IP/device.
function buildAcceptance(version, req) {
    const ua = (req && req.headers && req.headers['user-agent']) || '';
    const { browser, os, device } = parseUserAgent(ua);
    return {
        version: version || DEFAULT_TERMS_VERSION,
        at: Date.now(),
        ip: getClientIp(req),
        device: `${device} · ${os} · ${browser}`,
    };
}

module.exports = {
    DEFAULT_TERMS_VERSION,
    DEFAULT_PRIVACY_VERSION,
    getClientIp,
    parseUserAgent,
    recordLoginLog,
    scheduleLoginLogSave,
    loginLogSavePending,
    cancelLoginLogSave,
    LOGIN_LOG_SAVE_INTERVAL_MS,
    buildAcceptance,
};
