// Tentativa do aluno numa aplicação de prova: a que está aberta ou, quando ele pode
// começar, uma nova. É o único caminho das rotas do aluno (sync, início da tentativa e
// validação do token) para chegar a uma tentativa: nenhuma delas cria uma tentativa por
// cima de outra aberta (inclusive a vencida que ainda espera a entrega automática) nem
// quando o aluno não pode começar (tentativas esgotadas, tempo coletivo acabado ou
// aplicação que não está em andamento). Antes, validar o token com o identificador de
// outra tentativa gravava uma tentativa nova na mesma chave: as respostas sumiam e o
// cronômetro por aluno recomeçava do zero.
const db = require('../database.js');
const { accessibilityExtraMinutes } = require('../middlewares.js');
const {
    ACTIVE_APPLICATION_STATUSES,
    createAttemptState,
    examStateKey,
    findOpenAttemptState,
} = require('./examApplications.js');
const { countStudentExamAttempts, filterStudentExamAttempts, normalizeMaxAttempts } = require('./examAttempts.js');
const { SERVER_FINALIZE_DELAY_MS, computeAttemptDeadline, settleExpiredAttempts } = require('./examDeadline.js');

function normalizedEmail(value) {
    return String(value || '').trim().toLowerCase();
}

// Estado da interface antiga (sem aplicação) que é uma tentativa de verdade.
function isLegacyAttemptInUse(state) {
    if (!state || typeof state !== 'object') return false;
    if (Number(state.startedAt) > 0) return true;
    // Cronômetro já rodando na interface antiga (o estado avulso tinha timerRemaining null).
    if (typeof state.timerRemaining === 'number') return true;
    if (state.answers && typeof state.answers === 'object' && Object.keys(state.answers).length > 0) return true;
    return state.tokenValidated === true || state.versionAssigned === true;
}

// Finaliza a tentativa vencida do aluno nesta aplicação (nunca a recria). Com
// graceMs 0 finaliza na hora; no sync espera o atraso normal do envio automático.
function settleStudentAttempt(application, studentEmail, graceMs = SERVER_FINALIZE_DELAY_MS) {
    if (!application) return [];
    const { finalized, changed } = settleExpiredAttempts(db.memory, { applicationId: application.id, studentEmail, graceMs });
    if (changed) db.save().catch(() => {});
    return finalized;
}

// Cronômetro coletivo: uma tentativa nova começa no início da aplicação. Depois que
// o tempo coletivo acabou, ela já nasceria vencida, então não é criada. Com a tentativa
// já aberta nas instruções (openState), vale o ajuste individual dela.
function collectiveTimeOverForNewAttempt(application, studentEmail, now = Date.now(), openState = null) {
    if (!application || application.timerMode === 'per_attempt' || application.timerEnabled === false) return false;
    const startsAt = Number(application.startsAt);
    if (!(startsAt > 0) || startsAt > now) return false;
    const email = normalizedEmail(studentEmail);
    const deadlineAt = computeAttemptDeadline({
        application,
        state: {
            startedAt: startsAt,
            individualTimeAdjustment: openState
                ? Number(openState.individualTimeAdjustment || 0)
                : Number(application.studentAdjustments?.[email] || 0),
            accessibilityExtraMinutes: accessibilityExtraMinutes(email, application.durationMinutes),
        },
        now,
    });
    return deadlineAt !== null && deadlineAt <= now;
}

// O aluno pode começar uma tentativa NOVA nesta aplicação? (Só vale quando ele não tem
// tentativa aberta; a aberta é sempre a que continua.) Mesmas regras em todas as rotas.
function newAttemptGate(application, { studentEmail, onlineConfig = null, courseId = null, now = Date.now() } = {}) {
    const maxAttempts = normalizeMaxAttempts(application?.maxAttempts ?? onlineConfig?.maxAttempts);
    const attemptsUsed = application
        ? countStudentExamAttempts(db.memory.submissions, {
            studentEmail,
            examKey: application.examKey,
            courseId: courseId || application.courseId,
            applicationId: application.id,
        })
        : 0;
    const attemptsExhausted = maxAttempts !== null && attemptsUsed >= maxAttempts;
    const timeOver = !!application && collectiveTimeOverForNewAttempt(application, studentEmail, now);
    const applicationActive = !!application && ACTIVE_APPLICATION_STATUSES.has(application.status);
    return {
        maxAttempts,
        attemptsUsed,
        attemptsExhausted,
        timeOver,
        applicationActive,
        allowed: applicationActive && !attemptsExhausted && !timeOver,
    };
}

function attemptContextForStudent({ application, studentEmail, examKey, create = false, studentClass, courseId } = {}) {
    if (!application) {
        const key = examStateKey({ studentEmail, examKey });
        return { key, state: db.memory.studentExamState[key] || null };
    }
    const open = findOpenAttemptState(db.memory.studentExamState, { applicationId: application.id, studentEmail });
    if (open) return open;

    // Migração transparente: uma tentativa aberta pela interface antiga é vinculada
    // à aplicação atual na primeira requisição nova. Só vale para tentativa de verdade
    // (iniciada, com respostas, token validado ou versão escolhida no Monitor): o estado
    // avulso que versões anteriores gravavam com um evento de foco ou um desbloqueio
    // depois da entrega virava uma tentativa fantasma travada ("Bloqueado" para quem já
    // tinha entregado). Ele fica onde está, sem efeito.
    const legacyKey = examStateKey({ studentEmail, examKey });
    const legacyState = db.memory.studentExamState[legacyKey];
    if (legacyState && !legacyState.applicationId && isLegacyAttemptInUse(legacyState)) {
        const previousAttempts = filterStudentExamAttempts(db.memory.submissions, {
            studentEmail,
            examKey,
            courseId,
            applicationId: application.id,
        });
        legacyState.applicationId = application.id;
        legacyState.attemptNumber = previousAttempts.length + 1;
        legacyState.attemptId = legacyState.attemptId || `attempt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        legacyState.id = legacyState.attemptId;
        legacyState.status = legacyState.startedAt ? 'active' : 'instructions';
        const key = examStateKey({ applicationId: application.id, studentEmail, attemptNumber: legacyState.attemptNumber });
        db.memory.studentExamState[key] = legacyState;
        delete db.memory.studentExamState[legacyKey];
        return { key, state: legacyState };
    }
    if (!create) return { key: null, state: null };

    const attemptsUsed = countStudentExamAttempts(db.memory.submissions, {
        studentEmail,
        examKey,
        courseId,
        applicationId: application.id,
    });
    const state = createAttemptState({
        application,
        studentEmail,
        attemptNumber: attemptsUsed + 1,
        studentClass,
        courseId,
    });
    const key = examStateKey({ applicationId: application.id, studentEmail, attemptNumber: state.attemptNumber });
    db.memory.studentExamState[key] = state;
    // O "+N min" dado ao aluno antes de ele ter tentativa aberta vale para esta tentativa
    // (já copiado nela) e não passa para a seguinte.
    const email = normalizedEmail(studentEmail);
    if (application.studentAdjustments && Object.prototype.hasOwnProperty.call(application.studentAdjustments, email)) {
        delete application.studentAdjustments[email];
    }
    return { key, state };
}

module.exports = {
    attemptContextForStudent,
    collectiveTimeOverForNewAttempt,
    isLegacyAttemptInUse,
    newAttemptGate,
    settleStudentAttempt,
};
