const express = require('express');
const crypto = require('crypto');
const path = require('path');
const db = require('../database.js');
const {
    DB_CLASSES_FILE,
    readJSON,
    validateAdmin,
    adminCanAccessClass,
    findClassByNameAndCourse,
    getCourseItemKeys,
    localIpAddresses,
    getReleasedItemsForClass,
} = require('../middlewares.js');
const settingsUtil = require('../utils/settings.js');
const { saveServerBackup } = require('../utils/backup.js');
const { ACTIVE_APPLICATION_STATUSES } = require('../utils/examApplications.js');
const { finishApplication } = require('../utils/examFinish.js');
const {
    applicationBelongsToClass,
    applicationSummary,
    applyExamStateFlush,
    classApplications,
    planClassReset,
    planExamStateFlush,
    sameClassName,
} = require('../utils/examMaintenance.js');

function normalizedEmail(value) {
    return String(value || '').trim().toLowerCase();
}

// Nome legível da prova (título da avaliação ou nome da unidade no curso).
function examTitleFor(examKey) {
    const evaluation = db.memory.evaluations?.[examKey];
    if (evaluation?.title || evaluation?.name) return evaluation.title || evaluation.name;
    for (const course of db.memory.courses || []) {
        for (const module of course?.structure || []) {
            const unit = (module?.units || module?.items || []).find(item => item?.avaliacaoKey === examKey);
            if (unit?.name || unit?.title) return unit.name || unit.title;
        }
    }
    return String(examKey || 'Prova').replace(/_/g, ' ');
}

function studentInClass(student, cls) {
    const memberships = Array.isArray(student?.classes) && student.classes.length
        ? student.classes
        : (student?.studentClass ? [student.studentClass] : []);
    return memberships.some(item => {
        const name = typeof item === 'string' ? item : (item && (item.name || item.className));
        const courseId = item && typeof item === 'object' ? item.courseId : (student.courseId || null);
        return !!name && sameClassName(name, cls.name) && (!courseId || !cls.courseId || String(courseId) === String(cls.courseId));
    });
}

// Alunos matriculados e provas do curso da turma (para estados de prova antigos,
// gravados sem aplicação nem turma).
function classHelpers(cls) {
    const emails = new Set((db.memory.students || []).filter(student => studentInClass(student, cls)).map(student => normalizedEmail(student.email)));
    return {
        isClassStudent: email => emails.has(normalizedEmail(email)),
        courseExamKeys: getCourseItemKeys(cls),
        examTitle: examTitleFor,
    };
}

// Turma (e aplicação) das ações de manutenção, conferida no servidor.
function maintenanceScope(req, matchedAdmin, { studentClass, courseId, applicationId }) {
    const cls = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId);
    if (!cls) return { status: 404, error: 'Turma não encontrada.' };
    if (!adminCanAccessClass(matchedAdmin, cls.name, cls.courseId)) return { status: 403, error: 'A turma solicitada não está atribuída a esta conta.' };
    let application = null;
    if (applicationId) {
        application = (db.memory.examApplications || []).find(item => item && item.id === String(applicationId).trim()) || null;
        if (!application || !applicationBelongsToClass(application, cls)) return { status: 404, error: 'Aplicação de prova não encontrada nesta turma.' };
    }
    return { cls, application };
}

// Backup dos dados antes de apagar qualquer coisa: a limpeza pode ser desfeita.
function safetyBackup(prefix) {
    try {
        return { ok: true, file: path.basename(saveServerBackup(prefix)) };
    } catch (error) {
        console.error(`[MANUTENÇÃO] Falha no backup de segurança (${prefix}):`, error.message);
        return { ok: false, file: null };
    }
}

function recordMaintenanceAudit(req, account, type, cls, details) {
    if (!Array.isArray(db.memory.auditLogs)) db.memory.auditLogs = [];
    db.memory.auditLogs.push({
        id: `audit_maintenance_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        type,
        actorEmail: account && account.email,
        studentClass: cls ? cls.name : null,
        courseId: cls ? cls.courseId || null : null,
        details,
        at: Date.now(),
        ip: req.ip || (req.socket && req.socket.remoteAddress) || '',
    });
}

function createAdminSystemRouter({ port = process.env.PORT || 3000 } = {}) {
    const router = express.Router();

    router.post('/api/admin/config', (req, res) => {
        validateAdmin(req, res, config => {
            const { studentClass, studentEmail, courseId } = req.body;
            const preferredIp = localIpAddresses.find(ip => !ip.name.toLowerCase().includes('virtualbox') && !ip.address.startsWith('192.168.56.'))
                || localIpAddresses[0]
                || { address: 'localhost' };
            const responseData = {
                activeExamKey: config.activeExamKey,
                releasedItems: config.releasedItems || {},
                serverUrl: `http://${preferredIp.address}:${port}`,
            };

            if (studentClass) {
                const classes = readJSON(DB_CLASSES_FILE);
                const cls = findClassByNameAndCourse(classes, studentClass, courseId);
                if (!cls) return res.status(404).json({ error: 'Turma nÃ£o encontrada.' });
                responseData.activeExamKey = cls.activeExamKey;
                responseData.activeExamQuestionCount = cls.activeExamQuestionCount || 20;
                responseData.examConfigs = cls.examConfigs || {};
                responseData.onlineExamConfigs = cls.onlineExamConfigs || {};
                responseData.releasedItems = getReleasedItemsForClass(cls, studentEmail);
            }
            res.json(responseData);
        });
    });

    // Prévia das ações de manutenção para a turma escolhida: o que cada uma apaga ou
    // encerra, para a confirmação mostrar ao professor antes de qualquer mudança.
    router.get('/api/admin/maintenance/preview', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            const restart = {
                activeApplications: (db.memory.examApplications || [])
                    .filter(application => application && ACTIVE_APPLICATION_STATUSES.has(application.status))
                    .filter(application => adminCanAccessClass(matchedAdmin, application.studentClass, application.courseId))
                    .map(application => ({ ...applicationSummary(application, examTitleFor), studentClass: application.studentClass })),
            };
            const studentClass = String(req.query.studentClass || '').trim();
            if (!studentClass) return res.json({ success: true, restart, flush: null, reset: null, applications: [] });
            const scope = maintenanceScope(req, matchedAdmin, { studentClass, courseId: req.query.courseId, applicationId: req.query.applicationId });
            if (scope.error) return res.status(scope.status).json({ error: scope.error });
            const { cls, application } = scope;
            const helpers = classHelpers(cls);
            const flushPlan = planExamStateFlush(db.memory, { cls, application, ...helpers });
            const resetPlan = planClassReset(db.memory, { cls, ...helpers });
            res.json({
                success: true,
                studentClass: cls.name,
                courseId: cls.courseId || null,
                restart,
                applications: classApplications(db.memory, cls).map(item => applicationSummary(item, examTitleFor)),
                flush: {
                    applicationId: flushPlan.applicationId,
                    blockedBy: flushPlan.blockedBy,
                    counts: flushPlan.counts,
                    preserved: flushPlan.preserved,
                },
                reset: {
                    activeApplications: resetPlan.activeApplications,
                    counts: resetPlan.counts,
                    preserved: resetPlan.preserved,
                },
            });
        });
    });

    // "Limpar estado de prova": só na turma escolhida (e, se informada, numa aplicação
    // dela), com confirmação digitada, nunca com prova em andamento e sem apagar logs
    // de monitoramento, histórico de digitação, entregas ou notas (UXI-02, CONF-10, OPS-X3).
    router.post('/api/admin/flush-exam-state', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            const { studentClass, courseId, applicationId, examKey, studentEmail } = req.body || {};
            if (!String(studentClass || '').trim()) {
                return res.status(400).json({ error: 'Escolha a turma: a limpeza do estado de prova vale só para uma turma.' });
            }
            const scope = maintenanceScope(req, matchedAdmin, { studentClass, courseId, applicationId });
            if (scope.error) return res.status(scope.status).json({ error: scope.error });
            if (String(req.body.confirm || '').trim().toUpperCase() !== 'LIMPAR') {
                return res.status(400).json({ error: 'Digite LIMPAR para confirmar a limpeza do estado de prova.', confirmationRequired: true });
            }
            const { cls, application } = scope;
            const plan = planExamStateFlush(db.memory, { cls, application, examKey, studentEmail, ...classHelpers(cls) });
            if (plan.blockedBy.length) {
                const names = plan.blockedBy.map(item => item.examTitle).join(', ');
                return res.status(409).json({
                    error: `Há uma aplicação em andamento nesta turma (${names}). Encerre-a pelo Monitor antes de limpar o estado de prova.`,
                    blockedBy: plan.blockedBy,
                });
            }
            const clearedCount = plan.counts.examStates + plan.counts.messages;
            if (clearedCount === 0) {
                return res.json({ success: true, clearedCount: 0, message: `Nada para limpar na turma ${cls.name}.` });
            }
            const backup = safetyBackup('antes-limpeza-prova');
            if (!backup.ok) return res.status(500).json({ error: 'Não foi possível salvar o backup de segurança; nada foi apagado.' });
            const removed = applyExamStateFlush(db.memory, plan);
            recordMaintenanceAudit(req, matchedAdmin, 'exam_state_flushed', cls, {
                applicationId: plan.applicationId,
                examKey: plan.examKey || (examKey ? String(examKey) : null),
                studentEmail: plan.studentEmail,
                ...removed,
                pendingAnswers: plan.counts.pendingAnswers,
                preserved: plan.preserved,
                backup: backup.file,
            });
            await db.save();
            console.log(`[FLUSH] Estado de prova limpo na turma ${cls.name}: ${clearedCount} registros removidos.`);
            res.json({
                success: true,
                clearedCount,
                ...removed,
                backup: backup.file,
                message: `Estado de prova limpo na turma ${cls.name}: ${removed.removedStates} estado(s) de tentativa e ${removed.removedMessages} mensagem(ns) removidos. Logs de monitoramento e histórico de digitação foram preservados.`,
            });
        });
    });

    router.post('/api/admin/server/restart', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            // Reiniciar derruba a conexão de todos os alunos: só com confirmação explícita.
            if (String((req.body || {}).confirm || '').trim().toUpperCase() !== 'REINICIAR') {
                return res.status(400).json({ error: 'Confirme o reinício do servidor.', confirmationRequired: true });
            }
            recordMaintenanceAudit(req, matchedAdmin, 'server_restart_requested', null, {
                activeApplications: (db.memory.examApplications || []).filter(item => item && ACTIVE_APPLICATION_STATUSES.has(item.status)).length,
            });
            try { await db.save(); } catch (_) {}
            res.json({ success: true, message: 'Servidor reiniciando...' });
            const serverInstance = req.app.get('serverInstance');

            const spawnRestart = () => {
                console.log('Iniciando processo de reinicialização...');
                const { spawn } = require('child_process');
                const child = spawn('cmd.exe', ['/c', 'ping 127.0.0.1 -n 3 >nul && node backend/server.js'], {
                    detached: true,
                    stdio: 'ignore',
                    cwd: process.cwd(),
                    shell: true,
                });
                child.unref();
                process.exit(0);
            };

            if (serverInstance) {
                serverInstance.close(() => {
                    console.log('Porta liberada.');
                    spawnRestart();
                });
            }

            setTimeout(() => {
                console.log('Forçando reinicialização do servidor por timeout...');
                spawnRestart();
            }, 2000);
        });
    });

    // "Resetar sala": só na turma escolhida e com a confirmação RESETAR conferida no
    // servidor. As provas em andamento da turma são encerradas salvando as respostas
    // (viram entrega), o que sobrar de estado de prova e as mensagens da turma são
    // limpos e os alunos dela são desconectados. Logs, digitação e notas ficam (CONF-X3).
    router.post('/api/admin/reset', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            const { studentClass, courseId } = req.body || {};
            if (!String(studentClass || '').trim()) {
                return res.status(400).json({ error: 'Escolha a turma: o reset vale só para uma turma.' });
            }
            const scope = maintenanceScope(req, matchedAdmin, { studentClass, courseId });
            if (scope.error) return res.status(scope.status).json({ error: scope.error });
            if (String(req.body.confirm || '').trim().toUpperCase() !== 'RESETAR') {
                return res.status(400).json({ error: 'Digite RESETAR para confirmar o reset da sala.', confirmationRequired: true });
            }
            const { cls } = scope;
            const helpers = classHelpers(cls);
            const backup = safetyBackup('antes-resetar-sala');
            if (!backup.ok) return res.status(500).json({ error: 'Não foi possível salvar o backup de segurança; nada foi alterado.' });

            const actor = (matchedAdmin && (matchedAdmin.email || matchedAdmin.name)) || 'Administrador';
            const finished = [];
            classApplications(db.memory, cls)
                .filter(application => ACTIVE_APPLICATION_STATUSES.has(application.status))
                .forEach(application => {
                    const processed = finishApplication(db.memory, { application, cls, policy: 'submit', actor, reason: 'reset_sala' });
                    finished.push({ applicationId: application.id, examKey: application.examKey, submitted: processed.submitted, deliveredAtDeadline: processed.deliveredAtDeadline });
                });

            // Sobras: estados de prova sem aplicação em andamento e mensagens da turma.
            const removed = applyExamStateFlush(db.memory, planExamStateFlush(db.memory, { cls, ...helpers }));

            // Configurações antigas (sem aplicação) que ficaram marcadas como ativas.
            let legacyConfigs = 0;
            Object.values(cls.onlineExamConfigs || {}).forEach(examConfig => {
                if (!examConfig || !['running', 'waiting', 'paused'].includes(examConfig.status)) return;
                const application = examConfig.applicationId
                    ? (db.memory.examApplications || []).find(item => item && item.id === examConfig.applicationId)
                    : null;
                if (application) return;
                examConfig.status = 'not_applied';
                examConfig.onlineActive = false;
                examConfig.startTime = null;
                examConfig.waitingRoomStartTimestamp = null;
                examConfig.updatedAt = new Date().toISOString();
                legacyConfigs += 1;
            });
            const stillActive = classApplications(db.memory, cls).some(item => ACTIVE_APPLICATION_STATUSES.has(item.status));
            if (!stillActive) {
                cls.activeExamKey = null;
                cls.activeApplicationId = null;
            }

            const disconnected = Object.keys(db.memory.sessions || {}).filter(email => helpers.isClassStudent(email));
            disconnected.forEach(email => { delete db.memory.sessions[email]; });

            const submitted = finished.reduce((total, item) => total + item.submitted + item.deliveredAtDeadline, 0);
            recordMaintenanceAudit(req, matchedAdmin, 'class_reset', cls, {
                finishedApplications: finished,
                ...removed,
                disconnectedStudents: disconnected.length,
                legacyConfigs,
                backup: backup.file,
            });
            await db.save();
            res.json({
                success: true,
                finishedApplications: finished.length,
                submitted,
                ...removed,
                disconnectedStudents: disconnected.length,
                backup: backup.file,
                message: `Sala ${cls.name} resetada: ${finished.length} prova(s) em andamento encerrada(s) com as respostas salvas (${submitted} entrega(s)), ${disconnected.length} aluno(s) desconectado(s), ${removed.removedStates} estado(s) de prova e ${removed.removedMessages} mensagem(ns) limpos. Conteúdos liberados, notas e logs foram preservados.`,
            });
        });
    });

    router.get('/api/admin/settings', (req, res) => {
        validateAdmin(req, res, () => res.json(settingsUtil.getSettings()));
    });

    router.post('/api/admin/settings', (req, res) => {
        validateAdmin(req, res, async () => {
            if (!db.memory.config) db.memory.config = {};
            db.memory.config.settings = settingsUtil.mergeSettings(req.body || {});
            await db.save();
            res.json({ success: true, settings: db.memory.config.settings });
        });
    });

    return router;
}

module.exports = { createAdminSystemRouter };
