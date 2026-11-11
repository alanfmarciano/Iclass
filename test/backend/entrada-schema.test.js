// Validação do corpo por schema e tetos do caderno (fase 2, H9b: ENG-03, ENG-04).
// utils/inputSchema.js confere tipo e tamanho dos campos que cada rota lê e responde
// 400 { success:false, error, field }; utils/studentNotes.js põe teto no caderno, nas
// anotações de parágrafo e o fórum aceita até 5.000 caracteres. Antes um número no
// lugar de um texto derrubava a rota com 500 e o aluno gravava notas de 9 MB.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-entrada-schema-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { DEMO_ACCOUNTS } = require('../../backend/utils/demoAccounts.js');
const schema = require('../../backend/utils/inputSchema.js');
const notesUtil = require('../../backend/utils/studentNotes.js');

const ADMIN_TOKEN = 'h9b-admin-token';
const PROFESSOR_TOKEN = 'h9b-professor-token';
const STUDENT_TOKEN = 'h9b-student-token';
const STUDENT_EMAIL = DEMO_ACCOUNTS.student.email;
const COURSE_ID = 'curso_legacy_01';
const CLASS_NAME = '1DES';

let app;

function openSessions() {
    const now = Date.now();
    db.memory.adminSessions = {
        [ADMIN_TOKEN]: { email: DEMO_ACCOUNTS.admin.email, createdAt: now, lastSeen: now },
        [PROFESSOR_TOKEN]: { email: DEMO_ACCOUNTS.professor.email, createdAt: now, lastSeen: now },
    };
    db.memory.sessions = {
        [STUDENT_EMAIL]: { token: STUDENT_TOKEN, createdAt: now, lastSeen: now, ip: '127.0.0.1' },
    };
}

const asAdmin = (route, token = ADMIN_TOKEN) => request(app).post(route).set('x-admin-session', token);
const asStudent = route => request(app).post(route).set('x-session-token', STUDENT_TOKEN);
const saveNote = (moduleKey, note) => asStudent('/api/student/notes/save').send({ email: STUDENT_EMAIL, moduleKey, note });
const getNote = moduleKey => asStudent('/api/student/notes/get').send({ email: STUDENT_EMAIL, moduleKey });
const annotate = (key, paragraphId, fields) => asStudent('/api/student/annotation').send({ email: STUDENT_EMAIL, key, paragraphId, ...fields });

function assertRefused(res, field, error) {
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.success, false);
    assert.equal(res.body.field, field, JSON.stringify(res.body));
    if (error !== undefined) assert.equal(res.body.error, error);
}

test.before(async () => {
    await db.init();
    app = createApp();
    const seeded = await request(app).post('/api/test/seed');
    assert.equal(seeded.status, 200);
    openSessions();
});

test.beforeEach(() => openSessions());

test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 300));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------- inputSchema

test('[UC-ERRO-003] inputSchema: texto aparado, tamanho, null, obrigatório e mensagens em português', () => {
    const field = schema.str({ max: 5, label: 'nome' });
    assert.deepEqual(field.run('  ab  ', 'name'), { ok: true, value: 'ab' });
    assert.deepEqual(field.run(undefined, 'name'), { ok: true, value: undefined });
    assert.deepEqual(field.run('abcdef', 'name'), { ok: false, field: 'name', error: 'O campo "nome" aceita no máximo 5 caracteres.' });
    assert.deepEqual(field.run(123, 'name'), { ok: false, field: 'name', error: 'O campo "nome" está em formato inválido.' });
    assert.deepEqual(field.run(null, 'name'), { ok: false, field: 'name', error: 'O campo "nome" está em formato inválido.' });
    assert.deepEqual(schema.str({ nullable: true }).run(null, 'x'), { ok: true, value: null });
    assert.deepEqual(schema.str({ required: true, label: 'nome' }).run('   ', 'name').error, 'O campo "nome" é obrigatório.');
    // Senha e anotação não são aparadas; o tamanho conta como o maxLength do navegador.
    assert.deepEqual(schema.str({ trim: false, max: 4 }).run(' ab ', 'p'), { ok: true, value: ' ab ' });
    assert.equal(schema.str({ pattern: schema.KEY_PATTERN, label: 'unidade' }).run('../x', 'k').error, 'O campo "unidade" tem caracteres não permitidos.');
    assert.equal(schema.str({ pattern: schema.KEY_PATTERN }).run('apostila_TI_Módulo 1:a-b.c', 'k').ok, true);
    // typeMessage: a rota que já tinha mensagem para o tipo errado continua com ela.
    assert.equal(schema.str({ typeMessage: 'Informe e-mail e senha.' }).run(['a'], 'email').error, 'Informe e-mail e senha.');
    assert.equal(schema.str({ max: 2, typeMessage: 'Informe e-mail e senha.', label: 'e-mail' }).run('abc', 'email').error, 'O campo "e-mail" aceita no máximo 2 caracteres.');
    assert.equal(schema.formatCount(1000000), '1.000.000');
    assert.equal(schema.formatCount(50000), '50.000');
});

test('[UC-ERRO-003] inputSchema: números, lista de valores, listas, objetos, mapas e alternativas', () => {
    const number = schema.int({ min: 1, max: 100, coerce: true, label: 'questão' });
    assert.deepEqual(number.run('7', 'n'), { ok: true, value: 7 });
    assert.equal(number.run('7a', 'n').error, 'O campo "questão" está em formato inválido.');
    assert.equal(number.run(0, 'n').error, 'O campo "questão" deve estar entre 1 e 100.');
    assert.equal(schema.int().run(1.5, 'n').ok, false);
    assert.equal(schema.num().run(1.5, 'n').ok, true);
    assert.equal(schema.bool().run('true', 'b').ok, false);

    const area = schema.oneOf(['aluno', 'painel'], { label: 'área' });
    assert.deepEqual(area.run(' aluno ', 'area'), { ok: true, value: 'aluno' });
    assert.equal(area.run('outra', 'area').error, 'O campo "área" tem um valor não permitido.');
    assert.equal(area.run(3, 'area').error, 'O campo "área" está em formato inválido.');

    const ids = schema.list(schema.str({ max: 3 }), { max: 2, label: 'ids' });
    assert.equal(ids.run(['a', 'b', 'c'], 'ids').error, 'O campo "ids" aceita no máximo 2 itens.');
    assert.deepEqual(ids.run(['a', 5], 'ids'), { ok: false, field: 'ids[1]', error: 'O campo "ids" está em formato inválido.' });

    const guardian = schema.shape({ name: schema.str({ max: 3, label: 'nome do responsável' }) });
    const value = { name: ' Ana ', extra: { livre: true } };
    assert.equal(guardian.run(value, 'guardian').ok, true);
    assert.deepEqual(value, { name: 'Ana', extra: { livre: true } }, 'normaliza o declarado e deixa o resto como veio');
    assert.equal(guardian.run({ name: 'Joana' }, 'guardian').field, 'guardian.name');
    assert.equal(guardian.run([], 'guardian').ok, false);

    const map = schema.dict(null, { maxKeys: 2, keyPattern: /^[a-z.]+$/, label: 'preferências' });
    assert.equal(map.run({ 'a.b': 1 }, 'p').ok, true);
    assert.equal(map.run(JSON.parse('{"__proto__": 1}'), 'p').ok, false);
    assert.equal(map.run({ 'a b': 1 }, 'p').error, 'O campo "preferências" tem caracteres não permitidos.');
    assert.equal(map.run({ a: 1, b: 2, c: 3 }, 'p').error, 'O campo "preferências" aceita no máximo 2 itens.');
    // O field aponta a chave enviada: dentro de um campo com ponto; no corpo, só a chave.
    assert.equal(map.run({ 'a b': 1 }, 'p').field, 'p.a b');
    assert.equal(map.run({ 'a b': 1 }, '').field, 'a b');
    assert.equal(map.run({ a: 1, b: 2, c: 3 }, '').field, 'c', 'a primeira além do limite');
    assert.equal(map.run({ ['Z'.repeat(300)]: 1 }, 'p').field, 'p', 'chave longa demais fica com o nome do mapa');
    assert.equal(schema.dict(schema.bool(), { label: 'unidades' }).run({ a: 'x' }, '').field, 'a');

    const version = schema.either([schema.str({ max: 30 }), schema.num()], { label: 'versão' });
    assert.equal(version.run('2026-11-11T10:00:00.000Z', 'v').ok, true);
    assert.equal(version.run(3, 'v').ok, true);
    assert.equal(version.run({}, 'v').error, 'O campo "versão" está em formato inválido.');
    assert.equal(version.run('x'.repeat(31), 'v').error, 'O campo "versão" aceita no máximo 30 caracteres.');
});

test('[UC-ERRO-003] body(): corpo que não é objeto recebe 400 sem campo; campo errado recebe o nome enviado', () => {
    const middleware = schema.body({ name: schema.str({ max: 3, label: 'nome' }) });
    const responder = () => {
        const out = {};
        return { out, status(code) { out.status = code; return this; }, json(payload) { out.body = payload; return this; } };
    };
    for (const payload of [[1, 2], 'texto', null]) {
        const res = responder();
        let called = false;
        middleware({ body: payload }, res, () => { called = true; });
        assert.equal(called, false);
        assert.deepEqual(res.out, { status: 400, body: { success: false, error: 'Dados enviados em formato inválido.' } });
    }
    const res = responder();
    middleware({ body: { name: 'Joana' } }, res, () => {});
    assert.deepEqual(res.out.body, { success: false, error: 'O campo "nome" aceita no máximo 3 caracteres.', field: 'name' });
    const req = { body: { name: ' Ana ', outro: 1 } };
    let next = false;
    middleware(req, responder(), () => { next = true; });
    assert.equal(next, true);
    assert.deepEqual(req.body, { name: 'Ana', outro: 1 });
});

// ---------------------------------------------------------------- rotas do aluno e públicas

test('[UC-ERRO-003] login e cadastro: campo de outro tipo recebe 400 com o campo, sem 500', async () => {
    const login = await request(app).post('/api/student/login').send({ email: 123, password: 'teste' });
    assertRefused(login, 'email', 'E-mail e senha são obrigatórios.');
    const longEmail = await request(app).post('/api/student/login').send({ email: `${'a'.repeat(250)}@x.local`, password: 'teste' });
    assertRefused(longEmail, 'email', 'O campo "e-mail" aceita no máximo 254 caracteres.');
    const admin = await request(app).post('/api/session/admin-login').send({ email: DEMO_ACCOUNTS.admin.email, password: ['teste'] });
    assertRefused(admin, 'password', 'Informe e-mail e senha.');
    const register = await request(app).post('/api/student/register').send({ name: { primeiro: 'Ana' }, email: 'nova@teste.local', password: 'Senha-forte-123' });
    assertRefused(register, 'name', 'O campo "nome" está em formato inválido.');
    // O login certo continua funcionando com o e-mail aparado.
    const ok = await request(app).post('/api/student/login').send({ email: `  ${STUDENT_EMAIL}  `, password: DEMO_ACCOUNTS.student.password });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('[UC-ERRO-003] prova e tela do aluno: tipo errado nos campos lidos responde 400 com o campo', async () => {
    assertRefused(await asStudent('/api/student/report-question').send({ email: STUDENT_EMAIL, examKey: 'x', questionNumber: 'dois', text: 'a' }), 'questionNumber');
    assertRefused(await asStudent('/api/student/notifications/seen').send({ email: STUDENT_EMAIL, ids: 'n1' }), 'ids');
    assertRefused(await asStudent('/api/student/log-activity').send({ email: STUDENT_EMAIL, examKey: 'x', eventType: 'blur', details: 'd'.repeat(2001) }), 'details');
    // Lote de teclas: até 2.000 itens na lista (o ExamRunner manda 500 por vez); acima disso
    // 400 { field: 'events' } sem gravar nada. Antes não havia teto além dos 512 KB do corpo.
    const before = db.keystrokes.stats({ email: STUDENT_EMAIL }).total;
    const tiny = Array.from({ length: 2001 }, () => ({}));
    assertRefused(await asStudent('/api/student/log-keystrokes').send({ email: STUDENT_EMAIL, studentClass: CLASS_NAME, courseId: COURSE_ID, examKey: 'Avaliacao_FUTEC_5', events: tiny }), 'events', 'O campo "eventos" aceita no máximo 2.000 itens.');
    assert.equal(db.keystrokes.stats({ email: STUDENT_EMAIL }).total, before, 'nada gravado do lote recusado');
    const area = await request(app).post('/api/client-error').set('x-session-token', STUDENT_TOKEN).send({ area: 'aluno', message: { texto: 'x' } });
    assertRefused(area, 'message', 'O campo "mensagem" está em formato inválido.');
});

// ---------------------------------------------------------------- rotas do professor

test('[UC-ERRO-003] rotas do professor que davam 500 respondem 400 com o campo', async () => {
    assertRefused(await asAdmin('/api/admin/accounts/update').send({ originalEmail: DEMO_ACCOUNTS.professor.email, assignedClasses: 123 }), 'assignedClasses');
    assertRefused(await asAdmin('/api/admin/accounts/delete').send({ email: { $ne: '' } }), 'email');
    assertRefused(await asAdmin('/api/admin/schools/create').send({ name: 42 }), 'name');
    assertRefused(await asAdmin('/api/admin/schools/update').send({ id: 'x', branding: 'azul' }), 'branding');
    assertRefused(await asAdmin('/api/admin/student/observations/create').send({ email: STUDENT_EMAIL, text: 'o'.repeat(5001) }), 'text', 'O campo "observação" aceita no máximo 5.000 caracteres.');
    // A edição tem o mesmo teto da criação.
    assertRefused(await asAdmin('/api/admin/student/observations/update').send({ id: 'obs-x', text: 'o'.repeat(5001) }), 'text', 'O campo "observação" aceita no máximo 5.000 caracteres.');
    assertRefused(await asAdmin('/api/admin/student/observations/update').send({ id: { $ne: '' } }), 'id');
    assertRefused(await asAdmin('/api/admin/student/certificates/issue').send({ email: STUDENT_EMAIL, courseName: ['TI'] }), 'courseName');
    assertRefused(await asAdmin('/api/admin/unlock-student-focus').send({ studentEmail: 1, examKey: 'x' }), 'studentEmail');
    assertRefused(await asAdmin('/api/admin/assign-student-version').send({ studentEmail: STUDENT_EMAIL, examKey: 'x', version: { v: 'A' } }), 'version');
});

test('[UC-ERRO-003] banco de questões: categoria objeto recebe 400 e a questão antiga com categoria objeto vem como "Geral"', async () => {
    const before = (db.memory.questionBank || []).length;
    const refused = await asAdmin('/api/admin/question-bank/create').send({ category: { nome: 'Redes' }, questionText: 'Qual?', alternatives: [{ letter: 'A', text: 'Sim', isCorrect: true }, { letter: 'B', text: 'Não' }], correctAnswer: 'A' });
    assertRefused(refused, 'category', 'O campo "categoria" está em formato inválido.');
    assert.equal((db.memory.questionBank || []).length, before, 'nada gravado');

    // Questão antiga gravada antes do H9b com campos de outro tipo: a tela recebe texto,
    // sem que o servidor reescreva o dado guardado (a tela branca vinha daqui).
    db.memory.questionBank.push({ key: 'qb_antiga_h9b', category: { nome: 'Redes' }, curriculumKey: 7, type: null, questionText: ['Qual?'], alternatives: [], correctAnswer: '' });
    const res = await request(app).get('/api/admin/question-bank').set('x-admin-session', ADMIN_TOKEN);
    assert.equal(res.status, 200);
    const old = res.body.questions.find(question => question.key === 'qb_antiga_h9b');
    assert.equal(old.category, 'Geral');
    assert.equal(old.curriculumKey, '');
    assert.equal(old.type, 'multiple_choice');
    assert.equal(old.questionText, '');
    const stored = db.memory.questionBank.find(question => question && question.key === 'qb_antiga_h9b');
    assert.deepEqual(stored.category, { nome: 'Redes' }, 'o dado guardado fica como estava');

    // A resposta do create e do update vem no formato da tela, como o GET; um item null
    // na lista (dado antigo) não derruba o update nem a exclusão.
    db.memory.questionBank.unshift(null);
    const updated = await asAdmin('/api/admin/question-bank/update').send({ key: 'qb_antiga_h9b', questionText: 'Qual protocolo?', alternatives: [{ letter: 'A', text: 'TCP', isCorrect: true }, { letter: 'B', text: 'UDP' }], correctAnswer: 'A' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.question.curriculumKey, '');
    assert.equal(updated.body.question.type, 'multiple_choice');
    assert.equal(updated.body.question.category, 'Geral');
    assert.equal(stored.curriculumKey, 7, 'o update não regrava o que não foi enviado');
    const created = await asAdmin('/api/admin/question-bank/create').send({ category: 'Redes', questionText: 'Qual porta?', alternatives: [{ letter: 'A', text: '80', isCorrect: true }, { letter: 'B', text: '21' }], correctAnswer: 'A' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(typeof created.body.question.questionText, 'string');
    const removed = await asAdmin('/api/admin/question-bank/delete').send({ key: created.body.question.key });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.deleted, 1);
    assert.equal(db.memory.questionBank[0], null, 'o item null fica como estava');
    db.memory.questionBank.shift();
});

test('[UC-ERRO-003] preferências: chave com espaço, mais de 100 chaves ou mais de 64 KB recebem 400; os modelos do fórum passam', async () => {
    const send = payload => asAdmin('/api/admin/preferences', PROFESSOR_TOKEN).send(payload);
    // O corpo é o próprio mapa: o field é a chave enviada que foi recusada, nunca um
    // 'preferences' que o cliente não mandou.
    assertRefused(await send({ ok: 1, 'a b': 1 }), 'a b', 'O campo "preferências" tem caracteres não permitidos.');
    assertRefused(await asAdmin('/api/admin/preferences', PROFESSOR_TOKEN).set('Content-Type', 'application/json').send('{"__proto__": {"x": 1}}'), '__proto__');
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`chave${index}`, index]));
    assertRefused(await send(many), 'chave100', 'O campo "preferências" aceita no máximo 100 itens.');
    assertRefused(await send({ 'gate.small': ['a'], 'forum.templates': ['x'.repeat(70 * 1024)] }), 'forum.templates',
        'As preferências desta conta passaram do limite de 64 KB. Limpe favoritos ou modelos de resposta antigos.');
    // Já com 99 chaves guardadas, a primeira nova além das 100 é a apontada.
    const professor = db.memory.admins.find(item => item.email === DEMO_ACCOUNTS.professor.email);
    professor.preferences = Object.fromEntries(Array.from({ length: 99 }, (_, index) => [`velha${index}`, index]));
    assertRefused(await send({ velha1: 'x', nova1: 1, nova2: 2 }), 'nova2', 'O campo "preferências" aceita no máximo 100 itens.');
    professor.preferences = {};
    const templates = await send({ 'forum.templates': ['Obrigado pela pergunta!', 'Veja a apostila, seção 2.'] });
    assert.equal(templates.status, 200, JSON.stringify(templates.body));
    assert.deepEqual(templates.body.preferences['forum.templates'], ['Obrigado pela pergunta!', 'Veja a apostila, seção 2.']);

    // Conta que já passou do limite (dado antigo) continua salvando o que diminui.
    const account = db.memory.admins.find(item => item.email === DEMO_ACCOUNTS.professor.email);
    account.preferences = { 'gate.favorites': ['f'.repeat(80 * 1024)] };
    assert.equal((await send({ 'gate.favorites': ['curso_legacy_01'] })).status, 200);
    assert.equal((await send({ 'gate.recentContexts': ['x'.repeat(70 * 1024)] })).status, 400);
});

// ---------------------------------------------------------------- caderno e anotações

test('[UC-CADERNO-001] caderno: nota até 50.000 caracteres, campos de outro tipo e unidade herdada recebem 400', async () => {
    assertRefused(await saveNote('apostila_TI_1', 'n'.repeat(50001)), 'note', 'O campo "nota" aceita no máximo 50.000 caracteres.');
    assert.equal((await saveNote('apostila_TI_1', 'n'.repeat(50000))).status, 200);
    assert.equal((await getNote('apostila_TI_1')).body.note.length, 50000);
    assertRefused(await saveNote(123, 'oi'), 'moduleKey');
    assertRefused(await saveNote('apostila_TI_1', { a: 1 }), 'note', 'O campo "nota" está em formato inválido.');
    assertRefused(await saveNote('../../etc', 'oi'), 'moduleKey', 'O campo "unidade" tem caracteres não permitidos.');
    assertRefused(await saveNote('__proto__', 'oi'), 'moduleKey', 'Unidade inválida.');
    assert.equal((await getNote('constructor')).body.note, '', 'chave herdada nunca devolve o que vem de Object');
    // A nota é guardada como veio (sem aparar).
    assert.equal((await saveNote('apostila_TI_2', '  recuo\n')).status, 200);
    assert.equal((await getNote('apostila_TI_2')).body.note, '  recuo\n');
    // Nota vazia apaga a chave; notes/get continua devolvendo ''.
    assert.equal((await saveNote('apostila_TI_2', '')).status, 200);
    assert.equal(Object.prototype.hasOwnProperty.call(db.memory.notes[STUDENT_EMAIL], 'apostila_TI_2'), false);
    assert.equal((await getNote('apostila_TI_2')).body.note, '');
});

test('[UC-CADERNO-001] caderno: até 300 unidades e 1.000.000 caracteres; nota antiga acima do limite só diminui', async () => {
    db.memory.notes[STUDENT_EMAIL] = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`unidade_${index}`, 'x']));
    assertRefused(await saveNote('unidade_nova', 'oi'), 'moduleKey', 'Seu caderno chegou ao limite de 300 unidades com anotações.');
    assert.equal((await saveNote('unidade_5', 'editada')).status, 200, 'a unidade que já existe continua editável');
    assert.equal((await saveNote('unidade_6', '')).status, 200);
    assert.equal((await saveNote('unidade_nova', 'oi')).status, 200, 'apagar uma libera a vaga');

    // Dado antigo (gravado antes do H9b): uma nota de 60.000 e um caderno de 1,2 milhão.
    db.memory.notes[STUDENT_EMAIL] = { antiga: 'a'.repeat(60000) };
    assert.equal((await saveNote('antiga', 'a'.repeat(59000))).status, 200, 'pode diminuir');
    assertRefused(await saveNote('antiga', 'a'.repeat(61000)), 'note', 'O campo "nota" aceita no máximo 50.000 caracteres.');
    assert.equal(db.memory.notes[STUDENT_EMAIL].antiga.length, 59000, 'nada se perde na recusa');

    db.memory.notes[STUDENT_EMAIL] = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`u${index}`, 'b'.repeat(40000)]));
    assert.equal(notesUtil.notesTotal(db.memory.notes[STUDENT_EMAIL]), 1200000);
    assertRefused(await saveNote('u_nova', 'oi'), 'note',
        'Seu caderno chegou ao limite total de 1.000.000 caracteres. Apague anotações antigas para continuar.');
    assertRefused(await saveNote('u1', 'b'.repeat(40001)), 'note');
    assert.equal((await saveNote('u1', 'b'.repeat(100))).status, 200, 'diminuir passa mesmo acima do total');
    assert.equal(db.memory.notes[STUDENT_EMAIL].u2.length, 40000, 'nenhuma nota antiga é apagada ou encurtada');
    delete db.memory.notes[STUDENT_EMAIL];
});

test('[UC-CADERNO-001] caderno: nota antiga que não é texto chega à tela como texto, sem regravar', async () => {
    db.memory.notes[STUDENT_EMAIL] = { objeto: { titulo: 'Redes', itens: [1, 2] }, numero: 42, lista: ['a', 'b'], zero: 0, falso: false };
    assert.equal((await getNote('objeto')).body.note, '{"titulo":"Redes","itens":[1,2]}', 'antes: a tela mostrava "[object Object]"');
    assert.equal((await getNote('numero')).body.note, '42');
    assert.equal((await getNote('lista')).body.note, '["a","b"]');
    assert.equal((await getNote('zero')).body.note, '0');
    assert.equal((await getNote('falso')).body.note, 'false');
    assert.deepEqual(db.memory.notes[STUDENT_EMAIL].objeto, { titulo: 'Redes', itens: [1, 2] }, 'a leitura não regrava');
    // O aluno edita o texto que viu e grava (do mesmo tamanho ou menor: passa).
    assert.equal((await saveNote('objeto', 'Redes: itens 1 e 2')).status, 200);
    assert.equal(db.memory.notes[STUDENT_EMAIL].objeto, 'Redes: itens 1 e 2');
    assert.equal(notesUtil.noteForScreen(undefined), '');
    assert.equal(notesUtil.noteForScreen(null), '');
    delete db.memory.notes[STUDENT_EMAIL];
});

test('[UC-CADERNO-001] anotações: trecho destacado guardado com 1.000, nota até 5.000, parágrafo no formato da tela e até 500 por unidade', async () => {
    const saved = await annotate('apostila_TI_1', 'p3', { highlightedText: 'h'.repeat(5000), note: 'minha nota' });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const stored = db.memory.annotations[STUDENT_EMAIL].apostila_TI_1.p3;
    assert.equal(stored.highlightedText.length, 1000);
    assert.equal(stored.note, 'minha nota');
    assertRefused(await annotate('apostila_TI_1', 'p3', { highlightedText: 'h', note: 'n'.repeat(5001) }), 'note', 'O campo "anotação" aceita no máximo 5.000 caracteres.');
    assertRefused(await annotate('apostila_TI_1', '../x', { highlightedText: 'h', note: 'n' }), 'paragraphId');
    assertRefused(await annotate('apostila_TI_1', 'p4', { highlightedText: 'h', note: 12 }), 'note');
    assertRefused(await annotate({ k: 1 }, 'p4', { highlightedText: 'h', note: 'n' }), 'key');

    const full = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`p${index + 1}`, { highlightedText: 'h', note: 'n', timestamp: 'x' }]));
    db.memory.annotations[STUDENT_EMAIL] = { cheia: full };
    assertRefused(await annotate('cheia', 'p501', { highlightedText: 'h', note: 'n' }), 'paragraphId', 'Limite de anotações desta unidade atingido.');
    assert.equal((await annotate('cheia', 'p10', { highlightedText: 'h', note: 'outra' })).status, 200, 'editar a que existe passa');
    assert.equal((await annotate('cheia', 'p11', { highlightedText: null, note: null })).status, 200, 'apagar sempre passa');
    assert.equal(Object.keys(db.memory.annotations[STUDENT_EMAIL].cheia).length, 499);

    db.memory.annotations[STUDENT_EMAIL] = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`u${index}`, { p1: { note: 'n' } }]));
    assertRefused(await annotate('u_nova', 'p1', { highlightedText: 'h', note: 'n' }), 'key', 'Você chegou ao limite de 300 unidades com anotações.');
    const list = await request(app).get('/api/student/annotations').set('x-session-token', STUDENT_TOKEN).query({ key: 'constructor' });
    assert.deepEqual(list.body.annotations, {}, 'chave herdada não devolve o que vem de Object');
    delete db.memory.annotations[STUDENT_EMAIL];
});

test('[UC-CADERNO-001] anotações antigas: acima de 5.000 só diminuem e as guardadas em outro formato são convertidas sem perder nada', async () => {
    // Anotação gravada antes do teto, com 6.000 caracteres: pode ser editada sem crescer.
    db.memory.annotations[STUDENT_EMAIL] = { Apostila_A: { 'p-1': { highlightedText: 'h', note: 'n'.repeat(6000), timestamp: 'x' } } };
    assert.equal((await annotate('Apostila_A', 'p-1', { highlightedText: 'h', note: 'n'.repeat(5500) })).status, 200, 'diminuir passa');
    assertRefused(await annotate('Apostila_A', 'p-1', { highlightedText: 'h', note: 'n'.repeat(5600) }), 'note', 'O campo "anotação" aceita no máximo 5.000 caracteres.');
    assert.equal(db.memory.annotations[STUDENT_EMAIL].Apostila_A['p-1'].note.length, 5500, 'nada se perde na recusa');
    assertRefused(await annotate('Apostila_A', 'p-2', { highlightedText: 'h', note: 'n'.repeat(5001) }), 'note'); // parágrafo novo segue o teto

    // Formato antigo (decisões §12, sobra do H9b): antes 409 legacy_format; agora o servidor
    // converte na leitura e na gravação (texto vira uma entrada do mapa, lista vira texto
    // JSON legível) e grava normalmente.
    const listAnnotations = key => request(app).get('/api/student/annotations').set('x-session-token', STUDENT_TOKEN).query({ key });
    db.memory.annotations[STUDENT_EMAIL] = { Apostila_X: 'texto-legado', Apostila_L: ['a'] };
    // Leitura: convertida, sem regravar.
    const readX = await listAnnotations('Apostila_X').expect(200);
    assert.deepEqual(readX.body.annotations, { 'anotacao-anterior': { highlightedText: '', note: 'texto-legado', timestamp: null } });
    assert.equal(db.memory.annotations[STUDENT_EMAIL].Apostila_X, 'texto-legado', 'ler não regrava');
    // Apagar o que não existe não muda nada.
    assert.equal((await annotate('Apostila_X', 'p-1', { highlightedText: null, note: null })).status, 200);
    assert.equal(db.memory.annotations[STUDENT_EMAIL].Apostila_X, 'texto-legado');
    for (const key of ['Apostila_X', 'Apostila_L']) {
        const saved = await annotate(key, 'p-1', { highlightedText: 'h', note: 'nova' });
        assert.equal(saved.status, 200, JSON.stringify(saved.body));
        assert.equal(db.memory.annotations[STUDENT_EMAIL][key]['p-1'].note, 'nova');
    }
    assert.equal(db.memory.annotations[STUDENT_EMAIL].Apostila_X['anotacao-anterior'].note, 'texto-legado', 'o texto antigo fica');
    assert.equal(db.memory.annotations[STUDENT_EMAIL].Apostila_L['anotacao-anterior'].note, JSON.stringify(['a'], null, 2));
    assert.equal((await annotate('Apostila_N', 'p-1', { highlightedText: 'h', note: 'n' })).status, 200, 'as outras unidades continuam');

    // O mapa do aluno inteiro em outro formato: convertido na anotação e no caderno.
    db.memory.annotations[STUDENT_EMAIL] = 'mapa-legado';
    assert.equal((await annotate('Apostila_A', 'p-1', { highlightedText: null, note: null })).status, 200);
    assert.equal(db.memory.annotations[STUDENT_EMAIL], 'mapa-legado', 'apagar o que não existe não converte');
    assert.equal((await listAnnotations('anotacoes-anteriores').expect(200)).body.annotations['anotacao-anterior'].note, 'mapa-legado');
    assert.equal((await annotate('Apostila_A', 'p-1', { highlightedText: 'h', note: 'n' })).status, 200);
    assert.equal(db.memory.annotations[STUDENT_EMAIL].Apostila_A['p-1'].note, 'n');
    assert.equal(db.memory.annotations[STUDENT_EMAIL]['anotacoes-anteriores']['anotacao-anterior'].note, 'mapa-legado');
    db.memory.notes[STUDENT_EMAIL] = 'caderno-legado';
    assert.equal((await getNote('0')).body.note, '', 'não lê letra do texto antigo como nota');
    assert.equal((await getNote('anotacoes-anteriores')).body.note, 'caderno-legado', 'o texto antigo é lido como nota');
    assert.equal((await saveNote('apostila_TI_1', '')).status, 200);
    assert.equal(db.memory.notes[STUDENT_EMAIL], 'caderno-legado', 'apagar o que não existe não converte');
    const note = await saveNote('apostila_TI_1', 'oi');
    assert.equal(note.status, 200, JSON.stringify(note.body));
    assert.deepEqual(db.memory.notes[STUDENT_EMAIL], { 'anotacoes-anteriores': 'caderno-legado', apostila_TI_1: 'oi' });
    db.memory.notes[STUDENT_EMAIL] = [{ titulo: 'x' }];
    assert.equal((await saveNote('apostila_TI_1', 'oi')).status, 200);
    assert.equal(db.memory.notes[STUDENT_EMAIL]['anotacoes-anteriores'], JSON.stringify([{ titulo: 'x' }], null, 2));

    // A leitura das anotações devolve sempre texto (como o notes/get), sem "[object Object]".
    db.memory.annotations[STUDENT_EMAIL] = { Apostila_O: { p1: { highlightedText: { trecho: 'a' }, note: 42, timestamp: 't' }, p2: 'solta', p3: { note: null } } };
    const read = (await listAnnotations('Apostila_O').expect(200)).body.annotations;
    assert.deepEqual(read.p1, { highlightedText: '{"trecho":"a"}', note: '42', timestamp: 't' });
    assert.deepEqual(read.p2, { highlightedText: '', note: 'solta', timestamp: null });
    assert.deepEqual(read.p3, { highlightedText: '', note: '' });
    assert.equal(typeof db.memory.annotations[STUDENT_EMAIL].Apostila_O.p1.note, 'number', 'ler não regrava');
    delete db.memory.notes[STUDENT_EMAIL];
    delete db.memory.annotations[STUDENT_EMAIL];
});

test('[UC-CADERNO-001] fórum: dúvida e resposta com até 5.000 caracteres; texto de outro tipo recebe 400', async () => {
    const context = { email: STUDENT_EMAIL, courseId: COURSE_ID, studentClass: CLASS_NAME, key: 'geral' };
    assertRefused(await asStudent('/api/forum/comment').send({ ...context, text: 123 }), 'text', 'O campo "texto" está em formato inválido.');
    assertRefused(await asStudent('/api/forum/comment').send({ ...context, text: 't'.repeat(5001) }), 'text', 'O campo "texto" aceita no máximo 5.000 caracteres.');
    const created = await asStudent('/api/forum/comment').send({ ...context, text: 't'.repeat(5000) });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const commentId = created.body.comment.id;
    assertRefused(await asStudent('/api/forum/reply').send({ ...context, commentId, text: { a: 1 } }), 'text');
    assertRefused(await asStudent('/api/forum/comment/edit').send({ ...context, commentId, text: 'e'.repeat(5001) }), 'text');
    assertRefused(await asAdmin('/api/forum/reply').send({ commentId, courseId: COURSE_ID, studentClass: CLASS_NAME, text: 'r'.repeat(5001) }), 'text');
    const reply = await asAdmin('/api/forum/reply').send({ commentId, courseId: COURSE_ID, studentClass: CLASS_NAME, text: '  Veja a seção 2.  ' });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.reply.text, 'Veja a seção 2.');
});
