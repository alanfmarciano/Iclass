// Professor auxiliar (papel 'monitor') sem notas: pendência da J0 da fase 3, fechada no B1.
//
// O contrato (shared_contracts.rbac.papeis do plano) diz que o professor auxiliar faz
// chamada e usa o Monitor, sem notas, provas, conteúdo e mensagens. Ele já não mudava nota
// (admin-roles-matrix.test.js), mas LIA notas pelas rotas que pedem só page.students,
// page.dashboard ou page.monitor:
// - ficha do aluno (/student/report, /student/academic, /student/dashboard);
// - resumo dos alunos e tendências do Dashboard (/dashboard/students-overview e
//   /dashboard/trends, com a média de notas da turma);
// - revisão da prova no Monitor (/monitor-review/:class/:examKey, com as respostas do
//   aluno, o gabarito e o acerto de cada questão).
// Agora quem não lê nota (canReadStudentGrades: sem page.results nem reports.view) recebe
// essas rotas sem a nota (gradesHidden: true, média null, lista de provas vazia) e a
// revisão do Monitor responde 403 grades_hidden; a lista do Monitor continua com ele.
//
// O papel continua oculto na criação de conta (decisão do plano: "Professor auxiliar fica
// escondido"). A parte de baixo segura que a API também não cria conta com ele nem troca
// outra conta para ele.
//
// Ajuste do B1: o Monitor precisa da lista das aplicações, da ação da aplicação (iniciar,
// pausar, encerrar) e do resumo do encerramento, que pediam page.exams; o auxiliar não
// conseguia escolher prova nenhuma. Agora essas três aceitam page.monitor e a lista vem
// sempre resumida para ele (sem as versões, que levam o gabarito). A fila do Dashboard
// deixa de oferecer pendência de tela que a conta não abre (Resultados, Fórum).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-auxiliar-notas-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { findAdminRole } = require('../../backend/utils/adminRoles.js');
const { canReadStudentGrades, roleGrantablePermissions } = require('../../backend/utils/adminPermissions.js');
const { createExamApplication } = require('../../backend/utils/examApplications.js');

const COURSE = 'curso_a';
const TOKENS = { admin: 'tok-aux-admin', professor: 'tok-aux-prof', monitor: 'tok-aux-monitor' };
const EMAILS = { admin: 'admin@auxiliar.local', professor: 'prof@auxiliar.local', monitor: 'aux@auxiliar.local' };
const STUDENT = 'ana@auxiliar.local';

let app;

function seed() {
    const turma = [{ courseId: COURSE, className: '1A' }];
    db.memory.admins = [
        { email: EMAILS.admin, name: 'Admin', role: 'admin', password: db.hashPassword('x') },
        { email: EMAILS.professor, name: 'Prof', role: 'professor', password: db.hashPassword('x'), assignedClasses: turma },
        // Conta com o papel oculto (gravada antes ou vinda de backup): é o que o Alan teria.
        { email: EMAILS.monitor, name: 'Auxiliar', role: 'monitor', password: db.hashPassword('x'), assignedClasses: turma },
    ];
    const now = Date.now();
    db.memory.adminSessions = Object.fromEntries(Object.entries(TOKENS)
        .map(([who, token]) => [token, { email: EMAILS[who], createdAt: now, lastSeen: now }]));
    db.memory.courses = [{ id: COURSE, name: 'Curso A', structure: [
        { id: 'm1', name: 'Módulo 1', units: [{ key: 'u1', name: 'Prova 1', avaliacaoKey: 'Avaliacao_P1' }] },
    ] }];
    db.memory.classes = [{ name: '1A', courseId: COURSE, onlineExamConfigs: {} }];
    db.memory.students = [
        { name: 'Ana', email: STUDENT, status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1A', courseId: COURSE }] },
        // Bia tirou 2,0: para o professor, risco médio pela nota; sem nota, o risco não sobe.
        { name: 'Bia', email: 'bia@auxiliar.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1A', courseId: COURSE }] },
    ];
    db.memory.evaluations = { Avaliacao_P1: { title: 'Prova 1', questions: [{ originalNumber: 1, text: 'Q1', correctAnswer: 'A', alternatives: [{ letter: 'A', text: 'a' }, { letter: 'B', text: 'b' }] }] } };
    // Nota de dois dias atrás: entra na média da ficha, do resumo e da janela de 30 dias.
    const recent = new Date(now - 2 * 24 * 3600 * 1000).toISOString();
    db.memory.submissions = [{
        id: 'sub_ana_p1', student: { name: 'Ana', email: STUDENT, courseId: COURSE, studentClass: '1A' },
        examKey: 'Avaliacao_P1', applicationId: null, score: 80, correctCount: 1, totalCount: 1,
        gradedAnswers: [{ originalNumber: 1, chosen: 'A', correct: 'A', isCorrect: true }],
        type: 'impressa', attemptNumber: 1, resultStatus: 'considered', aggregationPolicy: 'highest',
        selectedForResult: false, gradePublished: true, timestamp: recent,
    }, {
        id: 'sub_bia_p1', student: { name: 'Bia', email: 'bia@auxiliar.local', courseId: COURSE, studentClass: '1A' },
        examKey: 'Avaliacao_P1', applicationId: null, score: 20, correctCount: 0, totalCount: 1, gradedAnswers: [],
        type: 'impressa', attemptNumber: 1, resultStatus: 'considered', aggregationPolicy: 'highest',
        selectedForResult: false, gradePublished: true, timestamp: recent,
    }];
    db.memory.examApplications = [];
    db.memory.studentExamState = {};
    db.memory.attendance = [];
    db.memory.progress = {};
    db.memory.auditLogs = [];
}

const as = (who, req) => req.set('x-admin-session', TOKENS[who]);
const get = (who, url) => as(who, request(app).get(url));
const qs = `email=${encodeURIComponent(STUDENT)}&courseId=${COURSE}&studentClass=1A`;

test.before(async () => {
    await db.init();
    app = createApp();
    seed();
});

test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-PAPEIS-001] quem lê nota: administrador e professor sim; professor auxiliar não, nem com os extras que o papel aceita', () => {
    assert.equal(canReadStudentGrades({ role: 'admin' }), true);
    assert.equal(canReadStudentGrades({ role: 'professor' }), true);
    assert.equal(canReadStudentGrades({ role: 'monitor' }), false);
    assert.equal(canReadStudentGrades({ role: 'monitor', additionalPermissions: roleGrantablePermissions('monitor') }), false);
    // A coordenação consulta relatório (reports.view): lê nota, sem mudar.
    assert.equal(canReadStudentGrades({ role: 'coordenacao' }), findAdminRole('coordenacao').permissoesPadrao.some(p => ['page.results', 'reports.view'].includes(p)));
});

test('[UC-PAPEIS-001] ficha do aluno: o professor vê a nota; o professor auxiliar recebe a ficha sem nota (gradesHidden)', async () => {
    const academicProf = await get('professor', `/api/admin/student/academic?${qs}`).expect(200);
    assert.equal(academicProf.body.submissions.length, 1);
    assert.equal(academicProf.body.submissions[0].score, 80, 'nota na escala da entrega (0 a 100)');
    assert.equal(academicProf.body.gradesHidden, undefined);
    const academicAux = await get('monitor', `/api/admin/student/academic?${qs}`).expect(200);
    assert.deepEqual(academicAux.body.submissions, []);
    assert.equal(academicAux.body.gradesHidden, true);
    assert.ok(academicAux.body.attendance && academicAux.body.progress, 'presença e progresso continuam');

    const reportProf = await get('professor', `/api/admin/student/report?${qs}`).expect(200);
    assert.equal(reportProf.body.overallAverage, 8);
    assert.ok(reportProf.body.modules.length > 0);
    const reportAux = await get('monitor', `/api/admin/student/report?${qs}`).expect(200);
    assert.deepEqual([reportAux.body.modules, reportAux.body.overallAverage, reportAux.body.gradesHidden], [[], null, true]);
    assert.ok(reportAux.body.attendance, 'a frequência continua no boletim');
    assert.doesNotMatch(JSON.stringify(reportAux.body), /"score"|Avaliacao_P1/);

    const dashProf = await get('professor', `/api/admin/student/dashboard?${qs}`).expect(200);
    assert.equal(dashProf.body.kpis.media, 8);
    const dashAux = await get('monitor', `/api/admin/student/dashboard?${qs}`).expect(200);
    assert.equal(dashAux.body.gradesHidden, true);
    assert.equal(dashAux.body.kpis.media, null);
    assert.equal(dashAux.body.comparativo.studentMedia ?? null, null);
    assert.equal(dashAux.body.comparativo.turmaMedia ?? null, null);
    assert.doesNotMatch(JSON.stringify(dashAux.body), /"score"|"nota":\s*\d/);
});

test('[UC-PAPEIS-001] Dashboard: resumo dos alunos e tendências sem a média para o professor auxiliar', async () => {
    const overviewProf = await get('professor', `/api/admin/dashboard/students-overview?courseId=${COURSE}&studentClass=1A`).expect(200);
    assert.equal(overviewProf.body.find(row => row.email === STUDENT).media, 8);
    const overviewAux = await get('monitor', `/api/admin/dashboard/students-overview?courseId=${COURSE}&studentClass=1A`).expect(200);
    const row = overviewAux.body.find(item => item.email === STUDENT);
    assert.ok(row, 'o aluno da turma aparece');
    assert.equal(row.media, null);
    assert.equal(overviewAux.body.every(item => item.media === null), true);
    // Risco: a nota baixa de Bia pesa para o professor e não aparece pelo risco ao auxiliar.
    assert.equal(overviewProf.body.find(item => item.email === 'bia@auxiliar.local').riscoLevel, 'medio');
    assert.equal(overviewAux.body.find(item => item.email === 'bia@auxiliar.local').riscoLevel, 'baixo');

    const trendsProf = await get('professor', `/api/admin/dashboard/trends?courseId=${COURSE}&studentClass=1A`).expect(200);
    assert.equal(trendsProf.body.media.atual, 5, 'média da turma: (8,0 + 2,0) / 2');
    assert.equal(trendsProf.body.media.base.provas, 2);
    const trendsAux = await get('monitor', `/api/admin/dashboard/trends?courseId=${COURSE}&studentClass=1A`).expect(200);
    assert.equal(trendsAux.body.gradesHidden, true);
    assert.deepEqual([trendsAux.body.media.atual, trendsAux.body.media.anterior, trendsAux.body.media.base.provas], [null, null, 0]);
    assert.equal(trendsAux.body.media.serie.every(point => point.valor == null), true);
    assert.ok(trendsAux.body.frequencia, 'a frequência continua');
});

test('[UC-PAPEIS-001] Monitor: a revisão da prova (respostas, gabarito e acerto) responde 403 grades_hidden ao professor auxiliar', async () => {
    const url = `/api/admin/monitor-review/1A/Avaliacao_P1?courseId=${COURSE}&studentEmail=${encodeURIComponent(STUDENT)}`;
    const aux = await get('monitor', url);
    assert.equal(aux.status, 403);
    assert.equal(aux.body.code, 'grades_hidden');
    assert.match(aux.body.error, /não vê as respostas corrigidas/);
    const prof = await get('professor', url);
    assert.notEqual(prof.body.code, 'grades_hidden');
    assert.notEqual(prof.status, 403, JSON.stringify(prof.body));
    // A lista do Monitor (quem está fazendo a prova) continua com ele.
    const status = await get('monitor', `/api/admin/monitor-status/1A/Avaliacao_P1?courseId=${COURSE}`);
    assert.notEqual(status.status, 403, JSON.stringify(status.body));
});

test('[UC-PAPEIS-001] o papel continua oculto: a API não cria conta com ele nem troca outra conta para ele', async () => {
    assert.equal(findAdminRole('monitor').oculto, true);
    const created = await as('admin', request(app).post('/api/admin/accounts/create')).send({
        name: 'Auxiliar novo', email: 'aux2@auxiliar.local', password: 'Senha-forte-2026-x', requirePasswordChange: false,
        role: 'monitor', assignedClasses: [{ courseId: COURSE, className: '1A' }],
    });
    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(db.memory.admins.some(item => item.email === 'aux2@auxiliar.local'), false);
    const changed = await as('admin', request(app).post('/api/admin/accounts/update')).send({ email: EMAILS.professor, role: 'monitor' });
    assert.equal(changed.status, 400, JSON.stringify(changed.body));
    assert.equal(db.memory.admins.find(item => item.email === EMAILS.professor).role, 'professor');
});

test('[UC-PAPEIS-001] Monitor: o professor auxiliar escolhe a prova (lista resumida, sem gabarito), pausa, retoma e vê o resumo do encerramento', async () => {
    const application = createExamApplication({
        examKey: 'Avaliacao_P1', courseId: COURSE, studentClass: '1A', status: 'running',
        config: { versionSnapshots: [{ version: 'A', questions: [{ originalNumber: 1, correctAnswer: 'A', alternatives: [] }] }] },
    });
    db.memory.examApplications = [application];
    db.memory.classes[0].onlineExamConfigs = { Avaliacao_P1: { applicationId: application.id, status: 'running' } };
    try {
        const listUrl = `/api/admin/exam-applications?courseId=${COURSE}&studentClass=1A`;
        // Com view=summary (o polling do Monitor) e sem (o seletor de aplicações): sempre o resumo.
        for (const url of [`${listUrl}&view=summary`, listUrl]) {
            const aux = await get('monitor', url);
            assert.equal(aux.status, 200, JSON.stringify(aux.body));
            assert.deepEqual(aux.body.applications.map(item => item.id), [application.id]);
            assert.equal(aux.body.applications[0].versionSnapshots, undefined, 'sem as versões (gabarito)');
            assert.doesNotMatch(JSON.stringify(aux.body), /correctAnswer/);
        }
        // O professor continua recebendo a lista completa sem view=summary.
        const prof = await get('professor', listUrl).expect(200);
        assert.equal(prof.body.applications[0].versionSnapshots.length, 1);

        const finish = await get('monitor', `/api/admin/exam-applications/${application.id}/finish-summary`);
        assert.equal(finish.status, 200, JSON.stringify(finish.body));
        assert.equal(finish.body.summary.applicationId, application.id);

        const paused = await as('monitor', request(app).post(`/api/admin/exam-applications/${application.id}/control`)).send({ action: 'pause' });
        assert.equal(paused.status, 200, JSON.stringify(paused.body));
        assert.equal(db.memory.examApplications[0].status, 'paused');
        // A resposta do controle também vem sem as versões (gabarito), na aplicação e na configuração.
        assert.equal(paused.body.application.status, 'paused');
        assert.doesNotMatch(JSON.stringify(paused.body), /versionSnapshots|correctAnswer/);
        // A turma lida pelo Monitor (GET /classes) também, para o auxiliar; o professor recebe como antes.
        const classesAux = await get('monitor', `/api/admin/classes?courseId=${COURSE}&studentClass=1A`).expect(200);
        assert.equal(classesAux.body[0].onlineExamConfigs.Avaliacao_P1.status, 'paused');
        assert.doesNotMatch(JSON.stringify(classesAux.body), /versionSnapshots|correctAnswer/);
        const classesProf = await get('professor', `/api/admin/classes?courseId=${COURSE}&studentClass=1A`).expect(200);
        assert.equal(classesProf.body[0].onlineExamConfigs.Avaliacao_P1.versionSnapshots.length, 1);
        // O controle antigo (sem aplicação, server-exam-control) também responde sem o gabarito.
        const legacy = await as('monitor', request(app).post('/api/admin/server-exam-control')).send({ studentClass: '1A', courseId: COURSE, examKey: 'Avaliacao_P1', action: 'resume' });
        assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
        assert.doesNotMatch(JSON.stringify(legacy.body), /versionSnapshots|correctAnswer/);
        await as('monitor', request(app).post(`/api/admin/exam-applications/${application.id}/control`)).send({ action: 'pause' }).expect(200);
        await as('monitor', request(app).post(`/api/admin/exam-applications/${application.id}/control`)).send({ action: 'resume' }).expect(200);
        assert.equal(db.memory.examApplications[0].status, 'running');

        // O resto de exam-applications continua sendo da tela Provas e de Resultados.
        assert.equal((await get('monitor', `/api/admin/exam-applications/${application.id}`)).status, 403, 'a aplicação inteira traz as versões');
        assert.equal((await get('monitor', `/api/admin/exam-applications/${application.id}/audit`)).status, 403);
        const prepare = await as('monitor', request(app).post('/api/admin/exam-applications')).send({ examKey: 'Avaliacao_P1', courseId: COURSE, studentClass: '1A' });
        assert.equal(prepare.status, 403);
        const adjust = await as('monitor', request(app).post(`/api/admin/exam-applications/${application.id}/time-adjustment`)).send({ adjustmentMinutes: 5 });
        assert.equal(adjust.status, 403);

        // Aplicação de turma fora do escopo dele: recusada pelo guarda, como antes.
        const other = createExamApplication({ examKey: 'Avaliacao_P1', courseId: COURSE, studentClass: '9Z', status: 'running' });
        db.memory.examApplications.push(other);
        assert.equal((await as('monitor', request(app).post(`/api/admin/exam-applications/${other.id}/control`)).send({ action: 'pause' })).status, 403);
        assert.equal(other.status, 'running');
        const listed = await get('monitor', `/api/admin/exam-applications?view=summary`).expect(200);
        assert.deepEqual(listed.body.applications.map(item => item.id), [application.id]);
    } finally {
        db.memory.examApplications = [];
        db.memory.classes[0].onlineExamConfigs = {};
    }
});

test('[UC-PAPEIS-001] fila do Dashboard: sem pendência de tela que a conta não abre (Resultados, Fórum), como no sino', async () => {
    db.memory.students.push({ name: 'Caio', email: 'caio@auxiliar.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1A', courseId: COURSE }] });
    try {
        const url = `/api/admin/dashboard/queue?courseId=${COURSE}&studentClass=1A`;
        const prof = await get('professor', url).expect(200);
        assert.ok(prof.body.some(item => item.id === 'sem_avaliacao'), 'o professor continua vendo "Alunos sem nenhuma avaliação"');
        const aux = await get('monitor', url).expect(200);
        assert.equal(aux.body.some(item => item.id === 'sem_avaliacao'), false);
        assert.equal(aux.body.every(item => ['page.dashboard', 'page.classes', 'page.students', 'page.monitor'].includes(item.permissao)), true, JSON.stringify(aux.body));
    } finally {
        db.memory.students = db.memory.students.filter(student => student.email !== 'caio@auxiliar.local');
    }
});
