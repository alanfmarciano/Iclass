// Regressões do grupo G5 (fase 1): lançamento manual de nota validado, auditoria
// das alterações de nota, exportação de notas e boletim igual à tela Resultados.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-grades-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { errorHandler } = require('../../backend/middlewares.js');
const { regradeSubmission } = require('../../backend/utils/examGrading.js');

let app;
// Funções de nota da interface (web/src/lib/grades.js), para comparar com o que a tela mostra.
let webGrades;
const adminToken = 'admin-token-grades';
const professorToken = 'professor-token-grades';
const COURSE_A = 'curso-a';
const COURSE_B = 'curso-b';

function question(number, correct) {
    return {
        originalNumber: number,
        text: `Questão ${number}`,
        correctAnswer: correct,
        alternatives: ['A', 'B', 'C', 'D'].map(letter => ({ letter, text: `Alternativa ${letter}` })),
    };
}

function submission(id, { email = 'ana@notas.local', name = 'Ana', examKey = 'Avaliacao_P1', score, applicationId = null, published = true, courseId = COURSE_A, studentClass = '1DES', timestamp = '2026-03-01T12:00:00.000Z', extra = {} } = {}) {
    return {
        id,
        student: { name, email, courseId, studentClass },
        examKey,
        applicationId,
        score,
        correctCount: null,
        totalCount: null,
        gradedAnswers: [],
        type: applicationId ? 'online' : 'impressa',
        attemptNumber: 1,
        resultStatus: 'considered',
        aggregationPolicy: 'highest',
        selectedForResult: false,
        gradePublished: published,
        timestamp,
        ...extra,
    };
}

function seed() {
    db.memory.admins = [
        { email: 'admin@notas.local', name: 'Admin', role: 'admin', password: db.hashPassword('x') },
        { email: 'prof@notas.local', name: 'Professor', role: 'professor', password: db.hashPassword('x'), assignedClasses: [{ courseId: COURSE_A, className: '1DES' }] },
    ];
    db.memory.adminSessions = {
        [adminToken]: { email: 'admin@notas.local', createdAt: Date.now(), lastSeen: Date.now() },
        [professorToken]: { email: 'prof@notas.local', createdAt: Date.now(), lastSeen: Date.now() },
    };
    db.memory.courses = [
        { id: COURSE_A, name: 'Desenvolvimento', structure: [
            { id: 'm1', name: 'FUTEC — Fundamentos', units: [
                { key: 'u1', name: 'Prova 1', avaliacaoKey: 'Avaliacao_P1' },
                { key: 'u2', name: 'Prova 2', avaliacaoKey: 'Avaliacao_P2' },
            ] },
            { id: 'm2', name: 'LOGPROG — Lógica', units: [
                { key: 'u3', name: 'Prova 3', avaliacaoKey: 'Avaliacao_P3' },
            ] },
        ] },
        { id: COURSE_B, name: 'Redes', structure: [
            { id: 'r1', name: 'REDES — Redes', units: [{ key: 'r1u1', name: 'Prova 1', avaliacaoKey: 'Avaliacao_P1' }] },
        ] },
    ];
    db.memory.classes = [
        { name: '1DES', courseId: COURSE_A, period: 'Manhã' },
        { name: '2RED', courseId: COURSE_B, period: 'Noite' },
        { name: '1DES', courseId: COURSE_B, period: 'Tarde' },
    ];
    db.memory.evaluations = {
        Avaliacao_P1: { title: 'Prova 1 — Fundamentos', questions: [question(1, 'B'), question(2, 'A'), question(3, 'C'), question(4, 'D')] },
        Avaliacao_P2: { title: 'Prova 2', questions: Array.from({ length: 10 }, (_, index) => question(index + 1, 'A')) },
        Avaliacao_P3: { title: 'Prova 3', questions: Array.from({ length: 5 }, (_, index) => question(index + 1, 'B')) },
        Avaliacao_FORA: { title: 'Prova de outro curso', questions: [question(1, 'A')] },
    };
    db.memory.students = [
        { name: 'Ana', email: 'ana@notas.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: COURSE_A }] },
        { name: 'Bia', email: 'bia@notas.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: COURSE_A }, { name: '2RED', courseId: COURSE_B }] },
        { name: '=HYPERLINK("http://x")', email: 'hack@notas.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: COURSE_A }] },
        { name: 'Caio', email: 'caio@notas.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: COURSE_B }] },
    ];
    db.memory.examApplications = [
        { id: 'app_1', examKey: 'Avaliacao_P1', studentClass: '1DES', courseId: COURSE_A, status: 'finished', createdAt: '2026-03-01T10:00:00.000Z', startedAt: '2026-03-01T10:05:00.000Z' },
        { id: 'app_2', examKey: 'Avaliacao_P1', studentClass: '1DES', courseId: COURSE_A, status: 'finished', createdAt: '2026-03-15T10:00:00.000Z', startedAt: '2026-03-15T10:05:00.000Z' },
    ];
    db.memory.sessions = {};
    db.memory.submissions = [];
    db.memory.studentExamState = {};
    db.memory.attendance = [];
    db.memory.progress = {};
    db.memory.auditLogs = [];
}

const admin = (req) => req.set('x-admin-session', adminToken);
const professor = (req) => req.set('x-admin-session', professorToken);
const createGrade = (body) => admin(request(app).post('/api/admin/submissions/create')).send({ studentEmail: 'ana@notas.local', courseId: COURSE_A, studentClass: '1DES', type: 'impressa', ...body });

// Média da tela Resultados (0 a 100, sem arredondar): consolida por grupo
// (aluno+curso+turma+aplicação) e tira a média dos grupos. A tela mostra
// fmtGrade(média) — compare com resultadosAverageText.
function resultadosAverage(rows, email) {
    const groups = new Map();
    rows.filter(row => row.student.email === email).forEach(row => {
        const key = `${row.student.courseId}::${row.student.studentClass}::${row.applicationId || `legacy-exam:${row.examKey}`}`;
        if (row.consolidatedScore != null) groups.set(key, row.consolidatedScore);
    });
    const scores = [...groups.values()];
    return scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null;
}

// Texto que a tela Resultados mostra para a média do aluno (lógica real da tela).
function resultadosAverageText(rows, email) {
    return webGrades.fmtGrade(resultadosAverage(rows, email), '-');
}

function parseCsv(text) {
    assert.equal(text.charCodeAt(0), 0xFEFF, 'CSV começa com BOM UTF-8 para o Excel');
    return text.slice(1).trim().split(/\r\n/).map(line => line.split(';'));
}

test.before(async () => {
    await db.init();
    app = createApp();
    webGrades = await import(pathToFileURL(path.join(__dirname, '..', '..', 'web', 'src', 'lib', 'grades.js')).href);
});
test.beforeEach(() => { seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-NOTAS-001] só acertos e total calcula a nota pelos acertos (antes gravava 0)', async () => {
    const res = await createGrade({ examKey: 'Avaliacao_P2', correctCount: 7, totalCount: 10 });
    assert.equal(res.status, 200, res.body.error);
    assert.equal(res.body.score, 70);
    assert.equal(res.body.grade, 7);
    const stored = db.memory.submissions.find(item => item.id === res.body.submissionId);
    assert.equal(stored.score, 70);
    assert.equal(stored.correctCount, 7);
    assert.equal(stored.totalCount, 10);
    assert.equal(stored.student.courseId, COURSE_A);
    assert.equal(stored.student.studentClass, '1DES');

    const onlyCount = await createGrade({ examKey: 'Avaliacao_P1', correctCount: '3' });
    assert.equal(onlyCount.status, 200, onlyCount.body.error);
    assert.equal(onlyCount.body.score, 75, 'sem total, usa o total de questões da prova (4)');
});

test('[UC-NOTAS-001] nota de 0 a 10 aceita vírgula e não inventa acertos', async () => {
    const comma = await createGrade({ examKey: 'Avaliacao_P1', grade: '8,5' });
    assert.equal(comma.status, 200, comma.body.error);
    assert.equal(comma.body.score, 85);
    assert.equal(comma.body.correctCount, null);
    assert.equal(comma.body.totalCount, null);
    const dot = await createGrade({ examKey: 'Avaliacao_P1', grade: 9.5 });
    assert.equal(dot.body.score, 95);
    const zero = await createGrade({ examKey: 'Avaliacao_P1', grade: '0' });
    assert.equal(zero.status, 200);
    assert.equal(zero.body.score, 0);
    const ten = await createGrade({ examKey: 'Avaliacao_P1', grade: 10, correctCount: 4, totalCount: 4 });
    assert.equal(ten.body.score, 100);
});

test('[UC-NOTAS-001] recusa notas e acertos impossíveis com 400 em português, sem gravar nada', async () => {
    const cases = [
        [{ examKey: 'Avaliacao_P1', grade: 150 }, /0 a 10/],
        [{ examKey: 'Avaliacao_P1', grade: 15 }, /0 a 10/],
        [{ examKey: 'Avaliacao_P1', grade: -2 }, /0 a 10/],
        [{ examKey: 'Avaliacao_P1', grade: 'abc' }, /0 a 10/],
        [{ examKey: 'Avaliacao_P1', grade: 'dez' }, /0 a 10/],
        [{ examKey: 'Avaliacao_P1', grade: null }, /Informe a nota/],
        [{ examKey: 'Avaliacao_P1' }, /Informe a nota/],
        [{ examKey: 'Avaliacao_P1', score: 150 }, /0 a 10/],
        [{ examKey: 'Avaliacao_P1', score: 85 }, /0 a 10/],
        [{ examKey: 'Avaliacao_P1', correctCount: 3, totalCount: 2 }, /não podem passar do total/],
        [{ examKey: 'Avaliacao_P1', correctCount: 5 }, /não podem passar do total/],
        [{ examKey: 'Avaliacao_P1', correctCount: -1, totalCount: 4 }, /Acertos/],
        [{ examKey: 'Avaliacao_P1', correctCount: 2.5, totalCount: 4 }, /Acertos/],
        [{ examKey: 'Avaliacao_P1', correctCount: 2, totalCount: 0 }, /maior que zero/],
        [{ examKey: 'Avaliacao_P1', correctCount: 2, totalCount: 10 }, /4 questões/],
        [{ examKey: 'Avaliacao_P1', grade: 7, type: 'qualquer' }, /Tipo de lançamento/],
        [{ examKey: 'Avaliacao_P1', grade: 7, studentEmail: 123 }, /aluno/],
        [{ examKey: 42, grade: 7 }, /prova/],
        [{ examKey: 'Avaliacao_FORA', grade: 7 }, /não faz parte do curso/],
        [{ examKey: 'Avaliacao_P1', grade: 7, studentClass: '3XX' }, /não está matriculado/],
    ];
    for (const [body, message] of cases) {
        const res = await createGrade(body);
        assert.equal(res.status, 400, `${JSON.stringify(body)} deveria dar 400 (deu ${res.status})`);
        assert.match(res.body.error, message, JSON.stringify(body));
    }
    assert.equal(db.memory.submissions.length, 0, 'nenhuma entrada inválida foi gravada');
});

test('[UC-NOTAS-001] cartão-resposta corrige pelo gabarito e valida questões e letras', async () => {
    const ok = await createGrade({ examKey: 'Avaliacao_P1', mode: 'card', answers: { 1: 'B', 2: 'a', 3: 'D' }, questionNumbers: [1, 2, 3, 4] });
    assert.equal(ok.status, 200, ok.body.error);
    assert.equal(ok.body.correctCount, 2);
    assert.equal(ok.body.totalCount, 4);
    assert.equal(ok.body.score, 50);
    const badLetter = await createGrade({ examKey: 'Avaliacao_P1', answers: { 1: 'BB' } });
    assert.equal(badLetter.status, 400);
    const badQuestion = await createGrade({ examKey: 'Avaliacao_P1', answers: { 9: 'A' } });
    assert.equal(badQuestion.status, 400);
    assert.match(badQuestion.body.error, /questão 9/);
    const outsideVersion = await createGrade({ examKey: 'Avaliacao_P1', answers: { 4: 'D' }, questionNumbers: [1, 2] });
    assert.equal(outsideVersion.status, 400);
    const emptyCard = await createGrade({ examKey: 'Avaliacao_P1', mode: 'card', answers: {} });
    assert.equal(emptyCard.status, 400);
});

test('[UC-NOTAS-001] aluno em dois cursos: a nota vai para a turma do workspace', async () => {
    const res = await admin(request(app).post('/api/admin/submissions/create')).send({ studentEmail: 'bia@notas.local', examKey: 'Avaliacao_P1', grade: 6, courseId: COURSE_B, studentClass: '2RED' });
    assert.equal(res.status, 200, res.body.error);
    const stored = db.memory.submissions.find(item => item.id === res.body.submissionId);
    assert.equal(stored.student.courseId, COURSE_B);
    assert.equal(stored.student.studentClass, '2RED');
});

test('[UC-NOTAS-001] lançar, publicar, mudar a regra e excluir ficam na auditoria do aluno', async () => {
    const created = await createGrade({ examKey: 'Avaliacao_P2', correctCount: 7, totalCount: 10 });
    const id = created.body.submissionId;
    const second = await createGrade({ examKey: 'Avaliacao_P2', grade: '9' });

    const publish = await admin(request(app).post('/api/admin/submissions/publish')).send({ ids: [id], published: true });
    assert.equal(publish.status, 200);
    const policy = await admin(request(app).post('/api/admin/submissions/result-control')).send({ submissionId: id, action: 'policy', policy: 'average' });
    assert.equal(policy.status, 200);
    const removed = await admin(request(app).post('/api/admin/submissions/delete')).send({ id: second.body.submissionId });
    assert.equal(removed.status, 200);

    const audit = await admin(request(app).get('/api/admin/student/audit?email=ana@notas.local'));
    assert.equal(audit.status, 200);
    const actions = audit.body.map(entry => entry.action).sort();
    assert.deepEqual(actions, ['grade_create', 'grade_create', 'grade_delete', 'grade_publish', 'grade_result_policy']);
    const createEntry = audit.body.find(entry => entry.action === 'grade_create' && entry.submissionId === id);
    assert.match(createEntry.newValue, /Prova 2: 7,0 \(7\/10 acertos\)/);
    assert.equal(createEntry.actor, 'admin@notas.local');
    const deleteEntry = db.memory.auditLogs.find(entry => entry.action === 'grade_delete');
    assert.equal(deleteEntry.details.deletedSubmission.id, second.body.submissionId, 'cópia do registro excluído fica guardada');
    assert.equal(deleteEntry.details.deletedSubmission.score, 90);
    const policyEntry = audit.body.find(entry => entry.action === 'grade_result_policy');
    assert.match(policyEntry.oldValue, /Melhor nota/);
    assert.match(policyEntry.newValue, /Média das consideradas/);

    const review = await admin(request(app).get(`/api/admin/submissions/${id}/review`));
    assert.equal(review.status, 200);
    assert.deepEqual(review.body.history.map(entry => entry.field).sort(), ['Composição da nota', 'Nota', 'Publicação da nota']);
});

test('[UC-NOTAS-001] recorreção por anulação guarda a nota anterior', () => {
    const sub = { score: 50, correctCount: 2, totalCount: 4, assignedVersion: 'A', gradedAnswers: [
        { questionNumber: 1, studentChoice: 'B' }, { questionNumber: 2, studentChoice: 'A' }, { questionNumber: 3, studentChoice: 'A' }, { questionNumber: 4, studentChoice: 'A' },
    ] };
    const application = { annulledQuestions: [{ questionNumber: 3, mode: 'ponto_para_todos' }] };
    regradeSubmission({ submission: sub, application, evaluation: db.memory.evaluations.Avaliacao_P1, reason: 'anulação da questão 3', by: 'admin@notas.local' });
    assert.equal(sub.score, 75);
    assert.equal(sub.scoreHistory.length, 1);
    assert.equal(sub.scoreHistory[0].from, 50);
    assert.equal(sub.scoreHistory[0].to, 75);
    assert.equal(sub.scoreHistory[0].reason, 'anulação da questão 3');
    regradeSubmission({ submission: sub, application, evaluation: db.memory.evaluations.Avaliacao_P1 });
    assert.equal(sub.scoreHistory.length, 1, 'sem mudança de nota, não cria histórico');
});

test('[UC-NOTAS-001] nota inválida antiga (150 ou vazia) não entra em média, não é publicada e não chega ao aluno', async () => {
    db.memory.submissions = [
        submission('legado_150', { score: 150, published: true }),
        submission('legado_null', { examKey: 'Avaliacao_P2', score: null, published: false }),
        submission('ok_70', { examKey: 'Avaliacao_P3', score: 70, published: true }),
    ];
    const list = await admin(request(app).get(`/api/admin/submissions?courseId=${COURSE_A}&studentClass=1DES`));
    const invalid = list.body.find(item => item.id === 'legado_150');
    assert.equal(invalid.scoreInvalid, true);
    assert.equal(invalid.consolidatedScore, null, 'antes a consolidação devolvia 150 (15,0)');
    assert.equal(list.body.find(item => item.id === 'legado_null').consolidatedScore, null, 'nota vazia não vira 0');

    const report = await admin(request(app).get(`/api/admin/student/report?email=ana@notas.local&courseId=${COURSE_A}&studentClass=1DES`));
    assert.equal(report.status, 200);
    assert.equal(report.body.overallAverage, 7);
    const grades = report.body.modules.flatMap(module => module.exams.map(exam => exam.grade)).filter(grade => grade != null);
    assert.deepEqual(grades, [7]);

    const publish = await admin(request(app).post('/api/admin/submissions/publish')).send({ ids: ['legado_null'], published: true });
    assert.equal(publish.body.skippedInvalid, 1);
    assert.equal(db.memory.submissions.find(item => item.id === 'legado_null').gradePublished, false);

    const login = await request(app).post('/api/student/login').send({ email: 'ana@notas.local', password: '123' });
    assert.equal(login.status, 200, login.body.error);
    const mine = await request(app).post('/api/student/my-submissions').set('x-session-token', login.body.sessionToken).send({ courseId: COURSE_A, studentClass: '1DES' });
    assert.equal(mine.status, 200, mine.body.error);
    const seen = (mine.body.submissions || mine.body).find(item => item.id === 'legado_150');
    assert.equal(seen.score, undefined, 'o aluno não vê 15,0');
    assert.equal(seen.gradePublished, false);
});

test('[UC-NOTAS-003] boletim usa a mesma consolidação de Resultados com duas aplicações da mesma prova', async () => {
    db.memory.submissions = [
        submission('p1_app1', { applicationId: 'app_1', score: 40, timestamp: '2026-03-01T11:00:00.000Z' }),
        submission('p1_app2', { applicationId: 'app_2', score: 90, timestamp: '2026-03-15T11:00:00.000Z' }),
        submission('p2_a', { examKey: 'Avaliacao_P2', score: 60, timestamp: '2026-03-20T11:00:00.000Z' }),
        submission('p2_b', { examKey: 'Avaliacao_P2', score: 80, timestamp: '2026-03-21T11:00:00.000Z' }),
        submission('p3_pend', { examKey: 'Avaliacao_P3', score: 100, published: false }),
    ];
    const report = await admin(request(app).get(`/api/admin/student/report?email=ana@notas.local&courseId=${COURSE_A}&studentClass=1DES`));
    assert.equal(report.status, 200, report.body.error);
    const futec = report.body.modules.find(module => module.id === 'm1');
    const p1Rows = futec.exams.filter(exam => exam.examKey === 'Avaliacao_P1');
    assert.equal(p1Rows.length, 2, 'uma linha por aplicação');
    assert.deepEqual(p1Rows.map(exam => exam.grade), [4, 9]);
    assert.match(p1Rows[0].title, /\(1ª aplicação, 01\/03\/2026\)/);
    assert.match(p1Rows[1].title, /\(2ª aplicação, 15\/03\/2026\)/);
    assert.equal(futec.exams.find(exam => exam.examKey === 'Avaliacao_P2').grade, 8, 'regra "melhor nota" dentro da prova');
    assert.equal(futec.average, 7);
    const p3 = report.body.modules.find(module => module.id === 'm2').exams[0];
    assert.equal(p3.grade, null, 'nota não publicada não entra no boletim');
    assert.equal(p3.pendingAttempts, 1);

    // Mesmo resultado da tela Resultados (todas publicadas, exceto P3, que fica fora).
    db.memory.submissions = db.memory.submissions.filter(item => item.id !== 'p3_pend');
    const list = await admin(request(app).get(`/api/admin/submissions?courseId=${COURSE_A}&studentClass=1DES`));
    const again = await admin(request(app).get(`/api/admin/student/report?email=ana@notas.local&courseId=${COURSE_A}&studentClass=1DES`));
    assert.equal(webGrades.fmtGradeValue(again.body.overallAverage), resultadosAverageText(list.body, 'ana@notas.local'));
    assert.equal(again.body.overallAverage, 7);
});

test('[UC-NOTAS-003] boletim respeita o curso ativo de aluno com duas matrículas', async () => {
    db.memory.submissions = [
        submission('bia_a', { email: 'bia@notas.local', name: 'Bia', score: 50 }),
        submission('bia_b', { email: 'bia@notas.local', name: 'Bia', score: 100, courseId: COURSE_B, studentClass: '2RED' }),
    ];
    const inB = await admin(request(app).get(`/api/admin/student/report?email=bia@notas.local&courseId=${COURSE_B}&studentClass=2RED`));
    assert.equal(inB.status, 200);
    assert.equal(inB.body.course.id, COURSE_B);
    assert.equal(inB.body.className, '2RED');
    assert.equal(inB.body.overallAverage, 10);
    const inA = await admin(request(app).get(`/api/admin/student/report?email=bia@notas.local&courseId=${COURSE_A}`));
    assert.equal(inA.body.course.id, COURSE_A);
    assert.equal(inA.body.overallAverage, 5);
    const notEnrolled = await admin(request(app).get('/api/admin/student/report?email=ana@notas.local&courseId=curso-inexistente'));
    assert.equal(notEnrolled.status, 400);
});

test('[UC-NOTAS-002] planilha da turma: uma linha por aluno, coluna por prova, média igual a Resultados, CSV pt-BR', async () => {
    db.memory.submissions = [
        submission('p1_app1', { applicationId: 'app_1', score: 40 }),
        submission('p1_app2', { applicationId: 'app_2', score: 90, timestamp: '2026-03-15T11:00:00.000Z' }),
        submission('p2', { examKey: 'Avaliacao_P2', score: 85, published: false }),
        submission('bia_p2', { email: 'bia@notas.local', name: 'Bia', examKey: 'Avaliacao_P2', score: 66 }),
        submission('outra_turma', { email: 'caio@notas.local', name: 'Caio', score: 100, courseId: COURSE_B }),
    ];
    const json = await admin(request(app).get(`/api/admin/gradebook?courseId=${COURSE_A}&studentClass=1DES`));
    assert.equal(json.status, 200, json.body.error);
    const labels = json.body.columns.map(column => column.label);
    assert.deepEqual(labels, [
        'Prova 1 — Fundamentos (1ª aplicação, 01/03/2026)',
        'Prova 1 — Fundamentos (2ª aplicação, 15/03/2026)',
        'Prova 2',
        'Prova 3',
    ]);
    assert.deepEqual(json.body.rows.map(row => row.email).sort(), ['ana@notas.local', 'bia@notas.local', 'hack@notas.local'], 'Caio é de 1DES de outro curso');
    const ana = json.body.rows.find(row => row.email === 'ana@notas.local');
    const list = await admin(request(app).get(`/api/admin/submissions?courseId=${COURSE_A}&studentClass=1DES`));
    assert.equal(webGrades.fmtGradeValue(ana.average), resultadosAverageText(list.body, 'ana@notas.local'));
    assert.equal(ana.average, 7.2);
    assert.equal(ana.pendingCount, 1);

    const csv = await admin(request(app).get(`/api/admin/gradebook?courseId=${COURSE_A}&studentClass=1DES&format=csv`));
    assert.equal(csv.status, 200);
    assert.match(csv.headers['content-type'], /text\/csv/);
    assert.match(csv.headers['content-disposition'], /planilha_notas_.*1DES/);
    const lines = parseCsv(csv.text);
    assert.deepEqual(lines[0].slice(0, 3), ['Aluno', 'E-mail', 'Matrícula']);
    assert.deepEqual(lines[0].slice(-2), ['Média', 'Notas não publicadas']);
    const anaLine = lines.find(line => line[1] === 'ana@notas.local');
    assert.deepEqual(anaLine.slice(3), ['4,0', '9,0', '8,5', '', '7,2', '1']);
    const hackLine = lines.find(line => line[1] === 'hack@notas.local');
    assert.ok(hackLine[0].startsWith('"\'=HYPERLINK') || hackLine[0].startsWith("'=HYPERLINK"), `fórmula neutralizada: ${hackLine[0]}`);

    const forbidden = await professor(request(app).get(`/api/admin/gradebook?courseId=${COURSE_B}&studentClass=2RED`));
    assert.equal(forbidden.status, 403);
    const own = await professor(request(app).get(`/api/admin/gradebook?courseId=${COURSE_A}&studentClass=1DES`));
    assert.equal(own.status, 200);

    // Duas aplicações no mesmo dia: colunas com rótulos diferentes (numeradas).
    db.memory.examApplications[1].createdAt = '2026-03-01T14:00:00.000Z';
    db.memory.examApplications[1].startedAt = '2026-03-01T14:05:00.000Z';
    const sameDay = await admin(request(app).get(`/api/admin/gradebook?courseId=${COURSE_A}&studentClass=1DES`));
    const p1Labels = sameDay.body.columns.filter(column => column.examKey === 'Avaliacao_P1').map(column => column.label);
    assert.deepEqual(p1Labels, ['Prova 1 — Fundamentos (1ª aplicação, 01/03/2026)', 'Prova 1 — Fundamentos (2ª aplicação, 01/03/2026)']);
});

test('[UC-NOTAS-002] CSV da prova: nota 0 a 10 com vírgula, acertos separados e só do curso pedido', async () => {
    db.memory.submissions = [
        submission('a1', { applicationId: 'app_1', score: 60, extra: { correctCount: 2, totalCount: 4, assignedVersion: 'B' } }),
        submission('caio', { email: 'caio@notas.local', name: 'Caio', score: 100, courseId: COURSE_B }),
    ];
    const res = await admin(request(app).get(`/api/admin/export-grades/1DES/Avaliacao_P1?courseId=${COURSE_A}`));
    assert.equal(res.status, 200);
    const lines = parseCsv(res.text);
    assert.deepEqual(lines[0], ['Aluno', 'E-mail', 'Turma', 'Avaliação', 'Aplicação', 'Tentativa', 'Versão', 'Acertos', 'Questões', 'Nota da tentativa', 'Compõe a nota', 'Nota da aplicação', 'Publicada', 'Data de envio']);
    assert.equal(lines.length, 2, 'Caio (1DES de outro curso) fica fora');
    const row = lines[1];
    assert.equal(row[3], 'Prova 1 — Fundamentos');
    assert.equal(row[4], '1ª aplicação, 01/03/2026');
    assert.equal(row[7], '2');
    assert.equal(row[8], '4');
    assert.equal(row[9], '6,0');
    assert.equal(row[11], '6,0');
    assert.equal(row[12], 'Sim');

    const noSession = await request(app).get(`/api/admin/export-grades/1DES/Avaliacao_P1?courseId=${COURSE_A}`);
    assert.equal(noSession.status, 401, 'continua exigindo sessão (a tela agora baixa com fetch autenticado)');
});

test('[UC-NOTAS-001] presença manual valida data, aluno e turma (CONF-14)', async () => {
    const mark = (body) => admin(request(app).post('/api/admin/student/attendance/mark')).send(body);
    for (const date of ['31/02/2026', '2026-02-31', '2026-13-01', 'ontem']) {
        const res = await mark({ email: 'ana@notas.local', date, studentClass: '1DES', courseId: COURSE_A });
        assert.equal(res.status, 400, date);
        assert.match(res.body.error, /Data inválida/);
    }
    assert.equal((await mark({ email: 123 })).status, 400);
    assert.equal((await mark({ email: 'ninguem@notas.local', date: '2026-03-02' })).status, 404);
    assert.equal((await mark({ email: 'ana@notas.local', date: '2026-03-02', studentClass: '2RED' })).status, 400);
    assert.equal(db.memory.attendance.length, 0);
    const ok = await mark({ email: 'ana@notas.local', date: '2026-03-02', studentClass: '1DES' });
    assert.equal(ok.status, 200);
    assert.equal(db.memory.attendance[0].courseId, COURSE_A, 'curso vem da matrícula quando não é enviado');
});

test('[UC-NOTAS-001] entradas com tipo errado dão 400, não 500 com mensagem interna (CONF-14)', async () => {
    const del = await admin(request(app).post('/api/admin/delete-student')).send({ email: 123 });
    assert.equal(del.status, 400);
    const delSub = await admin(request(app).post('/api/admin/submissions/delete')).send({ studentEmail: 123, examKey: 'Avaliacao_P1' });
    assert.equal(delSub.status, 400);
    const publish = await admin(request(app).post('/api/admin/submissions/publish')).send({ ids: 'abc' });
    assert.equal(publish.status, 400);

    const login = await request(app).post('/api/student/login').send({ email: 'ana@notas.local', password: '123' });
    const progress = (completedUnits) => request(app).post('/api/student/progress').set('x-session-token', login.body.sessionToken).send({ completedUnits });
    assert.equal((await progress('tudo')).status, 400);
    assert.equal((await progress(['u1'])).status, 400);
    assert.equal((await progress({ u1: { x: 1 } })).status, 400);
    assert.equal((await progress({ u1: true })).status, 200);

    const malformed = await admin(request(app).post('/api/admin/submissions/create')).set('Content-Type', 'application/json').send('{"studentEmail": ');
    assert.equal(malformed.status, 400);
    assert.match(malformed.body.error, /formato inválido/);

    let sent = null;
    const res = { status(code) { this.code = code; return this; }, json(body) { sent = body; return this; } };
    const originalError = console.error;
    console.error = () => {};
    try { errorHandler(new TypeError('email.trim is not a function'), {}, res, () => {}); } finally { console.error = originalError; }
    assert.equal(res.code, 500);
    assert.equal(sent.error, 'Ocorreu um erro interno no servidor.');
});

// ---------------------------------------------------------------------------
// Rodada de ajuste 1 (revisão): total da turma na prévia, nota × acertos,
// cartão com questão que saiu do banco, escopo de registros antigos,
// arredondamento único, lixeira de notas e registro da aplicação.

test('[UC-NOTAS-001] total padrão do lançamento é o da turma (quantidade configurada, sem excluídas), igual na tela e no servidor', async () => {
    db.memory.classes[0].examConfigs = { Avaliacao_P1: { questionCount: 2 }, Avaliacao_P3: { excludedQuestions: [1, 2] } };
    const context = await admin(request(app).get(`/api/admin/submissions/manual-context?courseId=${COURSE_A}&studentClass=1DES&examKey=Avaliacao_P1`));
    assert.equal(context.status, 200, context.body.error);
    assert.equal(context.body.questionCount, 4);
    assert.equal(context.body.defaultTotal, 2, 'a turma usa 2 das 4 questões');
    const excluded = await admin(request(app).get(`/api/admin/submissions/manual-context?courseId=${COURSE_A}&studentClass=1DES&examKey=Avaliacao_P3`));
    assert.equal(excluded.body.defaultTotal, 3, '5 questões menos 2 excluídas');

    // A prévia da tela (lógica real) mostra o que o servidor grava.
    const limits = { maxQuestions: context.body.questionCount, defaultTotal: context.body.defaultTotal };
    const quick = webGrades.validateQuickGrade({ grade: '', correctCount: '2', totalCount: '' }, limits);
    assert.deepEqual(quick.errors, {});
    const preview = webGrades.previewQuickGrade(quick.payload, limits.defaultTotal);
    const saved = await createGrade({ examKey: 'Avaliacao_P1', ...quick.payload });
    assert.equal(saved.status, 200, saved.body.error);
    assert.equal(saved.body.score, 100, '2 de 2 acertos');
    assert.equal(webGrades.fmtGradeValue(preview), webGrades.fmtGrade(saved.body.score), 'antes a tela dizia 5,0 e o servidor gravava 10,0');

    // Acertos acima do total da turma: a tela barra antes de enviar e o servidor também.
    assert.match(webGrades.validateQuickGrade({ grade: '', correctCount: '3', totalCount: '' }, limits).errors.correctCount, /Nesta turma a prova tem 2 questões/);
    const over = await createGrade({ examKey: 'Avaliacao_P1', correctCount: 3 });
    assert.equal(over.status, 400);

    assert.equal((await professor(request(app).get(`/api/admin/submissions/manual-context?courseId=${COURSE_B}&studentClass=2RED&examKey=Avaliacao_P1`))).status, 403);
    assert.equal((await admin(request(app).get(`/api/admin/submissions/manual-context?courseId=${COURSE_A}&studentClass=1DES&examKey=Avaliacao_NAO_EXISTE`))).status, 404);
});

test('[UC-NOTAS-001] nota digitada que não confere com os acertos é recusada (na tela e no servidor)', async () => {
    const wrong = await createGrade({ examKey: 'Avaliacao_P1', grade: 10, correctCount: 0, totalCount: 4 });
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.error, /não confere com 0 de 4 acertos/);
    assert.match(webGrades.validateQuickGrade({ grade: '10', correctCount: '0', totalCount: '4' }).errors.grade, /Não confere/);
    const ok = await createGrade({ examKey: 'Avaliacao_P1', grade: '7,5', correctCount: 3 });
    assert.equal(ok.status, 200, ok.body.error);
    const rounded = await createGrade({ examKey: 'Avaliacao_P3', grade: '6,7', correctCount: 2, totalCount: 3 });
    assert.equal(rounded.status, 200, 'diferença só de arredondamento (6,67) é aceita');
    assert.deepEqual(webGrades.validateQuickGrade({ grade: '6,7', correctCount: '2', totalCount: '3' }).errors, {});
    assert.equal(db.memory.submissions.length, 2);
});

test('[UC-NOTAS-001] cartão-resposta de versão impressa com questão que saiu do banco: corrige as existentes e avisa', async () => {
    const res = await createGrade({ examKey: 'Avaliacao_P1', mode: 'card', answers: { 1: 'B', 2: 'A', 5: 'C' }, questionNumbers: [1, 2, 3, 4, 5] });
    assert.equal(res.status, 200, res.body.error);
    assert.equal(res.body.totalCount, 4, 'a questão 5 não tem gabarito e fica fora do total');
    assert.equal(res.body.correctCount, 2);
    assert.deepEqual(res.body.ignoredQuestionNumbers, [5]);
    assert.match(res.body.message, /Atenção: a questão 5 da versão impressa não existe mais/);
    const stored = db.memory.submissions.find(item => item.id === res.body.submissionId);
    assert.deepEqual(stored.ignoredQuestionNumbers, [5]);
    const audit = db.memory.auditLogs.find(entry => entry.action === 'grade_create');
    assert.match(audit.newValue, /questão 5 da versão impressa/);

    const onlyMissing = await createGrade({ examKey: 'Avaliacao_P1', mode: 'card', answers: { 5: 'C' }, questionNumbers: [1, 5] });
    assert.equal(onlyMissing.status, 400);
    assert.match(onlyMissing.body.error, /questão que ainda existe/);
});

test('[UC-NOTAS-003] registro antigo sem curso fica só no curso da matrícula do aluno (não vaza para turma homônima)', async () => {
    const legacy = (id, email, name, score) => ({ ...submission(id, { email, name, score }), student: { name, email, studentClass: '1DES' } });
    db.memory.submissions = [
        legacy('caio_antigo', 'caio@notas.local', 'Caio', 30),
        legacy('ana_antiga', 'ana@notas.local', 'Ana', 80),
        legacy('ex_aluno', 'saiu@notas.local', 'Ex-aluno', 50),
    ];
    const listA = await admin(request(app).get(`/api/admin/submissions?courseId=${COURSE_A}&studentClass=1DES`));
    assert.deepEqual(listA.body.map(item => item.id).sort(), ['ana_antiga', 'ex_aluno'], 'Caio é da 1DES do curso B');
    assert.equal(listA.body.find(item => item.id === 'ana_antiga').student.courseId, COURSE_A);
    const listB = await admin(request(app).get(`/api/admin/submissions?courseId=${COURSE_B}&studentClass=1DES`));
    assert.deepEqual(listB.body.map(item => item.id), ['caio_antigo']);
    assert.equal(listB.body[0].student.courseId, COURSE_B);

    const bookA = await admin(request(app).get(`/api/admin/gradebook?courseId=${COURSE_A}&studentClass=1DES`));
    assert.equal(bookA.body.rows.some(row => row.email === 'caio@notas.local'), false, 'antes Caio ganhava linha no curso A');
    const bookB = await admin(request(app).get(`/api/admin/gradebook?courseId=${COURSE_B}&studentClass=1DES`));
    assert.equal(bookB.body.rows.find(row => row.email === 'caio@notas.local').average, 3);

    const csvA = await admin(request(app).get(`/api/admin/export-grades/1DES/Avaliacao_P1?courseId=${COURSE_A}`));
    assert.equal(csvA.text.includes('caio@notas.local'), false);
    const report = await admin(request(app).get(`/api/admin/student/report?email=caio@notas.local&courseId=${COURSE_B}&studentClass=1DES`));
    assert.equal(report.status, 200, report.body.error);
    assert.equal(report.body.overallAverage, 3);
});

test('[UC-NOTAS-003] a mesma média aparece igual no boletim, no quadro, na planilha, no portal do aluno e em Resultados', async () => {
    // 6,0 e 8,7 publicadas: média 73,5 -> 7,4 em todo lugar (antes 7,4 no boletim e 7,3 no resto).
    db.memory.submissions = [
        submission('rui_p1', { score: 60 }),
        submission('rui_p2', { examKey: 'Avaliacao_P2', score: 87 }),
    ];
    const report = await admin(request(app).get(`/api/admin/student/report?email=ana@notas.local&courseId=${COURSE_A}&studentClass=1DES`));
    assert.equal(report.body.overallAverage, 7.4);
    const list = await admin(request(app).get(`/api/admin/submissions?courseId=${COURSE_A}&studentClass=1DES`));
    assert.equal(resultadosAverageText(list.body, 'ana@notas.local'), '7,4', 'tela Resultados');
    const book = await admin(request(app).get(`/api/admin/gradebook?courseId=${COURSE_A}&studentClass=1DES`));
    const anaRow = book.body.rows.find(row => row.email === 'ana@notas.local');
    assert.equal(anaRow.average, 7.4);
    assert.equal(webGrades.fmtGrade(anaRow.averageScore), '7,4', 'quadro de notas na tela');
    const csv = await admin(request(app).get(`/api/admin/gradebook?courseId=${COURSE_A}&studentClass=1DES&format=csv`));
    assert.equal(parseCsv(csv.text).find(line => line[1] === 'ana@notas.local').slice(-2)[0], '7,4');

    const login = await request(app).post('/api/student/login').send({ email: 'ana@notas.local', password: '123' });
    const dashboard = await request(app).get(`/api/student/dashboard?courseId=${COURSE_A}&studentClass=1DES`).set('x-session-token', login.body.sessionToken);
    assert.equal(dashboard.status, 200, dashboard.body.error);
    assert.equal(dashboard.body.overallNote, 7.4);

    // Servidor (roundGrade/formatGradeBR) e tela (fmtGrade) arredondam do mesmo jeito.
    const { formatGradeBR } = require('../../backend/utils/gradebook.js');
    for (let tenths = 0; tenths <= 1000; tenths += 5) {
        const score = tenths / 10;
        assert.equal(webGrades.fmtGrade(score), formatGradeBR(score), `nota ${score}`);
    }
    for (const score of [200 / 3, 100 / 3, 73.5, 84.95, 0.05, 99.95]) assert.equal(webGrades.fmtGrade(score), formatGradeBR(score), `nota ${score}`);
});

test('[UC-NOTAS-001] colega só com nota inválida não puxa a média da turma; análise sem nota válida não mostra 0,0', async () => {
    db.memory.submissions = [
        submission('ana_ok', { score: 80 }),
        submission('bia_invalida', { email: 'bia@notas.local', name: 'Bia', score: 150 }),
    ];
    const dash = await admin(request(app).get('/api/admin/student/dashboard?email=ana@notas.local'));
    assert.equal(dash.status, 200);
    assert.equal(dash.body.comparativo.turmaMedia, 8, 'antes a nota inválida da Bia contava como 0 (média 4)');

    db.memory.submissions = [submission('so_invalida', { examKey: 'Avaliacao_P3', score: 150 })];
    const analytics = await admin(request(app).get('/api/admin/exam-analytics/1DES/Avaliacao_P3'));
    assert.equal(analytics.status, 200);
    assert.equal(analytics.body.averageScore, null);
    assert.equal(analytics.body.validScoreCount, 0);
    assert.equal(webGrades.fmtGrade(analytics.body.averageScore), '—', 'o Monitor mostra "—"');
});

test('[UC-NOTAS-004] lixeira de notas: a exclusão pode ser desfeita e fica registrada', async () => {
    const created = await createGrade({ examKey: 'Avaliacao_P2', correctCount: 7, totalCount: 10 });
    const id = created.body.submissionId;
    await admin(request(app).post('/api/admin/submissions/publish')).send({ ids: [id], published: true });
    const removed = await professor(request(app).post('/api/admin/submissions/delete')).send({ id });
    assert.equal(removed.status, 200);
    assert.equal(db.memory.submissions.some(item => item.id === id), false);

    const trash = await professor(request(app).get(`/api/admin/submissions/deleted?courseId=${COURSE_A}&studentClass=1DES`));
    assert.equal(trash.status, 200, trash.body.error);
    assert.equal(trash.body.items.length, 1);
    const item = trash.body.items[0];
    assert.equal(item.submissionId, id);
    assert.equal(item.deletedBy, 'prof@notas.local');
    assert.equal(item.grade, '7,0');
    assert.equal(item.gradePublished, true);
    assert.equal(item.canRestore, true);
    assert.equal((await admin(request(app).get(`/api/admin/submissions/deleted?courseId=${COURSE_B}&studentClass=2RED`))).body.items.length, 0, 'só a turma pedida');

    const restored = await professor(request(app).post('/api/admin/submissions/restore')).send({ auditId: item.auditId });
    assert.equal(restored.status, 200, restored.body.error);
    const back = db.memory.submissions.find(sub => sub.id === id);
    assert.equal(back.score, 70);
    assert.equal(back.gradePublished, true, 'volta como estava');
    assert.equal(back.restoredBy, 'prof@notas.local');
    assert.equal((await professor(request(app).get(`/api/admin/submissions/deleted?courseId=${COURSE_A}&studentClass=1DES`))).body.items.length, 0);
    assert.equal((await professor(request(app).post('/api/admin/submissions/restore')).send({ auditId: item.auditId })).status, 409, 'não restaura duas vezes');
    assert.equal((await admin(request(app).post('/api/admin/submissions/restore')).send({ auditId: 'nao-existe' })).status, 404);
    assert.equal((await admin(request(app).post('/api/admin/submissions/restore')).send({})).status, 400);

    const audit = await admin(request(app).get('/api/admin/student/audit?email=ana@notas.local'));
    const restoreEntry = audit.body.find(entry => entry.action === 'grade_restore');
    assert.ok(restoreEntry, 'restauração na auditoria do aluno');
    assert.match(restoreEntry.newValue, /restaurada da lixeira \(publicada\)/);
    const review = await admin(request(app).get(`/api/admin/submissions/${id}/review`));
    assert.ok(review.body.history.some(entry => /restaurada/.test(entry.newValue)), 'histórico da nota mostra a volta');

    // Professor não vê nem restaura nota excluída de aluno de outro curso (mesma regra da exclusão).
    const caio = await admin(request(app).post('/api/admin/submissions/create')).send({ studentEmail: 'caio@notas.local', examKey: 'Avaliacao_P1', grade: 6, courseId: COURSE_B, studentClass: '1DES' });
    assert.equal(caio.status, 200, caio.body.error);
    await admin(request(app).post('/api/admin/submissions/delete')).send({ id: caio.body.submissionId });
    const caioEntry = db.memory.auditLogs.find(entry => entry.action === 'grade_delete' && entry.submissionId === caio.body.submissionId);
    assert.equal((await professor(request(app).get(`/api/admin/submissions/deleted?courseId=${COURSE_B}&studentClass=1DES`))).status, 403, 'turma fora do escopo do professor');
    assert.equal((await professor(request(app).get('/api/admin/submissions/deleted'))).body.items.some(entry => entry.studentEmail === 'caio@notas.local'), false);
    assert.equal((await admin(request(app).get(`/api/admin/submissions/deleted?courseId=${COURSE_B}&studentClass=1DES`))).body.items.length, 1);
    assert.equal((await professor(request(app).post('/api/admin/submissions/restore')).send({ auditId: caioEntry.id })).status, 404);
});

test('[UC-NOTAS-004] anulação guarda o motivo no histórico da nota e o registro da aplicação mostra tudo', async () => {
    const application = db.memory.examApplications[0];
    application.versionSnapshots = [{ version: 'A', questions: db.memory.evaluations.Avaliacao_P1.questions.map(item => ({ ...item })) }];
    application.createdBy = 'prof@notas.local';
    application.finishedAt = '2026-03-01T11:00:00.000Z';
    db.memory.examApplications.push({ id: 'app_red', examKey: 'Avaliacao_P1', studentClass: '2RED', courseId: COURSE_B, status: 'finished', createdAt: '2026-03-02T10:00:00.000Z' });
    db.memory.submissions = [submission('ana_app1', { applicationId: 'app_1', score: 50, extra: {
        correctCount: 2,
        totalCount: 4,
        assignedVersion: 'A',
        gradedAnswers: [
            { questionNumber: 1, studentChoice: 'B' }, { questionNumber: 2, studentChoice: 'A' },
            { questionNumber: 3, studentChoice: 'A' }, { questionNumber: 4, studentChoice: 'A' },
        ],
    } })];

    const annul = await professor(request(app).post('/api/admin/annul-question')).send({ applicationId: 'app_1', questionNumber: 3, mode: 'ponto_para_todos', reason: 'enunciado ambíguo' });
    assert.equal(annul.status, 200, annul.body.error);
    const sub = db.memory.submissions.find(item => item.id === 'ana_app1');
    assert.equal(sub.score, 75);
    assert.match(sub.scoreHistory[0].reason, /anulação da questão 3 \(ponto para todos\) · motivo: enunciado ambíguo/);
    const regradeAudit = db.memory.auditLogs.find(entry => entry.action === 'grade_regrade');
    assert.match(regradeAudit.newValue, /motivo: enunciado ambíguo/, 'antes o histórico dizia só "anulação da questão 3"');
    const studentMessage = (db.memory.broadcastMessages || []).find(message => message.applicationId === 'app_1');
    assert.equal(studentMessage.messageText, 'A questão 3 foi anulada pelo professor e não prejudicará sua nota.', 'aviso ao aluno com acentos');

    const trail = await professor(request(app).get('/api/admin/exam-applications/app_1/audit'));
    assert.equal(trail.status, 200, trail.body.error);
    assert.equal(trail.body.application.examTitle, 'Prova 1 — Fundamentos');
    const titles = trail.body.entries.map(entry => entry.title);
    assert.ok(titles.includes('Aplicação criada'));
    assert.ok(titles.includes('Prova iniciada'));
    assert.ok(titles.includes('Aplicação encerrada'));
    const annulEntry = trail.body.entries.find(entry => entry.kind === 'exam');
    assert.equal(annulEntry.title, 'Questão 3 anulada (ponto para todos)');
    assert.match(annulEntry.detail, /motivo: enunciado ambíguo · 1 entrega recorrigida/);
    assert.equal(annulEntry.actor, 'prof@notas.local');
    const gradeEntry = trail.body.entries.find(entry => entry.kind === 'grade');
    assert.equal(gradeEntry.title, 'Nota · Ana');
    assert.match(gradeEntry.detail, /5,0 \(2\/4 acertos\) → .*7,5 \(3\/4 acertos\)/);
    const seconds = trail.body.entries.map(entry => Math.floor(entry.at / 1000));
    assert.deepEqual(seconds, [...seconds].sort((a, b) => a - b), 'em ordem cronológica');
    assert.ok(trail.body.entries.indexOf(annulEntry) < trail.body.entries.indexOf(gradeEntry), 'a anulação aparece antes da nota que ela recorrigiu');

    assert.equal((await professor(request(app).get('/api/admin/exam-applications/app_red/audit'))).status, 403, 'aplicação de outro curso');
    assert.equal((await admin(request(app).get('/api/admin/exam-applications/nao_existe/audit'))).status, 404);
});

test('[UC-NOTAS-001] regra e "Usar esta nota" valem para o grupo inteiro, inclusive o registro antigo sem curso', async () => {
    // Registro antigo (lançamento da versão anterior, sem curso) + lançamento novo da
    // mesma prova: Resultados e boletim mostram UM grupo. Antes a ação na tentativa
    // antiga mexia só nela e a nota mostrada não mudava (a auditoria gravava uma nota que não valia).
    db.memory.submissions = [{ ...submission('antiga', { score: 90 }), student: { name: 'Ana', email: 'ana@notas.local', studentClass: '1DES', courseId: null } }];
    const created = await createGrade({ examKey: 'Avaliacao_P1', grade: '5' });
    assert.equal(created.status, 200, created.body.error);
    const novo = created.body.submissionId;
    assert.equal(db.memory.submissions.find(item => item.id === novo).attemptNumber, 2);
    await admin(request(app).post('/api/admin/submissions/publish')).send({ ids: [novo], published: true });
    const list = async () => (await admin(request(app).get(`/api/admin/submissions?courseId=${COURSE_A}&studentClass=1DES`))).body;
    const report = async () => (await admin(request(app).get(`/api/admin/student/report?email=ana@notas.local&courseId=${COURSE_A}&studentClass=1DES`))).body.overallAverage;
    assert.deepEqual((await list()).map(item => item.consolidatedScore), [90, 90], 'um grupo, maior nota');

    const policy = await admin(request(app).post('/api/admin/submissions/result-control')).send({ submissionId: novo, action: 'policy', policy: 'average' });
    assert.equal(policy.status, 200, policy.body.error);
    assert.deepEqual(policy.body.submissions.map(item => [item.id, item.consolidatedScore]).sort(), [['antiga', 70], [novo, 70]], 'a resposta traz o grupo inteiro');
    assert.equal(db.memory.submissions.find(item => item.id === 'antiga').aggregationPolicy, 'average');
    assert.equal(await report(), 7);

    const select = await admin(request(app).post('/api/admin/submissions/result-control')).send({ submissionId: 'antiga', action: 'select' });
    assert.equal(select.status, 200, select.body.error);
    assert.deepEqual(select.body.submissions.map(item => [item.id, item.consolidatedScore]).sort(), [['antiga', 90], [novo, 90]]);
    const rows = await list();
    assert.deepEqual(rows.map(item => [item.id, item.consolidatedScore, item.countsTowardResult]).sort(), [['antiga', 90, true], [novo, 90, false]], 'antes continuava 7,0 (média)');
    assert.equal(await report(), 9, 'boletim igual a Resultados');
    const audit = db.memory.auditLogs.filter(entry => entry.action === 'grade_result_select').pop();
    assert.match(audit.oldValue, /7,0 \(regra: Média das consideradas\)/);
    assert.match(audit.newValue, /9,0 · tentativa 1 escolhida para a nota/);
    assert.equal(db.memory.submissions.find(item => item.id === 'antiga').student.courseId, null, 'o registro antigo não é reescrito');
});

test('[UC-NOTAS-004] nota na lixeira acompanha a troca de e-mail do aluno', async () => {
    const created = await createGrade({ examKey: 'Avaliacao_P2', grade: '7' });
    const id = created.body.submissionId;
    assert.equal((await professor(request(app).post('/api/admin/submissions/delete')).send({ id })).status, 200);
    const update = await admin(request(app).post('/api/admin/student/update')).send({ originalEmail: 'ana@notas.local', email: 'ana.nova@notas.local', name: 'Ana', classes: [{ name: '1DES', courseId: COURSE_A }], status: 'Ativo' });
    assert.equal(update.status, 200, update.body.error);

    const trash = await professor(request(app).get(`/api/admin/submissions/deleted?courseId=${COURSE_A}&studentClass=1DES`));
    assert.equal(trash.body.items.length, 1);
    assert.equal(trash.body.items[0].studentEmail, 'ana.nova@notas.local');
    assert.equal(trash.body.items[0].canRestore, true, 'antes: "Aluno fora do cadastro"');
    const restored = await professor(request(app).post('/api/admin/submissions/restore')).send({ auditId: trash.body.items[0].auditId });
    assert.equal(restored.status, 200, restored.body.error);
    assert.equal(db.memory.submissions.find(item => item.id === id).student.email, 'ana.nova@notas.local');

    // Dado gravado antes desta correção: a troca de e-mail renomeou só a auditoria, não a cópia.
    const other = await createGrade({ studentEmail: 'ana.nova@notas.local', examKey: 'Avaliacao_P3', grade: '6' });
    await admin(request(app).post('/api/admin/submissions/delete')).send({ id: other.body.submissionId });
    const entry = db.memory.auditLogs.find(item => item.action === 'grade_delete' && item.submissionId === other.body.submissionId);
    entry.details.deletedSubmission.student.email = 'ana.antiga@notas.local';
    const legacyTrash = await admin(request(app).get(`/api/admin/submissions/deleted?courseId=${COURSE_A}&studentClass=1DES`));
    assert.deepEqual(legacyTrash.body.items.map(item => [item.studentEmail, item.canRestore]), [['ana.nova@notas.local', true]]);
    const legacyRestore = await admin(request(app).post('/api/admin/submissions/restore')).send({ auditId: entry.id });
    assert.equal(legacyRestore.status, 200, legacyRestore.body.error);
    assert.equal(db.memory.submissions.find(item => item.id === other.body.submissionId).student.email, 'ana.nova@notas.local');
});

test('[UC-NOTAS-004] restaurar depois de lançar outra tentativa não repete o número nem deixa duas escolhidas', async () => {
    const first = await createGrade({ examKey: 'Avaliacao_P2', grade: '7' });
    await admin(request(app).post('/api/admin/submissions/result-control')).send({ submissionId: first.body.submissionId, action: 'select' });
    await admin(request(app).post('/api/admin/submissions/delete')).send({ id: first.body.submissionId });
    const second = await createGrade({ examKey: 'Avaliacao_P2', grade: '9' });
    assert.equal(db.memory.submissions.find(item => item.id === second.body.submissionId).attemptNumber, 1);
    await admin(request(app).post('/api/admin/submissions/result-control')).send({ submissionId: second.body.submissionId, action: 'select' });

    const auditId = db.memory.auditLogs.find(entry => entry.action === 'grade_delete').id;
    const restored = await admin(request(app).post('/api/admin/submissions/restore')).send({ auditId });
    assert.equal(restored.status, 200, restored.body.error);
    assert.equal(restored.body.attemptNumber, 2);
    assert.match(restored.body.message, /como tentativa 2/);
    const rows = (await admin(request(app).get(`/api/admin/submissions?courseId=${COURSE_A}&studentClass=1DES`))).body;
    assert.deepEqual(rows.map(item => item.attemptNumber).sort(), [1, 2], 'antes: duas "Tentativa 1"');
    assert.equal(rows.filter(item => item.selectedForResult === true).length, 1, 'só a escolhida depois continua escolhida');
    assert.ok(rows.every(item => item.consolidatedScore === 90));
    const audit = db.memory.auditLogs.find(entry => entry.action === 'grade_restore');
    assert.match(audit.newValue, /volta como tentativa 2 \(o número 1 já estava em uso\) · outra tentativa continua escolhida para a nota/);

    // Lançar depois de excluir uma tentativa do meio usa o maior número + 1 (antes repetia o 2).
    const third = await createGrade({ examKey: 'Avaliacao_P2', grade: '8' });
    assert.equal(db.memory.submissions.find(item => item.id === third.body.submissionId).attemptNumber, 3);
    await admin(request(app).post('/api/admin/submissions/delete')).send({ id: second.body.submissionId });
    const fourth = await createGrade({ examKey: 'Avaliacao_P2', grade: '6' });
    assert.equal(db.memory.submissions.find(item => item.id === fourth.body.submissionId).attemptNumber, 4);
});

test('[UC-NOTAS-001] nota e acertos conferem pela nota gravada, não pela digitada (na tela e no servidor)', async () => {
    const cases = [
        { grade: '7,4', ok: false }, { grade: '7,41', ok: false }, { grade: '7,45', ok: true, score: 75 },
        { grade: '7,5', ok: true, score: 75 }, { grade: '7,55', ok: false }, { grade: '7,59', ok: false }, { grade: '7,6', ok: false },
    ];
    for (const item of cases) {
        const res = await createGrade({ examKey: 'Avaliacao_P1', grade: item.grade, correctCount: 3, totalCount: 4 });
        assert.equal(res.status, item.ok ? 200 : 400, `${item.grade} com 3 de 4: ${res.body.error || res.body.score}`);
        if (item.ok) assert.equal(res.body.score, item.score);
        const front = webGrades.validateQuickGrade({ grade: item.grade, correctCount: '3', totalCount: '4' }, { maxQuestions: 4, defaultTotal: 4 });
        assert.equal(!front.errors.grade, item.ok, `tela: ${item.grade}`);
    }
    const twoDecimals = await createGrade({ examKey: 'Avaliacao_P1', grade: '7,41', correctCount: 3, totalCount: 4 });
    assert.match(twoDecimals.body.error, /A nota 7,41 \(gravada como 7,4\) não confere com 3 de 4 acertos \(7,5\)/);
    assert.match(webGrades.validateQuickGrade({ grade: '7,59', correctCount: '3', totalCount: '4' }).errors.grade, /gravada como 7,6/);
    // 2 de 3 = 6,67: 6,6 e 6,7 são arredondamentos aceitos.
    for (const grade of ['6,6', '6,7']) {
        assert.equal((await createGrade({ examKey: 'Avaliacao_P3', grade, correctCount: 2, totalCount: 3 })).status, 200, grade);
    }
    // Servidor e tela gravam/mostram a mesma nota para qualquer nota digitada de 0,00 a 10,00.
    const { scoreFromGrade } = require('../../backend/utils/gradebook.js');
    for (let hundredths = 0; hundredths <= 1000; hundredths++) {
        const grade = hundredths / 100;
        assert.equal(webGrades.scoreFromGrade(grade), scoreFromGrade(grade), `nota ${grade}`);
        assert.equal(webGrades.previewQuickGrade({ grade }), scoreFromGrade(grade) / 10, `prévia ${grade}`);
    }
});

test('[UC-NOTAS-003] portal do aluno (Provas) faz a média como o painel e o boletim, com regra "média" e registro antigo', async () => {
    db.memory.submissions = [
        submission('p1_a', { score: 60, extra: { aggregationPolicy: 'average', attemptNumber: 1 } }),
        submission('p1_b', { score: 80, timestamp: '2026-03-02T12:00:00.000Z', extra: { aggregationPolicy: 'average', attemptNumber: 2 } }),
        submission('p2', { examKey: 'Avaliacao_P2', score: 100 }),
        { ...submission('p3_antiga', { examKey: 'Avaliacao_P3', score: 40 }), student: { name: 'Ana', email: 'ana@notas.local', studentClass: '1DES' } },
    ];
    const login = await request(app).post('/api/student/login').send({ email: 'ana@notas.local', password: '123' });
    const token = login.body.sessionToken;
    const mine = await request(app).post('/api/student/my-submissions').set('x-session-token', token).send({ courseId: COURSE_A, studentClass: '1DES' });
    assert.equal(mine.status, 200, mine.body.error);
    assert.ok(mine.body.submissions.some(item => item.id === 'p3_antiga'), 'registro antigo sem curso aparece no curso da matrícula');
    const dashboard = await request(app).get(`/api/student/dashboard?courseId=${COURSE_A}&studentClass=1DES`).set('x-session-token', token);
    const report = await admin(request(app).get(`/api/admin/student/report?email=ana@notas.local&courseId=${COURSE_A}&studentClass=1DES`));
    // (média(6,0; 8,0) + 10,0 + 4,0) / 3 = 7,0 no painel e no boletim. Antes a tela
    // Provas não recebia o registro antigo e fazia a média por tentativa: (6+8+10)/3 = 8,0.
    assert.equal(dashboard.body.overallNote, 7);
    assert.equal(report.body.overallAverage, 7);
    assert.equal(webGrades.fmtGrade(webGrades.consolidatedAverage(mine.body.submissions)), '7,0');

    db.memory.submissions = db.memory.submissions.filter(item => item.id !== 'p3_antiga');
    const mine2 = await request(app).post('/api/student/my-submissions').set('x-session-token', token).send({ courseId: COURSE_A, studentClass: '1DES' });
    const dashboard2 = await request(app).get(`/api/student/dashboard?courseId=${COURSE_A}&studentClass=1DES`).set('x-session-token', token);
    assert.equal(dashboard2.body.overallNote, 8.5);
    assert.equal(webGrades.fmtGrade(webGrades.consolidatedAverage(mine2.body.submissions)), '8,5', 'antes a tela Provas mostrava 8,0');
});

test('[UC-NOTAS-004] excluir o aluno anonimiza as cópias das notas dele na lixeira (fica só prova e nota)', async () => {
    // Entrega online copiava o cadastro inteiro do aluno para a nota (e daí para a lixeira).
    db.memory.students[0].matricula = 'MAT-2026-001';
    db.memory.students[0].telefone = '(11) 99999-0000';
    db.memory.submissions = [
        submission('ana_online', { applicationId: 'app_1', score: 70, extra: {
            student: { name: 'Ana', email: 'ana@notas.local', matricula: 'MAT-2026-001', telefone: '(11) 99999-0000', courseId: COURSE_A, studentClass: '1DES' },
            studentName: 'Ana', correctCount: 3, totalCount: 4, assignedVersion: 'A', gradedAnswers: [{ questionNumber: 1, studentChoice: 'B', isCorrect: true }],
        } }),
        submission('bia_p1', { email: 'bia@notas.local', name: 'Bia', score: 90 }),
    ];
    assert.equal((await admin(request(app).post('/api/admin/submissions/delete')).send({ id: 'ana_online' })).status, 200);
    assert.equal((await admin(request(app).post('/api/admin/submissions/delete')).send({ id: 'bia_p1' })).status, 200);
    const before = db.memory.auditLogs.find(entry => entry.action === 'grade_delete' && entry.details.deletedSubmission.id === 'ana_online');
    assert.equal(before.details.deletedSubmission.student.matricula, 'MAT-2026-001', 'antes da exclusão do aluno a cópia é completa (restaurável)');

    const deleted = await admin(request(app).post('/api/admin/delete-student')).send({ email: 'ANA@notas.local' });
    assert.equal(deleted.status, 200, deleted.body.error);

    const entry = db.memory.auditLogs.find(item => item.action === 'grade_delete' && item.details.deletedSubmission.id === 'ana_online');
    const copy = entry.details.deletedSubmission;
    const serialized = JSON.stringify(copy);
    for (const personal of ['ana@notas.local', 'MAT-2026-001', '99999-0000', '"Ana"']) {
        assert.equal(serialized.includes(personal), false, `cópia ainda tem ${personal}`);
    }
    assert.equal(copy.anonymized, true);
    assert.deepEqual(copy.student, { name: 'Aluno excluído', email: '', courseId: COURSE_A, studentClass: '1DES' });
    // Para a estatística: prova, nota, acertos e respostas continuam.
    assert.equal(copy.examKey, 'Avaliacao_P1');
    assert.equal(copy.score, 70);
    assert.equal(copy.correctCount, 3);
    assert.equal(copy.totalCount, 4);
    assert.equal(copy.gradedAnswers.length, 1);
    // A ficha de auditoria pelo e-mail antigo também não devolve mais o cadastro.
    const audit = await admin(request(app).get('/api/admin/student/audit?email=ana@notas.local'));
    assert.equal(JSON.stringify(audit.body).includes('MAT-2026-001'), false);

    // A nota da Bia (outra aluna) continua completa e restaurável.
    const bia = db.memory.auditLogs.find(item => item.action === 'grade_delete' && item.details.deletedSubmission.id === 'bia_p1');
    assert.equal(bia.details.deletedSubmission.student.email, 'bia@notas.local');

    const trash = await admin(request(app).get(`/api/admin/submissions/deleted?courseId=${COURSE_A}&studentClass=1DES`));
    const anaItem = trash.body.items.find(item => item.submissionId === 'ana_online');
    assert.equal(anaItem.studentName, 'Aluno excluído');
    assert.equal(anaItem.studentEmail, '');
    assert.equal(anaItem.canRestore, false);
    assert.equal(trash.body.items.find(item => item.submissionId === 'bia_p1').canRestore, true);

    // Nova conta com o mesmo e-mail não "herda" a nota anonimizada.
    db.memory.students.push({ name: 'Outra Ana', email: 'ana@notas.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: COURSE_A }] });
    const again = await admin(request(app).get(`/api/admin/submissions/deleted?courseId=${COURSE_A}&studentClass=1DES`));
    assert.equal(again.body.items.find(item => item.submissionId === 'ana_online').canRestore, false);
    const restore = await admin(request(app).post('/api/admin/submissions/restore')).send({ auditId: entry.id });
    assert.equal(restore.status, 409);
    assert.match(restore.body.error, /excluído/);
    assert.equal(db.memory.submissions.some(item => item.id === 'ana_online'), false);
});

test('[UC-NOTAS-002] CSV da prova exige o curso e não marca como publicada a nota inválida', async () => {
    db.memory.submissions = [
        submission('ana_p1', { score: 70 }),
        submission('ana_invalida', { score: 150, extra: { attemptNumber: 2 } }),
        // Registro antigo sem curso de um aluno da 1DES do curso B (turma homônima).
        { ...submission('caio_antigo', { email: 'caio@notas.local', name: 'Caio', score: 30 }), student: { name: 'Caio', email: 'caio@notas.local', studentClass: '1DES' } },
    ];
    const noCourse = await admin(request(app).get('/api/admin/export-grades/1DES/Avaliacao_P1'));
    assert.equal(noCourse.status, 400, 'antes juntava o Caio do curso B');
    assert.match(noCourse.body.error, /Curso é obrigatório/);

    const res = await admin(request(app).get(`/api/admin/export-grades/1DES/Avaliacao_P1?courseId=${COURSE_A}`));
    assert.equal(res.status, 200);
    const lines = parseCsv(res.text);
    assert.equal(res.text.includes('caio@notas.local'), false);
    const invalid = lines.find(line => line[9] === 'nota inválida');
    assert.ok(invalid, 'linha da nota inválida');
    assert.equal(invalid[12], 'Não (nota inválida)', 'antes saía "Sim"');
    assert.equal(lines.find(line => line[9] === '7,0')[12], 'Sim');
});

test('[UC-NOTAS-004] registro da aplicação não fala em "0 tentativas descartadas" quando não houve descarte', async () => {
    const application = db.memory.examApplications[0];
    application.finishedAt = '2026-03-01T11:00:00.000Z';
    const finishEntry = (id, details) => ({
        id, type: 'exam_application_finished', actor: 'prof@notas.local', applicationId: 'app_1', examKey: 'Avaliacao_P1',
        studentClass: '1DES', courseId: COURSE_A, details, timestamp: '2026-03-01T11:00:00.000Z',
    });
    db.memory.auditLogs = [finishEntry('fin_discard_0', { policy: 'discard', submitted: 0, discarded: 0 })];
    let trail = await admin(request(app).get('/api/admin/exam-applications/app_1/audit'));
    let finished = trail.body.entries.find(entry => entry.title === 'Aplicação encerrada');
    assert.equal(finished.detail, '', 'antes: "0 tentativas em andamento descartadas"');

    db.memory.auditLogs = [finishEntry('fin_submit_0', { policy: 'submit', submitted: 0, discarded: 0 })];
    trail = await admin(request(app).get('/api/admin/exam-applications/app_1/audit'));
    assert.equal(trail.body.entries.find(entry => entry.title === 'Aplicação encerrada').detail, '');

    db.memory.auditLogs = [finishEntry('fin_discard_2', { policy: 'discard', submitted: 0, discarded: 2 })];
    trail = await admin(request(app).get('/api/admin/exam-applications/app_1/audit'));
    assert.equal(trail.body.entries.find(entry => entry.title === 'Aplicação encerrada').detail, '2 tentativas em andamento descartadas');

    db.memory.auditLogs = [finishEntry('fin_submit_1', { policy: 'submit', submitted: 1, discarded: 0 })];
    trail = await admin(request(app).get('/api/admin/exam-applications/app_1/audit'));
    assert.equal(trail.body.entries.find(entry => entry.title === 'Aplicação encerrada').detail, '1 prova em andamento enviada pelo professor');
});
