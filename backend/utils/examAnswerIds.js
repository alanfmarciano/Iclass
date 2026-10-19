// Letras e identificadores das alternativas da prova online (AVA-05).
//
// O aluno vê a letra da POSIÇÃO (A, B, C... na ordem em que as alternativas aparecem
// na versão dele) e o navegador nunca recebe a letra original (a do gabarito). Cada
// alternativa vai para o navegador com um identificador opaco: um HMAC da aplicação,
// do número da questão e da letra original, com um segredo que só existe no servidor.
// O identificador é estável (recarga, reinício do servidor) e não revela a letra.
// O servidor converte o identificador para a letra original ao salvar e ao corrigir,
// e as respostas continuam guardadas com a letra original (dados antigos valem).
//
// Respostas com uma letra só (navegador antigo, cópia local antiga, chamadas diretas):
// - tentativa criada a partir desta versão (alternativeLabels = 'position'): a letra é
//   a POSIÇÃO na versão do aluno, a mesma que ele vê;
// - tentativa antiga (sem a marca): a letra é a original, como era antes.
const crypto = require('crypto');
const db = require('../database.js');
const { questionsForAttempt } = require('./examGrading.js');

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const POSITION_LABELS = 'position';
const ANSWER_ID_PATTERN = /^[0-9A-Z]{13}$/;
const SINGLE_LETTER_PATTERN = /^[A-Z]$/;
// Sem a lista de questões da tentativa (registro antigo sem snapshot), no máximo esta
// quantidade de respostas é convertida: cada identificador custa até 26 HMACs.
const MAX_ANSWERS_WITHOUT_QUESTIONS = 200;
// Teto de entradas lidas do objeto de respostas, com ou sem questões (uma prova real tem
// dezenas): o corpo pode ter até 10 MB e centenas de milhares de chaves inventadas; as
// que passam do teto nem são lidas. Resposta é texto curto (letra ou identificador de
// 13 caracteres): valor que não é texto ou é longo demais é descartado sem processar.
const MAX_ANSWER_ENTRIES = 10000;
const MAX_ANSWER_VALUE_LENGTH = 64;

let cachedSecret = null;
let idCache = new Map();

// Segredo do servidor (gerado no boot em database.js; aqui só como garantia).
function answerIdSecret() {
    if (!db.memory.config || typeof db.memory.config !== 'object') db.memory.config = {};
    let secret = db.memory.config.examAnswerSecret;
    if (typeof secret !== 'string' || secret.length < 32) {
        secret = crypto.randomBytes(32).toString('hex');
        db.memory.config.examAnswerSecret = secret;
        db.save();
    }
    if (secret !== cachedSecret) {
        cachedSecret = secret;
        idCache = new Map();
    }
    return secret;
}

// Escopo dos identificadores: a aplicação (ids diferentes a cada aplicação da prova).
function answerIdScope({ application = null, onlineConfig = null, examKey = '' } = {}) {
    const applicationId = application?.id || onlineConfig?.applicationId;
    if (applicationId) return String(applicationId);
    return `legado:${String(examKey || '').trim()}:${onlineConfig?.activeHistoryId || ''}`;
}

function originalLetter(alternative, index) {
    const letter = alternative && typeof alternative === 'object' ? alternative.letter : null;
    return String(letter || LETTERS[index] || '').trim().toUpperCase();
}

function alternativeText(alternative) {
    if (alternative && typeof alternative === 'object') return alternative.text ?? alternative.label ?? '';
    return alternative == null ? '' : String(alternative);
}

function alternativeList(question) {
    if (Array.isArray(question?.alternatives)) return question.alternatives;
    return Object.entries(question?.alternatives || {}).map(([letter, text]) => ({ letter, text }));
}

function questionNumberOf(question, index = 0) {
    return Number(question?.originalNumber ?? question?.number ?? index + 1);
}

function alternativeAnswerId(scope, questionNumber, letter) {
    const secret = answerIdSecret();
    const key = `${scope}|${Number(questionNumber)}|${String(letter).toUpperCase()}`;
    const cached = idCache.get(key);
    if (cached) return cached;
    const digest = crypto.createHmac('sha256', secret).update(key).digest();
    // 64 bits em base 36, maiúsculo: sobrevive ao toUpperCase de navegadores antigos.
    const id = digest.readBigUInt64BE(0).toString(36).toUpperCase().padStart(13, '0');
    if (idCache.size > 100000) idCache = new Map();
    idCache.set(key, id);
    return id;
}

// Alternativas como vão para o navegador do aluno: identificador opaco e texto, na
// ordem da versão. O campo letter repete o identificador para páginas da prova abertas
// antes desta versão (elas respondiam com alt.letter): continuam corrigidas certo.
function studentAlternatives(question, scope, index = 0) {
    const number = questionNumberOf(question, index);
    return alternativeList(question).map((alternative, alternativeIndex) => {
        const id = alternativeAnswerId(scope, number, originalLetter(alternative, alternativeIndex));
        return { id, letter: id, text: alternativeText(alternative) };
    });
}

// Respostas guardadas (letra original) no formato do navegador (identificadores).
function encodeAnswersForStudent(answers, scope) {
    const encoded = {};
    Object.entries(answers && typeof answers === 'object' ? answers : {}).forEach(([number, value]) => {
        const letter = String(value ?? '').trim().toUpperCase();
        if (!SINGLE_LETTER_PATTERN.test(letter)) return;
        encoded[number] = alternativeAnswerId(scope, number, letter);
    });
    return encoded;
}

// Respostas do navegador (identificador, ou letra) convertidas para a letra original.
// questions: questões da tentativa na ordem da versão do aluno (questionsForAttempt).
// positional: a letra avulsa é a posição na versão (tentativas novas) ou a original.
// Só as questões da tentativa contam (a correção ignora as outras): a chave de uma
// questão que não está na tentativa é descartada antes de qualquer HMAC, e milhares de
// chaves inventadas num salvamento não prendem o servidor da sala.
function decodeStudentAnswers(answers, { scope, questions = [], positional = false } = {}) {
    const byNumber = new Map((Array.isArray(questions) ? questions : [])
        .map((question, index) => [questionNumberOf(question, index), question]));
    const decoded = {};
    let unknownQuestionAnswers = 0;
    let examined = 0;
    const source = answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : {};
    const decodeEntry = (key, raw) => {
        if (typeof raw !== 'string' || raw.length > MAX_ANSWER_VALUE_LENGTH) return;
        const number = Number(key);
        if (!Number.isFinite(number)) return;
        const question = byNumber.get(number) || null;
        if (!question) {
            if (byNumber.size) return;
            unknownQuestionAnswers += 1;
            if (unknownQuestionAnswers > MAX_ANSWERS_WITHOUT_QUESTIONS) return;
        }
        const value = raw.trim().toUpperCase();
        if (!value) return;
        const letters = question
            ? alternativeList(question).map((alternative, index) => originalLetter(alternative, index)).filter(Boolean)
            : [];
        if (ANSWER_ID_PATTERN.test(value)) {
            const candidates = letters.length ? letters : LETTERS;
            const match = candidates.find(letter => alternativeAnswerId(scope, number, letter) === value);
            if (match) decoded[String(number)] = match;
            return;
        }
        if (!SINGLE_LETTER_PATTERN.test(value)) return;
        if (!positional) {
            decoded[String(number)] = value;
            return;
        }
        const position = LETTERS.indexOf(value);
        if (position >= 0 && letters[position]) decoded[String(number)] = letters[position];
    };
    for (const key in source) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        examined += 1;
        if (examined > MAX_ANSWER_ENTRIES) break;
        decodeEntry(key, source[key]);
    }
    return decoded;
}

function usesPositionLabels(record) {
    return record?.alternativeLabels === POSITION_LABELS;
}

// Respostas recebidas do navegador para uma tentativa, já com a letra original.
function decodeAttemptAnswers(answers, { application = null, onlineConfig = null, state = null, evaluation = null, examKey = '' } = {}) {
    const { questions } = questionsForAttempt({ application, onlineConfig, state, evaluation });
    return decodeStudentAnswers(answers, {
        scope: answerIdScope({ application, onlineConfig, examKey }),
        questions,
        positional: usesPositionLabels(state),
    });
}

// Estado da tentativa como vai para o aluno: respostas com os identificadores opacos.
function stateForStudent(state, scope) {
    if (!state || typeof state !== 'object') return state;
    return { ...state, answers: encodeAnswersForStudent(state.answers, scope) };
}

// Que letras o aluno viu nas alternativas desta tentativa ou entrega:
// - 'position': tentativa nova, a posição na versão dele;
// - 'original': tentativa online antiga, a letra original (era o que a tela mostrava);
// - 'printed': prova impressa/lançada à mão, a letra impressa (displayLetter).
function alternativeLabelsMode(record) {
    const explicit = record?.alternativeLabels;
    if ([POSITION_LABELS, 'original', 'printed'].includes(explicit)) return explicit;
    if (record && (record.applicationId || record.attemptId || record.startedAt)) return 'original';
    return 'printed';
}

// Letra que o aluno viu em uma alternativa (revisão do professor e do aluno).
function seenAlternativeLetter(record, alternative, index) {
    const canonical = originalLetter(alternative, index);
    const mode = alternativeLabelsMode(record);
    if (mode === POSITION_LABELS) return LETTERS[index] || canonical;
    if (mode === 'original') return canonical;
    const printed = alternative && typeof alternative === 'object' ? alternative.displayLetter : null;
    return String(printed || canonical).toUpperCase();
}

// Converte uma letra original na letra que o aluno viu naquela questão.
function seenLetterFor(record, question, letter) {
    if (letter == null || letter === '') return letter ?? null;
    const target = String(letter).toUpperCase();
    const alternatives = alternativeList(question);
    const index = alternatives.findIndex((alternative, alternativeIndex) => originalLetter(alternative, alternativeIndex) === target);
    return index >= 0 ? seenAlternativeLetter(record, alternatives[index], index) : target;
}

// Entrega com as letras como o aluno viu (gradedAnswers e alternativas do snapshot),
// para a revisão do próprio aluno. Entregas antigas ficam como estão.
function submissionWithSeenLetters(submission) {
    if (!usesPositionLabels(submission)) return submission;
    const questions = Array.isArray(submission?.examSnapshot?.questions) ? submission.examSnapshot.questions : [];
    if (!questions.length) return submission;
    const byNumber = new Map(questions.map((question, index) => [questionNumberOf(question, index), question]));
    return {
        ...submission,
        gradedAnswers: Array.isArray(submission.gradedAnswers)
            ? submission.gradedAnswers.map(answer => {
                const question = byNumber.get(Number(answer?.questionNumber));
                if (!question) return answer;
                return {
                    ...answer,
                    studentChoice: seenLetterFor(submission, question, answer.studentChoice),
                    correctAnswer: seenLetterFor(submission, question, answer.correctAnswer),
                };
            })
            : submission.gradedAnswers,
        examSnapshot: {
            ...submission.examSnapshot,
            questions: questions.map(question => ({
                ...question,
                alternatives: alternativeList(question).map((alternative, index) => ({
                    ...(alternative && typeof alternative === 'object' ? alternative : { text: alternativeText(alternative) }),
                    letter: seenAlternativeLetter(submission, alternative, index),
                })),
            })),
        },
    };
}

module.exports = {
    LETTERS,
    MAX_ANSWER_ENTRIES,
    POSITION_LABELS,
    alternativeAnswerId,
    alternativeLabelsMode,
    answerIdScope,
    answerIdSecret,
    decodeAttemptAnswers,
    decodeStudentAnswers,
    encodeAnswersForStudent,
    seenAlternativeLetter,
    seenLetterFor,
    stateForStudent,
    studentAlternatives,
    submissionWithSeenLetters,
    usesPositionLabels,
};
