// Portal do aluno: comunicação e turma da fase 3 (grupo P5). Rotas novas do aluno não
// entram em student.js (order_notes do plano); este router entra no createApp depois de
// studentAcademic e antes de studentRoutes (ordem_no_createApp).
//
// - GET /api/student/notebook?courseId=&studentClass= (P5-S3, UXA-14; D25 do P5): o caderno
//   do aluno para imprimir e baixar: a nota geral e, por unidade da estrutura da turma (na
//   ordem do curso), a nota da unidade e as anotações de parágrafo, com o título da unidade
//   e do módulo (utils/studentNotes.js buildNotebook). Exige a sessão e a matrícula na
//   turma; só lê; manda junto o fuso da escola (timezone). Na pré-visualização
//   (PREVIEW_READ_ROUTES) volta vazio: o aluno virtual não tem caderno.
//
// - GET /api/student/groups?courseId=&studentClass= (P5-S4, CRIT-11): os grupos ativos do
//   aluno na turma, com o nome dos colegas que ainda estão nela (P-C3: só o nome, sem
//   e-mail nem telefone). Exige a sessão do aluno e a matrícula na turma. Só lê: entra na
//   lista da pré-visualização (PREVIEW_READ_ROUTES); na prévia aberta com um grupo, a
//   resposta é a de um membro desse grupo (o aluno virtual não está em nenhum).
//
// Conversas com os professores (P5-S7a, FUN-14; regras em utils/conversations.js):
// - GET  /api/student/conversations?courseId&studentClass&arquivadas=0|1  as conversas do
//        aluno na turma (na prévia, nenhuma);
// - GET  /api/student/conversations/recipients?courseId&studentClass      para quem ele
//        pode escrever (nome e papel, com um identificador opaco; sem e-mail);
// - POST /api/student/conversations           começa uma conversa (ou continua a aberta
//        com o mesmo professor): { courseId, studentClass, destinatario, assunto?, texto };
// - GET  /api/student/conversations/:id/messages?depois=ms|antes=ms         mensagens
//        (não grava; a tela marca a leitura pelo POST /read);
// - POST /api/student/conversations/:id/messages   { texto }  (409 conversation_closed);
// - POST /api/student/conversations/:id/read       { ate? }   marca de leitura do aluno;
// - POST /api/student/conversations/:id/archive    { arquivada } arquivar só para ele.
// Conversa de outro aluno responde 404. Escrever (começar e responder) pede a matrícula
// ativa na turma da conversa, um professor que ainda atende a turma (409
// instructor_unavailable) e nenhuma tentativa de prova aberta (409 exam_in_progress, C9);
// os limites por conta (20 mensagens em 10 minutos, 5 conversas novas por dia) dão 429
// com Retry-After. Mensagem enviada não vai para a auditoria (ela mesma é o registro);
// a gravação é parcial: db.save({ only: ['conversations', 'conversationMessages'] }).
const express = require('express');
const db = require('../database.js');
const { validateStudentSession, studentBelongsToClass, findClassByNameAndCourse } = require('../middlewares.js');
const groupRules = require('../utils/classGroups.js');
const conversations = require('../utils/conversations.js');
const { classStructure, isCourseDeleted } = require('../utils/contentAccess.js');
const { buildNotebook } = require('../utils/studentNotes.js');
const settingsUtil = require('../utils/settings.js');
const { studentHasOpenAttempt } = require('../utils/passwordChange.js');
const rateLimit = require('../utils/rateLimit.js');
const { body, bool, int, str } = require('../utils/inputSchema.js');

const router = express.Router();
const { LIMITS } = conversations;

const SCHEMAS = Object.freeze({
    start: body({
        courseId: str({ max: 100, required: true, label: 'curso' }),
        studentClass: str({ max: 100, required: true, label: 'turma' }),
        destinatario: str({ max: 64, required: true, label: 'professor' }),
        assunto: str({ max: LIMITS.subjectMax, label: 'assunto' }),
        texto: str({ max: LIMITS.textMax, required: true, label: 'mensagem' }),
    }),
    message: body({
        texto: str({ max: LIMITS.textMax, required: true, label: 'mensagem' }),
    }),
    read: body({
        ate: int({ min: 0, label: 'lida até' }),
    }),
    archive: body({
        arquivada: bool({ required: true, label: 'arquivada' }),
    }),
});

router.get('/api/student/groups', validateStudentSession, (req, res) => {
    const courseId = String((req.query && req.query.courseId) || '').trim();
    const studentClass = String((req.query && req.query.studentClass) || '').trim();
    // O aluno vem da sessão (req.studentAccount, contrato X2): o real ou o virtual da prévia.
    const student = req.studentAccount;
    const cls = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId);
    if (!student || !cls || !studentBelongsToClass(student, cls)) {
        return res.status(403).json({ error: 'Contexto de turma não autorizado.' });
    }
    let groups;
    if (req.preview) {
        const previewGroupId = student.previewGroupId || null;
        groups = previewGroupId
            ? groupRules.activeGroupsForClass(db.memory, cls).filter(group => String(group.id) === String(previewGroupId))
            : [];
    }
    res.set('Cache-Control', 'no-store');
    return res.json(groupRules.studentGroupsView(db.memory, cls, req.studentEmail, { groups }));
});

// ------------------------------------------------------------ caderno
router.get('/api/student/notebook', validateStudentSession, (req, res) => {
    const cls = studentClassContext(req, res, req.query && req.query.courseId, req.query && req.query.studentClass);
    if (!cls) return undefined;
    res.set('Cache-Control', 'no-store');
    // Fuso da escola: a data do "Baixado em" e do rodapé da impressão no relógio da escola.
    const timezone = settingsUtil.getSettings().timezone || '';
    if (req.preview) return res.json({ success: true, geral: '', unidades: [], timezone });
    const notebook = buildNotebook(db.memory.notes, db.memory.annotations, req.studentEmail, classStructure(cls));
    return res.json({ success: true, ...notebook, timezone });
});

// ------------------------------------------------------------ conversas
function sendFailure(res, result) {
    const payload = { success: false, error: result.error };
    if (result.code) payload.code = result.code;
    if (result.field) payload.field = result.field;
    return res.status(result.status || 400).json(payload);
}

function courseOf(cls) {
    return (db.memory.courses || []).find(item => item && String(item.id) === String(cls.courseId)) || null;
}

// Turma do pedido (query ou corpo) em que o aluno da sessão está matriculado.
function studentClassContext(req, res, courseIdValue, studentClassValue) {
    const courseId = String(courseIdValue || '').trim();
    const studentClass = String(studentClassValue || '').trim();
    const student = req.studentAccount;
    const cls = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId);
    const course = cls ? courseOf(cls) : null;
    if (!student || !cls || !course || isCourseDeleted(course) || !studentBelongsToClass(student, cls)) {
        res.status(403).json({ success: false, error: 'Contexto de turma não autorizado.' });
        return null;
    }
    return cls;
}

// Conversa do caminho que é do aluno da sessão (de outro aluno, ou de curso excluído: 404).
function ownConversation(req, res) {
    const conv = conversations.findConversation(db.memory, req.params.id);
    if (!conv || !conversations.isStudentOf(conv, req.studentEmail) || !conversations.conversationClass(db.memory, conv)) {
        res.status(404).json({ success: false, error: 'Conversa não encontrada.', code: 'conversation_not_found' });
        return null;
    }
    return conv;
}

function tooMany(res, limit, text) {
    const retryAfterSeconds = Math.max(1, Math.ceil(limit.retryAfterMs / 1000));
    const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    const wait = minutes >= 60
        ? `${Math.ceil(minutes / 60)} ${Math.ceil(minutes / 60) === 1 ? 'hora' : 'horas'}`
        : `${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`;
    res.set('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ success: false, code: 'rate_limited', error: `${text} Tente de novo em ${wait}.`, retryAfterSeconds });
}

const messageKey = email => `conversas:mensagens:${email}`;
const newConversationKey = email => `conversas:novas-aluno:${email}`;

// O aluno pode escrever agora? (prova aberta e limite de mensagens.) Devolve true ou já
// respondeu.
function canWrite(req, res) {
    if (studentHasOpenAttempt(db.memory, req.studentEmail)) {
        res.status(409).json({ success: false, ...conversations.EXAM_IN_PROGRESS });
        return false;
    }
    const limit = rateLimit.peek(messageKey(req.studentEmail), LIMITS.studentMessages);
    if (!limit.allowed) {
        tooMany(res, limit, 'Você mandou muitas mensagens em pouco tempo.');
        return false;
    }
    return true;
}

function listMeta(req) {
    return {
        aviso: conversations.READ_NOTICE,
        avisoGuardadas: conversations.KEEP_NOTICE,
        emProva: !req.preview && studentHasOpenAttempt(db.memory, req.studentEmail),
        limites: { texto: LIMITS.textMax, assunto: LIMITS.subjectMax },
    };
}

router.get('/api/student/conversations', validateStudentSession, (req, res) => {
    const query = req.query || {};
    const cls = studentClassContext(req, res, query.courseId, query.studentClass);
    if (!cls) return undefined;
    const arquivadas = ['1', 'true', 'sim'].includes(String(query.arquivadas || '').trim().toLowerCase());
    // Prévia: o aluno virtual não tem conversa (lista vazia, D20).
    const rows = req.preview ? [] : conversations.studentConversations(db.memory, cls, req.studentEmail, { arquivadas });
    res.set('Cache-Control', 'no-store');
    return res.json({
        success: true,
        conversas: rows,
        naoLidas: rows.reduce((sum, row) => sum + (row.naoLidas || 0), 0),
        ...listMeta(req),
    });
});

router.get('/api/student/conversations/recipients', validateStudentSession, (req, res) => {
    const query = req.query || {};
    const cls = studentClassContext(req, res, query.courseId, query.studentClass);
    if (!cls) return undefined;
    res.set('Cache-Control', 'no-store');
    return res.json({
        success: true,
        destinatarios: conversations.classRecipients(db.memory, cls).map(({ ref, nome, papel }) => ({ ref, nome, papel })),
    });
});

router.post('/api/student/conversations', validateStudentSession, SCHEMAS.start, async (req, res) => {
    const cls = studentClassContext(req, res, req.body.courseId, req.body.studentClass);
    if (!cls) return undefined;
    const recipient = conversations.findRecipient(db.memory, cls, req.body.destinatario);
    if (!recipient) return sendFailure(res, { status: 400, error: 'Escolha um professor da lista.', code: 'invalid_recipient', field: 'destinatario' });
    if (!canWrite(req, res)) return undefined;
    const email = req.studentEmail;
    // Conversa aberta com o mesmo professor: a mensagem entra nela e não conta como nova.
    if (!conversations.openConversationFor(db.memory, cls, email, recipient.account.email)) {
        const limit = rateLimit.peek(newConversationKey(email), LIMITS.studentNewConversations);
        if (!limit.allowed) return tooMany(res, limit, 'Você já começou muitas conversas hoje.');
    }
    const result = conversations.startConversation(db.memory, cls, {
        by: 'aluno',
        student: req.studentAccount,
        account: recipient.account,
        assunto: req.body.assunto,
        texto: req.body.texto,
    });
    if (!result.ok) return sendFailure(res, result);
    rateLimit.hit(messageKey(email), LIMITS.studentMessages);
    if (result.created) rateLimit.hit(newConversationKey(email), LIMITS.studentNewConversations);
    await db.save({ only: ['conversations', 'conversationMessages'] });
    return res.status(result.created ? 201 : 200).json({
        success: true,
        criada: result.created,
        conversa: conversations.studentConversationSummary(db.memory, result.conversation),
        mensagem: conversations.messageView(result.message, { forStudent: true }),
    });
});

router.get('/api/student/conversations/:id/messages', validateStudentSession, (req, res) => {
    const conv = ownConversation(req, res);
    if (!conv) return undefined;
    const query = req.query || {};
    const number = value => (/^\d{1,15}$/.test(String(value || '').trim()) ? Number(String(value).trim()) : null);
    res.set('Cache-Control', 'no-store');
    return res.json({
        success: true,
        ...conversations.studentMessagesView(db.memory, conv, { depois: number(query.depois), antes: number(query.antes) }),
        ...listMeta(req),
    });
});

router.post('/api/student/conversations/:id/messages', validateStudentSession, SCHEMAS.message, async (req, res) => {
    const conv = ownConversation(req, res);
    if (!conv) return undefined;
    const read = conversations.readConversation(conv);
    if (read.status !== 'aberta') {
        return sendFailure(res, { status: 409, error: 'O professor encerrou esta conversa. Você pode começar outra.', code: 'conversation_closed' });
    }
    const cls = conversations.conversationClass(db.memory, conv);
    if (!studentBelongsToClass(req.studentAccount, cls)) {
        return sendFailure(res, { status: 409, error: 'Você não está mais nesta turma. A conversa fica só para leitura.', code: 'not_in_class' });
    }
    const instructor = conversations.instructorAccount(db.memory, read.instrutor.email);
    if (!conversations.instructorServesClass(instructor, cls)) {
        return sendFailure(res, { status: 409, error: 'Este professor não atende mais esta turma pelas mensagens. Comece uma conversa com outro professor.', code: 'instructor_unavailable' });
    }
    if (!canWrite(req, res)) return undefined;
    const result = conversations.postMessage(db.memory, conv, { by: 'aluno', email: req.studentEmail, texto: req.body.texto });
    if (!result.ok) return sendFailure(res, result);
    rateLimit.hit(messageKey(req.studentEmail), LIMITS.studentMessages);
    await db.save({ only: ['conversations', 'conversationMessages'] });
    return res.status(201).json({
        success: true,
        conversa: conversations.studentConversationSummary(db.memory, conv),
        mensagem: conversations.messageView(result.message, { forStudent: true }),
    });
});

router.post('/api/student/conversations/:id/read', validateStudentSession, SCHEMAS.read, async (req, res) => {
    const conv = ownConversation(req, res);
    if (!conv) return undefined;
    const ate = typeof req.body.ate === 'number' ? req.body.ate : undefined;
    const changed = conversations.markRead(conv, 'aluno', ate);
    if (changed) await db.save({ only: ['conversations'] });
    return res.json({ success: true, changed, lidaAte: conversations.readConversation(conv).lidaAte.aluno });
});

router.post('/api/student/conversations/:id/archive', validateStudentSession, SCHEMAS.archive, async (req, res) => {
    const conv = ownConversation(req, res);
    if (!conv) return undefined;
    const changed = conversations.setArchivedByStudent(conv, req.body.arquivada === true);
    if (changed) await db.save({ only: ['conversations'] });
    return res.json({ success: true, changed, conversa: conversations.studentConversationSummary(db.memory, conv) });
});

module.exports = router;
