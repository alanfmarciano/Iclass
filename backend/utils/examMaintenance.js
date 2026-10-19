// Manutenção de prova por turma: "Limpar estado de prova" e "Resetar sala" (UXI-02,
// CONF-10, OPS-X3, CONF-X3). As duas ações valem só para a turma escolhida (a limpeza
// também pode ficar em uma aplicação) e nunca apagam os logs de monitoramento nem o
// histórico de digitação: são a evidência das provas. Entregas e notas também não
// são tocadas aqui.
const { ACTIVE_APPLICATION_STATUSES, CLOSED_ATTEMPT_STATUSES } = require('./examApplications.js');
const { finishSummary } = require('./examFinish.js');

function normalized(value) {
    return String(value || '').trim();
}

function normalizedEmail(value) {
    return normalized(value).toLowerCase();
}

function sameClassName(a, b) {
    return normalized(a).toLowerCase() === normalized(b).toLowerCase();
}

function sameCourse(courseId, cls) {
    return !courseId || !cls.courseId || String(courseId) === String(cls.courseId);
}

function applicationBelongsToClass(application, cls) {
    return !!application && sameClassName(application.studentClass, cls.name) && sameCourse(application.courseId, cls);
}

function classApplications(memory, cls) {
    return (Array.isArray(memory?.examApplications) ? memory.examApplications : [])
        .filter(application => applicationBelongsToClass(application, cls))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function applicationSummary(application, examTitle) {
    return {
        id: application.id,
        examKey: application.examKey,
        examTitle: examTitle ? examTitle(application.examKey) : application.examKey,
        status: application.status,
        createdAt: application.createdAt || null,
        startedAt: application.startedAt || null,
        finishedAt: application.finishedAt || null,
    };
}

// Estado de prova (tentativa sem entrega) que pertence à turma. Estados antigos sem
// aplicação e sem turma gravada contam quando a prova é do curso da turma e o aluno
// está matriculado nela.
function stateBelongsToClass(state, cls, classApplicationIds, { courseExamKeys, isClassStudent } = {}) {
    if (!state || typeof state !== 'object') return false;
    if (state.applicationId && classApplicationIds.has(state.applicationId)) return true;
    if (state.applicationId && state.studentClass) return sameClassName(state.studentClass, cls.name) && sameCourse(state.courseId, cls);
    if (state.applicationId) return false;
    if (state.studentClass) return sameClassName(state.studentClass, cls.name) && sameCourse(state.courseId, cls);
    return !!(courseExamKeys && courseExamKeys.has(state.examKey)
        && isClassStudent && isClassStudent(state.studentEmail));
}

function messageBelongsToClass(message, cls) {
    return !!message && sameClassName(message.studentClass, cls.name) && sameCourse(message.courseId, cls);
}

function hasAnswers(state) {
    return Object.values(state?.answers && typeof state.answers === 'object' ? state.answers : {})
        .some(value => value !== null && value !== undefined && value !== '');
}

function evidenceCounts(memory, cls, application, studentEmail, examKey) {
    const inScope = item => item
        && (!studentEmail || normalizedEmail(item.studentEmail) === studentEmail)
        && (!examKey || item.examKey === examKey)
        && (application
            ? (item.applicationId ? item.applicationId === application.id : item.examKey === application.examKey && (!item.studentClass || sameClassName(item.studentClass, cls.name)))
            : (item.studentClass ? sameClassName(item.studentClass, cls.name) : false));
    return {
        proctoringLogs: (memory.proctoringLogs || []).filter(inScope).length,
        keystrokes: (memory.examKeystrokes || []).filter(inScope).length,
    };
}

// O que "Limpar estado de prova" faria na turma (e, opcionalmente, numa aplicação).
// blockedBy lista as aplicações em andamento que impedem a limpeza.
function planExamStateFlush(memory, { cls, application = null, examKey = '', studentEmail = '', courseExamKeys, isClassStudent, examTitle } = {}) {
    const email = normalizedEmail(studentEmail);
    const exam = application ? application.examKey : normalized(examKey);
    const applications = classApplications(memory, cls);
    const applicationIds = new Set(applications.map(item => item.id));
    const scopeApplications = application ? [application] : applications.filter(item => !exam || item.examKey === exam);
    const blockedBy = scopeApplications
        .filter(item => ACTIVE_APPLICATION_STATUSES.has(item.status))
        .map(item => applicationSummary(item, examTitle));
    const stateKeys = Object.entries(memory.studentExamState || {})
        .filter(([, state]) => stateBelongsToClass(state, cls, applicationIds, { courseExamKeys, isClassStudent }))
        .filter(([, state]) => !application
            || state.applicationId === application.id
            || (!state.applicationId && state.examKey === application.examKey))
        .filter(([, state]) => !exam || state.examKey === exam)
        .filter(([, state]) => !email || normalizedEmail(state.studentEmail) === email)
        .map(([key]) => key);
    const pendingAnswers = stateKeys.filter(key => {
        const state = memory.studentExamState[key];
        return !CLOSED_ATTEMPT_STATUSES.has(state.status) && hasAnswers(state);
    }).length;
    const messageIndexes = (memory.broadcastMessages || [])
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => messageBelongsToClass(message, cls))
        .filter(({ message }) => !application
            || message.applicationId === application.id
            || (!message.applicationId && message.examKey && message.examKey === application.examKey))
        .filter(({ message }) => !exam || message.examKey === exam)
        .filter(({ message }) => !email || normalizedEmail(message.targetEmail) === email)
        .map(({ index }) => index);
    return {
        studentClass: cls.name,
        courseId: cls.courseId || null,
        applicationId: application?.id || null,
        examKey: exam || null,
        studentEmail: email || null,
        blockedBy,
        stateKeys,
        messageIndexes,
        counts: {
            examStates: stateKeys.length,
            pendingAnswers,
            messages: messageIndexes.length,
        },
        preserved: evidenceCounts(memory, cls, application, email, exam),
    };
}

function applyExamStateFlush(memory, plan) {
    plan.stateKeys.forEach(key => { delete memory.studentExamState[key]; });
    if (plan.messageIndexes.length) {
        const remove = new Set(plan.messageIndexes);
        memory.broadcastMessages = (memory.broadcastMessages || []).filter((_, index) => !remove.has(index));
    }
    return { removedStates: plan.stateKeys.length, removedMessages: plan.messageIndexes.length };
}

// Alunos da turma que o reset desconecta. A sessão é por e-mail (não por turma): quem
// também está matriculado em outra turma e está fazendo uma prova em andamento lá
// continua conectado, para não perder a prova da outra turma.
function classSessionsToDrop(memory, cls, isClassStudent) {
    const busyElsewhere = new Set();
    const activeElsewhere = new Set((Array.isArray(memory?.examApplications) ? memory.examApplications : [])
        .filter(application => application && ACTIVE_APPLICATION_STATUSES.has(application.status) && !applicationBelongsToClass(application, cls))
        .map(application => application.id));
    Object.values(memory?.studentExamState || {}).forEach(state => {
        if (state && activeElsewhere.has(state.applicationId) && !CLOSED_ATTEMPT_STATUSES.has(state.status)) {
            busyElsewhere.add(normalizedEmail(state.studentEmail));
        }
    });
    const classEmails = Object.keys(memory?.sessions || {}).filter(email => isClassStudent && isClassStudent(email));
    return {
        drop: classEmails.filter(email => !busyElsewhere.has(normalizedEmail(email))),
        keptInOtherExam: classEmails.filter(email => busyElsewhere.has(normalizedEmail(email))),
    };
}

// O que "Resetar sala" faria na turma: encerra as aplicações em andamento salvando
// as respostas, limpa os estados de prova que sobrarem e as mensagens da turma e
// desconecta os alunos matriculados nela.
function planClassReset(memory, { cls, courseExamKeys, isClassStudent, examTitle } = {}) {
    const applications = classApplications(memory, cls);
    const active = applications.filter(item => ACTIVE_APPLICATION_STATUSES.has(item.status));
    const activeIds = new Set(active.map(item => item.id));
    const flush = planExamStateFlush(memory, { cls, courseExamKeys, isClassStudent, examTitle });
    // Os estados das aplicações em andamento viram entrega (ou ficam marcados como vencidos)
    // ao encerrar: só os que sobram contam como "limpos".
    const leftoverStateKeys = flush.stateKeys.filter(key => !activeIds.has(memory.studentExamState[key]?.applicationId));
    const sessions = classSessionsToDrop(memory, cls, isClassStudent);
    const sessionEmails = sessions.drop;
    return {
        studentClass: cls.name,
        courseId: cls.courseId || null,
        activeApplications: active.map(item => {
            const summary = finishSummary(memory, item);
            return {
                ...applicationSummary(item, examTitle),
                inProgressAttempts: summary.inProgressAttempts,
                answeredQuestions: summary.answeredQuestions,
                waitingToStart: summary.instructionsAttempts,
                timeOverAttempts: summary.timeOverAttempts,
            };
        }),
        leftoverStateKeys,
        messageIndexes: flush.messageIndexes,
        sessionEmails,
        counts: {
            activeApplications: active.length,
            inProgressAttempts: active.reduce((total, item) => total + finishSummary(memory, item).inProgressAttempts, 0),
            examStates: leftoverStateKeys.length,
            messages: flush.messageIndexes.length,
            sessions: sessionEmails.length,
            keptInOtherExam: sessions.keptInOtherExam.length,
        },
        preserved: flush.preserved,
    };
}

module.exports = {
    applicationBelongsToClass,
    applicationSummary,
    applyExamStateFlush,
    classApplications,
    classSessionsToDrop,
    planClassReset,
    planExamStateFlush,
    sameClassName,
};
