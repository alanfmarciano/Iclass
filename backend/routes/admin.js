const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const db = require('../database.js');
const {
    DB_STUDENTS_FILE,
    DB_SUBMISSIONS_FILE,
    CONFIG_FILE,
    DB_CLASSES_FILE,
    readJSON,
    writeJSON,
    validateAdmin,
    findClassByNameAndCourse,
    getCourseForClass,
    getCourseItemKeys,
    isProfessorAccount,
    adminAllowedCourseIds,
    adminCanAccessCourse,
    adminCanAccessClass,
    adminCanAccessItem,
    filterClassesForAdmin,
    filterStudentsForAdmin,
    filterSubmissionsForAdmin,
    filterSchoolsForAdmin,
    adminCanAccessStudent,
    isCourseExamKey
} = require('../middlewares.js');
const { parseEvaluationMarkdown } = require('../utils/parser.js');
const { gradeAttempt, correctAnswerFor } = require('../utils/examGrading.js');
const { alternativeLabelsMode, seenAlternativeLetter, seenLetterFor } = require('../utils/examAnswerIds.js');
const { canAccessAdminPermission } = require('../utils/adminPermissions.js');
const { stripFileAccessTokens } = require('../utils/contentMedia.js');
const {
    DEFAULT_STATUS,
    STUDENT_STATUSES,
    extractStudentFields,
    validateStudentFields,
    diffStudentForAudit,
    recordStudentAudit,
    OBSERVATION_CATEGORIES,
    OBSERVATION_VISIBILITY,
    classEntryName,
    studentInClass,
    normalizeClassEntriesForStorage,
} = require('../utils/students.js');
const { extractBranding, extractInstitutional, validateBrandingPatch } = require('../utils/branding.js');
const { VALID_POLICIES, calculateAttemptResult, enrichSubmissionsWithAttemptResult, normalizeScore } = require('../utils/submissionAttempts.js');
const {
    MANUAL_TYPES,
    buildClassGradebook,
    buildCsv,
    buildStudentReportModules,
    createResolvedGroupKey,
    describeSubmissionGrade,
    examTitle,
    formatDateTimeBR,
    formatGradeBR,
    gradeCountsMismatch,
    gradeFromScore,
    gradebookCsv,
    isEmptyInput,
    parseCountInput,
    parseGradeInput,
    recordGradeAudit,
    safeFilePart,
    scopeLabel,
    scopeSubmissionsToContext,
    scoreFromCounts,
    scoreFromGrade,
    structureExamIndex,
    anonymizeStudentAuditTrail,
    anonymizeStudentExamRecords,
    studentEmailOwnership,
} = require('../utils/gradebook.js');
const { isStudentSessionOnline, sessionLastSeen } = require('../utils/studentSessions.js');
const {
    ACTIVE_APPLICATION_STATUSES,
    applicationToOnlineConfig,
    examStateKey,
    findExamApplication,
    findOpenAttemptState,
    transitionExamApplication,
} = require('../utils/examApplications.js');
const { attemptOverdueMs, countAnswers, deliveredWithoutAttemptsLeft, reopenDeadlineDeliveries, settleExpiredAttempts } = require('../utils/examDeadline.js');
const { planControlAction, resolveInProgressAttempts } = require('../utils/examFinish.js');

function rejectInvalidBranding(res, body) {
    const validationError = validateBrandingPatch(body);
    if (!validationError) return false;
    res.status(400).json({ error: validationError.message, code: validationError.code, field: validationError.field });
    return true;
}

function recordAcademicAudit(req, actor, type, target, before, after) {
    if (!Array.isArray(db.memory.auditLogs)) db.memory.auditLogs = [];
    db.memory.auditLogs.push({
        id: `audit_academic_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        type,
        actorEmail: actor && actor.email,
        target,
        before: before || null,
        after: after || null,
        at: Date.now(),
        ip: req.ip || req.socket && req.socket.remoteAddress || '',
    });
}
const fileStore = require('../utils/storage.js');
const settingsUtil = require('../utils/settings.js');
const { computeStudentDashboard, studentOverview, buildOverviewIndex } = require('../utils/studentAnalytics.js');
const { computeNow, computeQueue, computeTrends } = require('../utils/dashboardAggregates.js');
const attendanceUtil = require('../utils/attendance.js');
const runtimePaths = require('../runtimePaths.js');
const { isBlockedUploadName, validateUploadedFile } = require('../utils/uploadSecurity.js');
const { createAdminRecoveryRouter } = require('./adminRecovery.js');
const { createAdminArchiveRouter } = require('./adminArchive.js');
const { createAdminSystemRouter } = require('./adminSystem.js');
const { createAdminAccountsRouter } = require('./adminAccounts.js');
const { createAdminExamConfigRouter } = require('./adminExamConfig.js');
const {
    addExtraUnit,
    courseClasses: contentCourseClasses,
    effectiveStructure,
    ensureOverrides,
    findClass: findContentClass,
    forkEvaluation,
    forkMaterial,
    resetOverridesForCourseItem,
    resolveBaseKey,
    uniqueVariantKey,
} = require('../utils/classContent.js');

const VERSION_LABELS = ['A', 'B', 'C', 'D'];
const DEFAULT_ONLINE_DURATION_MINUTES = 60;
const DEFAULT_WAITING_ROOM_MINUTES = 10;
const CLASS_PERIODS = ['Manhã', 'Tarde', 'Noite'];
function normalizeClassPeriod(value) {
    const normalized = String(value || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    return CLASS_PERIODS.find(period => period.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() === normalized) || null;
}
function isDeletedCourse(course) {
    return course && (course.deleted === true || course.status === 'deleted' || course.status === 'inactive' || !!course.deletedAt);
}

function courseUnitKeys(course) {
    return (course.structure || []).flatMap(mod => (mod.units || mod.items || []).map(unit => unit.apostilaKey || unit.key).filter(Boolean));
}

function moduleHours(mod) {
    const field = Number(mod.hours != null ? mod.hours : mod.carga);
    if (Number.isFinite(field) && field > 0) return field;
    const m = String(mod.name || mod.title || '').match(/(\d+)\s*h/i);
    return m ? Number(m[1]) : 0;
}

function estimateCourseHours(course) {
    return (course.structure || []).reduce((sum, mod) => sum + moduleHours(mod), 0);
}

function studentClassNames(student) {
    const raw = student.classes && student.classes.length ? student.classes : (student.studentClass ? [student.studentClass] : []);
    return raw.map(cls => typeof cls === 'string' ? cls : cls && cls.name).filter(Boolean);
}

function studentBelongsToClass(student, className, courseId) {
    const raw = student && Array.isArray(student.classes) && student.classes.length
        ? student.classes
        : (student && student.studentClass ? [student.studentClass] : []);
    const fallbackCourseId = String(student && (student.courseId || student.currentCourseId) || '').trim();
    const expectedCourseId = String(courseId || '').trim();
    return raw.some(entry => {
        const entryName = String(typeof entry === 'string' ? entry : entry && (entry.name || entry.className) || '').trim();
        if (entryName !== className) return false;
        const entryCourseId = String(typeof entry === 'object' && entry ? entry.courseId || fallbackCourseId : fallbackCourseId).trim();
        return !expectedCourseId || !entryCourseId || entryCourseId === expectedCourseId;
    });
}

// Contexto curso/turma das notas (Resultados, quadro, planilhas e boletim), com os
// alunos e turmas para situar registros antigos sem curso (ver gradebook.js).
function gradeScope(courseId, studentClass) {
    return { courseId, studentClass, students: db.memory.students || [], classes: db.memory.classes || [] };
}

// ----------------------------------------------------
// ROTAS DE API DO INSTRUTOR (ADMINISTRADOR)
// ----------------------------------------------------

function enrollmentRows(courseId = '', studentClass = '') {
    const courses = db.memory.courses || [];
    const classes = db.memory.classes || [];
    return (db.memory.students || []).flatMap(student => (student.enrollmentRequests || []).map(request => {
        const course = courses.find(item => item.id === request.courseId);
        const requestedClass = classes.find(item => item.courseId === request.courseId && item.name === request.requestedClassName);
        return {
            ...request,
            studentName: student.nomeSocial || student.name || student.email,
            studentEmail: student.email,
            studentPhone: student.phone || '',
            guardian: student.guardian || null,
            courseName: course?.name || request.courseId,
            requestedPeriod: request.requestedPeriod || requestedClass?.period || '',
        };
    })).filter(request => (!courseId || request.courseId === courseId)
        && (!studentClass || request.requestedClassName === studentClass || request.assignedClassName === studentClass))
        .sort((a, b) => {
            if (a.status === 'pending' && b.status !== 'pending') return -1;
            if (a.status !== 'pending' && b.status === 'pending') return 1;
            return Number(b.createdAt || 0) - Number(a.createdAt || 0);
        });
}

function findEnrollmentRequest(requestId) {
    for (const student of (db.memory.students || [])) {
        const request = (student.enrollmentRequests || []).find(item => item.id === requestId);
        if (request) return { student, request };
    }
    return null;
}

router.get('/api/admin/enrollment-requests', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        if (isProfessorAccount(matchedAdmin)) return res.status(403).json({ error: 'Aprovação de matrícula é exclusiva do administrador.' });
        const courseId = String(req.query.courseId || '').trim();
        const studentClass = String(req.query.studentClass || '').trim();
        if (studentClass && !findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId)) {
            return res.status(404).json({ error: 'Turma não encontrada.' });
        }
        const rows = enrollmentRows(courseId, studentClass);
        res.json({ requests: rows, pendingCount: rows.filter(item => item.status === 'pending').length });
    });
});

router.post('/api/admin/enrollment-requests/:id/approve', (req, res) => {
    // validateAdmin entrega (config, conta): com um só parâmetro a conta era o config e o
    // bloqueio de professor nunca valia.
    validateAdmin(req, res, async (config, matchedAdmin) => {
        if (isProfessorAccount(matchedAdmin)) return res.status(403).json({ error: 'Aprovação de matrícula é exclusiva do administrador.' });
        const found = findEnrollmentRequest(req.params.id);
        if (!found) return res.status(404).json({ error: 'Solicitação não encontrada.' });
        if (found.request.status !== 'pending') return res.status(409).json({ error: 'Esta solicitação já foi analisada.' });
        const className = String(req.body.className || found.request.requestedClassName || '').trim();
        const cls = (db.memory.classes || []).find(item => item.courseId === found.request.courseId && item.name === className);
        if (!cls) return res.status(400).json({ error: 'Escolha uma turma válida deste curso.' });
        if (!Array.isArray(found.student.classes)) found.student.classes = [];
        const alreadyMember = found.student.classes.some(item => {
            if (item && typeof item === 'object') return item.courseId === cls.courseId && item.name === cls.name;
            return item === cls.name;
        });
        if (!alreadyMember) found.student.classes.push({ name: cls.name, courseId: cls.courseId, period: cls.period || '' });
        if (!found.student.studentClass) {
            found.student.studentClass = cls.name;
            found.student.period = cls.period || '';
        }
        const now = Date.now();
        found.request.status = 'approved';
        found.request.assignedClassName = cls.name;
        found.request.assignedPeriod = cls.period || '';
        found.request.reviewedAt = now;
        found.request.updatedAt = now;
        found.request.reviewedBy = matchedAdmin?.email || 'admin';
        found.request.rejectionReason = '';
        found.student.updatedAt = now;
        recordStudentAudit(db.memory, {
            actor: matchedAdmin?.email || 'admin',
            studentEmail: found.student.email,
            action: 'enrollment_approved',
            changes: [{ field: 'Matrícula', oldValue: 'Pendente', newValue: `${found.request.courseId} · ${cls.name}` }],
            req,
        });
        await db.save();
        res.json({ success: true, request: found.request });
    });
});

router.post('/api/admin/enrollment-requests/:id/reject', (req, res) => {
    // validateAdmin entrega (config, conta): com um só parâmetro a conta era o config e o
    // bloqueio de professor nunca valia.
    validateAdmin(req, res, async (config, matchedAdmin) => {
        if (isProfessorAccount(matchedAdmin)) return res.status(403).json({ error: 'Aprovação de matrícula é exclusiva do administrador.' });
        const found = findEnrollmentRequest(req.params.id);
        if (!found) return res.status(404).json({ error: 'Solicitação não encontrada.' });
        if (found.request.status !== 'pending') return res.status(409).json({ error: 'Esta solicitação já foi analisada.' });
        const reason = String(req.body.reason || '').trim();
        if (!reason) return res.status(400).json({ error: 'Informe o motivo da recusa.' });
        const now = Date.now();
        found.request.status = 'rejected';
        found.request.rejectionReason = reason.slice(0, 500);
        found.request.reviewedAt = now;
        found.request.updatedAt = now;
        found.request.reviewedBy = matchedAdmin?.email || 'admin';
        found.student.updatedAt = now;
        recordStudentAudit(db.memory, {
            actor: matchedAdmin?.email || 'admin',
            studentEmail: found.student.email,
            action: 'enrollment_rejected',
            changes: [{ field: 'Matrícula', oldValue: 'Pendente', newValue: `Recusada: ${found.request.rejectionReason}` }],
            req,
        });
        await db.save();
        res.json({ success: true, request: found.request });
    });
});



// Redefinir senha do aluno
router.post('/api/admin/reset-password', (req, res) => {
    validateAdmin(req, res, () => {
        const { email, newPassword } = req.body;
        if (!email || !newPassword || newPassword.trim() === '') {
            return res.status(400).json({ error: 'E-mail ou nova senha inválidos.' });
        }

        const students = readJSON(DB_STUDENTS_FILE);
        const student = students.find(s => s.email && s.email.toLowerCase() === email.trim().toLowerCase());

        if (!student) {
            return res.status(404).json({ error: 'Estudante não encontrado.' });
        }

        student.password = db.hashPassword(newPassword.trim());
        student.recoveryRequested = false; // Limpa a solicitação de redefinição
        writeJSON(DB_STUDENTS_FILE, students);

        res.json({ success: true, message: 'Senha redefinida com sucesso!' });
    });
});

// Excluir conta do aluno e dados pessoais associados.
// Vale para todos os e-mails conhecidos do aluno (o atual e os anteriores, pelas trocas
// de e-mail registradas na auditoria), sempre por campo exato: excluir ana@ não toca
// joana@. É a única anonimização de aluno: não há anonimização automática no boot.
// Registro gravado com um e-mail que outro aluno cadastrado usou antes (e-mail antigo
// reaproveitado) é do outro aluno no período em que o e-mail era dele e fica; e-mail que
// também é de professor não leva a autoria do professor (studentEmailOwnership).
router.post('/api/admin/delete-student', (req, res) => {
    validateAdmin(req, res, () => {
        const { email } = req.body || {};
        if (typeof email !== 'string' || email.trim() === '') {
            return res.status(400).json({ error: 'E-mail do estudante não informado.' });
        }

        const normalizedEmail = email.trim().toLowerCase();
        const students = readJSON(DB_STUDENTS_FILE);
        const studentObjToDelete = students.find(s => s.email && s.email.toLowerCase() === normalizedEmail);

        if (!studentObjToDelete) {
            return res.status(404).json({ error: 'Estudante não encontrado.' });
        }

        // Antes de tirar o aluno do cadastro: a linha do tempo dos e-mails usa todos os alunos.
        const { emails, owns } = studentEmailOwnership(db.memory, normalizedEmail);
        // Registro do aluno: e-mail dele na data do registro (sem data: o e-mail atual).
        const ownedRecord = (item, value, kind = 'student') => !!item && owns(value, item, kind);
        const studentFiles = (db.memory.attendance || [])
            .filter(item => ownedRecord(item, item.studentEmail))
            .map(item => item.justificativa && item.justificativa.arquivo)
            .filter(Boolean);

        db.memory.students = students.filter(s => !s.email || s.email.toLowerCase() !== normalizedEmail);
        db.memory.submissions = readJSON(DB_SUBMISSIONS_FILE).filter(s => !(s && s.student && ownedRecord(s, s.student.email)));

        emails.forEach(known => {
            if (!owns(known, null, 'student')) return;
            ['progress', 'notes', 'annotations', 'sessions'].forEach(collection => {
                if (db.memory[collection]) delete db.memory[collection][known];
            });
        });
        // O log de auditoria é mantido como histórico, mas sem ligação com o aluno: as
        // entradas perdem o e-mail, o nome e a matrícula e as cópias das notas na lixeira
        // ficam só com prova e nota (para a estatística).
        anonymizeStudentAuditTrail(db.memory, {
            emails,
            owns,
            names: [studentObjToDelete.name, studentObjToDelete.nomeSocial],
            matriculas: [studentObjToDelete.matricula],
        });
        // Contestações de questão (com o texto livre do aluno), tempo extra e versão da prova.
        anonymizeStudentExamRecords(db.memory, { emails, owns });
        // Dados pessoais restantes indexados pelo e-mail (presença, acessos, observações,
        // certificados, logs de prova e de login). Login de professor com o mesmo e-mail fica.
        ['attendance', 'moduleAccess', 'pedagogicalObservations', 'certificates', 'proctoringLogs', 'examKeystrokes', 'loginLogs']
            .forEach(collection => {
                if (!Array.isArray(db.memory[collection])) return;
                db.memory[collection] = db.memory[collection].filter(item => !(item && ownedRecord(item, item.studentEmail || item.email,
                    collection === 'loginLogs' && item.role && item.role !== 'student' ? 'anyone' : 'student')));
            });
        // Fórum: as respostas dele saem; a dúvida dele sai inteira, a não ser que outra
        // pessoa tenha respondido: aí fica sem nome, e-mail e texto, com as respostas dos
        // outros. No histórico da dúvida fica "aluno excluído".
        const replyKind = item => (item && (item.authorRole === 'Aluno' || item.role === 'Aluno') ? 'student' : 'anyone');
        if (Array.isArray(db.memory.forum)) {
            db.memory.forum.forEach(comment => {
                if (!comment) return;
                if (Array.isArray(comment.replies)) comment.replies = comment.replies.filter(reply => !(reply && ownedRecord(reply, reply.authorEmail, replyKind(reply))));
                (Array.isArray(comment.events) ? comment.events : []).forEach(event => {
                    if (event && ownedRecord({ at: event.at }, event.by, replyKind(event))) { event.by = 'aluno excluído'; event.byName = 'Aluno excluído'; }
                });
                if (comment.deletedBy && ownedRecord(comment, comment.deletedBy, 'anyone')) comment.deletedBy = 'aluno excluído';
            });
            db.memory.forum = db.memory.forum.filter(comment => {
                if (!comment || !ownedRecord(comment, comment.studentEmail)) return true;
                if (!(comment.replies || []).length) return false;
                comment.studentEmail = '';
                comment.studentName = 'Aluno excluído';
                comment.text = 'Texto removido (aluno excluído).';
                comment.studentAnonymized = true;
                comment.anonymizedAt = new Date().toISOString();
                return true;
            });
        }
        // Mensagens da prova e avisos só para ele saem; nos outros, sai das listas de leitura.
        if (Array.isArray(db.memory.broadcastMessages)) {
            db.memory.broadcastMessages = db.memory.broadcastMessages.filter(message => !(message && ownedRecord(message, message.targetEmail)));
            db.memory.broadcastMessages.forEach(message => {
                ['acknowledgedBy', 'deletedFor'].forEach(field => {
                    if (message && Array.isArray(message[field])) message[field] = message[field].filter(value => !owns(value, null, 'student'));
                });
            });
        }
        if (Array.isArray(db.memory.announcements)) {
            db.memory.announcements = db.memory.announcements.filter(item => !(item && item.target === 'aluno' && ownedRecord(item, item.targetValue)));
            db.memory.announcements.forEach(item => {
                if (item && Array.isArray(item.readBy)) item.readBy = item.readBy.filter(value => !owns(value, null, 'student'));
            });
        }
        Object.keys(db.memory.studentExamState || {}).forEach(key => {
            const state = db.memory.studentExamState[key];
            if (state && owns(state.studentEmail, null, 'student')) delete db.memory.studentExamState[key];
        });

        const classes = readJSON(DB_CLASSES_FILE);
        classes.forEach(cls => {
            Object.keys((cls && cls.studentReleasedItems) || {}).forEach(key => {
                if (owns(key, null, 'student')) delete cls.studentReleasedItems[key];
            });
        });
        db.memory.classes = classes;

        // Pasta do aluno vai para a lixeira (documentos preservados de forma identificável).
        // Homônimo sem matrícula usa a mesma pasta (matrícula + nome): aí só os arquivos
        // ligados à presença do aluno excluído vão para a lixeira; os do outro ficam.
        try {
            const folder = fileStore.studentFolderName(studentObjToDelete);
            const dir = path.join(fileStore.ALUNOS_DIR, folder);
            const shared = db.memory.students.some(other => fileStore.studentFolderName(other).toLowerCase() === folder.toLowerCase());
            if (!shared) {
                if (fs.existsSync(dir)) fileStore.moveDirToTrash(dir);
            } else {
                const base = path.resolve(dir);
                [...new Set(studentFiles)].forEach(rel => {
                    if (!fileStore.isInsideStudents(rel)) return;
                    const target = path.resolve(fileStore.absFromData(rel));
                    if (target.startsWith(base + path.sep) && fs.existsSync(target)) fileStore.moveToTrash(target);
                });
            }
        } catch (e) {}

        db.save();
        res.json({ success: true, message: 'Estudante removido com sucesso.' });
    });
});

// Obter submissões de provas
router.get('/api/admin/submissions', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const submissions = readJSON(DB_SUBMISSIONS_FILE);
        const courseId = String(req.query.courseId || '').trim();
        const studentClass = String(req.query.studentClass || '').trim();
        // Mesmo recorte do boletim e da planilha: registro antigo sem curso entra
        // só no curso da matrícula do aluno naquela turma.
        const scoped = scopeSubmissionsToContext(filterSubmissionsForAdmin(submissions, matchedAdmin), gradeScope(courseId, studentClass));
        res.json(enrichSubmissionsWithAttemptResult(scoped));
    });
});

const RESULT_POLICY_LABELS = { highest: 'Melhor nota', latest: 'Última tentativa', average: 'Média das consideradas', selected: 'Tentativa escolhida' };

// Controla quais tentativas entram no resultado e como a nota consolidada é calculada.
// Cada mudança fica na auditoria do aluno com a nota antes e depois (AVA-08).
router.post('/api/admin/submissions/result-control', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const { submissionId, action, policy } = req.body || {};
        const submissions = readJSON(DB_SUBMISSIONS_FILE);
        const allowedIds = new Set(filterSubmissionsForAdmin(submissions, matchedAdmin).map(item => String(item.id)));
        const target = submissions.find(item => String(item.id) === String(submissionId) && allowedIds.has(String(item.id)));
        if (!target) return res.status(404).json({ error: 'Tentativa não encontrada.' });

        // Mesmo grupo que Resultados, boletim e quadro mostram: registro antigo sem
        // curso entra no grupo do lançamento novo da mesma prova (curso/turma
        // completados pela matrícula). Antes a ação mexia só em parte do grupo e a
        // nota mostrada não mudava.
        const groups = createResolvedGroupKey(gradeScope('', ''));
        const groupKey = groups.key(target);
        const group = submissions.filter(item => allowedIds.has(String(item.id)) && groups.key(item) === groupKey);
        if (group.length === 0) return res.status(404).json({ error: 'Tentativas não encontradas.' });
        const groupResult = () => enrichSubmissionsWithAttemptResult(group.map(groups.resolved));
        const before = groupResult().find(item => String(item.id) === String(target.id));

        if (action === 'archive') {
            target.resultStatus = 'archived';
            target.selectedForResult = false;
            target.archivedAt = new Date().toISOString();
            target.archivedBy = matchedAdmin?.email || 'admin';
        } else if (action === 'restore') {
            target.resultStatus = 'considered';
            target.archivedAt = null;
            target.archivedBy = null;
        } else if (action === 'select') {
            group.forEach(item => {
                item.aggregationPolicy = 'selected';
                item.selectedForResult = String(item.id) === String(target.id);
            });
            target.resultStatus = 'considered';
            target.archivedAt = null;
            target.archivedBy = null;
        } else if (action === 'policy') {
            if (!VALID_POLICIES.has(policy)) return res.status(400).json({ error: 'Regra de cálculo inválida.' });
            group.forEach(item => { item.aggregationPolicy = policy; });
            if (policy === 'selected' && !group.some(item => item.selectedForResult && item.resultStatus !== 'archived')) {
                const fallback = [...group].filter(item => item.resultStatus !== 'archived').sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))[0];
                if (fallback) fallback.selectedForResult = true;
            }
        } else {
            return res.status(400).json({ error: 'Ação de resultado inválida.' });
        }

        const refreshed = groupResult();
        const after = refreshed.find(item => String(item.id) === String(target.id));
        const title = examTitle(target.examKey, { evaluations: db.memory.evaluations });
        const policyLabel = value => RESULT_POLICY_LABELS[value] || value || 'Melhor nota';
        const consolidated = item => (item && item.consolidatedScore != null ? formatGradeBR(item.consolidatedScore) : 'sem nota');
        const actionLabel = {
            archive: `tentativa ${target.attemptNumber || 1} desconsiderada`,
            restore: `tentativa ${target.attemptNumber || 1} reconsiderada`,
            select: `tentativa ${target.attemptNumber || 1} escolhida para a nota`,
            policy: `regra: ${policyLabel(policy)}`,
        }[action];
        recordGradeAudit(db.memory, {
            req,
            actor: matchedAdmin,
            submission: target,
            action: `grade_result_${action}`,
            field: 'Composição da nota',
            oldValue: `${title}: ${consolidated(before)} (regra: ${policyLabel(before?.aggregationPolicy)})`,
            newValue: `${title}: ${consolidated(after)} · ${actionLabel}`,
        });
        writeJSON(DB_SUBMISSIONS_FILE, submissions);
        res.json({ success: true, submissions: refreshed });
    });
});

// Visualização completa e corrigida de uma tentativa.
router.get('/api/admin/submissions/:id/review', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const submissions = readJSON(DB_SUBMISSIONS_FILE);
        const allowed = filterSubmissionsForAdmin(submissions, matchedAdmin);
        const submission = allowed.find(item => String(item.id) === String(req.params.id));
        if (!submission) return res.status(404).json({ error: 'Entrega não encontrada.' });

        const gradedAnswers = Array.isArray(submission.gradedAnswers) ? submission.gradedAnswers : [];
        const gradedByNumber = new Map(gradedAnswers.map(answer => [Number(answer.questionNumber), answer]));
        const submittedNumbers = gradedAnswers.map(answer => Number(answer.questionNumber)).filter(Number.isFinite);
        let snapshot = submission.examSnapshot && Array.isArray(submission.examSnapshot.questions)
            ? submission.examSnapshot
            : null;
        let source = snapshot ? 'attempt' : null;

        if (!snapshot && submittedNumbers.length > 0) {
            const studentClass = submission.studentClass || submission.student?.studentClass;
            const courseId = submission.courseId || submission.student?.courseId;
            const cls = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId);
            const history = cls?.examHistory && Array.isArray(cls.examHistory[submission.examKey])
                ? cls.examHistory[submission.examKey]
                : [];
            const historyEntries = submission.activeHistoryId
                ? [...history.filter(entry => entry.id === submission.activeHistoryId), ...history.filter(entry => entry.id !== submission.activeHistoryId).reverse()]
                : [...history].reverse();
            for (const entry of historyEntries) {
                const rawSnapshots = Array.isArray(entry.versionSnapshots) && entry.versionSnapshots.length
                    ? entry.versionSnapshots
                    : (Array.isArray(entry.printSnapshot) ? entry.printSnapshot : []);
                const candidates = rawSnapshots.filter(candidate => String(candidate?.version || 'A').toUpperCase() === String(submission.assignedVersion || 'A').toUpperCase());
                const matched = candidates.find(candidate => {
                    const numbers = new Set((candidate.questions || []).map(question => Number(question.originalNumber || question.number)));
                    return submittedNumbers.every(number => numbers.has(number));
                });
                if (matched) {
                    snapshot = matched;
                    source = 'history';
                    break;
                }
            }
        }

        let questions = snapshot && Array.isArray(snapshot.questions) ? snapshot.questions : [];
        if (questions.length === 0 && submittedNumbers.length > 0) {
            const evaluation = db.memory.evaluations[submission.examKey];
            const available = Array.isArray(evaluation?.questions) ? evaluation.questions : [];
            questions = submittedNumbers.map(number => available.find((question, index) => Number(question.originalNumber || question.number || index + 1) === number)).filter(Boolean);
            source = 'evaluation';
        }

        const reviewQuestions = questions
            .map((question, index) => {
                const questionNumber = Number(question.originalNumber || question.number || index + 1);
                const graded = gradedByNumber.get(questionNumber);
                if (!graded) return null;
                const studentChoice = graded.studentChoice ? String(graded.studentChoice).toUpperCase() : null;
                const correctAnswer = graded.correctAnswer ? String(graded.correctAnswer).toUpperCase() : null;
                const rawAlternatives = Array.isArray(question.alternatives)
                    ? question.alternatives
                    : Object.entries(question.alternatives || {}).map(([letter, text]) => ({ letter, text }));
                return {
                    position: index + 1,
                    questionNumber,
                    text: question.questionText || question.text || `Questão ${questionNumber}`,
                    studentChoice,
                    correctAnswer,
                    // Letras como o aluno viu (AVA-05); studentChoice/correctAnswer são as originais.
                    studentChoiceSeen: seenLetterFor(submission, { alternatives: rawAlternatives }, studentChoice),
                    correctAnswerSeen: seenLetterFor(submission, { alternatives: rawAlternatives }, correctAnswer),
                    isCorrect: graded.isCorrect === true,
                    alternatives: rawAlternatives.map((alternative, alternativeIndex) => {
                        const canonicalLetter = String(alternative.letter || String.fromCharCode(65 + alternativeIndex)).toUpperCase();
                        return {
                            // letter: a que o aluno viu na tela; canonicalLetter: a original (gabarito).
                            letter: seenAlternativeLetter(submission, alternative, alternativeIndex),
                            canonicalLetter,
                            text: alternative.text ?? alternative.label ?? String(alternative),
                            selectedByStudent: canonicalLetter === studentChoice,
                            correct: canonicalLetter === correctAnswer || alternative.isCorrect === true
                        };
                    })
                };
            })
            .filter(Boolean);

        // Histórico da nota: auditoria desta entrega (lançamento, publicação,
        // composição) e recorreções por anulação/troca de questão (scoreHistory).
        const history = [
            ...(db.memory.auditLogs || [])
                .filter(entry => entry && entry.submissionId != null && String(entry.submissionId) === String(submission.id))
                .map(entry => ({ id: entry.id, at: entry.timestamp, actor: entry.actor, field: entry.field, oldValue: entry.oldValue, newValue: entry.newValue })),
            ...(Array.isArray(submission.scoreHistory) ? submission.scoreHistory : [])
                .filter(entry => !entry.auditId)
                .map((entry, index) => ({ id: `score_${index}`, at: Date.parse(entry.at) || entry.at, actor: entry.by || 'sistema', field: 'Nota recalculada', oldValue: formatGradeBR(entry.from), newValue: `${formatGradeBR(entry.to)}${entry.reason ? ` · ${entry.reason}` : ''}` })),
        ].sort((a, b) => Number(b.at || 0) - Number(a.at || 0));

        res.json({
            success: true,
            source,
            submissionId: submission.id,
            alternativeLabels: alternativeLabelsMode(submission),
            assignedVersion: submission.assignedVersion || snapshot?.version || 'A',
            examCode: submission.examSnapshot?.examCode || snapshot?.examCode || null,
            questions: reviewQuestions,
            history
        });
    });
});

router.post('/api/admin/submissions/publish', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const rawIds = req.body?.ids;
        if (!Array.isArray(rawIds) || rawIds.some(id => !['string', 'number'].includes(typeof id))) {
            return res.status(400).json({ error: 'Selecione ao menos uma nota.' });
        }
        if (req.body?.published !== undefined && typeof req.body.published !== 'boolean') {
            return res.status(400).json({ error: 'Informe se a nota deve ser publicada ou ocultada.' });
        }
        const ids = new Set(rawIds.map(String));
        const published = req.body?.published !== false;
        if (ids.size === 0) return res.status(400).json({ error: 'Selecione ao menos uma nota.' });
        const submissions = readJSON(DB_SUBMISSIONS_FILE);
        const allowedIds = new Set(filterSubmissionsForAdmin(submissions, matchedAdmin).map(item => String(item.id)));
        let updated = 0;
        let skippedInvalid = 0;
        submissions.forEach(item => {
            if (!ids.has(String(item.id)) || !allowedIds.has(String(item.id))) return;
            // Nota inválida (vazia ou fora de 0 a 10, de registros antigos) nunca é publicada.
            if (published && normalizeScore(item.score) === null) { skippedInvalid++; return; }
            const wasPublished = item.gradePublished === true;
            item.gradePublished = published;
            item.gradePublishedAt = published ? Date.now() : null;
            item.gradePublishedBy = published ? (matchedAdmin?.email || 'admin') : null;
            updated++;
            if (wasPublished !== published) {
                recordGradeAudit(db.memory, {
                    req,
                    actor: matchedAdmin,
                    submission: item,
                    action: published ? 'grade_publish' : 'grade_unpublish',
                    field: 'Publicação da nota',
                    oldValue: `${describeSubmissionGrade(item, examTitle(item.examKey, { evaluations: db.memory.evaluations }))} · ${wasPublished ? 'publicada' : 'em revisão'}`,
                    newValue: published ? 'publicada para o aluno' : 'oculta do aluno',
                });
            }
        });
        writeJSON(DB_SUBMISSIONS_FILE, submissions);
        res.json({ success: true, updated, published, skippedInvalid });
    });
});

// Excluir registro de submissão. A entrega sai das listas e vai para a lixeira de
// notas: a auditoria do aluno guarda uma cópia completa do registro, de onde ele
// pode ser restaurado (AVA-08).
router.post('/api/admin/submissions/delete', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const { id, studentEmail, examKey } = req.body || {};
        const submissions = readJSON(DB_SUBMISSIONS_FILE);
        const allowedIds = new Set(filterSubmissionsForAdmin(submissions, matchedAdmin).map(item => String(item.id)));
        let removed;
        if (id !== undefined && id !== null && id !== '') {
            if (!['string', 'number'].includes(typeof id)) return res.status(400).json({ error: 'Identificador da tentativa inválido.' });
            if (!allowedIds.has(String(id))) return res.status(404).json({ error: 'Tentativa não encontrada.' });
            removed = submissions.filter(item => String(item.id) === String(id));
        } else {
            if (typeof studentEmail !== 'string' || !studentEmail.trim() || typeof examKey !== 'string' || !examKey.trim()) {
                return res.status(400).json({ error: 'Dados insuficientes para exclusão.' });
            }
            const normalizedEmail = studentEmail.trim().toLowerCase();
            removed = submissions.filter(item => (
                allowedIds.has(String(item.id)) &&
                item.student?.email?.toLowerCase() === normalizedEmail &&
                item.examKey === examKey.trim()
            ));
        }
        if (removed.length === 0) return res.status(404).json({ error: 'Tentativa não encontrada.' });

        const removedSet = new Set(removed);
        removed.forEach(item => {
            recordGradeAudit(db.memory, {
                req,
                actor: matchedAdmin,
                submission: item,
                action: 'grade_delete',
                field: 'Nota',
                oldValue: `${describeSubmissionGrade(item, examTitle(item.examKey, { evaluations: db.memory.evaluations }))} · tentativa ${item.attemptNumber || 1}${item.gradePublished === true ? ' · publicada' : ''}`,
                newValue: 'registro excluído',
                details: { deletedSubmission: item },
            });
        });
        writeJSON(DB_SUBMISSIONS_FILE, submissions.filter(item => !removedSet.has(item)));
        res.json({ success: true, removed: removed.length, message: 'Registro de prova excluído com sucesso!' });
    });
});

// Lixeira de notas (AVA-08): exclusões (grade_delete) com a cópia do registro que
// ainda não voltaram. "Voltou" = existe um grade_restore apontando para aquela
// exclusão (a auditoria nunca é reescrita) ou a entrega já está de novo na lista.
function deletedGradeEntries() {
    const logs = db.memory.auditLogs || [];
    const restored = new Set(logs
        .filter(entry => entry && entry.action === 'grade_restore' && entry.details && entry.details.fromAuditId)
        .map(entry => String(entry.details.fromAuditId)));
    const current = new Set((db.memory.submissions || []).map(item => String(item && item.id)));
    return logs.filter(entry => entry && entry.action === 'grade_delete'
        && entry.details && entry.details.deletedSubmission && entry.details.deletedSubmission.id != null
        && !restored.has(String(entry.id))
        && !current.has(String(entry.details.deletedSubmission.id)));
}

function registeredStudentByEmail(email) {
    const normalized = String(email || '').trim().toLowerCase();
    return normalized ? (db.memory.students || []).find(item => item.email && item.email.toLowerCase() === normalized) || null : null;
}

// Cópia da nota excluída com o e-mail atual do aluno. A troca de e-mail renomeia a
// cópia (renameStudentEmailEverywhere); trocas feitas antes disso só renomearam o
// studentEmail da auditoria, então ele vale quando o e-mail da cópia saiu do cadastro.
function deletedCopyWithCurrentEmail(entry) {
    const copy = entry.details.deletedSubmission;
    // Cópia anonimizada (aluno excluído) não ganha de volta o e-mail da auditoria,
    // nem se outra conta for criada com ele.
    if (copy.anonymized === true) return copy;
    const copyEmail = String(copy.student?.email || copy.studentEmail || '').trim().toLowerCase();
    const auditEmail = String(entry.studentEmail || '').trim().toLowerCase();
    if (!auditEmail || auditEmail === copyEmail || registeredStudentByEmail(copyEmail) || !registeredStudentByEmail(auditEmail)) return copy;
    return { ...copy, student: { ...(copy.student || {}), email: auditEmail } };
}

// Notas excluídas da turma (lixeira), com quem excluiu e quando.
router.get('/api/admin/submissions/deleted', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const courseId = String(req.query.courseId || '').trim();
        const studentClass = String(req.query.studentClass || '').trim();
        const entries = deletedGradeEntries();
        const entryBySubmission = new Map(entries.map(entry => [String(entry.details.deletedSubmission.id), entry]));
        const copies = entries.map(deletedCopyWithCurrentEmail);
        const visible = scopeSubmissionsToContext(filterSubmissionsForAdmin(copies, matchedAdmin), gradeScope(courseId, studentClass));
        const items = visible.map(copy => {
            const entry = entryBySubmission.get(String(copy.id));
            const email = String(copy.student?.email || copy.studentEmail || '').trim().toLowerCase();
            const student = registeredStudentByEmail(email);
            return {
                auditId: entry.id,
                deletedAt: entry.timestamp,
                deletedBy: entry.actor,
                submissionId: copy.id,
                studentEmail: email,
                studentName: (student && student.name) || copy.student?.name || copy.studentName || email,
                examKey: copy.examKey || '',
                examTitle: examTitle(copy.examKey, { evaluations: db.memory.evaluations }),
                applicationId: copy.applicationId || null,
                attemptNumber: copy.attemptNumber || 1,
                type: copy.type || '',
                score: normalizeScore(copy.score),
                grade: formatGradeBR(copy.score) || null,
                gradePublished: copy.gradePublished === true,
                timestamp: copy.timestamp || null,
                canRestore: !!student && copy.anonymized !== true,
            };
        }).sort((a, b) => Number(b.deletedAt || 0) - Number(a.deletedAt || 0));
        res.json({ success: true, items });
    });
});

// Restaura uma nota excluída exatamente como estava (inclusive publicada ou não).
router.post('/api/admin/submissions/restore', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const auditId = typeof req.body?.auditId === 'string' ? req.body.auditId.trim() : '';
        if (!auditId) return res.status(400).json({ error: 'Informe a nota excluída que deve voltar.' });
        const entry = (db.memory.auditLogs || []).find(item => item && String(item.id) === auditId
            && item.action === 'grade_delete' && item.details && item.details.deletedSubmission);
        const copy = entry ? deletedCopyWithCurrentEmail(entry) : null;
        if (!entry || filterSubmissionsForAdmin([copy], matchedAdmin).length === 0) {
            return res.status(404).json({ error: 'Nota excluída não encontrada.' });
        }
        if (!deletedGradeEntries().some(item => item.id === entry.id)) {
            return res.status(409).json({ error: 'Esta nota já foi restaurada.' });
        }
        if (copy.anonymized === true) return res.status(409).json({ error: 'O aluno foi excluído e a nota ficou sem identificação; ela não pode voltar.' });
        const student = registeredStudentByEmail(copy.student?.email || copy.studentEmail);
        if (!student) return res.status(409).json({ error: 'O aluno não está mais no cadastro; a nota não pode voltar.' });

        const restored = {
            ...JSON.parse(JSON.stringify(copy)),
            restoredAt: new Date().toISOString(),
            restoredBy: matchedAdmin?.email || 'admin',
        };
        if (restored.student) restored.student.name = student.name || restored.student.name;
        const submissions = readJSON(DB_SUBMISSIONS_FILE);

        // A nota volta para o grupo de tentativas como ele está hoje: enquanto ela
        // estava na lixeira o professor pode ter lançado outra tentativa (que pegou o
        // mesmo número), escolhido outra nota ou mudado a regra.
        const groups = createResolvedGroupKey(gradeScope('', ''));
        const groupKey = groups.key(restored);
        const group = submissions.filter(item => groups.key(item) === groupKey);
        const notes = [];
        const originalAttempt = Number(restored.attemptNumber) || 1;
        if (group.some(item => (Number(item.attemptNumber) || 1) === originalAttempt)) {
            // Mesmo recorte do número de tentativa do lançamento manual (aluno + prova + curso).
            const restoredCourse = groups.resolved(restored).student?.courseId || null;
            const sameExam = submissions.filter(item => String(item.student?.email || '').toLowerCase() === String(restored.student?.email || '').toLowerCase()
                && item.examKey === restored.examKey
                && (!item.student?.courseId || !restoredCourse || String(item.student.courseId) === String(restoredCourse)));
            restored.attemptNumber = Math.max(...[...group, ...sameExam].map(item => Number(item.attemptNumber) || 1)) + 1;
            restored.restoredFromAttemptNumber = originalAttempt;
            notes.push(`volta como tentativa ${restored.attemptNumber} (o número ${originalAttempt} já estava em uso)`);
        }
        if (group.length > 0) {
            const current = calculateAttemptResult(group.map(groups.resolved));
            if (VALID_POLICIES.has(current.policy) && restored.aggregationPolicy !== current.policy) restored.aggregationPolicy = current.policy;
            if (restored.selectedForResult === true && group.some(item => item.selectedForResult === true && item.resultStatus !== 'archived')) {
                restored.selectedForResult = false;
                notes.push('outra tentativa continua escolhida para a nota');
            }
        }
        submissions.push(restored);
        recordGradeAudit(db.memory, {
            req,
            actor: matchedAdmin,
            submission: restored,
            action: 'grade_restore',
            field: 'Nota',
            oldValue: 'registro excluído',
            newValue: `${describeSubmissionGrade(restored, examTitle(restored.examKey, { evaluations: db.memory.evaluations }))} · restaurada da lixeira (${restored.gradePublished === true ? 'publicada' : 'em revisão'})${notes.length ? ` · ${notes.join(' · ')}` : ''}`,
            details: { fromAuditId: entry.id },
        });
        writeJSON(DB_SUBMISSIONS_FILE, submissions);
        res.json({
            success: true,
            submissionId: restored.id,
            attemptNumber: restored.attemptNumber || 1,
            message: `Nota de ${student.name || student.email} restaurada (${restored.gradePublished === true ? 'publicada' : 'em revisão'})${restored.restoredFromAttemptNumber ? `, como tentativa ${restored.attemptNumber}` : ''}.`,
        });
    });
});

// Questões da prova para o lançamento manual (banco do sistema ou .md legado),
// numeradas pelo número original. Lista vazia quando a prova não existe.
function loadManualExamQuestions(examKey) {
    let questions = [];
    const evaluation = db.memory.evaluations[examKey];
    if (evaluation) {
        questions = evaluation.questions;
    } else if (/^[A-Za-z0-9_-]+$/.test(examKey)) {
        const filePath = path.join(runtimePaths.CONTENT_DIR, `${examKey}.md`);
        if (fs.existsSync(filePath)) {
            const parsedObj = parseEvaluationMarkdown(fs.readFileSync(filePath, 'utf8'), examKey);
            questions = parsedObj ? parsedObj.questions : [];
        }
    }
    if (!Array.isArray(questions)) return [];
    return questions.map((question, index) => ({
        ...question,
        originalNumber: Number(question.originalNumber || question.number || index + 1)
    }));
}

// Total de questões que a turma usa nesta prova: a "Quantidade de questões" da
// configuração da prova na turma, sem as questões excluídas. É o total padrão do
// lançamento rápido e também o da prévia da tela (ENG-01), que o lê da rota
// manual-context para nunca divergir do que o servidor grava.
function manualExamTotals(cls, examKey, questions) {
    const examConfig = (cls && cls.examConfigs && cls.examConfigs[examKey]) || {};
    const excludedQuestions = new Set((examConfig.excludedQuestions || []).map(Number));
    const availableQuestions = questions.filter(q => !excludedQuestions.has(Number(q.originalNumber)));
    const configuredCount = parseInt(examConfig.questionCount, 10) || null;
    const defaultTotal = Math.min(configuredCount || availableQuestions.length, availableQuestions.length) || questions.length;
    return {
        availableQuestions,
        defaultTotal,
        questionCount: questions.length,
        configuredCount,
        excludedCount: questions.length - availableQuestions.length,
    };
}

// Totais da prova para a tela de lançamento (prévia "Nota que será gravada",
// placeholder do total e validação dos acertos), calculados como no lançamento.
router.get('/api/admin/submissions/manual-context', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const examKey = String(req.query.examKey || '').trim();
        const studentClass = String(req.query.studentClass || '').trim();
        const courseId = String(req.query.courseId || '').trim();
        if (!examKey || !studentClass) return res.status(400).json({ error: 'Turma e prova são obrigatórias.' });
        if (!adminCanAccessClass(matchedAdmin, studentClass, courseId)) return res.status(403).json({ error: 'Turma não autorizada para esta conta.' });
        const classes = readJSON(DB_CLASSES_FILE);
        const cls = findClassByNameAndCourse(classes, studentClass, courseId);
        if (!cls) return res.status(404).json({ error: 'Turma não encontrada neste curso.' });
        const questions = loadManualExamQuestions(examKey);
        if (questions.length === 0) return res.status(404).json({ error: 'Avaliação não encontrada ou sem questões cadastradas.' });
        const { defaultTotal, questionCount, configuredCount, excludedCount } = manualExamTotals(cls, examKey, questions);
        res.json({ examKey, studentClass: cls.name, courseId: cls.courseId || courseId, questionCount, defaultTotal, configuredCount, excludedCount });
    });
});

// Criar/Lançar registro de submissão manualmente pelo administrador.
// Modo rápido: nota de 0 a 10 (aceita vírgula) e/ou acertos e total; sem nota,
// ela é calculada pelos acertos. Modo cartão-resposta: corrige as letras marcadas
// pelo gabarito da prova. Tudo validado no servidor (ENG-01, CONF-14, AVA-08).
router.post('/api/admin/submissions/create', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const body = req.body || {};
        const { answers, questionNumbers: reqQuestionNumbers } = body;
        const studentEmail = typeof body.studentEmail === 'string' ? body.studentEmail.trim().toLowerCase() : '';
        const examKey = typeof body.examKey === 'string' ? body.examKey.trim() : '';
        if (!studentEmail) return res.status(400).json({ error: 'Selecione o aluno.' });
        if (!examKey) return res.status(400).json({ error: 'Selecione a prova.' });
        const type = isEmptyInput(body.type) ? 'impressa' : body.type;
        if (!MANUAL_TYPES.includes(type)) return res.status(400).json({ error: 'Tipo de lançamento inválido. Use impressa, manual ou online.' });
        if (body.score !== undefined && body.grade === undefined) {
            return res.status(400).json({ error: 'A nota agora é informada de 0 a 10 no campo "grade". Atualize a página e lance de novo.' });
        }

        const students = readJSON(DB_STUDENTS_FILE);
        const registeredStudent = students.find(s => s.email && s.email.toLowerCase() === studentEmail);
        if (!registeredStudent) {
            return res.status(404).json({ error: 'Estudante não encontrado no cadastro.' });
        }
        if (!adminCanAccessStudent(matchedAdmin, registeredStudent)) {
            return res.status(403).json({ error: 'Aluno fora do seu escopo.' });
        }

        // Turma/curso: os do workspace quando enviados (aluno em mais de uma turma),
        // senão a primeira matrícula do aluno.
        const requestedClass = typeof body.studentClass === 'string' ? body.studentClass.trim() : '';
        const requestedCourse = typeof body.courseId === 'string' ? body.courseId.trim() : '';
        const memberships = (Array.isArray(registeredStudent.classes) && registeredStudent.classes.length
            ? registeredStudent.classes
            : (registeredStudent.studentClass ? [registeredStudent.studentClass] : []))
            .map(item => typeof item === 'string'
                ? { name: item, courseId: String(registeredStudent.courseId || '') }
                : { name: String(item?.name || item?.className || ''), courseId: String(item?.courseId || registeredStudent.courseId || '') })
            .filter(item => item.name);
        let membership;
        if (requestedClass || requestedCourse) {
            membership = memberships.find(item => (!requestedClass || item.name === requestedClass)
                && (!requestedCourse || !item.courseId || item.courseId === requestedCourse));
            if (!membership) return res.status(400).json({ error: 'O aluno não está matriculado nesta turma.' });
        } else {
            membership = memberships[0] || { name: '', courseId: '' };
        }
        const studentClass = membership.name || '';
        const studentCourseId = membership.courseId || requestedCourse || registeredStudent.courseId || null;

        // Busca informações sobre a avaliação para correção ou contagem
        const questions = loadManualExamQuestions(examKey);
        if (questions.length === 0) {
            return res.status(400).json({ error: 'Avaliação não encontrada ou sem questões cadastradas.' });
        }
        const questionByNumber = new Map(questions.map(question => [question.originalNumber, question]));

        // Verifica configurações da prova para a turma
        const classes = readJSON(DB_CLASSES_FILE);
        const cls = findClassByNameAndCourse(classes, studentClass, studentCourseId) || classes.find(c => c.name === studentClass);
        if (cls) {
            const course = getCourseForClass(cls);
            const structure = effectiveStructure(course?.id || cls.courseId, cls.name)?.structure || course?.structure || [];
            const courseHasExams = structure.some(mod => (mod.units || mod.items || []).some(unit => unit.avaliacaoKey));
            if (courseHasExams && !isCourseExamKey(cls, examKey)) {
                return res.status(400).json({ error: 'Esta prova não faz parte do curso da turma do aluno.' });
            }
        }
        const { availableQuestions, defaultTotal: totalCount } = manualExamTotals(cls, examKey, questions);

        let finalScore = 0;
        let ignoredQuestionNumbers = [];
        let finalCorrectCount = null;
        let finalTotalCount = null;
        let gradedAnswers = [];
        let entryMode = 'quick';

        if (answers !== undefined && answers !== null && (typeof answers !== 'object' || Array.isArray(answers))) {
            return res.status(400).json({ error: 'Respostas do cartão em formato inválido.' });
        }
        const answeredEntries = answers ? Object.entries(answers).filter(([, letter]) => !isEmptyInput(letter)) : [];
        if (body.mode === 'card' && answeredEntries.length === 0) {
            return res.status(400).json({ error: 'Marque ao menos uma resposta no cartão.' });
        }

        if (answeredEntries.length > 0) {
            // Correção baseada no cartão-resposta (respostas fornecidas)
            entryMode = 'card';
            if (reqQuestionNumbers !== undefined && reqQuestionNumbers !== null && !Array.isArray(reqQuestionNumbers)) {
                return res.status(400).json({ error: 'Lista de questões da versão em formato inválido.' });
            }
            const providedNumbers = Array.isArray(reqQuestionNumbers)
                ? [...new Set(reqQuestionNumbers.map(Number))]
                : [];
            if (providedNumbers.some(number => !Number.isInteger(number) || number < 1)) {
                return res.status(400).json({ error: 'Lista de questões da versão em formato inválido.' });
            }
            // Versão impressa (histórico) com questão que saiu do banco depois da
            // impressão: sem gabarito, ela fica fora da nota (como antes) e o
            // professor é avisado na resposta, em vez de o lançamento falhar.
            const missingFromBank = new Set(providedNumbers.filter(number => !questionByNumber.has(number)));
            ignoredQuestionNumbers = [...missingFromBank].sort((a, b) => a - b);
            const normalizedAnswers = {};
            for (const [rawNumber, letter] of answeredEntries) {
                const number = Number(rawNumber);
                if (missingFromBank.has(number)) continue;
                if (!Number.isInteger(number) || !questionByNumber.has(number)) {
                    return res.status(400).json({ error: `A questão ${rawNumber} não existe nesta prova.` });
                }
                if (typeof letter !== 'string' || !/^[A-Za-z]$/.test(letter.trim())) {
                    return res.status(400).json({ error: `Resposta inválida na questão ${number}. Use uma letra (A, B, C...).` });
                }
                normalizedAnswers[number] = letter.trim().toUpperCase();
            }
            if (Object.keys(normalizedAnswers).length === 0) {
                return res.status(400).json({ error: 'Marque ao menos uma resposta em questão que ainda existe nesta prova.' });
            }

            let selectedQuestions;
            if (providedNumbers.length > 0) {
                // O frontend informou exatamente quais questões compuseram a prova aplicada
                // (versão impressa do histórico) — a nota é calculada sobre esse conjunto,
                // mesmo que a configuração atual da turma tenha mudado desde a impressão.
                const outside = Object.keys(normalizedAnswers).map(Number).find(number => !providedNumbers.includes(number));
                if (outside !== undefined) {
                    return res.status(400).json({ error: `A questão ${outside} não faz parte da versão informada.` });
                }
                selectedQuestions = questions.filter(q => providedNumbers.includes(Number(q.originalNumber)));
            } else {
                const submittedNumbers = Object.keys(normalizedAnswers).map(Number);
                selectedQuestions = availableQuestions.filter(q => submittedNumbers.includes(q.originalNumber));

                // Preenche com o restante das questões disponíveis caso não chegue no total esperado
                availableQuestions.forEach(q => {
                    if (selectedQuestions.length >= totalCount) return;
                    if (!selectedQuestions.some(selected => selected.originalNumber === q.originalNumber)) {
                        selectedQuestions.push(q);
                    }
                });
            }
            finalTotalCount = selectedQuestions.length;
            finalCorrectCount = 0;

            selectedQuestions.forEach(q => {
                const correctAnswer = correctAnswerFor(q);
                const studentChoice = normalizedAnswers[q.originalNumber] || null;
                const isCorrect = !!correctAnswer && studentChoice === correctAnswer;
                if (isCorrect) {
                    finalCorrectCount++;
                }
                gradedAnswers.push({
                    questionNumber: q.originalNumber,
                    studentChoice,
                    correctAnswer,
                    isCorrect
                });
            });

            finalScore = scoreFromCounts(finalCorrectCount, finalTotalCount);
        } else {
            // Lançamento rápido: nota (0 a 10) e/ou acertos e total.
            const gradeInput = parseGradeInput(body.grade);
            if (gradeInput.error) return res.status(400).json({ error: gradeInput.error });
            const correctInput = parseCountInput(body.correctCount);
            if (correctInput.error) return res.status(400).json({ error: 'Acertos deve ser um número inteiro, de 0 até o total de questões.' });
            const totalInput = parseCountInput(body.totalCount);
            if (totalInput.error || totalInput.value === 0) return res.status(400).json({ error: 'O total de questões deve ser um número inteiro maior que zero.' });
            if (!totalInput.empty && totalInput.value > questions.length) {
                return res.status(400).json({ error: `O total não pode passar de ${questions.length} questões, que é o tamanho desta prova.` });
            }
            if (gradeInput.empty && correctInput.empty) {
                return res.status(400).json({ error: 'Informe a nota (0 a 10) ou os acertos.' });
            }
            const effectiveTotal = totalInput.empty ? totalCount : totalInput.value;
            if (!correctInput.empty && correctInput.value > effectiveTotal) {
                return res.status(400).json({ error: `Os acertos (${correctInput.value}) não podem passar do total de questões (${effectiveTotal}).` });
            }
            // Nota e acertos juntos precisam conferir (ex.: 10 com 0 de 4 acertos é erro de digitação).
            const mismatch = gradeCountsMismatch(gradeInput.empty ? null : gradeInput.value, correctInput.empty ? null : correctInput.value, effectiveTotal);
            if (mismatch) return res.status(400).json({ error: mismatch });
            finalScore = gradeInput.empty
                ? scoreFromCounts(correctInput.value, effectiveTotal)
                : scoreFromGrade(gradeInput.value);
            // Sem acertos informados, não inventa acertos a partir da nota.
            finalCorrectCount = correctInput.empty ? null : correctInput.value;
            finalTotalCount = correctInput.empty && totalInput.empty ? null : effectiveTotal;
            gradedAnswers = [];
        }

        const normalizedStudent = {
            name: registeredStudent.name,
            email: studentEmail,
            studentClass: studentClass,
            courseId: studentCourseId
        };

        const submissions = readJSON(DB_SUBMISSIONS_FILE);
        const previousAttempts = submissions.filter(item =>
            item.student?.email?.toLowerCase() === studentEmail &&
            item.examKey === examKey &&
            (!item.student?.courseId || !studentCourseId || String(item.student.courseId) === String(studentCourseId))
        );
        const previousPolicy = [...previousAttempts].reverse().find(item => item.aggregationPolicy)?.aggregationPolicy || 'highest';

        const submissionObj = {
            id: 'sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9),
            student: normalizedStudent,
            examKey,
            score: finalScore,
            correctCount: finalCorrectCount,
            totalCount: finalTotalCount,
            gradedAnswers,
            type,
            entryMode,
            launchedBy: matchedAdmin?.email || 'admin',
            ...(ignoredQuestionNumbers.length ? { ignoredQuestionNumbers } : {}),
            // Maior número + 1 (contar as tentativas repetia o número depois de uma exclusão).
            attemptNumber: Math.max(previousAttempts.length, ...previousAttempts.map(item => Number(item.attemptNumber) || 0)) + 1,
            resultStatus: 'considered',
            aggregationPolicy: previousPolicy,
            selectedForResult: false,
            gradePublished: false,
            timestamp: new Date().toISOString()
        };

        submissions.push(submissionObj);
        const ignoredNote = ignoredQuestionNumbers.length
            ? `${ignoredQuestionNumbers.length === 1 ? 'a questão' : 'as questões'} ${ignoredQuestionNumbers.join(', ')} da versão impressa não ${ignoredQuestionNumbers.length === 1 ? 'existe' : 'existem'} mais na prova e ${ignoredQuestionNumbers.length === 1 ? 'ficou' : 'ficaram'} fora da nota`
            : '';
        recordGradeAudit(db.memory, {
            req,
            actor: matchedAdmin,
            submission: submissionObj,
            action: 'grade_create',
            field: 'Nota',
            oldValue: '',
            newValue: `${describeSubmissionGrade(submissionObj, examTitle(examKey, { evaluations: db.memory.evaluations }))} · lançamento ${entryMode === 'card' ? 'pelo cartão-resposta' : 'manual'} (${type})${ignoredNote ? ` · ${ignoredNote}` : ''}`,
        });
        writeJSON(DB_SUBMISSIONS_FILE, submissions);

        res.json({
            success: true,
            message: `Nota ${formatGradeBR(finalScore)} lançada para ${registeredStudent.name || studentEmail}.${ignoredNote ? ` Atenção: ${ignoredNote}.` : ''}`,
            submissionId: submissionObj.id,
            score: finalScore,
            grade: gradeFromScore(finalScore),
            correctCount: finalCorrectCount,
            totalCount: finalTotalCount,
            ignoredQuestionNumbers,
        });
    });
});

// Obter alunos cadastrados e online
router.get('/api/admin/students', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const students = readJSON(DB_STUDENTS_FILE);
        const now = Date.now();
        const enrichedStudents = students.map(s => {
            // As sessões são objetos { lastSeen, ip, token }. Também damos suporte ao
            // formato legado (timestamp puro). A chave é sempre o e-mail em minúsculas.
            const session = s.email ? db.memory.sessions[s.email.toLowerCase()] : null;
            const lastSeen = sessionLastSeen(session);
            const isOnline = isStudentSessionOnline(session, now);
            const { password, ...safeStudent } = s;
            return { ...redactSensitiveStudentData(safeStudent, matchedAdmin), isOnline, lastSeenAt: lastSeen || null };
        });
        const courseId = String(req.query.courseId || '').trim();
        const studentClass = String(req.query.studentClass || '').trim();
        res.json(filterStudentsForAdmin(enrichedStudents, matchedAdmin).filter(student => (
            (!courseId && !studentClass) || studentBelongsToClass(student, studentClass, courseId)
        )));
    });
});

// Criação manual de aluno pelo instrutor
router.post('/api/admin/student/create', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const { studentPassword, studentClass, classes } = req.body;

        // Suporte retroativo ou novo array. Turmas em objeto viram { name, courseId, period }
        // e `studentClass` guarda só o nome (DES-03).
        let studentClasses = normalizeClassEntriesForStorage(Array.isArray(classes) ? classes : (studentClass ? [studentClass] : []));

        const fields = extractStudentFields(req.body);

        if (!fields.name || !fields.email || !studentPassword || studentClasses.length === 0) {
            return res.status(400).json({ error: 'Dados incompletos. Informe nome, e-mail, senha e ao menos uma turma.' });
        }

        const allClasses = db.memory.classes;
        const requestedCourseId = String(req.body.courseId || '').trim();

        // Valida se as turmas existem (no curso informado, quando houver: o nome pode repetir entre cursos)
        for (let c of studentClasses) {
            const className = typeof c === 'string' ? c : (c && (c.name || c.className));
            const classCourse = (c && typeof c === 'object' && c.courseId) || requestedCourseId;
            const matchedClass = allClasses.find(cls => cls.name === className && (!classCourse || String(cls.courseId) === String(classCourse)));
            if (!matchedClass) {
                return res.status(400).json({ error: `A turma ${className} não está pré-cadastrada no sistema.` });
            }
        }

        const students = db.memory.students;

        // Validações de campos (e-mail válido/único, matrícula única, telefones, status)
        const validation = validateStudentFields(fields, students, null);
        if (!validation.ok) {
            return res.status(400).json({ error: validation.error });
        }

        const newStudent = {
            name: fields.name,
            nomeSocial: fields.nomeSocial || '',
            email: fields.email,
            matricula: fields.matricula || '',
            phone: fields.phone || '',
            guardianPhone: fields.guardianPhone || '',
            unidade: fields.unidade || '',
            status: fields.status || DEFAULT_STATUS, // Padrão: Ativo
            guardian: fields.guardian || null,
            // Dados de acessibilidade/saúde: só o administrador grava (SEG-04).
            accessibility: isProfessorAccount(matchedAdmin) ? null : (fields.accessibility || null),
            password: db.hashPassword(String(studentPassword).trim()),
            classes: studentClasses,
            studentClass: classEntryName(studentClasses[0]), // Compatibilidade com submissões legadas (sempre o nome)
            period: fields.period || 'Tarde',
            loginTime: null,
            recoveryRequested: false,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        students.push(newStudent);

        recordStudentAudit(db.memory, {
            actor: (matchedAdmin && matchedAdmin.email) || 'admin',
            studentEmail: newStudent.email,
            action: 'create',
            changes: [{ field: 'Cadastro', oldValue: '', newValue: 'Aluno criado' }],
            req
        });

        db.save();
        res.json({ success: true });
    });
});

// Atualização de cadastro de aluno pelo instrutor
router.post('/api/admin/student/update', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const { originalEmail, password, studentClass, classes } = req.body;

        let studentClasses = normalizeClassEntriesForStorage(Array.isArray(classes) ? classes : (studentClass ? [studentClass] : []));
        const fields = extractStudentFields(req.body);

        if (!originalEmail || !fields.name || !fields.email || studentClasses.length === 0) {
            return res.status(400).json({ error: 'Dados incompletos. Informe nome, e-mail e ao menos uma turma.' });
        }

        const students = db.memory.students;
        const originalEmailNorm = originalEmail.trim().toLowerCase();
        const studentIndex = students.findIndex(s => s.email && s.email.toLowerCase() === originalEmailNorm);

        if (studentIndex === -1) {
            return res.status(404).json({ error: 'Estudante não encontrado.' });
        }

        // Validações (e-mail válido/único, matrícula única, telefones, status) ignorando o próprio.
        const validation = validateStudentFields({ ...fields, classes: studentClasses }, students, originalEmailNorm);
        if (!validation.ok) {
            return res.status(400).json({ error: validation.error });
        }

        const before = students[studentIndex];
        const newEmailNormalized = fields.email;
        // Dados de acessibilidade/saúde: o professor recebe a observação ocultada e não
        // altera esse bloco; o que está gravado continua como está (SEG-04).
        if (isProfessorAccount(matchedAdmin)) delete fields.accessibility;

        // Auditoria: calcula o que mudou ANTES de aplicar.
        const changes = diffStudentForAudit(before, { ...fields, classes: studentClasses });

        students[studentIndex] = {
            ...before,
            name: fields.name,
            nomeSocial: fields.nomeSocial !== undefined ? fields.nomeSocial : (before.nomeSocial || ''),
            email: newEmailNormalized,
            matricula: fields.matricula !== undefined ? fields.matricula : (before.matricula || ''),
            phone: fields.phone !== undefined ? fields.phone : (before.phone || ''),
            guardianPhone: fields.guardianPhone !== undefined ? fields.guardianPhone : (before.guardianPhone || ''),
            unidade: fields.unidade !== undefined ? fields.unidade : (before.unidade || ''),
            status: fields.status || before.status || DEFAULT_STATUS,
            guardian: fields.guardian !== undefined ? fields.guardian : (before.guardian || null),
            accessibility: fields.accessibility !== undefined ? fields.accessibility : (before.accessibility || null),
            password: password
                ? (db.isHashed(password) ? password : db.hashPassword(String(password).trim()))
                : before.password,
            classes: studentClasses,
            studentClass: classEntryName(studentClasses[0]), // Compatibilidade (sempre o nome)
            period: fields.period || before.period,
            updatedAt: Date.now()
        };

        if (changes.length) {
            recordStudentAudit(db.memory, {
                actor: (matchedAdmin && matchedAdmin.email) || 'admin',
                studentEmail: newEmailNormalized,
                action: 'update',
                changes,
                req
            });
        }

        db.save();

        // Cascata nas submissões de notas antigas
        const submissions = db.memory.submissions;
        let submissionsUpdated = false;
        submissions.forEach(sub => {
            if (sub.student && sub.student.email && sub.student.email.toLowerCase() === originalEmailNorm) {
                sub.student.email = newEmailNormalized;
                sub.student.name = fields.name;
                sub.student.studentClass = classEntryName(studentClasses[0]); // Manter primeira turma na submissão antiga
                if (fields.period) sub.student.period = fields.period;
                submissionsUpdated = true;
            }
        });
        if (submissionsUpdated) {
            db.save();
        }
        // As demais coleções (progresso, caderno, presença, acessos, observações...) são
        // indexadas pelo e-mail; sem esta cascata o aluno "perdia" tudo ao trocar o login.
        if (newEmailNormalized !== originalEmailNorm) {
            renameStudentEmailEverywhere(originalEmailNorm, newEmailNormalized);
            db.save();
        }

        res.json({ success: true });
    });
});

// Propaga a troca de e-mail do aluno para todas as coleções indexadas por e-mail.
function renameStudentEmailEverywhere(oldEmail, newEmail) {
    const same = value => String(value || '').toLowerCase() === oldEmail;
    const memory = db.memory;
    ['progress', 'notes', 'annotations'].forEach(collection => {
        const map = memory[collection];
        if (map && Object.prototype.hasOwnProperty.call(map, oldEmail)) {
            map[newEmail] = map[oldEmail];
            delete map[oldEmail];
        }
    });
    if (memory.sessions) delete memory.sessions[oldEmail];
    ['attendance', 'moduleAccess', 'pedagogicalObservations', 'certificates', 'proctoringLogs', 'examKeystrokes', 'forum', 'auditLogs']
        .forEach(collection => (memory[collection] || []).forEach(item => { if (item && same(item.studentEmail)) item.studentEmail = newEmail; }));
    // Notas na lixeira: a cópia guardada na auditoria acompanha o novo e-mail, senão a
    // nota excluída aparece como "aluno fora do cadastro" e não pode ser restaurada.
    (memory.auditLogs || []).forEach(item => {
        const copy = item && item.details && item.details.deletedSubmission;
        if (copy && copy.student && same(copy.student.email)) copy.student.email = newEmail;
    });
    (memory.broadcastMessages || []).forEach(message => {
        if (!message) return;
        if (same(message.targetEmail)) message.targetEmail = newEmail;
        ['acknowledgedBy', 'deletedFor'].forEach(field => {
            if (Array.isArray(message[field])) message[field] = message[field].map(value => same(value) ? newEmail : value);
        });
    });
    (memory.announcements || []).forEach(item => {
        if (!item) return;
        if (item.target === 'aluno' && same(item.targetValue)) item.targetValue = newEmail;
        if (Array.isArray(item.readBy)) item.readBy = item.readBy.map(value => same(value) ? newEmail : value);
    });
    (memory.classes || []).forEach(cls => {
        if (cls && cls.studentReleasedItems && cls.studentReleasedItems[oldEmail]) {
            cls.studentReleasedItems[newEmail] = cls.studentReleasedItems[oldEmail];
            delete cls.studentReleasedItems[oldEmail];
        }
    });
    const examState = memory.studentExamState || {};
    Object.keys(examState).forEach(key => {
        const state = examState[key];
        if (!state || !same(state.studentEmail)) return;
        state.studentEmail = newEmail;
        const renamedKey = key.includes('::') ? key.replace(`::${oldEmail}::`, `::${newEmail}::`) : key.replace(`${oldEmail}_`, `${newEmail}_`);
        if (renamedKey !== key) { examState[renamedKey] = state; delete examState[key]; }
    });
    (memory.examApplications || []).forEach(application => {
        ['studentAdjustments', 'studentVersions'].forEach(field => {
            const map = application && application[field];
            if (map && Object.prototype.hasOwnProperty.call(map, oldEmail)) { map[newEmail] = map[oldEmail]; delete map[oldEmail]; }
        });
    });
}

// ---- Ações em lote (tela de Alunos) ----
// A lista de e-mails vem do cliente, então o escopo do professor é reaplicado aqui:
// nunca confiar na seleção recebida. Alunos fora do escopo viram 'skipped', não erro.
function resolveBulkTargets(emails, matchedAdmin) {
    const wanted = [...new Set((Array.isArray(emails) ? emails : [])
        .map(e => String(e || '').trim().toLowerCase())
        .filter(Boolean))];
    const students = db.memory.students;
    const allowed = new Set(filterStudentsForAdmin(students, matchedAdmin)
        .map(s => (s.email || '').toLowerCase()));
    const targets = [];
    const skipped = [];
    wanted.forEach(email => {
        const index = students.findIndex(s => s.email && s.email.toLowerCase() === email);
        if (index === -1) skipped.push({ email, reason: 'Aluno não encontrado.' });
        else if (!allowed.has(email)) skipped.push({ email, reason: 'Fora do seu escopo.' });
        else targets.push(index);
    });
    return { targets, skipped };
}

// Matricula vários alunos de uma vez numa turma (adiciona, não substitui as demais).
router.post('/api/admin/student/bulk-enroll', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const { emails, className } = req.body;
        const name = String(className || '').trim();
        const requestedCourseId = String(req.body.courseId || '').trim();
        if (!name) return res.status(400).json({ error: 'Informe a turma.' });

        // O nome da turma pode repetir entre cursos: com o curso informado, a busca é exata.
        const sameName = (db.memory.classes || []).filter(c => c.name === name && (!requestedCourseId || String(c.courseId) === requestedCourseId));
        if (!sameName.length) return res.status(404).json({ error: 'Turma não encontrada.' });
        if (sameName.length > 1) return res.status(400).json({ error: 'Há mais de uma turma com esse nome. Informe o curso.' });
        const cls = sameName[0];
        if (!adminCanAccessClass(matchedAdmin, cls.name, cls.courseId)) {
            return res.status(403).json({ error: 'Turma fora do seu escopo.' });
        }

        const { targets, skipped } = resolveBulkTargets(emails, matchedAdmin);
        if (!targets.length && !skipped.length) {
            return res.status(400).json({ error: 'Selecione ao menos um aluno.' });
        }

        const students = db.memory.students;
        let updated = 0;
        targets.forEach(index => {
            const before = students[index];
            const current = Array.isArray(before.classes) && before.classes.length
                ? before.classes
                : (before.studentClass ? [before.studentClass] : []);
            if (studentInClass(before, cls.name, cls.courseId)) {
                skipped.push({ email: before.email, reason: 'Já matriculado nesta turma.' });
                return;
            }
            // Mesmo formato da aprovação de matrícula; `studentClass` continua sendo o nome
            // da turma principal (antes copiava o objeto e derrubava o Monitor — DES-03).
            const nextClasses = [...normalizeClassEntriesForStorage(current), { name: cls.name, courseId: cls.courseId, period: cls.period || '' }];
            const changes = diffStudentForAudit(before, { classes: nextClasses });
            const primaryName = classEntryName(before.studentClass) || classEntryName(nextClasses[0]);
            students[index] = {
                ...before,
                classes: nextClasses,
                studentClass: primaryName, // Compatibilidade (sempre o nome)
                period: before.period || (primaryName === cls.name ? cls.period || '' : ''),
                updatedAt: Date.now(),
            };
            if (changes.length) {
                recordStudentAudit(db.memory, {
                    actor: (matchedAdmin && matchedAdmin.email) || 'admin',
                    studentEmail: before.email,
                    action: 'bulk_enroll',
                    changes,
                    req,
                });
            }
            updated++;
        });

        if (updated) db.save();
        res.json({ success: true, updated, skipped });
    });
});

// Altera a situação (Ativo, Inativo, ...) de vários alunos de uma vez.
router.post('/api/admin/student/bulk-status', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const { emails, status } = req.body;
        const nextStatus = String(status || '').trim();
        if (!STUDENT_STATUSES.includes(nextStatus)) {
            return res.status(400).json({ error: `Situação inválida. Use uma de: ${STUDENT_STATUSES.join(', ')}.` });
        }

        const { targets, skipped } = resolveBulkTargets(emails, matchedAdmin);
        if (!targets.length && !skipped.length) {
            return res.status(400).json({ error: 'Selecione ao menos um aluno.' });
        }

        const students = db.memory.students;
        let updated = 0;
        targets.forEach(index => {
            const before = students[index];
            if ((before.status || DEFAULT_STATUS) === nextStatus) {
                skipped.push({ email: before.email, reason: 'Já está nesta situação.' });
                return;
            }
            const changes = diffStudentForAudit(before, { status: nextStatus });
            students[index] = { ...before, status: nextStatus, updatedAt: Date.now() };
            if (changes.length) {
                recordStudentAudit(db.memory, {
                    actor: (matchedAdmin && matchedAdmin.email) || 'admin',
                    studentEmail: before.email,
                    action: 'bulk_status',
                    changes,
                    req,
                });
            }
            updated++;
        });

        if (updated) db.save();
        res.json({ success: true, updated, skipped });
    });
});

// Histórico de auditoria de um aluno (alterações no perfil) — somente admin.
router.get('/api/admin/student/audit', (req, res) => {
    validateAdmin(req, res, () => {
        const email = (req.query.email || '').trim().toLowerCase();
        if (!email) return res.status(400).json({ error: 'E-mail do aluno é obrigatório.' });
        const logs = (db.memory.auditLogs || [])
            .filter(l => l.studentEmail === email)
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        res.json(logs);
    });
});

// Logs de login de um aluno (segurança) — somente admin.
router.get('/api/admin/student/login-logs', (req, res) => {
    validateAdmin(req, res, () => {
        const email = (req.query.email || '').trim().toLowerCase();
        if (!email) return res.status(400).json({ error: 'E-mail do aluno é obrigatório.' });
        const logs = (db.memory.loginLogs || [])
            .filter(l => l.email === email)
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
            .slice(0, 100);
        res.json(logs);
    });
});

// ---- Observações pedagógicas controladas (Fase 3) ----
// SEG-04: "Restrita (coordenação)" e a categoria "Acessibilidade pedagógica" (dado de
// saúde) só aparecem para o administrador e para quem escreveu. Editar e excluir:
// administrador ou o próprio autor. O escopo de turma do professor vem do RBAC.
const RESTRICTED_OBSERVATION_VISIBILITY = 'Restrita (coordenação)';
const SENSITIVE_OBSERVATION_CATEGORIES = new Set(['Acessibilidade pedagógica']);

function isRestrictedObservation(obs) {
    return !!obs && (obs.visibility === RESTRICTED_OBSERVATION_VISIBILITY || SENSITIVE_OBSERVATION_CATEGORIES.has(obs.category));
}

function isObservationAuthor(account, obs) {
    const email = String((account && account.email) || '').trim().toLowerCase();
    return !!email && String((obs && obs.author) || '').trim().toLowerCase() === email;
}

function canSeeObservation(account, obs) {
    return !isProfessorAccount(account) || !isRestrictedObservation(obs) || isObservationAuthor(account, obs);
}

function canChangeObservation(account, obs) {
    return !isProfessorAccount(account) || isObservationAuthor(account, obs);
}

// Professor vê o necessário para a acomodação (tempo extra e recursos), sem o texto
// de acessibilidade, que pode trazer laudo ou diagnóstico (SEG-04).
function redactSensitiveStudentData(student, account) {
    if (!isProfessorAccount(account) || !student || !student.accessibility || typeof student.accessibility !== 'object') return student;
    const { observacao, ...accommodation } = student.accessibility;
    return {
        ...student,
        accessibility: { ...accommodation, observacao: '' },
        accessibilityNoteRestricted: !!String(observacao || '').trim(),
    };
}

router.get('/api/admin/student/observations', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const email = (req.query.email || '').trim().toLowerCase();
        if (!email) return res.status(400).json({ error: 'E-mail do aluno é obrigatório.' });
        const list = (db.memory.pedagogicalObservations || [])
            .filter(o => o.studentEmail === email && canSeeObservation(matchedAdmin, o))
            .map(o => ({ ...o, restricted: isRestrictedObservation(o), canEdit: canChangeObservation(matchedAdmin, o) }))
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        res.json(list);
    });
});

router.post('/api/admin/student/observations/create', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const email = (req.body.email || '').trim().toLowerCase();
        const category = (req.body.category || '').trim();
        const text = (req.body.text || '').trim();
        const visibility = (req.body.visibility || '').trim();
        if (!email || !text) return res.status(400).json({ error: 'Aluno e texto da observação são obrigatórios.' });
        if (category && !OBSERVATION_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Categoria inválida.' });
        if (visibility && !OBSERVATION_VISIBILITY.includes(visibility)) return res.status(400).json({ error: 'Visibilidade inválida.' });
        if (!Array.isArray(db.memory.pedagogicalObservations)) db.memory.pedagogicalObservations = [];
        const finalCategory = category || 'Observação geral';
        const obs = {
            id: 'obs_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            studentEmail: email,
            author: (matchedAdmin && matchedAdmin.email) || 'admin',
            category: finalCategory,
            // Dado de saúde nasce restrito à coordenação.
            visibility: SENSITIVE_OBSERVATION_CATEGORIES.has(finalCategory) ? RESTRICTED_OBSERVATION_VISIBILITY : (visibility || 'Equipe pedagógica'),
            text,
            timestamp: Date.now(),
            updatedAt: Date.now(),
        };
        db.memory.pedagogicalObservations.push(obs);
        recordStudentAudit(db.memory, { actor: obs.author, studentEmail: email, action: 'observation_create', changes: [{ field: 'Observação pedagógica', oldValue: '', newValue: obs.category }], req });
        db.save();
        res.json({ success: true, observation: obs });
    });
});

router.post('/api/admin/student/observations/update', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const { id } = req.body;
        const list = db.memory.pedagogicalObservations || [];
        const obs = list.find(o => o.id === id);
        if (!obs || !canSeeObservation(matchedAdmin, obs)) return res.status(404).json({ error: 'Observação não encontrada.' });
        if (!canChangeObservation(matchedAdmin, obs)) return res.status(403).json({ error: 'Só o autor ou o administrador pode editar esta observação.' });
        if (req.body.category !== undefined) {
            const category = String(req.body.category).trim();
            if (category && !OBSERVATION_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Categoria inválida.' });
            obs.category = category || obs.category;
        }
        if (req.body.visibility !== undefined) {
            const visibility = String(req.body.visibility).trim();
            if (visibility && !OBSERVATION_VISIBILITY.includes(visibility)) return res.status(400).json({ error: 'Visibilidade inválida.' });
            obs.visibility = visibility || obs.visibility;
        }
        if (SENSITIVE_OBSERVATION_CATEGORIES.has(obs.category)) obs.visibility = RESTRICTED_OBSERVATION_VISIBILITY;
        if (req.body.text !== undefined) obs.text = String(req.body.text).trim();
        obs.updatedAt = Date.now();
        recordStudentAudit(db.memory, { actor: (matchedAdmin && matchedAdmin.email) || 'admin', studentEmail: obs.studentEmail, action: 'observation_update', changes: [{ field: 'Observação pedagógica', oldValue: '', newValue: 'editada' }], req });
        db.save();
        res.json({ success: true, observation: obs });
    });
});

router.post('/api/admin/student/observations/delete', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const { id } = req.body;
        const list = db.memory.pedagogicalObservations || [];
        const obs = list.find(o => o.id === id);
        if (!obs || !canSeeObservation(matchedAdmin, obs)) return res.status(404).json({ error: 'Observação não encontrada.' });
        if (!canChangeObservation(matchedAdmin, obs)) return res.status(403).json({ error: 'Só o autor ou o administrador pode excluir esta observação.' });
        db.memory.pedagogicalObservations = list.filter(o => o.id !== id);
        recordStudentAudit(db.memory, { actor: (matchedAdmin && matchedAdmin.email) || 'admin', studentEmail: obs.studentEmail, action: 'observation_delete', changes: [{ field: 'Observação pedagógica', oldValue: obs.category, newValue: 'excluída' }], req });
        db.save();
        res.json({ success: true });
    });
});

// Presença de um mês específico (para o calendário navegável). Somente admin.
router.get('/api/admin/student/attendance', (req, res) => {
    validateAdmin(req, res, () => {
        const email = (req.query.email || '').trim().toLowerCase();
        if (!email) return res.status(400).json({ error: 'E-mail do aluno é obrigatório.' });
        const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : null; // YYYY-MM
        let list = (db.memory.attendance || []).filter(a => a.studentEmail === email);
        if (month) list = list.filter(a => (a.date || '').slice(0, 7) === month);
        const days = {};
        list.forEach(a => { if (a.date) days[a.date] = a.origin || 'login'; });
        res.json({ month, days });
    });
});

// Histórico acadêmico consolidado (Fase 4) — provas/notas + progresso. Somente admin.
router.get('/api/admin/student/academic', (req, res) => {
    validateAdmin(req, res, () => {
        const email = (req.query.email || '').trim().toLowerCase();
        if (!email) return res.status(400).json({ error: 'E-mail do aluno é obrigatório.' });
        const submissions = (db.memory.submissions || [])
            .filter(s => s.student && s.student.email && s.student.email.toLowerCase() === email)
            // Nota inválida de registro antigo (vazia ou fora de 0 a 10) vai como null + aviso.
            .map(s => ({ id: s.id, examKey: s.examKey, score: normalizeScore(s.score), scoreInvalid: normalizeScore(s.score) === null, correctCount: s.correctCount, totalCount: s.totalCount, assignedVersion: s.assignedVersion, gradePublished: s.gradePublished === true, timestamp: s.timestamp }))
            .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
        const progressMap = (db.memory.progress && db.memory.progress[email]) || {};
        const completedUnits = Object.keys(progressMap).filter(k => progressMap[k]);
        const attendance = (db.memory.attendance || []).filter(a => a.studentEmail === email).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        const certificates = (db.memory.certificates || []).filter(c => c.studentEmail === email).sort((a, b) => (b.issuedAt || 0) - (a.issuedAt || 0));
        const moduleAccess = (db.memory.moduleAccess || []).filter(m => m.studentEmail === email).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 50);
        res.json({
            submissions,
            progress: { completedCount: completedUnits.length, completedUnits },
            attendance: { count: attendance.length, recent: attendance.slice(0, 30) },
            certificates,
            moduleAccess
        });
    });
});

// Boletim consolidado do aluno (provas por módulo + frequência por disciplina),
// pronto para o frontend imprimir/salvar em PDF. Só notas publicadas entram na média.
// As notas usam a mesma consolidação da tela Resultados: cada aplicação da prova é
// um grupo com a regra escolhida pelo professor, e a média é a dos grupos (UXI-X1, FUN-X1).
router.get('/api/admin/student/report', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const email = String(req.query.email || '').trim().toLowerCase();
        if (!email) return res.status(400).json({ error: 'E-mail do aluno é obrigatório.' });
        const student = (db.memory.students || []).find(s => s.email && s.email.toLowerCase() === email);
        if (!student) return res.status(404).json({ error: 'Aluno não encontrado.' });
        if (!adminCanAccessStudent(matchedAdmin, student)) return res.status(403).json({ error: 'Aluno fora do seu escopo.' });

        const requestedCourseId = String(req.query.courseId || '').trim();
        const requestedClass = String(req.query.studentClass || '').trim();
        const memberships = (Array.isArray(student.classes) && student.classes.length ? student.classes : (student.studentClass ? [student.studentClass] : []))
            .map(item => typeof item === 'string'
                ? { name: item, courseId: String(student.courseId || '') }
                : { name: item?.name || item?.className || '', courseId: String(item?.courseId || student.courseId || '') })
            .filter(item => item.name);
        const inCourse = item => !requestedCourseId || !item.courseId || item.courseId === requestedCourseId;
        let membership;
        if (requestedCourseId || requestedClass) {
            membership = memberships.find(item => inCourse(item) && (!requestedClass || item.name === requestedClass))
                || memberships.find(inCourse);
            if (!membership) return res.status(400).json({ error: 'O aluno não tem matrícula no curso selecionado.' });
        } else {
            membership = memberships[0] || { name: student.studentClass || '', courseId: '' };
        }
        const cls = findClassByNameAndCourse(db.memory.classes || [], membership.name, membership.courseId || requestedCourseId)
            || (db.memory.classes || []).find(c => c.name === membership.name) || null;
        const courseId = String((cls && cls.courseId) || membership.courseId || requestedCourseId || '');
        const course = (db.memory.courses || []).find(c => String(c.id) === courseId) || null;
        const className = cls?.name || membership.name || '';
        const structure = effectiveStructure(courseId, cls?.name)?.structure || course?.structure || [];

        const ownSubmissions = (db.memory.submissions || []).filter(s => s.student && String(s.student.email || '').toLowerCase() === email);
        const contextSubmissions = scopeSubmissionsToContext(ownSubmissions, gradeScope(courseId, className));
        const { modules, overallAverage } = buildStudentReportModules({
            submissions: contextSubmissions.filter(s => s.gradePublished === true),
            allSubmissions: contextSubmissions,
            structure,
            evaluations: db.memory.evaluations || {},
            applications: db.memory.examApplications || [],
        });

        const attendanceRows = attendanceUtil.dedupeByDate((db.memory.attendance || []).filter(a => a.studentEmail === email
            && (!courseId || !a.courseId || String(a.courseId) === courseId) && (!cls || !a.studentClass || a.studentClass === cls.name)));
        const stats = attendanceUtil.computeAttendanceStats(attendanceRows);
        const discNome = {};
        ((course && course.disciplinas) || []).forEach(d => { discNome[d.id] = d.nome; });
        const disciplines = Object.entries(stats.porDisciplina).map(([id, value]) => ({ id, name: discNome[id] || id || 'Sem disciplina', ...value }));
        const progressMap = (db.memory.progress && db.memory.progress[email]) || {};
        const unitKeys = structure.flatMap(module => (module.units || module.items || []).map(unit => unit.apostilaKey).filter(Boolean));
        const completedUnits = unitKeys.filter(key => Array.isArray(progressMap[key]) ? progressMap[key].length > 0 : !!progressMap[key]).length;
        const school = (db.memory.schools || []).find(s => s.id === (course && course.schoolId)) || null;

        res.json({
            generatedAt: Date.now(),
            institution: (school && (school.name || school.info?.tradeName)) || db.memory.branding?.displayName || db.memory.branding?.institutionName || 'IClass',
            student: { name: student.name, nomeSocial: student.nomeSocial || '', email: student.email, matricula: student.matricula || '', status: student.status || '' },
            course: { id: courseId, name: course?.name || courseId || '' },
            className,
            period: cls?.period || student.period || '',
            modules,
            overallAverage,
            attendance: { frequency: stats.frequenciaGeral, presentes: stats.presentes, faltas: stats.faltasContam, totalAulas: stats.totalAulas, days: attendanceRows.length, disciplines, riskThreshold: attendanceUtil.effectiveAttendanceConfig(cls).limiarRiscoPct },
            progress: { completedUnits, totalUnits: unitKeys.length },
            issuedBy: (matchedAdmin && (matchedAdmin.name || matchedAdmin.email)) || 'Instrutor',
        });
    });
});

// Painel do aluno — Etapa 1: indicadores consolidados. Somente admin (escopo aplicado pelo guard).
router.get('/api/admin/student/dashboard', (req, res) => {
    validateAdmin(req, res, () => {
        const email = (req.query.email || '').trim().toLowerCase();
        if (!email) return res.status(400).json({ error: 'E-mail do aluno é obrigatório.' });
        res.json(computeStudentDashboard(db.memory, email));
    });
});

// Data real no formato AAAA-MM-DD (recusa 2026-02-31, 31/02/2026 etc.).
function isValidIsoDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Marcar presença manualmente (Fase 4). Valida e-mail, data e matrícula (CONF-14).
router.post('/api/admin/student/attendance/mark', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const body = req.body || {};
        if (typeof body.email !== 'string' || !body.email.trim()) return res.status(400).json({ error: 'E-mail do aluno é obrigatório.' });
        const email = body.email.trim().toLowerCase();
        let date = settingsUtil.today();
        if (!isEmptyInput(body.date)) {
            if (!isValidIsoDate(body.date)) return res.status(400).json({ error: 'Data inválida. Informe uma data real no formato AAAA-MM-DD.' });
            date = body.date;
        }
        if (body.studentClass !== undefined && body.studentClass !== null && typeof body.studentClass !== 'string') {
            return res.status(400).json({ error: 'Turma inválida.' });
        }
        if (body.courseId !== undefined && body.courseId !== null && typeof body.courseId !== 'string') {
            return res.status(400).json({ error: 'Curso inválido.' });
        }
        if (!Array.isArray(db.memory.attendance)) db.memory.attendance = [];
        const student = (db.memory.students || []).find(s => s.email && s.email.toLowerCase() === email);
        if (!student) return res.status(404).json({ error: 'Aluno não encontrado.' });
        if (!adminCanAccessStudent(matchedAdmin, student)) return res.status(403).json({ error: 'Aluno fora do seu escopo.' });
        const requestedClass = String(body.studentClass || '').trim();
        const requestedCourse = String(body.courseId || '').trim();
        const studentClass = requestedClass || studentClassNames(student)[0] || '';
        if (!studentClass) return res.status(400).json({ error: 'O aluno não está matriculado em nenhuma turma.' });
        if (!studentBelongsToClass(student, studentClass, requestedCourse)) return res.status(400).json({ error: 'O aluno não está matriculado nesta turma.' });
        const membershipCourse = (Array.isArray(student.classes) ? student.classes : [])
            .find(entry => entry && typeof entry === 'object' && (entry.name || entry.className) === studentClass && (!requestedCourse || !entry.courseId || entry.courseId === requestedCourse));
        const courseId = requestedCourse || String(membershipCourse?.courseId || student.courseId || '');
        // Marca presente em todas as aulas da grade do dia (fallback: 1 aula).
        const cls = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId)
            || (db.memory.classes || []).find(c => c.name === studentClass);
        const gradeAulas = attendanceUtil.gradeForDate(cls, date);
        const aulas = (gradeAulas.length ? gradeAulas : [{ ordem: 1, inicio: '', disciplinaId: '' }])
            .map(a => ({ ordem: a.ordem, disciplinaId: a.disciplinaId || '', inicio: a.inicio || '', status: 'presente', hora: '' }));
        db.memory.attendance.push({
            id: 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            studentEmail: email,
            studentClass,
            courseId,
            date,
            origin: 'manual',
            aulas,
            justificativa: null,
            markedBy: (matchedAdmin && matchedAdmin.email) || 'admin',
            timestamp: Date.now(),
        });
        db.save();
        res.json({ success: true, date });
    });
});


// ===================== CHAMADA POR TURMA (presença em massa) =====================
// Status válidos. Ausência (ausente/justificado) NÃO conta como presença nas métricas.
const ATT_STATUS = ['presente', 'ausente', 'atrasado', 'justificado'];

function _studentInClass(student, className, courseId) {
    const cn = String(className || '').trim();
    if (!cn) return false;
    const list = Array.isArray(student.classes) && student.classes.length
        ? student.classes
        : (student.studentClass ? [student.studentClass] : []);
    return list.some(c => {
        const name = typeof c === 'string' ? c : (c && (c.name || c.className));
        const assignedCourse = typeof c === 'object' && c ? c.courseId : (student.courseId || student.currentCourseId);
        return name === cn && (!courseId || !assignedCourse || String(assignedCourse) === String(courseId));
    });
}

// Grade do dia (aulas da turma na data) enriquecida com nome/cor da disciplina.
function _gradeAulasForRoster(cls, course, date) {
    const discById = {};
    ((course && course.disciplinas) || []).forEach(d => { discById[d.id] = d; });
    return attendanceUtil.gradeForDate(cls, date).map(a => ({
        ordem: a.ordem,
        inicio: a.inicio || '',
        disciplinaId: a.disciplinaId || '',
        disciplinaNome: (discById[a.disciplinaId] && discById[a.disciplinaId].nome) || '',
        cor: (discById[a.disciplinaId] && discById[a.disciplinaId].cor) || '',
    }));
}

// Roster da chamada: grade do dia + aulas já marcadas por aluno.
router.get('/api/admin/attendance/roster', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const className = String(req.query.studentClass || '').trim();
        const courseId = String(req.query.courseId || '').trim();
        const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : settingsUtil.today();
        if (!className) return res.status(400).json({ error: 'Turma é obrigatória.' });
        const cls = findClassByNameAndCourse(db.memory.classes || [], className, courseId)
            || (db.memory.classes || []).find(c => c.name === className);
        const course = (db.memory.courses || []).find(c => String(c.id) === courseId);
        const cfg = attendanceUtil.effectiveAttendanceConfig(cls);
        const gradeAulas = _gradeAulasForRoster(cls, course, date);

        const roster = filterStudentsForAdmin((db.memory.students || []).filter(s => _studentInClass(s, className, courseId)), matchedAdmin)
            .map(s => {
                const email = (s.email || '').toLowerCase();
                const recs = (db.memory.attendance || []).filter(a => a.studentEmail === email && a.date === date
                    && (!courseId || !a.courseId || String(a.courseId) === courseId)
                    && (!a.studentClass || a.studentClass === className));
                const rec = recs.find(a => a.origin === 'chamada') || recs.find(a => a.origin !== 'chamada') || null;
                // Aulas salvas têm prioridade; senão, monta a partir da grade (padrão presente).
                let aulas;
                if (rec && Array.isArray(rec.aulas) && rec.aulas.length) {
                    aulas = rec.aulas;
                } else if (rec) {
                    aulas = attendanceUtil.recordAulas(rec); // registro legado (1 aula)
                } else {
                    aulas = gradeAulas.map(a => ({ ordem: a.ordem, disciplinaId: a.disciplinaId, inicio: a.inicio, status: 'presente', hora: '' }));
                }
                // Frequência acumulada do aluno (todas as datas), para o selo de risco
                // na chamada. Dedupe por data evita contar login + chamada no mesmo dia.
                const histRecs = attendanceUtil.dedupeByDate((db.memory.attendance || []).filter(a =>
                    a.studentEmail === email && (!courseId || !a.courseId || String(a.courseId) === courseId)));
                const stats = attendanceUtil.computeAttendanceStats(histRecs);
                const freq = stats.frequenciaGeral;
                return {
                    email: s.email,
                    name: s.name || '',
                    nomeSocial: s.nomeSocial || '',
                    matricula: s.matricula || '',
                    origin: rec ? (rec.origin || '') : '',
                    // Presença automática (acesso do aluno): hora, IP e origem para o
                    // professor conferir antes de concluir a chamada (CRIT-02).
                    acessoAutomatico: rec && rec.origin === 'login'
                        ? { hora: rec.horaAcesso || '', ip: rec.ip || '', via: rec.source === 'heartbeat' ? 'sessão aberta' : 'login' }
                        : null,
                    salvo: !!rec,
                    concluida: !!(rec && rec.concluida),
                    aulas,
                    justificativa: (rec && rec.justificativa) || null,
                    observacao: (rec && rec.observacao) || '',
                    frequencia: freq,
                    faltasAcumuladas: stats.faltasContam,
                    emRisco: freq != null && freq < cfg.limiarRiscoPct,
                };
            })
            .sort((a, b) => (a.nomeSocial || a.name).localeCompare(b.nomeSocial || b.name, 'pt-BR'));
        res.json({
            studentClass: className, courseId, date,
            weekday: attendanceUtil.weekdayOf(date),
            toleranciaMin: cfg.toleranciaMin, limiarRiscoPct: cfg.limiarRiscoPct,
            disciplinas: (course && course.disciplinas) || [],
            aulas: gradeAulas,
            roster,
        });
    });
});

// Salva a chamada de uma turma numa data (upsert por aluno/data) — por aula.
router.post('/api/admin/attendance/bulk', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const className = String(req.body.studentClass || '').trim();
        const courseId = String(req.body.courseId || '').trim();
        const date = isValidIsoDate(req.body.date) ? req.body.date : null;
        const entries = Array.isArray(req.body.entries) ? req.body.entries : null;
        // Rascunho (autosave) x chamada concluída. Ambos contam na frequência —
        // `concluida` é só o marcador de workflow que a tela de chamada exibe.
        const concluida = req.body.concluida === true;
        if (!className || !courseId || !date || !entries) return res.status(400).json({ error: 'Curso, turma, data e lançamentos são obrigatórios.' });
        if (!Array.isArray(db.memory.attendance)) db.memory.attendance = [];

        let saved = 0;
        entries.forEach(entry => {
            const email = String(entry && entry.email || '').trim().toLowerCase();
            if (!email) return;
            const student = (db.memory.students || []).find(s => s.email && s.email.toLowerCase() === email);
            if (!student || !_studentInClass(student, className, courseId)) return;
            const aulas = attendanceUtil.sanitizeAulas(entry.aulas);
            const temJustificada = aulas.some(a => a.status === 'justificada');
            const justificativa = temJustificada ? attendanceUtil.sanitizeJustificativa(entry.justificativa) : null;
            const observacao = String((entry && entry.observacao) || '').slice(0, 500);
            // Remove qualquer registro daquele dia (inclusive login automático) e grava o da chamada.
            db.memory.attendance = db.memory.attendance.filter(a => !(a.studentEmail === email && a.date === date
                && String(a.courseId || '') === courseId && a.studentClass === className));
            db.memory.attendance.push({
                id: 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                studentEmail: email,
                studentClass: className,
                courseId: courseId || (student.classes && student.classes[0] && student.classes[0].courseId) || '',
                date,
                origin: 'chamada',
                concluida,
                aulas,
                justificativa,
                observacao,
                markedBy: (matchedAdmin && matchedAdmin.email) || 'admin',
                timestamp: Date.now(),
            });
            saved++;
        });
        db.save();
        res.json({ success: true, saved, concluida });
    });
});

// Origem do registro como o professor lê ("login" é a presença automática pelo acesso).
const ATT_ORIGIN_LABEL = { chamada: 'Chamada', manual: 'Manual', login: 'Automática (acesso do aluno)' };

// Exporta presença da turma em CSV (uma linha por aula; respeita período opcional).
router.get('/api/admin/attendance/export', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const className = String(req.query.studentClass || '').trim();
        if (!className) return res.status(400).json({ error: 'Turma é obrigatória.' });
        const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
        const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
        const emailsInScope = new Set(filterStudentsForAdmin((db.memory.students || []).filter(s => _studentInClass(s, className)), matchedAdmin).map(s => (s.email || '').toLowerCase()));
        const nameByEmail = {};
        (db.memory.students || []).forEach(s => { if (s.email) nameByEmail[s.email.toLowerCase()] = (s.nomeSocial && s.nomeSocial.trim()) || s.name || ''; });
        // Nome de disciplina por curso.
        const discNome = {};
        (db.memory.courses || []).forEach(c => (c.disciplinas || []).forEach(d => { discNome[`${c.id}::${d.id}`] = d.nome; }));
        let rows = (db.memory.attendance || []).filter(a => a.studentClass === className && emailsInScope.has(a.studentEmail));
        if (from) rows = rows.filter(a => (a.date || '') >= from);
        if (to) rows = rows.filter(a => (a.date || '') <= to);
        rows.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (nameByEmail[a.studentEmail] || '').localeCompare(nameByEmail[b.studentEmail] || '', 'pt-BR'));
        const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
        const stLabel = { presente: 'Presente', falta: 'Falta', justificada: 'Justificada' };
        const header = ['Data', 'Aluno', 'E-mail', 'Turma', 'Aula', 'Disciplina', 'Início', 'Status', 'Abonado', 'Justificativa', 'Origem'];
        const lines = [header.map(esc).join(';')];
        rows.forEach(a => {
            const just = a.justificativa || null;
            const abonado = just && just.abonado ? 'Sim' : '';
            const justTxt = just ? (just.texto || just.tipo || '') : '';
            attendanceUtil.recordAulas(a).forEach(aula => {
                lines.push([
                    a.date, nameByEmail[a.studentEmail] || '', a.studentEmail, a.studentClass,
                    aula.ordem, discNome[`${a.courseId}::${aula.disciplinaId}`] || aula.disciplinaId || '', aula.inicio || '',
                    stLabel[aula.status] || aula.status || '', aula.status === 'justificada' ? abonado : '',
                    aula.status === 'justificada' ? justTxt : '', ATT_ORIGIN_LABEL[a.origin] || a.origin || '',
                ].map(esc).join(';'));
            });
        });
        const csv = '﻿' + lines.join('\r\n'); // BOM p/ acentos no Excel
        res.set('Content-Type', 'text/csv; charset=utf-8');
        res.set('Content-Disposition', `attachment; filename="presenca_${className.replace(/[^a-z0-9]/gi, '_')}.csv"`);
        res.send(csv);
    });
});



// ===================== AVISOS / COMUNICADOS =====================
const ANN_TARGETS = ['todos', 'curso', 'turma', 'aluno'];

function _annProfessorScope(matchedAdmin) {
    const assignments = (matchedAdmin.assignedClasses || []).filter(item => item && typeof item === 'object');
    const assigned = new Set(assignments.map(item => `${item.courseId}::${item.className}`));
    const courseIds = new Set(assignments.map(item => item.courseId));
    return { assigned, courseIds };
}
function _annInScope(a, matchedAdmin) {
    if (!isProfessorAccount(matchedAdmin)) return true;
    if (a.target === 'todos') return true;
    if (a.target === 'turma') return adminCanAccessClass(matchedAdmin, a.targetValue, a.courseId);
    if (a.target === 'curso') return adminAllowedCourseIds(matchedAdmin).has(String(a.courseId || a.targetValue));
    if (a.target === 'aluno') {
        const student = (db.memory.students || []).find(item => String(item.email || '').toLowerCase() === String(a.targetValue || '').toLowerCase());
        return !!student && adminCanAccessStudent(matchedAdmin, student);
    }
    return false;
}

router.get('/api/admin/announcements', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        let list = (db.memory.announcements || []).filter(a => a.kind !== 'calendar' && _annInScope(a, matchedAdmin));
        const courseId = String(req.query.courseId || '').trim();
        const studentClass = String(req.query.studentClass || '').trim();
        if (courseId || studentClass) {
            list = list.filter(a => {
                if (a.target === 'todos') return true;
                if (a.target === 'curso') return String(a.courseId || a.targetValue) === courseId;
                if (a.target === 'turma') return String(a.courseId || '') === courseId && String(a.targetValue || '') === studentClass;
                if (a.target === 'aluno') {
                    if (a.courseId || a.studentClass) return String(a.courseId || '') === courseId && String(a.studentClass || '') === studentClass;
                    const student = (db.memory.students || []).find(item => String(item.email || '').toLowerCase() === String(a.targetValue || '').toLowerCase());
                    return !!student && studentBelongsToClass(student, studentClass, courseId);
                }
                return false;
            });
        }
        list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.createdAt || 0) - (a.createdAt || 0));
        res.json(list.map(a => ({ ...a, readCount: (a.readBy || []).length })));
    });
});

router.post('/api/admin/announcements', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const { title, message, target, targetValue, courseId, studentClass, priority, pinned, expiresAt } = req.body || {};
        if (!title || !message) return res.status(400).json({ error: 'Título e mensagem são obrigatórios.' });
        const tgt = ANN_TARGETS.includes(target) ? target : 'turma';
        if (isProfessorAccount(matchedAdmin)) {
            if (tgt === 'todos') return res.status(403).json({ error: 'Professor não pode enviar aviso para toda a instituição.' });
            if (tgt === 'turma' && !adminCanAccessClass(matchedAdmin, targetValue, courseId)) return res.status(403).json({ error: 'Turma fora do seu escopo.' });
            if (tgt === 'curso' && !adminAllowedCourseIds(matchedAdmin).has(String(courseId || targetValue))) return res.status(403).json({ error: 'Curso fora do seu escopo.' });
        }
        if ((tgt === 'turma' || tgt === 'curso' || tgt === 'aluno') && !String(targetValue || '').trim()) {
            return res.status(400).json({ error: 'Selecione o destino do aviso.' });
        }
        if (tgt === 'aluno') {
            const student = (db.memory.students || []).find(st => st.email && st.email.toLowerCase() === String(targetValue || '').trim().toLowerCase());
            if (!student) return res.status(400).json({ error: 'Nenhum aluno cadastrado com esse e-mail.' });
            if (!studentClass || !studentBelongsToClass(student, studentClass, courseId)) return res.status(403).json({ error: 'O aluno não pertence à turma ativa.' });
        }
        if (!Array.isArray(db.memory.announcements)) db.memory.announcements = [];
        const ann = {
            id: 'ann_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            title: String(title).slice(0, 200),
            message: String(message).slice(0, 5000),
            target: tgt,
            targetValue: tgt === 'todos' ? '' : String(targetValue || '').trim(),
            courseId: tgt === 'todos' ? null : String(courseId || (tgt === 'curso' ? targetValue : '')).trim(),
            studentClass: tgt === 'turma' ? String(targetValue || '').trim() : tgt === 'aluno' ? String(studentClass || '').trim() : '',
            priority: priority === 'alta' ? 'alta' : 'normal',
            pinned: !!pinned,
            expiresAt: (expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) ? expiresAt : null,
            author: (matchedAdmin && matchedAdmin.email) || 'admin',
            authorName: (matchedAdmin && matchedAdmin.name) || '',
            createdAt: Date.now(),
            readBy: [],
        };
        db.memory.announcements.push(ann);
        db.save();
        res.json({ success: true, announcement: ann });
    });
});

router.post('/api/admin/announcements/update', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const { id, title, message, target, targetValue, courseId, studentClass, priority, pinned, expiresAt } = req.body || {};
        const ann = (db.memory.announcements || []).find(a => a.id === id);
        if (!ann) return res.status(404).json({ error: 'Aviso não encontrado.' });
        if (!_annInScope(ann, matchedAdmin)) return res.status(403).json({ error: 'Aviso fora do seu escopo.' });
        const tgt = ANN_TARGETS.includes(target) ? target : ann.target;
        if (isProfessorAccount(matchedAdmin)) {
            if (tgt === 'todos') return res.status(403).json({ error: 'Professor não pode enviar para toda a instituição.' });
            if (tgt === 'turma' && !adminCanAccessClass(matchedAdmin, targetValue, courseId || ann.courseId)) return res.status(403).json({ error: 'Turma fora do seu escopo.' });
            if (tgt === 'curso' && !adminAllowedCourseIds(matchedAdmin).has(String(courseId || targetValue))) return res.status(403).json({ error: 'Curso fora do seu escopo.' });
        }
        if (tgt === 'aluno') {
            const email = String(targetValue !== undefined ? targetValue : ann.targetValue || '').trim().toLowerCase();
            const student = (db.memory.students || []).find(st => st.email && st.email.toLowerCase() === email);
            if (!student) return res.status(400).json({ error: 'Nenhum aluno cadastrado com esse e-mail.' });
            if (!studentClass || !studentBelongsToClass(student, studentClass, courseId || ann.courseId)) return res.status(403).json({ error: 'O aluno não pertence à turma ativa.' });
        }
        if (title !== undefined) ann.title = String(title).slice(0, 200);
        if (message !== undefined) ann.message = String(message).slice(0, 5000);
        ann.target = tgt;
        ann.targetValue = tgt === 'todos' ? '' : String(targetValue !== undefined ? targetValue : ann.targetValue || '').trim();
        ann.courseId = tgt === 'todos' ? null : String(courseId || ann.courseId || (tgt === 'curso' ? ann.targetValue : '')).trim();
        ann.studentClass = tgt === 'turma' ? ann.targetValue : tgt === 'aluno' ? String(studentClass || ann.studentClass || '').trim() : '';
        if (priority !== undefined) ann.priority = priority === 'alta' ? 'alta' : 'normal';
        if (pinned !== undefined) ann.pinned = !!pinned;
        if (expiresAt !== undefined) ann.expiresAt = (expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) ? expiresAt : null;
        ann.updatedAt = Date.now();
        db.save();
        res.json({ success: true, announcement: ann });
    });
});

router.post('/api/admin/announcements/delete', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const id = String((req.body && req.body.id) || '');
        if (!id) return res.status(400).json({ error: 'ID do aviso é obrigatório.' });
        const before = (db.memory.announcements || []).length;
        db.memory.announcements = (db.memory.announcements || []).filter(a => {
            if (a.id !== id) return true;
            return !_annInScope(a, matchedAdmin); // só remove se estiver no escopo de quem pediu
        });
        db.save();
        res.json({ success: true, removed: before - (db.memory.announcements || []).length });
    });
});

// ===================== CALENDARIO DO CURSO =====================
const CALENDAR_TYPES = ['aula', 'prova', 'entrega', 'aviso', 'reuniao', 'outro'];

function _calendarTargetAllowed(matchedAdmin, target, targetValue, courseId) {
    if (!isProfessorAccount(matchedAdmin)) return true;
    if (target === 'curso') return adminAllowedCourseIds(matchedAdmin).has(String(courseId || targetValue));
    return adminCanAccessClass(matchedAdmin, targetValue, courseId);
}

router.get('/api/admin/announcements/calendar', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const courseId = String(req.query.courseId || '').trim();
        const studentClass = String(req.query.studentClass || '').trim();
        const list = (db.memory.announcements || [])
            .filter(item => item.kind === 'calendar'
                && _annInScope(item, matchedAdmin)
                && (!courseId || item.courseId === courseId)
                && (!studentClass || item.target === 'curso' || item.targetValue === studentClass))
            .sort((a, b) => String(a.eventDate).localeCompare(String(b.eventDate)) || String(a.startTime || '').localeCompare(String(b.startTime || '')));
        res.json(list);
    });
});

router.post('/api/admin/announcements/calendar', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const body = req.body || {};
        const title = String(body.title || '').trim();
        const eventDate = String(body.eventDate || '');
        const courseId = String(body.courseId || '').trim();
        const target = body.target === 'turma' ? 'turma' : 'curso';
        const targetValue = target === 'curso' ? courseId : String(body.targetValue || '').trim();
        if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || !courseId || !targetValue) {
            return res.status(400).json({ error: 'Título, data, curso e destino são obrigatórios.' });
        }
        if (!_calendarTargetAllowed(matchedAdmin, target, targetValue, courseId)) return res.status(403).json({ error: 'Destino fora do seu escopo.' });
        if (!Array.isArray(db.memory.announcements)) db.memory.announcements = [];
        const item = {
            id: 'cal_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            kind: 'calendar',
            title: title.slice(0, 200),
            message: String(body.description || '').slice(0, 5000),
            eventDate,
            startTime: /^\d{2}:\d{2}$/.test(body.startTime || '') ? body.startTime : '',
            endTime: /^\d{2}:\d{2}$/.test(body.endTime || '') ? body.endTime : '',
            eventType: CALENDAR_TYPES.includes(body.eventType) ? body.eventType : 'outro',
            target,
            targetValue,
            courseId,
            author: matchedAdmin?.email || 'admin',
            authorName: matchedAdmin?.name || '',
            createdAt: Date.now(),
            readBy: [],
        };
        db.memory.announcements.push(item);
        db.save();
        res.json({ success: true, event: item });
    });
});

router.post('/api/admin/announcements/calendar/update', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const body = req.body || {};
        const item = (db.memory.announcements || []).find(entry => entry.id === body.id && entry.kind === 'calendar');
        if (!item) return res.status(404).json({ error: 'Evento não encontrado.' });
        if (!_annInScope(item, matchedAdmin)) return res.status(403).json({ error: 'Evento fora do seu escopo.' });
        const target = body.target === 'turma' ? 'turma' : 'curso';
        const courseId = String(body.courseId || item.courseId || '').trim();
        const targetValue = target === 'curso' ? courseId : String(body.targetValue || '').trim();
        if (!_calendarTargetAllowed(matchedAdmin, target, targetValue, courseId)) return res.status(403).json({ error: 'Destino fora do seu escopo.' });
        if (!String(body.title || '').trim() || !/^\d{4}-\d{2}-\d{2}$/.test(body.eventDate || '') || !courseId || !targetValue) {
            return res.status(400).json({ error: 'Título, data, curso e destino são obrigatórios.' });
        }
        item.title = String(body.title).trim().slice(0, 200);
        item.message = String(body.description || '').slice(0, 5000);
        item.eventDate = body.eventDate;
        item.startTime = /^\d{2}:\d{2}$/.test(body.startTime || '') ? body.startTime : '';
        item.endTime = /^\d{2}:\d{2}$/.test(body.endTime || '') ? body.endTime : '';
        item.eventType = CALENDAR_TYPES.includes(body.eventType) ? body.eventType : 'outro';
        item.target = target;
        item.targetValue = targetValue;
        item.courseId = courseId;
        item.updatedAt = Date.now();
        db.save();
        res.json({ success: true, event: item });
    });
});

router.post('/api/admin/announcements/calendar/delete', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const id = String(req.body?.id || '');
        const item = (db.memory.announcements || []).find(entry => entry.id === id && entry.kind === 'calendar');
        if (!item) return res.status(404).json({ error: 'Evento não encontrado.' });
        if (!_annInScope(item, matchedAdmin)) return res.status(403).json({ error: 'Evento fora do seu escopo.' });
        db.memory.announcements = db.memory.announcements.filter(entry => entry.id !== id);
        db.save();
        res.json({ success: true });
    });
});


// Emitir certificado (Fase 4)
router.post('/api/admin/student/certificates/issue', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const email = (req.body.email || '').trim().toLowerCase();
        const courseName = (req.body.courseName || '').trim();
        if (!email || !courseName) return res.status(400).json({ error: 'Aluno e curso são obrigatórios.' });
        if (!Array.isArray(db.memory.certificates)) db.memory.certificates = [];
        const code = 'CERT-' + Math.random().toString(16).slice(2, 6).toUpperCase() + '-' + Date.now().toString(36).toUpperCase();
        const cert = {
            id: 'cert_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            studentEmail: email,
            courseId: req.body.courseId || '',
            courseName,
            code,
            status: 'Emitido',
            issuedAt: Date.now(),
            issuedBy: (matchedAdmin && matchedAdmin.email) || 'admin',
        };
        db.memory.certificates.push(cert);
        db.save();
        res.json({ success: true, certificate: cert });
    });
});

// Cancelar certificado (Fase 4)
router.post('/api/admin/student/certificates/revoke', (req, res) => {
    validateAdmin(req, res, () => {
        const { id } = req.body;
        const cert = (db.memory.certificates || []).find(c => c.id === id);
        if (!cert) return res.status(404).json({ error: 'Certificado não encontrado.' });
        cert.status = 'Cancelado';
        cert.revokedAt = Date.now();
        db.save();
        res.json({ success: true });
    });
});

// Obter lista completa de turmas cadastradas (administrador)
router.get('/api/admin/classes', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const classes = readJSON(DB_CLASSES_FILE);
        const professors = (db.memory.admins || []).filter(account => isProfessorAccount(account));
        const students = db.memory.students || [];
        const courseId = String(req.query.courseId || '').trim();
        const studentClass = String(req.query.studentClass || '').trim();
        res.json(filterClassesForAdmin(classes, matchedAdmin)
          .filter(cls => (!courseId || String(cls.courseId) === courseId) && (!studentClass || cls.name === studentClass))
          .map(cls => ({
            ...cls,
            attendanceConfig: attendanceUtil.effectiveAttendanceConfig(cls),
            studentCount: students.filter(student => studentBelongsToClass(student, cls.name, cls.courseId)).length,
            professorCount: professors.filter(account => adminCanAccessClass(account, cls.name, cls.courseId)).length,
          })));
    });
});

router.get('/api/admin/course-summaries', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const includeDeleted = req.query.includeDeleted === '1' || req.query.includeDeleted === 'true';
        const allowedCourseIds = adminAllowedCourseIds(matchedAdmin);
        const courses = (db.memory.courses || []).filter(course =>
            (includeDeleted || !isDeletedCourse(course)) &&
            (!isProfessorAccount(matchedAdmin) || allowedCourseIds.has(course.id))
        );
        const classes = filterClassesForAdmin(readJSON(DB_CLASSES_FILE), matchedAdmin)
            .filter(cls => cls.status !== 'inactive' && cls.status !== 'deleted' && cls.active !== false && !cls.deletedAt);
        const students = filterStudentsForAdmin(db.memory.students || [], matchedAdmin);

        const summaries = courses.map(course => {
            const courseClasses = classes.filter(cls => cls.courseId === course.id);
            const studentCount = students.filter(student => courseClasses.some(cls =>
                studentBelongsToClass(student, cls.name, cls.courseId)
            )).length;
            const periods = [...new Set(courseClasses.map(cls => cls.period).filter(Boolean))];
            const unitCount = courseUnitKeys(course).length;
            return {
                ...course,
                classes: courseClasses.map(cls => ({
                    name: cls.name,
                    period: cls.period || '',
                    registrationEnabled: cls.registrationEnabled !== false,
                    attendanceConfig: attendanceUtil.effectiveAttendanceConfig(cls),
                    studentCount: students.filter(student => studentBelongsToClass(student, cls.name, cls.courseId)).length,
                    professorCount: (db.memory.admins || []).filter(account => isProfessorAccount(account) && adminCanAccessClass(account, cls.name, cls.courseId)).length,
                })),
                stats: {
                    periods,
                    periodLabel: periods.length ? periods.join(', ') : 'Sem turmas',
                    classCount: courseClasses.length,
                    studentCount,
                    unitCount,
                    estimatedHours: estimateCourseHours(course)
                }
            };
        });

        res.json(summaries);
    });
});

// Cadastrar nova turma (administrador)
router.post('/api/admin/class/create', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const { name, period, courseId } = req.body;
        const normalizedPeriod = normalizeClassPeriod(period);
        if (!name || !normalizedPeriod || name.trim() === '' || !courseId) {
            return res.status(400).json({ error: 'Nome, curso ou período inválido. Selecione Manhã, Tarde ou Noite.' });
        }
        const className = name.trim().toUpperCase();
        const classes = readJSON(DB_CLASSES_FILE);
        const exists = classes.find(c => c.name === className && c.courseId === courseId);
        if (exists) {
            return res.status(400).json({ error: 'Esta turma já está cadastrada neste curso.' });
        }
        
        const courses = db.memory.courses || [];
        const course = courses.find(c => c.id === courseId);
        if (!course) {
            return res.status(400).json({ error: 'Curso não encontrado.' });
        }

        const defaultReleasedItems = {};
        if (course.structure) {
            course.structure.forEach(m => {
                (m.units || m.items || []).forEach(unit => {
                    if (unit.apostilaKey) defaultReleasedItems[unit.apostilaKey] = true;
                    if (unit.avaliacaoKey) {
                        defaultReleasedItems[unit.avaliacaoKey] = false;
                        defaultReleasedItems[`Gabarito_${unit.avaliacaoKey}`] = false;
                    }
                });
            });
        }

        const disciplinaIds = new Set(((course && course.disciplinas) || []).map(d => d.id));
        const attendanceConfig = attendanceUtil.sanitizeAttendanceConfig(req.body.attendanceConfig, disciplinaIds)
            || attendanceUtil.configDefault();

        const newClass = {
            name: className,
            period: normalizedPeriod,
            courseId: courseId,
            registrationEnabled: true,
            examConfigs: {},
            releasedItems: defaultReleasedItems,
            attendanceConfig,
            contentOverrides: { materials: {}, evaluations: {}, unitNames: {}, extraUnits: [], structure: null }
        };
        classes.push(newClass);

        recordAcademicAudit(req, matchedAdmin, 'class_created', { courseId, className }, null, newClass);
        writeJSON(DB_CLASSES_FILE, classes);
        res.json({ success: true });
    });
});

router.post('/api/admin/class/update', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const name = String(req.body.name || '').trim().toUpperCase();
        const courseId = String(req.body.courseId || '').trim();
        if (!name || !courseId) return res.status(400).json({ error: 'Nome da turma ou curso não informado.' });
        const classes = readJSON(DB_CLASSES_FILE);
        const cls = classes.find(item => item.name === name && String(item.courseId) === courseId);
        if (!cls) return res.status(404).json({ error: 'Turma não encontrada.' });
        const before = { ...cls };
        if (req.body.period !== undefined) {
            const period = normalizeClassPeriod(req.body.period);
            if (!period) return res.status(400).json({ error: 'Período inválido. Selecione Manhã, Tarde ou Noite.' });
            cls.period = period;
        }
        if (req.body.registrationEnabled !== undefined) cls.registrationEnabled = !!req.body.registrationEnabled;
        if (req.body.attendanceConfig !== undefined) {
            const course = (db.memory.courses || []).find(c => String(c.id) === courseId);
            const disciplinaIds = new Set(((course && course.disciplinas) || []).map(d => d.id));
            const cfg = attendanceUtil.sanitizeAttendanceConfig(req.body.attendanceConfig, disciplinaIds);
            if (!cfg) return res.status(400).json({ error: 'Configuração de presença inválida.' });
            cls.attendanceConfig = cfg;
        }
        recordAcademicAudit(req, matchedAdmin, 'class_updated', { courseId, className: name }, before, { ...cls });
        writeJSON(DB_CLASSES_FILE, classes);
        res.json({ success: true, class: cls });
    });
});

// Define a lista de disciplinas de um curso (usada na grade de presença das turmas).
router.post('/api/admin/course/disciplinas', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const courseId = String(req.body.courseId || '').trim();
        if (!courseId) return res.status(400).json({ error: 'Curso não informado.' });
        const course = (db.memory.courses || []).find(c => String(c.id) === courseId);
        if (!course) return res.status(404).json({ error: 'Curso não encontrado.' });
        const disciplinas = attendanceUtil.sanitizeDisciplinas(req.body.disciplinas);
        if (!disciplinas) return res.status(400).json({ error: 'Lista de disciplinas inválida.' });
        const before = { disciplinas: course.disciplinas || [] };
        course.disciplinas = disciplinas;
        recordAcademicAudit(req, matchedAdmin, 'course_disciplinas_updated', { courseId }, before, { disciplinas });
        db.save();
        res.json({ success: true, disciplinas });
    });
});

// Define os modelos de grade reutilizáveis de um curso (usados pelo assistente de horários).
router.post('/api/admin/course/grade-templates', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const courseId = String(req.body.courseId || '').trim();
        if (!courseId) return res.status(400).json({ error: 'Curso não informado.' });
        const course = (db.memory.courses || []).find(c => String(c.id) === courseId);
        if (!course) return res.status(404).json({ error: 'Curso não encontrado.' });
        const templates = attendanceUtil.sanitizeGradeTemplates(req.body.templates);
        if (!templates) return res.status(400).json({ error: 'Lista de modelos inválida.' });
        const before = { gradeTemplates: course.gradeTemplates || [] };
        course.gradeTemplates = templates;
        recordAcademicAudit(req, matchedAdmin, 'course_grade_templates_updated', { courseId }, before, { gradeTemplates: templates });
        db.save();
        res.json({ success: true, gradeTemplates: templates });
    });
});

// Ativar/Desativar liberação de cadastro para turma (administrador)
router.post('/api/admin/class/toggle-registration', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const { name, courseId, registrationEnabled } = req.body;
        if (!name || !courseId) {
            return res.status(400).json({ error: 'Nome da turma ou curso não informado.' });
        }
        const classes = readJSON(DB_CLASSES_FILE);
        const cls = classes.find(c => c.name === name && c.courseId === courseId);
        if (!cls) {
            return res.status(404).json({ error: 'Turma não encontrada.' });
        }
        const before = { ...cls };
        cls.registrationEnabled = !!registrationEnabled;
        recordAcademicAudit(req, matchedAdmin, 'class_updated', { courseId, className: name }, before, { ...cls });
        writeJSON(DB_CLASSES_FILE, classes);
        res.json({ success: true, classes });
    });
});

// Excluir turma (administrador)
router.post('/api/admin/class/delete', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const { name, courseId } = req.body;
        if (!name || !courseId) {
            return res.status(400).json({ error: 'Nome da turma ou curso não informado.' });
        }
        const classes = readJSON(DB_CLASSES_FILE);
        const removed = classes.find(c => c.name === name && c.courseId === courseId);
        if (!removed) return res.status(404).json({ error: 'Turma não encontrada.' });
        const filtered = classes.filter(c => !(c.name === name && c.courseId === courseId));
        recordAcademicAudit(req, matchedAdmin, 'class_deleted', { courseId, className: name }, removed, null);
        writeJSON(DB_CLASSES_FILE, filtered);
        res.json({ success: true });
    });
});

// ----------------------------------------------------
// DYNAMIC COURSE STRUCTURE AND FILES
// ----------------------------------------------------

// Obter a estrutura dinâmica do curso (módulos e unidades)
router.get('/api/admin/courses/:id/structure', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const { id } = req.params;
        const studentClass = String(req.query.studentClass || '').trim();
        if (!adminCanAccessCourse(matchedAdmin, id) || (studentClass && !adminCanAccessClass(matchedAdmin, studentClass, id))) return res.status(403).json({ error: 'Contexto de turma não autorizado.' });
        const resolved = effectiveStructure(id, studentClass);
        
        if (!resolved) {
            return res.status(404).json({ error: 'Curso não encontrado.' });
        }
        if (studentClass && !resolved.cls) return res.status(404).json({ error: 'Turma não encontrada.' });
        res.json({ success: true, structure: resolved.structure, source: resolved.source, variants: resolved.variants });
    });
});

// Salvar a estrutura do curso (usado para CRUD e drag-and-drop de reordenamento)
router.post('/api/admin/courses/:id/structure', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const { id } = req.params;
        const { structure } = req.body;
        const scope = req.body.scope === 'class' ? 'class' : 'course';
        const studentClass = String(req.body.studentClass || '').trim();
        if (!adminCanAccessCourse(matchedAdmin, id) || (scope === 'class' && !adminCanAccessClass(matchedAdmin, studentClass, id))) return res.status(403).json({ error: 'Contexto de turma não autorizado.' });
        
        if (!Array.isArray(structure)) {
            return res.status(400).json({ error: 'Formato inválido. Esperado array de módulos.' });
        }

        const courses = db.memory.courses || [];
        const courseIndex = courses.findIndex(c => c.id === id);

        if (courseIndex === -1) {
            return res.status(404).json({ error: 'Curso não encontrado.' });
        }

        let affectedClasses = [];
        if (scope === 'class') {
            const cls = findContentClass(id, studentClass);
            if (!cls) return res.status(404).json({ error: 'Turma não encontrada.' });
            ensureOverrides(cls).structure = JSON.parse(JSON.stringify(structure));
            affectedClasses = [studentClass];
        } else {
            courses[courseIndex].structure = structure;
            affectedClasses = contentCourseClasses(id).map(cls => {
                ensureOverrides(cls).structure = null;
                return cls.name;
            });
        }
        db.memory.courses = courses;
        db.save();
        
        const resolved = effectiveStructure(id, studentClass);
        res.json({ success: true, structure: resolved?.structure || structure, scope, affectedClasses });
    });
});

// ----------------------------------------------------
// EDITORES DE CONTEÚDO (APOSTILAS E AVALIAÇÕES)
// ----------------------------------------------------

// Salvar conteúdo da apostila (.md)
router.put('/api/admin/material/:key', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const requestedKey = req.params.key;
        const { markdownText } = req.body;
        const courseId = String(req.body.courseId || '').trim();
        const studentClass = String(req.body.studentClass || '').trim();
        const scope = req.body.scope === 'class' ? 'class' : 'course';
        if ((courseId && !adminCanAccessCourse(matchedAdmin, courseId)) || (scope === 'class' && !adminCanAccessClass(matchedAdmin, studentClass, courseId)) || !adminCanAccessItem(matchedAdmin, requestedKey)) return res.status(403).json({ error: 'Contexto ou recurso não autorizado.' });
        if (markdownText === undefined) {
            return res.status(400).json({ error: 'Conteúdo vazio.' });
        }

        let key = requestedKey;
        let affectedClasses = [];
        try {
            if (scope === 'class') {
                if (!courseId || !studentClass) return res.status(400).json({ error: 'Curso e turma são obrigatórios para uma edição específica.' });
                key = forkMaterial({ courseId, className: studentClass, key: requestedKey }).key;
                affectedClasses = [studentClass];
            } else if (courseId) {
                key = resolveBaseKey(courseId, studentClass, 'materials', requestedKey);
                affectedClasses = contentCourseClasses(courseId).map(cls => cls.name);
                resetOverridesForCourseItem(courseId, 'materials', key);
            }
        } catch (error) {
            return res.status(error.status || 400).json({ error: error.message });
        }

        // Valida se o nome do arquivo é seguro
        if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
            return res.status(400).json({ error: 'Chave de material inválida.' });
        }

        const filePath = path.join(runtimePaths.CONTENT_DIR, `${key}.md`);
        
        try {
            // Backup antes de salvar
            if (fs.existsSync(filePath)) {
                const oldContent = fs.readFileSync(filePath, 'utf8');
                makeBackup(key, oldContent, false);
            }
            
            // A sessão do instrutor nunca fica gravada nos links de imagem (UXA-X2).
            fs.writeFileSync(filePath, stripFileAccessTokens(markdownText, { ownHosts: [req.get('host')] }), 'utf8');
            recordAcademicAudit(req, matchedAdmin, 'content_material_updated', { courseId, className: studentClass, key, scope }, null, { affectedClasses });
            db.save();
            const resolved = courseId ? effectiveStructure(courseId, studentClass) : null;
            res.json({ success: true, key, scope, affectedClasses, structure: resolved?.structure });
        } catch (e) {
            console.error("Erro ao salvar material:", e);
            res.status(500).json({ error: 'Falha ao gravar arquivo no disco.' });
        }
    });
});

// Criar nova apostila e unidade
router.post('/api/admin/material/create', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const { courseId, moduleId, unitName } = req.body;
        const studentClass = String(req.body.studentClass || '').trim();
        const scope = req.body.scope === 'class' ? 'class' : 'course';
        if (!adminCanAccessCourse(matchedAdmin, courseId) || (scope === 'class' && !adminCanAccessClass(matchedAdmin, studentClass, courseId))) return res.status(403).json({ error: 'Contexto de turma não autorizado.' });
        if (!courseId || !moduleId || !unitName) {
            return res.status(400).json({ error: 'Dados incompletos.' });
        }

        const courses = db.memory.courses || [];
        const course = courses.find(c => c.id === courseId);
        if (!course) {
            return res.status(404).json({ error: 'Curso não encontrado.' });
        }

        const resolved = effectiveStructure(courseId, scope === 'class' ? studentClass : '');
        if (scope === 'class' && !resolved?.cls) return res.status(404).json({ error: 'Turma não encontrada.' });
        const structure = resolved?.structure || course.structure || [];
        const targetModule = structure.find((m, index) => String(m.id || m.key || m.name || index) === String(moduleId));
        if (!targetModule) {
            return res.status(404).json({ error: 'Módulo não encontrado.' });
        }

        // Calcula o próximo index da unidade
        const nextId = ((targetModule.units || targetModule.items || []).length + 1).toString();
        const cleanModuleId = moduleId.replace(/[^a-zA-Z0-9]/g, '');
        const keyBase = `${cleanModuleId}_${nextId}`;
        const apostilaKey = scope === 'class' ? uniqueVariantKey(`Apostila_${keyBase}`, courseId, studentClass) : `Apostila_${keyBase}`;
        const avaliacaoKey = scope === 'class' ? uniqueVariantKey(`Avaliacao_${keyBase}`, courseId, studentClass) : `Avaliacao_${keyBase}`;

        // Cria arquivos em disco e no BD
        const mdPath = path.join(runtimePaths.CONTENT_DIR, `${apostilaKey}.md`);
        const defaultMd = `# 📘 ${unitName}\n\nEscreva o conteúdo da sua nova unidade aqui...\n`;
        
        try {
            fs.writeFileSync(mdPath, defaultMd, 'utf8');
            
            // Cria avaliação em branco na memória
            db.memory.evaluations[avaliacaoKey] = {
                key: avaliacaoKey,
                title: `Avaliação: ${unitName}`,
                theme: unitName,
                rubric: "## Parte 2: Boss Fight\n\nDescreva critérios de avaliação aqui...\n",
                questions: []
            };

            const unit = {
                id: nextId,
                name: unitName,
                apostilaKey,
                avaliacaoKey,
                files: []
            };

            if (scope === 'class') {
                addExtraUnit({ courseId, className: studentClass, moduleId, unit });
            } else {
                const baseModule = (course.structure || []).find((m, index) => String(m.id || m.key || m.name || index) === String(moduleId));
                if (!Array.isArray(baseModule.units)) baseModule.units = Array.isArray(baseModule.items) ? baseModule.items : [];
                baseModule.units.push(unit);
            }

            db.memory.courses = courses;
            const affectedClasses = scope === 'class' ? [studentClass] : contentCourseClasses(courseId).map(cls => cls.name);
            recordAcademicAudit(req, matchedAdmin, 'content_unit_created', { courseId, className: studentClass, moduleId, scope }, null, { unit, affectedClasses });
            db.save();
            res.json({ success: true, apostilaKey, avaliacaoKey, scope, affectedClasses, structure: effectiveStructure(courseId, studentClass)?.structure || structure });
        } catch(e) {
            console.error("Erro ao criar nova apostila:", e);
            res.status(500).json({ error: 'Falha ao criar arquivos no servidor.' });
        }
    });
});

// Obter avaliação estruturada
function normalizeEvaluationPayload(payload) {
    const title = String(payload?.title || '').trim();
    if (!title) throw Object.assign(new Error('Título da avaliação é obrigatório.'), { status: 400 });
    if (!Array.isArray(payload.questions) || payload.questions.length === 0) {
        throw Object.assign(new Error('A avaliação deve ter pelo menos uma questão.'), { status: 400 });
    }
    const questions = payload.questions.map((question, index) => {
        const text = String(question?.text || question?.questionText || '').trim();
        if (!text) throw Object.assign(new Error(`Informe o texto da questão ${index + 1}.`), { status: 400 });
        const rawAlternatives = Array.isArray(question.alternatives) ? question.alternatives : [];
        if (rawAlternatives.length < 2 || rawAlternatives.length > 8) {
            throw Object.assign(new Error(`A questão ${index + 1} deve ter entre 2 e 8 alternativas.`), { status: 400 });
        }
        const requestedCorrect = String(question.correctAnswer || '').trim().toUpperCase();
        const alternatives = rawAlternatives.map((alternative, alternativeIndex) => ({
            letter: String.fromCharCode(65 + alternativeIndex),
            text: String(typeof alternative === 'string' ? alternative : alternative?.text || '').trim(),
            isCorrect: alternative?.isCorrect === true
                || String(alternative?.letter || '').toUpperCase() === requestedCorrect,
        }));
        if (alternatives.some(alternative => !alternative.text)) {
            throw Object.assign(new Error(`Preencha todas as alternativas da questão ${index + 1}.`), { status: 400 });
        }
        if (alternatives.filter(alternative => alternative.isCorrect).length !== 1) {
            throw Object.assign(new Error(`Marque exatamente uma alternativa correta na questão ${index + 1}.`), { status: 400 });
        }
        const correctAnswer = alternatives.find(alternative => alternative.isCorrect).letter;
        return {
            ...question,
            number: index + 1,
            originalNumber: index + 1,
            text,
            alternatives,
            correctAnswer,
        };
    });
    return {
        title,
        theme: String(payload.theme || '').trim(),
        rubric: String(payload.rubric || '').trim(),
        questions,
    };
}

router.post('/api/admin/evaluation', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const courseId = String(req.body.courseId || '').trim();
        const moduleId = String(req.body.moduleId || '').trim();
        const studentClass = String(req.body.studentClass || '').trim();
        const scope = req.body.scope === 'class' ? 'class' : 'course';
        if (!adminCanAccessCourse(matchedAdmin, courseId) || (scope === 'class' && !adminCanAccessClass(matchedAdmin, studentClass, courseId))) return res.status(403).json({ error: 'Contexto de turma não autorizado.' });
        const course = (db.memory.courses || []).find(item => item.id === courseId);
        if (!course) return res.status(404).json({ error: 'Curso não encontrado.' });
        const resolved = effectiveStructure(courseId, scope === 'class' ? studentClass : '');
        if (scope === 'class' && !resolved?.cls) return res.status(404).json({ error: 'Turma não encontrada.' });
        const module = (resolved?.structure || course.structure || []).find((item, index) => String(item.id || item.key || item.name || index) === moduleId);
        if (!module) return res.status(404).json({ error: 'Módulo não encontrado.' });
        let normalized;
        try { normalized = normalizeEvaluationPayload(req.body); }
        catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
        const slug = normalized.title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').slice(0, 48) || 'Nova';
        let key = `Avaliacao_${slug}_${Date.now().toString(36)}`;
        while (db.memory.evaluations[key]) key += '_2';
        const now = new Date().toISOString();
        const evaluation = { key, ...normalized, revision: 1, createdAt: now, updatedAt: now };
        db.memory.evaluations[key] = evaluation;
        const units = Array.isArray(module.units) ? module.units : (Array.isArray(module.items) ? module.items : []);
        const nextId = String(Math.max(0, ...units.map(item => Number(item.id) || 0)) + 1);
        const unit = { id: nextId, name: normalized.title, avaliacaoKey: key, files: [] };
        if (scope === 'class') {
            addExtraUnit({ courseId, className: studentClass, moduleId, unit });
        } else {
            const baseModule = (course.structure || []).find((item, index) => String(item.id || item.key || item.name || index) === moduleId);
            if (!baseModule) return res.status(404).json({ error: 'Módulo não encontrado no modelo do curso.' });
            if (!Array.isArray(baseModule.units)) baseModule.units = Array.isArray(baseModule.items) ? baseModule.items : [];
            baseModule.units.push(unit);
        }
        const affectedClasses = scope === 'class' ? [studentClass] : contentCourseClasses(courseId).map(cls => cls.name);
        recordAcademicAudit(req, matchedAdmin, 'content_evaluation_created', { courseId, className: studentClass, moduleId, key, scope }, null, { affectedClasses });
        db.save();
        res.status(201).json({ success: true, key, evaluation, scope, affectedClasses, structure: effectiveStructure(courseId, studentClass)?.structure || course.structure });
    });
});

router.get('/api/admin/evaluation/:key', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const { key } = req.params;
        if (!adminCanAccessItem(matchedAdmin, key)) return res.status(403).json({ error: 'Recurso não autorizado.' });
        let evaluation = db.memory.evaluations[key];
        
        if (!evaluation) {
            // Tenta carregar e migrar se houver arquivo .md legando em disco
            const mdPath = path.join(runtimePaths.CONTENT_DIR, `${key}.md`);
            if (fs.existsSync(mdPath)) {
                try {
                    const mdContent = fs.readFileSync(mdPath, 'utf8');
                    evaluation = parseEvaluationMarkdown(mdContent, key);
                    if (evaluation) {
                        db.memory.evaluations[key] = evaluation;
                        db.save();
                    }
                } catch(e) {}
            }
        }

        if (!evaluation) {
            return res.status(404).json({ error: 'Avaliação não encontrada.' });
        }
        res.json(evaluation);
    });
});

// Salvar avaliação estruturada
router.put('/api/admin/evaluation/:key', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const requestedKey = req.params.key;
        const evaluationData = req.body;
        const courseId = String(evaluationData.courseId || '').trim();
        const studentClass = String(evaluationData.studentClass || '').trim();
        const scope = evaluationData.scope === 'class' ? 'class' : 'course';
        if ((courseId && !adminCanAccessCourse(matchedAdmin, courseId)) || (scope === 'class' && !adminCanAccessClass(matchedAdmin, studentClass, courseId)) || !adminCanAccessItem(matchedAdmin, requestedKey)) return res.status(403).json({ error: 'Contexto ou recurso não autorizado.' });
        let key = requestedKey;
        let baseKey = requestedKey;
        let affectedClasses = [];
        if (courseId) {
            if (scope === 'class') {
                try {
                    const forked = forkEvaluation({ courseId, className: studentClass, key: requestedKey });
                    key = forked.key;
                    baseKey = forked.baseKey || requestedKey;
                    affectedClasses = [studentClass];
                    ensureOverrides(findContentClass(courseId, studentClass)).unitNames[baseKey] = String(evaluationData.title || '').trim();
                } catch (error) {
                    return res.status(error.status || 400).json({ error: error.message });
                }
            } else {
                baseKey = resolveBaseKey(courseId, studentClass, 'evaluations', requestedKey);
                key = baseKey;
                affectedClasses = contentCourseClasses(courseId).map(cls => cls.name);
                resetOverridesForCourseItem(courseId, 'evaluations', baseKey);
            }
        }
        let normalized;
        try { normalized = normalizeEvaluationPayload(evaluationData); }
        catch (error) { return res.status(error.status || 400).json({ error: error.message }); }

        // Backup
        if (db.memory.evaluations[key]) {
            makeBackup(key, JSON.stringify(db.memory.evaluations[key], null, 2), true);
        }

        const previous = db.memory.evaluations[key] || {};
        const now = new Date().toISOString();
        db.memory.evaluations[key] = {
            ...previous,
            key,
            ...normalized,
            revision: Number(previous.revision || 0) + 1,
            createdAt: previous.createdAt || now,
            updatedAt: now,
            revisionHistory: [...(previous.revisionHistory || []).slice(-19), {
                revision: Number(previous.revision || 0) || 1,
                savedAt: previous.updatedAt || previous.createdAt || now,
                title: previous.title || normalized.title,
                questionCount: Array.isArray(previous.questions) ? previous.questions.length : 0,
            }],
        };
        (db.memory.courses || []).forEach(course => {
            if (courseId && String(course.id) !== courseId) return;
            (course.structure || []).forEach(module => {
                const units = Array.isArray(module.units) ? module.units : (Array.isArray(module.items) ? module.items : []);
                units.forEach(unit => {
                    if (unit.avaliacaoKey === key || (scope === 'course' && unit.avaliacaoKey === baseKey)) unit.name = normalized.title;
                });
            });
        });
        if (courseId && scope === 'class') {
            const overrides = ensureOverrides(findContentClass(courseId, studentClass));
            overrides.extraUnits.forEach(extra => {
                if (extra.unit?.avaliacaoKey === key || extra.unit?.avaliacaoKey === requestedKey) extra.unit.name = normalized.title;
            });
        }
        recordAcademicAudit(req, matchedAdmin, 'content_evaluation_updated', { courseId, className: studentClass, key, sourceKey: requestedKey, scope }, null, { affectedClasses });
        db.save();
        res.json({ success: true, key, scope, affectedClasses, evaluation: db.memory.evaluations[key], structure: courseId ? effectiveStructure(courseId, studentClass)?.structure : undefined });
    });
});

// Duplicar avaliação (Prova 2 a partir da Prova 1)
router.post('/api/admin/evaluation/duplicate', (req, res) => {
    validateAdmin(req, res, () => {
        const { sourceKey, targetKey, targetTitle } = req.body;
        if (!sourceKey || !targetKey || !targetTitle) {
            return res.status(400).json({ error: 'Dados incompletos para duplicação.' });
        }

        const sourceEval = db.memory.evaluations[sourceKey];
        if (!sourceEval) {
            return res.status(404).json({ error: 'Avaliação de origem não encontrada.' });
        }

        // Deep copy questions
        const clonedQuestions = JSON.parse(JSON.stringify(sourceEval.questions));

        db.memory.evaluations[targetKey] = {
            key: targetKey,
            title: targetTitle,
            theme: sourceEval.theme,
            rubric: sourceEval.rubric,
            questions: clonedQuestions
        };

        db.save();
        res.json({ success: true, targetKey });
    });
});

// ----------------------------------------------------
// UPLOADS DE MATERIAIS
// ----------------------------------------------------

const multer = require('multer');
const uploadDir = runtimePaths.UPLOADS_DIR;
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
function uploadForRequest() {
    const maxSizeMb = Number(settingsUtil.getSettings().upload.maxSizeMb || 50);
    return multer({
        storage,
        limits: { fileSize: maxSizeMb * 1024 * 1024, files: 1, fields: 30 },
        fileFilter: (req, file, cb) => {
            if (isBlockedUploadName(file.originalname)) return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
            cb(null, true);
        }
    });
}

// Mensagem do envio recusado em português (o multer responde em inglês: "Unexpected
// field", "File too large"). O tipo bloqueado (.exe, .bat...) chega como LIMIT_UNEXPECTED_FILE.
const UPLOAD_ERROR_MESSAGES = {
    LIMIT_UNEXPECTED_FILE: 'tipo de arquivo não permitido.',
    LIMIT_FILE_SIZE: 'arquivo maior que o limite de envio.',
    LIMIT_FILE_COUNT: 'envie um arquivo por vez.',
    LIMIT_PART_COUNT: 'envio com partes demais.',
    LIMIT_FIELD_COUNT: 'envio com campos demais.',
    LIMIT_FIELD_KEY: 'nome de campo grande demais.',
    LIMIT_FIELD_VALUE: 'campo grande demais.',
};
function uploadErrorMessage(err) {
    const detail = (err && UPLOAD_ERROR_MESSAGES[err.code]) || 'o arquivo não pôde ser recebido.';
    return `Erro no upload: ${detail}`;
}

// `discard`: apaga o arquivo recusado em vez de mandá-lo para a lixeira (arquivo de
// backup leva o banco inteiro e não pode reaparecer pela lixeira, SEG-X1).
function rejectInvalidUpload(req, res, { discard = false } = {}) {
    const result = validateUploadedFile(req.file);
    if (result.valid) return false;
    try {
        if (discard) fs.rmSync(req.file.path, { force: true });
        else fileStore.moveToTrash(req.file.path);
    } catch (e) {}
    res.status(400).json({ error: result.reason });
    return true;
}

router.use(createAdminRecoveryRouter({ uploadForRequest, rejectInvalidUpload, uploadErrorMessage, uploadDir }));
router.use(createAdminArchiveRouter({ studentClassNames }));
router.use(createAdminSystemRouter());
router.use(createAdminAccountsRouter());
router.use(createAdminExamConfigRouter());


// Upload de comprovante/atestado de justificativa (PDF ou imagem)
router.post('/api/admin/attendance/justification-upload', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        uploadForRequest().single('file')(req, res, async (err) => {
            if (err) return res.status(400).json({ error: uploadErrorMessage(err) });
            if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
            if (rejectInvalidUpload(req, res)) return;
            const requestedCourseId = String(req.body.courseId || '').trim();
            const requestedClass = String(req.body.studentClass || '').trim();
            const requestedScope = req.body.scope === 'class' ? 'class' : 'course';
            if (!adminCanAccessCourse(matchedAdmin, requestedCourseId) || (requestedScope === 'class' && !adminCanAccessClass(matchedAdmin, requestedClass, requestedCourseId))) {
                try { fileStore.moveToTrash(path.join(uploadDir, req.file.filename)); } catch (error) {}
                return res.status(403).json({ error: 'Contexto de turma não autorizado.' });
            }
            const tempPath = path.join(uploadDir, req.file.filename);
            const ext = path.extname(req.file.originalname).toLowerCase();
            if (!['.pdf', '.jpg', '.jpeg', '.png', '.webp'].includes(ext)) { fileStore.moveToTrash(tempPath); return res.status(400).json({ error: 'Envie um PDF ou imagem (jpg, png, webp).' }); }
            const email = String(req.body.studentEmail || '').trim().toLowerCase();
            const student = (db.memory.students || []).find(st => st.email && st.email.toLowerCase() === email);
            if (!student) { fileStore.moveToTrash(tempPath); return res.status(400).json({ error: 'Aluno não informado.' }); }
            if (isProfessorAccount(matchedAdmin) && !adminCanAccessStudent(matchedAdmin, student)) { fileStore.moveToTrash(tempPath); return res.status(403).json({ error: 'Aluno fora do seu escopo.' }); }
            const _stA = settingsUtil.getSettings();
            if (req.file.size > _stA.upload.maxSizeMb * 1024 * 1024) { fileStore.moveToTrash(tempPath); return res.status(400).json({ error: 'Arquivo excede o limite de ' + _stA.upload.maxSizeMb + ' MB.' }); }
            const rel = fileStore.storeStudentFile(student, 'atestados', req.file.originalname, tempPath);
            res.json({ success: true, file: rel, name: req.file.originalname });
        });
    });
});

// Download autenticado de documento do aluno (só instrutor no escopo).
router.get('/api/admin/attendance/justification-file', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const email = String(req.query.studentEmail || '').trim().toLowerCase();
        const file = String(req.query.file || '');
        const student = (db.memory.students || []).find(st => st.email && st.email.toLowerCase() === email);
        if (!student) return res.status(404).json({ error: 'Aluno não encontrado.' });
        if (isProfessorAccount(matchedAdmin) && !adminCanAccessStudent(matchedAdmin, student)) return res.status(403).json({ error: 'Fora do seu escopo.' });
        if (!fileStore.isInsideStudents(file)) return res.status(400).json({ error: 'Caminho inválido.' });
        const base = path.resolve(fileStore.studentDir(student));
        const target = path.resolve(fileStore.absFromData(file));
        if (target !== base && !target.startsWith(base + path.sep)) return res.status(403).json({ error: 'Arquivo fora da pasta do aluno.' });
        if (!fs.existsSync(target)) return res.status(404).json({ error: 'Arquivo não encontrado.' });
        res.sendFile(target);
    });
});

// ===================== BIBLIOTECA DE MATERIAIS =====================
function _libFileType(ext) {
    ext = String(ext || '').toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'].includes(ext)) return 'image';
    if (ext === '.pdf') return 'pdf';
    if (['.mp4', '.webm', '.mov', '.avi', '.mkv'].includes(ext)) return 'video';
    if (['.zip', '.rar', '.7z'].includes(ext)) return 'zip';
    if (['.doc', '.docx', '.odt'].includes(ext)) return 'doc';
    if (['.xls', '.xlsx', '.csv'].includes(ext)) return 'sheet';
    return 'other';
}
// Rastreabilidade: onde um material esta sendo usado (varre apostilas .md por filename/url).
function _libUsage(entry) {
    const used = [];
    try {
        const contentDir = runtimePaths.CONTENT_DIR;
        const n1 = entry.filename || '';
        const n2 = entry.url || '';
        fs.readdirSync(contentDir).filter(f => f.endsWith('.md')).forEach(f => {
            try {
                const txt = fs.readFileSync(path.join(contentDir, f), 'utf8');
                if ((n1 && txt.includes(n1)) || (n2 && txt.includes(n2))) used.push(f.replace(/\.md$/, ''));
            } catch (e) {}
        });
    } catch (e) {}
    return used;
}

function effectiveLibraryEntries(courseId, studentClass) {
    const entries = (db.memory.library || []).filter(entry => String(entry.courseId || '') === String(courseId || ''));
    if (!studentClass) return entries.filter(entry => !entry.hidden);
    const classEntries = entries.filter(entry => String(entry.studentClass || '') === String(studentClass));
    const replaced = new Set(classEntries.map(entry => entry.sourceLibraryId).filter(Boolean));
    return [
        ...entries.filter(entry => !entry.studentClass && !replaced.has(entry.id) && !entry.hidden),
        ...classEntries.filter(entry => !entry.hidden),
    ];
}

router.get('/api/admin/library', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const allowedCourses = adminAllowedCourseIds(matchedAdmin);
        const courseId = String(req.query.courseId || '').trim();
        const studentClass = String(req.query.studentClass || '').trim();
        if (studentClass && !adminCanAccessClass(matchedAdmin, studentClass, courseId)) return res.status(403).json({ error: 'Contexto de turma não autorizado.' });
        const source = courseId ? effectiveLibraryEntries(courseId, studentClass) : (db.memory.library || []);
        const list = source
            .filter(entry => !isProfessorAccount(matchedAdmin) || allowedCourses.has(entry.courseId))
            .slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        const access = encodeURIComponent(String(req.get('x-admin-session') || ''));
        res.json(list.map(e => ({ ...e, url: e.kind === 'link' ? e.url : `${e.url}${e.url.includes('?') ? '&' : '?'}access=${access}`, usedIn: _libUsage(e) })));
    });
});

router.post('/api/admin/library/upload', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        uploadForRequest().single('file')(req, res, (err) => {
            if (err) return res.status(400).json({ error: uploadErrorMessage(err) });
            if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
            if (rejectInvalidUpload(req, res)) return;
            const ext = path.extname(req.file.originalname).toLowerCase();
            const _st = settingsUtil.getSettings();
            if (req.file.size > _st.upload.maxSizeMb * 1024 * 1024) { fileStore.moveToTrash(path.join(uploadDir, req.file.filename)); return res.status(400).json({ error: 'Arquivo excede o limite de ' + _st.upload.maxSizeMb + ' MB.' }); }
            if (!_st.upload.allowedTypes.includes(settingsUtil.extCategory(ext))) { fileStore.moveToTrash(path.join(uploadDir, req.file.filename)); return res.status(400).json({ error: 'Tipo de arquivo não permitido nas configurações.' }); }
            let tags = [];
            try { tags = req.body.tags ? String(req.body.tags).split(',').map(t => t.trim()).filter(Boolean) : []; } catch (e) {}
            const entry = {
                id: 'lib_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
                kind: 'file',
                courseId: String(req.body.courseId || ''),
                studentClass: req.body.scope === 'class' ? String(req.body.studentClass || '') : '',
                moduleId: String(req.body.moduleId || ''),
                name: req.body.name ? String(req.body.name).slice(0, 200) : req.file.originalname,
                originalName: req.file.originalname,
                filename: req.file.filename,
                url: '/uploads/' + req.file.filename,
                type: _libFileType(ext),
                ext,
                size: req.file.size || 0,
                description: req.body.description ? String(req.body.description).slice(0, 500) : '',
                tags,
                author: (matchedAdmin && matchedAdmin.email) || 'admin',
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            if (!Array.isArray(db.memory.library)) db.memory.library = [];
            db.memory.library.push(entry);
            const affectedClasses = entry.studentClass ? [entry.studentClass] : contentCourseClasses(entry.courseId).map(cls => cls.name);
            recordAcademicAudit(req, matchedAdmin, 'content_library_created', { courseId: entry.courseId, className: entry.studentClass, id: entry.id, scope: entry.studentClass ? 'class' : 'course' }, null, { affectedClasses });
            db.save();
            res.json({ success: true, entry, affectedClasses });
        });
    });
});

router.post('/api/admin/library/link', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const { title, url, description, tags, courseId, moduleId } = req.body || {};
        const requestedClass = String(req.body.studentClass || '').trim();
        const requestedScope = req.body.scope === 'class' ? 'class' : 'course';
        if (!adminCanAccessCourse(matchedAdmin, courseId) || (requestedScope === 'class' && !adminCanAccessClass(matchedAdmin, requestedClass, courseId))) return res.status(403).json({ error: 'Contexto de turma não autorizado.' });
        if (!title || !url) return res.status(400).json({ error: 'Título e URL são obrigatórios.' });
        if (!/^https?:\/\//i.test(String(url))) return res.status(400).json({ error: 'A URL deve começar com http:// ou https://' });
        const isVideo = /youtube\.com|youtu\.be|vimeo\.com|\.mp4(\?|$)/i.test(url);
        let tg = [];
        try { tg = tags ? (Array.isArray(tags) ? tags : String(tags).split(',').map(t => t.trim()).filter(Boolean)) : []; } catch (e) {}
        const entry = {
            id: 'lib_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
            kind: 'link',
            courseId: String(courseId || ''),
            studentClass: req.body.scope === 'class' ? String(req.body.studentClass || '') : '',
            moduleId: String(moduleId || ''),
            name: String(title).slice(0, 200),
            url: String(url).slice(0, 1000),
            type: isVideo ? 'video' : 'link',
            size: 0,
            description: description ? String(description).slice(0, 500) : '',
            tags: tg,
            author: (matchedAdmin && matchedAdmin.email) || 'admin',
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        if (!Array.isArray(db.memory.library)) db.memory.library = [];
        db.memory.library.push(entry);
        const affectedClasses = entry.studentClass ? [entry.studentClass] : contentCourseClasses(entry.courseId).map(cls => cls.name);
        recordAcademicAudit(req, matchedAdmin, 'content_library_created', { courseId: entry.courseId, className: entry.studentClass, id: entry.id, scope: entry.studentClass ? 'class' : 'course' }, null, { affectedClasses });
        db.save();
        res.json({ success: true, entry, affectedClasses });
    });
});

router.post('/api/admin/library/update', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const { id, name, description, tags } = req.body || {};
        const original = (db.memory.library || []).find(x => x.id === id);
        let e = original;
        if (!e) return res.status(404).json({ error: 'Material não encontrado.' });
        const courseId = String(req.body.courseId || original.courseId || '').trim();
        const studentClass = String(req.body.studentClass || '').trim();
        const scope = req.body.scope === 'class' ? 'class' : 'course';
        if (!adminCanAccessCourse(matchedAdmin, courseId)) return res.status(403).json({ error: 'Curso não autorizado.' });
        if (scope === 'class') {
            if (!studentClass || !adminCanAccessClass(matchedAdmin, studentClass, courseId)) return res.status(403).json({ error: 'Contexto de turma não autorizado.' });
            if (String(original.studentClass || '') !== studentClass) {
                e = (db.memory.library || []).find(item => item.sourceLibraryId === original.id && String(item.studentClass || '') === studentClass);
                if (!e) {
                    e = { ...original, id: `lib_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, studentClass, sourceLibraryId: original.sourceLibraryId || original.id, createdAt: Date.now() };
                    db.memory.library.push(e);
                }
            }
        } else {
            const sourceId = original.sourceLibraryId || original.id;
            e = (db.memory.library || []).find(item => item.id === sourceId) || original;
            e.studentClass = '';
            e.hidden = false;
            db.memory.library = (db.memory.library || []).filter(item => item === e || item.sourceLibraryId !== sourceId);
        }
        if (req.body.moduleId !== undefined) e.moduleId = String(req.body.moduleId || '');
        if (req.body.url !== undefined && e.kind === 'link') {
            const u = String(req.body.url);
            if (/^https?:\/\//i.test(u)) { e.url = u.slice(0, 1000); e.type = /youtube\.com|youtu\.be|vimeo\.com|\.mp4(\?|$)/i.test(u) ? 'video' : 'link'; }
        }
        if (name !== undefined) e.name = String(name).slice(0, 200);
        if (description !== undefined) e.description = String(description).slice(0, 500);
        if (tags !== undefined) e.tags = Array.isArray(tags) ? tags : String(tags).split(',').map(t => t.trim()).filter(Boolean);
        e.updatedAt = Date.now();
        const affectedClasses = scope === 'class' ? [studentClass] : contentCourseClasses(courseId).map(cls => cls.name);
        recordAcademicAudit(req, matchedAdmin, 'content_library_updated', { courseId, className: studentClass, id: e.id, sourceId: original.id, scope }, null, { affectedClasses });
        db.save();
        res.json({ success: true, entry: e, affectedClasses });
    });
});

router.post('/api/admin/library/delete', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const { id, force } = req.body || {};
        const e = (db.memory.library || []).find(x => x.id === id);
        if (!e) return res.status(404).json({ error: 'Material não encontrado.' });
        const usedIn = _libUsage(e);
        if (usedIn.length && !force) {
            return res.status(409).json({ error: 'Material em uso.', usedIn });
        }
        const courseId = String(req.body.courseId || e.courseId || '').trim();
        const studentClass = String(req.body.studentClass || '').trim();
        const scope = req.body.scope === 'class' ? 'class' : 'course';
        if (!adminCanAccessCourse(matchedAdmin, courseId) || (scope === 'class' && !adminCanAccessClass(matchedAdmin, studentClass, courseId))) return res.status(403).json({ error: 'Contexto de turma não autorizado.' });
        if (scope === 'class' && String(e.studentClass || '') !== studentClass) {
            db.memory.library.push({
                id: `lib_hidden_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                courseId,
                studentClass,
                sourceLibraryId: e.sourceLibraryId || e.id,
                hidden: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            });
        } else if (scope === 'class') {
            db.memory.library = (db.memory.library || []).filter(x => x.id !== id);
            try { if (!e.sourceLibraryId && e.kind !== 'link' && e.filename) fileStore.moveToTrash(path.join(uploadDir, e.filename)); } catch (err) {}
        } else {
            const sourceId = e.sourceLibraryId || e.id;
            const base = (db.memory.library || []).find(item => item.id === sourceId) || e;
            db.memory.library = (db.memory.library || []).filter(item => item.id !== sourceId && item.sourceLibraryId !== sourceId);
            try { if (base.kind !== 'link' && base.filename) fileStore.moveToTrash(path.join(uploadDir, base.filename)); } catch (err) {}
        }
        const affectedClasses = scope === 'class' ? [studentClass] : contentCourseClasses(courseId).map(cls => cls.name);
        recordAcademicAudit(req, matchedAdmin, 'content_library_deleted', { courseId, className: studentClass, id, scope }, null, { affectedClasses });
        db.save();
        res.json({ success: true, removed: 1, affectedClasses });
    });
});



function forEachCourseUnit(callback) {
    const courses = db.memory.courses || [];
    courses.forEach(course => {
        (course.structure || []).forEach(mod => {
            (mod.units || []).forEach(unit => callback(unit, mod, course));
        });
    });

    // Compatibilidade com bases antigas que ainda usam courseStructure.
    (db.memory.courseStructure || []).forEach(mod => {
        (mod.units || []).forEach(unit => callback(unit, mod, null));
    });
}

function getFilesForApostila(key) {
    let files = [];
    forEachCourseUnit(unit => {
        if (unit.apostilaKey === key) {
            files = unit.files || [];
        }
    });
    return files;
}

router.post('/api/admin/upload', (req, res) => {
    validateAdmin(req, res, () => {
        uploadForRequest().single('file')(req, res, (err) => {
            if (err) {
                return res.status(400).json({ error: 'Erro ao fazer upload do arquivo: ' + err.message });
            }
            if (!req.file) {
                return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
            }
            if (rejectInvalidUpload(req, res)) return;
            
            const { apostilaKey } = req.body;
            const originalname = req.file.originalname;
            const filename = req.file.filename;
            const relativePath = '/uploads/' + filename;
            const ext = path.extname(originalname).toLowerCase();
            let fileType = 'other';
            if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'].includes(ext)) {
                fileType = 'image';
            } else if (ext === '.pdf') {
                fileType = 'pdf';
            }
            
            let linked = false;
            forEachCourseUnit(u => {
                if (u.apostilaKey === apostilaKey) {
                    if (!u.files) u.files = [];
                    u.files.push({
                        id: 'f_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
                        name: originalname,
                        path: relativePath,
                        type: fileType,
                        timestamp: new Date().toISOString()
                    });
                    linked = true;
                }
            });
            
            if (linked) {
                db.save();
                res.json({ success: true, files: getFilesForApostila(apostilaKey) });
            } else {
                res.status(404).json({ error: 'Apostila não encontrada.' });
            }
        });
    });
});

router.post('/api/admin/upload-image', (req, res) => {
    validateAdmin(req, res, () => {
        uploadForRequest().single('image')(req, res, (err) => {
            if (err) {
                return res.status(400).json({ error: 'Erro ao fazer upload da imagem: ' + err.message });
            }
            if (!req.file) {
                return res.status(400).json({ error: 'Nenhuma imagem enviada.' });
            }
            if (rejectInvalidUpload(req, res)) return;
            if (!['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(path.extname(req.file.originalname).toLowerCase())) {
                fileStore.moveToTrash(req.file.path);
                return res.status(400).json({ error: 'Envie uma imagem raster segura (JPG, PNG, GIF ou WebP).' });
            }
            const filename = req.file.filename;
            const relativePath = '/uploads/' + filename;
            
            res.json({ success: true, url: relativePath });
        });
    });
});

router.post('/api/admin/material/link', (req, res) => {
    validateAdmin(req, res, () => {
        const { apostilaKey, name, url } = req.body;
        if (!apostilaKey || !name || !url) {
            return res.status(400).json({ error: 'Dados incompletos.' });
        }
        
        let linked = false;
        forEachCourseUnit(u => {
            if (u.apostilaKey === apostilaKey) {
                if (!u.files) u.files = [];
                u.files.push({
                    id: 'l_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
                    name,
                    path: url,
                    type: 'link',
                    timestamp: new Date().toISOString()
                });
                linked = true;
            }
        });
        
        if (linked) {
            db.save();
            res.json({ success: true, files: getFilesForApostila(apostilaKey) });
        } else {
            res.status(404).json({ error: 'Apostila não encontrada.' });
        }
    });
});

router.post('/api/admin/material/delete-file', (req, res) => {
    validateAdmin(req, res, () => {
        const { apostilaKey, fileId } = req.body;
        if (!apostilaKey || !fileId) {
            return res.status(400).json({ error: 'Dados incompletos.' });
        }
        
        let removed = false;
        forEachCourseUnit(u => {
            if (u.apostilaKey === apostilaKey && u.files) {
                const beforeLength = u.files.length;
                u.files = u.files.filter(f => f.id !== fileId);
                if (u.files.length < beforeLength) {
                    removed = true;
                }
            }
        });
        
        if (removed) {
            db.save();
            res.json({ success: true, files: getFilesForApostila(apostilaKey) });
        } else {
            res.status(404).json({ error: 'Recurso não encontrado.' });
        }
    });
});

// Função de backup automático
function makeBackup(key, content, isJson = false) {
    const backupDir = runtimePaths.BACKUPS_DIR;
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = isJson ? '.json' : '.md';
    const backupPath = path.join(backupDir, `${key}_${timestamp}${ext}.bak`);
    fs.writeFileSync(backupPath, content, 'utf8');
}


// ----------------------------------------------------
// ENDPOINTS DE CONTROLE E MONITORAMENTO DE PROVAS ONLINE
// ----------------------------------------------------

// 1. Inicia, pausa, retoma ou encerra um exame de uma turma
router.post('/api/admin/server-exam-control', (req, res) => {
    validateAdmin(req, res, () => {
        const { studentClass, courseId, examKey, applicationId } = req.body;
        const actionAliases = { start: 'running', pause: 'paused', resume: 'running', finish: 'finished', stop: 'finished' };
        const action = actionAliases[req.body.action] || req.body.action;
        if (!studentClass || !examKey || !action) {
            return res.status(400).json({ error: 'Parâmetros studentClass, examKey e action são obrigatórios.' });
        }

        const classes = db.memory.classes;
        const cls = findClassByNameAndCourse(classes, studentClass, courseId);
        if (!cls) {
            return res.status(404).json({ error: 'Turma não encontrada.' });
        }

        if (!cls.onlineExamConfigs) {
            cls.onlineExamConfigs = {};
        }

        if (!cls.onlineExamConfigs[examKey]) {
            cls.onlineExamConfigs[examKey] = {
                status: 'not_applied',
                startTime: null,
                durationMinutes: DEFAULT_ONLINE_DURATION_MINUTES,
                globalTimeAdjustment: 0,
                waitingRoomDuration: DEFAULT_WAITING_ROOM_MINUTES * 60,
                onlineActive: false
            };
        }

        const currentConfig = cls.onlineExamConfigs[examKey];
        const application = findExamApplication(db.memory.examApplications, applicationId || currentConfig.applicationId);
        if (applicationId && !application) {
            return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });
        }
        if (application) {
            // Encerrar ou cancelar uma aplicação em andamento pelo controle antigo segue a
            // mesma regra do Monitor: sem decisão sobre as respostas, nada é encerrado (AVA-04).
            // A transição é conferida antes; repetir o encerramento não muda nada.
            let plan;
            try {
                plan = planControlAction(db.memory, application, action);
            } catch (error) {
                return res.status(error.status || 400).json({ error: error.message });
            }
            if (plan.unchanged) {
                if (plan.droppedLeftovers) db.save();
                return res.json({ success: true, unchanged: true, application, config: currentConfig });
            }
            if (plan.resolve) {
                try {
                    resolveInProgressAttempts(db.memory, {
                        application,
                        onlineConfig: currentConfig,
                        policy: req.body.inProgressPolicy,
                        actor: req.adminAccount?.email || 'Administrador',
                    });
                } catch (error) {
                    if (!error.requiresInProgressPolicy) throw error;
                    return res.status(409).json({ error: error.message, requiresInProgressPolicy: true, summary: error.summary });
                }
            }
            try {
                transitionExamApplication(application, action, {
                    actor: req.adminAccount?.email || 'Administrador',
                    waitingRoomDuration: req.body.waitingRoomDuration,
                    adjustmentSeconds: req.body.adjustmentSeconds,
                });
            } catch (error) {
                return res.status(error.status || 400).json({ error: error.message });
            }
            cls.onlineExamConfigs[examKey] = applicationToOnlineConfig(application, currentConfig);
            const active = ACTIVE_APPLICATION_STATUSES.has(application.status);
            if (!cls.releasedItems) cls.releasedItems = {};
            cls.releasedItems[examKey] = active;
            cls.activeExamKey = active ? examKey : (cls.activeExamKey === examKey ? null : cls.activeExamKey);
            cls.activeApplicationId = active ? application.id : (cls.activeApplicationId === application.id ? null : cls.activeApplicationId);
            db.save();
            return res.json({ success: true, application, config: cls.onlineExamConfigs[examKey] });
        }
        const actionStartsExam = action === 'running' || action === 'waiting';
        const hasPreparedSnapshot = currentConfig.activeHistoryId
            && Array.isArray(currentConfig.versionSnapshots)
            && currentConfig.versionSnapshots.length > 0;
        if (actionStartsExam && !hasPreparedSnapshot) {
            return res.status(400).json({
                error: 'Prepare a prova online a partir do histórico antes de iniciar pelo Monitor.'
            });
        }
        const previousStatus = currentConfig.status;
        const now = Date.now();
        if (action === 'adjust_waiting' && previousStatus !== 'waiting') {
            return res.status(409).json({ error: 'A prova não está em sala de espera.' });
        }
        currentConfig.status = action === 'adjust_waiting' ? 'waiting' : action;
        // NÃO altera updatedAt em ações de controle. updatedAt é a "versão de CONTEÚDO"
        // da prova; mudá-la ao pausar/iniciar/encerrar faz o aluno ver "O professor
        // atualizou a prova" e recarregar à toa (e pode até bloquear o envio). O status
        // já é propagado pelo próprio campo .status no polling do aluno.

        if (action === 'adjust_waiting') {
            const adjustmentSeconds = Number(req.body.adjustmentSeconds);
            if (!Number.isFinite(adjustmentSeconds)) {
                return res.status(400).json({ error: 'Ajuste de tempo inválido.' });
            }
            const currentStart = Number(currentConfig.startTime) || now;
            currentConfig.startTime = Math.max(now, currentStart + (adjustmentSeconds * 1000));
            const waitingStartedAt = Number(currentConfig.waitingRoomStartTimestamp) || now;
            currentConfig.waitingRoomStartTimestamp = waitingStartedAt;
            currentConfig.waitingRoomDuration = Math.max(0, Math.ceil((currentConfig.startTime - waitingStartedAt) / 1000));
        } else if (action === 'running') {
            currentConfig.onlineActive = true;
            if (!currentConfig.startTime || previousStatus === 'waiting' || currentConfig.startTime > now) {
                currentConfig.startTime = now;
            }
            currentConfig.waitingRoomStartTimestamp = null;
            cls.activeExamKey = examKey;
        } else if (action === 'waiting') {
            currentConfig.onlineActive = true;
            cls.activeExamKey = examKey;
            const waitSeconds = Number(req.body.waitingRoomDuration);
            currentConfig.waitingRoomDuration = Number.isFinite(waitSeconds) && waitSeconds >= 0
                ? waitSeconds
                : (Number.isFinite(Number(currentConfig.waitingRoomDuration))
                    ? Number(currentConfig.waitingRoomDuration)
                    : DEFAULT_WAITING_ROOM_MINUTES * 60);
            currentConfig.waitingRoomStartTimestamp = now;
            currentConfig.startTime = currentConfig.waitingRoomStartTimestamp + (currentConfig.waitingRoomDuration * 1000);
        } else if (action === 'paused') {
            currentConfig.onlineActive = true;
            cls.activeExamKey = examKey;
        } else if (action === 'finished') {
            currentConfig.onlineActive = false;
            cls.activeExamKey = null;
            currentConfig.waitingRoomStartTimestamp = null;
        } else if (action === 'not_applied' || action === 'prepared') {
            currentConfig.onlineActive = false;
            currentConfig.startTime = null;
            currentConfig.waitingRoomStartTimestamp = null;
            if (cls.activeExamKey === examKey) {
                cls.activeExamKey = null;
            }
        }

        db.save();
        res.json({ success: true, config: currentConfig });
    });
});

// Retorno do "+N min" da turma: entregas do fim do tempo reabertas com o tempo extra
// (e quantas delas voltaram bloqueadas por perda de foco) e quem já tinha entregue e
// ficou sem ele (fim do tempo fora da janela ou nota publicada, e quem enviou por conta
// própria depois que o tempo dele tinha acabado).
function classExtraTimeResult(reopened, deliveredAtDeadline = 0) {
    if (!reopened) return { success: true, reopenedAtDeadline: 0, reopenedLocked: 0, deliveredAtDeadline, deliveredByStudent: 0 };
    return {
        success: true,
        reopenedAtDeadline: reopened.reopened.length,
        reopenedLocked: reopened.reopenedLocked,
        deliveredAtDeadline: reopened.deadlineKept,
        deliveredByStudent: reopened.manualKept,
    };
}

// 2. Adiciona ou subtrai minutos de um aluno específico ou de toda a turma
router.post('/api/admin/adjust-student-time', (req, res) => {
    validateAdmin(req, res, () => {
        const { studentClass, courseId, examKey, applicationId, targetEmail, adjustmentMinutes } = req.body;
        if (!studentClass || !examKey || typeof adjustmentMinutes !== 'number') {
            return res.status(400).json({ error: 'Campos obrigatórios ausentes ou inválidos.' });
        }

        const scopedClass = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId);
        const application = findExamApplication(db.memory.examApplications, applicationId || scopedClass?.onlineExamConfigs?.[examKey]?.applicationId);
        if (applicationId && !application) return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });
        // Tempo extra para um aluno nunca reabre tentativa vencida: ela é entregue (respostas
        // salvas) antes do ajuste. No ajuste da TURMA, quem foi entregue automaticamente no
        // fim do tempo há até 2 min volta para a prova com o tempo extra (reopenDeadlineDeliveries);
        // o professor fica sabendo quantos voltaram e quantos ficaram sem o extra.
        let deliveredAtDeadline = 0;
        let reopened = null;
        if (application) {
            const settled = settleExpiredAttempts(db.memory, {
                applicationId: application.id,
                studentEmail: targetEmail ? targetEmail.trim().toLowerCase() : null,
                graceMs: 0,
            });
            if (targetEmail && settled.finalized.length) {
                db.save();
                return res.status(409).json({
                    error: 'O tempo deste aluno já tinha terminado. A tentativa foi entregue automaticamente com as respostas salvas.',
                    attemptFinalized: true,
                });
            }
            deliveredAtDeadline = settled.finalized.length;
        }

        if (targetEmail) {
            const email = targetEmail.trim().toLowerCase();
            // Aluno que já entregou todas as tentativas: o ajuste não teria efeito nenhum.
            if (application && deliveredWithoutAttemptsLeft(db.memory, application, email)) {
                return res.status(409).json({
                    error: 'Este aluno já entregou a prova. O tempo extra não tem efeito.',
                    alreadyDelivered: true,
                });
            }
            const openAttempt = application
                ? findOpenAttemptState(db.memory.studentExamState, { applicationId: application.id, studentEmail: email })
                : null;
            const key = openAttempt?.key || examStateKey({ studentEmail: email, examKey: examKey.trim() });
            if (application) {
                if (!application.studentAdjustments) application.studentAdjustments = {};
                application.studentAdjustments[email] = Number(application.studentAdjustments[email] || 0) + adjustmentMinutes;
            }
            if (application && !openAttempt) {
                // Ainda sem tentativa aberta: o ajuste fica na aplicação e entra na
                // tentativa quando ela for criada (sem estado avulso fora da aplicação).
                db.save();
                return res.json({ success: true, appliesToNextAttempt: true });
            }
            if (!db.memory.studentExamState[key]) {
                db.memory.studentExamState[key] = {
                    studentEmail: email,
                    examKey: examKey.trim(),
                    answers: {},
                    timerRemaining: null,
                    assignedVersion: 'A',
                    individualTimeAdjustment: 0
                };
            }
            db.memory.studentExamState[key].individualTimeAdjustment += adjustmentMinutes;
            if (db.memory.studentExamState[key].timerRemaining !== null) {
                db.memory.studentExamState[key].timerRemaining += (adjustmentMinutes * 60);
            }
        } else {
            const classes = db.memory.classes;
            const cls = findClassByNameAndCourse(classes, studentClass, courseId);
            if (!cls) {
                return res.status(404).json({ error: 'Turma não encontrada.' });
            }
            if (!cls.onlineExamConfigs) cls.onlineExamConfigs = {};
            if (!cls.onlineExamConfigs[examKey]) {
                cls.onlineExamConfigs[examKey] = {
                    status: 'not_applied',
                    startTime: null,
                    durationMinutes: DEFAULT_ONLINE_DURATION_MINUTES,
                    globalTimeAdjustment: 0,
                    waitingRoomDuration: DEFAULT_WAITING_ROOM_MINUTES * 60
                };
            }
            cls.onlineExamConfigs[examKey].globalTimeAdjustment += adjustmentMinutes;
            if (application) {
                application.globalTimeAdjustment = Number(application.globalTimeAdjustment || 0) + adjustmentMinutes;
                cls.onlineExamConfigs[examKey] = applicationToOnlineConfig(application, cls.onlineExamConfigs[examKey]);
                if (adjustmentMinutes > 0) {
                    reopened = reopenDeadlineDeliveries(db.memory, application, { actor: req.adminAccount?.email || 'Administrador', extraMinutes: adjustmentMinutes });
                }
            }
        }

        db.save();
        res.json(targetEmail ? { success: true } : classExtraTimeResult(reopened, deliveredAtDeadline));
    });
});

// 3. Atribui uma versão específica de prova (A, B, C...) a um aluno em tempo real
router.post('/api/admin/assign-student-version', (req, res) => {
    validateAdmin(req, res, () => {
        const { studentEmail, examKey, applicationId, version } = req.body;
        if (!studentEmail || !examKey || !version) {
            return res.status(400).json({ error: 'E-mail, exame e versão são obrigatórios.' });
        }

        const email = studentEmail.trim().toLowerCase();
        const application = findExamApplication(db.memory.examApplications, applicationId);
        if (applicationId && !application) return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });
        const openAttempt = application
            ? findOpenAttemptState(db.memory.studentExamState, { applicationId: application.id, studentEmail: email })
            : null;
        const key = openAttempt?.key || examStateKey({ studentEmail: email, examKey: examKey.trim() });
        if (application) {
            if (!application.studentVersions) application.studentVersions = {};
            application.studentVersions[email] = version.trim().toUpperCase();
        }
        if (!db.memory.studentExamState[key]) {
            db.memory.studentExamState[key] = {
                studentEmail: email,
                examKey: examKey.trim(),
                answers: {},
                timerRemaining: null,
                assignedVersion: 'A',
                individualTimeAdjustment: 0
            };
        }
        db.memory.studentExamState[key].assignedVersion = version.trim();
        db.memory.studentExamState[key].versionAssigned = true; // trava: o sorteio automático não sobrescreve a escolha manual
        db.save();
        res.json({ success: true });
    });
});

// 3.1. Desbloqueia a tela de um aluno travada por perda de foco
router.post('/api/admin/unlock-student-focus', (req, res) => {
    validateAdmin(req, res, (config, currentAdmin) => {
        const { studentEmail, studentClass, courseId, examKey, applicationId } = req.body;
        if (!studentEmail || !examKey) {
            return res.status(400).json({ error: 'E-mail do aluno e prova são obrigatórios.' });
        }

        const email = studentEmail.trim().toLowerCase();
        const normalizedExamKey = examKey.trim();
        const scopedClass = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId);
        const application = findExamApplication(db.memory.examApplications, applicationId || scopedClass?.onlineExamConfigs?.[normalizedExamKey]?.applicationId);
        if (applicationId && !application) return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });
        const openAttempt = application
            ? findOpenAttemptState(db.memory.studentExamState, { applicationId: application.id, studentEmail: email })
            : null;
        const key = openAttempt?.key || examStateKey({ studentEmail: email, examKey: normalizedExamKey });
        if (!db.memory.studentExamState[key]) {
            db.memory.studentExamState[key] = {
                studentEmail: email,
                examKey: normalizedExamKey,
                answers: {},
                timerRemaining: null,
                assignedVersion: 'A',
                individualTimeAdjustment: 0
            };
        }

        db.memory.studentExamState[key].focusLocked = false;
        db.memory.studentExamState[key].focusUnlockedAt = Date.now();
        db.memory.studentExamState[key].focusUnlockedBy = currentAdmin ? currentAdmin.email : null;
        delete db.memory.studentExamState[key].pageExit;

        db.memory.proctoringLogs.push({
            id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
            studentEmail: email,
            studentClass: studentClass ? studentClass.trim() : '',
            courseId: courseId || null,
            examKey: normalizedExamKey,
            applicationId: application?.id || null,
            attemptId: db.memory.studentExamState[key].attemptId || null,
            timestamp: Date.now(),
            eventType: 'focus_unlocked',
            details: `Tela desbloqueada pelo instrutor${currentAdmin && currentAdmin.email ? ` (${currentAdmin.email})` : ''}`
        });

        db.save();
        const { localCopyKey, ...unlockedState } = db.memory.studentExamState[key];
        res.json({ success: true, state: unlockedState });
    });
});

// 4. Envia mensagem pop-up para a turma ou aluno individual
router.post('/api/admin/send-broadcast-message', (req, res) => {
    validateAdmin(req, res, () => {
        const { studentClass, courseId, examKey, applicationId, targetEmail, messageText } = req.body;
        if (!studentClass || !messageText) {
            return res.status(400).json({ error: 'Turma e texto da mensagem são obrigatórios.' });
        }

        const message = {
            id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 5),
            studentClass: studentClass.trim(),
            courseId: courseId || null,
            examKey: examKey || null,
            applicationId: applicationId || null,
            targetEmail: targetEmail ? targetEmail.trim().toLowerCase() : null,
            messageText: messageText.trim(),
            timestamp: Date.now(),
            createdAt: new Date().toISOString(),
            senderEmail: (req.adminAccount && req.adminAccount.email) || null,
            acknowledgedBy: [],
            deletedFor: [],
            adminDeleted: false,
            status: 'pending'
        };
        db.memory.broadcastMessages.push(message);

        db.save();
        res.json({ success: true, message });
    });
});

router.get('/api/admin/message-history', (req, res) => {
    validateAdmin(req, res, () => {
        const studentClass = (req.query.studentClass || '').trim();
        const courseId = (req.query.courseId || '').trim();
        const examKey = (req.query.examKey || '').trim();
        const applicationId = (req.query.applicationId || '').trim();
        const targetEmail = (req.query.targetEmail || '').trim().toLowerCase();
        const messages = (db.memory.broadcastMessages || [])
            .filter(m => !m.adminDeleted)
            .filter(m => !studentClass || String(m.studentClass || '').toLowerCase() === studentClass.toLowerCase())
            .filter(m => !courseId || !m.courseId || String(m.courseId) === courseId)
            .filter(m => !examKey || !m.examKey || String(m.examKey) === examKey)
            .filter(m => !applicationId || m.applicationId === applicationId)
            .filter(m => !targetEmail || !m.targetEmail || String(m.targetEmail).toLowerCase() === targetEmail)
            .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
        res.json({ success: true, messages });
    });
});

router.post('/api/admin/message-history/delete', (req, res) => {
    validateAdmin(req, res, () => {
        const { messageId, studentClass, courseId, examKey, applicationId } = req.body || {};
        let count = 0;
        (db.memory.broadcastMessages || []).forEach(m => {
            const match = messageId
                ? m.id === messageId
                : (!studentClass || String(m.studentClass || '').toLowerCase() === String(studentClass).trim().toLowerCase())
                    && (!courseId || !m.courseId || String(m.courseId) === String(courseId))
                    && (!examKey || !m.examKey || String(m.examKey) === String(examKey))
                    && (!applicationId || m.applicationId === applicationId);
            if (match && !m.adminDeleted) {
                m.adminDeleted = true;
                m.adminDeletedAt = new Date().toISOString();
                count++;
            }
        });
        db.save();
        res.json({ success: true, deleted: count });
    });
});

// Alunos cuja tentativa em andamento foi desconsiderada no encerramento da aplicação:
// os listados na decisão (encerramentos desta versão) e as tentativas que versões
// antigas deixaram e o servidor registrou como desconsideradas (discardedAtFinish).
function discardedAttemptEmails(application) {
    const emails = new Set();
    [application.finishResolution, ...(Array.isArray(application.previousFinishResolutions) ? application.previousFinishResolutions : [])]
        .filter(resolution => resolution && resolution.policy === 'discard' && Array.isArray(resolution.discardedAttempts))
        .forEach(resolution => resolution.discardedAttempts.forEach(item => {
            if (item?.studentEmail) emails.add(String(item.studentEmail).trim().toLowerCase());
        }));
    Object.values(db.memory.studentExamState || {}).forEach(state => {
        if (state && state.applicationId === application.id && state.discardedAtFinish === true) {
            emails.add(String(state.studentEmail || '').trim().toLowerCase());
        }
    });
    return emails;
}

// 5. Retorna o status de monitoramento em tempo real de todos os estudantes
router.get('/api/admin/monitor-status/:class/:examKey', (req, res) => {
    validateAdmin(req, res, () => {
        const studentClass = req.params.class.trim();
        const examKey = req.params.examKey.trim();
        const courseId = req.query.courseId;
        const cls = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId)
            || (db.memory.classes || []).find(c => c.name && c.name.toLowerCase() === studentClass.toLowerCase());
        const currentConfig = (cls && cls.onlineExamConfigs && cls.onlineExamConfigs[examKey]) || {};
        const application = findExamApplication(db.memory.examApplications, req.query.applicationId || currentConfig.applicationId);
        if (req.query.applicationId && !application) return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });
        // Mesma varredura do servidor: tentativa vencida há mais que o atraso normal vira entrega.
        if (application && settleExpiredAttempts(db.memory, { applicationId: application.id }).changed) db.save();
        const monitorNow = Date.now();
        // "Tempo esgotado: entrega automática em instantes" só existe com a aplicação em
        // andamento. Encerrada, quem teve a tentativa desconsiderada aparece assim, de
        // forma estável (inclusive as sobras de versões antigas).
        const applicationActive = !application || ACTIVE_APPLICATION_STATUSES.has(application.status);
        const discardedEmails = applicationActive ? new Set() : discardedAttemptEmails(application);

        // Um único aluno com a turma gravada em formato inesperado não pode derrubar o
        // Monitor de todas as turmas (DES-03): a leitura passa pelo helper normalizado.
        const monitorCourseId = String((cls && cls.courseId) || courseId || '').trim();
        const students = (db.memory.students || []).filter(s => s && s.email && studentInClass(s, studentClass, monitorCourseId));

        const monitorList = students.map(s => {
            const email = s.email.toLowerCase();
            const openAttempt = application
                ? findOpenAttemptState(db.memory.studentExamState, { applicationId: application.id, studentEmail: email })
                : null;
            const stateKey = openAttempt?.key || examStateKey({ studentEmail: email, examKey });
            const state = openAttempt?.state || db.memory.studentExamState[stateKey] || {
                answers: {},
                timerRemaining: null,
                assignedVersion: 'A',
                individualTimeAdjustment: 0
            };

            const session = db.memory.sessions[email];
            const isOnline = isStudentSessionOnline(session);
            
            // Entrega mais recente do aluno nesta aplicação (a que o professor precisa ver).
            const submission = db.memory.submissions.filter(sub =>
                (sub.studentEmail ? sub.studentEmail.toLowerCase() : ((sub.student && sub.student.email) ? sub.student.email.toLowerCase() : '')) === email && 
                sub.examKey && sub.examKey.toLowerCase() === examKey.toLowerCase() &&
                (application ? sub.applicationId === application.id : true)
            ).sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))[0];
            const timing = application && state.startedAt && !submission
                ? attemptOverdueMs(state, application, monitorNow)
                : null;

            const studentLogs = db.memory.proctoringLogs.filter(l =>
                l.studentEmail.toLowerCase() === email &&
                l.examKey.toLowerCase() === examKey.toLowerCase() &&
                (application ? l.applicationId === application.id : true)
            );

            const studentKeystrokes = (db.memory.examKeystrokes || []).filter(k =>
                k.studentEmail.toLowerCase() === email &&
                k.examKey.toLowerCase() === examKey.toLowerCase() &&
                (application ? k.applicationId === application.id : true)
            );
            const keystrokeCount = studentKeystrokes.length;
            const suspiciousCount = studentKeystrokes.filter(k => k.suspicious || k.blocked).length;
            const lastKeystrokeAt = keystrokeCount
                ? Math.max(...studentKeystrokes.map(k => Number(k.serverTs) || 0))
                : null;

            let status = 'absent';
            if (submission) {
                status = 'finished';
            } else if (discardedEmails.has(email)) {
                status = 'discarded';
            } else if (applicationActive && timing && timing.overdueMs !== null && timing.overdueMs >= 0) {
                // Prazo esgotado: a entrega automática chega em instantes (navegador ou servidor).
                status = 'time_over';
            } else if (state.focusLocked === true) {
                status = 'focus_locked';
            } else if (isOnline) {
                const sortedLogs = [...studentLogs].sort((a, b) => b.timestamp - a.timestamp);
                const lastLog = sortedLogs[0];
                if (lastLog && ['tab_blur', 'exam_left'].includes(lastLog.eventType)) {
                    status = 'blur';
                } else {
                    status = 'online';
                }
            }

            let progress = '0/0';
            const evaluation = db.memory.evaluations[examKey];
            if (evaluation && evaluation.questions) {
                const snapshotCount = Array.isArray(currentConfig.versionSnapshots) && currentConfig.versionSnapshots[0] && Array.isArray(currentConfig.versionSnapshots[0].questions)
                    ? currentConfig.versionSnapshots[0].questions.length
                    : 0;
                const totalQuestions = Number(currentConfig.questionCount) || snapshotCount || evaluation.questions.length;
                // Entregue: quantas questões o aluno de fato respondeu (a entrega do fim do
                // tempo pode ter menos respostas que questões).
                const answeredQuestions = submission
                    ? (Number.isFinite(Number(submission.answeredCount)) && submission.answeredCount !== null
                        ? Number(submission.answeredCount)
                        : (Array.isArray(submission.gradedAnswers)
                            ? countAnswers(Object.fromEntries(submission.gradedAnswers.map(item => [item.questionNumber, item.studentChoice])))
                            : 0))
                    : Object.keys(state.answers || {}).length;
                const questionsInAttempt = submission ? (Number(submission.totalCount) || totalQuestions) : totalQuestions;
                progress = `${answeredQuestions}/${questionsInAttempt}`;
            }

            let timerRemaining = state.timerRemaining;
            if (timing && timing.deadlineAt !== null) {
                // Prazo efetivo: durante a pausa da aplicação o tempo fica congelado.
                timerRemaining = Math.max(0, Math.ceil((timing.deadlineAt - monitorNow) / 1000));
            } else if (status !== 'finished' && Number(state.deadlineAt) > 0) {
                timerRemaining = Math.max(0, Math.ceil((Number(state.deadlineAt) - Date.now()) / 1000));
            } else if (
                timerRemaining === null
                && status !== 'finished'
                && currentConfig.onlineActive === true
                && currentConfig.startTime
                && Number(currentConfig.durationMinutes) > 0
            ) {
                const elapsedSeconds = Math.max(0, Math.floor((Date.now() - Number(currentConfig.startTime)) / 1000));
                const totalSeconds = (Number(currentConfig.durationMinutes) * 60)
                    + (Number(currentConfig.globalTimeAdjustment || 0) * 60)
                    + (Number(state.individualTimeAdjustment || 0) * 60);
                timerRemaining = Math.max(0, totalSeconds - elapsedSeconds);
            }

            return {
                email: s.email,
                name: s.name,
                ip: session ? session.ip : '',
                status,
                assignedVersion: state.assignedVersion,
                timerRemaining,
                progress,
                focusLocked: state.focusLocked === true,
                focusLockedAt: state.focusLockedAt || null,
                focusLockReason: state.focusLockReason || '',
                applicationId: application?.id || null,
                attemptId: state.attemptId || submission?.attemptId || null,
                submissionSource: submission?.submissionSource || null,
                lateBySeconds: Number(submission?.lateBySeconds || 0),
                focusLockedAtDeadline: submission?.focusLockedAtDeadline === true,
                recoveredAfterFinish: submission?.recoveredAfterFinish === true,
                // Reaberta pelo "+N min" da turma depois da entrega do fim do tempo (tentativa
                // em andamento ou a entrega que veio dela) e entrega do fim do tempo que voltou
                // porque o tempo extra foi desconsiderado no encerramento.
                reopenedAt: submission
                    ? (submission.reopenedAt || null)
                    : (Number(state.reopenedAt) > 0 ? new Date(Number(state.reopenedAt)).toISOString() : null),
                restoredAfterDiscard: !!submission?.restoredAfterDiscard,
                // Aparelho sem tela cheia (iPhone): a prova abriu sem exigi-la (UXA-02).
                fullscreenUnsupported: studentLogs.some(log => log.eventType === 'fullscreen_unsupported'),
                logs: studentLogs,
                keystrokeCount,
                suspiciousCount,
                lastKeystrokeAt
            };
        });

        res.json(monitorList);
    });
});

// 5b. Retorna a prova corrente de UM aluno com respostas + gabarito (correção ao vivo).
// Funciona tanto para prova em andamento (state.answers) quanto finalizada (submission.gradedAnswers).
router.get('/api/admin/monitor-review/:class/:examKey', (req, res) => {
    validateAdmin(req, res, () => {
        const studentClass = req.params.class.trim();
        const examKey = req.params.examKey.trim();
        const courseId = req.query.courseId;
        const studentEmail = String(req.query.studentEmail || '').trim().toLowerCase();
        if (!studentEmail) return res.status(400).json({ error: 'studentEmail é obrigatório.' });

        const cls = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId)
            || (db.memory.classes || []).find(c => c.name && c.name.toLowerCase() === studentClass.toLowerCase());
        const currentConfig = (cls && cls.onlineExamConfigs && cls.onlineExamConfigs[examKey]) || {};
        const application = findExamApplication(db.memory.examApplications, req.query.applicationId || currentConfig.applicationId);
        if (req.query.applicationId && !application) return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });

        const student = db.memory.students.find(s => s.email && s.email.toLowerCase() === studentEmail);
        if (!student) return res.status(404).json({ error: 'Aluno não encontrado.' });
        // Escopo do professor: além da turma da URL, o aluno pedido precisa estar nas turmas dele.
        if (!adminCanAccessStudent(req.adminAccount, student) || (cls && !adminCanAccessClass(req.adminAccount, cls.name, cls.courseId))) {
            return res.status(403).json({ error: 'O aluno solicitado não pertence às turmas atribuídas a esta conta.' });
        }

        const openAttempt = application
            ? findOpenAttemptState(db.memory.studentExamState, { applicationId: application.id, studentEmail })
            : null;
        const stateKey = openAttempt?.key || examStateKey({ studentEmail, examKey });
        const state = openAttempt?.state || db.memory.studentExamState[stateKey] || { answers: {}, assignedVersion: 'A' };

        const submission = db.memory.submissions.find(sub =>
            (sub.studentEmail ? sub.studentEmail.toLowerCase() : ((sub.student && sub.student.email) ? sub.student.email.toLowerCase() : '')) === studentEmail &&
            sub.examKey && sub.examKey.toLowerCase() === examKey.toLowerCase() &&
            (application ? sub.applicationId === application.id : true)
        );

        const assignedVersion = String((submission && submission.assignedVersion) || state.assignedVersion || 'A').toUpperCase();

        // Prova em andamento: usa o MESMO motor da nota final (questões atribuídas,
        // anulações e substituições), para que "certa/errada" aqui bata com a correção.
        const liveGrade = !submission
            ? gradeAttempt({ application, onlineConfig: currentConfig, state, evaluation: db.memory.evaluations?.[examKey], answers: state.answers || {} })
            : null;

        // Resolve o snapshot da versão do aluno (questões + alternativas).
        const versionSnapshots = Array.isArray(currentConfig.versionSnapshots) ? currentConfig.versionSnapshots : [];
        let snapshot = null;
        if (submission && submission.examSnapshot && Array.isArray(submission.examSnapshot.questions)) {
            snapshot = submission.examSnapshot;
        } else if (liveGrade && liveGrade.examSnapshot && Array.isArray(liveGrade.examSnapshot.questions) && liveGrade.examSnapshot.questions.length) {
            snapshot = liveGrade.examSnapshot;
        } else {
            snapshot = versionSnapshots.find(s => String(s.version || 'A').toUpperCase() === assignedVersion) || versionSnapshots[0] || null;
        }
        let questions = snapshot && Array.isArray(snapshot.questions) ? snapshot.questions : [];

        // Fallback: prova finalizada sem snapshot — sintetiza a partir das respostas corrigidas.
        if (questions.length === 0 && submission && Array.isArray(submission.gradedAnswers)) {
            questions = submission.gradedAnswers.map(a => ({
                originalNumber: a.questionNumber, number: a.questionNumber,
                text: `Questão ${a.questionNumber}`, alternatives: []
            }));
        }

        function getCorrectAnswer(question) {
            if (question.correctAnswer) return String(question.correctAnswer).toUpperCase();
            const correctAlt = (question.alternatives || []).find(alt => alt.isCorrect);
            return correctAlt && correctAlt.letter ? String(correctAlt.letter).toUpperCase() : '';
        }

        const gradedByNumber = new Map(
            (submission ? (submission.gradedAnswers || []) : (liveGrade ? liveGrade.gradedAnswers : []))
                .map(a => [Number(a.questionNumber), a])
        );
        const answers = state.answers || {};
        // Tentativa (ou entrega) que diz quais letras o aluno viu na tela (AVA-05). Quem
        // ainda não abriu a prova vai vê-la com as letras da posição.
        const labelsRecord = submission || (state.attemptId || state.startedAt
            ? { ...state, alternativeLabels: state.alternativeLabels || 'original' }
            : { alternativeLabels: application ? 'position' : 'original' });

        const reviewQuestions = questions.map((question, index) => {
            const questionNumber = Number(question.originalNumber || question.number || index + 1);
            let studentChoice = null;
            let correctAnswer = null;
            let isCorrect = false;

            const graded = gradedByNumber.get(questionNumber);
            if (graded) {
                studentChoice = graded.studentChoice ? String(graded.studentChoice).toUpperCase() : null;
                correctAnswer = graded.correctAnswer ? String(graded.correctAnswer).toUpperCase() : null;
                isCorrect = graded.isCorrect === true;
            } else if (submission) {
                correctAnswer = getCorrectAnswer(question) || null;
            } else {
                const rawChoice = answers[question.number] != null ? answers[question.number]
                    : (answers[questionNumber] != null ? answers[questionNumber] : null);
                studentChoice = rawChoice != null ? String(rawChoice).toUpperCase() : null;
                correctAnswer = getCorrectAnswer(question) || null;
                isCorrect = !!studentChoice && studentChoice === correctAnswer;
            }

            const rawAlternatives = Array.isArray(question.alternatives)
                ? question.alternatives
                : Object.entries(question.alternatives || {}).map(([letter, text]) => ({ letter, text }));

            return {
                position: index + 1,
                questionNumber,
                text: question.questionText || question.text || `Questão ${questionNumber}`,
                studentChoice,
                correctAnswer,
                // Letras como o aluno viu (AVA-05); studentChoice/correctAnswer são as originais.
                studentChoiceSeen: seenLetterFor(labelsRecord, { alternatives: rawAlternatives }, studentChoice),
                correctAnswerSeen: seenLetterFor(labelsRecord, { alternatives: rawAlternatives }, correctAnswer),
                isCorrect,
                annulled: !!(graded && graded.annulled),
                annulmentMode: (graded && graded.annulmentMode) || null,
                answered: !!studentChoice,
                alternatives: rawAlternatives.map((alternative, alternativeIndex) => {
                    const canonicalLetter = String(alternative.letter || String.fromCharCode(65 + alternativeIndex)).toUpperCase();
                    return {
                        // letter: a que o aluno viu na tela; canonicalLetter: a original (gabarito).
                        letter: seenAlternativeLetter(labelsRecord, alternative, alternativeIndex),
                        canonicalLetter,
                        text: alternative.text ?? alternative.label ?? String(alternative),
                        selectedByStudent: canonicalLetter === studentChoice,
                        correct: canonicalLetter === correctAnswer || alternative.isCorrect === true,
                    };
                }),
            };
        });

        const answeredCount = reviewQuestions.filter(q => q.answered).length;
        const correctCount = reviewQuestions.filter(q => q.isCorrect).length;
        const totalCount = Number(currentConfig.questionCount) || reviewQuestions.length;
        // Quem já iniciou a tentativa (startedAt) está "em andamento" mesmo sem resposta.
        const status = submission ? 'finished' : ((answeredCount > 0 || state.startedAt) ? 'in_progress' : 'not_started');

        res.json({
            success: true,
            studentName: student.name,
            studentEmail: student.email,
            assignedVersion,
            alternativeLabels: alternativeLabelsMode(labelsRecord),
            examCode: (submission && submission.examSnapshot && submission.examSnapshot.examCode) || (snapshot && snapshot.examCode) || null,
            status,
            answeredCount,
            correctCount,
            totalCount,
            hasSnapshot: !!(snapshot && Array.isArray(snapshot.questions) && snapshot.questions.length > 0),
            questions: reviewQuestions,
        });
    });
});

// 6. Exporta as notas de uma prova da turma em CSV (Excel pt-BR: ";", BOM e nota
// 0 a 10 com vírgula). Escopo por curso/turma e pelas turmas do professor (UXI-01).
router.get('/api/admin/export-grades/:class/:examKey', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const studentClass = String(req.params.class || '').trim();
        const examKey = String(req.params.examKey || '').trim();
        const courseId = String(req.query.courseId || '').trim();
        const applicationId = String(req.query.applicationId || '').trim();
        if (!studentClass || !examKey) return res.status(400).json({ error: 'Turma e prova são obrigatórias.' });
        // Sem o curso, registros antigos sem curso de uma turma homônima de outro curso
        // entravam na planilha: o curso é obrigatório, como no quadro de notas.
        if (!courseId) return res.status(400).json({ error: 'Curso é obrigatório para exportar as notas.' });
        if (!adminCanAccessClass(matchedAdmin, studentClass, courseId)) return res.status(403).json({ error: 'Turma não autorizada para esta conta.' });

        const scoped = scopeSubmissionsToContext(filterSubmissionsForAdmin(db.memory.submissions || [], matchedAdmin), gradeScope(courseId, studentClass))
            .filter(sub => String(sub.examKey || '') === examKey && (!applicationId || sub.applicationId === applicationId));
        const submissions = enrichSubmissionsWithAttemptResult(scoped).sort((a, b) =>
            String(a.student?.name || a.studentName || '').localeCompare(String(b.student?.name || b.studentName || ''), 'pt-BR')
            || new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
        const title = examTitle(examKey, { evaluations: db.memory.evaluations, examIndex: structureExamIndex(effectiveStructure(courseId, studentClass)?.structure || []) });
        const applicationsById = new Map((db.memory.examApplications || []).map(item => [String(item.id), item]));

        const header = ['Aluno', 'E-mail', 'Turma', 'Avaliação', 'Aplicação', 'Tentativa', 'Versão', 'Acertos', 'Questões', 'Nota da tentativa', 'Compõe a nota', 'Nota da aplicação', 'Publicada', 'Data de envio'];
        const rows = submissions.map(sub => [
            sub.studentName || sub.student?.name || '',
            sub.studentEmail || sub.student?.email || '',
            sub.studentClass || sub.student?.studentClass || studentClass,
            title,
            scopeLabel({ attempts: [sub] }, applicationsById),
            sub.attemptNumber || 1,
            sub.assignedVersion || sub.version || '',
            Number.isInteger(sub.correctCount) ? sub.correctCount : '',
            Number.isInteger(sub.totalCount) ? sub.totalCount : '',
            sub.scoreInvalid ? 'nota inválida' : formatGradeBR(sub.score),
            sub.resultStatus === 'archived' ? 'Desconsiderada' : (sub.countsTowardResult ? 'Sim' : 'Não'),
            formatGradeBR(sub.consolidatedScore),
            // Nota inválida não é mostrada ao aluno nem entra na média, mesmo marcada como publicada.
            sub.scoreInvalid ? 'Não (nota inválida)' : (sub.gradePublished === true ? 'Sim' : 'Não'),
            formatDateTimeBR(sub.timestamp || sub.submittedAt),
        ]);

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="notas_${safeFilePart(studentClass)}_${safeFilePart(examKey)}.csv"`);
        res.status(200).send(buildCsv([header, ...rows]));
    });
});

// Planilha de notas da turma (UXI-01, FUN-06): uma linha por aluno, uma coluna por
// prova e a média, com a mesma consolidação da tela Resultados. JSON para a tela
// e CSV (?format=csv) no padrão do Excel brasileiro.
router.get('/api/admin/gradebook', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const courseId = String(req.query.courseId || '').trim();
        const studentClass = String(req.query.studentClass || '').trim();
        if (!courseId || !studentClass) return res.status(400).json({ error: 'Curso e turma são obrigatórios.' });
        const cls = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId);
        if (!cls) return res.status(404).json({ error: 'Turma não encontrada neste curso.' });
        if (!adminCanAccessClass(matchedAdmin, studentClass, courseId)) return res.status(403).json({ error: 'Turma não autorizada para esta conta.' });

        const course = (db.memory.courses || []).find(item => String(item.id) === courseId) || null;
        const structure = effectiveStructure(courseId, studentClass)?.structure || course?.structure || [];
        const submissions = scopeSubmissionsToContext(filterSubmissionsForAdmin(db.memory.submissions || [], matchedAdmin), gradeScope(courseId, studentClass));
        const students = filterStudentsForAdmin(db.memory.students || [], matchedAdmin)
            .filter(student => studentBelongsToClass(student, studentClass, courseId));
        const gradebook = buildClassGradebook({
            students,
            submissions,
            structure,
            evaluations: db.memory.evaluations || {},
            applications: db.memory.examApplications || [],
        });

        if (String(req.query.format || '').toLowerCase() === 'csv') {
            const today = new Date();
            const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="planilha_notas_${safeFilePart(course?.name || courseId)}_${safeFilePart(studentClass)}_${stamp}.csv"`);
            return res.status(200).send(gradebookCsv(gradebook));
        }
        res.json({ courseId, courseName: course?.name || courseId, studentClass, generatedAt: Date.now(), ...gradebook });
    });
});

// 7. Relatório analítico por questão para apoiar revisão pedagógica
router.get('/api/admin/exam-analytics/:class/:examKey', (req, res) => {
    validateAdmin(req, res, () => {
        const studentClass = req.params.class.trim();
        const examKey = req.params.examKey.trim();
        const applicationId = String(req.query.applicationId || '').trim();
        const submissions = db.memory.submissions.filter(sub => {
            const subClass = sub.studentClass || (sub.student && sub.student.studentClass) || '';
            return sub.examKey === examKey
                && subClass.toLowerCase() === studentClass.toLowerCase()
                && (!applicationId || sub.applicationId === applicationId);
        });
        const proctoringLogs = (db.memory.proctoringLogs || []).filter(log =>
            log.examKey === examKey &&
            log.studentClass &&
            log.studentClass.toLowerCase() === studentClass.toLowerCase() &&
            (!applicationId || log.applicationId === applicationId)
        );
        const focusLossLogs = proctoringLogs.filter(log => ['tab_blur', 'exam_left'].includes(log.eventType));
        const focusUnlockLogs = proctoringLogs.filter(log => log.eventType === 'focus_unlocked');

        const byQuestion = {};
        const gradeBuckets = { baixo: 0, medio: 0, alto: 0 };

        // Nota inválida de registro antigo (vazia ou fora de 0 a 100) não entra nas faixas nem na média.
        const validScores = submissions.map(sub => normalizeScore(sub.score)).filter(score => score !== null);
        submissions.forEach(sub => {
            const score = normalizeScore(sub.score);
            if (score === null) { /* sem nota válida */ }
            else if (score < 60) gradeBuckets.baixo++;
            else if (score < 85) gradeBuckets.medio++;
            else gradeBuckets.alto++;

            (sub.gradedAnswers || []).forEach(answer => {
                const qn = String(answer.questionNumber);
                if (!byQuestion[qn]) {
                    byQuestion[qn] = {
                        questionNumber: Number(answer.questionNumber),
                        attempts: 0,
                        correct: 0,
                        wrong: 0,
                        choices: {}
                    };
                }
                byQuestion[qn].attempts++;
                if (answer.isCorrect) byQuestion[qn].correct++;
                else byQuestion[qn].wrong++;
                const choice = answer.studentChoice || 'em branco';
                byQuestion[qn].choices[choice] = (byQuestion[qn].choices[choice] || 0) + 1;
            });
        });

        const questions = Object.values(byQuestion)
            .sort((a, b) => a.questionNumber - b.questionNumber)
            .map(item => ({
                ...item,
                accuracyPercent: item.attempts > 0 ? Math.round((item.correct / item.attempts) * 100) : 0,
                difficulty: item.attempts === 0 ? 'sem dados' : (item.correct / item.attempts >= 0.75 ? 'baixa' : (item.correct / item.attempts >= 0.45 ? 'media' : 'alta'))
            }));

        res.json({
            success: true,
            studentClass,
            examKey,
            applicationId: applicationId || null,
            totalSubmissions: submissions.length,
            // Sem nota válida, a média fica vazia (o Monitor mostra "—", não 0,0).
            averageScore: validScores.length
                ? Math.round(validScores.reduce((sum, score) => sum + score, 0) / validScores.length)
                : null,
            validScoreCount: validScores.length,
            gradeBuckets,
            proctoringSummary: {
                totalFocusLosses: focusLossLogs.length,
                affectedStudents: [...new Set(focusLossLogs.map(log => log.studentEmail))].length,
                unlocks: focusUnlockLogs.length
            },
            questions
        });
    });
});

// 8. Banco centralizado de questões reutilizáveis
router.get('/api/admin/question-bank', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const questions = isProfessorAccount(matchedAdmin)
            ? (db.memory.questionBank || []).filter(question => !question.sourceExamKey || adminCanAccessItem(matchedAdmin, question.sourceExamKey))
            : (db.memory.questionBank || []);
        res.json({ success: true, questions });
    });
});

router.post('/api/admin/question-bank/create', (req, res) => {
    validateAdmin(req, res, () => {
        const { category, type, questionText, alternatives, correctAnswer, sourceExamKey, curriculumKey } = req.body;
        if (!questionText || String(questionText).trim() === '') {
            return res.status(400).json({ error: 'Texto da questão é obrigatório.' });
        }
        let normalizedQuestion;
        try {
            normalizedQuestion = normalizeEvaluationPayload({
                title: 'Banco de questões',
                questions: [{ text: questionText, alternatives, correctAnswer }],
            }).questions[0];
        } catch (error) {
            return res.status(error.status || 400).json({ error: error.message });
        }
        const item = {
            key: 'qb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
            category: category || 'Geral',
            curriculumKey: curriculumKey || '',
            type: type || 'multiple_choice',
            questionText: normalizedQuestion.text,
            alternatives: normalizedQuestion.alternatives,
            correctAnswer: normalizedQuestion.correctAnswer,
            sourceExamKey: sourceExamKey || null,
            createdAt: new Date().toISOString()
        };
        db.memory.questionBank.push(item);
        db.save();
        res.json({ success: true, question: item });
    });
});

router.post('/api/admin/question-bank/update', (req, res) => {
    validateAdmin(req, res, () => {
        const item = (db.memory.questionBank || []).find(question => question.key === req.body.key);
        if (!item) return res.status(404).json({ error: 'Questão não encontrada no banco.' });
        let normalizedQuestion;
        try {
            normalizedQuestion = normalizeEvaluationPayload({
                title: 'Banco de questões',
                questions: [{
                    text: req.body.questionText ?? item.questionText,
                    alternatives: req.body.alternatives ?? item.alternatives,
                    correctAnswer: req.body.correctAnswer ?? item.correctAnswer,
                }],
            }).questions[0];
        } catch (error) {
            return res.status(error.status || 400).json({ error: error.message });
        }
        item.questionText = normalizedQuestion.text;
        item.alternatives = normalizedQuestion.alternatives;
        item.correctAnswer = normalizedQuestion.correctAnswer;
        if (req.body.category !== undefined) item.category = String(req.body.category || 'Geral');
        if (req.body.curriculumKey !== undefined) item.curriculumKey = String(req.body.curriculumKey || '');
        item.updatedAt = new Date().toISOString();
        db.save();
        res.json({ success: true, question: item });
    });
});

router.post('/api/admin/question-bank/import-evaluation', (req, res) => {
    validateAdmin(req, res, () => {
        const { examKey, category, curriculumKey } = req.body;
        if (!examKey) return res.status(400).json({ error: 'examKey é obrigatório.' });

        const evaluation = db.memory.evaluations[examKey];
        const questions = evaluation && Array.isArray(evaluation.questions) ? evaluation.questions : [];
        if (questions.length === 0) {
            return res.status(404).json({ error: 'Avaliação não encontrada ou sem questões estruturadas.' });
        }

        const existingKeys = new Set((db.memory.questionBank || []).map(q => `${q.sourceExamKey}:${q.originalNumber}`));
        const imported = [];
        questions.forEach(question => {
            const originalNumber = Number(question.originalNumber || question.number || 0);
            const dedupeKey = `${examKey}:${originalNumber}`;
            if (existingKeys.has(dedupeKey)) return;
            const item = {
                key: 'qb_' + Date.now() + '_' + originalNumber + '_' + Math.random().toString(36).slice(2, 5),
                category: category || examKey.split('_')[1] || 'Geral',
                curriculumKey: curriculumKey || '',
                type: 'multiple_choice',
                sourceExamKey: examKey,
                originalNumber,
                questionText: question.text || '',
                alternatives: question.alternatives || [],
                correctAnswer: question.correctAnswer || '',
                createdAt: new Date().toISOString()
            };
            db.memory.questionBank.push(item);
            imported.push(item);
        });

        db.save();
        res.json({ success: true, importedCount: imported.length, questions: imported });
    });
});

router.post('/api/admin/question-bank/delete', (req, res) => {
    validateAdmin(req, res, () => {
        const { key } = req.body;
        if (!key) return res.status(400).json({ error: 'key é obrigatório.' });
        const before = db.memory.questionBank.length;
        db.memory.questionBank = db.memory.questionBank.filter(q => q.key !== key);
        db.save();
        res.json({ success: true, deleted: before - db.memory.questionBank.length });
    });
});

// ---- Escolas / Instituições (Fase I.1) ----
router.get('/api/admin/schools', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => { res.json(filterSchoolsForAdmin(db.memory.schools || [], matchedAdmin)); });
});
router.post('/api/admin/schools/create', (req, res) => {
    validateAdmin(req, res, () => {
        const name = (req.body.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Nome da escola é obrigatório.' });
        if (rejectInvalidBranding(res, req.body.branding || {})) return;
        if (!Array.isArray(db.memory.schools)) db.memory.schools = [];
        const school = {
            id: 'escola_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
            name,
            info: extractInstitutional(req.body.info || req.body),
            branding: extractBranding(req.body.branding || {}),
            createdAt: Date.now(),
        };
        db.memory.schools.push(school);
        db.save();
        res.json({ success: true, school });
    });
});
router.post('/api/admin/schools/update', (req, res) => {
    validateAdmin(req, res, () => {
        const id = (req.body.id || '').trim();
        const school = (db.memory.schools || []).find(s => s.id === id);
        if (!school) return res.status(404).json({ error: 'Escola não encontrada.' });
        if (req.body.branding !== undefined && rejectInvalidBranding(res, req.body.branding)) return;
        if (req.body.name !== undefined) school.name = String(req.body.name).trim();
        if (req.body.info !== undefined) school.info = { ...(school.info || {}), ...extractInstitutional(req.body.info) };
        if (req.body.branding !== undefined) school.branding = { ...(school.branding || {}), ...extractBranding(req.body.branding) };
        school.updatedAt = Date.now();
        db.save();
        res.json({ success: true, school });
    });
});
router.post('/api/admin/schools/delete', (req, res) => {
    validateAdmin(req, res, () => {
        const id = (req.body.id || '').trim();
        const schools = db.memory.schools || [];
        if (schools.length <= 1) return res.status(400).json({ error: 'Não é possível excluir a única escola.' });
        const school = schools.find(s => s.id === id);
        if (!school) return res.status(404).json({ error: 'Escola não encontrada.' });
        const inUse = (db.memory.courses || []).some(c => c.schoolId === id && !c.deleted);
        if (inUse) return res.status(400).json({ error: 'Escola em uso por cursos. Mova os cursos antes de excluir.' });
        db.memory.schools = schools.filter(s => s.id !== id);
        db.save();
        res.json({ success: true });
    });
});

// Visão geral de alunos para o Dashboard: frequência, faltas, média e risco. Escopo do professor aplicado.
router.get('/api/admin/dashboard/students-overview', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const courseId = (req.query.courseId || '').trim();
        const studentClass = (req.query.studentClass || '').trim();
        const scn = (st) => (Array.isArray(st.classes) && st.classes.length ? st.classes : (st.studentClass ? [st.studentClass] : [])).map(c => typeof c === 'string' ? c : (c && c.name)).filter(Boolean);
        let list = filterStudentsForAdmin(db.memory.students || [], matchedAdmin);
        if (courseId) {
            const clsNames = new Set((db.memory.classes || []).filter(c => c.courseId === courseId).map(c => c.name));
            list = list.filter(st => scn(st).some(nm => clsNames.has(nm)));
        }
        if (studentClass) list = list.filter(st => studentBelongsToClass(st, studentClass, courseId));
        // Índice montado uma vez por requisição: a tela de Alunos chama esta rota sem
        // filtro de curso, então sem ele o custo seria alunos × (presenças + submissões).
        const index = buildOverviewIndex(db.memory);
        const overview = list.map(st => ({
            email: st.email,
            name: (st.nomeSocial && st.nomeSocial.trim()) || st.name || st.email,
            className: studentClass || scn(st)[0] || '',
            ...studentOverview(db.memory, st, { courseId, index }),
        }));
        res.json(overview);
    });
});

// ---------------------------------------------------------------------------
// Dashboard v3 — três endpoints especializados, não um agregado: /now muda em
// segundos (poll de ~30s), /queue em minutos e /trends em dias. Um payload só
// obrigaria a recarregar tudo a cada poll. Escopo de professor aplicado a todos.
// ---------------------------------------------------------------------------
function _dashboardScope(req, matchedAdmin) {
    const courseId = String(req.query.courseId || '').trim();
    const studentClass = String(req.query.studentClass || '').trim();
    const cls = studentClass
        ? (findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId)
            || (db.memory.classes || []).find(c => c.name === studentClass) || null)
        : null;
    const course = (db.memory.courses || []).find(c => String(c.id) === courseId) || null;
    const scn = (st) => (Array.isArray(st.classes) && st.classes.length ? st.classes : (st.studentClass ? [st.studentClass] : [])).map(c => typeof c === 'string' ? c : (c && c.name)).filter(Boolean);
    let students = filterStudentsForAdmin(db.memory.students || [], matchedAdmin);
    if (courseId) {
        const clsNames = new Set((db.memory.classes || []).filter(c => c.courseId === courseId).map(c => c.name));
        students = students.filter(st => scn(st).some(nm => clsNames.has(nm)));
    }
    if (studentClass) students = students.filter(st => studentBelongsToClass(st, studentClass, courseId));
    return { courseId, studentClass, cls, course, students };
}

// Faixa "Agora": aula corrente da grade, aplicação de prova ativa e presença online.
router.get('/api/admin/dashboard/now', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const scope = _dashboardScope(req, matchedAdmin);
        const tz = settingsUtil.getSettings().timezone;
        res.json(computeNow({
            memory: db.memory, cls: scope.cls, course: scope.course, students: scope.students,
            today: settingsUtil.today(), nowMin: attendanceUtil.hhmmToMin(settingsUtil.nowHHMM(tz)), now: Date.now(),
        }));
    });
});

// Fila "Precisa de você": pendências com destino clicável. Respeita o snooze de
// 24h persistido em preferences (dashboard.snoozed) e esconde matrículas de professor.
router.get('/api/admin/dashboard/queue', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const scope = _dashboardScope(req, matchedAdmin);
        const now = Date.now();
        // 'page.accounts' é permissão exclusiva de administrador pleno — é o
        // proxy correto para "professor não vê matrículas" (ADMIN_ONLY_PERMISSION_SET).
        const canSeeMatriculas = canAccessAdminPermission(matchedAdmin, 'page.accounts');
        let items = computeQueue({
            memory: db.memory, cls: scope.cls, course: scope.course, students: scope.students,
            today: settingsUtil.today(), now, canSeeMatriculas,
        });
        const account = (db.memory.admins || []).find(a => a.email && matchedAdmin
            && a.email.toLowerCase() === String(matchedAdmin.email || '').toLowerCase());
        const snoozed = (account && account.preferences && account.preferences['dashboard.snoozed']) || {};
        items = items.filter(item => {
            const ts = Number(snoozed[item.id]);
            return !(Number.isFinite(ts) && now - ts < 86400000);
        });
        res.json(items);
    });
});

// Pulso: frequência, média e engajamento em janelas móveis de 30 dias com série.
// Sino do instrutor: reaproveita a fila "Precisa de você". Um item conta como
// novo até ser visto com o mesmo contador (id:count guardado nas preferências).
// Sino do instrutor (UXI-X2). Cada pendência é de um curso + turma: dentro de uma
// turma vêm só as dela; fora (modo instituição) vem uma linha por turma do escopo, com
// curso e turma para o painel abrir o workspace certo antes de navegar. "Lido" é
// guardado por curso + turma + item + contagem e é somado ao que já estava lido.
const NOTIFICATION_SEEN_LIMIT = 400;

function _notificationScopes(req, matchedAdmin) {
    const scope = _dashboardScope(req, matchedAdmin);
    if (scope.cls) return [scope];
    const courses = db.memory.courses || [];
    const allowedStudents = filterStudentsForAdmin(db.memory.students || [], matchedAdmin);
    return (db.memory.classes || [])
        .filter(cls => cls && cls.name && (!scope.courseId || String(cls.courseId) === scope.courseId))
        .filter(cls => adminCanAccessClass(matchedAdmin, cls.name, cls.courseId))
        .map(cls => {
            const course = courses.find(item => String(item.id) === String(cls.courseId)) || null;
            if (!course || isDeletedCourse(course)) return null;
            return {
                courseId: String(cls.courseId || ''), studentClass: cls.name, cls, course,
                students: allowedStudents.filter(student => studentBelongsToClass(student, cls.name, cls.courseId)),
            };
        })
        .filter(Boolean);
}

function _pendingEnrollmentsForClass(cls) {
    let count = 0;
    let at = 0;
    (db.memory.students || []).forEach(student => (student.enrollmentRequests || []).forEach(request => {
        if (request.status !== 'pending' || request.requestedClassName !== cls.name || String(request.courseId || '') !== String(cls.courseId || '')) return;
        count++;
        at = Math.max(at, Number(request.createdAt) || 0);
    }));
    return { count, at };
}

function _notificationSeenKey(courseId, studentClass, item) {
    return `${courseId}::${studentClass}::${item.id}:${item.count || 0}`;
}

router.get('/api/admin/notifications', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const scopes = _notificationScopes(req, matchedAdmin);
        const multiClass = !String(req.query.studentClass || '').trim();
        const canSeeMatriculas = canAccessAdminPermission(matchedAdmin, 'page.accounts');
        const account = (db.memory.admins || []).find(a => a.email && a.email.toLowerCase() === String(matchedAdmin.email || '').toLowerCase());
        const seen = new Set((account && account.preferences && account.preferences['notifications.seen']) || []);
        const today = settingsUtil.today();
        const now = Date.now();
        const items = [];
        scopes.forEach(scope => {
            const courseId = String(scope.courseId || (scope.cls && scope.cls.courseId) || '');
            const studentClass = String(scope.studentClass || (scope.cls && scope.cls.name) || '');
            // Matrículas pendentes são contadas pela turma pedida (o aluno pendente ainda
            // não está em `students` da turma).
            const queue = computeQueue({
                memory: db.memory, cls: scope.cls, course: scope.course, students: scope.students,
                today, now, canSeeMatriculas: false,
            });
            if (canSeeMatriculas && scope.cls) {
                const pending = _pendingEnrollmentsForClass(scope.cls);
                if (pending.count) {
                    queue.push({
                        id: 'matriculas', tipo: 'matriculas', titulo: 'Solicitações de matrícula pendentes',
                        detalhe: 'aguardando aprovação · Matrículas', count: pending.count, tone: 'early',
                        href: '/matriculas', permissao: 'page.students', at: pending.at || null,
                    });
                }
            }
            queue.filter(item => canAccessAdminPermission(matchedAdmin, item.permissao)).forEach(item => {
                const key = _notificationSeenKey(courseId, studentClass, item);
                const courseName = (scope.course && scope.course.name) || courseId;
                items.push({
                    id: `${item.id}@${courseId}::${studentClass}`,
                    type: item.tipo,
                    title: item.titulo,
                    text: item.detalhe || item.descricao || '',
                    // Modo instituição: curso e turma em linha própria, sem tomar o lugar da descrição.
                    context: multiClass ? [courseName, studentClass].filter(Boolean).join(' · ') : '',
                    count: item.count || 0,
                    tone: item.tone,
                    href: item.href,
                    at: Number(item.at) || null,
                    courseId, courseName, studentClass,
                    schoolId: (scope.course && scope.course.schoolId) || '',
                    period: (scope.cls && scope.cls.period) || '',
                    key,
                    unread: !seen.has(key),
                });
            });
        });
        const limited = items.slice(0, 40);
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, items: limited, unread: limited.filter(item => item.unread).length });
    });
});

router.post('/api/admin/notifications/seen', (req, res) => {
    validateAdmin(req, res, async (config, matchedAdmin) => {
        const account = (db.memory.admins || []).find(a => a.email && a.email.toLowerCase() === String(matchedAdmin.email || '').toLowerCase());
        if (!account) return res.status(404).json({ error: 'Conta não encontrada.' });
        // Só chaves no formato curso::turma::item:contagem; as antigas (item:contagem,
        // sem turma) marcavam como lida a pendência de outra turma e são descartadas.
        const keys = Array.isArray(req.body.keys)
            ? req.body.keys.map(String).filter(key => key.split('::').length === 3 && key.length <= 300).slice(0, 100)
            : [];
        const previous = ((account.preferences && account.preferences['notifications.seen']) || [])
            .map(String).filter(key => key.split('::').length === 3 && !keys.includes(key));
        account.preferences = { ...(account.preferences || {}), 'notifications.seen': [...previous, ...keys].slice(-NOTIFICATION_SEEN_LIMIT) };
        await db.save();
        res.json({ success: true });
    });
});

router.get('/api/admin/dashboard/trends', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const scope = _dashboardScope(req, matchedAdmin);
        res.json(computeTrends({ memory: db.memory, students: scope.students, course: scope.course, cls: scope.cls, now: Date.now() }));
    });
});


// Duplicar (clonar) curso para outra escola: copia independente de estrutura e conteudo.
router.post('/api/admin/courses/:id/clone', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        if (!canAccessAdminPermission(matchedAdmin, 'course.manage')) {
            return res.status(403).json({ error: 'Sua conta não possui permissão para esta operação.' });
        }
        const src = (db.memory.courses || []).find(c => c.id === req.params.id);
        if (!src) return res.status(404).json({ error: 'Curso de origem não encontrado.' });
        const newId = String(req.body.newId || '').trim().toUpperCase();
        const newName = String(req.body.newName || '').trim();
        const schoolId = req.body.schoolId || src.schoolId || 'escola_default';
        if (!newId || !newName) return res.status(400).json({ error: 'Informe ID e nome do novo curso.' });
        if ((db.memory.courses || []).some(c => c.id === newId)) return res.status(400).json({ error: 'Já existe um curso com esse ID.' });

        function copyContentFile(oldKey, newKey) {
            const oldP = path.join(runtimePaths.CONTENT_DIR, `${oldKey}.md`);
            const newP = path.join(runtimePaths.CONTENT_DIR, `${newKey}.md`);
            if (fs.existsSync(oldP)) { try { fs.copyFileSync(oldP, newP); } catch (e) {} }
        }
        if (!db.memory.evaluations) db.memory.evaluations = {};

        const materialKeyMap = new Map();
        const evaluationKeyMap = new Map();

        const cloneMaterialKey = (oldKey) => {
            if (!oldKey) return oldKey;
            if (materialKeyMap.has(oldKey)) return materialKeyMap.get(oldKey);
            const newKey = `${oldKey}_${newId}`;
            copyContentFile(oldKey, newKey);
            materialKeyMap.set(oldKey, newKey);
            return newKey;
        };

        const cloneEvaluationKey = (oldKey) => {
            if (!oldKey) return oldKey;
            if (evaluationKeyMap.has(oldKey)) return evaluationKeyMap.get(oldKey);
            const newKey = `${oldKey}_${newId}`;
            copyContentFile(oldKey, newKey);
            if (db.memory.evaluations[oldKey]) {
                const evaluation = JSON.parse(JSON.stringify(db.memory.evaluations[oldKey]));
                evaluation.key = newKey;
                evaluation.sourceEvaluationKey = evaluation.sourceEvaluationKey ? `${evaluation.sourceEvaluationKey}_${newId}` : undefined;
                db.memory.evaluations[newKey] = evaluation;
            }
            evaluationKeyMap.set(oldKey, newKey);
            return newKey;
        };

        const cloneModule = (mod) => {
            const m = JSON.parse(JSON.stringify(mod));
            const units = m.units || m.items || [];
            units.forEach((u) => {
                if (u.apostilaKey) u.apostilaKey = cloneMaterialKey(u.apostilaKey);
                if (u.avaliacaoKey) u.avaliacaoKey = cloneEvaluationKey(u.avaliacaoKey);
            });
            return m;
        };

        const newCourse = {
            ...JSON.parse(JSON.stringify(src)),
            id: newId,
            name: newName,
            schoolId,
            structure: (src.structure || []).map(cloneModule),
            status: 'active',
            deleted: false,
            deletedAt: null,
            clonedFrom: src.id,
        };
        db.memory.courses.push(newCourse);
        const clonedClasses = (db.memory.classes || []).filter(cls => String(cls.courseId) === String(src.id)).map(sourceClass => {
            const cloned = JSON.parse(JSON.stringify(sourceClass));
            cloned.courseId = newId;
            const sourceOverrides = ensureOverrides(sourceClass);
            const materialOverrides = {};
            Object.entries(sourceOverrides.materials).forEach(([baseKey, entry]) => {
                const variantKey = entry?.key || entry;
                materialOverrides[cloneMaterialKey(baseKey)] = { ...(typeof entry === 'object' ? entry : {}), key: cloneMaterialKey(variantKey) };
            });
            const evaluationOverrides = {};
            Object.entries(sourceOverrides.evaluations).forEach(([baseKey, entry]) => {
                const variantKey = entry?.key || entry;
                evaluationOverrides[cloneEvaluationKey(baseKey)] = { ...(typeof entry === 'object' ? entry : {}), key: cloneEvaluationKey(variantKey) };
            });
            const unitNames = {};
            Object.entries(sourceOverrides.unitNames || {}).forEach(([key, value]) => {
                unitNames[evaluationKeyMap.get(key) || materialKeyMap.get(key) || key] = value;
            });
            cloned.contentOverrides = {
                materials: materialOverrides,
                evaluations: evaluationOverrides,
                unitNames,
                structure: Array.isArray(sourceOverrides.structure) ? sourceOverrides.structure.map(cloneModule) : null,
                extraUnits: (sourceOverrides.extraUnits || []).map(extra => ({
                    ...JSON.parse(JSON.stringify(extra)),
                    unit: {
                        ...JSON.parse(JSON.stringify(extra.unit || {})),
                        apostilaKey: extra.unit?.apostilaKey ? cloneMaterialKey(extra.unit.apostilaKey) : undefined,
                        avaliacaoKey: extra.unit?.avaliacaoKey ? cloneEvaluationKey(extra.unit.avaliacaoKey) : undefined,
                    },
                })),
            };
            cloned.releasedItems = Object.fromEntries(Object.entries(sourceClass.releasedItems || {}).map(([key, value]) => {
                if (key.startsWith('Gabarito_')) return [`Gabarito_${cloneEvaluationKey(key.slice('Gabarito_'.length))}`, value];
                return [materialKeyMap.get(key) || evaluationKeyMap.get(key) || key, value];
            }));
            cloned.onlineExamConfigs = {};
            cloned.activeExamKey = null;
            cloned.activeApplicationId = null;
            return cloned;
        });
        db.memory.classes.push(...clonedClasses);
        recordAcademicAudit(req, matchedAdmin, 'course_cloned', { courseId: src.id }, null, { newCourseId: newId, clonedClasses: clonedClasses.map(cls => cls.name) });
        db.save();
        res.json({ success: true, course: newCourse, classes: clonedClasses });
    });
});


module.exports = router;
