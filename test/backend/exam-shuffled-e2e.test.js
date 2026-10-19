// Ponta a ponta da prova embaralhada (merge da fase 1: G3 × G4, AVA-02, AVA-05, SEG-02).
// Prova com 2 versões embaralhadas (ordem das questões e das alternativas), dois alunos
// em versões diferentes: um acerta tudo, o outro erra tudo. As questões vão ao aluno
// pelo caminho do G3 (start-attempt e sync, só a tentativa, questionsVersion) com os
// identificadores opacos e a letra da posição do G4; a correção lê as respostas certo e
// cada nota aparece certa em Resultados, na planilha da turma e no boletim. Nenhuma rota
// do aluno entrega gabarito, isCorrect, correctAnswer, letra original nem as versões da
// prova antes da liberação do gabarito. Também as tentativas antigas (começadas antes da
// atualização, alternativeLabels 'original'): letra avulsa é a original e a nota é certa.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-shuffled-e2e-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');

let app;
const adminToken = 'admin-token-shuffled-e2e';
const courseId = 'curso-embaralhado';
const studentClass = 'TURMA EMBARALHADA';
const examKey = 'Avaliacao_EMB_1';
const LETTERS = ['A', 'B', 'C', 'D'];
// Texto das alternativas sem letra nenhuma: o que o aluno lê não diz a letra original.
const WORDS = { A: 'sol', B: 'lua', C: 'mar', D: 'rio' };
const altText = (number, letter) => `Questão ${number}: opção ${WORDS[letter]}`;
const questionText = number => `Enunciado embaralhado ${number}`;
// Gabarito pela letra original.
const CORRECT = { 1: 'B', 2: 'D', 3: 'A', 4: 'C' };
// Cada versão: ordem das questões e, por questão, a ordem das letras originais na tela.
const VERSIONS = {
    A: { order: [3, 1, 4, 2], alternatives: { 1: ['C', 'A', 'D', 'B'], 2: ['D', 'B', 'A', 'C'], 3: ['B', 'D', 'C', 'A'], 4: ['A', 'C', 'B', 'D'] } },
    B: { order: [2, 4, 1, 3], alternatives: { 1: ['B', 'D', 'A', 'C'], 2: ['A', 'C', 'D', 'B'], 3: ['D', 'A', 'B', 'C'], 4: ['C', 'B', 'D', 'A'] } },
};
// Letra que o aluno vê (posição) para uma letra original na versão dele.
const seenLetter = (version, number, original) => LETTERS[VERSIONS[version].alternatives[number].indexOf(original)];
// Errar tudo: a alternativa logo depois da certa, na ordem original.
const wrongLetter = number => LETTERS[(LETTERS.indexOf(CORRECT[number]) + 1) % LETTERS.length];

const students = {
    ana: { email: 'ana@embaralhada.local', name: 'Ana Acerta', version: 'A' },
    bruno: { email: 'bruno@embaralhada.local', name: 'Bruno Erra', version: 'B' },
    // Tentativas começadas antes da atualização (alternativeLabels 'original').
    carla: { email: 'carla@embaralhada.local', name: 'Carla Antiga', version: 'B' },
    diego: { email: 'diego@embaralhada.local', name: 'Diego Antigo', version: 'A' },
};

// Versões como a tela Provas monta (buildExamVersions): letra original, letra impressa,
// isCorrect, correctAnswer e o gabarito da versão. Tudo isso é do professor.
function printSnapshot() {
    return Object.entries(VERSIONS).map(([version, spec]) => {
        const questions = spec.order.map((number, index) => ({
            originalNumber: number,
            examNumber: index + 1,
            text: questionText(number),
            questionText: questionText(number),
            correctAnswer: CORRECT[number],
            alternatives: spec.alternatives[number].map((letter, position) => ({
                letter,
                displayLetter: LETTERS[position],
                text: altText(number, letter),
                isCorrect: letter === CORRECT[number],
            })),
        }));
        const answerKey = Object.fromEntries(questions.map((question, index) => [index + 1, seenLetter(version, question.originalNumber, CORRECT[question.originalNumber])]));
        return { version, examCode: `EMB${version}`, count: questions.length, answerKey, questions };
    });
}

function seed() {
    db.memory.admins = [{ email: 'admin@embaralhada.local', name: 'Admin', role: 'admin', password: db.hashPassword('x') }];
    db.memory.adminSessions = { [adminToken]: { email: 'admin@embaralhada.local', createdAt: Date.now(), lastSeen: Date.now() } };
    db.memory.courses = [{
        id: courseId,
        name: 'Curso Embaralhado',
        structure: [{ id: 'EMB', name: 'Módulo embaralhado', units: [{ id: '1', name: 'Unidade 1', avaliacaoKey: examKey }] }],
    }];
    db.memory.classes = [{ name: studentClass, courseId, registrationEnabled: false, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} }];
    db.memory.students = Object.values(students).map(student => ({
        name: student.name,
        email: student.email,
        status: 'Ativo',
        password: db.hashPassword('123'),
        classes: [{ name: studentClass, courseId }],
    }));
    db.memory.evaluations = {
        [examKey]: {
            key: examKey,
            title: 'Prova embaralhada',
            questions: [1, 2, 3, 4].map(number => ({
                number,
                text: questionText(number),
                correctAnswer: CORRECT[number],
                alternatives: LETTERS.map(letter => ({ letter, text: altText(number, letter), isCorrect: letter === CORRECT[number] })),
            })),
        },
    };
    db.memory.sessions = {};
    db.memory.submissions = [];
    db.memory.examApplications = [];
    db.memory.studentExamState = {};
    db.memory.proctoringLogs = [];
    db.memory.broadcastMessages = [];
    db.memory.courseStructure = [];
}

test.before(async () => {
    await db.init();
    app = createApp();
    seed();
});

test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

const admin = (method, url) => request(app)[method](url).set('x-admin-session', adminToken);

async function login(student) {
    const res = await request(app).post('/api/student/login').send({ email: student.email, password: '123' });
    assert.equal(res.status, 200, res.body && res.body.error);
    student.token = res.body.sessionToken;
}

const asStudent = (student, method, url) => request(app)[method](url).set('x-session-token', student.token);

function sync(student, applicationId, extra = {}) {
    return asStudent(student, 'get', '/api/student/sync')
        .query({ email: student.email, studentClass, courseId, examKey, applicationId, ...extra })
        .expect(200);
}

// Toda resposta de rota do aluno, de todas as fases, para a varredura do sigilo.
const collected = [];
function keep(label, response) {
    collected.push({ label, body: response.body, text: response.text });
    return response;
}

// Rotas do aluno que devolvem algo da prova ou do portal, na fase atual.
async function studentRoutes(student, applicationId, phase) {
    const query = `studentClass=${encodeURIComponent(studentClass)}&courseId=${courseId}`;
    const calls = {
        status: asStudent(student, 'get', `/api/status?${query}`),
        aplicações: asStudent(student, 'get', '/api/student/exam-applications'),
        sync: asStudent(student, 'get', '/api/student/sync').query({ email: student.email, studentClass, courseId, examKey, applicationId }),
        'estado da prova': asStudent(student, 'get', `/api/student/exam-state?email=${encodeURIComponent(student.email)}&${query}&examKey=${examKey}`),
        'minhas entregas': asStudent(student, 'post', '/api/student/my-submissions').send({ email: student.email, studentClass, courseId }),
        notificações: asStudent(student, 'get', `/api/student/notifications?${query}`),
        painel: asStudent(student, 'get', `/api/student/dashboard?${query}`),
        mensagens: asStudent(student, 'get', `/api/student/message-history?email=${encodeURIComponent(student.email)}&${query}&examKey=${examKey}`),
        calendário: asStudent(student, 'get', `/api/student/calendar-events?${query}`),
        biblioteca: asStudent(student, 'get', `/api/student/library?${query}`),
        avisos: asStudent(student, 'get', `/api/student/announcements?${query}`),
        matrículas: asStudent(student, 'get', '/api/student/enrollments'),
        progresso: asStudent(student, 'get', `/api/student/progress?email=${encodeURIComponent(student.email)}`),
        ping: asStudent(student, 'get', '/api/ping'),
        'data.js': asStudent(student, 'get', `/api/data.js?${query}`),
    };
    const results = {};
    for (const [label, pending] of Object.entries(calls)) {
        const response = await pending;
        assert.equal(response.status, 200, `${phase} · ${label}: ${response.status} ${response.text}`);
        results[label] = keep(`${phase} · ${student.email} · ${label}`, response);
    }
    return results;
}

// Campos do professor que nunca vão ao aluno antes da liberação do gabarito.
const FORBIDDEN_FIELDS = ['isCorrect', 'correctAnswer', 'correctAnswerSeen', 'answerKey', 'versionSnapshots', 'examSnapshot', 'printSnapshot', 'displayLetter', 'canonicalLetter', 'studentVersions', 'scoreHistory'];

// Varre um corpo de resposta: nenhum campo do gabarito, nenhuma alternativa com letra
// (só identificador opaco) e nenhuma resposta guardada como letra (só identificador).
function assertNoAnswerKey(label, body, text) {
    const raw = text || JSON.stringify(body);
    for (const field of FORBIDDEN_FIELDS) {
        assert.equal(raw.includes(`"${field}"`) || raw.includes(`${field}:`), false, `${label}: ${field} não pode ir ao aluno`);
    }
    const walk = (value, trail) => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) { value.forEach((item, index) => walk(item, `${trail}[${index}]`)); return; }
        if (Array.isArray(value.alternatives)) {
            value.alternatives.forEach((alternative, index) => {
                assert.deepEqual(Object.keys(alternative).sort(), ['id', 'letter', 'text'], `${label}: ${trail}.alternatives[${index}] só leva id, letter e texto`);
                assert.match(alternative.id, /^[0-9A-Z]{13}$/, `${label}: ${trail}.alternatives[${index}].id opaco`);
                assert.equal(alternative.letter, alternative.id, `${label}: ${trail}.alternatives[${index}].letter não é a letra original`);
            });
        }
        if (value.answers && typeof value.answers === 'object' && !Array.isArray(value.answers)) {
            Object.entries(value.answers).forEach(([number, answer]) => {
                assert.equal(/^[A-Z]$/.test(String(answer)), false, `${label}: ${trail}.answers[${number}] vai como identificador, não como letra`);
            });
        }
        Object.entries(value).forEach(([key, item]) => walk(item, `${trail}.${key}`));
    };
    walk(body, 'corpo');
}

// Nenhum enunciado nem alternativa (antes do início real da tentativa).
function assertNoQuestions(label, text) {
    assert.equal(/Enunciado embaralhado|opção (sol|lua|mar|rio)/.test(text || ''), false, `${label}: questões não podem ir ao aluno antes do início`);
}

function alternativeIdFor(questions, number, original) {
    const question = questions.find(item => Number(item.originalNumber) === number);
    const alternative = question.alternatives.find(item => item.text === altText(number, original));
    return alternative.id;
}

function stateOf(attemptId) {
    return Object.values(db.memory.studentExamState).find(state => state && state.attemptId === attemptId) || null;
}

// Professor prepara a prova com duas versões embaralhadas (questões e alternativas).
async function prepareApplication() {
    const history = await admin('post', '/api/admin/exam-history/add').send({
        studentClass, courseId, examKey, type: 'online', questionNumbers: [1, 2, 3, 4],
        printSnapshot: printSnapshot(), shuffleQuestions: true, shuffleAnswers: true,
        durationMinutes: 30, waitingRoomMinutes: 0, maxAttempts: 1,
    }).expect(200);
    const created = await admin('post', '/api/admin/exam-applications').send({
        studentClass, courseId, examKey, historyId: history.body.entry.id,
        applicationOptions: { timerMode: 'per_attempt', waitingRoomMinutes: 0, maxAttempts: 1 },
    }).expect(201);
    return created.body.application;
}

function submissionOf(student, applicationId) {
    return db.memory.submissions.find(item => item.student?.email === student.email && item.applicationId === applicationId);
}

test('[UC-PROVA-003] prova com 2 versões embaralhadas: cada aluno vê a própria versão pela letra da posição, a nota sai certa em Resultados e no boletim e nada do gabarito vai ao aluno antes da liberação', async () => {
    for (const student of Object.values(students)) await login(student);

    const application = await prepareApplication();
    // A versão de cada aluno escolhida no Monitor antes de ele entrar (o sorteio não a
    // troca depois). Antes, a escolha gravava um estado avulso que o sync (ou a rota
    // antiga exam-state) adotava como tentativa antiga e sorteava outra versão.
    for (const student of Object.values(students)) {
        await admin('post', '/api/admin/assign-student-version')
            .send({ studentEmail: student.email, examKey, applicationId: application.id, version: student.version })
            .expect(200);
    }
    // O Monitor mostra a versão escolhida mesmo antes de o aluno entrar.
    const monitor = await admin('get', `/api/admin/monitor-status/${encodeURIComponent(studentClass)}/${examKey}`)
        .query({ courseId, applicationId: application.id }).expect(200);
    for (const student of Object.values(students)) {
        assert.equal(monitor.body.find(row => row.email === student.email).assignedVersion, student.version, `Monitor: versão de ${student.email}`);
    }

    // Preparada: nada de questões nem gabarito em nenhuma rota do aluno.
    for (const [label, response] of Object.entries(await studentRoutes(students.ana, application.id, 'preparada'))) {
        assertNoQuestions(`preparada · ${label}`, response.text);
    }

    await admin('post', `/api/admin/exam-applications/${application.id}/control`).send({ action: 'start' }).expect(200);
    for (const [label, response] of Object.entries(await studentRoutes(students.bruno, application.id, 'em andamento, antes de começar'))) {
        assertNoQuestions(`antes de começar · ${label}`, response.text);
    }

    // Cada aluno começa a tentativa: as questões chegam só pelo start-attempt e pelo sync.
    const started = {};
    for (const [name, student] of Object.entries(students)) {
        keep(`${name} · sync antes de começar`, await sync(student, application.id));
        const response = keep(`${name} · start-attempt`, await asStudent(student, 'post', `/api/student/exam-applications/${application.id}/start-attempt`).send({}).expect(200));
        started[name] = response.body;
        assert.equal(response.body.state.assignedVersion, student.version, `${name} na versão ${student.version}`);
        const spec = VERSIONS[student.version];
        // Ordem das questões e das alternativas da versão dele, sem a letra original.
        assert.deepEqual(response.body.questions.map(question => question.originalNumber), spec.order);
        assert.deepEqual(response.body.questions.map(question => question.examNumber), [1, 2, 3, 4]);
        response.body.questions.forEach(question => {
            assert.deepEqual(question.alternatives.map(alternative => alternative.text), spec.alternatives[question.originalNumber].map(letter => altText(question.originalNumber, letter)));
        });
        assert.ok(response.body.questionsVersion);
        const running = keep(`${name} · sync com a tentativa`, await sync(student, application.id));
        assert.deepEqual(running.body.questions, response.body.questions, 'o sync manda as mesmas questões');
        assert.equal(running.body.questionsVersion, response.body.questionsVersion);
        const cached = keep(`${name} · sync com as questões em cache`, await sync(student, application.id, { questionsVersion: response.body.questionsVersion }));
        assert.equal(cached.body.questions, null);
    }
    // As duas versões mostram as alternativas em ordens diferentes (mesma questão, ids iguais
    // porque o id é da alternativa, não da posição).
    const anaQ1 = started.ana.questions.find(question => question.originalNumber === 1);
    const brunoQ1 = started.bruno.questions.find(question => question.originalNumber === 1);
    assert.notDeepEqual(anaQ1.alternatives.map(alternative => alternative.id), brunoQ1.alternatives.map(alternative => alternative.id));
    assert.deepEqual([...anaQ1.alternatives.map(alternative => alternative.id)].sort(), [...brunoQ1.alternatives.map(alternative => alternative.id)].sort());

    // Tentativas de Carla e Diego começaram antes da atualização: sem a marca de posição.
    for (const name of ['carla', 'diego']) {
        const state = stateOf(started[name].attemptId);
        assert.equal(state.alternativeLabels, 'position');
        delete state.alternativeLabels;
    }

    // Ana acerta tudo clicando nas alternativas (identificadores); Bruno erra tudo, parte
    // pelo identificador e parte pela letra que vê na tela (navegador antigo).
    const anaAnswers = Object.fromEntries([1, 2, 3, 4].map(number => [number, alternativeIdFor(started.ana.questions, number, CORRECT[number])]));
    const brunoAnswers = {
        1: alternativeIdFor(started.bruno.questions, 1, wrongLetter(1)),
        2: seenLetter('B', 2, wrongLetter(2)),
        3: alternativeIdFor(started.bruno.questions, 3, wrongLetter(3)),
        4: seenLetter('B', 4, wrongLetter(4)),
    };
    // Página antiga da Carla manda a letra original; depois de recarregar, o identificador.
    const carlaAnswers = { 1: CORRECT[1], 2: CORRECT[2], 3: alternativeIdFor(started.carla.questions, 3, CORRECT[3]), 4: alternativeIdFor(started.carla.questions, 4, CORRECT[4]) };
    const diegoAnswers = Object.fromEntries([1, 2, 3, 4].map(number => [number, wrongLetter(number)]));
    const answersOf = { ana: anaAnswers, bruno: brunoAnswers, carla: carlaAnswers, diego: diegoAnswers };

    for (const [name, student] of Object.entries(students)) {
        keep(`${name} · autosave`, await asStudent(student, 'post', '/api/student/autosave-progress')
            .send({ studentClass, courseId, examKey, applicationId: application.id, attemptId: started[name].attemptId, answers: answersOf[name] })
            .expect(200));
    }
    // Guardado sempre com a letra original.
    assert.deepEqual(stateOf(started.ana.attemptId).answers, { 1: 'B', 2: 'D', 3: 'A', 4: 'C' });
    assert.deepEqual(stateOf(started.bruno.attemptId).answers, { 1: 'C', 2: 'A', 3: 'B', 4: 'D' });
    assert.deepEqual(stateOf(started.carla.attemptId).answers, { 1: 'B', 2: 'D', 3: 'A', 4: 'C' });
    assert.deepEqual(stateOf(started.diego.attemptId).answers, { 1: 'C', 2: 'A', 3: 'B', 4: 'D' });
    // O sync devolve as respostas como identificadores (nunca a letra original).
    const brunoSynced = keep('bruno · sync depois de salvar', await sync(students.bruno, application.id));
    assert.deepEqual(brunoSynced.body.state.answers, Object.fromEntries([1, 2, 3, 4].map(number => [number, alternativeIdFor(started.bruno.questions, number, wrongLetter(number))])));

    for (const student of Object.values(students)) await studentRoutes(student, application.id, 'com a tentativa em andamento');

    // Ana, Bruno e Carla enviam; Diego fica com a prova aberta e o encerramento entrega.
    for (const name of ['ana', 'bruno', 'carla']) {
        const response = keep(`${name} · envio`, await asStudent(students[name], 'post', '/api/student/submit').send({
            studentClass, courseId, examKey, applicationId: application.id, attemptId: started[name].attemptId,
            answers: answersOf[name], examConfigVersion: started[name].examConfigVersion,
        }));
        assert.equal(response.status, 200, response.text);
        assert.equal(/"score"\s*:/.test(response.text), false, 'o envio não mostra a nota antes da publicação');
    }
    await admin('post', `/api/admin/exam-applications/${application.id}/control`).send({ action: 'finish', inProgressPolicy: 'submit' }).expect(200);

    // Correção pela letra original, em todas as tentativas.
    const expected = { ana: { score: 100, correct: 4 }, bruno: { score: 0, correct: 0 }, carla: { score: 100, correct: 4 }, diego: { score: 0, correct: 0 } };
    for (const [name, student] of Object.entries(students)) {
        const submission = submissionOf(student, application.id);
        assert.ok(submission, `${name} tem entrega`);
        assert.equal(submission.assignedVersion, student.version);
        assert.equal(submission.score, expected[name].score, `${name}: nota`);
        assert.equal(submission.correctCount, expected[name].correct, `${name}: acertos`);
        assert.equal(submission.totalCount, 4);
        assert.equal(submission.alternativeLabels, ['ana', 'bruno'].includes(name) ? 'position' : undefined);
        assert.deepEqual(submission.examSnapshot.questions.map(question => question.originalNumber), VERSIONS[student.version].order);
    }

    // Encerrada, nota ainda não publicada: nada de nota nem gabarito para o aluno.
    for (const student of Object.values(students)) {
        const routes = await studentRoutes(student, application.id, 'encerrada, sem publicar');
        const own = routes['minhas entregas'].body.submissions.find(item => item.applicationId === application.id);
        assert.equal(own.gradePublished, false);
        assert.equal(own.score, undefined);
        assert.equal(own.correctCount, undefined);
        assert.equal(own.answerKeyReleased, false);
        assert.equal(own.examQuestions, undefined);
        assertNoQuestions(`encerrada · ${student.email} · sync`, routes.sync.text);
    }

    // Resultados (professor): nota e letra que cada aluno viu.
    const results = await admin('get', `/api/admin/submissions?courseId=${courseId}&studentClass=${encodeURIComponent(studentClass)}`).expect(200);
    for (const [name, student] of Object.entries(students)) {
        const row = results.body.find(item => item.student?.email === student.email && item.applicationId === application.id);
        assert.equal(row.score, expected[name].score, `Resultados: nota de ${name}`);
        assert.equal(row.correctCount, expected[name].correct);
        const review = await admin('get', `/api/admin/submissions/${row.id}/review`).expect(200);
        const choices = Object.fromEntries(review.body.questions.map(question => [question.questionNumber, question.studentChoiceSeen]));
        const original = name === 'ana' || name === 'carla' ? CORRECT : Object.fromEntries([1, 2, 3, 4].map(number => [number, wrongLetter(number)]));
        const seen = Object.fromEntries([1, 2, 3, 4].map(number => [number, ['ana', 'bruno'].includes(name) ? seenLetter(student.version, number, original[number]) : original[number]]));
        assert.deepEqual(choices, seen, `Resultados: letras que ${name} viu`);
        review.body.questions.forEach(question => assert.equal(question.isCorrect, name === 'ana' || name === 'carla'));
    }

    // Professor publica as notas; o gabarito continua bloqueado.
    const ids = Object.values(students).map(student => submissionOf(student, application.id).id);
    await admin('post', '/api/admin/submissions/publish').send({ ids, published: true }).expect(200);

    // Boletim (relatório do aluno) e planilha da turma: 10,0 para quem acertou tudo, 0,0 para quem errou.
    const gradebook = await admin('get', `/api/admin/gradebook?courseId=${courseId}&studentClass=${encodeURIComponent(studentClass)}`).expect(200);
    for (const [name, student] of Object.entries(students)) {
        const report = await admin('get', `/api/admin/student/report?email=${encodeURIComponent(student.email)}&courseId=${courseId}&studentClass=${encodeURIComponent(studentClass)}`).expect(200);
        const exam = report.body.modules.flatMap(module => module.exams).find(item => item.examKey === examKey);
        assert.equal(exam.grade, expected[name].score / 10, `boletim: nota de ${name}`);
        assert.equal(report.body.overallAverage, expected[name].score / 10, `boletim: média de ${name}`);
        const row = gradebook.body.rows.find(item => item.email === student.email);
        assert.ok(row, `planilha: linha de ${name}`);
        assert.equal(row.cells[examKey]?.grade, expected[name].score / 10, `planilha: nota de ${name}`);
        assert.equal(row.average, expected[name].score / 10, `planilha: média de ${name}`);
    }

    // Nota publicada, gabarito não liberado: o aluno vê a nota e a letra que marcou, nada mais.
    for (const [name, student] of Object.entries(students)) {
        const routes = await studentRoutes(student, application.id, 'publicada, gabarito bloqueado');
        const own = routes['minhas entregas'].body.submissions.find(item => item.applicationId === application.id);
        assert.equal(own.gradePublished, true);
        assert.equal(own.score, expected[name].score);
        assert.equal(own.answerKeyReleased, false);
        assert.deepEqual(own.gradedAnswers.map(answer => Object.keys(answer).sort()), [1, 2, 3, 4].map(() => ['questionNumber', 'studentChoice']));
        const marked = Object.fromEntries(own.gradedAnswers.map(answer => [answer.questionNumber, answer.studentChoice]));
        const original = name === 'ana' || name === 'carla' ? CORRECT : Object.fromEntries([1, 2, 3, 4].map(number => [number, wrongLetter(number)]));
        const expectedMarks = Object.fromEntries([1, 2, 3, 4].map(number => [number, ['ana', 'bruno'].includes(name) ? seenLetter(student.version, number, original[number]) : original[number]]));
        assert.deepEqual(marked, expectedMarks, `minhas entregas: letras que ${name} viu`);
    }

    // Varredura de todas as respostas do aluno coletadas até aqui (antes da liberação).
    assert.ok(collected.length > 100, `rotas do aluno varridas: ${collected.length}`);
    collected.forEach(item => assertNoAnswerKey(item.label, item.body, item.text));

    // Professor libera o gabarito: agora o aluno vê a resposta certa, pela letra que viu.
    await admin('post', '/api/admin/release-item').send({ studentClass, courseId, itemKey: `Gabarito_${examKey}`, released: true }).expect(200);
    for (const [name, student] of Object.entries(students)) {
        const mine = await asStudent(student, 'post', '/api/student/my-submissions').send({ email: student.email, studentClass, courseId }).expect(200);
        const own = mine.body.submissions.find(item => item.applicationId === application.id);
        assert.equal(own.answerKeyReleased, true, `${name}: gabarito liberado`);
        const position = ['ana', 'bruno'].includes(name);
        own.gradedAnswers.forEach(answer => {
            const number = Number(answer.questionNumber);
            assert.equal(answer.correctAnswer, position ? seenLetter(student.version, number, CORRECT[number]) : CORRECT[number], `${name}: resposta certa da questão ${number} pela letra vista`);
            assert.equal(answer.isCorrect, name === 'ana' || name === 'carla');
        });
        // A prova completa vem na ordem da versão, com as letras que o aluno viu.
        assert.deepEqual(own.examQuestions.map(question => question.number), VERSIONS[student.version].order);
        own.examQuestions.forEach(question => {
            const letters = VERSIONS[student.version].alternatives[question.number];
            assert.deepEqual(question.alternatives.map(alternative => alternative.letter), position ? LETTERS : letters);
            assert.deepEqual(question.alternatives.map(alternative => alternative.text), letters.map(letter => altText(question.number, letter)));
        });
        // As versões da prova e o gabarito da versão continuam só com o professor.
        assert.equal(/versionSnapshots|examSnapshot|answerKey"|displayLetter|canonicalLetter/.test(mine.text), false);
    }
});

test('[UC-PROVA-003] versão trocada no Monitor com o aluno ainda nas instruções: a tentativa segue a ordem da versão nova', async () => {
    const { ana } = students;
    const application = await prepareApplication();
    await admin('post', `/api/admin/exam-applications/${application.id}/control`).send({ action: 'start' }).expect(200);
    // O sorteio deu a versão A na entrada (instruções abertas).
    const random = Math.random;
    Math.random = () => 0;
    try { await sync(ana, application.id); } finally { Math.random = random; }
    const opened = Object.values(db.memory.studentExamState).find(state => state && state.applicationId === application.id && state.studentEmail === ana.email);
    assert.equal(opened.assignedVersion, 'A');
    assert.deepEqual(opened.assignedQuestionNumbers, VERSIONS.A.order);

    // O professor troca para a B antes de ela começar: antes a ordem das questões ficava a
    // da A (só as alternativas mudavam), uma mistura que não é nenhuma das versões.
    await admin('post', '/api/admin/assign-student-version')
        .send({ studentEmail: ana.email, examKey, applicationId: application.id, version: 'B' })
        .expect(200);
    await sync(ana, application.id);
    const started = await asStudent(ana, 'post', `/api/student/exam-applications/${application.id}/start-attempt`).send({}).expect(200);
    assert.equal(started.body.state.assignedVersion, 'B');
    assert.deepEqual(started.body.questions.map(question => question.originalNumber), VERSIONS.B.order);
    started.body.questions.forEach(question => {
        assert.deepEqual(question.alternatives.map(alternative => alternative.text), VERSIONS.B.alternatives[question.originalNumber].map(letter => altText(question.originalNumber, letter)));
    });
    assertNoAnswerKey('start-attempt depois da troca de versão', started.body, started.text);
    await admin('post', `/api/admin/exam-applications/${application.id}/control`).send({ action: 'finish', inProgressPolicy: 'discard' }).expect(200);
});
