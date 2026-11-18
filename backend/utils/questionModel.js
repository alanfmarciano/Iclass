// Modelo único da questão (fase 3, P3-S1: AVA-06, FUN-10; decisão D3 do desenho P3).
//
// Uma regra só para a avaliação (PUT/POST /api/admin/evaluation), a correção ao vivo
// (adminExamConfig.js) e, a partir do banco de questões novo, o banco: antes eram três
// validações diferentes e o banco aceitava o que a avaliação recusava.
//
// normalizeQuestion(raw, { index, context, previous }) devolve a questão limpa ou lança
// um erro 400 com a mensagem em português ("Questão 3: informe pelo menos uma resposta
// aceita."). context: 'avaliacao' (padrão), 'banco' ou 'ao_vivo'. Na correção ao vivo as
// letras das alternativas são as do pedido (são as do gabarito e dos identificadores das
// respostas já salvas), alternativa vazia sai e o tipo, sem pedido, é o da questão de
// antes (previous).
//
// Campos (docs/MODELO_DADOS.md, "Questões da prova"):
// - type: 'multiple_choice' (padrão) | 'multiple_answer' | 'true_false' | 'numeric' |
//   'short_answer' | 'essay';
// - points: 0,1 a 100, até duas casas (padrão 1);
// - text: Markdown até 20.000; alternatives[].text: Markdown até 2.000;
// - escolha única: correctAnswer (letra); várias corretas: correctAnswers (letras) e
//   partialCredit (padrão true: proporcional, errada desconta, nunca negativa);
//   verdadeiro ou falso: alternativas fixas A = Verdadeiro e B = Falso;
// - numeric: { value, tolerance >= 0, unit? (até 20) }; short_answer: acceptedAnswers (1 a
//   20, até 300 cada); review: 'auto' | 'professor' nas duas (mandar para o professor a
//   resposta que não bate);
// - essay: expectedAnswer (até 5.000, só do professor) e rubric ([{ id, nome, pontos }],
//   1 a 8 critérios cuja soma é igual aos pontos);
// - explanation: Markdown até 5.000 (vai ao aluno só com o gabarito liberado);
// - metadados: difficulty ('facil' | 'media' | 'dificil'), skills[] e tags[] (até 10),
//   bankKey (questão que veio do banco).
// Questão antiga sem type é 'multiple_choice' e sem points vale 1 ponto (D1): o modelo só
// é aplicado quando alguém salva; nada é reescrito no boot.
const { QUESTION_TYPES, normalizeShortAnswer } = require('./examScoring.js');
const { formatCount } = require('./inputSchema.js');

const LIMITS = Object.freeze({
    text: 20000,
    alternative: 2000,
    explanation: 5000,
    expectedAnswer: 5000,
    acceptedAnswer: 300,
    acceptedAnswers: 20,
    unit: 20,
    rubricCriteria: 8,
    rubricName: 80,
    skills: 10,
    skill: 80,
    tags: 10,
    tag: 40,
    bankKey: 100,
    minAlternatives: 2,
    maxAlternatives: 8,
    minPoints: 0.1,
    maxPoints: 100,
    questions: 500,
});
const DIFFICULTIES = Object.freeze(['facil', 'media', 'dificil']);
const REVIEW_MODES = Object.freeze(['auto', 'professor']);
const TRUE_FALSE_ALTERNATIVES = Object.freeze([
    Object.freeze({ letter: 'A', text: 'Verdadeiro' }),
    Object.freeze({ letter: 'B', text: 'Falso' }),
]);
const TYPE_LABELS = Object.freeze({
    multiple_choice: 'Uma correta',
    multiple_answer: 'Várias corretas',
    true_false: 'Verdadeiro ou falso',
    numeric: 'Numérica',
    short_answer: 'Resposta curta',
    essay: 'Dissertativa',
});
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

function questionError(message) {
    return Object.assign(new Error(message), { status: 400 });
}

// Prefixo da mensagem: "Questão 3: " na avaliação e no banco; na correção ao vivo (uma
// questão só) a mensagem começa direto.
function messageFor(context, index, text) {
    if (context === 'ao_vivo') return text.charAt(0).toUpperCase() + text.slice(1);
    return `Questão ${index + 1}: ${text}`;
}

function formatNumberBR(value) {
    return String(Math.round(Number(value) * 100) / 100).replace('.', ',');
}

// Número digitado como número ou texto ('2,5'); null quando vazio; NaN quando inválido.
function parseNumberInput(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
    if (typeof raw !== 'string') return NaN;
    const text = raw.trim().replace(',', '.');
    if (!text) return null;
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return NaN;
    return Number(text);
}

function cleanText(value) {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return '';
}

function markdownField(raw, max, fail, label) {
    const text = cleanText(raw);
    if (text.length > max) throw fail(`${label} aceita no máximo ${formatCount(max)} caracteres.`);
    return text;
}

function normalizeType(raw, previous, fail) {
    const requested = typeof raw === 'string' ? raw.trim() : '';
    if (!requested) {
        const kept = typeof previous?.type === 'string' ? previous.type.trim() : '';
        return QUESTION_TYPES.includes(kept) ? kept : 'multiple_choice';
    }
    if (!QUESTION_TYPES.includes(requested)) throw fail('tipo de questão desconhecido.');
    return requested;
}

function normalizePoints(raw, fail) {
    const value = parseNumberInput(raw);
    if (value === null) return 1;
    const rounded = Math.round(value * 100) / 100;
    if (!Number.isFinite(value) || value < LIMITS.minPoints || value > LIMITS.maxPoints || Math.abs(rounded - value) > 1e-9) {
        throw fail('os pontos devem ficar entre 0,1 e 100, com até duas casas decimais.');
    }
    return rounded;
}

function alternativeSource(raw) {
    if (Array.isArray(raw?.alternatives)) return raw.alternatives;
    if (raw?.alternatives && typeof raw.alternatives === 'object') {
        return Object.entries(raw.alternatives).map(([letter, text]) => ({ letter, text }));
    }
    return [];
}

function alternativeTextOf(alternative) {
    if (typeof alternative === 'string') return alternative;
    if (alternative && typeof alternative === 'object') return alternative.text ?? alternative.label ?? '';
    return '';
}

function upperLetters(list) {
    return (Array.isArray(list) ? list : [])
        .map(item => (typeof item === 'string' ? item.trim().toUpperCase() : ''))
        .filter(Boolean);
}

// Alternativas dos tipos de escolha. Na avaliação e no banco as letras são A, B, C... na
// ordem; ao vivo, as do pedido. Devolve [{ letter, text, isCorrect? }] sem a marca.
function choiceAlternatives(raw, context, fail) {
    const source = alternativeSource(raw);
    if (context === 'ao_vivo') {
        const seen = new Set();
        const alternatives = source.map((alternative, index) => {
            const letter = String((alternative && typeof alternative === 'object' && alternative.letter) || LETTERS[index] || '').trim().toUpperCase();
            return { letter, text: cleanText(alternativeTextOf(alternative)), marked: alternative?.isCorrect === true };
        }).filter(alternative => alternative.text);
        alternatives.forEach(alternative => {
            if (!/^[A-Z]$/.test(alternative.letter) || seen.has(alternative.letter)) throw fail('as letras das alternativas estão repetidas ou inválidas.');
            seen.add(alternative.letter);
        });
        if (alternatives.length < LIMITS.minAlternatives) throw fail('informe pelo menos duas alternativas.');
        if (alternatives.length > LIMITS.maxAlternatives) throw fail('a questão aceita no máximo 8 alternativas.');
        alternatives.forEach(alternative => {
            if (alternative.text.length > LIMITS.alternative) throw fail(`cada alternativa aceita no máximo ${formatCount(LIMITS.alternative)} caracteres.`);
        });
        return alternatives.map(alternative => ({ ...alternative, original: alternative.letter }));
    }
    if (source.length < LIMITS.minAlternatives || source.length > LIMITS.maxAlternatives) {
        throw fail('a questão deve ter entre 2 e 8 alternativas.');
    }
    return source.map((alternative, index) => {
        const text = cleanText(alternativeTextOf(alternative));
        if (!text) throw fail('preencha todas as alternativas.');
        if (text.length > LIMITS.alternative) throw fail(`cada alternativa aceita no máximo ${formatCount(LIMITS.alternative)} caracteres.`);
        const original = String((alternative && typeof alternative === 'object' && alternative.letter) || '').trim().toUpperCase();
        return { letter: LETTERS[index], text, marked: alternative?.isCorrect === true, original };
    });
}

function normalizeChoice(raw, type, context, fail) {
    if (type === 'true_false') {
        const source = alternativeSource(raw);
        if (source.length && source.length !== 2) throw fail('verdadeiro ou falso tem só as alternativas Verdadeiro e Falso.');
        let correct = typeof raw?.correctAnswer === 'string' ? raw.correctAnswer.trim().toUpperCase() : '';
        if (correct === 'V' || correct === 'VERDADEIRO' || correct === 'TRUE') correct = 'A';
        if (correct === 'F' || correct === 'FALSO' || correct === 'FALSE') correct = 'B';
        if (!correct && typeof raw?.correct === 'boolean') correct = raw.correct ? 'A' : 'B';
        if (!correct && source.length === 2) {
            const markedIndex = source.findIndex(alternative => alternative?.isCorrect === true);
            if (markedIndex >= 0 && source.filter(alternative => alternative?.isCorrect === true).length === 1) correct = LETTERS[markedIndex];
        }
        if (correct !== 'A' && correct !== 'B') throw fail('marque se a afirmação é verdadeira ou falsa.');
        return {
            alternatives: TRUE_FALSE_ALTERNATIVES.map(alternative => ({ ...alternative, isCorrect: alternative.letter === correct })),
            correctAnswer: correct,
        };
    }
    const alternatives = choiceAlternatives(raw, context, fail);
    // A resposta certa pode vir pela marca da alternativa ou pela letra (a letra do
    // pedido: ao vivo é a original; na avaliação, a do formulário, que é a da posição).
    const byRequested = letter => alternatives.find(alternative => alternative.original === letter || (!alternative.original && alternative.letter === letter));
    if (type === 'multiple_choice') {
        const requested = typeof raw?.correctAnswer === 'string' ? raw.correctAnswer.trim().toUpperCase() : '';
        const flagged = alternatives.filter(alternative => alternative.marked);
        let correct = null;
        if (context === 'ao_vivo') {
            correct = requested ? alternatives.find(alternative => alternative.letter === requested) : flagged[0];
            if (!correct) throw fail('selecione uma alternativa correta válida.');
        } else {
            const chosen = new Set(flagged.map(alternative => alternative.letter));
            if (requested) {
                const match = byRequested(requested);
                if (match) chosen.add(match.letter);
            }
            if (chosen.size !== 1) throw fail('marque exatamente uma alternativa correta.');
            correct = alternatives.find(alternative => chosen.has(alternative.letter));
        }
        return {
            alternatives: alternatives.map(alternative => ({ letter: alternative.letter, text: alternative.text, isCorrect: alternative.letter === correct.letter })),
            correctAnswer: correct.letter,
        };
    }
    // Várias corretas.
    const chosen = new Set(alternatives.filter(alternative => alternative.marked).map(alternative => alternative.letter));
    upperLetters(raw?.correctAnswers).forEach(letter => {
        const match = context === 'ao_vivo' ? alternatives.find(alternative => alternative.letter === letter) : byRequested(letter);
        if (!match) throw fail('as respostas corretas precisam ser letras das alternativas.');
        chosen.add(match.letter);
    });
    if (!chosen.size) throw fail('marque pelo menos uma alternativa correta.');
    const normalizedAlternatives = alternatives.map(alternative => ({ letter: alternative.letter, text: alternative.text, isCorrect: chosen.has(alternative.letter) }));
    return {
        alternatives: normalizedAlternatives,
        correctAnswer: '',
        correctAnswers: normalizedAlternatives.filter(alternative => alternative.isCorrect).map(alternative => alternative.letter),
        partialCredit: raw?.partialCredit !== false,
    };
}

function normalizeReview(raw, fail) {
    const value = typeof raw?.review === 'string' ? raw.review.trim() : '';
    if (!value) return 'auto';
    if (!REVIEW_MODES.includes(value)) throw fail('a revisão da resposta deve ser "auto" ou "professor".');
    return value;
}

function normalizeNumeric(raw, fail) {
    const source = raw?.numeric && typeof raw.numeric === 'object' ? raw.numeric : {};
    const value = parseNumberInput(source.value);
    if (value === null || !Number.isFinite(value)) throw fail('informe o valor da resposta numérica.');
    const tolerance = parseNumberInput(source.tolerance);
    if (tolerance !== null && (!Number.isFinite(tolerance) || tolerance < 0)) throw fail('a tolerância deve ser um número maior ou igual a zero.');
    const unit = cleanText(source.unit);
    if (unit.length > LIMITS.unit) throw fail(`a unidade aceita no máximo ${LIMITS.unit} caracteres.`);
    return { value, tolerance: tolerance === null ? 0 : tolerance, ...(unit ? { unit } : {}) };
}

function normalizeAcceptedAnswers(raw, fail) {
    const source = Array.isArray(raw?.acceptedAnswers) ? raw.acceptedAnswers : [];
    const seen = new Set();
    const accepted = [];
    source.forEach(item => {
        const text = cleanText(item);
        if (!text) return;
        if (text.length > LIMITS.acceptedAnswer) throw fail(`cada resposta aceita tem no máximo ${LIMITS.acceptedAnswer} caracteres.`);
        const key = normalizeShortAnswer(text);
        if (!key || seen.has(key)) return;
        seen.add(key);
        accepted.push(text);
    });
    if (!accepted.length) throw fail('informe pelo menos uma resposta aceita.');
    if (accepted.length > LIMITS.acceptedAnswers) throw fail(`a questão aceita no máximo ${LIMITS.acceptedAnswers} respostas aceitas.`);
    return accepted;
}

// Rubrica da dissertativa (D9): 1 a 8 critérios { id, nome, pontos } com soma = pontos.
// O id é estável (a correção do professor guarda os pontos por id): o que vier válido
// e sem repetição fica; o que faltar ganha 'c1', 'c2'...
function normalizeRubric(raw, points, fail) {
    if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) return null;
    if (!Array.isArray(raw)) throw fail('a rubrica precisa ser uma lista de critérios.');
    if (raw.length > LIMITS.rubricCriteria) throw fail(`a rubrica aceita no máximo ${LIMITS.rubricCriteria} critérios.`);
    const used = new Set();
    const criteria = raw.map((item, criterionIndex) => {
        const nome = cleanText(item?.nome ?? item?.name);
        if (!nome) throw fail(`dê um nome ao critério ${criterionIndex + 1} da rubrica.`);
        if (nome.length > LIMITS.rubricName) throw fail(`o nome do critério ${criterionIndex + 1} da rubrica aceita no máximo ${LIMITS.rubricName} caracteres.`);
        const value = parseNumberInput(item?.pontos ?? item?.points);
        const rounded = value === null ? NaN : Math.round(value * 100) / 100;
        if (!Number.isFinite(value) || value <= 0 || value > LIMITS.maxPoints || Math.abs(rounded - value) > 1e-9) {
            throw fail(`os pontos do critério ${criterionIndex + 1} da rubrica devem ser maiores que zero, com até duas casas decimais.`);
        }
        const requestedId = typeof item?.id === 'string' ? item.id.trim() : '';
        const id = /^[A-Za-z0-9_-]{1,20}$/.test(requestedId) && !used.has(requestedId) ? requestedId : '';
        if (id) used.add(id);
        return { id, nome, pontos: rounded };
    });
    let next = 1;
    criteria.forEach(criterion => {
        if (criterion.id) return;
        while (used.has(`c${next}`)) next += 1;
        criterion.id = `c${next}`;
        used.add(criterion.id);
    });
    const total = Math.round(criteria.reduce((sum, criterion) => sum + criterion.pontos, 0) * 100) / 100;
    if (Math.abs(total - points) > 0.005) {
        throw fail(`a soma dos critérios da rubrica (${formatNumberBR(total)}) precisa ser igual aos pontos da questão (${formatNumberBR(points)}).`);
    }
    return criteria;
}

function normalizeTextList(raw, maxItems, maxLength, fail, label) {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw fail(`${label} precisa ser uma lista.`);
    const seen = new Set();
    const out = [];
    raw.forEach(item => {
        const text = cleanText(item);
        if (!text) return;
        if (text.length > maxLength) throw fail(`cada item de ${label} tem no máximo ${maxLength} caracteres.`);
        const key = text.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(text);
    });
    if (out.length > maxItems) throw fail(`${label} aceita no máximo ${maxItems} itens.`);
    return out;
}

function normalizeMetadata(raw, fail) {
    const meta = {};
    const difficulty = typeof raw?.difficulty === 'string' ? raw.difficulty.trim() : '';
    if (difficulty) {
        if (!DIFFICULTIES.includes(difficulty)) throw fail('a dificuldade deve ser fácil, média ou difícil.');
        meta.difficulty = difficulty;
    }
    const skills = normalizeTextList(raw?.skills, LIMITS.skills, LIMITS.skill, fail, 'habilidades');
    if (skills.length) meta.skills = skills;
    const tags = normalizeTextList(raw?.tags, LIMITS.tags, LIMITS.tag, fail, 'etiquetas');
    if (tags.length) meta.tags = tags;
    const bankKey = cleanText(raw?.bankKey);
    if (bankKey) {
        if (bankKey.length > LIMITS.bankKey) throw fail('a referência ao banco de questões é longa demais.');
        meta.bankKey = bankKey;
    }
    return meta;
}

// Campos que a correção ao vivo herda da questão de antes quando o pedido não traz (o
// formulário do Monitor manda só enunciado, alternativas e a letra certa).
const LIVE_INHERITED_FIELDS = ['points', 'partialCredit', 'numeric', 'acceptedAnswers', 'review', 'expectedAnswer', 'rubric', 'explanation', 'difficulty', 'skills', 'tags', 'bankKey'];

function withLiveInheritance(raw, previous) {
    if (!previous || typeof previous !== 'object') return raw;
    const merged = { ...raw };
    LIVE_INHERITED_FIELDS.forEach(field => {
        if (merged[field] === undefined && previous[field] !== undefined) merged[field] = previous[field];
    });
    const type = typeof merged.type === 'string' && merged.type.trim() ? merged.type.trim() : previous.type;
    if (type === 'multiple_answer') {
        const marked = alternativeSource(merged).some(alternative => alternative?.isCorrect === true);
        if (merged.correctAnswers === undefined && !marked && Array.isArray(previous.correctAnswers)) merged.correctAnswers = previous.correctAnswers;
    }
    return merged;
}

function normalizeQuestion(input, { index = 0, context = 'avaliacao', previous = null } = {}) {
    const fail = text => questionError(messageFor(context, index, text));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('questão em formato inválido.');
    const raw = context === 'ao_vivo' ? withLiveInheritance(input, previous) : input;
    const type = normalizeType(raw.type, context === 'ao_vivo' ? previous : null, fail);
    const points = normalizePoints(raw.points, fail);
    const text = cleanText(raw.text || raw.questionText);
    if (!text) throw fail(context === 'ao_vivo' ? 'o enunciado da questão é obrigatório.' : 'informe o enunciado.');
    if (text.length > LIMITS.text) throw fail(`o enunciado aceita no máximo ${formatCount(LIMITS.text)} caracteres.`);
    const question = { type, points, text };
    if (type === 'multiple_choice' || type === 'multiple_answer' || type === 'true_false') {
        Object.assign(question, normalizeChoice(raw, type, context, fail));
    } else {
        question.alternatives = [];
        question.correctAnswer = '';
        if (type === 'numeric') {
            question.numeric = normalizeNumeric(raw, fail);
            question.review = normalizeReview(raw, fail);
        } else if (type === 'short_answer') {
            question.acceptedAnswers = normalizeAcceptedAnswers(raw, fail);
            question.review = normalizeReview(raw, fail);
        } else {
            const expectedAnswer = markdownField(raw.expectedAnswer, LIMITS.expectedAnswer, fail, 'a resposta esperada');
            if (expectedAnswer) question.expectedAnswer = expectedAnswer;
            const rubric = normalizeRubric(raw.rubric, points, fail);
            if (rubric) question.rubric = rubric;
        }
    }
    const explanation = markdownField(raw.explanation, LIMITS.explanation, fail, 'a explicação');
    if (explanation) question.explanation = explanation;
    Object.assign(question, normalizeMetadata(raw, fail));
    return question;
}

// Questões de uma avaliação (POST e PUT /api/admin/evaluation): número e número original
// pela posição, como sempre.
function normalizeEvaluationQuestions(questions, { context = 'avaliacao' } = {}) {
    if (!Array.isArray(questions) || questions.length === 0) {
        throw questionError('A avaliação deve ter pelo menos uma questão.');
    }
    if (questions.length > LIMITS.questions) {
        throw questionError(`A avaliação aceita no máximo ${LIMITS.questions} questões.`);
    }
    return questions.map((raw, index) => ({
        ...normalizeQuestion(raw, { index, context }),
        number: index + 1,
        originalNumber: index + 1,
    }));
}

module.exports = {
    DIFFICULTIES,
    LIMITS,
    REVIEW_MODES,
    TRUE_FALSE_ALTERNATIVES,
    TYPE_LABELS,
    normalizeEvaluationQuestions,
    normalizeQuestion,
};
