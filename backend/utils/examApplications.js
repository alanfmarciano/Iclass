const crypto = require('crypto');
const { normalizeMaxAttempts } = require('./examAttempts.js');

const APPLICATION_STATUSES = Object.freeze([
    'draft',
    'prepared',
    'waiting',
    'running',
    'paused',
    'finished',
    'cancelled',
]);

const ACTIVE_APPLICATION_STATUSES = new Set(['waiting', 'running', 'paused']);
const TRANSITIONS = Object.freeze({
    draft: new Set(['prepared', 'cancelled']),
    prepared: new Set(['waiting', 'running', 'finished', 'cancelled']),
    waiting: new Set(['running', 'paused', 'finished', 'cancelled']),
    running: new Set(['paused', 'finished', 'cancelled']),
    paused: new Set(['running', 'finished', 'cancelled']),
    finished: new Set(),
    cancelled: new Set(),
});

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createId(prefix) {
    const suffix = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
    return `${prefix}_${suffix}`;
}

function normalizeTimerMode(value, fallback = 'collective') {
    return value === 'per_attempt' ? 'per_attempt' : fallback;
}

function normalizeApplicationStatus(value, fallback = 'prepared') {
    return APPLICATION_STATUSES.includes(value) ? value : fallback;
}

function createExamApplication({
    examKey,
    courseId,
    studentClass,
    historyId = null,
    config = {},
    actor = null,
    now = Date.now(),
    status = 'prepared',
} = {}) {
    if (!examKey || !studentClass) throw new Error('Prova e turma são obrigatórias para criar a aplicação.');
    const timestamp = new Date(now).toISOString();
    const normalizedStatus = normalizeApplicationStatus(status);
    const waitingSeconds = Math.max(0, Number(config.waitingRoomDuration || 0));
    const startsAt = normalizedStatus === 'waiting'
        ? now + waitingSeconds * 1000
        : (normalizedStatus === 'running' ? now : null);

    return {
        id: createId('app'),
        examKey: String(examKey).trim(),
        courseId: courseId ? String(courseId).trim() : null,
        studentClass: String(studentClass).trim(),
        historyId: historyId || config.activeHistoryId || null,
        status: normalizedStatus,
        timerMode: normalizeTimerMode(config.timerMode),
        durationMinutes: Math.max(1, Number(config.durationMinutes) || 60),
        timerEnabled: config.timerEnabled !== false,
        waitingRoomDuration: waitingSeconds,
        startsAt,
        endsAt: null,
        maxAttempts: normalizeMaxAttempts(config.maxAttempts),
        questionCount: Math.max(1, Number(config.questionCount) || 1),
        excludedQuestions: Array.isArray(config.excludedQuestions) ? config.excludedQuestions.map(Number) : [],
        shuffleQuestions: config.shuffleQuestions !== false,
        shuffleAnswers: config.shuffleAnswers !== false,
        versionSnapshots: clone(Array.isArray(config.versionSnapshots) ? config.versionSnapshots : []),
        contentVersion: config.updatedAt || timestamp,
        accessTokenHash: config.accessTokenHash || null,
        tokenEnabled: config.tokenEnabled === true || !!config.accessTokenHash || !!config.accessToken,
        globalTimeAdjustment: Number(config.globalTimeAdjustment || 0),
        studentAdjustments: clone(config.studentAdjustments || {}),
        studentVersions: clone(config.studentVersions || {}),
        annulledQuestions: clone(Array.isArray(config.annulledQuestions) ? config.annulledQuestions : []),
        questionReports: clone(Array.isArray(config.questionReports) ? config.questionReports : []),
        createdAt: timestamp,
        preparedAt: timestamp,
        startedAt: normalizedStatus === 'running' ? timestamp : null,
        finishedAt: null,
        cancelledAt: null,
        updatedAt: timestamp,
        createdBy: actor || null,
        updatedBy: actor || null,
    };
}

function applicationToOnlineConfig(application, previousConfig = {}) {
    if (!application) return previousConfig || {};
    return {
        ...previousConfig,
        applicationId: application.id,
        questionCount: application.questionCount,
        excludedQuestions: clone(application.excludedQuestions || []),
        shuffleQuestions: application.shuffleQuestions !== false,
        shuffleAnswers: application.shuffleAnswers !== false,
        durationMinutes: application.durationMinutes,
        timerEnabled: application.timerEnabled !== false,
        timerMode: application.timerMode || 'collective',
        waitingRoomDuration: Number(application.waitingRoomDuration || 0),
        onlineActive: ACTIVE_APPLICATION_STATUSES.has(application.status),
        status: application.status,
        startTime: application.startsAt || null,
        waitingRoomStartTimestamp: application.status === 'waiting'
            ? Math.max(0, Number(application.startsAt || 0) - Number(application.waitingRoomDuration || 0) * 1000)
            : null,
        globalTimeAdjustment: Number(application.globalTimeAdjustment || 0),
        annulledQuestions: clone(application.annulledQuestions || []),
        activeHistoryId: application.historyId || null,
        versionSnapshots: clone(application.versionSnapshots || []),
        accessToken: null,
        accessTokenHash: application.accessTokenHash || null,
        tokenEnabled: application.tokenEnabled === true,
        maxAttempts: application.maxAttempts,
        preparedAt: application.preparedAt || application.createdAt,
        updatedAt: application.contentVersion || application.updatedAt,
    };
}

function listExamApplications(applications, filters = {}) {
    const courseId = String(filters.courseId || '').trim();
    const studentClass = String(filters.studentClass || '').trim().toLowerCase();
    const examKey = String(filters.examKey || '').trim();
    const statuses = filters.statuses ? new Set(filters.statuses) : null;
    return (Array.isArray(applications) ? applications : [])
        .filter(application => application
            && (!courseId || String(application.courseId || '') === courseId)
            && (!studentClass || String(application.studentClass || '').toLowerCase() === studentClass)
            && (!examKey || String(application.examKey || '') === examKey)
            && (!statuses || statuses.has(application.status)))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function findExamApplication(applications, applicationId) {
    const id = String(applicationId || '').trim();
    if (!id) return null;
    return (Array.isArray(applications) ? applications : []).find(application => application && application.id === id) || null;
}

function resolveExamApplication(memory, { applicationId, studentClass, courseId, examKey } = {}) {
    if (applicationId) return findExamApplication(memory && memory.examApplications, applicationId);
    return listExamApplications(memory && memory.examApplications, {
        studentClass,
        courseId,
        examKey,
        statuses: ['prepared', 'waiting', 'running', 'paused'],
    })[0] || null;
}

function examStateKey({ applicationId, studentEmail, attemptNumber = 1, examKey } = {}) {
    const email = String(studentEmail || '').trim().toLowerCase();
    if (applicationId) return `${applicationId}::${email}::${Math.max(1, Number(attemptNumber) || 1)}`;
    return `${email}_${String(examKey || '').trim()}`;
}

function attemptStatesForApplication(studentExamState, { applicationId, studentEmail } = {}) {
    const email = String(studentEmail || '').trim().toLowerCase();
    return Object.entries(studentExamState || {})
        .filter(([, state]) => state
            && state.applicationId === applicationId
            && String(state.studentEmail || '').toLowerCase() === email)
        .sort((a, b) => Number(b[1].attemptNumber || 0) - Number(a[1].attemptNumber || 0));
}

// Tentativa "em aberto" é a que ainda não virou entrega. Uma tentativa vencida
// ('expired', gravada por versões antigas) continua sendo a tentativa atual até o
// servidor finalizá-la: ela nunca é recriada nem sobrescrita por uma nova.
const CLOSED_ATTEMPT_STATUSES = new Set(['submitted', 'invalidated']);

function findOpenAttemptState(studentExamState, scope = {}) {
    const match = attemptStatesForApplication(studentExamState, scope)
        .find(([, state]) => !CLOSED_ATTEMPT_STATUSES.has(state.status));
    return match ? { key: match[0], state: match[1] } : null;
}

// Pausas da aplicação ({ pausedAt, resumedAt }). Pausar congela o cronômetro: o
// prazo de cada tentativa é empurrado pelo tempo em que a aplicação ficou pausada.
function applicationPauses(application) {
    return (Array.isArray(application?.pauses) ? application.pauses : [])
        .filter(pause => pause && Number(pause.pausedAt) > 0)
        .map(pause => ({ pausedAt: Number(pause.pausedAt), resumedAt: Number(pause.resumedAt) > 0 ? Number(pause.resumedAt) : null }))
        .sort((a, b) => a.pausedAt - b.pausedAt);
}

function openApplicationPause(application, now = Date.now()) {
    if (!Array.isArray(application.pauses)) application.pauses = [];
    const open = application.pauses.find(pause => pause && !pause.resumedAt);
    if (!open) application.pauses.push({ pausedAt: now, resumedAt: null });
    application.pausedAt = open ? Number(open.pausedAt) : now;
}

function closeApplicationPause(application, now = Date.now()) {
    (Array.isArray(application.pauses) ? application.pauses : []).forEach(pause => {
        if (pause && !pause.resumedAt) pause.resumedAt = Math.max(Number(pause.pausedAt) || now, now);
    });
    application.pausedAt = null;
}

// Aplicações pausadas por versões antigas não registravam o início da pausa. Usa o
// último updatedAt (gravado na transição) como melhor estimativa. Idempotente.
function normalizeLegacyApplicationPause(application, now = Date.now()) {
    if (!application || application.status !== 'paused') return false;
    if (applicationPauses(application).some(pause => !pause.resumedAt)) return false;
    const updatedAt = Date.parse(application.updatedAt || '');
    openApplicationPause(application, Number.isFinite(updatedAt) && updatedAt > 0 && updatedAt <= now ? updatedAt : now);
    return true;
}

// Empurra o prazo base de uma tentativa pelas pausas que aconteceram enquanto ela
// ainda tinha tempo. Uma pausa que começou depois do fim do tempo não ressuscita a
// tentativa; a pausa em curso conta até "agora" (cronômetro congelado).
function extendDeadlineByPauses(application, startedAt, baseDeadline, now = Date.now()) {
    let deadline = Number(baseDeadline);
    const start = Number(startedAt);
    if (!Number.isFinite(deadline) || !Number.isFinite(start)) return baseDeadline;
    for (const pause of applicationPauses(application)) {
        const from = Math.max(pause.pausedAt, start);
        const until = pause.resumedAt || now;
        if (!(until > from)) continue;
        if (from >= deadline) break;
        deadline += until - from;
    }
    return deadline;
}

function createAttemptState({ application, studentEmail, attemptNumber, studentClass, courseId, now = Date.now() } = {}) {
    if (!application || !application.id) throw new Error('Aplicação inválida para criar tentativa.');
    const number = Math.max(1, Number(attemptNumber) || 1);
    const state = {
        id: createId('attempt'),
        attemptId: null,
        applicationId: application.id,
        studentEmail: String(studentEmail || '').trim().toLowerCase(),
        studentClass: studentClass || application.studentClass,
        courseId: courseId || application.courseId || null,
        examKey: application.examKey,
        attemptNumber: number,
        status: 'instructions',
        answers: {},
        timerRemaining: null,
        assignedVersion: application.studentVersions?.[String(studentEmail || '').trim().toLowerCase()] || 'A',
        versionAssigned: !!application.studentVersions?.[String(studentEmail || '').trim().toLowerCase()],
        assignedQuestionNumbers: null,
        individualTimeAdjustment: Number(application.studentAdjustments?.[String(studentEmail || '').trim().toLowerCase()] || 0),
        tokenValidated: application.tokenEnabled !== true,
        startedAt: null,
        deadlineAt: null,
        savedAt: null,
        createdAt: new Date(now).toISOString(),
        examConfigVersion: application.contentVersion || application.updatedAt || null,
        focusLocked: false,
        // O aluno vê as alternativas pela letra da posição (AVA-05, utils/examAnswerIds.js).
        alternativeLabels: 'position',
    };
    state.attemptId = state.id;
    return state;
}

const ACTION_ALIASES = Object.freeze({ start: 'running', resume: 'running', pause: 'paused', finish: 'finished', stop: 'finished', cancel: 'cancelled' });

// Confere, sem mudar nada, se a ação é possível no status atual da aplicação. Devolve
// o status de destino e se a aplicação já está nele (a ação não mudaria nada). As
// rotas de controle chamam antes de mexer nas tentativas: uma ação impossível não
// pode deixar entrega gerada nem decisão de encerramento sobrescrita pelo caminho.
function checkExamApplicationTransition(application, action) {
    if (!application) throw Object.assign(new Error('Aplicação não encontrada.'), { status: 404 });
    const current = normalizeApplicationStatus(application.status);
    if (action === 'adjust_waiting') {
        if (current !== 'waiting') {
            throw Object.assign(new Error('A prova não está em sala de espera.'), { status: 409 });
        }
        return { current, target: current, unchanged: false };
    }
    const target = ACTION_ALIASES[action] || action;
    if (!APPLICATION_STATUSES.includes(target)) throw Object.assign(new Error('Estado de aplicação inválido.'), { status: 400 });
    if (current === target) return { current, target, unchanged: true };
    if (!TRANSITIONS[current] || !TRANSITIONS[current].has(target)) {
        throw Object.assign(new Error(`Não é possível alterar a aplicação de ${current} para ${target}.`), { status: 409 });
    }
    return { current, target, unchanged: false };
}

function transitionExamApplication(application, action, options = {}) {
    const { current, target, unchanged } = checkExamApplicationTransition(application, action);
    const now = Number(options.now || Date.now());
    const timestamp = new Date(now).toISOString();

    if (action === 'adjust_waiting') {
        const adjustmentSeconds = Number(options.adjustmentSeconds);
        if (!Number.isFinite(adjustmentSeconds)) {
            throw Object.assign(new Error('Ajuste de tempo inválido.'), { status: 400 });
        }
        const currentStartsAt = Number(application.startsAt);
        const startsAt = Number.isFinite(currentStartsAt) && currentStartsAt > 0 ? currentStartsAt : now;
        const currentDuration = Math.max(0, Number(application.waitingRoomDuration) || 0);
        const waitingStartedAt = startsAt - currentDuration * 1000;
        application.startsAt = Math.max(now, startsAt + adjustmentSeconds * 1000);
        application.waitingRoomDuration = Math.max(0, Math.ceil((application.startsAt - waitingStartedAt) / 1000));
        application.updatedAt = timestamp;
        if (options.actor) application.updatedBy = options.actor;
        return application;
    }

    if (unchanged) return application;

    if (target === 'waiting') {
        const waitingSeconds = Math.max(0, Number(options.waitingRoomDuration ?? application.waitingRoomDuration ?? 0));
        application.waitingRoomDuration = waitingSeconds;
        application.startsAt = now + waitingSeconds * 1000;
    }
    if (target === 'paused') openApplicationPause(application, now);
    if (target === 'running') {
        if (current === 'paused') {
            // Retomar não reinicia o relógio: o início original fica e o tempo pausado é
            // somado ao prazo de cada tentativa. Uma pausa ainda na sala de espera (início
            // no futuro) começa a prova agora: o status 'running' já liberava o início
            // nos dois modos (no modo por tentativa o startsAt antigo ficava no futuro,
            // mas o aluno já podia iniciar); aqui o startsAt passa a dizer a verdade.
            closeApplicationPause(application, now);
            const startsAt = Number(application.startsAt);
            if (!(startsAt > 0) || startsAt > now) application.startsAt = now;
        } else {
            application.startsAt = now;
        }
        if (!application.startedAt) application.startedAt = timestamp;
    }
    if (target === 'finished') {
        if (current === 'paused') closeApplicationPause(application, now);
        application.endsAt = now;
        application.finishedAt = timestamp;
    }
    if (target === 'cancelled') {
        if (current === 'paused') closeApplicationPause(application, now);
        application.cancelledAt = timestamp;
    }
    application.status = target;
    application.updatedAt = timestamp;
    if (options.actor) application.updatedBy = options.actor;
    return application;
}

module.exports = {
    ACTIVE_APPLICATION_STATUSES,
    APPLICATION_STATUSES,
    CLOSED_ATTEMPT_STATUSES,
    applicationPauses,
    applicationToOnlineConfig,
    attemptStatesForApplication,
    checkExamApplicationTransition,
    closeApplicationPause,
    extendDeadlineByPauses,
    createAttemptState,
    createExamApplication,
    examStateKey,
    findExamApplication,
    findOpenAttemptState,
    listExamApplications,
    normalizeApplicationStatus,
    normalizeLegacyApplicationPause,
    normalizeTimerMode,
    openApplicationPause,
    resolveExamApplication,
    transitionExamApplication,
};
