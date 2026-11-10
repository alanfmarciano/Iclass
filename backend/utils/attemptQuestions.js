// Sigilo da prova: questões que podem ir ao navegador do aluno.
// O aluno só recebe enunciados e alternativas da PRÓPRIA tentativa e só depois que
// ela começou de fato (aplicação em andamento, token validado quando exigido e
// tentativa iniciada). Nunca vão o gabarito (correctAnswer/isCorrect/answerKey) nem
// as outras versões da prova. Aplicação apenas preparada, pausada ou encerrada não
// envia questões.
// As alternativas vão só com o identificador opaco e o texto, na ordem da versão do
// aluno (AVA-05, utils/examAnswerIds.js): a letra original (a do gabarito) e a letra
// impressa (displayLetter) não saem do servidor; o aluno vê a letra da posição.
const crypto = require('crypto');
const { questionNumber, questionsForAttempt } = require('./examGrading.js');
const { answerIdScope, studentAlternatives } = require('./examAnswerIds.js');

const CLOSED_ATTEMPT_STATUSES = new Set(['submitted', 'expired', 'invalidated']);
const LEGACY_BLOCKED_CONFIG_STATUSES = new Set(['draft', 'prepared', 'paused', 'finished', 'cancelled']);

function attemptQuestionsAvailable({ application, onlineConfig, state, now = Date.now() } = {}) {
    if (!state || !Number(state.startedAt)) return false;
    if (CLOSED_ATTEMPT_STATUSES.has(state.status)) return false;
    if (Number(state.deadlineAt) > 0 && now > Number(state.deadlineAt)) return false;

    if (application) {
        if (state.applicationId && state.applicationId !== application.id) return false;
        const inProgress = application.status === 'running'
            || (application.status === 'waiting' && Number(application.startsAt || 0) <= now);
        if (!inProgress) return false;
        if (application.tokenEnabled === true && state.tokenValidated !== true) return false;
        return true;
    }

    // Estado legado, sem aplicação identificada: vale a configuração da turma.
    if (!onlineConfig || onlineConfig.onlineActive !== true) return false;
    if (LEGACY_BLOCKED_CONFIG_STATUSES.has(onlineConfig.status)) return false;
    const startTime = Number(onlineConfig.startTime);
    if (!(startTime > 0 && now >= startTime)) return false;
    const requiresToken = !!onlineConfig.accessToken || !!onlineConfig.accessTokenHash || onlineConfig.tokenEnabled === true;
    if (requiresToken && state.tokenValidated !== true) return false;
    return true;
}

// Lista do que o aluno pode ver de cada questão (lista branca: campo novo no
// snapshot não vaza por acidente). scope: escopo dos identificadores das alternativas
// (a aplicação; answerIdScope).
function studentQuestion(question, index, scope) {
    const number = questionNumber(question, index);
    const text = typeof question?.text === 'string' && question.text
        ? question.text
        : (typeof question?.questionText === 'string' ? question.questionText : '');
    const examNumber = Number(question?.examNumber);
    return {
        originalNumber: number,
        examNumber: Number.isFinite(examNumber) && examNumber > 0 ? examNumber : index + 1,
        text,
        questionText: text,
        isAdditional: question?.isAdditional === true,
        replacedQuestionNumber: question?.replacedQuestionNumber ? Number(question.replacedQuestionNumber) : null,
        alternatives: studentAlternatives({ ...question, originalNumber: number }, scope, index)
            .map(alternative => ({ id: alternative.id, letter: alternative.letter, text: String(alternative.text ?? '') })),
    };
}

// Questões da versão sorteada para a tentativa, na ordem atribuída, e uma impressão
// digital (questionsVersion) para o cliente não precisar recebê-las a cada sync.
function questionsForStudentAttempt({ application, onlineConfig, state, evaluation } = {}) {
    const resolved = questionsForAttempt({ application, onlineConfig, state, evaluation });
    const scope = answerIdScope({ application, onlineConfig, examKey: state?.examKey || application?.examKey || '' });
    const questions = resolved.questions.map((question, index) => studentQuestion(question, index, scope));
    const questionsVersion = crypto.createHash('sha256').update(JSON.stringify(questions)).digest('hex').slice(0, 16);
    return { questions, questionsVersion };
}

module.exports = {
    attemptQuestionsAvailable,
    questionsForStudentAttempt,
    studentQuestion,
};
