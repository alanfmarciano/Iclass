// Boot do servidor sem regravar o que não mudou (fase 2, H3b: DES-08).
// O boot (prepareServer) com uma turma de prova em andamento coerente com a aplicação
// não reescreve turma, aluno nem presença e não imprime "Provas online resetadas" (antes
// toda turma com prova ativa contava como resetada e o boot gravava a cada início). Uma
// entrega nova depois do boot só grava a entrega. Linha de aluno com JSON ilegível
// continua no arquivo; a turma antiga de chave 'T1' passa para 'c1::T1'.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const sqlite3 = require('sqlite3');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-db-boot-test-'));
const databaseFile = path.join(tempRoot, 'database.db');
const childScript = path.join(__dirname, 'fixtures', 'server-boot-child.js');
const COUNTED_TABLES = ['classes', 'students', 'attendance'];

function openConnection() {
    return new sqlite3.Database(databaseFile);
}

function exec(connection, sql) {
    return new Promise((resolve, reject) => connection.exec(sql, err => (err ? reject(err) : resolve())));
}

function all(connection, sql, params = []) {
    return new Promise((resolve, reject) => connection.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
}

function closeConnection(connection) {
    return new Promise(resolve => connection.close(() => resolve()));
}

async function query(sql, params = []) {
    const connection = openConnection();
    try {
        return await all(connection, sql, params);
    } finally {
        await closeConnection(connection);
    }
}

// Um boot num processo próprio (database.js abre o arquivo no require).
function runChild(scenario, argument) {
    const env = {
        ...process.env,
        ICLASS_DATA_DIR: tempRoot,
        ICLASS_CONTENT_DIR: path.join(tempRoot, 'content'),
        ICLASS_ARCHIVE_DIR: path.join(tempRoot, 'archives'),
        TEST_MODE: '1',
    };
    delete env.NODE_TEST_CONTEXT;
    delete env.ICLASS_VERIFY_SAVES;
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
                reject(new Error(`processo filho (${scenario}) falhou: ${result.fatal}\n${(result.logs || []).join('\n')}\n${stderr}`));
                return;
            }
            resolve(result);
        });
    });
}

// Contador de escritas (INSERT, UPDATE e DELETE) por tabela, por gatilhos no arquivo.
async function installWriteCounters() {
    const statements = ['CREATE TABLE IF NOT EXISTS contagem_boot (tabela TEXT NOT NULL, op TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (tabela, op));'];
    COUNTED_TABLES.forEach(table => {
        ['INSERT', 'UPDATE', 'DELETE'].forEach(op => {
            statements.push(`INSERT OR IGNORE INTO contagem_boot VALUES ('${table}', '${op}', 0);`);
            statements.push(`CREATE TRIGGER IF NOT EXISTS conta_${table}_${op.toLowerCase()} AFTER ${op} ON ${table} BEGIN UPDATE contagem_boot SET n = n + 1 WHERE tabela = '${table}' AND op = '${op}'; END;`);
        });
    });
    const connection = openConnection();
    try {
        await exec(connection, statements.join('\n'));
    } finally {
        await closeConnection(connection);
    }
}

async function writeCounts() {
    const rows = await query('SELECT tabela, op, n FROM contagem_boot');
    const counts = Object.fromEntries(COUNTED_TABLES.map(table => [table, 0]));
    rows.forEach(row => { counts[row.tabela] += row.n; });
    return counts;
}

async function resetWriteCounts() {
    const connection = openConnection();
    try {
        await exec(connection, 'UPDATE contagem_boot SET n = 0;');
    } finally {
        await closeConnection(connection);
    }
}

test.before(async () => {
    // Banco de versão anterior: turma gravada com a chave só pelo nome e um aluno com
    // JSON ilegível (gravado à mão, cópia corrompida).
    const connection = openConnection();
    await exec(connection, `CREATE TABLE IF NOT EXISTS classes (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS students (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO classes (key, value) VALUES ('T1', '{"name":"T1","courseId":"c1","releasedItems":{},"onlineExamConfigs":{}}');
        INSERT INTO students (key, value) VALUES ('quebrado@boot.local', 'nao-e-json');`);
    await closeConnection(connection);
    await runChild('seed');
});

test.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-GRAVACAO-001] turma antiga de chave só pelo nome passa para curso::nome e a antiga sai (DES-08)', async () => {
    const keys = (await query('SELECT key FROM classes ORDER BY key')).map(row => row.key);
    assert.ok(keys.includes('c1::T1'), `chaves das turmas: ${keys.join(', ')}`);
    assert.equal(keys.includes('T1'), false, 'a chave antiga ficou duplicada');
    assert.ok(keys.includes('c1::Turma Prova'));
});

test('[UC-GRAVACAO-001] boot com prova em andamento não regrava turmas, alunos nem presenças (DES-08)', async () => {
    await installWriteCounters();
    const booted = await runChild('boot');
    assert.deepEqual(booted.uncaught, []);
    assert.deepEqual(await writeCounts(), { classes: 0, students: 0, attendance: 0 });
    const resetLog = booted.logs.find(line => line.includes('Provas online resetadas'));
    assert.equal(resetLog, undefined, `o boot disse que resetou provas sem mudar nada:\n${booted.logs.join('\n')}`);
    // Prova em andamento sem registro de quando o servidor parou (primeiro boot desta
    // versão): avisa que o tempo não foi devolvido.
    assert.ok(booted.logs.some(line => line.includes('runtime/heartbeat.json')), booted.logs.join('\n'));

    // A turma continua com a prova ativa e a aplicação em andamento.
    const [row] = await query('SELECT value FROM classes WHERE key = ?', ['c1::Turma Prova']);
    const cls = JSON.parse(row.value);
    assert.equal(cls.activeExamKey, 'Avaliacao_Boot');
    assert.equal(cls.onlineExamConfigs.Avaliacao_Boot.status, 'running');
    assert.equal(cls.releasedItems.Avaliacao_Boot, true);
});

test('[UC-GRAVACAO-001] depois do boot, uma entrega nova não regrava alunos nem presenças (DES-08)', async () => {
    await resetWriteCounts();
    const result = await runChild('submission');
    assert.deepEqual(result.uncaught, []);
    assert.deepEqual(await writeCounts(), { classes: 0, students: 0, attendance: 0 });
    assert.equal((await query('SELECT key FROM submissions WHERE key = ?', ['entrega-boot-1'])).length, 1);
    assert.equal(result.logs.some(line => line.includes('Provas online resetadas')), false);
});

test('[UC-GRAVACAO-001] aluno com JSON ilegível continua no arquivo depois de boots e gravações (DES-08)', async () => {
    const rows = await query('SELECT value FROM students WHERE key = ?', ['quebrado@boot.local']);
    assert.equal(rows.length, 1, 'a linha ilegível foi apagada');
    assert.equal(rows[0].value, 'nao-e-json');
    const [count] = await query('SELECT count(*) AS n FROM students');
    assert.ok(count.n >= 31, `alunos no arquivo: ${count.n}`);
});
