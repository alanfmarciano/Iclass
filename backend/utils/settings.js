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
    network: { adminAccess: 'rede-sem-https', studentsHttps: false },
    backup: { destino: '', guardarExterno: 14 },
    retention: { proctoringDays: 0, loginLogsDays: 0, reviewedAt: null, reviewedBy: null },
    entregas: { maxMbPorArquivo: 20, maxMbPorEnvio: 50, discoLivreMinimoMb: 2048 },
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
// - 'rede': outros aparelhos só pela conexão segura (https, H6c). A rota de rede só
//   aceita essa escolha com a conexão segura funcionando.
// Valor gravado desconhecido vale o padrão: ninguém fica trancado fora do painel.
//
// Alunos pela conexão segura (settings.network.studentsHttps, H6c): false por padrão (e
// no banco antigo). Ligado, o aluno que abre o IClass por http em outro aparelho vai
// para o endereço https, e o QR da sala passa a ser https. Só true liga.
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
    return { adminAccess: normalizeAdminAccess(network.adminAccess), studentsHttps: network.studentsHttps === true };
}

// Destino externo do backup (settings.backup, H4b, OPS-03): a pasta fora do computador
// (pendrive, HD externo ou pasta de rede) onde o backup completo diário é copiado, e
// quantos backups automáticos ficam lá (1 a 90). Gravado só por POST
// /api/admin/backup/config, que confere a pasta e testa a gravação; a restauração de um
// backup nunca o troca (gancho 'protectedConfig'). Banco de antes desta versão (sem o
// bloco) ou valor estranho: sem destino e 14.
const BACKUP_KEEP_EXTERNAL_MIN = 1;
const BACKUP_KEEP_EXTERNAL_MAX = 90;

function backupSettings(stored = storedSettings()) {
    const backup = stored.backup && typeof stored.backup === 'object' && !Array.isArray(stored.backup) ? stored.backup : {};
    const destino = typeof backup.destino === 'string' ? backup.destino.trim() : '';
    const keep = Math.floor(Number(backup.guardarExterno));
    return {
        destino,
        guardarExterno: Number.isFinite(keep) && keep >= BACKUP_KEEP_EXTERNAL_MIN
            ? Math.min(BACKUP_KEEP_EXTERNAL_MAX, keep)
            : DEFAULTS.backup.guardarExterno,
    };
}

// Prazos de guarda dos registros técnicos (settings.retention, H8b: SEG-13, decisão 4 do
// Alan). Só o administrador grava, por POST /api/admin/lgpd/retention (utils/retention.js
// confere os limites). 0 = nunca apagar sozinho, que é o padrão e o valor de um banco de
// antes desta versão (sem o bloco). Só teclas e saídas de tela da prova (proctoringDays) e
// registros de acesso (loginLogsDays) têm prazo; o da lixeira continua em
// trash.retentionDays. Notas, frequência, entregas, auditoria e cadastro de aluno nunca
// são apagados por prazo. Valor gravado estranho (negativo, texto) vale 0.
const RETENTION_MAX_DAYS = 3650;

function retentionDays(value) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? Math.min(RETENTION_MAX_DAYS, number) : 0;
}

function retentionSettings(stored = storedSettings()) {
    const retention = stored.retention && typeof stored.retention === 'object' && !Array.isArray(stored.retention) ? stored.retention : {};
    const trash = stored.trash && typeof stored.trash === 'object' && !Array.isArray(stored.trash) ? stored.trash : {};
    return {
        proctoringDays: retentionDays(retention.proctoringDays),
        loginLogsDays: retentionDays(retention.loginLogsDays),
        trashDays: retentionDays(trash.retentionDays),
        reviewedAt: typeof retention.reviewedAt === 'string' && retention.reviewedAt ? retention.reviewedAt : null,
        reviewedBy: typeof retention.reviewedBy === 'string' && retention.reviewedBy ? retention.reviewedBy : null,
    };
}

// Limites globais das entregas de tarefa (settings.entregas, fase 3, P1 D17), editáveis em
// Sistema pelo POST /api/admin/settings (system.manage):
// - maxMbPorArquivo: teto de cada arquivo que o professor pode escolher na tarefa (padrão
//   20; nunca acima de upload.maxSizeMb, o teto de envio do servidor);
// - maxMbPorEnvio: soma dos arquivos de um envio (padrão 50; nunca abaixo do teto por
//   arquivo, senão um arquivo no limite não caberia);
// - discoLivreMinimoMb: abaixo disso de espaço livre o envio do aluno é recusado (507) e a
//   fila do Dashboard avisa (padrão 2048).
// Banco de antes desta versão (sem o bloco) ou valor estranho: os padrões.
const ENTREGAS_LIMITS = Object.freeze({
    maxMbPorArquivo: { min: 1, max: 1024 },
    maxMbPorEnvio: { min: 1, max: 4096 },
    discoLivreMinimoMb: { min: 0, max: 1024 * 1024 },
});

// Nome de cada limite nas mensagens de erro do POST /api/admin/settings.
const ENTREGAS_LABELS = Object.freeze({
    maxMbPorArquivo: 'Tamanho máximo por arquivo das entregas (MB)',
    maxMbPorEnvio: 'Tamanho máximo por envio das entregas (MB)',
    discoLivreMinimoMb: 'Espaço livre mínimo para receber entregas (MB)',
});

// Confere a combinação dos limites das entregas que o POST /api/admin/settings vai gravar,
// depois do schema (tipo e faixa de cada campo, na rota). { error, field } ou null.
// - patchEntregas: o bloco 'entregas' do pedido (já validado);
// - before: os limites que valem agora (getSettings().entregas, o que a tela mostrou);
// - next: o resultado de mergeSettings(pedido) (upload.maxSizeMb e entregas como ficam).
// Só o campo que o pedido MUDA é conferido: a tela devolve o bloco inteiro que leu, e um
// valor que só ficou acima do teto porque o upload.maxSizeMb baixou no mesmo pedido continua
// valendo com o teto na leitura (não trava o salvar das outras configurações).
function entregasPatchError(patchEntregas, { before, next } = {}) {
    if (!patchEntregas || typeof patchEntregas !== 'object' || Array.isArray(patchEntregas)) return null;
    const current = before || entregasSettings();
    const changed = key => patchEntregas[key] !== undefined && Number(patchEntregas[key]) !== current[key];
    const nextUpload = Math.floor(Number(next && next.upload && next.upload.maxSizeMb));
    const ceiling = Number.isFinite(nextUpload) && nextUpload >= 1 ? nextUpload : Infinity;
    const stored = (next && next.entregas) || entregasSettings(storedSettings(), Infinity, { forStorage: true });
    if (changed('maxMbPorArquivo') && stored.maxMbPorArquivo > ceiling) {
        return {
            field: 'entregas.maxMbPorArquivo',
            error: `O tamanho máximo por arquivo das entregas não pode passar do limite de upload do servidor (${ceiling} MB).`,
        };
    }
    const perFile = Math.min(stored.maxMbPorArquivo, ceiling);
    if ((changed('maxMbPorArquivo') || changed('maxMbPorEnvio')) && stored.maxMbPorEnvio < perFile) {
        return {
            field: changed('maxMbPorEnvio') ? 'entregas.maxMbPorEnvio' : 'entregas.maxMbPorArquivo',
            error: `O tamanho máximo por envio (${stored.maxMbPorEnvio} MB) não pode ser menor que o tamanho máximo por arquivo (${perFile} MB).`,
        };
    }
    return null;
}

// forStorage: os valores como ficam gravados (só os limites de cada campo); sem ele, os que
// valem agora (teto do upload e envio nunca menor que um arquivo).
function entregasSettings(stored = storedSettings(), uploadMaxMb, { forStorage = false } = {}) {
    const entregas = stored.entregas && typeof stored.entregas === 'object' && !Array.isArray(stored.entregas) ? stored.entregas : {};
    const uploadStored = stored.upload && typeof stored.upload === 'object' ? stored.upload : {};
    const uploadCeiling = Math.floor(Number(uploadMaxMb !== undefined ? uploadMaxMb : (uploadStored.maxSizeMb ?? DEFAULTS.upload.maxSizeMb)));
    const read = (key) => {
        const limits = ENTREGAS_LIMITS[key];
        const value = Math.floor(Number(entregas[key]));
        if (entregas[key] === null || entregas[key] === '' || typeof entregas[key] === 'boolean' || !Number.isFinite(value)) return DEFAULTS.entregas[key];
        return Math.min(limits.max, Math.max(limits.min, value));
    };
    if (forStorage) return { maxMbPorArquivo: read('maxMbPorArquivo'), maxMbPorEnvio: read('maxMbPorEnvio'), discoLivreMinimoMb: read('discoLivreMinimoMb') };
    let maxMbPorArquivo = read('maxMbPorArquivo');
    if (Number.isFinite(uploadCeiling) && uploadCeiling >= 1) maxMbPorArquivo = Math.min(maxMbPorArquivo, uploadCeiling);
    const maxMbPorEnvio = Math.max(read('maxMbPorEnvio'), maxMbPorArquivo);
    return { maxMbPorArquivo, maxMbPorEnvio, discoLivreMinimoMb: read('discoLivreMinimoMb') };
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
        backup: backupSettings(s),
        retention: (({ trashDays, ...rest }) => rest)(retentionSettings(s)),
        entregas: entregasSettings(s, { ...DEFAULTS.upload, ...(s.upload || {}) }.maxSizeMb),
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
    // Entregas de tarefa: cada campo do pedido que é número vale (dentro dos limites); o
    // resto fica como está gravado. Grava o valor escolhido sem o teto do upload.maxSizeMb,
    // que só se aplica na leitura (getSettings): baixar e depois subir o teto do servidor
    // não perde a escolha.
    const entregasPatch = p.entregas && typeof p.entregas === 'object' && !Array.isArray(p.entregas) ? p.entregas : {};
    const entregasNext = { ...entregasSettings(storedSettings(), Infinity, { forStorage: true }) };
    Object.keys(ENTREGAS_LIMITS).forEach(key => {
        const value = entregasPatch[key];
        if (value === undefined || value === null || value === '' || typeof value === 'boolean') return;
        if (Number.isFinite(Number(value))) entregasNext[key] = Number(value);
    });
    next.entregas = entregasSettings({ entregas: entregasNext }, Infinity, { forStorage: true });
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
    backupSettings,
    BACKUP_KEEP_EXTERNAL_MIN,
    BACKUP_KEEP_EXTERNAL_MAX,
    retentionSettings,
    RETENTION_MAX_DAYS,
    entregasSettings,
    entregasPatchError,
    ENTREGAS_LIMITS,
    ENTREGAS_LABELS,
    normalizeAdminAccess,
    isValidTimeZone,
    todayInTz,
    today,
    nowHHMM,
    withinAttendanceWindow,
    extCategory,
};
