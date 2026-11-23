// ---------------------------------------------------------------------------
// Conversas com alunos pelo painel (fase 3, P5-S7a, FUN-14; D8 a D15 do P5).
//
// GET  /api/admin/conversations?courseId&studentClass&status=aberta|encerrada&todas=0|1
//                                        as conversas de quem vê (todas=1: todas da escola,
//                                        só com messages.readAll)
// POST /api/admin/conversations          começa (ou continua a aberta) com um aluno da
//                                        turma: { courseId, studentClass, studentEmail |
//                                        studentId, assunto?, texto }
// GET  /api/admin/conversations/:id/messages?depois=ms|antes=ms     mensagens (não grava)
// POST /api/admin/conversations/:id/messages     { texto }
// POST /api/admin/conversations/:id/read         { ate? }   marca de leitura do instrutor
// POST /api/admin/conversations/:id/close        { motivo? } encerrar
// POST /api/admin/conversations/:id/reopen       {}        reabrir
// POST /api/admin/conversations/:id/admin-open   {}        o administrador abre a conversa
//                                                          de outra pessoa (registra)
//
// Regras:
// - Permissão 'page.messages' no guarda (adminPermissions.js, regra /conversations; o
//   professor tem por padrão, a coordenação, o professor auxiliar e a secretaria não) e
//   'messages.readAll' para admin-open (só o administrador pleno). Escopo: a turma do corpo
//   ou da query no guarda e de novo aqui; nas rotas com :id, a turma DO REGISTRO da
//   conversa (validateProfessorRequestScope e aqui).
// - Quem lê e escreve: o instrutor da conversa (participante). Outro professor recebe
//   404, como se a conversa não existisse. O administrador pleno (messages.readAll, resposta
//   do Alan à pergunta 4) lê qualquer conversa depois do admin-open do dia, que grava
//   conversation_read_by_admin na auditoria (uma vez por dia e conversa); sem ele, 403
//   admin_open_required. Ele não escreve, não encerra nem marca leitura na conversa dos
//   outros (403 not_participant).
// - Começar: o aluno precisa estar ativo e matriculado na turma; até 60 conversas novas por
//   hora por conta (429). Mensagem do instrutor não tem limite e vale também na conversa
//   encerrada (o aluno lê, mas não responde).
// - Auditoria na mesma gravação: conversation_closed (motivo), conversation_reopened e
//   conversation_read_by_admin, na categoria do registro (student e privacy). Mensagem
//   enviada não entra (ela mesma é o registro). Gravação parcial:
//   db.save({ only: ['conversations', 'conversationMessages'] }) no envio,
//   ['conversations'] na leitura e ['conversations', 'auditLogs'] no encerrar e reabrir.
// ---------------------------------------------------------------------------
const express = require('express');
const db = require('../database.js');
const { adminCanAccessClass, findClassByNameAndCourse, validateAdmin } = require('../middlewares.js');
const { canAccessAdminPermission } = require('../utils/adminPermissions.js');
const { outOfScopeMessage } = require('../utils/adminRoles.js');
const { recordAudit } = require('../utils/audit.js');
const { isCourseDeleted } = require('../utils/contentAccess.js');
const conversations = require('../utils/conversations.js');
const { findStudentByEmail, findStudentById } = require('../utils/studentIdentity.js');
const { normalizeEmail } = require('../utils/students.js');
const schoolTime = require('../utils/schoolTime.js');
const settingsUtil = require('../utils/settings.js');
const rateLimit = require('../utils/rateLimit.js');
const { body, int, str } = require('../utils/inputSchema.js');

const { LIMITS } = conversations;

const SCHEMAS = Object.freeze({
    start: body({
        courseId: str({ max: 100, required: true, label: 'curso' }),
        studentClass: str({ max: 100, required: true, label: 'turma' }),
        studentEmail: str({ max: 254, label: 'aluno' }),
        studentId: str({ max: 64, label: 'aluno' }),
        assunto: str({ max: LIMITS.subjectMax, label: 'assunto' }),
        texto: str({ max: LIMITS.textMax, required: true, label: 'mensagem' }),
    }),
    message: body({
        texto: str({ max: LIMITS.textMax, required: true, label: 'mensagem' }),
    }),
    read: body({
        ate: int({ min: 0, label: 'lida até' }),
    }),
    close: body({
        motivo: str({ max: LIMITS.reasonMax, label: 'motivo' }),
    }),
    empty: body({}),
});

const STATUS_FILTERS = new Set(['aberta', 'encerrada']);

function sendFailure(res, result) {
    const payload = { success: false, error: result.error };
    if (result.code) payload.code = result.code;
    if (result.field) payload.field = result.field;
    if (result.conversationId) payload.conversationId = result.conversationId;
    return res.status(result.status || 400).json(payload);
}

function courseOf(cls) {
    return (db.memory.courses || []).find(item => item && String(item.id) === String(cls.courseId)) || null;
}

// Turma do pedido, existente, de curso ativo e no escopo da conta.
function scopedClass(res, account, courseIdValue, studentClassValue) {
    const courseId = String(courseIdValue || '').trim();
    const studentClass = String(studentClassValue || '').trim();
    const cls = courseId && studentClass ? findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId) : null;
    const course = cls ? courseOf(cls) : null;
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

const canReadAll = account => canAccessAdminPermission(account, conversations.READ_ALL_PERMISSION);

// Conversa do caminho que a conta pode ver: a dela (participante, com a turma no escopo)
// ou, para quem lê todas, qualquer uma. Outro professor: 404 (sigilo).
function visibleConversation(req, res, account) {
    const conv = conversations.findConversation(db.memory, req.params.id);
    const cls = conv ? conversations.conversationClass(db.memory, conv) : null;
    const participant = !!conv && conversations.isInstructorOf(conv, account.email);
    if (!conv || !cls || (!participant && !canReadAll(account))) {
        sendFailure(res, { status: 404, error: 'Conversa não encontrada.', code: 'conversation_not_found' });
        return null;
    }
    if (participant && !adminCanAccessClass(account, cls.name, cls.courseId)) {
        sendFailure(res, { status: 403, error: outOfScopeMessage(account, 'A conversa solicitada') });
        return null;
    }
    return { conv, cls, participant };
}

// Só o instrutor da conversa escreve, marca leitura, encerra e reabre.
function participantConversation(req, res, account) {
    const found = visibleConversation(req, res, account);
    if (!found) return null;
    if (!found.participant) {
        sendFailure(res, { status: 403, error: 'Só o professor da conversa pode fazer isso.', code: 'not_participant' });
        return null;
    }
    return found;
}

// ------------------------------------------------------------ leitura pela administração
// A leitura de conversa dos outros fica na auditoria uma vez por dia (data da escola) e
// conversa. Cache do processo para a consulta a cada 10 s não percorrer a trilha.
const adminOpenCache = new Map();

function schoolDate(ms) {
    return schoolTime.schoolDateOf(ms, settingsUtil.getSettings().timezone) || '';
}

function adminOpenedToday(account, conv, today) {
    const actor = normalizeEmail(account && account.email);
    const key = `${actor}\n${String(conv.id)}`;
    if (adminOpenCache.get(key) === today) return true;
    const logs = Array.isArray(db.memory.auditLogs) ? db.memory.auditLogs : [];
    for (let index = logs.length - 1; index >= 0; index--) {
        const entry = logs[index];
        if (!entry || entry.action !== 'conversation_read_by_admin') continue;
        if (normalizeEmail(entry.actor) !== actor) continue;
        if (!entry.details || String(entry.details.conversationId || '') !== String(conv.id)) continue;
        if (schoolDate(Number(entry.timestamp)) !== today) continue;
        adminOpenCache.set(key, today);
        return true;
    }
    return false;
}

function audit(req, account, action, conv, details, category = 'student') {
    const read = conversations.readConversation(conv);
    recordAudit(db.memory, {
        req,
        actor: account,
        action,
        category,
        studentEmail: read.aluno.email,
        courseId: read.courseId,
        studentClass: read.studentClass,
        details: { conversationId: read.id, ...details },
    });
}

function summary(conv, account) {
    const read = conversations.readConversation(conv);
    const naoLidas = conversations.isInstructorOf(conv, account.email)
        ? (conversations.unreadCounts(db.memory, [conv], 'instrutor').get(read.id) || 0)
        : 0;
    return conversations.adminConversationView(db.memory, conv, account.email, { naoLidas });
}

function numberParam(value) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    return /^\d{1,15}$/.test(text) ? Number(text) : null;
}

function createAdminMessagesRouter() {
    const router = express.Router();

    router.get('/api/admin/conversations', (req, res) => validateAdmin(req, res, (config, account) => {
        const query = req.query || {};
        const all = ['1', 'true', 'sim'].includes(String(query.todas || '').trim().toLowerCase());
        if (all && !canReadAll(account)) {
            return sendFailure(res, { status: 403, error: 'Só o administrador da escola vê as conversas de todos.', code: 'read_all_required' });
        }
        const courseId = String(query.courseId || '').trim();
        const studentClass = String(query.studentClass || '').trim();
        if (studentClass && !scopedClass(res, account, courseId, studentClass)) return undefined;
        const statusText = String(query.status || '').trim().toLowerCase();
        const status = STATUS_FILTERS.has(statusText) ? statusText : '';
        const rows = conversations.adminConversations(db.memory, account, {
            courseId,
            studentClass,
            status,
            all,
            canSeeClass: cls => all || adminCanAccessClass(account, cls.name, cls.courseId),
        });
        res.set('Cache-Control', 'no-store');
        return res.json({
            success: true,
            conversas: rows,
            naoLidas: rows.reduce((sum, row) => sum + (row.naoLidas || 0), 0),
            podeLerTodas: canReadAll(account),
            aviso: conversations.READ_NOTICE,
            avisoGuardadas: conversations.KEEP_NOTICE,
            limites: { texto: LIMITS.textMax, assunto: LIMITS.subjectMax, motivo: LIMITS.reasonMax },
        });
    }));

    router.post('/api/admin/conversations', SCHEMAS.start, (req, res) => validateAdmin(req, res, async (config, account) => {
        const cls = scopedClass(res, account, req.body.courseId, req.body.studentClass);
        if (!cls) return undefined;
        const student = req.body.studentId
            ? findStudentById(db.memory, req.body.studentId)
            : (req.body.studentEmail ? findStudentByEmail(db.memory, req.body.studentEmail) : null);
        if (!req.body.studentId && !req.body.studentEmail) {
            return sendFailure(res, { status: 400, error: 'Escolha o aluno.', field: 'studentEmail' });
        }
        if (!conversations.studentCanTalkInClass(student, cls)) {
            return sendFailure(res, { status: 400, error: 'O aluno precisa estar ativo e matriculado nesta turma.', code: 'student_not_in_class', field: 'studentEmail' });
        }
        const email = normalizeEmail(account.email);
        const existing = conversations.openConversationFor(db.memory, cls, student.email, email);
        const limitKey = `conversas:novas-instrutor:${email}`;
        if (!existing) {
            const limit = rateLimit.peek(limitKey, LIMITS.instructorNewConversations);
            if (!limit.allowed) {
                const retryAfterSeconds = Math.max(1, Math.ceil(limit.retryAfterMs / 1000));
                const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
                res.set('Retry-After', String(retryAfterSeconds));
                return res.status(429).json({ success: false, code: 'rate_limited', retryAfterSeconds, error: `Você começou muitas conversas na última hora. Tente de novo em ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}.` });
            }
        }
        const result = conversations.startConversation(db.memory, cls, {
            by: 'instrutor',
            student,
            account,
            assunto: req.body.assunto,
            texto: req.body.texto,
        });
        if (!result.ok) return sendFailure(res, result);
        if (result.created) rateLimit.hit(limitKey, LIMITS.instructorNewConversations);
        await db.save({ only: ['conversations', 'conversationMessages'] });
        return res.status(result.created ? 201 : 200).json({
            success: true,
            criada: result.created,
            conversa: summary(result.conversation, account),
            mensagem: conversations.messageView(result.message, { nome: conversations.adminConversationView(db.memory, result.conversation, email).instrutor.nome }),
        });
    }));

    router.get('/api/admin/conversations/:id/messages', (req, res) => validateAdmin(req, res, (config, account) => {
        const found = visibleConversation(req, res, account);
        if (!found) return undefined;
        if (!found.participant && !adminOpenedToday(account, found.conv, settingsUtil.today())) {
            return sendFailure(res, {
                status: 403,
                error: 'Para ler a conversa de outro professor, abra pelo botão "Ler como administrador". A leitura fica registrada na Auditoria.',
                code: 'admin_open_required',
            });
        }
        const query = req.query || {};
        res.set('Cache-Control', 'no-store');
        return res.json({
            success: true,
            ...conversations.adminMessagesView(db.memory, found.conv, account.email, { depois: numberParam(query.depois), antes: numberParam(query.antes) }),
            aviso: conversations.READ_NOTICE,
            leituraAdministrativa: !found.participant,
        });
    }));

    router.post('/api/admin/conversations/:id/admin-open', SCHEMAS.empty, (req, res) => validateAdmin(req, res, async (config, account) => {
        const found = visibleConversation(req, res, account);
        if (!found) return undefined;
        if (found.participant) return res.json({ success: true, registrado: false, participante: true });
        const today = settingsUtil.today();
        if (adminOpenedToday(account, found.conv, today)) return res.json({ success: true, registrado: false, participante: false });
        const read = conversations.readConversation(found.conv);
        audit(req, account, 'conversation_read_by_admin', found.conv, { instrutor: read.instrutor.email }, 'privacy');
        await db.save({ only: ['auditLogs'] });
        adminOpenCache.set(`${normalizeEmail(account.email)}\n${read.id}`, today);
        return res.json({ success: true, registrado: true, participante: false });
    }));

    router.post('/api/admin/conversations/:id/messages', SCHEMAS.message, (req, res) => validateAdmin(req, res, async (config, account) => {
        const found = participantConversation(req, res, account);
        if (!found) return undefined;
        const result = conversations.postMessage(db.memory, found.conv, { by: 'instrutor', email: account.email, texto: req.body.texto });
        if (!result.ok) return sendFailure(res, result);
        await db.save({ only: ['conversations', 'conversationMessages'] });
        const conversa = summary(found.conv, account);
        return res.status(201).json({
            success: true,
            conversa,
            mensagem: conversations.messageView(result.message, { nome: conversa.instrutor.nome }),
        });
    }));

    router.post('/api/admin/conversations/:id/read', SCHEMAS.read, (req, res) => validateAdmin(req, res, async (config, account) => {
        const found = participantConversation(req, res, account);
        if (!found) return undefined;
        const ate = typeof req.body.ate === 'number' ? req.body.ate : undefined;
        const changed = conversations.markRead(found.conv, 'instrutor', ate);
        if (changed) await db.save({ only: ['conversations'] });
        return res.json({ success: true, changed, lidaAte: conversations.readConversation(found.conv).lidaAte.instrutor });
    }));

    router.post('/api/admin/conversations/:id/close', SCHEMAS.close, (req, res) => validateAdmin(req, res, async (config, account) => {
        const found = participantConversation(req, res, account);
        if (!found) return undefined;
        const result = conversations.closeConversation(found.conv, { actorEmail: account.email, motivo: req.body.motivo });
        if (!result.ok) return sendFailure(res, result);
        if (!result.changed) return res.json({ success: true, changed: false, conversa: summary(found.conv, account) });
        const motivo = conversations.readConversation(found.conv).motivoEncerramento;
        audit(req, account, 'conversation_closed', found.conv, { motivo: motivo || null });
        await db.save({ only: ['conversations', 'auditLogs'] });
        return res.json({ success: true, changed: true, conversa: summary(found.conv, account) });
    }));

    router.post('/api/admin/conversations/:id/reopen', SCHEMAS.empty, (req, res) => validateAdmin(req, res, async (config, account) => {
        const found = participantConversation(req, res, account);
        if (!found) return undefined;
        const result = conversations.reopenConversation(db.memory, found.conv, { actorEmail: account.email });
        if (!result.ok) return sendFailure(res, result);
        if (!result.changed) return res.json({ success: true, changed: false, conversa: summary(found.conv, account) });
        audit(req, account, 'conversation_reopened', found.conv, {});
        await db.save({ only: ['conversations', 'auditLogs'] });
        return res.json({ success: true, changed: true, conversa: summary(found.conv, account) });
    }));

    return router;
}

// Só nos testes: esquece as leituras do dia guardadas no processo.
function resetAdminOpenCacheForTests() {
    adminOpenCache.clear();
}

module.exports = { createAdminMessagesRouter, resetAdminOpenCacheForTests };
