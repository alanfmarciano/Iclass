// Processo filho de test/backend/keystroke-store.test.js: cada execução é um boot do
// banco (database.js abre o arquivo de ICLASS_DATA_DIR no require e o init migra o
// histórico de digitação antigo). Uso:
//   node keystroke-child.js <cenário> [argumento]
// Imprime '@@' seguido do resultado em JSON e termina fechando o banco.
const path = require('node:path');
const sqlite3 = require('sqlite3');

const db = require('../../../backend/database.js');
const { KEYSTROKE_SCHEMA, LEGACY_KEYSTROKE_TABLE, KEYSTROKE_TABLE } = require('../../../backend/utils/keystrokeStore.js');

const dataDir = process.env.ICLASS_DATA_DIR;
const databaseFile = path.join(dataDir, 'database.db');
const uncaught = [];
process.on('uncaughtException', err => uncaught.push(String((err && err.message) || err)));
process.on('unhandledRejection', err => uncaught.push(String((err && err.message) || err)));

function open(file) {
    return new sqlite3.Database(file);
}

function exec(connection, sql) {
    return new Promise((resolve, reject) => connection.exec(sql, err => (err ? reject(err) : resolve())));
}

function run(connection, sql, params = []) {
    return new Promise((resolve, reject) => connection.run(sql, params, err => (err ? reject(err) : resolve())));
}

function all(connection, sql, params = []) {
    return new Promise((resolve, reject) => connection.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
}

function closeConnection(connection) {
    return new Promise(resolve => connection.close(() => resolve()));
}

async function fileCounts() {
    const reader = open(databaseFile);
    try {
        const [legacy] = await all(reader, `SELECT COUNT(*) AS n FROM ${LEGACY_KEYSTROKE_TABLE}`);
        const [current] = await all(reader, `SELECT COUNT(*) AS n FROM ${KEYSTROKE_TABLE}`);
        const legacyKeys = (await all(reader, `SELECT key FROM ${LEGACY_KEYSTROKE_TABLE} ORDER BY key`)).map(row => row.key);
        return { legacy: legacy.n, current: current.n, legacyKeys };
    } finally {
        await closeConnection(reader);
    }
}

const event = (id, email, extra = {}) => ({
    id,
    studentEmail: email,
    studentClass: 'Turma Origem',
    courseId: 'curso-origem',
    examKey: 'Prova_Origem',
    applicationId: 'app-origem',
    attemptId: 'tentativa-1',
    seq: 1,
    clientTs: 1000,
    serverTs: 1000,
    key: 'a',
    code: 'KeyA',
    mods: '',
    kind: 'key',
    question: '1',
    blocked: false,
    suspicious: false,
    ...extra,
});

const scenarios = {
    // Boot sobre o banco antigo (a migração roda no init): o que ficou em cada tabela,
    // os contadores e o que a consulta da digitação ao vivo devolve.
    async migrate() {
        const counts = await fileCounts();
        const ana = await db.keystrokes.query({ email: 'ana@migra.local', examKey: 'prova_migra' });
        return {
            ...counts,
            inMemory: Object.prototype.hasOwnProperty.call(db.memory, 'examKeystrokes'),
            total: db.storageStatus().keystrokes,
            anaStats: db.keystrokes.stats({ email: 'ana@migra.local', examKey: 'Prova_Migra', applicationId: 'app-migra' }),
            anaAllStats: db.keystrokes.stats({ email: 'ANA@migra.local', examKey: 'PROVA_MIGRA' }),
            ana,
            longIdLength: ((await db.keystrokes.findByEmails(['longo@migra.local']))[0] || { id: '' }).id.length,
        };
    },

    // Escritas do store fora das rotas: retenção (deleteWhere), exportação e importação do
    // backup (exportRows, importRows) e cópia de outro arquivo de banco (copyFromAttached),
    // da tabela nova e da antiga.
    async units() {
        const out = {};
        await db.keystrokes.append([
            event('u-1', 'um@units.local', { applicationId: 'app-velha', serverTs: 1000 }),
            event('u-2', 'um@units.local', { applicationId: 'app-velha', serverTs: 2000 }),
            event('u-3', 'um@units.local', { applicationId: 'app-nova', serverTs: Date.now() }),
            event('u-4', 'dois@units.local', { applicationId: 'app-velha', serverTs: 3000 }),
        ]);
        out.afterAppend = db.storageStatus().keystrokes;
        try {
            db.keystrokes.deleteWhere({});
            out.deleteWhereWithoutFilter = 'aceito';
        } catch (err) {
            out.deleteWhereWithoutFilter = err.name;
        }
        out.deleteOldest = await db.keystrokes.deleteWhere({ before: 2500, max: 1 });
        out.afterDeleteOldest = (await db.keystrokes.findByEmails(['um@units.local', 'dois@units.local'])).map(item => item.id).sort();
        out.deleteApplication = await db.keystrokes.deleteWhere({ applicationIds: ['app-velha'] });
        out.afterDeleteApplication = (await db.keystrokes.findByEmails(['um@units.local', 'dois@units.local'])).map(item => item.id).sort();
        out.statsAfterDelete = db.keystrokes.stats({ email: 'um@units.local' });

        out.exported = (await db.keystrokes.exportRows()).map(item => ({ id: item.id, studentEmail: item.studentEmail, applicationId: item.applicationId }));
        out.importReplace = await db.keystrokes.importRows([
            event('i-1', 'Tres@Units.local', { suspicious: true }),
            event('i-2', 'tres@units.local', { blocked: true }),
            event('i-1', 'tres@units.local'),
            { id: 'sem-prova', studentEmail: 'tres@units.local' },
        ], { replace: true });
        out.afterImport = (await db.keystrokes.exportRows()).map(item => item.id);
        out.statsAfterImport = db.keystrokes.stats({ email: 'tres@units.local', examKey: 'prova_origem' });

        out.renamed = await db.keystrokes.renameEmail('tres@units.local', 'tres.nova@units.local');
        out.statsOldEmail = db.keystrokes.stats({ email: 'tres@units.local' });
        out.statsNewEmail = db.keystrokes.stats({ email: 'tres.nova@units.local' });

        // Outro arquivo de banco: um da versão nova (tabela própria) e um antigo (JSON).
        const newSource = path.join(dataDir, 'origem-nova.db');
        const source = open(newSource);
        await exec(source, KEYSTROKE_SCHEMA.join(';\n'));
        await run(source, `INSERT INTO ${KEYSTROKE_TABLE} (id, student_email, exam_key, application_id, server_ts, suspicious) VALUES (?, ?, ?, ?, ?, ?)`,
            ['c-1', 'quatro@units.local', 'Prova_Copia', 'app-copia', 5000, 1]);
        await run(source, `INSERT INTO ${KEYSTROKE_TABLE} (id, student_email, exam_key, application_id, server_ts) VALUES (?, ?, ?, ?, ?)`,
            ['i-1', 'repetido@units.local', 'Prova_Copia', 'app-copia', 5000]);
        await closeConnection(source);
        const legacySource = path.join(dataDir, 'origem-antiga.db');
        const legacy = open(legacySource);
        await exec(legacy, `CREATE TABLE ${LEGACY_KEYSTROKE_TABLE} (key TEXT PRIMARY KEY, value TEXT)`);
        await run(legacy, `INSERT INTO ${LEGACY_KEYSTROKE_TABLE} (key, value) VALUES (?, ?), (?, ?)`, [
            'l-1', JSON.stringify(event('l-1', 'Cinco@Units.local', { examKey: 'Prova_Antiga', applicationId: null })),
            'l-2', '{ilegível',
        ]);
        await closeConnection(legacy);
        out.copyNew = await db.keystrokes.copyFromAttached(newSource);
        out.copyLegacy = await db.keystrokes.copyFromAttached(legacySource);
        out.afterCopy = (await db.keystrokes.exportRows()).map(item => `${item.id}:${item.studentEmail}`);
        out.statsCopied = db.keystrokes.stats({ email: 'quatro@units.local', examKey: 'PROVA_COPIA' });
        out.statsLegacyCopied = db.keystrokes.stats({ email: 'cinco@units.local', examKey: 'prova_antiga' });
        out.copyReplace = await db.keystrokes.copyFromAttached(newSource, { replace: true });
        out.afterCopyReplace = (await db.keystrokes.exportRows()).map(item => item.id).sort();
        out.total = db.storageStatus().keystrokes;
        return out;
    },

    // Boot seguinte: os contadores saem do arquivo (GROUP BY).
    async counters() {
        return {
            total: db.storageStatus().keystrokes,
            entries: db.keystrokes.statsEntries().map(entry => `${entry.studentEmail}:${entry.applicationId}:${entry.total}`).sort(),
        };
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
