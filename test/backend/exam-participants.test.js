// Segunda chamada, participantes e exceção por aluno (fase 3, P3-S7: AVA-09; D15, D16 e
// D17 do desenho do P3, contratos C2 e C7).
//
// - Aplicação com lista (segunda chamada ou alunos escolhidos): quem não está nela não vê a
//   aplicação, não recebe o sino, não sincroniza nem começa tentativa (403 not_participant)
//   e não conta como ausente no Monitor, no encerramento, no Dashboard nem na troca de senha.
// - A segunda chamada sem lista vem com quem ainda não tem entrega que conta numa
//   aplicação regular da prova (arquivada não conta como feita).
// - Exceção por aluno: tentativas extras (só ele ganha maxAttempts + N) e prazo para
//   começar (vencido, recusa o início).
// - Aplicação sem os campos novos (antiga) é da turma inteira, como antes.
// - A lista e as exceções são mapas por e-mail: troca de e-mail renomeia, anonimizar e
//   apagar de vez tiram o aluno, e Meus dados mostra a seção.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-participants-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { finishSummary } = require('../../backend/utils/examFinish.js');
const { studentHasExamInProgress } = require('../../backend/utils/passwordChange.js');
const { computeNow } = require('../../backend/utils/dashboardAggregates.js');
const { applicationParticipant, effectiveMaxAttempts } = require('../../backend/utils/examApplications.js');
const handlers = require('../../backend/utils/studentDataHandlers.js');
const { buildStudentDataExport } = require('../../backend/utils/studentDataExport.js');

let app;
const adminToken = 'admin-token-participants';
const otherProfessorToken = 'professor-token-participants';
const studentClass = '2DES';
const otherClass = '3DES';
const courseId = 'curso-participantes';
const examKey = 'Avaliacao_Participantes';
const ALICE = 'alice@participantes.local';
const BRUNO = 'bruno@participantes.local';
const CARLA = 'carla@participantes.local';
const DIEGO = 'diego@outra-turma.local';
const TOKENS = { [ALICE]: 'token-alice', [BRUNO]: 'token-bruno', [CARLA]: 'token-carla', [DIEGO]: 'token-diego' };

const admin = req => req.set('x-admin-session', adminToken);
const asStudent = (req, email) => req.set('x-session-token', TOKENS[email]);

function seed() {
    db.memory.admins = [
        { email: 'admin@participantes.local', name: 'Admin', role: 'admin', password: db.hashPassword('senha-administrativa') },
        { email: 'prof@outra.local', name: 'Prof Outra', role: 'professor', password: db.hashPassword('senha-professor-x'), assignedClasses: [{ courseId, className: otherClass }] },
    ];
    db.memory.adminSessions = {
        [adminToken]: { email: 'admin@participantes.local', createdAt: Date.now(), lastSeen: Date.now() },
        [otherProfessorToken]: { email: 'prof@outra.local', createdAt: Date.now(), lastSeen: Date.now() },
    };
    const student = (name, email, cls = studentClass) => ({ name, email, status: 'Ativo', classes: [{ name: cls, courseId }] });
    db.memory.students = [
        student('Alice Souza', ALICE),
        student('Bruno Lima', BRUNO),
        student('Carla Dias', CARLA),
        student('Diego Reis', DIEGO, otherClass),
    ];
    db.memory.sessions = Object.fromEntries(Object.entries(TOKENS).map(([email, token]) => [email, { token, lastSeen: Date.now(), ip: '127.0.0.1' }]));
    db.memory.courses = [{ id: courseId, structure: [{ name: 'Módulo', units: [{ avaliacaoKey: examKey }] }] }];
    db.memory.classes = [
        { name: studentClass, courseId, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} },
        { name: otherClass, courseId, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} },
    ];
    db.memory.evaluations = {
        [examKey]: {
            key: examKey,
            title: 'Prova de participantes',
            questions: [{
                number: 1,
                text: 'Questão única',
                correctAnswer: 'A',
                alternatives: [{ letter: 'A', text: 'Certa', isCorrect: true }, { letter: 'B', text: 'Errada', isCorrect: false }],
            }],
        },
    };
    db.memory.submissions = [];
    db.memory.examApplications = [];
    db.memory.studentExamState = {};
    db.memory.proctoringLogs = [];
    db.memory.broadcastMessages = [];
    db.memory.auditLogs = [];
    db.memory.classGroups = [];
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

async function createHistory() {
    const response = await admin(request(app).post('/api/admin/exam-history/add')).send({
        studentClass, courseId, examKey, type: 'online', questionNumbers: [1],
        printSnapshot: [{ version: 'A', questions: [{ originalNumber: 1, text: 'Questão única', alternatives: [{ letter: 'A', text: 'Certa' }, { letter: 'B', text: 'Errada' }] }] }],
        durationMinutes: 30, waitingRoomMinutes: 0, maxAttempts: 1,
    }).expect(200);
    return response.body.entry.id;
}

async function prepare(historyId, options = {}, expected = 201) {
    return admin(request(app).post('/api/admin/exam-applications')).send({
        studentClass, courseId, examKey, historyId,
        applicationOptions: { timerMode: 'per_attempt', waitingRoomMinutes: 0, maxAttempts: 1, ...options },
    }).expect(expected);
}

async function start(applicationId) {
    const started = await admin(request(app).post(`/api/admin/exam-applications/${applicationId}/control`)).send({ action: 'start' }).expect(200);
    return started.body.application;
}

async function finish(applicationId) {
    await admin(request(app).post(`/api/admin/exam-applications/${applicationId}/control`)).send({ action: 'finish', inProgressPolicy: 'discard' }).expect(200);
}

function sync(email, applicationId) {
    return asStudent(request(app).get('/api/student/sync'), email).query({ email, studentClass, courseId, examKey, applicationId });
}

function startAttempt(email, applicationId) {
    return asStudent(request(app).post(`/api/student/exam-applications/${applicationId}/start-attempt`), email).send({});
}

async function deliver(email, applicationId) {
    await sync(email, applicationId).expect(200);
    const started = await startAttempt(email, applicationId).expect(200);
    const response = await asStudent(request(app).post('/api/student/submit'), email).send({
        studentClass, courseId, examKey, applicationId, attemptId: started.body.attemptId,
        answers: {}, questionNumbers: [1], examConfigVersion: started.body.examConfigVersion,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response;
}

// Aplicação regular aplicada e encerrada em que só a Alice entregou.
async function regularDoneByAlice(historyId) {
    const prepared = await prepare(historyId);
    const regular = await start(prepared.body.application.id);
    await deliver(ALICE, regular.id);
    await finish(regular.id);
    return regular;
}

test('[UC-PROVA-006] segunda chamada: a lista vem com quem não fez; os outros não veem, não sincronizam, não começam e não contam como ausentes', async () => {
    const historyId = await createHistory();
    const regular = await regularDoneByAlice(historyId);

    // A lista pré-marcada da tela: quem não tem entrega que conta numa aplicação regular.
    const candidates = await admin(request(app).get('/api/admin/exam-applications/participant-candidates'))
        .query({ studentClass, courseId, examKey }).expect(200);
    assert.deepEqual(candidates.body.segundaChamada.sort(), [BRUNO, CARLA]);
    assert.equal(candidates.body.students.find(item => item.email === ALICE).fezRegular, true);
    assert.equal(candidates.body.students.some(item => item.email === DIEGO), false, 'aluno de outra turma não aparece');

    // Segunda chamada sem lista: o servidor monta a mesma lista.
    const prepared = await prepare(historyId, { finalidade: 'segunda_chamada' });
    const second = prepared.body.application;
    assert.equal(second.finalidade, 'segunda_chamada');
    assert.deepEqual([...second.participants].sort(), [BRUNO, CARLA]);
    const audit = db.memory.auditLogs.find(entry => entry.type === 'exam_application_participants_set' && entry.applicationId === second.id);
    assert.ok(audit, 'a preparação da segunda chamada grava a auditoria');
    assert.equal(audit.details.quantidade, 2);
    assert.equal(audit.details.finalidade, 'segunda_chamada');
    assert.doesNotMatch(JSON.stringify(audit), /bruno@|carla@/, 'a auditoria não leva a lista de e-mails');
    await start(second.id);

    // Alice (fora da lista): não vê a aplicação, não recebe o sino, não sincroniza nem começa.
    const aliceList = await asStudent(request(app).get('/api/student/exam-applications'), ALICE).query({ studentClass, courseId }).expect(200);
    assert.equal(aliceList.body.applications.some(item => item.id === second.id), false);
    const aliceBell = await asStudent(request(app).get('/api/student/notifications'), ALICE).query({ studentClass, courseId }).expect(200);
    assert.equal((aliceBell.body.items || []).some(item => item.id === `prova:${second.id}`), false);
    const aliceSync = await sync(ALICE, second.id).expect(403);
    assert.equal(aliceSync.body.code, 'not_participant');
    assert.match(aliceSync.body.error, /segunda chamada/);
    // Sem applicationId a turma aponta para a segunda chamada: também recusa, sem criar nada.
    await asStudent(request(app).get('/api/student/sync'), ALICE).query({ email: ALICE, studentClass, courseId, examKey }).expect(403);
    const aliceStart = await startAttempt(ALICE, second.id).expect(403);
    assert.equal(aliceStart.body.notParticipant, true);
    assert.equal(Object.values(db.memory.studentExamState).some(state => state.applicationId === second.id && state.studentEmail === ALICE), false, 'nenhuma tentativa criada para quem não está na lista');

    // Bruno (na lista): vê, recebe o sino e começa.
    const brunoList = await asStudent(request(app).get('/api/student/exam-applications'), BRUNO).query({ studentClass, courseId }).expect(200);
    const brunoApp = brunoList.body.applications.find(item => item.id === second.id);
    assert.ok(brunoApp);
    assert.equal(brunoApp.finalidade, 'segunda_chamada');
    assert.equal(brunoApp.participants, undefined, 'o aluno não recebe a lista dos outros');
    const brunoBell = await asStudent(request(app).get('/api/student/notifications'), BRUNO).query({ studentClass, courseId }).expect(200);
    assert.equal((brunoBell.body.items || []).some(item => item.id === `prova:${second.id}`), true);
    await sync(BRUNO, second.id).expect(200);
    await startAttempt(BRUNO, second.id).expect(200);

    // Monitor: só Bruno e Carla; Alice não é "ausente".
    const monitor = await admin(request(app).get(`/api/admin/monitor-status/${encodeURIComponent(studentClass)}/${examKey}`)).query({ courseId, applicationId: second.id }).expect(200);
    assert.deepEqual(monitor.body.map(row => row.email).sort(), [BRUNO, CARLA]);
    // Encerramento: "ainda não iniciaram" conta só a Carla (Alice está fora da lista).
    assert.equal(finishSummary(db.memory, db.memory.examApplications.find(item => item.id === second.id)).waitingToStart, 1);
    // Troca de senha: a Alice não está em prova por causa da segunda chamada.
    assert.equal(studentHasExamInProgress(db.memory, ALICE), false);
    assert.equal(studentHasExamInProgress(db.memory, CARLA), true);
    // Dashboard: o total da aplicação ativa é o da lista.
    const cls = db.memory.classes.find(item => item.name === studentClass);
    const now = computeNow({ memory: db.memory, cls, course: db.memory.courses[0], students: db.memory.students.filter(item => item.classes[0].name === studentClass), today: '2026-11-19', nowMin: 600, now: Date.now() });
    assert.equal(now.aplicacao.id, second.id);
    assert.equal(now.aplicacao.total, 2);
    assert.equal(now.aplicacao.entregues, 0, 'a entrega da Alice na regular não conta na segunda chamada');

    // A regular continua da turma inteira.
    assert.equal(applicationParticipant(db.memory.examApplications.find(item => item.id === regular.id), CARLA), true);
});

test('[UC-PROVA-006] segunda chamada com token: quem não está na lista acerta o token e mesmo assim não abre tentativa', async () => {
    const historyId = await createHistory();
    await regularDoneByAlice(historyId);
    const prepared = await prepare(historyId, { finalidade: 'segunda_chamada', tokenEnabled: true, accessToken: 'ABCDE' });
    const second = await start(prepared.body.application.id);
    const body = email => ({ email, studentClass, courseId, examKey, applicationId: second.id, token: 'ABCDE' });
    const alice = await asStudent(request(app).post('/api/student/validate-exam-token'), ALICE).send(body(ALICE)).expect(403);
    assert.equal(alice.body.code, 'not_participant');
    assert.equal(Object.values(db.memory.studentExamState).some(state => state.applicationId === second.id && state.studentEmail === ALICE), false);
    const bruno = await asStudent(request(app).post('/api/student/validate-exam-token'), BRUNO).send(body(BRUNO)).expect(200);
    assert.equal(bruno.body.valid, true);
    await startAttempt(BRUNO, second.id).expect(200);
});

test('[UC-PROVA-006] lista pré-marcada: entrega arquivada não conta como feita, a da segunda chamada não vira regular e "todos já fizeram" é recusado', async () => {
    const historyId = await createHistory();
    const regular = await regularDoneByAlice(historyId);
    const aliceDelivery = db.memory.submissions.find(item => item.applicationId === regular.id);
    aliceDelivery.resultStatus = 'archived';
    let candidates = await admin(request(app).get('/api/admin/exam-applications/participant-candidates')).query({ studentClass, courseId, examKey }).expect(200);
    assert.deepEqual(candidates.body.segundaChamada.sort(), [ALICE, BRUNO, CARLA], 'a entrega arquivada não conta como feita');
    aliceDelivery.resultStatus = 'active';

    // Entrega numa segunda chamada não conta como "fez a regular".
    db.memory.submissions.push({ id: 'sub_2a', examKey, applicationId: 'app_segunda_antiga', student: { email: BRUNO, studentClass, courseId }, score: 50 });
    db.memory.examApplications.push({ id: 'app_segunda_antiga', examKey, studentClass, courseId, status: 'finished', finalidade: 'segunda_chamada', participants: [BRUNO] });
    candidates = await admin(request(app).get('/api/admin/exam-applications/participant-candidates')).query({ studentClass, courseId, examKey }).expect(200);
    assert.deepEqual(candidates.body.segundaChamada.sort(), [BRUNO, CARLA]);
    // Mas a tela avisa: numa nova segunda chamada, o Bruno aparece com "Fez a segunda
    // chamada" (continua marcado; a Carla e a Alice não têm o aviso).
    const flags = Object.fromEntries(candidates.body.students.map(item => [item.email, item.fezSegundaChamada]));
    assert.deepEqual(flags, { [ALICE]: false, [BRUNO]: true, [CARLA]: false });
    // A própria aplicação (Alunos desta aplicação) não conta como anterior.
    const own = await admin(request(app).get('/api/admin/exam-applications/participant-candidates')).query({ applicationId: 'app_segunda_antiga' }).expect(200);
    assert.equal(own.body.students.find(item => item.email === BRUNO).fezSegundaChamada, false);

    // Todos já fizeram: a segunda chamada sem lista é recusada.
    db.memory.submissions.push(
        { id: 'sub_b', examKey, applicationId: regular.id, student: { email: BRUNO, studentClass, courseId }, score: 10 },
        { id: 'sub_c', examKey, applicationId: regular.id, student: { email: CARLA, studentClass, courseId }, score: 10 },
    );
    const refused = await prepare(historyId, { finalidade: 'segunda_chamada' }, 400);
    assert.match(refused.body.error, /já fizeram/);
});

test('[UC-PROVA-006] lista pré-marcada vale para a família da prova: a regular na prova do curso conta na segunda chamada da variante "só desta turma" e vice-versa', async () => {
    const historyId = await createHistory();
    await regularDoneByAlice(historyId);
    // O professor editou a prova só para a turma depois da regular: nasce a variante.
    const variant = `${examKey}__turma_abc123`;
    db.memory.evaluations[variant] = { ...db.memory.evaluations[examKey], key: variant, sourceEvaluationKey: examKey };
    const candidates = await admin(request(app).get('/api/admin/exam-applications/participant-candidates'))
        .query({ studentClass, courseId, examKey: variant }).expect(200);
    assert.deepEqual(candidates.body.segundaChamada.sort(), [BRUNO, CARLA], 'quem fez na prova do curso não volta marcado');
    assert.equal(candidates.body.students.find(item => item.email === ALICE).fezRegular, true, 'a Alice aparece com "Já fez"');

    // O contrário: a regular foi na variante (vínculo pelo mapa da turma) e a segunda
    // chamada é preparada na prova do curso.
    delete db.memory.evaluations[variant].sourceEvaluationKey;
    db.memory.classes.find(item => item.name === studentClass).contentOverrides = { evaluations: { [examKey]: variant } };
    db.memory.submissions.push({ id: 'sub_variante', examKey: variant, applicationId: 'app_variante', student: { email: BRUNO, studentClass, courseId }, score: 70 });
    db.memory.examApplications.push({ id: 'app_variante', examKey: variant, studentClass, courseId, status: 'finished' });
    const base = await admin(request(app).get('/api/admin/exam-applications/participant-candidates'))
        .query({ studentClass, courseId, examKey }).expect(200);
    assert.deepEqual(base.body.segundaChamada, [CARLA]);

    // Prova sem parentesco não entra: a entrega de outra prova não conta.
    db.memory.submissions.push({ id: 'sub_outra', examKey: 'Avaliacao_Outra', applicationId: 'app_outra', student: { email: CARLA, studentClass, courseId }, score: 70 });
    db.memory.examApplications.push({ id: 'app_outra', examKey: 'Avaliacao_Outra', studentClass, courseId, status: 'finished' });
    const again = await admin(request(app).get('/api/admin/exam-applications/participant-candidates'))
        .query({ studentClass, courseId, examKey }).expect(200);
    assert.deepEqual(again.body.segundaChamada, [CARLA]);
});

test('[UC-PROVA-006] alunos escolhidos: e-mail de fora da turma, lista vazia e finalidade inválida são recusados; a recuperação é gravada', async () => {
    const historyId = await createHistory();
    const outside = await prepare(historyId, { participants: [BRUNO, DIEGO] }, 400);
    assert.match(outside.body.error, /não é aluno ativo desta turma/);
    assert.equal(outside.body.field, 'applicationOptions.participants');
    const empty = await prepare(historyId, { participants: [] }, 400);
    assert.match(empty.body.error, /pelo menos um aluno/);
    await prepare(historyId, { finalidade: 'outra' }, 400);
    await prepare(historyId, { participants: 'todos' }, 400);
    assert.equal(db.memory.examApplications.length, 0, 'nada é preparado com o pedido recusado');

    const chosen = await prepare(historyId, { participants: ['Bruno@Participantes.local'] });
    assert.deepEqual(chosen.body.application.participants, [BRUNO], 'e-mail minúsculo');
    assert.equal(chosen.body.application.finalidade, 'regular');
    // Recuperação: o servidor grava (a tela esconde até a J2, D17).
    const recovery = await prepare(historyId, { finalidade: 'recuperacao', participants: [CARLA] });
    assert.equal(recovery.body.application.finalidade, 'recuperacao');
});

test('[UC-PROVA-006] tentativa extra: só o aluno da exceção faz maxAttempts + 1', async () => {
    const historyId = await createHistory();
    const prepared = await prepare(historyId, {
        studentOverrides: { [BRUNO]: { extraAttempts: 1, motivo: 'Faltou luz na sala' } },
    });
    const application = prepared.body.application;
    assert.equal(application.studentOverrides[BRUNO].extraAttempts, 1);
    assert.equal(application.studentOverrides[BRUNO].por, 'admin@participantes.local');
    const granted = db.memory.auditLogs.filter(entry => entry.type === 'exam_attempt_extra_granted');
    assert.equal(granted.length, 1);
    assert.equal(granted[0].studentEmail, BRUNO);
    assert.equal(granted[0].details.extraAttempts, 1);
    await start(application.id);

    await deliver(BRUNO, application.id);
    await deliver(CARLA, application.id);
    const brunoSync = await sync(BRUNO, application.id).expect(200);
    assert.equal(brunoSync.body.maxAttempts, 2);
    assert.equal(brunoSync.body.attemptsUsed, 1);
    // Bruno faz a segunda tentativa; a entrega dela é aceita.
    const second = await startAttempt(BRUNO, application.id).expect(200);
    assert.equal(second.body.attemptNumber, 2);
    await asStudent(request(app).post('/api/student/submit'), BRUNO).send({
        studentClass, courseId, examKey, applicationId: application.id, attemptId: second.body.attemptId,
        answers: {}, questionNumbers: [1], examConfigVersion: second.body.examConfigVersion,
    }).expect(200);
    await startAttempt(BRUNO, application.id).expect(403);

    // Carla, sem exceção, continua com uma.
    const carlaSync = await sync(CARLA, application.id).expect(200);
    assert.equal(carlaSync.body.maxAttempts, 1);
    const carla = await startAttempt(CARLA, application.id).expect(403);
    assert.equal(carla.body.attemptsExhausted, true);

    const monitor = await admin(request(app).get(`/api/admin/monitor-status/${encodeURIComponent(studentClass)}/${examKey}`)).query({ courseId, applicationId: application.id }).expect(200);
    assert.equal(monitor.body.find(row => row.email === BRUNO).maxAttempts, 2);
    assert.equal(monitor.body.find(row => row.email === CARLA).maxAttempts, 1);
    const appRecord = db.memory.examApplications.find(item => item.id === application.id);
    assert.equal(effectiveMaxAttempts(appRecord, ALICE), 1);
});

test('[UC-PROVA-006] prazo para começar: vencido recusa o início; prazo no passado ou com cronômetro coletivo é recusado na preparação', async () => {
    const historyId = await createHistory();
    const past = await prepare(historyId, { studentOverrides: { [BRUNO]: { prazoAte: Date.now() - 60000 } } }, 400);
    assert.match(past.body.error, /depois de agora/);
    const collective = await prepare(historyId, { timerMode: 'collective', studentOverrides: { [BRUNO]: { prazoAte: Date.now() + 3600000 } } }, 400);
    assert.match(collective.body.error, /cronômetro/);

    const prepared = await prepare(historyId, { studentOverrides: { [BRUNO]: { prazoAteLocal: '2099-12-01T08:00' } } });
    const application = prepared.body.application;
    assert.ok(application.studentOverrides[BRUNO].prazoAte > Date.now());
    await start(application.id);
    // A lista e o sync levam o prazo do próprio aluno, no relógio da escola, para as telas
    // dele (cartão da prova e instruções); quem não tem prazo recebe null.
    const brunoList = await asStudent(request(app).get('/api/student/exam-applications'), BRUNO).query({ studentClass, courseId }).expect(200);
    const brunoItem = brunoList.body.applications.find(item => item.id === application.id);
    assert.equal(brunoItem.startDeadlineAt, application.studentOverrides[BRUNO].prazoAte);
    assert.equal(brunoItem.startDeadlineLabel, '01/12 às 08:00');
    const carlaList = await asStudent(request(app).get('/api/student/exam-applications'), CARLA).query({ studentClass, courseId }).expect(200);
    assert.equal(carlaList.body.applications.find(item => item.id === application.id).startDeadlineLabel, null);
    const brunoBefore = await sync(BRUNO, application.id).expect(200);
    assert.equal(brunoBefore.body.startDeadlineLabel, '01/12 às 08:00');
    assert.equal(brunoBefore.body.startDeadlinePassed, false);
    // "Alunos desta aplicação" mostra o prazo atual no relógio da escola.
    const candidates = await admin(request(app).get('/api/admin/exam-applications/participant-candidates')).query({ applicationId: application.id }).expect(200);
    assert.equal(candidates.body.students.find(item => item.email === BRUNO).override.prazoAteLabel, '01/12 às 08:00');
    assert.equal(candidates.body.students.find(item => item.email === CARLA).override, null);
    // O prazo passou (o relógio andou).
    db.memory.examApplications.find(item => item.id === application.id).studentOverrides[BRUNO].prazoAte = Date.now() - 1000;

    const synced = await sync(BRUNO, application.id).expect(200);
    assert.equal(synced.body.startDeadlinePassed, true);
    assert.match(synced.body.startDeadlineMessage, /prazo para começar/);
    // O sync de antes do prazo já criou a tentativa nas instruções; depois do prazo ela não começa.
    assert.equal(Object.values(db.memory.studentExamState).some(state => state.applicationId === application.id && state.studentEmail === BRUNO && state.startedAt), false, 'nenhuma tentativa começa depois do prazo');
    const refused = await startAttempt(BRUNO, application.id).expect(409);
    assert.equal(refused.body.code, 'start_deadline_passed');
    // A Carla, sem prazo, começa normalmente.
    await sync(CARLA, application.id).expect(200);
    await startAttempt(CARLA, application.id).expect(200);
});

test('[UC-PROVA-006] prazo para começar: quem começou antes do prazo continua depois dele, sem aviso de prazo terminado', async () => {
    const historyId = await createHistory();
    const prepared = await prepare(historyId, { studentOverrides: { [BRUNO]: { prazoAteLocal: '2099-12-01T08:00' } } });
    const application = await start(prepared.body.application.id);
    await sync(BRUNO, application.id).expect(200);
    const started = await startAttempt(BRUNO, application.id).expect(200);
    // O prazo passa com a tentativa dele aberta (o relógio andou).
    db.memory.examApplications.find(item => item.id === application.id).studentOverrides[BRUNO].prazoAte = Date.now() - 1000;

    // A lista e o sync não dizem mais que o prazo terminou: ele começou antes.
    const list = await asStudent(request(app).get('/api/student/exam-applications'), BRUNO).query({ studentClass, courseId }).expect(200);
    const item = list.body.applications.find(entry => entry.id === application.id);
    assert.equal(item.startDeadlineAt, null);
    assert.equal(item.startDeadlineLabel, null);
    assert.equal(item.attemptsExhausted, false);
    const synced = await sync(BRUNO, application.id).expect(200);
    assert.equal(synced.body.startDeadlinePassed, false);
    assert.equal(synced.body.startDeadlineMessage, null);
    assert.equal(synced.body.startDeadlineLabel, null);
    assert.equal(synced.body.attemptId, started.body.attemptId);
    // Voltar ao início continua a mesma tentativa, e a entrega é aceita.
    const again = await startAttempt(BRUNO, application.id).expect(200);
    assert.equal(again.body.attemptId, started.body.attemptId);
    await asStudent(request(app).post('/api/student/submit'), BRUNO).send({
        studentClass, courseId, examKey, applicationId: application.id, attemptId: started.body.attemptId,
        answers: {}, questionNumbers: [1], examConfigVersion: started.body.examConfigVersion,
    }).expect(200);
});

test('[UC-PROVA-006] rota de participantes: acrescenta em andamento, não tira, recusa aplicação encerrada, outra turma e e-mail de fora, com auditoria', async () => {
    const historyId = await createHistory();
    const prepared = await prepare(historyId, { participants: [BRUNO] });
    const id = prepared.body.application.id;
    const route = `/api/admin/exam-applications/${id}/participants`;

    // Preparada: dá para trocar a lista e a finalidade.
    let changed = await admin(request(app).post(route)).send({ finalidade: 'segunda_chamada', participants: [BRUNO, CARLA] }).expect(200);
    assert.deepEqual(changed.body.application.participants, [BRUNO, CARLA]);
    const unchanged = await admin(request(app).post(route)).send({ participants: [BRUNO, CARLA] }).expect(200);
    assert.equal(unchanged.body.unchanged, true);
    await start(id);

    // Em andamento: tirar é recusado, acrescentar passa; a finalidade não muda mais.
    const removing = await admin(request(app).post(route)).send({ participants: [BRUNO] }).expect(400);
    assert.match(removing.body.error, /só dá para acrescentar/);
    await admin(request(app).post(route)).send({ finalidade: 'regular' }).expect(400);
    await admin(request(app).post(route)).send({ participants: [BRUNO, CARLA, DIEGO] }).expect(400);
    changed = await admin(request(app).post(route)).send({ participants: [BRUNO, CARLA, ALICE] }).expect(200);
    assert.deepEqual(changed.body.application.participants, [BRUNO, CARLA, ALICE]);
    // Alice acrescentada: agora vê e começa.
    await sync(ALICE, id).expect(200);
    await startAttempt(ALICE, id).expect(200);

    // Exceção dada no meio da prova e retirada depois.
    await admin(request(app).post(route)).send({ studentOverrides: { [CARLA]: { extraAttempts: 2, motivo: 'Passou mal' } } }).expect(200);
    assert.equal(db.memory.examApplications.find(item => item.id === id).studentOverrides[CARLA].extraAttempts, 2);
    // Pedido com outro aluno mantém a exceção de quem não veio nele (mescla).
    await admin(request(app).post(route)).send({ studentOverrides: { [BRUNO]: { extraAttempts: 1 } } }).expect(200);
    assert.equal(db.memory.examApplications.find(item => item.id === id).studentOverrides[CARLA].extraAttempts, 2);
    assert.equal(db.memory.examApplications.find(item => item.id === id).studentOverrides[BRUNO].extraAttempts, 1);
    await admin(request(app).post(route)).send({ studentOverrides: { [CARLA]: null } }).expect(200);
    assert.equal(db.memory.examApplications.find(item => item.id === id).studentOverrides[CARLA], undefined);
    assert.equal(db.memory.examApplications.find(item => item.id === id).studentOverrides[BRUNO].extraAttempts, 1);
    const extra = db.memory.auditLogs.filter(entry => entry.type === 'exam_attempt_extra_granted' && entry.studentEmail === CARLA);
    assert.equal(extra.length, 2, 'conceder e retirar ficam na auditoria');
    const sets = db.memory.auditLogs.filter(entry => entry.type === 'exam_application_participants_set' && entry.applicationId === id);
    assert.equal(sets.length, 3, 'preparar, trocar e acrescentar');
    assert.equal(sets[2].details.quantidade, 3);
    assert.equal(sets[2].details.quantidadeAntes, 2);
    // Registro da aplicação (Resultados): as linhas com título em português.
    const trail = await admin(request(app).get(`/api/admin/exam-applications/${id}/audit`)).expect(200);
    assert.ok(trail.body.entries.some(row => row.title === 'Participantes da aplicação definidos' && /Segunda chamada · 3 alunos/.test(row.detail)));
    assert.ok(trail.body.entries.some(row => row.title === 'Exceção para Carla Dias' && /2 tentativas extras/.test(row.detail)));

    // Professor de outra turma: 403. Formato errado: 400 do schema.
    await request(app).post(route).set('x-admin-session', otherProfessorToken).send({ participants: [BRUNO] }).expect(403);
    await admin(request(app).post(route)).send({ participants: [BRUNO, 42] }).expect(400);
    // Item que não é um e-mail (nome colado, duas listas numa só) para no schema.
    const pasted = await admin(request(app).post(route)).send({ participants: [BRUNO, 'Carla Dias <carla@participantes.local>'] }).expect(400);
    assert.match(pasted.body.error, /caracteres não permitidos/);
    assert.match(pasted.body.field, /^participants/);
    await admin(request(app).post(route)).send({ participants: [`${BRUNO},${CARLA}`] }).expect(400);
    await admin(request(app).post(route)).send({ studentOverrides: { [CARLA]: { extraAttempts: 9 } } }).expect(400);

    await finish(id);
    const closed = await admin(request(app).post(route)).send({ participants: [BRUNO, CARLA, ALICE] }).expect(409);
    assert.equal(closed.body.applicationClosed, true);
    assert.equal(closed.body.code, 'application_closed', 'o 409 tem code, como not_participant e start_deadline_passed');
});

test('[UC-PROVA-006] aplicação antiga sem os campos novos é da turma inteira', async () => {
    const historyId = await createHistory();
    const prepared = await prepare(historyId);
    const record = db.memory.examApplications.find(item => item.id === prepared.body.application.id);
    delete record.finalidade;
    delete record.participants;
    delete record.studentOverrides;
    await start(record.id);
    for (const email of [ALICE, BRUNO, CARLA]) {
        const list = await asStudent(request(app).get('/api/student/exam-applications'), email).query({ studentClass, courseId }).expect(200);
        const item = list.body.applications.find(entry => entry.id === record.id);
        assert.ok(item, `${email} vê a aplicação antiga`);
        assert.equal(item.finalidade, 'regular');
        assert.equal(item.maxAttempts, 1);
    }
    await sync(CARLA, record.id).expect(200);
    await startAttempt(CARLA, record.id).expect(200);
    const monitor = await admin(request(app).get(`/api/admin/monitor-status/${encodeURIComponent(studentClass)}/${examKey}`)).query({ courseId, applicationId: record.id }).expect(200);
    assert.deepEqual(monitor.body.map(row => row.email).sort(), [ALICE, BRUNO, CARLA]);
});

test('[UC-PROVA-006] lista e exceções por e-mail: troca de e-mail renomeia, anonimizar tira o aluno e Meus dados mostra a seção', async () => {
    db.memory.examApplications.push({
        id: 'app_ciclo', examKey, studentClass, courseId, status: 'finished', finalidade: 'segunda_chamada',
        participants: [BRUNO, CARLA],
        studentOverrides: { [BRUNO]: { extraAttempts: 1, prazoAte: null, motivo: 'Atestado', por: 'admin@participantes.local', em: Date.now() } },
    });
    const application = db.memory.examApplications[0];

    // Meus dados: a seção do aluno; o administrador vê também quem concedeu.
    const forStudent = buildStudentDataExport(db.memory, BRUNO, { audience: 'aluno' });
    const forAdmin = buildStudentDataExport(db.memory, BRUNO, { audience: 'admin' });
    assert.equal(forStudent.examParticipation.length, 1);
    assert.equal(forStudent.examParticipation[0].finalidadeLabel, 'Segunda chamada');
    assert.equal(forStudent.examParticipation[0].extraAttempts, 1);
    assert.equal(forStudent.examParticipation[0].concedidaPor, undefined);
    assert.equal(forAdmin.examParticipation[0].concedidaPor, 'admin@participantes.local');
    assert.equal(buildStudentDataExport(db.memory, ALICE, { audience: 'aluno' }).examParticipation, undefined, 'sem participação, sem seção');

    // Troca de e-mail pela tela do aluno.
    const novo = 'bruno.lima@participantes.local';
    handlers.renameStudentData(db.memory, BRUNO, novo);
    assert.deepEqual(application.participants, [novo, CARLA]);
    assert.ok(application.studentOverrides[novo]);
    assert.equal(application.studentOverrides[BRUNO], undefined);

    // Anonimizar: o aluno sai da lista e das exceções.
    const carla = db.memory.students.find(item => item.email === CARLA);
    handlers.anonymizeStudentData(db.memory, handlers.studentDataContext(db.memory, carla), { email: 'anon@x.invalid', name: 'Aluno anonimizado' });
    assert.deepEqual(application.participants, [novo]);
});

// Junção J1 (A3 + C1): o registro da aplicação (Resultados) não mostra o endereço interno
// do aluno sem e-mail; a exceção dele aparece pelo nome.
test('[UC-PROVA-006] [UC-IDENT-001] registro da aplicação com aluno sem e-mail não mostra o endereço interno', async () => {
    const INTERNAL = 'aluno-alu_00000000000000f2@sem-email.invalid';
    db.memory.students.push({ id: 'alu_00000000000000f2', name: 'Bruno Sem Email', email: INTERNAL, semEmail: true, matricula: 'R7', status: 'Ativo', classes: [{ name: studentClass, courseId }] });
    const historyId = await createHistory();
    const prepared = await prepare(historyId, { participants: [INTERNAL, CARLA] });
    const id = prepared.body.application.id;
    await admin(request(app).post(`/api/admin/exam-applications/${id}/participants`))
        .send({ studentOverrides: { [INTERNAL]: { extraAttempts: 1, motivo: 'Faltou luz' } } }).expect(200);
    const trail = await admin(request(app).get(`/api/admin/exam-applications/${id}/audit`)).expect(200);
    assert.ok(trail.body.entries.some(row => row.title === 'Exceção para Bruno Sem Email'));
    assert.equal(JSON.stringify(trail.body).includes('sem-email.invalid'), false, JSON.stringify(trail.body.entries));
});

// "Para quem: um grupo" (C19 / P5-S5, contrato C2 do P5): participants = os membros do
// grupo na hora da preparação; groupId só como rótulo; mudar o grupo depois não muda a
// aplicação; quem não é do grupo não faz.
test('[UC-PROVA-006] [UC-GRUPO-003] Para quem: um grupo grava os membros na preparação e o grupo como rótulo', async () => {
    const membro = email => ({ email, studentId: null, adicionadoEm: 1, adicionadoPor: 'admin@participantes.local' });
    const grupo = (id, nome, membros, extra = {}) => ({
        id, schemaVersion: 1, courseId, studentClass, nome, conjunto: 'Laboratório', tipo: 'subturma', membros: membros.map(membro),
        criadoEm: 1, criadoPor: 'admin@participantes.local', atualizadoEm: 1, atualizadoPor: 'admin@participantes.local', arquivadoEm: null, arquivadoPor: null, ...extra,
    });
    db.memory.classGroups = [
        grupo('grp_1_aaaaaa', 'Laboratório A', [ALICE, BRUNO]),
        grupo('grp_1_bbbbbb', 'Arquivado', [CARLA], { arquivadoEm: 5 }),
        grupo('grp_1_cccccc', 'Outra turma', [DIEGO], { studentClass: otherClass }),
        grupo('grp_1_dddddd', 'Vazio', [DIEGO]),
    ];
    const candidates = await admin(request(app).get('/api/admin/exam-applications/participant-candidates')).query({ studentClass, courseId, examKey }).expect(200);
    assert.deepEqual(candidates.body.grupos.map(item => [item.id, item.membros]), [['grp_1_aaaaaa', [ALICE, BRUNO]], ['grp_1_dddddd', []]]);

    const historyId = await createHistory();
    for (const groupId of ['grp_1_bbbbbb', 'grp_1_cccccc', 'grp_inexistente']) {
        const refused = await prepare(historyId, { groupId }, 400);
        assert.equal(refused.body.field, 'applicationOptions.groupId', groupId);
    }
    const empty = await prepare(historyId, { groupId: 'grp_1_dddddd' }, 400);
    assert.match(empty.body.error, /não tem alunos ativos/);
    const second = await prepare(historyId, { groupId: 'grp_1_aaaaaa', finalidade: 'segunda_chamada' }, 400);
    assert.equal(second.body.field, 'applicationOptions.groupId');
    assert.match(second.body.error, /segunda chamada não é feita por grupo/);
    assert.equal(db.memory.examApplications.length, 0);

    // O grupo vale mais que uma lista mandada junto.
    const prepared = await prepare(historyId, { groupId: 'grp_1_aaaaaa', participants: [CARLA] });
    const application = prepared.body.application;
    assert.deepEqual(application.participants, [ALICE, BRUNO]);
    assert.equal(application.groupId, 'grp_1_aaaaaa');
    assert.equal(application.finalidade, 'regular');
    const audit = db.memory.auditLogs.filter(entry => entry.type === 'exam_application_participants_set');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].details.groupId, 'grp_1_aaaaaa');
    assert.equal(audit[0].details.grupo, 'Laboratório A');
    assert.equal(audit[0].details.quantidade, 2);

    // Mudar o grupo depois não muda quem pode fazer.
    db.memory.classGroups[0].membros.push(membro(CARLA));
    db.memory.classGroups[0].membros = db.memory.classGroups[0].membros.filter(item => item.email !== BRUNO);
    const stored = db.memory.examApplications.find(item => item.id === application.id);
    assert.deepEqual(stored.participants, [ALICE, BRUNO]);
    assert.equal(applicationParticipant(stored, BRUNO), true);
    assert.equal(applicationParticipant(stored, CARLA), false);
    const view = await admin(request(app).get('/api/admin/exam-applications/participant-candidates')).query({ applicationId: application.id }).expect(200);
    assert.deepEqual(view.body.application.grupo, { id: 'grp_1_aaaaaa', nome: 'Laboratório A', conjunto: 'Laboratório', arquivado: false });
    assert.equal(view.body.application.groupId, 'grp_1_aaaaaa');

    // Rota de participantes: escolher o grupo de novo pega os membros de agora; uma lista
    // própria tira o rótulo.
    const again = await admin(request(app).post(`/api/admin/exam-applications/${application.id}/participants`)).send({ groupId: 'grp_1_aaaaaa' }).expect(200);
    assert.deepEqual(again.body.application.participants, [ALICE, CARLA]);
    assert.equal(again.body.application.grupo.nome, 'Laboratório A');
    const own = await admin(request(app).post(`/api/admin/exam-applications/${application.id}/participants`)).send({ participants: [ALICE] }).expect(200);
    assert.equal(own.body.application.groupId, null);
    assert.equal(own.body.application.grupo, undefined);
    const whole = await admin(request(app).post(`/api/admin/exam-applications/${application.id}/participants`)).send({ groupId: 'grp_1_aaaaaa' }).expect(200);
    assert.equal(whole.body.application.groupId, 'grp_1_aaaaaa');
    const all = await admin(request(app).post(`/api/admin/exam-applications/${application.id}/participants`)).send({ participants: null }).expect(200);
    assert.equal(all.body.application.participants, null);
    assert.equal(all.body.application.groupId, null);
});

// Rodada de ajuste do C19: a nova aplicação trava o gabarito liberado para um grupo
// tirando a chave do mapa do grupo (D18: o grupo só guarda liberação). Antes ela gravava
// false ali, e esse false passava por cima do true da turma: liberado de novo para a turma
// depois da nova aplicação, os membros do grupo continuavam sem o gabarito e o painel não
// mostrava nada para desfazer.
test('[UC-GRUPO-003] nova aplicação trava o gabarito liberado para um grupo sem deixar bloqueio: a turma libera de novo e todos veem', async () => {
    const GROUP = 'grp_1_aaaaaa';
    db.memory.classGroups = [{
        id: GROUP, schemaVersion: 1, courseId, studentClass, nome: 'Laboratório A', conjunto: 'Laboratório', tipo: 'subturma',
        membros: [{ email: ALICE, studentId: null, adicionadoEm: 1, adicionadoPor: 'admin@participantes.local' }],
        criadoEm: 1, criadoPor: 'admin@participantes.local', atualizadoEm: 1, atualizadoPor: 'admin@participantes.local', arquivadoEm: null, arquivadoPor: null,
    }];
    const answerKey = `Gabarito_${examKey}`;
    const releaseKey = extra => admin(request(app).post('/api/admin/release-item')).send({ studentClass, courseId, itemKey: answerKey, released: true, ...extra });
    const seenBy = async email => {
        const res = await asStudent(request(app).get('/api/status'), email).query({ studentClass, courseId }).expect(200);
        return res.body.releasedItems[answerKey];
    };
    const historyId = await createHistory();
    const first = await prepare(historyId);
    await start(first.body.application.id);
    await finish(first.body.application.id);
    await releaseKey({ groupId: GROUP }).expect(200);
    await releaseKey({}).expect(200);
    assert.equal(await seenBy(ALICE), true);
    assert.equal(await seenBy(BRUNO), true);

    // Nova aplicação: o gabarito volta a ficar bloqueado para todos, e o mapa do grupo
    // fica sem a chave (nada de false guardado).
    const second = await prepare(historyId);
    const cls = db.memory.classes.find(item => item.name === studentClass);
    assert.equal(cls.releasedItems[answerKey], false);
    assert.deepEqual(cls.groupReleasedItems || {}, {}, 'o grupo que ficou vazio sai do mapa');
    await start(second.body.application.id);
    assert.equal(await seenBy(ALICE), false);
    assert.equal(await seenBy(BRUNO), false);
    await finish(second.body.application.id);
    assert.equal(await seenBy(ALICE), false, 'encerrada, continua bloqueado até o professor liberar');

    // A turma libera de novo: o membro do grupo vê como todo mundo.
    await releaseKey({}).expect(200);
    assert.equal(await seenBy(ALICE), true);
    assert.equal(await seenBy(BRUNO), true);
    const panel = await admin(request(app).get('/api/status')).query({ studentClass, courseId }).expect(200);
    assert.deepEqual(panel.body.groupReleases, {});

    // Liberado de novo só para o grupo (com a turma bloqueada), vale para o membro.
    db.memory.classes.find(item => item.name === studentClass).releasedItems[answerKey] = false;
    await releaseKey({ groupId: GROUP }).expect(200);
    assert.equal(await seenBy(ALICE), true);
    assert.equal(await seenBy(BRUNO), false);
});
