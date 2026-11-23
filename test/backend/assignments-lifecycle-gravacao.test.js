// Anonimizar e apagar de vez com o arquivo do banco travado (fase 3, C10 ajuste 2; FUN-01,
// D4 e D14 do P1). Outro programa segura a escrita do database.db: a rota responde 503
// "tente de novo" e nada sai do lugar na hora. A memória já mudou, e a regravação em
// segundo plano do dbWriter a leva ao disco quando a trava sai; logo depois desse COMMIT
// os arquivos das entregas vão para a lixeira e o pacote do curso excluído é regravado.
// Antes, esses efeitos se perdiam: a nova tentativa recebia 409 "já está anonimizado"
// (ou 404 no apagar), o arquivo ficava em data/entregas, fora da lixeira, e restaurar o
// curso trazia de volta o e-mail, o texto e o nome do arquivo.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const sqlite3 = require('sqlite3');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-assignments-lifecycle-gravacao-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';
// Trava longa vira 503 em cerca de 1 s (o padrão é 5 s).
process.env.ICLASS_DB_BUSY_TIMEOUT_MS = '1000';

const db = require('../../backend/database.js');
const runtimePaths = require('../../backend/runtimePaths.js');
const assignments = require('../../backend/utils/assignments.js');
const assignmentFiles = require('../../backend/utils/assignmentFiles.js');
const fileStore = require('../../backend/utils/storage.js');
const assignmentLifecycle = require('../../backend/utils/assignmentLifecycle.js');
const { createAdminSession } = require('../../backend/utils/authSessions.js');
const { createApp } = require('../../backend/server.js');

const COURSE = 'curso-trava';
const OTHER = 'curso-fica';
const HOUR = 60 * 60 * 1000;
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(256, 0x20), Buffer.from('\n%%EOF\n')]);
const WRITE_ERROR = 'Não foi possível gravar os dados agora. Tente de novo em alguns segundos.';
let app;
let adminToken;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const asAdmin = req => req.set('x-admin-session', adminToken);

function exec(connection, sql) {
    return new Promise((resolve, reject) => connection.exec(sql, err => (err ? reject(err) : resolve())));
}

// Outro programa segurando a escrita do arquivo (BEGIN IMMEDIATE).
async function holdWriteLock() {
    const connection = new sqlite3.Database(path.join(tempRoot, 'database.db'));
    await exec(connection, 'BEGIN IMMEDIATE');
    let released = false;
    return async () => {
        if (released) return;
        released = true;
        await exec(connection, 'COMMIT');
        await new Promise(resolve => connection.close(() => resolve()));
    };
}

async function waitFor(check, timeoutMs, label) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (await check()) return;
        await wait(100);
    }
    assert.fail(`${label}: não aconteceu em ${timeoutMs} ms`);
}

function addSubmission(task, email, mark) {
    const student = db.memory.students.find(item => item.email === email);
    const sub = assignments.newSubmissionRecord(task, student, { now: Date.now() - 2 * HOUR });
    const id = assignmentFiles.newFileId();
    const storedRel = assignmentFiles.storedRelFor(task.id, sub.id, id, '.pdf');
    const abs = assignmentFiles.absFromStoredRel(storedRel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, PDF);
    sub.versions = [{ n: 1, requestAt: Date.now() - HOUR, receivedAt: Date.now() - HOUR, late: false, lateMs: 0, text: `TXT_${mark}`, link: '', files: [{ id, originalName: `ARQ_${mark}.pdf`, storedRel, size: PDF.length, sha256: crypto.createHash('sha256').update(PDF).digest('hex'), mime: 'application/pdf', ext: '.pdf', category: 'pdf' }], ip: '10.0.0.9', device: 'Celular' }];
    sub.status = 'enviada';
    db.memory.assignmentSubmissions.push(sub);
    return sub;
}

function newTask(courseId, studentClass) {
    const task = assignments.newAssignmentRecord({ courseId, studentClass, title: 'Relatório', response: { files: true, text: true, link: false }, files: { maxFiles: 2, maxSizeMb: 2, types: ['pdf'], extraExtensions: [] }, dueAt: Date.now() + 3 * 24 * HOUR, status: 'publicada' }, { actor: 'adm@trava.local', now: Date.now() - 24 * HOUR });
    db.memory.assignments.push(task);
    return task;
}

const onDisk = file => fs.existsSync(assignmentFiles.absFromStoredRel(file.storedRel));

test.before(async () => {
    await db.init();
    app = createApp();
});

test.after(async () => {
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

for (const mode of ['anonymize', 'purge']) {
    test(`[UC-ENCERRADOS-002] ${mode} com o banco travado: 503, nada sai do lugar; quando a trava sai, os arquivos vão para a lixeira e o pacote do curso fica sem o dado`, async () => {
        const both = [{ name: '1TRV', courseId: COURSE }, { name: '2FIC', courseId: OTHER }];
        db.memory.courses = [{ id: COURSE, name: 'Curso travado', structure: [] }, { id: OTHER, name: 'Curso que fica', structure: [] }];
        db.memory.classes = [{ name: '1TRV', courseId: COURSE, period: 'Manhã' }, { name: '2FIC', courseId: OTHER, period: 'Tarde' }];
        db.memory.students = [{ id: 'alu_000000000000d4d4', name: 'Duda Reis', email: 'duda@trava.local', matricula: 'MT-1', status: 'Ativo', password: db.hashPassword('Senha-forte-123'), classes: both }];
        db.memory.admins = [{ email: 'adm@trava.local', name: 'Adm', role: 'admin', password: db.hashPassword('Senha-forte-2026') }];
        db.memory.assignments = [];
        db.memory.assignmentSubmissions = [];
        db.memory.assignmentFileTombstones = [];
        db.memory.auditLogs = [];
        adminToken = createAdminSession(db.memory, 'adm@trava.local');
        fs.rmSync(runtimePaths.ASSIGNMENT_FILES_DIR, { recursive: true, force: true });
        fs.rmSync(fileStore.LIXEIRA_DIR, { recursive: true, force: true });
        fs.rmSync(runtimePaths.ARCHIVE_DIR, { recursive: true, force: true });
        const archivedSub = addSubmission(newTask(COURSE, '1TRV'), 'duda@trava.local', 'ARQUIVADA');
        const liveSub = addSubmission(newTask(OTHER, '2FIC'), 'duda@trava.local', 'VIVA');
        liveSub.courseId = OTHER;
        liveSub.studentClass = '2FIC';
        await db.save();
        const archived = await asAdmin(request(app).post(`/api/admin/courses/${COURSE}/purge`)).send({});
        assert.equal(archived.status, 200, JSON.stringify(archived.body));
        const folder = archived.body.folder;
        const bundleFile = path.join(runtimePaths.ARCHIVE_DIR, folder, 'curso.json');
        const student = db.memory.students[0];
        student.status = 'Transferido';
        student.statusChangedAt = Date.now() - HOUR;
        await db.save();
        const bundleBefore = fs.readFileSync(bundleFile, 'utf8');
        assert.equal(bundleBefore.includes('TXT_ARQUIVADA'), true);

        const release = await holdWriteLock();
        try {
            const res = await asAdmin(request(app).post(`/api/admin/students/${mode}`))
                .timeout(8000)
                .send({ email: 'duda@trava.local', confirm: mode === 'anonymize' ? 'ANONIMIZAR' : 'APAGAR', reason: 'Pedido da família' });
            assert.equal(res.status, 503, JSON.stringify(res.body));
            assert.equal(res.body.retryable, true);
            assert.equal(res.body.error, WRITE_ERROR);
            // Na hora, nada mudou no disco.
            liveSub.versions[0].files.forEach(file => assert.equal(onDisk(file), true));
            assert.equal(fs.readFileSync(bundleFile, 'utf8'), bundleBefore);
            assert.equal(fileStore.listTrash().filter(item => /^entregas\//.test(item.originalRel)).length, 0);
        } finally {
            await release();
        }
        // A regravação em segundo plano (sem novo pedido) leva a memória ao disco e os
        // efeitos rodam logo depois.
        await waitFor(() => db.storageStatus().pendingRetry === false && !fs.readFileSync(bundleFile, 'utf8').includes('TXT_ARQUIVADA'), 12000, 'regravação e efeitos');
        liveSub.versions[0].files.forEach(file => assert.equal(onDisk(file), false));
        const trash = fileStore.listTrash().filter(item => item.name === liveSub.id || item.name === archivedSub.id);
        assert.equal(trash.length, 2);
        trash.forEach(item => assert.equal(fileStore.isAdminOnlyTrashEntry(item), true));
        const bundleText = fs.readFileSync(bundleFile, 'utf8');
        ['TXT_ARQUIVADA', 'ARQ_ARQUIVADA', 'duda@trava.local'].forEach(piece => assert.equal(bundleText.includes(piece), false, piece));
        // A nova tentativa diz a verdade: já foi feito.
        const retry = await asAdmin(request(app).post(`/api/admin/students/${mode}`)).send({ email: 'duda@trava.local', confirm: mode === 'anonymize' ? 'ANONIMIZAR' : 'APAGAR', reason: 'Pedido da família' });
        assert.equal(retry.status, 404, JSON.stringify(retry.body));
        // Restaurar o curso não traz o dado de volta.
        const restored = await asAdmin(request(app).post('/api/admin/archived-courses/restore')).send({ folder });
        assert.equal(restored.status, 200, JSON.stringify(restored.body));
        const back = JSON.stringify(db.memory.assignmentSubmissions);
        ['TXT_ARQUIVADA', 'ARQ_ARQUIVADA', 'TXT_VIVA', 'ARQ_VIVA', 'duda@trava.local'].forEach(piece => assert.equal(back.includes(piece), false, piece));
    });
}

// J2 (pendência do C10): o disco do pacote falhando e o pacote que sobra depois de restaurar.
function seedCourse() {
    db.memory.courses = [{ id: COURSE, name: 'Curso travado', structure: [] }, { id: OTHER, name: 'Curso que fica', structure: [] }];
    db.memory.classes = [{ name: '1TRV', courseId: COURSE, period: 'Manhã' }, { name: '2FIC', courseId: OTHER, period: 'Tarde' }];
    db.memory.students = [
        { id: 'alu_000000000000e5e5', name: 'Eva Prado', email: 'eva@trava.local', matricula: 'MT-2', status: 'Ativo', password: db.hashPassword('Senha-forte-123'), classes: [{ name: '1TRV', courseId: COURSE }, { name: '2FIC', courseId: OTHER }] },
    ];
    db.memory.admins = [{ email: 'adm@trava.local', name: 'Adm', role: 'admin', password: db.hashPassword('Senha-forte-2026') }];
    db.memory.assignments = [];
    db.memory.assignmentSubmissions = [];
    db.memory.assignmentFileTombstones = [];
    db.memory.auditLogs = [];
    adminToken = createAdminSession(db.memory, 'adm@trava.local');
    fs.rmSync(runtimePaths.ASSIGNMENT_FILES_DIR, { recursive: true, force: true });
    fs.rmSync(fileStore.LIXEIRA_DIR, { recursive: true, force: true });
    fs.rmSync(runtimePaths.ARCHIVE_DIR, { recursive: true, force: true });
}

async function archiveCourse() {
    const archived = await asAdmin(request(app).post(`/api/admin/courses/${COURSE}/purge`)).send({});
    assert.equal(archived.status, 200, JSON.stringify(archived.body));
    return archived.body.folder;
}

test('[UC-ENCERRADOS-002] regravação do pacote do curso excluído falha: a mudança continua pendente, restaurar traz a entrega anonimizada e a regravação sai depois da próxima gravação', async () => {
    seedCourse();
    const sub = addSubmission(newTask(COURSE, '1TRV'), 'eva@trava.local', 'EVA');
    await db.save();
    const folder = await archiveCourse();
    const student = db.memory.students[0];
    student.status = 'Transferido';
    student.statusChangedAt = Date.now() - HOUR;
    await db.save();
    const bundleFile = path.join(runtimePaths.ARCHIVE_DIR, folder, 'curso.json');
    const realWrite = fs.writeFileSync;
    fs.writeFileSync = function (target, ...rest) {
        if (String(target).startsWith(bundleFile)) { const error = new Error('EBUSY simulado'); error.code = 'EBUSY'; throw error; }
        return realWrite.call(this, target, ...rest);
    };
    const originalError = console.error;
    console.error = () => {};
    let res;
    try {
        res = await asAdmin(request(app).post('/api/admin/students/anonymize')).send({ email: 'eva@trava.local', confirm: 'ANONIMIZAR', reason: 'Pedido da família' });
    } finally {
        fs.writeFileSync = realWrite;
        console.error = originalError;
    }
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // O pacote continua com o dado (a regravação falhou), mas a mudança está pendente:
    // restaurar nesse meio-tempo traz a entrega como ficaria.
    assert.equal(fs.readFileSync(bundleFile, 'utf8').includes('TXT_EVA'), true);
    const pending = assignmentLifecycle.pendingBundleChangesApplied(folder, JSON.parse(fs.readFileSync(bundleFile, 'utf8')).assignmentSubmissions, db.memory);
    assert.equal(JSON.stringify(pending).includes('TXT_EVA'), false);
    assert.equal(pending.find(item => item.id === sub.id).anonymized, true);
    // A pendência fica gravada no banco (C18): sobrevive a desligar o servidor (o caso de
    // desligar e religar está em assignments-bundle-queue-boot.test.js).
    const queue = db.memory[assignmentLifecycle.BUNDLE_QUEUE];
    assert.equal(queue.length, 1);
    assert.equal(queue[0].folder, folder);
    assert.equal(queue[0].mode, 'anonymize');
    // A próxima gravação (de qualquer rota) leva a regravação do pacote.
    await db.save();
    await waitFor(() => !fs.readFileSync(bundleFile, 'utf8').includes('TXT_EVA'), 5000, 'regravação do pacote');
    await waitFor(() => db.memory[assignmentLifecycle.BUNDLE_QUEUE].length === 0, 5000, 'fila vazia');
    ['TXT_EVA', 'ARQ_EVA', 'eva@trava.local'].forEach(piece => assert.equal(fs.readFileSync(bundleFile, 'utf8').includes(piece), false, piece));
    const restored = await asAdmin(request(app).post('/api/admin/archived-courses/restore')).send({ folder });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    const back = db.memory.assignmentSubmissions.find(item => item.id === sub.id);
    assert.equal(back.anonymized, true);
    assert.equal(JSON.stringify(back).includes('TXT_EVA'), false);
});

test('[UC-ENCERRADOS-002] pacote que ficou depois de restaurar o curso: excluir o pacote não leva os arquivos das entregas ativas nem grava lápide', async () => {
    seedCourse();
    const sub = addSubmission(newTask(COURSE, '1TRV'), 'eva@trava.local', 'EVA');
    await db.save();
    const folder = await archiveCourse();
    const file = sub.versions[0].files[0];
    assert.equal(onDisk(file), false, 'o arquivo foi para o pacote');
    const dir = path.join(runtimePaths.ARCHIVE_DIR, folder);
    const realRm = fs.rmSync;
    fs.rmSync = function (target, ...rest) {
        if (path.resolve(String(target)) === path.resolve(dir)) { const error = new Error('EPERM simulado'); error.code = 'EPERM'; throw error; }
        return realRm.call(this, target, ...rest);
    };
    const originalError = console.error;
    console.error = () => {};
    let restored;
    try {
        restored = await asAdmin(request(app).post('/api/admin/archived-courses/restore')).send({ folder });
    } finally {
        fs.rmSync = realRm;
        console.error = originalError;
    }
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(onDisk(file), true, 'o arquivo voltou');
    assert.equal(fs.existsSync(dir), true, 'o pacote ficou (a remoção falhou)');
    // Arquivo que só ficou no pacote (a volta não o levou): excluir o pacote o devolve.
    const abs = assignmentFiles.absFromStoredRel(file.storedRel);
    const archivedAbs = abs.replace(`${path.sep}entregas${path.sep}`, `${path.sep}entregas${path.sep}${assignmentLifecycle.COURSE_ARCHIVE_SEGMENT}${path.sep}${folder}${path.sep}`);
    fs.mkdirSync(path.dirname(archivedAbs), { recursive: true });
    fs.renameSync(abs, archivedAbs);
    assert.equal(onDisk(file), false);
    const deleted = await asAdmin(request(app).post('/api/admin/archived-courses/delete')).send({ folder });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.ok(db.memory.assignmentSubmissions.find(item => item.id === sub.id), 'a entrega continua ativa');
    assert.equal(onDisk(file), true, 'o arquivo da entrega ativa não foi para a lixeira');
    assert.equal(db.memory.assignmentFileTombstones.some(item => item.fileId === file.id), false, 'sem lápide para arquivo de entrega ativa');
    assert.equal(fileStore.listTrash().some(item => item.name === file.id || String(item.originalRel || '').includes(file.id)), false);
    const audit = db.memory.auditLogs.find(item => item.action === 'course_archive_deleted');
    assert.equal(audit.details.arquivosEntregasAtivasMantidos, 1);
});

test('[UC-ENCERRADOS-002] restaurar o curso com o banco travado: 503 e os arquivos ficam no pacote; quando a gravação sai, voltam e o pacote sai', async () => {
    seedCourse();
    const sub = addSubmission(newTask(COURSE, '1TRV'), 'eva@trava.local', 'EVA');
    await db.save();
    const folder = await archiveCourse();
    const file = sub.versions[0].files[0];
    const dir = path.join(runtimePaths.ARCHIVE_DIR, folder);
    const release = await holdWriteLock();
    try {
        const res = await asAdmin(request(app).post('/api/admin/archived-courses/restore')).timeout(8000).send({ folder });
        assert.equal(res.status, 503, JSON.stringify(res.body));
        // Na hora, nada saiu do pacote (o banco do disco ainda não tem o curso).
        assert.equal(onDisk(file), false);
        assert.equal(fs.existsSync(dir), true);
    } finally {
        await release();
    }
    await waitFor(() => db.storageStatus().pendingRetry === false && onDisk(file) && !fs.existsSync(dir), 12000, 'arquivos de volta depois da gravação');
    assert.ok(db.memory.assignmentSubmissions.find(item => item.id === sub.id));
});
