// Resposta só depois do COMMIT (fase 2, H1-a: CONF-04, CONF-05).
// Antes, cerca de 105 gravações não eram aguardadas: a rota respondia "salvo" com o dado
// ainda na fila (com uma espera fixa de 250 ms) e um kill -9, o Reiniciar ou uma trava
// do arquivo o perdiam. Agora todo db.save() feito durante o pedido é esperado antes da
// resposta (utils/persistenceContext.js); se a gravação falha, sai 503 retryable em vez
// do "salvo". Falha que a rota trata de propósito (db.save().catch, try/catch: presença
// automática, Reiniciar) mantém a resposta da rota. Também cobre o verificador de gravação
// parcial (ICLASS_VERIFY_SAVES) e o db.save({ detached: true }), que não segura a resposta.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const express = require('express');
const request = require('supertest');
const sqlite3 = require('sqlite3');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-save-response-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';
// Trava longa vira 503 em cerca de 1 s (o padrão é 5 s).
process.env.ICLASS_DB_BUSY_TIMEOUT_MS = '1000';
// Verificador ligado também fora do node --test.
process.env.ICLASS_VERIFY_SAVES = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');

const databaseFile = path.join(tempRoot, 'database.db');
const STUDENT = { email: 'resposta@teste.local', password: 'senha-do-aluno' };
const ADMIN = { email: 'admin-resposta@teste.local', password: 'senha-do-admin' };
const WRITE_ERROR = 'Não foi possível gravar os dados agora. Tente de novo em alguns segundos.';

let app;
let studentToken;
let adminToken;

function openConnection(file = databaseFile) {
    return new sqlite3.Database(file);
}

function exec(connection, sql) {
    return new Promise((resolve, reject) => connection.exec(sql, err => (err ? reject(err) : resolve())));
}

function closeConnection(connection) {
    return new Promise(resolve => connection.close(() => resolve()));
}

async function readRow(table, key, file = databaseFile) {
    const reader = openConnection(file);
    try {
        return await new Promise((resolve, reject) => reader.get(`SELECT value FROM ${table} WHERE key = ?`, [key], (err, row) => (err ? reject(err) : resolve(row))));
    } finally {
        await closeConnection(reader);
    }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Outro programa segurando a escrita do arquivo (BEGIN IMMEDIATE).
async function holdWriteLock() {
    const connection = openConnection();
    await exec(connection, 'BEGIN IMMEDIATE');
    let released = false;
    return async () => {
        if (released) return;
        released = true;
        await exec(connection, 'COMMIT');
        await closeConnection(connection);
    };
}

async function waitFor(check, timeoutMs, label) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (await check()) return Date.now() - started;
        await wait(100);
    }
    assert.fail(`${label}: não aconteceu em ${timeoutMs} ms`);
}

test.before(async () => {
    await db.init();
    app = createApp();
    db.memory.students.push({
        name: 'Aluno da resposta',
        email: STUDENT.email,
        password: db.hashPassword(STUDENT.password),
        status: 'Ativo',
        classes: [],
    });
    db.memory.admins.push({
        name: 'Admin da resposta',
        email: ADMIN.email,
        password: db.hashPassword(ADMIN.password),
        role: 'admin',
        mustChangePassword: false,
    });
    await db.save();
    // Sessões pelas rotas de login (como o navegador faz).
    const login = await request(app).post('/api/student/login').send(STUDENT);
    assert.equal(login.status, 200, JSON.stringify(login.body));
    studentToken = login.body.sessionToken;
    const whoami = await request(app).get('/api/admin/whoami').set('Authorization', `${ADMIN.email}:${ADMIN.password}`);
    assert.equal(whoami.status, 200, JSON.stringify(whoami.body));
    adminToken = whoami.body.sessionToken;
    assert.ok(studentToken && adminToken);
});

test.after(async () => {
    db.clearSaveVerifyFailures();
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-GRAVACAO-001] notes/save só responde depois do COMMIT e a nota já está no arquivo', async () => {
    const release = await holdWriteLock();
    const releaseTimer = wait(400).then(release);
    const started = performance.now();
    const response = await request(app)
        .post('/api/student/notes/save')
        .set('x-session-token', studentToken)
        .send({ moduleKey: 'Apostila_FUTEC_1', note: 'anotação confirmada' });
    const elapsed = performance.now() - started;
    // Lido antes de qualquer outra espera: no momento da resposta a nota tem de estar lá.
    const row = await readRow('notes', STUDENT.email);
    await releaseTimer;
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { success: true });
    assert.match(response.headers['content-type'], /application\/json/);
    assert.ok(elapsed >= 350, `a resposta saiu em ${Math.round(elapsed)} ms, antes de a trava de 400 ms sair (antes do COMMIT)`);
    assert.ok(row, 'o "salvo" saiu sem a nota no arquivo');
    assert.equal(JSON.parse(row.value).Apostila_FUTEC_1, 'anotação confirmada');
});

test('[UC-GRAVACAO-001] trava longa do arquivo: 503 retryable sem pendurar e regravação depois', async () => {
    const release = await holdWriteLock();
    try {
        const started = performance.now();
        const note = await request(app)
            .post('/api/student/notes/save')
            .set('x-session-token', studentToken)
            .timeout(5000)
            .send({ moduleKey: 'Apostila_FUTEC_2', note: 'gravada depois da trava' });
        assert.equal(note.status, 503);
        assert.equal(note.body.retryable, true);
        assert.equal(note.body.error, WRITE_ERROR);
        assert.ok(performance.now() - started < 4000);

        const settings = await request(app)
            .post('/api/admin/settings')
            .set('x-admin-session', adminToken)
            .timeout(5000)
            .send({});
        assert.equal(settings.status, 503);
        assert.equal(settings.body.retryable, true);
        assert.equal(settings.body.error, WRITE_ERROR);

        const status = db.storageStatus();
        assert.equal(status.pendingRetry, true);
        assert.equal(status.lastWriteError.code, 'SQLITE_BUSY');
        // A sessão continua valendo: o 503 não derruba o aluno nem o admin.
        assert.ok(db.memory.sessions[STUDENT.email]);
    } finally {
        await release();
    }
    // Sem novo pedido: a regravação em segundo plano grava a nota pendente.
    await waitFor(() => db.storageStatus().pendingRetry === false, 9000, 'regravação em segundo plano');
    assert.equal(db.storageStatus().lastWriteError, null);
    const row = await readRow('notes', STUDENT.email);
    assert.equal(JSON.parse(row.value).Apostila_FUTEC_2, 'gravada depois da trava');
});

// Servidor de verdade num processo próprio (fixtures/save-kill-server.js), com uma
// pasta de dados só dele. Devolve { child, base, exited, output() }.
async function startFixtureServer(dataDir, args, extraEnv = {}) {
    const env = {
        ...process.env,
        ICLASS_DATA_DIR: dataDir,
        ICLASS_CONTENT_DIR: path.join(dataDir, 'content'),
        ICLASS_ARCHIVE_DIR: path.join(dataDir, 'archives'),
        TEST_MODE: '1',
    };
    delete env.NODE_TEST_CONTEXT;
    delete env.ICLASS_DB_BUSY_TIMEOUT_MS;
    Object.assign(env, extraEnv);
    const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'save-kill-server.js'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    try {
        const port = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`servidor de teste não subiu: ${output}`)), 30000);
            const check = () => {
                const match = output.match(/PORT=(\d+)/);
                if (match) {
                    clearTimeout(timer);
                    resolve(Number(match[1]));
                } else if (/FALHA=/.test(output)) {
                    clearTimeout(timer);
                    reject(new Error(output));
                }
            };
            child.stdout.on('data', check);
            check();
        });
        return { child, base: `http://127.0.0.1:${port}`, exited, output: () => output };
    } catch (err) {
        child.kill('SIGKILL');
        await exited;
        throw err;
    }
}

async function postJson(url, body, headers = {}) {
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

test('[UC-GRAVACAO-001] kill -9 logo depois do 200 não perde o que foi confirmado', async () => {
    const killDir = fs.mkdtempSync(path.join(tempRoot, 'kill-'));
    const server = await startFixtureServer(killDir, ['kill@teste.local', 'senha-kill']);
    try {
        const login = await postJson(`${server.base}/api/student/login`, { email: 'kill@teste.local', password: 'senha-kill' });
        assert.equal(login.status, 200);
        const { sessionToken } = await login.json();
        const saved = await postJson(`${server.base}/api/student/notes/save`,
            { moduleKey: 'Apostila_FUTEC_3', note: 'sobrevive ao kill -9' }, { 'x-session-token': sessionToken });
        // Mata assim que o status chega, sem ler o corpo.
        server.child.kill('SIGKILL');
        assert.equal(saved.status, 200);
        await server.exited;
    } finally {
        if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill('SIGKILL');
        await server.exited;
    }
    const row = await readRow('notes', 'kill@teste.local', path.join(killDir, 'database.db'));
    assert.ok(row, 'a nota confirmada com 200 sumiu depois do kill -9');
    assert.equal(JSON.parse(row.value).Apostila_FUTEC_3, 'sobrevive ao kill -9');
});

// Fechar o banco no Reiniciar (db.close) e os sinais SIGHUP/SIGBREAK ficam com o H3c
// (plano da fase 2, conflito H1 x H3). Aqui: o que recebeu 200 antes do Reiniciar já está
// no arquivo (o -wal é aplicado na subida seguinte), e a falha de gravação que a rota do
// Reiniciar trata de propósito não vira 503 (antes o administrador lia "Não foi possível
// gravar" e o servidor reiniciava assim mesmo).
async function adminSessionToken(server, email, password) {
    const whoami = await fetch(`${server.base}/api/admin/whoami`, { headers: { Authorization: `${email}:${password}` } });
    assert.equal(whoami.status, 200);
    return (await whoami.json()).sessionToken;
}

test('[UC-GRAVACAO-001] Reiniciar logo depois do 200 não perde o que foi confirmado', async () => {
    const restartDir = fs.mkdtempSync(path.join(tempRoot, 'reiniciar-'));
    const restartFile = path.join(restartDir, 'database.db');
    const server = await startFixtureServer(restartDir, ['reinicio@teste.local', 'senha-aluno', 'admin-reinicio@teste.local', 'senha-admin']);
    try {
        const login = await postJson(`${server.base}/api/student/login`, { email: 'reinicio@teste.local', password: 'senha-aluno' });
        const { sessionToken } = await login.json();
        assert.equal((await postJson(`${server.base}/api/student/notes/save`,
            { moduleKey: 'Apostila_FUTEC_4', note: 'salva antes do reinício' }, { 'x-session-token': sessionToken })).status, 200);
        const adminToken = await adminSessionToken(server, 'admin-reinicio@teste.local', 'senha-admin');
        const restart = await postJson(`${server.base}/api/admin/server/restart`, { confirm: 'REINICIAR' }, { 'x-admin-session': adminToken });
        assert.equal(restart.status, 200);
        const result = await Promise.race([server.exited, wait(10000).then(() => null)]);
        assert.ok(result, 'o processo não saiu depois do Reiniciar');
        assert.equal(result.code, 0);
        assert.match(server.output(), /SPAWN=/, 'o novo servidor é disparado');
    } finally {
        if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill('SIGKILL');
        await server.exited;
    }
    const row = await readRow('notes', 'reinicio@teste.local', restartFile);
    assert.equal(JSON.parse(row.value).Apostila_FUTEC_4, 'salva antes do reinício');
    const reader = openConnection(restartFile);
    const audit = await new Promise((resolve, reject) => reader.all('SELECT value FROM audit_logs', (err, rows) => (err ? reject(err) : resolve(rows))));
    const mode = await new Promise((resolve, reject) => reader.get('PRAGMA journal_mode', (err, value) => (err ? reject(err) : resolve(value))));
    await closeConnection(reader);
    assert.ok(audit.some(item => JSON.parse(item.value).type === 'server_restart_requested'), 'o registro do reinício foi gravado');
    assert.equal(String(Object.values(mode)[0]).toLowerCase(), 'wal');
});

test('[UC-GRAVACAO-001] Reiniciar com o banco travado responde "reiniciando", não o 503 de gravação', async () => {
    const restartDir = fs.mkdtempSync(path.join(tempRoot, 'reiniciar-travado-'));
    const restartFile = path.join(restartDir, 'database.db');
    const server = await startFixtureServer(restartDir, ['reinicio2@teste.local', 'senha-aluno', 'admin-reinicio2@teste.local', 'senha-admin'],
        { ICLASS_DB_BUSY_TIMEOUT_MS: '300' });
    let lock = null;
    try {
        const adminToken = await adminSessionToken(server, 'admin-reinicio2@teste.local', 'senha-admin');
        const connection = openConnection(restartFile);
        await exec(connection, 'BEGIN IMMEDIATE');
        lock = async () => { await exec(connection, 'COMMIT'); await closeConnection(connection); };
        const restart = await postJson(`${server.base}/api/admin/server/restart`, { confirm: 'REINICIAR' }, { 'x-admin-session': adminToken });
        const body = await restart.json();
        assert.equal(restart.status, 200, JSON.stringify(body));
        assert.deepEqual(body, { success: true, message: 'Servidor reiniciando...' });
        const result = await Promise.race([server.exited, wait(10000).then(() => null)]);
        assert.ok(result, 'o processo não saiu depois do Reiniciar');
        assert.equal(result.code, 0);
    } finally {
        if (lock) await lock();
        if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill('SIGKILL');
        await server.exited;
    }
});

// App mínimo com o mesmo middleware do createApp, para rotas de teste.
function verifierApp(routes) {
    const { createPersistenceContext } = require('../../backend/utils/persistenceContext.js');
    const { errorHandler } = require('../../backend/middlewares.js');
    const mini = express();
    mini.use(express.json());
    mini.use(createPersistenceContext({
        snapshot: () => db.captureSaveSnapshot(),
        onWriteFailure: (err, req, res) => errorHandler(err, req, res, () => {}),
    }));
    routes(mini);
    mini.use(errorHandler);
    return mini;
}

test('[UC-GRAVACAO-001] falha de gravação: 503 só quando a rota não a tratou', async () => {
    const uncaught = [];
    const collect = err => uncaught.push(String((err && err.message) || err));
    process.on('unhandledRejection', collect);
    const mini = verifierApp(router => {
        // Sem await nem catch (as ~105 gravações antigas): 503.
        router.post('/api/teste/sem-tratar', (req, res) => {
            db.memory.notes['sem-tratar@teste.local'] = { modulo: 'x' };
            db.save();
            res.json({ ok: true });
        });
        // Falha tratada de propósito (presença do ping, settleStudentAttempt): a resposta é da rota.
        router.post('/api/teste/catch', (req, res) => {
            db.memory.notes['catch@teste.local'] = { modulo: 'x' };
            db.save().catch(() => {});
            res.json({ ok: true, origem: 'catch' });
        });
        // try/catch em volta do await (Reiniciar): a resposta é da rota.
        router.post('/api/teste/try-catch', async (req, res) => {
            db.memory.notes['try-catch@teste.local'] = { modulo: 'x' };
            try { await db.save(); } catch (_) { /* segue */ }
            res.json({ ok: true, origem: 'try-catch' });
        });
        // await sem try: a falha sobe para o errorHandler (503).
        router.post('/api/teste/await', async (req, res) => {
            db.memory.notes['await@teste.local'] = { modulo: 'x' };
            await db.save();
            res.json({ ok: true });
        });
        // Responde antes e depois espera a gravação, que falha: a resposta adiada vira 503.
        router.post('/api/teste/responde-e-espera', async (req, res) => {
            db.memory.notes['responde@teste.local'] = { modulo: 'x' };
            const saving = db.save();
            res.json({ ok: true });
            await saving;
        });
        // Duas gravações, uma tratada e outra não: 503.
        router.post('/api/teste/misto', (req, res) => {
            db.memory.notes['misto@teste.local'] = { modulo: 'x' };
            db.save().catch(() => {});
            db.save();
            res.json({ ok: true });
        });
    });
    const release = await holdWriteLock();
    try {
        const call = route => request(mini).post(route).timeout(5000).send({});
        const results = await Promise.all([
            call('/api/teste/sem-tratar'), call('/api/teste/catch'), call('/api/teste/try-catch'),
            call('/api/teste/await'), call('/api/teste/responde-e-espera'), call('/api/teste/misto'),
        ]);
        const summary = results.map(response => [response.status, response.body.retryable === true ? 'retryable' : response.body.origem || null]);
        assert.deepEqual(summary, [
            [503, 'retryable'],
            [200, 'catch'],
            [200, 'try-catch'],
            [503, 'retryable'],
            [503, 'retryable'],
            [503, 'retryable'],
        ]);
        results.filter(response => response.status === 503).forEach(response => assert.equal(response.body.error, WRITE_ERROR));
    } finally {
        await release();
    }
    await waitFor(() => db.storageStatus().pendingRetry === false, 9000, 'regravação em segundo plano');
    // A falha tratada também volta para a fila: a nota chega ao disco sozinha.
    assert.ok(await readRow('notes', 'catch@teste.local'));
    assert.ok(await readRow('notes', 'try-catch@teste.local'));
    process.removeListener('unhandledRejection', collect);
    assert.deepEqual(uncaught, []);
});

test('[UC-GRAVACAO-001] promessa do db.save() num pedido continua uma promessa comum', async () => {
    const mini = verifierApp(router => {
        router.post('/api/teste/promessa', async (req, res) => {
            db.memory.notes['promessa@teste.local'] = { modulo: 'x' };
            const saving = db.save();
            const derived = saving.then(() => 'depois');
            let ranFinally = false;
            await saving.finally(() => { ranFinally = true; });
            res.json({ instance: saving instanceof Promise, derived: await derived, ranFinally, all: (await Promise.all([saving, db.save()])).length });
        });
    });
    const response = await request(mini).post('/api/teste/promessa').send({});
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { instance: true, derived: 'depois', ranFinally: true, all: 2 });
});

test('[UC-GRAVACAO-001] verificador acusa alteração fora da gravação parcial e grava assim mesmo', async () => {
    let releaseSlow;
    const slowGate = new Promise(resolve => { releaseSlow = resolve; });
    const mini = verifierApp(router => {
        router.post('/api/teste/parcial-esquecida', async (req, res) => {
            db.memory.notes['esquecida@teste.local'] = { modulo: req.body.texto };
            db.memory.studentExamState['esquecida@teste.local_Avaliacao_FUTEC_1'] = { status: 'em_andamento' };
            await db.save({ only: ['studentExamState'] });
            res.json({ ok: true });
        });
        router.post('/api/teste/acrescimo', async (req, res) => {
            const old = db.memory.proctoringLogs.find(log => log.id === 'verif-antigo');
            old.detail = 'alterado sem changed';
            db.memory.proctoringLogs.push({ id: 'verif-novo', type: 'focus' });
            await db.save({ only: ['proctoringLogs'] });
            res.json({ ok: true });
        });
        router.post('/api/teste/lento', async (req, res) => {
            await slowGate;
            res.json({ ok: true });
        });
    });
    try {
        db.clearSaveVerifyFailures();
        const first = await request(mini).post('/api/teste/parcial-esquecida').send({ texto: 'um' });
        assert.equal(first.status, 200);
        assert.deepEqual(db.saveVerifyFailures.map(item => [item.method, item.path, item.collection, item.key]),
            [['POST', '/api/teste/parcial-esquecida', 'notes', 'esquecida@teste.local']]);
        // O dado não se perde: a coleção esquecida entra no ciclo.
        assert.deepEqual(JSON.parse((await readRow('notes', 'esquecida@teste.local')).value), { modulo: 'um' });

        db.memory.proctoringLogs.push({ id: 'verif-antigo', type: 'blur', detail: 'original' });
        await db.save();
        db.clearSaveVerifyFailures();
        const append = await request(mini).post('/api/teste/acrescimo').send({});
        assert.equal(append.status, 200);
        assert.deepEqual(db.saveVerifyFailures.map(item => [item.collection, item.key]), [['proctoringLogs', 'verif-antigo']],
            'só a linha antiga alterada sem changed é acusada; a nova não');
        assert.equal(JSON.parse((await readRow('proctoring_logs', 'verif-antigo')).value).detail, 'alterado sem changed');
        assert.ok(await readRow('proctoring_logs', 'verif-novo'));

        // Com outro /api em andamento a verificação é pulada (ele pode mudar a memória).
        db.clearSaveVerifyFailures();
        const slow = request(mini).post('/api/teste/lento').send({}).then(response => response);
        await wait(100);
        const concurrent = await request(mini).post('/api/teste/parcial-esquecida').send({ texto: 'dois' });
        assert.equal(concurrent.status, 200);
        assert.deepEqual(db.saveVerifyFailures, []);
        releaseSlow();
        assert.equal((await slow).status, 200);
        // A gravação parcial sem verificação grava só o pedido; a completa grava o resto.
        await db.save();
        assert.deepEqual(JSON.parse((await readRow('notes', 'esquecida@teste.local')).value), { modulo: 'dois' });
    } finally {
        releaseSlow();
        db.clearSaveVerifyFailures();
    }
});

test('[UC-GRAVACAO-001] verificador sem falso positivo: completa antes da parcial, outro pedido ou tarefa de fundo no meio', async () => {
    let releaseGate;
    let gate = new Promise(resolve => { releaseGate = resolve; });
    const mini = verifierApp(router => {
        // Gravação completa e depois parcial no mesmo pedido: a completa já levou a nota.
        router.post('/api/teste/completa-e-parcial', async (req, res) => {
            db.memory.notes['completa@teste.local'] = { modulo: 'levada pela completa' };
            await db.save();
            db.memory.studentExamState['completa@teste.local_Avaliacao_FUTEC_1'] = { status: 'em_andamento' };
            await db.save({ only: ['studentExamState'] });
            res.json({ ok: true });
        });
        // Espera o teste mexer na memória (outro pedido ou tarefa de fundo) e grava parcial.
        router.post('/api/teste/espera-e-parcial', async (req, res) => {
            await gate;
            db.memory.studentExamState['espera@teste.local_Avaliacao_FUTEC_1'] = { status: 'em_andamento' };
            await db.save({ only: ['studentExamState'] });
            res.json({ ok: true });
        });
        router.post('/api/teste/outro', async (req, res) => {
            db.memory.notes['outro-pedido@teste.local'] = { modulo: 'de outro pedido' };
            await db.save();
            res.json({ ok: true });
        });
    });
    try {
        db.clearSaveVerifyFailures();
        assert.equal((await request(mini).post('/api/teste/completa-e-parcial').send({})).status, 200);
        assert.deepEqual(db.saveVerifyFailures, []);

        // Outro pedido começa e termina no meio: a alteração dele não é acusada.
        const waiting = request(mini).post('/api/teste/espera-e-parcial').send({}).then(response => response);
        await wait(100);
        assert.equal((await request(mini).post('/api/teste/outro').send({})).status, 200);
        releaseGate();
        assert.equal((await waiting).status, 200);
        assert.deepEqual(db.saveVerifyFailures, []);

        // Tarefa de fundo (fora de pedido, como a entrega automática do fim do tempo) muda
        // a memória e grava no meio: também não é acusada.
        gate = new Promise(resolve => { releaseGate = resolve; });
        const waitingAgain = request(mini).post('/api/teste/espera-e-parcial').send({}).then(response => response);
        await wait(100);
        db.memory.notes['tarefa-de-fundo@teste.local'] = { modulo: 'timer' };
        db.save({ detached: true });
        releaseGate();
        assert.equal((await waitingAgain).status, 200);
        assert.deepEqual(db.saveVerifyFailures, []);
        await db.flush();
        assert.ok(await readRow('notes', 'tarefa-de-fundo@teste.local'));
        assert.ok(await readRow('notes', 'completa@teste.local'));
    } finally {
        releaseGate();
        db.clearSaveVerifyFailures();
    }
});

test('[UC-GRAVACAO-001] save com detached não segura a resposta', async () => {
    const mini = verifierApp(router => {
        router.post('/api/teste/desligado', (req, res) => {
            db.memory.notes['desligado@teste.local'] = { modulo: 'presença automática' };
            db.save({ detached: true });
            res.json({ ok: true });
        });
    });
    const release = await holdWriteLock();
    const releaseTimer = wait(600).then(release);
    try {
        const started = performance.now();
        const response = await request(mini).post('/api/teste/desligado').send({});
        const elapsed = performance.now() - started;
        assert.equal(response.status, 200);
        assert.ok(elapsed < 400, `a resposta esperou ${Math.round(elapsed)} ms por uma gravação desligada do pedido`);
        assert.equal(await readRow('notes', 'desligado@teste.local'), undefined);
    } finally {
        await releaseTimer;
    }
    await db.flush();
    assert.ok(await readRow('notes', 'desligado@teste.local'));
});

test('[UC-GRAVACAO-001] writeJSON devolve a gravação', async () => {
    const { writeJSON } = require('../../backend/middlewares.js');
    const result = writeJSON(path.join(tempRoot, 'config.json'), db.memory.config);
    assert.ok(result && typeof result.then === 'function', 'writeJSON tem de devolver a promessa do db.save()');
    await result;
});
