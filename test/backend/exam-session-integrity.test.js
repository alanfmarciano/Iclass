// Outro login e troca de IP durante a prova (fase 3, P3-S13: AVA-17; D28 e D29 do desenho
// do P3).
//
// - login com a mesma conta e a tentativa em andamento grava session_replaced (IP e
//   navegador de antes e de agora) e, com a política 'travar' (padrão), trava a tentativa
//   até o professor liberar; com 'avisar' só grava;
// - sem tentativa em andamento (só nas instruções, entregue) ou sem sessão de verdade antes
//   (Sair, reinício longo), nada é gravado;
// - troca de IP com a tentativa aberta grava ip_changed uma vez por IP novo, pelas rotas da
//   prova (sync, autosave-progress, log-activity), e nunca trava;
// - o Monitor mostra os selos (sessionReplacedAt, ipChangeCount), o motivo da trava e o
//   IP repetido (2 ou 3 alunos num IP com pelo menos 5 IPs; rede com NAT não marca);
// - as rotas continuam com gravação parcial (o verificador não acusa nada);
// - o navegador do login fica na sessão (cortado em 120 caracteres) e volta depois de um
//   reinício; a Política de Privacidade padrão fala do IP e do aparelho da prova.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-session-integrity-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const authSessions = require('../../backend/utils/authSessions.js');
const integrity = require('../../backend/utils/examSessionIntegrity.js');
const legal = require('../../backend/utils/legalTemplates.js');
const rateLimit = require('../../backend/utils/rateLimit.js');

let app;
const adminToken = 'admin-token-session-integrity';
const studentClass = '2DES';
const courseId = 'curso-integridade';
const examKey = 'Avaliacao_Integridade';
const PASSWORD = 'Senha-da-prova-2026';
const ALICE = 'alice@integridade.local';
const BRUNO = 'bruno@integridade.local';
const OTHERS = ['carla', 'davi', 'elisa', 'fabio', 'gina'].map(name => `${name}@integridade.local`);
const OLD_BROWSER = 'Mozilla/5.0 (Linux; Android 14) Celular antigo da Alice';
const NEW_BROWSER = `Mozilla/5.0 (X11; Linux x86_64) Computador do laboratorio ${'x'.repeat(200)}`;

const admin = req => req.set('x-admin-session', adminToken);
const tokens = {};
const asStudent = (req, email) => req.set('x-session-token', tokens[email]);

function seed() {
    rateLimit.resetForTests();
    db.memory.admins = [{ email: 'admin@integridade.local', name: 'Admin', role: 'admin', password: db.hashPassword('senha-administrativa') }];
    db.memory.adminSessions = { [adminToken]: { email: 'admin@integridade.local', createdAt: Date.now(), lastSeen: Date.now() } };
    const student = (name, email) => ({ name, email, status: 'Ativo', password: db.hashPassword(PASSWORD), classes: [{ name: studentClass, courseId }] });
    db.memory.students = [
        student('Alice Souza', ALICE),
        student('Bruno Lima', BRUNO),
        ...OTHERS.map(email => student(email.split('@')[0], email)),
    ];
    db.memory.sessions = {};
    [ALICE, BRUNO, ...OTHERS].forEach(email => {
        tokens[email] = authSessions.createStudentSession(db.memory, email, { ip: '127.0.0.1', userAgent: OLD_BROWSER });
    });
    db.memory.courses = [{ id: courseId, structure: [{ name: 'Módulo', units: [{ avaliacaoKey: examKey }] }] }];
    db.memory.classes = [{ name: studentClass, courseId, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} }];
    db.memory.evaluations = {
        [examKey]: {
            key: examKey,
            title: 'Prova da integridade',
            questions: [1, 2].map(number => ({
                number,
                text: `Questão ${number}`,
                correctAnswer: 'A',
                alternatives: [{ letter: 'A', text: 'Certa', isCorrect: true }, { letter: 'B', text: 'Errada', isCorrect: false }],
            })),
        },
    };
    db.memory.submissions = [];
    db.memory.examApplications = [];
    db.memory.studentExamState = {};
    db.memory.proctoringLogs = [];
    db.memory.broadcastMessages = [];
    db.memory.auditLogs = [];
    db.memory.loginLogs = [];
    db.memory.attendance = [];
}

test.before(async () => {
    await db.init();
    app = createApp();
});
test.beforeEach(() => seed());
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

const SNAPSHOT = [{
    version: 'A',
    questions: [1, 2].map(number => ({ originalNumber: number, text: `Questão ${number}`, alternatives: [{ letter: 'A', text: 'Certa' }, { letter: 'B', text: 'Errada' }] })),
}];

async function running(options = {}) {
    const history = await admin(request(app).post('/api/admin/exam-history/add')).send({
        studentClass, courseId, examKey, type: 'online', questionNumbers: [1, 2], printSnapshot: SNAPSHOT,
        durationMinutes: 30, waitingRoomMinutes: 0, maxAttempts: 1,
    }).expect(200);
    const prepared = await admin(request(app).post('/api/admin/exam-applications')).send({
        studentClass, courseId, examKey, historyId: history.body.entry.id,
        applicationOptions: { timerMode: 'per_attempt', waitingRoomMinutes: 0, maxAttempts: 1, ...options },
    });
    assert.equal(prepared.status, 201, JSON.stringify(prepared.body));
    const started = await admin(request(app).post(`/api/admin/exam-applications/${prepared.body.application.id}/control`)).send({ action: 'start' }).expect(200);
    return started.body.application;
}

function sync(email, applicationId) {
    return asStudent(request(app).get('/api/student/sync'), email).query({ email, studentClass, courseId, examKey, applicationId });
}

async function begin(email, applicationId) {
    await sync(email, applicationId).expect(200);
    const started = await asStudent(request(app).post(`/api/student/exam-applications/${applicationId}/start-attempt`), email).send({});
    assert.equal(started.status, 200, JSON.stringify(started.body));
    return started.body;
}

function openState(email, applicationId) {
    return Object.values(db.memory.studentExamState).find(state => state.applicationId === applicationId && state.studentEmail === email && state.status !== 'submitted');
}

function logsOf(type, email = ALICE) {
    return db.memory.proctoringLogs.filter(log => log.eventType === type && log.studentEmail === email);
}

// Login da Alice "em outro aparelho": a sessão de antes era de outro IP e navegador.
async function loginAgain(email = ALICE, { previousIp = '10.0.0.5' } = {}) {
    const previous = authSessions.studentSessionByEmail(db.memory, email);
    if (previous) previous.ip = previousIp;
    const response = await request(app).post('/api/student/login').set('User-Agent', NEW_BROWSER).send({ email, password: PASSWORD });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const oldToken = tokens[email];
    tokens[email] = response.body.sessionToken;
    return { response, oldToken };
}

async function monitorRows(applicationId) {
    const monitor = await admin(request(app).get(`/api/admin/monitor-status/${encodeURIComponent(studentClass)}/${examKey}`)).query({ courseId, applicationId }).expect(200);
    return monitor.body;
}

test('[UC-TENTATIVA-005] outro login com a prova em andamento grava session_replaced com o IP e o navegador de antes e de agora e trava a tentativa (padrão)', async () => {
    const failuresBefore = db.saveVerifyFailures.length;
    const application = await running();
    assert.equal(application.sessionPolicy, 'travar', 'a aplicação sem escolha fica com o padrão');
    await begin(ALICE, application.id);
    await begin(BRUNO, application.id);

    const { oldToken } = await loginAgain();
    const [log] = logsOf('session_replaced');
    assert.ok(log, 'o login grava session_replaced');
    assert.equal(log.applicationId, application.id);
    assert.equal(log.attemptId, openState(ALICE, application.id).attemptId);
    assert.equal(log.sessionChange.ipAntes, '10.0.0.5');
    assert.equal(log.sessionChange.ipDepois, '127.0.0.1');
    assert.equal(log.sessionChange.navegadorAntes, OLD_BROWSER);
    assert.equal(log.sessionChange.navegadorDepois, NEW_BROWSER.slice(0, 120), 'o navegador vai cortado em 120 caracteres');
    assert.equal(log.sessionChange.travou, true);
    assert.match(log.details, /Entrou de outro aparelho.*10\.0\.0\.5 → 127\.0\.0\.1.*travada/);
    assert.equal(logsOf('session_replaced', BRUNO).length, 0, 'só a conta que entrou de novo');
    assert.equal(db.memory.auditLogs.some(entry => /session_replaced/.test(entry.action || entry.type || '')), false, 'fica no registro da prova, não na auditoria');

    const state = openState(ALICE, application.id);
    assert.equal(state.focusLocked, true);
    assert.equal(state.focusLockReason, 'session_replaced');
    assert.equal(state.focusLockEventId, log.id);
    assert.deepEqual([...state.sessionIps].sort(), ['10.0.0.5', '127.0.0.1'], 'os dois IPs ficam na tentativa (o aparelho novo não vira ip_changed)');
    assert.equal(openState(BRUNO, application.id).focusLocked, false);

    // O aparelho antigo sai; o novo vê a prova travada com o motivo.
    const old = await request(app).get('/api/student/sync').set('x-session-token', oldToken)
        .query({ email: ALICE, studentClass, courseId, examKey, applicationId: application.id });
    assert.equal(old.status, 401);
    assert.equal(old.body.reason, 'replaced');
    const fresh = await sync(ALICE, application.id).expect(200);
    assert.equal(fresh.body.state.focusLocked, true);
    assert.equal(fresh.body.state.focusLockReason, 'session_replaced');
    const autosave = await asStudent(request(app).post('/api/student/autosave-progress'), ALICE)
        .send({ email: ALICE, studentClass, courseId, examKey, applicationId: application.id, answers: {} });
    // O rascunho que já estava a caminho ainda entra logo depois da trava (15 s); depois, 423.
    assert.ok([200, 423].includes(autosave.status), JSON.stringify(autosave.body));
    openState(ALICE, application.id).focusLockedAt = Date.now() - 60 * 1000;
    const lateAutosave = await asStudent(request(app).post('/api/student/autosave-progress'), ALICE)
        .send({ email: ALICE, studentClass, courseId, examKey, applicationId: application.id, answers: {} });
    assert.equal(lateAutosave.status, 423);

    // Monitor: travado pelo outro aparelho, com o selo e a hora.
    const row = (await monitorRows(application.id)).find(item => item.email === ALICE);
    assert.equal(row.status, 'focus_locked');
    assert.equal(row.focusLockReason, 'session_replaced');
    assert.equal(row.sessionReplacedCount, 1);
    assert.equal(row.sessionReplacedAt, log.timestamp);
    assert.equal(row.ipChangeCount, 0);
    assert.ok(row.logs.some(item => item.eventType === 'session_replaced'));

    // O professor libera pelo Monitor e a prova continua no aparelho novo.
    await admin(request(app).post('/api/admin/unlock-student-focus')).send({ studentEmail: ALICE, studentClass, courseId, examKey, applicationId: application.id }).expect(200);
    assert.equal(openState(ALICE, application.id).focusLocked, false);
    await asStudent(request(app).post('/api/student/autosave-progress'), ALICE)
        .send({ email: ALICE, studentClass, courseId, examKey, applicationId: application.id, answers: {} }).expect(200);

    assert.deepEqual(db.saveVerifyFailures.slice(failuresBefore).map(item => `${item.path} ${item.collection}`), []);
});

test('[UC-TENTATIVA-005] com "Só avisar" o outro login grava session_replaced sem travar; política inválida é recusada', async () => {
    const refused = await admin(request(app).post('/api/admin/exam-history/add')).send({
        studentClass, courseId, examKey, type: 'online', questionNumbers: [1, 2], printSnapshot: SNAPSHOT, durationMinutes: 30, waitingRoomMinutes: 0, maxAttempts: 1,
    }).expect(200);
    const invalid = await admin(request(app).post('/api/admin/exam-applications')).send({
        studentClass, courseId, examKey, historyId: refused.body.entry.id,
        applicationOptions: { timerMode: 'per_attempt', waitingRoomMinutes: 0, sessionPolicy: 'derrubar' },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.field, 'applicationOptions.sessionPolicy');

    const application = await running({ sessionPolicy: 'avisar' });
    assert.equal(application.sessionPolicy, 'avisar');
    await begin(ALICE, application.id);
    await loginAgain();
    const [log] = logsOf('session_replaced');
    assert.ok(log);
    assert.equal(log.sessionChange.travou, false);
    assert.equal(log.sessionChange.politica, 'avisar');
    assert.match(log.details, /Só aviso/);
    assert.equal(openState(ALICE, application.id).focusLocked, false);
    const row = (await monitorRows(application.id)).find(item => item.email === ALICE);
    assert.equal(row.status === 'focus_locked', false);
    assert.equal(row.sessionReplacedCount, 1);
});

test('[UC-TENTATIVA-005] sem tentativa em andamento, ou sem sessão de verdade antes, o login não grava nada', async () => {
    const application = await running();
    // Só nas instruções (a tentativa existe, mas não começou).
    await sync(ALICE, application.id).expect(200);
    await loginAgain();
    assert.equal(logsOf('session_replaced').length, 0, 'tentativa que não começou');
    assert.notEqual(openState(ALICE, application.id).focusLocked, true);

    // Depois da entrega.
    const started = await begin(BRUNO, application.id);
    await asStudent(request(app).post('/api/student/submit'), BRUNO).send({
        studentClass, courseId, examKey, applicationId: application.id, attemptId: started.attemptId,
        answers: {}, questionNumbers: [1, 2], examConfigVersion: started.examConfigVersion,
    }).expect(200);
    await loginAgain(BRUNO);
    assert.equal(logsOf('session_replaced', BRUNO).length, 0, 'tentativa entregue');

    // Saiu (ou o servidor ficou fora do ar tempo demais): não há sessão para substituir.
    const carla = OTHERS[0];
    await begin(carla, application.id);
    authSessions.revokeStudentSession(db.memory, carla);
    await loginAgain(carla);
    assert.equal(logsOf('session_replaced', carla).length, 0, 'sem sessão de antes');
    assert.notEqual(openState(carla, application.id).focusLocked, true);
});

test('[UC-TENTATIVA-005] troca de IP com a prova aberta grava ip_changed uma vez por IP novo, em sync, autosave e log-activity, e nunca trava', async () => {
    const failuresBefore = db.saveVerifyFailures.length;
    const application = await running();
    await begin(ALICE, application.id);
    const state = () => openState(ALICE, application.id);
    assert.deepEqual(state().sessionIps, ['127.0.0.1'], 'o primeiro IP só fica guardado');
    await sync(ALICE, application.id).expect(200);
    assert.equal(logsOf('ip_changed').length, 0, 'mesmo IP: nada');

    // O celular estava em 10.0.0.7 e agora aparece em 127.0.0.1 (troca de rede).
    const moveFrom = ip => {
        state().sessionIps = [ip];
        authSessions.studentSessionByEmail(db.memory, ALICE).ip = ip;
    };
    moveFrom('10.0.0.7');
    await sync(ALICE, application.id).expect(200);
    let changes = logsOf('ip_changed');
    assert.equal(changes.length, 1);
    assert.equal(changes[0].sessionChange.ipAntes, '10.0.0.7');
    assert.equal(changes[0].sessionChange.ipDepois, '127.0.0.1');
    assert.equal(changes[0].sessionChange.travou, false);
    assert.equal(changes[0].attemptId, state().attemptId);
    assert.match(changes[0].details, /Mudou de endereço de rede: 10\.0\.0\.7 → 127\.0\.0\.1/);
    assert.notEqual(state().focusLocked, true, 'troca de IP nunca trava');
    assert.equal(authSessions.studentSessionByEmail(db.memory, ALICE).ip, '127.0.0.1');
    await sync(ALICE, application.id).expect(200);
    await asStudent(request(app).post('/api/student/autosave-progress'), ALICE)
        .send({ email: ALICE, studentClass, courseId, examKey, applicationId: application.id, answers: {} }).expect(200);
    assert.equal(logsOf('ip_changed').length, 1, 'o mesmo IP novo não repete o registro');

    // Pelo autosave.
    moveFrom('10.0.0.8');
    await asStudent(request(app).post('/api/student/autosave-progress'), ALICE)
        .send({ email: ALICE, studentClass, courseId, examKey, applicationId: application.id, answers: {} }).expect(200);
    changes = logsOf('ip_changed');
    assert.equal(changes.length, 2);
    assert.equal(changes[1].sessionChange.ipAntes, '10.0.0.8');

    // Pelo log-activity (um evento que não trava).
    moveFrom('10.0.0.9');
    await asStudent(request(app).post('/api/student/log-activity'), ALICE)
        .send({ email: ALICE, studentClass, courseId, examKey, applicationId: application.id, attemptId: state().attemptId, eventType: 'exam_render_error', details: 'teste' }).expect(200);
    assert.equal(logsOf('ip_changed').length, 3);
    assert.notEqual(state().focusLocked, true);

    // Tentativa de antes desta versão (sem sessionIps): vale a troca que a sessão viu agora.
    delete state().sessionIps;
    authSessions.studentSessionByEmail(db.memory, ALICE).ip = '10.0.0.10';
    await sync(ALICE, application.id).expect(200);
    changes = logsOf('ip_changed');
    assert.equal(changes.length, 4);
    assert.equal(changes[3].sessionChange.ipAntes, '10.0.0.10');
    // Sem troca nenhuma e sem lista: só guarda o IP.
    delete state().sessionIps;
    await sync(ALICE, application.id).expect(200);
    assert.equal(logsOf('ip_changed').length, 4);
    assert.deepEqual(state().sessionIps, ['127.0.0.1']);

    // Sem tentativa aberta, a troca de IP não vai para o registro da prova.
    authSessions.studentSessionByEmail(db.memory, BRUNO).ip = '10.0.0.11';
    await sync(BRUNO, application.id).expect(200);
    assert.equal(logsOf('ip_changed', BRUNO).length, 0, 'nas instruções a troca não é registrada');

    const row = (await monitorRows(application.id)).find(item => item.email === ALICE);
    assert.equal(row.ipChangeCount, 4);
    assert.ok(row.ipChangedAt > 0);
    assert.equal(row.sessionReplacedCount, 0);
    assert.equal(row.status === 'focus_locked', false);

    assert.deepEqual(db.saveVerifyFailures.slice(failuresBefore).map(item => `${item.path} ${item.collection}`), []);
});

test('[UC-TENTATIVA-005] IP repetido: 2 de 6 IPs marca "mesmo IP de"; rede com NAT (todos no mesmo IP) não marca e avisa', async () => {
    const entries = (ips) => ips.map((ip, index) => ({ email: `aluno${index}@x.local`, name: `Aluno ${index}`, ip }));
    const marked = integrity.sharedIpSummary(entries(['10.0.0.1', '10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5', '10.0.0.6']));
    assert.equal(marked.networkSharedIp, false);
    assert.deepEqual(marked.sameIpAs.get('aluno0@x.local').map(item => item.name), ['Aluno 1']);
    assert.deepEqual(marked.sameIpAs.get('aluno1@x.local').map(item => item.name), ['Aluno 0']);
    assert.equal(marked.sameIpAs.has('aluno2@x.local'), false);
    // Poucos IPs diferentes (menos de 5): sem destaque.
    assert.equal(integrity.sharedIpSummary(entries(['10.0.0.1', '10.0.0.1', '10.0.0.2', '10.0.0.3'])).sameIpAs.size, 0);
    // Grupo de 4 no mesmo IP não é destacado (2 a 3).
    assert.equal(integrity.sharedIpSummary(entries(['10.0.0.1', '10.0.0.1', '10.0.0.1', '10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5', '10.0.0.6', '10.0.0.7'])).sameIpAs.size, 0);
    const nat = integrity.sharedIpSummary(entries(Array.from({ length: 20 }, () => '192.168.0.1')));
    assert.equal(nat.networkSharedIp, true);
    assert.equal(nat.sameIpAs.size, 0);

    // Pela rota: Alice e Bruno no mesmo IP, os outros cinco cada um no seu.
    const application = await running();
    const everyone = [ALICE, BRUNO, ...OTHERS];
    for (const email of everyone) await begin(email, application.id);
    const ipOf = { [ALICE]: '10.1.0.1', [BRUNO]: '10.1.0.1' };
    OTHERS.forEach((email, index) => { ipOf[email] = `10.1.0.${index + 2}`; });
    everyone.forEach(email => { authSessions.studentSessionByEmail(db.memory, email).ip = ipOf[email]; });
    let rows = await monitorRows(application.id);
    const byEmail = email => rows.find(item => item.email === email);
    assert.deepEqual(byEmail(ALICE).sameIpAs.map(item => item.name), ['Bruno Lima']);
    assert.deepEqual(byEmail(BRUNO).sameIpAs.map(item => item.name), ['Alice Souza']);
    assert.deepEqual(byEmail(OTHERS[0]).sameIpAs, []);
    assert.equal(byEmail(ALICE).networkSharedIp, false);

    // Todos no mesmo IP (a sala sai por um IP só): ninguém é marcado e a linha avisa.
    everyone.forEach(email => { authSessions.studentSessionByEmail(db.memory, email).ip = '192.168.0.1'; });
    rows = await monitorRows(application.id);
    assert.equal(rows.every(item => item.sameIpAs.length === 0), true);
    assert.equal(rows.every(item => item.networkSharedIp === true), true);
});

test('[UC-TENTATIVA-005] o navegador do login fica na sessão (120 caracteres) e volta depois de um reinício; a Política padrão fala do IP e do aparelho da prova', () => {
    const memory = { sessions: {}, students: [{ email: 'ana@x.local', status: 'Ativo' }], admins: [] };
    authSessions.createStudentSession(memory, 'ana@x.local', { ip: '10.0.0.2', now: Date.now(), userAgent: `  ${'Navegador '.repeat(30)}  ` });
    const session = authSessions.studentSessionByEmail(memory, 'ana@x.local');
    assert.ok(session.userAgent.length <= 120 && session.userAgent.startsWith('Navegador Navegador'));
    const rows = authSessions.persistedSessionRows(memory);
    assert.equal(rows[0].value.userAgent, session.userAgent);
    const restored = { sessions: {}, adminSessions: {}, students: memory.students, admins: [] };
    authSessions.restoreSessions(restored, rows, { downtimeMs: 1000, now: Date.now() });
    assert.equal(authSessions.studentSessionByEmail(restored, 'ana@x.local').userAgent, session.userAgent);
    // Linha de antes desta versão (sem navegador) continua valendo.
    const legacy = rows.map(row => ({ key: row.key, value: { kind: 'student', email: 'ana@x.local', createdAt: row.value.createdAt, ip: '10.0.0.2' } }));
    const fromLegacy = { sessions: {}, adminSessions: {}, students: memory.students, admins: [] };
    authSessions.restoreSessions(fromLegacy, legacy, { downtimeMs: 1000, now: Date.now() });
    assert.equal(authSessions.studentSessionByEmail(fromLegacy, 'ana@x.local').userAgent, undefined);
    assert.equal(authSessions.studentSessionByEmail(fromLegacy, 'ana@x.local').ip, '10.0.0.2');

    assert.equal(integrity.normalizeSessionPolicy(undefined), 'travar');
    assert.equal(integrity.applicationSessionPolicy({}), 'travar', 'aplicação antiga vale o padrão');
    assert.equal(integrity.applicationSessionPolicy({ sessionPolicy: 'avisar' }), 'avisar');

    assert.notEqual(legal.MODEL_ID, 'modelo-2026.1', 'o texto do modelo mudou, o identificador muda junto');
    assert.match(legal.PRIVACY_MODEL, /endereço de rede \(IP\) e o aparelho \(navegador\) de cada entrada na conta durante a prova/);
    assert.match(legal.TERMS_MODEL, /outro aparelho com a prova em andamento, a prova pode ficar travada até o professor liberar/);
});
