const express = require('express');
const db = require('../database.js');
const {
    DB_ADMINS_FILE,
    readJSON,
    validateAdmin,
    issueAdminSession,
    SERVER_INSTANCE_ID,
} = require('../middlewares.js');
const { parseAdditionalPermissions, isProfessorAccount } = require('../utils/adminPermissions.js');

// Gestão de contas (criar/editar/excluir) é exclusiva de administradores.
// Backstop além do RBAC: mesmo que a capability accounts.manage vaze para um
// professor, o handler recusa — impede criar conta admin ou auto-promoção.
function requireAdminManager(res, requester) {
    if (isProfessorAccount(requester)) {
        res.status(403).json({ error: 'Apenas administradores podem gerenciar contas.' });
        return false;
    }
    return true;
}

const ADMIN_ACCOUNT_ROLES = new Set(['admin', 'professor']);

function parseAdminAccountRole(value, fallback = 'admin') {
    if (value === undefined || value === null || String(value).trim() === '') {
        return { ok: true, role: fallback };
    }
    const role = String(value).trim().toLowerCase();
    if (!ADMIN_ACCOUNT_ROLES.has(role)) return { ok: false, error: 'Papel inválido. Use admin ou professor.' };
    return { ok: true, role };
}

function parseAssignedClasses(value) {
    if (value === undefined) return { ok: true, classes: undefined };
    if (!Array.isArray(value)) return { ok: false, error: 'Turmas atribuídas devem ser enviadas como uma lista.' };

    const classes = [];
    for (const item of value) {
        if (item && typeof item === 'object') {
            const assignment = {
                courseId: String(item.courseId || '').trim(),
                className: String(item.className || item.name || '').trim(),
            };
            if (!assignment.courseId || !assignment.className) {
                return { ok: false, error: 'Cada turma deve informar courseId e className.' };
            }
            classes.push(assignment);
            continue;
        }
        const className = String(item || '').trim();
        if (!className) continue;
        const matches = (db.memory.classes || []).filter(cls => cls.name === className);
        if (matches.length !== 1) {
            return { ok: false, error: `A turma "${className}" é inexistente ou ambígua; selecione também o curso.` };
        }
        classes.push({ courseId: matches[0].courseId, className });
    }
    return { ok: true, classes: [...new Map(classes.map(item => [`${item.courseId}::${item.className}`, item])).values()] };
}

function findUnknownAssignedClass(assignedClasses) {
    return (assignedClasses || []).find(assignment => !(db.memory.classes || []).some(cls => (
        cls.name === assignment.className && cls.courseId === assignment.courseId
    )));
}

function parseAssignmentIds(value, label) {
    if (value === undefined) return { ok: true, ids: undefined };
    if (!Array.isArray(value)) return { ok: false, error: `${label} devem ser enviados como uma lista.` };
    return { ok: true, ids: [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))] };
}

function findUnknownSchool(ids) {
    return (ids || []).find(id => !(db.memory.schools || []).some(school => String(school.id) === id));
}

function findUnknownCourse(ids) {
    return (ids || []).find(id => !(db.memory.courses || []).some(course => (
        String(course.id) === id && !course.deleted && course.status !== 'deleted' && course.status !== 'inactive'
    )));
}

function assignmentSnapshot(account) {
    return {
        assignedSchoolIds: Array.isArray(account && account.assignedSchoolIds) ? account.assignedSchoolIds : [],
        assignedCourseIds: Array.isArray(account && account.assignedCourseIds) ? account.assignedCourseIds : [],
        assignedClasses: Array.isArray(account && account.assignedClasses) ? account.assignedClasses : [],
    };
}

function recordAssignmentAudit(req, requester, targetEmail, before, after) {
    if (!Array.isArray(db.memory.auditLogs)) db.memory.auditLogs = [];
    db.memory.auditLogs.push({
        id: `audit_assignment_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        type: 'professor_assignments_updated',
        actorEmail: requester && requester.email,
        targetEmail,
        before,
        after,
        at: Date.now(),
        ip: req.ip || req.socket && req.socket.remoteAddress || '',
    });
}

function createAdminAccountsRouter() {
    const router = express.Router();

    router.get('/api/admin/accounts', (req, res) => {
        validateAdmin(req, res, () => {
            const admins = readJSON(DB_ADMINS_FILE);
            res.json(admins.map(account => ({
                name: account.name,
                email: account.email,
                role: account.role || 'admin',
                assignedSchoolIds: Array.isArray(account.assignedSchoolIds) ? account.assignedSchoolIds : [],
                assignedCourseIds: Array.isArray(account.assignedCourseIds) ? account.assignedCourseIds : [],
                assignedClasses: Array.isArray(account.assignedClasses) ? account.assignedClasses : [],
                additionalPermissions: Array.isArray(account.additionalPermissions) ? account.additionalPermissions : [],
            })));
        });
    });

    router.post('/api/admin/accounts/create', (req, res) => {
        validateAdmin(req, res, async (config, currentAdmin) => {
            if (!requireAdminManager(res, currentAdmin)) return;
            const { name, email, password } = req.body;
            if (!name || !email || !password || name.trim() === '' || email.trim() === '' || password.trim() === '') {
                return res.status(400).json({ error: 'Dados incompletos ou inválidos.' });
            }

            const parsedRole = parseAdminAccountRole(req.body.role);
            if (!parsedRole.ok) return res.status(400).json({ error: parsedRole.error });
            const parsedClasses = parseAssignedClasses(req.body.assignedClasses);
            if (!parsedClasses.ok) return res.status(400).json({ error: parsedClasses.error });
            const parsedSchools = parseAssignmentIds(req.body.assignedSchoolIds, 'Escolas atribuídas');
            if (!parsedSchools.ok) return res.status(400).json({ error: parsedSchools.error });
            const parsedCourses = parseAssignmentIds(req.body.assignedCourseIds, 'Cursos atribuídos');
            if (!parsedCourses.ok) return res.status(400).json({ error: parsedCourses.error });
            const parsedPermissions = parseAdditionalPermissions(req.body.additionalPermissions);
            if (!parsedPermissions.ok) return res.status(400).json({ error: parsedPermissions.error });

            const role = parsedRole.role;
            let assignedClasses = parsedClasses.classes || [];
            let assignedSchoolIds = parsedSchools.ids || [];
            let assignedCourseIds = parsedCourses.ids || [];
            let additionalPermissions = parsedPermissions.permissions || [];
            if (role === 'professor') {
                const invalid = findUnknownAssignedClass(assignedClasses);
                if (invalid) return res.status(400).json({ error: `Turma inexistente: ${invalid.className}.` });
                const invalidSchool = findUnknownSchool(assignedSchoolIds);
                if (invalidSchool) return res.status(400).json({ error: `Escola inexistente: ${invalidSchool}.` });
                const invalidCourse = findUnknownCourse(assignedCourseIds);
                if (invalidCourse) return res.status(400).json({ error: `Curso inexistente: ${invalidCourse}.` });
            } else {
                assignedClasses = [];
                assignedSchoolIds = [];
                assignedCourseIds = [];
                additionalPermissions = [];
            }

            const admins = readJSON(DB_ADMINS_FILE);
            const normalizedEmail = email.trim().toLowerCase();
            if (admins.some(account => account.email && account.email.toLowerCase() === normalizedEmail)) {
                return res.status(400).json({ error: 'E-mail administrativo já cadastrado.' });
            }
            admins.push({
                name: name.trim(),
                email: normalizedEmail,
                password: db.hashPassword(password.trim()),
                role,
                assignedSchoolIds,
                assignedCourseIds,
                assignedClasses,
                additionalPermissions,
            });
            db.memory.admins = admins;
            await db.save();
            res.json({ success: true });
        });
    });

    router.post('/api/admin/accounts/update', (req, res) => {
        validateAdmin(req, res, async (config, currentAdmin) => {
            if (!requireAdminManager(res, currentAdmin)) return;
            const email = (req.body.email || '').trim().toLowerCase();
            if (!email) return res.status(400).json({ error: 'E-mail não informado.' });
            const admins = readJSON(DB_ADMINS_FILE);
            const account = admins.find(item => item.email && item.email.toLowerCase() === email);
            const assignmentsBefore = account ? assignmentSnapshot(account) : null;
            if (!account) return res.status(404).json({ error: 'Conta não encontrada.' });

            const nextName = req.body.name === undefined ? (account.name || '') : String(req.body.name).trim();
            if (!nextName) return res.status(400).json({ error: 'Nome da conta não pode ficar vazio.' });
            const parsedRole = parseAdminAccountRole(req.body.role, account.role === 'professor' ? 'professor' : 'admin');
            if (!parsedRole.ok) return res.status(400).json({ error: parsedRole.error });
            const parsedClasses = parseAssignedClasses(req.body.assignedClasses);
            if (!parsedClasses.ok) return res.status(400).json({ error: parsedClasses.error });
            const parsedSchools = parseAssignmentIds(req.body.assignedSchoolIds, 'Escolas atribuídas');
            if (!parsedSchools.ok) return res.status(400).json({ error: parsedSchools.error });
            const parsedCourses = parseAssignmentIds(req.body.assignedCourseIds, 'Cursos atribuídos');
            if (!parsedCourses.ok) return res.status(400).json({ error: parsedCourses.error });
            const parsedPermissions = parseAdditionalPermissions(req.body.additionalPermissions);
            if (!parsedPermissions.ok) return res.status(400).json({ error: parsedPermissions.error });

            const nextRole = parsedRole.role;
            const nextAssignedClasses = nextRole === 'professor'
                ? (parsedClasses.classes === undefined ? (Array.isArray(account.assignedClasses) ? account.assignedClasses : []) : parsedClasses.classes)
                : [];
            const nextAssignedSchoolIds = nextRole === 'professor'
                ? (parsedSchools.ids === undefined ? (Array.isArray(account.assignedSchoolIds) ? account.assignedSchoolIds : []) : parsedSchools.ids)
                : [];
            const nextAssignedCourseIds = nextRole === 'professor'
                ? (parsedCourses.ids === undefined ? (Array.isArray(account.assignedCourseIds) ? account.assignedCourseIds : []) : parsedCourses.ids)
                : [];
            const invalid = findUnknownAssignedClass(nextAssignedClasses);
            if (nextRole === 'professor' && invalid) {
                return res.status(400).json({ error: `Turma inexistente: ${invalid.className}.` });
            }
            const invalidSchool = findUnknownSchool(nextAssignedSchoolIds);
            if (nextRole === 'professor' && invalidSchool) return res.status(400).json({ error: `Escola inexistente: ${invalidSchool}.` });
            const invalidCourse = findUnknownCourse(nextAssignedCourseIds);
            if (nextRole === 'professor' && invalidCourse) return res.status(400).json({ error: `Curso inexistente: ${invalidCourse}.` });
            const nextAdditionalPermissions = nextRole === 'professor'
                ? (parsedPermissions.permissions === undefined
                    ? (Array.isArray(account.additionalPermissions) ? account.additionalPermissions : [])
                    : parsedPermissions.permissions)
                : [];

            account.name = nextName;
            account.role = nextRole;
            account.assignedSchoolIds = nextAssignedSchoolIds;
            account.assignedCourseIds = nextAssignedCourseIds;
            account.assignedClasses = nextAssignedClasses;
            account.additionalPermissions = nextAdditionalPermissions;
            const assignmentsAfter = assignmentSnapshot(account);
            if (assignmentsBefore && JSON.stringify(assignmentsBefore) !== JSON.stringify(assignmentsAfter)) {
                recordAssignmentAudit(req, currentAdmin, email, assignmentsBefore, assignmentsAfter);
            }
            db.memory.admins = admins;
            await db.save();
            res.json({ success: true });
        });
    });

    router.get('/api/admin/whoami', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            const sessionToken = req.adminSessionToken || issueAdminSession(matchedAdmin.email);
            res.json({
                email: matchedAdmin.email,
                name: matchedAdmin.name || '',
                role: matchedAdmin.role || 'admin',
                assignedSchoolIds: Array.isArray(matchedAdmin.assignedSchoolIds) ? matchedAdmin.assignedSchoolIds : [],
                assignedCourseIds: Array.isArray(matchedAdmin.assignedCourseIds) ? matchedAdmin.assignedCourseIds : [],
                assignedClasses: Array.isArray(matchedAdmin.assignedClasses) ? matchedAdmin.assignedClasses : [],
                additionalPermissions: Array.isArray(matchedAdmin.additionalPermissions) ? matchedAdmin.additionalPermissions : [],
                mustChangePassword: matchedAdmin.mustChangePassword === true,
                sessionToken,
                instanceId: SERVER_INSTANCE_ID,
            });
        });
    });

    router.post('/api/session/logout', (req, res) => {
        validateAdmin(req, res, () => {
            if (req.adminSessionToken && db.memory.adminSessions) delete db.memory.adminSessions[req.adminSessionToken];
            res.json({ success: true });
        });
    });

    router.post('/api/admin/teacher-assignments', (req, res) => {
        validateAdmin(req, res, async (config, currentAdmin) => {
            if (!requireAdminManager(res, currentAdmin)) return;
            const email = String(req.body.email || '').trim().toLowerCase();
            if (!email) return res.status(400).json({ error: 'Professor não informado.' });
            const account = (db.memory.admins || []).find(item => item && String(item.email || '').toLowerCase() === email);
            if (!account || account.role !== 'professor') return res.status(404).json({ error: 'Professor não encontrado.' });

            const parsedSchools = parseAssignmentIds(req.body.assignedSchoolIds, 'Escolas atribuídas');
            const parsedCourses = parseAssignmentIds(req.body.assignedCourseIds, 'Cursos atribuídos');
            const parsedClasses = parseAssignedClasses(req.body.assignedClasses);
            if (!parsedSchools.ok) return res.status(400).json({ error: parsedSchools.error });
            if (!parsedCourses.ok) return res.status(400).json({ error: parsedCourses.error });
            if (!parsedClasses.ok) return res.status(400).json({ error: parsedClasses.error });

            const next = {
                assignedSchoolIds: parsedSchools.ids === undefined ? assignmentSnapshot(account).assignedSchoolIds : parsedSchools.ids,
                assignedCourseIds: parsedCourses.ids === undefined ? assignmentSnapshot(account).assignedCourseIds : parsedCourses.ids,
                assignedClasses: parsedClasses.classes === undefined ? assignmentSnapshot(account).assignedClasses : parsedClasses.classes,
            };
            const invalidSchool = findUnknownSchool(next.assignedSchoolIds);
            const invalidCourse = findUnknownCourse(next.assignedCourseIds);
            const invalidClass = findUnknownAssignedClass(next.assignedClasses);
            if (invalidSchool) return res.status(400).json({ error: `Escola inexistente: ${invalidSchool}.` });
            if (invalidCourse) return res.status(400).json({ error: `Curso inexistente: ${invalidCourse}.` });
            if (invalidClass) return res.status(400).json({ error: `Turma inexistente: ${invalidClass.className}.` });

            const before = assignmentSnapshot(account);
            account.assignedSchoolIds = next.assignedSchoolIds;
            account.assignedCourseIds = next.assignedCourseIds;
            account.assignedClasses = next.assignedClasses;
            recordAssignmentAudit(req, currentAdmin, email, before, assignmentSnapshot(account));
            await db.save();
            res.json({ success: true, assignments: assignmentSnapshot(account) });
        });
    });

    router.post('/api/admin/accounts/delete', (req, res) => {
        validateAdmin(req, res, async (config, currentAdmin) => {
            if (!requireAdminManager(res, currentAdmin)) return;
            const { email } = req.body;
            if (!email) return res.status(400).json({ error: 'E-mail não informado.' });
            const targetEmail = email.trim().toLowerCase();
            if (currentAdmin.email.toLowerCase() === targetEmail) {
                return res.status(400).json({ error: 'Você não pode excluir a sua própria conta conectada.' });
            }

            const admins = readJSON(DB_ADMINS_FILE);
            const target = admins.find(account => account.email && account.email.toLowerCase() === targetEmail);
            const adminCount = admins.filter(account => !account.role || account.role === 'admin').length;
            if (target && (!target.role || target.role === 'admin') && adminCount <= 1) {
                return res.status(400).json({ error: 'Não é possível excluir o único administrador cadastrado.' });
            }
            const filtered = admins.filter(account => !account.email || account.email.toLowerCase() !== targetEmail);
            if (admins.length === filtered.length) return res.status(404).json({ error: 'Administrador não encontrado.' });
            db.memory.admins = filtered;
            await db.save();
            res.json({ success: true, message: 'Administrador removido com sucesso!' });
        });
    });

    router.post('/api/admin/change-password', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            const { newPassword, currentPassword } = req.body;
            if (!newPassword || newPassword.trim().length < 10) {
                return res.status(400).json({ error: 'A nova senha deve ter pelo menos 10 caracteres.' });
            }
            // Fora da troca obrigatória inicial (mustChangePassword), exige a senha
            // atual — impede que uma sessão sequestrada troque a senha sem conhecê-la.
            if (matchedAdmin.mustChangePassword !== true) {
                if (!currentPassword || !db.verifyPassword(matchedAdmin.password, String(currentPassword).trim())) {
                    return res.status(400).json({ error: 'Senha atual incorreta.' });
                }
            }
            matchedAdmin.password = db.hashPassword(newPassword.trim());
            matchedAdmin.mustChangePassword = false;
            await db.save();
            res.json({ success: true, message: 'Senha atualizada com sucesso!' });
        });
    });

    router.get('/api/admin/preferences', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => res.json((matchedAdmin && matchedAdmin.preferences) || {}));
    });

    router.post('/api/admin/preferences', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            const account = (db.memory.admins || []).find(item => (
                item.email && matchedAdmin && item.email.toLowerCase() === String(matchedAdmin.email || '').toLowerCase()
            ));
            if (!account) return res.status(404).json({ error: 'Conta não encontrada.' });
            account.preferences = { ...(account.preferences || {}), ...(req.body || {}) };
            await db.save();
            res.json({ success: true, preferences: account.preferences });
        });
    });

    return router;
}

module.exports = { createAdminAccountsRouter };
