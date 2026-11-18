// Banco danificado no boot (H4a, OPS-05): PRAGMA quick_check antes de ler as coleções.
// Antes, um banco com páginas estragadas que ainda abria (o cabeçalho certo) era lido até
// onde dava e o servidor subia; a primeira gravação podia piorar o estrago. Agora o boot
// recusa com ICLASS_DB_CORRUPT (saída 3, o supervisor não insiste) sem tocar no arquivo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const sqlite3 = require('sqlite3');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-integridade-test-'));
const dbFile = require('../../backend/utils/dbFile.js');
const proc = require('./fixtures/server-process.js');

const childScript = path.join(__dirname, 'fixtures', 'server-main-child.js');
const databaseModule = JSON.stringify(require.resolve('../../backend/database.js'));

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function run(connection, sql, params = []) {
    return new Promise((resolve, reject) => connection.run(sql, params, err => (err ? reject(err) : resolve())));
}

function get(connection, sql, params = []) {
    return new Promise((resolve, reject) => connection.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
}

// Banco do IClass gravado de verdade (init + save) numa pasta própria, com alunos o
// bastante para o índice da chave ocupar páginas próprias.
function makeDatabase(name) {
    const dataDir = path.join(tempRoot, name);
    fs.mkdirSync(dataDir, { recursive: true });
    const script = `const db = require(${databaseModule});
db.init().then(async () => {
    for (let i = 0; i < 400; i += 1) db.memory.students.push({ name: 'Aluno ' + i, email: 'aluno' + i + '@integridade.local', status: 'Ativo', classes: [] });
    await db.save();
    await db.close();
    process.stdout.write('@@ok');
});`;
    execFileSync(process.execPath, ['-e', script], { env: { ...process.env, ICLASS_DATA_DIR: dataDir, ICLASS_CONTENT_DIR: path.join(dataDir, 'content'), ICLASS_ARCHIVE_DIR: path.join(dataDir, 'arquivados'), TEST_MODE: '1' }, encoding: 'utf8' });
    return { dataDir, file: path.join(dataDir, 'database.db') };
}

// Estraga a página do índice da chave de students (sqlite_autoindex_students_1): a
// leitura das coleções (varredura da tabela, SELECT key, value) não passa pelo índice e
// funcionava como se nada houvesse, mas o quick_check acusa.
async function corruptStudentsIndex(file) {
    const connection = new sqlite3.Database(file);
    let pageSize;
    let rootPage;
    try {
        pageSize = (await get(connection, 'PRAGMA page_size')).page_size;
        rootPage = (await get(connection, "SELECT rootpage FROM sqlite_master WHERE name = 'sqlite_autoindex_students_1'")).rootpage;
        await run(connection, 'PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
        await new Promise(resolve => connection.close(resolve));
    }
    const handle = fs.openSync(file, 'r+');
    try {
        // Tipo de página inválido no cabeçalho da página do índice.
        fs.writeSync(handle, Buffer.from([0x07, 0xff, 0xff, 0xff, 0xff]), 0, 5, (rootPage - 1) * pageSize);
    } finally {
        fs.closeSync(handle);
    }
}

function bootInChild(dataDir) {
    const script = `const db = require(${databaseModule});
db.init().then(async () => { process.stdout.write('@@' + JSON.stringify({ ok: true, students: db.memory.students.length })); await db.close(); })
.catch(err => { process.stdout.write('@@' + JSON.stringify({ ok: false, code: err.code, message: err.message })); process.exit(0); });`;
    const output = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, ICLASS_DATA_DIR: dataDir, ICLASS_CONTENT_DIR: path.join(dataDir, 'content'), ICLASS_ARCHIVE_DIR: path.join(dataDir, 'arquivados'), TEST_MODE: '1' }, encoding: 'utf8' });
    return JSON.parse(output.slice(output.lastIndexOf('@@') + 2));
}

test.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-BACKUP-002] banco com página do índice estragada: o boot recusa com ICLASS_DB_CORRUPT e o arquivo fica como estava', async () => {
    const { dataDir, file } = makeDatabase('indice');
    assert.ok(bootInChild(dataDir).students >= 400, 'o banco íntegro sobe');
    await corruptStudentsIndex(file);
    const before = sha256(file);
    const result = bootInChild(dataDir);
    assert.equal(result.ok, false, 'antes o boot lia as coleções e subia');
    assert.equal(result.code, 'ICLASS_DB_CORRUPT');
    assert.match(result.message, /está danificado/);
    assert.equal(sha256(file), before, 'o boot não grava no banco danificado');
});

test('[UC-BACKUP-002] o servidor sai com 3 (o supervisor não insiste), sem exceção não tratada e mandando para o backup-cli', async () => {
    const { dataDir, file } = makeDatabase('servidor');
    await corruptStudentsIndex(file);
    const before = sha256(file);
    const server = proc.launch(childScript, { dataDir, port: await proc.freePort() });
    const result = await server.exited;
    assert.equal(result.code, 3, server.output());
    assert.match(server.output(), /está danificado/);
    assert.match(server.output(), /backup-cli\.js listar/);
    assert.match(server.output(), /backup-cli\.js restaurar --ultimo/);
    assert.equal(/uncaughtException|unhandledRejection/.test(server.output()), false);
    assert.equal(/iniciado com sucesso/.test(server.output()), false);
    assert.equal(sha256(file), before);
});

test('[UC-BACKUP-002] quick_check: só "ok" vale; trava (SQLITE_BUSY) não é dano', async () => {
    const fake = rows => ({ all: (sql, params, callback) => callback(null, rows) });
    assert.equal(await dbFile.quickCheck(fake([{ quick_check: 'ok' }])), 'ok');
    await assert.rejects(dbFile.quickCheck(fake([{ quick_check: '*** in database main ***' }, { quick_check: 'Page 5: btreeInitPage() returns error code 11' }])), { code: 'ICLASS_DB_CORRUPT' });
    await assert.rejects(dbFile.quickCheck(fake([])), { code: 'ICLASS_DB_CORRUPT' });
    const failing = code => ({ all: (sql, params, callback) => callback(Object.assign(new Error(code), { code })) });
    await assert.rejects(dbFile.quickCheck(failing('SQLITE_BUSY')), error => error.code === 'SQLITE_BUSY');
    await assert.rejects(dbFile.quickCheck(failing('SQLITE_NOTADB')), { code: 'ICLASS_DB_CORRUPT' });
    await assert.rejects(dbFile.quickCheck(failing('SQLITE_CORRUPT')), { code: 'ICLASS_DB_CORRUPT' });
});
