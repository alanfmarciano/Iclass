// Regressões da revisão de 14/10/2026: cada teste cobre um defeito corrigido.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-review-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { initializeExamState } = require('../../backend/middlewares.js');
const { createApp } = require('../../backend/server.js');

let app;
const adminToken = 'admin-token-review';
const professorToken = 'professor-token-review';
const courseA = 'curso-a';
const courseB = 'curso-b';

function readAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        const reader = new sqlite3.Database(path.join(tempRoot, 'database.db'));
        reader.all(sql, params, (err, rows) => reader.close(closeError => (err || closeError) ? reject(err || closeError) : resolve(rows)));
    });
}

function seed() {
    db.memory.admins = [
        { email: 'admin@review.local', name: 'Admin', role: 'admin', password: db.hashPassword('x') },
        { email: 'prof@review.local', name: 'Professor', role: 'professor', password: db.hashPassword('x'), assignedClasses: [{ courseId: courseA, className: 'TURMA A' }] },
    ];
    db.memory.adminSessions = {
        [adminToken]: { email: 'admin@review.local', createdAt: Date.now(), lastSeen: Date.now() },
        [professorToken]: { email: 'prof@review.local', createdAt: Date.now(), lastSeen: Date.now() },
    };
    db.memory.courses = [{ id: courseA, structure: [] }, { id: courseB, structure: [] }];
    db.memory.classes = [
        { name: 'TURMA A', courseId: courseA, period: 'Manhã' },
        { name: 'TURMA A', courseId: courseB, period: 'Tarde', onlineExamConfigs: { P1: { questionCount: 1, versionSnapshots: [{ version: 'A', questions: [{ originalNumber: 1, text: 'Q1', correctAnswer: 'B', alternatives: [{ letter: 'A', text: 'a' }, { letter: 'B', text: 'b' }] }] }] } } },
    ];
    db.memory.students = [
        { name: 'Ana', email: 'ana@review.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: 'TURMA A', courseId: courseA }] },
        { name: 'Celia', email: 'celia@review.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: 'TURMA A', courseId: courseB }] },
    ];
    db.memory.sessions = {};
    db.memory.submissions = [];
    db.memory.studentExamState = {};
    db.memory.attendance = [];
    db.memory.progress = {};
    db.memory.auditLogs = [];
}

async function loginStudent(email) {
    const res = await request(app).post('/api/student/login').send({ email, password: '123' });
    assert.equal(res.status, 200);
    return res.body.sessionToken;
}

test.before(async () => { await db.init(); app = createApp(); });
test.beforeEach(() => { seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('turmas com o mesmo nome em cursos diferentes são todas persistidas', async () => {
    await db.save();
    const rows = await readAll('SELECT key, value FROM classes');
    const stored = rows.map(row => JSON.parse(row.value)).filter(cls => cls.name === 'TURMA A').map(cls => cls.courseId).sort();
    assert.deepEqual(stored, [courseA, courseB]);
});

test('gravação incremental só reescreve as linhas que mudaram e remove as excluídas', async () => {
    db.memory.attendance = [
        { id: 'att_1', studentEmail: 'ana@review.local', date: '2026-10-01' },
        { id: 'att_2', studentEmail: 'ana@review.local', date: '2026-10-02' },
    ];
    await db.save();
    db.memory.attendance[1].date = '2026-10-03';
    db.memory.attendance.push({ id: 'att_3', studentEmail: 'ana@review.local', date: '2026-10-04' });
    db.memory.attendance = db.memory.attendance.filter(item => item.id !== 'att_1');
    await db.save();
    const rows = await readAll('SELECT key, value FROM attendance ORDER BY key');
    assert.deepEqual(rows.map(row => [row.key, JSON.parse(row.value).date]), [['att_2', '2026-10-03'], ['att_3', '2026-10-04']]);
});

test('prova com cronômetro desativado não recebe prazo nem contagem regressiva', () => {
    const config = { onlineActive: true, startTime: Date.now() - 1000, durationMinutes: 1, timerEnabled: false, updatedAt: 'v1', versionSnapshots: [] };
    const state = { answers: {}, applicationId: 'app_x', examConfigVersion: 'v1', startedAt: Date.now() - 1000, deadlineAt: null, timerRemaining: null };
    initializeExamState(state, config);
    assert.equal(state.deadlineAt, null);
    assert.equal(state.timerRemaining, null);

    const timed = { answers: {}, applicationId: 'app_y', examConfigVersion: 'v1', startedAt: Date.now() - 1000, deadlineAt: null, timerRemaining: null };
    initializeExamState(timed, { ...config, timerEnabled: true });
    assert.ok(Number(timed.deadlineAt) > Date.now(), 'com cronômetro ativo o prazo continua sendo calculado');
});

test('tempo adicional de acessibilidade estende o prazo da prova', () => {
    db.memory.students[0].accessibility = { tempoAdicional: true, tempoAdicionalPercent: 50 };
    const config = { onlineActive: true, startTime: Date.now() - 1000, durationMinutes: 40, timerEnabled: true, updatedAt: 'v1', versionSnapshots: [] };
    const startedAt = Date.now() - 1000;
    const withExtra = { answers: {}, studentEmail: 'ana@review.local', applicationId: 'app_a', examConfigVersion: 'v1', startedAt, deadlineAt: null, timerRemaining: null };
    initializeExamState(withExtra, config);
    assert.equal(withExtra.accessibilityExtraMinutes, 20);
    assert.equal(withExtra.deadlineAt, startedAt + 60 * 60000);

    const regular = { answers: {}, studentEmail: 'celia@review.local', applicationId: 'app_b', examConfigVersion: 'v1', startedAt, deadlineAt: null, timerRemaining: null };
    initializeExamState(regular, config);
    assert.equal(regular.accessibilityExtraMinutes, 0);
    assert.equal(regular.deadlineAt, startedAt + 40 * 60000);
});

test('backup automático guarda só os mais recentes', () => {
    const backupUtil = require('../../backend/utils/backup.js');
    const { BACKUPS_DIR } = require('../../backend/runtimePaths.js');
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    for (let i = 1; i <= 4; i += 1) fs.writeFileSync(path.join(BACKUPS_DIR, `teste-auto_2026-01-0${i}T00-00-00-000Z.json`), '{}');
    const file = backupUtil.runAutomaticBackup({ prefix: 'teste-auto', keep: 3 });
    const kept = fs.readdirSync(BACKUPS_DIR).filter(name => name.startsWith('teste-auto_')).sort();
    assert.equal(kept.length, 3);
    assert.ok(kept.includes(path.basename(file)), 'o backup novo é mantido');
    assert.ok(!kept.includes('teste-auto_2026-01-01T00-00-00-000Z.json'), 'o mais antigo é apagado');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).type, 'iclass-backup-data');
    assert.ok(backupUtil.lastAutomaticBackupAt('teste-auto') > 0);
});

test('modo demonstração gera apostilas, biblioteca e uma prova preparada', async () => {
    const res = await request(app).post('/api/test/seed');
    assert.equal(res.status, 200);
    const { CONTENT_DIR } = require('../../backend/runtimePaths.js');
    assert.ok(fs.existsSync(path.join(CONTENT_DIR, 'Apostila_FUTEC_1.md')));
    assert.ok((db.memory.library || []).filter(item => String(item.id).startsWith('seed_lib_')).length >= 3);
    const application = db.memory.examApplications.find(item => item.seedDemo === true);
    assert.equal(application.status, 'prepared');
    const cls = db.memory.classes.find(item => item.name === '1DES' && item.courseId === 'curso_legacy_01');
    assert.equal(cls.onlineExamConfigs[application.examKey].applicationId, application.id);
    // Rodar de novo não duplica a aplicação de demonstração.
    await request(app).post('/api/test/seed');
    assert.equal(db.memory.examApplications.filter(item => item.seedDemo === true).length, 1);
});

test('/api/student/leave exige sessão e só encerra a própria sessão', async () => {
    const anaToken = await loginStudent('ana@review.local');
    const celiaToken = await loginStudent('celia@review.local');
    const anonymous = await request(app).post('/api/student/leave').set('Content-Type', 'text/plain').send('ana@review.local');
    assert.equal(anonymous.status, 401);
    assert.ok(db.memory.sessions['ana@review.local'], 'sessão da Ana continua viva');

    const forged = await request(app).post('/api/student/leave').set('x-session-token', celiaToken).set('Content-Type', 'text/plain').send('ana@review.local');
    assert.equal(forged.status, 403);
    assert.ok(db.memory.sessions['ana@review.local']);

    const own = await request(app).post('/api/student/leave').set('x-session-token', anaToken).set('Content-Type', 'text/plain').send('ana@review.local');
    assert.equal(own.status, 200);
    assert.equal(db.memory.sessions['ana@review.local'], undefined);
});

test('/api/status e /data.js exigem sessão de aluno ou de instrutor', async () => {
    const query = `?studentClass=TURMA%20A&courseId=${courseB}`;
    assert.equal((await request(app).get(`/api/status${query}`)).status, 401);
    assert.equal((await request(app).get(`/data.js?courseId=${courseB}`)).status, 401);

    const token = await loginStudent('celia@review.local');
    const asStudent = await request(app).get(`/api/status${query}`).set('x-session-token', token);
    assert.equal(asStudent.status, 200);
    assert.equal(asStudent.body.onlineExamConfigs.P1.versionSnapshots[0].questions[0].text, 'Q1');
    assert.equal(asStudent.body.onlineExamConfigs.P1.versionSnapshots[0].questions[0].correctAnswer, undefined, 'gabarito nunca vai para o aluno');

    const asAdmin = await request(app).get(`/data.js?courseId=${courseB}`).set('x-admin-session', adminToken);
    assert.equal(asAdmin.status, 200);
});

test('aluno que troca de IP mantém a sessão (o token é a prova de identidade)', async () => {
    const token = await loginStudent('ana@review.local');
    db.memory.sessions['ana@review.local'].ip = '10.9.9.9';
    const res = await request(app).get('/api/ping?email=ana@review.local').set('x-session-token', token);
    assert.equal(res.status, 200);
    assert.notEqual(db.memory.sessions['ana@review.local'].ip, '10.9.9.9');
});

test('professor não vê as respostas de aluno de turma fora do seu escopo', async () => {
    const forbidden = await request(app).get(`/api/admin/monitor-review/TURMA%20A/P1?courseId=${courseB}&studentEmail=celia@review.local`).set('x-admin-session', professorToken);
    assert.equal(forbidden.status, 403);
    const allowed = await request(app).get(`/api/admin/monitor-review/TURMA%20A/P1?courseId=${courseB}&studentEmail=celia@review.local`).set('x-admin-session', adminToken);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.status, 'not_started');
});

test('trocar o e-mail do aluno leva progresso, presença e caderno junto', async () => {
    db.memory.progress['ana@review.local'] = { Apostila_X_1: true };
    db.memory.notes['ana@review.local'] = { Apostila_X_1: 'anotação' };
    db.memory.attendance = [{ id: 'att_1', studentEmail: 'ana@review.local', date: '2026-10-01' }];
    const res = await request(app).post('/api/admin/student/update').set('x-admin-session', adminToken)
        .send({ originalEmail: 'ana@review.local', name: 'Ana', email: 'ana.nova@review.local', classes: ['TURMA A'] });
    assert.equal(res.status, 200);
    assert.deepEqual(db.memory.progress['ana.nova@review.local'], { Apostila_X_1: true });
    assert.equal(db.memory.progress['ana@review.local'], undefined);
    assert.equal(db.memory.notes['ana.nova@review.local'].Apostila_X_1, 'anotação');
    assert.equal(db.memory.attendance[0].studentEmail, 'ana.nova@review.local');
});

test('recuperação de senha responde igual para e-mail cadastrado ou não', async () => {
    const known = await request(app).post('/api/student/recover').send({ email: 'ana@review.local' });
    const unknown = await request(app).post('/api/student/recover').send({ email: 'ninguem@review.local' });
    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    assert.deepEqual(known.body, unknown.body);
    assert.equal(db.memory.students[0].recoveryRequested, true);
});
