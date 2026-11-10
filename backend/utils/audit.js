// Trilha de auditoria (H7a-1; SEG-07, FUN-04): quem fez o quê, quando e de onde.
//
// recordAudit é a única forma de gravar uma entrada nova em auditLogs (contrato 6 da
// fase 2). A exceção são as entradas de prova (type/actor/timestamp com applicationId:
// encerramento, anulação, contestação...), que buildApplicationAuditTrail (gradebook.js)
// lê pelo type e continuam no formato próprio.
//
// A trilha só cresce: nada aqui altera ou remove entrada gravada. Só podem mexer numa
// entrada existente a troca de e-mail do aluno (renameStudentEmailEverywhere), a
// anonimização (anonymizeStudentAuditTrail), o apagar de vez do aluno e a junção na
// restauração (mergeAuditTrails); test/backend/audit-trail.test.js confere no código.
//
// O banco tem quatro formatos antigos, que nunca são reescritos (a leitura passa por
// normalizeAuditEntry):
// - action/actor/timestamp em ms (notas, cadastro do aluno, backup);
// - type/actorEmail/at em ms (turmas e conteúdo, escopo do professor, manutenção);
// - type/actor/timestamp em ISO (provas);
// - type/actorEmail/at em ISO (modo de configuração local).
// As entradas novas saem no formato canônico. Os registradores que já existiam
// (recordGradeAudit, recordStudentAudit, recordAcademicAudit...) viraram atalhos para
// recordAudit e continuam gravando também os campos antigos que as telas e a lixeira
// de notas leem (type, actorEmail, at, target), para nada que já funciona mudar.
//
// Este módulo não depende do banco nem de outros utilitários: recebe a memória
// (db.memory) e não grava (quem chama faz o db.save() depois).

const crypto = require('crypto');

// Categorias da trilha (filtro da tela Auditoria e do CSV).
const AUDIT_CATEGORIES = ['grade', 'student', 'attendance', 'exam', 'academic', 'content', 'account', 'security', 'system', 'backup', 'privacy', 'other'];
const CATEGORY_LABELS = {
    grade: 'Notas',
    student: 'Alunos',
    attendance: 'Presença',
    exam: 'Provas',
    academic: 'Cursos e turmas',
    content: 'Conteúdo',
    account: 'Contas de acesso',
    security: 'Segurança',
    system: 'Sistema',
    backup: 'Backup',
    privacy: 'Privacidade (LGPD)',
    other: 'Outros',
};

// Rótulo em português de cada ação (tela Auditoria, CSV). Os nomes de ação são fixos
// (contrato 6 da fase 2): cada grupo acrescenta aqui o rótulo das ações que passa a
// gravar. Ação fora da lista ainda é gravada e aparece como "Outro evento (nome)".
const ACTION_LABELS = Object.freeze({
    // Notas (recordGradeAudit)
    grade_create: 'Nota lançada',
    grade_publish: 'Nota publicada para o aluno',
    grade_unpublish: 'Nota ocultada do aluno',
    grade_delete: 'Nota excluída',
    grade_restore: 'Nota restaurada da lixeira',
    grade_regrade: 'Nota recalculada',
    grade_result_archive: 'Tentativa desconsiderada',
    grade_result_restore: 'Tentativa considerada de novo',
    grade_result_select: 'Tentativa escolhida para o resultado',
    grade_result_policy: 'Regra de cálculo da nota alterada',
    // Cadastro do aluno (recordStudentAudit)
    create: 'Aluno cadastrado',
    update: 'Cadastro do aluno alterado',
    bulk_enroll: 'Turma alterada em lote',
    bulk_status: 'Situação alterada em lote',
    enrollment_approved: 'Matrícula aprovada',
    enrollment_rejected: 'Matrícula recusada',
    observation_create: 'Observação pedagógica registrada',
    observation_update: 'Observação pedagógica editada',
    observation_delete: 'Observação pedagógica excluída',
    student_anonymized: 'Aluno anonimizado',
    student_purged: 'Cadastro apagado de vez',
    // Segurança
    student_password_reset: 'Senha do aluno redefinida',
    local_quick_login: 'Acesso rápido local (modo de configuração)',
    admin_local_setup_login: 'Entrada administrativa local (modo de configuração)',
    admin_password_reset_local: 'Senha de conta redefinida no computador do servidor',
    // Contas de acesso
    account_created: 'Conta de acesso criada',
    account_updated: 'Conta de acesso alterada',
    account_deleted: 'Conta de acesso excluída',
    account_password_changed: 'Senha de conta trocada',
    account_login_unlocked: 'Entrada de conta desbloqueada',
    student_login_unlocked: 'Entrada de aluno desbloqueada',
    professor_assignments_updated: 'Turmas, cursos e escolas do professor alterados',
    // Cursos e turmas
    course_created: 'Curso criado',
    course_updated: 'Curso alterado',
    course_deleted: 'Curso excluído',
    course_cloned: 'Curso duplicado',
    course_disciplinas_updated: 'Disciplinas do curso alteradas',
    course_grade_templates_updated: 'Modelos de avaliação do curso alterados',
    class_created: 'Turma criada',
    class_updated: 'Turma alterada',
    class_deleted: 'Turma excluída',
    // Conteúdo
    content_material_updated: 'Material alterado',
    content_unit_created: 'Unidade de conteúdo criada',
    content_evaluation_created: 'Avaliação criada',
    content_evaluation_updated: 'Avaliação alterada',
    content_library_created: 'Item da biblioteca adicionado',
    content_library_updated: 'Item da biblioteca alterado',
    content_library_deleted: 'Item da biblioteca excluído',
    // Sistema
    settings_updated: 'Configurações alteradas',
    storage_compacted: 'Banco de dados compactado',
    network_settings_changed: 'Configurações de rede alteradas',
    class_reset: 'Sala resetada',
    exam_state_flushed: 'Estado de prova limpo',
    server_restart_requested: 'Reinício do servidor pedido',
    // Backup
    backup_server_created: 'Cópia de segurança gerada no servidor',
    backup_downloaded: 'Backup baixado',
    backup_restored: 'Backup restaurado',
    backup_restore_failed: 'Restauração de backup recusada ou com falha',
    // Privacidade (LGPD)
    privacy_accept: 'Termos e Política de Privacidade aceitos',
    legal_publish: 'Documento legal publicado',
    retention_purge: 'Registros antigos apagados pelo prazo de guarda',
    lgpd_export: 'Dados pessoais exportados',
    // Provas (formato próprio, gravado fora de recordAudit)
    exam_application_finished: 'Aplicação de prova encerrada',
    exam_application_replaced: 'Aplicação de prova substituída',
    exam_application_cancelled: 'Aplicação de prova cancelada',
    exam_application_token_regenerated: 'Token da prova trocado',
    exam_question_annulled: 'Questão anulada',
    exam_question_replaced: 'Questão trocada',
    exam_question_corrected_live: 'Questão corrigida durante a aplicação',
    exam_question_reported: 'Questão contestada pelo aluno',
    exam_question_reports_reviewed: 'Contestações revisadas',
    exam_attempt_recovered_after_finish: 'Tentativa recuperada depois do encerramento',
    exam_attempt_reopened_extra_time: 'Tentativa reaberta com tempo extra',
    exam_attempt_reopen_discarded: 'Reabertura sem entrega nova: a entrega anterior voltou',
});

// Categoria de uma ação sem category gravada (entradas antigas, ou ação nova que não
// passou a categoria ao recordAudit): primeiro esta lista, que só tem os nomes que o
// começo não classifica (ou classificaria errado: class_reset é sistema, não turma;
// exam_state_flushed é sistema, não prova); depois o começo do nome (CATEGORY_PREFIXES).
// Ação nova com rótulo em ACTION_LABELS precisa cair numa categoria por um dos dois
// caminhos (test/backend/audit-normalize.test.js confere).
const ACTION_CATEGORIES = Object.freeze({
    create: 'student',
    update: 'student',
    bulk_enroll: 'student',
    bulk_status: 'student',
    enrollment_approved: 'student',
    enrollment_rejected: 'student',
    observation_create: 'student',
    observation_update: 'student',
    observation_delete: 'student',
    student_anonymized: 'student',
    student_purged: 'student',
    student_password_reset: 'security',
    local_quick_login: 'security',
    admin_local_setup_login: 'security',
    admin_password_reset_local: 'security',
    student_login_unlocked: 'account',
    storage_compacted: 'system',
    network_settings_changed: 'system',
    class_reset: 'system',
    exam_state_flushed: 'system',
});

const CATEGORY_PREFIXES = [
    ['grade_', 'grade'],
    ['attendance_', 'attendance'],
    ['exam_', 'exam'],
    ['backup_', 'backup'],
    ['class_', 'academic'],
    ['course_', 'academic'],
    ['school_', 'academic'],
    ['certificate_', 'academic'],
    ['announcement_', 'academic'],
    ['calendar_', 'academic'],
    ['question_', 'academic'],
    ['content_', 'content'],
    ['professor_assignments', 'account'],
    ['account_', 'account'],
    ['settings_', 'system'],
    ['trash_', 'system'],
    ['server_restart', 'system'],
    ['forum_purged', 'system'],
    ['audit_', 'system'],
    ['privacy_', 'privacy'],
    ['legal_', 'privacy'],
    ['retention_', 'privacy'],
    ['lgpd_', 'privacy'],
];

function inferAuditCategory(action, raw = null) {
    const name = String(action || '');
    if (Object.prototype.hasOwnProperty.call(ACTION_CATEGORIES, name)) return ACTION_CATEGORIES[name];
    const prefix = CATEGORY_PREFIXES.find(([start]) => name.startsWith(start));
    if (prefix) return prefix[1];
    // Alteração do cadastro no formato antigo (recordStudentAudit, sem category).
    if (raw && typeof raw === 'object' && !raw.type && Object.prototype.hasOwnProperty.call(raw, 'field')) return 'student';
    return 'other';
}

function actionLabel(action) {
    const name = String(action || '');
    if (Object.prototype.hasOwnProperty.call(ACTION_LABELS, name)) return ACTION_LABELS[name];
    return name ? `Outro evento (${name})` : 'Outro evento';
}

// IP de quem fez o pedido, sem o prefixo IPv4-mapeado (::ffff:) e com ::1 como 127.0.0.1.
function getClientIp(req) {
    try {
        const raw = (req && (req.ip || (req.socket && req.socket.remoteAddress))) || '';
        return raw.startsWith('::ffff:') ? raw.substring(7) : (raw === '::1' ? '127.0.0.1' : raw);
    } catch (e) { return ''; }
}

const DEVICE_MAX_LENGTH = 160;
const REASON_MAX_LENGTH = 500;

// ------------------------------------------------------------ segredos
// Senha, hash, sal e tokens nunca vão para a auditoria, nem dentro de um objeto
// copiado inteiro (a turma em before/after, a conta, o pedido). Vale para o nome exato
// e para nomes terminados em password/senha/token/secret/hash/salt (studentPassword,
// controlToken, examAnswerSecret, accessTokenHash da prova, tokenHash da sessão...).
// O hash também sai: o token da prova tem 5 letras e o accessTokenHash é sha256 sem
// sal, que volta ao token por tentativa em segundos. Valor booleano fica
// (mustChangePassword: true não é segredo; só diz que a senha precisa ser trocada).
// O vazio (null) também sai: a trilha nem mostra que o campo existe.
const SECRET_KEYS = new Set(['password', 'passwordhash', 'hash', 'salt', 'token', 'sessiontoken', 'accesstoken', 'adminsessiontoken', 'secret', 'senha']);
const SECRET_SUFFIXES = /(password|senha|token|secret|hash|salt)$/;

function isSecretKey(key, value) {
    if (typeof value === 'boolean') return false;
    const name = String(key).toLowerCase();
    return SECRET_KEYS.has(name) || SECRET_SUFFIXES.test(name);
}

// Cópia profunda sem os segredos. A entrada guarda uma fotografia: antes a turma ia por
// referência e a auditoria de "turma criada" mudava junto com cada edição da turma.
const MAX_DEPTH = 40;
function stripSecrets(value, depth = 0, ancestors = new Set()) {
    if (value === null || typeof value !== 'object') {
        if (typeof value === 'bigint') return String(value);
        if (typeof value === 'function' || typeof value === 'symbol') return undefined;
        return value;
    }
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
    if (ancestors.has(value)) return '[referência circular]';
    if (depth >= MAX_DEPTH) return '[conteúdo muito aninhado]';
    ancestors.add(value);
    let copy;
    if (Array.isArray(value)) {
        copy = value.map(item => {
            const cleaned = stripSecrets(item, depth + 1, ancestors);
            return cleaned === undefined ? null : cleaned;
        });
    } else {
        copy = {};
        Object.keys(value).forEach(key => {
            const item = value[key];
            if (isSecretKey(key, item)) return;
            const cleaned = stripSecrets(item, depth + 1, ancestors);
            if (cleaned !== undefined) copy[key] = cleaned;
        });
    }
    ancestors.delete(value);
    return copy;
}

// ------------------------------------------------------------ gravação
function normalizedActor(value) {
    const text = String(value ?? '').trim();
    return text.includes('@') ? text.toLowerCase() : text;
}

// Quem fez: e-mail (minúsculas) da conta passada, do texto passado, da conta do
// pedido (req.adminAccount) ou do aluno da sessão; sem nada disso, 'sistema'.
function resolveActor(actor, req) {
    let value = actor && typeof actor === 'object' ? actor.email : actor;
    value = normalizedActor(value);
    if (!value && req && req.adminAccount && req.adminAccount.email) value = normalizedActor(req.adminAccount.email);
    if (!value && req && req.studentEmail) value = normalizedActor(req.studentEmail);
    return value || 'sistema';
}

// Papel de quem fez, quando dá para saber: a conta passada ou a do pedido (admin ou
// professor), o aluno da sessão, ou o próprio sistema. Sem como saber, fica de fora.
function resolveActorRole(actor, req, actorValue) {
    const accountRole = account => (account && account.role === 'professor' ? 'professor' : 'admin');
    if (actor && typeof actor === 'object' && actor.email && normalizedActor(actor.email) === actorValue) return accountRole(actor);
    if (req && req.adminAccount && req.adminAccount.email && normalizedActor(req.adminAccount.email) === actorValue) return accountRole(req.adminAccount);
    if (req && req.studentEmail && normalizedActor(req.studentEmail) === actorValue) return 'aluno';
    if (actorValue === 'sistema' || actorValue === 'launcher-local') return 'sistema';
    return undefined;
}

const CANONICAL_KEYS = new Set(['id', 'action', 'category', 'actor', 'actorRole', 'timestamp', 'ip', 'device',
    'studentEmail', 'targetEmail', 'courseId', 'studentClass', 'examKey', 'applicationId', 'submissionId',
    'field', 'oldValue', 'newValue', 'reason', 'before', 'after', 'details']);

// Grava uma entrada nova no fim de memory.auditLogs (cria a lista se faltar) e devolve
// a entrada. Não grava no banco: quem chama faz o db.save() depois.
// - actor: conta ({ email, role }) ou e-mail/texto; sem ele, a conta do pedido.
// - campos opcionais só entram quando definidos (undefined fica de fora; null fica,
//   para os registradores antigos continuarem gravando o mesmo que antes).
// - before, after e details entram como cópia, sem senha, hash, sal nem token.
// options (só para os registradores antigos e para testes):
// - timestamp: a mesma hora para várias entradas do mesmo pedido;
// - legacy: campos do formato antigo que leitores existentes ainda usam (type,
//   actorEmail, at, target...). Nunca substituem um campo canônico.
function recordAudit(memory, fields = {}, options = {}) {
    if (!memory || typeof memory !== 'object') throw new TypeError('recordAudit: memória ausente.');
    const action = String((fields && fields.action) || '').trim();
    if (!action) throw new TypeError('recordAudit: ação ausente.');
    const {
        req, actor, category,
        studentEmail, targetEmail, courseId, studentClass, examKey, applicationId, submissionId,
        field, oldValue, newValue, reason, before, after, details,
    } = fields;
    const givenTime = options.timestamp === undefined || options.timestamp === null ? NaN : Number(options.timestamp);
    const timestamp = Number.isFinite(givenTime) ? givenTime : Date.now();
    const finalCategory = String(category || '').trim() || inferAuditCategory(action);
    const actorValue = resolveActor(actor, req);
    const actorRole = resolveActorRole(actor, req, actorValue);
    const entry = {
        id: `audit_${finalCategory}_${timestamp}_${crypto.randomBytes(4).toString('hex')}`,
        action,
        category: finalCategory,
        actor: actorValue,
    };
    if (actorRole) entry.actorRole = actorRole;
    entry.timestamp = timestamp;
    entry.ip = getClientIp(req);
    entry.device = String((req && req.headers && req.headers['user-agent']) || '').slice(0, DEVICE_MAX_LENGTH);
    const email = value => (value === null ? null : String(value).trim().toLowerCase());
    if (studentEmail !== undefined) entry.studentEmail = email(studentEmail);
    if (targetEmail !== undefined) entry.targetEmail = email(targetEmail);
    if (courseId !== undefined) entry.courseId = courseId;
    if (studentClass !== undefined) entry.studentClass = studentClass;
    if (examKey !== undefined) entry.examKey = examKey;
    if (applicationId !== undefined) entry.applicationId = applicationId;
    if (submissionId !== undefined) entry.submissionId = submissionId === null ? null : String(submissionId);
    if (field !== undefined) entry.field = field;
    if (oldValue !== undefined) entry.oldValue = stripSecrets(oldValue);
    if (newValue !== undefined) entry.newValue = stripSecrets(newValue);
    if (reason !== undefined && reason !== null && String(reason).trim()) entry.reason = String(reason).trim().slice(0, REASON_MAX_LENGTH);
    if (before !== undefined) entry.before = stripSecrets(before);
    if (after !== undefined) entry.after = stripSecrets(after);
    if (details !== undefined) entry.details = stripSecrets(details);
    const legacy = options.legacy && typeof options.legacy === 'object' ? options.legacy : null;
    if (legacy) {
        Object.keys(legacy).forEach(key => {
            if (CANONICAL_KEYS.has(key) || legacy[key] === undefined || isSecretKey(key, legacy[key])) return;
            entry[key] = stripSecrets(legacy[key]);
        });
    }
    if (!Array.isArray(memory.auditLogs)) memory.auditLogs = [];
    memory.auditLogs.push(entry);
    return entry;
}

// ------------------------------------------------------------ leitura
// Hora da entrada em ms: número usado direto, texto ISO (ou só dígitos) convertido.
// Inválida vira 0 (vai para o fim de uma lista do mais novo para o mais antigo).
function auditTimestamp(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
    if (typeof value !== 'string' || !value.trim()) return 0;
    const text = value.trim();
    const parsed = /^\d+$/.test(text) ? Number(text) : Date.parse(text);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function firstText(...values) {
    for (const value of values) {
        if (value === null || value === undefined) continue;
        const text = String(value).trim();
        if (text) return text;
    }
    return '';
}

// Campos que normalizeAuditEntry já lê; o resto de uma entrada antiga sem details
// (backup antigo: file, size, error...) vira o details da entrada normalizada.
const KNOWN_RAW_KEYS = new Set([...CANONICAL_KEYS, 'type', 'actorEmail', 'at', 'label', 'studentAnonymized', 'anonymizedAt']);

// Entrada em qualquer um dos formatos, no formato canônico de leitura (tela Auditoria,
// CSV). Só lê: a entrada gravada não muda. Devolve null para o que não é entrada.
function normalizeAuditEntry(raw) {
    if (!isPlainObject(raw)) return null;
    const rawDetails = isPlainObject(raw.details) ? raw.details : null;
    const target = isPlainObject(raw.target) ? raw.target : null;
    const action = firstText(raw.action, raw.type);
    let details = raw.details === undefined ? null : raw.details;
    if (details === null) {
        const loose = {};
        Object.keys(raw).forEach(key => { if (!KNOWN_RAW_KEYS.has(key) && raw[key] !== undefined) loose[key] = raw[key]; });
        if (Object.keys(loose).length) details = loose;
    }
    const actor = firstText(raw.actor, raw.actorEmail);
    return {
        id: raw.id === undefined || raw.id === null ? '' : String(raw.id),
        action,
        category: firstText(raw.category) || inferAuditCategory(action, raw),
        actor,
        actorRole: firstText(raw.actorRole) || (actor === 'sistema' || actor === 'launcher-local' ? 'sistema' : ''),
        timestamp: auditTimestamp(raw.timestamp !== undefined && raw.timestamp !== null && raw.timestamp !== '' ? raw.timestamp : raw.at),
        ip: firstText(raw.ip),
        studentEmail: firstText(raw.studentEmail, rawDetails && rawDetails.studentEmail).toLowerCase(),
        targetEmail: firstText(raw.targetEmail, rawDetails && rawDetails.targetEmail).toLowerCase(),
        courseId: firstText(raw.courseId, target && target.courseId, rawDetails && rawDetails.courseId) || null,
        studentClass: firstText(raw.studentClass, target && (target.className || target.studentClass), rawDetails && (rawDetails.studentClass || rawDetails.className)) || null,
        examKey: firstText(raw.examKey, rawDetails && rawDetails.examKey) || null,
        applicationId: firstText(raw.applicationId, rawDetails && rawDetails.applicationId) || null,
        submissionId: firstText(raw.submissionId, rawDetails && rawDetails.submissionId) || null,
        field: raw.field === undefined || raw.field === null ? '' : raw.field,
        oldValue: raw.oldValue === undefined ? null : raw.oldValue,
        newValue: raw.newValue === undefined ? null : raw.newValue,
        reason: firstText(raw.reason),
        before: raw.before === undefined ? null : raw.before,
        after: raw.after === undefined ? null : raw.after,
        details,
        label: actionLabel(action),
    };
}

// ------------------------------------------------------------ restauração
// Identidade da entrada para juntar duas trilhas: o id; sem id, o conteúdo inteiro.
function entryIdentity(entry) {
    if (entry.id !== undefined && entry.id !== null && String(entry.id) !== '') return `id:${String(entry.id)}`;
    try { return `json:${JSON.stringify(entry)}`; } catch (e) { return null; }
}

// Restaurar um backup não apaga o registro de quem fez o quê depois dele (FUN-03,
// CONF-09). Devolve uma lista nova com todas as entradas do backup (a do backup vence
// quando o id é o mesmo) mais as atuais que o backup não tem, em ordem de hora (a mais
// antiga primeiro; mesma hora, a ordem de antes). Backup sem a trilha (restored que
// não é lista) deixa a atual como está. Não altera as listas recebidas.
function mergeAuditTrails(restored, current) {
    const currentList = (Array.isArray(current) ? current : []).filter(isPlainObject);
    if (!Array.isArray(restored)) return currentList.slice();
    const restoredList = restored.filter(isPlainObject);
    const known = new Set(restoredList.map(entryIdentity).filter(Boolean));
    const extra = currentList.filter(entry => {
        const identity = entryIdentity(entry);
        return !identity || !known.has(identity);
    });
    return [...restoredList, ...extra]
        .map((entry, index) => ({ entry, index, time: auditTimestamp(entry.timestamp !== undefined && entry.timestamp !== null && entry.timestamp !== '' ? entry.timestamp : entry.at) }))
        .sort((a, b) => a.time - b.time || a.index - b.index)
        .map(item => item.entry);
}

module.exports = {
    AUDIT_CATEGORIES,
    CATEGORY_LABELS,
    ACTION_LABELS,
    ACTION_CATEGORIES,
    recordAudit,
    normalizeAuditEntry,
    mergeAuditTrails,
    stripSecrets,
    inferAuditCategory,
    actionLabel,
    auditTimestamp,
    getClientIp,
};
