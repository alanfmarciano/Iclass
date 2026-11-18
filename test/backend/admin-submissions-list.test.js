// Respostas enxutas para o Monitor e a lista de entregas (fase 2, H2-D: DES-04, DES-13).
// - GET /api/admin/submissions sem examSnapshot (as questões ficam só na revisão) e com o
//   filtro applicationId ("Liberar notas" do Monitor);
// - GET /api/admin/exam-applications?view=summary sem versionSnapshots e questionReports,
//   com openReportCount (consultado a cada 5 s pelo Monitor); sem view, nada muda;
// - GET /api/admin/question-reports sem `config` (levava as versões e o gabarito a cada 3 s).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-submissions-list-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');

let app;
const adminToken = 'admin-token-lista-entregas';
const adminEmail = 'admin@lista.local';
const courseId = 'curso-lista';
const className = 'Turma Lista';
const examKey = 'Prova_Lista';
const snapshot = {
    version: 'A',
    questions: [1, 2].map(number => ({
        originalNumber: number,
        text: `Enunciado ${number}`,
        correctAnswer: 'B',
        alternatives: ['A', 'B', 'C'].map(letter => ({ letter, text: `Alternativa ${letter}`, isCorrect: letter === 'B' })),
    })),
};

function submission(id, applicationId, email, extra = {}) {
    return {
        id,
        studentEmail: email,
        student: { email, name: email.split('@')[0], studentClass: className, courseId, classes: [{ name: className, courseId }] },
        studentClass: className,
        courseId,
        examKey,
        applicationId,
        attemptId: `${id}-tentativa`,
        attemptNumber: 1,
        score: 50,
        correctCount: 1,
        totalCount: 2,
        gradePublished: false,
        timestamp: new Date().toISOString(),
        assignedVersion: 'A',
        examSnapshot: snapshot,
        gradedAnswers: [
            { questionNumber: 1, studentChoice: 'B', correctAnswer: 'B', isCorrect: true },
            { questionNumber: 2, studentChoice: 'A', correctAnswer: 'B', isCorrect: false },
        ],
        ...extra,
    };
}

test.before(async () => {
    await db.init();
    app = createApp();
    const m = db.memory;
    m.admins = [{ email: adminEmail, name: 'Admin', role: 'admin', password: db.hashPassword('senha-administrativa') }];
    m.adminSessions = { [adminToken]: { email: adminEmail, createdAt: Date.now(), lastSeen: Date.now() } };
    m.courses = [{ id: courseId, structure: [] }];
    m.classes = [{ name: className, courseId, releasedItems: {}, examHistory: {}, onlineExamConfigs: {
        [examKey]: { applicationId: 'app-2', versionSnapshots: [snapshot], status: 'running', onlineActive: true },
    } }];
    m.students = ['ana', 'bia'].map(name => ({ name, email: `${name}@lista.local`, status: 'Ativo', password: 'x', classes: [{ name: className, courseId }] }));
    m.examApplications = [
        { id: 'app-1', examKey, studentClass: className, courseId, status: 'finished', createdAt: new Date(Date.now() - 86400000).toISOString(), versionSnapshots: [snapshot], questionReports: [] },
        {
            id: 'app-2', examKey, studentClass: className, courseId, status: 'running', createdAt: new Date().toISOString(),
            versionSnapshots: [snapshot],
            questionReports: [
                { id: 'r1', questionNumber: 1, reason: 'duas_corretas', status: 'open', assignedVersion: 'A' },
                { id: 'r2', questionNumber: 1, reason: 'outro', status: 'open', assignedVersion: 'A' },
                { id: 'r3', questionNumber: 2, reason: 'outro', status: 'resolved', assignedVersion: 'A' },
            ],
        },
    ];
    m.submissions = [
        submission('sub-ana-1', 'app-1', 'ana@lista.local', { score: 90, gradePublished: true }),
        submission('sub-ana-2', 'app-2', 'ana@lista.local', { attemptNumber: 1 }),
        submission('sub-bia-2', 'app-2', 'bia@lista.local'),
    ];
    m.studentExamState = {};
    await db.save();
});

test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 200));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

function admin(url) {
    return request(app).get(url).set('x-admin-session', adminToken);
}

test('[UC-DESEMPENHO-004] lista de entregas sem examSnapshot e com filtro por aplicação; a revisão continua com as questões', async () => {
    const all = await admin('/api/admin/submissions').query({ courseId, studentClass: className }).expect(200);
    assert.equal(all.body.length, 3);
    all.body.forEach(item => assert.equal('examSnapshot' in item, false, `${item.id} sem examSnapshot`));
    assert.equal(/Enunciado 1/.test(all.text), false, 'as questões não vão na lista');
    // Os campos da consolidação continuam vindo.
    assert.ok(all.body.every(item => item.resultStatus && 'consolidatedScore' in item));
    // O snapshot continua gravado (só a resposta fica sem ele).
    assert.ok(db.memory.submissions.every(item => item.examSnapshot && item.examSnapshot.questions.length === 2));

    const filtered = await admin('/api/admin/submissions').query({ courseId, studentClass: className, applicationId: 'app-2' }).expect(200);
    assert.deepEqual(filtered.body.map(item => item.id).sort(), ['sub-ana-2', 'sub-bia-2']);
    const none = await admin('/api/admin/submissions').query({ courseId, studentClass: className, applicationId: 'app-inexistente' }).expect(200);
    assert.deepEqual(none.body, []);

    const review = await admin('/api/admin/submissions/sub-ana-2/review').expect(200);
    assert.equal(review.body.source, 'attempt');
    assert.deepEqual(review.body.questions.map(question => question.text), ['Enunciado 1', 'Enunciado 2']);
    assert.equal(review.body.questions[0].alternatives.length, 3);
});

test('[UC-DESEMPENHO-004] exam-applications?view=summary sem versões e contestações, com openReportCount; sem view, nada muda', async () => {
    const summary = await admin('/api/admin/exam-applications').query({ courseId, studentClass: className, view: 'summary' }).expect(200);
    assert.equal(summary.body.applications.length, 2);
    summary.body.applications.forEach(application => {
        assert.equal('versionSnapshots' in application, false);
        assert.equal('questionReports' in application, false);
    });
    const current = summary.body.applications.find(application => application.id === 'app-2');
    assert.equal(current.openReportCount, 2);
    assert.equal(current.status, 'running');
    assert.equal(summary.body.applications.find(application => application.id === 'app-1').openReportCount, 0);
    // A memória não é alterada pela versão resumida.
    assert.equal(db.memory.examApplications[1].questionReports.length, 3);

    const full = await admin('/api/admin/exam-applications').query({ courseId, studentClass: className }).expect(200);
    const fullCurrent = full.body.applications.find(application => application.id === 'app-2');
    assert.equal(fullCurrent.versionSnapshots.length, 1);
    assert.equal(fullCurrent.questionReports.length, 3);
    assert.equal('openReportCount' in fullCurrent, false);
});

test('[UC-DESEMPENHO-004] question-reports não devolve config (versões e gabarito)', async () => {
    const response = await admin(`/api/admin/question-reports/${encodeURIComponent(className)}/${examKey}`).query({ applicationId: 'app-2' }).expect(200);
    assert.equal('config' in response.body, false);
    assert.equal(response.body.totalOpen, 2);
    assert.equal(response.body.groups.length, 1);
    assert.equal(response.body.groups[0].questionNumber, 1);
    assert.equal(response.body.groups[0].count, 2);
});
