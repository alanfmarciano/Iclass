// Corrigir o gabarito depois do encerramento (fase 3, P3-S6: AVA-X2; D14 do desenho P3).
// POST /api/admin/exam-applications/:id/answer-key-correction muda só o gabarito da
// questão nas versões da aplicação, recorrige as entregas (scoreHistory com o motivo e
// grade_regrade), registra exam_answer_key_corrected e avisa no sino quem tinha a nota
// publicada e teve a nota mudada; dryRun mostra o impacto sem gravar. Antes desta rota,
// depois de encerrar só dava para anular a questão (correct-live-question dava 409).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-answer-key-correction-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { createAdminSession, createStudentSession } = require('../../backend/utils/authSessions.js');
const { createSubmissionFromAttempt } = require('../../backend/utils/examGrading.js');
const { normalizeAnswerKey } = require('../../backend/utils/questionModel.js');
const {
    answerKeyOf,
    applyAnswerKey,
    describeAnswerKey,
    previewAnswerKeyRegrade,
    sameAnswerKey,
} = require('../../backend/utils/examAnswerKeyCorrection.js');

const ADMIN = 'adm@gabarito.local';
const PROF = 'prof@gabarito.local';
const OTHER_PROF = 'outro@gabarito.local';
const MONITOR = 'aux@gabarito.local';
const COURSE = 'curso-gabarito';
const CLASS = '1RED';
const EXAM = 'Avaliacao_Redes_1';
const APP = 'app_gabarito_final';
let app;

const STUDENTS = {
    ana: { email: 'ana@gabarito.local', name: 'Ana Lima', version: 'A' },
    bruno: { email: 'bruno@gabarito.local', name: 'Bruno Costa', version: 'B' },
    carla: { email: 'carla@gabarito.local', name: 'Carla Dias', version: 'A' },
    dani: { email: 'dani@gabarito.local', name: 'Dani Rocha', version: 'B' },
};

// Quatro questões de uma correta e uma de cada tipo com gabarito automático. A questão 4
// foi cadastrada com a letra C, mas a certa era a B (o aluno reclamou depois da prova).
function evaluationQuestions() {
    const choice = (number, correct, texts) => ({
        originalNumber: number,
        number,
        type: 'multiple_choice',
        points: 1,
        text: `Questão ${number} de redes`,
        correctAnswer: correct,
        alternatives: texts.map((text, index) => ({ letter: 'ABCD'[index], text, isCorrect: 'ABCD'[index] === correct })),
    });
    return [
        choice(1, 'A', ['TCP', 'UDP', 'ICMP', 'ARP']),
        choice(2, 'B', ['Hub', 'Switch', 'Cabo', 'Antena']),
        choice(3, 'D', ['80', '21', '25', '443']),
        choice(4, 'C', ['255.0.0.0', '255.255.255.0', '255.255.0.0', '0.0.0.0']),
        {
            originalNumber: 5, number: 5, type: 'numeric', points: 1, text: 'Latência em ms?',
            alternatives: [], correctAnswer: '', numeric: { value: 3.5, tolerance: 0, unit: 'ms' }, review: 'auto',
        },
        {
            originalNumber: 6, number: 6, type: 'short_answer', points: 1, text: 'Nome do 255.255.255.0?',
            alternatives: [], correctAnswer: '', acceptedAnswers: ['máscara'], review: 'auto',
        },
        { originalNumber: 7, number: 7, type: 'essay', points: 1, text: 'Explique o handshake.', alternatives: [], correctAnswer: '' },
    ];
}

// Versão A na ordem; versão B com as questões invertidas e as alternativas de escolha ao
// contrário (a letra original fica em letter; a impressa, em displayLetter).
function versionSnapshots() {
    const questions = evaluationQuestions();
    const withDisplay = (question, reverse) => {
        const alternatives = reverse ? [...question.alternatives].reverse() : question.alternatives;
        return { ...question, alternatives: alternatives.map((alternative, index) => ({ ...alternative, displayLetter: 'ABCD'[index] })) };
    };
    const printedKey = list => Object.fromEntries(list.map((question, index) => {
        const correct = question.alternatives.find(alternative => alternative.isCorrect);
        return [index + 1, correct ? correct.displayLetter : ''];
    }).filter(([, letter]) => letter));
    const a = questions.map((question, index) => ({ ...withDisplay(question, false), examNumber: index + 1 }));
    const b = [...questions].reverse().map((question, index) => ({ ...withDisplay(question, true), examNumber: index + 1 }));
    return [
        { version: 'A', examCode: 'A1', questions: a, answerKey: printedKey(a) },
        { version: 'B', examCode: 'B1', questions: b, answerKey: printedKey(b) },
    ];
}

function submissionFor(application, key, answers, { published }) {
    const student = STUDENTS[key];
    const submission = createSubmissionFromAttempt({
        application,
        onlineConfig: null,
        state: {
            studentEmail: student.email,
            studentClass: CLASS,
            courseId: COURSE,
            attemptId: `attempt_${key}`,
            assignedVersion: student.version,
            assignedQuestionNumbers: student.version === 'A' ? [1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1],
            answers,
        },
        evaluation: db.memory.evaluations[EXAM],
        student: { name: student.name, email: student.email },
        now: Date.now() - 3600000,
    });
    submission.id = `sub_${key}`;
    submission.gradePublished = published;
    if (published) submission.gradePublishedAt = Date.now() - 1800000;
    return submission;
}

function seed() {
    db.memory.config = { ...(db.memory.config || {}), settings: {} };
    db.memory.admins = [
        { email: ADMIN, name: 'Administração', role: 'admin', password: 'x' },
        { email: PROF, name: 'Professora Paula', role: 'professor', password: 'x', assignedClasses: [{ courseId: COURSE, className: CLASS }] },
        { email: OTHER_PROF, name: 'Outro Professor', role: 'professor', password: 'x', assignedClasses: [{ courseId: COURSE, className: '2RED' }] },
        { email: MONITOR, name: 'Auxiliar', role: 'monitor', password: 'x', assignedClasses: [{ courseId: COURSE, className: CLASS }] },
    ];
    db.memory.courses = [{ id: COURSE, name: 'Redes', structure: [{ id: 'm1', name: 'Módulo 1', units: [{ key: 'u1', name: 'Prova de redes', avaliacaoKey: EXAM }] }] }];
    db.memory.classes = [
        // A configuração da turma já é de outra aplicação (uma segunda chamada preparada
        // depois): corrigir a aplicação encerrada não pode trocá-la.
        { name: CLASS, courseId: COURSE, status: 'active', releasedItems: {}, examHistory: {}, onlineExamConfigs: { [EXAM]: { applicationId: 'app_segunda_chamada', status: 'prepared', annulledQuestions: [] } } },
        { name: '2RED', courseId: COURSE, status: 'active', releasedItems: {}, examHistory: {}, onlineExamConfigs: {} },
    ];
    db.memory.students = Object.values(STUDENTS).map(student => ({
        name: student.name, email: student.email, status: 'Ativo', classes: [{ name: CLASS, courseId: COURSE }], studentClass: CLASS, notificationsSeenAt: 0,
    }));
    db.memory.evaluations = { [EXAM]: { key: EXAM, title: 'Prova de redes', questions: evaluationQuestions() } };
    const application = {
        id: APP,
        examKey: EXAM,
        courseId: COURSE,
        studentClass: CLASS,
        historyId: 'hist_1',
        status: 'finished',
        finishedAt: new Date(Date.now() - 3000000).toISOString(),
        createdAt: new Date(Date.now() - 7200000).toISOString(),
        timerMode: 'collective',
        maxAttempts: 1,
        questionCount: 7,
        versionSnapshots: versionSnapshots(),
        annulledQuestions: [],
        questionReports: [
            { id: 'rep_1', questionNumber: 4, status: 'open', studentEmail: STUDENTS.ana.email, text: 'A certa é a máscara /24.' },
        ],
    };
    db.memory.examApplications = [application];
    const right = { 1: 'A', 2: 'B', 3: 'D', 5: { numero: '3,5' }, 6: { texto: 'máscara' } };
    db.memory.submissions = [
        // Ana marcou B na 4 (a certa de verdade): nota publicada, ganha.
        submissionFor(application, 'ana', { ...right, 4: 'B' }, { published: true }),
        // Bruno marcou C (o gabarito errado): nota publicada, perde.
        submissionFor(application, 'bruno', { ...right, 4: 'C' }, { published: true }),
        // Carla marcou A: errada antes e depois, a nota não muda.
        submissionFor(application, 'carla', { ...right, 4: 'A' }, { published: true }),
        // Dani marcou B, mas a nota ainda não foi publicada: ganha e não é avisada.
        submissionFor(application, 'dani', { ...right, 4: 'B', 5: { numero: '3,6' } }, { published: false }),
    ];
    db.memory.auditLogs = [];
    db.memory.announcements = [];
    db.memory.forum = [];
    db.memory.studentExamState = {};
    db.memory.broadcastMessages = [];
}

test.before(async () => { await db.init(); app = createApp(); });
test.beforeEach(() => seed());
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

const adminHeaders = (email = ADMIN) => ({ 'x-admin-session': createAdminSession(db.memory, email) });
const studentHeaders = key => ({ 'x-session-token': createStudentSession(db.memory, STUDENTS[key].email) });
const submission = key => db.memory.submissions.find(item => item.id === `sub_${key}`);
const application = () => db.memory.examApplications.find(item => item.id === APP);
const correct = (payload, email = ADMIN, applicationId = APP) => request(app)
    .post(`/api/admin/exam-applications/${applicationId}/answer-key-correction`)
    .set(adminHeaders(email))
    .send(payload);
const FIX_Q4 = { questionNumber: 4, correctAnswer: 'B', motivo: 'A máscara /24 é 255.255.255.0; o gabarito estava com a C.' };

test('[UC-PROVA-005] prévia: diz quem muda de nota e quantas já publicadas, sem gravar nada', async () => {
    const before = JSON.stringify({ submissions: db.memory.submissions, applications: db.memory.examApplications, classes: db.memory.classes });
    const response = await correct({ ...FIX_Q4, dryRun: true });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.dryRun, true);
    assert.equal(response.body.regraded, 4);
    assert.equal(response.body.changed, 3);
    assert.equal(response.body.published, 2);
    assert.deepEqual(response.body.question, { number: 4, type: 'multiple_choice', antes: 'C · 255.255.0.0', depois: 'B · 255.255.255.0' });
    assert.deepEqual(response.body.students.map(student => [student.name, student.from, student.to, student.published]), [
        // Sete questões de 1 ponto (a dissertativa em branco vale zero): 5/7 = 71, 6/7 = 86.
        ['Ana Lima', 71, 86, true],
        ['Bruno Costa', 86, 71, true],
        ['Dani Rocha', 57, 71, false],
    ]);
    assert.equal(JSON.stringify({ submissions: db.memory.submissions, applications: db.memory.examApplications, classes: db.memory.classes }), before, 'a prévia não muda nada');
    assert.equal(db.memory.auditLogs.length, 0);
});

test('[UC-PROVA-005] depois de encerrar, a letra C vira B: quem marcou B ganha, quem marcou C perde, com histórico, auditoria e aviso', async () => {
    const scores = Object.fromEntries(Object.keys(STUDENTS).map(key => [key, submission(key).score]));
    assert.equal(scores.ana, 71);
    assert.equal(scores.bruno, 86);
    const response = await correct(FIX_Q4, PROF);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.regraded, 4);
    assert.equal(response.body.changed, 3);
    assert.equal(response.body.notifiedStudents, 2);

    assert.equal(submission('ana').score, 86);
    assert.equal(submission('bruno').score, 71);
    assert.equal(submission('carla').score, scores.carla, 'quem errou antes e depois fica igual');
    assert.equal(submission('dani').score, 71);
    // O status da aplicação e a nota publicada não mudam por causa da correção.
    assert.equal(application().status, 'finished');
    assert.equal(submission('bruno').gradePublished, true);

    // Nota anterior no scoreHistory com o motivo; o aviso fica marcado só na publicada.
    const last = key => submission(key).scoreHistory.at(-1);
    assert.equal(last('ana').from, 71);
    assert.equal(last('ana').to, 86);
    assert.match(last('ana').reason, /^gabarito da questão 4 corrigido \(C · 255\.255\.0\.0 → B · 255\.255\.255\.0\) · motivo: A máscara \/24/);
    assert.equal(last('ana').by, PROF);
    assert.deepEqual(last('ana').avisoAluno, { tipo: 'gabarito_corrigido', numeroNaProva: 4 });
    assert.deepEqual(last('bruno').avisoAluno, { tipo: 'gabarito_corrigido', numeroNaProva: 4 }, 'na versão B a questão 4 também é a quarta');
    assert.equal(last('dani').avisoAluno, undefined, 'nota não publicada: sem aviso (o "Nota publicada" de sempre avisa depois)');
    assert.equal(submission('carla').scoreHistory, undefined);

    // Gabarito trocado nas duas versões pela letra original; o texto e a ordem ficam.
    const [versionA, versionB] = application().versionSnapshots;
    const q4 = snapshot => snapshot.questions.find(question => question.originalNumber === 4);
    assert.equal(q4(versionA).correctAnswer, 'B');
    assert.deepEqual(q4(versionA).alternatives.map(alternative => [alternative.letter, alternative.displayLetter, alternative.isCorrect]), [
        ['A', 'A', false], ['B', 'B', true], ['C', 'C', false], ['D', 'D', false],
    ]);
    assert.deepEqual(q4(versionB).alternatives.map(alternative => [alternative.letter, alternative.displayLetter, alternative.isCorrect]), [
        ['D', 'A', false], ['C', 'B', false], ['B', 'C', true], ['A', 'D', false],
    ]);
    assert.equal(q4(versionA).text, 'Questão 4 de redes');
    assert.equal(versionA.answerKey[4], 'B');
    assert.equal(versionB.answerKey[4], 'C', 'o gabarito impresso da versão B segue a letra da posição');
    // A avaliação no editor não muda, nem a configuração da turma de outra aplicação.
    assert.equal(db.memory.evaluations[EXAM].questions[3].correctAnswer, 'C');
    assert.equal(db.memory.classes[0].onlineExamConfigs[EXAM].applicationId, 'app_segunda_chamada');
    assert.equal(db.memory.classes[0].onlineExamConfigs[EXAM].versionSnapshots, undefined);
    // A contestação da questão 4 fica revisada como corrigida.
    assert.equal(application().questionReports[0].status, 'reviewed');
    assert.equal(application().questionReports[0].resolutionAction, 'corrected');

    // Registro na aplicação e na auditoria.
    assert.deepEqual(application().answerKeyCorrections.map(item => [item.questionNumber, item.antes, item.depois, item.changed, item.notifiedStudents, item.por]), [
        [4, 'C · 255.255.0.0', 'B · 255.255.255.0', 3, 2, PROF],
    ]);
    const corrected = db.memory.auditLogs.filter(entry => entry.type === 'exam_answer_key_corrected');
    assert.equal(corrected.length, 1);
    assert.equal(corrected[0].applicationId, APP);
    assert.deepEqual(
        { ...corrected[0].details },
        { questionNumber: 4, tipo: 'multiple_choice', antes: 'C · 255.255.0.0', depois: 'B · 255.255.255.0', motivo: FIX_Q4.motivo, regraded: 4, changed: 3, notifiedStudents: 2 },
    );
    const regrades = db.memory.auditLogs.filter(entry => entry.action === 'grade_regrade');
    assert.deepEqual(regrades.map(entry => entry.studentEmail).sort(), [STUDENTS.ana.email, STUDENTS.bruno.email, STUDENTS.dani.email]);

    // O registro da aplicação (Resultados) descreve a correção.
    const trail = await request(app).get(`/api/admin/exam-applications/${APP}/audit`).set(adminHeaders());
    assert.equal(trail.status, 200);
    const row = trail.body.entries.find(entry => entry.id === corrected[0].id);
    assert.equal(row.title, 'Gabarito da questão 4 corrigido: C · 255.255.0.0 → B · 255.255.255.0');
    assert.equal(row.detail, `3 notas mudaram · 2 alunos avisados · motivo: ${FIX_Q4.motivo}`);
});

test('[UC-PROVA-005] aluno com nota publicada recebe "Nota alterada" no sino, com a questão da versão dele e sem o gabarito', async () => {
    // Na versão B a ordem das questões é outra: a numérica (5) é a terceira.
    const numeric = await correct({ questionNumber: 5, numeric: { value: '3,6' }, motivo: 'O valor certo da latência é 3,6 ms.' });
    assert.equal(numeric.status, 200, JSON.stringify(numeric.body));
    assert.equal(numeric.body.question.antes, '3,5 ms');
    assert.equal(numeric.body.question.depois, '3,6 ms');
    await correct(FIX_Q4).expect(200);

    const bell = async key => (await request(app).get(`/api/student/notifications?courseId=${COURSE}&studentClass=${CLASS}`).set(studentHeaders(key)).expect(200)).body;
    const ana = await bell('ana');
    const anaNotices = ana.items.filter(item => item.title === 'Nota alterada');
    assert.deepEqual(anaNotices.map(item => item.text), [
        'Prova de redes: O gabarito da questão 4 foi corrigido e a sua nota mudou.',
        'Prova de redes: O gabarito da questão 5 foi corrigido e a sua nota mudou.',
    ]);
    assert.ok(anaNotices.every(item => item.unread === true && item.type === 'nota' && item.href === '/aluno/provas'));
    const bruno = await bell('bruno');
    assert.deepEqual(bruno.items.filter(item => item.title === 'Nota alterada').map(item => item.text), [
        'Prova de redes: O gabarito da questão 4 foi corrigido e a sua nota mudou.',
        'Prova de redes: O gabarito da questão 3 foi corrigido e a sua nota mudou.',
    ]);
    const serialized = JSON.stringify([ana, bruno].map(body => body.items.filter(item => item.title === 'Nota alterada')));
    for (const leak of ['motivo', 'máscara /24', '255.255', '3,6 ms', 'tolerância']) assert.equal(serialized.includes(leak), false, `${leak} não vai ao aluno`);
    // Carla (errou a 4 antes e depois) só é avisada da numérica; Dani (nota não
    // publicada) não recebe aviso.
    assert.deepEqual((await bell('carla')).items.filter(item => item.title === 'Nota alterada').map(item => item.text), [
        'Prova de redes: O gabarito da questão 5 foi corrigido e a sua nota mudou.',
    ]);
    assert.equal((await bell('dani')).items.some(item => item.title === 'Nota alterada'), false);
    // "Marcar como lidas" vale para o aviso como para os outros itens.
    await request(app).post(`/api/student/notifications/seen?courseId=${COURSE}&studentClass=${CLASS}`).set(studentHeaders('ana')).send({ ids: [] }).expect(200);
    assert.equal((await bell('ana')).items.filter(item => item.title === 'Nota alterada').some(item => item.unread), false);
    // O scoreHistory continua fora das rotas do aluno.
    const mine = await request(app).get(`/api/student/my-submissions?courseId=${COURSE}&studentClass=${CLASS}`).set(studentHeaders('ana'));
    assert.equal(JSON.stringify(mine.body).includes('avisoAluno'), false);
});

test('[UC-PROVA-005] repetir a mesma correção não muda nada; recusas de motivo, status, tipo, letra e escopo', async () => {
    await correct(FIX_Q4).expect(200);
    const snapshot = JSON.stringify({ submissions: db.memory.submissions, applications: db.memory.examApplications, audit: db.memory.auditLogs });
    const again = await correct(FIX_Q4);
    assert.equal(again.status, 200);
    assert.equal(again.body.unchanged, true);
    assert.equal(again.body.changed, 0);
    assert.equal(again.body.message, 'O gabarito da questão 4 já é este: nenhuma nota muda.');
    assert.equal(JSON.stringify({ submissions: db.memory.submissions, applications: db.memory.examApplications, audit: db.memory.auditLogs }), snapshot);

    const empty = await correct({ ...FIX_Q4, correctAnswer: 'A', motivo: '' });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, 'Escreva o motivo da correção (pelo menos 5 caracteres).');
    assert.equal((await correct({ ...FIX_Q4, correctAnswer: 'A', motivo: 'erro' })).status, 400);
    assert.equal((await correct({ ...FIX_Q4, correctAnswer: 'A' , motivo: 'x'.repeat(501) })).body.field, 'motivo');
    assert.equal((await correct({ ...FIX_Q4, correctAnswer: 'Z' })).body.error, 'A resposta certa precisa ser uma das alternativas da questão.');
    assert.equal((await correct({ ...FIX_Q4, correctAnswer: '' })).body.error, 'Escolha a alternativa certa.');
    assert.equal((await correct({ ...FIX_Q4, correctAnswer: ['B'] })).body.field, 'correctAnswer');
    const essay = await correct({ questionNumber: 7, motivo: 'Dissertativa não tem gabarito' });
    assert.equal(essay.status, 400);
    assert.equal(essay.body.error, 'A dissertativa não tem resposta certa automática: a nota dela é dada pelo professor.');
    assert.equal((await correct({ ...FIX_Q4, questionNumber: 99 })).status, 404);
    assert.equal((await correct(FIX_Q4, ADMIN, 'app_nao_existe')).status, 404);

    // Escopo e papel: professor de outra turma e professor auxiliar não corrigem.
    assert.equal((await correct({ ...FIX_Q4, correctAnswer: 'A' }, OTHER_PROF)).status, 403);
    assert.equal((await correct({ ...FIX_Q4, correctAnswer: 'A' }, MONITOR)).status, 403);

    // Aplicação cancelada: 409; ainda não começou: 409 (corrige-se no editor).
    application().status = 'cancelled';
    const cancelled = await correct({ ...FIX_Q4, correctAnswer: 'A' });
    assert.equal(cancelled.status, 409);
    assert.equal(cancelled.body.code, 'application_cancelled');
    application().status = 'prepared';
    assert.equal((await correct({ ...FIX_Q4, correctAnswer: 'A' })).body.code, 'application_not_started');
    // Em andamento também vale (o aluno que ainda vai entregar é corrigido pelo gabarito novo).
    application().status = 'running';
    assert.equal((await correct({ ...FIX_Q4, correctAnswer: 'C', motivo: 'Voltando ao gabarito de antes.' })).status, 200);
    assert.equal(submission('bruno').score, 86);
});

test('[UC-PROVA-005] questão anulada só é corrigida tirando a anulação; questão trocada no Monitor não', async () => {
    await request(app).post('/api/admin/annul-question').set(adminHeaders())
        .send({ applicationId: APP, questionNumber: 4, mode: 'ponto_para_todos', reason: 'gabarito duvidoso' }).expect(200);
    assert.equal(submission('ana').score, 86);
    assert.equal(submission('bruno').score, 86);
    const refused = await correct(FIX_Q4);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'question_annulled');
    assert.match(refused.body.error, /^A questão 4 está anulada nesta aplicação \(ponto para todos\)/);

    const preview = await correct({ ...FIX_Q4, tirarAnulacao: true, dryRun: true }).expect(200);
    assert.equal(preview.body.tirarAnulacao, true);
    assert.deepEqual(preview.body.students.map(student => student.name), ['Bruno Costa', 'Carla Dias']);
    assert.equal(application().annulledQuestions.length, 1, 'a prévia não tira a anulação');

    const fixed = await correct({ ...FIX_Q4, tirarAnulacao: true }).expect(200);
    assert.equal(fixed.body.changed, 2);
    assert.deepEqual(application().annulledQuestions, []);
    assert.equal(submission('ana').score, 86);
    assert.equal(submission('bruno').score, 71);
    assert.equal(application().answerKeyCorrections[0].tirouAnulacao, 'ponto_para_todos');
    assert.match(submission('bruno').scoreHistory.at(-1).reason, /e anulação retirada · motivo:/);

    // Questão que saiu pela troca do Monitor: a nota dela vem da que entrou no lugar.
    application().versionSnapshots.forEach(snapshot => snapshot.questions.push({
        ...snapshot.questions.find(question => question.originalNumber === 1), originalNumber: 8, isAdditional: true, replacedQuestionNumber: 2,
    }));
    const replaced = await correct({ questionNumber: 2, correctAnswer: 'A', motivo: 'Questão trocada antes.' });
    assert.equal(replaced.status, 409);
    assert.equal(replaced.body.code, 'question_replaced');
});

test('[UC-PROVA-005] várias corretas, verdadeiro ou falso, numérica e resposta curta pelo gabarito do tipo', () => {
    const multiple = { type: 'multiple_answer', alternatives: [{ letter: 'A', text: 'TCP', isCorrect: true }, { letter: 'B', text: 'HTTP' }, { letter: 'C', text: 'UDP' }] };
    assert.deepEqual(normalizeAnswerKey(multiple, { correctAnswers: ['c', 'A', 'C'] }), { type: 'multiple_answer', correctAnswers: ['A', 'C'] });
    assert.throws(() => normalizeAnswerKey(multiple, { correctAnswers: [] }), /Marque pelo menos uma alternativa certa/);
    assert.throws(() => normalizeAnswerKey(multiple, { correctAnswers: ['D'] }), /letras das alternativas/);
    const trueFalse = { type: 'true_false', alternatives: [{ letter: 'A', text: 'Verdadeiro', isCorrect: true }, { letter: 'B', text: 'Falso' }], correctAnswer: 'A' };
    assert.deepEqual(normalizeAnswerKey(trueFalse, { correctAnswer: 'F' }), { type: 'true_false', correctAnswer: 'B' });
    assert.equal(describeAnswerKey({ type: 'true_false', correctAnswer: 'B' }, trueFalse), 'Falso');
    const numeric = { type: 'numeric', numeric: { value: 3.5, tolerance: 0.25, unit: 'ms' } };
    assert.deepEqual(normalizeAnswerKey(numeric, { numeric: { value: '4,2' } }), { type: 'numeric', numeric: { value: 4.2, tolerance: 0.25, unit: 'ms' } });
    assert.deepEqual(normalizeAnswerKey(numeric, { numeric: { value: 4, tolerance: '0' } }).numeric, { value: 4, tolerance: 0, unit: 'ms' });
    assert.throws(() => normalizeAnswerKey(numeric, { numeric: { value: 'quatro' } }), /Informe o valor da resposta numérica/);
    assert.equal(describeAnswerKey(answerKeyOf(numeric), numeric), '3,5 ms (tolerância 0,25)');
    const short = { type: 'short_answer', acceptedAnswers: ['máscara'] };
    assert.deepEqual(normalizeAnswerKey(short, { acceptedAnswers: ['Máscara de rede', ' máscara de rede ', 'máscara'] }), { type: 'short_answer', acceptedAnswers: ['Máscara de rede', 'máscara'] });
    assert.throws(() => normalizeAnswerKey(short, { acceptedAnswers: [] }), /Informe pelo menos uma resposta aceita/);
    assert.equal(sameAnswerKey(answerKeyOf(numeric), { type: 'numeric', numeric: { value: 3.5, tolerance: 0.25, unit: 'ms' } }), true);

    // Várias corretas aplicadas nas versões: as marcas seguem a letra original e o
    // gabarito impresso junta as letras da posição.
    const draft = {
        id: 'app_x',
        versionSnapshots: [{ version: 'B', answerKey: { 1: 'A' }, questions: [{ originalNumber: 1, examNumber: 1, ...multiple, alternatives: [
            { letter: 'C', text: 'UDP', displayLetter: 'A' }, { letter: 'A', text: 'TCP', displayLetter: 'B', isCorrect: true }, { letter: 'B', text: 'HTTP', displayLetter: 'C' },
        ] }] }],
    };
    assert.equal(applyAnswerKey(draft, 1, { type: 'multiple_answer', correctAnswers: ['A', 'C'] }), 1);
    assert.deepEqual(draft.versionSnapshots[0].questions[0].alternatives.map(alternative => alternative.isCorrect), [true, true, false]);
    assert.deepEqual(draft.versionSnapshots[0].questions[0].correctAnswers, ['A', 'C']);
    assert.equal(draft.versionSnapshots[0].answerKey[1], 'AB');
});

test('[UC-PROVA-005] resposta curta corrigida pela rota recorrige quem escreveu a resposta nova; prévia é pura', async () => {
    // Ninguém escreveu "máscara de rede": a nota de quem escreveu "máscara" cai se ela sai.
    const preview = previewAnswerKeyRegrade({
        application: application(),
        submissions: db.memory.submissions,
        evaluation: db.memory.evaluations[EXAM],
        number: 6,
        key: { type: 'short_answer', acceptedAnswers: ['máscara de rede'] },
    });
    assert.equal(preview.regraded, 4);
    assert.equal(preview.changes.length, 4);
    const response = await correct({ questionNumber: 6, acceptedAnswers: ['máscara de rede', 'máscara'], motivo: 'Aceitar também máscara de rede.' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.changed, 0, 'quem escreveu "máscara" continua certo');
    assert.equal(response.body.question.depois, '"máscara de rede" ou "máscara"');
    assert.deepEqual(application().versionSnapshots[1].questions.find(question => question.originalNumber === 6).acceptedAnswers, ['máscara de rede', 'máscara']);
});

test('[UC-PROVA-005] aplicação antiga sem anulações próprias não herda as da configuração de outra aplicação', async () => {
    // Aplicação de antes das anulações por aplicação: sem o campo. A configuração da turma
    // é de outra aplicação e anula a questão 1.
    delete application().annulledQuestions;
    db.memory.classes[0].onlineExamConfigs[EXAM].annulledQuestions = [{ questionNumber: 1, mode: 'remover_do_total', reason: 'da outra aplicação' }];
    await correct(FIX_Q4).expect(200);
    const first = submission('ana').gradedAnswers.find(answer => answer.questionNumber === 1);
    assert.equal(first.annulled, false);
    assert.equal(submission('ana').totalCount, 7);
    assert.equal(submission('ana').score, 86);
});
