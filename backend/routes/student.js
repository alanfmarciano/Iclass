const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../database.js');
const {
    DB_STUDENTS_FILE,
    DB_SUBMISSIONS_FILE,
    DB_CLASSES_FILE,
    DB_ADMINS_FILE,
    readJSON,
    writeJSON,
    normalizeIp,
    validateStudentSession,
    validateAnySession,
    sanitizeSubmissionForStudent,
    sanitizeOnlineExamConfigsForStudent,
    studentExamConfigSummary,
    studentExamConfigsSummary,
    studentBelongsToClass,
    sanitizeBroadcastMessageForStudent,
    canStudentViewAnswerKey,
    getReleasedItemsForClass,
    findClassByNameAndCourse,
    initializeExamState,
    accessibilityExtraMinutes,
    getCourseForClass,
    getCourseItemKeys,
    validateAdmin,
    validateAdminPermission,
    isProfessorAccount,
    adminCanAccessClass,
    adminCanAccessItem
} = require('../middlewares.js');
const { extractStudentFields, validateStudentFields, DEFAULT_STATUS } = require('../utils/students.js');
const { recordLoginLog, buildAcceptance, DEFAULT_TERMS_VERSION, DEFAULT_PRIVACY_VERSION } = require('../utils/security.js');
const attendanceUtil = require('../utils/attendance.js');
const settingsUtil = require('../utils/settings.js');
const { CONTENT_DIR } = require('../runtimePaths.js');
const { normalizeExamToken } = require('../utils/examToken.js');
const { effectiveStructure } = require('../utils/classContent.js');
const {
    ACTIVE_APPLICATION_STATUSES,
    createAttemptState,
    examStateKey,
    findExamApplication,
    findOpenAttemptState,
    listExamApplications,
} = require('../utils/examApplications.js');
const {
    countStudentExamAttempts,
    filterStudentExamAttempts,
    normalizeMaxAttempts,
} = require('../utils/examAttempts.js');
const { consolidateSubmissions, enrichSubmissionsWithAttemptResult } = require('../utils/submissionAttempts.js');
const { pruneExpiredStudentSessions } = require('../utils/studentSessions.js');
const {
    createSubmissionFromAttempt,
    questionsForAttempt,
} = require('../utils/examGrading.js');
const { attemptQuestionsAvailable, questionsForStudentAttempt } = require('../utils/attemptQuestions.js');

// Marca a presença automática do dia (origem "login"), no máx. 1x/dia, respeitando
// a config (liga/desliga + janela + fuso). Retorna true se criou o registro.
// Usada tanto no POST de login quanto no heartbeat (/api/ping): assim, alunos cuja
// sessão foi retomada pelo navegador (sem novo POST de login) também são marcados
// presentes ao voltarem no dia seguinte.
function ensureDailyLoginAttendance(rawEmail) {
    try {
        const normalizedEmail = String(rawEmail || '').trim().toLowerCase();
        if (!normalizedEmail) return false;
        const _stPres = settingsUtil.getSettings();
        if (!_stPres.attendance.autoOnLogin || !settingsUtil.withinAttendanceWindow(_stPres)) return false;
        const student = (db.memory.students || []).find(s => s.email && s.email.toLowerCase() === normalizedEmail);
        if (!student) return false;
        const status = String(student.status || '').trim().toLowerCase();
        if (!['ativo', 'active'].includes(status)) return false;
        if (!Array.isArray(db.memory.attendance)) db.memory.attendance = [];
        const _today = settingsUtil.today();
        const _firstClass = Array.isArray(student.classes) && student.classes[0];
        const _cls = student.studentClass || (_firstClass && (typeof _firstClass === 'string' ? _firstClass : _firstClass.name)) || '';
        if (!_cls) return false;
        const _courseId = (_firstClass && typeof _firstClass === 'object' && _firstClass.courseId) || student.courseId || '';
        // Já existe algum lançamento hoje para essa turma? (chamada do professor tem prioridade)
        const _hasToday = db.memory.attendance.some(a => a.studentEmail === normalizedEmail && a.date === _today
            && (!a.studentClass || a.studentClass === _cls));
        if (_hasToday) return false;
        // Grade do dia: se não é dia letivo, não cria registro (não inventa aulas).
        const classObj = findClassByNameAndCourse(db.memory.classes || [], _cls, _courseId)
            || (db.memory.classes || []).find(c => c.name === _cls);
        const gradeAulas = attendanceUtil.gradeForDate(classObj, _today);
        if (!gradeAulas.length) return false;
        // Marca por aula conforme a hora do login + tolerância da turma.
        const cfg = attendanceUtil.effectiveAttendanceConfig(classObj);
        const horaLogin = settingsUtil.nowHHMM();
        const aulas = attendanceUtil.deriveAulasFromArrival(gradeAulas, horaLogin, cfg.toleranciaMin);
        db.memory.attendance.push({
            id: 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            studentEmail: normalizedEmail,
            studentClass: _cls,
            courseId: _courseId,
            date: _today,
            origin: 'login',
            aulas,
            justificativa: null,
            markedBy: null,
            timestamp: Date.now(),
        });
        return true;
    } catch (e) { return false; }
}

function applicationForClass(cls, examKey, applicationId) {
    const configApplicationId = cls?.onlineExamConfigs?.[examKey]?.applicationId;
    const application = findExamApplication(db.memory.examApplications, applicationId || configApplicationId);
    if (!application) return null;
    if (application.examKey !== examKey) return null;
    if (application.studentClass !== cls.name) return null;
    if (application.courseId && cls.courseId && application.courseId !== cls.courseId) return null;
    return application;
}

function attemptContextForStudent({ application, studentEmail, examKey, create = false, studentClass, courseId } = {}) {
    if (!application) {
        const key = examStateKey({ studentEmail, examKey });
        return { key, state: db.memory.studentExamState[key] || null };
    }
    const open = findOpenAttemptState(db.memory.studentExamState, { applicationId: application.id, studentEmail });
    if (open) return open;

    // Migração transparente: uma tentativa aberta pela interface antiga é vinculada
    // à aplicação atual na primeira requisição nova.
    const legacyKey = examStateKey({ studentEmail, examKey });
    const legacyState = db.memory.studentExamState[legacyKey];
    if (legacyState && !legacyState.applicationId) {
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
    return { key, state };
}

// ----------------------------------------------------
// ROTAS DE REDE E PRESENÇA
// ----------------------------------------------------

// Ping do Aluno para manter a sessão online
router.get('/api/ping', validateStudentSession, (req, res) => {
    const email = req.query.email;
    if (email) {
        const normalizedEmail = email.toLowerCase();
        const clientIp = normalizeIp(req.ip || req.socket.remoteAddress);
        const existingSession = db.memory.sessions[normalizedEmail];
        
        if (existingSession && typeof existingSession === 'object') {
            // Presença serve só para o contador "online". Não bloqueamos por IP diferente
            // (isso fazia o aluno sumir da lista se o IP mudasse). O IP de login continua
            // sendo verificado nas rotas sensíveis (envio de prova, autosave etc.).
            existingSession.lastSeen = Date.now();
        } else {
            db.memory.sessions[normalizedEmail] = {
                lastSeen: Date.now(),
                ip: clientIp
            };
        }
        // Presença automática também no heartbeat: cobre alunos com sessão já ativa
        // (retomada do navegador), que não passam de novo pelo POST /api/student/login.
        if (ensureDailyLoginAttendance(normalizedEmail)) {
            db.save().catch(() => {});
        }
    }
    res.json({ success: true });
});

// Beacon de saída do aluno. Só encerra a PRÓPRIA sessão: sem autenticação qualquer
// pessoa na rede derrubava a sessão de um aluno pelo e-mail, inclusive durante a prova.
router.post('/api/student/leave', express.text({ type: 'text/plain' }), (req, res, next) => {
    if (typeof req.body === 'string') {
        let parsed = null;
        try { parsed = req.body.trim().startsWith('{') ? JSON.parse(req.body) : null; } catch (jsonErr) {}
        req.body = parsed && typeof parsed === 'object' ? parsed : { email: req.body.trim() };
    }
    next();
}, validateStudentSession, (req, res) => {
    delete db.memory.sessions[req.studentEmail];
    res.json({ success: true });
});

// Remove apenas sessões que atingiram o prazo absoluto. O heartbeat controla
// a presença exibida no monitor, mas uma aba em segundo plano pode ter seus
// timers suspensos pelo navegador e não pode perder a autenticação por isso.
const sessionCleanupInterval = setInterval(() => {
    const absoluteHours = Number(settingsUtil.getSettings().session.absoluteHours) || 8;
    pruneExpiredStudentSessions(db.memory.sessions, { absoluteTtlMs: absoluteHours * 3600000 });
}, 15 * 60 * 1000);
sessionCleanupInterval.unref();

// ----------------------------------------------------
// ROTAS DE API DO ALUNO
// ----------------------------------------------------

// Retorna a lista de turmas liberadas para cadastro de aluno
router.get('/api/classes', (req, res) => {
    const classes = readJSON(DB_CLASSES_FILE);
    const courses = db.memory.courses || [];
    const isCourseDeleted = (course) => course && (course.deleted === true || course.status === 'deleted' || course.status === 'inactive' || !!course.deletedAt);
    const activeClasses = classes.filter(c => c.registrationEnabled).map(c => {
        const course = courses.find(course => course.id === c.courseId);
        if (!course || isCourseDeleted(course)) return null;
        return {
            name: c.name,
            courseId: c.courseId,
            courseName: course ? course.name : 'Curso Desconhecido'
        };
    }).filter(Boolean);
    res.json(activeClasses);
});

// Retorna o status da prova ativa e itens liberados (específicos por turma).
// Exige sessão (aluno ou instrutor). O aluno precisa ter matrícula aprovada na turma
// e recebe só metadados das provas (estado, horários); enunciados e alternativas
// nunca vão por aqui. O instrutor continua recebendo a configuração completa (sem gabarito).
router.get('/api/status', validateAnySession, (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const studentClass = req.query.studentClass;
    const courseId = req.query.courseId;
    const studentEmail = req.query.studentEmail || req.query.email;
    if (!studentClass) {
        return res.json({ 
            activeExamKey: null,
            activeExamQuestionCount: 0,
            releasedItems: {}
        });
    }

    const classes = readJSON(DB_CLASSES_FILE);
    const cls = findClassByNameAndCourse(classes, studentClass, courseId);
    if (!cls) {
        return res.json({ 
            activeExamKey: null,
            activeExamQuestionCount: 0,
            releasedItems: {}
        });
    }

    if (req.requester.role === 'student') {
        if (!studentBelongsToClass(req.studentAccount, cls)) {
            return res.status(403).json({ error: 'Turma não autorizada para este estudante.' });
        }
        return res.json({
            examConfigs: cls.examConfigs || {},
            onlineExamConfigs: studentExamConfigsSummary(cls.onlineExamConfigs),
            releasedItems: getReleasedItemsForClass(cls, req.studentEmail),
            releaseMeta: cls.releaseMeta || {}
        });
    }

    res.json({
        examConfigs: cls.examConfigs || {},
        onlineExamConfigs: sanitizeOnlineExamConfigsForStudent(cls.onlineExamConfigs),
        releasedItems: getReleasedItemsForClass(cls, studentEmail),
        releaseMeta: cls.releaseMeta || {}
    });
});

function studentApplicationLabel(application, cls) {
    const evaluation = db.memory.evaluations?.[application.examKey];
    if (evaluation?.title || evaluation?.name) return evaluation.title || evaluation.name;

    const course = getCourseForClass(cls);
    const structure = effectiveStructure(course?.id, cls?.name)?.structure || course?.structure || db.memory.courseStructure || [];
    for (const module of structure) {
        const unit = (module?.units || []).find(item => item?.avaliacaoKey === application.examKey);
        if (unit?.name || unit?.title) return unit.name || unit.title;
    }
    return String(application.examKey || 'Prova').replace(/_/g, ' ');
}

// Campos da aplicação que o aluno pode ver. Lista branca: versionSnapshots (com o
// gabarito), versões sorteadas, ajustes e contestações de outros alunos ficam no servidor.
const STUDENT_APPLICATION_FIELDS = [
    'id',
    'examKey',
    'courseId',
    'studentClass',
    'status',
    'timerMode',
    'durationMinutes',
    'timerEnabled',
    'waitingRoomDuration',
    'startsAt',
    'endsAt',
    'maxAttempts',
    'questionCount',
    'tokenEnabled',
    'globalTimeAdjustment',
    'createdAt',
    'startedAt',
    'finishedAt',
    'updatedAt',
];

function applicationForStudent(application, cls, studentEmail) {
    const config = studentExamConfigSummary(cls.onlineExamConfigs?.[application.examKey]);
    const maxAttempts = normalizeMaxAttempts(application.maxAttempts ?? config?.maxAttempts);
    const attemptsUsed = countStudentExamAttempts(db.memory.submissions, {
        studentEmail,
        examKey: application.examKey,
        courseId: application.courseId || cls.courseId,
        applicationId: application.id,
    });
    const openAttempt = findOpenAttemptState(db.memory.studentExamState, {
        applicationId: application.id,
        studentEmail,
    });
    const safeApplication = {};
    STUDENT_APPLICATION_FIELDS.forEach(field => {
        if (application[field] !== undefined) safeApplication[field] = application[field];
    });
    const course = getCourseForClass(cls);
    return {
        ...safeApplication,
        examTitle: studentApplicationLabel(application, cls),
        courseName: course?.name || course?.title || application.courseId || '',
        config,
        attemptsUsed,
        maxAttempts,
        attemptsExhausted: maxAttempts !== null && attemptsUsed >= maxAttempts && !openAttempt,
    };
}

router.get('/api/student/exam-applications', validateStudentSession, (req, res) => {
    const requestedClass = String(req.query.studentClass || '').trim();
    const requestedCourseId = String(req.query.courseId || '').trim();
    const classes = db.memory.classes || [];
    const enrolledClasses = classes.filter(cls => studentBelongsToClass(req.studentAccount, cls));
    let scopedClasses = enrolledClasses;

    if (requestedClass) {
        const cls = findClassByNameAndCourse(classes, requestedClass, requestedCourseId);
        if (!cls || !studentBelongsToClass(req.studentAccount, cls)) {
            return res.status(403).json({ error: 'Turma não autorizada para este estudante.' });
        }
        scopedClasses = [cls];
    } else if (requestedCourseId) {
        scopedClasses = enrolledClasses.filter(cls => !cls.courseId || cls.courseId === requestedCourseId);
    }

    const seen = new Set();
    const applications = scopedClasses
        .flatMap(cls => listExamApplications(db.memory.examApplications, {
            studentClass: cls.name,
            courseId: cls.courseId,
            statuses: ['waiting', 'running', 'paused'],
        }).map(application => ({ application, cls })))
        .filter(({ application }) => {
            if (seen.has(application.id)) return false;
            seen.add(application.id);
            return true;
        })
        .sort((a, b) => String(b.application.createdAt || '').localeCompare(String(a.application.createdAt || '')))
        .map(({ application, cls }) => applicationForStudent(application, cls, req.studentEmail));

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.json({ success: true, applications });
});

// Sincronização unificada durante a prova: estado, mensagens pop-up, configuração da
// prova e itens liberados em UMA única requisição (reduz a carga de polling na rede
// local quando há muitos alunos simultâneos).
router.get('/api/student/sync', validateStudentSession, (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    try {
        const email = req.studentEmail;
        const studentClass = req.query.studentClass;
        const courseId = req.query.courseId;
        const examKey = (req.query.examKey || '').trim();
        if (!email || !studentClass) {
            return res.status(400).json({ error: 'email e studentClass são obrigatórios.' });
        }

        const classes = db.memory.classes || [];
        const cls = findClassByNameAndCourse(classes, studentClass, courseId);
        if (!cls) {
            return res.json({
                success: true,
                onlineExamConfigs: {},
                releasedItems: {},
                state: null,
                messages: [],
                examConfigVersion: null,
                attemptsUsed: 0,
                maxAttempts: null
            });
        }

        // Só aluno com matrícula aprovada na turma sincroniza (e cria tentativa) nela.
        if (!studentBelongsToClass(req.studentAccount, cls)) {
            return res.status(403).json({ error: 'Turma não autorizada para este estudante.' });
        }

        // Só a configuração (metadados) da prova pedida; nada das outras provas da turma.
        const studentConfigs = examKey ? studentExamConfigsSummary(cls.onlineExamConfigs, examKey) : {};
        const releasedItems = getReleasedItemsForClass(cls, email);

        let state = null;
        let messages = [];
        let examConfigVersion = null;
        let attemptsUsed = 0;
        let maxAttempts = null;
        let application = null;
        let attemptId = null;
        let tokenAccepted = false;
        let questionReports = [];
        let finishOutcome = null;
        let questions = null;
        let questionsVersion = null;

        if (examKey) {
            const onlineCfg = cls.onlineExamConfigs && cls.onlineExamConfigs[examKey];
            application = applicationForClass(cls, examKey, req.query.applicationId);
            if (req.query.applicationId && !application) {
                return res.status(404).json({ error: 'Aplicação de prova não encontrada para esta turma.' });
            }
            maxAttempts = normalizeMaxAttempts(application?.maxAttempts ?? onlineCfg?.maxAttempts);
            attemptsUsed = countStudentExamAttempts(db.memory.submissions, {
                studentEmail: email,
                examKey,
                courseId: cls.courseId || courseId,
                applicationId: application?.id,
            });
            const attemptsExhausted = maxAttempts !== null && attemptsUsed >= maxAttempts;
            const context = application
                ? attemptContextForStudent({
                    application,
                    studentEmail: email,
                    examKey,
                    studentClass: cls.name,
                    courseId: cls.courseId,
                    create: !attemptsExhausted && ['waiting', 'running', 'paused'].includes(application.status),
                })
                : attemptContextForStudent({ studentEmail: email, examKey });
            const stateKey = context.key || examStateKey({ studentEmail: email, examKey });
            const rawState = context.state || {
                studentEmail: email,
                examKey,
                answers: {},
                timerRemaining: null,
                assignedVersion: 'A',
                individualTimeAdjustment: 0
            };
            // Sorteia a versão da prova (uma vez) quando ela está ativa e tem múltiplas versões.
            if (onlineCfg && !attemptsExhausted && initializeExamState(rawState, onlineCfg)) {
                rawState.studentEmail = email;
                rawState.examKey = examKey;
                rawState.studentClass = cls.name;
                rawState.courseId = cls.courseId || null;
                if (application) rawState.applicationId = application.id;
                db.memory.studentExamState[stateKey] = rawState;
                db.save();
            }

            // Não expõe a flag interna de validação de token ao cliente.
            const { tokenValidated, ...safeState } = rawState;
            state = safeState;
            attemptId = rawState.attemptId || null;
            tokenAccepted = rawState.tokenValidated === true;

            // Questões só da tentativa iniciada (aplicação em andamento, token validado)
            // e só quando o cliente ainda não tem esta versão delas.
            if (attemptQuestionsAvailable({ application, onlineConfig: onlineCfg, state: rawState })) {
                const delivered = questionsForStudentAttempt({
                    application,
                    onlineConfig: onlineCfg,
                    state: rawState,
                    evaluation: db.memory.evaluations?.[examKey],
                });
                questionsVersion = delivered.questionsVersion;
                if (String(req.query.questionsVersion || '') !== questionsVersion) questions = delivered.questions;
            }

            messages = (db.memory.broadcastMessages || []).filter(m =>
                !m.adminDeleted &&
                m.studentClass &&
                m.studentClass.toLowerCase() === String(studentClass).trim().toLowerCase() &&
                (!m.courseId || String(m.courseId) === String(courseId || '')) &&
                (!m.examKey || String(m.examKey) === String(examKey || '')) &&
                (!application || !m.applicationId || m.applicationId === application.id) &&
                (m.targetEmail === null || (m.targetEmail && m.targetEmail.toLowerCase() === email)) &&
                !(m.acknowledgedBy || []).includes(email) &&
                !(m.deletedFor || []).includes(email) &&
                m.status !== 'read'
            ).map(m => sanitizeBroadcastMessageForStudent(m, email));

            const cfg = cls.onlineExamConfigs && cls.onlineExamConfigs[examKey];
            examConfigVersion = cfg ? (cfg.updatedAt || null) : null;
            questionReports = application
                ? (application.questionReports || [])
                    .filter(report => String(report.studentEmail || '').toLowerCase() === email)
                    .map(report => ({
                        id: report.id,
                        questionNumber: report.questionNumber,
                        reason: report.reason,
                        status: report.status,
                        createdAt: report.createdAt,
                        resolvedAt: report.resolvedAt || null,
                    }))
                : [];
            if (application?.status === 'finished') {
                const savedByInstructor = (db.memory.submissions || []).some(submission =>
                    submission?.applicationId === application.id
                    && String(submission.student?.email || '').toLowerCase() === email
                    && submission.submissionSource === 'instructor_finish');
                finishOutcome = savedByInstructor
                    ? 'submitted'
                    : (application.finishResolution?.policy === 'discard' ? 'discarded' : null);
            }
        }

        res.json({
            success: true,
            onlineExamConfigs: studentConfigs,
            releasedItems,
            state,
            questions,
            questionsVersion,
            messages,
            examConfigVersion,
            attemptsUsed,
            maxAttempts,
            applicationId: application?.id || null,
            attemptId,
            tokenAccepted,
            questionReports,
            finishOutcome,
            examTitle: examKey ? studentApplicationLabel({ examKey }, cls) : null,
            accessibilityExtraMinutes: examKey && cls.onlineExamConfigs?.[examKey]?.timerEnabled !== false
                ? accessibilityExtraMinutes(email, cls.onlineExamConfigs?.[examKey]?.durationMinutes)
                : 0
        });
    } catch (err) {
        console.error('Erro no sync unificado do estudante:', err);
        res.status(500).json({ error: 'Erro interno no servidor.' });
    }
});

// Cadastro de Aluno
router.post('/api/student/register', (req, res) => {
    const { rateLimit } = require('../utils/rateLimit.js');
    const _rl = rateLimit(`student-register:${normalizeIp(req.ip || req.socket.remoteAddress)}`, { max: 10, windowMs: 60000 });
    if (!_rl.allowed) {
        return res.status(429).json({ error: 'Muitos cadastros seguidos. Aguarde um instante e tente novamente.' });
    }
    const { password, studentClass, courseId } = req.body;
    const fields = extractStudentFields(req.body);

    if (!fields.name || !fields.email || !password || !studentClass || !courseId) {
        return res.status(400).json({ error: 'Dados incompletos.' });
    }

    const classes = readJSON(DB_CLASSES_FILE);
    const matchedClass = classes.find(c => c.name === studentClass && c.courseId === courseId && c.registrationEnabled);
    if (!matchedClass) {
        return res.status(400).json({ error: 'A turma selecionada não existe ou não está liberada para cadastro.' });
    }

    const period = matchedClass.period || 'Tarde';
    const students = readJSON(DB_STUDENTS_FILE);

    // Autocadastro: apenas campos que o aluno pode informar sem prejuízo ao admin.
    // Matrícula, unidade e status NÃO são autodeclarados — ficam sob controle do admin
    // (status sempre nasce "Ativo").
    const selfFields = {
        name: fields.name,
        nomeSocial: fields.nomeSocial,
        email: fields.email,
        phone: fields.phone,
        guardian: fields.guardian,
    };
    const validation = validateStudentFields(selfFields, students, null);
    if (!validation.ok) {
        return res.status(400).json({ error: validation.error });
    }

    if (!req.body.acceptedTerms) {
        return res.status(400).json({ error: 'É necessário aceitar os Termos de Uso e a Política de Privacidade.' });
    }

    const enrollmentRequest = {
        id: `enrollment_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        courseId,
        requestedClassName: studentClass,
        requestedPeriod: period,
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        reviewedAt: null,
        reviewedBy: null,
        rejectionReason: '',
    };
    const studentObj = {
        name: fields.name,
        nomeSocial: fields.nomeSocial || '',
        email: fields.email,
        phone: fields.phone || '',
        guardianPhone: (fields.guardian && fields.guardian.phone) || '',
        guardian: fields.guardian || null,
        matricula: '',
        unidade: '',
        status: DEFAULT_STATUS,
        password: db.hashPassword(String(password).trim()),
        classes: [],
        studentClass: '',
        period: '',
        enrollmentRequests: [enrollmentRequest],
        loginTime: null,
        recoveryRequested: false,
        termsAcceptance: buildAcceptance(DEFAULT_TERMS_VERSION, req),
        privacyAcceptance: buildAcceptance(DEFAULT_PRIVACY_VERSION, req),
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    students.push(studentObj);
    writeJSON(DB_STUDENTS_FILE, students);

    res.json({ success: true, enrollmentRequest });
});

function enrollmentPayload(student) {
    const allClasses = db.memory.classes || [];
    const allCourses = db.memory.courses || [];
    const rawClasses = Array.isArray(student.classes) && student.classes.length
        ? student.classes
        : (student.studentClass ? [student.studentClass] : []);
    const classes = rawClasses.map(item => {
        if (item && typeof item === 'object') return { name: item.name || '', courseId: item.courseId || '', period: item.period || '' };
        const cls = allClasses.find(candidate => candidate.name === item);
        return { name: String(item || ''), courseId: cls?.courseId || '', period: cls?.period || student.period || '' };
    }).filter(item => item.name);
    const courses = [...new Set(classes.map(item => item.courseId).filter(Boolean))].map(courseId => {
        const course = allCourses.find(item => item.id === courseId);
        const membership = classes.find(item => item.courseId === courseId);
        return { id: courseId, name: course?.name || courseId, description: course?.description || '', className: membership?.name || '' };
    });
    const requests = (student.enrollmentRequests || []).map(request => {
        const course = allCourses.find(item => item.id === request.courseId);
        return { ...request, courseName: course?.name || request.courseId };
    }).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    return { classes, courses, requests };
}

router.get('/api/student/enrollments', validateStudentSession, (req, res) => {
    res.json(enrollmentPayload(req.studentAccount));
});

router.post('/api/student/enrollments/request', validateStudentSession, async (req, res) => {
    const courseId = String(req.body.courseId || '').trim();
    const studentClass = String(req.body.studentClass || '').trim();
    const matchedClass = (db.memory.classes || []).find(item => item.courseId === courseId && item.name === studentClass && item.registrationEnabled);
    if (!matchedClass) return res.status(400).json({ error: 'A turma não está disponível para matrícula.' });
    const student = req.studentAccount;
    const memberships = Array.isArray(student.classes) ? student.classes : [];
    if (memberships.some(item => item && typeof item === 'object' && item.courseId === courseId)) {
        return res.status(409).json({ error: 'Você já está matriculado neste curso.' });
    }
    if (!Array.isArray(student.enrollmentRequests)) student.enrollmentRequests = [];
    if (student.enrollmentRequests.some(item => item.courseId === courseId && item.status === 'pending')) {
        return res.status(409).json({ error: 'Já existe uma solicitação pendente para este curso.' });
    }
    const request = {
        id: `enrollment_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        courseId,
        requestedClassName: studentClass,
        requestedPeriod: matchedClass.period || '',
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        reviewedAt: null,
        reviewedBy: null,
        rejectionReason: '',
    };
    student.enrollmentRequests.push(request);
    student.updatedAt = Date.now();
    await db.save();
    res.json({ success: true, request });
});

router.post('/api/student/enrollments/cancel', validateStudentSession, async (req, res) => {
    const request = (req.studentAccount.enrollmentRequests || []).find(item => item.id === req.body.id);
    if (!request) return res.status(404).json({ error: 'Solicitação não encontrada.' });
    if (request.status !== 'pending') return res.status(409).json({ error: 'Somente solicitações pendentes podem ser canceladas.' });
    request.status = 'cancelled';
    request.updatedAt = Date.now();
    req.studentAccount.updatedAt = Date.now();
    await db.save();
    res.json({ success: true });
});

// ===================== BIBLIOTECA DO ALUNO =====================
router.get('/api/student/library', validateStudentSession, (req, res) => {
    const email = req.studentEmail;
    const courseId = String(req.query.courseId || '').trim();
    const studentClass = String(req.query.studentClass || '').trim();
    const student = (db.memory.students || []).find(s => s.email && s.email.toLowerCase() === email);
    if (!student) return res.json([]);
    const cls = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId);
    if (!cls || !studentBelongsToClass(student, cls)) return res.status(403).json({ error: 'Contexto de turma não autorizado.' });
    // resolve nomes de módulo (matéria) por curso para agrupar
    const moduleName = {};
    (effectiveStructure(courseId, studentClass)?.structure || []).forEach(m => { moduleName[courseId + '::' + m.id] = m.name || m.id; });
    const courseEntries = (db.memory.library || []).filter(e => String(e.courseId || '') === courseId);
    const classEntries = courseEntries.filter(e => String(e.studentClass || '') === studentClass);
    const replaced = new Set(classEntries.map(e => e.sourceLibraryId).filter(Boolean));
    const list = [
        ...courseEntries.filter(e => !e.studentClass && !e.hidden && !replaced.has(e.id)),
        ...classEntries.filter(e => !e.hidden),
    ];
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const access = encodeURIComponent(String(req.get('x-session-token') || ''));
    res.json(list.map(e => ({
        id: e.id, name: e.name, url: e.kind === 'link' ? e.url : `${e.url}${e.url.includes('?') ? '&' : '?'}access=${access}`, type: e.type, kind: e.kind,
        description: e.description, tags: e.tags || [],
        courseId: e.courseId,
        moduleId: e.moduleId || '',
        materia: e.moduleId ? (moduleName[e.courseId + '::' + e.moduleId] || e.moduleId) : 'Geral',
    })));
});


// ===================== AVISOS DO ALUNO =====================
router.get('/api/student/announcements', validateStudentSession, (req, res) => {
    const email = req.studentEmail;
    const courseId = String(req.query.courseId || '').trim();
    const studentClass = String(req.query.studentClass || '').trim();
    const student = (db.memory.students || []).find(s => s.email && s.email.toLowerCase() === email);
    if (!student) return res.json([]);
    const cls = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId);
    if (!cls || !studentBelongsToClass(student, cls)) return res.status(403).json({ error: 'Contexto de turma não autorizado.' });
    const today = settingsUtil.today(); // fuso configurado, como no restante do sistema
    let list = (db.memory.announcements || []).filter(a => {
        if (a.kind === 'calendar') return false;
        if (a.expiresAt && a.expiresAt < today) return false;
        if (a.target === 'todos') return true;
        if (a.target === 'turma') return String(a.targetValue || '') === studentClass && (!a.courseId || String(a.courseId) === courseId);
        if (a.target === 'curso') return String(a.targetValue || '') === courseId;
        if (a.target === 'aluno') return String(a.targetValue || '').toLowerCase() === email
            && (!a.courseId || String(a.courseId) === courseId)
            && (!a.studentClass || String(a.studentClass) === studentClass);
        return false;
    });
    list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.createdAt || 0) - (a.createdAt || 0));
    res.json(list.map(a => ({ id: a.id, title: a.title, message: a.message, priority: a.priority, pinned: a.pinned, createdAt: a.createdAt, authorName: a.authorName, read: (a.readBy || []).includes(email) })));
});

router.post('/api/student/announcements/read', validateStudentSession, (req, res) => {
    const email = req.studentEmail;
    const id = String(req.body.id || '');
    const ann = (db.memory.announcements || []).find(a => a.id === id);
    if (ann) { ann.readBy = ann.readBy || []; if (!ann.readBy.includes(email)) { ann.readBy.push(email); db.save(); } }
    res.json({ success: true });
});

router.get('/api/student/calendar-events', validateStudentSession, (req, res) => {
    const email = req.studentEmail;
    const requestedCourse = String(req.query.courseId || '').trim();
    const requestedClass = String(req.query.studentClass || '').trim();
    const student = (db.memory.students || []).find(s => s.email && s.email.toLowerCase() === email);
    if (!student) return res.json([]);
    const cls = findClassByNameAndCourse(db.memory.classes || [], requestedClass, requestedCourse);
    if (!cls || !studentBelongsToClass(student, cls)) return res.status(403).json({ error: 'Contexto de turma não autorizado.' });
    const list = (db.memory.announcements || [])
        .filter(item => {
            if (item.kind !== 'calendar') return false;
            if (requestedCourse && item.courseId !== requestedCourse) return false;
            if (item.target === 'curso') return String(item.targetValue || '') === requestedCourse;
            if (item.target === 'turma') return String(item.targetValue || '') === requestedClass && (!item.courseId || String(item.courseId) === requestedCourse);
            return false;
        })
        .sort((a, b) => String(a.eventDate).localeCompare(String(b.eventDate)) || String(a.startTime || '').localeCompare(String(b.startTime || '')))
        .map(item => ({
            id: item.id,
            title: item.title,
            description: item.message || '',
            eventDate: item.eventDate,
            startTime: item.startTime || '',
            endTime: item.endTime || '',
            eventType: item.eventType || 'outro',
            target: item.target,
            targetValue: item.targetValue,
            courseId: item.courseId,
            authorName: item.authorName || '',
        }));
    res.json(list);
});


// Login do aluno
router.post('/api/student/login', async (req, res) => {
    const { rateLimit } = require('../utils/rateLimit.js');
    const _rl = rateLimit(`student-login:${normalizeIp(req.ip || req.socket.remoteAddress)}`, { max: 30, windowMs: 60000 });
    if (!_rl.allowed) {
        return res.status(429).json({ error: 'Muitas tentativas de login. Aguarde um instante e tente novamente.' });
    }
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
    }

    const students = db.memory.students;
    const normalizedEmail = email.trim().toLowerCase();
    const student = students.find(s => s.email && s.email.toLowerCase() === normalizedEmail && db.verifyPassword(s.password, password.trim()));

    if (!student) {
        recordLoginLog(db.memory, { email: normalizedEmail, role: 'student', status: 'fail', reason: 'Credenciais inválidas', req });
        await db.save();
        return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    }

    const status = String(student.status || '').trim().toLowerCase();
    if (!['ativo', 'active'].includes(status)) {
        recordLoginLog(db.memory, { email: normalizedEmail, role: 'student', status: 'blocked', reason: `Status: ${student.status || 'não informado'}`, req });
        await db.save();
        return res.status(403).json({ error: 'Esta conta está bloqueada ou inativa. Procure o instrutor.' });
    }

    if (db.needsPasswordRehash(student.password)) student.password = db.hashPassword(password.trim());

    student.loginTime = new Date().toISOString();
    student.lastLoginAt = Date.now();
    student.lastLoginIp = normalizeIp(req.ip || req.socket.remoteAddress);
    recordLoginLog(db.memory, { email: normalizedEmail, role: 'student', status: 'success', req });
    // Presença automática por login: respeita config (liga/desliga, janela, fuso). Máx. 1/dia.
    // (mesma lógica reaproveitada no heartbeat /api/ping para sessões já ativas)
    ensureDailyLoginAttendance(normalizedEmail);
    // Sessão única: gera um token novo a cada login. Logins anteriores (em outros
    // dispositivos) deixam de valer porque o token guardado neles passa a divergir.
    const sessionToken = crypto.randomUUID
        ? crypto.randomUUID()
        : (Date.now().toString(36) + Math.random().toString(36).slice(2));
    db.memory.sessions[normalizedEmail] = {
        lastSeen: Date.now(),
        createdAt: Date.now(),
        ip: normalizeIp(req.ip || req.socket.remoteAddress),
        token: sessionToken
    };
    await db.save();

    // Retorna dados do estudante sem expor o campo de senha
    const { password: _, ...safeStudent } = student;
    
    const allClasses = db.memory.classes;
    const allCourses = db.memory.courses;
    const isCourseDeleted = (course) => course && (course.deleted === true || course.status === 'deleted' || course.status === 'inactive' || !!course.deletedAt);
    
    // Normalize classes array to always be objects
    const resolvedClasses = [];
    const studentCourses = [];
    
    const rawClasses = student.classes || (student.studentClass ? [student.studentClass] : []);
    
    rawClasses.forEach(c => {
        let className = '';
        let courseId = null;
        let period = student.period || null;
        
        if (typeof c === 'string') {
            className = c;
            // Lookup in allClasses to find courseId and period
            const cls = allClasses.find(clsObj => clsObj.name === c);
            if (cls) {
                courseId = cls.courseId;
                if (cls.period) period = cls.period;
            }
        } else if (c && typeof c === 'object') {
            className = c.name || '';
            courseId = c.courseId || null;
            period = c.period || student.period || null;
        }
        
        const courseObj = courseId ? allCourses.find(co => co.id === courseId) : null;
        if (courseObj && isCourseDeleted(courseObj)) {
            return;
        }

        if (className) {
            resolvedClasses.push({
                name: className,
                courseId: courseId,
                period: period
            });
            
            if (courseId) {
                if (courseObj && !studentCourses.some(sc => sc.id === courseObj.id)) {
                    studentCourses.push({
                        id: courseObj.id,
                        name: courseObj.name,
                        description: courseObj.description,
                        className: className
                    });
                }
            }
        }
    });
    
    safeStudent.classes = resolvedClasses;
    safeStudent.courses = studentCourses;
    safeStudent.enrollmentRequests = enrollmentPayload(student).requests;
    
    if (resolvedClasses.length > 0) {
        safeStudent.studentClass = resolvedClasses[0].name;
    } else {
        safeStudent.studentClass = '';
    }

    res.json({ success: true, student: safeStudent, sessionToken });
});

// Solicitação de recuperação de senha pelo aluno
router.post('/api/student/recover', (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ error: 'E-mail é obrigatório.' });
    }

    const { rateLimit } = require('../utils/rateLimit.js');
    const _rl = rateLimit(`student-recover:${normalizeIp(req.ip || req.socket.remoteAddress)}`, { max: 10, windowMs: 60000 });
    if (!_rl.allowed) {
        return res.status(429).json({ error: 'Muitas solicitações seguidas. Aguarde um instante e tente novamente.' });
    }

    const students = readJSON(DB_STUDENTS_FILE);
    const normalizedEmail = String(email).trim().toLowerCase();
    const student = students.find(s => s.email && s.email.toLowerCase() === normalizedEmail);

    // Resposta igual com ou sem cadastro: não revela quais e-mails existem.
    if (student) {
        student.recoveryRequested = true;
        writeJSON(DB_STUDENTS_FILE, students);
    }

    res.json({ success: true, message: 'Se o e-mail estiver cadastrado, o instrutor receberá a solicitação.' });
});


router.post('/api/student/exam-applications/:applicationId/start-attempt', validateStudentSession, async (req, res) => {
    const application = findExamApplication(db.memory.examApplications, req.params.applicationId);
    if (!application) return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });
    const cls = findClassByNameAndCourse(db.memory.classes || [], application.studentClass, application.courseId);
    if (!cls || !studentBelongsToClass(req.studentAccount, cls)) {
        return res.status(403).json({ error: 'Aplicação não autorizada para este estudante.' });
    }
    const config = cls.onlineExamConfigs?.[application.examKey];
    const now = Date.now();
    const mayStart = application.status === 'running'
        || (application.status === 'waiting' && Number(application.startsAt || 0) <= now);
    if (!mayStart || !config?.onlineActive) {
        return res.status(409).json({ error: 'A prova ainda não foi iniciada pelo professor.' });
    }

    const previousAttempts = filterStudentExamAttempts(db.memory.submissions, {
        studentEmail: req.studentEmail,
        examKey: application.examKey,
        courseId: application.courseId,
        applicationId: application.id,
    });
    const maxAttempts = normalizeMaxAttempts(application.maxAttempts);
    if (maxAttempts !== null && previousAttempts.length >= maxAttempts) {
        return res.status(403).json({
            error: 'Limite de tentativas atingido.',
            attemptsExhausted: true,
            attemptsUsed: previousAttempts.length,
            maxAttempts,
        });
    }

    const context = attemptContextForStudent({
        application,
        studentEmail: req.studentEmail,
        examKey: application.examKey,
        studentClass: cls.name,
        courseId: cls.courseId,
        create: true,
    });
    const state = context.state;
    if (application.tokenEnabled === true && state.tokenValidated !== true) {
        return res.status(403).json({ error: 'Valide o token antes de iniciar a tentativa.', tokenRequired: true });
    }
    if (!state.startedAt) {
        state.startedAt = application.timerMode === 'per_attempt'
            ? now
            : Math.min(now, Number(application.startsAt || now));
        state.status = 'active';
        state.accessibilityExtraMinutes = accessibilityExtraMinutes(req.studentEmail, application.durationMinutes);
        const totalMinutes = Number(application.durationMinutes || 0)
            + Number(application.globalTimeAdjustment || 0)
            + Number(state.individualTimeAdjustment || 0)
            + state.accessibilityExtraMinutes;
        state.deadlineAt = application.timerEnabled === false || totalMinutes <= 0
            ? null
            : state.startedAt + totalMinutes * 60000;
    }
    initializeExamState(state, config);
    db.memory.studentExamState[context.key] = state;
    await db.save();
    const { tokenValidated, ...safeState } = state;
    // A tentativa acabou de começar: as questões da versão do aluno já vão na resposta.
    const delivered = attemptQuestionsAvailable({ application, onlineConfig: config, state })
        ? questionsForStudentAttempt({ application, onlineConfig: config, state, evaluation: db.memory.evaluations?.[application.examKey] })
        : null;
    res.json({
        success: true,
        applicationId: application.id,
        attemptId: state.attemptId,
        attemptNumber: state.attemptNumber,
        state: safeState,
        examConfigVersion: state.examConfigVersion,
        questions: delivered ? delivered.questions : null,
        questionsVersion: delivered ? delivered.questionsVersion : null,
    });
});

// Envio de prova pelo aluno (com correção blindada no servidor)
const QUESTION_REPORT_REASONS = new Set([
    'sem_resposta_correta',
    'duas_corretas',
    'enunciado_confuso',
    'erro_digitacao',
    'outro',
]);

router.post('/api/student/report-question', validateStudentSession, async (req, res) => {
    const applicationId = String(req.body?.applicationId || '').trim();
    const attemptId = String(req.body?.attemptId || '').trim();
    const reason = String(req.body?.reason || '').trim();
    const text = String(req.body?.text || '').trim();
    const number = Number(req.body?.questionNumber);
    if (!applicationId || !attemptId || !Number.isFinite(number) || !QUESTION_REPORT_REASONS.has(reason)) {
        return res.status(400).json({ error: 'Dados da contestacao invalidos.' });
    }
    if (text.length > 300) return res.status(400).json({ error: 'O detalhe deve ter no maximo 300 caracteres.' });

    const application = findExamApplication(db.memory.examApplications, applicationId);
    if (!application) return res.status(404).json({ error: 'Aplicacao de prova nao encontrada.' });
    if (!['waiting', 'running', 'paused'].includes(application.status)) {
        return res.status(409).json({ error: 'Esta aplicacao ja foi encerrada.' });
    }
    const cls = findClassByNameAndCourse(db.memory.classes || [], application.studentClass, application.courseId);
    if (!cls || !studentBelongsToClass(req.studentAccount, cls)) {
        return res.status(403).json({ error: 'Aplicacao nao autorizada para este estudante.' });
    }
    const context = attemptContextForStudent({ application, studentEmail: req.studentEmail, examKey: application.examKey });
    const state = context.state;
    if (!state?.startedAt || state.attemptId !== attemptId) {
        return res.status(409).json({ error: 'A contestacao nao corresponde a tentativa ativa.' });
    }
    const resolved = questionsForAttempt({
        application,
        onlineConfig: cls.onlineExamConfigs?.[application.examKey],
        state,
        evaluation: db.memory.evaluations?.[application.examKey],
    });
    if (!resolved.assignedNumbers.includes(number)) {
        return res.status(400).json({ error: 'Esta questao nao pertence a tentativa do aluno.' });
    }

    if (!Array.isArray(application.questionReports)) application.questionReports = [];
    const duplicate = application.questionReports.find(report =>
        String(report.studentEmail || '').toLowerCase() === req.studentEmail
        && Number(report.questionNumber) === number);
    if (duplicate) {
        return res.status(409).json({ error: 'Voce ja reportou esta questao.', alreadyReported: true, report: duplicate });
    }
    const oneMinuteAgo = Date.now() - 60000;
    const recentCount = application.questionReports.filter(report =>
        String(report.studentEmail || '').toLowerCase() === req.studentEmail
        && new Date(report.createdAt || 0).getTime() >= oneMinuteAgo).length;
    if (recentCount >= 5) return res.status(429).json({ error: 'Aguarde um minuto antes de enviar novas contestacoes.' });

    const now = new Date().toISOString();
    const report = {
        id: `qreport_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        applicationId: application.id,
        attemptId: state.attemptId,
        examKey: application.examKey,
        studentClass: application.studentClass,
        courseId: application.courseId || null,
        questionNumber: number,
        questionPosition: resolved.assignedNumbers.indexOf(number) + 1,
        assignedVersion: resolved.assignedVersion,
        studentEmail: req.studentEmail,
        studentName: req.studentAccount?.name || req.studentEmail,
        reason,
        text,
        status: 'open',
        createdAt: now,
        resolvedBy: null,
        resolvedAt: null,
        resolutionAction: null,
    };
    application.questionReports.push(report);
    application.updatedAt = now;
    if (!Array.isArray(db.memory.auditLogs)) db.memory.auditLogs = [];
    db.memory.auditLogs.push({
        id: `audit_exam_report_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        type: 'exam_question_reported',
        actor: req.studentEmail,
        applicationId: application.id,
        examKey: application.examKey,
        studentClass: application.studentClass,
        courseId: application.courseId || null,
        details: { reportId: report.id, questionNumber: number, reason },
        timestamp: now,
    });
    await db.save();
    res.status(201).json({ success: true, report });
});

router.post('/api/student/submit', validateStudentSession, async (req, res) => {
    const { student = {}, studentClass: bodyStudentClass, courseId: bodyCourseId, examKey, applicationId, attemptId, answers, questionNumbers, examConfigVersion, auto } = req.body;
    if (!examKey || !answers || typeof answers !== 'object' || Array.isArray(answers)) {
        return res.status(400).json({ error: 'Dados inválidos ou incompletos.' });
    }
    const studentEmail = req.studentEmail;
    const registeredStudent = req.studentAccount;

    // Verifica se a prova enviada está de fato liberada para a turma do estudante
    const studentClass = bodyStudentClass || student.studentClass;
    const studentCourseId = bodyCourseId || student.courseId || student.currentCourseId || null;
    if (!studentClass) {
        return res.status(400).json({ error: 'Turma do estudante não informada.' });
    }

    const classes = readJSON(DB_CLASSES_FILE);
    const cls = findClassByNameAndCourse(classes, studentClass, studentCourseId);
    if (!cls) {
        return res.status(403).json({ error: 'Turma do estudante não encontrada.' });
    }
    if (!studentBelongsToClass(registeredStudent, cls)) {
        return res.status(403).json({ error: 'Estudante não pertence à turma informada.' });
    }
    
    const application = applicationForClass(cls, examKey, applicationId);
    if (applicationId && !application) {
        return res.status(404).json({ error: 'Aplicação de prova não encontrada para esta turma.' });
    }
    const onlineConfig = (cls.onlineExamConfigs && cls.onlineExamConfigs[examKey]) || {};
    if (application && onlineConfig.applicationId !== application.id) {
        return res.status(409).json({ error: 'Esta aplicação não é mais a aplicação ativa da prova.' });
    }
    // A prova aceita envio quando está liberada e em andamento: status 'running', ou
    // 'waiting' cuja sala de espera já terminou (o horário de início já passou).
    const nowTs = Date.now();
    const examStatus = onlineConfig.status || 'not_applied';
    const emAndamento = examStatus === 'running'
        || (examStatus === 'waiting' && onlineConfig.startTime && nowTs >= onlineConfig.startTime);
    if (onlineConfig.onlineActive !== true || !emAndamento) {
        return res.status(403).json({ error: 'Esta prova online ainda não está em andamento para a sua turma.' });
    }

    const previousAttempts = filterStudentExamAttempts(db.memory.submissions, {
        studentEmail,
        examKey,
        courseId: cls.courseId || studentCourseId,
        applicationId: application?.id,
    });
    const previousSameAttempt = attemptId
        ? previousAttempts.find(item => item.attemptId === attemptId)
        : null;
    if (previousSameAttempt) {
        return res.json({
            success: true,
            duplicate: true,
            submissionId: previousSameAttempt.id,
            gradePublished: previousSameAttempt.gradePublished === true,
            message: 'Esta tentativa já havia sido enviada.',
            examConfigVersion: previousSameAttempt.examConfigVersion || null,
        });
    }
    const maxAttempts = normalizeMaxAttempts(onlineConfig.maxAttempts);
    if (maxAttempts !== null && previousAttempts.length >= maxAttempts) {
        return res.status(403).json({
            error: 'Limite de tentativas atingido.',
            attemptsExhausted: true,
            attemptsUsed: previousAttempts.length,
            maxAttempts,
        });
    }

    // Trava real do token de acesso: se a prova exige token, só aceita o envio caso
    // o aluno tenha validado o token no servidor (impossível burlar pelo navegador).
    const attemptContext = application
        ? attemptContextForStudent({ application, studentEmail, examKey, studentClass: cls.name, courseId: cls.courseId })
        : attemptContextForStudent({ studentEmail, examKey });
    const stateKey = attemptContext.key;
    const lockedState = attemptContext.state;
    if (!lockedState || !lockedState.startedAt) {
        return res.status(409).json({ error: 'A prova ainda não foi iniciada no servidor.' });
    }
    if (attemptId && lockedState.attemptId && lockedState.attemptId !== attemptId) {
        return res.status(409).json({ error: 'A tentativa enviada não corresponde à tentativa ativa.' });
    }
    const deadlineExceededBy = lockedState.deadlineAt ? Date.now() - Number(lockedState.deadlineAt) : 0;
    const autoSubmitGrace = auto === true && deadlineExceededBy >= 0 && deadlineExceededBy <= 30000;
    if (lockedState.deadlineAt && deadlineExceededBy > 0 && !autoSubmitGrace) {
        return res.status(408).json({ error: 'O prazo da prova terminou.', deadlineExceeded: true });
    }

    const requiredExamToken = normalizeExamToken(onlineConfig.accessToken);
    if (onlineConfig.accessToken && !requiredExamToken) {
        return res.status(409).json({ error: 'O token configurado para esta prova é inválido. Solicite ao professor que prepare a aplicação novamente.' });
    }
    if (requiredExamToken && lockedState.tokenValidated !== true) {
        return res.status(403).json({
            error: 'Token de acesso não validado. Solicite o token ao professor e valide-o antes de enviar a prova.',
            tokenRequired: true
        });
    }

    if (lockedState.focusLocked === true) {
        return res.status(423).json({
            error: 'Sua prova foi bloqueada por perda de foco. Aguarde o professor desbloquear pelo monitor.',
            focusLocked: true
        });
    }

    // Tenta obter questoes estruturadas do banco de dados primeiro
    let questions;
    const evaluation = db.memory.evaluations[examKey];
    if (evaluation) {
        questions = evaluation.questions;
    } else {
        // Fallback: Localiza e lê o arquivo da prova antigo .md
        const filePath = path.join(CONTENT_DIR, `${examKey}.md`);
        try {
            await fs.promises.access(filePath, fs.constants.F_OK);
            const mdContent = await fs.promises.readFile(filePath, 'utf8');
            const parsedObj = parseEvaluationMarkdown(mdContent, examKey);
            questions = parsedObj ? parsedObj.questions : [];
        } catch (err) {}
    }
    
    if (!questions || questions.length === 0) {
        return res.status(500).json({ error: 'Falha ao processar avaliação no servidor.' });
    }

    questions = questions.map((question, index) => ({
        ...question,
        originalNumber: Number(question.originalNumber || question.number || index + 1)
    }));

    const currentExamConfigVersion = application?.contentVersion || onlineConfig.updatedAt || null;
    if (currentExamConfigVersion && examConfigVersion !== currentExamConfigVersion) {
        return res.status(409).json({
            error: 'O professor atualizou esta prova. A versão anterior deixa de valer; carregue a prova novamente para responder a versão nova.',
            examUpdated: true,
            currentExamConfigVersion
        });
    }

    const resolvedQuestions = questionsForAttempt({ application, onlineConfig, state: lockedState, evaluation });
    const serverQuestionNumbers = resolvedQuestions.assignedNumbers;

    if (serverQuestionNumbers.length === 0) {
        return res.status(400).json({ error: 'Esta prova não possui questões disponíveis para correção.' });
    }

    if (Array.isArray(questionNumbers)) {
        const clientQuestionNumbers = [...new Set(questionNumbers.map(Number).filter(Number.isFinite))];
        const sameSet = clientQuestionNumbers.length === serverQuestionNumbers.length
            && clientQuestionNumbers.every(qn => serverQuestionNumbers.includes(qn));
        if (!sameSet) {
            return res.status(409).json({ error: 'O conjunto de questões enviado diverge da prova atribuída pelo servidor.' });
        }
    }

    // Correção das respostas no servidor respeitando a configuração aplicada.
    const submissionObj = createSubmissionFromAttempt({
        application,
        onlineConfig,
        state: lockedState,
        evaluation,
        student: registeredStudent,
        answers,
        previousAttempts,
        source: auto === true ? 'timer_auto_submit' : 'student',
    });
    
    const submissions = db.memory.submissions;
    submissions.push(submissionObj);
    writeJSON(DB_SUBMISSIONS_FILE, submissions);

    lockedState.status = 'submitted';
    lockedState.submittedAt = submissionObj.timestamp;
    if (stateKey && db.memory.studentExamState[stateKey]) {
        delete db.memory.studentExamState[stateKey];
    }
    await db.save();

    res.json({
        success: true,
        gradePublished: false,
        submissionId: submissionObj.id,
        applicationId: application?.id || null,
        attemptId: submissionObj.attemptId,
        message: 'Prova enviada. A nota sera exibida apos a publicacao do professor.',
        examConfigVersion: currentExamConfigVersion
    });
});

// Obter histórico de submissões de um aluno
router.post('/api/student/my-submissions', validateStudentSession, (req, res) => {
    const email = req.studentEmail;
    const courseId = String(req.body.courseId || '').trim();
    const studentClass = String(req.body.studentClass || '').trim();
    const cls = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId);
    if (!cls || !studentBelongsToClass(req.studentAccount, cls)) return res.status(403).json({ error: 'Contexto de turma não autorizado.' });

    const submissions = readJSON(DB_SUBMISSIONS_FILE);
    const normalizedEmail = email.trim().toLowerCase();
    
    const ownSubmissions = submissions.filter(s => s.student && s.student.email && s.student.email.toLowerCase() === normalizedEmail)
        .filter(s => String(s.student?.courseId || s.courseId || '') === courseId && String(s.student?.studentClass || s.studentClass || '') === studentClass);
    const publishedResultById = new Map(
        enrichSubmissionsWithAttemptResult(ownSubmissions.filter(item => item.gradePublished === true))
            .map(item => [String(item.id), item])
    );
    const mySubmissions = ownSubmissions
        .map(s => ({
            ...s,
            resultStatus: s.resultStatus === 'archived' ? 'archived' : 'considered',
            aggregationPolicy: publishedResultById.get(String(s.id))?.aggregationPolicy || s.aggregationPolicy || 'highest',
            consolidatedScore: publishedResultById.get(String(s.id))?.consolidatedScore ?? null,
            countsTowardResult: publishedResultById.get(String(s.id))?.countsTowardResult === true,
        }))
        .map(s => {
            const canViewAnswerKey = canStudentViewAnswerKey(s, normalizedEmail);
            const sanitized = {
                ...sanitizeSubmissionForStudent(s, canViewAnswerKey),
                answerKeyReleased: canViewAnswerKey,
                // Nome legível da prova (o aluno via a chave técnica "Avaliacao_FUTEC_1").
                examTitle: studentApplicationLabel({ examKey: s.examKey }, cls)
            };
            // Fallback para a visualizacao completa da prova: quando o gabarito esta
            // liberado mas a submissao nao guardou o examSnapshot (submissoes antigas),
            // reconstroi examQuestions a partir da avaliacao de origem, limitando as
            // questoes que o aluno efetivamente respondeu (gradedAnswers).
            if (canViewAnswerKey && (!Array.isArray(sanitized.examQuestions) || sanitized.examQuestions.length === 0)) {
                const evaluation = db.memory.evaluations?.[s.examKey];
                const evalQuestions = Array.isArray(evaluation?.questions) ? evaluation.questions : [];
                if (evalQuestions.length && Array.isArray(s.gradedAnswers)) {
                    const byNumber = new Map(evalQuestions.map(q => [Number(q.originalNumber ?? q.number), q]));
                    const rebuilt = s.gradedAnswers
                        .map(a => {
                            const q = byNumber.get(Number(a.questionNumber));
                            if (!q) return null;
                            return {
                                number: Number(a.questionNumber),
                                text: typeof q.text === 'string' ? q.text : '',
                                alternatives: Array.isArray(q.alternatives)
                                    ? q.alternatives.map(alt => ({
                                        letter: String(alt?.letter || '').toUpperCase(),
                                        text: typeof alt?.text === 'string' ? alt.text : ''
                                    }))
                                    : []
                            };
                        })
                        .filter(Boolean);
                    if (rebuilt.length) sanitized.examQuestions = rebuilt;
                }
            }
            return sanitized;
        });

    res.json({ success: true, submissions: mySubmissions });
});

// Obter progresso do aluno (GET)
router.get('/api/student/progress', validateStudentSession, (req, res) => {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email não informado.' });
    
    const completedUnits = db.memory.progress[email.toLowerCase()] || {};
    res.json({ success: true, completedUnits });
});

// Sino do aluno: avisos não lidos, dúvidas respondidas, notas publicadas e prova
// liberada na turma ativa. "Visto" é um carimbo de tempo gravado no cadastro.
router.get('/api/student/notifications', validateStudentSession, (req, res) => {
    const email = req.studentEmail;
    const courseId = String(req.query.courseId || '').trim();
    const className = String(req.query.studentClass || '').trim();
    const student = req.studentAccount;
    const cls = findClassByNameAndCourse(db.memory.classes || [], className, courseId);
    if (!cls || !studentBelongsToClass(student, cls)) return res.status(403).json({ error: 'Contexto de turma não autorizado.' });
    const seenAt = Number(student.notificationsSeenAt || 0);
    const today = settingsUtil.today();
    const items = [];

    const visibleTarget = item => item.target === 'todos'
        || (item.target === 'curso' && String(item.targetValue || '') === courseId)
        || (item.target === 'turma' && String(item.targetValue || '') === className && (!item.courseId || String(item.courseId) === courseId))
        || (item.target === 'aluno' && String(item.targetValue || '').toLowerCase() === email
            && (!item.courseId || String(item.courseId) === courseId)
            && (!item.studentClass || String(item.studentClass) === className));
    (db.memory.announcements || [])
        .filter(item => item.kind !== 'calendar' && visibleTarget(item) && (!item.expiresAt || item.expiresAt >= today))
        .forEach(item => items.push({
            id: `aviso:${item.id}`, type: 'aviso', title: item.title || 'Aviso', text: String(item.message || '').slice(0, 140),
            at: Number(item.createdAt || 0), href: '/aluno/avisos', unread: !(item.readBy || []).includes(email),
        }));

    (db.memory.forum || [])
        .filter(c => c && !c.deleted && String(c.studentEmail || '').toLowerCase() === email)
        .forEach(c => {
            const context = inferLegacyForumContext(c);
            if (!context || context.courseId !== courseId || context.studentClass !== className) return;
            (c.replies || []).filter(r => !r.deleted && r.authorRole === 'Instrutor').forEach(r => {
                const at = Date.parse(r.timestamp) || 0;
                items.push({ id: `duvida:${r.id || at}`, type: 'duvida', title: 'Sua dúvida foi respondida', text: String(c.text || '').slice(0, 140), at, href: '/aluno/duvidas', unread: at > seenAt });
            });
        });

    (db.memory.submissions || [])
        .filter(s => s && s.gradePublished === true && String(s.student?.email || '').toLowerCase() === email
            && (!s.student?.courseId || String(s.student.courseId) === courseId) && (!s.student?.studentClass || String(s.student.studentClass) === className))
        .forEach(s => {
            const at = Number(s.gradePublishedAt || Date.parse(s.timestamp) || 0);
            items.push({ id: `nota:${s.id}`, type: 'nota', title: 'Nota publicada', text: studentApplicationLabel({ examKey: s.examKey }, cls), at, href: '/aluno/provas', unread: at > seenAt });
        });

    listExamApplications(db.memory.examApplications, { studentClass: cls.name, courseId: cls.courseId, statuses: ['waiting', 'running', 'paused'] })
        .forEach(application => {
            const at = Date.parse(application.startedAt || application.updatedAt || application.createdAt) || 0;
            items.push({
                id: `prova:${application.id}`, type: 'prova', title: application.status === 'waiting' ? 'Sala de espera aberta' : 'Prova disponível',
                text: studentApplicationLabel(application, cls), at, unread: at > seenAt,
                href: `/aluno/prova/${encodeURIComponent(application.examKey)}?applicationId=${encodeURIComponent(application.id)}`,
            });
        });

    items.sort((a, b) => b.at - a.at);
    const limited = items.slice(0, 30);
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, items: limited, unread: limited.filter(item => item.unread).length });
});

router.post('/api/student/notifications/seen', validateStudentSession, async (req, res) => {
    req.studentAccount.notificationsSeenAt = Date.now();
    await db.save();
    res.json({ success: true });
});

router.get('/api/student/dashboard', validateStudentSession, (req, res) => {
    const email = req.studentEmail;
    const courseId = String(req.query.courseId || '').trim();
    const className = String(req.query.studentClass || '').trim();
    const student = (db.memory.students || []).find(item => item.email && item.email.toLowerCase() === email);
    if (!student) return res.status(404).json({ error: 'Aluno nao encontrado.' });

    const classes = readJSON(DB_CLASSES_FILE);
    const cls = findClassByNameAndCourse(classes, className, courseId);
    if (!cls || !studentBelongsToClass(student, cls)) return res.status(403).json({ error: 'Contexto de turma não autorizado.' });
    const course = (db.memory.courses || []).find(item => item.id === courseId) || null;
    const structure = effectiveStructure(courseId, className)?.structure || [];
    const completed = db.memory.progress[email] || {};
    const released = cls ? getReleasedItemsForClass(cls, email) : {};
    const submissions = readJSON(DB_SUBMISSIONS_FILE)
        .filter(item => item.student?.email && item.student.email.toLowerCase() === email)
        .filter(item => (!courseId || !item.student?.courseId || item.student.courseId === courseId)
            && (!className || !item.student?.studentClass || item.student.studentClass === className));

    const modules = structure.map((module, moduleIndex) => {
        const units = module.units || module.items || [];
        const unitKeys = units.map(unit => unit.apostilaKey || unit.key).filter(Boolean);
        const examKeys = new Set(units.map(unit => unit.avaliacaoKey).filter(Boolean));
        const moduleSubmissions = submissions.filter(item => examKeys.has(item.examKey));
        const published = moduleSubmissions.filter(item => item.gradePublished === true && Number.isFinite(Number(item.score)));
        const consolidated = consolidateSubmissions(published).filter(item => item.score != null);
        const note = consolidated.length ? consolidated.reduce((sum, item) => sum + Number(item.score), 0) / consolidated.length / 10 : null;
        const done = unitKeys.filter(key => completed[key]).length;
        return {
            id: module.id || module.key || `module_${moduleIndex}`,
            name: module.name || module.title || `Modulo ${moduleIndex + 1}`,
            done,
            total: unitKeys.length,
            progress: unitKeys.length ? Math.round((done / unitKeys.length) * 100) : 0,
            note: note == null ? null : Number(note.toFixed(1)),
            noteStatus: note != null ? 'published' : moduleSubmissions.length ? 'review' : 'none',
        };
    });

    const publishedSubmissions = consolidateSubmissions(submissions.filter(item => item.gradePublished === true && Number.isFinite(Number(item.score))))
        .filter(item => item.score != null);
    const totalUnits = structure.flatMap(module => module.units || module.items || []).map(unit => unit.apostilaKey || unit.key).filter(Boolean);
    const completedCount = totalUnits.filter(key => completed[key]).length;
    const availableUnits = totalUnits.filter(key => released[key] === true);
    const pendingCount = availableUnits.filter(key => !completed[key]).length;
    const attendance = (db.memory.attendance || []).filter(item => item.studentEmail === email && (!className || !item.studentClass || item.studentClass === className));
    // Dedup por data (chamada > manual > login) e frequência por aula, geral —
    // mesmo motor do admin. null quando não há aulas lançadas.
    const attendanceRows = attendanceUtil.dedupeByDate(attendance);
    const frequency = attendanceUtil.computeAttendanceStats(attendanceRows).frequenciaGeral;

    const unitInfo = new Map();
    structure.forEach(module => (module.units || module.items || []).forEach(unit => {
        const key = unit.apostilaKey || unit.key;
        if (key) unitInfo.set(key, { key, title: unit.name || unit.title || key, moduleName: module.name || module.title || module.id || '' });
    }));
    const lastAccess = (db.memory.moduleAccess || [])
        .filter(item => item.studentEmail === email && (!courseId || !item.courseId || item.courseId === courseId))
        .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))[0];
    const continueItem = lastAccess && unitInfo.get(lastAccess.key) ? unitInfo.get(lastAccess.key) : (availableUnits.map(key => unitInfo.get(key)).find(Boolean) || null);

    const classNames = new Set([className].filter(Boolean));
    const courseIds = new Set([courseId].filter(Boolean));
    const visibleTarget = item => item.target === 'todos'
        || (item.target === 'curso' && courseIds.has(item.targetValue))
        || (item.target === 'turma' && classNames.has(item.targetValue) && (!item.courseId || courseIds.has(item.courseId)))
        || (item.target === 'aluno' && String(item.targetValue || '').toLowerCase() === email
            && (!item.courseId || String(item.courseId) === courseId)
            && (!item.studentClass || String(item.studentClass) === className));
    const today = settingsUtil.today();
    const announcements = (db.memory.announcements || [])
        .filter(item => item.kind !== 'calendar' && visibleTarget(item) && (!item.expiresAt || item.expiresAt >= today))
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
        .slice(0, 3)
        .map(item => ({ id: item.id, title: item.title, message: item.message, createdAt: item.createdAt, priority: item.priority }));
    const calendar = (db.memory.announcements || [])
        .filter(item => item.kind === 'calendar' && visibleTarget(item) && item.eventDate >= today)
        .sort((a, b) => String(a.eventDate).localeCompare(String(b.eventDate)) || String(a.startTime || '').localeCompare(String(b.startTime || '')))
        .slice(0, 4)
        .map(item => ({ id: item.id, title: item.title, eventDate: item.eventDate, startTime: item.startTime || '', eventType: item.eventType || 'outro' }));

    res.json({
        courseName: course?.name || courseId,
        modules,
        progress: totalUnits.length ? Math.round((completedCount / totalUnits.length) * 100) : 0,
        completedCount,
        totalUnits: totalUnits.length,
        overallNote: publishedSubmissions.length ? Number((publishedSubmissions.reduce((sum, item) => sum + Number(item.score), 0) / publishedSubmissions.length / 10).toFixed(1)) : null,
        frequency,
        pendingCount,
        continueItem,
        announcements,
        calendar,
        // Cada item é um grupo consolidado (prova/aplicação): id, prova e data vêm da tentativa mais recente.
        performance: publishedSubmissions
            .map(group => {
                const latest = [...group.attempts].sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))[0] || {};
                return { id: latest.id, examKey: latest.examKey, timestamp: latest.timestamp, note: Number((Number(group.score) / 10).toFixed(1)) };
            })
            .sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0))
            .slice(-5)
            .map(({ timestamp, ...item }) => item),
    });
});

// Atualizar progresso do aluno (POST)
// completedUnits: { [chaveDaUnidade]: true/false } (registros antigos podem ter listas).
router.post('/api/student/progress', validateStudentSession, (req, res) => {
    const { completedUnits } = req.body || {};
    const email = req.studentEmail;
    if (!email || !completedUnits) return res.status(400).json({ error: 'Dados incompletos.' });
    const entries = typeof completedUnits === 'object' && !Array.isArray(completedUnits) ? Object.entries(completedUnits) : null;
    if (!entries || entries.length > 2000 || entries.some(([key, value]) => !key || key.length > 200
        || !(typeof value === 'boolean' || (Array.isArray(value) && value.every(item => typeof item === 'string' || typeof item === 'number'))))) {
        return res.status(400).json({ error: 'Progresso em formato inválido.' });
    }

    db.memory.progress[email.toLowerCase()] = completedUnits;
    db.save();
    res.json({ success: true });
});

// Registra acesso a um módulo/apostila (Fase 4 — histórico de módulos acessados)
router.post('/api/student/track-access', validateStudentSession, (req, res) => {
    const { email, key, moduleKey, courseId } = req.body;
    if (!email || !key) return res.status(400).json({ error: 'Dados incompletos.' });
    if (!Array.isArray(db.memory.moduleAccess)) db.memory.moduleAccess = [];
    db.memory.moduleAccess.push({
        id: 'acc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        studentEmail: String(email).trim().toLowerCase(),
        key: String(key),
        moduleKey: moduleKey || '',
        courseId: courseId || '',
        timestamp: Date.now(),
    });
    if (db.memory.moduleAccess.length > 10000) db.memory.moduleAccess.splice(0, db.memory.moduleAccess.length - 10000);
    db.save();
    res.json({ success: true });
});

// ==========================================
// NOTAS (MEU CADERNO)
// ==========================================
router.post('/api/student/notes/save', validateStudentSession, (req, res) => {
    const { moduleKey, note } = req.body;
    const email = req.studentEmail;
    if (!moduleKey) return res.status(400).json({ error: 'Dados insuficientes' });
    
    if (!db.memory.notes[email]) {
        db.memory.notes[email] = {};
    }
    db.memory.notes[email][moduleKey] = note;
    db.save();
    res.json({ success: true });
});

router.post('/api/student/notes/get', validateStudentSession, (req, res) => {
    const { moduleKey } = req.body;
    const email = req.studentEmail;
    if (!moduleKey) return res.status(400).json({ error: 'Dados insuficientes' });
    
    const notesMap = db.memory.notes[email] || {};
    res.json({ success: true, note: notesMap[moduleKey] || "" });
});

// ==========================================
// ANOTAÇÕES E DESTAQUES POR PARÁGRAFO
// ==========================================
router.post('/api/student/annotation', validateStudentSession, (req, res) => {
    const { key, paragraphId, highlightedText, note } = req.body;
    const email = req.studentEmail;
    if (!key || !paragraphId) {
        return res.status(400).json({ error: 'Dados insuficientes' });
    }
    
    const lowerEmail = email.toLowerCase();
    if (!db.memory.annotations[lowerEmail]) {
        db.memory.annotations[lowerEmail] = {};
    }
    if (!db.memory.annotations[lowerEmail][key]) {
        db.memory.annotations[lowerEmail][key] = {};
    }
    
    if (note === null && highlightedText === null) {
        delete db.memory.annotations[lowerEmail][key][paragraphId];
        if (Object.keys(db.memory.annotations[lowerEmail][key]).length === 0) {
            delete db.memory.annotations[lowerEmail][key];
        }
    } else {
        db.memory.annotations[lowerEmail][key][paragraphId] = {
            highlightedText,
            note,
            timestamp: new Date().toISOString()
        };
    }
    
    db.save();
    res.json({ success: true });
});

router.get('/api/student/annotations', validateStudentSession, (req, res) => {
    const { key } = req.query;
    const email = req.studentEmail;
    if (!key) {
        return res.status(400).json({ error: 'Dados insuficientes' });
    }
    
    const lowerEmail = email.toLowerCase();
    const studentAnns = db.memory.annotations[lowerEmail] || {};
    res.json({ success: true, annotations: studentAnns[key] || {} });
});

// ==========================================
// FÓRUM / DÚVIDAS INTEGRADO
// ==========================================
// Quando a chamada vem do painel administrativo, aplica também o RBAC e o
// escopo de conteúdo da conta. Chamadas do portal do aluno mantêm o fluxo atual.
router.use('/api/forum', (req, res, next) => {
    const hasAdminCredentials = !!(req.headers['x-admin-session'] || req.headers.authorization);
    if (!hasAdminCredentials) return validateStudentSession(req, res, next);
    validateAdminPermission(req, res, 'page.forum', (config, matchedAdmin) => {
        let key = (req.body && req.body.key) || (req.query && req.query.key);
        if (!key && req.body && req.body.commentId) {
            const comment = (db.memory.forum || []).find(item => item.id === req.body.commentId);
            key = comment && comment.key;
        }
        if (key && !adminCanAccessItem(matchedAdmin, key)) {
            return res.status(403).json({ error: 'O tópico solicitado não pertence às turmas atribuídas a esta conta.' });
        }
        req.auth = { role: 'admin', email: matchedAdmin.email, admin: matchedAdmin };
        next();
    });
});

function inferLegacyForumContext(comment) {
    if (comment?.courseId || comment?.studentClass) return comment ? { courseId: String(comment.courseId || ''), studentClass: String(comment.studentClass || '') } : null;
    const student = (db.memory.students || []).find(item => String(item.email || '').toLowerCase() === String(comment?.studentEmail || '').toLowerCase());
    if (!student) return null;
    const matches = (db.memory.classes || []).filter(cls => studentBelongsToClass(student, cls))
        .filter(cls => comment.key === 'geral' || getCourseItemKeys(cls).has(comment.key));
    if (matches.length !== 1) return null;
    comment.courseId = String(matches[0].courseId || '');
    comment.studentClass = String(matches[0].name || '');
    return { courseId: comment.courseId, studentClass: comment.studentClass };
}

function forumContextAllowed(req, comment) {
    const context = inferLegacyForumContext(comment);
    if (!context) return false;
    const requestedCourseId = String(req.body?.courseId || req.query?.courseId || '').trim();
    const requestedClass = String(req.body?.studentClass || req.query?.studentClass || '').trim();
    if (requestedCourseId && requestedCourseId !== context.courseId) return false;
    if (requestedClass && requestedClass !== context.studentClass) return false;
    if (req.auth.role === 'admin') return adminCanAccessClass(req.auth.admin, context.studentClass, context.courseId);
    const cls = findClassByNameAndCourse(db.memory.classes || [], context.studentClass, context.courseId);
    return !!cls && studentBelongsToClass(req.studentAccount, cls);
}

function adminForumContextAllowed(req, matchedAdmin, comment) {
    const context = inferLegacyForumContext(comment);
    if (!context) return false;
    const requestedCourseId = String(req.body?.courseId || '').trim();
    const requestedClass = String(req.body?.studentClass || '').trim();
    if (requestedCourseId && requestedCourseId !== context.courseId) return false;
    if (requestedClass && requestedClass !== context.studentClass) return false;
    return adminCanAccessClass(matchedAdmin, context.studentClass, context.courseId);
}

router.get('/api/forum', (req, res) => {
    const { key } = req.query;
    const courseId = String(req.query.courseId || '').trim();
    const studentClass = String(req.query.studentClass || '').trim();
    if (!key) return res.status(400).json({ error: 'Falta a chave do material' });
    if (req.auth.role === 'student' && (courseId || studentClass)) {
        const cls = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId);
        if (!cls || !studentBelongsToClass(req.studentAccount, cls)) return res.status(403).json({ error: 'Contexto de turma não autorizado.' });
    }
    
    let migrated = false;
    const comments = db.memory.forum.filter(c => c.key === key && !c.deleted).filter(c => {
        if (!courseId && !studentClass) return true;
        const wasLegacy = !c.courseId && !c.studentClass;
        const context = inferLegacyForumContext(c);
        if (wasLegacy && context) migrated = true;
        return !!context && context.courseId === courseId && context.studentClass === studentClass;
    }).map(c => {
        const own = req.auth.role === 'admin' || String(c.studentEmail || '').toLowerCase() === req.auth.email;
        return {
            ...c,
            studentEmail: own ? c.studentEmail : undefined,
            isOwner: own,
            replies: (c.replies || []).filter(r => !r.deleted).map(r => ({
                ...r,
                authorEmail: req.auth.role === 'admin' || String(r.authorEmail || '').toLowerCase() === req.auth.email ? r.authorEmail : undefined,
            })),
        };
    });
    if (migrated) db.save();
    res.json({ success: true, comments });
});

// Todas as dúvidas do aluno na turma ativa (gerais e por unidade), com o nome da
// unidade e a lista de tópicos para abrir uma dúvida nova. A tela "Dúvidas" só
// mostrava o tópico "geral", então as perguntas feitas dentro das apostilas sumiam.
router.get('/api/student/my-forum', validateStudentSession, (req, res) => {
    const email = req.studentEmail;
    const courseId = String(req.query.courseId || '').trim();
    const studentClass = String(req.query.studentClass || '').trim();
    const cls = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId);
    if (!cls || !studentBelongsToClass(req.studentAccount, cls)) return res.status(403).json({ error: 'Contexto de turma não autorizado.' });

    const unitTitle = { geral: 'Dúvida geral' };
    const topics = [{ key: 'geral', title: 'Dúvida geral', module: '' }];
    (effectiveStructure(courseId, studentClass)?.structure || []).forEach(module => {
        (module.units || module.items || []).forEach(unit => {
            if (!unit.apostilaKey) return;
            unitTitle[unit.apostilaKey] = unit.name || unit.title || unit.apostilaKey;
            topics.push({ key: unit.apostilaKey, title: unitTitle[unit.apostilaKey], module: module.name || module.title || module.id || '' });
        });
    });

    const comments = (db.memory.forum || [])
        .filter(c => c && !c.deleted && String(c.studentEmail || '').toLowerCase() === email)
        .filter(c => {
            const context = inferLegacyForumContext(c);
            return !!context && context.courseId === courseId && context.studentClass === studentClass;
        })
        .map(c => ({
            id: c.id,
            key: c.key,
            unitTitle: unitTitle[c.key] || String(c.key || '').replace(/_/g, ' '),
            text: c.text,
            timestamp: c.timestamp,
            status: c.status || ((c.replies || []).some(r => !r.deleted && r.authorRole === 'Instrutor') ? 'respondida' : 'aberta'),
            isFaq: c.isFaq === true,
            replies: (c.replies || []).filter(r => !r.deleted).map(r => ({ id: r.id, authorName: r.authorName, authorRole: r.authorRole, text: r.text, timestamp: r.timestamp })),
        }))
        .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
    res.json({ success: true, comments, topics });
});

function adminActor(a) { return { name: (a && (a.name || a.email)) || 'Instrutor', email: (a && a.email) || db.defaultAdminEmail(), role: 'Instrutor' }; }
function logForumEvent(comment, type, actor, detail) {
    if (!Array.isArray(comment.events)) comment.events = [];
    comment.events.push({
        type,
        by: (actor && actor.email) || 'sistema',
        byName: (actor && actor.name) || (actor && actor.email) || 'Sistema',
        role: (actor && actor.role) || null,
        at: new Date().toISOString(),
        detail: detail || null,
    });
    if (comment.events.length > 100) comment.events = comment.events.slice(-100);
}

router.post('/api/forum/comment', (req, res) => {
    const { key, text } = req.body;
    const courseId = String(req.body.courseId || '').trim();
    const studentClass = String(req.body.studentClass || '').trim();
    if (req.auth.role !== 'student') return res.status(403).json({ error: 'Apenas alunos podem criar dúvidas por esta rota.' });
    if (!key || !text || text.trim() === '') {
        return res.status(400).json({ error: 'Campos obrigatórios não preenchidos' });
    }
    const cls = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId);
    const belongs = cls && studentBelongsToClass(req.studentAccount, cls);
    if (!belongs) return res.status(403).json({ error: 'A turma informada não pertence ao aluno autenticado.' });
    if (key !== 'geral' && !getCourseItemKeys(cls).has(key)) return res.status(403).json({ error: 'O tópico não pertence à turma ativa.' });
    
    const newComment = {
        id: 'comment_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        key,
        studentName: req.studentAccount.nomeSocial || req.studentAccount.name || req.studentEmail,
        studentEmail: req.studentEmail,
        courseId,
        studentClass,
        text: text.trim(),
        timestamp: new Date().toISOString(),
        replies: []
    };
    
    db.memory.forum.push(newComment);
    db.save();
    res.json({ success: true, comment: newComment });
});

router.post('/api/forum/reply', (req, res) => {
    const { commentId, text } = req.body;
    if (!commentId || !text || text.trim() === '') {
        return res.status(400).json({ error: 'Campos obrigatórios não preenchidos' });
    }
    
    const comment = db.memory.forum.find(c => c.id === commentId);
    if (!comment) {
        return res.status(404).json({ error: 'Comentário original não encontrado' });
    }
    if (!forumContextAllowed(req, comment)) return res.status(403).json({ error: 'A dúvida não pertence ao contexto ativo.' });
    
    const isAdminActor = req.auth.role === 'admin';
    const authorRole = isAdminActor ? 'Instrutor' : 'Aluno';
    const resolvedEmail = req.auth.email;
    const authorName = isAdminActor
        ? (req.auth.admin.name || req.auth.email)
        : (req.studentAccount.nomeSocial || req.studentAccount.name || req.auth.email);
    
    const newReply = {
        id: 'reply_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        authorName,
        authorRole,
        authorEmail: resolvedEmail,
        text: text.trim(),
        timestamp: new Date().toISOString()
    };
    
    comment.replies.push(newReply);
    logForumEvent(comment, 'reply', { name: authorName, email: resolvedEmail, role: authorRole });
    if (authorRole === 'Instrutor' && comment.status !== 'resolvida') comment.status = 'respondida';
    db.save();
    res.json({ success: true, reply: newReply });
});

router.post('/api/forum/comment/edit', (req, res) => {
    const { commentId, text } = req.body;
    if (!commentId || !text || text.trim() === '') {
        return res.status(400).json({ error: 'Dados incompletos.' });
    }

    const isAdmin = req.auth.role === 'admin';

    const comment = db.memory.forum.find(c => c.id === commentId);
    if (!comment) {
        return res.status(404).json({ error: 'Comentário não encontrado.' });
    }
    if (!forumContextAllowed(req, comment)) return res.status(403).json({ error: 'A dúvida não pertence ao contexto ativo.' });

    if (!isAdmin && String(comment.studentEmail || '').toLowerCase() !== req.auth.email) {
        return res.status(403).json({ error: 'Não autorizado a editar este comentário.' });
    }

    comment.text = text.trim();
    logForumEvent(comment, 'edit_comment', isAdmin ? adminActor(req.auth.admin) : { name: comment.studentName, email: comment.studentEmail, role: 'Aluno' });
    db.save();
    res.json({ success: true, comment });
});

router.post('/api/forum/comment/delete', (req, res) => {
    const { commentId } = req.body;
    if (!commentId) {
        return res.status(400).json({ error: 'Falta o ID do comentário.' });
    }

    const isAdmin = req.auth.role === 'admin';

    const commentIndex = db.memory.forum.findIndex(c => c.id === commentId);
    if (commentIndex === -1) {
        return res.status(404).json({ error: 'Comentário não encontrado.' });
    }

    const comment = db.memory.forum[commentIndex];
    if (!forumContextAllowed(req, comment)) return res.status(403).json({ error: 'A dúvida não pertence ao contexto ativo.' });

    if (!isAdmin && String(comment.studentEmail || '').toLowerCase() !== req.auth.email) {
        return res.status(403).json({ error: 'Não autorizado a excluir este comentário.' });
    }

    comment.deleted = true;
    comment.deletedAt = new Date().toISOString();
    comment.deletedBy = req.auth.email;
    logForumEvent(comment, 'delete_comment', isAdmin ? adminActor(req.auth.admin) : { name: comment.studentName, email: comment.studentEmail, role: 'Aluno' });
    db.save();
    res.json({ success: true });
});

router.post('/api/forum/reply/edit', (req, res) => {
    const { commentId, replyId, text } = req.body;
    if (!commentId || !replyId || !text || text.trim() === '') {
        return res.status(400).json({ error: 'Dados incompletos.' });
    }

    const isAdmin = req.auth.role === 'admin';

    const comment = db.memory.forum.find(c => c.id === commentId);
    if (!comment) {
        return res.status(404).json({ error: 'Comentário não encontrado.' });
    }
    if (!forumContextAllowed(req, comment)) return res.status(403).json({ error: 'A dúvida não pertence ao contexto ativo.' });

    const reply = comment.replies.find(r => r.id === replyId);
    if (!reply) {
        return res.status(404).json({ error: 'Resposta não encontrada.' });
    }

    const isCreator = reply.authorEmail && reply.authorEmail.toLowerCase() === req.auth.email;
    if (!isAdmin && !isCreator) {
        return res.status(403).json({ error: 'Não autorizado a editar esta resposta.' });
    }

    reply.text = text.trim();
    logForumEvent(comment, 'edit_reply', isAdmin ? adminActor(req.auth.admin) : { name: reply.authorName, email: reply.authorEmail, role: reply.authorRole });
    db.save();
    res.json({ success: true, reply });
});

router.post('/api/forum/reply/delete', (req, res) => {
    const { commentId, replyId } = req.body;
    if (!commentId || !replyId) {
        return res.status(400).json({ error: 'Dados incompletos.' });
    }

    const isAdmin = req.auth.role === 'admin';

    const comment = db.memory.forum.find(c => c.id === commentId);
    if (!comment) {
        return res.status(404).json({ error: 'Comentário não encontrado.' });
    }
    if (!forumContextAllowed(req, comment)) return res.status(403).json({ error: 'A dúvida não pertence ao contexto ativo.' });

    const replyIndex = comment.replies.findIndex(r => r.id === replyId);
    if (replyIndex === -1) {
        return res.status(404).json({ error: 'Resposta não encontrada.' });
    }

    const reply = comment.replies[replyIndex];
    const isCreator = reply.authorEmail && reply.authorEmail.toLowerCase() === req.auth.email;

    if (!isAdmin && !isCreator) {
        return res.status(403).json({ error: 'Não autorizado a excluir esta resposta.' });
    }

    logForumEvent(comment, 'delete_reply', isAdmin ? adminActor(req.auth.admin) : { name: reply.authorName, email: reply.authorEmail, role: reply.authorRole }, reply.text ? reply.text.slice(0, 80) : null);
    reply.deleted = true;
    reply.deletedAt = new Date().toISOString();
    reply.deletedBy = req.auth.email;
    db.save();
    res.json({ success: true });
});

// ----------------------------------------------------
// PAINEL DO INSTRUTOR — visão completa do fórum
// (Reconstruído: endpoint perdido no truncamento do arquivo. O frontend
//  espera { success, comments } com TODAS as dúvidas/respostas.)
// ----------------------------------------------------
router.post('/api/admin/forum/all', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const courseId = String(req.body?.courseId || '').trim();
        const studentClass = String(req.body?.studentClass || '').trim();
        const cls = studentClass ? findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId) : null;
        if (studentClass && !cls) return res.status(404).json({ error: 'Turma não encontrada.' });
        let comments = isProfessorAccount(matchedAdmin)
            ? (db.memory.forum || []).filter(comment => adminCanAccessItem(matchedAdmin, comment.key))
            : (db.memory.forum || []);
        let migrated = false;
        if (courseId || studentClass) {
            const allowedKeys = cls ? getCourseItemKeys(cls) : new Set();
            allowedKeys.add('geral');
            comments = comments.filter(comment => {
                const wasLegacy = !comment.courseId && !comment.studentClass;
                const context = inferLegacyForumContext(comment);
                if (wasLegacy && context) migrated = true;
                return !!context && context.courseId === courseId && context.studentClass === studentClass && allowedKeys.has(comment.key);
            });
        }
        if (migrated) db.save();
        res.json({ success: true, comments });
    });
});

router.post('/api/admin/forum/resolve', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const { commentId, resolved } = req.body;
        const comment = (db.memory.forum || []).find(c => c.id === commentId);
        if (!comment) return res.status(404).json({ error: 'Duvida nao encontrada.' });
        if (!adminForumContextAllowed(req, matchedAdmin, comment)) return res.status(403).json({ error: 'Dúvida fora do contexto ativo.' });
        if (isProfessorAccount(matchedAdmin) && !adminCanAccessItem(matchedAdmin, comment.key)) return res.status(403).json({ error: 'Sem acesso a esta duvida.' });
        if (resolved) {
            comment.status = 'resolvida';
            comment.resolvedBy = matchedAdmin.email;
            comment.resolvedAt = new Date().toISOString();
            logForumEvent(comment, 'resolved', adminActor(matchedAdmin));
        } else {
            comment.status = (comment.replies && comment.replies.some(r => r.authorRole === 'Instrutor')) ? 'respondida' : 'aberta';
            comment.resolvedBy = null;
            comment.resolvedAt = null;
            logForumEvent(comment, 'reopened', adminActor(matchedAdmin));
        }
        db.save();
        res.json({ success: true, comment });
    });
});

router.post('/api/admin/forum/faq', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const { commentId, faq } = req.body;
        const comment = (db.memory.forum || []).find(c => c.id === commentId);
        if (!comment) return res.status(404).json({ error: 'Duvida nao encontrada.' });
        if (!adminForumContextAllowed(req, matchedAdmin, comment)) return res.status(403).json({ error: 'Dúvida fora do contexto ativo.' });
        if (isProfessorAccount(matchedAdmin) && !adminCanAccessItem(matchedAdmin, comment.key)) return res.status(403).json({ error: 'Sem acesso a esta duvida.' });
        comment.isFaq = !!faq;
        comment.faqBy = faq ? matchedAdmin.email : null;
        comment.faqAt = faq ? new Date().toISOString() : null;
        logForumEvent(comment, faq ? 'faq_added' : 'faq_removed', adminActor(matchedAdmin));
        db.save();
        res.json({ success: true, comment });
    });
});

router.post('/api/admin/forum/restore', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const { commentId, replyId } = req.body;
        const comment = (db.memory.forum || []).find(c => c.id === commentId);
        if (!comment) return res.status(404).json({ error: 'Duvida nao encontrada.' });
        if (!adminForumContextAllowed(req, matchedAdmin, comment)) return res.status(403).json({ error: 'Dúvida fora do contexto ativo.' });
        if (isProfessorAccount(matchedAdmin) && !adminCanAccessItem(matchedAdmin, comment.key)) return res.status(403).json({ error: 'Sem acesso a esta duvida.' });
        if (replyId) {
            const reply = (comment.replies || []).find(r => r.id === replyId);
            if (!reply) return res.status(404).json({ error: 'Resposta nao encontrada.' });
            reply.deleted = false; reply.deletedAt = null; reply.deletedBy = null;
            logForumEvent(comment, 'restore_reply', adminActor(matchedAdmin));
        } else {
            comment.deleted = false; comment.deletedAt = null; comment.deletedBy = null;
            logForumEvent(comment, 'restore_comment', adminActor(matchedAdmin));
        }
        db.save();
        res.json({ success: true });
    });
});

router.post('/api/admin/forum/purge', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        if (isProfessorAccount(matchedAdmin)) return res.status(403).json({ error: 'Apenas administradores podem apagar definitivamente.' });
        const { commentId, replyId } = req.body;
        const idx = (db.memory.forum || []).findIndex(c => c.id === commentId);
        if (idx === -1) return res.status(404).json({ error: 'Duvida nao encontrada.' });
        if (!adminForumContextAllowed(req, matchedAdmin, db.memory.forum[idx])) return res.status(403).json({ error: 'Dúvida fora do contexto ativo.' });
        if (replyId) {
            const comment = db.memory.forum[idx];
            const rIdx = (comment.replies || []).findIndex(r => r.id === replyId);
            if (rIdx !== -1) comment.replies.splice(rIdx, 1);
        } else {
            db.memory.forum.splice(idx, 1);
        }
        db.save();
        res.json({ success: true });
    });
});

module.exports = router;
