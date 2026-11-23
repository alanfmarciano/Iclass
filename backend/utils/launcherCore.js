// Launcher do IClass em Node (fase 3, A16 / P6-S4; OPS-01, OPS-02, OPS-07, OPS-15; D11 do P6).
//
// O ligarIclassV3.bat ligava o servidor com "start cmd /c node backend/server.js" (sem o
// supervisor: ninguém religava depois de uma queda, e a janela sumia com a mensagem de erro)
// e desligava com taskkill /f em todo processo cuja linha do netstat tivesse ":3000 ",
// inclusive o navegador e outros programas, sem perguntar e sem deixar o servidor gravar o
// que estava na fila. Estas são as ações do launcher novo, testáveis no Linux (o processo,
// o HTTP, o navegador e o taskkill são injetados); a interface do menu fica em
// backend/scripts/launcher.js e o IClass.cmd do pacote só acha o Node e chama ele.
//
// - iniciar: sobe backend/supervisor.js numa janela própria (no Windows, "start" do cmd;
//   fora dele, processo separado com a saída em DATA_DIR/logs/servidor.log), espera o
//   /api/health mostrando a fase do boot (até 90 s; até 10 min nas fases da atualização,
//   backup-atualizacao e migrando) e abre o navegador só com 200. Se o servidor sair, diz
//   o motivo pelo código (2 configuração, 3 banco danificado, 1 erro), com o fim do
//   servidor.log e o próximo passo; se passar do tempo, mostra o fim do log e deixa a
//   janela aberta;
// - parar: POST /api/system/control { action: 'stop' } com o token de runtime/control.token
//   e espera o processo sair; sem resposta em 15 s, taskkill /T sem /f na árvore do
//   supervisor (no Windows fecha a janela, e o supervisor faz a parada ordenada); só depois,
//   e só se a pessoa disser que sim, o encerramento forçado. Nunca netstat, nunca porta
//   escrita fixa: a porta e o processo vêm do runtime/servidor.json que o servidor grava
//   junto com o token. Token ou servidor.json de um processo que já terminou é ignorado;
// - reiniciar (pela rota de controle, sob o supervisor), backup e restaurar (backup-cli,
//   com o IClass parado e ligado de novo depois), senha (reset-admin-password.js, parando
//   antes pela rota de controle), endereco (abre /endereco), status;
// - demonstração na porta 3100 com pastas próprias recriadas do zero (TEST_MODE e o seed),
//   sem tocar no servidor de verdade nem nos dados dele;
// - instalar, atualizar, voltar para a versão anterior, ligar junto com o Windows e
//   desinstalar (A17 / P6-S5): em launcherInstall.js, expostas pelo createLauncher.
// Antes de desligar, reiniciar, fazer backup, restaurar ou redefinir a senha, o launcher lê
// GET /api/system/control/status: com prova em andamento, pergunta (desligar, reiniciar) ou
// recusa (backup, restaurar, senha) dizendo qual prova.
// Códigos de saída de cada ação (os mesmos do servidor e do supervisor): 0 deu certo,
// 1 falhou ou foi cancelado, 2 configuração (porta ocupada, build), 3 banco danificado.
//
// Este módulo não carrega o database.js nem o serverLifecycle.js (que puxa as regras de
// prova): o launcher nunca abre o banco. As fases e os códigos repetidos aqui são
// conferidos contra os do servidor em test/backend/launcher-core.test.js.
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const runtimePaths = require('../runtimePaths.js');

const EXIT = Object.freeze({ OK: 0, ERROR: 1, CONFIG: 2, DB_CORRUPT: 3 });
const DEFAULT_PORT = 3000;
const DEMO_PORT = 3100;
const CONTROL_HEADER = 'x-iclass-control';
// Texto de cada fase do boot (serverLifecycle.BOOT_PHASES, contrato C11 do P6): quem
// acrescenta uma fase demorada no boot acrescenta o texto aqui.
const BOOT_PHASE_TEXT = Object.freeze({
    starting: 'Abrindo o servidor',
    loading: 'Lendo o banco de dados',
    'backup-atualizacao': 'Fazendo o backup antes de atualizar os dados',
    migrando: 'Atualizando os dados para esta versão',
    restoring: 'Retomando as sessões',
    checking: 'Conferindo as provas em andamento',
    ready: 'Pronto',
});
const UPDATE_PHASES = Object.freeze(['backup-atualizacao', 'migrando']);
const DEFAULT_TIMEOUTS = Object.freeze({
    bootMs: 90 * 1000,
    updateMs: 10 * 60 * 1000,
    stopMs: 15 * 1000,
    forceMs: 5 * 1000,
    pollMs: 500,
    requestMs: 3000,
});
const LOG_TAIL_LINES = 25;
// Folga entre a hora em que o servidor de uma versão anterior diz que começou e a hora do
// control.token que ele grava logo depois de abrir a porta (relógio do mesmo computador).
const TOKEN_CLOCK_SLACK_MS = 2000;
const DEMO_MARKER = '.iclass-demonstracao';
const WINDOW_TITLE = 'Servidor do IClass (não feche esta janela)';
const DEMO_WINDOW_TITLE = 'Demonstração do IClass (porta 3100)';
// Começo dos títulos acima (o sistema pode cortar o título de um processo).
const KNOWN_TITLE_PATTERN = /^(?:Servidor|Demonstração) do IClass/;
// Variáveis que só o supervisor passa ao servidor: herdadas do ambiente de quem chamou o
// launcher, confundiriam o servidor novo (contagem de reinícios, "reinício pedido").
const SUPERVISOR_ONLY_ENV = ['ICLASS_SUPERVISED', 'ICLASS_SUPERVISOR_RESTARTS', 'ICLASS_SUPERVISOR_LAST_EXIT', 'ICLASS_SUPERVISOR_RECENT_FATALS', 'ICLASS_RESTARTED'];

class LauncherError extends Error {
    constructor(message, code = EXIT.ERROR) {
        super(message);
        this.code = code;
    }
}

// --- arquivos de runtime --------------------------------------------------------------

function runtimeFile(dataDir, name) {
    return path.join(dataDir, 'runtime', name);
}

function readText(file) {
    try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
}

function readJson(file) {
    const text = readText(file);
    if (text === null) return null;
    try { return JSON.parse(text); } catch (e) { return null; }
}

// O processo existe? process.kill(pid, 0) só confere (também no Windows). EPERM: existe.
function processAlive(pid) {
    if (!(Number(pid) > 0)) return false;
    try {
        process.kill(Number(pid), 0);
        return true;
    } catch (err) {
        return !!err && err.code === 'EPERM';
    }
}

// O pid ainda é de um Node? Depois de uma falta de energia, o supervisor.pid ou o
// servidor.json podem sobrar com um número que o Windows já deu a outro programa: o
// taskkill /T nesse número fecharia o programa errado. No Windows pelo tasklist (nome da
// imagem); no Linux pelo executável do processo (/proc/<pid>/exe), porque o cmdline muda
// quando o processo troca o process.title (o supervisor de uma versão anterior desta fase
// fazia isso também no Linux); sem acesso ao exe (processo de outro usuário), pelo cmdline,
// aceitando também os títulos que o launcher dá à janela do supervisor; sem como saber,
// sim (o processAlive já conferiu que existe).
function processIsNode(pid, { platform = process.platform } = {}) {
    if (!(Number(pid) > 0)) return false;
    try {
        if (platform === 'win32') {
            const result = childProcess.spawnSync('tasklist', ['/FI', `PID eq ${Number(pid)}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
            if (result.status !== 0 || typeof result.stdout !== 'string') return true;
            return /^"node(?:\.exe)?"/im.test(result.stdout);
        }
        const procDir = `/proc/${Number(pid)}`;
        if (!fs.existsSync(procDir)) return platform === 'linux' ? false : true;
        const looksLikeNode = file => {
            const clean = String(file || '').replace(/ \(deleted\)$/, '');
            if (!clean) return false;
            if (/^node(?:js)?(?:\.exe)?$/i.test(path.basename(clean))) return true;
            try { return fs.realpathSync(process.execPath) === clean || path.resolve(process.execPath) === clean; } catch (e) { return false; }
        };
        let exe = null;
        try { exe = fs.readlinkSync(`${procDir}/exe`); } catch (e) { exe = null; }
        if (exe) return looksLikeNode(exe);
        const cmdline = String(fs.readFileSync(`${procDir}/cmdline`, 'utf8'));
        const argv0 = cmdline.split('\0')[0];
        if (looksLikeNode(argv0) || path.resolve(argv0) === path.resolve(process.execPath)) return true;
        const title = cmdline.replace(/\0+$/, '').trim();
        return KNOWN_TITLE_PATTERN.test(title);
    } catch (e) {
        return true;
    }
}

function readControlToken(dataDir) {
    const value = String(readText(runtimeFile(dataDir, 'control.token')) || '').trim();
    return /^[0-9a-f]{64}$/.test(value) ? value : null;
}

// runtime/servidor.json (serverLifecycle.writeServerInfo): { pid, porta, instanceId, ... }.
function readServerInfo(dataDir) {
    const parsed = readJson(runtimeFile(dataDir, 'servidor.json'));
    if (!parsed || typeof parsed !== 'object') return null;
    const pid = Number(parsed.pid);
    const porta = Number(parsed.porta);
    if (!(Number.isInteger(pid) && pid > 0) || !(Number.isInteger(porta) && porta > 0 && porta < 65536)) return null;
    return { ...parsed, pid, porta };
}

function readSupervisorPid(dataDir) {
    const pid = Number(String(readText(runtimeFile(dataDir, 'supervisor.pid')) || '').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function readSupervisorExit(dataDir) {
    const parsed = readJson(runtimeFile(dataDir, 'supervisor-saida.json'));
    if (!parsed || !(Number(parsed.pid) > 0) || !Number.isInteger(Number(parsed.codigo))) return null;
    return { pid: Number(parsed.pid), codigo: Number(parsed.codigo) };
}

function logFile(dataDir) {
    return path.join(dataDir, 'logs', 'servidor.log');
}

function fileSize(file) {
    try { return fs.statSync(file).size; } catch (e) { return 0; }
}

function fileMtimeMs(file) {
    try { return fs.statSync(file).mtimeMs; } catch (e) { return null; }
}

// As últimas linhas do servidor.log escritas depois de `offset` (o tamanho antes de ligar).
// O log girou (ficou menor que o offset): vale o arquivo todo.
function readLogTail(file, offset = 0, maxLines = LOG_TAIL_LINES) {
    let buffer;
    try { buffer = fs.readFileSync(file); } catch (e) { return []; }
    const start = offset > 0 && offset <= buffer.length ? offset : 0;
    const lines = buffer.subarray(start).toString('utf8').split(/\r?\n/).filter(line => line.trim());
    return lines.slice(-maxLines);
}

// --- textos ---------------------------------------------------------------------------

function plural(count, one, many) {
    return `${count} ${count === 1 ? one : many}`;
}

function phaseText(phase) {
    return BOOT_PHASE_TEXT[phase] || BOOT_PHASE_TEXT.loading;
}

// "Redes, 2DES" (uma) ou "Redes, 2DES; Banco de dados, 1DES" (várias).
function describeExams(provas) {
    return (Array.isArray(provas) ? provas : [])
        .map(item => (item && item.turma ? `${item.titulo || 'Prova'}, ${item.turma}` : String((item && item.titulo) || 'Prova')))
        .join('; ');
}

function examsSentence(provas) {
    const list = Array.isArray(provas) ? provas : [];
    if (!list.length) return '';
    return list.length === 1
        ? `Há 1 prova em andamento (${describeExams(list)}).`
        : `Há ${list.length} provas em andamento (${describeExams(list)}).`;
}

// Próximo passo depois que o servidor saiu durante o boot, pelo código de saída e pela
// mensagem que ele deixou no log.
function nextStepFor(code, tail = []) {
    const text = tail.join('\n');
    if (code === EXIT.DB_CORRUPT) {
        return 'O banco de dados está danificado. Restaure o backup mais recente pela opção [5] (Restaurar um backup): o banco de agora vai para a quarentena, nada é apagado.';
    }
    if (code === EXIT.CONFIG) {
        if (/porta \d+ já está em uso/i.test(text)) return 'Outro programa (ou outra janela do IClass) está usando a porta. Feche-o e ligue o IClass de novo.';
        if (/interface|build|web\/src|reinstale/i.test(text)) return 'Os arquivos do programa estão incompletos ou desatualizados: reinstale esta versão do IClass (na instalação pelo git, rode npm run build).';
        if (/backup antes de atualizar/i.test(text)) return 'Libere espaço no disco (ou conecte o destino do backup) e ligue o IClass de novo. Nada foi alterado.';
        if (/versão .* mais nova/i.test(text)) return 'Estes dados são de uma versão mais nova do IClass: abra a versão nova.';
        return 'Corrija o que a mensagem acima diz e ligue o IClass de novo.';
    }
    return 'O servidor não conseguiu ligar. Veja a mensagem acima e o arquivo de registro (servidor.log); se continuar, ligue o computador de novo e tente outra vez.';
}

function exitCodeFor(code) {
    if (code === EXIT.CONFIG || code === EXIT.DB_CORRUPT) return code;
    return EXIT.ERROR;
}

// O servidor está no ar, mas o launcher não sabe se há prova em andamento: servidor de uma
// versão anterior (sem a rota de situação), sem resposta, sem o arquivo de controle, ou a
// rota respondeu sem a contagem (a leitura das provas falhou: provasEmAndamento null).
// Ligando também conta: no boot o banco ainda não foi lido, e entre uma queda e o servidor
// voltar (o supervisor religando) as provas que estavam em andamento continuam no banco.
function examsUnknown(found) {
    if (!found || !['ligado', 'iniciando', 'sem-resposta', 'sem-controle'].includes(found.state)) return false;
    return !(found.status && Number.isInteger(found.status.provasEmAndamento));
}

function unknownExamsSentence(found) {
    if (found.state === 'iniciando') return 'Não deu para conferir se há prova em andamento: o IClass ainda está ligando (ou voltando depois de uma queda).';
    if (found.legacy) return 'Não deu para conferir se há prova em andamento: o servidor é de uma versão anterior do IClass.';
    if (found.state === 'ligado' && found.status) return 'Não deu para conferir se há prova em andamento: o servidor não conseguiu ler as provas agora.';
    return 'Não deu para conferir se há prova em andamento: o servidor não responde ao launcher.';
}

// --- padrões injetáveis ---------------------------------------------------------------

// GET/POST em 127.0.0.1:<porta>. Resolve { status, body, text }; falha de conexão rejeita
// com o código do erro (ECONNREFUSED, ETIMEDOUT...).
function httpRequest({ port, method = 'GET', pathname = '/', headers = {}, body, timeoutMs = DEFAULT_TIMEOUTS.requestMs }) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const req = http.request({
            host: '127.0.0.1',
            port,
            method,
            path: pathname,
            headers: { Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}), ...headers },
            timeout: timeoutMs,
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let parsed = null;
                try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
                resolve({ status: res.statusCode, body: parsed, text });
            });
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(Object.assign(new Error('sem resposta'), { code: 'ETIMEDOUT' })));
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

// Sobe o supervisor numa janela própria. No Windows, pelo "start" do cmd (a janela de
// console nova, com título; /min com minimizado): o cmd sai na hora, então o launcher
// acompanha o supervisor pelo runtime/supervisor.pid e lê o código de saída do
// runtime/supervisor-saida.json. Fora do Windows, processo separado (detached) sem
// terminal: o código de saída chega pelo evento 'exit'.
function startSupervisorProcess({ nodePath, script, cwd, env, platform = process.platform, minimized = false }) {
    if (platform === 'win32') {
        const quote = value => `"${String(value).replace(/"/g, '')}"`;
        const command = `start "IClass"${minimized ? ' /min' : ''} ${quote(nodePath)} ${quote(script)}`;
        const child = childProcess.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
            cwd,
            env,
            stdio: 'ignore',
            windowsVerbatimArguments: true,
            windowsHide: true,
            detached: true,
        });
        child.on('error', () => {});
        child.unref();
        return { child, tracksExit: false };
    }
    const child = childProcess.spawn(nodePath, [script], { cwd, env, stdio: 'ignore', detached: true });
    child.unref();
    return { child, tracksExit: true };
}

// Roda um script do IClass (backup-cli, redefinir senha) no mesmo console, com a entrada
// e a saída da pessoa. Resolve o código de saída.
function runScript({ nodePath, script, args = [], cwd, env }) {
    return new Promise(resolve => {
        const child = childProcess.spawn(nodePath, [script, ...args], { cwd, env, stdio: 'inherit' });
        child.once('error', () => resolve(EXIT.ERROR));
        child.once('exit', code => resolve(Number.isInteger(code) ? code : EXIT.ERROR));
    });
}

// taskkill /T (a árvore do supervisor: ele e o servidor) sem /f: no Windows fecha a janela,
// e o supervisor faz a parada ordenada. /F só com force (depois de perguntar). Fora do
// Windows: SIGTERM no supervisor (parada ordenada) e, com force, SIGKILL no grupo.
function killProcessTree(pid, { force = false, platform = process.platform } = {}) {
    if (platform === 'win32') {
        const args = force ? ['/T', '/F', '/PID', String(pid)] : ['/T', '/PID', String(pid)];
        const result = childProcess.spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true });
        return { ok: result.status === 0, command: ['taskkill', ...args] };
    }
    const signal = force ? 'SIGKILL' : 'SIGTERM';
    try {
        if (force) {
            try { process.kill(-pid, signal); } catch (e) { process.kill(pid, signal); }
        } else {
            process.kill(pid, signal);
        }
        return { ok: true, command: ['kill', `-${signal}`, String(pid)] };
    } catch (e) {
        return { ok: false, command: ['kill', `-${signal}`, String(pid)] };
    }
}

// Abre a página no navegador padrão, sem passar o endereço por um interpretador de
// comandos. Nunca lança.
function openInBrowser(url, { platform = process.platform } = {}) {
    try {
        let child;
        if (platform === 'win32') child = childProcess.spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', detached: true, windowsHide: true });
        else if (platform === 'darwin') child = childProcess.spawn('open', [url], { stdio: 'ignore', detached: true });
        else child = childProcess.spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
        child.on('error', () => {});
        child.unref();
        return true;
    } catch (e) {
        return false;
    }
}

const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- pastas ---------------------------------------------------------------------------

function isInside(child, parent) {
    const relative = path.relative(parent, child);
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function sameOrNested(a, b) {
    return isInside(a, b) || isInside(b, a);
}

// Pastas da demonstração: na instalação pelo git (pastas padrão), as mesmas do
// ligarIclassV3.bat (data-demo, content-demo e cursos_arquivados-demo, no .gitignore); no
// pacote, ao lado da pasta de dados, em demonstracao/. Nunca a pasta de dados de verdade,
// nem dentro dela (conferido antes de apagar qualquer coisa).
function demoFolders({ projectRoot, folders }) {
    const legacy = !folders.origem || folders.origem.DATA_DIR === 'padrao';
    const result = legacy
        ? {
            dataDir: path.join(projectRoot, 'data-demo'),
            contentDir: path.join(projectRoot, 'content-demo'),
            archiveDir: path.join(projectRoot, 'cursos_arquivados-demo'),
            legacy: true,
        }
        : {
            dataDir: path.join(path.dirname(folders.DATA_DIR), 'demonstracao', 'dados'),
            contentDir: path.join(path.dirname(folders.DATA_DIR), 'demonstracao', 'conteudo'),
            archiveDir: path.join(path.dirname(folders.DATA_DIR), 'demonstracao', 'cursos-arquivados'),
            legacy: false,
        };
    const real = [folders.DATA_DIR, folders.CONTENT_DIR, folders.ARCHIVE_DIR].map(item => path.resolve(item));
    [result.dataDir, result.contentDir, result.archiveDir].forEach(dir => {
        const resolved = path.resolve(dir);
        if (real.some(item => sameOrNested(resolved, item))) {
            throw new LauncherError(`A pasta da demonstração (${resolved}) coincide com uma pasta de dados de verdade. Nada foi apagado.`);
        }
        if (sameOrNested(resolved, path.resolve(projectRoot)) && !isInside(resolved, path.resolve(projectRoot))) {
            throw new LauncherError(`A pasta da demonstração (${resolved}) contém a pasta do programa. Nada foi apagado.`);
        }
    });
    return result;
}

// Recria uma pasta da demonstração do zero. Só apaga a que tem a marca da demonstração (ou,
// na instalação pelo git, as pastas -demo do ligarIclassV3.bat, que nunca tiveram marca).
function recreateDemoFolder(dir, { legacy }) {
    if (fs.existsSync(dir)) {
        const marked = fs.existsSync(path.join(dir, DEMO_MARKER));
        let empty = false;
        try { empty = fs.readdirSync(dir).length === 0; } catch (e) { empty = false; }
        if (!marked && !empty && !(legacy && /-demo$/.test(path.basename(dir)))) {
            throw new LauncherError(`A pasta ${dir} não é da demonstração (falta a marca ${DEMO_MARKER}). Nada foi apagado.`);
        }
        fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, DEMO_MARKER), 'Pasta da demonstração do IClass: recriada do zero a cada demonstração.\n');
}

// --- o launcher -----------------------------------------------------------------------

function createLauncher(options = {}) {
    const projectRoot = path.resolve(options.projectRoot || runtimePaths.PROJECT_ROOT);
    const baseEnv = { ...(options.env || process.env) };
    SUPERVISOR_ONLY_ENV.forEach(name => { delete baseEnv[name]; });
    const folders = options.folders || runtimePaths.resolveRuntimeFolders({ projectRoot, env: baseEnv });
    const explicitFolders = !!options.folders;
    const platform = options.platform || process.platform;
    const nodePath = options.nodePath || process.execPath;
    const scripts = {
        supervisor: options.supervisorScript || path.join(projectRoot, 'backend', 'supervisor.js'),
        backupCli: options.backupCliScript || path.join(projectRoot, 'backend', 'scripts', 'backup-cli.js'),
        resetPassword: options.resetPasswordScript || path.join(projectRoot, 'backend', 'scripts', 'reset-admin-password.js'),
    };
    const timeouts = { ...DEFAULT_TIMEOUTS, ...(options.timeouts || {}) };
    const startSupervisor = options.startSupervisor || startSupervisorProcess;
    const run = options.run || runScript;
    const request = options.request || httpRequest;
    const openBrowser = options.openBrowser || (url => openInBrowser(url, { platform }));
    const killTree = options.killTree || ((pid, opts) => killProcessTree(pid, { ...opts, platform }));
    const isAlive = options.isAlive || processAlive;
    const isNode = options.isNodeProcess || (pid => processIsNode(pid, { platform }));
    // pid gravado em runtime que ainda é um Node vivo: o resto (morto, ou o número já dado a
    // outro programa depois de uma falta de energia) é arquivo velho.
    const runningNode = pid => isAlive(pid) && isNode(pid);
    const sleep = options.sleep || realSleep;
    const now = options.now || Date.now;
    const out = options.out || (line => process.stdout.write(`${line}\n`));
    const ask = options.ask || (async () => '');
    const envPort = Number(baseEnv.PORT);
    const defaultPort = Number(options.port) || (Number.isInteger(envPort) && envPort > 0 ? envPort : DEFAULT_PORT);
    const demoPort = Number(options.demoPort) || DEMO_PORT;
    const version = options.version || (readJson(path.join(projectRoot, 'package.json')) || {}).version || '';

    const realInstance = {
        nome: 'IClass',
        dataDir: folders.DATA_DIR,
        contentDir: folders.CONTENT_DIR,
        archiveDir: folders.ARCHIVE_DIR,
        port: defaultPort,
        demo: false,
    };

    function instanceEnv(instance, extra = {}) {
        const env = { ...baseEnv, PORT: String(instance.port), ...extra };
        if (instance.demo || explicitFolders) {
            env.ICLASS_DATA_DIR = instance.dataDir;
            env.ICLASS_CONTENT_DIR = instance.contentDir;
            env.ICLASS_ARCHIVE_DIR = instance.archiveDir;
        }
        if (instance.demo) {
            env.TEST_MODE = '1';
            delete env.ICLASS_ADMIN_SETUP_MODE;
            delete env.ICLASS_ADMIN_SETUP_TOKEN;
        }
        return env;
    }

    // Sem resposta possível (a entrada acabou, como num "echo s | launcher.js parar" que
    // chega à segunda pergunta, ou Ctrl+C na pergunta): ask resolve null, e vale "não".
    async function confirm(question, { defaultYes = false } = {}) {
        const raw = await ask(`${question} ${defaultYes ? '(S/n)' : '(s/N)'} `);
        if (raw === null || raw === undefined) return false;
        const answer = String(raw).trim().toLowerCase();
        if (!answer) return defaultYes;
        return ['s', 'sim', 'y', 'yes'].includes(answer);
    }

    async function getStatus(port, token) {
        try {
            const res = await request({ port, method: 'GET', pathname: '/api/system/control/status', headers: { [CONTROL_HEADER]: token }, timeoutMs: timeouts.requestMs });
            return res;
        } catch (err) {
            return { status: 0, error: err && err.code ? err.code : String(err) };
        }
    }

    async function getHealth(port) {
        try {
            return await request({ port, method: 'GET', pathname: '/api/health', timeoutMs: timeouts.requestMs });
        } catch (err) {
            return { status: 0, error: err && err.code ? err.code : String(err) };
        }
    }

    // Um servidor de uma versão anterior (281029f: sem a rota de situação nem o
    // runtime/servidor.json) responde na porta: é o desta pasta de dados? O control.token
    // pode ter sobrado de um servidor parado à força (o ligarIclassV3.bat para o 281029f
    // com taskkill /f, que não deixa o servidor apagar o token), e qualquer outro programa
    // (outro IClass, a demonstração do .bat, outro servidor) pode estar na mesma porta. É o
    // nosso se o /api/health traz o instanceId do runtime/heartbeat.json desta pasta, gravado
    // por um Node ainda vivo (o 281029f grava { instanceId, pid } a cada 5 s), ou, enquanto
    // ele liga e ainda não gravou o heartbeat, se o control.token desta pasta foi gravado
    // depois que ele começou (o 281029f grava o token logo depois de abrir a porta). Com o
    // runtime/servidor.json de um Node vivo (o locate já conferiu), pelo instanceId dele.
    function legacyServerIsOurs(instance, health, info) {
        const body = health && health.body;
        const instanceId = body && typeof body.instanceId === 'string' ? body.instanceId : '';
        if (!instanceId) return { ours: false };
        if (info && info.instanceId === instanceId) return { ours: true, pid: info.pid };
        const heartbeat = readJson(runtimeFile(instance.dataDir, 'heartbeat.json'));
        const heartbeatPid = heartbeat ? Number(heartbeat.pid) : 0;
        if (heartbeat && heartbeat.instanceId === instanceId && Number.isInteger(heartbeatPid) && heartbeatPid > 0 && runningNode(heartbeatPid)) {
            return { ours: true, pid: heartbeatPid };
        }
        const startedAt = Date.parse(body.startedAt);
        const tokenAt = fileMtimeMs(runtimeFile(instance.dataDir, 'control.token'));
        if (Number.isFinite(startedAt) && tokenAt !== null && tokenAt >= startedAt - TOKEN_CLOCK_SLACK_MS) return { ours: true, pid: null };
        return { ours: false };
    }

    // Onde está o servidor desta pasta de dados e em que estado:
    // 'ligado' | 'iniciando' | 'desligado' | 'sem-resposta' | 'sem-controle'.
    async function locate(instance = realInstance) {
        const token = readControlToken(instance.dataDir);
        const info = readServerInfo(instance.dataDir);
        const supervisorPid = readSupervisorPid(instance.dataDir);
        const supervisorAlive = supervisorPid ? runningNode(supervisorPid) : false;
        const base = { token, info, port: info ? info.porta : instance.port, serverPid: info ? info.pid : null, supervisorPid: supervisorAlive ? supervisorPid : null, status: null };
        if (info && !runningNode(info.pid)) {
            // Arquivo de um processo que já terminou (queda, computador desligado) ou cujo
            // número hoje é de outro programa: ignorado.
            if (supervisorAlive) return { ...base, state: 'iniciando', serverPid: null, stale: true };
            return { ...base, state: 'desligado', stale: true, serverPid: null };
        }
        if (!info && !token) {
            // Sem servidor no ar, mas com o supervisor vivo: entre um reinício e outro.
            if (supervisorAlive) return { ...base, state: 'iniciando' };
            return { ...base, state: 'desligado' };
        }
        if (!token) return { ...base, state: 'sem-controle' };
        const res = await getStatus(base.port, token);
        if (res.status === 200 && res.body && res.body.success) {
            return { ...base, state: res.body.pronto ? 'ligado' : 'iniciando', status: res.body, serverPid: base.serverPid || Number(res.body.pid) || null };
        }
        if (res.status === 404 || (res.status === 503 && !info)) {
            // Servidor de uma versão anterior (sem a rota de situação): só o /api/health, e só
            // se ele for o desta pasta de dados. Senão é outro programa na porta, e o token é
            // de um servidor que já terminou.
            const health = await getHealth(base.port);
            const legacy = health.status ? legacyServerIsOurs(instance, health, info) : { ours: false };
            if (!legacy.ours) {
                if (health.status) return { ...base, state: 'desligado', stale: true, portBusy: true };
                if (supervisorAlive) return { ...base, state: 'iniciando' };
                return { ...base, state: 'desligado', stale: true };
            }
            const legacyBase = { ...base, legacy: true, serverPid: legacy.pid || null };
            if (health.status === 200) return { ...legacyBase, state: 'ligado' };
            if (health.status === 503 && health.body && health.body.status === 'starting') return { ...legacyBase, state: 'iniciando' };
            return { ...legacyBase, state: 'ligado', degraded: true };
        }
        if (res.status === 403) {
            // O token não vale nesta porta: outro programa (ou outro IClass) responde ali.
            if (info) return { ...base, state: 'sem-controle' };
            return { ...base, state: 'desligado', stale: true, portBusy: true };
        }
        if (!res.status) {
            if (info) return { ...base, state: 'sem-resposta' };
            if (supervisorAlive) return { ...base, state: 'iniciando' };
            return { ...base, state: 'desligado', stale: true };
        }
        return { ...base, state: info ? 'sem-resposta' : 'desligado' };
    }

    // "o IClass" ou "a demonstração", nos textos das ações que valem para as duas.
    function nameOf(instance, { capital = false } = {}) {
        const text = instance && instance.demo ? 'a demonstração' : 'o IClass';
        return capital ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
    }

    function windowOf(instance) {
        return instance && instance.demo ? 'da demonstração do IClass' : 'do servidor do IClass';
    }

    function localUrl(port, pathname = '/') {
        return `http://localhost:${port}${pathname}`;
    }

    function printReady(instance, status, port) {
        out(`${instance.demo ? 'Demonstração ligada' : 'IClass ligado'}: ${localUrl(port)}`);
        if (status && status.enderecoAlunos) out(`Endereço para os alunos: ${status.enderecoAlunos}`);
        else if (status && status.pronto && !instance.demo) out('Endereço para os alunos: este computador não está em nenhuma rede agora (ligue o Wi-Fi ou o cabo).');
    }

    // Espera o servidor desta pasta ficar pronto. child (fora do Windows): o supervisor, com
    // o evento de saída; sem ele, o supervisor é acompanhado pelo runtime/supervisor.pid.
    // previousInstanceId: no reinício, só vale a instância nova.
    async function waitReady(instance, { child = null, port, logOffset = 0, previousInstanceId = null, ignoreSupervisorPid = null, spawned = false } = {}) {
        const started = now();
        let deadline = started + timeouts.bootMs;
        let updateSeen = false;
        let lastPhase = null;
        let exited = null;
        let supervisorPid = null;
        if (child && typeof child.once === 'function') {
            child.once('exit', (code, signal) => { exited = { code: Number.isInteger(code) ? code : null, signal: signal || null }; });
            child.once('error', err => { exited = { code: null, error: err }; });
        }
        let targetPort = port;
        for (;;) {
            if (!child) {
                const pid = readSupervisorPid(instance.dataDir);
                if (pid && pid !== ignoreSupervisorPid && isAlive(pid)) supervisorPid = pid;
                else if (supervisorPid && !isAlive(supervisorPid)) {
                    const saida = readSupervisorExit(instance.dataDir);
                    exited = { code: saida && saida.pid === supervisorPid ? saida.codigo : null };
                } else if (spawned && !supervisorPid) {
                    // O supervisor saiu (porta ocupada, banco danificado) antes de a espera
                    // ver o supervisor.pid dele: o clearStaleRuntime apagou a saída velha antes
                    // de ligar, então um supervisor-saida.json aqui é desta vez.
                    const saida = readSupervisorExit(instance.dataDir);
                    if (saida && saida.pid !== ignoreSupervisorPid) exited = { code: saida.codigo };
                }
            }
            if (exited) return bootFailure(instance, exited, logOffset);
            const info = readServerInfo(instance.dataDir);
            if (info && isAlive(info.pid)) targetPort = info.porta;
            const health = await getHealth(targetPort);
            const body = health.body || {};
            // Só vale a resposta do servidor desta pasta de dados (o do runtime/servidor.json):
            // outro IClass na mesma porta responderia 200 enquanto o nosso sai com 2.
            const ours = !!body.instanceId && body.instanceId !== previousInstanceId
                && (info ? info.instanceId === body.instanceId : !spawned);
            if ((health.status === 200 || (health.status === 503 && body.status === 'degraded')) && ours) {
                const token = readControlToken(instance.dataDir);
                const status = token ? await getStatus(targetPort, token) : null;
                const statusBody = status && status.status === 200 ? status.body : null;
                printReady(instance, statusBody, targetPort);
                if (body.status === 'degraded') out('Atenção: o servidor ligou, mas está com problemas. Veja Sistema > Saúde do servidor no painel.');
                return { code: EXIT.OK, port: targetPort, instanceId: body.instanceId, status: statusBody };
            }
            if (health.status === 503 && body.status === 'starting' && (!previousInstanceId || body.instanceId !== previousInstanceId)) {
                const phase = body.phase || 'loading';
                if (phase !== lastPhase) {
                    out(`${phaseText(phase)}...`);
                    lastPhase = phase;
                }
                if (UPDATE_PHASES.includes(phase) && !updateSeen) {
                    updateSeen = true;
                    deadline = Math.max(deadline, started + timeouts.updateMs);
                }
            }
            if (now() >= deadline) {
                const tail = readLogTail(logFile(instance.dataDir), logOffset);
                const seconds = Math.round((updateSeen ? timeouts.updateMs : timeouts.bootMs) / 1000);
                out(`O ${instance.demo ? 'servidor da demonstração' : 'IClass'} não respondeu em ${seconds >= 120 ? `${Math.round(seconds / 60)} min` : `${seconds} s`}.`);
                if (tail.length) {
                    out('Últimas linhas do registro do servidor:');
                    tail.forEach(line => out(`  ${line}`));
                }
                out(`A janela do servidor continua aberta: veja nela o que está acontecendo (registro em ${logFile(instance.dataDir)}).`);
                return { code: EXIT.ERROR, timeout: true };
            }
            await sleep(timeouts.pollMs);
        }
    }

    function bootFailure(instance, exited, logOffset) {
        const tail = readLogTail(logFile(instance.dataDir), logOffset);
        const code = exited.code;
        if (code === EXIT.OK) {
            out('O servidor foi desligado antes de terminar de ligar.');
            return { code: EXIT.ERROR, exitCode: code };
        }
        out(`O ${instance.demo ? 'servidor da demonstração' : 'IClass'} não ligou${code === null || code === undefined ? '' : ` (código ${code})`}.`);
        if (exited.error) out(`Não foi possível abrir o servidor: ${exited.error.message || exited.error}`);
        if (tail.length) {
            out('Mensagem do servidor:');
            tail.forEach(line => out(`  ${line}`));
        }
        out(`O que fazer: ${nextStepFor(code, tail)}`);
        return { code: exitCodeFor(code), exitCode: code };
    }

    // Apaga os arquivos de runtime de um processo que já terminou, antes de ligar de novo:
    // a espera não confunde o supervisor.pid velho com o novo.
    function clearStaleRuntime(instance) {
        const pid = readSupervisorPid(instance.dataDir);
        if (pid && !runningNode(pid)) fs.rmSync(runtimeFile(instance.dataDir, 'supervisor.pid'), { force: true });
        const info = readServerInfo(instance.dataDir);
        if (info && !runningNode(info.pid)) fs.rmSync(runtimeFile(instance.dataDir, 'servidor.json'), { force: true });
        fs.rmSync(runtimeFile(instance.dataDir, 'supervisor-saida.json'), { force: true });
    }

    async function iniciar({ instance = realInstance, abrirNavegador = true, caminho = '/', minimizado = false, extraEnv = {} } = {}) {
        const found = await locate(instance);
        if (found.state === 'ligado') {
            out(`O ${instance.demo ? 'servidor da demonstração' : 'IClass'} já está ligado: ${localUrl(found.port)}`);
            if (found.status && found.status.enderecoAlunos) out(`Endereço para os alunos: ${found.status.enderecoAlunos}`);
            if (abrirNavegador) openBrowser(localUrl(found.port, caminho));
            return { code: EXIT.OK, already: true, port: found.port };
        }
        if (found.state === 'iniciando') {
            out(`${nameOf(instance, { capital: true })} já está ligando. Esperando ficar pronto...`);
            const ready = await waitReady(instance, { port: found.port });
            if (ready.code === EXIT.OK && abrirNavegador) openBrowser(localUrl(ready.port, caminho));
            return ready;
        }
        if (found.state === 'sem-resposta' || found.state === 'sem-controle') {
            out(`Já há um servidor ${instance.demo ? 'da demonstração' : 'do IClass'} com esta pasta de dados (processo ${found.serverPid || '?'}), mas ele não responde ao launcher. ${instance.demo ? 'Desligue a demonstração pela opção [8]' : 'Use a opção [2] (Desligar)'} e ligue de novo.`);
            return { code: EXIT.ERROR };
        }
        clearStaleRuntime(instance);
        const logOffset = fileSize(logFile(instance.dataDir));
        const staleSupervisor = readSupervisorPid(instance.dataDir);
        out(instance.demo ? `Ligando a demonstração na porta ${instance.port}...` : `Ligando o IClass na porta ${instance.port}...`);
        let started;
        try {
            started = startSupervisor({
                nodePath,
                script: scripts.supervisor,
                cwd: projectRoot,
                env: instanceEnv(instance, { ICLASS_JANELA_TITULO: instance.demo ? DEMO_WINDOW_TITLE : WINDOW_TITLE, ...extraEnv }),
                platform,
                minimized: minimizado,
            });
        } catch (err) {
            out(`Não foi possível abrir a janela do servidor: ${err && err.message ? err.message : err}`);
            return { code: EXIT.ERROR };
        }
        const ready = await waitReady(instance, {
            child: started && started.tracksExit ? started.child : null,
            port: instance.port,
            logOffset,
            ignoreSupervisorPid: staleSupervisor,
            spawned: true,
        });
        if (ready.code === EXIT.OK && abrirNavegador) openBrowser(localUrl(ready.port, caminho));
        return ready;
    }

    // O servidor desta pasta saiu? Pelo processo do servidor e do supervisor; sem nenhum
    // dos dois conhecido (servidor de uma versão anterior), pela porta que deixa de responder.
    async function waitStopped(instance, found, ms) {
        const deadline = now() + ms;
        for (;;) {
            const serverGone = !found.serverPid || !isAlive(found.serverPid);
            const supervisorGone = !found.supervisorPid || !isAlive(found.supervisorPid);
            let stopped = serverGone && supervisorGone;
            if (stopped && !found.serverPid && !found.supervisorPid) stopped = (await getHealth(found.port)).status === 0;
            if (stopped) return true;
            if (now() >= deadline) return false;
            await sleep(timeouts.pollMs);
        }
    }

    async function confirmWithExams(found, verbo, { sim }) {
        const provas = found.status && Array.isArray(found.status.provas) ? found.status.provas : [];
        const question = `${verbo.charAt(0).toUpperCase()}${verbo.slice(1)} mesmo assim?`;
        if (provas.length) {
            if (sim) return true;
            out(examsSentence(provas));
            out(`Se ${verbo} agora, os alunos ficam sem o servidor até ele voltar (as respostas ficam guardadas e o tempo parado é devolvido quando o IClass voltar).`);
            return confirm(question);
        }
        if (!examsUnknown(found)) return true;
        // Sem como saber das provas: avisa sempre (também com --sim) e pergunta.
        out(unknownExamsSentence(found));
        out(`Se houver prova e você ${verbo} agora, os alunos ficam sem o servidor até ele voltar.`);
        if (sim) return true;
        return confirm(question);
    }

    async function parar({ instance = realInstance, sim = false, silencioso = false, jaConfirmado = false } = {}) {
        const found = await locate(instance);
        if (found.state === 'desligado') {
            if (!silencioso) out(`O ${instance.demo ? 'servidor da demonstração' : 'IClass'} já está desligado.`);
            return { code: EXIT.OK, already: true };
        }
        if (!jaConfirmado && !(await confirmWithExams(found, 'desligar', { sim }))) {
            out('Nada foi desligado.');
            return { code: EXIT.ERROR, cancelled: true };
        }
        if (!silencioso) out(`Desligando o ${instance.demo ? 'servidor da demonstração' : 'IClass'} (gravando os dados)...`);
        let asked = false;
        if (found.token && (found.state === 'ligado' || found.state === 'iniciando')) {
            try {
                const res = await request({ port: found.port, method: 'POST', pathname: '/api/system/control', headers: { [CONTROL_HEADER]: found.token }, body: { action: 'stop' }, timeoutMs: timeouts.requestMs });
                asked = res.status === 202;
            } catch (err) {
                asked = false;
            }
        }
        if (asked && await waitStopped(instance, found, timeouts.stopMs)) {
            out(`${instance.demo ? 'Demonstração desligada' : 'IClass desligado'}.`);
            return { code: EXIT.OK };
        }
        const target = found.supervisorPid || found.serverPid;
        if (!target) {
            out(`Não foi possível desligar pelo launcher. Feche a janela ${windowOf(instance)}.`);
            return { code: EXIT.ERROR };
        }
        if (!isNode(target)) {
            // Número que sobrou de antes e hoje é de outro programa: não fecha nada.
            out(`O processo ${target} não é mais o IClass (o arquivo em runtime ficou de antes). Nada foi fechado. Se a janela ${windowOf(instance)} estiver aberta, feche-a.`);
            return { code: EXIT.ERROR };
        }
        out(asked ? `O servidor não desligou em ${Math.round(timeouts.stopMs / 1000)} s. Pedindo para a janela dele fechar...` : 'O servidor não respondeu. Pedindo para a janela dele fechar...');
        killTree(target, { force: false });
        if (await waitStopped(instance, found, timeouts.stopMs)) {
            out(`${instance.demo ? 'Demonstração desligada' : 'IClass desligado'}.`);
            return { code: EXIT.OK };
        }
        const force = !sim && await confirm('O servidor continua ligado. Forçar o encerramento? O que estava sendo gravado pode se perder.');
        if (!force) {
            out(`O servidor continua ligado. Feche a janela ${windowOf(instance)} ou tente de novo.`);
            return { code: EXIT.ERROR };
        }
        killTree(target, { force: true });
        if (await waitStopped(instance, found, timeouts.forceMs)) {
            out('Servidor encerrado à força.');
            return { code: EXIT.OK, forced: true };
        }
        out('Não foi possível encerrar o servidor. Reinicie o computador.');
        return { code: EXIT.ERROR };
    }

    async function reiniciar({ instance = realInstance, sim = false, abrirNavegador = false } = {}) {
        const found = await locate(instance);
        if (found.state === 'desligado') return iniciar({ instance, abrirNavegador });
        if (!(await confirmWithExams(found, 'reiniciar', { sim }))) {
            out('Nada foi reiniciado.');
            return { code: EXIT.ERROR, cancelled: true };
        }
        const supervised = found.status && found.status.supervisionado === true;
        if (supervised && found.token) {
            let asked = false;
            try {
                const res = await request({ port: found.port, method: 'POST', pathname: '/api/system/control', headers: { [CONTROL_HEADER]: found.token }, body: { action: 'restart' }, timeoutMs: timeouts.requestMs });
                asked = res.status === 202;
            } catch (err) {
                asked = false;
            }
            if (asked) {
                out(`Reiniciando ${nameOf(instance)} (gravando os dados)...`);
                const logOffset = fileSize(logFile(instance.dataDir));
                const ready = await waitReady(instance, { port: found.port, logOffset, previousInstanceId: found.status.instanceId });
                if (ready.code === EXIT.OK && abrirNavegador) openBrowser(localUrl(ready.port));
                return ready;
            }
        }
        // Servidor sem o supervisor (ligado pelo .bat antigo) ou sem resposta: desliga e
        // liga de novo pelo supervisor.
        const stopped = await parar({ instance, sim: true, jaConfirmado: true });
        if (stopped.code !== EXIT.OK) return stopped;
        return iniciar({ instance, abrirNavegador });
    }

    function refuseWithExams(found, what, instance = realInstance) {
        const provas = found.status && Array.isArray(found.status.provas) ? found.status.provas : [];
        if (!provas.length) {
            // Sem como saber das provas: não recusa (o servidor pode ser de uma versão
            // anterior), mas avisa antes da pergunta de desligar.
            if (examsUnknown(found)) {
                out(unknownExamsSentence(found));
                out(`${what} desliga ${nameOf(instance)} por alguns instantes: se houver prova em andamento, espere ela terminar.`);
            }
            return false;
        }
        out(examsSentence(provas));
        out(`${what} desliga ${nameOf(instance)} por alguns instantes: espere a prova terminar.`);
        return true;
    }

    function isRunning(found) {
        return found.state !== 'desligado';
    }

    // Outro programa responde na porta (o IClass desta pasta está desligado): a backup-cli
    // recusa enquanto qualquer coisa responder ali ("O IClass está ligado"), sem saber que é
    // outro programa. O launcher já sabe e diz o que fazer.
    function refusePortBusy(found, what, instance) {
        if (!found.portBusy) return false;
        out(`A porta ${found.port} está sendo usada por outro programa, e ${what} só roda com essa porta livre (${nameOf(instance)} está desligad${instance.demo ? 'a' : 'o'}). Feche o outro programa e tente de novo.`);
        return true;
    }

    async function stopForMaintenance(found, instance, { sim, pergunta }) {
        if (!sim && !(await confirm(pergunta, { defaultYes: true }))) {
            out('Nada foi feito.');
            return false;
        }
        const stopped = await parar({ instance, sim: true, jaConfirmado: true });
        return stopped.code === EXIT.OK;
    }

    async function backup({ instance = realInstance, sim = false, destino = null, dados = false } = {}) {
        const found = await locate(instance);
        const wasRunning = isRunning(found);
        if (wasRunning) {
            if (refuseWithExams(found, 'O backup pela linha de comando', instance)) {
                out('Ou faça o backup pela tela Sistema ("Fazer backup agora"), que não desliga nada.');
                return { code: EXIT.ERROR, refused: true };
            }
            const ok = await stopForMaintenance(found, instance, { sim, pergunta: `Para fazer o backup, ${nameOf(instance)} fica desligad${instance.demo ? 'a' : 'o'} por alguns segundos e liga de novo sozinh${instance.demo ? 'a' : 'o'}. Continuar?` });
            if (!ok) return { code: EXIT.ERROR, cancelled: true };
        } else if (refusePortBusy(found, 'o backup pela linha de comando', instance)) return { code: EXIT.CONFIG, portBusy: true };
        const args = ['criar', ...(dados ? ['--dados'] : []), ...(destino ? ['--destino', destino] : [])];
        const code = await run({ nodePath, script: scripts.backupCli, args, cwd: projectRoot, env: instanceEnv({ ...instance, port: found.port }) });
        if (wasRunning) {
            out(`Ligando ${nameOf(instance)} de novo...`);
            await iniciar({ instance, abrirNavegador: false });
        }
        return { code };
    }

    async function restaurar({ instance = realInstance, arquivo = null, ultimo = false, sim = false, perguntarArquivo = false } = {}) {
        let target = arquivo;
        let latest = ultimo;
        if (!target && !latest && perguntarArquivo) {
            await run({ nodePath, script: scripts.backupCli, args: ['listar'], cwd: projectRoot, env: instanceEnv(instance) });
            const answer = String((await ask('Caminho do arquivo .zip do backup (ou Enter para o mais recente): ')) || '').trim().replace(/^"(.*)"$/, '$1');
            if (answer) target = answer;
            else latest = true;
        }
        if (!target && !latest) {
            out('Informe o arquivo do backup ou use --ultimo.');
            return { code: EXIT.ERROR };
        }
        const found = await locate(instance);
        const wasRunning = isRunning(found);
        if (wasRunning) {
            if (refuseWithExams(found, 'Restaurar um backup', instance)) return { code: EXIT.ERROR, refused: true };
            const ok = await stopForMaintenance(found, instance, { sim, pergunta: `Para restaurar, ${nameOf(instance)} precisa ser desligad${instance.demo ? 'a' : 'o'}. Desligar agora?` });
            if (!ok) return { code: EXIT.ERROR, cancelled: true };
        } else if (refusePortBusy(found, 'a restauração pela linha de comando', instance)) return { code: EXIT.CONFIG, portBusy: true };
        const args = ['restaurar', ...(target ? [target] : ['--ultimo']), ...(sim ? ['--sim'] : [])];
        const code = await run({ nodePath, script: scripts.backupCli, args, cwd: projectRoot, env: instanceEnv({ ...instance, port: found.port }) });
        if (code === EXIT.OK) {
            if (sim || await confirm(`Ligar ${nameOf(instance)} agora?`, { defaultYes: true })) await iniciar({ instance, abrirNavegador: !sim });
        } else if (wasRunning) {
            out(`Nada foi restaurado. Ligando ${nameOf(instance)} de novo...`);
            await iniciar({ instance, abrirNavegador: false });
        }
        return { code };
    }

    async function senha({ instance = realInstance, email = null, sim = false, perguntarEmail = false } = {}) {
        let account = email;
        if (!account && perguntarEmail) account = String((await ask('E-mail da conta (Enter para o primeiro administrador): ')) || '').trim();
        const found = await locate(instance);
        const wasRunning = isRunning(found);
        if (wasRunning) {
            if (refuseWithExams(found, 'Redefinir a senha', instance)) return { code: EXIT.ERROR, refused: true };
            const ok = await stopForMaintenance(found, instance, { sim, pergunta: `Para redefinir a senha, ${nameOf(instance)} fica desligad${instance.demo ? 'a' : 'o'} por alguns segundos e liga de novo. Continuar?` });
            if (!ok) return { code: EXIT.ERROR, cancelled: true };
        }
        const code = await run({ nodePath, script: scripts.resetPassword, args: account ? [account] : [], cwd: projectRoot, env: instanceEnv({ ...instance, port: found.port }) });
        if (code !== EXIT.OK) out('Não foi possível redefinir a senha. Veja a mensagem acima.');
        if (wasRunning) {
            out(`Ligando ${nameOf(instance)} de novo...`);
            await iniciar({ instance, abrirNavegador: code === EXIT.OK && !sim, caminho: '/login' });
        } else if (code === EXIT.OK) {
            out(instance.demo ? 'Ligue a demonstração pela opção [8] e entre com a senha temporária.' : 'Ligue o IClass pela opção [1] e entre com a senha temporária.');
        }
        return { code };
    }

    async function endereco({ instance = realInstance, abrirNavegador = true } = {}) {
        const found = await locate(instance);
        if (found.state !== 'ligado') {
            if (found.state === 'iniciando') out(`${nameOf(instance, { capital: true })} ainda está ligando. Espere ficar pronto e tente de novo.`);
            else out(instance.demo ? 'A demonstração está desligada. Ligue pela opção [8] (Modo demonstração) e tente de novo.' : 'O IClass está desligado. Ligue pela opção [1] (Ligar o IClass) e tente de novo.');
            return { code: EXIT.ERROR };
        }
        const address = found.status && found.status.enderecoAlunos;
        if (address) out(`Endereço para os alunos: ${address}`);
        else if (found.status && found.status.pronto) out('Este computador não está em nenhuma rede agora (ligue o Wi-Fi ou o cabo).');
        // Servidor de uma versão anterior (sem a rota de situação) ou sem a leitura agora: o
        // launcher não sabe o endereço, mas a página /endereco do próprio servidor mostra.
        else out(`Não deu para ler o endereço dos alunos pelo launcher${found.legacy ? ' (o servidor é de uma versão anterior do IClass)' : ''}: ${abrirNavegador ? 'veja na página que vai abrir no navegador' : `veja em ${localUrl(found.port, '/endereco')}`}.`);
        if (abrirNavegador) openBrowser(localUrl(found.port, '/endereco'));
        return { code: EXIT.OK, enderecoAlunos: address || null };
    }

    function describeState(found, instance = realInstance) {
        const name = instance.demo ? 'Demonstração' : 'IClass';
        const suffix = instance.demo ? 'a' : 'o';
        if (found.state === 'ligado') {
            const status = found.status || {};
            const lines = [`${name} ligad${suffix} em ${localUrl(found.port)}${status.versao ? ` (versão ${status.versao})` : ''}.`];
            if (status.enderecoAlunos) lines.push(`Endereço para os alunos: ${status.enderecoAlunos}`);
            if (Number.isInteger(status.provasEmAndamento)) lines.push(status.provasEmAndamento ? examsSentence(status.provas) : 'Nenhuma prova em andamento.');
            else if (found.status) lines.push('Não deu para conferir as provas em andamento agora.');
            if (Number.isInteger(status.alunosConectados)) lines.push(`Alunos conectados agora: ${status.alunosConectados}.`);
            if (status.computadorAcordado === true) lines.push('O computador não vai dormir enquanto houver prova em andamento.');
            if (found.status && found.status.supervisionado === false) lines.push('Reinício automático desligado (o servidor foi ligado sem o supervisor).');
            if (found.legacy) lines.push('Servidor de uma versão anterior: o launcher só consegue desligá-lo e ligá-lo, sem conferir as provas em andamento.');
            return lines;
        }
        if (found.state === 'iniciando') {
            const phase = found.status && found.status.fase;
            return [`${name} ligando${phase ? `: ${phaseText(phase).toLowerCase()}` : ''}...`];
        }
        if (found.state === 'sem-resposta') return [`${name}: o servidor (processo ${found.serverPid}) não responde. Use a opção [2] (Desligar).`];
        if (found.state === 'sem-controle') return [`${name}: há um servidor no ar com esta pasta de dados, mas sem o arquivo de controle. Feche a janela dele.`];
        const lines = [`${name} desligad${suffix}.`];
        if (found.portBusy) lines.push(`A porta ${found.port} está sendo usada por outro programa: ${instance.demo ? 'a demonstração' : 'o IClass'} não liga nela enquanto ele estiver aberto.`);
        return lines;
    }

    async function status({ instance = realInstance, json = false } = {}) {
        const found = await locate(instance);
        if (json) {
            out(JSON.stringify({
                estado: found.state,
                porta: found.port,
                versaoPrograma: version || null,
                versaoServidor: found.status ? found.status.versao : null,
                pid: found.serverPid,
                supervisorPid: found.supervisorPid,
                provasEmAndamento: found.status ? found.status.provasEmAndamento : null,
                provas: found.status ? found.status.provas : [],
                alunosConectados: found.status ? found.status.alunosConectados : null,
                enderecoAlunos: found.status ? found.status.enderecoAlunos : null,
                computadorAcordado: found.status ? found.status.computadorAcordado === true : null,
                portaOcupada: found.portBusy === true,
                pastaDeDados: instance.dataDir,
            }));
        } else {
            describeState(found, instance).forEach(line => out(line));
        }
        return { code: EXIT.OK, state: found.state, found };
    }

    function demoInstance() {
        const demo = demoFolders({ projectRoot, folders });
        return { nome: 'Demonstração', dataDir: demo.dataDir, contentDir: demo.contentDir, archiveDir: demo.archiveDir, port: demoPort, demo: true, legacy: demo.legacy };
    }

    async function demonstracao({ abrirNavegador = true } = {}) {
        let demo;
        try {
            demo = demoInstance();
        } catch (err) {
            out(err.message);
            return { code: EXIT.ERROR };
        }
        const real = await locate(realInstance);
        if (real.state !== 'desligado' && real.port === demo.port) {
            out(`O IClass de verdade está usando a porta ${demo.port}: a demonstração não pode usar a mesma porta.`);
            return { code: EXIT.CONFIG };
        }
        const previous = await locate(demo);
        if (previous.state !== 'desligado') {
            out('Desligando a demonstração anterior...');
            const stopped = await parar({ instance: demo, sim: true, silencioso: true, jaConfirmado: true });
            if (stopped.code !== EXIT.OK) return stopped;
        }
        out('Preparando a demonstração do zero (nada dos dados de verdade é lido ou alterado)...');
        try {
            [demo.dataDir, demo.contentDir, demo.archiveDir].forEach(dir => recreateDemoFolder(dir, { legacy: demo.legacy }));
        } catch (err) {
            out(err.message);
            return { code: EXIT.ERROR };
        }
        const ready = await iniciar({ instance: demo, abrirNavegador: false });
        if (ready.code !== EXIT.OK) return ready;
        try {
            const seeded = await request({ port: ready.port, method: 'POST', pathname: '/api/test/seed', body: {}, timeoutMs: 30000 });
            if (seeded.status === 200) out('Dados de demonstração prontos (curso, turma, alunos e notas). Na tela de login, use os botões Administrador, Professor ou Aluno.');
            else out('Não foi possível preparar os dados de demonstração agora: os botões da tela de login criam os dados ao serem usados.');
        } catch (err) {
            out('Não foi possível preparar os dados de demonstração agora: os botões da tela de login criam os dados ao serem usados.');
        }
        out('Nada da demonstração vai para os dados de verdade. Ao terminar, desligue a demonstração pelo menu.');
        if (abrirNavegador) openBrowser(localUrl(ready.port, '/login'));
        return ready;
    }

    async function pararDemonstracao() {
        let demo;
        try {
            demo = demoInstance();
        } catch (err) {
            out(err.message);
            return { code: EXIT.ERROR };
        }
        return parar({ instance: demo, sim: true, jaConfirmado: true });
    }

    // Instalar, atualizar, voltar de versão, ligar com o Windows e desinstalar (A17 /
    // P6-S5): em launcherInstall.js, com as mesmas injeções deste launcher.
    const install = require('./launcherInstall.js').createInstallActions({
        options,
        projectRoot,
        platform,
        baseEnv,
        out,
        ask,
        confirm,
        run,
        now,
        defaultPort,
        version,
        createLauncher,
    });

    return {
        EXIT,
        version,
        folders,
        realInstance,
        // Ligar do menu e do comando iniciar: com a oferta de atualizar sem o backup
        // de antes quando ele falhou (só com a pessoa digitando SIM).
        iniciarOferecendo: params => install.iniciarOferecendo({ iniciar, folders }, params),
        instalar: install.instalar,
        atualizar: install.atualizar,
        voltarVersao: install.voltarVersao,
        ligarComWindows: install.ligarComWindows,
        desinstalar: install.desinstalar,
        installationContext: install.installationContext,
        startupState: install.startupState,
        defaultInstallRoot: install.defaultRoot,
        demoInstance,
        locate,
        describeState,
        iniciar,
        parar,
        reiniciar,
        backup,
        restaurar,
        senha,
        endereco,
        status,
        demonstracao,
        pararDemonstracao,
    };
}

module.exports = {
    BOOT_PHASE_TEXT,
    DEFAULT_PORT,
    DEFAULT_TIMEOUTS,
    DEMO_MARKER,
    DEMO_PORT,
    EXIT,
    LauncherError,
    UPDATE_PHASES,
    createLauncher,
    demoFolders,
    describeExams,
    examsSentence,
    examsUnknown,
    httpRequest,
    killProcessTree,
    nextStepFor,
    openInBrowser,
    processAlive,
    processIsNode,
    readLogTail,
    readServerInfo,
    recreateDemoFolder,
    runScript,
    startSupervisorProcess,
};
