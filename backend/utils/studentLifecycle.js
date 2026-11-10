// Ciclo de vida do cadastro do aluno (H7c; FUN-03, CONF-09, decisão 4 do Alan).
//
// A escola guarda o histórico mesmo de quem saiu: o aluno é desligado primeiro (situação
// Inativo, Transferido, Evadido ou Concluído, pelo bulk-status, com quando, quem e por
// quê) e o cadastro encerrado aparece em Cadastros encerrados (/encerrados), onde o
// administrador decide caso a caso. Nada aqui roda sozinho: não existe tarefa por prazo.
//
// Dois modos, os dois só para cadastro encerrado e só pelo administrador:
// - 'anonymize' (POST /api/admin/students/anonymize): o aluno vira um pseudônimo
//   (e-mail 'anonimizado-<ref>@anonimizado.invalid', nome 'Aluno anonimizado <REF>',
//   situação 'Anonimizado', anonymizedRef/At/By). Ficam, com o pseudônimo, as notas, a
//   presença (sem justificativa escrita, arquivo, IP nem observação) e os certificados,
//   e a auditoria sem os dados pessoais. Sai o resto, como no apagar de vez. O e-mail
//   antigo fica livre para um cadastro novo. Nenhuma entrada liga o e-mail antigo ao
//   pseudônimo.
// - 'purge' (POST /api/admin/students/purge): a cascata de remoção de sempre (a que o
//   antigo delete-student fazia, que agora responde 410), com a auditoria anonimizada e
//   uma entrada student_purged sem dados pessoais.
//
// Quem é dono de cada registro segue studentEmailOwnership (gradebook.js): todos os
// e-mails conhecidos do aluno, cada um no período em que foi dele, por campo exato
// (anonimizar ana@ não toca joana@).
//
// Teclas da prova (tabela própria, db.keystrokes): a busca (findByEmails) vem antes, e
// a remoção (deleteRows), as mudanças na memória e o db.save() são pedidos no mesmo
// trecho síncrono, então entram no mesmo ciclo de gravação, numa transação só (antes, no
// delete-student, as teclas saíam numa segunda transação depois da resposta da memória).
// Como o aluno está encerrado, a sessão dele já não vale e nenhum lote novo de teclas
// entra durante a espera.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { recordAudit } = require('./audit.js');
const {
    ANONYMIZED_STATUS,
    isAnonymizedStudent,
    isClosedStudentStatus,
    lastStatusChangeIndex,
    normalizeEmail,
    studentClassEntries,
    studentStatusSince,
} = require('./students.js');
const {
    anonymizeStudentAuditTrail,
    anonymizeStudentExamRecords,
    studentEmailOwnership,
} = require('./gradebook.js');
const { revokeStudentSession } = require('./authSessions.js');
const fileStore = require('./storage.js');

const ANONYMIZE_WORD = 'ANONIMIZAR';
const PURGE_WORD = 'APAGAR';
const REASON_MIN = 3;
const REASON_MAX = 500;
const ANONYMIZED_EMAIL_DOMAIN = 'anonimizado.invalid';
const ANONYMIZED_NAME_PREFIX = 'Aluno anonimizado';

// Campos do cadastro que continuam no aluno anonimizado: só o que não identifica a
// pessoa (turmas, datas e a própria marca da anonimização). Tudo o mais sai, inclusive
// campo que versões futuras criarem (data de nascimento, responsável, aceites com IP).
const KEPT_STUDENT_FIELDS = ['classes', 'studentClass', 'courseId', 'period', 'createdAt'];
// Campos pessoais que a entrega online copiava do cadastro para a nota.
const PERSONAL_SUBMISSION_FIELDS = ['studentName', 'studentMatricula', 'matricula', 'nomeSocial', 'name', 'email'];

class StudentLifecycleError extends Error {
    constructor(status, message, { code, field } = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.field = field;
    }
}

function lifecycleBody(err) {
    const body = { success: false, error: err.message };
    if (err.code) body.code = err.code;
    if (err.field) body.field = err.field;
    return body;
}

// Confere o pedido de anonimizar ou apagar: e-mail, palavra digitada e motivo.
// Devolve { email, reason } ou lança StudentLifecycleError (400).
function validateLifecycleRequest(body, word) {
    const input = body && typeof body === 'object' ? body : {};
    if (typeof input.email !== 'string' || !input.email.trim()) {
        throw new StudentLifecycleError(400, 'Informe o e-mail do aluno.', { field: 'email' });
    }
    if (typeof input.confirm !== 'string' || input.confirm.trim().toUpperCase() !== word) {
        throw new StudentLifecycleError(400, `Digite ${word} para confirmar.`, { code: 'confirm_required', field: 'confirm' });
    }
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
        throw new StudentLifecycleError(400, `Informe o motivo (de ${REASON_MIN} a ${REASON_MAX} caracteres).`, { code: 'reason_required', field: 'reason' });
    }
    return { email: normalizeEmail(input.email), reason };
}

function findStudent(memory, email) {
    return (memory.students || []).find(student => student && normalizeEmail(student.email) === email) || null;
}

// O cadastro pode passar por este modo? (404, 409 se não está encerrado, ou 409 se já
// está anonimizado, no anonimizar.)
function assertEligible(student, mode) {
    if (!student) throw new StudentLifecycleError(404, 'Aluno não encontrado.', { code: 'student_not_found' });
    if (mode === 'anonymize' && isAnonymizedStudent(student)) {
        throw new StudentLifecycleError(409, 'Este cadastro já está anonimizado.', { code: 'already_anonymized' });
    }
    if (!isClosedStudentStatus(student.status) && !isAnonymizedStudent(student)) {
        throw new StudentLifecycleError(409, 'Desligue o aluno antes (situação Inativo, Transferido, Evadido ou Concluído). Só cadastro encerrado pode ser anonimizado ou apagado.', { code: 'student_not_closed' });
    }
}

function newPseudonym(memory) {
    for (;;) {
        const ref = crypto.randomBytes(6).toString('hex');
        const email = `anonimizado-${ref}@${ANONYMIZED_EMAIL_DOMAIN}`;
        if (!findStudent(memory, email)) {
            return { ref, email, name: `${ANONYMIZED_NAME_PREFIX} ${ref.slice(0, 6).toUpperCase()}` };
        }
    }
}

function actorEmail(actor) {
    return normalizeEmail(actor && typeof actor === 'object' ? actor.email : actor) || 'admin';
}

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Tira do texto livre o e-mail, o nome e a matrícula do aluno (palavra inteira, sem
// diferenciar maiúscula), no lugar do nome fica `replacement`.
function scrubReason(text, { emails = [], names = [], matriculas = [], replacement = 'aluno' } = {}) {
    let out = String(text || '');
    const edge = (value, to) => {
        out = out.replace(new RegExp(`(^|[^\\p{L}\\p{N}@._-])${escapeRegExp(value)}(?=$|[^\\p{L}\\p{N}@_-]|\\.(?![\\p{L}\\p{N}]))`, 'giu'), `$1${to}`);
    };
    emails.filter(Boolean).forEach(email => edge(email, replacement));
    names.map(name => String(name || '').trim()).filter(name => name.length >= 3)
        .sort((a, b) => b.length - a.length)
        .forEach(name => edge(name, replacement));
    matriculas.map(value => String(value || '').trim()).filter(value => value.length >= 3).forEach(value => edge(value, ''));
    return out.trim();
}

function countBy(list, predicate) {
    return (Array.isArray(list) ? list : []).reduce((sum, item) => sum + (predicate(item) ? 1 : 0), 0);
}

// Cadastro do aluno anonimizado: só o que não identifica a pessoa.
// A data do desligamento (closedSince) e quem desligou ficam: Cadastros encerrados e a
// chamada de datas antigas continuam contando a partir dela. Sem data conhecida (aluno
// desligado antes da atualização, sem a mudança na auditoria), fica sem data: a chamada
// não passa a mostrar o anonimizado nas datas anteriores à anonimização. O motivo do
// desligamento sai (texto livre, pode citar a pessoa).
function anonymizedStudentRecord(student, pseudonym, { actor, at, closedSince }) {
    const record = {};
    KEPT_STUDENT_FIELDS.forEach(field => {
        if (student[field] !== undefined) record[field] = student[field];
    });
    return {
        ...record,
        name: pseudonym.name,
        nomeSocial: '',
        email: pseudonym.email,
        matricula: '',
        phone: '',
        guardianPhone: '',
        guardian: null,
        accessibility: null,
        unidade: '',
        status: ANONYMIZED_STATUS,
        password: '',
        statusChangedAt: closedSince || null,
        statusChangedBy: closedSince ? (student.statusChangedBy || '') : '',
        statusReason: '',
        anonymizedRef: pseudonym.ref,
        anonymizedAt: at,
        anonymizedBy: actor,
        updatedAt: at,
    };
}

// Arquivos de justificativa de presença do aluno, para a lixeira quando a pasta dele é
// dividida com um homônimo sem matrícula.
function moveStudentFolderToTrash(memory, student, files, { deletedBy }) {
    try {
        const folder = fileStore.studentFolderName(student);
        const dir = path.join(fileStore.ALUNOS_DIR, folder);
        const shared = (memory.students || []).some(other => other !== student && fileStore.studentFolderName(other).toLowerCase() === folder.toLowerCase());
        if (!shared) {
            if (fs.existsSync(dir)) fileStore.moveDirToTrash(dir, { deletedBy });
            return;
        }
        const base = path.resolve(dir);
        [...new Set(files)].forEach(rel => {
            if (!fileStore.isInsideStudents(rel)) return;
            const target = path.resolve(fileStore.absFromData(rel));
            if (target.startsWith(base + path.sep) && fs.existsSync(target)) fileStore.moveToTrash(target, { deletedBy });
        });
    } catch (e) { /* a pasta é só cópia de documento: falha aqui não desfaz o resto */ }
}

// Presença guardada do aluno anonimizado: as aulas, a origem, a data e a justificativa
// só com o tipo e o abono. Saem o texto e o arquivo da justificativa, a observação, o IP
// e o aparelho do acesso automático.
function anonymizedAttendance(record, pseudoEmail) {
    const next = { ...record, studentEmail: pseudoEmail };
    delete next.ip;
    delete next.userAgent;
    delete next.observacao;
    if (next.justificativa && typeof next.justificativa === 'object') {
        next.justificativa = { tipo: next.justificativa.tipo || '', abonado: next.justificativa.abonado === true };
    }
    if (next.loginAccess && typeof next.loginAccess === 'object') {
        const access = { ...next.loginAccess };
        delete access.ip;
        next.loginAccess = access;
    }
    return next;
}

// Entrega/nota do aluno anonimizado: prova, nota, acertos e respostas ficam; o cadastro
// que a entrega online copiava (telefone, matrícula, responsável...) sai.
function anonymizedSubmission(submission, pseudonym) {
    const student = submission.student && typeof submission.student === 'object' ? submission.student : {};
    const next = { ...submission };
    PERSONAL_SUBMISSION_FIELDS.forEach(field => { delete next[field]; });
    if (next.studentEmail !== undefined) next.studentEmail = pseudonym.email;
    next.student = {
        name: pseudonym.name,
        email: pseudonym.email,
        studentClass: student.studentClass || '',
        courseId: student.courseId || null,
    };
    if (student.period) next.student.period = student.period;
    return next;
}

// Contagens para a tela e para a entrada da auditoria (sem dado pessoal).
function recordCounts(memory, owned) {
    return {
        submissions: countBy(memory.submissions, item => item && item.student && owned(item, item.student.email)),
        attendance: countBy(memory.attendance, item => item && owned(item, item.studentEmail)),
        certificates: countBy(memory.certificates, item => item && owned(item, item.studentEmail)),
    };
}

// Cascata única (os dois modos). Síncrona: chamada já com as teclas encontradas.
function applyCascade(db, { mode, student, ownership, keystrokeRows, actor, reason, req, at, closedSince }) {
    const memory = db.memory;
    const { emails, owns } = ownership;
    const anonymize = mode === 'anonymize';
    const atIso = new Date(at).toISOString();
    // Registro do aluno: e-mail dele na data do registro (sem data: o e-mail atual).
    // Nos campos que a troca de e-mail renomeia ('renamed'), o e-mail atual é sempre
    // dele, mesmo em registro com data da época em que o e-mail era de outro aluno.
    const ownedRecord = (item, value, kind = 'renamed') => !!item && owns(value, item, kind);
    const counts = recordCounts(memory, (item, value) => ownedRecord(item, value));
    const pseudonym = anonymize ? newPseudonym(memory) : null;
    const replacement = anonymize ? pseudonym.email : '';
    // O motivo digitado pode citar o aluno ("pedido da Ana Souza"): o nome, o e-mail e a
    // matrícula saem dele antes de ir para a auditoria.
    const cleanReason = scrubReason(reason, {
        emails,
        names: [student.name, student.nomeSocial],
        matriculas: [student.matricula],
        replacement: anonymize ? pseudonym.name : 'aluno',
    });

    const studentFiles = (memory.attendance || [])
        .filter(item => ownedRecord(item, item.studentEmail))
        .map(item => item.justificativa && item.justificativa.arquivo)
        .filter(Boolean);

    // Cadastro: anonimizado no lugar (mesma posição) ou fora da lista.
    const index = (memory.students || []).indexOf(student);
    if (anonymize) memory.students[index] = anonymizedStudentRecord(student, pseudonym, { actor, at, closedSince });
    else memory.students = memory.students.filter(item => item !== student);

    // Notas: com o pseudônimo, ou fora.
    if (anonymize) {
        memory.submissions = (memory.submissions || []).map(item => (item && item.student && ownedRecord(item, item.student.email) ? anonymizedSubmission(item, pseudonym) : item));
    } else {
        memory.submissions = (memory.submissions || []).filter(item => !(item && item.student && ownedRecord(item, item.student.email)));
    }

    emails.forEach(known => {
        if (!owns(known, null, 'renamed')) return;
        ['progress', 'notes', 'annotations'].forEach(collection => {
            if (memory[collection]) delete memory[collection][known];
        });
        // A sessão sai pelo authSessions (e da tabela auth_sessions na gravação).
        revokeStudentSession(memory, known);
    });

    // O log de auditoria é mantido como histórico, mas sem ligação com a pessoa: as
    // entradas perdem o e-mail, o nome e a matrícula e as cópias das notas na lixeira
    // ficam só com prova e nota. No anonimizar, as entradas do aluno ficam com o
    // pseudônimo (a ficha do aluno anonimizado mostra a trilha dele).
    anonymizeStudentAuditTrail(memory, {
        emails,
        owns,
        names: [student.name, student.nomeSocial],
        matriculas: [student.matricula],
        replacementEmail: replacement,
        replacementName: anonymize ? pseudonym.name : undefined,
    }, { at: atIso });
    // Contestações de questão (com o texto livre do aluno), tempo extra e versão da prova.
    anonymizeStudentExamRecords(memory, { emails, owns }, { at: atIso });
    // Decisão do encerramento da aplicação (tentativas descartadas): o e-mail sai ou vira
    // o pseudônimo.
    (memory.examApplications || []).forEach(application => {
        if (!application) return;
        [application.finishResolution, ...(Array.isArray(application.previousFinishResolutions) ? application.previousFinishResolutions : [])]
            .forEach(resolution => (resolution && Array.isArray(resolution.discardedAttempts) ? resolution.discardedAttempts : []).forEach(item => {
                if (item && owns(item.studentEmail, null, 'renamed')) item.studentEmail = replacement;
            }));
    });

    // Presença e certificados: ficam com o pseudônimo no anonimizar. O resto indexado pelo
    // e-mail (acessos aos módulos, observações, logs de prova e de login) sai nos dois.
    // Login de professor com o mesmo e-mail fica. O log de login não é renomeado na troca
    // de e-mail: vale o dono do e-mail na data.
    const loginKind = item => (item.role && item.role !== 'student' ? 'anyone' : 'student');
    if (anonymize) {
        memory.attendance = (memory.attendance || []).map(item => (ownedRecord(item, item && item.studentEmail) ? anonymizedAttendance(item, pseudonym.email) : item));
        memory.certificates = (memory.certificates || []).map(item => (ownedRecord(item, item && item.studentEmail) ? { ...item, studentEmail: pseudonym.email } : item));
    }
    const removed = anonymize
        ? ['moduleAccess', 'pedagogicalObservations', 'proctoringLogs', 'loginLogs']
        : ['attendance', 'moduleAccess', 'pedagogicalObservations', 'certificates', 'proctoringLogs', 'loginLogs'];
    removed.forEach(collection => {
        if (!Array.isArray(memory[collection])) return;
        memory[collection] = memory[collection].filter(item => !(item && ownedRecord(item, item.studentEmail || item.email,
            collection === 'loginLogs' ? loginKind(item) : 'renamed')));
    });

    // Fórum: as respostas dele saem; a dúvida dele sai inteira, a não ser que outra
    // pessoa tenha respondido: aí fica sem nome, e-mail e texto, com as respostas dos
    // outros. No histórico da dúvida fica "aluno excluído".
    const replyKind = item => (item && (item.authorRole === 'Aluno' || item.role === 'Aluno') ? 'student' : 'anyone');
    if (Array.isArray(memory.forum)) {
        memory.forum.forEach(comment => {
            if (!comment) return;
            if (Array.isArray(comment.replies)) comment.replies = comment.replies.filter(reply => !(reply && ownedRecord(reply, reply.authorEmail, replyKind(reply))));
            (Array.isArray(comment.events) ? comment.events : []).forEach(event => {
                if (event && ownedRecord({ at: event.at }, event.by, replyKind(event))) { event.by = 'aluno excluído'; event.byName = 'Aluno excluído'; }
            });
            if (comment.deletedBy && ownedRecord(comment, comment.deletedBy, 'anyone')) comment.deletedBy = 'aluno excluído';
        });
        memory.forum = memory.forum.filter(comment => {
            if (!comment || !ownedRecord(comment, comment.studentEmail)) return true;
            if (!(comment.replies || []).length) return false;
            comment.studentEmail = '';
            comment.studentName = 'Aluno excluído';
            comment.text = 'Texto removido (aluno excluído).';
            comment.studentAnonymized = true;
            comment.anonymizedAt = atIso;
            return true;
        });
    }
    // Mensagens da prova e avisos só para ele saem; nos outros, sai das listas de leitura.
    if (Array.isArray(memory.broadcastMessages)) {
        memory.broadcastMessages = memory.broadcastMessages.filter(message => !(message && ownedRecord(message, message.targetEmail)));
        memory.broadcastMessages.forEach(message => {
            ['acknowledgedBy', 'deletedFor'].forEach(field => {
                if (message && Array.isArray(message[field])) message[field] = message[field].filter(value => !owns(value, null, 'renamed'));
            });
        });
    }
    if (Array.isArray(memory.announcements)) {
        memory.announcements = memory.announcements.filter(item => !(item && item.target === 'aluno' && ownedRecord(item, item.targetValue)));
        memory.announcements.forEach(item => {
            if (item && Array.isArray(item.readBy)) item.readBy = item.readBy.filter(value => !owns(value, null, 'renamed'));
        });
    }
    Object.keys(memory.studentExamState || {}).forEach(key => {
        const state = memory.studentExamState[key];
        if (state && owns(state.studentEmail, null, 'renamed')) delete memory.studentExamState[key];
    });
    (memory.classes || []).forEach(cls => {
        Object.keys((cls && cls.studentReleasedItems) || {}).forEach(key => {
            if (owns(key, null, 'renamed')) delete cls.studentReleasedItems[key];
        });
    });

    // Pasta do aluno vai para a lixeira de arquivos. Homônimo sem matrícula usa a mesma
    // pasta (matrícula + nome): aí só os arquivos ligados à presença deste aluno vão.
    moveStudentFolderToTrash(memory, student, studentFiles, { deletedBy: actor });

    // Entrada da auditoria sem dado pessoal: no anonimizar, só o pseudônimo; no apagar,
    // nem isso (só as contagens e o motivo).
    if (anonymize) {
        recordAudit(memory, {
            req,
            actor,
            action: 'student_anonymized',
            category: 'student',
            studentEmail: pseudonym.email,
            reason: cleanReason,
            details: { ref: pseudonym.ref, kept: counts },
        }, { timestamp: at });
    } else {
        recordAudit(memory, {
            req,
            actor,
            action: 'student_purged',
            category: 'student',
            reason: cleanReason,
            details: { removed: counts, wasAnonymized: isAnonymizedStudent(student) },
        }, { timestamp: at });
    }

    // Teclas da prova: no mesmo ciclo de gravação da memória (ver o começo do arquivo).
    const keystrokeIds = (keystrokeRows || [])
        .filter(item => ownedRecord(item, item.studentEmail))
        .map(item => item.id);
    const keystrokesDone = keystrokeIds.length ? db.keystrokes.deleteRows(keystrokeIds) : Promise.resolve({ deleted: 0 });
    const saved = db.save();
    return { pseudonym, counts, keystrokes: keystrokeIds.length, completion: Promise.all([saved, keystrokesDone]) };
}

// Anonimiza (mode 'anonymize') ou apaga de vez (mode 'purge') o cadastro encerrado.
// db: o módulo database.js (memória, teclas e gravação). Lança StudentLifecycleError
// nas recusas previstas. Devolve, depois do COMMIT, { email?, name?, counts, keystrokes }.
async function runStudentLifecycle(db, { mode, email, actor, reason, req, now = Date.now } = {}) {
    if (mode !== 'anonymize' && mode !== 'purge') throw new TypeError('runStudentLifecycle: modo desconhecido.');
    const wanted = normalizeEmail(email);
    assertEligible(findStudent(db.memory, wanted), mode);
    // As teclas vêm do arquivo (assíncrono); durante a espera o cadastro pode ter mudado
    // (outra aba reativou, trocou o e-mail): tudo é conferido de novo depois.
    let ownership = studentEmailOwnership(db.memory, wanted);
    let keystrokeRows = await db.keystrokes.findByEmails(ownership.emails);
    const student = findStudent(db.memory, wanted);
    assertEligible(student, mode);
    const fresh = studentEmailOwnership(db.memory, wanted);
    if (fresh.emails.some(item => !ownership.emails.includes(item))) {
        keystrokeRows = await db.keystrokes.findByEmails(fresh.emails);
        assertEligible(findStudent(db.memory, wanted), mode);
    }
    ownership = studentEmailOwnership(db.memory, wanted);
    const current = findStudent(db.memory, wanted);
    const at = typeof now === 'function' ? now() : Number(now);
    const closedSince = studentStatusSince(current, lastStatusChangeIndex(db.memory.auditLogs));
    const result = applyCascade(db, {
        closedSince,
        mode,
        student: current,
        ownership,
        keystrokeRows,
        actor: actorEmail(actor),
        reason,
        req,
        at,
    });
    await result.completion;
    return {
        email: result.pseudonym ? result.pseudonym.email : undefined,
        name: result.pseudonym ? result.pseudonym.name : undefined,
        counts: result.counts,
        keystrokes: result.keystrokes,
        at,
    };
}

// Linhas de Cadastros encerrados: uma passada por coleção para as contagens.
// sinceOf(student) devolve a hora (ms) da mudança de situação ou null.
function closedStudentRows(memory, { sinceOf }) {
    const closed = (memory.students || []).filter(student => student && student.email && (isClosedStudentStatus(student.status) || isAnonymizedStudent(student)));
    const byEmail = new Map(closed.map(student => [normalizeEmail(student.email), { submissions: 0, attendance: 0, certificates: 0 }]));
    const bump = (email, field) => {
        const counts = byEmail.get(normalizeEmail(email));
        if (counts) counts[field] += 1;
    };
    (memory.submissions || []).forEach(item => { if (item && item.student) bump(item.student.email, 'submissions'); });
    (memory.attendance || []).forEach(item => { if (item) bump(item.studentEmail, 'attendance'); });
    (memory.certificates || []).forEach(item => { if (item) bump(item.studentEmail, 'certificates'); });
    return closed.map(student => {
        const anonymized = isAnonymizedStudent(student);
        return {
            email: student.email,
            name: student.name || '',
            nomeSocial: anonymized ? '' : (student.nomeSocial || ''),
            matricula: anonymized ? '' : (student.matricula || ''),
            status: anonymized ? ANONYMIZED_STATUS : (student.status || ''),
            since: sinceOf(student),
            by: student.statusChangedBy || null,
            reason: student.statusReason || '',
            classes: studentClassEntries(student).map(entry => ({ name: entry.name, courseId: entry.courseId })),
            anonymizedAt: student.anonymizedAt || null,
            anonymized,
            counts: byEmail.get(normalizeEmail(student.email)),
        };
    }).sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity) || a.name.localeCompare(b.name, 'pt-BR'));
}

module.exports = {
    ANONYMIZE_WORD,
    PURGE_WORD,
    REASON_MIN,
    REASON_MAX,
    ANONYMIZED_EMAIL_DOMAIN,
    StudentLifecycleError,
    lifecycleBody,
    validateLifecycleRequest,
    runStudentLifecycle,
    closedStudentRows,
    scrubReason,
};
