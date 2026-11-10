// Fim da sessão no servidor e perfil mínimo do aluno (H5b; SEG-10, SEG-16, DES-X2).
//
// Antes: o "Sair" do aluno só limpava o navegador (o token valia até 8 h no servidor, num
// computador de laboratório compartilhado); o "Redefinir senha" do professor deixava a
// sessão aberta com a senha antiga; a troca de senha do instrutor deixava as outras
// sessões dele abertas; o token do aluno valia também em ?sessionToken= na URL (vai para o
// histórico e para os registros); e o login do aluno mandava o cadastro inteiro
// (responsável, telefones, acessibilidade) para o localStorage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-session-revocation-test-'));
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
const { STUDENT_SESSION_PROFILE_FIELDS } = require('../../backend/utils/studentProfile.js');

const ADMIN = { email: 'adm@sessao.local', password: 'senha-adm-forte' };
const PROF = { email: 'prof@sessao.local', password: 'senha-prof-forte' };
const STUDENT_PASSWORD = 'aluno-senha-1';
const ANA = 'ana@sessao.local';
let app;

function seed() {
    db.memory.config = { ...(db.memory.config || {}), settings: {} };
    db.memory.admins = [
        { email: ADMIN.email, name: 'Admin', role: 'admin', password: db.hashPassword(ADMIN.password) },
        { email: PROF.email, name: 'Professor', role: 'professor', password: db.hashPassword(PROF.password), assignedClasses: ['1DES'], assignedCourseIds: ['DES'] },
    ];
    db.memory.students = [{
        email: ANA, name: 'Ana Souza', nomeSocial: '', password: db.hashPassword(STUDENT_PASSWORD),
        classes: ['1DES'], studentClass: '1DES', status: 'Ativo', matricula: '2026-07',
        phone: '11 98888-0000', birthDate: '2009-03-02', cpf: '000.000.000-00', unidade: 'Centro',
        guardian: { name: 'Maria Souza', phone: '11 99999-0000', email: 'maria@familia.local', parentesco: 'mãe' },
        accessibility: { needs: ['baixa visão'], notes: 'fonte grande' },
    }];
    db.memory.sessions = {};
    db.memory.adminSessions = {};
    db.memory.classes = [{ name: '1DES', courseId: 'DES' }];
    db.memory.courses = [{ id: 'DES', name: 'Desenvolvimento' }];
    db.memory.examApplications = [];
    db.memory.studentExamState = {};
    db.memory.loginLogs = [];
    db.memory.auditLogs = [];
}

const studentLogin = (password = STUDENT_PASSWORD) => request(app).post('/api/student/login').send({ email: ANA, password });
const ping = token => request(app).get(`/api/ping?email=${encodeURIComponent(ANA)}`).set('x-session-token', token);
async function studentToken() { return (await studentLogin().expect(200)).body.sessionToken; }
async function adminToken(account = ADMIN) {
    return (await request(app).post('/api/session/admin-login').send(account).expect(200)).body.sessionToken;
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

test('[UC-AUTH-003] "Sair" do aluno (POST /api/student/logout) encerra a sessão no servidor', async () => {
    const token = await studentToken();
    await ping(token).expect(200);
    const res = await request(app).post('/api/student/logout').set('x-session-token', token).send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    // O pedido seguinte do token antigo (outra aba) diz o motivo (contrato 401
    // { sessionRevoked, reason }); antes saía o "sessão expirada" genérico, sem reason.
    const after = await ping(token).expect(401);
    assert.equal(after.body.sessionRevoked, true);
    assert.equal(after.body.reason, 'logout');
    // Sem sessão, o logout não derruba ninguém.
    await request(app).post('/api/student/logout').send({ email: ANA }).expect(401);
});

test('[UC-AUTH-003] o beacon antigo /api/student/leave continua encerrando a sessão', async () => {
    const token = await studentToken();
    await request(app).post('/api/student/leave').set('x-session-token', token).set('Content-Type', 'text/plain').send(ANA).expect(200);
    await ping(token).expect(401);
});

test('[UC-AUTH-003] o token do aluno não vale mais em ?sessionToken= na URL', async () => {
    const token = await studentToken();
    const res = await request(app).get(`/api/ping?email=${encodeURIComponent(ANA)}&sessionToken=${token}`);
    assert.equal(res.status, 401);
    await ping(token).expect(200);
});

test('[UC-AUTH-003] o login do aluno manda só o perfil do portal, sem dados pessoais', async () => {
    const res = await studentLogin().expect(200);
    const student = res.body.student;
    assert.equal(student.email, ANA);
    assert.equal(student.name, 'Ana Souza');
    assert.ok(Array.isArray(student.classes) && student.classes[0].name === '1DES');
    for (const key of Object.keys(student)) assert.ok(STUDENT_SESSION_PROFILE_FIELDS.includes(key), `campo fora do perfil: ${key}`);
    // A matrícula também fica fora (H5b, ajuste 2): o perfil vai para o localStorage.
    for (const secret of ['password', 'phone', 'birthDate', 'cpf', 'unidade', 'guardian', 'accessibility', 'matricula', '2026-07', 'maria@familia.local', '99999-0000', 'baixa visão']) {
        assert.equal(JSON.stringify(res.body).includes(secret), false, `a resposta do login não leva ${secret}`);
    }
});

test('[UC-AUTH-003] Minha conta lê a matrícula na hora (GET /api/student/account), só com a sessão do próprio aluno', async () => {
    const token = await studentToken();
    const res = await request(app).get('/api/student/account').set('x-session-token', token).expect(200);
    assert.deepEqual(res.body, { success: true, matricula: '2026-07' });
    await request(app).get('/api/student/account').expect(400);
    await request(app).get('/api/student/account').set('x-session-token', 'token-que-nao-existe').query({ email: ANA }).expect(401);
});

test('[UC-AUTH-003] "Redefinir senha" do professor encerra a sessão aberta do aluno e libera o atraso', async () => {
    const token = await studentToken();
    for (let n = 0; n < 5; n += 1) loginGuard.recordFailure(loginGuard.accountKey('student', ANA));
    const prof = await adminToken(PROF);
    const res = await request(app).post('/api/admin/reset-password').set('x-admin-session', prof).send({ email: ANA, newPassword: 'nova-senha-ana-7' });
    assert.equal(res.status, 200, res.body && res.body.error);
    assert.equal(res.body.sessionEnded, true);
    // O aparelho de antes lê o motivo, e não "Sessão expirada" (contrato 401 { reason }).
    const after = await ping(token).expect(401);
    assert.equal(after.body.sessionRevoked, true);
    assert.equal(after.body.reason, 'password_reset');
    assert.equal(after.body.error, 'A senha desta conta foi redefinida pelo professor. Entre de novo com a senha nova.');
    // Atraso liberado e a senha nova vale na hora.
    await studentLogin('nova-senha-ana-7').expect(200);
    // Com o aluno já de volta em outro aparelho, o token antigo continua com o motivo
    // certo (e não "a conta foi acessada em outro dispositivo").
    const again = await ping(token).expect(401);
    assert.equal(again.body.reason, 'password_reset');
    // A lista de Alunos não mostra o marcador interno.
    const list = await request(app).get('/api/admin/students?courseId=DES&studentClass=1DES').set('x-admin-session', prof).expect(200);
    assert.equal(list.body[0].sessionsInvalidBefore, undefined);
});

test('[UC-AUTH-003] "Redefinir senha" com o aluno em prova: a sessão termina a prova e acaba no primeiro pedido depois dela', async () => {
    const token = await studentToken();
    db.memory.examApplications = [{ id: 'app-1', status: 'running', studentClass: '1DES', courseId: 'DES', examKey: 'p1' }];
    db.memory.studentExamState = { 'app-1|ana': { applicationId: 'app-1', studentEmail: ANA, status: 'in_progress', attemptId: 'at-1' } };
    const prof = await adminToken(PROF);
    const res = await request(app).post('/api/admin/reset-password').set('x-admin-session', prof).send({ email: ANA, newPassword: 'nova-senha-ana-7' }).expect(200);
    assert.equal(res.body.sessionEnded, false);
    // Em prova: a sessão segue, só nas rotas da prova (decisão do coordenador, J2).
    await ping(token).expect(200);
    const examState = await request(app).get('/api/student/exam-state').set('x-session-token', token).query({ email: ANA, studentClass: '1DES', courseId: 'DES', examKey: 'p1' });
    assert.notEqual(examState.status, 401, 'rota da prova continua com o token de antes do reset');
    const activity = await request(app).post('/api/student/log-activity').set('x-session-token', token)
        .send({ email: ANA, studentClass: '1DES', courseId: 'DES', examKey: 'p1', applicationId: 'app-1', attemptId: 'at-1', eventType: 'focus_lost', details: 'teste' });
    assert.notEqual(activity.status, 401, 'log-activity continua');
    // O resto do portal não abre com o token de antes do reset (antes, abria até a entrega).
    for (const [method, url] of [['get', '/api/student/enrollments'], ['get', '/api/student/dashboard'], ['get', '/api/student/account'], ['post', '/api/student/notes/get']]) {
        const blocked = await request(app)[method](url).set('x-session-token', token).query({ email: ANA }).send({ email: ANA });
        assert.equal(blocked.status, 401, `${url}: antes, ${blocked.status}`);
        assert.equal(blocked.body.sessionRevoked, true);
        assert.equal(blocked.body.reason, 'password_reset');
    }
    // A recusa fora da prova não encerra a sessão: a prova continua.
    await ping(token).expect(200);
    // Acabou a prova: o próximo pedido recebe 401 com o motivo, e a sessão sai.
    db.memory.examApplications[0].status = 'finished';
    const after = await ping(token);
    assert.equal(after.status, 401);
    assert.equal(after.body.sessionRevoked, true);
    assert.equal(after.body.reason, 'password_reset');
    assert.match(after.body.error, /senha desta conta foi redefinida/);
    await ping(token).expect(401);
    // O login novo, com a senha nova, não é derrubado pela marca da redefinição.
    const fresh = (await studentLogin('nova-senha-ana-7').expect(200)).body.sessionToken;
    await ping(fresh).expect(200);
});

test('[UC-AUTH-003] "Redefinir senha" com prova na turma que o aluno ainda não abriu: a sessão antiga acaba na hora', async () => {
    // Antes: a regra da troca adiada (aplicação ativa na turma, dentro da janela) também
    // segurava a sessão. Quem tinha a senha antiga continuava entrando por até 4 h só
    // porque a turma estava em prova, sem o aluno ter aberto a tentativa.
    const token = await studentToken();
    db.memory.examApplications = [{ id: 'app-1', status: 'waiting', studentClass: '1DES', courseId: 'DES', examKey: 'p1', startsAt: new Date().toISOString(), durationMinutes: 60 }];
    db.memory.studentExamState = {};
    const prof = await adminToken(PROF);
    const res = await request(app).post('/api/admin/reset-password').set('x-admin-session', prof).send({ email: ANA, newPassword: 'nova-senha-ana-7' }).expect(200);
    assert.equal(res.body.sessionEnded, true);
    await ping(token).expect(401);
    await request(app).get('/api/student/enrollments').set('x-session-token', token).query({ email: ANA }).expect(401);
    // O aluno entra de novo com a senha nova e faz a prova.
    const fresh = (await studentLogin('nova-senha-ana-7').expect(200)).body.sessionToken;
    await ping(fresh).expect(200);
});

test('[UC-AUTH-003] "Redefinir senha" em prova: depois da entrega o token antigo também não abre arquivo de /imagens', async () => {
    const imagesDir = path.join(process.env.ICLASS_CONTENT_DIR, 'imagens', 'sessao');
    fs.mkdirSync(imagesDir, { recursive: true });
    fs.writeFileSync(path.join(imagesDir, 'figura.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    const token = await studentToken();
    const image = () => request(app).get('/imagens/sessao/figura.png').set('x-session-token', token);
    await image().expect(200);
    db.memory.examApplications = [{ id: 'app-1', status: 'running', studentClass: '1DES', courseId: 'DES', examKey: 'p1' }];
    db.memory.studentExamState = { 'app-1|ana': { applicationId: 'app-1', studentEmail: ANA, status: 'in_progress', attemptId: 'at-1' } };
    const prof = await adminToken(PROF);
    const res = await request(app).post('/api/admin/reset-password').set('x-admin-session', prof).send({ email: ANA, newPassword: 'nova-senha-ana-7' }).expect(200);
    assert.equal(res.body.sessionEnded, false);
    // Na prova, a imagem da questão continua abrindo.
    await image().expect(200);
    // Entregou: antes, o token antigo seguia abrindo /uploads e /imagens até passar por
    // validateStudentSession.
    db.memory.studentExamState['app-1|ana'].status = 'submitted';
    await image().expect(401);
    await ping(token).expect(401);
});

test('[UC-AUTH-003] troca de senha do instrutor encerra as outras sessões dele e mantém a deste aparelho', async () => {
    const here = await adminToken(PROF);
    const elsewhere = await adminToken(PROF);
    const other = await adminToken(ADMIN);
    await request(app).get('/api/admin/whoami').set('x-admin-session', elsewhere).expect(200);
    const res = await request(app).post('/api/admin/change-password').set('x-admin-session', here)
        .send({ currentPassword: PROF.password, newPassword: 'Girassol-azul-42' });
    assert.equal(res.status, 200, res.body && res.body.error);
    assert.equal(res.body.endedSessions, 1);
    await request(app).get('/api/admin/whoami').set('x-admin-session', here).expect(200);
    const ended = await request(app).get('/api/admin/whoami').set('x-admin-session', elsewhere).expect(401);
    assert.equal(ended.body.sessionRevoked, true);
    assert.equal(ended.body.reason, 'password_changed');
    assert.match(ended.body.error, /senha desta conta foi trocada/);
    // A sessão de outra conta não é tocada.
    await request(app).get('/api/admin/whoami').set('x-admin-session', other).expect(200);
    const audit = db.memory.auditLogs.find(entry => entry.action === 'account_password_changed');
    assert.equal(audit.details.endedSessions, 1);
});

test('[UC-AUTH-003] prova sem cronômetro aberta há dias: depois do "Redefinir senha" o token antigo segue só na prova até o professor encerrar', async () => {
    // Decisões §10 (revisão da J2): na prova sem cronômetro não há corte de 4 h; enquanto a
    // aplicação estiver aberta, a tentativa sem entrega é prova em andamento. Antes, a prova B
    // da referência (sem cronômetro, em andamento desde 19/10) deixava de contar depois de 4 h
    // e o "Redefinir senha" derrubava a aluna no meio da prova. O portal continua fechado
    // para o token antigo, e encerrar a aplicação fecha a janela.
    const token = await studentToken();
    const threeDaysAgo = Date.now() - 3 * 24 * 3600 * 1000;
    db.memory.examApplications = [{ id: 'app-b', status: 'running', studentClass: '1DES', courseId: 'DES', examKey: 'pB', timerEnabled: false, startedAt: new Date(threeDaysAgo).toISOString() }];
    db.memory.studentExamState = { 'app-b|ana': { applicationId: 'app-b', studentEmail: ANA, status: 'active', attemptId: 'at-b', startedAt: threeDaysAgo } };
    const prof = await adminToken(PROF);
    const res = await request(app).post('/api/admin/reset-password').set('x-admin-session', prof).send({ email: ANA, newPassword: 'nova-senha-ana-7' }).expect(200);
    assert.equal(res.body.sessionEnded, false, 'antes, true: a sessão da prova acabava');
    await ping(token).expect(200);
    const portal = await request(app).get('/api/student/enrollments').set('x-session-token', token).query({ email: ANA }).expect(401);
    assert.equal(portal.body.reason, 'password_reset');
    // O professor encerrou a aplicação: a sessão de antes acaba de vez.
    db.memory.examApplications[0].status = 'finished';
    const after = await ping(token).expect(401);
    assert.equal(after.body.reason, 'password_reset');
});

test('[UC-AUTH-003] tentativa aberta dentro do tempo da prova segura a sessão; passado o prazo com a folga, não; sem cronômetro, até encerrar', () => {
    const { studentHasOpenAttempt } = require('../../backend/utils/passwordChange.js');
    const now = Date.now();
    const memory = {
        examApplications: [{ id: 'app-t', status: 'running', durationMinutes: 50, globalTimeAdjustment: 10 }],
        studentExamState: { 'app-t|ana': { applicationId: 'app-t', studentEmail: ANA, status: 'active', startedAt: now - 30 * 60000 } },
    };
    // 60 min de prova (50 + 10) e mais 30 min de folga.
    assert.equal(studentHasOpenAttempt(memory, ANA, now), true);
    assert.equal(studentHasOpenAttempt(memory, ANA, now + 59 * 60000), true);
    assert.equal(studentHasOpenAttempt(memory, ANA, now + 61 * 60000), false);
    // Sem cronômetro: sem corte enquanto a aplicação estiver aberta (antes, 4 h).
    memory.examApplications[0].timerEnabled = false;
    assert.equal(studentHasOpenAttempt(memory, ANA, now + 3 * 3600000), true);
    assert.equal(studentHasOpenAttempt(memory, ANA, now + 5 * 3600000), true, 'antes, false depois de 4 h');
    assert.equal(studentHasOpenAttempt(memory, ANA, now + 30 * 24 * 3600000), true);
    memory.examApplications[0].status = 'paused';
    assert.equal(studentHasOpenAttempt(memory, ANA, now + 5 * 3600000), true);
    memory.examApplications[0].status = 'finished';
    assert.equal(studentHasOpenAttempt(memory, ANA, now), false);
    memory.examApplications[0].status = 'running';
    // Entregue: não conta.
    memory.studentExamState['app-t|ana'].status = 'submitted';
    assert.equal(studentHasOpenAttempt(memory, ANA, now), false);
    memory.studentExamState['app-t|ana'].status = 'active';
    // Tentativa sem hora nenhuma (estado antigo): continua contando como aberta.
    memory.studentExamState['app-t|ana'].startedAt = null;
    assert.equal(studentHasOpenAttempt(memory, ANA, now + 30 * 24 * 3600000), true);
});

test('[UC-AUTH-003] Sair do instrutor: o token antigo recebe 401 com reason logout', async () => {
    const token = await adminToken(ADMIN);
    await request(app).post('/api/session/logout').set('x-admin-session', token).send({}).expect(200);
    const after = await request(app).get('/api/admin/whoami').set('x-admin-session', token).expect(401);
    assert.equal(after.body.sessionRevoked, true);
    assert.equal(after.body.reason, 'logout');
});

test('[UC-AUTH-003] rota de qualquer perfil (validateAnySession) também diz o motivo ao token encerrado', async () => {
    const token = await studentToken();
    await request(app).post('/api/student/logout').set('x-session-token', token).send({}).expect(200);
    const res = await request(app).get('/api/data.js').set('x-session-token', token).expect(401);
    assert.equal(res.body.sessionRevoked, true);
    assert.equal(res.body.reason, 'logout');
});
