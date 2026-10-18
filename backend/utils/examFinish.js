// Encerramento de uma aplicação de prova online com a decisão do professor sobre as
// tentativas em andamento: "salvar" vira entrega com as respostas salvas e
// "desconsiderar" não gera entrega. O Monitor, o controle antigo por turma e o
// "Resetar sala" passam todos por aqui: nenhuma aplicação com prova em andamento é
// encerrada em silêncio, descartando respostas (AVA-04, CONF-X3).
const crypto = require('crypto');
const { filterStudentExamAttempts } = require('./examAttempts.js');
const { createSubmissionFromAttempt } = require('./examGrading.js');
const {
    ACTIVE_APPLICATION_STATUSES,
    CLOSED_ATTEMPT_STATUSES,
    applicationToOnlineConfig,
    checkExamApplicationTransition,
    listExamApplications,
    transitionExamApplication,
} = require('./examApplications.js');
const { isAttemptPastDeadline, settleExpiredAttempts } = require('./examDeadline.js');

const IN_PROGRESS_POLICIES = new Set(['submit', 'discard']);
// Aplicação que ocupa a prova na turma: preparada (ainda sem alunos) ou em andamento.
const OPEN_APPLICATION_STATUSES = new Set(['prepared', ...ACTIVE_APPLICATION_STATUSES]);

const ACTIVE_APPLICATION_MESSAGE = 'Há uma aplicação em andamento desta prova nesta turma; encerre-a pelo Monitor antes de preparar outra.';

function normalizedEmail(value) {
    return String(value || '').trim().toLowerCase();
}

// Tentativas ainda sem entrega (inclui as vencidas: elas nunca ficam de fora).
function applicationStateEntries(memory, applicationId) {
    return Object.entries(memory?.studentExamState || {}).filter(([, state]) =>
        state && state.applicationId === applicationId && !CLOSED_ATTEMPT_STATUSES.has(state.status));
}

function finishSummary(memory, application, now = Date.now()) {
    const entries = applicationStateEntries(memory, application.id);
    const started = entries.filter(([, state]) => !!state.startedAt);
    // Tempo esgotado: a entrega é automática com as respostas salvas, em qualquer escolha.
    const timeOver = started.filter(([, state]) => isAttemptPastDeadline(state, application, now));
    const inProgress = started.filter(entry => !timeOver.includes(entry));
    return {
        applicationId: application.id,
        inProgressAttempts: inProgress.length,
        answeredQuestions: inProgress.reduce((total, [, state]) => total + Object.keys(state.answers || {}).length, 0),
        waitingToStart: entries.length - started.length,
        timeOverAttempts: timeOver.length,
        students: inProgress.map(([, state]) => ({
            email: state.studentEmail,
            answeredQuestions: Object.keys(state.answers || {}).length,
            attemptNumber: state.attemptNumber || 1,
        })),
    };
}

function recordExamAudit(memory, type, application, actor, details = {}) {
    if (!Array.isArray(memory.auditLogs)) memory.auditLogs = [];
    memory.auditLogs.push({
        id: `audit_exam_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        type,
        actor,
        applicationId: application.id,
        examKey: application.examKey,
        studentClass: application.studentClass,
        courseId: application.courseId || null,
        details,
        timestamp: new Date().toISOString(),
    });
}

// Aplicações da mesma prova e turma com um dos status informados (mais nova primeiro).
function classExamApplications(memory, { studentClass, courseId, examKey, statuses }) {
    return listExamApplications(memory?.examApplications, { studentClass, courseId, examKey, statuses: [...statuses] });
}

// Aplicação em andamento (sala de espera, rodando ou pausada) da prova na turma.
function activeExamApplication(memory, scope) {
    return classExamApplications(memory, { ...scope, statuses: ACTIVE_APPLICATION_STATUSES })[0] || null;
}

// Resposta 409 padrão quando uma aplicação em andamento impede a operação.
function activeApplicationConflict(application, message = ACTIVE_APPLICATION_MESSAGE) {
    return {
        error: message,
        activeApplication: true,
        activeApplicationId: application.id,
        activeApplicationStatus: application.status,
    };
}

// Gera a entrega ("salvar") ou registra o descarte ("desconsiderar") das tentativas
// em andamento de uma aplicação que vai ser encerrada. Sem decisão e com alguém
// fazendo a prova, nada muda e o erro traz o resumo para o professor escolher.
function resolveInProgressAttempts(memory, { application, onlineConfig = null, policy, actor, reason = null, now = Date.now() } = {}) {
    const summary = finishSummary(memory, application, now);
    if (summary.inProgressAttempts > 0 && !IN_PROGRESS_POLICIES.has(policy)) {
        throw Object.assign(new Error('Escolha se as respostas em andamento devem ser salvas ou desconsideradas.'), {
            status: 409,
            requiresInProgressPolicy: true,
            summary,
        });
    }
    // Quem já estava sem tempo recebe a entrega automática do fim do tempo
    // (respostas salvas), qualquer que seja a escolha para quem está em andamento.
    const deliveredAtDeadline = settleExpiredAttempts(memory, { applicationId: application.id, graceMs: 0, now }).finalized.length;
    const entries = applicationStateEntries(memory, application.id);
    if (!Array.isArray(memory.submissions)) memory.submissions = [];
    let submitted = 0;
    let discarded = 0;
    let discardedAttempts = [];
    if (policy === 'submit') {
        for (const [, state] of entries) {
            if (!state.startedAt) continue;
            const duplicate = memory.submissions.some(item => item?.attemptId && item.attemptId === state.attemptId);
            if (duplicate) continue;
            const student = (memory.students || []).find(item =>
                normalizedEmail(item?.email) === normalizedEmail(state.studentEmail))
                || { email: state.studentEmail, name: state.studentEmail };
            const previousAttempts = filterStudentExamAttempts(memory.submissions, {
                studentEmail: state.studentEmail,
                examKey: application.examKey,
                courseId: application.courseId,
                applicationId: application.id,
            });
            const submission = createSubmissionFromAttempt({
                application,
                onlineConfig,
                state,
                evaluation: memory.evaluations?.[application.examKey],
                student,
                answers: state.answers || {},
                previousAttempts,
                source: 'instructor_finish',
            });
            submission.autoSubmittedByInstructor = true;
            submission.finishPolicy = 'submit';
            memory.submissions.push(submission);
            submitted += 1;
        }
    } else if (policy === 'discard') {
        discarded = summary.inProgressAttempts;
        // Quem de fato tinha tentativa em andamento desconsiderada: só esses alunos
        // veem "o professor desconsiderou" ao abrir a prova depois.
        discardedAttempts = entries
            .filter(([, state]) => !!state.startedAt)
            .map(([, state]) => ({
                studentEmail: normalizedEmail(state.studentEmail),
                attemptId: state.attemptId || state.id || null,
            }));
    }
    entries.forEach(([key]) => { delete memory.studentExamState[key]; });
    const processed = { policy: policy || 'none', submitted, discarded, deliveredAtDeadline, summary };
    // Uma segunda resolução (sobras de tentativa numa aplicação já encerrada) nunca
    // apaga a decisão do primeiro encerramento: ela fica guardada no histórico.
    if (application.finishResolution) {
        application.previousFinishResolutions = [
            ...(Array.isArray(application.previousFinishResolutions) ? application.previousFinishResolutions : []),
            application.finishResolution,
        ];
    }
    application.finishResolution = {
        policy: processed.policy,
        submitted,
        discarded,
        deliveredAtDeadline,
        ...(policy === 'discard' ? { discardedAttempts } : {}),
        ...(reason ? { reason } : {}),
        at: new Date(now).toISOString(),
        by: actor,
    };
    recordExamAudit(memory, 'exam_application_finished', application, actor, reason ? { ...processed, reason } : processed);
    return processed;
}

// Reflete o status da aplicação na turma (configuração online, item liberado e prova
// ativa). Não mexe na configuração quando ela já pertence a outra aplicação.
function syncClassWithApplication(cls, application) {
    if (!cls || !application) return;
    if (!cls.onlineExamConfigs) cls.onlineExamConfigs = {};
    if (!cls.releasedItems) cls.releasedItems = {};
    const current = cls.onlineExamConfigs[application.examKey] || {};
    if (current.applicationId && current.applicationId !== application.id) return;
    cls.onlineExamConfigs[application.examKey] = applicationToOnlineConfig(application, current);
    const active = ACTIVE_APPLICATION_STATUSES.has(application.status);
    cls.releasedItems[application.examKey] = active;
    cls.activeExamKey = active ? application.examKey : (cls.activeExamKey === application.examKey ? null : cls.activeExamKey);
    cls.activeApplicationId = active ? application.id : (cls.activeApplicationId === application.id ? null : cls.activeApplicationId);
}

const CLOSING_STATUSES = new Set(['finished', 'cancelled']);

// O que uma ação de controle (Monitor ou controle antigo por turma) faz com as
// tentativas. A transição é conferida ANTES de mexer em qualquer coisa: ação
// impossível lança o erro e nada muda. Repetir o encerramento de uma aplicação já
// encerrada, sem tentativa pendente, não muda nada (unchanged): a decisão gravada no
// primeiro encerramento fica. resolve diz se as tentativas precisam ser resolvidas.
function planControlAction(memory, application, action) {
    const check = checkExamApplicationTransition(application, action);
    const closing = CLOSING_STATUSES.has(check.target);
    const pending = closing ? applicationStateEntries(memory, application.id).length : 0;
    if (closing && check.unchanged && pending === 0) return { ...check, closing, resolve: false, unchanged: true };
    const resolve = closing && (
        (check.target === 'finished' && !check.unchanged)
        || ACTIVE_APPLICATION_STATUSES.has(application.status)
        || pending > 0
    );
    return { ...check, closing, resolve, unchanged: false };
}

// Encerra de vez uma aplicação em andamento: resolve as tentativas (com a política
// informada) e muda o status para "finished".
function finishApplication(memory, { application, cls, policy, actor, reason = null, now = Date.now() } = {}) {
    const plan = planControlAction(memory, application, 'finish');
    if (plan.unchanged) return null;
    const processed = resolveInProgressAttempts(memory, {
        application,
        onlineConfig: cls?.onlineExamConfigs?.[application.examKey] || null,
        policy,
        actor,
        reason,
        now,
    });
    transitionExamApplication(application, 'finished', { actor, now });
    syncClassWithApplication(cls, application);
    return processed;
}

module.exports = {
    ACTIVE_APPLICATION_MESSAGE,
    IN_PROGRESS_POLICIES,
    OPEN_APPLICATION_STATUSES,
    activeApplicationConflict,
    activeExamApplication,
    applicationStateEntries,
    classExamApplications,
    finishApplication,
    finishSummary,
    planControlAction,
    recordExamAudit,
    resolveInProgressAttempts,
    syncClassWithApplication,
};
