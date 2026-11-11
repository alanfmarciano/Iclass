// backup-cli.js (H4a, OPS-05): o caminho de volta com o servidor parado. Antes não havia
// como criar, conferir ou restaurar um backup sem o painel (e o boot com banco danificado
// não abre o painel). Cada teste roda a CLI de verdade, num processo próprio, sobre uma
// pasta de dados descartável.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawnSync } = require('node:child_process');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-backup-cli-test-'));
const cli = path.join(__dirname, '..', '..', 'backend', 'scripts', 'backup-cli.js');
const databaseModule = JSON.stringify(require.resolve('../../backend/database.js'));
const backupModule = JSON.stringify(require.resolve('../../backend/utils/backup.js'));
const proc = require('./fixtures/server-process.js');

function envFor(dataDir, port) {
    return {
        ...process.env,
        ICLASS_DATA_DIR: dataDir,
        ICLASS_CONTENT_DIR: path.join(dataDir, 'content'),
        ICLASS_ARCHIVE_DIR: path.join(dataDir, 'arquivados'),
        TEST_MODE: '1',
        PORT: String(port),
    };
}

// Roda um trecho com o database.js da pasta e devolve o JSON que ele escreveu depois de @@.
function withDatabase(dataDir, body) {
    const script = `const db = require(${databaseModule});
db.init().then(async () => { const result = await (async () => { ${body} })(); await db.save(); await db.close(); process.stdout.write('@@' + JSON.stringify(result === undefined ? null : result)); process.exit(0); })
.catch(err => { process.stdout.write('@@' + JSON.stringify({ failed: true, code: err.code, message: err.message })); process.exit(0); });`;
    const output = execFileSync(process.execPath, ['-e', script], { env: envFor(dataDir, 1), encoding: 'utf8' });
    return JSON.parse(output.slice(output.lastIndexOf('@@') + 2));
}

function runCli(dataDir, port, args) {
    const result = spawnSync(process.execPath, [cli, ...args], { env: envFor(dataDir, port), encoding: 'utf8', input: '' });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, output: `${result.stdout}\n${result.stderr}` };
}

function makeDataDir(name) {
    const dataDir = path.join(tempRoot, name);
    fs.mkdirSync(path.join(dataDir, 'content'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'content', 'Apostila_CLI.md'), '# apostila do backup');
    withDatabase(dataDir, `
        db.memory.students.push({ name: 'Ana CLI', email: 'ana@cli.local', status: 'Ativo', classes: [] });
        db.memory.config.settings = { ...(db.memory.config.settings || {}), network: { adminAccess: 'local' } };
    `);
    return dataDir;
}

function zipsIn(dataDir) {
    const dir = path.join(dataDir, 'backups');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith('.zip')).sort() : [];
}

test.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-BACKUP-002] criar, listar e verificar: ZIP formato 2 com .sha256, listado e conferido', async () => {
    const dataDir = makeDataDir('criar');
    const port = await proc.freePort();
    const created = runCli(dataDir, port, ['criar']);
    assert.equal(created.code, 0, created.output);
    const [zip] = zipsIn(dataDir);
    assert.match(zip, /^manual_completo_.+\.zip$/);
    assert.ok(fs.existsSync(path.join(dataDir, 'backups', `${zip}.sha256`)));

    // O estado.json do servidor (H4b) mora em data/backups e é mais novo que o ZIP: não é
    // backup e não aparece na lista (antes saía como "1. estado.json [formato antigo]",
    // e o restaurar --ultimo do launcher o tomaria pelo backup mais recente).
    fs.writeFileSync(path.join(dataDir, 'backups', 'estado.json'), JSON.stringify({ local: { ultimoSucesso: new Date().toISOString() } }));
    fs.writeFileSync(path.join(dataDir, 'backups', 'anotacoes.json'), '{}');
    const listed = runCli(dataDir, port, ['listar']);
    assert.equal(listed.code, 0, listed.output);
    assert.match(listed.stdout, new RegExp(`1\\. ${zip.replace(/\./g, '\\.')} .*formato 2, completo`));
    assert.equal(/estado\.json|anotacoes\.json/.test(listed.stdout), false, listed.stdout);

    const verified = runCli(dataDir, port, ['verificar', path.join(dataDir, 'backups', zip)]);
    assert.equal(verified.code, 0, verified.output);
    assert.match(verified.stdout, /Backup íntegro/);
    assert.match(verified.stdout, /Pastas: .*content/);

    // O .sha256 ao lado não confere: recusa.
    fs.writeFileSync(path.join(dataDir, 'backups', `${zip}.sha256`), `${'0'.repeat(64)}  ${zip}\n`);
    const tampered = runCli(dataDir, port, ['verificar', path.join(dataDir, 'backups', zip)]);
    assert.equal(tampered.code, 1);
    assert.match(tampered.stderr, /não confere com a soma de verificação gravada ao lado dele/);
});

test('[UC-BACKUP-002] restaurar --ultimo com o servidor parado: banco e content do backup, o de antes na quarentena, a regra de rede de hoje fica', async () => {
    const dataDir = makeDataDir('restaurar');
    const port = await proc.freePort();
    assert.equal(runCli(dataDir, port, ['criar', '--dados']).code, 0);
    assert.equal(runCli(dataDir, port, ['criar']).code, 0);
    // Depois do backup: aluno novo, content trocado e a rede mudada.
    withDatabase(dataDir, `
        db.memory.students.push({ name: 'Bia Depois', email: 'bia@cli.local', status: 'Ativo', classes: [] });
        db.memory.config.settings.network = { adminAccess: 'rede' };
    `);
    fs.writeFileSync(path.join(dataDir, 'content', 'Apostila_CLI.md'), '# editada depois');
    // Restauração pela tela interrompida no meio (marcador do backup.js): a da CLI a
    // substitui, e o marcador vai para a quarentena (senão o boot seguinte "desfaria" esta).
    fs.mkdirSync(path.join(dataDir, '.restauracao', 'desfazer'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, '.restauracao', 'desfazer', 'marcador.json'), JSON.stringify({ id: 'x', banco: null, pastas: [], conteudo: [], cursos: [] }));

    const restored = runCli(dataDir, port, ['restaurar', '--ultimo', '--sim']);
    assert.equal(restored.code, 0, restored.output);
    assert.match(restored.stdout, /restauração pela tela Sistema interrompida/);
    assert.equal(fs.existsSync(path.join(dataDir, '.restauracao', 'desfazer')), false);
    assert.match(restored.stdout, /Backup restaurado/);
    assert.match(restored.stdout, /opção \[S\] do launcher/);

    const after = withDatabase(dataDir, `return { emails: db.memory.students.map(s => s.email), network: db.memory.config.settings.network, sessions: db.memory.authSessions ? Object.keys(db.memory.authSessions).length : 0 };`);
    assert.ok(after.emails.includes('ana@cli.local'));
    assert.equal(after.emails.includes('bia@cli.local'), false, 'o aluno criado depois do backup sai');
    assert.deepEqual(after.network, { adminAccess: 'rede' }, 'decisões §7: a regra de rede de hoje fica');
    assert.equal(fs.readFileSync(path.join(dataDir, 'content', 'Apostila_CLI.md'), 'utf8'), '# apostila do backup');

    const quarantine = fs.readdirSync(path.join(dataDir, 'quarentena'));
    assert.equal(quarantine.length, 1);
    assert.match(quarantine[0], /^antes-restauracao_/);
    assert.ok(fs.existsSync(path.join(dataDir, 'quarentena', quarantine[0], 'restauracao-interrompida', 'marcador.json')));
    assert.ok(fs.existsSync(path.join(dataDir, 'quarentena', quarantine[0], 'data', 'database.db')), 'o banco de antes não é apagado');
    assert.equal(fs.readFileSync(path.join(dataDir, 'quarentena', quarantine[0], 'content', 'Apostila_CLI.md'), 'utf8'), '# editada depois');
});

test('[UC-BACKUP-002] restaurar sem --sim pede RESTAURAR; com o servidor ligado criar e restaurar saem com 2 e nada muda', async () => {
    const dataDir = makeDataDir('ligado');
    const port = await proc.freePort();
    assert.equal(runCli(dataDir, port, ['criar']).code, 0);
    const [zip] = zipsIn(dataDir);
    const dbBefore = fs.readFileSync(path.join(dataDir, 'database.db'));

    const cancelled = runCli(dataDir, port, ['restaurar', path.join(dataDir, 'backups', zip)]);
    assert.equal(cancelled.code, 1, cancelled.output);
    assert.match(cancelled.stdout, /Restauração cancelada\. Nada foi alterado\./);

    const server = http.createServer((req, res) => { res.statusCode = 401; res.end(); });
    await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
    try {
        const refused = await new Promise(resolve => {
            const child = require('node:child_process').spawn(process.execPath, [cli, 'restaurar', '--ultimo', '--sim'], { env: envFor(dataDir, port) });
            let output = '';
            child.stdout.on('data', chunk => { output += chunk; });
            child.stderr.on('data', chunk => { output += chunk; });
            child.on('exit', code => resolve({ code, output }));
        });
        assert.equal(refused.code, 2, refused.output);
        assert.match(refused.output, /O IClass está ligado/);
        // criar também espera o servidor parado (a memória dele ficaria fora da cópia).
        const createRefused = await new Promise(resolve => {
            const child = require('node:child_process').spawn(process.execPath, [cli, 'criar'], { env: envFor(dataDir, port) });
            let output = '';
            child.stdout.on('data', chunk => { output += chunk; });
            child.stderr.on('data', chunk => { output += chunk; });
            child.on('exit', code => resolve({ code, output }));
        });
        assert.equal(createRefused.code, 2, createRefused.output);
        assert.deepEqual(zipsIn(dataDir), [zip], 'nenhum backup novo com o servidor ligado');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
    assert.ok(fs.readFileSync(path.join(dataDir, 'database.db')).equals(dbBefore));
    assert.equal(fs.existsSync(path.join(dataDir, 'quarentena')), false);
});

test('[UC-BACKUP-002] banco danificado: restaurar --ultimo devolve um banco que abre', async () => {
    const dataDir = makeDataDir('danificado');
    const port = await proc.freePort();
    assert.equal(runCli(dataDir, port, ['criar']).code, 0);
    // Cabeçalho estragado: não é mais um banco SQLite.
    const file = path.join(dataDir, 'database.db');
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
    const handle = fs.openSync(file, 'r+');
    fs.writeSync(handle, Buffer.alloc(100, 0x41), 0, 100, 0);
    fs.closeSync(handle);
    assert.equal(withDatabase(dataDir, 'return 1;').code, 'ICLASS_DB_CORRUPT');

    const restored = runCli(dataDir, port, ['restaurar', '--ultimo', '--sim']);
    assert.equal(restored.code, 0, restored.output);
    assert.match(restored.stdout, /A regra de rede do painel voltou à do backup/);
    const after = withDatabase(dataDir, 'return { emails: db.memory.students.map(s => s.email) };');
    assert.ok(after.emails.includes('ana@cli.local'));
});

test('[UC-BACKUP-002] verificar recusa ZIP de formato antigo e ZIP cortado, com saída 1', async () => {
    const dataDir = makeDataDir('antigo');
    const port = await proc.freePort();
    const script = `const db = require(${databaseModule}); const backup = require(${backupModule});
db.init().then(async () => { require('fs').writeFileSync(process.argv[1], backup.buildFullZipBuffer()); await db.close(); process.exit(0); });`;
    const format1 = path.join(tempRoot, 'formato1.zip');
    execFileSync(process.execPath, ['-e', script, format1], { env: envFor(dataDir, port) });
    const old = runCli(dataDir, port, ['verificar', format1]);
    assert.equal(old.code, 1, old.output);
    assert.match(old.stderr, /formato antigo .*tela Sistema/);

    assert.equal(runCli(dataDir, port, ['criar']).code, 0);
    const [zip] = zipsIn(dataDir);
    const whole = fs.readFileSync(path.join(dataDir, 'backups', zip));
    const cut = path.join(tempRoot, 'cortado.zip');
    fs.writeFileSync(cut, whole.subarray(0, Math.floor(whole.length / 2)));
    const broken = runCli(dataDir, port, ['verificar', cut]);
    assert.equal(broken.code, 1, broken.output);
    assert.match(broken.stderr, /corrompido ou incompleto/);
    assert.equal(/at .*\.js:\d+/.test(broken.stderr), false, 'erro esperado sem pilha');
});

test('[UC-BACKUP-004] criar sem --destino grava na pasta deste computador no destino externo da tela Sistema; listar mostra as duas pastas', async () => {
    const dataDir = makeDataDir('destino-externo');
    const pendrive = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-backup-cli-pendrive-'));
    try {
        withDatabase(dataDir, `db.memory.config.settings = { ...(db.memory.config.settings || {}), backup: { destino: ${JSON.stringify(pendrive)}, guardarExterno: 14 } };`);
        const port = await proc.freePort();
        const created = runCli(dataDir, port, ['criar', '--dados']);
        assert.equal(created.code, 0, created.output);
        const store = require('../../backend/utils/backupStore.js');
        const external = store.externalDir(pendrive);
        const [zip] = fs.readdirSync(external).filter(name => name.endsWith('.zip'));
        assert.match(zip, /^manual_dados_.+\.zip$/);
        assert.ok(fs.existsSync(path.join(external, `${zip}.sha256`)));
        assert.deepEqual(zipsIn(dataDir), [], 'sem --destino e com o destino acessível, o backup vai para o pendrive');

        const local = runCli(dataDir, port, ['criar', '--dados', '--destino', path.join(dataDir, 'backups')]);
        assert.equal(local.code, 0, local.output);
        const listed = runCli(dataDir, port, ['listar']);
        assert.equal(listed.code, 0, listed.output);
        assert.match(listed.stdout, /Backups neste computador/);
        assert.match(listed.stdout, new RegExp(`Backups no destino externo, em ${external.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
        assert.match(listed.stdout, new RegExp(zip.replace(/\./g, '\\.')));

        // Pendrive desconectado: criar cai em data/backups e listar avisa.
        fs.rmSync(pendrive, { recursive: true, force: true });
        const fallback = runCli(dataDir, port, ['criar', '--dados']);
        assert.equal(fallback.code, 0, fallback.output);
        assert.match(fallback.stdout, /não está acessível/);
        assert.equal(zipsIn(dataDir).length, 2);
        assert.match(runCli(dataDir, port, ['listar']).stdout, /não está acessível agora/);
    } finally {
        fs.rmSync(pendrive, { recursive: true, force: true });
    }
});
