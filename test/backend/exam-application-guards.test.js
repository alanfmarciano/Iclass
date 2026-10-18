// Aplicações de prova e botões de manutenção (G2): preparar outra aplicação ou mexer
// em Materiais nunca encerra prova em andamento nem descarta respostas, liberar em
// lote não cria aplicação nem libera gabarito, o gabarito some durante uma nova
// aplicação e "Limpar estado de prova"/"Resetar sala" agem só na turma escolhida.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-guards-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const runtimePaths = require('../../backend/runtimePaths.js');
const { createApp } = require('../../backend/server.js');
const { initializeExamState } = require('../../backend/middlewares.js');

let app;
const adminToken = 'admin-token-guards';
const adminEmail = 'admin@guards.local';
const courseId = 'curso-guardas';
const classA = 'Turma A';
const classB = 'Turma B';
const examKey = 'Avaliacao_Guardas';
const apostilaKey = 'Apostila_Guardas';
const answerKey = `Gabarito_${examKey}`;
const students = {
    ana: { email: 'ana@guards.local', token: 'token-ana', studentClass: classA },
    bruno: { email: 'bruno@guards.local', token: 'token-bruno', studentClass: classA },
    carla: { email: 'carla@guards.local', token: 'token-carla', studentClass: classB },
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
        classes: [{ name: student.studentClass, courseId }],
    }));
    resetSessions();
    db.memory.courses = [{ id: courseId, structure: [{ name: 'Módulo', units: [{ name: 'Unidade 1', apostilaKey, avaliacaoKey: examKey }] }] }];
    db.memory.classes = [classA, classB].map(name => ({ name, courseId, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} }));
    db.memory.evaluations = {
        [examKey]: {
            key: examKey,
            title: 'Prova das guardas',
            questions: ['A', 'B'].map((correct, index) => ({
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
    db.memory.examKeystrokes = [];
    db.memory.broadcastMessages = [];
    db.memory.auditLogs = [];
});

test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

function resetSessions() {
    db.memory.sessions = Object.fromEntries(Object.values(students).map(student => [
        student.email,
        { token: student.token, lastSeen: Date.now(), ip: '127.0.0.1' },
    ]));
}

function admin(method, url) {
    return request(app)[method](url).set('x-admin-session', adminToken);
}

async function createHistory(studentClass) {
    const response = await admin('post', '/api/admin/exam-history/add')
        .send({
            studentClass,
            courseId,
            examKey,
            type: 'online',
            questionNumbers: [1, 2],
            printSnapshot: [{
                version: 'A',
                questions: [1, 2].map(number => ({
                    originalNumber: number,
                    text: `Questão ${number}`,
                    alternatives: ['A', 'B', 'C'].map(letter => ({ letter, text: `Alternativa ${letter}` })),
                })),
            }],
            durationMinutes: 30,
            waitingRoomMinutes: 0,
            maxAttempts: 1,
        })
        .expect(200);
    return response.body.entry.id;
}

function prepare(studentClass, historyId) {
    return admin('post', '/api/admin/exam-applications').send({
        studentClass,
        courseId,
        examKey,
        historyId,
        applicationOptions: { timerMode: 'per_attempt', waitingRoomMinutes: 0, maxAttempts: 1 },
    });
}

async function prepareAndStart(studentClass) {
    const historyId = await createHistory(studentClass);
    const created = await prepare(studentClass, historyId).expect(201);
    const started = await admin('post', `/api/admin/exam-applications/${created.body.application.id}/control`)
        .send({ action: 'start' })
        .expect(200);
    return { application: started.body.application, historyId };
}

function control(applicationId, body) {
    return admin('post', `/api/admin/exam-applications/${applicationId}/control`).send(body);
}

async function startAttempt(student, applicationId) {
    await request(app)
        .get('/api/student/sync')
        .set('x-session-token', student.token)
        .query({ email: student.email, studentClass: student.studentClass, courseId, examKey, applicationId })
        .expect(200);
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
        .send({ studentClass: student.studentClass, courseId, examKey, applicationId, attemptId, answers })
        .expect(200);
}

function submit(student, applicationId, started, answers) {
    return request(app)
        .post('/api/student/submit')
        .set('x-session-token', student.token)
        .send({
            studentClass: student.studentClass,
            courseId,
            examKey,
            applicationId,
            attemptId: started.attemptId,
            answers,
            examConfigVersion: started.examConfigVersion,
        });
}

function mySubmissions(student) {
    return request(app)
        .post('/api/student/my-submissions')
        .set('x-session-token', student.token)
        .send({ studentClass: student.studentClass, courseId })
        .expect(200);
}

function applicationOf(id) {
    return db.memory.examApplications.find(item => item.id === id);
}

function openStatesOf(student, applicationId) {
    return Object.values(db.memory.studentExamState).filter(state => state
        && state.applicationId === applicationId
        && state.studentEmail === student.email);
}

function classOf(name) {
    return db.memory.classes.find(cls => cls.name === name);
}

test('[UC-APLICACAO-001] preparar outra aplicação com uma em andamento é recusado e nada é encerrado (AVA-04)', async () => {
    const { ana } = students;
    const { application, historyId } = await prepareAndStart(classA);
    const started = await startAttempt(ana, application.id);
    await autosave(ana, application.id, started.attemptId, { 1: 'A' });

    const refused = await prepare(classA, historyId).expect(409);
    assert.match(refused.body.error, /aplicação em andamento/i);
    assert.equal(refused.body.activeApplication, true);
    assert.equal(refused.body.activeApplicationId, application.id);

    // Materiais: bloquear a prova (ou liberar de novo com outra configuração) também não encerra.
    const blocked = await admin('post', '/api/admin/release-item')
        .send({ studentClass: classA, courseId, itemKey: examKey, released: false })
        .expect(409);
    assert.match(blocked.body.error, /Monitor/);
    await admin('post', '/api/admin/release-item')
        .send({ studentClass: classA, courseId, itemKey: examKey, released: true, historyId })
        .expect(409);
    await admin('post', '/api/admin/online-exam-config')
        .send({ studentClass: classA, courseId, examKey, durationMinutes: 45 })
        .expect(409);

    // Encerrar ou cancelar por qualquer caminho exige a decisão sobre as respostas.
    for (const action of ['cancel', 'finished']) {
        const response = await control(application.id, { action }).expect(409);
        assert.equal(response.body.requiresInProgressPolicy, true);
    }
    const legacy = await admin('post', '/api/admin/server-exam-control')
        .send({ studentClass: classA, courseId, examKey, action: 'finish' })
        .expect(409);
    assert.equal(legacy.body.requiresInProgressPolicy, true);

    assert.equal(applicationOf(application.id).status, 'running');
    assert.deepEqual(openStatesOf(ana, application.id)[0].answers, { 1: 'A' });
    assert.equal(db.memory.examApplications.filter(item => item.studentClass === classA).length, 1);

    // A aluna continua e entrega normalmente na mesma aplicação.
    const delivered = await submit(ana, application.id, started, { 1: 'A', 2: 'B' }).expect(200);
    assert.equal(delivered.body.applicationId, application.id);
    await control(application.id, { action: 'finish' }).expect(200);
    assert.equal(applicationOf(application.id).status, 'finished');
});

test('[UC-APLICACAO-001] controle antigo por turma encerra salvando as respostas quando o professor escolhe', async () => {
    const { bruno } = students;
    const { application } = await prepareAndStart(classA);
    const started = await startAttempt(bruno, application.id);
    await autosave(bruno, application.id, started.attemptId, { 2: 'B' });
    await admin('post', '/api/admin/server-exam-control')
        .send({ studentClass: classA, courseId, examKey, action: 'finish', inProgressPolicy: 'submit' })
        .expect(200);
    assert.equal(applicationOf(application.id).status, 'finished');
    const saved = db.memory.submissions.find(item => item.attemptId === started.attemptId);
    assert.ok(saved, 'a tentativa em andamento virou entrega');
    assert.equal(saved.submissionSource, 'instructor_finish');
    assert.equal(openStatesOf(bruno, application.id).length, 0);
});

test('[UC-APLICACAO-001] nova preparação substitui só a aplicação preparada que não começou', async () => {
    const historyId = await createHistory(classA);
    const first = await prepare(classA, historyId).expect(201);
    const second = await prepare(classA, historyId).expect(201);
    assert.deepEqual(second.body.replacedApplicationIds, [first.body.application.id]);
    assert.equal(applicationOf(first.body.application.id).status, 'cancelled');
    assert.ok(db.memory.auditLogs.some(log => log.type === 'exam_application_replaced' && log.applicationId === first.body.application.id));
    await control(second.body.application.id, { action: 'cancel' }).expect(200);
});

test('tentativa de uma aplicação nunca é reiniciada com a configuração de outra', () => {
    const state = {
        applicationId: 'app_antiga',
        examConfigVersion: 'versao-1',
        answers: { 1: 'A' },
        startedAt: Date.now() - 60000,
        status: 'active',
        assignedVersion: 'A',
        versionAssigned: true,
        assignedQuestionNumbers: [1, 2],
    };
    const changed = initializeExamState(state, { applicationId: 'app_nova', updatedAt: 'versao-2', versionSnapshots: [] });
    assert.equal(changed, false);
    assert.deepEqual(state.answers, { 1: 'A' });
    assert.equal(state.status, 'active');
});

test('[UC-APLICACAO-001] liberar em lote não cria aplicação nem reabre prova; gabarito some durante nova aplicação (AVA-X1)', async () => {
    const { ana, bruno } = students;
    const { application } = await prepareAndStart(classA);
    const startedAna = await startAttempt(ana, application.id);
    const startedBruno = await startAttempt(bruno, application.id);
    await submit(ana, application.id, startedAna, { 1: 'A', 2: 'C' }).expect(200);
    await submit(bruno, application.id, startedBruno, { 1: 'A', 2: 'B' }).expect(200);
    await control(application.id, { action: 'finish' }).expect(200);
    const anaSubmission = db.memory.submissions.find(item => item.attemptId === startedAna.attemptId);
    await admin('post', '/api/admin/submissions/publish').send({ ids: [anaSubmission.id], published: true }).expect(200);

    // O professor libera o gabarito pela chave própria: a aluna vê a correção publicada.
    await admin('post', '/api/admin/release-item').send({ studentClass: classA, courseId, itemKey: answerKey, released: true }).expect(200);
    let anaView = (await mySubmissions(ana)).body.submissions.find(item => item.id === anaSubmission.id);
    assert.equal(anaView.answerKeyReleased, true);
    assert.equal(anaView.gradedAnswers[0].correctAnswer !== undefined, true);
    // Nota não publicada: nunca mostra a correção, mesmo com o gabarito liberado.
    const brunoView = (await mySubmissions(bruno)).body.submissions[0];
    assert.equal(brunoView.answerKeyReleased, false);
    assert.equal(brunoView.gradedAnswers.some(answer => 'correctAnswer' in answer || 'isCorrect' in answer), false);

    // "Liberar unidade" em Materiais: a prova encerrada não volta como aplicação nova.
    const applicationsBefore = db.memory.examApplications.length;
    await admin('post', '/api/admin/release-item').send({ studentClass: classA, courseId, itemKey: apostilaKey, released: true }).expect(200);
    const examRelease = await admin('post', '/api/admin/release-item').send({ studentClass: classA, courseId, itemKey: examKey, released: true }).expect(409);
    assert.equal(examRelease.body.requiresApplication, true);
    assert.equal(db.memory.examApplications.length, applicationsBefore);
    assert.equal(applicationOf(application.id).status, 'finished');
    const list = await request(app).get('/api/student/exam-applications').set('x-session-token', ana.token).expect(200);
    assert.equal(list.body.applications.length, 0);

    // Nova aplicação da mesma prova: o gabarito volta a ficar bloqueado e não sai para ninguém.
    const historyId = await createHistory(classA);
    const second = await prepare(classA, historyId).expect(201);
    assert.equal(second.body.answerKeyLocked, true);
    assert.equal(classOf(classA).releasedItems[answerKey], false);
    const lockedRelease = await admin('post', '/api/admin/release-item').send({ studentClass: classA, courseId, itemKey: answerKey, released: true }).expect(409);
    assert.match(lockedRelease.body.error, /gabarito/i);
    await admin('post', '/api/admin/release-item').send({ studentClass: classA, courseId, itemKey: answerKey, released: true, studentEmail: ana.email }).expect(409);
    // Mesmo com uma liberação gravada por versões antigas, nada de gabarito durante a aplicação.
    classOf(classA).releasedItems[answerKey] = true;
    anaView = (await mySubmissions(ana)).body.submissions.find(item => item.id === anaSubmission.id);
    assert.equal(anaView.answerKeyReleased, false);
    assert.equal(anaView.gradedAnswers.some(answer => 'correctAnswer' in answer || 'isCorrect' in answer), false);
    await control(second.body.application.id, { action: 'start' }).expect(200);
    anaView = (await mySubmissions(ana)).body.submissions.find(item => item.id === anaSubmission.id);
    assert.equal(anaView.answerKeyReleased, false);

    // Encerrada a nova aplicação, o gabarito volta a valer para a nota publicada.
    await control(second.body.application.id, { action: 'finish' }).expect(200);
    anaView = (await mySubmissions(ana)).body.submissions.find(item => item.id === anaSubmission.id);
    assert.equal(anaView.answerKeyReleased, true);
});

test('[UC-MANUT-001] limpar estado de prova exige turma e confirmação, respeita prova em andamento e preserva a evidência (UXI-02, CONF-10, OPS-X3)', async () => {
    const { carla } = students;
    await admin('post', '/api/admin/flush-exam-state').send({}).expect(400);
    const noConfirm = await admin('post', '/api/admin/flush-exam-state').send({ studentClass: classA, courseId }).expect(400);
    assert.equal(noConfirm.body.confirmationRequired, true);
    await admin('post', '/api/admin/flush-exam-state').send({ studentClass: 'Turma Inexistente', courseId, confirm: 'LIMPAR' }).expect(404);

    // Prova em andamento na turma B: a limpeza dessa turma é recusada e nada muda.
    const { application } = await prepareAndStart(classB);
    const started = await startAttempt(carla, application.id);
    await autosave(carla, application.id, started.attemptId, { 1: 'C' });
    const preview = await admin('get', '/api/admin/maintenance/preview').query({ studentClass: classB, courseId }).expect(200);
    assert.equal(preview.body.flush.blockedBy.length, 1);
    assert.equal(preview.body.reset.activeApplications[0].inProgressAttempts, 1);
    const blocked = await admin('post', '/api/admin/flush-exam-state').send({ studentClass: classB, courseId, confirm: 'LIMPAR' }).expect(409);
    assert.match(blocked.body.error, /em andamento/);
    assert.deepEqual(openStatesOf(carla, application.id)[0].answers, { 1: 'C' });

    // Sobras antigas na turma A, logs e digitação de provas encerradas, mensagens das duas turmas.
    db.memory.studentExamState['ana@guards.local_Avaliacao_Guardas'] = { studentEmail: 'ana@guards.local', examKey, answers: { 1: 'B' } };
    db.memory.studentExamState['legado-b'] = { studentEmail: 'carla@guards.local', studentClass: classB, examKey, answers: {} };
    db.memory.proctoringLogs.push({ id: 'log-a', studentEmail: 'ana@guards.local', studentClass: classA, examKey, eventType: 'tab_blur' });
    db.memory.examKeystrokes.push({ id: 'key-a', studentEmail: 'ana@guards.local', studentClass: classA, examKey, key: 'a' });
    db.memory.broadcastMessages.push(
        { id: 'msg-a', studentClass: classA, courseId, examKey, targetEmail: null, messageText: 'Turma A' },
        { id: 'msg-b', studentClass: classB, courseId, examKey, targetEmail: null, messageText: 'Turma B' },
    );
    const previewA = await admin('get', '/api/admin/maintenance/preview').query({ studentClass: classA, courseId }).expect(200);
    assert.equal(previewA.body.flush.blockedBy.length, 0);
    assert.equal(previewA.body.flush.counts.examStates, 1);
    assert.equal(previewA.body.flush.counts.pendingAnswers, 1);
    assert.equal(previewA.body.flush.counts.messages, 1);
    assert.equal(previewA.body.flush.preserved.proctoringLogs, 1);

    const originalSave = db.save;
    let saves = 0;
    db.save = (...args) => { saves += 1; return originalSave.apply(db, args); };
    let flushed;
    try {
        flushed = await admin('post', '/api/admin/flush-exam-state').send({ studentClass: classA, courseId, confirm: 'limpar' }).expect(200);
    } finally {
        db.save = originalSave;
    }
    assert.ok(saves >= 1, 'a limpeza grava no banco');
    assert.equal(flushed.body.removedStates, 1);
    assert.equal(flushed.body.removedMessages, 1);
    assert.equal(db.memory.studentExamState['ana@guards.local_Avaliacao_Guardas'], undefined);
    assert.ok(db.memory.studentExamState['legado-b'], 'estado de outra turma fica');
    assert.equal(openStatesOf(carla, application.id).length, 1);
    assert.deepEqual(db.memory.broadcastMessages.map(message => message.id), ['msg-b']);
    assert.equal(db.memory.proctoringLogs.length, 1);
    assert.equal(db.memory.examKeystrokes.length, 1);
    assert.ok(fs.existsSync(path.join(runtimePaths.BACKUPS_DIR, flushed.body.backup)), 'backup de segurança salvo antes');
    const audit = db.memory.auditLogs.find(log => log.type === 'exam_state_flushed');
    assert.equal(audit.studentClass, classA);
    assert.equal(audit.details.removedStates, 1);

    await control(application.id, { action: 'finish', inProgressPolicy: 'submit' }).expect(200);
    delete db.memory.studentExamState['legado-b'];
});

test('[UC-MANUT-001] resetar sala só na turma escolhida encerra a prova salvando as respostas (CONF-X3)', async () => {
    const { ana, bruno, carla } = students;
    resetSessions();
    const { application: appA } = await prepareAndStart(classA);
    const { application: appB } = await prepareAndStart(classB);
    const startedAna = await startAttempt(ana, appA.id);
    await autosave(ana, appA.id, startedAna.attemptId, { 1: 'A', 2: 'C' });
    const startedCarla = await startAttempt(carla, appB.id);
    await autosave(carla, appB.id, startedCarla.attemptId, { 2: 'B' });
    db.memory.broadcastMessages.push({ id: 'msg-reset-a', studentClass: classA, courseId, examKey, targetEmail: null, messageText: 'A' });

    await admin('post', '/api/admin/reset').send({}).expect(400);
    const noConfirm = await admin('post', '/api/admin/reset').send({ studentClass: classA, courseId, confirm: 'SIM' }).expect(400);
    assert.equal(noConfirm.body.confirmationRequired, true);
    assert.equal(applicationOf(appA.id).status, 'running');

    const reset = await admin('post', '/api/admin/reset').send({ studentClass: classA, courseId, confirm: 'RESETAR' }).expect(200);
    assert.equal(reset.body.finishedApplications, 1);
    assert.equal(reset.body.submitted, 1);
    assert.match(reset.body.message, /Turma A/);

    const finishedA = applicationOf(appA.id);
    assert.equal(finishedA.status, 'finished');
    assert.equal(finishedA.finishResolution.policy, 'submit');
    assert.equal(finishedA.finishResolution.reason, 'reset_sala');
    const saved = db.memory.submissions.find(item => item.attemptId === startedAna.attemptId);
    assert.equal(saved.submissionSource, 'instructor_finish');
    assert.equal(saved.gradedAnswers.find(answer => Number(answer.questionNumber) === 2).studentChoice, 'C');
    assert.equal(openStatesOf(ana, appA.id).length, 0);
    assert.equal(classOf(classA).onlineExamConfigs[examKey].status, 'finished');
    assert.equal(classOf(classA).activeApplicationId, null);

    // A outra turma segue intacta: aplicação rodando, tentativa, sessão e mensagens.
    assert.equal(applicationOf(appB.id).status, 'running');
    assert.deepEqual(openStatesOf(carla, appB.id)[0].answers, { 2: 'B' });
    assert.ok(db.memory.sessions[carla.email]);
    assert.equal(db.memory.sessions[ana.email], undefined);
    assert.equal(db.memory.sessions[bruno.email], undefined);
    assert.equal(db.memory.broadcastMessages.some(message => message.id === 'msg-reset-a'), false);
    assert.equal(db.memory.broadcastMessages.some(message => message.studentClass === classB), true);
    assert.ok(db.memory.auditLogs.some(log => log.type === 'class_reset' && log.studentClass === classA));

    resetSessions();
    await control(appB.id, { action: 'finish', inProgressPolicy: 'discard' }).expect(200);
});

test('[UC-MANUT-001] reiniciar o servidor exige confirmação explícita', async () => {
    const originalExit = process.exit;
    let exited = false;
    process.exit = () => { exited = true; };
    try {
        const refused = await admin('post', '/api/admin/server/restart').send({}).expect(400);
        assert.equal(refused.body.confirmationRequired, true);
        const preview = await admin('get', '/api/admin/maintenance/preview').expect(200);
        assert.ok(Array.isArray(preview.body.restart.activeApplications));
    } finally {
        await new Promise(resolve => setTimeout(resolve, 50));
        process.exit = originalExit;
    }
    assert.equal(exited, false);
});

test('[UC-APLICACAO-001] repetir o encerramento não sobrescreve a decisão gravada no primeiro', async () => {
    const { ana } = students;
    const { application } = await prepareAndStart(classA);
    const started = await startAttempt(ana, application.id);
    await autosave(ana, application.id, started.attemptId, { 1: 'B' });
    await control(application.id, { action: 'finish', inProgressPolicy: 'submit' }).expect(200);
    const first = { ...applicationOf(application.id).finishResolution };
    assert.equal(first.policy, 'submit');
    assert.equal(first.submitted, 1);
    const finishedAudits = () => db.memory.auditLogs.filter(log => log.type === 'exam_application_finished' && log.applicationId === application.id).length;
    assert.equal(finishedAudits(), 1);

    // Duplo clique, controle antigo por turma: nada muda, nem a auditoria.
    const again = await control(application.id, { action: 'finish' }).expect(200);
    assert.equal(again.body.unchanged, true);
    await control(application.id, { action: 'stop', inProgressPolicy: 'discard' }).expect(200);
    await admin('post', '/api/admin/server-exam-control')
        .send({ studentClass: classA, courseId, examKey, applicationId: application.id, action: 'finish' })
        .expect(200);
    // Ação impossível é recusada antes de mexer em qualquer coisa.
    await control(application.id, { action: 'cancel', inProgressPolicy: 'discard' }).expect(409);
    assert.deepEqual(applicationOf(application.id).finishResolution, first);
    assert.equal(finishedAudits(), 1);
    assert.equal(db.memory.submissions.filter(item => item.attemptId === started.attemptId).length, 1);

    // Sobra de tentativa (dados antigos) resolvida depois: a primeira decisão fica no histórico.
    db.memory.studentExamState['sobra-guardas'] = {
        id: 'attempt-sobra', attemptId: 'attempt-sobra', applicationId: application.id, studentEmail: students.bruno.email,
        studentClass: classA, courseId, examKey, attemptNumber: 1, status: 'active', answers: { 1: 'A' },
        startedAt: Date.now() - 1000, assignedVersion: 'A',
    };
    await control(application.id, { action: 'finish', inProgressPolicy: 'discard' }).expect(200);
    const resolved = applicationOf(application.id);
    assert.deepEqual(resolved.previousFinishResolutions, [first]);
    assert.equal(resolved.status, 'finished');
    assert.equal(db.memory.studentExamState['sobra-guardas'], undefined);
});

test('[UC-APLICACAO-001] token perdido: o professor gera outro sem preparar de novo nem encerrar a prova', async () => {
    const { ana, bruno } = students;
    const historyId = await createHistory(classA);
    const created = await admin('post', '/api/admin/exam-applications').send({
        studentClass: classA,
        courseId,
        examKey,
        historyId,
        applicationOptions: { timerMode: 'per_attempt', waitingRoomMinutes: 0, maxAttempts: 1, tokenEnabled: true, accessToken: 'ABCDE' },
    }).expect(201);
    const applicationId = created.body.application.id;
    await control(applicationId, { action: 'start' }).expect(200);
    const validate = (student, token) => request(app)
        .post('/api/student/validate-exam-token')
        .set('x-session-token', student.token)
        .send({ email: student.email, studentClass: classA, courseId, examKey, applicationId, token })
        .expect(200);
    assert.equal((await validate(ana, 'ABCDE')).body.valid, true);

    const generated = await admin('post', `/api/admin/exam-applications/${applicationId}/access-token`).send({}).expect(200);
    assert.match(generated.body.accessToken, /^[A-Z]{5}$/);
    const chosen = await admin('post', `/api/admin/exam-applications/${applicationId}/access-token`).send({ accessToken: 'fghij' }).expect(200);
    assert.equal(chosen.body.accessToken, 'FGHIJ');
    await admin('post', `/api/admin/exam-applications/${applicationId}/access-token`).send({ accessToken: 'AB1' }).expect(400);

    // A prova seguiu: mesma aplicação, ninguém perdeu a validação; o token antigo deixou de valer.
    assert.equal(applicationOf(applicationId).status, 'running');
    assert.equal(db.memory.examApplications.filter(item => item.studentClass === classA && ['prepared', 'running'].includes(item.status)).length, 1);
    assert.equal(Object.values(db.memory.studentExamState).find(state => state.applicationId === applicationId && state.studentEmail === ana.email).tokenValidated, true);
    assert.equal((await validate(bruno, 'ABCDE')).body.valid, false);
    assert.equal((await validate(bruno, 'FGHIJ')).body.valid, true);
    const audits = db.memory.auditLogs.filter(log => log.type === 'exam_application_token_regenerated' && log.applicationId === applicationId);
    assert.equal(audits.length, 2);
    assert.equal(JSON.stringify(audits).includes('FGHIJ'), false);

    await control(applicationId, { action: 'finish', inProgressPolicy: 'discard' }).expect(200);
    await admin('post', `/api/admin/exam-applications/${applicationId}/access-token`).send({}).expect(409);
});

test('[UC-MANUT-001] resetar sala mantém conectado quem faz prova em outra turma e o backup guarda as aplicações (CONF-X3)', async () => {
    const davi = { email: 'davi@guards.local', token: 'token-davi', studentClass: classB };
    db.memory.students.push({ name: 'Davi', email: davi.email, status: 'Ativo', classes: [{ name: classA, courseId }, { name: classB, courseId }] });
    resetSessions();
    db.memory.sessions[davi.email] = { token: davi.token, lastSeen: Date.now(), ip: '127.0.0.1' };
    const { application: appA } = await prepareAndStart(classA);
    const { application: appB } = await prepareAndStart(classB);
    const startedDavi = await startAttempt(davi, appB.id);
    await autosave(davi, appB.id, startedDavi.attemptId, { 1: 'C' });

    const preview = await admin('get', '/api/admin/maintenance/preview').query({ studentClass: classA, courseId }).expect(200);
    assert.equal(preview.body.reset.counts.keptInOtherExam, 1);
    assert.equal(preview.body.reset.counts.sessions, 2);

    const reset = await admin('post', '/api/admin/reset').send({ studentClass: classA, courseId, confirm: 'RESETAR' }).expect(200);
    assert.equal(reset.body.disconnectedStudents, 2);
    assert.equal(reset.body.keptInOtherExam, 1);
    assert.ok(db.memory.sessions[davi.email], 'quem está em prova de outra turma continua conectado');
    assert.equal(db.memory.sessions[students.ana.email], undefined);
    assert.deepEqual(openStatesOf(davi, appB.id)[0].answers, { 1: 'C' });
    assert.equal(applicationOf(appA.id).status, 'finished');

    // O backup salvo antes do reset traz as aplicações como estavam: restaurá-lo desfaz o encerramento.
    const snapshot = JSON.parse(fs.readFileSync(path.join(runtimePaths.BACKUPS_DIR, reset.body.backup), 'utf8'));
    assert.equal(snapshot.data.examApplications.find(item => item.id === appA.id).status, 'running');

    resetSessions();
    await control(appB.id, { action: 'finish', inProgressPolicy: 'discard' }).expect(200);
    db.memory.students = db.memory.students.filter(student => student.email !== davi.email);
});
