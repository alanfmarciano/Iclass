// Arquivo de banco SQLite fora da conexão principal (H4a: CONF-07, CONF-08, OPS-05): a
// cópia do VACUUM INTO, o banco que veio dentro de um backup formato 2 e o banco parado
// que a backup-cli confere. Sem estado: cada função abre, lê e fecha a própria conexão.
// Não depende de database.js, para a backup-cli usá-lo com o servidor parado sem abrir
// o banco de dados de verdade.
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');

// Códigos do SQLite que dizem "o arquivo não é um banco legível" (cabeçalho trocado,
// páginas estragadas). SQLITE_BUSY e SQLITE_CANTOPEN não entram: são trava ou caminho.
const CORRUPT_SQLITE_CODES = new Set(['SQLITE_NOTADB', 'SQLITE_CORRUPT']);

function openDatabaseFile(file, { readOnly = true } = {}) {
    return new Promise((resolve, reject) => {
        const mode = readOnly ? sqlite3.OPEN_READONLY : (sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
        const connection = new sqlite3.Database(file, mode, err => (err ? reject(err) : resolve(connection)));
        // Erro de statement sem callback não pode derrubar o processo.
        connection.on('error', () => {});
    });
}

function closeDatabaseFile(connection) {
    return new Promise(resolve => {
        if (!connection) return resolve();
        connection.close(() => resolve());
    });
}

function allOn(connection, sql, params = []) {
    return new Promise((resolve, reject) => connection.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
}

function getOn(connection, sql, params = []) {
    return new Promise((resolve, reject) => connection.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
}

// Erro de banco danificado (code ICLASS_DB_CORRUPT): o boot sai com o código 3 e a
// restauração recusa o backup.
function corruptDatabaseError(detail, { file = '', cause = null } = {}) {
    const error = new Error(`O banco de dados${file ? ` (${file})` : ''} está danificado: ${detail}`);
    error.code = 'ICLASS_DB_CORRUPT';
    if (file) error.dbFile = file;
    if (cause) error.cause = cause;
    return error;
}

// PRAGMA quick_check: vale só exatamente uma linha 'ok'. NOTADB e CORRUPT viram
// ICLASS_DB_CORRUPT; outros erros (trava, sem permissão) seguem como estão.
async function quickCheck(connection, { file = '' } = {}) {
    let rows;
    try {
        rows = await allOn(connection, 'PRAGMA quick_check');
    } catch (err) {
        if (err && CORRUPT_SQLITE_CODES.has(err.code)) throw corruptDatabaseError(err.code, { file, cause: err });
        throw err;
    }
    const values = (rows || []).map(row => String(Object.values(row)[0]));
    if (values.length !== 1 || values[0] !== 'ok') {
        throw corruptDatabaseError(`a verificação do SQLite encontrou problemas (${values.slice(0, 3).join('; ') || 'sem resposta'})`, { file });
    }
    return 'ok';
}

// Tabelas do arquivo (sem as internas do SQLite).
async function tableNames(connection) {
    const rows = await allOn(connection, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    return rows.map(row => row.name);
}

// Linhas de cada tabela: { nome: contagem }.
async function tableCounts(connection) {
    const counts = {};
    for (const name of await tableNames(connection)) {
        const row = await getOn(connection, `SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`);
        counts[name] = Number(row && row.n) || 0;
    }
    return counts;
}

// SHA-256 de um arquivo, lido aos pedaços (sem carregar na memória).
function fileSha256(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(file, { highWaterMark: 1024 * 1024 });
        stream.on('error', reject);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

// Confere um arquivo de banco parado: quick_check, contagem de cada tabela, tamanho e
// SHA-256. Rejeita com ICLASS_DB_CORRUPT quando o arquivo não passa.
async function inspectDatabaseFile(file) {
    const connection = await openDatabaseFile(file, { readOnly: true });
    let counts;
    try {
        await quickCheck(connection, { file });
        counts = await tableCounts(connection);
    } catch (err) {
        if (err && CORRUPT_SQLITE_CODES.has(err.code)) throw corruptDatabaseError(err.code, { file, cause: err });
        throw err;
    } finally {
        await closeDatabaseFile(connection);
    }
    const stat = await fs.promises.stat(file);
    return { file, bytes: stat.size, sha256: await fileSha256(file), tabelas: counts, quickCheck: 'ok' };
}

module.exports = {
    CORRUPT_SQLITE_CODES,
    allOn,
    closeDatabaseFile,
    corruptDatabaseError,
    fileSha256,
    getOn,
    inspectDatabaseFile,
    openDatabaseFile,
    quickCheck,
    tableCounts,
    tableNames,
};
