// Fase 1 — Utilitários de cadastro de aluno: campos, validações e auditoria.
// Mantém o padrão do projeto (objetos JSON em memoryDB, sem ORM/migrations).

const { recordAudit, getClientIp, auditTimestamp } = require('./audit.js');
const { checkBirthDate } = require('./birthDate.js');

// Status permitidos para o aluno. "Ativo" é o padrão ao cadastrar.
const STUDENT_STATUSES = ['Ativo', 'Inativo', 'Bloqueado', 'Concluído', 'Transferido', 'Evadido'];
const OBSERVATION_CATEGORIES = ['Dificuldade de aprendizagem', 'Participação', 'Frequência', 'Entregas atrasadas', 'Acompanhamento pedagógico', 'Acessibilidade pedagógica', 'Comportamento acadêmico', 'Observação geral'];
const OBSERVATION_VISIBILITY = ['Restrita (coordenação)', 'Equipe pedagógica', 'Compartilhada'];
const EXTRA_TIME_OPTIONS = [25, 50, 100];
const DEFAULT_STATUS = 'Ativo';

// Situações que encerram o vínculo do aluno com a escola (H7b: o aluno sai da chamada
// das datas novas; o H7c usa a mesma lista em Cadastros encerrados). Comparadas sem
// acento e sem diferenciar maiúscula ('concluido' e 'CONCLUÍDO' também valem).
// 'Bloqueado' não encerra: só suspende o acesso, e o aluno continua na turma.
// 'Anonimizado' é a situação do cadastro anonimizado (H7c).
const CLOSED_STUDENT_STATUSES = ['Inativo', 'Concluído', 'Transferido', 'Evadido', 'Anonimizado'];
function foldStatus(value) {
    return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}
const CLOSED_STATUS_KEYS = new Set(CLOSED_STUDENT_STATUSES.map(foldStatus));
function isClosedStudentStatus(status) {
    return CLOSED_STATUS_KEYS.has(foldStatus(status));
}

// Cadastro anonimizado (H7c, decisão 4 do Alan): fica com as notas, a presença e os
// certificados sob um pseudônimo e não volta a ser editado nem reativado. A situação
// não aparece no seletor nem se aplica por edição: só POST /api/admin/students/anonymize
// a grava (com anonymizedAt, que a prévia da restauração do H4a lê).
const ANONYMIZED_STATUS = 'Anonimizado';
function isAnonymizedStudent(student) {
    if (!student || typeof student !== 'object') return false;
    return foldStatus(student.status) === foldStatus(ANONYMIZED_STATUS) || !!student.anonymizedAt;
}

// Motivo da mudança de situação (Desligar aluno, Reativar, bulk-status): opcional, até
// 500 caracteres depois de aparar.
const STATUS_REASON_MAX = 500;
function cleanStatusReason(value) {
    return typeof value === 'string' ? value.trim().slice(0, STATUS_REASON_MAX) : '';
}

// Muda a situação do aluno guardando quando, quem e por quê (statusChangedAt em ms,
// statusChangedBy, statusReason). Devolve o aluno novo (cópia) ou o mesmo objeto quando
// a situação não muda. A chamada (H7b) lê statusChangedAt para mostrar o encerrado nas
// datas anteriores ao desligamento, e Cadastros encerrados mostra "encerrado desde".
function applyStudentStatus(student, status, actor, reason, { now = Date.now() } = {}) {
    const next = String(status || '').trim();
    if (!student || !next || (student.status || DEFAULT_STATUS) === next) return student;
    const by = actor && typeof actor === 'object' ? actor.email : actor;
    return {
        ...student,
        status: next,
        statusChangedAt: now,
        statusChangedBy: String(by || 'admin').trim().toLowerCase(),
        statusReason: cleanStatusReason(reason),
        updatedAt: now,
    };
}

// Desde quando o cadastro está na situação atual (ms), para Cadastros encerrados e para
// a chamada de datas antigas: statusChangedAt (gravado desde o H7c); na falta (aluno
// desligado antes da atualização), a última alteração de "Status" da auditoria do
// cadastro que levou à situação atual; senão null ("data não registrada").
// index: lastStatusChangeIndex(memory.auditLogs), montado uma vez por pedido.
function lastStatusChangeIndex(auditLogs) {
    const index = new Map();
    (Array.isArray(auditLogs) ? auditLogs : []).forEach(entry => {
        if (!entry || typeof entry !== 'object' || entry.field !== 'Status' || entry.type) return;
        const email = normalizeEmail(entry.studentEmail);
        const time = auditTimestamp(entry.timestamp !== undefined ? entry.timestamp : entry.at);
        if (!email || !time) return;
        const current = index.get(email);
        if (!current || time >= current.timestamp) index.set(email, { timestamp: time, status: String(entry.newValue ?? '') });
    });
    return index;
}

function studentStatusSince(student, index) {
    if (!student) return null;
    const saved = auditTimestamp(student.statusChangedAt);
    if (saved) return saved;
    const last = index && index.get(normalizeEmail(student.email));
    if (last && foldStatus(last.status) === foldStatus(student.status)) return last.timestamp;
    return null;
}

// Campos escalares auditáveis do perfil do aluno.
const AUDITABLE_FIELDS = [
    { key: 'name', label: 'Nome completo' },
    { key: 'nomeSocial', label: 'Nome social' },
    { key: 'email', label: 'E-mail/login' },
    { key: 'matricula', label: 'Matrícula' },
    { key: 'phone', label: 'Telefone' },
    { key: 'guardianPhone', label: 'Telefone do responsável' },
    // Data de nascimento (H8a-2, SEG-09): 'AAAA-MM-DD' (utils/birthDate.js).
    { key: 'birthDate', label: 'Data de nascimento' },
    { key: 'status', label: 'Status' },
    { key: 'unidade', label: 'Unidade/instituição' },
];

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

// Telefone brasileiro tolerante: aceita +, espaços, (), - e exige 8 a 13 dígitos.
function isValidPhone(value) {
    if (value === undefined || value === null || String(value).trim() === '') return true; // opcional
    const digits = String(value).replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 13;
}

function isValidStatus(value) {
    return STUDENT_STATUSES.includes(value);
}

// Nome exibido: prioriza nome social quando preenchido, sem apagar o nome completo.
function displayName(student) {
    if (!student) return '';
    const social = (student.nomeSocial || '').trim();
    return social || student.name || '';
}

// Normaliza os campos vindos do corpo da requisição para o shape do aluno.
// Só inclui chaves realmente enviadas (evita sobrescrever com undefined no update).
function extractStudentFields(body) {
    const out = {};
    if (body.name !== undefined) out.name = String(body.name).trim();
    if (body.nomeSocial !== undefined) out.nomeSocial = String(body.nomeSocial).trim();
    if (body.email !== undefined) out.email = normalizeEmail(body.email);
    if (body.matricula !== undefined) out.matricula = String(body.matricula).trim();
    if (body.phone !== undefined) out.phone = String(body.phone).trim();
    if (body.guardianPhone !== undefined) out.guardianPhone = String(body.guardianPhone).trim();
    // Data de nascimento (H8a-2): null ou vazio apagam; o resto é conferido em
    // validateStudentFields.
    if (body.birthDate !== undefined) out.birthDate = body.birthDate === null ? '' : String(body.birthDate).trim();
    if (body.unidade !== undefined) out.unidade = String(body.unidade).trim();
    if (body.status !== undefined) out.status = String(body.status).trim();
    if (body.period !== undefined) out.period = String(body.period).trim();
    if (body.guardian !== undefined && body.guardian && typeof body.guardian === 'object') {
        out.guardian = {
            name: String(body.guardian.name || '').trim(),
            phone: String(body.guardian.phone || '').trim(),
            email: normalizeEmail(body.guardian.email),
            parentesco: String(body.guardian.parentesco || '').trim(),
            observacao: String(body.guardian.observacao || '').trim(),
        };
    }
    if (body.accessibility !== undefined && body.accessibility && typeof body.accessibility === 'object') {
        const a = body.accessibility;
        out.accessibility = {
            fonteAmpliada: !!a.fonteAmpliada,
            altoContraste: !!a.altoContraste,
            reducaoAnimacoes: !!a.reducaoAnimacoes,
            leitorTela: !!a.leitorTela,
            tempoAdicional: !!a.tempoAdicional,
            tempoAdicionalPercent: Number(a.tempoAdicionalPercent) || 0,
            observacao: String(a.observacao || '').trim(),
        };
    }
    return out;
}

// Valida os campos do aluno. Retorna { ok, error }.
// `students` é a lista atual; `selfEmail` é o e-mail original (para ignorar o próprio no update).
// Cada recusa diz o campo do corpo (field), no formato dos 400 { success, error, field }
// (H5a): o formulário marca o campo certo em vez de só mostrar a mensagem.
function validateStudentFields(fields, students, selfEmail) {
    const self = normalizeEmail(selfEmail);

    if (fields.name !== undefined && !fields.name) {
        return { ok: false, error: 'Nome completo é obrigatório.', field: 'name' };
    }
    if (fields.email !== undefined) {
        if (!fields.email) return { ok: false, error: 'E-mail é obrigatório.', field: 'email' };
        if (!isValidEmail(fields.email)) return { ok: false, error: 'E-mail em formato inválido.', field: 'email' };
        const emailTaken = students.some(s => s.email && normalizeEmail(s.email) === fields.email && normalizeEmail(s.email) !== self);
        if (emailTaken) return { ok: false, error: 'E-mail já cadastrado para outro aluno.', field: 'email' };
    }
    if (fields.matricula) {
        const matTaken = students.some(s => s.matricula && String(s.matricula).trim() === fields.matricula && normalizeEmail(s.email) !== self);
        if (matTaken) return { ok: false, error: 'Matrícula/código interno já cadastrado para outro aluno.', field: 'matricula' };
    }
    if (fields.phone !== undefined && !isValidPhone(fields.phone)) {
        return { ok: false, error: 'Telefone em formato inválido.', field: 'phone' };
    }
    if (fields.guardianPhone !== undefined && !isValidPhone(fields.guardianPhone)) {
        return { ok: false, error: 'Telefone do responsável em formato inválido.', field: 'guardianPhone' };
    }
    if (fields.guardian && fields.guardian.phone && !isValidPhone(fields.guardian.phone)) {
        return { ok: false, error: 'Telefone do responsável em formato inválido.', field: 'guardian.phone' };
    }
    if (fields.guardian && fields.guardian.email && !isValidEmail(fields.guardian.email)) {
        return { ok: false, error: 'E-mail do responsável em formato inválido.', field: 'guardian.email' };
    }
    // Opcional no cadastro e na edição pelo professor, mas conferida (H8a-2).
    if (fields.birthDate) {
        const birth = checkBirthDate(fields.birthDate);
        if (!birth.ok) return { ok: false, error: birth.error, field: birth.field };
    }
    if (fields.status !== undefined && fields.status && !isValidStatus(fields.status)) {
        return { ok: false, error: `Status inválido. Use um de: ${STUDENT_STATUSES.join(', ')}.`, field: 'status' };
    }
    return { ok: true };
}

// ---- Turmas do aluno (DES-03) ----
// `classes` guarda strings (legado) ou objetos { name, courseId, period };
// `studentClass` é sempre o NOME (string) da turma principal. Fluxos antigos
// (aprovação de matrícula seguida de matrícula em lote, cadastro com turmas em
// objeto) gravavam o objeto em `studentClass` e derrubavam quem chamava
// .toLowerCase() nele (o Monitor da prova devolvia 500 em todas as turmas).
function classEntryName(entry) {
    if (typeof entry === 'string') return entry.trim();
    if (entry && typeof entry === 'object') return String(entry.name || entry.className || '').trim();
    if (typeof entry === 'number') return String(entry);
    return '';
}

function classEntryCourseId(entry) {
    return entry && typeof entry === 'object' ? String(entry.courseId || '').trim() : '';
}

// Lista normalizada das matrículas do aluno: [{ name, courseId }]. Usa `classes`
// quando há turmas; senão cai em `studentClass` (registros muito antigos).
function studentClassEntries(student) {
    if (!student) return [];
    const raw = Array.isArray(student.classes) && student.classes.length
        ? student.classes
        : (student.studentClass ? [student.studentClass] : []);
    const fallbackCourseId = String(student.courseId || '').trim();
    return raw
        .map(entry => ({ name: classEntryName(entry), courseId: classEntryCourseId(entry) || fallbackCourseId }))
        .filter(entry => entry.name);
}

function studentClassNameList(student) {
    return studentClassEntries(student).map(entry => entry.name);
}

// Nome da turma principal, sempre string.
function primaryStudentClassName(student) {
    if (!student) return '';
    const own = classEntryName(student.studentClass);
    if (own) return own;
    const first = studentClassEntries(student)[0];
    return first ? first.name : '';
}

// O aluno está matriculado na turma `className` (do curso `courseId`, quando
// informado)? Compara sem diferenciar maiúsculas. Entradas sem curso valem
// para qualquer curso (dados legados).
function studentInClass(student, className, courseId) {
    const wanted = String(className || '').trim().toLowerCase();
    if (!wanted) return false;
    const wantedCourse = String(courseId || '').trim();
    return studentClassEntries(student).some(entry =>
        entry.name.toLowerCase() === wanted
        && (!wantedCourse || !entry.courseId || entry.courseId === wantedCourse));
}

// Normaliza uma lista de turmas recebida (strings ou objetos) para gravação:
// strings aparadas; objetos viram { name, courseId, period }. Entradas sem nome saem.
function normalizeClassEntriesForStorage(list) {
    if (!Array.isArray(list)) return [];
    return list.map(entry => {
        if (typeof entry === 'string' || typeof entry === 'number') return String(entry).trim();
        if (!entry || typeof entry !== 'object') return '';
        const name = classEntryName(entry);
        if (!name) return '';
        const out = { name, courseId: classEntryCourseId(entry) };
        if (entry.period !== undefined) out.period = String(entry.period || '');
        return out;
    }).filter(entry => (typeof entry === 'string' ? entry : entry && entry.name));
}

// Normaliza no lugar `studentClass` (e entradas inválidas de `classes`) de um
// aluno já gravado. Idempotente; retorna true se mudou algo.
function normalizeStoredStudentClasses(student) {
    if (!student || typeof student !== 'object') return false;
    let changed = false;
    if (student.classes !== undefined && !Array.isArray(student.classes)) {
        student.classes = student.classes ? [student.classes] : [];
        changed = true;
    }
    if (Array.isArray(student.classes)) {
        const before = JSON.stringify(student.classes);
        const next = student.classes.map(entry => {
            if (typeof entry === 'string') return entry.trim();
            if (entry && typeof entry === 'object') {
                const name = classEntryName(entry);
                if (!name) return '';
                if (entry.name === name) return entry;
                const fixed = { ...entry, name };
                delete fixed.className;
                return fixed;
            }
            return typeof entry === 'number' ? String(entry) : '';
        }).filter(entry => (typeof entry === 'string' ? entry : entry && entry.name));
        if (JSON.stringify(next) !== before) { student.classes = next; changed = true; }
    }
    if (student.studentClass !== undefined && student.studentClass !== null && typeof student.studentClass !== 'string') {
        student.studentClass = classEntryName(student.studentClass);
        changed = true;
    }
    return changed;
}


// Gera as entradas de auditoria comparando o aluno antigo com os novos campos.
// Registra apenas os campos escalares auditáveis que mudaram, mais 'classes' (turmas).
function diffStudentForAudit(oldStudent, newFields) {
    const changes = [];
    AUDITABLE_FIELDS.forEach(({ key, label }) => {
        if (newFields[key] === undefined) return;
        const before = oldStudent && oldStudent[key] !== undefined && oldStudent[key] !== null ? String(oldStudent[key]) : '';
        const after = newFields[key] !== null ? String(newFields[key]) : '';
        if (before !== after) changes.push({ field: label, oldValue: before, newValue: after });
    });
    if (newFields.classes !== undefined) {
        const before = (oldStudent && Array.isArray(oldStudent.classes) ? oldStudent.classes : []).map(c => typeof c === 'string' ? c : c.name).join(', ');
        const after = (Array.isArray(newFields.classes) ? newFields.classes : []).map(c => typeof c === 'string' ? c : c.name).join(', ');
        if (before !== after) changes.push({ field: 'Turmas', oldValue: before, newValue: after });
    }
    if (newFields.accessibility !== undefined) {
        const before = JSON.stringify((oldStudent && oldStudent.accessibility) || {});
        const after = JSON.stringify(newFields.accessibility || {});
        if (before !== after) changes.push({ field: 'Preferências de acessibilidade', oldValue: '', newValue: 'atualizadas' });
    }
    return changes;
}

// Cria e anexa entradas de auditoria na coleção em memória, uma por campo alterado,
// todas com a mesma hora. Atalho para recordAudit (utils/audit.js), na categoria
// 'student', com os mesmos campos de antes (field/oldValue/newValue), que o painel
// Auditoria da ficha do aluno lê. Não persiste (chame db.save() depois).
function recordStudentAudit(memory, { actor, studentEmail, changes, req, action, reason }) {
    const timestamp = Date.now();
    const entries = (changes && changes.length ? changes : [{ field: action || 'Registro', oldValue: '', newValue: '' }]);
    entries.forEach(c => {
        recordAudit(memory, {
            req,
            actor: actor || 'desconhecido',
            action: action || 'update',
            category: 'student',
            studentEmail: normalizeEmail(studentEmail),
            field: c.field,
            oldValue: c.oldValue,
            newValue: c.newValue,
            reason,
        }, { timestamp });
    });
}

module.exports = {
    STUDENT_STATUSES,
    OBSERVATION_CATEGORIES,
    OBSERVATION_VISIBILITY,
    EXTRA_TIME_OPTIONS,
    DEFAULT_STATUS,
    CLOSED_STUDENT_STATUSES,
    isClosedStudentStatus,
    ANONYMIZED_STATUS,
    isAnonymizedStudent,
    STATUS_REASON_MAX,
    cleanStatusReason,
    applyStudentStatus,
    lastStatusChangeIndex,
    studentStatusSince,
    AUDITABLE_FIELDS,
    normalizeEmail,
    isValidEmail,
    isValidPhone,
    isValidStatus,
    displayName,
    extractStudentFields,
    validateStudentFields,
    diffStudentForAudit,
    recordStudentAudit,
    getClientIp,
    classEntryName,
    studentClassEntries,
    studentClassNameList,
    primaryStudentClassName,
    studentInClass,
    normalizeClassEntriesForStorage,
    normalizeStoredStudentClasses,
};
