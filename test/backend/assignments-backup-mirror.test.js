// Espelho das entregas no destino externo e cartão Armazenamento (fase 3, C11 / P1-i;
// FUN-01, D3 e D4 do P1, P-ALAN-1 'A'). Antes deste caso, os arquivos dos trabalhos dos
// alunos (data/entregas, fora de todo ZIP de backup) não tinham cópia nenhuma fora deste
// computador: o backup diário não os levava para o pendrive, a lápide do aluno
// anonimizado não tinha quem a cumprisse, não havia como trazer de volta um arquivo que
// sumiu daqui, o cartão Armazenamento não falava dos trabalhos, a fila não avisava da
// falta de cópia nem do disco quase cheio para os envios, e a prévia da restauração não
// dizia que as entregas de hoje que o backup não tem perdem o registro.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-espelho-entregas-'));
const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-espelho-pendrive-'));
process.env.ICLASS_DATA_DIR = path.join(tempRoot, 'data');
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'cursos_arquivados');
process.env.TEST_MODE = '1';

const AdmZip = require('adm-zip');
const db = require('../../backend/database.js');
const runtimePaths = require('../../backend/runtimePaths.js');
const { createApp } = require('../../backend/server.js');
const backup = require('../../backend/utils/backup.js');
const store = require('../../backend/utils/backupStore.js');
const mirror = require('../../backend/utils/assignmentMirror.js');
const assignmentLifecycle = require('../../backend/utils/assignmentLifecycle.js');
const studentData = require('../../backend/utils/studentDataHandlers.js');
const { computeQueue } = require('../../backend/utils/dashboardAggregates.js');

const ADMIN = 'admin@espelho.local';
const PROFESSOR = 'prof@espelho.local';
const PASSWORD = 'segura-espelho-2026';
const TOKENS = { [ADMIN]: 'token-admin-espelho', [PROFESSOR]: 'token-prof-espelho' };
const COURSE = 'curso-espelho';
const CLASS = '1ESP';
const ANA = 'ana@espelho.local';
const BIA = 'bia@espelho.local';
const MB = 1024 * 1024;
let app;
let seq = 0;

const as = (email = ADMIN) => (method, url) => request(app)[method](url).set('x-admin-session', TOKENS[email]);
const auditOf = action => (db.memory.auditLogs || []).filter(entry => entry.action === action);
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

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

function clearDir(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
}

// Uma entrega com os arquivos gravados em data/entregas (como o envio do aluno deixa).
function addSubmission(email, contents, { assignmentId = 'asg_1_aaaaaa' } = {}) {
    seq += 1;
    const subId = `asub_${seq}_${crypto.randomBytes(3).toString('hex')}`;
    const files = contents.map((content, index) => {
        const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
        const fileId = `f_${crypto.randomBytes(8).toString('hex')}`;
        const storedRel = `entregas/${assignmentId}/${subId}/${fileId}.txt`;
        const abs = path.join(runtimePaths.DATA_DIR, ...storedRel.split('/'));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, buffer);
        return { id: fileId, originalName: `trabalho-${index + 1}.txt`, storedRel, size: buffer.length, sha256: sha(buffer), mime: 'text/plain', ext: '.txt', category: 'code' };
    });
    const now = Date.now();
    const row = {
        id: subId, schemaVersion: 1, assignmentId, courseId: COURSE, studentClass: CLASS, studentEmail: email, studentId: null,
        status: 'enviada', versions: [{ n: 1, requestAt: now, receivedAt: now, late: false, lateMs: 0, text: '', link: '', files, ip: '10.0.0.5', device: 'celular' }],
        extension: null, grade: null, returnedAt: null, returnedBy: '', manualEntry: null, anonymized: false, createdAt: now, updatedAt: now,
    };
    db.memory.assignmentSubmissions.push(row);
    return { row, files };
}

function localPath(storedRel) {
    return path.join(runtimePaths.DATA_DIR, ...storedRel.split('/'));
}

function mirrorPath(destino, storedRel) {
    return path.join(mirror.mirrorDirFor(destino), ...storedRel.split('/').slice(1));
}

async function resetState({ withDestination = true } = {}) {
    const now = Date.now();
    db.memory.admins = [
        { email: ADMIN, name: 'Admin', role: 'admin', password: db.hashPassword(PASSWORD) },
        { email: PROFESSOR, name: 'Prof', role: 'professor', password: db.hashPassword(PASSWORD), additionalPermissions: ['page.system', 'system.manage'] },
    ];
    db.memory.adminSessions = Object.fromEntries(Object.entries(TOKENS).map(([email, token]) => [token, { email, createdAt: now, lastSeen: now }]));
    db.memory.courses = [{ id: COURSE, name: 'Curso do espelho', structure: [] }];
    db.memory.classes = [{ name: CLASS, courseId: COURSE }];
    db.memory.students = [
        { id: 'alu_000000000000e001', name: 'Ana Espelho', email: ANA, status: 'Transferido', statusChangedAt: now, classes: [{ name: CLASS, courseId: COURSE }] },
        { id: 'alu_000000000000e002', name: 'Bia Espelho', email: BIA, status: 'Ativo', classes: [{ name: CLASS, courseId: COURSE }] },
    ];
    db.memory.assignments = [{ id: 'asg_1_aaaaaa', schemaVersion: 1, courseId: COURSE, studentClass: CLASS, title: 'Relatório', status: 'publicada', dueAt: now + 86400000 }];
    db.memory.assignmentSubmissions = [];
    db.memory.assignmentFileTombstones = [];
    db.memory.examApplications = [];
    db.memory.auditLogs = [];
    clearDir(runtimePaths.BACKUPS_DIR);
    clearDir(runtimePaths.ASSIGNMENT_FILES_DIR);
    fs.rmSync(runtimePaths.ARCHIVE_DIR, { recursive: true, force: true });
    clearDir(externalRoot);
    store.checksumCache.clear();
    const destino = withDestination ? fs.mkdtempSync(path.join(externalRoot, 'pendrive-')) : '';
    db.memory.config.settings = { ...(db.memory.config.settings || {}), network: { adminAccess: 'local' }, backup: { destino, guardarExterno: 14 } };
    await db.save();
    return destino;
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

test('[UC-ARMAZENAMENTO-002] backup diário: o espelho copia os trabalhos conferidos pelo SHA-256 e o segundo não copia nada; o ZIP continua sem data/entregas', async () => {
    const destino = await resetState();
    const ana = addSubmission(ANA, ['relatório da Ana', 'segunda parte']);
    const bia = addSubmission(BIA, ['trabalho da Bia']);
    // Arquivo sem registro (depois de restaurar um backup antigo): também vai para o espelho.
    const orphan = path.join(runtimePaths.ASSIGNMENT_FILES_DIR, 'asg_velha', 'asub_velha', 'f_velho.pdf');
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, 'arquivo de antes');
    // .recebendo (envio pela metade) nunca vai.
    fs.mkdirSync(runtimePaths.ASSIGNMENT_RECEIVING_DIR, { recursive: true });
    fs.writeFileSync(path.join(runtimePaths.ASSIGNMENT_RECEIVING_DIR, 'meio.part'), 'pela metade');
    await db.save();

    const result = await backup.runBackupJob({ origem: 'manual' });
    assert.equal(result.espelho.ok, true, JSON.stringify(result.espelho));
    assert.equal(result.espelho.copiados, 4);
    for (const file of [...ana.files, ...bia.files]) {
        const copy = mirrorPath(destino, file.storedRel);
        assert.equal(sha(fs.readFileSync(copy)), file.sha256, copy);
        assert.equal(fs.existsSync(`${copy}${mirror.PARTIAL_SUFFIX}`), false);
    }
    assert.equal(fs.readFileSync(path.join(mirror.mirrorDirFor(destino), 'asg_velha', 'asub_velha', 'f_velho.pdf'), 'utf8'), 'arquivo de antes');
    assert.equal(fs.existsSync(path.join(mirror.mirrorDirFor(destino), '.recebendo')), false);
    const manifest = JSON.parse(fs.readFileSync(path.join(mirror.mirrorDirFor(destino), mirror.MANIFEST_FILE), 'utf8'));
    assert.equal(Object.keys(manifest.arquivos).length, 4);
    assert.equal(manifest.arquivos[ana.files[0].storedRel.slice('entregas/'.length)].sha256, ana.files[0].sha256);
    const espelho = store.readState().espelho;
    assert.equal(espelho.destino, destino);
    assert.ok(espelho.ultimoSucesso);
    assert.equal(espelho.copiados, 4);
    assert.equal(espelho.arquivos, 4);
    const audit = auditOf('assignment_files_mirrored');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].category, 'backup');
    assert.deepEqual(audit[0].details, { copiados: 4, bytes: audit[0].details.bytes, removidosPorLapide: 0 });

    // O ZIP (dados e completo) continua sem a pasta dos trabalhos (contrato C7 do P1).
    for (const file of [result.local.file, result.externo.file]) {
        assert.equal(new AdmZip(file).getEntries().some(entry => /entregas/.test(entry.entryName)), false, file);
    }

    // Segundo backup: nada novo para copiar, nenhum registro novo na auditoria.
    const second = await backup.runBackupJob({ origem: 'manual' });
    assert.equal(second.espelho.ok, true);
    assert.equal(second.espelho.copiados, 0);
    assert.equal(auditOf('assignment_files_mirrored').length, 1, 'sem auditoria quando nada mudou');

    // Cópia danificada no pendrive (tirado no meio): é refeita.
    const damaged = mirrorPath(destino, bia.files[0].storedRel);
    fs.writeFileSync(damaged, 'xx');
    const third = await backup.runBackupJob({ origem: 'manual' });
    assert.equal(third.espelho.copiados, 1);
    assert.equal(sha(fs.readFileSync(damaged)), bia.files[0].sha256);

    // Sem o espelho.json (outro computador, perdido): confere pelo SHA-256 e não recopia.
    fs.rmSync(path.join(mirror.mirrorDirFor(destino), mirror.MANIFEST_FILE));
    const outcome = await mirror.mirrorAssignmentFiles({ destino, memory: db.memory });
    assert.equal(outcome.resumo.copiados, 0);
    assert.equal(outcome.resumo.conferidos, 4);
});

test('[UC-ARMAZENAMENTO-002] lápides: o arquivo do aluno anonimizado sai do espelho e não volta; o da entrega viva fica', async () => {
    const destino = await resetState();
    const ana = addSubmission(ANA, ['trabalho da Ana']);
    const bia = addSubmission(BIA, ['trabalho da Bia']);
    await db.save();
    await backup.runBackupJob({ origem: 'manual' });
    assert.ok(fs.existsSync(mirrorPath(destino, ana.files[0].storedRel)));

    // Anonimizar a Ana: arquivo para a lixeira e lápide (C10).
    const handler = studentData.studentDataHandlers().find(item => item.collection === 'assignmentSubmissions');
    const aluno = studentData.studentDataContext(db.memory, ANA);
    const effects = handler.anonymize(db.memory, aluno, { email: 'anon-1@anonimizado.invalid' });
    for (const effect of [].concat(effects).filter(Boolean)) {
        if (typeof effect === 'function') effect({ deletedBy: ADMIN });
        else { effect.accepted(); effect.afterSave({ deletedBy: ADMIN }); }
    }
    await db.save();
    assert.equal(fs.existsSync(localPath(ana.files[0].storedRel)), false, 'o arquivo foi para a lixeira');
    assert.equal(db.memory.assignmentFileTombstones.length, 1);

    const result = await backup.runBackupJob({ origem: 'manual' });
    assert.equal(result.espelho.removidosPorLapide, 1);
    assert.equal(fs.existsSync(mirrorPath(destino, ana.files[0].storedRel)), false, 'a cópia do anonimizado saiu do pendrive');
    assert.ok(fs.existsSync(mirrorPath(destino, bia.files[0].storedRel)), 'a da Bia fica');
    assert.ok(db.memory.assignmentFileTombstones[0].mirroredRemovalAt, 'a lápide foi cumprida');
    assert.equal(auditOf('assignment_files_mirrored').at(-1).details.removidosPorLapide, 1);
    // Gravada no banco (append alterado em linha antiga: changed).
    const stored = await db.readStoredData();
    assert.ok(stored.memory.assignmentFileTombstones[0].mirroredRemovalAt);

    // O arquivo que não conseguiu ir para a lixeira (preso) e ficou aqui: não volta ao
    // espelho, porque tem lápide e nenhuma entrega viva aponta para ele.
    fs.mkdirSync(path.dirname(localPath(ana.files[0].storedRel)), { recursive: true });
    fs.writeFileSync(localPath(ana.files[0].storedRel), 'trabalho da Ana');
    await backup.runBackupJob({ origem: 'manual' });
    assert.equal(fs.existsSync(mirrorPath(destino, ana.files[0].storedRel)), false);

    // Lápide de um pacote excluído depois que o curso foi restaurado (o arquivo está aqui
    // e a entrega da Bia aponta para ele): a cópia no caminho vivo fica; a do caminho do
    // pacote sai; a lápide espera.
    const archivedRel = `entregas/${assignmentLifecycle.COURSE_ARCHIVE_SEGMENT}/pacote-1/${bia.files[0].storedRel.slice('entregas/'.length)}`;
    const archivedCopy = mirrorPath(destino, archivedRel);
    fs.mkdirSync(path.dirname(archivedCopy), { recursive: true });
    fs.writeFileSync(archivedCopy, 'cópia velha do pacote');
    db.memory.assignmentFileTombstones.push({ fileId: bia.files[0].id, storedRel: bia.files[0].storedRel, reason: 'excluir_curso', at: Date.now(), mirroredRemovalAt: null, archivedRel });
    await db.save();
    await backup.runBackupJob({ origem: 'manual' });
    assert.ok(fs.existsSync(mirrorPath(destino, bia.files[0].storedRel)), 'a entrega viva continua no pendrive');
    assert.equal(fs.existsSync(archivedCopy), false, 'a cópia do pacote saiu');
    assert.equal(db.memory.assignmentFileTombstones.find(item => item.fileId === bia.files[0].id).mirroredRemovalAt, null);

    // Restaurar um backup de antes da anonimização trouxe a entrega original de volta,
    // mas o arquivo está na lixeira: a lápide (merge) vale e o espelho não guarda a cópia.
    fs.rmSync(localPath(ana.files[0].storedRel), { force: true });
    const restoredRow = JSON.parse(JSON.stringify(ana.row));
    db.memory.assignmentSubmissions = db.memory.assignmentSubmissions.filter(item => item.id !== ana.row.id).concat([restoredRow]);
    const copy = mirrorPath(destino, ana.files[0].storedRel);
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, 'trabalho da Ana');
    await backup.runBackupJob({ origem: 'manual' });
    assert.equal(fs.existsSync(copy), false);
    // E "Trazer arquivos" não traz o arquivo com lápide.
    const recovered = await as()('post', '/api/admin/backup/entregas/recuperar').send({});
    assert.equal(recovered.status, 200, recovered.body.error);
    assert.equal(recovered.body.copiados, 0);
    assert.equal(fs.existsSync(localPath(ana.files[0].storedRel)), false);
});

test('[UC-ARMAZENAMENTO-002] trazer arquivos do destino externo: só os registrados que faltam, conferidos pelo SHA-256, sem substituir nada; só o administrador', async () => {
    const destino = await resetState();
    const bia = addSubmission(BIA, ['parte 1', 'parte 2', 'parte 3']);
    await db.save();
    await backup.runBackupJob({ origem: 'manual' });
    const [kept, lost, damaged] = bia.files;
    fs.rmSync(localPath(lost.storedRel));
    fs.rmSync(localPath(damaged.storedRel));
    fs.writeFileSync(mirrorPath(destino, damaged.storedRel), 'adulterado');
    fs.writeFileSync(localPath(kept.storedRel), 'parte 1');
    // Um registrado que nem o espelho tem.
    const ghost = { ...lost, id: 'f_ffffffffffffffff', storedRel: lost.storedRel.replace(lost.id, 'f_ffffffffffffffff') };
    bia.row.versions[0].files.push(ghost);
    await db.save();

    await as(PROFESSOR)('post', '/api/admin/backup/entregas/recuperar').send({}).expect(403);
    const bad = await as()('post', '/api/admin/backup/entregas/recuperar').send([1]);
    assert.equal(bad.status, 400);

    // Sem espaço neste computador (mínimo livre dos envios maior que o disco): recusa
    // antes de copiar qualquer coisa.
    const previousEntregas = db.memory.config.settings.entregas;
    db.memory.config.settings.entregas = { ...(previousEntregas || {}), discoLivreMinimoMb: 1024 * 1024 };
    const full = await as()('post', '/api/admin/backup/entregas/recuperar').send({});
    db.memory.config.settings.entregas = previousEntregas;
    assert.equal(full.status, 409);
    assert.match(full.body.error, /Sem espaço neste computador/);
    assert.equal(fs.existsSync(localPath(lost.storedRel)), false, 'nada copiado sem espaço');

    const res = await as()('post', '/api/admin/backup/entregas/recuperar').send({});
    assert.equal(res.status, 200, res.body.error);
    assert.equal(res.body.copiados, 1);
    assert.equal(res.body.divergentes, 1);
    assert.equal(res.body.faltando, 1);
    assert.equal(res.body.conferidos, 1);
    assert.equal(sha(fs.readFileSync(localPath(lost.storedRel))), lost.sha256);
    assert.equal(fs.existsSync(localPath(damaged.storedRel)), false, 'a cópia adulterada não entra');
    assert.equal(fs.readdirSync(runtimePaths.ASSIGNMENT_RECEIVING_DIR).length, 0, 'sem temporário sobrando');
    const audit = auditOf('assignment_files_recovered').at(-1);
    assert.equal(audit.actor, ADMIN);
    assert.equal(audit.category, 'backup');
    assert.equal(audit.details.copiados, 1);
    assert.equal(audit.details.faltando, 1);

    // Sem destino: 409 com a explicação.
    db.memory.config.settings.backup = { destino: '', guardarExterno: 14 };
    const none = await as()('post', '/api/admin/backup/entregas/recuperar').send({});
    assert.equal(none.status, 409);
    assert.match(none.body.error, /Configure o destino externo/);
    // Destino desconectado: 409.
    const gone = fs.mkdtempSync(path.join(externalRoot, 'sumiu-'));
    db.memory.config.settings.backup = { destino: gone, guardarExterno: 14 };
    fs.rmSync(gone, { recursive: true, force: true });
    const unplugged = await as()('post', '/api/admin/backup/entregas/recuperar').send({});
    assert.equal(unplugged.status, 409);
    assert.match(unplugged.body.error, /não está acessível/);
});

test('[UC-ARMAZENAMENTO-002] sem espaço no destino: o backup vale, o espelho falha com o motivo e a fila avisa só o administrador', async () => {
    const destino = await resetState();
    addSubmission(BIA, ['trabalho grande']);
    await db.save();
    const original = store.freeBytesAt;
    store.freeBytesAt = async dir => (String(dir).includes(`${path.sep}entregas`) ? 10 * MB : original(dir));
    let result;
    try {
        // O automático: a falha do espelho entra na Auditoria com a etapa própria.
        const outcome = await backup.runAutomaticIfDue({ now: Date.now() });
        assert.equal(outcome.ran, true, JSON.stringify(outcome));
        result = outcome.result;
    } finally {
        store.freeBytesAt = original;
    }
    assert.deepEqual(auditOf('backup_auto_failed').map(entry => entry.details.etapa), ['espelho']);
    assert.ok(fs.existsSync(result.local.file), 'o backup local foi feito');
    assert.ok(result.externo && fs.existsSync(result.externo.file), 'a cópia externa do backup também');
    assert.equal(result.espelho.ok, false);
    assert.match(result.espelho.mensagem, /Espaço insuficiente no destino externo para a cópia dos trabalhos/);
    assert.equal(result.espelho.mensagem.includes(destino), false, 'sem o caminho do destino');
    const state = store.readState().espelho;
    assert.match(state.ultimaFalha.mensagem, /Espaço insuficiente/);
    assert.equal(state.ultimaFalha.destino, destino);

    await withoutTestMode(async () => {
        const items = await queueOf(ADMIN);
        const failed = items.find(item => item.id === 'entregas_espelho_falhou');
        assert.ok(failed, JSON.stringify(items.map(item => item.id)));
        assert.equal(failed.tone, 'danger');
        assert.equal(failed.adiavel, false);
        assert.equal(failed.href, '/sistema');
        assert.equal(failed.permissao, 'system.manage');
        assert.equal((await queueOf(PROFESSOR)).some(item => /^entregas_(sem_copia|espelho|disco)/.test(item.id)), false, 'professor não vê');
    });
    // Em TEST_MODE (demonstração e e2e) não há esses alertas.
    assert.equal((await queueOf(ADMIN)).some(item => item.id === 'entregas_espelho_falhou'), false);

    // A falha do "Fazer backup agora" aparece na resposta (sem o caminho para o professor).
    const original2 = store.freeBytesAt;
    store.freeBytesAt = async dir => (String(dir).includes(`${path.sep}entregas`) ? 10 * MB : original2(dir));
    try {
        const prof = await as(PROFESSOR)('post', '/api/admin/backup/server').send({});
        assert.equal(prof.status, 200, prof.body.error);
        assert.equal(prof.body.espelho.ok, false);
        assert.match(prof.body.espelho.erro, /Espaço insuficiente/);
    } finally {
        store.freeBytesAt = original2;
    }

    // Com espaço de novo, o próximo backup copia e a falha sai da fila.
    const ok = await backup.runBackupJob({ origem: 'manual' });
    assert.equal(ok.espelho.ok, true);
    assert.equal(ok.espelho.copiados, 1);
    await withoutTestMode(async () => {
        assert.equal((await queueOf(ADMIN)).some(item => item.id === 'entregas_espelho_falhou'), false);
    });
});

test('[UC-ARMAZENAMENTO-002] destino desconectado: a fila mostra a falha da cópia externa uma vez só; sem destino, avisa que os trabalhos estão só aqui', async () => {
    const destino = await resetState();
    addSubmission(BIA, ['trabalho']);
    await db.save();
    fs.rmSync(destino, { recursive: true, force: true });
    const outcome = await backup.runAutomaticIfDue({ now: Date.now() });
    assert.equal(outcome.ran, true, JSON.stringify(outcome));
    const result = outcome.result;
    assert.match(result.externoErro, /não está acessível/);
    // Uma entrada de falha na Auditoria (a da cópia externa), não duas pela mesma causa.
    assert.deepEqual(auditOf('backup_auto_failed').map(entry => entry.details.etapa), ['externo']);
    assert.equal(result.espelho.ok, false);
    assert.match(result.espelho.mensagem, /não está acessível/);
    await withoutTestMode(async () => {
        const ids = (await queueOf(ADMIN)).map(item => item.id);
        assert.ok(ids.includes('backup_falhou'), ids.join(','));
        assert.equal(ids.includes('entregas_espelho_falhou'), false, 'o mesmo destino não vira dois avisos');
    });

    await resetState({ withDestination: false });
    addSubmission(BIA, ['um', 'dois']);
    await db.save();
    // Sem destino, a mesma causa vira um item só: o "Backup só neste computador" passa a
    // falar também dos trabalhos (antes saíam backup_sem_destino e entregas_sem_copia).
    await withoutTestMode(async () => {
        const items = await queueOf(ADMIN);
        assert.equal(items.some(entry => entry.id === 'entregas_sem_copia'), false, JSON.stringify(items.map(entry => entry.id)));
        const item = items.find(entry => entry.id === 'backup_sem_destino');
        assert.ok(item);
        assert.equal(item.tone, 'warning');
        assert.equal(item.titulo, 'Backup e trabalhos dos alunos só neste computador');
        assert.match(item.detalhe, /Os trabalhos dos alunos \(2 arquivos, 1 KB\) também não têm cópia fora daqui/);
    });
    // Sem o bloco do backup (só o das entregas), o item próprio aparece, com o tamanho em KB
    // (272 bytes não viram "1 MB").
    const base = { memory: { students: [], classes: [], attendance: [], submissions: [] }, cls: null, course: null, students: [], today: '2026-11-23', now: Date.now(), canSeeMatriculas: true };
    const own = computeQueue(base, { entregas: { semCopia: { arquivos: 1, bytes: 272 } } }).find(entry => entry.id === 'entregas_sem_copia');
    assert.ok(own);
    assert.match(own.titulo, /Trabalhos dos alunos sem cópia fora deste computador/);
    assert.match(own.detalhe, /^1 arquivo \(1 KB\) só neste computador/);
    const merged = computeQueue(base, { backup: { semDestino: { dias: 1 } }, entregas: { semCopia: { arquivos: 3, bytes: 5 * MB } } });
    assert.deepEqual(merged.filter(entry => /sem_destino|sem_copia/.test(entry.id)).map(entry => entry.id), ['backup_sem_destino']);
    assert.match(merged.find(entry => entry.id === 'backup_sem_destino').detalhe, /3 arquivos, 5 MB/);
    assert.equal(computeQueue(base, { backup: { semDestino: { dias: 1 } } }).find(entry => entry.id === 'backup_sem_destino').titulo, 'Backup só neste computador');
});

test('[UC-ARMAZENAMENTO-002] pouco espaço no disco para os envios: aviso antes e alerta que não se adia quando já recusa', async () => {
    await resetState();
    db.memory.config.settings.entregas = { discoLivreMinimoMb: 2048 };
    const low = await mirror.queueAlerts(db.memory, { statfs: async () => ({ bavail: 3 * 1024, bsize: MB }) });
    assert.equal(low.discoBaixo.recusando, false);
    const full = await mirror.queueAlerts(db.memory, { statfs: async () => ({ bavail: 1024, bsize: MB }) });
    assert.equal(full.discoBaixo.recusando, true);
    const plenty = await mirror.queueAlerts(db.memory, { statfs: async () => ({ bavail: 100 * 1024, bsize: MB }) });
    assert.equal(plenty.discoBaixo, null);

    const base = { memory: { students: [], classes: [], attendance: [], submissions: [] }, cls: null, course: null, students: [], today: '2026-11-23', now: Date.now(), canSeeMatriculas: true };
    const warn = computeQueue(base, { entregas: low }).find(item => item.id === 'entregas_disco_baixo');
    assert.equal(warn.tone, 'warning');
    assert.equal(warn.adiavel, undefined);
    assert.match(warn.titulo, /Pouco espaço no disco/);
    assert.match(warn.detalhe, /3 GB livres; abaixo de 2 GB os envios são recusados/);
    const danger = computeQueue(base, { entregas: full }).find(item => item.id === 'entregas_disco_baixo');
    assert.equal(danger.tone, 'danger');
    assert.equal(danger.adiavel, false);
    assert.match(danger.titulo, /os alunos não conseguem enviar/);
    assert.equal(computeQueue(base, { entregas: null }).some(item => /^entregas_/.test(item.id)), false);
});

test('[UC-ARMAZENAMENTO-002] cartão Armazenamento: tamanho, sem registro, faltando, cópia pendente; o curso excluído conta como registrado', async () => {
    const destino = await resetState();
    const bia = addSubmission(BIA, ['aaaa', 'bbbbbb']);
    const orphan = path.join(runtimePaths.ASSIGNMENT_FILES_DIR, 'asg_velha', 'asub_velha', 'f_velho.pdf');
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, '1234567890');
    // Arquivo de curso excluído de vez: registrado no pacote (curso.json), em _cursos_arquivados.
    const archived = path.join(runtimePaths.ASSIGNMENT_FILES_DIR, assignmentLifecycle.COURSE_ARCHIVE_SEGMENT, 'pacote-1', 'asg_9_bbbbbb', 'asub_9_bbbbbb', 'f_aaaaaaaaaaaaaaaa.txt');
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    fs.writeFileSync(archived, 'do curso');
    fs.mkdirSync(path.join(runtimePaths.ARCHIVE_DIR, 'pacote-1'), { recursive: true });
    fs.writeFileSync(path.join(runtimePaths.ARCHIVE_DIR, 'pacote-1', 'manifesto.json'), JSON.stringify({ counts: { tarefas: 1, entregas: 1 } }));
    fs.writeFileSync(path.join(runtimePaths.ARCHIVE_DIR, 'pacote-1', 'curso.json'), JSON.stringify({ assignmentSubmissions: [{ id: 'asub_9_bbbbbb', assignmentId: 'asg_9_bbbbbb', studentEmail: BIA, versions: [{ n: 1, files: [{ id: 'f_aaaaaaaaaaaaaaaa', storedRel: 'entregas/asg_9_bbbbbb/asub_9_bbbbbb/f_aaaaaaaaaaaaaaaa.txt', size: 8, sha256: sha(Buffer.from('do curso')) }] }] }] }));
    fs.rmSync(localPath(bia.files[1].storedRel));
    await db.save();

    const before = await as()('get', '/api/admin/storage');
    assert.equal(before.status, 200);
    const entregas = before.body.entregas;
    assert.equal(entregas.arquivos, 3);
    assert.equal(entregas.bytes, 4 + 10 + 8);
    assert.equal(entregas.semRegistro, 1);
    assert.equal(entregas.semRegistroBytes, 10);
    assert.equal(entregas.faltando, 1);
    assert.equal(entregas.espelho.configurado, true);
    assert.equal(entregas.espelho.acessivel, true);
    assert.equal(entregas.espelho.ultimoSucesso, null);
    assert.equal(entregas.espelho.pendentes, 3);
    assert.equal(entregas.podeRecuperar, true);
    assert.equal(JSON.stringify(before.body).includes(destino), false, 'o cartão não traz o caminho do destino');

    await backup.runBackupJob({ origem: 'manual' });
    assert.ok(fs.existsSync(path.join(mirror.mirrorDirFor(destino), assignmentLifecycle.COURSE_ARCHIVE_SEGMENT, 'pacote-1', 'asg_9_bbbbbb', 'asub_9_bbbbbb', 'f_aaaaaaaaaaaaaaaa.txt')), 'o arquivo do curso excluído também vai para o espelho');
    const after = await as()('get', '/api/admin/storage');
    assert.equal(after.body.entregas.espelho.pendentes, 0);
    assert.ok(after.body.entregas.espelho.ultimoSucesso);
    assert.equal(after.body.entregas.espelho.arquivos, 3);
    addSubmission(BIA, ['novo']);
    await db.save();
    assert.equal((await as()('get', '/api/admin/storage')).body.entregas.espelho.pendentes, 1);

    const prof = await as(PROFESSOR)('get', '/api/admin/storage');
    assert.equal(prof.status, 200);
    assert.equal(prof.body.entregas.podeRecuperar, false);
});

test('[UC-ARMAZENAMENTO-002] prévia da restauração avisa das tarefas e entregas de hoje que o backup não tem; os arquivos ficam', async () => {
    await resetState();
    addSubmission(BIA, ['antes']);
    await db.save();
    const made = await as()('post', '/api/admin/backup/server').send({});
    assert.equal(made.status, 200, made.body.error);
    const nome = made.body.fileName;
    const later = addSubmission(ANA, ['depois do backup']);
    db.memory.assignments.push({ id: 'asg_2_cccccc', schemaVersion: 1, courseId: COURSE, studentClass: CLASS, title: 'Outra', status: 'rascunho' });
    db.memory.assignmentSubmissions[0].versions.push({ ...db.memory.assignmentSubmissions[0].versions[0], n: 2 });
    await db.save();

    const res = await as()('post', '/api/admin/backup/restore/preview').send({ local: 'servidor', nome });
    assert.equal(res.status, 200, res.body.error);
    assert.deepEqual({ tarefas: res.body.entregas.tarefas, entregas: res.body.entregas.entregas, envios: res.body.entregas.envios }, { tarefas: 1, entregas: 1, envios: 1 });
    const aviso = res.body.avisos.find(text => /Hoje há/.test(text));
    assert.ok(aviso, JSON.stringify(res.body.avisos));
    assert.match(aviso, /Hoje há 1 tarefa e 1 entrega de aluno que não estão neste backup, e 1 envio feito depois dele/);
    assert.match(aviso, /continuam neste computador/);
    assert.ok(fs.existsSync(localPath(later.files[0].storedRel)));

    // Backup de antes das tarefas (sem as coleções): ficam como estão; nada a avisar aqui.
    assert.equal(mirror.restorePreviewNotice({ students: [] }, db.memory), null);
    // Backup igual ao de hoje: nada a avisar.
    assert.equal(mirror.restorePreviewNotice({ assignments: db.memory.assignments, assignmentSubmissions: db.memory.assignmentSubmissions }, db.memory), null);
});

test('[UC-ARMAZENAMENTO-002] desligamento no meio: o espelho para, o que já foi copiado fica anotado e nada vira falha', async () => {
    const destino = await resetState();
    addSubmission(BIA, ['um', 'dois']);
    await db.save();
    const controller = new AbortController();
    controller.abort();
    const step = await mirror.runMirrorStep({ job: { controller }, destino, memory: db.memory, failureMessage: backup.failureMessage });
    assert.equal(step.ok, false);
    assert.equal(step.interrompido, true);
    assert.equal(store.readState().espelho, undefined, 'interrupção não é falha do destino');
    await assert.rejects(mirror.mirrorAssignmentFiles({ destino, memory: db.memory, signal: controller.signal }), error => error.code === 'ICLASS_BACKUP_ABORTED');
    assert.equal(fs.readdirSync(mirror.mirrorDirFor(destino)).filter(name => name.endsWith(mirror.PARTIAL_SUFFIX)).length, 0);
});

// Rodada de ajuste 1 do C11 (verificação V2): curso restaurado cujo pacote que sobrou foi
// excluído depois. A exclusão do pacote mandou para a lixeira o arquivo de uma entrega que
// continua viva no banco e gravou a lápide 'excluir_curso' (o bug do C10, aberto até a J2).
// Antes, o espelho apagava a única cópia externa dessa entrega (o arquivo não estava mais
// aqui), o cartão não a contava como faltando e "Trazer arquivos" não a trazia.
test('[UC-ARMAZENAMENTO-002] lápide de pacote de curso excluído não apaga a cópia de uma entrega viva do banco; o cartão conta e "Trazer arquivos" traz', async () => {
    const destino = await resetState();
    const bia = addSubmission(BIA, ['trabalho da Bia, entrega viva']);
    const ana = addSubmission(ANA, ['trabalho da Ana, só no pacote']);
    await db.save();
    await backup.runBackupJob({ origem: 'manual' });
    const [live] = bia.files;
    const copy = mirrorPath(destino, live.storedRel);
    assert.ok(fs.existsSync(copy));
    const archivedRel = rel => `entregas/${assignmentLifecycle.COURSE_ARCHIVE_SEGMENT}/pacote-1/${rel.slice('entregas/'.length)}`;
    // A cópia do caminho do pacote (de um espelhamento enquanto o curso estava excluído).
    const archivedCopy = mirrorPath(destino, archivedRel(live.storedRel));
    fs.mkdirSync(path.dirname(archivedCopy), { recursive: true });
    fs.copyFileSync(copy, archivedCopy);
    // O pacote excluído: arquivo da entrega viva na lixeira, lápides 'excluir_curso'. A da
    // Ana é de uma entrega que não está mais no banco (só no pacote): essa vale.
    fs.rmSync(localPath(live.storedRel));
    fs.rmSync(localPath(ana.files[0].storedRel));
    db.memory.assignmentSubmissions = db.memory.assignmentSubmissions.filter(item => item.id !== ana.row.id);
    const at = Date.now();
    db.memory.assignmentFileTombstones.push(
        { fileId: live.id, storedRel: live.storedRel, reason: 'excluir_curso', at, mirroredRemovalAt: null, archivedRel: archivedRel(live.storedRel) },
        { fileId: ana.files[0].id, storedRel: ana.files[0].storedRel, reason: 'excluir_curso', at, mirroredRemovalAt: null, archivedRel: archivedRel(ana.files[0].storedRel) },
    );
    await db.save();

    const result = await backup.runBackupJob({ origem: 'manual' });
    assert.equal(result.espelho.ok, true, JSON.stringify(result.espelho));
    assert.ok(fs.existsSync(copy), 'a cópia da entrega viva fica no pendrive');
    assert.equal(fs.existsSync(archivedCopy), false, 'a cópia do caminho do pacote sai');
    assert.equal(fs.existsSync(mirrorPath(destino, ana.files[0].storedRel)), false, 'a da entrega que só estava no pacote sai');
    const tombs = Object.fromEntries(db.memory.assignmentFileTombstones.map(item => [item.fileId, item.mirroredRemovalAt]));
    assert.equal(tombs[live.id], null, 'a lápide do caminho vivo espera');
    assert.ok(tombs[ana.files[0].id], 'a outra foi cumprida');

    // O cartão mostra o arquivo que falta aqui (antes: faltando 0, perda invisível).
    const card = await as()('get', '/api/admin/storage');
    assert.equal(card.body.entregas.faltando, 1);
    // "Trazer arquivos" traz de volta, conferido pelo SHA-256 do registro.
    const recovered = await as()('post', '/api/admin/backup/entregas/recuperar').send({});
    assert.equal(recovered.status, 200, recovered.body.error);
    assert.equal(recovered.body.copiados, 1);
    assert.equal(sha(fs.readFileSync(localPath(live.storedRel))), live.sha256);
    assert.equal(fs.existsSync(localPath(ana.files[0].storedRel)), false, 'a da entrega que não está no banco não volta');
    assert.equal((await as()('get', '/api/admin/storage')).body.entregas.faltando, 0);

    // A entrega viva é anonimizada depois: o arquivo sai do registro e a lápide (a mesma,
    // 'excluir_curso') passa a valer; a cópia sai do pendrive.
    const handler = studentData.studentDataHandlers().find(item => item.collection === 'assignmentSubmissions');
    const effects = handler.anonymize(db.memory, studentData.studentDataContext(db.memory, BIA), { email: 'anon-2@anonimizado.invalid' });
    for (const effect of [].concat(effects).filter(Boolean)) {
        if (typeof effect === 'function') effect({ deletedBy: ADMIN });
        else { effect.accepted(); effect.afterSave({ deletedBy: ADMIN }); }
    }
    await db.save();
    await backup.runBackupJob({ origem: 'manual' });
    assert.equal(fs.existsSync(copy), false, 'anonimizada, a cópia sai');
});

// Rodada de ajuste 1 do C11 (verificação V3): no computador novo (no Windows, outro nome,
// DESKTOP-XXXX), "Trazer arquivos" procurava só em <destino>/IClass-<este computador> e
// respondia que os arquivos não estavam no destino, embora estivessem na pasta do de antes.
test('[UC-ARMAZENAMENTO-002] computador trocado: "Trazer arquivos" acha a cópia na pasta do computador de antes, conferida pelo SHA-256', async () => {
    const destino = await resetState();
    const bia = addSubmission(BIA, ['parte A', 'parte B', 'parte C']);
    await db.save();
    await backup.runBackupJob({ origem: 'manual' });
    const [good, damaged, noHash] = bia.files;
    // O espelho foi feito pelo computador velho; o novo tem outro nome.
    const own = store.externalDir(destino);
    const oldDir = path.join(destino, 'IClass-COMPUTADOR-VELHO', mirror.MIRROR_SEGMENT);
    fs.mkdirSync(path.dirname(oldDir), { recursive: true });
    fs.renameSync(mirror.mirrorDirFor(destino), oldDir);
    fs.rmSync(own, { recursive: true, force: true });
    // Outra pasta, de um terceiro computador, com uma cópia adulterada do mesmo tamanho.
    const thirdDir = path.join(destino, 'IClass-OUTRO', mirror.MIRROR_SEGMENT);
    const thirdCopy = path.join(thirdDir, ...damaged.storedRel.split('/').slice(1));
    fs.mkdirSync(path.dirname(thirdCopy), { recursive: true });
    fs.writeFileSync(thirdCopy, 'parte X');
    // A cópia do velho do segundo arquivo também está adulterada (mesmo tamanho).
    fs.writeFileSync(path.join(oldDir, ...damaged.storedRel.split('/').slice(1)), 'parte Y');
    // Registro sem SHA-256: de outro computador, não se traz (não há como conferir).
    noHash.sha256 = '';
    for (const file of bia.files) fs.rmSync(localPath(file.storedRel));
    // Uma pasta qualquer com nome estranho no destino é ignorada.
    fs.mkdirSync(path.join(destino, 'Fotos', mirror.MIRROR_SEGMENT), { recursive: true });
    await db.save();

    const card = await as()('get', '/api/admin/storage');
    assert.equal(card.body.entregas.faltando, 3);
    const res = await as()('post', '/api/admin/backup/entregas/recuperar').send({});
    assert.equal(res.status, 200, res.body.error);
    assert.equal(res.body.copiados, 1, JSON.stringify(res.body));
    assert.equal(res.body.deOutroComputador, 1);
    assert.equal(res.body.divergentes, 1);
    assert.equal(res.body.faltando, 1, 'o sem SHA-256 não vem de outro computador');
    assert.equal(sha(fs.readFileSync(localPath(good.storedRel))), good.sha256);
    assert.equal(fs.existsSync(localPath(damaged.storedRel)), false, 'nenhuma das cópias adulteradas entra');
    assert.equal(fs.existsSync(localPath(noHash.storedRel)), false);
    assert.equal(auditOf('assignment_files_recovered').at(-1).details.deOutroComputador, 1);
    // O próximo backup copia o que voltou para a pasta deste computador.
    const next = await backup.runBackupJob({ origem: 'manual' });
    assert.equal(next.espelho.ok, true);
    assert.equal(sha(fs.readFileSync(mirrorPath(destino, good.storedRel))), good.sha256);
});

// Rodada de ajuste 1 do C11 (verificação V4): a cópia estragada no pendrive com o MESMO
// tamanho (um byte trocado) não era percebida: com o arquivo no espelho.json, só o tamanho
// era comparado, e o cartão dizia "Em dia" para sempre.
test('[UC-ARMAZENAMENTO-002] cópia estragada com o mesmo tamanho é refeita: mexida no destino (outra data) ou pela releitura de rodízio', async () => {
    const destino = await resetState();
    const bia = addSubmission(BIA, ['conteúdo original do trabalho 1', 'conteúdo original do trabalho 2']);
    await db.save();
    await backup.runBackupJob({ origem: 'manual' });
    const [first, second] = bia.files;
    const manifestFile = path.join(mirror.mirrorDirFor(destino), mirror.MANIFEST_FILE);
    const entry = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).arquivos[first.storedRel.slice('entregas/'.length)];
    assert.ok(Number.isInteger(entry.mtimeMs), 'o espelho.json guarda a data de gravação da cópia');
    assert.ok(entry.conferidoEm);

    // 1. Byte trocado (outra data de gravação no destino): conferida e refeita.
    const copy1 = mirrorPath(destino, first.storedRel);
    const buffer = fs.readFileSync(copy1);
    buffer[3] ^= 0xff;
    fs.writeFileSync(copy1, buffer);
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(copy1, future, future);
    const fixed = await backup.runBackupJob({ origem: 'manual' });
    assert.equal(fixed.espelho.copiados, 1, JSON.stringify(fixed.espelho));
    assert.equal(sha(fs.readFileSync(copy1)), first.sha256);

    // 2. Byte trocado sem mudar a data (pendrive que estraga aos poucos): a releitura de
    // rodízio confere as cópias e refaz a estragada.
    const copy2 = mirrorPath(destino, second.storedRel);
    const before = fs.statSync(copy2);
    const buffer2 = fs.readFileSync(copy2);
    buffer2[5] ^= 0xff;
    fs.writeFileSync(copy2, buffer2);
    fs.utimesSync(copy2, before.atime, before.mtime);
    const outcome = await mirror.mirrorAssignmentFiles({ destino, memory: db.memory });
    assert.equal(outcome.resumo.corrigidos, 1);
    assert.equal(sha(fs.readFileSync(copy2)), second.sha256);
    // Com tudo certo, nada é copiado de novo.
    const again = await backup.runBackupJob({ origem: 'manual' });
    assert.equal(again.espelho.copiados, 0);
    assert.equal(auditOf('assignment_files_mirrored').at(-1).details.copiados, 1, 'sem auditoria nova quando nada mudou');
});

// Rodada de ajuste 1 do C11: a falta de espaço dizia "faltam copiar cerca de 65 MB" para
// um arquivo de 272 bytes (somava a folga de 64 MB ao que falta copiar).
test('[UC-ARMAZENAMENTO-002] sem espaço no destino: a mensagem separa o que falta copiar da folga', async () => {
    const destino = await resetState();
    addSubmission(BIA, [Buffer.alloc(272, 0x41)]);
    await db.save();
    const original = store.freeBytesAt;
    store.freeBytesAt = async dir => (String(dir).includes(`${path.sep}entregas`) ? 10 * MB : original(dir));
    try {
        await assert.rejects(mirror.mirrorAssignmentFiles({ destino, memory: db.memory }), error => {
            assert.equal(error.code, 'ENOSPC_DESTINO');
            assert.match(error.message, /faltam copiar cerca de 1 KB \(1 arquivo\), o destino precisa ficar com uma folga de 64 MB e há 10 MB livres/);
            return true;
        });
    } finally {
        store.freeBytesAt = original;
    }
});
