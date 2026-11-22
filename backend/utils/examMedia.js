// Imagens das questões de prova (fase 3, P3-S2: UXA-12, AVA-06; decisão D11 e contrato C8
// do desenho P3).
//
// O professor põe a imagem no enunciado, na alternativa ou na explicação pelo editor
// (POST /api/admin/upload-image), e o Markdown da questão cita /uploads/<arquivo>. O
// arquivo fica em data/uploads (vai no backup). Para o aluno, /uploads só sai pela regra
// de sendControlledFile (server.js), e a imagem de questão entra nela por aqui:
// - durante a prova: o arquivo está citado no enunciado ou numa alternativa das questões
//   da tentativa ABERTA dele, já liberada (attemptQuestionsAvailable: aplicação em
//   andamento, token aceito quando exigido, tentativa iniciada e dentro do prazo);
// - depois da prova: o arquivo está citado numa questão de uma entrega dele cujo gabarito
//   ele já pode ver (canStudentViewAnswerKey: nota publicada e gabarito liberado, sem
//   aplicação da mesma prova aberta). Aqui também vale a imagem da explicação.
// Antes do início, numa aplicação pausada ou encerrada, depois da entrega sem gabarito e
// para aluno de outra turma, a imagem é recusada (403), mesmo que o nome seja conhecido:
// a regra não depende de o nome do arquivo ser aleatório.
const db = require('../database.js');
const { referencedUploads } = require('./contentMedia.js');
const { attemptQuestionsAvailable } = require('./attemptQuestions.js');
const { questionsForAttempt } = require('./examGrading.js');

const CLOSED_STATES = new Set(['submitted', 'invalidated']);

function textOf(value) {
    return typeof value === 'string' ? value : '';
}

function alternativeTexts(question) {
    const list = Array.isArray(question?.alternatives)
        ? question.alternatives
        : Object.values(question?.alternatives || {});
    return list.map(alternative => (alternative && typeof alternative === 'object'
        ? textOf(alternative.text ?? alternative.label)
        : textOf(alternative)));
}

// Textos de uma questão que o aluno pode ver na prova (enunciado e alternativas) e, com
// includeAnswerKey, também os que só saem com o gabarito (explicação e resposta esperada).
function questionTexts(question, { includeAnswerKey = false } = {}) {
    if (!question || typeof question !== 'object') return [];
    const texts = [textOf(question.text), textOf(question.questionText), ...alternativeTexts(question)];
    if (includeAnswerKey) texts.push(textOf(question.explanation), textOf(question.expectedAnswer));
    return texts.filter(Boolean);
}

function uploadsInQuestions(questions, options) {
    const names = new Set();
    (Array.isArray(questions) ? questions : []).forEach(question => {
        questionTexts(question, options).forEach(text => referencedUploads(text).forEach(name => names.add(name)));
    });
    return names;
}

// Contrato C8: arquivos de /uploads citados numa avaliação ({ questions }) ou num item do
// banco de questões (a própria questão), em ordem, sem repetição. Serve para quem exporta
// um curso ou o banco levar as imagens junto (CRIT-06).
function referencedExamUploads(evaluationOrBankItem) {
    if (!evaluationOrBankItem || typeof evaluationOrBankItem !== 'object') return [];
    const questions = Array.isArray(evaluationOrBankItem.questions)
        ? evaluationOrBankItem.questions
        : [evaluationOrBankItem];
    return [...uploadsInQuestions(questions, { includeAnswerKey: true })].sort();
}

function normalizedEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function stateBelongsTo(key, state, email) {
    if (normalizedEmail(state?.studentEmail) === email) return true;
    const parts = String(key || '').split('::');
    return parts.length === 3 && normalizedEmail(parts[1]) === email;
}

function classOfApplication(application) {
    return (db.memory.classes || []).find(cls => cls
        && String(cls.name || '').trim() === String(application.studentClass || '').trim()
        && (!application.courseId || !cls.courseId || String(cls.courseId) === String(application.courseId))) || null;
}

// O arquivo está nas questões de uma tentativa aberta e liberada deste aluno?
function uploadInOpenAttempt({ student, email, filename, studentBelongsToClass, now }) {
    const states = Object.entries(db.memory.studentExamState || {})
        .filter(([key, state]) => state && typeof state === 'object'
            && !CLOSED_STATES.has(state.status)
            && Number(state.startedAt) > 0
            && stateBelongsTo(key, state, email));
    for (const [, state] of states) {
        const examKey = String(state.examKey || '').trim();
        const evaluation = db.memory.evaluations?.[examKey] || null;
        const application = state.applicationId
            ? (db.memory.examApplications || []).find(item => item && item.id === state.applicationId) || null
            : null;
        if (state.applicationId && !application) continue;
        const classes = application
            ? [classOfApplication(application)].filter(Boolean)
            : (db.memory.classes || []).filter(cls => cls?.onlineExamConfigs?.[examKey]);
        for (const cls of classes) {
            if (typeof studentBelongsToClass === 'function' && !studentBelongsToClass(student, cls)) continue;
            const onlineConfig = cls?.onlineExamConfigs?.[application?.examKey || examKey] || null;
            if (!attemptQuestionsAvailable({ application, onlineConfig, state, now })) continue;
            const { questions } = questionsForAttempt({ application, onlineConfig, state, evaluation });
            if (uploadsInQuestions(questions).has(filename)) return true;
        }
    }
    return false;
}

// O arquivo está numa questão de uma entrega deste aluno com o gabarito liberado para ele?
function uploadInReleasedAnswerKey({ email, filename, canViewAnswerKey }) {
    if (typeof canViewAnswerKey !== 'function') return false;
    const own = (db.memory.submissions || []).filter(submission => submission
        && submission.gradePublished === true
        && normalizedEmail(submission.student?.email || submission.studentEmail) === email
        && Array.isArray(submission.examSnapshot?.questions));
    for (const submission of own) {
        // Primeiro o que é barato (o arquivo está nesta entrega?), depois a liberação.
        if (!uploadsInQuestions(submission.examSnapshot.questions, { includeAnswerKey: true }).has(filename)) continue;
        if (canViewAnswerKey(submission, email)) return true;
    }
    return false;
}

// Regra D11 para o aluno: imagem de questão citada na tentativa aberta dele ou numa
// entrega dele com o gabarito liberado. student: o cadastro (matrícula da turma).
function studentCanSeeExamUpload({ student, studentEmail, filename, studentBelongsToClass, canViewAnswerKey, now = Date.now() } = {}) {
    const email = normalizedEmail(studentEmail || student?.email);
    const name = String(filename || '');
    if (!email || !name || !student) return false;
    if (uploadInOpenAttempt({ student, email, filename: name, studentBelongsToClass, now })) return true;
    return uploadInReleasedAnswerKey({ email, filename: name, canViewAnswerKey });
}

module.exports = {
    questionTexts,
    referencedExamUploads,
    studentCanSeeExamUpload,
};
