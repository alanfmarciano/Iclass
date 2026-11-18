// Fase 2, H5d (SEG-16): cabeçalhos de segurança em toda resposta. Antes, páginas e API
// saíam sem CSP, sem proteção contra embutir o painel num iframe de outro site, sem
// nosniff e sem Referrer-Policy, e com "X-Powered-By: Express". Os arquivos de /uploads e
// /imagens continuam com a CSP sandbox própria, mais fechada.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-security-headers-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const runtimePaths = require('../../backend/runtimePaths.js');
const { resetBuildIdCache } = require('../../backend/utils/buildIntegrity.js');
const { createApp, createBootApp } = require('../../backend/server.js');
const { createAdminSession } = require('../../backend/utils/authSessions.js');
const { CONTENT_SECURITY_POLICY } = require('../../backend/utils/securityHeaders.js');

const originalDistDir = runtimePaths.WEB_DIST_DIR;
const distDir = path.join(tempRoot, 'dist');
const ENTRY = 'index-abc123.js';
const ADMIN_EMAIL = 'cabecalhos.admin@teste.local';
// PNG de 1×1.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

let server;
let bootServer;
let baseUrl;
let bootUrl;
let adminToken;

function raw(base, urlPath, { method = 'GET', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(`${base}${urlPath}`, { method, headers }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end();
    });
}

function listen(app) {
    return new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
}

function assertAppHeaders(res, label, { csp = CONTENT_SECURITY_POLICY } = {}) {
    assert.equal(res.headers['content-security-policy'], csp, `${label}: CSP`);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', `${label}: nosniff`);
    assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN', `${label}: X-Frame-Options`);
    assert.equal(res.headers['referrer-policy'], 'strict-origin-when-cross-origin', `${label}: Referrer-Policy`);
    assert.equal(res.headers['x-powered-by'], undefined, `${label}: sem X-Powered-By`);
    // A conexão é http: HSTS nunca (trancaria os alunos, que usam http no mesmo endereço).
    assert.equal(res.headers['strict-transport-security'], undefined, `${label}: sem HSTS no http`);
}

test.before(async () => {
    runtimePaths.WEB_DIST_DIR = distDir;
    fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html lang="pt-BR"><head><title>IClass</title></head><body><div id="root"></div></body></html>\n');
    fs.writeFileSync(path.join(distDir, 'build-meta.json'), JSON.stringify({ sourceHash: 'd'.repeat(64) }) + '\n');
    fs.writeFileSync(path.join(distDir, 'assets', ENTRY), 'console.log("ok");\n');
    resetBuildIdCache();
    await db.init();
    db.memory.admins = [...(db.memory.admins || []), { email: ADMIN_EMAIL, name: 'Admin dos cabeçalhos', role: 'admin', password: 'x' }];
    adminToken = createAdminSession(db.memory, ADMIN_EMAIL);
    fs.mkdirSync(runtimePaths.UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(runtimePaths.UPLOADS_DIR, 'foto-cabecalhos.png'), PNG);
    const imagesDir = path.join(runtimePaths.CONTENT_DIR, 'imagens', 'teste');
    fs.mkdirSync(imagesDir, { recursive: true });
    fs.writeFileSync(path.join(imagesDir, 'figura.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
    server = await listen(createApp());
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    bootServer = await listen(createBootApp());
    bootUrl = `http://127.0.0.1:${bootServer.address().port}`;
});

test.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => bootServer.close(resolve));
    runtimePaths.WEB_DIST_DIR = originalDistDir;
    resetBuildIdCache();
    await new Promise(resolve => setTimeout(resolve, 300));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-SEC-002] a política deixa o app funcionar e fecha o resto', () => {
    const directives = Object.fromEntries(CONTENT_SECURITY_POLICY.split(';').map(part => {
        const [name, ...values] = part.trim().split(/\s+/);
        return [name, values];
    }));
    // Script só do próprio IClass: nada inline, nada de eval, nada de fora.
    assert.deepEqual(directives['script-src'], ["'self'"]);
    assert.deepEqual(directives['default-src'], ["'self'"]);
    assert.deepEqual(directives['object-src'], ["'none'"]);
    assert.deepEqual(directives['frame-ancestors'], ["'self'"]);
    assert.deepEqual(directives['base-uri'], ["'self'"]);
    assert.deepEqual(directives['form-action'], ["'self'"]);
    assert.deepEqual(directives['connect-src'], ["'self'"]);
    // Estilo inline: atributos style do React e o <style> das janelas de impressão.
    assert.ok(directives['style-src'].includes("'unsafe-inline'"));
    // Players da biblioteca.
    for (const origin of ['https://www.youtube.com', 'https://www.youtube-nocookie.com', 'https://player.vimeo.com']) {
        assert.ok(directives['frame-src'].includes(origin), origin);
    }
    // Imagens e vídeos de fora (logo, biblioteca, apostila), inclusive http já gravado.
    for (const source of ["'self'", 'data:', 'blob:', 'http:', 'https:']) assert.ok(directives['img-src'].includes(source), source);
    assert.ok(!CONTENT_SECURITY_POLICY.includes("'unsafe-eval'"));
    assert.ok(!CONTENT_SECURITY_POLICY.includes('upgrade-insecure-requests'), 'o IClass fala http com os alunos');
});

test('[UC-SEC-002] página, API, erro e /assets saem com os cabeçalhos e sem X-Powered-By', async () => {
    const page = await raw(baseUrl, '/');
    assert.equal(page.status, 200);
    assertAppHeaders(page, 'GET /');

    const spa = await raw(baseUrl, '/alunos');
    assert.equal(spa.status, 200);
    assertAppHeaders(spa, 'GET /alunos');

    const publicSettings = await raw(baseUrl, '/api/settings/public');
    assert.equal(publicSettings.status, 200);
    assertAppHeaders(publicSettings, 'GET /api/settings/public');

    const unauthorized = await raw(baseUrl, '/api/admin/whoami');
    assert.equal(unauthorized.status, 401);
    assertAppHeaders(unauthorized, '401 do painel');

    // Rota /api que não existe: o 404 padrão do Express troca a CSP pela dele, ainda mais
    // fechada (default-src 'none'); os outros cabeçalhos ficam.
    const missingApi = await raw(baseUrl, '/api/rota-que-nao-existe');
    assert.equal(missingApi.status, 404);
    assertAppHeaders(missingApi, '404 da API', { csp: "default-src 'none'" });

    const asset = await raw(baseUrl, `/assets/${ENTRY}`);
    assert.equal(asset.status, 200);
    assertAppHeaders(asset, '/assets');

    const missingAsset = await raw(baseUrl, '/assets/nao-existe-123.js');
    assert.equal(missingAsset.status, 404);
    assertAppHeaders(missingAsset, '/assets inexistente');
});

test('[UC-SEC-002] arquivos de /uploads e /imagens mantêm a CSP sandbox própria', async () => {
    const upload = await raw(baseUrl, '/uploads/foto-cabecalhos.png', { headers: { 'x-admin-session': adminToken } });
    assert.equal(upload.status, 200);
    assert.equal(upload.headers['content-security-policy'], "default-src 'none'; sandbox");
    assert.equal(upload.headers['x-content-type-options'], 'nosniff');
    assert.equal(upload.headers['x-frame-options'], 'SAMEORIGIN');
    assert.equal(upload.headers['x-powered-by'], undefined);

    const svg = await raw(baseUrl, '/imagens/teste/figura.svg', { headers: { 'x-admin-session': adminToken } });
    assert.equal(svg.status, 200);
    assert.match(String(svg.headers['content-security-policy']), /^default-src 'none';.*sandbox$/);
    assert.equal(svg.headers['x-powered-by'], undefined);

    // Sem sessão: a recusa também sai com os cabeçalhos do app.
    const denied = await raw(baseUrl, '/uploads/foto-cabecalhos.png');
    assert.equal(denied.status, 401);
    assertAppHeaders(denied, '401 de /uploads');
});

test('[UC-SEC-002] a página "iniciando" do boot e o 503 da API durante o boot também', async () => {
    const page = await raw(bootUrl, '/');
    assert.equal(page.status, 503);
    assertAppHeaders(page, 'boot GET /');
    assert.match(page.body, /<style>/, 'o <style> inline da página de boot vale com a CSP (style-src unsafe-inline)');
    assert.doesNotMatch(page.body, /<script/i);

    const api = await raw(bootUrl, '/api/status');
    assert.equal(api.status, 503);
    assertAppHeaders(api, 'boot /api');
});

test('[UC-SEC-002] ordem do createApp: cabeçalhos logo depois do cors e antes do cabeçalho de build', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'server.js'), 'utf8');
    const createAppBody = source.slice(source.indexOf('function createApp('), source.indexOf('\nreturn app;'));
    const at = needle => {
        const index = createAppBody.indexOf(needle);
        assert.ok(index >= 0, `não achei ${needle} no createApp`);
        return index;
    };
    const requestId = at('app.use(assignRequestId)');
    const cors = at('app.use(cors(');
    const disable = at("app.disable('x-powered-by')");
    const headers = at('app.use(securityHeaders())');
    const build = at('BUILD_ID_HEADER');
    assert.ok(requestId < cors && cors < disable && disable < headers && headers < build,
        'ordem do contrato: requestId → cors → securityHeaders/x-powered-by → cabeçalho de build');
});
