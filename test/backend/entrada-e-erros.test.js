// Servidor que não trava nem cai com pedido errado (fase 2, H9a: ENG-03, ENG-04).
// Varredura de todas as rotas do servidor com corpo ausente, vazio e de tipo errado,
// guarda dos callbacks (validateAdmin e multer), código do erro (X-Request-Id),
// registro no crash.log com limite de 5 MB, limite do corpo JSON por sessão e query
// string com parâmetro repetido.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-entrada-erros-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const middlewares = require('../../backend/middlewares.js');
// Carregado dentro dos testes: no código sem o módulo, só os testes dele falham (o
// tratador de uncaughtException do server.js engoliria o erro do require no topo).
const errorLog = () => require('../../backend/utils/errorLog.js');
const { DEMO_ACCOUNTS } = require('../../backend/utils/demoAccounts.js');

const root = path.resolve(__dirname, '..', '..');
const routesDir = path.join(root, 'backend', 'routes');
const ADMIN_TOKEN = 'h9a-admin-token';
const PROFESSOR_TOKEN = 'h9a-professor-token';
const STUDENT_TOKEN = 'h9a-student-token';
const REQUEST_ID = /^[0-9a-f]{8}$/;

let app;
let snapshot;

// Rotas que a varredura não chama: derrubam o processo, apagam tudo ou dependem de
// arquivo de backup (cobertas pelos próprios testes).
const SWEEP_EXCLUDED = [
    /^POST \/api\/admin\/server\/restart$/,
    /^POST \/api\/admin\/reset$/,
    /^POST \/api\/test\/seed$/,
    /^POST \/api\/admin\/backup\/restore$/,
    /^POST \/api\/setup\//,
];

// Pendência conhecida até o H9b (schemas por rota): estas rotas ainda respondem 500
// com campo de tipo errado. Nunca ficam sem resposta (a guarda leva a exceção ao
// errorHandler). O H9b zera esta lista; a varredura falha se uma rota daqui deixar
// de falhar, para a lista não guardar rota já corrigida.
const KNOWN_TYPE_ERRORS_UNTIL_H9B = new Set([
    'POST /api/admin/accounts/create',
    'POST /api/admin/accounts/delete',
    'POST /api/admin/accounts/update',
    'POST /api/admin/assign-student-version',
    'POST /api/admin/change-password',
    'POST /api/admin/reset-password',
    'POST /api/admin/schools/create',
    'POST /api/admin/schools/delete',
    'POST /api/admin/schools/update',
    'POST /api/admin/student/certificates/issue',
    'POST /api/admin/student/observations/create',
    'POST /api/admin/student/update',
    'POST /api/admin/unlock-student-focus',
    'POST /api/forum/comment',
    'POST /api/forum/comment/edit',
    'POST /api/forum/reply',
    'POST /api/forum/reply/edit',
    'POST /api/student/log-keystrokes',
    'POST /api/student/login',
]);

// Campos mais usados nos corpos das rotas (grep de req.body em backend/routes).
const FIELDS = [
    'email', 'password', 'name', 'studentEmail', 'targetEmail', 'originalEmail', 'newPassword', 'currentPassword',
    'role', 'studentClass', 'className', 'courseId', 'examKey', 'applicationId', 'attemptId', 'id', 'ids', 'key',
    'keys', 'moduleKey', 'note', 'text', 'commentId', 'replyId', 'title', 'message', 'url', 'description', 'tags',
    'category', 'curriculumKey', 'type', 'questionText', 'alternatives', 'correctAnswer', 'questionNumber', 'version',
    'status', 'events', 'answers', 'reason', 'itemKey', 'confirm', 'folder', 'scope', 'info', 'branding', 'structure',
    'token', 'accessToken',
];
const WRONG_VALUES = [
    ['número', 123],
    ['objeto', { x: 1 }],
    ['lista', [1, 'a']],
];

function routesFromSource(methods) {
    const pattern = new RegExp(`router\\.(${methods})\\(\\s*['"\`]([^'"\`]+)`, 'g');
    const found = new Set();
    for (const filename of fs.readdirSync(routesDir).filter(name => name.endsWith('.js'))) {
        const source = fs.readFileSync(path.join(routesDir, filename), 'utf8');
        let match;
        while ((match = pattern.exec(source))) found.add(`${match[1].toUpperCase()} ${match[2]}`);
    }
    return [...found].sort();
}

function restoreSeed() {
    const memory = db.memory;
    Object.keys(memory).forEach(key => { delete memory[key]; });
    Object.assign(memory, structuredClone(snapshot));
    const now = Date.now();
    memory.adminSessions = {
        [ADMIN_TOKEN]: { email: DEMO_ACCOUNTS.admin.email, createdAt: now, lastSeen: now },
        [PROFESSOR_TOKEN]: { email: DEMO_ACCOUNTS.professor.email, createdAt: now, lastSeen: now },
    };
    memory.sessions = {
        [DEMO_ACCOUNTS.student.email]: { token: STUDENT_TOKEN, createdAt: now, lastSeen: now, ip: '127.0.0.1' },
    };
}

// Quem chama cada rota: o painel do instrutor (/api/admin), o portal do aluno
// (/api/student) e, nas rotas compartilhadas (fórum, cursos, logout), os dois.
function identitiesFor(route) {
    const routePath = route.split(' ')[1];
    if (routePath.startsWith('/api/admin')) return ['admin'];
    if (routePath.startsWith('/api/student')) return ['aluno'];
    return ['admin', 'aluno'];
}

function withIdentity(req, identity) {
    if (identity === 'admin') return req.set('x-admin-session', ADMIN_TOKEN);
    return req.set('x-session-token', STUDENT_TOKEN);
}

function bodyVariants(identity) {
    const variants = [['sem corpo', undefined], ['{}', {}]];
    WRONG_VALUES.forEach(([label, value]) => {
        variants.push([`campos como ${label}`, Object.fromEntries(FIELDS.map(field => [field, value]))]);
        // O aluno manda o próprio e-mail junto (a sessão confere o e-mail declarado):
        // com ele certo, o pedido passa da sessão e o tipo errado chega à rota.
        if (identity === 'aluno') {
            variants.push([`campos como ${label} (e-mail da sessão)`, {
                ...Object.fromEntries(FIELDS.map(field => [field, value])),
                email: DEMO_ACCOUNTS.student.email,
            }]);
        }
    });
    return variants;
}

async function call(route, identity, body, query = '') {
    const [method, routePath] = route.split(' ');
    const target = routePath.replace(/:[A-Za-z_]+/g, 'x1') + query;
    let req = withIdentity(request(app)[method.toLowerCase()](target), identity).timeout(2000);
    if (body !== undefined) req = req.send(body);
    try {
        const res = await req;
        return { status: res.status, requestId: res.headers['x-request-id'], error: res.body && res.body.error };
    } catch (error) {
        if (error && error.response) {
            return { status: error.response.status, requestId: error.response.headers['x-request-id'] };
        }
        return { status: 0, timeout: true, error: String(error && (error.code || error.message) || error) };
    }
}

test.before(async () => {
    await db.init();
    app = createApp();
    const seeded = await request(app).post('/api/test/seed');
    assert.equal(seeded.status, 200);
    await db.save();
    snapshot = structuredClone({ ...db.memory, sessions: {}, adminSessions: {} });
});

test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-ERRO-001] varredura: nenhuma rota de escrita fica sem resposta ou responde 500 com corpo ausente, vazio ou de tipo errado', async () => {
    const routes = routesFromSource('post|put|delete|patch')
        .filter(route => !SWEEP_EXCLUDED.some(pattern => pattern.test(route)));
    assert.ok(routes.length >= 130, `a varredura enxergou só ${routes.length} rotas de escrita (forma de declarar rota mudou?)`);

    const rejections = [];
    const onRejection = reason => rejections.push(String(reason && reason.stack || reason));
    process.on('unhandledRejection', onRejection);
    const hung = [];
    const failures = new Map();
    const missingRequestId = [];
    try {
        for (const route of routes) {
            for (const identity of identitiesFor(route)) {
                for (const [label, body] of bodyVariants(identity)) {
                    restoreSeed();
                    const result = await call(route, identity, body);
                    const where = `${route} [${identity}, ${label}]`;
                    if (result.timeout) hung.push(`${where}: ${result.error}`);
                    else if (result.status >= 500) {
                        if (!failures.has(route)) failures.set(route, []);
                        failures.get(route).push(`${where}: ${result.status} ${result.error || ''}`);
                    }
                    if (!result.timeout && !REQUEST_ID.test(String(result.requestId || ''))) missingRequestId.push(where);
                }
            }
        }
        await new Promise(resolve => setImmediate(resolve));
    } finally {
        process.off('unhandledRejection', onRejection);
    }

    assert.deepEqual(hung, [], `Pedidos sem resposta em 2 s:\n${hung.join('\n')}`);
    const unexpected = [...failures.entries()].filter(([route]) => !KNOWN_TYPE_ERRORS_UNTIL_H9B.has(route));
    assert.deepEqual(unexpected.flatMap(([, lines]) => lines), [], 'Rotas com resposta 500 ou acima');
    const alreadyFixed = [...KNOWN_TYPE_ERRORS_UNTIL_H9B].filter(route => !failures.has(route));
    assert.deepEqual(alreadyFixed, [], 'Rotas que já não falham: tire da lista KNOWN_TYPE_ERRORS_UNTIL_H9B');
    assert.deepEqual(missingRequestId, [], 'Respostas sem X-Request-Id');
    assert.deepEqual(rejections, [], 'unhandledRejection durante a varredura');
});

test('[UC-ERRO-001] varredura: nenhuma rota de leitura responde 500 com parâmetro de query repetido', async () => {
    // Rotas que montam o ZIP inteiro: cobertas pelos testes de backup.
    const excluded = new Set(['GET /api/admin/backup/full', 'GET /api/admin/backup/data']);
    const routes = routesFromSource('get').filter(route => !excluded.has(route));
    assert.ok(routes.length >= 70, `a varredura enxergou só ${routes.length} rotas de leitura`);
    const repeated = '?' + FIELDS.flatMap(field => [`${field}=a`, `${field}=b`]).join('&')
        + '&studentEmail=' + encodeURIComponent(DEMO_ACCOUNTS.student.email);
    const problems = [];
    for (const route of routes) {
        for (const identity of identitiesFor(route)) {
            restoreSeed();
            const result = await call(route, identity, undefined, repeated);
            if (result.timeout || result.status >= 500) problems.push(`${route} [${identity}]: ${result.status || result.error} ${result.error || ''}`);
        }
    }
    assert.deepEqual(problems, [], 'GET com parâmetro repetido respondeu 500 ou ficou sem resposta');

    // As rotas que a auditoria mediu, com o aluno e o curso certos repetidos.
    restoreSeed();
    const email = encodeURIComponent(DEMO_ACCOUNTS.student.email);
    for (const routePath of ['/api/admin/student/dashboard', '/api/admin/student/academic', '/api/admin/student/attendance',
        '/api/admin/student/audit', '/api/admin/student/login-logs', '/api/admin/student/observations', '/api/admin/message-history',
        '/api/admin/dashboard/students-overview']) {
        const res = await request(app).get(`${routePath}?email=${email}&email=${email}&studentEmail=${email}&studentEmail=x`).set('x-admin-session', ADMIN_TOKEN);
        assert.ok(res.status < 500, `${routePath}: ${res.status} ${res.body && res.body.error}`);
    }
    const branding = await request(app).get('/api/branding?courseId=a&courseId=b&schoolId=a&schoolId=b');
    assert.ok(branding.status < 500, `/api/branding: ${branding.status}`);
});

test('[UC-ERRO-001] leitor de query: parâmetro repetido vira o último valor, sempre texto', async () => {
    const probe = express();
    probe.set('query parser', app.get('query parser fn'));
    probe.get('/q', (req, res) => res.json({ query: { ...req.query }, isArray: Array.isArray(req.query.email) }));
    const res = await request(probe).get('/q?email=a%40x.local&email=b%40x.local&nested[a]=1&vazio=&mais=um+dois');
    assert.equal(res.body.isArray, false);
    assert.deepEqual(res.body.query, { email: 'b@x.local', 'nested[a]': '1', vazio: '', mais: 'um dois' });
    const empty = await request(probe).get('/q');
    assert.deepEqual(empty.body.query, {});
});

test('[UC-ERRO-001] toda resposta da API leva X-Request-Id, inclusive 401 e 404', async () => {
    restoreSeed();
    const responses = await Promise.all([
        request(app).get('/api/ping'),
        request(app).get('/api/admin/accounts'),
        request(app).get('/api/rota-que-nao-existe'),
        request(app).post('/api/student/login').send({ email: DEMO_ACCOUNTS.student.email, password: 'errada' }),
    ]);
    const ids = responses.map(res => res.headers['x-request-id']);
    ids.forEach((id, index) => assert.match(String(id), REQUEST_ID, `resposta ${index} sem código`));
    assert.equal(new Set(ids).size, ids.length, 'cada pedido tem o seu código');
});

test('[UC-ERRO-001] exceção no callback assíncrono de validateAdmin responde 500 com o código do erro e vai para o crash.log sem a senha', async () => {
    restoreSeed();
    const probe = express();
    probe.use(middlewares.assignRequestId);
    probe.use(express.json());
    probe.post('/falha', (req, res) => {
        middlewares.validateAdmin(req, res, async () => {
            await null;
            throw new Error('falha de teste no callback');
        });
    });
    probe.post('/falha-permissao', (req, res) => {
        middlewares.validateAdminPermission(req, res, 'page.forum', async () => {
            await null;
            throw new Error('falha de teste com permissão');
        });
    });
    probe.post('/falha-sincrona', (req, res) => {
        middlewares.validateAdmin(req, res, () => { throw new Error('falha síncrona de teste'); });
    });
    probe.use(middlewares.errorHandler);

    const rejections = [];
    const onRejection = reason => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
        const started = Date.now();
        const res = await request(probe).post('/falha').set('x-admin-session', PROFESSOR_TOKEN)
            .send({ password: 'senha-que-nao-pode-ir-ao-log' }).timeout(1000);
        assert.ok(Date.now() - started < 1000);
        assert.equal(res.status, 500);
        const id = res.headers['x-request-id'];
        assert.match(String(id), REQUEST_ID);
        assert.equal(res.body.requestId, id);
        assert.equal(res.body.error, `Ocorreu um erro interno no servidor. Código do erro: ${id}.`);

        const permission = await request(probe).post('/falha-permissao').set('x-admin-session', ADMIN_TOKEN).send({}).timeout(1000);
        assert.equal(permission.status, 500);
        assert.match(permission.body.error, /Código do erro: [0-9a-f]{8}\./);
        const sync = await request(probe).post('/falha-sincrona').set('x-admin-session', ADMIN_TOKEN).send({}).timeout(1000);
        assert.equal(sync.status, 500);
        await new Promise(resolve => setImmediate(resolve));

        const log = fs.readFileSync(errorLog().crashLogPath(), 'utf8');
        const block = log.split('\n[').find(entry => entry.includes(` ${id} `));
        assert.ok(block, 'o crash.log tem o bloco com o código do erro');
        assert.match(block, new RegExp(`erro interno ${id} POST /falha \\(professor ${DEMO_ACCOUNTS.professor.email.replace('.', '\\.')}\\)`));
        assert.match(block, /falha de teste no callback/);
        assert.match(block, /entrada-e-erros\.test\.js/, 'o stack vai para o log');
        assert.doesNotMatch(log, /senha-que-nao-pode-ir-ao-log/);
    } finally {
        process.off('unhandledRejection', onRejection);
    }
    assert.deepEqual(rejections, []);
});

test('[UC-ERRO-001] exceção síncrona no callback do multer responde 500 (guarded), sem uncaughtException', async () => {
    restoreSeed();
    const uncaught = [];
    const onUncaught = error => uncaught.push(error);
    process.on('uncaughtException', onUncaught);
    try {
        const probe = express();
        probe.use(middlewares.assignRequestId);
        const upload = multer({ storage: multer.memoryStorage() });
        probe.post('/envio', (req, res) => {
            middlewares.validateAdmin(req, res, () => {
                upload.single('file')(req, res, middlewares.guarded(req, res, () => {
                    throw new Error('falha síncrona no callback do multer');
                }));
            });
        });
        probe.post('/envio-async', (req, res) => {
            middlewares.validateAdmin(req, res, () => {
                upload.single('file')(req, res, middlewares.guarded(req, res, async () => {
                    await null;
                    throw new Error('falha assíncrona no callback do multer');
                }));
            });
        });
        probe.use(middlewares.errorHandler);
        for (const target of ['/envio', '/envio-async']) {
            const res = await request(probe).post(target).set('x-admin-session', ADMIN_TOKEN)
                .attach('file', Buffer.from('conteúdo'), 'arquivo.txt').timeout(1000);
            assert.equal(res.status, 500, target);
            assert.match(res.body.error, /Código do erro: [0-9a-f]{8}\./);
        }
        await new Promise(resolve => setImmediate(resolve));
    } finally {
        process.off('uncaughtException', onUncaught);
    }
    assert.deepEqual(uncaught, []);
});

test('[UC-ERRO-001] os callbacks do multer e de validateAdmin das rotas reais ficam dentro da guarda', () => {
    const problems = [];
    for (const filename of fs.readdirSync(routesDir).filter(name => name.endsWith('.js'))) {
        fs.readFileSync(path.join(routesDir, filename), 'utf8').split('\n').forEach((line, index) => {
            // Callback do multer passado direto, sem guarded(req, res, ...).
            if (/\.(single|array|fields|any|none)\([^)]*\)\(req, res, (?!guarded\()/.test(line)) problems.push(`${filename}:${index + 1}: ${line.trim()}`);
        });
    }
    assert.deepEqual(problems, [], 'callback do multer sem guarded()');

    // Catch que responde 500 só com console.error (sem código nem crash.log) e mensagem
    // interna (error.message) num 500.
    const routeSources = fs.readdirSync(routesDir).filter(name => name.endsWith('.js'))
        .map(name => [name, fs.readFileSync(path.join(routesDir, name), 'utf8')]);
    routeSources.forEach(([name, source]) => {
        assert.doesNotMatch(source, /status\(500\)\.json\(\{ ?error: [^'"]*message/, `${name} devolve error.message num 500`);
        assert.doesNotMatch(source, /res\.status\(500\)\.json\(\{ error: 'Erro interno no servidor\.' \}\)/, `${name} tem catch sem sendInternalError`);
    });
});

test('[UC-ERRO-001] catch de rota com erro responde o 500 padrão com o código e registra no crash.log (sendInternalError)', async () => {
    restoreSeed();
    db.memory.proctoringLogs = [...(db.memory.proctoringLogs || []), { id: 'log-quebrado' }];
    const res = await request(app).get('/api/admin/proctoring-logs/1DES/Avaliacao_FUTEC_5').set('x-admin-session', ADMIN_TOKEN);
    assert.equal(res.status, 500);
    const id = res.headers['x-request-id'];
    assert.equal(res.body.error, `Ocorreu um erro interno no servidor. Código do erro: ${id}.`);
    assert.doesNotMatch(JSON.stringify(res.body), /toLowerCase|TypeError/);
    const log = fs.readFileSync(errorLog().crashLogPath(), 'utf8');
    assert.match(log, new RegExp(`erro interno ${id} GET /api/admin/proctoring-logs/1DES/Avaliacao_FUTEC_5 \\(admin `));
    assert.match(log, /TypeError/);
});

test('[UC-ERRO-001] corpo JSON: 512 KB sem sessão de instrutor, 10 MB com sessão válida e 401 com sessão vencida', async () => {
    restoreSeed();
    const big = 'x'.repeat(600 * 1024);
    const started = Date.now();
    const anonymous = await request(app).post('/api/student/login').send({ email: 'a@b.local', password: big });
    assert.ok(Date.now() - started < 1000, 'recusa sem processar o corpo');
    assert.equal(anonymous.status, 413);
    assert.equal(anonymous.body.error, 'Os dados enviados são grandes demais.');

    const student = await request(app).post('/api/student/notes/save').set('x-session-token', STUDENT_TOKEN)
        .send({ email: DEMO_ACCOUNTS.student.email, moduleKey: 'geral', note: big });
    assert.equal(student.status, 413, 'o aluno fica com 512 KB');

    const material = await request(app).put('/api/admin/material/Apostila_Grande').set('x-admin-session', ADMIN_TOKEN)
        .send({ markdownText: `# Apostila\n\n${big}` });
    assert.notEqual(material.status, 413, 'o professor com sessão salva apostila grande');
    assert.ok(material.status < 500, `${material.status} ${material.body && material.body.error}`);

    const unknown = await request(app).put('/api/admin/material/Apostila_Grande').set('x-admin-session', 'sessao-de-antes-do-reinicio')
        .send({ markdownText: big });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.sessionRevoked, true);
    assert.equal(unknown.body.error, 'Sessão expirada. Faça login novamente.');

    db.memory.adminSessions[ADMIN_TOKEN].createdAt = Date.now() - 400 * 3600000;
    const expired = await request(app).put('/api/admin/material/Apostila_Grande').set('x-admin-session', ADMIN_TOKEN)
        .send({ markdownText: big });
    assert.equal(expired.status, 401);
    assert.equal(expired.body.sessionRevoked, true);

    // Abaixo do limite, a sessão vencida continua com a resposta de sempre de validateAdmin.
    restoreSeed();
    db.memory.adminSessions[ADMIN_TOKEN].createdAt = Date.now() - 400 * 3600000;
    const small = await request(app).put('/api/admin/material/Apostila_Grande').set('x-admin-session', ADMIN_TOKEN).send({ markdownText: 'x' });
    assert.equal(small.status, 401);
    assert.equal(small.body.sessionRevoked, true);
    assert.equal(db.memory.adminSessions[ADMIN_TOKEN], undefined, 'sessão vencida removida');
});

test('[UC-ERRO-001] resolveAdminSession não altera nada e só aceita sessão existente dentro do prazo', () => {
    restoreSeed();
    const now = Date.now();
    assert.equal(middlewares.resolveAdminSession({ headers: {} }), null);
    assert.equal(middlewares.resolveAdminSession({ headers: { 'x-admin-session': 'nao-existe' } }), null);
    assert.equal(middlewares.resolveAdminSession({ headers: { 'x-admin-session': '__proto__' } }), null);
    assert.equal(middlewares.resolveAdminSession({ headers: { 'x-admin-session': 'constructor' } }), null);
    assert.equal(middlewares.resolveAdminSession({ headers: { 'x-admin-session': ADMIN_TOKEN } }).session.email, DEMO_ACCOUNTS.admin.email);
    db.memory.adminSessions[ADMIN_TOKEN].createdAt = now - 400 * 3600000;
    assert.equal(middlewares.resolveAdminSession({ headers: { 'x-admin-session': ADMIN_TOKEN } }), null);
    assert.ok(db.memory.adminSessions[ADMIN_TOKEN], 'a consulta não apaga a sessão');
});

test('[UC-ERRO-001] credencial legada só vale como texto: password numérico ou objeto responde 401 sem gastar tentativas', async () => {
    restoreSeed();
    for (let attempt = 0; attempt < 35; attempt++) {
        const res = await request(app).post('/api/admin/student/observations/create')
            .send({ password: attempt % 2 ? 12345 : { senha: 'x' }, email: DEMO_ACCOUNTS.student.email, text: 'oi' });
        assert.equal(res.status, 401, `tentativa ${attempt + 1}: ${res.status}`);
        assert.equal(res.body.error, 'Acesso não autorizado.');
    }
    const logout = await request(app).post('/api/session/logout').send({ password: 123 });
    assert.ok(logout.status < 500, `logout: ${logout.status}`);
    const branding = await request(app).post('/api/branding').send({ password: ['a'] });
    assert.equal(branding.status, 401);
    // O login legado em texto continua funcionando (até o H6b tirá-lo).
    const legacy = await request(app).get('/api/admin/whoami')
        .set('Authorization', `${DEMO_ACCOUNTS.admin.email}:${DEMO_ACCOUNTS.admin.password}`);
    assert.equal(legacy.status, 200);
});

test('[UC-ERRO-001] corpo sempre objeto: rota sem corpo responde 400 em vez de 500 ou ficar sem resposta, e o beacon de texto continua lido', async () => {
    restoreSeed();
    const accounts = await request(app).post('/api/admin/accounts/create').set('x-admin-session', ADMIN_TOKEN).timeout(2000);
    assert.equal(accounts.status, 400);
    const password = await request(app).post('/api/admin/change-password').set('x-admin-session', ADMIN_TOKEN).timeout(2000);
    assert.ok(password.status >= 400 && password.status < 500, String(password.status));

    const leave = await request(app).post('/api/student/leave').set('x-session-token', STUDENT_TOKEN)
        .set('Content-Type', 'text/plain').send(DEMO_ACCOUNTS.student.email);
    assert.equal(leave.status, 200);
    assert.equal(db.memory.sessions[DEMO_ACCOUNTS.student.email], undefined, 'o beacon de saída encerrou a sessão');
});

test('[UC-ERRO-001] errorHandler: falha de gravação vira 503 retryable, resposta já começada só é fechada, sem código fora de pedido', () => {
    const fakeRes = () => ({
        headersSent: false, writableEnded: false, statusCode: 200, body: null, ended: false,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; this.headersSent = true; this.writableEnded = true; return this; },
        end() { this.ended = true; this.writableEnded = true; },
    });
    const originalError = console.error;
    console.error = () => {};
    try {
        const dbWrite = fakeRes();
        const err = Object.assign(new Error('SQLITE_BUSY'), { code: 'ICLASS_DB_WRITE' });
        middlewares.errorHandler(err, { id: 'abcd1234', method: 'POST', originalUrl: '/api/student/autosave-progress' }, dbWrite, () => {});
        assert.equal(dbWrite.statusCode, 503);
        assert.equal(dbWrite.body.retryable, true);
        assert.equal(dbWrite.body.error, 'Não foi possível gravar os dados agora. Tente de novo em alguns segundos.');

        const started = fakeRes();
        started.headersSent = true;
        middlewares.errorHandler(new Error('falha no meio do envio'), { id: 'abcd1235' }, started, () => {});
        assert.equal(started.body, null, 'não tenta mandar outro corpo');
        assert.equal(started.ended, true);

        const direct = fakeRes();
        middlewares.errorHandler(new TypeError('email.trim is not a function'), {}, direct, () => {});
        assert.equal(direct.statusCode, 500);
        assert.equal(direct.body.error, 'Ocorreu um erro interno no servidor.');
        assert.equal(direct.body.requestId, undefined);

        const charset = fakeRes();
        middlewares.errorHandler(Object.assign(new Error('unsupported charset "UTF-7"'), { status: 415, type: 'charset.unsupported' }), {}, charset, () => {});
        assert.equal(charset.statusCode, 415);
        assert.equal(charset.body.error, 'Dados enviados em formato inválido.');
    } finally {
        console.error = originalError;
    }
});

test('[UC-ERRO-001] crash.log: só logError escreve, sem query string, e o arquivo roda em 5 MB para crash.log.1', () => {
    const { logError, crashLogPath, CRASH_LOG_MAX_BYTES } = errorLog();
    const file = crashLogPath();
    const originalError = console.error;
    console.error = () => {};
    try {
        fs.writeFileSync(`${file}.1`, 'rotação anterior');
        fs.writeFileSync(file, 'a'.repeat(CRASH_LOG_MAX_BYTES + 1));
        logError('erro interno', new Error('primeiro depois do limite'), {
            req: { id: 'cafe0001', method: 'GET', originalUrl: '/uploads/x.pdf?access=SEGREDO-DO-TOKEN', studentEmail: 'ana@teste.local', body: { password: 'SENHA' } },
        });
        assert.equal(fs.statSync(`${file}.1`).size, CRASH_LOG_MAX_BYTES + 1, 'o arquivo cheio virou crash.log.1 (o anterior foi substituído)');
        const current = fs.readFileSync(file, 'utf8');
        assert.ok(current.length < 10000);
        assert.match(current, /\] erro interno cafe0001 GET \/uploads\/x\.pdf \(aluno ana@teste\.local\)\n/);
        assert.match(current, /primeiro depois do limite/);
        assert.doesNotMatch(current, /SEGREDO-DO-TOKEN|SENHA/);

        // Bloco sem pedido (exceção não tratada) e erro que não é Error.
        logError('unhandledRejection', 'motivo em texto');
        logError('uncaughtException', undefined);
        const after = fs.readFileSync(file, 'utf8');
        assert.match(after, /\] unhandledRejection\nmotivo em texto\n/);
        assert.match(after, /\] uncaughtException\nundefined\n/);

        // Detalhe enorme é cortado.
        logError('erro de tela', new Error('x'.repeat(200000)), { details: { area: 'admin', caminho: '/provas' } });
        assert.ok(fs.statSync(file).size < 100000);
        assert.match(fs.readFileSync(file, 'utf8'), /area: admin\n {2}caminho: \/provas\n/);
    } finally {
        console.error = originalError;
    }

    // Ninguém mais escreve no crash.log.
    const writers = [];
    const scan = directory => fs.readdirSync(directory, { withFileTypes: true }).forEach(entry => {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) return scan(full);
        if (!entry.name.endsWith('.js') || full.endsWith(path.join('utils', 'errorLog.js'))) return;
        if (/crash\.log/.test(fs.readFileSync(full, 'utf8').replace(/\/\/.*$/gm, ''))) writers.push(path.relative(root, full));
    });
    scan(path.join(root, 'backend'));
    assert.deepEqual(writers, [], 'arquivos do servidor que citam crash.log fora de utils/errorLog.js');
});
