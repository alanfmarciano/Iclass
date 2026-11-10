// Processo filho de test/backend/database-storage.test.js: cada execução é um boot do
// banco (database.js abre o arquivo de ICLASS_DATA_DIR no require). Uso:
//   node database-child.js <cenário> [argumento]
// Imprime '@@' seguido do resultado em JSON e termina fechando o banco.
const path = require('node:path');
const sqlite3 = require('sqlite3');

const db = require('../../../backend/database.js');

const databaseFile = path.join(process.env.ICLASS_DATA_DIR, 'database.db');
const uncaught = [];
process.on('uncaughtException', err => uncaught.push(String((err && err.message) || err)));
process.on('unhandledRejection', err => uncaught.push(String((err && err.message) || err)));

function connect() {
    return new sqlite3.Database(databaseFile);
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

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const scenarios = {
    // Grava N presenças (o banco "de um ano" em miniatura).
    async seed(count) {
        const total = Number(count) || 2000;
        for (let index = 0; index < total; index += 1) {
            db.memory.attendance.push({ id: `presenca-${String(index).padStart(5, '0')}`, studentEmail: `aluno${index % 40}@boot.local`, date: '2026-03-02', status: 'presente' });
        }
        await db.save();
        return { first: db.memory.attendance[0].id, total: db.memory.attendance.length };
    },

    // Boot seguinte: muda uma nota e uma presença antiga e grava.
    async change() {
        db.memory.notes['nota@boot.local'] = { modulo: 'texto novo' };
        db.memory.attendance[0].status = 'abonado';
        await db.save();
        return { status: typeof db.storageStatus === 'function' ? db.storageStatus().lastCycle : null };
    },

    // Ordem da coleção depois do boot.
    async first() {
        return { first: db.memory.attendance[0].id, status: db.memory.attendance[0].status, total: db.memory.attendance.length };
    },

    // Trava de escrita além do busy_timeout (ICLASS_DB_BUSY_TIMEOUT_MS=200): o save
    // rejeita, nada fica pendurado e a regravação em segundo plano grava sozinha.
    async busy() {
        for (let index = 0; index < 50; index += 1) {
            db.memory.attendance.push({ id: `trava-${index}`, studentEmail: 'trava@boot.local', status: 'presente' });
        }
        await db.save();
        const external = connect();
        await exec(external, `CREATE TABLE IF NOT EXISTS contagem_teste (op TEXT PRIMARY KEY, n INTEGER NOT NULL);
            INSERT OR IGNORE INTO contagem_teste VALUES ('delete', 0), ('insert', 0), ('update', 0);
            CREATE TRIGGER IF NOT EXISTS conta_delete AFTER DELETE ON attendance BEGIN UPDATE contagem_teste SET n = n + 1 WHERE op = 'delete'; END;
            CREATE TRIGGER IF NOT EXISTS conta_insert AFTER INSERT ON attendance BEGIN UPDATE contagem_teste SET n = n + 1 WHERE op = 'insert'; END;
            CREATE TRIGGER IF NOT EXISTS conta_update AFTER UPDATE ON attendance BEGIN UPDATE contagem_teste SET n = n + 1 WHERE op = 'update'; END;`);
        await exec(external, 'BEGIN IMMEDIATE');
        const lockedAt = Date.now();
        db.memory.notes['trava@boot.local'] = { modulo: 'gravada depois da trava' };
        let error = null;
        try {
            await db.save();
        } catch (err) {
            error = { code: err.code, sqliteCode: err.sqliteCode, name: err.name };
        }
        const rejectedAfterMs = Date.now() - lockedAt;
        const statusWhileLocked = db.storageStatus();
        await wait(Math.max(0, 700 - (Date.now() - lockedAt)));
        await exec(external, 'COMMIT');
        const releasedAt = Date.now();
        // Sem chamar save de novo: a nota tem de aparecer no disco sozinha.
        const reader = connect();
        let foundAfterMs = null;
        while (Date.now() - releasedAt < 4000) {
            const row = await get(reader, 'SELECT value FROM notes WHERE key = ?', ['trava@boot.local']);
            if (row) {
                foundAfterMs = Date.now() - releasedAt;
                break;
            }
            await wait(100);
        }
        const counts = {};
        const rows = await new Promise((resolve, reject) => reader.all('SELECT op, n FROM contagem_teste', (err, result) => (err ? reject(err) : resolve(result))));
        rows.forEach(row => { counts[row.op] = row.n; });
        // Outra conexão consegue escrever: nenhuma transação ficou aberta.
        let otherWriter = 'ok';
        try {
            await exec(external, 'BEGIN IMMEDIATE; UPDATE contagem_teste SET n = n WHERE op = \'insert\'; COMMIT;');
        } catch (err) {
            otherWriter = String(err.message);
        }
        await closeConnection(reader);
        await closeConnection(external);
        return { error, rejectedAfterMs, statusWhileLocked, foundAfterMs, counts, otherWriter, statusAfter: db.storageStatus() };
    },

    // Linhas ilegíveis no arquivo (preparadas pelo teste antes do boot): config, um
    // singleton, e uma nota cuja chave volta a ser usada. O boot segue com o padrão; a
    // gravação guarda as linhas originais ao lado em vez de sobrescrevê-las.
    async unreadable() {
        const bootConfig = { ...db.memory.config };
        await db.save();
        db.memory.notes['volta@boot.local'] = { modulo: 'nota nova' };
        await db.save();
        return {
            hasSecret: typeof db.memory.config.examAnswerSecret === 'string',
            secret: db.memory.config.examAnswerSecret,
            bootConfigKeys: Object.keys(bootConfig).sort(),
        };
    },

    // Boot seguinte: o que foi gravado volta (segredo igual) e as cópias continuam no arquivo.
    async reboot() {
        await db.save();
        return { secret: db.memory.config.examAnswerSecret, notes: Object.keys(db.memory.notes).sort() };
    },

    // Pedido que entra durante um ciclo travado: espera no total cerca de um busy_timeout
    // (ICLASS_DB_BUSY_TIMEOUT_MS=1000), e não o ciclo travado mais o dele (2 s).
    async busyQueue() {
        await db.save();
        const external = connect();
        await exec(external, 'BEGIN IMMEDIATE');
        const outcome = (startedAt, promise) => promise.then(
            () => ({ ok: true, ms: Date.now() - startedAt }),
            err => ({ ok: false, code: err.code, sqliteCode: err.sqliteCode, ms: Date.now() - startedAt }));
        db.memory.notes['fila-a@boot.local'] = { modulo: 'primeira' };
        const first = outcome(Date.now(), db.save());
        await wait(300);
        db.memory.notes['fila-b@boot.local'] = { modulo: 'segunda, durante o ciclo travado' };
        const second = outcome(Date.now(), db.save());
        const [a, b] = await Promise.all([first, second]);
        await exec(external, 'COMMIT');
        await closeConnection(external);
        // A conexão volta ao busy_timeout normal depois do ciclo encurtado.
        const busyAfter = await db.runExclusive(connection => get(connection, 'PRAGMA busy_timeout'));
        await db.save();
        const reader = connect();
        const saved = await get(reader, 'SELECT count(*) AS n FROM notes WHERE key IN (?, ?)', ['fila-a@boot.local', 'fila-b@boot.local']);
        await closeConnection(reader);
        return { a, b, busyAfter: Number(Object.values(busyAfter)[0]), saved: saved.n };
    },
};

(async () => {
    const [scenario, argument] = process.argv.slice(2);
    await db.init();
    const result = await scenarios[scenario](argument);
    await db.close();
    process.stdout.write(`@@${JSON.stringify({ ...result, uncaught })}`);
})().catch(err => {
    process.stdout.write(`@@${JSON.stringify({ fatal: String((err && err.stack) || err), uncaught })}`);
    process.exitCode = 1;
});
