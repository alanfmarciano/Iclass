// Atraso progressivo por conta no login, tetos por IP e por aluno, loginLogs sem gravação
// inteira a cada falha, "Liberar login" e a fila "Precisa de você" (H5b; SEG-06, DES-X2,
// decisão 6 do Alan).
//
// Antes: o login tinha só um teto de 30 tentativas por minuto por IP. A turma inteira atrás
// do mesmo roteador (NAT da Wi-Fi da sala) recebia "Muitas tentativas" no começo da aula, e
// quem tentasse adivinhar a senha de UMA conta, de vários aparelhos, nunca era contido. O
// código da prova tinha o mesmo teto por IP, contando os códigos certos. Cada senha errada
// gravava o banco inteiro (db.save) e a do instrutor nem ficava registrada.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-login-guard-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const loginGuard = require('../../backend/utils/loginGuard.js');
const rateLimiter = require('../../backend/utils/rateLimit.js');
const passwordLogin = require('../../backend/utils/passwordLogin.js');
const security = require('../../backend/utils/security.js');
const { computeQueue } = require('../../backend/utils/dashboardAggregates.js');

const ADMIN = { email: 'adm@guard.local', password: 'senha-adm-forte' };
const PROF = { email: 'prof@guard.local', password: 'senha-prof-forte' };
const OTHER_PROF = { email: 'outro@guard.local', password: 'senha-outro-forte' };
const STUDENT_PASSWORD = 'aluno-senha-1';
let app;

function student(email, extra = {}) {
    return {
        email, name: email.split('@')[0], password: db.hashPassword(STUDENT_PASSWORD),
        classes: ['1DES'], studentClass: '1DES', status: 'Ativo', ...extra,
    };
}

function seed() {
    db.memory.config = { ...(db.memory.config || {}), settings: {} };
    db.memory.admins = [
        { email: ADMIN.email, name: 'Admin', role: 'admin', password: db.hashPassword(ADMIN.password) },
        { email: PROF.email, name: 'Professor', role: 'professor', password: db.hashPassword(PROF.password), assignedClasses: ['1DES'], assignedCourseIds: ['DES'] },
        { email: OTHER_PROF.email, name: 'Outro', role: 'professor', password: db.hashPassword(OTHER_PROF.password), assignedClasses: ['2ADM'], assignedCourseIds: ['ADM'] },
    ];
    db.memory.students = [
        student('ana@guard.local'),
        student('bia@guard.local'),
        student('caio@guard.local', { classes: ['2ADM'], studentClass: '2ADM' }),
    ];
    db.memory.sessions = {};
    db.memory.adminSessions = {};
    db.memory.classes = [
        { name: '1DES', courseId: 'DES', onlineExamConfigs: { prova1: { accessToken: 'ABCDE' } } },
        { name: '2ADM', courseId: 'ADM' },
    ];
    db.memory.courses = [{ id: 'DES', name: 'Desenvolvimento' }, { id: 'ADM', name: 'Administração' }];
    db.memory.examApplications = [];
    db.memory.studentExamState = {};
    db.memory.loginLogs = [];
    db.memory.auditLogs = [];
}

const studentLogin = (email, password = STUDENT_PASSWORD) => request(app).post('/api/student/login').send({ email, password });
const adminLogin = (email, password) => request(app).post('/api/session/admin-login').send({ email, password });
async function adminToken(account = ADMIN) {
    const res = await adminLogin(account.email, account.password).expect(200);
    return res.body.sessionToken;
}

test.before(async () => { await db.init(); app = createApp(); });
test.beforeEach(() => {
    seed();
    loginGuard.resetForTests();
    rateLimiter.resetForTests();
    passwordLogin.resetForTests();
    security.cancelLoginLogSave();
});
test.after(async () => {
    security.cancelLoginLogSave();
    await new Promise(resolve => setTimeout(resolve, 500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

// --- Regra do atraso (utils/loginGuard.js) -----------------------------------------

test('[UC-AUTH-002] atraso por conta: nada até a 4.ª falha, 30 s na 5.ª, dobra a cada falha e para em 15 min', () => {
    const key = loginGuard.accountKey('student', ' Ana@Guard.Local ');
    assert.equal(key, 'student:ana@guard.local');
    const t0 = 1_000_000;
    for (let n = 1; n <= 4; n += 1) {
        const state = loginGuard.recordFailure(key, t0);
        assert.equal(state.delayed, false, `falha ${n} não atrasa`);
        assert.equal(state.failures, n);
    }
    assert.equal(loginGuard.protectionFor(key, t0), null, 'antes da 5.ª falha não há selo');
    assert.deepEqual([5, 6, 7, 8, 9, 10, 11, 12].map(loginGuard.delayAfterFailures),
        [30e3, 60e3, 120e3, 240e3, 480e3, 900e3, 900e3, 900e3]);
    const fifth = loginGuard.recordFailure(key, t0);
    assert.equal(fifth.delayed, true);
    assert.equal(fifth.retryAfterSeconds, 30);
    assert.deepEqual(loginGuard.protectionFor(key, t0), { failures: 5, retryAt: t0 + 30e3 });
    // Durante a espera: check diz quanto falta; depois dela, a conta volta a tentar.
    assert.equal(loginGuard.check(key, t0 + 10e3).retryAfterSeconds, 20);
    assert.equal(loginGuard.check(key, t0 + 30e3).delayed, false);
    // A senha certa zera a conta.
    loginGuard.recordSuccess(key);
    assert.equal(loginGuard.check(key, t0).failures, 0);
    // A conta é esquecida 24 h depois da última falha.
    loginGuard.recordFailure(key, t0);
    assert.equal(loginGuard.check(key, t0 + loginGuard.ENTRY_TTL_MS + 1).failures, 0);
    // "Liberar login": devolve se havia algo.
    loginGuard.recordFailure(key, t0);
    assert.equal(loginGuard.clear(key), true);
    assert.equal(loginGuard.clear(key), false);
});

test('[UC-AUTH-002] a memória do atraso tem teto: acima de 10.000 contas sai a que errou há mais tempo', () => {
    for (let i = 0; i < loginGuard.MAX_ENTRIES + 5; i += 1) loginGuard.recordFailure(`student:c${i}@x`, 1000 + i);
    assert.equal(loginGuard.size(), loginGuard.MAX_ENTRIES);
    assert.equal(loginGuard.check('student:c0@x', 2000).failures, 0);
    assert.equal(loginGuard.check(`student:c${loginGuard.MAX_ENTRIES + 4}@x`, 20000).failures, 1);
});

test('[UC-AUTH-002] rateLimit.peek consulta sem contar; hit conta; reset zera', () => {
    const opts = { max: 2, windowMs: 60000, now: 1000 };
    assert.equal(rateLimiter.peek('k', opts).count, 0);
    assert.equal(rateLimiter.hit('k', opts).allowed, true);
    assert.equal(rateLimiter.peek('k', opts).count, 1);
    assert.equal(rateLimiter.hit('k', opts).allowed, true);
    assert.equal(rateLimiter.peek('k', opts).allowed, false);
    assert.equal(rateLimiter.hit('k', opts).allowed, false);
    assert.equal(rateLimiter.reset('k'), true);
    assert.equal(rateLimiter.peek('k', opts).allowed, true);
});

// --- Login do aluno ------------------------------------------------------------------

test('[UC-AUTH-002] aluno: 5 senhas erradas e a 6.ª tentativa espera (429 loginDelayed), mesmo com a senha certa; os outros alunos seguem entrando', async () => {
    for (let n = 1; n <= 5; n += 1) {
        const res = await studentLogin('ana@guard.local', 'errada-' + n);
        assert.equal(res.status, 401, `tentativa ${n}`);
    }
    const blocked = await studentLogin('ana@guard.local');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.loginDelayed, true);
    assert.ok(blocked.body.retryAfterSeconds >= 1 && blocked.body.retryAfterSeconds <= 30);
    assert.match(blocked.body.error, /^Muitas tentativas com senha errada para esta conta\. Tente de novo em \d+ segundos ou peça ao professor para liberar\.$/);
    assert.equal(blocked.body.sessionToken, undefined);
    // Atraso é da conta, não do aparelho: a colega no mesmo IP entra.
    await studentLogin('bia@guard.local').expect(200);
    // A espera não conta outra falha: continua 5.
    assert.equal(loginGuard.check(loginGuard.accountKey('student', 'ana@guard.local')).failures, 5);
});

test('[UC-AUTH-002] a turma inteira atrás do mesmo IP entra: 40 logins certos seguidos, nenhum 429', async () => {
    const emails = Array.from({ length: 40 }, (_, i) => `turma${i}@guard.local`);
    db.memory.students.push(...emails.map(email => student(email)));
    const results = await Promise.all(emails.map(email => studentLogin(email)));
    assert.deepEqual(results.map(res => res.status), emails.map(() => 200));
});

test('[UC-AUTH-002] rajada em paralelo contra uma conta não fura o atraso', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => studentLogin('ana@guard.local', 'chute-' + i)));
    const statuses = results.map(res => res.status);
    assert.equal(statuses.filter(status => status === 401).length, 5, statuses.join(','));
    assert.equal(statuses.filter(status => status === 429).length, 7, statuses.join(','));
});

test('[UC-AUTH-002] e-mail que não existe também conta (a resposta não revela as contas) e a senha certa zera', async () => {
    for (let n = 1; n <= 5; n += 1) await studentLogin('ninguem@guard.local', 'x-' + n).expect(401);
    const res = await studentLogin('ninguem@guard.local', 'x-6');
    assert.equal(res.status, 429);
    for (let n = 1; n <= 4; n += 1) await studentLogin('bia@guard.local', 'errada-' + n).expect(401);
    await studentLogin('bia@guard.local').expect(200);
    assert.equal(loginGuard.check(loginGuard.accountKey('student', 'bia@guard.local')).failures, 0);
});

test('[UC-AUTH-002] senha errada não grava o banco inteiro na hora: loginLogs agrupa as falhas seguidas e grava depois, em segundo plano', async () => {
    const original = db.save;
    const calls = [];
    db.save = function patchedSave(...args) { calls.push(args[0] || null); return original.apply(this, args); };
    try {
        for (let n = 1; n <= 3; n += 1) await studentLogin('ana@guard.local', 'errada-' + n).expect(401);
    } finally {
        db.save = original;
    }
    assert.deepEqual(calls, [], 'nenhum db.save no pedido da senha errada');
    const fails = db.memory.loginLogs.filter(entry => entry.email === 'ana@guard.local' && entry.status === 'fail');
    assert.equal(fails.length, 1, 'uma linha só para as três falhas seguidas');
    assert.equal(fails[0].count, 3);
    assert.equal(fails[0].role, 'student');
    assert.equal(security.loginLogSavePending(), true, 'a gravação ficou marcada para depois');
});

test('[UC-AUTH-002] instrutor: senha errada fica em loginLogs com o papel, e a 6.ª tentativa espera', async () => {
    for (let n = 1; n <= 5; n += 1) await adminLogin(PROF.email, 'errada-' + n).expect(401);
    const fail = db.memory.loginLogs.find(entry => entry.email === PROF.email && entry.status === 'fail');
    assert.ok(fail, 'antes a falha do instrutor nem era registrada');
    assert.equal(fail.role, 'professor');
    assert.equal(fail.count, 5);
    const blocked = await adminLogin(PROF.email, PROF.password);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.loginDelayed, true);
    assert.match(blocked.body.error, /peça a um administrador para liberar\.$/);
    const throttled = db.memory.loginLogs.find(entry => entry.email === PROF.email && entry.status === 'throttled');
    assert.ok(throttled, 'a tentativa durante a espera fica registrada como em espera');
    // O sucesso também fica registrado, com o papel.
    await adminLogin(ADMIN.email, ADMIN.password).expect(200);
    assert.ok(db.memory.loginLogs.some(entry => entry.email === ADMIN.email && entry.status === 'success' && entry.role === 'admin'));
});

test('[UC-AUTH-002] teto por IP de 300 tentativas por minuto continua protegendo o servidor', async () => {
    for (let i = 0; i < passwordLogin.LOGIN_RATE_LIMIT.max; i += 1) rateLimiter.hit('student-login-all:127.0.0.1', passwordLogin.LOGIN_RATE_LIMIT);
    const res = await studentLogin('bia@guard.local');
    assert.equal(res.status, 429);
    assert.equal(res.body.loginDelayed, true);
});

// --- Código da prova -----------------------------------------------------------------

async function studentToken(email) {
    const res = await studentLogin(email).expect(200);
    return res.body.sessionToken;
}
const validateToken = (token, email, code) => request(app).post('/api/student/validate-exam-token').set('x-session-token', token)
    .send({ email, studentClass: '1DES', courseId: 'DES', examKey: 'prova1', token: code });

test('[UC-AUTH-002] código da prova: limite por aluno, só para os códigos errados', async () => {
    const ana = await studentToken('ana@guard.local');
    const bia = await studentToken('bia@guard.local');
    // 31 códigos certos do mesmo IP: antes, a 31.ª validação no minuto dava 429.
    for (let i = 0; i < 31; i += 1) {
        const res = await validateToken(i % 2 ? ana : bia, i % 2 ? 'ana@guard.local' : 'bia@guard.local', 'ABCDE');
        assert.equal(res.status, 200, `validação ${i + 1}`);
        assert.equal(res.body.valid, true);
    }
    // 10 códigos errados da Ana: valid:false; o 11.º pedido dela é recusado.
    for (let i = 0; i < 10; i += 1) {
        const res = await validateToken(ana, 'ana@guard.local', 'ZZZZZ').expect(200);
        assert.equal(res.body.valid, false);
    }
    const tooMany = await validateToken(ana, 'ana@guard.local', 'ABCDE');
    assert.equal(tooMany.status, 429);
    assert.match(tooMany.body.error, /chame o professor/);
    assert.ok(tooMany.body.retryAfterSeconds >= 1);
    // A Bia, no mesmo IP, continua validando.
    const other = await validateToken(bia, 'bia@guard.local', 'ABCDE').expect(200);
    assert.equal(other.body.valid, true);
});

test('[UC-AUTH-002] código da prova: o certo zera os erros do aluno', async () => {
    const ana = await studentToken('ana@guard.local');
    for (let i = 0; i < 9; i += 1) await validateToken(ana, 'ana@guard.local', 'ZZZZZ').expect(200);
    await validateToken(ana, 'ana@guard.local', 'ABCDE').expect(200);
    for (let i = 0; i < 9; i += 1) await validateToken(ana, 'ana@guard.local', 'ZZZZZ').expect(200);
    const res = await validateToken(ana, 'ana@guard.local', 'ABCDE').expect(200);
    assert.equal(res.body.valid, true);
});

// --- Liberar login, selos e fila -----------------------------------------------------

async function delay(kind, email) {
    const key = loginGuard.accountKey(kind, email);
    for (let n = 0; n < 5; n += 1) loginGuard.recordFailure(key);
}

test('[UC-AUTH-002] "Liberar login" do aluno: selo em Alunos, liberação com auditoria e login na hora', async () => {
    const token = await adminToken(PROF);
    await delay('student', 'ana@guard.local');
    await studentLogin('ana@guard.local').expect(429);

    const list = await request(app).get('/api/admin/students?courseId=DES&studentClass=1DES').set('x-admin-session', token).expect(200);
    const ana = list.body.find(item => item.email === 'ana@guard.local');
    assert.equal(ana.loginProtection.failures, 5);
    assert.ok(ana.loginProtection.retryAt > Date.now());
    assert.equal(ana.sessionsInvalidBefore, undefined);
    assert.equal(list.body.find(item => item.email === 'bia@guard.local').loginProtection, undefined);

    const res = await request(app).post('/api/admin/student/unlock-login').set('x-admin-session', token).send({ email: 'ANA@guard.local' }).expect(200);
    assert.equal(res.body.unlocked, true);
    assert.match(res.body.message, /Login liberado/);
    const audit = db.memory.auditLogs.find(entry => entry.action === 'student_login_unlocked');
    assert.ok(audit, 'liberação na auditoria');
    assert.equal(audit.studentEmail, 'ana@guard.local');
    await studentLogin('ana@guard.local').expect(200);

    // Sem nada para liberar: 200 com unlocked:false, sem auditoria nova.
    const again = await request(app).post('/api/admin/student/unlock-login').set('x-admin-session', token).send({ email: 'ana@guard.local' }).expect(200);
    assert.equal(again.body.unlocked, false);
    assert.equal(db.memory.auditLogs.filter(entry => entry.action === 'student_login_unlocked').length, 1);
});

test('[UC-AUTH-002] "Liberar login" do aluno respeita a turma do professor e recusa entrada errada', async () => {
    const token = await adminToken(PROF);
    await delay('student', 'caio@guard.local');
    const foreign = await request(app).post('/api/admin/student/unlock-login').set('x-admin-session', token).send({ email: 'caio@guard.local' });
    assert.equal(foreign.status, 403);
    assert.ok(loginGuard.protectionFor(loginGuard.accountKey('student', 'caio@guard.local')), 'o atraso continua');
    const missing = await request(app).post('/api/admin/student/unlock-login').set('x-admin-session', token).send({});
    assert.equal(missing.status, 400);
    assert.equal(missing.body.field, 'email');
    const wrongType = await request(app).post('/api/admin/student/unlock-login').set('x-admin-session', token).send({ email: ['ana@guard.local'] });
    assert.ok(wrongType.status === 400 || wrongType.status === 403, `status ${wrongType.status}`);
    const unknown = await request(app).post('/api/admin/student/unlock-login').set('x-admin-session', await adminToken(ADMIN)).send({ email: 'nao@guard.local' });
    assert.equal(unknown.status, 404);
});

test('[UC-AUTH-002] "Liberar login" de conta de instrutor: só administrador, com selo em Contas', async () => {
    const adminSession = await adminToken(ADMIN);
    const profSession = await adminToken(PROF);
    await delay('admin', OTHER_PROF.email);
    await adminLogin(OTHER_PROF.email, OTHER_PROF.password).expect(429);

    const accounts = await request(app).get('/api/admin/accounts').set('x-admin-session', adminSession).expect(200);
    assert.equal(accounts.body.find(item => item.email === OTHER_PROF.email).loginProtection.failures, 5);

    await request(app).post('/api/admin/accounts/unlock-login').set('x-admin-session', profSession).send({ email: OTHER_PROF.email }).expect(403);
    const res = await request(app).post('/api/admin/accounts/unlock-login').set('x-admin-session', adminSession).send({ email: OTHER_PROF.email }).expect(200);
    assert.equal(res.body.unlocked, true);
    assert.ok(db.memory.auditLogs.some(entry => entry.action === 'account_login_unlocked' && entry.targetEmail === OTHER_PROF.email));
    await adminLogin(OTHER_PROF.email, OTHER_PROF.password).expect(200);
});

test('[UC-AUTH-002] fila "Precisa de você": professor vê os alunos da turma dele; administrador vê também contas e o alerta por IP', async () => {
    const profSession = await adminToken(PROF);
    const adminSession = await adminToken(ADMIN);
    db.memory.students.find(item => item.email === 'bia@guard.local').recoveryRequested = true;
    await delay('student', 'ana@guard.local');
    await delay('student', 'caio@guard.local'); // de outra turma: não aparece para o professor
    await delay('admin', OTHER_PROF.email);
    // 49 senhas erradas já contadas deste IP: a 50.ª cria o alerta.
    for (let i = 0; i < passwordLogin.IP_ALERT_THRESHOLD - 1; i += 1) {
        rateLimiter.hit('login-fail-ip:127.0.0.1', { max: Number.MAX_SAFE_INTEGER, windowMs: passwordLogin.IP_ALERT_WINDOW_MS });
    }
    await studentLogin('alguem@guard.local', 'chute').expect(401);
    const alert = db.memory.loginLogs.find(entry => entry.status === 'alert');
    assert.ok(alert, 'alerta em loginLogs');
    assert.equal(alert.count, passwordLogin.IP_ALERT_THRESHOLD);
    await studentLogin('outro@guard.local', 'chute').expect(401);
    assert.equal(db.memory.loginLogs.filter(entry => entry.status === 'alert').length, 1, 'um alerta por janela, com o count atualizado');
    assert.equal(alert.count, passwordLogin.IP_ALERT_THRESHOLD + 1);

    const prof = await request(app).get('/api/admin/dashboard/queue?courseId=DES&studentClass=1DES').set('x-admin-session', profSession).expect(200);
    const profItems = Object.fromEntries((prof.body.items || prof.body).map(item => [item.id, item]));
    assert.equal(profItems.login_tentativas.count, 1);
    assert.equal(profItems.login_tentativas.href, '/alunos');
    assert.equal(profItems.senhas_pedidas.count, 1);
    assert.equal(profItems.login_tentativas_contas, undefined);
    assert.equal(profItems.login_ip_alerta, undefined);

    const adm = await request(app).get('/api/admin/dashboard/queue?courseId=DES&studentClass=1DES').set('x-admin-session', adminSession).expect(200);
    const admItems = Object.fromEntries((adm.body.items || adm.body).map(item => [item.id, item]));
    assert.equal(admItems.login_tentativas.count, 1);
    assert.equal(admItems.login_tentativas_contas.count, 1);
    assert.equal(admItems.login_tentativas_contas.href, '/admins');
    assert.equal(admItems.login_ip_alerta.count, 1);
    assert.match(admItems.login_ip_alerta.detalhe, /127\.0\.0\.1/);
});

test('[UC-AUTH-002] computeQueue sem o bloco de segurança fica como antes', () => {
    const items = computeQueue({ memory: { ...db.memory, students: [] }, cls: null, course: null, students: [], today: '2026-11-10', now: Date.now(), canSeeMatriculas: true });
    assert.equal(items.some(item => /^login_|^senhas_/.test(item.id)), false);
});
