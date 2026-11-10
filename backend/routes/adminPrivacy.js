// Página Privacidade (LGPD) do painel (H8a-1; SEG-08, OPS-12): Termos de Uso, Política
// de Privacidade e encarregado (DPO).
//
// GET  /api/admin/lgpd/documents?escola=   rascunho, versão atual, histórico e prévia
// GET  /api/admin/lgpd/documents/version?id=&escola=   uma versão publicada (texto e prévia)
// POST /api/admin/lgpd/documents/preview   prévia de um texto ainda não gravado
// POST /api/admin/lgpd/documents/draft     grava o rascunho (linha publicada responde 409)
// POST /api/admin/lgpd/documents/restore-model   rascunho volta ao texto do modelo
// POST /api/admin/lgpd/documents/publish   publica o rascunho como nova versão (PUBLICAR)
// GET  /api/admin/lgpd/dpo                 dados do controlador e do encarregado por escola
// POST /api/admin/lgpd/dpo                 grava o encarregado de uma escola (ou de todas)
//
// Só o administrador: a regra /lgpd de ADMIN_API_PERMISSION_RULES pede students.security,
// que é exclusiva dele, e cada rota confere de novo. Publicar e trocar o encarregado
// ficam na auditoria (legal_publish e dpo_changed, categoria privacy).
//
// Enquanto nada é publicado, o aluno vê o modelo e ninguém precisa aceitar nada
// (decisão P4). O aceite com documentId, o portão e os links no login são do H8a-2.
const express = require('express');
const db = require('../database.js');
const { validateAdminPermission } = require('../middlewares.js');
const { recordAudit } = require('../utils/audit.js');
const { isClosedStudentStatus } = require('../utils/students.js');
const { MODEL_ID } = require('../utils/legalTemplates.js');
const legal = require('../utils/legalDocuments.js');
const { INSTITUTIONAL_KEYS } = require('../utils/branding.js');

const PERMISSION = 'students.security';
const PUBLISH_WORD = 'PUBLICAR';

function queryText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

// Recusa prevista (LegalDocumentError, sempre com texto fixo em português): status,
// mensagem, campo e código. Qualquer outra falha segue para a guarda (500 com código).
function sendLegalError(res, validationError) {
    if (!(validationError instanceof legal.LegalDocumentError)) throw validationError;
    const body = { success: false, error: validationError.message };
    if (validationError.field) body.field = validationError.field;
    if (validationError.code) body.code = validationError.code;
    return res.status(validationError.status).json(body);
}

// Alunos que teriam de aceitar uma versão nova: todos com cadastro em aberto (o
// encerrado não volta ao portal). A cobrança do aceite é do H8a-2.
function activeStudentCount() {
    return (db.memory.students || []).filter(student => student && student.email && !isClosedStudentStatus(student.status)).length;
}

function schoolList() {
    return (db.memory.schools || []).filter(school => school && typeof school === 'object').map(legal.schoolSummary);
}

function kindPayload(kind, school) {
    const current = legal.currentDocument(db.memory, kind);
    const draft = legal.draftFor(db.memory, kind);
    const preview = legal.renderedDocument(db.memory, school, { markdown: draft.markdown, preview: true });
    return {
        kind,
        label: legal.KIND_LABELS[kind],
        current: {
            documentId: current.documentId,
            version: current.version,
            publishedAt: current.publishedAt,
            publishedBy: current.publishedBy,
            isModel: current.isModel,
            title: current.title,
        },
        draft,
        preview,
        history: legal.publishedVersions(db.memory, kind).map(legal.historyEntry),
    };
}

function documentsPayload(query) {
    const school = legal.resolveSchool(db.memory, { escola: queryText(query.escola), courseId: queryText(query.courseId) });
    const documents = {};
    legal.LEGAL_KINDS.forEach(kind => { documents[kind] = kindPayload(kind, school); });
    return {
        success: true,
        modelId: MODEL_ID,
        placeholders: legal.LEGAL_PLACEHOLDERS,
        markdownMax: legal.MARKDOWN_MAX,
        schools: schoolList(),
        school: legal.schoolSummary(school),
        activeStudents: activeStudentCount(),
        documents,
    };
}

function controllerView(school) {
    const info = school && school.info && typeof school.info === 'object' ? school.info : {};
    const institution = {};
    INSTITUTIONAL_KEYS.filter(key => key !== 'signatureUrl').forEach(key => {
        institution[key] = typeof info[key] === 'string' ? info[key] : '';
    });
    return { ...legal.schoolSummary(school), institution, dpo: legal.dpoOf(school) };
}

function createAdminPrivacyRouter() {
    const router = express.Router();

    router.get('/api/admin/lgpd/documents', (req, res) => {
        validateAdminPermission(req, res, PERMISSION, () => {
            res.json(documentsPayload(req.query || {}));
        });
    });

    router.get('/api/admin/lgpd/documents/version', (req, res) => {
        validateAdminPermission(req, res, PERMISSION, () => {
            const row = legal.findPublished(db.memory, queryText(req.query.id));
            if (!row) return res.status(404).json({ success: false, error: 'Versão não encontrada.' });
            const school = legal.resolveSchool(db.memory, { escola: queryText(req.query.escola) });
            const preview = legal.renderedDocument(db.memory, school, row);
            res.json({ success: true, document: { ...legal.historyEntry(row), kind: row.kind, markdown: row.markdown }, preview, school: legal.schoolSummary(school) });
        });
    });

    router.post('/api/admin/lgpd/documents/preview', (req, res) => {
        validateAdminPermission(req, res, PERMISSION, () => {
            const body = req.body || {};
            if (typeof body.markdown !== 'string') return res.status(400).json({ success: false, error: 'O texto do documento deve ser um texto.', field: 'markdown' });
            if (body.markdown.length > legal.MARKDOWN_MAX) return res.status(400).json({ success: false, error: `O texto do documento pode ter no máximo ${legal.MARKDOWN_MAX.toLocaleString('pt-BR')} caracteres.`, field: 'markdown' });
            const school = legal.resolveSchool(db.memory, { escola: queryText(body.escola) });
            res.json({ success: true, school: legal.schoolSummary(school), ...legal.renderedDocument(db.memory, school, { markdown: body.markdown, preview: true }) });
        });
    });

    router.post('/api/admin/lgpd/documents/draft', (req, res) => {
        validateAdminPermission(req, res, PERMISSION, (config, matchedAdmin) => {
            try {
                const draft = legal.saveDraft(db.memory, req.body, matchedAdmin && matchedAdmin.email);
                db.save();
                res.json({ success: true, draft });
            } catch (error) {
                return sendLegalError(res, error);
            }
        });
    });

    router.post('/api/admin/lgpd/documents/restore-model', (req, res) => {
        validateAdminPermission(req, res, PERMISSION, (config, matchedAdmin) => {
            try {
                const draft = legal.restoreModelDraft(db.memory, req.body, matchedAdmin && matchedAdmin.email);
                db.save();
                res.json({ success: true, draft });
            } catch (error) {
                return sendLegalError(res, error);
            }
        });
    });

    router.post('/api/admin/lgpd/documents/publish', (req, res) => {
        validateAdminPermission(req, res, PERMISSION, (config, matchedAdmin) => {
            const body = req.body || {};
            if (typeof body.confirm !== 'string' || body.confirm.trim().toUpperCase() !== PUBLISH_WORD) {
                return res.status(400).json({ success: false, error: `Digite ${PUBLISH_WORD} para confirmar a publicação.`, field: 'confirm' });
            }
            try {
                const { document, previous } = legal.publishDraft(db.memory, body, matchedAdmin && matchedAdmin.email);
                const affected = activeStudentCount();
                recordAudit(db.memory, {
                    req,
                    actor: matchedAdmin,
                    action: 'legal_publish',
                    category: 'privacy',
                    details: {
                        kind: document.kind,
                        documentId: document.id,
                        version: document.version,
                        previousDocumentId: previous ? previous.id : null,
                        title: document.title,
                        changeSummary: document.changeSummary || '',
                        characters: document.markdown.length,
                        activeStudents: affected,
                    },
                });
                db.save();
                res.json({ success: true, document: legal.historyEntry(document), activeStudents: affected });
            } catch (error) {
                return sendLegalError(res, error);
            }
        });
    });

    router.get('/api/admin/lgpd/dpo', (req, res) => {
        validateAdminPermission(req, res, PERMISSION, () => {
            res.json({ success: true, schools: (db.memory.schools || []).filter(school => school && typeof school === 'object').map(controllerView) });
        });
    });

    router.post('/api/admin/lgpd/dpo', (req, res) => {
        validateAdminPermission(req, res, PERMISSION, (config, matchedAdmin) => {
            const body = req.body || {};
            const applyToAll = body.applyToAll === true;
            const schoolId = queryText(body.schoolId);
            const schools = (db.memory.schools || []).filter(school => school && typeof school === 'object');
            const targets = applyToAll ? schools : schools.filter(school => String(school.id) === schoolId);
            if (!applyToAll && !schoolId) return res.status(400).json({ success: false, error: 'Escolha a escola.', field: 'schoolId' });
            if (!targets.length) return res.status(404).json({ success: false, error: 'Escola não encontrada.' });
            let dpo;
            try {
                dpo = legal.validateDpoInput(body);
            } catch (error) {
                return sendLegalError(res, error);
            }
            const changed = [];
            targets.forEach(school => {
                const before = legal.dpoOf(school);
                if (legal.DPO_KEYS.every(key => before[key] === dpo[key])) return;
                const info = school.info && typeof school.info === 'object' && !Array.isArray(school.info) ? school.info : {};
                legal.DPO_KEYS.forEach(key => { info[key] = dpo[key]; });
                school.info = info;
                school.updatedAt = Date.now();
                changed.push(school.id);
                recordAudit(db.memory, {
                    req,
                    actor: matchedAdmin,
                    action: 'dpo_changed',
                    category: 'privacy',
                    before,
                    after: { ...dpo },
                    details: { schoolId: school.id, schoolName: school.name || '' },
                });
            });
            if (changed.length) db.save();
            res.json({ success: true, changed: changed.length, schools: schools.map(controllerView) });
        });
    });

    return router;
}

module.exports = { createAdminPrivacyRouter };
