const crypto = require('crypto');

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

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

function gradeAttempt({ application, onlineConfig, state, evaluation, answers = {} } = {}) {
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
        return {
            questionNumber: number,
            studentChoice,
            correctAnswer,
            isCorrect,
            annulled: !!annulment,
            annulmentMode: annulment?.mode || null,
        };
    });
    const score = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 100;
    const examSnapshot = resolved.snapshot ? clone({
        version: resolved.snapshot.version || resolved.assignedVersion,
        examCode: resolved.snapshot.examCode || null,
        questions: resolved.questions,
    }) : null;
    return {
        score,
        correctCount,
        totalCount,
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
        gradedAnswers: grade.gradedAnswers,
        assignedVersion: grade.assignedVersion,
        activeHistoryId: application?.historyId || onlineConfig?.activeHistoryId || null,
        examSnapshot: grade.examSnapshot,
        examConfigVersion: application?.contentVersion || onlineConfig?.updatedAt || state?.examConfigVersion || null,
        attemptNumber: state?.attemptNumber || previousAttempts.length + 1,
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
// muda, a anterior fica em submission.scoreHistory com o motivo (AVA-08).
function regradeSubmission({ submission, application, onlineConfig, evaluation, reason = '', by = '' } = {}) {
    const existing = Array.isArray(submission?.gradedAnswers) ? submission.gradedAnswers : [];
    const answers = Object.fromEntries(existing
        .filter(answer => answer?.studentChoice)
        .map(answer => [Number(answer.questionNumber), answer.studentChoice]));
    const state = {
        assignedVersion: submission?.assignedVersion || 'A',
        assignedQuestionNumbers: existing.map(answer => Number(answer.questionNumber)).filter(Number.isFinite),
    };
    const grade = gradeAttempt({ application, onlineConfig, state, evaluation, answers });
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
