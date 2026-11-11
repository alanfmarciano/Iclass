// Conexão segura (H6c, SEG-03 e OPS-08): CA própria e certificado do servidor gerados em
// JS puro (utils/tlsCertificates.js). Antes não havia https nenhum no IClass: a senha do
// professor e as dos alunos passavam abertas no Wi-Fi da sala.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
    FILES,
    SERVER_DAYS,
    ensureTlsMaterial,
    isPermittedIp,
    serverSubjectNames,
} = require('../../backend/utils/tlsCertificates.js');

const DAY = 24 * 3600 * 1000;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-tls-test-'));
let counter = 0;
function freshDir() {
    counter += 1;
    return path.join(tempRoot, `tls-${counter}`);
}
const WIFI = [
    { name: 'Wi-Fi', address: '192.168.0.10', kind: 'rede' },
    { name: 'VirtualBox Host-Only', address: '192.168.56.1', kind: 'virtual' },
    { name: 'vEthernet (WSL)', address: '172.20.0.1', kind: 'virtual' },
    { name: 'Ethernet 2', address: '8.8.8.8', kind: 'rede' },
    { name: 'eth0', address: '192.0.2.2', kind: 'rede' },
    { name: 'APIPA', address: '169.254.3.4', kind: 'link-local' },
];

function hasOpenssl() {
    try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}

test.after(() => { fs.rmSync(tempRoot, { recursive: true, force: true }); });

test('[UC-REDE-004] CA própria restrita e certificado do servidor com os IPs privados da máquina no SAN', () => {
    const dir = freshDir();
    const material = ensureTlsMaterial({ dir, addresses: WIFI });
    const ca = new crypto.X509Certificate(material.ca.certPem);
    const server = new crypto.X509Certificate(material.cert);
    assert.equal(ca.ca, true, 'a CA é CA');
    assert.equal(server.ca, false);
    // nameConstraints (2.5.29.30) presente na CA: só nomes .local/localhost e IPs privados.
    const nameConstraintsOid = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x1e]);
    assert.ok(ca.raw.includes(nameConstraintsOid), 'CA com nameConstraints');
    assert.equal(server.verify(ca.publicKey), true, 'assinado pela CA');
    assert.equal(server.checkIssued(ca), true);
    assert.equal(server.checkIP('192.168.0.10'), '192.168.0.10');
    assert.equal(server.checkIP('127.0.0.1'), '127.0.0.1');
    assert.equal(server.checkHost('localhost'), 'localhost');
    // Fora do SAN: IP público, faixa de teste, adaptador virtual e link-local.
    for (const ip of ['8.8.8.8', '192.0.2.2', '192.168.56.1', '172.20.0.1', '169.254.3.4']) {
        assert.equal(server.checkIP(ip), undefined, ip);
    }
    assert.deepEqual(material.server.ips, ['127.0.0.1', '192.168.0.10']);
    assert.deepEqual(material.server.names, ['localhost']);
    // Validade: no máximo 397 dias no total (limite da Apple), começando antes de agora.
    const span = Date.parse(server.validTo) - Date.parse(server.validFrom);
    assert.ok(span <= SERVER_DAYS * DAY, `validade ${span / DAY} dias`);
    assert.ok(Date.parse(server.validFrom) < Date.now());
    assert.ok(Date.parse(ca.validTo) - Date.now() > 9 * 365 * DAY, 'CA de 10 anos');
    // Impressão digital no formato que a tela mostra.
    assert.match(material.ca.fingerprintSha256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.deepEqual(material.ca.der, ca.raw);
    // Arquivos na pasta, chaves com 0600 (onde o sistema tem permissão de arquivo).
    for (const name of [FILES.caKey, FILES.caCert, FILES.serverKey, FILES.serverCert]) {
        assert.ok(fs.existsSync(path.join(dir, name)), name);
    }
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(path.join(dir, FILES.caKey)).mode & 0o777, 0o600);
        assert.equal(fs.statSync(path.join(dir, FILES.serverKey)).mode & 0o777, 0o600);
    }
    assert.deepEqual(material.changed, { ca: true, server: true });
    assert.equal(material.ca.recreatedAt, null, 'primeira CA não é "recriada"');
    assert.equal(material.caRecreatedNow, false);
});

test('[UC-REDE-004] openssl confere a cadeia e a CA recusa nome e IP de fora', { skip: !hasOpenssl() && 'openssl ausente' }, () => {
    const dir = freshDir();
    ensureTlsMaterial({ dir, addresses: WIFI });
    const out = execFileSync('openssl', ['verify', '-CAfile', path.join(dir, FILES.caCert), path.join(dir, FILES.serverCert)], { encoding: 'utf8' });
    assert.match(out, /OK/);
    // Certificado forjado com a chave da CA para google.com e 8.8.8.8: as restrições de
    // nome da própria CA fazem o openssl recusar (a chave vazada não serve para a internet).
    const evilKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const evilKeyFile = path.join(dir, 'evil.key');
    const evilCsr = path.join(dir, 'evil.csr');
    const evilCrt = path.join(dir, 'evil.crt');
    const ext = path.join(dir, 'evil.ext');
    fs.writeFileSync(evilKeyFile, evilKey.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    fs.writeFileSync(ext, 'subjectAltName=DNS:google.com,IP:8.8.8.8\nextendedKeyUsage=serverAuth\n');
    execFileSync('openssl', ['req', '-new', '-key', evilKeyFile, '-subj', '/CN=google.com', '-out', evilCsr], { stdio: 'ignore' });
    execFileSync('openssl', ['x509', '-req', '-in', evilCsr, '-CA', path.join(dir, FILES.caCert), '-CAkey', path.join(dir, FILES.caKey), '-CAcreateserial', '-days', '30', '-extfile', ext, '-out', evilCrt], { stdio: 'ignore' });
    let refused = '';
    try {
        execFileSync('openssl', ['verify', '-CAfile', path.join(dir, FILES.caCert), evilCrt], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
        refused = `${error.stdout || ''}${error.stderr || ''}`;
    }
    assert.match(refused, /permitted subtree violation|name constraints/i);
});

test('[UC-REDE-004] segunda chamada sem mudança não regrava nada', () => {
    const dir = freshDir();
    const first = ensureTlsMaterial({ dir, addresses: WIFI });
    const before = fs.statSync(path.join(dir, FILES.serverCert)).mtimeMs;
    const second = ensureTlsMaterial({ dir, addresses: WIFI });
    assert.deepEqual(second.changed, { ca: false, server: false });
    assert.equal(second.cert, first.cert);
    assert.equal(fs.statSync(path.join(dir, FILES.serverCert)).mtimeMs, before);
});

test('[UC-REDE-004] IP novo refaz só o certificado do servidor; a CA (instalada nos aparelhos) é a mesma', () => {
    const dir = freshDir();
    const first = ensureTlsMaterial({ dir, addresses: WIFI });
    const moved = ensureTlsMaterial({ dir, addresses: [{ name: 'Wi-Fi', address: '10.0.5.20', kind: 'rede' }] });
    assert.deepEqual(moved.changed, { ca: false, server: true });
    assert.equal(moved.ca.fingerprintSha256, first.ca.fingerprintSha256);
    assert.deepEqual(moved.server.ips, ['10.0.5.20', '127.0.0.1']);
    const server = new crypto.X509Certificate(moved.cert);
    assert.equal(server.checkIP('10.0.5.20'), '10.0.5.20');
    assert.equal(server.checkIP('192.168.0.10'), undefined, 'o IP antigo saiu');
});

test('[UC-REDE-004] certificado vencendo em menos de 30 dias é renovado; CA vencida é recriada com aviso', () => {
    const dir = freshDir();
    const longAgo = Date.now() - 380 * DAY;
    const old = ensureTlsMaterial({ dir, addresses: WIFI, now: longAgo });
    const renewed = ensureTlsMaterial({ dir, addresses: WIFI });
    assert.deepEqual(renewed.changed, { ca: false, server: true }, 'faltavam menos de 30 dias');
    assert.equal(renewed.ca.fingerprintSha256, old.ca.fingerprintSha256);
    assert.ok(Date.parse(renewed.server.validTo) - Date.now() > 300 * DAY);

    // CA de 11 anos atrás: venceu. É recriada, e o arquivo antigo fica de lado (nunca apagado).
    const dir2 = freshDir();
    const ancient = ensureTlsMaterial({ dir: dir2, addresses: WIFI, now: Date.now() - 3700 * DAY });
    const recreated = ensureTlsMaterial({ dir: dir2, addresses: WIFI });
    assert.deepEqual(recreated.changed, { ca: true, server: true });
    assert.notEqual(recreated.ca.fingerprintSha256, ancient.ca.fingerprintSha256);
    assert.ok(recreated.ca.recreatedAt, 'a tela avisa para instalar de novo');
    assert.match(recreated.ca.recreatedReason, /venceu/);
    const aside = fs.readdirSync(dir2).filter(name => name.includes('.invalido-'));
    assert.ok(aside.some(name => name.startsWith(`${FILES.caKey}.invalido-`)), aside.join(','));
    assert.ok(aside.some(name => name.startsWith(`${FILES.caCert}.invalido-`)), aside.join(','));
});

test('[UC-REDE-004] arquivo corrompido é renomeado para *.invalido-* e recriado, sem apagar nada', () => {
    const dir = freshDir();
    const first = ensureTlsMaterial({ dir, addresses: WIFI });
    // Certificado do servidor estragado: só ele é refeito, a CA continua.
    fs.writeFileSync(path.join(dir, FILES.serverCert), 'lixo');
    const fixed = ensureTlsMaterial({ dir, addresses: WIFI });
    assert.deepEqual(fixed.changed, { ca: false, server: true });
    assert.equal(fixed.ca.fingerprintSha256, first.ca.fingerprintSha256);
    const asideServer = fs.readdirSync(dir).filter(name => name.startsWith(`${FILES.serverCert}.invalido-`));
    assert.equal(asideServer.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, asideServer[0]), 'utf8'), 'lixo', 'o conteúdo antigo continua lá');

    // Chave da CA estragada: CA nova, com o aviso de reinstalar.
    fs.writeFileSync(path.join(dir, FILES.caKey), '-----BEGIN PRIVATE KEY-----\nxx\n-----END PRIVATE KEY-----\n');
    const again = ensureTlsMaterial({ dir, addresses: WIFI });
    assert.equal(again.changed.ca, true);
    assert.notEqual(again.ca.fingerprintSha256, first.ca.fingerprintSha256);
    assert.match(again.ca.recreatedReason, /ilegível/);
    // O motivo da tela e do console é só português; a mensagem crua fica como detalhe no arquivo.
    assert.equal(again.ca.recreatedReason, 'arquivo ilegível ou danificado');
    assert.equal(again.caRecreatedNow, true, 'o console avisa no boot que a CA foi trocada');
    assert.equal(ensureTlsMaterial({ dir, addresses: WIFI }).caRecreatedNow, false, 'só na leitura que recriou');
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir, FILES.caRecreated), 'utf8')).detail);
    assert.ok(fs.readdirSync(dir).some(name => name.startsWith(`${FILES.caKey}.invalido-`)));
    // Chave e certificado da CA de outro par (cópia misturada): também é recriada.
    const dir3 = freshDir();
    const a = ensureTlsMaterial({ dir: dir3, addresses: WIFI });
    const other = freshDir();
    ensureTlsMaterial({ dir: other, addresses: WIFI });
    fs.copyFileSync(path.join(other, FILES.caCert), path.join(dir3, FILES.caCert));
    const mixed = ensureTlsMaterial({ dir: dir3, addresses: WIFI });
    assert.equal(mixed.changed.ca, true);
    assert.notEqual(mixed.ca.fingerprintSha256, a.ca.fingerprintSha256);
});

test('[UC-REDE-004] nomes do SAN: só adaptadores de rede dentro das faixas da CA; .local só com o H6d', () => {
    assert.equal(isPermittedIp('10.1.2.3'), true);
    assert.equal(isPermittedIp('172.31.255.1'), true);
    assert.equal(isPermittedIp('172.32.0.1'), false);
    assert.equal(isPermittedIp('100.64.0.1'), false);
    assert.equal(isPermittedIp('192.0.2.2'), false);
    assert.equal(isPermittedIp('abc'), false);
    assert.deepEqual(serverSubjectNames({ addresses: WIFI }), { names: ['localhost'], ips: ['127.0.0.1', '192.168.0.10'] });
    // O nome fixo do H6d entra pelo mesmo caminho (e nada fora de .local passa).
    assert.deepEqual(serverSubjectNames({ addresses: [], dnsNames: ['iclass.local', 'google.com', 'Sala 3'] }).names, ['iclass.local', 'localhost']);
});

test('[UC-REDE-004] pasta que não pode ser criada: lança (o servidor sobe só em http)', () => {
    // Um arquivo no lugar da pasta tls (vale também rodando como root, que ignora 0500).
    const blocker = path.join(tempRoot, 'arquivo-no-lugar-da-pasta');
    fs.writeFileSync(blocker, 'x');
    assert.throws(() => ensureTlsMaterial({ dir: path.join(blocker, 'tls'), addresses: WIFI }), /ENOTDIR|EEXIST/);
    assert.equal(fs.readFileSync(blocker, 'utf8'), 'x');
});
