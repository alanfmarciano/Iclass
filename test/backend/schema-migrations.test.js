// Versão dos dados e migrações (fase 3, A0 / P6-S1: CONF-16, OPS-02, ENG-14). Antes não
// havia registro de migrações nem schemaMeta: o código novo abria o banco da versão
// anterior e mudava o que quisesse no boot, sem backup antes, sem saber de que versão
// eram os dados e sem recusar um banco de versão mais nova. Cada boot roda num processo
// próprio (fixtures/schema-boot-child.js) sobre uma cópia de fixtures/banco-281029f.db
// (o banco da versão que o Alan tem hoje), com o registro de teste carregado por
// fixtures/registro-de-teste.js quando o teste precisa de outras migrações.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3');

const schemaMigrations = require('../../backend/utils/schemaMigrations.js');
const { MIGRATIONS, BOOT_NORMALIZATIONS } = require('../../backend/migrations/index.js');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-schema-test-'));
const fixtureDb = path.join(__dirname, 'fixtures', 'banco-281029f.db');
const childScript = path.join(__dirname, 'fixtures', 'schema-boot-child.js');
const preload = path.join(__dirname, 'fixtures', 'registro-de-teste.js');
const cli = path.join(__dirname, '..', '..', 'backend', 'scripts', 'backup-cli.js');
const publishedFile = path.join(__dirname, 'fixtures', 'migracoes-publicadas.json');
const legacyBackup = path.join(__dirname, 'fixtures', 'backup-versao-anterior.json');
const NEW_TABLES = ['schema_meta', 'assignments', 'assignment_submissions', 'assignment_file_tombstones', 'academic_terms',
    'non_school_days', 'class_diary', 'class_groups', 'conversations', 'conversation_messages', 'guardian_contacts'];

test.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

let dirCounter = 0;
// Pasta de dados nova; com fixture, o banco 281029f copiado (o original nunca é aberto).
function newDataDir(name, { fixture = true } = {}) {
    dirCounter += 1;
    const root = path.join(tempRoot, `${name}-${dirCounter}`);
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'content'), { recursive: true });
    if (fixture) fs.copyFileSync(fixtureDb, path.join(dataDir, 'database.db'));
    return { root, dataDir, dbFile: path.join(dataDir, 'database.db'), backupsDir: path.join(dataDir, 'backups') };
}

// Registro de teste num arquivo (o filho o carrega pelo registro-de-teste.js).
function writeRegistry(root, source) {
    const file = path.join(root, `registro-${crypto.randomBytes(4).toString('hex')}.js`);
    fs.writeFileSync(file, source);
    return file;
}

// Marca na configuração (que o boot grava) o que cada migração de teste viu.
const MARK_HELPER = `
function mark(memory, id, ctx) {
    const config = memory.config;
    config.testMarks = config.testMarks || { ordem: [] };
    config.testMarks.ordem.push(id);
    config.testMarks.origem = ctx.origem;
    config.testMarks.idsDeAntes = ctx.previousStudentIds instanceof Map ? ctx.previousStudentIds.size : -1;
    config.testMarks.idDaAna = ctx.previousStudentIds instanceof Map ? (ctx.previousStudentIds.get('aluno@teste.local') || null) : null;
    return true;
}
`;

const BASE_ROW = `{ id: '2026-11-p6-base', nome: 'Marca a base 281029f (não muda nenhum dado)', tipo: 'memoria', run() { return false; } }`;

function childEnv(dataDir, extra = {}) {
    const env = {
        ...process.env,
        ICLASS_DATA_DIR: dataDir,
        ICLASS_CONTENT_DIR: path.join(path.dirname(dataDir), 'content'),
        ICLASS_ARCHIVE_DIR: path.join(path.dirname(dataDir), 'arquivados'),
        TEST_MODE: '1',
        PORT: '1',
    };
    delete env.NODE_TEST_CONTEXT;
    delete env.ICLASS_VERIFY_SAVES;
    delete env.ICLASS_ATUALIZAR_SEM_BACKUP;
    delete env.ICLASS_TEST_MIGRATIONS;
    delete env.ICLASS_TEST_FREE_BYTES;
    Object.entries(extra).forEach(([key, value]) => {
        if (value === undefined) delete env[key];
        else env[key] = value;
    });
    if (env.ICLASS_TEST_MIGRATIONS) env.NODE_OPTIONS = `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ''}--require ${JSON.stringify(preload)}`;
    return env;
}

// Um boot (prepareServer) num processo próprio; cenário 'restaurar' com o arquivo.
function boot(dataDir, { env = {}, scenario, argument } = {}) {
    const args = [childScript];
    if (scenario) args.push(scenario);
    if (argument) args.push(argument);
    return new Promise((resolve, reject) => {
        execFile(process.execPath, args, { env: childEnv(dataDir, env), encoding: 'utf8', timeout: 90000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
            const text = String(stdout || '');
            const marker = text.lastIndexOf('@@');
            if (marker === -1) {
                reject(new Error(`o filho não respondeu (${err && err.code}): ${text}\n${stderr}`));
                return;
            }
            const result = JSON.parse(text.slice(marker + 2));
            result.exit = err ? err.code : 0;
            result.stderr = String(stderr || '');
            resolve(result);
        });
    });
}

function runCli(dataDir, args, env = {}) {
    const result = spawnSync(process.execPath, [cli, ...args], { env: childEnv(dataDir, env), encoding: 'utf8', input: '', timeout: 90000 });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, output: `${result.stdout}\n${result.stderr}` };
}

function openDb(file, mode = sqlite3.OPEN_READONLY) {
    return new Promise((resolve, reject) => {
        const connection = new sqlite3.Database(file, mode, err => (err ? reject(err) : resolve(connection)));
    });
}

function all(connection, sql, params = []) {
    return new Promise((resolve, reject) => connection.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
}

function exec(connection, sql, params = []) {
    return new Promise((resolve, reject) => connection.run(sql, params, err => (err ? reject(err) : resolve())));
}

function closeDb(connection) {
    return new Promise(resolve => connection.close(() => resolve()));
}

// Todas as linhas de todas as tabelas, em ordem (para comparar dois bancos).
async function dump(file, { skip = [] } = {}) {
    const connection = await openDb(file);
    try {
        const tables = (await all(connection, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"))
            .map(row => row.name)
            .filter(name => !skip.includes(name));
        const result = {};
        for (const table of tables) {
            result[table] = await all(connection, `SELECT * FROM ${table} ORDER BY 1`);
        }
        return result;
    } finally {
        await closeDb(connection);
    }
}

async function tableNames(file) {
    const connection = await openDb(file);
    try {
        return (await all(connection, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).map(row => row.name);
    } finally {
        await closeDb(connection);
    }
}

async function studentId(file, email) {
    const connection = await openDb(file);
    try {
        const rows = await all(connection, 'SELECT value FROM students');
        const student = rows.map(row => JSON.parse(row.value)).find(item => String(item.email).toLowerCase() === email);
        return student ? student.id || null : null;
    } finally {
        await closeDb(connection);
    }
}

// O backup JSON da versão de antes da fase 1 (fixtures/backup-versao-anterior.json traz o
// arquivo em .backup, ao lado de como foi gerado).
function legacyBackupFile(root) {
    const file = path.join(root, 'backup-versao-anterior.json');
    fs.writeFileSync(file, JSON.stringify(JSON.parse(fs.readFileSync(legacyBackup, 'utf8')).backup));
    return file;
}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function zipsIn(dir, prefix = '') {
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith('.zip') && name.startsWith(prefix)).sort() : [];
}

// --- registro --------------------------------------------------------------------------

test('[UC-ESQUEMA-001] migrações publicadas são imutáveis: o código de cada linha confere com o hash de migracoes-publicadas.json, na mesma ordem', () => {
    const published = JSON.parse(fs.readFileSync(publishedFile, 'utf8')).migracoes;
    assert.ok(Array.isArray(published) && published.length >= 1);
    // Toda linha publicada continua no registro, na mesma posição e com o mesmo código.
    published.forEach((item, index) => {
        const row = MIGRATIONS[index];
        assert.ok(row, `a migração publicada ${item.id} sumiu do registro`);
        assert.equal(row.id, item.id, `a ordem das migrações publicadas mudou na posição ${index + 1}`);
        assert.equal(schemaMigrations.migrationHash(row), item.hash, `o código da migração publicada ${item.id} mudou: efeito novo é uma linha nova com id novo`);
    });
    // Quem acrescenta uma linha acrescenta o hash dela.
    assert.deepEqual(MIGRATIONS.map(row => row.id), published.map(item => item.id), 'linha nova no registro sem o hash em migracoes-publicadas.json');
    // A primeira é a base 281029f e não muda nada.
    assert.equal(MIGRATIONS[0].id, '2026-11-p6-base');
    assert.equal(MIGRATIONS[0].run({}, {}), false);
    // BOOT_NORMALIZATIONS: a do C1 (ensureStudentIds, todo boot e depois de restaurar).
    assert.deepEqual(BOOT_NORMALIZATIONS.map(row => row.id), ['2026-11-p4-ids-alunos-sempre']);
    assert.ok(Object.isFrozen(MIGRATIONS) && Object.isFrozen(BOOT_NORMALIZATIONS));
    // O hash não depende do fim de linha (checkout no Windows com CRLF).
    const row = { id: '2026-11-teste-crlf', tipo: 'memoria', run: { toString: () => 'run() {\r\n    return false;\r\n}' } };
    const lf = { ...row, run: { toString: () => 'run() {\n    return false;\n}' } };
    assert.equal(schemaMigrations.migrationHash(row), schemaMigrations.migrationHash(lf));
});

test('[UC-ESQUEMA-001] migração que delega a outro módulo: o código das dependencias entra no hash (mudar ensureStudentIds ou o que ele chama reprova a linha publicada)', () => {
    const studentIdentity = require('../../backend/utils/studentIdentity.js');
    const row = MIGRATIONS.find(item => item.id === '2026-11-p4-ids-alunos');
    assert.ok(row && row.dependencias === studentIdentity.ENSURE_STUDENT_IDS_DEPENDENCIES);
    const hash = schemaMigrations.migrationHash(row);
    // Sem as dependencias o hash seria só o do run (que não muda quando ensureStudentIds muda).
    assert.notEqual(schemaMigrations.migrationHash({ ...row, dependencias: undefined }), hash);
    // O caso que já aconteceu (bab6e29 -> 3ccd38a): hasStoredId mais frouxo, mesmo run.
    const looseHasStoredId = function hasStoredId(student) {
        return !!student && typeof student.id === 'string' && student.id.trim() !== '';
    };
    const changed = row.dependencias.map(dep => (typeof dep === 'function' && dep.name === 'hasStoredId' ? looseHasStoredId : dep));
    assert.notEqual(schemaMigrations.migrationHash({ ...row, dependencias: changed }), hash);
    // Constante mudada também muda o hash.
    const otherPrefix = row.dependencias.map(dep => (typeof dep === 'function' ? dep : { ...dep, STUDENT_ID_PREFIX: 'aluno_' }));
    assert.notEqual(schemaMigrations.migrationHash({ ...row, dependencias: otherPrefix }), hash);
    // CRLF nas dependencias não muda o hash.
    const crlf = row.dependencias.map(dep => (typeof dep === 'function' ? Object.assign(() => {}, { toString: () => String(dep).replace(/\n/g, '\r\n') }) : dep));
    assert.equal(schemaMigrations.migrationHash({ ...row, dependencias: crlf }), hash);

    // A lista está completa: toda função de studentIdentity.js chamada por ensureStudentIds
    // (direta ou indiretamente) e toda constante de módulo usada estão nas dependencias.
    const source = fs.readFileSync(require.resolve('../../backend/utils/studentIdentity.js'), 'utf8');
    const bodies = new Map();
    const fnPattern = /^function (\w+)\([^)]*\) \{\n([\s\S]*?)^\}/gm;
    let match;
    while ((match = fnPattern.exec(source))) bodies.set(match[1], match[2]);
    const constants = new Set([...source.matchAll(/^const ([A-Z][A-Z0-9_]+) = /gm)].map(item => item[1]));
    const listedFns = new Set(row.dependencias.filter(dep => typeof dep === 'function').map(dep => dep.name));
    const listedConstants = new Set(row.dependencias.filter(dep => typeof dep !== 'function').flatMap(dep => Object.keys(dep)));
    const seen = new Set();
    const queue = ['ensureStudentIds'];
    while (queue.length) {
        const name = queue.shift();
        if (seen.has(name)) continue;
        seen.add(name);
        const body = bodies.get(name) || '';
        bodies.forEach((_, other) => { if (other !== name && new RegExp(`\\b${other}\\(`).test(body)) queue.push(other); });
        constants.forEach(constant => {
            if (new RegExp(`\\b${constant}\\b`).test(body)) assert.ok(listedConstants.has(constant), `${name} usa ${constant}, que falta em ENSURE_STUDENT_IDS_DEPENDENCIES`);
        });
    }
    seen.forEach(name => assert.ok(listedFns.has(name), `ensureStudentIds chama ${name}, que falta em ENSURE_STUDENT_IDS_DEPENDENCIES`));
    // As de fora do módulo que ele chama.
    assert.ok(listedFns.has('normalizeEmail') && listedFns.has('relinkStudentData'));
    // Linha sem dependencias tem o hash de sempre (a base 281029f não mudou).
    assert.equal(schemaMigrations.migrationHash(MIGRATIONS[0]), '22a0fb3ddfdf061c39e812355b21daf1adb63c76f005b9595193ca952848bcd3');
    // dependencias inválidas são recusadas pelo registro.
    assert.throws(() => schemaMigrations.validateRegistry({ migrations: [{ id: '2026-11-teste-dep', nome: 'Dep', tipo: 'memoria', run: () => false, dependencias: ['texto'] }] }), /dependencias/);
});

test('[UC-ESQUEMA-001] o registro é conferido: id no formato AAAA-MM-<grupo>-<nome>, sem repetição, tipo memoria ou sql e run', () => {
    const ok = { id: '2026-11-teste-ok', nome: 'Ok', tipo: 'memoria', run: () => false };
    assert.doesNotThrow(() => schemaMigrations.validateRegistry({ migrations: [ok] }));
    const cases = [
        [{ migrations: [{ ...ok, id: '7' }] }, /fora do formato/],
        [{ migrations: [{ ...ok, id: '2026-11-Teste' }] }, /fora do formato/],
        [{ migrations: [ok, { ...ok }] }, /id repetido/],
        [{ migrations: [ok], normalizations: [{ id: ok.id, nome: 'n', run: () => false }] }, /id repetido/],
        [{ migrations: [{ ...ok, tipo: 'js' }] }, /tipo "js"/],
        [{ migrations: [{ ...ok, run: 'x' }] }, /não tem run/],
        [{ migrations: [{ ...ok, nome: '' }] }, /não tem nome/],
        [{ migrations: {} }, /precisa ser uma lista/],
    ];
    cases.forEach(([value, pattern]) => assert.throws(() => schemaMigrations.validateRegistry(value), pattern));
    // O formato do módulo também vale para o registro de teste.
    schemaMigrations.useRegistryForTests({ MIGRATIONS: [ok], BOOT_NORMALIZATIONS: [] });
    try {
        assert.deepEqual(schemaMigrations.registry().migrations.map(row => row.id), ['2026-11-teste-ok']);
        const plan = schemaMigrations.planSchema({ aplicadas: [{ id: '2026-11-teste-ok' }, { id: '2099-01-teste-futuro' }], versaoApp: '9.9.9' });
        assert.deepEqual(plan.pending, []);
        assert.deepEqual(plan.unknown, ['2099-01-teste-futuro']);
    } finally {
        schemaMigrations.useRegistryForTests(null);
    }
    // Lista de ids do manifesto e schemaMeta valem o mesmo; sem nada é a base.
    assert.deepEqual(schemaMigrations.planSchema(undefined).pending.map(row => row.id), MIGRATIONS.map(row => row.id));
    assert.deepEqual(schemaMigrations.planSchema({ aplicadas: ['2026-11-p6-base'] }).applied, ['2026-11-p6-base']);
});

// --- boot -------------------------------------------------------------------------------

test('[UC-ESQUEMA-001] boot sobre o banco 281029f aplica as migrações na ordem, grava uma vez e o segundo boot não muda nada', async () => {
    const dir = newDataDir('ordem');
    const registry = writeRegistry(dir.root, `${MARK_HELPER}
module.exports = { MIGRATIONS: [
    ${BASE_ROW},
    { id: '2026-11-teste-um', nome: 'Primeira de teste', tipo: 'memoria', run(memory, ctx) { return mark(memory, 'um', ctx); } },
    { id: '2026-11-teste-dois', nome: 'Segunda de teste', tipo: 'memoria', run(memory, ctx) { return mark(memory, 'dois', ctx); } },
    { id: '2026-11-teste-tres', nome: 'Terceira de teste', tipo: 'memoria', run(memory, ctx) { return mark(memory, 'tres', ctx); } },
], BOOT_NORMALIZATIONS: [] };`);
    const baseline = newDataDir('ordem-base');
    const plain = await boot(baseline.dataDir);
    assert.equal(plain.exit, 0, plain.message);

    const first = await boot(dir.dataDir, { env: { ICLASS_TEST_MIGRATIONS: registry } });
    assert.equal(first.exit, 0, first.message);
    assert.deepEqual(first.marks.ordem, ['um', 'dois', 'tres']);
    assert.equal(first.marks.origem, 'boot');
    assert.equal(first.marks.idsDeAntes, 0, 'no boot o mapa de ids de antes vem vazio');
    const ids = ['2026-11-p6-base', '2026-11-teste-um', '2026-11-teste-dois', '2026-11-teste-tres'];
    assert.deepEqual(first.schemaMeta.aplicadas.map(entry => entry.id), ids);
    first.schemaMeta.aplicadas.forEach(entry => {
        assert.ok(Number.isFinite(entry.em) && entry.em > 0);
        assert.equal(typeof entry.versaoApp, 'string');
    });
    assert.equal(first.schemaMeta.atualizacoes.length, 1);
    assert.deepEqual(first.schemaMeta.atualizacoes[0].migracoes, ids);
    assert.equal(first.userVersion, 4, 'PRAGMA user_version espelha o número de migrações aplicadas');
    assert.deepEqual(first.phases.slice(0, 3), ['loading', 'backup-atualizacao', 'migrando']);
    // As migrações entram na gravação do fim do init: o boot com 4 migrações grava
    // tantas vezes quanto o boot com só a base.
    assert.equal(first.savesSinceBoot, plain.savesSinceBoot);
    const updated = first.audits.find(entry => entry.action === 'app_updated');
    assert.ok(updated, 'app_updated na auditoria');
    assert.equal(updated.category, 'system');
    assert.equal(updated.actor, 'sistema');
    assert.deepEqual(updated.details.migracoes, ids);
    assert.match(first.logs.join('\n'), /Dados atualizados para a versão .*4 etapas/);
    // data/backups/atualizacoes.json para o launcher (voltar de versão).
    const updatesFile = JSON.parse(fs.readFileSync(path.join(dir.backupsDir, 'atualizacoes.json'), 'utf8'));
    assert.deepEqual(updatesFile.atualizacoes[0].migracoes, ids);
    assert.equal(updatesFile.atualizacoes[0].backup, zipsIn(dir.backupsDir, 'pre-atualizacao_')[0]);

    const afterFirst = await dump(dir.dbFile);
    const second = await boot(dir.dataDir, { env: { ICLASS_TEST_MIGRATIONS: registry } });
    assert.equal(second.exit, 0, second.message);
    assert.deepEqual(second.info.aplicadasAgora, []);
    assert.equal(second.info.atualizacao, null);
    assert.equal(second.marks.ordem.length, 3, 'nenhuma migração roda de novo');
    assert.equal(second.savesSinceBoot, 0, 'o segundo boot não grava');
    assert.equal(zipsIn(dir.backupsDir, 'pre-atualizacao_').length, 1, 'sem migração pendente não há backup novo');
    assert.equal(second.phases.includes('backup-atualizacao'), false);
    assert.deepEqual(await dump(dir.dbFile), afterFirst, 'dois boots seguidos dão o mesmo banco');
});

test('[UC-ESQUEMA-001] migração que falha, que tenta gravar ou que devolve promessa: saída 2 com o nome da etapa e nada da memória gravado', async () => {
    const scenarios = [
        { name: 'falha', run: `run(memory, ctx) { mark(memory, 'quebra', ctx); throw new Error('campo inesperado'); }`, pattern: /parou na etapa "Etapa que quebra" \(2026-11-teste-quebra\): campo inesperado/ },
        { name: 'grava', run: `run(memory) { memory.config.testMarks = { gravou: true }; require(${JSON.stringify(require.resolve('../../backend/database.js'))}).save(); return true; }`, pattern: /tentou gravar no banco/ },
        { name: 'promessa', run: `async run(memory) { memory.config.testMarks = { assincrona: true }; return true; }`, pattern: /precisa ser síncrona/ },
    ];
    for (const scenario of scenarios) {
        const dir = newDataDir(`quebra-${scenario.name}`);
        const before = await dump(dir.dbFile);
        const registry = writeRegistry(dir.root, `${MARK_HELPER}
module.exports = { MIGRATIONS: [
    ${BASE_ROW},
    { id: '2026-11-teste-antes', nome: 'Etapa antes', tipo: 'memoria', run(memory, ctx) { return mark(memory, 'antes', ctx); } },
    { id: '2026-11-teste-quebra', nome: 'Etapa que quebra', tipo: 'memoria', ${scenario.run} },
], BOOT_NORMALIZATIONS: [] };`);
        const result = await boot(dir.dataDir, { env: { ICLASS_TEST_MIGRATIONS: registry } });
        assert.equal(result.exit, 2, `${scenario.name}: ${result.message}`);
        assert.equal(result.code, 'ICLASS_MIGRATION_FAILED', scenario.name);
        assert.match(result.message, scenario.pattern);
        assert.match(result.message, /Nada foi gravado/);
        // O backup de antes foi feito e conferido; os dados ficaram como a versão anterior
        // deixou (as tabelas novas nascem vazias pelo CREATE TABLE IF NOT EXISTS).
        assert.equal(zipsIn(dir.backupsDir, 'pre-atualizacao_').length, 1, scenario.name);
        const after = await dump(dir.dbFile, { skip: NEW_TABLES });
        assert.deepEqual(after, before, `${scenario.name}: nada da memória foi gravado`);
        const meta = await dump(dir.dbFile);
        assert.deepEqual(meta.schema_meta || [], [], `${scenario.name}: a versão dos dados não foi marcada`);
    }
});

test('[UC-ESQUEMA-002] banco 281029f: backup pre-atualizacao conferido antes de qualquer gravação, igual ao banco de antes, verificar da backup-cli passa', async () => {
    const dir = newDataDir('pre-atualizacao');
    const before = await dump(dir.dbFile);
    const tablesBefore = await tableNames(dir.dbFile);
    const result = await boot(dir.dataDir);
    assert.equal(result.exit, 0, result.message);
    const [zip] = zipsIn(dir.backupsDir, 'pre-atualizacao_');
    assert.match(zip, /^pre-atualizacao_dados_.+\.zip$/);
    assert.ok(fs.existsSync(path.join(dir.backupsDir, `${zip}.sha256`)));
    // O banco de dentro do ZIP é o de antes do boot: as mesmas linhas e nenhuma tabela nova.
    const extracted = path.join(dir.root, 'extraido');
    const archive = require('../../backend/utils/backupArchive.js');
    const manifest = await archive.readBackupManifest(path.join(dir.backupsDir, zip));
    assert.equal(manifest.origem, 'pre-atualizacao');
    assert.deepEqual(manifest.esquema, { aplicadas: [], versaoApp: null });
    await archive.extractBackupZip(path.join(dir.backupsDir, zip), extracted);
    const inside = path.join(extracted, 'data', 'database.db');
    assert.deepEqual(await tableNames(inside), tablesBefore);
    assert.deepEqual(await dump(inside), before);
    assert.equal(manifest.banco.tabelas.students, 13);
    assert.equal(manifest.banco.tabelas.submissions, 72);
    // A conferência da linha de comando (manifesto, CRC, soma e estrutura) passa.
    const verified = runCli(dir.dataDir, ['verificar', path.join(dir.backupsDir, zip)]);
    assert.equal(verified.code, 0, verified.output);
    assert.match(verified.stdout, /Versão dos dados: base/);
    // A auditoria registra o backup e a atualização; as contagens ficaram as mesmas.
    const created = result.audits.find(entry => entry.action === 'backup_preupdate_created');
    assert.ok(created);
    assert.equal(created.details.arquivo, zip);
    assert.equal(created.category, 'backup');
    assert.ok(result.audits.find(entry => entry.action === 'app_updated'));
    assert.deepEqual(result.counts, { students: 13, submissions: 72, attendance: 193, forum: 4, admins: 3, classes: 2, assignments: 0 });
    assert.deepEqual(result.schemaMeta.aplicadas.map(entry => entry.id), MIGRATIONS.map(row => row.id));
    assert.equal(result.userVersion, MIGRATIONS.length);
    const tablesAfter = await tableNames(dir.dbFile);
    NEW_TABLES.forEach(table => assert.ok(tablesAfter.includes(table), `tabela ${table}`));
});

test('[UC-ESQUEMA-002] instalação nova: schemaMeta nasce com todas as migrações, sem backup de antes e sem app_updated', async () => {
    const dir = newDataDir('nova', { fixture: false });
    const result = await boot(dir.dataDir);
    assert.equal(result.exit, 0, result.message);
    assert.equal(result.info.bancoNovo, true);
    assert.deepEqual(result.schemaMeta.aplicadas.map(entry => entry.id), MIGRATIONS.map(row => row.id));
    assert.equal(result.schemaMeta.atualizacoes[0].instalacaoNova, true);
    assert.equal(zipsIn(dir.backupsDir, 'pre-atualizacao_').length, 0);
    assert.deepEqual(result.audits, []);
    assert.equal(result.phases.includes('migrando'), false);
    assert.equal(result.userVersion, MIGRATIONS.length);
});

test('[UC-ESQUEMA-003] banco de uma versão mais nova: saída 2 em português e o arquivo fica igual; em TEST_MODE só avisa', async () => {
    const dir = newDataDir('mais-nova');
    assert.equal((await boot(dir.dataDir)).exit, 0);
    const connection = await openDb(dir.dbFile, sqlite3.OPEN_READWRITE);
    const meta = { aplicadas: [...MIGRATIONS.map(row => ({ id: row.id, em: 1 })), { id: '2099-01-teste-futuro', em: 2 }], atualizacoes: [], versaoApp: '9.9.9' };
    await exec(connection, 'UPDATE schema_meta SET value = ? WHERE key = ?', [JSON.stringify(meta), 'default']);
    await exec(connection, 'PRAGMA wal_checkpoint(TRUNCATE)');
    await closeDb(connection);
    const hash = sha256(dir.dbFile);
    const zipsBefore = zipsIn(dir.backupsDir);

    const refused = await boot(dir.dataDir, { env: { TEST_MODE: undefined } });
    assert.equal(refused.exit, 2, refused.message);
    assert.equal(refused.code, 'ICLASS_SCHEMA_NEWER');
    assert.match(refused.message, /Estes dados foram atualizados pela versão 9\.9\.9 do IClass, mais nova que esta/);
    assert.match(refused.message, /Voltar para a versão anterior/);
    assert.equal(sha256(dir.dbFile), hash, 'o banco de versão mais nova não é tocado');
    assert.deepEqual(zipsIn(dir.backupsDir), zipsBefore);

    const warned = await boot(dir.dataDir);
    assert.equal(warned.exit, 0, warned.message);
    assert.match(warned.logs.join('\n'), /mais nova/);
    assert.deepEqual(warned.info.desconhecidas, ['2099-01-teste-futuro']);
});

test('[UC-ESQUEMA-005] sem espaço ou sem como gravar o backup de antes: saída 2, "Nada foi alterado" e o banco igual', async () => {
    const noSpace = newDataDir('sem-espaco');
    const tables = await tableNames(noSpace.dbFile);
    const before = await dump(noSpace.dbFile);
    const result = await boot(noSpace.dataDir, { env: { ICLASS_TEST_FREE_BYTES: '1000' } });
    assert.equal(result.exit, 2, result.message);
    assert.equal(result.code, 'ICLASS_PREUPDATE_BACKUP');
    assert.match(result.message, /Não foi possível fazer o backup antes de atualizar os dados: sem espaço no disco/);
    assert.match(result.message, /Nada foi alterado/);
    assert.deepEqual(await tableNames(noSpace.dbFile), tables, 'nem as tabelas novas foram criadas');
    assert.deepEqual(await dump(noSpace.dbFile), before);
    assert.equal(zipsIn(noSpace.backupsDir).length, 0);

    const blocked = newDataDir('sem-pasta');
    fs.writeFileSync(blocked.backupsDir, 'um arquivo no lugar da pasta de backups');
    const failed = await boot(blocked.dataDir);
    assert.equal(failed.exit, 2, failed.message);
    assert.match(failed.message, /Não foi possível fazer o backup antes de atualizar os dados/);
    assert.match(failed.message, /Nada foi alterado/);
    assert.deepEqual(await tableNames(blocked.dbFile), tables);
});

test('[UC-ESQUEMA-005] ICLASS_ATUALIZAR_SEM_BACKUP=1 (pedido no launcher) atualiza sem o backup e registra backup_preupdate_skipped', async () => {
    const dir = newDataDir('sem-backup');
    const result = await boot(dir.dataDir, { env: { ICLASS_ATUALIZAR_SEM_BACKUP: '1' } });
    assert.equal(result.exit, 0, result.message);
    assert.equal(zipsIn(dir.backupsDir, 'pre-atualizacao_').length, 0);
    const skipped = result.audits.find(entry => entry.action === 'backup_preupdate_skipped');
    assert.ok(skipped);
    assert.equal(skipped.category, 'backup');
    assert.equal(result.schemaMeta.atualizacoes[0].semBackup, true);
    assert.match(result.logs.join('\n'), /SEM o backup de antes/);
});

test('[UC-ESQUEMA-001] BOOT_NORMALIZATIONS rodam em todo boot (mesmo sem migração pendente) e depois da restauração', async () => {
    const dir = newDataDir('normalizacoes');
    const registry = writeRegistry(dir.root, `
module.exports = { MIGRATIONS: [${BASE_ROW}], BOOT_NORMALIZATIONS: [
    { id: '2026-11-teste-normaliza', nome: 'Normalização de teste', run(memory, ctx) {
        const config = memory.config;
        const marks = config.testMarks || { ordem: [] };
        if (marks.ordem[marks.ordem.length - 1] === ctx.origem) return false;
        marks.ordem.push(ctx.origem);
        config.testMarks = marks;
        return true;
    } },
] };`);
    const first = await boot(dir.dataDir, { env: { ICLASS_TEST_MIGRATIONS: registry } });
    assert.equal(first.exit, 0, first.message);
    assert.deepEqual(first.marks.ordem, ['boot']);
    // Simula a versão 281029f gravando o formato antigo depois da migração.
    const connection = await openDb(dir.dbFile, sqlite3.OPEN_READWRITE);
    const [row] = await all(connection, "SELECT value FROM config WHERE key = 'app_config'");
    const config = JSON.parse(row.value);
    config.testMarks = { ordem: ['281029f'] };
    await exec(connection, "UPDATE config SET value = ? WHERE key = 'app_config'", [JSON.stringify(config)]);
    await closeDb(connection);
    const second = await boot(dir.dataDir, { env: { ICLASS_TEST_MIGRATIONS: registry } });
    assert.deepEqual(second.marks.ordem, ['281029f', 'boot'], 'roda de novo no boot sem migração pendente');
    assert.deepEqual(second.info.aplicadasAgora, []);
    const restored = await boot(dir.dataDir, { env: { ICLASS_TEST_MIGRATIONS: registry }, scenario: 'restaurar', argument: legacyBackupFile(dir.root) });
    assert.equal(restored.restore.ok, true, restored.restore.message);
    assert.equal(restored.marks.ordem[restored.marks.ordem.length - 1], 'restauracao');
});

// --- restauração pela tela Sistema ----------------------------------------------------------

test('[UC-ESQUEMA-004] restaurar backup sem versão dos dados (JSON antigo e ZIP da 281029f) aplica as migrações, com os ids de antes, e mantém as funções novas', async () => {
    const dir = newDataDir('restaurar');
    const registry = writeRegistry(dir.root, `${MARK_HELPER}
module.exports = { MIGRATIONS: [
    ${BASE_ROW},
    // Como a ensureStudentIds do C1: dá id a quem não tem, reaproveitando o id de antes
    // da restauração para o mesmo e-mail.
    { id: '2026-11-teste-restaura', nome: 'Etapa de teste', tipo: 'memoria', run(memory, ctx) {
        (memory.students || []).forEach(student => {
            if (student.id) return;
            student.id = ctx.previousStudentIds.get(String(student.email).toLowerCase()) || ('al_' + require('crypto').randomBytes(6).toString('hex'));
        });
        return mark(memory, 'restaura', ctx);
    } },
], BOOT_NORMALIZATIONS: [] };`);
    const env = { ICLASS_TEST_MIGRATIONS: registry };
    const first = await boot(dir.dataDir, { env });
    assert.equal(first.exit, 0, first.message);
    assert.equal(first.marks.idsDeAntes, 0);
    const idBefore = await studentId(dir.dbFile, 'aluno@teste.local');
    assert.match(idBefore, /^al_[0-9a-f]{12}$/);
    const [zip] = zipsIn(dir.backupsDir, 'pre-atualizacao_');
    // Uma tarefa criada depois da atualização (coleção nova, missing 'keep').
    const connection = await openDb(dir.dbFile, sqlite3.OPEN_READWRITE);
    await exec(connection, 'INSERT INTO assignments (key, value) VALUES (?, ?)', ['tar_1', JSON.stringify({ id: 'tar_1', title: 'Tarefa de agora' })]);
    await closeDb(connection);

    const restored = await boot(dir.dataDir, { env, scenario: 'restaurar', argument: path.join(dir.backupsDir, zip) });
    assert.equal(restored.restore.ok, true, restored.restore.message);
    assert.deepEqual(restored.marks.ordem, ['restaura'], 'a etapa rodou sobre os dados do backup');
    assert.equal(restored.marks.origem, 'restauracao');
    assert.equal(restored.marks.idsDeAntes, 13, 'previousStudentIds: os alunos de antes da restauração');
    assert.equal(restored.marks.idDaAna, idBefore);
    assert.equal(await studentId(dir.dbFile, 'aluno@teste.local'), idBefore, 'o aluno do backup (sem id) recebe o mesmo id de antes');
    assert.deepEqual(restored.schemaMeta.aplicadas.map(entry => [entry.id, entry.naRestauracao === true]), [['2026-11-p6-base', true], ['2026-11-teste-restaura', true]]);
    assert.equal(restored.schemaMeta.atualizacoes.length, 1, 'o histórico de atualizações desta instalação fica');
    const migrated = restored.audits.find(entry => entry.action === 'schema_migrated_on_restore');
    assert.ok(migrated);
    assert.equal(migrated.category, 'backup');
    assert.deepEqual(migrated.details, { migracoes: ['2026-11-p6-base', '2026-11-teste-restaura'], de: 'base' });
    assert.equal(restored.counts.assignments, 1, 'a tarefa de agora fica (o backup é de antes da função)');
    assert.deepEqual(restored.preview.ficamComoEstao, [{ colecao: 'assignments', rotulo: 'Tarefas', atual: 1 }]);
    assert.equal(restored.preview.nota.assignments, 'fica como está (o backup é de antes desta função)');
    assert.equal(restored.userVersion, 2);
    // O boot seguinte não roda nada de novo.
    const after = await boot(dir.dataDir, { env });
    assert.deepEqual(after.info.aplicadasAgora, []);
    assert.deepEqual(after.marks.ordem, ['restaura']);

    // Backup JSON da versão de antes da fase 1.
    const json = await boot(dir.dataDir, { env, scenario: 'restaurar', argument: legacyBackupFile(dir.root) });
    assert.equal(json.restore.ok, true, json.restore.message);
    assert.deepEqual(json.marks.ordem, ['restaura']);
    assert.ok(json.audits.some(entry => entry.action === 'schema_migrated_on_restore'));
    assert.deepEqual(json.schemaMeta.aplicadas.map(entry => entry.id), ['2026-11-p6-base', '2026-11-teste-restaura']);
});

test('[UC-ESQUEMA-004] backup feito por uma versão mais nova é recusado (400 em português) e nada muda', async () => {
    const dir = newDataDir('backup-mais-novo');
    assert.equal((await boot(dir.dataDir)).exit, 0);
    const payload = JSON.parse(fs.readFileSync(legacyBackup, 'utf8')).backup;
    payload.data.schemaMeta = { aplicadas: [{ id: '2026-11-p6-base' }, { id: '2099-01-teste-futuro' }], atualizacoes: [], versaoApp: '9.9.9' };
    const file = path.join(dir.root, 'backup-mais-novo.json');
    fs.writeFileSync(file, JSON.stringify(payload));
    const before = await dump(dir.dbFile);
    const result = await boot(dir.dataDir, { scenario: 'restaurar', argument: file });
    assert.equal(result.restore.ok, false);
    assert.equal(result.restore.status, 400);
    assert.equal(result.restore.code, 'backup_schema_newer');
    assert.match(result.restore.message, /Este backup foi feito pela versão 9\.9\.9 do IClass, mais nova que esta .*Atualize este IClass antes de restaurar\./);
    assert.deepEqual(await dump(dir.dbFile), before);
});

// --- registro de tabelas e conferência do backup --------------------------------------------

test('[UC-ESQUEMA-004] tabelas novas no registro: rótulos, missing keep, origens e retenção, chave única por coleção e chaves compostas só avisam', () => {
    const db = require('../../backend/database.js');
    const backup = require('../../backend/utils/backup.js');
    const schema = require('../../backend/utils/backupSchema.js');
    const store = require('../../backend/utils/backupStore.js');
    const expected = {
        schemaMeta: 'schema_meta',
        assignments: 'assignments',
        assignmentSubmissions: 'assignment_submissions',
        assignmentFileTombstones: 'assignment_file_tombstones',
        academicTerms: 'academic_terms',
        nonSchoolDays: 'non_school_days',
        classDiary: 'class_diary',
        classGroups: 'class_groups',
        conversations: 'conversations',
        conversationMessages: 'conversation_messages',
        guardianContacts: 'guardian_contacts',
    };
    Object.entries(expected).forEach(([collection, table]) => {
        const entry = db.COLLECTION_TABLES.find(item => item.collection === collection);
        assert.ok(entry, collection);
        assert.equal(entry.table, table);
        assert.ok(backup.COLLECTION_LABELS[collection] && backup.COLLECTION_LABELS[collection] !== collection, `rótulo de ${collection}`);
        assert.equal(backup.missingCollectionOutcome(entry), 'keep', `${collection}: backup de antes da função mantém a de agora`);
    });
    assert.equal(db.COLLECTION_TABLES.find(item => item.collection === 'assignmentFileTombstones').key, 'fileId');
    assert.equal(db.COLLECTION_TABLES.find(item => item.collection === 'assignmentFileTombstones').restore, 'merge');
    assert.equal(db.COLLECTION_TABLES.find(item => item.collection === 'schemaMeta').restore, 'keep');
    assert.equal(db.afterRestore[0].name, 'schemaMigrations');
    // Origens novas e a retenção delas.
    assert.ok(store.BACKUP_ORIGINS.includes('pre-atualizacao'));
    assert.ok(store.BACKUP_ORIGINS.includes('antes-mesclagem'));
    const rule = grupo => store.RETENTION_RULES.find(item => item.grupo === grupo);
    assert.deepEqual([rule('pre-atualizacao').local, rule('pre-atualizacao').externo, rule('pre-atualizacao').origens], [3, 3, ['pre-atualizacao']]);
    assert.deepEqual([rule('antes-mesclagem').local, rule('antes-mesclagem').externo, rule('antes-mesclagem').origens], [10, 10, ['antes-mesclagem']]);

    const tables = db.COLLECTION_TABLES.filter(entry => entry.backup !== false && entry.kind !== 'derived');
    const base = { config: {}, students: [], submissions: [] };
    // Tombstone pela chave fileId.
    const tombstones = [{ fileId: 'arq_1', removidoEm: 1 }, { fileId: 'arq_2', removidoEm: 2 }];
    assert.doesNotThrow(() => schema.validateBackupData({ ...base, assignmentFileTombstones: tombstones }, tables));
    assert.throws(() => schema.validateBackupData({ ...base, assignmentFileTombstones: [...tombstones, { fileId: 'arq_1' }] }, tables), /repetid/i);
    // students.id: opcional, mas único quando vem.
    assert.doesNotThrow(() => schema.validateBackupData({ ...base, students: [{ email: 'a@x', name: 'A' }, { email: 'b@x', name: 'B', id: 'al_1' }] }, tables));
    assert.throws(() => schema.validateBackupData({ ...base, students: [{ email: 'a@x', name: 'A', id: 'al_1' }, { email: 'b@x', name: 'B', id: 'al_1' }] }, tables), /repetid/i);
    assert.throws(() => schema.validateBackupData({ ...base, assignments: [{ id: 't1' }, { id: 't1' }] }, tables), /repetid/i);
    // Chave composta repetida: só aviso.
    const { warnings } = schema.validateBackupData({
        ...base,
        assignmentSubmissions: [
            { id: 'e1', assignmentId: 't1', studentEmail: 'Ana@x' },
            { id: 'e2', assignmentId: 't1', studentEmail: 'ana@x' },
        ],
        classDiary: [
            { id: 'd1', courseId: 'c', studentClass: '1A', date: '2026-11-01' },
            { id: 'd2', courseId: 'c', studentClass: '1A', date: '2026-11-01' },
        ],
        conversations: [{ id: 'cv1' }],
        conversationMessages: [{ id: 'm1', conversationId: 'cv1' }, { id: 'm2', conversationId: 'cv_sumiu' }],
    }, tables);
    assert.ok(warnings.includes('1 entrega de tarefa repetida para o mesmo aluno na mesma tarefa.'), warnings.join('\n'));
    assert.ok(warnings.includes('1 registro do diário repetido na mesma turma e data.'), warnings.join('\n'));
    assert.ok(warnings.includes('1 mensagem aponta para uma conversa que não está no backup.'), warnings.join('\n'));
    // Backup de versão mais nova (schemaMeta com etapa desconhecida) é recusado.
    assert.throws(() => schema.validateBackupData({ ...base, schemaMeta: { aplicadas: [{ id: '2099-01-teste-futuro' }] } }, tables), error => error.code === 'backup_schema_newer' && error.status === 400);
});
