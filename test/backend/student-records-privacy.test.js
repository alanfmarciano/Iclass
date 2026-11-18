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
    const failure = db.memory.auditLogs.find(entry => entry.action === 'backup_restore_failed');
    assert.ok(failure, 'a falha também fica registrada');
    // Mesmo formato dos outros registros de auditoria (antes: type/actorEmail/at).
    assert.equal(failure.actor, 'admin@g6.local');
    assert.equal(typeof failure.timestamp, 'number');
    assert.equal(failure.details.file, 'backup.json');
    assert.ok(failure.details.error);
    assert.equal(failure.type, undefined);
    // As recusas antes da restauração (sem confirmação, formato inválido) também ficam
    // no histórico; antes só a falha dentro da restauração era registrada.
    const failures = db.memory.auditLogs.filter(entry => entry.action === 'backup_restore_failed');
    assert.equal(failures.length, 3);
    assert.deepEqual(failures.map(entry => entry.details.file), ['backup.json', 'backup.png', 'backup.json']);
    assert.match(failures[0].details.error, /RESTAURAR/);
    db.memory.adminSessions = { [adminToken]: { email: 'admin@g6.local', createdAt: Date.now(), lastSeen: Date.now() } };

    const response = await request(app).post('/api/admin/backup/restore').set('x-admin-session', adminToken)
        .field('confirm', 'RESTAURAR').attach('file', Buffer.from(JSON.stringify(snapshot)), 'backup-da-escola.json');
    assert.equal(response.status, 200, response.body && response.body.error);
    assert.equal(response.body.accountsNotRestored, 1, 'a tela avisa da conta do backup que ficou de fora');

    assert.equal(backupTrashItems().length, trashBefore, 'o backup enviado ia para a lixeira, de onde o professor o restaurava');
    const leftovers = fs.readdirSync(fileStore.UPLOADS_DIR).filter(name => !uploadsBefore.has(name));
    assert.deepEqual(leftovers, [], 'nenhum arquivo enviado fica em /uploads');

    const audit = db.memory.auditLogs.filter(entry => entry.action === 'backup_restored');
    assert.equal(audit.length, 1, 'a restauração vai para o registro de auditoria');
    assert.equal(audit[0].actor, 'admin@g6.local');
    assert.equal(audit[0].details.file, 'backup-da-escola.json');
    assert.equal(audit[0].details.format, 'json');
    assert.ok(audit[0].ip);
    assert.ok(audit[0].details.collections.includes('students'));
    // A restauração bem-sucedida troca o registro pelo do backup: a falha anterior sumia.
    assert.ok(db.memory.auditLogs.some(entry => entry.id === failure.id), 'o registro da falha continua depois da restauração');
});

test('[UC-BACKUP-001] histórico de backup na tela do administrador (formato novo e antigo) e só 20 cópias manuais', async () => {
    const runtimePaths = require('../../backend/runtimePaths.js');
    // Registro gravado pela versão anterior (type/actorEmail/at e dados soltos).
    db.memory.auditLogs = [{ id: 'audit_backup_legado', actorEmail: 'admin@g6.local', at: 1700000000000, ip: '10.0.0.5', type: 'backup_restore_failed', file: 'velho.json', size: 10, replaceAccounts: false, error: 'Arquivo de backup inválido.' }];

    fs.mkdirSync(runtimePaths.BACKUPS_DIR, { recursive: true });
    const manual = () => fs.readdirSync(runtimePaths.BACKUPS_DIR).filter(name => name.startsWith('manual_') && name.endsWith('.json'));
    manual().forEach(name => fs.rmSync(path.join(runtimePaths.BACKUPS_DIR, name), { force: true }));
    // 22 cópias antigas mais uma nova: ficam as 20 mais recentes.
    for (let index = 0; index < 22; index += 1) {
        fs.writeFileSync(path.join(runtimePaths.BACKUPS_DIR, `manual_2020-01-${String(index + 1).padStart(2, '0')}T00-00-00-000Z.json`), '{}');
    }
    const created = await request(app).post('/api/admin/backup/server').set('x-admin-session', professorToken).send({});
    assert.equal(created.status, 200, created.body && created.body.error);
    const kept = manual();
    assert.equal(kept.length, 20, 'as cópias manuais eram ilimitadas');
    assert.ok(kept.includes(created.body.fileName), 'a cópia nova fica');
    assert.ok(!kept.includes('manual_2020-01-01T00-00-00-000Z.json'), 'as mais antigas saem');

    const asProfessor = await request(app).get('/api/admin/backup/history').set('x-admin-session', professorToken);
    assert.equal(asProfessor.status, 403);
    const history = await request(app).get('/api/admin/backup/history').set('x-admin-session', adminToken);
    assert.equal(history.status, 200, history.body && history.body.error);
    const [latest, legacy] = history.body.entries;
    assert.equal(latest.action, 'backup_server_created');
    assert.equal(latest.actor, 'prof@g6.local');
    assert.equal(latest.file, created.body.fileName);
    assert.deepEqual(
        { action: legacy.action, actor: legacy.actor, timestamp: legacy.timestamp, ip: legacy.ip, file: legacy.file, error: legacy.error },
        { action: 'backup_restore_failed', actor: 'admin@g6.local', timestamp: 1700000000000, ip: '10.0.0.5', file: 'velho.json', error: 'Arquivo de backup inválido.' },
    );
});

test('[UC-BACKUP-001] tentativa do professor, restauração sem arquivo e tipo bloqueado ficam no histórico, em português', async () => {
    db.memory.auditLogs = [];
    const asProfessor = await request(app).post('/api/admin/backup/restore').set('x-admin-session', professorToken)
        .field('confirm', 'RESTAURAR').attach('file', Buffer.from('{"type":"iclass-backup-data"}'), 'backup.json');
    assert.equal(asProfessor.status, 403);
    // Professora sem "Executar manutenção": a guarda de permissões recusa antes da rota.
    const withoutPermission = await request(app).post('/api/admin/backup/restore').set('x-admin-session', otherProfessorToken)
        .field('confirm', 'RESTAURAR').attach('file', Buffer.from('{"type":"iclass-backup-data"}'), 'backup.json');
    assert.equal(withoutPermission.status, 403);
    const noFile = await request(app).post('/api/admin/backup/restore').set('x-admin-session', adminToken).field('confirm', 'RESTAURAR');
    assert.equal(noFile.status, 400);
    const blocked = await request(app).post('/api/admin/backup/restore').set('x-admin-session', adminToken)
        .field('confirm', 'RESTAURAR').attach('file', Buffer.from('MZ'), 'programa.exe');
    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error, 'Erro no upload: tipo de arquivo não permitido.', 'antes: "Erro no upload: Unexpected field"');

    const history = await request(app).get('/api/admin/backup/history').set('x-admin-session', adminToken);
    assert.equal(history.status, 200);
    const failures = history.body.entries.filter(entry => entry.action === 'backup_restore_failed');
    assert.equal(failures.length, 4, 'antes as tentativas dos professores e a restauração sem arquivo não eram registradas');
    const byActor = failures.find(entry => entry.actor === 'prof@g6.local');
    assert.ok(byActor, 'tentativa do professor registrada com quem tentou');
    assert.match(byActor.error, /professor/);
    const byGuard = failures.find(entry => entry.actor === 'prof2@g6.local');
    assert.ok(byGuard, 'tentativa recusada pela guarda de permissões também fica no histórico');
    assert.match(byGuard.error, /^Tentativa de restauração recusada: /);
    // Só a restauração é registrada pela guarda; outras recusas não viram histórico de backup.
    await request(app).get('/api/admin/backup/full').set('x-admin-session', otherProfessorToken).expect(403);
    const after = await request(app).get('/api/admin/backup/history').set('x-admin-session', adminToken);
    assert.equal(after.body.entries.filter(entry => entry.action === 'backup_restore_failed').length, 4);
    assert.ok(failures.some(entry => /sem arquivo/.test(entry.error)));
    assert.ok(failures.some(entry => entry.error === 'Erro no upload: tipo de arquivo não permitido.'));
    assert.equal(JSON.stringify(history.body).includes('Unexpected field'), false);
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
    // Mas o vínculo não libera um backup: item de biblioteca apontando para o banco
    // continua só do administrador (antes dava 200 ao professor).
    db.memory.library = [{ id: 'lib1', kind: 'file', courseId: courseA, filename: restoredName, url: `/uploads/${restoredName}` }];
    await request(app).get(`/uploads/${restoredName}`).set('x-admin-session', professorToken).expect(403);
    const plainJson = `${Date.now()}-778.json`;
    fs.writeFileSync(path.join(fileStore.UPLOADS_DIR, plainJson), JSON.stringify({ exercicios: [{ id: 1, enunciado: 'Some 2 + 2' }] }));
    db.memory.library.push({ id: 'lib2', kind: 'file', courseId: courseA, filename: plainJson, url: `/uploads/${plainJson}` });
    await request(app).get(`/uploads/${plainJson}`).set('x-admin-session', professorToken).expect(200);
    db.memory.library = [];
});

test('[UC-BACKUP-001] professor que liga um backup à estrutura da turma ou a um material não o baixa (decisão pelo conteúdo)', async () => {
    const fileStore = require('../../backend/utils/storage.js');
    const AdmZip = require('adm-zip');
    await db.save();
    const stamp = Date.now();
    const snapshot = backup.buildDataSnapshot();
    const files = {
        // Backup como o sistema gera, o mesmo editado à mão (chaves em outra ordem e
        // indentado), o backup completo em ZIP e um ZIP com o backup renomeado.
        json: `${stamp}-501.json`,
        edited: `${stamp}-502.json`,
        fullZip: `${stamp}-503.zip`,
        renamedZip: `${stamp}-504.zip`,
    };
    fs.writeFileSync(path.join(fileStore.UPLOADS_DIR, files.json), JSON.stringify(snapshot));
    const { type, ...rest } = snapshot;
    fs.writeFileSync(path.join(fileStore.UPLOADS_DIR, files.edited), JSON.stringify({ ...rest, type }, null, 2));
    fs.writeFileSync(path.join(fileStore.UPLOADS_DIR, files.fullZip), backup.buildFullZipBuffer());
    const renamed = new AdmZip();
    renamed.addFile('material/dados.json', Buffer.from(JSON.stringify(snapshot)));
    fs.writeFileSync(path.join(fileStore.UPLOADS_DIR, files.renamedZip), renamed.toBuffer());
    const unitFiles = Object.values(files).map((name, index) => ({ id: `f${index}`, name, path: `/uploads/${name}`, type: 'other' }));

    // Caminho exato do achado: o próprio professor salva a estrutura da turma com o link.
    const saved = await request(app).post(`/api/admin/courses/${courseA}/structure`).set('x-admin-session', professorToken)
        .send({ scope: 'class', studentClass: 'TURMA A', structure: [{ id: 'm1', name: 'Módulo', units: [{ id: 'u1', name: 'Unidade', apostilaKey: 'Apostila_G6', files: unitFiles }] }] });
    assert.equal(saved.status, 200, saved.body && saved.body.error);
    // E também pelo link de material na estrutura do curso.
    db.memory.courses[0].structure = [{ id: 'm1', units: [{ id: 'u1', apostilaKey: 'Apostila_G6_Curso', files: [] }] }];
    const linked = await request(app).post('/api/admin/material/link').set('x-admin-session', professorToken)
        .send({ apostilaKey: 'Apostila_G6_Curso', name: 'backup', url: `/uploads/${files.fullZip}` });
    assert.equal(linked.status, 200, linked.body && linked.body.error);

    for (const name of Object.values(files)) {
        const asProfessor = await request(app).get(`/uploads/${name}`).set('x-admin-session', professorToken);
        assert.equal(asProfessor.status, 403, `${name}: o professor baixava o banco com os hashes`);
        assert.doesNotMatch(asProfessor.text, /scrypt\$/);
        await request(app).get(`/uploads/${name}`).set('x-admin-session', adminToken).expect(200);
    }

    // Aluno com o backup na biblioteca do curso também não baixa.
    const login = await request(app).post('/api/student/login').send({ email: 'ana@g6.local', password: '123' });
    assert.equal(login.status, 200, login.body && login.body.error);
    db.memory.library = [{ id: 'lib-bkp', kind: 'file', courseId: courseA, filename: files.json, url: `/uploads/${files.json}` }];
    const asStudent = await request(app).get(`/uploads/${files.json}`).set('x-session-token', login.body.sessionToken);
    assert.equal(asStudent.status, 403);
    db.memory.library = [];
});

function sqliteFile(statements) {
    const file = path.join(tempRoot, `exemplo-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    return new Promise((resolve, reject) => {
        const database = new sqlite3.Database(file);
        database.serialize(() => statements.forEach(sql => database.run(sql)));
        database.close(error => {
            if (error) return reject(error);
            const bytes = fs.readFileSync(file);
            fs.rmSync(file, { force: true });
            resolve(bytes);
        });
    });
}

test('[UC-BACKUP-001] ZIP gravado como .json, ZIP com bytes antes, ZIP dentro de ZIP e pasta de dados com o banco: só o administrador', async () => {
    const fileStore = require('../../backend/utils/storage.js');
    const AdmZip = require('adm-zip');
    await db.save();
    const stamp = Date.now();
    const fullZip = backup.buildFullZipBuffer();
    const inner = new AdmZip();
    inner.addFile('copia.json', Buffer.from(JSON.stringify(backup.buildDataSnapshot())));
    const nested = new AdmZip();
    nested.addFile('pacote/material.zip', inner.toBuffer());
    // Banco do iClass (mesmo esquema de database.js), sem nenhum hash dentro.
    const iclassDb = await sqliteFile(['CREATE TABLE IF NOT EXISTS admins (key TEXT PRIMARY KEY, value TEXT)', 'CREATE TABLE IF NOT EXISTS students (key TEXT PRIMARY KEY, value TEXT)']);
    const dataFolder = new AdmZip();
    dataFolder.addFile('data/database.db', iclassDb);
    const disguisedDb = new AdmZip();
    disguisedDb.addFile('notas/planilha.bin', iclassDb);
    const files = {
        // Achado da revisão: o backup completo gravado com nome .json passava (200).
        zipAsJson: [`${stamp}-601.json`, fullZip],
        prefixedZip: [`${stamp}-602.json`, Buffer.concat([Buffer.from('MZ-autoextraivel-'), fullZip])],
        nestedZip: [`${stamp}-603.zip`, nested.toBuffer()],
        dataFolder: [`${stamp}-604.zip`, dataFolder.toBuffer()],
        disguisedDb: [`${stamp}-605.zip`, disguisedDb.toBuffer()],
        rawDbAsJson: [`${stamp}-606.json`, iclassDb],
    };
    Object.values(files).forEach(([name, bytes]) => fs.writeFileSync(path.join(fileStore.UPLOADS_DIR, name), bytes));
    const unitFiles = Object.values(files).map(([name], index) => ({ id: `z${index}`, name, path: `/uploads/${name}`, type: 'other' }));
    const saved = await request(app).post(`/api/admin/courses/${courseA}/structure`).set('x-admin-session', professorToken)
        .send({ scope: 'class', studentClass: 'TURMA A', structure: [{ id: 'm1', name: 'Módulo', units: [{ id: 'u1', name: 'Unidade', apostilaKey: 'Apostila_G6', files: unitFiles }] }] });
    assert.equal(saved.status, 200, saved.body && saved.body.error);
    const login = await request(app).post('/api/student/login').send({ email: 'ana@g6.local', password: '123' });
    assert.equal(login.status, 200, login.body && login.body.error);
    db.memory.library = Object.values(files).map(([name], index) => ({ id: `lib-z${index}`, kind: 'file', courseId: courseA, filename: name, url: `/uploads/${name}` }));
    for (const [label, [name]] of Object.entries(files)) {
        const asProfessor = await request(app).get(`/uploads/${name}`).set('x-admin-session', professorToken);
        assert.equal(asProfessor.status, 403, `${label}: o professor baixava`);
        const asStudent = await request(app).get(`/uploads/${name}`).set('x-session-token', login.body.sessionToken);
        assert.equal(asStudent.status, 403, `${label}: o aluno baixava`);
        // O ZIP gravado como .json sai com Content-Type de JSON: lê o corpo sem interpretar.
        const ignoreBody = (res, callback) => { res.on('data', () => {}); res.on('end', () => callback(null, null)); };
        await request(app).get(`/uploads/${name}`).set('x-admin-session', adminToken).parse(ignoreBody).expect(200);
    }
    db.memory.library = [];
});

test('[UC-BACKUP-001] backup compactado com gzip ou salvo em UTF-16 também é só do administrador; aula com .gz comum continua liberada', async () => {
    const fileStore = require('../../backend/utils/storage.js');
    const AdmZip = require('adm-zip');
    const zlib = require('node:zlib');
    await db.save();
    const stamp = Date.now();
    const json = JSON.stringify(backup.buildDataSnapshot());
    const gz = zlib.gzipSync(Buffer.from(json));
    const zipWithGz = new AdmZip();
    zipWithGz.addFile('dados.json.gz', gz);
    const zipWithBin = new AdmZip();
    zipWithBin.addFile('pasta/dados.bin', gz);
    const zipWithGzAsJson = new AdmZip();
    zipWithGzAsJson.addFile('dados.json', gz);
    const files = {
        gzipAsJson: [`${stamp}-801.json`, gz],
        utf16AsJson: [`${stamp}-802.json`, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')])],
        zipWithGz: [`${stamp}-803.zip`, zipWithGz.toBuffer()],
        zipWithBin: [`${stamp}-804.zip`, zipWithBin.toBuffer()],
        zipWithGzAsJson: [`${stamp}-805.zip`, zipWithGzAsJson.toBuffer()],
    };
    Object.values(files).forEach(([name, bytes]) => fs.writeFileSync(path.join(fileStore.UPLOADS_DIR, name), bytes));
    db.memory.library = Object.values(files).map(([name], index) => ({ id: `lib-gz${index}`, kind: 'file', courseId: courseA, filename: name, url: `/uploads/${name}` }));
    for (const [label, [name]] of Object.entries(files)) {
        const asProfessor = await request(app).get(`/uploads/${name}`).set('x-admin-session', professorToken);
        assert.equal(asProfessor.status, 403, `${label}: o professor baixava (antes 200)`);
    }
    // Material de aula com um .gz comum (dados de exemplo) continua liberado.
    const lesson = new AdmZip();
    lesson.addFile('aula/vendas.csv.gz', zlib.gzipSync(Buffer.from('produto;valor\nCaderno;12,50\n')));
    lesson.addFile('aula/roteiro.json', Buffer.from(JSON.stringify({ passos: ['abrir', 'somar'] })));
    const lessonName = `${stamp}-806.zip`;
    fs.writeFileSync(path.join(fileStore.UPLOADS_DIR, lessonName), lesson.toBuffer());
    const plainGzName = `${stamp}-807.json`;
    fs.writeFileSync(path.join(fileStore.UPLOADS_DIR, plainGzName), zlib.gzipSync(Buffer.from(JSON.stringify({ exercicio: 1 }))));
    db.memory.library.push(
        { id: 'lib-gz-aula', kind: 'file', courseId: courseA, filename: lessonName, url: `/uploads/${lessonName}` },
        { id: 'lib-gz-json', kind: 'file', courseId: courseA, filename: plainGzName, url: `/uploads/${plainGzName}` },
    );
    const ignoreBody = (res, callback) => { res.on('data', () => {}); res.on('end', () => callback(null, null)); };
    await request(app).get(`/uploads/${lessonName}`).set('x-admin-session', professorToken).parse(ignoreBody).expect(200);
    await request(app).get(`/uploads/${plainGzName}`).set('x-admin-session', professorToken).parse(ignoreBody).expect(200);
    db.memory.library = [];
});

test('[UC-BACKUP-001] material de aula em ZIP com um banco SQLite de exemplo continua liberado ao aluno e ao professor', async () => {
    const fileStore = require('../../backend/utils/storage.js');
    const AdmZip = require('adm-zip');
    const lojaDb = await sqliteFile([
        'CREATE TABLE produtos (id INTEGER PRIMARY KEY, nome TEXT, preco REAL)',
        "INSERT INTO produtos (nome, preco) VALUES ('Caderno', 12.5), ('Caneta', 3.2)",
        'CREATE TABLE usuarios (id INTEGER PRIMARY KEY, login TEXT, senha TEXT)',
        "INSERT INTO usuarios (login, senha) VALUES ('admin', '1234')",
    ]);
    const zip = new AdmZip();
    zip.addFile('aula-sql/loja.db', lojaDb);
    zip.addFile('aula-sql/loja.sqlite3', lojaDb);
    zip.addFile('aula-sql/roteiro.txt', Buffer.from('Faça SELECT * FROM produtos;'));
    zip.addFile('aula-sql/dados.json', Buffer.from(JSON.stringify({ produtos: [{ nome: 'Caderno' }] })));
    // Slides (.pptx é ZIP) com uma planilha (.xlsx, outro ZIP) dentro: três níveis de ZIP legítimos.
    const xlsx = new AdmZip();
    xlsx.addFile('xl/workbook.xml', Buffer.from('<?xml version="1.0"?><workbook/>'));
    const pptx = new AdmZip();
    pptx.addFile('ppt/presentation.xml', Buffer.from('<?xml version="1.0"?><presentation/>'));
    pptx.addFile('ppt/embeddings/Planilha.xlsx', xlsx.toBuffer());
    const inner = new AdmZip();
    inner.addFile('slides/aula.pptx', pptx.toBuffer());
    zip.addFile('aula-sql/extras.zip', inner.toBuffer());
    const name = `${Date.now()}-701.zip`;
    fs.writeFileSync(path.join(fileStore.UPLOADS_DIR, name), zip.toBuffer());
    db.memory.library = [{ id: 'lib-sql', kind: 'file', courseId: courseA, filename: name, url: `/uploads/${name}` }];
    const login = await request(app).post('/api/student/login').send({ email: 'ana@g6.local', password: '123' });
    // Antes: 403 "Arquivo disponível só para o administrador." para aluno e professor.
    const asStudent = await request(app).get(`/uploads/${name}`).set('x-session-token', login.body.sessionToken);
    assert.equal(asStudent.status, 200, asStudent.body && asStudent.body.error);
    const asProfessor = await request(app).get(`/uploads/${name}`).set('x-admin-session', professorToken);
    assert.equal(asProfessor.status, 200, asProfessor.body && asProfessor.body.error);
    db.memory.library = [];
});

test('[UC-BACKUP-001] a conferência do ZIP não lê o arquivo inteiro de forma síncrona (não trava o servidor)', async () => {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    zip.addFile('video/aula.mp4', Buffer.alloc(4 * 1024 * 1024, 7));
    zip.addFile('exercicios.json', Buffer.from(JSON.stringify({ lista: [1, 2, 3] })));
    const file = path.join(tempRoot, `${Date.now()}-sync.zip`);
    fs.writeFileSync(file, zip.toBuffer());
    const originalReadFileSync = fs.readFileSync;
    const syncReads = [];
    fs.readFileSync = function patched(target, ...args) {
        if (String(target) === file) syncReads.push(target);
        return originalReadFileSync.call(this, target, ...args);
    };
    try {
        assert.equal(await backup.fileLooksLikeBackup(file), false);
    } finally {
        fs.readFileSync = originalReadFileSync;
    }
    // Antes o adm-zip lia o ZIP inteiro com readFileSync no primeiro pedido.
    assert.deepEqual(syncReads, []);
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

test('[UC-PRIVACIDADE-001] professor não recebe o texto de saúde por nenhuma rota (cópia do aluno nas entregas, lixeira de notas e auditoria)', async () => {
    const ana = db.memory.students.find(s => s.email === 'ana@g6.local');
    const { password, ...snapshot } = ana;
    const applicationId = 'app_g6_privacidade';
    db.memory.examApplications = [{
        id: applicationId, examKey, courseId: courseA, studentClass: 'TURMA A', status: 'finished',
        mode: 'collective', durationMinutes: 30, startsAt: Date.now() - 3600000, finishedAt: Date.now() - 60000,
    }];
    // A entrega guarda a ficha inteira do aluno (examGrading.createSubmissionFromAttempt), com o laudo.
    const sub = {
        id: 'sub_g6_privacidade', student: { ...snapshot, studentClass: 'TURMA A', courseId: courseA }, examKey, applicationId,
        attemptId: 'att_g6', score: 80, correctCount: 4, totalCount: 5, gradedAnswers: [], gradePublished: true,
        timestamp: new Date().toISOString(),
    };
    db.memory.submissions = [sub];
    db.memory.auditLogs = [{
        action: 'grade_delete', actor: 'admin@g6.local', timestamp: Date.now(), studentEmail: 'ana@g6.local',
        details: { deletedSubmission: { ...sub, id: 'sub_g6_lixeira' } },
    }];

    const asAdmin = await request(app).get(`/api/admin/submissions?courseId=${courseA}&studentClass=TURMA%20A`).set('x-admin-session', adminToken);
    assert.equal(asAdmin.status, 200);
    assert.match(JSON.stringify(asAdmin.body), /Laudo de TDAH/);

    const direct = await request(app).get(`/api/admin/submissions?courseId=${courseA}&studentClass=TURMA%20A`).set('x-admin-session', professorToken);
    assert.equal(direct.status, 200);
    const mine = direct.body.find(item => item.id === 'sub_g6_privacidade');
    assert.ok(mine, 'o professor continua vendo a entrega');
    assert.equal(mine.student.accessibility.tempoAdicional, true);
    assert.equal(mine.student.accessibility.observacao, '');
    assert.equal(mine.student.accessibilityNoteRestricted, true);
    // O banco não é alterado pela máscara.
    assert.equal(db.memory.submissions[0].student.accessibility.observacao, 'Laudo de TDAH, CID F90');

    // Varredura: toda rota GET de instrutor, com os parâmetros da turma, da prova e da aluna.
    const routesDir = path.join(__dirname, '../../backend/routes');
    const paths = new Set();
    for (const file of fs.readdirSync(routesDir)) {
        const source = fs.readFileSync(path.join(routesDir, file), 'utf8');
        for (const match of source.matchAll(/router\.get\(\[?'(\/api\/admin\/[^']*)'/g)) paths.add(match[1]);
    }
    assert.ok(paths.size > 40, `rotas encontradas: ${paths.size}`);
    const query = new URLSearchParams({
        courseId: courseA, studentClass: 'TURMA A', className: 'TURMA A', email: 'ana@g6.local', studentEmail: 'ana@g6.local',
        examKey, applicationId,
    }).toString();
    const answered = [];
    for (const routePath of paths) {
        const url = routePath
            .replace(':class', encodeURIComponent('TURMA A'))
            .replace(':examKey', examKey)
            .replace(':key', examKey)
            .replace(':applicationId', applicationId)
            .replace(':id/review', 'sub_g6_privacidade/review')
            .replace(':id', courseA);
        const res = await request(app).get(`${url}?${query}`).set('x-admin-session', professorToken);
        const text = res.text || JSON.stringify(res.body || '');
        assert.doesNotMatch(text, /TDAH|F90/, `${routePath} devolveu o texto de saúde ao professor`);
        if (res.status === 200) answered.push(routePath);
    }
    for (const expected of ['/api/admin/submissions', '/api/admin/submissions/deleted', '/api/admin/student/academic', '/api/admin/submissions/:id/review']) {
        assert.ok(answered.includes(expected), `${expected} deveria responder ao professor`);
    }
});
