// ---------------------------------------------------------------------------
// Configurações do Sistema (com defaults + merge). Fonte única de verdade.
// Guardadas em db.memory.config.settings. Fáceis de evoluir por seção.
// ---------------------------------------------------------------------------
const db = require('../database.js');

const DEFAULTS = Object.freeze({
    timezone: 'America/Sao_Paulo',
    locale: 'pt-BR',
    dateFormat: 'dd/MM/yyyy',
    session: { idleMinutes: 60, absoluteHours: 8 },
    upload: { maxSizeMb: 50, allowedTypes: ['pdf', 'image', 'video', 'doc', 'sheet', 'zip', 'other'] },
    attendance: { autoOnLogin: true, windowStart: '', windowEnd: '' },
    trash: { retentionDays: 0 },
    maintenance: { enabled: false, message: 'Sistema em manutenção. Tente novamente em instantes.' },
});

function getSettings() {
    const s = (db.memory.config && db.memory.config.settings) || {};
    return {
        timezone: s.timezone || DEFAULTS.timezone,
        locale: DEFAULTS.locale,
        dateFormat: DEFAULTS.dateFormat,
        session: { ...DEFAULTS.session, ...(s.session || {}) },
        upload: { ...DEFAULTS.upload, ...(s.upload || {}) },
        attendance: { ...DEFAULTS.attendance, ...(s.attendance || {}) },
        trash: { ...DEFAULTS.trash, ...(s.trash || {}) },
        maintenance: { ...DEFAULTS.maintenance, ...(s.maintenance || {}) },
    };
}

// Sanitiza e mescla uma atualização parcial vinda do cliente.
function mergeSettings(patch) {
    const cur = getSettings();
    const p = patch || {};
    const clampNum = (v, def, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
    const next = {
        timezone: typeof p.timezone === 'string' && p.timezone.trim() ? p.timezone.trim() : cur.timezone,
        locale: DEFAULTS.locale,
        dateFormat: DEFAULTS.dateFormat,
        session: {
            idleMinutes: clampNum(p.session && p.session.idleMinutes, cur.session.idleMinutes, 5, 720),
            absoluteHours: clampNum(p.session && p.session.absoluteHours, cur.session.absoluteHours, 1, 24),
        },
        upload: {
            maxSizeMb: clampNum(p.upload && p.upload.maxSizeMb, cur.upload.maxSizeMb, 1, 1024),
            allowedTypes: Array.isArray(p.upload && p.upload.allowedTypes) ? p.upload.allowedTypes.filter(t => typeof t === 'string') : cur.upload.allowedTypes,
        },
        attendance: {
            autoOnLogin: p.attendance ? !!p.attendance.autoOnLogin : cur.attendance.autoOnLogin,
            windowStart: /^\d{2}:\d{2}$/.test(p.attendance && p.attendance.windowStart) ? p.attendance.windowStart : (p.attendance && p.attendance.windowStart === '' ? '' : cur.attendance.windowStart),
            windowEnd: /^\d{2}:\d{2}$/.test(p.attendance && p.attendance.windowEnd) ? p.attendance.windowEnd : (p.attendance && p.attendance.windowEnd === '' ? '' : cur.attendance.windowEnd),
        },
        trash: { retentionDays: clampNum(p.trash && p.trash.retentionDays, cur.trash.retentionDays, 0, 3650) },
        maintenance: {
            enabled: p.maintenance ? !!p.maintenance.enabled : cur.maintenance.enabled,
            message: typeof (p.maintenance && p.maintenance.message) === 'string' ? String(p.maintenance.message).slice(0, 300) : cur.maintenance.message,
        },
    };
    return next;
}

// "Hoje" (YYYY-MM-DD) no fuso configurado. en-CA gera formato ISO.
function todayInTz(tz) {
    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone: tz || DEFAULTS.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    } catch (e) { return new Date().toISOString().slice(0, 10); }
}
function today() { return todayInTz(getSettings().timezone); }

// HH:MM atual no fuso configurado.
function nowHHMM(tz) {
    try {
        return new Intl.DateTimeFormat('en-GB', { timeZone: tz || DEFAULTS.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    } catch (e) { return new Date().toTimeString().slice(0, 5); }
}

// Está dentro da janela de presença automática? (vazio = sempre)
function withinAttendanceWindow(settings) {
    const a = (settings || getSettings()).attendance;
    if (!a.windowStart || !a.windowEnd) return true;
    const t = nowHHMM((settings || getSettings()).timezone);
    if (a.windowStart <= a.windowEnd) return t >= a.windowStart && t <= a.windowEnd;
    return t >= a.windowStart || t <= a.windowEnd;
}

// Extensão -> categoria (para regra de tipos de upload permitidos).
function extCategory(ext) {
    ext = String(ext || '').toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'].includes(ext)) return 'image';
    if (ext === '.pdf') return 'pdf';
    if (['.mp4', '.webm', '.mov', '.avi', '.mkv'].includes(ext)) return 'video';
    if (['.zip', '.rar', '.7z'].includes(ext)) return 'zip';
    if (['.doc', '.docx', '.odt'].includes(ext)) return 'doc';
    if (['.xls', '.xlsx', '.csv'].includes(ext)) return 'sheet';
    return 'other';
}

module.exports = { DEFAULTS, getSettings, mergeSettings, todayInTz, today, nowHHMM, withinAttendanceWindow, extCategory };
