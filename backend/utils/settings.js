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
    network: { adminAccess: 'rede-sem-https' },
});

// Blocos que o POST genérico de configurações (/api/admin/settings) nunca altera: cada
// um só é gravado pela própria rota, com validação e auditoria (backup do H4, rede do
// H6 em /api/admin/network-settings, retenção do H8). mergeSettings devolve o bloco
// gravado como está, inclusive campos que esta versão ainda não conhece.
const PROTECTED_SETTINGS_SECTIONS = Object.freeze(['backup', 'network', 'retention']);

// Painel do professor em outros aparelhos (settings.network.adminAccess, SEG-03):
// - 'rede-sem-https' (padrão; também quando o campo não existe, como no banco de antes
//   desta versão): abre em qualquer aparelho da rede, como antes, e a tela avisa que a
//   senha passa pela rede sem proteção quando não é o computador do IClass;
// - 'local': só no computador onde o IClass está ligado;
// - 'rede': outros aparelhos só pela conexão segura (https). Enquanto esta versão não
//   tem https (H6c), a rota de rede recusa essa escolha.
// Valor gravado desconhecido vale o padrão: ninguém fica trancado fora do painel.
const ADMIN_ACCESS_MODES = Object.freeze(['rede-sem-https', 'local', 'rede']);

function normalizeAdminAccess(value) {
    return ADMIN_ACCESS_MODES.includes(value) ? value : DEFAULTS.network.adminAccess;
}

function storedSettings() {
    const s = db.memory.config && db.memory.config.settings;
    return s && typeof s === 'object' ? s : {};
}

function networkSettings(stored = storedSettings()) {
    const network = stored.network && typeof stored.network === 'object' ? stored.network : {};
    return { adminAccess: normalizeAdminAccess(network.adminAccess) };
}

function getSettings() {
    const s = storedSettings();
    return {
        timezone: isValidTimeZone(s.timezone) ? s.timezone : DEFAULTS.timezone,
        locale: DEFAULTS.locale,
        dateFormat: DEFAULTS.dateFormat,
        session: { ...DEFAULTS.session, ...(s.session || {}) },
        upload: { ...DEFAULTS.upload, ...(s.upload || {}) },
        attendance: { ...DEFAULTS.attendance, ...(s.attendance || {}) },
        trash: { ...DEFAULTS.trash, ...(s.trash || {}) },
        maintenance: { ...DEFAULTS.maintenance, ...(s.maintenance || {}) },
        network: networkSettings(s),
    };
}

// Sanitiza e mescla uma atualização parcial vinda do cliente.
function mergeSettings(patch) {
    const cur = getSettings();
    const p = patch || {};
    const clampNum = (v, def, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
    const next = {
        timezone: typeof p.timezone === 'string' && isValidTimeZone(p.timezone.trim()) ? p.timezone.trim() : cur.timezone,
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
    // Blocos protegidos: o que está gravado continua, e o que veio no pedido é ignorado.
    const stored = storedSettings();
    PROTECTED_SETTINGS_SECTIONS.forEach(section => {
        if (stored[section] !== undefined) next[section] = stored[section];
    });
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

// Fuso que o Intl conhece. Um nome que ele recusa ('Brasil/Hora', vindo pela API, de um
// banco ou de um backup antigo) fazia cada data formatada com ele quebrar (a tela
// Auditoria respondia 500) ou cair no UTC: getSettings devolve o padrão no lugar e
// mergeSettings mantém o fuso de antes. A resposta fica guardada (poucos nomes por vez).
const timeZoneChecks = new Map();
function isValidTimeZone(value) {
    if (typeof value !== 'string' || !value.trim()) return false;
    if (!timeZoneChecks.has(value)) {
        let valid = false;
        try { new Intl.DateTimeFormat('en-US', { timeZone: value }); valid = true; } catch (e) { valid = false; }
        if (timeZoneChecks.size >= 64) timeZoneChecks.clear();
        timeZoneChecks.set(value, valid);
    }
    return timeZoneChecks.get(value);
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

module.exports = {
    DEFAULTS,
    PROTECTED_SETTINGS_SECTIONS,
    ADMIN_ACCESS_MODES,
    getSettings,
    mergeSettings,
    networkSettings,
    normalizeAdminAccess,
    isValidTimeZone,
    todayInTz,
    today,
    nowHHMM,
    withinAttendanceWindow,
    extCategory,
};
