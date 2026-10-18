// Sigilo da prova (fase 1, grupo G3): questões, gabarito e material só chegam a quem
// pode vê-los. Cada teste falha no comportamento antigo (SEG-01, SEG-02, AVA-01,
// AVA-02, UXA-07, DES-X1, SEG-18).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-secrecy-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');

let app;
const adminToken = 'admin-token-secrecy';
const courseA = 'curso-sigilo';
const courseB = 'curso-outro';
const deletedCourse = 'curso-excluido';
const classA = 'TURMA SIGILO';
const classB = 'TURMA OUTRA';
const examKey = 'Avaliacao_SIG_1';
const otherExamKey = 'Avaliacao_SIG_2';
const GABARITO = 'GABARITO EXCLUSIVO DO PROFESSOR';
const CONTENT_DIR = process.env.ICLASS_CONTENT_DIR;

const evaluationMarkdown = `# Avaliação SIG 1

**1. Qual é a resposta certa?**
a) Errada
b) Certa

<details>
<summary><b>👀 ${GABARITO}</b></summary>

1. **B** (segredo do professor)
</details>
`;

function writeContent() {
    fs.mkdirSync(CONTENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(CONTENT_DIR, 'Apostila_SIG_1.md'), '# Apostila liberada\n\nConteúdo da unidade 1.');
    fs.writeFileSync(path.join(CONTENT_DIR, 'Apostila_SIG_2.md'), '# Apostila bloqueada\n\nConteúdo ainda não liberado.');
    fs.writeFileSync(path.join(CONTENT_DIR, 'Apostila_OUTRA_1.md'), '# Apostila de outro curso');
    fs.writeFileSync(path.join(CONTENT_DIR, 'Apostila_SIG_1_JOYA.md'), '# Cópia fora da estrutura');
    fs.writeFileSync(path.join(CONTENT_DIR, `${examKey}.md`), evaluationMarkdown);
    fs.writeFileSync(path.join(CONTENT_DIR, `${examKey}_JOYA.md`), evaluationMarkdown);
    // Simula o NTFS/APFS, que não diferenciam maiúsculas: o mesmo arquivo pedido em
    // minúsculas abre a avaliação com o gabarito.
    fs.writeFileSync(path.join(CONTENT_DIR, `${examKey.toLowerCase()}.md`), evaluationMarkdown);
    fs.writeFileSync(path.join(CONTENT_DIR, `${examKey.toUpperCase()}.md`), evaluationMarkdown);
}

function seed() {
    db.memory.admins = [{ email: 'admin@sigilo.local', name: 'Admin', role: 'admin', password: db.hashPassword('x') }];
    db.memory.adminSessions = { [adminToken]: { email: 'admin@sigilo.local', createdAt: Date.now(), lastSeen: Date.now() } };
    db.memory.courses = [
        {
            id: courseA,
            name: 'Curso Sigilo',
            structure: [{ id: 'SIG', name: 'Módulo', units: [
                { id: '1', name: 'Unidade 1', apostilaKey: 'Apostila_SIG_1', avaliacaoKey: examKey },
                { id: '2', name: 'Unidade 2', apostilaKey: 'Apostila_SIG_2', avaliacaoKey: otherExamKey },
            ] }],
        },
        { id: courseB, name: 'Curso Outro', structure: [{ id: 'OUT', name: 'Outro', units: [{ id: '1', apostilaKey: 'Apostila_OUTRA_1' }] }] },
        { id: deletedCourse, name: 'Curso Excluído', status: 'deleted', deleted: true, deletedAt: '2026-01-01T00:00:00.000Z', structure: [] },
    ];
    db.memory.classes = [
        { name: classA, courseId: courseA, registrationEnabled: true, releasedItems: { Apostila_SIG_2: false }, onlineExamConfigs: {}, examHistory: {} },
        { name: classB, courseId: courseB, registrationEnabled: false, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} },
        { name: 'TURMA EXCLUIDA', courseId: deletedCourse, registrationEnabled: true, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} },
    ];
    db.memory.students = [
        { name: 'Ana', email: 'ana@sigilo.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: classA, courseId: courseA }] },
        { name: 'Bia', email: 'bia@sigilo.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: classB, courseId: courseB }] },
    ];
    db.memory.evaluations = {
        [examKey]: {
            key: examKey,
            title: 'Prova sigilosa',
            questions: [
                { number: 1, text: 'Enunciado base 1', correctAnswer: 'B', alternatives: [{ letter: 'A', text: 'Errada', isCorrect: false }, { letter: 'B', text: 'Certa', isCorrect: true }] },
                { number: 2, text: 'Enunciado base 2', correctAnswer: 'A', alternatives: [{ letter: 'A', text: 'Certa', isCorrect: true }, { letter: 'B', text: 'Errada', isCorrect: false }] },
            ],
        },
    };
    db.memory.sessions = {};
    db.memory.submissions = [];
    db.memory.examApplications = [];
    db.memory.studentExamState = {};
    db.memory.proctoringLogs = [];
    db.memory.broadcastMessages = [];
    db.memory.courseStructure = [];
}

async function loginStudent(email, password = '123') {
    const res = await request(app).post('/api/student/login').send({ email, password });
    assert.equal(res.status, 200, res.body && res.body.error);
    return res.body.sessionToken;
}

// Prepara a prova com duas versões de texto diferente (A e B). Com token, exige ABCDE.
async function prepareApplication({ tokenEnabled = false } = {}) {
    const versionQuestions = version => [1, 2].map(number => ({
        originalNumber: number,
        examNumber: number,
        text: `Versão ${version} questão ${number}`,
        correctAnswer: number === 1 ? 'B' : 'A',
        alternatives: [
            { letter: 'A', displayLetter: 'A', text: `${version}${number} alternativa A`, isCorrect: number !== 1 },
            { letter: 'B', displayLetter: 'B', text: `${version}${number} alternativa B`, isCorrect: number === 1 },
        ],
    }));
    const history = await request(app).post('/api/admin/exam-history/add').set('x-admin-session', adminToken).send({
        studentClass: classA,
        courseId: courseA,
        examKey,
        type: 'online',
        questionNumbers: [1, 2],
        printSnapshot: [
            { version: 'A', questions: versionQuestions('A'), answerKey: { 1: 'B', 2: 'A' } },
            { version: 'B', questions: versionQuestions('B'), answerKey: { 1: 'B', 2: 'A' } },
        ],
        durationMinutes: 30,
        waitingRoomMinutes: 0,
        maxAttempts: 1,
    }).expect(200);
    const created = await request(app).post('/api/admin/exam-applications').set('x-admin-session', adminToken).send({
        studentClass: classA,
        courseId: courseA,
        examKey,
        historyId: history.body.entry.id,
        applicationOptions: tokenEnabled
            ? { timerMode: 'per_attempt', waitingRoomMinutes: 0, maxAttempts: 1, tokenEnabled: true, accessToken: 'ABCDE' }
            : { timerMode: 'per_attempt', waitingRoomMinutes: 0, maxAttempts: 1 },
    }).expect(201);
    assert.equal(created.body.application.status, 'prepared');
    return created.body.application;
}

function control(applicationId, action, extra = {}) {
    return request(app).post(`/api/admin/exam-applications/${applicationId}/control`)
        .set('x-admin-session', adminToken).send({ action, ...extra });
}

function sync(token, query = {}) {
    return request(app).get('/api/student/sync').set('x-session-token', token)
        .query({ studentClass: classA, courseId: courseA, examKey, ...query });
}

// Nenhum texto de questão (de nenhuma versão) nem gabarito no corpo da resposta.
function assertNoExamContent(body, label) {
    const raw = JSON.stringify(body);
    assert.equal(/Versão [AB] questão/.test(raw), false, `${label}: enunciado não pode ir ao aluno`);
    assert.equal(/Enunciado base/.test(raw), false, `${label}: questões da avaliação não podem ir ao aluno`);
    assert.equal(raw.includes('versionSnapshots'), false, `${label}: snapshots de versão não podem ir ao aluno`);
    assert.equal(raw.includes('correctAnswer'), false, `${label}: gabarito não pode ir ao aluno`);
    assert.equal(raw.includes('isCorrect'), false, `${label}: gabarito não pode ir ao aluno`);
    assert.equal(raw.includes(GABARITO), false, `${label}: bloco de gabarito não pode ir ao aluno`);
}

test.before(async () => {
    writeContent();
    await db.init();
    app = createApp();
});
test.beforeEach(() => { seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-SIGILO-001] gabarito .md não sai sem login nem com outra grafia do nome (SEG-01)', async () => {
    for (const name of [examKey, examKey.toLowerCase(), examKey.toUpperCase(), 'aVaLiAcAo_SIG_1', `${examKey}_JOYA`]) {
        const anonymous = await request(app).get(`/${name}.md`);
        assert.equal(anonymous.status, 401, `${name} sem sessão`);
        assert.equal(anonymous.text.includes(GABARITO), false);
    }

    const token = await loginStudent('ana@sigilo.local');
    for (const name of [examKey, examKey.toLowerCase(), examKey.toUpperCase(), `${examKey}_JOYA`]) {
        const asStudent = await request(app).get(`/${name}.md`).set('x-session-token', token);
        assert.equal(asStudent.status, 403, `${name} como aluno`);
        assert.equal(asStudent.text.includes(GABARITO), false);
    }

    // O instrutor também não abre avaliação por esta rota (como antes), em nenhuma grafia.
    const asAdmin = await request(app).get(`/${examKey.toLowerCase()}.md`).set('x-admin-session', adminToken);
    assert.equal(asAdmin.status, 403);
});

test('[UC-SIGILO-001] apostila só com sessão e só se estiver liberada para a turma do aluno (SEG-18, UXA-07)', async () => {
    assert.equal((await request(app).get('/Apostila_SIG_1.md')).status, 401, 'sem sessão não lê apostila');

    const token = await loginStudent('ana@sigilo.local');
    const released = await request(app).get('/Apostila_SIG_1.md').set('x-session-token', token);
    assert.equal(released.status, 200);
    assert.match(released.text, /Conteúdo da unidade 1/);
    const otherCase = await request(app).get('/apostila_sig_1.md').set('x-session-token', token);
    assert.equal(otherCase.status, 200, 'a comparação ignora maiúsculas, mas abre o arquivo canônico');
    assert.match(otherCase.text, /Conteúdo da unidade 1/);

    assert.equal((await request(app).get('/Apostila_SIG_2.md').set('x-session-token', token)).status, 403, 'bloqueada pelo instrutor');
    assert.equal((await request(app).get('/Apostila_OUTRA_1.md').set('x-session-token', token)).status, 403, 'de outro curso');
    assert.equal((await request(app).get('/Apostila_SIG_1_JOYA.md').set('x-session-token', token)).status, 403, 'fora da estrutura');

    const asAdmin = await request(app).get('/Apostila_SIG_2.md').set('x-admin-session', adminToken);
    assert.equal(asAdmin.status, 200, 'o editor do instrutor continua abrindo qualquer apostila');
    assert.match(asAdmin.text, /ainda não liberado/);
    const legacyAdmin = await request(app).get('/Apostila_SIG_2.md').set('Authorization', 'admin@sigilo.local:x');
    assert.equal(legacyAdmin.status, 200, 'login legado do instrutor também abre');
    assert.equal((await request(app).get('/Apostila_SIG_2.md').set('Authorization', 'admin@sigilo.local:errada')).status, 401);
});

test('[UC-SIGILO-001] /api/courses sem instrutor só lista id e nome de cursos ativos com cadastro aberto (SEG-18)', async () => {
    const anonymous = await request(app).get('/api/courses?includeDeleted=1').expect(200);
    assert.deepEqual(anonymous.body, [{ id: courseA, name: 'Curso Sigilo' }]);
    assert.equal(JSON.stringify(anonymous.body).includes('avaliacaoKey'), false);

    const token = await loginStudent('ana@sigilo.local');
    const asStudent = await request(app).get('/api/courses').set('x-session-token', token).expect(200);
    assert.equal(JSON.stringify(asStudent.body).includes('structure'), false);

    const asAdmin = await request(app).get('/api/courses?includeDeleted=1').set('x-admin-session', adminToken).expect(200);
    assert.equal(asAdmin.body.length, 3, 'o instrutor continua vendo todos, inclusive excluídos');
    assert.equal(asAdmin.body.find(course => course.id === courseA).structure[0].units[0].avaliacaoKey, examKey);
    const legacyAuth = await request(app).get('/api/courses').set('Authorization', 'admin@sigilo.local:x').expect(200);
    assert.equal(legacyAuth.body.length, 2);
    await request(app).get('/api/courses').set('x-admin-session', 'token-invalido').expect(401);
});

test('[UC-SIGILO-001] data.js do aluno: só apostilas liberadas do próprio curso, nunca avaliações (AVA-01, UXA-07)', async () => {
    const token = await loginStudent('ana@sigilo.local');
    const withoutCourse = await request(app).get('/api/data.js').set('x-session-token', token);
    assert.equal(withoutCourse.status, 400);
    assert.equal(withoutCourse.text.includes(GABARITO), false);

    const res = await request(app).get(`/api/data.js?courseId=${courseA}&studentClass=${encodeURIComponent(classA)}`).set('x-session-token', token);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.text.replace(/^const courseData = /, '').replace(/;\s*$/, ''));
    assert.equal(data.Apostila_SIG_1, '# Apostila liberada\n\nConteúdo da unidade 1.');
    assert.equal(data.Apostila_SIG_2, undefined, 'apostila bloqueada não vai ao navegador');
    assert.equal(data.Apostila_OUTRA_1, undefined);
    assert.equal(data.Apostila_SIG_1_JOYA, undefined);
    assert.equal(Object.keys(data).some(key => /^avaliacao_/i.test(key)), false, 'nenhuma avaliação, em nenhuma grafia');
    assert.equal(res.text.includes(GABARITO), false);
    assert.equal(res.text.includes('"questions"'), false);
    assert.equal(data.courses.length, 1);
    assert.equal(data.courses[0].structure[0].units.length, 2, 'a estrutura do curso continua para mostrar as unidades bloqueadas');

    // Sem a turma na query, usa a turma do aluno no curso pedido.
    const implicitClass = await request(app).get(`/data.js?courseId=${courseA}`).set('x-session-token', token);
    assert.equal(implicitClass.status, 200);
    assert.match(implicitClass.text, /Apostila_SIG_1/);

    assert.equal((await request(app).get(`/api/data.js?courseId=${courseB}`).set('x-session-token', token)).status, 403, 'curso em que não está matriculado');
    assert.equal((await request(app).get(`/api/data.js?courseId=${courseB}&studentClass=${encodeURIComponent(classA)}`).set('x-session-token', token)).status, 403);
    assert.equal((await request(app).get(`/api/data.js?courseId=${deletedCourse}`).set('x-session-token', token)).status, 404, 'curso excluído nunca');

    const asAdmin = await request(app).get(`/data.js?courseId=${courseA}`).set('x-admin-session', adminToken);
    assert.equal(asAdmin.status, 200, 'o instrutor continua recebendo o data.js completo');
    assert.match(asAdmin.text, /Apostila_SIG_2/);
});

test('[UC-SIGILO-001] conta autocadastrada pendente e aluno de outra turma não veem nada da prova (SEG-02)', async () => {
    const application = await prepareApplication();
    await request(app).post('/api/student/register').send({
        name: 'Intruso', email: 'intruso@sigilo.local', password: '1', studentClass: classA, courseId: courseA, acceptedTerms: true,
    }).expect(200);
    const intruder = await loginStudent('intruso@sigilo.local', '1');
    const outsider = await loginStudent('bia@sigilo.local');

    for (const [label, token] of [['autocadastro pendente', intruder], ['aluno de outra turma', outsider]]) {
        const status = await request(app).get(`/api/status?studentClass=${encodeURIComponent(classA)}&courseId=${courseA}`).set('x-session-token', token);
        assert.equal(status.status, 403, `${label}: /api/status`);
        assertNoExamContent(status.body, label);
        const synced = await sync(token, { applicationId: application.id });
        assert.equal(synced.status, 403, `${label}: sync`);
        assertNoExamContent(synced.body, label);
        const data = await request(app).get(`/api/data.js?courseId=${courseA}&studentClass=${encodeURIComponent(classA)}`).set('x-session-token', token);
        assert.equal(data.status, 403, `${label}: data.js`);
    }

    await control(application.id, 'start').expect(200);
    for (const [email, token] of [['intruso@sigilo.local', intruder], ['bia@sigilo.local', outsider]]) {
        const synced = await sync(token, { applicationId: application.id });
        assert.equal(synced.status, 403);
        assertNoExamContent(synced.body, 'sync com prova em andamento');
        const tokenAttempt = await request(app).post('/api/student/validate-exam-token').set('x-session-token', token)
            .send({ email, studentClass: classA, courseId: courseA, examKey, applicationId: application.id, token: 'ABCDE' });
        assert.equal(tokenAttempt.status, 403);
        const activity = await request(app).post('/api/student/log-activity').set('x-session-token', token)
            .send({ email, studentClass: classA, courseId: courseA, examKey, applicationId: application.id, eventType: 'tab_blur' });
        assert.equal(activity.status, 403);
        const listed = await request(app).get('/api/student/exam-applications').set('x-session-token', token).expect(200);
        assert.equal(listed.body.applications.length, 0);
    }
    const foreignStates = Object.values(db.memory.studentExamState)
        .filter(state => ['intruso@sigilo.local', 'bia@sigilo.local'].includes(state.studentEmail));
    assert.equal(foreignStates.length, 0, 'nenhuma tentativa criada em turma alheia');
    await control(application.id, 'finish', { inProgressPolicy: 'discard' }).expect(200);
});

test('[UC-SIGILO-001] conta pendente não valida token de prova, nem com turma inexistente ou sem turma', async () => {
    await request(app).post('/api/student/register').send({
        name: 'Pendente', email: 'pendente@sigilo.local', password: '1', studentClass: classA, courseId: courseA, acceptedTerms: true,
    }).expect(200);
    const pending = await loginStudent('pendente@sigilo.local', '1');
    const application = await prepareApplication({ tokenEnabled: true });
    await control(application.id, 'start').expect(200);
    for (const studentClass of ['TURMA FANTASMA', '', classA, classA.toLowerCase()]) {
        const res = await request(app).post('/api/student/validate-exam-token').set('x-session-token', pending)
            .send({ email: 'pendente@sigilo.local', studentClass, courseId: courseA, examKey, token: 'ABCDE' });
        assert.equal(res.status, 403, `turma "${studentClass}": antes valid:true para turma inexistente`);
        assert.notEqual(res.body.valid, true);
    }
    assert.equal(Object.values(db.memory.studentExamState).some(state => state.studentEmail === 'pendente@sigilo.local'), false);
    // Aluno matriculado continua validando (com a turma em outra grafia, inclusive).
    const ana = await loginStudent('ana@sigilo.local');
    const ok = await request(app).post('/api/student/validate-exam-token').set('x-session-token', ana)
        .send({ email: 'ana@sigilo.local', studentClass: classA.toLowerCase(), courseId: courseA, examKey, applicationId: application.id, token: 'ABCDE' });
    assert.equal(ok.status, 200, ok.body && ok.body.error);
    assert.equal(ok.body.valid, true);
    await control(application.id, 'finish', { inProgressPolicy: 'discard' }).expect(200);
});

test('[UC-SIGILO-001] lista de aplicações e entregas do aluno não levam snapshots, letra original, gabarito nem nota não publicada', async () => {
    const application = await prepareApplication({ tokenEnabled: true });
    const token = await loginStudent('ana@sigilo.local');
    const assertCleanList = async (label) => {
        const listed = await request(app).get('/api/student/exam-applications').set('x-session-token', token).expect(200);
        const raw = JSON.stringify(listed.body);
        assertNoExamContent(listed.body, label);
        for (const field of ['alternatives', '"letter"', 'displayLetter', 'answerKey', 'accessToken', 'ABCDE', 'questionReports', 'studentVersions']) {
            assert.equal(raw.includes(field), false, `${label}: ${field} não pode ir ao aluno`);
        }
        return listed.body.applications;
    };
    await control(application.id, 'start').expect(200);
    assert.equal((await assertCleanList('em andamento')).length, 1);
    await control(application.id, 'pause').expect(200);
    await assertCleanList('pausada');
    await control(application.id, 'resume').expect(200);

    await request(app).post('/api/student/validate-exam-token').set('x-session-token', token)
        .send({ email: 'ana@sigilo.local', studentClass: classA, courseId: courseA, examKey, applicationId: application.id, token: 'ABCDE' }).expect(200);
    const started = await request(app).post(`/api/student/exam-applications/${application.id}/start-attempt`).set('x-session-token', token).send({}).expect(200);
    await assertCleanList('com a tentativa iniciada');
    const submitted = await request(app).post('/api/student/submit').set('x-session-token', token).send({
        studentClass: classA, courseId: courseA, examKey, applicationId: application.id, attemptId: started.body.attemptId,
        answers: { 1: 'B', 2: 'B' }, questionNumbers: [1, 2], examConfigVersion: started.body.examConfigVersion,
    });
    assert.equal(submitted.status, 200, submitted.body && submitted.body.error);
    assert.equal(submitted.body.message, 'Prova enviada. A nota será exibida após a publicação do professor.');
    assert.equal(JSON.stringify(submitted.body).includes('score'), false);
    // Anulação depois do envio recorrige a nota e guarda a anterior no histórico.
    await request(app).post('/api/admin/annul-question').set('x-admin-session', adminToken)
        .send({ applicationId: application.id, questionNumber: 2, mode: 'ponto_para_todos', reason: 'teste' }).expect(200);
    const stored = db.memory.submissions.find(item => item.applicationId === application.id);
    assert.ok(stored.scoreHistory && stored.scoreHistory.length, 'a recorreção guardou a nota anterior');

    // Nota não publicada e gabarito não liberado: nada de nota, histórico nem gabarito.
    const mine = await request(app).post('/api/student/my-submissions').set('x-session-token', token).send({ courseId: courseA, studentClass: classA }).expect(200);
    const own = mine.body.submissions.find(item => item.applicationId === application.id);
    assert.ok(own);
    assert.equal(own.gradePublished, false);
    assert.equal(own.answerKeyReleased, false);
    assert.equal(own.score, undefined);
    assert.equal(own.scoreHistory, undefined, 'o histórico da nota revelava a nota antes da publicação');
    const raw = JSON.stringify(mine.body);
    for (const field of ['correctAnswer', 'isCorrect', 'examSnapshot', 'versionSnapshots', '"answerKey"', '"from"', '"to"']) {
        assert.equal(raw.includes(field), false, `minhas entregas: ${field} não pode ir ao aluno antes da liberação`);
    }
    assert.deepEqual(own.gradedAnswers.map(answer => Object.keys(answer).sort()), [['questionNumber', 'studentChoice'], ['questionNumber', 'studentChoice']]);

    // Os outros caminhos do aluno também não levam gabarito, snapshot nem a nota antes da publicação.
    const others = {
        'estado da prova': await request(app).get(`/api/student/exam-state?email=ana@sigilo.local&studentClass=${encodeURIComponent(classA)}&courseId=${courseA}&examKey=${examKey}`).set('x-session-token', token),
        sync: await sync(token, { applicationId: application.id }),
        status: await request(app).get(`/api/status?studentClass=${encodeURIComponent(classA)}&courseId=${courseA}`).set('x-session-token', token),
        notificações: await request(app).get(`/api/student/notifications?studentClass=${encodeURIComponent(classA)}&courseId=${courseA}`).set('x-session-token', token),
        painel: await request(app).get(`/api/student/dashboard?studentClass=${encodeURIComponent(classA)}&courseId=${courseA}`).set('x-session-token', token),
        aplicações: await request(app).get('/api/student/exam-applications').set('x-session-token', token),
    };
    for (const [label, response] of Object.entries(others)) {
        assert.equal(response.status, 200, `${label}: ${response.status} ${JSON.stringify(response.body)}`);
        const text = JSON.stringify(response.body);
        for (const field of ['correctAnswer', 'isCorrect', 'answerKey', 'versionSnapshots', 'examSnapshot', 'GABARITO', 'scoreHistory']) {
            assert.equal(text.includes(field), false, `${label}: ${field} não pode ir ao aluno antes da liberação`);
        }
        assert.equal(/"score"\s*:\s*\d/.test(text), false, `${label}: nota antes da publicação`);
    }
    await control(application.id, 'finish', { inProgressPolicy: 'discard' }).expect(200);
});

test('[UC-SIGILO-001] questões só chegam depois do início real da tentativa e só da versão do aluno (AVA-02)', async () => {
    const application = await prepareApplication({ tokenEnabled: true });
    const token = await loginStudent('ana@sigilo.local');

    // Preparada: nada de enunciado em status, sync nem lista de aplicações.
    const preparedStatus = await request(app).get(`/api/status?studentClass=${encodeURIComponent(classA)}&courseId=${courseA}`).set('x-session-token', token).expect(200);
    assert.equal(preparedStatus.body.onlineExamConfigs[examKey].status, 'prepared');
    assertNoExamContent(preparedStatus.body, 'status com prova preparada');
    const preparedSync = await sync(token, { applicationId: application.id }).expect(200);
    assert.equal(preparedSync.body.questions, null);
    assertNoExamContent(preparedSync.body, 'sync com prova preparada');

    await control(application.id, 'start').expect(200);
    const listed = await request(app).get('/api/student/exam-applications').set('x-session-token', token).expect(200);
    assert.equal(listed.body.applications.length, 1);
    assertNoExamContent(listed.body, 'lista de aplicações');
    assert.equal(listed.body.applications[0].studentVersions, undefined);
    assert.equal(listed.body.applications[0].config.requiresToken, true);

    // Em andamento, mas sem token: nada.
    const beforeToken = await sync(token, { applicationId: application.id }).expect(200);
    assert.equal(beforeToken.body.tokenAccepted, false);
    assert.equal(beforeToken.body.questions, null);
    assertNoExamContent(beforeToken.body, 'sync antes do token');

    // Token validado, mas tentativa ainda nas instruções (cronômetro parado): nada.
    const validated = await request(app).post('/api/student/validate-exam-token').set('x-session-token', token)
        .send({ email: 'ana@sigilo.local', studentClass: classA, courseId: courseA, examKey, applicationId: application.id, token: 'ABCDE' }).expect(200);
    assert.equal(validated.body.valid, true);
    const beforeStart = await sync(token, { applicationId: application.id }).expect(200);
    assert.equal(beforeStart.body.tokenAccepted, true);
    assert.equal(beforeStart.body.state.startedAt, null);
    assertNoExamContent(beforeStart.body, 'sync antes de iniciar a tentativa');

    // Tentativa iniciada: só a versão sorteada, sem gabarito.
    const started = await request(app).post(`/api/student/exam-applications/${application.id}/start-attempt`).set('x-session-token', token).send({}).expect(200);
    const version = started.body.state.assignedVersion;
    const otherVersion = version === 'A' ? 'B' : 'A';
    assert.deepEqual(started.body.questions.map(question => question.text), [`Versão ${version} questão 1`, `Versão ${version} questão 2`]);
    assert.ok(started.body.questionsVersion);
    const startedRaw = JSON.stringify(started.body);
    assert.equal(startedRaw.includes(`Versão ${otherVersion} questão`), false, 'a outra versão não vai ao aluno');
    assert.equal(startedRaw.includes('correctAnswer') || startedRaw.includes('isCorrect') || startedRaw.includes('answerKey'), false);

    const running = await sync(token, { applicationId: application.id }).expect(200);
    assert.deepEqual(running.body.questions, started.body.questions);
    assert.equal(running.body.questionsVersion, started.body.questionsVersion);
    const runningRaw = JSON.stringify(running.body);
    assert.equal(runningRaw.includes(`Versão ${otherVersion} questão`), false);
    assert.equal(runningRaw.includes('correctAnswer') || runningRaw.includes('isCorrect'), false);

    // Pausada pelo professor: as questões param de ir.
    await control(application.id, 'pause').expect(200);
    const paused = await sync(token, { applicationId: application.id }).expect(200);
    assert.equal(paused.body.questions, null);
    assert.equal(paused.body.onlineExamConfigs[examKey].status, 'paused');
    await control(application.id, 'resume').expect(200);

    // Encerrada: nada de questões em sync nem status.
    await control(application.id, 'finish', { inProgressPolicy: 'submit' }).expect(200);
    const finished = await sync(token, { applicationId: application.id }).expect(200);
    assertNoExamContent(finished.body, 'sync depois de encerrar');
    const finishedStatus = await request(app).get(`/api/status?studentClass=${encodeURIComponent(classA)}&courseId=${courseA}`).set('x-session-token', token).expect(200);
    assertNoExamContent(finishedStatus.body, 'status depois de encerrar');
    assert.equal(finishedStatus.body.onlineExamConfigs[examKey].status, 'finished');

    // O instrutor continua vendo a configuração completa.
    const adminStatus = await request(app).get(`/api/status?studentClass=${encodeURIComponent(classA)}&courseId=${courseA}`).set('x-admin-session', adminToken).expect(200);
    assert.equal(adminStatus.body.onlineExamConfigs[examKey].versionSnapshots.length, 2);
});

test('[UC-SIGILO-001] sync só manda a config da prova pedida e as questões só quando o cliente não as tem (DES-X1)', async () => {
    // Outra prova já encerrada na turma, com snapshots guardados na configuração.
    db.memory.classes[0].onlineExamConfigs[otherExamKey] = {
        applicationId: 'app_antiga',
        status: 'finished',
        onlineActive: false,
        versionSnapshots: [{ version: 'A', questions: [{ originalNumber: 1, text: 'Versão A questão antiga', correctAnswer: 'A', alternatives: [] }] }],
    };
    const application = await prepareApplication();
    await control(application.id, 'start').expect(200);
    const token = await loginStudent('ana@sigilo.local');
    await sync(token, { applicationId: application.id }).expect(200);
    const started = await request(app).post(`/api/student/exam-applications/${application.id}/start-attempt`).set('x-session-token', token).send({}).expect(200);

    const first = await sync(token, { applicationId: application.id }).expect(200);
    assert.deepEqual(Object.keys(first.body.onlineExamConfigs), [examKey], 'só a configuração da prova aberta');
    assert.equal(first.body.questions.length, 2);

    const cached = await sync(token, { applicationId: application.id, questionsVersion: started.body.questionsVersion }).expect(200);
    assert.equal(cached.body.questions, null, 'o cliente já tem estas questões');
    assert.equal(cached.body.questionsVersion, started.body.questionsVersion);
    assert.ok(Buffer.byteLength(cached.text) < Buffer.byteLength(first.text));
    assertNoExamContent(cached.body, 'sync sem reenvio');

    const status = await request(app).get(`/api/status?studentClass=${encodeURIComponent(classA)}&courseId=${courseA}`).set('x-session-token', token).expect(200);
    assert.equal(JSON.stringify(status.body).includes('questão antiga'), false, 'status não reenvia provas antigas');
    await control(application.id, 'finish', { inProgressPolicy: 'discard' }).expect(200);
});

test('[UC-SIGILO-001] mensagens da prova só para aluno da turma, sem os e-mails de quem já leu (SEG-02)', async () => {
    const sendMessage = body => request(app).post('/api/admin/send-broadcast-message').set('x-admin-session', adminToken)
        .send({ studentClass: classA, courseId: courseA, examKey, ...body }).expect(200);
    const toClass = (await sendMessage({ messageText: 'Questão 2 anulada, sigam para a 3.' })).body.message;
    const toAna = (await sendMessage({ messageText: 'Ana, confira a folha.', targetEmail: 'ana@sigilo.local' })).body.message;
    db.memory.broadcastMessages.find(m => m.id === toClass.id).acknowledgedBy = ['colega@sigilo.local'];

    await request(app).post('/api/student/register').send({
        name: 'Intruso', email: 'intruso@sigilo.local', password: '1', studentClass: classA, courseId: courseA, acceptedTerms: true,
    }).expect(200);
    const intruder = await loginStudent('intruso@sigilo.local', '1');
    const outsider = await loginStudent('bia@sigilo.local');

    for (const [label, email, token] of [['autocadastro pendente', 'intruso@sigilo.local', intruder], ['aluno de outra turma', 'bia@sigilo.local', outsider]]) {
        const all = await request(app).get('/api/student/message-history').set('x-session-token', token).expect(200);
        assert.deepEqual(all.body.messages, [], `${label}: histórico sem turma não traz mensagens de outras turmas`);
        const withClass = await request(app).get('/api/student/message-history').set('x-session-token', token)
            .query({ studentClass: classA, courseId: courseA, examKey });
        assert.equal(withClass.status, 403, `${label}: histórico da turma alheia`);
        for (const body of [all.body, withClass.body]) {
            const raw = JSON.stringify(body);
            assert.equal(raw.includes('anulada'), false, `${label}: texto da mensagem não vaza`);
            assert.equal(raw.includes('colega@sigilo.local'), false, `${label}: e-mails de colegas não vazam`);
        }
        const state = await request(app).get('/api/student/exam-state').set('x-session-token', token)
            .query({ email, studentClass: classA, courseId: courseA, examKey });
        assert.equal(state.status, 403, `${label}: exam-state`);

        const ack = await request(app).post('/api/student/acknowledge-message').set('x-session-token', token).send({ email, messageId: toAna.id });
        assert.equal(ack.status, 404, `${label}: não confirma mensagem que não pode ver`);
        const hidden = await request(app).post('/api/student/message-history/delete').set('x-session-token', token).send({ email }).expect(200);
        assert.equal(hidden.body.deleted, 0, `${label}: não mexe em mensagens de outras turmas`);
        const hiddenClass = await request(app).post('/api/student/message-history/delete').set('x-session-token', token)
            .send({ email, studentClass: classA, courseId: courseA });
        assert.equal(hiddenClass.status, 403);
    }
    const storedToAna = db.memory.broadcastMessages.find(m => m.id === toAna.id);
    assert.equal(storedToAna.status, 'pending', 'mensagem individual da Ana continua não lida');
    assert.deepEqual(storedToAna.acknowledgedBy, []);
    assert.equal(db.memory.broadcastMessages.some(m => (m.deletedFor || []).length > 0), false);

    // A aluna da turma continua recebendo as mensagens, sem a lista de quem já confirmou.
    const ana = await loginStudent('ana@sigilo.local');
    const history = await request(app).get('/api/student/message-history').set('x-session-token', ana)
        .query({ studentClass: classA, courseId: courseA, examKey }).expect(200);
    assert.deepEqual(history.body.messages.map(m => m.messageText).sort(), ['Ana, confira a folha.', 'Questão 2 anulada, sigam para a 3.']);
    assert.equal(JSON.stringify(history.body).includes('colega@sigilo.local'), false);
    assert.equal(JSON.stringify(history.body).includes('acknowledgedBy'), false);
    const anaState = await request(app).get('/api/student/exam-state').set('x-session-token', ana)
        .query({ email: 'ana@sigilo.local', studentClass: classA, courseId: courseA, examKey }).expect(200);
    assert.equal(anaState.body.messages.length, 2);
    assert.equal(JSON.stringify(anaState.body.messages).includes('colega@sigilo.local'), false);
    await request(app).post('/api/student/acknowledge-message').set('x-session-token', ana)
        .send({ email: 'ana@sigilo.local', messageId: toAna.id }).expect(200);
    assert.equal(storedToAna.status, 'read');
    const removed = await request(app).post('/api/student/message-history/delete').set('x-session-token', ana)
        .send({ email: 'ana@sigilo.local', studentClass: classA, courseId: courseA, examKey }).expect(200);
    assert.equal(removed.body.deleted, 2);
});

test('[UC-SIGILO-001] apostila perde só o gabarito do professor; autocorreção do aluno fica (SEG-01)', async () => {
    const file = path.join(CONTENT_DIR, 'Apostila_SIG_1.md');
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, [
        '# Apostila liberada',
        '<details>\n<summary>Gabarito dos exercícios</summary>\n\n1. Resposta para o aluno conferir\n</details>',
        '<details>\n<summary>👀 Ver Resposta</summary>\n\nExplicação para o aluno\n</details>',
        `<details>\n<summary><b>👀 ${GABARITO}</b></summary>\n\n1. **B** (segredo do professor)\n</details>`,
        '<details>\n<summary><b>GABARITO</b></summary>\n\n1. **C** (segredo da prova)\n</details>',
        '<details>\n<summary><b>GABARITO OFICIAL</b></summary>\n\n1. **D** (segredo oficial)\n</details>',
    ].join('\n\n'));
    try {
        const token = await loginStudent('ana@sigilo.local');
        const asStudent = await request(app).get('/Apostila_SIG_1.md').set('x-session-token', token).expect(200);
        const data = await request(app).get(`/api/data.js?courseId=${courseA}`).set('x-session-token', token).expect(200);
        for (const [label, text] of [['apostila .md', asStudent.text], ['data.js', data.text]]) {
            assert.match(text, /Resposta para o aluno conferir/, `${label}: bloco de autocorreção continua`);
            assert.match(text, /Explicação para o aluno/, label);
            assert.equal(/segredo (do professor|da prova|oficial)/.test(text), false, `${label}: gabarito do professor sai`);
            assert.equal(text.includes(GABARITO), false, label);
        }
        const asAdmin = await request(app).get('/Apostila_SIG_1.md').set('x-admin-session', adminToken).expect(200);
        assert.match(asAdmin.text, /segredo do professor/, 'o editor do instrutor vê o arquivo como está');
    } finally {
        fs.writeFileSync(file, original);
    }
});
