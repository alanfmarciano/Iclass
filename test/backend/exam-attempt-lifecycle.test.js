// Ciclo da tentativa de prova online: fim do tempo, pausa, encerramento e envio
// atrasado. Os relógios são simulados deslocando startedAt/startsAt/pausas para trás.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-lifecycle-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const {
    extendDeadlineByPauses,
    normalizeLegacyApplicationPause,
    transitionExamApplication,
} = require('../../backend/utils/examApplications.js');
const { lateSubmitDecision, LATE_AUTO_SUBMIT_TOLERANCE_MS, settleExpiredAttempts } = require('../../backend/utils/examDeadline.js');
const { encodeAnswersForStudent } = require('../../backend/utils/examAnswerIds.js');

// O sync devolve as respostas com o identificador opaco de cada alternativa (AVA-05),
// nunca a letra original: compara com os identificadores das letras esperadas.
function asStudentAnswers(applicationId, letters) {
    return encodeAnswersForStudent(letters, applicationId);
}

let app;
const adminToken = 'admin-token-lifecycle';
const adminEmail = 'admin@lifecycle.local';
const studentClass = 'Turma Ciclo';
const courseId = 'curso-ciclo';
const examKey = 'Avaliacao_Ciclo';
const DURATION_MIN = 30;
const MIN = 60000;
const students = {
    ana: { email: 'ana@lifecycle.local', token: 'token-ana' },
    bruno: { email: 'bruno@lifecycle.local', token: 'token-bruno' },
    carla: { email: 'carla@lifecycle.local', token: 'token-carla' },
    diego: { email: 'diego@lifecycle.local', token: 'token-diego' },
};

test.before(async () => {
    await db.init();
    app = createApp();
    db.memory.admins = [{ email: adminEmail, name: 'Admin', role: 'admin', password: db.hashPassword('senha-administrativa') }];
    db.memory.adminSessions = { [adminToken]: { email: adminEmail, createdAt: Date.now(), lastSeen: Date.now() } };
    db.memory.students = Object.values(students).map((student, index) => ({
        name: `Aluno ${index + 1}`,
        email: student.email,
        status: 'Ativo',
        classes: [{ name: studentClass, courseId }],
    }));
    db.memory.sessions = Object.fromEntries(Object.values(students).map(student => [
        student.email,
        { token: student.token, lastSeen: Date.now(), ip: '127.0.0.1' },
    ]));
    db.memory.courses = [{ id: courseId, structure: [{ name: 'Módulo', units: [{ avaliacaoKey: examKey }] }] }];
    db.memory.classes = [{ name: studentClass, courseId, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} }];
    db.memory.evaluations = {
        [examKey]: {
            key: examKey,
            title: 'Prova do ciclo da tentativa',
            questions: ['A', 'B', 'C'].map((correct, index) => ({
                number: index + 1,
                text: `Questão ${index + 1}`,
                correctAnswer: correct,
                alternatives: ['A', 'B', 'C'].map(letter => ({ letter, text: `Alternativa ${letter}`, isCorrect: letter === correct })),
            })),
        },
    };
    db.memory.submissions = [];
    db.memory.examApplications = [];
    db.memory.studentExamState = {};
    db.memory.proctoringLogs = [];
    db.memory.broadcastMessages = [];
});

test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function createApplication({ timerMode = 'per_attempt', maxAttempts = 1 } = {}) {
    const history = await request(app)
        .post('/api/admin/exam-history/add')
        .set('x-admin-session', adminToken)
        .send({
            studentClass,
            courseId,
            examKey,
            type: 'online',
            questionNumbers: [1, 2, 3],
            printSnapshot: [{
                version: 'A',
                questions: [1, 2, 3].map(number => ({
                    originalNumber: number,
                    text: `Questão ${number}`,
                    alternatives: ['A', 'B', 'C'].map(letter => ({ letter, text: `Alternativa ${letter}` })),
                })),
            }],
            durationMinutes: DURATION_MIN,
            waitingRoomMinutes: 0,
            maxAttempts,
        })
        .expect(200);
    const created = await request(app)
        .post('/api/admin/exam-applications')
        .set('x-admin-session', adminToken)
        .send({
            studentClass,
            courseId,
            examKey,
            historyId: history.body.entry.id,
            applicationOptions: { timerMode, waitingRoomMinutes: 0, maxAttempts },
        })
        .expect(201);
    const started = await control(created.body.application.id, 'start');
    return started.body.application;
}

function control(applicationId, action, extra = {}) {
    return request(app)
        .post(`/api/admin/exam-applications/${applicationId}/control`)
        .set('x-admin-session', adminToken)
        .send({ action, ...extra })
        .expect(200);
}

function sync(student, applicationId, attemptId = '') {
    return request(app)
        .get('/api/student/sync')
        .set('x-session-token', student.token)
        .query({ email: student.email, studentClass, courseId, examKey, applicationId, attemptId })
        .expect(200);
}

async function startAttempt(student, applicationId) {
    await sync(student, applicationId);
    const started = await request(app)
        .post(`/api/student/exam-applications/${applicationId}/start-attempt`)
        .set('x-session-token', student.token)
        .send({})
        .expect(200);
    return started.body;
}

function autosave(student, applicationId, attemptId, answers) {
    return request(app)
        .post('/api/student/autosave-progress')
        .set('x-session-token', student.token)
        .send({ studentClass, courseId, examKey, applicationId, attemptId, answers });
}

function submit(student, applicationId, started, answers, auto = true) {
    return request(app)
        .post('/api/student/submit')
        .set('x-session-token', student.token)
        .send({
            studentClass,
            courseId,
            examKey,
            applicationId,
            attemptId: started.attemptId,
            answers,
            examConfigVersion: started.examConfigVersion,
            auto,
        });
}

function stateOf(attemptId) {
    return Object.values(db.memory.studentExamState).find(state => state?.attemptId === attemptId) || null;
}

function openStatesOf(student, applicationId) {
    return Object.values(db.memory.studentExamState).filter(state => state
        && state.applicationId === applicationId
        && state.studentEmail === student.email
        && !['submitted', 'invalidated'].includes(state.status));
}

function submissionsOf(student, applicationId) {
    return db.memory.submissions.filter(item => item.applicationId === applicationId && item.student?.email === student.email);
}

// Faz o prazo da tentativa ter vencido há overdueMs (cronômetro por tentativa).
function expireAttempt(attemptId, overdueMs) {
    const state = stateOf(attemptId);
    state.startedAt = Date.now() - DURATION_MIN * MIN - overdueMs;
    return state;
}

function applicationOf(applicationId) {
    return db.memory.examApplications.find(item => item.id === applicationId);
}

test('[UC-TENTATIVA-001] sincronizar depois do prazo não recria a tentativa nem apaga as respostas; o servidor entrega o que estava salvo (AVA-03, CONF-02)', async () => {
    const { ana } = students;
    const application = await createApplication({ timerMode: 'per_attempt', maxAttempts: 1 });
    const started = await startAttempt(ana, application.id);
    await autosave(ana, application.id, started.attemptId, { 1: 'A', 2: 'B' }).expect(200);

    expireAttempt(started.attemptId, 2000);
    const firstAfter = await sync(ana, application.id, started.attemptId);
    assert.equal(firstAfter.body.attemptId, started.attemptId);
    assert.equal(firstAfter.body.state.timerRemaining, 0);
    assert.deepEqual(firstAfter.body.state.answers, asStudentAnswers(application.id, { 1: 'A', 2: 'B' }));
    assert.notEqual(firstAfter.body.state.status, 'instructions');

    const secondAfter = await sync(ana, application.id, started.attemptId);
    assert.equal(secondAfter.body.attemptId, started.attemptId, 'a tentativa vencida não é recriada');
    assert.deepEqual(secondAfter.body.state.answers, asStudentAnswers(application.id, { 1: 'A', 2: 'B' }));

    // Passado o atraso normal do envio automático, o servidor entrega sozinho.
    expireAttempt(started.attemptId, 45000);
    const finalized = await sync(ana, application.id, started.attemptId);
    assert.equal(finalized.body.attemptOutcome.attemptId, started.attemptId);
    assert.equal(finalized.body.attemptOutcome.finalizedByServer, true);
    assert.equal(finalized.body.attemptOutcome.answeredCount, 2);
    assert.equal(finalized.body.attemptsUsed, 1);
    assert.equal(openStatesOf(ana, application.id).length, 0);

    const delivered = submissionsOf(ana, application.id);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].submissionSource, 'deadline_server_auto_submit');
    assert.equal(delivered[0].attemptId, started.attemptId);
    assert.equal(delivered[0].correctCount, 2);
    assert.ok(Number(delivered[0].deadlineAt) > 0);

    // Nada de tempo cheio de novo: a única tentativa já foi usada.
    const restart = await request(app)
        .post(`/api/student/exam-applications/${application.id}/start-attempt`)
        .set('x-session-token', ana.token)
        .send({})
        .expect(403);
    assert.equal(restart.body.attemptsExhausted, true);
    await control(application.id, 'finish');
});

test('[UC-TENTATIVA-001] envio automático que chega depois de uma sincronização pós-prazo é aceito com as respostas do navegador (CONF-01)', async () => {
    const { bruno } = students;
    const application = await createApplication({ timerMode: 'per_attempt' });
    const started = await startAttempt(bruno, application.id);
    await autosave(bruno, application.id, started.attemptId, { 1: 'A' }).expect(200);

    expireAttempt(started.attemptId, 1000);
    await sync(bruno, application.id, started.attemptId);
    const response = await submit(bruno, application.id, started, { 1: 'A', 2: 'B', 3: 'A' }).expect(200);
    assert.equal(response.body.answeredCount, 3);
    assert.equal(response.body.lateBySeconds, 0);

    const [delivered] = submissionsOf(bruno, application.id);
    assert.equal(delivered.submissionSource, 'timer_auto_submit');
    assert.equal(delivered.correctCount, 2);
    assert.equal(delivered.submittedAfterDeadline, undefined);
    await control(application.id, 'finish');
});

test('[UC-TENTATIVA-001] celular sem rede no fim do tempo: o envio atrasado do navegador substitui a entrega do servidor dentro da tolerância (UXA-01, CONF-01)', async () => {
    const { carla } = students;
    const application = await createApplication({ timerMode: 'per_attempt' });
    const started = await startAttempt(carla, application.id);
    await autosave(carla, application.id, started.attemptId, { 1: 'B' }).expect(200);

    // 3 minutos sem rede: a varredura do servidor entrega o que estava salvo.
    expireAttempt(started.attemptId, 3 * MIN);
    await request(app)
        .get(`/api/admin/monitor-status/${encodeURIComponent(studentClass)}/${encodeURIComponent(examKey)}`)
        .set('x-admin-session', adminToken)
        .query({ courseId, applicationId: application.id })
        .expect(200);
    let [delivered] = submissionsOf(carla, application.id);
    assert.equal(delivered.submissionSource, 'deadline_server_auto_submit');
    assert.equal(delivered.correctCount, 0);

    // A rede volta e chega o envio automático com as respostas congeladas no zero.
    const late = await submit(carla, application.id, started, { 1: 'A', 2: 'B' }).expect(200);
    assert.equal(late.body.replacedServerFinalization, true);
    assert.ok(late.body.lateBySeconds >= 179 && late.body.lateBySeconds <= 185, `atraso registrado: ${late.body.lateBySeconds}`);
    [delivered] = submissionsOf(carla, application.id);
    assert.equal(submissionsOf(carla, application.id).length, 1);
    assert.equal(delivered.submissionSource, 'timer_auto_submit');
    assert.equal(delivered.submittedAfterDeadline, true);
    assert.equal(delivered.correctCount, 2);
    assert.equal(delivered.serverFinalization.answeredCount, 1);

    // O registro da entrega substituída (com a nota daquela versão) é só do professor:
    // o aluno não vê nota nenhuma antes da publicação, nem por esse campo.
    const mine = await request(app)
        .post('/api/student/my-submissions')
        .set('x-session-token', carla.token)
        .send({ studentClass, courseId })
        .expect(200);
    const own = mine.body.submissions.find(item => item.attemptId === started.attemptId);
    assert.ok(own, 'a entrega aparece para a aluna');
    assert.equal(own.gradePublished, false);
    assert.equal(own.score, undefined);
    assert.equal(own.serverFinalization, undefined);
    assert.equal(JSON.stringify(mine.body).includes('serverFinalization'), false);
    assert.equal(own.lateBySeconds, late.body.lateBySeconds, 'o atraso continua visível para a aluna');
    delivered.gradePublished = true;
    const published = await request(app)
        .post('/api/student/my-submissions')
        .set('x-session-token', carla.token)
        .send({ studentClass, courseId })
        .expect(200);
    const ownPublished = published.body.submissions.find(item => item.attemptId === started.attemptId);
    assert.equal(ownPublished.score, delivered.score, 'publicada, vale a nota da entrega que conta');
    assert.equal(ownPublished.serverFinalization, undefined);
    delivered.gradePublished = false;

    // Reenvio (resposta perdida na rede) é idempotente.
    const retry = await submit(carla, application.id, started, { 1: 'A', 2: 'B' }).expect(200);
    assert.equal(retry.body.duplicate, true);
    assert.equal(submissionsOf(carla, application.id).length, 1);

    // O professor vê como e quando a entrega chegou.
    const monitor = await request(app)
        .get(`/api/admin/monitor-status/${encodeURIComponent(studentClass)}/${encodeURIComponent(examKey)}`)
        .set('x-admin-session', adminToken)
        .query({ courseId, applicationId: application.id })
        .expect(200);
    const row = monitor.body.find(item => item.email === carla.email);
    assert.equal(row.status, 'finished');
    assert.equal(row.submissionSource, 'timer_auto_submit');
    assert.ok(row.lateBySeconds >= 179);
    await control(application.id, 'finish');
});

test('[UC-TENTATIVA-001] depois da janela de tolerância vale a entrega do servidor com as respostas salvas (UXA-01)', async () => {
    const { ana, bruno } = students;
    const application = await createApplication({ timerMode: 'per_attempt' });
    const startedAna = await startAttempt(ana, application.id);
    await autosave(ana, application.id, startedAna.attemptId, { 1: 'A' }).expect(200);
    expireAttempt(startedAna.attemptId, LATE_AUTO_SUBMIT_TOLERANCE_MS + MIN);
    const tooLate = await submit(ana, application.id, startedAna, { 1: 'A', 2: 'B', 3: 'C' }).expect(408);
    assert.equal(tooLate.body.deadlineExceeded, true);
    assert.equal(tooLate.body.finalizedByServer, true);
    const [deliveredAna] = submissionsOf(ana, application.id);
    assert.equal(deliveredAna.submissionSource, 'deadline_server_auto_submit');
    assert.equal(deliveredAna.answeredCount, 1);
    const again = await submit(ana, application.id, startedAna, { 1: 'A', 2: 'B', 3: 'C' }).expect(200);
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.finalizedByServer, true);
    assert.equal(submissionsOf(ana, application.id)[0].answeredCount, 1);

    // Envio manual muito depois do prazo também não reabre a tentativa.
    const startedBruno = await startAttempt(bruno, application.id);
    await autosave(bruno, application.id, startedBruno.attemptId, { 2: 'B' }).expect(200);
    expireAttempt(startedBruno.attemptId, 40000);
    await submit(bruno, application.id, startedBruno, { 1: 'A', 2: 'B', 3: 'C' }, false).expect(408);
    const [deliveredBruno] = submissionsOf(bruno, application.id);
    assert.equal(deliveredBruno.submissionSource, 'deadline_server_auto_submit');
    assert.equal(deliveredBruno.correctCount, 1);
    await control(application.id, 'finish');
});

test('[UC-TENTATIVA-001] cronômetro coletivo esgotado: a tentativa vencida vira entrega e ninguém ganha prazo novo (CONF-02)', async () => {
    const { ana, bruno } = students;
    const application = await createApplication({ timerMode: 'collective', maxAttempts: 2 });
    const startedAna = await startAttempt(ana, application.id);
    await autosave(ana, application.id, startedAna.attemptId, { 3: 'C' }).expect(200);

    const shift = DURATION_MIN * MIN + 40000;
    applicationOf(application.id).startsAt -= shift;
    stateOf(startedAna.attemptId).startedAt -= shift;

    const afterDeadline = await sync(ana, application.id, startedAna.attemptId);
    assert.equal(afterDeadline.body.attemptOutcome.finalizedByServer, true);
    assert.equal(afterDeadline.body.attemptsUsed, 1);
    assert.equal(afterDeadline.body.timeOver, true);
    assert.equal(openStatesOf(ana, application.id).length, 0, 'nenhuma tentativa nova nasce já vencida');
    assert.equal(submissionsOf(ana, application.id)[0].correctCount, 1);

    await sync(bruno, application.id);
    const late = await request(app)
        .post(`/api/student/exam-applications/${application.id}/start-attempt`)
        .set('x-session-token', bruno.token)
        .send({})
        .expect(409);
    assert.equal(late.body.timeOver, true);
    assert.equal(openStatesOf(bruno, application.id).some(state => state.startedAt), false);
    assert.equal(submissionsOf(bruno, application.id).length, 0);
    await control(application.id, 'finish');
});

test('[UC-TENTATIVA-001] encerrar entrega quem estava com tempo esgotado em qualquer escolha (CONF-02, CONF-X4)', async () => {
    const { ana, bruno, carla, diego } = students;
    const application = await createApplication({ timerMode: 'per_attempt' });
    // Diego só abriu as instruções (a tentativa existe, mas não começou).
    const diegoOpened = await sync(diego, application.id);
    assert.ok(diegoOpened.body.attemptId);
    const startedAna = await startAttempt(ana, application.id);
    await autosave(ana, application.id, startedAna.attemptId, { 1: 'A' }).expect(200);
    expireAttempt(startedAna.attemptId, 5000);
    const startedBruno = await startAttempt(bruno, application.id);
    await autosave(bruno, application.id, startedBruno.attemptId, { 1: 'A', 2: 'B' }).expect(200);

    const summary = await request(app)
        .get(`/api/admin/exam-applications/${application.id}/finish-summary`)
        .set('x-admin-session', adminToken)
        .expect(200);
    assert.equal(summary.body.summary.inProgressAttempts, 1);
    assert.equal(summary.body.summary.timeOverAttempts, 1);

    const finished = await control(application.id, 'finish', { inProgressPolicy: 'discard' });
    assert.equal(finished.body.finish.deliveredAtDeadline, 1);
    assert.equal(finished.body.finish.discarded, 1);
    const [deliveredAna] = submissionsOf(ana, application.id);
    assert.equal(deliveredAna.submissionSource, 'deadline_server_auto_submit');
    assert.equal(deliveredAna.correctCount, 1);
    assert.equal(submissionsOf(bruno, application.id).length, 0);
    assert.equal(Object.values(db.memory.studentExamState).some(state => state?.applicationId === application.id), false);

    // Quem foi entregue no fim do tempo vê a própria entrega, mesmo abrindo a prova em
    // outro aparelho (sem a tentativa conhecida), e não "o professor desconsiderou".
    const anaElsewhere = await sync(ana, application.id);
    assert.equal(anaElsewhere.body.finishOutcome, 'delivered');
    assert.equal(anaElsewhere.body.attemptOutcome.attemptId, startedAna.attemptId);
    assert.equal(anaElsewhere.body.attemptOutcome.finalizedByServer, true);
    assert.equal(anaElsewhere.body.attemptOutcome.answeredCount, 1);
    const brunoKnown = await sync(bruno, application.id, startedBruno.attemptId);
    assert.equal(brunoKnown.body.finishOutcome, 'discarded');
    const brunoElsewhere = await sync(bruno, application.id);
    assert.equal(brunoElsewhere.body.finishOutcome, 'discarded');

    // Só quem tinha tentativa em andamento ouve que o professor desconsiderou: quem nunca
    // abriu a prova ou só leu as instruções vê apenas que a aplicação foi encerrada.
    assert.deepEqual(applicationOf(application.id).finishResolution.discardedAttempts,
        [{ studentEmail: bruno.email, attemptId: startedBruno.attemptId }]);
    const carlaNeverOpened = await sync(carla, application.id);
    assert.equal(carlaNeverOpened.body.finishOutcome, null);
    const diegoInstructions = await sync(diego, application.id, diegoOpened.body.attemptId);
    assert.equal(diegoInstructions.body.finishOutcome, null);
    assert.equal((await sync(diego, application.id)).body.finishOutcome, null);

    // Encerramento gravado por versão anterior (sem a lista): vale a tentativa conhecida.
    delete applicationOf(application.id).finishResolution.discardedAttempts;
    assert.equal((await sync(bruno, application.id, startedBruno.attemptId)).body.finishOutcome, 'discarded');
    assert.equal((await sync(carla, application.id)).body.finishOutcome, null);
    assert.equal((await sync(ana, application.id)).body.finishOutcome, 'delivered');
});

test('[UC-TENTATIVA-001] aluno travado por perda de foco no fim do tempo tem as respostas salvas entregues (AVA-03)', async () => {
    const { ana, bruno } = students;
    const application = await createApplication({ timerMode: 'per_attempt' });
    const startedAna = await startAttempt(ana, application.id);
    await autosave(ana, application.id, startedAna.attemptId, { 1: 'A', 3: 'C' }).expect(200);
    await request(app)
        .post('/api/student/log-activity')
        .set('x-session-token', ana.token)
        .send({ email: ana.email, studentClass, courseId, examKey, applicationId: application.id, attemptId: startedAna.attemptId, eventType: 'tab_blur', details: 'Aba oculta' })
        .expect(200);
    assert.equal(stateOf(startedAna.attemptId).focusLocked, true);
    expireAttempt(startedAna.attemptId, 40000);
    const finalized = await sync(ana, application.id, startedAna.attemptId);
    assert.equal(finalized.body.attemptOutcome.finalizedByServer, true);
    assert.equal(submissionsOf(ana, application.id)[0].correctCount, 2);

    // Bloqueado e com o tempo acabando: o envio automático vale (não 423).
    const startedBruno = await startAttempt(bruno, application.id);
    await request(app)
        .post('/api/student/log-activity')
        .set('x-session-token', bruno.token)
        .send({ email: bruno.email, studentClass, courseId, examKey, applicationId: application.id, attemptId: startedBruno.attemptId, eventType: 'tab_blur', details: 'Aba oculta' })
        .expect(200);
    await submit(bruno, application.id, startedBruno, { 1: 'A' }).expect(423);
    expireAttempt(startedBruno.attemptId, 2000);
    // O tempo acabou bloqueado: a entrega é a do servidor, com o que estava salvo.
    const lockedAtDeadline = await submit(bruno, application.id, startedBruno, { 1: 'A' }).expect(408);
    assert.equal(lockedAtDeadline.body.focusLocked, true);
    assert.equal(lockedAtDeadline.body.finalizedByServer, true);
    assert.equal(submissionsOf(bruno, application.id)[0].answeredCount, 0);
    await control(application.id, 'finish');
});

test('[UC-TENTATIVA-001] prova bloqueada por foco: respostas mudadas durante o bloqueio não entram na nota (AVA-03)', async () => {
    const { carla } = students;
    const application = await createApplication({ timerMode: 'per_attempt' });
    const started = await startAttempt(carla, application.id);
    await autosave(carla, application.id, started.attemptId, { 1: 'A' }).expect(200);
    await request(app)
        .post('/api/student/log-activity')
        .set('x-session-token', carla.token)
        .send({ email: carla.email, studentClass, courseId, examKey, applicationId: application.id, attemptId: started.attemptId, eventType: 'fullscreen_exit', details: 'Saiu da tela cheia' })
        .expect(200);
    // O que ela marcou logo antes do bloqueio ainda chega (estava a caminho).
    await autosave(carla, application.id, started.attemptId, { 1: 'A', 2: 'B' }).expect(200);
    // Depois disso, com as questões ocultas, o rascunho é recusado até o professor liberar.
    stateOf(started.attemptId).focusLockedAt = Date.now() - 20000;
    const refused = await autosave(carla, application.id, started.attemptId, { 1: 'C', 2: 'C', 3: 'C' }).expect(423);
    assert.equal(refused.body.focusLocked, true);
    assert.deepEqual(stateOf(started.attemptId).answers, { 1: 'A', 2: 'B' });

    expireAttempt(started.attemptId, 2000);
    const atDeadline = await submit(carla, application.id, started, { 1: 'C', 2: 'C', 3: 'C' }).expect(408);
    assert.equal(atDeadline.body.focusLocked, true);
    assert.equal(atDeadline.body.finalizedByServer, true);
    assert.equal(atDeadline.body.answeredCount, 2);
    let [delivered] = submissionsOf(carla, application.id);
    assert.equal(delivered.submissionSource, 'deadline_server_auto_submit');
    assert.equal(delivered.focusLockedAtDeadline, true);
    assert.equal(delivered.correctCount, 2);

    // O envio automático atrasado não substitui a entrega de quem terminou bloqueado.
    const retry = await submit(carla, application.id, started, { 1: 'C', 2: 'C', 3: 'C' }).expect(200);
    assert.equal(retry.body.duplicate, true);
    [delivered] = submissionsOf(carla, application.id);
    assert.equal(submissionsOf(carla, application.id).length, 1);
    assert.equal(delivered.correctCount, 2);

    const monitor = await request(app)
        .get(`/api/admin/monitor-status/${encodeURIComponent(studentClass)}/${encodeURIComponent(examKey)}`)
        .set('x-admin-session', adminToken)
        .query({ courseId, applicationId: application.id })
        .expect(200);
    const row = monitor.body.find(item => item.email === carla.email);
    assert.equal(row.focusLockedAtDeadline, true);
    assert.equal(row.progress, '2/3');
    await control(application.id, 'finish');
});

test('[UC-TENTATIVA-001] envio manual depois do prazo só vale dentro do atraso normal de rede (5 s)', async () => {
    const { ana, bruno } = students;
    const application = await createApplication({ timerMode: 'per_attempt' });
    const startedAna = await startAttempt(ana, application.id);
    await autosave(ana, application.id, startedAna.attemptId, { 1: 'A' }).expect(200);
    expireAttempt(startedAna.attemptId, 3000);
    const onTime = await submit(ana, application.id, startedAna, { 1: 'A', 2: 'B' }, false).expect(200);
    assert.equal(onTime.body.lateBySeconds, 0);
    assert.equal(submissionsOf(ana, application.id)[0].submissionSource, 'student');

    const startedBruno = await startAttempt(bruno, application.id);
    await autosave(bruno, application.id, startedBruno.attemptId, { 2: 'B' }).expect(200);
    expireAttempt(startedBruno.attemptId, 8000);
    const late = await submit(bruno, application.id, startedBruno, { 1: 'A', 2: 'B', 3: 'C' }, false).expect(408);
    assert.equal(late.body.finalizedByServer, true);
    const [deliveredBruno] = submissionsOf(bruno, application.id);
    assert.equal(deliveredBruno.submissionSource, 'deadline_server_auto_submit');
    assert.equal(deliveredBruno.correctCount, 1);

    // Repetir o mesmo envio marcado como "automático" não contorna o limite do manual:
    // a entrega do servidor fica, sem troca de respostas.
    const forged = await submit(bruno, application.id, startedBruno, { 1: 'A', 2: 'B', 3: 'C' }, true).expect(200);
    assert.equal(forged.body.duplicate, true);
    assert.equal(forged.body.replacedServerFinalization, undefined);
    assert.equal(submissionsOf(bruno, application.id).length, 1);
    assert.equal(submissionsOf(bruno, application.id)[0].correctCount, 1);
    assert.equal(submissionsOf(bruno, application.id)[0].submissionSource, 'deadline_server_auto_submit');
    assert.equal(submissionsOf(bruno, application.id)[0].serverFinalization, undefined);
    await control(application.id, 'finish');
});

test('[UC-TENTATIVA-001] pausar congela o cronômetro; pausa maior que o tempo restante não vence nem apaga respostas (AVA-10, CONF-X1)', async () => {
    const { ana } = students;
    const application = await createApplication({ timerMode: 'per_attempt' });
    const started = await startAttempt(ana, application.id);
    await autosave(ana, application.id, started.attemptId, { 1: 'A' }).expect(200);

    // Restavam 60 s quando o professor pausou, há 5 minutos.
    await control(application.id, 'pause');
    const stored = applicationOf(application.id);
    assert.equal(stored.pauses.length, 1);
    stored.pauses[0].pausedAt = Date.now() - 5 * MIN;
    stateOf(started.attemptId).startedAt = Date.now() - 5 * MIN - (DURATION_MIN * MIN - 60000);

    const duringPause = await sync(ana, application.id, started.attemptId);
    assert.equal(duringPause.body.attemptId, started.attemptId);
    assert.ok(duringPause.body.state.timerRemaining >= 58 && duringPause.body.state.timerRemaining <= 60, `restante na pausa: ${duringPause.body.state.timerRemaining}`);
    assert.deepEqual(duringPause.body.state.answers, asStudentAnswers(application.id, { 1: 'A' }));
    assert.equal(duringPause.body.attemptOutcome, null);
    await autosave(ana, application.id, started.attemptId, { 1: 'A', 2: 'B' }).expect(200);

    await control(application.id, 'resume');
    assert.equal(stored.pausedAt, null);
    assert.ok(stored.pauses[0].resumedAt > 0);
    const afterResume = await sync(ana, application.id, started.attemptId);
    assert.ok(afterResume.body.state.timerRemaining >= 58 && afterResume.body.state.timerRemaining <= 60, `restante após retomar: ${afterResume.body.state.timerRemaining}`);
    assert.deepEqual(afterResume.body.state.answers, asStudentAnswers(application.id, { 1: 'A', 2: 'B' }));

    const monitor = await request(app)
        .get(`/api/admin/monitor-status/${encodeURIComponent(studentClass)}/${encodeURIComponent(examKey)}`)
        .set('x-admin-session', adminToken)
        .query({ courseId, applicationId: application.id })
        .expect(200);
    const row = monitor.body.find(item => item.email === ana.email);
    assert.notEqual(row.status, 'time_over');
    assert.ok(row.timerRemaining >= 58 && row.timerRemaining <= 60);
    assert.equal(submissionsOf(ana, application.id).length, 0);
    await control(application.id, 'finish', { inProgressPolicy: 'discard' });
});

test('[UC-TENTATIVA-001] retomar no modo coletivo não reinicia o relógio: quem começa depois recebe só o tempo restante (AVA-10)', async () => {
    const { bruno } = students;
    const application = await createApplication({ timerMode: 'collective' });
    const stored = applicationOf(application.id);
    // A prova correu 30 s, ficou 30 s pausada e foi retomada agora.
    const originalStart = Date.now() - 60000;
    stored.startsAt = originalStart;
    await control(application.id, 'pause');
    stored.pauses[0].pausedAt = Date.now() - 30000;
    const resumed = await control(application.id, 'resume');
    assert.equal(Number(resumed.body.application.startsAt), originalStart);

    const started = await startAttempt(bruno, application.id);
    const remaining = Number(started.state.timerRemaining);
    assert.ok(remaining >= DURATION_MIN * 60 - 32 && remaining <= DURATION_MIN * 60 - 28, `restante para quem começa depois: ${remaining}`);
    await control(application.id, 'finish', { inProgressPolicy: 'discard' });
});

test('[UC-TENTATIVA-001] tempo extra para UM aluno não reabre tentativa vencida; o da turma logo depois do fim reabre (AVA-03)', async () => {
    const { ana, bruno, carla } = students;
    const application = await createApplication({ timerMode: 'per_attempt' });
    const startedAna = await startAttempt(ana, application.id);
    await autosave(ana, application.id, startedAna.attemptId, { 1: 'A' }).expect(200);
    expireAttempt(startedAna.attemptId, 3000);
    const refused = await request(app)
        .post(`/api/admin/exam-applications/${application.id}/time-adjustment`)
        .set('x-admin-session', adminToken)
        .send({ targetEmail: ana.email, adjustmentMinutes: 5 })
        .expect(409);
    assert.equal(refused.body.attemptFinalized, true);
    assert.equal(submissionsOf(ana, application.id)[0].submissionSource, 'deadline_server_auto_submit');

    const startedBruno = await startAttempt(bruno, application.id);
    expireAttempt(startedBruno.attemptId, 3000);
    await request(app)
        .post('/api/admin/adjust-student-time')
        .set('x-admin-session', adminToken)
        .send({ studentClass, courseId, examKey, applicationId: application.id, targetEmail: bruno.email, adjustmentMinutes: 5 })
        .expect(409);
    assert.equal(submissionsOf(bruno, application.id).length, 1);

    // +5 min para a TURMA logo depois do fim do tempo: as entregas automáticas do fim do
    // tempo (ana e bruno, há segundos) e a da carla (entregue pelo próprio ajuste) voltam
    // para a prova com o tempo extra.
    const startedCarla = await startAttempt(carla, application.id);
    expireAttempt(startedCarla.attemptId, 3000);
    const classAdjust = await request(app)
        .post(`/api/admin/exam-applications/${application.id}/time-adjustment`)
        .set('x-admin-session', adminToken)
        .send({ adjustmentMinutes: 5 })
        .expect(200);
    assert.equal(classAdjust.body.reopenedAtDeadline, 3);
    assert.equal(classAdjust.body.deliveredAtDeadline, 0);
    for (const [student, started] of [[ana, startedAna], [bruno, startedBruno], [carla, startedCarla]]) {
        assert.equal(submissionsOf(student, application.id).length, 0);
        const [open] = openStatesOf(student, application.id);
        assert.equal(open.attemptId, started.attemptId, 'a mesma tentativa volta, nunca uma nova');
        assert.equal(open.status, 'active');
    }
    assert.deepEqual(stateOf(startedAna.attemptId).answers, { 1: 'A' });

    // O "+5 min" do Monitor (turma inteira) logo depois do fim do tempo do diego.
    const startedDiego = await startAttempt(students.diego, application.id);
    stateOf(startedDiego.attemptId).startedAt = Date.now() - (DURATION_MIN + 5) * MIN - 2000;
    const monitorAdjust = await request(app)
        .post('/api/admin/adjust-student-time')
        .set('x-admin-session', adminToken)
        .send({ studentClass, courseId, examKey, applicationId: application.id, adjustmentMinutes: 5 })
        .expect(200);
    assert.equal(monitorAdjust.body.success, true);
    assert.equal(monitorAdjust.body.reopenedAtDeadline, 1);
    assert.equal(monitorAdjust.body.deliveredAtDeadline, 0);
    assert.equal(submissionsOf(students.diego, application.id).length, 0);
    assert.equal(openStatesOf(students.diego, application.id)[0].attemptId, startedDiego.attemptId);
    const nobodyLate = await request(app)
        .post('/api/admin/adjust-student-time')
        .set('x-admin-session', adminToken)
        .send({ studentClass, courseId, examKey, applicationId: application.id, adjustmentMinutes: 5 })
        .expect(200);
    assert.equal(nobodyLate.body.reopenedAtDeadline, 0);
    assert.equal(nobodyLate.body.deliveredAtDeadline, 0);
    await control(application.id, 'finish', { inProgressPolicy: 'discard' });
});

test('[UC-TENTATIVA-001] +N min da turma até 2 min depois do fim do tempo coletivo reabre só as entregas automáticas (AVA-03)', async () => {
    const { ana, bruno, carla, diego } = students;
    const application = await createApplication({ timerMode: 'collective', maxAttempts: 1 });
    const startedAna = await startAttempt(ana, application.id);
    const startedBruno = await startAttempt(bruno, application.id);
    const startedCarla = await startAttempt(carla, application.id);
    const startedDiego = await startAttempt(diego, application.id);
    await autosave(ana, application.id, startedAna.attemptId, { 1: 'A' }).expect(200);
    await autosave(bruno, application.id, startedBruno.attemptId, { 1: 'A', 2: 'C' }).expect(200);
    // Carla envia por conta própria antes do fim: nunca é reaberta.
    await submit(carla, application.id, startedCarla, { 1: 'A', 2: 'B' }, false).expect(200);

    // O tempo coletivo acabou há 3 s.
    const shift = DURATION_MIN * MIN + 3000;
    applicationOf(application.id).startsAt -= shift;
    [startedAna, startedBruno, startedDiego].forEach(started => { stateOf(started.attemptId).startedAt -= shift; });
    // Ana: o navegador entregou no zero. Diego: também, mas a nota já foi publicada.
    // Bruno: sem rede, o servidor entrega o que estava salvo.
    await submit(ana, application.id, startedAna, { 1: 'A', 2: 'B' }).expect(200);
    await submit(diego, application.id, startedDiego, { 1: 'A' }).expect(200);
    submissionsOf(diego, application.id)[0].gradePublished = true;
    assert.equal(settleExpiredAttempts(db.memory, { applicationId: application.id, graceMs: 0 }).finalized.length, 1);
    assert.equal(submissionsOf(bruno, application.id)[0].submissionSource, 'deadline_server_auto_submit');
    assert.equal(submissionsOf(ana, application.id)[0].submissionSource, 'timer_auto_submit');

    const adjusted = await request(app)
        .post('/api/admin/adjust-student-time')
        .set('x-admin-session', adminToken)
        .send({ studentClass, courseId, examKey, applicationId: application.id, adjustmentMinutes: 5 })
        .expect(200);
    assert.equal(adjusted.body.reopenedAtDeadline, 2);
    assert.equal(adjusted.body.deliveredAtDeadline, 1, 'diego: nota publicada');
    assert.equal(adjusted.body.deliveredByStudent, 1, 'carla: enviou por conta própria');
    assert.equal(submissionsOf(carla, application.id).length, 1);
    assert.equal(submissionsOf(diego, application.id).length, 1);
    assert.equal(openStatesOf(carla, application.id).length, 0);
    assert.equal(openStatesOf(diego, application.id).length, 0);

    // Ana volta para a mesma tentativa, com as respostas da entrega e o prazo novo.
    const anaBack = await sync(ana, application.id, startedAna.attemptId);
    assert.equal(anaBack.body.attemptId, startedAna.attemptId);
    assert.equal(anaBack.body.attemptOutcome, null);
    assert.equal(anaBack.body.attemptsUsed, 0);
    assert.ok(anaBack.body.state.reopenedAt > 0);
    assert.equal(anaBack.body.state.reopenedFrom, undefined, 'o histórico da reabertura é do professor');
    assert.deepEqual(anaBack.body.state.answers, asStudentAnswers(application.id, { 1: 'A', 2: 'B' }));
    const remaining = Number(anaBack.body.state.timerRemaining);
    assert.ok(remaining > 4 * 60 && remaining <= 5 * 60, `tempo extra: ${remaining}`);
    assert.ok(anaBack.body.localCopyKey, 'a tentativa reaberta ganha uma chave nova da cópia local');
    assert.ok(db.memory.auditLogs.some(log => log.type === 'exam_attempt_reopened_extra_time'
        && log.details.attemptId === startedAna.attemptId && log.details.submissionSource === 'timer_auto_submit'));
    const bobBack = await sync(bruno, application.id, startedBruno.attemptId);
    assert.deepEqual(bobBack.body.state.answers, asStudentAnswers(application.id, { 1: 'A', 2: 'C' }));

    // A tela que ainda tentava o envio automático congelado no zero não entrega de novo:
    // o servidor responde que a prova continua.
    const stale = await submit(ana, application.id, startedAna, { 1: 'A', 2: 'B' }).expect(409);
    assert.equal(stale.body.deadlineExtended, true);
    assert.ok(stale.body.timerRemaining > 4 * 60);
    assert.equal(submissionsOf(ana, application.id).length, 0);

    // Ana termina e envia: a entrega mostra ao professor que a tentativa foi reaberta.
    await submit(ana, application.id, startedAna, { 1: 'A', 2: 'B', 3: 'C' }, false).expect(200);
    const [final] = submissionsOf(ana, application.id);
    assert.equal(final.attemptId, startedAna.attemptId);
    assert.equal(final.correctCount, 3);
    assert.ok(Date.parse(final.reopenedAt) > 0);
    assert.equal(final.reopenedFrom[0].source, 'timer_auto_submit');
    assert.equal(final.reopenedFrom[0].answeredCount, 2);
    const mine = await request(app)
        .post('/api/student/my-submissions')
        .set('x-session-token', ana.token)
        .send({ studentClass, courseId })
        .expect(200);
    assert.equal(mine.body.submissions.find(item => item.attemptId === startedAna.attemptId).reopenableState, undefined);

    // Passados os 2 min do fim do tempo, o +N min não reabre mais (e avisa).
    const brunoState = stateOf(startedBruno.attemptId);
    brunoState.startedAt -= 5 * MIN + 3 * MIN;
    applicationOf(application.id).startsAt -= 5 * MIN + 3 * MIN;
    const late = await request(app)
        .post('/api/admin/adjust-student-time')
        .set('x-admin-session', adminToken)
        .send({ studentClass, courseId, examKey, applicationId: application.id, adjustmentMinutes: 5 })
        .expect(200);
    assert.equal(late.body.reopenedAtDeadline, 0);
    assert.equal(late.body.deliveredAtDeadline, 2, 'bruno (fim do tempo há 3 min) e diego (nota publicada)');
    assert.equal(submissionsOf(bruno, application.id).length, 1);
    assert.equal(openStatesOf(bruno, application.id).length, 0);

    // Tirar tempo da turma nunca reabre nada.
    const minus = await request(app)
        .post('/api/admin/adjust-student-time')
        .set('x-admin-session', adminToken)
        .send({ studentClass, courseId, examKey, applicationId: application.id, adjustmentMinutes: -1 })
        .expect(200);
    assert.equal(minus.body.reopenedAtDeadline, 0);
    await control(application.id, 'finish');
});

function monitorRows(applicationId) {
    return request(app)
        .get(`/api/admin/monitor-status/${encodeURIComponent(studentClass)}/${encodeURIComponent(examKey)}`)
        .set('x-admin-session', adminToken)
        .query({ courseId, applicationId })
        .expect(200);
}

function classExtraTime(applicationId, adjustmentMinutes = 5) {
    return request(app)
        .post('/api/admin/adjust-student-time')
        .set('x-admin-session', adminToken)
        .send({ studentClass, courseId, examKey, applicationId, adjustmentMinutes })
        .expect(200);
}

test('[UC-TENTATIVA-001] tentativa reaberta pelo "+N min" e desconsiderada no encerramento mantém a entrega do fim do tempo (G1-mais5)', async () => {
    const { ana, bruno, carla } = students;
    const application = await createApplication({ timerMode: 'collective', maxAttempts: 1 });
    const startedAna = await startAttempt(ana, application.id);
    const startedBruno = await startAttempt(bruno, application.id);
    const startedCarla = await startAttempt(carla, application.id);
    await autosave(ana, application.id, startedAna.attemptId, { 1: 'A', 2: 'B' }).expect(200);
    await autosave(carla, application.id, startedCarla.attemptId, { 1: 'A' }).expect(200);

    // O tempo coletivo acabou há 3 s: o navegador da ana entregou no zero; a carla ficou
    // sem rede e o servidor entregou o que estava salvo.
    const shift = DURATION_MIN * MIN + 3000;
    applicationOf(application.id).startsAt -= shift;
    [startedAna, startedBruno, startedCarla].forEach(started => { stateOf(started.attemptId).startedAt -= shift; });
    await submit(ana, application.id, startedAna, { 1: 'A', 2: 'B' }).expect(200);
    await submit(bruno, application.id, startedBruno, { 1: 'C' }).expect(200);
    settleExpiredAttempts(db.memory, { applicationId: application.id, graceMs: 0 });
    const [anaDelivery] = submissionsOf(ana, application.id);
    const anaDeliveryCopy = JSON.parse(JSON.stringify(anaDelivery));
    assert.equal(anaDelivery.correctCount, 2);

    const adjusted = await classExtraTime(application.id);
    assert.equal(adjusted.body.reopenedAtDeadline, 3);
    assert.equal(adjusted.body.reopenedLocked, 0);
    assert.equal(submissionsOf(ana, application.id).length, 0);
    // A entrega fica guardada na tentativa reaberta, nunca no que vai para o aluno.
    const anaState = stateOf(startedAna.attemptId);
    assert.equal(anaState.reopenedDelivery.id, anaDelivery.id);
    assert.equal(anaState.reopenedDelivery.reopenableState, undefined);
    assert.equal(anaState.reopenedFrom.at(-1).score, anaDelivery.score);
    const anaBack = await sync(ana, application.id, startedAna.attemptId);
    assert.equal(anaBack.body.state.reopenedDelivery, undefined);
    assert.equal(anaBack.body.state.reopenedFrom, undefined);

    // Monitor: a tentativa em andamento mostra que foi reaberta.
    const during = (await monitorRows(application.id)).body.find(item => item.email === ana.email);
    assert.equal(during.status, 'online');
    assert.ok(Date.parse(during.reopenedAt) > 0);

    // Bruno termina e envia de novo: a entrega nova substitui a do fim do tempo.
    await submit(bruno, application.id, startedBruno, { 1: 'A', 2: 'B', 3: 'C' }, false).expect(200);
    const [brunoFinal] = submissionsOf(bruno, application.id);
    assert.equal(brunoFinal.correctCount, 3);
    assert.equal(brunoFinal.reopenedFrom.at(-1).source, 'timer_auto_submit');
    const brunoMine = await request(app)
        .post('/api/student/my-submissions')
        .set('x-session-token', bruno.token)
        .send({ studentClass, courseId })
        .expect(200);
    const brunoSeen = brunoMine.body.submissions.find(item => item.attemptId === startedBruno.attemptId);
    assert.equal(brunoSeen.reopenedFrom, undefined, 'a nota da entrega substituída não vai para o aluno');

    // Ana e carla continuam fazendo a prova no tempo extra; o professor encerra e
    // desconsidera o que está em andamento.
    await autosave(ana, application.id, startedAna.attemptId, { 1: 'C', 2: 'C', 3: 'C' }).expect(200);
    const summary = await request(app)
        .get(`/api/admin/exam-applications/${application.id}/finish-summary`)
        .set('x-admin-session', adminToken)
        .expect(200);
    assert.equal(summary.body.summary.inProgressAttempts, 2);
    assert.equal(summary.body.summary.reopenedAttempts, 2);
    const finished = await control(application.id, 'finish', { inProgressPolicy: 'discard' });
    assert.equal(finished.body.finish.restoredDeliveries, 2);
    assert.equal(finished.body.finish.discarded, 0);

    // A entrega que a ana já tinha volta como estava (mesma entrega, mesma nota).
    const anaAfter = submissionsOf(ana, application.id);
    assert.equal(anaAfter.length, 1);
    assert.equal(anaAfter[0].id, anaDeliveryCopy.id);
    assert.equal(anaAfter[0].score, anaDeliveryCopy.score);
    assert.equal(anaAfter[0].correctCount, 2);
    assert.deepEqual(anaAfter[0].gradedAnswers, anaDeliveryCopy.gradedAnswers);
    assert.ok(anaAfter[0].restoredAfterDiscard?.at);
    assert.equal(submissionsOf(carla, application.id)[0].submissionSource, 'deadline_server_auto_submit');
    assert.equal(openStatesOf(ana, application.id).length, 0);
    assert.ok(db.memory.auditLogs.some(log => log.type === 'exam_attempt_reopen_discarded'
        && log.details.attemptId === startedAna.attemptId && log.details.submissionId === anaDeliveryCopy.id));
    assert.deepEqual(applicationOf(application.id).finishResolution.discardedAttempts, []);

    // O aluno vê a entrega, não "o professor desconsiderou"; o Monitor também.
    const anaFinal = await sync(ana, application.id, startedAna.attemptId);
    assert.equal(anaFinal.body.finishOutcome, 'delivered');
    assert.equal(anaFinal.body.attemptOutcome.attemptId, startedAna.attemptId);
    const rows = (await monitorRows(application.id)).body;
    const anaRow = rows.find(item => item.email === ana.email);
    assert.equal(anaRow.status, 'finished');
    assert.equal(anaRow.restoredAfterDiscard, true);
    const mine = await request(app)
        .post('/api/student/my-submissions')
        .set('x-session-token', ana.token)
        .send({ studentClass, courseId })
        .expect(200);
    assert.equal(mine.body.submissions.find(item => item.attemptId === startedAna.attemptId).restoredAfterDiscard, undefined);
});

test('[UC-TENTATIVA-001] "+N min" no meio da prova não avisa de quem já enviou; reaberta bloqueada por foco é contada (G1-mais5)', async () => {
    const { ana, bruno, carla } = students;
    const application = await createApplication({ timerMode: 'collective', maxAttempts: 1 });
    const startedAna = await startAttempt(ana, application.id);
    const startedBruno = await startAttempt(bruno, application.id);
    const startedCarla = await startAttempt(carla, application.id);
    // Ana envia por conta própria no meio da prova: o "+5 min" não tem aviso para ela.
    await submit(ana, application.id, startedAna, { 1: 'A' }, false).expect(200);
    const middle = await classExtraTime(application.id);
    assert.equal(middle.body.reopenedAtDeadline, 0);
    assert.equal(middle.body.deliveredAtDeadline, 0);
    assert.equal(middle.body.deliveredByStudent, 0);

    // Bruno fica bloqueado por perda de foco e o tempo acaba: o servidor entrega o que
    // estava salvo. O "+5 min" reabre a tentativa dele, mas ela volta bloqueada.
    await autosave(bruno, application.id, startedBruno.attemptId, { 1: 'A' }).expect(200);
    await request(app)
        .post('/api/student/log-activity')
        .set('x-session-token', bruno.token)
        .send({ email: bruno.email, studentClass, courseId, examKey, applicationId: application.id, attemptId: startedBruno.attemptId, eventType: 'tab_blur', details: 'Aba oculta' })
        .expect(200);
    const shift = (DURATION_MIN + 5) * MIN + 3000;
    applicationOf(application.id).startsAt -= shift;
    [startedBruno, startedCarla].forEach(started => { stateOf(started.attemptId).startedAt -= shift; });
    await submit(carla, application.id, startedCarla, { 1: 'A' }).expect(200);
    settleExpiredAttempts(db.memory, { applicationId: application.id, graceMs: 0 });
    assert.equal(submissionsOf(bruno, application.id)[0].focusLockedAtDeadline, true);

    const after = await classExtraTime(application.id);
    assert.equal(after.body.reopenedAtDeadline, 2);
    assert.equal(after.body.reopenedLocked, 1);
    assert.equal(after.body.deliveredByStudent, 1, 'depois do fim do tempo, quem enviou por conta própria entra no aviso');
    assert.equal(stateOf(startedBruno.attemptId).focusLocked, true);
    const brunoRow = (await monitorRows(application.id)).body.find(item => item.email === bruno.email);
    assert.equal(brunoRow.status, 'focus_locked');
    assert.ok(Date.parse(brunoRow.reopenedAt) > 0);
    await control(application.id, 'finish', { inProgressPolicy: 'submit' });
    const [brunoFinal] = submissionsOf(bruno, application.id);
    assert.equal(brunoFinal.submissionSource, 'instructor_finish');
    assert.ok(Date.parse(brunoFinal.reopenedAt) > 0);
});

test('[UC-TENTATIVA-001] reaberta duas vezes: guarda só a última entrega do fim do tempo, sem cópias aninhadas (G1-mais5)', async () => {
    const { diego } = students;
    const application = await createApplication({ timerMode: 'collective', maxAttempts: 1 });
    const started = await startAttempt(diego, application.id);
    await autosave(diego, application.id, started.attemptId, { 1: 'A' }).expect(200);
    applicationOf(application.id).startsAt -= DURATION_MIN * MIN + 3000;
    stateOf(started.attemptId).startedAt -= DURATION_MIN * MIN + 3000;
    await submit(diego, application.id, started, { 1: 'A' }).expect(200);
    const first = submissionsOf(diego, application.id)[0].id;
    assert.equal((await classExtraTime(application.id, 1)).body.reopenedAtDeadline, 1);

    // O minuto extra também acaba e o navegador entrega de novo no zero.
    applicationOf(application.id).startsAt -= MIN + 1000;
    stateOf(started.attemptId).startedAt -= MIN + 1000;
    await submit(diego, application.id, started, { 1: 'A', 2: 'B' }).expect(200);
    const second = submissionsOf(diego, application.id)[0];
    assert.notEqual(second.id, first);
    assert.equal(second.reopenableState.reopenedDelivery, undefined);
    assert.equal((await classExtraTime(application.id, 1)).body.reopenedAtDeadline, 1);
    const state = stateOf(started.attemptId);
    assert.equal(state.reopenedDelivery.id, second.id);
    assert.equal(state.reopenedDelivery.reopenableState, undefined);
    assert.equal(state.reopenedFrom.length, 2);
    assert.equal(JSON.stringify(state).split('"reopenedDelivery"').length - 1, 1, 'nenhuma cópia aninhada');

    await control(application.id, 'finish', { inProgressPolicy: 'discard' });
    const [kept] = submissionsOf(diego, application.id);
    assert.equal(kept.id, second.id);
    assert.equal(kept.correctCount, 2);
    assert.equal(kept.reopenedFrom.length, 1, 'a entrega mantida lembra a primeira reabertura');
});

test('[UC-TENTATIVA-001] entrega do fim do tempo gravada antes desta versão (sem o estado guardado) não é reaberta', async () => {
    const { ana } = students;
    const application = await createApplication({ timerMode: 'per_attempt' });
    const started = await startAttempt(ana, application.id);
    await autosave(ana, application.id, started.attemptId, { 1: 'A' }).expect(200);
    expireAttempt(started.attemptId, 3000);
    settleExpiredAttempts(db.memory, { applicationId: application.id, graceMs: 0 });
    delete submissionsOf(ana, application.id)[0].reopenableState;
    const adjusted = await request(app)
        .post(`/api/admin/exam-applications/${application.id}/time-adjustment`)
        .set('x-admin-session', adminToken)
        .send({ adjustmentMinutes: 5 })
        .expect(200);
    assert.equal(adjusted.body.reopenedAtDeadline, 0);
    assert.equal(adjusted.body.deliveredAtDeadline, 1);
    assert.equal(submissionsOf(ana, application.id).length, 1);
    await control(application.id, 'finish');
});

test('[UC-TENTATIVA-001] estado "expired" gravado por versão antiga vira entrega com as respostas, sem ser sobrescrito', async () => {
    const { carla } = students;
    const application = await createApplication({ timerMode: 'per_attempt' });
    const started = await startAttempt(carla, application.id);
    await autosave(carla, application.id, started.attemptId, { 1: 'A', 2: 'B', 3: 'C' }).expect(200);
    const legacy = expireAttempt(started.attemptId, 5000);
    legacy.status = 'expired';

    const response = await sync(carla, application.id, started.attemptId);
    assert.equal(response.body.attemptOutcome.finalizedByServer, true);
    const [delivered] = submissionsOf(carla, application.id);
    assert.equal(delivered.correctCount, 3);
    assert.equal(delivered.recoveredFromExpiredState, true);
    assert.equal(openStatesOf(carla, application.id).length, 0);
    await control(application.id, 'finish');
});

test('[UC-TENTATIVA-001] regras puras de pausa e tolerância', () => {
    const now = 10 * MIN;
    const paused = { pauses: [{ pausedAt: 2 * MIN, resumedAt: 4 * MIN }] };
    assert.equal(extendDeadlineByPauses(paused, 0, 5 * MIN, now), 7 * MIN, 'pausa durante a prova empurra o prazo');
    assert.equal(extendDeadlineByPauses(paused, 0, MIN, now), MIN, 'pausa depois do fim do tempo não reabre a tentativa');
    assert.equal(extendDeadlineByPauses(paused, 3 * MIN, 8 * MIN, now), 9 * MIN, 'só conta a parte da pausa depois do início');
    assert.equal(extendDeadlineByPauses({ pauses: [{ pausedAt: 6 * MIN }] }, 0, 7 * MIN, now), 11 * MIN, 'pausa em curso congela o relógio');

    const legacyPaused = { status: 'paused', updatedAt: new Date(3 * MIN).toISOString() };
    assert.equal(normalizeLegacyApplicationPause(legacyPaused, now), true);
    assert.deepEqual(legacyPaused.pauses, [{ pausedAt: 3 * MIN, resumedAt: null }]);
    assert.equal(normalizeLegacyApplicationPause(legacyPaused, now), false, 'migração idempotente');
    transitionExamApplication(legacyPaused, 'resume', { now: 5 * MIN });
    assert.equal(legacyPaused.pauses[0].resumedAt, 5 * MIN);

    // Pausa ainda na sala de espera, nos dois modos: retomar libera o início agora (o
    // status 'running' já liberava antes) e a pausa não empurra prazos de quem começa depois.
    for (const timerMode of ['per_attempt', 'collective']) {
        const waitingApp = { status: 'waiting', timerMode, startsAt: 3 * MIN };
        transitionExamApplication(waitingApp, 'pause', { now: MIN });
        transitionExamApplication(waitingApp, 'resume', { now: 2 * MIN });
        assert.equal(waitingApp.status, 'running');
        assert.equal(waitingApp.startsAt, 2 * MIN, `${timerMode}: início = retomada`);
        assert.equal(extendDeadlineByPauses(waitingApp, 2 * MIN, 32 * MIN, now), 32 * MIN);
    }

    assert.deepEqual(lateSubmitDecision({ overdueMs: 2000, auto: true }), { accept: true, lateMs: 0 });
    assert.deepEqual(lateSubmitDecision({ overdueMs: 3000, auto: false }), { accept: true, lateMs: 0 });
    assert.deepEqual(lateSubmitDecision({ overdueMs: 20000, auto: true }), { accept: true, lateMs: 20000 });
    assert.equal(lateSubmitDecision({ overdueMs: 20000, auto: false }).accept, false, 'envio manual não ganha a tolerância do automático');
    assert.equal(lateSubmitDecision({ overdueMs: 5 * MIN, auto: true }).accept, true);
    assert.equal(lateSubmitDecision({ overdueMs: 5 * MIN, auto: false }).accept, false);
    assert.equal(lateSubmitDecision({ overdueMs: LATE_AUTO_SUBMIT_TOLERANCE_MS + 1, auto: true }).accept, false);
});

test('[UC-TENTATIVA-001] chave da cópia local: 32 bytes por tentativa, guardada no servidor e entregue só ao dono enquanto a tentativa está aberta (AVA-11)', async () => {
    const { ana, bruno } = students;
    const application = await createApplication({ timerMode: 'per_attempt' });
    const startedAna = await startAttempt(ana, application.id);
    const key = startedAna.localCopyKey;
    assert.match(key, /^[A-Za-z0-9+/]{43}=$/);
    assert.equal(Buffer.from(key, 'base64').length, 32);
    assert.equal(startedAna.state.localCopyKey, undefined, 'a chave não vai dentro do estado');
    assert.equal(stateOf(startedAna.attemptId).localCopyKey, key, 'a chave fica guardada com a tentativa');

    const anaSync = await sync(ana, application.id, startedAna.attemptId);
    assert.equal(anaSync.body.localCopyKey, key);
    assert.equal(anaSync.body.state.localCopyKey, undefined);

    const startedBruno = await startAttempt(bruno, application.id);
    assert.notEqual(startedBruno.localCopyKey, key, 'cada tentativa tem a sua chave');
    // A sincronização de um aluno nunca traz a chave de outro.
    const brunoSync = await sync(bruno, application.id, startedAna.attemptId);
    assert.equal(brunoSync.body.localCopyKey, startedBruno.localCopyKey);
    assert.equal(brunoSync.body.attemptOutcome, null);

    // Tentativa iniciada antes desta versão ganha a chave na primeira sincronização.
    delete stateOf(startedBruno.attemptId).localCopyKey;
    const upgraded = await sync(bruno, application.id, startedBruno.attemptId);
    assert.match(upgraded.body.localCopyKey, /^[A-Za-z0-9+/]{43}=$/);
    assert.equal(stateOf(startedBruno.attemptId).localCopyKey, upgraded.body.localCopyKey);

    // Telas do professor não recebem a chave.
    const monitor = await request(app)
        .get(`/api/admin/monitor-status/${encodeURIComponent(studentClass)}/${encodeURIComponent(examKey)}`)
        .set('x-admin-session', adminToken)
        .query({ courseId, applicationId: application.id })
        .expect(200);
    assert.equal(JSON.stringify(monitor.body).includes(key), false);
    const unlocked = await request(app)
        .post('/api/admin/unlock-student-focus')
        .set('x-admin-session', adminToken)
        .send({ studentEmail: ana.email, studentClass, courseId, examKey, applicationId: application.id })
        .expect(200);
    assert.equal(unlocked.body.state.localCopyKey, undefined);

    // Entregue: a tentativa (e a chave) some do servidor e a sincronização não traz chave.
    await submit(ana, application.id, startedAna, { 1: 'A' }, false).expect(200);
    const afterSubmit = await sync(ana, application.id, startedAna.attemptId);
    assert.equal(afterSubmit.body.localCopyKey, null);
    assert.equal(afterSubmit.body.attemptOutcome.attemptId, startedAna.attemptId);
    assert.equal(JSON.stringify(db.memory.submissions).includes(key), false, 'a chave não vai para a entrega');
    await control(application.id, 'finish', { inProgressPolicy: 'discard' });
});

test('[UC-TENTATIVA-001] tempo coletivo acaba com o aluno nas instruções: a sincronização já avisa que o tempo terminou', async () => {
    const { bruno } = students;
    const application = await createApplication({ timerMode: 'collective' });
    const before = await sync(bruno, application.id);
    assert.equal(before.body.timeOver, false);
    assert.equal(before.body.state.status, 'instructions');

    applicationOf(application.id).startsAt -= DURATION_MIN * MIN + 40000;
    const after = await sync(bruno, application.id);
    assert.equal(after.body.timeOver, true);
    assert.ok(!after.body.state.startedAt);
    assert.equal(after.body.localCopyKey, null);
    const late = await request(app)
        .post(`/api/student/exam-applications/${application.id}/start-attempt`)
        .set('x-session-token', bruno.token)
        .send({})
        .expect(409);
    assert.equal(late.body.timeOver, true);
    await control(application.id, 'finish');
});

test('[UC-TENTATIVA-001] Monitor mostra quantas questões a entrega do fim do tempo de fato tem', async () => {
    const { ana } = students;
    const application = await createApplication({ timerMode: 'per_attempt' });
    const started = await startAttempt(ana, application.id);
    await autosave(ana, application.id, started.attemptId, { 1: 'A', 3: 'C' }).expect(200);
    expireAttempt(started.attemptId, 45000);
    const monitor = await request(app)
        .get(`/api/admin/monitor-status/${encodeURIComponent(studentClass)}/${encodeURIComponent(examKey)}`)
        .set('x-admin-session', adminToken)
        .query({ courseId, applicationId: application.id })
        .expect(200);
    const row = monitor.body.find(item => item.email === ana.email);
    assert.equal(row.status, 'finished');
    assert.equal(row.submissionSource, 'deadline_server_auto_submit');
    assert.equal(row.progress, '2/3');
    await control(application.id, 'finish');
});

test('[UC-TENTATIVA-001] tempo extra para quem já entregou avisa que não tem efeito; para quem não começou vale na tentativa (AVA-03)', async () => {
    const { ana, bruno } = students;
    const application = await createApplication({ timerMode: 'per_attempt', maxAttempts: 1 });
    const startedAna = await startAttempt(ana, application.id);
    await submit(ana, application.id, startedAna, { 1: 'A' }, false).expect(200);
    const legacyKeyOf = student => `${student.email}_${examKey}`;

    const refused = await request(app)
        .post('/api/admin/adjust-student-time')
        .set('x-admin-session', adminToken)
        .send({ studentClass, courseId, examKey, applicationId: application.id, targetEmail: ana.email, adjustmentMinutes: 5 })
        .expect(409);
    assert.equal(refused.body.alreadyDelivered, true);
    assert.equal(db.memory.studentExamState[legacyKeyOf(ana)], undefined, 'nenhum estado avulso é criado');
    assert.equal(openStatesOf(ana, application.id).length, 0);
    await request(app)
        .post(`/api/admin/exam-applications/${application.id}/time-adjustment`)
        .set('x-admin-session', adminToken)
        .send({ targetEmail: ana.email, adjustmentMinutes: 5 })
        .expect(409);
    const anaAfter = await sync(ana, application.id);
    assert.ok(!anaAfter.body.state?.status || anaAfter.body.state.status !== 'instructions');

    const pending = await request(app)
        .post('/api/admin/adjust-student-time')
        .set('x-admin-session', adminToken)
        .send({ studentClass, courseId, examKey, applicationId: application.id, targetEmail: bruno.email, adjustmentMinutes: 5 })
        .expect(200);
    assert.equal(pending.body.appliesToNextAttempt, true);
    assert.equal(db.memory.studentExamState[legacyKeyOf(bruno)], undefined);
    const startedBruno = await startAttempt(bruno, application.id);
    const remaining = Number(startedBruno.state.timerRemaining);
    assert.ok(remaining >= (DURATION_MIN + 5) * 60 - 3, `prazo com o ajuste: ${remaining}`);
    await control(application.id, 'finish', { inProgressPolicy: 'discard' });
});

test('[UC-TENTATIVA-001] tentativa vencida deixada por versão antiga em aplicação já encerrada: entrega com a hora do fim do tempo e aviso ao professor', async () => {
    const { carla } = students;
    const application = await createApplication({ timerMode: 'per_attempt' });
    await control(application.id, 'finish');
    const startedAt = Date.now() - (DURATION_MIN + 20) * MIN;
    db.memory.studentExamState[`${application.id}::${carla.email}::1`] = {
        id: 'attempt_legacy_carla',
        attemptId: 'attempt_legacy_carla',
        applicationId: application.id,
        studentEmail: carla.email,
        studentClass,
        courseId,
        examKey,
        attemptNumber: 1,
        status: 'expired',
        answers: { 1: 'A', 2: 'C' },
        assignedVersion: 'A',
        startedAt,
        individualTimeAdjustment: 0,
    };

    const { finalized } = settleExpiredAttempts(db.memory);
    assert.equal(finalized.length, 1);
    const [delivered] = submissionsOf(carla, application.id);
    assert.equal(delivered.recoveredAfterFinish, true);
    assert.equal(delivered.recoveredFromExpiredState, true);
    assert.equal(delivered.gradePublished, false);
    assert.equal(delivered.correctCount, 1);
    assert.equal(Date.parse(delivered.timestamp), startedAt + DURATION_MIN * MIN, 'a entrega leva a hora do fim do tempo');
    assert.ok(Date.parse(delivered.finalizedByServerAt) > Date.parse(delivered.timestamp));
    assert.ok(db.memory.auditLogs.some(log => log.type === 'exam_attempt_recovered_after_finish' && log.details.submissionId === delivered.id));

    const queue = await request(app)
        .get('/api/admin/dashboard/queue')
        .set('x-admin-session', adminToken)
        .query({ courseId, studentClass })
        .expect(200);
    const item = queue.body.find(entry => entry.id === 'provas_recuperadas');
    assert.ok(item, 'aparece no "Precisa de você"');
    assert.equal(item.count, 1);
    assert.equal(item.href, '/resultados');
    const bell = await request(app)
        .get('/api/admin/notifications')
        .set('x-admin-session', adminToken)
        .query({ courseId, studentClass })
        .expect(200);
    assert.ok(bell.body.items.some(entry => entry.id === 'provas_recuperadas' && entry.unread));

    // Publicada a nota, o aviso sai da fila.
    delivered.gradePublished = true;
    const cleared = await request(app)
        .get('/api/admin/dashboard/queue')
        .set('x-admin-session', adminToken)
        .query({ courseId, studentClass })
        .expect(200);
    assert.equal(cleared.body.some(entry => entry.id === 'provas_recuperadas'), false);
});

test('[UC-TENTATIVA-001] aplicação encerrada com "desconsiderar" em versão antiga: tentativa "expired" nunca fica para sempre em "entrega em instantes"', async () => {
    const { ana, bruno, carla, diego } = students;
    const application = await createApplication({ timerMode: 'per_attempt' });
    await control(application.id, 'finish', { inProgressPolicy: 'discard' });
    const finishedApp = applicationOf(application.id);
    // Encerramento gravado pela versão antiga: há 20 min, sem a lista de desconsideradas.
    const closedAt = Date.now() - 20 * MIN;
    finishedApp.endsAt = closedAt;
    finishedApp.finishedAt = new Date(closedAt).toISOString();
    delete finishedApp.finishResolution.discardedAttempts;
    const legacyState = (student, attemptId, startedAt, status = 'expired') => {
        db.memory.studentExamState[`${application.id}::${student.email}::1`] = {
            id: attemptId,
            attemptId,
            applicationId: application.id,
            studentEmail: student.email,
            studentClass,
            courseId,
            examKey,
            attemptNumber: 1,
            status,
            answers: { 1: 'A', 2: 'C' },
            assignedVersion: 'A',
            startedAt,
            individualTimeAdjustment: 0,
        };
    };
    // Ana: o tempo dela acabou 10 min antes do encerramento (regra atual: entrega do fim do tempo).
    legacyState(ana, 'attempt_legacy_ana', closedAt - (DURATION_MIN + 10) * MIN);
    // Bruno: marcado 'expired' com o tempo acabando depois do encerramento: desconsiderada.
    legacyState(bruno, 'attempt_legacy_bruno', closedAt - (DURATION_MIN - 5) * MIN);
    // Carla: em andamento ('active') quando a versão antiga encerrou sem decisão, mas o
    // tempo dela já tinha acabado: também é entrega do fim do tempo.
    legacyState(carla, 'attempt_legacy_carla2', closedAt - (DURATION_MIN + 2) * MIN, 'active');
    // Diego: em andamento no encerramento e sem 'expired': continua esperando a decisão.
    legacyState(diego, 'attempt_legacy_diego', closedAt - (DURATION_MIN - 5) * MIN, 'active');

    const monitorRows = async () => (await request(app)
        .get(`/api/admin/monitor-status/${encodeURIComponent(studentClass)}/${encodeURIComponent(examKey)}`)
        .set('x-admin-session', adminToken)
        .query({ courseId, applicationId: application.id })
        .expect(200)).body;
    const first = await monitorRows();
    const statusOf = (rows, student) => rows.find(row => row.email === student.email).status;
    assert.equal(statusOf(first, ana), 'finished');
    assert.equal(statusOf(first, bruno), 'discarded');
    assert.equal(statusOf(first, carla), 'finished');
    assert.ok(first.every(row => row.status !== 'time_over'), 'nenhuma linha "entrega automática em instantes" em aplicação encerrada');

    const [anaDelivered] = submissionsOf(ana, application.id);
    assert.equal(anaDelivered.recoveredAfterFinish, true);
    assert.equal(anaDelivered.correctCount, 1);
    assert.equal(submissionsOf(bruno, application.id).length, 0);
    const brunoState = stateOf('attempt_legacy_bruno');
    assert.equal(brunoState.status, 'invalidated');
    assert.equal(brunoState.discardedAtFinish, true);
    assert.deepEqual(brunoState.answers, { 1: 'A', 2: 'C' }, 'as respostas ficam guardadas');
    assert.equal(submissionsOf(carla, application.id)[0].recoveredAfterFinish, true);
    assert.equal(submissionsOf(diego, application.id).length, 0);

    // Estável: a próxima varredura e o próximo Monitor mostram o mesmo.
    const again = settleExpiredAttempts(db.memory);
    assert.equal(again.finalized.length, 0);
    assert.equal(again.discarded, 0);
    const second = await monitorRows();
    assert.equal(statusOf(second, bruno), 'discarded');
    assert.ok(second.every(row => row.status !== 'time_over'));
    assert.equal((await sync(bruno, application.id, 'attempt_legacy_bruno')).body.finishOutcome, 'discarded');
    assert.equal((await sync(ana, application.id)).body.finishOutcome, 'delivered');
    delete db.memory.studentExamState[`${application.id}::${diego.email}::1`];
});

test('[UC-TENTATIVA-001] recarregar a página da prova: a mesma sessão que volta em até 60 s destrava sozinha e o Monitor registra', async () => {
    const { ana, bruno } = students;
    const { PAGE_EXIT_RETURN_WINDOW_MS } = require('../../backend/utils/examFocusRules.js');
    assert.equal(PAGE_EXIT_RETURN_WINDOW_MS, 60 * 1000);
    const application = await createApplication({ timerMode: 'per_attempt' });
    const logActivity = (student, started, eventType, details, extra = {}) => request(app)
        .post('/api/student/log-activity')
        .set('x-session-token', student.token)
        .send({ email: student.email, studentClass, courseId, examKey, applicationId: application.id, attemptId: started.attemptId, eventType, details, ...extra })
        .expect(200);
    // Registros iguais em menos de 1 s são deduplicados: cada cena começa "depois".
    const ageLogs = () => db.memory.proctoringLogs
        .filter(log => log.applicationId === application.id)
        .forEach(log => { log.timestamp -= 5000; });
    const startedAna = await startAttempt(ana, application.id);
    await autosave(ana, application.id, startedAna.attemptId, { 1: 'A' }).expect(200);

    // Recarregou: o pagehide registra a saída da página e trava.
    await logActivity(ana, startedAna, 'exam_left', 'Página da prova foi fechada ou recarregada', { pageExit: true });
    // A aba fica oculta enquanto a página descarrega: faz parte da mesma saída.
    await logActivity(ana, startedAna, 'tab_blur', 'Aba oculta');
    assert.equal(stateOf(startedAna.attemptId).focusLocked, true);
    stateOf(startedAna.attemptId).pageExit.at -= 7000;
    const back = await sync(ana, application.id, startedAna.attemptId);
    assert.equal(back.body.state.focusLocked, false, 'voltou em 7 s: destravou sozinha');
    assert.equal(back.body.state.pageExit, undefined);
    assert.deepEqual(back.body.state.answers, asStudentAnswers(application.id, { 1: 'A' }));
    const returnLog = db.memory.proctoringLogs.find(log => log.applicationId === application.id && log.eventType === 'page_return');
    assert.ok(returnLog, 'o retorno fica registrado no Monitor');
    assert.match(returnLog.details, /voltou em 7 s/);
    const monitor = await request(app)
        .get(`/api/admin/monitor-status/${encodeURIComponent(studentClass)}/${encodeURIComponent(examKey)}`)
        .set('x-admin-session', adminToken)
        .query({ courseId, applicationId: application.id })
        .expect(200);
    const anaRow = monitor.body.find(row => row.email === ana.email);
    assert.equal(anaRow.focusLocked, false);
    assert.equal(anaRow.status, 'online');
    assert.ok(anaRow.logs.some(log => log.eventType === 'page_return'));

    // Sem voltar em 60 s: vale a regra de saída (só o professor libera).
    ageLogs();
    await logActivity(ana, startedAna, 'exam_left', 'Página da prova foi fechada ou recarregada', { pageExit: true });
    stateOf(startedAna.attemptId).pageExit.at -= 61 * 1000;
    const tooLate = await sync(ana, application.id, startedAna.attemptId);
    assert.equal(tooLate.body.state.focusLocked, true);
    assert.equal(stateOf(startedAna.attemptId).pageExit, undefined);
    assert.equal((await sync(ana, application.id, startedAna.attemptId)).body.state.focusLocked, true);
    await request(app)
        .post('/api/admin/unlock-student-focus')
        .set('x-admin-session', adminToken)
        .send({ studentEmail: ana.email, studentClass, courseId, examKey, applicationId: application.id })
        .expect(200);

    // Saída pelo botão da prova (sem ser saída da página): continua travada.
    ageLogs();
    await logActivity(ana, startedAna, 'exam_left', 'Aluno saiu usando o botão da prova');
    assert.equal((await sync(ana, application.id, startedAna.attemptId)).body.state.focusLocked, true);
    await request(app)
        .post('/api/admin/unlock-student-focus')
        .set('x-admin-session', adminToken)
        .send({ studentEmail: ana.email, studentClass, courseId, examKey, applicationId: application.id })
        .expect(200);

    // Troca de aba continua como está: a prova já travada não destrava com uma recarga depois.
    ageLogs();
    const startedBruno = await startAttempt(bruno, application.id);
    await logActivity(bruno, startedBruno, 'tab_blur', 'Aba oculta');
    stateOf(startedBruno.attemptId).focusLockedAt -= 10 * 1000;
    await logActivity(bruno, startedBruno, 'exam_left', 'Página da prova foi fechada ou recarregada', { pageExit: true });
    assert.equal((await sync(bruno, application.id, startedBruno.attemptId)).body.state.focusLocked, true);
    await request(app)
        .post('/api/admin/unlock-student-focus')
        .set('x-admin-session', adminToken)
        .send({ studentEmail: bruno.email, studentClass, courseId, examKey, applicationId: application.id })
        .expect(200);

    // Troca de aba de verdade e recarga 2,5 s depois: a troca de aba vale (não é a
    // descarga da página) e a volta em 40 s não destrava.
    ageLogs();
    await logActivity(bruno, startedBruno, 'tab_blur', 'Aba oculta');
    stateOf(startedBruno.attemptId).focusLockedAt -= 2500;
    await logActivity(bruno, startedBruno, 'exam_left', 'Página da prova foi fechada ou recarregada', { pageExit: true });
    assert.equal(stateOf(startedBruno.attemptId).pageExit, undefined, 'a saída da página não vale para a prova já travada pela troca de aba');
    assert.equal((await sync(bruno, application.id, startedBruno.attemptId)).body.state.focusLocked, true, 'troca de aba seguida de recarga continua travada');
    await request(app)
        .post('/api/admin/unlock-student-focus')
        .set('x-admin-session', adminToken)
        .send({ studentEmail: bruno.email, studentClass, courseId, examKey, applicationId: application.id })
        .expect(200);

    // A aba oculta da própria descarga chega um pouco antes da saída da página (rede):
    // faz parte da mesma saída e a volta destrava.
    ageLogs();
    await logActivity(bruno, startedBruno, 'tab_blur', 'Aba oculta');
    stateOf(startedBruno.attemptId).focusLockedAt -= 300;
    await logActivity(bruno, startedBruno, 'exam_left', 'Página da prova foi fechada ou recarregada', { pageExit: true });
    stateOf(startedBruno.attemptId).pageExit.at -= 5000;
    assert.equal((await sync(bruno, application.id, startedBruno.attemptId)).body.state.focusLocked, false);

    // Outra sessão (login em outro aparelho) não destrava a saída desta.
    ageLogs();
    await logActivity(bruno, startedBruno, 'exam_left', 'Página da prova foi fechada ou recarregada', { pageExit: true });
    const otherDevice = { ...bruno, token: 'token-bruno-outro-aparelho' };
    const previousToken = db.memory.sessions[bruno.email].token;
    db.memory.sessions[bruno.email].token = otherDevice.token;
    try {
        assert.equal((await sync(otherDevice, application.id, startedBruno.attemptId)).body.state.focusLocked, true);
    } finally {
        db.memory.sessions[bruno.email].token = previousToken;
    }
    await control(application.id, 'finish', { inProgressPolicy: 'discard' });
});
