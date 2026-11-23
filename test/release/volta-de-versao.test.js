// Volta de versão contra o código 281029f (fase 3, A17 / P6-S5; OPS-02, X7 do plano, D10
// do P6). Roda com `npm run test:release` (fora do test:backend: tira o 281029f do git e
// sobe o servidor dele). A volta de versão do IClass é restaurar o backup 'pre-atualizacao'
// com a versão anterior: os dados voltam ao momento da atualização. Aqui a versão anterior
// é a 281029f, a que o Alan tem hoje:
//   banco da 281029f -> código novo no mesmo DATA_DIR (backup pre-atualizacao + migrações)
//   -> algo gravado depois da atualização -> backup-cli da 281029f restaura o pre-atualizacao
//   -> servidor da 281029f sobe, e as contagens e o sha256 das linhas de alunos, envios e
//   presença são os de antes da atualização.
// O código 281029f sai por git archive numa pasta temporária (o repositório não muda), com
// o node_modules deste repositório e um web/dist mínimo (o servidor antigo confere o build).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3');

const proc = require('../backend/fixtures/server-process.js');

const ROOT = path.resolve(__dirname, '..', '..');
const OLD_COMMIT = '281029f';
const FIXTURE_DB = path.join(ROOT, 'test', 'backend', 'fixtures', 'banco-281029f.db');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-volta-281029f-'));
const oldCode = path.join(tempRoot, 'v281029f');
const dataDir = path.join(tempRoot, 'dados');
const contentDir = path.join(tempRoot, 'conteudo');
const archiveDir = path.join(tempRoot, 'cursos-arquivados');

test.after(() => {
    proc.killAll();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

// As tabelas que o 281029f já tinha (as do banco de referência), menos as que mudam só
// por ligar e restaurar (registro de auditoria, logins e sessões).
const VOLATILE = new Set(['audit_logs', 'login_logs', 'auth_sessions', 'sqlite_sequence']);
const HASHED = ['students', 'submissions', 'attendance'];

function openReadOnly(file) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY, err => (err ? reject(err) : resolve(db)));
    });
}

const all = (db, sql) => new Promise((resolve, reject) => db.all(sql, (err, rows) => (err ? reject(err) : resolve(rows))));
const close = db => new Promise(resolve => db.close(() => resolve()));

// { tabelas: { nome: linhas }, hashes: { nome: sha256 das linhas em ordem } }.
async function snapshot(file, tables = null) {
    const db = await openReadOnly(file);
    try {
        const names = tables || (await all(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).map(row => row.name).filter(name => !VOLATILE.has(name));
        const tabelas = {};
        for (const name of names) tabelas[name] = (await all(db, `SELECT COUNT(*) AS c FROM ${name}`))[0].c;
        const hashes = {};
        for (const name of HASHED) {
            const rows = await all(db, `SELECT * FROM ${name} ORDER BY 1`);
            hashes[name] = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
        }
        return { tabelas, hashes, names };
    } finally {
        await close(db);
    }
}

function run(file, args, { cwd, env = {} } = {}) {
    const result = spawnSync(process.execPath, [file, ...args], {
        cwd,
        encoding: 'utf8',
        env: proc.processEnv(dataDir, 0, { ICLASS_CONTENT_DIR: contentDir, ICLASS_ARCHIVE_DIR: archiveDir, ...env }),
        maxBuffer: 64 * 1024 * 1024,
        timeout: 5 * 60 * 1000,
    });
    return { code: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

function zipsIn(prefix) {
    const dir = path.join(dataDir, 'backups');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.startsWith(prefix) && name.endsWith('.zip')).sort() : [];
}

// O código 281029f numa pasta própria, pronto para rodar: backend, content e package.json
// do git, o node_modules daqui e o web/dist com o build-meta que o servidor antigo confere.
function prepareOldCode() {
    const exists = spawnSync('git', ['cat-file', '-t', OLD_COMMIT], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(String(exists.stdout).trim(), 'commit', `o commit ${OLD_COMMIT} precisa estar no repositório (git fetch) para este teste`);
    fs.mkdirSync(oldCode, { recursive: true });
    const archive = spawnSync('git', ['archive', '--format=tar', OLD_COMMIT, 'backend', 'content', 'package.json'], { cwd: ROOT, maxBuffer: 512 * 1024 * 1024 });
    assert.equal(archive.status, 0, String(archive.stderr));
    const untar = spawnSync('tar', ['-x', '-C', oldCode], { input: archive.stdout });
    assert.equal(untar.status, 0, String(untar.stderr));
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(oldCode, 'node_modules'), 'dir');
    fs.mkdirSync(path.join(oldCode, 'web', 'src'), { recursive: true });
    const dist = path.join(oldCode, 'web', 'dist');
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>IClass</title>');
    const hash = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(path.join(oldCode, 'backend', 'utils', 'buildIntegrity.js'))}).computeSourceHash())`], { encoding: 'utf8' });
    assert.equal(hash.status, 0, hash.stderr);
    fs.writeFileSync(path.join(dist, 'build-meta.json'), JSON.stringify({ sourceHash: hash.stdout, buildId: 'teste-volta' }));
}

// O código novo abre os dados (o boot de verdade, prepareServer: backup pre-atualizacao e
// migrações) e grava algo depois da atualização: um envio novo e o nome de um aluno.
function bootNewCodeAndWrite() {
    const child = path.join(tempRoot, 'boot-novo.js');
    fs.writeFileSync(child, `
const db = require(${JSON.stringify(path.join(ROOT, 'backend', 'database.js'))});
const { prepareServer } = require(${JSON.stringify(path.join(ROOT, 'backend', 'server.js'))});
(async () => {
    await prepareServer();
    const meta = db.memory.schemaMeta;
    const first = db.memory.submissions[0];
    db.memory.submissions.push({ ...first, id: 'sub_depois_da_atualizacao', score: 0 });
    db.memory.students[0].name = 'Nome trocado depois da atualização';
    await db.save();
    await db.close();
    process.stdout.write('@@' + JSON.stringify({ versaoApp: meta.versaoApp, atualizacoes: meta.atualizacoes }));
    process.exit(0);
})().catch(err => { console.error(err && err.stack || err); process.exit(1); });
`);
    const result = run(child, [], { cwd: ROOT });
    assert.equal(result.code, 0, result.output.slice(-3000));
    return JSON.parse(result.output.slice(result.output.lastIndexOf('@@') + 2));
}

test('[UC-VERSAO-001] voltar para a 281029f: a backup-cli dela restaura o pre-atualizacao e o servidor dela sobe com os dados de antes da atualização', { timeout: 10 * 60 * 1000 }, async () => {
    prepareOldCode();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(FIXTURE_DB, path.join(dataDir, 'database.db'));
    fs.cpSync(path.join(oldCode, 'content'), contentDir, { recursive: true });
    const before = await snapshot(path.join(dataDir, 'database.db'));
    assert.ok(before.tabelas.students > 0 && before.tabelas.submissions > 0 && before.tabelas.attendance > 0, 'o banco de referência tem alunos, envios e presença');

    // 1. O código novo abre os dados da 281029f: backup pre-atualizacao e migrações.
    const boot = bootNewCodeAndWrite();
    const [preUpdate] = zipsIn('pre-atualizacao_');
    assert.ok(preUpdate, 'backup pre-atualizacao feito no primeiro boot');
    const entry = boot.atualizacoes.at(-1);
    assert.equal(entry.backup, preUpdate);
    assert.ok(entry.migracoes.length > 0, 'o boot migrou os dados');
    const updated = await snapshot(path.join(dataDir, 'database.db'), before.names);
    assert.notEqual(updated.hashes.students, before.hashes.students, 'o que foi gravado depois da atualização está no banco');
    assert.equal(updated.tabelas.submissions, before.tabelas.submissions + 1);

    // 2. A backup-cli da 281029f confere e restaura o pre-atualizacao (o --sim do launcher).
    const backupFile = path.join(dataDir, 'backups', preUpdate);
    const oldCli = path.join(oldCode, 'backend', 'scripts', 'backup-cli.js');
    const verify = run(oldCli, ['verificar', backupFile], { cwd: oldCode });
    assert.equal(verify.code, 0, verify.output.slice(-3000));
    const restore = run(oldCli, ['restaurar', backupFile, '--sim'], { cwd: oldCode });
    assert.equal(restore.code, 0, restore.output.slice(-3000));

    // 3. O servidor da 281029f sobe sobre os dados restaurados e desliga.
    const port = await proc.freePort();
    const server = proc.launch(path.join(oldCode, 'backend', 'server.js'), { dataDir, port, env: { ICLASS_CONTENT_DIR: contentDir, ICLASS_ARCHIVE_DIR: archiveDir } });
    try {
        await proc.waitForHealth(server.base, { timeoutMs: 90 * 1000, exited: server.exited });
    } catch (err) {
        throw new Error(`${err.message}\n${server.output().slice(-3000)}`);
    }
    server.child.kill('SIGTERM');
    const exit = await server.exited;
    assert.ok(exit.code === 0 || exit.signal === 'SIGTERM', `${JSON.stringify(exit)}\n${server.output().slice(-2000)}`);

    // 4. Os dados são os de antes da atualização: nada do que foi gravado depois ficou.
    const after = await snapshot(path.join(dataDir, 'database.db'), before.names);
    assert.deepEqual(after.tabelas, before.tabelas);
    assert.deepEqual(after.hashes, before.hashes);
});
