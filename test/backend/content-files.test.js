// Arquivos das apostilas: imagens em subpastas/SVG e minigames (18/11/2026).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-content-files-'));
const contentDir = path.join(tempRoot, 'content');
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = contentDir;
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');

const adminToken = 'admin-token-content';
const studentToken = 'student-token-content';
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
const GAME = '<!doctype html><html><head><title>Jogo</title></head><body><script>document.title="ok"</script></body></html>';
let app;

function writeFixtures() {
    fs.mkdirSync(path.join(contentDir, 'imagens', 'fecop', 'cap1'), { recursive: true });
    fs.mkdirSync(path.join(contentDir, 'minigames'), { recursive: true });
    fs.writeFileSync(path.join(contentDir, 'imagens', 'fecop', 'cap1', 'agenda.svg'), SVG);
    fs.writeFileSync(path.join(contentDir, 'imagens', 'SREDS_1_cap1_dora.png'), PNG);
    fs.writeFileSync(path.join(contentDir, 'imagens', 'pagina.html'), GAME);
    fs.writeFileSync(path.join(contentDir, 'minigames', 'SREDS_1_cap1_servidor-dhcp.html'), GAME);
    fs.writeFileSync(path.join(tempRoot, 'segredo.png'), PNG);
}

function seed() {
    db.memory.adminSessions = { [adminToken]: { email: 'admin@content.local', createdAt: Date.now(), lastSeen: Date.now() } };
    db.memory.sessions = { 'ana@content.local': { token: studentToken, createdAt: Date.now() } };
}

test.before(async () => { writeFixtures(); await db.init(); app = createApp(); });
test.beforeEach(() => { seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('imagem em subpasta e em SVG é servida para quem está logado', async () => {
    const res = await request(app).get(`/imagens/fecop/cap1/agenda.svg?access=${studentToken}`);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^image\/svg\+xml/);
    assert.match(res.headers['content-security-policy'], /sandbox/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('imagem na raiz de imagens continua funcionando', async () => {
    const res = await request(app).get('/imagens/SREDS_1_cap1_dora.png').set('x-admin-session', adminToken);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^image\/png/);
});

test('imagem exige sessão', async () => {
    const res = await request(app).get('/imagens/fecop/cap1/agenda.svg');
    assert.equal(res.status, 401);
});

test('imagens só serve formatos de imagem', async () => {
    const res = await request(app).get(`/imagens/pagina.html?access=${studentToken}`);
    assert.equal(res.status, 415);
});

test('imagens recusa sair da pasta', async () => {
    for (const url of ['/imagens/%2E%2E/segredo.png', '/imagens/fecop/%2E%2E/%2E%2E/%2E%2E/segredo.png', '/imagens/.oculto.png', '/imagens/fecop%5C..%5C..%5Csegredo.png']) {
        const res = await request(app).get(`${url}?access=${studentToken}`);
        assert.ok([400, 404].includes(res.status), `${url} devolveu ${res.status}`);
        assert.notEqual(res.status, 200);
    }
});

test('minigame vem como texto puro para o leitor, com token no cabeçalho', async () => {
    const res = await request(app).get('/minigames/SREDS_1_cap1_servidor-dhcp.html').set('x-session-token', studentToken);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/plain/);
    assert.match(res.headers['content-security-policy'], /sandbox/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.text, GAME);
});

test('minigame não aceita token na URL', async () => {
    const res = await request(app).get(`/minigames/SREDS_1_cap1_servidor-dhcp.html?access=${studentToken}`);
    assert.equal(res.status, 401);
});

test('minigame inexistente devolve 404 e nome inválido devolve 400', async () => {
    const missing = await request(app).get('/minigames/nao-existe.html').set('x-session-token', studentToken);
    assert.equal(missing.status, 404);
    for (const url of ['/minigames/%2E%2E%2Fsegredo.html', '/minigames/jogo.js', '/minigames/.jogo.html']) {
        const res = await request(app).get(url).set('x-session-token', studentToken);
        assert.ok([400, 404].includes(res.status), `${url} devolveu ${res.status}`);
        assert.doesNotMatch(String(res.headers['content-type'] || ''), /text\/html/);
    }
});
