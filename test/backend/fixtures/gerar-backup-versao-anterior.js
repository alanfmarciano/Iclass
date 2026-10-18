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

(async () => {
    await db.init();
    const app = createApp();
    db.memory.admins = [{ email: adminEmail, name: 'Admin', role: 'admin', password: db.hashPassword('senha-antiga') }];
    db.memory.adminSessions = { [adminToken]: { email: adminEmail, createdAt: Date.now(), lastSeen: Date.now() } };
    db.memory.students = [{ name: 'Ana Antiga', email: studentEmail, status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: studentClass, courseId }] }];
    db.memory.sessions = { [studentEmail]: { token: studentToken, lastSeen: Date.now(), ip: '127.0.0.1' } };
    db.memory.courses = [{ id: courseId, name: 'Curso antigo', structure: [{ name: 'Módulo', units: [{ avaliacaoKey: examKey }] }] }];
    db.memory.classes = [{ name: studentClass, courseId, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} }];
    db.memory.evaluations = { [examKey]: { key: examKey, title: 'Prova da versão anterior', questions: [{
        number: 1, text: 'Quanto é 1 + 1?', correctAnswer: 'B',
        alternatives: [{ letter: 'A', text: '1', isCorrect: false }, { letter: 'B', text: '2', isCorrect: true }],
    }] } };
    db.memory.submissions = [];
    db.memory.examApplications = [];
    db.memory.studentExamState = {};

    const admin = (method, url) => request(app)[method](url).set('x-admin-session', adminToken);
    const student = (method, url) => request(app)[method](url).set('x-session-token', studentToken);
    const prepareAndStart = async () => {
        const history = await admin('post', '/api/admin/exam-history/add').send({
            studentClass, courseId, examKey, type: 'online', questionNumbers: [1],
            printSnapshot: [{ version: 'A', questions: [{ originalNumber: 1, text: 'Quanto é 1 + 1?', correctAnswer: 'B',
                alternatives: [{ letter: 'A', text: '1' }, { letter: 'B', text: '2' }] }] }],
            durationMinutes: 30, waitingRoomMinutes: 0, maxAttempts: 1,
        }).expect(200);
        const created = await admin('post', '/api/admin/exam-applications').send({
            studentClass, courseId, examKey, historyId: history.body.entry.id,
            applicationOptions: { timerMode: 'per_attempt', waitingRoomMinutes: 0, maxAttempts: 1, durationMinutes: 30 },
        }).expect(201);
        const started = await admin('post', `/api/admin/exam-applications/${created.body.application.id}/control`).send({ action: 'start' }).expect(200);
        return started.body.application;
    };
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

    await db.save();
    const snapshot = backup.buildDataSnapshot();
    const fixture = {
        geradoPor: 'backend/utils/backup.js da versão 5b69148 (em produção antes da fase 1)',
        backup: snapshot,
        // Aplicações do banco naquele momento (o backup antigo não as guardava).
        applicationsAtBackup: db.memory.examApplications,
        ids: { first: first.id, second: second.id, secondAttempt: secondAttempt.body.attemptId },
    };
    fs.writeFileSync(output, JSON.stringify(fixture, null, 1));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    console.log('ok', Object.keys(snapshot.data).join(','), 'examApplications' in snapshot.data);
})().catch(error => { console.error(error); process.exit(1); });
