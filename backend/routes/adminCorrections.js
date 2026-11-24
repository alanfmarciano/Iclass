// Correção do professor nas entregas de prova (fase 3, P3-S4a: AVA-07; D7 e D8 do
// desenho do P3; contratos C1 e C5). Montado em admin.js logo depois de
// createAdminAcademicRouter (ordem_no_createApp do plano). Servem à tela "Corrigir"
// (P3-S4b, A18: web/src/features/admin/CorrecaoPage.jsx, /resultados/correcao), ao
// lançamento da prova impressa e aos testes.
//
// - GET  /api/admin/corrections?courseId=&studentClass=&applicationId=&examKey=
//   a fila "Aguardando correção": entregas do escopo da conta com correção pendente (nem
//   arquivadas, nem anuladas), com as questões que esperam o professor.
// - GET  /api/admin/submissions/:id/correction
//   as questões da entrega com a resposta do aluno, o gabarito, os pontos possíveis, a
//   rubrica, a resposta esperada, a conta automática e o item da correção, mais a
//   versao (para o conflito de duas abas) e a situação.
// - POST /api/admin/submissions/:id/correction
//   { versao, itens: { [n]: { pontos, comentario, rubrica, motivo } | null },
//   comentarioGeral, concluir, motivo }. Grava os pontos, comentários e rubrica por
//   questão e o comentário geral; concluir pede os pontos de toda questão que espera o
//   professor e recalcula a nota (examGrading.regradeFromOwnSnapshot), com o histórico
//   (scoreHistory). 409 correction_conflict quando versao mudou; 400 com pontos acima do
//   possível, rubrica fora do máximo, ajuste de questão corrigida pelo sistema sem motivo
//   e nota publicada que muda sem motivo; 409 class_closed (assertClassOpen). Apagar os
//   pontos de uma questão que espera o professor numa correção concluída a reabre
//   (situacao 'pendente'): a nota volta a ficar fora das médias até concluir de novo.
// Auditoria na mesma gravação (categoria nota): grade_manual_correction (questão que
// esperava o professor), grade_item_override (questão corrigida pelo sistema, com motivo)
// e grade_correction_completed (nota antes e depois).
//
// - POST /api/admin/submissions/:id/review-requests/:requestId/answer
//   { resposta } (P3-S5 / A19, D13): responde o pedido de revisão aberto do aluno. A
//   mudança de nota, quando há, vem antes pela rota da correção; notaMudou é calculado pelo
//   histórico da nota (utils/examReviewRequests.js). 409 com o pedido já respondido e
//   class_closed (assertClassOpen). Auditoria grade_review_answered (sem o texto).
//   A fila (GET /corrections) traz também os pedidos abertos (pedidosRevisao) e a entrega
//   (GET .../correction) traz todos os pedidos dela, com a resposta e quem respondeu.
//
// Permissão page.results para todas (adminPermissions.js: /corrections e a regra de
// /submissions); a Coordenação, só de leitura, recebe os GET. O escopo é o de Resultados
// (filterSubmissionsForAdmin). A fila "Precisa de você" ganha os itens "provas aguardando
// correção" (provedor 'correcoes-de-prova' do studentFeeds) e "pedidos de revisão"
// (provedor 'revisoes-de-nota').
const express = require('express');
const db = require('../database.js');
const {
    validateAdmin,
    filterSubmissionsForAdmin,
    findClassByNameAndCourse,
} = require('../middlewares.js');
const { assertClassOpen, classOfSubmission } = require('../utils/academicCalendar.js');
const { canReadQuestionAnswerKey } = require('../utils/examAnswerKeyView.js');
const { findExamApplication } = require('../utils/examApplications.js');
const { regradeFromOwnSnapshot } = require('../utils/examGrading.js');
const {
    CORRECTION_COMMENT_MAX,
    CORRECTION_GENERAL_MAX,
    CORRECTION_REASON_MAX,
    MAX_ITEMS,
    applyCorrectionInput,
    correctionOf,
    correctionQuestionRows,
    formatPoints,
    pendingQuestionNumbers,
} = require('../utils/examCorrection.js');
const { examTitle, formatGradeBR, recordGradeAudit, scopeSubmissionsToContext } = require('../utils/gradebook.js');
const { body, bool, dict, int, num, shape, str } = require('../utils/inputSchema.js');
const { integrityDecision, isArchived, isAwaitingCorrection, normalizeScore } = require('../utils/submissionAttempts.js');
const studentFeeds = require('../utils/studentFeeds.js');
const { displayName, normalizeEmail } = require('../utils/students.js');
const {
    REVIEW_ANSWER_MAX,
    answerReviewRequest,
    openReviewRequest,
    reviewRequestsForTeacher,
} = require('../utils/examReviewRequests.js');

const QUEUE_PROVIDER_ID = 'correcoes-de-prova';
const REVIEW_QUEUE_PROVIDER_ID = 'revisoes-de-nota';

const REVIEW_ANSWER_SCHEMA = body({
    resposta: str({ max: REVIEW_ANSWER_MAX, nullable: true, label: 'resposta' }),
});

const CORRECTION_SCHEMA = body({
    versao: int({ min: 0, max: 1000000, coerce: true, required: true, label: 'versão da correção' }),
    itens: dict(
        shape({
            pontos: num({ min: 0, max: 100, coerce: true, nullable: true, label: 'pontos' }),
            comentario: str({ max: CORRECTION_COMMENT_MAX, nullable: true, trim: false, label: 'comentário' }),
            rubrica: dict(num({ min: 0, max: 100, coerce: true, label: 'pontos do critério' }), { maxKeys: 8, keyMax: 40, nullable: true, label: 'rubrica' }),
            motivo: str({ max: CORRECTION_REASON_MAX, nullable: true, label: 'motivo' }),
        }, { nullable: true, label: 'questão' }),
        { maxKeys: MAX_ITEMS, keyPattern: /^\d{1,4}$/, nullable: true, label: 'questões' },
    ),
    comentarioGeral: str({ max: CORRECTION_GENERAL_MAX, nullable: true, trim: false, label: 'comentário geral' }),
    concluir: bool({ nullable: true, label: 'concluir' }),
    motivo: str({ max: CORRECTION_REASON_MAX, nullable: true, label: 'motivo' }),
});

function actorOf(matchedAdmin) {
    return (matchedAdmin && (matchedAdmin.email || matchedAdmin.name)) || 'Administrador';
}

function studentOf(submission) {
    const email = normalizeEmail(submission?.student?.email || submission?.studentEmail);
    const registered = email ? (db.memory.students || []).find(item => item && normalizeEmail(item.email) === email) : null;
    return {
        email,
        name: (registered && displayName(registered)) || submission?.student?.name || email,
    };
}

// Aplicação, configuração da turma e avaliação da entrega (as anulações da aplicação
// valem; a entrega impressa não tem aplicação).
function gradingContext(submission) {
    const application = submission?.applicationId
        ? findExamApplication(db.memory.examApplications || [], submission.applicationId)
        : null;
    const studentClass = submission?.student?.studentClass || submission?.studentClass || '';
    const courseId = submission?.student?.courseId || submission?.courseId || '';
    const cls = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId);
    const onlineConfig = application ? (cls?.onlineExamConfigs?.[submission.examKey] || {}) : {};
    const evaluation = (db.memory.evaluations || {})[submission.examKey] || null;
    return { application, onlineConfig, evaluation, cls };
}

function scopedSubmission(matchedAdmin, id) {
    const allowed = filterSubmissionsForAdmin(db.memory.submissions || [], matchedAdmin);
    return allowed.find(item => String(item.id) === String(id)) || null;
}

function awaitingInQueue(submission) {
    return !isArchived(submission) && integrityDecision(submission) === null && isAwaitingCorrection(submission);
}

function correctionSummary(submission) {
    const correcao = correctionOf(submission);
    return {
        situacao: isAwaitingCorrection(submission) ? 'pendente' : 'concluida',
        versao: correcao && Number.isInteger(correcao.versao) ? correcao.versao : 0,
        comentarioGeral: correcao ? String(correcao.comentarioGeral || '') : '',
        concluidaPor: correcao ? correcao.concluidaPor || null : null,
        concluidaEm: correcao ? correcao.concluidaEm || null : null,
    };
}

function gradeLabel(score) {
    return formatGradeBR(score) || 'sem nota';
}

// Pendência da fila "Precisa de você" (e do sino do instrutor): entregas da turma que
// esperam a correção, dos alunos do escopo de quem vê.
function queueItems(ctx) {
    const cls = ctx && ctx.cls;
    if (!cls || !cls.name || !ctx.memory) return [];
    const scoped = scopeSubmissionsToContext((ctx.memory.submissions || []).filter(awaitingInQueue), {
        courseId: String(cls.courseId || ''),
        studentClass: String(cls.name),
        students: ctx.memory.students || [],
        classes: ctx.memory.classes || [],
    });
    const emails = ctx.emails instanceof Set ? ctx.emails : null;
    const pending = scoped.filter(item => !emails || emails.has(normalizeEmail(item?.student?.email)));
    if (!pending.length) return [];
    const exams = new Set(pending.map(item => item.examKey));
    const oldest = Math.min(...pending.map(item => Date.parse(item.timestamp) || Date.now()));
    const title = exams.size === 1 ? examTitle([...exams][0], { evaluations: ctx.memory.evaluations || {} }) : '';
    return [{
        id: 'provas_aguardando_correcao',
        tipo: 'provas_aguardando_correcao',
        titulo: pending.length === 1 ? 'Prova aguardando correção' : 'Provas aguardando correção',
        detalhe: exams.size === 1 ? `em "${title}" · Corrigir provas` : `em ${exams.size} provas · Corrigir provas`,
        count: pending.length,
        tone: 'warning',
        // A tela Corrigir (A18), com a prova da fila quando é uma só.
        href: exams.size === 1 ? `/resultados/correcao?examKey=${encodeURIComponent([...exams][0])}` : '/resultados/correcao',
        permissao: 'page.results',
        // Corrigir é ação: a Coordenação (Resultados só para ver) não recebe o item.
        somenteQuemAltera: true,
        at: Number.isFinite(oldest) ? oldest : undefined,
    }];
}

// Pedidos de revisão abertos (P3-S5 / A19) das entregas da turma, dos alunos do escopo de
// quem vê. Um só leva direto à entrega na tela Corrigir.
function openReviewRows(submissions) {
    return submissions
        .map(submission => ({ submission, request: openReviewRequest(submission) }))
        .filter(row => row.request);
}

function reviewQueueItems(ctx) {
    const cls = ctx && ctx.cls;
    if (!cls || !cls.name || !ctx.memory) return [];
    const scoped = scopeSubmissionsToContext((ctx.memory.submissions || []).filter(item => item && openReviewRequest(item)), {
        courseId: String(cls.courseId || ''),
        studentClass: String(cls.name),
        students: ctx.memory.students || [],
        classes: ctx.memory.classes || [],
    });
    const emails = ctx.emails instanceof Set ? ctx.emails : null;
    const rows = openReviewRows(scoped.filter(item => !emails || emails.has(normalizeEmail(item?.student?.email))));
    if (!rows.length) return [];
    const oldest = Math.min(...rows.map(row => Number(row.request.criadoEm) || Date.now()));
    return [{
        id: 'pedidos_de_revisao',
        tipo: 'pedidos_de_revisao',
        titulo: rows.length === 1 ? 'Pedido de revisão de nota' : 'Pedidos de revisão de nota',
        detalhe: rows.length === 1
            ? `em "${examTitle(rows[0].submission.examKey, { evaluations: ctx.memory.evaluations || {} })}" · Responder`
            : `de ${rows.length} entregas · Responder`,
        count: rows.length,
        tone: 'warning',
        href: rows.length === 1
            ? `/resultados/correcao?submissionId=${encodeURIComponent(String(rows[0].submission.id))}`
            : '/resultados/correcao',
        permissao: 'page.results',
        // Responder é ação: a Coordenação (só consulta) não recebe o item.
        somenteQuemAltera: true,
        at: Number.isFinite(oldest) ? oldest : undefined,
    }];
}

function registerCorrectionFeeds() {
    studentFeeds.registerInstructorQueueProvider({ id: QUEUE_PROVIDER_ID, items: queueItems });
    studentFeeds.registerInstructorQueueProvider({ id: REVIEW_QUEUE_PROVIDER_ID, items: reviewQueueItems });
}

// Pedido aberto como a fila da tela Corrigir mostra (sem o texto: ele aparece ao abrir a
// entrega).
function reviewQueueRow(submission, request) {
    return {
        submissionId: submission.id,
        requestId: request.id,
        aluno: studentOf(submission),
        examKey: submission.examKey,
        prova: examTitle(submission.examKey, { evaluations: db.memory.evaluations || {} }),
        applicationId: submission.applicationId || null,
        attemptNumber: submission.attemptNumber || 1,
        questionNumber: request.questionNumber ?? null,
        criadoEm: request.criadoEm || null,
    };
}

function createAdminCorrectionsRouter() {
    const router = express.Router();
    registerCorrectionFeeds();

    router.get('/api/admin/corrections', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            const courseId = String(req.query.courseId || '').trim();
            const studentClass = String(req.query.studentClass || '').trim();
            const applicationId = String(req.query.applicationId || '').trim();
            const examKey = String(req.query.examKey || '').trim();
            const scoped = scopeSubmissionsToContext(filterSubmissionsForAdmin(db.memory.submissions || [], matchedAdmin), {
                courseId,
                studentClass,
                students: db.memory.students || [],
                classes: db.memory.classes || [],
            });
            const pendentes = scoped
                .filter(awaitingInQueue)
                .filter(item => (!applicationId || String(item.applicationId || '') === applicationId) && (!examKey || item.examKey === examKey))
                .sort((a, b) => (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0))
                .map(item => {
                    const context = gradingContext(item);
                    return {
                        submissionId: item.id,
                        aluno: studentOf(item),
                        examKey: item.examKey,
                        prova: examTitle(item.examKey, { evaluations: db.memory.evaluations || {} }),
                        applicationId: item.applicationId || null,
                        studentClass: item.student?.studentClass || '',
                        courseId: item.student?.courseId || null,
                        attemptNumber: item.attemptNumber || 1,
                        enviadaEm: item.timestamp || null,
                        tipo: item.type || (item.applicationId ? 'online' : 'impressa'),
                        questoesPendentes: pendingQuestionNumbers(item, context),
                        versao: correctionSummary(item).versao,
                    };
                });
            // Pedidos de revisão abertos (P3-S5 / A19), do mais antigo para o mais novo, com
            // os mesmos filtros (a entrega pode já estar com a correção concluída).
            const pedidosRevisao = openReviewRows(scoped
                .filter(item => (!applicationId || String(item.applicationId || '') === applicationId) && (!examKey || item.examKey === examKey)))
                .sort((a, b) => (Number(a.request.criadoEm) || 0) - (Number(b.request.criadoEm) || 0))
                .map(row => reviewQueueRow(row.submission, row.request));
            res.json({ success: true, pendentes, total: pendentes.length, pedidosRevisao });
        });
    });

    router.get('/api/admin/submissions/:id/correction', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            const submission = scopedSubmission(matchedAdmin, req.params.id);
            if (!submission) return res.status(404).json({ error: 'Entrega não encontrada.' });
            const context = gradingContext(submission);
            const questoes = correctionQuestionRows(submission, { ...context, withAnswerKey: canReadQuestionAnswerKey(matchedAdmin) });
            res.json({
                success: true,
                submissionId: submission.id,
                aluno: studentOf(submission),
                examKey: submission.examKey,
                prova: examTitle(submission.examKey, { evaluations: db.memory.evaluations || {} }),
                applicationId: submission.applicationId || null,
                attemptNumber: submission.attemptNumber || 1,
                enviadaEm: submission.timestamp || null,
                gradePublished: submission.gradePublished === true,
                score: normalizeScore(submission.score),
                pointsEarned: submission.pointsEarned ?? null,
                pointsPossible: submission.pointsPossible ?? null,
                integrity: integrityDecision(submission),
                ...correctionSummary(submission),
                questoes,
                pedidosRevisao: reviewRequestsForTeacher(submission),
            });
        });
    });

    router.post('/api/admin/submissions/:id/correction', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            if (!CORRECTION_SCHEMA.check(req, res)) return;
            const submissions = db.memory.submissions || [];
            const submission = scopedSubmission(matchedAdmin, req.params.id);
            if (!submission) return res.status(404).json({ error: 'Entrega não encontrada.' });
            const index = submissions.indexOf(submission);
            // Turma encerrada não recebe correção (sem efeito até o B10).
            if (!assertClassOpen(classOfSubmission(db.memory, submission), { res })) return;
            const context = gradingContext(submission);
            const actor = actorOf(matchedAdmin);
            const now = Date.now();
            const applied = applyCorrectionInput(submission, req.body, { ...context, actor, now });
            if (!applied.ok) return res.status(applied.status).json(applied.body);
            if (applied.unchanged) {
                return res.json({ success: true, unchanged: true, submissionId: submission.id, ...correctionSummary(submission) });
            }
            // A conta é feita numa cópia: com a nota publicada que muda e sem motivo, nada
            // muda na entrega.
            const draft = JSON.parse(JSON.stringify(submission));
            draft.correcao = applied.correcao;
            const before = { score: normalizeScore(submission.score), awaiting: isAwaitingCorrection(submission) };
            const reasons = [String(req.body.motivo || '').trim(), ...applied.changes.map(change => change.reason).filter(Boolean)];
            const reason = reasons.find(text => text.length >= 3) || '';
            regradeFromOwnSnapshot({
                submission: draft,
                ...context,
                reason: reason || (applied.completing ? 'Correção do professor concluída' : 'Correção do professor'),
                by: actor,
                syncCorrection: false,
            });
            const after = { score: normalizeScore(draft.score), awaiting: isAwaitingCorrection(draft) };
            // Nota publicada que muda, ou que volta a aguardar a correção (o aluno deixa de
            // ver a nota até o professor concluir de novo): pede o motivo.
            if (submission.gradePublished === true && (before.score !== after.score || applied.reopened) && reason.length < 3) {
                return res.status(400).json({ success: false, code: 'reason_required', field: 'motivo', error: 'Informe o motivo: esta nota já foi publicada para o aluno.' });
            }
            submissions[index] = draft;
            const title = examTitle(draft.examKey, { evaluations: db.memory.evaluations || {} });
            applied.changes.forEach(change => {
                if (change.kind === 'comment') return;
                const label = value => (value === null || value === undefined ? 'aguardando correção' : `${formatPoints(value)} de ${formatPoints(change.possible)}`);
                recordGradeAudit(db.memory, {
                    req,
                    actor: matchedAdmin,
                    submission: draft,
                    action: change.kind === 'override' ? 'grade_item_override' : 'grade_manual_correction',
                    field: `Questão ${change.number}`,
                    oldValue: `${title}: ${label(change.from)}`,
                    newValue: label(change.to),
                    reason: change.reason || undefined,
                    details: { questionNumber: change.number, situacao: draft.correcao.situacao, versao: draft.correcao.versao },
                });
            });
            if (applied.completing) {
                recordGradeAudit(db.memory, {
                    req,
                    actor: matchedAdmin,
                    submission: draft,
                    action: 'grade_correction_completed',
                    field: 'Correção da prova',
                    oldValue: `${title}: ${before.awaiting ? `aguardando correção (parcial ${gradeLabel(before.score)})` : gradeLabel(before.score)}`,
                    newValue: `${gradeLabel(after.score)} · correção concluída`,
                    reason: reason || undefined,
                    details: { versao: draft.correcao.versao, scoreAntes: before.score, scoreDepois: after.score },
                });
            }
            await db.save();
            res.json({
                success: true,
                submissionId: draft.id,
                score: after.score,
                pointsEarned: draft.pointsEarned ?? null,
                pointsPossible: draft.pointsPossible ?? null,
                scoreBefore: before.score,
                gradePublished: draft.gradePublished === true,
                reaberta: applied.reopened === true,
                ...correctionSummary(draft),
                questoes: correctionQuestionRows(draft, { ...context, withAnswerKey: canReadQuestionAnswerKey(matchedAdmin) }),
                pedidosRevisao: reviewRequestsForTeacher(draft),
            });
        });
    });

    router.post('/api/admin/submissions/:id/review-requests/:requestId/answer', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            if (!REVIEW_ANSWER_SCHEMA.check(req, res)) return;
            const submission = scopedSubmission(matchedAdmin, req.params.id);
            if (!submission) return res.status(404).json({ error: 'Entrega não encontrada.' });
            // Turma encerrada não recebe resposta de revisão (sem efeito até o B10; C5).
            if (!assertClassOpen(classOfSubmission(db.memory, submission), { res })) return;
            const answered = answerReviewRequest(submission, req.params.requestId, {
                resposta: req.body.resposta,
                by: actorOf(matchedAdmin),
                now: Date.now(),
            });
            if (!answered.ok) return res.status(answered.status).json(answered.body);
            const title = examTitle(submission.examKey, { evaluations: db.memory.evaluations || {} });
            recordGradeAudit(db.memory, {
                req,
                actor: matchedAdmin,
                submission,
                action: 'grade_review_answered',
                field: answered.request.questionNumber ? `Questão ${answered.request.questionNumber}` : 'Prova toda',
                oldValue: `${title}: pedido de revisão aberto`,
                newValue: answered.request.notaMudou ? `respondido · a nota mudou (${gradeLabel(normalizeScore(submission.score))})` : 'respondido · nota mantida',
                details: { requestId: answered.request.id, notaMudou: answered.request.notaMudou },
            });
            // submissions só cresce (append): a entrega antiga mudada vai pela gravação completa.
            await db.save();
            res.json({
                success: true,
                submissionId: submission.id,
                pedido: reviewRequestsForTeacher({ pedidosRevisao: [answered.request] })[0],
                pedidosRevisao: reviewRequestsForTeacher(submission),
            });
        });
    });

    return router;
}

module.exports = {
    QUEUE_PROVIDER_ID,
    REVIEW_QUEUE_PROVIDER_ID,
    createAdminCorrectionsRouter,
    queueItems,
    registerCorrectionFeeds,
    reviewQueueItems,
};
