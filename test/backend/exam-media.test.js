// Imagem da questão de prova (fase 3, P3-S2: UXA-12; decisão D11 e contrato C8 do desenho
// P3). O professor cita /uploads/<arquivo> no Markdown do enunciado, da alternativa ou da
// explicação; o aluno só recebe o arquivo com a tentativa dele aberta e liberada
// (enunciado e alternativas) ou numa entrega dele com o gabarito liberado (também a
// explicação). Antes do início, depois da entrega sem gabarito, para quem não começou e
// para aluno de outra turma: 403, mesmo sabendo o nome do arquivo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-exam-media-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const runtimePaths = require('../../backend/runtimePaths.js');
const { createApp } = require('../../backend/server.js');
const { referencedExamUploads } = require('../../backend/utils/examMedia.js');

let app;
const adminToken = 'admin-token-exam-media';
const adminEmail = 'admin@imagens.local';
const studentClass = 'Turma Imagens';
const otherClass = 'Turma Vizinha';
const courseId = 'curso-imagens';
const examKey = 'Avaliacao_Imagens';
const students = {
    ana: { email: 'ana@imagens.local', token: 'token-ana-imagens', className: studentClass },
    bruno: { email: 'bruno@imagens.local', token: 'token-bruno-imagens', className: studentClass },
    carla: { email: 'carla@imagens.local', token: 'token-carla-imagens', className: otherClass },
};
// PNG de 1 x 1.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const FILES = ['q-enunciado.png', 'q-alternativa.png', 'q-explicacao.png', 'solto.png'];

const QUESTIONS = [
    {
        type: 'multiple_choice',
        points: 1,
        text: 'Observe a rede:\n\n![rede da sala](/uploads/q-enunciado.png)',
        alternatives: [{ text: '![topologia](uploads/q-alternativa.png)' }, { text: 'Anel' }],
        correctAnswer: 'A',
        explanation: 'Veja o diagrama: ![explicação](/uploads/q-explicacao.png)',
    },
];

test.before(async () => {
    await db.init();
    app = createApp();
    fs.mkdirSync(runtimePaths.UPLOADS_DIR, { recursive: true });
    FILES.forEach(name => fs.writeFileSync(path.join(runtimePaths.UPLOADS_DIR, name), PNG));
    db.memory.admins = [{ email: adminEmail, name: 'Admin', role: 'admin', password: db.hashPassword('senha-administrativa') }];
    db.memory.adminSessions = { [adminToken]: { email: adminEmail, createdAt: Date.now(), lastSeen: Date.now() } };
    db.memory.students = Object.values(students).map((student, index) => ({
        name: `Aluno ${index + 1}`,
        email: student.email,
        status: 'Ativo',
        classes: [{ name: student.className, courseId }],
    }));
    db.memory.sessions = Object.fromEntries(Object.values(students).map(student => [
        student.email,
        { token: student.token, lastSeen: Date.now(), ip: '127.0.0.1' },
    ]));
    db.memory.courses = [{ id: courseId, structure: [{ name: 'Módulo', units: [{ avaliacaoKey: examKey }] }] }];
    db.memory.classes = [
        { name: studentClass, courseId, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} },
        { name: otherClass, courseId, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} },
    ];
    db.memory.evaluations = { [examKey]: { key: examKey, title: 'Prova com imagem', questions: [] } };
    db.memory.library = [];
    db.memory.submissions = [];
    db.memory.examApplications = [];
    db.memory.studentExamState = {};
    db.memory.proctoringLogs = [];
    db.memory.broadcastMessages = [];
});

test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

function image(name, student) {
    return request(app).get(`/uploads/${name}`).query({ access: student.token });
}

async function statuses(student) {
    const result = {};
    for (const name of FILES) result[name] = (await image(name, student)).status;
    return result;
}

function sync(student, applicationId, attemptId = '') {
    return request(app)
        .get('/api/student/sync')
        .set('x-session-token', student.token)
        .query({ email: student.email, studentClass, courseId, examKey, applicationId, attemptId })
        .expect(200);
}

async function prepare() {
    const saved = await request(app)
        .put(`/api/admin/evaluation/${examKey}`)
        .set('x-admin-session', adminToken)
        .send({ title: 'Prova com imagem', theme: 'Redes', rubric: '', questions: QUESTIONS })
        .expect(200);
    const evaluation = saved.body.evaluation;
    const history = await request(app)
        .post('/api/admin/exam-history/add')
        .set('x-admin-session', adminToken)
        .send({
            studentClass, courseId, examKey, type: 'online',
            questionNumbers: evaluation.questions.map(question => question.originalNumber),
            printSnapshot: [{
                version: 'A',
                questions: evaluation.questions.map((question, index) => ({
                    originalNumber: question.originalNumber,
                    examNumber: index + 1,
                    text: question.text,
                    questionText: question.text,
                    correctAnswer: question.correctAnswer,
                    alternatives: question.alternatives.map((alternative, position) => ({ ...alternative, displayLetter: 'AB'[position] })),
                })),
            }],
            shuffleAnswers: false, durationMinutes: 30, waitingRoomMinutes: 0, maxAttempts: 1,
        })
        .expect(200);
    const created = await request(app)
        .post('/api/admin/exam-applications')
        .set('x-admin-session', adminToken)
        .send({ studentClass, courseId, examKey, historyId: history.body.entry.id, applicationOptions: { timerMode: 'per_attempt', waitingRoomMinutes: 0, maxAttempts: 1 } })
        .expect(201);
    return created.body.application;
}

function control(applicationId, data) {
    return request(app)
        .post(`/api/admin/exam-applications/${applicationId}/control`)
        .set('x-admin-session', adminToken)
        .send(data)
        .expect(200);
}

test('[UC-SIGILO-001] imagem da questão: 403 antes do início, 200 com a tentativa aberta, 403 depois da entrega sem gabarito, 200 com o gabarito liberado e 403 para outra turma (D11)', async () => {
    const application = await prepare();
    const closed = { 'q-enunciado.png': 403, 'q-alternativa.png': 403, 'q-explicacao.png': 403, 'solto.png': 403 };

    // Preparada: ninguém vê, nem com o nome do arquivo.
    assert.deepEqual(await statuses(students.ana), closed, 'aplicação só preparada');
    // O professor sempre vê (o editor e a prévia usam a sessão dele).
    const teacher = await request(app).get('/uploads/q-enunciado.png').query({ access: adminToken });
    assert.equal(teacher.status, 200);

    await control(application.id, { action: 'start' });
    // Em andamento, mas a Ana ainda não iniciou a tentativa.
    await sync(students.ana, application.id);
    assert.deepEqual(await statuses(students.ana), closed, 'tentativa ainda não iniciada');

    const started = await request(app)
        .post(`/api/student/exam-applications/${application.id}/start-attempt`)
        .set('x-session-token', students.ana.token)
        .send({})
        .expect(200);
    assert.ok(started.body.questions[0].text.includes('/uploads/q-enunciado.png'), 'o Markdown vai como está');
    // Tentativa aberta: enunciado e alternativa saem; a explicação, não (revela a resposta).
    assert.deepEqual(await statuses(students.ana), { ...closed, 'q-enunciado.png': 200, 'q-alternativa.png': 200 });
    const served = await image('q-enunciado.png', students.ana);
    assert.equal(served.headers['content-type'], 'image/png');
    assert.equal(served.headers['cache-control'], 'private, no-store');
    // Colega da turma que não começou e aluno de outra turma: nada.
    assert.deepEqual(await statuses(students.bruno), closed, 'colega sem tentativa iniciada');
    assert.deepEqual(await statuses(students.carla), closed, 'aluno de outra turma');

    // Pausada pelo professor: as questões somem da tela, e as imagens também.
    await control(application.id, { action: 'pause' });
    assert.deepEqual(await statuses(students.ana), closed, 'aplicação pausada');
    await control(application.id, { action: 'resume' });
    assert.equal((await image('q-enunciado.png', students.ana)).status, 200);

    const synced = await sync(students.ana, application.id, started.body.attemptId);
    const answerId = synced.body.questions[0].alternatives[0].id;
    await request(app)
        .post('/api/student/submit')
        .set('x-session-token', students.ana.token)
        .send({ studentClass, courseId, examKey, applicationId: application.id, attemptId: started.body.attemptId, answers: { 1: answerId }, examConfigVersion: synced.body.examConfigVersion })
        .expect(200);
    // Entregue, sem gabarito liberado: fecha de novo.
    assert.deepEqual(await statuses(students.ana), closed, 'depois da entrega sem gabarito');

    // Encerrada, nota publicada e gabarito liberado: a revisão dela mostra tudo, inclusive
    // a imagem da explicação. Upload solto continua fechado; a outra turma também.
    await control(application.id, { action: 'finish', inProgressPolicy: 'submit' });
    const submission = db.memory.submissions.find(item => item.attemptId === started.body.attemptId);
    submission.gradePublished = true;
    const cls = db.memory.classes.find(item => item.name === studentClass);
    cls.releasedItems[`Gabarito_${examKey}`] = true;
    assert.deepEqual(await statuses(students.ana), { 'q-enunciado.png': 200, 'q-alternativa.png': 200, 'q-explicacao.png': 200, 'solto.png': 403 });
    assert.deepEqual(await statuses(students.bruno), closed, 'colega sem entrega');
    assert.deepEqual(await statuses(students.carla), closed, 'aluno de outra turma');

    // Nova aplicação da mesma prova preparada: o gabarito volta a ficar bloqueado (G2).
    cls.releasedItems[`Gabarito_${examKey}`] = false;
    assert.deepEqual(await statuses(students.ana), closed, 'gabarito fechado de novo');
    // Sem sessão: 401.
    assert.equal((await request(app).get('/uploads/q-enunciado.png')).status, 401);
});

test('[UC-SIGILO-001] referencedExamUploads lista as imagens da avaliação e do item do banco para levar junto (C8)', () => {
    assert.deepEqual(referencedExamUploads({ questions: QUESTIONS }), ['q-alternativa.png', 'q-enunciado.png', 'q-explicacao.png']);
    // Item do banco de questões (questionText e alternativas antigas em objeto).
    assert.deepEqual(referencedExamUploads({
        questionText: 'Veja ![a](/uploads/banco-a.png) e ![b](/uploads/banco-a.png)',
        alternatives: { A: '![c](/uploads/banco-c.png)', B: 'texto' },
        expectedAnswer: 'Resposta com ![d](uploads/banco-d.png)',
    }), ['banco-a.png', 'banco-c.png', 'banco-d.png']);
    assert.deepEqual(referencedExamUploads(null), []);
    assert.deepEqual(referencedExamUploads({ questions: [{ text: 'sem imagem' }] }), []);
});
