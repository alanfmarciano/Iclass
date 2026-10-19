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
// com campo de tipo errado (só nas variantes "campos como ..."; sem corpo e com {}
// elas também têm de responder abaixo de 500). Nunca ficam sem resposta (a guarda
// leva a exceção ao errorHandler). O H9b zera esta lista; a varredura falha se uma
// rota daqui deixar de falhar, para a lista não guardar rota já corrigida.
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
    ['null', null],
    ['booleano', true],
];
const TYPED_VARIANT = /^campos como /;

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

// Quem chama cada rota: o painel do instrutor (/api/admin) com as duas contas
// (administrador e professor, que passa pelas regras de escopo), o portal do aluno
// (/api/student) e, nas rotas compartilhadas (fórum, cursos, logout), todos.
function identitiesFor(route) {
    const routePath = route.split(' ')[1];
    if (routePath.startsWith('/api/admin')) return ['admin', 'professor'];
    if (routePath.startsWith('/api/student')) return ['aluno'];
    return ['admin', 'professor', 'aluno'];
}

function withIdentity(req, identity) {
    if (identity === 'admin') return req.set('x-admin-session', ADMIN_TOKEN);
    if (identity === 'professor') return req.set('x-admin-session', PROFESSOR_TOKEN);
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
    const knownFailures = new Map();
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
                        const known = KNOWN_TYPE_ERRORS_UNTIL_H9B.has(route) && TYPED_VARIANT.test(label);
                        const bucket = known ? knownFailures : failures;
                        if (!bucket.has(route)) bucket.set(route, []);
                        bucket.get(route).push(`${where}: ${result.status} ${result.error || ''}`);
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
    assert.deepEqual([...failures.values()].flat(), [], 'Rotas com resposta 500 ou acima');
    const alreadyFixed = [...KNOWN_TYPE_ERRORS_UNTIL_H9B].filter(route => !knownFailures.has(route));
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

    // Todo 500 de rota passa por sendInternalError (código do erro, requestId e bloco no
    // crash.log). Um res.status(500) escrito à mão respondia sem código e sem registro
    // (salvar apostila com falha de disco, curso arquivado corrompido, ZIP do backup).
    // O 503 fica de fora: é resposta de estado (manutenção, configuração inicial e, nas
    // próximas etapas, servidor iniciando), com formato próprio.
    const internalErrors = [];
    for (const filename of fs.readdirSync(routesDir).filter(name => name.endsWith('.js'))) {
        fs.readFileSync(path.join(routesDir, filename), 'utf8').split('\n').forEach((line, index) => {
            if (/(status|sendStatus)\(\s*5(?!03)\d\d\b/.test(line)) internalErrors.push(`${filename}:${index + 1}: ${line.trim()}`);
            // error.message numa resposta: a falha inesperada ("EISDIR: illegal operation on
            // a directory", "x is not a function") saía num 400 sem código e sem registro.
            // Só a recusa do encerramento com prova em andamento (mensagem em português
            // de utils/examFinish.js) passa direto; o resto usa sendRouteError.
            if (/\.json\(.*\b(e|err|error|ex)\.message/.test(line) && !/requiresInProgressPolicy/.test(line)) internalErrors.push(`${filename}:${index + 1}: devolve error.message (use sendRouteError)`);
        });
    }
    assert.deepEqual(internalErrors, [], 'resposta 5xx escrita à mão ou error.message nas rotas (use sendInternalError ou sendRouteError)');
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

test('[UC-ERRO-001] falha de disco ao salvar apostila e curso arquivado corrompido respondem 500 com o código do erro e ficam no crash.log', async () => {
    restoreSeed();
    const crashLog = () => fs.readFileSync(errorLog().crashLogPath(), 'utf8');
    // Pasta no lugar do .md: o fs.writeFileSync falha com EISDIR (como disco cheio ou
    // arquivo preso por outro programa).
    const blocked = path.join(process.env.ICLASS_CONTENT_DIR, 'Apostila_Disco_Falho.md');
    fs.mkdirSync(blocked, { recursive: true });
    try {
        const res = await request(app).put('/api/admin/material/Apostila_Disco_Falho').set('x-admin-session', ADMIN_TOKEN)
            .send({ markdownText: '# Apostila' });
        assert.equal(res.status, 500);
        const id = res.headers['x-request-id'];
        assert.match(String(id), REQUEST_ID);
        assert.equal(res.body.requestId, id);
        assert.equal(res.body.error, `Falha ao gravar arquivo no disco. Código do erro: ${id}.`);
        const log = crashLog();
        assert.match(log, new RegExp(`erro interno ${id} PUT /api/admin/material/Apostila_Disco_Falho \\(admin `));
        assert.match(log, /EISDIR/);

        // O editor salva na turma (scope 'class'): a cópia da apostila para a turma
        // (forkMaterial) falhava do mesmo jeito e respondia 400 "EISDIR: illegal operation
        // on a directory, read", em inglês, sem código e sem registro.
        const forked = await request(app).put('/api/admin/material/Apostila_Disco_Falho').set('x-admin-session', ADMIN_TOKEN)
            .send({ markdownText: '# Apostila', courseId: 'curso_legacy_01', studentClass: '1DES', scope: 'class' });
        assert.equal(forked.status, 500);
        const forkedId = forked.headers['x-request-id'];
        assert.equal(forked.body.error, `Falha ao gravar arquivo no disco. Código do erro: ${forkedId}.`);
        assert.doesNotMatch(JSON.stringify(forked.body), /EISDIR|illegal/);
        assert.match(crashLog(), new RegExp(`erro interno ${forkedId} PUT /api/admin/material/Apostila_Disco_Falho \\(admin [^)]*\\)\\nError: EISDIR`));
    } finally {
        fs.rmSync(blocked, { recursive: true, force: true });
    }

    // A recusa prevista do mesmo trecho continua com a própria mensagem.
    const missingClass = await request(app).put('/api/admin/material/Apostila_FUTEC_1').set('x-admin-session', ADMIN_TOKEN)
        .send({ markdownText: '# Apostila', courseId: 'curso_legacy_01', studentClass: 'Turma Que Nao Existe', scope: 'class' });
    assert.equal(missingClass.status, 404);
    assert.equal(missingClass.body.error, 'Turma não encontrada.');

    const folder = path.join(process.env.ICLASS_ARCHIVE_DIR, 'curso_corrompido');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'manifesto.json'), JSON.stringify({ folder: 'curso_corrompido' }));
    fs.writeFileSync(path.join(folder, 'curso.json'), '{"course": {"id": ');
    try {
        const res = await request(app).post('/api/admin/archived-courses/restore').set('x-admin-session', ADMIN_TOKEN)
            .send({ folder: 'curso_corrompido' });
        assert.equal(res.status, 500);
        const id = res.headers['x-request-id'];
        assert.equal(res.body.error, `Arquivo corrompido. Código do erro: ${id}.`);
        assert.match(crashLog(), new RegExp(`erro interno ${id} POST /api/admin/archived-courses/restore \\(admin [^)]*\\)\\nSyntaxError`));
    } finally {
        fs.rmSync(folder, { recursive: true, force: true });
    }
});

test('[UC-ERRO-001] falha ao gerar o ZIP do backup completo: antes do envio responde 500 em JSON com o código; no meio do envio corta a conexão; nos dois casos fica no crash.log', async () => {
    restoreSeed();
    const backupUtil = require('../../backend/utils/backup.js');
    const original = backupUtil.streamFullZip;
    const crashLog = () => fs.readFileSync(errorLog().crashLogPath(), 'utf8');
    const originalError = console.error;
    console.error = () => {};
    try {
        backupUtil.streamFullZip = async () => { throw new Error('EMFILE: too many open files'); };
        const res = await request(app).get('/api/admin/backup/full').set('x-admin-session', ADMIN_TOKEN);
        assert.equal(res.status, 500);
        const id = res.headers['x-request-id'];
        assert.match(String(id), REQUEST_ID);
        assert.equal(res.body.error, `Falha ao gerar backup completo. Código do erro: ${id}.`);
        assert.equal(res.body.requestId, id);
        // A resposta de erro não sai como "arquivo .zip" com o JSON dentro.
        assert.match(String(res.headers['content-type']), /^application\/json/);
        assert.equal(res.headers['content-disposition'], undefined);
        assert.match(crashLog(), new RegExp(`erro interno ${id} GET /api/admin/backup/full \\(admin [^)]*\\)\\nError: EMFILE`));

        // O ZIP já começou a descer: não há como mandar o JSON; a conexão é cortada (o
        // navegador acusa o download como falho) e o registro fica no crash.log.
        backupUtil.streamFullZip = async output => {
            output.write(Buffer.alloc(64 * 1024, 1));
            await new Promise(resolve => setTimeout(resolve, 20));
            throw new Error('EIO: falha de leitura no meio do ZIP');
        };
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        try {
            const outcome = await new Promise(resolve => {
                const http = require('node:http');
                const req = http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/admin/backup/full', headers: { 'x-admin-session': ADMIN_TOKEN } }, response => {
                    response.on('data', () => {});
                    response.on('error', () => {});
                    response.on('close', () => resolve({ status: response.statusCode, id: response.headers['x-request-id'], complete: response.complete }));
                });
                req.on('error', error => resolve({ error }));
                req.setTimeout(5000, () => { req.destroy(new Error('sem resposta')); });
            });
            assert.equal(outcome.status, 200);
            assert.equal(outcome.complete, false, 'ZIP pela metade não pode chegar como download completo');
            assert.match(crashLog(), new RegExp(`erro interno ${outcome.id} GET /api/admin/backup/full \\(admin [^)]*\\)\\nError: EIO`));
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    } finally {
        backupUtil.streamFullZip = original;
        console.error = originalError;
    }
});

test('[UC-ERRO-001] sendInternalError: mensagem da rota com o código, sem error.message, e falha de gravação continua 503', () => {
    const fakeRes = () => ({
        headersSent: false, writableEnded: false, statusCode: 200, body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; this.headersSent = true; this.writableEnded = true; return this; },
        end() { this.writableEnded = true; },
    });
    const originalError = console.error;
    console.error = () => {};
    try {
        const custom = fakeRes();
        middlewares.sendInternalError(new Error('ENOSPC: no space left on device'), { id: 'beef0001', method: 'PUT', originalUrl: '/api/admin/material/x' }, custom, 'Falha ao gravar arquivo no disco.');
        assert.equal(custom.statusCode, 500);
        assert.deepEqual(custom.body, { success: false, error: 'Falha ao gravar arquivo no disco. Código do erro: beef0001.', requestId: 'beef0001' });

        const generic = fakeRes();
        middlewares.sendInternalError(new Error('x'), { id: 'beef0002' }, generic);
        assert.equal(generic.body.error, 'Ocorreu um erro interno no servidor. Código do erro: beef0002.');

        const dbWrite = fakeRes();
        middlewares.sendInternalError(Object.assign(new Error('SQLITE_FULL'), { code: 'ICLASS_DB_WRITE' }), { id: 'beef0003' }, dbWrite, 'Falha ao gravar arquivo no disco.');
        assert.equal(dbWrite.statusCode, 503);
        assert.equal(dbWrite.body.retryable, true);
    } finally {
        console.error = originalError;
    }
});

test('[UC-ERRO-001] sendRouteError: recusa prevista mantém status e mensagem; falha inesperada vira 500 com o código; gravação continua 503', () => {
    const fakeRes = () => ({
        headersSent: false, writableEnded: false, statusCode: 200, body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; this.headersSent = true; this.writableEnded = true; return this; },
        end() { this.writableEnded = true; },
    });
    const originalError = console.error;
    console.error = () => {};
    try {
        const refusal = fakeRes();
        middlewares.sendRouteError(Object.assign(new Error('A aplicação está encerrada e não pode ser pausada.'), { status: 409 }), { id: 'feed0001' }, refusal);
        assert.equal(refusal.statusCode, 409);
        assert.deepEqual(refusal.body, { error: 'A aplicação está encerrada e não pode ser pausada.' });

        const invalidId = fakeRes();
        middlewares.sendRouteError(Object.assign(new Error('Identificador inválido.'), { code: 'INVALID_ID' }), { id: 'feed0002' }, invalidId);
        assert.equal(invalidId.statusCode, 400);
        assert.deepEqual(invalidId.body, { error: 'Identificador inválido.' });

        const unexpected = fakeRes();
        middlewares.sendRouteError(new TypeError("Cannot read properties of undefined (reading 'unitNames')"), { id: 'feed0003' }, unexpected);
        assert.equal(unexpected.statusCode, 500);
        assert.deepEqual(unexpected.body, { success: false, error: 'Ocorreu um erro interno no servidor. Código do erro: feed0003.', requestId: 'feed0003' });

        const disk = fakeRes();
        middlewares.sendRouteError(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }), { id: 'feed0004' }, disk, 'Falha ao gravar arquivo no disco.');
        assert.equal(disk.statusCode, 500);
        assert.equal(disk.body.error, 'Falha ao gravar arquivo no disco. Código do erro: feed0004.');

        const dbWrite = fakeRes();
        middlewares.sendRouteError(Object.assign(new Error('SQLITE_FULL'), { code: 'ICLASS_DB_WRITE' }), { id: 'feed0005' }, dbWrite);
        assert.equal(dbWrite.statusCode, 503);
        assert.equal(dbWrite.body.retryable, true);
    } finally {
        console.error = originalError;
    }
});

test('[UC-ERRO-001] parâmetro de caminho com % inválido responde 400 em português', async () => {
    restoreSeed();
    const res = await request(app).get('/api/admin/proctoring-logs/%E0%A4%A/x').set('x-admin-session', ADMIN_TOKEN);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'O endereço pedido tem caracteres inválidos.');
    assert.match(String(res.headers['x-request-id']), REQUEST_ID);
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
    assert.equal(unknown.body.reason, 'expired');
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
    assert.equal(small.body.reason, 'expired');
    assert.equal(db.memory.adminSessions[ADMIN_TOKEN], undefined, 'sessão vencida removida');
});

test('[UC-ERRO-001] lote de teclas grande com sessão de aluno continua aceito (até o H2-C fatiar no cliente); sem sessão fica com 512 KB', async () => {
    restoreSeed();
    // ~4.000 eventos como os do ExamRunner (> 512 KB): o buffer de uma queda longa de rede.
    const events = Array.from({ length: 4000 }, (_, index) => ({
        seq: index + 1, clientTs: Date.now(), key: 'a', code: 'KeyA', mods: '', kind: 'char', question: null,
        blocked: false, suspicious: false, padding: 'x'.repeat(60),
    }));
    const payload = { email: DEMO_ACCOUNTS.student.email, studentClass: '1DES', courseId: 'curso_legacy_01', examKey: 'Avaliacao_FUTEC_5', events };
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 512 * 1024);
    const before = db.memory.examKeystrokes.length;
    const accepted = await request(app).post('/api/student/log-keystrokes').set('x-session-token', STUDENT_TOKEN).send(payload);
    assert.equal(accepted.status, 200, `${accepted.status} ${accepted.body && accepted.body.error}`);
    assert.equal(accepted.body.inserted, 500, 'o servidor guarda no máximo 500 por envio, como antes');
    assert.equal(db.memory.examKeystrokes.length, before + 500);

    const anonymous = await request(app).post('/api/student/log-keystrokes').send(payload);
    assert.equal(anonymous.status, 413);
    const unknown = await request(app).post('/api/student/log-keystrokes').set('x-session-token', 'token-que-nao-existe').send(payload);
    assert.equal(unknown.status, 413);
    // A exceção vale só para o lote de teclas: o caderno do aluno segue com 512 KB.
    const notes = await request(app).post('/api/student/notes/save').set('x-session-token', STUDENT_TOKEN)
        .send({ email: DEMO_ACCOUNTS.student.email, moduleKey: 'geral', note: 'x'.repeat(600 * 1024) });
    assert.equal(notes.status, 413);
    assert.equal(middlewares.hasStudentSessionToken({ headers: { 'x-session-token': STUDENT_TOKEN } }), true);
    assert.equal(middlewares.hasStudentSessionToken({ headers: { 'x-session-token': '__proto__' } }), false);
    assert.equal(middlewares.hasStudentSessionToken({ headers: {} }), false);
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

    // Console: só a linha-resumo quando o bloco foi gravado; o stack inteiro quando o
    // arquivo não pôde ser gravado ou na exceção não tratada (printStack, logCrash).
    const printed = [];
    console.error = (...args) => printed.push(args.join(' '));
    try {
        assert.equal(logError('erro interno', new Error('gravado no arquivo')), true);
        assert.equal(printed.length, 1);
        assert.match(printed[0], /gravado no arquivo \(detalhes em crash\.log\)$/);
        assert.doesNotMatch(printed[0], /\n\s+at /);

        printed.length = 0;
        assert.equal(logError('uncaughtException', new Error('exceção solta'), { printStack: true }), true);
        assert.match(printed[0], /exceção solta \(também em crash\.log\)\n.*Error: exceção solta\n\s+at /s);

        // crash.log impossível de gravar (aqui, uma pasta no lugar dele).
        fs.rmSync(file, { force: true });
        fs.rmSync(`${file}.1`, { force: true });
        fs.mkdirSync(file);
        printed.length = 0;
        assert.equal(logError('erro interno', new Error('disco cheio'), { req: { id: 'cafe0002', method: 'POST', originalUrl: '/api/x' } }), false);
        assert.match(printed[0], /erro interno cafe0002 POST \/api\/x: disco cheio \(crash\.log indisponível\)\nError: disco cheio\n\s+at /);
    } finally {
        console.error = originalError;
        fs.rmSync(file, { recursive: true, force: true });
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
