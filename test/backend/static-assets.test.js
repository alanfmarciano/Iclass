// Fase 2, H2-A (DES-05): os arquivos do app em /assets, com hash no nome, ficam no
// aparelho para sempre (cache imutável) e saem comprimidos pelas versões .br e .gz que o
// build grava; a API e o index.html nunca ficam em cache, porque a recarga automática
// depois de uma atualização depende deles. Antes, todo .js saía com no-store (o celular
// baixava o app inteiro a cada abertura) e um /assets/x.js que não existe voltava como o
// index.html com 200, o que com cache imutável gravaria HTML no lugar de JS por um ano.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-static-assets-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const express = require('express');
const db = require('../../backend/database.js');
const runtimePaths = require('../../backend/runtimePaths.js');
const { resetBuildIdCache } = require('../../backend/utils/buildIntegrity.js');
const { createApp } = require('../../backend/server.js');
const { assignRequestId } = require('../../backend/middlewares.js');
const { createStudentSession } = require('../../backend/utils/authSessions.js');
const { serveBuildAssets } = require('../../backend/utils/staticAssets.js');

const originalDistDir = runtimePaths.WEB_DIST_DIR;
const distDir = path.join(tempRoot, 'dist');
const assetsDir = path.join(distDir, 'assets');
const ENTRY = 'index-abc123.js';
const ENTRY_SOURCE = `console.log(${JSON.stringify('IClass '.repeat(400))});\n`;
const CSS = 'index-def456.css';
const CSS_SOURCE = `body{color:#123}\n${'.x{margin:0}'.repeat(200)}\n`;
const LEGACY = 'velho-789xyz.js';
const LEGACY_SOURCE = `export const velho = ${JSON.stringify('sem compressão '.repeat(100))};\n`;
const INDEX_HTML = '<!doctype html><html lang="pt-BR"><head><title>IClass</title></head><body><div id="root"></div></body></html>\n';

let server;
let baseUrl;

function writeBuild() {
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'index.html'), INDEX_HTML);
    fs.writeFileSync(path.join(distDir, 'build-meta.json'), JSON.stringify({ sourceHash: 'c'.repeat(64) }) + '\n');
    fs.writeFileSync(path.join(assetsDir, ENTRY), ENTRY_SOURCE);
    fs.writeFileSync(path.join(assetsDir, `${ENTRY}.gz`), zlib.gzipSync(Buffer.from(ENTRY_SOURCE), { level: 9 }));
    fs.writeFileSync(path.join(assetsDir, `${ENTRY}.br`), zlib.brotliCompressSync(Buffer.from(ENTRY_SOURCE)));
    fs.writeFileSync(path.join(assetsDir, CSS), CSS_SOURCE);
    fs.writeFileSync(path.join(assetsDir, `${CSS}.gz`), zlib.gzipSync(Buffer.from(CSS_SOURCE), { level: 9 }));
    // Build de antes da fase 2: sem as versões comprimidas.
    fs.writeFileSync(path.join(assetsDir, LEGACY), LEGACY_SOURCE);
    resetBuildIdCache();
}

// Pedido cru (sem descompressão automática), para conferir os bytes e os cabeçalhos.
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

test.before(async () => {
    runtimePaths.WEB_DIST_DIR = distDir;
    writeBuild();
    await db.init();
    const app = createApp();
    server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    await new Promise(resolve => server.close(resolve));
    runtimePaths.WEB_DIST_DIR = originalDistDir;
    resetBuildIdCache();
    await new Promise(resolve => setTimeout(resolve, 300));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

function assertImmutable(res) {
    const cacheControl = String(res.headers['cache-control'] || '');
    assert.match(cacheControl, /max-age=31536000/);
    assert.match(cacheControl, /immutable/);
    assert.doesNotMatch(cacheControl, /no-store/);
    assert.equal(res.headers.pragma, undefined);
    assert.match(String(res.headers.vary || ''), /Accept-Encoding/i);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
}

test('[UC-DESEMPENHO-001] /assets com gzip: versão .gz do build, cache imutável de um ano e Vary', async () => {
    const res = await raw('GET', `/assets/${ENTRY}`, { 'Accept-Encoding': 'gzip, deflate' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.match(res.headers['content-type'], /javascript/);
    assertImmutable(res);
    // Pedaço de arquivo comprimido não faz sentido: sem Accept-Ranges.
    assert.equal(res.headers['accept-ranges'], undefined);
    assert.equal(zlib.gunzipSync(res.body).toString('utf8'), ENTRY_SOURCE);
    assert.ok(res.body.length < Buffer.byteLength(ENTRY_SOURCE) / 4);

    const css = await raw('GET', `/assets/${CSS}`, { 'Accept-Encoding': 'gzip' });
    assert.equal(css.headers['content-encoding'], 'gzip');
    assert.match(css.headers['content-type'], /text\/css/);
    assert.equal(zlib.gunzipSync(css.body).toString('utf8'), CSS_SOURCE);
});

test('[UC-DESEMPENHO-001] /assets com br (HTTPS): versão .br; sem Accept-Encoding: o arquivo original', async () => {
    const br = await raw('GET', `/assets/${ENTRY}`, { 'Accept-Encoding': 'gzip, deflate, br' });
    assert.equal(br.status, 200);
    assert.equal(br.headers['content-encoding'], 'br');
    assertImmutable(br);
    assert.equal(zlib.brotliDecompressSync(br.body).toString('utf8'), ENTRY_SOURCE);

    // br recusado (q=0): cai no gzip.
    const noBr = await raw('GET', `/assets/${ENTRY}`, { 'Accept-Encoding': 'br;q=0, gzip' });
    assert.equal(noBr.headers['content-encoding'], 'gzip');

    const plain = await raw('GET', `/assets/${ENTRY}`);
    assert.equal(plain.status, 200);
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.headers['accept-ranges'], 'bytes');
    assertImmutable(plain);
    assert.equal(plain.body.toString('utf8'), ENTRY_SOURCE);

    // CSS só com .gz: quem aceita só br recebe o original.
    const cssBrOnly = await raw('GET', `/assets/${CSS}`, { 'Accept-Encoding': 'br' });
    assert.equal(cssBrOnly.headers['content-encoding'], undefined);
    assert.equal(cssBrOnly.body.toString('utf8'), CSS_SOURCE);
});

test('[UC-DESEMPENHO-001] build antigo, sem .gz nem .br: sai o original, também com cache imutável', async () => {
    const res = await raw('GET', `/assets/${LEGACY}`, { 'Accept-Encoding': 'gzip, br' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-encoding'], undefined);
    assertImmutable(res);
    assert.equal(res.body.toString('utf8'), LEGACY_SOURCE);
});

test('[UC-DESEMPENHO-001] arquivo que não existe em /assets é 404 com no-store, nunca o index.html', async () => {
    for (const urlPath of ['/assets/nao-existe.js', '/assets/index-antigo999.css', '/assets/', '/assets']) {
        const res = await raw('GET', urlPath, { 'Accept-Encoding': 'gzip' });
        assert.equal(res.status, 404, urlPath);
        assert.match(String(res.headers['cache-control'] || ''), /no-store/, urlPath);
        assert.doesNotMatch(String(res.headers['cache-control'] || ''), /immutable/, urlPath);
        assert.doesNotMatch(res.body.toString('utf8'), /<!doctype html>|<div id="root">/i, urlPath);
        assert.equal(res.body.toString('utf8'), 'Arquivo não encontrado.', urlPath);
        assert.match(res.headers['content-type'], /text\/plain/, urlPath);
    }
});

test('[UC-DESEMPENHO-001] versões comprimidas e caminhos fora da pasta não saem por nome', async () => {
    for (const urlPath of [
        `/assets/${ENTRY}.gz`,
        `/assets/${ENTRY}.br`,
        '/assets/..%2Fbuild-meta.json',
        '/assets/%2e%2e%2fbuild-meta.json',
        '/assets/..%2Findex.html',
        '/assets/.hidden.js',
        '/assets/sub/dir.js',
    ]) {
        const res = await raw('GET', urlPath, { 'Accept-Encoding': 'gzip' });
        assert.equal(res.status, 404, urlPath);
        assert.match(String(res.headers['cache-control'] || ''), /no-store/, urlPath);
        assert.doesNotMatch(res.body.toString('utf8'), /sourceHash|<div id="root">/, urlPath);
    }
});

test('[UC-DESEMPENHO-001] nomes que o Vite dá a pedaços compartilhados (começando com _ ou -) saem com cache imutável', async () => {
    // Antes, o servidor recusava nome começando com '_' (404 no-store), e o Vite gera
    // nomes assim (_commonjsHelpers-<hash>.js, ou um módulo _baseHelper.js de uma
    // dependência): depois de uma atualização, a tela que usasse esse pedaço quebrava.
    const shared = ['_baseHelper-Do-915rM.js', '__vite-browser-external-9aZ.js', '-inicio-x1.js'];
    const source = `export const ajuda = ${JSON.stringify('pedaço compartilhado '.repeat(80))};\n`;
    for (const name of shared) {
        fs.writeFileSync(path.join(assetsDir, name), source);
        fs.writeFileSync(path.join(assetsDir, `${name}.gz`), zlib.gzipSync(Buffer.from(source), { level: 9 }));
    }
    try {
        for (const name of shared) {
            const res = await raw('GET', `/assets/${name}`, { 'Accept-Encoding': 'gzip' });
            assert.equal(res.status, 200, name);
            assert.equal(res.headers['content-encoding'], 'gzip', name);
            assert.match(String(res.headers['cache-control']), /immutable/, name);
            assert.match(String(res.headers['content-type']), /javascript/, name);
            assert.equal(zlib.gunzipSync(res.body).toString('utf8'), source, name);
        }
        // Ponto no começo ou no fim continua recusado (arquivo oculto; no Windows, o ponto
        // final some e o nome cairia em outro arquivo).
        fs.writeFileSync(path.join(assetsDir, '.oculto.js'), source);
        for (const urlPath of ['/assets/.oculto.js', `/assets/${ENTRY}.`, `/assets/${ENTRY}.gz.`]) {
            const res = await raw('GET', urlPath, { 'Accept-Encoding': 'gzip' });
            assert.equal(res.status, 404, urlPath);
            assert.match(String(res.headers['cache-control'] || ''), /no-store/, urlPath);
        }
    } finally {
        for (const name of [...shared, ...shared.map(n => `${n}.gz`), '.oculto.js']) fs.rmSync(path.join(assetsDir, name), { force: true });
    }
});

test('[UC-DESEMPENHO-001] HEAD e revalidação (ETag → 304) em /assets; outro método é 405', async () => {
    const head = await raw('HEAD', `/assets/${ENTRY}`, { 'Accept-Encoding': 'gzip' });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-encoding'], 'gzip');
    assert.equal(head.body.length, 0);
    assertImmutable(head);

    const first = await raw('GET', `/assets/${ENTRY}`, { 'Accept-Encoding': 'gzip' });
    assert.ok(first.headers.etag);
    const again = await raw('GET', `/assets/${ENTRY}`, { 'Accept-Encoding': 'gzip', 'If-None-Match': first.headers.etag });
    assert.equal(again.status, 304);
    assert.equal(again.body.length, 0);

    const post = await raw('POST', `/assets/${ENTRY}`);
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD');
    assert.match(String(post.headers['cache-control'] || ''), /no-store/);
});

test('[UC-DESEMPENHO-001] / e as rotas do app entregam o index.html sempre com no-store', async () => {
    for (const urlPath of ['/', '/login', '/aluno/provas', '/monitor']) {
        const res = await raw('GET', urlPath, { 'Accept-Encoding': 'gzip' });
        assert.equal(res.status, 200, urlPath);
        assert.match(res.headers['content-type'], /text\/html/, urlPath);
        assert.match(String(res.headers['cache-control'] || ''), /no-store/, urlPath);
        assert.doesNotMatch(String(res.headers['cache-control'] || ''), /max-age=[1-9]/, urlPath);
        assert.equal(res.body.toString('utf8'), INDEX_HTML, urlPath);
    }
    const direct = await raw('GET', '/index.html');
    assert.equal(direct.status, 200);
    assert.match(String(direct.headers['cache-control'] || ''), /no-store/);
});

test('[UC-DESEMPENHO-001] toda resposta /api sai com no-store, inclusive 401 e rota inexistente', async () => {
    for (const urlPath of ['/api/rota-que-nao-existe', '/api/admin/whoami', '/api/student/sync', '/api/branding']) {
        const res = await raw('GET', urlPath, { 'Accept-Encoding': 'gzip' });
        assert.match(String(res.headers['cache-control'] || ''), /no-store/, `${urlPath} (${res.status})`);
    }
    // Rota que define o próprio Cache-Control continua definindo: as do aluno mandam um
    // valor diferente do padrão de /api, e é o delas que chega.
    db.memory.students = [{ name: 'Ana Assets', email: 'ana@assets.local', status: 'Ativo', password: db.hashPassword('x'), classes: [] }];
    const token = createStudentSession(db.memory, 'ana@assets.local');
    for (const urlPath of ['/api/student/exam-applications', '/api/student/sync?studentClass=TURMA-QUE-NAO-EXISTE']) {
        const res = await raw('GET', urlPath, { 'x-session-token': token, 'Accept-Encoding': 'gzip' });
        assert.equal(res.status, 200, urlPath);
        assert.equal(res.headers['cache-control'], 'no-store, no-cache, must-revalidate, private', urlPath);
    }
    const status = await raw('GET', '/api/session/status');
    assert.equal(status.headers['cache-control'], 'no-store');
});

// App mínimo com o handler de /assets e o código do pedido (como no createApp), com o
// envio do arquivo trocado por uma falha de disco: como root, chmod não impede a leitura.
async function withFailingAssets(breakResponse, fn) {
    const app = express();
    app.use(assignRequestId);
    app.use((req, res, next) => { breakResponse(res); next(); });
    app.use('/assets', serveBuildAssets(distDir));
    const failing = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    try {
        return await fn(`http://127.0.0.1:${failing.address().port}`);
    } finally {
        await new Promise(resolve => failing.close(resolve));
    }
}

function crashLogText() {
    const file = path.join(runtimePaths.DATA_DIR, 'crash.log');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function assertContractInternalError(res, label) {
    const requestId = res.headers['x-request-id'];
    assert.ok(requestId, label);
    assert.equal(res.status, 500, label);
    assert.match(res.headers['content-type'], /application\/json/, label);
    assert.deepEqual(JSON.parse(res.body.toString('utf8')), {
        success: false,
        error: `Ocorreu um erro interno no servidor. Código do erro: ${requestId}.`,
        requestId,
    }, label);
    const cacheControl = String(res.headers['cache-control'] || '');
    assert.match(cacheControl, /no-store/, label);
    assert.doesNotMatch(cacheControl, /immutable|max-age=31536000/, label);
    assert.equal(res.headers['content-encoding'], undefined, label);
    // O ETag do arquivo (preparado pelo envio) não fica na resposta de erro.
    assert.notEqual(res.headers.etag, 'W/"123-abc"', label);
    assert.match(crashLogText(), new RegExp(`erro interno ${requestId} GET /assets/${ENTRY.replace(/\./g, '\\.')}`), label);
    return requestId;
}

test('[UC-DESEMPENHO-001] falha inesperada ao enviar um arquivo de /assets: 500 do contrato, com o código do erro e o registro no crash.log', async () => {
    // Antes: texto próprio ("Não foi possível enviar um arquivo do app"), sem o código do
    // erro, fora do padrão do H9a.
    await withFailingAssets((res) => {
        res.sendFile = function sendFileWithDiskError(file, options, callback) {
            // O envio já tinha preparado o cache imutável e o ETag quando o disco falhou.
            this.set('Cache-Control', 'public, max-age=31536000, immutable');
            this.set('ETag', 'W/"123-abc"');
            const err = new Error('EIO: i/o error, read');
            err.code = 'EIO';
            setImmediate(() => callback(err));
        };
    }, async (base) => {
        const res = await raw('GET', `/assets/${ENTRY}`, { 'Accept-Encoding': 'gzip' }, base);
        assertContractInternalError(res, 'falha de disco no envio');
        assert.match(crashLogText(), /EIO: i\/o error, read/);
        assert.match(crashLogText(), /Falha ao enviar um arquivo do app \(\/assets\)\./);
    });

    await withFailingAssets((res) => {
        res.vary = () => { throw new TypeError('vary quebrado'); };
    }, async (base) => {
        const res = await raw('GET', `/assets/${ENTRY}`, { 'Accept-Encoding': 'gzip' }, base);
        assertContractInternalError(res, 'exceção antes do envio');
    });

    // O arquivo que some entre a conferência e o envio continua 404, sem registro.
    await withFailingAssets((res) => {
        res.sendFile = function sendFileVanished(file, options, callback) {
            const err = new Error('ENOENT: no such file or directory');
            err.code = 'ENOENT';
            err.status = 404;
            setImmediate(() => callback(err));
        };
    }, async (base) => {
        const res = await raw('GET', `/assets/${ENTRY}`, { 'Accept-Encoding': 'gzip' }, base);
        assert.equal(res.status, 404);
        assert.equal(res.body.toString('utf8'), 'Arquivo não encontrado.');
        assert.doesNotMatch(crashLogText(), new RegExp(res.headers['x-request-id']));
    });
});

test('[UC-DESEMPENHO-001] index.html ausente (build sendo refeito): 503 em português, sem cache, e /assets continua 404', async () => {
    const indexPath = path.join(distDir, 'index.html');
    fs.renameSync(indexPath, `${indexPath}.tmp`);
    try {
        const res = await raw('GET', '/login');
        assert.equal(res.status, 503);
        assert.equal(res.headers['retry-after'], '3');
        assert.match(String(res.headers['cache-control'] || ''), /no-store/);
        assert.match(res.body.toString('utf8'), /O IClass está sendo atualizado/);
        const asset = await raw('GET', '/assets/nao-existe.js');
        assert.equal(asset.status, 404);
    } finally {
        fs.renameSync(`${indexPath}.tmp`, indexPath);
    }
});
