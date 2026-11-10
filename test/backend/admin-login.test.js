// Login do instrutor pelo POST /api/session/admin-login e fim do 'Authorization:
// email:senha' (H6b, SEG-03). Antes, o painel mandava e-mail e senha em cada pedido no
// cabeçalho Authorization (e o whoami trocava isso por um token), e o validateAdmin ainda
// aceitava `password` no corpo. Agora a senha vai uma vez, no corpo do POST de login, e
// todo o resto anda só com o token da sessão (x-admin-session).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-admin-login-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { SERVER_INSTANCE_ID } = require('../../backend/middlewares.js');

const REPO = path.join(__dirname, '..', '..');
const ADMIN = { email: 'adm@login.local', password: 'senha-adm' };
const PROF = { email: 'prof@login.local', password: 'senha-prof' };
let app;

function seed() {
    db.memory.config = { ...(db.memory.config || {}), settings: {} };
    db.memory.admins = [
        { email: ADMIN.email, name: 'Admin', role: 'admin', password: db.hashPassword(ADMIN.password) },
        { email: PROF.email, name: 'Professor', role: 'professor', password: db.hashPassword(PROF.password), assignedClasses: ['1DES'], assignedCourseIds: ['DES'] },
    ];
    db.memory.students = [];
    db.memory.sessions = {};
    db.memory.adminSessions = {};
    db.memory.classes = [{ name: '1DES', courseId: 'DES' }];
    db.memory.courses = [{ id: 'DES', name: 'Desenvolvimento' }];
    db.memory.loginLogs = [];
    db.memory.auditLogs = [];
}

// O teto de 30 tentativas por minuto é por IP, e todos os pedidos vêm do loopback: o
// teste do teto vem depois dos outros logins deste arquivo.
const login = body => request(app).post('/api/session/admin-login').send(body);

test.before(async () => { await db.init(); app = createApp(); });
test.beforeEach(() => { seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1000));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-AUTH-001] POST /api/session/admin-login devolve o token da sessão e os dados da conta, sem a senha', async () => {
    const res = await login({ email: ' PROF@login.local ', password: PROF.password }).expect(200);
    assert.ok(res.body.sessionToken && res.body.sessionToken.length >= 40);
    assert.equal(res.body.email, PROF.email);
    assert.equal(res.body.role, 'professor');
    assert.ok(Array.isArray(res.body.assignedClasses));
    assert.equal(res.body.instanceId, SERVER_INSTANCE_ID);
    assert.equal(res.body.mustChangePassword, false);
    assert.equal(Object.hasOwn(res.body, 'password'), false);
    assert.equal(JSON.stringify(res.body).includes(PROF.password), false);
    // A sessão vale para o whoami, que devolve o mesmo token (não abre outra sessão).
    const who = await request(app).get('/api/admin/whoami').set('x-admin-session', res.body.sessionToken).expect(200);
    assert.equal(who.body.sessionToken, res.body.sessionToken);
    assert.equal(Object.keys(db.memory.adminSessions).length, 1);
    assert.equal(db.memory.adminSessions[Object.keys(db.memory.adminSessions)[0]].email, PROF.email);
});

test('[UC-AUTH-001] admin-login recusa credencial errada (401), ausente ou de outro tipo (400), sem abrir sessão', async () => {
    const wrong = await login({ email: ADMIN.email, password: 'errada' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error, 'E-mail ou senha incorretos.');
    assert.equal((await login({ email: 'ninguem@login.local', password: 'x' })).status, 401);
    for (const body of [{}, { email: ADMIN.email }, { password: ADMIN.password }, { email: '', password: '' },
        { email: [ADMIN.email], password: ADMIN.password }, { email: ADMIN.email, password: { $ne: '' } }, { email: ADMIN.email, password: 123 }]) {
        const res = await login(body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.equal(res.body.error, 'Informe e-mail e senha.');
    }
    assert.deepEqual(db.memory.adminSessions, {});
});

test('[UC-AUTH-001] o cabeçalho Authorization e o password no corpo não autenticam mais o instrutor', async () => {
    const basic = `${ADMIN.email}:${ADMIN.password}`;
    for (const pending of [
        request(app).get('/api/admin/whoami').set('Authorization', basic),
        request(app).get('/api/admin/classes').set('Authorization', basic),
        request(app).get('/api/admin/whoami').set('Authorization', 'Basic ' + Buffer.from(basic).toString('base64')),
        request(app).post('/api/admin/classes').send({ email: ADMIN.email, password: ADMIN.password }),
        request(app).get('/api/admin/whoami').query({ email: ADMIN.email, password: ADMIN.password }),
    ]) {
        const res = await pending;
        assert.equal(res.status, 401, `${res.req.method} ${res.req.path}: ${res.status}`);
        assert.equal(res.body.sessionToken, undefined);
    }
    assert.deepEqual(db.memory.adminSessions, {}, 'nenhuma sessão nasce do cabeçalho antigo');
});

test('[UC-AUTH-001] teto de 30 tentativas por minuto no login do instrutor, com o tempo de espera', async () => {
    let last;
    for (let i = 0; i < 31; i += 1) last = await login({ email: ADMIN.email, password: 'errada-' + i });
    assert.equal(last.status, 429);
    assert.equal(last.body.error, 'Muitas tentativas de acesso. Aguarde um instante e tente novamente.');
    assert.ok(Number.isInteger(last.body.retryAfterSeconds) && last.body.retryAfterSeconds >= 1 && last.body.retryAfterSeconds <= 60);
    // Nem a senha certa passa enquanto o teto vale.
    assert.equal((await login(ADMIN)).status, 429);
    // O teto do aluno é outro (o login do aluno não sofre com o do instrutor).
    const student = await request(app).post('/api/student/login').send({ email: 'x@login.local', password: 'y' });
    assert.equal(student.status, 401);
});

// Ninguém volta a mandar e-mail e senha no cabeçalho: nem o servidor lê, nem o app envia.
test('[UC-AUTH-001] código sem Authorization: nem o servidor lê, nem o app do navegador envia', () => {
    const roots = [path.join(REPO, 'backend'), path.join(REPO, 'web', 'src')];
    const offenders = [];
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === 'dist') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!/\.(c|m)?jsx?$/.test(entry.name) || /\.test\.jsx?$/.test(entry.name)) continue;
            const code = fs.readFileSync(full, 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
            if (/authorization/i.test(code)) offenders.push(path.relative(REPO, full));
        }
    };
    roots.forEach(walk);
    assert.deepEqual(offenders, []);
    // O validateAdmin não lê senha do corpo; só o login com senha lê req.body.password.
    const middlewares = fs.readFileSync(path.join(REPO, 'backend', 'middlewares.js'), 'utf8');
    assert.equal(/body\??\.password|body\[['"]password['"]\]/.test(middlewares), false);
});
