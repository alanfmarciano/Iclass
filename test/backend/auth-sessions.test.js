// Sessões guardadas só como hash (H3a-1, utils/authSessions.js). Antes, o servidor
// guardava o token cru: sessions[email].token e adminSessions[tokenCru]. Agora o token
// cru fica só no navegador; a memória e a tabela auth_sessions (H3a-2) guardam o
// sha256. Os testes de formato e de retomada falham no código antigo; os do caminho
// legado (fixtures com { token } e adminSessions[tokenCru]) ficam de guarda para nenhum
// aluno ou professor cair por causa da troca de formato. Os do H3a-2 (no fim) conferem a
// tabela auth_sessions lida por outra conexão: login, Sair e saída do aluno gravam sem
// db.save() do teste, o ping não muda a linha, a restauração de backup esvazia a tabela e
// nenhum código fora do authSessions.js mexe nas sessões da memória. O reinício de
// verdade (kill -9) está em server-restart.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const sqlite3 = require('sqlite3');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-auth-sessions-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const runtimePaths = require('../../backend/runtimePaths.js');
const { createApp } = require('../../backend/server.js');
const authSessions = require('../../backend/utils/authSessions.js');
const { SESSION_RESUME_MAX_DOWNTIME_MS } = require('../../backend/utils/sessionConfig.js');

const {
    hashSessionToken,
    adminSessionKey,
    findStudentSession,
    findAdminSession,
    createStudentSession,
    createAdminSession,
    revokeStudentSession,
    revokeAdminSession,
    revokeAdminSessions,
    checkStudentSessionToken,
    checkAdminSessionToken,
    isSessionIdle,
    persistedSessionRows,
    restoreSessions,
    clearSessions,
    studentSessionByEmail,
    studentSessionEmails,
    markStudentPresence,
    pruneExpiredSessions,
} = authSessions;

const ADMIN = { email: 'adm@sessoes.local', password: 'senha-adm' };
const PROF = { email: 'prof@sessoes.local', password: 'senha-prof' };
const ANA = { email: 'ana@sessoes.local', password: 'senha-ana' };
const BIA = { email: 'bia@sessoes.local', password: 'senha-bia' };
const HOUR = 3600000;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
let app;

function seed() {
    db.memory.config = { ...(db.memory.config || {}), settings: {} };
    db.memory.admins = [
        { email: ADMIN.email, name: 'Admin', role: 'admin', password: db.hashPassword(ADMIN.password) },
        { email: PROF.email, name: 'Professor', role: 'professor', password: db.hashPassword(PROF.password), assignedClasses: [] },
    ];
    db.memory.students = [
        { name: 'Ana', email: ANA.email, status: 'Ativo', password: db.hashPassword(ANA.password), classes: [] },
        { name: 'Bia', email: BIA.email, status: 'Ativo', password: db.hashPassword(BIA.password), classes: [] },
    ];
    db.memory.sessions = {};
    db.memory.adminSessions = {};
    db.memory.classes = [];
    db.memory.courses = [];
    db.memory.evaluations = {};
    db.memory.attendance = [];
    db.memory.loginLogs = [];
    db.memory.auditLogs = [];
    db.memory.library = [];
    db.memory.branding = {};
}

async function studentLogin(account = ANA) {
    const res = await request(app).post('/api/student/login').send({ email: account.email, password: account.password });
    assert.equal(res.status, 200, `login do aluno: ${res.status} ${res.body && res.body.error}`);
    assert.ok(res.body.sessionToken);
    return res.body.sessionToken;
}

async function adminLogin(account = ADMIN) {
    const res = await request(app).get('/api/admin/whoami').set('Authorization', `${account.email}:${account.password}`);
    assert.equal(res.status, 200, `login do instrutor: ${res.status} ${res.body && res.body.error}`);
    assert.ok(res.body.sessionToken);
    return res.body.sessionToken;
}

const ping = (token, email = ANA.email) => request(app).get('/api/ping').query({ email }).set('x-session-token', token);
const whoami = token => request(app).get('/api/admin/whoami').set('x-admin-session', token);

test.before(async () => { await db.init(); app = createApp(); });
test.beforeEach(() => { seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1000));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-AUTH-001] login do aluno guarda só o hash do token (antes: token cru em sessions[email].token)', async () => {
    const token = await studentLogin();
    const session = db.memory.sessions[ANA.email];
    assert.equal(session.tokenHash, sha256(token));
    assert.equal(Object.hasOwn(session, 'token'), false, 'nada de token cru na memória');
    assert.equal(JSON.stringify(db.memory.sessions).includes(token), false);
    assert.ok(session.createdAt && session.lastSeen && session.lastActivityAt);
    assert.ok(Buffer.from(token, 'base64url').length >= 32, 'token com 32 bytes aleatórios');
    // O token cru continua valendo no navegador.
    await ping(token).expect(200);
    await request(app).get('/api/ping').set('x-session-token', token).expect(200);
    // Um login novo (outro aparelho) derruba o anterior: sessão única, como antes.
    const second = await studentLogin();
    const old = await ping(token);
    assert.equal(old.status, 401);
    assert.equal(old.body.sessionRevoked, true);
    await ping(second).expect(200);
});

test('[UC-AUTH-001] sessão do instrutor fica na chave h:+sha256 (antes: adminSessions[tokenCru])', async () => {
    const token = await adminLogin();
    const key = 'h:' + sha256(token);
    assert.equal(adminSessionKey(token), key);
    assert.deepEqual(Object.keys(db.memory.adminSessions), [key]);
    assert.equal(db.memory.adminSessions[key].email, ADMIN.email);
    assert.equal(JSON.stringify(db.memory.adminSessions).includes(token), false);
    const me = await whoami(token).expect(200);
    // req.adminSessionToken continua cru: o whoami devolve o mesmo token.
    assert.equal(me.body.sessionToken, token);
    await request(app).get('/api/data.js').set('x-admin-session', token).expect(200);
});

test('[UC-AUTH-001] a chave ou o hash guardados não servem como token', async () => {
    const adminToken = await adminLogin();
    const studentToken = await studentLogin();
    const adminKey = adminSessionKey(adminToken);
    for (const stolen of [adminKey, adminKey.slice(2), hashSessionToken(adminToken)]) {
        const res = await whoami(stolen);
        assert.equal(res.status, 401, `"${stolen.slice(0, 10)}…" como x-admin-session respondeu ${res.status}`);
        await request(app).get('/api/data.js').set('x-admin-session', stolen).expect(401);
    }
    const studentHash = db.memory.sessions[ANA.email].tokenHash;
    for (const stolen of [studentHash, 'h:' + studentHash]) {
        const res = await ping(stolen);
        assert.equal(res.status, 401, `hash como x-session-token respondeu ${res.status}`);
        // Sem e-mail, o token desconhecido nem identifica o aluno (400, como antes).
        const anonymous = await request(app).get('/api/ping').set('x-session-token', stolen);
        assert.ok([400, 401].includes(anonymous.status), `sem e-mail respondeu ${anonymous.status}`);
    }
    // A sessão de verdade continua inteira.
    await whoami(adminToken).expect(200);
    await ping(studentToken).expect(200);
});

test('[UC-AUTH-001] fixtures e sessões no formato antigo (token cru) continuam entrando', async () => {
    const now = Date.now();
    db.memory.adminSessions['token-admin-legado'] = { email: ADMIN.email, createdAt: now, lastSeen: now };
    db.memory.sessions[ANA.email] = { token: 'token-ana-legado', createdAt: now, lastSeen: now, ip: '127.0.0.1' };
    await whoami('token-admin-legado').expect(200);
    await request(app).get('/api/data.js').set('x-admin-session', 'token-admin-legado').expect(200);
    await ping('token-ana-legado').expect(200);
    await request(app).get('/api/ping').set('x-session-token', 'token-ana-legado').expect(200);
    // Token errado para o e-mail continua derrubando (sessão única).
    const wrong = await ping('outro-token');
    assert.equal(wrong.status, 401);
    // Valor com cara de chave guardada nunca cai no legado.
    db.memory.adminSessions['h:legado'] = { email: ADMIN.email, createdAt: now, lastSeen: now };
    await whoami('h:legado').expect(401);
    // Sair também apaga a sessão antiga.
    await request(app).post('/api/session/logout').set('x-admin-session', 'token-admin-legado').expect(200);
    assert.equal(Object.hasOwn(db.memory.adminSessions, 'token-admin-legado'), false);
    await whoami('token-admin-legado').expect(401);
    await request(app).post('/api/student/leave').set('x-session-token', 'token-ana-legado').send({ email: ANA.email }).expect(200);
    assert.equal(Object.hasOwn(db.memory.sessions, ANA.email), false);
});

test('[UC-AUTH-001] Sair (instrutor) e /api/student/leave removem a sessão gravada', async () => {
    const adminToken = await adminLogin();
    const studentToken = await studentLogin();
    await request(app).post('/api/session/logout').set('x-admin-session', adminToken).expect(200);
    assert.deepEqual(Object.keys(db.memory.adminSessions), []);
    await whoami(adminToken).expect(401);
    await request(app).post('/api/student/leave').set('Content-Type', 'text/plain')
        .set('x-session-token', studentToken).send(JSON.stringify({ email: ANA.email })).expect(200);
    assert.equal(Object.hasOwn(db.memory.sessions, ANA.email), false);
    await ping(studentToken).expect(401);
    assert.deepEqual(persistedSessionRows(db.memory), []);
});

test('[UC-AUTH-001] o ping não cria sessão sem token', async () => {
    const res = await request(app).get('/api/ping').query({ email: BIA.email });
    assert.equal(res.status, 401);
    assert.equal(Object.hasOwn(db.memory.sessions, BIA.email), false);
});

test('[UC-AUTH-001] token de instrutor vencido ou de conta apagada não abre arquivo, não fura a manutenção nem serve de requisitante', async () => {
    fs.mkdirSync(runtimePaths.UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(runtimePaths.UPLOADS_DIR, 'arquivo-sessoes.pdf'), '%PDF-1.4\n% protegido\n');
    const adminToken = await adminLogin();
    const profToken = await adminLogin(PROF);
    await request(app).get('/uploads/arquivo-sessoes.pdf').query({ access: adminToken }).expect(200);

    // Vencido (prazo absoluto de 8 h): antes o ?access= e /api/data.js ainda aceitavam.
    db.memory.adminSessions[adminSessionKey(adminToken)].createdAt = Date.now() - 9 * HOUR;
    await request(app).get('/uploads/arquivo-sessoes.pdf').query({ access: adminToken }).expect(401);
    await request(app).get('/uploads/arquivo-sessoes.pdf').set('x-admin-session', adminToken).expect(401);
    await request(app).get('/api/data.js').set('x-admin-session', adminToken).expect(401);

    // Conta apagada: a sessão que sobrou não vale mais.
    db.memory.admins = db.memory.admins.filter(item => item.email !== PROF.email);
    await request(app).get('/uploads/arquivo-sessoes.pdf').query({ access: profToken }).expect(401);
    await request(app).get('/api/data.js').set('x-admin-session', profToken).expect(401);

    // Manutenção: só a sessão válida de instrutor passa.
    db.memory.config.settings = { maintenance: { enabled: true, message: 'Em manutenção.' } };
    const blocked = await request(app).get('/api/ping').set('x-admin-session', adminToken);
    assert.equal(blocked.status, 503);
    assert.equal(blocked.body.maintenance, true);
    const freshAdmin = await adminLogin();
    const passed = await request(app).get('/api/ping').set('x-admin-session', freshAdmin);
    assert.notEqual(passed.status, 503);
});

test('[UC-AUTH-001] aluno bloqueado não baixa arquivo com a sessão que sobrou', async () => {
    fs.mkdirSync(runtimePaths.UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(runtimePaths.UPLOADS_DIR, 'capa-sessoes.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    db.memory.branding = { logo: '/uploads/capa-sessoes.png' };
    const token = await studentLogin();
    db.memory.students.find(item => item.email === ANA.email).status = 'Bloqueado';
    const check = checkStudentSessionToken(token);
    assert.equal(check.ok, false);
    assert.equal(check.reason, 'account_inactive');
    // Arquivo público da identidade visual continua abrindo para todos.
    await request(app).get('/uploads/capa-sessoes.png').query({ access: token }).expect(200);
    fs.writeFileSync(path.join(runtimePaths.UPLOADS_DIR, 'privado-sessoes.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await request(app).get('/uploads/privado-sessoes.png').set('x-session-token', token).expect(401);
});

test('[UC-AUTH-001] check*SessionToken só consulta e diz o motivo', () => {
    const memory = {
        students: [
            { email: 'ok@x.local', status: 'Ativo' },
            { email: 'parado@x.local', status: 'Inativo' },
        ],
        admins: [{ email: 'adm@x.local', role: 'admin' }],
        sessions: {},
        adminSessions: {},
    };
    const now = 1_000_000_000_000;
    const ok = createStudentSession(memory, 'OK@x.local', { ip: '10.0.0.5', now });
    const parado = createStudentSession(memory, 'parado@x.local', { now });
    const sumido = createStudentSession(memory, 'sumido@x.local', { now });
    const adm = createAdminSession(memory, 'adm@x.local', { now });
    const orfao = createAdminSession(memory, 'apagado@x.local', { now });
    const before = JSON.stringify(memory);
    const opts = { memory, absoluteTtlMs: 8 * HOUR };

    assert.deepEqual(checkStudentSessionToken('nao-existe', now, opts), { ok: false, reason: 'missing' });
    assert.equal(checkStudentSessionToken(ok, now, opts).ok, true);
    assert.equal(checkStudentSessionToken(ok, now, opts).email, 'ok@x.local');
    assert.equal(checkStudentSessionToken(ok, now + 9 * HOUR, opts).reason, 'expired');
    assert.equal(checkStudentSessionToken(parado, now, opts).reason, 'account_inactive');
    assert.equal(checkStudentSessionToken(sumido, now, opts).reason, 'account_missing');
    assert.equal(checkStudentSessionToken(ok, now + 2 * HOUR, { ...opts, idleMs: HOUR }).reason, 'idle');
    assert.equal(checkStudentSessionToken(ok, now + 2 * HOUR, opts).ok, true, 'sem idleMs não há ociosidade');

    assert.deepEqual(checkAdminSessionToken('__proto__', now, opts), { ok: false, reason: 'missing' });
    assert.deepEqual(checkAdminSessionToken(undefined, now, opts), { ok: false, reason: 'missing' });
    const admCheck = checkAdminSessionToken(adm, now, opts);
    assert.equal(admCheck.ok, true);
    assert.equal(admCheck.account.email, 'adm@x.local');
    assert.equal(checkAdminSessionToken(adm, now + 9 * HOUR, opts).reason, 'expired');
    assert.equal(checkAdminSessionToken(orfao, now, opts).reason, 'account_missing');
    memory.adminSessions['estragada'] = 7;
    assert.equal(checkAdminSessionToken('estragada', now, opts).reason, 'invalid');
    delete memory.adminSessions['estragada'];
    assert.equal(JSON.stringify(memory), before, 'a consulta não muda nada');

    assert.equal(isSessionIdle({ lastActivityAt: now - 2 * HOUR }, now, HOUR), true);
    assert.equal(isSessionIdle({ lastActivityAt: now - 10 }, now, HOUR), false);
    assert.equal(isSessionIdle({ lastSeen: now - 2 * HOUR }, now, HOUR), true, 'sem lastActivityAt vale lastSeen');
    assert.equal(isSessionIdle({ lastActivityAt: now - 2 * HOUR }, now, 0), false);
});

test('[UC-AUTH-001] revogação: por e-mail, por token e todas do instrutor menos a atual', () => {
    const memory = { sessions: {}, adminSessions: {} };
    const now = Date.now();
    const a1 = createAdminSession(memory, 'adm@x.local', { now });
    const a2 = createAdminSession(memory, 'ADM@x.local', { now });
    const other = createAdminSession(memory, 'outro@x.local', { now });
    memory.adminSessions['legado-adm'] = { email: 'adm@x.local', createdAt: now };
    assert.equal(revokeAdminSessions(memory, 'adm@x.local', { exceptToken: a1 }), 2);
    assert.ok(findAdminSession(memory, a1));
    assert.equal(findAdminSession(memory, a2), null);
    assert.equal(findAdminSession(memory, 'legado-adm'), null);
    assert.ok(findAdminSession(memory, other));
    assert.equal(revokeAdminSessions(memory, 'adm@x.local'), 1);
    assert.equal(findAdminSession(memory, a1), null);
    assert.equal(revokeAdminSession(memory, other), true);
    assert.equal(revokeAdminSession(memory, other), false);
    assert.deepEqual(memory.adminSessions, {});

    const s = createStudentSession(memory, 'ana@x.local', { now });
    assert.equal(findStudentSession(memory, s).email, 'ana@x.local');
    assert.equal(revokeStudentSession(memory, 'ANA@x.local'), true);
    assert.equal(revokeStudentSession(memory, 'ana@x.local'), false);
    assert.equal(revokeStudentSession(memory, '__proto__'), false);
    assert.equal(findStudentSession(memory, s), null);
    assert.throws(() => createStudentSession(memory, '__proto__', { now }), TypeError);
    assert.equal(Object.prototype.tokenHash, undefined);
});

test('[UC-AUTH-001] persistedSessionRows: só hashes, sem lastSeen, com origin quando não é login', async () => {
    const studentToken = await studentLogin();
    const adminToken = await adminLogin();
    const now = Date.now();
    db.memory.sessions[BIA.email] = { token: 'token-bia-legado', createdAt: now, lastSeen: now, ip: '10.1.1.1' };
    db.memory.adminSessions[adminSessionKey('setup-token')] = { email: ADMIN.email, createdAt: now, lastSeen: now, origin: 'setup' };
    db.memory.sessions['presenca@sessoes.local'] = now; // presença antiga (número): não é sessão

    const rows = persistedSessionRows(db.memory);
    const byKey = Object.fromEntries(rows.map(row => [row.key, row.value]));
    assert.equal(rows.length, 4);
    rows.forEach(row => assert.match(row.key, /^[0-9a-f]{64}$/));
    assert.deepEqual(Object.keys(byKey[sha256(studentToken)]).sort(), ['createdAt', 'email', 'ip', 'kind']);
    assert.equal(byKey[sha256(studentToken)].kind, 'student');
    assert.equal(byKey[sha256(studentToken)].email, ANA.email);
    assert.deepEqual(byKey[sha256(adminToken)], { kind: 'admin', email: ADMIN.email, createdAt: db.memory.adminSessions[adminSessionKey(adminToken)].createdAt });
    assert.equal(byKey[sha256('token-bia-legado')].email, BIA.email, 'sessão antiga entra pelo hash do token');
    assert.equal(byKey[sha256('setup-token')].origin, 'setup');
    const text = JSON.stringify(rows);
    for (const raw of [studentToken, adminToken, 'token-bia-legado', 'setup-token']) assert.equal(text.includes(raw), false);
    assert.equal(/lastSeen|lastActivityAt/.test(text), false);
});

test('[UC-AUTH-001] restoreSessions: reinício rápido mantém aluno e professor com o mesmo token', async () => {
    const studentToken = await studentLogin();
    const adminToken = await adminLogin();
    const rows = JSON.parse(JSON.stringify(persistedSessionRows(db.memory)));

    clearSessions(db.memory);
    await ping(studentToken).expect(401);
    await whoami(adminToken).expect(401);

    const now = Date.now();
    const result = restoreSessions(db.memory, rows, { now, downtimeMs: 5 * 60000 });
    assert.deepEqual(result, { students: 1, admins: 1, dropped: 0, reason: null, clockWentBack: false });
    assert.equal(db.memory.sessions[ANA.email].lastSeen, null, 'aparece offline até o próximo ping');
    assert.equal(db.memory.sessions[ANA.email].lastActivityAt, now);
    await ping(studentToken).expect(200);
    await whoami(adminToken).expect(200);

    // Fora do ar por mais de 60 min: todos entram de novo.
    const dropped = restoreSessions(db.memory, rows, { now, downtimeMs: SESSION_RESUME_MAX_DOWNTIME_MS + 60000 });
    assert.equal(dropped.reason, 'downtime_too_long');
    assert.equal(dropped.dropped, 2);
    await ping(studentToken).expect(401);
    await whoami(adminToken).expect(401);
});

test('[UC-AUTH-001] restoreSessions segue as regras de prazo, queda, origem e e-mail repetido', () => {
    const now = 2_000_000_000_000;
    const ttl = 8 * HOUR;
    const row = (token, value) => ({ key: sha256(token), value: JSON.stringify(value) });
    const rows = [
        row('aluno-1h', { kind: 'student', email: 'um@x.local', createdAt: now - HOUR, ip: '10.0.0.1' }),
        row('aluno-9h', { kind: 'student', email: 'velho@x.local', createdAt: now - 9 * HOUR }),
        row('prof-1h', { kind: 'admin', email: 'prof@x.local', createdAt: now - HOUR }),
        row('setup-aluno', { kind: 'student', email: 'setup@x.local', createdAt: now - 60000, origin: 'setup' }),
        row('setup-admin', { kind: 'admin', email: 'adm@x.local', createdAt: now - 60000, origin: 'setup' }),
        row('dup-velho', { kind: 'student', email: 'dup@x.local', createdAt: now - 3 * HOUR }),
        row('dup-novo', { kind: 'student', email: 'dup@x.local', createdAt: now - HOUR }),
        row('dup-meio', { kind: 'student', email: 'dup@x.local', createdAt: now - 2 * HOUR }),
        { key: 'nao-e-hash', value: { kind: 'student', email: 'x@x.local', createdAt: now } },
        row('proto', { kind: 'student', email: '__proto__', createdAt: now }),
        row('sem-tipo', { email: 'x@x.local', createdAt: now }),
        { key: sha256('json-quebrado'), value: '{"kind":' },
    ];
    // As contas existem e estão ativas (a regra da conta tem teste próprio, abaixo).
    const memory = {
        students: ['um@x.local', 'velho@x.local', 'setup@x.local', 'dup@x.local', 'x@x.local'].map(email => ({ email, status: 'Ativo' })),
        admins: [{ email: 'prof@x.local' }, { email: 'adm@x.local' }],
        sessions: { antigo: { tokenHash: sha256('antigo'), createdAt: now } },
        adminSessions: {},
    };

    const kept = restoreSessions(memory, rows, { now, downtimeMs: 5 * 60000, absoluteTtlMs: ttl });
    assert.equal(kept.students, 2);
    assert.equal(kept.admins, 1);
    assert.equal(kept.dropped, 9);
    assert.deepEqual(Object.keys(memory.sessions).sort(), ['dup@x.local', 'um@x.local'], 'substitui o que havia na memória');
    assert.equal(findStudentSession(memory, 'aluno-1h').email, 'um@x.local');
    assert.equal(memory.sessions['um@x.local'].ip, '10.0.0.1');
    assert.equal(findStudentSession(memory, 'aluno-9h'), null, 'mais de 8 h: descartada');
    assert.equal(findStudentSession(memory, 'dup-novo').email, 'dup@x.local', 'e-mail repetido: fica a mais nova');
    assert.equal(findStudentSession(memory, 'dup-velho'), null);
    assert.equal(findStudentSession(memory, 'setup-aluno'), null, "origin 'setup' só com o modo setup");
    assert.equal(findAdminSession(memory, 'prof-1h').email, 'prof@x.local');
    assert.equal(findAdminSession(memory, 'setup-admin'), null);
    assert.equal(Object.prototype.kind, undefined);

    const setup = restoreSessions(memory, rows, { now, downtimeMs: 0, absoluteTtlMs: ttl, setupMode: true });
    assert.equal(findStudentSession(memory, 'setup-aluno').email, 'setup@x.local');
    assert.equal(findAdminSession(memory, 'setup-admin').session.origin, 'setup');
    assert.equal(setup.students, 3);

    const back = restoreSessions(memory, rows, { now, downtimeMs: -30 * 60000, absoluteTtlMs: ttl });
    assert.equal(back.clockWentBack, true, 'relógio que voltou conta como 0');
    assert.equal(back.students, 2);

    for (const downtimeMs of [undefined, null, NaN, 'x']) {
        const unknown = restoreSessions(memory, rows, { now, downtimeMs, absoluteTtlMs: ttl });
        assert.equal(unknown.reason, 'downtime_unknown');
        assert.equal(unknown.dropped, rows.length);
        assert.deepEqual(memory.sessions, {});
        assert.deepEqual(memory.adminSessions, {});
    }
    const late = restoreSessions(memory, rows, { now, downtimeMs: 61 * 60000, absoluteTtlMs: ttl });
    assert.equal(late.reason, 'downtime_too_long');
    assert.deepEqual(memory.sessions, {});

    // Também aceita as linhas como Map (chave → valor), como sai de uma tabela.
    const asMap = new Map(rows.slice(0, 3).map(item => [item.key, item.value]));
    assert.equal(restoreSessions(memory, asMap, { now, downtimeMs: 1000, absoluteTtlMs: ttl }).admins, 1);
});

// Ajuste 2 do H3a-2. A retomada não conferia a conta: a sessão de um aluno bloqueado (ou
// apagado, ou de um instrutor apagado) voltava no boot, e com o aluno desbloqueado (ou a
// conta recriada com o mesmo e-mail) o token antigo entrava de novo, agora também depois
// de um reinício. Antes desta versão o reinício zerava todas.
test('[UC-AUTH-001] restoreSessions descarta sessão de aluno bloqueado ou apagado e de instrutor apagado', () => {
    const now = 2_000_000_000_000;
    const row = (token, value) => ({ key: sha256(token), value: JSON.stringify(value) });
    const memory = {
        students: [
            { email: 'Ativa@X.local', status: 'Ativo' },
            { email: 'active@x.local', status: ' active ' },
            { email: 'bloqueada@x.local', status: 'Bloqueado' },
            { email: 'inativa@x.local', status: 'Inativo' },
            { email: 'sem-status@x.local' },
        ],
        admins: [{ email: 'Prof@X.local', role: 'professor' }],
        sessions: {},
        adminSessions: {},
    };
    const rows = [
        row('ativa', { kind: 'student', email: 'ativa@x.local', createdAt: now - HOUR }),
        row('active', { kind: 'student', email: 'active@x.local', createdAt: now - HOUR }),
        row('bloqueada', { kind: 'student', email: 'bloqueada@x.local', createdAt: now - HOUR }),
        row('inativa', { kind: 'student', email: 'inativa@x.local', createdAt: now - HOUR }),
        row('sem-status', { kind: 'student', email: 'sem-status@x.local', createdAt: now - HOUR }),
        row('aluno-apagado', { kind: 'student', email: 'apagado@x.local', createdAt: now - HOUR }),
        row('prof', { kind: 'admin', email: 'prof@x.local', createdAt: now - HOUR }),
        row('prof-apagado', { kind: 'admin', email: 'apagado@x.local', createdAt: now - HOUR }),
        // Instrutor e aluno são contas diferentes: o e-mail de um não traz a sessão do outro.
        row('aluno-com-email-de-prof', { kind: 'student', email: 'prof@x.local', createdAt: now - HOUR }),
        row('prof-com-email-de-aluno', { kind: 'admin', email: 'ativa@x.local', createdAt: now - HOUR }),
    ];
    const result = restoreSessions(memory, rows, { now, downtimeMs: 60000, absoluteTtlMs: 8 * HOUR });
    assert.deepEqual(result, { students: 2, admins: 1, dropped: 7, reason: null, clockWentBack: false });
    assert.deepEqual(Object.keys(memory.sessions).sort(), ['active@x.local', 'ativa@x.local']);
    assert.equal(findAdminSession(memory, 'prof').email, 'prof@x.local');
    for (const token of ['bloqueada', 'inativa', 'sem-status', 'aluno-apagado', 'aluno-com-email-de-prof']) assert.equal(findStudentSession(memory, token), null, token);
    for (const token of ['prof-apagado', 'prof-com-email-de-aluno']) assert.equal(findAdminSession(memory, token), null, token);

    // Memória sem cadastro (contas ainda não lidas): ninguém volta.
    const empty = { sessions: {}, adminSessions: {} };
    assert.equal(restoreSessions(empty, rows, { now, downtimeMs: 60000, absoluteTtlMs: 8 * HOUR }).dropped, rows.length);
    assert.deepEqual(empty.sessions, {});
    assert.deepEqual(empty.adminSessions, {});
});

// Teste estático do contrato de sessões: fora de utils/authSessions.js ninguém lê
// adminSessions[...] nem compara o token cru, e nenhum código grava sessão com token.
test('[UC-AUTH-001] só utils/authSessions.js lê e grava sessão pelo token', () => {
    const backendDir = path.join(__dirname, '..', '..', 'backend');
    const files = [];
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
        if (entry.name === 'node_modules') return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(c|m)?js$/.test(entry.name)) files.push(full);
    });
    walk(backendDir);
    const offenders = [];
    files.filter(file => path.basename(file) !== 'authSessions.js').forEach(file => {
        const text = fs.readFileSync(file, 'utf8');
        const rel = path.relative(backendDir, file);
        if (/adminSessions\s*\[/.test(text)) offenders.push(`${rel}: adminSessions[`);
        if (/\.token\s*[!=]==?/.test(text)) offenders.push(`${rel}: .token ===`);
        if (/sessions\s*\[[^\]]+\]\s*=\s*\{[^}]*\btoken\s*:/s.test(text)) offenders.push(`${rel}: sessão gravada com token cru`);
    });
    assert.deepEqual(offenders, []);
});

// ---------------------------------------------------------------------------
// H3a-2: a tabela auth_sessions (CONF-03, UXA-06, DES-08)
// ---------------------------------------------------------------------------

// Linhas de auth_sessions lidas do arquivo por outra conexão (o que sobrevive a um kill -9).
async function storedSessionRows() {
    const connection = new sqlite3.Database(path.join(tempRoot, 'database.db'), sqlite3.OPEN_READONLY);
    try {
        const rows = await new Promise((resolve, reject) => connection.all('SELECT key, value FROM auth_sessions ORDER BY key', (err, list) => (err ? reject(err) : resolve(list))));
        return Object.fromEntries(rows.map(row => [row.key, row.value]));
    } finally {
        await new Promise(resolve => connection.close(() => resolve()));
    }
}

test('[UC-AUTH-001] login, Sair e saída do aluno gravam a tabela auth_sessions antes da resposta (antes: sessões só na memória)', async () => {
    await db.save();
    assert.deepEqual(await storedSessionRows(), {}, 'memória sem sessões: tabela vazia');

    const studentToken = await studentLogin();
    let stored = await storedSessionRows();
    assert.deepEqual(Object.keys(stored), [sha256(studentToken)]);
    const studentRow = JSON.parse(stored[sha256(studentToken)]);
    assert.equal(studentRow.kind, 'student');
    assert.equal(studentRow.email, ANA.email);
    assert.equal(studentRow.createdAt, db.memory.sessions[ANA.email].createdAt);

    const adminToken = await adminLogin();
    stored = await storedSessionRows();
    assert.deepEqual(Object.keys(stored).sort(), [sha256(studentToken), sha256(adminToken)].sort());
    assert.deepEqual(JSON.parse(stored[sha256(adminToken)]), { kind: 'admin', email: ADMIN.email, createdAt: db.memory.adminSessions[adminSessionKey(adminToken)].createdAt });
    const text = JSON.stringify(stored);
    assert.equal(text.includes(studentToken) || text.includes(adminToken), false, 'nada de token cru no arquivo');

    // O ping muda só a presença (lastSeen), que não vai para a tabela: a linha fica igual
    // mesmo depois de uma gravação completa.
    const before = stored[sha256(studentToken)];
    const seenBefore = db.memory.sessions[ANA.email].lastSeen;
    await new Promise(resolve => setTimeout(resolve, 5));
    await ping(studentToken).expect(200);
    assert.ok(db.memory.sessions[ANA.email].lastSeen > seenBefore);
    await db.save();
    stored = await storedSessionRows();
    assert.equal(stored[sha256(studentToken)], before);

    // Sair e /api/student/leave tiram a linha (sem db.save() do teste).
    await request(app).post('/api/session/logout').set('x-admin-session', adminToken).expect(200);
    assert.deepEqual(Object.keys(await storedSessionRows()), [sha256(studentToken)]);
    await request(app).post('/api/student/leave').set('x-session-token', studentToken).send({ email: ANA.email }).expect(200);
    assert.deepEqual(await storedSessionRows(), {});

    // Login novo do mesmo aluno (outro aparelho): a linha antiga sai junto.
    const first = await studentLogin();
    const second = await studentLogin();
    assert.deepEqual(Object.keys(await storedSessionRows()), [sha256(second)]);
    assert.notEqual(first, second);
});

test('[UC-AUTH-001] backup não leva sessões, e restaurar desconecta todos e esvazia auth_sessions', async () => {
    const backup = require('../../backend/utils/backup.js');
    const studentToken = await studentLogin();
    const adminToken = await adminLogin();
    assert.equal(Object.keys(await storedSessionRows()).length, 2);

    const snapshot = structuredClone(backup.buildDataSnapshot());
    ['sessions', 'adminSessions', 'authSessions', 'auth_sessions'].forEach(key => assert.equal(Object.hasOwn(snapshot.data, key), false, key));
    const text = JSON.stringify(snapshot);
    for (const secret of [studentToken, adminToken, sha256(studentToken), sha256(adminToken)]) assert.equal(text.includes(secret), false);

    await backup.restoreDataSnapshot(snapshot);
    assert.deepEqual(await storedSessionRows(), {});
    assert.deepEqual(persistedSessionRows(db.memory), []);
    await ping(studentToken).expect(401);
    await whoami(adminToken).expect(401);
    // Depois de restaurar, entrar de novo funciona e volta a gravar.
    const again = await studentLogin();
    assert.deepEqual(Object.keys(await storedSessionRows()), [sha256(again)]);
});

test('[UC-AUTH-001] markStudentPresence: presença sem login não autentica nem vai para a tabela', () => {
    const memory = { students: [{ email: 'ana@x.local', status: 'Ativo' }], sessions: {}, adminSessions: {} };
    const now = 1_500_000_000_000;
    const token = createStudentSession(memory, 'ana@x.local', { ip: '10.0.0.2', now });
    const hash = memory.sessions['ana@x.local'].tokenHash;

    // Sessão de verdade: só a presença muda (antes a semente gravava um número por cima).
    markStudentPresence(memory, 'ANA@x.local', now + 5000);
    assert.equal(memory.sessions['ana@x.local'].tokenHash, hash);
    assert.equal(memory.sessions['ana@x.local'].lastSeen, now + 5000);
    assert.equal(findStudentSession(memory, token).email, 'ana@x.local');

    // Sem sessão: só { lastSeen }, sem credencial.
    markStudentPresence(memory, 'bia@x.local', now);
    assert.deepEqual(memory.sessions['bia@x.local'], { lastSeen: now });
    assert.equal(studentSessionByEmail(memory, 'BIA@x.local').lastSeen, now);
    assert.deepEqual(studentSessionEmails(memory).sort(), ['ana@x.local', 'bia@x.local']);
    assert.deepEqual(persistedSessionRows(memory).map(row => row.value.email), ['ana@x.local']);
    assert.throws(() => markStudentPresence(memory, '__proto__', now), TypeError);
    assert.equal(Object.prototype.lastSeen, undefined);
    assert.equal(studentSessionByEmail(memory, 'constructor'), undefined);
});

test('[UC-AUTH-001] pruneExpiredSessions tira aluno e instrutor vencidos, formatos antigos e valores que não são sessão', () => {
    const now = 1_700_000_000_000;
    const ttl = 8 * HOUR;
    const memory = { sessions: {}, adminSessions: {} };
    const fresh = createStudentSession(memory, 'novo@x.local', { now: now - HOUR });
    createStudentSession(memory, 'velho@x.local', { now: now - 9 * HOUR });
    memory.sessions['numero-recente@x.local'] = now - HOUR; // presença antiga (número)
    memory.sessions['numero-velho@x.local'] = now - 9 * HOUR;
    memory.sessions['presenca@x.local'] = { lastSeen: now - 2 * HOUR };
    memory.sessions['presenca-velha@x.local'] = { lastSeen: now - 10 * HOUR };
    memory.sessions['vazio@x.local'] = {};
    const adminFresh = createAdminSession(memory, 'adm@x.local', { now: now - HOUR });
    const adminOld = createAdminSession(memory, 'adm@x.local', { now: now - 9 * HOUR });
    memory.adminSessions['legado-velho'] = { email: 'adm@x.local', createdAt: now - 9 * HOUR };
    memory.adminSessions['legado-novo'] = { email: 'adm@x.local', lastSeen: now - HOUR };
    memory.adminSessions['estragada'] = 7;

    assert.equal(pruneExpiredSessions(memory, { now, absoluteTtlMs: ttl }), 7);
    assert.deepEqual(Object.keys(memory.sessions).sort(), ['novo@x.local', 'numero-recente@x.local', 'presenca@x.local']);
    assert.equal(findStudentSession(memory, fresh).email, 'novo@x.local');
    assert.ok(findAdminSession(memory, adminFresh));
    assert.equal(findAdminSession(memory, adminOld), null);
    assert.deepEqual(Object.keys(memory.adminSessions).sort(), [adminSessionKey(adminFresh), 'legado-novo'].sort());
    // Prazo inválido não apaga nada.
    assert.equal(pruneExpiredSessions(memory, { now, absoluteTtlMs: 0 }), 0);
    assert.equal(pruneExpiredSessions(memory, { now: now + 100 * HOUR, absoluteTtlMs: NaN }), 0);
    assert.equal(pruneExpiredSessions(null), 0);
});

// Contrato do H3a-2: as sessões da memória (db.memory.sessions e adminSessions) só são
// lidas e gravadas pelo utils/authSessions.js, para nada escapar da tabela auth_sessions
// (a semente do TEST_MODE gravava um número em sessions[email]; a limpeza periódica e o
// painel liam o objeto direto). Linhas de comentário ficam de fora.
test('[UC-AUTH-001] fora de utils/authSessions.js ninguém mexe em sessions nem em adminSessions da memória', () => {
    const backendDir = path.join(__dirname, '..', '..', 'backend');
    const files = [];
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
        if (entry.name === 'node_modules') return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(c|m)?js$/.test(entry.name)) files.push(full);
    });
    walk(backendDir);
    const patterns = [
        [/\.sessions\b/, '.sessions'],
        [/\bsessions\s*\[/, 'sessions['],
        [/\badminSessions\b/, 'adminSessions'],
        [/['"`](sessions|adminSessions)['"`]/, "'sessions'"],
    ];
    const offenders = [];
    files.filter(file => path.basename(file) !== 'authSessions.js').forEach(file => {
        const rel = path.relative(backendDir, file);
        fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
            const trimmed = line.trim();
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
            patterns.forEach(([pattern, label]) => {
                if (pattern.test(line)) offenders.push(`${rel}:${index + 1}: ${label}`);
            });
        });
    });
    assert.deepEqual(offenders, []);
});

// Ajuste 1 do H3a-2. Com as sessões gravadas, a sessão de instrutor que sai da memória
// (limpeza do prazo absoluto, que agora também tira as de instrutor, ou retomada que não a
// trouxe) respondia { error: 'Acesso não autorizado.' }, sem sessionRevoked nem reason;
// antes, vencida e ainda na memória, respondia 'Sessão expirada.' com reason 'expired'.
test('[UC-AUTH-001] token de instrutor que saiu da memória responde 401 com sessionRevoked e reason (antes: "Acesso não autorizado.")', async () => {
    // Sessões criadas direto pelo módulo (o login por HTTP tem limite de 30 por minuto).
    const adminToken = createAdminSession(db.memory, ADMIN.email);
    await whoami(adminToken).expect(200);
    db.memory.adminSessions[adminSessionKey(adminToken)].createdAt = Date.now() - 9 * HOUR;
    assert.equal(pruneExpiredSessions(db.memory, { now: Date.now() }), 1);
    const expired = { error: 'Sessão expirada. Faça login novamente.', sessionRevoked: true, reason: 'expired' };
    for (const token of [adminToken, 'token-que-nunca-existiu']) {
        const res = await whoami(token);
        assert.equal(res.status, 401);
        assert.deepEqual(res.body, expired);
    }
    // Sem token nenhum continua como antes: quem nunca entrou.
    const anonymous = await request(app).get('/api/admin/whoami');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.sessionRevoked, undefined);
});

// Contrato H3 x H4 x H5: os ganchos pós-restauração ficam em db.afterRestore, e é por ele
// que a restauração zera as sessões (antes: uma função reset na entrada do registro e um
// ramo próprio no laço da restauração).
test('[UC-AUTH-001] restaurar backup zera as sessões pelo gancho de db.afterRestore', async () => {
    const backup = require('../../backend/utils/backup.js');
    const entry = db.COLLECTION_TABLES.find(item => item.collection === 'authSessions');
    assert.equal(entry.kind, 'derived');
    assert.equal(entry.restore, 'reset');
    assert.equal(entry.backup, false);
    assert.equal(entry.reset, undefined, 'o zeramento não fica na entrada do registro');
    assert.ok(Array.isArray(db.afterRestore));
    assert.deepEqual(db.afterRestore.map(hook => hook.name).slice(0, 1), ['authSessions']);

    const studentToken = await studentLogin();
    const adminToken = createAdminSession(db.memory, ADMIN.email);
    const snapshot = structuredClone(backup.buildDataSnapshot());
    snapshot.data.students = snapshot.data.students.filter(student => student.email === ANA.email);
    const seen = [];
    const probe = {
        name: 'teste',
        async run(memory) {
            await new Promise(resolve => setImmediate(resolve));
            seen.push({
                same: memory === db.memory,
                students: memory.students.map(student => student.email),
                sessions: persistedSessionRows(memory).length,
            });
        },
    };
    db.afterRestore.push(probe);
    try {
        await backup.restoreDataSnapshot(snapshot);
    } finally {
        db.afterRestore.splice(db.afterRestore.indexOf(probe), 1);
    }
    // O gancho rodou uma vez, com a memória já restaurada e depois do gancho das sessões.
    assert.deepEqual(seen, [{ same: true, students: [ANA.email], sessions: 0 }]);
    assert.deepEqual(await storedSessionRows(), {});
    await ping(studentToken).expect(401);
    await whoami(adminToken).expect(401);
});

// Redefinição de senha pelo launcher (scripts/reset-admin-password.js): as sessões da conta
// acabam, as das outras contas ficam. O caminho com o servidor parado (linhas lidas no boot
// do script) está em server-restart.test.js.
test('[UC-AUTH-001] redefinir a senha pelo launcher encerra só as sessões daquela conta', async () => {
    const { resetAdminPassword } = require('../../backend/scripts/reset-admin-password.js');
    const profToken = createAdminSession(db.memory, PROF.email);
    const profOther = createAdminSession(db.memory, PROF.email);
    const adminToken = createAdminSession(db.memory, ADMIN.email);
    const studentToken = await studentLogin();
    await whoami(profToken).expect(200);
    const result = await resetAdminPassword(PROF.email.toUpperCase());
    assert.equal(result.email, PROF.email);
    assert.equal(result.sessionsRevoked, 2);
    for (const token of [profToken, profOther]) {
        const res = await whoami(token);
        assert.equal(res.status, 401);
        assert.equal(res.body.sessionRevoked, true);
    }
    await whoami(adminToken).expect(200);
    await ping(studentToken).expect(200);
    assert.deepEqual(Object.keys(await storedSessionRows()).sort(), [sha256(adminToken), sha256(studentToken)].sort());
    assert.throws(() => db.revokeAccountSessions({ kind: 'qualquer', email: ADMIN.email }), TypeError);
    assert.equal(db.revokeAccountSessions({ kind: 'student', email: ANA.email }), 1);
    await ping(studentToken).expect(401);
});

test('[UC-AUTH-001] sessionRowBelongsTo reconhece a conta da linha gravada', () => {
    const row = { key: sha256('x'), value: JSON.stringify({ kind: 'admin', email: 'prof@x.local', createdAt: 1_700_000_000_000 }) };
    assert.equal(authSessions.sessionRowBelongsTo(row, { kind: 'admin', email: 'PROF@x.local ' }), true);
    assert.equal(authSessions.sessionRowBelongsTo(row, { kind: 'student', email: 'prof@x.local' }), false);
    assert.equal(authSessions.sessionRowBelongsTo(row, { kind: 'admin', email: 'outro@x.local' }), false);
    assert.equal(authSessions.sessionRowBelongsTo({ key: sha256('x'), value: '{estragada' }, { kind: 'admin', email: 'prof@x.local' }), false);
    assert.equal(authSessions.sessionRowBelongsTo({ key: 'curta', value: row.value }, { kind: 'admin', email: 'prof@x.local' }), false);
    assert.equal(authSessions.sessionRowBelongsTo(null, { kind: 'admin', email: 'prof@x.local' }), false);
});

// ---------------------------------------------------------------------------
// Ajuste 2 do H3a-2: reason em todo 401 de sessão e nada de sessão de conta que não pode
// mais entrar voltando pelo arquivo.
// ---------------------------------------------------------------------------

// Contrato das respostas de estado: 401 { sessionRevoked: true, reason }. Antes, os 401 do
// aluno (token que não voltou depois de um reinício, vencido, outro aparelho, conta
// apagada), o 403 de conta bloqueada, o 'Conta não encontrada.' do instrutor e o 401 de
// validateAnySession saíam sem reason, e o cliente não distinguia vencida de encerrada.
test('[UC-AUTH-001] 401 e 403 de sessão do aluno, do instrutor e de validateAnySession trazem reason', async () => {
    const expectRevoked = (res, status, reason) => {
        assert.equal(res.status, status, JSON.stringify(res.body));
        assert.equal(res.body.sessionRevoked, true);
        assert.equal(res.body.reason, reason, JSON.stringify(res.body));
        assert.equal(typeof res.body.error, 'string');
    };
    // Token desconhecido (não voltou no boot) e e-mail sem sessão: vencida.
    expectRevoked(await ping('token-que-nao-voltou'), 401, 'expired');
    // Outro aparelho entrou com a conta: 'replaced'.
    const first = await studentLogin();
    const second = await studentLogin();
    expectRevoked(await ping(first), 401, 'replaced');
    // Prazo absoluto.
    db.memory.sessions[ANA.email].createdAt = Date.now() - 9 * HOUR;
    expectRevoked(await ping(second), 401, 'expired');
    // Conta apagada e conta bloqueada (403).
    const bia = await studentLogin(BIA);
    db.memory.students = db.memory.students.filter(student => student.email !== BIA.email);
    expectRevoked(await ping(bia, BIA.email), 401, 'account_missing');
    const ana = await studentLogin();
    db.memory.students.find(student => student.email === ANA.email).status = 'Bloqueado';
    expectRevoked(await ping(ana), 403, 'account_inactive');

    // Instrutor de conta apagada.
    const profToken = createAdminSession(db.memory, PROF.email);
    db.memory.admins = db.memory.admins.filter(account => account.email !== PROF.email);
    expectRevoked(await whoami(profToken), 401, 'account_missing');

    // validateAnySession (/api/status): token que o servidor não conhece = vencida; sem
    // token nenhum = 'missing'.
    expectRevoked(await request(app).get('/api/status').set('x-session-token', 'desconhecido'), 401, 'expired');
    expectRevoked(await request(app).get('/api/status').set('x-admin-session', 'desconhecido'), 401, 'expired');
    expectRevoked(await request(app).get('/api/status'), 401, 'missing');
});

// O 401/403 que derruba a sessão (vencida, conta apagada ou bloqueada) tira a linha de
// auth_sessions antes da resposta. Antes a revogação ficava só na memória: a linha voltava
// no boot seguinte e, com o aluno desbloqueado, o token antigo entrava de novo.
test('[UC-AUTH-001] sessão derrubada por 401/403 sai da tabela auth_sessions antes da resposta', async () => {
    const ana = await studentLogin();
    const bia = await studentLogin(BIA);
    const profToken = createAdminSession(db.memory, PROF.email);
    await db.save();
    assert.deepEqual(Object.keys(await storedSessionRows()).sort(), [sha256(ana), sha256(bia), sha256(profToken)].sort());

    // Aluna bloqueada: 403, e a linha sai (sem db.save() do teste).
    const student = db.memory.students.find(item => item.email === ANA.email);
    student.status = 'Bloqueado';
    await ping(ana).expect(403);
    assert.equal(Object.hasOwn(await storedSessionRows(), sha256(ana)), false);
    // Desbloqueada, o token antigo não volta: entra de novo.
    student.status = 'Ativo';
    const again = await ping(ana);
    assert.equal(again.status, 401);
    assert.equal(again.body.reason, 'expired');

    // Prazo absoluto vencido.
    db.memory.sessions[BIA.email].createdAt = Date.now() - 9 * HOUR;
    await ping(bia, BIA.email).expect(401);
    assert.equal(Object.hasOwn(await storedSessionRows(), sha256(bia)), false);

    // Instrutor de conta apagada.
    db.memory.admins = db.memory.admins.filter(account => account.email !== PROF.email);
    await whoami(profToken).expect(401);
    assert.deepEqual(await storedSessionRows(), {});
});

// Excluir uma conta de instrutor encerra as sessões dela. Antes elas ficavam na memória e
// na tabela, voltavam no boot e, recriada a conta com o mesmo e-mail, o token antigo
// entrava de novo.
test('[UC-AUTH-001] excluir conta de instrutor encerra as sessões; conta recriada com o mesmo e-mail não herda token', async () => {
    const adminToken = createAdminSession(db.memory, ADMIN.email);
    const profToken = createAdminSession(db.memory, PROF.email);
    const profOther = createAdminSession(db.memory, PROF.email);
    await db.save();
    const removed = await request(app).post('/api/admin/accounts/delete').set('x-admin-session', adminToken).send({ email: PROF.email.toUpperCase() });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(Object.keys(await storedSessionRows()), [sha256(adminToken)], 'as sessões do professor saíram do arquivo');
    for (const token of [profToken, profOther]) assert.equal(findAdminSession(db.memory, token), null);

    const created = await request(app).post('/api/admin/accounts/create').set('x-admin-session', adminToken)
        .send({ name: 'Professor novo', email: PROF.email, password: 'outra-senha-forte-1', role: 'professor', assignedClasses: [] });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    for (const token of [profToken, profOther]) {
        const res = await whoami(token);
        assert.equal(res.status, 401, 'o token da conta excluída não entra na conta nova');
        assert.equal(res.body.reason, 'expired');
    }
    await whoami(adminToken).expect(200);
});

// Conta nova não herda sessão que tenha ficado do e-mail (por exemplo, gravada por uma
// versão anterior e retomada no boot).
test('[UC-AUTH-001] criar conta de instrutor tira sessão que tenha ficado do mesmo e-mail', async () => {
    const adminToken = createAdminSession(db.memory, ADMIN.email);
    const orphan = createAdminSession(db.memory, 'reaproveitado@sessoes.local');
    const created = await request(app).post('/api/admin/accounts/create').set('x-admin-session', adminToken)
        .send({ name: 'Reaproveitado', email: 'Reaproveitado@sessoes.local', password: 'senha-forte-123', role: 'admin' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(findAdminSession(db.memory, orphan), null);
    await whoami(orphan).expect(401);
    assert.equal(Object.hasOwn(await storedSessionRows(), sha256(orphan)), false);
});

// Excluir definitivamente um curso leva os alunos que só estavam nele (para o arquivo).
// Antes a sessão deles ficava: gravada, voltava no boot e, restaurado o curso arquivado com
// os alunos, o token antigo entrava de novo.
test('[UC-AUTH-001] excluir curso definitivamente encerra a sessão dos alunos que saem com ele', async () => {
    const CARLA = { email: 'carla@sessoes.local', password: 'senha-carla' };
    db.memory.courses = [{ id: 'curso-arq', name: 'Curso arquivado', schoolId: null }];
    db.memory.classes = [{ name: 'T-ARQ', courseId: 'curso-arq' }];
    db.memory.students.push({ name: 'Carla', email: CARLA.email, status: 'Ativo', password: db.hashPassword(CARLA.password), classes: ['T-ARQ'], studentClass: 'T-ARQ' });
    const carla = await studentLogin(CARLA);
    const ana = await studentLogin();
    const adminToken = createAdminSession(db.memory, ADMIN.email);
    await db.save();

    const purge = await request(app).post('/api/admin/courses/curso-arq/purge').set('x-admin-session', adminToken).send({});
    assert.equal(purge.status, 200, JSON.stringify(purge.body));
    assert.equal(purge.body.counts.alunos, 1);
    const stored = await storedSessionRows();
    assert.equal(Object.hasOwn(stored, sha256(carla)), false, 'a sessão da aluna saiu do arquivo');
    assert.equal(Object.hasOwn(stored, sha256(ana)), true, 'os outros alunos continuam');

    const restored = await request(app).post('/api/admin/archived-courses/restore').set('x-admin-session', adminToken).send({ folder: purge.body.folder });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.ok(db.memory.students.some(student => student.email === CARLA.email), 'a aluna voltou com o curso');
    const res = await ping(carla, CARLA.email);
    assert.equal(res.status, 401, 'o token antigo não volta com o curso');
    assert.equal(res.body.reason, 'expired');
    await ping(ana).expect(200);
});
