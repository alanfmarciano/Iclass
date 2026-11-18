// Processo filho de test/backend/schema-migrations.test.js (A0, P6-S1): cada execução é um
// boot (database.js abre o arquivo de ICLASS_DATA_DIR no require) pelo prepareServer do
// server.js, sem o build e sem abrir a porta. Uso:
//   node schema-boot-child.js [cenário]
// Variáveis:
// - ICLASS_TEST_MIGRATIONS: arquivo .js com { MIGRATIONS, BOOT_NORMALIZATIONS } que
//   substitui o registro de backend/migrations/index.js (registro-de-teste.js);
// - ICLASS_TEST_FREE_BYTES: fs.promises.statfs passa a dizer que há só esses bytes livres.
// Cenários: 'boot' (padrão) e 'restaurar <arquivo do backup>' (o boot e depois a
// restauração pela mesma função da tela Sistema, backup.applyRestore).
// Imprime '@@' seguido do resultado em JSON. Falha no boot: o código de saída e a
// mensagem de describeBootFailure, como o servidor de verdade (failBoot).
const fs = require('node:fs');

const logs = [];
['log', 'warn', 'error'].forEach(level => {
    const original = console[level].bind(console);
    console[level] = (...args) => {
        logs.push(args.map(value => (typeof value === 'string' ? value : JSON.stringify(value))).join(' '));
        if (process.env.ICLASS_CHILD_ECHO) original(...args);
    };
});

if (process.env.ICLASS_TEST_FREE_BYTES) {
    const free = Number(process.env.ICLASS_TEST_FREE_BYTES);
    const statfs = fs.promises.statfs.bind(fs.promises);
    fs.promises.statfs = async (...args) => {
        const stat = await statfs(...args);
        return { ...stat, bsize: 1, bavail: free };
    };
}

require('./registro-de-teste.js');
const db = require('../../../backend/database.js');
const { prepareServer, describeBootFailure } = require('../../../backend/server.js');
const serverLifecycle = require('../../../backend/utils/serverLifecycle.js');

const phases = [];
const setBootPhase = serverLifecycle.setBootPhase;
serverLifecycle.setBootPhase = phase => {
    phases.push(phase);
    return setBootPhase(phase);
};

// Lido depois do db.close, numa conexão própria só de leitura.
async function userVersion() {
    const dbFile = require('../../../backend/utils/dbFile.js');
    const connection = await dbFile.openDatabaseFile(db.dbPath, { readOnly: true });
    try {
        return (await dbFile.getOn(connection, 'PRAGMA user_version')).user_version;
    } finally {
        await dbFile.closeDatabaseFile(connection);
    }
}

function finish(result, exitCode = 0) {
    process.stdout.write(`@@${JSON.stringify(result)}`);
    process.exit(exitCode);
}

(async () => {
    const [scenario = 'boot', argument] = process.argv.slice(2);
    try {
        await prepareServer();
    } catch (err) {
        const failure = describeBootFailure('database', err);
        finish({ failed: true, exitCode: failure.exitCode, message: failure.message, code: err && err.code, logs }, failure.exitCode);
        return;
    }
    const result = { savesBeforeChildSave: db.storageStatus().savesSinceBoot };
    if (scenario === 'restaurar') {
        const backup = require('../../../backend/utils/backup.js');
        try {
            const path = require('node:path');
            const { prepared, preview } = await backup.prepareRestore(argument, { originalName: path.basename(argument), keepSource: true });
            result.preview = { nota: Object.fromEntries((preview.contagens || []).filter(item => item.nota).map(item => [item.colecao || item.collection, item.nota])), ficamComoEstao: preview.ficamComoEstao || null };
            await backup.applyPreparedRestore(prepared, { acceptLegacy: true });
            result.restore = { ok: true };
        } catch (err) {
            result.restore = { ok: false, status: err.status || null, code: err.code || null, message: err.message };
        }
    }
    await db.save();
    Object.assign(result, {
        info: db.schemaBootInfo(),
        schemaMeta: db.memory.schemaMeta,
        audits: (db.memory.auditLogs || [])
            .filter(entry => entry && /^(app_updated|backup_preupdate_|schema_migrated_on_restore)/.test(entry.action))
            .map(entry => ({ action: entry.action, category: entry.category, actor: entry.actor, details: entry.details })),
        counts: Object.fromEntries(['students', 'submissions', 'attendance', 'forum', 'admins', 'classes', 'assignments']
            .map(key => [key, Array.isArray(db.memory[key]) ? db.memory[key].length : null])),
        marks: (db.memory.config && db.memory.config.testMarks) || null,
        savesSinceBoot: result.savesBeforeChildSave,
        phases,
        logs,
    });
    await db.close();
    result.userVersion = await userVersion();
    finish(result);
})().catch(err => finish({ failed: true, crashed: true, message: String((err && err.stack) || err), logs }, 1));
