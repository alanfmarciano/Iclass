// Situação do aluno e cadastros encerrados (H7c; FUN-03, CONF-09, decisão 4 do Alan).
// O aluno é desligado (bulk-status com quando, quem e por quê), aparece em Cadastros
// encerrados e só ali, pelo administrador e caso a caso, é anonimizado ou apagado de vez.
// O antigo delete-student responde 410 e não mexe em nada.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-lifecycle-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { scrubReason } = require('../../backend/utils/studentLifecycle.js');

let app;
const adminToken = 'admin-token-lifecycle';
const professorToken = 'professor-token-lifecycle';
const COURSE = 'curso-vida';
const CLASS = '1VID';
const ANA = {
    name: 'Ana Souza Lima',
    email: 'ana.souza@vida.local',
    matricula: 'MAT-77881',
    phone: '(11) 98888-1234',
    guardianPhone: '(11) 97777-4321',
};

function seed() {
    db.memory.admins = [
        { email: 'admin@vida.local', name: 'Admin', role: 'admin', password: db.hashPassword('x') },
        { email: 'prof@vida.local', name: 'Professor', role: 'professor', password: db.hashPassword('x'), assignedClasses: [{ courseId: COURSE, className: CLASS }] },
    ];
    db.memory.adminSessions = {
        [adminToken]: { email: 'admin@vida.local', createdAt: Date.now(), lastSeen: Date.now() },
        [professorToken]: { email: 'prof@vida.local', createdAt: Date.now(), lastSeen: Date.now() },
    };
    db.memory.courses = [{ id: COURSE, name: 'Curso da vida', structure: [] }];
    db.memory.classes = [{ name: CLASS, courseId: COURSE, period: 'Manhã' }];
    db.memory.students = [
        {
            ...ANA,
            nomeSocial: 'Aninha',
            status: 'Ativo',
            password: db.hashPassword('Senha-forte-123'),
            classes: [{ name: CLASS, courseId: COURSE }],
            unidade: 'Unidade Centro',
            createdAt: '2025-02-01T12:00:00.000Z',
        },
        { name: 'Bruno Alves', email: 'bruno@vida.local', status: 'Ativo', password: db.hashPassword('Senha-forte-123'), classes: [{ name: CLASS, courseId: COURSE }] },
    ];
    db.memory.submissions = [
        { id: 'sub-ana', student: { name: ANA.name, email: ANA.email, studentClass: CLASS, courseId: COURSE, phone: ANA.phone, matricula: ANA.matricula }, studentName: ANA.name, studentMatricula: ANA.matricula, examKey: 'Prova_1', score: 80, timestamp: '2026-03-01T12:00:00.000Z' },
        { id: 'sub-bruno', student: { name: 'Bruno Alves', email: 'bruno@vida.local', studentClass: CLASS, courseId: COURSE }, examKey: 'Prova_1', score: 60, timestamp: '2026-03-01T12:00:00.000Z' },
    ];
    db.memory.attendance = [
        { id: 'att-ana-1', studentEmail: ANA.email, studentClass: CLASS, courseId: COURSE, date: '2026-03-02', status: 'presente', ip: '10.0.0.5', userAgent: 'Navegador da Ana', observacao: `Ana Souza Lima chegou com o pai, tel ${ANA.phone}`, origin: 'login' },
        { id: 'att-ana-2', studentEmail: ANA.email, studentClass: CLASS, courseId: COURSE, date: '2026-03-03', status: 'falta', justificativa: { tipo: 'atestado', texto: `Atestado da ${ANA.name}`, arquivo: 'alunos/x/atestado.pdf', abonado: true } },
        { id: 'att-bruno', studentEmail: 'bruno@vida.local', studentClass: CLASS, courseId: COURSE, date: '2026-03-02', status: 'presente' },
    ];
    db.memory.certificates = [
        { id: 'cert-ana', studentEmail: ANA.email, courseId: COURSE, issuedAt: '2026-04-01T12:00:00.000Z', code: 'CERT-1' },
    ];
    db.memory.progress = { [ANA.email]: { Apostila_1: { percent: 50 } } };
    db.memory.notes = { [ANA.email]: { Apostila_1: `Anotação da ${ANA.name}` } };
    db.memory.annotations = {};
    db.memory.pedagogicalObservations = [{ id: 'obs-1', studentEmail: ANA.email, text: `A ${ANA.name} precisa de apoio` }];
    db.memory.loginLogs = [{ email: ANA.email, role: 'student', status: 'success', ip: '10.0.0.5', timestamp: Date.now() - 1000 }];
    db.memory.moduleAccess = [{ studentEmail: ANA.email, moduleId: 'm1', at: Date.now() - 1000 }];
    db.memory.proctoringLogs = [];
    db.memory.forum = [];
    db.memory.broadcastMessages = [];
    db.memory.announcements = [];
    db.memory.studentExamState = {};
    db.memory.examApplications = [];
    db.memory.sessions = {};
    db.memory.auditLogs = [];
}

const admin = (req) => req.set('x-admin-session', adminToken);
const professor = (req) => req.set('x-admin-session', professorToken);
const findStudent = (email) => db.memory.students.find(item => item.email === email);
const desligar = (body) => admin(request(app).post('/api/admin/student/bulk-status')).send(body);
const anonymize = (body) => admin(request(app).post('/api/admin/students/anonymize')).send(body);
const purge = (body) => admin(request(app).post('/api/admin/students/purge')).send(body);
const closedList = () => admin(request(app).get('/api/admin/students/closed'));

test.before(async () => {
    await db.init();
    app = createApp();
});
test.beforeEach(() => { seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-ENCERRADOS-001] delete-student responde 410 e não apaga nada', async () => {
    const before = JSON.stringify(db.memory.students);
    const res = await admin(request(app).post('/api/admin/delete-student')).send({ email: ANA.email });
    assert.equal(res.status, 410);
    assert.equal(res.body.success, false);
    assert.equal(res.body.code, 'student_delete_replaced');
    assert.match(res.body.error, /Cadastros encerrados/);
    assert.equal(JSON.stringify(db.memory.students), before);
    assert.equal(db.memory.submissions.length, 2);
    assert.equal(db.memory.attendance.length, 3);
});

test('[UC-ENCERRADOS-001] desligar grava quando, quem e o motivo; o aluno não entra e aparece em Cadastros encerrados', async () => {
    const t0 = Date.now();
    const res = await desligar({ emails: [ANA.email], status: 'Transferido', reason: '  Mudou de cidade  ' });
    assert.equal(res.status, 200, res.body.error);
    assert.equal(res.body.updated, 1);
    const ana = findStudent(ANA.email);
    assert.equal(ana.status, 'Transferido');
    assert.ok(ana.statusChangedAt >= t0 && ana.statusChangedAt <= Date.now());
    assert.equal(ana.statusChangedBy, 'admin@vida.local');
    assert.equal(ana.statusReason, 'Mudou de cidade');
    const entry = db.memory.auditLogs.find(item => item.studentEmail === ANA.email && item.field === 'Status');
    assert.ok(entry, 'mudança de situação na auditoria');
    assert.equal(entry.newValue, 'Transferido');
    assert.equal(entry.reason, 'Mudou de cidade');

    // Notas, presença e certificados ficam.
    assert.equal(db.memory.submissions.length, 2);
    assert.equal(db.memory.attendance.length, 3);
    assert.equal(db.memory.certificates.length, 1);

    const login = await request(app).post('/api/student/login').send({ email: ANA.email, password: 'Senha-forte-123' });
    assert.equal(login.status, 403);

    const list = await closedList();
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 1);
    const row = list.body.items[0];
    assert.equal(row.email, ANA.email);
    assert.equal(row.status, 'Transferido');
    assert.equal(row.since, ana.statusChangedAt);
    assert.equal(row.by, 'admin@vida.local');
    assert.equal(row.reason, 'Mudou de cidade');
    assert.equal(row.anonymized, false);
    assert.deepEqual(row.counts, { submissions: 1, attendance: 2, certificates: 1 });
    assert.deepEqual(row.classes, [{ name: CLASS, courseId: COURSE }]);
    assert.ok('lastBackupAt' in list.body);
});

test('[UC-ENCERRADOS-001] situação Anonimizado e motivo inválido são recusados no bulk-status e na edição', async () => {
    const bulk = await desligar({ emails: [ANA.email], status: 'Anonimizado' });
    assert.equal(bulk.status, 400);
    assert.equal(bulk.body.field, 'status');
    const unknown = await desligar({ emails: [ANA.email], status: 'Sumido' });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.field, 'status');
    const long = await desligar({ emails: [ANA.email], status: 'Inativo', reason: 'x'.repeat(501) });
    assert.equal(long.status, 400);
    assert.equal(long.body.field, 'reason');
    const notText = await desligar({ emails: [ANA.email], status: 'Inativo', reason: 42 });
    assert.equal(notText.status, 400);
    assert.equal(notText.body.field, 'reason');
    const update = await admin(request(app).post('/api/admin/student/update'))
        .send({ originalEmail: ANA.email, email: ANA.email, name: ANA.name, classes: [{ name: CLASS, courseId: COURSE }], status: 'Anonimizado' });
    assert.equal(update.status, 400);
    assert.equal(update.body.field, 'status');
    assert.equal(findStudent(ANA.email).status, 'Ativo');
});

test('[UC-ENCERRADOS-002] professor não lista, não anonimiza nem apaga', async () => {
    await desligar({ emails: [ANA.email], status: 'Inativo', reason: 'Saiu' }).expect(200);
    const list = await professor(request(app).get('/api/admin/students/closed'));
    assert.equal(list.status, 403);
    const anon = await professor(request(app).post('/api/admin/students/anonymize')).send({ email: ANA.email, confirm: 'ANONIMIZAR', reason: 'Pedido da família' });
    assert.equal(anon.status, 403);
    const del = await professor(request(app).post('/api/admin/students/purge')).send({ email: ANA.email, confirm: 'APAGAR', reason: 'Pedido da família' });
    assert.equal(del.status, 403);
    assert.equal(findStudent(ANA.email).status, 'Inativo');
});

test('[UC-ENCERRADOS-002] anonimizar pede cadastro encerrado, a palavra e o motivo', async () => {
    const active = await anonymize({ email: ANA.email, confirm: 'ANONIMIZAR', reason: 'Pedido da família' });
    assert.equal(active.status, 409);
    assert.equal(active.body.code, 'student_not_closed');
    const activePurge = await purge({ email: ANA.email, confirm: 'APAGAR', reason: 'Pedido da família' });
    assert.equal(activePurge.status, 409);
    assert.equal(activePurge.body.code, 'student_not_closed');

    await desligar({ emails: [ANA.email], status: 'Inativo' }).expect(200);
    const noWord = await anonymize({ email: ANA.email, confirm: 'APAGAR', reason: 'Pedido da família' });
    assert.equal(noWord.status, 400);
    assert.equal(noWord.body.code, 'confirm_required');
    assert.equal(noWord.body.field, 'confirm');
    const noReason = await anonymize({ email: ANA.email, confirm: 'ANONIMIZAR', reason: ' ' });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.code, 'reason_required');
    assert.equal(noReason.body.field, 'reason');
    const noEmail = await anonymize({ email: 123, confirm: 'ANONIMIZAR', reason: 'Pedido da família' });
    assert.equal(noEmail.status, 400);
    assert.equal(noEmail.body.field, 'email');
    const missing = await anonymize({ email: 'ninguem@vida.local', confirm: 'ANONIMIZAR', reason: 'Pedido da família' });
    assert.equal(missing.status, 404);
    assert.equal(findStudent(ANA.email).status, 'Inativo');
    assert.equal(findStudent(ANA.email).name, ANA.name);
});

test('[UC-ENCERRADOS-002] anonimizar tira os dados pessoais de tudo e guarda notas, presença e certificados sob o pseudônimo', async () => {
    // Teclas da prova da Ana e do Bruno, na tabela própria.
    await db.keystrokes.append([
        { studentEmail: ANA.email, examKey: 'Prova_1', applicationId: 'app-1', seq: 1, key: 'a', timestamp: Date.now() },
        { studentEmail: ANA.email, examKey: 'Prova_1', applicationId: 'app-1', seq: 2, key: 'b', timestamp: Date.now() },
        { studentEmail: 'bruno@vida.local', examKey: 'Prova_1', applicationId: 'app-1', seq: 1, key: 'c', timestamp: Date.now() },
    ]);
    assert.equal((await db.keystrokes.findByEmails([ANA.email])).length, 2);

    await desligar({ emails: [ANA.email], status: 'Evadido', reason: `Ana Souza Lima (${ANA.matricula}) parou de vir` }).expect(200);
    const closedAt = findStudent(ANA.email).statusChangedAt;
    const cyclesBefore = db.storageStatus().savesSinceBoot;
    const res = await anonymize({ email: ANA.email, confirm: 'anonimizar', reason: `Pedido da Ana Souza Lima, ${ANA.email}` });
    assert.equal(res.status, 200, res.body.error);
    assert.match(res.body.email, /^anonimizado-[0-9a-f]{12}@anonimizado\.invalid$/);
    assert.match(res.body.name, /^Aluno anonimizado [0-9A-F]{6}$/);
    assert.deepEqual(res.body.kept, { submissions: 1, attendance: 2, certificates: 1 });
    assert.ok(res.body.anonymizedAt > 0);
    // Memória e teclas numa transação só (um ciclo de gravação).
    assert.equal(db.storageStatus().savesSinceBoot - cyclesBefore, 1);

    const pseudo = res.body.email;
    const record = findStudent(pseudo);
    assert.ok(record, 'cadastro fica no lugar, com o pseudônimo');
    assert.equal(record.status, 'Anonimizado');
    assert.equal(record.anonymizedAt, res.body.anonymizedAt, 'anonymizedAt gravado (o H4a lê)');
    assert.equal(record.anonymizedBy, 'admin@vida.local');
    assert.equal(record.statusChangedAt, closedAt, 'continua contando do desligamento');
    assert.equal(record.password, '');
    assert.equal(record.matricula, '');
    assert.deepEqual(record.classes, [{ name: CLASS, courseId: COURSE }]);

    // Nenhum dado pessoal da Ana sobra na memória.
    const dump = JSON.stringify(db.memory);
    [ANA.email, ANA.name, 'Ana Souza', ANA.matricula, ANA.phone, ANA.guardianPhone, 'Aninha', 'Unidade Centro', '10.0.0.5', 'Navegador da Ana']
        .forEach(value => assert.ok(!dump.includes(value), `sobrou "${value}" na memória`));

    // Ficam com o pseudônimo: nota, presença (sem texto, arquivo, IP), certificado.
    const sub = db.memory.submissions.find(item => item.id === 'sub-ana');
    assert.equal(sub.student.email, pseudo);
    assert.equal(sub.score, 80);
    assert.equal(sub.student.phone, undefined);
    const att = db.memory.attendance.filter(item => item.studentEmail === pseudo);
    assert.equal(att.length, 2);
    const justified = att.find(item => item.id === 'att-ana-2');
    assert.deepEqual(justified.justificativa, { tipo: 'atestado', abonado: true });
    assert.equal(att.find(item => item.id === 'att-ana-1').ip, undefined);
    assert.equal(db.memory.certificates[0].studentEmail, pseudo);
    // Bruno não muda.
    assert.equal(db.memory.submissions.find(item => item.id === 'sub-bruno').student.email, 'bruno@vida.local');
    assert.equal(db.memory.attendance.find(item => item.id === 'att-bruno').studentEmail, 'bruno@vida.local');

    // Saem progresso, anotações, observações, logs.
    assert.equal(db.memory.progress[ANA.email], undefined);
    assert.equal(db.memory.pedagogicalObservations.length, 0);
    assert.equal(db.memory.loginLogs.filter(item => item.email === ANA.email).length, 0);

    // Teclas: as da Ana saíram, as do Bruno ficam.
    assert.deepEqual(await db.keystrokes.findByEmails([ANA.email]), []);
    assert.equal((await db.keystrokes.findByEmails(['bruno@vida.local'])).length, 1);

    // Auditoria: entrada student_anonymized só com o pseudônimo; o motivo sem o nome nem o e-mail.
    const entry = db.memory.auditLogs.find(item => item.action === 'student_anonymized');
    assert.ok(entry);
    assert.equal(entry.studentEmail, pseudo);
    assert.ok(!entry.reason.includes('Ana'));
    assert.ok(entry.reason.includes(res.body.name));
    // A trilha do desligamento continua, com o pseudônimo.
    assert.ok(db.memory.auditLogs.some(item => item.field === 'Status' && item.studentEmail === pseudo));

    // Cadastros encerrados mostra o anonimizado.
    const list = await closedList().expect(200);
    const row = list.body.items.find(item => item.email === pseudo);
    assert.equal(row.anonymized, true);
    assert.equal(row.status, 'Anonimizado');
    assert.equal(row.anonymizedAt, res.body.anonymizedAt);
    assert.equal(row.matricula, '');
    assert.deepEqual(row.counts, { submissions: 1, attendance: 2, certificates: 1 });

    // O e-mail antigo fica livre para um cadastro novo.
    const again = await admin(request(app).post('/api/admin/student/create'))
        .send({ name: 'Ana Nova', email: ANA.email, classes: [{ name: CLASS, courseId: COURSE }], studentPassword: '' });
    assert.equal(again.status, 200, again.body.error);
});

test('[UC-ENCERRADOS-002] cadastro anonimizado não é editado, reativado, nem anonimizado de novo; pode ser apagado de vez', async () => {
    await desligar({ emails: [ANA.email], status: 'Inativo' }).expect(200);
    const res = await anonymize({ email: ANA.email, confirm: 'ANONIMIZAR', reason: 'Pedido da família' }).expect(200);
    const pseudo = res.body.email;

    const update = await admin(request(app).post('/api/admin/student/update'))
        .send({ originalEmail: pseudo, email: pseudo, name: 'Ana de volta', classes: [{ name: CLASS, courseId: COURSE }], status: 'Ativo' });
    assert.equal(update.status, 409);
    assert.equal(update.body.code, 'student_anonymized');
    const reactivate = await desligar({ emails: [pseudo], status: 'Ativo', reason: 'Voltou' });
    assert.equal(reactivate.status, 200);
    assert.equal(reactivate.body.updated, 0);
    assert.equal(reactivate.body.skipped[0].reason, 'Cadastro anonimizado.');
    const reset = await admin(request(app).post('/api/admin/reset-password')).send({ email: pseudo });
    assert.equal(reset.status, 409);
    assert.equal(reset.body.code, 'student_anonymized');
    const twice = await anonymize({ email: pseudo, confirm: 'ANONIMIZAR', reason: 'De novo' });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.code, 'already_anonymized');
    assert.equal(findStudent(pseudo).status, 'Anonimizado');

    // Chamada de data nova: o anonimizado não aparece.
    const roster = await admin(request(app).get('/api/admin/attendance/roster')).query({ studentClass: CLASS, courseId: COURSE, date: '2099-01-05' }).expect(200);
    const emails = (roster.body.roster || roster.body.students || []).map(item => item.email);
    assert.ok(!emails.includes(pseudo));

    const gone = await purge({ email: pseudo, confirm: 'APAGAR', reason: 'Fim do prazo legal' });
    assert.equal(gone.status, 200, gone.body.error);
    assert.deepEqual(gone.body.removed, { submissions: 1, attendance: 2, certificates: 1 });
    assert.equal(findStudent(pseudo), undefined);
    assert.equal(db.memory.submissions.filter(item => item.student.email === pseudo).length, 0);
    const entry = db.memory.auditLogs.find(item => item.action === 'student_purged');
    assert.ok(entry);
    assert.equal(entry.details.wasAnonymized, true);
    assert.ok(!JSON.stringify(entry).includes(pseudo));
});

test('[UC-ENCERRADOS-002] apagar de vez remove o cadastro e deixa a auditoria sem dado pessoal', async () => {
    await desligar({ emails: [ANA.email], status: 'Concluído', reason: 'Formou' }).expect(200);
    const res = await purge({ email: ANA.email, confirm: 'APAGAR', reason: `Matrícula da ${ANA.name} feita por engano` });
    assert.equal(res.status, 200, res.body.error);
    assert.deepEqual(res.body.removed, { submissions: 1, attendance: 2, certificates: 1 });
    assert.equal(findStudent(ANA.email), undefined);
    assert.equal(db.memory.attendance.length, 1);
    assert.equal(db.memory.certificates.length, 0);
    const dump = JSON.stringify(db.memory);
    [ANA.email, ANA.name, ANA.matricula, ANA.phone].forEach(value => assert.ok(!dump.includes(value), `sobrou "${value}"`));
    const entry = db.memory.auditLogs.find(item => item.action === 'student_purged');
    assert.ok(entry);
    assert.equal(entry.reason, 'Matrícula da aluno feita por engano');
    assert.ok(!entry.studentEmail);
});

test('[UC-ENCERRADOS-003] aluno desligado antes da atualização: data pela auditoria na chamada e em Cadastros encerrados', async () => {
    // Banco antigo: status Inativo sem statusChangedAt, com a alteração de Status na auditoria.
    const changedAt = Date.parse('2026-03-10T15:00:00.000Z');
    Object.assign(findStudent(ANA.email), { status: 'Inativo' });
    db.memory.auditLogs = [
        { id: 'old-1', timestamp: changedAt, actor: 'admin@vida.local', studentEmail: ANA.email, field: 'Status', oldValue: 'Ativo', newValue: 'Inativo' },
    ];
    db.memory.students.push({ name: 'Caio Sem Data', email: 'caio@vida.local', status: 'Evadido', classes: [{ name: CLASS, courseId: COURSE }] });

    const list = await closedList().expect(200);
    const ana = list.body.items.find(item => item.email === ANA.email);
    assert.equal(ana.since, changedAt);
    const caio = list.body.items.find(item => item.email === 'caio@vida.local');
    assert.equal(caio.since, null, 'sem data registrada');
    // Ordem: o mais antigo primeiro; sem data no fim.
    assert.deepEqual(list.body.items.map(item => item.email), [ANA.email, 'caio@vida.local']);

    const rosterEmails = async (date) => {
        const roster = await admin(request(app).get('/api/admin/attendance/roster')).query({ studentClass: CLASS, courseId: COURSE, date }).expect(200);
        return (roster.body.roster || roster.body.students || []).map(item => item.email);
    };
    // Antes do desligamento (pela auditoria): a Ana entra na chamada atrasada.
    assert.ok((await rosterEmails('2026-03-09')).includes(ANA.email));
    // Depois: não entra.
    assert.ok(!(await rosterEmails('2026-03-11')).includes(ANA.email));
    // Sem data nenhuma: só com registro na data.
    assert.ok(!(await rosterEmails('2026-03-09')).includes('caio@vida.local'));
});

test('[UC-ENCERRADOS-003] anonimizar aluno desligado sem data conhecida não o põe na chamada de datas antigas', async () => {
    // Banco antigo: Inativo sem statusChangedAt e sem a mudança na auditoria.
    Object.assign(findStudent(ANA.email), { status: 'Inativo' });
    const res = await anonymize({ email: ANA.email, confirm: 'ANONIMIZAR', reason: 'Pedido da família' }).expect(200);
    const record = findStudent(res.body.email);
    assert.equal(record.statusChangedAt, null, 'sem data inventada');
    assert.ok(record.anonymizedAt > 0);
    const list = await closedList().expect(200);
    assert.equal(list.body.items.find(item => item.email === res.body.email).since, null);
    assert.ok(list.body.lastBackupAt === null || Number.isInteger(list.body.lastBackupAt));
    const roster = await admin(request(app).get('/api/admin/attendance/roster')).query({ studentClass: CLASS, courseId: COURSE, date: '2026-01-05' }).expect(200);
    const emails = (roster.body.roster || roster.body.students || []).map(item => item.email);
    assert.ok(!emails.includes(res.body.email));
});

test('[UC-ENCERRADOS-003] reativar volta a Ativo com o motivo e tira de Cadastros encerrados', async () => {
    await desligar({ emails: [ANA.email], status: 'Inativo', reason: 'Trancou' }).expect(200);
    const back = await desligar({ emails: [ANA.email], status: 'Ativo', reason: 'Voltou a estudar' });
    assert.equal(back.status, 200);
    assert.equal(back.body.updated, 1);
    const ana = findStudent(ANA.email);
    assert.equal(ana.status, 'Ativo');
    assert.equal(ana.statusReason, 'Voltou a estudar');
    const list = await closedList().expect(200);
    assert.equal(list.body.total, 0);
    const login = await request(app).post('/api/student/login').send({ email: ANA.email, password: 'Senha-forte-123' });
    assert.notEqual(login.status, 403);
});

test('scrubReason tira e-mail, nome e matrícula sem pegar pedaço de palavra', () => {
    const out = scrubReason('Ana Souza (MAT-1) e ana@x.local; Anabela fica', {
        emails: ['ana@x.local'], names: ['Ana Souza', 'Ana'], matriculas: ['MAT-1'], replacement: 'aluno',
    });
    assert.equal(out, 'aluno () e aluno; Anabela fica');
});
