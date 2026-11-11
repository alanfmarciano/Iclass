// Cópia dos dados pessoais de um aluno (H8c reduzido; SEG-14, art. 18 da LGPD: acesso e
// portabilidade).
//
// buildStudentDataExport(memory, email, { audience, keystrokes, now, generatedBy }) monta o
// arquivo JSON de uma pessoa só. Duas versões:
// - 'aluno' (GET /api/student/my-data, "Meus dados" no portal): o que é dele e o que ele
//   já pode ver no portal. Ficam de fora a senha e a sessão, a nota ainda não publicada
//   (a entrega aparece "em revisão"), o gabarito não liberado, o conteúdo da prova, as
//   observações que não são 'Compartilhada', o texto restrito de acessibilidade (laudo,
//   SEG-04), quem da equipe fez cada coisa (e-mail, IP e aparelho de quem alterou), as
//   respostas de outros alunos no fórum e qualquer dado de outro aluno.
// - 'admin' (GET /api/admin/lgpd/students/export, ficha do aluno): tudo o que o IClass
//   guarda da pessoa, inclusive as observações restritas, a acessibilidade inteira, as
//   provas em andamento e a auditoria. A rota grava lgpd_export na auditoria.
//
// Quem é dono de cada registro segue studentEmailOwnership (gradebook.js), como a
// anonimização (studentLifecycle.js): os e-mails que o aluno já usou, cada um no período
// em que foi dele. Assim o que a exportação mostra é o mesmo que a anonimização tira.
//
// Não grava nada e não lê o banco: recebe a memória (db.memory) e as teclas da prova já
// buscadas (db.keystrokes.findByEmails), porque elas moram em tabela própria.
const { stripSecrets, normalizeAuditEntry, auditEntryWithoutSecrets } = require('./audit.js');
const { studentEmailOwnership } = require('./gradebook.js');
const { normalizeEmail, studentClassEntries, isAnonymizedStudent } = require('./students.js');
const legal = require('./legalDocuments.js');
const { studentCourseId } = require('./legalAcceptance.js');
const { keystrokeModeOf, KEYSTROKE_MODE_LABELS } = require('./keystrokePolicy.js');

const EXPORT_TYPE = 'iclass-dados-pessoais';
const EXPORT_FORMAT_VERSION = 1;
const AUDIENCES = ['aluno', 'admin'];
const SHARED_OBSERVATION_VISIBILITY = 'Compartilhada';
const SENSITIVE_OBSERVATION_CATEGORIES = new Set(['Acessibilidade pedagógica']);

const STUDENT_NOTICE = 'Cópia dos seus dados pessoais guardados pelo IClass desta escola (art. 18 da LGPD: acesso e portabilidade). '
    + 'Não traz a sua senha nem dados de outros alunos. Nota ainda não publicada aparece como "em revisão", e o gabarito só aparece depois que o professor o libera. '
    + 'Para corrigir um dado ou pedir a cópia completa, fale com o professor ou com o encarregado de dados da escola.';
const ADMIN_NOTICE = 'Exportação completa dos dados pessoais do aluno, feita pela administração (art. 18 da LGPD). '
    + 'Inclui observações restritas, acessibilidade, provas em andamento e a auditoria. '
    + 'Este arquivo é dado pessoal: guarde em lugar seguro e não envie por canal aberto.';

// Campos do cadastro que viram seção própria (não se repetem no perfil).
const SECTION_FIELDS = ['classes', 'studentClass', 'enrollmentRequests', 'termsAcceptance', 'privacyAcceptance', 'legalAcceptances'];
// Quem da equipe fez: some na versão do aluno (risco anotado no desenho do H8: "os
// atores ficam de fora"). Também as listas de leitura das mensagens, que têm o e-mail de
// outros alunos.
const ACTOR_KEYS = new Set(['actor', 'actorEmail', 'actorRole', 'author', 'authorEmail', 'authorName', 'senderEmail', 'senderName', 'deletedFor', 'readBy']);
const ACTOR_SUFFIX = /By$/;
// Campos de sessão (o perfil nunca leva sessão nem o corte das sessões antigas).
const SESSION_KEY = /session/i;
// Conteúdo da prova (enunciados e alternativas): não é dado pessoal e incha o arquivo.
const EXAM_CONTENT_KEYS = ['examSnapshot', 'examQuestions'];

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function list(value) {
    return Array.isArray(value) ? value.filter(Boolean) : [];
}

// Cópia sem os campos de quem fez (versão do aluno), em qualquer profundidade.
function withoutActors(value, depth = 0) {
    if (depth > 40 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(item => withoutActors(item, depth + 1));
    const out = {};
    Object.keys(value).forEach(key => {
        if (ACTOR_KEYS.has(key) || ACTOR_SUFFIX.test(key)) return;
        out[key] = withoutActors(value[key], depth + 1);
    });
    return out;
}

// Cópia limpa para o arquivo: sem senha, hash, sal nem token (stripSecrets) e, para o
// aluno, sem quem da equipe fez.
function clean(value, audience) {
    const copy = stripSecrets(value);
    return audience === 'aluno' ? withoutActors(copy) : copy;
}

function isoTime(value) {
    if (value === null || value === undefined || value === '') return null;
    const time = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function findStudent(memory, email) {
    return list(memory && memory.students).find(student => normalizeEmail(student.email) === email) || null;
}

// ------------------------------------------------------------ perfil e matrículas
function profileSection(student, audience) {
    const copy = { ...student };
    SECTION_FIELDS.forEach(field => { delete copy[field]; });
    Object.keys(copy).forEach(key => { if (SESSION_KEY.test(key)) delete copy[key]; });
    const profile = clean(copy, audience);
    if (audience === 'aluno' && isPlainObject(profile.accessibility)) {
        // O texto de acessibilidade pode trazer laudo ou diagnóstico e só o administrador o
        // vê (SEG-04). Fica a acomodação e o aviso de que existe um texto restrito.
        const note = String(profile.accessibility.observacao || '').trim();
        const { observacao, ...accommodation } = profile.accessibility;
        profile.accessibility = accommodation;
        if (note) profile.accessibilityNoteRestricted = true;
    }
    return profile;
}

function enrollmentsSection(memory, student, audience) {
    const courses = new Map(list(memory.courses).map(course => [String(course.id), course]));
    const classes = studentClassEntries(student).map(entry => {
        const course = courses.get(String(entry.courseId || ''));
        return { className: entry.name, courseId: entry.courseId || null, courseName: (course && course.name) || '' };
    });
    return {
        classes,
        period: typeof student.period === 'string' ? student.period : '',
        requests: list(student.enrollmentRequests).map(request => clean(request, audience)),
    };
}

function acceptancesSection(student, audience) {
    const acceptance = value => (isPlainObject(value) ? clean(value, audience) : null);
    return {
        terms: acceptance(student.termsAcceptance),
        privacy: acceptance(student.privacyAcceptance),
        previous: list(student.legalAcceptances).map(item => clean(item, audience)),
    };
}

// ------------------------------------------------------------ registros escolares
// Entrega como o aluno a vê no portal (my-submissions): nota só publicada, gabarito só
// liberado, sem o histórico de notas nem a decisão do professor. middlewares.js é lido só
// aqui (lê a turma no banco para saber se o gabarito saiu).
function submissionForStudent(submission, email) {
    const { sanitizeSubmissionForStudent, canStudentViewAnswerKey } = require('../middlewares.js');
    const answerKeyReleased = canStudentViewAnswerKey(submission, email);
    const view = sanitizeSubmissionForStudent(submission, answerKeyReleased);
    EXAM_CONTENT_KEYS.forEach(key => { delete view[key]; });
    view.answerKeyReleased = answerKeyReleased;
    if (view.gradePublished !== true) view.resultStatus = 'em_revisao';
    return withoutActors(stripSecrets(view));
}

function submissionsSection(memory, ownership, email, audience) {
    return list(memory.submissions)
        .filter(item => item.student && ownership.owns(item.student.email, item, 'renamed'))
        .map(item => {
            if (audience === 'aluno') return submissionForStudent(item, email);
            const copy = { ...item };
            EXAM_CONTENT_KEYS.forEach(key => { delete copy[key]; });
            return stripSecrets(copy);
        });
}

function ownedList(memory, collection, ownership, audience, field = 'studentEmail') {
    return list(memory[collection])
        .filter(item => ownership.owns(item[field], item, 'renamed'))
        .map(item => clean(item, audience));
}

function observationsSection(memory, ownership, audience) {
    return list(memory.pedagogicalObservations)
        .filter(item => ownership.owns(item.studentEmail, item, 'renamed'))
        .filter(item => audience === 'admin' || (item.visibility === SHARED_OBSERVATION_VISIBILITY && !SENSITIVE_OBSERVATION_CATEGORIES.has(item.category)))
        .map(item => clean(item, audience));
}

// Progresso, caderno e anotações: guardados por e-mail (todos os e-mails dele).
function byEmailSection(memory, collection, ownership, audience) {
    const map = isPlainObject(memory[collection]) ? memory[collection] : {};
    const out = {};
    ownership.emails.forEach(known => {
        if (!ownership.owns(known, null, 'renamed')) return;
        if (!Object.prototype.hasOwnProperty.call(map, known)) return;
        out[known] = clean(map[known], audience);
    });
    return out;
}

// Fórum: as dúvidas dele e as respostas que ele escreveu nas dúvidas dos outros (só a
// dele). Nas dúvidas dele, a resposta de outro aluno aparece só como "houve resposta de
// outro aluno", sem nome nem texto, nas duas versões: o arquivo pode ser entregue ao
// titular, e a resposta é dado do outro aluno. Na versão do aluno, a resposta da equipe
// fica com o texto, sem quem respondeu, e o histórico da dúvida (quem mexeu) fica de fora.
function forumSection(memory, ownership, audience) {
    const isStudentReply = reply => !!reply && (reply.authorRole === 'Aluno' || reply.role === 'Aluno');
    const ownsReply = reply => isStudentReply(reply) && ownership.owns(reply.authorEmail, reply, 'student');
    const questions = [];
    const replies = [];
    list(memory.forum).forEach(comment => {
        if (ownership.owns(comment.studentEmail, comment, 'renamed')) {
            const { replies: thread, events, ...question } = comment;
            const replyView = reply => {
                if (ownsReply(reply)) return audience === 'admin' ? { mine: true, ...stripSecrets(reply) } : { mine: true, text: reply.text || '', timestamp: reply.timestamp || null };
                if (isStudentReply(reply)) return { from: 'Outro aluno', text: '', timestamp: reply.timestamp || null };
                return audience === 'admin' ? { from: 'Equipe', ...stripSecrets(reply) } : { from: 'Equipe', text: reply.text || '', timestamp: reply.timestamp || null };
            };
            questions.push({
                ...clean(question, audience),
                replies: list(thread).map(replyView),
                ...(audience === 'admin' ? { events: stripSecrets(list(events)) } : {}),
            });
            return;
        }
        list(comment.replies).filter(ownsReply).forEach(reply => {
            replies.push({ questionId: comment.id || null, key: comment.key || null, text: reply.text || '', timestamp: reply.timestamp || null });
        });
    });
    return { questions, replies };
}

// Registros de acesso (login): só os da conta de aluno; o login de professor com o mesmo
// e-mail não é dele. O log de login não é renomeado na troca de e-mail: vale o dono do
// e-mail na data.
function loginLogsSection(memory, ownership, audience) {
    return list(memory.loginLogs)
        .filter(item => !item.role || item.role === 'student')
        .filter(item => ownership.owns(item.email, item, 'student'))
        .map(item => clean(item, audience));
}

// Contestações de questão, tempo extra e versão da prova de cada aplicação.
function examRecordsSection(memory, ownership, audience) {
    const out = [];
    list(memory.examApplications).forEach(application => {
        const reports = list(application.questionReports)
            .filter(report => ownership.owns(report.studentEmail, report, 'student'))
            .map(report => clean(report, audience));
        const pick = field => {
            const map = isPlainObject(application[field]) ? application[field] : {};
            const key = Object.keys(map).find(email => ownership.owns(email, null, 'renamed'));
            return key === undefined ? null : clean(map[key], audience);
        };
        const adjustment = pick('studentAdjustments');
        const version = pick('studentVersions');
        if (!reports.length && adjustment === null && version === null) return;
        out.push({
            applicationId: application.id || null,
            examKey: application.examKey || null,
            studentClass: application.studentClass || null,
            courseId: application.courseId || null,
            keystrokeMode: keystrokeModeOf(application),
            keystrokeModeLabel: KEYSTROKE_MODE_LABELS[keystrokeModeOf(application)],
            questionReports: reports,
            adjustment,
            assignedVersion: version,
        });
    });
    return out;
}

// Mensagens da prova mandadas só para ele. As listas de leitura (acknowledgedBy,
// deletedFor) têm e-mail de outros alunos: viram só se ele leu ou apagou a mensagem.
function examMessagesSection(memory, ownership, audience) {
    const mine = values => list(values).some(value => ownership.owns(value, null, 'renamed'));
    return list(memory.broadcastMessages)
        .filter(message => ownership.owns(message.targetEmail, message, 'renamed'))
        .map(message => {
            const { acknowledgedBy, deletedFor, ...rest } = message;
            return { ...clean(rest, audience), acknowledged: mine(acknowledgedBy), deletedByStudent: mine(deletedFor) };
        });
}

function keystrokesSection(rows, ownership, audience) {
    return list(rows)
        .filter(row => ownership.owns(row.studentEmail, { timestamp: row.serverTs }, 'renamed'))
        .map(row => clean(row, audience));
}

// Provas em andamento (só o administrador): o estado da tentativa sem os segredos dela.
function openAttemptsSection(memory, ownership) {
    const states = isPlainObject(memory.studentExamState) ? memory.studentExamState : {};
    return Object.keys(states)
        .filter(key => states[key] && ownership.owns(states[key].studentEmail, null, 'renamed'))
        .map(key => {
            // A chave da cópia local da tentativa é segredo da tentativa, não dado da pessoa.
            const { localCopyKey, ...state } = states[key];
            return { key, ...stripSecrets(state) };
        });
}

// ------------------------------------------------------------ auditoria
function ownedAuditEntries(memory, ownership) {
    return list(memory.auditLogs)
        .map(normalizeAuditEntry)
        .filter(Boolean)
        .filter(entry => ownership.owns(entry.studentEmail, entry, 'renamed')
            || ownership.owns(entry.targetEmail, entry, 'renamed')
            || (entry.actorRole === 'aluno' && ownership.owns(entry.actor, entry, 'anyone'))
            || (!entry.studentEmail && !entry.targetEmail && ownership.owns(entry.actor, entry, 'anyone')))
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

// Histórico das alterações do cadastro, para o aluno: quando, o quê, antes e depois. Sem
// quem alterou, IP nem aparelho.
function profileHistory(entries) {
    return entries
        .filter(entry => entry.category === 'student' && entry.field)
        .map(entry => ({
            timestamp: isoTime(entry.timestamp),
            label: entry.label,
            field: entry.field,
            oldValue: withoutActors(stripSecrets(entry.oldValue)),
            newValue: withoutActors(stripSecrets(entry.newValue)),
        }));
}

// ------------------------------------------------------------ montagem
function institutionOf(memory, student) {
    const school = legal.resolveSchool(memory, { courseId: studentCourseId(student) });
    const summary = legal.schoolSummary(school);
    const dpo = school ? legal.dpoOf(school) : null;
    return {
        id: summary ? summary.id : null,
        name: summary ? summary.name : '',
        dpo: dpo && (dpo.dpoName || dpo.dpoEmail || dpo.dpoPhone) ? { name: dpo.dpoName || '', email: dpo.dpoEmail || '', phone: dpo.dpoPhone || '' } : null,
    };
}

function sectionCounts(data) {
    const size = value => (Array.isArray(value) ? value.length : isPlainObject(value) ? Object.keys(value).length : 0);
    const out = {
        submissions: size(data.submissions),
        attendance: size(data.attendance),
        certificates: size(data.certificates),
        observations: size(data.observations),
        forumQuestions: size(data.forum.questions),
        forumReplies: size(data.forum.replies),
        moduleAccess: size(data.moduleAccess),
        loginLogs: size(data.loginLogs),
        proctoringLogs: size(data.proctoring.focusEvents),
        keystrokes: size(data.proctoring.keystrokes),
        examMessages: size(data.examMessages),
        profileHistory: size(data.profileHistory),
    };
    if (data.audit) out.audit = size(data.audit);
    if (data.openAttempts) out.openAttempts = size(data.openAttempts);
    return out;
}

// O arquivo de uma pessoa. Devolve null quando o aluno não existe.
// - audience: 'aluno' ou 'admin' (padrão 'aluno', a versão com menos dados);
// - keystrokes: teclas já buscadas (db.keystrokes.findByEmails(ownership.emails));
// - generatedBy: e-mail de quem exportou (só na versão do administrador).
function buildStudentDataExport(memory, email, { audience = 'aluno', keystrokes = [], now = Date.now(), generatedBy } = {}) {
    if (!AUDIENCES.includes(audience)) throw new TypeError('buildStudentDataExport: audience deve ser aluno ou admin.');
    const wanted = normalizeEmail(email);
    const student = findStudent(memory || {}, wanted);
    if (!student) return null;
    const ownership = studentEmailOwnership(memory, wanted);
    const auditEntries = ownedAuditEntries(memory, ownership);
    const data = {
        type: EXPORT_TYPE,
        formatVersion: EXPORT_FORMAT_VERSION,
        audience,
        generatedAt: new Date(now).toISOString(),
        notice: audience === 'admin' ? ADMIN_NOTICE : STUDENT_NOTICE,
        institution: institutionOf(memory, student),
        ...(audience === 'admin' ? { generatedBy: normalizeEmail(generatedBy) || null, knownEmails: ownership.emails, anonymized: isAnonymizedStudent(student) } : {}),
        profile: profileSection(student, audience),
        enrollments: enrollmentsSection(memory, student, audience),
        acceptances: acceptancesSection(student, audience),
        submissions: submissionsSection(memory, ownership, wanted, audience),
        attendance: ownedList(memory, 'attendance', ownership, audience),
        certificates: ownedList(memory, 'certificates', ownership, audience),
        observations: observationsSection(memory, ownership, audience),
        progress: byEmailSection(memory, 'progress', ownership, audience),
        notes: byEmailSection(memory, 'notes', ownership, audience),
        annotations: byEmailSection(memory, 'annotations', ownership, audience),
        forum: forumSection(memory, ownership, audience),
        moduleAccess: ownedList(memory, 'moduleAccess', ownership, audience),
        loginLogs: loginLogsSection(memory, ownership, audience),
        proctoring: {
            focusEvents: ownedList(memory, 'proctoringLogs', ownership, audience),
            keystrokes: keystrokesSection(keystrokes, ownership, audience),
        },
        examRecords: examRecordsSection(memory, ownership, audience),
        examMessages: examMessagesSection(memory, ownership, audience),
        profileHistory: profileHistory(auditEntries),
    };
    if (audience === 'admin') {
        data.openAttempts = openAttemptsSection(memory, ownership);
        data.audit = auditEntries.map(auditEntryWithoutSecrets);
    }
    data.counts = sectionCounts(data);
    return data;
}

// Nome do arquivo: meus-dados-AAAA-MM-DD.json (aluno) ou dados-<e-mail>-AAAA-MM-DD.json.
function exportFileName(audience, email, today) {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(today || '')) ? today : new Date().toISOString().slice(0, 10);
    if (audience !== 'admin') return `meus-dados-${day}.json`;
    const safe = normalizeEmail(email).replace(/[^a-z0-9._-]+/g, '_').slice(0, 80) || 'aluno';
    return `dados-${safe}-${day}.json`;
}

module.exports = {
    EXPORT_TYPE,
    EXPORT_FORMAT_VERSION,
    STUDENT_NOTICE,
    ADMIN_NOTICE,
    buildStudentDataExport,
    exportFileName,
    withoutActors,
};
