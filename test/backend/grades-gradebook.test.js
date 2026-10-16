// Regressões do grupo G5 (fase 1): lançamento manual de nota validado, auditoria
// das alterações de nota, exportação de notas e boletim igual à tela Resultados.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

// Média da tela Resultados: consolida por grupo (aluno+curso+turma+aplicação) e tira a média dos grupos.
function resultadosAverage(rows, email) {
    const groups = new Map();
    rows.filter(row => row.student.email === email).forEach(row => {
        const key = `${row.student.courseId}::${row.student.studentClass}::${row.applicationId || `legacy-exam:${row.examKey}`}`;
        if (row.consolidatedScore != null) groups.set(key, row.consolidatedScore);
    });
    const scores = [...groups.values()];
    return scores.length ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length) / 10 : null;
}

function parseCsv(text) {
    assert.equal(text.charCodeAt(0), 0xFEFF, 'CSV começa com BOM UTF-8 para o Excel');
    return text.slice(1).trim().split(/\r\n/).map(line => line.split(';'));
}

test.before(async () => { await db.init(); app = createApp(); });
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
    assert.equal(again.body.overallAverage, resultadosAverage(list.body, 'ana@notas.local'));
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
    assert.equal(ana.average, resultadosAverage(list.body, 'ana@notas.local'));
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
