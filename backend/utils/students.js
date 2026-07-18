// Fase 1 — Utilitários de cadastro de aluno: campos, validações e auditoria.
// Mantém o padrão do projeto (objetos JSON em memoryDB, sem ORM/migrations).

const crypto = require('crypto');

// Status permitidos para o aluno. "Ativo" é o padrão ao cadastrar.
const STUDENT_STATUSES = ['Ativo', 'Inativo', 'Bloqueado', 'Concluído', 'Transferido', 'Evadido'];
const OBSERVATION_CATEGORIES = ['Dificuldade de aprendizagem', 'Participação', 'Frequência', 'Entregas atrasadas', 'Acompanhamento pedagógico', 'Acessibilidade pedagógica', 'Comportamento acadêmico', 'Observação geral'];
const OBSERVATION_VISIBILITY = ['Restrita (coordenação)', 'Equipe pedagógica', 'Compartilhada'];
const EXTRA_TIME_OPTIONS = [25, 50, 100];
const DEFAULT_STATUS = 'Ativo';

// Campos escalares auditáveis do perfil do aluno.
const AUDITABLE_FIELDS = [
    { key: 'name', label: 'Nome completo' },
    { key: 'nomeSocial', label: 'Nome social' },
    { key: 'email', label: 'E-mail/login' },
    { key: 'matricula', label: 'Matrícula' },
    { key: 'phone', label: 'Telefone' },
    { key: 'guardianPhone', label: 'Telefone do responsável' },
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
function validateStudentFields(fields, students, selfEmail) {
    const self = normalizeEmail(selfEmail);

    if (fields.name !== undefined && !fields.name) {
        return { ok: false, error: 'Nome completo é obrigatório.' };
    }
    if (fields.email !== undefined) {
        if (!fields.email) return { ok: false, error: 'E-mail é obrigatório.' };
        if (!isValidEmail(fields.email)) return { ok: false, error: 'E-mail em formato inválido.' };
        const emailTaken = students.some(s => s.email && normalizeEmail(s.email) === fields.email && normalizeEmail(s.email) !== self);
        if (emailTaken) return { ok: false, error: 'E-mail já cadastrado para outro aluno.' };
    }
    if (fields.matricula) {
        const matTaken = students.some(s => s.matricula && String(s.matricula).trim() === fields.matricula && normalizeEmail(s.email) !== self);
        if (matTaken) return { ok: false, error: 'Matrícula/código interno já cadastrado para outro aluno.' };
    }
    if (fields.phone !== undefined && !isValidPhone(fields.phone)) {
        return { ok: false, error: 'Telefone em formato inválido.' };
    }
    if (fields.guardianPhone !== undefined && !isValidPhone(fields.guardianPhone)) {
        return { ok: false, error: 'Telefone do responsável em formato inválido.' };
    }
    if (fields.guardian && fields.guardian.phone && !isValidPhone(fields.guardian.phone)) {
        return { ok: false, error: 'Telefone do responsável em formato inválido.' };
    }
    if (fields.guardian && fields.guardian.email && !isValidEmail(fields.guardian.email)) {
        return { ok: false, error: 'E-mail do responsável em formato inválido.' };
    }
    if (fields.status !== undefined && fields.status && !isValidStatus(fields.status)) {
        return { ok: false, error: `Status inválido. Use um de: ${STUDENT_STATUSES.join(', ')}.` };
    }
    return { ok: true };
}

function getClientIp(req) {
    try {
        const raw = (req && (req.ip || (req.socket && req.socket.remoteAddress))) || '';
        return raw.startsWith('::ffff:') ? raw.substring(7) : (raw === '::1' ? '127.0.0.1' : raw);
    } catch (e) { return ''; }
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

// Cria e anexa entradas de auditoria na coleção em memória. Não persiste (chame db.save() depois).
function recordStudentAudit(memory, { actor, studentEmail, changes, req, action }) {
    if (!Array.isArray(memory.auditLogs)) memory.auditLogs = [];
    const ts = Date.now();
    const ip = getClientIp(req);
    const device = (req && req.headers && req.headers['user-agent']) || '';
    const entries = (changes && changes.length ? changes : [{ field: action || 'Registro', oldValue: '', newValue: '' }]);
    entries.forEach((c, idx) => {
        memory.auditLogs.push({
            id: `audit_${ts}_${idx}_${crypto.randomBytes(3).toString('hex')}`,
            actor: actor || 'desconhecido',
            studentEmail: normalizeEmail(studentEmail),
            action: action || 'update',
            field: c.field,
            oldValue: c.oldValue,
            newValue: c.newValue,
            timestamp: ts,
            ip,
            device,
        });
    });
}

module.exports = {
    STUDENT_STATUSES,
    OBSERVATION_CATEGORIES,
    OBSERVATION_VISIBILITY,
    EXTRA_TIME_OPTIONS,
    DEFAULT_STATUS,
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
};
