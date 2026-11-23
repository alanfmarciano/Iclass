// Conversas entre aluno e instrutor (fase 3, C13 / P5-S7a, FUN-14; D8 a D15 do P5).
// [UC-MENSAGEM-001] começar: o aluno só escreve para quem atende a turma (identificador
//   opaco, sem e-mail; de outra turma ou forjado 400); o professor começa com aluno da
//   turma dele; conversa aberta repetida continua a mesma.
// [UC-MENSAGEM-002] sigilo: outro aluno e outro professor 404; GET não grava; o
//   administrador lê a conversa dos outros só depois do admin-open, que fica na auditoria.
// [UC-MENSAGEM-003] regras: texto vazio, longo ou só espaços 400; limite por conta 429 com
//   Retry-After; prova aberta 409 exam_in_progress; encerrada 409 conversation_closed ao
//   aluno e aceita o instrutor; arquivada volta com mensagem nova.
// [UC-MENSAGEM-004] sino do aluno pela marca lidaAte, fila e sino do instrutor, gravação
//   parcial (só conversations e conversationMessages).
// [UC-MENSAGEM-005] ciclo de vida: troca de e-mail, anonimizar, apagar de vez, Meus dados,
//   mesclar, religar e backup antigo (missing 'keep'); pré-visualização só lê.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-conversas-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const conversations = require('../../backend/utils/conversations.js');
const studentData = require('../../backend/utils/studentDataHandlers.js');
const rateLimit = require('../../backend/utils/rateLimit.js');
const { missingCollectionOutcome } = require('../../backend/utils/backupSchema.js');
const { createAdminSession, createStudentSession } = require('../../backend/utils/authSessions.js');
const { resetAdminOpenCacheForTests } = require('../../backend/routes/adminMessages.js');
const { createApp } = require('../../backend/server.js');

const COURSE = 'curso-conversas';
const CLASS = '1MSG';
const OTHER = '2MSG';
const ANA = 'ana@conversas.local';
const BIA = 'bia@conversas.local';
const CAIO = 'caio@conversas.local';
const PROF = 'prof@conversas.local';
const PROF_B = 'profb@conversas.local';
const PROF2 = 'prof2@conversas.local';
const ADMIN = 'adm@conversas.local';
const tokens = {};
let app;

const as = (name, req) => req.set('x-admin-session', tokens[name]);
const asStudent = (email, req) => req.set('x-session-token', tokens[email]);
const audits = action => (db.memory.auditLogs || []).filter(entry => entry.action === action);
const Q = `courseId=${COURSE}&studentClass=${CLASS}`;

function student(id, name, email, extra = {}) {
    return { id, name, email, matricula: `MAT-${id.slice(-2)}`, status: 'Ativo', password: db.hashPassword('Senha-forte-123'), classes: [{ name: CLASS, courseId: COURSE }], ...extra };
}

function seed() {
    db.memory.config = { ...(db.memory.config || {}), settings: { timezone: 'America/Sao_Paulo' } };
    db.memory.schools = [{ id: 'escola_m', name: 'Escola M', info: {}, branding: {} }];
    db.memory.courses = [{ id: COURSE, name: 'Curso das conversas', schoolId: 'escola_m', structure: [] }];
    db.memory.classes = [{ name: CLASS, courseId: COURSE, period: 'Manhã' }, { name: OTHER, courseId: COURSE, period: 'Tarde' }];
    db.memory.students = [
        student('alu_00000000000000a1', 'Ana Souza', ANA),
        student('alu_00000000000000b2', 'Beatriz Lima', BIA, { nomeSocial: 'Bia' }),
        student('alu_00000000000000c3', 'Caio Prado', CAIO, { classes: [{ name: OTHER, courseId: COURSE }] }),
    ];
    const pass = db.hashPassword('Senha-forte-2026');
    db.memory.admins = [
        { email: ADMIN, name: 'Administração', role: 'admin', password: pass },
        { email: PROF, name: 'Prof. Alan', role: 'professor', password: pass, assignedClasses: [{ courseId: COURSE, className: CLASS }] },
        { email: PROF_B, name: 'Prof. Bruna', role: 'professor', password: pass, assignedClasses: [{ courseId: COURSE, className: CLASS }] },
        { email: PROF2, name: 'Prof. Outra', role: 'professor', password: pass, assignedClasses: [{ courseId: COURSE, className: OTHER }] },
        { email: 'coord@conversas.local', name: 'Coordenação', role: 'coordenacao', password: pass, assignedSchoolIds: ['escola_m'] },
        { email: 'mon@conversas.local', name: 'Monitor', role: 'monitor', password: pass, assignedClasses: [{ courseId: COURSE, className: CLASS }] },
    ];
    db.memory.adminSessions = {};
    db.memory.sessions = {};
    db.memory.conversations = [];
    db.memory.conversationMessages = [];
    db.memory.auditLogs = [];
    db.memory.submissions = [];
    db.memory.attendance = [];
    db.memory.certificates = [];
    db.memory.examApplications = [];
    db.memory.studentExamState = {};
    db.memory.announcements = [];
    db.memory.forum = [];
    delete db.memory.previewSessions;
    tokens.admin = createAdminSession(db.memory, ADMIN);
    tokens.prof = createAdminSession(db.memory, PROF);
    tokens.profB = createAdminSession(db.memory, PROF_B);
    tokens.prof2 = createAdminSession(db.memory, PROF2);
    tokens.coord = createAdminSession(db.memory, 'coord@conversas.local');
    tokens.mon = createAdminSession(db.memory, 'mon@conversas.local');
    [ANA, BIA, CAIO].forEach(email => { tokens[email] = createStudentSession(db.memory, email); });
    rateLimit.resetForTests();
    resetAdminOpenCacheForTests();
}

async function recipients(email = ANA, query = Q) {
    const res = await asStudent(email, request(app).get(`/api/student/conversations/recipients?${query}`));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.destinatarios;
}

async function refOf(nome, email = ANA) {
    const found = (await recipients(email)).find(item => item.nome === nome);
    assert.ok(found, `${nome} na lista`);
    return found.ref;
}

async function studentStart(body = {}, email = ANA) {
    const destinatario = body.destinatario || await refOf('Prof. Alan', email);
    return asStudent(email, request(app).post('/api/student/conversations')).send({ courseId: COURSE, studentClass: CLASS, texto: 'Oi, professor', ...body, destinatario });
}

async function startOk(body, email) {
    const res = await studentStart(body, email);
    assert.ok([200, 201].includes(res.status), JSON.stringify(res.body));
    return res.body.conversa;
}

function spySaves() {
    const saves = [];
    const original = db.save;
    db.save = function spied(...args) { saves.push(args[0]); return original.apply(this, args); };
    return { saves, restore: () => { db.save = original; } };
}

test.before(async () => {
    await db.init();
    app = createApp();
});
test.beforeEach(() => { seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 300));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// [UC-MENSAGEM-001] começar uma conversa
// ---------------------------------------------------------------------------

test('[UC-MENSAGEM-001] o aluno vê só quem atende a turma dele, sem e-mail; preferência desligada tira da lista', async () => {
    const list = await recipients();
    assert.deepEqual(list.map(item => [item.nome, item.papel]), [['Administração', 'Administrador'], ['Prof. Alan', 'Professor'], ['Prof. Bruna', 'Professor']]);
    list.forEach(item => assert.match(item.ref, /^[0-9a-f]{32}$/));
    assert.equal(JSON.stringify(list).includes('@'), false, 'nenhum e-mail de professor no portal');
    // A outra turma tem outra lista e outros identificadores.
    const other = await recipients(CAIO, `courseId=${COURSE}&studentClass=${OTHER}`);
    assert.deepEqual(other.map(item => item.nome), ['Administração', 'Prof. Outra']);
    assert.notEqual(other[0].ref, list[0].ref, 'o identificador muda com a turma');
    // Turma de fora do aluno: 403.
    assert.equal((await asStudent(ANA, request(app).get(`/api/student/conversations/recipients?courseId=${COURSE}&studentClass=${OTHER}`))).status, 403);

    // "Receber mensagens de alunos" desligada: some da lista. Só aceita sim ou não.
    const bad = await as('profB', request(app).post('/api/admin/preferences')).send({ 'messages.receive': 'nao' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.field, 'messages.receive');
    const off = await as('profB', request(app).post('/api/admin/preferences')).send({ 'messages.receive': false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.deepEqual((await recipients()).map(item => item.nome), ['Administração', 'Prof. Alan']);
});

test('[UC-MENSAGEM-001] o aluno começa a conversa: a linha segue o modelo, grava só as duas coleções e a aberta repetida continua a mesma', async () => {
    const ref = await refOf('Prof. Alan');
    const spy = spySaves();
    let res;
    try {
        res = await studentStart({ destinatario: ref, assunto: '  Revisão   da prova ', texto: '  Professor, posso pedir revisão?\r\nObrigada.  ' });
    } finally { spy.restore(); }
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(spy.saves, [{ only: ['conversations', 'conversationMessages'] }]);
    assert.equal(res.body.criada, true);
    const conv = db.memory.conversations[0];
    assert.match(conv.id, /^conv_\d{13}_[0-9a-f]{6}$/);
    assert.equal(conv.schemaVersion, 1);
    assert.deepEqual([conv.courseId, conv.studentClass, conv.status, conv.iniciadaPor, conv.assunto, conv.mensagens], [COURSE, CLASS, 'aberta', 'aluno', 'Revisão da prova', 1]);
    assert.deepEqual(conv.aluno, { email: ANA, studentId: 'alu_00000000000000a1' });
    assert.deepEqual(conv.instrutor, { email: PROF, nome: 'Prof. Alan' });
    const msg = db.memory.conversationMessages[0];
    assert.match(msg.id, /^msg_\d{13}_[0-9a-f]{6}$/);
    assert.deepEqual([msg.conversationId, msg.autor, msg.autorEmail, msg.texto], [conv.id, 'aluno', ANA, 'Professor, posso pedir revisão?\nObrigada.']);
    assert.equal(conv.lidaAte.aluno, msg.criadaEm, 'a mensagem de quem escreve já conta como lida para ele');
    assert.equal(conv.lidaAte.instrutor, 0);
    assert.equal(res.body.conversa.instrutor.nome, 'Prof. Alan');
    assert.equal(JSON.stringify(res.body).includes(PROF), false, 'sem o e-mail do professor');
    assert.equal(audits('conversation_closed').length + db.memory.auditLogs.length, 0, 'mensagem enviada não vai para a auditoria');

    const again = await studentStart({ destinatario: ref, texto: 'Mais uma coisa' });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.criada, false);
    assert.equal(again.body.conversa.id, conv.id);
    assert.equal(db.memory.conversations.length, 1);
    assert.equal(db.memory.conversations[0].mensagens, 2);
});

test('[UC-MENSAGEM-001] identificador forjado, de outra turma ou de professor que não atende dá 400', async () => {
    const forged = await studentStart({ destinatario: 'f'.repeat(32) });
    assert.equal(forged.status, 400);
    assert.equal(forged.body.code, 'invalid_recipient');
    assert.equal(forged.body.field, 'destinatario');
    const fromOther = (await recipients(CAIO, `courseId=${COURSE}&studentClass=${OTHER}`)).find(item => item.nome === 'Prof. Outra').ref;
    const res = await studentStart({ destinatario: fromOther });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'invalid_recipient');
    const notString = await asStudent(ANA, request(app).post('/api/student/conversations')).send({ courseId: COURSE, studentClass: CLASS, destinatario: 5, texto: 'Oi' });
    assert.equal(notString.status, 400);
    assert.equal(db.memory.conversations.length, 0);
});

test('[UC-MENSAGEM-001] o professor começa com aluno da turma dele; aluno de fora 400; turma de fora 403; coordenação e monitor sem a tela', async () => {
    const spy = spySaves();
    let res;
    try {
        res = await as('prof', request(app).post('/api/admin/conversations')).send({ courseId: COURSE, studentClass: CLASS, studentEmail: BIA, assunto: 'Faltas', texto: 'Bia, está tudo bem?' });
    } finally { spy.restore(); }
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(spy.saves, [{ only: ['conversations', 'conversationMessages'] }]);
    assert.equal(res.body.conversa.iniciadaPor, 'instrutor');
    assert.equal(res.body.conversa.aluno.nome, 'Bia');
    assert.equal(res.body.conversa.participante, true);
    assert.equal(res.body.mensagem.voce, true);
    // Pelo id do aluno também (aluno sem e-mail).
    const byId = await as('prof', request(app).post('/api/admin/conversations')).send({ courseId: COURSE, studentClass: CLASS, studentId: 'alu_00000000000000a1', texto: 'Ana, tudo bem?' });
    assert.equal(byId.status, 201, JSON.stringify(byId.body));
    // Aluno de outra turma: o guarda de escopo do professor barra antes (403).
    const outsider = await as('prof', request(app).post('/api/admin/conversations')).send({ courseId: COURSE, studentClass: CLASS, studentEmail: CAIO, texto: 'Oi' });
    assert.equal(outsider.status, 403);
    const unknown = await as('prof', request(app).post('/api/admin/conversations')).send({ courseId: COURSE, studentClass: CLASS, studentEmail: 'ninguem@aluno.local', texto: 'Oi' });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.code, 'student_not_in_class');
    const outOfScope = await as('prof', request(app).post('/api/admin/conversations')).send({ courseId: COURSE, studentClass: OTHER, studentEmail: CAIO, texto: 'Oi' });
    assert.equal(outOfScope.status, 403);
    for (const who of ['coord', 'mon']) {
        assert.equal((await as(who, request(app).get('/api/admin/conversations'))).status, 403, who);
        assert.equal((await as(who, request(app).post('/api/admin/conversations')).send({ courseId: COURSE, studentClass: CLASS, studentEmail: ANA, texto: 'Oi' })).status, 403, who);
    }
    // O aluno inativo não recebe conversa nova.
    db.memory.students.find(item => item.email === ANA).status = 'Inativo';
    try {
        const inactive = await as('prof', request(app).post('/api/admin/conversations')).send({ courseId: COURSE, studentClass: CLASS, studentEmail: ANA, texto: 'Oi' });
        assert.equal(inactive.status, 400);
        assert.equal(inactive.body.code, 'student_not_in_class');
    } finally {
        db.memory.students.find(item => item.email === ANA).status = 'Ativo';
    }
});

// ---------------------------------------------------------------------------
// [UC-MENSAGEM-002] sigilo e leitura pela administração
// ---------------------------------------------------------------------------

test('[UC-MENSAGEM-002] outro aluno e outro professor recebem 404; a lista de cada um só tem as dele; GET não grava', async () => {
    const conv = await startOk({ texto: 'Assunto pessoal' });
    for (const [who, req] of [
        ['Bia', asStudent(BIA, request(app).get(`/api/student/conversations/${conv.id}/messages`))],
        ['Bia responde', asStudent(BIA, request(app).post(`/api/student/conversations/${conv.id}/messages`)).send({ texto: 'Oi' })],
        ['Bia lê', asStudent(BIA, request(app).post(`/api/student/conversations/${conv.id}/read`)).send({})],
        ['Bruna (mesma turma)', as('profB', request(app).get(`/api/admin/conversations/${conv.id}/messages`))],
        ['Bruna responde', as('profB', request(app).post(`/api/admin/conversations/${conv.id}/messages`)).send({ texto: 'Oi' })],
        ['Bruna encerra', as('profB', request(app).post(`/api/admin/conversations/${conv.id}/close`)).send({})],
        ['Outra (outra turma)', as('prof2', request(app).get(`/api/admin/conversations/${conv.id}/messages`))],
    ]) {
        const res = await req;
        assert.equal(res.status, 404, `${who}: ${JSON.stringify(res.body)}`);
    }
    assert.deepEqual((await asStudent(BIA, request(app).get(`/api/student/conversations?${Q}`))).body.conversas, []);
    assert.deepEqual((await as('profB', request(app).get('/api/admin/conversations'))).body.conversas, []);

    const spy = spySaves();
    try {
        const mine = await asStudent(ANA, request(app).get(`/api/student/conversations/${conv.id}/messages`));
        assert.equal(mine.status, 200);
        assert.deepEqual(mine.body.mensagens.map(item => [item.autor, item.nome, item.texto]), [['voce', 'Você', 'Assunto pessoal']]);
        const prof = await as('prof', request(app).get(`/api/admin/conversations/${conv.id}/messages`));
        assert.equal(prof.status, 200);
        assert.deepEqual(prof.body.mensagens.map(item => [item.autor, item.nome, item.voce]), [['aluno', 'Ana Souza', false]]);
        assert.equal(prof.body.conversa.naoLidas, 1);
        assert.equal((await as('prof', request(app).get('/api/admin/conversations'))).status, 200);
        assert.equal((await asStudent(ANA, request(app).get(`/api/student/conversations?${Q}`))).status, 200);
    } finally { spy.restore(); }
    assert.deepEqual(spy.saves, [], 'ler não grava');
});

test('[UC-MENSAGEM-002] o administrador lê a conversa dos outros só depois do admin-open, que fica na auditoria uma vez por dia; não escreve nela', async () => {
    const conv = await startOk({ texto: 'Preciso falar com o senhor' });
    const list = await as('prof', request(app).get('/api/admin/conversations'));
    assert.equal(list.body.aviso, 'O administrador da escola pode ler estas mensagens.');
    assert.equal(list.body.podeLerTodas, false);
    assert.equal((await as('prof', request(app).get('/api/admin/conversations?todas=1'))).status, 403, 'professor não vê as de todos');
    const studentList = await asStudent(ANA, request(app).get(`/api/student/conversations?${Q}`));
    assert.equal(studentList.body.aviso, 'O administrador da escola pode ler estas mensagens.');

    const own = await as('admin', request(app).get('/api/admin/conversations'));
    assert.deepEqual(own.body.conversas, [], 'sem todas=1, só as do próprio administrador');
    const all = await as('admin', request(app).get('/api/admin/conversations?todas=1'));
    assert.equal(all.status, 200);
    assert.equal(all.body.podeLerTodas, true);
    assert.deepEqual(all.body.conversas.map(row => [row.id, row.participante, row.naoLidas, row.instrutor.nome]), [[conv.id, false, 0, 'Prof. Alan']]);

    const blocked = await as('admin', request(app).get(`/api/admin/conversations/${conv.id}/messages`));
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'admin_open_required');
    // Professor não abre como administrador (guarda: messages.readAll).
    assert.equal((await as('prof', request(app).post(`/api/admin/conversations/${conv.id}/admin-open`)).send({})).status, 403);

    const spy = spySaves();
    let opened;
    try {
        opened = await as('admin', request(app).post(`/api/admin/conversations/${conv.id}/admin-open`)).send({});
    } finally { spy.restore(); }
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal(opened.body.registrado, true);
    assert.deepEqual(spy.saves, [{ only: ['auditLogs'] }]);
    const entry = audits('conversation_read_by_admin')[0];
    assert.equal(entry.category, 'privacy');
    assert.equal(entry.actor, ADMIN);
    assert.equal(entry.studentEmail, ANA);
    assert.deepEqual([entry.courseId, entry.studentClass, entry.details.conversationId, entry.details.instrutor], [COURSE, CLASS, conv.id, PROF]);
    const again = await as('admin', request(app).post(`/api/admin/conversations/${conv.id}/admin-open`)).send({});
    assert.equal(again.body.registrado, false);
    assert.equal(audits('conversation_read_by_admin').length, 1, 'uma vez por dia e conversa');
    // Outro processo (sem o cache): a trilha vale.
    resetAdminOpenCacheForTests();
    const read = await as('admin', request(app).get(`/api/admin/conversations/${conv.id}/messages`));
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.leituraAdministrativa, true);
    assert.equal(read.body.mensagens[0].texto, 'Preciso falar com o senhor');
    // Entrada de ontem não vale hoje.
    entry.timestamp -= 2 * 24 * 60 * 60 * 1000;
    resetAdminOpenCacheForTests();
    assert.equal((await as('admin', request(app).get(`/api/admin/conversations/${conv.id}/messages`))).status, 403);

    for (const [action, payload] of [['messages', { texto: 'Oi' }], ['read', {}], ['close', {}], ['reopen', {}]]) {
        const res = await as('admin', request(app).post(`/api/admin/conversations/${conv.id}/${action}`)).send(payload);
        assert.equal(res.status, 403, action);
        assert.equal(res.body.code, 'not_participant', action);
    }
});

// ---------------------------------------------------------------------------
// [UC-MENSAGEM-003] regras
// ---------------------------------------------------------------------------

test('[UC-MENSAGEM-003] texto vazio, só espaços, com mais de 2000 caracteres ou de tipo errado dá 400 em português; controle sai e HTML fica como texto', async () => {
    const conv = await startOk({ texto: 'Primeira' });
    const post = texto => asStudent(ANA, request(app).post(`/api/student/conversations/${conv.id}/messages`)).send({ texto });
    for (const texto of ['', '     ', '\n\t  \n']) {
        const res = await post(texto);
        assert.equal(res.status, 400, JSON.stringify(texto));
        assert.match(res.body.error, /mensagem/i);
    }
    const tooLong = await post('a'.repeat(2001));
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.error, 'O campo "mensagem" aceita no máximo 2.000 caracteres.');
    assert.equal((await post(12)).status, 400);
    // Só caracteres de controle: depois de limpar, fica vazia.
    const control = await post('\u0007\u0000');
    assert.equal(control.status, 400);
    assert.equal(control.body.code, 'empty_message');
    const ok = await post('<script>alert(1)</script>\u0007 fim');
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.mensagem.texto, '<script>alert(1)</script> fim');
    const exact = await post('b'.repeat(2000));
    assert.equal(exact.status, 201);
    const subject = await studentStart({ assunto: 'x'.repeat(121) });
    assert.equal(subject.status, 400);
});

test('[UC-MENSAGEM-003] limites por conta: a 21ª mensagem em 10 minutos e a 6ª conversa nova do dia dão 429 com Retry-After', async () => {
    const conv = await startOk({ texto: '1' });
    for (let index = 2; index <= 20; index++) {
        const res = await asStudent(ANA, request(app).post(`/api/student/conversations/${conv.id}/messages`)).send({ texto: String(index) });
        assert.equal(res.status, 201, `${index}: ${JSON.stringify(res.body)}`);
    }
    const blocked = await asStudent(ANA, request(app).post(`/api/student/conversations/${conv.id}/messages`)).send({ texto: '21' });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, 'rate_limited');
    assert.ok(Number(blocked.headers['retry-after']) > 0);
    assert.match(blocked.body.error, /^Você mandou muitas mensagens em pouco tempo\. Tente de novo em \d+ minutos?\.$/);
    assert.equal(db.memory.conversations[0].mensagens, 20, 'a recusada não grava');
    // O professor não tem limite de mensagem.
    for (let index = 0; index < 25; index++) {
        assert.equal((await as('prof', request(app).post(`/api/admin/conversations/${conv.id}/messages`)).send({ texto: `p${index}` })).status, 201);
    }

    // Conversas novas: 5 por dia (encerrada pelo professor, a próxima é nova).
    rateLimit.resetForTests();
    await as('prof', request(app).post(`/api/admin/conversations/${conv.id}/close`)).send({});
    for (let index = 1; index <= 4; index++) {
        const res = await studentStart({ texto: `nova ${index}` });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        await as('prof', request(app).post(`/api/admin/conversations/${res.body.conversa.id}/close`)).send({});
    }
    const fifth = await studentStart({ texto: 'nova 5', destinatario: await refOf('Prof. Bruna') });
    assert.equal(fifth.status, 201);
    const sixth = await studentStart({ texto: 'nova 6', destinatario: await refOf('Administração') });
    assert.equal(sixth.status, 429);
    assert.match(sixth.body.error, /muitas conversas hoje/);
    // Continuar a aberta com a Bruna não é conversa nova.
    const same = await studentStart({ texto: 'continua', destinatario: await refOf('Prof. Bruna') });
    assert.equal(same.status, 200, JSON.stringify(same.body));
});

test('[UC-MENSAGEM-003] com tentativa de prova aberta o aluno não envia (409 exam_in_progress); o professor escreve e o aluno lê depois', async () => {
    const conv = await startOk({ texto: 'Antes da prova' });
    db.memory.examApplications = [{ id: 'app_prova', examKey: 'Avaliacao_1', courseId: COURSE, studentClass: CLASS, status: 'running', startedAt: new Date().toISOString() }];
    db.memory.studentExamState = { [`${ANA}_Avaliacao_1`]: { studentEmail: ANA, examKey: 'Avaliacao_1', applicationId: 'app_prova', status: 'in_progress', startedAt: Date.now() } };
    const reply = await asStudent(ANA, request(app).post(`/api/student/conversations/${conv.id}/messages`)).send({ texto: 'Professor, a questão 3...' });
    assert.equal(reply.status, 409);
    assert.deepEqual([reply.body.code, reply.body.error], ['exam_in_progress', 'Durante a prova, fale com o professor pelo botão da prova.']);
    const start = await studentStart({ texto: 'Nova', destinatario: await refOf('Prof. Bruna') });
    assert.equal(start.status, 409);
    assert.equal(start.body.code, 'exam_in_progress');
    const list = await asStudent(ANA, request(app).get(`/api/student/conversations?${Q}`));
    assert.equal(list.body.emProva, true);
    assert.equal((await as('prof', request(app).post(`/api/admin/conversations/${conv.id}/messages`)).send({ texto: 'Foco na prova!' })).status, 201);
    const read = await asStudent(ANA, request(app).get(`/api/student/conversations/${conv.id}/messages`));
    assert.equal(read.status, 200);
    assert.equal(read.body.mensagens.at(-1).texto, 'Foco na prova!');
    // Prova entregue: volta a escrever.
    db.memory.studentExamState[`${ANA}_Avaliacao_1`].status = 'submitted';
    assert.equal((await asStudent(ANA, request(app).post(`/api/student/conversations/${conv.id}/messages`)).send({ texto: 'Terminei' })).status, 201);
});

test('[UC-MENSAGEM-003] encerrar e reabrir: encerrada dá 409 ao aluno e aceita o professor; auditoria na mesma gravação; uma aberta por par', async () => {
    const conv = await startOk({ texto: 'Oi' });
    const spy = spySaves();
    let closed;
    try {
        closed = await as('prof', request(app).post(`/api/admin/conversations/${conv.id}/close`)).send({ motivo: '  Saiu do assunto  ' });
    } finally { spy.restore(); }
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.deepEqual(spy.saves, [{ only: ['conversations', 'auditLogs'] }]);
    assert.equal(closed.body.conversa.status, 'encerrada');
    const entry = audits('conversation_closed')[0];
    assert.deepEqual([entry.category, entry.actor, entry.studentEmail, entry.courseId, entry.studentClass, entry.details.conversationId, entry.details.motivo],
        ['student', PROF, ANA, COURSE, CLASS, conv.id, 'Saiu do assunto']);
    assert.equal((await as('prof', request(app).post(`/api/admin/conversations/${conv.id}/close`)).send({})).body.changed, false);
    assert.equal(audits('conversation_closed').length, 1, 'encerrar de novo não registra');

    const student = await asStudent(ANA, request(app).post(`/api/student/conversations/${conv.id}/messages`)).send({ texto: 'Mas professor...' });
    assert.equal(student.status, 409);
    assert.deepEqual([student.body.code, student.body.error], ['conversation_closed', 'O professor encerrou esta conversa. Você pode começar outra.']);
    assert.equal((await as('prof', request(app).post(`/api/admin/conversations/${conv.id}/messages`)).send({ texto: 'Fale comigo na aula.' })).status, 201);

    // Começar de novo com o mesmo professor cria outra conversa (a encerrada não recebe).
    const other = await startOk({ texto: 'Outro assunto' });
    assert.notEqual(other.id, conv.id);
    const conflict = await as('prof', request(app).post(`/api/admin/conversations/${conv.id}/reopen`)).send({});
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'conversation_open_exists');
    assert.equal(conflict.body.conversationId, other.id);
    await as('prof', request(app).post(`/api/admin/conversations/${other.id}/close`)).send({});
    const reopened = await as('prof', request(app).post(`/api/admin/conversations/${conv.id}/reopen`)).send({});
    assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
    assert.equal(reopened.body.conversa.status, 'aberta');
    assert.equal(audits('conversation_reopened')[0].details.conversationId, conv.id);
    assert.equal((await asStudent(ANA, request(app).post(`/api/student/conversations/${conv.id}/messages`)).send({ texto: 'Obrigada' })).status, 201);
});

test('[UC-MENSAGEM-003] arquivar só para o aluno; mensagem nova tira do arquivo; professor que não atende mais a turma não recebe resposta', async () => {
    const conv = await startOk({ texto: 'Oi' });
    const archived = await asStudent(ANA, request(app).post(`/api/student/conversations/${conv.id}/archive`)).send({ arquivada: true });
    assert.equal(archived.status, 200, JSON.stringify(archived.body));
    assert.equal(archived.body.conversa.arquivada, true);
    assert.deepEqual((await asStudent(ANA, request(app).get(`/api/student/conversations?${Q}`))).body.conversas, []);
    assert.deepEqual((await asStudent(ANA, request(app).get(`/api/student/conversations?${Q}&arquivadas=1`))).body.conversas.map(row => row.id), [conv.id]);
    assert.equal((await as('prof', request(app).get('/api/admin/conversations'))).body.conversas.length, 1, 'o professor continua vendo');
    assert.equal((await asStudent(ANA, request(app).post(`/api/student/conversations/${conv.id}/archive`)).send({ arquivada: 'sim' })).status, 400);
    await as('prof', request(app).post(`/api/admin/conversations/${conv.id}/messages`)).send({ texto: 'Resposta' });
    assert.deepEqual((await asStudent(ANA, request(app).get(`/api/student/conversations?${Q}`))).body.conversas.map(row => [row.id, row.naoLidas]), [[conv.id, 1]]);

    // O professor perdeu a turma: o aluno lê, mas não responde.
    db.memory.admins.find(item => item.email === PROF).assignedClasses = [{ courseId: COURSE, className: OTHER }];
    const reply = await asStudent(ANA, request(app).post(`/api/student/conversations/${conv.id}/messages`)).send({ texto: 'E agora?' });
    assert.equal(reply.status, 409);
    assert.equal(reply.body.code, 'instructor_unavailable');
    assert.equal((await asStudent(ANA, request(app).get(`/api/student/conversations/${conv.id}/messages`))).status, 200);
    // E ele, sem a turma no escopo, não abre a conversa (guarda pela turma do registro).
    assert.equal((await as('prof', request(app).get(`/api/admin/conversations/${conv.id}/messages`))).status, 403);
    assert.equal((await as('prof', request(app).get('/api/admin/conversations'))).body.conversas.length, 0);
});

// ---------------------------------------------------------------------------
// [UC-MENSAGEM-004] sino, fila e consulta a cada 10 s
// ---------------------------------------------------------------------------

test('[UC-MENSAGEM-004] sino do aluno: item mensagem pela marca lidaAte; "Marcar como lidas" do sino não marca a conversa; read zera', async () => {
    const conv = await startOk({ assunto: 'Revisão', texto: 'Oi' });
    const bell = async () => (await asStudent(ANA, request(app).get(`/api/student/notifications?${Q}`))).body.items.filter(item => item.type === 'mensagem');
    assert.deepEqual(await bell(), [], 'a própria mensagem não toca o sino');
    await as('prof', request(app).post(`/api/admin/conversations/${conv.id}/messages`)).send({ texto: 'Pode sim' });
    const items = await bell();
    assert.equal(items.length, 1);
    assert.deepEqual([items[0].id, items[0].title, items[0].text, items[0].href, items[0].unread], [`mensagem:${conv.id}`, 'Mensagem de Prof. Alan', 'Revisão', `/aluno/mensagens?c=${conv.id}`, true]);
    assert.equal((await asStudent(ANA, request(app).post('/api/student/notifications/seen')).send({ courseId: COURSE, studentClass: CLASS, ids: items.map(item => item.id) })).status, 200);
    assert.equal((await bell()).length, 1, 'o carimbo do sino não marca a conversa');
    assert.equal((await asStudent(BIA, request(app).get(`/api/student/notifications?${Q}`))).body.items.filter(item => item.type === 'mensagem').length, 0, 'outro aluno não vê');

    const spy = spySaves();
    let read;
    try {
        read = await asStudent(ANA, request(app).post(`/api/student/conversations/${conv.id}/read`)).send({});
    } finally { spy.restore(); }
    assert.equal(read.status, 200);
    assert.equal(read.body.changed, true);
    assert.deepEqual(spy.saves, [{ only: ['conversations'] }]);
    assert.deepEqual(await bell(), []);
    const again = await asStudent(ANA, request(app).post(`/api/student/conversations/${conv.id}/read`)).send({});
    assert.equal(again.body.changed, false, 'sem mudança, sem gravação');
});

test('[UC-MENSAGEM-004] sino do aluno: mensagensNovas conta as conversas antes do corte de 30 itens (avisos mais novos não somem com o número do menu)', async () => {
    const conv = await startOk({ assunto: 'Antiga', texto: 'Oi' });
    await as('prof', request(app).post(`/api/admin/conversations/${conv.id}/messages`)).send({ texto: 'Resposta antiga' });
    const later = Date.now() + 60000;
    db.memory.announcements = Array.from({ length: 35 }, (_, index) => ({
        id: `aviso_${index}`, title: `Aviso ${index}`, message: 'Texto', target: 'turma', targetValue: CLASS, courseId: COURSE,
        createdAt: later + index, readBy: [],
    }));
    try {
        const res = await asStudent(ANA, request(app).get(`/api/student/notifications?${Q}`));
        assert.equal(res.status, 200);
        assert.equal(res.body.items.length, 30);
        assert.equal(res.body.items.filter(item => item.type === 'mensagem').length, 0, 'a conversa antiga saiu da lista do sino');
        assert.equal(res.body.mensagensNovas, 1, 'mas o número do menu continua certo');
    } finally { db.memory.announcements = []; }
    await asStudent(ANA, request(app).post(`/api/student/conversations/${conv.id}/read`)).send({});
    assert.equal((await asStudent(ANA, request(app).get(`/api/student/notifications?${Q}`))).body.mensagensNovas, 0);
});

test('[UC-MENSAGEM-004] fila e sino do instrutor: "N conversas com mensagem nova" só para o professor da conversa; read tira', async () => {
    const conv = await startOk({ texto: 'Oi' });
    await startOk({ texto: 'Oi também' }, BIA);
    const queue = async who => (await as(who, request(app).get(`/api/admin/dashboard/queue?${Q}`))).body.filter(item => item.id === 'mensagens');
    const items = await queue('prof');
    assert.equal(items.length, 1, JSON.stringify(items));
    assert.deepEqual([items[0].titulo, items[0].count, items[0].href, items[0].permissao], ['2 conversas com mensagem nova', 2, '/mensagens', 'page.messages']);
    assert.deepEqual(await queue('profB'), [], 'não é dela');
    assert.deepEqual(await queue('admin'), [], 'o administrador não recebe as dos outros');
    const bell = await as('prof', request(app).get(`/api/admin/notifications?${Q}`));
    assert.equal(bell.body.items.filter(item => item.type === 'mensagens').length, 1);
    // O número do menu vem somado antes do corte da lista do sino (revisão do C14).
    assert.equal(bell.body.mensagensNovas, 2);
    assert.equal((await as('profB', request(app).get(`/api/admin/notifications?${Q}`))).body.mensagensNovas, 0);
    // Sem turma escolhida (Dashboard da instituição), a fila conta as do professor.
    assert.equal((await as('prof', request(app).get('/api/admin/dashboard/queue'))).body.filter(item => item.id === 'mensagens')[0].count, 2);

    await as('prof', request(app).post(`/api/admin/conversations/${conv.id}/read`)).send({});
    assert.equal((await queue('prof'))[0].titulo, '1 conversa com mensagem nova');
    const list = await as('prof', request(app).get('/api/admin/conversations'));
    assert.deepEqual(list.body.conversas.map(row => [row.aluno.nome, row.naoLidas]), [['Bia', 1], ['Ana Souza', 0]]);
    assert.equal(list.body.naoLidas, 1);
    // Turma que saiu do escopo dele: a conversa não abre (403), então não entra na conta.
    const prof = db.memory.admins.find(item => item.email === PROF);
    const before = prof.assignedClasses;
    prof.assignedClasses = [{ courseId: COURSE, className: OTHER }];
    try {
        assert.deepEqual((await as('prof', request(app).get('/api/admin/dashboard/queue'))).body.filter(item => item.id === 'mensagens'), []);
    } finally { prof.assignedClasses = before; }
});

test('[UC-MENSAGEM-004] consulta "depois de": só as novas, com o carimbo sempre crescente (nada se perde no mesmo milissegundo)', async () => {
    const conv = await startOk({ texto: 'Um' });
    const realNow = Date.now;
    const frozen = realNow();
    Date.now = () => frozen;
    try {
        await as('prof', request(app).post(`/api/admin/conversations/${conv.id}/messages`)).send({ texto: 'Dois' });
        await as('prof', request(app).post(`/api/admin/conversations/${conv.id}/messages`)).send({ texto: 'Três' });
    } finally { Date.now = realNow; }
    const stamps = db.memory.conversationMessages.map(msg => msg.criadaEm);
    assert.ok(stamps[1] > stamps[0] && stamps[2] > stamps[1], JSON.stringify(stamps));
    const after = await asStudent(ANA, request(app).get(`/api/student/conversations/${conv.id}/messages?depois=${stamps[1]}`));
    assert.deepEqual(after.body.mensagens.map(item => item.texto), ['Três']);
    const all = await asStudent(ANA, request(app).get(`/api/student/conversations/${conv.id}/messages`));
    assert.deepEqual(all.body.mensagens.map(item => [item.autor, item.texto]), [['voce', 'Um'], ['instrutor', 'Dois'], ['instrutor', 'Três']]);
    assert.equal(all.body.conversa.naoLidas, 2);
    const before = await asStudent(ANA, request(app).get(`/api/student/conversations/${conv.id}/messages?antes=${stamps[2]}`));
    assert.deepEqual(before.body.mensagens.map(item => item.texto), ['Um', 'Dois']);
    // Marca até a segunda: falta uma.
    await asStudent(ANA, request(app).post(`/api/student/conversations/${conv.id}/read`)).send({ ate: stamps[1] });
    assert.equal((await asStudent(ANA, request(app).get(`/api/student/conversations?${Q}`))).body.conversas[0].naoLidas, 1);
    // Marca no futuro fica na última mensagem; nunca volta para trás.
    await asStudent(ANA, request(app).post(`/api/student/conversations/${conv.id}/read`)).send({ ate: stamps[2] + 999999 });
    assert.equal(db.memory.conversations[0].lidaAte.aluno, stamps[2]);
    assert.equal((await asStudent(ANA, request(app).post(`/api/student/conversations/${conv.id}/read`)).send({ ate: stamps[0] })).body.changed, false);
});

// ---------------------------------------------------------------------------
// [UC-MENSAGEM-005] ciclo de vida, backup e pré-visualização
// ---------------------------------------------------------------------------

test('[UC-MENSAGEM-005] troca de e-mail renomeia o aluno da conversa e o autor das mensagens dele; Meus dados traz a seção Conversas', async () => {
    const conv = await startOk({ assunto: 'Estágio', texto: 'Professor, e o estágio?' }, BIA);
    await as('prof', request(app).post(`/api/admin/conversations/${conv.id}/messages`)).send({ texto: 'Vamos ver.' });
    const res = await as('admin', request(app).post('/api/admin/student/update')).send({ originalEmail: BIA, email: 'bia.nova@conversas.local', name: 'Beatriz Lima', studentClass: CLASS, classes: [{ name: CLASS, courseId: COURSE }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(db.memory.conversations[0].aluno.email, 'bia.nova@conversas.local');
    assert.deepEqual(db.memory.conversationMessages.map(msg => msg.autorEmail), ['bia.nova@conversas.local', PROF]);

    tokens.bia2 = createStudentSession(db.memory, 'bia.nova@conversas.local');
    const mine = await request(app).get('/api/student/my-data?finalidade=baixar').set('x-session-token', tokens.bia2);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.deepEqual(mine.body.conversas.map(row => [row.conversa, row.turma, row.professor, row.autor, row.mensagem]), [
        ['Estágio', CLASS, 'Prof. Alan', 'Você', 'Professor, e o estágio?'],
        ['Estágio', CLASS, 'Prof. Alan', 'Professor', 'Vamos ver.'],
    ]);
    assert.equal(typeof mine.body.conversas[0].enviadaEm, 'number');
    // O campo "curso" é o nome do curso, não o código (J2, pendência leve do C13).
    assert.equal(mine.body.conversas[0].curso, 'Curso das conversas');
    assert.equal(mine.body.extraSections.find(item => item.key === 'conversas').label, 'Conversas com professores');
    assert.equal(JSON.stringify(mine.body.conversas).includes(PROF), false, 'sem o e-mail do professor na versão do aluno');
    const admin = await as('admin', request(app).get(`/api/admin/lgpd/students/export?email=${encodeURIComponent('bia.nova@conversas.local')}&finalidade=baixar`));
    assert.equal(admin.status, 200);
    assert.equal(admin.body.conversas[0].professorEmail, PROF);
    assert.equal(admin.body.conversas[0].conversationId, conv.id);
});

test('[UC-MENSAGEM-005] anonimizar: o texto do aluno sai, o do professor fica sem o nome dele, o assunto dele sai; apagar de vez tira conversa e mensagens', async () => {
    const conv = await startOk({ assunto: 'Problema da Ana', texto: 'Meu nome é Ana Souza, matrícula MAT-a1' });
    await as('prof', request(app).post(`/api/admin/conversations/${conv.id}/messages`)).send({ texto: 'Ana Souza, fale comigo (ana@conversas.local).' });
    await as('prof', request(app).post(`/api/admin/conversations/${conv.id}/close`)).send({ motivo: 'Resolvido com a Ana Souza' });
    const byProf = await as('prof', request(app).post('/api/admin/conversations')).send({ courseId: COURSE, studentClass: CLASS, studentEmail: ANA, assunto: 'Notas de Ana Souza', texto: 'Oi' });
    assert.equal(byProf.status, 201);
    const bia = await startOk({ texto: 'Sou a Bia' }, BIA);

    db.memory.students.find(item => item.email === ANA).status = 'Transferido';
    const closed = await as('admin', request(app).get('/api/admin/students/closed'));
    assert.equal(closed.body.items.find(item => item.email === ANA).counts.conversations, 2);
    assert.equal(closed.body.countLabels.conversations, 'Conversas com professores');
    const anonymized = await as('admin', request(app).post('/api/admin/students/anonymize')).send({ email: ANA, confirm: 'ANONIMIZAR', reason: 'Pedido da família' });
    assert.equal(anonymized.status, 200, JSON.stringify(anonymized.body));
    assert.equal(anonymized.body.kept.conversations, 2);
    const pseudonym = db.memory.students.find(item => item.status === 'Anonimizado').email;
    const rows = db.memory.conversations.filter(item => item.id !== bia.id);
    assert.ok(rows.every(item => item.aluno.email === pseudonym && item.aluno.studentId === null));
    assert.equal(rows.find(item => item.id === conv.id).assunto, '', 'o assunto escrito pelo aluno sai');
    assert.equal(rows.find(item => item.id === byProf.body.conversa.id).assunto, 'Notas de aluno');
    assert.equal(rows.find(item => item.id === conv.id).motivoEncerramento, 'Resolvido com a aluno');
    const texts = db.memory.conversationMessages.filter(msg => msg.conversationId !== bia.id).map(msg => msg.texto);
    assert.deepEqual(texts, ['[mensagem removida na anonimização]', 'aluno, fale comigo (aluno).', 'Oi']);
    const all = JSON.stringify([db.memory.conversations, db.memory.conversationMessages, db.memory.auditLogs.filter(entry => String(entry.action).startsWith('conversation_'))]);
    for (const leak of ['Ana Souza', ANA, 'MAT-a1']) assert.equal(all.includes(leak), false, leak);
    assert.equal(db.memory.conversationMessages.find(msg => msg.conversationId === bia.id).texto, 'Sou a Bia', 'a da Bia fica');
    // O professor continua com o histórico (o aluno aparece pelo pseudônimo).
    const profList = await as('prof', request(app).get('/api/admin/conversations'));
    assert.equal(profList.body.conversas.filter(row => row.aluno.nome.startsWith('Aluno anonimizado')).length, 2, JSON.stringify(profList.body.conversas.map(row => row.aluno)));

    db.memory.students.find(item => item.email === BIA).status = 'Concluído';
    const purged = await as('admin', request(app).post('/api/admin/students/purge')).send({ email: BIA, confirm: 'APAGAR', reason: 'Pedido da família' });
    assert.equal(purged.status, 200, JSON.stringify(purged.body));
    assert.equal(purged.body.removed.conversations, 1);
    assert.equal(db.memory.conversations.some(item => item.id === bia.id), false);
    assert.equal(db.memory.conversationMessages.some(msg => msg.conversationId === bia.id), false);
    assert.equal(JSON.stringify([db.memory.conversations, db.memory.conversationMessages]).includes(BIA), false);
});

test('[UC-MENSAGEM-005] anonimizar tira do texto do professor o primeiro nome, o sobrenome solto e o nome sem acento; partícula do nome fica', async () => {
    const ana = db.memory.students.find(item => item.email === ANA);
    ana.name = 'Ana Júlia dos Santos Souza';
    ana.matricula = '2024001';
    const conv = await startOk({ texto: 'Oi, professor' });
    const textos = [
        'Oi Ana, tudo bem? Souza, matrícula 2024001.',
        'ANA, a Julia (sem acento) e a JÚLIA falaram com os Santos.',
        'Recado dos professores para a turma.',
        'Anabela não é ela; Souzana também não.',
    ];
    for (const texto of textos) {
        const res = await as('prof', request(app).post(`/api/admin/conversations/${conv.id}/messages`)).send({ texto });
        assert.equal(res.status, 201, JSON.stringify(res.body));
    }
    ana.status = 'Transferido';
    const anonymized = await as('admin', request(app).post('/api/admin/students/anonymize')).send({ email: ANA, confirm: 'ANONIMIZAR', reason: 'Pedido da família' });
    assert.equal(anonymized.status, 200, JSON.stringify(anonymized.body));
    const texts = db.memory.conversationMessages.filter(msg => msg.conversationId === conv.id).map(msg => msg.texto);
    assert.deepEqual(texts, [
        '[mensagem removida na anonimização]',
        'Oi aluno, tudo bem? aluno, matrícula.',
        'aluno, a aluno (sem acento) e a aluno falaram com os aluno.',
        'Recado dos professores para a turma.',
        'Anabela não é ela; Souzana também não.',
    ]);
    for (const leak of [/\bAna\b/i, /J[uú]lia/i, /Souza\b/, /Santos/, /2024001/]) {
        assert.equal(texts.slice(1, 3).some(texto => leak.test(texto)), false, String(leak));
    }
});

// Rodada 2 do C13: o sobrenome com hífen ficava ("Souza-Lima", porque só as partes
// entravam e a borda não aceita hífen colado) e a arrumação de espaços mudava a forma da
// mensagem do professor que nem citava o aluno.
test('[UC-MENSAGEM-005] anonimizar tira o sobrenome com hífen e não muda a forma da mensagem do professor sem o nome', async () => {
    const ana = db.memory.students.find(item => item.email === ANA);
    ana.name = 'Ana Souza-Lima';
    const conv = await startOk({ texto: 'Oi, professor' });
    const lista = 'Lista:\n    1.  primeiro  item\n    2.  segundo ( ) ok !';
    const textos = [
        'Souza-Lima, fale comigo.',
        'Recado para a SOUZA-LIMA e para a souza lima; Lima e Souza também.',
        lista,
        'Anabela-Souzana fica.',
    ];
    for (const texto of textos) {
        const res = await as('prof', request(app).post(`/api/admin/conversations/${conv.id}/messages`)).send({ texto });
        assert.equal(res.status, 201, JSON.stringify(res.body));
    }
    ana.status = 'Transferido';
    const anonymized = await as('admin', request(app).post('/api/admin/students/anonymize')).send({ email: ANA, confirm: 'ANONIMIZAR', reason: 'Pedido da família' });
    assert.equal(anonymized.status, 200, JSON.stringify(anonymized.body));
    const texts = db.memory.conversationMessages.filter(msg => msg.conversationId === conv.id).map(msg => msg.texto);
    assert.deepEqual(texts, [
        '[mensagem removida na anonimização]',
        'aluno, fale comigo.',
        'Recado para a aluno e para a aluno aluno; aluno e aluno também.',
        lista,
        'Anabela-Souzana fica.',
    ]);
    assert.equal(/souza|lima/i.test(texts.slice(1, 3).join(' ')), false);
});

// Rodada 2 do C13: backup de antes da anonimização restaurado traz de volta o cadastro com
// o e-mail original, e a conversa fica com o do pseudônimo. A lista mostrava o endereço
// interno como nome do aluno.
test('[UC-MENSAGEM-005] conversa com o e-mail do pseudônimo sem o cadastro ao lado aparece com o nome do pseudônimo', async () => {
    const conv = await startOk({ texto: 'Oi, professor' });
    const original = { ...db.memory.students.find(item => item.email === ANA) };
    db.memory.students.find(item => item.email === ANA).status = 'Transferido';
    const anonymized = await as('admin', request(app).post('/api/admin/students/anonymize')).send({ email: ANA, confirm: 'ANONIMIZAR', reason: 'Pedido da família' });
    assert.equal(anonymized.status, 200, JSON.stringify(anonymized.body));
    const pseudonym = db.memory.students.find(item => item.status === 'Anonimizado');
    // Como a restauração do backup antigo: o cadastro volta como era; a conversa não muda.
    db.memory.students = db.memory.students.map(item => (item === pseudonym ? original : item));
    const row = (await as('prof', request(app).get('/api/admin/conversations'))).body.conversas.find(item => item.id === conv.id);
    assert.equal(row.aluno.nome, pseudonym.name, JSON.stringify(row.aluno));
    assert.equal(row.aluno.ativo, false);
    const read = await as('prof', request(app).get(`/api/admin/conversations/${conv.id}/messages`));
    assert.equal(read.status, 200);
    assert.equal(JSON.stringify(read.body).includes(`"nome":"${pseudonym.email}"`), false);
    assert.equal(read.body.conversa.aluno.nome, pseudonym.name);
});

test('[UC-MENSAGEM-005] anonimizar encerra a conversa aberta; cadastro encerrado ou anonimizado não recebe mensagem nem reabre (409 student_inactive)', async () => {
    const conv = await startOk({ texto: 'Oi, professor' });
    const bia = await startOk({ texto: 'Sou a Bia' }, BIA);

    // Desligado (sem anonimizar): o professor só consulta; reativado, volta a escrever.
    const beatriz = db.memory.students.find(item => item.email === BIA);
    beatriz.status = 'Inativo';
    const inactive = await as('prof', request(app).post(`/api/admin/conversations/${bia.id}/messages`)).send({ texto: 'Bia, volte!' });
    assert.equal(inactive.status, 409, JSON.stringify(inactive.body));
    assert.deepEqual([inactive.body.code, inactive.body.error], ['student_inactive', 'O cadastro deste aluno está encerrado. A conversa fica só para consulta.']);
    const listed = await as('prof', request(app).get('/api/admin/conversations'));
    assert.equal(listed.body.conversas.find(row => row.id === bia.id).aluno.ativo, false);
    assert.equal(listed.body.conversas.find(row => row.id === conv.id).aluno.ativo, true);
    await as('prof', request(app).post(`/api/admin/conversations/${bia.id}/close`)).send({});
    assert.equal((await as('prof', request(app).post(`/api/admin/conversations/${bia.id}/reopen`)).send({})).body.code, 'student_inactive');
    beatriz.status = 'Ativo';
    assert.equal((await as('prof', request(app).post(`/api/admin/conversations/${bia.id}/reopen`)).send({})).status, 200);
    assert.equal((await as('prof', request(app).post(`/api/admin/conversations/${bia.id}/messages`)).send({ texto: 'Que bom que voltou.' })).status, 201);

    // Anonimizado: a aberta fica encerrada pelo sistema; escrever e reabrir dão 409 e nada
    // volta para a conversa.
    db.memory.students.find(item => item.email === ANA).status = 'Transferido';
    const anonymized = await as('admin', request(app).post('/api/admin/students/anonymize')).send({ email: ANA, confirm: 'ANONIMIZAR', reason: 'Pedido da família' });
    assert.equal(anonymized.status, 200, JSON.stringify(anonymized.body));
    const row = db.memory.conversations.find(item => item.id === conv.id);
    assert.deepEqual([row.status, row.encerradaPor, row.motivoEncerramento], ['encerrada', 'sistema', 'Cadastro do aluno anonimizado']);
    assert.equal(typeof row.encerradaEm, 'number');
    const before = db.memory.conversationMessages.length;
    const post = await as('prof', request(app).post(`/api/admin/conversations/${conv.id}/messages`)).send({ texto: 'Ana Souza, volte!' });
    assert.equal(post.status, 409, JSON.stringify(post.body));
    assert.equal(post.body.code, 'student_inactive');
    const reopen = await as('prof', request(app).post(`/api/admin/conversations/${conv.id}/reopen`)).send({});
    assert.equal(reopen.status, 409);
    assert.equal(reopen.body.code, 'student_inactive');
    assert.equal(db.memory.conversationMessages.length, before);
    assert.equal(db.memory.conversations.find(item => item.id === conv.id).status, 'encerrada');
    assert.equal(JSON.stringify(db.memory.conversationMessages).includes('Ana Souza'), false);
    assert.equal(audits('conversation_reopened').filter(entry => entry.details.conversationId === conv.id).length, 0);
    // O histórico continua para consulta.
    const read = await as('prof', request(app).get(`/api/admin/conversations/${conv.id}/messages`));
    assert.equal(read.status, 200);
    assert.equal(read.body.conversa.aluno.ativo, false);
});

test('[UC-MENSAGEM-002] lista "todas da escola": a conversa dos outros vem sem assunto e sem motivo até o admin-open do dia', async () => {
    const conv = await startOk({ assunto: 'Problema em casa', texto: 'Preciso falar com o senhor' });
    await as('prof', request(app).post(`/api/admin/conversations/${conv.id}/close`)).send({ motivo: 'Conversamos na sala' });
    const hidden = (await as('admin', request(app).get('/api/admin/conversations?todas=1'))).body.conversas.find(row => row.id === conv.id);
    assert.deepEqual([hidden.assunto, hidden.motivoEncerramento, hidden.textoOculto], ['', '', true]);
    assert.equal(hidden.aluno.nome, 'Ana Souza', 'o aluno e o professor ficam, para escolher qual abrir');
    assert.equal(hidden.instrutor.nome, 'Prof. Alan');
    // O professor da conversa vê tudo na lista dele.
    const own = (await as('prof', request(app).get('/api/admin/conversations'))).body.conversas.find(row => row.id === conv.id);
    assert.deepEqual([own.assunto, own.motivoEncerramento, own.textoOculto], ['Problema em casa', 'Conversamos na sala', undefined]);

    assert.equal((await as('admin', request(app).post(`/api/admin/conversations/${conv.id}/admin-open`)).send({})).body.registrado, true);
    const shown = (await as('admin', request(app).get('/api/admin/conversations?todas=1'))).body.conversas.find(row => row.id === conv.id);
    assert.deepEqual([shown.assunto, shown.motivoEncerramento, shown.textoOculto], ['Problema em casa', 'Conversamos na sala', undefined]);
    // Outro processo (sem o cache): vale a trilha do dia; a de ontem não.
    resetAdminOpenCacheForTests();
    assert.equal((await as('admin', request(app).get('/api/admin/conversations?todas=1'))).body.conversas.find(row => row.id === conv.id).assunto, 'Problema em casa');
    audits('conversation_read_by_admin')[0].timestamp -= 2 * 24 * 60 * 60 * 1000;
    resetAdminOpenCacheForTests();
    assert.equal((await as('admin', request(app).get('/api/admin/conversations?todas=1'))).body.conversas.find(row => row.id === conv.id).textoOculto, true);
});

test('[UC-MENSAGEM-005] mesclar: as conversas do que sai passam ao que fica; duas abertas com o mesmo professor, a do que sai fica encerrada; religar o id', () => {
    const memory = {
        classes: [{ name: CLASS, courseId: COURSE }],
        courses: [{ id: COURSE, name: 'Curso' }],
        students: [
            { id: 'alu_000000000000fica', email: ANA, name: 'Ana', status: 'Ativo', classes: [{ name: CLASS, courseId: COURSE }] },
            { id: 'alu_0000000000000sai', email: 'ana.dup@conversas.local', name: 'Ana dup', status: 'Ativo', classes: [{ name: CLASS, courseId: COURSE }] },
        ],
        conversations: [
            { id: 'conv_1_aaaaaa', courseId: COURSE, studentClass: CLASS, aluno: { email: ANA, studentId: 'alu_000000000000fica' }, instrutor: { email: PROF, nome: 'Prof. Alan' }, status: 'aberta', criadaEm: 1 },
            { id: 'conv_2_bbbbbb', courseId: COURSE, studentClass: CLASS, aluno: { email: 'ana.dup@conversas.local', studentId: 'alu_0000000000000sai' }, instrutor: { email: PROF, nome: 'Prof. Alan' }, status: 'aberta', criadaEm: 2 },
            { id: 'conv_3_cccccc', courseId: COURSE, studentClass: CLASS, aluno: { email: 'ana.dup@conversas.local', studentId: 'alu_0000000000000sai' }, instrutor: { email: PROF_B, nome: 'Prof. Bruna' }, status: 'aberta', criadaEm: 3 },
        ],
        conversationMessages: [
            { id: 'msg_1', conversationId: 'conv_2_bbbbbb', autor: 'aluno', autorEmail: 'ana.dup@conversas.local', texto: 'x', criadaEm: 2 },
            { id: 'msg_2', conversationId: 'conv_3_cccccc', autor: 'instrutor', autorEmail: PROF_B, texto: 'y', criadaEm: 3 },
        ],
    };
    const fica = studentData.studentDataContext(memory, ANA);
    const sai = studentData.studentDataContext(memory, 'ana.dup@conversas.local');
    studentData.mergeStudentData(memory, fica, sai);
    assert.ok(memory.conversations.every(conv => conv.aluno.email === ANA && conv.aluno.studentId === 'alu_000000000000fica'));
    const second = memory.conversations[1];
    assert.equal(second.status, 'encerrada', 'uma aberta por par: a do que sai encerra');
    assert.equal(second.mergedFrom.length, 1);
    assert.equal(memory.conversations[2].status, 'aberta');
    assert.deepEqual(memory.conversationMessages.map(msg => msg.autorEmail), [ANA, PROF_B]);

    memory.conversations[0].aluno.studentId = 'alu_00000000000velho';
    memory.conversations[2].aluno.studentId = null;
    assert.equal(studentData.relinkStudentData(memory, { [ANA]: 'alu_000000000000fica' }), true);
    assert.equal(memory.conversations[0].aluno.studentId, 'alu_000000000000fica');
    assert.equal(memory.conversations[2].aluno.studentId, 'alu_000000000000fica');
    assert.equal(studentData.relinkStudentData(memory, { [ANA]: 'alu_000000000000fica' }), false, 'idempotente');
});

test('[UC-MENSAGEM-005] backup de antes das conversas mantém as de agora (missing keep); linha antiga lida com os padrões, sem reescrever', () => {
    for (const collection of ['conversations', 'conversationMessages']) {
        const entry = db.COLLECTION_TABLES.find(item => item.collection === collection);
        assert.ok(entry, collection);
        assert.equal(missingCollectionOutcome(entry), 'keep', collection);
    }
    assert.equal(db.COLLECTION_TABLES.find(item => item.collection === 'conversationMessages').append, true);
    const memory = {
        courses: [{ id: COURSE, name: 'Curso' }],
        classes: [{ name: CLASS, courseId: COURSE }],
        students: [],
        admins: [],
        conversations: [{ id: 'conv_velha', courseId: COURSE, studentClass: CLASS, aluno: { email: 'X@Y.local' }, instrutor: { email: PROF } }],
        conversationMessages: [{ id: 'm1', conversationId: 'conv_velha', autor: 'instrutor', texto: 'oi', criadaEm: 5 }],
    };
    const before = JSON.stringify(memory);
    const read = conversations.readConversation(memory.conversations[0]);
    assert.deepEqual([read.status, read.aluno.email, read.assunto, read.mensagens, read.lidaAte.aluno], ['encerrada', 'x@y.local', '', 0, 0]);
    // Sem ultimaDo*, o sino cai na contagem das mensagens.
    assert.equal(conversations.hasUnread(memory, memory.conversations[0], 'aluno'), true);
    const items = conversations.notificationItems({ memory, cls: memory.classes[0], email: 'x@y.local', student: { email: 'x@y.local' } });
    assert.equal(items.length, 1);
    assert.equal(JSON.stringify(memory), before, 'ler não reescreve a linha');
});

test('[UC-MENSAGEM-005] pré-visualização: a lista vem vazia, a de professores lê; começar, responder e ler a conversa ficam recusados', async () => {
    const conv = await startOk({ texto: 'Oi' });
    const opened = await as('prof', request(app).post('/api/admin/preview-sessions')).send({ courseId: COURSE, studentClass: CLASS });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const token = opened.body.previewToken;
    const before = JSON.stringify([db.memory.conversations, db.memory.conversationMessages]);
    const list = await request(app).get(`/api/student/conversations?${Q}`).set('x-preview-session', token);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body.conversas, []);
    const people = await request(app).get(`/api/student/conversations/recipients?${Q}`).set('x-preview-session', token);
    assert.equal(people.status, 200);
    assert.ok(people.body.destinatarios.length >= 1);
    for (const req of [
        request(app).post('/api/student/conversations').set('x-preview-session', token).send({ courseId: COURSE, studentClass: CLASS, destinatario: people.body.destinatarios[0].ref, texto: 'Oi' }),
        request(app).get(`/api/student/conversations/${conv.id}/messages`).set('x-preview-session', token),
        request(app).post(`/api/student/conversations/${conv.id}/messages`).set('x-preview-session', token).send({ texto: 'Oi' }),
        request(app).post(`/api/student/conversations/${conv.id}/read`).set('x-preview-session', token).send({}),
        request(app).post(`/api/student/conversations/${conv.id}/archive`).set('x-preview-session', token).send({ arquivada: true }),
    ]) {
        const res = await req;
        assert.equal(res.status, 403, JSON.stringify(res.body));
        assert.equal(res.body.code, 'preview_read_only');
    }
    assert.equal(JSON.stringify([db.memory.conversations, db.memory.conversationMessages]), before);
});
