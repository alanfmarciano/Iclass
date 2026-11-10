// Sistema → Rede: onde o painel do professor abre (H6b, SEG-03). Só o administrador troca
// settings.network.adminAccess, pela rota própria, com registro na auditoria. O POST
// genérico de configurações não mexe no bloco (PROTECTED_SETTINGS_SECTIONS), e a opção
// 'rede' (só pela conexão segura) é recusada enquanto o IClass não tiver https (H6c).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-network-settings-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const settingsUtil = require('../../backend/utils/settings.js');
const { createAdminSession } = require('../../backend/utils/authSessions.js');

const ADMIN = { email: 'adm@rede-config.local' };
const PROF = { email: 'prof@rede-config.local' };
let app;
let adminToken;
let profToken;

function seed(settings = {}) {
    db.memory.config = { ...(db.memory.config || {}), settings };
    db.memory.admins = [
        { email: ADMIN.email, name: 'Admin', role: 'admin', password: db.hashPassword('senha-adm') },
        // Professor com "Executar manutenção": passa no RBAC, mas a rota recusa.
        { email: PROF.email, name: 'Prof', role: 'professor', password: db.hashPassword('senha-prof'), assignedClasses: [], additionalPermissions: ['system.manage'] },
    ];
    db.memory.students = [];
    db.memory.sessions = {};
    db.memory.adminSessions = {};
    db.memory.auditLogs = [];
    adminToken = createAdminSession(db.memory, ADMIN.email);
    profToken = createAdminSession(db.memory, PROF.email);
}

const asAdmin = req => req.set('x-admin-session', adminToken);
const asProf = req => req.set('x-admin-session', profToken);
const networkAudits = () => (db.memory.auditLogs || []).filter(entry => entry.action === 'network_settings_changed');

test.before(async () => { await db.init(); app = createApp(); });
test.beforeEach(() => { seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1000));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-REDE-001] GET network-settings: padrão do banco antigo, modos e se a conexão segura existe', async () => {
    const res = await asAdmin(request(app).get('/api/admin/network-settings')).expect(200);
    assert.deepEqual(res.body, {
        adminAccess: 'rede-sem-https',
        modes: ['rede-sem-https', 'local', 'rede'],
        httpsAvailable: false,
        thisComputer: true,
        secure: false,
    });
    // O professor com "Executar manutenção" vê a regra (o cartão mostra qual vale).
    await asProf(request(app).get('/api/admin/network-settings')).expect(200);
    await request(app).get('/api/admin/network-settings').expect(401);
});

test('[UC-REDE-001] administrador troca para "Só o computador do IClass" e a troca fica na auditoria', async () => {
    seed({ timezone: 'America/Sao_Paulo', network: { adminAccess: 'rede-sem-https', futuro: 'mantido' } });
    const res = await asAdmin(request(app).post('/api/admin/network-settings')).send({ adminAccess: 'local' }).expect(200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.network.adminAccess, 'local');
    assert.deepEqual(db.memory.config.settings.network, { adminAccess: 'local', futuro: 'mantido' }, 'campo que esta versão não conhece fica');
    assert.equal(db.memory.config.settings.timezone, 'America/Sao_Paulo');
    const audits = networkAudits();
    assert.equal(audits.length, 1);
    assert.equal(audits[0].category, 'system');
    assert.equal(JSON.stringify(audits[0]).includes(ADMIN.email), true, 'quem trocou fica registrado');
    assert.equal(JSON.stringify(audits[0]).includes('rede-sem-https'), true);
    assert.equal(JSON.stringify(audits[0]).includes('local'), true);
    // Mesmo valor de novo: nada muda, nada novo na auditoria.
    const again = await asAdmin(request(app).post('/api/admin/network-settings')).send({ adminAccess: 'local' }).expect(200);
    assert.equal(again.body.unchanged, true);
    assert.equal(networkAudits().length, 1);
    // E volta para "Todos os aparelhos da rede".
    await asAdmin(request(app).post('/api/admin/network-settings')).send({ adminAccess: 'rede-sem-https' }).expect(200);
    assert.equal(settingsUtil.networkSettings().adminAccess, 'rede-sem-https');
    assert.equal(networkAudits().length, 2);
});

test('[UC-REDE-001] "Outros aparelhos só com conexão segura" é recusado enquanto não há https, em português claro', async () => {
    const res = await asAdmin(request(app).post('/api/admin/network-settings')).send({ adminAccess: 'rede' });
    assert.equal(res.status, 409);
    assert.equal(res.body.success, false);
    assert.equal(res.body.field, 'adminAccess');
    assert.match(res.body.error, /ainda não pode ser usada: esta versão do IClass ainda não tem a conexão segura \(https\)/);
    assert.equal(settingsUtil.networkSettings().adminAccess, 'rede-sem-https');
    assert.equal(networkAudits().length, 0);
});

test('[UC-REDE-001] valor inválido é recusado sem gravar', async () => {
    for (const body of [{}, { adminAccess: 'todos' }, { adminAccess: 1 }, { adminAccess: null }, { adminAccess: ['local'] }, { adminAccess: { local: true } }]) {
        const res = await asAdmin(request(app).post('/api/admin/network-settings')).send(body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.deepEqual(res.body, { success: false, error: 'Escolha onde o painel do professor pode abrir.', field: 'adminAccess' });
    }
    assert.equal(db.memory.config.settings.network, undefined);
    assert.equal(networkAudits().length, 0);
});

test('[UC-REDE-001] professor não troca a regra, nem com "Executar manutenção"', async () => {
    const res = await asProf(request(app).post('/api/admin/network-settings')).send({ adminAccess: 'local' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'Só o administrador pode mudar onde o painel do professor abre.');
    assert.equal(db.memory.config.settings.network, undefined);
    assert.equal(networkAudits().length, 0);
});

test('[UC-REDE-001] o POST genérico de configurações não mexe nos blocos protegidos (rede, backup, retenção)', async () => {
    assert.deepEqual([...settingsUtil.PROTECTED_SETTINGS_SECTIONS], ['backup', 'network', 'retention']);
    seed({ network: { adminAccess: 'local' }, backup: { keep: 7 }, retention: { days: 30 } });
    const res = await asAdmin(request(app).post('/api/admin/settings')).send({
        timezone: 'America/Manaus',
        network: { adminAccess: 'rede-sem-https' },
        backup: { keep: 1 },
        retention: { days: 1 },
    }).expect(200);
    assert.equal(res.body.success, true);
    assert.equal(db.memory.config.settings.timezone, 'America/Manaus');
    assert.deepEqual(db.memory.config.settings.network, { adminAccess: 'local' });
    assert.deepEqual(db.memory.config.settings.backup, { keep: 7 });
    assert.deepEqual(db.memory.config.settings.retention, { days: 30 });
    // Sem bloco gravado, o POST genérico também não cria um.
    seed({});
    await asAdmin(request(app).post('/api/admin/settings')).send({ network: { adminAccess: 'local' } }).expect(200);
    assert.equal(db.memory.config.settings.network, undefined);
    assert.equal(settingsUtil.getSettings().network.adminAccess, 'rede-sem-https');
});

test('[UC-REDE-001] a regra gravada sobrevive ao reinício (vai para o banco)', async () => {
    await asAdmin(request(app).post('/api/admin/network-settings')).send({ adminAccess: 'local' }).expect(200);
    // Outro processo sobe o banco gravado (como o servidor ao ligar).
    const script = `const db = require(${JSON.stringify(require.resolve('../../backend/database.js'))});
const settingsUtil = require(${JSON.stringify(require.resolve('../../backend/utils/settings.js'))});
db.init().then(async () => { process.stdout.write('@@' + JSON.stringify(settingsUtil.networkSettings())); await db.close(); });`;
    const output = require('node:child_process').execFileSync(process.execPath, ['-e', script], { env: process.env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(output.slice(output.indexOf('@@') + 2)), { adminAccess: 'local' });
});
