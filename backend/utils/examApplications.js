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

function findOpenAttemptState(studentExamState, scope = {}) {
    const match = attemptStatesForApplication(studentExamState, scope)
        .find(([, state]) => !['submitted', 'expired', 'invalidated'].includes(state.status));
    return match ? { key: match[0], state: match[1] } : null;
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
    };
    state.attemptId = state.id;
    return state;
}

function transitionExamApplication(application, action, options = {}) {
    if (!application) throw Object.assign(new Error('Aplicação não encontrada.'), { status: 404 });
    const current = normalizeApplicationStatus(application.status);
    const now = Number(options.now || Date.now());
    const timestamp = new Date(now).toISOString();

    if (action === 'adjust_waiting') {
        if (current !== 'waiting') {
            throw Object.assign(new Error('A prova não está em sala de espera.'), { status: 409 });
        }
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

    const aliases = { start: 'running', resume: 'running', pause: 'paused', finish: 'finished', stop: 'finished', cancel: 'cancelled' };
    const target = aliases[action] || action;
    if (!APPLICATION_STATUSES.includes(target)) throw Object.assign(new Error('Estado de aplicação inválido.'), { status: 400 });
    if (current === target) return application;
    if (!TRANSITIONS[current] || !TRANSITIONS[current].has(target)) {
        throw Object.assign(new Error(`Não é possível alterar a aplicação de ${current} para ${target}.`), { status: 409 });
    }

    if (target === 'waiting') {
        const waitingSeconds = Math.max(0, Number(options.waitingRoomDuration ?? application.waitingRoomDuration ?? 0));
        application.waitingRoomDuration = waitingSeconds;
        application.startsAt = now + waitingSeconds * 1000;
    }
    if (target === 'running') {
        if (current !== 'paused' || application.timerMode === 'collective') application.startsAt = now;
        if (!application.startedAt) application.startedAt = timestamp;
    }
    if (target === 'finished') {
        application.endsAt = now;
        application.finishedAt = timestamp;
    }
    if (target === 'cancelled') application.cancelledAt = timestamp;
    application.status = target;
    application.updatedAt = timestamp;
    if (options.actor) application.updatedBy = options.actor;
    return application;
}

module.exports = {
    ACTIVE_APPLICATION_STATUSES,
    APPLICATION_STATUSES,
    applicationToOnlineConfig,
    attemptStatesForApplication,
    createAttemptState,
    createExamApplication,
    examStateKey,
    findExamApplication,
    findOpenAttemptState,
    listExamApplications,
    normalizeApplicationStatus,
    normalizeTimerMode,
    resolveExamApplication,
    transitionExamApplication,
};
