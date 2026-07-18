const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-applications-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');

let app;
const adminToken = 'admin-token-applications';
const studentToken = 'student-token-applications';
const adminEmail = 'admin@applications.local';
const studentEmail = 'student@applications.local';
const studentClass = 'Turma Aplicações';
const courseId = 'curso-aplicacoes';
const examKey = 'Avaliacao_Aplicacoes';

test.before(async () => {
    await db.init();
    app = createApp();
    db.memory.admins = [{ email: adminEmail, name: 'Admin', role: 'admin', password: db.hashPassword('senha-administrativa') }];
    db.memory.adminSessions = { [adminToken]: { email: adminEmail, createdAt: Date.now(), lastSeen: Date.now() } };
    db.memory.students = [{
        name: 'Aluno Aplicações',
        email: studentEmail,
        status: 'Ativo',
        classes: [{ name: studentClass, courseId }],
    }];
    db.memory.sessions = { [studentEmail]: { token: studentToken, lastSeen: Date.now(), ip: '127.0.0.1' } };
    db.memory.courses = [{
        id: courseId,
        structure: [{ name: 'Módulo', units: [{ avaliacaoKey: examKey }] }],
    }];
    db.memory.classes = [{ name: studentClass, courseId, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} }];
    db.memory.evaluations = {
        [examKey]: {
            key: examKey,
            title: 'Prova de isolamento',
            questions: [{
                number: 1,
                text: 'Questão de isolamento',
                correctAnswer: 'A',
                alternatives: [
                    { letter: 'A', text: 'Correta', isCorrect: true },
                    { letter: 'B', text: 'Incorreta', isCorrect: false },
                ],
            }],
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

async function createHistory() {
    const response = await request(app)
        .post('/api/admin/exam-history/add')
        .set('x-admin-session', adminToken)
        .send({
            studentClass,
            courseId,
            examKey,
            type: 'online',
            questionNumbers: [1],
            printSnapshot: [{
                version: 'A',
                questions: [{
                    originalNumber: 1,
                    text: 'Questão de isolamento',
                    alternatives: [{ letter: 'A', text: 'Correta' }, { letter: 'B', text: 'Incorreta' }],
                }],
            }],
            durationMinutes: 30,
            waitingRoomMinutes: 0,
            maxAttempts: 1,
        })
        .expect(200);
    return response.body.entry.id;
}

async function createAndStartApplication(historyId) {
    const created = await request(app)
        .post('/api/admin/exam-applications')
        .set('x-admin-session', adminToken)
        .send({
            studentClass,
            courseId,
            examKey,
            historyId,
            applicationOptions: { timerMode: 'per_attempt', waitingRoomMinutes: 0, maxAttempts: 1 },
        })
        .expect(201);
    assert.equal(created.body.application.status, 'prepared');
    assert.equal(db.memory.classes[0].releasedItems[examKey], false);

    const started = await request(app)
        .post(`/api/admin/exam-applications/${created.body.application.id}/control`)
        .set('x-admin-session', adminToken)
        .send({ action: 'start' })
        .expect(200);
    assert.equal(started.body.application.status, 'running');
    return started.body.application;
}

async function syncApplication(applicationId) {
    return request(app)
        .get('/api/student/sync')
        .set('x-session-token', studentToken)
        .query({ email: studentEmail, studentClass, courseId, examKey, applicationId })
        .expect(200);
}

test('usa por padrão uma tentativa e dez minutos de sala de espera', async () => {
    const history = await request(app)
        .post('/api/admin/exam-history/add')
        .set('x-admin-session', adminToken)
        .send({
            studentClass,
            courseId,
            examKey,
            type: 'online',
            questionNumbers: [1],
            printSnapshot: [{
                version: 'A',
                questions: [{
                    originalNumber: 1,
                    text: 'Questão com valores padrão',
                    alternatives: [{ letter: 'A', text: 'Correta' }, { letter: 'B', text: 'Incorreta' }],
                }],
            }],
        })
        .expect(200);
    assert.equal(history.body.entry.waitingRoomMinutes, 10);
    assert.equal(history.body.entry.maxAttempts, 1);

    const created = await request(app)
        .post('/api/admin/exam-applications')
        .set('x-admin-session', adminToken)
        .send({ studentClass, courseId, examKey, historyId: history.body.entry.id })
        .expect(201);
    assert.equal(created.body.application.waitingRoomDuration, 600);
    assert.equal(created.body.application.maxAttempts, 1);
});

test('avisa o aluno somente quando a aplicação está ativa e descobre todas as turmas matriculadas', async () => {
    const historyId = await createHistory();
    const created = await request(app)
        .post('/api/admin/exam-applications')
        .set('x-admin-session', adminToken)
        .send({
            studentClass,
            courseId,
            examKey,
            historyId,
            applicationOptions: { timerMode: 'per_attempt', waitingRoomMinutes: 0, maxAttempts: 1 },
        })
        .expect(201);

    const preparedList = await request(app)
        .get('/api/student/exam-applications')
        .set('x-session-token', studentToken)
        .expect(200);
    assert.equal(preparedList.body.applications.some(item => item.id === created.body.application.id), false);

    await request(app)
        .post(`/api/admin/exam-applications/${created.body.application.id}/control`)
        .set('x-admin-session', adminToken)
        .send({ action: 'start' })
        .expect(200);

    const allClassesList = await request(app)
        .get('/api/student/exam-applications')
        .set('x-session-token', studentToken)
        .expect(200);
    const available = allClassesList.body.applications.find(item => item.id === created.body.application.id);
    assert.ok(available);
    assert.equal(available.examTitle, 'Prova de isolamento');
    assert.equal(available.studentClass, studentClass);
    assert.equal(available.courseId, courseId);
    assert.equal(available.attemptsUsed, 0);
    assert.equal(available.maxAttempts, 1);
    assert.equal(available.attemptsExhausted, false);
    assert.equal(Object.prototype.hasOwnProperty.call(available, 'accessTokenHash'), false);

    const scopedList = await request(app)
        .get('/api/student/exam-applications')
        .set('x-session-token', studentToken)
        .query({ studentClass, courseId })
        .expect(200);
    assert.equal(scopedList.body.applications.some(item => item.id === created.body.application.id), true);

    await request(app)
        .post(`/api/admin/exam-applications/${created.body.application.id}/control`)
        .set('x-admin-session', adminToken)
        .send({ action: 'finish', inProgressPolicy: 'discard' })
        .expect(200);

    const finishedList = await request(app)
        .get('/api/student/exam-applications')
        .set('x-session-token', studentToken)
        .expect(200);
    assert.equal(finishedList.body.applications.some(item => item.id === created.body.application.id), false);
});

test('libera a prova automaticamente quando o tempo da sala de espera termina', async () => {
    const historyId = await createHistory();
    const created = await request(app)
        .post('/api/admin/exam-applications')
        .set('x-admin-session', adminToken)
        .send({
            studentClass,
            courseId,
            examKey,
            historyId,
            applicationOptions: { timerMode: 'per_attempt', waitingRoomMinutes: 10, maxAttempts: 1 },
        })
        .expect(201);

    const waiting = await request(app)
        .post(`/api/admin/exam-applications/${created.body.application.id}/control`)
        .set('x-admin-session', adminToken)
        .send({ action: 'waiting', waitingRoomDuration: 0 })
        .expect(200);
    assert.equal(waiting.body.application.status, 'waiting');
    assert.ok(Number(waiting.body.application.startsAt) <= Date.now());

    const sync = await syncApplication(created.body.application.id);
    assert.equal(sync.body.onlineExamConfigs[examKey].status, 'waiting');
    assert.ok(Number(sync.body.onlineExamConfigs[examKey].startTime) <= Date.now());
    assert.equal(sync.body.state.status, 'instructions');

    await request(app)
        .post(`/api/student/exam-applications/${created.body.application.id}/start-attempt`)
        .set('x-session-token', studentToken)
        .send({})
        .expect(200);

    await request(app)
        .post(`/api/admin/exam-applications/${created.body.application.id}/control`)
        .set('x-admin-session', adminToken)
        .send({ action: 'finish', inProgressPolicy: 'discard' })
        .expect(200);
});

test('adiciona e remove minutos da sala de espera sem alterar o estado da aplicação', async () => {
    const historyId = await createHistory();
    const created = await request(app)
        .post('/api/admin/exam-applications')
        .set('x-admin-session', adminToken)
        .send({
            studentClass,
            courseId,
            examKey,
            historyId,
            applicationOptions: { timerMode: 'per_attempt', waitingRoomMinutes: 10, maxAttempts: 1 },
        })
        .expect(201);

    const waiting = await request(app)
        .post(`/api/admin/exam-applications/${created.body.application.id}/control`)
        .set('x-admin-session', adminToken)
        .send({ action: 'waiting', waitingRoomDuration: 600 })
        .expect(200);
    const originalStartsAt = Number(waiting.body.application.startsAt);

    const added = await request(app)
        .post(`/api/admin/exam-applications/${created.body.application.id}/control`)
        .set('x-admin-session', adminToken)
        .send({ action: 'adjust_waiting', adjustmentSeconds: 60 })
        .expect(200);
    assert.equal(added.body.application.status, 'waiting');
    assert.equal(Number(added.body.application.startsAt), originalStartsAt + 60000);
    assert.equal(added.body.application.waitingRoomDuration, 660);
    assert.equal(Number(added.body.config.startTime), originalStartsAt + 60000);

    const removed = await request(app)
        .post(`/api/admin/exam-applications/${created.body.application.id}/control`)
        .set('x-admin-session', adminToken)
        .send({ action: 'adjust_waiting', adjustmentSeconds: -60 })
        .expect(200);
    assert.equal(removed.body.application.status, 'waiting');
    assert.equal(Number(removed.body.application.startsAt), originalStartsAt);
    assert.equal(removed.body.application.waitingRoomDuration, 600);

    await request(app)
        .post(`/api/admin/exam-applications/${created.body.application.id}/control`)
        .set('x-admin-session', adminToken)
        .send({ action: 'start' })
        .expect(200);

    const invalidState = await request(app)
        .post(`/api/admin/exam-applications/${created.body.application.id}/control`)
        .set('x-admin-session', adminToken)
        .send({ action: 'adjust_waiting', adjustmentSeconds: 60 })
        .expect(409);
    assert.match(invalidState.body.error, /não está em sala de espera/i);

    await request(app)
        .post(`/api/admin/exam-applications/${created.body.application.id}/control`)
        .set('x-admin-session', adminToken)
        .send({ action: 'finish' })
        .expect(200);
});

test('monitor calcula o tempo individual pelo prazo do aluno sem depender do heartbeat', async () => {
    const historyId = await createHistory();
    const application = await createAndStartApplication(historyId);
    await syncApplication(application.id);
    const started = await request(app)
        .post(`/api/student/exam-applications/${application.id}/start-attempt`)
        .set('x-session-token', studentToken)
        .send({})
        .expect(200);

    const state = Object.values(db.memory.studentExamState).find(item => item?.attemptId === started.body.attemptId);
    state.deadlineAt = Date.now() + 125000;
    state.timerRemaining = 1800;

    const monitor = await request(app)
        .get(`/api/admin/monitor-status/${encodeURIComponent(studentClass)}/${encodeURIComponent(examKey)}`)
        .set('x-admin-session', adminToken)
        .query({ courseId, applicationId: application.id })
        .expect(200);

    assert.equal(monitor.body.length, 1);
    assert.ok(monitor.body[0].timerRemaining >= 123 && monitor.body[0].timerRemaining <= 125);

    await request(app)
        .post(`/api/admin/exam-applications/${application.id}/control`)
        .set('x-admin-session', adminToken)
        .send({ action: 'finish', inProgressPolicy: 'discard' })
        .expect(200);
});

test('isola tentativas e estado entre duas aplicações consecutivas da mesma prova', async () => {
    const historyId = await createHistory();
    const first = await createAndStartApplication(historyId);
    const firstSync = await syncApplication(first.id);
    assert.equal(firstSync.body.applicationId, first.id);
    assert.equal(firstSync.body.attemptsUsed, 0);
    assert.equal(firstSync.body.state.status, 'instructions');
    assert.equal(firstSync.body.state.startedAt, null);

    const firstStart = await request(app)
        .post(`/api/student/exam-applications/${first.id}/start-attempt`)
        .set('x-session-token', studentToken)
        .send({})
        .expect(200);
    assert.ok(firstStart.body.state.startedAt);
    assert.equal(firstStart.body.state.status, 'active');

    const submissionBody = {
        studentClass,
        courseId,
        examKey,
        applicationId: first.id,
        attemptId: firstStart.body.attemptId,
        answers: { 1: 'A' },
        questionNumbers: [1],
        examConfigVersion: firstStart.body.examConfigVersion,
    };
    const firstSubmission = await request(app)
        .post('/api/student/submit')
        .set('x-session-token', studentToken)
        .send(submissionBody)
        .expect(200);
    assert.equal(firstSubmission.body.applicationId, first.id);
    assert.equal(db.memory.submissions.length, 1);

    const duplicate = await request(app)
        .post('/api/student/submit')
        .set('x-session-token', studentToken)
        .send(submissionBody)
        .expect(200);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(db.memory.submissions.length, 1);

    await request(app)
        .post(`/api/admin/exam-applications/${first.id}/control`)
        .set('x-admin-session', adminToken)
        .send({ action: 'finish', inProgressPolicy: 'discard' })
        .expect(200);

    const second = await createAndStartApplication(historyId);
    assert.notEqual(second.id, first.id);
    const secondSync = await syncApplication(second.id);
    assert.equal(secondSync.body.applicationId, second.id);
    assert.equal(secondSync.body.attemptsUsed, 0);
    assert.deepEqual(secondSync.body.state.answers, {});
    assert.equal(secondSync.body.state.status, 'instructions');
    assert.equal(db.memory.submissions[0].applicationId, first.id);
});

test('cria e edita prova com validação e mantém banco de questões editável', async () => {
    await request(app)
        .post('/api/admin/evaluation')
        .set('x-admin-session', adminToken)
        .send({
            courseId,
            moduleId: 'Módulo',
            title: 'Prova inválida',
            questions: [{ text: 'Sem resposta correta', alternatives: [{ text: 'A' }, { text: 'B' }] }],
        })
        .expect(400);

    const created = await request(app)
        .post('/api/admin/evaluation')
        .set('x-admin-session', adminToken)
        .send({
            courseId,
            moduleId: 'Módulo',
            title: 'Prova criada pela interface',
            theme: 'Aplicações',
            rubric: 'Leia todas as questões.',
            questions: [{
                text: 'Qual alternativa está correta?',
                alternatives: [
                    { letter: 'A', text: 'Esta', isCorrect: true },
                    { letter: 'B', text: 'A outra', isCorrect: false },
                ],
                correctAnswer: 'A',
            }],
        })
        .expect(201);
    assert.ok(created.body.key.startsWith('Avaliacao_'));
    assert.equal(created.body.evaluation.revision, 1);
    assert.equal(db.memory.courses[0].structure[0].units.some(unit => unit.avaliacaoKey === created.body.key), true);

    const updated = await request(app)
        .put(`/api/admin/evaluation/${created.body.key}`)
        .set('x-admin-session', adminToken)
        .send({
            ...created.body.evaluation,
            title: 'Prova atualizada',
            questions: [{
                text: 'Questão editada',
                alternatives: [
                    { letter: 'A', text: 'Errada', isCorrect: false },
                    { letter: 'B', text: 'Correta', isCorrect: true },
                ],
                correctAnswer: 'B',
            }],
        })
        .expect(200);
    assert.equal(updated.body.evaluation.revision, 2);
    assert.equal(updated.body.evaluation.questions[0].correctAnswer, 'B');
    assert.equal(db.memory.courses[0].structure[0].units.find(unit => unit.avaliacaoKey === created.body.key).name, 'Prova atualizada');

    const bankCreated = await request(app)
        .post('/api/admin/question-bank/create')
        .set('x-admin-session', adminToken)
        .send({
            category: 'Aplicações',
            questionText: 'Questão reutilizável',
            alternatives: [{ letter: 'A', text: 'Sim', isCorrect: true }, { letter: 'B', text: 'Não' }],
            correctAnswer: 'A',
        })
        .expect(200);
    const bankUpdated = await request(app)
        .post('/api/admin/question-bank/update')
        .set('x-admin-session', adminToken)
        .send({
            key: bankCreated.body.question.key,
            category: 'Revisada',
            questionText: 'Questão reutilizável editada',
            alternatives: [{ letter: 'A', text: 'Não' }, { letter: 'B', text: 'Sim', isCorrect: true }],
            correctAnswer: 'B',
        })
        .expect(200);
    assert.equal(bankUpdated.body.question.category, 'Revisada');
    assert.equal(bankUpdated.body.question.correctAnswer, 'B');
});

test('aluno contesta e professor corrige a questao ao vivo antes do envio', async () => {
    const historyId = await createHistory();
    const application = await createAndStartApplication(historyId);
    await syncApplication(application.id);
    const started = await request(app).post(`/api/student/exam-applications/${application.id}/start-attempt`)
        .set('x-session-token', studentToken).send({}).expect(200);

    await request(app).post('/api/student/report-question').set('x-session-token', studentToken).send({
        applicationId: application.id,
        attemptId: started.body.attemptId,
        questionNumber: 1,
        reason: 'sem_resposta_correta',
        text: 'A alternativa correta parece ausente.',
    }).expect(201);
    await request(app).post('/api/student/report-question').set('x-session-token', studentToken).send({
        applicationId: application.id,
        attemptId: started.body.attemptId,
        questionNumber: 1,
        reason: 'outro',
    }).expect(409);

    const reports = await request(app)
        .get(`/api/admin/question-reports/${encodeURIComponent(studentClass)}/${encodeURIComponent(examKey)}`)
        .set('x-admin-session', adminToken).query({ applicationId: application.id }).expect(200);
    assert.equal(reports.body.totalOpen, 1);
    assert.equal(reports.body.groups[0].questionNumber, 1);

    const corrected = await request(app).post('/api/admin/correct-live-question').set('x-admin-session', adminToken).send({
        applicationId: application.id,
        questionNumber: 1,
        question: {
            text: 'Questao corrigida durante a prova',
            alternatives: [{ letter: 'A', text: 'Agora incorreta' }, { letter: 'B', text: 'Agora correta' }],
            correctAnswer: 'B',
        },
    }).expect(200);
    assert.equal(corrected.body.question.correctAnswer, 'B');

    const afterCorrection = await syncApplication(application.id);
    const studentQuestion = afterCorrection.body.onlineExamConfigs[examKey].versionSnapshots[0].questions[0];
    assert.equal(studentQuestion.text, 'Questao corrigida durante a prova');
    assert.equal(Object.prototype.hasOwnProperty.call(studentQuestion, 'correctAnswer'), false);
    assert.equal(afterCorrection.body.questionReports[0].status, 'reviewed');

    await request(app).post('/api/student/submit').set('x-session-token', studentToken).send({
        studentClass, courseId, examKey, applicationId: application.id,
        attemptId: started.body.attemptId, answers: { 1: 'B' }, questionNumbers: [1],
        examConfigVersion: started.body.examConfigVersion,
    }).expect(200);
    const submission = db.memory.submissions.find(item => item.applicationId === application.id);
    assert.equal(submission.score, 100);
    assert.equal(submission.gradedAnswers[0].correctAnswer, 'B');
    await request(app).post(`/api/admin/exam-applications/${application.id}/control`)
        .set('x-admin-session', adminToken).send({ action: 'finish' }).expect(200);
});

test('anula e substitui questao para tentativas ativas com tempo extra', async () => {
    const historyId = await createHistory();
    const application = await createAndStartApplication(historyId);
    await syncApplication(application.id);
    const started = await request(app).post(`/api/student/exam-applications/${application.id}/start-attempt`)
        .set('x-session-token', studentToken).send({}).expect(200);
    const state = Object.values(db.memory.studentExamState).find(item => item?.attemptId === started.body.attemptId);
    const oldDeadline = state.deadlineAt;
    db.memory.questionBank.push({
        key: 'qb_replacement_test', category: 'Aplicacoes', questionText: 'Questao adicional',
        alternatives: [{ letter: 'A', text: 'Incorreta' }, { letter: 'B', text: 'Correta', isCorrect: true }], correctAnswer: 'B',
    });

    const replaced = await request(app).post('/api/admin/replace-question').set('x-admin-session', adminToken).send({
        applicationId: application.id, questionNumber: 1, bankQuestionKey: 'qb_replacement_test', extraMinutes: 5,
    }).expect(200);
    assert.equal(replaced.body.replacementNumber, 2);
    assert.equal(state.assignedQuestionNumbers.includes(2), true);
    assert.equal(state.deadlineAt, oldDeadline + 300000);

    const sync = await syncApplication(application.id);
    const cfg = sync.body.onlineExamConfigs[examKey];
    assert.equal(cfg.versionSnapshots[0].questions.length, 2);
    assert.equal(cfg.versionSnapshots[0].questions[1].isAdditional, true);
    assert.equal(cfg.annulledQuestions[0].questionNumber, 1);
    await request(app).post('/api/student/submit').set('x-session-token', studentToken).send({
        studentClass, courseId, examKey, applicationId: application.id,
        attemptId: started.body.attemptId, answers: { 1: 'B', 2: 'B' }, questionNumbers: [1, 2],
        examConfigVersion: started.body.examConfigVersion,
    }).expect(200);
    const submission = db.memory.submissions.find(item => item.applicationId === application.id);
    assert.equal(submission.score, 100);
    assert.equal(submission.totalCount, 1);
    assert.equal(submission.gradedAnswers.find(item => item.questionNumber === 1).annulled, true);
    await request(app).post(`/api/admin/exam-applications/${application.id}/control`)
        .set('x-admin-session', adminToken).send({ action: 'finish' }).expect(200);
});

test('encerramento antecipado exige decisao e salva ou desconsidera o rascunho', async () => {
    const historyId = await createHistory();
    const saveApplication = await createAndStartApplication(historyId);
    await syncApplication(saveApplication.id);
    const saveStarted = await request(app).post(`/api/student/exam-applications/${saveApplication.id}/start-attempt`)
        .set('x-session-token', studentToken).send({}).expect(200);
    await request(app).post('/api/student/autosave-progress').set('x-session-token', studentToken).send({
        studentClass, courseId, examKey, applicationId: saveApplication.id,
        attemptId: saveStarted.body.attemptId, answers: { 1: 'A' },
    }).expect(200);

    const refused = await request(app).post(`/api/admin/exam-applications/${saveApplication.id}/control`)
        .set('x-admin-session', adminToken).send({ action: 'finish' }).expect(409);
    assert.equal(refused.body.requiresInProgressPolicy, true);
    assert.equal(refused.body.summary.inProgressAttempts, 1);
    const saved = await request(app).post(`/api/admin/exam-applications/${saveApplication.id}/control`)
        .set('x-admin-session', adminToken).send({ action: 'finish', inProgressPolicy: 'submit' }).expect(200);
    assert.equal(saved.body.finish.submitted, 1);
    const automatic = db.memory.submissions.find(item => item.applicationId === saveApplication.id);
    assert.equal(automatic.submissionSource, 'instructor_finish');
    assert.equal(automatic.score, 100);

    const discardApplication = await createAndStartApplication(historyId);
    await syncApplication(discardApplication.id);
    const discardStarted = await request(app).post(`/api/student/exam-applications/${discardApplication.id}/start-attempt`)
        .set('x-session-token', studentToken).send({}).expect(200);
    await request(app).post('/api/student/autosave-progress').set('x-session-token', studentToken).send({
        studentClass, courseId, examKey, applicationId: discardApplication.id,
        attemptId: discardStarted.body.attemptId, answers: { 1: 'A' },
    }).expect(200);
    const discarded = await request(app).post(`/api/admin/exam-applications/${discardApplication.id}/control`)
        .set('x-admin-session', adminToken).send({ action: 'finish', inProgressPolicy: 'discard' }).expect(200);
    assert.equal(discarded.body.finish.discarded, 1);
    assert.equal(db.memory.submissions.some(item => item.applicationId === discardApplication.id), false);
    assert.equal(Object.values(db.memory.studentExamState).some(item => item?.applicationId === discardApplication.id), false);
});
