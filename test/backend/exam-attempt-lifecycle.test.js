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
const { lateSubmitDecision, LATE_AUTO_SUBMIT_TOLERANCE_MS } = require('../../backend/utils/examDeadline.js');

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
    assert.deepEqual(firstAfter.body.state.answers, { 1: 'A', 2: 'B' });
    assert.notEqual(firstAfter.body.state.status, 'instructions');

    const secondAfter = await sync(ana, application.id, started.attemptId);
    assert.equal(secondAfter.body.attemptId, started.attemptId, 'a tentativa vencida não é recriada');
    assert.deepEqual(secondAfter.body.state.answers, { 1: 'A', 2: 'B' });

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
    const { ana, bruno } = students;
    const application = await createApplication({ timerMode: 'per_attempt' });
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
    await submit(bruno, application.id, startedBruno, { 1: 'A' }).expect(200);
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
    assert.deepEqual(duringPause.body.state.answers, { 1: 'A' });
    assert.equal(duringPause.body.attemptOutcome, null);
    await autosave(ana, application.id, started.attemptId, { 1: 'A', 2: 'B' }).expect(200);

    await control(application.id, 'resume');
    assert.equal(stored.pausedAt, null);
    assert.ok(stored.pauses[0].resumedAt > 0);
    const afterResume = await sync(ana, application.id, started.attemptId);
    assert.ok(afterResume.body.state.timerRemaining >= 58 && afterResume.body.state.timerRemaining <= 60, `restante após retomar: ${afterResume.body.state.timerRemaining}`);
    assert.deepEqual(afterResume.body.state.answers, { 1: 'A', 2: 'B' });

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

test('[UC-TENTATIVA-001] tempo extra do professor não reabre tentativa vencida (AVA-03)', async () => {
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

    // +5 min para a turma também não ressuscita quem já estava sem tempo.
    const startedCarla = await startAttempt(carla, application.id);
    expireAttempt(startedCarla.attemptId, 3000);
    await request(app)
        .post(`/api/admin/exam-applications/${application.id}/time-adjustment`)
        .set('x-admin-session', adminToken)
        .send({ adjustmentMinutes: 5 })
        .expect(200);
    assert.equal(submissionsOf(carla, application.id).length, 1);
    assert.equal(openStatesOf(carla, application.id).length, 0);
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

    assert.deepEqual(lateSubmitDecision({ overdueMs: 2000, auto: true }), { accept: true, lateMs: 0 });
    assert.deepEqual(lateSubmitDecision({ overdueMs: 20000, auto: false }), { accept: true, lateMs: 20000 });
    assert.equal(lateSubmitDecision({ overdueMs: 5 * MIN, auto: true }).accept, true);
    assert.equal(lateSubmitDecision({ overdueMs: 5 * MIN, auto: false }).accept, false);
    assert.equal(lateSubmitDecision({ overdueMs: LATE_AUTO_SUBMIT_TOLERANCE_MS + 1, auto: true }).accept, false);
});
