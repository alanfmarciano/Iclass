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
    adminCanAccessStudent
} = require('../middlewares.js');
const { parseEvaluationMarkdown } = require('../utils/parser.js');
const { gradeAttempt } = require('../utils/examGrading.js');
const { alternativeLabelsMode, seenAlternativeLetter, seenLetterFor } = require('../utils/examAnswerIds.js');
const { canAccessAdminPermission } = require('../utils/adminPermissions.js');
const {
    DEFAULT_STATUS,
    STUDENT_STATUSES,
    extractStudentFields,
    validateStudentFields,
    diffStudentForAudit,
    recordStudentAudit,
    OBSERVATION_CATEGORIES,
    OBSERVATION_VISIBILITY,
} = require('../utils/students.js');
const { extractBranding, extractInstitutional, validateBrandingPatch } = require('../utils/branding.js');
const { VALID_POLICIES, attemptGroupKey, enrichSubmissionsWithAttemptResult } = require('../utils/submissionAttempts.js');
const { isStudentSessionOnline, sessionLastSeen } = require('../utils/studentSessions.js');
const {
    ACTIVE_APPLICATION_STATUSES,
    applicationToOnlineConfig,
    examStateKey,
    findExamApplication,
    findOpenAttemptState,
    transitionExamApplication,
} = require('../utils/examApplications.js');
const { attemptOverdueMs, countAnswers, deliveredWithoutAttemptsLeft, settleExpiredAttempts } = require('../utils/examDeadline.js');
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
    validateAdmin(req, res, async matchedAdmin => {
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
    validateAdmin(req, res, async matchedAdmin => {
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

// Excluir conta do aluno e dados pessoais associados
router.post('/api/admin/delete-student', (req, res) => {
    validateAdmin(req, res, () => {
        const { email } = req.body;
        if (!email || email.trim() === '') {
            return res.status(400).json({ error: 'E-mail do estudante nao informado.' });
        }

        const normalizedEmail = email.trim().toLowerCase();
        const students = readJSON(DB_STUDENTS_FILE);
        const studentExists = students.some(s => s.email && s.email.toLowerCase() === normalizedEmail);
        const studentObjToDelete = students.find(s => s.email && s.email.toLowerCase() === normalizedEmail);

        if (!studentExists) {
            return res.status(404).json({ error: 'Estudante nao encontrado.' });
        }

        db.memory.students = students.filter(s => !s.email || s.email.toLowerCase() !== normalizedEmail);
        db.memory.submissions = readJSON(DB_SUBMISSIONS_FILE).filter(s =>
            !(s.student && s.student.email && s.student.email.toLowerCase() === normalizedEmail)
        );

        if (db.memory.progress) delete db.memory.progress[normalizedEmail];
        if (db.memory.notes) delete db.memory.notes[normalizedEmail];
        if (db.memory.annotations) delete db.memory.annotations[normalizedEmail];
        if (db.memory.sessions) delete db.memory.sessions[normalizedEmail];
        // Dados pessoais restantes indexados pelo e-mail (presença, acessos, observações,
        // certificados, logs de prova e de login). O log de auditoria é mantido como histórico.
        const ownedBy = item => item && String(item.studentEmail || item.email || '').toLowerCase() === normalizedEmail;
        ['attendance', 'moduleAccess', 'pedagogicalObservations', 'certificates', 'proctoringLogs', 'examKeystrokes', 'loginLogs', 'forum']
            .forEach(collection => { if (Array.isArray(db.memory[collection])) db.memory[collection] = db.memory[collection].filter(item => !ownedBy(item)); });
        Object.keys(db.memory.studentExamState || {}).forEach(key => {
            const state = db.memory.studentExamState[key];
            if (state && String(state.studentEmail || '').toLowerCase() === normalizedEmail) delete db.memory.studentExamState[key];
        });

        const classes = readJSON(DB_CLASSES_FILE);
        classes.forEach(cls => {
            if (cls.studentReleasedItems && cls.studentReleasedItems[normalizedEmail]) {
                delete cls.studentReleasedItems[normalizedEmail];
            }
        });
        db.memory.classes = classes;

        // Pasta do aluno vai para a lixeira (documentos preservados de forma identificável).
        try { const dir = path.join(fileStore.ALUNOS_DIR, fileStore.studentFolderName(studentObjToDelete)); if (fs.existsSync(dir)) fileStore.moveDirToTrash(dir); } catch (e) {}

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
        const scoped = filterSubmissionsForAdmin(submissions, matchedAdmin).filter(submission => {
            const rowCourseId = String(submission.courseId || submission.student?.courseId || '').trim();
            const rowClass = String(submission.studentClass || submission.student?.studentClass || '').trim();
            return (!courseId || rowCourseId === courseId) && (!studentClass || rowClass === studentClass);
        });
        res.json(enrichSubmissionsWithAttemptResult(scoped));
    });
});

// Controla quais tentativas entram no resultado e como a nota consolidada é calculada.
router.post('/api/admin/submissions/result-control', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const { submissionId, action, policy } = req.body || {};
        const submissions = readJSON(DB_SUBMISSIONS_FILE);
        const allowedIds = new Set(filterSubmissionsForAdmin(submissions, matchedAdmin).map(item => String(item.id)));
        const target = submissions.find(item => String(item.id) === String(submissionId) && allowedIds.has(String(item.id)));
        if (!target) return res.status(404).json({ error: 'Tentativa não encontrada.' });

        const groupKey = attemptGroupKey(target);
        const group = submissions.filter(item => attemptGroupKey(item) === groupKey && allowedIds.has(String(item.id)));
        if (group.length === 0) return res.status(404).json({ error: 'Tentativas não encontradas.' });

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

        writeJSON(DB_SUBMISSIONS_FILE, submissions);
        const refreshed = enrichSubmissionsWithAttemptResult(group);
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

        res.json({
            success: true,
            source,
            submissionId: submission.id,
            alternativeLabels: alternativeLabelsMode(submission),
            assignedVersion: submission.assignedVersion || snapshot?.version || 'A',
            examCode: submission.examSnapshot?.examCode || snapshot?.examCode || null,
            questions: reviewQuestions
        });
    });
});

router.post('/api/admin/submissions/publish', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const ids = new Set(Array.isArray(req.body?.ids) ? req.body.ids.map(String) : []);
        const published = req.body?.published !== false;
        if (ids.size === 0) return res.status(400).json({ error: 'Selecione ao menos uma nota.' });
        const submissions = readJSON(DB_SUBMISSIONS_FILE);
        const allowedIds = new Set(filterSubmissionsForAdmin(submissions, matchedAdmin).map(item => String(item.id)));
        let updated = 0;
        submissions.forEach(item => {
            if (!ids.has(String(item.id)) || !allowedIds.has(String(item.id))) return;
            item.gradePublished = published;
            item.gradePublishedAt = published ? Date.now() : null;
            item.gradePublishedBy = published ? (matchedAdmin?.email || 'admin') : null;
            updated++;
        });
        writeJSON(DB_SUBMISSIONS_FILE, submissions);
        res.json({ success: true, updated, published });
    });
});

// Excluir registro de submissão
router.post('/api/admin/submissions/delete', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const { id, studentEmail, examKey } = req.body;
        const submissions = readJSON(DB_SUBMISSIONS_FILE);
        const allowedIds = new Set(filterSubmissionsForAdmin(submissions, matchedAdmin).map(item => String(item.id)));
        let filteredSubmissions;
        if (id !== undefined && id !== null) {
            if (!allowedIds.has(String(id))) return res.status(404).json({ error: 'Tentativa não encontrada.' });
            filteredSubmissions = submissions.filter(item => String(item.id) !== String(id));
        } else {
            if (!studentEmail || !examKey) return res.status(400).json({ error: 'Dados insuficientes para exclusão.' });
            const normalizedEmail = studentEmail.trim().toLowerCase();
            filteredSubmissions = submissions.filter(item => !(
                allowedIds.has(String(item.id)) &&
                item.student?.email?.toLowerCase() === normalizedEmail &&
                item.examKey === examKey
            ));
        }

        writeJSON(DB_SUBMISSIONS_FILE, filteredSubmissions);
        res.json({ success: true, message: 'Registro de prova excluído com sucesso!' });
    });
});

// Criar/Lançar registro de submissão manualmente pelo administrador
router.post('/api/admin/submissions/create', (req, res) => {
    validateAdmin(req, res, () => {
        const { studentEmail, examKey, score, correctCount: reqCorrectCount, totalCount: reqTotalCount, answers, type, questionNumbers: reqQuestionNumbers } = req.body;
        
        if (!studentEmail || !examKey) {
            return res.status(400).json({ error: 'E-mail do estudante e chave da prova são obrigatórios.' });
        }

        const normalizedEmail = studentEmail.trim().toLowerCase();
        const students = readJSON(DB_STUDENTS_FILE);
        const registeredStudent = students.find(s => s.email && s.email.toLowerCase() === normalizedEmail);
        
        if (!registeredStudent) {
            return res.status(404).json({ error: 'Estudante não encontrado no cadastro.' });
        }

        // Recupera a turma do estudante
        const studentClass = registeredStudent.classes && registeredStudent.classes.length > 0
            ? (typeof registeredStudent.classes[0] === 'object' ? registeredStudent.classes[0].name : registeredStudent.classes[0])
            : (registeredStudent.studentClass || "");
            
        const studentCourseId = registeredStudent.classes && registeredStudent.classes.length > 0 && typeof registeredStudent.classes[0] === 'object'
            ? registeredStudent.classes[0].courseId
            : (registeredStudent.courseId || null);

        // Busca informações sobre a avaliação para correção ou contagem
        let questions = [];
        const evaluation = db.memory.evaluations[examKey];
        if (evaluation) {
            questions = evaluation.questions;
        } else {
            const filePath = path.join(runtimePaths.CONTENT_DIR, `${examKey}.md`);
            if (fs.existsSync(filePath)) {
                const mdContent = fs.readFileSync(filePath, 'utf8');
                const parsedObj = parseEvaluationMarkdown(mdContent, examKey);
                questions = parsedObj ? parsedObj.questions : [];
            }
        }

        if (!questions || questions.length === 0) {
            return res.status(400).json({ error: 'Avaliação não encontrada ou sem questões cadastradas.' });
        }

        questions = questions.map((question, index) => ({
            ...question,
            originalNumber: Number(question.originalNumber || question.number || index + 1)
        }));

        // Verifica configurações da prova para a turma
        const classes = readJSON(DB_CLASSES_FILE);
        const cls = classes.find(c => c.name === studentClass);
        const examConfig = (cls && cls.examConfigs && cls.examConfigs[examKey]) || {};
        const excludedQuestions = new Set((examConfig.excludedQuestions || []).map(Number));
        const availableQuestions = questions.filter(q => !excludedQuestions.has(Number(q.originalNumber)));
        
        const configuredCount = parseInt(examConfig.questionCount, 10) || availableQuestions.length;
        const totalCount = Math.min(configuredCount, availableQuestions.length) || questions.length;

        let finalScore = 0;
        let finalCorrectCount = 0;
        let finalTotalCount = totalCount;
        let gradedAnswers = [];

        function getCorrectAnswer(question) {
            if (question.correctAnswer) return String(question.correctAnswer).toUpperCase();
            const correctAlt = (question.alternatives || []).find(alt => alt.isCorrect);
            return correctAlt && correctAlt.letter ? String(correctAlt.letter).toUpperCase() : '';
        }

        if (answers && typeof answers === 'object' && Object.keys(answers).length > 0) {
            // Correção baseada no cartão-resposta (respostas fornecidas)
            const providedNumbers = Array.isArray(reqQuestionNumbers)
                ? [...new Set(reqQuestionNumbers.map(Number).filter(Number.isFinite))]
                : [];

            let selectedQuestions;
            if (providedNumbers.length > 0) {
                // O frontend informou exatamente quais questões compuseram a prova aplicada
                // (versão impressa do histórico) — a nota é calculada sobre esse conjunto,
                // mesmo que a configuração atual da turma tenha mudado desde a impressão.
                selectedQuestions = questions.filter(q => providedNumbers.includes(Number(q.originalNumber)));
                finalTotalCount = selectedQuestions.length || totalCount;
            } else {
                const submittedNumbers = Object.keys(answers).map(Number).filter(n => availableQuestions.some(q => q.originalNumber === n));
                selectedQuestions = availableQuestions.filter(q => submittedNumbers.includes(q.originalNumber));

                // Preenche com o restante das questões disponíveis caso não chegue no total esperado
                availableQuestions.forEach(q => {
                    if (selectedQuestions.length >= totalCount) return;
                    if (!selectedQuestions.some(selected => selected.originalNumber === q.originalNumber)) {
                        selectedQuestions.push(q);
                    }
                });
                finalTotalCount = totalCount;
            }

            selectedQuestions.forEach(q => {
                const correctAnswer = getCorrectAnswer(q);
                const studentChoice = answers[q.originalNumber] ? String(answers[q.originalNumber]).toUpperCase() : null;
                const isCorrect = studentChoice === correctAnswer;
                if (isCorrect) {
                    finalCorrectCount++;
                }
                gradedAnswers.push({
                    questionNumber: q.originalNumber,
                    studentChoice: studentChoice || null,
                    correctAnswer,
                    isCorrect
                });
            });

            finalScore = Math.round((finalCorrectCount / finalTotalCount) * 100);
        } else {
            // Lançamento rápido (nota/acertos direta)
            finalScore = score !== undefined ? Math.round(Number(score)) : 0;
            const tempTotal = reqTotalCount !== undefined ? parseInt(reqTotalCount, 10) : totalCount;
            finalCorrectCount = reqCorrectCount !== undefined
                ? parseInt(reqCorrectCount, 10)
                : Math.round((finalScore / 100) * tempTotal);
            finalTotalCount = tempTotal || totalCount;

            // Graded answers vazios ou mapeando apenas os índices simulados
            gradedAnswers = [];
        }

        const normalizedStudent = {
            name: registeredStudent.name,
            email: normalizedEmail,
            studentClass: studentClass,
            courseId: studentCourseId
        };

        const submissions = readJSON(DB_SUBMISSIONS_FILE);
        const previousAttempts = submissions.filter(item =>
            item.student?.email?.toLowerCase() === normalizedEmail &&
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
            type: type || "impressa",
            attemptNumber: previousAttempts.length + 1,
            resultStatus: 'considered',
            aggregationPolicy: previousPolicy,
            selectedForResult: false,
            gradePublished: false,
            timestamp: new Date().toISOString()
        };

        submissions.push(submissionObj);
        writeJSON(DB_SUBMISSIONS_FILE, submissions);

        res.json({
            success: true,
            message: 'Nota lançada e corrigida com sucesso!',
            score: finalScore,
            correctCount: finalCorrectCount,
            totalCount: finalTotalCount
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
            return { ...safeStudent, isOnline, lastSeenAt: lastSeen || null };
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

        // Suporte retroativo ou novo array
        let studentClasses = classes || (studentClass ? [studentClass] : []);

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
            accessibility: fields.accessibility || null,
            password: db.hashPassword(String(studentPassword).trim()),
            classes: studentClasses,
            studentClass: studentClasses[0], // Compatibilidade com submissões legadas
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

        let studentClasses = classes || (studentClass ? [studentClass] : []);
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
            studentClass: studentClasses[0], // Compatibilidade
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
                sub.student.studentClass = studentClasses[0]; // Manter primeira turma na submissão antiga
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
        if (!name) return res.status(400).json({ error: 'Informe a turma.' });

        const cls = (db.memory.classes || []).find(c => c.name === name);
        if (!cls) return res.status(404).json({ error: 'Turma não encontrada.' });
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
            const alreadyIn = current.some(c => (typeof c === 'string' ? c : c && c.name) === name);
            if (alreadyIn) {
                skipped.push({ email: before.email, reason: 'Já matriculado nesta turma.' });
                return;
            }
            const nextClasses = [...current, name];
            const changes = diffStudentForAudit(before, { classes: nextClasses });
            students[index] = {
                ...before,
                classes: nextClasses,
                studentClass: nextClasses[0], // Compatibilidade
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

// ---- Observações pedagógicas controladas (Fase 3) — somente admin ----
router.get('/api/admin/student/observations', (req, res) => {
    validateAdmin(req, res, () => {
        const email = (req.query.email || '').trim().toLowerCase();
        if (!email) return res.status(400).json({ error: 'E-mail do aluno é obrigatório.' });
        const list = (db.memory.pedagogicalObservations || [])
            .filter(o => o.studentEmail === email)
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
        const obs = {
            id: 'obs_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            studentEmail: email,
            author: (matchedAdmin && matchedAdmin.email) || 'admin',
            category: category || 'Observação geral',
            visibility: visibility || 'Equipe pedagógica',
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
        if (!obs) return res.status(404).json({ error: 'Observação não encontrada.' });
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
        if (!obs) return res.status(404).json({ error: 'Observação não encontrada.' });
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
            .map(s => ({ id: s.id, examKey: s.examKey, score: s.score, correctCount: s.correctCount, totalCount: s.totalCount, assignedVersion: s.assignedVersion, timestamp: s.timestamp }))
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
router.get('/api/admin/student/report', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const email = (req.query.email || '').trim().toLowerCase();
        if (!email) return res.status(400).json({ error: 'E-mail do aluno é obrigatório.' });
        const student = (db.memory.students || []).find(s => s.email && s.email.toLowerCase() === email);
        if (!student) return res.status(404).json({ error: 'Aluno não encontrado.' });
        if (!adminCanAccessStudent(matchedAdmin, student)) return res.status(403).json({ error: 'Aluno fora do seu escopo.' });

        const requestedCourseId = String(req.query.courseId || '').trim();
        const memberships = (Array.isArray(student.classes) && student.classes.length ? student.classes : (student.studentClass ? [student.studentClass] : []))
            .map(item => typeof item === 'string' ? { name: item, courseId: '' } : { name: item?.name || item?.className || '', courseId: item?.courseId || '' })
            .filter(item => item.name);
        const membership = memberships.find(item => !requestedCourseId || String(item.courseId) === requestedCourseId) || memberships[0] || { name: student.studentClass || '', courseId: '' };
        const cls = findClassByNameAndCourse(db.memory.classes || [], membership.name, membership.courseId)
            || (db.memory.classes || []).find(c => c.name === membership.name) || null;
        const courseId = String((cls && cls.courseId) || membership.courseId || '');
        const course = (db.memory.courses || []).find(c => String(c.id) === courseId) || null;
        const structure = effectiveStructure(courseId, cls?.name)?.structure || course?.structure || [];

        const subs = (db.memory.submissions || []).filter(s => s.student && String(s.student.email || '').toLowerCase() === email
            && (!courseId || !s.student.courseId || String(s.student.courseId) === courseId));
        const published = enrichSubmissionsWithAttemptResult(subs.filter(s => s.gradePublished === true));
        const byExam = new Map();
        published.forEach(s => {
            const list = byExam.get(s.examKey) || [];
            list.push(s);
            byExam.set(s.examKey, list);
        });
        const modules = structure.map(module => {
            const exams = (module.units || module.items || []).filter(unit => unit.avaliacaoKey).map(unit => {
                const attempts = byExam.get(unit.avaliacaoKey) || [];
                const counted = attempts.filter(item => item.countsTowardResult !== false);
                const consolidated = attempts.find(item => item.consolidatedScore != null)?.consolidatedScore;
                const score = consolidated != null ? consolidated : (counted.length ? counted.reduce((sum, item) => sum + Number(item.score || 0), 0) / counted.length : null);
                const evaluation = db.memory.evaluations?.[unit.avaliacaoKey];
                const pendingAttempts = subs.filter(s => s.examKey === unit.avaliacaoKey && s.gradePublished !== true).length;
                return {
                    examKey: unit.avaliacaoKey,
                    title: (evaluation && (evaluation.title || evaluation.name)) || unit.name || unit.avaliacaoKey,
                    attempts: attempts.length,
                    pendingAttempts,
                    grade: score == null ? null : Math.round(score) / 10,
                    lastAt: attempts.map(item => Date.parse(item.timestamp) || 0).sort((a, b) => b - a)[0] || null,
                };
            });
            const graded = exams.filter(exam => exam.grade != null);
            return {
                id: module.id || module.key || module.name,
                name: module.name || module.title || module.id,
                exams,
                average: graded.length ? Math.round(graded.reduce((sum, exam) => sum + exam.grade, 0) / graded.length * 10) / 10 : null,
            };
        });
        const allGraded = modules.flatMap(module => module.exams).filter(exam => exam.grade != null);

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
            className: cls?.name || membership.name || '',
            period: cls?.period || student.period || '',
            modules,
            overallAverage: allGraded.length ? Math.round(allGraded.reduce((sum, exam) => sum + exam.grade, 0) / allGraded.length * 10) / 10 : null,
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

// Marcar presença manualmente (Fase 4)
router.post('/api/admin/student/attendance/mark', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const email = (req.body.email || '').trim().toLowerCase();
        if (!email) return res.status(400).json({ error: 'E-mail do aluno é obrigatório.' });
        const date = (req.body.date || new Date().toISOString().slice(0, 10));
        if (!Array.isArray(db.memory.attendance)) db.memory.attendance = [];
        const student = (db.memory.students || []).find(s => s.email && s.email.toLowerCase() === email);
        const studentClass = (req.body.studentClass || (student && student.studentClass) || '');
        const courseId = String(req.body.courseId || '');
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
        res.json({ success: true });
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
        const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') ? req.body.date : null;
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
                    aula.status === 'justificada' ? justTxt : '', a.origin || '',
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
            return res.status(400).json({ error: 'Titulo, data, curso e destino sao obrigatorios.' });
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
        if (!item) return res.status(404).json({ error: 'Evento nao encontrado.' });
        if (!_annInScope(item, matchedAdmin)) return res.status(403).json({ error: 'Evento fora do seu escopo.' });
        const target = body.target === 'turma' ? 'turma' : 'curso';
        const courseId = String(body.courseId || item.courseId || '').trim();
        const targetValue = target === 'curso' ? courseId : String(body.targetValue || '').trim();
        if (!_calendarTargetAllowed(matchedAdmin, target, targetValue, courseId)) return res.status(403).json({ error: 'Destino fora do seu escopo.' });
        if (!String(body.title || '').trim() || !/^\d{4}-\d{2}-\d{2}$/.test(body.eventDate || '') || !courseId || !targetValue) {
            return res.status(400).json({ error: 'Titulo, data, curso e destino sao obrigatorios.' });
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
        if (!item) return res.status(404).json({ error: 'Evento nao encontrado.' });
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
            
            fs.writeFileSync(filePath, markdownText, 'utf8');
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

function rejectInvalidUpload(req, res) {
    const result = validateUploadedFile(req.file);
    if (result.valid) return false;
    try { fileStore.moveToTrash(req.file.path); } catch (e) {}
    res.status(400).json({ error: result.reason });
    return true;
}

router.use(createAdminRecoveryRouter({ uploadForRequest, rejectInvalidUpload, uploadDir }));
router.use(createAdminArchiveRouter({ studentClassNames }));
router.use(createAdminSystemRouter());
router.use(createAdminAccountsRouter());
router.use(createAdminExamConfigRouter());


// Upload de comprovante/atestado de justificativa (PDF ou imagem)
router.post('/api/admin/attendance/justification-upload', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        uploadForRequest().single('file')(req, res, async (err) => {
            if (err) return res.status(400).json({ error: 'Erro no upload: ' + err.message });
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
            if (err) return res.status(400).json({ error: 'Erro no upload: ' + err.message });
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
                error: 'Prepare a prova online a partir do historico antes de iniciar pelo Monitor.'
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
        // Tempo extra nunca reabre tentativa vencida: ela é entregue (respostas salvas) antes do ajuste.
        // No ajuste da turma, o professor fica sabendo quantos já estavam sem tempo.
        let deliveredAtDeadline = 0;
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
            }
        }

        db.save();
        res.json(targetEmail ? { success: true } : { success: true, deliveredAtDeadline });
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
            return res.status(400).json({ error: 'E-mail do aluno e prova sÃ£o obrigatÃ³rios.' });
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

        const students = db.memory.students.filter(s => {
            const hasClass = s.classes && s.classes.some(c => 
                (typeof c === 'string' && c.toLowerCase() === studentClass.toLowerCase()) || 
                (c && c.name && c.name.toLowerCase() === studentClass.toLowerCase())
            );
            const classMatch = s.studentClass && s.studentClass.toLowerCase() === studentClass.toLowerCase();
            return hasClass || classMatch;
        });

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
            } else if (timing && timing.overdueMs !== null && timing.overdueMs >= 0) {
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

// 6. Exporta notas de uma turma em formato CSV
router.get('/api/admin/export-grades/:class/:examKey', (req, res) => {
    validateAdmin(req, res, () => {
        const studentClass = req.params.class.trim();
        const examKey = req.params.examKey.trim();
        const applicationId = String(req.query.applicationId || '').trim();

        const submissions = db.memory.submissions.filter(sub => {
            const examMatch = sub.examKey && sub.examKey.toLowerCase() === examKey.toLowerCase();
            // Suporte a sub.studentClass (legado) e sub.student.studentClass (atual)
            const subClass = sub.studentClass || (sub.student && sub.student.studentClass) || '';
            const classMatch = subClass.toLowerCase() === studentClass.toLowerCase();
            return examMatch && classMatch && (!applicationId || sub.applicationId === applicationId);
        });

        let csvContent = '\uFEFF';
        csvContent += 'Nome;E-mail;Turma;Avaliação;Aplicação;Tentativa;Versão;Acertos;Nota Final;Data de Envio\n';

        // Neutraliza CSV/formula injection: nome e e-mail são controlados pelo aluno.
        const csvSafe = (value) => {
            let s = String(value == null ? '' : value);
            if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
            if (/[";\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
            return s;
        };
        submissions.forEach(sub => {
            // Suporte a estrutura legada e atual (sub.student.name vs sub.studentName)
            const name = sub.studentName || (sub.student && sub.student.name) || 'N/A';
            const email = sub.studentEmail || (sub.student && sub.student.email) || 'N/A';
            const subClass = sub.studentClass || (sub.student && sub.student.studentClass) || studentClass;
            const version = sub.assignedVersion || sub.version || (sub.state && sub.state.assignedVersion) || 'A';
            const correct = typeof sub.correctCount === 'number' ? sub.correctCount : (sub.score || 0);
            const total = typeof sub.totalCount === 'number' ? sub.totalCount : (typeof sub.totalQuestions === 'number' ? sub.totalQuestions : 20);
            const finalGrade = typeof sub.score === 'number' ? sub.score : (typeof sub.finalGrade === 'number' ? sub.finalGrade : 0);
            const dateStr = sub.timestamp ? new Date(sub.timestamp).toLocaleString('pt-BR') : (sub.submittedAt ? new Date(sub.submittedAt).toLocaleString('pt-BR') : 'N/A');

            csvContent += `${csvSafe(name)};${csvSafe(email)};${csvSafe(subClass)};${csvSafe(examKey)};${csvSafe(sub.applicationId || 'legado')};${csvSafe(sub.attemptNumber || 1)};${csvSafe(version)};${csvSafe(`${correct}/${total}`)};${csvSafe(finalGrade.toFixed(2))};${csvSafe(dateStr)}\n`;
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=notas_${studentClass}_${examKey}.csv`);
        res.status(200).send(csvContent);
    });
});

// 7. RelatÃ³rio analÃ­tico por questÃ£o para apoiar revisÃ£o pedagÃ³gica
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

        submissions.forEach(sub => {
            const score = Number(sub.score || 0);
            if (score < 60) gradeBuckets.baixo++;
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
            averageScore: submissions.length
                ? Math.round(submissions.reduce((sum, sub) => sum + Number(sub.score || 0), 0) / submissions.length)
                : 0,
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

// 8. Banco centralizado de questÃµes reutilizÃ¡veis
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
            return res.status(400).json({ error: 'Texto da questÃ£o Ã© obrigatÃ³rio.' });
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
router.get('/api/admin/notifications', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const scope = _dashboardScope(req, matchedAdmin);
        const canSeeMatriculas = canAccessAdminPermission(matchedAdmin, 'page.accounts');
        const queue = computeQueue({
            memory: db.memory, cls: scope.cls, course: scope.course, students: scope.students,
            today: settingsUtil.today(), now: Date.now(), canSeeMatriculas,
        }).filter(item => canAccessAdminPermission(matchedAdmin, item.permissao));
        const account = (db.memory.admins || []).find(a => a.email && a.email.toLowerCase() === String(matchedAdmin.email || '').toLowerCase());
        const seen = new Set((account && account.preferences && account.preferences['notifications.seen']) || []);
        const items = queue.map(item => ({
            id: item.id, type: item.tipo, title: item.titulo, text: item.descricao || '', count: item.count || 0,
            tone: item.tone, href: item.href, unread: !seen.has(`${item.id}:${item.count || 0}`),
        }));
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, items, unread: items.filter(item => item.unread).length });
    });
});

router.post('/api/admin/notifications/seen', (req, res) => {
    validateAdmin(req, res, async (config, matchedAdmin) => {
        const account = (db.memory.admins || []).find(a => a.email && a.email.toLowerCase() === String(matchedAdmin.email || '').toLowerCase());
        if (!account) return res.status(404).json({ error: 'Conta não encontrada.' });
        const keys = Array.isArray(req.body.keys) ? req.body.keys.map(String).slice(0, 100) : [];
        account.preferences = { ...(account.preferences || {}), 'notifications.seen': keys };
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
            return res.status(403).json({ error: 'Sua conta nao possui permissao para esta operacao.' });
        }
        const src = (db.memory.courses || []).find(c => c.id === req.params.id);
        if (!src) return res.status(404).json({ error: 'Curso de origem nao encontrado.' });
        const newId = String(req.body.newId || '').trim().toUpperCase();
        const newName = String(req.body.newName || '').trim();
        const schoolId = req.body.schoolId || src.schoolId || 'escola_default';
        if (!newId || !newName) return res.status(400).json({ error: 'Informe ID e nome do novo curso.' });
        if ((db.memory.courses || []).some(c => c.id === newId)) return res.status(400).json({ error: 'Ja existe um curso com esse ID.' });

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
