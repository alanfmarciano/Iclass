// Saúde do servidor e controle do processo (H3c: CONF-12, OPS-06, OPS-07).
//
// Antes, /api/health dava 404 e /health devolvia 200 com o HTML do app (falso positivo
// para qualquer monitor), e o launcher só conseguia parar o servidor com taskkill /f
// (perdendo a gravação em andamento). Três rotas:
// - GET /api/health (pública): 200 só com o servidor funcionando; 503 'starting' durante
//   o boot (o handler de boot do server.js responde por ela) e 503 'degraded' (com
//   problemas) depois de uma exceção não tratada, com a gravação falhando seguidamente ou
//   com o banco sem responder. Sem e-mail, sem IP, sem dado de aluno;
// - GET /api/admin/system/health (instrutor com page.system): o cartão "Saúde do
//   servidor" da tela Sistema;
// - POST /api/system/control { action: 'stop' | 'restart' }: só do próprio computador
//   (loopback) e com o cabeçalho x-iclass-control igual ao conteúdo de
//   runtime/control.token (novo a cada boot). Responde 202 e faz o desligamento ordenado
//   (serverLifecycle.requestShutdown). É o caminho do launcher para parar ou reiniciar
//   sem taskkill /f. Qualquer outra situação: 403;
// - GET /api/system/control/status (fase 3, A16 / P6-S4): o mesmo guarda (loopback e o
//   token). O que o launcher precisa saber antes de desligar, reiniciar, fazer backup ou
//   restaurar: versão, instância, fase do boot, provas em andamento (com o nome da prova e
//   a turma), alunos conectados agora e o endereço dos alunos. Não muda nada.
// O estado do banco vem de db.storageStatus() (fonte única, pelo recorte db.health()) e
// de db.ping().
const express = require('express');
const db = require('../database.js');
const { validateAdmin } = require('../middlewares.js');
const serverLifecycle = require('../utils/serverLifecycle.js');
const { maskEmails, readLastCrash } = require('../utils/errorLog.js');
const { SERVER_INSTANCE_ID } = require('../utils/sessionConfig.js');
const { version: APP_VERSION } = require('../../package.json');

// Gravações seguidas que falharam a partir das quais o servidor está "com problemas".
const DEGRADED_SAVE_FAILURES = 3;
// Consultas seguidas ao banco (fora de gravação) que falharam.
const DEGRADED_PING_FAILURES = 2;
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const CONTROL_HEADER = 'x-iclass-control';
const CONTROL_ACTIONS = new Set(['stop', 'restart']);

function startedAtIso() {
    return new Date(serverLifecycle.bootState().startedAt).toISOString();
}

function uptimeSeconds(now = Date.now()) {
    return Math.max(0, Math.round((now - serverLifecycle.bootState().startedAt) / 1000));
}

function databaseCheck(ping) {
    if (!ping || ping.ok === null || ping.ok === undefined) return 'unknown';
    return ping.ok ? 'ok' : 'error';
}

// Estado do servidor atendendo pelo app: 'degraded' (com problemas) ou 'ok'. Durante o
// boot quem responde é o handler de boot do server.js ('starting', startingHealthBody).
function serverStatus({ save, ping }) {
    if (serverLifecycle.degradedState()) return 'degraded';
    if (save && save.consecutiveFailures >= DEGRADED_SAVE_FAILURES) return 'degraded';
    if (ping && ping.consecutiveFailures >= DEGRADED_PING_FAILURES) return 'degraded';
    return 'ok';
}

// Corpo do /api/health durante o boot (handler de boot do server.js): ainda não há banco
// para consultar. starting: true como todo o resto do /api no boot (contrato das
// respostas de estado: 503 {starting:true} com Retry-After 3): o cliente classifica o
// estado da conexão por ele, e a espera do Reiniciar e o cartão Saúde consultam
// justamente esta rota.
function startingHealthBody() {
    const boot = serverLifecycle.bootState();
    return {
        status: 'starting',
        starting: true,
        phase: boot.phase === 'ready' ? 'checking' : boot.phase,
        instanceId: SERVER_INSTANCE_ID,
        startedAt: startedAtIso(),
        uptimeSeconds: uptimeSeconds(),
        version: APP_VERSION,
        supervised: serverLifecycle.isSupervised(),
    };
}

async function publicHealth() {
    const ping = await db.ping();
    const save = db.health();
    const status = serverStatus({ save, ping });
    return {
        status,
        instanceId: SERVER_INSTANCE_ID,
        startedAt: startedAtIso(),
        uptimeSeconds: uptimeSeconds(),
        version: APP_VERSION,
        supervised: serverLifecycle.isSupervised(),
        checks: {
            database: databaseCheck(ping),
            lastSaveAt: save.lastOkAt || null,
        },
    };
}

// A queda mais recente durante uma prova (application.outages, H3b), com a prova e a
// turma.
function lastOutage(memory) {
    let latest = null;
    (Array.isArray(memory && memory.examApplications) ? memory.examApplications : []).forEach(application => {
        (Array.isArray(application && application.outages) ? application.outages : []).forEach(outage => {
            const to = Number(outage && outage.to);
            if (!(to > 0) || (latest && latest.to >= to)) return;
            latest = {
                from: Number(outage.from) || null,
                to,
                durationMs: Number(outage.durationMs) || 0,
                reason: outage.reason || null,
                compensated: outage.compensated === true,
                examKey: application.examKey || null,
                studentClass: application.studentClass || null,
                courseId: application.courseId || null,
            };
        });
    });
    return latest;
}

// "Com problemas" desde quando e por quê, sem e-mail (a mensagem do erro pode trazer o de
// um aluno; o detalhe completo fica no crash.log).
function degradedForCard() {
    const degraded = serverLifecycle.degradedState();
    if (!degraded) return null;
    return { at: degraded.at, reason: maskEmails(degraded.reason || '').slice(0, 300) };
}

const megabytes = bytes => Math.round((Number(bytes) || 0) / (1024 * 1024) * 10) / 10;

async function adminHealth() {
    const ping = await db.ping();
    const save = db.health();
    const boot = serverLifecycle.bootState();
    const supervisor = serverLifecycle.supervisorInfo();
    const memoryUsage = process.memoryUsage();
    return {
        status: serverStatus({ save, ping }),
        instanceId: SERVER_INSTANCE_ID,
        version: APP_VERSION,
        startedAt: startedAtIso(),
        bootDurationMs: boot.bootDurationMs,
        uptimeSeconds: uptimeSeconds(),
        rssMb: megabytes(memoryUsage.rss),
        heapUsedMb: megabytes(memoryUsage.heapUsed),
        dbFileMb: megabytes(save.dbFileBytes),
        database: databaseCheck(ping),
        save,
        supervised: supervisor.supervised,
        restarts: supervisor.restarts,
        lastExit: supervisor.lastExit,
        degraded: degradedForCard(),
        lastCrash: readLastCrash(),
        lastOutage: lastOutage(db.memory),
        sessionsRestored: boot.sessionsRestored || { students: 0, admins: 0, dropped: 0 },
    };
}

// Provas em andamento (aplicações em sala de espera, em andamento ou pausadas, a mesma
// regra do backup e da compactação) com o nome da prova e a turma, para o launcher dizer
// "Há 1 prova em andamento (Redes, 2DES)".
function activeExams(memory) {
    const { ACTIVE_APPLICATION_STATUSES } = require('../utils/examApplications.js');
    const { examTitle } = require('../utils/gradebook.js');
    const evaluations = (memory && memory.evaluations) || {};
    return (Array.isArray(memory && memory.examApplications) ? memory.examApplications : [])
        .filter(item => item && ACTIVE_APPLICATION_STATUSES.has(item.status))
        .map(item => ({
            titulo: String(item.title || examTitle(item.examKey, { evaluations }) || item.examKey || 'Prova'),
            turma: item.studentClass || null,
            cursoId: item.courseId || null,
            situacao: item.status,
        }));
}

// Alunos com sessão vista nos últimos 90 s (a mesma presença do painel e do Monitor).
function connectedStudents(memory) {
    const { studentSessionByEmail, studentSessionEmails } = require('../utils/authSessions.js');
    const { isStudentSessionOnline } = require('../utils/studentSessions.js');
    const now = Date.now();
    return studentSessionEmails(memory).filter(email => isStudentSessionOnline(studentSessionByEmail(memory, email), now)).length;
}

function studentAddress(port) {
    try {
        const { networkAddresses } = require('../utils/networkAddresses.js');
        const { studentsHttpsEnabled } = require('../utils/networkPolicy.js');
        const secureConnection = require('../utils/secureConnection.js');
        const snapshot = networkAddresses({ port, scheme: studentsHttpsEnabled() ? 'https' : 'http', httpsIps: secureConnection.serverIps() });
        return snapshot.recommended ? snapshot.recommended.url : null;
    } catch (e) {
        return null;
    }
}

function listeningPort(req) {
    const server = req.app && req.app.get && req.app.get('serverInstance');
    const address = server && typeof server.address === 'function' ? server.address() : null;
    if (address && typeof address === 'object' && address.port) return address.port;
    const local = req.socket && req.socket.localPort;
    return Number(local) || null;
}

// Corpo do GET /api/system/control/status. Durante o boot (handler de boot do server.js)
// o banco ainda não foi lido: provas e alunos vêm null ("não se sabe ainda").
function controlStatusBody(req, { ready = serverLifecycle.bootState().ready } = {}) {
    const boot = serverLifecycle.bootState();
    const port = listeningPort(req);
    const base = {
        success: true,
        versao: APP_VERSION,
        instanceId: SERVER_INSTANCE_ID,
        pid: process.pid,
        porta: port,
        fase: ready ? 'ready' : (boot.phase === 'ready' ? 'checking' : boot.phase),
        pronto: ready === true,
        supervisionado: serverLifecycle.isSupervised(),
        iniciadoEm: startedAtIso(),
    };
    if (!ready) return { ...base, provasEmAndamento: null, provas: [], alunosConectados: null, enderecoAlunos: null };
    const provas = activeExams(db.memory);
    return {
        ...base,
        provasEmAndamento: provas.length,
        provas,
        alunosConectados: connectedStudents(db.memory),
        enderecoAlunos: port ? studentAddress(port) : null,
        comProblemas: serverLifecycle.degradedState() ? true : false,
        // Pedido ao Windows para o computador não dormir durante a prova (A17, D13).
        computadorAcordado: keepAwakeActive(),
    };
}

function keepAwakeActive() {
    try { return require('../utils/keepAwake.js').keepAwake.status().ativo === true; } catch (e) { return false; }
}

function controlAllowed(req) {
    return isLoopback(req) && serverLifecycle.controlTokenMatches(req.get(CONTROL_HEADER));
}

// GET /api/system/control/status: no app e no handler de boot (createBootApp, com
// ready false). Sem o token ou de outro aparelho: 403, sem dizer o motivo.
function handleControlStatus(req, res) {
    res.set('Cache-Control', 'no-store');
    if (!controlAllowed(req)) return res.status(403).json({ error: 'Acesso negado.' });
    try {
        return res.json(controlStatusBody(req));
    } catch (err) {
        // A leitura das provas falhou: o servidor está no ar, mas o launcher não sabe das
        // provas. provasEmAndamento null é "não deu para saber" (launcherCore.examsUnknown):
        // desligar e reiniciar avisam e perguntam; backup, restaurar e senha avisam.
        return res.json({ ...controlStatusBody(req, { ready: false }), fase: 'ready', pronto: true, comProblemas: true });
    }
}

function isLoopback(req) {
    const address = String((req.socket && req.socket.remoteAddress) || '');
    return LOOPBACK_ADDRESSES.has(address);
}

function createSystemHealthRouter() {
    const router = express.Router();

    router.get('/api/health', async (req, res) => {
        let body;
        try {
            body = await publicHealth();
        } catch (err) {
            // A própria consulta falhou: o servidor está no ar, mas com problemas.
            body = { status: 'degraded', instanceId: SERVER_INSTANCE_ID, startedAt: startedAtIso(), uptimeSeconds: uptimeSeconds(), version: APP_VERSION, supervised: serverLifecycle.isSupervised(), checks: { database: 'unknown', lastSaveAt: null } };
        }
        res.status(body.status === 'ok' ? 200 : 503).json(body);
    });

    router.get('/api/admin/system/health', (req, res) => {
        validateAdmin(req, res, async () => {
            res.json({ success: true, ...(await adminHealth()) });
        });
    });

    router.get('/api/system/control/status', handleControlStatus);
    router.post('/api/system/control', handleSystemControl);

    return router;
}

// POST /api/system/control. O mesmo handler atende no app e no handler de boot do
// server.js (createBootApp): o launcher para ou reinicia também enquanto o servidor ainda
// carrega o banco, sem taskkill. Durante o boot o desligamento sai sem gravar (o que o
// boot gravou já está no disco).
function handleSystemControl(req, res) {
    res.set('Cache-Control', 'no-store');
    // Do próprio computador e com o token do boot; o resto é 403, sem dizer o motivo.
    if (!controlAllowed(req)) {
        return res.status(403).json({ error: 'Acesso negado.' });
    }
    const action = typeof (req.body || {}).action === 'string' ? req.body.action.trim() : '';
    if (!CONTROL_ACTIONS.has(action)) {
        return res.status(400).json({ success: false, error: 'Ação inválida: use stop ou restart.', field: 'action' });
    }
    if (!serverLifecycle.hasShutdownHandler()) {
        return res.status(503).json({ success: false, error: 'Controle indisponível neste modo.' });
    }
    res.status(202).json({ success: true, action, supervised: serverLifecycle.isSupervised(), starting: !serverLifecycle.bootState().ready });
    // Depois que a resposta saiu: o desligamento fecha as conexões.
    res.once('finish', () => setImmediate(() => {
        serverLifecycle.requestShutdown({ restart: action === 'restart', reason: action === 'restart' ? 'restart' : 'stop' });
    }));
    return undefined;
}

module.exports = {
    DEGRADED_PING_FAILURES,
    DEGRADED_SAVE_FAILURES,
    adminHealth,
    activeExams,
    controlStatusBody,
    createSystemHealthRouter,
    handleControlStatus,
    handleSystemControl,
    lastOutage,
    publicHealth,
    serverStatus,
    startingHealthBody,
};
