// Corrigir o gabarito de uma aplicação depois da prova (fase 3, P3-S6: AVA-X2; D14 do
// desenho P3). Funções puras, sem banco: a rota POST /api/admin/exam-applications/:id/
// answer-key-correction (routes/adminExamConfig.js) valida o pedido pelo modelo da questão
// (questionModel.normalizeAnswerKey), mostra a prévia do impacto (previewAnswerKeyRegrade),
// troca o gabarito nas versões da aplicação (applyAnswerKey) e recorrige as entregas.
//
// Só o gabarito muda: o enunciado, as alternativas, a ordem de cada versão, os pontos e o
// tipo ficam como os alunos viram. A letra é sempre a ORIGINAL da alternativa (a do
// gabarito e das respostas guardadas), nunca a letra impressa de uma versão embaralhada.
// O gabarito impresso de cada versão (snapshot.answerKey, letra da posição) acompanha.
// A avaliação no editor e o histórico de preparações não mudam (a próxima aplicação sai
// da avaliação, que o professor corrige no editor).
const {
    correctLetterFor,
    correctLettersFor,
    questionType,
} = require('./examScoring.js');
const { questionNumber, regradeSubmission } = require('./examGrading.js');
const { applicationToOnlineConfig } = require('./examApplications.js');

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

// Status em que o gabarito pode ser corrigido: a prova em andamento ou encerrada. Antes de
// começar não há entrega (a questão se corrige no editor); cancelada não vale nota.
const CORRECTABLE_STATUSES = new Set(['waiting', 'running', 'paused', 'finished']);

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function alternativesOf(question) {
    return Array.isArray(question?.alternatives) ? question.alternatives : [];
}

// Letra original da alternativa (a do gabarito e das respostas guardadas).
function originalLetter(alternative, index) {
    return String((alternative && typeof alternative === 'object' && alternative.letter) || LETTERS[index] || '').trim().toUpperCase();
}

function formatNumber(value) {
    return Number.isFinite(Number(value)) ? String(Number(value)).replace('.', ',') : '';
}

function joinWords(list) {
    const items = list.filter(Boolean);
    if (items.length <= 1) return items.join('');
    return `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`;
}

// Gabarito de uma questão aplicada, no formato do tipo dela.
function answerKeyOf(question) {
    const type = questionType(question);
    if (type === 'multiple_choice' || type === 'true_false') return { type, correctAnswer: correctLetterFor(question) };
    if (type === 'multiple_answer') return { type, correctAnswers: correctLettersFor(question) };
    if (type === 'numeric') {
        const numeric = question?.numeric && typeof question.numeric === 'object' ? question.numeric : {};
        return { type, numeric: { value: Number(numeric.value), tolerance: Math.max(0, Number(numeric.tolerance) || 0) } };
    }
    if (type === 'short_answer') return { type, acceptedAnswers: (Array.isArray(question?.acceptedAnswers) ? question.acceptedAnswers : []).map(String) };
    return { type };
}

// Forma de comparar dois gabaritos (a unidade da numérica não é do gabarito).
function canonicalKey(key) {
    const type = key?.type || 'multiple_choice';
    if (type === 'multiple_choice' || type === 'true_false') return { type, correctAnswer: String(key.correctAnswer || '').toUpperCase() };
    if (type === 'multiple_answer') return { type, correctAnswers: [...new Set((key.correctAnswers || []).map(letter => String(letter).toUpperCase()))].sort() };
    if (type === 'numeric') return { type, value: Number(key.numeric?.value), tolerance: Math.max(0, Number(key.numeric?.tolerance) || 0) };
    if (type === 'short_answer') return { type, acceptedAnswers: (key.acceptedAnswers || []).map(String) };
    return { type };
}

function sameAnswerKey(a, b) {
    return JSON.stringify(canonicalKey(a)) === JSON.stringify(canonicalKey(b));
}

// O gabarito em palavras, para a auditoria, o registro da aplicação e a tela ('C · rm',
// 'A e C', 'Verdadeiro', '3,5 ms (tolerância 0,25)', '"máscara" ou "máscara de rede"').
// question: a questão aplicada (para o texto das alternativas e a unidade).
function describeAnswerKey(key, question = null) {
    const type = key?.type || questionType(question);
    const textOf = letter => {
        const index = alternativesOf(question).findIndex((alternative, position) => originalLetter(alternative, position) === letter);
        const text = index >= 0 ? String(alternativesOf(question)[index]?.text || '').replace(/\s+/g, ' ').trim() : '';
        return text.length > 40 ? `${text.slice(0, 39)}…` : text;
    };
    if (type === 'true_false') return key.correctAnswer === 'A' ? 'Verdadeiro' : (key.correctAnswer === 'B' ? 'Falso' : '');
    if (type === 'multiple_choice') {
        const letter = key.correctAnswer || '';
        const text = letter ? textOf(letter) : '';
        return text ? `${letter} · ${text}` : letter;
    }
    if (type === 'multiple_answer') return joinWords(key.correctAnswers || []);
    if (type === 'numeric') {
        const unit = typeof question?.numeric?.unit === 'string' ? question.numeric.unit.trim() : '';
        const value = `${formatNumber(key.numeric?.value)}${unit ? ` ${unit}` : ''}`;
        const tolerance = Number(key.numeric?.tolerance) || 0;
        return tolerance > 0 ? `${value} (tolerância ${formatNumber(tolerance)})` : value;
    }
    if (type === 'short_answer') return (key.acceptedAnswers || []).map(text => `"${text}"`).join(' ou ');
    return '';
}

// Questões da aplicação com o número original pedido, uma por versão.
function applicationQuestions(application, number) {
    const found = [];
    (Array.isArray(application?.versionSnapshots) ? application.versionSnapshots : []).forEach(snapshot => {
        (Array.isArray(snapshot?.questions) ? snapshot.questions : []).forEach((question, index) => {
            if (question && questionNumber(question, index) === Number(number)) found.push({ snapshot, question, index });
        });
    });
    return found;
}

// A questão saiu da prova pela troca do Monitor (replace-question): a nota dela vem da
// questão que entrou no lugar.
function questionWasReplaced(application, number) {
    return (Array.isArray(application?.versionSnapshots) ? application.versionSnapshots : [])
        .some(snapshot => (Array.isArray(snapshot?.questions) ? snapshot.questions : [])
            .some(question => question && question.isAdditional && Number(question.replacedQuestionNumber) === Number(number)));
}

function annulmentOf(application, number) {
    return (Array.isArray(application?.annulledQuestions) ? application.annulledQuestions : [])
        .find(entry => Number(entry?.questionNumber) === Number(number)) || null;
}

// Troca o gabarito da questão em todas as versões da aplicação (muda a aplicação no
// lugar). key: o gabarito validado por normalizeAnswerKey. Devolve quantas versões
// mudaram.
function applyAnswerKey(application, number, key) {
    let updated = 0;
    applicationQuestions(application, number).forEach(({ snapshot, question, index }) => {
        const next = { ...question };
        if (key.type === 'multiple_choice' || key.type === 'true_false' || key.type === 'multiple_answer') {
            const correct = new Set(key.type === 'multiple_answer' ? key.correctAnswers : [key.correctAnswer]);
            next.alternatives = alternativesOf(question).map((alternative, position) => ({
                ...alternative,
                isCorrect: correct.has(originalLetter(alternative, position)),
            }));
            if (key.type === 'multiple_answer') {
                next.correctAnswers = [...key.correctAnswers];
                next.correctAnswer = '';
            } else {
                next.correctAnswer = key.correctAnswer;
                delete next.correctAnswers;
            }
            // Gabarito impresso da versão (letra da posição), como na correção ao vivo.
            if (snapshot.answerKey && typeof snapshot.answerKey === 'object') {
                const position = Number(question.examNumber) > 0 ? Number(question.examNumber) : index + 1;
                const printed = next.alternatives
                    .map((alternative, position2) => (alternative.isCorrect ? String(alternative.displayLetter || LETTERS[position2] || '').toUpperCase() : ''))
                    .filter(Boolean);
                if (printed.length) snapshot.answerKey[position] = printed.join('');
            }
        } else if (key.type === 'numeric') {
            next.numeric = { ...(question.numeric || {}), value: key.numeric.value, tolerance: key.numeric.tolerance };
        } else if (key.type === 'short_answer') {
            next.acceptedAnswers = [...key.acceptedAnswers];
        }
        snapshot.questions[index] = next;
        updated += 1;
    });
    return updated;
}

// Prévia do impacto, sem mudar nada: recorrige cópias das entregas da aplicação com o
// gabarito novo e devolve as que mudam de nota. submissions: as entregas da aplicação;
// onlineConfig: a configuração da turma para a prova (a mesma que a recorreção usa).
function previewAnswerKeyRegrade({ application, submissions = [], onlineConfig = null, evaluation = null, number, key }) {
    const draft = clone(application);
    applyAnswerKey(draft, number, key);
    const draftConfig = applicationToOnlineConfig(draft, clone(onlineConfig) || {});
    const changes = [];
    let regraded = 0;
    (submissions || []).forEach(original => {
        if (!original || original.applicationId !== application.id) return;
        const copy = clone(original);
        regradeSubmission({ submission: copy, application: draft, onlineConfig: draftConfig, evaluation, reason: 'prévia', by: 'prévia' });
        regraded += 1;
        if (copy.score !== original.score || copy.correctCount !== original.correctCount || copy.totalCount !== original.totalCount) {
            changes.push({ submission: original, from: original.score ?? null, to: copy.score });
        }
    });
    return { regraded, changes };
}

// Posição da questão na prova que o aluno fez (a versão dele pode ter outra ordem), para
// o aviso do sino dizer "questão 7" a quem a viu como 7.
function questionPositionInSubmission(submission, number) {
    const questions = Array.isArray(submission?.examSnapshot?.questions) ? submission.examSnapshot.questions : [];
    const index = questions.findIndex((question, position) => questionNumber(question, position) === Number(number));
    if (index >= 0) {
        const examNumber = Number(questions[index]?.examNumber);
        return Number.isInteger(examNumber) && examNumber > 0 ? examNumber : index + 1;
    }
    const graded = Array.isArray(submission?.gradedAnswers) ? submission.gradedAnswers : [];
    const gradedIndex = graded.findIndex(answer => Number(answer?.questionNumber) === Number(number));
    return gradedIndex >= 0 ? gradedIndex + 1 : Number(number);
}

module.exports = {
    CORRECTABLE_STATUSES,
    annulmentOf,
    answerKeyOf,
    applicationQuestions,
    applyAnswerKey,
    describeAnswerKey,
    previewAnswerKeyRegrade,
    questionPositionInSubmission,
    questionWasReplaced,
    sameAnswerKey,
};
