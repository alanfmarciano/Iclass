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
// Não persiste (chame db.save() depois). Mantém no máximo 5000 registros.
function recordLoginLog(memory, { email, role, status, reason, req }) {
    if (!Array.isArray(memory.loginLogs)) memory.loginLogs = [];
    const ua = (req && req.headers && req.headers['user-agent']) || '';
    const { browser, os, device } = parseUserAgent(ua);
    const entry = {
        id: `login_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        email: String(email || '').trim().toLowerCase(),
        role: role || 'student',
        status: status || 'success',
        reason: reason || '',
        timestamp: Date.now(),
        ip: getClientIp(req),
        browser, os, device,
        userAgent: ua,
    };
    memory.loginLogs.push(entry);
    if (memory.loginLogs.length > 5000) {
        memory.loginLogs.splice(0, memory.loginLogs.length - 5000);
    }
    return entry;
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
    buildAcceptance,
};
