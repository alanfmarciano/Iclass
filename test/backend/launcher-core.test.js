// Launcher em Node (fase 3, A16 / P6-S4; OPS-01, OPS-02, OPS-07, OPS-15; D11 do P6). Antes
// não existia: o ligarIclassV3.bat ligava o servidor sem o supervisor ("start cmd /c node
// backend/server.js"), esperava 3 s fixos e abria o navegador mesmo com o servidor fora do
// ar, e desligava com taskkill /f em todo processo que o netstat mostrasse na porta 3000,
// sem perguntar e sem deixar o servidor gravar. A primeira parte testa as ações com o
// processo, o HTTP, o navegador e o taskkill injetados (relógio de mentira, sem esperar de
// verdade); a segunda sobe o supervisor e o servidor de verdade pelo launcher.
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const launcherCore = require('../../backend/utils/launcherCore.js');
const launcherScript = require('../../backend/scripts/launcher.js');
const serverLifecycle = require('../../backend/utils/serverLifecycle.js');
const proc = require('./fixtures/server-process.js');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-launcher-'));
const TOKEN = 'ab'.repeat(32);
const spawnedSupervisors = new Set();

test.after(() => {
    // Supervisores de verdade abertos pelo launcher (processo separado): nenhum fica vivo.
    spawnedSupervisors.forEach(dataDir => {
        const pid = Number(String(fs.existsSync(path.join(dataDir, 'runtime', 'supervisor.pid')) ? fs.readFileSync(path.join(dataDir, 'runtime', 'supervisor.pid'), 'utf8') : '').trim());
        if (pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch (e) { /* já saiu */ } }
        const info = launcherCore.readServerInfo(dataDir);
        if (info) { try { process.kill(info.pid, 'SIGKILL'); } catch (e) { /* já saiu */ } }
    });
    proc.killAll();
});

// ---------------------------------------------------------------- mundo de mentira

function newFolders(prefix) {
    const root = fs.mkdtempSync(path.join(tempRoot, prefix));
    const folders = {
        DATA_DIR: path.join(root, 'dados'),
        CONTENT_DIR: path.join(root, 'conteudo'),
        ARCHIVE_DIR: path.join(root, 'cursos-arquivados'),
        origem: { DATA_DIR: 'arquivo', CONTENT_DIR: 'arquivo', ARCHIVE_DIR: 'arquivo' },
    };
    fs.mkdirSync(path.join(folders.DATA_DIR, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(folders.DATA_DIR, 'logs'), { recursive: true });
    return { root, folders, dataDir: folders.DATA_DIR };
}

function writeRuntime(dataDir, name, value) {
    fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'runtime', name), typeof value === 'string' ? value : JSON.stringify(value));
}

function appendLog(dataDir, text) {
    fs.appendFileSync(path.join(dataDir, 'logs', 'servidor.log'), `${text}\n`);
}

// Um computador de mentira: processos vivos (por pid), relógio que só anda no sleep e um
// servidor cujas respostas cada teste define em handlers.
function createWorld({ prefix = 'mundo-', port = 4321, answers = [] } = {}) {
    const { root, folders, dataDir } = newFolders(prefix);
    const world = {
        root,
        folders,
        dataDir,
        port,
        clock: 0,
        alive: new Set(),
        lines: [],
        requests: [],
        browser: [],
        kills: [],
        spawns: [],
        runs: [],
        asks: [],
        answers: answers.slice(),
        handlers: {},
    };
    world.launcher = launcherCore.createLauncher({
        projectRoot: root,
        folders,
        port,
        nodePath: '/caminho/do/node',
        supervisorScript: path.join(root, 'backend', 'supervisor.js'),
        version: '3.1.0',
        env: { PATH: process.env.PATH, ICLASS_SUPERVISED: '1', ICLASS_RESTARTED: '1' },
        platform: 'linux',
        startSupervisor: params => {
            world.spawns.push(params);
            const child = new EventEmitter();
            child.pid = 4241;
            world.child = child;
            if (world.handlers.spawn) world.handlers.spawn(params, child);
            return { child, tracksExit: world.tracksExit !== false };
        },
        request: async params => {
            world.requests.push({ ...params, at: world.clock });
            const key = `${params.method} ${params.pathname}`;
            const handler = world.handlers[key];
            if (!handler) throw Object.assign(new Error('recusada'), { code: 'ECONNREFUSED' });
            const result = await handler(params);
            if (result instanceof Error) throw result;
            return result;
        },
        openBrowser: url => { world.browser.push({ url, at: world.clock, ready: world.ready === true }); return true; },
        killTree: (pid, options) => {
            world.kills.push({ pid, force: options.force === true, at: world.clock });
            if (world.handlers.kill) world.handlers.kill(pid, options);
            return { ok: true };
        },
        run: async params => {
            world.runs.push(params);
            return world.handlers.run ? world.handlers.run(params) : 0;
        },
        isAlive: pid => world.alive.has(pid),
        isNodeProcess: pid => !(world.notNode && world.notNode.has(pid)),
        sleep: async ms => {
            world.clock += ms;
            if (world.handlers.tick) world.handlers.tick(world.clock);
        },
        now: () => world.clock,
        out: line => world.lines.push(line),
        ask: async question => {
            world.asks.push(question);
            return world.answers.length ? world.answers.shift() : '';
        },
        timeouts: { pollMs: 500 },
    });
    world.text = () => world.lines.join('\n');
    return world;
}

const refused = () => Object.assign(new Error('recusada'), { code: 'ECONNREFUSED' });

function serverStatus(extra = {}) {
    return { status: 200, body: { success: true, versao: '3.1.0', instanceId: 'atual', pid: 5001, porta: 4321, fase: 'ready', pronto: true, supervisionado: true, provasEmAndamento: 0, provas: [], alunosConectados: 3, enderecoAlunos: 'http://192.168.0.10:4321', ...extra } };
}

// Um servidor no ar: servidor.json, token e supervisor.pid de processos vivos.
function runningServer(world, { pid = 5001, supervisorPid = 5000, status = serverStatus() } = {}) {
    writeRuntime(world.dataDir, 'servidor.json', { formato: 1, pid, porta: world.port, instanceId: 'atual', versao: '3.1.0' });
    writeRuntime(world.dataDir, 'control.token', TOKEN);
    writeRuntime(world.dataDir, 'supervisor.pid', String(supervisorPid));
    world.alive.add(pid);
    world.alive.add(supervisorPid);
    world.handlers['GET /api/system/control/status'] = () => status;
    world.handlers['GET /api/health'] = () => (world.alive.has(pid) ? { status: 200, body: { status: 'ok', instanceId: 'atual' } } : refused());
    return { pid, supervisorPid };
}

// ---------------------------------------------------------------- contrato com o servidor

test('[UC-LAUNCHER-001] o launcher conhece todas as fases do boot do servidor, as de atualização e os códigos de saída', () => {
    Object.keys(serverLifecycle.BOOT_PHASES).forEach(phase => {
        assert.ok(launcherCore.BOOT_PHASE_TEXT[phase], `texto da fase ${phase} no launcherCore.BOOT_PHASE_TEXT (contrato C11)`);
    });
    assert.deepEqual([...launcherCore.UPDATE_PHASES], [...serverLifecycle.UPDATE_BOOT_PHASES]);
    assert.equal(launcherCore.DEFAULT_TIMEOUTS.bootMs, 90 * 1000);
    assert.equal(launcherCore.DEFAULT_TIMEOUTS.updateMs, 10 * 60 * 1000);
    assert.equal(launcherCore.DEFAULT_TIMEOUTS.stopMs, 15 * 1000);
    ['OK', 'ERROR', 'CONFIG', 'DB_CORRUPT'].forEach(name => assert.equal(launcherCore.EXIT[name], serverLifecycle.EXIT_CODES[name], name));
    assert.equal(launcherCore.DEMO_PORT, 3100);
    // O runtime/servidor.json que o servidor grava é o que o launcher lê.
    const { dataDir } = newFolders('servidor-json-');
    const file = path.join(dataDir, 'runtime', 'servidor.json');
    fs.writeFileSync(file, JSON.stringify({ formato: 1, pid: 77, porta: 3000, instanceId: 'x' }));
    assert.deepEqual(launcherCore.readServerInfo(dataDir), serverLifecycle.readServerInfo(file));
    fs.writeFileSync(file, JSON.stringify({ pid: 77, porta: 'abc' }));
    assert.equal(launcherCore.readServerInfo(dataDir), null);
    assert.equal(serverLifecycle.readServerInfo(file), null);
});

// ---------------------------------------------------------------- iniciar

test('[UC-LAUNCHER-001] iniciar sobe o supervisor, mostra as fases (até 10 min nas de atualização) e só abre o navegador com o 200', async () => {
    const world = createWorld({ prefix: 'iniciar-' });
    const phases = [];
    let healthCalls = 0;
    world.handlers.spawn = () => {
        writeRuntime(world.dataDir, 'servidor.json', { formato: 1, pid: 4242, porta: world.port, instanceId: 'novo' });
        writeRuntime(world.dataDir, 'control.token', TOKEN);
        world.alive.add(4242);
    };
    world.handlers['GET /api/health'] = () => {
        healthCalls += 1;
        if (healthCalls === 1) return refused();
        // Backup antes de atualizar e migração por 5 min (mais que os 90 s das fases comuns).
        const phase = world.clock < 2000 ? 'loading' : world.clock < 60000 ? 'backup-atualizacao' : world.clock < 5 * 60000 ? 'migrando' : null;
        if (phase) {
            phases.push(phase);
            return { status: 503, body: { status: 'starting', phase, instanceId: 'novo' } };
        }
        world.ready = true;
        return { status: 200, body: { status: 'ok', instanceId: 'novo' } };
    };
    world.handlers['GET /api/system/control/status'] = () => serverStatus({ instanceId: 'novo' });
    const result = await world.launcher.iniciar();
    assert.equal(result.code, 0, world.text());
    assert.equal(world.spawns.length, 1);
    const spawn = world.spawns[0];
    assert.equal(spawn.nodePath, '/caminho/do/node');
    assert.equal(spawn.script, path.join(world.root, 'backend', 'supervisor.js'));
    assert.equal(spawn.env.PORT, String(world.port));
    assert.equal(spawn.env.ICLASS_DATA_DIR, world.dataDir);
    assert.match(spawn.env.ICLASS_JANELA_TITULO, /Servidor do IClass/);
    assert.equal(spawn.env.ICLASS_SUPERVISED, undefined, 'variáveis do supervisor não passam adiante');
    assert.equal(spawn.env.ICLASS_RESTARTED, undefined);
    assert.ok(phases.includes('migrando') && world.clock > 4 * 60000, 'esperou a migração passar dos 90 s');
    ['Lendo o banco de dados...', 'Fazendo o backup antes de atualizar os dados...', 'Atualizando os dados para esta versão...'].forEach(text => {
        assert.ok(world.lines.includes(text), `mostra "${text}"`);
    });
    assert.equal(world.lines.filter(line => line === 'Atualizando os dados para esta versão...').length, 1, 'cada fase aparece uma vez');
    assert.deepEqual(world.browser.map(item => item.url), [`http://localhost:${world.port}/`]);
    assert.equal(world.browser[0].ready, true, 'o navegador abriu depois do 200');
    assert.match(world.text(), /Endereço para os alunos: http:\/\/192\.168\.0\.10:4321/);

    // Já ligado: não sobe outro supervisor.
    const again = await world.launcher.iniciar({ abrirNavegador: false });
    assert.equal(again.code, 0);
    assert.equal(again.already, true);
    assert.equal(world.spawns.length, 1);
});

test('[UC-LAUNCHER-001] fase comum passando de 90 s: desiste da espera, mostra o fim do servidor.log (só o desta vez) e não abre o navegador', async () => {
    const world = createWorld({ prefix: 'timeout-' });
    appendLog(world.dataDir, '[ontem] linha de uma execução anterior');
    world.handlers.spawn = () => {
        writeRuntime(world.dataDir, 'servidor.json', { formato: 1, pid: 4242, porta: world.port, instanceId: 'novo' });
        world.alive.add(4242);
        appendLog(world.dataDir, '[hoje] Carregando os dados do IClass (porta 4321 já respondendo "iniciando")...');
    };
    world.handlers['GET /api/health'] = () => ({ status: 503, body: { status: 'starting', phase: 'loading', instanceId: 'novo' } });
    const result = await world.launcher.iniciar();
    assert.equal(result.code, 1);
    assert.equal(result.timeout, true);
    assert.ok(world.clock >= 90000 && world.clock < 95000, `desistiu nos 90 s (${world.clock})`);
    assert.match(world.text(), /não respondeu em 90 s/);
    assert.match(world.text(), /\[hoje\] Carregando os dados/);
    assert.doesNotMatch(world.text(), /linha de uma execução anterior/);
    assert.match(world.text(), /A janela do servidor continua aberta/);
    assert.deepEqual(world.browser, []);
    assert.deepEqual(world.kills, [], 'não derruba o servidor que ainda está carregando');
});

test('[UC-LAUNCHER-001] servidor sai com 2 (porta ocupada) ou 3 (banco danificado): mensagem do servidor, o próximo passo e o mesmo código', async () => {
    for (const scenario of [
        { code: 2, log: '⛔ A porta 4321 já está em uso por outro programa (talvez outra janela do IClass ou o modo demonstração). Feche-o e abra de novo.', next: /Outro programa \(ou outra janela do IClass\) está usando a porta/ },
        { code: 3, log: '⛔ O banco de dados está danificado (SQLITE_CORRUPT). Restaure um backup: node backend/scripts/backup-cli.js restaurar --ultimo', next: /opção \[5\] \(Restaurar um backup\)/ },
        { code: 1, log: '⛔ O servidor não conseguiu iniciar 5 vezes seguidas.', next: /O servidor não conseguiu ligar/ },
    ]) {
        const world = createWorld({ prefix: `saida-${scenario.code}-` });
        let calls = 0;
        world.handlers['GET /api/health'] = () => {
            calls += 1;
            if (calls === 2) {
                appendLog(world.dataDir, scenario.log);
                world.child.emit('exit', scenario.code, null);
            }
            return refused();
        };
        const result = await world.launcher.iniciar();
        assert.equal(result.code, scenario.code, world.text());
        assert.ok(world.text().includes(scenario.log), 'mostra a mensagem do servidor');
        assert.match(world.text(), scenario.next);
        assert.match(world.text(), new RegExp(`não ligou \\(código ${scenario.code}\\)`));
        assert.deepEqual(world.browser, []);
    }
});

test('[UC-LAUNCHER-001] no Windows (janela aberta pelo start do cmd): acompanha o supervisor.pid e lê o código do supervisor-saida.json; supervisor.pid velho não engana', async () => {
    const world = createWorld({ prefix: 'windows-' });
    world.tracksExit = false;
    // Sobra de um supervisor que morreu sem apagar o arquivo (processo 9 não existe mais).
    writeRuntime(world.dataDir, 'supervisor.pid', '9');
    writeRuntime(world.dataDir, 'supervisor-saida.json', { pid: 9, codigo: 3 });
    world.handlers.spawn = () => {
        assert.equal(fs.existsSync(path.join(world.dataDir, 'runtime', 'supervisor.pid')), false, 'o supervisor.pid velho saiu antes de ligar');
        assert.equal(fs.existsSync(path.join(world.dataDir, 'runtime', 'supervisor-saida.json')), false, 'a saída velha também');
    };
    let calls = 0;
    world.handlers['GET /api/health'] = () => {
        calls += 1;
        if (calls === 2) {
            writeRuntime(world.dataDir, 'supervisor.pid', '6000');
            world.alive.add(6000);
        }
        if (calls === 4) {
            world.alive.delete(6000);
            writeRuntime(world.dataDir, 'supervisor-saida.json', { pid: 6000, codigo: 2 });
            appendLog(world.dataDir, '⛔ A porta 4321 já está em uso por outro programa.');
        }
        return refused();
    };
    const result = await world.launcher.iniciar();
    assert.equal(result.code, 2, world.text());
    assert.match(world.text(), /já está em uso/);
});

test('[UC-LAUNCHER-001] no Windows: supervisor que sai antes de a espera ver o supervisor.pid dele também dá o código e a mensagem (sem esperar os 90 s)', async () => {
    // Antes: a espera só lia o supervisor-saida.json depois de ter visto o supervisor.pid
    // vivo; o supervisor que saía logo (porta ocupada) fazia o launcher esperar 90 s, sair
    // com 1 e dizer que a janela do servidor continuava aberta.
    const world = createWorld({ prefix: 'windows-cedo-' });
    world.tracksExit = false;
    world.handlers.spawn = () => {
        // O supervisor gravou, saiu e apagou o supervisor.pid antes da primeira leitura.
        writeRuntime(world.dataDir, 'supervisor-saida.json', { pid: 6100, codigo: 2 });
        appendLog(world.dataDir, '⛔ A porta 4321 já está em uso por outro programa.');
    };
    world.handlers['GET /api/health'] = () => refused();
    const result = await world.launcher.iniciar();
    assert.equal(result.code, 2, world.text());
    assert.equal(result.timeout, undefined);
    assert.ok(world.clock < 5000, `desistiu logo (${world.clock} ms)`);
    assert.match(world.text(), /já está em uso/);
    assert.doesNotMatch(world.text(), /continua aberta/);
});

test('[UC-LAUNCHER-001] outro IClass responde 200 na mesma porta enquanto o nosso sai com 2: não conta como ligado', async () => {
    const world = createWorld({ prefix: 'outro-iclass-' });
    let calls = 0;
    world.handlers['GET /api/health'] = () => {
        calls += 1;
        if (calls === 3) {
            appendLog(world.dataDir, '⛔ A porta 4321 já está em uso por outro programa.');
            world.child.emit('exit', 2, null);
        }
        return { status: 200, body: { status: 'ok', instanceId: 'de-outra-pasta' } };
    };
    const result = await world.launcher.iniciar();
    assert.equal(result.code, 2, world.text());
    assert.deepEqual(world.browser, []);
});

// ---------------------------------------------------------------- parar

test('[UC-LAUNCHER-002] parar pela rota de controle com o token: 202, espera o processo sair, sem taskkill e sem netstat', async () => {
    const world = createWorld({ prefix: 'parar-' });
    const { pid, supervisorPid } = runningServer(world);
    world.handlers['POST /api/system/control'] = params => {
        assert.equal(params.headers['x-iclass-control'], TOKEN);
        assert.deepEqual(params.body, { action: 'stop' });
        setImmediate(() => {});
        world.stopAt = world.clock + 1500;
        return { status: 202, body: { success: true } };
    };
    world.handlers.tick = clock => {
        if (world.stopAt && clock >= world.stopAt) {
            world.alive.delete(pid);
            world.alive.delete(supervisorPid);
        }
    };
    const result = await world.launcher.parar();
    assert.equal(result.code, 0, world.text());
    assert.deepEqual(world.kills, []);
    assert.deepEqual(world.asks, [], 'sem prova em andamento, não pergunta');
    assert.equal(world.requests.filter(item => item.method === 'POST' && item.pathname === '/api/system/control').length, 1);
    assert.match(world.text(), /IClass desligado\./);
});

test('[UC-LAUNCHER-002] sem resposta em 15 s: taskkill /T sem /f na árvore do supervisor; só pergunta pelo encerramento forçado depois, e só força com "sim"', async () => {
    for (const answer of ['n', 's']) {
        const world = createWorld({ prefix: `forcar-${answer}-`, answers: [answer] });
        const { pid, supervisorPid } = runningServer(world);
        world.handlers['POST /api/system/control'] = () => ({ status: 202, body: { success: true } });
        world.handlers.kill = (target, options) => {
            if (options.force) {
                world.alive.delete(pid);
                world.alive.delete(supervisorPid);
            }
        };
        const result = await world.launcher.parar();
        assert.equal(world.kills[0].pid, supervisorPid, 'a árvore do supervisor');
        assert.equal(world.kills[0].force, false, 'primeiro sem /f');
        assert.ok(world.kills[0].at >= 15000, `só depois dos 15 s (${world.kills[0].at})`);
        assert.equal(world.asks.length, 1);
        assert.match(world.asks[0], /Forçar o encerramento\?/);
        assert.ok(world.clock >= 30000, 'esperou também depois do taskkill sem /f');
        if (answer === 'n') {
            assert.equal(result.code, 1);
            assert.equal(world.kills.length, 1, 'sem /f quando a resposta é não');
            assert.match(world.text(), /O servidor continua ligado/);
        } else {
            assert.equal(result.code, 0);
            assert.equal(result.forced, true);
            assert.deepEqual(world.kills.map(item => item.force), [false, true]);
        }
    }
    // --sim (scripts) nunca força.
    const world = createWorld({ prefix: 'forcar-sim-', answers: ['s'] });
    runningServer(world);
    world.handlers['POST /api/system/control'] = () => ({ status: 202, body: { success: true } });
    const result = await world.launcher.parar({ sim: true });
    assert.equal(result.code, 1);
    assert.deepEqual(world.kills.map(item => item.force), [false]);
    assert.deepEqual(world.asks, []);
});

test('[UC-LAUNCHER-002] pid que sobrou de antes e hoje é de outro programa: conta como desligado, nenhum taskkill, e o iniciar sobe um novo', async () => {
    const world = createWorld({ prefix: 'pid-reusado-', answers: ['s'] });
    const { pid, supervisorPid } = runningServer(world);
    // Falta de energia: os números do servidor.json e do supervisor.pid foram dados a outros
    // programas, e a porta não responde.
    world.notNode = new Set([pid, supervisorPid]);
    delete world.handlers['GET /api/system/control/status'];
    delete world.handlers['GET /api/health'];
    world.handlers['POST /api/system/control'] = () => { throw new Error('não devia chamar a rota de controle'); };
    const stopped = await world.launcher.parar();
    assert.equal(stopped.code, 0);
    assert.equal(stopped.already, true);
    assert.deepEqual(world.kills, [], 'nem o taskkill sem /f');
    assert.deepEqual(world.asks, []);
    assert.match(world.text(), /já está desligado/);
    // Se o número for dado a outro programa entre a leitura e o taskkill, também não fecha.
    const late = createWorld({ prefix: 'pid-reusado-tarde-', answers: ['s'] });
    const lateServer = runningServer(late);
    late.handlers['POST /api/system/control'] = () => ({ status: 202, body: { success: true } });
    late.handlers.tick = () => { if (late.clock > 1000) late.notNode = new Set([lateServer.supervisorPid]); };
    const result = await late.launcher.parar();
    assert.equal(result.code, 1);
    assert.deepEqual(late.kills, []);
    assert.match(late.text(), new RegExp(`O processo ${lateServer.supervisorPid} não é mais o IClass`));
});

test('[UC-LAUNCHER-002] processIsNode no Linux: o próprio Node sim, outro programa não', { skip: process.platform !== 'linux' }, async () => {
    const { spawn } = require('node:child_process');
    assert.equal(launcherCore.processIsNode(process.pid), true);
    const other = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
        await new Promise(resolve => other.once('spawn', resolve));
        assert.equal(launcherCore.processIsNode(other.pid), false);
    } finally {
        other.kill();
    }
    assert.equal(launcherCore.processIsNode(0), false);
});

test('[UC-LAUNCHER-002] processIsNode no Linux: Node que trocou o process.title (título da janela do supervisor) continua sendo Node', { skip: process.platform !== 'linux' }, async () => {
    // Antes: o supervisor trocava o process.title também no Linux, o /proc/<pid>/cmdline
    // virava "Servidor do IClass (não feche esta janela)" e o launcher achava que o
    // supervisor vivo era outro programa: "desligado" na janela de religar depois de uma
    // queda, e o iniciar subia um segundo supervisor na mesma pasta de dados.
    const titled = childProcess.spawn(process.execPath, ['-e', 'process.title = "Servidor do IClass (não feche esta janela)"; setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    try {
        await new Promise(resolve => titled.once('spawn', resolve));
        await proc.waitFor(() => fs.readFileSync(`/proc/${titled.pid}/cmdline`, 'utf8').startsWith('Servidor do IClass'), { what: 'o título trocar' });
        assert.equal(launcherCore.processIsNode(titled.pid, { platform: 'linux' }), true);
    } finally {
        titled.kill();
    }
});

test('[UC-LAUNCHER-002] token e servidor.json de um processo que já terminou são ignorados: "já está desligado" e o iniciar sobe um novo', async () => {
    const world = createWorld({ prefix: 'token-velho-' });
    writeRuntime(world.dataDir, 'servidor.json', { formato: 1, pid: 31337, porta: world.port, instanceId: 'velho' });
    writeRuntime(world.dataDir, 'control.token', TOKEN);
    world.handlers['POST /api/system/control'] = () => { throw new Error('não devia chamar a rota de controle'); };
    const stopped = await world.launcher.parar();
    assert.equal(stopped.code, 0);
    assert.equal(stopped.already, true);
    assert.match(world.text(), /já está desligado/);
    assert.deepEqual(world.kills, []);
    assert.equal(world.requests.length, 0, 'nem pergunta à porta: o processo do arquivo não existe');
    const state = await world.launcher.locate();
    assert.equal(state.state, 'desligado');
    assert.equal(state.stale, true);

    world.handlers.spawn = () => {
        assert.equal(fs.existsSync(path.join(world.dataDir, 'runtime', 'servidor.json')), false, 'o servidor.json velho saiu');
        writeRuntime(world.dataDir, 'servidor.json', { formato: 1, pid: 4242, porta: world.port, instanceId: 'novo' });
        world.alive.add(4242);
    };
    world.handlers['GET /api/health'] = () => ({ status: 200, body: { status: 'ok', instanceId: 'novo' } });
    const started = await world.launcher.iniciar({ abrirNavegador: false });
    assert.equal(started.code, 0, world.text());
    assert.equal(world.spawns.length, 1);
});

test('[UC-LAUNCHER-002] prova em andamento: desligar e reiniciar perguntam dizendo qual prova; backup, restaurar e senha recusam', async () => {
    const withExam = serverStatus({ provasEmAndamento: 1, provas: [{ titulo: 'Redes', turma: '2DES', cursoId: 'c1', situacao: 'running' }] });
    const world = createWorld({ prefix: 'prova-', answers: ['n', 'n'] });
    runningServer(world, { status: withExam });
    world.handlers['POST /api/system/control'] = () => { throw new Error('não devia desligar'); };
    const stop = await world.launcher.parar();
    assert.equal(stop.code, 1);
    assert.equal(stop.cancelled, true);
    assert.match(world.text(), /Há 1 prova em andamento \(Redes, 2DES\)\./);
    assert.equal(launcherCore.examsSentence([{ titulo: 'Redes', turma: '2DES' }, { titulo: 'Banco de dados', turma: '1DES' }]), 'Há 2 provas em andamento (Redes, 2DES; Banco de dados, 1DES).');
    assert.match(world.asks[0], /Desligar mesmo assim\?/);
    const restart = await world.launcher.reiniciar();
    assert.equal(restart.cancelled, true);
    assert.match(world.asks[1], /Reiniciar mesmo assim\?/);
    for (const action of ['backup', 'restaurar', 'senha']) {
        const result = await world.launcher[action]({ sim: true, ultimo: true });
        assert.equal(result.code, 1, action);
        assert.equal(result.refused, true, action);
    }
    assert.deepEqual(world.runs, [], 'nenhum script rodou');
    assert.deepEqual(world.kills, []);
    assert.match(world.text(), /Fazer backup agora/);
});

test('[UC-LAUNCHER-002] sem como conferir as provas (servidor de versão anterior ou leitura das provas falhou): avisa antes de desligar, reiniciar, fazer backup, restaurar e redefinir a senha', async () => {
    // Antes: com servidor de uma versão anterior (sem a rota de situação) ou com a rota
    // respondendo provasEmAndamento null, o launcher desligava sem dizer nada das provas.
    const legacy = createWorld({ prefix: 'sem-provas-antigo-', answers: ['n', 'n'] });
    runningServer(legacy);
    legacy.handlers['GET /api/system/control/status'] = () => ({ status: 404, body: { error: 'Não encontrado.' } });
    legacy.handlers['POST /api/system/control'] = () => { throw new Error('não devia desligar'); };
    const stop = await legacy.launcher.parar();
    assert.equal(stop.cancelled, true, legacy.text());
    assert.match(legacy.text(), /Não deu para conferir se há prova em andamento: o servidor é de uma versão anterior do IClass\./);
    assert.match(legacy.asks[0], /Desligar mesmo assim\?/);
    const restart = await legacy.launcher.reiniciar();
    assert.equal(restart.cancelled, true);
    assert.match(legacy.asks[1], /Reiniciar mesmo assim\?/);
    const described = await legacy.launcher.status();
    assert.equal(described.state, 'ligado');
    assert.match(legacy.text(), /sem conferir as provas em andamento/);

    // A rota respondeu, mas sem conseguir ler as provas (catch do handleControlStatus).
    const failing = createWorld({ prefix: 'sem-provas-falha-' });
    const { pid, supervisorPid } = runningServer(failing, { status: serverStatus({ provasEmAndamento: null, provas: [], alunosConectados: null, comProblemas: true }) });
    assert.equal(launcherCore.examsUnknown(await failing.launcher.locate()), true);
    failing.handlers['POST /api/system/control'] = () => {
        failing.alive.delete(pid);
        failing.alive.delete(supervisorPid);
        return { status: 202, body: { success: true } };
    };
    const backup = await failing.launcher.backup({ sim: true });
    assert.equal(backup.code, 0, failing.text());
    assert.match(failing.text(), /Não deu para conferir se há prova em andamento: o servidor não conseguiu ler as provas agora\./);
    assert.match(failing.text(), /O backup pela linha de comando desliga o IClass por alguns instantes: se houver prova em andamento, espere ela terminar\./);
    assert.deepEqual(failing.runs.map(item => item.args), [['criar']]);

    // Com as provas conhecidas e nenhuma em andamento, nada de aviso.
    const known = createWorld({ prefix: 'sem-provas-ok-' });
    runningServer(known);
    assert.equal(launcherCore.examsUnknown(await known.launcher.locate()), false);
});

test('[UC-LAUNCHER-002] backup com o IClass ligado: desliga pela rota de controle, roda a backup-cli com a porta certa e liga de novo', async () => {
    const world = createWorld({ prefix: 'backup-' });
    const { pid, supervisorPid } = runningServer(world);
    world.handlers['POST /api/system/control'] = () => {
        world.alive.delete(pid);
        world.alive.delete(supervisorPid);
        fs.rmSync(path.join(world.dataDir, 'runtime', 'servidor.json'), { force: true });
        fs.rmSync(path.join(world.dataDir, 'runtime', 'control.token'), { force: true });
        return { status: 202, body: { success: true } };
    };
    world.handlers.run = params => {
        assert.deepEqual(params.args, ['criar']);
        assert.equal(params.env.PORT, String(world.port));
        assert.equal(world.alive.has(pid), false, 'a backup-cli roda com o servidor parado');
        return 0;
    };
    world.handlers.spawn = () => {
        writeRuntime(world.dataDir, 'servidor.json', { formato: 1, pid: 4242, porta: world.port, instanceId: 'depois' });
        world.alive.add(4242);
    };
    world.handlers['GET /api/health'] = () => (world.alive.has(4242) ? { status: 200, body: { status: 'ok', instanceId: 'depois' } } : refused());
    const result = await world.launcher.backup({ sim: true });
    assert.equal(result.code, 0, world.text());
    assert.equal(world.runs.length, 1);
    assert.equal(world.runs[0].script, path.join(world.root, 'backend', 'scripts', 'backup-cli.js'));
    assert.equal(world.spawns.length, 1, 'ligou de novo');
    assert.deepEqual(world.browser, [], 'sem abrir o navegador de novo');
});

test('[UC-LAUNCHER-002] killProcessTree: no Windows, taskkill /T sem /F (com /F só no forçado); nunca netstat', () => {
    const original = childProcess.spawnSync;
    const calls = [];
    childProcess.spawnSync = (command, args) => {
        calls.push([command, ...args]);
        return { status: 0 };
    };
    try {
        launcherCore.killProcessTree(1234, { platform: 'win32' });
        launcherCore.killProcessTree(1234, { platform: 'win32', force: true });
    } finally {
        childProcess.spawnSync = original;
    }
    assert.deepEqual(calls, [['taskkill', '/T', '/PID', '1234'], ['taskkill', '/T', '/F', '/PID', '1234']]);
    // Sem os comentários (que contam como era o .bat antigo).
    const code = file => fs.readFileSync(require.resolve(file), 'utf8').split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
    const source = code('../../backend/utils/launcherCore.js');
    const script = code('../../backend/scripts/launcher.js');
    assert.doesNotMatch(source + script, /netstat/i);
    assert.equal((source.match(/'\/F'/g) || []).length, 1, '/F só no ramo do encerramento forçado');
});

test('[UC-LAUNCHER-001] janela própria: no Windows pelo "start" do cmd com título (e /min), sem interpretar o caminho; fora dele, processo separado', () => {
    const original = childProcess.spawn;
    const calls = [];
    childProcess.spawn = (command, args, options) => {
        calls.push({ command, args, options });
        const child = new EventEmitter();
        child.unref = () => {};
        return child;
    };
    try {
        const win = launcherCore.startSupervisorProcess({ nodePath: 'C:\\IClass\\programa\\3.1.0\\node\\node.exe', script: 'C:\\Users\\José\\IClass (x86)\\backend\\supervisor.js', cwd: 'C:\\IClass', env: {}, platform: 'win32', minimized: true });
        assert.equal(win.tracksExit, false);
        const linux = launcherCore.startSupervisorProcess({ nodePath: '/usr/bin/node', script: '/opt/iclass/backend/supervisor.js', cwd: '/opt/iclass', env: {}, platform: 'linux' });
        assert.equal(linux.tracksExit, true);
    } finally {
        childProcess.spawn = original;
    }
    assert.deepEqual(calls[0].args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(calls[0].args[3], '"start "IClass" /min "C:\\IClass\\programa\\3.1.0\\node\\node.exe" "C:\\Users\\José\\IClass (x86)\\backend\\supervisor.js""');
    assert.equal(calls[0].options.windowsVerbatimArguments, true);
    assert.equal(calls[1].command, '/usr/bin/node');
    assert.deepEqual(calls[1].args, ['/opt/iclass/backend/supervisor.js']);
    assert.equal(calls[1].options.detached, true);
});

// ---------------------------------------------------------------- reiniciar, endereço, demonstração

test('[UC-LAUNCHER-003] reiniciar sob o supervisor pela rota de controle: espera a instância nova; endereço abre /endereco', async () => {
    const world = createWorld({ prefix: 'reiniciar-' });
    runningServer(world);
    world.handlers['POST /api/system/control'] = params => {
        assert.deepEqual(params.body, { action: 'restart' });
        world.restartAt = world.clock + 2000;
        return { status: 202, body: { success: true } };
    };
    world.handlers['GET /api/health'] = () => {
        if (world.restartAt && world.clock >= world.restartAt) {
            writeRuntime(world.dataDir, 'servidor.json', { formato: 1, pid: 5002, porta: world.port, instanceId: 'reiniciado' });
            world.alive.add(5002);
            return { status: 200, body: { status: 'ok', instanceId: 'reiniciado' } };
        }
        // Até o processo novo subir, o antigo ainda responde com a instância velha.
        return { status: 200, body: { status: 'ok', instanceId: 'atual' } };
    };
    const result = await world.launcher.reiniciar({ sim: true });
    assert.equal(result.code, 0, world.text());
    assert.equal(result.instanceId, 'reiniciado');
    assert.equal(world.spawns.length, 0, 'o supervisor religa sozinho');

    const address = await world.launcher.endereco();
    assert.equal(address.code, 0);
    assert.equal(address.enderecoAlunos, 'http://192.168.0.10:4321');
    assert.equal(world.browser.at(-1).url, `http://localhost:${world.port}/endereco`);

    const off = createWorld({ prefix: 'endereco-desligado-' });
    const none = await off.launcher.endereco();
    assert.equal(none.code, 1);
    assert.match(off.text(), /está desligado/);
});

test('[UC-LAUNCHER-003] demonstração na porta 3100 com pastas próprias recriadas do zero; o servidor de verdade e os dados dele não são tocados', async () => {
    const world = createWorld({ prefix: 'demo-', port: 3000 });
    runningServer(world);
    fs.writeFileSync(path.join(world.dataDir, 'database.db'), 'dados de verdade');
    const before = crypto.createHash('sha256').update(fs.readFileSync(path.join(world.dataDir, 'database.db'))).digest('hex');
    const demo = world.launcher.demoInstance();
    assert.equal(demo.port, 3100);
    assert.equal(demo.dataDir, path.join(world.root, 'demonstracao', 'dados'));
    // Sobra da demonstração anterior: some.
    fs.mkdirSync(demo.dataDir, { recursive: true });
    fs.writeFileSync(path.join(demo.dataDir, launcherCore.DEMO_MARKER), '');
    fs.writeFileSync(path.join(demo.dataDir, 'sobra.txt'), 'da apresentação de ontem');
    world.handlers.spawn = params => {
        assert.equal(params.env.TEST_MODE, '1');
        assert.equal(params.env.PORT, '3100');
        assert.equal(params.env.ICLASS_DATA_DIR, demo.dataDir);
        writeRuntime(demo.dataDir, 'servidor.json', { formato: 1, pid: 7001, porta: 3100, instanceId: 'demo' });
        world.alive.add(7001);
    };
    const realHealth = world.handlers['GET /api/health'];
    world.handlers['GET /api/health'] = params => (params.port === 3100 ? { status: 200, body: { status: 'ok', instanceId: 'demo' } } : realHealth(params));
    world.handlers['POST /api/test/seed'] = params => {
        assert.equal(params.port, 3100);
        return { status: 200, body: { success: true } };
    };
    world.handlers['POST /api/system/control'] = () => { throw new Error('não pode desligar o servidor de verdade'); };
    const result = await world.launcher.demonstracao();
    assert.equal(result.code, 0, world.text());
    assert.equal(fs.existsSync(path.join(demo.dataDir, 'sobra.txt')), false);
    assert.equal(fs.existsSync(path.join(demo.dataDir, launcherCore.DEMO_MARKER)), true);
    assert.deepEqual(world.browser.map(item => item.url), ['http://localhost:3100/login']);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(world.dataDir, 'database.db'))).digest('hex'), before);
    assert.equal((await world.launcher.locate()).state, 'ligado', 'o servidor de verdade continua ligado');
});

test('[UC-LAUNCHER-003] pastas da demonstração: nunca a pasta de dados de verdade nem dentro dela; pasta sem a marca não é apagada', () => {
    const root = fs.mkdtempSync(path.join(tempRoot, 'demo-pastas-'));
    const git = launcherCore.demoFolders({ projectRoot: root, folders: { DATA_DIR: path.join(root, 'data'), CONTENT_DIR: path.join(root, 'content'), ARCHIVE_DIR: path.join(root, 'cursos_arquivados'), origem: { DATA_DIR: 'padrao' } } });
    assert.equal(git.dataDir, path.join(root, 'data-demo'), 'na instalação pelo git, as pastas do ligarIclassV3.bat');
    assert.equal(git.contentDir, path.join(root, 'content-demo'));
    // Conteúdo de verdade numa pasta "demonstracao" ao lado dos dados: a demonstração cairia
    // dentro dela.
    assert.throws(() => launcherCore.demoFolders({ projectRoot: path.join(root, 'programa'), folders: { DATA_DIR: path.join(root, 'dados'), CONTENT_DIR: path.join(root, 'demonstracao'), ARCHIVE_DIR: path.join(root, 'a'), origem: { DATA_DIR: 'arquivo' } } }), /coincide com uma pasta de dados de verdade/);
    assert.throws(() => launcherCore.demoFolders({ projectRoot: path.join(root, 'programa'), folders: { DATA_DIR: path.join(root, 'dados'), CONTENT_DIR: path.join(root, 'demonstracao', 'conteudo', 'apostilas'), ARCHIVE_DIR: path.join(root, 'a'), origem: { DATA_DIR: 'arquivo' } } }), /coincide/);
    const foreign = path.join(root, 'outra');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'importante.txt'), 'não apagar');
    assert.throws(() => launcherCore.recreateDemoFolder(foreign, { legacy: false }), /não é da demonstração/);
    assert.equal(fs.readFileSync(path.join(foreign, 'importante.txt'), 'utf8'), 'não apagar');
    const legacy = path.join(root, 'data-demo');
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, 'database.db'), 'demo antiga do .bat');
    launcherCore.recreateDemoFolder(legacy, { legacy: true });
    assert.deepEqual(fs.readdirSync(legacy), [launcherCore.DEMO_MARKER]);
});

test('[UC-LAUNCHER-003] menu e opções do launcher.js: os rótulos do desenho, porta validada e comando desconhecido recusado', async () => {
    const labels = launcherScript.MENU.map(item => `[${item.key}] ${item.label}`);
    assert.deepEqual(labels, [
        '[1] Ligar o IClass',
        '[2] Desligar',
        '[3] Reiniciar',
        '[4] Fazer backup agora',
        '[5] Restaurar um backup',
        '[6] Endereço para os alunos',
        '[7] Redefinir a senha do administrador',
        '[8] Modo demonstração (porta 3100)',
        '[0] Sair',
    ]);
    const parsed = launcherScript.parseArgs(['iniciar', '--porta', '3005', '--sem-navegador']);
    assert.equal(parsed.command, 'iniciar');
    assert.equal(parsed.porta, 3005);
    assert.equal(parsed.semNavegador, true);
    assert.deepEqual(launcherScript.parseArgs(['restaurar', 'C:\\backups\\x.zip', '--sim']).positional, ['C:\\backups\\x.zip']);
    assert.throws(() => launcherScript.parseArgs(['iniciar', '--porta', 'abc']), /porta/);
    assert.throws(() => launcherScript.parseArgs(['--qualquer']), /Opção desconhecida/);
});

// ---------------------------------------------------------------- servidor de verdade

test('[UC-LAUNCHER-003] servidor de verdade no Linux: iniciar → status → reiniciar (instância nova, mesmas sessões) → backup (ZIP) → parar (parada limpa)', { timeout: 120000 }, async () => {
    const dataDir = fs.mkdtempSync(path.join(tempRoot, 'real-'));
    const port = await proc.freePort();
    spawnedSupervisors.add(dataDir);
    const lines = [];
    const browser = [];
    const scriptRuns = [];
    const env = proc.processEnv(dataDir, port);
    const launcher = launcherCore.createLauncher({
        env,
        supervisorScript: path.join(__dirname, 'fixtures', 'supervisor-child.js'),
        openBrowser: url => browser.push(url),
        out: line => lines.push(line),
        ask: async () => 's',
        run: async params => {
            const result = childProcess.spawnSync(params.nodePath, [params.script, ...params.args], { cwd: params.cwd, env: params.env, encoding: 'utf8' });
            scriptRuns.push({ args: params.args, status: result.status, output: `${result.stdout}${result.stderr}` });
            return result.status;
        },
    });
    const base = `http://127.0.0.1:${port}`;

    const started = await launcher.iniciar();
    assert.equal(started.code, 0, lines.join('\n'));
    assert.deepEqual(browser, [`http://localhost:${port}/`]);
    const info = launcherCore.readServerInfo(dataDir);
    assert.equal(info.porta, port);
    assert.equal(info.instanceId, started.instanceId);
    assert.ok(info.supervisorPid > 0, 'o servidor sabe o supervisor dele');
    const health = await proc.call(base, '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.supervised, true);

    const seeded = await proc.call(base, '/api/test/seed', { method: 'POST', body: {} });
    assert.equal(seeded.status, 200);
    const login = await proc.call(base, '/api/session/admin-login', { method: 'POST', body: { email: 'admin@teste.local', password: 'teste' } });
    assert.equal(login.status, 200, login.text);
    const session = { 'x-admin-session': login.body.sessionToken };
    assert.equal((await proc.call(base, '/api/admin/whoami', { headers: session })).status, 200);

    const situation = await launcher.status();
    assert.equal(situation.state, 'ligado');
    assert.equal(situation.found.status.supervisionado, true);
    assert.equal(situation.found.status.provasEmAndamento, 0);

    const restarted = await launcher.reiniciar({ sim: true });
    assert.equal(restarted.code, 0, lines.join('\n'));
    assert.notEqual(restarted.instanceId, started.instanceId, 'instância nova');
    assert.equal(launcherCore.readServerInfo(dataDir).pid !== info.pid, true, 'processo novo do servidor');
    assert.equal((await proc.call(base, '/api/admin/whoami', { headers: session })).status, 200, 'a mesma sessão continua valendo depois do reinício');

    const backup = await launcher.backup({ sim: true });
    assert.equal(backup.code, 0, `${lines.join('\n')}\n${scriptRuns.map(item => item.output).join('\n')}`);
    assert.deepEqual(scriptRuns.map(item => item.args), [['criar']]);
    const zips = fs.readdirSync(path.join(dataDir, 'backups')).filter(name => /^manual_completo_.*\.zip$/.test(name));
    assert.equal(zips.length, 1, 'o ZIP do backup');
    assert.equal((await launcher.locate()).state, 'ligado', 'ligou de novo depois do backup');

    const supervisorPid = Number(fs.readFileSync(path.join(dataDir, 'runtime', 'supervisor.pid'), 'utf8'));
    // O supervisor de verdade é reconhecido como Node (no Linux o título da janela não
    // troca o cmdline): status --json mostra o pid dele.
    assert.equal((await launcher.locate()).supervisorPid, supervisorPid);
    // Queda do servidor: na espera para religar, o launcher vê o supervisor vivo
    // ("ligando", nunca "desligado"), e o iniciar espera em vez de subir um segundo supervisor.
    const crashedPid = launcherCore.readServerInfo(dataDir).pid;
    process.kill(crashedPid, 'SIGKILL');
    await proc.waitFor(() => !proc.processAlive(crashedPid), { what: 'o servidor cair' });
    const duringBackoff = await launcher.locate();
    assert.notEqual(duringBackoff.state, 'desligado', 'o supervisor vivo vai religar');
    assert.equal(duringBackoff.supervisorPid, supervisorPid);
    const again = await launcher.iniciar({ abrirNavegador: false });
    assert.equal(again.code, 0, lines.join('\n'));
    assert.equal(Number(fs.readFileSync(path.join(dataDir, 'runtime', 'supervisor.pid'), 'utf8')), supervisorPid, 'o mesmo supervisor, nenhum segundo');
    assert.ok(proc.processAlive(supervisorPid));
    assert.notEqual(launcherCore.readServerInfo(dataDir).pid, crashedPid, 'o supervisor religou o servidor');
    const stopped = await launcher.parar({ sim: true });
    assert.equal(stopped.code, 0, lines.join('\n'));
    await proc.waitFor(() => !proc.processAlive(supervisorPid), { what: 'o supervisor sair' });
    const heartbeat = proc.readJson(proc.heartbeatFile(dataDir));
    assert.equal(heartbeat.clean, true);
    assert.equal(heartbeat.reason, 'stop');
    assert.equal(fs.existsSync(proc.controlTokenFile(dataDir)), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'runtime', 'servidor.json')), false, 'servidor.json sai junto com o token');
    assert.deepEqual(proc.readJson(path.join(dataDir, 'runtime', 'supervisor-saida.json')).codigo, 0);
    assert.equal((await launcher.locate()).state, 'desligado');
});

test('[UC-LAUNCHER-001] servidor de verdade com a porta ocupada: o launcher diz que a porta está em uso e sai com 2', { timeout: 60000 }, async () => {
    const dataDir = fs.mkdtempSync(path.join(tempRoot, 'porta-ocupada-'));
    const port = await proc.freePort();
    spawnedSupervisors.add(dataDir);
    const blocker = require('node:net').createServer();
    await new Promise(resolve => blocker.listen(port, '127.0.0.1', resolve));
    const lines = [];
    try {
        const launcher = launcherCore.createLauncher({
            env: proc.processEnv(dataDir, port),
            supervisorScript: path.join(__dirname, 'fixtures', 'supervisor-child.js'),
            openBrowser: () => { throw new Error('não devia abrir o navegador'); },
            out: line => lines.push(line),
        });
        const result = await launcher.iniciar();
        assert.equal(result.code, 2, lines.join('\n'));
        assert.match(lines.join('\n'), new RegExp(`A porta ${port} já está em uso`));
        assert.match(lines.join('\n'), /O que fazer: Outro programa/);
    } finally {
        // Sem esperar o close: a conexão do /api/health que ficou sem resposta é encerrada
        // pelo launcher, e o callback do close pode nunca vir.
        blocker.close();
    }
});
