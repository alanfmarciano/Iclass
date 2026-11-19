// Para quem é a aplicação de prova (fase 3, P3-S7: AVA-09; D15, D16 e D17 do desenho do
// P3, contratos C2 e C7).
//
// Cada aplicação guarda, além do que já tinha:
// - finalidade: 'regular' (padrão; a aplicação antiga sem o campo é regular),
//   'segunda_chamada' ou 'recuperacao'. Como a segunda chamada e a recuperação entram na
//   média é regra do gradebook (P2, contrato C3 dele); aqui só se grava. A tela esconde
//   'Recuperação' até o gradebook tratar a finalidade (J2, D17).
// - participants: null (a turma inteira, como sempre foi) ou a lista dos e-mails
//   (minúsculos) de quem pode fazer. Quem não está na lista não vê a aplicação, não
//   recebe o sino, não abre tentativa e não conta como ausente no Monitor nem no
//   encerramento.
// - studentOverrides: { [email]: { extraAttempts 0..5, prazoAte ms|null, motivo, por, em } }:
//   tentativas a mais e prazo para começar de um aluno só, sem reabrir a prova para a
//   turma. O prazo só vale com o cronômetro por aluno ('per_attempt'). O "+N min" por
//   aluno continua o de antes (studentAdjustments).
//
// Quem pode fazer a aplicação sai SÓ de applicationParticipant (contrato C3 do P3), e o
// limite de tentativas de um aluno só de effectiveMaxAttempts. participants e
// studentOverrides são mapas por e-mail, como studentAdjustments: a troca de e-mail, o
// anonimizar, o apagar de vez e a mesclagem passam pelo handler registrado aqui
// (utils/studentDataHandlers.js, contrato C7).
const { normalizeMaxAttempts } = require('./examAttempts.js');
const { examFamilyKeys } = require('./examFamily.js');
const { dict, either, int, list, oneOf, shape, str } = require('./inputSchema.js');
const { registerStudentDataHandler } = require('./studentDataHandlers.js');
const { displayName, normalizeEmail, studentInClass } = require('./students.js');
const { compareText } = require('./textSearch.js');

const APPLICATION_PURPOSES = Object.freeze(['regular', 'segunda_chamada', 'recuperacao']);
const PURPOSE_LABELS = Object.freeze({
    regular: 'Aplicação regular',
    segunda_chamada: 'Segunda chamada',
    recuperacao: 'Recuperação',
});
const MAX_PARTICIPANTS = 500;
const MAX_EXTRA_ATTEMPTS = 5;
const OVERRIDE_REASON_MAX = 300;

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeFinalidade(value) {
    const text = String(value || '').trim();
    return APPLICATION_PURPOSES.includes(text) ? text : 'regular';
}

function applicationFinalidade(application) {
    return normalizeFinalidade(application && application.finalidade);
}

// Lista de quem pode fazer a aplicação (e-mails minúsculos) ou null para a turma inteira.
function applicationParticipantList(application) {
    const list = application && application.participants;
    if (!Array.isArray(list)) return null;
    return [...new Set(list.map(normalizeEmail).filter(Boolean))];
}

// O aluno pode fazer esta aplicação? Aplicação sem lista (antiga ou "turma inteira"):
// todo aluno da turma. A matrícula na turma continua conferida por quem chama.
function applicationParticipant(application, email) {
    if (!application) return false;
    const list = application.participants;
    if (!Array.isArray(list)) return true;
    const wanted = normalizeEmail(email);
    if (!wanted) return false;
    return list.some(item => normalizeEmail(item) === wanted);
}

function isRestrictedApplication(application) {
    return !!application && Array.isArray(application.participants);
}

function overridesMap(application) {
    return application && isPlainObject(application.studentOverrides) ? application.studentOverrides : {};
}

// Exceção do aluno na aplicação: { extraAttempts, prazoAte } normalizados, ou null.
function studentOverrideFor(application, email) {
    const wanted = normalizeEmail(email);
    if (!wanted) return null;
    const map = overridesMap(application);
    const key = Object.keys(map).find(item => normalizeEmail(item) === wanted);
    const raw = key === undefined ? null : map[key];
    if (!isPlainObject(raw)) return null;
    const extra = Number(raw.extraAttempts);
    const prazo = Number(raw.prazoAte);
    const override = {
        extraAttempts: Number.isInteger(extra) && extra > 0 ? Math.min(extra, MAX_EXTRA_ATTEMPTS) : 0,
        prazoAte: Number.isFinite(prazo) && prazo > 0 ? prazo : null,
    };
    return override.extraAttempts || override.prazoAte ? override : null;
}

// Tentativas a mais do aluno nesta aplicação (0 sem exceção).
function extraAttemptsFor(application, email) {
    const override = studentOverrideFor(application, email);
    return override ? override.extraAttempts : 0;
}

// Limite de tentativas do aluno nesta aplicação: o da aplicação (ou o da configuração
// da turma, para a aplicação antiga sem o campo) mais as tentativas extras dele. null
// continua sendo "sem limite".
function effectiveMaxAttempts(application, email, fallback) {
    const raw = application && application.maxAttempts !== undefined && application.maxAttempts !== null
        ? application.maxAttempts
        : fallback;
    const base = normalizeMaxAttempts(raw);
    if (base === null) return null;
    return base + extraAttemptsFor(application, email);
}

// Prazo do aluno para começar uma tentativa nova, quando já passou (ms), ou null. Só no
// cronômetro por aluno: no coletivo a prova começa para todos ao mesmo tempo.
function studentStartDeadlinePassed(application, email, now = Date.now()) {
    if (!application || application.timerMode !== 'per_attempt') return null;
    const override = studentOverrideFor(application, email);
    if (!override || !override.prazoAte) return null;
    return override.prazoAte <= now ? override.prazoAte : null;
}

// "20/11 às 08:00" no relógio da escola (schoolTime carrega as configurações, que
// carregam o banco: require na hora, sem ciclo com database.js).
function formatSchoolDateTime(ms) {
    const { localParts } = require('./schoolTime.js');
    const parts = localParts(ms);
    if (!parts) return '';
    return `${String(parts.day).padStart(2, '0')}/${String(parts.month).padStart(2, '0')} às ${parts.time}`;
}

// Prazo do aluno para começar, para as telas dele (lista de provas e instruções):
// { startDeadlineAt, startDeadlineLabel } com o horário no relógio da escola ("20/11 às
// 08:00"), ou nulos sem exceção com prazo ou fora do cronômetro por aluno.
function studentStartDeadlineInfo(application, email) {
    const override = application && application.timerMode === 'per_attempt' ? studentOverrideFor(application, email) : null;
    const at = override && override.prazoAte ? override.prazoAte : null;
    return { startDeadlineAt: at, startDeadlineLabel: at ? formatSchoolDateTime(at) || null : null };
}

function notParticipantMessage(application) {
    return applicationFinalidade(application) === 'segunda_chamada'
        ? 'Esta é a segunda chamada da prova, só para os alunos indicados pelo professor.'
        : 'Esta aplicação da prova é só para os alunos indicados pelo professor.';
}

// Corpo do 403 de quem não está na lista.
function notParticipantResponse(application) {
    return { error: notParticipantMessage(application), code: 'not_participant', notParticipant: true };
}

// Corpo do 409 de quem passou do prazo para começar.
function startDeadlineResponse(prazoAte) {
    const when = formatSchoolDateTime(prazoAte);
    return {
        error: when
            ? `O seu prazo para começar esta prova terminou em ${when}. Procure o professor.`
            : 'O seu prazo para começar esta prova terminou. Procure o professor.',
        code: 'start_deadline_passed',
        startDeadlinePassed: true,
        prazoAte,
    };
}

function activeStudent(student) {
    const status = String((student && student.status) || '').trim().toLowerCase();
    return !status || status === 'ativo' || status === 'active';
}

// Alunos da turma (matriculados e ativos), em ordem de nome.
function classStudents(memory, { studentClass, courseId } = {}) {
    return ((memory && memory.students) || [])
        .filter(student => student && student.email && activeStudent(student) && studentInClass(student, studentClass, courseId))
        .sort((a, b) => compareText(displayName(a) || a.email, displayName(b) || b.email));
}

function submissionEmail(submission) {
    return normalizeEmail((submission && submission.student && submission.student.email) || (submission && submission.studentEmail));
}

// Entrega que conta como feita: nem arquivada, nem anulada, nem desconsiderada.
function consideredSubmission(submission) {
    if (!submission) return false;
    if (submission.resultStatus === 'archived' || submission.archived === true) return false;
    if (submission.resultStatus === 'invalidated') return false;
    if (submission.integrity && submission.integrity.decisao === 'desconsiderar' && !submission.integrity.desfeitaEm) return false;
    return true;
}

// Quem já fez a prova numa aplicação regular (ou pela interface antiga, sem aplicação)
// desta turma: o conjunto dos e-mails. Vale a família da prova (utils/examFamily.js): a
// prova do curso e a variante "só desta turma" criada ao editar a prova para a turma
// (Avaliacao_X__turma_<hash>) são a mesma prova. Sem isso, quem fez a regular na chave do
// curso voltava marcado na segunda chamada da variante, sem "Já fez".
function emailsWithRegularDelivery(memory, { studentClass, courseId, examKey, excludeApplicationId = null } = {}) {
    const className = String(studentClass || '').trim().toLowerCase();
    const course = String(courseId || '').trim();
    const family = examFamilyKeys(memory, examKey);
    const inFamily = key => family.has(String(key || '').trim());
    const regular = new Set(((memory && memory.examApplications) || [])
        .filter(application => application
            && application.id !== excludeApplicationId
            && inFamily(application.examKey)
            && String(application.studentClass || '').trim().toLowerCase() === className
            && (!application.courseId || !course || String(application.courseId) === course)
            && applicationFinalidade(application) === 'regular')
        .map(application => application.id));
    const done = new Set();
    ((memory && memory.submissions) || []).forEach(submission => {
        if (!submission || !inFamily(submission.examKey) || !consideredSubmission(submission)) return;
        if (submission.applicationId) {
            if (!regular.has(submission.applicationId)) return;
        } else {
            // Entrega da interface antiga: pela turma e pelo curso gravados nela.
            const subClass = String((submission.student && submission.student.studentClass) || submission.studentClass || '').trim().toLowerCase();
            const subCourse = String((submission.student && submission.student.courseId) || submission.courseId || '').trim();
            if (subClass && subClass !== className) return;
            if (subCourse && course && subCourse !== course) return;
        }
        const email = submissionEmail(submission);
        if (email) done.add(email);
    });
    return done;
}

// Alunos da turma para o "Para quem": cada um com fezRegular (já tem entrega que conta
// numa aplicação regular da prova). A segunda chamada pré-marca quem não fez.
function participantCandidates(memory, scope = {}) {
    const done = emailsWithRegularDelivery(memory, scope);
    return classStudents(memory, scope).map(student => {
        const email = normalizeEmail(student.email);
        return { email, name: displayName(student) || student.email, fezRegular: done.has(email) };
    });
}

function secondCallEmails(memory, scope = {}) {
    return participantCandidates(memory, scope).filter(item => !item.fezRegular).map(item => item.email);
}

// ------------------------------------------------------------ entrada do professor
// Tipo e tamanho dos campos do "Para quem" (utils/inputSchema.js): no corpo da rota de
// participantes e dentro de applicationOptions na preparação. As regras de negócio (aluno
// da turma, prazo no futuro, só acrescentar em andamento) ficam em parseApplicationAudience.
const OVERRIDE_INPUT = shape({
    extraAttempts: int({ min: 0, max: MAX_EXTRA_ATTEMPTS, coerce: true, nullable: true, label: 'tentativas extras' }),
    prazoAte: either([int({ min: 1, label: 'prazo para começar' }), str({ max: 20, label: 'prazo para começar' })], { nullable: true, label: 'prazo para começar' }),
    prazoAteLocal: str({ max: 20, nullable: true, label: 'prazo para começar' }),
    motivo: str({ max: OVERRIDE_REASON_MAX, nullable: true, label: 'motivo da exceção' }),
}, { nullable: true, label: 'exceção do aluno' });

// E-mail do aluno na lista: até 254 caracteres, sem espaço, vírgula, ponto e vírgula nem
// <> (nome colado junto, duas listas numa só). Não exige o formato completo nome@dominio:
// cadastro antigo pode ter um e-mail fora do formato e ainda é aluno da turma; quem não é
// aluno ativo da turma é recusado pela regra de negócio.
const STUDENT_EMAIL_PATTERN = /^[^\s,;<>]+$/u;
const emailField = (label = 'aluno') => str({ max: 254, pattern: STUDENT_EMAIL_PATTERN, label });

const AUDIENCE_INPUT_FIELDS = Object.freeze({
    finalidade: oneOf(APPLICATION_PURPOSES, { nullable: true, label: 'finalidade' }),
    participants: list(emailField(), { max: MAX_PARTICIPANTS, nullable: true, label: 'alunos' }),
    studentOverrides: dict(OVERRIDE_INPUT, { maxKeys: MAX_PARTICIPANTS, keyMax: 254, nullable: true, label: 'exceções por aluno' }),
});

function fail(error, field) {
    return { ok: false, error, field };
}

// Instante do prazo: número (ms) ou 'AAAA-MM-DDTHH:MM' no relógio da escola.
function parseDeadline(raw) {
    if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
    if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? { ok: true, value: Math.round(raw) } : { ok: false };
    if (typeof raw !== 'string') return { ok: false };
    const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})$/.exec(raw.trim());
    if (!match) return { ok: false };
    const { deadlineFromLocal } = require('./schoolTime.js');
    const value = deadlineFromLocal(match[1], match[2]);
    return value === null ? { ok: false } : { ok: true, value };
}

// Confere e normaliza o "Para quem" e as exceções que o professor mandou (preparar a
// aplicação ou a rota de participantes). input: { finalidade?, participants?,
// studentOverrides? } (ausente = mantém o que a aplicação tem; na preparação, o padrão).
// Devolve { ok: true, value: { finalidade, participants, studentOverrides } } ou
// { ok: false, error, field }. Regras:
// - participants: null (turma inteira) ou lista de 1 a 500 e-mails de alunos ativos da
//   turma; com a aplicação em andamento, só dá para acrescentar;
// - segunda chamada sem lista: a lista é a de quem não fez (vazia é recusada);
// - exceções só para alunos da turma (e da lista, quando há lista): tentativas extras de
//   0 a 5 e prazo para começar (só com o cronômetro por aluno, no futuro quando muda);
//   extraAttempts 0 sem prazo (ou null) tira a exceção; aluno que não veio no pedido
//   mantém a dele (mescla). Mantém por/em da exceção que não mudou.
function parseApplicationAudience(memory, input = {}, {
    cls,
    examKey,
    application = null,
    timerMode = application ? application.timerMode : 'collective',
    actor = null,
    now = Date.now(),
} = {}) {
    if (!cls) return fail('Turma da aplicação não encontrada.');
    const source = isPlainObject(input) ? input : {};
    const scope = { studentClass: cls.name, courseId: cls.courseId, examKey, excludeApplicationId: application ? application.id : null };
    const students = classStudents(memory, scope);
    const studentEmails = new Set(students.map(student => normalizeEmail(student.email)));

    let finalidade = application ? applicationFinalidade(application) : 'regular';
    if (source.finalidade !== undefined && source.finalidade !== null && source.finalidade !== '') {
        if (!APPLICATION_PURPOSES.includes(String(source.finalidade))) return fail('Finalidade da aplicação inválida.', 'finalidade');
        const requested = String(source.finalidade);
        if (application && requested !== finalidade && !['draft', 'prepared'].includes(application.status)) {
            return fail('A finalidade da aplicação só muda antes de a prova começar.', 'finalidade');
        }
        finalidade = requested;
    }

    const previousList = application ? applicationParticipantList(application) : null;
    let participants = previousList;
    if (source.participants !== undefined) {
        if (source.participants === null) {
            participants = null;
        } else if (!Array.isArray(source.participants)) {
            return fail('A lista de alunos está em formato inválido.', 'participants');
        } else {
            if (source.participants.length > MAX_PARTICIPANTS) return fail(`A lista aceita no máximo ${MAX_PARTICIPANTS} alunos.`, 'participants');
            if (source.participants.some(item => typeof item !== 'string')) return fail('A lista de alunos está em formato inválido.', 'participants');
            participants = [...new Set(source.participants.map(normalizeEmail).filter(Boolean))];
        }
    }
    // Segunda chamada sem lista: a lista é a de quem ainda não fez a prova.
    if (finalidade === 'segunda_chamada' && participants === null) {
        participants = secondCallEmails(memory, scope);
        if (!participants.length) return fail('Todos os alunos da turma já fizeram esta prova. Escolha quem faz a segunda chamada.', 'participants');
    }
    if (Array.isArray(participants)) {
        if (!participants.length) return fail('Escolha pelo menos um aluno para esta aplicação.', 'participants');
        const outside = participants.filter(email => !studentEmails.has(email) && !(previousList || []).includes(email));
        if (outside.length) {
            return fail(outside.length === 1
                ? `${outside[0]} não é aluno ativo desta turma.`
                : `${outside.length} e-mails da lista não são de alunos ativos desta turma (${outside.slice(0, 3).join(', ')}${outside.length > 3 ? '...' : ''}).`, 'participants');
        }
    }
    // Em andamento (ou já aberta para os alunos), a lista só cresce: quem já podia entrar
    // pode ter começado.
    if (application && ['waiting', 'running', 'paused'].includes(application.status)) {
        const removed = previousList === null
            ? (participants === null ? [] : [...studentEmails].filter(email => !participants.includes(email)))
            : previousList.filter(email => participants !== null && !participants.includes(email));
        if (removed.length) return fail('Com a prova em andamento só dá para acrescentar alunos à lista, não tirar.', 'participants');
    }

    const previousOverrides = overridesMap(application);
    let studentOverrides = application ? { ...previousOverrides } : {};
    if (source.studentOverrides !== undefined && source.studentOverrides !== null) {
        if (!isPlainObject(source.studentOverrides)) return fail('As exceções por aluno estão em formato inválido.', 'studentOverrides');
        const keys = Object.keys(source.studentOverrides);
        if (keys.length > MAX_PARTICIPANTS) return fail(`No máximo ${MAX_PARTICIPANTS} exceções por aplicação.`, 'studentOverrides');
        // Mescla: aluno que não veio no pedido mantém a exceção que tinha; null (ou 0
        // tentativas e sem prazo) retira.
        const next = {};
        Object.entries(studentOverrides).forEach(([key, value]) => {
            const email = normalizeEmail(key);
            if (email && isPlainObject(value)) next[email] = value;
        });
        for (const rawKey of keys) {
            const email = normalizeEmail(rawKey);
            const field = `studentOverrides.${rawKey}`;
            if (!email || ['__proto__', 'constructor', 'prototype'].includes(rawKey)) return fail('As exceções por aluno estão em formato inválido.', field);
            const entry = source.studentOverrides[rawKey];
            delete next[email];
            if (entry === null) continue;
            if (!isPlainObject(entry)) return fail('As exceções por aluno estão em formato inválido.', field);
            const previousKey = Object.keys(previousOverrides).find(key => normalizeEmail(key) === email);
            const previous = previousKey === undefined ? null : previousOverrides[previousKey];
            if (!studentEmails.has(email) && !previous) return fail(`${email} não é aluno ativo desta turma.`, field);
            if (Array.isArray(participants) && !participants.includes(email)) return fail(`${email} não está na lista desta aplicação.`, field);
            const extraRaw = entry.extraAttempts === undefined || entry.extraAttempts === null || entry.extraAttempts === '' ? 0 : Number(entry.extraAttempts);
            if (!Number.isInteger(extraRaw) || extraRaw < 0 || extraRaw > MAX_EXTRA_ATTEMPTS) {
                return fail(`Tentativas extras deve ser um número inteiro de 0 a ${MAX_EXTRA_ATTEMPTS}.`, `${field}.extraAttempts`);
            }
            const deadline = parseDeadline(entry.prazoAteLocal !== undefined ? entry.prazoAteLocal : entry.prazoAte);
            if (!deadline.ok) return fail('O prazo para começar está em formato inválido (use data e hora).', `${field}.prazoAte`);
            const previousDeadline = previous && Number(previous.prazoAte) > 0 ? Number(previous.prazoAte) : null;
            if (deadline.value !== null) {
                if (timerMode !== 'per_attempt') return fail('O prazo por aluno só vale quando o cronômetro começa quando cada aluno iniciar.', `${field}.prazoAte`);
                if (deadline.value !== previousDeadline && deadline.value <= now) return fail('O prazo para começar precisa ser depois de agora.', `${field}.prazoAte`);
            }
            const motivoRaw = entry.motivo === undefined || entry.motivo === null ? (previous && previous.motivo) || '' : entry.motivo;
            if (typeof motivoRaw !== 'string') return fail('O motivo da exceção está em formato inválido.', `${field}.motivo`);
            const motivo = motivoRaw.trim();
            if (motivo.length > OVERRIDE_REASON_MAX) return fail(`O motivo da exceção aceita no máximo ${OVERRIDE_REASON_MAX} caracteres.`, `${field}.motivo`);
            if (!extraRaw && deadline.value === null) continue;
            const unchanged = previous
                && Number(previous.extraAttempts || 0) === extraRaw
                && previousDeadline === deadline.value
                && String(previous.motivo || '') === motivo;
            next[email] = unchanged
                ? { ...previous, extraAttempts: extraRaw, prazoAte: deadline.value, motivo }
                : { extraAttempts: extraRaw, prazoAte: deadline.value, motivo, por: actor || null, em: now };
        }
        studentOverrides = next;
    }
    if (Array.isArray(participants)) {
        // Exceção de quem saiu da lista não vale mais.
        studentOverrides = Object.fromEntries(Object.entries(studentOverrides).filter(([email]) => participants.includes(normalizeEmail(email))));
    }
    return { ok: true, value: { finalidade, participants, studentOverrides } };
}

// O que mudou nas exceções (para a auditoria, um registro por aluno): [{ email, antes, depois }].
function changedOverrides(before = {}, after = {}) {
    const emails = new Set([...Object.keys(before || {}), ...Object.keys(after || {})].map(normalizeEmail).filter(Boolean));
    const pick = (map, email) => {
        const key = Object.keys(map || {}).find(item => normalizeEmail(item) === email);
        const value = key === undefined ? null : map[key];
        return value ? { extraAttempts: Number(value.extraAttempts) || 0, prazoAte: Number(value.prazoAte) > 0 ? Number(value.prazoAte) : null, motivo: String(value.motivo || '') } : null;
    };
    const out = [];
    emails.forEach(email => {
        const antes = pick(before, email);
        const depois = pick(after, email);
        if (JSON.stringify(antes) !== JSON.stringify(depois)) out.push({ email, antes, depois });
    });
    return out;
}

// Título e detalhe das linhas do registro da aplicação (Resultados > aplicação) para os
// eventos daqui. Ficam fora de gradebook.js até a J2 (o arquivo é da trilha B).
function describeAudienceAudit(entry, nameByEmail = new Map()) {
    const details = (entry && entry.details) || {};
    if (!entry) return null;
    if (entry.type === 'exam_application_participants_set') {
        const purpose = PURPOSE_LABELS[normalizeFinalidade(details.finalidade)];
        const who = details.quantidade === null || details.quantidade === undefined
            ? 'turma inteira'
            : `${details.quantidade} ${Number(details.quantidade) === 1 ? 'aluno' : 'alunos'}`;
        return { title: 'Participantes da aplicação definidos', detail: `${purpose} · ${who}` };
    }
    if (entry.type === 'exam_attempt_extra_granted') {
        const email = normalizeEmail(entry.studentEmail || details.studentEmail);
        const name = nameByEmail.get(email) || (entry.studentAnonymized ? 'Aluno anonimizado' : email || 'aluno');
        const parts = [];
        const extra = Number(details.extraAttempts) || 0;
        if (extra) parts.push(`${extra} ${extra === 1 ? 'tentativa extra' : 'tentativas extras'}`);
        if (Number(details.prazoAte) > 0) parts.push(`pode começar até ${formatSchoolDateTime(Number(details.prazoAte))}`);
        if (!parts.length) parts.push('exceção retirada');
        if (details.motivo) parts.push(`motivo: ${details.motivo}`);
        return { title: `Exceção para ${name}`, detail: parts.join(' · ') };
    }
    return null;
}

// ------------------------------------------------------------ ciclo de vida do aluno
function forEachApplication(memory, fn) {
    ((memory && memory.examApplications) || []).forEach(application => {
        if (application && typeof application === 'object') fn(application);
    });
}

function renameInApplication(application, from, to) {
    if (Array.isArray(application.participants)) {
        const next = [];
        application.participants.forEach(item => {
            const email = normalizeEmail(item) === from ? to : item;
            if (!next.some(value => normalizeEmail(value) === normalizeEmail(email))) next.push(email);
        });
        application.participants = next;
    }
    const map = application.studentOverrides;
    if (isPlainObject(map)) {
        Object.keys(map).forEach(key => {
            if (normalizeEmail(key) !== from) return;
            if (!Object.prototype.hasOwnProperty.call(map, to)) map[to] = map[key];
            delete map[key];
        });
    }
}

// Tira o aluno da lista e as exceções dele (anonimizar e apagar de vez): os mapas por
// e-mail não têm mais a quem se aplicar, como o "+N min" e a versão (gradebook.js).
function removeStudentFromApplications(memory, aluno) {
    const isHis = email => aluno.owns(email, null, 'renamed');
    forEachApplication(memory, application => {
        if (Array.isArray(application.participants)) {
            application.participants = application.participants.filter(email => !isHis(email));
        }
        const map = application.studentOverrides;
        if (isPlainObject(map)) Object.keys(map).forEach(key => { if (isHis(key)) delete map[key]; });
    });
}

registerStudentDataHandler({
    collection: 'examParticipation',
    label: 'Participação e exceções em provas',
    rename(memory, de, para) {
        forEachApplication(memory, application => renameInApplication(application, de, para));
    },
    anonymize(memory, aluno) {
        removeStudentFromApplications(memory, aluno);
    },
    purge(memory, aluno) {
        removeStudentFromApplications(memory, aluno);
    },
    // Mesclar: o que era do 'sai' passa para o 'fica'; a exceção do 'fica' vale quando os
    // dois têm.
    merge(memory, fica, sai) {
        const target = normalizeEmail(fica && fica.email);
        if (!target) return;
        const isSai = email => sai.owns(email, null, 'renamed');
        forEachApplication(memory, application => {
            if (Array.isArray(application.participants)) {
                const next = [];
                application.participants.forEach(item => {
                    const email = isSai(item) ? target : item;
                    if (!next.some(value => normalizeEmail(value) === normalizeEmail(email))) next.push(email);
                });
                application.participants = next;
            }
            const map = application.studentOverrides;
            if (isPlainObject(map)) {
                Object.keys(map).forEach(key => {
                    if (!isSai(key) || normalizeEmail(key) === target) return;
                    if (!Object.keys(map).some(other => normalizeEmail(other) === target)) map[target] = map[key];
                    delete map[key];
                });
            }
        });
    },
    // Meus dados: as aplicações em que o aluno estava numa lista escolhida e as exceções
    // dele. O administrador vê também quem concedeu e quando.
    exportSection(memory, aluno, audience) {
        const isHis = email => aluno.owns(email, null, 'renamed');
        const rows = [];
        forEachApplication(memory, application => {
            const listed = Array.isArray(application.participants) && application.participants.some(isHis);
            const map = overridesMap(application);
            const key = Object.keys(map).find(isHis);
            const override = key === undefined ? null : map[key];
            if (!listed && !override) return;
            const evaluation = memory && memory.evaluations && memory.evaluations[application.examKey];
            const row = {
                applicationId: application.id || null,
                examKey: application.examKey || null,
                examTitle: (evaluation && (evaluation.title || evaluation.name)) || application.examKey || '',
                studentClass: application.studentClass || null,
                finalidade: applicationFinalidade(application),
                finalidadeLabel: PURPOSE_LABELS[applicationFinalidade(application)],
                naLista: listed,
                extraAttempts: override ? Number(override.extraAttempts) || 0 : 0,
                prazoAte: override && Number(override.prazoAte) > 0 ? Number(override.prazoAte) : null,
                motivo: override ? String(override.motivo || '') : '',
            };
            if (audience === 'admin' && override) {
                row.concedidaPor = override.por || null;
                row.concedidaEm = override.em || null;
            }
            rows.push(row);
        });
        return rows.length ? rows : undefined;
    },
    printColumns: [
        { field: 'examTitle', label: 'Prova', format: 'text' },
        { field: 'finalidadeLabel', label: 'Aplicação', format: 'text' },
        { field: 'extraAttempts', label: 'Tentativas extras', format: 'count' },
        { field: 'prazoAte', label: 'Pode começar até', format: 'datetime' },
        { field: 'motivo', label: 'Motivo', format: 'text' },
    ],
});

module.exports = {
    APPLICATION_PURPOSES,
    AUDIENCE_INPUT_FIELDS,
    MAX_EXTRA_ATTEMPTS,
    MAX_PARTICIPANTS,
    PURPOSE_LABELS,
    applicationFinalidade,
    applicationParticipant,
    applicationParticipantList,
    changedOverrides,
    consideredSubmission,
    describeAudienceAudit,
    effectiveMaxAttempts,
    emailsWithRegularDelivery,
    extraAttemptsFor,
    formatSchoolDateTime,
    isRestrictedApplication,
    normalizeFinalidade,
    notParticipantResponse,
    parseApplicationAudience,
    participantCandidates,
    secondCallEmails,
    startDeadlineResponse,
    studentOverrideFor,
    studentStartDeadlineInfo,
    studentStartDeadlinePassed,
};
