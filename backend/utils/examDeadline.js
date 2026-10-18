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
    examStateKey,
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
// Entregas automáticas do fim do tempo (navegador ou servidor). Só elas podem ser
// reabertas pelo "+N min" da turma; o envio feito pelo próprio aluno nunca.
const DEADLINE_DELIVERY_SOURCES = new Set([CLIENT_TIMER_SOURCE, SERVER_DEADLINE_SOURCE]);
// "+N min" para a turma até 2 min depois do fim do tempo: quem foi entregue
// automaticamente no fim do tempo volta para a mesma tentativa com o prazo novo.
const CLASS_EXTRA_TIME_REOPEN_WINDOW_MS = 2 * 60 * 1000;
// O navegador só envia sozinho quando o cronômetro dele chega a zero, e o cronômetro
// é acertado pelo servidor a cada sincronização (4 s). Um envio "automático" que
// chega com o prazo ainda bem à frente é de uma tela que não viu o tempo extra (o
// professor deu mais tempo, ou reabriu a tentativa): a prova continua.
const AUTO_SUBMIT_EARLY_TOLERANCE_MS = 15 * 1000;

function normalizedEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function countAnswers(answers) {
    return Object.values(answers && typeof answers === 'object' ? answers : {})
        .filter(value => value !== null && value !== undefined && value !== '').length;
}

// Estado da tentativa guardado na entrega automática do fim do tempo, para o "+N min"
// da turma poder reabri-la (sem as respostas, que ficam na própria entrega, e sem a
// chave da cópia local, que é do navegador do aluno).
const REOPEN_STATE_OMITTED_FIELDS = new Set(['answers', 'localCopyKey', 'status', 'timerRemaining', 'submittedAt', 'reopenableState', 'pageExit', 'reopenedDelivery']);

function attemptStateForReopen(state) {
    if (!state || typeof state !== 'object' || !state.startedAt) return null;
    const snapshot = {};
    Object.entries(state).forEach(([field, value]) => {
        if (REOPEN_STATE_OMITTED_FIELDS.has(field) || value === undefined) return;
        snapshot[field] = value == null || typeof value !== 'object' ? value : JSON.parse(JSON.stringify(value));
    });
    return snapshot;
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
    if (ACTIVE_APPLICATION_STATUSES.has(application.status)) {
        const reopenable = attemptStateForReopen(state);
        if (reopenable) submission.reopenableState = reopenable;
    } else {
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

// Hora em que a aplicação deixou de estar em andamento (encerrada ou cancelada).
function applicationClosedAt(application) {
    const candidates = [
        Number(application?.endsAt),
        Date.parse(application?.finishedAt || ''),
        Date.parse(application?.cancelledAt || ''),
    ];
    return candidates.find(value => Number.isFinite(value) && value > 0) || null;
}

// Tentativa sem entrega numa aplicação já encerrada. O código atual resolve todas no
// encerramento; estas são sobras de versões antigas e nunca podem ficar para sempre
// "esperando a entrega automática" no Monitor:
// - o tempo dela acabou antes do encerramento: pela regra atual a entrega automática
//   do fim do tempo vale qualquer que tenha sido a escolha do professor (inclusive
//   "desconsiderar", que só vale para quem ainda estava fazendo a prova);
// - marcada 'expired' por versão antiga com o tempo acabando depois do encerramento:
//   entregue, a menos que o professor tenha desconsiderado o que estava em andamento,
//   e aí ela fica registrada como desconsiderada (estado final, com as respostas);
// - em andamento no encerramento (sem 'expired'): continua esperando a decisão do
//   professor, como antes.
function closedApplicationLeftover(application, state, deadlineAt) {
    if (!application || application.status !== 'finished') return null;
    const closedAt = applicationClosedAt(application);
    if (deadlineAt != null && closedAt != null && deadlineAt <= closedAt) return 'finalize';
    if (state?.status !== 'expired') return null;
    return application.finishResolution?.policy === 'discard' ? 'discard' : 'finalize';
}

function markDiscardedAtFinish(state, now) {
    state.status = 'invalidated';
    state.discardedAtFinish = true;
    state.discardedAt = new Date(now).toISOString();
}

// Finaliza as tentativas cujo prazo passou há pelo menos graceMs. Com graceMs 0
// (encerramento, ajuste de tempo, início de tentativa) finaliza na hora.
// Estados 'expired' de versões antigas que voltaram a ter tempo (pausa) reabrem.
function settleExpiredAttempts(memory, { applicationId = null, studentEmail = null, now = Date.now(), graceMs = SERVER_FINALIZE_DELAY_MS } = {}) {
    const result = { finalized: [], discarded: 0, changed: false };
    const states = memory?.studentExamState;
    if (!states || typeof states !== 'object') return result;
    const email = studentEmail ? normalizedEmail(studentEmail) : null;
    for (const [key, state] of Object.entries(states)) {
        if (!state || !state.applicationId || CLOSED_ATTEMPT_STATUSES.has(state.status)) continue;
        if (applicationId && state.applicationId !== applicationId) continue;
        if (email && normalizedEmail(state.studentEmail) !== email) continue;
        if (!state.startedAt) continue;
        const application = findExamApplication(memory.examApplications, state.applicationId);
        if (!application) continue;
        const legacyExpired = state.status === 'expired';
        const { deadlineAt, overdueMs } = attemptOverdueMs(state, application, now);
        if (!ACTIVE_APPLICATION_STATUSES.has(application.status)) {
            const leftover = closedApplicationLeftover(application, state, deadlineAt);
            if (leftover === 'discard') {
                markDiscardedAtFinish(state, now);
                result.discarded += 1;
                result.changed = true;
            } else if (leftover === 'finalize') {
                const submission = finalizeAttemptState(memory, { key, state, application, now, deadlineAt });
                result.changed = true;
                if (submission) result.finalized.push(submission);
            }
            continue;
        }
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

function openAttemptsInApplication(memory, applicationId, email) {
    return Object.entries(memory?.studentExamState || {}).filter(([, state]) => state
        && state.applicationId === applicationId
        && normalizedEmail(state.studentEmail) === email
        && !CLOSED_ATTEMPT_STATUSES.has(state.status));
}

// Tentativa seguinte que o aluno ainda não começou (tela de instruções, sem resposta):
// per_attempt com 2+ tentativas cria a próxima logo depois da entrega do fim do tempo.
function untouchedNextAttempt(state, delivery) {
    return !!state && !state.startedAt
        && countAnswers(state.answers) === 0
        && Number(state.attemptNumber || 0) > Number(delivery?.attemptNumber || 0);
}

function latestDeliveryByStudent(memory, applicationId) {
    const latest = new Map();
    (Array.isArray(memory?.submissions) ? memory.submissions : []).forEach(item => {
        if (!item || item.applicationId !== applicationId || item.resultStatus === 'invalidated') return;
        const email = normalizedEmail(item.student?.email || item.studentEmail);
        if (!email) return;
        const current = latest.get(email);
        const newer = !current
            || Number(item.attemptNumber || 0) > Number(current.attemptNumber || 0)
            || (Number(item.attemptNumber || 0) === Number(current.attemptNumber || 0)
                && String(item.timestamp || '') > String(current.timestamp || ''));
        if (newer) latest.set(email, item);
    });
    return latest;
}

// Respostas da entrega (letra original por questão), como ficam no estado da tentativa.
function answersFromDelivery(submission) {
    const answers = {};
    (Array.isArray(submission?.gradedAnswers) ? submission.gradedAnswers : []).forEach(item => {
        const number = Number(item?.questionNumber);
        if (Number.isFinite(number) && item.studentChoice) answers[number] = String(item.studentChoice).toUpperCase();
    });
    return answers;
}

// A entrega manual (o aluno apertou "Enviar") só conta como "ficou sem o tempo extra"
// quando o tempo dele já tinha acabado antes do "+N min": no meio da prova, quem já
// enviou não perdeu nada e o professor não precisa de aviso.
function timeEndedBeforeExtra(application, submission, email, { now, extraMinutes }) {
    const collective = application.timerMode !== 'per_attempt' && Number(application.startsAt) > 0;
    if (collective) {
        const before = computeAttemptDeadline({
            application: { ...application, globalTimeAdjustment: Number(application.globalTimeAdjustment || 0) - Number(extraMinutes || 0) },
            state: { startedAt: Number(application.startsAt), individualTimeAdjustment: Number(application.studentAdjustments?.[email] || 0) },
            now,
        });
        if (before !== null) return before <= now;
    }
    const stored = Number(submission?.deadlineAt);
    return stored > 0 && stored <= now;
}

// Cópia da entrega do fim do tempo que a reabertura tira da lista: fica guardada na
// tentativa reaberta para voltar se ela terminar sem entrega nova (o professor
// desconsidera o que estava em andamento ao encerrar). Nunca vai para o aluno.
function archivedDelivery(submission) {
    const copy = JSON.parse(JSON.stringify(submission));
    delete copy.reopenableState;
    return copy;
}

// "+N min" para a turma logo depois do fim do tempo (AVA-03). Chamado depois de somar
// o tempo extra na aplicação: quem foi entregue AUTOMATICAMENTE no fim do tempo (pelo
// navegador ou pelo servidor) há até 2 min volta para a mesma tentativa, com as mesmas
// respostas e o prazo novo. A entrega sai da lista e fica guardada na tentativa
// (reopenedDelivery): uma entrega nova da tentativa a substitui, e o descarte no
// encerramento a devolve (restoreReopenedDelivery), então a entrega que o aluno já tinha
// nunca se perde. Nunca reabre o envio feito pelo próprio aluno, entrega com nota
// publicada ou arquivada, entrega mais antiga que a janela ou tentativa que o tempo
// extra não alcança. Com 2+ tentativas (per_attempt), a tentativa seguinte que o aluno
// ainda não começou (instruções, sem resposta) é descartada e a entrega reabre; se ele
// já começou a seguinte, a entrega fica e ele é contado (o tempo extra vale para a
// tentativa em andamento). Devolve as tentativas reabertas (e quantas voltaram
// bloqueadas por perda de foco) e quantos ficaram de fora, com o motivo:
// deadlineKept (entregues no fim do tempo e não reabertas; extraTooShort delas porque o
// tempo extra não cobre o tempo que já passou desde o fim), manualKept (enviaram por
// conta própria depois do fim do tempo) e nextAttemptStarted.
function reopenDeadlineDeliveries(memory, application, { now = Date.now(), actor = null, windowMs = CLASS_EXTRA_TIME_REOPEN_WINDOW_MS, extraMinutes = 0 } = {}) {
    const result = { reopened: [], reopenedLocked: 0, deadlineKept: 0, extraTooShort: 0, manualKept: 0, nextAttemptStarted: 0, discardedNextAttempts: 0 };
    if (!application || !ACTIVE_APPLICATION_STATUSES.has(application.status)) return result;
    if (!memory.studentExamState || typeof memory.studentExamState !== 'object') memory.studentExamState = {};
    for (const [email, submission] of latestDeliveryByStudent(memory, application.id)) {
        const open = openAttemptsInApplication(memory, application.id, email);
        const pendingNext = open.length > 0 && open.every(([, state]) => untouchedNextAttempt(state, submission));
        if (open.length && !pendingNext) {
            // Já está na tentativa seguinte: a entrega do fim do tempo da anterior fica.
            if (DEADLINE_DELIVERY_SOURCES.has(submission.submissionSource)
                && Number(submission.deadlineAt) > 0 && now - Number(submission.deadlineAt) <= windowMs
                && open.some(([, state]) => Number(state.attemptNumber || 0) > Number(submission.attemptNumber || 0))) {
                result.nextAttemptStarted += 1;
            }
            continue;
        }
        if (!DEADLINE_DELIVERY_SOURCES.has(submission.submissionSource)) {
            if (timeEndedBeforeExtra(application, submission, email, { now, extraMinutes })) result.manualKept += 1;
            continue;
        }
        const snapshot = submission.reopenableState;
        const deadlineAt = Number(submission.deadlineAt);
        const reopenable = snapshot && typeof snapshot === 'object' && snapshot.startedAt
            && submission.gradePublished !== true
            && !['archived', 'invalidated'].includes(submission.resultStatus)
            && deadlineAt > 0 && now - deadlineAt <= windowMs;
        const state = reopenable ? {
            ...JSON.parse(JSON.stringify(snapshot)),
            applicationId: application.id,
            studentEmail: email,
            status: 'active',
            answers: answersFromDelivery(submission),
            timerRemaining: null,
        } : null;
        const newDeadline = state ? computeAttemptDeadline({ application, state, now }) : null;
        if (!state || (newDeadline !== null && newDeadline <= now)) {
            result.deadlineKept += 1;
            // Reabriria, mas o prazo novo já passou: o tempo extra é menor que o tempo
            // que já passou desde o fim (ex.: +1 min 90 s depois do fim).
            if (state) result.extraTooShort += 1;
            continue;
        }
        // A tentativa seguinte, ainda não começada, sai: a reaberta volta a ser a atual.
        const discardedNext = pendingNext ? open.map(([key, next]) => {
            delete memory.studentExamState[key];
            return { attemptId: next.attemptId || next.id || null, attemptNumber: Number(next.attemptNumber || 0) || null };
        }) : [];
        result.discardedNextAttempts += discardedNext.length;
        state.attemptId = state.attemptId || submission.attemptId;
        state.id = state.id || state.attemptId;
        state.attemptNumber = Number(state.attemptNumber || submission.attemptNumber || 1);
        state.deadlineAt = newDeadline;
        state.savedAt = state.savedAt || submission.timestamp || null;
        state.reopenedAt = now;
        state.reopenedBy = actor || null;
        // A entrega que a reabertura substituiu: o resumo vai junto na próxima entrega da
        // tentativa (o professor vê em Resultados) e a cópia completa fica guardada.
        state.reopenedFrom = [
            ...(Array.isArray(snapshot.reopenedFrom) ? snapshot.reopenedFrom : []),
            {
                submissionId: submission.id,
                source: submission.submissionSource,
                deliveredAt: submission.timestamp || null,
                deadlineAt,
                answeredCount: countAnswers(state.answers),
                lateBySeconds: Number(submission.lateBySeconds || 0),
                score: submission.score ?? null,
            },
        ];
        state.reopenedDelivery = archivedDelivery(submission);
        const key = examStateKey({ applicationId: application.id, studentEmail: email, attemptNumber: state.attemptNumber });
        const index = memory.submissions.indexOf(submission);
        if (index >= 0) memory.submissions.splice(index, 1);
        memory.studentExamState[key] = state;
        recordReopenedAttempt(memory, application, submission, state, actor, now, discardedNext);
        // Travada por perda de foco no fim do tempo: volta travada, e o professor precisa
        // desbloquear no Monitor para o aluno continuar.
        if (state.focusLocked === true) result.reopenedLocked += 1;
        result.reopened.push({ studentEmail: email, attemptId: state.attemptId, submissionId: submission.id, focusLocked: state.focusLocked === true });
    }
    return result;
}

// Tentativa reaberta pelo "+N min" que termina sem entrega nova (o professor desconsiderou
// as tentativas em andamento ao encerrar): a entrega do fim do tempo que ela já tinha
// volta como estava, marcada para o professor. Devolve a entrega restaurada (ou null).
function restoreReopenedDelivery(memory, state, { application = null, actor = null, now = Date.now() } = {}) {
    const archived = state?.reopenedDelivery;
    if (!archived || typeof archived !== 'object' || !archived.id) return null;
    if (!Array.isArray(memory.submissions)) memory.submissions = [];
    const attemptId = archived.attemptId || state.attemptId || null;
    if (attemptId && memory.submissions.some(item => item?.attemptId === attemptId)) return null;
    const restored = JSON.parse(JSON.stringify(archived));
    restored.restoredAfterDiscard = {
        at: new Date(now).toISOString(),
        by: actor || 'sistema',
        reopenedAt: Number(state.reopenedAt) > 0 ? new Date(Number(state.reopenedAt)).toISOString() : null,
    };
    memory.submissions.push(restored);
    if (!Array.isArray(memory.auditLogs)) memory.auditLogs = [];
    memory.auditLogs.push({
        id: `audit_exam_${now}_${Math.random().toString(36).slice(2, 10)}`,
        type: 'exam_attempt_reopen_discarded',
        actor: actor || 'sistema',
        applicationId: application?.id || state.applicationId || null,
        examKey: application?.examKey || restored.examKey || null,
        studentClass: application?.studentClass || null,
        courseId: application?.courseId || null,
        details: {
            studentEmail: normalizedEmail(restored.student?.email || state.studentEmail),
            attemptId,
            submissionId: restored.id,
            discardedAnsweredCount: countAnswers(state.answers),
            restoredAnsweredCount: Number(restored.answeredCount || 0),
        },
        timestamp: new Date(now).toISOString(),
    });
    return restored;
}

function recordReopenedAttempt(memory, application, submission, state, actor, now, discardedNext = []) {
    if (!Array.isArray(memory.auditLogs)) memory.auditLogs = [];
    memory.auditLogs.push({
        id: `audit_exam_${now}_${Math.random().toString(36).slice(2, 10)}`,
        type: 'exam_attempt_reopened_extra_time',
        actor: actor || 'sistema',
        applicationId: application.id,
        examKey: application.examKey,
        studentClass: application.studentClass,
        courseId: application.courseId || null,
        details: {
            studentEmail: normalizedEmail(submission.student?.email),
            attemptId: state.attemptId,
            submissionId: submission.id,
            submissionSource: submission.submissionSource,
            deliveredAt: submission.timestamp || null,
            deadlineAt: Number(submission.deadlineAt) || null,
            newDeadlineAt: state.deadlineAt,
            answeredCount: countAnswers(state.answers),
            score: submission.score ?? null,
            ...(discardedNext.length ? { discardedNextAttempts: discardedNext } : {}),
        },
        timestamp: new Date(now).toISOString(),
    });
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
    // Finalizada porque um envio MANUAL chegou fora do atraso aceito: um envio
    // "automático" depois disso não troca as respostas (o navegador real não faz isso).
    if (submission.lateManualSubmitRefused === true) return false;
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
    AUTO_SUBMIT_EARLY_TOLERANCE_MS,
    AUTO_SUBMIT_GRACE_MS,
    CLASS_EXTRA_TIME_REOPEN_WINDOW_MS,
    CLIENT_TIMER_SOURCE,
    LATE_AUTO_SUBMIT_TOLERANCE_MS,
    LATE_FLAG_THRESHOLD_MS,
    SERVER_DEADLINE_SOURCE,
    SERVER_FINALIZE_DELAY_MS,
    attemptOverdueMs,
    attemptStateForReopen,
    canReplaceServerFinalization,
    computeAttemptDeadline,
    countAnswers,
    deliveredWithoutAttemptsLeft,
    finalizeAttemptState,
    isAttemptPastDeadline,
    lateSubmitDecision,
    markLateSubmission,
    reopenDeadlineDeliveries,
    replaceServerFinalization,
    restoreReopenedDelivery,
    settleExpiredAttempts,
};
