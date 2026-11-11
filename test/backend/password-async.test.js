// Senhas sem parar o servidor (H2-B, DES-07). Antes, o login do aluno e do instrutor, o
// cadastro e as rotas de senha chamavam crypto.scryptSync: cada senha travava a única
// thread do servidor por cerca de 50 ms, e 40 alunos entrando juntos paravam tudo por
// quase 2 s. Agora as rotas usam hashPasswordAsync/verifyPasswordAsync (pool de threads
// da libuv). Os testes trocam crypto.scryptSync por uma função que falha: no código
// antigo as rotas respondiam 500 (ou 401); agora seguem funcionando.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-password-async-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { attemptPasswordLogin } = require('../../backend/utils/passwordLogin.js');
const { createAdminSession } = require('../../backend/utils/authSessions.js');

const ADMIN = { email: 'adm@senhas.local', password: 'senha-adm' };
const ANA = { email: 'ana@senhas.local', password: 'senha-ana' };
const LEGACY_SALT = 'senai_salt_4.0_!@#';
const legacySha = value => crypto.createHash('sha256').update(value + LEGACY_SALT).digest('hex');
const scryptSha256 = value => {
    const salt = crypto.randomBytes(16);
    return `scrypt-sha256$${salt.toString('base64')}$${crypto.scryptSync(legacySha(value), salt, 64).toString('base64')}`;
};
let app;

function seed() {
    db.memory.config = { ...(db.memory.config || {}), settings: {} };
    db.memory.admins = [
        { email: ADMIN.email, name: 'Admin', role: 'admin', password: db.hashPassword(ADMIN.password) },
    ];
    db.memory.students = [
        { name: 'Ana', email: ANA.email, status: 'Ativo', password: db.hashPassword(ANA.password), classes: [] },
    ];
    db.memory.sessions = {};
    db.memory.adminSessions = {};
    db.memory.classes = [{ name: '1DES', courseId: 'DES', status: 'active', registrationEnabled: true }];
    db.memory.courses = [{ id: 'DES', name: 'Desenvolvimento' }];
    db.memory.enrollmentRequests = [];
    db.memory.loginLogs = [];
    db.memory.auditLogs = [];
}

// Troca crypto.scryptSync por uma função que falha enquanto `run` executa.
async function withoutSyncScrypt(run) {
    const original = crypto.scryptSync;
    let calls = 0;
    crypto.scryptSync = () => { calls += 1; throw new Error('scryptSync numa rota'); };
    try { return await run(); } finally {
        crypto.scryptSync = original;
        assert.equal(calls, 0, 'nenhuma rota chama crypto.scryptSync');
    }
}

async function adminSession() {
    const res = await request(app).post('/api/session/admin-login').send(ADMIN);
    assert.equal(res.status, 200, `login do instrutor: ${res.status} ${res.body && res.body.error}`);
    return res.body.sessionToken;
}

test.before(async () => { await db.init(); app = createApp(); });
test.beforeEach(() => { seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1000));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-AUTH-001] hashPasswordAsync grava scrypt$ e verifyPasswordAsync confere todos os formatos guardados', async () => {
    const hashed = await db.hashPasswordAsync('Segredo 1');
    assert.match(hashed, /^scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.equal(db.verifyPassword(hashed, 'Segredo 1'), true, 'o formato é o mesmo do hashPassword');
    assert.equal(await db.verifyPasswordAsync(db.hashPassword('Segredo 1'), 'Segredo 1'), true);
    assert.notEqual(await db.hashPasswordAsync('Segredo 1'), hashed, 'sal novo a cada hash');
    assert.equal(await db.hashPasswordAsync(''), '');

    const cases = [
        ['scrypt$', hashed],
        ['scrypt-sha256$ (H5a)', scryptSha256('Segredo 1')],
        ['SHA-256 legado', legacySha('Segredo 1')],
        ['texto puro', 'Segredo 1'],
    ];
    for (const [label, stored] of cases) {
        assert.equal(await db.verifyPasswordAsync(stored, 'Segredo 1'), true, `${label}: senha certa`);
        assert.equal(await db.verifyPasswordAsync(stored, 'Segredo 2'), false, `${label}: senha errada`);
        assert.equal(await db.verifyPasswordAsync(stored, 'Segredo 1'), db.verifyPassword(stored, 'Segredo 1'), `${label}: igual à versão síncrona`);
    }
    for (const stored of ['', null, undefined, 'scrypt$', 'scrypt$abc', 'scrypt$$', 'scrypt-sha256$x']) {
        assert.equal(await db.verifyPasswordAsync(stored, 'qualquer'), false, `valor guardado ${JSON.stringify(stored)} nunca confere`);
    }
    assert.equal(await db.verifyPasswordAsync(hashed, null), false);
    assert.equal(await db.verifyPasswordAsync(hashed, undefined), false);
});

test('[UC-AUTH-001] login do aluno e do instrutor não usam crypto.scryptSync (DES-07)', async () => {
    await withoutSyncScrypt(async () => {
        const student = await request(app).post('/api/student/login').send(ANA);
        assert.equal(student.status, 200, `aluno: ${student.status} ${student.body && student.body.error}`);
        assert.ok(student.body.sessionToken);
        const admin = await request(app).post('/api/session/admin-login').send(ADMIN);
        assert.equal(admin.status, 200, `instrutor: ${admin.status} ${admin.body && admin.body.error}`);
        assert.ok(admin.body.sessionToken);
        // Senha errada também passa pelo caminho assíncrono.
        assert.equal((await request(app).post('/api/student/login').send({ ...ANA, password: 'errada' })).status, 401);
        assert.equal((await request(app).post('/api/session/admin-login').send({ ...ADMIN, password: 'errada' })).status, 401);
    });
});

test('[UC-AUTH-001] vinte logins juntos não param o servidor (o laço de eventos segue girando)', async () => {
    const students = Array.from({ length: 20 }, (_, i) => ({ name: `Aluno ${i}`, email: `a${i}@senhas.local`, status: 'Ativo', password: db.hashPassword('senha-' + i), classes: [] }));
    db.memory.students.push(...students);
    // Quanto um scrypt síncrono para a thread nesta máquina (~50 ms num computador comum).
    const startedSync = process.hrtime.bigint();
    crypto.scryptSync('medida', crypto.randomBytes(16), 64);
    const syncMs = Number(process.hrtime.bigint() - startedSync) / 1e6;
    await withoutSyncScrypt(async () => {
        // Maior intervalo entre dois giros do laço de eventos durante os logins. Com o
        // scrypt síncrono, cada login segurava a thread pelo tempo inteiro de um scrypt.
        let maxGap = 0;
        let last = process.hrtime.bigint();
        const ticker = setInterval(() => {
            const now = process.hrtime.bigint();
            maxGap = Math.max(maxGap, Number(now - last) / 1e6);
            last = now;
        }, 1);
        // Sonda: quando os vinte logins já esperam a senha, um GET /api/session/status
        // (que passa pelo fs.stat do express.static, no pool de threads) precisa voltar
        // antes de a rajada terminar. Sem a fila do scrypt, o fs.stat ia para o fim da
        // fila do pool, atrás das vinte senhas, e a sonda só voltava no fim.
        const original = db.verifyPasswordAsync;
        let started = 0;
        let finished = 0;
        let probe = null;
        db.verifyPasswordAsync = async (stored, password) => {
            started += 1;
            if (started === students.length) {
                probe = request(app).get('/api/session/status').then(res => ({ status: res.status, finishedBefore: finished }));
            }
            try { return await original(stored, password); } finally { finished += 1; }
        };
        let probeResult;
        try {
            const results = await Promise.all(students.map((s, i) => request(app).post('/api/student/login').send({ email: s.email, password: 'senha-' + i })));
            results.forEach((res, i) => assert.equal(res.status, 200, `aluno ${i}: ${res.status}`));
            probeResult = await probe;
        } finally {
            clearInterval(ticker);
            db.verifyPasswordAsync = original;
        }
        // Síncrono: as vinte senhas seguidas, sem o laço girar (~20 scrypts, ~800 ms).
        // Assíncrono: no máximo o custo de montar os pedidos (dezenas de ms). A margem
        // de seis scrypts separa os dois sem depender da velocidade da máquina.
        assert.ok(maxGap < Math.max(syncMs * 6, 150), `maior parada do servidor ${maxGap.toFixed(1)} ms (um scrypt síncrono: ${syncMs.toFixed(1)} ms)`);
        assert.ok(probeResult, 'a sonda foi enviada com os vinte logins esperando a senha');
        assert.equal(probeResult.status, 200);
        assert.ok(probeResult.finishedBefore < students.length / 2,
            `a sonda voltou depois de ${probeResult.finishedBefore} das ${students.length} senhas (sem a fila, só no fim da rajada)`);
    });
});

test('[UC-AUTH-001] a fila do scrypt deixa o pool de threads livre para o banco e os arquivos (DES-07)', async () => {
    const { concurrency } = db.passwordHashQueueStatus();
    assert.ok(concurrency >= 1, 'pelo menos uma senha por vez');
    const original = crypto.scrypt;
    let inFlight = 0;
    let peak = 0;
    crypto.scrypt = (...args) => {
        const callback = args.pop();
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        return original(...args, (err, derived) => { inFlight -= 1; callback(err, derived); });
    };
    try {
        let finished = 0;
        const hashes = Array.from({ length: 20 }, (_, i) => db.hashPasswordAsync('rajada-' + i).then(value => { finished += 1; return value; }));
        assert.equal(db.passwordHashQueueStatus().running, Math.min(concurrency, 20));
        assert.equal(db.passwordHashQueueStatus().waiting, 20 - Math.min(concurrency, 20));
        // Um pedido de arquivo (como o fs.stat do express.static ou o COMMIT do sqlite3)
        // feito no meio da rajada é atendido logo, sem esperar as vinte senhas.
        await fs.promises.stat(tempRoot);
        const finishedAtStat = finished;
        const values = await Promise.all(hashes);
        assert.ok(finishedAtStat < 10, `o fs.stat esperou ${finishedAtStat} das 20 senhas (sem a fila, quase todas)`);
        assert.ok(peak <= concurrency, `no máximo ${concurrency} scrypts ao mesmo tempo (houve ${peak})`);
        for (let i = 0; i < values.length; i += 1) {
            assert.equal(db.verifyPassword(values[i], 'rajada-' + i), true, `hash ${i} confere`);
        }
        const after = db.passwordHashQueueStatus();
        assert.deepEqual({ running: after.running, waiting: after.waiting }, { running: 0, waiting: 0 });
    } finally {
        crypto.scrypt = original;
    }
    // Falha do scrypt libera a vaga: a fila não trava.
    crypto.scrypt = () => { throw new Error('scrypt indisponível'); };
    try {
        await assert.rejects(db.hashPasswordAsync('falha'), /scrypt indisponível/);
        assert.equal(await db.verifyPasswordAsync(db.hashPassword('abc'), 'abc'), false, 'falha conta como senha errada');
    } finally {
        crypto.scrypt = original;
    }
    assert.equal(db.passwordHashQueueStatus().running, 0, 'a vaga da falha foi devolvida');
    assert.equal(await db.verifyPasswordAsync(db.hashPassword('abc'), 'abc'), true);
});

test('[UC-AUTH-001] hash antigo vira scrypt$ no login, pelo caminho assíncrono', async () => {
    db.memory.students[0].password = legacySha(ANA.password);
    db.memory.admins[0].password = ADMIN.password; // texto puro
    await withoutSyncScrypt(async () => {
        await request(app).post('/api/student/login').send(ANA).expect(200);
        await request(app).post('/api/session/admin-login').send(ADMIN).expect(200);
    });
    assert.match(db.memory.students[0].password, /^scrypt\$/);
    assert.match(db.memory.admins[0].password, /^scrypt\$/);
    assert.equal(await db.verifyPasswordAsync(db.memory.students[0].password, ANA.password), true);
    assert.equal(await db.verifyPasswordAsync(db.memory.admins[0].password, ADMIN.password), true);
});

// Troca db.<name> por uma versão que roda `during` depois da primeira chamada (o momento
// em que o login está esperando o scrypt) e devolve o resultado original.
async function withChangeDuring(name, during, run) {
    const original = db[name];
    let calls = 0;
    db[name] = async (...args) => {
        const result = await original(...args);
        calls += 1;
        if (calls === 1) await during();
        return result;
    };
    try { return await run(); } finally { db[name] = original; }
}
const loopbackReq = () => ({ headers: {}, socket: { remoteAddress: '127.0.0.1' } });

test('[UC-AUTH-001] senha trocada durante a conferência não é sobrescrita pela regravação do hash antigo, e a antiga não entra', async () => {
    db.memory.students[0].password = legacySha(ANA.password);
    const login = await withChangeDuring('verifyPasswordAsync', () => {
        // O professor redefine a senha enquanto o login espera o scrypt.
        db.memory.students[0].password = 'scrypt$nova$senha';
    }, () => attemptPasswordLogin({ kind: 'student', email: ANA.email, password: ANA.password, req: loopbackReq() }));
    // Antes, a sessão saía com a senha antiga (só a regravação era protegida).
    assert.equal(login.ok, false);
    assert.equal(login.status, 401);
    assert.equal(login.passwordChanged, true);
    assert.equal(db.memory.students[0].password, 'scrypt$nova$senha');
});

test('[UC-AUTH-001] senha redefinida no meio do login: a antiga não abre sessão, a nova abre (aluno e instrutor)', async () => {
    const newStudentHash = await db.hashPasswordAsync('nova-ana-123');
    const studentLogin = await withChangeDuring('verifyPasswordAsync', () => {
        db.memory.students[0].password = newStudentHash;
    }, () => request(app).post('/api/student/login').send(ANA));
    assert.equal(studentLogin.status, 401, `aluno com a senha antiga: ${studentLogin.status}`);
    assert.equal(studentLogin.body.error, 'E-mail ou senha incorretos.');
    assert.equal(studentLogin.body.passwordChanged, undefined, 'o detalhe não vai para a resposta');
    assert.deepEqual(Object.keys(db.memory.sessions || {}), [], 'nenhuma sessão de aluno');
    await request(app).post('/api/student/login').send({ email: ANA.email, password: 'nova-ana-123' }).expect(200);

    const newAdminHash = await db.hashPasswordAsync('nova-adm-123');
    const adminLogin = await withChangeDuring('verifyPasswordAsync', () => {
        db.memory.admins[0].password = newAdminHash;
    }, () => request(app).post('/api/session/admin-login').send(ADMIN));
    assert.equal(adminLogin.status, 401, `instrutor com a senha antiga: ${adminLogin.status}`);
    assert.equal(adminLogin.body.sessionToken, undefined);
    assert.deepEqual(Object.keys(db.memory.adminSessions || {}), [], 'nenhuma sessão de instrutor');
    await request(app).post('/api/session/admin-login').send({ email: ADMIN.email, password: 'nova-adm-123' }).expect(200);
});

test('[UC-AUTH-001] senha trocada durante a regravação do hash antigo: a antiga não entra e a nova fica', async () => {
    db.memory.students[0].password = legacySha(ANA.password);
    const newHash = await db.hashPasswordAsync('nova-ana-456');
    const login = await withChangeDuring('hashPasswordAsync', () => {
        db.memory.students[0].password = newHash;
    }, () => attemptPasswordLogin({ kind: 'student', email: ANA.email, password: ANA.password, req: loopbackReq() }));
    assert.equal(login.ok, false);
    assert.equal(login.status, 401);
    assert.equal(db.memory.students[0].password, newHash);
});

test('[UC-AUTH-001] conta apagada no meio do login não abre sessão; lista regravada com a mesma senha continua entrando', async () => {
    const deleted = await withChangeDuring('verifyPasswordAsync', () => {
        db.memory.students = [];
    }, () => attemptPasswordLogin({ kind: 'student', email: ANA.email, password: ANA.password, req: loopbackReq() }));
    assert.equal(deleted.ok, false);
    assert.equal(deleted.status, 401);

    seed();
    db.memory.students[0].password = legacySha(ANA.password);
    const rewritten = await withChangeDuring('verifyPasswordAsync', () => {
        // Outra rota regrava a lista inteira (objetos novos, mesmos valores).
        db.memory.students = db.memory.students.map(student => ({ ...student }));
    }, () => attemptPasswordLogin({ kind: 'student', email: ANA.email, password: ANA.password, req: loopbackReq() }));
    assert.equal(rewritten.ok, true);
    assert.equal(rewritten.account, db.memory.students[0], 'a conta que está na lista agora');
    assert.equal(rewritten.rehashed, true);
    assert.match(db.memory.students[0].password, /^scrypt\$/, 'o hash novo vai para a conta da lista atual');
});

test('[UC-AUTH-001] cadastro, contas e senhas pelo painel gravam scrypt$ sem crypto.scryptSync', async () => {
    const token = await adminSession();
    const admin = { 'x-admin-session': token };
    await withoutSyncScrypt(async () => {
        const reg = await request(app).post('/api/student/register').send({
            name: 'Bia Nova', email: 'bia@senhas.local', password: 'senha-bia', courseId: 'DES', studentClass: '1DES', acceptedTerms: true, birthDate: '2000-01-01',
        });
        assert.ok(reg.status < 300, `cadastro: ${reg.status} ${reg.body && reg.body.error}`);
        const created = await request(app).post('/api/admin/accounts/create').set(admin).send({
            email: 'prof@senhas.local', name: 'Prof', password: 'giz-azul-2024', role: 'professor',
        });
        assert.ok(created.status < 300, `conta: ${created.status} ${created.body && created.body.error}`);
        const reset = await request(app).post('/api/admin/reset-password').set(admin).send({ email: ANA.email, newPassword: 'nova-ana' });
        assert.ok(reset.status < 300, `redefinir: ${reset.status} ${reset.body && reset.body.error}`);
        const changed = await request(app).post('/api/admin/change-password').set(admin).send({ currentPassword: ADMIN.password, newPassword: 'nova-adm-123' });
        assert.ok(changed.status < 300, `trocar: ${changed.status} ${changed.body && changed.body.error}`);
    });
    const bia = db.memory.students.find(s => s.email === 'bia@senhas.local');
    assert.match(bia.password, /^scrypt\$/);
    assert.equal(await db.verifyPasswordAsync(bia.password, 'senha-bia'), true);
    const prof = db.memory.admins.find(a => a.email === 'prof@senhas.local');
    assert.match(prof.password, /^scrypt\$/);
    assert.equal(await db.verifyPasswordAsync(db.memory.students[0].password, 'nova-ana'), true);
    assert.equal(await db.verifyPasswordAsync(db.memory.admins[0].password, 'nova-adm-123'), true);
    assert.equal(await db.verifyPasswordAsync(db.memory.admins[0].password, ADMIN.password), false);
});

// Pedido falso para o attemptPasswordLogin direto, com o IP de outro aparelho (o teto
// por IP deste arquivo, do loopback, fica para os pedidos HTTP).
const fakeReq = ip => ({ headers: {}, socket: { remoteAddress: ip } });

test('[UC-AUTH-001] o 429 do login segue o formato combinado: loginDelayed e retryAfterSeconds', async () => {
    const { rateLimit } = require('../../backend/utils/rateLimit.js');
    for (const kind of ['student', 'admin']) {
        const ip = kind === 'student' ? '10.77.0.1' : '10.77.0.2';
        // Teto por IP do H5b: 300 tentativas por minuto, contando todas.
        for (let i = 0; i < 300; i += 1) rateLimit(`${kind}-login-all:${ip}`, { max: 300, windowMs: 60000 });
        const last = await attemptPasswordLogin({ kind, email: 'ninguem@senhas.local', password: 'x', req: fakeReq(ip) });
        assert.equal(last.ok, false);
        assert.equal(last.status, 429, kind);
        assert.equal(last.body.loginDelayed, true, `${kind}: loginDelayed`);
        assert.ok(Number.isInteger(last.body.retryAfterSeconds) && last.body.retryAfterSeconds >= 1 && last.body.retryAfterSeconds <= 60);
        assert.match(last.body.error, /^Muitas tentativas de (login|acesso)\. Aguarde um instante e tente novamente\.$/);
    }
});

test('[UC-AUTH-001] troca de senha do instrutor com hash antigo: a regravação na conferência não vira 409', async () => {
    db.memory.admins[0].password = legacySha(ADMIN.password);
    const token = createAdminSession(db.memory, ADMIN.email, { now: Date.now() });
    const res = await request(app).post('/api/admin/change-password').set('x-admin-session', token)
        .send({ currentPassword: ADMIN.password, newPassword: 'nova-senha-adm-1' });
    assert.equal(res.status, 200, `${res.status} ${res.body && res.body.error}`);
    assert.equal(await db.verifyPasswordAsync(db.memory.admins[0].password, 'nova-senha-adm-1'), true);
});

test('[UC-AUTH-001] troca de senha do instrutor: outra troca durante a conferência da senha atual dá 409', async () => {
    const token = createAdminSession(db.memory, ADMIN.email, { now: Date.now() });
    const original = db.verifyPasswordAsync;
    db.verifyPasswordAsync = async (stored, password) => {
        const ok = await original(stored, password);
        db.memory.admins[0].password = 'scrypt$outra$troca';
        return ok;
    };
    let res;
    try {
        res = await request(app).post('/api/admin/change-password').set('x-admin-session', token)
            .send({ currentPassword: ADMIN.password, newPassword: 'nova-senha-adm-2' });
    } finally {
        db.verifyPasswordAsync = original;
    }
    assert.equal(res.status, 409, `${res.status} ${res.body && res.body.error}`);
    assert.equal(db.memory.admins[0].password, 'scrypt$outra$troca', 'a troca do outro pedido fica');
});

// Por último neste arquivo: gasta o teto do loopback para o instrutor.
test('[UC-AUTH-001] a senha atual da troca de senha passa pelo atraso da conta do login do instrutor (429)', async () => {
    const token = createAdminSession(db.memory, ADMIN.email, { now: Date.now() });
    const before = db.memory.admins[0].password;
    const change = currentPassword => request(app).post('/api/admin/change-password').set('x-admin-session', token)
        .send({ currentPassword, newPassword: 'nova-senha-adm-3' });
    let res;
    let wrong = 0;
    for (let i = 0; i < 31; i += 1) {
        res = await change('errada-' + i);
        if (res.status === 429) break;
        assert.equal(res.status, 400, `tentativa ${i}: ${res.status}`);
        assert.equal(res.body.error, 'Senha atual incorreta.');
        wrong += 1;
    }
    assert.equal(res.status, 429, `depois de ${wrong} senhas atuais erradas`);
    // H5b: a senha atual errada conta no atraso da conta (5 seguidas), como no login.
    assert.equal(wrong, 5, 'a 6.ª tentativa espera');
    assert.equal(res.body.loginDelayed, true);
    assert.ok(Number.isInteger(res.body.retryAfterSeconds) && res.body.retryAfterSeconds >= 1);
    // Enquanto a conta espera, nem a senha atual certa troca a senha, e o login também espera.
    assert.equal((await change(ADMIN.password)).status, 429);
    assert.equal(db.memory.admins[0].password, before, 'a senha não mudou');
    assert.equal((await request(app).post('/api/session/admin-login').send(ADMIN)).status, 429, 'o teto é o mesmo do login do instrutor');
});
