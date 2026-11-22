// Identidade da instalação em todo boot (fase 3, A1 / P6-S2: OPS-02, OPS-21; rodada de
// ajuste). A linha '2026-11-p6-instalacao' do registro dá a settings.install um código e a
// data uma vez só. A versão 281029f não conhece a seção: ao salvar Configurações
// (mergeSettings só com as chaves dela) ela a apaga, e ao restaurar pela tela dela a seção
// vem do backup (talvez de outro computador). Antes, de volta ao código novo, a migração
// não rodava de novo e a instalação ficava sem código para sempre ("reinicie o IClass" não
// resolvia). Agora a normalização '2026-11-p6-instalacao-sempre' (BOOT_NORMALIZATIONS)
// confere a identidade em todo boot e depois de toda restauração, pela cópia em
// schemaMeta.instalacao (tabela schema_meta, que a 281029f nunca toca).
// Cada boot roda num processo próprio (fixtures/schema-boot-child.js) sobre uma cópia de
// fixtures/banco-281029f.db, com o registro de verdade.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3');
const proc = require('./fixtures/server-process.js');

const { MIGRATIONS, BOOT_NORMALIZATIONS } = require('../../backend/migrations/index.js');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-instalacao-test-'));
const fixtureDb = path.join(__dirname, 'fixtures', 'banco-281029f.db');
const childScript = path.join(__dirname, 'fixtures', 'schema-boot-child.js');
const cli = path.join(__dirname, '..', '..', 'backend', 'scripts', 'backup-cli.js');
const legacyBackup = path.join(__dirname, 'fixtures', 'backup-versao-anterior.json');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NORMALIZATION = BOOT_NORMALIZATIONS.find(row => row.id === '2026-11-p6-instalacao-sempre');
const MIGRATION = MIGRATIONS.find(row => row.id === '2026-11-p6-instalacao');
const OTHER = { id: '11111111-2222-4333-8444-555555555555', criadaEm: 1, licenciadoPara: 'Outra escola' };

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
    return { root, dataDir, dbFile: path.join(dataDir, 'database.db'), backupsDir: path.join(dataDir, 'backups') };
}

function envFor(dataDir, port = 1) {
    const env = {
        ...process.env,
        ICLASS_DATA_DIR: dataDir,
        ICLASS_CONTENT_DIR: path.join(path.dirname(dataDir), 'content'),
        ICLASS_ARCHIVE_DIR: path.join(path.dirname(dataDir), 'arquivados'),
        TEST_MODE: '1',
        PORT: String(port),
    };
    ['NODE_TEST_CONTEXT', 'ICLASS_VERIFY_SAVES', 'ICLASS_ATUALIZAR_SEM_BACKUP', 'ICLASS_TEST_MIGRATIONS', 'ICLASS_TEST_FREE_BYTES'].forEach(key => delete env[key]);
    return env;
}

// Um boot (e, com 'restaurar', a restauração pela mesma função da tela Sistema).
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

// O que está gravado: settings.install e a cópia em schemaMeta.instalacao.
function readIdentity(file) {
    return withDb(file, sqlite3.OPEN_READONLY, async ({ all }) => {
        const config = JSON.parse((await all("SELECT value FROM config WHERE key = 'app_config'"))[0].value);
        const metaRow = (await all("SELECT value FROM schema_meta WHERE key = 'default'"))[0];
        return { install: config.settings && config.settings.install, copia: metaRow ? JSON.parse(metaRow.value).instalacao : undefined };
    });
}

// Grava a seção como a 281029f deixaria (sem ela, ou a de outro backup), com o resto igual.
function writeInstallAs281029f(file, install) {
    return withDb(file, sqlite3.OPEN_READWRITE, async ({ all, run }) => {
        const config = JSON.parse((await all("SELECT value FROM config WHERE key = 'app_config'"))[0].value);
        if (install === undefined) delete config.settings.install;
        else config.settings.install = install;
        await run("UPDATE config SET value = ? WHERE key = 'app_config'", [JSON.stringify(config)]);
    });
}

test('[UC-VERSAO-006] a normalização da identidade: cópia em schemaMeta.instalacao, idempotente, e a cópia vale quando a seção sumiu ou veio de outro computador', () => {
    assert.ok(NORMALIZATION, 'a normalização 2026-11-p6-instalacao-sempre está em BOOT_NORMALIZATIONS');
    assert.ok(MIGRATION, 'a migração 2026-11-p6-instalacao continua no registro');
    const ctx = { origem: 'boot', now: 1763424000000, versaoApp: '3.0.0', previousStudentIds: new Map() };

    // Primeiro boot depois da migração: a seção existe e ganha a cópia.
    const memory = { config: { settings: { timezone: 'America/Sao_Paulo' } }, schemaMeta: { aplicadas: [], atualizacoes: [] } };
    MIGRATION.run(memory, ctx);
    const original = structuredClone(memory.config.settings.install);
    assert.equal(NORMALIZATION.run(memory, ctx), true);
    assert.deepEqual(memory.schemaMeta.instalacao, original);
    assert.deepEqual(memory.config.settings.install, original);
    const snapshot = structuredClone(memory);
    assert.equal(NORMALIZATION.run(memory, { ...ctx, now: ctx.now + 9000 }), false, 'idempotente');
    assert.deepEqual(memory, snapshot);

    // A 281029f salvou Configurações: a seção sumiu. Volta o mesmo código e a mesma data.
    delete memory.config.settings.install;
    assert.equal(NORMALIZATION.run(memory, { ...ctx, now: ctx.now + 60000 }), true);
    assert.deepEqual(memory.config.settings.install, original);
    assert.equal(memory.config.settings.timezone, 'America/Sao_Paulo', 'o resto das configurações fica');

    // A 281029f restaurou o backup de outro computador: o código e a data voltam a ser os
    // desta instalação; o resto da seção (a licença do A21b) fica como está.
    memory.config.settings.install = { ...OTHER };
    assert.equal(NORMALIZATION.run(memory, ctx), true);
    assert.deepEqual(memory.config.settings.install, { ...original, licenciadoPara: 'Outra escola' });
    assert.deepEqual(memory.schemaMeta.instalacao, original);

    // Sem a cópia e sem a seção (banco estranho): código novo e a data de agora, nos dois.
    const bare = {};
    assert.equal(NORMALIZATION.run(bare, ctx), true);
    assert.match(bare.config.settings.install.id, UUID);
    assert.equal(bare.config.settings.install.criadaEm, ctx.now);
    assert.deepEqual(bare.schemaMeta.instalacao, bare.config.settings.install);
    assert.deepEqual(bare.schemaMeta.aplicadas, []);

    // Cópia estragada (editada à mão): vale a seção, e a cópia é refeita.
    const broken = { config: { settings: { install: { id: 'codigo-bom', criadaEm: 5 } } }, schemaMeta: { aplicadas: [], atualizacoes: [], instalacao: { id: '', criadaEm: 'ontem' } } };
    assert.equal(NORMALIZATION.run(broken, ctx), true);
    assert.deepEqual(broken.config.settings.install, { id: 'codigo-bom', criadaEm: 5 });
    assert.deepEqual(broken.schemaMeta.instalacao, { id: 'codigo-bom', criadaEm: 5 });
});

test('[UC-VERSAO-006] volta pela 281029f (X7): Configurações salvas lá apagam a identidade e o boot seguinte põe de volta o mesmo código e a mesma data', async () => {
    const dir = newDataDir('volta-281029f');
    const first = bootOnce(dir.dataDir);
    assert.ok(first.info.aplicadasAgora.includes('2026-11-p6-instalacao'));
    const before = await readIdentity(dir.dbFile);
    assert.match(before.install.id, UUID);
    assert.deepEqual(Object.keys(before.install).sort(), ['criadaEm', 'id']);
    assert.deepEqual(before.copia, before.install, 'a cópia nasce no mesmo boot');

    // O segundo boot não muda nada.
    const steady = bootOnce(dir.dataDir);
    assert.deepEqual(steady.info.aplicadasAgora, []);
    assert.equal(steady.savesSinceBoot, 0, 'o boot sem nada a fazer não grava');

    // A 281029f gravou Configurações (a seção some); nenhuma migração está pendente.
    await writeInstallAs281029f(dir.dbFile, undefined);
    const back = bootOnce(dir.dataDir);
    assert.deepEqual(back.info.aplicadasAgora, [], 'a migração não roda de novo');
    assert.deepEqual(back.info.pendentes, []);
    assert.deepEqual(await readIdentity(dir.dbFile), before, 'o mesmo código e a mesma data');

    // A 281029f restaurou pela tela dela o backup de outro computador (a seção veio dele).
    await writeInstallAs281029f(dir.dbFile, { ...OTHER });
    bootOnce(dir.dataDir);
    const after = await readIdentity(dir.dbFile);
    assert.equal(after.install.id, before.install.id);
    assert.equal(after.install.criadaEm, before.install.criadaEm);
    assert.deepEqual(after.copia, before.copia);
});

test('[UC-VERSAO-006] restaurar pela tela e pela backup-cli depois da volta pela 281029f mantém o código desta instalação', async () => {
    const dir = newDataDir('restaurar-depois');
    bootOnce(dir.dataDir);
    const before = await readIdentity(dir.dbFile);
    const [zip] = fs.readdirSync(dir.backupsDir).filter(name => /^pre-atualizacao_.+\.zip$/.test(name));
    assert.ok(zip, 'o primeiro boot fez o backup de antes da atualização (dados da 281029f, sem a seção)');

    // Tela Sistema: a seção sumiu (281029f) e o backup é de antes da migração.
    await writeInstallAs281029f(dir.dbFile, undefined);
    const legacy = path.join(dir.root, 'backup-versao-anterior.json');
    fs.writeFileSync(legacy, JSON.stringify(JSON.parse(fs.readFileSync(legacyBackup, 'utf8')).backup));
    const restored = bootOnce(dir.dataDir, 'restaurar', legacy);
    assert.equal(restored.restore.ok, true, restored.restore.message);
    assert.deepEqual(await readIdentity(dir.dbFile), before);

    // backup-cli (servidor parado), com a seção apagada de novo antes.
    await writeInstallAs281029f(dir.dbFile, undefined);
    const port = await proc.freePort();
    const result = spawnSync(process.execPath, [cli, 'restaurar', path.join(dir.backupsDir, zip), '--sim'], { env: envFor(dir.dataDir, port), encoding: 'utf8', input: '', timeout: 120000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Backup restaurado\./);
    assert.deepEqual(await readIdentity(dir.dbFile), before);
    // O boot seguinte não muda nada.
    const after = bootOnce(dir.dataDir);
    assert.deepEqual(after.info.aplicadasAgora, []);
    assert.deepEqual(await readIdentity(dir.dbFile), before);
});
