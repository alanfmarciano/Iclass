// Instalar, atualizar, voltar de versão, ligar com o Windows e desinstalar o IClass do
// pacote (fase 3, A17 / P6-S5; OPS-01, OPS-02; D10, D12, D13 e D24 do P6). Antes não
// existia: instalar era o INSTALAR_E_COMPILAR.bat (Node no PATH, internet, npm install e
// build na escola), atualizar era copiar a pasta por cima à mão e não havia volta de versão.
// Os pacotes aqui são pastas de mentira com um release-manifest.json de verdade; o
// processo do servidor, o HTTP, a backup-cli e o atalho do Windows são injetados (relógio de
// mentira, sem esperar de verdade). O banco da pasta antiga é um SQLite de verdade.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const launcherCore = require('../../backend/utils/launcherCore.js');
const launcherInstall = require('../../backend/utils/launcherInstall.js');
const launcherScript = require('../../backend/scripts/launcher.js');
const { writeReleaseManifest } = require('../../scripts/release/montar-pacote.js');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-instalar-'));
const TOKEN = 'cd'.repeat(32);

test.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------- pacotes e pastas

let packageCount = 0;

// Uma pasta de pacote extraída (como o ZIP do release), com o release-manifest.json.
function makePackage(version, { extra = {} } = {}) {
    packageCount += 1;
    const dir = path.join(tempRoot, `pacote-${packageCount}-${version}`);
    const files = {
        'package.json': JSON.stringify({ name: 'iclass', version }),
        'backend/server.js': `// servidor ${version}\n`,
        'backend/supervisor.js': `// supervisor ${version}\n`,
        'backend/scripts/launcher.js': `// launcher ${version}\n`,
        'backend/scripts/backup-cli.js': `// backup-cli ${version}\n`,
        'web/dist/index.html': `<div id="root"></div><!-- ${version} -->`,
        'web/dist/build-meta.json': JSON.stringify({ version }),
        'node/node': '#!/bin/sh\n',
        'IClass.cmd': `@echo off\r\nrem IClass ${version}\r\n`,
        'desinstalar.ps1': `# desinstalar ${version}\n`,
        'Instalar IClass.cmd': '@echo off\r\n',
        'instalar.ps1': '# instalar\n',
        ...extra,
    };
    Object.entries(files).forEach(([relative, content]) => {
        const file = path.join(dir, ...relative.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    });
    writeReleaseManifest(dir, { versao: version, commit: 'f'.repeat(40), plataforma: 'linux-x64', node: 'v22.23.5' });
    return dir;
}

function newRoot(prefix) {
    return path.join(fs.mkdtempSync(path.join(tempRoot, prefix)), 'IClass');
}

// SHA-256 de cada arquivo de uma árvore (o que "não mudar nada" quer dizer).
function treeHash(dir) {
    const out = {};
    const walk = (current, relative) => {
        if (!fs.existsSync(current)) return;
        fs.readdirSync(current, { withFileTypes: true }).forEach(entry => {
            const rel = relative ? `${relative}/${entry.name}` : entry.name;
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) walk(full, rel);
            else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
        });
    };
    walk(dir, '');
    return out;
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeRuntime(dataDir, name, value) {
    fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'runtime', name), typeof value === 'string' ? value : JSON.stringify(value));
}

const refused = () => Object.assign(new Error('recusada'), { code: 'ECONNREFUSED' });

function statusBody(extra = {}) {
    return { status: 200, body: { success: true, versao: '3.1.0', instanceId: 'atual', pid: 5001, porta: 4321, fase: 'ready', pronto: true, supervisionado: true, provasEmAndamento: 0, provas: [], alunosConectados: 0, enderecoAlunos: null, ...extra } };
}

// Um computador de mentira, como o de launcher-core.test.js: processos vivos por pid,
// relógio que só anda no sleep e um servidor cujas respostas cada teste define. Todo
// supervisor que o launcher sobe "liga" na hora (servidor.json, token e health 200).
function createWorld({ projectRoot, platform = 'linux', env = {}, answers = [], port = 4321 } = {}) {
    const world = {
        clock: 1_700_000_000_000,
        alive: new Set(),
        lines: [],
        requests: [],
        spawns: [],
        runs: [],
        asks: [],
        kills: [],
        browser: [],
        shortcuts: { created: [], removed: [], existing: new Set() },
        answers: answers.slice(),
        handlers: {},
        nextPid: 6000,
        port,
    };
    world.options = {
        projectRoot,
        port,
        platform,
        env: { PATH: process.env.PATH, ...env },
        startSupervisor: params => {
            world.spawns.push(params);
            const child = new EventEmitter();
            child.pid = world.nextPid;
            if (world.handlers.spawn) {
                world.handlers.spawn(params, child);
            } else {
                const pid = world.nextPid;
                world.nextPid += 1;
                const dataDir = params.env.ICLASS_DATA_DIR;
                writeRuntime(dataDir, 'servidor.json', { formato: 1, pid, porta: port, instanceId: `inst-${pid}` });
                writeRuntime(dataDir, 'control.token', TOKEN);
                world.alive.add(pid);
                world.current = { pid, instanceId: `inst-${pid}`, dataDir, script: params.script };
            }
            return { child, tracksExit: true };
        },
        request: async params => {
            world.requests.push({ ...params, at: world.clock });
            const key = `${params.method} ${params.pathname}`;
            if (world.handlers[key]) {
                const result = await world.handlers[key](params);
                if (result instanceof Error) throw result;
                return result;
            }
            const current = world.current;
            if (!current || !world.alive.has(current.pid)) throw refused();
            if (key === 'GET /api/health') return { status: 200, body: { status: 'ok', instanceId: current.instanceId } };
            if (key === 'GET /api/system/control/status') return statusBody({ instanceId: current.instanceId, pid: current.pid });
            if (key === 'POST /api/system/control') {
                world.alive.delete(current.pid);
                return { status: 202, body: { success: true } };
            }
            throw refused();
        },
        openBrowser: url => { world.browser.push(url); return true; },
        killTree: (pid, options) => { world.kills.push({ pid, force: options.force === true }); return { ok: true }; },
        run: async params => {
            world.runs.push(params);
            return world.handlers.run ? world.handlers.run(params) : 0;
        },
        isAlive: pid => world.alive.has(pid),
        isNodeProcess: () => true,
        sleep: async ms => { world.clock += ms; },
        now: () => world.clock,
        out: line => world.lines.push(line),
        ask: async question => {
            world.asks.push(question);
            return world.answers.length ? world.answers.shift() : '';
        },
        shortcut: {
            create: params => { world.shortcuts.created.push(params); world.shortcuts.existing.add(params.file); fs.mkdirSync(path.dirname(params.file), { recursive: true }); fs.writeFileSync(params.file, 'lnk'); return true; },
            remove: file => { world.shortcuts.removed.push(file); world.shortcuts.existing.delete(file); fs.rmSync(file, { force: true }); return true; },
            exists: file => world.shortcuts.existing.has(file),
        },
        timeouts: { pollMs: 500 },
    };
    world.launcher = launcherCore.createLauncher(world.options);
    world.text = () => world.lines.join('\n');
    return world;
}

// O launcher da versão instalada (o do IClass.cmd da raiz).
function installedWorld(root, version, extra = {}) {
    return createWorld({ projectRoot: path.join(root, 'programa', version), ...extra });
}

async function install(version, root, extra = {}) {
    const pkg = makePackage(version);
    const world = createWorld({ projectRoot: pkg, ...(extra.world || {}) });
    const result = await world.launcher.instalar({ destino: root, semIniciar: true, sim: true, ...(extra.params || {}) });
    return { pkg, world, result };
}

// Um IClass "ligado" nesta pasta de dados (servidor.json, token e processo vivo).
function runningServer(world, dataDir, { pid = 5001, status = statusBody() } = {}) {
    writeRuntime(dataDir, 'servidor.json', { formato: 1, pid, porta: world.port, instanceId: 'atual', versao: '3.1.0' });
    writeRuntime(dataDir, 'control.token', TOKEN);
    world.alive.add(pid);
    world.current = { pid, instanceId: 'atual', dataDir };
    if (status) world.handlers['GET /api/system/control/status'] = () => (world.alive.has(pid) ? status : refused());
    return pid;
}

function createSqlite(file, students = 3) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(file, err => {
            if (err) return reject(err);
            db.serialize(() => {
                db.run('CREATE TABLE students (email TEXT PRIMARY KEY, data TEXT)');
                for (let i = 0; i < students; i += 1) db.run('INSERT INTO students VALUES (?, ?)', [`aluno${i}@escola.local`, '{}']);
                db.close(closeErr => (closeErr ? reject(closeErr) : resolve()));
            });
            return undefined;
        });
    });
}

// A pasta do git do Alan (281029f): data/, content/ e cursos_arquivados/, com as pastas de
// trabalho do servidor que não vão na cópia.
async function makeOldFolder(prefix = 'antiga-') {
    const oldRoot = fs.mkdtempSync(path.join(tempRoot, prefix));
    const write = (relative, content) => {
        const file = path.join(oldRoot, ...relative.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    };
    await createSqlite(path.join(oldRoot, 'data', 'database.db'), 4);
    write('ligarIclassV3.bat', '@echo off\r\n');
    write('data/database.db-shm', 'shm');
    write('data/tls/ca.key.pem', 'CA DA ESCOLA');
    write('data/backups/automatico_dados_20261120-080000.zip', 'zip');
    write('data/uploads/foto.png', 'png');
    write('data/runtime/control.token', TOKEN);
    write('data/runtime/heartbeat.json', '{}');
    write('data/logs/servidor.log', 'log antigo\n');
    write('data/quarentena/database.db', 'velho');
    write('data/.restauracao/sobra.txt', 'sobra');
    write('data/.backup-trabalho/x.db', 'x');
    write('data/entregas/.recebendo/parcial.bin', 'pela metade');
    write('data/entregas/asg_1/asub_1/trabalho.pdf', 'pdf');
    write('content/Apostila_FUTEC_1.md', '# Apostila editada pela escola');
    write('content/imagens/figura.png', 'figura');
    write('cursos_arquivados/curso_velho/curso.json', '{}');
    return oldRoot;
}

// ---------------------------------------------------------------- versões

test('[UC-INSTALACAO-001] versões: SemVer com versão de teste antes da final', () => {
    const { compareVersions, parseVersion } = launcherInstall;
    assert.equal(compareVersions('3.1.0', '3.1.1'), -1);
    assert.equal(compareVersions('3.10.0', '3.9.9'), 1);
    assert.equal(compareVersions('3.1.1-teste', '3.1.1'), -1);
    assert.equal(compareVersions('3.1.1-teste', '3.1.0'), 1);
    assert.equal(compareVersions('3.1.1-2', '3.1.1-10'), -1);
    assert.equal(compareVersions('3.1.0', '3.1.0'), 0);
    assert.equal(parseVersion('3.1'), null);
    assert.equal(parseVersion('../3.1.0'), null);
});

// ---------------------------------------------------------------- instalar

test('[UC-INSTALACAO-001] instalação nova: programa/<versão>, ponteiro, iclass-pastas.json e iclass-instalacao.json; a segunda instalação da mesma versão não muda nada', async () => {
    const root = newRoot('nova-');
    const { pkg, world, result } = await install('3.1.0', root);
    assert.equal(result.code, 0, world.text());
    assert.equal(result.kind, 'nova');
    const program = path.join(root, 'programa', '3.1.0');
    const manifest = readJson(path.join(pkg, 'release-manifest.json'));
    Object.keys(manifest.arquivos).forEach(relative => {
        assert.equal(treeHash(program)[relative], manifest.arquivos[relative], `programa/3.1.0/${relative} igual ao pacote`);
    });
    assert.ok(fs.existsSync(path.join(program, 'release-manifest.json')));
    assert.equal(fs.readFileSync(path.join(root, 'programa', 'versao-atual.txt'), 'utf8'), '3.1.0');
    // Relativo à pasta da versão: a instalação movida inteira continua achando os dados.
    assert.deepEqual(readJson(path.join(program, 'iclass-pastas.json')), {
        dados: '../../dados',
        conteudo: '../../conteudo',
        cursosArquivados: '../../cursos-arquivados',
    });
    ['dados', 'conteudo', 'cursos-arquivados'].forEach(name => assert.ok(fs.statSync(path.join(root, name)).isDirectory(), name));
    const info = readJson(path.join(root, 'iclass-instalacao.json'));
    assert.equal(info.versaoAtual, '3.1.0');
    assert.equal(info.versaoAnterior, null);
    assert.deepEqual(info.versoes, ['3.1.0']);
    assert.equal(info.raiz, root);
    assert.equal(info.ligarComWindows, false);
    assert.equal(fs.readFileSync(path.join(root, 'IClass.cmd'), 'utf8'), fs.readFileSync(path.join(pkg, 'IClass.cmd'), 'utf8'), 'o IClass.cmd do pacote na raiz');
    assert.ok(fs.existsSync(path.join(root, 'desinstalar.ps1')));
    assert.equal(world.spawns.length, 0, '--sem-iniciar não liga');
    // O runtimePaths da versão instalada acha os dados pelo iclass-pastas.json.
    const runtimePaths = require('../../backend/runtimePaths.js');
    assert.equal(runtimePaths.resolveRuntimeFolders({ projectRoot: program, env: {} }).DATA_DIR, path.join(root, 'dados'));
    const moved = `${root}-movida`;
    fs.cpSync(root, moved, { recursive: true });
    assert.equal(runtimePaths.resolveRuntimeFolders({ projectRoot: path.join(moved, 'programa', '3.1.0'), env: {} }).DATA_DIR, path.join(moved, 'dados'));
    fs.rmSync(moved, { recursive: true, force: true });

    const before = treeHash(path.dirname(root));
    const again = await createWorld({ projectRoot: pkg }).launcher.instalar({ destino: root, semIniciar: true, sim: true });
    assert.equal(again.code, 0);
    assert.equal(again.kind, 'mesma');
    assert.equal(again.changed, false);
    assert.deepEqual(treeHash(path.dirname(root)), before, 'nada mudou na segunda instalação');
});

test('[UC-INSTALACAO-001] instalação nova liga a versão instalada (Node, supervisor e pastas dela) e abre o navegador só com ela pronta', async () => {
    const root = newRoot('liga-');
    const pkg = makePackage('3.1.0');
    const world = createWorld({ projectRoot: pkg });
    const result = await world.launcher.instalar({ destino: root, sim: true });
    assert.equal(result.code, 0, world.text());
    assert.equal(world.spawns.length, 1);
    const program = path.join(root, 'programa', '3.1.0');
    assert.equal(world.spawns[0].script, path.join(program, 'backend', 'supervisor.js'));
    assert.equal(world.spawns[0].nodePath, path.join(program, 'node', 'node'), 'o Node da versão instalada, não o do pacote baixado');
    assert.equal(world.spawns[0].cwd, program);
    assert.equal(world.spawns[0].env.ICLASS_DATA_DIR, path.join(root, 'dados'));
    assert.deepEqual(world.browser, [`http://localhost:${world.port}/`]);
});

test('[UC-INSTALACAO-001] atualizar guarda as duas últimas versões e nunca toca em dados, conteudo e cursos-arquivados', async () => {
    const root = newRoot('atualiza-');
    await install('3.1.0', root);
    // Dados de uma escola de verdade.
    const files = {
        'dados/database.db': 'banco',
        'dados/backups/pre-atualizacao_dados_x.zip': 'zip',
        'dados/entregas/asg_1/asub_1/trabalho.pdf': 'pdf',
        'conteudo/Apostila_1.md': '# editada',
        'cursos-arquivados/c1/curso.json': '{}',
    };
    Object.entries(files).forEach(([relative, content]) => {
        const file = path.join(root, ...relative.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    });
    const dataBefore = ['dados', 'conteudo', 'cursos-arquivados'].map(name => treeHash(path.join(root, name)));

    const second = await install('3.1.1', root);
    assert.equal(second.result.code, 0, second.world.text());
    assert.equal(second.result.kind, 'atualizacao');
    assert.match(second.world.text(), /IClass atualizado de 3\.1\.0 para 3\.1\.1/);
    let info = readJson(path.join(root, 'iclass-instalacao.json'));
    assert.equal(info.versaoAtual, '3.1.1');
    assert.equal(info.versaoAnterior, '3.1.0');
    assert.deepEqual(info.versoes, ['3.1.0', '3.1.1']);
    assert.ok(info.atualizadoEm);
    assert.equal(fs.readFileSync(path.join(root, 'programa', 'versao-atual.txt'), 'utf8'), '3.1.1');
    assert.ok(fs.existsSync(path.join(root, 'programa', '3.1.0', 'release-manifest.json')), 'a anterior fica guardada');

    const third = await install('3.2.0', root);
    assert.equal(third.result.code, 0, third.world.text());
    info = readJson(path.join(root, 'iclass-instalacao.json'));
    assert.deepEqual(info.versoes, ['3.1.1', '3.2.0']);
    assert.deepEqual(fs.readdirSync(path.join(root, 'programa')).sort(), ['3.1.1', '3.2.0', 'versao-atual.txt']);
    assert.deepEqual(third.result.removed, ['3.1.0']);
    assert.deepEqual(['dados', 'conteudo', 'cursos-arquivados'].map(name => treeHash(path.join(root, name))), dataBefore, 'os dados ficam iguais (SHA-256 de cada arquivo)');
    assert.equal(fs.readFileSync(path.join(root, 'IClass.cmd'), 'utf8'), fs.readFileSync(path.join(third.pkg, 'IClass.cmd'), 'utf8'), 'IClass.cmd da raiz trocado pelo da versão nova');
});

test('[UC-INSTALACAO-001] atualizar com o IClass ligado: desliga pela rota de controle antes de copiar e liga a versão nova; com prova em andamento recusa sem copiar nada', async () => {
    const root = newRoot('ligado-');
    await install('3.1.0', root);
    const dataDir = path.join(root, 'dados');

    // Prova em andamento: recusa, nada copiado nem desligado.
    const pkg = makePackage('3.1.1');
    const busy = createWorld({ projectRoot: pkg });
    runningServer(busy, dataDir, { status: statusBody({ provasEmAndamento: 1, provas: [{ titulo: 'Redes', turma: '2DES' }] }) });
    const refusedResult = await busy.launcher.instalar({ destino: root, sim: true });
    assert.equal(refusedResult.code, 1);
    assert.equal(refusedResult.refused, true);
    assert.match(busy.text(), /Há 1 prova em andamento \(Redes, 2DES\)\. Atualize depois que ela terminar\./);
    const busyTwo = createWorld({ projectRoot: pkg });
    runningServer(busyTwo, dataDir, { status: statusBody({ provasEmAndamento: 2, provas: [{ titulo: 'Redes', turma: '2DES' }, { titulo: 'Banco', turma: '1DES' }] }) });
    assert.equal((await busyTwo.launcher.instalar({ destino: root, sim: true })).refused, true);
    assert.match(busyTwo.text(), /Há 2 provas em andamento \(Redes, 2DES; Banco, 1DES\)\. Atualize depois que elas terminarem\./);
    assert.ok(!fs.existsSync(path.join(root, 'programa', '3.1.1')), 'nada copiado');
    assert.equal(busy.requests.filter(item => item.method === 'POST').length, 0, 'não desligou');
    assert.equal(readJson(path.join(root, 'iclass-instalacao.json')).versaoAtual, '3.1.0');

    // Sem prova: pergunta, desliga, copia e liga a nova (mesmo com --sem-iniciar, porque
    // estava ligado).
    const world = createWorld({ projectRoot: pkg, answers: ['s'] });
    runningServer(world, dataDir);
    const result = await world.launcher.instalar({ destino: root, semIniciar: true });
    assert.equal(result.code, 0, world.text());
    assert.match(world.asks[0], /Atualizar o IClass de 3\.1\.0 para 3\.1\.1\?/);
    const stopAt = world.requests.findIndex(item => item.method === 'POST' && item.pathname === '/api/system/control');
    assert.ok(stopAt >= 0, 'desligou pela rota de controle');
    assert.equal(world.kills.length, 0, 'sem taskkill');
    assert.equal(world.spawns.length, 1, 'ligou de novo');
    assert.equal(world.spawns[0].script, path.join(root, 'programa', '3.1.1', 'backend', 'supervisor.js'));
    assert.match(world.text(), /a versão nova faz um backup dos dados/);

    // Cancelado na pergunta: nada muda.
    const pkg2 = makePackage('3.1.2');
    const cancelled = createWorld({ projectRoot: pkg2, answers: ['n'] });
    runningServer(cancelled, dataDir);
    const cancelledResult = await cancelled.launcher.instalar({ destino: root });
    assert.equal(cancelledResult.code, 1);
    assert.ok(!fs.existsSync(path.join(root, 'programa', '3.1.2')));
});

test('[UC-INSTALACAO-001] recusas: pacote mais velho que o instalado, pacote alterado, pasta dentro do pacote e comando fora do pacote', async () => {
    const root = newRoot('recusas-');
    await install('3.2.0', root);
    const older = await install('3.1.0', root);
    assert.equal(older.result.code, 1);
    assert.match(older.world.text(), /A versão instalada em .* \(3\.2\.0\) é mais nova que este pacote \(3\.1\.0\)\. Nada foi feito\./);
    assert.ok(!fs.existsSync(path.join(root, 'programa', '3.1.0')));

    const tampered = makePackage('3.3.0');
    fs.appendFileSync(path.join(tampered, 'web', 'dist', 'index.html'), '<!-- mexido -->');
    fs.rmSync(path.join(tampered, 'backend', 'supervisor.js'));
    const world = createWorld({ projectRoot: tampered });
    const result = await world.launcher.instalar({ destino: root, sim: true, semIniciar: true });
    assert.equal(result.code, 2);
    assert.match(world.text(), /O pacote está incompleto ou foi alterado: backend\/supervisor\.js \(faltando\), web\/dist\/index\.html \(alterado\)\. Extraia o ZIP/);
    assert.ok(!fs.existsSync(path.join(root, 'programa', '3.3.0')));

    const pkg = makePackage('3.3.1');
    const inside = createWorld({ projectRoot: pkg });
    const insideResult = await inside.launcher.instalar({ destino: path.join(pkg, 'instalacao'), semIniciar: true, sim: true });
    assert.equal(insideResult.code, 1);
    assert.match(inside.text(), /não pode ficar dentro da pasta do pacote baixado/);

    const gitFolder = fs.mkdtempSync(path.join(tempRoot, 'git-'));
    const dev = createWorld({ projectRoot: gitFolder });
    const devResult = await dev.launcher.instalar({ destino: newRoot('dev-'), semIniciar: true, sim: true });
    assert.equal(devResult.code, 2);
    assert.match(dev.text(), /só funciona a partir da pasta do pacote do IClass \(falta o release-manifest\.json\)/);

    // atualizar sem instalação: recusa.
    const update = createWorld({ projectRoot: makePackage('3.4.0') });
    const updateResult = await update.launcher.atualizar({ destino: newRoot('sem-instalacao-'), sim: true });
    assert.equal(updateResult.code, 1);
    assert.match(update.text(), /Não há IClass instalado em/);
});

test('[UC-INSTALACAO-001] reinstalar depois de desinstalar mantendo os dados: os dados que já estavam continuam valendo', async () => {
    const root = newRoot('reinstala-');
    fs.mkdirSync(path.join(root, 'dados'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dados', 'database.db'), 'banco de antes');
    const { world, result } = await install('3.1.0', root);
    assert.equal(result.code, 0, world.text());
    assert.match(world.text(), /Os dados que já estavam em .*dados continuam valendo/);
    assert.equal(fs.readFileSync(path.join(root, 'dados', 'database.db'), 'utf8'), 'banco de antes');
});

// ---------------------------------------------------------------- trazer de uma pasta antiga

test('[UC-INSTALACAO-002] --trazer-de a pasta do git: copia data (com tls e backups, sem runtime, logs, quarentena e pastas de trabalho), content e cursos_arquivados; a pasta antiga fica igual', async () => {
    const oldRoot = await makeOldFolder();
    const before = treeHash(oldRoot);
    const root = newRoot('trazer-');
    const { world, result } = await install('3.1.0', root, { params: { trazerDe: oldRoot } });
    assert.equal(result.code, 0, world.text());
    assert.deepEqual(treeHash(oldRoot), before, 'a pasta antiga fica igual (SHA-256 de cada arquivo)');
    const copied = treeHash(path.join(root, 'dados'));
    ['database.db', 'tls/ca.key.pem', 'backups/automatico_dados_20261120-080000.zip', 'uploads/foto.png', 'entregas/asg_1/asub_1/trabalho.pdf'].forEach(relative => {
        assert.ok(copied[relative], `dados/${relative} copiado`);
    });
    assert.equal(copied['tls/ca.key.pem'], before['data/tls/ca.key.pem'], 'a mesma CA: os aparelhos não instalam o certificado de novo');
    Object.keys(copied).forEach(relative => {
        assert.doesNotMatch(relative, /^(runtime|logs|quarentena|\.restauracao|\.backup-trabalho)\//, `${relative} não devia vir`);
        assert.doesNotMatch(relative, /^entregas\/\.recebendo\//);
    });
    assert.ok(!copied['database.db-shm'], 'o -shm não vem');
    assert.equal(fs.readFileSync(path.join(root, 'conteudo', 'Apostila_FUTEC_1.md'), 'utf8'), '# Apostila editada pela escola');
    assert.ok(fs.existsSync(path.join(root, 'conteudo', 'imagens', 'figura.png')));
    assert.ok(fs.existsSync(path.join(root, 'cursos-arquivados', 'curso_velho', 'curso.json')));
    assert.match(world.text(), /Dados trazidos e conferidos: .*4 alunos no banco\. O banco abriu sem problemas\./);
    const info = readJson(path.join(root, 'iclass-instalacao.json'));
    assert.equal(info.trazidoDe.pasta, path.resolve(oldRoot));
    assert.ok(!fs.existsSync(path.join(root, '.iclass-trazendo')), 'sem sobra da pasta provisória');
});

test('[UC-INSTALACAO-002] --trazer-de recusa sem copiar: banco que não passa no quick_check, instalação com dados, pasta sem banco e restauração interrompida', async () => {
    // Banco danificado: nada copiado, nem o programa instalado.
    const broken = await makeOldFolder('estragado-');
    fs.writeFileSync(path.join(broken, 'data', 'database.db'), Buffer.alloc(8192, 7));
    const before = treeHash(broken);
    const root = newRoot('estragado-destino-');
    const { world, result } = await install('3.1.0', root, { params: { trazerDe: broken } });
    assert.equal(result.code, 1);
    assert.match(world.text(), /não passou na conferência .*Nada foi copiado/);
    assert.ok(!fs.existsSync(path.join(root, 'dados')) || fs.readdirSync(path.join(root, 'dados')).length === 0, 'nada em dados');
    assert.ok(!fs.existsSync(path.join(root, 'programa', '3.1.0')), 'o programa também não');
    assert.ok(!fs.existsSync(path.join(root, '.iclass-trazendo')));
    assert.deepEqual(treeHash(broken), before);

    // Já instalado com dados: recusa.
    const old = await makeOldFolder('ja-instalado-');
    const installed = newRoot('ja-instalado-destino-');
    await install('3.1.0', installed);
    fs.writeFileSync(path.join(installed, 'dados', 'database.db'), 'banco da instalação');
    const again = await install('3.1.1', installed, { params: { trazerDe: old } });
    assert.equal(again.result.code, 1);
    assert.match(again.world.text(), /os dados da pasta antiga só vêm numa instalação nova/);
    assert.equal(fs.readFileSync(path.join(installed, 'dados', 'database.db'), 'utf8'), 'banco da instalação');

    // Pasta sem o banco.
    const empty = fs.mkdtempSync(path.join(tempRoot, 'sem-banco-'));
    const noDb = await install('3.1.0', newRoot('sem-banco-destino-'), { params: { trazerDe: empty } });
    assert.equal(noDb.result.code, 1);
    assert.match(noDb.world.text(), /Não encontrei os dados do IClass em/);

    // Restauração interrompida na pasta antiga.
    const undo = await makeOldFolder('desfazer-');
    fs.mkdirSync(path.join(undo, 'data', '.restauracao', 'desfazer'), { recursive: true });
    fs.writeFileSync(path.join(undo, 'data', '.restauracao', 'desfazer', 'marcador.json'), JSON.stringify({ estado: 'aplicando' }));
    const undoResult = await install('3.1.0', newRoot('desfazer-destino-'), { params: { trazerDe: undo } });
    assert.equal(undoResult.result.code, 1);
    assert.match(undoResult.world.text(), /restauração de backup interrompida na pasta antiga/);

    // A pasta da instalação dentro da pasta antiga.
    const nested = await makeOldFolder('aninhada-');
    const nestedResult = await install('3.1.0', path.join(nested, 'IClass'), { params: { trazerDe: nested } });
    assert.equal(nestedResult.result.code, 1);
    assert.match(nestedResult.world.text(), /não podem ficar uma dentro da outra/);
});

test('[UC-INSTALACAO-002] --trazer-de com o IClass antigo ligado: desliga pela rota de controle (ou recusa com prova em andamento) antes de copiar', async () => {
    const oldRoot = await makeOldFolder('antigo-ligado-');
    const oldData = path.join(oldRoot, 'data');
    // Prova em andamento no antigo: recusa.
    const pkg = makePackage('3.1.0');
    const busy = createWorld({ projectRoot: pkg });
    runningServer(busy, oldData, { status: statusBody({ provasEmAndamento: 1, provas: [{ titulo: 'Banco de dados', turma: '1DES' }] }) });
    const root = newRoot('antigo-ligado-destino-');
    const refusedResult = await busy.launcher.instalar({ destino: root, trazerDe: oldRoot, sim: true, semIniciar: true });
    assert.equal(refusedResult.code, 1);
    assert.match(busy.text(), /Há 1 prova em andamento \(Banco de dados, 1DES\) no IClass de .*antigo-ligado.*\. Traga os dados depois que ela terminar\./);
    assert.ok(!fs.existsSync(path.join(root, 'dados', 'database.db')));

    // Sem prova: desliga pela rota e copia.
    const world = createWorld({ projectRoot: pkg });
    runningServer(world, oldData);
    const result = await world.launcher.instalar({ destino: root, trazerDe: oldRoot, sim: true, semIniciar: true });
    assert.equal(result.code, 0, world.text());
    assert.ok(world.requests.some(item => item.method === 'POST' && item.pathname === '/api/system/control'), 'desligou o antigo pela rota de controle');
    assert.ok(fs.existsSync(path.join(root, 'dados', 'database.db')));
    assert.match(world.text(), /use o ligarIclassV3\.bat daquela pasta/);
});

// Tabelas do jeito do database.js (key, value JSON): aplicações de prova e turmas.
function sqliteRun(file, statements, { keepOpen = false } = {}) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(file, err => {
            if (err) return reject(err);
            db.serialize(() => {
                statements.forEach(([sql, params]) => db.run(sql, params || []));
                db.run('SELECT 1', [], runErr => {
                    if (runErr) return reject(runErr);
                    if (keepOpen) return resolve(db);
                    return db.close(closeErr => (closeErr ? reject(closeErr) : resolve(null)));
                });
            });
            return undefined;
        });
    });
}

function examTables(applications = [], classes = []) {
    return [
        ['CREATE TABLE IF NOT EXISTS exam_applications (key TEXT PRIMARY KEY, value TEXT)'],
        ['CREATE TABLE IF NOT EXISTS classes (key TEXT PRIMARY KEY, value TEXT)'],
        ...applications.map(item => ['INSERT INTO exam_applications VALUES (?, ?)', [item.id, JSON.stringify(item)]]),
        ...classes.map(item => ['INSERT INTO classes VALUES (?, ?)', [`${item.courseId}::${item.name}`, JSON.stringify(item)]]),
    ];
}

// O 281029f (ligarIclassV3.bat) ligado nesta pasta: só o /api/health, sem a rota de situação.
function legacyServer(world, dataDir) {
    runningServer(world, dataDir, { status: null });
    world.handlers['GET /api/system/control/status'] = () => (world.alive.has(5001) ? { status: 404, body: { error: 'Não encontrado.' } } : refused());
    world.handlers['GET /api/health'] = () => (world.alive.has(5001) ? { status: 200, body: { status: 'ok', instanceId: 'atual' } } : refused());
}

test('[UC-INSTALACAO-002] provas em andamento lidas do banco (só leitura, com o servidor ligado em WAL): aplicações e prova ativa antiga da turma', async () => {
    const dir = fs.mkdtempSync(path.join(tempRoot, 'provas-banco-'));
    const file = path.join(dir, 'database.db');
    const writer = await sqliteRun(file, [
        ['PRAGMA journal_mode = WAL'],
        ...examTables([
            { id: 'app_1', status: 'running', title: 'Redes', studentClass: '2DES' },
            { id: 'app_2', status: 'paused', examKey: 'mod_bd', studentClass: '1DES' },
            { id: 'app_3', status: 'finished', title: 'Encerrada' },
            { id: 'app_4', status: 'prepared', title: 'Preparada' },
        ], [
            // Turma com a aplicação já no registro: conta uma vez só (pela aplicação).
            { courseId: 'FUTEC', name: '2DES', onlineExamConfigs: { redes: { applicationId: 'app_1', status: 'running', onlineActive: true } } },
            // Banco mais antigo: prova ativa só na turma, sem aplicação.
            { courseId: 'FECOP', name: '3INF', onlineExamConfigs: { mod_x: { onlineActive: true }, mod_y: { status: 'finished', onlineActive: false } } },
        ]),
    ], { keepOpen: true });
    try {
        const before = fs.readFileSync(file);
        const provas = await launcherInstall.readDataExams(file);
        assert.deepEqual(provas, [
            { titulo: 'Redes', turma: '2DES', situacao: 'running' },
            { titulo: 'mod_bd', turma: '1DES', situacao: 'paused' },
            { titulo: 'mod_x', turma: '3INF', situacao: 'running' },
        ]);
        assert.ok(before.equals(fs.readFileSync(file)), 'só leitura');
    } finally {
        await new Promise(resolve => writer.close(resolve));
    }
    // Banco sem as tabelas (bem antigo ou vazio): nenhuma prova.
    const empty = path.join(dir, 'vazio.db');
    await createSqlite(empty, 1);
    assert.deepEqual(await launcherInstall.readDataExams(empty), []);
    // Arquivo que não é banco: o erro sobe (quem chama trata como "não deu para conferir").
    fs.writeFileSync(path.join(dir, 'lixo.db'), 'isto não é um banco');
    await assert.rejects(launcherInstall.readDataExams(path.join(dir, 'lixo.db')));
});

// Rodada de ajuste 1: o 281029f não tem a rota de situação. O --trazer-de só avisava
// "Não deu para conferir se há prova em andamento" e desligava o IClass antigo no meio da
// prova (com --sim sem perguntar; sem --sim, Enter era sim).
test('[UC-INSTALACAO-002] --trazer-de com o IClass antigo (281029f) ligado no meio da prova: lê as provas do banco e recusa sem desligar nem copiar', async () => {
    const oldRoot = await makeOldFolder('antigo-281029f-prova-');
    const oldData = path.join(oldRoot, 'data');
    await sqliteRun(path.join(oldData, 'database.db'), examTables([
        { id: 'app_a', status: 'running', title: 'FECOP 2', studentClass: '2DES' },
        { id: 'app_b', status: 'running', title: 'FUTEC 4', studentClass: '1DES' },
    ]));
    const pkg = makePackage('3.1.0');
    for (const sim of [true, false]) {
        const world = createWorld({ projectRoot: pkg, answers: ['', '', ''] });
        legacyServer(world, oldData);
        const root = newRoot('antigo-281029f-destino-');
        const before = treeHash(oldRoot);
        const result = await world.launcher.instalar({ destino: root, trazerDe: oldRoot, sim, semIniciar: true });
        assert.equal(result.code, 1, world.text());
        assert.match(world.text(), /Há 2 provas em andamento \(FECOP 2, 2DES; FUTEC 4, 1DES\) no IClass de .*\. Traga os dados depois que elas terminarem\./);
        assert.match(world.text(), /Nada foi copiado de/);
        assert.equal(world.requests.filter(item => item.method === 'POST').length, 0, 'não desligou o antigo');
        assert.ok(world.alive.has(5001));
        assert.ok(!fs.existsSync(path.join(root, 'dados', 'database.db')));
        assert.deepEqual(treeHash(oldRoot), before, 'a pasta antiga fica igual');
    }

    // Sem prova no banco: desliga o antigo e copia (como com a rota de situação).
    await sqliteRun(path.join(oldData, 'database.db'), [["UPDATE exam_applications SET value = json_set(value, '$.status', 'finished')"]]);
    const world = createWorld({ projectRoot: pkg });
    legacyServer(world, oldData);
    const root = newRoot('antigo-281029f-livre-');
    const result = await world.launcher.instalar({ destino: root, trazerDe: oldRoot, sim: true, semIniciar: true });
    assert.equal(result.code, 0, world.text());
    assert.ok(world.requests.some(item => item.method === 'POST' && item.pathname === '/api/system/control'));
    assert.ok(fs.existsSync(path.join(root, 'dados', 'database.db')));
});

test('[UC-INSTALACAO-002] --trazer-de sem como conferir as provas do IClass antigo ligado: com --sim recusa; sem --sim pergunta e Enter é não', async () => {
    const oldRoot = await makeOldFolder('antigo-sem-conferir-');
    const oldData = path.join(oldRoot, 'data');
    const pkg = makePackage('3.1.0');
    const unreadable = async () => { throw new Error('banco travado'); };

    const withSim = createWorld({ projectRoot: pkg });
    withSim.options.readDataExams = unreadable;
    withSim.launcher = launcherCore.createLauncher(withSim.options);
    legacyServer(withSim, oldData);
    const rootSim = newRoot('sem-conferir-sim-');
    const simResult = await withSim.launcher.instalar({ destino: rootSim, trazerDe: oldRoot, sim: true, semIniciar: true });
    assert.equal(simResult.code, 1, withSim.text());
    assert.match(withSim.text(), /Não deu para conferir se há prova em andamento no IClass de .* \(o servidor é de uma versão anterior do IClass\)\. Desligar agora encerra a prova para os alunos\./);
    assert.match(withSim.text(), /Com --sim, o IClass não desliga um servidor sem conferir as provas/);
    assert.equal(withSim.requests.filter(item => item.method === 'POST').length, 0);
    assert.ok(!fs.existsSync(path.join(rootSim, 'dados', 'database.db')));

    // Interativo (o instalar.ps1 chama sem --sim): Enter não desliga.
    const enter = createWorld({ projectRoot: pkg, answers: [''] });
    enter.options.readDataExams = unreadable;
    enter.launcher = launcherCore.createLauncher(enter.options);
    legacyServer(enter, oldData);
    const rootEnter = newRoot('sem-conferir-enter-');
    const enterResult = await enter.launcher.instalar({ destino: rootEnter, trazerDe: oldRoot, semIniciar: true });
    assert.equal(enterResult.code, 1, enter.text());
    assert.match(enter.asks[0], /Só responda sim se não houver prova em andamento\. \(s\/N\)/);
    assert.equal(enter.requests.filter(item => item.method === 'POST').length, 0);
    assert.ok(!fs.existsSync(path.join(rootEnter, 'dados', 'database.db')));

    // "s" digitado: desliga e copia.
    const yes = createWorld({ projectRoot: pkg, answers: ['s'] });
    yes.options.readDataExams = unreadable;
    yes.launcher = launcherCore.createLauncher(yes.options);
    legacyServer(yes, oldData);
    const rootYes = newRoot('sem-conferir-s-');
    const yesResult = await yes.launcher.instalar({ destino: rootYes, trazerDe: oldRoot, semIniciar: true });
    assert.equal(yesResult.code, 0, yes.text());
    assert.ok(fs.existsSync(path.join(rootYes, 'dados', 'database.db')));
});

// ---------------------------------------------------------------- voltar de versão

async function updatedInstallation(prefix, { entry, backupFile = true } = {}) {
    const root = newRoot(prefix);
    await install('3.1.0', root);
    await install('3.1.1', root);
    const dataDir = path.join(root, 'dados');
    fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
    const name = 'pre-atualizacao_dados_20261123-090000.zip';
    if (backupFile) fs.writeFileSync(path.join(dataDir, 'backups', name), 'zip de antes');
    const updates = entry === null ? null : [{ de: '3.1.0', para: '3.1.1', em: Date.UTC(2026, 10, 23, 12), migracoes: ['2026-12-p9-teste'], backup: name, semBackup: false, ...(entry || {}) }];
    if (updates) fs.writeFileSync(path.join(dataDir, 'backups', 'atualizacoes.json'), JSON.stringify({ atualizacoes: updates }));
    return { root, dataDir, name };
}

test('[UC-VERSAO-002] voltar para a versão anterior: backup de agora, restaurar o pre-atualizacao com a backup-cli da anterior, trocar o ponteiro e ligar (nessa ordem)', async () => {
    const { root, dataDir, name } = await updatedInstallation('volta-');
    const world = installedWorld(root, '3.1.1', { answers: ['s'] });
    runningServer(world, dataDir);
    const order = [];
    world.handlers.run = params => {
        order.push(`${params.args[0]}:${path.basename(path.dirname(path.dirname(path.dirname(params.script))))}`);
        return 0;
    };
    const spawn = world.options.startSupervisor;
    world.options.startSupervisor = params => { order.push(`iniciar:${path.basename(params.cwd)}`); return spawn(params); };
    world.launcher = launcherCore.createLauncher(world.options);
    const originalRequest = world.options.request;
    world.options.request = async params => {
        if (params.method === 'POST') order.push('parar');
        return originalRequest(params);
    };
    world.launcher = launcherCore.createLauncher(world.options);

    const result = await world.launcher.voltarVersao();
    assert.equal(result.code, 0, world.text());
    assert.equal(result.mode, 'restaurar');
    assert.deepEqual(order, ['parar', 'criar:3.1.1', 'restaurar:3.1.0', 'iniciar:3.1.0']);
    const restore = world.runs.find(item => item.args[0] === 'restaurar');
    assert.deepEqual(restore.args, ['restaurar', path.join(dataDir, 'backups', name), '--sim']);
    assert.equal(restore.script, path.join(root, 'programa', '3.1.0', 'backend', 'scripts', 'backup-cli.js'));
    assert.equal(restore.nodePath, path.join(root, 'programa', '3.1.0', 'node', 'node'));
    assert.equal(restore.env.ICLASS_DATA_DIR, dataDir);
    assert.equal(fs.readFileSync(path.join(root, 'programa', 'versao-atual.txt'), 'utf8'), '3.1.0');
    const info = readJson(path.join(root, 'iclass-instalacao.json'));
    assert.equal(info.versaoAtual, '3.1.0');
    assert.equal(info.versaoAnterior, '3.1.1');
    assert.ok(info.voltouEm);
    assert.match(world.text(), /restaura o backup de antes da atualização \(pre-atualizacao_dados_20261123-090000\.zip/);
    assert.match(world.text(), /só no backup de agora/);
    assert.ok(fs.existsSync(path.join(root, 'programa', '3.1.1')), 'a versão nova fica guardada');
});

test('[UC-VERSAO-002] voltar recusa: sem versão anterior, com prova em andamento, sem o backup de antes, atualização feita sem backup; restauração que falha não troca nada', async () => {
    // Sem versão anterior.
    const single = newRoot('volta-sem-anterior-');
    await install('3.1.0', single);
    const lonely = installedWorld(single, '3.1.0');
    assert.equal((await lonely.launcher.voltarVersao({ sim: true })).code, 1);
    assert.match(lonely.text(), /Não há uma versão anterior guardada/);

    // Prova em andamento.
    const busyInstall = await updatedInstallation('volta-prova-');
    const busy = installedWorld(busyInstall.root, '3.1.1');
    runningServer(busy, busyInstall.dataDir, { status: statusBody({ provasEmAndamento: 1, provas: [{ titulo: 'Redes', turma: '2DES' }] }) });
    const busyResult = await busy.launcher.voltarVersao({ sim: true });
    assert.equal(busyResult.refused, true);
    assert.match(busy.text(), /Há 1 prova em andamento \(Redes, 2DES\)\. Volte de versão depois que ela terminar\./);
    assert.equal(busy.runs.length, 0);
    assert.equal(busy.requests.filter(item => item.method === 'POST').length, 0, 'não desligou');
    // Duas provas: o plural.
    const two = installedWorld(busyInstall.root, '3.1.1');
    runningServer(two, busyInstall.dataDir, { status: statusBody({ provasEmAndamento: 2, provas: [{ titulo: 'Redes', turma: '2DES' }, { titulo: 'Banco', turma: '1DES' }] }) });
    assert.equal((await two.launcher.voltarVersao({ sim: true })).refused, true);
    assert.match(two.text(), /Há 2 provas em andamento \(Redes, 2DES; Banco, 1DES\)\. Volte de versão depois que elas terminarem\./);

    // O backup de antes sumiu.
    const missing = await updatedInstallation('volta-sem-backup-', { backupFile: false });
    const noBackup = installedWorld(missing.root, '3.1.1');
    const noBackupResult = await noBackup.launcher.voltarVersao({ sim: true });
    assert.equal(noBackupResult.refused, true);
    assert.match(noBackup.text(), /O backup de antes da atualização \(pre-atualizacao_dados_20261123-090000\.zip\) não está mais em/);
    assert.equal(fs.readFileSync(path.join(missing.root, 'programa', 'versao-atual.txt'), 'utf8'), '3.1.1');

    // Atualização feita sem o backup (ICLASS_ATUALIZAR_SEM_BACKUP).
    const skipped = await updatedInstallation('volta-sem-backup-feito-', { entry: { backup: null, semBackup: true } });
    const skippedWorld = installedWorld(skipped.root, '3.1.1');
    assert.equal((await skippedWorld.launcher.voltarVersao({ sim: true })).refused, true);
    assert.match(skippedWorld.text(), /foi feita sem o backup de antes/);

    // A backup-cli da versão anterior falha: o ponteiro fica, e o IClass liga de novo na atual.
    const failing = await updatedInstallation('volta-falha-');
    const failWorld = installedWorld(failing.root, '3.1.1');
    runningServer(failWorld, failing.dataDir);
    failWorld.handlers.run = params => (params.args[0] === 'restaurar' ? 1 : 0);
    const failResult = await failWorld.launcher.voltarVersao({ sim: true });
    assert.equal(failResult.code, 1);
    assert.match(failWorld.text(), /A restauração não deu certo\. Nada foi trocado/);
    assert.equal(fs.readFileSync(path.join(failing.root, 'programa', 'versao-atual.txt'), 'utf8'), '3.1.1');
    assert.equal(readJson(path.join(failing.root, 'iclass-instalacao.json')).versaoAtual, '3.1.1');
    assert.equal(failWorld.spawns.at(-1).script, path.join(failing.root, 'programa', '3.1.1', 'backend', 'supervisor.js'), 'ligou de novo a atual');

    // O backup de agora falha: nada restaurado.
    const nowFails = await updatedInstallation('volta-backup-agora-');
    const nowWorld = installedWorld(nowFails.root, '3.1.1');
    nowWorld.handlers.run = params => (params.args[0] === 'criar' ? 1 : 0);
    assert.equal((await nowWorld.launcher.voltarVersao({ sim: true })).code, 1);
    assert.deepEqual(nowWorld.runs.map(item => item.args[0]), ['criar']);
    assert.equal(fs.readFileSync(path.join(nowFails.root, 'programa', 'versao-atual.txt'), 'utf8'), '3.1.1');
});

test('[UC-VERSAO-002] atualização que não mudou o formato dos dados (nenhuma migração) ou que nunca abriu os dados: volta sem restaurar, depois do backup de agora', async () => {
    const plain = await updatedInstallation('volta-ponteiro-', { entry: { migracoes: [], backup: null } });
    const world = installedWorld(plain.root, '3.1.1');
    const result = await world.launcher.voltarVersao({ sim: true });
    assert.equal(result.code, 0, world.text());
    assert.equal(result.mode, 'ponteiro');
    assert.deepEqual(world.runs.map(item => item.args[0]), ['criar']);
    assert.match(world.text(), /não mudou o formato dos dados/);
    assert.equal(fs.readFileSync(path.join(plain.root, 'programa', 'versao-atual.txt'), 'utf8'), '3.1.0');

    // Sem o atualizacoes.json: decide pelo banco parado (a versão nova nunca abriu os dados).
    const unknown = await updatedInstallation('volta-sem-registro-', { entry: null });
    const reads = [];
    const unknownWorld = installedWorld(unknown.root, '3.1.1');
    unknownWorld.options.readDataSchema = async file => { reads.push(file); return { aplicadas: [], atualizacoes: [], versaoApp: '3.1.0' }; };
    unknownWorld.launcher = launcherCore.createLauncher(unknownWorld.options);
    const unknownResult = await unknownWorld.launcher.voltarVersao({ sim: true });
    assert.equal(unknownResult.code, 0, unknownWorld.text());
    assert.equal(unknownResult.mode, 'ponteiro');
    assert.deepEqual(reads, [path.join(unknown.dataDir, 'database.db')]);

    // Banco de verdade sem schema_meta (dados da 281029f trazidos e nunca abertos pela 3.x):
    // nenhuma das duas versões abriu os dados, então só troca a versão.
    const fresh = await updatedInstallation('volta-banco-sem-esquema-', { entry: null });
    await createSqlite(path.join(fresh.dataDir, 'database.db'), 2);
    const freshWorld = installedWorld(fresh.root, '3.1.1');
    const freshResult = await freshWorld.launcher.voltarVersao({ sim: true });
    assert.equal(freshResult.code, 0, freshWorld.text());
    assert.equal(freshResult.mode, 'ponteiro');
    assert.match(freshWorld.text(), /a versão 3\.1\.1 ainda não abriu estes dados/);

    // Sem o atualizacoes.json, mas o banco diz que a 3.1.1 atualizou com migração: restaura.
    const fromDb = await updatedInstallation('volta-pelo-banco-', { entry: null });
    const dbWorld = installedWorld(fromDb.root, '3.1.1');
    dbWorld.options.readDataSchema = async () => ({ versaoApp: '3.1.1', atualizacoes: [{ de: '3.1.0', para: '3.1.1', em: 1, migracoes: ['2026-12-p9-teste'], backup: fromDb.name }] });
    dbWorld.launcher = launcherCore.createLauncher(dbWorld.options);
    const dbResult = await dbWorld.launcher.voltarVersao({ sim: true });
    assert.equal(dbResult.code, 0, dbWorld.text());
    assert.equal(dbResult.mode, 'restaurar');

    // Fora da instalação pelo pacote (pasta do git): não existe.
    const git = createWorld({ projectRoot: fs.mkdtempSync(path.join(tempRoot, 'git-volta-')) });
    assert.equal((await git.launcher.voltarVersao({ sim: true })).code, 1);
    assert.match(git.text(), /só existe na instalação pelo pacote/);
});

// Rodada de ajuste 1: depois de uma volta de versão, o histórico da atualização desfeita
// fica no schemaMeta e no atualizacoes.json. Atualizar de novo e voltar sem a versão nova
// ter aberto os dados (backup de antes que falhou, IClass não ligado) restaurava o backup
// da primeira atualização e jogava fora o que foi feito na versão anterior desde a volta.
test('[UC-VERSAO-002] voltar depois de uma volta anterior: não usa o registro da atualização já desfeita', async () => {
    const T1 = Date.UTC(2026, 10, 23, 12);
    const T2 = Date.UTC(2026, 10, 23, 13);
    const T3 = Date.UTC(2026, 10, 23, 14);
    const firstUpdate = { de: '3.1.0', para: '3.1.1', em: T1, migracoes: ['2026-12-p9-teste'], backup: 'pre-atualizacao_dados_20261123-090000.zip', semBackup: false };
    const setup = async (prefix, meta) => {
        const inst = await updatedInstallation(prefix);
        // A volta de versão de T2 e a nova atualização para a 3.1.1 (o instalar guarda o voltouEm).
        const infoFile = path.join(inst.root, 'iclass-instalacao.json');
        fs.writeFileSync(infoFile, JSON.stringify({ ...readJson(infoFile), voltouEm: new Date(T2).toISOString() }));
        const again = await install('3.1.1', inst.root);
        assert.equal(again.result.code, 0, again.world.text());
        assert.equal(readJson(infoFile).voltouEm, new Date(T2).toISOString(), 'atualizar de novo mantém o registro da volta');
        const world = installedWorld(inst.root, '3.1.1');
        world.options.readDataSchema = typeof meta === 'function' ? meta : async () => meta;
        world.launcher = launcherCore.createLauncher(world.options);
        return { ...inst, world };
    };

    // A 3.1.1 nunca abriu os dados depois da volta (o banco diz 3.1.0): só troca a versão.
    const never = await setup('volta-de-novo-nunca-', { versaoApp: '3.1.0', aplicadas: [], atualizacoes: [firstUpdate] });
    const neverResult = await never.world.launcher.voltarVersao({ sim: true });
    assert.equal(neverResult.code, 0, never.world.text());
    assert.equal(neverResult.mode, 'ponteiro');
    assert.deepEqual(never.world.runs.map(item => item.args[0]), ['criar'], 'nenhuma restauração');
    assert.match(never.world.text(), /a versão 3\.1\.1 ainda não abriu estes dados/);
    assert.doesNotMatch(never.world.text(), /pre-atualizacao_dados_20261123-090000/);
    assert.equal(fs.readFileSync(path.join(never.root, 'programa', 'versao-atual.txt'), 'utf8'), '3.1.0');

    // A 3.1.1 abriu os dados sem o backup de antes (o atualizacoes.json ficou para trás): recusa.
    const skipped = await setup('volta-de-novo-sem-backup-', { versaoApp: '3.1.1', atualizacoes: [firstUpdate, { de: '3.1.0', para: '3.1.1', em: T3, migracoes: ['2026-12-p9-teste'], backup: null, semBackup: true }] });
    assert.equal((await skipped.world.launcher.voltarVersao({ sim: true })).refused, true);
    assert.match(skipped.world.text(), /foi feita sem o backup de antes/);
    assert.equal(skipped.world.runs.length, 0);

    // A 3.1.1 abriu de novo com o backup novo: restaura esse, não o da primeira atualização.
    const fresh = await setup('volta-de-novo-certo-', { versaoApp: '3.1.1', atualizacoes: [firstUpdate, { de: '3.1.0', para: '3.1.1', em: T3, migracoes: ['2026-12-p9-teste'], backup: 'pre-atualizacao_dados_20261123-110000.zip' }] });
    fs.writeFileSync(path.join(fresh.dataDir, 'backups', 'pre-atualizacao_dados_20261123-110000.zip'), 'zip novo');
    const freshResult = await fresh.world.launcher.voltarVersao({ sim: true });
    assert.equal(freshResult.code, 0, fresh.world.text());
    assert.deepEqual(fresh.world.runs.find(item => item.args[0] === 'restaurar').args, ['restaurar', path.join(fresh.dataDir, 'backups', 'pre-atualizacao_dados_20261123-110000.zip'), '--sim']);

    // O banco diz 3.1.1, mas o único registro é de antes da volta: recusa (não adivinha).
    const stale = await setup('volta-de-novo-velho-', { versaoApp: '3.1.1', atualizacoes: [firstUpdate] });
    assert.equal((await stale.world.launcher.voltarVersao({ sim: true })).refused, true);
    assert.match(stale.world.text(), /Não encontrei o registro da atualização para a versão 3\.1\.1/);
    assert.equal(stale.world.runs.length, 0);

    // Banco ilegível: o atualizacoes.json só tem o registro de antes da volta; recusa.
    const unreadable = await setup('volta-de-novo-ilegivel-', async () => { throw new Error('ilegível'); });
    assert.equal((await unreadable.world.launcher.voltarVersao({ sim: true })).refused, true);
    assert.match(unreadable.world.text(), /Não deu para ler a versão dos dados/);
    assert.equal(unreadable.world.runs.length, 0);
    assert.equal(fs.readFileSync(path.join(unreadable.root, 'programa', 'versao-atual.txt'), 'utf8'), '3.1.1');
});

test('[UC-VERSAO-002] voltar com o IClass desligado mas uma prova em andamento no banco (janela fechada no meio da prova): recusa', async () => {
    const inst = await updatedInstallation('volta-prova-no-banco-');
    const world = installedWorld(inst.root, '3.1.1');
    const files = [];
    world.options.readDataExams = async file => { files.push(file); return [{ titulo: 'Redes', turma: '2DES', situacao: 'running' }]; };
    world.launcher = launcherCore.createLauncher(world.options);
    const result = await world.launcher.voltarVersao({ sim: true });
    assert.equal(result.refused, true, world.text());
    assert.deepEqual(files, [path.join(inst.dataDir, 'database.db')]);
    assert.match(world.text(), /Há 1 prova em andamento \(Redes, 2DES\)\. Volte de versão depois que ela terminar\./);
    assert.match(world.text(), /ele foi fechado no meio dela\)\. Ligue o IClass, encerre a prova pelo painel/);
    assert.equal(world.runs.length, 0);
    assert.equal(fs.readFileSync(path.join(inst.root, 'programa', 'versao-atual.txt'), 'utf8'), '3.1.1');

    // O servidor antigo da instalação sem a contagem na rota: as provas vêm do banco também.
    const legacyInst = await updatedInstallation('volta-prova-rota-sem-contagem-');
    fs.writeFileSync(path.join(legacyInst.dataDir, 'database.db'), 'banco');
    const legacyWorld = installedWorld(legacyInst.root, '3.1.1');
    legacyWorld.options.readDataExams = async () => [{ titulo: 'Banco', turma: '1DES', situacao: 'paused' }];
    legacyWorld.launcher = launcherCore.createLauncher(legacyWorld.options);
    runningServer(legacyWorld, legacyInst.dataDir, { status: statusBody({ provasEmAndamento: null, provas: [] }) });
    assert.equal((await legacyWorld.launcher.voltarVersao({ sim: true })).refused, true);
    assert.match(legacyWorld.text(), /Há 1 prova em andamento \(Banco, 1DES\)/);
    assert.equal(legacyWorld.requests.filter(item => item.method === 'POST').length, 0);
});

// ---------------------------------------------------------------- ligar com o Windows

test('[UC-INSTALACAO-001] ligar junto com o Windows: atalho na pasta Inicializar para "IClass.cmd iniciar --minimizado --sem-navegador", e desligar tira o atalho', async () => {
    const root = newRoot('inicializar-');
    await install('3.1.0', root);
    const appData = fs.mkdtempSync(path.join(tempRoot, 'appdata-'));
    const world = installedWorld(root, '3.1.0', { platform: 'win32', env: { APPDATA: appData } });
    assert.deepEqual(world.launcher.startupState(), { disponivel: true, ligado: false, file: path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'IClass.lnk'), root });
    const on = await world.launcher.ligarComWindows({ ligar: true });
    assert.equal(on.code, 0, world.text());
    assert.deepEqual(world.shortcuts.created[0], {
        file: path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'IClass.lnk'),
        target: path.join(root, 'IClass.cmd'),
        args: 'iniciar --minimizado --sem-navegador',
        workdir: root,
        description: 'Liga o IClass junto com o Windows',
    });
    assert.equal(readJson(path.join(root, 'iclass-instalacao.json')).ligarComWindows, true);
    assert.equal(world.launcher.startupState().ligado, true);
    const labels = launcherScript.menuItems(world.launcher).map(item => `[${item.key}] ${item.label}`);
    assert.ok(labels.includes('[9] Ligar junto com o Windows: Sim'), labels.join(' | '));
    const off = await world.launcher.ligarComWindows({ ligar: false });
    assert.equal(off.code, 0);
    assert.deepEqual(world.shortcuts.removed, [on.file]);
    assert.equal(readJson(path.join(root, 'iclass-instalacao.json')).ligarComWindows, false);

    // Fora do Windows: não existe.
    const linux = installedWorld(root, '3.1.0');
    assert.equal((await linux.launcher.ligarComWindows({ ligar: true })).code, 1);
    assert.match(linux.text(), /só existe no Windows/);
});

test('[UC-INSTALACAO-001] menu da instalação: [V] só com uma versão anterior guardada; na pasta do git, o menu de sempre', async () => {
    const root = newRoot('menu-');
    await install('3.1.0', root);
    const plain = launcherScript.menuItems(installedWorld(root, '3.1.0').launcher).map(item => item.key);
    assert.deepEqual(plain, ['1', '2', '3', '4', '5', '6', '7', '8', '0'], 'fora do Windows e sem versão anterior');
    await install('3.1.1', root);
    const labels = launcherScript.menuItems(installedWorld(root, '3.1.1').launcher).map(item => `[${item.key}] ${item.label}`);
    assert.deepEqual(labels.slice(-2), ['[V] Voltar para a versão anterior (3.1.0)', '[0] Sair']);
    const git = launcherScript.menuItems(createWorld({ projectRoot: fs.mkdtempSync(path.join(tempRoot, 'menu-git-')) }).launcher);
    assert.deepEqual(git, [...launcherScript.MENU]);
    const parsed = launcherScript.parseArgs(['instalar', '--destino', 'C:\\IClass', '--trazer-de', 'C:\\IClassV3', '--sem-iniciar', '--firewall', 'liberado']);
    assert.equal(parsed.command, 'instalar');
    assert.equal(parsed.destino, 'C:\\IClass');
    assert.equal(parsed.trazerDe, 'C:\\IClassV3');
    assert.equal(parsed.semIniciar, true);
    assert.equal(parsed.firewall, 'liberado');
    assert.throws(() => launcherScript.parseArgs(['instalar', '--trazer-de']), /pasta antiga/);
});

test('[UC-INSTALACAO-001] o firewall que o instalar.ps1 liberou fica no iclass-instalacao.json', async () => {
    const root = newRoot('firewall-');
    await install('3.1.0', root, { params: { firewall: 'liberado' } });
    const info = readJson(path.join(root, 'iclass-instalacao.json'));
    assert.equal(info.firewall.estado, 'liberado');
    assert.equal(info.firewall.porta, 4321);
    assert.equal(info.firewall.versao, '3.1.0');
});

// ---------------------------------------------------------------- o backup antes de atualizar falhou

test('[UC-INSTALACAO-001] a versão nova não consegue o backup antes de atualizar os dados: oferece atualizar sem ele só com a pessoa digitando SIM (o --sim não responde)', async () => {
    for (const answer of ['SIM', '']) {
        const root = newRoot(`sem-backup-${answer || 'nao'}-`);
        await install('3.1.0', root);
        const pkg = makePackage('3.1.1');
        const world = createWorld({ projectRoot: pkg, answers: [answer] });
        let attempts = 0;
        world.handlers.spawn = (params, child) => {
            attempts += 1;
            if (attempts === 1) {
                const log = path.join(params.env.ICLASS_DATA_DIR, 'logs', 'servidor.log');
                fs.mkdirSync(path.dirname(log), { recursive: true });
                fs.appendFileSync(log, '⛔ Não foi possível fazer o backup antes de atualizar os dados: sem espaço no disco. Nada foi alterado.\n');
                // O servidor sai com 2 logo na primeira conferência de saúde.
                world.handlers['GET /api/health'] = () => {
                    delete world.handlers['GET /api/health'];
                    child.emit('exit', 2, null);
                    return refused();
                };
                return;
            }
            const pid = 7000 + attempts;
            writeRuntime(params.env.ICLASS_DATA_DIR, 'servidor.json', { formato: 1, pid, porta: world.port, instanceId: `inst-${pid}` });
            writeRuntime(params.env.ICLASS_DATA_DIR, 'control.token', TOKEN);
            world.alive.add(pid);
            world.current = { pid, instanceId: `inst-${pid}` };
        };
        const result = await world.launcher.instalar({ destino: root, sim: true });
        if (answer === 'SIM') {
            assert.equal(result.code, 0, world.text());
            assert.equal(world.spawns.length, 2);
            assert.equal(world.spawns[0].env.ICLASS_ATUALIZAR_SEM_BACKUP, undefined);
            assert.equal(world.spawns[1].env.ICLASS_ATUALIZAR_SEM_BACKUP, '1');
        } else {
            assert.equal(result.code, 2);
            assert.equal(world.spawns.length, 1);
            assert.match(world.text(), /Nada foi alterado\. Libere espaço/);
        }
        assert.match(world.asks.at(-1), /Digite SIM para continuar/);
    }
});

// ---------------------------------------------------------------- desinstalar

test('[UC-INSTALACAO-001] desinstalar: desliga, tira o programa e o atalho do Inicializar e mantém os dados; só com APAGAR os dados saem', async () => {
    const root = newRoot('desinstala-');
    await install('3.1.0', root);
    await install('3.1.1', root);
    fs.writeFileSync(path.join(root, 'dados', 'database.db'), 'banco');
    fs.writeFileSync(path.join(root, 'conteudo', 'Apostila.md'), '# a');
    const world = installedWorld(root, '3.1.1', { answers: ['s', ''] });
    runningServer(world, path.join(root, 'dados'));
    const dataBefore = treeHash(path.join(root, 'dados'));
    const result = await world.launcher.desinstalar();
    assert.equal(result.code, 0, world.text());
    assert.ok(world.requests.some(item => item.method === 'POST' && item.pathname === '/api/system/control'), 'desligou');
    assert.ok(!fs.existsSync(path.join(root, 'programa')), 'programa apagado');
    assert.ok(!fs.existsSync(path.join(root, 'iclass-instalacao.json')));
    assert.ok(!fs.existsSync(path.join(root, 'IClass.cmd')));
    assert.deepEqual(treeHash(path.join(root, 'dados')), dataBefore, 'dados intactos');
    assert.ok(fs.existsSync(path.join(root, 'conteudo', 'Apostila.md')));
    assert.match(world.text(), /Os dados continuam em/);

    // Instala de novo na mesma pasta: os dados continuam.
    const again = await install('3.1.1', root);
    assert.equal(again.result.code, 0);
    assert.match(again.world.text(), /continuam valendo/);

    // Com APAGAR: as pastas de dados dentro da raiz saem.
    const world2 = installedWorld(root, '3.1.1', { answers: ['s', 'APAGAR'] });
    const result2 = await world2.launcher.desinstalar();
    assert.equal(result2.code, 0, world2.text());
    assert.equal(result2.apagouDados, true);
    ['dados', 'conteudo', 'cursos-arquivados'].forEach(name => assert.ok(!fs.existsSync(path.join(root, name)), `${name} apagada`));

    // Prova em andamento: recusa.
    const root3 = newRoot('desinstala-prova-');
    await install('3.1.0', root3);
    const busy = installedWorld(root3, '3.1.0');
    runningServer(busy, path.join(root3, 'dados'), { status: statusBody({ provasEmAndamento: 1, provas: [{ titulo: 'Redes', turma: '2DES' }] }) });
    assert.equal((await busy.launcher.desinstalar({ sim: true })).code, 1);
    assert.ok(fs.existsSync(path.join(root3, 'programa', '3.1.0')));

    // No Windows o atalho do Inicializar sai, e o programa fica para o desinstalar.ps1.
    const root4 = newRoot('desinstala-windows-');
    await install('3.1.0', root4);
    const appData = fs.mkdtempSync(path.join(tempRoot, 'appdata-des-'));
    const win = installedWorld(root4, '3.1.0', { platform: 'win32', env: { APPDATA: appData }, answers: ['s', ''] });
    await win.launcher.ligarComWindows({ ligar: true });
    const winResult = await win.launcher.desinstalar();
    assert.equal(winResult.code, 0, win.text());
    assert.equal(win.shortcuts.removed.length, 1, 'tirou o atalho do Inicializar');
    assert.ok(fs.existsSync(path.join(root4, 'programa', '3.1.0')), 'o node.exe em uso fica para o desinstalar.ps1');
});

// ---------------------------------------------------------------- scripts do Windows

// Os .ps1 do pacote: UTF-8 com BOM (o PowerShell 5.1 lê sem BOM como ANSI e estraga os
// acentos), sem taskkill /f nem netstat, e só fazendo o que é do Windows: a cópia e os
// dados ficam no launcher.js (que tem estes testes).
test('[UC-LAUNCHER-004] instalar.ps1 e desinstalar.ps1: UTF-8 com BOM, chamam o launcher.js e não apagam dados', () => {
    const folder = path.join(__dirname, '..', '..', 'scripts', 'release', 'modelos');
    for (const name of ['instalar.ps1', 'desinstalar.ps1']) {
        const bytes = fs.readFileSync(path.join(folder, name));
        assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${name} com BOM`);
        const text = bytes.subarray(3).toString('utf8');
        assert.doesNotMatch(text, /taskkill[^\r\n]*\/f\b/i);
        assert.doesNotMatch(text, /netstat/i);
        assert.doesNotMatch(text, /Remove-Item[^\r\n]*\b(dados|conteudo|cursos-arquivados)\b/i, `${name} não apaga pasta de dados`);
        assert.match(text, /launcher/);
    }
    const instalar = fs.readFileSync(path.join(folder, 'instalar.ps1'), 'utf8');
    assert.match(instalar, /'instalar', '--destino', \$raiz, '--sem-iniciar'/);
    assert.match(instalar, /Unblock-File/);
    assert.match(instalar, /-Profile Private,Domain/);
    assert.match(instalar, /-Verb RunAs/);
    assert.match(instalar, /ligar-com-windows/);
    assert.match(instalar, /HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\IClass/);
    const desinstalar = fs.readFileSync(path.join(folder, 'desinstalar.ps1'), 'utf8');
    assert.match(desinstalar, /& \$node \$launcher 'desinstalar'/);
    const cmd = fs.readFileSync(path.join(folder, 'Instalar IClass.cmd'), 'latin1');
    assert.match(cmd, /powershell\.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ICLASS_PACOTE%instalar\.ps1"/);
    assert.match(cmd, /backend\\scripts\\launcher\.js instalar/, 'mostra o passo manual quando a política não deixa o PowerShell rodar');
});

// ---------------------------------------------------------------- status: computador acordado

test('[UC-INSTALACAO-003] o status do launcher mostra quando o computador não vai dormir por causa da prova', async () => {
    const root = newRoot('status-acordado-');
    await install('3.1.0', root);
    const world = installedWorld(root, '3.1.0');
    runningServer(world, path.join(root, 'dados'), { status: statusBody({ provasEmAndamento: 1, provas: [{ titulo: 'Redes', turma: '2DES' }], computadorAcordado: true }) });
    await world.launcher.status();
    assert.match(world.text(), /O computador não vai dormir enquanto houver prova em andamento\./);
    world.lines.length = 0;
    await world.launcher.status({ json: true });
    assert.equal(JSON.parse(world.lines.at(-1)).computadorAcordado, true);

    const quiet = installedWorld(root, '3.1.0');
    runningServer(quiet, path.join(root, 'dados'));
    await quiet.launcher.status();
    assert.doesNotMatch(quiet.text(), /não vai dormir/);
});

test('[UC-INSTALACAO-001] o Ligar do menu e o iniciar também oferecem atualizar sem o backup (com SIM); ligado junto com o Windows (minimizado), não pergunta', async () => {
    for (const scenario of [{ answer: 'SIM', minimizado: false, spawns: 2 }, { answer: 'SIM', minimizado: true, spawns: 1 }]) {
        const root = newRoot(`oferta-iniciar-${scenario.minimizado ? 'min' : 'normal'}-`);
        await install('3.1.0', root);
        const world = installedWorld(root, '3.1.0', { answers: [scenario.answer] });
        let attempts = 0;
        world.handlers.spawn = (params, child) => {
            attempts += 1;
            if (attempts === 1) {
                const log = path.join(root, 'dados', 'logs', 'servidor.log');
                fs.mkdirSync(path.dirname(log), { recursive: true });
                fs.appendFileSync(log, '⛔ Não foi possível fazer o backup antes de atualizar os dados: sem espaço no disco. Nada foi alterado.\n');
                world.handlers['GET /api/health'] = () => {
                    delete world.handlers['GET /api/health'];
                    child.emit('exit', 2, null);
                    return refused();
                };
                return;
            }
            const pid = 7100 + attempts;
            writeRuntime(path.join(root, 'dados'), 'servidor.json', { formato: 1, pid, porta: world.port, instanceId: `inst-${pid}` });
            writeRuntime(path.join(root, 'dados'), 'control.token', TOKEN);
            world.alive.add(pid);
            world.current = { pid, instanceId: `inst-${pid}` };
        };
        const result = await world.launcher.iniciarOferecendo({ abrirNavegador: false, minimizado: scenario.minimizado });
        assert.equal(world.spawns.length, scenario.spawns, world.text());
        if (scenario.minimizado) {
            assert.equal(result.code, 2);
            assert.equal(world.asks.length, 0, 'minimizado não pergunta');
        } else {
            assert.equal(result.code, 0, world.text());
            assert.equal(world.spawns[1].env.ICLASS_ATUALIZAR_SEM_BACKUP, '1');
            assert.match(world.asks.at(-1), /Digite SIM para continuar/);
        }
    }
    // O menu [1] e o comando iniciar passam por aqui.
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'scripts', 'launcher.js'), 'utf8');
    assert.ok(source.includes("if (choice === '1') await launcher.iniciarOferecendo();"));
    assert.ok(source.includes("if (command === 'iniciar') result = await launcher.iniciarOferecendo("));
});
