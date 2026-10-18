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
    // Nem religa a cópia ao aluno: a própria entrada da exclusão perdia só a cópia e
    // continuava com studentEmail, e a busca da ficha pelo e-mail devolvia nota e prova.
    assert.equal(entry.studentEmail, '');
    assert.equal(entry.studentAnonymized, true);
    assert.equal(audit.body.some(item => item.id === entry.id), false);
    assert.deepEqual(audit.body, []);
    const anaTrail = db.memory.auditLogs.filter(item => item.submissionId === 'ana_online');
    assert.ok(anaTrail.length >= 1);
    for (const item of anaTrail) {
        const text = JSON.stringify(item);
        assert.equal(text.includes('ana@notas.local'), false, `${item.action} ainda tem o e-mail`);
        assert.equal(item.studentEmail, '');
    }

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

    // Contestação do aluno: antes aparecia como "Evento da prova · exam_question_reported".
    db.memory.auditLogs = [{ ...finishEntry('rep_1', { reportId: 'r1', questionNumber: 3, reason: 'duas_corretas' }), type: 'exam_question_reported', actor: 'ana@notas.local' }];
    trail = await admin(request(app).get('/api/admin/exam-applications/app_1/audit'));
    const reported = trail.body.entries.find(entry => entry.id === 'rep_1');
    assert.equal(reported.title, 'Questão 3 contestada pelo aluno');
    assert.equal(reported.detail, 'Mais de uma resposta correta');
    assert.equal(JSON.stringify(trail.body.entries).includes('exam_question_reported'), false);
});

test('[UC-NOTAS-004] excluir o aluno tira o e-mail, o nome e o cadastro de todo o histórico dele na auditoria', async () => {
    db.memory.students[0].matricula = 'MAT-2026-001';
    // Alteração de cadastro (Nome) feita pela ficha: valores são dado pessoal.
    const updated = await admin(request(app).post('/api/admin/student/update')).send({ originalEmail: 'ana@notas.local', email: 'ana@notas.local', name: 'Ana Souza', matricula: 'MAT-2026-001', classes: [{ name: '1DES', courseId: COURSE_A }] });
    assert.equal(updated.status, 200, updated.body.error);
    const profile = db.memory.auditLogs.find(item => item.field === 'Nome completo' && item.studentEmail === 'ana@notas.local');
    assert.ok(profile, 'a troca de nome gera auditoria');
    db.memory.auditLogs.push(
        { id: 'audit_exam_report_x', type: 'exam_question_reported', actor: 'ana@notas.local', applicationId: 'app_1', examKey: 'Avaliacao_P1', studentClass: '1DES', courseId: COURSE_A, details: { reportId: 'r1', questionNumber: 1, reason: 'outro' }, timestamp: Date.now() },
        { id: 'audit_exam_finish_x', type: 'exam_application_finished', actor: 'admin@notas.local', applicationId: 'app_1', examKey: 'Avaliacao_P1', studentClass: '1DES', courseId: COURSE_A, details: { policy: 'submit', submitted: 2, students: [{ email: 'ana@notas.local', answeredQuestions: 3 }, { email: 'bia@notas.local', answeredQuestions: 4 }] }, timestamp: Date.now() },
        { id: 'audit_bia_x', actor: 'admin@notas.local', studentEmail: 'bia@notas.local', action: 'update', field: 'Nome', oldValue: 'Bia', newValue: 'Bia Lima', timestamp: Date.now() },
    );
    db.memory.submissions = [submission('ana_p1', { name: 'Ana Souza', score: 63, extra: { correctCount: 3, totalCount: 4 } })];
    assert.equal((await admin(request(app).post('/api/admin/submissions/delete')).send({ id: 'ana_p1' })).status, 200);

    assert.equal((await admin(request(app).post('/api/admin/delete-student')).send({ email: 'ana@notas.local' })).status, 200);

    const leaks = db.memory.auditLogs.filter(item => /ana@notas\.local|Ana Souza|MAT-2026-001/i.test(JSON.stringify(item)));
    assert.deepEqual(leaks.map(item => item.id), [], 'nenhuma entrada cita o e-mail, o nome ou a matrícula');
    const profileAfter = db.memory.auditLogs.find(item => item.id === profile.id);
    assert.equal(profileAfter.studentEmail, '');
    assert.equal(profileAfter.oldValue, '');
    assert.equal(profileAfter.newValue, '');
    assert.equal(profileAfter.field, 'Nome completo', 'o tipo da alteração e quem fez continuam no histórico');
    assert.equal(profileAfter.actor, 'admin@notas.local');
    assert.equal(db.memory.auditLogs.find(item => item.id === 'audit_exam_report_x').actor, 'aluno excluído');
    const finish = db.memory.auditLogs.find(item => item.id === 'audit_exam_finish_x');
    assert.deepEqual(finish.details.students, [{ email: '', answeredQuestions: 3 }, { email: 'bia@notas.local', answeredQuestions: 4 }]);
    // A nota (prova e valor) continua para a estatística.
    const deletion = db.memory.auditLogs.find(item => item.action === 'grade_delete' && item.submissionId === 'ana_p1');
    assert.equal(deletion.details.deletedSubmission.score, 63);
    assert.equal(deletion.examKey, 'Avaliacao_P1');
    assert.match(deletion.oldValue, /6,3/);
    // Outra aluna não muda.
    assert.deepEqual(db.memory.auditLogs.find(item => item.id === 'audit_bia_x'), { id: 'audit_bia_x', actor: 'admin@notas.local', studentEmail: 'bia@notas.local', action: 'update', field: 'Nome', oldValue: 'Bia', newValue: 'Bia Lima', timestamp: db.memory.auditLogs.find(item => item.id === 'audit_bia_x').timestamp });
    const audit = await admin(request(app).get('/api/admin/student/audit?email=ana@notas.local'));
    assert.deepEqual(audit.body, []);
});

test('[UC-NOTAS-004] excluir aluno que reaproveitou o e-mail antigo de outro não mexe no histórico do aluno vivo', async () => {
    // Ana trocou ana@ → ana.souza@ na versão antiga (as entradas de antes ficaram com ana@);
    // depois outra pessoa se cadastrou com ana@ e é excluída.
    db.memory.students[0].email = 'ana.souza@notas.local';
    db.memory.students.push({ name: 'Zé Novo', email: 'ana@notas.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: COURSE_A }] });
    db.memory.auditLogs = [
        { id: 'old_ana', actor: 'admin@notas.local', studentEmail: 'ana@notas.local', action: 'update', field: 'Telefone', oldValue: '1', newValue: '2', timestamp: 1 },
        { id: 'troca_ana', actor: 'admin@notas.local', studentEmail: 'ana.souza@notas.local', action: 'update', field: 'E-mail/login', oldValue: 'ana@notas.local', newValue: 'ana.souza@notas.local', timestamp: 2 },
        { id: 'ze_criado', actor: 'admin@notas.local', studentEmail: 'ana@notas.local', action: 'create', field: 'Cadastro', oldValue: '', newValue: 'Aluno criado', timestamp: 3 },
    ];
    const troca = { ...db.memory.auditLogs[1] };
    const antiga = { ...db.memory.auditLogs[0] };
    assert.equal((await admin(request(app).post('/api/admin/delete-student')).send({ email: 'ana@notas.local' })).status, 200);
    assert.deepEqual(db.memory.auditLogs.find(item => item.id === 'troca_ana'), troca, 'a troca de e-mail da Ana (viva) continua com o valor antigo');
    // Antes da troca o e-mail era da Ana: a entrada dela com ana@ não muda (antes virava "aluno excluído").
    assert.deepEqual(db.memory.auditLogs.find(item => item.id === 'old_ana'), antiga);
    assert.equal(db.memory.auditLogs.find(item => item.id === 'ze_criado').studentEmail, '');
});

test('[UC-NOTAS-004] excluir o aluno anonimiza as contestações dele nas aplicações (sem e-mail, nome e texto livre)', async () => {
    const report = (id, email, name, text) => ({
        id, applicationId: 'app_1', attemptId: `att_${id}`, examKey: 'Avaliacao_P1', studentClass: '1DES', courseId: COURSE_A,
        questionNumber: 2, questionPosition: 1, assignedVersion: 'A', studentEmail: email, studentName: name,
        reason: 'outro', text, status: 'open', createdAt: '2026-03-01T10:30:00.000Z',
    });
    db.memory.students[0].matricula = '2026-TI-001';
    db.memory.examApplications[0].questionReports = [
        report('r_ana', 'ana@notas.local', 'Ana', 'Sou Ana, matrícula 2026-TI-001, telefone 11 99999-0000: a alternativa B também serve.'),
        report('r_bia', 'bia@notas.local', 'Bia', 'A questão tem duas respostas.'),
    ];
    db.memory.examApplications[0].studentAdjustments = { 'ana@notas.local': 10, 'bia@notas.local': 5 };
    db.memory.examApplications[0].studentVersions = { 'ana@notas.local': 'B' };
    db.memory.classes[0].onlineExamConfigs = { Avaliacao_P1: { questionReports: [report('r_ana_cfg', 'ANA@notas.local', 'Ana', 'texto da Ana')], studentAdjustments: { 'ana@notas.local': 10 } } };

    assert.equal((await admin(request(app).post('/api/admin/delete-student')).send({ email: 'ana@notas.local' })).status, 200);

    const application = db.memory.examApplications[0];
    const serialized = JSON.stringify(application) + JSON.stringify(db.memory.classes[0]);
    for (const personal of ['ana@notas.local', '2026-TI-001', '99999-0000', 'Sou Ana', 'texto da Ana']) {
        assert.equal(serialized.toLowerCase().includes(personal.toLowerCase()), false, `aplicação ainda tem ${personal}`);
    }
    const anaReport = application.questionReports.find(item => item.id === 'r_ana');
    assert.equal(anaReport.studentEmail, '');
    assert.equal(anaReport.studentName, 'Aluno excluído');
    assert.equal(anaReport.text, '');
    // A contestação continua para o professor revisar a questão.
    assert.equal(anaReport.questionNumber, 2);
    assert.equal(anaReport.reason, 'outro');
    assert.equal(anaReport.status, 'open');
    // A da Bia não muda.
    assert.equal(application.questionReports.find(item => item.id === 'r_bia').text, 'A questão tem duas respostas.');
    assert.deepEqual(application.studentAdjustments, { 'bia@notas.local': 5 });
    assert.deepEqual(application.studentVersions, {});
    assert.equal(db.memory.classes[0].onlineExamConfigs.Avaliacao_P1.questionReports[0].studentName, 'Aluno excluído');
});

// ---------------------------------------------------------------- exclusão do aluno (B-anonimizar)
// Regra: só a ação "excluir aluno" anonimiza, com casamento exato (campo igual ao
// e-mail; em texto livre, só o e-mail inteiro), para todos os e-mails conhecidos dele.

test('[UC-NOTAS-004] excluir ana@teste.local não altera nada de joana@teste.local (casamento exato, nunca por pedaço do e-mail)', async () => {
    const ANA = 'ana@teste.local';
    const JOANA = 'joana@teste.local';
    db.memory.students.push(
        { name: 'Ana Teste', email: ANA, matricula: 'MAT-ANA-01', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: COURSE_A }] },
        { name: 'Joana Teste', email: JOANA, matricula: 'MAT-JOA-01', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: COURSE_A }] },
    );
    const copyOf = (id, email, name) => ({ id, examKey: 'Avaliacao_P1', score: 70, student: { name, email, courseId: COURSE_A, studentClass: '1DES' } });
    db.memory.auditLogs = [
        { id: 'j_perfil', actor: 'admin@notas.local', studentEmail: JOANA, action: 'update', field: 'Telefone', oldValue: '(11) 1111-1111', newValue: '(11) 2222-2222', timestamp: 1 },
        { id: 'j_nota', actor: 'admin@notas.local', studentEmail: JOANA, action: 'grade_delete', category: 'grade', field: 'Nota', oldValue: '7,0', newValue: 'excluída', submissionId: 'sj', details: { deletedSubmission: copyOf('sj', JOANA, 'Joana Teste') }, timestamp: 2 },
        { id: 'j_contesta', type: 'exam_question_reported', actor: JOANA, applicationId: 'app_1', details: { reportId: 'rj', questionNumber: 1, reason: 'outro' }, timestamp: 3 },
        { id: 'j_texto', actor: 'admin@notas.local', studentEmail: JOANA, action: 'update', field: 'Observação', oldValue: '', newValue: `Responsável avisado em ${JOANA}`, timestamp: 4 },
        { id: 'a_perfil', actor: 'admin@notas.local', studentEmail: ANA, action: 'update', field: 'Telefone', oldValue: '(11) 3333-3333', newValue: '(11) 4444-4444', timestamp: 5 },
        { id: 'a_contesta', type: 'exam_question_reported', actor: ANA, applicationId: 'app_1', details: { reportId: 'ra', questionNumber: 2, reason: 'outro' }, timestamp: 6 },
        { id: 'turma_fim', type: 'exam_application_finished', actor: 'admin@notas.local', applicationId: 'app_1', details: { students: [{ email: ANA, answeredQuestions: 2 }, { email: JOANA, answeredQuestions: 4 }] }, timestamp: 7 },
        { id: 'turma_nota', type: 'academic_note', actorEmail: 'admin@notas.local', target: '1DES', after: `Contato: ${ANA}; ${JOANA}; maria.ana@teste.local; ${ANA}.br; ANA@Teste.Local. Fim com ${ANA}.`, at: 8 },
        // E-mails de outros alunos com letra acentuada ou apóstrofo colado (o cadastro aceita).
        { id: 'turma_fim_acentos', type: 'exam_application_finished', actor: 'admin@notas.local', applicationId: 'app_1', details: { summary: { students: [ANA, 'andréana@teste.local', "d'ana@teste.local", 'joãoana@teste.local', `${ANA}.br`, `${ANA}host`] } }, timestamp: 9 },
    ];
    db.memory.loginLogs = [
        { id: 'l_ana', email: ANA, role: 'student', status: 'success', timestamp: 1 },
        { id: 'l_joana', email: JOANA, role: 'student', status: 'success', timestamp: 2 },
        { id: 'l_maria', email: 'maria.ana@teste.local', role: 'student', status: 'failure', timestamp: 3 },
    ];
    db.memory.examApplications[0].questionReports = [
        { id: 'ra', applicationId: 'app_1', questionNumber: 2, studentEmail: ANA, studentName: 'Ana Teste', reason: 'outro', text: 'texto da Ana', status: 'open' },
        { id: 'rj', applicationId: 'app_1', questionNumber: 1, studentEmail: JOANA, studentName: 'Joana Teste', reason: 'outro', text: 'texto da Joana', status: 'open' },
    ];
    db.memory.examApplications[0].studentAdjustments = { [ANA]: 10, [JOANA]: 5 };
    db.memory.attendance = [
        { id: 'pa', studentEmail: ANA, date: '2026-03-02', status: 'presente' },
        { id: 'pj', studentEmail: JOANA, date: '2026-03-02', status: 'presente' },
    ];
    db.memory.forum = [{
        id: 'c_joana', key: 'geral', studentName: 'Joana Teste', studentEmail: JOANA, courseId: COURSE_A, studentClass: '1DES', text: 'dúvida da Joana', timestamp: 't',
        replies: [
            { id: 'r_ana', authorName: 'Ana Teste', authorRole: 'Aluno', authorEmail: ANA, text: 'resposta da Ana', timestamp: 't' },
            { id: 'r_joana', authorName: 'Joana Teste', authorRole: 'Aluno', authorEmail: JOANA, text: 'obrigada', timestamp: 't' },
        ],
        events: [{ type: 'reply', by: ANA, byName: 'Ana Teste', role: 'Aluno', at: 't' }, { type: 'reply', by: JOANA, byName: 'Joana Teste', role: 'Aluno', at: 't' }],
    }];
    db.memory.broadcastMessages = [
        { id: 'm_ana', targetEmail: ANA, messageText: 'só para a Ana', acknowledgedBy: [], deletedFor: [] },
        { id: 'm_joana', targetEmail: JOANA, messageText: 'só para a Joana', acknowledgedBy: [JOANA], deletedFor: [] },
        { id: 'm_turma', targetEmail: null, messageText: 'turma', acknowledgedBy: [ANA, JOANA], deletedFor: [ANA] },
    ];
    db.memory.announcements = [
        { id: 'av_ana', target: 'aluno', targetValue: ANA, title: 'Para a Ana', readBy: [ANA] },
        { id: 'av_joana', target: 'aluno', targetValue: JOANA, title: 'Para a Joana', readBy: [JOANA] },
        { id: 'av_turma', target: 'turma', targetValue: '1DES', title: 'Turma', readBy: [ANA, JOANA] },
    ];
    const snapshot = value => JSON.parse(JSON.stringify(value));
    const joanaBefore = {
        audit: snapshot(db.memory.auditLogs.filter(item => item.id.startsWith('j_'))),
        logins: snapshot(db.memory.loginLogs.filter(item => item.id !== 'l_ana')),
        report: snapshot(db.memory.examApplications[0].questionReports.find(item => item.id === 'rj')),
        attendance: snapshot(db.memory.attendance.find(item => item.id === 'pj')),
        message: snapshot(db.memory.broadcastMessages.find(item => item.id === 'm_joana')),
        announcement: snapshot(db.memory.announcements.find(item => item.id === 'av_joana')),
    };

    const deleted = await admin(request(app).post('/api/admin/delete-student')).send({ email: ANA });
    assert.equal(deleted.status, 200, deleted.body.error);

    // Nada da Joana mudou (antes: "joana@teste.local" contém "ana@teste.local" e virava "joaluno excluído").
    assert.deepEqual(db.memory.auditLogs.filter(item => item.id.startsWith('j_')), joanaBefore.audit);
    assert.deepEqual(db.memory.loginLogs, joanaBefore.logins);
    assert.deepEqual(db.memory.examApplications[0].questionReports.find(item => item.id === 'rj'), joanaBefore.report);
    assert.deepEqual(db.memory.examApplications[0].studentAdjustments, { [JOANA]: 5 });
    assert.deepEqual(db.memory.attendance, [joanaBefore.attendance]);
    assert.deepEqual(db.memory.broadcastMessages.find(item => item.id === 'm_joana'), joanaBefore.message);
    assert.deepEqual(db.memory.announcements.find(item => item.id === 'av_joana'), joanaBefore.announcement);
    assert.ok(db.memory.students.some(item => item.email === JOANA));
    const forum = db.memory.forum.find(item => item.id === 'c_joana');
    assert.equal(forum.studentEmail, JOANA);
    assert.deepEqual(forum.replies.map(item => item.id), ['r_joana']);
    assert.deepEqual(forum.events.map(item => item.by), ['aluno excluído', JOANA]);

    // Da Ana: campo exato vira vazio (ou "aluno excluído" no autor); em texto livre, só o e-mail inteiro.
    const byId = id => db.memory.auditLogs.find(item => item.id === id);
    assert.equal(byId('a_perfil').studentEmail, '');
    assert.equal(byId('a_perfil').oldValue, '');
    assert.equal(byId('a_contesta').actor, 'aluno excluído');
    assert.deepEqual(byId('turma_fim').details.students, [{ email: '', answeredQuestions: 2 }, { email: JOANA, answeredQuestions: 4 }]);
    assert.equal(byId('turma_nota').after, `Contato: aluno excluído; ${JOANA}; maria.ana@teste.local; ${ANA}.br; aluno excluído. Fim com aluno excluído.`);
    // Antes: "andréaluno excluído" e "d'aluno excluído".
    assert.deepEqual(byId('turma_fim_acentos').details.summary.students, ['', 'andréana@teste.local', "d'ana@teste.local", 'joãoana@teste.local', `${ANA}.br`, `${ANA}host`]);
    assert.deepEqual(db.memory.examApplications[0].questionReports.find(item => item.id === 'ra'), {
        id: 'ra', applicationId: 'app_1', questionNumber: 2, studentEmail: '', studentName: 'Aluno excluído', reason: 'outro', text: '', status: 'open',
        studentAnonymized: true, anonymizedAt: db.memory.examApplications[0].questionReports.find(item => item.id === 'ra').anonymizedAt,
    });
    assert.deepEqual(db.memory.broadcastMessages.find(item => item.id === 'm_turma'), { id: 'm_turma', targetEmail: null, messageText: 'turma', acknowledgedBy: [JOANA], deletedFor: [] });
    assert.equal(db.memory.broadcastMessages.some(item => item.id === 'm_ana'), false);
    assert.deepEqual(db.memory.announcements.find(item => item.id === 'av_turma').readBy, [JOANA]);
    assert.equal(db.memory.announcements.some(item => item.id === 'av_ana'), false);
    // Nenhum lugar do banco cita mais o e-mail da Ana (como e-mail inteiro).
    const anaEverywhere = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}._%+'-])ana@teste\\.local(?![\\p{L}\\p{M}\\p{N}_%+'-]|\\.[\\p{L}\\p{N}])`, 'iu');
    for (const collection of ['auditLogs', 'loginLogs', 'examApplications', 'attendance', 'forum', 'broadcastMessages', 'announcements', 'students']) {
        assert.equal(anaEverywhere.test(JSON.stringify(db.memory[collection])), false, `${collection} ainda cita ${ANA}`);
    }
});

test('[UC-NOTAS-004] aluno que trocou de e-mail tem os registros dos dois e-mails anonimizados (auditoria, logins, contestações e demais dados)', async () => {
    const OLD = 'ana@notas.local';
    const MIDDLE = 'ana.meio@notas.local';
    const NEW = 'ana.nova@notas.local';
    db.memory.loginLogs = [];
    // Login, contestação e presença com o e-mail antigo (a troca não renomeia logins nem contestações).
    assert.equal((await request(app).post('/api/student/login').send({ email: OLD, password: '123' })).status, 200);
    db.memory.examApplications[0].questionReports = [
        { id: 'r_antiga', applicationId: 'app_1', questionNumber: 1, studentEmail: OLD, studentName: 'Ana', reason: 'outro', text: 'minha matrícula é 2026-77', status: 'open' },
        { id: 'r_bia', applicationId: 'app_1', questionNumber: 1, studentEmail: 'bia@notas.local', studentName: 'Bia', reason: 'outro', text: 'texto da Bia', status: 'open' },
    ];
    // Troca em cadeia pela ficha: antigo → meio → novo.
    for (const [from, to] of [[OLD, MIDDLE], [MIDDLE, NEW]]) {
        const update = await admin(request(app).post('/api/admin/student/update')).send({ originalEmail: from, email: to, name: 'Ana', classes: [{ name: '1DES', courseId: COURSE_A }], status: 'Ativo' });
        assert.equal(update.status, 200, update.body.error);
    }
    assert.equal((await request(app).post('/api/student/login').send({ email: NEW, password: '123' })).status, 200);
    // Dados gravados por versões antigas, que a troca não renomeava.
    db.memory.auditLogs.push(
        { id: 'legado_antigo', actor: 'admin@notas.local', studentEmail: OLD, action: 'update', field: 'Telefone', oldValue: '(11) 98888-7777', newValue: '(11) 97777-6666', timestamp: 1 },
        { id: 'legado_meio', type: 'exam_question_reported', actor: MIDDLE, applicationId: 'app_1', details: { reportId: 'r_antiga', questionNumber: 1, reason: 'outro' }, timestamp: 2 },
        { id: 'bia_x', actor: 'admin@notas.local', studentEmail: 'bia@notas.local', action: 'update', field: 'Telefone', oldValue: '1', newValue: '2', timestamp: 3 },
    );
    db.memory.attendance = [
        { id: 'p_antiga', studentEmail: OLD, date: '2026-03-01', status: 'presente' },
        { id: 'p_bia', studentEmail: 'bia@notas.local', date: '2026-03-01', status: 'presente' },
    ];
    const biaBefore = JSON.parse(JSON.stringify(db.memory.auditLogs.find(item => item.id === 'bia_x')));
    assert.deepEqual(db.memory.loginLogs.map(item => item.email).sort(), [NEW, OLD].sort());

    const deleted = await admin(request(app).post('/api/admin/delete-student')).send({ email: NEW });
    assert.equal(deleted.status, 200, deleted.body.error);

    const emailPattern = email => new RegExp(`(?<![A-Za-z0-9._%+-])${email.replace(/\./g, '\\.')}(?![A-Za-z0-9_%+-]|\\.[A-Za-z0-9])`, 'i');
    for (const email of [OLD, MIDDLE, NEW]) {
        for (const collection of ['auditLogs', 'loginLogs', 'examApplications', 'attendance', 'students', 'submissions']) {
            assert.equal(emailPattern(email).test(JSON.stringify(db.memory[collection])), false, `${collection} ainda cita ${email}`);
        }
    }
    assert.deepEqual(db.memory.loginLogs, [], 'os logins com o e-mail antigo e com o novo saem');
    const report = db.memory.examApplications[0].questionReports.find(item => item.id === 'r_antiga');
    assert.equal(report.studentEmail, '');
    assert.equal(report.text, '');
    assert.equal(report.questionNumber, 1, 'a contestação continua para o professor revisar a questão');
    const legacy = db.memory.auditLogs.find(item => item.id === 'legado_antigo');
    assert.equal(legacy.studentEmail, '');
    assert.equal(legacy.oldValue, '');
    assert.equal(legacy.studentAnonymized, true);
    assert.equal(db.memory.auditLogs.find(item => item.id === 'legado_meio').actor, 'aluno excluído');
    const changes = db.memory.auditLogs.filter(item => item.field === 'E-mail/login');
    assert.equal(changes.length, 2);
    for (const change of changes) assert.deepEqual([change.studentEmail, change.oldValue, change.newValue], ['', '', '']);
    // A Bia (outra aluna) continua igual.
    assert.deepEqual(db.memory.auditLogs.find(item => item.id === 'bia_x'), biaBefore);
    assert.equal(db.memory.examApplications[0].questionReports.find(item => item.id === 'r_bia').text, 'texto da Bia');
    assert.deepEqual(db.memory.attendance.map(item => item.id), ['p_bia']);
});

test('[UC-NOTAS-004] e-mail antigo que hoje é o login de outro aluno não entra na exclusão', async () => {
    // Ana trocou ana@ → ana.souza@; depois o Carlos se cadastrou com ana@. Excluir a Ana não toca no Carlos.
    const update = await admin(request(app).post('/api/admin/student/update')).send({ originalEmail: 'ana@notas.local', email: 'ana.souza@notas.local', name: 'Ana', classes: [{ name: '1DES', courseId: COURSE_A }], status: 'Ativo' });
    assert.equal(update.status, 200, update.body.error);
    db.memory.students.push({ name: 'Carlos', email: 'ana@notas.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: COURSE_A }] });
    db.memory.loginLogs = [];
    assert.equal((await request(app).post('/api/student/login').send({ email: 'ana@notas.local', password: '123' })).status, 200);
    db.memory.auditLogs.push({ id: 'carlos_x', actor: 'admin@notas.local', studentEmail: 'ana@notas.local', action: 'update', field: 'Telefone', oldValue: '1', newValue: '2', timestamp: 9 });
    db.memory.attendance = [{ id: 'p_carlos', studentEmail: 'ana@notas.local', date: '2026-03-01', status: 'presente' }];
    const carlosBefore = JSON.parse(JSON.stringify({ audit: db.memory.auditLogs.find(item => item.id === 'carlos_x'), logins: db.memory.loginLogs, attendance: db.memory.attendance }));

    assert.equal((await admin(request(app).post('/api/admin/delete-student')).send({ email: 'ana.souza@notas.local' })).status, 200);

    assert.deepEqual({ audit: db.memory.auditLogs.find(item => item.id === 'carlos_x'), logins: db.memory.loginLogs, attendance: db.memory.attendance }, carlosBefore);
    assert.ok(db.memory.students.some(item => item.email === 'ana@notas.local' && item.name === 'Carlos'));
    const change = db.memory.auditLogs.find(item => item.field === 'E-mail/login');
    assert.deepEqual([change.studentEmail, change.oldValue, change.newValue], ['', '', ''], 'a troca de e-mail da Ana (excluída) fica sem os e-mails');
});

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('[UC-NOTAS-004] excluir aluno cadastrado com o e-mail antigo de um aluno vivo não mexe no que o aluno vivo gravou com esse e-mail', async () => {
    // A Ana (viva) usava ana.antiga@, trocou para ana@ e depois a "Bia Nova" foi cadastrada com ana.antiga@.
    const OLD = 'ana.antiga@notas.local';
    const ANA = 'ana@notas.local';
    db.memory.students[0].email = OLD;
    db.memory.students[0].name = 'Ana Teste';
    db.memory.loginLogs = [];
    db.memory.forum = [{
        id: 'c_bia', key: 'geral', studentName: 'Bia', studentEmail: 'bia@notas.local', courseId: COURSE_A, studentClass: '1DES', text: 'dúvida da Bia', timestamp: new Date().toISOString(),
        replies: [], events: [],
    }];
    assert.equal((await request(app).post('/api/student/login').send({ email: OLD, password: '123' })).status, 200);
    const now = Date.now();
    db.memory.examApplications[0].questionReports = [
        { id: 'r_ana', applicationId: 'app_1', questionNumber: 1, studentEmail: OLD, studentName: 'Ana Teste', reason: 'outro', text: 'contestação da Ana', status: 'open', createdAt: new Date(now).toISOString() },
    ];
    db.memory.auditLogs.push(
        { id: 'ana_contesta', type: 'exam_question_reported', actor: OLD, applicationId: 'app_1', details: { reportId: 'r_ana', questionNumber: 1, reason: 'outro' }, timestamp: now },
        { id: 'ana_fim', type: 'exam_application_finished', actor: 'admin@notas.local', applicationId: 'app_1', details: { summary: { students: [OLD, 'bia@notas.local'] } }, timestamp: new Date(now).toISOString() },
    );
    db.memory.forum[0].replies.push({ id: 'reply_ana', authorName: 'Ana Teste', authorRole: 'Aluno', authorEmail: OLD, text: 'resposta da Ana', timestamp: new Date(now).toISOString() });
    db.memory.forum[0].events.push({ type: 'reply', by: OLD, byName: 'Ana Teste', role: 'Aluno', at: new Date(now).toISOString() });
    await pause(5);
    const update = await admin(request(app).post('/api/admin/student/update')).send({ originalEmail: OLD, email: ANA, name: 'Ana Teste', classes: [{ name: '1DES', courseId: COURSE_A }], status: 'Ativo' });
    assert.equal(update.status, 200, update.body.error);
    await pause(5);
    const created = await admin(request(app).post('/api/admin/student/create')).send({ name: 'Bia Nova', email: OLD, studentPassword: '123', classes: [{ name: '1DES', courseId: COURSE_A }] });
    assert.equal(created.status, 200, created.body.error);
    await pause(5);
    assert.equal((await request(app).post('/api/student/login').send({ email: OLD, password: '123' })).status, 200);
    const later = Date.now();
    db.memory.examApplications[0].questionReports.push(
        { id: 'r_nova', applicationId: 'app_1', questionNumber: 2, studentEmail: OLD, studentName: 'Bia Nova', reason: 'outro', text: 'contestação da Bia Nova', status: 'open', createdAt: new Date(later).toISOString() },
    );
    db.memory.auditLogs.push({ id: 'nova_contesta', type: 'exam_question_reported', actor: OLD, applicationId: 'app_1', details: { reportId: 'r_nova', questionNumber: 2, reason: 'outro' }, timestamp: later });
    db.memory.forum[0].replies.push({ id: 'reply_nova', authorName: 'Bia Nova', authorRole: 'Aluno', authorEmail: OLD, text: 'resposta da Bia Nova', timestamp: new Date(later).toISOString() });
    const anaLogin = JSON.parse(JSON.stringify(db.memory.loginLogs.find(item => item.email === OLD && item.timestamp <= now)));
    const before = JSON.parse(JSON.stringify({
        report: db.memory.examApplications[0].questionReports.find(item => item.id === 'r_ana'),
        contesta: db.memory.auditLogs.find(item => item.id === 'ana_contesta'),
        fim: db.memory.auditLogs.find(item => item.id === 'ana_fim'),
        troca: db.memory.auditLogs.find(item => item.field === 'E-mail/login'),
    }));

    const deleted = await admin(request(app).post('/api/admin/delete-student')).send({ email: OLD });
    assert.equal(deleted.status, 200, deleted.body.error);

    // O que a Ana gravou com ana.antiga@ antes da troca continua igual (antes: login apagado,
    // contestação sem nome e texto, autor "aluno excluído", resposta do fórum apagada).
    assert.deepEqual(db.memory.loginLogs, [anaLogin]);
    assert.deepEqual({
        report: db.memory.examApplications[0].questionReports.find(item => item.id === 'r_ana'),
        contesta: db.memory.auditLogs.find(item => item.id === 'ana_contesta'),
        fim: db.memory.auditLogs.find(item => item.id === 'ana_fim'),
        troca: db.memory.auditLogs.find(item => item.field === 'E-mail/login'),
    }, before);
    assert.deepEqual(db.memory.forum[0].replies.map(item => item.id), ['reply_ana']);
    assert.deepEqual(db.memory.forum[0].events.map(item => item.by), [OLD]);
    assert.ok(db.memory.students.some(item => item.email === ANA && item.name === 'Ana Teste'));
    // O que a Bia Nova gravou sai ou fica anônimo.
    const nova = db.memory.examApplications[0].questionReports.find(item => item.id === 'r_nova');
    assert.deepEqual([nova.studentEmail, nova.studentName, nova.text], ['', 'Aluno excluído', '']);
    assert.equal(db.memory.auditLogs.find(item => item.id === 'nova_contesta').actor, 'aluno excluído');
    const novaCriada = db.memory.auditLogs.find(item => item.action === 'create' && item.field === 'Cadastro');
    assert.equal(novaCriada.studentEmail, '');
    assert.equal(db.memory.students.some(item => item.name === 'Bia Nova'), false);
});

test('[UC-NOTAS-004] excluir o aluno tira o e-mail dele também das chaves dos objetos guardados na auditoria (liberação individual da turma)', async () => {
    db.memory.classes[0].releasedItems = {};
    const released = await admin(request(app).post('/api/admin/release-item')).send({ studentClass: '1DES', courseId: COURSE_A, itemKey: 'Avaliacao_P2', released: true, studentEmail: 'ana@notas.local' });
    assert.equal(released.status, 200, released.body.error);
    db.memory.classes[0].studentReleasedItems['bia@notas.local'] = { Avaliacao_P2: true };
    const updated = await admin(request(app).post('/api/admin/class/update')).send({ name: '1DES', courseId: COURSE_A, period: 'Tarde' });
    assert.equal(updated.status, 200, updated.body.error);
    const snapshot = db.memory.auditLogs.find(item => item.type === 'class_updated');
    assert.ok(snapshot.after.studentReleasedItems['ana@notas.local'], 'a turma inteira vai para o "depois" da auditoria');

    assert.equal((await admin(request(app).post('/api/admin/delete-student')).send({ email: 'ana@notas.local' })).status, 200);

    const after = db.memory.auditLogs.find(item => item.id === snapshot.id);
    for (const side of ['before', 'after']) {
        const keys = Object.keys(after[side].studentReleasedItems);
        assert.equal(keys.includes('ana@notas.local'), false, `${side} ainda tem a chave com o e-mail`);
    }
    assert.deepEqual(after.after.studentReleasedItems, { 'aluno excluído': { Avaliacao_P2: true }, 'bia@notas.local': { Avaliacao_P2: true } });
    assert.equal(/ana@notas\.local/i.test(JSON.stringify(db.memory.auditLogs)), false);
    assert.equal(/ana@notas\.local/i.test(JSON.stringify(db.memory.classes)), false);
    assert.equal(after.actorEmail, 'admin@notas.local');
});

test('[UC-NOTAS-004] conta de aluno com o e-mail de um professor: excluí-la não leva a autoria do professor', async () => {
    const PROF = 'prof@notas.local';
    const created = await admin(request(app).post('/api/admin/student/create')).send({ name: 'Conta Teste', email: PROF, studentPassword: '123', classes: [{ name: '1DES', courseId: COURSE_A }] });
    assert.equal(created.status, 200, created.body.error);
    db.memory.auditLogs.push(
        { id: 'prof_prova', type: 'exam_application_finished', actor: PROF, applicationId: 'app_1', details: { summary: { finishedBy: PROF } }, timestamp: Date.now() },
        { id: 'prof_turma', type: 'class_updated', actorEmail: PROF, target: { courseId: COURSE_A, className: '1DES' }, before: { name: '1DES' }, after: { name: '1DES', period: 'Tarde' }, at: Date.now() },
    );
    db.memory.loginLogs = [{ id: 'l_prof', email: PROF, role: 'admin', status: 'success', timestamp: Date.now() }, { id: 'l_conta', email: PROF, role: 'student', status: 'success', timestamp: Date.now() }];
    db.memory.forum = [{
        id: 'c_bia', key: 'geral', studentName: 'Bia', studentEmail: 'bia@notas.local', courseId: COURSE_A, studentClass: '1DES', text: 'dúvida', timestamp: new Date().toISOString(),
        replies: [{ id: 'reply_prof', authorName: 'Professor', authorRole: 'Instrutor', authorEmail: PROF, text: 'resposta do professor', timestamp: new Date().toISOString() }],
        events: [{ type: 'reply', by: PROF, byName: 'Professor', role: 'Instrutor', at: new Date().toISOString() }],
    }];
    const before = JSON.parse(JSON.stringify({ prova: db.memory.auditLogs.find(item => item.id === 'prof_prova'), turma: db.memory.auditLogs.find(item => item.id === 'prof_turma'), forum: db.memory.forum }));

    assert.equal((await admin(request(app).post('/api/admin/delete-student')).send({ email: PROF })).status, 200);

    assert.deepEqual({ prova: db.memory.auditLogs.find(item => item.id === 'prof_prova'), turma: db.memory.auditLogs.find(item => item.id === 'prof_turma'), forum: db.memory.forum }, before);
    assert.deepEqual(db.memory.loginLogs.map(item => item.id), ['l_prof'], 'o login do professor fica; o da conta de aluno sai');
    const criada = db.memory.auditLogs.find(item => item.action === 'create' && item.field === 'Cadastro');
    assert.equal(criada.studentEmail, '', 'a entrada da conta de aluno perde o e-mail');
    assert.equal(criada.actor, 'admin@notas.local');
    assert.ok(db.memory.admins.some(item => item.email === PROF));
});

test('[UC-NOTAS-004] dúvida do aluno excluído com resposta de outra aluna fica sem nome e texto, com a resposta da outra; sem resposta de outros, sai', async () => {
    const t = new Date().toISOString();
    db.memory.forum = [
        {
            id: 'c_ana', key: 'geral', studentName: 'Ana', studentEmail: 'ana@notas.local', courseId: COURSE_A, studentClass: '1DES', text: 'Sou a Ana, telefone 11 99999-0000', timestamp: t,
            replies: [
                { id: 'r_bia', authorName: 'Bia', authorRole: 'Aluno', authorEmail: 'bia@notas.local', text: 'resposta da Bia na dúvida da Ana', timestamp: t },
                { id: 'r_ana', authorName: 'Ana', authorRole: 'Aluno', authorEmail: 'ana@notas.local', text: 'obrigada', timestamp: t },
            ],
            events: [{ type: 'reply', by: 'bia@notas.local', byName: 'Bia', role: 'Aluno', at: t }, { type: 'reply', by: 'ana@notas.local', byName: 'Ana', role: 'Aluno', at: t }],
        },
        { id: 'c_ana_sozinha', key: 'geral', studentName: 'Ana', studentEmail: 'ana@notas.local', courseId: COURSE_A, studentClass: '1DES', text: 'outra dúvida', timestamp: t, replies: [{ id: 'r_ana_2', authorName: 'Ana', authorRole: 'Aluno', authorEmail: 'ana@notas.local', text: 'esqueci', timestamp: t }] },
    ];
    const biaReply = JSON.parse(JSON.stringify(db.memory.forum[0].replies[0]));

    assert.equal((await admin(request(app).post('/api/admin/delete-student')).send({ email: 'ana@notas.local' })).status, 200);

    assert.deepEqual(db.memory.forum.map(item => item.id), ['c_ana'], 'a dúvida sem resposta de outros sai');
    const kept = db.memory.forum[0];
    assert.deepEqual(kept.replies, [biaReply], 'a resposta da Bia continua igual');
    assert.equal(kept.studentEmail, '');
    assert.equal(kept.studentName, 'Aluno excluído');
    assert.doesNotMatch(kept.text, /Ana|99999/);
    assert.deepEqual(kept.events.map(item => item.by), ['bia@notas.local', 'aluno excluído']);
    assert.equal(/ana@notas\.local/i.test(JSON.stringify(db.memory.forum)), false);
});

test('[UC-NOTAS-004] homônimos sem matrícula: excluir um não manda para a lixeira os documentos do outro', async () => {
    const runtimePaths = require('../../backend/runtimePaths.js');
    db.memory.students.push(
        { name: 'Carlos Lima', email: 'carlos.1des@notas.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: COURSE_A }] },
        { name: 'Carlos Lima', email: 'carlos.2red@notas.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '2RED', courseId: COURSE_B }] },
    );
    const pdf = name => Buffer.from(`%PDF-1.4\n% ${name}\n%%EOF\n`);
    const upload = async (email, name) => {
        const res = await admin(request(app).post('/api/admin/attendance/justification-upload')).field('studentEmail', email).attach('file', pdf(name), `${name}.pdf`);
        assert.equal(res.status, 200, res.body.error);
        return res.body.file;
    };
    const fileA = await upload('carlos.1des@notas.local', 'atestado-1des');
    const fileB = await upload('carlos.2red@notas.local', 'atestado-2red');
    assert.equal(path.dirname(fileA), path.dirname(fileB), 'os dois caem na mesma pasta (matrícula + nome)');
    db.memory.attendance = [{ id: 'p_b', studentEmail: 'carlos.2red@notas.local', studentClass: '2RED', courseId: COURSE_B, date: '2026-03-02', aulas: [], justificativa: { tipo: 'atestado', arquivo: fileB, arquivoNome: 'atestado-2red.pdf' } }];

    assert.equal((await admin(request(app).post('/api/admin/delete-student')).send({ email: 'carlos.2red@notas.local' })).status, 200);

    assert.ok(fs.existsSync(path.join(runtimePaths.DATA_DIR, fileA)), 'o atestado do Carlos vivo continua na pasta');
    assert.equal(fs.existsSync(path.join(runtimePaths.DATA_DIR, fileB)), false, 'o do Carlos excluído vai para a lixeira');
    const served = await admin(request(app).get('/api/admin/attendance/justification-file')).query({ studentEmail: 'carlos.1des@notas.local', file: fileA });
    assert.equal(served.status, 200);
    const trash = fs.readdirSync(runtimePaths.TRASH_DIR).filter(name => name !== '_index.json');
    assert.ok(trash.some(name => name.endsWith('atestado-2red.pdf')), trash.join(', '));
});

test('[UC-NOTAS-004] e-mail antigo que hoje é o login de outro aluno: o que é da época do aluno excluído sai, o do outro aluno fica', async () => {
    // Ana usava ana@, trocou para ana.souza@ e depois o Carlos foi cadastrado (com data) com ana@.
    db.memory.loginLogs = [];
    assert.equal((await request(app).post('/api/student/login').send({ email: 'ana@notas.local', password: '123' })).status, 200);
    db.memory.examApplications[0].questionReports = [{ id: 'r_ana', applicationId: 'app_1', questionNumber: 1, studentEmail: 'ana@notas.local', studentName: 'Ana', reason: 'outro', text: 'texto da Ana', status: 'open', createdAt: new Date().toISOString() }];
    await pause(5);
    const update = await admin(request(app).post('/api/admin/student/update')).send({ originalEmail: 'ana@notas.local', email: 'ana.souza@notas.local', name: 'Ana', classes: [{ name: '1DES', courseId: COURSE_A }], status: 'Ativo' });
    assert.equal(update.status, 200, update.body.error);
    await pause(5);
    const created = await admin(request(app).post('/api/admin/student/create')).send({ name: 'Carlos', email: 'ana@notas.local', studentPassword: '123', classes: [{ name: '1DES', courseId: COURSE_A }] });
    assert.equal(created.status, 200, created.body.error);
    await pause(5);
    assert.equal((await request(app).post('/api/student/login').send({ email: 'ana@notas.local', password: '123' })).status, 200);
    db.memory.examApplications[0].questionReports.push({ id: 'r_carlos', applicationId: 'app_1', questionNumber: 2, studentEmail: 'ana@notas.local', studentName: 'Carlos', reason: 'outro', text: 'texto do Carlos', status: 'open', createdAt: new Date().toISOString() });
    const carlosLogin = JSON.parse(JSON.stringify(db.memory.loginLogs[1]));
    const carlosReport = JSON.parse(JSON.stringify(db.memory.examApplications[0].questionReports[1]));

    assert.equal((await admin(request(app).post('/api/admin/delete-student')).send({ email: 'ana.souza@notas.local' })).status, 200);

    assert.deepEqual(db.memory.loginLogs, [carlosLogin], 'o login da Ana com ana@ (antes do Carlos) sai; o do Carlos fica');
    assert.equal(db.memory.examApplications[0].questionReports[0].text, '', 'a contestação da Ana com ana@ fica anônima');
    assert.deepEqual(db.memory.examApplications[0].questionReports[1], carlosReport);
    assert.ok(db.memory.students.some(item => item.email === 'ana@notas.local' && item.name === 'Carlos'));
});

// Cenário do revisor: a Joana largou aluno05@ (trocou para joana@) e depois a Ana passou
// a usar aluno05@. A troca da Ana renomeou para aluno05@ os registros dela de janeiro,
// época em que o e-mail ainda era da Joana.
async function emailSwapScenario() {
    const T0 = Date.parse('2026-01-01T10:00:00Z');
    const JAN = '2026-01-15T10:00:00.000Z';
    const T1 = Date.parse('2026-02-01T10:00:00Z');
    const T3 = Date.parse('2026-03-01T10:00:00Z');
    db.memory.students = [
        { name: 'Ana Souza', email: 'ana@notas.local', matricula: 'MAT-1', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: COURSE_A }], studentClass: '1DES', createdAt: T0 },
        { name: 'Joana Lima', email: 'aluno05@notas.local', matricula: 'MAT-2', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: COURSE_A }], studentClass: '1DES', createdAt: T0 },
    ];
    db.memory.attendance = [
        { id: 'att_ana', studentEmail: 'ana@notas.local', date: JAN.slice(0, 10), status: 'falta', justificativa: { texto: 'atestado da Ana' } },
        { id: 'att_joana', studentEmail: 'aluno05@notas.local', date: '2026-01-10', status: 'presente' },
    ];
    db.memory.pedagogicalObservations = [
        { id: 'obs_ana', studentEmail: 'ana@notas.local', text: 'Ana tem dificuldade', createdAt: JAN },
        { id: 'obs_joana', studentEmail: 'aluno05@notas.local', text: 'Joana participa', createdAt: '2026-01-10T10:00:00.000Z' },
    ];
    db.memory.submissions = [
        submission('sub_ana', { email: 'ana@notas.local', name: 'Ana Souza', score: 70, timestamp: JAN }),
        submission('sub_joana', { email: 'aluno05@notas.local', name: 'Joana Lima', score: 90, timestamp: '2026-01-10T10:00:00.000Z' }),
    ];
    db.memory.forum = [
        { id: 'comment_ana', key: 'u1', studentEmail: 'ana@notas.local', studentName: 'Ana Souza', courseId: COURSE_A, studentClass: '1DES', text: 'Meu telefone é 99999', timestamp: JAN, replies: [] },
        { id: 'comment_joana', key: 'u1', studentEmail: 'aluno05@notas.local', studentName: 'Joana Lima', courseId: COURSE_A, studentClass: '1DES', text: 'dúvida da Joana', timestamp: '2026-01-10T10:00:00.000Z', replies: [] },
    ];
    db.memory.progress = { 'ana@notas.local': { u1: true }, 'aluno05@notas.local': { u2: true } };
    db.memory.auditLogs = [
        { id: 'audit_ana_jan', actor: 'admin@notas.local', studentEmail: 'ana@notas.local', action: 'update', field: 'Telefone', oldValue: '(11) 1111', newValue: '(11) 2222', timestamp: Date.parse(JAN) },
        { id: 'audit_joana_jan', actor: 'admin@notas.local', studentEmail: 'aluno05@notas.local', action: 'update', field: 'Telefone', oldValue: '(21) 1111', newValue: '(21) 2222', timestamp: Date.parse('2026-01-10T10:00:00.000Z') },
    ];
    // O log de login não é renomeado na troca: o de janeiro com aluno05@ é da Joana.
    db.memory.loginLogs = [
        { id: 'login_joana_jan', email: 'aluno05@notas.local', role: 'student', timestamp: '2026-01-12T10:00:00.000Z' },
        { id: 'login_ana_mar', email: 'aluno05@notas.local', role: 'student', timestamp: '2026-03-05T10:00:00.000Z' },
    ];
    const swap = async (from, to, name, matricula, when) => {
        const response = await admin(request(app).post('/api/admin/student/update')).send({ originalEmail: from, email: to, name, matricula, classes: [{ name: '1DES', courseId: COURSE_A }], status: 'Ativo' });
        assert.equal(response.status, 200, response.body.error);
        db.memory.auditLogs.filter(entry => entry.field === 'E-mail/login' && entry.newValue === to).forEach(entry => { entry.timestamp = when; });
    };
    await swap('aluno05@notas.local', 'joana@notas.local', 'Joana Lima', 'MAT-2', T1);
    await swap('ana@notas.local', 'aluno05@notas.local', 'Ana Souza', 'MAT-1', T3);
    assert.equal(db.memory.attendance.find(item => item.id === 'att_ana').studentEmail, 'aluno05@notas.local');
    assert.equal(db.memory.attendance.find(item => item.id === 'att_joana').studentEmail, 'joana@notas.local');
}

test('[UC-NOTAS-004] excluir a aluna que passou a usar o e-mail largado por outra apaga tudo dela, mesmo o que tem data da época da outra', async () => {
    await emailSwapScenario();
    const joanaBefore = JSON.parse(JSON.stringify({
        attendance: db.memory.attendance.filter(item => item.studentEmail === 'joana@notas.local'),
        observations: db.memory.pedagogicalObservations.filter(item => item.studentEmail === 'joana@notas.local'),
        submissions: db.memory.submissions.filter(item => item.student.email === 'joana@notas.local'),
        forum: db.memory.forum.filter(item => item.studentEmail === 'joana@notas.local'),
        audit: db.memory.auditLogs.filter(item => item.studentEmail === 'joana@notas.local'),
        progress: db.memory.progress['joana@notas.local'],
    }));

    const deleted = await admin(request(app).post('/api/admin/delete-student')).send({ email: 'aluno05@notas.local' });
    assert.equal(deleted.status, 200, deleted.body.error);

    // Antes: presença, observação, nota e dúvida de janeiro da Ana ficavam com aluno05@
    // (a data caía na época da Joana) e a auditoria dela continuava com o telefone.
    assert.deepEqual(db.memory.attendance.map(item => item.id), ['att_joana']);
    assert.deepEqual(db.memory.pedagogicalObservations.map(item => item.id), ['obs_joana']);
    assert.deepEqual(db.memory.submissions.map(item => item.id), ['sub_joana']);
    assert.deepEqual(db.memory.forum.map(item => item.id), ['comment_joana']);
    assert.equal(db.memory.progress['aluno05@notas.local'], undefined);
    const anaAudit = db.memory.auditLogs.find(item => item.id === 'audit_ana_jan');
    assert.deepEqual([anaAudit.studentEmail, anaAudit.oldValue, anaAudit.newValue, anaAudit.studentAnonymized], ['', '', '', true]);
    // O login de janeiro com aluno05@ é da Joana (logins não são renomeados); o de março, da Ana.
    assert.deepEqual(db.memory.loginLogs.map(item => item.id), ['login_joana_jan']);
    // Nada da Joana mudou.
    assert.deepEqual({
        attendance: db.memory.attendance.filter(item => item.studentEmail === 'joana@notas.local'),
        observations: db.memory.pedagogicalObservations.filter(item => item.studentEmail === 'joana@notas.local'),
        submissions: db.memory.submissions.filter(item => item.student.email === 'joana@notas.local'),
        forum: db.memory.forum.filter(item => item.studentEmail === 'joana@notas.local'),
        audit: db.memory.auditLogs.filter(item => item.studentEmail === 'joana@notas.local'),
        progress: db.memory.progress['joana@notas.local'],
    }, joanaBefore);

    // Nova conta com o e-mail liberado não herda nada da Ana.
    const created = await admin(request(app).post('/api/admin/student/create')).send({ name: 'Carla Nova', email: 'aluno05@notas.local', studentPassword: '12345', classes: [{ name: '1DES', courseId: COURSE_A }] });
    assert.equal(created.status, 200, created.body.error);
    const query = '?email=aluno05%40notas.local';
    assert.deepEqual((await admin(request(app).get(`/api/admin/student/observations${query}`))).body, []);
    assert.deepEqual((await admin(request(app).get(`/api/admin/student/attendance${query}`))).body.days, {});
    assert.deepEqual((await admin(request(app).get(`/api/admin/student/audit${query}`))).body.map(item => item.field), ['Cadastro']);
});

test('[UC-NOTAS-004] excluir a aluna que largou o e-mail não leva os registros renomeados da que passou a usá-lo', async () => {
    await emailSwapScenario();
    const anaBefore = JSON.parse(JSON.stringify({
        attendance: db.memory.attendance.filter(item => item.studentEmail === 'aluno05@notas.local'),
        observations: db.memory.pedagogicalObservations.filter(item => item.studentEmail === 'aluno05@notas.local'),
        submissions: db.memory.submissions.filter(item => item.student.email === 'aluno05@notas.local'),
        forum: db.memory.forum.filter(item => item.studentEmail === 'aluno05@notas.local'),
        audit: db.memory.auditLogs.filter(item => item.studentEmail === 'aluno05@notas.local'),
        progress: db.memory.progress['aluno05@notas.local'],
    }));
    assert.equal(anaBefore.attendance.length, 1);

    const deleted = await admin(request(app).post('/api/admin/delete-student')).send({ email: 'joana@notas.local' });
    assert.equal(deleted.status, 200, deleted.body.error);

    // A presença de janeiro com aluno05@ é da Ana (renomeada na troca dela), mesmo com
    // data da época em que o e-mail era da Joana.
    assert.deepEqual({
        attendance: db.memory.attendance.filter(item => item.studentEmail === 'aluno05@notas.local'),
        observations: db.memory.pedagogicalObservations.filter(item => item.studentEmail === 'aluno05@notas.local'),
        submissions: db.memory.submissions.filter(item => item.student.email === 'aluno05@notas.local'),
        forum: db.memory.forum.filter(item => item.studentEmail === 'aluno05@notas.local'),
        audit: db.memory.auditLogs.filter(item => item.studentEmail === 'aluno05@notas.local'),
        progress: db.memory.progress['aluno05@notas.local'],
    }, anaBefore);
    // O que é da Joana sai: os registros renomeados para joana@ e o login dela de janeiro.
    assert.deepEqual(db.memory.attendance.map(item => item.id), ['att_ana']);
    assert.deepEqual(db.memory.submissions.map(item => item.id), ['sub_ana']);
    assert.deepEqual(db.memory.loginLogs.map(item => item.id), ['login_ana_mar']);
    assert.equal(db.memory.auditLogs.find(item => item.id === 'audit_joana_jan').studentEmail, '');
});

test('[UC-NOTAS-004] excluir o aluno não tira nome e matrícula de identificadores e datas da auditoria (só do texto livre)', async () => {
    db.memory.students[0].matricula = '2026';
    db.memory.students[0].name = 'Ana';
    db.memory.auditLogs = [{
        id: 'grade_ana', category: 'grade', action: 'grade_updated', actor: 'admin@notas.local', studentEmail: 'ana@notas.local',
        examKey: 'Avaliacao_Ana', applicationId: 'app_2026', timestamp: '2026-03-01T10:00:00.000Z', date: '2026-03-02',
        details: { submissionId: 'sub_2026_Ana', attemptId: 'att_Ana_2026', startedAt: '2026-03-01T09:00:00.000Z', reason: 'Ana (matrícula 2026) pediu revisão' },
    }];
    const deleted = await admin(request(app).post('/api/admin/delete-student')).send({ email: 'ana@notas.local' });
    assert.equal(deleted.status, 200, deleted.body.error);
    const entry = db.memory.auditLogs.find(item => item.id === 'grade_ana');
    // Antes: "2026-03-01" virava "-03-01", "Avaliacao_Ana" virava "Avaliacao_Aluno excluído".
    assert.deepEqual(
        [entry.examKey, entry.applicationId, entry.timestamp, entry.date, entry.details.submissionId, entry.details.attemptId, entry.details.startedAt],
        ['Avaliacao_Ana', 'app_2026', '2026-03-01T10:00:00.000Z', '2026-03-02', 'sub_2026_Ana', 'att_Ana_2026', '2026-03-01T09:00:00.000Z'],
    );
    assert.equal(/\d{4}-\d{2}-\d{2}T/.test(entry.anonymizedAt), true, 'anonymizedAt fica uma data inteira');
    assert.equal(entry.details.reason, 'Aluno excluído (matrícula ) pediu revisão', 'o texto livre perde nome e matrícula');
    assert.equal(entry.studentEmail, '');
});
