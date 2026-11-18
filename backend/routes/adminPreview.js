// Pré-visualização como aluno pelo painel (fase 3, P5-S6a, CRIT-08).
//
// POST /api/admin/preview-sessions      abre uma sessão de leitura de uma turma
//   corpo { courseId, studentClass, groupId? }; resposta { success, previewToken, expiraEm,
//   rotulo, aluno } (aluno no formato do perfil do login, com preview: true). Permissão
//   ['page.materials', 'page.classes'] e escopo da turma (adminRbacGuard e de novo aqui);
//   a coordenação (só consulta) recebe 403 read_only_account no guarda. Auditoria
//   content_preview_started.
// POST /api/admin/preview-sessions/end  encerra a prévia do cabeçalho x-preview-session
//   (se for desta conta) ou, sem ele, todas as prévias da conta; fora da auditoria.
//
// A sessão fica só na memória (utils/authSessions.js createPreviewSession): 60 min,
// ligada à sessão do instrutor que a abriu. O que ela pode ler está em
// utils/previewAccess.js (PREVIEW_READ_ROUTES).
const express = require('express');
const db = require('../database.js');
const { adminCanAccessClass, findClassByNameAndCourse, validateAdmin } = require('../middlewares.js');
const { outOfScopeMessage } = require('../utils/adminRoles.js');
const { recordAudit } = require('../utils/audit.js');
const { createPreviewSession, endPreviewSession, endPreviewSessionsOf } = require('../utils/authSessions.js');
const {
    accountStamp,
    buildPreviewStudent,
    findPreviewGroup,
    previewLabel,
    previewToken,
} = require('../utils/previewAccess.js');
const { studentSessionProfile } = require('../utils/studentProfile.js');
const { body, str } = require('../utils/inputSchema.js');
const { isCourseDeleted } = require('../utils/contentAccess.js');

const PREVIEW_SCHEMAS = {
    create: body({
        courseId: str({ max: 100, required: true, label: 'curso' }),
        studentClass: str({ max: 100, required: true, label: 'turma' }),
        groupId: str({ max: 100, nullable: true, label: 'grupo' }),
    }),
    end: body({}),
};

function createAdminPreviewRouter() {
    const router = express.Router();

    router.post('/api/admin/preview-sessions', PREVIEW_SCHEMAS.create, (req, res) => validateAdmin(req, res, async (config, account) => {
        const courseId = String(req.body.courseId || '').trim();
        const studentClass = String(req.body.studentClass || '').trim();
        const groupId = req.body.groupId ? String(req.body.groupId).trim() : '';
        const course = (db.memory.courses || []).find(item => item && String(item.id) === courseId);
        const cls = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId);
        if (!course || isCourseDeleted(course) || !cls || String(cls.courseId || '') !== courseId) {
            return res.status(404).json({ success: false, error: 'Turma não encontrada.' });
        }
        // O guarda já conferiu o escopo pelo corpo; a turma achada é conferida de novo.
        if (!adminCanAccessClass(account, cls.name, cls.courseId)) {
            return res.status(403).json({ success: false, error: outOfScopeMessage(account, 'A turma solicitada') });
        }
        const group = groupId ? findPreviewGroup(db.memory, { courseId, studentClass: cls.name, groupId }) : null;
        if (groupId && !group) {
            return res.status(404).json({ success: false, error: 'Grupo não encontrado nesta turma.', field: 'groupId' });
        }

        const { token, session } = createPreviewSession(db.memory, {
            adminToken: req.adminSessionToken,
            courseId: cls.courseId,
            studentClass: cls.name,
            groupId: group ? group.id : null,
            accountStamp: accountStamp(account),
        });
        recordAudit(db.memory, {
            req,
            actor: account,
            action: 'content_preview_started',
            category: 'content',
            courseId: cls.courseId,
            studentClass: cls.name,
            details: { groupId: group ? group.id : null },
        });
        await db.save({ only: ['auditLogs'] });

        const student = buildPreviewStudent(session, cls);
        res.json({
            success: true,
            previewToken: token,
            expiraEm: session.expiresAt,
            rotulo: previewLabel(cls.name, group),
            aluno: {
                ...studentSessionProfile(student),
                courses: [{ id: course.id, name: course.name || course.id, description: course.description || '', className: cls.name }],
                preview: true,
                previewGroupId: group ? group.id : null,
            },
        });
    }));

    router.post('/api/admin/preview-sessions/end', PREVIEW_SCHEMAS.end, (req, res) => validateAdmin(req, res, (config, account) => {
        const token = previewToken(req);
        const ended = token
            ? (endPreviewSession(db.memory, token, { adminEmail: account.email }) ? 1 : 0)
            : endPreviewSessionsOf(db.memory, account.email);
        res.json({ success: true, encerradas: ended });
    }));

    return router;
}

module.exports = { createAdminPreviewRouter };
