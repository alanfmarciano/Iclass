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
// guardava as aplicações de prova: na 1DES uma aplicação encerrada (Ana entregou) e uma
// reaplicação em andamento com a tentativa da Ana aberta (respondeu e não entregou); na
// 2DES uma preparada com token e a versão B escolhida no Monitor para a Isabela; na 3DES
// uma por tentativa pausada aos 20 min (Carla e Davi no meio da tentativa 1, Davi com
// +10 min e Fábio com +5 min antes de começar); na 4DES uma encerrada (Eva entregou).
// Como foi gerado: test/backend/fixtures/gerar-backup-versao-anterior.js.
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'backup-versao-anterior.json'), 'utf8'));
const { first, second, secondAttempt, tokenApp, pausedApp, carlaAttempt, finishedApp } = fixture.ids;
const backupAt = Date.parse(fixture.backup.exportedAt);
const rebuiltIds = [second, tokenApp, pausedApp, finishedApp].sort();
const studentClass = '1DES';
const courseId = 'curso-antigo';
const examKey = 'Avaliacao_Antiga';
const adminToken = 'admin-token-backup-anterior';
const anaToken = 'ana-token-backup-anterior';
const anaEmail = 'ana@antigo.local';

let app;

const studentEmails = { ana: anaEmail, bruno: 'bruno@antigo.local', isabela: 'isabela@antigo.local' };
function sessions() {
    db.memory.adminSessions = { [adminToken]: { email: 'admin@antigo.local', createdAt: Date.now(), lastSeen: Date.now() } };
    db.memory.sessions = Object.fromEntries(Object.entries(studentEmails)
        .map(([id, email]) => [email, { token: id === 'ana' ? anaToken : `${id}-token-backup-anterior`, lastSeen: Date.now(), ip: '127.0.0.1' }]));
}
const admin = (method, url) => request(app)[method](url).set('x-admin-session', adminToken);
const as = id => (method, url) => request(app)[method](url).set('x-session-token', id === 'ana' ? anaToken : `${id}-token-backup-anterior`);
const bootOutput = (script, env = process.env) => {
    const output = require('node:child_process').execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
    return JSON.parse(output.slice(output.indexOf('@@') + 2));
};
const databasePath = JSON.stringify(require.resolve('../../backend/database.js'));
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
    const atBackup = fixture.applicationsAtBackup.map(item => item.id);
    assert.deepEqual(applicationIds(), [...atBackup, third.id].sort());

    // Sem a confirmação do aviso: nada muda e a tela recebe o aviso para mostrar.
    const warned = await restore();
    assert.equal(warned.status, 409, 'antes restaurava direto e deixava a aplicação encerrada com a tentativa "em andamento" do backup');
    assert.equal(warned.body.legacyBackup, true);
    assert.match(warned.body.error, /versão anterior do IClass/);
    assert.match(warned.body.error, /aplicações de prova atuais serão descartadas/);
    // O aviso diz o que volta e o que não volta (antes prometia que a prova "volta como
    // estava", e a versão escolhida no Monitor, as contestações e o "+N min" sumiam).
    assert.doesNotMatch(warned.body.error, /volta como estava/);
    assert.match(warned.body.error, /token de acesso/);
    assert.match(warned.body.error, /versão escolhida no Monitor/);
    assert.match(warned.body.error, /pausada continua pausada, mas a pausa passa a contar do momento do backup/);
    // Diz que o tempo entre a pausa e o backup sai do tempo dos alunos (antes não dizia).
    assert.match(warned.body.error, /tempo entre a pausa e o backup é descontado do tempo dos alunos/);
    assert.match(warned.body.error, /Não voltam[^.]*contestações de questão[^.]*"\+N min"/);
    assert.match(warned.body.error, /encerramento[^.]*aproximado pela última entrega/);
    assert.deepEqual(applicationIds(), [...atBackup, third.id].sort(), 'nada foi restaurado');
    assert.equal(db.memory.examApplications.find(item => item.id === second).status, 'finished');
    assert.equal(db.memory.auditLogs.filter(entry => entry.action === 'backup_restored').length, 0);

    // Com a confirmação: as aplicações atuais saem e voltam as do backup.
    sessions();
    const restored = await restore({ acceptLegacy: '1' });
    assert.equal(restored.status, 200, restored.body && restored.body.error);
    assert.equal(restored.body.legacyApplications, true);
    assert.equal(restored.body.applicationsDiscarded, atBackup.length + 1);
    assert.equal(restored.body.applicationsRebuilt, 4);

    // A última aplicação de cada turma volta, com o mesmo identificador (as tentativas e
    // as entregas gravadas com ele continuam dela); a preparada depois do backup não fica.
    assert.deepEqual(applicationIds(), rebuiltIds);
    const rebuilt = db.memory.examApplications.find(item => item.id === second);
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
    assert.deepEqual(db.memory.submissions.map(item => item.applicationId), [first, finishedApp]);

    // O registro do backup anota a versão anterior e o que aconteceu com as aplicações.
    const audit = db.memory.auditLogs.filter(entry => entry.action === 'backup_restored');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].details.legacyApplications, true);
    assert.equal(audit[0].details.applicationsDiscarded, atBackup.length + 1);
    assert.equal(audit[0].details.applicationsRebuilt, 4);
    sessions();
    const historyEntries = (await admin('get', '/api/admin/backup/history').expect(200)).body.entries;
    const entry = historyEntries.find(item => item.action === 'backup_restored');
    assert.equal(entry.legacyApplications, true);
    assert.equal(entry.applicationsDiscarded, atBackup.length + 1);
    assert.equal(entry.applicationsRebuilt, 4);

    // O Monitor da aplicação refeita mostra a Ana (em andamento, ou já entregue pelo fim
    // do tempo com a resposta salva, conforme o relógio): a tentativa não sumiu.
    const monitor = await admin('get', `/api/admin/monitor-status/${encodeURIComponent(studentClass)}/${examKey}`).query({ courseId, applicationId: second }).expect(200);
    const anaRow = monitor.body.find(row => row.email === anaEmail);
    assert.ok(anaRow, 'Ana aparece no Monitor');
    assert.equal(anaRow.attemptStarted, true);
    await db.save();

    // Boot depois da restauração: nada muda (aplicações inteiras e turmas das contas
    // iguais). Antes a aplicação pausada ganhava no boot uma pausa desde o início da prova.
    const before = { applications: db.memory.examApplications, admins: db.memory.admins.map(item => item.assignedClasses) };
    const after = bootOutput(`const db = require(${databasePath});
db.init().then(async () => { process.stdout.write('@@' + JSON.stringify({ applications: db.memory.examApplications, admins: db.memory.admins.map(item => item.assignedClasses) })); await db.close(); });`);
    assert.deepEqual(after, JSON.parse(JSON.stringify(before)));
});

test('[UC-BACKUP-001] backup de versão anterior: o token, a versão escolhida no Monitor, a pausa e o encerramento voltam', async () => {
    sessions();
    const restored = await restore({ acceptLegacy: '1' });
    assert.equal(restored.status, 200, restored.body && restored.body.error);
    assert.deepEqual(applicationIds(), rebuiltIds);
    sessions(); // a restauração encerra as sessões
    const byId = id => db.memory.examApplications.find(item => item.id === id);
    const configOf = name => fixture.backup.data.classes.find(item => item.name === name).onlineExamConfigs[examKey];

    // Token: a versão anterior guardava só o hash (accessToken null). Antes o hash era
    // descartado e qualquer aluno começava a prova sem token.
    const withToken = byId(tokenApp);
    assert.equal(withToken.status, 'prepared');
    assert.equal(withToken.tokenEnabled, true);
    assert.ok(configOf('2DES').accessTokenHash);
    assert.equal(withToken.accessTokenHash, configOf('2DES').accessTokenHash);
    // Versão escolhida no Monitor para a Isabela, que ainda não tinha começado.
    assert.deepEqual(withToken.studentVersions, { [studentEmails.isabela]: 'B' });
    // Data da preparação que estava no backup (antes, a hora da restauração; a da
    // aplicação em andamento era a do início da prova).
    assert.equal(withToken.createdAt, configOf('2DES').preparedAt);
    assert.equal(withToken.preparedAt, configOf('2DES').preparedAt);
    assert.equal(db.memory.classes.find(item => item.name === '2DES').onlineExamConfigs[examKey].preparedAt, configOf('2DES').preparedAt);
    assert.equal(byId(second).createdAt, configOf('1DES').preparedAt);
    assert.equal(byId(second).startsAt, configOf('1DES').startTime);

    await admin('post', `/api/admin/exam-applications/${tokenApp}/control`).send({ action: 'start' }).expect(200);
    const startAttempt = id => as(id)('post', `/api/student/exam-applications/${tokenApp}/start-attempt`).send({});
    const validate = (id, token) => as(id)('post', '/api/student/validate-exam-token')
        .send({ email: studentEmails[id], studentClass: '2DES', courseId, examKey, applicationId: tokenApp, token });
    const refused = await startAttempt('bruno');
    assert.equal(refused.status, 403, 'sem o token, o Bruno não começa');
    assert.equal(refused.body.tokenRequired, true);
    assert.equal((await validate('bruno', 'ERRADO')).body.valid, false);
    assert.equal((await validate('bruno', fixture.accessToken)).body.valid, true);
    assert.equal((await startAttempt('bruno')).status, 200);
    assert.equal((await validate('isabela', fixture.accessToken)).body.valid, true);
    assert.equal((await startAttempt('isabela')).status, 200);
    const isabelaState = Object.values(db.memory.studentExamState)
        .find(state => state.applicationId === tokenApp && state.studentEmail === studentEmails.isabela);
    assert.equal(isabelaState.assignedVersion, 'B', 'antes a escolha do Monitor sumia e ela recebia outra versão');
    assert.equal(isabelaState.versionAssigned, true);

    // Pausada no backup: fica pausada desde o momento dele, com o cronômetro parado. Antes
    // a aplicação refeita ficava "pausada" sem o início da pausa (o tempo continuava
    // correndo) e o boot seguinte gravava a pausa desde o início da prova: todos voltavam
    // a ter a duração inteira.
    const paused = byId(pausedApp);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.pausedAt, backupAt);
    assert.deepEqual(paused.pauses, [{ pausedAt: backupAt, resumedAt: null }]);
    const carla = Object.values(db.memory.studentExamState).find(state => state.attemptId === carlaAttempt);
    assert.equal(carla.status, 'active');
    const { computeAttemptDeadline } = require('../../backend/utils/examDeadline.js');
    const remaining = () => computeAttemptDeadline({ application: byId(pausedApp), state: carla, now: Date.now() }) - Date.now();
    // O que faltava no momento do backup (60 min menos os ~20 min já feitos).
    const remainingAtBackup = Number(carla.startedAt) + 60 * 60000 - backupAt;
    assert.ok(remainingAtBackup < 41 * 60000 && remainingAtBackup > 39 * 60000, String(remainingAtBackup));
    const firstRead = remaining();
    assert.ok(Math.abs(firstRead - remainingAtBackup) < 1000, `${firstRead} x ${remainingAtBackup}`);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.ok(Math.abs(remaining() - firstRead) < 50, 'o cronômetro não anda durante a pausa');

    // Encerrada: o horário de encerramento é aproximado pela última entrega (antes, null).
    const finished = byId(finishedApp);
    assert.equal(finished.status, 'finished');
    const evaSubmission = db.memory.submissions.find(item => item.applicationId === finishedApp);
    assert.equal(finished.finishedAt, new Date(Date.parse(evaSubmission.timestamp)).toISOString());

    // O boot seguinte não muda nada, e a Carla continua com o tempo que tinha no backup.
    await db.save();
    const after = bootOutput(`const db = require(${databasePath});
const { computeAttemptDeadline } = require(${JSON.stringify(require.resolve('../../backend/utils/examDeadline.js'))});
db.init().then(async () => {
    const application = db.memory.examApplications.find(item => item.id === ${JSON.stringify(pausedApp)});
    const carla = Object.values(db.memory.studentExamState).find(state => state.attemptId === ${JSON.stringify(carlaAttempt)});
    const now = Date.now();
    process.stdout.write('@@' + JSON.stringify({ pausedAt: application.pausedAt, pauses: application.pauses, remaining: computeAttemptDeadline({ application, state: carla, now }) - now }));
    await db.close();
});`);
    assert.equal(after.pausedAt, backupAt);
    assert.deepEqual(after.pauses, [{ pausedAt: backupAt, resumedAt: null }]);
    assert.ok(Math.abs(after.remaining - remainingAtBackup) < 1000, `${after.remaining} x ${remainingAtBackup}`);
});

test('[UC-APLICACAO-001] atualização: "+N min" dado pela versão anterior com a tentativa aberta não passa para a tentativa seguinte', () => {
    // O banco como a versão anterior o deixou (com as aplicações), atualizado pelo boot.
    // A versão anterior gravava o +10 min do Davi na tentativa 1 dele E na aplicação, e a
    // tentativa 2 copiava o da aplicação (70 min em vez de 60). O +5 min do Fábio, dado
    // antes de ele começar, continua esperando a primeira tentativa dele.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-ajuste-anterior-test-'));
    const env = { ...process.env, ICLASS_DATA_DIR: dataDir, ICLASS_CONTENT_DIR: path.join(dataDir, 'content'), ICLASS_ARCHIVE_DIR: path.join(dataDir, 'archives') };
    try {
        bootOutput(`const db = require(${databasePath});
const fixture = require(${JSON.stringify(path.join(__dirname, 'fixtures', 'backup-versao-anterior.json'))});
db.init().then(async () => {
    const secret = db.memory.config.examAnswerSecret;
    Object.assign(db.memory, fixture.backup.data);
    db.memory.config = { ...db.memory.config, examAnswerSecret: secret };
    db.memory.examApplications = fixture.applicationsAtBackup;
    await db.save();
    process.stdout.write('@@{}');
    await db.close();
});`, env);
        const read = `const db = require(${databasePath});
const { createAttemptState } = require(${JSON.stringify(require.resolve('../../backend/utils/examApplications.js'))});
db.init().then(async () => {
    const application = db.memory.examApplications.find(item => item.id === ${JSON.stringify(pausedApp)});
    const adjustmentOf = (studentEmail, attemptNumber) => createAttemptState({ application, studentEmail, attemptNumber, studentClass: '3DES', courseId: ${JSON.stringify(courseId)} }).individualTimeAdjustment;
    const davi = Object.values(db.memory.studentExamState).find(state => state.applicationId === application.id && state.studentEmail === 'davi@antigo.local');
    process.stdout.write('@@' + JSON.stringify({
        studentAdjustments: application.studentAdjustments,
        mode: application.studentAdjustmentsMode,
        daviAttempt1: davi.individualTimeAdjustment,
        daviAttempt2: adjustmentOf('davi@antigo.local', 2),
        fabioAttempt1: adjustmentOf('fabio@antigo.local', 1),
    }));
    await db.close();
});`;
        const firstBoot = bootOutput(read, env);
        assert.deepEqual(firstBoot, {
            studentAdjustments: { 'fabio@antigo.local': 5 },
            mode: 'next_attempt',
            daviAttempt1: 10,
            daviAttempt2: 0,
            fabioAttempt1: 5,
        });
        // Idempotente: o boot seguinte não tira de novo.
        assert.deepEqual(bootOutput(read, env), firstBoot);
    } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test('[UC-APLICACAO-001] atualização: a versão escolhida no Monitor da versão anterior para quem não começou continua, com o "+N min" dado antes de começar', () => {
    // O banco como a versão anterior o deixou (com as aplicações). Na 2DES (preparada,
    // com token) o Monitor escolheu a versão B para a Isabela, que ainda não tinha
    // entrado, e deu +7 min a ela: a versão anterior gravava as duas coisas na aplicação
    // e no estado avulso "<email>_<prova>" (versionAssigned, individualTimeAdjustment),
    // como faz adjust-student-time em 5b69148. Antes, depois da atualização, o estado
    // avulso virava a tentativa dela e era reiniciado: versão sorteada de novo (metade
    // das vezes A) e o +7 sumia da tentativa, parado em application.studentAdjustments.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-versao-anterior-monitor-test-'));
    const env = { ...process.env, ICLASS_DATA_DIR: dataDir, ICLASS_CONTENT_DIR: path.join(dataDir, 'content'), ICLASS_ARCHIVE_DIR: path.join(dataDir, 'archives') };
    const isabela = studentEmails.isabela;
    const looseKey = `${isabela}_${examKey}`;
    try {
        bootOutput(`const db = require(${databasePath});
const fixture = require(${JSON.stringify(path.join(__dirname, 'fixtures', 'backup-versao-anterior.json'))});
db.init().then(async () => {
    const secret = db.memory.config.examAnswerSecret;
    Object.assign(db.memory, fixture.backup.data);
    db.memory.config = { ...db.memory.config, examAnswerSecret: secret };
    db.memory.examApplications = fixture.applicationsAtBackup;
    const application = db.memory.examApplications.find(item => item.id === ${JSON.stringify(tokenApp)});
    application.studentAdjustments = { ${JSON.stringify(isabela)}: 7 };
    db.memory.studentExamState[${JSON.stringify(looseKey)}].individualTimeAdjustment = 7;
    await db.save();
    process.stdout.write('@@{}');
    await db.close();
});`, env);
        const read = `const db = require(${databasePath});
db.init().then(async () => {
    const application = db.memory.examApplications.find(item => item.id === ${JSON.stringify(tokenApp)});
    process.stdout.write('@@' + JSON.stringify({
        applications: db.memory.examApplications,
        states: db.memory.studentExamState,
        loose: db.memory.studentExamState[${JSON.stringify(looseKey)}],
        studentVersions: application.studentVersions,
        studentAdjustments: application.studentAdjustments,
    }));
    await db.close();
});`;
        const firstBoot = bootOutput(read, env);
        assert.deepEqual(firstBoot.studentVersions, { [isabela]: 'B' });
        assert.deepEqual(firstBoot.studentAdjustments, { [isabela]: 7 });
        assert.equal(firstBoot.loose.versionAssigned, false, 'o estado avulso deixa de ser a tentativa dela');
        assert.equal(firstBoot.loose.assignedVersion, 'B', 'nada é apagado do estado avulso');
        // Idempotente: o boot seguinte não muda nada.
        const secondBoot = bootOutput(read, env);
        assert.deepEqual(secondBoot.applications, firstBoot.applications);
        assert.deepEqual(secondBoot.states, firstBoot.states);

        // O professor inicia a prova; a Isabela valida o token e começa: versão B e +7 min,
        // sempre (antes dependia do sorteio).
        const started = bootOutput(`const db = require(${databasePath});
const request = require(${JSON.stringify(require.resolve('supertest'))});
const { createApp } = require(${JSON.stringify(require.resolve('../../backend/server.js'))});
db.init().then(async () => {
    const app = createApp();
    db.memory.adminSessions = { admin: { email: 'admin@antigo.local', createdAt: Date.now(), lastSeen: Date.now() } };
    db.memory.sessions[${JSON.stringify(isabela)}] = { token: 'isabela', lastSeen: Date.now(), ip: '127.0.0.1' };
    const control = await request(app).post('/api/admin/exam-applications/${tokenApp}/control').set('x-admin-session', 'admin').send({ action: 'start' });
    const validate = await request(app).post('/api/student/validate-exam-token').set('x-session-token', 'isabela')
        .send({ email: ${JSON.stringify(isabela)}, studentClass: '2DES', courseId: ${JSON.stringify(courseId)}, examKey: ${JSON.stringify(examKey)}, applicationId: ${JSON.stringify(tokenApp)}, token: ${JSON.stringify(fixture.accessToken)} });
    const start = await request(app).post('/api/student/exam-applications/${tokenApp}/start-attempt').set('x-session-token', 'isabela').send({});
    const application = db.memory.examApplications.find(item => item.id === ${JSON.stringify(tokenApp)});
    const attempt = Object.values(db.memory.studentExamState).find(state => state.applicationId === application.id && state.studentEmail === ${JSON.stringify(isabela)});
    process.stdout.write('@@' + JSON.stringify({
        control: control.status,
        valid: validate.body.valid,
        start: start.status,
        version: attempt.assignedVersion,
        versionAssigned: attempt.versionAssigned,
        adjustment: attempt.individualTimeAdjustment,
        minutes: Math.round((attempt.deadlineAt - attempt.startedAt) / 60000),
        duration: application.durationMinutes,
        pending: application.studentAdjustments,
    }));
    await new Promise(resolve => setTimeout(resolve, 300));
    await db.close();
});`, env);
        assert.equal(started.control, 200);
        assert.equal(started.valid, true);
        assert.equal(started.start, 200);
        assert.equal(started.version, 'B', 'antes a versão era sorteada de novo');
        assert.equal(started.versionAssigned, true);
        assert.equal(started.adjustment, 7, 'antes o +7 min sumia da tentativa');
        assert.equal(started.minutes, started.duration + 7);
        assert.deepEqual(started.pending, {}, 'o +7 min vale para esta tentativa e não fica parado na aplicação');
    } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
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
