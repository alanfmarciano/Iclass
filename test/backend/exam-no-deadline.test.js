// Prova sem prazo ("Cronômetro ativo" desligado, sem duração): não existe fim do tempo,
// então não existe envio automático por tempo. As telas até a 1615783 liam o tempo
// restante null como zero e mandavam auto: true assim que o aluno abria a prova, clicava
// em Iniciar ou era liberado do foco; o servidor aceitava e fechava a tentativa como
// "enviada no fim do tempo" (timer_auto_submit).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-no-deadline-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { encodeAnswersForStudent } = require('../../backend/utils/examAnswerIds.js');

let app;
const adminToken = 'admin-token-sem-prazo';
const adminEmail = 'admin@semprazo.local';
const studentClass = 'Turma Sem Prazo';
const courseId = 'curso-sem-prazo';
const examKey = 'Avaliacao_SemPrazo';
const legacyExamKey = 'Avaliacao_SemPrazo_Legado';
const DURATION_MIN = 30;
const MIN = 60000;
const students = {
    mateus: { email: 'mateus@semprazo.local', token: 'token-mateus' },
    alice: { email: 'alice@semprazo.local', token: 'token-alice' },
    otavio: { email: 'otavio@semprazo.local', token: 'token-otavio' },
    bruno: { email: 'bruno@semprazo.local', token: 'token-bruno' },
    lia: { email: 'lia@semprazo.local', token: 'token-lia' },
};

function evaluationFor(key) {
    return {
        key,
        title: `Prova ${key}`,
        questions: ['A', 'B', 'C'].map((correct, index) => ({
            number: index + 1,
            text: `Questão ${index + 1}`,
            correctAnswer: correct,
            alternatives: ['A', 'B', 'C'].map(letter => ({ letter, text: `Alternativa ${letter}`, isCorrect: letter === correct })),
        })),
    };
}

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
    db.memory.courses = [{ id: courseId, structure: [{ name: 'Módulo', units: [{ avaliacaoKey: examKey }, { avaliacaoKey: legacyExamKey }] }] }];
    db.memory.classes = [{ name: studentClass, courseId, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} }];
    db.memory.evaluations = { [examKey]: evaluationFor(examKey), [legacyExamKey]: evaluationFor(legacyExamKey) };
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

function control(applicationId, action, extra = {}) {
    return request(app)
        .post(`/api/admin/exam-applications/${applicationId}/control`)
        .set('x-admin-session', adminToken)
        .send({ action, ...extra })
        .expect(200);
}

async function createApplication({ timerEnabled, maxAttempts = 2 } = {}) {
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
            applicationOptions: { timerMode: 'per_attempt', waitingRoomMinutes: 0, maxAttempts, durationMinutes: DURATION_MIN, timerEnabled },
        })
        .expect(201);
    const started = await control(created.body.application.id, 'start');
    return started.body.application;
}

// Cada caso encerra a aplicação mesmo se falhar: a próxima preparação da prova não
// pode esbarrar numa aplicação ainda ativa.
async function withApplication(options, run) {
    const application = await createApplication(options);
    try {
        await run(application);
    } finally {
        if (['waiting', 'running', 'paused'].includes(db.memory.examApplications.find(item => item.id === application.id)?.status)) {
            await control(application.id, 'finish', { inProgressPolicy: 'discard' });
        }
    }
}

function sync(student, applicationId, attemptId = '', key = examKey) {
    return request(app)
        .get('/api/student/sync')
        .set('x-session-token', student.token)
        .query({ email: student.email, studentClass, courseId, examKey: key, applicationId, attemptId })
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

function autosave(student, applicationId, attemptId, answers, key = examKey) {
    return request(app)
        .post('/api/student/autosave-progress')
        .set('x-session-token', student.token)
        .send({ studentClass, courseId, examKey: key, applicationId, attemptId, answers });
}

function submit(student, { applicationId, attemptId, examConfigVersion, key = examKey }, answers, auto) {
    return request(app)
        .post('/api/student/submit')
        .set('x-session-token', student.token)
        .send({ studentClass, courseId, examKey: key, applicationId, attemptId, answers, examConfigVersion, auto });
}

function logActivity(student, started, eventType, details) {
    return request(app)
        .post('/api/student/log-activity')
        .set('x-session-token', student.token)
        .send({ email: student.email, studentClass, courseId, examKey, applicationId: started.applicationId, attemptId: started.attemptId, eventType, details })
        .expect(200);
}

function stateOf(attemptId) {
    return Object.values(db.memory.studentExamState).find(state => state?.attemptId === attemptId) || null;
}

function submissionsOf(student, key = examKey) {
    return db.memory.submissions.filter(item => item.examKey === key && item.student?.email === student.email);
}

test('[UC-TENTATIVA-002] prova com "Cronômetro ativo" desligado: o envio automático é recusado com 409 no_deadline e a tentativa continua aberta com as respostas', async () => {
    const { mateus } = students;
    await withApplication({ timerEnabled: false }, async (application) => {
        const started = await startAttempt(mateus, application.id);
        // Sem prazo o tempo restante não vai para o aluno (nem null): a tela antiga lia o
        // null como zero.
        assert.equal(started.state.deadlineAt, null);
        assert.equal(Object.prototype.hasOwnProperty.call(started.state, 'timerRemaining'), false, 'start-attempt sem timerRemaining');
        await autosave(mateus, application.id, started.attemptId, { 1: 'A', 2: 'B' }).expect(200);

        // Abrir a tela de novo (o caso do revisor): o sync também não manda timerRemaining.
        const reopened = await sync(mateus, application.id, started.attemptId);
        assert.equal(reopened.body.state.status, 'active');
        assert.equal(Object.prototype.hasOwnProperty.call(reopened.body.state, 'timerRemaining'), false, 'sync sem timerRemaining');

        // A tela antiga mandava auto: true logo depois desse sync.
        const refused = await submit(mateus, started, { 1: 'A', 2: 'B', 3: 'C' }, true).expect(409);
        assert.equal(refused.body.code, 'no_deadline');
        assert.equal(refused.body.noDeadline, true);
        assert.match(refused.body.error, /não tem tempo limite/);

        // Nada foi gravado: a tentativa continua a mesma, ativa, com as respostas salvas.
        assert.equal(submissionsOf(mateus).length, 0, 'nenhuma entrega');
        const state = stateOf(started.attemptId);
        assert.equal(state.status, 'active');
        assert.deepEqual(state.answers, { 1: 'A', 2: 'B' });
        const afterRefusal = await sync(mateus, application.id, started.attemptId);
        assert.equal(afterRefusal.body.attemptId, started.attemptId);
        assert.equal(afterRefusal.body.attemptsUsed, 0);
        assert.equal(afterRefusal.body.attemptOutcome, null);
        assert.deepEqual(afterRefusal.body.state.answers, encodeAnswersForStudent({ 1: 'A', 2: 'B' }, application.id));

        // O aluno termina e envia: vale, com o motivo do aluno.
        await autosave(mateus, application.id, started.attemptId, { 1: 'A', 2: 'B', 3: 'C' }).expect(200);
        const sent = await submit(mateus, started, { 1: 'A', 2: 'B', 3: 'C' }, false).expect(200);
        assert.equal(sent.body.success, true);
        const [delivery] = submissionsOf(mateus);
        assert.equal(delivery.submissionSource, 'student');
        assert.equal(delivery.answeredCount, 3);
        assert.equal(delivery.correctCount, 3);
        assert.equal(stateOf(started.attemptId), null, 'a tentativa entregue sai do estado');
    });
});

test('[UC-TENTATIVA-002] sem prazo: "Iniciar prova" e a liberação do foco não abrem caminho para o envio automático (casos da Alice e do Otávio)', async () => {
    const { alice, otavio } = students;
    await withApplication({ timerEnabled: false }, async (application) => {

        // Alice clica em Iniciar: a tela antiga mandava auto: true com 0 respostas na hora.
        const startedAlice = await startAttempt(alice, application.id);
        const refusedAlice = await submit(alice, startedAlice, {}, true).expect(409);
        assert.equal(refusedAlice.body.code, 'no_deadline');
        assert.equal(stateOf(startedAlice.attemptId).status, 'active');
        assert.equal(submissionsOf(alice).length, 0);

        // Otávio fica bloqueado por foco e a professora libera: a tela antiga enviava sozinha
        // no sync seguinte. Bloqueado ou liberado, o envio automático não fecha a tentativa.
        const startedOtavio = await startAttempt(otavio, application.id);
        await autosave(otavio, application.id, startedOtavio.attemptId, { 1: 'B' }).expect(200);
        await logActivity(otavio, startedOtavio, 'tab_blur', 'Aba oculta');
        assert.equal(stateOf(startedOtavio.attemptId).focusLocked, true);
        const whileLocked = await submit(otavio, startedOtavio, { 1: 'B' }, true).expect(409);
        assert.equal(whileLocked.body.code, 'no_deadline');
        assert.equal(stateOf(startedOtavio.attemptId).focusLocked, true, 'continua bloqueado até o professor liberar');
        await request(app)
            .post('/api/admin/unlock-student-focus')
            .set('x-admin-session', adminToken)
            .send({ studentEmail: otavio.email, studentClass, courseId, examKey, applicationId: application.id })
            .expect(200);
        const afterUnlock = await sync(otavio, application.id, startedOtavio.attemptId);
        assert.equal(afterUnlock.body.state.focusLocked, false);
        assert.equal(Object.prototype.hasOwnProperty.call(afterUnlock.body.state, 'timerRemaining'), false);
        await submit(otavio, startedOtavio, { 1: 'B' }, true).expect(409);
        assert.equal(stateOf(startedOtavio.attemptId).status, 'active');
        assert.deepEqual(stateOf(startedOtavio.attemptId).answers, { 1: 'B' });
        assert.equal(submissionsOf(otavio).length, 0);

        // Aplicação pausada e retomada: o envio automático sem prazo também é recusado.
        await control(application.id, 'pause');
        await submit(otavio, startedOtavio, { 1: 'B' }, true).expect(409);
        await control(application.id, 'resume');
        await submit(otavio, startedOtavio, { 1: 'B' }, true).expect(409);
        assert.equal(submissionsOf(otavio).length, 0);
    });
});

test('[UC-TENTATIVA-002] com prazo nada muda: o envio automático no fim do tempo segue aceito como timer_auto_submit', async () => {
    const { bruno } = students;
    await withApplication({ timerEnabled: true, maxAttempts: 1 }, async (application) => {
        const started = await startAttempt(bruno, application.id);
        assert.ok(started.state.timerRemaining > (DURATION_MIN - 1) * 60, `tempo restante: ${started.state.timerRemaining}`);
        await autosave(bruno, application.id, started.attemptId, { 1: 'A' }).expect(200);

        // Com o prazo ainda à frente, o envio automático continua recusado como "mais tempo".
        const early = await submit(bruno, started, { 1: 'A' }, true).expect(409);
        assert.equal(early.body.deadlineExtended, true);
        assert.notEqual(early.body.code, 'no_deadline');

        // Prazo vencido há 2 s: o navegador entrega sozinho e vale.
        stateOf(started.attemptId).startedAt = Date.now() - DURATION_MIN * MIN - 2000;
        const expired = await sync(bruno, application.id, started.attemptId);
        assert.equal(expired.body.state.timerRemaining, 0);
        const sent = await submit(bruno, started, { 1: 'A', 2: 'B' }, true).expect(200);
        assert.equal(sent.body.success, true);
        const [delivery] = submissionsOf(bruno);
        assert.equal(delivery.submissionSource, 'timer_auto_submit');
        assert.equal(delivery.answeredCount, 2);
    });
});

test('[UC-TENTATIVA-002] estado avulso (sem aplicação) sem prazo: cronômetro desligado ou sem duração recusam o envio automático e aceitam o do aluno', async () => {
    const { lia } = students;
    const cls = db.memory.classes[0];
    const versionSnapshots = [{
        version: 'A',
        questions: [1, 2, 3].map(number => ({
            originalNumber: number,
            text: `Questão ${number}`,
            alternatives: ['A', 'B', 'C'].map(letter => ({ letter, text: `Alternativa ${letter}` })),
        })),
    }];
    for (const [label, extra] of [['cronômetro desligado', { timerEnabled: false, durationMinutes: 30 }], ['sem duração', { durationMinutes: 0 }]]) {
        db.memory.submissions = db.memory.submissions.filter(item => item.examKey !== legacyExamKey);
        Object.keys(db.memory.studentExamState).forEach(key => {
            if (db.memory.studentExamState[key]?.examKey === legacyExamKey) delete db.memory.studentExamState[key];
        });
        const version = `legado-${label}`;
        cls.onlineExamConfigs[legacyExamKey] = {
            onlineActive: true,
            status: 'running',
            startTime: Date.now() - 5 * MIN,
            timerMode: 'collective',
            maxAttempts: 1,
            updatedAt: version,
            versionSnapshots,
            ...extra,
        };
        const opened = await sync(lia, '', '', legacyExamKey);
        assert.ok(opened.body.state.startedAt > 0, `${label}: começou pelo horário da turma`);
        assert.equal(Object.prototype.hasOwnProperty.call(opened.body.state, 'timerRemaining'), false, `${label}: sem timerRemaining`);
        await autosave(lia, '', '', { 1: 'C' }, legacyExamKey).expect(200);

        const refused = await submit(lia, { applicationId: '', attemptId: null, examConfigVersion: version, key: legacyExamKey }, { 1: 'C' }, true).expect(409);
        assert.equal(refused.body.code, 'no_deadline', label);
        assert.equal(submissionsOf(lia, legacyExamKey).length, 0, `${label}: nenhuma entrega`);
        const state = Object.values(db.memory.studentExamState).find(item => item?.examKey === legacyExamKey && item.studentEmail === lia.email);
        assert.ok(state && state.startedAt && state.status !== 'submitted', `${label}: a tentativa continua`);
        assert.deepEqual(state.answers, { 1: 'C' });

        await submit(lia, { applicationId: '', attemptId: null, examConfigVersion: version, key: legacyExamKey }, { 1: 'C', 2: 'B' }, false).expect(200);
        const [delivery] = submissionsOf(lia, legacyExamKey);
        assert.equal(delivery.submissionSource, 'student', label);
    }
    delete cls.onlineExamConfigs[legacyExamKey];
});
