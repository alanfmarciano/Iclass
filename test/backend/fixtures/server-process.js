// Ajudantes dos testes que sobem o servidor (ou o supervisor) num processo próprio:
// porta livre, ambiente com pasta de dados temporária, espera pelo /api/health e leitura
// dos arquivos de runtime. Cada processo iniciado fica em `running` para o after() matar.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const running = new Set();

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

function processEnv(dataDir, port, extra = {}) {
    const env = {
        ...process.env,
        ICLASS_DATA_DIR: dataDir,
        ICLASS_CONTENT_DIR: path.join(dataDir, 'content'),
        ICLASS_ARCHIVE_DIR: path.join(dataDir, 'archives'),
        TEST_MODE: '1',
        PORT: String(port),
    };
    ['NODE_TEST_CONTEXT', 'ICLASS_ADMIN_SETUP_MODE', 'ICLASS_ADMIN_SETUP_TOKEN', 'ICLASS_SUPERVISED', 'ICLASS_SUPERVISOR_RESTARTS',
        'ICLASS_SUPERVISOR_LAST_EXIT', 'ICLASS_SUPERVISOR_RECENT_FATALS', 'ICLASS_RESTARTED', 'ICLASS_TEST_BOOT_DELAY_MS', 'ICLASS_TEST_BUILD', 'ICLASS_TEST_ALLOW_CRASH']
        .forEach(name => { delete env[name]; });
    return { ...env, ...extra };
}

// Inicia `script` e devolve { child, output(), exited, base, port }.
function launch(script, { dataDir, port, env = {} }) {
    const child = spawn(process.execPath, [script], { env: processEnv(dataDir, port, env), stdio: ['ignore', 'pipe', 'pipe'] });
    running.add(child);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => {
        running.delete(child);
        resolve({ code, signal });
    }));
    return { child, output: () => output, exited, port, base: `http://127.0.0.1:${port}` };
}

async function call(base, pathname, { method = 'GET', headers = {}, body } = {}) {
    const response = await fetch(base + pathname, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    const text = await response.text();
    try { json = JSON.parse(text); } catch (e) { json = null; }
    return { status: response.status, body: json, text, headers: response.headers };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Espera o /api/health satisfazer `accept` (padrão: 200), até timeoutMs.
async function waitForHealth(base, { timeoutMs = 30000, accept = res => res.status === 200, exited } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    let finished = null;
    if (exited) exited.then(result => { finished = result; });
    while (Date.now() < deadline) {
        if (finished) throw new Error(`o processo saiu (código ${finished.code}, sinal ${finished.signal}) antes do /api/health esperado`);
        try {
            last = await call(base, '/api/health');
            if (accept(last)) return last;
        } catch (e) {
            last = { error: String(e && e.message) };
        }
        await sleep(150);
    }
    throw new Error(`o /api/health não chegou ao esperado em ${timeoutMs} ms: ${JSON.stringify(last && (last.body || last))}`);
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

const heartbeatFile = dataDir => path.join(dataDir, 'runtime', 'heartbeat.json');
const controlTokenFile = dataDir => path.join(dataDir, 'runtime', 'control.token');

function processAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
}

function killAll() {
    running.forEach(child => { try { child.kill('SIGKILL'); } catch (e) { /* já saiu */ } });
}

module.exports = {
    call,
    controlTokenFile,
    freePort,
    heartbeatFile,
    killAll,
    launch,
    processAlive,
    readJson,
    running,
    sleep,
    waitForHealth,
};
