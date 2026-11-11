// Endereço da sala (H6a, OPS-10). Antes: os IPs eram lidos uma vez só, ao subir
// (detectIP em middlewares.js), o GET /api/admin/network-info devolvia [{ name, address }]
// sem esquema nem porta (quem digitava só o IP no celular caía na porta 80), adaptador de
// máquina virtual aparecia como "recomendado" e não havia QR nem rota para o professor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-network-addresses-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { createAdminSession } = require('../../backend/utils/authSessions.js');
const networkAddresses = require('../../backend/utils/networkAddresses.js');
const { resolveAdminApiPermission } = require('../../backend/utils/adminPermissions.js');

const SALA = {
    'Wi-Fi': [
        { family: 'IPv6', address: 'fe80::1', internal: false },
        { family: 'IPv4', address: '192.168.0.10', internal: false },
    ],
    'vEthernet (WSL)': [{ family: 'IPv4', address: '172.20.0.1', internal: false }],
    'VirtualBox Host-Only Network': [{ family: 'IPv4', address: '192.168.56.1', internal: false }],
    'Ethernet 3': [{ family: 'IPv4', address: '169.254.3.4', internal: false }],
    'Loopback Pseudo-Interface 1': [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
};

let interfaces = SALA;
const provider = () => interfaces;

const ADMIN = { email: 'adm@endereco.local' };
const PROF = { email: 'prof@endereco.local' };
let app;
const tokens = {};

function seed() {
    db.memory.config = { ...(db.memory.config || {}), settings: {} };
    db.memory.admins = [
        { email: ADMIN.email, name: 'Admin', role: 'admin', password: db.hashPassword('senha-adm-123') },
        { email: PROF.email, name: 'Prof', role: 'professor', password: db.hashPassword('senha-prof-123'), assignedClasses: [] },
    ];
    db.memory.adminSessions = {};
    tokens.admin = createAdminSession(db.memory, ADMIN.email);
    tokens.prof = createAdminSession(db.memory, PROF.email);
}

test.before(async () => {
    await db.init();
    app = createApp();
});
test.beforeEach(() => {
    interfaces = SALA;
    networkAddresses.setInterfaceProvider(provider);
    seed();
});
test.after(async () => {
    networkAddresses.setInterfaceProvider(null);
    await new Promise(resolve => setTimeout(resolve, 500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-REDE-002] classifica os adaptadores e recomenda o Wi-Fi, com esquema e porta', () => {
    const snapshot = networkAddresses.networkAddresses({ port: 3000 });
    assert.deepEqual(snapshot.recommended, { name: 'Wi-Fi', address: '192.168.0.10', kind: 'rede', url: 'http://192.168.0.10:3000' });
    const byName = Object.fromEntries(snapshot.addresses.map(item => [item.name, item]));
    assert.equal(byName['vEthernet (WSL)'].kind, 'virtual');
    assert.equal(byName['VirtualBox Host-Only Network'].kind, 'virtual');
    assert.equal(byName['Ethernet 3'].kind, 'link-local');
    assert.equal(byName['Ethernet 3'].url, 'http://169.254.3.4:3000');
    // IPv6 e loopback ficam de fora; só um recomendado.
    assert.equal(snapshot.addresses.length, 4);
    assert.equal(snapshot.addresses.filter(item => item.recommended).length, 1);
    assert.equal(networkAddresses.networkAddresses({ port: 3000, scheme: 'https' }).recommended.url, 'https://192.168.0.10:3000');
});

test('[UC-REDE-002] ordem do recomendado: privado com nome de Wi-Fi/Ethernet, privado, qualquer da rede, virtual, link-local', () => {
    const cases = [
        // "Conexão Local* 2" (hotspot/Wi-Fi Direct do Windows) não passa à frente da Ethernet.
        [{ 'Conexão Local* 2': [{ family: 'IPv4', address: '10.1.2.3' }], Ethernet: [{ family: 'IPv4', address: '10.1.2.4' }] }, '10.1.2.4'],
        [{ 'Rede da escola': [{ family: 'IPv4', address: '100.70.0.2' }], 'Adaptador 2': [{ family: 'IPv4', address: '172.16.5.5' }] }, '172.16.5.5'],
        [{ 'Rede da escola': [{ family: 'IPv4', address: '100.70.0.2' }], 'VMware Network Adapter VMnet8': [{ family: 'IPv4', address: '192.168.80.1' }] }, '100.70.0.2'],
        [{ 'Tailscale': [{ family: 'IPv4', address: '100.101.1.1' }], 'Wi-Fi': [{ family: 'IPv4', address: '169.254.9.9' }] }, '100.101.1.1'],
        [{ 'Wi-Fi': [{ family: 'IPv4', address: '169.254.9.9' }] }, '169.254.9.9'],
        // Node 18.0 a 18.3 devolvia family como número.
        [{ wlan0: [{ family: 4, address: '192.168.1.20' }] }, '192.168.1.20'],
    ];
    cases.forEach(([list, expected]) => {
        networkAddresses.setInterfaceProvider(() => list);
        assert.equal(networkAddresses.networkAddresses({ port: 3000 }).recommended.address, expected, JSON.stringify(list));
    });
    networkAddresses.setInterfaceProvider(() => ({ lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] }));
    const offline = networkAddresses.networkAddresses({ port: 3000 });
    assert.equal(offline.recommended, null);
    assert.deepEqual(offline.addresses, []);
});

test('[UC-REDE-002] os adaptadores são relidos depois de 2 s (o IP do boot não fica congelado)', () => {
    const t0 = 1_000_000;
    networkAddresses.networkAddresses({ port: 3000, now: t0 });
    interfaces = { 'Wi-Fi': [{ family: 'IPv4', address: '192.168.0.77', internal: false }] };
    assert.equal(networkAddresses.networkAddresses({ port: 3000, now: t0 + 1000 }).recommended.address, '192.168.0.10', 'dentro do cache');
    assert.equal(networkAddresses.networkAddresses({ port: 3000, now: t0 + 2001 }).recommended.address, '192.168.0.77', 'depois do cache');
});

test('[UC-REDE-002] GET /api/admin/network-info: objeto com o recomendado e a url de cada adaptador', async () => {
    const res = await request(app).get('/api/admin/network-info').set('x-admin-session', tokens.admin).expect(200);
    assert.equal(Array.isArray(res.body), false);
    assert.equal(res.body.port, 3000);
    assert.equal(res.body.recommended.url, 'http://192.168.0.10:3000');
    assert.equal(res.body.addresses.length, 4);
    res.body.addresses.forEach(item => assert.match(item.url, /^http:\/\/[\d.]+:3000$/));
    // Sem o certificado preparado (supertest, sem startServer): conexão segura indisponível (H6c).
    assert.equal(res.body.https.available, false);
    assert.equal(res.body.https.studentsHttps, false);
    assert.equal(res.body.https.url, null);
    assert.equal(res.body.hostname, null);
    assert.equal(res.body.adminAccess, 'rede-sem-https');
    await request(app).get('/api/admin/network-info').expect(401);
});

test('[UC-REDE-002] GET /api/admin/room-address: o professor recebe o endereço e o QR dele', async () => {
    const res = await request(app).get('/api/admin/room-address').set('x-admin-session', tokens.prof).expect(200);
    assert.equal(res.body.studentUrl, 'http://192.168.0.10:3000');
    assert.equal(res.body.studentsHttps, false);
    assert.equal(res.body.nameUrl, null);
    assert.equal(res.body.mdnsState, 'desligado');
    assert.deepEqual(res.body.adapter, { name: 'Wi-Fi', address: '192.168.0.10', kind: 'rede' });
    const { encodeQr } = require('../../backend/utils/qrCode.js');
    assert.deepEqual(res.body.qr.rows, encodeQr('http://192.168.0.10:3000').rows, 'o QR codifica studentUrl');
    assert.equal(res.body.qr.size, res.body.qr.rows.length);
    await request(app).get('/api/admin/room-address').expect(401);
});

test('[UC-REDE-002] o QR acompanha a troca de rede, e sem rede nenhuma a rota diz isso', async () => {
    interfaces = { 'Wi-Fi': [{ family: 'IPv4', address: '10.0.0.42', internal: false }] };
    networkAddresses.setInterfaceProvider(provider);
    const changed = await request(app).get('/api/admin/room-address').set('x-admin-session', tokens.prof).expect(200);
    assert.equal(changed.body.studentUrl, 'http://10.0.0.42:3000');
    interfaces = {};
    networkAddresses.setInterfaceProvider(provider);
    const offline = await request(app).get('/api/admin/room-address').set('x-admin-session', tokens.prof).expect(200);
    assert.equal(offline.body.studentUrl, null);
    assert.equal(offline.body.qr, null);
});

test('[UC-REDE-002] RBAC: room-address para quem vê o Dashboard ou o Monitor; network-info segue com page.system', async () => {
    assert.deepEqual(resolveAdminApiPermission('GET', '/room-address'), ['page.dashboard', 'page.monitor']);
    assert.equal(resolveAdminApiPermission('GET', '/network-info'), 'page.system');
    // Professor sem page.system (padrão) não lê network-info.
    await request(app).get('/api/admin/network-info').set('x-admin-session', tokens.prof).expect(403);
});

test('[UC-REDE-002] serverUrl de /api/admin/config usa o mesmo endereço recomendado (antes podia ser o do VirtualBox)', async () => {
    interfaces = {
        'VirtualBox Host-Only Network': [{ family: 'IPv4', address: '192.168.56.1', internal: false }],
        'vEthernet (Default Switch)': [{ family: 'IPv4', address: '172.30.0.1', internal: false }],
        'Wi-Fi': [{ family: 'IPv4', address: '192.168.0.10', internal: false }],
    };
    networkAddresses.setInterfaceProvider(provider);
    const res = await request(app).post('/api/admin/config').set('x-admin-session', tokens.admin).send({}).expect(200);
    assert.equal(res.body.serverUrl, 'http://192.168.0.10:3000');
});

test('[UC-REDE-002] linhas do console: endereço para os alunos, virtuais marcados, painel conforme a regra e firewall', () => {
    const lines = networkAddresses.consoleLines({ port: 3000, adminAccess: 'local' });
    assert.match(lines[0], /^Para os alunos: http:\/\/192\.168\.0\.10:3000 /);
    assert.ok(lines.some(line => /172\.20\.0\.1:3000.*virtual, não use/.test(line)));
    assert.ok(lines.some(line => /169\.254\.3\.4:3000.*não use/.test(line)));
    assert.ok(lines.includes('Painel do professor: só neste computador (http://localhost:3000).'));
    assert.ok(lines.some(line => /porta TCP 3000/.test(line)));
    assert.ok(networkAddresses.consoleLines({ port: 3000 }).some(line => /também nos outros aparelhos da rede, sem conexão segura/.test(line)));
    networkAddresses.setInterfaceProvider(() => ({}));
    assert.match(networkAddresses.consoleLines({ port: 3000 })[0], /não está ligado a nenhuma rede/);
});

test('[UC-REDE-002] vigia da rede: avisa no console quando o endereço muda, uma vez por mudança', () => {
    const logs = [];
    const changes = [];
    const watcher = networkAddresses.createAddressWatcher({ port: 3000, log: line => logs.push(line), onChange: (now, before) => changes.push([now.recommended && now.recommended.address, before.recommended && before.recommended.address]) });
    assert.equal(watcher.check(), false);
    interfaces = { 'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.50', internal: false }] };
    networkAddresses.setInterfaceProvider(provider);
    assert.equal(watcher.check(), true);
    assert.equal(watcher.check(), false);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /Endereço da rede mudou: http:\/\/192\.168\.1\.50:3000 \(antes: http:\/\/192\.168\.0\.10:3000\)/);
    assert.deepEqual(changes, [['192.168.1.50', '192.168.0.10']]);
    interfaces = {};
    networkAddresses.setInterfaceProvider(provider);
    assert.equal(watcher.check(), true);
    assert.match(logs[1], /mudou: sem rede \(antes: http:\/\/192\.168\.1\.50:3000\)/);
});

test('[UC-REDE-005] vigia da rede: ligar o https dos alunos troca o esquema sem contar como rede nova', () => {
    const logs = [];
    const changes = [];
    let scheme = 'http';
    const watcher = networkAddresses.createAddressWatcher({ port: 3000, scheme: () => scheme, log: line => logs.push(line), onChange: now => changes.push(now.recommended && now.recommended.url) });
    assert.equal(watcher.check(), false);
    scheme = 'https';
    // Antes, a troca de esquema aparecia como "Endereço da rede mudou" e refazia o certificado.
    assert.equal(watcher.check(), false, 'a rede não mudou');
    assert.deepEqual(changes, []);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^🔄 Endereço para os alunos agora é https:\/\/192\.168\.0\.10:3000 \(antes: http:\/\/192\.168\.0\.10:3000\)\.$/);
    assert.equal(watcher.current().recommended.url, 'https://192.168.0.10:3000');
    assert.equal(watcher.check(), false);
    assert.equal(logs.length, 1, 'uma vez por troca');
    interfaces = { 'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.50', internal: false }] };
    networkAddresses.setInterfaceProvider(provider);
    assert.equal(watcher.check(), true);
    assert.deepEqual(changes, ['https://192.168.1.50:3000']);
});

test('[UC-REDE-002] com TEST_MODE, ICLASS_TEST_INTERFACES_FILE simula os adaptadores; fora dele é ignorado', () => {
    const file = path.join(tempRoot, 'interfaces.json');
    fs.writeFileSync(file, JSON.stringify({ 'Wi-Fi': [{ family: 'IPv4', address: '192.168.9.9', internal: false }] }));
    networkAddresses.setInterfaceProvider(null);
    process.env.ICLASS_TEST_INTERFACES_FILE = file;
    try {
        assert.equal(networkAddresses.networkAddresses({ port: 3000, now: 5_000_000 }).recommended.address, '192.168.9.9');
        process.env.TEST_MODE = '0';
        const real = networkAddresses.networkAddresses({ port: 3000, now: 6_000_000 });
        assert.notEqual(real.recommended && real.recommended.address, '192.168.9.9');
    } finally {
        process.env.TEST_MODE = '1';
        delete process.env.ICLASS_TEST_INTERFACES_FILE;
    }
});

test('[UC-REDE-002] o detectIP congelado saiu do middlewares.js e ninguém usa localIpAddresses', () => {
    const backendDir = path.join(__dirname, '..', '..', 'backend');
    const offenders = [];
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); return; }
        if (!entry.name.endsWith('.js')) return;
        const source = fs.readFileSync(full, 'utf8');
        if (/localIpAddresses|function detectIP/.test(source)) offenders.push(path.relative(backendDir, full));
    });
    walk(backendDir);
    assert.deepEqual(offenders, []);
});
