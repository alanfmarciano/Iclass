const express = require('express');
const crypto = require('crypto');
const db = require('../database.js');
const { ensureExamToken, hashExamToken, normalizeExamToken } = require('../utils/examToken.js');
const { filterStudentExamAttempts, normalizeMaxAttempts, parseMaxAttempts } = require('../utils/examAttempts.js');
const {
    createSubmissionFromAttempt,
    questionNumber,
    regradeSubmission,
    snapshotForAttempt,
} = require('../utils/examGrading.js');
const {
    ACTIVE_APPLICATION_STATUSES,
    applicationToOnlineConfig,
    createExamApplication,
    findExamApplication,
    listExamApplications,
    transitionExamApplication,
} = require('../utils/examApplications.js');
const { buildApplicationAuditTrail, describeSubmissionGrade, examTitle, recordGradeAudit } = require('../utils/gradebook.js');
const {
    validateAdmin,
    adminCanAccessClass,
    findClassByNameAndCourse,
    getReleasedItemsForClass,
    isCourseItemKey,
    isCourseExamKey,
} = require('../middlewares.js');

const VERSION_LABELS = ['A', 'B', 'C', 'D'];
const DEFAULT_ONLINE_DURATION_MINUTES = 60;
const DEFAULT_WAITING_ROOM_MINUTES = 10;
const DEFAULT_MAX_ATTEMPTS = 1;

function getHistoryVersionSnapshots(historyEntry) {
    const snapshots = Array.isArray(historyEntry.versionSnapshots) && historyEntry.versionSnapshots.length > 0
        ? historyEntry.versionSnapshots
        : historyEntry.printSnapshot;
    return Array.isArray(snapshots)
        ? snapshots.slice(0, VERSION_LABELS.length).map((snapshot, index) => ({ version: VERSION_LABELS[index], ...snapshot }))
        : [];
}

function findOnlineHistoryEntry(cls, examKey, historyId) {
    const history = cls.examHistory && Array.isArray(cls.examHistory[examKey]) ? cls.examHistory[examKey] : [];
    const isReusableEntry = entry => getHistoryVersionSnapshots(entry).length > 0;
    if (historyId) return history.find(entry => entry.id === historyId && isReusableEntry(entry)) || null;
    return [...history].reverse().find(isReusableEntry) || null;
}

function buildPreparedOnlineExamConfig(historyEntry, previousConfig = {}, applicationOptions = {}) {
    const availableSnapshots = getHistoryVersionSnapshots(historyEntry);
    const requestedVersions = parseInt(applicationOptions.onlineVersions, 10);
    const versionCount = Number.isFinite(requestedVersions)
        ? Math.max(1, Math.min(requestedVersions, availableSnapshots.length))
        : availableSnapshots.length;
    const versionSnapshots = availableSnapshots.slice(0, versionCount);
    const fallbackQuestionCount = Array.isArray(historyEntry.questionNumbers)
        ? historyEntry.questionNumbers.length
        : (versionSnapshots[0] && Array.isArray(versionSnapshots[0].questions) ? versionSnapshots[0].questions.length : 20);
    const updatedAt = new Date().toISOString();
    const now = Date.now();
    const parsedWaitingRoom = parseInt(applicationOptions.waitingRoomMinutes ?? historyEntry.waitingRoomMinutes, 10);
    const waitingRoomMinutes = Number.isFinite(parsedWaitingRoom) ? Math.max(0, parsedWaitingRoom) : DEFAULT_WAITING_ROOM_MINUTES;
    const waitingRoomDuration = waitingRoomMinutes * 60;
    const hasWaitingRoom = waitingRoomDuration > 0;
    const hasTokenChoice = Object.prototype.hasOwnProperty.call(applicationOptions, 'tokenEnabled');
    const tokenEnabled = hasTokenChoice ? applicationOptions.tokenEnabled === true : !!normalizeExamToken(historyEntry.accessToken);
    const hasMaxAttemptsChoice = Object.prototype.hasOwnProperty.call(applicationOptions, 'maxAttempts');
    const historyHasMaxAttempts = Object.prototype.hasOwnProperty.call(historyEntry, 'maxAttempts');
    const maxAttempts = normalizeMaxAttempts(hasMaxAttemptsChoice
        ? applicationOptions.maxAttempts
        : (historyHasMaxAttempts ? historyEntry.maxAttempts : DEFAULT_MAX_ATTEMPTS));
    return {
        questionCount: parseInt(historyEntry.questionCount, 10) || fallbackQuestionCount,
        excludedQuestions: Array.isArray(historyEntry.excludedQuestions) ? historyEntry.excludedQuestions.map(Number) : [],
        shuffleQuestions: historyEntry.shuffleQuestions !== false,
        shuffleAnswers: historyEntry.shuffleAnswers !== false,
        durationMinutes: parseInt(applicationOptions.durationMinutes ?? historyEntry.durationMinutes, 10) || DEFAULT_ONLINE_DURATION_MINUTES,
        timerEnabled: typeof applicationOptions.timerEnabled === 'boolean' ? applicationOptions.timerEnabled : historyEntry.timerEnabled !== false,
        waitingRoomDuration,
        onlineActive: true,
        status: hasWaitingRoom ? 'waiting' : 'running',
        startTime: hasWaitingRoom ? now + waitingRoomDuration * 1000 : now,
        waitingRoomStartTimestamp: hasWaitingRoom ? now : null,
        globalTimeAdjustment: 0,
        activeHistoryId: historyEntry.id,
        accessToken: tokenEnabled ? ensureExamToken(applicationOptions.accessToken || historyEntry.accessToken) : null,
        maxAttempts,
        versionSnapshots,
        preparedAt: updatedAt,
        updatedAt,
    };
}

async function persistClasses(classes) {
    db.memory.classes = classes;
    await db.save();
}

function adminActor(req) {
    return (req.adminAccount && (req.adminAccount.email || req.adminAccount.name)) || 'Administrador';
}

function closePreviousApplications({ studentClass, courseId, examKey, actor }) {
    listExamApplications(db.memory.examApplications, { studentClass, courseId, examKey })
        .filter(application => !['finished', 'cancelled'].includes(application.status))
        .forEach(application => {
            try {
                transitionExamApplication(application, ACTIVE_APPLICATION_STATUSES.has(application.status) ? 'finished' : 'cancelled', { actor });
            } catch (_) {}
        });
}

function prepareApplicationFromHistory(cls, examKey, historyEntry, applicationOptions, req) {
    const options = applicationOptions || {};
    const preparedConfig = buildPreparedOnlineExamConfig(historyEntry, cls.onlineExamConfigs?.[examKey] || {}, options);
    const rawToken = preparedConfig.accessToken;
    preparedConfig.accessTokenHash = hashExamToken(rawToken);
    preparedConfig.tokenEnabled = !!preparedConfig.accessTokenHash;
    preparedConfig.accessToken = null;
    preparedConfig.status = 'prepared';
    preparedConfig.onlineActive = false;
    preparedConfig.startTime = null;
    preparedConfig.waitingRoomStartTimestamp = null;
    preparedConfig.timerMode = options.timerMode === 'per_attempt' ? 'per_attempt' : 'collective';

    const actor = adminActor(req);
    closePreviousApplications({ studentClass: cls.name, courseId: cls.courseId, examKey, actor });
    const application = createExamApplication({
        examKey,
        courseId: cls.courseId,
        studentClass: cls.name,
        historyId: historyEntry.id,
        config: preparedConfig,
        actor,
        status: 'prepared',
    });
    db.memory.examApplications.push(application);
    cls.onlineExamConfigs[examKey] = applicationToOnlineConfig(application, cls.onlineExamConfigs?.[examKey] || {});
    cls.releasedItems[examKey] = false;
    if (cls.activeExamKey === examKey) cls.activeExamKey = null;
    if (cls.activeApplicationId === application.id) cls.activeApplicationId = null;
    return { application, accessToken: rawToken || null };
}

function applicationStateEntries(applicationId) {
    return Object.entries(db.memory.studentExamState || {}).filter(([, state]) =>
        state && state.applicationId === applicationId && !['submitted', 'expired', 'invalidated'].includes(state.status));
}

function finishSummary(application) {
    const entries = applicationStateEntries(application.id);
    const started = entries.filter(([, state]) => !!state.startedAt);
    return {
        applicationId: application.id,
        inProgressAttempts: started.length,
        answeredQuestions: started.reduce((total, [, state]) => total + Object.keys(state.answers || {}).length, 0),
        waitingToStart: entries.length - started.length,
        students: started.map(([, state]) => ({
            email: state.studentEmail,
            answeredQuestions: Object.keys(state.answers || {}).length,
            attemptNumber: state.attemptNumber || 1,
        })),
    };
}

function recordExamAudit(type, application, actor, details = {}) {
    if (!Array.isArray(db.memory.auditLogs)) db.memory.auditLogs = [];
    db.memory.auditLogs.push({
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

function pushExamMessage(application, actor, messageText) {
    if (!Array.isArray(db.memory.broadcastMessages)) db.memory.broadcastMessages = [];
    db.memory.broadcastMessages.push({
        id: `exam_message_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        studentClass: application.studentClass,
        courseId: application.courseId || null,
        examKey: application.examKey,
        applicationId: application.id,
        targetEmail: null,
        messageText,
        timestamp: Date.now(),
        createdAt: new Date().toISOString(),
        senderEmail: actor,
        acknowledgedBy: [],
        deletedFor: [],
        adminDeleted: false,
        status: 'pending',
    });
}

function markQuestionReports(application, question, action, actor, reportIds = null) {
    const ids = reportIds ? new Set(reportIds.map(String)) : null;
    const now = new Date().toISOString();
    let updated = 0;
    (application.questionReports || []).forEach(report => {
        if (report.status !== 'open') return;
        if (ids ? !ids.has(String(report.id)) : Number(report.questionNumber) !== Number(question)) return;
        report.status = action === 'annulled' ? 'annulled' : 'reviewed';
        report.resolutionAction = action;
        report.resolvedBy = actor;
        report.resolvedAt = now;
        updated += 1;
    });
    return updated;
}

// Recorrige as entregas da aplicação. Nota que mudou vai para o scoreHistory da
// entrega e para a auditoria do aluno, com o motivo (AVA-08).
function regradeApplicationSubmissions(application, cls, { req = null, reason = '' } = {}) {
    const onlineConfig = cls.onlineExamConfigs?.[application.examKey] || applicationToOnlineConfig(application, {});
    const evaluation = db.memory.evaluations?.[application.examKey] || null;
    const by = req ? adminActor(req) : 'sistema';
    let updated = 0;
    (db.memory.submissions || []).forEach(submission => {
        if (submission?.applicationId !== application.id) return;
        const before = { score: submission.score, correctCount: submission.correctCount, totalCount: submission.totalCount };
        regradeSubmission({ submission, application, onlineConfig, evaluation, reason, by });
        updated += 1;
        if (before.score !== submission.score || before.correctCount !== submission.correctCount || before.totalCount !== submission.totalCount) {
            const title = examTitle(submission.examKey, { evaluations: db.memory.evaluations });
            const audit = recordGradeAudit(db.memory, {
                req,
                actor: by,
                submission,
                action: 'grade_regrade',
                field: 'Nota',
                oldValue: describeSubmissionGrade({ ...submission, ...before }, title),
                newValue: `${describeSubmissionGrade(submission, title)} · ${reason || 'recorreção da prova'}`,
            });
            const last = Array.isArray(submission.scoreHistory) ? submission.scoreHistory[submission.scoreHistory.length - 1] : null;
            if (last && audit) last.auditId = audit.id;
        }
    });
    return updated;
}

function syncApplicationConfig(cls, application) {
    if (!cls.onlineExamConfigs) cls.onlineExamConfigs = {};
    cls.onlineExamConfigs[application.examKey] = applicationToOnlineConfig(
        application,
        cls.onlineExamConfigs[application.examKey] || {}
    );
    return cls.onlineExamConfigs[application.examKey];
}

function liveQuestion(application, number, version = 'A') {
    const snapshot = snapshotForAttempt(application, null, version);
    return (snapshot?.questions || []).find((question, index) => questionNumber(question, index) === Number(number)) || null;
}

function normalizeLiveQuestion(payload = {}) {
    const text = String(payload.text || payload.questionText || '').trim();
    const alternatives = (Array.isArray(payload.alternatives) ? payload.alternatives : []).map((alternative, index) => ({
        letter: String(alternative?.letter || String.fromCharCode(65 + index)).toUpperCase(),
        text: String(alternative?.text || '').trim(),
        isCorrect: alternative?.isCorrect === true,
    })).filter(alternative => alternative.text);
    let correctAnswer = String(payload.correctAnswer || '').toUpperCase();
    if (!correctAnswer) correctAnswer = alternatives.find(alternative => alternative.isCorrect)?.letter || '';
    alternatives.forEach(alternative => { alternative.isCorrect = alternative.letter === correctAnswer; });
    if (!text) throw Object.assign(new Error('O enunciado da questao e obrigatorio.'), { status: 400 });
    if (alternatives.length < 2) throw Object.assign(new Error('Informe pelo menos duas alternativas.'), { status: 400 });
    if (!alternatives.some(alternative => alternative.letter === correctAnswer)) {
        throw Object.assign(new Error('Selecione uma alternativa correta valida.'), { status: 400 });
    }
    return { text, questionText: text, alternatives, correctAnswer };
}

function applicationForAdminRequest(applicationId) {
    const application = findExamApplication(db.memory.examApplications, applicationId);
    if (!application) throw Object.assign(new Error('Aplicacao de prova nao encontrada.'), { status: 404 });
    const cls = findClassByNameAndCourse(db.memory.classes || [], application.studentClass, application.courseId);
    if (!cls) throw Object.assign(new Error('Turma da aplicacao nao encontrada.'), { status: 404 });
    return { application, cls };
}

function createAdminExamConfigRouter() {
    const router = express.Router();

    router.get('/api/admin/exam-applications', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            const applications = listExamApplications(db.memory.examApplications, {
                studentClass: req.query.studentClass,
                courseId: req.query.courseId,
                examKey: req.query.examKey,
            }).filter(application => matchedAdmin?.role !== 'professor'
                || (matchedAdmin.assignedClasses || []).some(item =>
                    item && item.courseId === application.courseId && item.className === application.studentClass));
            res.json({ success: true, applications });
        });
    });

    router.get('/api/admin/exam-applications/:applicationId', (req, res) => {
        validateAdmin(req, res, () => {
            const application = findExamApplication(db.memory.examApplications, req.params.applicationId);
            if (!application) return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });
            res.json({ success: true, application });
        });
    });

    // Registro da aplicação (AVA-08): ciclo, eventos da prova e alterações de nota
    // das entregas desta aplicação, para o professor conferir o que mudou e quando.
    router.get('/api/admin/exam-applications/:applicationId/audit', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            const application = findExamApplication(db.memory.examApplications, req.params.applicationId);
            if (!application) return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });
            if (!adminCanAccessClass(matchedAdmin, application.studentClass, application.courseId)) {
                return res.status(403).json({ error: 'Aplicação fora do escopo desta conta.' });
            }
            res.json({
                success: true,
                application: {
                    id: application.id,
                    examKey: application.examKey,
                    examTitle: examTitle(application.examKey, { evaluations: db.memory.evaluations }),
                    studentClass: application.studentClass,
                    courseId: application.courseId || null,
                    status: application.status,
                    createdAt: application.createdAt || null,
                },
                entries: buildApplicationAuditTrail(application, db.memory.auditLogs || [], { students: db.memory.students || [] }),
            });
        });
    });

    router.get('/api/admin/exam-applications/:applicationId/finish-summary', (req, res) => {
        validateAdmin(req, res, () => {
            const application = findExamApplication(db.memory.examApplications, req.params.applicationId);
            if (!application) return res.status(404).json({ error: 'Aplicacao de prova nao encontrada.' });
            res.json({ success: true, summary: finishSummary(application) });
        });
    });

    router.post('/api/admin/exam-applications', (req, res) => {
        validateAdmin(req, res, async () => {
            const { studentClass, courseId, examKey, historyId } = req.body || {};
            if (!studentClass || !examKey || !historyId) {
                return res.status(400).json({ error: 'Turma, prova e configuração salva são obrigatórias.' });
            }
            const cls = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId);
            if (!cls) return res.status(404).json({ error: 'Turma não encontrada.' });
            if (!isCourseExamKey(cls, examKey)) return res.status(400).json({ error: 'Avaliação não pertence ao curso da turma.' });
            const historyEntry = findOnlineHistoryEntry(cls, examKey, historyId);
            if (!historyEntry) return res.status(400).json({ error: 'Configuração salva não encontrada ou sem questões.' });
            const options = req.body.applicationOptions || {};
            if (options.tokenEnabled === true && !normalizeExamToken(options.accessToken)) {
                return res.status(400).json({ error: 'O token deve conter exatamente 5 letras maiúsculas.' });
            }
            const parsedMaxAttempts = parseMaxAttempts(Object.prototype.hasOwnProperty.call(options, 'maxAttempts')
                ? options.maxAttempts
                : (Object.prototype.hasOwnProperty.call(historyEntry, 'maxAttempts') ? historyEntry.maxAttempts : DEFAULT_MAX_ATTEMPTS));
            if (!parsedMaxAttempts.valid) return res.status(400).json({ error: 'Tentativas deve ser um número entre 1 e 10.' });
            if (!cls.onlineExamConfigs) cls.onlineExamConfigs = {};
            if (!cls.releasedItems) cls.releasedItems = {};
            const prepared = prepareApplicationFromHistory(cls, examKey, historyEntry, options, req);
            await persistClasses(db.memory.classes || []);
            res.status(201).json({ success: true, ...prepared, onlineExamConfig: cls.onlineExamConfigs[examKey] });
        });
    });

    router.post('/api/admin/exam-applications/:applicationId/control', (req, res) => {
        validateAdmin(req, res, async () => {
            const application = findExamApplication(db.memory.examApplications, req.params.applicationId);
            if (!application) return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });
            const cls = findClassByNameAndCourse(db.memory.classes || [], application.studentClass, application.courseId);
            if (!cls) return res.status(404).json({ error: 'Turma da aplicacao nao encontrada.' });
            let processedFinish = null;
            if (req.body.action === 'finish' || req.body.action === 'stop') {
                const summary = finishSummary(application);
                const policy = req.body.inProgressPolicy;
                if (summary.inProgressAttempts > 0 && !['submit', 'discard'].includes(policy)) {
                    return res.status(409).json({
                        error: 'Escolha se as respostas em andamento devem ser salvas ou desconsideradas.',
                        requiresInProgressPolicy: true,
                        summary,
                    });
                }
                const entries = applicationStateEntries(application.id);
                let submitted = 0;
                let discarded = 0;
                if (policy === 'submit') {
                    for (const [, state] of entries) {
                        if (!state.startedAt) continue;
                        const duplicate = (db.memory.submissions || []).some(item => item?.attemptId && item.attemptId === state.attemptId);
                        if (duplicate) continue;
                        const student = (db.memory.students || []).find(item =>
                            String(item?.email || '').toLowerCase() === String(state.studentEmail || '').toLowerCase())
                            || { email: state.studentEmail, name: state.studentEmail };
                        const previousAttempts = filterStudentExamAttempts(db.memory.submissions, {
                            studentEmail: state.studentEmail,
                            examKey: application.examKey,
                            courseId: application.courseId,
                            applicationId: application.id,
                        });
                        const submission = createSubmissionFromAttempt({
                            application,
                            onlineConfig: cls.onlineExamConfigs?.[application.examKey],
                            state,
                            evaluation: db.memory.evaluations?.[application.examKey],
                            student,
                            answers: state.answers || {},
                            previousAttempts,
                            source: 'instructor_finish',
                        });
                        submission.autoSubmittedByInstructor = true;
                        submission.finishPolicy = 'submit';
                        db.memory.submissions.push(submission);
                        submitted += 1;
                    }
                } else if (policy === 'discard') {
                    discarded = summary.inProgressAttempts;
                }
                entries.forEach(([key]) => { delete db.memory.studentExamState[key]; });
                processedFinish = { policy: policy || 'none', submitted, discarded, summary };
                application.finishResolution = {
                    policy: processedFinish.policy,
                    submitted,
                    discarded,
                    at: new Date().toISOString(),
                    by: adminActor(req),
                };
                recordExamAudit('exam_application_finished', application, adminActor(req), processedFinish);
            }
            if (!cls) return res.status(404).json({ error: 'Turma da aplicação não encontrada.' });
            try {
                transitionExamApplication(application, req.body.action, {
                    actor: adminActor(req),
                    waitingRoomDuration: req.body.waitingRoomDuration,
                    adjustmentSeconds: req.body.adjustmentSeconds,
                });
            } catch (error) {
                return res.status(error.status || 400).json({ error: error.message });
            }
            if (!cls.onlineExamConfigs) cls.onlineExamConfigs = {};
            if (!cls.releasedItems) cls.releasedItems = {};
            cls.onlineExamConfigs[application.examKey] = applicationToOnlineConfig(application, cls.onlineExamConfigs[application.examKey] || {});
            const active = ACTIVE_APPLICATION_STATUSES.has(application.status);
            cls.releasedItems[application.examKey] = active;
            cls.activeExamKey = active ? application.examKey : (cls.activeExamKey === application.examKey ? null : cls.activeExamKey);
            cls.activeApplicationId = active ? application.id : (cls.activeApplicationId === application.id ? null : cls.activeApplicationId);
            await persistClasses(db.memory.classes || []);
            res.json({ success: true, application, config: cls.onlineExamConfigs[application.examKey], finish: processedFinish });
        });
    });

    router.post('/api/admin/exam-applications/:applicationId/time-adjustment', (req, res) => {
        validateAdmin(req, res, async () => {
            const application = findExamApplication(db.memory.examApplications, req.params.applicationId);
            if (!application) return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });
            const adjustmentMinutes = Number(req.body.adjustmentMinutes);
            if (!Number.isFinite(adjustmentMinutes)) return res.status(400).json({ error: 'Ajuste de tempo inválido.' });
            const targetEmail = String(req.body.targetEmail || '').trim().toLowerCase();
            if (targetEmail) {
                Object.values(db.memory.studentExamState || {}).forEach(state => {
                    if (state && state.applicationId === application.id && state.studentEmail === targetEmail && !['submitted', 'expired'].includes(state.status)) {
                        state.individualTimeAdjustment = Number(state.individualTimeAdjustment || 0) + adjustmentMinutes;
                        if (state.deadlineAt) state.deadlineAt = Number(state.deadlineAt) + adjustmentMinutes * 60000;
                    }
                });
            } else {
                application.globalTimeAdjustment = Number(application.globalTimeAdjustment || 0) + adjustmentMinutes;
                const cls = findClassByNameAndCourse(db.memory.classes || [], application.studentClass, application.courseId);
                if (cls?.onlineExamConfigs?.[application.examKey]) {
                    cls.onlineExamConfigs[application.examKey] = applicationToOnlineConfig(application, cls.onlineExamConfigs[application.examKey]);
                }
            }
            application.updatedAt = new Date().toISOString();
            application.updatedBy = adminActor(req);
            await db.save();
            res.json({ success: true, application });
        });
    });

    router.get('/api/admin/question-reports/:class/:examKey', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            try {
                const { application, cls } = applicationForAdminRequest(req.query.applicationId);
                if (application.studentClass.toLowerCase() !== String(req.params.class || '').trim().toLowerCase()
                    || application.examKey !== String(req.params.examKey || '').trim()) {
                    return res.status(404).json({ error: 'Aplicacao nao encontrada para a turma e prova informadas.' });
                }
                if (!adminCanAccessClass(matchedAdmin, application.studentClass, application.courseId)) {
                    return res.status(403).json({ error: 'Aplicacao fora do escopo desta conta.' });
                }
                const openReports = (application.questionReports || []).filter(report => report.status === 'open');
                const byQuestion = new Map();
                openReports.forEach(report => {
                    const number = Number(report.questionNumber);
                    if (!byQuestion.has(number)) byQuestion.set(number, []);
                    byQuestion.get(number).push(report);
                });
                const groups = [...byQuestion.entries()].map(([number, reports]) => {
                    const reasons = {};
                    reports.forEach(report => { reasons[report.reason] = Number(reasons[report.reason] || 0) + 1; });
                    const version = reports[0]?.assignedVersion || 'A';
                    const question = liveQuestion(application, number, version);
                    return {
                        questionNumber: number,
                        questionPosition: reports[0]?.questionPosition || null,
                        count: reports.length,
                        reasons,
                        reports,
                        question,
                        annulled: (application.annulledQuestions || []).some(item => Number(item.questionNumber) === number),
                    };
                }).sort((a, b) => a.questionNumber - b.questionNumber);
                res.json({
                    success: true,
                    applicationId: application.id,
                    totalOpen: openReports.length,
                    groups,
                    status: application.status,
                    finishSummary: finishSummary(application),
                    config: cls.onlineExamConfigs?.[application.examKey] || null,
                });
            } catch (error) {
                res.status(error.status || 400).json({ error: error.message });
            }
        });
    });

    router.post('/api/admin/question-reports/resolve', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            try {
                const { application } = applicationForAdminRequest(req.body.applicationId);
                if (!adminCanAccessClass(matchedAdmin, application.studentClass, application.courseId)) {
                    return res.status(403).json({ error: 'Aplicacao fora do escopo desta conta.' });
                }
                const reportIds = Array.isArray(req.body.reportIds) ? req.body.reportIds : null;
                const number = Number(req.body.questionNumber);
                if (!reportIds && !Number.isFinite(number)) return res.status(400).json({ error: 'Informe a questao ou as contestacoes.' });
                const updated = markQuestionReports(application, number, 'reviewed', adminActor(req), reportIds);
                recordExamAudit('exam_question_reports_reviewed', application, adminActor(req), { questionNumber: number, reportIds, updated });
                await db.save();
                res.json({ success: true, updated });
            } catch (error) {
                res.status(error.status || 400).json({ error: error.message });
            }
        });
    });

    router.post('/api/admin/correct-live-question', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            try {
                const { application, cls } = applicationForAdminRequest(req.body.applicationId);
                if (!adminCanAccessClass(matchedAdmin, application.studentClass, application.courseId)) {
                    return res.status(403).json({ error: 'Aplicacao fora do escopo desta conta.' });
                }
                if (!['waiting', 'running', 'paused'].includes(application.status)) {
                    return res.status(409).json({ error: 'A aplicacao precisa estar ativa para corrigir a questao ao vivo.' });
                }
                const number = Number(req.body.questionNumber);
                const normalized = normalizeLiveQuestion(req.body.question || {});
                let updatedSnapshots = 0;
                (application.versionSnapshots || []).forEach(snapshot => {
                    snapshot.questions = (snapshot.questions || []).map((question, index) => {
                        if (questionNumber(question, index) !== number) return question;
                        updatedSnapshots += 1;
                        return {
                            ...question,
                            ...normalized,
                            originalNumber: number,
                            alternatives: normalized.alternatives.map(alternative => ({ ...alternative, displayLetter: alternative.letter })),
                        };
                    });
                });
                if (updatedSnapshots === 0) return res.status(404).json({ error: 'Questao nao encontrada nesta aplicacao.' });
                application.updatedAt = new Date().toISOString();
                markQuestionReports(application, number, 'corrected', adminActor(req));
                const onlineConfig = syncApplicationConfig(cls, application);
                const regraded = regradeApplicationSubmissions(application, cls, { req, reason: `correção da questão ${number} durante a aplicação` });
                pushExamMessage(application, adminActor(req), `A questão ${number} foi corrigida pelo professor. Revise o enunciado e as alternativas antes de enviar.`);
                recordExamAudit('exam_question_corrected_live', application, adminActor(req), { questionNumber: number, regraded });
                await db.save();
                res.json({ success: true, question: liveQuestion(application, number), regraded, config: onlineConfig });
            } catch (error) {
                res.status(error.status || 400).json({ error: error.message });
            }
        });
    });

    router.post('/api/admin/annul-question', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            try {
                const { application, cls } = applicationForAdminRequest(req.body.applicationId);
                if (!adminCanAccessClass(matchedAdmin, application.studentClass, application.courseId)) {
                    return res.status(403).json({ error: 'Aplicacao fora do escopo desta conta.' });
                }
                const number = Number(req.body.questionNumber);
                const mode = req.body.mode === 'ponto_para_todos' ? 'ponto_para_todos' : 'remover_do_total';
                if (!liveQuestion(application, number)) return res.status(404).json({ error: 'Questao nao encontrada nesta aplicacao.' });
                if (!Array.isArray(application.annulledQuestions)) application.annulledQuestions = [];
                const existing = application.annulledQuestions.find(item => Number(item.questionNumber) === number);
                const entry = {
                    questionNumber: number,
                    mode,
                    reason: String(req.body.reason || '').trim(),
                    by: adminActor(req),
                    at: new Date().toISOString(),
                };
                if (existing) Object.assign(existing, entry);
                else application.annulledQuestions.push(entry);
                application.updatedAt = entry.at;
                markQuestionReports(application, number, 'annulled', adminActor(req));
                const onlineConfig = syncApplicationConfig(cls, application);
                // O motivo digitado pelo professor vai junto para o histórico da nota (AVA-08).
                const modeLabel = mode === 'ponto_para_todos' ? 'ponto para todos' : 'removida do total';
                const regraded = regradeApplicationSubmissions(application, cls, {
                    req,
                    reason: `anulação da questão ${number} (${modeLabel})${entry.reason ? ` · motivo: ${entry.reason}` : ''}`,
                });
                pushExamMessage(application, adminActor(req), `A questão ${number} foi anulada pelo professor e não prejudicará sua nota.`);
                recordExamAudit('exam_question_annulled', application, adminActor(req), { ...entry, regraded });
                await db.save();
                res.json({ success: true, annulment: entry, regraded, config: onlineConfig });
            } catch (error) {
                res.status(error.status || 400).json({ error: error.message });
            }
        });
    });

    router.post('/api/admin/replace-question', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            try {
                const { application, cls } = applicationForAdminRequest(req.body.applicationId);
                if (!adminCanAccessClass(matchedAdmin, application.studentClass, application.courseId)) {
                    return res.status(403).json({ error: 'Aplicacao fora do escopo desta conta.' });
                }
                if (application.status !== 'running') {
                    return res.status(409).json({ error: 'A prova precisa estar em andamento para substituir uma questao.' });
                }
                const activeStates = applicationStateEntries(application.id).map(([, state]) => state).filter(state => state.startedAt);
                const remainingValues = activeStates
                    .filter(state => Number(state.deadlineAt) > 0)
                    .map(state => Math.max(0, Math.ceil((Number(state.deadlineAt) - Date.now()) / 1000)));
                if (remainingValues.length && Math.min(...remainingValues) < 300) {
                    return res.status(409).json({ error: 'Nao e possivel substituir: um ou mais alunos tem menos de 5 minutos restantes.' });
                }
                const originalNumber = Number(req.body.questionNumber);
                if (!liveQuestion(application, originalNumber)) return res.status(404).json({ error: 'Questao original nao encontrada.' });
                const bank = (db.memory.questionBank || []).find(question => question.key === req.body.bankQuestionKey);
                if (!bank) return res.status(404).json({ error: 'Questao do banco nao encontrada.' });
                const extraMinutes = Math.max(0, Math.min(30, Number(req.body.extraMinutes) || 0));
                const allNumbers = (application.versionSnapshots || []).flatMap(snapshot =>
                    (snapshot.questions || []).map((question, index) => questionNumber(question, index)).filter(Number.isFinite));
                const replacementNumber = Math.max(0, ...allNumbers) + 1;
                const replacement = normalizeLiveQuestion({
                    text: bank.questionText,
                    alternatives: bank.alternatives,
                    correctAnswer: bank.correctAnswer,
                });
                (application.versionSnapshots || []).forEach(snapshot => {
                    if (!Array.isArray(snapshot.questions)) snapshot.questions = [];
                    snapshot.questions.push({
                        ...replacement,
                        originalNumber: replacementNumber,
                        examNumber: snapshot.questions.length + 1,
                        alternatives: replacement.alternatives.map(alternative => ({ ...alternative, displayLetter: alternative.letter })),
                        isAdditional: true,
                        replacedQuestionNumber: originalNumber,
                        sourceBankKey: bank.key,
                    });
                });
                if (!Array.isArray(application.annulledQuestions)) application.annulledQuestions = [];
                if (!application.annulledQuestions.some(item => Number(item.questionNumber) === originalNumber)) {
                    application.annulledQuestions.push({
                        questionNumber: originalNumber,
                        mode: 'remover_do_total',
                        reason: 'Questao substituida durante a aplicacao.',
                        by: adminActor(req),
                        at: new Date().toISOString(),
                    });
                }
                applicationStateEntries(application.id).forEach(([, state]) => {
                    if (!Array.isArray(state.assignedQuestionNumbers)) state.assignedQuestionNumbers = [];
                    if (!state.assignedQuestionNumbers.includes(replacementNumber)) state.assignedQuestionNumbers.push(replacementNumber);
                    if (extraMinutes > 0 && Number(state.deadlineAt) > 0) state.deadlineAt += extraMinutes * 60000;
                });
                application.questionCount = Number(application.questionCount || 0) + 1;
                application.globalTimeAdjustment = Number(application.globalTimeAdjustment || 0) + extraMinutes;
                application.updatedAt = new Date().toISOString();
                markQuestionReports(application, originalNumber, 'replaced', adminActor(req));
                const onlineConfig = syncApplicationConfig(cls, application);
                const regraded = regradeApplicationSubmissions(application, cls, { req, reason: `troca da questão ${originalNumber}` });
                pushExamMessage(application, adminActor(req), `A questao ${originalNumber} foi anulada e uma questao adicional foi inserida no final da prova.${extraMinutes ? ` Foram acrescentados ${extraMinutes} minutos.` : ''}`);
                recordExamAudit('exam_question_replaced', application, adminActor(req), {
                    questionNumber: originalNumber,
                    replacementNumber,
                    bankQuestionKey: bank.key,
                    extraMinutes,
                    regraded,
                });
                await db.save();
                res.json({ success: true, replacementNumber, extraMinutes, regraded, config: onlineConfig });
            } catch (error) {
                res.status(error.status || 400).json({ error: error.message });
            }
        });
    });

    router.post('/api/admin/exam-config', (req, res) => {
        validateAdmin(req, res, async () => {
            const { studentClass, courseId, examKey, questionCount, excludedQuestions, shuffleQuestions, shuffleAnswers } = req.body;
            if (!studentClass || !examKey) return res.status(400).json({ error: 'Turma ou chave da prova não informada.' });
            const classes = db.memory.classes || [];
            const cls = findClassByNameAndCourse(classes, studentClass, courseId);
            if (!cls) return res.status(404).json({ error: 'Turma não encontrada.' });
            if (!isCourseExamKey(cls, examKey)) return res.status(400).json({ error: 'Avaliação não pertence ao curso da turma.' });
            if (!cls.examConfigs) cls.examConfigs = {};
            cls.examConfigs[examKey] = {
                questionCount: parseInt(questionCount, 10) || 20,
                excludedQuestions: Array.isArray(excludedQuestions) ? excludedQuestions.map(Number) : [],
                shuffleQuestions: shuffleQuestions !== false,
                shuffleAnswers: shuffleAnswers !== false,
                updatedAt: new Date().toISOString(),
            };
            await persistClasses(classes);
            res.json({ success: true, examConfigs: cls.examConfigs, examConfig: cls.examConfigs[examKey] });
        });
    });

    router.post('/api/admin/online-exam-config', (req, res) => {
        validateAdmin(req, res, async () => {
            const { studentClass, courseId, examKey, questionCount, excludedQuestions, shuffleQuestions, shuffleAnswers, durationMinutes, timerEnabled, maxAttempts } = req.body;
            if (!studentClass || !examKey) return res.status(400).json({ error: 'Turma ou chave da prova não informada.' });
            const parsedMaxAttempts = parseMaxAttempts(Object.prototype.hasOwnProperty.call(req.body || {}, 'maxAttempts')
                ? maxAttempts
                : DEFAULT_MAX_ATTEMPTS);
            if (!parsedMaxAttempts.valid) return res.status(400).json({ error: 'Tentativas deve ser um número entre 1 e 10.' });
            const classes = db.memory.classes || [];
            const cls = findClassByNameAndCourse(classes, studentClass, courseId);
            if (!cls) return res.status(404).json({ error: 'Turma não encontrada.' });
            if (!isCourseExamKey(cls, examKey)) return res.status(400).json({ error: 'Avaliação não pertence ao curso da turma.' });
            if (!cls.onlineExamConfigs) cls.onlineExamConfigs = {};
            const previousConfig = cls.onlineExamConfigs[examKey] || {};
            const updatedAt = new Date().toISOString();
            cls.onlineExamConfigs[examKey] = {
                ...previousConfig,
                questionCount: parseInt(questionCount, 10) || 20,
                excludedQuestions: Array.isArray(excludedQuestions) ? excludedQuestions.map(Number) : [],
                shuffleQuestions: shuffleQuestions !== false,
                shuffleAnswers: shuffleAnswers !== false,
                durationMinutes: parseInt(durationMinutes, 10) || DEFAULT_ONLINE_DURATION_MINUTES,
                timerEnabled: timerEnabled !== false,
                onlineActive: false,
                status: 'prepared',
                startTime: null,
                waitingRoomStartTimestamp: null,
                activeHistoryId: null,
                versionSnapshots: [],
                accessToken: normalizeExamToken(previousConfig.accessToken),
                maxAttempts: parsedMaxAttempts.value,
                preparedAt: updatedAt,
                updatedAt,
            };
            if (cls.activeExamKey === examKey) cls.activeExamKey = null;
            await persistClasses(classes);
            res.json({ success: true, onlineExamConfigs: cls.onlineExamConfigs, onlineExamConfig: cls.onlineExamConfigs[examKey] });
        });
    });

    router.post('/api/admin/release-item', (req, res) => {
        validateAdmin(req, res, async () => {
            const { studentClass, courseId, itemKey, released, studentEmail, historyId, applicationOptions } = req.body;
            if (!studentClass) return res.status(400).json({ error: 'Turma não informada.' });
            if (!itemKey) return res.status(400).json({ error: 'Chave do item não informada.' });
            const classes = db.memory.classes || [];
            const cls = findClassByNameAndCourse(classes, studentClass, courseId);
            if (!cls) return res.status(404).json({ error: 'Turma não encontrada.' });
            if (!isCourseItemKey(cls, itemKey)) return res.status(400).json({ error: 'Item não pertence ao curso da turma.' });

            const normalizedStudentEmail = (studentEmail || '').trim().toLowerCase();
            let affectedApplication = null;
            if (normalizedStudentEmail) {
                if (!cls.studentReleasedItems) cls.studentReleasedItems = {};
                if (!cls.studentReleasedItems[normalizedStudentEmail]) cls.studentReleasedItems[normalizedStudentEmail] = {};
                cls.studentReleasedItems[normalizedStudentEmail][itemKey] = !!released;
            } else {
                if (!cls.releasedItems) cls.releasedItems = {};
                if (itemKey.startsWith('Avaliacao_')) {
                    if (!cls.onlineExamConfigs) cls.onlineExamConfigs = {};
                    const previousConfig = cls.onlineExamConfigs[itemKey] || {};
                    if (released) {
                        const historyEntry = findOnlineHistoryEntry(cls, itemKey, historyId);
                        if (!historyEntry) {
                            return res.status(400).json({ error: 'Nenhuma aplicação salva com questões foi encontrada para preparar esta prova.' });
                        }
                        if (applicationOptions?.tokenEnabled === true && !normalizeExamToken(applicationOptions.accessToken)) {
                            return res.status(400).json({ error: 'O token deve conter exatamente 5 letras maiúsculas.' });
                        }
                        const parsedMaxAttempts = parseMaxAttempts(Object.prototype.hasOwnProperty.call(applicationOptions || {}, 'maxAttempts')
                            ? applicationOptions.maxAttempts
                            : (Object.prototype.hasOwnProperty.call(historyEntry, 'maxAttempts') ? historyEntry.maxAttempts : DEFAULT_MAX_ATTEMPTS));
                        if (!parsedMaxAttempts.valid) {
                            return res.status(400).json({ error: 'Tentativas deve ser um número entre 1 e 10.' });
                        }
                        const prepared = prepareApplicationFromHistory(cls, itemKey, historyEntry, applicationOptions || {}, req);
                        affectedApplication = prepared.application;
                        const targetStatus = Number(affectedApplication.waitingRoomDuration || 0) > 0 ? 'waiting' : 'running';
                        transitionExamApplication(affectedApplication, targetStatus, {
                            actor: adminActor(req),
                            waitingRoomDuration: affectedApplication.waitingRoomDuration,
                        });
                        cls.onlineExamConfigs[itemKey] = applicationToOnlineConfig(affectedApplication, previousConfig);
                        cls.releasedItems[itemKey] = true;
                        cls.activeExamKey = itemKey;
                        cls.activeApplicationId = affectedApplication.id;
                    } else {
                        affectedApplication = findExamApplication(db.memory.examApplications, previousConfig.applicationId);
                        if (affectedApplication && !['finished', 'cancelled'].includes(affectedApplication.status)) {
                            try {
                                transitionExamApplication(
                                    affectedApplication,
                                    ACTIVE_APPLICATION_STATUSES.has(affectedApplication.status) ? 'finished' : 'cancelled',
                                    { actor: adminActor(req) }
                                );
                            } catch (_) {}
                        }
                        cls.onlineExamConfigs[itemKey] = {
                            ...previousConfig,
                            onlineActive: false,
                            status: 'not_applied',
                            startTime: null,
                            waitingRoomStartTimestamp: null,
                            activeHistoryId: null,
                            applicationId: null,
                            accessToken: null,
                            versionSnapshots: [],
                            preparedAt: null,
                            updatedAt: new Date().toISOString(),
                        };
                        cls.releasedItems[itemKey] = false;
                        if (cls.activeExamKey === itemKey) cls.activeExamKey = null;
                        if (cls.activeApplicationId === previousConfig.applicationId) cls.activeApplicationId = null;
                    }
                } else {
                    cls.releasedItems[itemKey] = !!released;
                }
            }

            if (!normalizedStudentEmail) {
                if (!cls.releaseMeta) cls.releaseMeta = {};
                const actor = (req.adminAccount && (req.adminAccount.name || req.adminAccount.email)) || 'Administrador';
                cls.releaseMeta[itemKey] = { by: actor, at: new Date().toISOString(), released: !!released };
            }
            await persistClasses(classes);
            res.json({
                success: true,
                scope: normalizedStudentEmail ? 'student' : 'class',
                releasedItems: getReleasedItemsForClass(cls, normalizedStudentEmail),
                application: affectedApplication,
            });
        });
    });

    router.post('/api/admin/exam-history/add', (req, res) => {
        validateAdmin(req, res, async () => {
            const { studentClass, courseId, examKey, type, label, questionNumbers, examCode, printSnapshot, questionCount, excludedQuestions, shuffleQuestions, shuffleAnswers, durationMinutes, timerEnabled, waitingRoomMinutes, maxAttempts } = req.body;
            if (!studentClass || !examKey || !Array.isArray(questionNumbers) || questionNumbers.length === 0) {
                return res.status(400).json({ error: 'Dados incompletos para registrar histórico.' });
            }
            const parsedMaxAttempts = parseMaxAttempts(Object.prototype.hasOwnProperty.call(req.body || {}, 'maxAttempts')
                ? maxAttempts
                : DEFAULT_MAX_ATTEMPTS);
            if (!parsedMaxAttempts.valid) return res.status(400).json({ error: 'Tentativas deve ser um número entre 1 e 10.' });
            const classes = db.memory.classes || [];
            const cls = findClassByNameAndCourse(classes, studentClass, courseId);
            if (!cls) return res.status(404).json({ error: 'Turma não encontrada.' });
            if (!isCourseExamKey(cls, examKey)) return res.status(400).json({ error: 'Avaliação não pertence ao curso da turma.' });
            if (!cls.examHistory) cls.examHistory = {};
            if (!cls.examHistory[examKey]) cls.examHistory[examKey] = [];
            const parsedWaitingRoom = parseInt(waitingRoomMinutes, 10);
            const entry = {
                id: 'eh_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
                type: type || 'online',
                label: label || null,
                questionNumbers: questionNumbers.map(Number),
                examCode: examCode || null,
                printSnapshot: printSnapshot || null,
                versionSnapshots: Array.isArray(printSnapshot)
                    ? printSnapshot.slice(0, VERSION_LABELS.length).map((snapshot, index) => ({ version: VERSION_LABELS[index], ...snapshot }))
                    : [],
                questionCount: parseInt(questionCount, 10) || questionNumbers.length,
                excludedQuestions: Array.isArray(excludedQuestions) ? excludedQuestions.map(Number) : [],
                shuffleQuestions: shuffleQuestions !== false,
                shuffleAnswers: shuffleAnswers !== false,
                durationMinutes: parseInt(durationMinutes, 10) || DEFAULT_ONLINE_DURATION_MINUTES,
                timerEnabled: timerEnabled !== false,
                waitingRoomMinutes: Number.isFinite(parsedWaitingRoom) ? Math.max(0, parsedWaitingRoom) : DEFAULT_WAITING_ROOM_MINUTES,
                accessToken: normalizeExamToken(req.body.accessToken),
                maxAttempts: parsedMaxAttempts.value,
                createdAt: new Date().toISOString(),
            };
            cls.examHistory[examKey].push(entry);
            await persistClasses(classes);
            res.json({ success: true, entry });
        });
    });

    router.get('/api/admin/exam-history', (req, res) => {
        validateAdmin(req, res, () => {
            const { studentClass, courseId, examKey } = req.query;
            if (!studentClass || !examKey) return res.status(400).json({ error: 'Turma ou avaliação não informada.' });
            const cls = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId);
            if (!cls) return res.status(404).json({ error: 'Turma não encontrada.' });
            if (!isCourseExamKey(cls, examKey)) return res.status(400).json({ error: 'Avaliação não pertence ao curso da turma.' });
            res.json({ success: true, history: (cls.examHistory && cls.examHistory[examKey]) || [] });
        });
    });

    router.post('/api/admin/exam-history/delete', (req, res) => {
        validateAdmin(req, res, async () => {
            const { studentClass, courseId, examKey, entryId } = req.body;
            if (!studentClass || !examKey || !entryId) return res.status(400).json({ error: 'Dados insuficientes para exclusão.' });
            const classes = db.memory.classes || [];
            const cls = findClassByNameAndCourse(classes, studentClass, courseId);
            if (!cls) return res.status(404).json({ error: 'Turma não encontrada.' });
            if (!isCourseExamKey(cls, examKey)) return res.status(400).json({ error: 'Avaliação não pertence ao curso da turma.' });
            if (!cls.examHistory || !cls.examHistory[examKey]) return res.status(404).json({ error: 'Histórico não encontrado.' });
            const before = cls.examHistory[examKey].length;
            cls.examHistory[examKey] = cls.examHistory[examKey].filter(entry => entry.id !== entryId);
            if (cls.examHistory[examKey].length === before) return res.status(404).json({ error: 'Entrada não encontrada no histórico.' });
            await persistClasses(classes);
            res.json({ success: true });
        });
    });

    return router;
}

module.exports = { createAdminExamConfigRouter };
