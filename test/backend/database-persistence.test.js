const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-db-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');

function readOne(databasePath, sql, params = []) {
    return new Promise((resolve, reject) => {
        const reader = new sqlite3.Database(databasePath);
        reader.get(sql, params, (err, row) => {
            reader.close(closeError => {
                if (err || closeError) reject(err || closeError);
                else resolve(row);
            });
        });
    });
}

test.after(async () => {
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('save só resolve depois que o COMMIT pode ser lido por outra conexão', async () => {
    await db.init();
    db.memory.notes['persistencia@teste.local'] = { texto: 'confirmado' };
    await db.save();

    const row = await readOne(
        path.join(tempRoot, 'database.db'),
        'SELECT value FROM notes WHERE key = ?',
        ['persistencia@teste.local']
    );
    assert.deepEqual(JSON.parse(row.value), { texto: 'confirmado' });
});

test('scrypt usa salt individual e aceita validação', () => {
    const first = db.hashPassword('segredo-forte');
    const second = db.hashPassword('segredo-forte');
    assert.notEqual(first, second);
    assert.match(first, /^scrypt\$/);
    assert.equal(db.verifyPassword(first, 'segredo-forte'), true);
    assert.equal(db.verifyPassword(first, 'incorreta'), false);
});

test('administradores são vinculados automaticamente a todas as turmas', async () => {
    db.memory.classes = [
        { name: 'Turma A', courseId: 'curso-1' },
        { name: 'Turma B', courseId: 'curso-2' },
    ];
    db.memory.admins = [
        { name: 'Admin', email: 'admin-turmas@teste.local', role: 'admin', assignedClasses: [] },
        { name: 'Professor', email: 'professor-turmas@teste.local', role: 'professor', assignedClasses: [{ courseId: 'curso-1', className: 'Turma A' }] },
    ];

    await db.save();
    assert.deepEqual(db.memory.admins[0].assignedClasses, [
        { courseId: 'curso-1', className: 'Turma A' },
        { courseId: 'curso-2', className: 'Turma B' },
    ]);
    assert.deepEqual(db.memory.admins[1].assignedClasses, [{ courseId: 'curso-1', className: 'Turma A' }]);

    db.memory.classes.push({ name: 'Turma C', courseId: 'curso-3' });
    await db.save();
    assert.deepEqual(db.memory.admins[0].assignedClasses.at(-1), { courseId: 'curso-3', className: 'Turma C' });

    db.memory.classes = db.memory.classes.filter(cls => cls.name !== 'Turma B');
    await db.save();
    assert.equal(db.memory.admins[0].assignedClasses.some(item => item.className === 'Turma B'), false);
});

test('estado da prova fixa versão, questões e prazo no servidor', () => {
    const { initializeExamState } = require('../../backend/middlewares.js');
    const now = Date.now();
    const state = { assignedVersion: 'A', individualTimeAdjustment: 5 };
    const changed = initializeExamState(state, {
        onlineActive: true,
        startTime: now - 1000,
        durationMinutes: 30,
        globalTimeAdjustment: 2,
        versionSnapshots: [{ version: 'A', questions: [{ originalNumber: 7 }, { originalNumber: 3 }] }],
    });
    assert.equal(changed, true);
    assert.deepEqual(state.assignedQuestionNumbers, [7, 3]);
    assert.equal(state.startedAt, now - 1000);
    assert.equal(state.deadlineAt, now - 1000 + 37 * 60000);
});

test('backup de dados faz round-trip de SQLite e Markdown', async () => {
    const backup = require('../../backend/utils/backup.js');
    fs.mkdirSync(process.env.ICLASS_CONTENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.ICLASS_CONTENT_DIR, 'RoundTrip.md'), '# original');
    db.memory.notes['roundtrip@teste.local'] = { valor: 1 };
    await db.save();
    const snapshot = structuredClone(backup.buildDataSnapshot());

    db.memory.notes['roundtrip@teste.local'] = { valor: 999 };
    fs.writeFileSync(path.join(process.env.ICLASS_CONTENT_DIR, 'RoundTrip.md'), '# alterado');
    await db.save();
    await backup.restoreDataSnapshot(snapshot);

    assert.deepEqual(db.memory.notes['roundtrip@teste.local'], { valor: 1 });
    assert.equal(fs.readFileSync(path.join(process.env.ICLASS_CONTENT_DIR, 'RoundTrip.md'), 'utf8'), '# original');
});

test('turmas homônimas são isoladas pelo curso', () => {
    const { adminCanAccessClass } = require('../../backend/middlewares.js');
    db.memory.classes = [
        { name: 'Turma A', courseId: 'curso-1' },
        { name: 'Turma A', courseId: 'curso-2' },
    ];
    const professor = { role: 'professor', assignedClasses: [{ courseId: 'curso-1', className: 'Turma A' }] };
    assert.equal(adminCanAccessClass(professor, 'Turma A', 'curso-1'), true);
    assert.equal(adminCanAccessClass(professor, 'Turma A', 'curso-2'), false);
    assert.equal(adminCanAccessClass(professor, 'Turma A'), false);
});

test('atribuições por escola e curso são herdadas sem apagar vínculos específicos', async () => {
    const { adminCanAccessClass, adminAllowedCourseIds } = require('../../backend/middlewares.js');
    db.memory.schools = [{ id: 'escola-a', name: 'Escola A' }, { id: 'escola-b', name: 'Escola B' }];
    db.memory.courses = [
        { id: 'curso-a', name: 'Curso A', schoolId: 'escola-a', status: 'active' },
        { id: 'curso-b', name: 'Curso B', schoolId: 'escola-a', status: 'active' },
        { id: 'curso-c', name: 'Curso C', schoolId: 'escola-b', status: 'active' },
    ];
    db.memory.classes = [
        { name: 'A1', courseId: 'curso-a' },
        { name: 'A2 NOVA', courseId: 'curso-a' },
        { name: 'B1', courseId: 'curso-b' },
        { name: 'C1', courseId: 'curso-c' },
    ];
    const professor = {
        role: 'professor', assignedSchoolIds: ['escola-a'], assignedCourseIds: [],
        assignedClasses: [{ courseId: 'curso-c', className: 'C1' }],
    };
    assert.equal(adminCanAccessClass(professor, 'A2 NOVA', 'curso-a'), true);
    assert.equal(adminCanAccessClass(professor, 'B1', 'curso-b'), true);
    assert.equal(adminCanAccessClass(professor, 'C1', 'curso-c'), true);
    assert.deepEqual([...adminAllowedCourseIds(professor)].sort(), ['curso-a', 'curso-b', 'curso-c']);

    professor.assignedSchoolIds = [];
    professor.assignedCourseIds = ['curso-a'];
    assert.equal(adminCanAccessClass(professor, 'A2 NOVA', 'curso-a'), true);
    assert.equal(adminCanAccessClass(professor, 'B1', 'curso-b'), false);
    assert.equal(adminCanAccessClass(professor, 'C1', 'curso-c'), true);
    assert.deepEqual(professor.assignedClasses, [{ courseId: 'curso-c', className: 'C1' }]);

    db.memory.admins = [professor];
    db.memory.classes = db.memory.classes.filter(cls => cls.name !== 'C1');
    await db.save();
    assert.deepEqual(professor.assignedClasses, []);
});

test('backup ZIP é escrito em streaming e validado antes da restauração', async () => {
    const backup = require('../../backend/utils/backup.js');
    const uploadDir = path.join(tempRoot, 'uploads');
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.writeFileSync(path.join(uploadDir, 'binario.pdf'), '%PDF-original');
    db.memory.notes['zip@teste.local'] = { valor: 'original' };
    await db.save();
    const zipPath = path.join(tempRoot, 'streaming.zip');
    await backup.streamFullZip(fs.createWriteStream(zipPath));
    const parsed = backup.validateZip(fs.readFileSync(zipPath));
    assert.equal(parsed.snapshot.type, 'iclass-backup-data');
    assert.ok(fs.statSync(zipPath).size > 0);

    db.memory.notes['zip@teste.local'] = { valor: 'alterado' };
    fs.writeFileSync(path.join(uploadDir, 'binario.pdf'), '%PDF-alterado');
    await backup.restoreFullZip(fs.readFileSync(zipPath));
    assert.deepEqual(db.memory.notes['zip@teste.local'], { valor: 'original' });
    assert.equal(fs.readFileSync(path.join(uploadDir, 'binario.pdf'), 'utf8'), '%PDF-original');
});

test('uploads exigem sessão e respeitam o curso da biblioteca', async () => {
    const request = require('supertest');
    const { createApp } = require('../../backend/server.js');
    const uploads = path.join(tempRoot, 'uploads');
    fs.mkdirSync(uploads, { recursive: true });
    fs.writeFileSync(path.join(uploads, 'protegido.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    db.memory.sessions = { 'aluno@teste.local': { token: 'token-teste', lastSeen: Date.now(), ip: '::ffff:127.0.0.1' } };
    db.memory.students = [{ email: 'aluno@teste.local', status: 'Ativo', classes: [{ name: 'Turma 1', courseId: 'curso-1' }] }];
    db.memory.library = [{ id: 'lib-1', filename: 'protegido.png', url: '/uploads/protegido.png', courseId: 'curso-2' }];
    const app = createApp();

    await request(app).get('/uploads/protegido.png').expect(401);
    await request(app).get('/uploads/protegido.png?access=token-teste').expect(403);
    db.memory.library[0].courseId = 'curso-1';
    await request(app).get('/uploads/protegido.png?access=token-teste').expect(200).expect('X-Content-Type-Options', 'nosniff');
});

test('validação de ZIP rejeita path traversal antes de extrair', () => {
    const AdmZip = require('adm-zip');
    const backup = require('../../backend/utils/backup.js');
    const zip = new AdmZip();
    zip.addFile('backup-data.json', Buffer.from(JSON.stringify(backup.buildDataSnapshot())));
    zip.addFile('escape.txt', Buffer.from('não extrair'));
    zip.getEntries().find(entry => entry.entryName === 'escape.txt').entryName = '../escape.txt';
    assert.throws(() => backup.validateZip(zip.toBuffer()), /Caminho inseguro/);
});

test('aluno inativo não autentica e identidade do body não substitui a sessão', async () => {
    const request = require('supertest');
    const { createApp } = require('../../backend/server.js');
    db.memory.students = [
        { name: 'Bloqueado', email: 'bloqueado@teste.local', password: db.hashPassword('senha-segura'), status: 'Inativo', classes: [] },
        { name: 'Aluno A', email: 'a@teste.local', password: db.hashPassword('senha-segura'), status: 'Ativo', classes: [] },
        { name: 'Aluno B', email: 'b@teste.local', password: db.hashPassword('senha-segura'), status: 'Ativo', classes: [] },
    ];
    db.memory.sessions = { 'a@teste.local': { token: 'token-a', lastSeen: Date.now(), ip: '::ffff:127.0.0.1' } };
    const app = createApp();

    await request(app).post('/api/student/login').send({ email: 'bloqueado@teste.local', password: 'senha-segura' }).expect(403);
    await request(app).post('/api/student/notes/get').set('x-session-token', 'token-a').send({ email: 'b@teste.local' }).expect(403);
});

test('routers extraídos preservam contratos administrativos', async () => {
    const request = require('supertest');
    const { createApp } = require('../../backend/server.js');
    db.memory.admins = [{ email: 'admin@teste.local', name: 'Admin', role: 'admin', password: db.hashPassword('senha-administrativa') }];
    db.memory.adminSessions = { 'admin-token': { email: 'admin@teste.local', createdAt: Date.now(), lastSeen: Date.now() } };
    const app = createApp();

    const trash = await request(app).get('/api/admin/trash').set('x-admin-session', 'admin-token').expect(200);
    assert.equal(Array.isArray(trash.body), true);
    await request(app).get('/api/admin/archived-courses').set('x-admin-session', 'admin-token').expect(200);
    await request(app).get('/api/admin/backup/data').set('x-admin-session', 'admin-token').expect(200).expect('Content-Type', /application\/json/).expect('Content-Disposition', /iclass-backup-dados_/);

    const config = await request(app).post('/api/admin/config').set('x-admin-session', 'admin-token').send({}).expect(200);
    assert.match(config.body.serverUrl, /^http:\/\//);

    const savedSettings = await request(app).post('/api/admin/settings').set('x-admin-session', 'admin-token').send({
        session: { idleMinutes: 1 },
        maintenance: { enabled: true, message: 'Manutenção de teste' },
    }).expect(200);
    assert.equal(savedSettings.body.settings.session.idleMinutes, 5);
    assert.equal(savedSettings.body.settings.maintenance.enabled, true);
    const loadedSettings = await request(app).get('/api/admin/settings').set('x-admin-session', 'admin-token').expect(200);
    assert.equal(loadedSettings.body.maintenance.message, 'Manutenção de teste');

    // Limpar estado de prova: só na turma informada, com confirmação digitada, e sem
    // apagar logs de monitoramento nem entregas (evidência e notas ficam).
    db.memory.classes = [{ name: 'Turma 1', courseId: 'curso-1' }];
    db.memory.studentExamState = { 'aluno@teste.local_prova-1': { studentEmail: 'aluno@teste.local', studentClass: 'Turma 1', examKey: 'prova-1' } };
    db.memory.proctoringLogs = [{ studentEmail: 'aluno@teste.local', studentClass: 'Turma 1', examKey: 'prova-1' }];
    db.memory.broadcastMessages = [{ targetEmail: 'aluno@teste.local', studentClass: 'Turma 1', examKey: 'prova-1' }];
    db.memory.submissions = [{ email: 'aluno@teste.local', examKey: 'prova-1' }];
    await request(app).post('/api/admin/flush-exam-state').set('x-admin-session', 'admin-token').send({
        studentEmail: 'aluno@teste.local',
        examKey: 'prova-1',
        studentClass: 'Turma 1',
    }).expect(400);
    const flushed = await request(app).post('/api/admin/flush-exam-state').set('x-admin-session', 'admin-token').send({
        studentEmail: 'aluno@teste.local',
        examKey: 'prova-1',
        studentClass: 'Turma 1',
        confirm: 'LIMPAR',
    }).expect(200);
    assert.equal(flushed.body.clearedCount, 2);
    assert.equal(db.memory.proctoringLogs.length, 1);
    assert.equal(db.memory.submissions.length, 1);

    const identity = await request(app).get('/api/admin/whoami').set('x-admin-session', 'admin-token').expect(200);
    assert.equal(identity.body.email, 'admin@teste.local');
    assert.equal(identity.body.sessionToken, 'admin-token');

    db.memory.schools = [{ id: 'escola-contas', name: 'Escola Contas' }];
    db.memory.courses = [{ id: 'curso-contas', name: 'Curso Contas', schoolId: 'escola-contas' }];
    db.memory.classes = [{ name: 'Turma Contas', courseId: 'curso-contas' }];
    await request(app).post('/api/admin/accounts/create').set('x-admin-session', 'admin-token').send({
        name: 'Professor Teste',
        email: 'professor@teste.local',
        password: 'senha-professor',
        role: 'professor',
        assignedClasses: [{ courseId: 'curso-contas', className: 'Turma Contas' }],
    }).expect(200);
    const accounts = await request(app).get('/api/admin/accounts').set('x-admin-session', 'admin-token').expect(200);
    const professor = accounts.body.find(account => account.email === 'professor@teste.local');
    assert.equal(professor.name, 'Professor Teste');
    assert.equal(Object.hasOwn(professor, 'password'), false);
    const assignments = await request(app).post('/api/admin/teacher-assignments').set('x-admin-session', 'admin-token').send({
        email: 'professor@teste.local',
        assignedSchoolIds: ['escola-contas'],
        assignedCourseIds: ['curso-contas'],
        assignedClasses: [{ courseId: 'curso-contas', className: 'Turma Contas' }],
    }).expect(200);
    assert.deepEqual(assignments.body.assignments.assignedSchoolIds, ['escola-contas']);
    assert.deepEqual(assignments.body.assignments.assignedCourseIds, ['curso-contas']);
    assert.deepEqual(assignments.body.assignments.assignedClasses, [{ courseId: 'curso-contas', className: 'Turma Contas' }]);
    assert.equal(db.memory.auditLogs.at(-1).type, 'professor_assignments_updated');
    assert.equal(db.memory.auditLogs.at(-1).targetEmail, 'professor@teste.local');
    await request(app).post('/api/admin/accounts/update').set('x-admin-session', 'admin-token').send({
        email: 'professor@teste.local',
        name: 'Professor Atualizado',
    }).expect(200);
    await request(app).post('/api/admin/accounts/delete').set('x-admin-session', 'admin-token').send({
        email: 'professor@teste.local',
    }).expect(200);

    const preferences = await request(app).post('/api/admin/preferences').set('x-admin-session', 'admin-token').send({ compact: true }).expect(200);
    assert.equal(preferences.body.preferences.compact, true);

    db.memory.courses = [{
        id: 'curso-prova',
        structure: [{ name: 'Módulo', units: [{ avaliacaoKey: 'Avaliacao_Teste', apostilaKey: 'Apostila_Teste' }] }],
    }];
    db.memory.classes = [{ name: 'Turma Prova', courseId: 'curso-prova', releasedItems: {} }];
    const examConfig = await request(app).post('/api/admin/exam-config').set('x-admin-session', 'admin-token').send({
        studentClass: 'Turma Prova', courseId: 'curso-prova', examKey: 'Avaliacao_Teste', questionCount: 5,
    }).expect(200);
    assert.equal(examConfig.body.examConfig.questionCount, 5);
    const onlineConfig = await request(app).post('/api/admin/online-exam-config').set('x-admin-session', 'admin-token').send({
        studentClass: 'Turma Prova', courseId: 'curso-prova', examKey: 'Avaliacao_Teste', durationMinutes: 45,
    }).expect(200);
    assert.equal(onlineConfig.body.onlineExamConfig.status, 'prepared');
    const historyEntry = await request(app).post('/api/admin/exam-history/add').set('x-admin-session', 'admin-token').send({
        studentClass: 'Turma Prova', courseId: 'curso-prova', examKey: 'Avaliacao_Teste',
        questionNumbers: [1, 2], waitingRoomMinutes: 0,
        printSnapshot: [{ questions: [{ originalNumber: 1 }, { originalNumber: 2 }] }],
    }).expect(200);
    const entryId = historyEntry.body.entry.id;
    const released = await request(app).post('/api/admin/release-item').set('x-admin-session', 'admin-token').send({
        studentClass: 'Turma Prova', courseId: 'curso-prova', itemKey: 'Avaliacao_Teste', released: true, historyId: entryId,
    }).expect(200);
    assert.equal(released.body.releasedItems.Avaliacao_Teste, true);
    assert.equal(db.memory.classes[0].onlineExamConfigs.Avaliacao_Teste.status, 'running');
    const history = await request(app).get('/api/admin/exam-history').set('x-admin-session', 'admin-token').query({
        studentClass: 'Turma Prova', courseId: 'curso-prova', examKey: 'Avaliacao_Teste',
    }).expect(200);
    assert.equal(history.body.history.length, 1);
    await request(app).post('/api/admin/exam-history/delete').set('x-admin-session', 'admin-token').send({
        studentClass: 'Turma Prova', courseId: 'curso-prova', examKey: 'Avaliacao_Teste', entryId,
    }).expect(200);

    await request(app).post('/api/admin/change-password').set('x-admin-session', 'admin-token').send({ currentPassword: 'senha-administrativa', newPassword: 'nova-senha-segura' }).expect(200);
    assert.equal(db.verifyPassword(db.memory.admins[0].password, 'nova-senha-segura'), true);
    await request(app).post('/api/session/logout').set('x-admin-session', 'admin-token').expect(200);
    assert.equal(db.memory.adminSessions['admin-token'], undefined);
});

test('modo administrativo local exige loopback e token efêmero de uso único', async () => {
    const express = require('express');
    const request = require('supertest');
    const { createSetupModeRouter, isLoopbackAddress } = require('../../backend/routes/setupMode.js');
    const setupToken = 'token-local-seguro-com-32-caracteres';
    let currentTime = 1000;

    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('::1'), true);
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackAddress('192.168.1.50'), false);

    db.memory.admins = [{
        email: 'admin-local@teste.local', name: 'Admin Local', role: 'admin',
        password: db.hashPassword('senha-local-segura'), mustChangePassword: false,
    }];
    db.memory.adminSessions = {};
    db.memory.auditLogs = [];

    const app = express();
    app.use(express.json());
    app.use(createSetupModeRouter({
        enabled: true, setupToken, now: () => currentTime, startedAt: currentTime,
    }));

    await request(app).post('/api/setup/admin-session').send({ token: 'token-incorreto' }).expect(403);
    currentTime = 3600999;
    const authenticated = await request(app).post('/api/setup/admin-session').send({ token: setupToken }).expect(200);
    assert.equal(authenticated.body.email, 'admin-local@teste.local');
    assert.equal(authenticated.body.localSetupMode, true);
    assert.ok(db.memory.adminSessions[authenticated.body.sessionToken]);
    assert.equal(JSON.stringify(db.memory.auditLogs).includes(setupToken), false);
    await request(app).post('/api/setup/admin-session').send({ token: setupToken }).expect(410);

    const expiredApp = express();
    expiredApp.use(express.json());
    currentTime = 3601001;
    expiredApp.use(createSetupModeRouter({ enabled: true, setupToken, now: () => currentTime, startedAt: 1000 }));
    await request(expiredApp).post('/api/setup/admin-session').send({ token: setupToken }).expect(410);
});

test('acesso rapido local escolhe somente as contas oficiais de teste', async () => {
    const express = require('express');
    const request = require('supertest');
    const { createSetupModeRouter } = require('../../backend/routes/setupMode.js');
    const setupToken = 'token-local-rapido-com-32-caracteres';
    let currentTime = 5000;

    db.memory.admins = [
        { email: 'outro-admin@teste.local', name: 'Outro Admin', role: 'admin', password: db.hashPassword('senha-admin') },
        { email: 'chorume@show.com', name: 'Chorume', role: 'professor', password: db.hashPassword('senha-chorume') },
        { email: 'admin@teste.local', name: 'Ana Administradora', role: 'admin', password: db.hashPassword('teste'), seedDemo: true },
        { email: 'professor@teste.local', name: 'Paulo Professor', role: 'professor', password: db.hashPassword('teste'), seedDemo: true },
    ];
    db.memory.students = [
        { email: 'outro-aluno@teste.local', name: 'Outro Aluno', status: 'Ativo', password: db.hashPassword('senha-aluno'), classes: [] },
        { email: 'aluno@teste.local', name: 'Alice Aluna', status: 'Ativo', password: db.hashPassword('teste'), seedDemo: true, classes: [{ name: 'Turma Rapida', courseId: 'curso-rapido' }] },
    ];
    db.memory.classes = [{ name: 'Turma Rapida', courseId: 'curso-rapido', period: 'Noite' }];
    db.memory.courses = [{ id: 'curso-rapido', name: 'Curso Rapido' }];
    db.memory.adminSessions = {};
    db.memory.sessions = {};
    db.memory.auditLogs = [];

    const app = express();
    app.use(express.json());
    app.use(createSetupModeRouter({ enabled: true, setupToken, now: () => currentTime, startedAt: currentTime }));

    await request(app).post('/api/setup/quick-session').send({ token: 'incorreto', profile: 'admin' }).expect(403);
    await request(app).post('/api/setup/quick-session').send({ token: setupToken, profile: 'desconhecido' }).expect(400);

    const admin = await request(app).post('/api/setup/quick-session').send({ token: setupToken, profile: 'admin' }).expect(200);
    assert.equal(admin.body.email, 'admin@teste.local');
    assert.equal(admin.body.sessionType, 'admin');
    assert.ok(db.memory.adminSessions[admin.body.sessionToken]);

    const professor = await request(app).post('/api/setup/quick-session').send({ token: setupToken, profile: 'professor' }).expect(200);
    assert.equal(professor.body.email, 'professor@teste.local');
    assert.equal(professor.body.role, 'professor');

    const student = await request(app).post('/api/setup/quick-session').send({ token: setupToken, profile: 'student' }).expect(200);
    assert.equal(student.body.email, 'aluno@teste.local');
    assert.equal(student.body.sessionType, 'student');
    assert.equal(Object.hasOwn(student.body.student, 'password'), false);
    assert.ok(db.memory.sessions['aluno@teste.local']);
    assert.equal(db.memory.auditLogs.filter(log => log.type === 'local_quick_login').length, 3);
    assert.equal(JSON.stringify(db.memory.auditLogs).includes(setupToken), false);

    const expiredApp = express();
    expiredApp.use(express.json());
    currentTime = 3605001;
    expiredApp.use(createSetupModeRouter({ enabled: true, setupToken, now: () => currentTime, startedAt: 5000 }));
    await request(expiredApp).post('/api/setup/quick-session').send({ token: setupToken, profile: 'admin' }).expect(410);
});
