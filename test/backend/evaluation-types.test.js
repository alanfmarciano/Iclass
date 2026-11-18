// Tipos de questão de ponta a ponta pela API (fase 3, P3-S1: AVA-06, FUN-10). O
// professor salva uma avaliação com os seis tipos pelo PUT, prepara e abre a aplicação;
// o aluno recebe só o que pode ver de cada questão, responde cada tipo no formato dele
// (identificador opaco, lista de identificadores, { numero } e { texto }) e entrega; a
// nota é por pontos e a dissertativa fica aguardando o professor. Resposta de formato
// errado é descartada e nenhum campo do gabarito chega ao aluno.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-evaluation-types-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { alternativeAnswerId } = require('../../backend/utils/examAnswerIds.js');

let app;
const adminToken = 'admin-token-evaluation-types';
const adminEmail = 'admin@tipos.local';
const studentClass = 'Turma Tipos';
const courseId = 'curso-tipos';
const examKey = 'Avaliacao_Tipos';
const students = {
    ana: { email: 'ana@tipos.local', token: 'token-ana-tipos' },
    bruno: { email: 'bruno@tipos.local', token: 'token-bruno-tipos' },
    carla: { email: 'carla@tipos.local', token: 'token-carla-tipos' },
};

// As seis questões como o editor (a partir do A6) manda.
const QUESTIONS = [
    { type: 'multiple_choice', points: 2, text: 'Qual comando lista arquivos?\n\n```\n$ ls -la\n```', alternatives: [{ text: 'ls' }, { text: 'cd' }, { text: 'rm' }], correctAnswer: 'A', explanation: 'O **ls** lista.' },
    { type: 'multiple_answer', points: 3, text: 'Quais são protocolos de transporte?', alternatives: [{ text: 'TCP' }, { text: 'HTTP' }, { text: 'UDP' }, { text: 'DNS' }], correctAnswers: ['A', 'C'] },
    { type: 'true_false', points: 1, text: 'IPv4 tem 32 bits.', correctAnswer: 'A' },
    { type: 'numeric', points: 2, text: 'Latência média em ms?', numeric: { value: 3.5, tolerance: 0.25, unit: 'ms' } },
    { type: 'short_answer', points: 1, text: 'Nome do endereço 255.255.255.0?', acceptedAnswers: ['Máscara de sub-rede', 'máscara'] },
    { type: 'essay', points: 3, text: 'Explique o handshake.', expectedAnswer: 'SYN, SYN-ACK, ACK', rubric: [{ nome: 'Etapas', pontos: 2 }, { nome: 'Clareza', pontos: 1 }] },
];

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
    db.memory.evaluations = { [examKey]: { key: examKey, title: 'Prova antiga', questions: [] } };
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

function putEvaluation(questions, extra = {}) {
    return request(app)
        .put(`/api/admin/evaluation/${examKey}`)
        .set('x-admin-session', adminToken)
        .send({ title: 'Prova de redes', theme: 'Redes', rubric: '', questions, ...extra });
}

// Snapshot como a tela monta (examTools.buildExamVersions): só número, enunciado,
// gabarito de escolha única e alternativas (com a marca e a letra impressa).
function browserSnapshot(evaluation) {
    return [{
        version: 'A',
        questions: evaluation.questions.map((question, index) => ({
            originalNumber: question.originalNumber,
            examNumber: index + 1,
            text: question.text,
            questionText: question.text,
            correctAnswer: question.correctAnswer || (question.alternatives || []).find(alternative => alternative.isCorrect)?.letter || '',
            alternatives: (question.alternatives || []).map((alternative, position) => ({ ...alternative, displayLetter: 'ABCDEFGH'[position] })),
        })),
    }];
}

let sharedApplication = null;
async function application() {
    if (sharedApplication) return sharedApplication;
    const saved = await putEvaluation(QUESTIONS).expect(200);
    const history = await request(app)
        .post('/api/admin/exam-history/add')
        .set('x-admin-session', adminToken)
        .send({
            studentClass, courseId, examKey, type: 'online',
            questionNumbers: saved.body.evaluation.questions.map(question => question.originalNumber),
            printSnapshot: browserSnapshot(saved.body.evaluation),
            shuffleAnswers: false, durationMinutes: 30, waitingRoomMinutes: 0, maxAttempts: 2,
        })
        .expect(200);
    const created = await request(app)
        .post('/api/admin/exam-applications')
        .set('x-admin-session', adminToken)
        .send({ studentClass, courseId, examKey, historyId: history.body.entry.id, applicationOptions: { timerMode: 'per_attempt', waitingRoomMinutes: 0, maxAttempts: 2 } })
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

function stateOf(attemptId) {
    return Object.values(db.memory.studentExamState).find(state => state?.attemptId === attemptId) || null;
}

function idOf(applicationId, number, letter) {
    return alternativeAnswerId(applicationId, number, letter);
}

test('[UC-PROVA-004] PUT da avaliação grava os seis tipos pelo modelo e recusa com a mensagem da questão (FUN-10)', async () => {
    const saved = await putEvaluation(QUESTIONS).expect(200);
    const questions = saved.body.evaluation.questions;
    assert.deepEqual(questions.map(question => question.type), ['multiple_choice', 'multiple_answer', 'true_false', 'numeric', 'short_answer', 'essay']);
    assert.deepEqual(questions.map(question => question.points), [2, 3, 1, 2, 1, 3]);
    assert.deepEqual(questions.map(question => question.originalNumber), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(questions[1].correctAnswers, ['A', 'C']);
    assert.deepEqual(questions[2].alternatives.map(alternative => alternative.text), ['Verdadeiro', 'Falso']);
    assert.deepEqual(questions[3].numeric, { value: 3.5, tolerance: 0.25, unit: 'ms' });
    assert.deepEqual(questions[5].rubric.map(criterion => criterion.id), ['c1', 'c2']);
    assert.equal(questions[0].explanation, 'O **ls** lista.');
    assert.ok(questions[0].text.includes('```'), 'o Markdown do enunciado fica como veio');

    const missingAccepted = await putEvaluation([QUESTIONS[0], { type: 'short_answer', text: 'Q', acceptedAnswers: [] }]).expect(400);
    assert.equal(missingAccepted.body.error, 'Questão 2: informe pelo menos uma resposta aceita.');
    const wrongRubric = await putEvaluation([{ ...QUESTIONS[5], points: 4 }]).expect(400);
    assert.match(wrongRubric.body.error, /^Questão 1: a soma dos critérios da rubrica \(3\) precisa ser igual aos pontos da questão \(4\)\.$/);
    // Tipo errado de campo: o schema responde com o campo (antes virava 500 ou ficava gravado).
    const badPoints = await putEvaluation([{ ...QUESTIONS[0], points: { muito: 1 } }]).expect(400);
    assert.equal(badPoints.body.field, 'questions[0].points');
    const badNumeric = await putEvaluation([{ ...QUESTIONS[3], numeric: 'três' }]).expect(400);
    assert.equal(badNumeric.body.field, 'questions[0].numeric');
    const longText = await putEvaluation([{ ...QUESTIONS[0], text: 'x'.repeat(20001) }]).expect(400);
    assert.equal(longText.body.field, 'questions[0].text');
    // Avaliação antiga (sem type nem points) continua salvando como antes.
    const legacy = await putEvaluation([{ text: 'Antiga', alternatives: [{ letter: 'A', text: 'a' }, { letter: 'B', text: 'b', isCorrect: true }], correctAnswer: 'B' }]).expect(200);
    assert.equal(legacy.body.evaluation.questions[0].type, 'multiple_choice');
    assert.equal(legacy.body.evaluation.questions[0].points, 1);
    // Volta para a prova com os seis tipos (as próximas etapas usam).
    await putEvaluation(QUESTIONS).expect(200);
});

test('[UC-SIGILO-001] a questão chega ao aluno com tipo, pontos, unidade e limite, sem nada do gabarito (contrato C4)', async () => {
    const app1 = await application();
    const started = await startAttempt(students.ana, app1.id);
    const synced = await sync(students.ana, app1.id, started.attemptId);
    const questions = synced.body.questions;
    assert.equal(questions.length, 6);
    assert.deepEqual(questions.map(question => question.type), ['multiple_choice', 'multiple_answer', 'true_false', 'numeric', 'short_answer', 'essay']);
    assert.deepEqual(questions.map(question => question.points), [2, 3, 1, 2, 1, 3]);
    assert.equal(questions[3].unit, 'ms');
    assert.deepEqual(questions.map(question => question.maxLength ?? null), [null, null, null, 32, 300, 10000]);
    assert.deepEqual(questions.map(question => question.alternatives.length), [3, 4, 2, 0, 0, 0]);
    questions.forEach(question => {
        assert.deepEqual(Object.keys(question).sort(), [
            'alternatives', 'examNumber', 'isAdditional', 'originalNumber', 'points', 'questionText', 'replacedQuestionNumber', 'text', 'type',
            ...(question.maxLength ? ['maxLength'] : []), ...(question.unit ? ['unit'] : []),
        ].sort());
    });
    const serialized = JSON.stringify(synced.body);
    for (const leak of ['correctAnswer', 'correctAnswers', 'isCorrect', 'acceptedAnswers', 'Máscara de sub-rede', 'explanation', 'O **ls** lista', 'expectedAnswer', 'SYN-ACK', 'rubric', 'Etapas', 'tolerance', '"numeric":', 'partialCredit', '"review":']) {
        assert.equal(serialized.includes(leak), false, `${leak} não pode chegar ao aluno`);
    }
});

test('[UC-PROVA-003] cada tipo vai e volta no formato dele; formato errado é descartado (D5)', async () => {
    const app1 = await application();
    const synced = await sync(students.ana, app1.id);
    const attemptId = synced.body.attemptId;
    const answers = {
        1: idOf(app1.id, 1, 'A'),
        2: [idOf(app1.id, 2, 'C'), idOf(app1.id, 2, 'A')],
        3: idOf(app1.id, 3, 'A'),
        4: { numero: '3,6 ms' },
        5: { texto: '  mascara  ' },
        6: { texto: 'O cliente manda SYN, o servidor responde SYN-ACK e o cliente confirma.\n' },
    };
    await autosave(students.ana, app1.id, attemptId, answers);
    assert.deepEqual(stateOf(attemptId).answers, {
        1: 'A',
        2: ['A', 'C'],
        3: 'A',
        4: { numero: '3,6 ms' },
        5: { texto: 'mascara' },
        6: { texto: 'O cliente manda SYN, o servidor responde SYN-ACK e o cliente confirma.' },
    });
    const again = await sync(students.ana, app1.id, attemptId);
    assert.deepEqual(again.body.state.answers, {
        1: idOf(app1.id, 1, 'A'),
        2: [idOf(app1.id, 2, 'A'), idOf(app1.id, 2, 'C')],
        3: idOf(app1.id, 3, 'A'),
        4: { numero: '3,6 ms' },
        5: { texto: 'mascara' },
        6: { texto: 'O cliente manda SYN, o servidor responde SYN-ACK e o cliente confirma.' },
    }, 'o sync devolve identificadores (também na lista) e a resposta digitada');

    // Formatos errados para o tipo: nada disso vira resposta.
    const { bruno } = students;
    const other = await startAttempt(bruno, app1.id);
    await autosave(bruno, app1.id, other.attemptId, {
        1: [idOf(app1.id, 1, 'A')],
        2: [idOf(app1.id, 2, 'A'), 'ZZZZZZZZZZZZZ'],
        3: { texto: 'Verdadeiro' },
        4: { numero: '1'.repeat(33) },
        5: 'A',
        6: { texto: 'x'.repeat(10001) },
    });
    assert.deepEqual(stateOf(other.attemptId).answers, {});
    await autosave(bruno, app1.id, other.attemptId, {
        2: [idOf(app1.id, 2, 'B'), idOf(app1.id, 2, 'B')],
        4: { numero: 42 },
        5: { texto: 'x'.repeat(300) },
        6: { texto: '   ' },
    });
    assert.deepEqual(stateOf(other.attemptId).answers, { 2: ['B'], 4: { numero: '42' }, 5: { texto: 'x'.repeat(300) } });
});

test('[UC-PROVA-004] entrega corrigida por pontos; dissertativa aguarda; Monitor e "Ver respostas" mostram cada tipo (AVA-06)', async () => {
    const app1 = await application();
    const synced = await sync(students.ana, app1.id);
    const attemptId = synced.body.attemptId;
    const answers = {
        1: idOf(app1.id, 1, 'A'),
        2: [idOf(app1.id, 2, 'A')],
        3: idOf(app1.id, 3, 'A'),
        4: { numero: '3,6 ms' },
        5: { texto: 'mascara' },
        6: { texto: 'Explico o handshake.' },
    };
    const submitted = await request(app)
        .post('/api/student/submit')
        .set('x-session-token', students.ana.token)
        .send({ studentClass, courseId, examKey, applicationId: app1.id, attemptId, answers, examConfigVersion: synced.body.examConfigVersion })
        .expect(200);
    assert.equal(submitted.body.answeredCount, 6);
    const submission = db.memory.submissions.find(item => item.attemptId === attemptId);
    // 2 + 1,5 (metade das certas) + 1 + 2 (3,6 dentro de 0,25) + 1 + 0 (aguardando) de 12.
    assert.equal(submission.pointsEarned, 7.5);
    assert.equal(submission.pointsPossible, 12);
    assert.equal(submission.score, 63);
    assert.equal(submission.correctCount, 4);
    assert.equal(submission.totalCount, 6);
    const essay = submission.gradedAnswers.find(answer => answer.questionNumber === 6);
    assert.equal(essay.pending, true);
    assert.equal(essay.isCorrect, null);
    assert.equal(essay.studentResponse, 'Explico o handshake.');

    const review = await request(app)
        .get(`/api/admin/submissions/${submission.id}/review`)
        .set('x-admin-session', adminToken)
        .expect(200);
    const byNumber = Object.fromEntries(review.body.questions.map(question => [question.questionNumber, question]));
    assert.equal(byNumber[1].answerText, 'A');
    assert.equal(byNumber[2].answerText, 'A');
    assert.deepEqual(byNumber[2].correctAnswersSeen, ['A', 'C']);
    assert.equal(byNumber[2].alternatives[0].selectedByStudent, true);
    assert.equal(byNumber[4].answerText, '3,6 ms');
    assert.equal(byNumber[5].answerText, 'mascara');
    assert.equal(byNumber[6].answerText, 'Resposta escrita');
    assert.equal(byNumber[6].studentResponse, 'Explico o handshake.');
    assert.equal(byNumber[6].pending, true);
    assert.deepEqual([byNumber[2].pointsEarned, byNumber[2].pointsPossible], [1.5, 3]);

    const monitor = await request(app)
        .get(`/api/admin/monitor-review/${encodeURIComponent(studentClass)}/${examKey}`)
        .query({ courseId, studentEmail: students.ana.email, applicationId: app1.id })
        .set('x-admin-session', adminToken)
        .expect(200);
    assert.equal(monitor.body.answeredCount, 6, 'lista, número e texto contam como respondidas');
    assert.equal(monitor.body.questions.find(question => question.questionNumber === 4).answerText, '3,6 ms');

    // Prova em andamento no Monitor: as respostas digitadas também contam.
    const brunoState = Object.values(db.memory.studentExamState).find(state => state?.studentEmail === students.bruno.email);
    const live = await request(app)
        .get(`/api/admin/monitor-review/${encodeURIComponent(studentClass)}/${examKey}`)
        .query({ courseId, studentEmail: students.bruno.email, applicationId: app1.id })
        .set('x-admin-session', adminToken)
        .expect(200);
    assert.equal(live.body.status, 'in_progress');
    assert.equal(live.body.answeredCount, Object.keys(brunoState.answers).length);

    // A aluna vê as próprias respostas na entrega (sem gabarito nem pontos antes da liberação).
    const mine = await request(app)
        .post('/api/student/my-submissions')
        .set('x-session-token', students.ana.token)
        .send({ courseId, studentClass })
        .expect(200);
    const listed = JSON.stringify(mine.body);
    assert.ok(listed.includes('Explico o handshake.'), 'a resposta escrita é da própria aluna');
    assert.equal(listed.includes('pointsEarned'), false);
    assert.equal(listed.includes('correctAnswers'), false);
    assert.equal(listed.includes('"score"'), false);
});

test('[UC-PROVA-004] entrega de antes do A2 (sem pontos guardados) aparece na revisão como questões de 1 ponto (D1)', async () => {
    const legacy = {
        id: 'sub_legacy_tipos',
        examKey: 'Avaliacao_Antiga_Tipos',
        studentClass,
        courseId,
        student: { email: students.carla.email, name: 'Aluno 3', studentClass, courseId },
        score: 50,
        correctCount: 1,
        totalCount: 2,
        examSnapshot: {
            version: 'A',
            questions: [1, 2, 3].map(number => ({
                originalNumber: number,
                examNumber: number,
                text: `Questão antiga ${number}`,
                alternatives: [{ letter: 'A', text: 'a' }, { letter: 'B', text: 'b' }],
            })),
        },
        gradedAnswers: [
            { questionNumber: 1, studentChoice: 'A', correctAnswer: 'A', isCorrect: true },
            { questionNumber: 2, studentChoice: 'B', correctAnswer: 'A', isCorrect: false },
            { questionNumber: 3, studentChoice: null, correctAnswer: 'B', isCorrect: false, annulled: true, annulmentMode: 'remover_do_total' },
        ],
    };
    db.memory.submissions.push(legacy);
    try {
        const review = await request(app)
            .get(`/api/admin/submissions/${legacy.id}/review`)
            .set('x-admin-session', adminToken)
            .expect(200);
        const byNumber = Object.fromEntries(review.body.questions.map(question => [question.questionNumber, question]));
        assert.deepEqual([1, 2, 3].map(number => byNumber[number].type), ['multiple_choice', 'multiple_choice', 'multiple_choice']);
        assert.deepEqual([1, 2, 3].map(number => [byNumber[number].pointsEarned, byNumber[number].pointsPossible]), [[1, 1], [0, 1], [0, 0]]);
        assert.equal(byNumber[2].answerText, 'B');
    } finally {
        db.memory.submissions = db.memory.submissions.filter(submission => submission.id !== legacy.id);
    }
});

test('[UC-PROVA-004] anulação e correção ao vivo recorrigem pelos pontos e mantêm o tipo e as respostas digitadas', async () => {
    const app1 = await application();
    const submission = db.memory.submissions.find(item => item.student?.email === students.ana.email && item.applicationId === app1.id);
    await request(app)
        .post('/api/admin/annul-question')
        .set('x-admin-session', adminToken)
        .send({ applicationId: app1.id, questionNumber: 2, mode: 'ponto_para_todos', reason: 'duas leituras' })
        .expect(200);
    assert.equal(submission.pointsEarned, 9);
    assert.equal(submission.score, 75);
    assert.equal(submission.gradedAnswers.find(answer => answer.questionNumber === 6).studentResponse, 'Explico o handshake.');
    assert.deepEqual(submission.gradedAnswers.find(answer => answer.questionNumber === 2).studentChoices, ['A']);

    // Correção ao vivo da numérica pelo formulário do Monitor (só enunciado): tipo e
    // gabarito da questão continuam os de antes.
    const corrected = await request(app)
        .post('/api/admin/correct-live-question')
        .set('x-admin-session', adminToken)
        .send({ applicationId: app1.id, questionNumber: 4, question: { text: 'Latência média, em milissegundos?', alternatives: [], correctAnswer: '' } })
        .expect(200);
    assert.equal(corrected.body.question.type, 'numeric');
    assert.deepEqual(corrected.body.question.numeric, { value: 3.5, tolerance: 0.25, unit: 'ms' });
    assert.equal(corrected.body.question.text, 'Latência média, em milissegundos?');
    assert.equal(submission.pointsEarned, 9, 'a nota não muda só por trocar o enunciado');

    // Várias corretas corrigida ao vivo: as marcas novas valem e a entrega é recorrigida.
    await request(app)
        .post('/api/admin/annul-question')
        .set('x-admin-session', adminToken)
        .send({ applicationId: app1.id, questionNumber: 2, mode: 'remover_do_total', reason: 'troca' })
        .expect(200);
    assert.equal(submission.pointsPossible, 9);
});

test('[UC-PROVA-004] editar a avaliação depois de aplicar não muda nota já dada; ao vivo o tipo não muda e o pedido passa pelo schema', async () => {
    const app1 = await application();
    const stored = db.memory.examApplications.find(item => item.id === app1.id);
    // O servidor congelou no snapshot o tipo, os pontos e o gabarito (o navegador não manda).
    const frozen = stored.versionSnapshots[0].questions;
    assert.deepEqual(frozen.map(question => [question.type, question.points]), [
        ['multiple_choice', 2], ['multiple_answer', 3], ['true_false', 1], ['numeric', 2], ['short_answer', 1], ['essay', 3],
    ]);
    assert.deepEqual(frozen[3].numeric, { value: 3.5, tolerance: 0.25, unit: 'ms' });
    assert.deepEqual(frozen[4].acceptedAnswers, ['Máscara de sub-rede', 'máscara']);
    const submission = db.memory.submissions.find(item => item.student?.email === students.ana.email && item.applicationId === app1.id);
    const before = { score: submission.score, pointsEarned: submission.pointsEarned, pointsPossible: submission.pointsPossible };

    // O professor edita a avaliação: a questão 1 passa a valer 20 e a 4 vira dissertativa.
    const edited = QUESTIONS.map((question, index) => {
        if (index === 0) return { ...question, points: 20 };
        if (index === 3) return { type: 'essay', points: 5, text: 'Explique a latência.' };
        return question;
    });
    await putEvaluation(edited).expect(200);
    try {
        // Anular a questão 1 recorrige a aplicação: a nota segue a prova que a aluna fez.
        await request(app)
            .post('/api/admin/annul-question')
            .set('x-admin-session', adminToken)
            .send({ applicationId: app1.id, questionNumber: 1, mode: 'ponto_para_todos', reason: 'recorreção depois de editar' })
            .expect(200);
        assert.deepEqual({ score: submission.score, pointsEarned: submission.pointsEarned, pointsPossible: submission.pointsPossible }, before);
        const fourth = submission.gradedAnswers.find(answer => answer.questionNumber === 4);
        assert.equal(fourth.type, 'numeric');
        assert.equal(fourth.studentResponse, '3,6 ms');
        assert.equal(fourth.pending, false);

        // Correção ao vivo não troca o tipo de uma questão que os alunos estão respondendo.
        const typeChange = await request(app)
            .post('/api/admin/correct-live-question')
            .set('x-admin-session', adminToken)
            .send({ applicationId: app1.id, questionNumber: 4, question: { type: 'essay', text: 'Explique.', alternatives: [] } })
            .expect(400);
        assert.equal(typeChange.body.error, 'O tipo da questão (Numérica) não muda durante a aplicação.');
        assert.equal(stored.versionSnapshots[0].questions[3].type, 'numeric');
        // O pedido passa pelo schema da questão (antes não tinha nenhum).
        const badType = await request(app)
            .post('/api/admin/correct-live-question')
            .set('x-admin-session', adminToken)
            .send({ applicationId: app1.id, questionNumber: 4, question: { type: 7, text: 'x' } })
            .expect(400);
        assert.equal(badType.body.field, 'question.type');
        const badQuestion = await request(app)
            .post('/api/admin/correct-live-question')
            .set('x-admin-session', adminToken)
            .send({ applicationId: app1.id, questionNumber: 4, question: 'texto' })
            .expect(400);
        assert.equal(badQuestion.body.field, 'question');
        const longText = await request(app)
            .post('/api/admin/correct-live-question')
            .set('x-admin-session', adminToken)
            .send({ applicationId: app1.id, questionNumber: 4, question: { text: 'x'.repeat(20001) } })
            .expect(400);
        assert.equal(longText.body.field, 'question.text');
        // O mesmo tipo, mandado de novo, passa.
        await request(app)
            .post('/api/admin/correct-live-question')
            .set('x-admin-session', adminToken)
            .send({ applicationId: app1.id, questionNumber: 4, question: { type: 'numeric', text: 'Latência média em ms?', alternatives: [] } })
            .expect(200);
        assert.deepEqual({ score: submission.score, pointsEarned: submission.pointsEarned, pointsPossible: submission.pointsPossible }, before);
    } finally {
        await putEvaluation(QUESTIONS).expect(200);
    }
});

test('[UC-PROVA-004] estatística da prova escreve cada resposta por describeAnswer e não conta a dissertativa pendente como erro (contrato C3)', async () => {
    const app1 = await application();
    const analytics = await request(app)
        .get(`/api/admin/exam-analytics/${encodeURIComponent(studentClass)}/${examKey}`)
        .query({ applicationId: app1.id })
        .set('x-admin-session', adminToken)
        .expect(200);
    const byNumber = Object.fromEntries(analytics.body.questions.map(question => [question.questionNumber, question]));
    assert.deepEqual(byNumber[2].choices, { A: 1 });
    assert.deepEqual(byNumber[4].choices, { '3,6 ms': 1 });
    assert.deepEqual(byNumber[5].choices, { mascara: 1 });
    assert.deepEqual(byNumber[6].choices, { 'Resposta escrita': 1 });
    assert.deepEqual([byNumber[6].correct, byNumber[6].wrong, byNumber[6].pending], [0, 0, 1]);
});

test('[UC-PROVA-004] levar a avaliação para o banco deixa de fora os tipos que o banco ainda não guarda', async () => {
    await application();
    const before = (db.memory.questionBank || []).length;
    const imported = await request(app)
        .post('/api/admin/question-bank/import-evaluation')
        .set('x-admin-session', adminToken)
        .send({ examKey, category: 'Redes' })
        .expect(200);
    assert.equal(imported.body.importedCount, 2);
    assert.deepEqual(imported.body.questions.map(question => question.originalNumber), [1, 3]);
    assert.deepEqual(imported.body.skipped, [
        { questionNumber: 2, type: 'multiple_answer' },
        { questionNumber: 4, type: 'numeric' },
        { questionNumber: 5, type: 'short_answer' },
        { questionNumber: 6, type: 'essay' },
    ]);
    assert.equal(imported.body.message, '4 questões ficaram de fora: o banco de questões ainda guarda só questões de uma correta e de verdadeiro ou falso.');
    const added = db.memory.questionBank.slice(before);
    assert.equal(added.length, 2);
    added.forEach(item => {
        assert.equal(item.type, 'multiple_choice');
        assert.equal(item.alternatives.filter(alternative => alternative.isCorrect).length, 1);
    });
});
