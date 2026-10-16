// Fim do tempo das tentativas de prova online.
// Regra: uma tentativa vencida nunca é recriada, sobrescrita nem ganha prazo novo.
// Quando o prazo passa sem envio, o servidor finaliza a tentativa com as últimas
// respostas salvas ("entregue automaticamente no fim do tempo"). O envio automático
// do navegador que chega atrasado (celular sem rede, por exemplo) ainda é aceito
// dentro de uma janela de tolerância, com o atraso registrado para o professor.
const { filterStudentExamAttempts, normalizeMaxAttempts } = require('./examAttempts.js');
const { createSubmissionFromAttempt, gradeAttempt } = require('./examGrading.js');
const {
    ACTIVE_APPLICATION_STATUSES,
    CLOSED_ATTEMPT_STATUSES,
    extendDeadlineByPauses,
    findExamApplication,
} = require('./examApplications.js');

// Atraso normal de rede/relógio no envio do fim do tempo: aceito sem marcação. É
// também o único atraso aceito no envio MANUAL (o aluno apertou "Enviar" antes do
// zero e a requisição chegou um pouco depois).
const LATE_FLAG_THRESHOLD_MS = 5 * 1000;
// Tempo que o servidor espera depois do prazo antes de finalizar sozinho a tentativa:
// no caso comum o próprio navegador entrega as respostas congeladas no zero.
const AUTO_SUBMIT_GRACE_MS = 30 * 1000;
// Janela para o envio AUTOMÁTICO do navegador que chega depois do prazo. Depois dela
// vale a finalização do servidor com as últimas respostas salvas.
const LATE_AUTO_SUBMIT_TOLERANCE_MS = 10 * 60 * 1000;
const SERVER_FINALIZE_DELAY_MS = AUTO_SUBMIT_GRACE_MS;
const SERVER_DEADLINE_SOURCE = 'deadline_server_auto_submit';
const CLIENT_TIMER_SOURCE = 'timer_auto_submit';

function normalizedEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function countAnswers(answers) {
    return Object.values(answers && typeof answers === 'object' ? answers : {})
        .filter(value => value !== null && value !== undefined && value !== '').length;
}

// Prazo efetivo da tentativa: início + duração + ajustes (turma, aluno e tempo de
// acessibilidade) + pausas da aplicação. É a mesma conta em todas as rotas.
function computeAttemptDeadline({ application = null, onlineConfig = null, state, now = Date.now() } = {}) {
    const startedAt = Number(state?.startedAt);
    if (!(startedAt > 0)) return null;
    const source = application || onlineConfig || {};
    if (source.timerEnabled === false) return null;
    const duration = Number(source.durationMinutes || 0);
    if (!(duration > 0)) return null;
    const adjustment = Number(source.globalTimeAdjustment || 0)
        + Number(state.individualTimeAdjustment || 0)
        + Number(state.accessibilityExtraMinutes || 0);
    const base = startedAt + Math.max(0, duration + adjustment) * 60000;
    return application ? extendDeadlineByPauses(application, startedAt, base, now) : base;
}

function attemptOverdueMs(state, application, now = Date.now()) {
    const deadlineAt = computeAttemptDeadline({ application, state, now });
    return { deadlineAt, overdueMs: deadlineAt == null ? null : now - deadlineAt };
}

function isAttemptPastDeadline(state, application, now = Date.now()) {
    if (!state || !state.startedAt || CLOSED_ATTEMPT_STATUSES.has(state.status)) return false;
    const { overdueMs } = attemptOverdueMs(state, application, now);
    return overdueMs !== null && overdueMs >= 0;
}

function classForApplication(memory, application) {
    return (memory?.classes || []).find(cls => cls
        && cls.name === application.studentClass
        && (!application.courseId || !cls.courseId || cls.courseId === application.courseId)) || null;
}

// Gera a entrega a partir do estado salvo no servidor e encerra a tentativa.
function finalizeAttemptState(memory, { key, state, application, now = Date.now(), deadlineAt = null, source = SERVER_DEADLINE_SOURCE } = {}) {
    if (!Array.isArray(memory.submissions)) memory.submissions = [];
    const email = normalizedEmail(state.studentEmail);
    const attemptId = state.attemptId || state.id || null;
    const alreadyDelivered = attemptId && memory.submissions.some(item => item?.attemptId === attemptId);
    if (alreadyDelivered) {
        if (key && memory.studentExamState) delete memory.studentExamState[key];
        return null;
    }
    const cls = classForApplication(memory, application);
    const student = (memory.students || []).find(item => normalizedEmail(item?.email) === email) || { email, name: email };
    const previousAttempts = filterStudentExamAttempts(memory.submissions, {
        studentEmail: email,
        examKey: application.examKey,
        courseId: application.courseId,
        applicationId: application.id,
    });
    const submission = createSubmissionFromAttempt({
        application,
        onlineConfig: cls?.onlineExamConfigs?.[application.examKey],
        state,
        evaluation: memory.evaluations?.[application.examKey],
        student,
        answers: state.answers || {},
        previousAttempts,
        source,
        now,
    });
    submission.deadlineAt = deadlineAt;
    submission.finalizedByServerAt = new Date(now).toISOString();
    submission.answeredCount = countAnswers(state.answers);
    // Travado por perda de foco no fim do tempo: vale o que estava salvo antes do
    // bloqueio, e o professor vê que a prova terminou bloqueada.
    if (state.focusLocked === true) {
        submission.focusLockedAtDeadline = true;
        submission.focusLockedAt = Number(state.focusLockedAt) || null;
        submission.focusLockReason = state.focusLockReason || '';
    }
    if (state.status === 'expired') submission.recoveredFromExpiredState = true;
    if (!ACTIVE_APPLICATION_STATUSES.has(application.status)) {
        // Tentativa que versões antigas deixaram sem entrega numa aplicação já encerrada:
        // a entrega leva a hora do fim do tempo (não a da recuperação) e fica marcada
        // para o professor conferir em Resultados e no "Precisa de você".
        submission.recoveredAfterFinish = true;
        if (Number(deadlineAt) > 0 && Number(deadlineAt) < now) submission.timestamp = new Date(Number(deadlineAt)).toISOString();
        recordRecoveredAttempt(memory, application, submission, now);
    }
    memory.submissions.push(submission);
    if (key && memory.studentExamState) delete memory.studentExamState[key];
    return submission;
}

function recordRecoveredAttempt(memory, application, submission, now) {
    if (!Array.isArray(memory.auditLogs)) memory.auditLogs = [];
    memory.auditLogs.push({
        id: `audit_exam_${now}_${Math.random().toString(36).slice(2, 10)}`,
        type: 'exam_attempt_recovered_after_finish',
        actor: 'sistema',
        applicationId: application.id,
        examKey: application.examKey,
        studentClass: application.studentClass,
        courseId: application.courseId || null,
        details: {
            studentEmail: submission.student?.email || null,
            attemptId: submission.attemptId || null,
            submissionId: submission.id,
            answeredCount: submission.answeredCount,
            deadlineAt: submission.deadlineAt || null,
        },
        timestamp: new Date(now).toISOString(),
    });
}

function finalizableApplication(application, state) {
    if (!application) return false;
    if (ACTIVE_APPLICATION_STATUSES.has(application.status)) return true;
    // Aplicação já encerrada: só recupera as tentativas vencidas ('expired') que
    // versões antigas deixaram para trás sem entrega, e nunca quando o professor
    // escolheu desconsiderar o que estava em andamento.
    return state?.status === 'expired'
        && application.status === 'finished'
        && application.finishResolution?.policy !== 'discard';
}

// Finaliza as tentativas cujo prazo passou há pelo menos graceMs. Com graceMs 0
// (encerramento, ajuste de tempo, início de tentativa) finaliza na hora.
// Estados 'expired' de versões antigas que voltaram a ter tempo (pausa) reabrem.
function settleExpiredAttempts(memory, { applicationId = null, studentEmail = null, now = Date.now(), graceMs = SERVER_FINALIZE_DELAY_MS } = {}) {
    const result = { finalized: [], changed: false };
    const states = memory?.studentExamState;
    if (!states || typeof states !== 'object') return result;
    const email = studentEmail ? normalizedEmail(studentEmail) : null;
    for (const [key, state] of Object.entries(states)) {
        if (!state || !state.applicationId || CLOSED_ATTEMPT_STATUSES.has(state.status)) continue;
        if (applicationId && state.applicationId !== applicationId) continue;
        if (email && normalizedEmail(state.studentEmail) !== email) continue;
        if (!state.startedAt) continue;
        const application = findExamApplication(memory.examApplications, state.applicationId);
        if (!finalizableApplication(application, state)) continue;
        const legacyExpired = state.status === 'expired';
        const { deadlineAt, overdueMs } = attemptOverdueMs(state, application, now);
        if (overdueMs === null || overdueMs < 0) {
            if (legacyExpired) {
                state.status = 'active';
                result.changed = true;
            }
            continue;
        }
        if (!legacyExpired && overdueMs < Math.max(0, Number(graceMs) || 0)) continue;
        const submission = finalizeAttemptState(memory, { key, state, application, now, deadlineAt });
        result.changed = true;
        if (submission) result.finalized.push(submission);
    }
    return result;
}

// Aluno sem tentativa aberta que já entregou todas as tentativas desta aplicação:
// tempo extra para ele não tem efeito nenhum (o professor precisa saber disso).
function deliveredWithoutAttemptsLeft(memory, application, studentEmail) {
    if (!application) return false;
    const email = normalizedEmail(studentEmail);
    const hasOpenAttempt = Object.values(memory?.studentExamState || {}).some(state => state
        && state.applicationId === application.id
        && normalizedEmail(state.studentEmail) === email
        && !CLOSED_ATTEMPT_STATUSES.has(state.status));
    if (hasOpenAttempt) return false;
    const delivered = filterStudentExamAttempts(memory?.submissions, {
        studentEmail: email,
        examKey: application.examKey,
        courseId: application.courseId,
        applicationId: application.id,
    }).length;
    if (!delivered) return false;
    const maxAttempts = normalizeMaxAttempts(application.maxAttempts);
    return maxAttempts !== null && delivered >= maxAttempts;
}

// Decide se um envio do aluno que chega depois do prazo ainda vale. Manual: só o
// atraso normal de rede/relógio. Automático (respostas congeladas no zero): sem
// marcação até 5 s, marcado com o atraso até a janela de tolerância.
function lateSubmitDecision({ overdueMs, auto = false } = {}) {
    if (overdueMs === null || overdueMs === undefined || overdueMs < 0) return { accept: true, lateMs: 0 };
    if (overdueMs <= LATE_FLAG_THRESHOLD_MS) return { accept: true, lateMs: 0 };
    if (auto === true && overdueMs <= LATE_AUTO_SUBMIT_TOLERANCE_MS) return { accept: true, lateMs: overdueMs };
    return { accept: false, lateMs: overdueMs };
}

function markLateSubmission(submission, { deadlineAt, lateMs } = {}) {
    if (deadlineAt) submission.deadlineAt = deadlineAt;
    if (lateMs > 0) {
        submission.submittedAfterDeadline = true;
        submission.lateBySeconds = Math.round(lateMs / 1000);
    }
    return submission;
}

function sameAnswers(gradedAnswers, answers) {
    const fromSubmission = {};
    (Array.isArray(gradedAnswers) ? gradedAnswers : []).forEach(item => {
        if (item?.studentChoice) fromSubmission[Number(item.questionNumber)] = String(item.studentChoice).toUpperCase();
    });
    const fromClient = {};
    Object.entries(answers || {}).forEach(([number, choice]) => {
        if (choice !== null && choice !== undefined && choice !== '') fromClient[Number(number)] = String(choice).toUpperCase();
    });
    const keys = new Set([...Object.keys(fromSubmission), ...Object.keys(fromClient)]);
    return [...keys].every(number => fromSubmission[number] === fromClient[number]);
}

// O envio automático do navegador (respostas congeladas no zero) substitui a
// finalização do servidor quando chega dentro da janela de tolerância.
function canReplaceServerFinalization(submission, { auto = false, answers, now = Date.now() } = {}) {
    if (!submission || submission.submissionSource !== SERVER_DEADLINE_SOURCE) return false;
    if (auto !== true || submission.gradePublished === true || submission.resultStatus === 'archived') return false;
    // Prova bloqueada por foco no fim do tempo: vale o que estava salvo antes do bloqueio.
    if (submission.focusLockedAtDeadline === true || submission.recoveredAfterFinish === true) return false;
    const deadlineAt = Number(submission.deadlineAt);
    if (!(deadlineAt > 0) || now - deadlineAt > LATE_AUTO_SUBMIT_TOLERANCE_MS) return false;
    return !sameAnswers(submission.gradedAnswers, answers);
}

function replaceServerFinalization(submission, { application, onlineConfig, evaluation, answers, now = Date.now() } = {}) {
    const numbers = Array.isArray(submission.gradedAnswers)
        ? submission.gradedAnswers.map(item => Number(item.questionNumber)).filter(Number.isFinite)
        : null;
    const grade = gradeAttempt({
        application,
        onlineConfig,
        state: { assignedVersion: submission.assignedVersion || 'A', assignedQuestionNumbers: numbers },
        evaluation,
        answers,
    });
    submission.serverFinalization = {
        at: submission.finalizedByServerAt || submission.timestamp || null,
        score: submission.score,
        answeredCount: Number(submission.answeredCount || 0),
    };
    submission.score = grade.score;
    submission.correctCount = grade.correctCount;
    submission.totalCount = grade.totalCount;
    submission.gradedAnswers = grade.gradedAnswers;
    if (grade.examSnapshot) submission.examSnapshot = grade.examSnapshot;
    submission.answeredCount = countAnswers(answers);
    submission.submissionSource = CLIENT_TIMER_SOURCE;
    submission.timestamp = new Date(now).toISOString();
    const lateMs = now - Number(submission.deadlineAt);
    markLateSubmission(submission, { lateMs: lateMs > LATE_FLAG_THRESHOLD_MS ? lateMs : 0 });
    return submission;
}

module.exports = {
    AUTO_SUBMIT_GRACE_MS,
    CLIENT_TIMER_SOURCE,
    LATE_AUTO_SUBMIT_TOLERANCE_MS,
    LATE_FLAG_THRESHOLD_MS,
    SERVER_DEADLINE_SOURCE,
    SERVER_FINALIZE_DELAY_MS,
    attemptOverdueMs,
    canReplaceServerFinalization,
    computeAttemptDeadline,
    countAnswers,
    deliveredWithoutAttemptsLeft,
    finalizeAttemptState,
    isAttemptPastDeadline,
    lateSubmitDecision,
    markLateSubmission,
    replaceServerFinalization,
    settleExpiredAttempts,
};
