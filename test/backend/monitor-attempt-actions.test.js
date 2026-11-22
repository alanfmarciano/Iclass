// Ações por aluno no Monitor e token que aparece de novo (fase 3, P3-S8: AVA-14; D18 e
// D19 do desenho do P3).
//
// - recolher: entrega a tentativa em andamento com as respostas salvas no servidor
//   (source 'instructor_collect'), com auditoria e registro do monitoramento;
// - reabrir (motivo obrigatório): a entrega volta para a mesma tentativa com as respostas
//   e o tempo que faltava, sem contar de novo no limite; só com a aplicação em andamento,
//   nota não publicada e entrega que guardou a tentativa;
// - tentativa_extra: soma às tentativas extras do aluno (até 5), como o "Para quem";
// - anular e desfazer ficam para o P3-S4a (A9): 400;
// - token: a preparação guarda o selo (AES-GCM com a chave do servidor), nunca o texto
//   puro no histórico; GET access-token devolve o mesmo token e grava a auditoria; o selo
//   não sai nas respostas nem na auditoria; a migração tira o token dos históricos antigos.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-attempt-actions-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { MIGRATIONS } = require('../../backend/migrations/index.js');
const { sealExamToken, unsealExamToken } = require('../../backend/utils/examToken.js');

let app;
const adminToken = 'admin-token-attempt-actions';
const otherProfessorToken = 'professor-token-attempt-actions';
const auxiliarToken = 'auxiliar-token-attempt-actions';
const studentClass = '2DES';
const otherClass = '3DES';
const courseId = 'curso-acoes';
const examKey = 'Avaliacao_Acoes';
const ALICE = 'alice@acoes.local';
const BRUNO = 'bruno@acoes.local';
const DIEGO = 'diego@outra-turma.local';
const TOKENS = { [ALICE]: 'token-alice', [BRUNO]: 'token-bruno', [DIEGO]: 'token-diego' };
const MINUTE = 60 * 1000;

const admin = req => req.set('x-admin-session', adminToken);
const otherProfessor = req => req.set('x-admin-session', otherProfessorToken);
const asStudent = (req, email) => req.set('x-session-token', TOKENS[email]);

function seed() {
    db.memory.admins = [
        { email: 'admin@acoes.local', name: 'Admin', role: 'admin', password: db.hashPassword('senha-administrativa') },
        { email: 'prof@outra.local', name: 'Prof Outra', role: 'professor', password: db.hashPassword('senha-professor-x'), assignedClasses: [{ courseId, className: otherClass }] },
        // Professor auxiliar (papel 'monitor'): acompanha a prova pelo Monitor, sem gabarito.
        { email: 'aux@acoes.local', name: 'Auxiliar', role: 'monitor', password: db.hashPassword('senha-auxiliar-x'), assignedClasses: [{ courseId, className: studentClass }] },
    ];
    db.memory.adminSessions = {
        [adminToken]: { email: 'admin@acoes.local', createdAt: Date.now(), lastSeen: Date.now() },
        [otherProfessorToken]: { email: 'prof@outra.local', createdAt: Date.now(), lastSeen: Date.now() },
        [auxiliarToken]: { email: 'aux@acoes.local', createdAt: Date.now(), lastSeen: Date.now() },
    };
    const student = (name, email, cls = studentClass) => ({ name, email, status: 'Ativo', classes: [{ name: cls, courseId }] });
    db.memory.students = [student('Alice Souza', ALICE), student('Bruno Lima', BRUNO), student('Diego Reis', DIEGO, otherClass)];
    db.memory.sessions = Object.fromEntries(Object.entries(TOKENS).map(([email, token]) => [email, { token, lastSeen: Date.now(), ip: '127.0.0.1' }]));
    db.memory.courses = [{ id: courseId, structure: [{ name: 'Módulo', units: [{ avaliacaoKey: examKey }] }] }];
    db.memory.classes = [
        { name: studentClass, courseId, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} },
        { name: otherClass, courseId, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} },
    ];
    db.memory.evaluations = {
        [examKey]: {
            key: examKey,
            title: 'Prova das ações',
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

async function createHistory(extra = {}) {
    const response = await admin(request(app).post('/api/admin/exam-history/add')).send({
        studentClass, courseId, examKey, type: 'online', questionNumbers: [1, 2], printSnapshot: SNAPSHOT,
        durationMinutes: 30, waitingRoomMinutes: 0, maxAttempts: 1, ...extra,
    }).expect(200);
    return response.body.entry.id;
}

async function prepare(historyId, options = {}) {
    const response = await admin(request(app).post('/api/admin/exam-applications')).send({
        studentClass, courseId, examKey, historyId,
        applicationOptions: { timerMode: 'per_attempt', waitingRoomMinutes: 0, maxAttempts: 1, ...options },
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response;
}

async function start(applicationId) {
    const started = await admin(request(app).post(`/api/admin/exam-applications/${applicationId}/control`)).send({ action: 'start' }).expect(200);
    return started.body.application;
}

async function running(options = {}) {
    const historyId = await createHistory();
    const prepared = await prepare(historyId, options);
    return start(prepared.body.application.id);
}

function sync(email, applicationId) {
    return asStudent(request(app).get('/api/student/sync'), email).query({ email, studentClass, courseId, examKey, applicationId });
}

function startAttempt(email, applicationId) {
    return asStudent(request(app).post(`/api/student/exam-applications/${applicationId}/start-attempt`), email).send({});
}

async function begin(email, applicationId) {
    await sync(email, applicationId).expect(200);
    const started = await startAttempt(email, applicationId);
    assert.equal(started.status, 200, JSON.stringify(started.body));
    return started.body;
}

function openState(email, applicationId) {
    return Object.values(db.memory.studentExamState).find(state => state.applicationId === applicationId && state.studentEmail === email && state.status !== 'submitted');
}

async function submit(email, applicationId, started, answers = {}) {
    const response = await asStudent(request(app).post('/api/student/submit'), email).send({
        studentClass, courseId, examKey, applicationId, attemptId: started.attemptId,
        answers, questionNumbers: [1, 2], examConfigVersion: started.examConfigVersion,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response;
}

function action(applicationId, body, as = admin) {
    return as(request(app).post(`/api/admin/exam-applications/${applicationId}/attempt-action`)).send(body);
}

function deliveries(applicationId, email) {
    return db.memory.submissions.filter(item => item.applicationId === applicationId && item.student.email === email);
}

async function monitorRow(applicationId, email) {
    const monitor = await admin(request(app).get(`/api/admin/monitor-status/${encodeURIComponent(studentClass)}/${examKey}`)).query({ courseId, applicationId }).expect(200);
    return monitor.body.find(row => row.email === email);
}

test('[UC-TENTATIVA-004] recolher entrega a tentativa em andamento com as respostas salvas, com auditoria e registro', async () => {
    const application = await running();
    const started = await begin(ALICE, application.id);
    // O que o autosave guardou no servidor (as respostas da tentativa).
    openState(ALICE, application.id).answers = { 1: 'A' };

    const collected = await action(application.id, { action: 'recolher', studentEmail: ALICE.toUpperCase(), motivo: 'Saiu da sala' }).expect(200);
    assert.equal(collected.body.success, true);
    assert.equal(collected.body.submission.answeredCount, 1);
    assert.equal(collected.body.application.accessTokenSealed, undefined);

    const [delivery] = deliveries(application.id, ALICE);
    assert.equal(delivery.submissionSource, 'instructor_collect');
    assert.equal(delivery.attemptId, started.attemptId);
    assert.equal(delivery.collectedBy, 'admin@acoes.local');
    assert.ok(delivery.reopenableState && delivery.reopenableState.startedAt, 'a entrega recolhida pode ser reaberta');
    assert.equal(openState(ALICE, application.id), undefined, 'a tentativa não fica aberta');

    const audit = db.memory.auditLogs.find(entry => entry.type === 'exam_attempt_collected');
    assert.ok(audit, 'recolher grava exam_attempt_collected');
    assert.equal(audit.applicationId, application.id);
    assert.equal(audit.studentEmail, ALICE);
    assert.equal(audit.details.motivo, 'Saiu da sala');
    assert.equal(audit.details.answeredCount, 1);
    const log = db.memory.proctoringLogs.find(entry => entry.eventType === 'attempt_collected');
    assert.ok(log && log.studentEmail === ALICE && log.applicationId === application.id);
    const trail = await admin(request(app).get(`/api/admin/exam-applications/${application.id}/audit`)).expect(200);
    const collectedRow = trail.body.entries.find(entry => entry.id === audit.id);
    assert.equal(collectedRow.title, 'Prova de Alice Souza recolhida pelo professor');
    assert.equal(collectedRow.detail, '1 resposta salva · motivo: Saiu da sala');

    // O aluno vê a prova entregue e não recebe quem recolheu.
    const studentView = await sync(ALICE, application.id).expect(200);
    assert.doesNotMatch(JSON.stringify(studentView.body), /collectedBy/);

    // Sem tentativa aberta: nada para recolher.
    const again = await action(application.id, { action: 'recolher', studentEmail: ALICE }).expect(409);
    assert.equal(again.body.code, 'no_open_attempt');
    const nobody = await action(application.id, { action: 'recolher', studentEmail: BRUNO }).expect(409);
    assert.equal(nobody.body.code, 'no_open_attempt');
});

test('[UC-TENTATIVA-004] recolher tentativa vencida entrega pelo fim do tempo (409 attemptFinalized)', async () => {
    const application = await running();
    await begin(ALICE, application.id);
    const state = openState(ALICE, application.id);
    state.startedAt = Date.now() - 31 * MINUTE;
    state.deadlineAt = Date.now() - MINUTE;
    const response = await action(application.id, { action: 'recolher', studentEmail: ALICE }).expect(409);
    assert.equal(response.body.code, 'attempt_finalized');
    assert.equal(response.body.attemptFinalized, true);
    assert.notEqual(deliveries(application.id, ALICE)[0].submissionSource, 'instructor_collect');
});

test('[UC-TENTATIVA-004] reabrir devolve a entrega com as respostas e o tempo que faltava, e não conta no limite', async () => {
    const application = await running();
    const started = await begin(ALICE, application.id);
    await submit(ALICE, application.id, started, {});
    const [delivery] = deliveries(application.id, ALICE);
    assert.ok(delivery.reopenableState, 'o "Enviar" do aluno com a aplicação em andamento guarda a tentativa');

    // Começou há 20 min, entregou aos 5 min (faltavam 25) e a prova é de 30: o prazo base
    // é daqui a 10 min, e a reabertura dá os 25 que faltavam (+15 min para o aluno).
    const now = Date.now();
    const startedAt = now - 20 * MINUTE;
    delivery.reopenableState.startedAt = startedAt;
    delivery.deadlineAt = startedAt + 30 * MINUTE;
    delivery.timestamp = new Date(startedAt + 5 * MINUTE).toISOString();
    delivery.gradedAnswers = (delivery.gradedAnswers || []).map(item => (Number(item.questionNumber) === 2 ? { ...item, answer: 'B', studentAnswer: 'B' } : item));

    const withoutReason = await action(application.id, { action: 'reabrir', studentEmail: ALICE }).expect(400);
    assert.equal(withoutReason.body.field, 'motivo');
    assert.equal(deliveries(application.id, ALICE).length, 1, 'sem motivo nada muda');

    const reopened = await action(application.id, { action: 'reabrir', studentEmail: ALICE, motivo: 'Queda de energia' }).expect(200);
    // 15 min e o que passou entre a conta do teste e a da rota (arredonda para cima).
    assert.ok([15, 16].includes(reopened.body.state.addedMinutes), String(reopened.body.state.addedMinutes));
    assert.equal(reopened.body.state.remainingMinutes, 25);
    const state = openState(ALICE, application.id);
    assert.ok(state, 'a tentativa volta a ficar aberta');
    assert.equal(state.attemptId, started.attemptId, 'é a mesma tentativa');
    assert.equal(state.attemptNumber, 1);
    assert.equal(state.reopenedByInstructor, true);
    assert.ok(Math.abs(state.deadlineAt - (now + 25 * MINUTE)) < MINUTE + 5000, `prazo novo perto de agora + 25 min (${(state.deadlineAt - now) / MINUTE} min)`);
    assert.equal(deliveries(application.id, ALICE).length, 0, 'a entrega sai da lista (fica guardada na tentativa)');
    assert.equal(state.reopenedDelivery.id, delivery.id);

    const audit = db.memory.auditLogs.find(entry => entry.type === 'exam_attempt_reopened_by_instructor');
    assert.ok(audit);
    assert.equal(audit.studentEmail, ALICE);
    assert.equal(audit.details.motivo, 'Queda de energia');
    assert.equal(audit.details.minutosAcrescentados, reopened.body.state.addedMinutes);
    assert.ok(db.memory.proctoringLogs.some(entry => entry.eventType === 'attempt_reopened' && entry.studentEmail === ALICE));

    const trail = await admin(request(app).get(`/api/admin/exam-applications/${application.id}/audit`)).expect(200);
    const reopenRow = trail.body.entries.find(entry => entry.id === audit.id);
    assert.equal(reopenRow.title, 'Prova de Alice Souza reaberta pelo professor');
    assert.match(reopenRow.detail, /25 min para terminar · motivo: Queda de energia/);

    const row = await monitorRow(application.id, ALICE);
    assert.equal(row.reopenedByInstructor, true);
    assert.equal(row.attemptInProgress, true);

    // O aluno vê a prova aberta de novo, com a marca da reabertura pelo professor.
    const studentSync = await sync(ALICE, application.id).expect(200);
    assert.match(JSON.stringify(studentSync.body), /"reopenedByInstructor":true/);

    // Entrega de novo: continua uma tentativa só (maxAttempts 1) e o limite não mudou.
    await submit(ALICE, application.id, { attemptId: started.attemptId, examConfigVersion: started.examConfigVersion }, {});
    const after = deliveries(application.id, ALICE);
    assert.equal(after.length, 1);
    assert.equal(after[0].attemptNumber, 1);
    assert.equal(after[0].reopenedFrom.at(-1).byInstructor, true);
    assert.equal((await monitorRow(application.id, ALICE)).reopenedByInstructor, true);
    const blocked = await startAttempt(ALICE, application.id);
    assert.notEqual(blocked.status, 200, 'a reabertura não dá tentativa a mais');
});

test('[UC-TENTATIVA-004] reabrir recusa: aplicação encerrada, nota publicada, entrega antiga, sem tempo, tentativa em andamento', async () => {
    const application = await running();
    const started = await begin(ALICE, application.id);
    await submit(ALICE, application.id, started, {});
    const [delivery] = deliveries(application.id, ALICE);
    const reabrir = email => action(application.id, { action: 'reabrir', studentEmail: email, motivo: 'Teste' });

    delivery.gradePublished = true;
    assert.equal((await reabrir(ALICE).expect(409)).body.code, 'grade_published');
    delivery.gradePublished = false;

    const snapshot = delivery.reopenableState;
    delete delivery.reopenableState;
    assert.equal((await reabrir(ALICE).expect(409)).body.code, 'not_reopenable');
    assert.equal((await monitorRow(application.id, ALICE)).canReopen, false);
    delivery.reopenableState = snapshot;
    assert.equal((await monitorRow(application.id, ALICE)).canReopen, true);

    const { timestamp } = delivery;
    delivery.timestamp = new Date(Number(delivery.deadlineAt) - 30 * 1000).toISOString();
    assert.equal((await reabrir(ALICE).expect(409)).body.code, 'no_time_left');
    delivery.timestamp = timestamp;

    assert.equal((await reabrir(BRUNO).expect(409)).body.code, 'no_delivery');
    await begin(BRUNO, application.id);
    assert.equal((await reabrir(BRUNO).expect(409)).body.code, 'no_delivery');

    await admin(request(app).post(`/api/admin/exam-applications/${application.id}/control`)).send({ action: 'finish', inProgressPolicy: 'discard' }).expect(200);
    assert.equal((await reabrir(ALICE).expect(409)).body.code, 'application_not_running');
    assert.equal(deliveries(application.id, ALICE).length, 1, 'nenhuma recusa mexe na entrega');
    assert.equal(db.memory.auditLogs.some(entry => entry.type === 'exam_attempt_reopened_by_instructor'), false);
});

test('[UC-TENTATIVA-004] reaberta pelo professor e desconsiderada no encerramento: a entrega anterior volta', async () => {
    const application = await running();
    const started = await begin(ALICE, application.id);
    await submit(ALICE, application.id, started, {});
    const [delivery] = deliveries(application.id, ALICE);
    await action(application.id, { action: 'reabrir', studentEmail: ALICE, motivo: 'Enviou sem querer' }).expect(200);
    assert.equal(deliveries(application.id, ALICE).length, 0);
    await admin(request(app).post(`/api/admin/exam-applications/${application.id}/control`)).send({ action: 'finish', inProgressPolicy: 'discard' }).expect(200);
    const [restored] = deliveries(application.id, ALICE);
    assert.ok(restored, 'a entrega de antes da reabertura volta');
    assert.equal(restored.id, delivery.id);
    assert.equal(restored.restoredAfterDiscard.byInstructor, true);
});

test('[UC-TENTATIVA-004] tentativa extra libera mais uma tentativa só para o aluno, até 5', async () => {
    const application = await running();
    const started = await begin(ALICE, application.id);
    await submit(ALICE, application.id, started, {});
    assert.notEqual((await startAttempt(ALICE, application.id)).status, 200, 'sem tentativa extra, o limite já foi atingido');

    const granted = await action(application.id, { action: 'tentativa_extra', studentEmail: ALICE, motivo: 'Passou mal' }).expect(200);
    assert.equal(granted.body.extraAttempts, 1);
    assert.equal(granted.body.maxAttempts, 2);
    const override = db.memory.examApplications.find(item => item.id === application.id).studentOverrides[ALICE];
    assert.equal(override.extraAttempts, 1);
    assert.equal(override.motivo, 'Passou mal');
    const audit = db.memory.auditLogs.find(entry => entry.type === 'exam_attempt_extra_granted');
    assert.ok(audit);
    assert.equal(audit.studentEmail, ALICE);
    assert.equal(audit.details.extraAttempts, 1);

    await sync(ALICE, application.id).expect(200);
    const second = await startAttempt(ALICE, application.id);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.attemptNumber, 2);

    // Bruno continua com uma.
    assert.equal(effectiveFor(application.id, BRUNO), undefined);

    const many = await action(application.id, { action: 'tentativa_extra', studentEmail: ALICE, extraAttempts: 5 }).expect(409);
    assert.equal(many.body.code, 'extra_limit');
    await action(application.id, { action: 'tentativa_extra', studentEmail: ALICE, extraAttempts: 4 }).expect(200);
    assert.equal(db.memory.examApplications.find(item => item.id === application.id).studentOverrides[ALICE].extraAttempts, 5);
    await action(application.id, { action: 'tentativa_extra', studentEmail: ALICE, extraAttempts: 6 }).expect(400);

    await admin(request(app).post(`/api/admin/exam-applications/${application.id}/control`)).send({ action: 'finish', inProgressPolicy: 'discard' }).expect(200);
    assert.equal((await action(application.id, { action: 'tentativa_extra', studentEmail: BRUNO }).expect(409)).body.code, 'application_closed');
});

function effectiveFor(applicationId, email) {
    const application = db.memory.examApplications.find(item => item.id === applicationId);
    return (application.studentOverrides || {})[email];
}

test('[UC-TENTATIVA-004] tentativa extra sem limite de tentativas é recusada', async () => {
    const historyId = await createHistory({ maxAttempts: null });
    const prepared = await prepare(historyId, { maxAttempts: null });
    const application = await start(prepared.body.application.id);
    const response = await action(application.id, { action: 'tentativa_extra', studentEmail: ALICE }).expect(409);
    assert.equal(response.body.code, 'unlimited_attempts');
    assert.equal(effectiveFor(application.id, ALICE), undefined);
});

test('[UC-TENTATIVA-004] ações por aluno: escopo, aluno de outra turma e ação inválida', async () => {
    const application = await running();
    await begin(ALICE, application.id);

    const foreign = await action(application.id, { action: 'recolher', studentEmail: ALICE }, otherProfessor).expect(403);
    assert.doesNotMatch(JSON.stringify(foreign.body), /alice@/);
    const outsider = await action(application.id, { action: 'tentativa_extra', studentEmail: DIEGO }).expect(404);
    assert.equal(outsider.body.field, 'studentEmail');
    await action('app_inexistente', { action: 'recolher', studentEmail: ALICE }).expect(404);
    const refused = await action(application.id, { action: 'apagar', studentEmail: ALICE }).expect(400);
    assert.equal(refused.body.field, 'action');
    // Anular e desfazer (P3-S4a) pedem motivo; sem ele, nada muda.
    for (const name of ['anular', 'desfazer_anulacao']) {
        const noReason = await action(application.id, { action: name, studentEmail: ALICE }).expect(400);
        assert.equal(noReason.body.field, 'motivo');
    }
    await action(application.id, { studentEmail: ALICE }).expect(400);
    assert.ok(openState(ALICE, application.id), 'nenhuma recusa mexe na tentativa');
    assert.equal(db.memory.auditLogs.some(entry => /exam_attempt_(collected|reopened_by_instructor|extra_granted)/.test(entry.type)), false);
});

test('[UC-TENTATIVA-004] ajuste de tempo de um aluno com motivo vai para o registro do monitoramento', async () => {
    const application = await running();
    await begin(ALICE, application.id);
    await admin(request(app).post('/api/admin/adjust-student-time')).send({
        studentClass, courseId, examKey, applicationId: application.id, targetEmail: ALICE, adjustmentMinutes: 10, reason: 'Laudo de tempo extra',
    }).expect(200);
    assert.equal(openState(ALICE, application.id).individualTimeAdjustment, 10);
    const log = db.memory.proctoringLogs.find(entry => entry.eventType === 'time_adjusted');
    assert.ok(log);
    assert.equal(log.details, '+10 min pelo professor: Laudo de tempo extra');
    assert.doesNotMatch(log.details, /@/, 'o e-mail do professor não vai para o registro que o aluno vê em Meus dados');
    await admin(request(app).post('/api/admin/adjust-student-time')).send({
        studentClass, courseId, examKey, applicationId: application.id, targetEmail: ALICE, adjustmentMinutes: 5, reason: 'x'.repeat(301),
    }).expect(400);
});

// ---------------------------------------------------------------- token (D19)

test('[UC-TENTATIVA-004] token: a preparação guarda o selo, o histórico não guarda o texto e o Monitor mostra o mesmo token', async () => {
    const historyId = await createHistory({ tokenEnabled: true, accessToken: 'PROVA' });
    const cls = db.memory.classes.find(item => item.name === studentClass);
    const entry = cls.examHistory[examKey][0];
    assert.equal(Object.prototype.hasOwnProperty.call(entry, 'accessToken'), false, 'o histórico não guarda o token em texto puro');
    assert.equal(entry.tokenEnabled, true);
    const history = await admin(request(app).get('/api/admin/exam-history')).query({ studentClass, courseId, examKey }).expect(200);
    assert.doesNotMatch(JSON.stringify(history.body), /PROVA/);
    assert.equal(history.body.history[0].tokenEnabled, true);

    const prepared = await prepare(historyId, { tokenEnabled: true, accessToken: 'ABCDE' });
    assert.equal(prepared.body.application.accessTokenSealed, undefined, 'o selo não sai na resposta');
    const application = db.memory.examApplications.find(item => item.id === prepared.body.application.id);
    assert.ok(application.accessTokenSealed && application.accessTokenSealed.data, 'a aplicação guarda o selo');
    assert.doesNotMatch(JSON.stringify(application), /ABCDE/, 'nem o selo nem nada da aplicação tem o token em texto');

    const list = await admin(request(app).get('/api/admin/exam-applications')).query({ studentClass, courseId, examKey }).expect(200);
    assert.doesNotMatch(JSON.stringify(list.body), /accessTokenSealed/);
    const summary = await admin(request(app).get('/api/admin/exam-applications')).query({ studentClass, courseId, examKey, view: 'summary' }).expect(200);
    assert.doesNotMatch(JSON.stringify(summary.body), /accessTokenSealed/);
    assert.deepEqual(summary.body.applications[0].versionLabels, ['A']);
    const byId = await admin(request(app).get(`/api/admin/exam-applications/${application.id}`)).expect(200);
    assert.doesNotMatch(JSON.stringify(byId.body), /accessTokenSealed/);

    const revealed = await admin(request(app).get(`/api/admin/exam-applications/${application.id}/access-token`)).expect(200);
    assert.equal(revealed.body.accessToken, 'ABCDE');
    assert.match(revealed.headers['cache-control'], /no-store/);
    const audit = db.memory.auditLogs.find(item => item.type === 'exam_access_token_revealed');
    assert.ok(audit, 'mostrar o token grava exam_access_token_revealed');
    assert.equal(audit.applicationId, application.id);
    const trail = await admin(request(app).get(`/api/admin/exam-applications/${application.id}/audit`)).expect(200);
    assert.equal(trail.body.entries.find(entry => entry.id === audit.id).title, 'Token da prova mostrado de novo');
    assert.doesNotMatch(JSON.stringify(db.memory.auditLogs), /ABCDE|accessTokenSealed/, 'nem o token nem o selo vão para a auditoria');

    await otherProfessor(request(app).get(`/api/admin/exam-applications/${application.id}/access-token`)).expect(403);

    // O aluno entra com o mesmo token, depois de ele aparecer de novo.
    await start(application.id);
    const studentSync = await sync(ALICE, application.id).expect(200);
    const studentList = await asStudent(request(app).get('/api/student/exam-applications'), ALICE).query({ studentClass, courseId }).expect(200);
    assert.doesNotMatch(JSON.stringify([studentSync.body, studentList.body]), /accessTokenSealed|ABCDE/, 'o aluno não recebe o selo');
    const valid = await asStudent(request(app).post('/api/student/validate-exam-token'), ALICE)
        .send({ email: ALICE, studentClass, courseId, examKey, applicationId: application.id, token: 'ABCDE' }).expect(200);
    assert.equal(valid.body.valid, true);

    // Gerar outro: o novo também aparece de novo.
    const regenerated = await admin(request(app).post(`/api/admin/exam-applications/${application.id}/access-token`)).send({}).expect(200);
    const again = await admin(request(app).get(`/api/admin/exam-applications/${application.id}/access-token`)).expect(200);
    assert.equal(again.body.accessToken, regenerated.body.accessToken);
    assert.notEqual(again.body.accessToken, 'ABCDE');

    // Aplicação encerrada: o token não aparece mais.
    await admin(request(app).post(`/api/admin/exam-applications/${application.id}/control`)).send({ action: 'finish', inProgressPolicy: 'discard' }).expect(200);
    const closed = await admin(request(app).get(`/api/admin/exam-applications/${application.id}/access-token`)).expect(409);
    assert.equal(closed.body.code, 'application_closed');
});

test('[UC-TENTATIVA-004] token: aplicação antiga (sem selo), selo de outro computador e prova sem token', async () => {
    const historyId = await createHistory();
    const prepared = await prepare(historyId, { tokenEnabled: true, accessToken: 'FGHIJ' });
    const application = db.memory.examApplications.find(item => item.id === prepared.body.application.id);
    const url = `/api/admin/exam-applications/${application.id}/access-token`;

    const sealed = application.accessTokenSealed;
    delete application.accessTokenSealed;
    const legacy = await admin(request(app).get(url)).expect(404);
    assert.equal(legacy.body.code, 'token_unavailable');
    assert.match(legacy.body.error, /Gere outro token/);

    // Backup de outro computador: o segredo de lá é outro e o selo não abre.
    application.accessTokenSealed = sealExamToken('FGHIJ', { applicationId: application.id, secret: 'o'.repeat(64) });
    assert.equal((await admin(request(app).get(url)).expect(404)).body.code, 'token_unavailable');
    // Selo de outra aplicação (copiado) também não abre.
    application.accessTokenSealed = sealExamToken('FGHIJ', { applicationId: 'app_outra', secret: db.memory.config.examAnswerSecret });
    assert.equal((await admin(request(app).get(url)).expect(404)).body.code, 'token_unavailable');
    application.accessTokenSealed = sealed;
    assert.equal((await admin(request(app).get(url)).expect(200)).body.accessToken, 'FGHIJ');
    assert.equal(unsealExamToken(sealed, { applicationId: application.id, secret: 'p'.repeat(64) }), null);

    const plain = await prepare(historyId, { tokenEnabled: false });
    const noToken = await admin(request(app).get(`/api/admin/exam-applications/${plain.body.application.id}/access-token`)).expect(400);
    assert.equal(noToken.body.code, 'token_disabled');
    assert.equal(db.memory.examApplications.find(item => item.id === plain.body.application.id).accessTokenSealed, undefined);
});

test('[UC-TENTATIVA-004] token: preparar pelo histórico de antes (com o token em texto) continua pedindo token', async () => {
    const historyId = await createHistory();
    const cls = db.memory.classes.find(item => item.name === studentClass);
    // Como a versão anterior gravava, antes da migração.
    cls.examHistory[examKey][0].accessToken = 'KLMNO';
    delete cls.examHistory[examKey][0].tokenEnabled;
    const history = await admin(request(app).get('/api/admin/exam-history')).query({ studentClass, courseId, examKey }).expect(200);
    assert.doesNotMatch(JSON.stringify(history.body), /KLMNO/);
    assert.equal(history.body.history[0].tokenEnabled, true);
    // Preparar por ela continua com o mesmo token (e agora ele aparece de novo).
    const legacy = await prepare(historyId);
    assert.equal(legacy.body.application.tokenEnabled, true);
    const revealed = await admin(request(app).get(`/api/admin/exam-applications/${legacy.body.application.id}/access-token`)).expect(200);
    assert.equal(revealed.body.accessToken, 'KLMNO');
    // A configuração nova (só tokenEnabled) gera um token na preparação.
    const fresh = await createHistory({ tokenEnabled: true });
    const prepared = await prepare(fresh);
    assert.equal(prepared.body.application.tokenEnabled, true);
    const generated = await admin(request(app).get(`/api/admin/exam-applications/${prepared.body.application.id}/access-token`)).expect(200);
    assert.match(generated.body.accessToken, /^[A-Z]{5}$/);
});

test('[UC-TENTATIVA-004] migração 2026-11-p3-token-historico tira o token em texto dos históricos e é idempotente', () => {
    const row = MIGRATIONS.find(item => item.id === '2026-11-p3-token-historico');
    assert.ok(row, 'a migração está no registro');
    assert.equal(row.tipo, 'memoria');
    const memory = {
        classes: [
            {
                name: 'A',
                examHistory: {
                    P1: [
                        { id: 'h1', accessToken: 'PROVA', durationMinutes: 30 },
                        { id: 'h2', accessToken: '', tokenEnabled: false },
                        { id: 'h3', accessToken: null, tokenEnabled: true },
                        { id: 'h4', tokenEnabled: false },
                    ],
                    P2: 'lixo',
                },
            },
            { name: 'B' },
            { name: 'C', examHistory: [] },
            null,
        ],
    };
    assert.equal(row.run(memory), true);
    const [h1, h2, h3, h4] = memory.classes[0].examHistory.P1;
    assert.deepEqual(h1, { id: 'h1', durationMinutes: 30, tokenEnabled: true });
    assert.deepEqual(h2, { id: 'h2', tokenEnabled: false });
    assert.deepEqual(h3, { id: 'h3', tokenEnabled: true });
    assert.deepEqual(h4, { id: 'h4', tokenEnabled: false }, 'entrada sem o campo fica como estava');
    assert.equal(memory.classes[0].examHistory.P2, 'lixo');
    assert.doesNotMatch(JSON.stringify(memory), /PROVA/);
    const before = JSON.stringify(memory);
    assert.equal(row.run(memory), false, 'segunda passada não muda nada');
    assert.equal(JSON.stringify(memory), before);
    assert.equal(row.run({}), false);
});

// ---------------------------------------------------------------- A4, ajuste 1

test('[UC-TENTATIVA-004] tentativa extra recusa aluno desligado e o Monitor não a oferece', async () => {
    const application = await running();
    const started = await begin(BRUNO, application.id);
    await submit(BRUNO, application.id, started, {});
    db.memory.students.find(item => item.email === BRUNO).status = 'Transferido';

    const refused = await action(application.id, { action: 'tentativa_extra', studentEmail: BRUNO }).expect(409);
    assert.equal(refused.body.code, 'student_inactive');
    assert.match(refused.body.error, /Bruno Lima está com o cadastro Transferido/);
    assert.equal(effectiveFor(application.id, BRUNO), undefined, 'nada é gravado');
    assert.equal(db.memory.auditLogs.some(entry => entry.type === 'exam_attempt_extra_granted'), false);
    assert.equal((await monitorRow(application.id, BRUNO)).activeStudent, false);
    assert.equal((await monitorRow(application.id, ALICE)).activeStudent, true);
    await action(application.id, { action: 'tentativa_extra', studentEmail: ALICE }).expect(200);
});

test('[UC-TENTATIVA-004] a cópia da tentativa na entrega não leva o e-mail e sai quando a aplicação encerra', async () => {
    const application = await running({ maxAttempts: 2 });
    const started = await begin(ALICE, application.id);
    await submit(ALICE, application.id, started, {});
    const [delivery] = deliveries(application.id, ALICE);
    assert.ok(delivery.reopenableState && delivery.reopenableState.startedAt);
    assert.equal(Object.prototype.hasOwnProperty.call(delivery.reopenableState, 'studentEmail'), false, 'sem o e-mail do aluno');
    assert.doesNotMatch(JSON.stringify(delivery.reopenableState), /alice@/);
    // Reabrir continua funcionando sem o e-mail na cópia: a tentativa volta com o da entrega.
    await action(application.id, { action: 'reabrir', studentEmail: ALICE, motivo: 'Enviou por engano' }).expect(200);
    assert.equal(openState(ALICE, application.id).studentEmail, ALICE);
    await action(application.id, { action: 'recolher', studentEmail: ALICE }).expect(200);
    assert.ok(deliveries(application.id, ALICE)[0].reopenableState);

    // Entregas são linhas antigas de coleção só de acréscimo: tirar a cópia pede gravação
    // completa (sem only), senão o banco ficaria com ela.
    const originalSave = db.save;
    const saves = [];
    db.save = (options) => { saves.push(options); return originalSave.call(db, options); };
    try {
        await admin(request(app).post(`/api/admin/exam-applications/${application.id}/control`)).send({ action: 'finish', inProgressPolicy: 'discard' }).expect(200);
    } finally {
        db.save = originalSave;
    }
    assert.ok(saves.length > 0 && saves.every(options => !options || !options.only), JSON.stringify(saves));
    const [kept] = deliveries(application.id, ALICE);
    assert.ok(kept, 'a entrega continua');
    assert.equal(kept.reopenableState, undefined, 'encerrada, a aplicação não guarda mais a cópia da tentativa');
});

test('[UC-TENTATIVA-004] server-exam-control não devolve o token selado e encerrar tira a cópia da tentativa', async () => {
    const historyId = await createHistory();
    const prepared = await prepare(historyId, { tokenEnabled: true, accessToken: 'QRSTU' });
    const applicationId = prepared.body.application.id;
    const started = await admin(request(app).post('/api/admin/server-exam-control')).send({ studentClass, courseId, examKey, applicationId, action: 'start' }).expect(200);
    assert.equal(started.body.application.status, 'running');
    assert.doesNotMatch(JSON.stringify(started.body), /accessTokenSealed|QRSTU/);
    assert.ok(db.memory.examApplications.find(item => item.id === applicationId).accessTokenSealed, 'a aplicação continua com o selo');
    const repeated = await admin(request(app).post('/api/admin/server-exam-control')).send({ studentClass, courseId, examKey, applicationId, action: 'start' }).expect(200);
    assert.doesNotMatch(JSON.stringify(repeated.body), /accessTokenSealed/);

    await asStudent(request(app).post('/api/student/validate-exam-token'), ALICE)
        .send({ email: ALICE, studentClass, courseId, examKey, applicationId, token: 'QRSTU' }).expect(200);
    const attempt = await begin(ALICE, applicationId);
    await submit(ALICE, applicationId, attempt, {});
    assert.ok(deliveries(applicationId, ALICE)[0].reopenableState);
    const finished = await admin(request(app).post('/api/admin/server-exam-control')).send({ studentClass, courseId, examKey, applicationId, action: 'finish', inProgressPolicy: 'discard' }).expect(200);
    assert.doesNotMatch(JSON.stringify(finished.body), /accessTokenSealed/);
    assert.equal(deliveries(applicationId, ALICE)[0].reopenableState, undefined);
});

test('[UC-TENTATIVA-004] anonimizar e trocar o e-mail não deixam o e-mail do aluno na cópia da tentativa', async () => {
    const application = await running();
    const started = await begin(ALICE, application.id);
    await submit(ALICE, application.id, started, {});
    // Como as entregas automáticas do fim do tempo gravavam antes deste ajuste.
    const [delivery] = deliveries(application.id, ALICE);
    delivery.reopenableState.studentEmail = ALICE;
    const startedBruno = await begin(BRUNO, application.id);
    await submit(BRUNO, application.id, startedBruno, {});
    deliveries(application.id, BRUNO)[0].reopenableState.studentEmail = BRUNO;

    // Trocar o e-mail do Bruno: o antigo sai de dentro da cópia (a reabertura usa o da entrega).
    const { renameStudentData } = require('../../backend/utils/studentDataHandlers.js');
    renameStudentData(db.memory, BRUNO, 'bruno.novo@acoes.local');
    const brunoDelivery = db.memory.submissions.find(item => item.applicationId === application.id && item.student.email === BRUNO);
    assert.ok(brunoDelivery.reopenableState && brunoDelivery.reopenableState.startedAt, 'a cópia continua');
    assert.equal(brunoDelivery.reopenableState.studentEmail, undefined);

    // Anonimizar a Alice (desligada) com a aplicação ainda em andamento.
    db.memory.students.find(item => item.email === ALICE).status = 'Transferido';
    const anonymized = await admin(request(app).post('/api/admin/students/anonymize')).send({ email: ALICE, confirm: 'ANONIMIZAR', reason: 'Pedido da família' });
    assert.equal(anonymized.status, 200, JSON.stringify(anonymized.body));
    assert.doesNotMatch(JSON.stringify(db.memory.submissions), /alice@acoes\.local/, 'nenhuma entrega guarda o e-mail original');
    const hers = db.memory.submissions.filter(item => item.applicationId === application.id && item.attemptId === started.attemptId);
    assert.equal(hers.length, 1);
    assert.equal(hers[0].reopenableState, undefined, 'a cópia da tentativa sai da entrega anonimizada');
    assert.ok(deliveries(application.id, BRUNO)[0].reopenableState, 'a do outro aluno fica');
});

test('[UC-TENTATIVA-004] ajuste de tempo de aluno que ainda não começou guarda o motivo no registro', async () => {
    const application = await running();
    const response = await admin(request(app).post('/api/admin/adjust-student-time')).send({
        studentClass, courseId, examKey, applicationId: application.id, targetEmail: BRUNO, adjustmentMinutes: 10, reason: 'Laudo de tempo extra',
    }).expect(200);
    assert.equal(response.body.appliesToNextAttempt, true);
    assert.equal(db.memory.examApplications.find(item => item.id === application.id).studentAdjustments[BRUNO], 10);
    const log = db.memory.proctoringLogs.find(entry => entry.eventType === 'time_adjusted' && entry.studentEmail === BRUNO);
    assert.ok(log, 'o ajuste fica no registro do monitoramento');
    assert.equal(log.attemptId, null);
    assert.equal(log.applicationId, application.id);
    assert.equal(log.details, '+10 min pelo professor (vale quando o aluno começar a prova): Laudo de tempo extra');
});

// ---------------------------------------------------------------- A4, ajuste 2

test('[UC-TENTATIVA-004] attempt-action valida o e-mail do aluno pelo emailField: fora do formato é 400, antes de procurar o aluno', async () => {
    const application = await running();
    for (const studentEmail of ['ana bia@acoes.local', 'ana@acoes.local,bia@acoes.local', 'Ana <ana@acoes.local>', 'ana;bia']) {
        const response = await action(application.id, { action: 'tentativa_extra', studentEmail }).expect(400);
        assert.equal(response.body.field, 'studentEmail', studentEmail);
        assert.match(response.body.error, /aluno/);
    }
    const missing = await action(application.id, { action: 'recolher' }).expect(400);
    assert.equal(missing.body.field, 'studentEmail');
    // Espaço em volta e maiúsculas continuam valendo (o campo corta e a regra normaliza).
    const ok = await action(application.id, { action: 'tentativa_extra', studentEmail: `  ${BRUNO.toUpperCase()} ` });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    // Bem formado, mas de ninguém da turma: 404 da regra.
    const nobody = await action(application.id, { action: 'tentativa_extra', studentEmail: 'ninguem@acoes.local' }).expect(404);
    assert.equal(nobody.body.field, 'studentEmail');
});

// Junção J1 (A4 + B1): o Professor auxiliar usa as ações por aluno do Monitor (page.monitor),
// mas a resposta não pode levar as versões da prova com o gabarito, como a lista e o
// /control já não levam para ele.
test('[UC-TENTATIVA-004] [UC-PAPEIS-001] ações por aluno do Professor auxiliar não devolvem as versões com o gabarito', async () => {
    const auxiliar = req => req.set('x-admin-session', auxiliarToken);
    const application = await running();
    assert.ok(Array.isArray(db.memory.examApplications.find(item => item.id === application.id).versionSnapshots));
    const started = await begin(ALICE, application.id);
    const collected = await action(application.id, { action: 'recolher', studentEmail: ALICE }, auxiliar);
    assert.equal(collected.status, 200, JSON.stringify(collected.body));
    assert.equal(collected.body.application.id, application.id);
    assert.equal('versionSnapshots' in collected.body.application, false);
    assert.equal('accessTokenSealed' in collected.body.application, false);
    assert.equal(JSON.stringify(collected.body).includes('isCorrect'), false);
    const reopened = await action(application.id, { action: 'reabrir', studentEmail: ALICE, motivo: 'Recolhida por engano' }, auxiliar);
    assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
    assert.equal('versionSnapshots' in reopened.body.application, false);
    await submit(ALICE, application.id, { attemptId: started.attemptId, examConfigVersion: started.examConfigVersion }, {});
    const extra = await action(application.id, { action: 'tentativa_extra', studentEmail: ALICE }, auxiliar);
    assert.equal(extra.status, 200, JSON.stringify(extra.body));
    assert.equal('versionSnapshots' in extra.body.application, false);
    // O professor da turma (com page.exams) continua recebendo a aplicação inteira.
    const extraAdmin = await action(application.id, { action: 'tentativa_extra', studentEmail: BRUNO }).expect(200);
    assert.ok(Array.isArray(extraAdmin.body.application.versionSnapshots));
});

// Anular por integridade (cola) e desfazer (P3-S4a, A9; D18 e P-B1 do P3).
const { calculateAttemptResult } = require('../../backend/utils/submissionAttempts.js');
const { sanitizeSubmissionForStudent } = require('../../backend/middlewares.js');

function consolidated(applicationId, email) {
    return calculateAttemptResult(deliveries(applicationId, email));
}

test('[UC-TENTATIVA-004] anular a entrega: nota zero com motivo, auditoria e registro; desfazer volta a nota; "não conta" fica fora', async () => {
    const application = await running();
    const started = await begin(ALICE, application.id);
    await submit(ALICE, application.id, started, { 1: 'A', 2: 'A' });
    const [delivery] = deliveries(application.id, ALICE);
    assert.equal(delivery.score, 100);
    assert.equal(consolidated(application.id, ALICE).score, 100);
    const before = await monitorRow(application.id, ALICE);
    assert.equal(before.canInvalidate, true);
    assert.equal(before.canUndoInvalidation, false);

    const short = await action(application.id, { action: 'anular', studentEmail: ALICE, motivo: 'x' }).expect(400);
    assert.equal(short.body.field, 'motivo');
    const badDecision = await action(application.id, { action: 'anular', studentEmail: ALICE, motivo: 'Cola com celular', decisao: 'apagar' }).expect(400);
    assert.equal(badDecision.body.field, 'decisao');
    assert.equal(delivery.integrity, undefined);

    // Padrão (P-B1): zero.
    const annulled = await action(application.id, { action: 'anular', studentEmail: ALICE, motivo: 'Cola com celular' }).expect(200);
    assert.equal(annulled.body.submission.id, delivery.id);
    assert.equal(annulled.body.submission.integrity, 'zero');
    assert.deepEqual([annulled.body.consolidated.before, annulled.body.consolidated.after], [100, 0]);
    assert.equal(delivery.score, 100, 'a nota gravada não muda: o calculador aplica a decisão');
    assert.equal(delivery.integrity.decisao, 'zero');
    assert.equal(delivery.integrity.motivo, 'Cola com celular');
    assert.equal(delivery.integrity.por, 'admin@acoes.local');
    assert.equal(consolidated(application.id, ALICE).score, 0);
    const audit = db.memory.auditLogs.find(entry => entry.action === 'grade_invalidated');
    assert.ok(audit, 'anular grava grade_invalidated');
    assert.equal(audit.reason, 'Cola com celular');
    assert.equal(audit.submissionId, delivery.id);
    assert.match(audit.newValue, /anulada \(nota zero\)/);
    const log = db.memory.proctoringLogs.find(entry => entry.eventType === 'attempt_invalidated');
    assert.ok(log && log.studentEmail === ALICE);
    assert.doesNotMatch(log.details, /Cola com celular/, 'o motivo fica na auditoria, não no registro que o aluno vê');
    const row = await monitorRow(application.id, ALICE);
    assert.equal(row.integrity, 'zero');
    assert.equal(row.canUndoInvalidation, true);
    assert.equal(row.canReopen, false);

    // Antes de publicar, o aluno não fica sabendo; com a nota publicada, vê a tentativa
    // anulada com 0.
    assert.equal(sanitizeSubmissionForStudent(delivery, false).anulada, undefined);
    delivery.gradePublished = true;
    const studentView = sanitizeSubmissionForStudent(delivery, false);
    assert.equal(studentView.anulada, 'zero');
    assert.equal(studentView.score, 0);
    assert.equal(studentView.integrity, undefined);
    assert.doesNotMatch(JSON.stringify(studentView), /Cola com celular|admin@acoes/);
    delivery.gradePublished = false;

    const again = await action(application.id, { action: 'anular', studentEmail: ALICE, motivo: 'De novo', decisao: 'desconsiderar' }).expect(409);
    assert.equal(again.body.code, 'already_invalidated');

    const undone = await action(application.id, { action: 'desfazer_anulacao', studentEmail: ALICE, motivo: 'Era a calculadora liberada' }).expect(200);
    assert.equal(undone.body.submission.integrity, null);
    assert.equal(undone.body.consolidated.after, 100);
    assert.equal(consolidated(application.id, ALICE).score, 100);
    assert.equal(delivery.integrity.desfeitaPor, 'admin@acoes.local');
    assert.equal(delivery.integrity.motivoDesfeita, 'Era a calculadora liberada');
    assert.ok(db.memory.auditLogs.some(entry => entry.action === 'grade_invalidation_undone' && entry.reason === 'Era a calculadora liberada'));
    assert.ok(db.memory.proctoringLogs.some(entry => entry.eventType === 'attempt_invalidation_undone'));
    const notAnnulled = await action(application.id, { action: 'desfazer_anulacao', studentEmail: ALICE, motivo: 'Outra vez' }).expect(409);
    assert.equal(notAnnulled.body.code, 'not_invalidated');

    // "Não conta": a tentativa sai da conta (sem nota, como se não tivesse feito).
    await action(application.id, { action: 'anular', studentEmail: ALICE, motivo: 'Trocou de prova com o colega', decisao: 'desconsiderar' }).expect(200);
    assert.equal(delivery.integrity.decisao, 'desconsiderar');
    assert.equal(delivery.integrity.anteriores.length, 1, 'a anulação desfeita fica no histórico da entrega');
    assert.equal(consolidated(application.id, ALICE).score, null);
    delivery.gradePublished = true;
    const hidden = sanitizeSubmissionForStudent(delivery, false);
    assert.equal(hidden.anulada, 'desconsiderar');
    assert.equal(hidden.gradePublished, false, 'a que não conta não mostra nota');
});

test('[UC-TENTATIVA-004] anular a prova em andamento recolhe a tentativa antes; sem entrega é 409; o auxiliar não anula', async () => {
    const auxiliar = req => req.set('x-admin-session', auxiliarToken);
    const application = await running();
    const started = await begin(ALICE, application.id);
    openState(ALICE, application.id).answers = { 1: 'A' };

    const refused = await action(application.id, { action: 'anular', studentEmail: ALICE, motivo: 'Cola com celular' }, auxiliar).expect(403);
    assert.doesNotMatch(JSON.stringify(refused.body), /alice@/);
    assert.ok(openState(ALICE, application.id), 'a recusa não recolhe');

    const annulled = await action(application.id, { action: 'anular', studentEmail: ALICE, motivo: 'Cola com celular' }).expect(200);
    assert.equal(annulled.body.submission.recolhida, true);
    assert.equal(openState(ALICE, application.id), undefined, 'a tentativa foi recolhida');
    const [delivery] = deliveries(application.id, ALICE);
    assert.equal(delivery.attemptId, started.attemptId);
    assert.equal(delivery.submissionSource, 'instructor_collect');
    assert.equal(delivery.integrity.decisao, 'zero');
    assert.ok(db.memory.auditLogs.some(entry => entry.type === 'exam_attempt_collected'));
    assert.equal(db.memory.auditLogs.find(entry => entry.action === 'grade_invalidated').details.recolhida, true);

    const nobody = await action(application.id, { action: 'anular', studentEmail: BRUNO, motivo: 'Cola com celular' }).expect(409);
    assert.equal(nobody.body.code, 'no_submission');
    const unknown = await action(application.id, { action: 'anular', studentEmail: ALICE, motivo: 'Cola com celular', submissionId: 'sub_outra' }).expect(404);
    assert.equal(unknown.body.code, 'submission_not_found');
});

test('[UC-TENTATIVA-004] anular vale na aplicação encerrada e o Monitor oferece só anular e desfazer', async () => {
    const application = await running();
    const started = await begin(ALICE, application.id);
    await submit(ALICE, application.id, started, { 1: 'A' });
    await admin(request(app).post(`/api/admin/exam-applications/${application.id}/control`)).send({ action: 'finish' }).expect(200);
    const row = await monitorRow(application.id, ALICE);
    assert.equal(row.canInvalidate, true);
    assert.equal(row.canReopen, false);
    await action(application.id, { action: 'anular', studentEmail: ALICE, motivo: 'Cola descoberta na correção' }).expect(200);
    assert.equal(deliveries(application.id, ALICE)[0].integrity.decisao, 'zero');
    const after = await monitorRow(application.id, ALICE);
    assert.equal(after.canInvalidate, false, 'a última entrega já está anulada');
    assert.equal(after.canUndoInvalidation, true);
});
