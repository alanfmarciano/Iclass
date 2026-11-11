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
// GET  /api/admin/lgpd/acceptance          quantos alunos o primeiro acesso ainda vai
//                                          pedir: aceite, data de nascimento, responsável (H8a-2)
// POST /api/admin/lgpd/dpo                 grava o encarregado de uma escola (ou de todas)
// GET  /api/admin/lgpd/retention           prazos de retenção, volume, prévia e última
//                                          limpeza (H8b, SEG-13)
// GET  /api/admin/lgpd/retention/preview?proctoringDays=&loginLogsDays=&trashDays=
//                                          o que a limpeza apagaria com outros prazos
// POST /api/admin/lgpd/retention           grava os três prazos (retention_settings_changed)
// POST /api/admin/lgpd/retention/run       limpa agora (APAGAR); 409 sem revisão dos prazos ou com prova aberta
// GET  /api/admin/lgpd/students/export?email=&finalidade=baixar|imprimir
//                                          cópia completa dos dados pessoais de um aluno
//                                          (H8c reduzido, SEG-14), com lgpd_export na auditoria
//
// Só o administrador: a regra /lgpd de ADMIN_API_PERMISSION_RULES pede students.security,
// que é exclusiva dele, e cada rota confere de novo. Publicar e trocar o encarregado
// ficam na auditoria (legal_publish e dpo_changed, categoria privacy).
//
// Enquanto nada é publicado, o aluno vê o modelo e ninguém precisa aceitar nada
// (decisão P4). O aceite com documentId, o portão e os links no login são do H8a-2
// (utils/legalAcceptance.js, routes/privacy.js).
const express = require('express');
const db = require('../database.js');
const { validateAdminPermission } = require('../middlewares.js');
const { recordAudit } = require('../utils/audit.js');
const { isClosedStudentStatus } = require('../utils/students.js');
const { MODEL_ID } = require('../utils/legalTemplates.js');
const legal = require('../utils/legalDocuments.js');
const { INSTITUTIONAL_KEYS } = require('../utils/branding.js');
const legalAcceptance = require('../utils/legalAcceptance.js');
const { todayIso } = require('../utils/birthDate.js');
const settingsUtil = require('../utils/settings.js');
const storage = require('../utils/storage.js');
const retention = require('../utils/retention.js');
const { buildStudentDataExport, exportFileName } = require('../utils/studentDataExport.js');
const { studentEmailOwnership } = require('../utils/gradebook.js');
const { normalizeEmail } = require('../utils/students.js');

const PERMISSION = 'students.security';
const PUBLISH_WORD = 'PUBLICAR';
const PURGE_WORD = 'APAGAR';
const ACTIVE_EXAM_MESSAGE = 'Há prova em andamento; a limpeza roda quando ela terminar.';
const EXPORT_PURPOSES = ['baixar', 'imprimir'];

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
// encerrado não volta ao portal). O portão do primeiro acesso cobra o aceite (H8a-2).
function activeStudents() {
    return (db.memory.students || []).filter(student => student && student.email && !isClosedStudentStatus(student.status));
}

function activeStudentCount() {
    return activeStudents().length;
}

// Contagem do que o primeiro acesso ainda vai pedir aos alunos com cadastro em aberto.
function acceptanceSummary() {
    const today = todayIso();
    const out = { activeStudents: 0, termsPending: 0, privacyPending: 0, birthDateMissing: 0, minors: 0, minorsWithoutGuardian: 0 };
    // Só conta: sem montar o texto dos documentos para cada aluno pendente.
    const current = { termos: legal.currentDocument(db.memory, 'termos'), privacidade: legal.currentDocument(db.memory, 'privacidade') };
    activeStudents().forEach(student => {
        const status = legalAcceptance.studentPrivacyStatus(db.memory, student, { today, ruleActive: true, includeText: false, current });
        out.activeStudents += 1;
        if (status.termsPending) out.termsPending += 1;
        if (status.privacyPending) out.privacyPending += 1;
        if (status.birthDateMissing) out.birthDateMissing += 1;
        if (status.isMinor) out.minors += 1;
        if (status.guardianMissing) out.minorsWithoutGuardian += 1;
    });
    out.published = legal.LEGAL_KINDS.some(kind => !current[kind].isModel);
    out.policy = legalAcceptance.MINORS_POLICY;
    out.gateActive = legalAcceptance.privacyGateActive();
    return out;
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
        // Avisos do modelo, fora do texto (utils/legalTemplates.js): a tela mostra os dois
        // ao administrador; os alunos só veem o primeiro, e só enquanto é o modelo.
        modelNotice: legal.MODEL_NOTICE,
        modelReviewHint: legal.MODEL_REVIEW_HINT,
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

// Retenção (H8b, SEG-13; decisão 4 do Alan): só registros técnicos têm prazo, e só
// quando o administrador liga (utils/retention.js). A lixeira entra pelo prazo que já
// existia (trash.retentionDays), agora gravado só por aqui.
function trashForRetention() {
    return {
        count: (days, now) => storage.trashRetentionCounts(days, now).expired,
        purge: days => storage.purgeTrash(days),
    };
}

function retentionVolume() {
    return {
        keystrokes: Number(db.keystrokes.total()) || 0,
        proctoringLogs: Array.isArray(db.memory.proctoringLogs) ? db.memory.proctoringLogs.length : 0,
        loginLogs: Array.isArray(db.memory.loginLogs) ? db.memory.loginLogs.length : 0,
        trash: storage.trashRetentionCounts(0).total,
    };
}

async function retentionPreview(values) {
    const plan = await retention.planRetention(db.memory, values, Date.now(), { keystrokes: db.keystrokes, trash: trashForRetention() });
    return { values: plan.values, counts: plan.counts };
}

async function retentionPayload() {
    const settings = settingsUtil.retentionSettings();
    return {
        success: true,
        settings,
        limits: retention.RETENTION_LIMITS,
        recommended: retention.RECOMMENDED_RETENTION,
        reviewed: !!settings.reviewedAt,
        lastRun: retention.lastRetentionRun(db.memory),
        activeApplications: retention.activeApplicationCount(db.memory),
        volume: retentionVolume(),
        preview: await retentionPreview(settings),
    };
}

// Prazo recusado (RetentionInputError, texto fixo em português): 400 com o campo.
function sendRetentionInputError(res, validationError) {
    if (!(validationError instanceof retention.RetentionInputError)) throw validationError;
    return res.status(400).json({ success: false, error: validationError.message, field: validationError.field });
}

// Texto de cada prazo que subiu para o mínimo ao gravar (1 a 29 dias vira 30, ...).
function adjustedNotes(values, adjusted) {
    return adjusted.map(field => ({
        field,
        value: values[field],
        message: `O prazo de ${retention.RETENTION_LIMITS[field].label} subiu para ${values[field]} dias, o mínimo.`,
    }));
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

    router.get('/api/admin/lgpd/acceptance', (req, res) => {
        validateAdminPermission(req, res, PERMISSION, () => {
            res.json({ success: true, ...acceptanceSummary() });
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

    router.get('/api/admin/lgpd/retention', (req, res) => {
        validateAdminPermission(req, res, PERMISSION, async () => {
            res.json(await retentionPayload());
        });
    });

    router.get('/api/admin/lgpd/retention/preview', (req, res) => {
        validateAdminPermission(req, res, PERMISSION, async () => {
            let parsed;
            try {
                parsed = retention.parseRetentionInput(req.query || {}, { current: settingsUtil.retentionSettings(), partial: true });
            } catch (error) {
                return sendRetentionInputError(res, error);
            }
            const preview = await retentionPreview(parsed.values);
            res.json({ success: true, ...preview, adjusted: adjustedNotes(parsed.values, parsed.adjusted) });
        });
    });

    router.post('/api/admin/lgpd/retention', (req, res) => {
        validateAdminPermission(req, res, PERMISSION, async (config, matchedAdmin) => {
            let parsed;
            try {
                parsed = retention.parseRetentionInput(req.body || {});
            } catch (error) {
                return sendRetentionInputError(res, error);
            }
            const before = settingsUtil.retentionSettings();
            const { values } = parsed;
            if (!db.memory.config) db.memory.config = {};
            const settings = db.memory.config.settings && typeof db.memory.config.settings === 'object' ? db.memory.config.settings : {};
            const storedRetention = settings.retention && typeof settings.retention === 'object' && !Array.isArray(settings.retention) ? settings.retention : {};
            const storedTrash = settings.trash && typeof settings.trash === 'object' && !Array.isArray(settings.trash) ? settings.trash : {};
            db.memory.config.settings = {
                ...settings,
                retention: {
                    ...storedRetention,
                    proctoringDays: values.proctoringDays,
                    loginLogsDays: values.loginLogsDays,
                    reviewedAt: new Date().toISOString(),
                    reviewedBy: (matchedAdmin && matchedAdmin.email) || null,
                },
                trash: { ...storedTrash, retentionDays: values.trashDays },
            };
            const pick = source => ({ proctoringDays: source.proctoringDays, loginLogsDays: source.loginLogsDays, trashDays: source.trashDays });
            recordAudit(db.memory, {
                req,
                actor: matchedAdmin,
                action: 'retention_settings_changed',
                category: 'privacy',
                before: pick(before),
                after: pick(values),
                details: { adjusted: parsed.adjusted, firstReview: !before.reviewedAt },
            });
            await db.save();
            res.json({ ...(await retentionPayload()), adjusted: adjustedNotes(values, parsed.adjusted) });
        });
    });

    router.post('/api/admin/lgpd/retention/run', (req, res) => {
        validateAdminPermission(req, res, PERMISSION, async (config, matchedAdmin) => {
            const body = req.body || {};
            if (typeof body.confirm !== 'string' || body.confirm.trim().toUpperCase() !== PURGE_WORD) {
                return res.status(400).json({ success: false, error: `Digite ${PURGE_WORD} para confirmar a limpeza.`, field: 'confirm' });
            }
            // Antes da primeira revisão dos prazos, nada é limpo à mão (a tela também deixa
            // o botão desligado): quem liga a retenção é o administrador, salvando os prazos.
            const currentSettings = settingsUtil.retentionSettings();
            if (!currentSettings.reviewedAt) {
                return res.status(409).json({ success: false, code: 'not_reviewed', error: 'Revise e salve os prazos de retenção antes de limpar.' });
            }
            const result = await retention.runRetention({
                memory: db.memory,
                keystrokes: db.keystrokes,
                trash: trashForRetention(),
                settings: currentSettings,
                trigger: 'manual',
                actor: matchedAdmin,
                req,
                save: () => db.save(),
            });
            if (!result.ran) {
                if (result.reason === 'active_application') {
                    return res.status(409).json({ success: false, code: 'active_application', error: ACTIVE_EXAM_MESSAGE, activeApplications: result.activeApplications });
                }
                if (result.reason === 'no_deadline') {
                    return res.status(409).json({ success: false, code: 'no_deadline', error: 'Nenhum prazo de retenção está ligado. Defina os prazos e salve antes de limpar.' });
                }
                return res.status(409).json({ success: false, code: 'busy', error: 'Já há uma limpeza em andamento. Aguarde alguns instantes.' });
            }
            res.json({ ...(await retentionPayload()), counts: result.counts, remaining: result.remaining });
        });
    });

    // Exportação dos dados pessoais de um aluno (H8c reduzido; SEG-14, art. 18 da LGPD):
    // a versão 'admin' de utils/studentDataExport.js, com tudo o que o IClass guarda da
    // pessoa. Cada exportação fica na auditoria (lgpd_export, privacy) com quem exportou,
    // a finalidade (baixar o arquivo ou imprimir) e quantos registros de cada tipo saíram.
    router.get('/api/admin/lgpd/students/export', (req, res) => {
        validateAdminPermission(req, res, PERMISSION, async (config, matchedAdmin) => {
            const query = req.query || {};
            const email = normalizeEmail(queryText(query.email));
            if (!email) return res.status(400).json({ success: false, error: 'Informe o e-mail do aluno.', field: 'email' });
            const purposeText = queryText(query.finalidade);
            if (purposeText && !EXPORT_PURPOSES.includes(purposeText)) {
                return res.status(400).json({ success: false, error: 'Finalidade inválida: use baixar ou imprimir.', field: 'finalidade' });
            }
            if (!(db.memory.students || []).some(student => student && normalizeEmail(student.email) === email)) {
                return res.status(404).json({ success: false, error: 'Aluno não encontrado.' });
            }
            // As teclas da prova moram em tabela própria: buscadas antes, por todos os
            // e-mails do aluno. A memória é lida de novo depois da espera.
            const keystrokes = await db.keystrokes.findByEmails(studentEmailOwnership(db.memory, email).emails);
            const actorEmail = (matchedAdmin && matchedAdmin.email) || null;
            const data = buildStudentDataExport(db.memory, email, { audience: 'admin', keystrokes, generatedBy: actorEmail });
            if (!data) return res.status(404).json({ success: false, error: 'Aluno não encontrado.' });
            recordAudit(db.memory, {
                req,
                actor: matchedAdmin,
                action: 'lgpd_export',
                category: 'privacy',
                studentEmail: email,
                details: { audience: 'admin', purpose: purposeText || 'baixar', counts: data.counts },
            });
            await db.save();
            res.set('Content-Disposition', `attachment; filename="${exportFileName('admin', email, todayIso())}"`);
            res.json(data);
        });
    });

    return router;
}

module.exports = { createAdminPrivacyRouter };
