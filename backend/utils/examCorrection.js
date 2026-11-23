// Correção do professor numa entrega de prova (fase 3, P3-S4a: AVA-07; D7 e D8 do
// desenho do P3). Funções puras sobre a entrega e as questões dela; quem grava, confere
// o escopo e audita é backend/routes/adminCorrections.js.
//
// submission.correcao = {
//   situacao: 'pendente' | 'concluida',
//   versao: int (sobe a cada gravação; conflito de duas abas é 409 correction_conflict),
//   itens: { [questionNumber]: { pontos?, comentario?, rubrica?: { [criterioId]: pontos },
//            motivo?, por, em } },
//   comentarioGeral, concluidaPor, concluidaEm
// }
// Os pontos de um item valem por cima da conta automática da questão (examScoring
// manual), na recorreção também. A questão que espera o professor (dissertativa
// respondida; resposta curta ou numérica "revisar" que não bateu) recebe os pontos aqui;
// a questão corrigida pelo sistema também pode ser ajustada, sempre com motivo
// (grade_item_override). A nota sai de examGrading (regradeFromOwnSnapshot): pontos
// obtidos / possíveis, as anulações da aplicação valendo.
const {
    answerFromGraded,
    describeAnswer,
    questionPoints,
    questionType,
    roundPoints,
    scoreQuestion,
} = require('./examScoring.js');
const { newCorrection, questionNumber } = require('./examGrading.js');
const { seenAlternativeLetter, seenLetterFor } = require('./examAnswerIds.js');
const { isAwaitingCorrection } = require('./submissionAttempts.js');

const CORRECTION_COMMENT_MAX = 2000;
const CORRECTION_GENERAL_MAX = 3000;
const CORRECTION_REASON_MAX = 500;
const CORRECTION_REASON_MIN = 3;
const MAX_ITEMS = 200;

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function correctionOf(submission) {
    return isPlainObject(submission?.correcao) ? submission.correcao : null;
}

function itemsOf(correcao) {
    return correcao && isPlainObject(correcao.itens) ? correcao.itens : {};
}

function itemFor(correcao, number) {
    const items = itemsOf(correcao);
    const item = items[String(number)];
    return isPlainObject(item) ? item : null;
}

function finiteNumber(value) {
    return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
}

function formatPoints(value) {
    return String(roundPoints(Number(value) || 0)).replace('.', ',');
}

// Questões da entrega por número: as que ela guardou (examSnapshot); entrega antiga sem
// snapshot, as da avaliação.
function submissionQuestions(submission, evaluation) {
    const own = Array.isArray(submission?.examSnapshot?.questions) ? submission.examSnapshot.questions : [];
    const source = own.length ? own : (Array.isArray(evaluation?.questions) ? evaluation.questions : []);
    return new Map(source.map((question, index) => [questionNumber(question, index), question]));
}

function annulmentsOf(application, onlineConfig) {
    const list = Array.isArray(application?.annulledQuestions)
        ? application.annulledQuestions
        : (Array.isArray(onlineConfig?.annulledQuestions) ? onlineConfig.annulledQuestions : []);
    return new Map(list.map(entry => [Number(entry.questionNumber), entry]));
}

// Conta automática da questão (sem os pontos do professor): o que o sistema daria.
function automaticScore(question, graded, annulment, onPaper = false) {
    return scoreQuestion(question || {}, answerFromGraded(graded || {}), { annulment: annulment || null, onPaper });
}

function rubricOf(question) {
    return (Array.isArray(question?.rubric) ? question.rubric : [])
        .filter(item => isPlainObject(item) && String(item.id || '').trim())
        .map(item => ({ id: String(item.id).trim(), nome: String(item.nome || ''), pontos: Number(item.pontos) || 0 }));
}

function alternativesOf(question) {
    return Array.isArray(question?.alternatives)
        ? question.alternatives
        : Object.entries(question?.alternatives || {}).map(([letter, text]) => ({ letter, text }));
}

// Linhas das questões da entrega para a tela Corrigir (GET .../correction): resposta do
// aluno, gabarito, pontos possíveis, rubrica, resposta esperada, a conta automática e o
// item da correção. withAnswerKey: a conta pode ler o gabarito (page.exams ou page.results).
function correctionQuestionRows(submission, { application = null, onlineConfig = null, evaluation = null, withAnswerKey = true } = {}) {
    const graded = Array.isArray(submission?.gradedAnswers) ? submission.gradedAnswers : [];
    const questions = submissionQuestions(submission, evaluation);
    const annulments = annulmentsOf(application, onlineConfig);
    const correcao = correctionOf(submission);
    const onPaper = submission?.answersOnPaper === true;
    return graded.map((answer, index) => {
        const number = Number(answer?.questionNumber);
        const question = questions.get(number) || null;
        const type = answer?.type || questionType(question);
        const annulment = annulments.get(number) || null;
        const auto = automaticScore(question, { ...answer, type }, annulment, onPaper);
        const alternatives = alternativesOf(question);
        const seen = letter => seenLetterFor(submission, { alternatives }, letter);
        const seenAnswer = {
            ...answer,
            type,
            studentChoice: answer?.studentChoice ? seen(String(answer.studentChoice).toUpperCase()) : null,
            studentChoices: Array.isArray(answer?.studentChoices) ? answer.studentChoices.map(letter => seen(String(letter).toUpperCase())).sort() : [],
        };
        const item = itemFor(correcao, number);
        const row = {
            position: index + 1,
            questionNumber: number,
            type,
            text: question ? String(question.text || question.questionText || '') : '',
            points: finiteNumber(answer?.pointsPossible) ?? (question ? questionPoints(question) : 1),
            answerText: describeAnswer(question, seenAnswer, { blank: '' }),
            studentResponse: answer?.studentResponse != null ? String(answer.studentResponse) : null,
            studentChoices: seenAnswer.studentChoices,
            annulled: !!annulment,
            annulmentMode: annulment ? annulment.mode || null : null,
            automatico: { pointsEarned: auto.pointsEarned, pointsPossible: auto.pointsPossible, isCorrect: auto.isCorrect, pending: auto.pending },
            precisaDoProfessor: auto.pending === true,
            pointsEarned: finiteNumber(answer?.pointsEarned),
            pending: answer?.pending === true,
            item: item ? {
                ...(finiteNumber(item.pontos) !== null ? { pontos: Number(item.pontos) } : {}),
                comentario: typeof item.comentario === 'string' ? item.comentario : '',
                ...(isPlainObject(item.rubrica) ? { rubrica: { ...item.rubrica } } : {}),
                ...(item.motivo ? { motivo: String(item.motivo) } : {}),
                por: item.por || null,
                em: item.em || null,
            } : null,
            alternatives: alternatives.map((alternative, altIndex) => {
                const canonical = String(alternative?.letter || String.fromCharCode(65 + altIndex)).toUpperCase();
                return {
                    letter: seenAlternativeLetter(submission, alternative, altIndex),
                    canonicalLetter: canonical,
                    text: alternative?.text ?? alternative?.label ?? String(alternative),
                };
            }),
        };
        if (withAnswerKey && question) {
            row.correctAnswerSeen = answer?.correctAnswer ? seen(String(answer.correctAnswer).toUpperCase()) : null;
            row.correctAnswersSeen = (Array.isArray(answer?.correctAnswers) ? answer.correctAnswers : []).map(letter => seen(String(letter).toUpperCase())).sort();
            if (isPlainObject(question.numeric)) row.numeric = { ...question.numeric };
            if (Array.isArray(question.acceptedAnswers)) row.acceptedAnswers = [...question.acceptedAnswers];
            if (typeof question.expectedAnswer === 'string' && question.expectedAnswer) row.expectedAnswer = question.expectedAnswer;
            const rubric = rubricOf(question);
            if (rubric.length) row.rubric = rubric;
            if (typeof question.explanation === 'string' && question.explanation) row.explanation = question.explanation;
        }
        return row;
    });
}

function refusal(status, error, extra = {}) {
    return { ok: false, status, body: { success: false, error, ...extra } };
}

function numbersLabel(numbers) {
    const list = numbers.map(String);
    if (list.length <= 1) return list.join('');
    return `${list.slice(0, -1).join(', ')} e ${list[list.length - 1]}`;
}

// Confere e aplica um pedido de correção na entrega (sem gravar). input (já validado no
// tipo pelo schema da rota): { versao, itens: { [n]: { pontos, comentario, rubrica,
// motivo } }, comentarioGeral, concluir, motivo }. Devolve { ok: false, status, body } sem
// mudar nada, ou { ok: true, changes, completing, correcao } com a correção nova já na
// entrega (a nota ainda não: quem recorrige é a rota, por regradeFromOwnSnapshot).
// changes: [{ number, kind: 'manual' | 'override' | 'comment', from, to, reason }].
function applyCorrectionInput(submission, input, { application = null, onlineConfig = null, evaluation = null, actor = '', now = Date.now() } = {}) {
    const graded = Array.isArray(submission?.gradedAnswers) ? submission.gradedAnswers : [];
    if (!graded.length) {
        return refusal(409, 'Esta nota foi lançada sem as respostas da prova: não há questões para corrigir. Para mudar a nota, lance outra tentativa em Resultados.', { code: 'correction_without_answers' });
    }
    const current = correctionOf(submission);
    const currentVersion = current && Number.isInteger(current.versao) ? current.versao : 0;
    if (Number(input.versao) !== currentVersion) {
        return refusal(409, 'Esta correção foi alterada em outra tela enquanto você corrigia. Recarregue para ver a versão atual antes de gravar.', { code: 'correction_conflict', versao: currentVersion });
    }
    const questions = submissionQuestions(submission, evaluation);
    const annulments = annulmentsOf(application, onlineConfig);
    const onPaper = submission?.answersOnPaper === true;
    const gradedByNumber = new Map(graded.map(answer => [Number(answer?.questionNumber), answer]));
    const topReason = String(input.motivo || '').trim().slice(0, CORRECTION_REASON_MAX);
    const nextItems = { ...itemsOf(current) };
    const changes = [];
    const rawItems = isPlainObject(input.itens) ? input.itens : {};
    for (const [key, raw] of Object.entries(rawItems)) {
        const number = Number(key);
        const answer = gradedByNumber.get(number);
        if (!Number.isInteger(number) || !answer) {
            return refusal(400, `A questão ${key} não faz parte desta entrega.`, { field: `itens.${key}` });
        }
        const question = questions.get(number) || null;
        const type = answer.type || questionType(question);
        const annulment = annulments.get(number) || null;
        const auto = automaticScore(question, { ...answer, type }, annulment, onPaper);
        const possible = finiteNumber(answer.pointsPossible) ?? auto.pointsPossible;
        if (raw === null) {
            // Item apagado: a questão volta para a conta automática (ou a esperar o professor).
            const previous = nextItems[String(number)];
            if (previous) {
                delete nextItems[String(number)];
                const previousPoints = finiteNumber(previous.pontos);
                changes.push(previousPoints === null
                    ? { number, kind: 'comment', from: null, to: null, possible, reason: '' }
                    : {
                        number,
                        kind: auto.pending === true ? 'manual' : 'override',
                        from: previousPoints,
                        to: auto.pending === true ? null : auto.pointsEarned,
                        possible,
                        reason: topReason,
                    });
            }
            continue;
        }
        const previous = isPlainObject(nextItems[String(number)]) ? nextItems[String(number)] : null;
        const next = { ...(previous || {}) };
        // Rubrica: cada critério de 0 aos pontos dele; os pontos da questão são a soma.
        const rubric = rubricOf(question);
        let rubricTotal = null;
        if (raw.rubrica !== undefined && raw.rubrica !== null) {
            if (!rubric.length) return refusal(400, `A questão ${number} não tem rubrica.`, { field: `itens.${key}.rubrica` });
            const byId = new Map(rubric.map(item => [item.id, item]));
            const scores = {};
            for (const [criterionId, value] of Object.entries(raw.rubrica)) {
                const criterion = byId.get(criterionId);
                if (!criterion) return refusal(400, `A questão ${number} não tem o critério "${criterionId}".`, { field: `itens.${key}.rubrica.${criterionId}` });
                const points = Number(value);
                if (!Number.isFinite(points) || points < 0 || points > criterion.pontos + 1e-9) {
                    return refusal(400, `Questão ${number}, critério "${criterion.nome || criterion.id}": de 0 a ${formatPoints(criterion.pontos)} pontos.`, { field: `itens.${key}.rubrica.${criterionId}` });
                }
                scores[criterionId] = roundPoints(points);
            }
            rubricTotal = roundPoints(Object.values(scores).reduce((sum, value) => sum + value, 0));
            next.rubrica = scores;
        }
        let points = raw.pontos === undefined ? undefined : (raw.pontos === null ? null : Number(raw.pontos));
        if (points === undefined && rubricTotal !== null) points = rubricTotal;
        if (points !== undefined && points !== null) {
            if (!Number.isFinite(points) || points < 0) return refusal(400, `Questão ${number}: os pontos precisam ser um número a partir de 0.`, { field: `itens.${key}.pontos` });
            if (points > possible + 1e-9) {
                return refusal(400, `Questão ${number}: no máximo ${formatPoints(possible)} ${possible === 1 ? 'ponto' : 'pontos'}.`, { field: `itens.${key}.pontos` });
            }
            points = roundPoints(points);
            if (rubricTotal !== null && Math.abs(points - rubricTotal) > 1e-9) {
                return refusal(400, `Questão ${number}: a soma dos critérios da rubrica (${formatPoints(rubricTotal)}) não bate com os pontos (${formatPoints(points)}).`, { field: `itens.${key}.pontos` });
            }
            if (annulment) return refusal(400, `A questão ${number} está anulada: os pontos dela não mudam pela correção.`, { field: `itens.${key}.pontos` });
        }
        if (raw.comentario !== undefined) next.comentario = String(raw.comentario || '').slice(0, CORRECTION_COMMENT_MAX);
        const itemReason = String(raw.motivo || '').trim().slice(0, CORRECTION_REASON_MAX) || topReason;
        const previousPoints = previous ? finiteNumber(previous.pontos) : null;
        if (points === null) {
            delete next.pontos;
            delete next.motivo;
        } else if (points !== undefined) {
            const overridesSystem = auto.pending !== true;
            if (overridesSystem && Math.abs(points - auto.pointsEarned) < 1e-9) {
                // Os mesmos pontos da conta automática numa questão que o sistema corrige:
                // nada a guardar (o gabarito corrigido depois continua valendo para ela).
                delete next.pontos;
                delete next.motivo;
            } else {
                if (overridesSystem && itemReason.length < CORRECTION_REASON_MIN) {
                    return refusal(400, `Informe o motivo para mudar os pontos da questão ${number}, que o sistema corrigiu pelo gabarito.`, { code: 'reason_required', field: `itens.${key}.motivo` });
                }
                next.pontos = points;
                if (overridesSystem) next.motivo = itemReason;
                else if (raw.motivo !== undefined) next.motivo = itemReason;
            }
        }
        const newPoints = finiteNumber(next.pontos);
        const pointsChanged = previousPoints !== newPoints;
        const commentChanged = String(previous?.comentario || '') !== String(next.comentario || '')
            || JSON.stringify(previous?.rubrica || null) !== JSON.stringify(next.rubrica || null);
        if (!pointsChanged && !commentChanged) continue;
        next.por = actor || 'professor';
        next.em = now;
        const empty = finiteNumber(next.pontos) === null && !String(next.comentario || '').trim() && !isPlainObject(next.rubrica);
        if (empty) delete nextItems[String(number)];
        else nextItems[String(number)] = next;
        if (pointsChanged) {
            changes.push({
                number,
                kind: auto.pending === true ? 'manual' : 'override',
                from: previousPoints !== null ? previousPoints : (auto.pending === true ? null : auto.pointsEarned),
                to: newPoints !== null ? newPoints : (auto.pending === true ? null : auto.pointsEarned),
                possible,
                reason: next.motivo || topReason,
            });
        } else {
            changes.push({ number, kind: 'comment', from: newPoints, to: newPoints, possible, reason: '' });
        }
    }

    const nextGeneral = input.comentarioGeral === undefined
        ? String(current?.comentarioGeral || '')
        : String(input.comentarioGeral || '').slice(0, CORRECTION_GENERAL_MAX);
    const generalChanged = nextGeneral !== String(current?.comentarioGeral || '');

    // Questões que, depois deste pedido, ainda esperam o professor sem pontos lançados.
    const missing = graded
        .map(answer => Number(answer?.questionNumber))
        .filter(number => {
            const answer = gradedByNumber.get(number);
            const question = questions.get(number) || null;
            const auto = automaticScore(question, { ...answer, type: answer.type || questionType(question) }, annulments.get(number) || null, onPaper);
            return auto.pending === true && finiteNumber(nextItems[String(number)]?.pontos) === null;
        });
    // Concluir: toda questão que espera o professor precisa ter os pontos (também quando a
    // correção já estava concluída e o pedido apaga os pontos de uma delas).
    if (input.concluir === true && missing.length) {
        return refusal(400, missing.length === 1
            ? `Falta lançar os pontos da questão ${missing[0]} para concluir a correção.`
            : `Falta lançar os pontos das questões ${numbersLabel(missing)} para concluir a correção.`, { code: 'correction_incomplete', missing });
    }
    const completing = input.concluir === true && (!current || current.situacao !== 'concluida');
    if (!changes.length && !generalChanged && !completing) {
        return { ok: true, unchanged: true, changes: [], completing: false, reopened: false, correcao: current };
    }
    // Entrega sem correção ainda: nasce pendente se espera o professor; senão (ajuste de
    // questão objetiva numa entrega já corrigida pelo sistema), já concluída.
    const base = current ? { ...current } : newCorrection();
    if (!current && !isAwaitingCorrection(submission)) base.situacao = 'concluida';
    const correcao = {
        ...base,
        itens: nextItems,
        comentarioGeral: nextGeneral,
        versao: currentVersion + 1,
    };
    let reopened = false;
    if (completing) {
        correcao.situacao = 'concluida';
        correcao.concluidaPor = actor || 'professor';
        correcao.concluidaEm = now;
        delete correcao.concluidaPeloSistema;
    } else if (missing.length && correcao.situacao !== 'pendente') {
        // Os pontos de uma questão que espera o professor foram apagados numa correção já
        // concluída: ela volta a aguardar a correção (a nota sai das médias e o aluno não
        // vê a parcial das objetivas) até o professor concluir de novo (D7).
        correcao.situacao = 'pendente';
        correcao.reabertaEm = now;
        correcao.reabertaPor = actor || 'professor';
        reopened = true;
    }
    return { ok: true, unchanged: false, changes, completing, reopened, generalChanged, correcao };
}

// Questões que esperam o professor numa entrega (para a fila): pela conta automática.
function pendingQuestionNumbers(submission, { application = null, onlineConfig = null, evaluation = null } = {}) {
    const graded = Array.isArray(submission?.gradedAnswers) ? submission.gradedAnswers : [];
    const questions = submissionQuestions(submission, evaluation);
    const annulments = annulmentsOf(application, onlineConfig);
    const correcao = correctionOf(submission);
    const onPaper = submission?.answersOnPaper === true;
    return graded
        .filter(answer => {
            const number = Number(answer?.questionNumber);
            const question = questions.get(number) || null;
            const auto = automaticScore(question, { ...answer, type: answer?.type || questionType(question) }, annulments.get(number) || null, onPaper);
            return auto.pending === true && finiteNumber(itemFor(correcao, number)?.pontos) === null;
        })
        .map(answer => Number(answer.questionNumber));
}

module.exports = {
    CORRECTION_COMMENT_MAX,
    CORRECTION_GENERAL_MAX,
    CORRECTION_REASON_MAX,
    MAX_ITEMS,
    applyCorrectionInput,
    correctionOf,
    correctionQuestionRows,
    formatPoints,
    pendingQuestionNumbers,
};
