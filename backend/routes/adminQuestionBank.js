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
// - POST import/preview e import (P3-S9b, D22): GIFT ou planilha CSV (o .xlsx é recusado:
//   ficou fora da fase 3, scope_cuts do plano), colado
//   ({ conteudo }) ou escolhido ({ arquivo: base64, nomeArquivo }), até 2 MB e 2.000
//   questões. A prévia lê tudo (utils/questionFormats.js), não grava e devolve as questões
//   que entrariam, os erros por linha, os avisos e as repetidas (já no banco, inclusive
//   arquivada, ou mais acima no arquivo), com o sha256 do arquivo. A confirmação manda o
//   mesmo arquivo e o sha256: arquivo diferente da prévia dá 409 import_changed; entram as
//   questões sem erro (a repetida só com ignorarDuplicadas false), como itens do acervo
//   comum (sem prova de origem), com auditoria question_bank_imported. Nada do arquivo
//   fica guardado.
// - GET export?formato=gift|csv (e os filtros do GET): as questões da lista em GIFT
//   (.gift.txt, UTF-8) ou planilha CSV (UTF-8 com BOM, ";", fórmula neutralizada), com
//   auditoria question_bank_exported. A coordenação, só de leitura, também exporta. As
//   imagens citadas (referencedExamUploads, contrato C8) não vão no arquivo: o GIFT lista
//   os nomes num comentário, a auditoria guarda quantas e quais, o cabeçalho
//   X-IClass-Imagens diz quantas e cada item do GET traz as suas em `imagens`.
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
const { body, bool, oneOf, str } = require('../utils/inputSchema.js');
const { questionInputFields } = require('../utils/questionModel.js');
const {
    DEFAULT_CATEGORY,
    QUESTION_CATEGORY_MAX_CHARS,
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
const {
    FORMATS,
    IMPORT_LIMITS,
    QuestionFormatError,
    readQuestionImport,
    toCsv,
    toGift,
} = require('../utils/questionFormats.js');
const { schoolDateOf } = require('../utils/schoolTime.js');
const { referencedExamUploads } = require('../utils/examMedia.js');

// Categoria do banco: até QUESTION_CATEGORY_MAX_CHARS (500, o teto do Tema do editor),
// o mesmo teto do filtro ?categoria= do GET (questionBank.js).
const text = (max, label) => str({ max, nullable: true, label });
const bankFields = () => ({
    ...questionInputFields(),
    key: text(100, 'questão'),
    category: text(QUESTION_CATEGORY_MAX_CHARS, 'categoria'),
    curriculumKey: text(100, 'componente curricular'),
    sourceExamKey: text(200, 'prova de origem'),
    examKey: text(200, 'prova'),
});
// Importação: o texto colado ou o arquivo em base64. O teto do schema é folgado (o
// base64 tem 4/3 do tamanho); o limite de verdade (2 MB do arquivo) é conferido nos bytes,
// com a mensagem de tamanho (413).
const importFields = () => ({
    formato: oneOf(FORMATS, { required: true, label: 'formato' }),
    conteudo: str({ max: IMPORT_LIMITS.maxBytes * 2, trim: false, nullable: true, label: 'texto das questões' }),
    arquivo: str({ max: IMPORT_LIMITS.maxBytes * 2, nullable: true, label: 'arquivo' }),
    nomeArquivo: text(255, 'nome do arquivo'),
    categoriaPadrao: text(QUESTION_CATEGORY_MAX_CHARS, 'categoria'),
});
const SCHEMAS = {
    item: body(bankFields()),
    importPreview: body(importFields()),
    importConfirm: body({
        ...importFields(),
        sha256: str({ required: true, pattern: /^[a-f0-9]{64}$/i, label: 'conferência do arquivo' }),
        ignorarDuplicadas: bool({ nullable: true, label: 'ignorar repetidas' }),
    }),
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

// Item para a tela, com `imagens`: os arquivos de /uploads citados na questão (enunciado,
// alternativas, explicação e resposta esperada), pelo referencedExamUploads do contrato C8.
// A tela de Exportar avisa quantas questões têm imagem, que não vai no arquivo.
function screenItem(item, stats = null) {
    return { ...bankItemForScreen(item, stats), imagens: referencedExamUploads(item) };
}

function categoryOf(value, fallback = DEFAULT_CATEGORY) {
    const category = typeof value === 'string' ? value.trim() : '';
    return category || fallback;
}

function deletedQuestionCopy(question) {
    return { ...(question || {}) };
}

// Prévia de cada questão para a tela: o suficiente para conferir (tipo, começo do
// enunciado, alternativas, resposta, pontos, categoria e etiquetas) sem mandar 2.000
// enunciados inteiros.
const PREVIEW_TEXT_MAX = 300;
const PREVIEW_ALTERNATIVE_MAX = 160;
function cut(value, max) {
    const textValue = String(value || '');
    return textValue.length > max ? `${textValue.slice(0, max - 3)}...` : textValue;
}
function previewItem(item) {
    const { question } = item;
    return {
        linha: item.linha,
        category: item.category,
        type: question.type,
        points: question.points,
        questionText: cut(question.questionText, PREVIEW_TEXT_MAX),
        alternatives: (question.alternatives || []).map(alternative => ({ letter: alternative.letter, text: cut(alternative.text, PREVIEW_ALTERNATIVE_MAX), isCorrect: alternative.isCorrect === true })),
        correctAnswer: question.correctAnswer || '',
        ...(question.correctAnswers ? { correctAnswers: question.correctAnswers } : {}),
        ...(question.numeric ? { numeric: question.numeric } : {}),
        ...(question.acceptedAnswers ? { acceptedAnswers: question.acceptedAnswers.slice(0, 5) } : {}),
        ...(question.difficulty ? { difficulty: question.difficulty } : {}),
        tags: question.tags || [],
        duplicada: item.duplicada,
        arquivada: item.arquivada,
        noArquivo: item.noArquivo,
        avisos: item.avisos,
    };
}

function importSummary(result) {
    const duplicadas = result.itens.filter(item => item.duplicada).length;
    return {
        formato: result.formato,
        sha256: result.sha256,
        total: result.itens.length + result.erros.length,
        validas: result.itens.length - duplicadas,
        duplicadas,
        comErro: result.erros.length,
    };
}

function readImport(req, account) {
    return readQuestionImport({
        formato: req.body.formato,
        conteudo: req.body.conteudo,
        arquivo: req.body.arquivo,
        nomeArquivo: req.body.nomeArquivo,
        categoriaPadrao: req.body.categoriaPadrao,
        existingItems: visibleItems(account),
    });
}

// Recusa do arquivo (QuestionFormatError: mensagem fixa em português, com o código e o
// status 400 ou 413); qualquer outro erro vai pelo sendRouteError.
function sendFormatError(formatError, req, res) {
    if (formatError instanceof QuestionFormatError) {
        return res.status(formatError.status || 400).json({ success: false, error: formatError.message, code: formatError.code });
    }
    return sendRouteError(formatError, req, res);
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
                .map(item => screenItem(item, stats.get(item.key)));
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
            res.json({ success: true, question: screenItem(item) });
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
                return res.json({ success: true, unchanged: true, question: screenItem(item, statsFor(matchedAdmin).get(item.key)) });
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
            res.json({ success: true, question: screenItem(item, statsFor(matchedAdmin).get(item.key)) });
        });
    });

    router.post('/api/admin/question-bank/archive', SCHEMAS.archive, (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            if (!req.body.key) return res.status(400).json({ error: 'key é obrigatório.' });
            const item = findItem(req.body.key);
            if (!item) return res.status(404).json({ error: 'Questão não encontrada no banco.' });
            const archived = req.body.archived !== false;
            if (isArchivedItem(item) === archived) {
                return res.json({ success: true, unchanged: true, question: screenItem(item, statsFor(matchedAdmin).get(item.key)) });
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
            res.json({ success: true, question: screenItem(item, statsFor(matchedAdmin).get(item.key)) });
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
                questions: imported.map(item => screenItem(item)),
                skippedCount: skipped.length,
                skipped,
                ...(skipped.length ? { message: skippedMessage } : {}),
            });
        });
    });

    router.post('/api/admin/question-bank/import/preview', SCHEMAS.importPreview, (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            let result;
            try {
                result = readImport(req, matchedAdmin);
            } catch (error) {
                return sendFormatError(error, req, res);
            }
            res.json({
                success: true,
                ...importSummary(result),
                itens: result.itens.map(previewItem),
                erros: result.erros,
                avisos: result.avisos,
            });
        });
    });

    router.post('/api/admin/question-bank/import', SCHEMAS.importConfirm, (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            let result;
            try {
                result = readImport(req, matchedAdmin);
            } catch (error) {
                return sendFormatError(error, req, res);
            }
            if (result.sha256 !== String(req.body.sha256).toLowerCase()) {
                return res.status(409).json({ success: false, error: 'O arquivo não é o mesmo da prévia. Veja a prévia de novo antes de importar.', code: 'import_changed' });
            }
            const skipDuplicates = req.body.ignorarDuplicadas !== false;
            const chosen = result.itens.filter(item => !skipDuplicates || !item.duplicada);
            const ignoradas = result.itens.length - chosen.length;
            if (!chosen.length) {
                return res.status(400).json({
                    success: false,
                    code: 'nothing_to_import',
                    error: result.itens.length
                        ? 'Todas as questões do arquivo já estão no banco. Para importar assim mesmo, ligue "Importar também as repetidas".'
                        : 'Nenhuma questão do arquivo pode ser importada: corrija os erros da prévia e tente de novo.',
                });
            }
            const now = new Date().toISOString();
            const author = actorEmail(matchedAdmin);
            // A chave leva a posição: 2.000 questões no mesmo milissegundo não repetem.
            const created = chosen.map((item, index) => ({
                key: newKey(`imp${index}`),
                category: item.category,
                curriculumKey: '',
                ...item.question,
                sourceExamKey: null,
                author,
                revision: 1,
                archived: false,
                createdAt: now,
                updatedAt: now,
                updatedBy: author,
            }));
            const existingKeys = new Set(bankList().filter(Boolean).map(item => item.key));
            created.forEach((item, index) => {
                while (existingKeys.has(item.key)) item.key = newKey(`imp${index}`);
                existingKeys.add(item.key);
            });
            bankList().push(...created);
            const categorias = [...new Set(created.map(item => item.category))];
            recordAudit(db.memory, {
                req,
                actor: matchedAdmin,
                action: 'question_bank_imported',
                details: {
                    formato: result.formato,
                    importadas: created.length,
                    ignoradas,
                    comErro: result.erros.length,
                    arquivo: typeof req.body.nomeArquivo === 'string' && req.body.nomeArquivo ? req.body.nomeArquivo.slice(0, 200) : null,
                    sha256: result.sha256,
                    categorias: categorias.slice(0, 20),
                    tipos: [...new Set(created.map(item => item.type))],
                    keys: created.slice(0, 100).map(item => item.key),
                },
            });
            db.save({ only: ['questionBank', 'auditLogs'] });
            res.json({ success: true, importadas: created.length, ignoradas, comErro: result.erros.length, categorias });
        });
    });

    router.get('/api/admin/question-bank/export', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            const formato = typeof req.query?.formato === 'string' ? req.query.formato.trim() : '';
            if (!FORMATS.includes(formato)) {
                return res.status(400).json({ success: false, error: 'Escolha o formato da exportação: gift ou csv.', field: 'formato' });
            }
            const parsed = parseBankFilters(req.query || {});
            if (parsed.error) return res.status(400).json({ success: false, error: parsed.error, field: parsed.field });
            const items = visibleItems(matchedAdmin).filter(item => matchesBankFilters(item, parsed.filters));
            if (!items.length) {
                return res.status(404).json({ success: false, error: 'Nenhuma questão do banco com estes filtros para exportar.', code: 'nothing_to_export' });
            }
            const today = schoolDateOf(Date.now()) || new Date().toISOString().slice(0, 10);
            // Contrato C8: as imagens citadas não vão no arquivo (só o endereço no Markdown);
            // o GIFT lista os nomes num comentário, a auditoria guarda quantas e quais, e o
            // cabeçalho X-IClass-Imagens diz quantas. Só as das questões que entram no
            // arquivo (o item incompleto que fica fora não conta).
            const built = formato === 'gift'
                ? toGift(items, { exportedAt: today, imagesOf: referencedExamUploads })
                : toCsv(items, { imagesOf: referencedExamUploads });
            const imagens = built.imagens;
            if (!built.quantidade) {
                return res.status(404).json({ success: false, error: 'As questões desta lista estão incompletas e não podem ser exportadas. Abra e salve cada uma no banco.', code: 'nothing_to_export' });
            }
            recordAudit(db.memory, {
                req,
                actor: matchedAdmin,
                action: 'question_bank_exported',
                details: { formato, quantidade: built.quantidade, foraDoArquivo: built.foraDoArquivo, filtros: parsed.filters, imagens: imagens.length, ...(imagens.length ? { arquivosDeImagem: imagens.slice(0, 50) } : {}) },
            });
            db.save({ only: ['auditLogs'] });
            const fileName = formato === 'gift' ? `banco-de-questoes_${today}.gift.txt` : `banco-de-questoes_${today}.csv`;
            res.setHeader('Content-Type', formato === 'gift' ? 'text/plain; charset=utf-8' : 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-IClass-Imagens', String(imagens.length));
            res.send(built.text);
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
