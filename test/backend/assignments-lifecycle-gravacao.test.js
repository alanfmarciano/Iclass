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
