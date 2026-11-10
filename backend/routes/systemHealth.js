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
//   sem taskkill /f. Qualquer outra situação: 403.
// O estado do banco vem de db.storageStatus() (fonte única, pelo recorte db.health()) e
// de db.ping().
const express = require('express');
const db = require('../database.js');
const { validateAdmin } = require('../middlewares.js');
const serverLifecycle = require('../utils/serverLifecycle.js');
const { readLastCrash } = require('../utils/errorLog.js');
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
// para consultar.
function startingHealthBody() {
    const boot = serverLifecycle.bootState();
    return {
        status: 'starting',
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
    return { at: degraded.at, reason: String(degraded.reason || '').replace(/[^\s@]+@[^\s@]+/g, '[e-mail]').slice(0, 300) };
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
    if (!isLoopback(req) || !serverLifecycle.controlTokenMatches(req.get(CONTROL_HEADER))) {
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
    createSystemHealthRouter,
    handleSystemControl,
    lastOutage,
    publicHealth,
    serverStatus,
    startingHealthBody,
};
