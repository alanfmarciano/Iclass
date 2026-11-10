// Fase 2, H2-A (DES-13, DES-05): as respostas de texto da API acima de 1 KB saem em gzip
// quando o navegador aceita (JSON, data.js, apostilas .md e CSV), sem pacote novo
// (utils/httpCompression.js). Antes, nenhuma resposta era comprimida: na rede da sala,
// 40 celulares baixavam o JSON inteiro a cada consulta. A compressão compõe com o redator
// de privacidade do professor e com quem espera o COMMIT antes de responder (H1-a).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const express = require('express');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-http-compression-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { acceptsEncoding, compressTextResponses } = require('../../backend/utils/httpCompression.js');

const adminToken = 'admin-token-compressao';
const professorToken = 'professor-token-compressao';
const courseId = 'curso-compressao';
const className = 'TURMA GZIP';
const APOSTILA_KEY = 'Apostila_Compressao';
const APOSTILA = `# Apostila de compressão\n\n${'Texto da apostila com acentuação: ação, lição, módulo. '.repeat(80)}\n`;

let server;
let baseUrl;

function seed() {
    db.memory.admins = [
        { email: 'admin@gzip.local', name: 'Admin', role: 'admin', password: db.hashPassword('x') },
        { email: 'prof@gzip.local', name: 'Professor', role: 'professor', password: db.hashPassword('x'), assignedClasses: [{ courseId, className }] },
    ];
    db.memory.adminSessions = {
        [adminToken]: { email: 'admin@gzip.local', createdAt: Date.now(), lastSeen: Date.now() },
        [professorToken]: { email: 'prof@gzip.local', createdAt: Date.now(), lastSeen: Date.now() },
    };
    db.memory.courses = [{ id: courseId, name: 'Curso Compressão', structure: [{ id: 'mod-1', title: 'Módulo 1', units: [{ id: 'un-1', title: 'Unidade 1', apostilaKey: APOSTILA_KEY }] }] }];
    db.memory.classes = [{ name: className, courseId, period: 'Manhã', onlineExamConfigs: {} }];
    db.memory.students = Array.from({ length: 30 }, (_, index) => ({
        name: `Aluna ${index + 1} da Silva`,
        email: `aluna${index + 1}@gzip.local`,
        status: 'Ativo',
        password: db.hashPassword('123'),
        classes: [{ name: className, courseId }],
        studentClass: className,
        ...(index === 0 ? { accessibility: { tempoAdicional: true, tempoAdicionalPercent: 25, observacao: 'Laudo de TDAH, CID F90' } } : {}),
    }));
}

// Pedido cru (sem descompressão automática), para conferir bytes e cabeçalhos.
function raw(method, urlPath, headers = {}, base = baseUrl) {
    return new Promise((resolve, reject) => {
        const req = http.request(`${base}${urlPath}`, { method, headers }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end();
    });
}

function decoded(res) {
    return res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(res.body).toString('utf8') : res.body.toString('utf8');
}

function listen(app) {
    return new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
}

test.before(async () => {
    await db.init();
    seed();
    fs.mkdirSync(process.env.ICLASS_CONTENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.ICLASS_CONTENT_DIR, `${APOSTILA_KEY}.md`), APOSTILA, 'utf8');
    server = await listen(createApp());
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(() => { seed(); });

test.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => setTimeout(resolve, 300));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

const studentsPath = `/api/admin/students?courseId=${courseId}&studentClass=${encodeURIComponent(className)}`;

test('[UC-DESEMPENHO-001] JSON da API acima de 1 KB sai em gzip, com Vary, e o conteúdo é o mesmo sem compressão', async () => {
    const gz = await raw('GET', studentsPath, { 'x-admin-session': adminToken, 'Accept-Encoding': 'gzip, deflate, br' });
    assert.equal(gz.status, 200);
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.match(String(gz.headers.vary || ''), /Accept-Encoding/i);
    assert.match(gz.headers['content-type'], /^application\/json; charset=utf-8$/);
    assert.equal(Number(gz.headers['content-length']), gz.body.length);

    const plain = await raw('GET', studentsPath, { 'x-admin-session': adminToken });
    assert.equal(plain.status, 200);
    assert.equal(plain.headers['content-encoding'], undefined);
    // Mesmo sem aceitar gzip, a resposta avisa que muda com o Accept-Encoding.
    assert.match(String(plain.headers.vary || ''), /Accept-Encoding/i);
    assert.ok(plain.body.length > 1024);
    assert.ok(gz.body.length < plain.body.length / 3, `${gz.body.length} >= ${plain.body.length} / 3`);
    assert.deepEqual(JSON.parse(decoded(gz)), JSON.parse(plain.body.toString('utf8')));
    // Cache e versão do build continuam iguais na resposta comprimida.
    assert.match(String(gz.headers['cache-control'] || ''), /no-store/);
    assert.ok(gz.headers['x-request-id']);
});

test('[UC-DESEMPENHO-001] resposta pequena, HEAD e gzip recusado (q=0) saem sem compressão', async () => {
    const small = await raw('GET', '/api/session/status', { 'Accept-Encoding': 'gzip' });
    assert.equal(small.status, 200);
    assert.ok(small.body.length < 1024);
    assert.equal(small.headers['content-encoding'], undefined);

    const head = await raw('HEAD', studentsPath, { 'x-admin-session': adminToken, 'Accept-Encoding': 'gzip' });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-encoding'], undefined);
    assert.equal(head.body.length, 0);

    const refused = await raw('GET', studentsPath, { 'x-admin-session': adminToken, 'Accept-Encoding': 'gzip;q=0, identity' });
    assert.equal(refused.headers['content-encoding'], undefined);
    assert.ok(JSON.parse(refused.body.toString('utf8')));
});

test('[UC-DESEMPENHO-001] data.js e apostila .md saem em gzip, com o tipo e o texto em UTF-8 intactos', async () => {
    const dataJs = await raw('GET', `/data.js?courseId=${courseId}`, { 'x-admin-session': adminToken, 'Accept-Encoding': 'gzip' });
    assert.equal(dataJs.status, 200);
    assert.equal(dataJs.headers['content-encoding'], 'gzip');
    assert.match(dataJs.headers['content-type'], /^application\/javascript; charset=utf-8$/);
    assert.match(String(dataJs.headers['cache-control'] || ''), /no-store/);
    assert.match(decoded(dataJs), /^const courseData = /);
    assert.ok(decoded(dataJs).includes('ação, lição, módulo'));

    const md = await raw('GET', `/${APOSTILA_KEY}.md`, { 'x-admin-session': adminToken, 'Accept-Encoding': 'gzip' });
    assert.equal(md.status, 200);
    assert.equal(md.headers['content-encoding'], 'gzip');
    assert.match(md.headers['content-type'], /^text\/markdown; charset=utf-8$/);
    assert.equal(decoded(md), APOSTILA);
});

test('[UC-DESEMPENHO-001] professor recebe a observação de acessibilidade mascarada também na resposta comprimida', async () => {
    const asProfessor = await raw('GET', studentsPath, { 'x-admin-session': professorToken, 'Accept-Encoding': 'gzip' });
    assert.equal(asProfessor.status, 200);
    assert.equal(asProfessor.headers['content-encoding'], 'gzip');
    const body = decoded(asProfessor);
    assert.doesNotMatch(body, /TDAH|F90/);
    const rows = JSON.parse(body);
    const list = Array.isArray(rows) ? rows : rows.students;
    const first = list.find(student => student.email === 'aluna1@gzip.local');
    assert.equal(first.accessibility.observacao, '');
    assert.equal(first.accessibility.tempoAdicional, true);

    const asAdmin = await raw('GET', studentsPath, { 'x-admin-session': adminToken, 'Accept-Encoding': 'gzip' });
    assert.match(decoded(asAdmin), /Laudo de TDAH, CID F90/);
});

test('[UC-DESEMPENHO-001] recusa da sessão (401, corpo pequeno) sai como antes, sem compressão', async () => {
    const denied = await raw('GET', studentsPath, { 'Accept-Encoding': 'gzip' });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers['content-encoding'], undefined);
    assert.ok(JSON.parse(denied.body.toString('utf8')).error);
});

// Simula o persistenceContext do H1-a, montado DEPOIS da compressão: o envio dele espera
// as gravações e, se uma falhou, troca a resposta pelo 503 retryable. A compressão só vê
// o que realmente sai.
function deferredCommitApp({ failWrite }) {
    const app = express();
    app.use(compressTextResponses({ minBytes: 1024 }));
    app.use((req, res, next) => {
        const originalSend = res.send;
        let deferred = false;
        res.send = function sendAfterCommit(body) {
            if (deferred) return this;
            deferred = true;
            const statusCode = this.statusCode;
            const contentType = this.get('Content-Type');
            setTimeout(() => {
                res.send = originalSend;
                if (failWrite && statusCode < 400) {
                    res.status(503).json({ success: false, error: 'Não foi possível gravar os dados agora. Tente de novo em alguns segundos.', retryable: true, detalhe: 'x'.repeat(2000) });
                    return;
                }
                res.statusCode = statusCode;
                if (contentType) res.set('Content-Type', contentType);
                originalSend.call(res, body);
            }, 20);
            return this;
        };
        next();
    });
    app.get('/api/salvar', (req, res) => res.json({ success: true, itens: Array.from({ length: 200 }, (_, i) => `item ${i}`) }));
    app.get('/api/salvar-pequeno', (req, res) => res.json({ success: true }));
    return app;
}

test('[UC-DESEMPENHO-001] com a resposta esperando o COMMIT: o 200 sai comprimido e o 503 retryable chega íntegro com gzip', async () => {
    const okServer = await listen(deferredCommitApp({ failWrite: false }));
    const failServer = await listen(deferredCommitApp({ failWrite: true }));
    try {
        const okBase = `http://127.0.0.1:${okServer.address().port}`;
        const ok = await raw('GET', '/api/salvar', { 'Accept-Encoding': 'gzip' }, okBase);
        assert.equal(ok.status, 200);
        assert.equal(ok.headers['content-encoding'], 'gzip');
        assert.equal(JSON.parse(decoded(ok)).itens.length, 200);

        const failBase = `http://127.0.0.1:${failServer.address().port}`;
        const failed = await raw('GET', '/api/salvar', { 'Accept-Encoding': 'gzip' }, failBase);
        assert.equal(failed.status, 503);
        assert.equal(failed.headers['content-encoding'], 'gzip');
        const body = JSON.parse(decoded(failed));
        assert.equal(body.retryable, true);
        assert.equal(body.success, false);
        assert.doesNotMatch(decoded(failed), /item 1/);

        const failedSmall = await raw('GET', '/api/salvar-pequeno', { 'Accept-Encoding': 'gzip' }, failBase);
        assert.equal(failedSmall.status, 503);
        assert.equal(JSON.parse(decoded(failedSmall)).retryable, true);
    } finally {
        await new Promise(resolve => okServer.close(resolve));
        await new Promise(resolve => failServer.close(resolve));
    }
});

test('[UC-DESEMPENHO-001] segundo envio durante a compressão é ignorado com aviso; no-transform, Content-Encoding e binário ficam como estão', async () => {
    const app = express();
    app.use(compressTextResponses({ minBytes: 1024 }));
    const big = 'texto '.repeat(1000);
    app.get('/duas-vezes', (req, res) => {
        res.status(200).type('text/plain').send(big);
        res.status(500).json({ error: 'segunda resposta' });
    });
    app.get('/no-transform', (req, res) => res.set('Cache-Control', 'no-store, no-transform').type('text/plain').send(big));
    app.get('/ja-codificado', (req, res) => res.set('Content-Encoding', 'identity').type('text/plain').send(big));
    app.get('/zip', (req, res) => res.type('application/zip').send(Buffer.alloc(4096, 1)));
    app.get('/csv', (req, res) => res.type('text/csv').send(`nome;nota\n${'Aluna;9,5\n'.repeat(300)}`));
    app.get('/html', (req, res) => res.send(`<p>${big}</p>`));
    app.get('/vazio', (req, res) => res.status(204).send(big));
    const local = await listen(app);
    const base = `http://127.0.0.1:${local.address().port}`;
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    try {
        const twice = await raw('GET', '/duas-vezes', { 'Accept-Encoding': 'gzip' }, base);
        assert.equal(twice.status, 200);
        assert.equal(decoded(twice), big);
        assert.ok(warnings.some(line => line.includes('[COMPRESSÃO] resposta enviada duas vezes') && line.includes('/duas-vezes')));

        const noTransform = await raw('GET', '/no-transform', { 'Accept-Encoding': 'gzip' }, base);
        assert.equal(noTransform.headers['content-encoding'], undefined);
        assert.equal(noTransform.body.toString('utf8'), big);

        const encoded = await raw('GET', '/ja-codificado', { 'Accept-Encoding': 'gzip' }, base);
        assert.equal(encoded.headers['content-encoding'], 'identity');

        const zip = await raw('GET', '/zip', { 'Accept-Encoding': 'gzip' }, base);
        assert.equal(zip.headers['content-encoding'], undefined);
        assert.equal(zip.body.length, 4096);

        const csv = await raw('GET', '/csv', { 'Accept-Encoding': 'gzip' }, base);
        assert.equal(csv.headers['content-encoding'], 'gzip');
        assert.match(csv.headers['content-type'], /^text\/csv; charset=utf-8$/);
        assert.match(decoded(csv), /^nome;nota\nAluna;9,5/);

        // Texto sem tipo vira HTML, como o Express faz.
        const html = await raw('GET', '/html', { 'Accept-Encoding': 'gzip' }, base);
        assert.equal(html.headers['content-encoding'], 'gzip');
        assert.match(html.headers['content-type'], /^text\/html; charset=utf-8$/);

        const empty = await raw('GET', '/vazio', { 'Accept-Encoding': 'gzip' }, base);
        assert.equal(empty.status, 204);
        assert.equal(empty.headers['content-encoding'], undefined);
    } finally {
        console.warn = originalWarn;
        await new Promise(resolve => local.close(resolve));
    }
});

test('[UC-DESEMPENHO-001] leitura do Accept-Encoding', () => {
    assert.equal(acceptsEncoding('gzip, deflate, br', 'gzip'), true);
    assert.equal(acceptsEncoding('GZIP', 'gzip'), true);
    assert.equal(acceptsEncoding('x-gzip', 'gzip'), true);
    assert.equal(acceptsEncoding('gzip;q=0.5', 'gzip'), true);
    assert.equal(acceptsEncoding('gzip;q=0', 'gzip'), false);
    assert.equal(acceptsEncoding('gzip; q=0.000', 'gzip'), false);
    assert.equal(acceptsEncoding('*', 'gzip'), true);
    assert.equal(acceptsEncoding('*;q=0', 'gzip'), false);
    assert.equal(acceptsEncoding('*;q=0, gzip', 'gzip'), true);
    assert.equal(acceptsEncoding('gzip;q=0, *', 'gzip'), false);
    assert.equal(acceptsEncoding('identity', 'gzip'), false);
    assert.equal(acceptsEncoding('deflate, br', 'gzip'), false);
    assert.equal(acceptsEncoding('gzip;q=abc', 'gzip'), false);
    assert.equal(acceptsEncoding('', 'gzip'), false);
    assert.equal(acceptsEncoding(undefined, 'gzip'), false);
    assert.equal(acceptsEncoding('gzip, deflate, br', 'br'), true);
    assert.equal(acceptsEncoding('gzip, deflate', 'br'), false);
});
