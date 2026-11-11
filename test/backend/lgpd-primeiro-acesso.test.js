// Primeiro acesso do aluno (H8a-2; SEG-08, OPS-12, SEG-09, decisão P4 do Alan).
// Antes: o autocadastro gravava o aceite { version: '1.0' } sem saber qual texto o aluno
// viu, quem o professor cadastrava nunca aceitava nada, não havia data de nascimento e o
// responsável do menor era opcional. Agora:
// 1) o aceite grava o documentId do texto exato (o modelo antes de publicar, a versão
//    publicada depois), com escola, hora, IP e aparelho; documento trocado com a tela
//    aberta responde 409;
// 2) o autocadastro pede a data de nascimento e, para menor de 18 anos, o nome e um
//    telefone ou e-mail do responsável;
// 3) GET /api/student/privacy/status e POST /api/student/privacy/accept: o portão pede a
//    todos a data que falta e, depois que o administrador publica, o aceite da versão
//    publicada; a nova publicação pede aceite de novo e o anterior vai para o histórico;
// 4) nada disso bloqueia o login nem as outras rotas (política 'ciência'), e com
//    TEST_MODE (demonstração) o portão não é exigido.
// Roda SEM o TEST_MODE; o teste que precisa dele liga e desliga na hora.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-lgpd-primeiro-acesso-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
delete process.env.TEST_MODE;

// Módulos antes do servidor: server.js registra o process.on('uncaughtException'), que
// engoliria a falha destes require e o arquivo passaria sem rodar nenhum teste.
const birth = require('../../backend/utils/birthDate.js');
const acceptance = require('../../backend/utils/legalAcceptance.js');
const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { createAdminSession, createStudentSession } = require('../../backend/utils/authSessions.js');

const ADMIN = 'adm@primeiro.local';
const PROF = 'prof@primeiro.local';
const ANA = { email: 'ana@primeiro.local', password: 'Caderno-Azul-7' };
const PASSWORD = 'Girassol-Amarelo-3';
let app;

const today = () => birth.todayIso();
const yearsAgo = (years, delta = 0) => {
    const [y, m, d] = today().split('-').map(Number);
    const date = new Date(Date.UTC(y - years, m - 1, d + delta));
    return date.toISOString().slice(0, 10);
};
const adminHeaders = (email = ADMIN) => ({ 'x-admin-session': createAdminSession(db.memory, email) });
const studentHeaders = email => ({ 'x-session-token': createStudentSession(db.memory, email) });
const findStudent = email => db.memory.students.find(student => student.email === email);
const auditOf = action => db.memory.auditLogs.filter(entry => entry.action === action);
const registerBody = extra => ({
    name: 'Bia Nova', email: 'bia@primeiro.local', password: PASSWORD, courseId: 'DES', studentClass: '1DES', acceptedTerms: true, ...extra,
});

function seed() {
    db.memory.config = { ...(db.memory.config || {}), settings: {} };
    db.memory.admins = [
        { email: ADMIN, name: 'Administração', role: 'admin', password: db.hashPassword('Painel-Seguro-2026') },
        { email: PROF, name: 'Professora', role: 'professor', password: db.hashPassword('Painel-Seguro-2026') },
    ];
    db.memory.schools = [
        { id: 'escola_a', name: 'Escola Alfa', info: {}, branding: {} },
        { id: 'escola_b', name: 'Escola Beta', info: {}, branding: {} },
    ];
    db.memory.courses = [{ id: 'DES', name: 'Desenvolvimento', schoolId: 'escola_b' }];
    db.memory.classes = [{ name: '1DES', courseId: 'DES', status: 'active', registrationEnabled: true }];
    db.memory.students = [
        // Cadastro antigo, feito pelo professor: sem data e sem aceite.
        { name: 'Ana Souza', email: ANA.email, status: 'Ativo', password: db.hashPassword(ANA.password), classes: [{ name: '1DES', courseId: 'DES' }], studentClass: '1DES' },
    ];
    db.memory.legalDocuments = [];
    db.memory.sessions = {};
    db.memory.adminSessions = {};
    db.memory.loginLogs = [];
    db.memory.auditLogs = [];
    db.memory.examApplications = [];
    db.memory.studentExamState = {};
}

async function publish(kind) {
    const res = await request(app).post('/api/admin/lgpd/documents/publish').set(adminHeaders()).send({ kind, confirm: 'PUBLICAR' });
    assert.equal(res.status, 200, res.body.error);
    return res.body.document;
}

async function editAndPublish(kind, markdown) {
    const draft = await request(app).post('/api/admin/lgpd/documents/draft').set(adminHeaders()).send({ kind, markdown });
    assert.equal(draft.status, 200, draft.body.error);
    return publish(kind);
}

async function withTestMode(run) {
    process.env.TEST_MODE = '1';
    try { return await run(); } finally { delete process.env.TEST_MODE; }
}

test.before(async () => { await db.init(); app = createApp(); });
test.beforeEach(() => { delete process.env.TEST_MODE; seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-LGPD-006] data de nascimento: formato, limites e idade em anos completos', () => {
    assert.equal(birth.checkBirthDate('2008-02-29').ok, true);
    assert.equal(birth.checkBirthDate('2007-02-29').ok, false, 'dia que não existe');
    assert.equal(birth.checkBirthDate('29/02/2008').ok, false, 'só AAAA-MM-DD');
    assert.equal(birth.checkBirthDate('1899-12-31').ok, false, 'antes de 1900');
    assert.equal(birth.checkBirthDate(yearsAgo(0, 1)).error, 'A data de nascimento não pode ser depois de hoje.');
    assert.equal(birth.checkBirthDate('', { required: true }).error, 'Informe a data de nascimento.');
    assert.equal(birth.checkBirthDate('').ok, true, 'opcional fora do autocadastro');
    assert.equal(birth.ageOn('2008-06-10', '2026-06-10'), 18, 'faz 18 hoje');
    assert.equal(birth.ageOn('2008-06-10', '2026-06-09'), 17);
    assert.equal(birth.isMinorBirthDate(yearsAgo(18)), false, 'faz 18 hoje: adulto');
    assert.equal(birth.isMinorBirthDate(yearsAgo(18, 1)), true, 'faz 18 amanhã: menor');
    assert.equal(acceptance.guardianComplete({ name: 'Jo', phone: '11 99999-0000' }), false, 'nome curto');
    assert.equal(acceptance.guardianComplete({ name: 'Maria', phone: '123' }), false, 'telefone curto e sem e-mail');
    assert.equal(acceptance.guardianComplete({ name: 'Maria', email: 'maria@familia.local' }), true);
});

test('[UC-LGPD-006] autocadastro pede a data de nascimento e, para menor, o responsável', async () => {
    const missing = await request(app).post('/api/student/register').send(registerBody());
    assert.equal(missing.status, 400, 'antes, 200 sem data');
    assert.deepEqual([missing.body.success, missing.body.field, missing.body.error], [false, 'birthDate', 'Informe a data de nascimento.']);
    const future = await request(app).post('/api/student/register').send(registerBody({ birthDate: yearsAgo(0, 2) }));
    assert.equal(future.status, 400);
    assert.equal(future.body.field, 'birthDate');
    const typed = await request(app).post('/api/student/register').send(registerBody({ birthDate: { dia: 1 } }));
    assert.equal(typed.status, 400, 'tipo errado não vira 500');

    const minor = registerBody({ birthDate: yearsAgo(15) });
    const noGuardian = await request(app).post('/api/student/register').send(minor);
    assert.equal(noGuardian.status, 400, 'antes, o responsável era opcional');
    assert.equal(noGuardian.body.error, 'Para menores de 18 anos, informe o nome e um telefone ou e-mail do responsável.');
    assert.match(noGuardian.body.field, /^guardian/);
    const shortName = await request(app).post('/api/student/register').send({ ...minor, guardian: { name: 'Jo', phone: '(11) 98888-1234' } });
    assert.equal(shortName.status, 400);
    assert.equal(shortName.body.field, 'guardian.name');
    assert.equal(findStudent(minor.email), undefined, 'nada é criado na recusa');

    // Formato único dos 400 da rota { success: false, error, field } (contrato): antes, o
    // e-mail inválido do responsável (validateStudentFields), "Dados incompletos." e a turma
    // fechada saíam sem success:false (e os dois últimos sem field).
    const badEmail = await request(app).post('/api/student/register').send({ ...minor, guardian: { name: 'Maria Nova', email: 'x@' } });
    assert.equal(badEmail.status, 400);
    assert.deepEqual([badEmail.body.success, badEmail.body.field], [false, 'guardian.email']);
    const incomplete = await request(app).post('/api/student/register').send({ ...minor, name: '' });
    assert.equal(incomplete.status, 400);
    assert.deepEqual([incomplete.body.success, incomplete.body.error, incomplete.body.field], [false, 'Dados incompletos.', 'name']);
    const noClass = await request(app).post('/api/student/register').send({ ...minor, studentClass: '' });
    assert.deepEqual([noClass.status, noClass.body.success, noClass.body.field], [400, false, 'studentClass']);
    const closedClass = await request(app).post('/api/student/register').send({ ...minor, studentClass: '9ZZZ' });
    assert.deepEqual([closedClass.status, closedClass.body.success, closedClass.body.field], [400, false, 'studentClass']);
    const badPhone = await request(app).post('/api/student/register').send({ ...minor, phone: '12', guardian: { name: 'Maria Nova', phone: '(11) 98888-1234' } });
    assert.deepEqual([badPhone.status, badPhone.body.success, badPhone.body.field], [400, false, 'phone']);

    const ok = await request(app).post('/api/student/register').send({ ...minor, guardian: { name: 'Maria Nova', phone: '(11) 98888-1234', parentesco: 'Mãe' } });
    assert.equal(ok.status, 200, ok.body.error);
    const bia = findStudent(minor.email);
    assert.equal(bia.birthDate, minor.birthDate);
    assert.equal(bia.guardian.name, 'Maria Nova');
    assert.equal(bia.guardianPhone, '(11) 98888-1234');
});

test('[UC-LGPD-006] autocadastro grava o aceite do documento exato (modelo antes de publicar), sem a versão 1.0', async () => {
    const res = await request(app).post('/api/student/register').set('User-Agent', 'Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile')
        .send(registerBody({ birthDate: '1999-04-03', termsDocumentId: 'modelo-2026.1:termos', privacyDocumentId: 'modelo-2026.1:privacidade' }));
    assert.equal(res.status, 200, res.body.error);
    const bia = findStudent('bia@primeiro.local');
    assert.equal(bia.termsAcceptance.documentId, 'modelo-2026.1:termos', 'antes: { version: "1.0" }');
    assert.equal(bia.termsAcceptance.version, null);
    assert.equal(bia.termsAcceptance.schoolId, 'escola_b', 'a escola do curso escolhido');
    assert.equal(bia.privacyAcceptance.documentId, 'modelo-2026.1:privacidade');
    assert.ok(bia.termsAcceptance.at && bia.termsAcceptance.ip && /Android/.test(bia.termsAcceptance.device));
    assert.doesNotMatch(JSON.stringify(bia), /"version":"1\.0"/);
    const audit = auditOf('privacy_accept');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].category, 'privacy');
    assert.equal(audit[0].studentEmail, bia.email);
    assert.equal(audit[0].details.source, 'cadastro');
    assert.equal(audit[0].details.terms.documentId, 'modelo-2026.1:termos');
    // O mesmo papel do aceite pelo portão (antes, actorRole vazio: não há sessão no cadastro).
    assert.equal(audit[0].actor, bia.email);
    assert.equal(audit[0].actorRole, 'aluno');
});

test('[UC-LGPD-006] autocadastro com documento trocado responde 409; tela antiga sem os ids aceita os atuais', async () => {
    await publish('termos');
    const stale = await request(app).post('/api/student/register')
        .send(registerBody({ birthDate: '1999-04-03', termsDocumentId: 'modelo-2026.1:termos', privacyDocumentId: 'modelo-2026.1:privacidade' }));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'documents_changed');
    assert.equal(stale.body.error, 'Os documentos foram atualizados. Leia a nova versão e marque o aceite de novo.');
    assert.equal(findStudent('bia@primeiro.local'), undefined);
    const oldScreen = await request(app).post('/api/student/register').send(registerBody({ birthDate: '1999-04-03' }));
    assert.equal(oldScreen.status, 200, oldScreen.body.error);
    assert.equal(findStudent('bia@primeiro.local').termsAcceptance.documentId, 'termos_v1');
    assert.equal(findStudent('bia@primeiro.local').termsAcceptance.version, 1);
});

test('[UC-LGPD-007] portão: a data é pedida a todos; os documentos só depois de publicados', async () => {
    const headers = studentHeaders(ANA.email);
    const before = await request(app).get('/api/student/privacy/status').set(headers);
    assert.equal(before.status, 200, 'antes, 404');
    assert.equal(before.body.required, true);
    assert.equal(before.body.birthDateMissing, true);
    assert.equal(before.body.termsPending, false, 'o modelo não é aceite exigível');
    assert.equal(before.body.privacyPending, false);
    assert.equal(before.body.documents.terms.isModel, true);
    assert.equal(before.body.documents.terms.markdown, undefined, 'sem pendência, sem o texto');

    const accepted = await request(app).post('/api/student/privacy/accept').set(headers).send({ birthDate: '1998-11-20' });
    assert.equal(accepted.status, 200, accepted.body.error);
    assert.equal(accepted.body.required, false);
    assert.equal(findStudent(ANA.email).birthDate, '1998-11-20');
    const change = db.memory.auditLogs.find(entry => entry.field === 'Data de nascimento');
    assert.ok(change, 'a data entra no histórico do cadastro');
    assert.equal(change.actor, ANA.email);
    // Só a data (nada publicado ainda): nenhum "Termos ... aceitos" na Auditoria.
    assert.equal(auditOf('privacy_accept').length, 0, 'antes, privacy_accept com terms e privacy null');

    // A data gravada não muda pelo portão (quem corrige é a escola).
    const again = await request(app).post('/api/student/privacy/accept').set(headers).send({ birthDate: '2001-01-01' });
    assert.equal(again.status, 200);
    assert.equal(findStudent(ANA.email).birthDate, '1998-11-20');
    assert.equal(again.body.saved, false);

    await publish('termos');
    await publish('privacidade');
    const pending = await request(app).get('/api/student/privacy/status?courseId=DES').set(headers);
    assert.equal(pending.body.required, true);
    assert.equal(pending.body.termsPending, true);
    assert.equal(pending.body.privacyPending, true);
    assert.equal(pending.body.documents.terms.documentId, 'termos_v1');
    assert.match(pending.body.documents.terms.markdown, /Escola Beta/, 'o texto já vem com os dados da escola do curso');
});

test('[UC-LGPD-007] aceite pelo portão: ids conferidos, 409 com o texto novo e histórico do aceite anterior', async () => {
    findStudent(ANA.email).birthDate = '1998-11-20';
    // Aceite antigo da versão 1.0 nunca vale para documento publicado.
    findStudent(ANA.email).termsAcceptance = { version: '1.0', at: 1 };
    await publish('termos');
    await publish('privacidade');
    const headers = studentHeaders(ANA.email);
    const status = await request(app).get('/api/student/privacy/status').set(headers);
    assert.equal(status.body.termsPending, true, 'o aceite { version: "1.0" } não vale');

    const missing = await request(app).post('/api/student/privacy/accept').set(headers).send({ termsDocumentId: 'termos_v1' });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.field, 'privacyDocumentId');
    const stale = await request(app).post('/api/student/privacy/accept').set(headers).send({ termsDocumentId: 'modelo-2026.1:termos', privacyDocumentId: 'privacidade_v1' });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'documents_changed');
    assert.equal(stale.body.status.documents.terms.documentId, 'termos_v1', 'a resposta já traz o documento atual');
    assert.equal(findStudent(ANA.email).privacyAcceptance, undefined, 'nada é gravado na recusa');

    const ok = await request(app).post('/api/student/privacy/accept').set(headers).send({ termsDocumentId: 'termos_v1', privacyDocumentId: 'privacidade_v1' });
    assert.equal(ok.status, 200, ok.body.error);
    assert.equal(ok.body.required, false);
    const ana = findStudent(ANA.email);
    assert.equal(ana.termsAcceptance.documentId, 'termos_v1');
    assert.equal(ana.termsAcceptance.version, 1);
    assert.equal(ana.legalAcceptances.length, 1, 'o aceite antigo foi para o histórico');
    assert.equal(ana.legalAcceptances[0].kind, 'termos');
    assert.equal(ana.legalAcceptances[0].version, '1.0');
    const audit = auditOf('privacy_accept');
    assert.equal(audit.length, 1);
    assert.deepEqual([audit[0].details.terms.documentId, audit[0].details.privacy.documentId, audit[0].details.source], ['termos_v1', 'privacidade_v1', 'portal']);
    assert.equal(audit[0].actorRole, 'aluno');

    // Nova publicação pede aceite de novo (só do que mudou).
    await editAndPublish('termos', '# Termos de Uso\n\nTexto revisado pela escola.');
    const next = await request(app).get('/api/student/privacy/status').set(headers);
    assert.deepEqual([next.body.required, next.body.termsPending, next.body.privacyPending], [true, true, false]);
    assert.equal(next.body.documents.terms.documentId, 'termos_v2');
    const second = await request(app).post('/api/student/privacy/accept').set(headers).send({ termsDocumentId: 'termos_v2' });
    assert.equal(second.status, 200, second.body.error);
    assert.equal(findStudent(ANA.email).legalAcceptances.length, 2);
    assert.equal(findStudent(ANA.email).legalAcceptances[1].documentId, 'termos_v1');
});

test('[UC-LGPD-007] menor no portão: o responsável é pedido e gravado; adulto não precisa', async () => {
    const headers = studentHeaders(ANA.email);
    const minorDate = yearsAgo(16);
    const noGuardian = await request(app).post('/api/student/privacy/accept').set(headers).send({ birthDate: minorDate });
    assert.equal(noGuardian.status, 400);
    assert.equal(noGuardian.body.error, 'Para menores de 18 anos, informe o nome e um telefone ou e-mail do responsável.');
    assert.equal(findStudent(ANA.email).birthDate, undefined, 'nada é gravado na recusa');
    const badPhone = await request(app).post('/api/student/privacy/accept').set(headers)
        .send({ birthDate: minorDate, guardian: { name: 'Carlos Souza', phone: '12' } });
    assert.equal(badPhone.status, 400);
    assert.equal(badPhone.body.field, 'guardian.phone');

    const ok = await request(app).post('/api/student/privacy/accept').set(headers)
        .send({ birthDate: minorDate, guardian: { name: 'Carlos Souza', email: 'Carlos@Familia.local', parentesco: 'Pai' } });
    assert.equal(ok.status, 200, ok.body.error);
    assert.deepEqual([ok.body.required, ok.body.isMinor, ok.body.guardianMissing], [false, true, false]);
    const ana = findStudent(ANA.email);
    assert.deepEqual([ana.guardian.name, ana.guardian.email, ana.guardian.parentesco], ['Carlos Souza', 'carlos@familia.local', 'Pai']);
    assert.ok(db.memory.auditLogs.some(entry => entry.field === 'Nome do responsável' && entry.newValue === 'Carlos Souza'));
    // Antes de publicar não há documento aceito: só a alteração do cadastro vai para a
    // auditoria (antes, privacy_accept "Termos e Política de Privacidade aceitos").
    assert.equal(auditOf('privacy_accept').length, 0, 'só a data e o responsável não são aceite de documento');

    // Menor cadastrado pelo professor já com a data, sem responsável: o portão pede só ele.
    ana.guardian = null;
    const status = await request(app).get('/api/student/privacy/status').set(headers);
    assert.deepEqual([status.body.required, status.body.birthDateMissing, status.body.guardianMissing], [true, false, true]);
});

test('[UC-LGPD-007] política ciência: o login e o portal não são bloqueados, e TEST_MODE não exige o portão', async () => {
    await publish('termos');
    const login = await request(app).post('/api/student/login').send({ email: ANA.email, password: ANA.password });
    assert.equal(login.status, 200, login.body.error);
    assert.equal(login.body.student.birthDate, undefined, 'a data não vai para o perfil guardado no navegador');
    const headers = { 'x-session-token': login.body.sessionToken };
    const status = await request(app).get('/api/student/privacy/status').set(headers);
    assert.equal(status.body.required, true);
    const other = await request(app).get('/api/student/enrollments').set(headers);
    assert.equal(other.status, 200, 'o servidor não recusa as outras rotas por causa do aceite');

    await withTestMode(async () => {
        const demo = await request(app).get('/api/student/privacy/status').set(headers);
        assert.equal(demo.body.required, false, 'demonstração não trava');
        assert.equal(demo.body.termsPending, true, 'mas diz o que falta');
        const accept = await request(app).post('/api/student/privacy/accept').set(headers).send({ termsDocumentId: 'termos_v1', birthDate: '2000-02-02' });
        assert.equal(accept.status, 200, accept.body.error);
    });
});

test('[UC-LGPD-007] professor cadastra e edita a data (opcional e conferida); resumo do primeiro acesso só para o administrador', async () => {
    const headers = adminHeaders();
    const base = { name: 'Caio Lima', email: 'caio@primeiro.local', classes: [{ name: '1DES', courseId: 'DES' }], studentPassword: 'Quadro-Negro-55' };
    const invalid = await request(app).post('/api/admin/student/create').set(headers).send({ ...base, birthDate: '2010-13-01' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.field, 'birthDate');
    const created = await request(app).post('/api/admin/student/create').set(headers).send({ ...base, birthDate: '2009-05-06' });
    assert.equal(created.status, 200, created.body.error);
    assert.equal(findStudent(base.email).birthDate, '2009-05-06');
    const updated = await request(app).post('/api/admin/student/update').set(headers)
        .send({ originalEmail: base.email, name: base.name, email: base.email, classes: base.classes, birthDate: '2009-05-07' });
    assert.equal(updated.status, 200, updated.body.error);
    assert.equal(findStudent(base.email).birthDate, '2009-05-07');
    assert.ok(db.memory.auditLogs.some(entry => entry.field === 'Data de nascimento' && entry.oldValue === '2009-05-06' && entry.newValue === '2009-05-07'));
    const kept = await request(app).post('/api/admin/student/update').set(headers)
        .send({ originalEmail: base.email, name: 'Caio Lima Souza', email: base.email, classes: base.classes });
    assert.equal(kept.status, 200);
    assert.equal(findStudent(base.email).birthDate, '2009-05-07', 'tela que não manda o campo não apaga a data');

    await publish('termos');
    const summary = await request(app).get('/api/admin/lgpd/acceptance').set(headers);
    assert.equal(summary.status, 200, summary.body.error);
    assert.deepEqual(
        [summary.body.activeStudents, summary.body.termsPending, summary.body.privacyPending, summary.body.birthDateMissing, summary.body.minors, summary.body.minorsWithoutGuardian, summary.body.published],
        [2, 2, 0, 1, 1, 1, true],
    );
    const prof = await request(app).get('/api/admin/lgpd/acceptance').set(adminHeaders(PROF));
    assert.equal(prof.status, 403);
});

test('[UC-LGPD-007] resumo do primeiro acesso conta sem montar o texto dos documentos de cada aluno', async () => {
    for (let i = 0; i < 40; i += 1) {
        db.memory.students.push({ name: `Aluno ${i}`, email: `aluno${i}@primeiro.local`, status: 'Ativo', classes: [{ name: '1DES', courseId: 'DES' }] });
    }
    await publish('termos');
    await publish('privacidade');
    const legal = require('../../backend/utils/legalDocuments.js');
    const original = legal.renderedDocument;
    let renders = 0;
    legal.renderedDocument = (...args) => { renders += 1; return original(...args); };
    try {
        const summary = await request(app).get('/api/admin/lgpd/acceptance').set(adminHeaders());
        assert.equal(summary.status, 200, summary.body.error);
        assert.deepEqual([summary.body.activeStudents, summary.body.termsPending, summary.body.privacyPending], [41, 41, 41]);
        assert.equal(renders, 0, 'antes, dois textos renderizados por aluno pendente (82 aqui)');
        // O portão do aluno continua recebendo o texto pendente.
        const status = await request(app).get('/api/student/privacy/status').set(studentHeaders(ANA.email));
        assert.match(status.body.documents.terms.markdown, /Termos/);
        assert.ok(renders > 0);
    } finally {
        legal.renderedDocument = original;
    }
});

test('[UC-LGPD-007] anonimizar tira o IP e o aparelho das entradas que o próprio aluno gravou no primeiro acesso', async () => {
    await publish('termos');
    const headers = { ...studentHeaders(ANA.email), 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile', 'X-Forwarded-For': '10.0.0.77' };
    const ok = await request(app).post('/api/student/privacy/accept').set(headers).send({ birthDate: '1998-11-20', termsDocumentId: 'termos_v1' });
    assert.equal(ok.status, 200, ok.body.error);
    const own = () => db.memory.auditLogs.filter(entry => entry.actor === ANA.email || (entry.action === 'privacy_accept'));
    assert.ok(own().length >= 2, 'privacy_accept e a alteração do cadastro');
    findStudent(ANA.email).status = 'Inativo';
    const anon = await request(app).post('/api/admin/students/anonymize').set(adminHeaders())
        .send({ email: ANA.email, confirm: 'ANONIMIZAR', reason: 'Pedido da família' });
    assert.equal(anon.status, 200, anon.body.error);
    const accepted = db.memory.auditLogs.filter(entry => entry.action === 'privacy_accept');
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].ip, undefined, 'antes, o IP do aluno ficava');
    assert.equal(accepted[0].device, undefined);
    const birthChange = db.memory.auditLogs.find(entry => entry.field === 'Data de nascimento');
    assert.equal(birthChange.ip, undefined);
    assert.equal(birthChange.newValue, '', 'a data também sai');
    // A entrada do administrador (a própria anonimização) mantém o IP dele.
    assert.ok(db.memory.auditLogs.find(entry => entry.action === 'student_anonymized').ip);
    assert.doesNotMatch(JSON.stringify(db.memory.auditLogs), /ana@primeiro\.local|1998-11-20|10\.0\.0\.77/);
});

// Decisões §12 (sobra do H8a-2): o portão guarda o status por 10 min; o sino do aluno
// (consultado a cada 30 s) traz a versão publicada dos documentos para o portão saber que
// a escola publicou outra e perguntar de novo.
test('[UC-LGPD-007] o sino do aluno traz a versão publicada dos documentos, a mesma do status do portão', async () => {
    const headers = studentHeaders(ANA.email);
    const bell = () => request(app).get('/api/student/notifications?courseId=DES&studentClass=1DES').set(headers);
    const first = await bell();
    assert.equal(first.status, 200, first.body.error);
    const status = await request(app).get('/api/student/privacy/status?courseId=DES').set(headers);
    assert.equal(first.body.legalVersion, `${status.body.documents.terms.documentId}|${status.body.documents.privacy.documentId}`);

    await publish('termos');
    const second = await bell();
    assert.notEqual(second.body.legalVersion, first.body.legalVersion);
    assert.equal(second.body.legalVersion.split('|')[0], 'termos_v1');
    await publish('privacidade');
    assert.equal((await bell()).body.legalVersion, 'termos_v1|privacidade_v1');
});
