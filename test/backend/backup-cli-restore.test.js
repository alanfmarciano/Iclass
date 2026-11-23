// backup-cli restaurar e a versão dos dados (fase 3, A0 / P6-S1: CONF-16, OPS-02). Antes
// a restauração pela linha de comando trocava o banco inteiro: as coleções das funções
// novas (tarefas, diário, conversas...) que um backup de antes delas não traz sumiam,
// os dados do backup ficavam no formato antigo e um backup de uma versão mais nova era
// restaurado sem aviso. Agora a regra é a da tela Sistema (missing 'keep' no registro de
// tabelas), o resumo antes de confirmar diz o que fica como está, o gancho
// 'schemaMigrations' roda as migrações que faltam ao backup (com o id de cada aluno de
// antes) e o backup de versão mais nova é recusado.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3');
const proc = require('./fixtures/server-process.js');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-backup-cli-restore-test-'));
const fixtureDb = path.join(__dirname, 'fixtures', 'banco-281029f.db');
const childScript = path.join(__dirname, 'fixtures', 'schema-boot-child.js');
const preload = path.join(__dirname, 'fixtures', 'registro-de-teste.js');
const cli = path.join(__dirname, '..', '..', 'backend', 'scripts', 'backup-cli.js');

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

function envFor(dataDir, { port = 1, registry } = {}) {
    const env = {
        ...process.env,
        ICLASS_DATA_DIR: dataDir,
        ICLASS_CONTENT_DIR: path.join(path.dirname(dataDir), 'content'),
        ICLASS_ARCHIVE_DIR: path.join(path.dirname(dataDir), 'arquivados'),
        TEST_MODE: '1',
        PORT: String(port),
    };
    delete env.NODE_TEST_CONTEXT;
    delete env.ICLASS_VERIFY_SAVES;
    delete env.ICLASS_ATUALIZAR_SEM_BACKUP;
    delete env.ICLASS_TEST_MIGRATIONS;
    if (registry) {
        // Pelo NODE_OPTIONS o registro de teste vale também nos filhos da backup-cli.
        env.ICLASS_TEST_MIGRATIONS = registry;
        env.NODE_OPTIONS = `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ''}--require ${JSON.stringify(preload)}`;
    }
    return env;
}

function bootOnce(dataDir, options) {
    const result = spawnSync(process.execPath, [childScript], { env: envFor(dataDir, options), encoding: 'utf8', timeout: 90000, maxBuffer: 32 * 1024 * 1024 });
    const marker = String(result.stdout || '').lastIndexOf('@@');
    assert.notEqual(marker, -1, `${result.stdout}\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout.slice(marker + 2));
    assert.equal(result.status, 0, parsed.message);
    return parsed;
}

function runCli(dataDir, port, args, options = {}) {
    const result = spawnSync(process.execPath, [cli, ...args], { env: envFor(dataDir, { ...options, port }), encoding: 'utf8', input: '', timeout: 120000 });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, output: `${result.stdout}\n${result.stderr}` };
}

function writeRegistry(root, source) {
    const file = path.join(root, `registro-${crypto.randomBytes(4).toString('hex')}.js`);
    fs.writeFileSync(file, source);
    return file;
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

const BASE_ROW = `{ id: '2026-11-p6-base', nome: 'Marca a base 281029f (não muda nenhum dado)', tipo: 'memoria', run() { return false; } }`;

// Como a ensureStudentIds do C1: id para quem não tem, o de antes para o mesmo e-mail.
const IDS_REGISTRY = `module.exports = { MIGRATIONS: [
    ${BASE_ROW},
    { id: '2026-11-teste-ids', nome: 'Ids de teste', tipo: 'memoria', run(memory, ctx) {
        (memory.students || []).forEach(student => {
            if (student.id) return;
            student.id = ctx.previousStudentIds.get(String(student.email).toLowerCase()) || ('al_' + require('crypto').randomBytes(6).toString('hex'));
        });
        memory.config.testMarks = { origem: ctx.origem, idsDeAntes: ctx.previousStudentIds.size };
        return true;
    } },
], BOOT_NORMALIZATIONS: [] };`;

test('[UC-ESQUEMA-004] backup-cli restaurar um backup da 281029f: as coleções novas ficam como estão (com as contagens no resumo) e os dados são atualizados com os ids de antes', async () => {
    const dir = newDataDir('cli-restaurar');
    const registry = writeRegistry(dir.root, IDS_REGISTRY);
    const first = bootOnce(dir.dataDir, { registry });
    const [zip] = fs.readdirSync(dir.backupsDir).filter(name => /^pre-atualizacao_.+\.zip$/.test(name));
    assert.ok(zip, 'o boot fez o backup de antes da atualização');
    assert.equal(first.marks.origem, 'boot');
    const idsBefore = await withDb(dir.dbFile, sqlite3.OPEN_READONLY, async ({ all }) => Object.fromEntries((await all('SELECT key, value FROM students'))
        .map(row => [row.key, JSON.parse(row.value).id])));
    assert.equal(Object.values(idsBefore).filter(Boolean).length, 13);
    // Depois da atualização: duas tarefas e um registro do diário (funções novas).
    await withDb(dir.dbFile, sqlite3.OPEN_READWRITE, async ({ run }) => {
        await run('INSERT INTO assignments (key, value) VALUES (?, ?)', ['tar_1', JSON.stringify({ id: 'tar_1', title: 'Tarefa 1' })]);
        await run('INSERT INTO assignments (key, value) VALUES (?, ?)', ['tar_2', JSON.stringify({ id: 'tar_2', title: 'Tarefa 2' })]);
        await run('INSERT INTO class_diary (key, value) VALUES (?, ?)', ['d1', JSON.stringify({ id: 'd1', courseId: 'c', studentClass: '1DES', date: '2026-11-17' })]);
    });

    const port = await proc.freePort();
    const restored = runCli(dir.dataDir, port, ['restaurar', path.join(dir.backupsDir, zip), '--sim'], { registry });
    assert.equal(restored.code, 0, restored.output);
    // Resumo antes de confirmar: versão dos dados e o que fica como está.
    assert.match(restored.stdout, /Versão dos dados: base \(de antes das atualizações automáticas dos dados\); ao restaurar, os dados são atualizados para esta versão \(2 etapas\)\./);
    assert.match(restored.stdout, /Ficam como estão \(o backup é de antes desta função\): Tarefas \(2\), Diário de classe \(1\)\./);
    assert.match(restored.stdout, /Backup restaurado\./);
    assert.match(restored.stdout, /Ficaram como estavam \(o backup é de antes desta função\): Tarefas \(2\), Diário de classe \(1\)\./);
    assert.match(restored.stdout, /Os dados do backup foram atualizados para esta versão \(2 etapas\)\./);
    // A opção de redefinir a senha nos dois menus (o launcher novo e o ligarIclassV3.bat).
    assert.match(restored.stdout, /"Redefinir a senha do administrador" no menu do IClass \(opção \[7\]; no ligarIclassV3\.bat, opção \[S\]\)/);

    const state = await withDb(dir.dbFile, sqlite3.OPEN_READONLY, async ({ all }) => ({
        assignments: (await all('SELECT key FROM assignments ORDER BY key')).map(row => row.key),
        diary: (await all('SELECT key FROM class_diary')).length,
        meta: JSON.parse((await all("SELECT value FROM schema_meta WHERE key = 'default'"))[0].value),
        audits: (await all('SELECT value FROM audit_logs')).map(row => JSON.parse(row.value)).filter(entry => entry.action === 'schema_migrated_on_restore'),
        students: Object.fromEntries((await all('SELECT key, value FROM students')).map(row => [row.key, JSON.parse(row.value).id])),
        config: JSON.parse((await all("SELECT value FROM config WHERE key = 'app_config'"))[0].value),
        userVersion: (await all('PRAGMA user_version'))[0].user_version,
    }));
    assert.deepEqual(state.assignments, ['tar_1', 'tar_2'], 'as tarefas de agora vieram do banco de antes');
    assert.equal(state.diary, 1);
    assert.deepEqual(state.meta.aplicadas.map(entry => [entry.id, entry.naRestauracao === true]), [['2026-11-p6-base', true], ['2026-11-teste-ids', true]]);
    assert.equal(state.meta.atualizacoes.length, 1, 'o histórico de atualizações desta instalação fica');
    assert.equal(state.audits.length, 1);
    assert.deepEqual(state.audits[0].details, { migracoes: ['2026-11-p6-base', '2026-11-teste-ids'], de: 'base' });
    assert.deepEqual(state.config.testMarks, { origem: 'restauracao', idsDeAntes: 13 }, 'previousStudentIds veio do banco de antes');
    assert.deepEqual(state.students, idsBefore, 'cada aluno do backup recebe o mesmo id de antes');
    assert.equal(state.userVersion, 2);
    // O boot seguinte não roda nada e não faz outro backup de antes da atualização.
    const after = bootOnce(dir.dataDir, { registry });
    assert.deepEqual(after.info.aplicadasAgora, []);
    assert.equal(fs.readdirSync(dir.backupsDir).filter(name => /^pre-atualizacao_.+\.zip$/.test(name)).length, 1);
    assert.equal(after.counts.assignments, 2);
});

test('[UC-ESQUEMA-004] backup-cli recusa (verificar e restaurar) um backup feito por uma versão mais nova e não muda nada', async () => {
    // Uma instalação "mais nova": o registro dela tem uma etapa que este código não tem.
    const newer = newDataDir('cli-mais-nova');
    const registry = writeRegistry(newer.root, `module.exports = { MIGRATIONS: [
    ${BASE_ROW},
    { id: '2099-01-teste-futuro', nome: 'Etapa do futuro', tipo: 'memoria', run() { return false; } },
], BOOT_NORMALIZATIONS: [] };`);
    bootOnce(newer.dataDir, { registry });
    const port = await proc.freePort();
    const created = runCli(newer.dataDir, port, ['criar', '--dados'], { registry });
    assert.equal(created.code, 0, created.output);
    const [zip] = fs.readdirSync(newer.backupsDir).filter(name => /^manual_dados_.+\.zip$/.test(name));
    assert.ok(zip, created.output);
    const zipFile = path.join(newer.backupsDir, zip);

    const here = newDataDir('cli-desta-versao');
    bootOnce(here.dataDir);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(here.dbFile)).digest('hex');
    const verified = runCli(here.dataDir, port, ['verificar', zipFile]);
    assert.notEqual(verified.code, 0, verified.output);
    assert.match(verified.output, /Este backup foi feito pela versão .* do IClass, mais nova que esta .*Atualize este IClass antes de restaurar\./);
    const restored = runCli(here.dataDir, port, ['restaurar', zipFile, '--sim']);
    assert.notEqual(restored.code, 0, restored.output);
    assert.match(restored.output, /mais nova que esta/);
    assert.doesNotMatch(restored.output, /Backup restaurado/);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(here.dbFile)).digest('hex'), hash);
    assert.equal(fs.existsSync(path.join(here.dataDir, 'quarentena')), false);
});
