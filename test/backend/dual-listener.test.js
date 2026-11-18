// http e https na mesma porta (H6c, SEG-03 e OPS-08): utils/dualListener.js. Antes o
// IClass só abria a porta em http (app.listen), e https://IP:3000 nem conectava.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { createDualServer, listenHttpAndHttps } = require('../../backend/utils/dualListener.js');
const { ensureTlsMaterial } = require('../../backend/utils/tlsCertificates.js');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-dual-listener-test-'));
const material = ensureTlsMaterial({ dir: path.join(tempRoot, 'tls'), addresses: [] });

function makeApp() {
    const app = express();
    app.use(express.json({ limit: '20mb' }));
    app.all('/via', (req, res) => res.json({ encrypted: !!req.socket.encrypted, bytes: JSON.stringify(req.body || {}).length }));
    return app;
}

function call(mod, port, { method = 'GET', body, ca, agent = false } = {}) {
    return new Promise((resolve, reject) => {
        const req = mod.request({
            host: '127.0.0.1', port, path: '/via', method, agent,
            headers: body ? { 'content-type': 'application/json' } : {},
            ...(mod === https ? { ca, servername: 'localhost' } : {}),
        }, res => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data), peer: res.socket && res.socket.getPeerCertificate ? res.socket.getPeerCertificate() : null }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function closeServer(server) {
    return new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
}

test.after(() => { fs.rmSync(tempRoot, { recursive: true, force: true }); });

test('[UC-REDE-004] http e https na mesma porta, com req.socket.encrypted dizendo por onde chegou', async () => {
    const app = makeApp();
    const server = await listenHttpAndHttps({ handler: (req, res) => app(req, res), port: 0, host: '127.0.0.1', tls: material });
    const { port } = server.address();
    try {
        const plain = await call(http, port);
        assert.equal(plain.status, 200);
        assert.equal(plain.body.encrypted, false);
        const secure = await call(https, port, { ca: material.ca.certPem });
        assert.equal(secure.status, 200);
        assert.equal(secure.body.encrypted, true);
        // Nenhuma das duas manda HSTS (os alunos continuam em http no mesmo endereço).
        assert.equal(plain.headers['strict-transport-security'], undefined);
        assert.equal(secure.headers['strict-transport-security'], undefined);
        // Corpo grande (5 MB) inteiro pelas duas vias: o primeiro byte lido volta para o fluxo.
        const big = JSON.stringify({ texto: 'x'.repeat(5 * 1024 * 1024) });
        const bigPlain = await call(http, port, { method: 'POST', body: big });
        assert.equal(bigPlain.body.bytes, big.length);
        const bigSecure = await call(https, port, { method: 'POST', body: big, ca: material.ca.certPem });
        assert.equal(bigSecure.body.bytes, big.length);
        // Aparelho sem a CA: o handshake falha só para ele.
        await assert.rejects(call(https, port), /self.signed|unable to verify|UNABLE_TO_VERIFY/i);
        assert.equal((await call(http, port)).status, 200, 'o servidor continua atendendo');
    } finally {
        await closeServer(server);
    }
});

test('[UC-REDE-004] primeiro byte lixo fecha só aquele socket; conexão muda é fechada no tempo-limite', async () => {
    const app = makeApp();
    const server = await listenHttpAndHttps({ handler: (req, res) => app(req, res), port: 0, host: '127.0.0.1', tls: material, firstByteTimeoutMs: 50 });
    const { port } = server.address();
    try {
        const garbage = await new Promise(resolve => {
            const socket = net.connect(port, '127.0.0.1', () => socket.write(Buffer.from([0x00, 0xff, 0x13, 0x37, 0x0d, 0x0a, 0x0d, 0x0a])));
            let data = '';
            socket.on('data', chunk => { data += chunk; });
            socket.on('close', () => resolve(data));
            socket.on('error', () => {});
        });
        assert.match(garbage, /^HTTP\/1\.1 400/, 'o http recusa e fecha');
        // TLS quebrado (0x16 seguido de lixo): fecha sem derrubar nada.
        await new Promise(resolve => {
            const socket = net.connect(port, '127.0.0.1', () => socket.write(Buffer.from([0x16, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03])));
            socket.on('close', resolve);
            socket.on('error', () => {});
        });
        const started = Date.now();
        await new Promise(resolve => {
            const socket = net.connect(port, '127.0.0.1');
            socket.on('close', resolve);
            socket.on('error', () => {});
        });
        assert.ok(Date.now() - started < 2000, 'conexão sem nenhum byte é fechada');
        assert.equal((await call(http, port)).status, 200);
        assert.equal((await call(https, port, { ca: material.ca.certPem })).status, 200);
    } finally {
        await closeServer(server);
    }
});

test('[UC-REDE-004] updateTls troca o certificado servido a quente, sem fechar a porta', async () => {
    const app = makeApp();
    const server = await listenHttpAndHttps({ handler: (req, res) => app(req, res), port: 0, host: '127.0.0.1', tls: material });
    const { port } = server.address();
    try {
        const before = await call(https, port, { ca: material.ca.certPem });
        const moved = ensureTlsMaterial({ dir: path.join(tempRoot, 'tls'), addresses: [{ name: 'Wi-Fi', address: '10.9.8.7', kind: 'rede' }] });
        assert.equal(moved.changed.server, true);
        assert.equal(server.updateTls(moved), true);
        const after = await call(https, port, { ca: moved.ca.certPem });
        assert.notEqual(after.peer.serialNumber, before.peer.serialNumber, 'conexão nova já vem com o certificado novo');
        const served = new crypto.X509Certificate(after.peer.raw);
        assert.equal(served.checkIP('10.9.8.7'), '10.9.8.7');
        assert.equal(server.listening, true);
    } finally {
        await closeServer(server);
    }
});

test('[UC-REDE-004] sem material TLS: só http; o TLS que chega é fechado; updateTls liga depois', async () => {
    const app = makeApp();
    const server = createDualServer((req, res) => app(req, res), { tls: null });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
        assert.equal(server.tlsEnabled(), false);
        assert.equal((await call(http, port)).status, 200);
        await assert.rejects(call(https, port, { ca: material.ca.certPem }), /socket hang up|ECONNRESET|disconnected/i);
        assert.equal(server.updateTls(material), true);
        assert.equal(server.tlsEnabled(), true);
        assert.equal((await call(https, port, { ca: material.ca.certPem })).body.encrypted, true);
    } finally {
        await closeServer(server);
    }
});

test('[UC-REDE-004] close() libera a porta e porta ocupada rejeita a promessa (saída 2 no startServer)', async () => {
    const app = makeApp();
    const server = await listenHttpAndHttps({ handler: (req, res) => app(req, res), port: 0, host: '127.0.0.1', tls: material });
    const { port } = server.address();
    // Conexão keep-alive aberta: closeIdleConnections/closeAllConnections derrubam e o close termina.
    const agent = new http.Agent({ keepAlive: true });
    assert.equal((await call(http, port, { agent })).status, 200);
    await assert.rejects(listenHttpAndHttps({ handler: (req, res) => app(req, res), port, host: '127.0.0.1', tls: material }), err => err.code === 'EADDRINUSE');
    server.closeIdleConnections();
    await closeServer(server);
    agent.destroy();
    const again = await listenHttpAndHttps({ handler: (req, res) => app(req, res), port, host: '127.0.0.1', tls: material });
    assert.equal(again.address().port, port, 'a porta ficou livre');
    await closeServer(again);
});
