const crypto = require('crypto');
const { answersFromGradedAnswers, correctLetterFor, gradedAnswerFor, questionPoints, questionType, roundPoints } = require('./examScoring.js');

// Campos que decidem a nota de uma questão: o tipo, os pontos e o gabarito de cada tipo
// (a letra de escolha única e as alternativas marcadas ficam no snapshot desde sempre).
// Numa aplicação eles valem como estavam no snapshot dela, nunca como estão na avaliação
// hoje: editar a avaliação depois de aplicar não muda nota já dada numa recorreção
// (anulação, correção ao vivo, gabarito). Questão de snapshot sem type foi montada antes
// dos tipos (281029f) e é uma correta de 1 ponto, como foi corrigida (D1 do P3).
const GRADING_FIELDS = Object.freeze(['type', 'points', 'correctAnswers', 'partialCredit', 'numeric', 'acceptedAnswers', 'review', 'expectedAnswer', 'rubric']);

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

// Questão da tentativa: a do snapshot por cima da avaliação, mas só o que não decide a
// nota (explicação, metadados) pode vir da avaliação; o tipo, os pontos e o gabarito são
// os do snapshot (GRADING_FIELDS). Sem snapshot, a avaliação é a própria questão.
function attemptQuestion(question, fallback, number) {
    const base = { ...(fallback || {}) };
    if (question !== fallback) GRADING_FIELDS.forEach(field => { delete base[field]; });
    const correctAnswer = correctAnswerFor(question) || correctAnswerFor(fallback);
    return {
        ...base,
        ...question,
        originalNumber: number,
        correctAnswer,
    };
}

// Grava no snapshot das versões o tipo, os pontos e o gabarito de cada questão como
// estão na avaliação agora (exam-history/add: o navegador monta o snapshot só com
// enunciado, alternativas e letra certa). O que o pedido trouxe nesses campos é
// trocado pelo da avaliação: quem decide a correção é o servidor. Muda os snapshots no
// lugar e devolve a mesma lista.
function freezeSnapshotGrading(snapshots, evaluation) {
    const evaluationQuestions = Array.isArray(evaluation?.questions) ? evaluation.questions : [];
    const byNumber = new Map(evaluationQuestions.map((question, index) => [questionNumber(question, index), question]));
    (Array.isArray(snapshots) ? snapshots : []).forEach(snapshot => {
        if (!snapshot || !Array.isArray(snapshot.questions)) return;
        snapshot.questions = snapshot.questions.map((question, index) => {
            if (!question || typeof question !== 'object') return question;
            const source = byNumber.get(questionNumber(question, index)) || null;
            const frozen = { ...question };
            GRADING_FIELDS.forEach(field => { delete frozen[field]; });
            frozen.type = questionType(source);
            frozen.points = questionPoints(source);
            GRADING_FIELDS.forEach(field => {
                if (field === 'type' || field === 'points') return;
                if (source && source[field] !== undefined && source[field] !== null) frozen[field] = clone(source[field]);
            });
            // Questão vinda do banco (P3-S9a): a chave do banco vem da avaliação, não do
            // navegador; é por ela que o banco conta usos e acertos.
            if (source) {
                delete frozen.bankKey;
                if (typeof source.bankKey === 'string' && source.bankKey) frozen.bankKey = source.bankKey;
            }
            return frozen;
        });
    });
    return snapshots;
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
        const fallback = snapshotQuestions.length ? evaluationByNumber.get(number) : question;
        return [number, attemptQuestion(question, fallback, number)];
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
    GRADING_FIELDS,
    attemptQuestion,
    correctAnswerFor,
    freezeSnapshotGrading,
    createSubmissionFromAttempt,
    gradeAttempt,
    questionNumber,
    questionsForAttempt,
    regradeSubmission,
    snapshotForAttempt,
};
