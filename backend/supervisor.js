// Supervisor do servidor do IClass (H3c: CONF-12, OPS-06). Uso: node backend/supervisor.js
// (npm run start:supervised). O "npm start" continua subindo o servidor sozinho.
//
// Antes, o launcher abria "node backend/server.js" numa janela: se o processo caísse
// (falta de memória, erro nativo, exceção) ninguém o religava, e a saída sumia com a
// janela. O supervisor, em Node puro e sem pacote novo:
// - sobe o servidor como processo filho (fork, com canal IPC) e copia a saída dele para o
//   console e para DATA_DIR/logs/servidor.log (sem as cores e links do terminal, com data
//   e hora; o arquivo gira aos 5 MB e guarda 3 anteriores);
// - decide pelo código de saída do servidor (serverLifecycle.EXIT_CODES):
//   0 parada normal: o supervisor sai com 0;
//   75 reinício pedido (botão Reiniciar, launcher): sobe de novo na hora;
//   2 configuração (porta ocupada, build ausente ou desatualizado) e 3 banco danificado:
//     não adianta repetir; o supervisor sai com o mesmo código;
//   outro código ou morto por sinal (queda): sobe de novo depois de 1, 2, 5, 10 e 30 s. A
//     espera volta ao começo depois de 5 min no ar. 5 quedas seguidas sem o servidor ficar
//     pronto: desiste e sai com 1, com o aviso de onde olhar;
// - Ctrl+C, SIGTERM, fechar a janela (SIGHUP) e Ctrl+Break: pede a parada ordenada ao
//   servidor pelo IPC ({type:'shutdown'}) e, se ele não sair em 15 s, o encerra à força.
//   Nunca religa enquanto está parando;
// - grava o próprio pid em DATA_DIR/runtime/supervisor.pid (apaga ao sair), para o
//   launcher encerrar a árvore certa.
// O servidor recebe ICLASS_SUPERVISED=1 e, a cada início, quantos reinícios houve
// (ICLASS_SUPERVISOR_RESTARTS), como o anterior saiu (ICLASS_SUPERVISOR_LAST_EXIT) e
// quantas quedas fatais houve nos últimos 10 min (ICLASS_SUPERVISOR_RECENT_FATALS).
const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');
const runtimePaths = require('./runtimePaths.js');
const { crashLogPath } = require('./utils/errorLog.js');

const SERVER_SCRIPT = path.join(__dirname, 'server.js');
const EXIT = Object.freeze({ OK: 0, ERROR: 1, CONFIG: 2, DB_CORRUPT: 3, RESTART: 75 });
const BACKOFF_SECONDS = [1, 2, 5, 10, 30];
const STABLE_RESET_MS = 5 * 60 * 1000;
const MAX_FAILURES_BEFORE_READY = 5;
const FATAL_WINDOW_MS = 10 * 60 * 1000;
const STOP_KILL_AFTER_MS = 15 * 1000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_KEEP = 3;

function logsDir() { return path.join(runtimePaths.DATA_DIR, 'logs'); }
function logFile() { return path.join(logsDir(), 'servidor.log'); }
function pidFile() { return path.join(runtimePaths.DATA_DIR, 'runtime', 'supervisor.pid'); }

// Cores (CSI) e links (OSC 8) do terminal saem do arquivo de log.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
function stripAnsi(text) {
    return String(text).replace(ANSI_PATTERN, '');
}

function timestamp(date = new Date()) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Gira servidor.log aos 5 MB: .1 é o mais recente, guarda 3. Rename preso (antivírus,
// OneDrive no Windows): continua anexando no mesmo arquivo.
function rotateLog(file = logFile(), { maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP } = {}) {
    let size = 0;
    try { size = fs.statSync(file).size; } catch (e) { return false; }
    if (size < maxBytes) return false;
    try {
        for (let index = keep - 1; index >= 1; index -= 1) {
            const from = `${file}.${index}`;
            if (fs.existsSync(from)) fs.renameSync(from, `${file}.${index + 1}`);
        }
        fs.renameSync(file, `${file}.1`);
        return true;
    } catch (e) {
        return false;
    }
}

let logReady = false;
function appendLog(text) {
    try {
        if (!logReady) {
            fs.mkdirSync(logsDir(), { recursive: true });
            logReady = true;
        }
        rotateLog();
        fs.appendFileSync(logFile(), text);
    } catch (e) { /* o log nunca derruba o supervisor */ }
}

// Linhas do servidor: o console recebe como vieram; o arquivo, com data e hora e sem as
// sequências do terminal. pending guarda o pedaço de linha que ainda não terminou.
function createLineCopier(stream) {
    let pending = '';
    return {
        write(chunk) {
            const text = String(chunk);
            stream.write(text);
            pending += text;
            const lines = pending.split(/\r?\n/);
            pending = lines.pop();
            if (lines.length) appendLog(lines.map(line => `[${timestamp()}] ${stripAnsi(line)}\n`).join(''));
        },
        flush() {
            if (pending) appendLog(`[${timestamp()}] ${stripAnsi(pending)}\n`);
            pending = '';
        },
    };
}

// Mensagens do próprio supervisor: com data e hora no console e no arquivo.
function say(message, { error = false } = {}) {
    const line = `[${timestamp()}] ${message}`;
    (error ? process.stderr : process.stdout).write(`${line}\n`);
    appendLog(`${stripAnsi(line)}\n`);
}

// Próximo passo depois que o servidor saiu (puro, testável): 'exit' com o código do
// supervisor, 'restart' na hora, ou 'backoff' com a espera.
function decideAfterExit({ code, signal, stopping, failuresBeforeReady, crashStreak }) {
    if (stopping) return { action: 'exit', exitCode: code === null || code === undefined ? EXIT.OK : code };
    if (code === EXIT.OK) return { action: 'exit', exitCode: EXIT.OK };
    if (code === EXIT.RESTART) return { action: 'restart', delayMs: 0 };
    if (code === EXIT.CONFIG || code === EXIT.DB_CORRUPT) return { action: 'exit', exitCode: code };
    if (failuresBeforeReady >= MAX_FAILURES_BEFORE_READY) return { action: 'give_up', exitCode: EXIT.ERROR };
    const index = Math.min(Math.max(0, crashStreak - 1), BACKOFF_SECONDS.length - 1);
    return { action: 'backoff', delayMs: BACKOFF_SECONDS[index] * 1000, signal: signal || null };
}

function describeExit(code, signal) {
    return signal ? `sinal ${signal}` : `código ${code}`;
}

function createSupervisor({ serverScript = SERVER_SCRIPT, env = process.env, execArgv = [] } = {}) {
    const state = {
        child: null,
        stopping: false,
        restarts: 0,
        lastExit: '',
        crashStreak: 0,
        failuresBeforeReady: 0,
        fatalTimes: [],
        readyAt: null,
        restartTimer: null,
        killTimer: null,
        finished: false,
    };

    function writePid() {
        try {
            fs.mkdirSync(path.dirname(pidFile()), { recursive: true });
            fs.writeFileSync(pidFile(), String(process.pid));
        } catch (e) { /* o launcher cai para o PID da porta */ }
    }

    function removePid() {
        try {
            if (fs.readFileSync(pidFile(), 'utf8').trim() === String(process.pid)) fs.rmSync(pidFile(), { force: true });
        } catch (e) { /* já não existe */ }
    }

    function finish(exitCode) {
        if (state.finished) return;
        state.finished = true;
        clearTimeout(state.restartTimer);
        clearTimeout(state.killTimer);
        removePid();
        process.exit(exitCode);
    }

    function recentFatals(now = Date.now()) {
        state.fatalTimes = state.fatalTimes.filter(at => now - at < FATAL_WINDOW_MS);
        return state.fatalTimes.length;
    }

    function start() {
        if (state.stopping) return;
        state.readyAt = null;
        const childEnv = {
            ...env,
            ICLASS_SUPERVISED: '1',
            ICLASS_SUPERVISOR_RESTARTS: String(state.restarts),
            ICLASS_SUPERVISOR_LAST_EXIT: state.lastExit,
            ICLASS_SUPERVISOR_RECENT_FATALS: String(recentFatals()),
        };
        delete childEnv.ICLASS_RESTARTED;
        const child = fork(serverScript, [], { env: childEnv, stdio: ['inherit', 'pipe', 'pipe', 'ipc'], execArgv });
        state.child = child;
        const out = createLineCopier(process.stdout);
        const err = createLineCopier(process.stderr);
        child.stdout.on('data', chunk => out.write(chunk));
        child.stderr.on('data', chunk => err.write(chunk));
        child.on('message', message => {
            if (!message || typeof message !== 'object' || message.type !== 'ready') return;
            state.readyAt = Date.now();
            state.failuresBeforeReady = 0;
        });
        child.once('error', error => say(`⚠️ Não foi possível iniciar o servidor: ${error && error.message}`, { error: true }));
        child.once('exit', (code, signal) => {
            out.flush();
            err.flush();
            state.child = null;
            clearTimeout(state.killTimer);
            onChildExit(code, signal);
        });
    }

    function onChildExit(code, signal) {
        const now = Date.now();
        const wasReady = state.readyAt !== null;
        // No ar por mais de 5 min: a espera crescente volta ao começo.
        if (wasReady && now - state.readyAt >= STABLE_RESET_MS) state.crashStreak = 0;
        state.lastExit = signal ? String(signal) : String(code);
        const crashed = !state.stopping && code !== EXIT.OK && code !== EXIT.RESTART && code !== EXIT.CONFIG && code !== EXIT.DB_CORRUPT;
        if (crashed) {
            state.crashStreak += 1;
            state.fatalTimes.push(now);
            if (!wasReady) state.failuresBeforeReady += 1;
        }
        const decision = decideAfterExit({ code, signal, stopping: state.stopping, failuresBeforeReady: state.failuresBeforeReady, crashStreak: state.crashStreak });
        if (decision.action === 'exit') {
            if (state.stopping) say(`✅ Servidor parado (${describeExit(code, signal)}).`);
            else if (code === EXIT.CONFIG) say('⛔ O servidor não pode iniciar por um problema de configuração (veja a mensagem acima). O supervisor não vai tentar de novo.', { error: true });
            else if (code === EXIT.DB_CORRUPT) say('⛔ O banco de dados está danificado (veja a mensagem acima). O supervisor não vai tentar de novo.', { error: true });
            else say('✅ Servidor parado.');
            return finish(decision.exitCode);
        }
        if (decision.action === 'give_up') {
            say(`⛔ O servidor não conseguiu iniciar ${MAX_FAILURES_BEFORE_READY} vezes seguidas. Veja ${logFile()} e ${crashLogPath()}.`, { error: true });
            return finish(decision.exitCode);
        }
        state.restarts += 1;
        if (decision.action === 'restart') {
            say('🔁 Reinício pedido. Iniciando o servidor de novo…');
            return start();
        }
        say(`🔁 O servidor parou (${describeExit(code, signal)}). Reiniciando em ${Math.round(decision.delayMs / 1000)} s…`, { error: true });
        state.restartTimer = setTimeout(start, decision.delayMs);
    }

    function stop(signal) {
        if (state.stopping) return;
        state.stopping = true;
        clearTimeout(state.restartTimer);
        say(`🛑 Parando o servidor (${signal})…`);
        const child = state.child;
        if (!child) return finish(EXIT.OK);
        try {
            if (child.connected) child.send({ type: 'shutdown' });
            else child.kill('SIGTERM');
        } catch (e) {
            try { child.kill('SIGTERM'); } catch (error) { /* já saiu */ }
        }
        state.killTimer = setTimeout(() => {
            say(`⚠️ O servidor não parou em ${STOP_KILL_AFTER_MS / 1000} s; encerrando à força.`, { error: true });
            try { child.kill('SIGKILL'); } catch (e) { /* já saiu */ }
        }, STOP_KILL_AFTER_MS);
    }

    function run() {
        writePid();
        process.on('exit', removePid);
        ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'].forEach(signal => {
            try { process.on(signal, () => stop(signal)); } catch (e) { /* sinal inexistente nesta plataforma */ }
        });
        // O próprio supervisor só registra: ele não pode cair e deixar o servidor sem dono.
        process.on('uncaughtException', error => say(`⚠️ Erro no supervisor: ${(error && error.stack) || error}`, { error: true }));
        say(`▶️ Supervisor do IClass iniciado (processo ${process.pid}). Log em ${logFile()}.`);
        start();
    }

    return { run, stop, state };
}

if (require.main === module) {
    createSupervisor().run();
}

module.exports = {
    BACKOFF_SECONDS,
    EXIT,
    MAX_FAILURES_BEFORE_READY,
    createSupervisor,
    decideAfterExit,
    rotateLog,
    stripAnsi,
};
