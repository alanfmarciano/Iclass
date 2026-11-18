// Conexão segura (H6c): a pasta data/tls que some inteira e a falha do certificado no
// console (decisões §12, sobras do H6c).
// 1) Antes, com a pasta tls apagada (antivírus, cópia da pasta do IClass sem ela, limpeza
//    à mão), a CA nova era tratada como a primeira: nenhum aviso, e os aparelhos que
//    tinham instalado a antiga davam "conexão não segura" sem ninguém saber por quê.
//    Agora a impressão digital da CA fica no banco (settings.network.caFingerprint) e a
//    CA nova depois de uma conhecida vira "CA recriada" (ca-recriada.json, aviso na tela
//    por 30 dias e no console). A primeira vez de verdade continua sem aviso.
// 2) Antes, a falha ao preparar o certificado escrevia no console a mensagem crua do
//    sistema, em inglês e com o caminho completo da pasta de dados, ao lado da linha em
//    português. Agora o console tem só a linha em português; o detalhe fica no crash.log.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-tls-ca-recriada-test-'));
process.env.ICLASS_DATA_DIR = path.join(tempRoot, 'data');
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const secureConnection = require('../../backend/utils/secureConnection.js');
const { FILES } = require('../../backend/utils/tlsCertificates.js');
const proc = require('./fixtures/server-process.js');

const ADDRESSES = [{ name: 'Wi-Fi', address: '192.168.0.10', kind: 'rede' }];
const childScript = path.join(__dirname, 'fixtures', 'server-main-child.js');

test.after(() => {
    proc.killAll();
    secureConnection.resetForTests();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-REDE-004] pasta tls que sumiu com uma CA conhecida: CA recriada, com aviso; primeira vez e pasta de outro computador, sem aviso', () => {
    const dir = path.join(tempRoot, 'unidade', 'tls');
    // Primeira vez de verdade: nada conhecido, nada de aviso.
    const first = secureConnection.prepare({ dir, addresses: ADDRESSES });
    assert.ok(first);
    assert.equal(first.changed.ca, true);
    const known = secureConnection.reconcileKnownCa(null);
    assert.equal(known.recreatedNow, false);
    assert.equal(known.fingerprint, first.ca.fingerprintSha256);
    assert.equal(fs.existsSync(path.join(dir, FILES.caRecreated)), false);
    assert.equal(secureConnection.status().ca.recreatedAt, null);

    // Mesma CA lida de novo: nada muda.
    secureConnection.prepare({ dir, addresses: ADDRESSES });
    assert.equal(secureConnection.reconcileKnownCa(known.fingerprint).recreatedNow, false);

    // A pasta inteira some: a CA nova é outra, e o banco conhecia a anterior.
    fs.rmSync(dir, { recursive: true, force: true });
    const again = secureConnection.prepare({ dir, addresses: ADDRESSES });
    assert.ok(again);
    assert.notEqual(again.ca.fingerprintSha256, known.fingerprint);
    assert.equal(again.caRecreatedNow, false, 'sozinho, o ensureTlsMaterial acha que é a primeira');
    const result = secureConnection.reconcileKnownCa(known.fingerprint);
    assert.equal(result.recreatedNow, true);
    assert.equal(result.fingerprint, again.ca.fingerprintSha256);
    const mark = JSON.parse(fs.readFileSync(path.join(dir, FILES.caRecreated), 'utf8'));
    assert.equal(mark.reason, secureConnection.CA_FOLDER_GONE_REASON);
    assert.ok(secureConnection.status().ca.recreatedAt, 'a tela avisa (30 dias)');
    // Chamado de novo com a impressão digital nova (já gravada): sem segundo aviso.
    assert.equal(secureConnection.reconcileKnownCa(result.fingerprint).recreatedNow, false);

    // Pasta tls trazida de outro computador (CA que já existia, não criada agora): não é
    // recriação, só passa a ser a conhecida.
    const other = path.join(tempRoot, 'outro', 'tls');
    secureConnection.prepare({ dir: other, addresses: ADDRESSES });
    const loaded = secureConnection.prepare({ dir: other, addresses: ADDRESSES });
    assert.equal(loaded.changed.ca, false);
    assert.equal(secureConnection.reconcileKnownCa(known.fingerprint).recreatedNow, false);
    assert.equal(fs.existsSync(path.join(other, FILES.caRecreated)), false);
});

test('[UC-REDE-004] falha do certificado: o console tem só a linha em português, sem a mensagem do sistema nem o caminho', () => {
    const blocker = path.join(tempRoot, 'arquivo-no-lugar');
    fs.writeFileSync(blocker, 'x');
    const captured = [];
    const originals = { error: console.error, warn: console.warn, log: console.log };
    ['error', 'warn', 'log'].forEach(name => { console[name] = (...args) => captured.push(args.join(' ')); });
    try {
        secureConnection.resetForTests();
        assert.equal(secureConnection.prepare({ dir: path.join(blocker, 'tls'), addresses: ADDRESSES }), null);
    } finally {
        Object.assign(console, originals);
    }
    const text = captured.join('\n');
    assert.equal(text.includes(tempRoot), false, text);
    assert.equal(/ENOTDIR|EEXIST|not a directory|file already exists|mkdir/i.test(text), false, text);
    // O detalhe técnico está no crash.log.
    const crash = fs.readFileSync(path.join(process.env.ICLASS_DATA_DIR, 'crash.log'), 'utf8');
    assert.match(crash, /conexão segura \(https\)/);
    assert.match(crash, /ENOTDIR|EEXIST/);
    assert.match(secureConnection.unavailableText(), /^Conexão segura indisponível: há um arquivo com o nome "tls"/);
});

test('[UC-REDE-004] servidor de verdade: data/tls apagada entre dois boots avisa no console que a CA foi criada de novo', async () => {
    const dataDir = path.join(tempRoot, 'boot');
    fs.mkdirSync(dataDir, { recursive: true });
    const boot = async () => {
        const server = proc.launch(childScript, { dataDir, port: await proc.freePort() });
        await proc.waitForHealth(server.base, { exited: server.exited });
        const info = await proc.call(server.base, '/api/connection/certificate');
        server.child.kill('SIGTERM');
        await server.exited;
        return { output: server.output(), info: info.body };
    };
    const first = await boot();
    assert.equal(first.info.available, true, first.output);
    assert.equal(/criado de novo/.test(first.output), false, 'primeira vez: sem aviso');
    const second = await boot();
    assert.equal(/criado de novo/.test(second.output), false, 'mesma CA: sem aviso');
    assert.ok(first.info.fingerprintSha256);
    assert.equal(second.info.fingerprintSha256, first.info.fingerprintSha256);

    fs.rmSync(path.join(dataDir, 'tls'), { recursive: true, force: true });
    const third = await boot();
    assert.match(third.output, /O certificado do IClass \(CA\) foi criado de novo \(a pasta do certificado \(tls\) sumiu\)\. Os aparelhos que já tinham instalado o anterior precisam instalar este/);
    assert.ok(fs.existsSync(path.join(dataDir, 'tls', FILES.caRecreated)));
    assert.notEqual(third.info.fingerprintSha256, first.info.fingerprintSha256);
    assert.ok(third.info.fingerprintSha256);
    const fourth = await boot();
    assert.equal(/criado de novo/.test(fourth.output), false, 'o aviso do console é uma vez só');
});
