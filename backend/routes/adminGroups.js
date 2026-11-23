// ---------------------------------------------------------------------------
// Grupos de alunos pelo painel (fase 3, P5-S4, CRIT-11; D16 e D17 do P5).
//
// GET  /api/admin/class-groups?courseId&studentClass&arquivados=0|1   grupos da turma
// POST /api/admin/class-groups                     cria (nome, conjunto, tipo, membros)
// POST /api/admin/class-groups/draw                sorteio: proposta (confirmar false) ou
//                                                  cria a proposta da semente (confirmar true)
// POST /api/admin/class-groups/:id/update          nome, conjunto, tipo, adicionar, remover
//                                                  (atualizadoEm da leitura; mover: true tira
//                                                  do outro grupo do conjunto quem entra)
// POST /api/admin/class-groups/:id/archive         arquiva (motivo opcional)
// POST /api/admin/class-groups/:id/restore         reativa
//
// Regras:
// - Permissão 'page.students' no guarda (adminPermissions.js, regra /class-groups). A
//   coordenação (só consulta) vê pelo GET; o POST dela recebe 403 read_only_account no
//   guarda. Escopo: a turma do corpo ou da query no guarda e de novo aqui; nas rotas com
//   :id, a turma DO REGISTRO do grupo (validateProfessorRequestScope e aqui).
// - As regras e a gravação na memória ficam em utils/classGroups.js (contrato
//   "classGroups": grupos só por lá); aqui só a entrada, o escopo, a auditoria e a
//   gravação parcial db.save({ only: ['classGroups', 'auditLogs'] }).
// - Auditoria na mesma gravação (categoria 'academic'): class_group_created,
//   class_group_updated (adicionados e removidos por e-mail, nome antes e depois; também
//   no grupo de onde o "Mover para" tirou o aluno), class_group_archived (motivo),
//   class_group_restored e class_groups_drawn (conjunto, grupos, alunos, semente).
//   Pedido que não muda nada não grava nem registra.
// ---------------------------------------------------------------------------
const express = require('express');
const db = require('../database.js');
const { adminCanAccessClass, findClassByNameAndCourse, validateAdmin } = require('../middlewares.js');
const { outOfScopeMessage } = require('../utils/adminRoles.js');
const { recordAudit } = require('../utils/audit.js');
const { isCourseDeleted } = require('../utils/contentAccess.js');
const groupRules = require('../utils/classGroups.js');
const { body, bool, int, list, oneOf, str } = require('../utils/inputSchema.js');

const { LIMITS } = groupRules;
const EMAIL_MAX = 254;
const emailList = label => list(str({ max: EMAIL_MAX, label }), { max: LIMITS.membersPerGroup, label });

const SCHEMAS = Object.freeze({
    create: body({
        courseId: str({ max: 100, required: true, label: 'curso' }),
        studentClass: str({ max: 100, required: true, label: 'turma' }),
        nome: str({ max: LIMITS.nameMax, label: 'nome do grupo' }),
        conjunto: str({ max: LIMITS.setMax, label: 'conjunto' }),
        tipo: oneOf(groupRules.GROUP_TYPES, { label: 'tipo' }),
        membros: emailList('membros'),
    }),
    update: body({
        nome: str({ max: LIMITS.nameMax, label: 'nome do grupo' }),
        conjunto: str({ max: LIMITS.setMax, label: 'conjunto' }),
        tipo: oneOf(groupRules.GROUP_TYPES, { label: 'tipo' }),
        adicionar: emailList('adicionar'),
        remover: emailList('remover'),
        atualizadoEm: int({ min: 0, required: true, label: 'versão do grupo' }),
        mover: bool({ label: 'mover' }),
    }),
    archive: body({
        motivo: str({ max: LIMITS.reasonMax, label: 'motivo' }),
    }),
    restore: body({}),
    draw: body({
        courseId: str({ max: 100, required: true, label: 'curso' }),
        studentClass: str({ max: 100, required: true, label: 'turma' }),
        conjunto: str({ max: LIMITS.setMax, label: 'conjunto' }),
        tipo: oneOf(groupRules.GROUP_TYPES, { label: 'tipo' }),
        criterio: oneOf(groupRules.DRAW_CRITERIA, { required: true, label: 'critério' }),
        valor: int({ min: LIMITS.drawMin, max: LIMITS.drawMax, required: true, coerce: true, label: 'valor' }),
        nomeBase: str({ max: LIMITS.drawBaseMax, label: 'começo do nome' }),
        somenteSemGrupo: bool({ label: 'só quem está sem grupo' }),
        confirmar: bool({ label: 'confirmar' }),
        semente: str({ max: LIMITS.seedMax, label: 'semente' }),
        assinatura: str({ max: 64, label: 'assinatura' }),
    }),
});

function sendFailure(res, result) {
    const payload = { success: false, error: result.error };
    if (result.field) payload.field = result.field;
    if (result.code) payload.code = result.code;
    if (result.groupId) payload.groupId = result.groupId;
    return res.status(result.status || 400).json(payload);
}

// Turma do pedido (corpo ou query), existente, de curso ativo e no escopo da conta.
function scopedClass(res, account, courseIdValue, studentClassValue) {
    const courseId = String(courseIdValue || '').trim();
    const studentClass = String(studentClassValue || '').trim();
    const cls = courseId && studentClass ? findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId) : null;
    const course = cls ? (db.memory.courses || []).find(item => item && String(item.id) === String(cls.courseId)) : null;
    if (!cls || !course || isCourseDeleted(course)) {
        sendFailure(res, { status: 404, error: 'Turma não encontrada.', field: 'studentClass' });
        return null;
    }
    if (!adminCanAccessClass(account, cls.name, cls.courseId)) {
        sendFailure(res, { status: 403, error: outOfScopeMessage(account, 'A turma solicitada'), field: 'studentClass' });
        return null;
    }
    return cls;
}

// Grupo do caminho, com a turma dele existente e no escopo da conta.
function scopedGroup(req, res, account) {
    const id = typeof req.params.id === 'string' ? req.params.id : '';
    const group = groupRules.GROUP_ID_PATTERN.test(id) ? groupRules.findGroup(db.memory, id) : null;
    if (!group) {
        sendFailure(res, { status: 404, error: 'Grupo não encontrado.', code: 'group_not_found' });
        return null;
    }
    if (!adminCanAccessClass(account, group.studentClass, group.courseId)) {
        sendFailure(res, { status: 403, error: outOfScopeMessage(account, 'O grupo solicitado') });
        return null;
    }
    const cls = groupRules.classOfGroup(db.memory, group);
    if (!cls) {
        sendFailure(res, { status: 404, error: 'A turma deste grupo não existe mais.', code: 'class_not_found' });
        return null;
    }
    return { group, cls };
}

function audit(req, account, action, group, details) {
    recordAudit(db.memory, {
        req,
        actor: account,
        action,
        category: 'academic',
        courseId: group.courseId,
        studentClass: group.studentClass,
        details,
    });
}

function view(group) {
    return groupRules.presentGroup(db.memory, group);
}

function createAdminGroupsRouter() {
    const router = express.Router();

    router.get('/api/admin/class-groups', (req, res) => validateAdmin(req, res, (config, account) => {
        const query = req.query || {};
        const cls = scopedClass(res, account, query.courseId, query.studentClass);
        if (!cls) return undefined;
        const includeArchived = ['1', 'true', 'sim'].includes(String(query.arquivados || '').trim().toLowerCase());
        res.set('Cache-Control', 'no-store');
        const course = (db.memory.courses || []).find(item => item && String(item.id) === String(cls.courseId));
        return res.json({
            success: true,
            turma: { courseId: cls.courseId, nome: cls.name, curso: (course && course.name) || cls.courseId },
            ...groupRules.classGroupsView(db.memory, cls, { includeArchived }),
            limites: LIMITS,
        });
    }));

    router.post('/api/admin/class-groups', SCHEMAS.create, (req, res) => validateAdmin(req, res, async (config, account) => {
        const cls = scopedClass(res, account, req.body.courseId, req.body.studentClass);
        if (!cls) return undefined;
        const result = groupRules.createGroup(db.memory, cls, req.body, { actor: account });
        if (!result.ok) return sendFailure(res, result);
        const { group } = result;
        audit(req, account, 'class_group_created', group, {
            groupId: group.id,
            nome: group.nome,
            conjunto: group.conjunto,
            tipo: group.tipo,
            membros: group.membros.length,
        });
        await db.save({ only: ['classGroups', 'auditLogs'] });
        return res.status(201).json({ success: true, grupo: view(group) });
    }));

    router.post('/api/admin/class-groups/draw', SCHEMAS.draw, (req, res) => validateAdmin(req, res, async (config, account) => {
        const cls = scopedClass(res, account, req.body.courseId, req.body.studentClass);
        if (!cls) return undefined;
        if (req.body.confirmar !== true) {
            const draw = groupRules.drawProposal(db.memory, cls, req.body);
            if (!draw.ok) return sendFailure(res, draw);
            return res.json({
                success: true,
                proposta: draw.proposta,
                semente: draw.semente,
                assinatura: draw.assinatura,
                conjunto: draw.conjunto,
                tipo: draw.tipo,
                criterio: draw.criterio,
                valor: draw.valor,
                alunos: draw.alunos,
            });
        }
        const result = groupRules.confirmDraw(db.memory, cls, req.body, { actor: account });
        if (!result.ok) return sendFailure(res, result);
        recordAudit(db.memory, {
            req,
            actor: account,
            action: 'class_groups_drawn',
            category: 'academic',
            courseId: cls.courseId,
            studentClass: cls.name,
            details: {
                conjunto: result.draw.conjunto,
                tipo: result.draw.tipo,
                criterio: result.draw.criterio,
                valor: result.draw.valor,
                grupos: result.groups.length,
                alunos: result.draw.alunos,
                semente: result.draw.semente,
                groupIds: result.groups.map(group => group.id),
            },
        });
        await db.save({ only: ['classGroups', 'auditLogs'] });
        return res.status(201).json({ success: true, grupos: result.groups.map(view) });
    }));

    router.post('/api/admin/class-groups/:id/update', SCHEMAS.update, (req, res) => validateAdmin(req, res, async (config, account) => {
        const found = scopedGroup(req, res, account);
        if (!found) return undefined;
        const result = groupRules.updateGroup(db.memory, found.group.id, req.body, { actor: account });
        if (!result.ok) return sendFailure(res, result);
        if (!result.changed) return res.json({ success: true, changed: false, grupo: view(result.group) });
        const { group } = result;
        const details = { groupId: group.id, adicionados: result.adicionados, removidos: result.removidos };
        if (result.antes.nome !== result.depois.nome) details.nome = { antes: result.antes.nome, depois: result.depois.nome };
        if (result.antes.conjunto !== result.depois.conjunto) details.conjunto = { antes: result.antes.conjunto, depois: result.depois.conjunto };
        if (result.antes.tipo !== result.depois.tipo) details.tipo = { antes: result.antes.tipo, depois: result.depois.tipo };
        audit(req, account, 'class_group_updated', group, details);
        result.movidos.forEach(({ group: source, emails }) => {
            audit(req, account, 'class_group_updated', source, { groupId: source.id, adicionados: [], removidos: emails, movidosPara: group.id });
        });
        await db.save({ only: ['classGroups', 'auditLogs'] });
        return res.json({
            success: true,
            changed: true,
            grupo: view(group),
            alterados: result.movidos.map(({ group: source }) => view(source)),
        });
    }));

    router.post('/api/admin/class-groups/:id/archive', SCHEMAS.archive, (req, res) => validateAdmin(req, res, async (config, account) => {
        const found = scopedGroup(req, res, account);
        if (!found) return undefined;
        const result = groupRules.archiveGroup(db.memory, found.group.id, { actor: account });
        if (!result.ok) return sendFailure(res, result);
        if (!result.changed) return res.json({ success: true, changed: false, grupo: view(result.group) });
        audit(req, account, 'class_group_archived', result.group, {
            groupId: result.group.id,
            nome: result.group.nome,
            motivo: groupRules.cleanReason(req.body.motivo) || null,
        });
        await db.save({ only: ['classGroups', 'auditLogs'] });
        return res.json({ success: true, changed: true, grupo: view(result.group) });
    }));

    router.post('/api/admin/class-groups/:id/restore', SCHEMAS.restore, (req, res) => validateAdmin(req, res, async (config, account) => {
        const found = scopedGroup(req, res, account);
        if (!found) return undefined;
        const result = groupRules.restoreGroup(db.memory, found.group.id, { actor: account });
        if (!result.ok) return sendFailure(res, result);
        if (!result.changed) return res.json({ success: true, changed: false, grupo: view(result.group) });
        audit(req, account, 'class_group_restored', result.group, { groupId: result.group.id, nome: result.group.nome });
        await db.save({ only: ['classGroups', 'auditLogs'] });
        return res.json({ success: true, changed: true, grupo: view(result.group) });
    }));

    return router;
}

module.exports = { createAdminGroupsRouter };
