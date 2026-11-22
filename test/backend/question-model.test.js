// Modelo único da questão (fase 3, P3-S1: AVA-06, FUN-10; D3 do P3). Antes a avaliação
// só aceitava "uma correta" (2 a 8 alternativas, exatamente uma marcada) e guardava os
// campos que viessem no pedido; agora o modelo valida os seis tipos, os pontos, a
// explicação, a rubrica e os metadados, com mensagem por questão.
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeEvaluationQuestions, normalizeQuestion } = require('../../backend/utils/questionModel.js');

function refuses(raw, pattern, options) {
    assert.throws(() => normalizeQuestion(raw, options), error => {
        assert.equal(error.status, 400);
        assert.match(error.message, pattern);
        return true;
    });
}

const ALTS = ['Um', 'Dois', 'Três', 'Quatro'].map(text => ({ text }));

test('[UC-PROVA-004] questão antiga sem type continua aceita: uma correta de 1 ponto, letras pela posição (D1)', () => {
    const [question] = normalizeEvaluationQuestions([{
        text: '  Enunciado  ',
        alternatives: [{ letter: 'A', text: 'x' }, { letter: 'B', text: 'y', isCorrect: true }, { letter: 'C', text: 'z' }],
        correctAnswer: 'B',
        weight: 1.0,
        lixo: 'não fica',
    }]);
    assert.deepEqual(question, {
        type: 'multiple_choice',
        points: 1,
        text: 'Enunciado',
        alternatives: [
            { letter: 'A', text: 'x', isCorrect: false },
            { letter: 'B', text: 'y', isCorrect: true },
            { letter: 'C', text: 'z', isCorrect: false },
        ],
        correctAnswer: 'B',
        number: 1,
        originalNumber: 1,
    });
    // Alternativas como texto e a letra da resposta pela posição.
    const [fromStrings] = normalizeEvaluationQuestions([{ text: 'Q', alternatives: ['x', 'y'], correctAnswer: 'B' }]);
    assert.equal(fromStrings.correctAnswer, 'B');
});

test('[UC-PROVA-004] os seis tipos com o gabarito de cada um', () => {
    const many = normalizeQuestion({ type: 'multiple_answer', points: '2,5', text: 'Q', alternatives: ALTS, correctAnswers: ['a', 'C'] });
    assert.deepEqual(many.correctAnswers, ['A', 'C']);
    assert.equal(many.points, 2.5);
    assert.equal(many.partialCredit, true, 'P3-B3: parcial por padrão');
    assert.deepEqual(many.alternatives.map(alternative => alternative.isCorrect), [true, false, true, false]);
    assert.equal(normalizeQuestion({ type: 'multiple_answer', text: 'Q', alternatives: ALTS.map((item, index) => ({ ...item, isCorrect: index === 3 })), partialCredit: false }).partialCredit, false);

    const tf = normalizeQuestion({ type: 'true_false', text: 'O céu é azul.', correctAnswer: 'V' });
    assert.deepEqual(tf.alternatives, [{ letter: 'A', text: 'Verdadeiro', isCorrect: true }, { letter: 'B', text: 'Falso', isCorrect: false }]);
    assert.equal(tf.correctAnswer, 'A');
    assert.equal(normalizeQuestion({ type: 'true_false', text: 'Q', correct: false }).correctAnswer, 'B');

    const numeric = normalizeQuestion({ type: 'numeric', text: 'Latência?', numeric: { value: '3,5', tolerance: '0,1', unit: ' ms ' } });
    assert.deepEqual(numeric.numeric, { value: 3.5, tolerance: 0.1, unit: 'ms' });
    assert.deepEqual(numeric.alternatives, []);
    assert.equal(numeric.review, 'auto');
    assert.equal(normalizeQuestion({ type: 'numeric', text: 'Q', numeric: { value: 0 } }).numeric.tolerance, 0);

    const short = normalizeQuestion({ type: 'short_answer', text: 'Q', acceptedAnswers: ['Sub-rede', ' sub-rede ', '', 'Máscara'], review: 'professor', alternatives: ALTS });
    assert.deepEqual(short.acceptedAnswers, ['Sub-rede', 'Máscara'], 'repetida (sem maiúsculas e espaços) sai');
    assert.equal(short.review, 'professor');
    assert.deepEqual(short.alternatives, [], 'alternativa esquecida no formulário não fica');

    const essay = normalizeQuestion({
        type: 'essay',
        points: 10,
        text: 'Explique.',
        expectedAnswer: 'Algo assim.',
        rubric: [{ nome: 'Clareza', pontos: 2.5 }, { id: 'c1', nome: 'Conteúdo', pontos: '2,5' }, { name: 'Exemplos', points: 2 }, { nome: 'Fontes', pontos: 1.5 }, { nome: 'Forma', pontos: 1.5 }],
        explanation: '**Porque** sim.',
        difficulty: 'media',
        tags: ['redes', 'Redes', 'ip'],
        skills: ['Competência 3'],
    });
    assert.deepEqual(essay.rubric.map(criterion => criterion.id), ['c2', 'c1', 'c3', 'c4', 'c5'], 'id existente fica; os que faltam ganham o próximo livre');
    assert.deepEqual(essay.rubric.map(criterion => criterion.pontos), [2.5, 2.5, 2, 1.5, 1.5]);
    assert.equal(essay.expectedAnswer, 'Algo assim.');
    assert.equal(essay.explanation, '**Porque** sim.');
    assert.deepEqual(essay.tags, ['redes', 'ip']);
    assert.equal(essay.difficulty, 'media');
});

test('[UC-PROVA-004] recusas com a mensagem da questão', () => {
    const at = { index: 2 };
    refuses({ type: 'true_false', text: 'Q', alternatives: ALTS.slice(0, 3), correctAnswer: 'A' }, /^Questão 3: verdadeiro ou falso tem só as alternativas Verdadeiro e Falso\.$/, at);
    refuses({ type: 'true_false', text: 'Q' }, /marque se a afirmação é verdadeira ou falsa/, at);
    refuses({ type: 'essay', points: 5, text: 'Q', rubric: [{ nome: 'A', pontos: 2 }, { nome: 'B', pontos: 2 }] }, /^Questão 3: a soma dos critérios da rubrica \(4\) precisa ser igual aos pontos da questão \(5\)\.$/, at);
    refuses({ text: 'Q', points: 0, alternatives: ALTS, correctAnswer: 'A' }, /os pontos devem ficar entre 0,1 e 100/, at);
    refuses({ text: 'Q', points: 101, alternatives: ALTS, correctAnswer: 'A' }, /os pontos devem ficar entre 0,1 e 100/, at);
    refuses({ text: 'Q', points: 1.234, alternatives: ALTS, correctAnswer: 'A' }, /até duas casas decimais/, at);
    refuses({ text: 'Q', points: 'dois', alternatives: ALTS, correctAnswer: 'A' }, /os pontos devem ficar/, at);
    refuses({ type: 'multiple_answer', text: 'Q', alternatives: ALTS }, /marque pelo menos uma alternativa correta/, at);
    refuses({ type: 'multiple_answer', text: 'Q', alternatives: ALTS, correctAnswers: ['E'] }, /letras das alternativas/, at);
    refuses({ type: 'numeric', text: 'Q', numeric: {} }, /^Questão 3: informe o valor da resposta numérica\.$/, at);
    refuses({ type: 'numeric', text: 'Q', numeric: { value: 1, tolerance: -1 } }, /tolerância/, at);
    refuses({ type: 'short_answer', text: 'Q', acceptedAnswers: ['  '] }, /^Questão 3: informe pelo menos uma resposta aceita\.$/, at);
    refuses({ type: 'short_answer', text: 'Q', acceptedAnswers: ['a'], review: 'talvez' }, /revisão da resposta/, at);
    refuses({ type: 'dissertativa', text: 'Q' }, /tipo de questão desconhecido/, at);
    refuses({ text: '   ', alternatives: ALTS, correctAnswer: 'A' }, /^Questão 3: informe o enunciado\.$/, at);
    refuses({ text: 'Q', alternatives: ALTS.slice(0, 1), correctAnswer: 'A' }, /entre 2 e 8 alternativas/, at);
    refuses({ text: 'Q', alternatives: [...ALTS, ...ALTS, { text: 'x' }], correctAnswer: 'A' }, /entre 2 e 8 alternativas/, at);
    refuses({ text: 'Q', alternatives: [{ text: 'x' }, { text: '' }], correctAnswer: 'A' }, /preencha todas as alternativas/, at);
    refuses({ text: 'Q', alternatives: ALTS, correctAnswer: 'A', explanation: 'x'.repeat(5001) }, /a explicação aceita no máximo 5\.000 caracteres/, at);
    refuses({ text: 'x'.repeat(20001), alternatives: ALTS, correctAnswer: 'A' }, /20\.000/, at);
    refuses({ text: 'Q', alternatives: ALTS, correctAnswer: 'A', difficulty: 'muito' }, /dificuldade/, at);
    refuses({ text: 'Q', alternatives: ALTS.map(item => ({ ...item, isCorrect: true })) }, /exatamente uma alternativa correta/, at);
    refuses({ text: 'Q', alternatives: ALTS }, /exatamente uma alternativa correta/, at);
    assert.throws(() => normalizeEvaluationQuestions([]), /pelo menos uma questão/);
});

test('[UC-PROVA-004] correção ao vivo: letras originais, alternativa vazia sai e o tipo e o gabarito da questão de antes ficam', () => {
    const live = normalizeQuestion({
        text: 'Q corrigida',
        alternatives: [{ letter: 'C', text: 'c' }, { letter: 'A', text: 'a' }, { letter: 'D', text: '' }],
        correctAnswer: 'C',
    }, { context: 'ao_vivo' });
    assert.deepEqual(live.alternatives, [{ letter: 'C', text: 'c', isCorrect: true }, { letter: 'A', text: 'a', isCorrect: false }]);
    refuses({ text: 'Q', alternatives: [{ letter: 'A', text: 'a' }, { letter: 'B', text: 'b' }], correctAnswer: 'E' }, /^Selecione uma alternativa correta válida\.$/, { context: 'ao_vivo' });
    refuses({ text: '', alternatives: [] }, /^O enunciado da questão é obrigatório\.$/, { context: 'ao_vivo' });

    const previous = { type: 'numeric', points: 3, numeric: { value: 7, tolerance: 0 }, explanation: 'Porque sim.' };
    const numeric = normalizeQuestion({ text: 'Novo enunciado', alternatives: [], correctAnswer: '' }, { context: 'ao_vivo', previous });
    assert.equal(numeric.type, 'numeric');
    assert.equal(numeric.points, 3);
    assert.deepEqual(numeric.numeric, { value: 7, tolerance: 0 });
    assert.equal(numeric.explanation, 'Porque sim.');

    const previousMany = { type: 'multiple_answer', points: 2, correctAnswers: ['A', 'B'], partialCredit: false };
    const many = normalizeQuestion({ text: 'Q', alternatives: [{ letter: 'A', text: 'a' }, { letter: 'B', text: 'b' }, { letter: 'C', text: 'c' }] }, { context: 'ao_vivo', previous: previousMany });
    assert.deepEqual(many.correctAnswers, ['A', 'B']);
    assert.equal(many.partialCredit, false);
});
