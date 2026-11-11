// Conexão segura de ponta a ponta (H6c, SEG-03 e OPS-08, decisões §2 P1 e §6): o app real
// atrás do listener de http e https na mesma porta, com a CA e o certificado gerados numa
// pasta de dados temporária. Antes não havia https: 'rede' era recusado, o professor em
// outro aparelho só tinha o http (senha aberta no Wi-Fi) e não existia /iclass-ca.crt
// nem o guia /certificado.
//
// "Outro aparelho" é simulado com createApp({ network: { isThisComputer: () => false } }):
// a conexão cifrada (req.socket.encrypted) e o endereço seguro são os de verdade.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-https-e2e-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const runtimePaths = require('../../backend/runtimePaths.js');
const { createApp } = require('../../backend/server.js');
const settingsUtil = require('../../backend/utils/settings.js');
const secureConnection = require('../../backend/utils/secureConnection.js');
const { PUBLIC_UNAVAILABLE_TEXT } = secureConnection;
const consoleLinesOf = require('../../backend/utils/networkAddresses.js').consoleLines;
const { createDualServer } = require('../../backend/utils/dualListener.js');
const { setInterfaceProvider } = require('../../backend/utils/networkAddresses.js');
const { createAdminSession } = require('../../backend/utils/authSessions.js');
const backupUtil = require('../../backend/utils/backup.js');
const {
    ADMIN_PANEL_PAGES,
    HTTPS_REQUIRED_MESSAGE,
    HTTPS_UNAVAILABLE_MESSAGE,
    STUDENT_HTTPS_MESSAGE,
} = require('../../backend/utils/networkPolicy.js');

const ADMIN = { email: 'adm@https.local', password: 'Senha-adm-2026' };
const ANA = { email: 'ana@https.local', password: 'Senha-ana-2026' };
const INTERFACES = {
    'Wi-Fi': [{ address: '192.168.0.10', family: 'IPv4', internal: false }],
    'VirtualBox Host-Only Network': [{ address: '192.168.56.1', family: 'IPv4', internal: false }],
};
let material;
let remote;
let local;

function seed(network) {
    db.memory.config = { ...(db.memory.config || {}), settings: network === undefined ? {} : { network } };
    db.memory.admins = [{ email: ADMIN.email, name: 'Admin', role: 'admin', password: db.hashPassword(ADMIN.password) }];
    db.memory.students = [{ name: 'Ana', email: ANA.email, status: 'Ativo', password: db.hashPassword(ANA.password), classes: [] }];
    db.memory.sessions = {};
    db.memory.adminSessions = {};
    db.memory.loginLogs = [];
    db.memory.auditLogs = [];
    db.memory.examApplications = [];
}

async function startServer(options) {
    const app = createApp(options);
    const server = createDualServer((req, res) => app(req, res), { tls: material });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    app.set('serverInstance', server);
    return { app, server, port: server.address().port };
}

function send(scheme, port, { method = 'GET', path: pathName = '/', headers = {}, body, ca = material.ca.certPem } = {}) {
    const mod = scheme === 'https' ? https : http;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
        const req = mod.request({
            host: '127.0.0.1', port, path: pathName, method, agent: false,
            headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}), ...headers },
            ...(scheme === 'https' ? { ca } : {}),
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const raw = Buffer.concat(chunks);
                let json = null;
                try { json = JSON.parse(raw.toString('utf8')); } catch (e) { json = null; }
                resolve({ status: res.statusCode, headers: res.headers, raw, body: json, peer: res.socket && res.socket.getPeerCertificate ? res.socket.getPeerCertificate() : null });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

test.before(async () => {
    await db.init();
    setInterfaceProvider(() => INTERFACES);
    material = secureConnection.prepare({ dir: path.join(runtimePaths.DATA_DIR, 'tls'), addresses: [{ name: 'Wi-Fi', address: '192.168.0.10', kind: 'rede' }] });
    assert.ok(material, 'material TLS criado na pasta de dados');
    remote = await startServer({ network: { isThisComputer: () => false } });
    local = await startServer({});
});
test.beforeEach(() => { seed(); });
test.after(async () => {
    for (const item of [remote, local]) {
        if (!item) continue;
        item.server.closeAllConnections();
        await new Promise(resolve => item.server.close(() => resolve()));
    }
    setInterfaceProvider(null);
    secureConnection.resetForTests();
    await new Promise(resolve => setTimeout(resolve, 500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-REDE-005] "rede": o painel em outro aparelho entra pelo https e o http é recusado com o endereço seguro', async () => {
    seed({ adminAccess: 'rede' });
    const httpsUrl = `https://127.0.0.1:${remote.port}`;
    const viaHttps = await send('https', remote.port, { method: 'POST', path: '/api/session/admin-login', body: ADMIN });
    assert.equal(viaHttps.status, 200, JSON.stringify(viaHttps.body));
    const token = viaHttps.body.sessionToken;
    assert.equal((await send('https', remote.port, { path: '/api/admin/whoami', headers: { 'x-admin-session': token } })).status, 200);

    const viaHttp = await send('http', remote.port, { method: 'POST', path: '/api/session/admin-login', body: ADMIN });
    assert.equal(viaHttp.status, 403);
    assert.deepEqual(viaHttp.body, { error: HTTPS_REQUIRED_MESSAGE, adminAccess: 'https-required', httpsUrl });
    assert.match(viaHttp.body.error, /\/certificado/, 'o texto aponta para o guia do certificado');
    const apiHttp = await send('http', remote.port, { path: '/api/admin/whoami', headers: { 'x-admin-session': token } });
    assert.equal(apiHttp.status, 403);
    assert.equal(apiHttp.body.adminAccess, 'https-required');

    // As páginas do painel e o login do instrutor por http vão para o https (302, nunca 301).
    for (const page of ['/login?mode=admin', '/sistema', '/monitor', '/alunos/ana', '/endereco']) {
        const res = await send('http', remote.port, { path: page });
        assert.equal(res.status, 302, page);
        assert.equal(res.headers.location, `${httpsUrl}${page}`, page);
        assert.equal(res.headers['strict-transport-security'], undefined);
    }
    // A entrada dos alunos não: '/', o login do aluno e o portal continuam em http.
    for (const page of ['/', '/login', '/aluno', '/aluno/provas', '/certificado', '/assets/app.js']) {
        const res = await send('http', remote.port, { path: page });
        assert.notEqual(res.status, 302, page);
    }
    // O aluno entra por http como sempre.
    const student = await send('http', remote.port, { method: 'POST', path: '/api/student/login', body: ANA });
    assert.equal(student.status, 200, JSON.stringify(student.body));

    // No computador do IClass, http sem redirecionar.
    assert.equal((await send('http', local.port, { path: '/sistema' })).status === 302, false);
    assert.equal((await send('http', local.port, { method: 'POST', path: '/api/session/admin-login', body: ADMIN })).status, 200);

    // /api/connection conta para a tela de login o que fazer.
    const connection = await send('http', remote.port, { path: '/api/connection' });
    assert.equal(connection.body.adminAccess, 'https-required');
    assert.equal(connection.body.tlsAvailable, true);
    assert.equal(connection.body.httpsUrl, httpsUrl);
    const secureConnectionInfo = await send('https', remote.port, { path: '/api/connection' });
    assert.equal(secureConnectionInfo.body.secure, true);
    assert.equal(secureConnectionInfo.body.adminAccess, 'ok');
});

test('[UC-REDE-005] "rede-sem-https" (padrão): outro aparelho por http abre como antes, com aviso; por https, sem aviso', async () => {
    seed();
    const plain = await send('http', remote.port, { path: '/api/connection' });
    assert.equal(plain.body.adminAccess, 'ok');
    assert.equal(plain.body.insecureAdmin, true, 'aviso fixo com o link "Usar conexão segura"');
    assert.equal(plain.body.tlsAvailable, true);
    assert.equal((await send('http', remote.port, { path: '/sistema' })).status === 302, false, 'sem redirecionar');
    assert.equal((await send('http', remote.port, { method: 'POST', path: '/api/session/admin-login', body: ADMIN })).status, 200);
    const secure = await send('https', remote.port, { path: '/api/connection' });
    assert.equal(secure.body.insecureAdmin, false);
});

test('[UC-REDE-005] /iclass-ca.crt e /api/connection/certificate: a mesma CA, em http e https, sem login', async () => {
    const plain = await send('http', remote.port, { path: '/iclass-ca.crt' });
    assert.equal(plain.status, 200);
    assert.equal(plain.headers['content-type'], 'application/x-x509-ca-cert');
    assert.match(plain.headers['content-disposition'], /attachment; filename="iclass-ca\.crt"/);
    const ca = new crypto.X509Certificate(plain.raw);
    assert.equal(ca.ca, true);
    assert.deepEqual(plain.raw, Buffer.from(material.ca.der));
    const secure = await send('https', remote.port, { path: '/iclass-ca.crt' });
    assert.deepEqual(secure.raw, plain.raw);

    const info = await send('http', remote.port, { path: '/api/connection/certificate' });
    assert.equal(info.status, 200);
    assert.equal(info.body.available, true);
    assert.equal(info.body.fingerprintSha256, ca.fingerprint256);
    assert.equal(info.body.validTo, new Date(ca.validTo).toISOString());
    assert.deepEqual(info.body.server.ips, ['127.0.0.1', '192.168.0.10']);
    assert.equal(info.headers['strict-transport-security'], undefined);
    // O certificado servido no https é o desta CA, com os IPs da máquina.
    const peer = new crypto.X509Certificate(secure.peer.raw);
    assert.equal(peer.verify(ca.publicKey), true);
    assert.equal(peer.checkIP('192.168.0.10'), '192.168.0.10');
});

test('[UC-REDE-005] alunos pelo https (studentsHttps): página por http vai para o https; login por http é recusado; o resto segue', async () => {
    seed({ studentsHttps: true });
    const httpsUrl = `https://127.0.0.1:${remote.port}`;
    for (const page of ['/', '/aluno', '/login', '/aluno/prova/x?y=1']) {
        const res = await send('http', remote.port, { path: page });
        assert.equal(res.status, 302, page);
        assert.equal(res.headers.location, `${httpsUrl}${page}`);
    }
    // O guia, o arquivo da CA e os pedaços do app de uma página já aberta não mudam.
    for (const pathName of ['/certificado', '/iclass-ca.crt', '/assets/x.js', '/api/session/status', '/api/connection']) {
        assert.notEqual((await send('http', remote.port, { path: pathName })).status, 302, pathName);
    }
    for (const entry of ['/api/student/login', '/api/student/register', '/api/student/recover']) {
        const res = await send('http', remote.port, { method: 'POST', path: entry, body: { email: ANA.email, password: ANA.password } });
        assert.equal(res.status, 403, entry);
        // A resposta de estado do contrato 9 (lista fechada), a mesma do painel: vá para o https.
        assert.deepEqual(res.body, { error: STUDENT_HTTPS_MESSAGE, adminAccess: 'https-required', httpsUrl });
    }
    const viaHttps = await send('https', remote.port, { method: 'POST', path: '/api/student/login', body: ANA });
    assert.equal(viaHttps.status, 200, JSON.stringify(viaHttps.body));
    // No computador do IClass (localhost), tudo em http como sempre.
    assert.equal((await send('http', local.port, { path: '/aluno' })).status === 302, false);
    assert.equal((await send('http', local.port, { method: 'POST', path: '/api/student/login', body: ANA })).status, 200);
    // O QR e o endereço da sala passam a ser https.
    const token = createAdminSession(db.memory, ADMIN.email);
    const room = await send('http', local.port, { path: '/api/admin/room-address', headers: { 'x-admin-session': token } });
    assert.equal(room.body.studentUrl, `https://192.168.0.10:${local.port}`);
    assert.equal(room.body.studentsHttps, true);
});

test('[UC-REDE-005] Host forjado não vira link: o endereço seguro usa o IP recomendado; a porta é a do listener', async () => {
    seed({ adminAccess: 'rede' });
    const res = await send('http', remote.port, { method: 'POST', path: '/api/session/admin-login', body: ADMIN, headers: { host: 'evil.com:4443' } });
    assert.equal(res.status, 403);
    assert.equal(res.body.httpsUrl, `https://192.168.0.10:${remote.port}`);
    const page = await send('http', remote.port, { path: '/sistema', headers: { host: 'evil.com' } });
    assert.equal(page.headers.location, `https://192.168.0.10:${remote.port}/sistema`);
    // Host com o IP da máquina (ou localhost) vale.
    const own = await send('http', remote.port, { path: '/sistema', headers: { host: `192.168.0.10:${remote.port}` } });
    assert.equal(own.headers.location, `https://192.168.0.10:${remote.port}/sistema`);
});

test('[UC-REDE-005] Sistema → Rede: "rede" e studentsHttps liberados com o https; prova em andamento trava a troca dos alunos', async () => {
    const token = createAdminSession(db.memory, ADMIN.email);
    const post = body => send('http', local.port, { method: 'POST', path: '/api/admin/network-settings', headers: { 'x-admin-session': token }, body });
    const info = await send('http', local.port, { path: '/api/admin/network-info', headers: { 'x-admin-session': token } });
    assert.equal(info.body.https.available, true);
    assert.equal(info.body.https.url, `https://192.168.0.10:${local.port}`);
    assert.equal(info.body.https.ca.fingerprintSha256, material.ca.fingerprintSha256);
    assert.deepEqual(info.body.https.server.ips, ['127.0.0.1', '192.168.0.10']);

    const rede = await post({ adminAccess: 'rede' });
    assert.equal(rede.status, 200, JSON.stringify(rede.body));
    assert.equal(settingsUtil.networkSettings().adminAccess, 'rede');
    assert.equal(rede.body.network.httpsAvailable, true);

    db.memory.examApplications = [{ id: 'app-1', examKey: 'prova_rede', studentClass: 'Turma A', status: 'running' }];
    const blocked = await post({ studentsHttps: true });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.field, 'studentsHttps');
    assert.match(blocked.body.error, /Há prova em andamento: prova rede \(Turma A\)/);
    assert.equal(settingsUtil.networkSettings().studentsHttps, false);
    // Trocar só o painel durante a prova continua possível (não muda o endereço dos alunos).
    assert.equal((await post({ adminAccess: 'rede-sem-https' })).status, 200);

    db.memory.examApplications = [{ id: 'app-1', examKey: 'prova_rede', studentClass: 'Turma A', status: 'finished' }];
    const on = await post({ studentsHttps: true });
    assert.equal(on.status, 200);
    assert.equal(settingsUtil.networkSettings().studentsHttps, true);
    assert.equal(on.body.network.studentsHttps, true);
    const audits = db.memory.auditLogs.filter(entry => entry.action === 'network_settings_changed');
    assert.deepEqual(audits.map(entry => entry.field), ['adminAccess', 'adminAccess', 'studentsHttps']);
    assert.equal((await post({ studentsHttps: 'sim' })).status, 400);
    assert.equal((await post({ studentsHttps: false })).status, 200);
    assert.equal(settingsUtil.networkSettings().studentsHttps, false);
});

test('[UC-REDE-005] a pasta tls (chave da CA) não entra no backup completo nem no dos dados', async () => {
    assert.ok(fs.existsSync(path.join(runtimePaths.DATA_DIR, 'tls', 'ca.key.pem')));
    // ZIP formato 2 (H4a): o completo (com data/uploads) e o dos dados, gravados no
    // servidor. Nenhum dos dois leva data/tls (backupArchive.excludedDirs).
    const AdmZip = backupUtil.getZipLib();
    for (const variante of ['completo', 'dados']) {
        const saved = await backupUtil.createBackup({ origem: 'manual', variante, dir: path.join(tempRoot, 'backups-tls') });
        const names = new AdmZip(saved.file).getEntries().map(entry => entry.entryName);
        assert.ok(names.includes('data/database.db'), names.join(', '));
        assert.equal(names.some(name => /(^|\/)tls\/|\.pem$|ca\.key/i.test(name)), false, names.join(', '));
        fs.rmSync(saved.file, { force: true });
    }
    const snapshot = JSON.stringify(await backupUtil.buildFullDataSnapshot());
    assert.equal(snapshot.includes('PRIVATE KEY'), false);
});

test('[UC-REDE-005] sem a conexão segura (pasta tls que não pode ser gravada): só http e o motivo na tela', async () => {
    const saved = secureConnection.status();
    const blocker = path.join(tempRoot, 'bloqueio');
    fs.writeFileSync(blocker, 'x');
    try {
        const crashLog = path.join(runtimePaths.DATA_DIR, 'crash.log');
        const crashBefore = fs.existsSync(crashLog) ? fs.readFileSync(crashLog, 'utf8').length : 0;
        assert.equal(secureConnection.prepare({ dir: path.join(blocker, 'tls'), addresses: [] }), null);
        const status = secureConnection.status();
        assert.equal(status.available, false);
        assert.match(secureConnection.unavailableText(), /^Conexão segura indisponível: /);
        // O motivo é português simples, sem o código repetido, sem a mensagem do sistema e
        // sem o caminho da pasta de dados (antes: "EEXIST: EEXIST: file already exists,
        // mkdir '/.../data/tls'", inclusive na rota pública).
        const text = secureConnection.unavailableText();
        assert.match(text, /há um arquivo com o nome "tls" na pasta de dados/);
        assert.equal(text.includes(tempRoot), false, text);
        assert.equal(/ENOTDIR|EEXIST|file already exists|not a directory|mkdir/i.test(text), false, text);
        // O detalhe técnico vai para o crash.log, uma vez por motivo.
        const crash = fs.readFileSync(crashLog, 'utf8').slice(crashBefore);
        assert.match(crash, /conexão segura \(https\)/);
        assert.equal(secureConnection.prepare({ dir: path.join(blocker, 'tls'), addresses: [] }), null);
        assert.equal(fs.readFileSync(crashLog, 'utf8').slice(crashBefore), crash, 'a mesma falha não se repete no crash.log');
        seed({ adminAccess: 'rede' });
        const res = await send('http', remote.port, { method: 'POST', path: '/api/session/admin-login', body: ADMIN });
        assert.equal(res.status, 403);
        assert.deepEqual(res.body, { error: HTTPS_UNAVAILABLE_MESSAGE, adminAccess: 'https-required', httpsUrl: null });
        // Sem https, nada é redirecionado (não haveria para onde ir).
        assert.equal((await send('http', remote.port, { path: '/sistema' })).status === 302, false);
        seed({ studentsHttps: true });
        assert.equal((await send('http', remote.port, { path: '/aluno' })).status === 302, false);
        assert.equal((await send('http', remote.port, { method: 'POST', path: '/api/student/login', body: ANA })).status, 200);
        const info = await send('http', remote.port, { path: '/api/connection/certificate' });
        assert.equal(info.status, 200);
        assert.equal(info.body.available, false);
        // Rota pública (o guia /certificado, sem login): só "indisponível"; o motivo fica
        // no console e em Sistema → Rede.
        assert.equal(info.body.error, PUBLIC_UNAVAILABLE_TEXT);
        const caFile = await send('http', remote.port, { path: '/iclass-ca.crt' });
        assert.equal(caFile.status, 404);
        assert.equal(caFile.raw.toString('utf8').includes(tempRoot), false);
        assert.match(caFile.raw.toString('utf8'), /^Conexão segura indisponível neste IClass agora\. /);
        seed();
        const token = createAdminSession(db.memory, ADMIN.email);
        const refused = await send('http', local.port, { method: 'POST', path: '/api/admin/network-settings', headers: { 'x-admin-session': token }, body: { studentsHttps: true } });
        assert.equal(refused.status, 409);
        assert.match(refused.body.error, /Conexão segura indisponível: há um arquivo com o nome "tls"/);
        const settings = await send('http', local.port, { path: '/api/admin/network-settings', headers: { 'x-admin-session': token } });
        assert.equal(settings.body.httpsReady, false);
        assert.equal(settings.body.httpsError, secureConnection.unavailableText());
    } finally {
        assert.ok(saved.available);
        secureConnection.prepare({ dir: path.join(runtimePaths.DATA_DIR, 'tls'), addresses: [{ name: 'Wi-Fi', address: '192.168.0.10', kind: 'rede' }] });
    }
});

test('[UC-REDE-005] IP da rede fora das faixas locais (192.0.2.2): a conexão segura vale só neste computador; nada manda para um https que não valida', async () => {
    // Antes: a tela dizia "funcionando" com https://192.0.2.2, aceitava 'rede' e
    // studentsHttps, e redirecionava professores e alunos para um https cujo certificado
    // (SAN só com localhost e 127.0.0.1) nunca validava, nem com a CA instalada.
    const outsideInterfaces = { eth0: [{ address: '192.0.2.2', family: 'IPv4', internal: false }] };
    const outsideDir = path.join(tempRoot, 'tls-fora');
    setInterfaceProvider(() => outsideInterfaces);
    try {
        const { networkAddresses } = require('../../backend/utils/networkAddresses.js');
        const outside = secureConnection.prepare({ dir: outsideDir, addresses: networkAddresses({ port: local.port }).addresses });
        assert.ok(outside);
        assert.deepEqual(outside.server.ips, ['127.0.0.1'], 'o IP fora das faixas da CA não entra no certificado');
        assert.equal(new crypto.X509Certificate(outside.cert).checkIP('192.0.2.2'), undefined);

        seed();
        const token = createAdminSession(db.memory, ADMIN.email);
        const auth = { 'x-admin-session': token };
        const info = await send('http', local.port, { path: '/api/admin/network-info', headers: auth });
        assert.equal(info.body.https.available, true);
        assert.equal(info.body.https.networkReady, false);
        assert.equal(info.body.https.url, null, 'nenhum endereço https://192.0.2.2');
        assert.equal(info.body.https.localUrl, `https://localhost:${local.port}`);
        assert.match(info.body.https.networkError, /O endereço desta rede \(192\.0\.2\.2\) não é de uma faixa de rede local/);

        const settings = await send('http', local.port, { path: '/api/admin/network-settings', headers: auth });
        assert.equal(settings.body.httpsAvailable, true);
        assert.equal(settings.body.httpsReady, false);
        assert.match(settings.body.httpsError, /192\.0\.2\.2/);
        const post = body => send('http', local.port, { method: 'POST', path: '/api/admin/network-settings', headers: auth, body });
        const rede = await post({ adminAccess: 'rede' });
        assert.equal(rede.status, 409);
        assert.equal(rede.body.field, 'adminAccess');
        assert.match(rede.body.error, /192\.0\.2\.2.*não é de uma faixa de rede local/);
        const students = await post({ studentsHttps: true });
        assert.equal(students.status, 409);
        assert.equal(students.body.field, 'studentsHttps');
        assert.equal(settingsUtil.networkSettings().adminAccess, 'rede-sem-https');
        assert.equal(settingsUtil.networkSettings().studentsHttps, false);

        // Opções já gravadas antes (banco de outra rede): nenhum redirecionamento para o
        // https por IP; o painel em outro aparelho é recusado com o texto de indisponível.
        seed({ adminAccess: 'rede', studentsHttps: true });
        const host = { host: `192.0.2.2:${remote.port}` };
        const login = await send('http', remote.port, { method: 'POST', path: '/api/session/admin-login', body: ADMIN, headers: host });
        assert.equal(login.status, 403);
        assert.deepEqual(login.body, { error: HTTPS_UNAVAILABLE_MESSAGE, adminAccess: 'https-required', httpsUrl: null });
        assert.equal((await send('http', remote.port, { path: '/sistema', headers: host })).status === 302, false);
        assert.equal((await send('http', remote.port, { path: '/aluno', headers: host })).status === 302, false);
        assert.equal((await send('http', remote.port, { method: 'POST', path: '/api/student/login', body: ANA, headers: host })).status, 200, 'os alunos seguem por http');
        const connection = await send('http', remote.port, { path: '/api/connection', headers: host });
        assert.equal(connection.body.httpsUrl, null);
        assert.equal(connection.body.studentsHttps, false);
        const guide = await send('http', remote.port, { path: '/api/connection/certificate', headers: host });
        assert.equal(guide.body.available, true);
        assert.equal(guide.body.httpsUrl, null, 'o guia não oferece um https que não abre');
        // O endereço da sala e o QR continuam em http.
        const room = await send('http', local.port, { path: '/api/admin/room-address', headers: { 'x-admin-session': createAdminSession(db.memory, ADMIN.email) } });
        assert.equal(room.body.studentUrl, `http://192.0.2.2:${local.port}`);
        assert.equal(room.body.studentsHttps, false);
        // Neste computador, o https por localhost continua valendo.
        const own = await send('http', local.port, { path: '/api/connection', headers: { host: `192.0.2.2:${local.port}` } });
        assert.equal(own.body.httpsUrl, `https://localhost:${local.port}`);
        // Console: nada de "Endereço seguro: https://192.0.2.2".
        const lines = consoleLinesOf({ port: local.port, secure: { available: true, studentsHttps: false, ips: secureConnection.serverIps() } });
        assert.equal(lines.some(line => line.includes('https://192.0.2.2')), false, lines.join('\n'));
        assert.ok(lines.some(line => /Conexão segura só neste computador/.test(line)));
    } finally {
        setInterfaceProvider(() => INTERFACES);
        secureConnection.prepare({ dir: path.join(runtimePaths.DATA_DIR, 'tls'), addresses: [{ name: 'Wi-Fi', address: '192.168.0.10', kind: 'rede' }] });
    }
});

test('[UC-REDE-005] com https para os alunos, o adaptador virtual (fora do certificado) continua em http na tela', async () => {
    seed({ studentsHttps: true });
    const token = createAdminSession(db.memory, ADMIN.email);
    const info = await send('http', local.port, { path: '/api/admin/network-info', headers: { 'x-admin-session': token } });
    const byAddress = Object.fromEntries(info.body.addresses.map(item => [item.address, item.url]));
    assert.equal(byAddress['192.168.0.10'], `https://192.168.0.10:${local.port}`);
    assert.equal(byAddress['192.168.56.1'], `http://192.168.56.1:${local.port}`, 'antes: https://192.168.56.1, fora do certificado');
    assert.equal(info.body.https.networkReady, true);
    assert.equal(info.body.https.url, `https://192.168.0.10:${local.port}`);
});

test('[UC-REDE-005] aviso de CA recriada: some depois de 30 dias (antes ficava para sempre)', () => {
    const dir = path.join(tempRoot, 'tls-recriada');
    try {
        assert.ok(secureConnection.prepare({ dir, addresses: [] }));
        const file = path.join(dir, 'ca-recriada.json');
        fs.writeFileSync(file, JSON.stringify({ at: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(), reason: 'a CA venceu' }));
        assert.ok(secureConnection.prepare({ dir, addresses: [] }));
        assert.ok(secureConnection.status().ca.recreatedAt, 'dentro dos 30 dias, a tela avisa');
        fs.writeFileSync(file, JSON.stringify({ at: new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString(), reason: 'a CA venceu' }));
        assert.ok(secureConnection.prepare({ dir, addresses: [] }));
        assert.equal(secureConnection.status().ca.recreatedAt, null);
        assert.ok(fs.existsSync(file), 'o histórico continua na pasta tls');
    } finally {
        secureConnection.prepare({ dir: path.join(runtimePaths.DATA_DIR, 'tls'), addresses: [{ name: 'Wi-Fi', address: '192.168.0.10', kind: 'rede' }] });
    }
});

test('[UC-REDE-005] a lista de páginas do painel bate com as rotas do instrutor do App (fora a "/")', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../web/src/lib/adminPermissions.js'), 'utf8');
    const block = source.slice(source.indexOf('ADMIN_PATH_PERMISSIONS'), source.indexOf('})', source.indexOf('ADMIN_PATH_PERMISSIONS')));
    const paths = [...block.matchAll(/'(\/[^']*)'\s*:/g)].map(match => match[1]).filter(item => item !== '/');
    assert.ok(paths.length > 10);
    assert.deepEqual([...ADMIN_PANEL_PAGES].sort(), [...new Set(paths)].sort());
});
