const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-bulk-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');

let app;
const adminToken = 'admin-token-bulk';
const professorToken = 'professor-token-bulk';
const courseId = 'curso-bulk';
const outroCurso = 'curso-bulk-alheio';
const turmaA = 'Turma A';
const turmaB = 'Turma B';
const turmaAlheia = 'Turma Alheia';

// Estado limpo antes de cada teste: as rotas de lote gravam em db.memory.
function seed() {
    db.memory.admins = [
        { email: 'admin@bulk.local', name: 'Admin', role: 'admin', password: db.hashPassword('x') },
        {
            email: 'prof@bulk.local', name: 'Professor', role: 'professor', password: db.hashPassword('x'),
            assignedClasses: [{ courseId, className: turmaA }, { courseId, className: turmaB }],
        },
    ];
    db.memory.adminSessions = {
        [adminToken]: { email: 'admin@bulk.local', createdAt: Date.now(), lastSeen: Date.now() },
        [professorToken]: { email: 'prof@bulk.local', createdAt: Date.now(), lastSeen: Date.now() },
    };
    db.memory.courses = [{ id: courseId, structure: [] }, { id: outroCurso, structure: [] }];
    db.memory.classes = [
        { name: turmaA, courseId },
        { name: turmaB, courseId },
        { name: turmaAlheia, courseId: outroCurso },
    ];
    db.memory.students = [
        { name: 'Ana', email: 'ana@bulk.local', status: 'Ativo', classes: [{ name: turmaA, courseId }] },
        { name: 'Bruno', email: 'bruno@bulk.local', status: 'Ativo', classes: [{ name: turmaA, courseId }] },
        { name: 'Célia', email: 'celia@bulk.local', status: 'Ativo', classes: [{ name: turmaAlheia, courseId: outroCurso }] },
    ];
    db.memory.auditLogs = [];
    db.memory.submissions = [];
    db.memory.attendance = [];
}

const asAdmin = (req) => req.set('x-admin-session', adminToken);
const asProfessor = (req) => req.set('x-admin-session', professorToken);
const findStudent = (email) => db.memory.students.find(s => s.email === email);
const classNamesOf = (student) => (student.classes || []).map(c => typeof c === 'string' ? c : c.name);

test.before(async () => { await db.init(); app = createApp(); });
test.beforeEach(() => { seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('bulk-enroll adiciona a turma sem remover as existentes e registra auditoria', async () => {
    const res = await asAdmin(request(app).post('/api/admin/student/bulk-enroll'))
        .send({ emails: ['ana@bulk.local', 'bruno@bulk.local'], className: turmaB });

    assert.equal(res.status, 200);
    assert.equal(res.body.updated, 2);
    // A turma anterior continua: matricular é somar, não substituir.
    assert.deepEqual(classNamesOf(findStudent('ana@bulk.local')), [turmaA, turmaB]);
    assert.deepEqual(classNamesOf(findStudent('bruno@bulk.local')), [turmaA, turmaB]);

    const auditados = db.memory.auditLogs.filter(l => l.action === 'bulk_enroll');
    assert.equal(auditados.length, 2, 'cada aluno alterado deve gerar entrada de auditoria');
    assert.equal(auditados[0].field, 'Turmas');
    assert.equal(auditados[0].actor, 'admin@bulk.local');
});

test('bulk-enroll ignora quem já está na turma em vez de duplicar', async () => {
    const res = await asAdmin(request(app).post('/api/admin/student/bulk-enroll'))
        .send({ emails: ['ana@bulk.local'], className: turmaA });

    assert.equal(res.status, 200);
    assert.equal(res.body.updated, 0);
    assert.equal(res.body.skipped[0].reason, 'Já matriculado nesta turma.');
    assert.deepEqual(classNamesOf(findStudent('ana@bulk.local')), [turmaA]);
});

test('bulk-enroll recusa turma inexistente', async () => {
    const res = await asAdmin(request(app).post('/api/admin/student/bulk-enroll'))
        .send({ emails: ['ana@bulk.local'], className: 'Turma Fantasma' });
    assert.equal(res.status, 404);
});

test('e-mail inexistente vira skipped, sem derrubar o restante do lote', async () => {
    const res = await asAdmin(request(app).post('/api/admin/student/bulk-enroll'))
        .send({ emails: ['ana@bulk.local', 'ninguem@bulk.local'], className: turmaB });

    assert.equal(res.status, 200);
    assert.equal(res.body.updated, 1, 'o aluno válido deve ser processado mesmo com um inválido no lote');
    assert.equal(res.body.skipped.length, 1);
    assert.equal(res.body.skipped[0].email, 'ninguem@bulk.local');
});

test('bulk-status altera a situação e audita o campo Status', async () => {
    const res = await asAdmin(request(app).post('/api/admin/student/bulk-status'))
        .send({ emails: ['ana@bulk.local', 'bruno@bulk.local'], status: 'Inativo' });

    assert.equal(res.status, 200);
    assert.equal(res.body.updated, 2);
    assert.equal(findStudent('ana@bulk.local').status, 'Inativo');

    const auditados = db.memory.auditLogs.filter(l => l.action === 'bulk_status');
    assert.equal(auditados.length, 2);
    assert.equal(auditados[0].field, 'Status');
    assert.equal(auditados[0].oldValue, 'Ativo');
    assert.equal(auditados[0].newValue, 'Inativo');
});

test('bulk-status rejeita situação fora da lista permitida', async () => {
    const res = await asAdmin(request(app).post('/api/admin/student/bulk-status'))
        .send({ emails: ['ana@bulk.local'], status: 'Expulso' });

    assert.equal(res.status, 400);
    assert.equal(findStudent('ana@bulk.local').status, 'Ativo', 'nada pode ser gravado quando o status é inválido');
});

// --- Segurança: a lista de e-mails vem do cliente e não pode ser confiada. ---

test('professor não altera aluno fora do seu escopo, mesmo enviando o e-mail direto', async () => {
    const res = await asProfessor(request(app).post('/api/admin/student/bulk-status'))
        .send({ emails: ['ana@bulk.local', 'celia@bulk.local'], status: 'Inativo' });

    assert.equal(res.status, 200);
    assert.equal(res.body.updated, 1, 'só a aluna dentro do escopo deve ser alterada');
    assert.equal(findStudent('ana@bulk.local').status, 'Inativo');
    assert.equal(findStudent('celia@bulk.local').status, 'Ativo', 'aluna de outro curso não pode ser tocada');
    assert.equal(res.body.skipped.find(s => s.email === 'celia@bulk.local').reason, 'Fora do seu escopo.');
});

test('professor não matricula alunos numa turma fora do seu escopo', async () => {
    const res = await asProfessor(request(app).post('/api/admin/student/bulk-enroll'))
        .send({ emails: ['ana@bulk.local'], className: turmaAlheia });

    assert.equal(res.status, 403);
    assert.deepEqual(classNamesOf(findStudent('ana@bulk.local')), [turmaA]);
});
