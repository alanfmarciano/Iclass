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

// [UC-LAUNCHER-001] O launcher do pacote (fase 3, A16 / P6-S4): IClass.cmd na raiz, e o
// launcher.js com o Node do pacote acha as pastas pelo iclass-pastas.json, liga o servidor
// pelo supervisor, diz o estado e desliga pela rota de controle (parada limpa).
test('[UC-LAUNCHER-001] o launcher do pacote liga pelo supervisor, diz o estado e desliga gravando os dados', { timeout: 3 * 60 * 1000 }, async () => {
    assert.ok(zipFile, 'o teste anterior montou o pacote');
    assert.ok(fs.existsSync(path.join(programDir, 'IClass.cmd')), 'IClass.cmd na raiz do pacote');
    assert.ok(fs.existsSync(path.join(programDir, 'iclass-pastas.json')), 'o teste anterior gravou o iclass-pastas.json');
    const node = path.join(programDir, 'node', 'node');
    const launcher = path.join(programDir, 'backend', 'scripts', 'launcher.js');
    const port = await proc.freePort();
    const run = (...args) => spawnSync(node, [launcher, ...args], { cwd: programDir, env: schoolEnv(port), encoding: 'utf8', timeout: 120000 });
    try {
        const started = run('iniciar', '--sem-navegador', '--porta', String(port));
        assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
        assert.match(started.stdout, /IClass ligado: http:\/\/localhost:\d+/);
        const info = JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime', 'servidor.json'), 'utf8'));
        assert.equal(info.porta, port);
        assert.equal(info.versao, version);

        const status = run('status', '--json');
        assert.equal(status.status, 0, status.stderr);
        const body = JSON.parse(status.stdout.trim().split('\n').pop());
        assert.equal(body.estado, 'ligado');
        assert.equal(body.porta, port);
        assert.equal(body.versaoServidor, version);
        assert.equal(body.provasEmAndamento, 0);
        assert.equal(body.pastaDeDados, dataDir);

        const stopped = run('parar', '--sim');
        assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
        assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime', 'heartbeat.json'), 'utf8')).clean, true);
        assert.equal(fs.existsSync(path.join(dataDir, 'runtime', 'servidor.json')), false);
        assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime', 'supervisor-saida.json'), 'utf8')).codigo, 0);
        assert.equal(run('status', '--json').stdout.includes('"estado":"desligado"'), true);
    } finally {
        // Se algo falhou no meio, não deixa o supervisor solto.
        const pidFile = path.join(dataDir, 'runtime', 'supervisor.pid');
        const pid = fs.existsSync(pidFile) ? Number(String(fs.readFileSync(pidFile, 'utf8')).trim().split(/\s/)[0]) : 0;
        if (pid > 0 && proc.processAlive(pid)) process.kill(pid, 'SIGTERM');
    }
});

// [UC-INSTALACAO-001] [UC-INSTALACAO-002] [UC-VERSAO-002] Instalar, atualizar e voltar de
// versão com o pacote de verdade (fase 3, A17 / P6-S5): o launcher.js do pacote
// descompactado instala no layout D10 (programa\<versão>, versao-atual.txt, dados ao
// lado), trazendo os dados de uma pasta antiga no formato do git (data, content); a
// versão instalada liga com o Node dela e lê os dados trazidos; um pacote "mais novo"
// (o mesmo, com outra versão no manifesto) atualiza guardando a anterior; o voltar
// faz o backup de agora e volta o ponteiro (sem migração entre as duas, nada a restaurar).
test('[UC-INSTALACAO-001] instala o pacote com os dados de uma pasta antiga, atualiza para um pacote mais novo e volta de versão', { timeout: 6 * 60 * 1000 }, async () => {
    assert.ok(zipFile, 'o teste anterior montou o pacote');
    const node = path.join(programDir, 'node', 'node');
    const port = await proc.freePort();
    const env = schoolEnv(port);
    const runFrom = (dir, ...args) => spawnSync(path.join(dir, 'node', 'node'), [path.join(dir, 'backend', 'scripts', 'launcher.js'), ...args], { cwd: dir, env, encoding: 'utf8', timeout: 180000 });
    const show = result => `${result.stdout}\n${result.stderr}`;

    // A pasta antiga (como a do git): data/ com o banco que os testes anteriores gravaram.
    const oldRoot = path.join(tempRoot, 'IClass-antigo');
    fs.cpSync(dataDir, path.join(oldRoot, 'data'), { recursive: true, filter: source => !source.includes(`${path.sep}runtime`) && !source.includes(`${path.sep}logs`) });
    fs.mkdirSync(path.join(oldRoot, 'content'), { recursive: true });
    fs.writeFileSync(path.join(oldRoot, 'content', 'Apostila.md'), '# Apostila\n');
    fs.writeFileSync(path.join(oldRoot, 'ligarIclassV3.bat'), '@echo off\r\n');
    const oldBefore = fs.readFileSync(path.join(oldRoot, 'data', 'database.db'));

    const root = path.join(tempRoot, 'Escola', 'IClass');
    const installed = spawnSync(node, [path.join(programDir, 'backend', 'scripts', 'launcher.js'), 'instalar', '--destino', root, '--trazer-de', oldRoot, '--sem-iniciar', '--sim'], { cwd: programDir, env, encoding: 'utf8', timeout: 180000 });
    assert.equal(installed.status, 0, show(installed));
    assert.match(installed.stdout, /Dados trazidos e conferidos: \d+ arquivos? .* O banco abriu sem problemas\./);
    assert.equal(fs.readFileSync(path.join(root, 'programa', 'versao-atual.txt'), 'utf8'), version);
    const current = path.join(root, 'programa', version);
    assert.ok(fs.existsSync(path.join(current, 'node', 'node')));
    assert.ok(fs.existsSync(path.join(root, 'IClass.cmd')));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(current, 'iclass-pastas.json'), 'utf8')), { dados: '../../dados', conteudo: '../../conteudo', cursosArquivados: '../../cursos-arquivados' });
    assert.ok(fs.existsSync(path.join(root, 'conteudo', 'Apostila.md')));
    assert.ok(fs.readFileSync(path.join(oldRoot, 'data', 'database.db')).equals(oldBefore), 'a pasta antiga fica como estava');

    try {
        const started = runFrom(current, 'iniciar', '--sem-navegador');
        assert.equal(started.status, 0, show(started));
        const status = JSON.parse(runFrom(current, 'status', '--json').stdout.trim().split('\n').pop());
        assert.equal(status.estado, 'ligado');
        assert.equal(status.pastaDeDados, path.join(root, 'dados'));
        assert.equal(status.computadorAcordado, false);

        // Um pacote "mais novo": o mesmo, com outra versão no package.json e no manifesto
        // (o servidor confere que as duas batem).
        const parts = version.split('-')[0].split('.').map(Number);
        const newer = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
        const newPackage = path.join(tempRoot, 'pacote-novo');
        fs.cpSync(programDir, newPackage, { recursive: true, filter: source => path.basename(source) !== 'iclass-pastas.json' });
        const pkgFile = path.join(newPackage, 'package.json');
        fs.writeFileSync(pkgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(pkgFile, 'utf8')), version: newer }, null, 2));
        const manifestFile = path.join(newPackage, 'release-manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        manifest.versao = newer;
        manifest.arquivos['package.json'] = require('node:crypto').createHash('sha256').update(fs.readFileSync(pkgFile)).digest('hex');
        fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
        const updated = runFrom(newPackage, 'atualizar', '--destino', root, '--sim');
        assert.equal(updated.status, 0, show(updated));
        assert.match(updated.stdout, new RegExp(`IClass atualizado de ${version.replace(/\./g, '\\.')} para ${newer.replace(/\./g, '\\.')}`));
        assert.equal(fs.readFileSync(path.join(root, 'programa', 'versao-atual.txt'), 'utf8'), newer);
        assert.ok(fs.existsSync(current), 'a versão anterior fica guardada');
        const info = JSON.parse(fs.readFileSync(path.join(root, 'iclass-instalacao.json'), 'utf8'));
        assert.equal(info.versaoAtual, newer);
        assert.equal(info.versaoAnterior, version);
        // Estava ligado: a versão nova liga sozinha.
        assert.equal(JSON.parse(runFrom(path.join(root, 'programa', newer), 'status', '--json').stdout.trim().split('\n').pop()).estado, 'ligado');

        const back = runFrom(path.join(root, 'programa', newer), 'voltar-versao', '--sim');
        assert.equal(back.status, 0, show(back));
        assert.match(back.stdout, new RegExp(`o IClass voltou para a versão ${version.replace(/\./g, '\\.')}`));
        assert.equal(fs.readFileSync(path.join(root, 'programa', 'versao-atual.txt'), 'utf8'), version);
        const backups = fs.readdirSync(path.join(root, 'dados', 'backups')).filter(name => name.endsWith('.zip'));
        assert.ok(backups.length >= 1, 'o backup de agora foi feito antes de voltar');
        const after = JSON.parse(runFrom(current, 'status', '--json').stdout.trim().split('\n').pop());
        assert.equal(after.estado, 'ligado');
        assert.equal(after.pastaDeDados, path.join(root, 'dados'));
        const stopped = runFrom(current, 'parar', '--sim');
        assert.equal(stopped.status, 0, show(stopped));
    } finally {
        const pidFile = path.join(root, 'dados', 'runtime', 'supervisor.pid');
        const pid = fs.existsSync(pidFile) ? Number(String(fs.readFileSync(pidFile, 'utf8')).trim().split(/\s/)[0]) : 0;
        if (pid > 0 && proc.processAlive(pid)) process.kill(pid, 'SIGTERM');
    }
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
