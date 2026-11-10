// Saúde do servidor e processo (H3c: CONF-12, OPS-06, OPS-07). Antes: /api/health dava
// 404 (e /health devolvia 200 com o HTML do app); com a porta ocupada o servidor imprimia
// "iniciado com sucesso" e saía com 0, sem nada no crash.log; o build desatualizado saía
// como "Falha ao inicializar o banco de dados SQLite"; quem chegava durante o boot levava
// conexão recusada; o desligamento só existia no SIGINT/SIGTERM, e o Reiniciar saía sem
// db.close. A primeira parte sobe o app pelo createApp (supertest); a segunda sobe o
// servidor de verdade num processo próprio (fixtures/server-main-child.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-server-health-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp, createBootApp, createSwitchableHandler, describeBootFailure } = require('../../backend/server.js');
const serverLifecycle = require('../../backend/utils/serverLifecycle.js');
const { readLastCrash, logError } = require('../../backend/utils/errorLog.js');
const { resolveAdminApiPermission } = require('../../backend/utils/adminPermissions.js');
const { SERVER_INSTANCE_ID } = require('../../backend/utils/sessionConfig.js');
const proc = require('./fixtures/server-process.js');

const REPO = path.resolve(__dirname, '..', '..');
const childScript = path.join(__dirname, 'fixtures', 'server-main-child.js');

let app;

test.before(async () => {
    await db.init();
    app = createApp();
    await request(app).post('/api/test/seed').send({}).expect(200);
});

test.after(async () => {
    proc.killAll();
    serverLifecycle.resetProcessState();
    await db.close().catch(() => {});
});

test.afterEach(() => {
    serverLifecycle.resetProcessState();
});

// Login do instrutor: POST /api/session/admin-login (H2-B); sem ele, o whoami com
// Authorization (o login desta versão).
async function adminToken(target, email = 'admin@teste.local', password = 'teste') {
    const login = await target.post('/api/session/admin-login').send({ email, password });
    if (login.status !== 404) {
        assert.equal(login.status, 200, JSON.stringify(login.body));
        return login.body.sessionToken;
    }
    const res = await target.get('/api/admin/whoami').set('Authorization', `${email}:${password}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.sessionToken;
}

// Mesma coisa contra um processo (fetch).
async function adminTokenOver(base, email = 'admin@teste.local', password = 'teste') {
    const login = await proc.call(base, '/api/session/admin-login', { method: 'POST', body: { email, password } });
    if (login.status !== 404) {
        assert.equal(login.status, 200, JSON.stringify(login.body));
        return login.body.sessionToken;
    }
    const res = await proc.call(base, '/api/admin/whoami', { headers: { Authorization: `${email}:${password}` } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.sessionToken;
}

test('[UC-SAUDE-001] GET /api/health responde 200 em JSON com o banco conferido, sem e-mail nem IP (CONF-12)', async () => {
    const res = await request(app).get('/api/health').expect(200);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.checks.database, 'ok');
    assert.equal(res.body.instanceId, SERVER_INSTANCE_ID);
    assert.equal(res.body.version, require('../../package.json').version);
    assert.equal(res.body.supervised, false);
    assert.ok(res.body.uptimeSeconds >= 0);
    const text = JSON.stringify(res.body);
    assert.equal(/@|\d+\.\d+\.\d+\.\d+/.test(text.replace(res.body.version, '')), false, `sem e-mail e sem IP: ${text}`);
});

test('[UC-SAUDE-001] /api/health dá 503 "degraded" com gravações falhando seguidamente ou depois de uma exceção não tratada', async () => {
    const original = db.health;
    try {
        db.health = () => ({ ...original(), consecutiveFailures: 3 });
        const failing = await request(app).get('/api/health').expect(503);
        assert.equal(failing.body.status, 'degraded');
        db.health = () => ({ ...original(), consecutiveFailures: 2 });
        await request(app).get('/api/health').expect(200);
    } finally {
        db.health = original;
    }
    serverLifecycle.markDegraded('erro de teste');
    const degraded = await request(app).get('/api/health').expect(503);
    assert.equal(degraded.body.status, 'degraded');
});

test('[UC-SAUDE-001] saúde do administrador: 401 sem login, os números do servidor com login e a entrada no catálogo RBAC', async () => {
    assert.equal(resolveAdminApiPermission('GET', '/system/health'), 'page.system');
    await request(app).get('/api/admin/system/health').expect(401);
    logError('teste-saude', new Error('Falha registrada para o cartão'), { email: 'quem@teste.local' });
    const token = await adminToken(request(app));
    const res = await request(app).get('/api/admin/system/health').set('x-admin-session', token).expect(200);
    assert.equal(res.body.status, 'ok');
    assert.ok(res.body.rssMb > 0);
    assert.ok(res.body.heapUsedMb > 0);
    assert.ok(res.body.dbFileMb >= 0);
    assert.equal(typeof res.body.save.consecutiveFailures, 'number');
    assert.deepEqual(res.body.sessionsRestored, { students: 0, admins: 0, dropped: 0 });
    assert.equal(res.body.supervised, false);
    assert.equal(res.body.restarts, 0);
    assert.equal(res.body.lastCrash.kind, 'teste-saude');
    assert.equal(res.body.lastCrash.summary.startsWith('Error: Falha registrada para o cartão'), true, JSON.stringify(res.body.lastCrash));
    assert.equal(JSON.stringify(res.body.lastCrash).includes('quem@teste.local'), false, 'a última falha não leva o e-mail do pedido');
    // Professor sem page.system não vê.
    const professor = await adminToken(request(app), 'professor@teste.local', 'teste');
    await request(app).get('/api/admin/system/health').set('x-admin-session', professor).expect(403);
});

test('[UC-SAUDE-001] a última queda durante prova aparece no cartão com a prova e a turma', async () => {
    const application = { id: 'app-saude', examKey: 'Prova_Saude', studentClass: 'T-Saude', courseId: 'c-saude', status: 'finished', outages: [
        { from: 1000, to: 5000, durationMs: 4000, reason: 'crash', compensated: true },
        { from: 9000, to: 20000, durationMs: 11000, reason: 'restart', compensated: true },
    ] };
    db.memory.examApplications.push(application);
    try {
        const token = await adminToken(request(app));
        const res = await request(app).get('/api/admin/system/health').set('x-admin-session', token).expect(200);
        assert.deepEqual(res.body.lastOutage, { from: 9000, to: 20000, durationMs: 11000, reason: 'restart', compensated: true, examKey: 'Prova_Saude', studentClass: 'T-Saude', courseId: 'c-saude' });
    } finally {
        db.memory.examApplications.splice(db.memory.examApplications.indexOf(application), 1);
    }
});

test('[UC-SAUDE-001] rota de controle: 403 sem o token do boot ou com o errado; sem o desligamento registrado, 503', async () => {
    await request(app).post('/api/system/control').send({ action: 'stop' }).expect(403);
    await request(app).post('/api/system/control').set('x-iclass-control', 'errado').send({ action: 'stop' }).expect(403);
    const token = serverLifecycle.writeControlToken();
    try {
        assert.match(token, /^[0-9a-f]{64}$/);
        if (process.platform !== 'win32') assert.equal(fs.statSync(serverLifecycle.controlTokenFile()).mode & 0o777, 0o600);
        await request(app).post('/api/system/control').set('x-iclass-control', token.slice(0, 63) + 'x').send({ action: 'stop' }).expect(403);
        await request(app).post('/api/system/control').set('x-iclass-control', token).send({ action: 'apagar' }).expect(400);
        await request(app).post('/api/system/control').set('x-iclass-control', token).send({ action: { toString: 1 } }).expect(400);
        await request(app).post('/api/system/control').set('x-iclass-control', token).send({ action: 'stop' }).expect(503);
        const calls = [];
        serverLifecycle.setShutdownHandler(options => { calls.push(options); });
        await request(app).post('/api/system/control').set('x-iclass-control', token).send({ action: 'restart' }).expect(202);
        await proc.sleep(30);
        assert.deepEqual(calls, [{ restart: true, reason: 'restart' }]);
    } finally {
        serverLifecycle.removeControlToken();
    }
});

test('[UC-MANUT-001] Reiniciar chama o desligamento ordenado com admin_restart; sem ele registrado responde 503 e nada acontece', async () => {
    const token = await adminToken(request(app));
    await request(app).post('/api/admin/server/restart').set('x-admin-session', token).send({}).expect(400);
    const unavailable = await request(app).post('/api/admin/server/restart').set('x-admin-session', token).send({ confirm: 'REINICIAR' }).expect(503);
    assert.equal(unavailable.body.error, 'Reinício indisponível neste modo.');
    const calls = [];
    serverLifecycle.setShutdownHandler(options => { calls.push(options); });
    const res = await request(app).post('/api/admin/server/restart').set('x-admin-session', token).send({ confirm: 'REINICIAR' }).expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.supervised, false);
    await proc.sleep(30);
    assert.deepEqual(calls, [{ restart: true, reason: 'admin_restart' }]);
    // Idempotente: o segundo pedido não chama de novo.
    assert.equal(serverLifecycle.requestShutdown({ reason: 'stop' }), serverLifecycle.requestShutdown({ reason: 'stop' }));
    assert.equal(calls.length, 1);
});

test('[UC-SAUDE-001] timers do servidor: registro com unref, o mesmo nome substitui, clearTimers para todos; sem handler requestShutdown devolve false', () => {
    assert.equal(serverLifecycle.requestShutdown({ reason: 'stop' }), false);
    let ran = 0;
    const first = serverLifecycle.registerTimer('teste-a', setInterval(() => { ran += 1; }, 1000));
    assert.equal(first.hasRef(), false, 'unref');
    const replaced = serverLifecycle.registerTimer('teste-a', setInterval(() => { ran += 1; }, 1000));
    assert.notEqual(first, replaced);
    serverLifecycle.registerTimer('teste-b', setInterval(() => { ran += 1; }, 1000));
    assert.ok(serverLifecycle.registeredTimers().includes('teste-a'));
    const cleared = serverLifecycle.clearTimers();
    assert.ok(cleared.includes('teste-a') && cleared.includes('teste-b'));
    assert.deepEqual(serverLifecycle.registeredTimers(), []);
});

test('[UC-SAUDE-001] todo setInterval do servidor passa por serverLifecycle.registerTimer (contrato de processo)', () => {
    const offenders = [];
    const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).forEach(entry => {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) return walk(full);
        if (!entry.name.endsWith('.js') || entry.name === 'supervisor.js') return;
        fs.readFileSync(full, 'utf8').split('\n').forEach((line, index) => {
            if (/\bsetInterval\(/.test(line) && !/registerTimer\(/.test(line) && !/^\s*\/\//.test(line)) offenders.push(`${path.relative(REPO, full)}:${index + 1}`);
        });
    });
    walk(path.join(REPO, 'backend'));
    assert.deepEqual(offenders, []);
    // E os do servidor estão lá depois de carregar as rotas.
    require('../../backend/routes/student.js');
    require('../../backend/utils/rateLimit.js');
});

test('[UC-SAUDE-001] cada falha de boot diz a causa certa com o código de saída próprio (OPS-07)', () => {
    const outdated = Object.assign(new Error('Build do frontend desatualizado. Execute npm run build novamente.'), { code: 'ICLASS_BUILD_OUTDATED' });
    const build = describeBootFailure('build', outdated);
    assert.equal(build.exitCode, 2);
    assert.match(build.message, /desatualizado/);
    assert.match(build.message, /opção \[4\] do launcher/);
    assert.equal(/banco de dados/i.test(build.message), false, 'build desatualizado não é falha do banco');
    const missing = describeBootFailure('build', Object.assign(new Error('ausente'), { code: 'ICLASS_BUILD_MISSING' }));
    assert.equal(missing.exitCode, 2);
    assert.match(missing.message, /não está compilado/);
    const busy = describeBootFailure('listen', Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }), { port: 3000 });
    assert.equal(busy.exitCode, 2);
    assert.match(busy.message, /A porta 3000 já está em uso por outro programa/);
    const corrupt = describeBootFailure('database', Object.assign(new Error('file is not a database'), { code: 'SQLITE_NOTADB', bootStage: 'database' }));
    assert.equal(corrupt.exitCode, 3);
    assert.match(corrupt.message, /danificado/);
    assert.match(corrupt.message, /backup-cli\.js/);
    assert.equal(describeBootFailure('database', Object.assign(new Error('x'), { code: 'ICLASS_DB_CORRUPT' })).exitCode, 3);
    const locked = describeBootFailure('database', Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY', bootStage: 'database' }));
    assert.equal(locked.exitCode, 1, 'falha passageira do banco: o supervisor tenta de novo');
    assert.match(locked.message, /Não foi possível abrir o banco de dados/);
    assert.equal(serverLifecycle.EXIT_CODES.RESTART, 75);
});

test('[UC-SAUDE-001] handler de boot: /api/health "starting" com a fase, /api 503 {starting:true} com Retry-After 3, página "iniciando" e /assets sem o HTML', async () => {
    const boot = createBootApp();
    serverLifecycle.setBootPhase('restoring');
    const health = await request(boot).get('/api/health').expect(503);
    assert.equal(health.body.status, 'starting');
    // Mesmo formato de estado do resto do /api no boot (J2): starting:true e Retry-After 3.
    assert.equal(health.body.starting, true);
    assert.equal(health.headers['retry-after'], '3');
    assert.equal(health.body.phase, 'restoring');
    assert.equal(health.body.instanceId, SERVER_INSTANCE_ID);
    const ping = await request(boot).get('/api/ping').expect(503);
    assert.deepEqual(ping.body, { error: 'O IClass está iniciando. Aguarde alguns segundos.', starting: true });
    assert.equal(ping.headers['retry-after'], '3');
    assert.ok(ping.headers['x-request-id']);
    const page = await request(boot).get('/aluno/prova').expect(503);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.text, /O IClass está iniciando/);
    assert.match(page.text, /http-equiv="refresh" content="3"/);
    const asset = await request(boot).get('/assets/nao-existe-123.js');
    assert.equal(asset.status, 404);
    assert.equal(/iniciando/.test(asset.text), false, '/assets nunca recebe o HTML');
    // Handler trocável: o mesmo servidor http passa do boot ao app.
    const handler = createSwitchableHandler(boot);
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        assert.equal((await proc.call(base, '/api/health')).status, 503);
        handler.set(app);
        assert.equal(handler.current(), app);
        assert.equal((await proc.call(base, '/api/health')).status, 200);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('[UC-SAUDE-001] readLastCrash lê só o fim do crash.log e devolve o último bloco', () => {
    const file = path.join(tempRoot, 'crash-teste.log');
    fs.writeFileSync(file, `${'x'.repeat(100 * 1024)}\n[2026-11-01T10:00:00.000Z] antigo\nError: velho\n\n[2026-11-02T11:00:00.000Z] uncaughtException\nError: o mais novo\n    at algum lugar\n`);
    assert.deepEqual(readLastCrash({ file }), { at: '2026-11-02T11:00:00.000Z', kind: 'uncaughtException', summary: 'Error: o mais novo' });
    assert.equal(readLastCrash({ file: path.join(tempRoot, 'nao-existe.log') }), null);
});

test('[UC-SAUDE-001] a última falha e o "com problemas" do cartão não levam e-mail que veio na mensagem do erro', async () => {
    // Antes o resumo era a primeira linha da mensagem como estava: "falha ao gravar aluno
    // joana@escola.com" chegava inteira a qualquer conta com page.system.
    const file = path.join(tempRoot, 'crash-email.log');
    fs.writeFileSync(file, '\n[2026-11-03T09:00:00.000Z] uncaughtException\nError: falha ao gravar aluno joana@escola.com (de <prof.ana@escola.com.br>)\n    at x\n');
    assert.deepEqual(readLastCrash({ file }), { at: '2026-11-03T09:00:00.000Z', kind: 'uncaughtException', summary: 'Error: falha ao gravar aluno [e-mail] (de <[e-mail]>)' });
    logError('teste-email', new Error('falha ao gravar aluno joana@escola.com'), { email: 'quem@teste.local' });
    serverLifecycle.markDegraded('Erro: aluno pedro@escola.com sumiu');
    try {
        const token = await adminToken(request(app));
        const res = await request(app).get('/api/admin/system/health').set('x-admin-session', token).expect(200);
        const text = JSON.stringify(res.body);
        assert.equal(res.body.lastCrash.summary, 'Error: falha ao gravar aluno [e-mail]');
        assert.equal(res.body.degraded.reason, 'Erro: aluno [e-mail] sumiu');
        for (const email of ['joana@escola.com', 'pedro@escola.com', 'quem@teste.local']) assert.equal(text.includes(email), false, email);
    } finally {
        serverLifecycle.resetProcessState();
    }
});

// ---------------------------------------------------------------------------
// O servidor de verdade num processo próprio.
// ---------------------------------------------------------------------------

function newDataDir(prefix) {
    return fs.mkdtempSync(path.join(tempRoot, prefix));
}

test('[UC-SAUDE-001] porta ocupada: sai com 2, sem "iniciado com sucesso", com "listen" no crash.log e sem tocar no banco (OPS-07)', async () => {
    const dataDir = newDataDir('porta-');
    const blocker = http.createServer((req, res) => res.end('outro programa'));
    const port = await proc.freePort();
    await new Promise(resolve => blocker.listen(port, '127.0.0.1', resolve));
    try {
        const server = proc.launch(childScript, { dataDir, port });
        const result = await server.exited;
        assert.equal(result.code, 2, server.output());
        assert.equal(/iniciado com sucesso/.test(server.output()), false);
        assert.match(server.output(), new RegExp(`A porta ${port} já está em uso por outro programa`));
        assert.match(fs.readFileSync(path.join(dataDir, 'crash.log'), 'utf8'), /\] listen$/m);
        // A porta é conferida antes de ler o banco: nenhuma tabela criada nem heartbeat
        // (o sqlite3 só cria o arquivo vazio ao carregar o módulo).
        const dbFile = path.join(dataDir, 'database.db');
        assert.equal(fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0, 0);
        assert.equal(fs.existsSync(proc.heartbeatFile(dataDir)), false);
    } finally {
        await new Promise(resolve => blocker.close(resolve));
    }
});

test('[UC-SAUDE-001] build desatualizado: sai com 2 dizendo que é o build, não o banco', async () => {
    const dataDir = newDataDir('build-');
    const server = proc.launch(childScript, { dataDir, port: await proc.freePort(), env: { ICLASS_TEST_BUILD: 'outdated' } });
    const result = await server.exited;
    assert.equal(result.code, 2, server.output());
    assert.match(server.output(), /O site do IClass está desatualizado/);
    assert.match(server.output(), /opção \[4\] do launcher/);
    assert.equal(/Falha ao inicializar o banco de dados SQLite/.test(server.output()), false);
});

test('[UC-SAUDE-001] banco que não é SQLite sai com 3 citando o backup-cli; pasta no lugar do arquivo sai com 1', async () => {
    const corruptDir = newDataDir('corrompido-');
    fs.writeFileSync(path.join(corruptDir, 'database.db'), 'isto não é um banco SQLite '.repeat(200));
    const corrupt = proc.launch(childScript, { dataDir: corruptDir, port: await proc.freePort() });
    const corruptExit = await corrupt.exited;
    assert.equal(corruptExit.code, 3, corrupt.output());
    assert.match(corrupt.output(), /está danificado/);
    assert.match(corrupt.output(), /backup-cli\.js/);
    assert.equal(/iniciado com sucesso/.test(corrupt.output()), false);
    // O token da rota de controle é gravado logo depois de a porta abrir: a falha do boot
    // não o deixa no disco (o launcher leria o token de um servidor que não está no ar).
    assert.equal(fs.existsSync(proc.controlTokenFile(corruptDir)), false, 'sem control.token depois da falha de boot');

    const folderDir = newDataDir('pasta-');
    fs.mkdirSync(path.join(folderDir, 'database.db'));
    const folder = proc.launch(childScript, { dataDir: folderDir, port: await proc.freePort() });
    const folderExit = await folder.exited;
    assert.equal(folderExit.code, 1, folder.output());
    assert.match(folder.output(), /Não foi possível abrir o banco de dados/);
    assert.equal(fs.existsSync(proc.controlTokenFile(folderDir)), false, 'sem control.token depois da falha de boot');
});

test('[UC-SAUDE-001] desligar durante o boot sai com 0 sem gravar e sem marcar parada limpa (o heartbeat do boot fica clean:false)', async () => {
    const dataDir = newDataDir('boot-sigterm-');
    const server = proc.launch(childScript, { dataDir, port: await proc.freePort(), env: { ICLASS_TEST_BOOT_DELAY_MS: '20000' } });
    await proc.waitForHealth(server.base, { accept: res => res.status === 503 && res.body && res.body.status === 'starting', exited: server.exited });
    // O heartbeat deste boot já começou (o atraso de teste vem depois do prepareServer).
    await proc.waitFor(() => proc.readJson(proc.heartbeatFile(dataDir)), { what: 'heartbeat do boot' });
    server.child.kill('SIGTERM');
    const result = await server.exited;
    assert.equal(result.code, 0, server.output());
    const heartbeat = proc.readJson(proc.heartbeatFile(dataDir));
    assert.equal(heartbeat.clean, false, `parada no boot não é parada limpa: ${JSON.stringify(heartbeat)}`);
    assert.equal(heartbeat.reason || null, null);
    assert.match(server.output(), /Desligando antes de terminar de iniciar: nada a gravar\./);
    assert.equal(/gravando os dados/.test(server.output()), false, 'não promete gravar o que não grava');
    assert.equal(fs.existsSync(proc.controlTokenFile(dataDir)), false);
});

test('[UC-SAUDE-001] rota de controle também durante o boot: 403 sem o token, 202 com ele (starting:true) e saída 0 sem esperar o boot', async () => {
    const dataDir = newDataDir('boot-controle-');
    const server = proc.launch(childScript, { dataDir, port: await proc.freePort(), env: { ICLASS_TEST_BOOT_DELAY_MS: '20000' } });
    await proc.waitForHealth(server.base, { accept: res => res.status === 503 && res.body && res.body.status === 'starting', exited: server.exited });
    await proc.waitFor(() => proc.readJson(proc.heartbeatFile(dataDir)), { what: 'heartbeat do boot' });
    const token = fs.readFileSync(proc.controlTokenFile(dataDir), 'utf8').trim();
    const denied = await proc.call(server.base, '/api/system/control', { method: 'POST', headers: { 'x-iclass-control': 'b'.repeat(64) }, body: { action: 'stop' } });
    assert.equal(denied.status, 403);
    const invalid = await proc.call(server.base, '/api/system/control', { method: 'POST', headers: { 'x-iclass-control': token }, body: { action: 'desligar' } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.field, 'action');
    // O resto da API continua "iniciando".
    assert.equal((await proc.call(server.base, '/api/ping')).status, 503);
    const startedAt = Date.now();
    const accepted = await proc.call(server.base, '/api/system/control', { method: 'POST', headers: { 'x-iclass-control': token }, body: { action: 'stop' } });
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    assert.equal(accepted.body.starting, true);
    const result = await server.exited;
    assert.equal(result.code, 0, server.output());
    assert.ok(Date.now() - startedAt < 10000, 'não esperou o fim do boot');
    assert.equal(proc.readJson(proc.heartbeatFile(dataDir)).clean, false);
    assert.equal(fs.existsSync(proc.controlTokenFile(dataDir)), false);
});

test('[UC-SAUDE-001] durante o boot a porta já responde "iniciando" (health 503 starting, API 503 starting) e depois 200', async () => {
    const dataDir = newDataDir('boot-');
    const server = proc.launch(childScript, { dataDir, port: await proc.freePort(), env: { ICLASS_TEST_BOOT_DELAY_MS: '3000' } });
    const starting = await proc.waitForHealth(server.base, { accept: res => res.status === 503, exited: server.exited });
    assert.equal(starting.body.status, 'starting');
    assert.ok(['loading', 'restoring', 'checking'].includes(starting.body.phase), starting.body.phase);
    const ping = await proc.call(server.base, '/api/ping');
    assert.equal(ping.status, 503);
    assert.equal(ping.body.starting, true);
    assert.equal(ping.headers.get('retry-after'), '3');
    assert.equal(/iniciado com sucesso/.test(server.output()), false, 'o banner só sai quando o servidor fica pronto');
    const ready = await proc.waitForHealth(server.base, { exited: server.exited });
    assert.equal(ready.body.status, 'ok');
    assert.equal(ready.body.instanceId, starting.body.instanceId);
    assert.match(server.output(), /iniciado com sucesso/);
    server.child.kill('SIGTERM');
    assert.equal((await server.exited).code, 0);
});

test('[UC-SAUDE-001] rota de controle do launcher: 403 sem o token, 202 com o token de runtime/control.token; sai com 0, heartbeat limpo e token apagado', async () => {
    const dataDir = newDataDir('controle-');
    const server = proc.launch(childScript, { dataDir, port: await proc.freePort() });
    await proc.waitForHealth(server.base, { exited: server.exited });
    const token = fs.readFileSync(proc.controlTokenFile(dataDir), 'utf8').trim();
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal((await proc.call(server.base, '/api/system/control', { method: 'POST', body: { action: 'stop' } })).status, 403);
    assert.equal((await proc.call(server.base, '/api/system/control', { method: 'POST', headers: { 'x-iclass-control': 'a'.repeat(64) }, body: { action: 'stop' } })).status, 403);
    const accepted = await proc.call(server.base, '/api/system/control', { method: 'POST', headers: { 'x-iclass-control': token }, body: { action: 'stop' } });
    assert.equal(accepted.status, 202);
    const result = await server.exited;
    assert.equal(result.code, 0, server.output());
    const heartbeat = proc.readJson(proc.heartbeatFile(dataDir));
    assert.equal(heartbeat.clean, true);
    assert.equal(heartbeat.reason, 'stop');
    assert.equal(fs.existsSync(proc.controlTokenFile(dataDir)), false);
    assert.match(server.output(), /Dados gravados\. Servidor desligado\./);
});

test('[UC-SAUDE-001] SIGHUP (fechar a janela) faz o desligamento ordenado: grava, fecha o banco e marca a parada limpa', async () => {
    const dataDir = newDataDir('sighup-');
    const server = proc.launch(childScript, { dataDir, port: await proc.freePort() });
    await proc.waitForHealth(server.base, { exited: server.exited });
    const seeded = await proc.call(server.base, '/api/test/seed', { method: 'POST', body: {} });
    assert.equal(seeded.status, 200);
    server.child.kill('SIGHUP');
    const result = await server.exited;
    assert.equal(result.code, 0, server.output());
    assert.equal(proc.readJson(proc.heartbeatFile(dataDir)).clean, true);
    // db.close aplica o -wal: o arquivo principal tem tudo e o -wal some.
    assert.equal(fs.existsSync(path.join(dataDir, 'database.db-wal')), false, 'o -wal foi aplicado pelo db.close');
});
