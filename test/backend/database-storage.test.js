// Motor de gravação do banco (fase 2, H1-a: DES-01, CONF-04, CONF-05).
// Conexão em WAL com synchronous FULL e busy_timeout; leitor externo não trava a
// gravação; a primeira gravação depois do boot só escreve o que mudou (antes apagava e
// reinseria todas as tabelas); linha com JSON ilegível nunca é apagada; gravação
// parcial (only/changed) e modo acréscimo; erro no meio do ciclo desfaz tudo (ROLLBACK)
// sem obrigar a regravar o banco inteiro; trava além do busy_timeout rejeita com
// DbWriteError e a regravação em segundo plano grava sozinha; close() fecha o banco.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const sqlite3 = require('sqlite3');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-db-storage-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';
delete process.env.ICLASS_DB_BUSY_TIMEOUT_MS;

const databaseFile = path.join(tempRoot, 'database.db');
const childScript = path.join(__dirname, 'fixtures', 'database-child.js');
const uncaught = [];
const collectUncaught = err => uncaught.push(String((err && err.message) || err));

let db;

function openConnection(file = databaseFile) {
    return new sqlite3.Database(file);
}

function exec(connection, sql) {
    return new Promise((resolve, reject) => connection.exec(sql, err => (err ? reject(err) : resolve())));
}

function get(connection, sql, params = []) {
    return new Promise((resolve, reject) => connection.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
}

function closeConnection(connection) {
    return new Promise(resolve => connection.close(() => resolve()));
}

// Lê uma linha do arquivo por outra conexão (o que está gravado de verdade).
async function readRow(table, key, file = databaseFile) {
    const reader = openConnection(file);
    try {
        return await get(reader, `SELECT value FROM ${table} WHERE key = ?`, [key]);
    } finally {
        await closeConnection(reader);
    }
}

async function countRows(table, file = databaseFile) {
    const reader = openConnection(file);
    try {
        const row = await get(reader, `SELECT count(*) AS n FROM ${table}`);
        return row.n;
    } finally {
        await closeConnection(reader);
    }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Um boot do banco num processo próprio (database.js abre o arquivo no require).
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
            resolve(result);
        });
    });
}

// Antes do primeiro boot: um banco antigo com uma linha de JSON ilegível em notes.
async function createLegacyFileWithUnreadableRow() {
    const connection = openConnection();
    await exec(connection, `CREATE TABLE IF NOT EXISTS notes (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO notes (key, value) VALUES ('quebrada@teste.local', 'nao-e-json');
        INSERT INTO notes (key, value) VALUES ('legivel@teste.local', '{"modulo":"antes"}');`);
    await closeConnection(connection);
}

test.before(async () => {
    process.on('uncaughtException', collectUncaught);
    await createLegacyFileWithUnreadableRow();
    db = require('../../backend/database.js');
    await db.init();
});

test.after(() => {
    process.removeListener('uncaughtException', collectUncaught);
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-GRAVACAO-001] conexão em WAL, synchronous FULL e busy_timeout de 5 s', async () => {
    const status = db.storageStatus();
    assert.equal(status.journalMode, 'wal');
    assert.equal(status.synchronous, 'FULL');
    assert.equal(status.busyTimeoutMs, 5000);
    // O modo WAL fica no arquivo: outra conexão vê o mesmo modo.
    const connection = openConnection();
    const row = await get(connection, 'PRAGMA journal_mode');
    await closeConnection(connection);
    assert.equal(String(Object.values(row)[0]).toLowerCase(), 'wal');
    assert.equal(typeof status.rows.notes, 'number');
    assert.ok(status.lastFullSaveAt, 'o boot faz uma gravação completa e ela aparece no estado');
});

test('[UC-GRAVACAO-001] leitor externo segurando o banco não atrasa nem derruba a gravação', async () => {
    const reader = openConnection();
    await exec(reader, 'BEGIN');
    await get(reader, 'SELECT count(*) AS n FROM notes');
    const release = wait(2000).then(() => exec(reader, 'COMMIT'));
    try {
        db.memory.notes['leitor@teste.local'] = { modulo: 'gravado com leitor aberto' };
        const started = performance.now();
        await db.save();
        const elapsed = performance.now() - started;
        assert.ok(elapsed < 1000, `a gravação levou ${Math.round(elapsed)} ms com um leitor aberto`);
        const row = await readRow('notes', 'leitor@teste.local');
        assert.deepEqual(JSON.parse(row.value), { modulo: 'gravado com leitor aberto' });
    } finally {
        await release;
        await closeConnection(reader);
    }
    assert.deepEqual(uncaught, []);
});

test('[UC-GRAVACAO-001] save resolve sem a espera fixa de 250 ms', async () => {
    const times = [];
    for (let index = 0; index < 5; index += 1) {
        db.memory.notes[`rapida-${index}@teste.local`] = { modulo: `texto ${index}` };
        const started = performance.now();
        await db.save();
        times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    assert.ok(times[2] < 200, `mediana de ${Math.round(times[2])} ms (antes havia uma espera fixa de 250 ms)`);
    assert.ok(await readRow('notes', 'rapida-4@teste.local'));
});

test('[UC-GRAVACAO-001] linha com JSON ilegível fica no arquivo e fora da memória', async () => {
    assert.equal(Object.prototype.hasOwnProperty.call(db.memory.notes, 'quebrada@teste.local'), false);
    assert.deepEqual(db.memory.notes['legivel@teste.local'], { modulo: 'antes' });
    db.memory.notes['legivel@teste.local'] = { modulo: 'depois' };
    await db.save();
    const unreadable = await readRow('notes', 'quebrada@teste.local');
    assert.ok(unreadable, 'a linha ilegível foi apagada pela gravação');
    assert.equal(unreadable.value, 'nao-e-json');
    assert.deepEqual(JSON.parse((await readRow('notes', 'legivel@teste.local')).value), { modulo: 'depois' });
});

test('[UC-GRAVACAO-001] gravação parcial grava só as coleções pedidas e a completa grava o resto', async () => {
    db.memory.progress['parcial@teste.local'] = { modulo: 50 };
    db.memory.notes['parcial@teste.local'] = { modulo: 'fica para a completa' };
    await db.save({ only: ['progress'] });
    assert.ok(await readRow('progress', 'parcial@teste.local'));
    assert.equal(await readRow('notes', 'parcial@teste.local'), undefined);
    await db.save();
    assert.ok(await readRow('notes', 'parcial@teste.local'));
});

test('[UC-GRAVACAO-001] modo acréscimo: linha nova entra, linha antiga só com changed, removida sai', async () => {
    db.memory.proctoringLogs.push(
        { id: 'log-1', type: 'blur', detail: 'original' },
        { id: 'log-2', type: 'blur', detail: 'original' },
        { id: 'log-3', type: 'blur', detail: 'original' },
    );
    await db.save();
    db.memory.proctoringLogs.push({ id: 'log-4', type: 'focus', detail: 'nova' });
    db.memory.proctoringLogs.find(log => log.id === 'log-1').detail = 'alterada';
    await db.save({ only: ['proctoringLogs'] });
    assert.ok(await readRow('proctoring_logs', 'log-4'), 'a linha nova entra na gravação parcial');
    assert.equal(JSON.parse((await readRow('proctoring_logs', 'log-1')).value).detail, 'original',
        'linha antiga de coleção com acréscimo só é comparada quando está em changed');
    await db.save({ changed: { proctoringLogs: ['log-1'] } });
    assert.equal(JSON.parse((await readRow('proctoring_logs', 'log-1')).value).detail, 'alterada');
    db.memory.proctoringLogs = db.memory.proctoringLogs.filter(log => log.id !== 'log-2');
    await db.save({ only: ['proctoringLogs'] });
    assert.equal(await readRow('proctoring_logs', 'log-2'), undefined);
    assert.equal(await countRows('proctoring_logs'), 3);
});

test('[UC-GRAVACAO-001] nome de coleção desconhecido ou opção errada lança TypeError na hora', () => {
    assert.throws(() => db.save({ only: ['naoExiste'] }), TypeError);
    assert.throws(() => db.save({ only: 'notes' }), TypeError);
    assert.throws(() => db.save({ changed: ['notes'] }), TypeError);
    assert.throws(() => db.save({ changed: { notes: 'chave' } }), TypeError);
    assert.throws(() => db.save({ changed: { sessions: ['x'] } }), TypeError);
    assert.throws(() => db.save('notes'), TypeError);
});

test('[UC-GRAVACAO-001] erro no meio do ciclo desfaz tudo e a gravação seguinte escreve só o que mudou', async () => {
    await db.save();
    const external = openConnection();
    await exec(external, `CREATE TRIGGER falha_forum BEFORE INSERT ON forum WHEN NEW.key = 'forum-falha'
        BEGIN SELECT RAISE(ABORT, 'falha simulada'); END;`);
    try {
        // notes vem antes de forum no registro: a nota é gravada e desfeita no ROLLBACK.
        db.memory.notes['atomico@teste.local'] = { modulo: 'não pode ficar sozinha' };
        db.memory.forum.push({ id: 'forum-falha', text: 'tópico' });
        await assert.rejects(db.save(), err => err.code === 'ICLASS_DB_WRITE' && err.name === 'DbWriteError'
            && err.sqliteCode === 'SQLITE_CONSTRAINT');
        assert.equal(await readRow('notes', 'atomico@teste.local'), undefined, 'o ROLLBACK desfaz a nota gravada antes do erro');
        const failed = db.storageStatus();
        assert.equal(failed.lastWriteError.code, 'SQLITE_CONSTRAINT');
        assert.equal(failed.pendingRetry, true);
        assert.ok(failed.nextRetryAt);
    } finally {
        await exec(external, 'DROP TRIGGER falha_forum');
        await closeConnection(external);
    }
    await db.save();
    assert.ok(await readRow('notes', 'atomico@teste.local'));
    assert.ok(await readRow('forum', 'forum-falha'));
    const status = db.storageStatus();
    assert.equal(status.lastCycle.rows, 2, 'depois do ROLLBACK só as duas linhas pendentes são gravadas');
    assert.equal(status.lastWriteError, null);
    assert.equal(status.pendingRetry, false);
    assert.equal(fs.existsSync(path.join(tempRoot, 'crash.log')), true);
    assert.match(fs.readFileSync(path.join(tempRoot, 'crash.log'), 'utf8'), /\[GRAVAÇÃO\] Não foi possível gravar no banco\nError: SQLITE_CONSTRAINT: falha simulada/);
});

test('[UC-GRAVACAO-001] primeira gravação depois do boot não apaga nem regrava as linhas que não mudaram', async () => {
    const bootDir = fs.mkdtempSync(path.join(tempRoot, 'boot-'));
    const bootFile = path.join(bootDir, 'database.db');
    const seeded = await runChild(bootDir, 'seed', 2000);
    assert.equal(seeded.total, 2000);
    assert.equal(seeded.first, 'presenca-00000');
    assert.deepEqual(seeded.uncaught, []);

    const counter = openConnection(bootFile);
    await exec(counter, `CREATE TABLE contagem_teste (op TEXT PRIMARY KEY, n INTEGER NOT NULL);
        INSERT INTO contagem_teste VALUES ('delete', 0), ('insert', 0), ('update', 0);
        CREATE TRIGGER conta_delete AFTER DELETE ON attendance BEGIN UPDATE contagem_teste SET n = n + 1 WHERE op = 'delete'; END;
        CREATE TRIGGER conta_insert AFTER INSERT ON attendance BEGIN UPDATE contagem_teste SET n = n + 1 WHERE op = 'insert'; END;
        CREATE TRIGGER conta_update AFTER UPDATE ON attendance BEGIN UPDATE contagem_teste SET n = n + 1 WHERE op = 'update'; END;`);
    await closeConnection(counter);

    const changed = await runChild(bootDir, 'change');
    assert.deepEqual(changed.uncaught, []);

    const reader = openConnection(bootFile);
    const counts = {};
    for (const op of ['delete', 'insert', 'update']) counts[op] = (await get(reader, 'SELECT n FROM contagem_teste WHERE op = ?', [op])).n;
    const note = await get(reader, 'SELECT value FROM notes WHERE key = ?', ['nota@boot.local']);
    await closeConnection(reader);
    assert.deepEqual(counts, { delete: 0, insert: 0, update: 1 });
    assert.deepEqual(JSON.parse(note.value), { modulo: 'texto novo' });
    assert.ok(changed.status && changed.status.rows <= 5, `a gravação depois do boot escreveu ${changed.status && changed.status.rows} linhas`);

    // A presença alterada continua no mesmo lugar: a ordem da coleção não muda.
    const after = await runChild(bootDir, 'first');
    assert.deepEqual({ first: after.first, status: after.status, total: after.total },
        { first: 'presenca-00000', status: 'abonado', total: 2000 });
});

test('[UC-GRAVACAO-001] trava além do busy_timeout rejeita com DbWriteError e a regravação grava sozinha', async () => {
    const busyDir = fs.mkdtempSync(path.join(tempRoot, 'trava-'));
    const result = await runChild(busyDir, 'busy', undefined, { ICLASS_DB_BUSY_TIMEOUT_MS: '200' });
    assert.deepEqual(result.uncaught, []);
    assert.deepEqual(result.error, { code: 'ICLASS_DB_WRITE', sqliteCode: 'SQLITE_BUSY', name: 'DbWriteError' });
    assert.ok(result.rejectedAfterMs < 1500, `a gravação travada levou ${result.rejectedAfterMs} ms para desistir`);
    assert.equal(result.statusWhileLocked.busyTimeoutMs, 200);
    assert.equal(result.statusWhileLocked.pendingRetry, true);
    assert.equal(result.statusWhileLocked.lastWriteError.code, 'SQLITE_BUSY');
    assert.ok(result.foundAfterMs !== null && result.foundAfterMs <= 3000,
        `a nota apareceu no disco ${result.foundAfterMs} ms depois de a trava sair (sem novo save)`);
    // A regravação escreve só a nota pendente: nenhuma presença foi apagada ou regravada.
    assert.deepEqual(result.counts, { delete: 0, insert: 0, update: 0 });
    assert.equal(result.otherWriter, 'ok', 'nenhuma transação ficou aberta');
    assert.equal(result.statusAfter.pendingRetry, false);
    assert.equal(result.statusAfter.lastWriteError, null);
    const crashLog = fs.readFileSync(path.join(busyDir, 'crash.log'), 'utf8');
    assert.match(crashLog, /\[GRAVAÇÃO\] Não foi possível gravar no banco\nError: SQLITE_BUSY: database is locked\n--> in Database#exec\('BEGIN IMMEDIATE'/);
    assert.equal(crashLog.match(/\[GRAVAÇÃO\]/g).length, 1, 'no máximo uma linha por minuto no crash.log');
});

test('[UC-GRAVACAO-001] backup e restauração saem do registro único de tabelas', () => {
    const backup = require('../../backend/utils/backup.js');
    const expected = db.COLLECTION_TABLES
        .filter(entry => entry.backup !== false && entry.kind !== 'derived')
        .map(entry => entry.collection);
    assert.deepEqual(backup.COLLECTIONS, expected);
    assert.equal(backup.COLLECTIONS.includes('examKeystrokes'), false);
    assert.equal(backup.COLLECTIONS.includes('examApplications'), true);
    // Toda coleção da memória tem tabela e toda tabela aparece uma vez.
    const tables = db.COLLECTION_TABLES.map(entry => entry.table);
    assert.equal(new Set(tables).size, tables.length);
    db.COLLECTION_TABLES.filter(entry => ['array', 'object', 'singleton'].includes(entry.kind))
        .forEach(entry => assert.ok(entry.collection in db.memory, `${entry.collection} fora da memória`));
});

test('[UC-GRAVACAO-001] toda tabela do arquivo tem entrada no registro único', async () => {
    const connection = openConnection();
    const rows = await new Promise((resolve, reject) => connection.all(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        (err, result) => (err ? reject(err) : resolve(result))));
    await closeConnection(connection);
    const registered = new Set(db.COLLECTION_TABLES.map(entry => entry.table));
    const missing = rows.map(row => row.name).filter(name => !registered.has(name));
    assert.deepEqual(missing, [], 'tabela criada fora de db.COLLECTION_TABLES');
    db.COLLECTION_TABLES.forEach(entry => assert.ok(rows.some(row => row.name === entry.table), `tabela ${entry.table} não foi criada`));
});

test('[UC-GRAVACAO-001] runExclusive roda com a fila parada, depois das gravações pedidas antes', async () => {
    db.memory.notes['antes-exclusiva@teste.local'] = { modulo: 'pedida antes' };
    const before = db.save();
    let duringSave = null;
    let seenInside = null;
    let seenDuring = null;
    const job = db.runExclusive(async connection => {
        seenInside = await get(connection, 'SELECT value FROM notes WHERE key = ?', ['antes-exclusiva@teste.local']);
        db.memory.notes['durante-exclusiva@teste.local'] = { modulo: 'pedida durante' };
        duringSave = db.save();
        await wait(150);
        // Nenhum ciclo roda enquanto a tarefa exclusiva não termina.
        seenDuring = await get(connection, 'SELECT value FROM notes WHERE key = ?', ['durante-exclusiva@teste.local']);
        await new Promise((resolve, reject) => connection.exec('VACUUM', err => (err ? reject(err) : resolve())));
        return 'feito';
    });
    await before;
    assert.equal(await job, 'feito');
    assert.ok(seenInside, 'a gravação pedida antes passa antes da tarefa exclusiva');
    assert.equal(seenDuring, undefined, 'a gravação pedida durante espera a tarefa exclusiva');
    await duringSave;
    assert.ok(await readRow('notes', 'durante-exclusiva@teste.local'));
    await assert.rejects(db.runExclusive('VACUUM'), TypeError);
});

test('[UC-GRAVACAO-001] flush espera as gravações pedidas, com ou sem quem as aguarde', async () => {
    db.memory.notes['flush@teste.local'] = { modulo: 'sem await' };
    db.save();
    await db.flush();
    assert.ok(await readRow('notes', 'flush@teste.local'));
    await db.flush();
});

// Último teste: fecha o banco.
test('[UC-GRAVACAO-001] close grava, fecha o banco, apaga o -wal e recusa gravações depois', async () => {
    db.memory.notes['fechamento@teste.local'] = { modulo: 'gravada no close' };
    await db.close();
    assert.equal(fs.existsSync(`${databaseFile}-wal`), false, 'o checkpoint do close apaga o -wal');
    assert.ok(await readRow('notes', 'fechamento@teste.local'));
    await assert.rejects(db.save(), err => err.code === 'ICLASS_DB_WRITE');
    assert.deepEqual(uncaught, []);
});
