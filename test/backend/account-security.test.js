// Senhas das contas (fase 2, H5a; SEG-06, UXA-13, SEG-X2, decisão P3 do Alan).
// Antes: o cadastro, a criação pelo professor e o "Resetar senha" aceitavam a senha "1";
// a edição do aluno gravava a senha digitada (e até um hash vindo do navegador) sem
// registro; o reset não deixava rastro na auditoria; não existia troca de senha para o
// aluno nem troca obrigatória; e os hashes SHA-256 antigos de quem não entrava mais
// ficavam no banco e nos backups. Este arquivo roda SEM o TEST_MODE (o TEST_MODE desliga
// a troca obrigatória, como no modo demonstração), e cada teste que precisa dele liga e
// desliga na hora.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-account-security-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
delete process.env.TEST_MODE;

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { createAdminSession, createStudentSession } = require('../../backend/utils/authSessions.js');
const {
    COMMON_PASSWORDS, TEMPORARY_ALPHABET, generateTemporaryPassword, validateNewPassword,
} = require('../../backend/utils/passwordPolicy.js');

const ADMIN = { email: 'adm@contas.local', password: 'Painel-Seguro-2026' };
const ANA = { email: 'ana.souza@contas.local', name: 'Ana Souza', password: 'Caderno-Azul-7' };
const LEGACY_SALT = 'senai_salt_4.0_!@#';
const legacySha = value => crypto.createHash('sha256').update(value + LEGACY_SALT).digest('hex');
let app;

function seed() {
    db.memory.config = { ...(db.memory.config || {}), settings: {} };
    delete db.memory.config.adminPassword;
    db.memory.admins = [
        { email: ADMIN.email, name: 'Administração', role: 'admin', password: db.hashPassword(ADMIN.password) },
    ];
    db.memory.students = [
        { name: ANA.name, email: ANA.email, status: 'Ativo', password: db.hashPassword(ANA.password), classes: [{ name: '1DES', courseId: 'DES' }], studentClass: '1DES' },
    ];
    db.memory.sessions = {};
    db.memory.adminSessions = {};
    db.memory.classes = [{ name: '1DES', courseId: 'DES', status: 'active', registrationEnabled: true }];
    db.memory.courses = [{ id: 'DES', name: 'Desenvolvimento' }];
    db.memory.enrollmentRequests = [];
    db.memory.loginLogs = [];
    db.memory.auditLogs = [];
    db.memory.examApplications = [];
    db.memory.studentExamState = {};
}

const adminHeaders = () => ({ 'x-admin-session': createAdminSession(db.memory, ADMIN.email) });
const studentHeaders = email => ({ 'x-session-token': createStudentSession(db.memory, email) });
const findStudent = email => db.memory.students.find(student => student.email === email);
const auditOf = action => db.memory.auditLogs.filter(entry => entry.action === action);

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

// --- Política de senha --------------------------------------------------------------

test('[UC-SENHA-001] política: tamanho, senha comum, sequência, repetição e dado pessoal', () => {
    const personal = { email: 'ana.souza@escola.local', name: 'Ana Souza', nomeSocial: 'Aninha Lima', matricula: '2026-0042' };
    const refused = [
        ['1', 'pelo menos 8'],
        ['  1234567 ', 'pelo menos 8'],
        ['12345678', 'muito comum'],
        ['87654321', 'muito comum'],
        ['78901234', 'muito comum'],
        ['abcdefgh', 'muito comum'],
        ['aaaaaaaa', 'muito comum'],
        ['Senha123', 'muito comum'],
        ['IClass2026', 'muito comum'],
        ['ana.souza@escola.local', 'e-mail, nome ou matrícula'],
        ['Ana Souza', 'e-mail, nome ou matrícula'],
        ['anasouza', 'e-mail, nome ou matrícula'],
        ['ÁnaSouza', 'e-mail, nome ou matrícula'],
        ['anasouza1999', 'e-mail, nome ou matrícula'],
        ['aninha lima', 'e-mail, nome ou matrícula'],
        ['2026-0042', 'e-mail, nome ou matrícula'],
        ['souza2026', 'e-mail, nome ou matrícula'],
        ['Aninha@2010', 'e-mail, nome ou matrícula'],
        ['123-lima-456', 'e-mail, nome ou matrícula'],
        ['x'.repeat(129), 'no máximo 128'],
    ];
    for (const [password, message] of refused) {
        const result = validateNewPassword(password, { kind: 'student', ...personal });
        assert.equal(result.ok, false, `"${password}" devia ser recusada`);
        assert.match(result.error, new RegExp(message), password);
    }
    for (const password of ['Caderno-Azul-7', 'girassol na janela', ' Lua-Cheia-88 ', 'Ab1-'.repeat(32), 'Ana-Lua-2026', 'souzaferreira99']) {
        assert.deepEqual(validateNewPassword(password, { kind: 'student', ...personal }), { ok: true }, password);
    }
    // Instrutor: 10 caracteres (o mínimo que a troca de senha do painel já pedia).
    assert.match(validateNewPassword('Lua-Che-8', { kind: 'instructor' }).error, /pelo menos 10/);
    assert.equal(validateNewPassword('Lua-Cheia-88', { kind: 'instructor' }).ok, true);
    // A lista fica em minúsculas e sem senhas que já caem pelo tamanho.
    for (const common of COMMON_PASSWORDS) {
        assert.equal(common, common.toLowerCase());
        assert.ok(common.length >= 8, common);
    }
});

test('[UC-SENHA-001] senha temporária: 10 letras e números sem os que se confundem, no formato xxxxx-xxxxx', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) {
        const value = generateTemporaryPassword();
        assert.match(value, /^[a-z2-9]{5}-[a-z2-9]{5}$/);
        assert.doesNotMatch(value, /[01ilo]/);
        assert.ok([...value.replace('-', '')].every(char => TEMPORARY_ALPHABET.includes(char)));
        assert.equal(validateNewPassword(value, { kind: 'student' }).ok, true, 'a temporária passa pela política');
        seen.add(value);
    }
    assert.equal(seen.size, 200, 'cada senha temporária é nova');
});

// --- Cadastro, criação, edição e redefinição ---------------------------------------

test('[UC-SENHA-001] autocadastro recusa senha fraca e nunca pede a troca no primeiro acesso', async () => {
    const base = { name: 'Bia Nova', email: 'bia.nova@contas.local', courseId: 'DES', studentClass: '1DES', acceptedTerms: true };
    for (const password of ['1', '12345678', 'bia.nova@contas.local', 'Bia Nova']) {
        const res = await request(app).post('/api/student/register').send({ ...base, password });
        assert.equal(res.status, 400, `${password}: antes, 200`);
        assert.equal(res.body.passwordPolicy, true);
        assert.equal(res.body.field, 'password');
    }
    assert.equal(findStudent(base.email), undefined, 'a senha recusada não cria a conta');
    const ok = await request(app).post('/api/student/register').send({ ...base, password: 'Girassol-Amarelo-3' });
    assert.equal(ok.status, 200, ok.body.error);
    assert.notEqual(findStudent(base.email).mustChangePassword, true);
    const login = await request(app).post('/api/student/login').send({ email: base.email, password: 'Girassol-Amarelo-3' });
    assert.equal(login.status, 200, login.body.error);
    assert.equal(login.body.mustChangePassword, false);
});

test('[UC-SENHA-001] professor cria aluno: senha fraca recusada, em branco gera temporária e a troca é pedida (ou não)', async () => {
    const headers = adminHeaders();
    const base = { name: 'Caio Lima', email: 'caio@contas.local', classes: [{ name: '1DES', courseId: 'DES' }] };
    const weak = await request(app).post('/api/admin/student/create').set(headers).send({ ...base, studentPassword: '123' });
    assert.equal(weak.status, 400, 'antes, 200 com a senha "123"');
    assert.equal(weak.body.passwordPolicy, true);
    assert.equal(findStudent(base.email), undefined);

    const generated = await request(app).post('/api/admin/student/create').set(headers).send({ ...base, studentPassword: '' });
    assert.equal(generated.status, 200, generated.body.error);
    assert.match(generated.body.temporaryPassword, /^[a-z2-9]{5}-[a-z2-9]{5}$/);
    assert.equal(generated.body.mustChangePassword, true);
    const caio = findStudent(base.email);
    assert.match(caio.password, /^scrypt\$/);
    assert.equal(await db.verifyPasswordAsync(caio.password, generated.body.temporaryPassword), true);
    assert.equal(caio.mustChangePassword, true);
    assert.equal(caio.passwordChangeReason, 'created');
    const created = auditOf('student_created').concat(db.memory.auditLogs.filter(entry => entry.studentEmail === base.email));
    assert.ok(created.length > 0, 'a criação fica na auditoria');
    assert.doesNotMatch(JSON.stringify(db.memory.auditLogs), new RegExp(generated.body.temporaryPassword), 'a senha não vai para a auditoria');

    // A caixa "Pedir troca no primeiro acesso" desmarcada.
    const typed = await request(app).post('/api/admin/student/create').set(headers)
        .send({ ...base, email: 'duda@contas.local', studentPassword: 'Quadro-Negro-55', requirePasswordChange: false });
    assert.equal(typed.status, 200, typed.body.error);
    assert.equal(typed.body.temporaryPassword, undefined, 'senha digitada não volta na resposta');
    assert.equal(typed.body.mustChangePassword, false);
    assert.notEqual(findStudent('duda@contas.local').mustChangePassword, true);

    const nonString = await request(app).post('/api/admin/student/create').set(headers).send({ ...base, email: 'eva@contas.local', studentPassword: 12345678 });
    assert.equal(nonString.status, 400);
});

test('[UC-SENHA-001] editar aluno não troca a senha: senha ou hash no pedido dão 400 e o hash fica', async () => {
    const headers = adminHeaders();
    const before = findStudent(ANA.email).password;
    const edit = { originalEmail: ANA.email, email: ANA.email, name: ANA.name, classes: [{ name: '1DES', courseId: 'DES' }], status: 'Ativo' };
    for (const password of ['1', 'Outra-Senha-99', legacySha('qualquer'), before]) {
        const res = await request(app).post('/api/admin/student/update').set(headers).send({ ...edit, password });
        assert.equal(res.status, 400, `antes, gravava "${password.slice(0, 12)}" como senha`);
        assert.match(res.body.error, /Redefinir senha/);
        assert.equal(findStudent(ANA.email).password, before);
    }
    const kept = await request(app).post('/api/admin/student/update').set(headers).send({ ...edit, name: 'Ana Souza Lima', password: '' });
    assert.equal(kept.status, 200, kept.body.error);
    assert.equal(findStudent(ANA.email).password, before, 'campo vazio das telas antigas não muda a senha');
    assert.equal(findStudent(ANA.email).name, 'Ana Souza Lima');
});

test('[UC-SENHA-001] redefinir senha: política, senha temporária, troca pedida e auditoria student_password_reset', async () => {
    const headers = adminHeaders();
    findStudent(ANA.email).recoveryRequested = true;
    const weak = await request(app).post('/api/admin/reset-password').set(headers).send({ email: ANA.email, newPassword: 'a' });
    assert.equal(weak.status, 400, 'antes, 200 com a senha "a"');
    assert.equal(weak.body.passwordPolicy, true);
    const invalid = await request(app).post('/api/admin/reset-password').set(headers).send({ email: ANA.email, newPassword: 12345678 });
    assert.equal(invalid.status, 400);
    assert.equal(auditOf('student_password_reset').length, 0, 'recusa não registra redefinição');

    const generated = await request(app).post('/api/admin/reset-password').set(headers).send({ email: ANA.email });
    assert.equal(generated.status, 200, generated.body.error);
    assert.match(generated.body.temporaryPassword, /^[a-z2-9]{5}-[a-z2-9]{5}$/);
    assert.equal(generated.body.mustChangePassword, true);
    const ana = findStudent(ANA.email);
    assert.equal(await db.verifyPasswordAsync(ana.password, generated.body.temporaryPassword), true);
    assert.equal(ana.mustChangePassword, true);
    assert.equal(ana.passwordChangeReason, 'reset');
    assert.equal(ana.recoveryRequested, false);
    const [entry] = auditOf('student_password_reset');
    assert.ok(entry, 'antes, o reset não deixava registro');
    assert.equal(entry.category, 'security');
    assert.equal(entry.studentEmail, ANA.email);
    assert.equal(entry.actorEmail || entry.actor, ADMIN.email);
    assert.equal(entry.details.mode, 'generated');
    const raw = JSON.stringify(db.memory.auditLogs);
    assert.doesNotMatch(raw, new RegExp(generated.body.temporaryPassword));
    assert.ok(!raw.includes(ana.password), 'nem o hash');

    const typed = await request(app).post('/api/admin/reset-password').set(headers).send({ email: ANA.email, newPassword: 'Janela-Aberta-31' });
    assert.equal(typed.status, 200, typed.body.error);
    assert.equal(typed.body.temporaryPassword, undefined);
    assert.equal(auditOf('student_password_reset').at(-1).details.mode, 'typed');
    assert.doesNotMatch(JSON.stringify(db.memory.auditLogs), /Janela-Aberta-31/);
});

// --- Troca obrigatória e troca pelo aluno -------------------------------------------

test('[UC-SENHA-001] troca obrigatória depois do reset: 403 em tudo, menos presença, troca e saída', async () => {
    const reset = await request(app).post('/api/admin/reset-password').set(adminHeaders()).send({ email: ANA.email });
    const temporary = reset.body.temporaryPassword;
    const login = await request(app).post('/api/student/login').send({ email: ANA.email, password: temporary });
    assert.equal(login.status, 200, login.body.error);
    assert.equal(login.body.mustChangePassword, true);
    assert.equal(login.body.passwordChangeReason, 'reset');
    const headers = { 'x-session-token': login.body.sessionToken };

    const page = await request(app).post('/api/student/notes/get').set(headers).send({ moduleKey: 'geral' });
    assert.equal(page.status, 403);
    assert.equal(page.body.passwordChangeRequired, true);
    assert.equal(page.body.passwordChangeReason, 'reset');
    const ping = await request(app).get(`/api/ping?email=${encodeURIComponent(ANA.email)}`).set(headers);
    assert.equal(ping.status, 200);
    assert.equal(ping.body.passwordChangeRequired, true);

    const change = body => request(app).post('/api/student/change-password').set(headers).send(body);
    assert.equal((await change({ newPassword: 'Ponte-Velha-48' })).body.field, 'currentPassword', 'sem a senha atual (temporária)');
    const wrong = await change({ currentPassword: 'nao-e-esta', newPassword: 'Ponte-Velha-48' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.field, 'currentPassword');
    const same = await change({ currentPassword: temporary, newPassword: temporary });
    assert.equal(same.status, 400, 'a nova não pode ser a temporária');
    const weak = await change({ currentPassword: temporary, newPassword: '12345678' });
    assert.equal(weak.status, 400);
    assert.equal(weak.body.passwordPolicy, true);
    const ok = await change({ currentPassword: temporary, newPassword: 'Ponte-Velha-48' });
    assert.equal(ok.status, 200, ok.body.error);

    const ana = findStudent(ANA.email);
    assert.equal(ana.mustChangePassword, false);
    assert.equal(ana.passwordChangeReason, undefined);
    assert.ok(Date.parse(ana.passwordChangedAt) > 0);
    assert.equal(await db.verifyPasswordAsync(ana.password, 'Ponte-Velha-48'), true);
    assert.equal((await request(app).post('/api/student/notes/get').set(headers).send({ moduleKey: 'geral' })).status, 200);
    assert.equal((await request(app).get(`/api/ping?email=${encodeURIComponent(ANA.email)}`).set(headers)).body.passwordChangeRequired, false);
    // Sair continua liberado com a troca pedida.
    findStudent(ANA.email).mustChangePassword = true;
    assert.equal((await request(app).post('/api/student/leave').set(headers).send({})).status, 200);
});

test('[UC-SENHA-001] aluno troca a própria senha em Minha conta (sem troca pedida), com a senha atual', async () => {
    const headers = studentHeaders(ANA.email);
    const missing = await request(app).post('/api/student/change-password').set(headers).send({ newPassword: 'Ponte-Velha-48' });
    assert.equal(missing.status, 400);
    const ok = await request(app).post('/api/student/change-password').set(headers).send({ currentPassword: ANA.password, newPassword: 'Ponte-Velha-48' });
    assert.equal(ok.status, 200, ok.body.error);
    assert.equal(await db.verifyPasswordAsync(findStudent(ANA.email).password, 'Ponte-Velha-48'), true);
    const anonymous = await request(app).post('/api/student/change-password').send({ email: ANA.email, currentPassword: 'Ponte-Velha-48', newPassword: 'Ponte-Velha-49' });
    assert.ok(anonymous.status === 400 || anonymous.status === 401, `só com sessão (${anonymous.status})`);
    assert.equal(await db.verifyPasswordAsync(findStudent(ANA.email).password, 'Ponte-Velha-48'), true);
});

test('[UC-SENHA-001] TEST_MODE (testes e modo demonstração) ignora a troca obrigatória e a senha fraca', async () => {
    await withTestMode(async () => {
        findStudent(ANA.email).mustChangePassword = true;
        findStudent(ANA.email).passwordChangeReason = 'reset';
        const login = await request(app).post('/api/student/login').send({ email: ANA.email, password: ANA.password });
        assert.equal(login.status, 200);
        assert.equal(login.body.mustChangePassword, false);
        assert.equal((await request(app).post('/api/student/notes/get').set('x-session-token', login.body.sessionToken).send({ moduleKey: 'geral' })).status, 200);
        findStudent(ANA.email).mustChangePassword = false;
        findStudent(ANA.email).password = db.hashPassword('teste');
        const weak = await request(app).post('/api/student/login').send({ email: ANA.email, password: 'teste' });
        assert.equal(weak.status, 200);
        assert.notEqual(findStudent(ANA.email).mustChangePassword, true, 'senha "teste" das contas demo não pede troca');
    });
});

test('[UC-SENHA-001] login com senha fraca pede a troca (motivo weak)', async () => {
    findStudent(ANA.email).password = db.hashPassword('123');
    const login = await request(app).post('/api/student/login').send({ email: ANA.email, password: '123' });
    assert.equal(login.status, 200, login.body.error);
    assert.equal(login.body.mustChangePassword, true);
    assert.equal(login.body.passwordChangeReason, 'weak');
    assert.equal(findStudent(ANA.email).mustChangePassword, true);
    const page = await request(app).post('/api/student/notes/get').set('x-session-token', login.body.sessionToken).send({ moduleKey: 'geral' });
    assert.equal(page.status, 403);
    assert.equal(page.body.passwordChangeReason, 'weak');
});

test('[UC-SENHA-001] prova em andamento: a troca não interrompe a prova e fica para o próximo acesso', async () => {
    db.memory.examApplications = [{ id: 'app_senha', status: 'running', courseId: 'DES', studentClass: '1DES', examKey: 'Avaliacao_DES_1' }];
    db.memory.studentExamState = { tentativa: { studentEmail: ANA.email, applicationId: 'app_senha', status: 'in_progress' } };
    // Senha fraca no login durante a prova: não marca agora.
    findStudent(ANA.email).password = db.hashPassword('123');
    const weakLogin = await request(app).post('/api/student/login').send({ email: ANA.email, password: '123' });
    assert.equal(weakLogin.status, 200);
    assert.equal(weakLogin.body.mustChangePassword, false);
    assert.notEqual(findStudent(ANA.email).mustChangePassword, true);

    // Troca já pedida (o professor redefiniu durante a prova): a sessão da prova segue.
    findStudent(ANA.email).mustChangePassword = true;
    findStudent(ANA.email).passwordChangeReason = 'reset';
    const headers = { 'x-session-token': weakLogin.body.sessionToken };
    assert.equal((await request(app).post('/api/student/notes/get').set(headers).send({ moduleKey: 'geral' })).status, 200);
    // A prova acabou: a mesma sessão ainda segue sem a troca (até o fim dela).
    db.memory.studentExamState.tentativa.status = 'submitted';
    db.memory.examApplications[0].status = 'finished';
    assert.equal((await request(app).post('/api/student/notes/get').set(headers).send({ moduleKey: 'geral' })).status, 200);
    assert.equal((await request(app).get(`/api/ping?email=${encodeURIComponent(ANA.email)}`).set(headers)).body.passwordChangeRequired, false);
    // Próximo acesso: a troca vale.
    const next = await request(app).post('/api/student/login').send({ email: ANA.email, password: '123' });
    assert.equal(next.body.mustChangePassword, true);
    assert.equal((await request(app).post('/api/student/notes/get').set('x-session-token', next.body.sessionToken).send({ moduleKey: 'geral' })).status, 403);
});

// --- Contas de instrutor ------------------------------------------------------------

test('[UC-SENHA-001] contas de instrutor: política, troca no primeiro acesso, senha fraca no login e auditoria', async () => {
    const headers = adminHeaders();
    const base = { email: 'prof.lia@contas.local', name: 'Lia Professora', role: 'professor' };
    const weak = await request(app).post('/api/admin/accounts/create').set(headers).send({ ...base, password: '1' });
    assert.equal(weak.status, 400, 'antes, 200 com a senha "1"');
    assert.equal(weak.body.passwordPolicy, true);
    const short = await request(app).post('/api/admin/accounts/create').set(headers).send({ ...base, password: 'Giz-Azul9' });
    assert.match(short.body.error, /pelo menos 10/);

    const created = await request(app).post('/api/admin/accounts/create').set(headers).send({ ...base, password: 'Giz-Azul-2026' });
    assert.equal(created.status, 200, created.body.error);
    assert.equal(created.body.mustChangePassword, true);
    const lia = db.memory.admins.find(account => account.email === base.email);
    assert.equal(lia.passwordChangeReason, 'created');
    const [createdAudit] = auditOf('account_created');
    assert.equal(createdAudit.targetEmail, base.email);
    assert.doesNotMatch(JSON.stringify(createdAudit), /Giz-Azul-2026/);

    const unchecked = await request(app).post('/api/admin/accounts/create').set(headers)
        .send({ ...base, email: 'prof.rui@contas.local', password: 'Giz-Verde-2026', requirePasswordChange: false });
    assert.equal(unchecked.body.mustChangePassword, false);

    const updated = await request(app).post('/api/admin/accounts/update').set(headers).send({ email: base.email, name: 'Lia Souza', role: 'professor', assignedClasses: [], additionalPermissions: [] });
    assert.equal(updated.status, 200, updated.body.error);
    assert.equal(auditOf('account_updated').at(-1).after.name, 'Lia Souza');
    const removed = await request(app).post('/api/admin/accounts/delete').set(headers).send({ email: 'prof.rui@contas.local' });
    assert.equal(removed.status, 200, removed.body.error);
    assert.equal(auditOf('account_deleted').at(-1).targetEmail, 'prof.rui@contas.local');

    // Conta criada pelo administrador: a troca obrigatória pede a senha recebida.
    const liaToken = createAdminSession(db.memory, base.email);
    const blocked = await request(app).get('/api/admin/students').set('x-admin-session', liaToken);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.passwordChangeRequired, true);
    const noCurrent = await request(app).post('/api/admin/change-password').set('x-admin-session', liaToken).send({ newPassword: 'Mesa-Redonda-77' });
    assert.equal(noCurrent.status, 400);
    assert.equal(noCurrent.body.currentPasswordRequired, true);
    const changed = await request(app).post('/api/admin/change-password').set('x-admin-session', liaToken)
        .send({ currentPassword: 'Giz-Azul-2026', newPassword: 'Mesa-Redonda-77' });
    assert.equal(changed.status, 200, changed.body.error);
    assert.equal(auditOf('account_password_changed').at(-1).details.forced, true);
    assert.equal(db.memory.admins.find(account => account.email === base.email).mustChangePassword, false);
});

test('[UC-SENHA-001] instrutor com senha fraca no login: troca pedida (weak), com a senha atual', async () => {
    db.memory.admins[0].password = db.hashPassword('admin');
    const login = await request(app).post('/api/session/admin-login').send({ email: ADMIN.email, password: 'admin' });
    assert.equal(login.status, 200, login.body.error);
    assert.equal(login.body.mustChangePassword, true);
    assert.equal(login.body.passwordChangeReason, 'weak');
    const token = login.body.sessionToken;
    assert.equal((await request(app).get('/api/admin/students').set('x-admin-session', token)).status, 403);
    const noCurrent = await request(app).post('/api/admin/change-password').set('x-admin-session', token).send({ newPassword: 'Mesa-Redonda-77' });
    assert.equal(noCurrent.body.currentPasswordRequired, true, 'sessão roubada não troca a senha sem a atual');
    const ok = await request(app).post('/api/admin/change-password').set('x-admin-session', token).send({ currentPassword: 'admin', newPassword: 'Mesa-Redonda-77' });
    assert.equal(ok.status, 200, ok.body.error);
    assert.equal((await request(app).get('/api/admin/students').set('x-admin-session', token)).status, 200);
});

// --- Hashes antigos (SEG-X2) --------------------------------------------------------

test('[UC-SENHA-002] hashes SHA-256 antigos viram scrypt-sha256$ sem a senha, e o login passa para scrypt$', async () => {
    findStudent(ANA.email).password = legacySha(ANA.password);
    db.memory.admins[0].password = legacySha(ADMIN.password).toUpperCase();
    db.memory.config.adminPassword = legacySha('senha-antiga-config');
    db.memory.students.push({ name: 'Moderno', email: 'moderno@contas.local', status: 'Ativo', password: db.hashPassword('Moderno-2026') });
    const modern = findStudent('moderno@contas.local').password;
    assert.equal(db.countLegacyPasswordHashes(db.memory), 3);

    assert.equal(await db.upgradeLegacyPasswordHashes(db.memory), 3);
    assert.match(findStudent(ANA.email).password, /^scrypt-sha256\$/);
    assert.match(db.memory.admins[0].password, /^scrypt-sha256\$/);
    assert.match(db.memory.config.adminPassword, /^scrypt-sha256\$/);
    assert.equal(findStudent('moderno@contas.local').password, modern, 'scrypt$ fica como está');
    assert.equal(await db.verifyPasswordAsync(findStudent(ANA.email).password, ANA.password), true);
    assert.equal(await db.verifyPasswordAsync(db.memory.admins[0].password, ADMIN.password), true);
    assert.equal(await db.verifyPasswordAsync(db.memory.config.adminPassword, 'senha-antiga-config'), true);
    // Rodar de novo não muda nada.
    const snapshot = JSON.stringify([db.memory.students, db.memory.admins, db.memory.config.adminPassword]);
    assert.equal(db.countLegacyPasswordHashes(db.memory), 0);
    assert.equal(await db.upgradeLegacyPasswordHashes(db.memory), 0);
    assert.equal(JSON.stringify([db.memory.students, db.memory.admins, db.memory.config.adminPassword]), snapshot);

    const login = await request(app).post('/api/student/login').send({ email: ANA.email, password: ANA.password });
    assert.equal(login.status, 200, login.body.error);
    assert.match(findStudent(ANA.email).password, /^scrypt\$/, 'no login a conta passa para scrypt$');
});

test('[UC-SENHA-002] boot converte os hashes antigos do banco antes de atender, com aviso só quando há o que converter', () => {
    const bootRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-account-security-boot-'));
    const env = {
        ...process.env,
        ICLASS_DATA_DIR: bootRoot,
        ICLASS_CONTENT_DIR: path.join(bootRoot, 'content'),
        ICLASS_ARCHIVE_DIR: path.join(bootRoot, 'archives'),
        TEST_MODE: '1',
    };
    const databasePath = JSON.stringify(require.resolve('../../backend/database.js'));
    const run = script => require('node:child_process').execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
    try {
        run(`(async () => { const db = require(${databasePath}); await db.init();
            db.memory.students = [{ name: 'Ex-aluno', email: 'ex@contas.local', status: 'Inativo', password: ${JSON.stringify(legacySha('Ex-Aluno-2019'))} }];
            await db.save(); await db.close(); })().catch(e => { console.error(e); process.exit(1); });`);
        const boot = `(async () => { const db = require(${databasePath}); await db.init();
            const s = db.memory.students.find(x => x.email === 'ex@contas.local');
            console.log('@@' + JSON.stringify({ password: s.password, ok: await db.verifyPasswordAsync(s.password, 'Ex-Aluno-2019') }));
            await db.close(); })().catch(e => { console.error(e); process.exit(1); });`;
        const first = run(boot);
        assert.match(first, /Protegendo 1 senha\(s\) no formato antigo/);
        const firstResult = JSON.parse(first.slice(first.indexOf('@@') + 2));
        assert.match(firstResult.password, /^scrypt-sha256\$/, 'o hash antigo de quem não entra mais também é protegido');
        assert.equal(firstResult.ok, true);
        const second = run(boot);
        assert.doesNotMatch(second, /Protegendo/, 'segundo boot não tem o que converter');
        assert.equal(JSON.parse(second.slice(second.indexOf('@@') + 2)).password, firstResult.password, 'o valor gravado não muda');
    } finally {
        fs.rmSync(bootRoot, { recursive: true, force: true });
    }
});

test('[UC-SENHA-002] restaurar backup antigo com hash SHA-256 grava scrypt-sha256$ e o aluno continua entrando', async () => {
    const backup = require('../../backend/utils/backup.js');
    const snapshot = backup.buildDataSnapshot();
    const anaInBackup = snapshot.data.students.find(student => student.email === ANA.email);
    anaInBackup.password = legacySha(ANA.password);
    const res = await request(app).post('/api/admin/backup/restore').set(adminHeaders())
        .field('confirm', 'RESTAURAR')
        .attach('file', Buffer.from(JSON.stringify(snapshot)), 'backup-antigo.json');
    assert.equal(res.status, 200, res.body.error);
    assert.match(findStudent(ANA.email).password, /^scrypt-sha256\$/);
    const login = await request(app).post('/api/student/login').send({ email: ANA.email, password: ANA.password });
    assert.equal(login.status, 200, login.body.error);
});
