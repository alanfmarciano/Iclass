const crypto = require('crypto');
const express = require('express');
const db = require('../database.js');
const { issueAdminSession, normalizeIp, SERVER_INSTANCE_ID } = require('../middlewares.js');
const { DEMO_ACCOUNTS } = require('../utils/demoAccounts.js');

const DEFAULT_TTL_MS = 60 * 60 * 1000;

function isLoopbackAddress(address) {
    const value = String(address || '').toLowerCase();
    return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function constantTimeEqual(received, expected) {
    const left = Buffer.from(String(received || ''), 'utf8');
    const right = Buffer.from(String(expected || ''), 'utf8');
    if (left.length !== right.length || left.length === 0) return false;
    return crypto.timingSafeEqual(left, right);
}

function findAccountByEmail(accounts, email) {
    const expectedEmail = String(email || '').trim().toLowerCase();
    return (accounts || []).find(item => String(item?.email || '').trim().toLowerCase() === expectedEmail);
}

function normalizeStudentForQuickAccess(student) {
    const { password, ...safeStudent } = student;
    const classes = [];
    const courses = [];
    const rawClasses = Array.isArray(student.classes) && student.classes.length
        ? student.classes
        : (student.studentClass ? [student.studentClass] : []);
    rawClasses.forEach(value => {
        const className = typeof value === 'string' ? value : String(value?.name || '');
        if (!className) return;
        const linkedClass = (db.memory.classes || []).find(item => item.name === className
            && (!value?.courseId || item.courseId === value.courseId));
        const courseId = typeof value === 'object' && value?.courseId ? value.courseId : linkedClass?.courseId || null;
        const period = typeof value === 'object' && value?.period ? value.period : linkedClass?.period || student.period || null;
        const course = courseId ? (db.memory.courses || []).find(item => item.id === courseId) : null;
        if (course && (course.deleted === true || course.status === 'deleted' || course.status === 'inactive' || course.deletedAt)) return;
        classes.push({ name: className, courseId, period });
        if (course && !courses.some(item => item.id === course.id)) {
            courses.push({ id: course.id, name: course.name, description: course.description, className });
        }
    });
    safeStudent.classes = classes;
    safeStudent.courses = courses;
    safeStudent.studentClass = classes[0]?.name || '';
    return safeStudent;
}

function createSetupModeRouter(options = {}) {
    const router = express.Router();
    const enabled = options.enabled !== undefined ? options.enabled : process.env.ICLASS_ADMIN_SETUP_MODE === '1';
    const expectedToken = options.setupToken !== undefined ? options.setupToken : process.env.ICLASS_ADMIN_SETUP_TOKEN;
    const now = options.now || Date.now;
    const startedAt = options.startedAt !== undefined ? options.startedAt : now();
    const ttlMs = options.ttlMs || DEFAULT_TTL_MS;
    let consumed = false;

    function validateLocalToken(req, res) {
        const remoteAddress = req.socket && req.socket.remoteAddress;
        if (!enabled || !expectedToken) {
            res.status(404).json({ error: 'Acesso rápido local indisponível.' });
            return false;
        }
        if (!isLoopbackAddress(remoteAddress)) {
            res.status(403).json({ error: 'Acesso permitido somente neste computador.' });
            return false;
        }
        if (now() - startedAt > ttlMs) {
            res.status(410).json({ error: 'Autorização local expirada. Reinicie a opção 5.' });
            return false;
        }
        if (!constantTimeEqual(req.body && req.body.token, expectedToken)) {
            res.status(403).json({ error: 'Autorização local inválida.' });
            return false;
        }
        return true;
    }

    router.post('/api/setup/quick-session', async (req, res) => {
        if (!validateLocalToken(req, res)) return;
        const profile = String(req.body?.profile || '').trim().toLowerCase();
        if (!['admin', 'professor', 'student'].includes(profile)) {
            return res.status(400).json({ error: 'Perfil de acesso rápido inválido.' });
        }

        const remoteAddress = req.socket && req.socket.remoteAddress;
        let response;
        let actorEmail;
        if (profile === 'student') {
            const expectedStudent = DEMO_ACCOUNTS.student;
            const student = findAccountByEmail(db.memory.students, expectedStudent.email);
            const studentStatus = String(student?.status || '').trim().toLowerCase();
            if (!student || !['ativo', 'active'].includes(studentStatus)) {
                return res.status(404).json({ error: `A conta oficial de aluno ${expectedStudent.email} não está cadastrada ou ativa.` });
            }
            const email = String(student.email).trim().toLowerCase();
            const sessionToken = crypto.randomUUID();
            const clientIp = normalizeIp(remoteAddress);
            db.memory.sessions = db.memory.sessions || {};
            db.memory.sessions[email] = {
                lastSeen: now(), createdAt: now(), ip: clientIp, token: sessionToken,
            };
            student.lastLoginAt = now();
            student.lastLoginIp = clientIp;
            actorEmail = email;
            response = {
                sessionType: 'student', role: 'student', email,
                student: normalizeStudentForQuickAccess(student), sessionToken, instanceId: SERVER_INSTANCE_ID,
                localSetupMode: true,
            };
        } else {
            const expectedAccount = DEMO_ACCOUNTS[profile];
            const admin = findAccountByEmail(db.memory.admins, expectedAccount.email);
            const actualRole = String(admin?.role || 'admin').toLowerCase();
            const hasExpectedRole = profile === 'professor' ? actualRole === 'professor' : actualRole !== 'professor';
            if (!admin || !hasExpectedRole) {
                return res.status(404).json({ error: `A conta oficial de ${profile === 'professor' ? 'professor' : 'administrador'} ${expectedAccount.email} não está cadastrada corretamente.` });
            }
            actorEmail = String(admin.email).trim().toLowerCase();
            response = {
                sessionType: 'admin', email: actorEmail, name: admin.name || '', role: admin.role || 'admin',
                assignedSchoolIds: Array.isArray(admin.assignedSchoolIds) ? admin.assignedSchoolIds : [],
                assignedCourseIds: Array.isArray(admin.assignedCourseIds) ? admin.assignedCourseIds : [],
                assignedClasses: Array.isArray(admin.assignedClasses) ? admin.assignedClasses : [],
                additionalPermissions: Array.isArray(admin.additionalPermissions) ? admin.additionalPermissions : [],
                mustChangePassword: admin.mustChangePassword === true,
                sessionToken: issueAdminSession(actorEmail), instanceId: SERVER_INSTANCE_ID, localSetupMode: true,
            };
        }

        if (!Array.isArray(db.memory.auditLogs)) db.memory.auditLogs = [];
        db.memory.auditLogs.push({
            id: `audit_quick_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
            type: 'local_quick_login', profile, actorEmail, at: new Date().toISOString(), ip: remoteAddress,
        });
        await db.save();
        res.json(response);
    });

    router.post('/api/setup/admin-session', async (req, res) => {
        if (!enabled || !expectedToken) return res.status(404).json({ error: 'Modo administrativo local indisponível.' });
        const remoteAddress = req.socket && req.socket.remoteAddress;
        if (!isLoopbackAddress(remoteAddress)) return res.status(403).json({ error: 'Acesso permitido somente neste computador.' });
        if (consumed) return res.status(410).json({ error: 'Autorização administrativa já utilizada.' });
        if (now() - startedAt > ttlMs) return res.status(410).json({ error: 'Autorização administrativa expirada.' });
        if (!constantTimeEqual(req.body && req.body.token, expectedToken)) {
            return res.status(403).json({ error: 'Autorização administrativa inválida.' });
        }

        const eligibleAdmins = (db.memory.admins || []).filter(account => account && account.email && (!account.role || account.role === 'admin'));
        const admin = eligibleAdmins.find(account => account.mustChangePassword !== true) || eligibleAdmins[0];
        if (!admin) return res.status(503).json({ error: 'Nenhuma conta administradora disponível.' });

        consumed = true;
        const sessionToken = issueAdminSession(admin.email);
        if (!Array.isArray(db.memory.auditLogs)) db.memory.auditLogs = [];
        db.memory.auditLogs.push({
            id: `audit_setup_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
            type: 'admin_local_setup_login',
            actorEmail: admin.email,
            targetEmail: admin.email,
            at: new Date().toISOString(),
            ip: remoteAddress,
        });
        await db.save();

        res.json({
            email: admin.email,
            name: admin.name || '',
            role: admin.role || 'admin',
            assignedSchoolIds: Array.isArray(admin.assignedSchoolIds) ? admin.assignedSchoolIds : [],
            assignedCourseIds: Array.isArray(admin.assignedCourseIds) ? admin.assignedCourseIds : [],
            assignedClasses: Array.isArray(admin.assignedClasses) ? admin.assignedClasses : [],
            additionalPermissions: Array.isArray(admin.additionalPermissions) ? admin.additionalPermissions : [],
            mustChangePassword: admin.mustChangePassword === true,
            sessionToken,
            instanceId: SERVER_INSTANCE_ID,
            localSetupMode: true,
        });
    });

    return router;
}

module.exports = createSetupModeRouter();
module.exports.createSetupModeRouter = createSetupModeRouter;
module.exports.isLoopbackAddress = isLoopbackAddress;
