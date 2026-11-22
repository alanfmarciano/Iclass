// ---------------------------------------------------------------------------
// Tarefas pelo painel do instrutor (fase 3, C4 / P1-b; FUN-01, D11 e D13 do P1): o
// cadastro da tarefa. A correção, a devolução, a prorrogação, a entrega em mãos, o
// download e o ZIP (P1-d, C6) entram neste mesmo router depois.
//
// GET  /api/admin/assignments?courseId&studentClass&status   lista com as contagens
// POST /api/admin/assignments                                 cria (rascunho ou publicada)
// GET  /api/admin/assignments/:id                              tarefa e a lista da turma
// POST /api/admin/assignments/:id/update                       altera
// POST /api/admin/assignments/:id/publish                      publica o rascunho
// POST /api/admin/assignments/:id/archive                      arquiva (some do aluno)
// POST /api/admin/assignments/:id/unarchive                    reativa
// POST /api/admin/assignments/:id/delete                       exclui (só sem entregas)
// POST /api/admin/assignments/:id/copy                         copia para outra turma
//
// Regras:
// - Permissão 'page.assignments' no guarda (adminPermissions.js, regra /assignments). A
//   coordenação (só consulta) vê pelo GET; o POST dela recebe 403 read_only_account no
//   guarda. O Professor auxiliar e a Secretaria não têm a permissão.
// - Escopo sempre pela turma e pelo curso DO REGISTRO da tarefa (adminCanAccessClass),
//   nunca pelo corpo do pedido (contrato rbac.regras_por_grupo P1). Na criação e na cópia,
//   a turma de destino é conferida no guarda (corpo) e de novo aqui (turma achada).
// - Prazos digitados como data + hora no relógio da escola (dueDate/dueTime,
//   closeDate/closeTime, opensDate/opensTime) e gravados como instante em ms por
//   schoolTime.deadlineFromLocal (assignments.deadlineFields). A resposta traz os mesmos
//   campos em local (para o formulário) e serverNow (o relógio do servidor, D8).
// - Rascunho pode ficar sem prazo; publicar exige prazo, ao menos uma forma de resposta e,
//   com arquivo, ao menos um tipo aceito (publishProblem). Tarefa publicada continua com
//   essas regras em toda alteração.
// - Mudar abertura, prazo ou encerramento de tarefa que já tem entrega exige motivo
//   (reason, 3 a 500 caracteres), que vai para a auditoria.
// - Excluir só sem nenhum registro de aluno (D13); com entrega, só arquivar. Arquivada não
//   muda (reative antes). Nada aqui apaga entrega ou arquivo.
// - Auditoria na mesma gravação (categoria 'assignment'): assignment_created,
//   assignment_updated (antes e depois só do que mudou), assignment_published,
//   assignment_archived, assignment_unarchived, assignment_deleted (cópia em
//   details.deleted) e assignment_copied. Pedido que não muda nada não grava nem registra.
// - Gravação parcial: db.save({ only: ['assignments', 'auditLogs'] }).
// ---------------------------------------------------------------------------
const express = require('express');
const db = require('../database.js');
const { adminCanAccessClass, findClassByNameAndCourse, validateAdmin } = require('../middlewares.js');
const { outOfScopeMessage } = require('../utils/adminRoles.js');
const { recordAudit } = require('../utils/audit.js');
const settingsUtil = require('../utils/settings.js');
const schoolTime = require('../utils/schoolTime.js');
const assignments = require('../utils/assignments.js');
const assignmentFiles = require('../utils/assignmentFiles.js');
const { isCourseDeleted } = require('../utils/contentAccess.js');
const { effectiveStructure } = require('../utils/classContent.js');
const { visibleLibraryEntries } = require('../utils/studentLibrary.js');
const { displayName, isClosedStudentStatus, isAnonymizedStudent, studentInClass } = require('../utils/students.js');
const studentIdentity = require('../utils/studentIdentity.js');
const { compareText } = require('../utils/textSearch.js');
const { KEY_PATTERN, body, bool, int, list, oneOf, shape, str } = require('../utils/inputSchema.js');

const { LIMITS } = assignments;
const ASSIGNMENT_ID_MAX = 100;
const LIST_STATUSES = Object.freeze(['ativas', 'rascunho', 'publicada', 'arquivada', 'todas']);
// Campos que a tela altera e que a auditoria compara (antes e depois).
const EDITABLE_KEYS = Object.freeze([
    'title', 'instructions', 'moduleId', 'unitKey', 'libraryIds', 'response', 'files',
    'opensAt', 'dueAt', 'closeAt', 'latePolicy', 'countsInAverage',
]);
const DEADLINE_KEYS = Object.freeze(['opensAt', 'dueAt', 'closeAt']);
// Os pares data + hora de cada instante: prefixo do corpo, chave gravada e o fim da frase
// das mensagens.
const DEADLINE_FIELDS = Object.freeze([
    { prefix: 'opens', key: 'opensAt', label: 'da abertura', defaultTime: '00:00' },
    { prefix: 'due', key: 'dueAt', label: 'do prazo', defaultTime: '23:59' },
    { prefix: 'close', key: 'closeAt', label: 'do encerramento', defaultTime: '23:59' },
]);

const MESSAGES = Object.freeze({
    notFound: 'Tarefa não encontrada.',
    classNotFound: 'Turma não encontrada.',
    title: `O título da tarefa precisa ter de ${LIMITS.titleMin} a ${LIMITS.titleMax} caracteres.`,
    response: 'Escolha ao menos uma forma de resposta: arquivo, texto ou link.',
    types: 'Escolha ao menos um tipo de arquivo ou informe um formato do curso.',
    dueRequired: 'Informe o prazo da tarefa (data e hora) antes de publicar.',
    archived: 'Esta tarefa está arquivada. Reative a tarefa para alterar.',
    archivedPublish: 'Esta tarefa está arquivada. Reative a tarefa antes de publicar.',
    otherClass: 'A turma de uma tarefa não muda. Para usar a tarefa em outra turma, use "Copiar para outra turma".',
    reason: `Esta tarefa já tem entregas. Para mudar a abertura, o prazo ou o encerramento, informe o motivo (de ${LIMITS.reasonMin} a ${LIMITS.reasonMax} caracteres).`,
    confirm: 'Digite EXCLUIR para confirmar.',
    hasSubmissions: 'Esta tarefa já tem entregas ou registros de alunos e não pode ser excluída. Arquive a tarefa para ela sumir para os alunos.',
    penaltyPerDay: 'Com desconto por atraso, informe o desconto por dia (de 1% a 100%).',
    penaltyMax: 'Com desconto por atraso, o desconto máximo precisa ser de 1% a 100%.',
});

// ------------------------------------------------------------ schemas
const dateField = label => str({ max: 10, nullable: true, label });
const timeField = label => str({ max: 8, nullable: true, label });

const DEADLINE_SCHEMA = {
    opensDate: dateField('data da abertura'),
    opensTime: timeField('hora da abertura'),
    dueDate: dateField('data do prazo'),
    dueTime: timeField('hora do prazo'),
    closeDate: dateField('data do encerramento'),
    closeTime: timeField('hora do encerramento'),
};

const FIELDS_SCHEMA = {
    title: str({ max: LIMITS.titleMax, nullable: true, label: 'título' }),
    instructions: str({ max: LIMITS.instructionsMax, trim: false, nullable: true, label: 'instruções' }),
    moduleId: str({ max: 100, nullable: true, label: 'módulo' }),
    unitKey: str({ max: 200, pattern: KEY_PATTERN, nullable: true, label: 'unidade' }),
    libraryIds: list(str({ max: 100, label: 'material de apoio' }), { max: LIMITS.libraryIdsMax, nullable: true, label: 'materiais de apoio' }),
    response: shape({
        files: bool({ label: 'responder com arquivo' }),
        text: bool({ label: 'responder com texto' }),
        link: bool({ label: 'responder com link' }),
    }, { label: 'forma de resposta' }),
    files: shape({
        maxFiles: int({ min: LIMITS.maxFilesMin, max: LIMITS.maxFilesMax, coerce: true, label: 'número de arquivos por envio' }),
        maxSizeMb: int({ min: LIMITS.maxSizeMbMin, max: 4096, coerce: true, label: 'tamanho máximo por arquivo (MB)' }),
        types: list(oneOf(assignmentFiles.FILE_TYPE_KEYS, { label: 'tipo de arquivo' }), { max: assignmentFiles.FILE_TYPE_KEYS.length, label: 'tipos de arquivo' }),
        extraExtensions: list(str({ max: 20, label: 'formato do curso' }), { max: assignmentFiles.EXTRA_EXTENSIONS_MAX, label: 'formatos do curso' }),
    }, { label: 'arquivos' }),
    ...DEADLINE_SCHEMA,
    latePolicy: shape({
        mode: oneOf(assignments.LATE_MODES, { label: 'regra de atraso' }),
        penaltyPerDayPct: int({ min: 0, max: 100, coerce: true, label: 'desconto por dia (%)' }),
        penaltyMaxPct: int({ min: 0, max: 100, coerce: true, label: 'desconto máximo (%)' }),
    }, { label: 'regra de atraso' }),
    countsInAverage: bool({ label: 'conta na média' }),
    publish: bool({ label: 'publicar agora' }),
    reason: str({ max: LIMITS.reasonMax, nullable: true, label: 'motivo' }),
};

const SCHEMAS = {
    list: shape({
        courseId: str({ max: 100, label: 'curso' }),
        studentClass: str({ max: 200, label: 'turma' }),
        status: oneOf(LIST_STATUSES, { label: 'situação' }),
    }),
    create: body({
        courseId: str({ max: 100, required: true, label: 'curso' }),
        studentClass: str({ max: 200, required: true, label: 'turma' }),
        ...FIELDS_SCHEMA,
    }),
    update: body({
        courseId: str({ max: 100, nullable: true, label: 'curso' }),
        studentClass: str({ max: 200, nullable: true, label: 'turma' }),
        ...FIELDS_SCHEMA,
    }),
    empty: body({}),
    remove: body({ confirm: str({ max: 20, nullable: true, label: 'confirmação' }) }),
    copy: body({
        courseId: str({ max: 100, required: true, label: 'curso' }),
        studentClass: str({ max: 200, required: true, label: 'turma' }),
        ...DEADLINE_SCHEMA,
    }),
};

// ------------------------------------------------------------ apoio
function hasKey(source, key) {
    return !!source && Object.prototype.hasOwnProperty.call(source, key);
}

function sendFieldError(res, error, field, { status = 400, code } = {}) {
    return res.status(status).json({ success: false, error, ...(field ? { field } : {}), ...(code ? { code } : {}) });
}

function timezone() {
    return settingsUtil.getSettings().timezone;
}

// Teto do tamanho por arquivo que o professor pode escolher (settings.entregas, D17).
function perFileCeilingMb() {
    const entregas = settingsUtil.getSettings().entregas || {};
    const value = Math.floor(Number(entregas.maxMbPorArquivo));
    return Number.isFinite(value) && value >= 1 ? value : assignments.DEFAULT_FILE_RULES.maxSizeMb;
}

// Turma e curso existentes (curso não excluído), ou null.
function findTargetClass(courseId, studentClass) {
    const course = (db.memory.courses || []).find(item => item && String(item.id) === String(courseId || ''));
    const cls = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId);
    if (!course || isCourseDeleted(course) || !cls || String(cls.courseId || '') !== String(course.id)) return null;
    return { course, cls };
}

// A tarefa do caminho, conferida contra o escopo da conta pela turma do registro. Já
// respondeu (404 ou 403) quando devolve null.
function loadScopedAssignment(req, res, account) {
    const id = typeof req.params.id === 'string' ? req.params.id : '';
    const raw = id && id.length <= ASSIGNMENT_ID_MAX ? assignments.findAssignment(db.memory, id) : null;
    if (!raw) {
        res.status(404).json({ success: false, error: MESSAGES.notFound });
        return null;
    }
    const task = assignments.normalizeAssignment(raw);
    if (!adminCanAccessClass(account, task.studentClass, task.courseId)) {
        res.status(403).json({ success: false, error: outOfScopeMessage(account, 'A tarefa solicitada') });
        return null;
    }
    return { raw, task };
}

function replaceAssignment(raw, next) {
    const rows = Array.isArray(db.memory.assignments) ? db.memory.assignments : [];
    const index = rows.indexOf(raw);
    if (index >= 0) rows[index] = next;
}

// Entregas com algo do aluno ou do professor (versão, entrega em mãos ou nota).
function deliveredSubmissions(memory, assignmentId) {
    return assignments.submissionsForAssignment(memory, assignmentId)
        .map(raw => assignments.normalizeSubmission(raw))
        .filter(sub => sub.versions.length > 0 || !!sub.manualEntry || !!sub.grade);
}

// Unidades do módulo com a chave de cada uma (a da apostila, a da avaliação ou a própria).
function unitKeysOf(module) {
    const keys = new Set();
    (module && (module.units || module.items) || []).forEach(unit => {
        if (!unit || typeof unit !== 'object') return;
        [unit.apostilaKey, unit.avaliacaoKey, unit.key].forEach(key => { if (typeof key === 'string' && key) keys.add(key); });
    });
    return keys;
}

function structureOf(courseId, studentClass) {
    try {
        const effective = effectiveStructure(courseId, studentClass);
        return Array.isArray(effective && effective.structure) ? effective.structure : [];
    } catch (e) {
        return [];
    }
}

// Módulo e unidade escolhidos, conferidos na estrutura da turma: { moduleId, unitKey } ou
// { error, field }. Unidade sem módulo vale o módulo dela.
function resolveModuleUnit({ moduleId, unitKey }, { courseId, studentClass }) {
    const wantedModule = String(moduleId || '').trim();
    const wantedUnit = String(unitKey || '').trim();
    if (!wantedModule && !wantedUnit) return { moduleId: '', unitKey: '' };
    const structure = structureOf(courseId, studentClass);
    if (wantedModule) {
        const module = structure.find(item => item && String(item.id) === wantedModule);
        if (!module) return { error: 'Módulo não encontrado no curso desta turma.', field: 'moduleId' };
        if (wantedUnit && !unitKeysOf(module).has(wantedUnit)) return { error: 'Unidade não encontrada no módulo escolhido.', field: 'unitKey' };
        return { moduleId: String(module.id), unitKey: wantedUnit };
    }
    const module = structure.find(item => unitKeysOf(item).has(wantedUnit));
    if (!module) return { error: 'Unidade não encontrada no curso desta turma.', field: 'unitKey' };
    return { moduleId: String(module.id), unitKey: wantedUnit };
}

// Materiais de apoio: só os da Biblioteca que o aluno da turma vê. { value } ou { error, field }.
function resolveLibraryIds(ids, { courseId, studentClass }) {
    const visible = new Set(visibleLibraryEntries(db.memory.library || [], courseId, studentClass).map(entry => String(entry.id)));
    const out = [];
    for (let index = 0; index < ids.length; index += 1) {
        const id = String(ids[index] || '').trim();
        if (!id) continue;
        if (!visible.has(id)) return { error: 'Material de apoio não encontrado na Biblioteca deste curso ou desta turma.', field: `libraryIds[${index}]` };
        if (!out.includes(id)) out.push(id);
    }
    return { value: out };
}

// Lê do corpo (já conferido pelo schema) os campos da tarefa. Na alteração (current), só
// os campos enviados mudam; na criação, os ausentes ficam com o padrão. Devolve
// { fields } ou { error, field }.
function readAssignmentFields(source, { current = null, courseId, studentClass, tz }) {
    const base = current ? assignments.normalizeAssignment(current) : null;
    const out = {};

    if (hasKey(source, 'title') || !base) {
        const title = typeof source.title === 'string' ? source.title.trim() : '';
        if (title.length < LIMITS.titleMin || title.length > LIMITS.titleMax) return { error: MESSAGES.title, field: 'title' };
        out.title = title;
    }
    if (hasKey(source, 'instructions')) out.instructions = typeof source.instructions === 'string' ? source.instructions : '';

    if (hasKey(source, 'moduleId') || hasKey(source, 'unitKey')) {
        const explicitUnit = hasKey(source, 'unitKey');
        const moduleId = hasKey(source, 'moduleId') ? source.moduleId : (base ? base.moduleId : '');
        let unitKey = explicitUnit ? source.unitKey : (base ? base.unitKey : '');
        // Trocou só o módulo: a unidade gravada que não é do módulo novo sai.
        if (!explicitUnit && unitKey && moduleId) {
            const module = structureOf(courseId, studentClass).find(item => item && String(item.id) === String(moduleId).trim());
            if (module && !unitKeysOf(module).has(unitKey)) unitKey = '';
        }
        const resolved = resolveModuleUnit({ moduleId, unitKey }, { courseId, studentClass });
        if (resolved.error) return resolved;
        out.moduleId = resolved.moduleId;
        out.unitKey = resolved.unitKey;
    }

    if (hasKey(source, 'libraryIds')) {
        const resolved = resolveLibraryIds(Array.isArray(source.libraryIds) ? source.libraryIds : [], { courseId, studentClass });
        if (resolved.error) return resolved;
        out.libraryIds = resolved.value;
    }

    if (hasKey(source, 'response')) {
        const response = { files: source.response.files === true, text: source.response.text === true, link: source.response.link === true };
        if (!response.files && !response.text && !response.link) return { error: MESSAGES.response, field: 'response' };
        out.response = response;
    }

    if (hasKey(source, 'files') || !base) {
        const sent = hasKey(source, 'files') ? source.files : {};
        const previous = base ? base.files : { ...assignments.DEFAULT_FILE_RULES, maxSizeMb: Math.min(assignments.DEFAULT_FILE_RULES.maxSizeMb, perFileCeilingMb()) };
        const rules = { ...previous };
        if (hasKey(sent, 'maxFiles')) rules.maxFiles = sent.maxFiles;
        if (hasKey(sent, 'maxSizeMb')) {
            const ceiling = perFileCeilingMb();
            if (sent.maxSizeMb > ceiling) {
                return { error: `O tamanho máximo por arquivo vai até ${ceiling} MB (o limite das entregas em Sistema).`, field: 'files.maxSizeMb' };
            }
            rules.maxSizeMb = sent.maxSizeMb;
        }
        if (hasKey(sent, 'types')) rules.types = assignmentFiles.normalizeFileTypes(sent.types);
        if (hasKey(sent, 'extraExtensions')) {
            const extras = assignmentFiles.normalizeExtraExtensions(sent.extraExtensions, { strict: true });
            if (extras.error) return { error: extras.error, field: 'files.extraExtensions' };
            rules.extraExtensions = extras.value;
        }
        out.files = { maxFiles: rules.maxFiles, maxSizeMb: rules.maxSizeMb, types: [...rules.types], extraExtensions: [...rules.extraExtensions] };
    }

    for (const deadline of DEADLINE_FIELDS) {
        const dateKey = `${deadline.prefix}Date`;
        const timeKey = `${deadline.prefix}Time`;
        if (!hasKey(source, dateKey) && !hasKey(source, timeKey)) continue;
        // Na alteração, a metade do par que não veio no pedido fica como estava (mandar só
        // a data nova não troca a hora gravada pelo padrão).
        let pair = source;
        const stored = base && base[deadline.key] !== null ? schoolTime.localParts(base[deadline.key], tz) : null;
        if (stored && hasKey(source, dateKey) !== hasKey(source, timeKey)) {
            pair = hasKey(source, dateKey) ? { [dateKey]: source[dateKey], [timeKey]: source[dateKey] ? stored.time : null } : { [dateKey]: stored.date, [timeKey]: source[timeKey] };
        }
        const read = assignments.deadlineFields(pair, deadline.prefix, { label: deadline.label, timezone: tz, defaultTime: deadline.defaultTime });
        if (read.error) return { error: read.error, field: read.field };
        out[deadline.key] = read.value;
    }

    if (hasKey(source, 'latePolicy')) {
        const sent = source.latePolicy;
        const policy = { ...(base ? base.latePolicy : assignments.DEFAULT_LATE_POLICY) };
        ['mode', 'penaltyPerDayPct', 'penaltyMaxPct'].forEach(key => {
            if (hasKey(sent, key) && sent[key] !== '' && sent[key] !== undefined) policy[key] = sent[key];
        });
        if (policy.mode === 'desconto') {
            if (!(policy.penaltyPerDayPct >= 1)) return { error: MESSAGES.penaltyPerDay, field: 'latePolicy.penaltyPerDayPct' };
            if (!(policy.penaltyMaxPct >= 1)) return { error: MESSAGES.penaltyMax, field: 'latePolicy.penaltyMaxPct' };
        }
        out.latePolicy = { mode: policy.mode, penaltyPerDayPct: policy.penaltyPerDayPct, penaltyMaxPct: policy.penaltyMaxPct };
    }

    if (hasKey(source, 'countsInAverage')) out.countsInAverage = source.countsInAverage === true;
    return { fields: out };
}

// A combinação que vale para toda tarefa (rascunho também): ordem das datas e, com
// arquivo, algum tipo aceito.
function shapeProblem(task) {
    const order = assignments.windowOrderError(task);
    if (order) return order;
    if (task.response.files && assignmentFiles.acceptedExtensions(task.files).length === 0) return { error: MESSAGES.types, field: 'files.types' };
    return null;
}

// O que falta para a tarefa poder ficar publicada.
function publishProblem(task) {
    if (task.title.length < LIMITS.titleMin) return { error: MESSAGES.title, field: 'title' };
    if (task.dueAt === null) return { error: MESSAGES.dueRequired, field: 'dueDate' };
    return shapeProblem(task);
}

function localFields(task, tz) {
    const out = {};
    DEADLINE_FIELDS.forEach(({ prefix, key }) => {
        const parts = task[key] === null ? null : schoolTime.localParts(task[key], tz);
        out[`${prefix}Date`] = parts ? parts.date : '';
        out[`${prefix}Time`] = parts ? parts.time : '';
    });
    return out;
}

// A tarefa como sai para o painel (nunca campo interno desconhecido). summary: as
// contagens da turma (assignmentStatusSummary, contrato C4 do P1).
function presentAssignment(memory, raw, { tz, full = true } = {}) {
    const task = assignments.normalizeAssignment(raw);
    const out = {
        id: task.id,
        schemaVersion: task.schemaVersion,
        courseId: task.courseId,
        studentClass: task.studentClass,
        moduleId: task.moduleId,
        unitKey: task.unitKey,
        title: task.title,
        status: task.status,
        response: task.response,
        files: task.files,
        accept: assignmentFiles.acceptedExtensions(task.files),
        opensAt: task.opensAt,
        dueAt: task.dueAt,
        closeAt: task.closeAt,
        latePolicy: task.latePolicy,
        countsInAverage: task.countsInAverage,
        createdBy: task.createdBy,
        createdAt: task.createdAt,
        updatedBy: task.updatedBy,
        updatedAt: task.updatedAt,
        publishedAt: task.publishedAt,
        archivedAt: task.archivedAt,
        archivedBy: task.archivedBy,
        local: localFields(task, tz),
        counts: assignments.assignmentStatusSummary(memory, task),
    };
    if (full) {
        out.instructions = task.instructions;
        out.libraryIds = task.libraryIds;
    }
    return out;
}

// Cópia da tarefa para a auditoria (sem contagens nem campos calculados).
function auditSnapshot(task) {
    const out = {};
    ['id', 'courseId', 'studentClass', 'status', ...EDITABLE_KEYS, 'createdBy', 'createdAt', 'publishedAt', 'archivedAt'].forEach(key => { out[key] = task[key]; });
    return out;
}

function changedKeys(before, after) {
    return EDITABLE_KEYS.filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

function compareAssignments(a, b) {
    const dueA = a.dueAt === null ? Infinity : a.dueAt;
    const dueB = b.dueAt === null ? Infinity : b.dueAt;
    if (dueA !== dueB) return dueA - dueB;
    return compareText(a.title, b.title) || (b.createdAt || 0) - (a.createdAt || 0) || compareText(String(a.id), String(b.id));
}

// Uma linha da lista da turma no detalhe da tarefa (nunca storedRel nem caminho).
function rosterRow(task, row) {
    const sub = row.submission ? assignments.normalizeSubmission(row.submission) : null;
    const student = row.student;
    const last = sub && sub.versions.length ? sub.versions[sub.versions.length - 1] : null;
    const enrolled = !!student && !isAnonymizedStudent(student) && !isClosedStudentStatus(student.status)
        && studentInClass(student, task.studentClass, task.courseId);
    return {
        studentEmail: row.studentEmail,
        studentId: row.studentId || null,
        semEmail: studentIdentity.isPlaceholderEmail(row.studentEmail),
        name: student ? displayName(student) : '',
        matricula: student ? String(student.matricula || '') : '',
        studentStatus: student ? String(student.status || '') : '',
        enrolled,
        submissionId: sub ? sub.id : null,
        status: assignments.instructorStatus(sub),
        versions: sub ? sub.versions.length : 0,
        lastVersion: last ? {
            n: last.n,
            requestAt: last.requestAt,
            receivedAt: last.receivedAt,
            late: last.late,
            lateMs: last.lateMs,
            filesCount: last.files.length,
            bytes: last.files.reduce((total, file) => total + file.size, 0),
            hasText: !!last.text,
            hasLink: !!last.link,
        } : null,
        newVersionAfterGrade: !!(sub && sub.grade && last && last.n > sub.grade.versionGraded),
        grade: sub && sub.grade ? {
            score: sub.grade.score,
            penaltyPct: sub.grade.penaltyPct,
            finalScore: sub.grade.finalScore,
            comment: sub.grade.comment,
            versionGraded: sub.grade.versionGraded,
            gradedBy: sub.grade.gradedBy,
            gradedAt: sub.grade.gradedAt,
            penaltyWaived: sub.grade.penaltyWaived,
        } : null,
        returnedAt: sub ? sub.returnedAt : null,
        extension: sub && sub.extension ? {
            dueAt: sub.extension.dueAt,
            closeAt: sub.extension.closeAt,
            by: sub.extension.by,
            at: sub.extension.at,
            reason: sub.extension.reason,
        } : null,
        manualEntry: sub && sub.manualEntry ? { note: sub.manualEntry.note, by: sub.manualEntry.by, at: sub.manualEntry.at } : null,
        anonymized: !!(sub && sub.anonymized) || (!!student && isAnonymizedStudent(student)),
    };
}

function audit(req, account, action, task, extra = {}) {
    recordAudit(db.memory, {
        req,
        actor: account,
        action,
        category: 'assignment',
        courseId: task.courseId,
        studentClass: task.studentClass,
        ...extra,
    });
}

// ------------------------------------------------------------ rotas
function createAdminAssignmentsRouter() {
    const router = express.Router();

    router.get('/api/admin/assignments', (req, res) => validateAdmin(req, res, (config, account) => {
        const query = { ...(req.query || {}) };
        const checked = SCHEMAS.list.run(query, '', 'filtro');
        if (!checked.ok) return sendFieldError(res, checked.error, checked.field);
        const courseId = String(query.courseId || '').trim();
        const studentClass = String(query.studentClass || '').trim();
        const status = String(query.status || '').trim() || 'ativas';
        const statuses = status === 'todas' ? null : (status === 'ativas' ? ['rascunho', 'publicada'] : [status]);
        const tz = timezone();
        const items = assignments.assignmentList(db.memory)
            .map(raw => ({ raw, task: assignments.normalizeAssignment(raw) }))
            .filter(({ task }) => (!courseId || task.courseId === courseId)
                && (!studentClass || task.studentClass === studentClass)
                && (!statuses || statuses.includes(task.status))
                && adminCanAccessClass(account, task.studentClass, task.courseId))
            .sort((a, b) => compareAssignments(a.task, b.task))
            .map(({ raw }) => presentAssignment(db.memory, raw, { tz, full: false }));
        res.json({ success: true, assignments: items, serverNow: Date.now(), timezone: tz });
    }));

    router.post('/api/admin/assignments', SCHEMAS.create, (req, res) => validateAdmin(req, res, async (config, account) => {
        const target = findTargetClass(req.body.courseId, req.body.studentClass);
        if (!target) return sendFieldError(res, MESSAGES.classNotFound, 'studentClass', { status: 404 });
        const { cls } = target;
        if (!adminCanAccessClass(account, cls.name, cls.courseId)) {
            return sendFieldError(res, outOfScopeMessage(account, 'A turma solicitada'), 'studentClass', { status: 403 });
        }
        const tz = timezone();
        const read = readAssignmentFields(req.body, { courseId: cls.courseId, studentClass: cls.name, tz });
        if (read.error) return sendFieldError(res, read.error, read.field);
        const publish = req.body.publish === true;
        const now = Date.now();
        const record = assignments.newAssignmentRecord({
            ...read.fields,
            courseId: cls.courseId,
            studentClass: cls.name,
            status: publish ? 'publicada' : 'rascunho',
        }, { actor: account, now });
        const problem = publish ? publishProblem(record) : shapeProblem(record);
        if (problem) return sendFieldError(res, problem.error, problem.field);

        if (!Array.isArray(db.memory.assignments)) db.memory.assignments = [];
        db.memory.assignments.push(record);
        audit(req, account, 'assignment_created', record, {
            after: auditSnapshot(record),
            details: { id: record.id, title: record.title, dueAt: record.dueAt, closeAt: record.closeAt, latePolicy: record.latePolicy, response: record.response, files: record.files },
        });
        if (publish) audit(req, account, 'assignment_published', record, { details: { id: record.id, opensAt: record.opensAt } });
        await db.save({ only: ['assignments', 'auditLogs'] });
        res.status(201).json({ success: true, assignment: presentAssignment(db.memory, record, { tz }) });
    }));

    router.get('/api/admin/assignments/:id', (req, res) => validateAdmin(req, res, (config, account) => {
        const found = loadScopedAssignment(req, res, account);
        if (!found) return;
        const tz = timezone();
        const roster = assignments.assignmentRoster(db.memory, found.task).map(row => rosterRow(found.task, row));
        res.json({ success: true, assignment: presentAssignment(db.memory, found.raw, { tz }), roster, serverNow: Date.now(), timezone: tz });
    }));

    router.post('/api/admin/assignments/:id/update', SCHEMAS.update, (req, res) => validateAdmin(req, res, async (config, account) => {
        const found = loadScopedAssignment(req, res, account);
        if (!found) return;
        const { raw, task } = found;
        if (task.status === 'arquivada') return sendFieldError(res, MESSAGES.archived, null, { status: 409, code: 'assignment_archived' });
        const sentCourse = typeof req.body.courseId === 'string' ? req.body.courseId.trim() : '';
        const sentClass = typeof req.body.studentClass === 'string' ? req.body.studentClass.trim() : '';
        if ((sentCourse && sentCourse !== task.courseId) || (sentClass && sentClass !== task.studentClass)) {
            return sendFieldError(res, MESSAGES.otherClass, sentClass && sentClass !== task.studentClass ? 'studentClass' : 'courseId');
        }
        const tz = timezone();
        const read = readAssignmentFields(req.body, { current: raw, courseId: task.courseId, studentClass: task.studentClass, tz });
        if (read.error) return sendFieldError(res, read.error, read.field);
        const now = Date.now();
        const merged = assignments.normalizeAssignment({ ...raw, ...read.fields });
        const problem = merged.status === 'publicada' ? publishProblem(merged) : shapeProblem(merged);
        if (problem) return sendFieldError(res, problem.error, problem.field);
        const keys = changedKeys(task, merged);
        if (!keys.length) return res.json({ success: true, changed: false, assignment: presentAssignment(db.memory, raw, { tz }) });

        const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
        const deadlineChanged = keys.some(key => DEADLINE_KEYS.includes(key));
        if (deadlineChanged && deliveredSubmissions(db.memory, task.id).length > 0
            && (reason.length < LIMITS.reasonMin || reason.length > LIMITS.reasonMax)) {
            return sendFieldError(res, MESSAGES.reason, 'reason', { code: 'reason_required' });
        }
        const next = { ...raw, ...merged, updatedBy: String(account.email || '').toLowerCase(), updatedAt: now };
        replaceAssignment(raw, next);
        const before = {};
        const after = {};
        keys.forEach(key => { before[key] = task[key]; after[key] = merged[key]; });
        audit(req, account, 'assignment_updated', merged, {
            before,
            after,
            reason: deadlineChanged && reason ? reason : undefined,
            details: { id: task.id, title: merged.title, campos: keys },
        });
        await db.save({ only: ['assignments', 'auditLogs'] });
        res.json({ success: true, changed: true, assignment: presentAssignment(db.memory, next, { tz }) });
    }));

    router.post('/api/admin/assignments/:id/publish', SCHEMAS.empty, (req, res) => validateAdmin(req, res, async (config, account) => {
        const found = loadScopedAssignment(req, res, account);
        if (!found) return;
        const { raw, task } = found;
        const tz = timezone();
        if (task.status === 'arquivada') return sendFieldError(res, MESSAGES.archivedPublish, null, { status: 409, code: 'assignment_archived' });
        if (task.status === 'publicada') return res.json({ success: true, changed: false, assignment: presentAssignment(db.memory, raw, { tz }) });
        const problem = publishProblem(task);
        if (problem) return sendFieldError(res, problem.error, problem.field);
        const now = Date.now();
        const by = String(account.email || '').toLowerCase();
        const next = { ...raw, ...task, status: 'publicada', publishedAt: now, updatedBy: by, updatedAt: now };
        replaceAssignment(raw, next);
        audit(req, account, 'assignment_published', task, { details: { id: task.id, title: task.title, opensAt: task.opensAt, dueAt: task.dueAt } });
        await db.save({ only: ['assignments', 'auditLogs'] });
        res.json({ success: true, changed: true, assignment: presentAssignment(db.memory, next, { tz }) });
    }));

    router.post('/api/admin/assignments/:id/archive', SCHEMAS.empty, (req, res) => validateAdmin(req, res, async (config, account) => {
        const found = loadScopedAssignment(req, res, account);
        if (!found) return;
        const { raw, task } = found;
        const tz = timezone();
        if (task.status === 'arquivada') return res.json({ success: true, changed: false, assignment: presentAssignment(db.memory, raw, { tz }) });
        const now = Date.now();
        const by = String(account.email || '').toLowerCase();
        const next = { ...raw, ...task, status: 'arquivada', archivedAt: now, archivedBy: by, updatedBy: by, updatedAt: now };
        replaceAssignment(raw, next);
        audit(req, account, 'assignment_archived', task, {
            details: { id: task.id, title: task.title, statusAnterior: task.status, entregas: deliveredSubmissions(db.memory, task.id).length },
        });
        await db.save({ only: ['assignments', 'auditLogs'] });
        res.json({ success: true, changed: true, assignment: presentAssignment(db.memory, next, { tz }) });
    }));

    router.post('/api/admin/assignments/:id/unarchive', SCHEMAS.empty, (req, res) => validateAdmin(req, res, async (config, account) => {
        const found = loadScopedAssignment(req, res, account);
        if (!found) return;
        const { raw, task } = found;
        const tz = timezone();
        if (task.status !== 'arquivada') return res.json({ success: true, changed: false, assignment: presentAssignment(db.memory, raw, { tz }) });
        // Volta como estava: publicada se já tinha sido publicada (e ainda pode), senão rascunho.
        const status = task.publishedAt !== null && !publishProblem({ ...task, status: 'publicada' }) ? 'publicada' : 'rascunho';
        const now = Date.now();
        const by = String(account.email || '').toLowerCase();
        const next = { ...raw, ...task, status, archivedAt: null, archivedBy: '', updatedBy: by, updatedAt: now };
        replaceAssignment(raw, next);
        audit(req, account, 'assignment_unarchived', task, { details: { id: task.id, title: task.title, status } });
        await db.save({ only: ['assignments', 'auditLogs'] });
        res.json({ success: true, changed: true, assignment: presentAssignment(db.memory, next, { tz }) });
    }));

    router.post('/api/admin/assignments/:id/delete', SCHEMAS.remove, (req, res) => validateAdmin(req, res, async (config, account) => {
        const found = loadScopedAssignment(req, res, account);
        if (!found) return;
        const { raw, task } = found;
        if (String(req.body.confirm || '').trim() !== 'EXCLUIR') return sendFieldError(res, MESSAGES.confirm, 'confirm', { code: 'confirm_required' });
        // Qualquer linha de aluno (até uma prorrogação sem envio) segura a tarefa: excluir
        // levaria junto o que é registro escolar (D13).
        const rows = assignments.submissionsForAssignment(db.memory, task.id);
        if (rows.length) {
            return sendFieldError(res, MESSAGES.hasSubmissions, null, { status: 409, code: 'assignment_has_submissions' });
        }
        db.memory.assignments = assignments.assignmentList(db.memory).filter(item => item !== raw);
        audit(req, account, 'assignment_deleted', task, { details: { id: task.id, title: task.title, deleted: auditSnapshot(task) } });
        await db.save({ only: ['assignments', 'auditLogs'] });
        res.json({ success: true });
    }));

    router.post('/api/admin/assignments/:id/copy', SCHEMAS.copy, (req, res) => validateAdmin(req, res, async (config, account) => {
        const found = loadScopedAssignment(req, res, account);
        if (!found) return;
        const { task } = found;
        const target = findTargetClass(req.body.courseId, req.body.studentClass);
        if (!target) return sendFieldError(res, MESSAGES.classNotFound, 'studentClass', { status: 404 });
        const { cls } = target;
        if (!adminCanAccessClass(account, cls.name, cls.courseId)) {
            return sendFieldError(res, outOfScopeMessage(account, 'A turma solicitada'), 'studentClass', { status: 403 });
        }
        const tz = timezone();
        const dates = {};
        for (const deadline of DEADLINE_FIELDS) {
            const read = assignments.deadlineFields(req.body, deadline.prefix, { label: deadline.label, timezone: tz, defaultTime: deadline.defaultTime });
            if (read.error) return sendFieldError(res, read.error, read.field);
            dates[deadline.key] = read.value;
        }
        // O que não existe na turma de destino fica de fora (e a resposta avisa).
        const avisos = [];
        let moduleUnit = { moduleId: '', unitKey: '' };
        if (task.moduleId || task.unitKey) {
            const resolved = resolveModuleUnit({ moduleId: task.moduleId, unitKey: task.unitKey }, { courseId: cls.courseId, studentClass: cls.name });
            if (resolved.error) {
                const moduleOnly = task.moduleId ? resolveModuleUnit({ moduleId: task.moduleId, unitKey: '' }, { courseId: cls.courseId, studentClass: cls.name }) : null;
                if (moduleOnly && !moduleOnly.error) moduleUnit = moduleOnly;
                avisos.push(moduleOnly && !moduleOnly.error
                    ? 'A unidade da tarefa não existe na turma de destino; a cópia ficou só com o módulo.'
                    : 'O módulo e a unidade da tarefa não existem na turma de destino; a cópia ficou sem eles.');
            } else moduleUnit = resolved;
        }
        const visible = new Set(visibleLibraryEntries(db.memory.library || [], cls.courseId, cls.name).map(entry => String(entry.id)));
        const libraryIds = task.libraryIds.filter(id => visible.has(id));
        if (libraryIds.length < task.libraryIds.length) {
            avisos.push(`${task.libraryIds.length - libraryIds.length} material(is) de apoio não aparece(m) para a turma de destino e ficou(aram) de fora.`);
        }
        const ceiling = perFileCeilingMb();
        const now = Date.now();
        const record = assignments.newAssignmentRecord({
            courseId: cls.courseId,
            studentClass: cls.name,
            ...moduleUnit,
            title: task.title,
            instructions: task.instructions,
            libraryIds,
            response: task.response,
            files: { ...task.files, maxSizeMb: Math.min(task.files.maxSizeMb, ceiling) },
            latePolicy: task.latePolicy,
            countsInAverage: task.countsInAverage,
            ...dates,
            status: 'rascunho',
        }, { actor: account, now });
        const problem = shapeProblem(record);
        if (problem) return sendFieldError(res, problem.error, problem.field);
        if (!Array.isArray(db.memory.assignments)) db.memory.assignments = [];
        db.memory.assignments.push(record);
        audit(req, account, 'assignment_copied', record, {
            after: auditSnapshot(record),
            details: { fromId: task.id, toId: record.id, fromCourseId: task.courseId, fromClass: task.studentClass, toCourseId: cls.courseId, toClass: cls.name, title: record.title, avisos },
        });
        await db.save({ only: ['assignments', 'auditLogs'] });
        res.status(201).json({ success: true, assignment: presentAssignment(db.memory, record, { tz }), avisos });
    }));

    return router;
}

module.exports = {
    createAdminAssignmentsRouter,
    loadScopedAssignment,
    presentAssignment,
    readAssignmentFields,
    publishProblem,
};
