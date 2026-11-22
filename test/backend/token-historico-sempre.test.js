// Token da prova fora do histórico em todo boot (fase 3, A4 / P3-S8: AVA-14, D19; rodada
// de ajuste 2). A linha '2026-11-p3-token-historico' do registro tira o token em texto puro
// de classes[].examHistory[prova][].accessToken uma vez só. A versão 281029f não recusa o
// banco migrado: se o Alan voltar para ela e preparar uma prova pela tela Provas antiga, o
// token em texto volta para o histórico (e para os backups feitos lá). A normalização
// '2026-11-p3-token-historico-sempre' (BOOT_NORMALIZATIONS) faz a mesma limpeza em todo
// boot e depois de toda restauração. Cada boot roda num processo próprio
// (fixtures/schema-boot-child.js) sobre uma cópia de fixtures/banco-281029f.db, com o
// registro de verdade.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3');

const { MIGRATIONS, BOOT_NORMALIZATIONS } = require('../../backend/migrations/index.js');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-token-historico-test-'));
const fixtureDb = path.join(__dirname, 'fixtures', 'banco-281029f.db');
const childScript = path.join(__dirname, 'fixtures', 'schema-boot-child.js');
const legacyBackup = path.join(__dirname, 'fixtures', 'backup-versao-anterior.json');
const NORMALIZATION = BOOT_NORMALIZATIONS.find(row => row.id === '2026-11-p3-token-historico-sempre');
const MIGRATION = MIGRATIONS.find(row => row.id === '2026-11-p3-token-historico');

test.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

let counter = 0;
function newDataDir(name) {
    counter += 1;
    const root = path.join(tempRoot, `${name}-${counter}`);
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'content'), { recursive: true });
    fs.copyFileSync(fixtureDb, path.join(dataDir, 'database.db'));
    return { root, dataDir, dbFile: path.join(dataDir, 'database.db') };
}

function envFor(dataDir) {
    const env = {
        ...process.env,
        ICLASS_DATA_DIR: dataDir,
        ICLASS_CONTENT_DIR: path.join(path.dirname(dataDir), 'content'),
        ICLASS_ARCHIVE_DIR: path.join(path.dirname(dataDir), 'arquivados'),
        TEST_MODE: '1',
        PORT: '1',
    };
    ['NODE_TEST_CONTEXT', 'ICLASS_VERIFY_SAVES', 'ICLASS_ATUALIZAR_SEM_BACKUP', 'ICLASS_TEST_MIGRATIONS', 'ICLASS_TEST_FREE_BYTES'].forEach(key => delete env[key]);
    return env;
}

function bootOnce(dataDir, scenario, argument) {
    const args = [childScript];
    if (scenario) args.push(scenario, argument);
    const result = spawnSync(process.execPath, args, { env: envFor(dataDir), encoding: 'utf8', timeout: 90000, maxBuffer: 32 * 1024 * 1024 });
    const marker = String(result.stdout || '').lastIndexOf('@@');
    assert.notEqual(marker, -1, `${result.stdout}\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout.slice(marker + 2));
    assert.equal(result.status, 0, parsed.message);
    return parsed;
}

async function withDb(file, mode, fn) {
    const connection = await new Promise((resolve, reject) => {
        const handle = new sqlite3.Database(file, mode, err => (err ? reject(err) : resolve(handle)));
    });
    const all = (sql, params = []) => new Promise((resolve, reject) => connection.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
    const run = (sql, params = []) => new Promise((resolve, reject) => connection.run(sql, params, err => (err ? reject(err) : resolve())));
    try {
        return await fn({ all, run });
    } finally {
        await new Promise(resolve => connection.close(() => resolve()));
    }
}

// Como a 281029f grava ao preparar pela tela Provas: uma configuração salva com o token em
// texto puro no histórico da primeira turma.
function writeHistoryAs281029f(file, token) {
    return withDb(file, sqlite3.OPEN_READWRITE, async ({ all, run }) => {
        const [row] = await all('SELECT key, value FROM classes ORDER BY key LIMIT 1');
        const cls = JSON.parse(row.value);
        if (!cls.examHistory || typeof cls.examHistory !== 'object') cls.examHistory = {};
        cls.examHistory.Avaliacao_Volta = [{ id: 'hist_volta', durationMinutes: 30, accessToken: token, savedAt: '2026-11-20T10:00:00.000Z' }];
        await run('UPDATE classes SET value = ? WHERE key = ?', [JSON.stringify(cls), row.key]);
        return row.key;
    });
}

function readClasses(file) {
    return withDb(file, sqlite3.OPEN_READONLY, async ({ all }) => (await all('SELECT key, value FROM classes')).map(row => ({ key: row.key, value: row.value })));
}

test('[UC-TENTATIVA-004] a normalização 2026-11-p3-token-historico-sempre limpa como a migração, é idempotente e não grava sem mudança', () => {
    assert.ok(NORMALIZATION, 'a normalização está em BOOT_NORMALIZATIONS');
    assert.ok(MIGRATION, 'a migração continua no registro (linha publicada não muda)');
    const sample = () => ({
        classes: [
            {
                name: 'A',
                examHistory: {
                    P1: [
                        { id: 'h1', accessToken: 'PROVA', durationMinutes: 30 },
                        { id: 'h2', accessToken: '', tokenEnabled: false },
                        { id: 'h3', accessToken: null, tokenEnabled: true },
                        { id: 'h4', accessToken: 'abc', tokenEnabled: false },
                        { id: 'h5', tokenEnabled: false },
                    ],
                    P2: 'lixo',
                },
            },
            { name: 'B', examHistory: null },
            { name: 'C', examHistory: [] },
            null,
        ],
    });
    const byNormalization = sample();
    const byMigration = sample();
    assert.equal(NORMALIZATION.run(byNormalization, { origem: 'boot' }), true);
    assert.equal(MIGRATION.run(byMigration), true);
    assert.deepEqual(byNormalization, byMigration, 'o mesmo resultado da migração');
    assert.doesNotMatch(JSON.stringify(byNormalization), /accessToken|PROVA/);
    const [h1, h2, h3, h4, h5] = byNormalization.classes[0].examHistory.P1;
    assert.deepEqual(h1, { id: 'h1', durationMinutes: 30, tokenEnabled: true });
    assert.deepEqual(h2, { id: 'h2', tokenEnabled: false });
    assert.deepEqual(h3, { id: 'h3', tokenEnabled: true });
    assert.deepEqual(h4, { id: 'h4', tokenEnabled: false }, 'texto que não é token de 5 letras não liga o token');
    assert.deepEqual(h5, { id: 'h5', tokenEnabled: false });
    const snapshot = JSON.stringify(byNormalization);
    assert.equal(NORMALIZATION.run(byNormalization, { origem: 'boot' }), false, 'segunda passada não muda nada');
    assert.equal(JSON.stringify(byNormalization), snapshot);
    assert.equal(NORMALIZATION.run({}, { origem: 'restauracao' }), false);
});

test('[UC-TENTATIVA-004] volta pela 281029f: o token que ela grava no histórico some no boot seguinte, que depois não grava nada', async () => {
    const dir = newDataDir('volta-281029f');
    const first = bootOnce(dir.dataDir);
    assert.ok(first.info.aplicadasAgora.includes('2026-11-p3-token-historico'));
    const steady = bootOnce(dir.dataDir);
    assert.equal(steady.savesSinceBoot, 0, 'sem token no histórico, o boot não grava');

    // A 281029f preparou uma prova com o token GIZES depois da migração.
    const key = await writeHistoryAs281029f(dir.dbFile, 'GIZES');
    assert.match(JSON.stringify(await readClasses(dir.dbFile)), /GIZES/);
    const back = bootOnce(dir.dataDir);
    assert.deepEqual(back.info.aplicadasAgora, [], 'a migração não roda de novo');
    assert.ok(back.savesSinceBoot > 0, 'a normalização gravou');
    const classes = await readClasses(dir.dbFile);
    assert.doesNotMatch(JSON.stringify(classes), /GIZES/, 'nenhum token em texto puro no banco');
    const cls = JSON.parse(classes.find(row => row.key === key).value);
    assert.deepEqual(cls.examHistory.Avaliacao_Volta[0], { id: 'hist_volta', durationMinutes: 30, savedAt: '2026-11-20T10:00:00.000Z', tokenEnabled: true });

    // E o boot seguinte não muda mais nada.
    const again = bootOnce(dir.dataDir);
    assert.equal(again.savesSinceBoot, 0);
    assert.deepEqual(await readClasses(dir.dbFile), classes);
});

test('[UC-TENTATIVA-004] restaurar um backup feito pela 281029f com o token no histórico deixa o banco sem o token', async () => {
    const dir = newDataDir('restaurar');
    bootOnce(dir.dataDir);
    const fixture = JSON.parse(fs.readFileSync(legacyBackup, 'utf8')).backup;
    const cls = fixture.data.classes[0];
    cls.examHistory = { ...(cls.examHistory || {}), Avaliacao_Volta: [{ id: 'hist_backup', accessToken: 'LOUSA', durationMinutes: 20 }] };
    const file = path.join(dir.root, 'backup-281029f-com-token.json');
    fs.writeFileSync(file, JSON.stringify(fixture));
    const restored = bootOnce(dir.dataDir, 'restaurar', file);
    assert.equal(restored.restore.ok, true, restored.restore.message);
    const classes = await readClasses(dir.dbFile);
    assert.doesNotMatch(JSON.stringify(classes), /LOUSA/);
    const entry = classes.map(row => JSON.parse(row.value)).find(item => item.examHistory && item.examHistory.Avaliacao_Volta).examHistory.Avaliacao_Volta[0];
    assert.deepEqual(entry, { id: 'hist_backup', durationMinutes: 20, tokenEnabled: true });
});
