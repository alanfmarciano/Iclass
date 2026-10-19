// Monitor e eventos de foco na revisão da integração da fase 1: evento de foco que chega
// depois da entrega não cria tentativa (nem trava), o Monitor mostra a tentativa atual
// quando a aplicação permite mais de uma, start-attempt durante a pausa diz que a prova
// está pausada e "Dispositivo sem tela cheia" é registrado uma vez por tentativa.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-monitor-attempts-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');

let app;
const adminToken = 'admin-token-monitor-attempts';
const adminEmail = 'admin@monitor-attempts.local';
const studentClass = 'Turma Monitor';
const courseId = 'curso-monitor';
const examKey = 'Avaliacao_Monitor';
const students = {
    ana: { email: 'ana@monitor-attempts.local', token: 'token-ana' },
    bruno: { email: 'bruno@monitor-attempts.local', token: 'token-bruno' },
    carla: { email: 'carla@monitor-attempts.local', token: 'token-carla' },
    diego: { email: 'diego@monitor-attempts.local', token: 'token-diego' },
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
            title: 'Prova do Monitor',
            questions: ['A', 'B', 'C', 'A'].map((correct, index) => ({
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

function admin(method, url) {
    return request(app)[method](url).set('x-admin-session', adminToken);
}

async function finishOpenApplications() {
    for (const application of db.memory.examApplications) {
        if (['waiting', 'running', 'paused'].includes(application.status)) {
            await admin('post', `/api/admin/exam-applications/${application.id}/control`)
                .send({ action: 'finish', inProgressPolicy: 'discard' })
                .expect(200);
        }
    }
}

async function createApplication({ maxAttempts = 1, start = true, timerMode = 'per_attempt' } = {}) {
    await finishOpenApplications();
    const history = await admin('post', '/api/admin/exam-history/add')
        .send({
            studentClass,
            courseId,
            examKey,
            type: 'online',
            questionNumbers: [1, 2, 3, 4],
            printSnapshot: [{
                version: 'A',
                questions: [1, 2, 3, 4].map(number => ({
                    originalNumber: number,
                    text: `Questão ${number}`,
                    alternatives: ['A', 'B', 'C'].map(letter => ({ letter, text: `Alternativa ${letter}` })),
                })),
            }],
            durationMinutes: 30,
            waitingRoomMinutes: 0,
            maxAttempts,
        })
        .expect(200);
    const created = await admin('post', '/api/admin/exam-applications')
        .send({
            studentClass,
            courseId,
            examKey,
            historyId: history.body.entry.id,
            applicationOptions: { timerMode, waitingRoomMinutes: 0, maxAttempts },
        })
        .expect(201);
    if (!start) return created.body.application;
    const started = await admin('post', `/api/admin/exam-applications/${created.body.application.id}/control`)
        .send({ action: 'start' })
        .expect(200);
    return started.body.application;
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
        .send({ studentClass, courseId, examKey, applicationId, attemptId, answers })
        .expect(200);
}

function submit(student, applicationId, started, answers) {
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
            auto: false,
        })
        .expect(200);
}

function logActivity(student, applicationId, attemptId, eventType, details, extra = {}) {
    return request(app)
        .post('/api/student/log-activity')
        .set('x-session-token', student.token)
        .send({ email: student.email, studentClass, courseId, examKey, applicationId, attemptId, eventType, details, ...extra })
        .expect(200);
}

// Registros iguais em menos de 1 s são deduplicados: cada cena começa "depois".
function ageLogs() {
    db.memory.proctoringLogs.forEach(log => { log.timestamp -= 5000; });
}

async function monitorRow(student, applicationId) {
    const monitor = await admin('get', `/api/admin/monitor-status/${encodeURIComponent(studentClass)}/${encodeURIComponent(examKey)}`)
        .query({ courseId, applicationId })
        .expect(200);
    return monitor.body.find(row => row.email === student.email);
}

function statesOf(student) {
    return Object.entries(db.memory.studentExamState).filter(([, state]) => state?.studentEmail === student.email);
}

test('[UC-TENTATIVA-001] evento de foco depois da entrega (limite 1) fica só no registro: sem tentativa fantasma nem trava', async () => {
    const { ana } = students;
    const application = await createApplication({ maxAttempts: 1 });
    const started = await startAttempt(ana, application.id);
    await autosave(ana, application.id, started.attemptId, { 1: 'A', 2: 'B' });
    await submit(ana, application.id, started, { 1: 'A', 2: 'B', 3: 'C', 4: 'A' });

    // O envio ainda estava a caminho na tela: a aba oculta, a saída da página e a saída
    // da tela cheia chegam depois da entrega (com e sem o id da tentativa entregue).
    await logActivity(ana, application.id, started.attemptId, 'tab_blur', 'Aba oculta');
    await logActivity(ana, application.id, '', 'exam_left', 'Página da prova foi fechada ou recarregada', { pageExit: true });
    await logActivity(ana, application.id, started.attemptId, 'fullscreen_exit', 'Saiu do modo tela cheia da prova');
    const loose = statesOf(ana).filter(([, state]) => !state.applicationId);
    assert.deepEqual(loose, [], 'nenhum estado avulso é gravado');

    const after = await sync(ana, application.id, started.attemptId);
    assert.equal(after.body.attemptId, null, 'o sync não cria tentativa nova');
    assert.equal(after.body.attemptsUsed, 1);
    const open = statesOf(ana).filter(([, state]) => state.applicationId === application.id && !['submitted', 'invalidated'].includes(state.status));
    assert.deepEqual(open, [], 'nenhuma tentativa aberta depois da entrega');

    const row = await monitorRow(ana, application.id);
    assert.equal(row.status, 'finished');
    assert.equal(row.focusLocked, false, 'o Monitor não mostra "Bloqueado" para quem já entregou');
    assert.equal(row.attemptId, started.attemptId);
    assert.ok(row.logs.some(log => log.eventType === 'tab_blur'), 'o evento continua no registro do Monitor');

    const summary = await admin('get', `/api/admin/exam-applications/${application.id}/finish-summary`).expect(200);
    const body = summary.body.summary || summary.body;
    // "Ainda não iniciaram" não conta quem já entregou: só os 3 colegas que não abriram a prova.
    assert.equal(body.waitingToStart, 3, '"Ainda não iniciaram" não conta quem já entregou');
    assert.equal(body.inProgressAttempts, 0);

    const listed = await request(app)
        .get('/api/student/exam-applications')
        .set('x-session-token', ana.token)
        .query({ studentClass, courseId })
        .expect(200);
    const mine = listed.body.applications.find(item => item.id === application.id);
    assert.equal(mine.attemptsExhausted, true, 'as tentativas continuam esgotadas');

    // "Foco" no Monitor para quem já entregou não grava estado nenhum.
    const unlocked = await admin('post', '/api/admin/unlock-student-focus')
        .send({ studentEmail: ana.email, studentClass, courseId, examKey, applicationId: application.id })
        .expect(200);
    assert.equal(unlocked.body.unchanged, true);
    assert.deepEqual(statesOf(ana).filter(([, state]) => !state.applicationId), []);
    assert.equal((await sync(ana, application.id)).body.attemptId, null);
});

test('[UC-TENTATIVA-001] estado avulso travado deixado por versões anteriores não vira tentativa da aplicação', async () => {
    const { bruno } = students;
    // Versão anterior: o evento de foco depois da entrega gravava este estado avulso.
    db.memory.studentExamState[`${bruno.email}_${examKey}`] = {
        studentEmail: bruno.email,
        examKey,
        answers: {},
        timerRemaining: null,
        assignedVersion: 'A',
        individualTimeAdjustment: 0,
        focusLocked: true,
        focusLockedAt: Date.now() - 60000,
        focusLockReason: 'Aba oculta',
    };
    const application = await createApplication({ maxAttempts: 1 });
    const first = await sync(bruno, application.id);
    assert.equal(first.body.state.focusLocked, false, 'a tentativa nova nasce destravada');
    const row = await monitorRow(bruno, application.id);
    assert.equal(row.focusLocked, false);
    assert.notEqual(row.status, 'focus_locked');
    assert.ok(db.memory.studentExamState[`${bruno.email}_${examKey}`], 'o registro antigo não é apagado');
    const started = await startAttempt(bruno, application.id);
    assert.equal(started.state.focusLocked, false);
    await finishOpenApplications();
});

test('[UC-APLICACAO-001] limite 2: o Monitor mostra a tentativa 2 em andamento (situação, progresso, trava e "N de M")', async () => {
    const { carla } = students;
    const application = await createApplication({ maxAttempts: 2 });
    const first = await startAttempt(carla, application.id);
    await submit(carla, application.id, first, { 1: 'A', 2: 'B', 3: 'C', 4: 'A' });

    // Entregou a 1 e ainda não começou a 2: aparece como entregue, tentativa 1 de 2.
    await sync(carla, application.id, first.attemptId);
    const delivered = await monitorRow(carla, application.id);
    assert.equal(delivered.status, 'finished');
    assert.equal(delivered.progress, '4/4');
    assert.equal(delivered.attemptNumber, 1);
    assert.equal(delivered.maxAttempts, 2);
    assert.equal(delivered.attemptId, first.attemptId);

    const second = await startAttempt(carla, application.id);
    assert.equal(second.attemptNumber, 2);
    await autosave(carla, application.id, second.attemptId, { 1: 'A', 2: 'B' });

    // Evento atrasado da tentativa 1 (já entregue) não trava a 2.
    await logActivity(carla, application.id, first.attemptId, 'tab_blur', 'Aba oculta');
    let row = await monitorRow(carla, application.id);
    assert.equal(row.status, 'online');
    assert.equal(row.focusLocked, false);
    assert.equal(row.progress, '2/4', 'progresso da tentativa atual, não da entrega anterior');
    assert.equal(row.attemptNumber, 2);
    assert.equal(row.maxAttempts, 2);
    assert.equal(row.attemptInProgress, true);
    assert.equal(row.attemptId, second.attemptId);
    assert.equal(row.submissionSource, null);
    assert.ok(row.timerRemaining > 0, 'tempo da tentativa em andamento');

    // Perda de foco na tentativa 2: a linha mostra a trava dela.
    ageLogs();
    await logActivity(carla, application.id, second.attemptId, 'tab_blur', 'Aba oculta');
    row = await monitorRow(carla, application.id);
    assert.equal(row.status, 'focus_locked');
    assert.equal(row.focusLocked, true);

    // "Ver respostas" mostra a mesma tentativa da linha.
    const review = await admin('get', `/api/admin/monitor-review/${encodeURIComponent(studentClass)}/${encodeURIComponent(examKey)}`)
        .query({ courseId, applicationId: application.id, studentEmail: carla.email })
        .expect(200);
    assert.equal(review.body.status, 'in_progress');
    assert.equal(review.body.answeredCount, 2);

    // Entregou a 2: volta a aparecer como entregue, tentativa 2 de 2.
    await admin('post', '/api/admin/unlock-student-focus')
        .send({ studentEmail: carla.email, studentClass, courseId, examKey, applicationId: application.id })
        .expect(200);
    await submit(carla, application.id, second, { 1: 'A', 2: 'B', 3: 'A' });
    row = await monitorRow(carla, application.id);
    assert.equal(row.status, 'finished');
    assert.equal(row.attemptNumber, 2);
    assert.equal(row.progress, '3/4');
    await finishOpenApplications();
});

test('[UC-TENTATIVA-001] start-attempt com a aplicação pausada diz que a prova está pausada', async () => {
    const { diego } = students;
    const application = await createApplication({ maxAttempts: 1 });
    await sync(diego, application.id);
    await admin('post', `/api/admin/exam-applications/${application.id}/control`).send({ action: 'pause' }).expect(200);
    const paused = await request(app)
        .post(`/api/student/exam-applications/${application.id}/start-attempt`)
        .set('x-session-token', diego.token)
        .send({})
        .expect(409);
    assert.equal(paused.body.error, 'A prova está pausada pelo professor.');
    assert.equal(paused.body.paused, true);
    await admin('post', `/api/admin/exam-applications/${application.id}/control`).send({ action: 'resume' }).expect(200);
    await startAttempt(diego, application.id);
    await finishOpenApplications();
});

test('[UC-TENTATIVA-001] "Dispositivo sem tela cheia" é registrado uma vez por tentativa', async () => {
    const { diego } = students;
    const application = await createApplication({ maxAttempts: 2 });
    const first = await startAttempt(diego, application.id);
    const unsupported = attemptId => logActivity(diego, application.id, attemptId, 'fullscreen_unsupported', 'Dispositivo sem tela cheia: a prova seguiu sem ela');
    const logsFor = attemptId => db.memory.proctoringLogs.filter(log => log.applicationId === application.id
        && log.studentEmail === diego.email && log.eventType === 'fullscreen_unsupported'
        && (!attemptId || log.attemptId === attemptId));

    // Recarregou a página duas vezes (o navegador manda de novo a cada volta).
    await unsupported(first.attemptId);
    ageLogs();
    const repeated = await unsupported(first.attemptId);
    assert.equal(repeated.body.deduplicated, true);
    ageLogs();
    await unsupported('');
    assert.equal(logsFor(first.attemptId).length, 1, 'uma vez por tentativa, mesmo sem o id da tentativa');
    assert.equal(logsFor().length, 1);

    // Tentativa nova: registra de novo, uma vez.
    await submit(diego, application.id, first, { 1: 'A' });
    const second = await startAttempt(diego, application.id);
    ageLogs();
    await unsupported(second.attemptId);
    ageLogs();
    await unsupported(second.attemptId);
    assert.equal(logsFor(second.attemptId).length, 1);
    assert.equal(logsFor().length, 2);
    const row = await monitorRow(diego, application.id);
    assert.equal(row.fullscreenUnsupported, true);
    await finishOpenApplications();
});

test('[UC-TENTATIVA-001] cronômetro por aluno: quem não começou aparece sem tempo correndo e fora de "Iniciaram"; "Ainda não iniciaram" conta quem não começou nesta aplicação', async () => {
    const { ana, bruno, carla, diego } = students;
    const application = await createApplication({ maxAttempts: 2 });
    // A aplicação abriu há 40 min (mais que os 30 da prova): quem ainda não começou
    // continua com o tempo inteiro pela frente. Antes o Monitor mostrava 0:00 para eles.
    const stored = db.memory.examApplications.find(item => item.id === application.id);
    stored.startsAt -= 40 * 60000;
    const cls = db.memory.classes.find(item => item.name === studentClass);
    cls.onlineExamConfigs[examKey].startTime = stored.startsAt;

    const first = await startAttempt(ana, application.id);
    await sync(bruno, application.id); // parado nas instruções
    const anaRow = await monitorRow(ana, application.id);
    assert.equal(anaRow.attemptStarted, true);
    assert.ok(anaRow.timerRemaining > 29 * 60, `tempo da tentativa da Ana: ${anaRow.timerRemaining}`);
    for (const student of [bruno, carla]) {
        const row = await monitorRow(student, application.id);
        assert.equal(row.attemptStarted, false, `${student.email} não começou`);
        assert.equal(row.timerRemaining, null, `${student.email} sem tempo correndo`);
    }
    const summaryOf = async () => (await admin('get', `/api/admin/exam-applications/${application.id}/finish-summary`).expect(200)).body.summary;
    assert.equal((await summaryOf()).waitingToStart, 3, 'Bruno (instruções), Carla e Diego (nunca abriram)');

    // A Ana entrega a tentativa 1 e fica na tela de envio: o sync dela cria a tentativa 2
    // nas instruções, e ela continua fora de "Ainda não iniciaram".
    await submit(ana, application.id, first, { 1: 'A' });
    const afterDelivery = await sync(ana, application.id, first.attemptId);
    assert.equal(afterDelivery.body.state.status, 'instructions');
    const summary = await summaryOf();
    assert.equal(summary.waitingToStart, 3);
    assert.equal(summary.instructionsAttempts, 2, 'tentativas paradas nas instruções: Bruno e a 2 da Ana');
    const delivered = await monitorRow(ana, application.id);
    assert.equal(delivered.status, 'finished');
    assert.equal(delivered.attemptStarted, true, 'quem já entregou nesta aplicação conta em "Iniciaram"');

    await startAttempt(diego, application.id);
    assert.equal((await summaryOf()).waitingToStart, 2);
    await finishOpenApplications();
});

test('[UC-TENTATIVA-001] cronômetro coletivo pausado: quem ainda não começou fica congelado com o mesmo tempo dos colegas', async () => {
    const { ana, bruno, carla } = students;
    const application = await createApplication({ timerMode: 'collective' });
    const stored = db.memory.examApplications.find(item => item.id === application.id);
    const started = await startAttempt(ana, application.id);
    // A prova começou há 10 min e está pausada há 5 min: restam 25 min para todos,
    // congelados. A Carla tem +3 min esperando a primeira tentativa dela.
    await admin('post', `/api/admin/exam-applications/${application.id}/control`).send({ action: 'pause' }).expect(200);
    const now = Date.now();
    stored.startsAt = now - 10 * 60000;
    stored.pauses = [{ pausedAt: now - 5 * 60000, resumedAt: null }];
    stored.pausedAt = now - 5 * 60000;
    stored.studentAdjustments = { [carla.email]: 3 };
    const cls = db.memory.classes.find(item => item.name === studentClass);
    cls.onlineExamConfigs[examKey].startTime = stored.startsAt;
    const anaState = Object.values(db.memory.studentExamState).find(state => state.attemptId === started.attemptId);
    anaState.startedAt = stored.startsAt;

    const read = async () => Object.fromEntries(await Promise.all([ana, bruno, carla]
        .map(async student => [student.email, (await monitorRow(student, application.id)).timerRemaining])));
    const first = await read();
    await new Promise(resolve => setTimeout(resolve, 1100));
    const second = await read();
    assert.ok(Math.abs(first[ana.email] - 25 * 60) <= 2, `Ana: ${first[ana.email]}`);
    // Antes o Bruno aparecia com 20 min (contados desde o início, sem a pausa) e
    // continuava descendo durante a pausa.
    assert.ok(Math.abs(first[bruno.email] - first[ana.email]) <= 1, `Bruno ${first[bruno.email]} x Ana ${first[ana.email]}`);
    assert.ok(Math.abs(first[carla.email] - (first[ana.email] + 3 * 60)) <= 1, `Carla com o +3 min: ${first[carla.email]}`);
    [ana, bruno, carla].forEach(student => {
        assert.ok(Math.abs(second[student.email] - first[student.email]) <= 0.5, `${student.email} congelado na pausa: ${first[student.email]} -> ${second[student.email]}`);
    });

    // Retomada: o Bruno começa com o mesmo tempo que aparecia para ele.
    await admin('post', `/api/admin/exam-applications/${application.id}/control`).send({ action: 'resume' }).expect(200);
    await startAttempt(bruno, application.id);
    const brunoRow = await monitorRow(bruno, application.id);
    assert.equal(brunoRow.attemptStarted, true);
    assert.ok(Math.abs(brunoRow.timerRemaining - first[bruno.email]) <= 2, `Bruno começou com ${brunoRow.timerRemaining}`);
    await finishOpenApplications();
});
