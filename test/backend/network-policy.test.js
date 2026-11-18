// Painel do professor conforme o aparelho (H6b, SEG-03, decisões §2 P1). Antes, qualquer
// aparelho da rede da sala abria o painel por http, e a senha ia em cada pedido no
// cabeçalho 'Authorization: email:senha'. Agora settings.network.adminAccess decide:
// 'rede-sem-https' (padrão e banco antigo: como antes, com aviso fixo), 'local' (só o
// computador do IClass) ou 'rede' (outros aparelhos só por https, que ainda não existe).
// Os testes de outro aparelho usam createApp({ isThisComputer: () => false }) ou
// createApp({ network: { isThisComputer, isSecure, httpsUrl } }): o supertest sempre
// conecta pelo loopback e sem cifra.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-network-policy-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const runtimePaths = require('../../backend/runtimePaths.js');
const { createApp } = require('../../backend/server.js');
const settingsUtil = require('../../backend/utils/settings.js');
const {
    LOCAL_ONLY_MESSAGE,
    HTTPS_REQUIRED_MESSAGE,
    HTTPS_UNAVAILABLE_MESSAGE,
    adminAccessDecision,
    isInstructorRequest,
    isThisComputerRequest,
} = require('../../backend/utils/networkPolicy.js');
const { createAdminSession, createStudentSession } = require('../../backend/utils/authSessions.js');

const DECISION_TEXT = 'O painel do professor só abre no computador onde o IClass está ligado. O administrador pode liberar outros aparelhos em Sistema → Rede.';
const ADMIN = { email: 'adm@rede.local', password: 'senha-adm' };
const PROF = { email: 'prof@rede.local', password: 'senha-prof' };
const ANA = { email: 'ana@rede.local', password: 'senha-ana' };
let localApp;
let remoteApp;

function seed(network) {
    db.memory.config = { ...(db.memory.config || {}), settings: network === undefined ? {} : { network } };
    db.memory.admins = [
        { email: ADMIN.email, name: 'Admin', role: 'admin', password: db.hashPassword(ADMIN.password) },
        { email: PROF.email, name: 'Prof', role: 'professor', password: db.hashPassword(PROF.password), assignedClasses: [], additionalPermissions: ['system.manage'] },
    ];
    db.memory.students = [
        { name: 'Ana', email: ANA.email, status: 'Ativo', password: db.hashPassword(ANA.password), classes: [] },
    ];
    db.memory.sessions = {};
    db.memory.adminSessions = {};
    db.memory.classes = [];
    db.memory.courses = [];
    db.memory.loginLogs = [];
    db.memory.auditLogs = [];
}

function fakeReq({ method = 'GET', path: pathName = '/', headers = {}, query = {}, ip = '127.0.0.1', encrypted = false } = {}) {
    return { method, path: pathName, headers, query, socket: { remoteAddress: ip, encrypted } };
}

test.before(async () => {
    await db.init();
    localApp = createApp({ isThisComputer: () => true });
    remoteApp = createApp({ isThisComputer: () => false });
    fs.mkdirSync(runtimePaths.UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(runtimePaths.UPLOADS_DIR, 'material-rede.pdf'), '%PDF-1.4 teste');
});
test.beforeEach(() => { seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1000));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-REDE-001] decisão por modo: este computador sempre entra; outro aparelho conforme a regra', () => {
    for (const mode of ['rede-sem-https', 'local', 'rede']) {
        assert.deepEqual(adminAccessDecision({ mode, thisComputer: true, secure: false }), { allowed: true, insecure: false }, mode);
    }
    assert.deepEqual(adminAccessDecision({ mode: 'rede-sem-https', thisComputer: false, secure: false }), { allowed: true, insecure: true });
    assert.deepEqual(adminAccessDecision({ mode: 'rede-sem-https', thisComputer: false, secure: true }), { allowed: true, insecure: false });
    assert.deepEqual(adminAccessDecision({ mode: 'local', thisComputer: false, secure: true }), { allowed: false, body: { error: DECISION_TEXT, adminAccess: 'local-only', httpsUrl: null } });
    // As duas recusas levam o httpsUrl do formato combinado (contrato 9), quando houver.
    assert.equal(adminAccessDecision({ mode: 'local', thisComputer: false, secure: false, httpsUrl: 'https://192.0.2.10:3000' }).body.httpsUrl, 'https://192.0.2.10:3000');
    // 'rede' sem endereço seguro (sem certificado) e com ele (H6c): o texto aponta para /certificado.
    assert.deepEqual(adminAccessDecision({ mode: 'rede', thisComputer: false, secure: false }), { allowed: false, body: { error: HTTPS_UNAVAILABLE_MESSAGE, adminAccess: 'https-required', httpsUrl: null } });
    assert.deepEqual(adminAccessDecision({ mode: 'rede', thisComputer: false, secure: false, httpsUrl: 'https://192.168.0.10:3000' }), { allowed: false, body: { error: HTTPS_REQUIRED_MESSAGE, adminAccess: 'https-required', httpsUrl: 'https://192.168.0.10:3000' } });
    assert.match(HTTPS_REQUIRED_MESSAGE, /\/certificado/);
    assert.deepEqual(adminAccessDecision({ mode: 'rede', thisComputer: false, secure: true }), { allowed: true, insecure: false });
    assert.equal(LOCAL_ONLY_MESSAGE, DECISION_TEXT, 'texto exato da decisão §2 P1');
});

test('[UC-REDE-001] "este computador": loopback e os endereços desta máquina; o resto é outro aparelho', () => {
    for (const ip of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1']) {
        assert.equal(isThisComputerRequest(fakeReq({ ip })), true, ip);
    }
    const own = Object.values(os.networkInterfaces()).flat().find(item => item && item.family === 'IPv4' && !item.internal);
    if (own) assert.equal(isThisComputerRequest(fakeReq({ ip: own.address })), true, `endereço da própria máquina ${own.address}`);
    for (const ip of ['203.0.113.77', '::ffff:198.51.100.4', '', null]) {
        assert.equal(isThisComputerRequest(fakeReq({ ip })), false, String(ip));
    }
    // O cabeçalho X-Forwarded-For nunca conta: só o endereço da conexão.
    assert.equal(isThisComputerRequest(fakeReq({ ip: '203.0.113.77', headers: { 'x-forwarded-for': '127.0.0.1' } })), false);
    // TEST_MODE=1 + ICLASS_TEST_REMOTE_IPS: um endereço desta máquina passa a contar como outro aparelho.
    const previous = process.env.ICLASS_TEST_REMOTE_IPS;
    process.env.ICLASS_TEST_REMOTE_IPS = '127.0.0.9, ::1';
    try {
        assert.equal(isThisComputerRequest(fakeReq({ ip: '127.0.0.9' })), false);
        assert.equal(isThisComputerRequest(fakeReq({ ip: '::1' })), false);
        assert.equal(isThisComputerRequest(fakeReq({ ip: '127.0.0.1' })), true);
    } finally {
        if (previous === undefined) delete process.env.ICLASS_TEST_REMOTE_IPS; else process.env.ICLASS_TEST_REMOTE_IPS = previous;
    }
});

test('[UC-REDE-001] pedido de professor: /api/admin, admin-login e qualquer token de sessão de professor', () => {
    const adminToken = createAdminSession(db.memory, ADMIN.email);
    const studentToken = createStudentSession(db.memory, ANA.email);
    const yes = [
        fakeReq({ path: '/api/admin/whoami' }),
        fakeReq({ path: '/API/Admin/classes' }),
        fakeReq({ path: '/api/admin' }),
        fakeReq({ method: 'POST', path: '/api/session/admin-login' }),
        fakeReq({ path: '/api/courses', headers: { 'x-admin-session': 'qualquer' } }),
        fakeReq({ path: '/uploads/material-rede.pdf', query: { access: adminToken } }),
        fakeReq({ path: '/uploads/material-rede.pdf', query: { access: ['velho', adminToken] } }),
        fakeReq({ path: '/uploads/material-rede.pdf', headers: { 'x-session-token': adminToken } }),
    ];
    yes.forEach((req, i) => assert.equal(isInstructorRequest(req), true, `caso ${i}: ${req.method} ${req.path}`));
    const no = [
        fakeReq({ path: '/api/student/sync', headers: { 'x-session-token': studentToken } }),
        fakeReq({ method: 'POST', path: '/api/student/login' }),
        fakeReq({ path: '/uploads/material-rede.pdf', query: { access: studentToken } }),
        fakeReq({ path: '/uploads/material-rede.pdf', query: { access: '__proto__' } }),
        fakeReq({ path: '/api/connection' }),
        fakeReq({ path: '/login' }),
        fakeReq({ path: '/api/administrativo' }),
        // Sair passa sempre: o aparelho recusado consegue apagar a própria sessão.
        fakeReq({ method: 'POST', path: '/api/session/logout', headers: { 'x-admin-session': adminToken } }),
    ];
    no.forEach((req, i) => assert.equal(isInstructorRequest(req), false, `caso ${i}: ${req.method} ${req.path}`));
});

test('[UC-REDE-001] banco antigo (sem settings.network): outro aparelho abre o painel como antes, com o aviso de conexão sem proteção', async () => {
    assert.equal(settingsUtil.networkSettings().adminAccess, 'rede-sem-https');
    assert.equal(settingsUtil.getSettings().network.adminAccess, 'rede-sem-https');
    const login = await request(remoteApp).post('/api/session/admin-login').send(ADMIN).expect(200);
    const token = login.body.sessionToken;
    await request(remoteApp).get('/api/admin/whoami').set('x-admin-session', token).expect(200);
    await request(remoteApp).get('/api/admin/classes').set('x-admin-session', token).expect(200);
    const remote = await request(remoteApp).get('/api/connection').expect(200);
    assert.equal(remote.headers['cache-control'], 'no-store');
    assert.deepEqual(remote.body, {
        secure: false, thisComputer: false, adminAccess: 'ok', adminAccessMode: 'rede-sem-https',
        insecureAdmin: true, tlsAvailable: false, studentsHttps: false, httpsUrl: null,
    });
    const local = await request(localApp).get('/api/connection').expect(200);
    assert.equal(local.body.thisComputer, true);
    assert.equal(local.body.insecureAdmin, false, 'no computador do IClass não há aviso');
    // Valor desconhecido (banco mexido à mão) cai no padrão.
    seed({ adminAccess: 'qualquer-coisa' });
    assert.equal(settingsUtil.networkSettings().adminAccess, 'rede-sem-https');
});

test('[UC-REDE-001] "Só o computador do IClass": outro aparelho recebe 403 local-only em todo pedido de professor; o aluno segue igual', async () => {
    seed({ adminAccess: 'local' });
    // Sessão aberta antes da troca da regra (o professor já estava no painel).
    const token = createAdminSession(db.memory, ADMIN.email);

    const login = await request(remoteApp).post('/api/session/admin-login').send(ADMIN);
    assert.equal(login.status, 403);
    assert.deepEqual(login.body, { error: DECISION_TEXT, adminAccess: 'local-only', httpsUrl: null });
    const blocked = [
        request(remoteApp).get('/api/admin/whoami').set('x-admin-session', token),
        request(remoteApp).get('/api/admin/classes').set('x-admin-session', token),
        request(remoteApp).get('/api/courses').set('x-admin-session', token),
        request(remoteApp).get('/uploads/material-rede.pdf').query({ access: token }),
        request(remoteApp).get('/uploads/material-rede.pdf?access=velho&access=' + encodeURIComponent(token)),
        request(remoteApp).get('/uploads/material-rede.pdf').set('x-session-token', token),
        request(remoteApp).post('/api/admin/network-settings').set('x-admin-session', token).send({ adminAccess: 'rede-sem-https' }),
    ];
    for (const [i, pending] of blocked.entries()) {
        const res = await pending;
        assert.equal(res.status, 403, `pedido ${i}: ${res.status}`);
        assert.equal(res.body.adminAccess, 'local-only', `pedido ${i}`);
        assert.equal(res.body.error, DECISION_TEXT, `pedido ${i}`);
        assert.ok(Object.prototype.hasOwnProperty.call(res.body, 'httpsUrl'), `pedido ${i}: httpsUrl no formato combinado`);
        assert.equal(res.body.httpsUrl, null, `pedido ${i}`);
    }
    // Ninguém em outro aparelho troca a regra de volta.
    assert.equal(db.memory.config.settings.network.adminAccess, 'local');
    const connection = await request(remoteApp).get('/api/connection').expect(200);
    assert.equal(connection.body.adminAccess, 'local-only');
    assert.equal(connection.body.adminAccessMode, 'local');
    assert.equal(connection.body.insecureAdmin, false);

    // Aluno: login, sincronização e arquivo continuam em qualquer aparelho.
    const student = await request(remoteApp).post('/api/student/login').send(ANA).expect(200);
    await request(remoteApp).get('/api/ping').query({ email: ANA.email }).set('x-session-token', student.body.sessionToken).expect(200);

    // Sair passa: o aparelho recusado apaga a sessão que ainda guardava.
    await request(remoteApp).post('/api/session/logout').set('x-admin-session', token).expect(200);
    await request(localApp).get('/api/admin/whoami').set('x-admin-session', token).expect(401);

    // No computador do IClass, tudo normal.
    const localLogin = await request(localApp).post('/api/session/admin-login').send(ADMIN).expect(200);
    await request(localApp).get('/api/admin/whoami').set('x-admin-session', localLogin.body.sessionToken).expect(200);
    await request(localApp).get('/uploads/material-rede.pdf').query({ access: localLogin.body.sessionToken }).expect(200);
});

test('[UC-REDE-001] "rede" guardado (backup de versão nova) sem https: outro aparelho recebe https-required; este computador entra', async () => {
    seed({ adminAccess: 'rede' });
    const login = await request(remoteApp).post('/api/session/admin-login').send(ADMIN);
    assert.equal(login.status, 403);
    assert.deepEqual(login.body, { error: HTTPS_UNAVAILABLE_MESSAGE, adminAccess: 'https-required', httpsUrl: null });
    const connection = await request(remoteApp).get('/api/connection').expect(200);
    assert.equal(connection.body.adminAccess, 'https-required');
    assert.equal(connection.body.tlsAvailable, false);
    await request(localApp).post('/api/session/admin-login').send(ADMIN).expect(200);
});

test('[UC-REDE-001] createApp({ network }): a mesma regra vale pelo app inteiro com conexão cifrada e endereço seguro', async () => {
    const HTTPS_URL = 'https://192.0.2.10:3000';
    const secureRemote = createApp({ network: { isThisComputer: () => false, isSecure: () => true, httpsUrl: () => HTTPS_URL } });
    const plainRemote = createApp({ network: { isThisComputer: () => false, httpsUrl: () => HTTPS_URL } });

    // 'rede': por http, recusa com o endereço seguro; pela conexão cifrada, entra.
    seed({ adminAccess: 'rede' });
    const plain = await request(plainRemote).post('/api/session/admin-login').send(ADMIN);
    assert.equal(plain.status, 403);
    assert.deepEqual(plain.body, { error: HTTPS_REQUIRED_MESSAGE, adminAccess: 'https-required', httpsUrl: HTTPS_URL });
    const viaHttps = await request(secureRemote).post('/api/session/admin-login').send(ADMIN).expect(200);
    await request(secureRemote).get('/api/admin/whoami').set('x-admin-session', viaHttps.body.sessionToken).expect(200);
    const secureConnection = await request(secureRemote).get('/api/connection').expect(200);
    assert.equal(secureConnection.body.secure, true);
    assert.equal(secureConnection.body.adminAccess, 'ok');
    assert.equal(secureConnection.body.insecureAdmin, false, 'pela conexão segura não há aviso');
    assert.equal(secureConnection.body.httpsUrl, HTTPS_URL);

    // 'local': a recusa também leva o httpsUrl, igual ao contrato.
    seed({ adminAccess: 'local' });
    const local = await request(secureRemote).post('/api/session/admin-login').send(ADMIN);
    assert.equal(local.status, 403);
    assert.deepEqual(local.body, { error: DECISION_TEXT, adminAccess: 'local-only', httpsUrl: HTTPS_URL });

    // 'rede-sem-https' pela conexão cifrada: entra, sem o aviso de senha exposta.
    seed({ adminAccess: 'rede-sem-https' });
    const open = await request(secureRemote).get('/api/connection').expect(200);
    assert.equal(open.body.adminAccess, 'ok');
    assert.equal(open.body.insecureAdmin, false);
    const openPlain = await request(plainRemote).get('/api/connection').expect(200);
    assert.equal(openPlain.body.insecureAdmin, true);

    // options.isThisComputer sozinho continua valendo, e vence o network.isThisComputer.
    const both = createApp({ isThisComputer: () => true, network: { isThisComputer: () => false } });
    const mine = await request(both).get('/api/connection').expect(200);
    assert.equal(mine.body.thisComputer, true);
});
