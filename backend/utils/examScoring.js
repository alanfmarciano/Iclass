// Corretor por tipo de questão (fase 3, P3-S1: AVA-06, FUN-10; decisões D1, D4, D5 e D6
// do desenho P3). Funções puras, sem banco: usadas na entrega, na recorreção, na troca da
// finalização do servidor, na revisão do professor e no Monitor.
//
// Tipos (D2): 'multiple_choice' (uma correta, o de sempre), 'multiple_answer' (várias
// corretas), 'true_false' (verdadeiro ou falso, alternativas fixas A = Verdadeiro e
// B = Falso), 'numeric' (número com tolerância), 'short_answer' (lista de respostas
// aceitas) e 'essay' (dissertativa, correção do professor). Questão sem type, ou com um
// type que este código não conhece, é 'multiple_choice'; sem points vale 1 ponto e o
// campo antigo weight é ignorado (D1). Com todas as questões valendo 1 ponto, a nota é
// exatamente a de antes: round(acertos / total * 100).
//
// Resposta guardada (estado da tentativa e entrega), por tipo (D5):
// - uma correta e V/F: a letra original (texto);
// - várias corretas: lista de letras originais, sem repetição e em ordem;
// - numérica: { numero: texto como o aluno digitou };
// - resposta curta e dissertativa: { texto }.
// Resposta de formato errado para o tipo vale como em branco.
//
// gradedAnswers[] (contrato C3 do P3): { questionNumber, type, studentChoice (texto ou
// null, só escolha única), studentChoices (lista), studentResponse (texto ou null),
// correctAnswer, correctAnswers, isCorrect (true | false | null quando aguarda o
// professor), pointsEarned, pointsPossible, pending, annulled, annulmentMode }. Ninguém
// supõe letra: o texto da resposta sai de describeAnswer.

const QUESTION_TYPES = Object.freeze(['multiple_choice', 'multiple_answer', 'true_false', 'numeric', 'short_answer', 'essay']);
const CHOICE_TYPES = new Set(['multiple_choice', 'multiple_answer', 'true_false']);
const SINGLE_CHOICE_TYPES = new Set(['multiple_choice', 'true_false']);
const TEXT_TYPES = new Set(['short_answer', 'essay']);
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

// Tamanho máximo da resposta digitada, por tipo (D5). O navegador recebe o número para
// mostrar o contador; o servidor descarta o que passar dele.
const ANSWER_LIMITS = Object.freeze({ numeric: 32, short_answer: 300, essay: 10000 });
const MAX_CHOICES = 8;
const DEFAULT_POINTS = 1;

function questionType(question) {
    const type = typeof question?.type === 'string' ? question.type.trim() : '';
    return QUESTION_TYPES.includes(type) ? type : 'multiple_choice';
}

function isChoiceType(type) {
    return CHOICE_TYPES.has(type);
}

function isSingleChoiceType(type) {
    return SINGLE_CHOICE_TYPES.has(type);
}

function roundPoints(value) {
    return Math.round(Number(value) * 100) / 100;
}

// Pontos da questão: número de 0,1 a 100 gravado pelo modelo (questionModel.js). Registro
// antigo ou estranho (sem points, zero, negativo, texto) vale 1 ponto, como sempre valeu.
function questionPoints(question) {
    const raw = question?.points;
    const value = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() ? Number(raw) : NaN);
    return Number.isFinite(value) && value > 0 && value <= 100 ? roundPoints(value) : DEFAULT_POINTS;
}

function alternativeList(question) {
    if (Array.isArray(question?.alternatives)) return question.alternatives;
    return Object.entries(question?.alternatives || {}).map(([letter, text]) => ({ letter, text }));
}

function alternativeLetter(alternative, index) {
    const letter = alternative && typeof alternative === 'object' ? alternative.letter : null;
    return String(letter || LETTERS[index] || '').trim().toUpperCase();
}

function alternativeLetters(question) {
    return alternativeList(question).map((alternative, index) => alternativeLetter(alternative, index)).filter(Boolean);
}

// Letra correta das questões de escolha única (o correctAnswerFor de sempre).
function correctLetterFor(question) {
    if (question?.correctAnswer) return String(question.correctAnswer).toUpperCase();
    const alternative = alternativeList(question).find(item => item?.isCorrect === true);
    return alternative?.letter ? String(alternative.letter).toUpperCase() : '';
}

// Letras corretas de 'várias corretas': as alternativas marcadas (é o que vai no snapshot
// da aplicação) ou, sem marca, a lista correctAnswers.
function correctLettersFor(question) {
    const alternatives = alternativeList(question);
    const marked = alternatives
        .map((alternative, index) => (alternative?.isCorrect === true ? alternativeLetter(alternative, index) : ''))
        .filter(Boolean);
    const source = marked.length
        ? marked
        : (Array.isArray(question?.correctAnswers) ? question.correctAnswers.map(letter => String(letter || '').trim().toUpperCase()) : []);
    return [...new Set(source.filter(letter => /^[A-Z]$/.test(letter)))].sort();
}

// Texto para comparar respostas curtas: sem maiúsculas, sem acentos e sem espaços extras.
function normalizeShortAnswer(value) {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Número digitado pelo aluno ('3,5', '3.5', '0.125', '-2', '1.234,5', '3,5 ms'). A
// unidade da questão no fim é ignorada; qualquer outra coisa não é número (null).
// Regra dos separadores, a mesma do valor que o professor digita (questionModel.js
// parseNumberInput aceita um separador só, ponto ou vírgula, como decimal):
// - um separador só, uma vez ('0.125', '2,5', '1.234'): é a casa decimal. Antes um ponto
//   seguido de três dígitos virava milhar e '0.125' valia 125;
// - ponto e vírgula juntos ('1.234,5' ou '1,234.5'): o último é a casa decimal e o outro
//   separa os milhares, em grupos de três;
// - o mesmo separador repetido ('1.234.567'): milhares, sem casa decimal.
function parseNumericAnswer(raw, unit = '') {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (typeof raw !== 'string') return null;
    let text = raw.trim().replace(/\u2212/g, '-');
    const cleanUnit = typeof unit === 'string' ? unit.trim() : '';
    if (cleanUnit) text = text.replace(new RegExp(`\\s*${escapeRegExp(cleanUnit)}$`, 'i'), '').trim();
    text = text.replace(/\s+/g, '');
    if (!text) return null;
    const dots = (text.match(/\./g) || []).length;
    const commas = (text.match(/,/g) || []).length;
    if (dots && commas) {
        const decimal = text.lastIndexOf('.') > text.lastIndexOf(',') ? '.' : ',';
        const thousands = decimal === '.' ? ',' : '.';
        const [whole, fraction, extra] = text.split(decimal);
        if (extra !== undefined || !fraction || !/^\d+$/.test(fraction)) return null;
        const grouped = new RegExp(`^[+-]?\\d{1,3}(?:\\${thousands}\\d{3})+$`);
        if (!grouped.test(whole)) return null;
        text = `${whole.split(thousands).join('')}.${fraction}`;
    } else if (dots > 1 || commas > 1) {
        const separator = dots > 1 ? '.' : ',';
        const grouped = new RegExp(`^[+-]?\\d{1,3}(?:\\${separator}\\d{3})+$`);
        if (!grouped.test(text)) return null;
        text = text.split(separator).join('');
    } else {
        text = text.replace(',', '.');
    }
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Resposta guardada no formato do tipo (ou null quando está em branco ou no formato
// errado). Valores vindos do navegador passam antes por decodeStudentAnswers; aqui é a
// segunda barreira (estado antigo, entrega reconstruída, chamada direta).
function normalizeStoredAnswer(question, raw) {
    const type = questionType(question);
    if (raw === null || raw === undefined || raw === '') return null;
    if (isSingleChoiceType(type)) {
        if (typeof raw !== 'string') return null;
        const letter = raw.trim().toUpperCase();
        return letter || null;
    }
    if (type === 'multiple_answer') {
        if (!Array.isArray(raw)) return null;
        const letters = raw.map(item => (typeof item === 'string' ? item.trim().toUpperCase() : '')).filter(Boolean);
        if (!letters.length || letters.length !== raw.length) return null;
        const unique = [...new Set(letters)].sort();
        return unique.length && unique.length <= MAX_CHOICES ? unique : null;
    }
    if (type === 'numeric') {
        const value = isPlainObject(raw) ? raw.numero : raw;
        const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : (typeof value === 'string' ? value.trim() : '');
        return text && text.length <= ANSWER_LIMITS.numeric ? { numero: text } : null;
    }
    // Resposta curta e dissertativa: só { texto }.
    if (!isPlainObject(raw) || typeof raw.texto !== 'string') return null;
    const text = type === 'essay' ? raw.texto.replace(/\s+$/, '') : raw.texto.trim();
    if (!text.trim() || text.length > ANSWER_LIMITS[type]) return null;
    return { texto: text };
}

function hasAnswer(value) {
    if (value === null || value === undefined || value === '') return false;
    if (Array.isArray(value)) return value.length > 0;
    if (isPlainObject(value)) {
        const inner = value.texto ?? value.numero;
        return inner !== null && inner !== undefined && String(inner).trim() !== '';
    }
    return true;
}

// Pontos de 'várias corretas' (P3-B3, padrão sem resposta do Alan): proporcional, cada
// certa marcada soma 1/nCertas, cada errada marcada tira 1/nErradas, nunca abaixo de zero.
// Com partialCredit false é tudo ou nada.
function multipleAnswerFraction(selected, correct, allLetters, partialCredit) {
    const correctSet = new Set(correct);
    const exact = selected.length === correct.length && selected.every(letter => correctSet.has(letter));
    if (exact) return 1;
    if (partialCredit === false) return 0;
    const wrongCount = allLetters.filter(letter => !correctSet.has(letter)).length;
    const hits = selected.filter(letter => correctSet.has(letter)).length;
    const misses = selected.filter(letter => !correctSet.has(letter)).length;
    const fraction = (correct.length ? hits / correct.length : 0) - (wrongCount ? misses / wrongCount : 0);
    return Math.max(0, Math.min(1, fraction));
}

// Pontos lançados pelo professor (correção manual, D8): número de 0 aos pontos da questão.
function manualPoints(manual, possible) {
    if (!manual || typeof manual !== 'object') return null;
    const raw = manual.pontos;
    const value = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() ? Number(raw.replace(',', '.')) : NaN);
    if (!Number.isFinite(value)) return null;
    return roundPoints(Math.max(0, Math.min(possible, value)));
}

// Corretor de uma questão (D4). answer: a resposta guardada (letra, lista ou objeto).
// options.annulment: a anulação da aplicação ({ mode }); options.manual: o item da
// correção do professor ({ pontos }), que vale por cima da conta automática.
// Devolve { pointsEarned, pointsPossible, isCorrect (true|false|null), pending }.
function scoreQuestion(question, answer, { annulment = null, manual = null } = {}) {
    const type = questionType(question);
    const points = questionPoints(question);
    const normalized = normalizeStoredAnswer(question, answer);
    if (annulment?.mode === 'remover_do_total') {
        return { pointsEarned: 0, pointsPossible: 0, isCorrect: false, pending: false };
    }
    if (annulment?.mode === 'ponto_para_todos') {
        return { pointsEarned: points, pointsPossible: points, isCorrect: true, pending: false };
    }
    const fromTeacher = manualPoints(manual, points);
    if (fromTeacher !== null) {
        return { pointsEarned: fromTeacher, pointsPossible: points, isCorrect: fromTeacher >= points, pending: false };
    }
    const result = (earned, isCorrect, pending = false) => ({
        pointsEarned: roundPoints(earned),
        pointsPossible: points,
        isCorrect,
        pending,
    });
    if (isSingleChoiceType(type)) {
        const correct = correctLetterFor(question);
        const right = !!correct && normalized === correct;
        return result(right ? points : 0, right);
    }
    if (type === 'multiple_answer') {
        const correct = correctLettersFor(question);
        if (!correct.length || !normalized) return result(0, false);
        const letters = alternativeLetters(question);
        const valid = new Set(letters);
        const selected = normalized.filter(letter => valid.has(letter));
        if (!selected.length) return result(0, false);
        const fraction = multipleAnswerFraction(selected, correct, letters, question?.partialCredit);
        return result(points * fraction, fraction === 1);
    }
    const review = question?.review === 'professor';
    if (type === 'numeric') {
        const expected = Number(question?.numeric?.value);
        const tolerance = Math.max(0, Number(question?.numeric?.tolerance) || 0);
        if (!normalized) return result(0, false);
        const value = parseNumericAnswer(normalized.numero, question?.numeric?.unit || '');
        const right = value !== null && Number.isFinite(expected)
            && Math.abs(value - expected) <= tolerance + 1e-9 * Math.max(1, Math.abs(expected));
        if (right) return result(points, true);
        return review ? result(0, null, true) : result(0, false);
    }
    if (type === 'short_answer') {
        if (!normalized) return result(0, false);
        const typed = normalizeShortAnswer(normalized.texto);
        const accepted = (Array.isArray(question?.acceptedAnswers) ? question.acceptedAnswers : []).map(normalizeShortAnswer).filter(Boolean);
        const right = !!typed && accepted.includes(typed);
        if (right) return result(points, true);
        return review ? result(0, null, true) : result(0, false);
    }
    // Dissertativa: em branco vale zero sem esperar o professor; escrita aguarda a correção.
    if (!normalized) return result(0, false);
    return result(0, null, true);
}

// Linha de gradedAnswers de uma questão (contrato C3).
function gradedAnswerFor(question, number, answer, { annulment = null, manual = null } = {}) {
    const type = questionType(question);
    const normalized = normalizeStoredAnswer(question, answer);
    const scored = scoreQuestion(question, normalized, { annulment, manual });
    const single = isSingleChoiceType(type);
    const correctAnswers = type === 'multiple_answer' ? correctLettersFor(question) : [];
    return {
        questionNumber: number,
        type,
        studentChoice: single ? normalized : null,
        studentChoices: type === 'multiple_answer' && normalized ? normalized : [],
        studentResponse: type === 'numeric' && normalized
            ? normalized.numero
            : (TEXT_TYPES.has(type) && normalized ? normalized.texto : null),
        // Leitores antigos comparam studentChoice com correctAnswer (letra): nos outros
        // tipos os dois ficam vazios e o gabarito vai em correctAnswers ou na questão.
        correctAnswer: single ? correctLetterFor(question) : null,
        correctAnswers,
        isCorrect: scored.isCorrect,
        pointsEarned: scored.pointsEarned,
        pointsPossible: scored.pointsPossible,
        pending: scored.pending,
        annulled: !!annulment,
        annulmentMode: annulment?.mode || null,
    };
}

// Resposta guardada a partir de uma linha de gradedAnswers (recorreção, reabertura e
// comparação com o envio do navegador). Entrega antiga só tem studentChoice.
function answerFromGraded(graded) {
    if (!graded || typeof graded !== 'object') return null;
    if (Array.isArray(graded.studentChoices) && graded.studentChoices.length) {
        return graded.studentChoices.map(letter => String(letter).toUpperCase()).sort();
    }
    if (graded.studentResponse !== null && graded.studentResponse !== undefined && String(graded.studentResponse) !== '') {
        return graded.type === 'numeric' ? { numero: String(graded.studentResponse) } : { texto: String(graded.studentResponse) };
    }
    if (graded.studentChoice) return String(graded.studentChoice).toUpperCase();
    return null;
}

function answersFromGradedAnswers(gradedAnswers) {
    const answers = {};
    (Array.isArray(gradedAnswers) ? gradedAnswers : []).forEach(item => {
        const number = Number(item?.questionNumber);
        const answer = answerFromGraded(item);
        if (Number.isFinite(number) && answer !== null) answers[number] = answer;
    });
    return answers;
}

// A questão foi respondida (gradedAnswers novo ou antigo).
function isAnswered(graded) {
    return answerFromGraded(graded) !== null;
}

// Forma canônica de uma resposta guardada, para comparar duas (letra em maiúscula, lista
// em ordem, texto como está).
function answerFingerprint(value) {
    if (!hasAnswer(value)) return '';
    if (Array.isArray(value)) return `L:${value.map(item => String(item).toUpperCase()).sort().join(',')}`;
    if (isPlainObject(value)) {
        if (value.numero !== undefined) return `N:${String(value.numero).trim()}`;
        return `T:${String(value.texto ?? '')}`;
    }
    return `C:${String(value).trim().toUpperCase()}`;
}

// Número da resposta com vírgula, sem arredondar: '0.125' digitado aparece '0,125' (antes
// o arredondamento dos pontos, em duas casas, mostrava '0,13').
function formatNumberBR(value) {
    if (!Number.isFinite(value)) return '';
    return String(value).replace('.', ',');
}

function joinLetters(letters) {
    const list = letters.filter(Boolean);
    if (list.length <= 1) return list.join('');
    return `${list.slice(0, -1).join(', ')} e ${list[list.length - 1]}`;
}

// Texto da resposta do aluno (contrato C3): 'B', 'A e C', '3,5 ms', o texto da resposta
// curta ou 'Resposta escrita'. As letras são as de gradedAnswer: quem quer a letra que o
// aluno viu passa a linha já convertida (submissionWithSeenLetters). Em branco: options.blank.
function describeAnswer(question, gradedAnswer, { blank = '' } = {}) {
    const type = gradedAnswer?.type && QUESTION_TYPES.includes(gradedAnswer.type) ? gradedAnswer.type : questionType(question);
    const answer = answerFromGraded({ ...(gradedAnswer || {}), type });
    if (answer === null) return blank;
    if (Array.isArray(answer)) return joinLetters(answer);
    if (isPlainObject(answer)) {
        if (type === 'numeric') {
            const value = parseNumericAnswer(answer.numero, question?.numeric?.unit || '');
            const unit = typeof question?.numeric?.unit === 'string' ? question.numeric.unit.trim() : '';
            const shown = value === null ? String(answer.numero) : formatNumberBR(value);
            return unit && value !== null ? `${shown} ${unit}` : shown;
        }
        if (type === 'essay') return 'Resposta escrita';
        return String(answer.texto);
    }
    return String(answer);
}

module.exports = {
    ANSWER_LIMITS,
    DEFAULT_POINTS,
    MAX_CHOICES,
    QUESTION_TYPES,
    alternativeLetters,
    answerFingerprint,
    answerFromGraded,
    answersFromGradedAnswers,
    correctLetterFor,
    correctLettersFor,
    describeAnswer,
    gradedAnswerFor,
    hasAnswer,
    isAnswered,
    isChoiceType,
    isSingleChoiceType,
    normalizeShortAnswer,
    normalizeStoredAnswer,
    parseNumericAnswer,
    questionPoints,
    questionType,
    roundPoints,
    scoreQuestion,
};
