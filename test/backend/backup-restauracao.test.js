// Backup ZIP formato 2 e restauração com prévia (H4a: CONF-07, OPS-04, CONF-08, CONF-11,
// SEG-X1). O formato 2 leva a cópia do banco pelo VACUUM INTO (com o histórico de
// digitação), o manifesto com o SHA-256 e as pastas; a restauração passa por uma prévia
// com token de uso único, aplica cada coleção pelo modo do registro e confere o arquivo
// inteiro antes de mudar qualquer coisa.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const request = require('supertest');
const { ticketUrl } = require('./fixtures/backupDownload.js');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-backup-h4a-test-'));
process.env.ICLASS_DATA_DIR = path.join(tempRoot, 'data');
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'cursos_arquivados');
process.env.TEST_MODE = '1';

const AdmZip = require('adm-zip');
const db = require('../../backend/database.js');
const runtimePaths = require('../../backend/runtimePaths.js');
const { createApp } = require('../../backend/server.js');
const backup = require('../../backend/utils/backup.js');
const archive = require('../../backend/utils/backupArchive.js');
const dbFile = require('../../backend/utils/dbFile.js');
const { LEGACY_KEYSTROKE_TABLE } = require('../../backend/utils/keystrokeStore.js');

const ADMIN = 'admin@h4a.local';
const OTHER_ADMIN = 'outra@h4a.local';
const PROFESSOR = 'prof@h4a.local';
const TOKENS = { [ADMIN]: 'token-admin-h4a', [OTHER_ADMIN]: 'token-outra-h4a', [PROFESSOR]: 'token-prof-h4a' };
const SECRET = 'a'.repeat(64);
let app;
let counter = 0;

function accounts() {
    return [
        { email: ADMIN, name: 'Admin', role: 'admin', password: db.hashPassword('segura-h4a') },
        { email: OTHER_ADMIN, name: 'Outra', role: 'admin', password: db.hashPassword('segura-h4a') },
        { email: PROFESSOR, name: 'Prof', role: 'professor', password: db.hashPassword('segura-h4a'), additionalPermissions: ['page.system', 'system.manage'] },
    ];
}

function sessions() {
    const now = Date.now();
    db.memory.adminSessions = Object.fromEntries(Object.entries(TOKENS).map(([email, token]) => [token, { email, createdAt: now, lastSeen: now }]));
}

const as = (email = ADMIN) => (method, url) => request(app)[method](url).set('x-admin-session', TOKENS[email]);
const preview = (buffer, name, email = ADMIN) => as(email)('post', '/api/admin/backup/restore/preview').attach('file', buffer, name);
const confirmRestore = (token, extra = {}, email = ADMIN) => as(email)('post', '/api/admin/backup/restore').send({ token, confirm: 'RESTAURAR', ...extra });

function student(email, extra = {}) {
    return { name: email.split('@')[0], email, status: 'Ativo', classes: [{ name: 'Turma H4a', courseId: 'curso-h4a' }], ...extra };
}

function keystroke(id, email = 'ana@h4a.local') {
    return { id, studentEmail: email, studentClass: 'Turma H4a', courseId: 'curso-h4a', examKey: 'Prova_H4a', seq: 1, key: 'a', serverTs: Date.now() };
}

async function resetState() {
    sessions();
    db.memory.admins = accounts();
    db.memory.students = [student('ana@h4a.local'), student('bia@h4a.local')];
    db.memory.classes = [{ name: 'Turma H4a', courseId: 'curso-h4a' }];
    db.memory.courses = [{ id: 'curso-h4a', name: 'Curso H4a' }];
    db.memory.attendance = [];
    db.memory.examApplications = [];
    db.memory.submissions = [];
    db.memory.config.examAnswerSecret = SECRET;
    db.memory.config.settings = { ...(db.memory.config.settings || {}), network: { adminAccess: 'local' } };
    await db.keystrokes.importRows([], { replace: true });
    await db.save();
}

function tempFile(name) {
    counter += 1;
    return path.join(tempRoot, `${counter}-${name}`);
}

async function writeFormat2(variante = 'completo') {
    const file = tempFile(`backup-${variante}.zip`);
    await backup.streamFullZip(fs.createWriteStream(file), { variante });
    return file;
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function listDir(dir) {
    try { return fs.readdirSync(dir); } catch (e) { return []; }
}

test.before(async () => {
    await db.init();
    app = createApp();
    await resetState();
});

test.after(async () => {
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-BACKUP-003] toda tabela do banco está no registro: nada fica de fora do banco do formato 2', async () => {
    const connection = await dbFile.openDatabaseFile(db.dbPath);
    let tables;
    try { tables = await dbFile.tableNames(connection); } finally { await dbFile.closeDatabaseFile(connection); }
    const known = new Set([...db.COLLECTION_TABLES.map(entry => entry.table), LEGACY_KEYSTROKE_TABLE]);
    assert.deepEqual(tables.filter(name => !known.has(name)), [], 'tabela nova sem entrada no registro');
    const file = await writeFormat2('dados');
    const manifest = JSON.parse(new AdmZip(file).readAsText('iclass-backup.json'));
    assert.deepEqual(Object.keys(manifest.banco.tabelas).sort(), [...tables].sort());
});

test('[UC-BACKUP-003] ZIP formato 2: ida e volta com o histórico de digitação, cursos arquivados, biblioteca, documentos e apostilas; data/tls nunca entra', async () => {
    await resetState();
    await db.keystrokes.append([keystroke('k1'), keystroke('k2'), keystroke('k3')]);
    fs.mkdirSync(runtimePaths.CONTENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(runtimePaths.CONTENT_DIR, 'Apostila_H4a.md'), '# original');
    fs.mkdirSync(runtimePaths.UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(runtimePaths.UPLOADS_DIR, 'material.pdf'), '%PDF-original');
    fs.mkdirSync(path.join(runtimePaths.STUDENTS_DIR, 'ana'), { recursive: true });
    fs.writeFileSync(path.join(runtimePaths.STUDENTS_DIR, 'ana', 'atestado.pdf'), '%PDF-atestado');
    fs.mkdirSync(path.join(runtimePaths.ARCHIVE_DIR, 'curso_2024'), { recursive: true });
    fs.writeFileSync(path.join(runtimePaths.ARCHIVE_DIR, 'curso_2024', 'manifesto.json'), '{"folder":"curso_2024"}');
    fs.mkdirSync(path.join(runtimePaths.DATA_DIR, 'tls'), { recursive: true });
    fs.writeFileSync(path.join(runtimePaths.DATA_DIR, 'tls', 'chave.pem'), 'segredo');
    await db.save();

    const saved = await backup.createBackup({ origem: 'manual', variante: 'completo' });
    assert.match(saved.name, /^manual_completo_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.zip$/);
    const zipBuffer = fs.readFileSync(saved.file);
    assert.equal(fs.readFileSync(`${saved.file}.sha256`, 'utf8'), `${sha256(zipBuffer)}  ${saved.name}\n`, '.sha256 no formato do sha256sum');
    const zip = new AdmZip(zipBuffer);
    const names = zip.getEntries().map(entry => entry.entryName);
    const manifest = JSON.parse(zip.readAsText('iclass-backup.json'));
    assert.equal(manifest.type, 'iclass-backup-manifest');
    assert.equal(manifest.formato, 2);
    assert.equal(manifest.variante, 'completo');
    assert.deepEqual([...manifest.inclui].sort(), ['content', 'cursos_arquivados', 'data/alunos', 'data/uploads']);
    assert.equal(manifest.banco.sha256, sha256(zip.getEntry('data/database.db').getData()));
    assert.equal(manifest.banco.tabelas.exam_keystroke_events, 3);
    assert.ok(names.includes('data/uploads/material.pdf'));
    assert.ok(names.includes('data/alunos/ana/atestado.pdf'));
    assert.ok(names.includes('cursos_arquivados/curso_2024/manifesto.json'));
    assert.ok(names.includes('content/Apostila_H4a.md'));
    assert.equal(names.some(name => /(^|\/)tls\//.test(name)), false, 'o certificado não vai no backup');
    assert.equal(names.some(name => name.startsWith('data/backups/') || name.startsWith('data/.')), false);

    // Tudo muda depois do backup.
    db.memory.students[0].name = 'Ana trocada';
    await db.keystrokes.append([keystroke('k4'), keystroke('k5')]);
    fs.writeFileSync(path.join(runtimePaths.CONTENT_DIR, 'Apostila_H4a.md'), '# alterada');
    fs.rmSync(path.join(runtimePaths.UPLOADS_DIR, 'material.pdf'));
    fs.rmSync(path.join(runtimePaths.ARCHIVE_DIR, 'curso_2024'), { recursive: true });
    await db.save();

    const checked = await preview(zipBuffer, saved.name);
    assert.equal(checked.status, 200, checked.body && checked.body.error);
    assert.equal(checked.body.formato, 'zip-2');
    assert.equal(checked.body.integridade.verificada, true);
    const keys = checked.body.contagens.find(row => row.colecao === 'examKeystrokes');
    assert.deepEqual({ backup: keys.backup, atual: keys.atual }, { backup: 3, atual: 5 });
    assert.equal(checked.body.redeMantida, true);
    assert.ok(checked.body.token);
    assert.equal(db.memory.students[0].name, 'Ana trocada', 'a prévia não muda nada');

    const restored = await confirmRestore(checked.body.token);
    assert.equal(restored.status, 200, restored.body && restored.body.error);
    assert.match(restored.body.safetyBackup, /^seguranca-restauracao_completo_.+\.zip$/);
    assert.ok(fs.existsSync(path.join(runtimePaths.BACKUPS_DIR, restored.body.safetyBackup)), 'backup de segurança antes');
    assert.equal(db.memory.students[0].name, 'ana');
    assert.deepEqual((await db.keystrokes.exportRows()).map(row => row.id).sort(), ['k1', 'k2', 'k3'], 'as teclas voltam (antes ficavam as de agora)');
    assert.equal(fs.readFileSync(path.join(runtimePaths.CONTENT_DIR, 'Apostila_H4a.md'), 'utf8'), '# original');
    assert.equal(fs.readFileSync(path.join(runtimePaths.UPLOADS_DIR, 'material.pdf'), 'utf8'), '%PDF-original');
    assert.ok(fs.existsSync(path.join(runtimePaths.ARCHIVE_DIR, 'curso_2024', 'manifesto.json')), 'curso arquivado acrescentado de volta');
    assert.equal(fs.readFileSync(path.join(runtimePaths.DATA_DIR, 'tls', 'chave.pem'), 'utf8'), 'segredo', 'data/tls fica como está');
    const audit = db.memory.auditLogs.filter(entry => entry.action === 'backup_restored').pop();
    assert.equal(audit.details.formato, 'zip-2');
    assert.equal(audit.details.file, saved.name);
});

test('[UC-BACKUP-003] "Baixar só os dados": ZIP formato 2 sem a biblioteca, com as teclas', async () => {
    await resetState();
    await db.keystrokes.append([keystroke('d1')]);
    fs.mkdirSync(runtimePaths.UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(runtimePaths.UPLOADS_DIR, 'grande.pdf'), '%PDF-grande');
    // Baixar pede a senha de novo (H4b, SEG-15): o bilhete vai no ?ticket=.
    const res = await as()('get', await ticketUrl(app, TOKENS[ADMIN], 'segura-h4a', '/api/admin/backup/full?variante=dados')).buffer(true).parse((response, callback) => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
    });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-disposition'], /filename="iclass-backup-dados_\d{4}-\d{2}-\d{2}\.zip"/);
    const zip = new AdmZip(res.body);
    const manifest = JSON.parse(zip.readAsText('iclass-backup.json'));
    assert.equal(manifest.variante, 'dados');
    assert.equal(manifest.inclui.includes('data/uploads'), false);
    assert.equal(zip.getEntries().some(entry => entry.entryName.startsWith('data/uploads/')), false);
    assert.equal(manifest.banco.tabelas.exam_keystroke_events, 1);
    // O JSON de dados também leva as teclas (antes saía sem elas).
    const json = await as()('get', await ticketUrl(app, TOKENS[ADMIN], 'segura-h4a', '/api/admin/backup/data'));
    assert.equal(json.status, 200);
    assert.deepEqual(json.body.data.examKeystrokes.map(row => row.id), ['d1']);
});

test('[UC-BACKUP-003] snapshotTo: cópia consistente com 30 gravações ao mesmo tempo', async () => {
    await resetState();
    const target = tempFile('snapshot.db');
    const saves = [];
    let snapshot;
    for (let index = 0; index < 30; index += 1) {
        db.memory.notes[`nota${index}@h4a.local`] = { valor: index };
        saves.push(db.save());
        if (index === 15) snapshot = db.snapshotTo(target);
    }
    await Promise.all(saves);
    const info = await snapshot;
    assert.equal(info.quickCheck, 'ok');
    assert.equal(info.sha256, await dbFile.fileSha256(target));
    const connection = await dbFile.openDatabaseFile(target);
    try {
        const stored = await db.readStoredData(connection);
        const copied = Object.keys(stored.memory.notes).filter(key => /^nota\d+@h4a\.local$/.test(key)).length;
        assert.ok(copied >= 16 && copied <= 30, `a cópia tem um estado inteiro (${copied} notas)`);
    } finally {
        await dbFile.closeDatabaseFile(connection);
    }
    await assert.rejects(db.snapshotTo(target), /já existe/, 'não sobrescreve um arquivo existente');
});

test('[UC-BACKUP-001] coleção que falta no backup fica vazia (e a prévia avisa); configuração e auditoria ficam', async () => {
    await resetState();
    const snapshot = structuredClone(backup.buildDataSnapshot());
    delete snapshot.data.attendance;
    db.memory.attendance = [{ id: 'p1', studentEmail: 'ana@h4a.local', status: 'presente' }, { id: 'p2', studentEmail: 'bia@h4a.local', status: 'falta' }];
    db.memory.config.settings.timezone = 'America/Recife';
    await db.save();
    const checked = await preview(Buffer.from(JSON.stringify(snapshot)), 'sem-presencas.json');
    assert.equal(checked.status, 200, checked.body && checked.body.error);
    assert.deepEqual(checked.body.ficaraoVazias.map(item => item.colecao), ['attendance']);
    assert.equal(checked.body.ficaraoVazias[0].atual, 2);
    assert.equal(checked.body.integridade.verificada, false);
    assert.equal(checked.body.formato, 'json');
    const restored = await confirmRestore(checked.body.token);
    assert.equal(restored.status, 200, restored.body && restored.body.error);
    assert.deepEqual(db.memory.attendance, [], 'antes as presenças de agora ficavam misturadas às do backup');
    assert.ok(db.memory.auditLogs.some(entry => entry.action === 'backup_restored'));
});

test('[UC-BACKUP-001] restaurar mantém settings.backup, settings.network e o segredo das alternativas de agora (decisões §7)', async () => {
    await resetState();
    db.memory.config.settings.backup = { destino: 'D:/Backups-IClass', horario: '18:00' };
    await db.save();
    const snapshot = structuredClone(backup.buildDataSnapshot());
    snapshot.data.config.settings.backup = { destino: 'C:/outro-computador' };
    snapshot.data.config.settings.network = { adminAccess: 'rede-sem-https' };
    snapshot.data.config.settings.timezone = 'America/Manaus';
    delete snapshot.data.config.examAnswerSecret;
    const first = await preview(Buffer.from(JSON.stringify(snapshot)), 'outro-pc.json');
    assert.equal((await confirmRestore(first.body.token)).status, 200);
    assert.deepEqual(db.memory.config.settings.backup, { destino: 'D:/Backups-IClass', horario: '18:00' });
    assert.deepEqual(db.memory.config.settings.network, { adminAccess: 'local' });
    assert.equal(db.memory.config.settings.timezone, 'America/Manaus', 'o resto vem do backup');
    assert.equal(db.memory.config.examAnswerSecret, SECRET, 'sem segredo no backup: fica o de agora');

    sessions();
    snapshot.data.config.examAnswerSecret = 'b'.repeat(64);
    const second = await preview(Buffer.from(JSON.stringify(snapshot)), 'com-segredo.json');
    assert.equal((await confirmRestore(second.body.token)).status, 200);
    assert.equal(db.memory.config.examAnswerSecret, 'b'.repeat(64), 'o segredo válido do backup volta com as entregas dele');
    assert.deepEqual(db.afterRestore.map(hook => hook.name), ['authSessions', 'legacyPasswordHashes', 'networkSettings', 'protectedConfig']);
});

test('[UC-BACKUP-001] o envio do backup não passa por data/uploads e não segue o limite de envio de materiais', async () => {
    await resetState();
    db.memory.config.settings.upload = { ...(db.memory.config.settings.upload || {}), maxSizeMb: 1 };
    await db.save();
    const snapshot = structuredClone(backup.buildDataSnapshot());
    snapshot.data.notes = { 'grande@h4a.local': { texto: 'x'.repeat(Math.floor(2.5 * 1024 * 1024)) } };
    const uploadsBefore = listDir(runtimePaths.UPLOADS_DIR).sort();
    const checked = await preview(Buffer.from(JSON.stringify(snapshot)), 'grande.json');
    assert.equal(checked.status, 200, `antes: "arquivo maior que o limite de envio" (${checked.body && checked.body.error})`);
    assert.deepEqual(listDir(runtimePaths.UPLOADS_DIR).sort(), uploadsBefore, 'nada em data/uploads');
    assert.deepEqual(listDir(backup.UPLOADS_INBOX_DIR), [], 'o envio sai da caixa de entrada para a pasta da prévia');
    const restored = await confirmRestore(checked.body.token);
    assert.equal(restored.status, 200, restored.body && restored.body.error);
    assert.equal(db.memory.notes['grande@h4a.local'].texto.length, Math.floor(2.5 * 1024 * 1024));
    assert.deepEqual(listDir(backup.RESTORE_DIR).filter(name => name !== 'envios'), [], 'a pasta da prévia sai depois de usada');
    assert.deepEqual(listDir(runtimePaths.UPLOADS_DIR).sort(), uploadsBefore);
});

test('[UC-BACKUP-001] estrutura das coleções: recusa em português com a coleção e a posição, e nada muda', async () => {
    await resetState();
    const base = () => structuredClone(backup.buildDataSnapshot());
    const cases = [
        [data => { data.students = [student('a@h4a.local'), { name: 'Sem e-mail', status: 'Ativo' }]; }, 'Backup inválido: aluno sem e-mail na posição 2 (students).'],
        [data => { data.students = [student('Ana@H4a.local'), student('ana@h4a.local')]; }, 'Backup inválido: e-mail repetido "ana@h4a.local" nas posições 1 e 2 (students).'],
        [data => { data.classes = [{ courseId: 'curso-h4a' }]; }, 'Backup inválido: turma sem nome na posição 1 (classes).'],
        [data => { data.classes = { nome: 'Turma' }; }, 'Backup inválido: a coleção classes precisa ser uma lista.'],
        [data => { data.examApplications = [{ id: 'x' }, { id: 'x' }]; }, 'Backup inválido: identificador repetido "x" nas posições 1 e 2 (examApplications).'],
        [data => { data.submissions = ['texto solto']; }, 'Backup inválido: entrega que não é um registro na posição 1 (submissions).'],
    ];
    const before = JSON.stringify(db.memory.students);
    for (const [change, message] of cases) {
        const snapshot = base();
        change(snapshot.data);
        const res = await preview(Buffer.from(JSON.stringify(snapshot)), 'editado.json');
        assert.equal(res.status, 400, message);
        assert.equal(res.body.error, message);
        const failure = db.memory.auditLogs.filter(entry => entry.action === 'backup_restore_failed').pop();
        assert.equal(failure.details.error, message);
        assert.equal(failure.details.etapa, 'previa');
    }
    assert.equal(JSON.stringify(db.memory.students), before);
    assert.deepEqual(listDir(backup.RESTORE_DIR).filter(name => name !== 'envios'), [], 'a recusa não deixa a pasta da prévia');
});

// Acha o registro do diretório central de uma entrada (assinatura 0x02014b50).
function centralRecord(buffer, name) {
    for (let index = buffer.length - 46; index >= 0; index -= 1) {
        if (buffer.readUInt32LE(index) !== 0x02014b50) continue;
        const length = buffer.readUInt16LE(index + 28);
        if (buffer.subarray(index + 46, index + 46 + length).toString('utf8') === name) return index;
    }
    return -1;
}

test('[UC-BACKUP-003] integridade do ZIP: soma de verificação, CRC, arquivo cortado e bomba de descompressão são recusados antes de mudar qualquer coisa', async () => {
    await resetState();
    fs.mkdirSync(runtimePaths.UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(runtimePaths.UPLOADS_DIR, 'material.pdf'), '%PDF-original-integridade');
    fs.writeFileSync(path.join(runtimePaths.CONTENT_DIR, 'Texto_H4a.md'), '# texto '.repeat(500));
    const good = fs.readFileSync(await writeFormat2('completo'));
    const before = JSON.stringify(db.memory.students);

    // Manifesto com outra soma (banco trocado ou editado).
    const edited = new AdmZip(good);
    const manifest = JSON.parse(edited.readAsText('iclass-backup.json'));
    manifest.banco.sha256 = '0'.repeat(64);
    edited.updateFile('iclass-backup.json', Buffer.from(JSON.stringify(manifest)));
    const wrongSum = await preview(edited.toBuffer(), 'soma.zip');
    assert.equal(wrongSum.status, 400);
    assert.match(wrongSum.body.error, /não confere com a soma de verificação do manifesto/);

    // Um byte trocado no meio do PDF (guardado sem compressão): o CRC não bate.
    const flipped = Buffer.from(good);
    const at = flipped.indexOf('%PDF-original-integridade') + 6;
    flipped[at] = flipped[at] === 0x41 ? 0x42 : 0x41;
    const badCrc = await preview(flipped, 'crc.zip');
    assert.equal(badCrc.status, 400);
    assert.match(badCrc.body.error, /material\.pdf está corrompida \(CRC diferente do gravado\)/);

    // Cortado no meio (download interrompido).
    const cut = await preview(good.subarray(0, Math.floor(good.length / 2)), 'cortado.zip');
    assert.equal(cut.status, 400);
    assert.equal(cut.body.error, 'O arquivo ZIP do backup está corrompido ou incompleto e não pôde ser aberto.');

    // Entrada que declara 1 byte e descompacta muito mais.
    const bomb = Buffer.from(good);
    const record = centralRecord(bomb, 'content/Texto_H4a.md');
    assert.ok(record > 0);
    bomb.writeUInt32LE(1, record + 24);
    const bombed = await preview(bomb, 'bomba.zip');
    assert.equal(bombed.status, 400);
    assert.match(bombed.body.error, /descompacta mais bytes do que declara/);

    assert.equal(JSON.stringify(db.memory.students), before);
    assert.deepEqual(listDir(backup.RESTORE_DIR).filter(name => name !== 'envios'), []);
});

test('[UC-BACKUP-003] link simbólico dentro do ZIP é recusado', async () => {
    await resetState();
    const zip = new AdmZip(fs.readFileSync(await writeFormat2('dados')));
    zip.addFile('content/atalho.md', Buffer.from('/etc/passwd'));
    const entry = zip.getEntry('content/atalho.md');
    entry.header.made = (3 << 8) | 20;
    entry.attr = (0o120777 << 16) >>> 0;
    const res = await preview(zip.toBuffer(), 'link.zip');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Link simbólico não permitido no ZIP: content/atalho.md');
});

test('[UC-BACKUP-001] token da prévia: uso único, só de quem fez a prévia, vale 1 hora; a pasta da prévia sai', async () => {
    await resetState();
    const snapshot = Buffer.from(JSON.stringify(backup.buildDataSnapshot()));
    const checked = await preview(snapshot, 'token.json');
    assert.equal(checked.status, 200);
    assert.ok(Date.parse(checked.body.expiraEm) - Date.now() > 59 * 60 * 1000);
    const other = await confirmRestore(checked.body.token, {}, OTHER_ADMIN);
    assert.equal(other.status, 403);
    assert.match(other.body.error, /outro administrador/);
    const noConfirm = await as()('post', '/api/admin/backup/restore').send({ token: checked.body.token, confirm: 'sim' });
    assert.equal(noConfirm.status, 400);
    const ok = await confirmRestore(checked.body.token);
    assert.equal(ok.status, 200, 'o token continua valendo para quem fez a prévia');
    sessions();
    const again = await confirmRestore(checked.body.token);
    assert.equal(again.status, 400);
    assert.match(again.body.error, /não vale mais/);

    // Vencido: a varredura tira o token e apaga a pasta da prévia.
    const { prepared } = await backup.prepareRestore((() => {
        const file = tempFile('vence.json');
        fs.writeFileSync(file, snapshot);
        return file;
    })(), { originalName: 'vence.json' });
    assert.ok(fs.existsSync(prepared.stagingDir));
    const now = Date.now();
    const { token } = backup.createRestoreToken(prepared, ADMIN, { now });
    assert.equal(backup.takeRestoreToken(token, ADMIN, { now: now + backup.RESTORE_TOKEN_TTL_MS + 1 }).status, 400);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(fs.existsSync(prepared.stagingDir), false, 'a pasta da prévia vencida sai');
});

test('[UC-BACKUP-001] professor não faz prévia nem restaura (403, registrado no histórico)', async () => {
    await resetState();
    const res = await preview(Buffer.from(JSON.stringify(backup.buildDataSnapshot())), 'prof.json', PROFESSOR);
    assert.equal(res.status, 403);
    const failure = db.memory.auditLogs.filter(entry => entry.action === 'backup_restore_failed').pop();
    assert.equal(failure.actor, PROFESSOR);
    assert.equal(listDir(backup.UPLOADS_INBOX_DIR).length, 0, 'o arquivo nem é recebido');
    const restore = await confirmRestore('qualquer', {}, PROFESSOR);
    assert.equal(restore.status, 403);
});

test('[UC-BACKUP-001] backups antigos continuam restaurando: ZIP formato 1 e JSON de versão anterior (aviso na prévia)', async () => {
    await resetState();
    db.memory.notes['formato1@h4a.local'] = { valor: 'backup' };
    await db.save();
    const format1 = backup.buildFullZipBuffer();
    db.memory.notes['formato1@h4a.local'] = { valor: 'depois' };
    await db.save();
    const checked = await preview(format1, 'formato1.zip');
    assert.equal(checked.status, 200, checked.body && checked.body.error);
    assert.equal(checked.body.formato, 'zip-1');
    assert.equal(checked.body.integridade.texto, 'sem soma de verificação (formato antigo)');
    assert.equal((await confirmRestore(checked.body.token)).status, 200);
    assert.deepEqual(db.memory.notes['formato1@h4a.local'], { valor: 'backup' });

    sessions();
    const legacy = Buffer.from(JSON.stringify(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'backup-versao-anterior.json'), 'utf8')).backup));
    const legacyPreview = await preview(legacy, 'backup-versao-anterior.json');
    assert.equal(legacyPreview.status, 200, legacyPreview.body && legacyPreview.body.error);
    assert.match(legacyPreview.body.legado.aviso, /versão anterior do IClass/);
    const restored = await confirmRestore(legacyPreview.body.token);
    assert.equal(restored.status, 200, restored.body && restored.body.error);
    assert.equal(restored.body.legacyApplications, true, 'a prévia já mostrou o aviso: sem o 409');
});

test('[UC-BACKUP-001] a prévia conta os alunos anonimizados agora que o backup traz com dados pessoais (decisões §3)', async () => {
    await resetState();
    const snapshot = structuredClone(backup.buildDataSnapshot());
    db.memory.students = [
        student('anonimizado-abc@anonimizado.invalid', { name: 'Aluno anonimizado', anonymizedAt: '2026-11-01T10:00:00.000Z', anonymizedRef: 'abc', status: 'Anonimizado' }),
        student('anonimizado-def@anonimizado.invalid', { name: 'Aluno anonimizado', anonymizedAt: '2026-11-01T10:00:00.000Z', anonymizedRef: 'def', status: 'Anonimizado' }),
        student('bia@h4a.local'),
    ];
    // O backup já traz o "def" anonimizado: ele não volta com dados pessoais.
    snapshot.data.students.push(student('anonimizado-def@anonimizado.invalid', { anonymizedAt: '2026-10-01T10:00:00.000Z', anonymizedRef: 'def', status: 'Anonimizado' }));
    await db.save();
    const checked = await preview(Buffer.from(JSON.stringify(snapshot)), 'anonimizados.json');
    assert.equal(checked.status, 200);
    assert.deepEqual(checked.body.anonimizados, { quantidade: 1, aviso: '1 aluno anonimizado depois deste backup voltará com dados pessoais.' });
    assert.ok(checked.body.avisos.includes('1 aluno anonimizado depois deste backup voltará com dados pessoais.'));
    db.memory.students.find(item => item.anonymizedRef === 'def').anonymizedRef = 'ghi';
    db.memory.students.find(item => item.anonymizedRef === 'ghi').email = 'anonimizado-ghi@anonimizado.invalid';
    const plural = await preview(Buffer.from(JSON.stringify(snapshot)), 'anonimizados.json');
    assert.equal(plural.body.anonimizados.aviso, '2 alunos anonimizados depois deste backup voltarão com dados pessoais.');
});

test('[UC-BACKUP-001] um backup por vez: o segundo pedido recebe 409', async () => {
    await resetState();
    const first = backup.createBackup({ origem: 'manual', variante: 'dados' });
    await assert.rejects(backup.createBackup({ origem: 'manual', variante: 'dados' }), error => error.status === 409 && error.code === 'ICLASS_BACKUP_BUSY');
    const busy = await preview(Buffer.from('{}'), 'busy.json');
    assert.equal(busy.status, 409);
    await first;
    assert.equal(backup.backupInProgress(), null);
});

test('[UC-BACKUP-001] falha no meio da restauração volta tudo: memória, teclas e pastas', async () => {
    await resetState();
    await db.keystrokes.append([keystroke('antes1')]);
    fs.writeFileSync(path.join(runtimePaths.CONTENT_DIR, 'Volta_H4a.md'), '# do backup');
    // Biblioteca e documentos de aluno (data/uploads e data/alunos têm a mesma pasta-mãe).
    fs.rmSync(runtimePaths.UPLOADS_DIR, { recursive: true, force: true });
    fs.mkdirSync(runtimePaths.UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(runtimePaths.UPLOADS_DIR, 'do-backup.pdf'), '%PDF-backup');
    fs.rmSync(runtimePaths.STUDENTS_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.join(runtimePaths.STUDENTS_DIR, 'ana'), { recursive: true });
    fs.writeFileSync(path.join(runtimePaths.STUDENTS_DIR, 'ana', 'do-backup.pdf'), '%PDF-backup');
    const zip = fs.readFileSync(await writeFormat2('completo'));
    db.memory.students[0].name = 'Ana de agora';
    await db.keystrokes.append([keystroke('agora1'), keystroke('agora2')]);
    fs.writeFileSync(path.join(runtimePaths.CONTENT_DIR, 'Volta_H4a.md'), '# de agora');
    fs.rmSync(path.join(runtimePaths.UPLOADS_DIR, 'do-backup.pdf'));
    fs.writeFileSync(path.join(runtimePaths.UPLOADS_DIR, 'de-agora.pdf'), '%PDF-agora');
    fs.rmSync(path.join(runtimePaths.STUDENTS_DIR, 'ana', 'do-backup.pdf'));
    fs.writeFileSync(path.join(runtimePaths.STUDENTS_DIR, 'ana', 'de-agora.pdf'), '%PDF-agora');
    await db.save();
    const checked = await preview(zip, 'falha.zip');
    assert.equal(checked.status, 200);
    const originalSave = db.save;
    let failed = false;
    db.save = function patchedSave(...args) {
        if (!failed) {
            failed = true;
            return Promise.reject(Object.assign(new Error('EIO: falha de disco no meio'), { code: 'EIO' }));
        }
        return originalSave.apply(this, args);
    };
    const originalError = console.error;
    console.error = () => {};
    let res;
    try {
        res = await confirmRestore(checked.body.token);
    } finally {
        db.save = originalSave;
        console.error = originalError;
    }
    assert.equal(res.status, 500);
    assert.equal(db.memory.students[0].name, 'Ana de agora');
    assert.deepEqual((await db.keystrokes.exportRows()).map(row => row.id).sort(), ['agora1', 'agora2', 'antes1']);
    assert.equal(fs.readFileSync(path.join(runtimePaths.CONTENT_DIR, 'Volta_H4a.md'), 'utf8'), '# de agora');
    // As duas pastas de data/ voltam (antes, a troca de data/alunos apagava a "anterior"
    // de data/uploads, e a biblioteca de agora sumia na volta).
    assert.deepEqual(fs.readdirSync(runtimePaths.UPLOADS_DIR), ['de-agora.pdf']);
    assert.deepEqual(fs.readdirSync(path.join(runtimePaths.STUDENTS_DIR, 'ana')), ['de-agora.pdf']);
    assert.deepEqual(fs.readdirSync(path.dirname(runtimePaths.UPLOADS_DIR)).filter(name => name.startsWith('.iclass-restauracao-')), []);
    assert.equal(fs.existsSync(backup.UNDO_DIR), false, 'volta completa: o marcador da restauração sai');
    const failure = db.memory.auditLogs.filter(entry => entry.action === 'backup_restore_failed').pop();
    assert.match(failure.details.error, /Código do erro/);
});
