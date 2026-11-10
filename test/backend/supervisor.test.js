// Supervisor do servidor (H3c: CONF-12, OPS-06). Antes não existia: se o processo caísse
// ninguém o religava, e o Reiniciar só voltava no Windows (e sem db.close). Estes testes
// sobem o supervisor de verdade (backend/supervisor.js, por fixtures/supervisor-child.js)
// com o servidor de verdade (startServer, sem a conferência do build de web/dist).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const proc = require('./fixtures/server-process.js');
const { BACKOFF_SECONDS, EXIT, MAX_FAILURES_BEFORE_READY, decideAfterExit, rotateLog, stripAnsi } = require('../../backend/supervisor.js');
const { EXIT_CODES } = require('../../backend/utils/serverLifecycle.js');

const supervisorScript = path.join(__dirname, 'fixtures', 'supervisor-child.js');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-supervisor-'));

test.after(() => proc.killAll());

const logOf = dataDir => {
    try { return fs.readFileSync(path.join(dataDir, 'logs', 'servidor.log'), 'utf8'); } catch (e) { return ''; }
};

async function startSupervised(prefix, env = {}) {
    const dataDir = fs.mkdtempSync(path.join(tempRoot, prefix));
    const port = await proc.freePort();
    const supervisor = proc.launch(supervisorScript, { dataDir, port, env });
    const health = await proc.waitForHealth(supervisor.base, { exited: supervisor.exited });
    return { dataDir, supervisor, health };
}

async function waitForNewInstance(base, previousId, { timeoutMs = 20000, exited } = {}) {
    return proc.waitForHealth(base, { timeoutMs, exited, accept: res => res.status === 200 && res.body && res.body.instanceId !== previousId });
}

async function stopSupervisor(supervisor) {
    supervisor.child.kill('SIGTERM');
    return supervisor.exited;
}

async function adminToken(base) {
    const login = await proc.call(base, '/api/session/admin-login', { method: 'POST', body: { email: 'admin@teste.local', password: 'teste' } });
    if (login.status !== 404) {
        assert.equal(login.status, 200, JSON.stringify(login.body));
        return login.body.sessionToken;
    }
    const res = await proc.call(base, '/api/admin/whoami', { headers: { Authorization: 'admin@teste.local:teste' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.sessionToken;
}

test('[UC-SAUDE-001] decisão depois da saída: 0 para, 75 volta na hora, 2 e 3 param sem laço, queda volta com espera crescente e desiste depois de 5 sem ficar pronto', () => {
    assert.deepEqual(EXIT, EXIT_CODES, 'os mesmos códigos do servidor');
    assert.deepEqual(decideAfterExit({ code: 0, stopping: false, failuresBeforeReady: 0, crashStreak: 0 }), { action: 'exit', exitCode: 0 });
    assert.deepEqual(decideAfterExit({ code: 75, stopping: false, failuresBeforeReady: 0, crashStreak: 0 }), { action: 'restart', delayMs: 0 });
    assert.deepEqual(decideAfterExit({ code: 2, stopping: false, failuresBeforeReady: 1, crashStreak: 0 }), { action: 'exit', exitCode: 2 });
    assert.deepEqual(decideAfterExit({ code: 3, stopping: false, failuresBeforeReady: 1, crashStreak: 0 }), { action: 'exit', exitCode: 3 });
    assert.deepEqual(BACKOFF_SECONDS, [1, 2, 5, 10, 30]);
    assert.equal(decideAfterExit({ code: 1, stopping: false, failuresBeforeReady: 0, crashStreak: 1 }).delayMs, 1000);
    assert.equal(decideAfterExit({ code: null, signal: 'SIGKILL', stopping: false, failuresBeforeReady: 0, crashStreak: 3 }).delayMs, 5000);
    assert.equal(decideAfterExit({ code: 1, stopping: false, failuresBeforeReady: 0, crashStreak: 9 }).delayMs, 30000);
    assert.deepEqual(decideAfterExit({ code: 1, stopping: false, failuresBeforeReady: MAX_FAILURES_BEFORE_READY, crashStreak: 5 }), { action: 'give_up', exitCode: 1 });
    // Parando: nunca religa.
    assert.deepEqual(decideAfterExit({ code: 75, stopping: true, failuresBeforeReady: 0, crashStreak: 0 }), { action: 'exit', exitCode: 75 });
    assert.deepEqual(decideAfterExit({ code: null, signal: 'SIGKILL', stopping: true, failuresBeforeReady: 0, crashStreak: 0 }), { action: 'exit', exitCode: 0 });
});

test('[UC-SAUDE-001] log do supervisor: sem as sequências do terminal e girando aos 5 MB com 3 anteriores', () => {
    assert.equal(stripAnsi('\x1b]8;;http://x\x1b\\http://x\x1b]8;;\x1b\\ \x1b[32mok\x1b[0m'), 'http://x ok');
    const dir = fs.mkdtempSync(path.join(tempRoot, 'rotacao-'));
    const file = path.join(dir, 'servidor.log');
    for (let round = 1; round <= 5; round += 1) {
        fs.writeFileSync(file, `rodada ${round}\n`.padEnd(200, '.'));
        assert.equal(rotateLog(file, { maxBytes: 100, keep: 3 }), true);
    }
    assert.equal(fs.existsSync(file), false);
    assert.match(fs.readFileSync(`${file}.1`, 'utf8'), /rodada 5/);
    assert.match(fs.readFileSync(`${file}.3`, 'utf8'), /rodada 3/);
    assert.equal(fs.existsSync(`${file}.4`), false);
    fs.writeFileSync(file, 'pequeno');
    assert.equal(rotateLog(file, { maxBytes: 100, keep: 3 }), false);
});

test('[UC-SAUDE-001] kill -9 no servidor: o supervisor sobe outro em segundos, com a linha de reinício no servidor.log', async () => {
    const { dataDir, supervisor, health } = await startSupervised('kill-');
    try {
        assert.equal(health.body.supervised, true);
        assert.ok(fs.existsSync(path.join(dataDir, 'runtime', 'supervisor.pid')));
        const childPid = proc.readJson(proc.heartbeatFile(dataDir)).pid;
        assert.ok(childPid > 0 && childPid !== supervisor.child.pid);
        process.kill(childPid, 'SIGKILL');
        const back = await waitForNewInstance(supervisor.base, health.body.instanceId, { timeoutMs: 15000, exited: supervisor.exited });
        assert.equal(back.body.status, 'ok');
        assert.match(logOf(dataDir), /🔁 O servidor parou \(sinal SIGKILL\)\. Reiniciando em 1 s…/);
        assert.match(logOf(dataDir), /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] .*iniciado com sucesso/);
        assert.equal(/\x1b/.test(logOf(dataDir)), false, 'sem sequências do terminal no arquivo');
    } finally {
        assert.equal((await stopSupervisor(supervisor)).code, 0);
    }
});

test('[UC-MANUT-001] Reiniciar pela tela Sistema: o servidor sai com 75 e volta, e o mesmo token do instrutor continua valendo', async () => {
    const { dataDir, supervisor, health } = await startSupervised('reiniciar-');
    try {
        assert.equal((await proc.call(supervisor.base, '/api/test/seed', { method: 'POST', body: {} })).status, 200);
        const token = await adminToken(supervisor.base);
        const restart = await proc.call(supervisor.base, '/api/admin/server/restart', { method: 'POST', headers: { 'x-admin-session': token }, body: { confirm: 'REINICIAR' } });
        assert.equal(restart.status, 200, JSON.stringify(restart.body));
        assert.equal(restart.body.supervised, true);
        const back = await waitForNewInstance(supervisor.base, health.body.instanceId, { exited: supervisor.exited });
        assert.equal(back.body.status, 'ok');
        assert.match(logOf(dataDir), /Reinício pedido\. Iniciando o servidor de novo…/);
        const whoami = await proc.call(supervisor.base, '/api/admin/whoami', { headers: { 'x-admin-session': token } });
        assert.equal(whoami.status, 200, 'ninguém precisa entrar de novo');
        const card = await proc.call(supervisor.base, '/api/admin/system/health', { headers: { 'x-admin-session': token } });
        assert.equal(card.body.restarts, 1);
        assert.equal(card.body.lastExit, '75');
        assert.equal(card.body.sessionsRestored.admins, 1);
    } finally {
        assert.equal((await stopSupervisor(supervisor)).code, 0);
    }
});

test('[UC-SAUDE-001] porta ocupada: o supervisor sai com 2 sem entrar em laço', async () => {
    const dataDir = fs.mkdtempSync(path.join(tempRoot, 'porta-'));
    const port = await proc.freePort();
    const blocker = http.createServer((req, res) => res.end('outro'));
    await new Promise(resolve => blocker.listen(port, '127.0.0.1', resolve));
    try {
        const supervisor = proc.launch(supervisorScript, { dataDir, port });
        const result = await supervisor.exited;
        assert.equal(result.code, 2, supervisor.output());
        assert.equal((supervisor.output().match(/já está em uso por outro programa/g) || []).length, 1, 'uma tentativa só');
        assert.match(logOf(dataDir), /não vai tentar de novo/);
        assert.equal(fs.existsSync(path.join(dataDir, 'runtime', 'supervisor.pid')), false);
    } finally {
        await new Promise(resolve => blocker.close(resolve));
    }
});

test('[UC-SAUDE-001] SIGTERM no supervisor: parada ordenada do servidor, heartbeat limpo, saída 0 e nenhum processo órfão', async () => {
    const { dataDir, supervisor } = await startSupervised('sigterm-');
    const childPid = proc.readJson(proc.heartbeatFile(dataDir)).pid;
    const result = await stopSupervisor(supervisor);
    assert.equal(result.code, 0, supervisor.output());
    const heartbeat = proc.readJson(proc.heartbeatFile(dataDir));
    assert.equal(heartbeat.clean, true);
    assert.equal(heartbeat.reason, 'stop');
    assert.equal(proc.processAlive(childPid), false, 'o servidor não ficou órfão');
    assert.equal(fs.existsSync(path.join(dataDir, 'runtime', 'supervisor.pid')), false);
});

test('[UC-SAUDE-001] exceção não tratada sob o supervisor: o servidor grava, sai com 1 e volta', async () => {
    const { dataDir, supervisor, health } = await startSupervised('crash-', { ICLASS_TEST_ALLOW_CRASH: '1' });
    try {
        const crash = await proc.call(supervisor.base, '/api/test/crash', { method: 'POST', body: {} });
        assert.equal(crash.status, 202);
        const back = await waitForNewInstance(supervisor.base, health.body.instanceId, { exited: supervisor.exited });
        assert.equal(back.body.status, 'ok');
        assert.match(logOf(dataDir), /🔁 O servidor parou \(código 1\)\. Reiniciando em 1 s…/);
        assert.match(fs.readFileSync(path.join(dataDir, 'crash.log'), 'utf8'), /uncaughtException[\s\S]*Falha simulada/);
        // Saída depois do erro fatal: heartbeat limpo com reason 'fatal' (o próximo boot
        // retoma as sessões e conta como queda).
        assert.match(logOf(dataDir), /gravando o que for possível/);
    } finally {
        assert.equal((await stopSupervisor(supervisor)).code, 0);
    }
});
