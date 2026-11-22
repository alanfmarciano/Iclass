// Minha conta do instrutor e "Redefinir senha" de outra conta do painel (fase 3, B1; UXI-07).
//
// Antes: o instrutor não tinha onde corrigir o próprio nome nem como encerrar a conta
// esquecida aberta em outro computador; e o administrador não tinha como redefinir a senha
// de uma conta do painel (só excluir e criar de novo, perdendo o histórico).
// Agora:
// - POST /api/admin/account/profile: cada conta corrige o próprio nome (também a
//   Coordenação, só consulta: é autoatendimento), com auditoria;
// - POST /api/admin/account/end-other-sessions: as outras sessões da conta recebem 401
//   ended_elsewhere; a deste pedido continua;
// - POST /api/admin/accounts/reset-password: só o administrador; gera a senha temporária
//   (ou aceita a digitada pela política do instrutor), pede a troca no próximo acesso
//   (motivo 'reset', com a temporária como senha atual) e encerra as sessões da conta.
// Este arquivo roda SEM o TEST_MODE (o TEST_MODE desliga a troca obrigatória).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-own-account-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
delete process.env.TEST_MODE;

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { createAdminSession } = require('../../backend/utils/authSessions.js');
const loginGuard = require('../../backend/utils/loginGuard.js');
const rateLimiter = require('../../backend/utils/rateLimit.js');
const passwordLogin = require('../../backend/utils/passwordLogin.js');
const security = require('../../backend/utils/security.js');
const { TEMPORARY_ALPHABET } = require('../../backend/utils/passwordPolicy.js');

const ADMIN = { email: 'adm@minhaconta.local', password: 'Painel-Seguro-2026' };
const PROF = { email: 'prof@minhaconta.local', password: 'Quadro-Verde-2026' };
const COORD = { email: 'coord@minhaconta.local', password: 'Relatorio-Mensal-26' };
const SCHOOL = 'escola_a';
let app;

function seed() {
    db.memory.config = { ...(db.memory.config || {}), settings: {} };
    db.memory.admins = [
        { email: ADMIN.email, name: 'Administração', role: 'admin', password: db.hashPassword(ADMIN.password) },
        { email: PROF.email, name: 'Prof Antigo', role: 'professor', password: db.hashPassword(PROF.password), assignedClasses: [{ courseId: 'DES', className: '1DES' }] },
        { email: COORD.email, name: 'Coordenação', role: 'coordenacao', password: db.hashPassword(COORD.password), assignedSchoolIds: [SCHOOL] },
    ];
    db.memory.schools = [{ id: SCHOOL, name: 'Escola A' }];
    db.memory.students = [];
    db.memory.sessions = {};
    db.memory.adminSessions = {};
    db.memory.classes = [{ name: '1DES', courseId: 'DES', schoolId: SCHOOL }];
    db.memory.courses = [{ id: 'DES', name: 'Desenvolvimento', schoolId: SCHOOL }];
    db.memory.loginLogs = [];
    db.memory.auditLogs = [];
    db.memory.examApplications = [];
    db.memory.studentExamState = {};
}

const token = email => createAdminSession(db.memory, email);
const post = (tok, url, body) => request(app).post(url).set('x-admin-session', tok).send(body);
const whoami = tok => request(app).get('/api/admin/whoami').set('x-admin-session', tok);
const account = email => db.memory.admins.find(item => item.email === email);
const auditOf = action => db.memory.auditLogs.filter(entry => entry.action === action);

test.before(async () => { await db.init(); app = createApp(); });
test.beforeEach(() => {
    delete process.env.TEST_MODE;
    seed();
    loginGuard.resetForTests();
    rateLimiter.resetForTests();
    passwordLogin.resetForTests();
    security.cancelLoginLogSave();
});
test.after(async () => {
    security.cancelLoginLogSave();
    await new Promise(resolve => setTimeout(resolve, 500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-CONTA-001] Minha conta: o professor corrige o próprio nome (espaços aparados) e só o dele; nome vazio é recusado', async () => {
    const prof = token(PROF.email);
    const saved = await post(prof, '/api/admin/account/profile', { name: '  Paula   de  Souza ' });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual([saved.body.name, saved.body.changed], ['Paula de Souza', true]);
    assert.equal(account(PROF.email).name, 'Paula de Souza');
    assert.equal(account(ADMIN.email).name, 'Administração', 'a rota não aceita mudar outra conta');
    const [entry] = auditOf('account_profile_updated');
    assert.equal(entry.actor, PROF.email);
    assert.equal(entry.targetEmail, PROF.email);
    assert.deepEqual([entry.before, entry.after], [{ name: 'Prof Antigo' }, { name: 'Paula de Souza' }]);

    // Um "email" no corpo não troca de conta: vale sempre a conta da sessão.
    const other = await post(prof, '/api/admin/account/profile', { name: 'Paula Souza', email: ADMIN.email });
    assert.equal(account(ADMIN.email).name, 'Administração', JSON.stringify(other.body));
    assert.notEqual(account(PROF.email).name, 'Prof Antigo');

    const empty = await post(prof, '/api/admin/account/profile', { name: '   ' });
    assert.equal(empty.status, 400);
    assert.deepEqual([empty.body.error, empty.body.field], ['Informe o seu nome.', 'name']);
    const tooLong = await post(prof, '/api/admin/account/profile', { name: 'x'.repeat(121) });
    assert.equal(tooLong.status, 400);

    // Mesmo nome: nada muda e nada vai para a auditoria.
    const before = db.memory.auditLogs.length;
    const same = await post(prof, '/api/admin/account/profile', { name: account(PROF.email).name });
    assert.deepEqual([same.status, same.body.changed], [200, false]);
    assert.equal(db.memory.auditLogs.length, before);
    // O nome novo chega pelo whoami (o avatar do topo usa as iniciais dele).
    const who = await whoami(prof).expect(200);
    assert.equal(who.body.name, account(PROF.email).name);
});

test('[UC-CONTA-001] Minha conta: a Coordenação (só consulta) também corrige o próprio nome e sai dos outros aparelhos', async () => {
    const coord = token(COORD.email);
    const saved = await post(coord, '/api/admin/account/profile', { name: 'Coordenação Pedagógica' });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(account(COORD.email).name, 'Coordenação Pedagógica');
    const ended = await post(coord, '/api/admin/account/end-other-sessions', {});
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
    // Fora do autoatendimento a coordenação continua só consultando.
    const refused = await post(coord, '/api/admin/accounts/reset-password', { email: PROF.email });
    assert.equal(refused.status, 403);
});

test('[UC-CONTA-001] "Sair dos outros aparelhos": as outras sessões recebem 401 ended_elsewhere; a deste aparelho continua', async () => {
    const here = token(PROF.email);
    const there = token(PROF.email);
    const third = token(PROF.email);
    const adminSession = token(ADMIN.email);
    const ended = await post(here, '/api/admin/account/end-other-sessions', {});
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
    assert.equal(ended.body.endedSessions, 2);
    assert.equal(ended.body.message, '2 outros aparelhos saíram desta conta.');
    await whoami(here).expect(200);
    const gone = await whoami(there);
    assert.equal(gone.status, 401);
    assert.deepEqual([gone.body.sessionRevoked, gone.body.reason], [true, 'ended_elsewhere']);
    assert.match(gone.body.error, /Sair dos outros aparelhos/);
    assert.equal((await whoami(third)).status, 401);
    await whoami(adminSession).expect(200);
    const [entry] = auditOf('account_sessions_ended');
    assert.deepEqual([entry.actor, entry.details.endedSessions], [PROF.email, 2]);

    const again = await post(here, '/api/admin/account/end-other-sessions', {});
    assert.deepEqual([again.body.endedSessions, again.body.message], [0, 'Nenhum outro aparelho estava com esta conta aberta.']);
    const one = token(PROF.email);
    const single = await post(here, '/api/admin/account/end-other-sessions', {});
    assert.equal(single.body.message, '1 outro aparelho saiu desta conta.');
    assert.equal((await whoami(one)).status, 401);
});

test('[UC-CONTA-002] Redefinir senha: o administrador gera a temporária; a conta sai de todos os aparelhos e troca a senha no próximo acesso', async () => {
    const admin = token(ADMIN.email);
    const profSession = token(PROF.email);
    const reset = await post(admin, '/api/admin/accounts/reset-password', { email: PROF.email });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assert.equal(reset.body.mustChangePassword, true);
    assert.equal(reset.body.endedSessions, 1);
    const temporary = reset.body.temporaryPassword;
    assert.match(temporary, new RegExp(`^[${TEMPORARY_ALPHABET}]{5}-[${TEMPORARY_ALPHABET}]{5}$`));
    const stored = account(PROF.email);
    assert.deepEqual([stored.mustChangePassword, stored.passwordChangeReason], [true, 'reset']);
    assert.notEqual(stored.password, temporary, 'a senha fica só como hash');

    // A sessão aberta do professor acaba com o texto do administrador (não "do professor").
    const gone = await whoami(profSession);
    assert.equal(gone.status, 401);
    assert.deepEqual([gone.body.reason, gone.body.sessionRevoked], ['password_reset', true]);
    assert.match(gone.body.error, /redefinida pelo administrador/);

    // A senha antiga não entra; a temporária entra e pede a troca.
    const old = await request(app).post('/api/session/admin-login').send(PROF);
    assert.notEqual(old.status, 200);
    const login = await request(app).post('/api/session/admin-login').send({ email: PROF.email, password: temporary }).expect(200);
    assert.equal(login.body.mustChangePassword, true);
    const fresh = login.body.sessionToken;
    const blocked = await request(app).get('/api/admin/classes').set('x-admin-session', fresh);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.passwordChangeRequired, true);
    assert.equal(blocked.body.passwordChangeReason, 'reset');

    // A troca pede a temporária como senha atual (sessão roubada não troca sem ela).
    const noCurrent = await post(fresh, '/api/admin/change-password', { newPassword: 'Caderno-Novo-2026' });
    assert.equal(noCurrent.status, 400);
    assert.equal(noCurrent.body.currentPasswordRequired, true);
    const changed = await post(fresh, '/api/admin/change-password', { currentPassword: temporary, newPassword: 'Caderno-Novo-2026' });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(account(PROF.email).mustChangePassword, false);
    await request(app).get('/api/admin/classes').set('x-admin-session', fresh).expect(200);

    // Auditoria de segurança, sem a senha.
    const [entry] = auditOf('account_password_reset');
    assert.deepEqual([entry.category, entry.actor, entry.targetEmail], ['security', ADMIN.email, PROF.email]);
    assert.deepEqual(entry.details, { mode: 'generated', mustChangePassword: true, endedSessions: 1 });
    assert.equal(JSON.stringify(db.memory.auditLogs).includes(temporary), false);
});

test('[UC-CONTA-002] Redefinir senha: digitada passa pela política do instrutor; a própria conta, outra que não existe e quem não é administrador são recusados', async () => {
    const admin = token(ADMIN.email);
    const weak = await post(admin, '/api/admin/accounts/reset-password', { email: PROF.email, newPassword: '123' });
    assert.equal(weak.status, 400);
    assert.equal(weak.body.field, 'newPassword');
    const typed = await post(admin, '/api/admin/accounts/reset-password', { email: PROF.email, newPassword: 'Janela-Clara-2026' });
    assert.equal(typed.status, 200, JSON.stringify(typed.body));
    assert.equal(typed.body.temporaryPassword, undefined, 'a digitada não volta na resposta');
    assert.equal(auditOf('account_password_reset').pop().details.mode, 'typed');
    assert.equal(JSON.stringify(db.memory.auditLogs).includes('Janela-Clara-2026'), false);
    await request(app).post('/api/session/admin-login').send({ email: PROF.email, password: 'Janela-Clara-2026' }).expect(200);

    const self = await post(admin, '/api/admin/accounts/reset-password', { email: ADMIN.email });
    assert.equal(self.status, 400);
    assert.match(self.body.error, /use Minha conta/);
    const missing = await post(admin, '/api/admin/accounts/reset-password', { email: 'ninguem@minhaconta.local' });
    assert.equal(missing.status, 404);

    const prof = token(PROF.email);
    const byProf = await post(prof, '/api/admin/accounts/reset-password', { email: COORD.email });
    assert.equal(byProf.status, 403);
    assert.equal(account(COORD.email).mustChangePassword, undefined);
});

test('[UC-CONTA-002] Redefinir senha libera o atraso de login da conta (5 senhas erradas)', async () => {
    for (let i = 0; i < 6; i++) {
        await request(app).post('/api/session/admin-login').send({ email: PROF.email, password: `errada-${i}-xyz` });
    }
    assert.ok(loginGuard.protectionFor(loginGuard.accountKey('admin', PROF.email)), 'conta em espera');
    const reset = await post(token(ADMIN.email), '/api/admin/accounts/reset-password', { email: PROF.email });
    assert.equal(reset.status, 200);
    assert.equal(loginGuard.protectionFor(loginGuard.accountKey('admin', PROF.email)), null);
    await request(app).post('/api/session/admin-login').send({ email: PROF.email, password: reset.body.temporaryPassword }).expect(200);
});
