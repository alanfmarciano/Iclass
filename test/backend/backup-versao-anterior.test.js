const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-backup-anterior-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');

// Backup gerado pelo código da versão em produção antes da fase 1 (5b69148), que não
// guardava as aplicações de prova: uma aplicação encerrada (Ana entregou) e uma
// reaplicação em andamento com a tentativa da Ana aberta (respondeu e não entregou).
// Como foi gerado: test/backend/fixtures/gerar-backup-versao-anterior.js.
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'backup-versao-anterior.json'), 'utf8'));
const { first, second, secondAttempt } = fixture.ids;
const studentClass = '1DES';
const courseId = 'curso-antigo';
const examKey = 'Avaliacao_Antiga';
const adminToken = 'admin-token-backup-anterior';
const anaToken = 'ana-token-backup-anterior';
const anaEmail = 'ana@antigo.local';

let app;

function sessions() {
    db.memory.adminSessions = { [adminToken]: { email: 'admin@antigo.local', createdAt: Date.now(), lastSeen: Date.now() } };
    db.memory.sessions = { [anaEmail]: { token: anaToken, lastSeen: Date.now(), ip: '127.0.0.1' } };
}
const admin = (method, url) => request(app)[method](url).set('x-admin-session', adminToken);
const restore = (extra = {}) => {
    let call = admin('post', '/api/admin/backup/restore').field('confirm', 'RESTAURAR');
    Object.entries(extra).forEach(([key, value]) => { call = call.field(key, value); });
    return call.attach('file', Buffer.from(JSON.stringify(fixture.backup)), 'backup-versao-anterior.json');
};
const applicationIds = () => db.memory.examApplications.map(item => item.id).sort();

test.before(async () => {
    await db.init();
    app = createApp();
    // O servidor como estava no momento do backup (versão anterior): os dados do backup
    // e as aplicações do banco, que o backup não levava.
    const secret = db.memory.config.examAnswerSecret;
    Object.assign(db.memory, structuredClone(fixture.backup.data));
    db.memory.config = { ...db.memory.config, examAnswerSecret: secret };
    db.memory.examApplications = structuredClone(fixture.applicationsAtBackup);
    sessions();
    await db.save();
});

test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-BACKUP-001] backup de versão anterior (sem as aplicações) volta àquele momento: aplicações atuais saem e são refeitas das turmas do backup', async () => {
    assert.equal(fixture.backup.data.examApplications, undefined, 'o backup antigo não traz as aplicações');

    // Depois do backup: a reaplicação é encerrada (a resposta da Ana vira entrega) e uma nova é preparada.
    const finished = await admin('post', `/api/admin/exam-applications/${second}/control`).send({ action: 'finish', inProgressPolicy: 'submit' });
    assert.equal(finished.status, 200, JSON.stringify(finished.body));
    const history = await admin('post', '/api/admin/exam-history/add').send({
        studentClass, courseId, examKey, type: 'online', questionNumbers: [1],
        printSnapshot: [{ version: 'A', questions: [{ originalNumber: 1, text: 'Quanto é 1 + 1?', alternatives: [{ letter: 'A', text: '1' }, { letter: 'B', text: '2' }] }] }],
        durationMinutes: 30, waitingRoomMinutes: 0, maxAttempts: 1,
    }).expect(200);
    const third = (await admin('post', '/api/admin/exam-applications').send({
        studentClass, courseId, examKey, historyId: history.body.entry.id,
        applicationOptions: { timerMode: 'per_attempt', waitingRoomMinutes: 0, maxAttempts: 1 },
    }).expect(201)).body.application;
    assert.deepEqual(applicationIds(), [first, second, third.id].sort());

    // Sem a confirmação do aviso: nada muda e a tela recebe o aviso para mostrar.
    const warned = await restore();
    assert.equal(warned.status, 409, 'antes restaurava direto e deixava a aplicação encerrada com a tentativa "em andamento" do backup');
    assert.equal(warned.body.legacyBackup, true);
    assert.match(warned.body.error, /versão anterior do IClass/);
    assert.match(warned.body.error, /aplicações de prova atuais serão descartadas/);
    assert.deepEqual(applicationIds(), [first, second, third.id].sort(), 'nada foi restaurado');
    assert.equal(db.memory.examApplications.find(item => item.id === second).status, 'finished');
    assert.equal(db.memory.auditLogs.filter(entry => entry.action === 'backup_restored').length, 0);

    // Com a confirmação: as aplicações atuais saem e voltam as do backup.
    sessions();
    const restored = await restore({ acceptLegacy: '1' });
    assert.equal(restored.status, 200, restored.body && restored.body.error);
    assert.equal(restored.body.legacyApplications, true);
    assert.equal(restored.body.applicationsDiscarded, 3);
    assert.equal(restored.body.applicationsRebuilt, 1);

    // A reaplicação volta em andamento, com o mesmo identificador (as tentativas e as
    // entregas gravadas com ele continuam dela); a preparada depois do backup não fica.
    assert.deepEqual(applicationIds(), [second]);
    const rebuilt = db.memory.examApplications[0];
    assert.equal(rebuilt.status, 'running');
    assert.equal(rebuilt.examKey, examKey);
    assert.equal(rebuilt.timerMode, 'per_attempt');
    const cls = db.memory.classes.find(item => item.name === studentClass);
    assert.equal(cls.onlineExamConfigs[examKey].applicationId, second);
    assert.equal(cls.onlineExamConfigs[examKey].onlineActive, true);
    assert.equal(cls.activeApplicationId, second);

    // A tentativa da Ana do backup continua aberta, com a resposta salva, na aplicação refeita.
    const anaState = Object.values(db.memory.studentExamState).find(state => state.attemptId === secondAttempt);
    assert.equal(anaState.applicationId, second);
    assert.equal(anaState.status, 'active');
    assert.deepEqual(anaState.answers, { 1: 'B' });
    // Nenhuma aplicação encerrada com tentativa em andamento, nenhuma tentativa sem aplicação.
    const byId = new Map(db.memory.examApplications.map(item => [item.id, item]));
    Object.values(db.memory.studentExamState).filter(state => state.applicationId && ['active', 'instructions'].includes(state.status)).forEach(state => {
        assert.ok(byId.has(state.applicationId), `tentativa ${state.attemptId} sem aplicação`);
        assert.ok(['waiting', 'running', 'paused'].includes(byId.get(state.applicationId).status), `tentativa ${state.attemptId} aberta em aplicação ${byId.get(state.applicationId).status}`);
    });
    // A entrega da 1ª aplicação (de antes do backup) continua; a feita depois do backup não.
    assert.deepEqual(db.memory.submissions.map(item => item.applicationId), [first]);

    // O registro do backup anota a versão anterior e o que aconteceu com as aplicações.
    const audit = db.memory.auditLogs.filter(entry => entry.action === 'backup_restored');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].details.legacyApplications, true);
    assert.equal(audit[0].details.applicationsDiscarded, 3);
    assert.equal(audit[0].details.applicationsRebuilt, 1);
    sessions();
    const historyEntries = (await admin('get', '/api/admin/backup/history').expect(200)).body.entries;
    const entry = historyEntries.find(item => item.action === 'backup_restored');
    assert.equal(entry.legacyApplications, true);
    assert.equal(entry.applicationsDiscarded, 3);
    assert.equal(entry.applicationsRebuilt, 1);

    // O Monitor da aplicação refeita mostra a Ana (em andamento, ou já entregue pelo fim
    // do tempo com a resposta salva, conforme o relógio): a tentativa não sumiu.
    const monitor = await admin('get', `/api/admin/monitor-status/${encodeURIComponent(studentClass)}/${examKey}`).query({ courseId, applicationId: second }).expect(200);
    const anaRow = monitor.body.find(row => row.email === anaEmail);
    assert.ok(anaRow, 'Ana aparece no Monitor');
    assert.equal(anaRow.attemptStarted, true);
    await db.save();

    // Boot depois da restauração: nada muda (aplicações e turmas das contas iguais).
    const before = { applications: db.memory.examApplications.map(item => [item.id, item.status]), admins: db.memory.admins.map(item => item.assignedClasses) };
    const script = `const db = require(${JSON.stringify(require.resolve('../../backend/database.js'))});
db.init().then(async () => { process.stdout.write('@@' + JSON.stringify({ applications: db.memory.examApplications.map(item => [item.id, item.status]), admins: db.memory.admins.map(item => item.assignedClasses) })); await db.close(); });`;
    const output = require('node:child_process').execFileSync(process.execPath, ['-e', script], { env: process.env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(output.slice(output.indexOf('@@') + 2)), before);
});

test('[UC-BACKUP-001] backup atual (com as aplicações) não pede a confirmação da versão anterior', async () => {
    sessions();
    const backup = require('../../backend/utils/backup.js');
    const snapshot = backup.buildDataSnapshot();
    assert.ok(Array.isArray(snapshot.data.examApplications));
    const response = await admin('post', '/api/admin/backup/restore').field('confirm', 'RESTAURAR')
        .attach('file', Buffer.from(JSON.stringify(snapshot)), 'backup-atual.json');
    assert.equal(response.status, 200, response.body && response.body.error);
    assert.equal(response.body.legacyApplications, undefined);
});
