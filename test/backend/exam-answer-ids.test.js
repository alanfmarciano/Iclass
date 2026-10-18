// Letras das alternativas na prova online (AVA-05): o aluno vê a letra da POSIÇÃO na
// versão dele e o navegador nunca recebe a letra original (a do gabarito). As respostas
// vão e voltam como identificadores opacos e ficam guardadas com a letra original.
// Também: aparelho sem tela cheia registrado no Monitor sem pausar a prova (UXA-02) e
// saída da prova registrada com o motivo (AVA-12).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-answer-ids-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const crypto = require('node:crypto');
const { alternativeAnswerId, decodeStudentAnswers } = require('../../backend/utils/examAnswerIds.js');

let app;
const adminToken = 'admin-token-answer-ids';
const adminEmail = 'admin@answer-ids.local';
const studentClass = 'Turma Letras';
const courseId = 'curso-letras';
const examKey = 'Avaliacao_Letras';
const students = {
    ana: { email: 'ana@answer-ids.local', token: 'token-ana' },
    bruno: { email: 'bruno@answer-ids.local', token: 'token-bruno' },
    carla: { email: 'carla@answer-ids.local', token: 'token-carla' },
    diego: { email: 'diego@answer-ids.local', token: 'token-diego' },
    eva: { email: 'eva@answer-ids.local', token: 'token-eva' },
    fabio: { email: 'fabio@answer-ids.local', token: 'token-fabio' },
};
// Gabarito original: questão 1 = C, questão 2 = A.
const CORRECT = { 1: 'C', 2: 'A' };
// Versão A embaralhada: a ordem na tela é esta (posições A, B, C, D).
const ORDER = { 1: ['C', 'A', 'D', 'B'], 2: ['B', 'D', 'A', 'C'] };

function shuffledSnapshot() {
    return [{
        version: 'A',
        questions: [1, 2].map(number => ({
            originalNumber: number,
            text: `Questão ${number}`,
            alternatives: ORDER[number].map((letter, index) => ({
                letter,
                displayLetter: 'ABCD'[index],
                text: `Texto ${letter} da questão ${number}`,
            })),
        })),
    }];
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
    db.memory.courses = [{ id: courseId, structure: [{ name: 'Módulo', units: [{ avaliacaoKey: examKey }] }] }];
    db.memory.classes = [{ name: studentClass, courseId, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} }];
    db.memory.evaluations = {
        [examKey]: {
            key: examKey,
            title: 'Prova das letras',
            questions: [1, 2].map(number => ({
                number,
                text: `Questão ${number}`,
                correctAnswer: CORRECT[number],
                alternatives: ['A', 'B', 'C', 'D'].map(letter => ({ letter, text: `Texto ${letter} da questão ${number}`, isCorrect: letter === CORRECT[number] })),
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

let sharedApplication = null;
async function application() {
    if (sharedApplication) return sharedApplication;
    const history = await request(app)
        .post('/api/admin/exam-history/add')
        .set('x-admin-session', adminToken)
        .send({
            studentClass,
            courseId,
            examKey,
            type: 'online',
            questionNumbers: [1, 2],
            printSnapshot: shuffledSnapshot(),
            shuffleAnswers: true,
            durationMinutes: 30,
            waitingRoomMinutes: 0,
            maxAttempts: 2,
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
            applicationOptions: { timerMode: 'per_attempt', waitingRoomMinutes: 0, maxAttempts: 2 },
        })
        .expect(201);
    await request(app)
        .post(`/api/admin/exam-applications/${created.body.application.id}/control`)
        .set('x-admin-session', adminToken)
        .send({ action: 'start' })
        .expect(200);
    sharedApplication = created.body.application;
    return sharedApplication;
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
        .send({ studentClass, courseId, examKey, applicationId, attemptId: started.attemptId, answers, examConfigVersion: started.examConfigVersion })
        .expect(200);
}

function logActivity(student, applicationId, attemptId, eventType, details) {
    return request(app)
        .post('/api/student/log-activity')
        .set('x-session-token', student.token)
        .send({ email: student.email, studentClass, courseId, examKey, applicationId, attemptId, eventType, details })
        .expect(200);
}

function stateOf(attemptId) {
    return Object.values(db.memory.studentExamState).find(state => state?.attemptId === attemptId) || null;
}

// Questões da tentativa como chegam ao navegador: só pelo campo questions do sync e do
// start-attempt (sigilo da prova, G3); a configuração da turma não traz mais as versões.
function payloadQuestions(syncBody) {
    assert.equal(syncBody.onlineExamConfigs?.[examKey]?.versionSnapshots, undefined, 'a configuração não traz as versões da prova');
    return syncBody.questions;
}

// Identificador que o navegador recebe para a alternativa na posição dada.
function idAt(syncBody, questionNumber, position) {
    const question = payloadQuestions(syncBody).find(item => Number(item.originalNumber ?? item.number) === questionNumber);
    return question.alternatives['ABCD'.indexOf(position)].id;
}

test('[UC-PROVA-003] o navegador recebe só identificadores opacos e o texto das alternativas, nunca a letra original (AVA-05)', async () => {
    const { ana } = students;
    const app1 = await application();
    const started = await startAttempt(ana, app1.id);
    const synced = await sync(ana, app1.id, started.attemptId);
    const questions = payloadQuestions(synced.body);
    assert.equal(questions.length, 2);
    for (const question of questions) {
        const number = Number(question.originalNumber ?? question.number);
        assert.deepEqual(question.alternatives.map(alternative => alternative.text), ORDER[number].map(letter => `Texto ${letter} da questão ${number}`));
        const ids = new Set();
        for (const alternative of question.alternatives) {
            assert.deepEqual(Object.keys(alternative).sort(), ['id', 'letter', 'text']);
            assert.match(alternative.id, /^[0-9A-Z]{13}$/);
            // letter repete o id para páginas da prova abertas antes desta versão.
            assert.equal(alternative.letter, alternative.id);
            ids.add(alternative.id);
        }
        assert.equal(ids.size, question.alternatives.length);
    }
    // Nada do sync (questões, configuração, estado) traz a letra original ou o gabarito.
    const serialized = JSON.stringify(synced.body);
    for (const leak of ['isCorrect', 'correctAnswer', 'displayLetter', 'canonicalLetter']) {
        assert.equal(serialized.includes(leak), false, `${leak} não pode chegar ao aluno`);
    }
    // Outra aplicação da mesma prova tem outros identificadores.
    assert.notEqual(alternativeAnswerId(app1.id, 1, 'C'), alternativeAnswerId('outra-aplicacao', 1, 'C'));
    // O segredo dos identificadores é gerado no boot e fica só no servidor.
    assert.match(db.memory.config.examAnswerSecret, /^[0-9a-f]{64}$/);
});

test('[UC-PROVA-003] resposta pelo identificador é guardada com a letra original e corrigida certo (AVA-05)', async () => {
    const { ana } = students;
    const app1 = await application();
    const synced = await sync(ana, app1.id);
    const started = { attemptId: synced.body.attemptId, examConfigVersion: synced.body.examConfigVersion };
    // Questão 1: posição A é a original C (certa). Questão 2: posição C é a original A (certa).
    const answers = { 1: idAt(synced.body, 1, 'A'), 2: idAt(synced.body, 2, 'C') };
    await autosave(ana, app1.id, started.attemptId, answers);
    assert.deepEqual(stateOf(started.attemptId).answers, { 1: 'C', 2: 'A' });
    assert.equal(stateOf(started.attemptId).alternativeLabels, 'position');

    const again = await sync(ana, app1.id, started.attemptId);
    assert.deepEqual(again.body.state.answers, answers, 'o sync devolve os identificadores, não as letras');

    await submit(ana, app1.id, started, answers);
    const submission = db.memory.submissions.find(item => item.attemptId === started.attemptId);
    assert.deepEqual(submission.gradedAnswers.map(answer => answer.studentChoice), ['C', 'A']);
    assert.equal(submission.correctCount, 2);
    assert.equal(submission.score, 100);
    assert.equal(submission.alternativeLabels, 'position');
});

test('[UC-PROVA-003] tentativa nova: letra avulsa é a posição que o aluno vê, não a original; identificador estranho é ignorado (AVA-05)', async () => {
    const { bruno } = students;
    const app1 = await application();
    const started = await startAttempt(bruno, app1.id);
    // Antes o servidor guardava a letra como veio: mandar "C" marcava a original C (a
    // certa da questão 1) e o aluno conseguia sondar o gabarito.
    await autosave(bruno, app1.id, started.attemptId, { 1: 'C', 2: 'B' });
    assert.deepEqual(stateOf(started.attemptId).answers, { 1: 'D', 2: 'D' });

    await autosave(bruno, app1.id, started.attemptId, {
        1: 'ZZZZZZZZZZZZZ',
        2: alternativeAnswerId('outra-aplicacao', 2, 'A'),
    });
    assert.deepEqual(stateOf(started.attemptId).answers, {}, 'identificadores que não são desta aplicação não viram resposta');
});

test('[UC-PROVA-003] tentativa antiga (sem a marca de posição): letra avulsa continua sendo a original', async () => {
    const { carla } = students;
    const app1 = await application();
    const started = await startAttempt(carla, app1.id);
    delete stateOf(started.attemptId).alternativeLabels;
    await autosave(carla, app1.id, started.attemptId, { 1: 'C', 2: 'B' });
    assert.deepEqual(stateOf(started.attemptId).answers, { 1: 'C', 2: 'B' });
    await submit(carla, app1.id, started, { 1: 'C', 2: 'B' });
    const submission = db.memory.submissions.find(item => item.attemptId === started.attemptId);
    assert.deepEqual(submission.gradedAnswers.map(answer => answer.studentChoice), ['C', 'B']);
    assert.equal(submission.correctCount, 1);
    assert.equal(submission.alternativeLabels, undefined);
});

test('[UC-PROVA-003] "Ver respostas" mostra a letra que o aluno viu e a original ao lado (AVA-05)', async () => {
    const app1 = await application();
    const anaSubmission = db.memory.submissions.find(item => item.student?.email === students.ana.email && item.applicationId === app1.id);
    const review = await request(app)
        .get(`/api/admin/submissions/${anaSubmission.id}/review`)
        .set('x-admin-session', adminToken)
        .expect(200);
    assert.equal(review.body.alternativeLabels, 'position');
    const [first, second] = review.body.questions;
    assert.equal(first.studentChoice, 'C');
    assert.equal(first.studentChoiceSeen, 'A');
    assert.equal(first.correctAnswerSeen, 'A');
    assert.deepEqual(first.alternatives.map(alternative => [alternative.letter, alternative.canonicalLetter]), [['A', 'C'], ['B', 'A'], ['C', 'D'], ['D', 'B']]);
    assert.equal(first.alternatives[0].selectedByStudent, true);
    assert.equal(first.alternatives[0].correct, true);
    assert.equal(second.studentChoiceSeen, 'C');
    assert.equal(second.studentChoice, 'A');

    // Entrega online antiga: a tela mostrava a letra original.
    const carlaSubmission = db.memory.submissions.find(item => item.student?.email === students.carla.email && item.applicationId === app1.id);
    const legacy = await request(app)
        .get(`/api/admin/submissions/${carlaSubmission.id}/review`)
        .set('x-admin-session', adminToken)
        .expect(200);
    assert.equal(legacy.body.alternativeLabels, 'original');
    assert.equal(legacy.body.questions[0].studentChoiceSeen, 'C');
    legacy.body.questions[0].alternatives.forEach(alternative => assert.equal(alternative.letter, alternative.canonicalLetter));

    // Prova impressa lançada à mão: a letra impressa (displayLetter) da versão.
    const printed = {
        id: 'sub_impressa_letras',
        student: { name: 'Aluno 4', email: students.diego.email, studentClass, courseId },
        examKey,
        assignedVersion: 'A',
        gradedAnswers: [{ questionNumber: 1, studentChoice: 'A', correctAnswer: 'C', isCorrect: false }],
        examSnapshot: { version: 'A', questions: [shuffledSnapshot()[0].questions[0]] },
        score: 0,
        timestamp: new Date().toISOString(),
    };
    db.memory.submissions.push(printed);
    const manual = await request(app)
        .get(`/api/admin/submissions/${printed.id}/review`)
        .set('x-admin-session', adminToken)
        .expect(200);
    assert.equal(manual.body.alternativeLabels, 'printed');
    assert.equal(manual.body.questions[0].studentChoiceSeen, 'B');
    assert.equal(manual.body.questions[0].correctAnswerSeen, 'A');
    db.memory.submissions = db.memory.submissions.filter(item => item.id !== printed.id);
});

test('[UC-PROVA-003] o aluno vê nas próprias entregas as letras da tela dele (AVA-05)', async () => {
    const { ana } = students;
    const app1 = await application();
    const response = await request(app)
        .post('/api/student/my-submissions')
        .set('x-session-token', ana.token)
        .send({ email: ana.email, studentClass, courseId })
        .expect(200);
    const list = Array.isArray(response.body) ? response.body : (response.body.submissions || []);
    const own = list.find(item => item.applicationId === app1.id);
    assert.ok(own, 'a entrega da aluna aparece');
    assert.deepEqual(own.gradedAnswers.map(answer => answer.studentChoice), ['A', 'C']);
    // A entrega guardada continua com a letra original.
    const stored = db.memory.submissions.find(item => item.id === own.id);
    assert.deepEqual(stored.gradedAnswers.map(answer => answer.studentChoice), ['C', 'A']);
});

test('[UC-PROVA-003] Monitor ao vivo mostra a letra vista na tentativa em andamento (AVA-05)', async () => {
    const { bruno } = students;
    const app1 = await application();
    const synced = await sync(bruno, app1.id);
    await autosave(bruno, app1.id, synced.body.attemptId, { 1: idAt(synced.body, 1, 'B') });
    const review = await request(app)
        .get(`/api/admin/monitor-review/${encodeURIComponent(studentClass)}/${examKey}`)
        .set('x-admin-session', adminToken)
        .query({ courseId, applicationId: app1.id, studentEmail: bruno.email })
        .expect(200);
    assert.equal(review.body.alternativeLabels, 'position');
    const first = review.body.questions.find(question => question.questionNumber === 1);
    assert.equal(first.studentChoice, 'A');
    assert.equal(first.studentChoiceSeen, 'B');
});

test('[UC-PROVA-003] aparelho sem tela cheia aparece no Monitor sem pausar a prova; a saída da prova registra o motivo (UXA-02, AVA-12)', async () => {
    const { bruno, diego } = students;
    const app1 = await application();
    const brunoAttempt = (await sync(bruno, app1.id)).body.attemptId;
    await logActivity(bruno, app1.id, brunoAttempt, 'fullscreen_unsupported', 'Dispositivo sem tela cheia: a prova seguiu sem ela');
    assert.notEqual(stateOf(brunoAttempt).focusLocked, true, 'sem tela cheia não pausa a prova');

    const diegoStarted = await startAttempt(diego, app1.id);
    await logActivity(diego, app1.id, diegoStarted.attemptId, 'exam_left', 'Saiu da prova pelo botão voltar do navegador');
    assert.equal(stateOf(diegoStarted.attemptId).focusLocked, true);

    const monitor = await request(app)
        .get(`/api/admin/monitor-status/${encodeURIComponent(studentClass)}/${examKey}`)
        .set('x-admin-session', adminToken)
        .query({ courseId, applicationId: app1.id })
        .expect(200);
    const row = email => monitor.body.find(item => item.email === email);
    assert.equal(row(bruno.email).fullscreenUnsupported, true);
    assert.equal(row(bruno.email).focusLocked, false);
    assert.equal(row(students.ana.email).fullscreenUnsupported, false);
    assert.equal(row(diego.email).focusLocked, true);
    assert.equal(row(diego.email).focusLockReason, 'Saiu da prova pelo botão voltar do navegador');
});

// Conta os HMACs calculados durante fn (cada identificador custa um HMAC).
function countHmacs(fn) {
    const original = crypto.createHmac;
    let calls = 0;
    crypto.createHmac = (...args) => { calls += 1; return original.apply(crypto, args); };
    try {
        const result = fn();
        return { result, calls };
    } finally {
        crypto.createHmac = original;
    }
}

test('[UC-PROVA-003] chaves de questões que não estão na tentativa são descartadas sem calcular HMAC (sem travar o servidor)', async () => {
    const questions = shuffledSnapshot()[0].questions;
    const junk = {};
    for (let index = 0; index < 5000; index += 1) junk[1000 + index] = `Z${String(index).padStart(12, '0')}`;
    const valid = alternativeAnswerId('escopo-teste-dos', 1, 'C');
    // Antes: 26 HMACs por chave inventada (5000 chaves = 130 mil HMACs, ~1 s de CPU parada).
    const { result, calls } = countHmacs(() => decodeStudentAnswers({ ...junk, 1: valid, '01': 'B' }, {
        scope: 'escopo-teste-dos',
        questions,
        positional: true,
    }));
    assert.deepEqual(result, { 1: 'A' }, 'só as questões da tentativa; "01" é a questão 1 (posição B = original A)');
    assert.ok(calls <= 4, `no máximo os HMACs das alternativas da questão 1 (foram ${calls})`);

    // Sem a lista de questões (registro antigo sem snapshot): número de respostas limitado.
    const manyIds = {};
    for (let index = 0; index < 1000; index += 1) manyIds[index + 1] = `Z${String(index).padStart(12, '0')}`;
    const unknown = countHmacs(() => decodeStudentAnswers(manyIds, { scope: 'escopo-teste-dos', questions: [] }));
    assert.ok(unknown.calls <= 200 * 26, `HMACs limitados sem a lista de questões (foram ${unknown.calls})`);

    // Pela rota: milhares de chaves inventadas no salvamento não viram resposta.
    const { eva } = students;
    const app1 = await application();
    // As questões (e os identificadores) chegam com a tentativa iniciada.
    const started = await startAttempt(eva, app1.id);
    const synced = { body: started };
    const before = Date.now();
    const { calls: routeCalls } = await (async () => {
        const original = crypto.createHmac;
        let count = 0;
        crypto.createHmac = (...args) => { count += 1; return original.apply(crypto, args); };
        try {
            await autosave(eva, app1.id, started.attemptId, { ...junk, 2: idAt(synced.body, 2, 'C') });
        } finally {
            crypto.createHmac = original;
        }
        return { calls: count };
    })();
    assert.deepEqual(stateOf(started.attemptId).answers, { 2: 'A' });
    assert.ok(routeCalls < 100, `o salvamento não calcula HMAC para as chaves inventadas (foram ${routeCalls})`);
    assert.ok(Date.now() - before < 5000);
});

test('[UC-PROVA-003] estado criado antes da atualização (instruções abertas ou tentativa antiga vinculada) começa com a letra da posição (AVA-05)', async () => {
    const { eva, fabio } = students;
    const app1 = await application();

    // Estado de instruções criado pelo sync antes da atualização: sem a marca.
    const evaSecond = await sync(eva, app1.id);
    await submit(eva, app1.id, { attemptId: evaSecond.body.attemptId, examConfigVersion: evaSecond.body.examConfigVersion }, {});
    const instructions = await sync(eva, app1.id);
    const pending = stateOf(instructions.body.attemptId);
    assert.equal(pending.startedAt, null);
    delete pending.alternativeLabels;
    const started = await startAttempt(eva, app1.id);
    assert.equal(started.attemptId, instructions.body.attemptId);
    assert.equal(stateOf(started.attemptId).alternativeLabels, 'position');
    // Letra avulsa (chamada direta) é a posição: posição A da questão 1 é a original C.
    await autosave(eva, app1.id, started.attemptId, { 1: 'A' });
    assert.deepEqual(stateOf(started.attemptId).answers, { 1: 'C' });

    // Tentativa da interface antiga (chave sem aplicação), ainda nas instruções.
    db.memory.studentExamState[`${fabio.email}_${examKey}`] = {
        studentEmail: fabio.email,
        examKey,
        studentClass,
        courseId,
        answers: {},
        startedAt: null,
        assignedVersion: 'A',
        tokenValidated: true,
    };
    const linked = await startAttempt(fabio, app1.id);
    assert.equal(stateOf(linked.attemptId).alternativeLabels, 'position');
    await autosave(fabio, app1.id, linked.attemptId, { 2: 'A' });
    assert.deepEqual(stateOf(linked.attemptId).answers, { 2: 'B' });
    // O professor vê a letra que o aluno viu (posição A) e a original ao lado.
    const review = await request(app)
        .get(`/api/admin/monitor-review/${encodeURIComponent(studentClass)}/${examKey}`)
        .set('x-admin-session', adminToken)
        .query({ courseId, applicationId: app1.id, studentEmail: fabio.email })
        .expect(200);
    assert.equal(review.body.alternativeLabels, 'position');
    const second = review.body.questions.find(question => question.questionNumber === 2);
    assert.equal(second.studentChoice, 'B');
    assert.equal(second.studentChoiceSeen, 'A');
});
