// ---------------------------------------------------------------------------
// Sessões de aluno e de instrutor: o único módulo que cria, procura, confere e
// revoga sessão (H3a-1).
//
// O token devolvido no login (cru) fica só no navegador. O servidor guarda o hash:
// - aluno:     memory.sessions[email] = { tokenHash, createdAt, lastSeen, lastActivityAt, ip, origin? }
// - instrutor: memory.adminSessions['h:' + sha256(token)] = { email, createdAt, lastSeen, lastActivityAt, origin? }
// Assim a tabela de sessões (a gravação no banco é do H3a-2) e qualquer cópia do
// banco não viram uma lista de chaves de entrada: o sha256 de um token aleatório de
// 256 bits não serve para entrar, e a chave 'h:...' guardada não é aceita como token.
//
// Caminho legado, só de leitura: sessão sem tokenHash ({ token } de aluno) ou
// adminSessions[tokenCru] (criadas antes desta versão, ou injetadas pelos testes)
// continuam valendo pelo token cru, para nenhum aluno ou professor cair por causa da
// troca de formato. Nenhum código novo grava token cru na memória ou no disco.
//
// Fora deste módulo não se lê adminSessions[...] nem se compara '.token ===' (teste
// estático em test/backend/auth-sessions.test.js). req.studentSessionToken e
// req.adminSessionToken continuam com o token cru (examFocusRules.sessionFingerprint).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const { ABSOLUTE_TTL_MS, SESSION_RESUME_MAX_DOWNTIME_MS } = require('./sessionConfig.js');
const { isInheritedKey } = require('./ownEntry.js');

const ADMIN_KEY_PREFIX = 'h:';
const TOKEN_BYTES = 32;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const DEFAULT_ORIGIN = 'login';
const ACTIVE_STUDENT_STATUSES = ['ativo', 'active'];

// db.memory sem criar dependência circular (database.js passa a usar este módulo na
// gravação das sessões, no H3a-2).
function currentMemory() {
    return require('../database.js').memory;
}

// Prazo absoluto da sessão (Configurações → Sessão, padrão 8 h).
function sessionAbsoluteTtlMs() {
    try {
        const hours = Number(require('./settings.js').getSettings().session.absoluteHours);
        if (Number.isFinite(hours) && hours > 0) return hours * 3600000;
    } catch (error) { /* configuração ilegível: vale o padrão */ }
    return ABSOLUTE_TTL_MS;
}

function hashSessionToken(raw) {
    if (typeof raw !== 'string' || !raw) return '';
    return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

function adminSessionKey(raw) {
    const hash = hashSessionToken(raw);
    return hash ? ADMIN_KEY_PREFIX + hash : '';
}

function newSessionToken() {
    return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function safeEqualText(left, right) {
    const a = Buffer.from(String(left), 'utf8');
    const b = Buffer.from(String(right), 'utf8');
    return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function ownValue(map, key) {
    if (!map || typeof map !== 'object' || typeof key !== 'string' || !key) return undefined;
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

// '__proto__' (ou 'constructor'...) como e-mail gravaria em Object.prototype.
function assertStorableEmail(email) {
    if (!email || isInheritedKey(email)) throw new TypeError('E-mail inválido para sessão.');
}

function validTimestamp(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

// Hash guardado de uma sessão de aluno: o tokenHash, ou o hash do token cru legado.
function studentSessionHash(session) {
    if (!session || typeof session !== 'object') return '';
    if (typeof session.tokenHash === 'string' && session.tokenHash) return HASH_PATTERN.test(session.tokenHash) ? session.tokenHash : '';
    return hashSessionToken(session.token);
}

// A sessão (de aluno) corresponde a este token? Pelo tokenHash; sessão legada sem
// tokenHash, pelo token cru. Comparação em tempo constante.
function sessionMatchesToken(session, raw, rawHash = hashSessionToken(raw)) {
    if (!session || typeof session !== 'object' || !rawHash) return false;
    if (typeof session.tokenHash === 'string' && session.tokenHash) return safeEqualText(session.tokenHash, rawHash);
    if (typeof session.token === 'string' && session.token) return safeEqualText(session.token, raw);
    return false;
}

function hasSessionCredential(session) {
    return !!(session && typeof session === 'object'
        && ((typeof session.tokenHash === 'string' && session.tokenHash) || (typeof session.token === 'string' && session.token)));
}

// Requisição que conta como uso real (não é polling automático): o cliente marca os
// polls com X-IClass-Background: 1 e, se houve interação recente, X-IClass-Active: 1.
// Só alimenta lastActivityAt; a ociosidade no servidor ainda não é aplicada.
function isUserActivityRequest(req) {
    const get = name => (req && typeof req.get === 'function' ? req.get(name) : (req && req.headers ? req.headers[name] : undefined));
    if (String(get('x-iclass-active') || '') === '1') return true;
    return String(get('x-iclass-background') || '') !== '1';
}

// Presença (lastSeen) a cada requisição autenticada; lastActivityAt só com uso real.
function touchSession(session, now = Date.now(), { active = true } = {}) {
    if (!session || typeof session !== 'object') return;
    session.lastSeen = now;
    if (active || !validTimestamp(session.lastActivityAt)) session.lastActivityAt = now;
}

function isSessionExpired(session, now, absoluteTtlMs) {
    const createdAt = validTimestamp(session && session.createdAt);
    const ttl = Number(absoluteTtlMs);
    if (!createdAt || !Number.isFinite(ttl) || ttl <= 0) return false;
    return now - createdAt > ttl;
}

// Sessão parada há mais de idleMs (última atividade; sem ela, lastSeen e createdAt).
// idleMs ausente ou 0: nunca ociosa.
function isSessionIdle(session, now = Date.now(), idleMs = 0) {
    const limit = Number(idleMs);
    if (!session || typeof session !== 'object' || !Number.isFinite(limit) || limit <= 0) return false;
    const reference = validTimestamp(session.lastActivityAt) || validTimestamp(session.lastSeen) || validTimestamp(session.createdAt);
    return !!reference && now - reference > limit;
}

// ---------------------------------------------------------------------------
// Aluno
// ---------------------------------------------------------------------------

// { email, session } da sessão de aluno com este token, ou null.
function findStudentSession(memory, raw) {
    const rawHash = hashSessionToken(raw);
    const sessions = memory && memory.sessions;
    if (!rawHash || !sessions || typeof sessions !== 'object') return null;
    for (const email of Object.keys(sessions)) {
        const session = sessions[email];
        if (sessionMatchesToken(session, raw, rawHash)) return { email, session };
    }
    return null;
}

// Sessão gravada para o e-mail (só chave própria), em qualquer formato.
function studentSessionByEmail(memory, email) {
    return ownValue(memory && memory.sessions, normalizeEmail(email));
}

// Sessão única: um login novo substitui a sessão anterior do mesmo e-mail (o token do
// outro aparelho deixa de valer). Devolve o token cru, que só vai na resposta.
function createStudentSession(memory, email, { ip = '', now = Date.now(), origin = DEFAULT_ORIGIN } = {}) {
    const normalizedEmail = normalizeEmail(email);
    assertStorableEmail(normalizedEmail);
    const token = newSessionToken();
    if (!memory.sessions || typeof memory.sessions !== 'object') memory.sessions = {};
    const session = { tokenHash: hashSessionToken(token), createdAt: now, lastSeen: now, lastActivityAt: now, ip: String(ip || '') };
    if (origin && origin !== DEFAULT_ORIGIN) session.origin = String(origin);
    memory.sessions[normalizedEmail] = session;
    return token;
}

function revokeStudentSession(memory, email) {
    const sessions = memory && memory.sessions;
    const normalizedEmail = normalizeEmail(email);
    if (ownValue(sessions, normalizedEmail) === undefined) return false;
    delete sessions[normalizedEmail];
    return true;
}

// Sessão de aluno aberta antes de o professor redefinir a senha (H5b, SEG-10)? O
// "Redefinir senha" grava na conta sessionsInvalidBefore (ms) e encerra a sessão na hora;
// se o aluno estava em prova, a sessão continua até o fim da prova e esta conferência
// (validateStudentSession) a encerra depois. Vale também depois de um reinício (a sessão
// retomada guarda o createdAt).
function sessionPredatesRevocation(account, session) {
    const cutoff = validTimestamp(account && account.sessionsInvalidBefore);
    if (!cutoff) return false;
    const createdAt = validTimestamp(session && session.createdAt);
    return !createdAt || createdAt <= cutoff;
}

// Consulta, sem efeito colateral: { ok: true, email, session, account } ou
// { ok: false, reason } com reason 'missing' (token desconhecido), 'expired' (prazo
// absoluto), 'idle' (só com options.idleMs), 'account_missing' ou 'account_inactive'.
function checkStudentSessionToken(raw, now = Date.now(), options = {}) {
    const memory = options.memory || currentMemory();
    const found = findStudentSession(memory, raw);
    if (!found) return { ok: false, reason: 'missing' };
    const { email, session } = found;
    const absoluteTtlMs = options.absoluteTtlMs !== undefined ? options.absoluteTtlMs : sessionAbsoluteTtlMs();
    if (isSessionExpired(session, now, absoluteTtlMs)) return { ok: false, reason: 'expired', email, session };
    if (isSessionIdle(session, now, options.idleMs)) return { ok: false, reason: 'idle', email, session };
    const account = (memory.students || []).find(item => item && item.email && String(item.email).toLowerCase() === email);
    if (!account) return { ok: false, reason: 'account_missing', email, session };
    const status = String(account.status || '').trim().toLowerCase();
    if (!ACTIVE_STUDENT_STATUSES.includes(status)) return { ok: false, reason: 'account_inactive', email, session, account };
    return { ok: true, email, session, account };
}

// ---------------------------------------------------------------------------
// Instrutor
// ---------------------------------------------------------------------------

function isAdminSessionValue(value) {
    return !!(value && typeof value === 'object' && typeof value.email === 'string' && value.email);
}

// Entrada de adminSessions para o token (válida ou não): pela chave 'h:' + hash; no
// legado, pela chave igual ao token cru. Um valor que já começa com 'h:' nunca cai no
// legado: a chave guardada não é credencial.
function adminSessionEntry(memory, raw) {
    if (typeof raw !== 'string' || !raw) return null;
    const map = memory && memory.adminSessions;
    if (!map || typeof map !== 'object') return null;
    const key = adminSessionKey(raw);
    if (ownValue(map, key) !== undefined) return { key, value: map[key], legacy: false };
    if (!raw.startsWith(ADMIN_KEY_PREFIX) && ownValue(map, raw) !== undefined) return { key: raw, value: map[raw], legacy: true };
    return null;
}

// { key, email, session } da sessão de instrutor com este token, ou null. Não confere
// prazo nem conta (para isso, checkAdminSessionToken).
function findAdminSession(memory, raw) {
    const entry = adminSessionEntry(memory, raw);
    if (!entry || !isAdminSessionValue(entry.value)) return null;
    return { key: entry.key, email: entry.value.email.toLowerCase(), session: entry.value, legacy: entry.legacy };
}

function createAdminSession(memory, email, { now = Date.now(), origin = DEFAULT_ORIGIN } = {}) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) throw new TypeError('E-mail inválido para sessão.');
    const token = newSessionToken();
    if (!memory.adminSessions || typeof memory.adminSessions !== 'object') memory.adminSessions = {};
    const session = { email: normalizedEmail, createdAt: now, lastSeen: now, lastActivityAt: now };
    if (origin && origin !== DEFAULT_ORIGIN) session.origin = String(origin);
    memory.adminSessions[adminSessionKey(token)] = session;
    return token;
}

// Remove a sessão deste token (válida, vencida ou com valor estragado).
function revokeAdminSession(memory, raw) {
    const entry = adminSessionEntry(memory, raw);
    if (!entry) return false;
    delete memory.adminSessions[entry.key];
    return true;
}

// Remove todas as sessões de instrutor do e-mail, menos a do token exceptToken (a do
// próprio pedido, na troca de senha). Devolve quantas saíram.
function revokeAdminSessions(memory, email, { exceptToken } = {}) {
    const map = memory && memory.adminSessions;
    const normalizedEmail = normalizeEmail(email);
    if (!map || typeof map !== 'object' || !normalizedEmail) return 0;
    const kept = exceptToken ? adminSessionEntry(memory, exceptToken) : null;
    let removed = 0;
    Object.keys(map).forEach(key => {
        const value = map[key];
        if (!isAdminSessionValue(value) || value.email.toLowerCase() !== normalizedEmail) return;
        if (kept && kept.key === key) return;
        delete map[key];
        removed += 1;
    });
    return removed;
}

// Consulta, sem efeito colateral: { ok: true, key, email, session, account } ou
// { ok: false, reason } com reason 'missing' (token desconhecido), 'invalid' (chave
// gravada com valor que não é sessão), 'expired', 'idle' (só com options.idleMs) ou
// 'account_missing' (conta apagada).
function checkAdminSessionToken(raw, now = Date.now(), options = {}) {
    const memory = options.memory || currentMemory();
    const entry = adminSessionEntry(memory, raw);
    if (!entry) return { ok: false, reason: 'missing' };
    const { key, value: session } = entry;
    if (!isAdminSessionValue(session)) return { ok: false, reason: 'invalid', key };
    const email = session.email.toLowerCase();
    const absoluteTtlMs = options.absoluteTtlMs !== undefined ? options.absoluteTtlMs : sessionAbsoluteTtlMs();
    if (isSessionExpired(session, now, absoluteTtlMs)) return { ok: false, reason: 'expired', key, email, session };
    if (isSessionIdle(session, now, options.idleMs)) return { ok: false, reason: 'idle', key, email, session };
    const account = (memory.admins || []).find(item => item && item.email && String(item.email).toLowerCase() === email);
    if (!account) return { ok: false, reason: 'account_missing', key, email, session };
    return { ok: true, key, email, session, account };
}

// Todas as sessões saem (boot sem retomada, restauração de backup).
function clearSessions(memory) {
    memory.sessions = {};
    memory.adminSessions = {};
}

// ---------------------------------------------------------------------------
// Gravação e retomada (a tabela auth_sessions e o boot são do H3a-2)
// ---------------------------------------------------------------------------

// Linhas para gravar: [{ key: sha256 do token, value: { kind, email, createdAt, ip?, origin? } }].
// Sem lastSeen e lastActivityAt, para a tabela não mudar a cada ping. Sessão legada
// (token cru) entra pelo hash do token; nada cru vai para o disco.
function persistedSessionRows(memory) {
    const rows = [];
    const seen = new Set();
    const push = (key, value) => {
        if (!key || seen.has(key)) return;
        seen.add(key);
        rows.push({ key, value });
    };
    Object.keys((memory && memory.sessions) || {}).forEach(email => {
        const session = memory.sessions[email];
        const hash = studentSessionHash(session);
        const createdAt = validTimestamp(session && session.createdAt);
        if (!hash || !createdAt || !email || isInheritedKey(email)) return;
        const value = { kind: 'student', email, createdAt };
        if (session.ip) value.ip = String(session.ip);
        if (session.origin && session.origin !== DEFAULT_ORIGIN) value.origin = String(session.origin);
        push(hash, value);
    });
    Object.keys((memory && memory.adminSessions) || {}).forEach(key => {
        const session = memory.adminSessions[key];
        const createdAt = validTimestamp(session && session.createdAt);
        if (!isAdminSessionValue(session) || !createdAt) return;
        let hash = '';
        if (key.startsWith(ADMIN_KEY_PREFIX)) hash = HASH_PATTERN.test(key.slice(ADMIN_KEY_PREFIX.length)) ? key.slice(ADMIN_KEY_PREFIX.length) : '';
        else hash = hashSessionToken(key);
        const value = { kind: 'admin', email: session.email.toLowerCase(), createdAt };
        if (session.origin && session.origin !== DEFAULT_ORIGIN) value.origin = String(session.origin);
        push(hash, value);
    });
    return rows;
}

function parseSessionRow(row) {
    if (!row || typeof row !== 'object') return null;
    const hash = String(row.key || '');
    let value = row.value;
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch (error) { return null; }
    }
    if (!HASH_PATTERN.test(hash) || !value || typeof value !== 'object') return null;
    if (value.kind !== 'student' && value.kind !== 'admin') return null;
    const email = normalizeEmail(value.email);
    const createdAt = validTimestamp(value.createdAt);
    if (!email || isInheritedKey(email) || !createdAt) return null;
    return { hash, kind: value.kind, email, createdAt, ip: value.ip ? String(value.ip) : '', origin: value.origin ? String(value.origin) : '' };
}

// Retomada das sessões gravadas depois de um reinício. Substitui sessions e
// adminSessions. Uma sessão volta só se:
// - o tempo fora do ar (downtimeMs, do heartbeat) é conhecido e cabe em maxDowntimeMs
//   (60 min): servidor desligado entre turnos continua derrubando todos;
// - now - createdAt cabe no prazo absoluto (8 h);
// - origin 'setup' (acesso rápido local) só volta com o modo setup ligado.
// Relógio que voltou (downtime negativo) conta como 0. E-mail de aluno repetido: fica
// a sessão mais nova. lastSeen volta null (o aluno aparece offline até o próximo ping)
// e lastActivityAt = now. Devolve { students, admins, dropped, reason, clockWentBack }.
function restoreSessions(memory, rows, options = {}) {
    const {
        now = Date.now(),
        downtimeMs,
        absoluteTtlMs = sessionAbsoluteTtlMs(),
        maxDowntimeMs = SESSION_RESUME_MAX_DOWNTIME_MS,
        setupMode = false,
    } = options;
    clearSessions(memory);
    let list = [];
    if (Array.isArray(rows)) list = rows;
    else if (rows instanceof Map) list = [...rows].map(([key, value]) => ({ key, value }));
    else if (rows && typeof rows === 'object') list = Object.keys(rows).map(key => ({ key, value: rows[key] }));
    const result = { students: 0, admins: 0, dropped: 0, reason: null, clockWentBack: false };

    let downtime = downtimeMs === null || downtimeMs === undefined ? NaN : Number(downtimeMs);
    if (!Number.isFinite(downtime)) {
        result.dropped = list.length;
        result.reason = 'downtime_unknown';
        return result;
    }
    if (downtime < 0) {
        downtime = 0;
        result.clockWentBack = true;
    }
    if (downtime > maxDowntimeMs) {
        result.dropped = list.length;
        result.reason = 'downtime_too_long';
        return result;
    }

    const students = new Map();
    list.forEach(row => {
        const parsed = parseSessionRow(row);
        if (!parsed) { result.dropped += 1; return; }
        const createdAt = Math.min(parsed.createdAt, now);
        if (now - createdAt > absoluteTtlMs || (parsed.origin === 'setup' && !setupMode)) { result.dropped += 1; return; }
        const origin = parsed.origin && parsed.origin !== DEFAULT_ORIGIN ? { origin: parsed.origin } : {};
        if (parsed.kind === 'admin') {
            const key = ADMIN_KEY_PREFIX + parsed.hash;
            if (ownValue(memory.adminSessions, key) !== undefined) { result.dropped += 1; return; }
            memory.adminSessions[key] = { email: parsed.email, createdAt, lastSeen: null, lastActivityAt: now, ...origin };
            result.admins += 1;
            return;
        }
        const previous = students.get(parsed.email);
        if (previous) {
            result.dropped += 1;
            if (previous.createdAt >= createdAt) return;
        }
        students.set(parsed.email, { tokenHash: parsed.hash, createdAt, lastSeen: null, lastActivityAt: now, ip: parsed.ip, ...origin });
    });
    students.forEach((session, email) => { memory.sessions[email] = session; });
    result.students = students.size;
    return result;
}

module.exports = {
    ADMIN_KEY_PREFIX,
    hashSessionToken,
    adminSessionKey,
    sessionAbsoluteTtlMs,
    sessionMatchesToken,
    hasSessionCredential,
    isUserActivityRequest,
    touchSession,
    isSessionIdle,
    findStudentSession,
    studentSessionByEmail,
    createStudentSession,
    revokeStudentSession,
    sessionPredatesRevocation,
    checkStudentSessionToken,
    findAdminSession,
    createAdminSession,
    revokeAdminSession,
    revokeAdminSessions,
    checkAdminSessionToken,
    clearSessions,
    persistedSessionRows,
    restoreSessions,
};
