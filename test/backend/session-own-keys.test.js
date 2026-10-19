// Sessão por nome herdado: '__proto__', 'constructor', 'toString', 'hasOwnProperty' e
// 'valueOf' como token de instrutor (cabeçalho x-admin-session ou ?access=), como token ou
// e-mail de aluno e como chave gravada a partir do pedido (anotação do aluno, liberação
// individual). Antes, db.memory.adminSessions['__proto__'] devolvia o valor herdado de
// Object.prototype e valia como sessão de instrutor: /api/data.js respondia 200 com as
// avaliações e /uploads entregava arquivo protegido, sem login. Cada teste falha no
// código antigo, salvo os de e-mail e token de aluno, que já davam 401 e ficam de guarda.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-own-keys-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const runtimePaths = require('../../backend/runtimePaths.js');
const { getReleasedItemsForClass } = require('../../backend/middlewares.js');
const { createApp } = require('../../backend/server.js');

const INHERITED_NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];
const COURSE = 'curso-chaves';
const EXAM_KEY = 'Avaliacao_CHV_1';
const ANSWER_KEY = `Gabarito_${EXAM_KEY}`;
const adminToken = 'admin-token-chaves';
const profToken = 'prof-token-chaves';
const anaToken = 'token-ana-chaves';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = Buffer.from('%PDF-1.4\n% arquivo protegido\n');
let app;

function writeFiles() {
    fs.mkdirSync(path.join(runtimePaths.CONTENT_DIR, 'imagens'), { recursive: true });
    fs.mkdirSync(runtimePaths.UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(runtimePaths.UPLOADS_DIR, 'protegido.pdf'), PDF);
    fs.writeFileSync(path.join(runtimePaths.CONTENT_DIR, 'imagens', 'capa.png'), PNG);
    fs.writeFileSync(path.join(runtimePaths.CONTENT_DIR, 'Apostila_CHV_1.md'),
        '# Unidade 1\n\nTexto da unidade.\n\n## Gabarito do professor\n\n1) B\n');
}

function seed() {
    db.memory.config = { ...(db.memory.config || {}), settings: {} };
    db.memory.admins = [
        { email: 'admin@chaves.local', name: 'Admin', role: 'admin', password: db.hashPassword('senha-admin') },
        { email: 'prof@chaves.local', name: 'Professor', role: 'professor', password: db.hashPassword('senha-prof'),
            assignedClasses: [{ courseId: COURSE, className: 'TURMA A' }] },
    ];
    db.memory.adminSessions = {
        [adminToken]: { email: 'admin@chaves.local', createdAt: Date.now(), lastSeen: Date.now() },
        [profToken]: { email: 'prof@chaves.local', createdAt: Date.now(), lastSeen: Date.now() },
    };
    db.memory.courses = [{ id: COURSE, name: 'Curso Chaves', structure: [{ id: 'CHV', name: 'Módulo', units: [
        { id: '1', name: 'Unidade 1', apostilaKey: 'Apostila_CHV_1', avaliacaoKey: EXAM_KEY },
    ] }] }];
    db.memory.classes = [
        { name: 'TURMA A', courseId: COURSE, period: 'Manhã', releasedItems: {}, onlineExamConfigs: {} },
        // Fora do escopo do professor.
        { name: 'TURMA C', courseId: COURSE, period: 'Tarde', releasedItems: {}, onlineExamConfigs: {} },
    ];
    db.memory.evaluations = {
        [EXAM_KEY]: { key: EXAM_KEY, title: 'Prova sigilosa', questions: [
            { number: 1, text: 'Enunciado sigiloso', alternatives: { A: 'um', B: 'dois' }, correctAnswer: 'B' },
        ] },
    };
    db.memory.students = [
        { name: 'Ana', email: 'ana@chaves.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: 'TURMA A', courseId: COURSE }], studentClass: 'TURMA A' },
        { name: 'Caio', email: 'caio@chaves.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: 'TURMA C', courseId: COURSE }], studentClass: 'TURMA C' },
    ];
    db.memory.sessions = {
        'ana@chaves.local': { token: anaToken, lastSeen: Date.now(), createdAt: Date.now(), ip: '::ffff:127.0.0.1' },
    };
    db.memory.annotations = {};
    db.memory.library = [];
    db.memory.branding = {};
    db.memory.forum = [];
    db.memory.announcements = [];
    db.memory.submissions = [];
    db.memory.attendance = [];
    db.memory.studentExamState = {};
    db.memory.proctoringLogs = [];
    db.memory.examApplications = [];
    db.memory.auditLogs = [];
    db.memory.loginLogs = [];
}

// Alvos que o código antigo alcançava ao ler mapa[nomeHerdado] e gravar dentro dele.
function inheritedTargets() {
    return [Object.prototype, Object, Object.prototype.toString, Object.prototype.hasOwnProperty, Object.prototype.valueOf];
}

function cleanInherited(prop) {
    inheritedTargets().forEach(target => { delete target[prop]; });
}

function assertNoInheritedWrite(prop, context) {
    inheritedTargets().forEach(target => {
        assert.equal(Object.prototype.hasOwnProperty.call(target, prop), false, `${context}: gravou "${prop}" em ${target === Object.prototype ? 'Object.prototype' : target.name || 'Object'}`);
    });
    assert.equal(({})[prop], undefined, `${context}: todo objeto passou a ter "${prop}"`);
}

test.before(async () => { await db.init(); app = createApp(); });
test.beforeEach(() => { writeFiles(); seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-AUTH-001] nome herdado no cabeçalho x-admin-session não é sessão de instrutor', async () => {
    // Sessão de verdade continua valendo (controle do teste).
    const real = await request(app).get('/api/data.js').set('x-admin-session', adminToken);
    assert.equal(real.status, 200);
    assert.match(real.text, /Enunciado sigiloso/);

    for (const name of INHERITED_NAMES) {
        const data = await request(app).get('/api/data.js').set('x-admin-session', name);
        assert.equal(data.status, 401, `/api/data.js com "${name}" respondeu ${data.status} (antes: 200 com as avaliações)`);
        assert.doesNotMatch(data.text, /Enunciado sigiloso|Prova sigilosa/);
        await request(app).get('/data.js').set('x-admin-session', name).expect(401);

        const status = await request(app).get('/api/status').query({ studentClass: 'TURMA A', courseId: COURSE }).set('x-admin-session', name);
        assert.equal(status.status, 401, `/api/status com "${name}" respondeu ${status.status}`);

        const markdown = await request(app).get('/Apostila_CHV_1.md').set('x-admin-session', name);
        assert.equal(markdown.status, 401, `apostila com "${name}" respondeu ${markdown.status} (antes: 200 com o gabarito do professor)`);
        assert.doesNotMatch(markdown.text, /Gabarito do professor/);

        await request(app).get('/api/admin/whoami').set('x-admin-session', name).expect(401);
        await request(app).get('/api/courses').set('x-admin-session', name).expect(401);
        await request(app).post('/api/session/logout').set('x-admin-session', name).expect(401);
        await request(app).get('/api/forum').query({ key: 'geral' }).set('x-admin-session', name).expect(401);
    }
});

test('[UC-AUTH-001] nome herdado em ?access= ou como token no cabeçalho não entrega arquivo protegido', async () => {
    await request(app).get('/uploads/protegido.pdf').set('x-admin-session', adminToken).expect(200);
    await request(app).get(`/uploads/protegido.pdf?access=${adminToken}`).expect(200);

    for (const name of INHERITED_NAMES) {
        const byQuery = await request(app).get(`/uploads/protegido.pdf?access=${encodeURIComponent(name)}`);
        assert.equal(byQuery.status, 401, `/uploads?access=${name} respondeu ${byQuery.status} (antes: 200 com o arquivo)`);
        assert.doesNotMatch(byQuery.text || '', /arquivo protegido/);
        await request(app).get('/uploads/protegido.pdf').set('x-admin-session', name).expect(401);
        // O token de aluno também passa por sendControlledFile: com '__proto__' ele
        // caía na tabela de sessões de instrutor.
        await request(app).get('/uploads/protegido.pdf').set('x-session-token', name).expect(401);
        // Link antigo com access= repetido: vale o último.
        await request(app).get(`/uploads/protegido.pdf?access=${adminToken}&access=${encodeURIComponent(name)}`).expect(401);
        await request(app).get(`/imagens/capa.png?access=${encodeURIComponent(name)}`).expect(401);
    }
});

test('[UC-AUTH-001] nome herdado como sessão de instrutor não fura o modo manutenção', async () => {
    db.memory.config.settings = { maintenance: { enabled: true, message: 'Sistema em manutenção para teste.' } };
    // O instrutor de verdade passa (o painel desliga a manutenção); a rota pede o e-mail.
    const realAdmin = await request(app).get('/api/ping').set('x-admin-session', adminToken);
    assert.notEqual(realAdmin.status, 503);
    for (const name of INHERITED_NAMES) {
        const ping = await request(app).get('/api/ping').query({ email: 'ana@chaves.local' }).set('x-session-token', anaToken).set('x-admin-session', name);
        assert.equal(ping.status, 503, `manutenção com "${name}" respondeu ${ping.status}`);
        assert.equal(ping.body.maintenance, true);
        await request(app).get('/Apostila_CHV_1.md').set('x-admin-session', name).expect(503);
    }
});

test('[UC-AUTH-001] nome herdado como e-mail ou token de aluno dá 401', async () => {
    // Login normal (controle do teste).
    const login = await request(app).post('/api/student/login').send({ email: 'ana@chaves.local', password: '123' });
    assert.equal(login.status, 200);
    const sessionToken = login.body.sessionToken;
    await request(app).get('/api/student/progress').query({ email: 'ana@chaves.local' }).set('x-session-token', sessionToken).expect(200);

    for (const name of INHERITED_NAMES) {
        await request(app).post('/api/student/login').send({ email: name, password: '123' }).expect(401);
        // E-mail herdado sem token, na query e no corpo.
        await request(app).get('/api/student/sync').query({ email: name, studentClass: 'TURMA A', courseId: COURSE }).expect(401);
        await request(app).get('/api/ping').query({ email: name }).expect(401);
        await request(app).post('/api/student/notes/get').send({ email: name, moduleKey: 'Apostila_CHV_1' }).expect(401);
        await request(app).post('/api/student/leave').set('Content-Type', 'text/plain').send(name).expect(401);
        // E-mail herdado com o token de outra conta: a identidade não confere.
        await request(app).get('/api/student/sync').query({ email: name, studentClass: 'TURMA A', courseId: COURSE }).set('x-session-token', sessionToken).expect(403);
        // Token herdado.
        await request(app).get('/api/student/progress').query({ email: 'ana@chaves.local' }).set('x-session-token', name).expect(401);
        await request(app).get('/api/status').query({ studentClass: 'TURMA A', courseId: COURSE }).set('x-session-token', name).expect(401);
        await request(app).get('/api/data.js').query({ courseId: COURSE, sessionToken: name }).expect(401);
        await request(app).get('/Apostila_CHV_1.md').set('x-session-token', name).expect(401);
    }
});

test('[UC-AUTH-001] anotação com unidade ou parágrafo de nome herdado é recusada e não grava em Object.prototype', async () => {
    const prop = 'iclassAnotacaoTeste';
    try {
        const ok = await request(app).post('/api/student/annotation').set('x-session-token', anaToken)
            .send({ email: 'ana@chaves.local', key: 'Apostila_CHV_1', paragraphId: 'p1', highlightedText: 'texto', note: 'nota' });
        assert.equal(ok.status, 200);
        const listed = await request(app).get('/api/student/annotations').query({ email: 'ana@chaves.local', key: 'Apostila_CHV_1' }).set('x-session-token', anaToken);
        assert.equal(listed.body.annotations.p1.note, 'nota');

        for (const name of INHERITED_NAMES) {
            const res = await request(app).post('/api/student/annotation').set('x-session-token', anaToken)
                .send({ email: 'ana@chaves.local', key: name, paragraphId: prop, highlightedText: 'x', note: 'y' });
            assert.equal(res.status, 400, `anotação na unidade "${name}" respondeu ${res.status}`);
            assertNoInheritedWrite(prop, `unidade "${name}"`);
            // Apagar (nota e destaque nulos) também não alcança o que é herdado.
            await request(app).post('/api/student/annotation').set('x-session-token', anaToken)
                .send({ email: 'ana@chaves.local', key: name, paragraphId: 'toString', highlightedText: null, note: null })
                .expect(400);
            assert.equal(typeof Object.prototype.toString, 'function');

            const paragraph = await request(app).post('/api/student/annotation').set('x-session-token', anaToken)
                .send({ email: 'ana@chaves.local', key: 'Apostila_CHV_1', paragraphId: name, highlightedText: 'x', note: 'y' });
            assert.equal(paragraph.status, 400, `anotação no parágrafo "${name}" respondeu ${paragraph.status}`);
        }
        assert.deepEqual(Object.keys(db.memory.annotations['ana@chaves.local']), ['Apostila_CHV_1']);
        assert.deepEqual(Object.keys(db.memory.annotations['ana@chaves.local'].Apostila_CHV_1), ['p1']);
    } finally {
        cleanInherited(prop);
    }
});

test('[UC-AUTH-001] liberação individual para aluno de nome herdado não libera o gabarito nas outras turmas', async () => {
    const turmaC = () => db.memory.classes.find(cls => cls.name === 'TURMA C');
    try {
        // Liberação individual normal do professor (controle do teste).
        await request(app).post('/api/admin/release-item').set('x-admin-session', profToken)
            .send({ studentClass: 'TURMA A', courseId: COURSE, itemKey: ANSWER_KEY, released: true, studentEmail: 'ana@chaves.local' })
            .expect(200);
        // A TURMA C não é do professor.
        await request(app).post('/api/admin/release-item').set('x-admin-session', profToken)
            .send({ studentClass: 'TURMA C', courseId: COURSE, itemKey: ANSWER_KEY, released: true })
            .expect(403);

        for (const name of INHERITED_NAMES) {
            const res = await request(app).post('/api/admin/release-item').set('x-admin-session', profToken)
                .send({ studentClass: 'TURMA A', courseId: COURSE, itemKey: ANSWER_KEY, released: true, studentEmail: name });
            // O e-mail vai em minúsculas: 'tostring', 'hasownproperty' e 'valueof' são
            // chaves comuns; '__proto__' e 'constructor' continuam herdadas e são recusadas.
            if (name.toLowerCase() in Object.prototype) {
                assert.equal(res.status, 400, `liberação para "${name}" respondeu ${res.status}`);
            }
            assertNoInheritedWrite(ANSWER_KEY, `aluno "${name}"`);
            assert.notEqual(getReleasedItemsForClass(turmaC(), 'caio@chaves.local')[ANSWER_KEY], true,
                `gabarito liberado na TURMA C (fora do escopo) depois da liberação para "${name}"`);
            assert.notEqual(getReleasedItemsForClass(db.memory.classes[0], '')[ANSWER_KEY], true);
        }
        assert.equal(getReleasedItemsForClass(db.memory.classes[0], 'ana@chaves.local')[ANSWER_KEY], true);
    } finally {
        cleanInherited(ANSWER_KEY);
    }
});

test('[UC-AUTH-001] login de instrutor e sair continuam funcionando', async () => {
    const whoami = await request(app).get('/api/admin/whoami').set('Authorization', 'prof@chaves.local:senha-prof');
    assert.equal(whoami.status, 200);
    const token = whoami.body.sessionToken;
    assert.ok(token && token in db.memory.adminSessions);
    await request(app).get('/api/data.js').set('x-admin-session', token).expect(200);
    await request(app).post('/api/session/logout').set('x-admin-session', token).expect(200);
    assert.equal(Object.prototype.hasOwnProperty.call(db.memory.adminSessions, token), false);
    await request(app).get('/api/data.js').set('x-admin-session', token).expect(401);
});
