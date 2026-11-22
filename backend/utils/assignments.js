// ---------------------------------------------------------------------------
// Tarefas com envio de arquivo (fase 3, P1-a; FUN-01). Regras da tarefa e da entrega,
// lidas por todas as rotas, pelo sino, pelo calendário, pela fila e pelo quadro de notas.
// Nenhuma rota recalcula prazo, atraso, desconto ou situação por conta própria.
//
// Coleções (registro único em database.js, missing 'keep'):
// - assignments: a tarefa, de uma turma (courseId + studentClass).
//   { id 'asg_<ms>_<6 hex>', schemaVersion 1, courseId, studentClass, moduleId, unitKey,
//     title, instructions (Markdown), libraryIds, response { files, text, link },
//     files { maxFiles, maxSizeMb, types, extraExtensions }, opensAt, dueAt, closeAt,
//     latePolicy { mode 'aceitar'|'desconto'|'bloquear', penaltyPerDayPct, penaltyMaxPct },
//     countsInAverage, status 'rascunho'|'publicada'|'arquivada', createdBy, createdAt,
//     updatedBy, updatedAt, publishedAt, archivedAt, archivedBy }
// - assignmentSubmissions: uma linha por aluno e tarefa, com as versões enviadas dentro.
//   { id 'asub_<ms>_<6 hex>', schemaVersion 1, assignmentId, courseId, studentClass,
//     studentEmail (minúsculo), studentId ('alu_...' ou null), groupId (null, reservado
//     para entrega em grupo, contrato C2), status 'pendente'|'enviada'|'refazer'|
//     'corrigida'|'devolvida'|'entregue_em_maos', versions [{ n, requestAt, receivedAt,
//     late, lateMs, text, link, files [{ id, originalName, storedRel, size, sha256, mime,
//     ext, category }], ip, device }], extension { dueAt, closeAt, by, at, reason } | null,
//     grade { score, penaltyPct, finalScore, comment, versionGraded, gradedBy, gradedAt,
//     penaltyWaived } | null, returnedAt, returnedBy, manualEntry { note, by, at } | null,
//     anonymized, createdAt, updatedAt }
//
// Datas e prazos: instante em ms (número), nunca ISO (K21 do plano). O que o professor
// digita (data + hora no relógio da escola) vira ms por schoolTime.deadlineFromLocal
// (deadlineFields abaixo), no fuso settings.timezone.
//
// Leitura tolerante (contrato nomes_e_formatos do plano, K3): campo ausente ou estranho
// vale o padrão em normalizeAssignment/normalizeSubmission, sem reescrever a linha no boot.
// As funções de leitura aceitam a linha crua ou já normalizada.
//
// Notas: score de 0 a 100 no banco (como as provas), 0 a 10 na tela. O aluno só vê nota e
// comentário depois de devolvida (status 'devolvida' com returnedAt).
//
// Atraso (D8): medido pela hora em que o pedido de envio CHEGOU ao servidor (requestAt,
// início do upload), contra o prazo efetivo (o da tarefa ou o individual da prorrogação
// ou do "refazer"). closeAt, quando existe, sempre fecha. 'bloquear' não recebe depois
// do prazo; 'desconto' tira penaltyPerDayPct por dia iniciado de atraso, até
// penaltyMaxPct, na correção.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const path = require('path');
const schoolTime = require('./schoolTime.js');
const assignmentFiles = require('./assignmentFiles.js');
const { normalizeEmail, studentInClass, isClosedStudentStatus, isAnonymizedStudent, displayName } = require('./students.js');
const { compareText } = require('./textSearch.js');
const academicCalendar = require('./academicCalendar.js');

const SCHEMA_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const SCORE_MAX = 100;

const ASSIGNMENT_STATUSES = Object.freeze(['rascunho', 'publicada', 'arquivada']);
const SUBMISSION_STATUSES = Object.freeze(['pendente', 'enviada', 'refazer', 'corrigida', 'devolvida', 'entregue_em_maos']);
const LATE_MODES = Object.freeze(['aceitar', 'desconto', 'bloquear']);
const DEFAULT_LATE_POLICY = Object.freeze({ mode: 'aceitar', penaltyPerDayPct: 10, penaltyMaxPct: 50 });
const DEFAULT_RESPONSE = Object.freeze({ files: true, text: false, link: false });
const DEFAULT_FILE_RULES = Object.freeze({ maxFiles: 5, maxSizeMb: 10, types: Object.freeze(['pdf', 'image', 'doc']), extraExtensions: Object.freeze([]) });

// Limites dos campos (as rotas validam com inputSchema usando estes números).
const LIMITS = Object.freeze({
    titleMin: 3,
    titleMax: 160,
    instructionsMax: 10000,
    libraryIdsMax: 10,
    maxFilesMin: 1,
    maxFilesMax: 10,
    maxSizeMbMin: 1,
    textMax: 10000,
    linkMax: 500,
    commentMax: 5000,
    manualNoteMax: 500,
    versionsMax: 20,
    deviceMax: 200,
    reasonMin: 3,
    reasonMax: 500,
});

const ASSIGNMENT_ID_PATTERN = /^asg_\d{10,16}_[0-9a-f]{6}$/;
const SUBMISSION_ID_PATTERN = /^asub_\d{10,16}_[0-9a-f]{6}$/;
const STUDENT_ID_PATTERN = /^alu_[0-9a-f]{16}$/;

function list(value) {
    return Array.isArray(value) ? value : [];
}

function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value, max) {
    const out = typeof value === 'string' ? value : (typeof value === 'number' && Number.isFinite(value) ? String(value) : '');
    return max ? out.slice(0, max) : out;
}

function trimmed(value, max) {
    return text(value).trim().slice(0, max || undefined);
}

// Instante em ms: número, texto só com dígitos ou (leitura tolerante) data ISO. null quando
// não há instante válido.
function toMs(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
    if (typeof value === 'string' && value.trim()) {
        const raw = value.trim();
        const parsed = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
        return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
    }
    return null;
}

function intIn(value, min, max, fallback) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return fallback;
    const number = Math.floor(Number(value));
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

function hex6() {
    return crypto.randomBytes(3).toString('hex');
}

// ------------------------------------------------------------ ids
function newAssignmentId(now = Date.now()) {
    return `asg_${Math.trunc(now)}_${hex6()}`;
}

function newSubmissionId(now = Date.now()) {
    return `asub_${Math.trunc(now)}_${hex6()}`;
}

function isAssignmentId(value) {
    return typeof value === 'string' && ASSIGNMENT_ID_PATTERN.test(value);
}

function isSubmissionId(value) {
    return typeof value === 'string' && SUBMISSION_ID_PATTERN.test(value);
}

// ------------------------------------------------------------ leitura tolerante
function normalizeLatePolicy(value) {
    const policy = isObject(value) ? value : {};
    return {
        mode: LATE_MODES.includes(policy.mode) ? policy.mode : DEFAULT_LATE_POLICY.mode,
        penaltyPerDayPct: intIn(policy.penaltyPerDayPct, 0, 100, DEFAULT_LATE_POLICY.penaltyPerDayPct),
        penaltyMaxPct: intIn(policy.penaltyMaxPct, 0, 100, DEFAULT_LATE_POLICY.penaltyMaxPct),
    };
}

function normalizeResponse(value) {
    if (!isObject(value)) return { ...DEFAULT_RESPONSE };
    const response = { files: value.files === true, text: value.text === true, link: value.link === true };
    // Nenhum modo marcado (linha estranha): vale o padrão, senão ninguém conseguiria entregar.
    return response.files || response.text || response.link ? response : { ...DEFAULT_RESPONSE };
}

function normalizeFileRules(value) {
    const rules = isObject(value) ? value : {};
    return {
        maxFiles: intIn(rules.maxFiles, LIMITS.maxFilesMin, LIMITS.maxFilesMax, DEFAULT_FILE_RULES.maxFiles),
        maxSizeMb: intIn(rules.maxSizeMb, LIMITS.maxSizeMbMin, 4096, DEFAULT_FILE_RULES.maxSizeMb),
        types: Array.isArray(rules.types) ? assignmentFiles.normalizeFileTypes(rules.types) : [...DEFAULT_FILE_RULES.types],
        extraExtensions: assignmentFiles.normalizeExtraExtensions(rules.extraExtensions),
    };
}

function uniqueStrings(value, max) {
    const out = [];
    list(value).forEach(item => {
        const entry = trimmed(item, 100);
        if (entry && !out.includes(entry)) out.push(entry);
    });
    return out.slice(0, max);
}

// A tarefa com todos os campos (padrões no que falta). Não muda a linha recebida. Campos
// que esta versão não conhece continuam no objeto devolvido.
function normalizeAssignment(raw) {
    if (!isObject(raw)) return null;
    return {
        ...raw,
        id: text(raw.id),
        schemaVersion: Number.isInteger(raw.schemaVersion) && raw.schemaVersion >= 1 ? raw.schemaVersion : SCHEMA_VERSION,
        courseId: trimmed(raw.courseId),
        studentClass: trimmed(raw.studentClass),
        moduleId: trimmed(raw.moduleId, 100),
        unitKey: trimmed(raw.unitKey, 200),
        title: trimmed(raw.title, LIMITS.titleMax),
        instructions: text(raw.instructions, LIMITS.instructionsMax),
        libraryIds: uniqueStrings(raw.libraryIds, LIMITS.libraryIdsMax),
        response: normalizeResponse(raw.response),
        files: normalizeFileRules(raw.files),
        opensAt: toMs(raw.opensAt),
        dueAt: toMs(raw.dueAt),
        closeAt: toMs(raw.closeAt),
        latePolicy: normalizeLatePolicy(raw.latePolicy),
        countsInAverage: raw.countsInAverage !== false,
        status: ASSIGNMENT_STATUSES.includes(raw.status) ? raw.status : 'rascunho',
        createdBy: trimmed(raw.createdBy).toLowerCase(),
        createdAt: toMs(raw.createdAt),
        updatedBy: trimmed(raw.updatedBy).toLowerCase(),
        updatedAt: toMs(raw.updatedAt),
        publishedAt: toMs(raw.publishedAt),
        archivedAt: toMs(raw.archivedAt),
        archivedBy: trimmed(raw.archivedBy).toLowerCase(),
    };
}

function normalizeVersionFile(value) {
    const file = isObject(value) ? value : {};
    const ext = trimmed(file.ext).toLowerCase() || assignmentFiles.normalizeExtension(path.extname(text(file.originalName))) || '';
    return {
        ...file,
        id: text(file.id),
        originalName: text(file.originalName, 200),
        storedRel: text(file.storedRel),
        size: Math.max(0, Math.floor(Number(file.size)) || 0),
        sha256: /^[0-9a-f]{64}$/.test(text(file.sha256)) ? file.sha256 : '',
        mime: text(file.mime) || assignmentFiles.DOWNLOAD_MIME[ext] || 'application/octet-stream',
        ext,
        category: text(file.category),
    };
}

// n fica null quando ausente ou estranho; normalizeSubmission numera (numberVersions).
function normalizeVersion(value) {
    const version = isObject(value) ? value : {};
    const requestAt = toMs(version.requestAt);
    return {
        ...version,
        n: Number.isInteger(version.n) && version.n >= 1 ? version.n : null,
        requestAt,
        receivedAt: toMs(version.receivedAt) ?? requestAt,
        late: version.late === true,
        lateMs: Math.max(0, Math.floor(Number(version.lateMs)) || 0),
        text: text(version.text, LIMITS.textMax),
        link: text(version.link, LIMITS.linkMax),
        files: list(version.files).filter(isObject).map(normalizeVersionFile),
        ip: text(version.ip, 100),
        device: text(version.device, LIMITS.deviceMax),
    };
}

function normalizeExtension(value) {
    if (!isObject(value)) return null;
    const dueAt = toMs(value.dueAt);
    if (dueAt === null) return null;
    return {
        ...value,
        dueAt,
        closeAt: toMs(value.closeAt),
        by: trimmed(value.by).toLowerCase(),
        at: toMs(value.at),
        reason: text(value.reason, LIMITS.reasonMax),
    };
}

function scoreOrNull(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(SCORE_MAX, Math.max(0, number)) : null;
}

function normalizeGrade(value) {
    if (!isObject(value)) return null;
    const score = scoreOrNull(value.score);
    const penaltyPct = intIn(value.penaltyPct, 0, 100, 0);
    const finalScore = scoreOrNull(value.finalScore);
    return {
        ...value,
        score,
        penaltyPct,
        finalScore: finalScore !== null ? finalScore : (score !== null ? finalScoreFor(score, penaltyPct) : null),
        comment: text(value.comment, LIMITS.commentMax),
        versionGraded: Number.isInteger(value.versionGraded) && value.versionGraded >= 0 ? value.versionGraded : 0,
        gradedBy: trimmed(value.gradedBy).toLowerCase(),
        gradedAt: toMs(value.gradedAt),
        // Última mudança da nota (não do comentário), desde o C6, ajuste 1; null nas
        // correções gravadas antes (quem lê usa o gradedAt).
        scoreChangedAt: toMs(value.scoreChangedAt),
        penaltyWaived: value.penaltyWaived === true,
    };
}

function normalizeManualEntry(value) {
    if (!isObject(value)) return null;
    return { ...value, note: text(value.note, LIMITS.manualNoteMax), by: trimmed(value.by).toLowerCase(), at: toMs(value.at) };
}

// Situação gravada estranha ou ausente: a que os outros campos dizem.
function derivedSubmissionStatus(sub) {
    if (sub.returnedAt !== null && sub.grade) return 'devolvida';
    if (sub.grade) return 'corrigida';
    if (sub.versions.length) return 'enviada';
    if (sub.manualEntry) return 'entregue_em_maos';
    return 'pendente';
}

// Números das versões sem repetir: o número gravado vale na primeira versão que o usa; a
// versão sem número (linha antiga ou editada à mão) ou com número repetido ganha o próximo
// depois do maior, na ordem em que está gravada. Depois, em ordem de número. Linha já
// numerada sem repetição não muda (idempotente).
function numberVersions(versions) {
    const used = new Set();
    const pending = [];
    versions.forEach(version => {
        if (version.n !== null && !used.has(version.n)) used.add(version.n);
        else pending.push(version);
    });
    let next = used.size ? Math.max(...used) : 0;
    pending.forEach(version => { next += 1; version.n = next; });
    return versions.sort((a, b) => a.n - b.n);
}

// A entrega com todos os campos (padrões no que falta), versões em ordem de número. Não
// muda a linha recebida.
function normalizeSubmission(raw) {
    if (!isObject(raw)) return null;
    const versions = numberVersions(list(raw.versions).filter(isObject).map(normalizeVersion));
    const sub = {
        ...raw,
        id: text(raw.id),
        schemaVersion: Number.isInteger(raw.schemaVersion) && raw.schemaVersion >= 1 ? raw.schemaVersion : SCHEMA_VERSION,
        assignmentId: text(raw.assignmentId),
        courseId: trimmed(raw.courseId),
        studentClass: trimmed(raw.studentClass),
        studentEmail: normalizeEmail(raw.studentEmail),
        studentId: typeof raw.studentId === 'string' && STUDENT_ID_PATTERN.test(raw.studentId) ? raw.studentId : null,
        groupId: raw.groupId === undefined || raw.groupId === '' ? null : raw.groupId,
        versions,
        extension: normalizeExtension(raw.extension),
        grade: normalizeGrade(raw.grade),
        returnedAt: toMs(raw.returnedAt),
        returnedBy: trimmed(raw.returnedBy).toLowerCase(),
        manualEntry: normalizeManualEntry(raw.manualEntry),
        anonymized: raw.anonymized === true,
        createdAt: toMs(raw.createdAt),
        updatedAt: toMs(raw.updatedAt),
    };
    sub.status = SUBMISSION_STATUSES.includes(raw.status) ? raw.status : derivedSubmissionStatus(sub);
    return sub;
}

// As funções de leitura aceitam a linha crua ou já normalizada (normalizar de novo não
// muda nada: teste de idempotência).
function asAssignment(value) {
    return normalizeAssignment(value);
}

function asSubmission(value) {
    return normalizeSubmission(value);
}

// ------------------------------------------------------------ registros novos
// Linha nova de tarefa a partir de campos já validados pela rota (prazos em ms).
function newAssignmentRecord(fields = {}, { actor = '', now = Date.now() } = {}) {
    const by = String((actor && typeof actor === 'object' ? actor.email : actor) || '').trim().toLowerCase();
    const record = normalizeAssignment({
        ...fields,
        id: fields.id || newAssignmentId(now),
        schemaVersion: SCHEMA_VERSION,
        status: fields.status || 'rascunho',
        createdBy: by,
        createdAt: now,
        updatedBy: by,
        updatedAt: now,
        publishedAt: fields.status === 'publicada' ? now : null,
        archivedAt: null,
        archivedBy: '',
    });
    return record;
}

// Linha nova de entrega para o aluno nesta tarefa (sem versão). studentId do cadastro,
// quando ele já tem (contrato nomes_e_formatos: studentId ao lado de studentEmail).
function newSubmissionRecord(assignment, student, { now = Date.now() } = {}) {
    const task = asAssignment(assignment) || {};
    const email = normalizeEmail(student && typeof student === 'object' ? student.email : student);
    const studentId = student && typeof student === 'object' && typeof student.id === 'string' && STUDENT_ID_PATTERN.test(student.id) ? student.id : null;
    return {
        id: newSubmissionId(now),
        schemaVersion: SCHEMA_VERSION,
        assignmentId: task.id || '',
        courseId: task.courseId || '',
        studentClass: task.studentClass || '',
        studentEmail: email,
        studentId,
        groupId: null,
        status: 'pendente',
        versions: [],
        extension: null,
        grade: null,
        returnedAt: null,
        returnedBy: '',
        manualEntry: null,
        anonymized: false,
        createdAt: now,
        updatedAt: now,
    };
}

// ------------------------------------------------------------ busca
function assignmentList(memory) {
    return list(memory && memory.assignments).filter(isObject);
}

function submissionList(memory) {
    return list(memory && memory.assignmentSubmissions).filter(isObject);
}

// A linha gravada (crua) da tarefa, ou null.
function findAssignment(memory, id) {
    if (id === undefined || id === null || id === '') return null;
    const wanted = String(id);
    return assignmentList(memory).find(item => String(item.id) === wanted) || null;
}

// Tarefas da turma (linhas cruas), opcionalmente só das situações pedidas.
function assignmentsForClass(memory, { courseId, studentClass, statuses = null } = {}) {
    const course = String(courseId || '').trim();
    const cls = String(studentClass || '').trim();
    if (!course || !cls) return [];
    return assignmentList(memory).filter(item => {
        const task = normalizeAssignment(item);
        return task.courseId === course && task.studentClass === cls && (!statuses || statuses.includes(task.status));
    });
}

// Donos da entrega (contrato C2): hoje só o aluno; entrega em grupo trará os membros.
// Nenhum leitor supõe um e-mail por linha.
function submissionOwners(sub) {
    if (!isObject(sub)) return [];
    const email = normalizeEmail(sub.studentEmail);
    return email ? [email] : [];
}

function submissionsForAssignment(memory, assignmentId) {
    const wanted = String(assignmentId || '');
    if (!wanted) return [];
    return submissionList(memory).filter(item => String(item.assignmentId) === wanted);
}

// A linha (crua) da entrega do aluno nesta tarefa, ou null.
function findSubmission(memory, assignmentId, studentEmail) {
    const email = normalizeEmail(studentEmail);
    if (!email) return null;
    return submissionsForAssignment(memory, assignmentId).find(item => submissionOwners(item).includes(email)) || null;
}

function findSubmissionById(memory, id) {
    if (!id) return null;
    const wanted = String(id);
    return submissionList(memory).find(item => String(item.id) === wanted) || null;
}

// ------------------------------------------------------------ prazos
// Re-exporta a conta de fuso da fundação (contrato C3 do P1 e K7 do plano): data + hora no
// relógio da escola -> ms, ou null quando a entrada não vale.
function deadlineFromLocal(date, time, timezone) {
    return schoolTime.deadlineFromLocal(date, time, timezone);
}

// Lê do corpo do pedido o par <prefixo>Date + <prefixo>Time ('due' -> dueDate e dueTime)
// e devolve { value: ms | null } ou { error, field }. Sem os dois campos: null (ou erro
// com required). Hora ausente com data presente vale defaultTime (23:59, o fim do dia, o
// costume do prazo de escola). label completa a frase: 'do prazo', 'da abertura'.
function deadlineFields(body, prefix, { required = false, label = 'do prazo', timezone, defaultTime = '23:59' } = {}) {
    const source = isObject(body) ? body : {};
    const dateKey = `${prefix}Date`;
    const timeKey = `${prefix}Time`;
    const date = typeof source[dateKey] === 'string' ? source[dateKey].trim() : '';
    const timeRaw = typeof source[timeKey] === 'string' ? source[timeKey].trim() : '';
    if (!date && !timeRaw) return required ? { error: `Informe a data e a hora ${label}.`, field: dateKey } : { value: null };
    if (!date) return { error: `Informe a data ${label}.`, field: dateKey };
    if (!schoolTime.isValidLocalDate(date)) return { error: `Data ${label} inválida. Use o formato AAAA-MM-DD.`, field: dateKey };
    const time = timeRaw || defaultTime;
    if (!schoolTime.isValidLocalTime(time)) return { error: `Hora ${label} inválida. Use o formato HH:MM (00:00 a 23:59).`, field: timeKey };
    const value = deadlineFromLocal(date, time, timezone);
    if (value === null) return { error: `Data ou hora ${label} inválida.`, field: dateKey };
    return { value };
}

// Confere a ordem das datas da tarefa: abertura antes do prazo e encerramento depois dele.
// Devolve { error, field } ou null.
function windowOrderError({ opensAt = null, dueAt = null, closeAt = null } = {}) {
    if (dueAt !== null && opensAt !== null && opensAt > dueAt) return { error: 'A abertura precisa ser antes do prazo.', field: 'opensDate' };
    if (closeAt !== null && dueAt === null) return { error: 'Informe o prazo antes do encerramento.', field: 'dueDate' };
    if (closeAt !== null && dueAt !== null && closeAt < dueAt) return { error: 'O encerramento precisa ser no prazo ou depois dele.', field: 'closeDate' };
    return null;
}

// Janela que vale para este aluno: a da tarefa ou, com prorrogação ou "refazer", o prazo
// individual. O prazo individual nunca deixa o aluno com menos tempo que a turma:
// - prazo: o mais tarde entre o da tarefa e o individual (prazo individual antes do da
//   turma, gravado por engano ou por um "refazer" pedido cedo, vale o da turma);
// - encerramento: tarefa sem encerramento continua sem encerramento para o aluno (um
//   encerramento individual fecharia antes da turma); com encerramento, vale o mais tarde
//   entre o da tarefa e o individual (sem individual, o da tarefa). Se mesmo assim ele
//   ficar antes do prazo individual (prorrogação para depois do encerramento da tarefa,
//   sem encerramento próprio), não há encerramento além da regra de atraso.
// As rotas da prorrogação e do "refazer" (C6) conferem antes com extensionWindowError,
// para o professor saber; esta conta só garante a regra para o que já está gravado.
function effectiveWindow(assignment, submission) {
    const task = asAssignment(assignment) || normalizeAssignment({});
    const sub = submission ? asSubmission(submission) : null;
    const ext = sub && sub.extension;
    if (!ext) return { opensAt: task.opensAt, dueAt: task.dueAt, closeAt: task.closeAt, individual: false };
    const dueAt = task.dueAt !== null ? Math.max(task.dueAt, ext.dueAt) : ext.dueAt;
    let closeAt = null;
    if (task.closeAt !== null) {
        closeAt = Math.max(task.closeAt, ext.closeAt !== null ? ext.closeAt : task.closeAt);
        if (closeAt < dueAt) closeAt = null;
    }
    return { opensAt: task.opensAt, dueAt, closeAt, individual: true };
}

// Confere o prazo individual (prorrogação ou "refazer") que o professor quer gravar, contra
// a tarefa: { error, field } ou null. Os nomes de campo são os do formulário (dueDate,
// closeDate, como deadlineFields com o prefixo 'due' e 'close').
function extensionWindowError(assignment, { dueAt = null, closeAt = null } = {}) {
    const task = asAssignment(assignment) || normalizeAssignment({});
    if (dueAt === null) return { error: 'Informe o novo prazo.', field: 'dueDate' };
    if (task.dueAt !== null && dueAt < task.dueAt) return { error: 'O novo prazo precisa ser no prazo da turma ou depois dele.', field: 'dueDate' };
    if (closeAt !== null && closeAt < dueAt) return { error: 'O encerramento precisa ser no novo prazo ou depois dele.', field: 'closeDate' };
    if (closeAt !== null && task.closeAt === null) return { error: 'Esta tarefa não tem encerramento para a turma; o aluno também fica sem encerramento.', field: 'closeDate' };
    if (closeAt !== null && closeAt < task.closeAt) return { error: 'O encerramento do aluno precisa ser no encerramento da turma ou depois dele.', field: 'closeDate' };
    return null;
}

const ACCEPTANCE_MESSAGES = Object.freeze({
    nao_publicada: 'Esta tarefa não está disponível.',
    nao_aberta: 'Esta tarefa ainda não abriu para envio.',
    devolvida: 'Esta tarefa já foi corrigida e devolvida. Para mandar outra versão, fale com o professor.',
    limite_versoes: `Você já enviou ${LIMITS.versionsMax} versões desta tarefa. Fale com o professor.`,
    encerrada: 'O prazo desta tarefa terminou. O envio não é mais aceito.',
    prazo_encerrado: 'O prazo desta tarefa terminou e ela não aceita envio atrasado. Fale com o professor.',
});

// A tarefa aceita envio deste aluno no instante now (o requestAt do pedido)?
// { accepts, code, message, late, lateMs, window }. code 'ok' quando aceita.
function submissionAcceptance(assignment, submission, { now = Date.now() } = {}) {
    const task = asAssignment(assignment) || normalizeAssignment({});
    const sub = submission ? asSubmission(submission) : null;
    const window = effectiveWindow(task, sub);
    const at = toMs(now) ?? Date.now();
    const lateMs = window.dueAt !== null && at > window.dueAt ? at - window.dueAt : 0;
    const refuse = code => ({ accepts: false, code, message: ACCEPTANCE_MESSAGES[code], late: lateMs > 0, lateMs, window });
    if (task.status !== 'publicada') return refuse('nao_publicada');
    if (window.opensAt !== null && at < window.opensAt) return refuse('nao_aberta');
    if (sub && sub.status === 'devolvida') return refuse('devolvida');
    if (sub && sub.versions.length >= LIMITS.versionsMax) return refuse('limite_versoes');
    if (window.closeAt !== null && at > window.closeAt) return refuse('encerrada');
    if (lateMs > 0 && task.latePolicy.mode === 'bloquear') return refuse('prazo_encerrado');
    return { accepts: true, code: 'ok', message: '', late: lateMs > 0, lateMs, window };
}

// ------------------------------------------------------------ desconto e nota
// Desconto de atraso em % (D8): só na regra 'desconto'; por dia INICIADO de atraso
// (1 min de atraso já é 1 dia), até o teto.
function latePenaltyPct(assignment, lateMs) {
    const task = asAssignment(assignment) || normalizeAssignment({});
    const late = Math.max(0, Number(lateMs) || 0);
    if (task.latePolicy.mode !== 'desconto' || late <= 0) return 0;
    const days = Math.ceil(late / DAY_MS);
    return Math.min(task.latePolicy.penaltyMaxPct, days * task.latePolicy.penaltyPerDayPct);
}

// Nota final (0 a 100) depois do desconto: arredondada como as notas gravadas.
function finalScoreFor(score, penaltyPct) {
    const value = scoreOrNull(score);
    if (value === null) return null;
    const pct = intIn(penaltyPct, 0, 100, 0);
    return Math.max(0, Math.min(SCORE_MAX, Math.round(Number((value * (100 - pct) / 100).toFixed(6)))));
}

// Versão a corrigir: a pedida ou a última. null sem versão.
function versionFor(submission, versionN) {
    const sub = asSubmission(submission);
    if (!sub || !sub.versions.length) return null;
    if (versionN !== undefined && versionN !== null) return sub.versions.find(version => version.n === Number(versionN)) || null;
    return sub.versions[sub.versions.length - 1];
}

// A correção como fica gravada: { score, penaltyPct, finalScore, versionGraded,
// penaltyWaived }. score já em 0 a 100 (gradebook.scoreFromGrade). O desconto sai do
// atraso da versão corrigida; sem versão (entrega em mãos) não há desconto.
function gradeWithPenalty(assignment, submission, { score, versionN = null, waivePenalty = false } = {}) {
    const version = submission ? versionFor(submission, versionN) : null;
    const penaltyPct = waivePenalty ? 0 : latePenaltyPct(assignment, version ? version.lateMs : 0);
    const value = scoreOrNull(score);
    return {
        score: value,
        penaltyPct,
        finalScore: finalScoreFor(value, penaltyPct),
        versionGraded: version ? version.n : 0,
        penaltyWaived: waivePenalty === true,
    };
}

// ------------------------------------------------------------ situação
function lastVersion(sub) {
    return sub && sub.versions.length ? sub.versions[sub.versions.length - 1] : null;
}

// Precisa de correção: há versão mais nova que a corrigida (ou nenhuma corrigida), ou
// entrega em mãos sem nota. Devolvida não volta para a fila (não aceita versão nova).
// Em 'refazer' (esperando o aluno), só a versão mandada depois do pedido conta: mais nova
// que a corrigida ou, sem correção gravada, com requestAt depois do pedido (extension.at).
// Sem nenhum dos dois marcos, a entrega espera o aluno (o envio novo volta a situação
// para 'enviada', C5).
function needsGrading(submission) {
    const sub = asSubmission(submission);
    if (!sub || sub.status === 'devolvida') return false;
    const last = lastVersion(sub);
    if (sub.status === 'refazer') {
        if (!last) return false;
        if (sub.grade) return last.n > sub.grade.versionGraded;
        const askedAt = sub.extension ? sub.extension.at : null;
        return askedAt !== null && last.requestAt !== null && last.requestAt > askedAt;
    }
    if (last) return !sub.grade || last.n > sub.grade.versionGraded;
    return !!sub.manualEntry && !sub.grade;
}

// Formato curto do instante no relógio da escola: '20/11 às 23:59'.
function formatSchoolDateTime(ms, timezone) {
    const parts = ms === null || ms === undefined ? null : schoolTime.localParts(ms, timezone);
    if (!parts) return '';
    return `${String(parts.day).padStart(2, '0')}/${String(parts.month).padStart(2, '0')} às ${parts.time}`;
}

// Situação para o aluno (lista /aluno/atividades e sino): { code, label, atrasada,
// aceitaEnvio, dueAt, closeAt }. Nota e comentário só aparecem em 'devolvida'.
// Códigos: 'a_fazer', 'atrasada' (sem envio, prazo passou e ainda aceita), 'enviada',
// 'refazer', 'devolvida', 'entregue_em_maos', 'nao_aberta', 'encerrada_sem_envio'.
function studentSituation(assignment, submission, { now = Date.now(), timezone } = {}) {
    const task = asAssignment(assignment) || normalizeAssignment({});
    const sub = submission ? asSubmission(submission) : null;
    const acceptance = submissionAcceptance(task, sub, { now });
    const base = { aceitaEnvio: acceptance.accepts, dueAt: acceptance.window.dueAt, closeAt: acceptance.window.closeAt, atrasada: false };
    if (sub && sub.status === 'devolvida' && sub.returnedAt !== null) return { ...base, code: 'devolvida', label: 'Devolvida' };
    if (sub && sub.status === 'refazer') {
        const when = formatSchoolDateTime(acceptance.window.dueAt, timezone);
        return { ...base, code: 'refazer', label: when ? `Refazer até ${when}` : 'Refazer' };
    }
    const last = lastVersion(sub);
    if (last) return { ...base, code: 'enviada', label: last.late ? 'Enviada com atraso' : 'Enviada', atrasada: last.late };
    if (sub && sub.manualEntry) return { ...base, code: 'entregue_em_maos', label: 'Entregue em mãos' };
    if (acceptance.accepts) {
        return acceptance.late
            ? { ...base, code: 'atrasada', label: 'Atrasada', atrasada: true }
            : { ...base, code: 'a_fazer', label: 'A fazer' };
    }
    if (acceptance.code === 'nao_aberta') {
        const when = formatSchoolDateTime(acceptance.window.opensAt, timezone);
        return { ...base, code: 'nao_aberta', label: when ? `Abre em ${when}` : 'Ainda não abriu' };
    }
    if (acceptance.code === 'encerrada' || acceptance.code === 'prazo_encerrado') return { ...base, code: 'encerrada_sem_envio', label: 'Encerrada sem envio' };
    return { ...base, code: acceptance.code, label: acceptance.message };
}

// Situação para o professor (lista da turma e contagens):
// 'nao_entregue', 'para_corrigir', 'corrigida' (salva, o aluno ainda não vê), 'refazer'
// (esperando o aluno), 'devolvida'.
function instructorStatus(submission) {
    const sub = submission ? asSubmission(submission) : null;
    if (!sub) return 'nao_entregue';
    if (sub.status === 'devolvida') return 'devolvida';
    if (needsGrading(sub)) return 'para_corrigir';
    if (sub.status === 'refazer') return 'refazer';
    if (sub.grade) return 'corrigida';
    return sub.versions.length || sub.manualEntry ? 'para_corrigir' : 'nao_entregue';
}

// Alunos da tarefa: os ativos matriculados na turma e, além deles, quem já tem entrega
// (aluno desligado ou anonimizado continua na lista do professor com o que entregou).
// [{ studentEmail, studentId, student (cadastro ou null), submission (crua ou null) }],
// em ordem alfabética do nome.
function assignmentRoster(memory, assignment) {
    const task = asAssignment(assignment);
    if (!task) return [];
    const students = list(memory && memory.students).filter(isObject);
    const byEmail = new Map(students.map(student => [normalizeEmail(student.email), student]));
    const subs = submissionsForAssignment(memory, task.id);
    const rows = new Map();
    students.forEach(student => {
        const email = normalizeEmail(student.email);
        if (!email || isAnonymizedStudent(student) || isClosedStudentStatus(student.status)) return;
        if (!studentInClass(student, task.studentClass, task.courseId)) return;
        rows.set(email, { studentEmail: email, studentId: typeof student.id === 'string' ? student.id : null, student, submission: null });
    });
    subs.forEach(sub => {
        submissionOwners(sub).forEach(email => {
            const row = rows.get(email) || { studentEmail: email, studentId: null, student: byEmail.get(email) || null, submission: null };
            row.submission = sub;
            if (!row.studentId) row.studentId = (row.student && typeof row.student.id === 'string' ? row.student.id : null) || asSubmission(sub).studentId;
            rows.set(email, row);
        });
    });
    return [...rows.values()].sort((a, b) => compareText(displayName(a.student) || a.studentEmail, displayName(b.student) || b.studentEmail)
        || compareText(a.studentEmail, b.studentEmail));
}

// Contagens da tarefa (contrato C4: relatórios e "A fazer" não recalculam atraso):
// { alunos, enviadas, paraCorrigir, atrasadas, naoEntregues, devolvidas, corrigidas,
//   refazer }. enviadas: com versão ou entrega em mãos; atrasadas: enviadas cuja última
// versão chegou depois do prazo efetivo; naoEntregues: sem versão nem entrega em mãos.
function assignmentStatusSummary(memory, assignmentOrId) {
    const task = typeof assignmentOrId === 'string' ? normalizeAssignment(findAssignment(memory, assignmentOrId)) : asAssignment(assignmentOrId);
    const summary = { alunos: 0, enviadas: 0, paraCorrigir: 0, atrasadas: 0, naoEntregues: 0, devolvidas: 0, corrigidas: 0, refazer: 0 };
    if (!task) return summary;
    assignmentRoster(memory, task).forEach(row => {
        summary.alunos += 1;
        const sub = row.submission ? asSubmission(row.submission) : null;
        const delivered = !!sub && (sub.versions.length > 0 || !!sub.manualEntry);
        if (!delivered) {
            summary.naoEntregues += 1;
            return;
        }
        summary.enviadas += 1;
        const last = lastVersion(sub);
        if (last && last.late) summary.atrasadas += 1;
        const status = instructorStatus(sub);
        if (status === 'para_corrigir') summary.paraCorrigir += 1;
        else if (status === 'devolvida') summary.devolvidas += 1;
        else if (status === 'corrigida') summary.corrigidas += 1;
        else if (status === 'refazer') summary.refazer += 1;
    });
    return summary;
}

// ------------------------------------------------------------ notas para o quadro
// Notas de tarefa para o quadro e a média (contrato C1 do P1, K1 do plano: uma fonte só,
// assignmentSubmissions.grade; o provedor 'tarefa' do gradebook lê daqui).
// [{ email, studentId, columnId 'tarefa:<id>', assignmentId, title, moduleId, score
//   (0 a 100, já com desconto), countsInAverage, returnedAt }].
// - published (padrão true): só nota devolvida (o que o aluno já vê). false traz também a
//   correção salva e não devolvida (só para o professor);
// - tarefas publicadas da turma; includeArchived traz também as arquivadas;
// - students: lista de e-mails (ou cadastros) para limitar; sem ela, todos.
function assignmentGradeEntries(memory, { courseId, studentClass, students = null, published = true, includeArchived = false } = {}) {
    const statuses = includeArchived ? ['publicada', 'arquivada'] : ['publicada'];
    const wanted = Array.isArray(students)
        ? new Set(students.map(item => normalizeEmail(item && typeof item === 'object' ? item.email : item)).filter(Boolean))
        : null;
    const out = [];
    assignmentsForClass(memory, { courseId, studentClass, statuses }).forEach(raw => {
        const task = normalizeAssignment(raw);
        submissionsForAssignment(memory, task.id).forEach(rawSub => {
            const sub = normalizeSubmission(rawSub);
            if (!sub.grade || sub.grade.finalScore === null) return;
            if (published && !(sub.status === 'devolvida' && sub.returnedAt !== null)) return;
            submissionOwners(sub).forEach(email => {
                if (wanted && !wanted.has(email)) return;
                out.push({
                    email,
                    studentId: sub.studentId,
                    columnId: `tarefa:${task.id}`,
                    assignmentId: task.id,
                    title: task.title,
                    moduleId: task.moduleId,
                    score: sub.grade.finalScore,
                    countsInAverage: task.countsInAverage,
                    returnedAt: sub.returnedAt,
                });
            });
        });
    });
    return out;
}

// ------------------------------------------------------------ regras de envio
// Limites do envio do aluno nesta tarefa, já com os tetos globais (settings.entregas):
// { response, types, extraExtensions, accept, maxFiles, maxSizeMb (o menor entre o da
//   tarefa e maxMbPorArquivo), maxTotalMb (maxMbPorEnvio), textMax, linkMax }.
function submissionRules(assignment, entregas = {}) {
    const task = asAssignment(assignment) || normalizeAssignment({});
    const perFileCeiling = Number(entregas && entregas.maxMbPorArquivo);
    const totalCeiling = Number(entregas && entregas.maxMbPorEnvio);
    const maxSizeMb = Number.isFinite(perFileCeiling) && perFileCeiling >= 1 ? Math.min(task.files.maxSizeMb, Math.floor(perFileCeiling)) : task.files.maxSizeMb;
    const rules = { types: task.files.types, extraExtensions: task.files.extraExtensions };
    return {
        response: task.response,
        types: task.files.types,
        extraExtensions: task.files.extraExtensions,
        accept: assignmentFiles.acceptAttribute(rules),
        extensions: assignmentFiles.acceptedExtensions(rules),
        maxFiles: task.files.maxFiles,
        maxSizeMb,
        maxTotalMb: Number.isFinite(totalCeiling) && totalCeiling >= 1 ? Math.max(Math.floor(totalCeiling), maxSizeMb) : null,
        textMax: LIMITS.textMax,
        linkMax: LIMITS.linkMax,
    };
}

// Próximo número de versão da entrega.
function nextVersionNumber(submission) {
    const sub = submission ? asSubmission(submission) : null;
    return sub && sub.versions.length ? sub.versions[sub.versions.length - 1].n + 1 : 1;
}

// ------------------------------------------------------------ envio do aluno (P1-c, C5)
// A tarefa aparece para o aluno da turma: publicada e já aberta (sem abertura, desde a
// publicação). Rascunho, arquivada e com abertura no futuro ficam fora da lista, do
// detalhe, do sino e do calendário.
function isVisibleToStudent(assignment, { now = Date.now() } = {}) {
    const task = asAssignment(assignment);
    if (!task || task.status !== 'publicada') return false;
    return task.opensAt === null || task.opensAt <= now;
}

// Situação da entrega depois de uma versão nova do aluno: 'corrigida' continua (a
// correção salva é da versão anterior e a versão nova volta para a fila do professor
// pelo needsGrading); o resto (pendente, enviada, refazer, entregue em mãos) vira
// 'enviada'. Devolvida não recebe versão (submissionAcceptance recusa antes).
function statusAfterNewVersion(submission) {
    const sub = submission ? asSubmission(submission) : null;
    return sub && sub.status === 'corrigida' ? 'corrigida' : 'enviada';
}

// Código curto do arquivo no comprovante: os 8 primeiros do sha256, em maiúsculas.
function fileReceiptCode(file) {
    const sha = file && typeof file.sha256 === 'string' && /^[0-9a-f]{64}$/.test(file.sha256) ? file.sha256 : '';
    return sha ? sha.slice(0, 8).toUpperCase() : '';
}

// Código do comprovante da versão ('A1B2C3D4'): sha256 da entrega, do número, da hora de
// chegada, dos sha256 dos arquivos, do texto e do link. Calculado de novo a partir do
// registro (não é gravado): o mesmo envio dá sempre o mesmo código, e qualquer mudança
// no que foi recebido dá outro.
function versionReceiptCode(submission, version) {
    const sub = submission && typeof submission === 'object' ? submission : {};
    const v = normalizeVersion(version);
    const payload = JSON.stringify([text(sub.id), v.n, v.requestAt, v.files.map(file => file.sha256), v.text, v.link]);
    return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 8).toUpperCase();
}

function formatPct(value) {
    return `${String(value).replace('.', ',')}%`;
}

// Regra de atraso escrita por extenso, para o aluno (D8 e a tela de envio).
function latePolicyText(assignment) {
    const task = asAssignment(assignment) || normalizeAssignment({});
    const close = task.closeAt !== null ? ' Depois do encerramento, o envio não é mais aceito.' : '';
    if (task.latePolicy.mode === 'bloquear') return 'Depois do prazo, o envio não é mais aceito.';
    if (task.latePolicy.mode === 'desconto') {
        return `Depois do prazo, a entrega é aceita com desconto de ${formatPct(task.latePolicy.penaltyPerDayPct)} por dia de atraso, até ${formatPct(task.latePolicy.penaltyMaxPct)}.${close}`;
    }
    return `Depois do prazo, a entrega é aceita e fica marcada como atrasada.${close}`;
}

// ------------------------------------------------------------ turma encerrada (P1-c, C5)
// A turma recebe envio? false quando academicCalendar.assertClassOpen recusa (turma
// encerrada; sem efeito até o B10 ligar). A lista, o detalhe, o sino e o calendário do
// aluno usam a mesma resposta que o POST do envio, para não oferecer o envio que ele
// recusaria com 409 class_closed. Chamada pelo objeto do módulo (o teste troca a função).
function classAcceptsSubmissions(cls) {
    try {
        return academicCalendar.assertClassOpen(cls) !== false;
    } catch (err) {
        if (err && err.code === academicCalendar.CLASS_CLOSED_CODE) return false;
        throw err;
    }
}

const CLOSED_CLASS_LABEL = 'Turma encerrada';
const SITUATIONS_WAITING_FOR_STUDENT = new Set(['a_fazer', 'atrasada', 'refazer', 'nao_aberta']);

// Situação do aluno numa turma encerrada: não aceita envio, e o que esperava o envio dele
// ('A fazer', 'Atrasada', 'Refazer', 'Abre em ...') passa a dizer 'Turma encerrada'. O
// código continua o mesmo; o que já foi enviado ou devolvido não muda.
function situationForClass(situation, classOpen) {
    if (classOpen || !situation) return situation;
    const label = SITUATIONS_WAITING_FOR_STUDENT.has(situation.code) ? CLOSED_CLASS_LABEL : situation.label;
    return { ...situation, aceitaEnvio: false, label, turmaEncerrada: true };
}

// ------------------------------------------------------------ correção (P1-d, C6)
// O aluno entregou algo (versão pelo sistema ou entrega em mãos)?
function hasDelivery(submission) {
    const sub = submission ? asSubmission(submission) : null;
    return !!sub && (sub.versions.length > 0 || !!sub.manualEntry);
}

// Devolvida: o aluno vê a nota e o comentário.
function isReturned(submission) {
    const sub = submission ? asSubmission(submission) : null;
    return !!sub && sub.status === 'devolvida' && sub.returnedAt !== null;
}

// Entra no "Devolver todas as corrigidas": correção salva com nota e nenhuma versão nova
// esperando correção (a nota salva seria de uma versão velha).
function isReturnable(submission) {
    const sub = submission ? asSubmission(submission) : null;
    return !!sub && instructorStatus(sub) === 'corrigida' && !!sub.grade && sub.grade.finalScore !== null;
}

// Desde quando a entrega espera correção: a chegada da última versão (ou a entrega em
// mãos, sem versão). null quando não espera.
function waitingSince(submission) {
    const sub = submission ? asSubmission(submission) : null;
    if (!sub || !needsGrading(sub)) return null;
    const last = lastVersion(sub);
    if (last) return last.requestAt;
    return sub.manualEntry ? sub.manualEntry.at : null;
}

// Entregas para corrigir nas tarefas publicadas da turma (fila "Precisa de você" e sino
// do instrutor, D16): { count, tasks: [{ id, title, count }], oldestAt }. emails (Set):
// só os alunos do escopo de quem vê; sem ele, todos.
function gradingQueueSummary(memory, { courseId, studentClass, emails = null } = {}) {
    const summary = { count: 0, tasks: [], oldestAt: null };
    assignmentsForClass(memory, { courseId, studentClass, statuses: ['publicada'] }).forEach(raw => {
        const task = normalizeAssignment(raw);
        let count = 0;
        submissionsForAssignment(memory, task.id).forEach(rawSub => {
            const sub = normalizeSubmission(rawSub);
            if (emails instanceof Set && !submissionOwners(sub).some(email => emails.has(email))) return;
            if (instructorStatus(sub) !== 'para_corrigir') return;
            count += 1;
            const since = waitingSince(sub);
            if (since !== null && (summary.oldestAt === null || since < summary.oldestAt)) summary.oldestAt = since;
        });
        if (count) {
            summary.count += count;
            summary.tasks.push({ id: task.id, title: task.title, count });
        }
    });
    summary.tasks.sort((a, b) => b.count - a.count || compareText(a.title, b.title));
    return summary;
}

module.exports = {
    SCHEMA_VERSION,
    ASSIGNMENT_STATUSES,
    SUBMISSION_STATUSES,
    LATE_MODES,
    DEFAULT_LATE_POLICY,
    DEFAULT_RESPONSE,
    DEFAULT_FILE_RULES,
    LIMITS,
    ACCEPTANCE_MESSAGES,
    toMs,
    newAssignmentId,
    newSubmissionId,
    isAssignmentId,
    isSubmissionId,
    normalizeAssignment,
    normalizeSubmission,
    newAssignmentRecord,
    newSubmissionRecord,
    assignmentList,
    submissionList,
    findAssignment,
    assignmentsForClass,
    submissionOwners,
    submissionsForAssignment,
    findSubmission,
    findSubmissionById,
    deadlineFromLocal,
    deadlineFields,
    windowOrderError,
    effectiveWindow,
    extensionWindowError,
    submissionAcceptance,
    latePenaltyPct,
    finalScoreFor,
    versionFor,
    gradeWithPenalty,
    needsGrading,
    formatSchoolDateTime,
    studentSituation,
    instructorStatus,
    assignmentRoster,
    assignmentStatusSummary,
    assignmentGradeEntries,
    submissionRules,
    nextVersionNumber,
    isVisibleToStudent,
    statusAfterNewVersion,
    fileReceiptCode,
    versionReceiptCode,
    latePolicyText,
    classAcceptsSubmissions,
    situationForClass,
    hasDelivery,
    isReturned,
    isReturnable,
    waitingSince,
    gradingQueueSummary,
};
