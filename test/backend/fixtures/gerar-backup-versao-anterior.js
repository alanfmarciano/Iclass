// Gera test/backend/fixtures/backup-versao-anterior.json com o código da versão em
// produção antes da fase 1 (5b69148), que não guardava as aplicações de prova no backup.
// Não é teste (não roda na suíte). Para gerar de novo:
//   mkdir /tmp/antigo && git archive 5b69148 backend package.json | tar -x -C /tmp/antigo
//   ln -s "$PWD/node_modules" /tmp/antigo/node_modules
//   node test/backend/fixtures/gerar-backup-versao-anterior.js /tmp/antigo test/backend/fixtures/backup-versao-anterior.json
const fs = require('fs');
const os = require('os');
const path = require('path');
const [oldRoot, output] = process.argv.slice(2);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-backup-antigo-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';
const request = require(path.join(oldRoot, 'node_modules/supertest'));
const db = require(path.join(oldRoot, 'backend/database.js'));
const { createApp } = require(path.join(oldRoot, 'backend/server.js'));
const backup = require(path.join(oldRoot, 'backend/utils/backup.js'));

const adminToken = 'admin-token-antigo';
const studentToken = 'student-token-antigo';
const adminEmail = 'admin@antigo.local';
const studentEmail = 'ana@antigo.local';
const studentClass = '1DES';
const courseId = 'curso-antigo';
const examKey = 'Avaliacao_Antiga';
// Turmas a mais (rodada 3 da revisão): prova preparada com token e versão escolhida no
// Monitor (2DES), prova por tentativa pausada aos 20 min com "+N min" (3DES) e prova
// encerrada (4DES).
const tokenClass = '2DES';
const pausedClass = '3DES';
const finishedClass = '4DES';
const accessToken = 'SENHA';
const others = {
    bruno: { email: 'bruno@antigo.local', name: 'Bruno Antigo', studentClass: tokenClass },
    isabela: { email: 'isabela@antigo.local', name: 'Isabela Antiga', studentClass: tokenClass },
    carla: { email: 'carla@antigo.local', name: 'Carla Antiga', studentClass: pausedClass },
    davi: { email: 'davi@antigo.local', name: 'Davi Antigo', studentClass: pausedClass },
    fabio: { email: 'fabio@antigo.local', name: 'Fábio Antigo', studentClass: pausedClass },
    eva: { email: 'eva@antigo.local', name: 'Eva Antiga', studentClass: finishedClass },
};

(async () => {
    await db.init();
    const app = createApp();
    db.memory.admins = [{ email: adminEmail, name: 'Admin', role: 'admin', password: db.hashPassword('senha-antiga') }];
    db.memory.adminSessions = { [adminToken]: { email: adminEmail, createdAt: Date.now(), lastSeen: Date.now() } };
    db.memory.students = [{ name: 'Ana Antiga', email: studentEmail, status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: studentClass, courseId }] }];
    db.memory.sessions = { [studentEmail]: { token: studentToken, lastSeen: Date.now(), ip: '127.0.0.1' } };
    Object.entries(others).forEach(([id, item]) => {
        db.memory.students.push({ name: item.name, email: item.email, status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: item.studentClass, courseId }] });
        db.memory.sessions[item.email] = { token: `${id}-token-antigo`, lastSeen: Date.now(), ip: '127.0.0.1' };
    });
    db.memory.courses = [{ id: courseId, name: 'Curso antigo', structure: [{ name: 'Módulo', units: [{ avaliacaoKey: examKey }] }] }];
    db.memory.classes = [studentClass, tokenClass, pausedClass, finishedClass]
        .map(name => ({ name, courseId, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} }));
    db.memory.evaluations = { [examKey]: { key: examKey, title: 'Prova da versão anterior', questions: [{
        number: 1, text: 'Quanto é 1 + 1?', correctAnswer: 'B',
        alternatives: [{ letter: 'A', text: '1', isCorrect: false }, { letter: 'B', text: '2', isCorrect: true }],
    }] } };
    db.memory.submissions = [];
    db.memory.examApplications = [];
    db.memory.studentExamState = {};

    const admin = (method, url) => request(app)[method](url).set('x-admin-session', adminToken);
    const student = (method, url) => request(app)[method](url).set('x-session-token', studentToken);
    const as = id => (method, url) => request(app)[method](url).set('x-session-token', `${id}-token-antigo`);
    const versionA = { version: 'A', questions: [{ originalNumber: 1, text: 'Quanto é 1 + 1?', correctAnswer: 'B',
        alternatives: [{ letter: 'A', text: '1' }, { letter: 'B', text: '2' }] }] };
    const versionB = { version: 'B', questions: [{ originalNumber: 1, text: 'Quanto é 1 + 1?', correctAnswer: 'A',
        alternatives: [{ letter: 'A', text: '2' }, { letter: 'B', text: '1' }] }] };
    const prepare = async ({ className = studentClass, durationMinutes = 30, maxAttempts = 1, printSnapshot = [versionA], options = {} } = {}) => {
        const history = await admin('post', '/api/admin/exam-history/add').send({
            studentClass: className, courseId, examKey, type: 'online', questionNumbers: [1],
            printSnapshot, durationMinutes, waitingRoomMinutes: 0, maxAttempts,
        }).expect(200);
        const created = await admin('post', '/api/admin/exam-applications').send({
            studentClass: className, courseId, examKey, historyId: history.body.entry.id,
            applicationOptions: { timerMode: 'per_attempt', waitingRoomMinutes: 0, maxAttempts, durationMinutes, ...options },
        }).expect(201);
        return created.body.application;
    };
    const start = async application => (await admin('post', `/api/admin/exam-applications/${application.id}/control`).send({ action: 'start' }).expect(200)).body.application;
    const prepareAndStart = async (settings) => start(await prepare(settings));
    const sync = applicationId => student('get', '/api/student/sync').query({ email: studentEmail, studentClass, courseId, examKey, applicationId }).expect(200);

    // 1ª aplicação: Ana entrega e a aplicação é encerrada.
    const first = await prepareAndStart();
    await sync(first.id);
    const firstAttempt = await student('post', `/api/student/exam-applications/${first.id}/start-attempt`).send({}).expect(200);
    await student('post', '/api/student/submit').send({
        studentClass, courseId, examKey, applicationId: first.id, attemptId: firstAttempt.body.attemptId,
        answers: { 1: 'A' }, questionNumbers: [1], examConfigVersion: firstAttempt.body.examConfigVersion,
    }).expect(200);
    await admin('post', `/api/admin/exam-applications/${first.id}/control`).send({ action: 'finish' }).expect(200);

    // 2ª aplicação (reaplicação): em andamento no momento do backup, Ana respondeu e não entregou.
    db.memory.examApplications.forEach(item => { item.maxAttempts = 1; });
    const second = await prepareAndStart();
    await sync(second.id);
    const secondAttempt = await student('post', `/api/student/exam-applications/${second.id}/start-attempt`).send({}).expect(200);
    await student('post', '/api/student/autosave-progress').send({
        studentClass, courseId, examKey, applicationId: second.id, attemptId: secondAttempt.body.attemptId, answers: { 1: 'B' },
    }).expect(200);

    // 2DES: preparada com token (a versão anterior guardava só o hash, com accessToken
    // null) e com 2 versões; o professor escolheu a versão B para a Isabela no Monitor
    // antes de ela começar. O Bruno não fez nada.
    const tokenApp = await prepare({ className: tokenClass, printSnapshot: [versionA, versionB], options: { tokenEnabled: true, accessToken } });
    await admin('post', '/api/admin/assign-student-version').send({
        studentEmail: others.isabela.email, examKey, applicationId: tokenApp.id, version: 'B',
    }).expect(200);

    // 3DES: por tentativa (60 min, 2 tentativas). Carla e Davi começaram a tentativa 1;
    // o Davi ganhou +10 min com ela aberta e o Fábio +5 min antes de começar. A prova
    // é pausada aos 20 min (o relógio é adiantado nos dados: início 20 min atrás).
    const pausedApp = await prepareAndStart({ className: pausedClass, durationMinutes: 60, maxAttempts: 2 });
    const syncAs = (id, applicationId, className) => as(id)('get', '/api/student/sync')
        .query({ email: others[id].email, studentClass: className, courseId, examKey, applicationId }).expect(200);
    const carlaAttempt = await (async () => {
        await syncAs('carla', pausedApp.id, pausedClass);
        const started = await as('carla')('post', `/api/student/exam-applications/${pausedApp.id}/start-attempt`).send({}).expect(200);
        await as('carla')('post', '/api/student/autosave-progress').send({
            studentClass: pausedClass, courseId, examKey, applicationId: pausedApp.id, attemptId: started.body.attemptId, answers: { 1: 'B' },
        }).expect(200);
        return started.body.attemptId;
    })();
    await syncAs('davi', pausedApp.id, pausedClass);
    await as('davi')('post', `/api/student/exam-applications/${pausedApp.id}/start-attempt`).send({}).expect(200);
    const adjust = (email, minutes) => admin('post', '/api/admin/adjust-student-time').send({
        studentClass: pausedClass, courseId, examKey, applicationId: pausedApp.id, targetEmail: email, adjustmentMinutes: minutes,
    }).expect(200);
    await adjust(others.davi.email, 10);
    await adjust(others.fabio.email, 5);
    const twentyMinutes = 20 * 60 * 1000;
    const pausedRecord = db.memory.examApplications.find(item => item.id === pausedApp.id);
    pausedRecord.startsAt -= twentyMinutes;
    const pausedConfig = db.memory.classes.find(item => item.name === pausedClass).onlineExamConfigs[examKey];
    pausedConfig.startTime -= twentyMinutes;
    Object.values(db.memory.studentExamState).filter(state => state.applicationId === pausedApp.id).forEach(state => {
        state.startedAt -= twentyMinutes;
        if (state.deadlineAt) state.deadlineAt -= twentyMinutes;
    });
    await admin('post', `/api/admin/exam-applications/${pausedApp.id}/control`).send({ action: 'pause' }).expect(200);

    // 4DES: encerrada depois de a Eva entregar.
    const finishedApp = await prepareAndStart({ className: finishedClass });
    await syncAs('eva', finishedApp.id, finishedClass);
    const evaAttempt = await as('eva')('post', `/api/student/exam-applications/${finishedApp.id}/start-attempt`).send({}).expect(200);
    await as('eva')('post', '/api/student/submit').send({
        studentClass: finishedClass, courseId, examKey, applicationId: finishedApp.id, attemptId: evaAttempt.body.attemptId,
        answers: { 1: 'B' }, questionNumbers: [1], examConfigVersion: evaAttempt.body.examConfigVersion,
    }).expect(200);
    await new Promise(resolve => setTimeout(resolve, 50));
    await admin('post', `/api/admin/exam-applications/${finishedApp.id}/control`).send({ action: 'finish' }).expect(200);

    await db.save();
    const snapshot = backup.buildDataSnapshot();
    const fixture = {
        geradoPor: 'backend/utils/backup.js da versão 5b69148 (em produção antes da fase 1)',
        backup: snapshot,
        // Aplicações do banco naquele momento (o backup antigo não as guardava).
        applicationsAtBackup: db.memory.examApplications,
        ids: {
            first: first.id, second: second.id, secondAttempt: secondAttempt.body.attemptId,
            tokenApp: tokenApp.id, pausedApp: pausedApp.id, carlaAttempt, finishedApp: finishedApp.id, evaAttempt: evaAttempt.body.attemptId,
        },
        accessToken,
    };
    fs.writeFileSync(output, JSON.stringify(fixture, null, 1));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    console.log('ok', Object.keys(snapshot.data).join(','), 'examApplications' in snapshot.data);
})().catch(error => { console.error(error); process.exit(1); });
