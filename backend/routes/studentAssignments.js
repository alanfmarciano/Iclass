// ---------------------------------------------------------------------------
// Tarefas no portal do aluno (fase 3, C5 / P1-c; FUN-01, D5, D6, D8, D9 e D17 do P1).
// Router próprio (K17 do plano: rota nova do aluno não entra em student.js), montado em
// createApp antes de studentRoutes (ordem_no_createApp).
//
// GET  /api/student/assignments?courseId&studentClass      tarefas da turma, por prazo
// GET  /api/student/assignments/:id?courseId&studentClass  a tarefa, o que enviar e as versões
// POST /api/student/assignments/:id/submit                 envio (multipart) = uma versão
// GET  /api/student/assignments/:id/files/:fileId          download de um arquivo próprio
//
// Regras:
// - Sessão do aluno (validateStudentSession: conta ativa, sem troca de senha pendente) e
//   matrícula aprovada na turma da tarefa (studentBelongsToClass). Só tarefa publicada e já
//   aberta (assignments.isVisibleToStudent); rascunho, arquivada e com abertura no futuro
//   respondem 404, como tarefa que não existe.
// - Envio (D5): um pedido multipart por versão, com os arquivos (campo 'files'), o texto e
//   o link juntos. A hora que vale para o atraso é a da CHEGADA do pedido (requestAt, antes
//   de ler o corpo; D8). Antes de aceitar o corpo: turma aberta (assertClassOpen, 409
//   class_closed), tarefa aceitando envio (409), tamanho declarado do envio (413) e espaço
//   livre no computador (507). O multer usa os limites da tarefa (arquivos, MB por arquivo,
//   10 campos de até 20 000 caracteres) e grava em data/entregas/.recebendo. Cada arquivo
//   passa por assignmentFiles.validateReceivedFile (tipo da tarefa, executável barrado,
//   assinatura, tamanho, sha256); um arquivo recusado descarta o envio inteiro (os
//   temporários são apagados, não vão para a lixeira: ainda não são de ninguém).
// - Versão atômica com trava por aluno e tarefa: a parte que grava (conferir de novo o
//   aceite, numerar a versão, mover os arquivos com renameWithRetry e gravar) roda um envio
//   por vez para o mesmo aluno na mesma tarefa; dois envios ao mesmo tempo viram as
//   versões n e n+1, nunca a mesma. A trava é a mesma das rotas do professor que mudam a
//   entrega (C6, utils/submissionLocks.js): a nota, a devolução ou a prorrogação esperam a
//   versão terminar de gravar (e vice-versa). Depois da espera do disco, a tarefa, a
//   entrega e o aceite são conferidos de novo: se algo mudou fora da trava, o envio é
//   recusado (409 submission_changed, retryable) em vez de gravar por cima. A versão só existe depois de todos os arquivos movidos
//   e da gravação no banco; falha de gravação responde 503 retryable, desfaz a versão na
//   memória e manda os arquivos já movidos para a lixeira (só do administrador).
// - Auditoria assignment_submitted (ator: o aluno) na mesma gravação:
//   db.save({ only: ['assignmentSubmissions', 'auditLogs', 'authSessions'] }).
// - Nenhuma resposta traz storedRel nem caminho do computador. Download sempre como
//   anexo (assignmentFiles.downloadHeaders: attachment, lista branca de Content-Type,
//   nosniff e CSP sandbox).
// - Pré-visualização (P5-S6a): a lista e o detalhe estão em PREVIEW_READ_ROUTES (só leem,
//   pelo req.studentAccount); o envio e o download recebem 403 preview_read_only.
// ---------------------------------------------------------------------------
const express = require('express');
const multer = require('multer');
const db = require('../database.js');
const { findClassByNameAndCourse, studentBelongsToClass, validateStudentSession } = require('../middlewares.js');
const { recordAudit, getClientIp } = require('../utils/audit.js');
const settingsUtil = require('../utils/settings.js');
const assignments = require('../utils/assignments.js');
const assignmentFiles = require('../utils/assignmentFiles.js');
const assignmentFeeds = require('../utils/assignmentFeeds.js');
const academicCalendar = require('../utils/academicCalendar.js');
const { submissionLockKey, withSubmissionLock, pendingLocks } = require('../utils/submissionLocks.js');
const fileStore = require('../utils/storage.js');
const { visibleLibraryEntries } = require('../utils/studentLibrary.js');
const { previewToken } = require('../utils/previewAccess.js');
const { DB_WRITE_ERROR_MESSAGE } = require('../utils/dbWriter.js');
const { logError } = require('../utils/errorLog.js');
const { body, str } = require('../utils/inputSchema.js');

const { LIMITS } = assignments;
const MB = assignmentFiles.MB;
const ID_MAX = 100;
// Folga do tamanho declarado (Content-Length) sobre o limite do envio: as bordas do
// multipart e os campos de texto. O tamanho de verdade é conferido depois de receber.
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const FILE_FIELDS = new Set(['files', 'files[]']);

const MESSAGES = Object.freeze({
    context: 'Contexto de turma não autorizado.',
    notFound: 'Tarefa não encontrada.',
    fileNotFound: 'Arquivo não encontrado.',
    fileMissing: 'Este arquivo não está mais no computador do professor. Fale com o professor.',
    classClosed: 'Esta turma foi encerrada. O envio não é mais aceito.',
    noFiles: 'Esta tarefa não recebe arquivos. Responda com o texto ou o link.',
    noText: 'Esta tarefa não recebe resposta em texto.',
    noLink: 'Esta tarefa não recebe link.',
    link: 'Informe um link que comece com http:// ou https://.',
    unexpectedField: 'Envio com um campo de arquivo inesperado. Atualize a página e tente de novo.',
    tooManyFields: 'Envio com campos demais. Atualize a página e tente de novo.',
    fieldTooLarge: 'Um campo do envio passou do tamanho permitido.',
    badRequest: 'O envio chegou incompleto. Confira a conexão e tente de novo.',
    invalidForm: 'O envio não chegou no formato esperado. Atualize a página e tente de novo. Se continuar, renomeie o arquivo com um nome simples.',
    readFailed: 'Não foi possível ler o arquivo agora. Tente de novo em alguns segundos.',
    receiveFailed: 'Não foi possível receber os arquivos agora. Tente de novo em alguns segundos.',
    writeFiles: 'Não foi possível gravar os arquivos do envio. Tente de novo.',
    changed: 'A entrega mudou enquanto o envio chegava. Atualize a página e envie de novo.',
});

const SUBMIT_SCHEMA = body({
    text: str({ max: LIMITS.textMax, trim: false, nullable: true, label: 'texto da resposta' }),
    link: str({ max: LIMITS.linkMax, nullable: true, label: 'link da resposta' }),
});

// ------------------------------------------------------------ apoio
function timezone() {
    return settingsUtil.getSettings().timezone;
}

function entregasSettings() {
    return settingsUtil.getSettings().entregas || {};
}

function sendError(res, status, error, extra = {}) {
    return res.status(status).json({ success: false, error, ...extra });
}

// A turma pedida (query) com matrícula aprovada, ou null (já respondeu 403).
function requestedClass(req, res) {
    const courseId = String((req.query && req.query.courseId) || '').trim();
    const studentClass = String((req.query && req.query.studentClass) || '').trim();
    const cls = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId);
    if (!cls || !studentBelongsToClass(req.studentAccount, cls)) {
        sendError(res, 403, MESSAGES.context);
        return null;
    }
    return cls;
}

// A tarefa do caminho que o aluno da sessão pode ver: publicada, aberta, de uma turma em
// que ele tem matrícula aprovada e, quando o pedido diz a turma (query), dessa turma.
// { raw, task, cls } ou null (já respondeu 403 ou 404).
function loadVisibleAssignment(req, res, { now = Date.now() } = {}) {
    const id = typeof req.params.id === 'string' ? req.params.id : '';
    const raw = id && id.length <= ID_MAX ? assignments.findAssignment(db.memory, id) : null;
    const task = raw ? assignments.normalizeAssignment(raw) : null;
    const queryCourse = String((req.query && req.query.courseId) || '').trim();
    const queryClass = String((req.query && req.query.studentClass) || '').trim();
    if (queryClass) {
        const asked = findClassByNameAndCourse(db.memory.classes || [], queryClass, queryCourse);
        if (!asked || !studentBelongsToClass(req.studentAccount, asked)) {
            sendError(res, 403, MESSAGES.context);
            return null;
        }
        if (task && (task.studentClass !== asked.name || task.courseId !== String(asked.courseId || ''))) {
            sendError(res, 404, MESSAGES.notFound);
            return null;
        }
    }
    const cls = task ? findClassByNameAndCourse(db.memory.classes || [], task.studentClass, task.courseId) : null;
    if (!task || !cls || !studentBelongsToClass(req.studentAccount, cls) || !assignments.isVisibleToStudent(task, { now })) {
        sendError(res, 404, MESSAGES.notFound);
        return null;
    }
    return { raw, task, cls };
}

function fileTypeLabels(task) {
    const labels = task.files.types.map(key => assignmentFiles.ASSIGNMENT_FILE_TYPES[key].label);
    const extraOutsideCatalog = task.files.extraExtensions.filter(ext => !task.files.types.some(key => assignmentFiles.ASSIGNMENT_FILE_TYPES[key].extensions.includes(ext)));
    if (extraOutsideCatalog.length) labels.push(`Formatos do curso (${extraOutsideCatalog.join(', ')})`);
    return labels;
}

// O arquivo como o aluno vê: nome, tamanho, tipo e o código do comprovante (nunca o caminho).
function presentFile(file) {
    return {
        id: file.id,
        name: file.originalName,
        size: file.size,
        mime: file.mime,
        ext: file.ext,
        comprovante: assignments.fileReceiptCode(file),
    };
}

function presentVersion(sub, version) {
    return {
        n: version.n,
        requestAt: version.requestAt,
        receivedAt: version.receivedAt,
        late: version.late,
        lateMs: version.lateMs,
        text: version.text,
        link: version.link,
        files: version.files.map(presentFile),
        bytes: version.files.reduce((total, file) => total + file.size, 0),
        comprovante: assignments.versionReceiptCode(sub, version),
    };
}

// Nota e comentário só depois de devolvida (o aluno nunca vê a correção salva).
function presentReturn(sub) {
    if (!sub || sub.status !== 'devolvida' || sub.returnedAt === null || !sub.grade) return null;
    return {
        nota: sub.grade.score,
        desconto: sub.grade.penaltyPct,
        notaFinal: sub.grade.finalScore,
        comentario: sub.grade.comment,
        versaoCorrigida: sub.grade.versionGraded,
        devolvidaEm: sub.returnedAt,
    };
}

// Pedido para refazer: o prazo novo (efetivo) e o comentário do professor.
function presentRedo(sub, window) {
    if (!sub || sub.status !== 'refazer') return null;
    return {
        ate: window.dueAt,
        encerramento: window.closeAt,
        comentario: sub.grade ? sub.grade.comment : '',
        pedidoEm: sub.extension ? sub.extension.at : null,
    };
}

// Uma linha da lista do aluno (contrato C4 do P1: situação e prazo efetivo prontos).
function listRow(task, rawSub, { now, tz, classOpen = true }) {
    const sub = rawSub ? assignments.normalizeSubmission(rawSub) : null;
    const situation = assignments.situationForClass(assignments.studentSituation(task, sub, { now, timezone: tz }), classOpen);
    const last = sub && sub.versions.length ? sub.versions[sub.versions.length - 1] : null;
    const devolucao = presentReturn(sub);
    return {
        id: task.id,
        title: task.title,
        moduleId: task.moduleId,
        unitKey: task.unitKey,
        opensAt: task.opensAt,
        dueAt: situation.dueAt,
        closeAt: situation.closeAt,
        aceitaEnvio: situation.aceitaEnvio,
        situacao: situation.code,
        situacaoTexto: situation.label,
        atrasada: situation.atrasada,
        versoes: sub ? sub.versions.length : 0,
        ultimaVersao: last ? { n: last.n, requestAt: last.requestAt, late: last.late } : null,
        nota: devolucao ? { nota: devolucao.nota, desconto: devolucao.desconto, notaFinal: devolucao.notaFinal } : null,
    };
}

function compareRows(a, b) {
    const dueA = a.dueAt === null ? Infinity : a.dueAt;
    const dueB = b.dueAt === null ? Infinity : b.dueAt;
    if (dueA !== dueB) return dueA - dueB;
    return String(a.title).localeCompare(String(b.title), 'pt-BR') || String(a.id).localeCompare(String(b.id), 'pt-BR');
}

// Materiais de apoio que o aluno da turma vê, com o link da Biblioteca (o mesmo formato
// de /api/student/library: o arquivo leva a sessão do pedido em ?access=).
function supportMaterials(req, task) {
    if (!task.libraryIds.length) return [];
    const visible = visibleLibraryEntries(db.memory.library || [], task.courseId, task.studentClass);
    const access = encodeURIComponent(String((req.preview ? previewToken(req) : req.get('x-session-token')) || ''));
    return task.libraryIds
        .map(id => visible.find(entry => String(entry.id) === id))
        .filter(Boolean)
        .map(entry => ({
            id: entry.id,
            name: entry.name || entry.title || '',
            type: entry.type || '',
            kind: entry.kind || '',
            url: entry.kind === 'link' ? entry.url : `${entry.url}${String(entry.url || '').includes('?') ? '&' : '?'}access=${access}`,
        }));
}

// Recusa do aceite (submissionAcceptance) no formato da resposta: o texto é o fixo de
// utils/assignments.js; a tarefa ainda não publicada responde como a que não existe.
function acceptanceRefusalBody(acceptance) {
    const status = acceptance.code === 'nao_publicada' ? 404 : 409;
    const text = status === 404 ? MESSAGES.notFound : acceptance.message;
    return { status, body: { success: false, error: text, code: `assignment_${acceptance.code}` } };
}

function acceptanceRefusal(res, acceptance) {
    const refusal = acceptanceRefusalBody(acceptance);
    return res.status(refusal.status).json(refusal.body);
}

// Turma encerrada (contrato academicCalendar e ajustes_do_plano do P1): 409 class_closed
// com o texto do envio. assertClassOpen ainda não tem efeito (o B10 liga); é chamada sem
// res para a recusa levar a mensagem do envio, e não a de notas e presença.
function isClassClosedError(err) {
    return !!err && err.code === academicCalendar.CLASS_CLOSED_CODE;
}

function classClosedBody() {
    return { success: false, error: MESSAGES.classClosed, code: academicCalendar.CLASS_CLOSED_CODE };
}

// Pedido recusado antes de ler o corpo: a resposta sai e o resto do corpo é descartado
// (sem fechar a conexão, o navegador recebe a mensagem depois de terminar de mandar).
function refuseBeforeBody(req, res, send) {
    req.resume();
    return send();
}

// ------------------------------------------------------------ multer
// Erro do multer (ou do fileFilter) no formato da resposta. fileName: o último arquivo que
// começou a chegar (o que passou do limite).
function multerErrorResponse(err, req, res, rules) {
    const name = req.assignmentUploadCurrentName ? `"${req.assignmentUploadCurrentName}"` : 'enviado';
    if (err && err.assignmentRefusal) return sendError(res, err.assignmentRefusal.status || 400, err.assignmentRefusal.message, { code: err.assignmentRefusal.code });
    if (err instanceof multer.MulterError || (err && err.name === 'MulterError')) {
        switch (err.code) {
            case 'LIMIT_FILE_SIZE':
                return sendError(res, 413, `O arquivo ${name} passa do limite de ${String(rules.maxSizeMb).replace('.', ',')} MB por arquivo desta tarefa.`, { code: 'file_too_large' });
            case 'LIMIT_FILE_COUNT':
                return rules.response.files
                    ? sendError(res, 400, `Envie no máximo ${rules.maxFiles} arquivo(s) por vez nesta tarefa.`, { code: 'too_many_files' })
                    : sendError(res, 400, MESSAGES.noFiles, { code: 'files_not_accepted' });
            case 'LIMIT_UNEXPECTED_FILE':
                return sendError(res, 400, MESSAGES.unexpectedField, { code: 'unexpected_field' });
            case 'LIMIT_FIELD_VALUE':
                return sendError(res, 400, MESSAGES.fieldTooLarge, { code: 'field_too_large' });
            case 'LIMIT_PART_COUNT':
            case 'LIMIT_FIELD_COUNT':
            case 'LIMIT_FIELD_KEY':
                return sendError(res, 400, MESSAGES.tooManyFields, { code: 'too_many_fields' });
            default:
                return sendError(res, 400, MESSAGES.invalidForm, { code: 'invalid_form' });
        }
    }
    if (err && (err.code === 'ENOSPC' || err.code === 'EDQUOT')) return sendError(res, 507, assignmentFiles.DISK_FULL_MESSAGE, { code: 'disk_full' });
    // Formulário que o pedido estragou: é do envio, não do servidor. Cortado no meio
    // (conexão caída) pede para conferir a conexão; cabeçalho multipart inválido (nome de
    // arquivo com caractere de controle, sem boundary) vem de um cliente com defeito e não
    // tem a ver com a conexão.
    const message = String((err && err.message) || '');
    if (/^(Unexpected end of (form|file)|Request (aborted|closed|error)$|aborted$)/.test(message)
        || (err && (err.code === 'ECONNRESET' || err.code === 'ECONNABORTED'))) {
        return sendError(res, 400, MESSAGES.badRequest, { code: 'bad_upload' });
    }
    if (/^(Malformed |Multipart: |Unsupported content type|Missing Content-Type)/.test(message)) {
        return sendError(res, 400, MESSAGES.invalidForm, { code: 'invalid_form' });
    }
    logError('[TAREFAS] Falha ao receber os arquivos de uma entrega', err);
    return sendError(res, 503, MESSAGES.receiveFailed, { code: 'receive_failed', retryable: true });
}

function receiveUpload(req, res, rules) {
    const upload = multer({
        storage: multer.diskStorage({
            destination: (request, file, cb) => {
                try { cb(null, assignmentFiles.ensureReceivingDir()); } catch (err) { cb(err); }
            },
            filename: (request, file, cb) => cb(null, assignmentFiles.receivingFileName()),
        }),
        // Navegador manda o nome do arquivo em UTF-8 ("Relatório final.pdf").
        defParamCharset: 'utf8',
        limits: {
            fileSize: Math.max(1, Math.floor(rules.maxSizeMb * MB)),
            files: rules.response.files ? rules.maxFiles : 0,
            fields: 10,
            fieldSize: 20000,
            fieldNameSize: 100,
            parts: rules.maxFiles + 10,
            headerPairs: 100,
        },
        fileFilter: (request, file, cb) => {
            request.assignmentUploadCurrentName = assignmentFiles.sanitizeOriginalName(file.originalname) || '';
            if (!FILE_FIELDS.has(file.fieldname)) return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
            // Tipo recusado (executável, fora da tarefa) para antes de receber o arquivo.
            const named = assignmentFiles.classifyFileName(file.originalname, rules);
            if (!named.ok) {
                const error = new Error(named.message);
                error.assignmentRefusal = { status: 400, code: named.code, message: named.message };
                return cb(error);
            }
            return cb(null, true);
        },
    }).any();
    return new Promise(resolve => {
        upload(req, res, err => resolve(err || null));
    });
}

// ------------------------------------------------------------ trava por aluno e tarefa
// A parte que grava roda um envio por vez para o mesmo aluno na mesma tarefa (o upload em
// si corre junto: cada um tem os próprios temporários). A trava é a mesma das rotas do
// professor que mudam a entrega (utils/submissionLocks.js, C6).

// ------------------------------------------------------------ gravação da versão
// Arquivos já movidos para data/entregas que ficaram sem registro (falha de gravação):
// vão para a lixeira com o nome original (entregas/ é só do administrador).
function trashCommittedFiles(files, task) {
    files.forEach(file => {
        try {
            fileStore.moveToTrash(assignmentFiles.absFromStoredRel(file.storedRel), {
                courseId: task.courseId, studentClass: task.studentClass, originalName: file.originalName,
            });
        } catch (err) { /* caminho estranho: fica para o cartão Armazenamento */ }
    });
}

function rowsOf(memory) {
    if (!Array.isArray(memory.assignmentSubmissions)) memory.assignmentSubmissions = [];
    return memory.assignmentSubmissions;
}

// Grava a versão (dentro da trava). Devolve { status, body }.
async function commitVersion(req, { assignmentId, requestAt, received, text, link }) {
    const raw = assignments.findAssignment(db.memory, assignmentId);
    const task = raw ? assignments.normalizeAssignment(raw) : null;
    const cls = task ? findClassByNameAndCourse(db.memory.classes || [], task.studentClass, task.courseId) : null;
    if (!task || !cls || !studentBelongsToClass(req.studentAccount, cls) || !assignments.isVisibleToStudent(task, { now: requestAt })) {
        return { status: 404, body: { success: false, error: MESSAGES.notFound } };
    }
    try {
        academicCalendar.assertClassOpen(cls);
    } catch (err) {
        if (isClassClosedError(err)) return { status: 409, body: classClosedBody() };
        throw err;
    }
    const email = req.studentEmail;
    const existing = assignments.findSubmission(db.memory, task.id, email);
    // O aceite de novo, já com a entrega de agora (outro envio do mesmo aluno pode ter
    // chegado à 20ª versão, o professor pode ter devolvido ou arquivado no meio do upload).
    const acceptance = assignments.submissionAcceptance(task, existing, { now: requestAt });
    if (!acceptance.accepts) return acceptanceRefusalBody(acceptance);

    const now = Date.now();
    const base = existing || assignments.newSubmissionRecord(task, req.studentAccount, { now });
    const n = assignments.nextVersionNumber(base);
    let files = [];
    if (received.length) {
        try {
            files = await assignmentFiles.commitReceivedFiles(received, { assignmentId: task.id, submissionId: base.id });
        } catch (err) {
            logError('[TAREFAS] Falha ao mover os arquivos de uma entrega', err.cause || err);
            return { status: 503, body: { success: false, error: MESSAGES.writeFiles, code: 'write_failed', retryable: true } };
        }
    }
    // Depois da espera do disco: a tarefa, a entrega e o aceite de novo. Quem muda a
    // entrega usa a mesma trava, então aqui nada deveria ter mudado; se mudou (restauração
    // de backup, tarefa excluída ou arquivada no meio), o envio não grava por cima.
    const rawAfter = assignments.findAssignment(db.memory, task.id);
    const taskAfter = rawAfter ? assignments.normalizeAssignment(rawAfter) : null;
    const current = assignments.findSubmission(db.memory, task.id, email);
    let refusal = null;
    if (current !== existing) {
        refusal = { status: 409, body: { success: false, error: MESSAGES.changed, code: 'submission_changed', retryable: true } };
    } else if (!taskAfter || !assignments.isVisibleToStudent(taskAfter, { now: requestAt })) {
        refusal = { status: 404, body: { success: false, error: MESSAGES.notFound } };
    }
    const acceptanceAfter = refusal ? null : assignments.submissionAcceptance(taskAfter, existing, { now: requestAt });
    if (!refusal && !acceptanceAfter.accepts) refusal = acceptanceRefusalBody(acceptanceAfter);
    if (refusal) {
        trashCommittedFiles(files, task);
        return refusal;
    }
    const version = {
        n,
        requestAt,
        receivedAt: Date.now(),
        late: acceptanceAfter.late,
        lateMs: acceptanceAfter.lateMs,
        text,
        link,
        files: files.map(file => ({
            id: file.id,
            originalName: file.originalName,
            storedRel: file.storedRel,
            size: file.size,
            sha256: file.sha256,
            mime: file.mime,
            ext: file.ext,
            category: file.category,
        })),
        ip: String(getClientIp(req) || '').slice(0, 100),
        device: String(req.get('user-agent') || '').slice(0, LIMITS.deviceMax),
    };
    const studentId = typeof req.studentAccount.id === 'string' && /^alu_[0-9a-f]{16}$/.test(req.studentAccount.id) ? req.studentAccount.id : null;
    const next = {
        ...base,
        studentId: base.studentId || studentId,
        versions: [...(Array.isArray(base.versions) ? base.versions : []), version],
        status: assignments.statusAfterNewVersion(base),
        updatedAt: now,
    };
    const rows = rowsOf(db.memory);
    const index = existing ? rows.indexOf(existing) : -1;
    if (index >= 0) rows[index] = next; else rows.push(next);
    const bytes = version.files.reduce((total, file) => total + file.size, 0);
    const entry = recordAudit(db.memory, {
        req,
        actor: email,
        action: 'assignment_submitted',
        category: 'assignment',
        studentEmail: email,
        courseId: task.courseId,
        studentClass: task.studentClass,
        submissionId: next.id,
        details: {
            assignmentId: task.id,
            version: n,
            files: version.files.length,
            bytes,
            late: version.late,
            lateMs: version.lateMs,
            text: !!text,
            link: !!link,
            sha256s: version.files.map(file => file.sha256),
        },
    });
    try {
        await db.save({ only: ['assignmentSubmissions', 'auditLogs', 'authSessions'] });
    } catch (err) {
        // Desfaz a versão (o banco ficou como estava) e tira os arquivos de data/entregas.
        const current = rowsOf(db.memory);
        const at = current.indexOf(next);
        if (at >= 0) {
            if (existing) current[at] = existing; else current.splice(at, 1);
        }
        const audits = Array.isArray(db.memory.auditLogs) ? db.memory.auditLogs : [];
        const auditAt = audits.indexOf(entry);
        if (auditAt >= 0) audits.splice(auditAt, 1);
        trashCommittedFiles(version.files, task);
        return { status: 503, body: { success: false, error: DB_WRITE_ERROR_MESSAGE, code: 'write_failed', retryable: true } };
    }
    const sub = assignments.normalizeSubmission(next);
    const saved = sub.versions.find(item => item.n === n);
    const situation = assignments.studentSituation(task, sub, { now: Date.now(), timezone: timezone() });
    return {
        status: 201,
        body: {
            success: true,
            version: presentVersion(sub, saved),
            situacao: situation.code,
            situacaoTexto: situation.label,
            serverNow: Date.now(),
        },
    };
}

// ------------------------------------------------------------ rotas
function createStudentAssignmentsRouter() {
    const router = express.Router();
    assignmentFeeds.registerAssignmentFeeds();

    router.get('/api/student/assignments', validateStudentSession, (req, res) => {
        const cls = requestedClass(req, res);
        if (!cls) return undefined;
        const now = Date.now();
        const tz = timezone();
        const classOpen = assignments.classAcceptsSubmissions(cls);
        const rows = assignments.assignmentsForClass(db.memory, { courseId: cls.courseId, studentClass: cls.name, statuses: ['publicada'] })
            .map(raw => assignments.normalizeAssignment(raw))
            .filter(task => assignments.isVisibleToStudent(task, { now }))
            .map(task => listRow(task, assignments.findSubmission(db.memory, task.id, req.studentEmail), { now, tz, classOpen }))
            .sort(compareRows);
        res.set('Cache-Control', 'no-store');
        return res.json({ success: true, assignments: rows, turmaEncerrada: !classOpen, serverNow: now, timezone: tz });
    });

    router.get('/api/student/assignments/:id', validateStudentSession, (req, res) => {
        const now = Date.now();
        const found = loadVisibleAssignment(req, res, { now });
        if (!found) return undefined;
        const { task, cls } = found;
        const tz = timezone();
        const rawSub = assignments.findSubmission(db.memory, task.id, req.studentEmail);
        const sub = rawSub ? assignments.normalizeSubmission(rawSub) : null;
        const acceptance = assignments.submissionAcceptance(task, sub, { now });
        // Turma encerrada: o envio responderia 409 class_closed; o detalhe já diz isso.
        const classOpen = assignments.classAcceptsSubmissions(cls);
        const accepts = acceptance.accepts && classOpen;
        const situation = assignments.situationForClass(assignments.studentSituation(task, sub, { now, timezone: tz }), classOpen);
        const rules = assignments.submissionRules(task, entregasSettings());
        res.set('Cache-Control', 'no-store');
        return res.json({
            success: true,
            assignment: {
                id: task.id,
                courseId: task.courseId,
                studentClass: task.studentClass,
                moduleId: task.moduleId,
                unitKey: task.unitKey,
                title: task.title,
                instructions: task.instructions,
                materiais: supportMaterials(req, task),
                opensAt: task.opensAt,
                dueAt: acceptance.window.dueAt,
                closeAt: acceptance.window.closeAt,
                prazoIndividual: acceptance.window.individual,
                latePolicy: task.latePolicy,
                regraAtraso: assignments.latePolicyText(task),
            },
            aceita: {
                resposta: rules.response,
                tipos: fileTypeLabels(task),
                extensoes: rules.extensions,
                accept: rules.accept,
                maxFiles: rules.maxFiles,
                maxSizeMb: rules.maxSizeMb,
                maxTotalMb: rules.maxTotalMb,
                textMax: rules.textMax,
                linkMax: rules.linkMax,
            },
            aceitaEnvio: accepts,
            motivo: accepts ? '' : (classOpen ? acceptance.message : MESSAGES.classClosed),
            atrasoAgora: accepts && acceptance.late,
            turmaEncerrada: !classOpen,
            situacao: situation.code,
            situacaoTexto: situation.label,
            minhaEntrega: sub ? {
                status: sub.status,
                versoes: sub.versions.map(version => presentVersion(sub, version)),
                entregaEmMaos: sub.manualEntry ? { at: sub.manualEntry.at } : null,
            } : null,
            devolucao: presentReturn(sub),
            refazer: presentRedo(sub, acceptance.window),
            serverNow: now,
            timezone: tz,
        });
    });

    router.post('/api/student/assignments/:id/submit', (req, res, next) => {
        // A hora que vale para o atraso: a chegada do pedido, antes de ler o corpo (D8).
        req.assignmentRequestAt = Date.now();
        next();
    }, validateStudentSession, async (req, res) => {
        const requestAt = req.assignmentRequestAt;
        const found = loadVisibleAssignment(req, res, { now: requestAt });
        if (!found) return refuseBeforeBody(req, res, () => undefined);
        const { task, cls } = found;
        // Turma encerrada recusa o envio antes de receber o corpo (e de novo na gravação).
        try {
            academicCalendar.assertClassOpen(cls);
        } catch (err) {
            if (isClassClosedError(err)) return refuseBeforeBody(req, res, () => res.status(409).json(classClosedBody()));
            throw err;
        }
        const existing = assignments.findSubmission(db.memory, task.id, req.studentEmail);
        const acceptance = assignments.submissionAcceptance(task, existing, { now: requestAt });
        if (!acceptance.accepts) return refuseBeforeBody(req, res, () => acceptanceRefusal(res, acceptance));
        const entregas = entregasSettings();
        const rules = assignments.submissionRules(task, entregas);
        const declared = Number(req.get('content-length'));
        if (rules.maxTotalMb && Number.isFinite(declared) && declared > rules.maxTotalMb * MB + MULTIPART_OVERHEAD_BYTES) {
            return refuseBeforeBody(req, res, () => sendError(res, 413, `O envio passa do limite de ${rules.maxTotalMb} MB por envio. Envie menos arquivos ou arquivos menores.`, { code: 'submission_too_large' }));
        }
        const space = await assignmentFiles.checkFreeSpace({ minFreeMb: entregas.discoLivreMinimoMb, incomingBytes: Number.isFinite(declared) ? declared : 0 });
        if (!space.ok) return refuseBeforeBody(req, res, () => sendError(res, 507, assignmentFiles.DISK_FULL_MESSAGE, { code: 'disk_full' }));
        if (!/^multipart\/form-data/i.test(String(req.get('content-type') || ''))) {
            return refuseBeforeBody(req, res, () => sendError(res, 400, MESSAGES.invalidForm, { code: 'invalid_form' }));
        }

        const uploadError = await receiveUpload(req, res, rules);
        const uploaded = Array.isArray(req.files) ? req.files : [];
        if (uploadError) {
            await assignmentFiles.discardReceivedFiles(uploaded);
            return multerErrorResponse(uploadError, req, res, rules);
        }
        const discard = () => assignmentFiles.discardReceivedFiles(uploaded);
        if (!SUBMIT_SCHEMA.check(req, res)) { await discard(); return undefined; }
        const text = typeof req.body.text === 'string' && req.body.text.trim() ? req.body.text : '';
        const link = typeof req.body.link === 'string' ? req.body.link.trim() : '';
        if (text && !rules.response.text) { await discard(); return sendError(res, 400, MESSAGES.noText, { code: 'text_not_accepted', field: 'text' }); }
        if (link && !rules.response.link) { await discard(); return sendError(res, 400, MESSAGES.noLink, { code: 'link_not_accepted', field: 'link' }); }
        if (link) {
            let parsed = null;
            try { parsed = new URL(link); } catch (e) { parsed = null; }
            if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
                await discard();
                return sendError(res, 400, MESSAGES.link, { code: 'invalid_link', field: 'link' });
            }
        }
        if (!uploaded.length && !text && !link) {
            const options = [rules.response.files && 'um arquivo', rules.response.text && 'a resposta em texto', rules.response.link && 'o link'].filter(Boolean);
            const joined = options.length > 1 ? `${options.slice(0, -1).join(', ')} ou ${options[options.length - 1]}` : options[0];
            return sendError(res, 400, `O envio está vazio. Envie ${joined}.`, { code: 'empty_submission' });
        }

        // Cada arquivo conferido de verdade (tipo, assinatura, tamanho, sha256); um recusado
        // descarta o envio inteiro.
        const received = [];
        for (const file of uploaded) {
            const checked = await assignmentFiles.validateReceivedFile(file, rules);
            if (!checked.ok) {
                await discard();
                if (checked.retryable) return sendError(res, 503, checked.message, { code: checked.code, retryable: true });
                return sendError(res, checked.status || 400, checked.message, { code: checked.code });
            }
            received.push({ tempPath: file.path, file: checked.file });
        }
        const total = received.reduce((sum, item) => sum + item.file.size, 0);
        if (rules.maxTotalMb && total > rules.maxTotalMb * MB) {
            await discard();
            return sendError(res, 413, `O envio passa do limite de ${rules.maxTotalMb} MB por envio. Envie menos arquivos ou arquivos menores.`, { code: 'submission_too_large' });
        }

        let outcome;
        try {
            outcome = await withSubmissionLock(submissionLockKey(task.id, req.studentEmail), () => commitVersion(req, {
                assignmentId: task.id, requestAt, received, text, link,
            }));
        } catch (err) {
            await discard();
            throw err;
        }
        if (outcome.status !== 201) await discard();
        return res.status(outcome.status).json(outcome.body);
    });

    router.get('/api/student/assignments/:id/files/:fileId', validateStudentSession, (req, res) => {
        const found = loadVisibleAssignment(req, res);
        if (!found) return undefined;
        const fileId = typeof req.params.fileId === 'string' ? req.params.fileId : '';
        const rawSub = assignmentFiles.isFileId(fileId) ? assignments.findSubmission(db.memory, found.task.id, req.studentEmail) : null;
        const sub = rawSub ? assignments.normalizeSubmission(rawSub) : null;
        const file = sub ? sub.versions.flatMap(version => version.files).find(item => item.id === fileId) : null;
        if (!file) return sendError(res, 404, MESSAGES.fileNotFound);
        // Anexo, nosniff e CSP sandbox; 404 file_missing e 503 read_failed como no painel.
        return assignmentFiles.sendStoredFile(res, file, {
            missingMessage: MESSAGES.fileMissing,
            readFailedMessage: MESSAGES.readFailed,
            onReadError: err => logError('[TAREFAS] Falha ao ler o arquivo de uma entrega', err),
        });
    });

    return router;
}

module.exports = { createStudentAssignmentsRouter, withSubmissionLock, pendingLocks };
