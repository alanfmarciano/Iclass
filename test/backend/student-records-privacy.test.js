// Fase 1, grupo G6: turma do aluno sempre como nome (DES-03), backup e restauração só
// do administrador (SEG-X1) e observações restritas / dados de saúde fora do alcance do
// professor (SEG-04). Cada teste falha no comportamento antigo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-g6-records-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const backup = require('../../backend/utils/backup.js');
const { normalizeStoredStudentClasses, studentInClass, primaryStudentClassName } = require('../../backend/utils/students.js');
const { createApp } = require('../../backend/server.js');

let app;
const adminToken = 'admin-token-g6';
const professorToken = 'professor-token-g6';
const otherProfessorToken = 'professor2-token-g6';
const courseA = 'curso-g6-a';
const courseB = 'curso-g6-b';
const examKey = 'Avaliacao_G6_1';

function readOne(sql, params = []) {
    return new Promise((resolve, reject) => {
        const reader = new sqlite3.Database(path.join(tempRoot, 'database.db'));
        reader.get(sql, params, (err, row) => reader.close(closeError => (err || closeError) ? reject(err || closeError) : resolve(row)));
    });
}

function seed() {
    db.memory.admins = [
        { email: 'admin@g6.local', name: 'Admin', role: 'admin', password: db.hashPassword('x') },
        {
            email: 'prof@g6.local', name: 'Professor', role: 'professor', password: db.hashPassword('x'),
            assignedClasses: [{ courseId: courseA, className: 'TURMA A' }],
            additionalPermissions: ['page.system', 'system.manage'],
        },
        { email: 'prof2@g6.local', name: 'Outra professora', role: 'professor', password: db.hashPassword('x'), assignedClasses: [{ courseId: courseA, className: 'TURMA A' }] },
    ];
    db.memory.adminSessions = {
        [adminToken]: { email: 'admin@g6.local', createdAt: Date.now(), lastSeen: Date.now() },
        [professorToken]: { email: 'prof@g6.local', createdAt: Date.now(), lastSeen: Date.now() },
        [otherProfessorToken]: { email: 'prof2@g6.local', createdAt: Date.now(), lastSeen: Date.now() },
    };
    db.memory.courses = [{ id: courseA, name: 'Curso A', structure: [] }, { id: courseB, name: 'Curso B', structure: [] }];
    db.memory.classes = [
        { name: 'TURMA A', courseId: courseA, period: 'Manhã', onlineExamConfigs: {} },
        { name: 'TURMA B', courseId: courseA, period: 'Tarde', onlineExamConfigs: {} },
        { name: 'TURMA C', courseId: courseA, period: 'Noite', onlineExamConfigs: {} },
        { name: 'TURMA B', courseId: courseB, period: 'Tarde', onlineExamConfigs: {} },
    ];
    db.memory.students = [
        {
            name: 'Ana', email: 'ana@g6.local', status: 'Ativo', password: db.hashPassword('123'),
            classes: [{ name: 'TURMA A', courseId: courseA }], studentClass: 'TURMA A',
            accessibility: { tempoAdicional: true, tempoAdicionalPercent: 25, fonteAmpliada: true, observacao: 'Laudo de TDAH, CID F90' },
        },
    ];
    db.memory.pedagogicalObservations = [];
    db.memory.sessions = {};
    db.memory.submissions = [];
    db.memory.studentExamState = {};
    db.memory.proctoringLogs = [];
    db.memory.examKeystrokes = [];
    db.memory.examApplications = [];
    db.memory.auditLogs = [];
}

test.before(async () => { await db.init(); app = createApp(); });
test.beforeEach(() => { seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------- DES-03

test('[UC-MATRICULA-001] aprovação seguida de matrícula em lote mantém a turma como nome e o Monitor abre em todas as turmas', async () => {
    db.memory.students.push({
        name: 'Duda', email: 'duda@g6.local', status: 'Ativo', password: db.hashPassword('123'), classes: [],
        enrollmentRequests: [{ id: 'req-duda', status: 'pending', courseId: courseA, requestedClassName: 'TURMA A', createdAt: Date.now() }],
    });
    await request(app).post('/api/admin/enrollment-requests/req-duda/approve').set('x-admin-session', adminToken).send({}).expect(200);
    const enroll = await request(app).post('/api/admin/student/bulk-enroll').set('x-admin-session', adminToken)
        .send({ emails: ['duda@g6.local'], className: 'TURMA B', courseId: courseA });
    assert.equal(enroll.status, 200, enroll.body && enroll.body.error);

    const duda = db.memory.students.find(s => s.email === 'duda@g6.local');
    assert.equal(typeof duda.studentClass, 'string', 'studentClass guardava o objeto da primeira turma');
    assert.equal(duda.studentClass, 'TURMA A');
    assert.deepEqual(duda.classes.map(c => [c.name, c.courseId]), [['TURMA A', courseA], ['TURMA B', courseA]]);

    for (const className of ['TURMA A', 'TURMA B', 'TURMA C']) {
        const monitor = await request(app).get(`/api/admin/monitor-status/${encodeURIComponent(className)}/${examKey}?courseId=${courseA}`).set('x-admin-session', adminToken);
        assert.equal(monitor.status, 200, `Monitor da ${className} caía com 500`);
        const emails = (monitor.body.students || monitor.body).map(row => row.email);
        assert.equal(emails.includes('duda@g6.local'), className !== 'TURMA C');
    }
});

test('[UC-MATRICULA-001] um registro antigo com a turma em objeto não derruba o Monitor', async () => {
    db.memory.students.push({ name: 'Legado', email: 'legado@g6.local', status: 'Ativo', password: db.hashPassword('123'),
        classes: [{ name: 'TURMA A', courseId: courseA }], studentClass: { name: 'TURMA A', courseId: courseA } });
    const monitor = await request(app).get(`/api/admin/monitor-status/TURMA%20A/${examKey}?courseId=${courseA}`).set('x-admin-session', adminToken);
    assert.equal(monitor.status, 200);
    const emails = (monitor.body.students || monitor.body).map(row => row.email);
    assert.ok(emails.includes('legado@g6.local'));
});

test('[UC-MATRICULA-001] matrícula em lote com turma homônima exige o curso e grava no curso certo', async () => {
    const ambiguous = await request(app).post('/api/admin/student/bulk-enroll').set('x-admin-session', adminToken)
        .send({ emails: ['ana@g6.local'], className: 'TURMA B' });
    assert.equal(ambiguous.status, 400);
    const ok = await request(app).post('/api/admin/student/bulk-enroll').set('x-admin-session', adminToken)
        .send({ emails: ['ana@g6.local'], className: 'TURMA B', courseId: courseB });
    assert.equal(ok.status, 200, ok.body && ok.body.error);
    const ana = db.memory.students.find(s => s.email === 'ana@g6.local');
    assert.ok(studentInClass(ana, 'TURMA B', courseB));
    assert.equal(studentInClass(ana, 'TURMA B', courseA), false, 'não pode cair na TURMA B do outro curso');
    assert.equal(ana.studentClass, 'TURMA A');
});

test('[UC-MATRICULA-001] cadastro com turmas em objeto grava studentClass como nome', async () => {
    const created = await request(app).post('/api/admin/student/create').set('x-admin-session', adminToken).send({
        name: 'Eva', email: 'eva@g6.local', studentPassword: 'senha123', courseId: courseA,
        classes: [{ name: 'TURMA C', courseId: courseA, period: 'Noite' }],
    });
    assert.equal(created.status, 200, created.body && created.body.error);
    const eva = db.memory.students.find(s => s.email === 'eva@g6.local');
    assert.equal(eva.studentClass, 'TURMA C');
    assert.deepEqual(eva.classes, [{ name: 'TURMA C', courseId: courseA, period: 'Noite' }]);
});

test('[UC-MATRICULA-001] a carga do banco normaliza studentClass em objeto, sem perder a matrícula, e é idempotente', async () => {
    db.memory.students.push({ name: 'Gil', email: 'gil@g6.local', status: 'Ativo', password: db.hashPassword('123'),
        classes: [{ className: 'TURMA B', courseId: courseA }, 'TURMA C'], studentClass: { name: 'TURMA B', courseId: courseA, period: 'Tarde' } });
    await db.save();
    const storedBefore = JSON.parse((await readOne('SELECT value FROM students WHERE key = ?', ['gil@g6.local'])).value);
    assert.equal(typeof storedBefore.studentClass, 'object');

    await db.init();
    const gil = db.memory.students.find(s => s.email === 'gil@g6.local');
    assert.equal(gil.studentClass, 'TURMA B');
    assert.deepEqual(gil.classes, [{ name: 'TURMA B', courseId: courseA }, 'TURMA C']);
    assert.equal(normalizeStoredStudentClasses(gil), false, 'segunda passada não muda nada');
    assert.equal(primaryStudentClassName(gil), 'TURMA B');
    await db.save();
    const storedAfter = JSON.parse((await readOne('SELECT value FROM students WHERE key = ?', ['gil@g6.local'])).value);
    assert.equal(storedAfter.studentClass, 'TURMA B');
});

test('[UC-MATRICULA-001] professor não aprova matrícula (o bloqueio nunca valia por causa da assinatura do callback)', async () => {
    db.memory.students.push({ name: 'Hugo', email: 'hugo@g6.local', status: 'Ativo', password: db.hashPassword('123'), classes: [],
        enrollmentRequests: [{ id: 'req-hugo', status: 'pending', courseId: courseA, requestedClassName: 'TURMA A', createdAt: Date.now() }] });
    const approve = await request(app).post('/api/admin/enrollment-requests/req-hugo/approve').set('x-admin-session', professorToken).send({});
    assert.equal(approve.status, 403);
    const reject = await request(app).post('/api/admin/enrollment-requests/req-hugo/reject').set('x-admin-session', professorToken).send({ reason: 'x' });
    assert.equal(reject.status, 403);
    assert.equal(db.memory.students.find(s => s.email === 'hugo@g6.local').enrollmentRequests[0].status, 'pending');
});

// ---------------------------------------------------------------- SEG-X1

test('[UC-BACKUP-001] professor com "Executar manutenção" só gera cópia no servidor; baixar e restaurar é do administrador', async () => {
    const data = await request(app).get('/api/admin/backup/data').set('x-admin-session', professorToken);
    assert.equal(data.status, 403, 'o JSON leva os hashes de senha de todas as contas');
    assert.doesNotMatch(JSON.stringify(data.body), /scrypt\$/);
    await request(app).get('/api/admin/backup/full').set('x-admin-session', professorToken).expect(403);
    const restore = await request(app).post('/api/admin/backup/restore').set('x-admin-session', professorToken)
        .field('confirm', 'RESTAURAR').attach('file', Buffer.from('{}'), 'backup.json');
    assert.equal(restore.status, 403);

    const server = await request(app).post('/api/admin/backup/server').set('x-admin-session', professorToken).send({});
    assert.equal(server.status, 200, server.body && server.body.error);
    assert.match(server.body.fileName, /manual/);

    const adminData = await request(app).get('/api/admin/backup/data').set('x-admin-session', adminToken);
    assert.equal(adminData.status, 200);
    // Professor sem a permissão nem chega à rota.
    db.memory.admins[1].additionalPermissions = [];
    await request(app).post('/api/admin/backup/server').set('x-admin-session', professorToken).send({}).expect(403);
});

test('[UC-BACKUP-001] restauração mantém as contas de acesso atuais, salvo pedido explícito do administrador', async () => {
    await db.save();
    const snapshot = structuredClone(backup.buildDataSnapshot());
    // Backup adulterado: professor promovido a admin com senha conhecida e admin trocado.
    snapshot.data.admins = [
        { email: 'prof@g6.local', name: 'Professor', role: 'admin', password: db.hashPassword('invasor') },
    ];
    snapshot.data.notes = { 'restaurado@g6.local': { ok: true } };

    const response = await request(app).post('/api/admin/backup/restore').set('x-admin-session', adminToken)
        .field('confirm', 'RESTAURAR').attach('file', Buffer.from(JSON.stringify(snapshot)), 'backup.json');
    assert.equal(response.status, 200, response.body && response.body.error);
    assert.equal(response.body.replaceAccounts, false);
    assert.deepEqual(db.memory.notes['restaurado@g6.local'], { ok: true }, 'os dados voltaram');
    const prof = db.memory.admins.find(a => a.email === 'prof@g6.local');
    assert.equal(prof.role, 'professor', 'a restauração não pode promover conta');
    assert.equal(db.verifyPassword(prof.password, 'invasor'), false);
    assert.ok(db.memory.admins.some(a => a.email === 'admin@g6.local' && a.role === 'admin'), 'o administrador continua existindo');
});

test('[UC-BACKUP-001] substituir as contas exige backup com administrador e senhas protegidas', async () => {
    await db.save();
    const plain = structuredClone(backup.buildDataSnapshot());
    plain.data.admins = [{ email: 'novo@g6.local', role: 'admin', password: 'texto-puro' }];
    await assert.rejects(backup.restoreDataSnapshot(plain, { replaceAccounts: true }), /texto puro/);
    assert.ok(db.memory.admins.some(a => a.email === 'admin@g6.local'), 'nada mudou');

    const onlyProfessors = structuredClone(backup.buildDataSnapshot());
    onlyProfessors.data.admins = [{ email: 'p@g6.local', role: 'professor', password: db.hashPassword('x') }];
    await assert.rejects(backup.restoreDataSnapshot(onlyProfessors, { replaceAccounts: true }), /nenhuma conta de administrador/);

    const valid = structuredClone(backup.buildDataSnapshot());
    valid.data.admins = [{ email: 'outro-admin@g6.local', name: 'Outro', role: 'admin', password: db.hashPassword('segura') }];
    const response = await request(app).post('/api/admin/backup/restore').set('x-admin-session', adminToken)
        .field('confirm', 'RESTAURAR').field('replaceAccounts', '1').attach('file', Buffer.from(JSON.stringify(valid)), 'backup.json');
    assert.equal(response.status, 200, response.body && response.body.error);
    assert.equal(response.body.replaceAccounts, true);
    assert.deepEqual(db.memory.admins.map(a => a.email), ['outro-admin@g6.local']);
});

test('[UC-BACKUP-001] o arquivo enviado para restaurar é apagado (não vai para a lixeira) e a restauração fica registrada', async () => {
    const fileStore = require('../../backend/utils/storage.js');
    const uploadsBefore = new Set(fs.readdirSync(fileStore.UPLOADS_DIR));
    const backupTrashItems = () => fileStore.listTrash().filter(entry => /^uploads\/.+\.(json|zip)$/.test(entry.originalRel));
    const trashBefore = backupTrashItems().length;
    await db.save();
    const snapshot = structuredClone(backup.buildDataSnapshot());
    snapshot.data.admins = [...snapshot.data.admins, { email: 'antigo@g6.local', name: 'Antigo', role: 'professor', password: db.hashPassword('x') }];

    // Sem a confirmação e com arquivo inválido: recusado, e o arquivo some.
    await request(app).post('/api/admin/backup/restore').set('x-admin-session', adminToken)
        .field('confirm', 'nao').attach('file', Buffer.from(JSON.stringify(snapshot)), 'backup.json').expect(400);
    await request(app).post('/api/admin/backup/restore').set('x-admin-session', adminToken)
        .field('confirm', 'RESTAURAR').attach('file', Buffer.from('PK nada'), 'backup.png').expect(400);
    const failed = await request(app).post('/api/admin/backup/restore').set('x-admin-session', adminToken)
        .field('confirm', 'RESTAURAR').attach('file', Buffer.from('{"type":"outro"}'), 'backup.json');
    assert.equal(failed.status, 400);
    const failure = db.memory.auditLogs.find(entry => entry.type === 'backup_restore_failed');
    assert.ok(failure, 'a falha também fica registrada');
    assert.equal(failure.actorEmail, 'admin@g6.local');
    db.memory.adminSessions = { [adminToken]: { email: 'admin@g6.local', createdAt: Date.now(), lastSeen: Date.now() } };

    const response = await request(app).post('/api/admin/backup/restore').set('x-admin-session', adminToken)
        .field('confirm', 'RESTAURAR').attach('file', Buffer.from(JSON.stringify(snapshot)), 'backup-da-escola.json');
    assert.equal(response.status, 200, response.body && response.body.error);
    assert.equal(response.body.accountsNotRestored, 1, 'a tela avisa da conta do backup que ficou de fora');

    assert.equal(backupTrashItems().length, trashBefore, 'o backup enviado ia para a lixeira, de onde o professor o restaurava');
    const leftovers = fs.readdirSync(fileStore.UPLOADS_DIR).filter(name => !uploadsBefore.has(name));
    assert.deepEqual(leftovers, [], 'nenhum arquivo enviado fica em /uploads');

    const audit = db.memory.auditLogs.filter(entry => entry.type === 'backup_restored');
    assert.equal(audit.length, 1, 'a restauração vai para o registro de auditoria');
    assert.equal(audit[0].actorEmail, 'admin@g6.local');
    assert.equal(audit[0].file, 'backup-da-escola.json');
    assert.equal(audit[0].format, 'json');
    assert.ok(audit[0].ip);
    assert.ok(audit[0].collections.includes('students'));
});

test('[UC-BACKUP-001] backup que já estava na lixeira (versões anteriores) não volta para o professor nem é baixado em /uploads', async () => {
    const fileStore = require('../../backend/utils/storage.js');
    await db.save();
    const legacyName = `${Date.now()}-123456.json`;
    fs.writeFileSync(path.join(fileStore.UPLOADS_DIR, legacyName), JSON.stringify(backup.buildDataSnapshot()));
    const trashId = fileStore.moveToTrash(path.join(fileStore.UPLOADS_DIR, legacyName));
    assert.ok(trashId);

    const professorList = await request(app).get('/api/admin/trash').set('x-admin-session', professorToken);
    assert.equal(professorList.status, 200);
    assert.ok(!professorList.body.some(entry => entry.id === trashId), 'o professor via o backup na lixeira');
    await request(app).post('/api/admin/trash/restore').set('x-admin-session', professorToken).send({ id: trashId }).expect(403);
    await request(app).post('/api/admin/trash/delete').set('x-admin-session', professorToken).send({ id: trashId }).expect(403);
    await request(app).post('/api/admin/trash/empty').set('x-admin-session', professorToken).send({}).expect(200);
    const adminList = await request(app).get('/api/admin/trash').set('x-admin-session', adminToken);
    assert.ok(adminList.body.some(entry => entry.id === trashId), 'o administrador continua vendo o item');

    // Se o arquivo já voltou para /uploads, o professor não o baixa; o administrador sim.
    const restored = await request(app).post('/api/admin/trash/restore').set('x-admin-session', adminToken).send({ id: trashId });
    assert.equal(restored.status, 200, restored.body && restored.body.error);
    const restoredName = path.basename(restored.body.restoredTo);
    const asProfessor = await request(app).get(`/uploads/${restoredName}`).set('x-admin-session', professorToken);
    assert.equal(asProfessor.status, 403, 'o professor baixava o banco com os hashes');
    assert.doesNotMatch(asProfessor.text, /scrypt\$/);
    await request(app).get(`/uploads/${restoredName}`).set('x-admin-session', adminToken).expect(200);

    // .json/.zip ligado ao conteúdo (biblioteca ou arquivo de unidade) continua aberto ao professor.
    const unitZip = `${Date.now()}-777.zip`;
    fs.writeFileSync(path.join(fileStore.UPLOADS_DIR, unitZip), 'PK\u0003\u0004');
    db.memory.courses[0].structure = [{ id: 'm1', units: [{ id: 'u1', apostilaKey: 'Apostila_G6', files: [{ id: 'f1', name: 'projeto.zip', path: `/uploads/${unitZip}`, type: 'other' }] }] }];
    await request(app).get(`/uploads/${unitZip}`).set('x-admin-session', professorToken).expect(200);
    db.memory.library = [{ id: 'lib1', kind: 'file', courseId: courseA, filename: restoredName, url: `/uploads/${restoredName}` }];
    await request(app).get(`/uploads/${restoredName}`).set('x-admin-session', professorToken).expect(200);
    db.memory.library = [];
});

// ---------------------------------------------------------------- SEG-04

test('[UC-PRIVACIDADE-001] observação restrita e de acessibilidade só para o administrador e o autor', async () => {
    db.memory.pedagogicalObservations = [
        { id: 'obs-geral', studentEmail: 'ana@g6.local', author: 'admin@g6.local', category: 'Observação geral', visibility: 'Equipe pedagógica', text: 'Participativa', timestamp: 1 },
        { id: 'obs-restrita', studentEmail: 'ana@g6.local', author: 'admin@g6.local', category: 'Observação geral', visibility: 'Restrita (coordenação)', text: 'Situação familiar delicada', timestamp: 2 },
        { id: 'obs-saude', studentEmail: 'ana@g6.local', author: 'admin@g6.local', category: 'Acessibilidade pedagógica', visibility: 'Equipe pedagógica', text: 'Laudo médico anexado', timestamp: 3 },
    ];
    const asProfessor = await request(app).get('/api/admin/student/observations?email=ana@g6.local').set('x-admin-session', professorToken);
    assert.equal(asProfessor.status, 200);
    assert.deepEqual(asProfessor.body.map(o => o.id), ['obs-geral']);
    assert.doesNotMatch(JSON.stringify(asProfessor.body), /familiar|Laudo/);
    assert.equal(asProfessor.body[0].canEdit, false);

    const asAdmin = await request(app).get('/api/admin/student/observations?email=ana@g6.local').set('x-admin-session', adminToken);
    assert.deepEqual(asAdmin.body.map(o => o.id).sort(), ['obs-geral', 'obs-restrita', 'obs-saude']);
    assert.equal(asAdmin.body.find(o => o.id === 'obs-saude').restricted, true);

    for (const id of ['obs-restrita', 'obs-saude']) {
        await request(app).post('/api/admin/student/observations/update').set('x-admin-session', professorToken).send({ id, text: 'alterado' }).expect(404);
        await request(app).post('/api/admin/student/observations/delete').set('x-admin-session', professorToken).send({ id }).expect(404);
    }
    await request(app).post('/api/admin/student/observations/delete').set('x-admin-session', professorToken).send({ id: 'obs-geral' }).expect(403);
    assert.equal(db.memory.pedagogicalObservations.length, 3, 'nada foi apagado');
});

test('[UC-PRIVACIDADE-001] professor autor vê e edita a própria observação restrita; a de saúde nasce restrita', async () => {
    const created = await request(app).post('/api/admin/student/observations/create').set('x-admin-session', professorToken)
        .send({ email: 'ana@g6.local', category: 'Acessibilidade pedagógica', visibility: 'Equipe pedagógica', text: 'Precisa de tempo extra' });
    assert.equal(created.status, 200, created.body && created.body.error);
    const stored = db.memory.pedagogicalObservations[0];
    assert.equal(stored.visibility, 'Restrita (coordenação)');

    const own = await request(app).get('/api/admin/student/observations?email=ana@g6.local').set('x-admin-session', professorToken);
    assert.deepEqual(own.body.map(o => o.id), [stored.id]);
    assert.equal(own.body[0].canEdit, true);
    const other = await request(app).get('/api/admin/student/observations?email=ana@g6.local').set('x-admin-session', otherProfessorToken);
    assert.deepEqual(other.body, [], 'a outra professora da turma não vê');

    await request(app).post('/api/admin/student/observations/update').set('x-admin-session', professorToken)
        .send({ id: stored.id, visibility: 'Equipe pedagógica', text: 'Tempo extra de 25%' }).expect(200);
    assert.equal(stored.visibility, 'Restrita (coordenação)', 'dado de saúde não pode ser aberto para a equipe');
    assert.equal(stored.text, 'Tempo extra de 25%');
});

test('[UC-PRIVACIDADE-001] professor recebe a acomodação sem o texto de saúde e não altera a acessibilidade', async () => {
    const list = await request(app).get(`/api/admin/students?courseId=${courseA}&studentClass=TURMA%20A`).set('x-admin-session', professorToken);
    assert.equal(list.status, 200);
    const rows = Array.isArray(list.body) ? list.body : (list.body.students || []);
    const ana = rows.find(s => s.email === 'ana@g6.local');
    assert.ok(ana);
    assert.equal(ana.accessibility.tempoAdicional, true);
    assert.equal(ana.accessibility.tempoAdicionalPercent, 25);
    assert.equal(ana.accessibility.observacao, '');
    assert.equal(ana.accessibilityNoteRestricted, true);
    assert.doesNotMatch(JSON.stringify(list.body), /TDAH|F90/);

    const asAdmin = await request(app).get(`/api/admin/students?courseId=${courseA}&studentClass=TURMA%20A`).set('x-admin-session', adminToken);
    const adminRows = Array.isArray(asAdmin.body) ? asAdmin.body : (asAdmin.body.students || []);
    assert.equal(adminRows.find(s => s.email === 'ana@g6.local').accessibility.observacao, 'Laudo de TDAH, CID F90');

    // O formulário do professor devolve a observação vazia: não pode apagar o laudo nem mudar o tempo extra.
    const update = await request(app).post('/api/admin/student/update').set('x-admin-session', professorToken).send({
        originalEmail: 'ana@g6.local', name: 'Ana Maria', email: 'ana@g6.local', courseId: courseA,
        classes: [{ name: 'TURMA A', courseId: courseA }],
        accessibility: { tempoAdicional: false, tempoAdicionalPercent: 0, observacao: '' },
    });
    assert.equal(update.status, 200, update.body && update.body.error);
    const stored = db.memory.students.find(s => s.email === 'ana@g6.local');
    assert.equal(stored.name, 'Ana Maria');
    assert.deepEqual(stored.accessibility, { tempoAdicional: true, tempoAdicionalPercent: 25, fonteAmpliada: true, observacao: 'Laudo de TDAH, CID F90' });
});
