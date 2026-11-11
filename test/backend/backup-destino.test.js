// Rotina de backup (H4b: OPS-03, CONF-11, decisões §3 SEG-15 e §12): destino externo,
// backup diário local e externo da mesma cópia do banco, adiamento durante prova,
// estado.json, status e itens do "Precisa de você", lista e download (com a senha do
// administrador de novo), retenção por grupo e o desligamento no meio de um backup.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const request = require('supertest');
const { downloadTicket, ticketUrl } = require('./fixtures/backupDownload.js');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-backup-h4b-test-'));
const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-backup-h4b-pendrive-'));
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
const store = require('../../backend/utils/backupStore.js');
const { computeQueue } = require('../../backend/utils/dashboardAggregates.js');

const ADMIN = 'admin@h4b.local';
const PROFESSOR = 'prof@h4b.local';
const PASSWORD = 'segura-h4b';
const TOKENS = { [ADMIN]: 'token-admin-h4b', [PROFESSOR]: 'token-prof-h4b' };
const HOUR = 3600000;
let app;

function accounts() {
    return [
        { email: ADMIN, name: 'Admin', role: 'admin', password: db.hashPassword(PASSWORD) },
        { email: PROFESSOR, name: 'Prof', role: 'professor', password: db.hashPassword(PASSWORD), additionalPermissions: ['page.system', 'system.manage'] },
    ];
}

const as = (email = ADMIN) => (method, url) => request(app)[method](url).set('x-admin-session', TOKENS[email]);

function binary(req) {
    return req.buffer(true).parse((res, done) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
    });
}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function clearDir(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
}

async function resetState({ destino = '' } = {}) {
    const now = Date.now();
    db.memory.admins = accounts();
    db.memory.adminSessions = Object.fromEntries(Object.entries(TOKENS).map(([email, token]) => [token, { email, createdAt: now, lastSeen: now }]));
    db.memory.students = [{ name: 'Ana', email: 'ana@h4b.local', status: 'Ativo', classes: [{ name: 'Turma H4b', courseId: 'curso-h4b' }] }];
    db.memory.classes = [{ name: 'Turma H4b', courseId: 'curso-h4b' }];
    db.memory.courses = [{ id: 'curso-h4b', name: 'Curso H4b' }];
    db.memory.examApplications = [];
    db.memory.auditLogs = [];
    db.memory.config.settings = { ...(db.memory.config.settings || {}), network: { adminAccess: 'local' }, backup: { destino, guardarExterno: 14 } };
    clearDir(runtimePaths.BACKUPS_DIR);
    clearDir(externalRoot);
    store.checksumCache.clear();
    await db.save();
}

function stamp(ms) {
    return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

function auditOf(action) {
    return (db.memory.auditLogs || []).filter(entry => entry.action === action);
}

function withoutTestMode(fn) {
    const previous = process.env.TEST_MODE;
    delete process.env.TEST_MODE;
    return Promise.resolve().then(fn).finally(() => { process.env.TEST_MODE = previous; });
}

async function queueOf(email) {
    const res = await as(email)('get', '/api/admin/dashboard/queue');
    assert.equal(res.status, 200, res.body && res.body.error);
    return res.body;
}

test.before(async () => {
    fs.mkdirSync(runtimePaths.CONTENT_DIR, { recursive: true });
    await db.init();
    app = createApp();
});

test.after(async () => {
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
});

// ------------------------------------------------------------------ destino

test('[UC-BACKUP-004] destino externo: pasta absoluta que existe, fora da pasta do IClass, com teste de gravação; só o administrador', async () => {
    await resetState();
    const save = body => as()('post', '/api/admin/backup/config').send(body);

    for (const [destino, pattern] of [
        ['pasta-relativa', /caminho completo/],
        [path.join(externalRoot, 'nao-existe'), /não existe/],
        [runtimePaths.DATA_DIR, /fora da pasta do IClass/],
        [path.join(runtimePaths.DATA_DIR, 'backups'), /fora da pasta do IClass/],
        [runtimePaths.PROJECT_ROOT, /fora da pasta do IClass/],
        [runtimePaths.CONTENT_DIR, /fora da pasta do IClass/],
    ]) {
        const res = await save({ destino });
        assert.equal(res.status, 400, destino);
        assert.equal(res.body.success, false);
        assert.equal(res.body.field, 'destino');
        assert.match(res.body.error, pattern, destino);
    }
    assert.equal((await save({ destino: externalRoot, guardarExterno: 0 })).body.field, 'guardarExterno');
    assert.equal((await save({ destino: externalRoot, guardarExterno: 91 })).status, 400);
    assert.equal((await save({ destino: 42 })).status, 400);

    const ok = await save({ destino: externalRoot, guardarExterno: 7 });
    assert.equal(ok.status, 200, ok.body.error);
    assert.equal(ok.body.destino, path.resolve(externalRoot));
    assert.equal(ok.body.pasta, path.join(path.resolve(externalRoot), store.hostFolderName()));
    assert.match(ok.body.pasta, /IClass-/);
    assert.equal(typeof ok.body.livreBytes, 'number');
    assert.equal(typeof ok.body.mesmoDisco, 'boolean');
    assert.match(ok.body.aviso, /dados pessoais de alunos/);
    assert.ok(fs.statSync(ok.body.pasta).isDirectory(), 'a pasta deste computador foi criada no destino');
    assert.deepEqual(fs.readdirSync(ok.body.pasta), [], 'o arquivo de teste da gravação foi apagado');
    assert.deepEqual(db.memory.config.settings.backup, { destino: path.resolve(externalRoot), guardarExterno: 7 });
    const changed = auditOf('backup_config_changed');
    assert.equal(changed.length, 1);
    assert.equal(changed[0].category, 'backup');
    assert.equal(changed[0].details.destino, path.resolve(externalRoot));

    const read = await as()('get', '/api/admin/backup/config');
    assert.equal(read.body.destino, path.resolve(externalRoot));
    assert.equal(read.body.guardarExterno, 7);

    // O POST /api/admin/settings não muda o destino (seção protegida).
    await as()('post', '/api/admin/settings').send({ backup: { destino: '/', guardarExterno: 90 } }).expect(200);
    assert.equal(db.memory.config.settings.backup.destino, path.resolve(externalRoot));

    // Professor com "Executar manutenção": não vê nem muda o destino.
    await as(PROFESSOR)('get', '/api/admin/backup/config').expect(403);
    await as(PROFESSOR)('post', '/api/admin/backup/config').send({ destino: '' }).expect(403);
    // Nem pelas configurações gerais: o caminho do destino é só do administrador.
    const profSettings = await as(PROFESSOR)('get', '/api/admin/settings').expect(200);
    assert.equal(profSettings.body.backup.destino, '');
    assert.equal((await as()('get', '/api/admin/settings')).body.backup.destino, path.resolve(externalRoot));
    const profStatus = await as(PROFESSOR)('get', '/api/admin/backup/status').expect(200);
    assert.equal(profStatus.body.destino, '');
    assert.equal(profStatus.body.configurado, true);

    // Vazio desliga a cópia externa.
    const off = await save({ destino: '' });
    assert.equal(off.status, 200);
    assert.equal(db.memory.config.settings.backup.destino, '');
});

// ------------------------------------------------------------------ execução

test('[UC-BACKUP-004] "Fazer backup agora": dados em data/backups e completo no destino, da mesma cópia, com .sha256 e estado.json', async () => {
    await resetState();
    await as()('post', '/api/admin/backup/config').send({ destino: externalRoot }).expect(200);
    fs.mkdirSync(runtimePaths.UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(runtimePaths.UPLOADS_DIR, 'apostila.pdf'), '%PDF-h4b');

    const res = await as()('post', '/api/admin/backup/server').send({});
    assert.equal(res.status, 200, res.body.error);
    assert.match(res.body.fileName, /^manual_dados_.+\.zip$/);
    assert.match(res.body.externo.fileName, /^manual_completo_.+\.zip$/);
    assert.equal(res.body.externoErro, null);

    const localFile = path.join(runtimePaths.BACKUPS_DIR, res.body.fileName);
    const externalFile = path.join(res.body.externo.pasta, res.body.externo.fileName);
    for (const file of [localFile, externalFile]) {
        const sidecar = fs.readFileSync(`${file}.sha256`, 'utf8');
        assert.equal(sidecar, `${sha256(file)}  ${path.basename(file)}\n`, 'o .sha256 confere no formato do sha256sum -c');
    }
    const localManifest = JSON.parse(new AdmZip(localFile).readAsText('iclass-backup.json'));
    const externalZip = new AdmZip(externalFile);
    const externalManifest = JSON.parse(externalZip.readAsText('iclass-backup.json'));
    assert.equal(localManifest.variante, 'dados');
    assert.equal(externalManifest.variante, 'completo');
    assert.ok(externalZip.getEntry('data/uploads/apostila.pdf'), 'o completo leva a biblioteca');
    assert.equal(localManifest.banco.sha256, externalManifest.banco.sha256, 'os dois saíram da mesma cópia do banco');

    const state = store.readState();
    assert.equal(state.local.arquivo, res.body.fileName);
    assert.equal(state.local.origem, 'manual');
    assert.equal(state.externo.arquivo, res.body.externo.fileName);
    assert.equal(state.externo.destino, path.resolve(externalRoot));

    const status = await as()('get', '/api/admin/backup/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.configurado, true);
    assert.equal(status.body.local.arquivo, res.body.fileName);
    assert.equal(status.body.externo.arquivo, res.body.externo.fileName);
    assert.equal(status.body.externo.acessivel, true);
    assert.equal(status.body.ultimaFalha, null);
    assert.ok(Date.parse(status.body.proximoAutomatico) > Date.now());
    // Professor vê a situação, não o caminho.
    const profStatus = await as(PROFESSOR)('get', '/api/admin/backup/status');
    assert.equal(profStatus.status, 200);
    assert.equal(profStatus.body.destino, '');
    assert.equal(profStatus.body.pasta, '');
    assert.equal(profStatus.body.configurado, true);

    const created = auditOf('backup_server_created').at(-1);
    assert.equal(created.details.file, res.body.fileName);
    assert.equal(created.details.externo, res.body.externo.fileName);
    // estado.json fica fora do backup.
    assert.equal(new AdmZip(localFile).getEntries().some(entry => /estado\.json/.test(entry.entryName)), false);
});

test('[UC-BACKUP-004] automático: devido com 20 h; adiado com prova em andamento até 48 h; nunca em TEST_MODE na inicialização', async () => {
    await resetState();
    const now = Date.now();
    await store.updateState(state => ({ ...state, local: { ultimoSucesso: new Date(now - 2 * HOUR).toISOString(), arquivo: 'x', origem: 'automatico' } }));
    assert.deepEqual(await backup.runAutomaticIfDue({ now }), { ran: false, reason: 'recent' });

    await store.updateState(state => ({ ...state, local: { ...state.local, ultimoSucesso: new Date(now - 21 * HOUR).toISOString() } }));
    db.memory.examApplications = [{ id: 'app-1', examKey: 'Prova_H4b', studentClass: 'Turma H4b', courseId: 'curso-h4b', status: 'running' }];
    const deferred = await backup.runAutomaticIfDue({ now });
    assert.equal(deferred.reason, 'exam');
    assert.ok(store.readState().adiadoPorProva.desde);
    assert.equal(fs.readdirSync(runtimePaths.BACKUPS_DIR).filter(name => name.endsWith('.zip')).length, 0, 'nada gravado durante a prova');
    const status = backup.backupStatus({ now });
    assert.equal(status.adiadoPorProva.aplicacoes, 1);
    // Com prova em andamento e menos de 48 h, o atraso não vira alerta.
    assert.equal(backup.backupAlerts({ now: now + 6 * HOUR, uptimeMs: 3 * HOUR }).atrasado, null);

    // Passou de 48 h: faz mesmo com a prova.
    await store.updateState(state => ({ ...state, local: { ...state.local, ultimoSucesso: new Date(now - 49 * HOUR).toISOString() } }));
    const forced = await backup.runAutomaticIfDue({ now });
    assert.equal(forced.ran, true);
    assert.match(forced.result.local.name, /^automatico_dados_/);
    assert.equal(store.readState().adiadoPorProva, null);
    const created = auditOf('backup_auto_created').at(-1);
    assert.equal(created.actor, 'sistema');
    assert.equal(created.details.file, forced.result.local.name);

    // A inicialização em TEST_MODE não agenda o backup automático (server.js).
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'server.js'), 'utf8');
    assert.match(source, /if \(process\.env\.TEST_MODE !== '1'\) \{\s*const backupIfDue = async \(\) => \{\s*try \{\s*const outcome = await backupUtil\.runAutomaticIfDue\(\)/);
});

test('[UC-BACKUP-004] destino removido: o local continua, a falha do externo fica no estado, no status e no "Precisa de você" só do administrador', async () => {
    await resetState();
    const destino = fs.mkdtempSync(path.join(externalRoot, 'pendrive-'));
    await as()('post', '/api/admin/backup/config').send({ destino }).expect(200);
    fs.rmSync(destino, { recursive: true, force: true });

    const now = Date.now();
    const outcome = await backup.runAutomaticIfDue({ now });
    assert.equal(outcome.ran, true);
    assert.ok(fs.existsSync(path.join(runtimePaths.BACKUPS_DIR, outcome.result.local.name)), 'o backup local foi feito');
    assert.match(outcome.result.externoErro, /não está acessível/);
    const failure = store.readState().ultimaFalha;
    assert.equal(failure.alvo, 'externo');
    assert.equal(failure.etapa, 'externo');
    assert.equal(failure.destino, destino);
    const failedAudit = auditOf('backup_auto_failed').at(-1);
    assert.equal(failedAudit.actor, 'sistema');
    assert.equal(failedAudit.details.etapa, 'externo');

    const status = await as()('get', '/api/admin/backup/status');
    assert.equal(status.body.ultimaFalha.alvo, 'externo');
    assert.equal(status.body.externo.acessivel, false);

    await withoutTestMode(async () => {
        const items = await queueOf(ADMIN);
        const failed = items.find(item => item.id === 'backup_falhou');
        assert.ok(failed, JSON.stringify(items.map(item => item.id)));
        assert.equal(failed.tone, 'danger');
        assert.equal(failed.href, '/sistema');
        assert.equal(failed.permissao, 'system.manage');
        assert.equal(failed.adiavel, false);
        assert.match(failed.titulo, /cópia externa/);
        assert.equal(items.some(item => item.id === 'backup_externo_atrasado'), false, 'sem item repetido para a mesma falha');
        // Falha não se adia.
        db.memory.admins[0].preferences = { 'dashboard.snoozed': { backup_falhou: Date.now(), backup_sem_destino: Date.now() } };
        assert.ok((await queueOf(ADMIN)).some(item => item.id === 'backup_falhou'));
        db.memory.admins[0].preferences = {};

        const professorItems = await queueOf(PROFESSOR);
        assert.equal(professorItems.some(item => /^backup_/.test(item.id)), false, 'professor não vê alertas de backup');
    });
    // Em TEST_MODE (demonstração e e2e) não há alertas de backup.
    assert.equal((await queueOf(ADMIN)).some(item => /^backup_/.test(item.id)), false);
});

test('[UC-BACKUP-004] itens do painel: atraso, cópia externa atrasada e destino não configurado', () => {
    const base = { memory: { students: [], classes: [], attendance: [], submissions: [] }, cls: null, course: null, students: [], today: '2026-11-11', now: Date.now(), canSeeMatriculas: true };
    const items = computeQueue(base, { backup: { atrasado: { ultimoSucesso: '2026-11-08T08:00:00.000Z', dias: 3 }, externoAtrasado: { ultimoSucesso: null, dias: 1 }, semDestino: { dias: 2 } } });
    const byId = Object.fromEntries(items.map(item => [item.id, item]));
    assert.equal(byId.backup_atrasado.tone, 'danger');
    assert.equal(byId.backup_atrasado.count, 3);
    assert.equal(byId.backup_atrasado.adiavel, false);
    assert.match(byId.backup_atrasado.detalhe, /há 3 dias/);
    assert.equal(byId.backup_externo_atrasado.tone, 'warning');
    assert.equal(byId.backup_sem_destino.tone, 'warning');
    assert.equal(byId.backup_sem_destino.adiavel, undefined, '"sem destino" adia 24 h como os outros');
    assert.equal(computeQueue(base, { backup: null }).some(item => /^backup_/.test(item.id)), false);

    // Carências: servidor recém-ligado (15 min) não acusa atraso.
    const now = Date.now();
    return store.updateState(state => ({ ...state, local: { ultimoSucesso: new Date(now - 30 * HOUR).toISOString() }, ultimaFalha: null })).then(() => {
        db.memory.config.settings.backup = { destino: '', guardarExterno: 14 };
        db.memory.examApplications = [];
        assert.equal(backup.backupAlerts({ now, uptimeMs: 5 * 60000 }).atrasado, null);
        const late = backup.backupAlerts({ now, uptimeMs: HOUR });
        assert.equal(late.atrasado.dias, 1);
        assert.equal(late.semDestino.dias, 1);
    });
});

// ------------------------------------------------------------------ retenção

test('[UC-BACKUP-005] retenção por grupo: 20 automáticos viram 14 (com os JSON antigos), arquivo de fora nunca sai, .bak fica em 30 por arquivo', async () => {
    await resetState();
    const dir = runtimePaths.BACKUPS_DIR;
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    const names = [];
    for (let i = 0; i < 20; i += 1) {
        const name = i < 5 ? `automatico_${stamp(base + i * HOUR)}.json` : `automatico_dados_${stamp(base + i * HOUR)}.zip`;
        fs.writeFileSync(path.join(dir, name), 'x');
        if (name.endsWith('.zip')) fs.writeFileSync(path.join(dir, `${name}.sha256`), 'y');
        names.push(name);
    }
    for (let i = 0; i < 7; i += 1) fs.writeFileSync(path.join(dir, `seguranca-restauracao_dados_${stamp(base + i * HOUR)}.zip`), 'x');
    fs.writeFileSync(path.join(dir, 'automatico_dados_copia-do-alan.zip'), 'meu');
    fs.writeFileSync(path.join(dir, 'notas-importantes.zip'), 'meu');
    const removed = store.applyRetention(dir, { scope: 'local' });
    const left = fs.readdirSync(dir);
    assert.equal(left.filter(name => /^automatico_/.test(name) && /\.(zip|json)$/.test(name) && name !== 'automatico_dados_copia-do-alan.zip').length, 14);
    assert.ok(left.includes(names[19]), 'o mais novo fica');
    names.slice(0, 6).forEach(name => assert.equal(left.includes(name), false, `${name} saiu`));
    assert.equal(left.includes(`${names[5]}.sha256`), false, 'o .sha256 sai junto');
    assert.equal(left.filter(name => name.startsWith('seguranca-restauracao_')).length, 5);
    assert.ok(left.includes('automatico_dados_copia-do-alan.zip') && left.includes('notas-importantes.zip'), 'arquivo fora do padrão nunca é apagado');
    assert.equal(removed.length, 8);

    // Externo: o número escolhido na tela.
    const ext = path.join(externalRoot, 'IClass-teste');
    fs.mkdirSync(ext, { recursive: true });
    for (let i = 0; i < 6; i += 1) fs.writeFileSync(path.join(ext, `automatico_completo_${stamp(base + i * HOUR)}.zip`), 'x');
    store.applyRetention(ext, { scope: 'externo', guardarExterno: 2 });
    assert.equal(fs.readdirSync(ext).length, 2);

    for (let i = 0; i < 35; i += 1) fs.writeFileSync(path.join(dir, `Apostila_1_${stamp(base + i * 60000)}.md.bak`), 'x');
    for (let i = 0; i < 3; i += 1) fs.writeFileSync(path.join(dir, `Outra_${stamp(base + i * 60000)}.md.bak`), 'x');
    store.pruneEditBackups(dir);
    const baks = fs.readdirSync(dir).filter(name => name.endsWith('.bak'));
    assert.equal(baks.filter(name => name.startsWith('Apostila_1_')).length, 30);
    assert.equal(baks.filter(name => name.startsWith('Outra_')).length, 3);
    assert.ok(baks.includes(`Apostila_1_${stamp(base + 34 * 60000)}.md.bak`));
});

test('[UC-BACKUP-005] sobras: .parcial antigo sai no boot e no backup; o recente (gravação em andamento) fica', async () => {
    await resetState();
    const dir = runtimePaths.BACKUPS_DIR;
    const old = path.join(dir, `automatico_dados_${stamp(Date.now() - 3 * HOUR)}.zip.parcial`);
    const fresh = path.join(dir, `manual_dados_${stamp(Date.now())}.zip.parcial`);
    const foreign = path.join(dir, 'meu-arquivo.parcial');
    [old, fresh, foreign].forEach(file => fs.writeFileSync(file, 'pela metade'));
    const past = new Date(Date.now() - 2 * HOUR);
    fs.utimesSync(old, past, past);
    fs.utimesSync(foreign, past, past);
    backup.cleanWorkDirs();
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(fresh), true);
    assert.equal(fs.existsSync(foreign), true, 'arquivo fora do padrão fica');
});

// ------------------------------------------------------------------ lista e download

test('[UC-BACKUP-006] lista do servidor e do destino; baixar pede a senha de novo (bilhete de uso único, preso ao arquivo) e vai para a auditoria', async () => {
    await resetState();
    await as()('post', '/api/admin/backup/config').send({ destino: externalRoot }).expect(200);
    const made = await as()('post', '/api/admin/backup/server').send({});
    assert.equal(made.status, 200);

    const list = await as()('get', '/api/admin/backup/list');
    assert.equal(list.status, 200);
    const servidor = list.body.itens.find(item => item.local === 'servidor');
    const externo = list.body.itens.find(item => item.local === 'externo');
    assert.equal(servidor.nome, made.body.fileName);
    assert.equal(servidor.variante, 'dados');
    assert.equal(servidor.formato, 'zip-2');
    assert.equal(externo.nome, made.body.externo.fileName);
    assert.equal(externo.variante, 'completo');
    assert.ok(servidor.bytes > 0);
    assert.ok(Date.parse(servidor.criadoEm));
    assert.equal(list.body.externoAcessivel, true);
    assert.equal(list.body.itens.some(item => item.nome === 'estado.json'), false);
    await as(PROFESSOR)('get', '/api/admin/backup/list').expect(403);

    const fileUrl = `/api/admin/backup/file?local=servidor&nome=${encodeURIComponent(servidor.nome)}`;
    // Sem bilhete: 403 com passwordRequired (não 401: a sessão continua).
    const noTicket = await as()('get', fileUrl);
    assert.equal(noTicket.status, 403);
    assert.equal(noTicket.body.passwordRequired, true);
    assert.match(noTicket.body.error, /confirme de novo a senha/);
    // Senha errada: 400 no campo password.
    const wrong = await as()('post', '/api/admin/backup/download-ticket').send({ tipo: 'arquivo', local: 'servidor', nome: servidor.nome, password: 'errada' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.field, 'password');
    assert.equal(wrong.body.error, 'Senha incorreta.');
    const empty = await as()('post', '/api/admin/backup/download-ticket').send({ tipo: 'arquivo', local: 'servidor', nome: servidor.nome });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.field, 'password');
    assert.equal((await as()('post', '/api/admin/backup/download-ticket').send({ tipo: 'xpto', password: PASSWORD })).body.field, 'tipo');
    await as(PROFESSOR)('post', '/api/admin/backup/download-ticket').send({ tipo: 'completo', password: PASSWORD }).expect(403);
    assert.equal(db.memory.loginLogs.filter(entry => entry.reason === 'backup_download').length > 0, true, 'a senha errada fica no registro de acesso');

    const ticket = await downloadTicket(app, TOKENS[ADMIN], PASSWORD, { tipo: 'arquivo', local: 'servidor', nome: servidor.nome });
    const downloaded = await binary(as()('get', `${fileUrl}&ticket=${ticket}`));
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers['content-disposition'], new RegExp(`filename="${servidor.nome}"`));
    assert.equal(crypto.createHash('sha256').update(downloaded.body).digest('hex'), sha256(path.join(runtimePaths.BACKUPS_DIR, servidor.nome)));
    const audit = auditOf('backup_downloaded').at(-1);
    assert.equal(audit.details.file, servidor.nome);
    assert.equal(audit.details.local, 'servidor');
    // Uso único.
    assert.equal((await as()('get', `${fileUrl}&ticket=${ticket}`)).status, 403);
    // Bilhete de um arquivo não vale para outro nem para o completo.
    const other = await downloadTicket(app, TOKENS[ADMIN], PASSWORD, { tipo: 'arquivo', local: 'servidor', nome: servidor.nome });
    assert.equal((await as()('get', `/api/admin/backup/file?local=externo&nome=${encodeURIComponent(externo.nome)}&ticket=${other}`)).status, 403);
    assert.equal((await as()('get', `/api/admin/backup/full?ticket=${other}`)).status, 403);

    const extUrl = await ticketUrl(app, TOKENS[ADMIN], PASSWORD, `/api/admin/backup/file?local=externo&nome=${encodeURIComponent(externo.nome)}`);
    const extDownload = await binary(as()('get', extUrl));
    assert.equal(extDownload.status, 200);
    assert.equal(JSON.parse(new AdmZip(extDownload.body).readAsText('iclass-backup.json')).variante, 'completo');

    // Nome fora do padrão ou com caminho: 400, sem tocar no disco.
    for (const nome of ['../x.zip', '../../data/database.db', 'estado.json', `${servidor.nome}/../${servidor.nome}`]) {
        const res = await as()('get', `/api/admin/backup/file?local=servidor&nome=${encodeURIComponent(nome)}`);
        assert.equal(res.status, 400, nome);
    }
    assert.equal((await as()('get', `/api/admin/backup/file?local=outro&nome=${encodeURIComponent(servidor.nome)}`)).status, 400);
    assert.equal((await as()('get', `/api/admin/backup/file?local=servidor&nome=manual_dados_${stamp(Date.now() - HOUR)}.zip`)).status, 404);
});

test('[UC-BACKUP-006] baixar completo, só os dados ou o JSON também pede a senha; variante desconhecida é 400', async () => {
    await resetState();
    const xpto = await as()('get', '/api/admin/backup/full?variante=xpto');
    assert.equal(xpto.status, 400);
    assert.equal(xpto.body.success, false);
    assert.equal(xpto.body.field, 'variante');
    for (const url of ['/api/admin/backup/full', '/api/admin/backup/full?variante=dados', '/api/admin/backup/data']) {
        const refused = await as()('get', url);
        assert.equal(refused.status, 403, url);
        assert.equal(refused.body.passwordRequired, true, url);
    }
    const before = auditOf('backup_downloaded').length;
    const dados = await binary(as()('get', await ticketUrl(app, TOKENS[ADMIN], PASSWORD, '/api/admin/backup/full?variante=dados')));
    assert.equal(dados.status, 200);
    assert.equal(JSON.parse(new AdmZip(dados.body).readAsText('iclass-backup.json')).variante, 'dados');
    const json = await as()('get', await ticketUrl(app, TOKENS[ADMIN], PASSWORD, '/api/admin/backup/data'));
    assert.equal(json.status, 200);
    assert.equal(auditOf('backup_downloaded').length, before + 2);
    // O bilhete dos dados não baixa o completo.
    const dadosTicket = await downloadTicket(app, TOKENS[ADMIN], PASSWORD, { tipo: 'dados' });
    assert.equal((await as()('get', `/api/admin/backup/full?ticket=${dadosTicket}`)).status, 403);
});

// ------------------------------------------------------------------ restaurar da lista

test('[UC-BACKUP-006] restaurar um backup da lista: prévia pelo nome confere o .sha256; o arquivo continua lá depois', async () => {
    await resetState();
    const made = await as()('post', '/api/admin/backup/server').send({});
    const nome = made.body.fileName;
    const file = path.join(runtimePaths.BACKUPS_DIR, nome);
    db.memory.students.push({ name: 'Depois', email: 'depois@h4b.local', status: 'Ativo', classes: [] });
    await db.save();

    for (const body of [{ local: 'servidor', nome: '../x.zip' }, { local: 'servidor', nome: 'estado.json' }, { local: 'lugar', nome }]) {
        const res = await as()('post', '/api/admin/backup/restore/preview').send(body);
        assert.equal(res.status, 400, JSON.stringify(body));
    }
    await as(PROFESSOR)('post', '/api/admin/backup/restore/preview').send({ local: 'servidor', nome }).expect(403);

    // .sha256 que não confere: recusa antes de extrair.
    const sidecar = fs.readFileSync(`${file}.sha256`, 'utf8');
    fs.writeFileSync(`${file}.sha256`, `${'0'.repeat(64)}  ${nome}\n`);
    store.checksumCache.clear();
    const bad = await as()('post', '/api/admin/backup/restore/preview').send({ local: 'servidor', nome });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /soma de verificação/);
    fs.writeFileSync(`${file}.sha256`, sidecar);
    store.checksumCache.clear();

    const preview = await as()('post', '/api/admin/backup/restore/preview').send({ local: 'servidor', nome });
    assert.equal(preview.status, 200, preview.body.error);
    assert.equal(preview.body.arquivo, nome);
    assert.equal(preview.body.integridade.verificada, true);
    // A auditoria é juntada na restauração (decisões §12): a linha diz que a de hoje fica.
    assert.equal(preview.body.contagens.find(row => row.colecao === 'auditLogs').nota, 'mantida e somada à do backup');
    assert.equal(preview.body.contagens.find(row => row.colecao === 'students').nota, undefined);
    const restored = await as()('post', '/api/admin/backup/restore').send({ token: preview.body.token, confirm: 'RESTAURAR' });
    assert.equal(restored.status, 200, restored.body.error);
    assert.equal(db.memory.students.some(item => item.email === 'depois@h4b.local'), false, 'voltou ao backup');
    assert.ok(fs.existsSync(file), 'o backup da lista não é apagado ao restaurar');
    assert.ok(fs.readdirSync(runtimePaths.BACKUPS_DIR).some(name => /^seguranca-restauracao_dados_/.test(name)));
});

// ------------------------------------------------------------------ desligamento

test('[UC-BACKUP-005] desligamento no meio de um backup: espera, interrompe e apaga o .parcial', async () => {
    await resetState();
    const original = archive.saveBackupZip;
    let release;
    const stuck = new Promise(resolve => { release = resolve; });
    let partialPath = null;
    // O trabalho "travado" não segura o processo sozinho (no servidor, a porta e o banco
    // seguram); aqui, um timer mantém o teste vivo enquanto ele espera.
    const keepAlive = setInterval(() => {}, 1000);
    archive.saveBackupZip = async options => {
        partialPath = path.join(options.dir, `${options.name}.parcial`);
        fs.writeFileSync(partialPath, 'pela metade');
        await stuck;
        throw archive.backupAbortedError();
    };
    try {
        // "Fazer backup agora" em andamento quando o servidor começa a desligar.
        const route = as()('post', '/api/admin/backup/server').send({}).then(res => res);
        while (!partialPath) await new Promise(resolve => setTimeout(resolve, 5));
        release();
        const interrupted = await route;
        assert.equal(interrupted.status, 503, 'interrompido pelo desligamento não é erro interno');
        assert.equal(interrupted.body.retryable, true);
        assert.match(interrupted.body.error, /desligado/);
        partialPath = null;
        release = null;
        const stuckAgain = new Promise(resolve => { release = resolve; });
        archive.saveBackupZip = async options => {
            partialPath = path.join(options.dir, `${options.name}.parcial`);
            fs.writeFileSync(partialPath, 'pela metade');
            await stuckAgain;
            throw archive.backupAbortedError();
        };
        const job = backup.runBackupJob({ origem: 'automatico' }).catch(error => error);
        while (!partialPath) await new Promise(resolve => setTimeout(resolve, 5));
        assert.ok(backup.backupInProgress());
        assert.equal((await as()('post', '/api/admin/backup/server').send({})).status, 409);
        const settled = await backup.settleForShutdown({ waitMs: 30, abortWaitMs: 30 });
        assert.deepEqual(settled, { waited: true, aborted: true, finished: false });
        assert.equal(fs.existsSync(partialPath), false, 'o .parcial saiu antes de o processo terminar');
        release();
        const error = await job;
        assert.equal(error.code, 'ICLASS_BACKUP_ABORTED');
        assert.equal(store.readState().ultimaFalha || null, null, 'interrupção pelo desligamento não é falha do backup');
    } finally {
        archive.saveBackupZip = original;
        release();
        clearInterval(keepAlive);
    }
    assert.equal(backup.backupInProgress(), null);
    assert.deepEqual(await backup.settleForShutdown({ waitMs: 10 }), { waited: false, aborted: false, finished: true });

    // A gravação de verdade interrompida pelo sinal não deixa .parcial nem o ZIP.
    const controller = new AbortController();
    controller.abort();
    const workDb = path.join(tempRoot, 'copia.db');
    const dbInfo = await db.snapshotTo(workDb);
    await assert.rejects(archive.saveBackupZip({ dir: runtimePaths.BACKUPS_DIR, name: 'manual_dados_teste.zip', dbInfo, variante: 'dados', origem: 'manual', signal: controller.signal }), { code: 'ICLASS_BACKUP_ABORTED' });
    assert.equal(fs.readdirSync(runtimePaths.BACKUPS_DIR).some(name => name.startsWith('manual_dados_teste')), false);
    fs.rmSync(workDb, { force: true });

    // server.js chama settleForShutdown antes de fechar o banco.
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'server.js'), 'utf8');
    const shutdown = source.slice(source.indexOf('async function performShutdown'));
    assert.ok(shutdown.indexOf('settleForShutdown') > 0 && shutdown.indexOf('settleForShutdown') < shutdown.indexOf('db.close()'));
});
