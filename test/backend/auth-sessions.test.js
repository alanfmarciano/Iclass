// Sessões guardadas só como hash (H3a-1, utils/authSessions.js). Antes, o servidor
// guardava o token cru: sessions[email].token e adminSessions[tokenCru]. Agora o token
// cru fica só no navegador; a memória (e, no H3a-2, a tabela auth_sessions) guarda o
// sha256. Os testes de formato e de retomada falham no código antigo; os do caminho
// legado (fixtures com { token } e adminSessions[tokenCru]) ficam de guarda para nenhum
// aluno ou professor cair por causa da troca de formato.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

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
    const memory = { sessions: { antigo: { tokenHash: sha256('antigo'), createdAt: now } }, adminSessions: {} };

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
