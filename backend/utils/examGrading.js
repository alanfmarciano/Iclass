const crypto = require('crypto');
const { answersFromGradedAnswers, correctLetterFor, gradedAnswerFor, roundPoints } = require('./examScoring.js');

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function questionNumber(question, index = 0) {
    return Number(question?.originalNumber || question?.number || index + 1);
}

// Letra correta de uma questão de escolha única (utils/examScoring.js).
function correctAnswerFor(question) {
    return correctLetterFor(question);
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
        return [number, {
            ...(fallback || {}),
            ...question,
            originalNumber: number,
            correctAnswer,
        }];
    }));

    let assignedNumbers = Array.isArray(state?.assignedQuestionNumbers)
        ? state.assignedQuestionNumbers.map(Number).filter(Number.isFinite)
        : [...sourceByNumber.keys()];
    assignedNumbers = [...new Set(assignedNumbers)];

    return {
        assignedVersion,
        snapshot,
        assignedNumbers,
        questions: assignedNumbers.map(number => sourceByNumber.get(number)).filter(Boolean),
    };
}

function annulmentMap(application, onlineConfig) {
    const entries = Array.isArray(application?.annulledQuestions)
        ? application.annulledQuestions
        : (Array.isArray(onlineConfig?.annulledQuestions) ? onlineConfig.annulledQuestions : []);
    return new Map(entries.map(entry => [Number(entry.questionNumber), entry]));
}

// Itens da correção do professor por número da questão (submission.correcao.itens, D8
// do P3): { pontos } vale por cima da conta automática da questão.
function manualItemsMap(manual) {
    if (!manual || typeof manual !== 'object') return new Map();
    const entries = manual instanceof Map ? [...manual.entries()] : Object.entries(manual);
    return new Map(entries
        .filter(([, item]) => item && typeof item === 'object')
        .map(([number, item]) => [Number(number), item])
        .filter(([number]) => Number.isFinite(number)));
}

// Corrige uma tentativa pelo corretor por tipo (utils/examScoring.js, D4 do P3): cada
// questão vale os seus pontos (1 quando não tem) e a nota é round(obtidos / possíveis *
// 100). correctCount e totalCount continuam a contagem de questões (as telas "18/19"),
// com a questão removida do total fora das duas. Com todas valendo 1 ponto a nota é a
// mesma de antes (teste de compatibilidade com o corretor antigo congelado).
// manual: os itens da correção do professor ({ [número]: { pontos } }).
function gradeAttempt({ application, onlineConfig, state, evaluation, answers = {}, manual = null } = {}) {
    const resolved = questionsForAttempt({ application, onlineConfig, state, evaluation });
    const annulled = annulmentMap(application, onlineConfig);
    const manualItems = manualItemsMap(manual);
    const source = answers && typeof answers === 'object' ? answers : {};
    let correctCount = 0;
    let totalCount = 0;
    let pointsEarned = 0;
    let pointsPossible = 0;
    let pendingCount = 0;
    const gradedAnswers = resolved.questions.map(question => {
        const number = Number(question.originalNumber);
        const annulment = annulled.get(number) || null;
        const graded = gradedAnswerFor(question, number, source[number], { annulment, manual: manualItems.get(number) || null });
        if (annulment?.mode !== 'remover_do_total') {
            totalCount += 1;
            if (graded.isCorrect === true) correctCount += 1;
        }
        if (graded.pending) pendingCount += 1;
        pointsEarned += graded.pointsEarned;
        pointsPossible += graded.pointsPossible;
        return graded;
    });
    pointsEarned = roundPoints(pointsEarned);
    pointsPossible = roundPoints(pointsPossible);
    const score = pointsPossible > 0 ? Math.round((pointsEarned / pointsPossible) * 100) : 100;
    const examSnapshot = resolved.snapshot ? clone({
        version: resolved.snapshot.version || resolved.assignedVersion,
        examCode: resolved.snapshot.examCode || null,
        questions: resolved.questions,
    }) : null;
    return {
        score,
        correctCount,
        totalCount,
        pointsEarned,
        pointsPossible,
        pendingCount,
        gradedAnswers,
        assignedVersion: resolved.assignedVersion,
        assignedQuestionNumbers: resolved.assignedNumbers,
        examSnapshot,
    };
}

function createSubmissionFromAttempt({
    application,
    onlineConfig,
    state,
    evaluation,
    student,
    answers,
    previousAttempts = [],
    source = 'student',
    now = Date.now(),
} = {}) {
    const grade = gradeAttempt({ application, onlineConfig, state, evaluation, answers: answers || state?.answers || {} });
    const email = String(state?.studentEmail || student?.email || '').trim().toLowerCase();
    const safeStudent = { ...(student || {}) };
    delete safeStudent.password;
    const normalizedStudent = {
        ...safeStudent,
        name: safeStudent.name || email,
        email,
        studentClass: state?.studentClass || application?.studentClass || safeStudent.studentClass || '',
        courseId: state?.courseId || application?.courseId || safeStudent.courseId || null,
    };
    const previousPolicy = [...previousAttempts].reverse().find(item => item?.aggregationPolicy)?.aggregationPolicy || 'highest';
    const suffix = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${now}_${Math.random().toString(36).slice(2, 9)}`;
    const timestamp = new Date(now).toISOString();
    return {
        id: `sub_${suffix}`,
        student: normalizedStudent,
        examKey: application?.examKey || state?.examKey,
        applicationId: application?.id || state?.applicationId || null,
        attemptId: state?.attemptId || state?.id || null,
        score: grade.score,
        correctCount: grade.correctCount,
        totalCount: grade.totalCount,
        // Pontos da tentativa (D4 do P3): a nota é obtidos / possíveis.
        pointsEarned: grade.pointsEarned,
        pointsPossible: grade.pointsPossible,
        gradedAnswers: grade.gradedAnswers,
        assignedVersion: grade.assignedVersion,
        activeHistoryId: application?.historyId || onlineConfig?.activeHistoryId || null,
        examSnapshot: grade.examSnapshot,
        examConfigVersion: application?.contentVersion || onlineConfig?.updatedAt || state?.examConfigVersion || null,
        attemptNumber: state?.attemptNumber || previousAttempts.length + 1,
        // "+N min" dado a este aluno nesta tentativa (o da aplicação inteira fica nela).
        individualTimeAdjustment: Number(state?.individualTimeAdjustment || 0),
        resultStatus: 'considered',
        aggregationPolicy: previousPolicy,
        selectedForResult: false,
        gradePublished: false,
        submissionSource: source,
        timestamp,
        // Letras que o aluno viu (posição na versão), para as revisões (AVA-05).
        ...(state?.alternativeLabels ? { alternativeLabels: state.alternativeLabels } : {}),
        // Tentativa reaberta pelo "+N min" da turma depois da entrega do fim do tempo:
        // o professor vê que houve reabertura e qual entrega ela substituiu.
        ...(Number(state?.reopenedAt) > 0 ? {
            reopenedAt: new Date(Number(state.reopenedAt)).toISOString(),
            reopenedFrom: clone(Array.isArray(state.reopenedFrom) ? state.reopenedFrom : []),
        } : {}),
    };
}

// Recorrige uma entrega (anulação, correção ou troca de questão). Quando a nota
// muda, a anterior fica em submission.scoreHistory com o motivo (AVA-08). As respostas
// saem de gradedAnswers por tipo (letra, lista de letras, número ou texto) e a correção
// do professor (submission.correcao, D8 do P3) continua valendo: os pontos lançados por
// ele entram por cima da conta automática e o registro da correção não é tocado.
function regradeSubmission({ submission, application, onlineConfig, evaluation, reason = '', by = '' } = {}) {
    const existing = Array.isArray(submission?.gradedAnswers) ? submission.gradedAnswers : [];
    const answers = answersFromGradedAnswers(existing);
    const state = {
        assignedVersion: submission?.assignedVersion || 'A',
        assignedQuestionNumbers: existing.map(answer => Number(answer.questionNumber)).filter(Number.isFinite),
    };
    const manual = submission?.correcao && typeof submission.correcao === 'object' ? submission.correcao.itens : null;
    const grade = gradeAttempt({ application, onlineConfig, state, evaluation, answers, manual });
    const previous = { score: submission.score, correctCount: submission.correctCount, totalCount: submission.totalCount };
    if (previous.score !== grade.score || previous.correctCount !== grade.correctCount || previous.totalCount !== grade.totalCount) {
        if (!Array.isArray(submission.scoreHistory)) submission.scoreHistory = [];
        submission.scoreHistory.push({
            at: new Date().toISOString(),
            from: previous.score ?? null,
            to: grade.score,
            fromCounts: `${previous.correctCount ?? '-'}/${previous.totalCount ?? '-'}`,
            toCounts: `${grade.correctCount}/${grade.totalCount}`,
            reason: reason || 'Recorreção da prova',
            by: by || 'sistema',
        });
    }
    submission.score = grade.score;
    submission.correctCount = grade.correctCount;
    submission.totalCount = grade.totalCount;
    submission.pointsEarned = grade.pointsEarned;
    submission.pointsPossible = grade.pointsPossible;
    submission.gradedAnswers = grade.gradedAnswers;
    submission.examSnapshot = grade.examSnapshot;
    submission.regradedAt = new Date().toISOString();
    return submission;
}

module.exports = {
    correctAnswerFor,
    createSubmissionFromAttempt,
    gradeAttempt,
    questionNumber,
    questionsForAttempt,
    regradeSubmission,
    snapshotForAttempt,
};
