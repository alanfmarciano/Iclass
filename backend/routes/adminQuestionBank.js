// Banco de questões do painel (fase 3, P3-S9a: AVA-15; desenho P3, rotas do banco). As
// rotas saíram de admin.js para este router, montado logo depois de
// createAdminCoursesRouter (ordem_no_createApp do plano):
// - GET /api/admin/question-bank?categoria=&tipo=&dificuldade=&tag=&q=&arquivadas=0|1:
//   os itens no formato da tela, com a estatística calculada na hora (usos, respostas,
//   pendentes e % de acerto), e as categorias e etiquetas existentes para os filtros. Sem
//   arquivadas=1, as arquivadas ficam de fora (a troca de questão do Monitor usa a lista
//   padrão). O professor vê o item criado no banco e o que veio de prova do escopo dele;
//   a estatística conta só as turmas dele.
// - POST create e update: a questão pelo modelo único (os seis tipos, pontos, explicação,
//   rubrica, dificuldade, habilidades e etiquetas), com author, revision, updatedAt e
//   updatedBy; auditoria question_created e question_updated na mesma gravação. Update
//   que não muda nada não sobe a revisão nem grava.
// - POST archive ({ key, archived }): arquivar tira da lista padrão sem apagar
//   (question_archived); desarquivar devolve (question_restored).
// - POST import-evaluation: leva as questões de uma avaliação do sistema, de todos os
//   tipos; a que o modelo recusa fica de fora em skipped, com o motivo.
// - POST delete: continua, com a cópia da questão na auditoria (question_deleted).
// Permissão page.exams para todas (adminPermissions.js); a coordenação, só de leitura,
// recebe o GET. O escopo do item que veio de uma prova é conferido pelo guarda
// (validateProfessorRequestScope: sourceExamKey do pedido e do item no update, no
// archive e no delete).
const express = require('express');
const db = require('../database.js');
const {
    validateAdmin,
    adminCanAccessClass,
    adminCanAccessItem,
    sendRouteError,
} = require('../middlewares.js');
const { accountScopeKind } = require('../utils/adminRoles.js');
const { recordAudit } = require('../utils/audit.js');
const { body, bool, str } = require('../utils/inputSchema.js');
const { questionInputFields } = require('../utils/questionModel.js');
const {
    DEFAULT_CATEGORY,
    applyBankQuestion,
    bankFacets,
    bankItemForScreen,
    bankQuestionText,
    changedBankFields,
    isArchivedItem,
    itemType,
    matchesBankFilters,
    normalizeBankQuestion,
    parseBankFilters,
    questionBankStats,
} = require('../utils/questionBank.js');

// Categoria do banco: a tela manda o tema da prova (ou o nome da unidade). O teto é o
// mesmo do campo Tema do editor (500, com contador): o schema nunca recusa o que a tela
// deixa digitar (decisões §12, sobra do H9b).
const QUESTION_CATEGORY_MAX_CHARS = 500;
const text = (max, label) => str({ max, nullable: true, label });
const bankFields = () => ({
    ...questionInputFields(),
    key: text(100, 'questão'),
    category: text(QUESTION_CATEGORY_MAX_CHARS, 'categoria'),
    curriculumKey: text(100, 'componente curricular'),
    sourceExamKey: text(200, 'prova de origem'),
    examKey: text(200, 'prova'),
});
const SCHEMAS = {
    item: body(bankFields()),
    archive: body({ key: text(100, 'questão'), archived: bool({ nullable: true, label: 'arquivada' }) }),
    importEvaluation: body({
        examKey: text(200, 'prova'),
        category: text(QUESTION_CATEGORY_MAX_CHARS, 'categoria'),
        curriculumKey: text(100, 'componente curricular'),
    }),
};

function bankList() {
    if (!Array.isArray(db.memory.questionBank)) db.memory.questionBank = [];
    return db.memory.questionBank;
}

function findItem(key) {
    if (typeof key !== 'string' || !key) return null;
    return bankList().find(item => item && item.key === key) || null;
}

function actorEmail(account) {
    return (account && (account.email || account.name)) || 'Administrador';
}

function newKey(suffix = '') {
    return `qb_${Date.now()}${suffix ? `_${suffix}` : ''}_${Math.random().toString(36).slice(2, 7)}`;
}

// O que o professor vê do banco: item criado no banco (sem prova de origem) ou de prova
// do escopo dele. O administrador vê tudo.
function visibleItems(account) {
    const items = bankList().filter(Boolean);
    if (accountScopeKind(account) === 'tudo') return items;
    return items.filter(item => !item.sourceExamKey || adminCanAccessItem(account, item.sourceExamKey));
}

function statsFor(account) {
    const canAccessClass = accountScopeKind(account) === 'tudo'
        ? null
        : (studentClass, courseId) => adminCanAccessClass(account, studentClass, courseId);
    return questionBankStats(db.memory, { canAccessClass });
}

function categoryOf(value, fallback = DEFAULT_CATEGORY) {
    const category = typeof value === 'string' ? value.trim() : '';
    return category || fallback;
}

function deletedQuestionCopy(question) {
    return { ...(question || {}) };
}

function createAdminQuestionBankRouter() {
    const router = express.Router();

    router.get('/api/admin/question-bank', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            const parsed = parseBankFilters(req.query || {});
            if (parsed.error) return res.status(400).json({ success: false, error: parsed.error, field: parsed.field });
            const visible = visibleItems(matchedAdmin);
            const stats = statsFor(matchedAdmin);
            const questions = visible
                .filter(item => matchesBankFilters(item, parsed.filters))
                .map(item => bankItemForScreen(item, stats.get(item.key)));
            res.json({
                success: true,
                questions,
                total: visible.filter(item => !isArchivedItem(item)).length,
                archivedCount: visible.filter(isArchivedItem).length,
                ...bankFacets(visible),
            });
        });
    });

    router.post('/api/admin/question-bank/create', SCHEMAS.item, (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            const raw = req.body;
            if (!String(raw.text ?? raw.questionText ?? '').trim()) {
                return res.status(400).json({ error: 'Texto da questão é obrigatório.' });
            }
            let normalized;
            try {
                normalized = normalizeBankQuestion(raw);
            } catch (error) {
                return sendRouteError(error, req, res);
            }
            const now = new Date().toISOString();
            const item = {
                key: newKey(),
                category: categoryOf(raw.category),
                curriculumKey: raw.curriculumKey || '',
                ...normalized,
                sourceExamKey: raw.sourceExamKey || null,
                author: actorEmail(matchedAdmin),
                revision: 1,
                archived: false,
                createdAt: now,
                updatedAt: now,
                updatedBy: actorEmail(matchedAdmin),
            };
            bankList().push(item);
            recordAudit(db.memory, {
                req,
                actor: matchedAdmin,
                action: 'question_created',
                examKey: item.sourceExamKey || undefined,
                details: { key: item.key, categoria: item.category, tipo: item.type },
            });
            db.save({ only: ['questionBank', 'auditLogs'] });
            res.json({ success: true, question: bankItemForScreen(item) });
        });
    });

    router.post('/api/admin/question-bank/update', SCHEMAS.item, (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            const item = findItem(req.body.key);
            if (!item) return res.status(404).json({ error: 'Questão não encontrada no banco.' });
            let normalized;
            try {
                normalized = normalizeBankQuestion(req.body, { previous: item });
            } catch (error) {
                return sendRouteError(error, req, res);
            }
            const next = { ...normalized };
            if (req.body.category !== undefined) next.category = categoryOf(req.body.category);
            else if (item.category !== undefined) next.category = item.category;
            if (req.body.curriculumKey !== undefined) next.curriculumKey = String(req.body.curriculumKey || '');
            else if (item.curriculumKey !== undefined) next.curriculumKey = item.curriculumKey;
            // Compara com o item lido pelo modelo: item antigo (sem tipo, texto em `text`,
            // alternativa em texto) salvo sem mudança não é reescrito nem auditado.
            let baseline = item;
            try {
                baseline = { ...item, ...normalizeBankQuestion({}, { previous: item }) };
            } catch {
                baseline = item;
            }
            const changed = changedBankFields(baseline, next);
            if (changed.length === 0) {
                // Nada mudou: a revisão fica, e nada é gravado nem auditado.
                return res.json({ success: true, unchanged: true, question: bankItemForScreen(item, statsFor(matchedAdmin).get(item.key)) });
            }
            applyBankQuestion(item, normalized);
            if (req.body.category !== undefined) item.category = next.category;
            if (req.body.curriculumKey !== undefined) item.curriculumKey = next.curriculumKey;
            item.revision = (Number.isInteger(item.revision) && item.revision > 0 ? item.revision : 0) + 1;
            item.updatedAt = new Date().toISOString();
            item.updatedBy = actorEmail(matchedAdmin);
            recordAudit(db.memory, {
                req,
                actor: matchedAdmin,
                action: 'question_updated',
                examKey: item.sourceExamKey || undefined,
                details: { key: item.key, revision: item.revision, tipo: itemType(item), campos: changed },
            });
            db.save({ only: ['questionBank', 'auditLogs'] });
            // Item antigo com curriculumKey ou type de outro tipo volta como texto (o guardado
            // fica como estava, igual ao GET).
            res.json({ success: true, question: bankItemForScreen(item, statsFor(matchedAdmin).get(item.key)) });
        });
    });

    router.post('/api/admin/question-bank/archive', SCHEMAS.archive, (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            if (!req.body.key) return res.status(400).json({ error: 'key é obrigatório.' });
            const item = findItem(req.body.key);
            if (!item) return res.status(404).json({ error: 'Questão não encontrada no banco.' });
            const archived = req.body.archived !== false;
            if (isArchivedItem(item) === archived) {
                return res.json({ success: true, unchanged: true, question: bankItemForScreen(item, statsFor(matchedAdmin).get(item.key)) });
            }
            item.archived = archived;
            item.updatedAt = new Date().toISOString();
            item.updatedBy = actorEmail(matchedAdmin);
            recordAudit(db.memory, {
                req,
                actor: matchedAdmin,
                action: archived ? 'question_archived' : 'question_restored',
                examKey: item.sourceExamKey || undefined,
                details: { key: item.key, categoria: categoryOf(item.category), texto: bankQuestionText(item).slice(0, 200) },
            });
            db.save({ only: ['questionBank', 'auditLogs'] });
            res.json({ success: true, question: bankItemForScreen(item, statsFor(matchedAdmin).get(item.key)) });
        });
    });

    router.post('/api/admin/question-bank/import-evaluation', SCHEMAS.importEvaluation, (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            const { examKey, category, curriculumKey } = req.body;
            if (!examKey) return res.status(400).json({ error: 'examKey é obrigatório.' });

            const evaluation = Object.prototype.hasOwnProperty.call(db.memory.evaluations || {}, examKey) ? db.memory.evaluations[examKey] : null;
            const questions = evaluation && Array.isArray(evaluation.questions) ? evaluation.questions : [];
            if (questions.length === 0) {
                return res.status(404).json({ error: 'Avaliação não encontrada ou sem questões estruturadas.' });
            }

            const existingKeys = new Set(bankList().filter(Boolean).map(question => `${question.sourceExamKey}:${question.originalNumber}`));
            const imported = [];
            // Desde o A7 o banco guarda os seis tipos pelo modelo da questão; a questão que o
            // modelo recusa (avaliação antiga incompleta) fica de fora, com o motivo.
            const skipped = [];
            const now = new Date().toISOString();
            questions.filter(question => question && typeof question === 'object').forEach(question => {
                const originalNumber = Number(question.originalNumber || question.number || 0);
                const dedupeKey = `${examKey}:${originalNumber}`;
                if (existingKeys.has(dedupeKey)) return;
                // Questão que já veio do banco não volta como cópia.
                if (typeof question.bankKey === 'string' && findItem(question.bankKey)) return;
                let normalized;
                try {
                    normalized = normalizeBankQuestion(question);
                } catch (error) {
                    skipped.push({ questionNumber: originalNumber, type: itemType(question), motivo: error.message });
                    return;
                }
                const item = {
                    key: newKey(originalNumber),
                    category: categoryOf(category, examKey.split('_')[1] || DEFAULT_CATEGORY),
                    curriculumKey: curriculumKey || '',
                    ...normalized,
                    sourceExamKey: examKey,
                    originalNumber,
                    author: actorEmail(matchedAdmin),
                    revision: 1,
                    archived: false,
                    createdAt: now,
                    updatedAt: now,
                    updatedBy: actorEmail(matchedAdmin),
                };
                bankList().push(item);
                existingKeys.add(dedupeKey);
                imported.push(item);
            });

            if (imported.length) {
                recordAudit(db.memory, {
                    req,
                    actor: matchedAdmin,
                    action: 'question_created',
                    examKey,
                    details: { origem: 'avaliacao', quantidade: imported.length, keys: imported.map(item => item.key), tipos: [...new Set(imported.map(item => item.type))] },
                });
                db.save({ only: ['questionBank', 'auditLogs'] });
            }
            const skippedMessage = skipped.length === 1
                ? `1 questão ficou de fora porque está incompleta (questão ${skipped[0].questionNumber}: ${skipped[0].motivo})`
                : `${skipped.length} questões ficaram de fora porque estão incompletas: ${skipped.map(item => item.questionNumber).join(', ')}.`;
            res.json({
                success: true,
                importedCount: imported.length,
                questions: imported.map(item => bankItemForScreen(item)),
                skippedCount: skipped.length,
                skipped,
                ...(skipped.length ? { message: skippedMessage } : {}),
            });
        });
    });

    router.post('/api/admin/question-bank/delete', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            const { key } = req.body || {};
            if (!key) return res.status(400).json({ error: 'key é obrigatório.' });
            // Um item null na lista (dado antigo) fica como está, sem derrubar a exclusão.
            const list = bankList();
            const before = list.length;
            const removed = list.filter(question => question && question.key === key);
            db.memory.questionBank = list.filter(question => !question || question.key !== key);
            removed.forEach(question => recordAudit(db.memory, {
                req,
                actor: matchedAdmin,
                action: 'question_deleted',
                category: 'academic',
                examKey: question.sourceExamKey || undefined,
                details: { deleted: deletedQuestionCopy(question) },
            }));
            db.save({ only: ['questionBank', 'auditLogs'] });
            res.json({ success: true, deleted: before - db.memory.questionBank.length });
        });
    });

    return router;
}

module.exports = { createAdminQuestionBankRouter, QUESTION_CATEGORY_MAX_CHARS };
