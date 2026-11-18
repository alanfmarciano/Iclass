// Corretor por tipo de questão no servidor (fase 3, P3-S1: AVA-06, FUN-10). Antes cada
// questão valia 1 e só existia "uma correta": a nota era acertos / total. Agora cada tipo
// tem o seu corretor (utils/examScoring.js), a nota é pontos obtidos / possíveis e as
// questões antigas (sem type nem points) dão exatamente a nota de antes: o corretor
// antigo está congelado aqui e é comparado com o novo no banco de referência 281029f, no
// seed do TEST_MODE e em milhares de provas sorteadas.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const {
    describeAnswer,
    gradedAnswerFor,
    isAnswered,
    normalizeShortAnswer,
    parseNumericAnswer,
    questionPoints,
    questionType,
    scoreQuestion,
} = require('../../backend/utils/examScoring.js');
const { gradeAttempt, regradeSubmission, createSubmissionFromAttempt } = require('../../backend/utils/examGrading.js');
const { countAnswers } = require('../../backend/utils/examDeadline.js');

// ------------------------------------------------------------------ corretor antigo
// Cópia congelada de backend/utils/examGrading.js na base da fase 3 (8490eb4), antes do
// corretor por tipo. Não mude: é a referência de compatibilidade (D1 do P3).
const frozen = (() => {
    function questionNumber(question, index = 0) {
        return Number(question?.originalNumber || question?.number || index + 1);
    }
    function correctAnswerFor(question) {
        if (question?.correctAnswer) return String(question.correctAnswer).toUpperCase();
        const alternative = (question?.alternatives || []).find(item => item?.isCorrect === true);
        return alternative?.letter ? String(alternative.letter).toUpperCase() : '';
    }
    function snapshotForAttempt(application, onlineConfig, assignedVersion = 'A') {
        const snapshots = Array.isArray(application?.versionSnapshots) && application.versionSnapshots.length
            ? application.versionSnapshots
            : (Array.isArray(onlineConfig?.versionSnapshots) ? onlineConfig.versionSnapshots : []);
        const version = String(assignedVersion || 'A').toUpperCase();
        return snapshots.find(snapshot => String(snapshot?.version || 'A').toUpperCase() === version)
            || snapshots[0]
            || null;
    }
    function questionsForAttempt({ application, onlineConfig, state, evaluation } = {}) {
        const assignedVersion = state?.assignedVersion || 'A';
        const snapshot = snapshotForAttempt(application, onlineConfig, assignedVersion);
        const snapshotQuestions = Array.isArray(snapshot?.questions) ? snapshot.questions : [];
        const evaluationQuestions = Array.isArray(evaluation?.questions) ? evaluation.questions : [];
        const evaluationByNumber = new Map(evaluationQuestions.map((question, index) => [questionNumber(question, index), question]));
        const sourceQuestions = snapshotQuestions.length ? snapshotQuestions : evaluationQuestions;
        const sourceByNumber = new Map(sourceQuestions.map((question, index) => {
            const number = questionNumber(question, index);
            const fallback = evaluationByNumber.get(number);
            const correctAnswer = correctAnswerFor(question) || correctAnswerFor(fallback);
            return [number, { ...(fallback || {}), ...question, originalNumber: number, correctAnswer }];
        }));
        let assignedNumbers = Array.isArray(state?.assignedQuestionNumbers)
            ? state.assignedQuestionNumbers.map(Number).filter(Number.isFinite)
            : [...sourceByNumber.keys()];
        assignedNumbers = [...new Set(assignedNumbers)];
        return { assignedVersion, snapshot, assignedNumbers, questions: assignedNumbers.map(number => sourceByNumber.get(number)).filter(Boolean) };
    }
    function annulmentMap(application, onlineConfig) {
        const entries = Array.isArray(application?.annulledQuestions)
            ? application.annulledQuestions
            : (Array.isArray(onlineConfig?.annulledQuestions) ? onlineConfig.annulledQuestions : []);
        return new Map(entries.map(entry => [Number(entry.questionNumber), entry]));
    }
    function gradeAttemptOld({ application, onlineConfig, state, evaluation, answers = {} } = {}) {
        const resolved = questionsForAttempt({ application, onlineConfig, state, evaluation });
        const annulled = annulmentMap(application, onlineConfig);
        let correctCount = 0;
        let totalCount = 0;
        const gradedAnswers = resolved.questions.map(question => {
            const number = Number(question.originalNumber);
            const correctAnswer = correctAnswerFor(question);
            const studentChoice = answers[number] == null ? null : String(answers[number]).toUpperCase();
            const annulment = annulled.get(number) || null;
            const removed = annulment?.mode === 'remover_do_total';
            const awarded = annulment?.mode === 'ponto_para_todos';
            const isCorrect = awarded || (!removed && !!correctAnswer && studentChoice === correctAnswer);
            if (!removed) {
                totalCount += 1;
                if (isCorrect) correctCount += 1;
            }
            return { questionNumber: number, studentChoice, correctAnswer, isCorrect, annulled: !!annulment, annulmentMode: annulment?.mode || null };
        });
        const score = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 100;
        return { score, correctCount, totalCount, gradedAnswers };
    }
    return { gradeAttemptOld };
})();

// Compara o corretor antigo com o novo numa tentativa: nota, contagens e, por questão,
// letra marcada, gabarito, certo/errado e anulação. Os campos novos só acrescentam.
function assertSameAsFrozen(args, label) {
    const before = frozen.gradeAttemptOld(args);
    const after = gradeAttempt(args);
    assert.equal(after.score, before.score, `${label}: nota`);
    assert.equal(after.correctCount, before.correctCount, `${label}: acertos`);
    assert.equal(after.totalCount, before.totalCount, `${label}: total`);
    assert.equal(after.gradedAnswers.length, before.gradedAnswers.length, `${label}: questões`);
    after.gradedAnswers.forEach((answer, index) => {
        const old = before.gradedAnswers[index];
        assert.equal(answer.questionNumber, old.questionNumber, `${label}: número`);
        // A letra em branco ('' ou null) é a mesma coisa nos dois; o resto é igual.
        assert.equal(answer.studentChoice || null, old.studentChoice || null, `${label}: resposta da questão ${old.questionNumber}`);
        assert.equal(answer.correctAnswer, old.correctAnswer, `${label}: gabarito da questão ${old.questionNumber}`);
        assert.equal(answer.isCorrect, old.isCorrect, `${label}: certo/errado da questão ${old.questionNumber}`);
        assert.equal(answer.annulled, old.annulled);
        assert.equal(answer.annulmentMode, old.annulmentMode);
        assert.equal(answer.type, 'multiple_choice');
    });
    return after;
}

// ------------------------------------------------------------------ tabela por tipo
const MC = { type: 'multiple_choice', points: 2, correctAnswer: 'B', alternatives: [{ letter: 'A', text: 'a' }, { letter: 'B', text: 'b' }, { letter: 'C', text: 'c' }] };
const TF = { type: 'true_false', points: 1, correctAnswer: 'B', alternatives: [{ letter: 'A', text: 'Verdadeiro' }, { letter: 'B', text: 'Falso' }] };
const MA = {
    type: 'multiple_answer',
    points: 3,
    partialCredit: true,
    correctAnswers: ['A', 'C'],
    alternatives: ['A', 'B', 'C', 'D'].map(letter => ({ letter, text: letter, isCorrect: letter === 'A' || letter === 'C' })),
};
const MA_ALL_OR_NOTHING = { ...MA, partialCredit: false };
const NUM = { type: 'numeric', points: 2, numeric: { value: 3.5, tolerance: 0, unit: 'ms' } };
const NUM_TOL = { type: 'numeric', points: 2, numeric: { value: 10, tolerance: 0.5 } };
const SHORT = { type: 'short_answer', points: 1, acceptedAnswers: ['Sub-rede', 'máscara de rede'] };
const ESSAY = { type: 'essay', points: 4, rubric: [{ id: 'c1', nome: 'Clareza', pontos: 2 }, { id: 'c2', nome: 'Conteúdo', pontos: 2 }] };

const TABLE = [
    // [rótulo, questão, resposta, { pointsEarned, isCorrect, pending }]
    ['uma correta: certa', MC, 'B', { pointsEarned: 2, isCorrect: true, pending: false }],
    ['uma correta: errada', MC, 'A', { pointsEarned: 0, isCorrect: false, pending: false }],
    ['uma correta: minúscula vale', MC, 'b', { pointsEarned: 2, isCorrect: true, pending: false }],
    ['uma correta: em branco', MC, null, { pointsEarned: 0, isCorrect: false, pending: false }],
    ['uma correta: formato errado (lista)', MC, ['B'], { pointsEarned: 0, isCorrect: false, pending: false }],
    ['uma correta: formato errado (texto)', MC, { texto: 'B' }, { pointsEarned: 0, isCorrect: false, pending: false }],
    ['V/F: certa', TF, 'B', { pointsEarned: 1, isCorrect: true, pending: false }],
    ['V/F: errada', TF, 'A', { pointsEarned: 0, isCorrect: false, pending: false }],
    ['várias: todas certas', MA, ['C', 'A'], { pointsEarned: 3, isCorrect: true, pending: false }],
    ['várias: metade das certas', MA, ['A'], { pointsEarned: 1.5, isCorrect: false, pending: false }],
    ['várias: uma certa e uma errada', MA, ['A', 'B'], { pointsEarned: 0, isCorrect: false, pending: false }],
    ['várias: tudo marcado dá zero', MA, ['A', 'B', 'C', 'D'], { pointsEarned: 0, isCorrect: false, pending: false }],
    ['várias: só erradas nunca fica negativa', MA, ['B', 'D'], { pointsEarned: 0, isCorrect: false, pending: false }],
    ['várias: as duas certas e uma errada', MA, ['A', 'C', 'D'], { pointsEarned: 1.5, isCorrect: false, pending: false }],
    ['várias: em branco', MA, null, { pointsEarned: 0, isCorrect: false, pending: false }],
    ['várias: formato errado (letra solta)', MA, 'A', { pointsEarned: 0, isCorrect: false, pending: false }],
    ['várias, tudo ou nada: certa', MA_ALL_OR_NOTHING, ['A', 'C'], { pointsEarned: 3, isCorrect: true, pending: false }],
    ['várias, tudo ou nada: parcial vale zero', MA_ALL_OR_NOTHING, ['A'], { pointsEarned: 0, isCorrect: false, pending: false }],
    ['numérica: com vírgula', NUM, { numero: '3,5' }, { pointsEarned: 2, isCorrect: true, pending: false }],
    ['numérica: com ponto', NUM, { numero: '3.5' }, { pointsEarned: 2, isCorrect: true, pending: false }],
    ['numérica: unidade ignorada', NUM, { numero: '3,5 ms' }, { pointsEarned: 2, isCorrect: true, pending: false }],
    ['numérica: tolerância 0 recusa 3,6', NUM, { numero: '3,6' }, { pointsEarned: 0, isCorrect: false, pending: false }],
    ['numérica: tolerância 0,5 aceita 10,5', NUM_TOL, { numero: '10,5' }, { pointsEarned: 2, isCorrect: true, pending: false }],
    ['numérica: tolerância 0,5 aceita 9,5', NUM_TOL, { numero: '9.5' }, { pointsEarned: 2, isCorrect: true, pending: false }],
    ['numérica: tolerância 0,5 recusa 10,51', NUM_TOL, { numero: '10,51' }, { pointsEarned: 0, isCorrect: false, pending: false }],
    ['numérica: texto que não é número', NUM, { numero: 'três e meio' }, { pointsEarned: 0, isCorrect: false, pending: false }],
    ['numérica: em branco', NUM, null, { pointsEarned: 0, isCorrect: false, pending: false }],
    ['numérica: formato errado (letra)', NUM, ['A'], { pointsEarned: 0, isCorrect: false, pending: false }],
    ['curta: sem acento, maiúscula e espaços extras', SHORT, { texto: '  MASCARA   de  rede ' }, { pointsEarned: 1, isCorrect: true, pending: false }],
    ['curta: outra aceita', SHORT, { texto: 'sub-rede' }, { pointsEarned: 1, isCorrect: true, pending: false }],
    ['curta: errada', SHORT, { texto: 'gateway' }, { pointsEarned: 0, isCorrect: false, pending: false }],
    ['curta: letra solta não é resposta', SHORT, 'A', { pointsEarned: 0, isCorrect: false, pending: false }],
    ['curta: em branco', SHORT, { texto: '   ' }, { pointsEarned: 0, isCorrect: false, pending: false }],
    ['dissertativa: escrita aguarda o professor', ESSAY, { texto: 'Minha resposta.' }, { pointsEarned: 0, isCorrect: null, pending: true }],
    ['dissertativa: em branco vale zero sem esperar', ESSAY, null, { pointsEarned: 0, isCorrect: false, pending: false }],
];

test('[UC-PROVA-004] corretor por tipo: certa, errada, em branco e formato errado de cada um dos seis tipos (AVA-06, FUN-10)', () => {
    TABLE.forEach(([label, question, answer, expected]) => {
        const result = scoreQuestion(question, answer);
        assert.equal(result.pointsEarned, expected.pointsEarned, `${label}: pontos`);
        assert.equal(result.pointsPossible, questionPoints(question), `${label}: possíveis`);
        assert.equal(result.isCorrect, expected.isCorrect, `${label}: certo/errado`);
        assert.equal(result.pending, expected.pending, `${label}: aguardando`);
    });
});

test('[UC-PROVA-004] resposta que não bate vai para o professor quando a questão pede revisão; anulação e correção manual valem por cima', () => {
    assert.deepEqual(scoreQuestion({ ...SHORT, review: 'professor' }, { texto: 'mascara' }), { pointsEarned: 0, pointsPossible: 1, isCorrect: null, pending: true });
    assert.deepEqual(scoreQuestion({ ...SHORT, review: 'professor' }, { texto: 'Sub-rede' }), { pointsEarned: 1, pointsPossible: 1, isCorrect: true, pending: false });
    assert.equal(scoreQuestion({ ...NUM, review: 'professor' }, { numero: '4' }).pending, true);
    // Anulação: removida do total sai da conta; ponto para todos dá os pontos da questão.
    assert.deepEqual(scoreQuestion(MA, ['B'], { annulment: { mode: 'remover_do_total' } }), { pointsEarned: 0, pointsPossible: 0, isCorrect: false, pending: false });
    assert.deepEqual(scoreQuestion(ESSAY, { texto: 'x' }, { annulment: { mode: 'ponto_para_todos' } }), { pointsEarned: 4, pointsPossible: 4, isCorrect: true, pending: false });
    // Correção do professor: limitada de 0 aos pontos da questão, nunca aguardando.
    assert.deepEqual(scoreQuestion(ESSAY, { texto: 'x' }, { manual: { pontos: 2.5 } }), { pointsEarned: 2.5, pointsPossible: 4, isCorrect: false, pending: false });
    assert.equal(scoreQuestion(ESSAY, { texto: 'x' }, { manual: { pontos: 9 } }).pointsEarned, 4);
    assert.equal(scoreQuestion(MC, 'A', { manual: { pontos: 1 } }).pointsEarned, 1, 'ajuste de questão objetiva');
});

test('[UC-PROVA-004] tipo e pontos padrão: questão antiga é uma correta de 1 ponto e weight é ignorado (D1)', () => {
    assert.equal(questionType({}), 'multiple_choice');
    assert.equal(questionType({ type: 'inventado' }), 'multiple_choice');
    assert.equal(questionPoints({ weight: 5 }), 1);
    assert.equal(questionPoints({ points: 0 }), 1);
    assert.equal(questionPoints({ points: -2 }), 1);
    assert.equal(questionPoints({ points: '2.5' }), 2.5);
    assert.equal(questionPoints({ points: 150 }), 1);
});

test('[UC-PROVA-004] número digitado e texto da resposta curta', () => {
    assert.equal(parseNumericAnswer('3,5'), 3.5);
    assert.equal(parseNumericAnswer(' -2 '), -2);
    assert.equal(parseNumericAnswer('1.234,5'), 1234.5);
    assert.equal(parseNumericAnswer('1,234.5'), 1234.5);
    assert.equal(parseNumericAnswer('255.255.255.0'), null);
    assert.equal(parseNumericAnswer('10 ms', 'ms'), 10);
    assert.equal(parseNumericAnswer('10 kg', 'ms'), null);
    assert.equal(parseNumericAnswer(''), null);
    assert.equal(normalizeShortAnswer('  Máscara   DE Rede '), 'mascara de rede');
});

test('[UC-PROVA-004] nota por pontos: soma de pontos, arredondamento e contagem de questões (D4)', () => {
    const evaluation = {
        questions: [
            { ...MC, originalNumber: 1 },
            { ...MA, originalNumber: 2 },
            { ...NUM, originalNumber: 3 },
            { ...SHORT, originalNumber: 4 },
            { ...TF, originalNumber: 5 },
            { ...ESSAY, originalNumber: 6 },
        ],
    };
    const answers = { 1: 'B', 2: ['A'], 3: { numero: '3,5' }, 4: { texto: 'gateway' }, 5: 'B', 6: { texto: 'Explico aqui.' } };
    const grade = gradeAttempt({ evaluation, answers });
    // 2 + 1,5 + 2 + 0 + 1 + 0 (aguardando) de 2 + 3 + 2 + 1 + 1 + 4 = 6,5 de 13 = 50%.
    assert.equal(grade.pointsEarned, 6.5);
    assert.equal(grade.pointsPossible, 13);
    assert.equal(grade.score, 50);
    assert.equal(grade.correctCount, 3, 'uma correta, numérica e V/F');
    assert.equal(grade.totalCount, 6);
    assert.equal(grade.pendingCount, 1);
    const essay = grade.gradedAnswers.find(answer => answer.questionNumber === 6);
    assert.deepEqual(essay, {
        questionNumber: 6, type: 'essay', studentChoice: null, studentChoices: [], studentResponse: 'Explico aqui.',
        correctAnswer: null, correctAnswers: [], isCorrect: null, pointsEarned: 0, pointsPossible: 4, pending: true,
        annulled: false, annulmentMode: null,
    });
    const multiple = grade.gradedAnswers.find(answer => answer.questionNumber === 2);
    assert.deepEqual([multiple.studentChoice, multiple.studentChoices, multiple.correctAnswers, multiple.pointsEarned], [null, ['A'], ['A', 'C'], 1.5]);
    assert.equal(grade.gradedAnswers.find(answer => answer.questionNumber === 3).studentResponse, '3,5');

    // Pontos quebrados: 0,1 + 0,2 não vira 0,30000000000000004.
    const tiny = gradeAttempt({
        evaluation: { questions: [{ ...MC, points: 0.1, originalNumber: 1 }, { ...MC, points: 0.2, originalNumber: 2 }, { ...MC, points: 0.3, originalNumber: 3 }] },
        answers: { 1: 'B', 2: 'B', 3: 'A' },
    });
    assert.equal(tiny.pointsEarned, 0.3);
    assert.equal(tiny.pointsPossible, 0.6);
    assert.equal(tiny.score, 50);

    // Anulação com pontos diferentes: removida sai do total; ponto para todos dá os pontos.
    const application = { annulledQuestions: [{ questionNumber: 2, mode: 'remover_do_total' }, { questionNumber: 6, mode: 'ponto_para_todos' }] };
    const annulled = gradeAttempt({ application, evaluation, answers });
    // 2 + 2 + 0 + 1 + 4 de 2 + 2 + 1 + 1 + 4 = 9 de 10.
    assert.equal(annulled.pointsPossible, 10);
    assert.equal(annulled.pointsEarned, 9);
    assert.equal(annulled.score, 90);
    assert.equal(annulled.totalCount, 5);
    assert.equal(annulled.pendingCount, 0);

    // Prova toda removida do total: 100, como antes.
    const empty = gradeAttempt({ application: { annulledQuestions: [{ questionNumber: 1, mode: 'remover_do_total' }] }, evaluation: { questions: [{ ...MC, originalNumber: 1 }] }, answers: {} });
    assert.equal(empty.score, 100);
});

test('[UC-PROVA-004] entrega guarda pontos; recorreção lê as respostas por tipo e mantém a correção do professor (D6, D8)', () => {
    const evaluation = { questions: [{ ...MA, originalNumber: 1 }, { ...NUM, originalNumber: 2 }, { ...ESSAY, originalNumber: 3 }, { ...MC, originalNumber: 4 }] };
    const submission = createSubmissionFromAttempt({
        evaluation,
        state: { studentEmail: 'ana@escola.local', assignedVersion: 'A' },
        answers: { 1: ['A', 'C'], 2: { numero: '3,5' }, 3: { texto: 'Resposta longa.' }, 4: 'A' },
        student: { email: 'ana@escola.local', name: 'Ana', password: 'x' },
    });
    assert.equal(submission.pointsEarned, 5);
    assert.equal(submission.pointsPossible, 11);
    assert.equal(submission.score, 45);
    assert.equal(submission.student.password, undefined);
    // O professor corrigiu a dissertativa (3 de 4 pontos).
    submission.correcao = { situacao: 'concluida', versao: 2, itens: { 3: { pontos: 3, comentario: 'Bom.' } } };
    const correcaoAntes = JSON.parse(JSON.stringify(submission.correcao));
    // Anulação da questão 4 (ponto para todos): a recorreção soma os 3 pontos do professor.
    regradeSubmission({ submission, application: { annulledQuestions: [{ questionNumber: 4, mode: 'ponto_para_todos' }] }, evaluation, reason: 'anulação' });
    assert.deepEqual(submission.correcao, correcaoAntes, 'a correção do professor não é tocada');
    assert.equal(submission.pointsEarned, 3 + 2 + 3 + 2);
    assert.equal(submission.score, Math.round((10 / 11) * 100));
    const byNumber = Object.fromEntries(submission.gradedAnswers.map(answer => [answer.questionNumber, answer]));
    assert.deepEqual(byNumber[1].studentChoices, ['A', 'C']);
    assert.equal(byNumber[2].studentResponse, '3,5');
    assert.equal(byNumber[3].studentResponse, 'Resposta longa.', 'o texto do aluno não se perde na recorreção');
    assert.equal(byNumber[3].pending, false);
    assert.equal(submission.scoreHistory.at(-1).reason, 'anulação');
    // Respondidas: lista, número e texto contam.
    assert.equal(submission.gradedAnswers.filter(isAnswered).length, 4);
    assert.equal(countAnswers({ 1: ['A'], 2: { numero: '1' }, 3: { texto: 'x' }, 4: 'B', 5: [], 6: { texto: '  ' }, 7: '' }), 4);
});

test('[UC-PROVA-004] describeAnswer: texto da resposta de cada tipo (contrato C3)', () => {
    const line = (question, answer) => gradedAnswerFor(question, 1, answer);
    assert.equal(describeAnswer(MC, line(MC, 'B')), 'B');
    assert.equal(describeAnswer(MA, line(MA, ['A', 'C', 'D'])), 'A, C e D');
    assert.equal(describeAnswer(MA, line(MA, ['C', 'A'])), 'A e C');
    assert.equal(describeAnswer(NUM, line(NUM, { numero: '3.5' })), '3,5 ms');
    assert.equal(describeAnswer(NUM, line(NUM, { numero: 'abc' })), 'abc');
    assert.equal(describeAnswer(SHORT, line(SHORT, { texto: 'sub-rede' })), 'sub-rede');
    assert.equal(describeAnswer(ESSAY, line(ESSAY, { texto: 'Um texto longo' })), 'Resposta escrita');
    assert.equal(describeAnswer(MC, line(MC, null)), '');
    assert.equal(describeAnswer(MC, line(MC, null), { blank: 'Em branco' }), 'Em branco');
    // Entrega antiga: só studentChoice.
    assert.equal(describeAnswer({}, { questionNumber: 1, studentChoice: 'c' }), 'C');
});

// ------------------------------------------------------------------ compatibilidade
function readTable(dbFile, table) {
    return new Promise((resolve, reject) => {
        const database = new sqlite3.Database(dbFile, sqlite3.OPEN_READONLY, error => {
            if (error) return reject(error);
            database.all(`SELECT key, value FROM ${table}`, (queryError, rows) => {
                database.close();
                if (queryError) return reject(queryError);
                resolve(rows.map(row => ({ key: row.key, value: JSON.parse(row.value) })));
            });
        });
    });
}

// Gerador determinístico (os casos sorteados são sempre os mesmos).
function seeded(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function shuffled(list, random) {
    const copy = [...list];
    for (let index = copy.length - 1; index > 0; index--) {
        const other = Math.floor(random() * (index + 1));
        [copy[index], copy[other]] = [copy[other], copy[index]];
    }
    return copy;
}

test('[UC-PROVA-004] compatibilidade: notas do banco de referência 281029f iguais às do corretor antigo (D1)', async () => {
    const dbFile = path.join(__dirname, 'fixtures', 'banco-281029f.db');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-exam-scoring-'));
    const copy = path.join(tempRoot, 'database.db');
    fs.copyFileSync(dbFile, copy);
    try {
        const evaluations = Object.fromEntries((await readTable(copy, 'evaluations')).map(row => [row.key, row.value]));
        const applications = (await readTable(copy, 'exam_applications')).map(row => row.value);
        const classes = (await readTable(copy, 'classes')).map(row => row.value);
        const submissions = (await readTable(copy, 'submissions')).map(row => row.value);
        assert.ok(Object.keys(evaluations).length >= 10, 'o banco de referência tem as avaliações');
        assert.ok(submissions.length >= 50, 'o banco de referência tem as entregas');
        let compared = 0;
        submissions.forEach(submission => {
            const evaluation = evaluations[submission.examKey];
            if (!evaluation || !Array.isArray(submission.gradedAnswers)) return;
            const application = applications.find(item => item.id === submission.applicationId) || null;
            const cls = classes.find(item => item.name === submission.student?.studentClass) || null;
            const onlineConfig = cls?.onlineExamConfigs?.[submission.examKey] || null;
            const state = {
                assignedVersion: submission.assignedVersion || 'A',
                assignedQuestionNumbers: submission.gradedAnswers.map(answer => Number(answer.questionNumber)),
            };
            const answers = Object.fromEntries(submission.gradedAnswers.filter(answer => answer.studentChoice).map(answer => [answer.questionNumber, answer.studentChoice]));
            assertSameAsFrozen({ application, onlineConfig, state, evaluation, answers }, `entrega ${submission.id}`);
            // A recorreção (anulação depois da prova) também dá a mesma nota de antes.
            const regraded = regradeSubmission({ submission: JSON.parse(JSON.stringify(submission)), application, onlineConfig, evaluation });
            const reference = frozen.gradeAttemptOld({ application, onlineConfig, state, evaluation, answers });
            assert.equal(regraded.score, reference.score);
            compared += 1;
        });
        assert.ok(compared >= 50, `${compared} entregas comparadas`);

        // Provas sorteadas sobre as avaliações reais: versões embaralhadas montadas como a
        // tela monta, respostas ao acaso (inclusive inválidas e em branco), anulações.
        const random = seeded(281029);
        let cases = 0;
        Object.values(evaluations).forEach(evaluation => {
            const questions = (evaluation.questions || []).map((question, index) => ({ ...question, originalNumber: Number(question.originalNumber || question.number || index + 1) }));
            if (!questions.length) return;
            for (let round = 0; round < 60; round++) {
                const picked = shuffled(questions, random).slice(0, 1 + Math.floor(random() * questions.length));
                const snapshot = {
                    version: 'A',
                    questions: picked.map((question, index) => ({
                        originalNumber: question.originalNumber,
                        examNumber: index + 1,
                        text: question.text,
                        // Metade das versões leva o gabarito; a outra metade cai na avaliação.
                        correctAnswer: random() < 0.5 ? question.correctAnswer : undefined,
                        alternatives: shuffled(question.alternatives || [], random).map((alternative, position) => ({ ...alternative, displayLetter: 'ABCDEFGH'[position] })),
                    })),
                };
                const annulledQuestions = picked.filter(() => random() < 0.15).map(question => ({
                    questionNumber: question.originalNumber,
                    mode: random() < 0.5 ? 'remover_do_total' : 'ponto_para_todos',
                }));
                const application = { versionSnapshots: [snapshot], annulledQuestions };
                const answers = {};
                picked.forEach(question => {
                    const roll = random();
                    if (roll < 0.1) return;
                    if (roll < 0.15) answers[question.originalNumber] = 'Z';
                    else if (roll < 0.2) answers[question.originalNumber] = String('abcd'[Math.floor(random() * 4)]);
                    else answers[question.originalNumber] = 'ABCD'[Math.floor(random() * 4)];
                });
                const state = { assignedVersion: 'A', assignedQuestionNumbers: random() < 0.5 ? picked.map(question => question.originalNumber) : undefined };
                assertSameAsFrozen({ application, state, evaluation, answers }, `sorteio ${cases}`);
                cases += 1;
            }
        });
        assert.ok(cases >= 600, `${cases} provas sorteadas`);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('[UC-PROVA-004] compatibilidade: formatos antigos de questão (alternativas em objeto, gabarito só na marca, weight 1.0 do .md)', () => {
    const legacy = {
        questions: [
            { originalNumber: 1, text: 'a', weight: 1.0, alternatives: { A: 'x', B: 'y', C: 'z' }, correctAnswer: 'b' },
            { originalNumber: 2, text: 'b', weight: 1.0, alternatives: [{ letter: 'A', text: 'x' }, { letter: 'B', text: 'y', isCorrect: true }], correctAnswer: '' },
            { number: 3, text: 'c', alternatives: [{ letter: 'A', text: 'x' }, { letter: 'B', text: 'y' }] },
            { originalNumber: 4, text: 'd', type: 'multiple_choice', alternatives: [{ letter: 'A', text: 'x', isCorrect: true }, { letter: 'B', text: 'y' }] },
        ],
    };
    const combos = [{}, { 1: 'B', 2: 'B', 3: 'A', 4: 'A' }, { 1: 'A', 2: 'A', 3: 'B', 4: 'B' }, { 1: '', 2: null, 4: 'a' }];
    combos.forEach((answers, index) => assertSameAsFrozen({ evaluation: legacy, answers }, `legado ${index}`));
});

test('[UC-PROVA-004] compatibilidade: seed do TEST_MODE corrigido igual pelos dois corretores', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-exam-scoring-seed-'));
    const childScript = path.join(tempRoot, 'seed-child.js');
    // O seed roda num processo próprio (TEST_MODE e pasta de dados só dele) e devolve as
    // avaliações e as entregas que ele monta.
    fs.writeFileSync(childScript, `
process.env.ICLASS_DATA_DIR = ${JSON.stringify(path.join(tempRoot, 'data'))};
process.env.ICLASS_CONTENT_DIR = ${JSON.stringify(path.join(tempRoot, 'content'))};
process.env.ICLASS_ARCHIVE_DIR = ${JSON.stringify(path.join(tempRoot, 'archives'))};
process.env.TEST_MODE = '1';
const request = require(${JSON.stringify(require.resolve('supertest'))});
const db = require(${JSON.stringify(path.join(__dirname, '..', '..', 'backend', 'database.js'))});
const { createApp } = require(${JSON.stringify(path.join(__dirname, '..', '..', 'backend', 'server.js'))});
(async () => {
    await db.init();
    const app = createApp();
    const response = await request(app).post('/api/test/seed').send({});
    if (response.status >= 400) throw new Error('seed: ' + response.status + ' ' + JSON.stringify(response.body));
    process.stdout.write(JSON.stringify({ evaluations: db.memory.evaluations, submissions: db.memory.submissions, examApplications: db.memory.examApplications, classes: db.memory.classes }));
    await new Promise(resolve => setTimeout(resolve, 500));
    await db.close();
    process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
`);
    try {
        const { spawnSync } = require('node:child_process');
        const env = { ...process.env };
        ['NODE_TEST_CONTEXT', 'ICLASS_VERIFY_SAVES'].forEach(key => delete env[key]);
        const child = spawnSync(process.execPath, [childScript], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
        assert.equal(child.status, 0, child.stderr);
        const seeded = JSON.parse(child.stdout.slice(child.stdout.indexOf('{"evaluations"')));
        let compared = 0;
        seeded.submissions.forEach(submission => {
            const evaluation = seeded.evaluations[submission.examKey];
            if (!evaluation || !Array.isArray(submission.gradedAnswers) || !submission.gradedAnswers.length) return;
            const application = seeded.examApplications.find(item => item.id === submission.applicationId) || null;
            const state = { assignedVersion: submission.assignedVersion || 'A', assignedQuestionNumbers: submission.gradedAnswers.map(answer => Number(answer.questionNumber)) };
            const answers = Object.fromEntries(submission.gradedAnswers.filter(answer => answer.studentChoice).map(answer => [answer.questionNumber, answer.studentChoice]));
            assertSameAsFrozen({ application, state, evaluation, answers }, `seed ${submission.id}`);
            compared += 1;
        });
        assert.ok(compared >= 20, `${compared} entregas do seed comparadas`);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});
