// Armazenamento do banco (fase 2, H1-c: DES-01, DES-11, CONF-05, CONF-06).
// - Rotas quentes (aluno e Monitor) gravam só as coleções que mudaram (db.save({ only })),
//   em vez de regravar o banco inteiro a cada nota, presença ou rascunho.
// - Rede de segurança: de 10 em 10 min, uma gravação completa leva ao disco o que uma rota
//   anotada tenha esquecido no only, e diz no crash.log quais coleções eram.
// - Espaço recuperável (freeBytes), Compactar (VACUUM) pela tela Sistema só para o
//   administrador, recusado com prova em andamento, e o item "Compactar o banco" no
//   "Precisa de você".
// - Pasta de dados dentro do OneDrive: aviso no console e no cartão.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const request = require('supertest');
const sqlite3 = require('sqlite3');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-armazenamento-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';
process.env.ICLASS_VERIFY_SAVES = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { syncedFolderInfo, SYNCED_FOLDER_WARNING } = require('../../backend/utils/syncedFolder.js');
const { computeQueue } = require('../../backend/utils/dashboardAggregates.js');

const databaseFile = path.join(tempRoot, 'database.db');
const STUDENT = { email: 'armazenamento@teste.local', password: 'senha-do-aluno' };
const adminToken = 'admin-token-armazenamento';
const profToken = 'prof-token-armazenamento';
const QUEUE_URL = '/api/admin/dashboard/queue?courseId=TI&studentClass=1DES';

let app;
let studentToken;

const asAdmin = req => req.set('x-admin-session', adminToken);
const asProfessor = req => req.set('x-admin-session', profToken);

async function readRow(table, key) {
    const reader = new sqlite3.Database(databaseFile);
    try {
        return await new Promise((resolve, reject) => reader.get(`SELECT value FROM ${table} WHERE key = ?`, [key], (err, row) => (err ? reject(err) : resolve(row))));
    } finally {
        await new Promise(resolve => reader.close(() => resolve()));
    }
}

function crashLog() {
    try { return fs.readFileSync(path.join(tempRoot, 'crash.log'), 'utf8'); } catch (e) { return ''; }
}

// Linhas grandes apagadas depois de gravadas: deixam páginas livres dentro do arquivo.
async function createFreeSpace(megabytes = 4) {
    const filler = 'x'.repeat(64 * 1024);
    for (let index = 0; index < megabytes * 16; index += 1) {
        db.memory.notes[`lixo-${index}@teste.local`] = { modulo: filler };
    }
    await db.save({ only: ['notes'] });
    Object.keys(db.memory.notes).filter(key => key.startsWith('lixo-')).forEach(key => delete db.memory.notes[key]);
    await db.save({ only: ['notes'] });
    await db.refreshStorageStats();
}

test.before(async () => {
    await db.init();
    app = createApp();
    db.memory.courses = [{ id: 'TI', name: 'TI', structure: [] }];
    db.memory.classes = [{ name: '1DES', courseId: 'TI', period: 'Manhã', onlineExamConfigs: {} }];
    db.memory.students.push({
        name: 'Aluno do armazenamento',
        email: STUDENT.email,
        password: db.hashPassword(STUDENT.password),
        status: 'Ativo',
        classes: [{ name: '1DES', courseId: 'TI' }],
        studentClass: '1DES',
    });
    db.memory.admins = [
        { email: 'root@armazenamento.local', name: 'Root', role: 'admin', password: db.hashPassword('senha-raiz-ok') },
        {
            email: 'prof@armazenamento.local', name: 'Prof', role: 'professor', password: db.hashPassword('senha-prof-ok'),
            assignedClasses: [{ courseId: 'TI', className: '1DES' }],
            // Mesmo com a tela Sistema liberada, compactar continua só do administrador.
            additionalPermissions: ['page.system', 'system.manage'],
        },
    ];
    db.memory.adminSessions = {
        [adminToken]: { email: 'root@armazenamento.local', createdAt: Date.now(), lastSeen: Date.now() },
        [profToken]: { email: 'prof@armazenamento.local', createdAt: Date.now(), lastSeen: Date.now() },
    };
    await db.save();
    const login = await request(app).post('/api/student/login').send(STUDENT);
    assert.equal(login.status, 200, JSON.stringify(login.body));
    studentToken = login.body.sessionToken;
});

test.after(async () => {
    db.clearSaveVerifyFailures();
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-GRAVACAO-001] rotas quentes do aluno gravam só a coleção que mudou, com o dado no arquivo', async () => {
    db.clearSaveVerifyFailures();
    const cases = [
        { url: '/api/student/notes/save', body: { moduleKey: 'Apostila_1', note: 'parcial' }, collection: 'notes', table: 'notes' },
        { url: '/api/student/progress', body: { completedUnits: { 'Apostila_1::u1': true } }, collection: 'progress', table: 'progress' },
        { url: '/api/student/annotation', body: { key: 'Apostila_1', paragraphId: 'p1', highlightedText: 'trecho', note: 'n' }, collection: 'annotations', table: 'annotations' },
    ];
    for (const item of cases) {
        // Uma gravação completa antes, para o ciclo da rota só ter o que ela mudou.
        await db.save();
        const response = await request(app).post(item.url).set('x-session-token', studentToken).send(item.body);
        assert.equal(response.status, 200, `${item.url}: ${JSON.stringify(response.body)}`);
        const cycle = db.storageStatus().lastCycle;
        assert.equal(cycle.full, false, `${item.url}: antes, cada pedido regravava o banco inteiro (gravação completa)`);
        if (item.table) {
            assert.ok(cycle.collections[item.collection] >= 1, `${item.url}: o ciclo não gravou ${item.collection}`);
            assert.ok(await readRow(item.table, STUDENT.email), `${item.url}: o dado não chegou ao arquivo`);
        }
        assert.equal(db.storageStatus().partialSinceFullSave, true);
    }
    // O verificador (ICLASS_VERIFY_SAVES) não acusou nada fora do only.
    assert.deepEqual(db.saveVerifyFailures.map(item => `${item.path} ${item.collection}`), []);
});

test('[UC-GRAVACAO-001] save resolve com o que o ciclo gravou (linhas por coleção e pedidos juntos)', async () => {
    await db.save();
    db.memory.notes['relatorio@teste.local'] = { a: '1' };
    const report = await db.save({ only: ['notes'] });
    assert.equal(report.full, false);
    assert.equal(report.rows, 1);
    assert.deepEqual(report.collections, { notes: 1 });
    assert.equal(report.requests, 1);
    const nothing = await db.save();
    assert.equal(nothing.full, true);
    assert.equal(nothing.rows, 0);
});

test('[UC-GRAVACAO-001] rede de segurança: a gravação completa leva o esquecido ao disco e diz a coleção no crash.log', async () => {
    await db.save();
    // Sem gravação parcial desde a última completa: nada a fazer.
    assert.deepEqual(await db.runSafetyNetSave({ idleWaitMs: 1000 }), { ran: false, rows: 0, found: 0 });

    // Uma rota que esqueceu uma coleção no only: a anotação muda e só as notas são gravadas.
    db.memory.annotations['esquecida@teste.local'] = { Apostila_1: { p1: { note: 'sem only' } } };
    db.memory.notes['esquecida@teste.local'] = { Apostila_1: 'com only' };
    await db.save({ only: ['notes'] });
    assert.equal(await readRow('annotations', 'esquecida@teste.local'), undefined, 'a anotação não devia estar no arquivo ainda');
    assert.equal(db.storageStatus().partialSinceFullSave, true);

    const before = crashLog().length;
    const result = await db.runSafetyNetSave({ idleWaitMs: 1000 });
    assert.equal(result.ran, true);
    assert.equal(result.found, 1);
    assert.deepEqual(result.collections, { annotations: 1 });
    assert.ok(await readRow('annotations', 'esquecida@teste.local'), 'a rede de segurança não gravou a anotação esquecida');
    const logged = crashLog().slice(before);
    assert.match(logged, /Rede de segurança/);
    assert.match(logged, /annotations \(1\)/);
    assert.equal(db.storageStatus().partialSinceFullSave, false);
    // Logo depois, sem gravação parcial nova, não roda de novo.
    assert.equal((await db.runSafetyNetSave({ idleWaitMs: 1000 })).ran, false);

    // Gravação parcial completa (nada esquecido): roda e não acusa nada.
    db.memory.notes['esquecida@teste.local'] = { Apostila_1: 'outra' };
    await db.save({ only: ['notes'] });
    const clean = await db.runSafetyNetSave({ idleWaitMs: 1000 });
    assert.equal(clean.ran, true);
    assert.equal(clean.found, 0);
    assert.equal(crashLog().slice(before).match(/Rede de segurança/g).length, 1);
});

test('[UC-GRAVACAO-001] rede de segurança espera a prova terminar (teto de 2 h) e grava depois', async () => {
    await db.save();
    db.memory.annotations['adiada@teste.local'] = { Apostila_1: { p1: { note: 'esquecida na prova' } } };
    db.memory.notes['adiada@teste.local'] = { Apostila_1: 'com only' };
    await db.save({ only: ['notes'] });
    db.memory.examApplications.push({ id: 'app-rede', classId: 'TI::1DES', examKey: 'P1', status: 'running' });
    const start = Date.now();
    try {
        // Com prova em andamento a gravação completa espera (contrato do H3c).
        const deferred = await db.runSafetyNetSave({ idleWaitMs: 1000, now: start });
        assert.equal(deferred.ran, false);
        assert.equal(deferred.deferred, true);
        assert.equal(deferred.activeApplications, 1);
        assert.equal(await readRow('annotations', 'adiada@teste.local'), undefined, 'gravou no meio da prova');
        const later = await db.runSafetyNetSave({ idleWaitMs: 1000, now: start + 90 * 60 * 1000 });
        assert.equal(later.deferred, true, 'antes do teto continua esperando');
        // Passou do teto (aplicação esquecida aberta): grava mesmo assim.
        const capped = await db.runSafetyNetSave({ idleWaitMs: 1000, now: start + db.SAFETY_NET_MAX_DEFER_MS });
        assert.equal(capped.ran, true);
        assert.ok(await readRow('annotations', 'adiada@teste.local'), 'depois do teto a rede de segurança grava');
    } finally {
        db.memory.examApplications = db.memory.examApplications.filter(item => item.id !== 'app-rede');
    }
    // Prova encerrada: a rodada seguinte grava na hora, e o teto recomeça na próxima prova.
    db.memory.annotations['adiada@teste.local'].Apostila_1.p1.note = 'depois da prova';
    await db.save({ only: ['notes'] });
    db.memory.examApplications.push({ id: 'app-rede-2', classId: 'TI::1DES', examKey: 'P1', status: 'paused' });
    try {
        assert.equal((await db.runSafetyNetSave({ idleWaitMs: 1000, now: start + db.SAFETY_NET_MAX_DEFER_MS + 1000 })).deferred, true, 'teto recomeça a contar');
    } finally {
        db.memory.examApplications = db.memory.examApplications.filter(item => item.id !== 'app-rede-2');
    }
    const after = await db.runSafetyNetSave({ idleWaitMs: 1000 });
    assert.equal(after.ran, true);
    assert.match((await readRow('annotations', 'adiada@teste.local')).value, /depois da prova/);
});

test('[UC-GRAVACAO-001] rede de segurança: adiamento de uma prova encerrada não vale para a prova seguinte', async () => {
    // Antes, a saída cedo (sem gravação parcial pendente) vinha antes de zerar o marcador
    // do adiamento: a prova 1 terminava com uma gravação completa, o marcador ficava, e a
    // gravação completa rodava logo no primeiro tick da prova 2 (3 h depois > teto de 2 h).
    await db.save();
    const start = Date.now();
    const removeApps = () => {
        db.memory.examApplications = db.memory.examApplications.filter(item => !String(item.id).startsWith('app-seq-'));
    };
    try {
        db.memory.notes['sequencia@teste.local'] = { Apostila_1: 'prova 1' };
        await db.save({ only: ['notes'] });
        db.memory.examApplications.push({ id: 'app-seq-1', classId: 'TI::1DES', examKey: 'P1', status: 'running' });
        assert.equal((await db.runSafetyNetSave({ idleWaitMs: 1000, now: start })).deferred, true);

        // A prova 1 termina com uma gravação completa (o encerrar com tentativas abertas).
        removeApps();
        await db.save();
        assert.equal(db.storageStatus().partialSinceFullSave, false);
        assert.equal((await db.runSafetyNetSave({ idleWaitMs: 1000, now: start + 10 * 60 * 1000 })).ran, false);

        // Prova 2, 3 h depois do primeiro adiamento, com gravação parcial pendente: espera.
        db.memory.examApplications.push({ id: 'app-seq-2', classId: 'TI::1DES', examKey: 'P1', status: 'running' });
        db.memory.annotations['sequencia@teste.local'] = { Apostila_1: { p1: { note: 'na prova 2' } } };
        db.memory.notes['sequencia@teste.local'] = { Apostila_1: 'prova 2' };
        await db.save({ only: ['notes'] });
        const second = await db.runSafetyNetSave({ idleWaitMs: 1000, now: start + 3 * 60 * 60 * 1000 });
        assert.equal(second.ran, false, 'a gravação completa rodou no meio da prova 2');
        assert.equal(second.deferred, true);
        assert.equal(await readRow('annotations', 'sequencia@teste.local'), undefined, 'gravou no meio da prova 2');

        // Provas uma depois da outra, sem tick entre elas: a prova 3 começa com a 2 já
        // encerrada; o adiamento da 2 não conta para a 3 (o teto é da prova esquecida aberta).
        const secondAt = start + 3 * 60 * 60 * 1000;
        const thirdAt = secondAt + 60 * 60 * 1000;
        removeApps();
        db.memory.examApplications.push({ id: 'app-seq-3', classId: 'TI::1DES', examKey: 'P1', status: 'running' });
        assert.equal((await db.runSafetyNetSave({ idleWaitMs: 1000, now: thirdAt })).deferred, true);
        const third = await db.runSafetyNetSave({ idleWaitMs: 1000, now: secondAt + db.SAFETY_NET_MAX_DEFER_MS });
        assert.equal(third.deferred, true, 'o adiamento da prova 2 valeu para a prova 3');

        // Prova esquecida aberta junto com outra que começou depois: o teto conta do
        // primeiro adiamento da esquecida.
        db.memory.examApplications.push({ id: 'app-seq-4', classId: 'TI::1DES', examKey: 'P1', status: 'running' });
        assert.equal((await db.runSafetyNetSave({ idleWaitMs: 1000, now: thirdAt + db.SAFETY_NET_MAX_DEFER_MS - 1000 })).deferred, true);
        const capped = await db.runSafetyNetSave({ idleWaitMs: 1000, now: thirdAt + db.SAFETY_NET_MAX_DEFER_MS });
        assert.equal(capped.ran, true, 'a prova 3 aberta há 2 h não chegou ao teto');
        assert.ok(await readRow('annotations', 'sequencia@teste.local'));
    } finally {
        removeApps();
    }
});

test('[UC-GRAVACAO-001] sync da prova numa turma sem contentOverrides não muda "classes" (verificador em silêncio)', async () => {
    const cls = db.memory.classes.find(item => item.name === '1DES');
    delete cls.contentOverrides;
    await db.save();
    db.clearSaveVerifyFailures();
    const response = await request(app)
        .get('/api/student/sync')
        .query({ email: STUDENT.email, studentClass: '1DES', courseId: 'TI', examKey: 'P1' })
        .set('x-session-token', studentToken);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    // Antes, montar a estrutura da turma criava contentOverrides (padrão) só na memória, e
    // o verificador acusava "GET /api/student/sync alterou classes sem incluir em only".
    assert.equal(cls.contentOverrides, undefined, 'a leitura criou contentOverrides na turma');
    assert.deepEqual(db.saveVerifyFailures.map(item => `${item.path} ${item.collection}`), []);
    const { effectiveStructure, readOverrides } = require('../../backend/utils/classContent.js');
    assert.ok(effectiveStructure('TI', '1DES'));
    assert.equal(cls.contentOverrides, undefined);
    assert.deepEqual(readOverrides(cls), { materials: {}, evaluations: {}, unitNames: {}, extraUnits: [], structure: null });
});

test('[UC-ARMAZENAMENTO-001] espaço recuperável e sugestão de compactar depois de apagar dados', async () => {
    await db.refreshStorageStats();
    const fresh = db.storageStatus();
    assert.equal(typeof fresh.freeBytes, 'number');
    assert.ok(fresh.freeBytesAt);
    assert.equal(fresh.compactSuggested, false, 'banco sem dados apagados não sugere compactar');
    await createFreeSpace(4);
    const status = db.storageStatus();
    assert.ok(status.freeBytes > 3 * 1024 * 1024, `freeBytes ${status.freeBytes}`);
    assert.equal(status.compactSuggested, true);
    assert.equal(status.inSyncedFolder, false);
    assert.equal(status.syncedFolderProvider, null);
});

test('[UC-ARMAZENAMENTO-001] "Compactar o banco" no Precisa de você só para o administrador', async () => {
    await db.refreshStorageStats();
    assert.equal(db.storageStatus().compactSuggested, true, 'pré-condição: espaço livre do teste anterior');
    const admin = await asAdmin(request(app).get(QUEUE_URL));
    assert.equal(admin.status, 200);
    const item = admin.body.find(entry => entry.id === 'compactar_banco');
    assert.ok(item, 'administrador vê a sugestão');
    assert.equal(item.href, '/sistema');
    assert.ok(item.count >= 3);
    // O texto se lê sozinho, com o número (antes: "MB livres dentro do arquivo do banco").
    assert.equal(item.detalhe, `${item.count} MB sem uso dentro do arquivo do banco (${Math.round(db.storageStatus().freeBytes / db.storageStatus().allocatedBytes * 100)}%) · Sistema → Armazenamento`);
    const professor = await asProfessor(request(app).get(QUEUE_URL));
    assert.equal(professor.status, 200);
    assert.ok(!professor.body.some(entry => entry.id === 'compactar_banco'), 'professor (mesmo com system.manage) não vê');
    // computeQueue sem o bloco (rotas antigas, professor) não muda nada.
    const memory = { students: [], classes: [], courses: [] };
    assert.ok(!computeQueue({ memory, cls: null, course: null, students: [], today: '2026-11-10', now: Date.now() }).some(entry => entry.id === 'compactar_banco'));
});

test('[UC-ARMAZENAMENTO-001] GET /api/admin/storage: estado do banco para o cartão, sem o botão para o professor', async () => {
    const anon = await request(app).get('/api/admin/storage');
    assert.equal(anon.status, 401);
    const admin = await asAdmin(request(app).get('/api/admin/storage'));
    assert.equal(admin.status, 200);
    assert.equal(admin.body.canCompact, true);
    assert.equal(admin.body.activeApplications, 0);
    const storage = admin.body.storage;
    assert.ok(storage.databaseBytes > 0);
    assert.equal(typeof storage.walBytes, 'number');
    assert.ok(storage.freeBytes > 0);
    // Base da proporção do espaço recuperável, a mesma do servidor (cartão e fila).
    assert.ok(storage.allocatedBytes >= storage.databaseBytes);
    assert.equal(typeof storage.rows.notes, 'number');
    assert.equal(typeof storage.keystrokes, 'number');
    assert.ok('commitP95Ms' in storage && 'lastFullSaveAt' in storage && 'lastWriteError' in storage);
    assert.equal(storage.inSyncedFolder, false);
    assert.ok(admin.body.diskFreeBytes === null || admin.body.diskFreeBytes > 0);
    const professor = await asProfessor(request(app).get('/api/admin/storage'));
    assert.equal(professor.status, 200);
    assert.equal(professor.body.canCompact, false);
});

test('[UC-ARMAZENAMENTO-001] Compactar: só administrador, com COMPACTAR, nunca com prova em andamento', async () => {
    const professor = await asProfessor(request(app).post('/api/admin/storage/compact')).send({ confirm: 'COMPACTAR' });
    assert.equal(professor.status, 403);
    assert.match(professor.body.error, /administradores/);

    const unconfirmed = await asAdmin(request(app).post('/api/admin/storage/compact')).send({});
    assert.equal(unconfirmed.status, 400);
    assert.equal(unconfirmed.body.error, 'Digite COMPACTAR para confirmar.');
    // Só texto: ['COMPACTAR'] passava no String() e chegava à compactação.
    for (const confirm of [['COMPACTAR'], { 0: 'COMPACTAR' }, 1]) {
        const wrongType = await asAdmin(request(app).post('/api/admin/storage/compact')).send({ confirm });
        assert.equal(wrongType.status, 400, JSON.stringify(confirm));
        assert.equal(wrongType.body.error, 'Digite COMPACTAR para confirmar.');
    }

    db.memory.examApplications.push({ id: 'app-armazenamento', classId: 'TI::1DES', examKey: 'P1', status: 'running' });
    try {
        const busy = await asAdmin(request(app).post('/api/admin/storage/compact')).send({ confirm: 'COMPACTAR' });
        assert.equal(busy.status, 409);
        assert.equal(busy.body.error, 'Há prova em andamento. Compacte o banco depois que as provas terminarem.');
        assert.equal(busy.body.activeApplications, 1);
    } finally {
        db.memory.examApplications = db.memory.examApplications.filter(item => item.id !== 'app-armazenamento');
    }
    assert.equal(db.memory.auditLogs.filter(entry => entry.action === 'storage_compacted').length, 0, 'recusa não registra compactação');
});

test('[UC-ARMAZENAMENTO-001] Compactar confere de novo a prova em andamento logo antes do VACUUM (sobra do H1-c, J2)', async () => {
    await db.flush();
    await db.refreshStorageStats();
    const freeBefore = db.storageStatus().freeBytes;
    assert.ok(freeBefore > 3 * 1024 * 1024, 'pré-condição: espaço livre dos testes anteriores');
    // A prova começa enquanto a rota espera as PRAGMAs e o disco (depois da 1ª conferência).
    const originalRefresh = db.refreshStorageStats;
    db.refreshStorageStats = async () => {
        if (!db.memory.examApplications.some(item => item.id === 'app-durante-a-espera')) {
            db.memory.examApplications.push({ id: 'app-durante-a-espera', classId: 'TI::1DES', examKey: 'P1', status: 'running' });
        }
        return originalRefresh();
    };
    try {
        const late = await asAdmin(request(app).post('/api/admin/storage/compact')).send({ confirm: 'COMPACTAR' });
        assert.equal(late.status, 409, `antes, ${late.status}: o VACUUM rodava com a prova aberta`);
        assert.equal(late.body.error, 'Há prova em andamento. Compacte o banco depois que as provas terminarem.');
        assert.equal(late.body.activeApplications, 1);
    } finally {
        db.refreshStorageStats = originalRefresh;
        db.memory.examApplications = db.memory.examApplications.filter(item => item.id !== 'app-durante-a-espera');
    }
    await db.refreshStorageStats();
    assert.ok(db.storageStatus().freeBytes >= freeBefore, 'o VACUUM não rodou');
    assert.equal(db.memory.auditLogs.filter(entry => entry.action === 'storage_compacted').length, 0, 'recusa não registra compactação');
});

test('[UC-ARMAZENAMENTO-001] Compactar devolve o espaço ao disco, registra na auditoria e não perde dados', async () => {
    await db.flush();
    await db.refreshStorageStats();
    const before = db.storageStatus();
    assert.ok(before.freeBytes > 3 * 1024 * 1024, 'pré-condição: espaço livre dos testes anteriores');
    const response = await asAdmin(request(app).post('/api/admin/storage/compact')).send({ confirm: 'compactar' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(response.body.depois < response.body.antes, `antes ${response.body.antes}, depois ${response.body.depois}`);
    assert.ok(response.body.antes - response.body.depois > 2 * 1024 * 1024);
    // O espaço vazio devolvido vem à parte (o antes soma o -wal, que o checkpoint zera).
    assert.ok(Math.abs(response.body.recuperadoBytes - (before.freeBytes - response.body.storage.freeBytes)) <= 64 * 1024, `recuperadoBytes ${response.body.recuperadoBytes}, livre antes ${before.freeBytes}`);
    assert.ok(response.body.recuperadoBytes > 2 * 1024 * 1024);
    assert.equal(typeof response.body.ms, 'number');
    assert.ok(response.body.storage.freeBytes < 64 * 1024, `freeBytes depois: ${response.body.storage.freeBytes}`);
    assert.equal(response.body.storage.compactSuggested, false);
    // O checkpoint zerou o -wal (sobra só a gravação da auditoria, feita depois) e o
    // arquivo encolheu de verdade.
    assert.ok(response.body.storage.walBytes < 64 * 1024, `walBytes ${response.body.storage.walBytes}`);
    assert.ok(fs.statSync(databaseFile).size < before.databaseBytes);
    const audit = db.memory.auditLogs.filter(entry => entry.action === 'storage_compacted');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].category, 'system');
    assert.equal(audit[0].actor, 'root@armazenamento.local');
    assert.ok(audit[0].details.antes > audit[0].details.depois);
    assert.equal(audit[0].details.recuperadoBytes, response.body.recuperadoBytes);
    // Os dados continuam lá, e gravar depois funciona.
    assert.equal(JSON.parse((await readRow('notes', STUDENT.email)).value).Apostila_1, 'parcial');
    const note = await request(app).post('/api/student/notes/save').set('x-session-token', studentToken).send({ moduleKey: 'Apostila_2', note: 'depois do vacuum' });
    assert.equal(note.status, 200);
    assert.equal(JSON.parse((await readRow('notes', STUDENT.email)).value).Apostila_2, 'depois do vacuum');
    // Sem o item na fila depois de compactar.
    const queue = await asAdmin(request(app).get(QUEUE_URL));
    assert.ok(!queue.body.some(entry => entry.id === 'compactar_banco'));
});

test('[UC-ARMAZENAMENTO-001] a fila renova o espaço livre sozinha, no máximo uma vez por minuto (sobra do H1-c, J2)', async () => {
    // Espaço livre novo sem ninguém reler as PRAGMAs (nem o cartão Armazenamento).
    const filler = 'x'.repeat(64 * 1024);
    for (let index = 0; index < 4 * 16; index += 1) db.memory.notes[`fila-${index}@teste.local`] = { modulo: filler };
    await db.save({ only: ['notes'] });
    Object.keys(db.memory.notes).filter(key => key.startsWith('fila-')).forEach(key => delete db.memory.notes[key]);
    await db.save({ only: ['notes'] });
    // Valor guardado há menos de 1 min: a fila usa o guardado (limite de frequência).
    const recent = await asAdmin(request(app).get(QUEUE_URL));
    assert.equal(recent.status, 200);
    assert.ok(!recent.body.some(entry => entry.id === 'compactar_banco'));
    // Passado 1 min, o mesmo pedido da fila relê as PRAGMAs antes de montar o item. Antes,
    // a primeira consulta respondia com o valor velho e só pedia a leitura em segundo plano.
    const realNow = Date.now;
    Date.now = () => realNow() + 61000;
    try {
        const later = await asAdmin(request(app).get(QUEUE_URL));
        assert.equal(later.status, 200);
        assert.ok(later.body.some(entry => entry.id === 'compactar_banco'), 'o item aparece sem abrir o cartão Armazenamento');
    } finally {
        Date.now = realNow;
    }
    const professor = await asProfessor(request(app).get(QUEUE_URL));
    assert.ok(!professor.body.some(entry => entry.id === 'compactar_banco'));
});

test('[UC-ARMAZENAMENTO-001] pasta do OneDrive: regras do caminho (Windows e variáveis do sistema)', () => {
    const env = { OneDrive: 'C:\\Users\\alan\\OneDrive - Escola' };
    assert.deepEqual(syncedFolderInfo('C:\\Users\\alan\\OneDrive - Escola\\IClass\\data', env), { inSyncedFolder: true, provider: 'OneDrive' });
    assert.equal(syncedFolderInfo('c:/users/ALAN/onedrive - escola/IClass/data', env).inSyncedFolder, true);
    assert.equal(syncedFolderInfo('D:\\Documentos\\OneDrive\\IClass\\data', {}).inSyncedFolder, true);
    assert.equal(syncedFolderInfo('D:\\Sync\\IClass\\data', { OneDriveCommercial: 'D:\\Sync' }).inSyncedFolder, true);
    assert.equal(syncedFolderInfo('C:\\IClass\\data', env).inSyncedFolder, false);
    assert.equal(syncedFolderInfo('C:\\Users\\alan\\OneDriveBackup2\\IClass', {}).inSyncedFolder, true);
    assert.equal(syncedFolderInfo('C:\\Users\\alan\\Documentos\\Meu-OneDrive\\IClass', {}).inSyncedFolder, false);
    assert.equal(syncedFolderInfo('', env).inSyncedFolder, false);
    assert.match(SYNCED_FOLDER_WARNING, /OneDrive/);
});

test('[UC-ARMAZENAMENTO-001] pasta de dados dentro do OneDrive: aviso no console do boot e no estado', async () => {
    const dataDir = path.join(tempRoot, 'OneDrive - Escola', 'IClass', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const script = `
        const db = require(${JSON.stringify(path.join(__dirname, '..', '..', 'backend', 'database.js'))});
        const { prepareServer } = require(${JSON.stringify(path.join(__dirname, '..', '..', 'backend', 'server.js'))});
        prepareServer().then(() => {
            const status = db.storageStatus();
            console.log('STATUS=' + JSON.stringify({ inSyncedFolder: status.inSyncedFolder, provider: status.syncedFolderProvider }));
            process.exit(0);
        }).catch(err => { console.error(err); process.exit(1); });
    `;
    const env = { ...process.env, ICLASS_DATA_DIR: dataDir, ICLASS_CONTENT_DIR: path.join(dataDir, 'content'), ICLASS_ARCHIVE_DIR: path.join(dataDir, 'archives'), TEST_MODE: '1' };
    delete env.NODE_TEST_CONTEXT;
    delete env.ICLASS_VERIFY_SAVES;
    const child = spawn(process.execPath, ['-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise(resolve => child.once('exit', resolve));
    assert.equal(code, 0, output);
    assert.ok(output.includes(SYNCED_FOLDER_WARNING), `sem o aviso no console: ${output}`);
    const match = output.match(/STATUS=(\{.*\})/);
    assert.ok(match, output);
    assert.deepEqual(JSON.parse(match[1]), { inSyncedFolder: true, provider: 'OneDrive' });
});
