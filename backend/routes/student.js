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
    getStudentReleasedItems,
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
    adminCanAccessItem,
    sendInternalError
} = require('../middlewares.js');
const { extractStudentFields, validateStudentFields, DEFAULT_STATUS, studentClassEntries, primaryStudentClassName } = require('../utils/students.js');
const { recordLoginLog } = require('../utils/security.js');
const legalAcceptance = require('../utils/legalAcceptance.js');
const attendanceUtil = require('../utils/attendance.js');
const settingsUtil = require('../utils/settings.js');
const { CONTENT_DIR } = require('../runtimePaths.js');
const { parseEvaluationMarkdown } = require('../utils/parser.js');
const { logError } = require('../utils/errorLog.js');
const { normalizeExamToken } = require('../utils/examToken.js');
const { effectiveStructure } = require('../utils/classContent.js');
const {
    ACTIVE_APPLICATION_STATUSES,
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
const { consolidateSubmissions, enrichSubmissionsWithAttemptResult, normalizeScore, roundGrade } = require('../utils/submissionAttempts.js');
const { scopeSubmissionsToContext } = require('../utils/gradebook.js');
const { createStudentSession, revokeStudentSession, pruneExpiredSessions, studentSessionByEmail } = require('../utils/authSessions.js');
const { attemptPasswordLogin } = require('../utils/passwordLogin.js');
const { studentSessionProfile } = require('../utils/studentProfile.js');
const { passwordPolicyRefusal, validateNewPassword } = require('../utils/passwordPolicy.js');
const {
    passwordChangeRuleActive,
    passwordChanged,
    requirePasswordChange,
    studentHasExamInProgress,
    studentPasswordChangeState,
} = require('../utils/passwordChange.js');
const { isInheritedKey } = require('../utils/ownEntry.js');
const serverLifecycle = require('../utils/serverLifecycle.js');
const {
    createSubmissionFromAttempt,
    questionsForAttempt,
} = require('../utils/examGrading.js');
const {
    AUTO_SUBMIT_EARLY_TOLERANCE_MS,
    NO_DEADLINE_AUTO_SUBMIT_MESSAGE,
    NO_DEADLINE_CODE,
    SERVER_DEADLINE_SOURCE,
    attemptOverdueMs,
    attemptStateForReopen,
    canReplaceServerFinalization,
    computeAttemptDeadline,
    countAnswers,
    extendedByServerOutage,
    finalizeAttemptState,
    lateSubmitDecision,
    markLateSubmission,
    replaceServerFinalization,
} = require('../utils/examDeadline.js');
const { ensureLocalCopyKey, localCopyKeyFor, stateWithoutSecrets } = require('../utils/examLocalCopy.js');
const { POSITION_LABELS, answerIdScope, decodeAttemptAnswers, stateForStudent } = require('../utils/examAnswerIds.js');
const { PAGE_RETURN_EVENT, pageExitReturnDecision, pageReturnDetails } = require('../utils/examFocusRules.js');
const { attemptQuestionsAvailable, questionsForStudentAttempt } = require('../utils/attemptQuestions.js');
const { visibleLibraryEntries } = require('../utils/studentLibrary.js');
const { recordAudit } = require('../utils/audit.js');
const { keystrokeModeOf } = require('../utils/keystrokePolicy.js');
const {
    attemptContextForStudent,
    collectiveTimeOverForNewAttempt,
    settleStudentAttempt,
} = require('../utils/studentAttemptContext.js');

// Marca a presença automática do dia (origem "login", exibida como "Automática"),
// no máx. 1x/dia por turma, respeitando a config (liga/desliga + janela + fuso).
// Usada tanto no POST de login quanto no heartbeat (/api/ping): assim, alunos cuja
// sessão foi retomada pelo navegador (sem novo POST de login) também são marcados
// presentes ao voltarem no dia seguinte.
// FUN-X2 / CRIT-02: só vale dentro da janela das aulas do dia da turma (do início da
// primeira aula menos a tolerância até o fim da última) e, se configurada, também da
// janela do Sistema. Fora disso o acesso não cria registro nem falta (quem entra às
// 18h para estudar não ganha falta nas aulas da manhã). Guarda IP, navegador e hora
// do acesso para o professor conferir na Chamada. Retorna true se criou o registro.
function ensureDailyLoginAttendance(rawEmail, { req = null, source = 'login' } = {}) {
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
        const horaAcesso = settingsUtil.nowHHMM(_stPres.timezone);
        // Turma da matrícula aprovada que tem aula agora (a turma principal primeiro).
        const primary = primaryStudentClassName(student).toLowerCase();
        const candidates = studentClassEntries(student)
            .sort((a, b) => (b.name.toLowerCase() === primary) - (a.name.toLowerCase() === primary))
            .map(entry => findClassByNameAndCourse(db.memory.classes || [], entry.name, entry.courseId)
                || (db.memory.classes || []).find(c => String(c.name || '').toLowerCase() === entry.name.toLowerCase()
                    && (!entry.courseId || !c.courseId || String(c.courseId) === entry.courseId)))
            .filter(cls => cls && studentBelongsToClass(student, cls));
        const classObj = candidates.find(cls => {
            const cfg = attendanceUtil.effectiveAttendanceConfig(cls);
            return attendanceUtil.withinClassDayWindow(attendanceUtil.gradeForDate(cls, _today), cfg.toleranciaMin, horaAcesso);
        });
        if (!classObj) return false;
        const _cls = classObj.name;
        const _courseId = String(classObj.courseId || '');
        // Já existe algum lançamento hoje para essa turma? (chamada do professor tem prioridade)
        const _hasToday = db.memory.attendance.some(a => a.studentEmail === normalizedEmail && a.date === _today
            && (!a.studentClass || a.studentClass === _cls)
            && (!a.courseId || !_courseId || String(a.courseId) === _courseId));
        if (_hasToday) return false;
        // Marca por aula conforme a hora do acesso + tolerância da turma.
        const cfg = attendanceUtil.effectiveAttendanceConfig(classObj);
        const gradeAulas = attendanceUtil.gradeForDate(classObj, _today);
        const aulas = attendanceUtil.deriveAulasFromArrival(gradeAulas, horaAcesso, cfg.toleranciaMin);
        db.memory.attendance.push({
            id: 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            studentEmail: normalizedEmail,
            studentClass: _cls,
            courseId: _courseId,
            date: _today,
            origin: 'login',
            source: source === 'heartbeat' ? 'heartbeat' : 'login',
            horaAcesso,
            ip: req ? normalizeIp(req.ip || (req.socket && req.socket.remoteAddress)) : '',
            userAgent: req ? String(req.get('user-agent') || '').slice(0, 300) : '',
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

// A mesma sessão voltou à página da prova logo depois de recarregar ou sair dela: a
// tentativa travada por essa saída destrava sozinha e o Monitor registra em quanto
// tempo ela voltou (regra única em utils/examFocusRules.js). Devolve se mudou algo.
function applyPageReturn(state, { sessionToken, application, cls, examKey }) {
    if (!state || state.focusLocked !== true || !state.pageExit) return false;
    const now = Date.now();
    const decision = pageExitReturnDecision(state, { sessionToken, now, outages: application?.outages });
    if (decision.expired) {
        // Passou do prazo: vale a regra de saída de sempre (o professor libera).
        delete state.pageExit;
        return true;
    }
    if (!decision.unlock) return false;
    state.focusLocked = false;
    state.focusUnlockedAt = now;
    state.focusUnlockedBy = null;
    delete state.pageExit;
    if (!Array.isArray(db.memory.proctoringLogs)) db.memory.proctoringLogs = [];
    db.memory.proctoringLogs.push({
        id: crypto.randomUUID ? crypto.randomUUID() : `${now}_${Math.random().toString(36).slice(2, 11)}`,
        studentEmail: state.studentEmail,
        studentClass: cls?.name || state.studentClass || '',
        courseId: cls?.courseId || state.courseId || null,
        examKey,
        applicationId: application?.id || null,
        attemptId: state.attemptId || null,
        timestamp: now,
        eventType: PAGE_RETURN_EVENT,
        details: pageReturnDetails(decision.seconds),
    });
    return true;
}

// Resultado de uma tentativa que o navegador conhece (inclusive a guardada antes de
// recarregar a página): diz se ela já virou entrega e de que forma.
function attemptOutcomeFor(application, studentEmail, attemptId) {
    if (!application || !attemptId) return null;
    const submission = (db.memory.submissions || []).find(item => item
        && item.attemptId === attemptId
        && item.applicationId === application.id
        && String(item.student?.email || '').toLowerCase() === studentEmail);
    if (!submission) return null;
    return {
        attemptId,
        submissionId: submission.id,
        source: submission.submissionSource || 'student',
        finalizedByServer: submission.submissionSource === SERVER_DEADLINE_SOURCE,
        submittedAt: submission.timestamp || null,
        answeredCount: Number.isFinite(Number(submission.answeredCount))
            ? Number(submission.answeredCount)
            : (submission.gradedAnswers || []).filter(item => item?.studentChoice).length,
        lateBySeconds: Number(submission.lateBySeconds || 0),
    };
}

// ----------------------------------------------------
// ROTAS DE REDE E PRESENÇA
// ----------------------------------------------------

// Ping do Aluno para manter a sessão online. validateStudentSession já conferiu a
// sessão (token e e-mail) e atualizou a presença (lastSeen), que serve só para o
// contador "online". O ramo antigo que criava aqui uma sessão sem token saiu: ele
// nunca era alcançado depois da validação e gravaria sessão que não é do login.
router.get('/api/ping', validateStudentSession, (req, res) => {
    if (req.query.email) {
        // Presença automática também no heartbeat: cobre alunos com sessão já ativa
        // (retomada do navegador), que não passam de novo pelo POST /api/student/login.
        // Rota quente (H1-c, DES-01): só a presença nova, sem segurar a resposta do
        // heartbeat (detached); a falha fica com a regravação de fundo do motor.
        if (ensureDailyLoginAttendance(req.studentEmail, { req, source: 'heartbeat' })) {
            db.save({ only: ['attendance', 'authSessions'], detached: true }).catch(() => {});
        }
    }
    // A tela do portal acompanha a troca obrigatória de senha por aqui (H5a): pedida pelo
    // professor com o aluno já logado, ou já feita em outro aparelho.
    const passwordChange = req.studentPasswordChange || {};
    res.json({
        success: true,
        passwordChangeRequired: passwordChange.required === true,
        ...(passwordChange.required ? { passwordChangeReason: passwordChange.reason } : {}),
    });
});

// Saída do aluno. Só encerra a PRÓPRIA sessão: sem autenticação qualquer pessoa na
// rede derrubava a sessão de um aluno pelo e-mail, inclusive durante a prova.
// - POST /api/student/logout: o "Sair" do portal (H5b, SEG-10). Antes o "Sair" só
//   apagava o navegador e o token seguia valendo no servidor por até 8 h (computador de
//   laboratório compartilhado);
// - POST /api/student/leave: o mesmo, com o corpo em texto (beacon de saída antigo).
function parseLeaveBody(req, res, next) {
    if (typeof req.body === 'string') {
        let parsed = null;
        try { parsed = req.body.trim().startsWith('{') ? JSON.parse(req.body) : null; } catch (jsonErr) {}
        req.body = parsed && typeof parsed === 'object' ? parsed : { email: req.body.trim() };
    }
    next();
}

async function endStudentSession(req, res) {
    // O motivo fica guardado: o pedido seguinte do token antigo (outra aba) recebe 401
    // com reason 'logout'. A sessão sai também da tabela auth_sessions (H3a-2): sem a
    // gravação ela voltaria depois de um reinício do servidor.
    revokeStudentSession(db.memory, req.studentEmail, { reason: 'logout' });
    await db.save();
    res.json({ success: true });
}

router.post('/api/student/logout', express.text({ type: 'text/plain' }), parseLeaveBody, validateStudentSession, endStudentSession);
router.post('/api/student/leave', express.text({ type: 'text/plain' }), parseLeaveBody, validateStudentSession, endStudentSession);

// Remove apenas sessões que atingiram o prazo absoluto. O heartbeat controla
// a presença exibida no monitor, mas uma aba em segundo plano pode ter seus
// timers suspensos pelo navegador e não pode perder a autenticação por isso.
// Tarefa de fundo: gravação { detached: true } (a falha vai para o crash.log pelo
// motor de gravação, que regrava sozinho).
// Registrada no ciclo de vida do servidor (H3c): o desligamento ordenado a para antes do
// db.close, e uma volta no meio do desligamento não grava num banco já fechado.
serverLifecycle.registerTimer('session-prune', setInterval(() => {
    const absoluteHours = Number(settingsUtil.getSettings().session.absoluteHours) || 8;
    const removed = pruneExpiredSessions(db.memory, { absoluteTtlMs: absoluteHours * 3600000 });
    if (removed) db.save({ detached: true }).catch(() => {});
}, 15 * 60 * 1000));

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
// nunca vão por aqui. Os itens liberados dele (e a máscara do gabarito) são os da conta
// da SESSÃO, nunca os do e-mail da URL. O instrutor continua recebendo a configuração
// completa (sem gabarito) e vê o que está gravado, sem a máscara do aluno, para
// conseguir bloquear pela tela um gabarito liberado (o e-mail da URL escolhe o aluno das
// liberações individuais, em Alunos).
router.get('/api/status', validateAnySession, (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const studentClass = req.query.studentClass;
    const courseId = req.query.courseId;
    const isAdmin = req.requester?.role === 'admin';
    const studentEmail = isAdmin
        ? String(req.query.studentEmail || req.query.email || '')
        : String(req.requester?.email || '');
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
            releasedItems: getStudentReleasedItems(cls, req.studentEmail),
            releaseMeta: cls.releaseMeta || {}
        });
    }

    res.json({
        examConfigs: cls.examConfigs || {},
        onlineExamConfigs: sanitizeOnlineExamConfigsForStudent(cls.onlineExamConfigs),
        releasedItems: isAdmin ? getReleasedItemsForClass(cls, studentEmail) : getStudentReleasedItems(cls, studentEmail),
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
    'keystrokeMode',
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
    safeApplication.keystrokeMode = keystrokeModeOf(application);
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
// Gravação parcial nas rotas quentes do aluno (H1-c, DES-01): db.save({ only }) com as
// coleções que a rota muda. Toda lista leva 'authSessions': a validação da sessão
// (validateStudentSession) registra o IP novo do aparelho (celular que troca de Wi-Fi) e
// completa a sessão de formato antigo, e isso vai para a tabela auth_sessions.
// Gravação parcial do sync: o estado da tentativa (sorteio,
// volta à página, chave da cópia local), o log da volta à página e a aplicação (a
// tentativa nova consome o "+N min" guardado para o aluno). A entrega de uma tentativa
// vencida (settleStudentAttempt) continua com a gravação completa.
const SYNC_SAVE_COLLECTIONS = ['studentExamState', 'proctoringLogs', 'examApplications', 'authSessions'];

router.get('/api/student/sync', validateStudentSession, (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    try {
        const email = req.studentEmail;
        const studentClass = req.query.studentClass;
        const courseId = req.query.courseId;
        const examKey = (req.query.examKey || '').trim();
        const knownAttemptId = String(req.query.attemptId || '').trim();
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
        // Máscara do gabarito da prova aberta para o aluno (G2: gabarito na reaplicação).
        const releasedItems = getStudentReleasedItems(cls, email);

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
        let attemptOutcome = null;
        let timeOver = false;
        let localCopyKey = null;
        let questions = null;
        let questionsVersion = null;

        if (examKey) {
            const onlineCfg = cls.onlineExamConfigs && cls.onlineExamConfigs[examKey];
            application = applicationForClass(cls, examKey, req.query.applicationId);
            if (req.query.applicationId && !application) {
                return res.status(404).json({ error: 'Aplicação de prova não encontrada para esta turma.' });
            }
            // Link antigo (aba aberta, link salvo) de uma aplicação já encerrada enquanto outra
            // aplicação da mesma prova está em andamento: a configuração da turma é a da nova.
            // A tela recebe a situação da aplicação que abriu; antes mostrava as instruções da
            // nova com um "Iniciar prova" que só devolvia "já foi encerrada".
            if (application && studentConfigs[examKey] && ['finished', 'cancelled'].includes(application.status)
                && onlineCfg?.applicationId !== application.id) {
                studentConfigs[examKey] = { ...studentConfigs[examKey], applicationId: application.id, status: application.status, onlineActive: false };
            }
            // Tentativa vencida vira entrega (com as respostas salvas) antes de qualquer
            // outra decisão: assim ela conta como usada e nunca é recriada vazia.
            settleStudentAttempt(application, email);
            maxAttempts = normalizeMaxAttempts(application?.maxAttempts ?? onlineCfg?.maxAttempts);
            attemptsUsed = countStudentExamAttempts(db.memory.submissions, {
                studentEmail: email,
                examKey,
                courseId: cls.courseId || courseId,
                applicationId: application?.id,
            });
            const attemptsExhausted = maxAttempts !== null && attemptsUsed >= maxAttempts;
            // Cronômetro coletivo esgotado para quem ainda não começou (sem tentativa ou
            // parado nas instruções): não há o que iniciar, e a tela diz isso na hora.
            const openAttempt = application
                ? findOpenAttemptState(db.memory.studentExamState, { applicationId: application.id, studentEmail: email })
                : null;
            timeOver = !!application && !openAttempt?.state?.startedAt && collectiveTimeOverForNewAttempt(application, email, Date.now(), openAttempt?.state || null);
            const context = application
                ? attemptContextForStudent({
                    application,
                    studentEmail: email,
                    examKey,
                    studentClass: cls.name,
                    courseId: cls.courseId,
                    create: !attemptsExhausted && !timeOver && ['waiting', 'running', 'paused'].includes(application.status),
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
            // Com aplicação, só uma tentativa de verdade é gravada (nunca um estado avulso).
            if (onlineCfg && !attemptsExhausted && (!application || context.state) && initializeExamState(rawState, onlineCfg)) {
                rawState.studentEmail = email;
                rawState.examKey = examKey;
                rawState.studentClass = cls.name;
                rawState.courseId = cls.courseId || null;
                if (application) rawState.applicationId = application.id;
                db.memory.studentExamState[stateKey] = rawState;
                db.save({ only: SYNC_SAVE_COLLECTIONS });
            }
            if (application && context.state && applyPageReturn(rawState, { sessionToken: req.studentSessionToken, application, cls, examKey })) db.save({ only: SYNC_SAVE_COLLECTIONS });
            // Chave da cópia local cifrada (AVA-11): tentativas iniciadas antes desta
            // versão ganham a chave aqui. Ela só sai no campo próprio, para o dono.
            if (application && context.state && ensureLocalCopyKey(rawState)) db.save({ only: SYNC_SAVE_COLLECTIONS });
            localCopyKey = application && context.state ? localCopyKeyFor(rawState) : null;

            // Não expõe a flag interna de validação de token nem a chave dentro do estado.
            // As respostas vão com os identificadores opacos das alternativas (AVA-05).
            state = stateForStudent(stateWithoutSecrets(rawState), answerIdScope({ application, onlineConfig: onlineCfg, examKey }));
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
            attemptOutcome = attemptOutcomeFor(application, email, knownAttemptId);
            if (application?.status === 'finished') {
                const ownDeliveries = (db.memory.submissions || [])
                    .filter(submission => submission?.applicationId === application.id
                        && String(submission.student?.email || '').toLowerCase() === email
                        && submission.resultStatus !== 'invalidated')
                    .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
                const savedByInstructor = ownDeliveries.some(submission => submission.submissionSource === 'instructor_finish');
                // A decisão do encerramento e as de sobras resolvidas depois (histórico):
                // quem teve a tentativa desconsiderada continua vendo o aviso.
                const discardResolutions = [application.finishResolution, ...(Array.isArray(application.previousFinishResolutions) ? application.previousFinishResolutions : [])]
                    .filter(resolution => resolution && resolution.policy === 'discard');
                const policyDiscard = discardResolutions.length > 0;
                // Encerramentos gravados a partir desta versão listam as tentativas em andamento
                // que foram desconsideradas; os antigos não, e aí só vale a tentativa que este
                // navegador conhecia e que não virou entrega.
                const discardedList = discardResolutions.every(resolution => Array.isArray(resolution.discardedAttempts))
                    ? discardResolutions.flatMap(resolution => resolution.discardedAttempts)
                    : null;
                const knownAttemptDiscarded = policyDiscard && !!knownAttemptId && !attemptOutcome
                    && (!discardedList || discardedList.some(item => item?.attemptId === knownAttemptId));
                const studentDiscarded = discardedList
                    ? policyDiscard && discardedList.some(item => String(item?.studentEmail || '').toLowerCase() === email)
                    : knownAttemptDiscarded;
                if (savedByInstructor) {
                    finishOutcome = 'submitted';
                } else if (ownDeliveries.length && !knownAttemptDiscarded) {
                    // O aluno tem entrega que conta (enviou, ou foi entregue no fim do tempo),
                    // mesmo que o professor tenha desconsiderado quem ainda estava fazendo.
                    finishOutcome = 'delivered';
                    if (!attemptOutcome) attemptOutcome = attemptOutcomeFor(application, email, ownDeliveries[0].attemptId);
                } else {
                    // Quem nunca abriu a prova (ou só leu as instruções) não teve nada
                    // desconsiderado: vê apenas que a aplicação foi encerrada.
                    finishOutcome = studentDiscarded ? 'discarded' : null;
                }
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
            attemptOutcome,
            timeOver,
            localCopyKey,
            // Prazo de guarda do monitoramento da prova (settings.retention, H8b), para as
            // instruções: 0 = sem prazo automático (até a escola apagar).
            proctoringRetentionDays: examKey ? settingsUtil.retentionSettings().proctoringDays : 0,
            examTitle: examKey ? studentApplicationLabel({ examKey }, cls) : null,
            accessibilityExtraMinutes: examKey && cls.onlineExamConfigs?.[examKey]?.timerEnabled !== false
                ? accessibilityExtraMinutes(email, cls.onlineExamConfigs?.[examKey]?.durationMinutes)
                : 0
        });
    } catch (err) {
        return sendInternalError(err, req, res);
    }
});

// Cadastro de Aluno
router.post('/api/student/register', async (req, res) => {
    // 60 cadastros a cada 10 min por IP (H5b, DES-X2): a turma toda se cadastrando na
    // primeira aula, atrás do mesmo roteador, cabe; antes eram 10 por minuto.
    const { rateLimit } = require('../utils/rateLimit.js');
    const _rl = rateLimit(`student-register:${normalizeIp(req.ip || req.socket.remoteAddress)}`, { max: 60, windowMs: 10 * 60 * 1000 });
    if (!_rl.allowed) {
        return res.status(429).json({ error: 'Muitos cadastros seguidos. Aguarde um instante e tente novamente.' });
    }
    const { password, studentClass, courseId } = req.body;
    const fields = extractStudentFields(req.body);

    // Formato dos 400 combinado entre os grupos: { success: false, error, field } (o campo
    // que falta primeiro, na ordem da tela).
    const missingField = [['name', fields.name], ['email', fields.email], ['password', password], ['courseId', courseId], ['studentClass', studentClass]]
        .find(([, value]) => !value);
    if (missingField) {
        return res.status(400).json({ success: false, error: 'Dados incompletos.', field: missingField[0] });
    }
    // Política de senha (H5a, SEG-06): a senha "1" era aceita. O autocadastro nunca pede
    // a troca no primeiro acesso: quem escolheu a senha foi o próprio aluno.
    const policy = validateNewPassword(password, {
        kind: 'student', email: fields.email, name: fields.name, nomeSocial: fields.nomeSocial,
    });
    if (!policy.ok) return res.status(400).json(passwordPolicyRefusal(policy));

    const classes = readJSON(DB_CLASSES_FILE);
    const matchedClass = classes.find(c => c.name === studentClass && c.courseId === courseId && c.registrationEnabled);
    if (!matchedClass) {
        return res.status(400).json({ success: false, error: 'A turma selecionada não existe ou não está liberada para cadastro.', field: 'studentClass' });
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
        return res.status(400).json({ success: false, error: validation.error, field: validation.field });
    }

    if (!req.body.acceptedTerms) {
        return res.status(400).json({ success: false, error: 'É necessário aceitar os Termos de Uso e a Política de Privacidade.', field: 'acceptedTerms' });
    }
    // Primeiro acesso (H8a-2; SEG-08, SEG-09): data de nascimento obrigatória; menor de 18
    // anos informa o responsável (nome e telefone ou e-mail); o aceite vale para os
    // documentos atuais. A tela manda os ids dos documentos que mostrou: se a escola
    // publicou outra versão no meio, 409 para o aluno ler a nova. Sem os ids (tela antiga
    // ainda no navegador), vale o documento atual.
    let registration;
    try {
        registration = legalAcceptance.checkRegistration(db.memory, req.body, { courseId });
    } catch (error) {
        if (!(error instanceof legalAcceptance.PrivacyAcceptError)) throw error;
        return res.status(error.status).json(legalAcceptance.privacyErrorBody(error));
    }

    // Hash com o scrypt assíncrono (DES-07). Durante a espera outro cadastro pode ter
    // entrado com o mesmo e-mail: a conferência de e-mail repetido roda de novo depois.
    const passwordHash = await db.hashPasswordAsync(String(password).trim());
    const currentStudents = readJSON(DB_STUDENTS_FILE);
    const recheck = validateStudentFields(selfFields, currentStudents, null);
    if (!recheck.ok) {
        return res.status(400).json({ success: false, error: recheck.error, field: recheck.field });
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
        guardianPhone: (registration.guardian && registration.guardian.phone) || (fields.guardian && fields.guardian.phone) || '',
        guardian: registration.guardian
            ? { ...(fields.guardian || {}), ...registration.guardian, observacao: (fields.guardian && fields.guardian.observacao) || '' }
            : (fields.guardian || null),
        birthDate: registration.birthDate,
        matricula: '',
        unidade: '',
        status: DEFAULT_STATUS,
        password: passwordHash,
        classes: [],
        studentClass: '',
        period: '',
        enrollmentRequests: [enrollmentRequest],
        loginTime: null,
        recoveryRequested: false,
        passwordChangedAt: new Date().toISOString(),
        // Aceite do documento exato (H8a-2): { documentId, version, schoolId, at, ip,
        // device }. Antes do H8a-2 gravava só { version: '1.0' }.
        termsAcceptance: legalAcceptance.buildDocumentAcceptance(registration.terms, registration.school, req),
        privacyAcceptance: legalAcceptance.buildDocumentAcceptance(registration.privacy, registration.school, req),
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    currentStudents.push(studentObj);
    recordAudit(db.memory, {
        req,
        // Sem sessão no cadastro: o papel vem da conta passada (o aluno, como no portão).
        actor: { email: studentObj.email, role: 'aluno' },
        action: 'privacy_accept',
        category: 'privacy',
        studentEmail: studentObj.email,
        courseId,
        details: legalAcceptance.acceptAuditDetails([registration.terms, registration.privacy], {
            source: 'cadastro',
            schoolId: registration.school ? registration.school.id : null,
            isMinor: registration.isMinor,
            guardianInformed: !!registration.guardian,
        }),
    });
    writeJSON(DB_STUDENTS_FILE, currentStudents);

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

// Dados da conta para Minha conta (H5b; SEG-16): a matrícula não vai no perfil do login
// (utils/studentProfile.js), que fica guardado no navegador; a tela a lê aqui, na hora.
router.get('/api/student/account', validateStudentSession, (req, res) => {
    const student = req.studentAccount || {};
    res.json({ success: true, matricula: typeof student.matricula === 'string' ? student.matricula : (student.matricula == null ? '' : String(student.matricula)) });
});

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
    // Mesma regra do download do arquivo (sendControlledFile em server.js).
    const list = visibleLibraryEntries(db.memory.library, courseId, studentClass);
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
// Aviso (não evento de calendário) dirigido ao aluno no contexto curso + turma. Mesma
// regra da lista de avisos, do sino e da marcação de leitura.
function announcementVisibleInContext(a, email, courseId, studentClass) {
    if (!a || a.kind === 'calendar') return false;
    if (a.target === 'todos') return true;
    if (a.target === 'turma') return String(a.targetValue || '') === studentClass && (!a.courseId || String(a.courseId) === courseId);
    if (a.target === 'curso') return String(a.targetValue || '') === courseId;
    if (a.target === 'aluno') return String(a.targetValue || '').toLowerCase() === email
        && (!a.courseId || String(a.courseId) === courseId)
        && (!a.studentClass || String(a.studentClass) === studentClass);
    return false;
}

// O aviso chega ao aluno por alguma turma em que ele tem matrícula aprovada? Sem isso,
// qualquer conta (inclusive autocadastro pendente) marcava como lido aviso de outra turma.
function studentCanSeeAnnouncement(student, email, a) {
    return (db.memory.classes || []).some(cls => cls && studentBelongsToClass(student, cls)
        && announcementVisibleInContext(a, email, String(cls.courseId || ''), String(cls.name || '')));
}

function markAnnouncementRead(a, email) {
    if (!Array.isArray(a.readBy)) a.readBy = [];
    if (a.readBy.includes(email)) return false;
    a.readBy.push(email);
    return true;
}

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
        if (a.expiresAt && a.expiresAt < today) return false;
        return announcementVisibleInContext(a, email, courseId, studentClass);
    });
    list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.createdAt || 0) - (a.createdAt || 0));
    res.json(list.map(a => ({ id: a.id, title: a.title, message: a.message, priority: a.priority, pinned: a.pinned, createdAt: a.createdAt, authorName: a.authorName, read: (a.readBy || []).includes(email) })));
});

router.post('/api/student/announcements/read', validateStudentSession, (req, res) => {
    const email = req.studentEmail;
    const id = String(req.body.id || '');
    const ann = (db.memory.announcements || []).find(a => a.id === id);
    if (!ann || !studentCanSeeAnnouncement(req.studentAccount, email, ann)) return res.status(404).json({ error: 'Aviso não encontrado.' });
    if (markAnnouncementRead(ann, email)) db.save({ only: ['announcements', 'authSessions'] });
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
    // Senha conferida com o scrypt assíncrono (utils/passwordLogin.js, DES-07): a turma
    // entrando junto não para o servidor. O hash antigo é regravado em scrypt$ lá.
    // A senha errada não espera o banco (H5b): a falha fica em loginLogs na memória e a
    // gravação é agrupada (no máximo uma a cada 60 s, utils/security.js). Antes cada
    // senha errada fazia um db.save() inteiro.
    const login = await attemptPasswordLogin({ kind: 'student', email: req.body.email, password: req.body.password, req });
    if (!login.ok) return res.status(login.status).json(login.body);
    const student = login.account;
    const normalizedEmail = login.email;

    const status = String(student.status || '').trim().toLowerCase();
    if (!['ativo', 'active'].includes(status)) {
        recordLoginLog(db.memory, { email: normalizedEmail, role: 'student', status: 'blocked', reason: `Status: ${student.status || 'não informado'}`, req });
        await db.save({ only: ['loginLogs'] });
        return res.status(403).json({ error: 'Esta conta está bloqueada ou inativa. Procure o instrutor.' });
    }

    // Senha fraca pela política de hoje (H5a, decisão P3 do Alan): a troca passa a ser
    // pedida, menos durante uma prova em andamento (fica para o login seguinte) e com
    // TEST_MODE (contas demo). Quem já tinha a troca pedida e está em prova segue sem
    // ela nesta sessão (utils/passwordChange.js).
    const inExam = passwordChangeRuleActive() && studentHasExamInProgress(db.memory, normalizedEmail, student);
    if (passwordChangeRuleActive() && login.weakPassword && student.mustChangePassword !== true && !inExam) {
        requirePasswordChange(student, 'weak');
    }

    student.loginTime = new Date().toISOString();
    student.lastLoginAt = Date.now();
    student.lastLoginIp = normalizeIp(req.ip || req.socket.remoteAddress);
    recordLoginLog(db.memory, { email: normalizedEmail, role: 'student', status: 'success', req });
    // Presença automática por login: respeita config (liga/desliga, janela, fuso). Máx. 1/dia.
    // (mesma lógica reaproveitada no heartbeat /api/ping para sessões já ativas)
    ensureDailyLoginAttendance(normalizedEmail, { req, source: 'login' });
    // Sessão única: gera um token novo a cada login. Logins anteriores (em outros
    // dispositivos) deixam de valer porque o token guardado neles passa a divergir.
    // O servidor guarda só o hash do token (utils/authSessions.js).
    const sessionToken = createStudentSession(db.memory, normalizedEmail, {
        ip: normalizeIp(req.ip || req.socket.remoteAddress),
        now: Date.now(),
    });
    const passwordChange = studentPasswordChangeState(db.memory, student, studentSessionByEmail(db.memory, normalizedEmail));
    // Rota quente no começo da aula (H1-c, DES-01): a conta (hora do login, hash novo,
    // troca obrigatória), o registro do login, a presença automática e a sessão gravada
    // (contrato: rota anotada que cria sessão leva 'authSessions'; a que audita leva
    // 'auditLogs').
    await db.save({ only: ['students', 'loginLogs', 'attendance', 'authSessions', 'auditLogs'] });

    // Retorna dados do estudante sem expor o campo de senha
    const { password: _, ...safeStudent } = student;
    // A tela segue o que vale para esta sessão (em prova, a troca fica para depois).
    safeStudent.mustChangePassword = passwordChange.required === true;
    if (passwordChange.required) safeStudent.passwordChangeReason = passwordChange.reason;
    else delete safeStudent.passwordChangeReason;
    
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

    res.json({
        success: true,
        // Só o que o portal usa (H5b): responsável, telefones e acessibilidade ficam no
        // servidor (utils/studentProfile.js).
        student: studentSessionProfile(safeStudent),
        sessionToken,
        mustChangePassword: passwordChange.required === true,
        ...(passwordChange.required ? { passwordChangeReason: passwordChange.reason } : {}),
    });
});

// Solicitação de recuperação de senha pelo aluno
router.post('/api/student/recover', (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ error: 'E-mail é obrigatório.' });
    }

    // 30 pedidos a cada 10 min por IP (H5b, DES-X2).
    const { rateLimit } = require('../utils/rateLimit.js');
    const _rl = rateLimit(`student-recover:${normalizeIp(req.ip || req.socket.remoteAddress)}`, { max: 30, windowMs: 10 * 60 * 1000 });
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


// Troca de senha pelo próprio aluno (H5a; UXA-13, SEG-10): na tela Minha conta e na
// troca obrigatória (senha criada ou redefinida pelo professor, ou senha fraca). Antes o
// aluno não tinha como sair de uma senha que o professor conhecia.
// - Sempre pede a senha atual (na troca obrigatória, a temporária que o professor
//   entregou), conferida pelo attemptPasswordLogin, o único caminho que confere senha:
//   scrypt assíncrono, o teto por IP do login e o erro em loginLogs. Assim quem só tem a
//   sessão aberta (um aparelho de antes do "Redefinir senha") não escolhe a senha nova.
// - A senha nova passa pela política (utils/passwordPolicy.js) e não pode ser a atual: a
//   temporária, que o professor conhece, não vira a senha definitiva.
// - A sessão atual continua (o aluno tem uma sessão só).
router.post('/api/student/change-password', validateStudentSession, async (req, res) => {
    const student = req.studentAccount;
    const { currentPassword, newPassword } = req.body;
    if (typeof currentPassword !== 'string' || !currentPassword.trim()) {
        return res.status(400).json({ success: false, error: 'Informe a senha atual.', field: 'currentPassword' });
    }
    if (typeof newPassword !== 'string' || !newPassword.trim()) {
        return res.status(400).json({ success: false, error: 'Informe a nova senha.', field: 'newPassword' });
    }
    const policy = validateNewPassword(newPassword, {
        kind: 'student', email: student.email, name: student.name, nomeSocial: student.nomeSocial, matricula: student.matricula,
    });
    if (!policy.ok) return res.status(400).json(passwordPolicyRefusal(policy, 'newPassword'));
    if (newPassword.trim() === currentPassword.trim()) {
        return res.status(400).json({ success: false, error: 'A nova senha precisa ser diferente da atual.', passwordPolicy: true, field: 'newPassword' });
    }
    const changedMeanwhile = () => res.status(409).json({ error: 'A senha desta conta acabou de ser alterada. Entre de novo e tente outra vez.' });
    const check = await attemptPasswordLogin({ kind: 'student', email: req.studentEmail, password: currentPassword, req, purpose: 'change_password' });
    if (!check.ok && check.status === 429) return res.status(429).json(check.body);
    if (!check.ok && check.passwordChanged) return changedMeanwhile();
    if (!check.ok) {
        // A tentativa errada fica em loginLogs e conta no atraso da conta (loginGuard),
        // com a gravação agrupada (attemptPasswordLogin).
        return res.status(400).json({ success: false, error: 'Senha atual incorreta.', field: 'currentPassword' });
    }
    if (check.account !== student || student.password !== check.password) return changedMeanwhile();
    const storedBefore = check.password;
    const passwordHash = await db.hashPasswordAsync(newPassword.trim());
    // Outra troca (o professor redefiniu, outra aba) terminou durante a espera: não
    // sobrescreve a senha que ela gravou.
    if (student.password !== storedBefore || !(db.memory.students || []).includes(student)) return changedMeanwhile();
    student.password = passwordHash;
    passwordChanged(student);
    student.recoveryRequested = false;
    student.updatedAt = Date.now();
    await db.save();
    res.json({ success: true, message: 'Senha alterada.' });
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
    // Uma tentativa vencida nunca ganha prazo novo: vira entrega com as respostas salvas.
    const finalizedNow = settleStudentAttempt(application, req.studentEmail, 0);
    if (finalizedNow.length) {
        await db.save();
        return res.status(409).json({
            error: 'O tempo da sua tentativa terminou. Ela foi entregue automaticamente com as respostas salvas.',
            attemptFinalized: true,
            attemptOutcome: attemptOutcomeFor(application, req.studentEmail, finalizedNow[0].attemptId),
        });
    }
    const mayStart = application.status === 'running'
        || (application.status === 'waiting' && Number(application.startsAt || 0) <= now);
    // Pausada: a prova já começou, só está parada (a tela do aluno mostra a pausa).
    if (application.status === 'paused') {
        return res.status(409).json({ error: 'A prova está pausada pelo professor.', paused: true });
    }
    // Encerrada ou cancelada: a prova já foi aplicada (link salvo, aba antiga). Antes a
    // mensagem dizia que ela "ainda não foi iniciada".
    if (['finished', 'cancelled'].includes(application.status)) {
        return res.status(409).json({ error: 'Esta aplicação já foi encerrada pelo professor.', applicationClosed: true });
    }
    if (!mayStart || !config?.onlineActive) {
        return res.status(409).json({ error: 'A prova ainda não foi iniciada pelo professor.', notStarted: true });
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

    const attemptScope = {
        application,
        studentEmail: req.studentEmail,
        examKey: application.examKey,
        studentClass: cls.name,
        courseId: cls.courseId,
    };
    let context = attemptContextForStudent(attemptScope);
    if (!context.state) {
        // Sem tentativa aberta, a nova só é criada quando pode começar de fato: antes
        // ela era gravada e só depois vinham as recusas (token, tempo coletivo acabado),
        // e o estado parado nas instruções contava em "Ainda não iniciaram".
        if (application.tokenEnabled === true) {
            return res.status(403).json({ error: 'Valide o token antes de iniciar a tentativa.', tokenRequired: true });
        }
        if (collectiveTimeOverForNewAttempt(application, req.studentEmail, now)) {
            return res.status(409).json({ error: 'O tempo desta aplicação já terminou.', timeOver: true });
        }
        context = attemptContextForStudent({ ...attemptScope, create: true });
    }
    const state = context.state;
    if (application.tokenEnabled === true && state.tokenValidated !== true) {
        return res.status(403).json({ error: 'Valide o token antes de iniciar a tentativa.', tokenRequired: true });
    }
    if (!state.startedAt) {
        const startedAt = application.timerMode === 'per_attempt'
            ? now
            : Math.min(now, Number(application.startsAt || now));
        const extraMinutes = accessibilityExtraMinutes(req.studentEmail, application.durationMinutes);
        const deadlineAt = computeAttemptDeadline({
            application,
            state: { ...state, startedAt, accessibilityExtraMinutes: extraMinutes },
            now,
        });
        // Cronômetro coletivo já esgotado: a tentativa nasceria vencida (e vazia).
        if (deadlineAt !== null && deadlineAt <= now) {
            return res.status(409).json({ error: 'O tempo desta aplicação já terminou.', timeOver: true });
        }
        state.startedAt = startedAt;
        state.status = 'active';
        state.accessibilityExtraMinutes = extraMinutes;
        state.deadlineAt = deadlineAt;
        // A tentativa começa nesta versão: o aluno vê a letra da posição (AVA-05). Vale
        // também para o estado criado antes da atualização (instruções abertas ou
        // tentativa antiga vinculada), que ainda não tinha a marca.
        state.alternativeLabels = POSITION_LABELS;
    }
    initializeExamState(state, config);
    ensureLocalCopyKey(state);
    db.memory.studentExamState[context.key] = state;
    // Rota quente (H1-c, DES-01): a tentativa e a aplicação (o "+N min" guardado para o
    // aluno passa para a tentativa nova).
    await db.save({ only: ['studentExamState', 'examApplications', 'authSessions'] });
    // A tentativa acabou de começar: as questões da versão do aluno já vão na resposta,
    // com os identificadores opacos das alternativas (AVA-05).
    const delivered = attemptQuestionsAvailable({ application, onlineConfig: config, state })
        ? questionsForStudentAttempt({ application, onlineConfig: config, state, evaluation: db.memory.evaluations?.[application.examKey] })
        : null;
    res.json({
        success: true,
        applicationId: application.id,
        attemptId: state.attemptId,
        attemptNumber: state.attemptNumber,
        // Respostas com os identificadores opacos das alternativas (AVA-05).
        state: stateForStudent(stateWithoutSecrets(state), answerIdScope({ application })),
        localCopyKey: localCopyKeyFor(state),
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
        return res.status(400).json({ error: 'Dados da contestação inválidos.' });
    }
    if (text.length > 300) return res.status(400).json({ error: 'O detalhe deve ter no máximo 300 caracteres.' });

    const application = findExamApplication(db.memory.examApplications, applicationId);
    if (!application) return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });
    if (!['waiting', 'running', 'paused'].includes(application.status)) {
        return res.status(409).json({ error: 'Esta aplicação já foi encerrada.' });
    }
    const cls = findClassByNameAndCourse(db.memory.classes || [], application.studentClass, application.courseId);
    if (!cls || !studentBelongsToClass(req.studentAccount, cls)) {
        return res.status(403).json({ error: 'Aplicação não autorizada para este estudante.' });
    }
    const context = attemptContextForStudent({ application, studentEmail: req.studentEmail, examKey: application.examKey });
    const state = context.state;
    if (!state?.startedAt || state.attemptId !== attemptId) {
        return res.status(409).json({ error: 'A contestação não corresponde à tentativa ativa.' });
    }
    const resolved = questionsForAttempt({
        application,
        onlineConfig: cls.onlineExamConfigs?.[application.examKey],
        state,
        evaluation: db.memory.evaluations?.[application.examKey],
    });
    if (!resolved.assignedNumbers.includes(number)) {
        return res.status(400).json({ error: 'Esta questão não pertence à tentativa do aluno.' });
    }

    if (!Array.isArray(application.questionReports)) application.questionReports = [];
    const duplicate = application.questionReports.find(report =>
        String(report.studentEmail || '').toLowerCase() === req.studentEmail
        && Number(report.questionNumber) === number);
    if (duplicate) {
        return res.status(409).json({ error: 'Você já reportou esta questão.', alreadyReported: true, report: duplicate });
    }
    const oneMinuteAgo = Date.now() - 60000;
    const recentCount = application.questionReports.filter(report =>
        String(report.studentEmail || '').toLowerCase() === req.studentEmail
        && new Date(report.createdAt || 0).getTime() >= oneMinuteAgo).length;
    if (recentCount >= 5) return res.status(429).json({ error: 'Aguarde um minuto antes de enviar novas contestações.' });

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
    await db.save({ only: ['examApplications', 'auditLogs', 'authSessions'] });
    res.status(201).json({ success: true, report });
});

router.post('/api/student/submit', validateStudentSession, async (req, res) => {
    const { student = {}, studentClass: bodyStudentClass, courseId: bodyCourseId, examKey, applicationId, attemptId, answers: rawAnswers, questionNumbers, examConfigVersion, auto } = req.body;
    if (!examKey || !rawAnswers || typeof rawAnswers !== 'object' || Array.isArray(rawAnswers)) {
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
    const nowTs = Date.now();

    // Envio idempotente: a mesma tentativa nunca gera duas entregas. Vem antes das
    // checagens de aplicação ativa para que o reenvio automático (rede instável)
    // receba a confirmação mesmo depois que o professor encerrou a aplicação.
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
        // Respostas do navegador (identificadores opacos) com a letra original (AVA-05).
        const answers = decodeAttemptAnswers(rawAnswers, {
            application,
            onlineConfig,
            examKey,
            evaluation: db.memory.evaluations?.[examKey],
            state: {
                assignedVersion: previousSameAttempt.assignedVersion || 'A',
                assignedQuestionNumbers: (previousSameAttempt.gradedAnswers || []).map(item => Number(item?.questionNumber)).filter(Number.isFinite),
                alternativeLabels: previousSameAttempt.alternativeLabels,
            },
        });
        // O servidor já tinha entregue no fim do tempo com as respostas salvas; o envio
        // automático do navegador (respostas congeladas no zero) ainda vale dentro da
        // janela de tolerância e fica marcado com o atraso.
        if (application && canReplaceServerFinalization(previousSameAttempt, { auto: auto === true, answers, now: nowTs })) {
            replaceServerFinalization(previousSameAttempt, {
                application,
                onlineConfig,
                evaluation: db.memory.evaluations?.[examKey],
                answers,
                now: nowTs,
            });
            await db.save();
            return res.json({
                success: true,
                replacedServerFinalization: true,
                submissionId: previousSameAttempt.id,
                applicationId: application.id,
                attemptId: previousSameAttempt.attemptId,
                gradePublished: false,
                answeredCount: previousSameAttempt.answeredCount,
                lateBySeconds: Number(previousSameAttempt.lateBySeconds || 0),
                message: 'Prova enviada após o fim do tempo. O atraso fica registrado para o professor.',
                examConfigVersion: previousSameAttempt.examConfigVersion || null,
            });
        }
        return res.json({
            success: true,
            duplicate: true,
            submissionId: previousSameAttempt.id,
            gradePublished: previousSameAttempt.gradePublished === true,
            finalizedByServer: previousSameAttempt.submissionSource === SERVER_DEADLINE_SOURCE,
            answeredCount: Number.isFinite(Number(previousSameAttempt.answeredCount))
                ? Number(previousSameAttempt.answeredCount)
                : (previousSameAttempt.gradedAnswers || []).filter(item => item?.studentChoice).length,
            message: 'Esta tentativa já havia sido enviada.',
            examConfigVersion: previousSameAttempt.examConfigVersion || null,
        });
    }

    if (application && onlineConfig.applicationId !== application.id) {
        return res.status(409).json({ error: 'Esta aplicação não é mais a aplicação ativa da prova.' });
    }
    // A prova aceita envio quando está liberada e em andamento: status 'running', ou
    // 'waiting' cuja sala de espera já terminou (o horário de início já passou). Com a
    // aplicação pausada só passa o envio de quem já estava sem tempo antes da pausa.
    const examStatus = onlineConfig.status || 'not_applied';
    const emAndamento = examStatus === 'running'
        || (examStatus === 'waiting' && onlineConfig.startTime && nowTs >= onlineConfig.startTime);
    const applicationPaused = examStatus === 'paused';
    if (onlineConfig.onlineActive !== true || (!emAndamento && !applicationPaused)) {
        return res.status(403).json({ error: 'Esta prova online ainda não está em andamento para a sua turma.' });
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
    const timing = application
        ? attemptOverdueMs(lockedState, application, nowTs)
        : {
            deadlineAt: Number(lockedState.deadlineAt) || null,
            overdueMs: lockedState.deadlineAt ? nowTs - Number(lockedState.deadlineAt) : null,
        };
    // Prova sem prazo ("Cronômetro ativo" desligado, sem duração ou sem início): não
    // existe fim do tempo, então não existe envio automático por tempo. As telas até a
    // 1615783 liam o tempo restante null como zero e mandavam auto: true assim que o
    // aluno abria a prova (ou clicava em Iniciar, ou era liberado do foco), e a tentativa
    // era fechada como "enviada no fim do tempo". Aqui a tentativa e as respostas ficam
    // como estão (nada é gravado) e a tela volta para as questões. O envio do aluno
    // (auto ausente ou false) segue normal.
    const withoutDeadline = timing.deadlineAt == null || (!application && onlineConfig.timerEnabled === false);
    if (auto === true && withoutDeadline) {
        return res.status(409).json({
            error: NO_DEADLINE_AUTO_SUBMIT_MESSAGE,
            code: NO_DEADLINE_CODE,
            noDeadline: true,
        });
    }
    const pastDeadline = timing.overdueMs !== null && timing.overdueMs >= 0;
    if (applicationPaused && !pastDeadline) {
        return res.status(403).json({ error: 'A aplicação está pausada pelo professor. Aguarde a retomada para enviar.', applicationPaused: true });
    }
    // Fim do tempo com a prova bloqueada por perda de foco: vale o que estava salvo
    // antes do bloqueio (as questões ficaram ocultas), nunca as respostas deste envio.
    if (lockedState.focusLocked === true && pastDeadline) {
        const finalized = application
            ? finalizeAttemptState(db.memory, { key: stateKey, state: lockedState, application, now: nowTs, deadlineAt: timing.deadlineAt })
            : null;
        if (finalized) await db.save();
        return res.status(408).json({
            error: finalized
                ? 'O tempo acabou com a prova bloqueada por perda de foco. As respostas salvas antes do bloqueio foram entregues automaticamente.'
                : 'O prazo da prova terminou.',
            deadlineExceeded: true,
            focusLocked: true,
            finalizedByServer: !!finalized,
            submissionId: finalized?.id || null,
            answeredCount: finalized ? finalized.answeredCount : null,
        });
    }
    const lateDecision = lateSubmitDecision({ overdueMs: timing.overdueMs, auto: auto === true });
    if (!lateDecision.accept) {
        // Fora da tolerância vale a finalização do servidor com as últimas respostas salvas.
        const finalized = application
            ? finalizeAttemptState(db.memory, { key: stateKey, state: lockedState, application, now: nowTs, deadlineAt: timing.deadlineAt })
            : null;
        if (finalized && auto !== true) finalized.lateManualSubmitRefused = true;
        if (finalized) await db.save();
        return res.status(408).json({
            error: finalized
                ? 'O prazo da prova terminou. As respostas salvas no servidor foram entregues automaticamente.'
                : 'O prazo da prova terminou.',
            deadlineExceeded: true,
            finalizedByServer: !!finalized,
            submissionId: finalized?.id || null,
            answeredCount: finalized ? finalized.answeredCount : null,
        });
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

    // Envio automático com o prazo ainda bem à frente: a tela não viu o tempo extra
    // (o professor deu mais tempo ou reabriu a tentativa no "+N min" da turma, ou o
    // servidor devolveu o tempo em que ficou fora do ar). A prova continua; o navegador
    // volta para as questões com o tempo novo. reason 'server_outage': o prazo só está
    // à frente pelo tempo devolvido da queda (H3b), e a tela diz isso ao aluno.
    if (auto === true && timing.overdueMs !== null && timing.overdueMs < -AUTO_SUBMIT_EARLY_TOLERANCE_MS) {
        const serverOutage = !!application && extendedByServerOutage(lockedState, application, nowTs);
        return res.status(409).json({
            error: serverOutage
                ? 'O servidor ficou fora do ar e o tempo foi devolvido. A prova continua.'
                : 'O professor deu mais tempo. A prova continua.',
            deadlineExtended: true,
            timerRemaining: Math.max(0, Math.ceil(-timing.overdueMs / 1000)),
            ...(serverOutage ? { reason: 'server_outage' } : {}),
        });
    }

    // Tenta obter questoes estruturadas do banco de dados primeiro
    let questions;
    let evaluation = db.memory.evaluations[examKey];
    if (evaluation) {
        questions = evaluation.questions;
    } else {
        // Fallback: a prova antiga só em .md (content/<prova>.md), sem entrada em
        // evaluations. Antes o leitor do .md não estava importado aqui: o caminho sempre
        // dava ReferenceError, engolido pelo catch, e o aluno recebia 500 "Falha ao
        // processar avaliação no servidor.". A avaliação lida do .md também vale para a
        // correção (gabarito das questões que a versão aplicada não trouxer).
        const filePath = path.join(CONTENT_DIR, `${examKey}.md`);
        try {
            const mdContent = await fs.promises.readFile(filePath, 'utf8');
            const parsedObj = parseEvaluationMarkdown(mdContent, examKey);
            questions = parsedObj ? parsedObj.questions : [];
            if (parsedObj && Array.isArray(parsedObj.questions) && parsedObj.questions.length) evaluation = parsedObj;
        } catch (err) {
            // Sem o arquivo: segue para o erro de prova sem questões, abaixo. Outra falha
            // (arquivo ilegível) fica no crash.log.
            if (!err || err.code !== 'ENOENT') logError('[PROVA] Não foi possível ler a prova em .md', err, { req, details: { examKey } });
        }
    }
    
    if (!questions || questions.length === 0) {
        // Prova sem questões no banco nem no .md: o código do erro leva o professor ao
        // registro no crash.log (qual prova faltou).
        return sendInternalError(new Error(`Avaliação sem questões no servidor: ${examKey}`), req, res, 'Falha ao processar avaliação no servidor.');
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

    // Correção das respostas no servidor respeitando a configuração aplicada. O navegador
    // manda o identificador opaco de cada alternativa; aqui ele vira a letra original.
    const answers = decodeAttemptAnswers(rawAnswers, { application, onlineConfig, state: lockedState, evaluation, examKey });
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
    submissionObj.answeredCount = countAnswers(answers);
    markLateSubmission(submissionObj, { deadlineAt: timing.deadlineAt, lateMs: lateDecision.lateMs });
    // Entrega automática do fim do tempo: guarda a tentativa para o "+N min" da turma
    // poder reabri-la logo depois do fim do tempo.
    if (auto === true && application) {
        const reopenable = attemptStateForReopen(lockedState);
        if (reopenable) submissionObj.reopenableState = reopenable;
    }
    
    // A entrega nova entra na lista (submissions é só acréscimo) e a tentativa sai dos
    // estados. Rota quente (H1-c, DES-01): uma gravação parcial só, em vez do writeJSON
    // (gravação completa) seguido de outra; os caminhos raros acima (entrega pelo
    // servidor fora do prazo, troca da entrega automática) continuam completos.
    db.memory.submissions.push(submissionObj);

    lockedState.status = 'submitted';
    lockedState.submittedAt = submissionObj.timestamp;
    if (stateKey && db.memory.studentExamState[stateKey]) {
        delete db.memory.studentExamState[stateKey];
    }
    await db.save({ only: ['submissions', 'studentExamState', 'auditLogs', 'examApplications', 'authSessions'] });

    res.json({
        success: true,
        gradePublished: false,
        submissionId: submissionObj.id,
        applicationId: application?.id || null,
        attemptId: submissionObj.attemptId,
        answeredCount: submissionObj.answeredCount,
        lateBySeconds: Number(submissionObj.lateBySeconds || 0),
        message: 'Prova enviada. A nota será exibida após a publicação do professor.',
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
    
    // Mesmo recorte do painel do aluno e do boletim: registro antigo sem curso entra
    // no curso da matrícula do aluno naquela turma (antes ficava fora desta lista e a
    // "Média das consideradas" divergia da média do painel).
    const ownSubmissions = scopeSubmissionsToContext(
        submissions.filter(s => s.student && s.student.email && s.student.email.toLowerCase() === normalizedEmail),
        { courseId, studentClass, students: db.memory.students || [], classes: db.memory.classes || [] },
    );
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
// Último "Marcar como lidas" do aluno no sino desta turma/curso. Contas gravadas antes
// desta versão só têm o carimbo único (notificationsSeenAt), que continua valendo.
function notificationContextKey(cls) {
    return `${String(cls?.courseId || '')}::${String(cls?.name || '')}`;
}

function notificationsSeenAtFor(student, cls) {
    const byContext = student?.notificationsSeenAtByContext;
    const contextual = byContext && typeof byContext === 'object' ? Number(byContext[notificationContextKey(cls)] || 0) : 0;
    return Math.max(contextual, Number(student?.notificationsSeenAt || 0));
}

router.get('/api/student/notifications', validateStudentSession, (req, res) => {
    const email = req.studentEmail;
    const courseId = String(req.query.courseId || '').trim();
    const className = String(req.query.studentClass || '').trim();
    const student = req.studentAccount;
    const cls = findClassByNameAndCourse(db.memory.classes || [], className, courseId);
    if (!cls || !studentBelongsToClass(student, cls)) return res.status(403).json({ error: 'Contexto de turma não autorizado.' });
    const seenAt = notificationsSeenAtFor(student, cls);
    const today = settingsUtil.today();
    const items = [];

    (db.memory.announcements || [])
        .filter(item => announcementVisibleInContext(item, email, courseId, className) && (!item.expiresAt || item.expiresAt >= today))
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

    // Só nota que o aluno de fato vê (Notas e boletim descartam nota vazia ou fora de 0 a 10),
    // com o mesmo recorte de contexto da tela Notas (my-submissions): registro antigo sem
    // curso ou turma entra só no contexto da matrícula do aluno. Antes ele aparecia no sino
    // de todas as turmas do aluno, e o clique levava a uma tela Notas sem aquela nota.
    scopeSubmissionsToContext(
        (db.memory.submissions || []).filter(s => s && s.gradePublished === true && normalizeScore(s.score) !== null
            && String(s.student?.email || '').toLowerCase() === email),
        { courseId, studentClass: className, students: db.memory.students || [], classes: db.memory.classes || [] },
    )
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

// "Marcar como lidas" (UXA-X3): carimbo para dúvidas, notas e provas e leitura dos
// avisos listados no sino (readBy), senão o próximo polling trazia o contador de volta.
// O carimbo é da turma/curso do sino (aluno em duas turmas não perde os itens novos da
// outra); sem turma informada (navegador antigo), vale para todas, como antes.
router.post('/api/student/notifications/seen', validateStudentSession, async (req, res) => {
    const email = req.studentEmail;
    const courseId = String(req.query.courseId || req.body?.courseId || '').trim();
    const className = String(req.query.studentClass || req.body?.studentClass || '').trim();
    const cls = className ? findClassByNameAndCourse(db.memory.classes || [], className, courseId) : null;
    if (className && (!cls || !studentBelongsToClass(req.studentAccount, cls))) {
        return res.status(403).json({ error: 'Contexto de turma não autorizado.' });
    }
    if (cls) {
        const byContext = req.studentAccount.notificationsSeenAtByContext && typeof req.studentAccount.notificationsSeenAtByContext === 'object'
            ? req.studentAccount.notificationsSeenAtByContext
            : {};
        byContext[notificationContextKey(cls)] = Date.now();
        req.studentAccount.notificationsSeenAtByContext = byContext;
    } else {
        req.studentAccount.notificationsSeenAt = Date.now();
    }
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.slice(0, 100).map(String) : [];
    const announcementIds = new Set(ids.filter(id => id.startsWith('aviso:')).map(id => id.slice('aviso:'.length)));
    let marked = 0;
    (db.memory.announcements || []).forEach(a => {
        if (!a || !announcementIds.has(String(a.id))) return;
        if (!studentCanSeeAnnouncement(req.studentAccount, email, a)) return;
        if (markAnnouncementRead(a, email)) marked++;
    });
    await db.save();
    res.json({ success: true, announcementsMarked: marked });
});

router.get('/api/student/dashboard', validateStudentSession, (req, res) => {
    const email = req.studentEmail;
    const courseId = String(req.query.courseId || '').trim();
    const className = String(req.query.studentClass || '').trim();
    const student = (db.memory.students || []).find(item => item.email && item.email.toLowerCase() === email);
    if (!student) return res.status(404).json({ error: 'Aluno não encontrado.' });

    const classes = readJSON(DB_CLASSES_FILE);
    const cls = findClassByNameAndCourse(classes, className, courseId);
    if (!cls || !studentBelongsToClass(student, cls)) return res.status(403).json({ error: 'Contexto de turma não autorizado.' });
    const course = (db.memory.courses || []).find(item => item.id === courseId) || null;
    const structure = effectiveStructure(courseId, className)?.structure || [];
    const completed = db.memory.progress[email] || {};
    const released = cls ? getStudentReleasedItems(cls, email) : {};
    // Mesmo recorte curso/turma do boletim e de Resultados: registro antigo sem curso
    // conta só no curso da matrícula do aluno naquela turma.
    const submissions = scopeSubmissionsToContext(
        readJSON(DB_SUBMISSIONS_FILE).filter(item => item.student?.email && item.student.email.toLowerCase() === email),
        { courseId, studentClass: className, students: db.memory.students || [], classes: db.memory.classes || [] },
    );

    const modules = structure.map((module, moduleIndex) => {
        const units = module.units || module.items || [];
        const unitKeys = units.map(unit => unit.apostilaKey || unit.key).filter(Boolean);
        const examKeys = new Set(units.map(unit => unit.avaliacaoKey).filter(Boolean));
        const moduleSubmissions = submissions.filter(item => examKeys.has(item.examKey));
        const published = moduleSubmissions.filter(item => item.gradePublished === true && Number.isFinite(Number(item.score)));
        const consolidated = consolidateSubmissions(published).filter(item => item.score != null);
        const note = consolidated.length ? roundGrade(consolidated.reduce((sum, item) => sum + Number(item.score), 0) / consolidated.length) : null;
        const done = unitKeys.filter(key => completed[key]).length;
        return {
            id: module.id || module.key || `module_${moduleIndex}`,
            name: module.name || module.title || `Módulo ${moduleIndex + 1}`,
            done,
            total: unitKeys.length,
            progress: unitKeys.length ? Math.round((done / unitKeys.length) * 100) : 0,
            note,
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
        // Mesmo arredondamento do boletim, do quadro e das planilhas (roundGrade).
        overallNote: publishedSubmissions.length ? roundGrade(publishedSubmissions.reduce((sum, item) => sum + Number(item.score), 0) / publishedSubmissions.length) : null,
        frequency,
        pendingCount,
        continueItem,
        announcements,
        calendar,
        // Cada item é um grupo consolidado (prova/aplicação): id, prova e data vêm da tentativa mais recente.
        performance: publishedSubmissions
            .map(group => {
                const latest = [...group.attempts].sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))[0] || {};
                return { id: latest.id, examKey: latest.examKey, timestamp: latest.timestamp, note: roundGrade(group.score) };
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
    db.save({ only: ['progress', 'authSessions'] });
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
    // Só acréscimo (e a poda das mais antigas, que a gravação parcial apaga).
    db.save({ only: ['moduleAccess', 'authSessions'] });
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
    db.save({ only: ['notes', 'authSessions'] });
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
    // Unidade ou parágrafo com nome herdado ('__proto__', 'constructor'...): a gravação
    // abaixo caía em Object.prototype (ou em Object) e valia para o servidor todo.
    if (isInheritedKey(key) || isInheritedKey(paragraphId)) {
        return res.status(400).json({ error: 'Unidade ou parágrafo inválido.' });
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
    
    db.save({ only: ['annotations', 'authSessions'] });
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
// Quando a chamada vem do painel administrativo (x-admin-session), aplica também o RBAC
// e o escopo de conteúdo da conta. Chamadas do portal do aluno mantêm o fluxo atual. O
// 'Authorization: email:senha' não identifica instrutor (SEG-03).
router.use('/api/forum', (req, res, next) => {
    const hasAdminCredentials = !!req.headers['x-admin-session'];
    if (!hasAdminCredentials) return validateStudentSession(req, res, next);
    return validateAdminPermission(req, res, 'page.forum', (config, matchedAdmin) => {
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

// Dúvida que o professor pode ver no painel (SEG-11): a turma da dúvida (gravada, ou
// inferida pelo aluno nas antigas) precisa estar no escopo dele. Dúvida antiga sem
// turma que se possa inferir fica escondida do professor; o administrador vê todas.
// Devolve também se a inferência gravou a turma numa dúvida antiga (quem chama grava).
function forumCommentVisibleToAdmin(account, comment) {
    if (!isProfessorAccount(account)) return { visible: true, migrated: false };
    const wasLegacy = !!comment && !comment.courseId && !comment.studentClass;
    const context = comment ? inferLegacyForumContext(comment) : null;
    return {
        visible: !!context && adminCanAccessClass(account, context.studentClass, context.courseId),
        migrated: wasLegacy && !!context,
    };
}

router.get('/api/forum', (req, res) => {
    const { key } = req.query;
    const courseId = String(req.query.courseId || '').trim();
    const studentClass = String(req.query.studentClass || '').trim();
    if (!key) return res.status(400).json({ error: 'Falta a chave do material' });
    // O aluno lê só as dúvidas da turma em que está (SEG-11): sem curso e turma, a lista
    // trazia nomes e dúvidas de todas as turmas, até para conta sem turma nenhuma.
    if (req.auth.role === 'student') {
        if (!courseId || !studentClass) return res.status(400).json({ success: false, error: 'Informe o curso e a turma.', field: courseId ? 'studentClass' : 'courseId' });
        const cls = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId);
        if (!cls || !studentBelongsToClass(req.studentAccount, cls)) return res.status(403).json({ success: false, error: 'Contexto de turma não autorizado.' });
    }

    let migrated = false;
    const comments = db.memory.forum.filter(c => c.key === key && !c.deleted).filter(c => {
        if (req.auth.role === 'admin') {
            const scope = forumCommentVisibleToAdmin(req.auth.admin, c);
            if (scope.migrated) migrated = true;
            if (!scope.visible) return false;
        }
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
        let migrated = false;
        // Professor: só as dúvidas das turmas dele, uma a uma (SEG-11). Antes o filtro era
        // pelo curso do tópico, e sem turma no pedido vinham as dúvidas (com e-mail) de
        // todas as turmas; o tópico 'geral' não pertence a curso nenhum e passava sempre.
        let comments = isProfessorAccount(matchedAdmin)
            ? (db.memory.forum || []).filter(comment => {
                if (!comment || !adminCanAccessItem(matchedAdmin, comment.key)) return false;
                const scope = forumCommentVisibleToAdmin(matchedAdmin, comment);
                if (scope.migrated) migrated = true;
                return scope.visible;
            })
            : (db.memory.forum || []);
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
        if (!comment) return res.status(404).json({ error: 'Dúvida não encontrada.' });
        if (!adminForumContextAllowed(req, matchedAdmin, comment)) return res.status(403).json({ error: 'Dúvida fora do contexto ativo.' });
        if (isProfessorAccount(matchedAdmin) && !adminCanAccessItem(matchedAdmin, comment.key)) return res.status(403).json({ error: 'Sem acesso a esta dúvida.' });
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
        if (!comment) return res.status(404).json({ error: 'Dúvida não encontrada.' });
        if (!adminForumContextAllowed(req, matchedAdmin, comment)) return res.status(403).json({ error: 'Dúvida fora do contexto ativo.' });
        if (isProfessorAccount(matchedAdmin) && !adminCanAccessItem(matchedAdmin, comment.key)) return res.status(403).json({ error: 'Sem acesso a esta dúvida.' });
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
        if (!comment) return res.status(404).json({ error: 'Dúvida não encontrada.' });
        if (!adminForumContextAllowed(req, matchedAdmin, comment)) return res.status(403).json({ error: 'Dúvida fora do contexto ativo.' });
        if (isProfessorAccount(matchedAdmin) && !adminCanAccessItem(matchedAdmin, comment.key)) return res.status(403).json({ error: 'Sem acesso a esta dúvida.' });
        if (replyId) {
            const reply = (comment.replies || []).find(r => r.id === replyId);
            if (!reply) return res.status(404).json({ error: 'Resposta não encontrada.' });
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
        if (idx === -1) return res.status(404).json({ error: 'Dúvida não encontrada.' });
        if (!adminForumContextAllowed(req, matchedAdmin, db.memory.forum[idx])) return res.status(403).json({ error: 'Dúvida fora do contexto ativo.' });
        const comment = db.memory.forum[idx];
        const context = inferLegacyForumContext(comment) || {};
        let purged = null;
        if (replyId) {
            const rIdx = (comment.replies || []).findIndex(r => r.id === replyId);
            if (rIdx !== -1) {
                comment.replies.splice(rIdx, 1);
                purged = { scope: 'resposta', commentId: comment.id, replyId, removedReplies: 1 };
            }
        } else {
            db.memory.forum.splice(idx, 1);
            purged = { scope: 'dúvida', commentId: comment.id, removedReplies: Array.isArray(comment.replies) ? comment.replies.length : 0 };
        }
        // Apagar de vez fica na auditoria (SEG-07): o escopo e a contagem, sem o texto.
        if (purged) {
            recordAudit(db.memory, {
                req,
                actor: matchedAdmin,
                action: 'forum_purged',
                category: 'system',
                courseId: context.courseId || undefined,
                studentClass: context.studentClass || undefined,
                details: purged,
            });
        }
        db.save();
        res.json({ success: true });
    });
});

module.exports = router;
