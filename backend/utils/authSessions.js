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

// Sessão gravada para o e-mail (só chave própria), em qualquer formato. Também é por
// aqui que o painel lê a presença (lastSeen) do aluno.
function studentSessionByEmail(memory, email) {
    return ownValue(memory && memory.sessions, normalizeEmail(email));
}

// E-mails com sessão (ou presença) de aluno na memória, só chaves próprias.
function studentSessionEmails(memory) {
    const sessions = memory && memory.sessions;
    if (!sessions || typeof sessions !== 'object') return [];
    return Object.keys(sessions).filter(email => email && !isInheritedKey(email));
}

// Presença sem login (semente de demonstração do TEST_MODE): o aluno aparece "online"
// no painel. Com sessão de verdade, só a presença muda; sem ela, fica só { lastSeen },
// que não autentica (sem credencial) e não vai para a tabela auth_sessions. Antes a
// semente gravava um número cru em sessions[email], por cima da sessão que houvesse.
function markStudentPresence(memory, email, lastSeen = Date.now()) {
    const normalizedEmail = normalizeEmail(email);
    assertStorableEmail(normalizedEmail);
    if (!memory.sessions || typeof memory.sessions !== 'object') memory.sessions = {};
    const seen = validTimestamp(lastSeen) || Date.now();
    const current = ownValue(memory.sessions, normalizedEmail);
    if (hasSessionCredential(current)) current.lastSeen = seen;
    else memory.sessions[normalizedEmail] = { lastSeen: seen };
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
    // O token do outro aparelho fica com o motivo 'replaced': o pedido seguinte dele recebe
    // o 401 'replaced' também nas rotas sem e-mail (antes, 400 "E-mail do estudante é
    // obrigatório.") e também depois de um reinício.
    const previous = ownValue(memory.sessions, normalizedEmail);
    if (hasSessionCredential(previous)) rememberRevocation(studentSessionHash(previous), 'replaced', now);
    memory.sessions[normalizedEmail] = session;
    return token;
}

// Sessões encerradas há pouco, com o motivo (H5b; contrato das respostas de estado: 401
// { sessionRevoked: true, reason }). A sessão revogada sai da memória e da tabela, e o
// pedido seguinte do token antigo cairia no "sessão expirada" genérico: o aluno cuja senha
// o professor redefiniu lia "Sessão expirada" em vez do motivo. Aqui fica só o sha256 do
// token e o motivo ('logout', 'password_reset', 'password_changed' ou 'replaced', quando um
// login novo da mesma conta substituiu a sessão), por no máximo o prazo absoluto da sessão
// e até 5.000 entradas (a mais antiga sai primeiro).
// Gravado junto com as sessões (frente do H3, sobra da J2): cada motivo vira uma linha de
// auth_sessions { kind: 'revoked', reason, at } com o mesmo sha256 como chave
// (persistedRevocationRows) e volta no boot pela restoreSessions, mesmo quando as sessões
// não voltam (o motivo continua verdadeiro). Antes ficava só na memória e, depois de um
// reinício, o aluno da senha redefinida lia "Sessão expirada". A versão anterior lê essa
// linha como ilegível e a descarta (sem erro).
const RECENT_REVOCATIONS_MAX = 5000;
const REVOCATION_REASONS = Object.freeze(['logout', 'password_reset', 'password_changed', 'replaced']);
const recentRevocations = new Map(); // sha256 do token → { reason, at }

function rememberRevocation(hash, reason, now = Date.now()) {
    if (!hash || !reason || !HASH_PATTERN.test(hash)) return;
    recentRevocations.delete(hash);
    recentRevocations.set(hash, { reason: String(reason), at: now });
    while (recentRevocations.size > RECENT_REVOCATIONS_MAX) {
        recentRevocations.delete(recentRevocations.keys().next().value);
    }
}

// Motivo do encerramento recente da sessão deste token (cru), ou null.
function revokedSessionReason(raw, now = Date.now()) {
    const hash = hashSessionToken(raw);
    const entry = hash ? recentRevocations.get(hash) : null;
    if (!entry) return null;
    if (now - entry.at > sessionAbsoluteTtlMs()) {
        recentRevocations.delete(hash);
        return null;
    }
    return entry.reason;
}

// Linhas dos motivos para a tabela auth_sessions: [{ key: sha256, value: { kind: 'revoked',
// reason, at } }], só os que ainda estão no prazo. Sem e-mail nem IP: o motivo só serve
// para o pedido seguinte do token antigo.
function persistedRevocationRows({ now = Date.now(), absoluteTtlMs = sessionAbsoluteTtlMs() } = {}) {
    const rows = [];
    recentRevocations.forEach((entry, hash) => {
        if (!entry || !REVOCATION_REASONS.includes(entry.reason)) return;
        if (now - entry.at > absoluteTtlMs) return;
        rows.push({ key: hash, value: { kind: 'revoked', reason: entry.reason, at: entry.at } });
    });
    return rows;
}

// Linha de motivo gravada ({ key, value }, value em texto JSON ou objeto) → { hash, reason,
// at }, ou null se não for uma linha de motivo legível.
function parseRevocationRow(row) {
    if (!row || typeof row !== 'object') return null;
    const hash = String(row.key || '');
    let value = row.value;
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch (error) { return null; }
    }
    if (!HASH_PATTERN.test(hash) || !value || typeof value !== 'object' || value.kind !== 'revoked') return null;
    const at = validTimestamp(value.at);
    if (!at || !REVOCATION_REASONS.includes(value.reason)) return null;
    return { hash, reason: value.reason, at };
}

function isRevocationRow(row) {
    if (!row || typeof row !== 'object') return false;
    let value = row.value;
    if (typeof value === 'string') {
        if (!value.includes('"revoked"')) return false;
        try { value = JSON.parse(value); } catch (error) { return false; }
    }
    return !!(value && typeof value === 'object' && value.kind === 'revoked');
}

// Esquece todos os motivos (restauração de backup: todos entram de novo, e o token antigo
// responde como sessão vencida; o motivo de antes da restauração não é mais o que importa).
function clearRevokedSessionReasons() {
    recentRevocations.clear();
}

function clearRecentRevocationsForTests() {
    recentRevocations.clear();
}

// Encerra a sessão do aluno. reason (opcional) fica guardado para o pedido seguinte do
// token antigo receber o motivo (revokedSessionReason).
function revokeStudentSession(memory, email, { reason, now = Date.now() } = {}) {
    const sessions = memory && memory.sessions;
    const normalizedEmail = normalizeEmail(email);
    if (ownValue(sessions, normalizedEmail) === undefined) return false;
    if (reason) rememberRevocation(studentSessionHash(sessions[normalizedEmail]), reason, now);
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
// absoluto), 'idle' (só com options.idleMs), 'account_missing', 'account_inactive' ou
// 'password_reset' (sessão de antes do "Redefinir senha", fora de uma tentativa aberta:
// a mesma regra de validateStudentSession, para o token antigo não continuar abrindo
// arquivo em /uploads e /imagens depois da prova).
function checkStudentSessionToken(raw, now = Date.now(), options = {}) {
    const memory = options.memory || currentMemory();
    const found = findStudentSession(memory, raw);
    if (!found) return { ok: false, reason: revokedSessionReason(raw, now) || 'missing' };
    const { email, session } = found;
    const absoluteTtlMs = options.absoluteTtlMs !== undefined ? options.absoluteTtlMs : sessionAbsoluteTtlMs();
    if (isSessionExpired(session, now, absoluteTtlMs)) return { ok: false, reason: 'expired', email, session };
    if (isSessionIdle(session, now, options.idleMs)) return { ok: false, reason: 'idle', email, session };
    const account = (memory.students || []).find(item => item && item.email && String(item.email).toLowerCase() === email);
    if (!account) return { ok: false, reason: 'account_missing', email, session };
    const status = String(account.status || '').trim().toLowerCase();
    if (!ACTIVE_STUDENT_STATUSES.includes(status)) return { ok: false, reason: 'account_inactive', email, session, account };
    // Carregado aqui: passwordChange.js lê o estado das provas (sem dependência circular).
    if (sessionPredatesRevocation(account, session) && !require('./passwordChange.js').studentHasOpenAttempt(memory, email, now)) {
        return { ok: false, reason: 'password_reset', email, session, account };
    }
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

// sha256 do token de uma chave de adminSessions ('h:' + hash, ou o token cru legado).
function adminKeyHash(key) {
    if (typeof key !== 'string' || !key) return '';
    if (key.startsWith(ADMIN_KEY_PREFIX)) {
        const hash = key.slice(ADMIN_KEY_PREFIX.length);
        return HASH_PATTERN.test(hash) ? hash : '';
    }
    return hashSessionToken(key);
}

// Remove a sessão deste token (válida, vencida ou com valor estragado). reason
// (opcional), como em revokeStudentSession.
function revokeAdminSession(memory, raw, { reason, now = Date.now() } = {}) {
    const entry = adminSessionEntry(memory, raw);
    if (!entry) return false;
    if (reason) rememberRevocation(adminKeyHash(entry.key), reason, now);
    dropPreviewsOfAdminHash(memory, adminKeyHash(entry.key));
    delete memory.adminSessions[entry.key];
    return true;
}

// Remove todas as sessões de instrutor do e-mail, menos a do token exceptToken (a do
// próprio pedido, na troca de senha). Devolve quantas saíram. reason (opcional), como em
// revokeStudentSession.
function revokeAdminSessions(memory, email, { exceptToken, reason, now = Date.now() } = {}) {
    const map = memory && memory.adminSessions;
    const normalizedEmail = normalizeEmail(email);
    if (!map || typeof map !== 'object' || !normalizedEmail) return 0;
    const kept = exceptToken ? adminSessionEntry(memory, exceptToken) : null;
    let removed = 0;
    Object.keys(map).forEach(key => {
        const value = map[key];
        if (!isAdminSessionValue(value) || value.email.toLowerCase() !== normalizedEmail) return;
        if (kept && kept.key === key) return;
        if (reason) rememberRevocation(adminKeyHash(key), reason, now);
        dropPreviewsOfAdminHash(memory, adminKeyHash(key));
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
    if (!entry) return { ok: false, reason: revokedSessionReason(raw, now) || 'missing' };
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

// Todas as sessões saem (memória nova, restauração de backup). As pré-visualizações
// (memory.previewSessions) saem junto: restaurar um backup encerra as prévias.
function clearSessions(memory) {
    memory.sessions = {};
    memory.adminSessions = {};
    delete memory.previewSessions;
}

// ---------------------------------------------------------------------------
// Pré-visualização como aluno (fase 3, P5-S6a, CRIT-08)
//
// Sessão de leitura que o instrutor abre para ver o portal de uma turma como um aluno
// dela (POST /api/admin/preview-sessions). Fica só na memória, em memory.previewSessions
// (fora do registro de tabelas, do backup e da tabela auth_sessions): reinício e
// restauração de backup encerram as prévias. Como nas outras sessões, a chave é o sha256
// do token; o token cru só vai na resposta. Cada prévia:
// { id, adminSessionHash, adminEmail, accountStamp, courseId, studentClass, groupId,
//   studentEmail ('previa-<hex>@previa.invalid'), createdAt, expiresAt }.
// Ela vale enquanto: está no prazo (60 min), a sessão de instrutor que a abriu existe
// (Sair ou troca de senha em outro aparelho a encerram) e a senha da conta não mudou
// (accountStamp, conferido em utils/previewAccess.js). Usá-la não muda nada aqui: a
// leitura do portal na prévia não pode alterar a memória.
// ---------------------------------------------------------------------------
const PREVIEW_TTL_MS = 60 * 60 * 1000;
const PREVIEW_MAX_PER_ADMIN_SESSION = 5;
const PREVIEW_MAX_TOTAL = 500;
const PREVIEW_EMAIL_DOMAIN = 'previa.invalid';

function previewMap(memory, { create = false } = {}) {
    if (!memory || typeof memory !== 'object') return null;
    const current = memory.previewSessions;
    if (current && typeof current === 'object' && !Array.isArray(current)) return current;
    if (!create) return null;
    memory.previewSessions = {};
    return memory.previewSessions;
}

function isPreviewValue(value) {
    return !!(value && typeof value === 'object' && typeof value.adminSessionHash === 'string' && value.adminSessionHash
        && typeof value.studentEmail === 'string' && value.studentEmail);
}

// sha256 do token da sessão de instrutor deste pedido ('' sem sessão gravada).
function adminSessionHashOf(memory, rawAdminToken) {
    const entry = adminSessionEntry(memory, rawAdminToken);
    return entry && isAdminSessionValue(entry.value) ? adminKeyHash(entry.key) : '';
}

// Sessão de instrutor pelo sha256 do token: chave 'h:' + hash ou, no legado, a chave
// igual ao token cru cujo hash bate. null quando ela não existe mais.
function adminSessionByHash(memory, hash) {
    const map = memory && memory.adminSessions;
    if (!hash || !HASH_PATTERN.test(hash) || !map || typeof map !== 'object') return null;
    const key = ADMIN_KEY_PREFIX + hash;
    const direct = ownValue(map, key);
    if (direct !== undefined) return isAdminSessionValue(direct) ? { key, session: direct } : null;
    for (const legacyKey of Object.keys(map)) {
        if (legacyKey.startsWith(ADMIN_KEY_PREFIX) || isInheritedKey(legacyKey)) continue;
        if (adminKeyHash(legacyKey) === hash) return isAdminSessionValue(map[legacyKey]) ? { key: legacyKey, session: map[legacyKey] } : null;
    }
    return null;
}

// Prévias vencidas ou ilegíveis saem (chamado ao abrir uma prévia nova, nunca numa leitura).
function prunePreviewSessions(memory, now = Date.now()) {
    const map = previewMap(memory);
    if (!map) return 0;
    let removed = 0;
    Object.keys(map).forEach(key => {
        const value = map[key];
        if (!isPreviewValue(value) || !(Number(value.expiresAt) > now)) {
            delete map[key];
            removed += 1;
        }
    });
    return removed;
}

// Abre uma prévia para a sessão de instrutor do token adminToken. Devolve { token,
// session } (token cru só para a resposta) ou lança TypeError sem sessão de instrutor.
// Cada sessão de instrutor guarda até 5 prévias (a mais antiga sai) e a memória até 500.
function createPreviewSession(memory, { adminToken, courseId, studentClass, groupId = null, accountStamp = '', now = Date.now() } = {}) {
    const entry = adminSessionEntry(memory, adminToken);
    if (!entry || !isAdminSessionValue(entry.value)) throw new TypeError('Sessão de instrutor inválida para a pré-visualização.');
    const adminSessionHash = adminKeyHash(entry.key);
    const map = previewMap(memory, { create: true });
    prunePreviewSessions(memory, now);
    const byCreation = (a, b) => Number(map[a].createdAt || 0) - Number(map[b].createdAt || 0);
    const own = Object.keys(map).filter(key => map[key].adminSessionHash === adminSessionHash).sort(byCreation);
    while (own.length >= PREVIEW_MAX_PER_ADMIN_SESSION) delete map[own.shift()];
    const all = Object.keys(map).sort(byCreation);
    while (all.length >= PREVIEW_MAX_TOTAL) delete map[all.shift()];

    const token = newSessionToken();
    const session = {
        id: `prev_${now}_${crypto.randomBytes(3).toString('hex')}`,
        adminSessionHash,
        adminEmail: entry.value.email.toLowerCase(),
        accountStamp: String(accountStamp || ''),
        courseId: String(courseId || ''),
        studentClass: String(studentClass || ''),
        groupId: groupId ? String(groupId) : null,
        studentEmail: `previa-${crypto.randomBytes(8).toString('hex')}@${PREVIEW_EMAIL_DOMAIN}`,
        createdAt: now,
        expiresAt: now + PREVIEW_TTL_MS,
    };
    map[hashSessionToken(token)] = session;
    return { token, session };
}

// { hash, session, adminSession } da prévia deste token, ou { reason } quando ela não vale:
// 'missing' (token desconhecido), 'expired' (passou dos 60 min) ou 'admin_session' (a
// sessão do instrutor que a abriu acabou: saiu da memória ou passou do prazo absoluto,
// como em checkAdminSessionToken). Sem efeito colateral: não apaga nem atualiza nada (a
// conferência da conta, da permissão e da turma é de utils/previewAccess.js). Antes, a
// sessão do painel vencida pelo prazo e ainda não removida (limpeza de 15 min ou pedido
// do painel com aquele token) mantinha a prévia aberta.
function findPreviewSession(memory, raw, now = Date.now(), { absoluteTtlMs = sessionAbsoluteTtlMs() } = {}) {
    const hash = hashSessionToken(raw);
    const map = previewMap(memory);
    const session = hash && map ? ownValue(map, hash) : undefined;
    if (!isPreviewValue(session)) return { reason: 'missing' };
    if (!(Number(session.expiresAt) > now)) return { reason: 'expired', hash, session };
    const admin = adminSessionByHash(memory, session.adminSessionHash);
    if (!admin || isSessionExpired(admin.session, now, absoluteTtlMs)) return { reason: 'admin_session', hash, session };
    return { hash, session, adminSession: admin.session };
}

// Encerra a prévia deste token. Com adminToken, só se ela é da mesma conta.
function endPreviewSession(memory, raw, { adminEmail } = {}) {
    const hash = hashSessionToken(raw);
    const map = previewMap(memory);
    const session = hash && map ? ownValue(map, hash) : undefined;
    if (!isPreviewValue(session)) return false;
    if (adminEmail && session.adminEmail !== normalizeEmail(adminEmail)) return false;
    delete map[hash];
    return true;
}

// Encerra todas as prévias da conta (e-mail do instrutor). Devolve quantas saíram.
function endPreviewSessionsOf(memory, adminEmail) {
    const map = previewMap(memory);
    const email = normalizeEmail(adminEmail);
    if (!map || !email) return 0;
    let removed = 0;
    Object.keys(map).forEach(key => {
        if (isPreviewValue(map[key]) && map[key].adminEmail !== email) return;
        delete map[key];
        removed += 1;
    });
    return removed;
}

// As prévias abertas por uma sessão de instrutor que acabou de sair.
function dropPreviewsOfAdminHash(memory, adminSessionHash) {
    const map = previewMap(memory);
    if (!map || !adminSessionHash) return;
    Object.keys(map).forEach(key => {
        if (!isPreviewValue(map[key]) || map[key].adminSessionHash === adminSessionHash) delete map[key];
    });
}

// Limpeza periódica: remove as sessões que passaram do prazo absoluto (aluno e
// instrutor), para elas saírem também da tabela auth_sessions na gravação seguinte.
// Ausência de ping não revoga: navegadores congelam os timers de abas em segundo plano,
// e o aluno só aparece offline no Monitor. Sessão de aluno sem createdAt (formato antigo
// ou só presença) conta pelo lastSeen; sem nenhum dos dois, sai. Valor de instrutor que
// não é sessão também sai. Devolve quantas saíram.
function pruneExpiredSessions(memory, { now = Date.now(), absoluteTtlMs = sessionAbsoluteTtlMs() } = {}) {
    const ttl = Number(absoluteTtlMs);
    if (!memory || typeof memory !== 'object' || !Number.isFinite(ttl) || ttl <= 0) return 0;
    let removed = 0;
    const sessions = memory.sessions && typeof memory.sessions === 'object' ? memory.sessions : {};
    studentSessionEmails(memory).forEach(email => {
        const session = sessions[email];
        const reference = session && typeof session === 'object'
            ? (validTimestamp(session.createdAt) || validTimestamp(session.lastSeen))
            : validTimestamp(session);
        if (!reference || now - reference > ttl) {
            delete sessions[email];
            removed += 1;
        }
    });
    const admins = memory.adminSessions && typeof memory.adminSessions === 'object' ? memory.adminSessions : {};
    Object.keys(admins).forEach(key => {
        const session = admins[key];
        const reference = isAdminSessionValue(session) ? (validTimestamp(session.createdAt) || validTimestamp(session.lastSeen)) : null;
        if (!reference || now - reference > ttl) {
            delete admins[key];
            removed += 1;
        }
    });
    return removed;
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

// A linha gravada ({ key, value }, value em texto JSON ou objeto) é de uma sessão desta
// conta? kind 'admin' (instrutor) ou 'student'. Linha ilegível não é de ninguém.
function sessionRowBelongsTo(row, { kind, email } = {}) {
    const parsed = parseSessionRow(row);
    return !!parsed && parsed.kind === kind && parsed.email === normalizeEmail(email);
}

// E-mails (minúsculas) das contas que podem ter sessão: alunos ativos (mesma regra de
// checkStudentSessionToken) e instrutores cadastrados (checkAdminSessionToken).
function sessionAccountEmails(memory) {
    const emailOf = item => (item && item.email ? String(item.email).trim().toLowerCase() : '');
    const students = new Set();
    (Array.isArray(memory && memory.students) ? memory.students : []).forEach(item => {
        const status = String((item && item.status) || '').trim().toLowerCase();
        if (emailOf(item) && ACTIVE_STUDENT_STATUSES.includes(status)) students.add(emailOf(item));
    });
    const admins = new Set((Array.isArray(memory && memory.admins) ? memory.admins : []).map(emailOf).filter(Boolean));
    return { students, admins };
}

// Retomada das sessões gravadas depois de um reinício. Substitui sessions e
// adminSessions. Uma sessão volta só se:
// - o tempo fora do ar (downtimeMs, do heartbeat) é conhecido e cabe em maxDowntimeMs
//   (60 min): servidor desligado entre turnos continua derrubando todos;
// - now - createdAt cabe no prazo absoluto (8 h);
// - origin 'setup' (acesso rápido local) só volta com o modo setup ligado;
// - a conta ainda pode entrar, conferida em memory.students e memory.admins (já lidos
//   pelo db.init()): aluno cadastrado e ativo, instrutor cadastrado. Sessão de aluno
//   bloqueado ou apagado, ou de instrutor apagado, fica de fora; antes ela voltava, e com
//   o aluno desbloqueado (ou a conta recriada com o mesmo e-mail) o token antigo entrava
//   de novo, agora também depois de um reinício.
// Relógio que voltou (downtime negativo) conta como 0. E-mail de aluno repetido: fica
// a sessão mais nova. lastSeen volta null (o aluno aparece offline até o próximo ping)
// e lastActivityAt = now. As linhas de motivo (kind 'revoked') voltam para a lista de
// motivos recentes, à parte. Devolve { students, admins, dropped, revocations, reason,
// clockWentBack }.
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
    const result = { students: 0, admins: 0, dropped: 0, revocations: 0, reason: null, clockWentBack: false };
    // Motivos de sessões encerradas (persistedRevocationRows): voltam sempre que estão no
    // prazo absoluto, mesmo quando as sessões não voltam (tempo fora do ar desconhecido ou
    // longo demais): o motivo continua verdadeiro. Não contam como sessão descartada.
    list = list.filter(row => {
        if (!isRevocationRow(row)) return true;
        const parsed = parseRevocationRow(row);
        if (parsed && now - Math.min(parsed.at, now) <= absoluteTtlMs && !recentRevocations.has(parsed.hash)) {
            rememberRevocation(parsed.hash, parsed.reason, Math.min(parsed.at, now));
            result.revocations += 1;
        }
        return false;
    });

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

    const accounts = sessionAccountEmails(memory);
    const students = new Map();
    list.forEach(row => {
        const parsed = parseSessionRow(row);
        if (!parsed) { result.dropped += 1; return; }
        const createdAt = Math.min(parsed.createdAt, now);
        if (now - createdAt > absoluteTtlMs || (parsed.origin === 'setup' && !setupMode)) { result.dropped += 1; return; }
        if (!(parsed.kind === 'admin' ? accounts.admins : accounts.students).has(parsed.email)) { result.dropped += 1; return; }
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
    studentSessionEmails,
    markStudentPresence,
    createStudentSession,
    revokeStudentSession,
    revokedSessionReason,
    persistedRevocationRows,
    clearRevokedSessionReasons,
    clearRecentRevocationsForTests,
    sessionPredatesRevocation,
    checkStudentSessionToken,
    findAdminSession,
    createAdminSession,
    revokeAdminSession,
    revokeAdminSessions,
    checkAdminSessionToken,
    clearSessions,
    PREVIEW_TTL_MS,
    PREVIEW_EMAIL_DOMAIN,
    adminSessionHashOf,
    createPreviewSession,
    findPreviewSession,
    endPreviewSession,
    endPreviewSessionsOf,
    prunePreviewSessions,
    pruneExpiredSessions,
    persistedSessionRows,
    sessionRowBelongsTo,
    restoreSessions,
};
