// Histórico de digitação da prova em tabela própria (fase 2, H1-b: DES-02, CONF-06).
// As teclas saíram de db.memory: ficam na tabela exam_keystroke_events, com contadores
// na memória, e todo acesso passa por db.keystrokes (utils/keystrokeStore.js). Aqui:
// migração idempotente da tabela antiga, contrato de log-keystrokes e de
// exam-keystrokes (cursor pelo row_id, hasMore, logs), teto por aluno e aplicação,
// Monitor e manutenção pelos contadores, exclusão e troca de e-mail do aluno, cortes
// dos campos, 503 com o banco travado e resposta só depois do COMMIT.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const request = require('supertest');
const sqlite3 = require('sqlite3');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-keystrokes-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';
// Trava do teste de 503: curta, para o pedido não esperar os 5 s padrão.
process.env.ICLASS_DB_BUSY_TIMEOUT_MS = '300';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');

// Tabelas no arquivo: a nova (uma linha por tecla) e a antiga (JSON por tecla, até a fase 1).
const KEYSTROKE_TABLE = 'exam_keystroke_events';
const LEGACY_KEYSTROKE_TABLE = 'exam_keystrokes';

const childScript = path.join(__dirname, 'fixtures', 'keystroke-child.js');
const databaseFile = path.join(tempRoot, 'database.db');

let app;
const adminToken = 'admin-token-teclas';
const adminEmail = 'admin@teclas.local';
const courseId = 'curso-teclas';
const className = 'Turma Teclas';
const examKey = 'Prova_Teclas';
const students = {
    ana: { email: 'ana@teclas.local', token: 'token-ana-teclas' },
    bia: { email: 'bia@teclas.local', token: 'token-bia-teclas' },
    caio: { email: 'caio@teclas.local', token: 'token-caio-teclas' },
    duda: { email: 'duda@teclas.local', token: 'token-duda-teclas' },
    eva: { email: 'eva@teclas.local', token: 'token-eva-teclas' },
    fabi: { email: 'fabi@teclas.local', token: 'token-fabi-teclas' },
};

test.before(async () => {
    await db.init();
    app = createApp();
    db.memory.admins = [{ email: adminEmail, name: 'Admin', role: 'admin', password: db.hashPassword('senha-administrativa') }];
    db.memory.adminSessions = { [adminToken]: { email: adminEmail, createdAt: Date.now(), lastSeen: Date.now() } };
    db.memory.courses = [{ id: courseId, structure: [{ name: 'Módulo', units: [{ name: 'Unidade 1', avaliacaoKey: examKey }] }] }];
    db.memory.classes = [{ name: className, courseId, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} }];
    db.memory.students = Object.entries(students).map(([name, student]) => ({
        name: name[0].toUpperCase() + name.slice(1),
        email: student.email,
        status: 'Ativo',
        password: db.hashPassword('senha-do-aluno'),
        classes: [{ name: className, courseId }],
    }));
    db.memory.sessions = Object.fromEntries(Object.values(students).map(student => [
        student.email,
        { token: student.token, lastSeen: Date.now(), createdAt: Date.now(), ip: '127.0.0.1' },
    ]));
    // Duas aplicações da mesma prova na turma: a de antes (encerrada) e a atual. As duas
    // registram toda a digitação (keystrokeMode 'tudo', H8b): estes testes são do
    // armazenamento das teclas; o filtro de cada modo fica em lgpd-teclas.test.js.
    db.memory.examApplications = [
        { id: 'app-anterior', examKey, studentClass: className, courseId, status: 'finished', keystrokeMode: 'tudo', createdAt: new Date(Date.now() - 86400000).toISOString() },
        { id: 'app-atual', examKey, studentClass: className, courseId, status: 'running', keystrokeMode: 'tudo', createdAt: new Date().toISOString() },
    ];
    db.memory.studentExamState = {};
    db.memory.submissions = [];
    db.memory.proctoringLogs = [];
    await db.save();
});

test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

function admin(method, url) {
    return request(app)[method](url).set('x-admin-session', adminToken);
}

function sendKeys(student, body) {
    return request(app).post('/api/student/log-keystrokes').set('x-session-token', student.token)
        .send({ studentClass: className, courseId, examKey, ...body });
}

function liveView(email, { examKey: exam = examKey, ...query } = {}) {
    return admin('get', `/api/admin/exam-keystrokes/${encodeURIComponent(className)}/${encodeURIComponent(exam)}`)
        .query({ email, ...query });
}

const keys = (from, count, extra = {}) => Array.from({ length: count }, (_, index) => ({
    seq: from + index,
    clientTs: 1700000000000 + from + index,
    key: String.fromCharCode(97 + ((from + index) % 26)),
    code: 'KeyA',
    kind: 'key',
    question: '1',
    ...extra,
}));

// Leitura direta do arquivo por outra conexão (o que está gravado de fato).
async function fileCount(sql, params = []) {
    const reader = new sqlite3.Database(databaseFile, sqlite3.OPEN_READONLY);
    try {
        return await new Promise((resolve, reject) => reader.get(sql, params, (err, row) => (err ? reject(err) : resolve(row.n))));
    } finally {
        await new Promise(resolve => reader.close(() => resolve()));
    }
}

const savedFor = email => fileCount(`SELECT COUNT(*) AS n FROM ${KEYSTROKE_TABLE} WHERE student_email = ?`, [email]);

function runChild(dataDir, scenario, argument, extraEnv = {}) {
    const env = {
        ...process.env,
        ICLASS_DATA_DIR: dataDir,
        ICLASS_CONTENT_DIR: path.join(dataDir, 'content'),
        ICLASS_ARCHIVE_DIR: path.join(dataDir, 'archives'),
        TEST_MODE: '1',
        ...extraEnv,
    };
    delete env.NODE_TEST_CONTEXT;
    delete env.ICLASS_DB_BUSY_TIMEOUT_MS;
    const args = [childScript, scenario];
    if (argument !== undefined) args.push(String(argument));
    return new Promise((resolve, reject) => {
        execFile(process.execPath, args, { env, encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            const marker = String(stdout || '').lastIndexOf('@@');
            if (marker < 0) {
                reject(new Error(`processo filho (${scenario}) sem resultado: ${(err && err.message) || ''}\n${stderr}`));
                return;
            }
            const result = JSON.parse(stdout.slice(marker + 2));
            if (result.fatal) {
                reject(new Error(`processo filho (${scenario}) falhou: ${result.fatal}\n${stderr}`));
                return;
            }
            resolve({ ...result, stdout: stdout.slice(0, marker), stderr });
        });
    });
}

// Banco da versão anterior: teclas como JSON na tabela chave-valor exam_keystrokes.
async function createLegacyDatabase(dataDir, rows) {
    fs.mkdirSync(dataDir, { recursive: true });
    const connection = new sqlite3.Database(path.join(dataDir, 'database.db'));
    const run = (sql, params = []) => new Promise((resolve, reject) => connection.run(sql, params, err => (err ? reject(err) : resolve())));
    await run(`CREATE TABLE IF NOT EXISTS ${LEGACY_KEYSTROKE_TABLE} (key TEXT PRIMARY KEY, value TEXT)`);
    for (const [key, value] of rows) await run(`INSERT INTO ${LEGACY_KEYSTROKE_TABLE} (key, value) VALUES (?, ?)`, [key, value]);
    await new Promise(resolve => connection.close(() => resolve()));
}

// ---------------------------------------------------------------- migração

test('[UC-DIGITACAO-001] boot migra as teclas da tabela antiga uma vez só, sem perder linha ilegível', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-keystrokes-migra-'));
    try {
        const legacy = (id, extra = {}) => [id, JSON.stringify({
            id,
            studentEmail: 'ana@migra.local',
            studentClass: '1DES',
            courseId: 'curso-migra',
            examKey: 'Prova_Migra',
            applicationId: 'app-migra',
            attemptId: 'tentativa-1',
            seq: 1,
            clientTs: 1700000000000,
            serverTs: 1700000000500,
            key: 'a',
            code: 'KeyA',
            mods: '',
            kind: 'key',
            question: '1',
            blocked: false,
            suspicious: false,
            ...extra,
        })];
        await createLegacyDatabase(dataDir, [
            legacy('antiga-1', { seq: 3, key: 'c', suspicious: true }),
            legacy('antiga-2', { seq: 1, studentEmail: '  ANA@Migra.Local ', key: 'a' }),
            legacy('antiga-3', { seq: 2, key: 'b', blocked: true, applicationId: null, question: 7 }),
            ['ilegivel-1', '{"studentEmail": "ana@migra.local", '],
            legacy('sem-prova', { examKey: '' }),
            // Chave maior que o campo id: entra cortada e sai da tabela antiga do mesmo jeito.
            legacy(`longa-${'k'.repeat(250)}`, { studentEmail: 'longo@migra.local' }),
        ]);

        const first = await runChild(dataDir, 'migrate');
        assert.deepEqual(first.uncaught, []);
        assert.match(first.stdout, /Migrando histórico de digitação \(4 registros\)\.\.\./);
        assert.match(first.stdout, /Histórico de digitação migrado \(4 registros\) em \d+\.\d s\./);
        assert.match(first.stderr, /2 registro\(s\) do histórico de digitação antigo não puderam ser migrados/);
        assert.equal(first.current, 4);
        assert.equal(first.legacy, 2, 'as linhas que não puderam ser migradas continuam na tabela antiga');
        assert.deepEqual(first.legacyKeys, ['ilegivel-1', 'sem-prova']);
        assert.equal(first.inMemory, false, 'as teclas não voltam para db.memory');
        assert.equal(first.total, 4);
        assert.equal(first.longIdLength, 200);
        // Ordem de chegada (a da tabela antiga), ids e campos preservados, e-mail em minúsculas.
        assert.deepEqual(first.ana.events.map(item => item.id), ['antiga-1', 'antiga-2', 'antiga-3']);
        const [one, two, three] = first.ana.events;
        assert.equal(two.studentEmail, 'ana@migra.local');
        assert.equal(one.suspicious, true);
        assert.equal(one.seq, 3);
        assert.equal(one.clientTs, 1700000000000);
        assert.equal(one.serverTs, 1700000000500);
        assert.equal(one.attemptId, 'tentativa-1');
        assert.equal(one.studentClass, '1DES');
        assert.equal(three.blocked, true);
        assert.equal(three.applicationId, null);
        assert.equal(three.question, '7');
        assert.deepEqual(first.anaStats, { total: 2, suspicious: 1, lastAt: 1700000000500, maxSeq: 3 });
        assert.equal(first.anaAllStats.total, 3, 'sem aplicação, soma todas (e-mail e prova sem diferenciar maiúsculas)');
        assert.equal(first.anaAllStats.suspicious, 2, 'suspeitas contam as bloqueadas');

        // Segundo boot: nada a migrar, nada duplicado.
        const second = await runChild(dataDir, 'migrate');
        assert.doesNotMatch(second.stdout, /Migrando histórico de digitação/);
        assert.equal(second.current, 4);
        assert.equal(second.legacy, 2);
        assert.deepEqual(second.ana.events.map(item => item.id), ['antiga-1', 'antiga-2', 'antiga-3']);
    } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test('[UC-DIGITACAO-001] retenção, exportação, importação e cópia de outro banco pelo store', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-keystrokes-units-'));
    try {
        const out = await runChild(dataDir, 'units');
        assert.deepEqual(out.uncaught, []);
        assert.equal(out.afterAppend, 4);
        assert.equal(out.deleteWhereWithoutFilter, 'TypeError', 'sem aplicação e sem data nunca apaga tudo');
        assert.deepEqual(out.deleteOldest, { deleted: 1 });
        assert.deepEqual(out.afterDeleteOldest, ['u-2', 'u-3', 'u-4']);
        assert.deepEqual(out.deleteApplication, { deleted: 2 });
        assert.deepEqual(out.afterDeleteApplication, ['u-3']);
        assert.equal(out.statsAfterDelete.total, 1);
        assert.deepEqual(out.exported, [{ id: 'u-3', studentEmail: 'um@units.local', applicationId: 'app-nova' }]);
        assert.deepEqual(out.importReplace, { imported: 2 }, 'id repetido e tecla sem prova ficam de fora');
        assert.deepEqual(out.afterImport, ['i-1', 'i-2']);
        assert.equal(out.statsAfterImport.total, 2);
        assert.equal(out.statsAfterImport.suspicious, 2);
        assert.deepEqual(out.renamed, { renamed: 2 });
        assert.equal(out.statsOldEmail.total, 0);
        assert.equal(out.statsNewEmail.total, 2);
        assert.deepEqual(out.copyNew, { copied: 1 });
        assert.deepEqual(out.copyLegacy, { copied: 1 }, 'do banco antigo, só a linha legível');
        assert.deepEqual(out.afterCopy, ['i-1:tres.nova@units.local', 'i-2:tres.nova@units.local', 'c-1:quatro@units.local', 'l-1:cinco@units.local']);
        assert.deepEqual(out.statsCopied, { total: 1, suspicious: 1, lastAt: 5000, maxSeq: null });
        assert.equal(out.statsLegacyCopied.total, 1);
        assert.deepEqual(out.copyReplace, { copied: 2 });
        assert.deepEqual(out.afterCopyReplace, ['c-1', 'i-1']);
        assert.equal(out.total, 2);

        // Boot seguinte: os contadores saem do arquivo e batem com o que ficou.
        const next = await runChild(dataDir, 'counters');
        assert.equal(next.total, 2);
        assert.deepEqual(next.entries, ['quatro@units.local:app-copia:1', 'repetido@units.local:app-copia:1']);
    } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------- gravação e consulta

test('[UC-DIGITACAO-001] log-keystrokes grava na tabela antes do 200 e a consulta segue o cursor pelo row_id', async () => {
    assert.equal(Object.prototype.hasOwnProperty.call(db.memory, 'examKeystrokes'), false);
    const startedAt = Date.now();
    const first = await sendKeys(students.ana, { applicationId: 'app-atual', attemptId: 'tentativa-ana', events: keys(1, 3, { mods: 'ctrl' }) });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body, { success: true, inserted: 3 });
    // A resposta saiu depois do COMMIT: outra conexão já vê as teclas no arquivo.
    assert.equal(await savedFor(students.ana.email), 3);

    const all = await liveView('ANA@teclas.local', { examKey: 'prova_teclas' }).expect(200);
    assert.equal(all.body.success, true);
    assert.equal(all.body.total, 3);
    assert.equal(all.body.hasMore, false);
    assert.ok(Array.isArray(all.body.logs));
    assert.deepEqual(all.body.events.map(item => item.seq), [1, 2, 3]);
    const sample = all.body.events[0];
    assert.equal(sample.studentEmail, students.ana.email);
    assert.equal(sample.studentClass, className);
    assert.equal(sample.courseId, courseId);
    assert.equal(sample.examKey, examKey);
    assert.equal(sample.applicationId, 'app-atual');
    assert.equal(sample.attemptId, 'tentativa-ana');
    assert.equal(sample.mods, 'ctrl');
    assert.equal(sample.question, '1');
    assert.equal(sample.blocked, false);
    assert.equal(sample.suspicious, false);
    assert.ok(sample.serverTs >= startedAt);
    assert.ok(Number.isInteger(all.body.cursor) && all.body.cursor > 0);

    // A página do aluno recarregou: o seq recomeça. Pelo cursor, chegam só as novas e na
    // ordem de chegada (antes, sinceSeq=3 escondia as duas e a ordem misturava as seqs).
    await sendKeys(students.ana, { applicationId: 'app-atual', attemptId: 'tentativa-ana', events: keys(1, 2) }).expect(200);
    const next = await liveView(students.ana.email, { after: all.body.cursor }).expect(200);
    assert.deepEqual(next.body.events.map(item => item.seq), [1, 2]);
    assert.equal(next.body.total, 5);
    assert.ok(next.body.cursor > all.body.cursor);
    const whole = await liveView(students.ana.email).expect(200);
    assert.deepEqual(whole.body.events.map(item => item.seq), [1, 2, 3, 1, 2], 'ordem de chegada');
    assert.equal(whole.body.cursor, next.body.cursor);
    // Nada novo: o cursor fica onde estava.
    const idle = await liveView(students.ana.email, { after: next.body.cursor }).expect(200);
    assert.deepEqual(idle.body.events, []);
    assert.equal(idle.body.cursor, next.body.cursor);

    // Páginas com limit e hasMore.
    const pageOne = await liveView(students.ana.email, { after: 0, limit: 2 }).expect(200);
    assert.equal(pageOne.body.events.length, 2);
    assert.equal(pageOne.body.hasMore, true);
    const pageTwo = await liveView(students.ana.email, { after: pageOne.body.cursor, limit: 2 }).expect(200);
    const pageThree = await liveView(students.ana.email, { after: pageTwo.body.cursor, limit: 2 }).expect(200);
    assert.equal(pageThree.body.hasMore, false);
    assert.deepEqual([...pageOne.body.events, ...pageTwo.body.events, ...pageThree.body.events].map(item => item.id), whole.body.events.map(item => item.id));
    // Sem after: as últimas `limit`, em ordem; sinceSeq continua valendo (cliente antigo).
    const last = await liveView(students.ana.email, { limit: 2 }).expect(200);
    assert.deepEqual(last.body.events.map(item => item.id), whole.body.events.slice(-2).map(item => item.id));
    assert.equal(last.body.total, 5);
    const since = await liveView(students.ana.email, { sinceSeq: 2 }).expect(200);
    assert.deepEqual(since.body.events.map(item => item.seq), [3]);
    assert.equal(since.body.total, 1);

    // Filtro pela aplicação: as teclas da aplicação anterior não aparecem na atual.
    await sendKeys(students.ana, { applicationId: 'app-anterior', events: keys(1, 4) }).expect(200);
    const current = await liveView(students.ana.email, { applicationId: 'app-atual' }).expect(200);
    assert.equal(current.body.total, 5);
    const previous = await liveView(students.ana.email, { applicationId: 'app-anterior' }).expect(200);
    assert.equal(previous.body.total, 4);
    assert.equal((await liveView(students.ana.email).expect(200)).body.total, 9);

    // Logs de foco do mesmo aluno, prova e aplicação vão junto.
    await request(app).post('/api/student/log-activity').set('x-session-token', students.ana.token)
        .send({ email: students.ana.email, studentClass: className, courseId, examKey, applicationId: 'app-atual', eventType: 'tab_blur', details: 'saiu da aba' })
        .expect(200);
    const withLogs = await liveView(students.ana.email, { applicationId: 'app-atual' }).expect(200);
    assert.deepEqual(withLogs.body.logs.map(item => item.eventType), ['tab_blur']);
    assert.deepEqual((await liveView(students.ana.email, { applicationId: 'app-anterior' }).expect(200)).body.logs, []);

    // Cursor que não é número: 400 com o campo.
    for (const after of ['abc', '-1', '1.5', '9'.repeat(16)]) {
        const bad = await liveView(students.ana.email, { after }).expect(400);
        assert.equal(bad.body.field, 'after');
    }
    await liveView('').expect(400);
});

test('[UC-DIGITACAO-001] Monitor e manutenção contam as teclas pelos contadores, por aplicação', async () => {
    const before = db.keystrokes.stats({ email: students.fabi.email });
    assert.equal(before.total, 0);
    await sendKeys(students.fabi, { applicationId: 'app-atual', events: [...keys(1, 2), { seq: 3, key: 'v', suspicious: true }, { seq: 4, key: 'c', blocked: true }] }).expect(200);
    await sendKeys(students.fabi, { applicationId: 'app-anterior', events: keys(1, 3, { suspicious: true }) }).expect(200);

    const monitor = async query => {
        const response = await admin('get', `/api/admin/monitor-status/${encodeURIComponent(className)}/${examKey}`).query({ courseId, ...query }).expect(200);
        return response.body.find(row => row.email === students.fabi.email);
    };
    const current = await monitor({ applicationId: 'app-atual' });
    assert.equal(current.keystrokeCount, 4);
    assert.equal(current.suspiciousCount, 2, 'suspeitas e bloqueadas');
    assert.ok(current.lastKeystrokeAt > 0);
    const previous = await monitor({ applicationId: 'app-anterior' });
    assert.equal(previous.keystrokeCount, 3);
    assert.equal(previous.suspiciousCount, 3);
    const withoutApplication = await monitor({});
    assert.equal(withoutApplication.keystrokeCount, 7, 'sem aplicação, todas as da prova');
    const caioRow = (await admin('get', `/api/admin/monitor-status/${encodeURIComponent(className)}/${examKey}`).query({ courseId, applicationId: 'app-atual' }).expect(200))
        .body.find(row => row.email === students.caio.email);
    assert.equal(caioRow.keystrokeCount, 0);
    assert.equal(caioRow.lastKeystrokeAt, null);

    // "Limpar estado de prova" mostra quantas teclas ficam preservadas na aplicação.
    const preview = await admin('get', '/api/admin/maintenance/preview').query({ studentClass: className, courseId, applicationId: 'app-anterior' }).expect(200);
    // Na aplicação anterior: as 4 da Ana (teste anterior) e as 3 da Fabi.
    assert.equal(preview.body.flush.preserved.keystrokes, 7);
    assert.equal(db.keystrokes.stats({ examKey, applicationId: 'app-anterior' }).total, 7);
});

test('[UC-DIGITACAO-001] teto por aluno e aplicação (ou prova) apaga as teclas mais antigas', async () => {
    process.env.ICLASS_KEYSTROKE_CAP = '50';
    try {
        await sendKeys(students.bia, { applicationId: 'app-atual', events: keys(1, 40) }).expect(200);
        await sendKeys(students.bia, { applicationId: 'app-atual', events: keys(41, 20) }).expect(200);
        const capped = await liveView(students.bia.email, { applicationId: 'app-atual', limit: 5000 }).expect(200);
        assert.equal(capped.body.total, 50);
        assert.deepEqual(capped.body.events.map(item => item.seq), Array.from({ length: 50 }, (_, index) => index + 11), 'ficam as 50 mais recentes');
        assert.equal(db.keystrokes.stats({ email: students.bia.email, examKey, applicationId: 'app-atual' }).total, 50);
        assert.equal(await savedFor(students.bia.email), 50);
        // Outra aplicação tem o próprio teto.
        await sendKeys(students.bia, { applicationId: 'app-anterior', events: keys(1, 10) }).expect(200);
        assert.equal(db.keystrokes.stats({ email: students.bia.email, examKey, applicationId: 'app-anterior' }).total, 10);
        assert.equal(db.keystrokes.stats({ email: students.bia.email, examKey, applicationId: 'app-atual' }).total, 50);

        // Sem aplicação: o teto vale para o aluno na prova (como antes). Sem aplicação o
        // registro é o padrão (H8b, 'eventos'), que só guarda atalhos.
        await sendKeys(students.eva, { events: keys(1, 55, { kind: 'shortcut' }) }).expect(200);
        const exam = await liveView(students.eva.email, { limit: 5000 }).expect(200);
        assert.equal(exam.body.total, 50);
        assert.equal(exam.body.events[0].seq, 6);
        assert.equal(db.keystrokes.stats({ email: students.eva.email, examKey }).total, 50);
    } finally {
        delete process.env.ICLASS_KEYSTROKE_CAP;
    }
});

test('[UC-DIGITACAO-001] campos do lote: identificação em texto curto e cortes de cada evento', async () => {
    const countBefore = db.storageStatus().keystrokes;
    const cases = [
        [{ examKey: { $ne: '' } }, 'examKey'],
        [{ examKey: 'x'.repeat(201) }, 'examKey'],
        [{ examKey: 42 }, 'examKey'],
        [{ applicationId: { id: 'app-atual' } }, 'applicationId'],
        [{ applicationId: 'a'.repeat(201) }, 'applicationId'],
        [{ attemptId: ['tentativa'] }, 'attemptId'],
        [{ attemptId: 'z'.repeat(201) }, 'attemptId'],
        [{ attemptId: 123 }, 'attemptId'],
    ];
    for (const [body, field] of cases) {
        const response = await sendKeys(students.duda, { events: keys(1, 1), ...body });
        assert.equal(response.status, 400, `${field}: ${JSON.stringify(response.body)}`);
        assert.equal(response.body.field, field);
        assert.equal(response.body.success, false);
    }
    assert.equal(db.storageStatus().keystrokes, countBefore, 'nada gravado nos pedidos recusados');

    const accepted = await sendKeys(students.duda, {
        applicationId: 'app-atual',
        attemptId: 't'.repeat(200),
        events: [
            { seq: 1e20, clientTs: 'agora', key: 'k'.repeat(500), code: 'c'.repeat(500), mods: 'm'.repeat(500), kind: 'q'.repeat(500), question: 'p'.repeat(500) },
            { seq: 2, key: { toString: 'x' }, question: { numero: 1 } },
            null,
            7,
            ['lista'],
        ],
    }).expect(200);
    assert.equal(accepted.body.inserted, 2);
    const saved = (await liveView(students.duda.email).expect(200)).body.events;
    assert.equal(saved.length, 2);
    assert.equal(saved[0].seq, null, 'seq fora dos inteiros seguros vira null');
    assert.equal(saved[0].clientTs, null);
    assert.equal(saved[0].key.length, 40);
    assert.equal(saved[0].code.length, 40);
    assert.equal(saved[0].mods.length, 16);
    assert.equal(saved[0].kind.length, 24);
    assert.equal(saved[0].question.length, 12);
    assert.equal(saved[0].attemptId.length, 200);
    assert.equal(saved[1].key, '');
    assert.equal(saved[1].question, null);

    // Lote só com eventos inválidos: nada é gravado.
    const before = await savedFor(students.duda.email);
    const empty = await sendKeys(students.duda, { events: [null, 3, 'texto', []] }).expect(200);
    assert.deepEqual(empty.body, { success: true, inserted: 0 });
    assert.equal(await savedFor(students.duda.email), before);

    // Lote maior que 500: só os 500 primeiros entram.
    const big = await sendKeys(students.duda, { applicationId: 'app-anterior', events: keys(1, 520) }).expect(200);
    assert.equal(big.body.inserted, 500);
});

// ---------------------------------------------------------------- aluno

test('[UC-DIGITACAO-001] excluir aluno apaga só as teclas dele; trocar o e-mail leva as teclas junto', async () => {
    await sendKeys(students.caio, { applicationId: 'app-atual', events: keys(1, 6) }).expect(200);
    const anaBefore = db.keystrokes.stats({ email: students.ana.email }).total;
    assert.ok(anaBefore > 0);
    assert.equal(await savedFor(students.caio.email), 6);

    // Apagar de vez (H7c): desligar e depois apagar em Cadastros encerrados; as teclas
    // saem no mesmo ciclo de gravação da memória, antes da resposta.
    await admin('post', '/api/admin/student/bulk-status').send({ emails: ['caio@teclas.local'], status: 'Evadido' }).expect(200);
    await admin('post', '/api/admin/students/purge').send({ email: 'CAIO@teclas.local', confirm: 'APAGAR', reason: 'Pedido da família' }).expect(200);
    assert.equal(await savedFor(students.caio.email), 0, 'apagadas no arquivo antes do 200');
    assert.equal(db.keystrokes.stats({ email: students.caio.email }).total, 0);
    assert.deepEqual(await db.keystrokes.findByEmails([students.caio.email]), []);
    assert.equal(db.keystrokes.stats({ email: students.ana.email }).total, anaBefore, 'as dos outros alunos ficam');

    const newEmail = 'eva.nova@teclas.local';
    const evaBefore = db.keystrokes.stats({ email: students.eva.email }).total;
    assert.ok(evaBefore > 0);
    // Progresso dela também muda de chave: a gravação das teclas (só a tabela própria) no
    // meio da troca não é uma gravação parcial esquecida para o verificador.
    db.memory.progress[students.eva.email] = { Apostila_1: { percent: 50 } };
    await db.save();
    const failuresBefore = db.saveVerifyFailures.length;
    await admin('post', '/api/admin/student/update')
        .send({ originalEmail: students.eva.email, email: newEmail, name: 'Eva', classes: [{ name: className, courseId }], status: 'Ativo' })
        .expect(200);
    assert.deepEqual(db.saveVerifyFailures.slice(failuresBefore), []);
    assert.equal(await fileCount('SELECT COUNT(*) AS n FROM progress WHERE key = ?', [newEmail]), 1);
    assert.equal(await savedFor(students.eva.email), 0);
    assert.equal(await savedFor(newEmail), evaBefore);
    assert.equal(db.keystrokes.stats({ email: students.eva.email }).total, 0);
    assert.equal(db.keystrokes.stats({ email: newEmail, examKey }).total, evaBefore);
    const moved = await liveView(newEmail).expect(200);
    assert.equal(moved.body.total, evaBefore);
    assert.ok(moved.body.events.every(item => item.studentEmail === newEmail));
    const row = (await admin('get', `/api/admin/monitor-status/${encodeURIComponent(className)}/${examKey}`).query({ courseId }).expect(200))
        .body.find(item => item.email === newEmail);
    assert.equal(row.keystrokeCount, evaBefore);
});

// ---------------------------------------------------------------- banco travado

test('[UC-DIGITACAO-001] banco travado: lote recebe 503 retryable e a regravação grava as teclas depois', async () => {
    const external = new sqlite3.Database(databaseFile);
    const exec = sql => new Promise((resolve, reject) => external.exec(sql, err => (err ? reject(err) : resolve())));
    await exec('BEGIN IMMEDIATE');
    let response;
    try {
        response = await sendKeys(students.bia, { applicationId: 'app-atual', events: keys(500, 3) });
    } finally {
        await exec('COMMIT');
        await new Promise(resolve => external.close(() => resolve()));
    }
    assert.equal(response.status, 503, JSON.stringify(response.body));
    assert.equal(response.body.retryable, true);
    // A regravação em segundo plano (2 s) grava as teclas que ficaram na fila.
    const deadline = Date.now() + 15000;
    let found = [];
    while (Date.now() < deadline) {
        found = (await db.keystrokes.findByEmails([students.bia.email])).filter(item => item.seq >= 500);
        if (found.length === 3 && await fileCount(`SELECT COUNT(*) AS n FROM ${KEYSTROKE_TABLE} WHERE student_email = ? AND seq >= 500`, [students.bia.email]) === 3) break;
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(await fileCount(`SELECT COUNT(*) AS n FROM ${KEYSTROKE_TABLE} WHERE student_email = ? AND seq >= 500`, [students.bia.email]), 3);
    // Contadores atualizados depois da regravação: as 50 do teste do teto e as 3 novas.
    assert.equal(db.keystrokes.stats({ email: students.bia.email, examKey, applicationId: 'app-atual' }).total, 53);
    assert.equal(db.storageStatus().pendingRetry, false);
});
