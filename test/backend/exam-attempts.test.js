const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-attempts-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const {
    countStudentExamAttempts,
    normalizeMaxAttempts,
    parseMaxAttempts,
} = require('../../backend/utils/examAttempts.js');

let app;

test.before(async () => {
    await db.init();
    app = createApp();
});

test.after(async () => {
    // Algumas rotas legadas disparam db.save() sem aguardar; deixa a fila terminar
    // antes de fechar a conexão temporária usada exclusivamente por este arquivo.
    await new Promise(resolve => setTimeout(resolve, 1000));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('normaliza limite e ignora tentativas invalidadas', () => {
    assert.deepEqual(parseMaxAttempts(''), { valid: true, value: null });
    assert.deepEqual(parseMaxAttempts('3'), { valid: true, value: 3 });
    assert.equal(parseMaxAttempts(0).valid, false);
    assert.equal(parseMaxAttempts(11).valid, false);
    assert.equal(normalizeMaxAttempts(undefined), null);
    assert.equal(countStudentExamAttempts([
        { student: { email: 'aluno@teste.local', courseId: 'curso-1' }, examKey: 'Avaliacao_Teste' },
        { student: { email: 'aluno@teste.local', courseId: 'curso-1' }, examKey: 'Avaliacao_Teste', resultStatus: 'invalidated' },
    ], { studentEmail: 'ALUNO@teste.local', examKey: 'Avaliacao_Teste', courseId: 'curso-1' }), 1);
});

test('persiste maxAttempts, expõe o consumo e bloqueia o envio excedente', async () => {
    const adminEmail = 'admin@teste.local';
    const adminToken = 'admin-token-attempts';
    const studentEmail = 'aluno@teste.local';
    const studentToken = 'student-token-attempts';
    const courseId = 'curso-tentativas';
    const studentClass = 'Turma Tentativas';
    const examKey = 'Avaliacao_Tentativas';

    db.memory.admins = [{ email: adminEmail, name: 'Admin', role: 'admin', password: db.hashPassword('senha-administrativa') }];
    db.memory.adminSessions = { [adminToken]: { email: adminEmail, createdAt: Date.now(), lastSeen: Date.now() } };
    db.memory.students = [{
        name: 'Aluno Teste',
        email: studentEmail,
        status: 'Ativo',
        classes: [{ name: studentClass, courseId }],
    }];
    db.memory.sessions = { [studentEmail]: { token: studentToken, lastSeen: Date.now(), ip: '127.0.0.1' } };
    db.memory.courses = [{
        id: courseId,
        structure: [{ name: 'Módulo', units: [{ avaliacaoKey: examKey }] }],
    }];
    db.memory.classes = [{ name: studentClass, courseId, releasedItems: {} }];
    db.memory.evaluations = {
        [examKey]: {
            questions: [{
                number: 1,
                text: 'Questão de teste',
                correctAnswer: 'A',
                alternatives: [
                    { letter: 'A', text: 'Correta', isCorrect: true },
                    { letter: 'B', text: 'Incorreta', isCorrect: false },
                ],
            }],
        },
    };
    db.memory.submissions = [];
    db.memory.studentExamState = {};
    db.memory.broadcastMessages = [];

    await request(app)
        .post('/api/admin/online-exam-config')
        .set('x-admin-session', adminToken)
        .send({ studentClass, courseId, examKey, maxAttempts: 0 })
        .expect(400);

    const prepared = await request(app)
        .post('/api/admin/online-exam-config')
        .set('x-admin-session', adminToken)
        .send({ studentClass, courseId, examKey, durationMinutes: 30, maxAttempts: 2 })
        .expect(200);
    assert.equal(prepared.body.onlineExamConfig.maxAttempts, 2);

    const historyResponse = await request(app)
        .post('/api/admin/exam-history/add')
        .set('x-admin-session', adminToken)
        .send({
            studentClass,
            courseId,
            examKey,
            type: 'online',
            questionNumbers: [1],
            printSnapshot: [{ questions: [{ originalNumber: 1, text: 'Questão de teste', alternatives: [{ letter: 'A', text: 'Correta' }, { letter: 'B', text: 'Incorreta' }] }] }],
            waitingRoomMinutes: 0,
            maxAttempts: 1,
        })
        .expect(200);
    assert.equal(historyResponse.body.entry.maxAttempts, 1);

    await request(app)
        .post('/api/admin/release-item')
        .set('x-admin-session', adminToken)
        .send({
            studentClass,
            courseId,
            itemKey: examKey,
            released: true,
            historyId: historyResponse.body.entry.id,
            applicationOptions: { waitingRoomMinutes: 0, maxAttempts: 1 },
        })
        .expect(200);

    const onlineConfig = db.memory.classes[0].onlineExamConfigs[examKey];
    assert.equal(onlineConfig.maxAttempts, 1);
    const stateKey = `${studentEmail}_${examKey}`;
    db.memory.studentExamState[stateKey] = {
        studentEmail,
        studentClass,
        courseId,
        examKey,
        answers: {},
        startedAt: onlineConfig.startTime,
        deadlineAt: Date.now() + 30 * 60000,
        assignedVersion: 'A',
        versionAssigned: true,
        assignedQuestionNumbers: [1],
        examConfigVersion: onlineConfig.updatedAt,
        individualTimeAdjustment: 0,
    };

    const submissionBody = {
        email: studentEmail,
        studentClass,
        courseId,
        examKey,
        answers: { 1: 'A' },
        questionNumbers: [1],
        examConfigVersion: onlineConfig.updatedAt,
    };

    await request(app)
        .post('/api/student/submit')
        .set('x-session-token', studentToken)
        .send(submissionBody)
        .expect(200);
    assert.equal(db.memory.submissions.length, 1);
    assert.equal(db.memory.submissions[0].attemptNumber, 1);

    const sync = await request(app)
        .get('/api/student/sync')
        .set('x-session-token', studentToken)
        .query({ email: studentEmail, studentClass, courseId, examKey })
        .expect(200);
    assert.equal(sync.body.attemptsUsed, 1);
    assert.equal(sync.body.maxAttempts, 1);

    const examState = await request(app)
        .get('/api/student/exam-state')
        .set('x-session-token', studentToken)
        .query({ email: studentEmail, studentClass, courseId, examKey })
        .expect(200);
    assert.equal(examState.body.attemptsUsed, 1);
    assert.equal(examState.body.maxAttempts, 1);

    const blocked = await request(app)
        .post('/api/student/submit')
        .set('x-session-token', studentToken)
        .send(submissionBody)
        .expect(403);
    assert.equal(blocked.body.attemptsExhausted, true);
    assert.equal(blocked.body.attemptsUsed, 1);
    assert.equal(blocked.body.maxAttempts, 1);
    assert.equal(db.memory.submissions.length, 1);
});
