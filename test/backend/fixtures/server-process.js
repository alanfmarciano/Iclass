// Ajudantes dos testes que sobem o servidor (ou o supervisor) num processo próprio:
// porta livre, ambiente com pasta de dados temporária, espera pelo /api/health e leitura
// dos arquivos de runtime. Cada processo iniciado fica em `running` para o after() matar.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const running = new Set();

// Porta para um servidor de teste. Antes era a porta 0 do sistema, fechada logo depois:
// com os arquivos de teste rodando em paralelo, o próprio sistema entregava a mesma porta
// a outro processo (o supertest abre porta 0 a cada pedido, e o fetch usa portas da mesma
// faixa para sair) no intervalo até o filho abrir. O login ia para o servidor de outro
// arquivo (401) e a CLI via "O IClass está ligado". Agora a porta sai de uma faixa que o
// sistema nunca usa sozinho (abaixo de 32768 no Linux, de 49152 no Windows e no macOS) e
// fica reservada para este processo de teste por um arquivo em os.tmpdir(): outro
// arquivo de teste não recebe a mesma porta enquanto este estiver vivo, nem entre os
// reinícios que reaproveitam a porta.
const PORT_RANGE = { first: 21000, size: 9000 };
const portDir = path.join(os.tmpdir(), 'iclass-test-ports');
const reservedPorts = new Set();
const STALE_RESERVATION_MS = 6 * 60 * 60 * 1000;

function reservationOwnerGone(file) {
    try {
        const stat = fs.statSync(file);
        const pid = Number(fs.readFileSync(file, 'utf8'));
        if (!Number.isInteger(pid) || pid <= 0) return Date.now() - stat.mtimeMs > 60 * 1000;
        if (Date.now() - stat.mtimeMs > STALE_RESERVATION_MS) return true;
        return !processAlive(pid);
    } catch (e) {
        return e && e.code === 'ENOENT';
    }
}

function reservePort(port) {
    const file = path.join(portDir, String(port));
    for (let tries = 0; tries < 2; tries += 1) {
        try {
            fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
            reservedPorts.add(port);
            return true;
        } catch (e) {
            if (!e || e.code !== 'EEXIST') throw e;
            if (!reservationOwnerGone(file)) return false;
            try { fs.unlinkSync(file); } catch (err) { /* outro processo levou primeiro */ }
        }
    }
    return false;
}

function releasePorts() {
    reservedPorts.forEach(port => {
        const file = path.join(portDir, String(port));
        try {
            if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file);
        } catch (e) { /* já saiu */ }
    });
    reservedPorts.clear();
}
process.once('exit', releasePorts);

function portIsFree(port) {
    return new Promise(resolve => {
        const probe = net.createServer();
        probe.once('error', () => resolve(false));
        // O servidor abre em 0.0.0.0: a prova usa o mesmo endereço.
        probe.listen(port, '0.0.0.0', () => probe.close(() => resolve(true)));
    });
}

async function freePort() {
    fs.mkdirSync(portDir, { recursive: true });
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const port = PORT_RANGE.first + Math.floor(Math.random() * PORT_RANGE.size);
        if (reservedPorts.has(port) || !reservePort(port)) continue;
        if (await portIsFree(port)) return port;
        // Ocupada por algo de fora dos testes: fica reservada (não volta a ser sorteada aqui).
    }
    throw new Error('nenhuma porta livre para o servidor de teste');
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

// Espera check() devolver algo verdadeiro, até timeoutMs.
async function waitFor(check, { timeoutMs = 15000, intervalMs = 100, what = 'condição' } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(intervalMs);
    }
    throw new Error(`${what}: não aconteceu em ${timeoutMs} ms`);
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
    waitFor,
    waitForHealth,
};
