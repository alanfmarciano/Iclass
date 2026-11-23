// Pacote de release de ponta a ponta (fase 3, A15 / P6-S3; OPS-01, OPS-21; D8, D10 e D14 do
// P6). Roda com `npm run test:release` (leva uns minutos: monta o pacote inteiro), fora do
// test:backend. Monta a variante linux-x64 (a mesma receita do pacote do Windows, com o Node
// e o sqlite3 do Linux) sem rede: os binários vêm do cache (scripts/release/.cache, que o
// `npm run test:release` completa antes com --so-baixar) e o npm só usa o cache dele.
// Depois descompacta o ZIP numa pasta vazia, como a escola faria, e sobe o servidor pelo
// supervisor com o Node do próprio pacote e as pastas do iclass-pastas.json.
// Antes desta subetapa não havia pacote: o servidor só subia com web/src na pasta.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const proc = require('../backend/fixtures/server-process.js');
const arquivos = require('../../scripts/release/arquivos.js');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'release', 'montar-pacote.js');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-pacote-linux-'));
const outputDir = path.join(tempRoot, 'saida');
const installDir = path.join(tempRoot, 'C_IClass');
const programDir = path.join(installDir, 'programa', 'versao');
const dataDir = path.join(installDir, 'dados');
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const running = new Set();

test.after(() => {
    running.forEach(child => { try { child.kill('SIGKILL'); } catch (e) { /* já saiu */ } });
    proc.killAll();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

// Ambiente da escola: sem as variáveis de pasta e sem o TEST_MODE (instalação de verdade).
function schoolEnv(port) {
    const env = { ...process.env, PORT: String(port) };
    ['ICLASS_DATA_DIR', 'ICLASS_CONTENT_DIR', 'ICLASS_ARCHIVE_DIR', 'TEST_MODE', 'NODE_TEST_CONTEXT', 'ICLASS_SUPERVISED',
        'ICLASS_ADMIN_SETUP_MODE', 'ICLASS_ADMIN_SETUP_TOKEN', 'ICLASS_RESTARTED', 'NODE_OPTIONS'].forEach(name => { delete env[name]; });
    return env;
}

function start(script, port) {
    const child = spawn(path.join(programDir, 'node', 'node'), [path.join(programDir, ...script.split('/'))], { cwd: programDir, env: schoolEnv(port), stdio: ['ignore', 'pipe', 'pipe'] });
    running.add(child);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => { running.delete(child); resolve({ code, signal }); }));
    return { child, exited, output: () => output, base: `http://127.0.0.1:${port}` };
}

let zipFile;

test('[UC-RELEASE-003] monta a variante linux-x64 sem rede e o ZIP não leva web/src, dependência de desenvolvimento nem node-gyp', { timeout: 15 * 60 * 1000 }, () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--plataforma', 'linux-x64', '--arvore', '--offline', '--saida', outputDir], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, NODE_TEST_CONTEXT: '' } });
    assert.equal(result.status, 0, `montar-pacote.js falhou:\n${String(result.stdout).slice(-3000)}\n${result.stderr}`);
    zipFile = path.join(outputDir, `IClass-${version}-linux-x64.zip`);
    assert.ok(fs.existsSync(zipFile), 'ZIP gerado');
    const sidecar = fs.readFileSync(`${zipFile}.sha256`, 'utf8');
    assert.equal(sidecar.split(/\s+/)[0], arquivos.sha256File(zipFile));

    fs.mkdirSync(programDir, { recursive: true });
    const unzip = spawnSync('unzip', ['-q', zipFile, '-d', programDir], { encoding: 'utf8' });
    assert.equal(unzip.status, 0, unzip.stderr);

    ['release-manifest.json', 'LICENSE.txt', 'THIRD_PARTY_NOTICES.txt', 'CHANGELOG.md', 'Guia de instalação.html', 'package.json', 'package-lock.json',
        'backend/server.js', 'backend/supervisor.js', 'backend/scripts/backup-cli.js', 'web/dist/index.html', 'web/dist/build-meta.json',
        'node/node', 'node/LICENSE', 'node_modules/sqlite3/build/Release/node_sqlite3.node', 'node_modules/express/package.json']
        .forEach(relative => assert.ok(fs.existsSync(path.join(programDir, ...relative.split('/'))), `o pacote tem ${relative}`));
    ['web/src', 'web/package.json', 'web/node_modules', 'test', 'content', 'docs', 'data', 'node_modules/node-gyp', 'node_modules/@playwright',
        'node_modules/supertest', 'node_modules/axe-core', 'scripts', 'mockup-dashboard-v3.html']
        .forEach(relative => assert.ok(!fs.existsSync(path.join(programDir, ...relative.split('/'))), `o pacote não tem ${relative}`));
    assert.ok(fs.statSync(path.join(programDir, 'node', 'node')).mode & 0o100, 'node/node executável depois de descompactar');

    // O manifesto lista todos os arquivos do pacote, com o SHA-256 de cada um.
    const manifest = JSON.parse(fs.readFileSync(path.join(programDir, 'release-manifest.json'), 'utf8'));
    assert.equal(manifest.produto, 'IClass');
    assert.equal(manifest.versao, version);
    assert.equal(manifest.plataforma, 'linux-x64');
    assert.match(manifest.node, /^v22\./);
    assert.match(manifest.commit, /^[0-9a-f]{40}/);
    const files = arquivos.listFiles(programDir).filter(relative => relative !== 'release-manifest.json');
    assert.deepEqual(Object.keys(manifest.arquivos).sort(), files.slice().sort());
    files.forEach(relative => assert.equal(manifest.arquivos[relative], arquivos.sha256File(path.join(programDir, ...relative.split('/'))), relative));

    const notices = fs.readFileSync(path.join(programDir, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
    ['express ', 'sqlite3 ', 'react ', 'Node.js 22.'].forEach(name => assert.ok(notices.includes(name), `avisos com ${name}`));
    assert.match(fs.readFileSync(path.join(programDir, 'Guia de instalação.html'), 'utf8'), /<h2 id="rede-e-firewall">/);
});

test('[UC-RELEASE-003] o pacote descompactado sobe pelo supervisor com o próprio Node, grava os dados nas pastas do iclass-pastas.json e para pela rota de controle', { timeout: 3 * 60 * 1000 }, async () => {
    assert.ok(zipFile, 'o teste anterior montou o pacote');
    fs.writeFileSync(path.join(programDir, 'iclass-pastas.json'), JSON.stringify({
        dados: dataDir,
        conteudo: path.join(installDir, 'conteudo'),
        cursosArquivados: path.join(installDir, 'cursos-arquivados'),
    }, null, 2));
    const port = await proc.freePort();
    const supervisor = start('backend/supervisor.js', port);
    const health = await proc.waitForHealth(supervisor.base, { timeoutMs: 90000, exited: supervisor.exited }).catch(err => {
        throw new Error(`${err.message}\n${supervisor.output()}`);
    });
    assert.equal(health.body.version, version);
    assert.equal(health.body.supervised, true);

    // Interface do web/dist: a página e um asset pré-comprimido em brotli.
    const page = await fetch(`${supervisor.base}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<div id="root">/);
    const asset = /\/assets\/[^"']+\.js/.exec(html)[0];
    const brotli = await fetch(`${supervisor.base}${asset}`, { headers: { 'Accept-Encoding': 'br' } });
    assert.equal(brotli.status, 200);
    assert.equal(brotli.headers.get('content-encoding'), 'br');
    await brotli.arrayBuffer();

    // O banco funciona (sqlite3 do pacote): o administrador inicial entra com a senha
    // temporária, gravada na pasta de dados do iclass-pastas.json.
    const bootstrap = fs.readFileSync(path.join(dataDir, 'bootstrap-admin.txt'), 'utf8');
    const password = /Senha temporária:\s*(\S+)/.exec(bootstrap)[1];
    const login = await proc.call(supervisor.base, '/api/session/admin-login', { method: 'POST', body: { email: 'admin@local', password } });
    assert.equal(login.status, 200, login.text);
    assert.ok(fs.existsSync(path.join(dataDir, 'database.db')), 'o banco fica na pasta "dados" do iclass-pastas.json');
    assert.ok(!fs.existsSync(path.join(programDir, 'data')), 'nada é gravado dentro da pasta da versão');

    // A backup-cli do pacote acha os mesmos dados pelo mesmo arquivo.
    const list = spawnSync(path.join(programDir, 'node', 'node'), [path.join(programDir, 'backend', 'scripts', 'backup-cli.js'), 'listar'], { cwd: programDir, env: schoolEnv(port), encoding: 'utf8' });
    assert.match(list.stdout, new RegExp(path.join(dataDir, 'backups').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const token = fs.readFileSync(proc.controlTokenFile(dataDir), 'utf8').trim();
    const stop = await proc.call(supervisor.base, '/api/system/control', { method: 'POST', headers: { 'x-iclass-control': token }, body: { action: 'stop' } });
    assert.equal(stop.status, 202, stop.text);
    const exit = await supervisor.exited;
    assert.equal(exit.code, 0, supervisor.output());
});

test('[UC-RELEASE-003] arquivo da interface alterado no pacote: o servidor sai com 2 e pede para reinstalar', { timeout: 60 * 1000 }, async () => {
    assert.ok(zipFile, 'o teste anterior montou o pacote');
    fs.appendFileSync(path.join(programDir, 'web', 'dist', 'index.html'), '<!-- mexido -->');
    const port = await proc.freePort();
    const server = start('backend/server.js', port);
    const exit = await server.exited;
    assert.equal(exit.code, 2, server.output());
    assert.match(server.output(), /Os arquivos da interface estão incompletos ou foram alterados\. Reinstale esta versão do IClass\./);
    assert.match(server.output(), /web\/dist\/index\.html \(alterado\)/);
});
