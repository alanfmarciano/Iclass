// Reinício do servidor sem expulsar ninguém (H3a-2: CONF-03, UXA-06, DES-08). Antes, as
// sessões de aluno e de instrutor ficavam só na memória: qualquer reinício (queda,
// Reiniciar, launcher reaberto) devolvia 401 a todos, inclusive a quem estava no meio da
// prova. Agora a tabela auth_sessions guarda o hash de cada token, e o boot retoma as
// sessões quando o servidor ficou pouco tempo fora do ar (heartbeat). Estes testes sobem
// o servidor de verdade num processo próprio (fixtures/server-restart-child.js), matam
// com kill -9 e sobem de novo sobre a mesma pasta de dados. Falham no código antigo: lá
// o token do login dá 401 depois do reinício e a tabela auth_sessions não existe.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const childScript = path.join(__dirname, 'fixtures', 'server-restart-child.js');
const STUDENT = { email: 'aluno@teste.local', password: 'teste' };
const PROFESSOR = { email: 'professor@teste.local', password: 'teste' };
const MIN = 60000;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const running = new Set();

// Sobe o servidor sobre dataDir e espera a porta abrir (até 30 s).
function startServer(dataDir) {
    const env = {
        ...process.env,
        ICLASS_DATA_DIR: dataDir,
        ICLASS_CONTENT_DIR: path.join(dataDir, 'content'),
        ICLASS_ARCHIVE_DIR: path.join(dataDir, 'archives'),
        TEST_MODE: '1',
        PORT: '0',
    };
    delete env.NODE_TEST_CONTEXT;
    delete env.ICLASS_ADMIN_SETUP_MODE;
    delete env.ICLASS_ADMIN_SETUP_TOKEN;
    const child = spawn(process.execPath, [childScript], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    running.add(child);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => {
        running.delete(child);
        resolve({ code, signal });
    }));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`o servidor não abriu a porta em 30 s:\n${output}`)), 30000);
        const onData = () => {
            const match = output.match(/@@READY (\{.*\})/);
            if (!match) return;
            clearTimeout(timer);
            child.stdout.off('data', onData);
            const { port } = JSON.parse(match[1]);
            const base = `http://127.0.0.1:${port}`;
            resolve({
                base,
                output: () => output,
                exited,
                async stop(signal = 'SIGTERM') {
                    child.kill(signal);
                    return exited;
                },
            });
        };
        child.stdout.on('data', onData);
        exited.then(({ code, signal }) => {
            clearTimeout(timer);
            reject(new Error(`o servidor saiu antes de abrir a porta (código ${code}, sinal ${signal}):\n${output}`));
        });
    });
}

async function call(server, pathname, { method = 'GET', headers = {}, body } = {}) {
    const response = await fetch(server.base + pathname, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await response.json(); } catch (e) { json = null; }
    return { status: response.status, body: json };
}

async function studentLogin(server) {
    const res = await call(server, '/api/student/login', { method: 'POST', body: STUDENT });
    assert.equal(res.status, 200, `login do aluno: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.sessionToken;
}

// Login do instrutor: POST /api/session/admin-login (H2-B); sem ele, o whoami com
// Authorization (o login desta versão). Os dois emitem a sessão do mesmo jeito.
async function professorLogin(server) {
    const login = await call(server, '/api/session/admin-login', { method: 'POST', body: PROFESSOR });
    if (login.status !== 404) {
        assert.equal(login.status, 200, `login do professor: ${login.status} ${JSON.stringify(login.body)}`);
        return login.body.sessionToken;
    }
    const res = await call(server, '/api/admin/whoami', { headers: { Authorization: `${PROFESSOR.email}:${PROFESSOR.password}` } });
    assert.equal(res.status, 200, `login do professor: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.sessionToken;
}

const ping = (server, token) => call(server, `/api/ping?email=${encodeURIComponent(STUDENT.email)}`, { headers: { 'x-session-token': token } });
const whoami = (server, token) => call(server, '/api/admin/whoami', { headers: { 'x-admin-session': token } });

// Linhas de uma tabela, lidas do arquivo por outra conexão (com o servidor parado).
async function readTable(dataDir, table) {
    const connection = new sqlite3.Database(path.join(dataDir, 'database.db'));
    try {
        return await new Promise((resolve, reject) => connection.all(`SELECT key, value FROM ${table} ORDER BY key`, (err, rows) => (err ? reject(err) : resolve(rows))));
    } finally {
        await new Promise(resolve => connection.close(() => resolve()));
    }
}

async function runSql(dataDir, sql, params = []) {
    const connection = new sqlite3.Database(path.join(dataDir, 'database.db'));
    try {
        await new Promise((resolve, reject) => connection.run(sql, params, err => (err ? reject(err) : resolve())));
    } finally {
        await new Promise(resolve => connection.close(() => resolve()));
    }
}

function heartbeatFile(dataDir) {
    return path.join(dataDir, 'runtime', 'heartbeat.json');
}

// Primeiro servidor: semente do TEST_MODE, login de aluno e professor e queda (kill -9).
async function loginAndCrash(dataDir) {
    const server = await startServer(dataDir);
    const seeded = await call(server, '/api/test/seed', { method: 'POST', body: {} });
    assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
    const studentToken = await studentLogin(server);
    const professorToken = await professorLogin(server);
    assert.equal((await ping(server, studentToken)).status, 200);
    assert.equal((await whoami(server, professorToken)).status, 200);
    const exit = await server.stop('SIGKILL');
    assert.equal(exit.signal, 'SIGKILL');
    return { studentToken, professorToken };
}

test.after(() => {
    running.forEach(child => { try { child.kill('SIGKILL'); } catch (e) { /* já saiu */ } });
});

test('[UC-AUTH-001] servidor que cai (kill -9) e volta: aluno e professor seguem com o mesmo token; Sair vale depois do reinício; mais de 60 min fora do ar desloga todos', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-server-restart-'));
    try {
        const { studentToken, professorToken } = await loginAndCrash(dataDir);

        // No arquivo: uma linha por sessão, chave = sha256 do token, sem o token cru e sem
        // a presença (lastSeen), que muda a cada ping.
        const rows = await readTable(dataDir, 'auth_sessions');
        const byKey = Object.fromEntries(rows.map(row => [row.key, JSON.parse(row.value)]));
        assert.equal(rows.length, 2, JSON.stringify(rows));
        assert.equal(byKey[sha256(studentToken)].kind, 'student');
        assert.equal(byKey[sha256(studentToken)].email, STUDENT.email);
        assert.equal(byKey[sha256(professorToken)].kind, 'admin');
        assert.equal(byKey[sha256(professorToken)].email, PROFESSOR.email);
        const text = JSON.stringify(rows);
        assert.equal(text.includes(studentToken) || text.includes(professorToken), false, 'nada de token cru no arquivo');
        assert.equal(/lastSeen|lastActivityAt/.test(text), false);

        // Volta: os mesmos tokens continuam valendo (antes: 401 para todos).
        const second = await startServer(dataDir);
        assert.match(second.output(), /Sessões retomadas: 1 aluno e 1 professor \(0 descartadas\)/);
        assert.equal((await ping(second, studentToken)).status, 200, 'o aluno continua conectado');
        const me = await whoami(second, professorToken);
        assert.equal(me.status, 200, 'o professor continua conectado');
        assert.equal(me.body.email, PROFESSOR.email);
        assert.equal(me.body.sessionToken, professorToken);

        // O aluno sai (beacon de saída): a sessão sai também do arquivo, e um novo reinício
        // não a traz de volta. O professor continua.
        const left = await call(second, '/api/student/leave', { method: 'POST', headers: { 'x-session-token': studentToken }, body: { email: STUDENT.email } });
        assert.equal(left.status, 200);
        await second.stop('SIGKILL');
        const third = await startServer(dataDir);
        assert.equal((await ping(third, studentToken)).status, 401, 'quem saiu não volta com o reinício');
        assert.equal((await whoami(third, professorToken)).status, 200);
        const stopped = await third.stop('SIGTERM');
        assert.equal(stopped.code, 0);

        // Servidor desligado entre turnos (heartbeat de 61 min atrás): todos entram de novo,
        // e as sessões saem do arquivo já no boot (antes de qualquer outra gravação).
        const beat = JSON.parse(fs.readFileSync(heartbeatFile(dataDir), 'utf8'));
        assert.equal(beat.clean, true);
        fs.writeFileSync(heartbeatFile(dataDir), JSON.stringify({ ...beat, at: Date.now() - 61 * MIN }));
        const fourth = await startServer(dataDir);
        assert.match(fourth.output(), /Sessões não retomadas: o servidor ficou mais de 60 min fora do ar/);
        assert.equal((await whoami(fourth, professorToken)).status, 401);
        await fourth.stop('SIGKILL');
        assert.deepEqual(await readTable(dataDir, 'auth_sessions'), []);
    } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test('[UC-AUTH-001] gravação do próprio boot (migração) não apaga as sessões antes da retomada; sem heartbeat ninguém volta', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-server-restart-boot-'));
    try {
        const { studentToken, professorToken } = await loginAndCrash(dataDir);
        // Aluno com senha em texto: o init converte e grava antes da retomada das sessões.
        await runSql(dataDir, 'INSERT OR REPLACE INTO students (key, value) VALUES (?, ?)', [
            'migracao@teste.local',
            JSON.stringify({ name: 'Migração', email: 'migracao@teste.local', status: 'Ativo', password: 'senha-em-texto', classes: [] }),
        ]);
        const second = await startServer(dataDir);
        await second.stop('SIGKILL');
        const migrated = (await readTable(dataDir, 'students')).find(row => row.key === 'migracao@teste.local');
        assert.match(JSON.parse(migrated.value).password, /^scrypt\$/, 'o boot gravou a migração');
        const keys = (await readTable(dataDir, 'auth_sessions')).map(row => row.key).sort();
        assert.deepEqual(keys, [sha256(studentToken), sha256(professorToken)].sort(), 'as sessões continuam no arquivo');

        const third = await startServer(dataDir);
        assert.equal((await ping(third, studentToken)).status, 200);
        assert.equal((await whoami(third, professorToken)).status, 200);
        await third.stop('SIGKILL');

        // Sem heartbeat (pasta runtime apagada): o tempo fora do ar é desconhecido.
        fs.rmSync(path.join(dataDir, 'runtime'), { recursive: true, force: true });
        const fourth = await startServer(dataDir);
        assert.match(fourth.output(), /Sessões não retomadas: não há registro de quando o servidor parou/);
        assert.equal((await ping(fourth, studentToken)).status, 401);
        assert.equal((await whoami(fourth, professorToken)).status, 401);
        await fourth.stop('SIGTERM');
        assert.deepEqual(await readTable(dataDir, 'auth_sessions'), []);
    } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});
