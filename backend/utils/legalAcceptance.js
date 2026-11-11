// Primeiro acesso do aluno (H8a-2; SEG-08, OPS-12, SEG-09, decisão P4 do Alan).
//
// Aceite com documentId: o aluno aceita um documento exato (utils/legalDocuments.js), e
// não mais a "versão 1.0" fixa. termsAcceptance e privacyAcceptance gravam
//   { documentId, version, schoolId, at, ip, device }
// documentId é o id da versão publicada ('termos_v2') ou, antes de qualquer publicação,
// o do modelo ('modelo-2026.1:termos', version null). O aceite anterior vai para o fim de
// student.legalAcceptances ({ kind, ...aceite, replacedAt }) antes de ser trocado.
//
// Quando vale (regra única):
// - um aceite vale se acceptance.documentId === id do documento publicado atual;
// - sem nenhuma publicação, ninguém fica pendente: o modelo não é aceite exigível;
// - o aceite antigo { version: '1.0' } nunca vale para um documento publicado, e toda
//   publicação nova pede aceite novo.
//
// Data de nascimento e responsável (política 'ciência', a única desta fase; o modo
// 'consentimento', que bloqueia o login, ficou adiado): a data é pedida a todos no
// próximo acesso ao portal; para menor de 18 anos, o nome do responsável (3 letras ou
// mais) e um telefone ou e-mail dele. Nada disso bloqueia o login: o portão
// (web/src/features/student/StudentPrivacyGate.jsx) pede o que falta no lugar da página.
// O servidor não recusa as outras rotas por causa de pendência; a prova
// (StudentExamShell) nunca passa pelo portão.
//
// TEST_MODE=1 (testes e modo demonstração): o portão não é exigido (required: false), como
// a troca obrigatória de senha (utils/passwordChange.js). O status continua dizendo o que
// falta e o aceite continua funcionando.

const legal = require('./legalDocuments.js');
const { getClientIp, parseUserAgent } = require('./security.js');
const { checkBirthDate, hasValidBirthDate, isMinorBirthDate, todayIso } = require('./birthDate.js');
const { normalizeEmail, isValidEmail, isValidPhone, studentClassEntries } = require('./students.js');

const MINORS_POLICY = 'ciencia';
const LEGAL_ACCEPTANCES_MAX = 50;
const GUARDIAN_NAME_MIN = 3;
const GUARDIAN_LIMITS = Object.freeze({ name: 120, phone: 40, email: 254, parentesco: 60 });
const ACCEPTANCE_FIELDS = Object.freeze({ termos: 'termsAcceptance', privacidade: 'privacyAcceptance' });
const BODY_FIELDS = Object.freeze({ termos: 'termsDocumentId', privacidade: 'privacyDocumentId' });

const DOCUMENTS_CHANGED_MESSAGE = 'Os documentos foram atualizados. Leia a nova versão e marque o aceite de novo.';
const MINOR_GUARDIAN_MESSAGE = 'Para menores de 18 anos, informe o nome e um telefone ou e-mail do responsável.';

class PrivacyAcceptError extends Error {
    constructor(status, message, { field, code } = {}) {
        super(message);
        this.status = status;
        this.field = field;
        this.code = code;
    }
}

function privacyErrorBody(err) {
    const body = { success: false, error: err.message };
    if (err.field) body.field = err.field;
    if (err.code) body.code = err.code;
    return body;
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

// O portão vale agora? Com TEST_MODE (demonstração e testes), não.
function privacyGateActive() {
    return process.env.TEST_MODE !== '1';
}

// ------------------------------------------------------------ escola do aluno
// Curso do aluno para escolher a escola dos marcadores: o pedido (?courseId=, a turma
// aberta no portal), senão o da primeira matrícula com curso, senão o do pedido de
// matrícula mais recente (autocadastro ainda sem turma).
function studentCourseId(student, wanted) {
    const entries = studentClassEntries(student).filter(entry => entry.courseId);
    const asked = typeof wanted === 'string' ? wanted.trim() : '';
    if (asked && entries.some(entry => entry.courseId === asked)) return asked;
    if (entries.length) return entries[0].courseId;
    const requests = Array.isArray(student && student.enrollmentRequests) ? student.enrollmentRequests : [];
    const last = requests.filter(item => item && item.courseId).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))[0];
    return last ? String(last.courseId) : '';
}

function schoolFor(memory, student, courseId) {
    return legal.resolveSchool(memory, { courseId: studentCourseId(student, courseId) });
}

// ------------------------------------------------------------ aceites
function acceptanceMatches(acceptance, doc) {
    return isPlainObject(acceptance) && typeof acceptance.documentId === 'string' && acceptance.documentId === doc.documentId;
}

// O documento atual pede aceite deste aluno? Só depois de publicado.
function documentPending(student, doc) {
    if (doc.isModel) return false;
    return !acceptanceMatches(student && student[ACCEPTANCE_FIELDS[doc.kind]], doc);
}

function buildDocumentAcceptance(doc, school, req, now = Date.now()) {
    const ua = (req && req.headers && req.headers['user-agent']) || '';
    const { browser, os, device } = parseUserAgent(ua);
    return {
        documentId: doc.documentId,
        version: doc.version,
        schoolId: school && school.id ? String(school.id) : null,
        at: now,
        ip: getClientIp(req),
        device: `${device} · ${os} · ${browser}`,
    };
}

// Grava o aceite de um documento no aluno, mandando o anterior para o histórico.
function storeAcceptance(student, kind, acceptance, now = Date.now()) {
    const field = ACCEPTANCE_FIELDS[kind];
    const previous = student[field];
    if (isPlainObject(previous)) {
        if (!Array.isArray(student.legalAcceptances)) student.legalAcceptances = [];
        student.legalAcceptances.push({ kind, ...previous, replacedAt: now });
        if (student.legalAcceptances.length > LEGAL_ACCEPTANCES_MAX) {
            student.legalAcceptances.splice(0, student.legalAcceptances.length - LEGAL_ACCEPTANCES_MAX);
        }
    }
    student[field] = acceptance;
}

// documentId enviado pelo cliente: ausente (null) ou texto. Outro tipo responde 400.
function readDocumentId(body, kind) {
    const key = BODY_FIELDS[kind];
    const value = body[key];
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') throw new PrivacyAcceptError(400, 'Documento inválido.', { field: key });
    return value.trim();
}

// ------------------------------------------------------------ responsável
function guardianOf(student) {
    const guardian = isPlainObject(student && student.guardian) ? student.guardian : {};
    return {
        name: typeof guardian.name === 'string' ? guardian.name.trim() : '',
        phone: (typeof guardian.phone === 'string' && guardian.phone.trim()) || (typeof (student && student.guardianPhone) === 'string' ? student.guardianPhone.trim() : ''),
        email: typeof guardian.email === 'string' ? guardian.email.trim() : '',
    };
}

// Nome com 3 letras ou mais e um telefone ou e-mail válido.
function guardianComplete(guardian) {
    if (!guardian) return false;
    const name = String(guardian.name || '').trim();
    const phone = String(guardian.phone || '').trim();
    const email = String(guardian.email || '').trim();
    const hasPhone = !!phone && isValidPhone(phone);
    const hasEmail = !!email && isValidEmail(email);
    return name.length >= GUARDIAN_NAME_MIN && (hasPhone || hasEmail);
}

function studentGuardianComplete(student) {
    return guardianComplete(guardianOf(student));
}

function readGuardianText(input, key, label) {
    const value = input[key];
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw new PrivacyAcceptError(400, `${label} deve ser um texto.`, { field: `guardian.${key}` });
    const text = value.replace(/\s+/g, ' ').trim();
    if (text.length > GUARDIAN_LIMITS[key]) throw new PrivacyAcceptError(400, `${label} pode ter no máximo ${GUARDIAN_LIMITS[key]} caracteres.`, { field: `guardian.${key}` });
    return text;
}

// Responsável enviado para um menor: nome, telefone ou e-mail, parentesco (opcional).
// Devolve { name, phone, email, parentesco } ou lança PrivacyAcceptError (400).
function validateMinorGuardian(raw) {
    if (!isPlainObject(raw)) throw new PrivacyAcceptError(400, MINOR_GUARDIAN_MESSAGE, { field: 'guardian' });
    const guardian = {
        name: readGuardianText(raw, 'name', 'O nome do responsável'),
        phone: readGuardianText(raw, 'phone', 'O telefone do responsável'),
        email: normalizeEmail(readGuardianText(raw, 'email', 'O e-mail do responsável')),
        parentesco: readGuardianText(raw, 'parentesco', 'O parentesco'),
    };
    if (guardian.phone && !isValidPhone(guardian.phone)) throw new PrivacyAcceptError(400, 'Telefone do responsável em formato inválido.', { field: 'guardian.phone' });
    if (guardian.email && !isValidEmail(guardian.email)) throw new PrivacyAcceptError(400, 'E-mail do responsável em formato inválido.', { field: 'guardian.email' });
    if (!guardianComplete(guardian)) {
        const field = guardian.name.length < GUARDIAN_NAME_MIN ? 'guardian.name' : 'guardian.phone';
        throw new PrivacyAcceptError(400, MINOR_GUARDIAN_MESSAGE, { field });
    }
    return guardian;
}

// ------------------------------------------------------------ status
function documentSummary(memory, school, doc, includeText) {
    const out = {
        kind: doc.kind,
        documentId: doc.documentId,
        version: doc.version,
        publishedAt: doc.publishedAt,
        isModel: doc.isModel,
        title: doc.title,
    };
    if (includeText) out.markdown = legal.renderedDocument(memory, school, doc).markdown;
    return out;
}

// O que falta para este aluno no primeiro acesso. required: o portão aparece (com
// TEST_MODE, nunca). O texto dos documentos só vai quando o documento está pendente.
// Para contar muitos alunos (resumo do administrador), includeText: false não monta o
// texto (renderizar o markdown de dois documentos por aluno pendente travava o servidor:
// ~0,5 s para 2000 alunos) e current ({ termos, privacidade }) evita procurar os
// documentos atuais de novo a cada aluno.
function studentPrivacyStatus(memory, student, { courseId, today = todayIso(), ruleActive = privacyGateActive(), includeText = true, current = null } = {}) {
    const school = schoolFor(memory, student, courseId);
    const terms = (current && current.termos) || legal.currentDocument(memory, 'termos');
    const privacy = (current && current.privacidade) || legal.currentDocument(memory, 'privacidade');
    const termsPending = documentPending(student, terms);
    const privacyPending = documentPending(student, privacy);
    const birthDateMissing = !hasValidBirthDate(student, { today });
    const isMinor = !birthDateMissing && isMinorBirthDate(student.birthDate, today);
    const guardianMissing = isMinor && !studentGuardianComplete(student);
    const pending = termsPending || privacyPending || birthDateMissing || guardianMissing;
    return {
        success: true,
        policy: MINORS_POLICY,
        ruleActive,
        required: ruleActive && pending,
        pending,
        termsPending,
        privacyPending,
        birthDateMissing,
        isMinor,
        guardianMissing,
        // O cadastro já tem responsável completo (o portão não pede de novo, mesmo que o
        // aluno informe agora uma data de menor).
        guardianInformed: studentGuardianComplete(student),
        // Política 'consentimento' (termo assinado pelo responsável) adiada: nunca pendente.
        guardianConsentPending: false,
        published: !terms.isModel || !privacy.isModel,
        school: legal.schoolSummary(school),
        documents: {
            terms: documentSummary(memory, school, terms, includeText && termsPending),
            privacy: documentSummary(memory, school, privacy, includeText && privacyPending),
        },
    };
}

// Versão dos documentos que valem agora, "<id dos termos>|<id da política>" (o mesmo
// documentId do status): vai no sino do aluno para o portão saber que mudou.
function publishedLegalVersion(memory) {
    return [legal.currentDocument(memory, 'termos'), legal.currentDocument(memory, 'privacidade')]
        .map(doc => String((doc && doc.documentId) || '')).join('|');
}

// ------------------------------------------------------------ aceite pelo portão
// POST /api/student/privacy/accept { termsDocumentId?, privacyDocumentId?, birthDate?,
// guardian? }. Confere tudo antes de mudar qualquer coisa:
// - documento pendente sem o id: 400; id diferente do atual: 409 (a escola publicou
//   outra versão com a tela aberta). Id igual ao atual (mesmo o do modelo) é gravado;
// - data de nascimento: só quando falta (a que já está no cadastro não muda por aqui:
//   quem corrige é a escola); obrigatória quando falta;
// - responsável: só para menor sem responsável completo; obrigatório nesse caso.
// Devolve { changes, accepted, birthDateInformed, guardianInformed } e altera o aluno
// na memória; quem chama grava a auditoria e faz o db.save().
function applyPrivacyAccept(memory, student, body, { req, courseId, now = Date.now(), today = todayIso() } = {}) {
    const input = isPlainObject(body) ? body : {};
    const school = schoolFor(memory, student, courseId);
    const accepted = [];
    legal.LEGAL_KINDS.forEach(kind => {
        const doc = legal.currentDocument(memory, kind);
        const sent = readDocumentId(input, kind);
        if (sent && sent !== doc.documentId) {
            throw new PrivacyAcceptError(409, DOCUMENTS_CHANGED_MESSAGE, { code: 'documents_changed', field: BODY_FIELDS[kind] });
        }
        if (!sent && documentPending(student, doc)) {
            const label = kind === 'termos' ? 'Marque que leu e aceita os Termos de Uso.' : 'Marque que leu a Política de Privacidade.';
            throw new PrivacyAcceptError(400, label, { field: BODY_FIELDS[kind] });
        }
        if (sent && !acceptanceMatches(student[ACCEPTANCE_FIELDS[kind]], doc)) accepted.push(doc);
    });

    const changes = [];
    let birthDate = hasValidBirthDate(student, { today }) ? student.birthDate : '';
    let birthDateInformed = false;
    if (!birthDate) {
        if (input.birthDate !== undefined && input.birthDate !== null && typeof input.birthDate !== 'string') {
            throw new PrivacyAcceptError(400, 'Data de nascimento inválida. Informe dia, mês e ano.', { field: 'birthDate' });
        }
        const checked = checkBirthDate(input.birthDate, { required: true, today });
        if (!checked.ok) throw new PrivacyAcceptError(400, checked.error, { field: checked.field });
        birthDate = checked.value;
        birthDateInformed = true;
    }
    let guardian = null;
    if (isMinorBirthDate(birthDate, today) && !studentGuardianComplete(student)) {
        guardian = validateMinorGuardian(input.guardian);
    }

    // Tudo conferido: grava.
    if (birthDateInformed) {
        changes.push({ field: 'Data de nascimento', oldValue: typeof student.birthDate === 'string' ? student.birthDate : '', newValue: birthDate });
        student.birthDate = birthDate;
    }
    if (guardian) {
        const before = isPlainObject(student.guardian) ? student.guardian : {};
        const beforeName = typeof before.name === 'string' ? before.name : '';
        const beforePhone = typeof student.guardianPhone === 'string' ? student.guardianPhone : '';
        student.guardian = {
            ...before,
            name: guardian.name,
            phone: guardian.phone,
            email: guardian.email,
            parentesco: guardian.parentesco || (typeof before.parentesco === 'string' ? before.parentesco : ''),
            observacao: typeof before.observacao === 'string' ? before.observacao : '',
        };
        student.guardianPhone = guardian.phone;
        if (beforeName !== guardian.name) changes.push({ field: 'Nome do responsável', oldValue: beforeName, newValue: guardian.name });
        if (beforePhone !== guardian.phone) changes.push({ field: 'Telefone do responsável', oldValue: beforePhone, newValue: guardian.phone });
    }
    accepted.forEach(doc => storeAcceptance(student, doc.kind, buildDocumentAcceptance(doc, school, req, now), now));
    if (accepted.length || changes.length) student.updatedAt = now;
    return { accepted, changes, birthDateInformed, guardianInformed: !!guardian, isMinor: isMinorBirthDate(birthDate, today), school };
}

// ------------------------------------------------------------ autocadastro
// POST /api/student/register: data de nascimento obrigatória; para menor, responsável
// completo; o aceite vale para os documentos atuais (os ids enviados pela tela, ou os
// atuais quando o navegador ainda tem a tela antiga e não os manda). Id diferente do
// atual responde 409. Devolve { birthDate, guardianRequired, terms, privacy, school }
// ou lança PrivacyAcceptError.
function checkRegistration(memory, body, { courseId, today = todayIso() } = {}) {
    const input = isPlainObject(body) ? body : {};
    if (input.birthDate !== undefined && input.birthDate !== null && typeof input.birthDate !== 'string') {
        throw new PrivacyAcceptError(400, 'Data de nascimento inválida. Informe dia, mês e ano.', { field: 'birthDate' });
    }
    const checked = checkBirthDate(input.birthDate, { required: true, today });
    if (!checked.ok) throw new PrivacyAcceptError(400, checked.error, { field: checked.field });
    const minor = isMinorBirthDate(checked.value, today);
    let guardian = null;
    if (minor) guardian = validateMinorGuardian(input.guardian);
    const school = legal.resolveSchool(memory, { courseId });
    const docs = {};
    legal.LEGAL_KINDS.forEach(kind => {
        const doc = legal.currentDocument(memory, kind);
        const sent = readDocumentId(input, kind);
        if (sent && sent !== doc.documentId) {
            throw new PrivacyAcceptError(409, DOCUMENTS_CHANGED_MESSAGE, { code: 'documents_changed', field: BODY_FIELDS[kind] });
        }
        docs[kind] = doc;
    });
    return { birthDate: checked.value, isMinor: minor, guardian, terms: docs.termos, privacy: docs.privacidade, school };
}

// Detalhes do privacy_accept na auditoria (sem IP nem aparelho: esses ficam no aceite).
function acceptAuditDetails(accepted, extra = {}) {
    const byKind = kind => {
        const doc = accepted.find(item => item.kind === kind);
        return doc ? { documentId: doc.documentId, version: doc.version } : null;
    };
    return { terms: byKind('termos'), privacy: byKind('privacidade'), ...extra };
}

module.exports = {
    publishedLegalVersion,
    MINORS_POLICY,
    DOCUMENTS_CHANGED_MESSAGE,
    MINOR_GUARDIAN_MESSAGE,
    ACCEPTANCE_FIELDS,
    PrivacyAcceptError,
    privacyErrorBody,
    privacyGateActive,
    studentCourseId,
    acceptanceMatches,
    documentPending,
    buildDocumentAcceptance,
    storeAcceptance,
    guardianComplete,
    studentGuardianComplete,
    validateMinorGuardian,
    studentPrivacyStatus,
    applyPrivacyAccept,
    checkRegistration,
    acceptAuditDetails,
};
