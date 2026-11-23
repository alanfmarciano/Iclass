// Banco de questões no modelo único, com metadados e estatística (fase 3, P3-S9a:
// AVA-15; decisões D3 e D21 do desenho P3). O banco guarda os seis tipos pela mesma regra
// da avaliação, com dificuldade, habilidades, etiquetas, autor, revisão e "Arquivar"; o
// GET filtra e devolve a estatística calculada na hora (usos e % de acerto, só com as
// entregas consideradas); a questão que veio do banco leva bankKey na avaliação e no
// snapshot da aplicação, e é por ela que as entregas contam.
// A importação e a exportação GIFT e planilha (P3-S9b, D22) estão no fim, em
// [UC-BANCO-002].
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-question-bank-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { alternativeAnswerId } = require('../../backend/utils/examAnswerIds.js');
const { questionBankStats, normalizeBankQuestion } = require('../../backend/utils/questionBank.js');
const questionFormats = require('../../backend/utils/questionFormats.js');
const { buildXlsx } = require('../../backend/utils/tabularFile.js');

let app;
const adminToken = 'admin-token-question-bank';
const professorToken = 'professor-token-question-bank';
const adminEmail = 'admin@banco.local';
const professorEmail = 'prof@banco.local';
const courseId = 'curso-banco';
const otherCourse = 'curso-outro';
const studentClass = '1RED';
const examKey = 'Avaliacao_Banco';
const otherExamKey = 'Avaliacao_Outra';
const student = { email: 'ana@banco.local', token: 'token-ana-banco' };

const asAdmin = (method, url) => request(app)[method](url).set('x-admin-session', adminToken);
const asProfessor = (method, url) => request(app)[method](url).set('x-admin-session', professorToken);
const audits = action => (db.memory.auditLogs || []).filter(entry => entry.action === action);

// As seis questões como o editor manda (editorQuestionPayload), com os metadados.
const ITEMS = {
    multiple_choice: { type: 'multiple_choice', points: 2, text: 'Qual porta o HTTP usa?', alternatives: [{ letter: 'A', text: '80', isCorrect: true }, { letter: 'B', text: '21' }], correctAnswer: 'A', explanation: 'Porta **80**.', difficulty: 'facil', tags: ['redes', 'HTTP'], skills: ['Competência 3'] },
    multiple_answer: { type: 'multiple_answer', points: 3, text: 'Quais são de transporte?', alternatives: [{ text: 'TCP', isCorrect: true }, { text: 'HTTP' }, { text: 'UDP', isCorrect: true }], correctAnswers: ['A', 'C'], partialCredit: false, difficulty: 'media', tags: ['Redes'] },
    true_false: { type: 'true_false', text: 'IPv4 tem 32 bits.', correctAnswer: 'A', difficulty: 'facil' },
    numeric: { type: 'numeric', points: 1.5, text: 'Quantos hosts numa /26?', numeric: { value: 62, tolerance: 0, unit: 'hosts' }, review: 'auto', difficulty: 'dificil', tags: ['sub-rede'] },
    short_answer: { type: 'short_answer', text: 'Comando que lista arquivos?', acceptedAnswers: ['ls', 'ls -l'], review: 'professor' },
    essay: { type: 'essay', points: 4, text: 'Explique o handshake.', expectedAnswer: 'SYN, SYN-ACK, ACK', rubric: [{ nome: 'Etapas', pontos: 3 }, { nome: 'Clareza', pontos: 1 }] },
};

function seed() {
    db.memory.admins = [
        { email: adminEmail, name: 'Admin', role: 'admin', password: db.hashPassword('senha-administrativa') },
        { email: professorEmail, name: 'Professora', role: 'professor', password: db.hashPassword('senha-administrativa'), assignedClasses: [{ courseId, className: studentClass }] },
    ];
    db.memory.adminSessions = {
        [adminToken]: { email: adminEmail, createdAt: Date.now(), lastSeen: Date.now() },
        [professorToken]: { email: professorEmail, createdAt: Date.now(), lastSeen: Date.now() },
    };
    db.memory.students = [{ name: 'Ana', email: student.email, status: 'Ativo', classes: [{ name: studentClass, courseId }] }];
    db.memory.sessions = { [student.email]: { token: student.token, lastSeen: Date.now(), ip: '127.0.0.1' } };
    db.memory.courses = [
        { id: courseId, name: 'Redes', structure: [{ name: 'Módulo', units: [{ avaliacaoKey: examKey }] }] },
        { id: otherCourse, name: 'Outro', structure: [{ name: 'Módulo', units: [{ avaliacaoKey: otherExamKey }] }] },
    ];
    db.memory.classes = [
        { name: studentClass, courseId, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} },
        { name: '2OUT', courseId: otherCourse, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} },
    ];
    db.memory.evaluations = { [examKey]: { key: examKey, title: 'Prova de redes', questions: [] } };
    db.memory.questionBank = [];
    db.memory.submissions = [];
    db.memory.examApplications = [];
    db.memory.studentExamState = {};
    db.memory.proctoringLogs = [];
    db.memory.broadcastMessages = [];
    db.memory.auditLogs = [];
}

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

async function create(payload, extra = {}) {
    const response = await asAdmin('post', '/api/admin/question-bank/create').send({ category: 'Redes', ...payload, ...extra });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.question;
}

test('[UC-BANCO-001] o banco guarda os seis tipos pelo modelo da avaliação, com autor, revisão e auditoria', async () => {
    seed();
    const created = {};
    for (const [type, payload] of Object.entries(ITEMS)) created[type] = await create(payload);
    const stored = key => db.memory.questionBank.find(item => item.key === key);

    const choice = stored(created.multiple_choice.key);
    assert.equal(choice.type, 'multiple_choice');
    assert.equal(choice.points, 2);
    assert.equal(choice.questionText, 'Qual porta o HTTP usa?');
    assert.equal('text' in choice, false, 'o enunciado fica em questionText, o nome de sempre do banco');
    assert.equal(choice.correctAnswer, 'A');
    assert.equal(choice.explanation, 'Porta **80**.');
    assert.equal(choice.difficulty, 'facil');
    assert.deepEqual(choice.tags, ['redes', 'HTTP']);
    assert.deepEqual(choice.skills, ['Competência 3']);
    assert.equal(choice.author, adminEmail);
    assert.equal(choice.updatedBy, adminEmail);
    assert.equal(choice.revision, 1);
    assert.equal(choice.archived, false);
    assert.equal(typeof choice.createdAt, 'string');

    assert.deepEqual(stored(created.multiple_answer.key).correctAnswers, ['A', 'C']);
    assert.equal(stored(created.multiple_answer.key).partialCredit, false);
    assert.deepEqual(stored(created.true_false.key).alternatives.map(alternative => alternative.text), ['Verdadeiro', 'Falso']);
    assert.equal(stored(created.true_false.key).points, 1, 'sem pontos vale 1');
    assert.deepEqual(stored(created.numeric.key).numeric, { value: 62, tolerance: 0, unit: 'hosts' });
    assert.deepEqual(stored(created.short_answer.key).acceptedAnswers, ['ls', 'ls -l']);
    assert.equal(stored(created.short_answer.key).review, 'professor');
    assert.deepEqual(stored(created.essay.key).rubric.map(criterion => criterion.id), ['c1', 'c2']);
    assert.equal(stored(created.essay.key).expectedAnswer, 'SYN, SYN-ACK, ACK');

    const logged = audits('question_created');
    assert.equal(logged.length, 6);
    assert.deepEqual(logged.map(entry => entry.details.tipo), Object.keys(ITEMS));
    assert.equal(logged[0].details.key, created.multiple_choice.key);
    assert.equal(logged[0].details.categoria, 'Redes');
    assert.equal(logged[0].category, 'academic');

    // A mesma regra da avaliação, com a mensagem sem "Questão N:".
    const noAccepted = await asAdmin('post', '/api/admin/question-bank/create').send({ category: 'Redes', type: 'short_answer', text: 'Q?', acceptedAnswers: [] });
    assert.equal(noAccepted.status, 400);
    assert.equal(noAccepted.body.error, 'Informe pelo menos uma resposta aceita.');
    const wrongRubric = await asAdmin('post', '/api/admin/question-bank/create').send({ ...ITEMS.essay, points: 5 });
    assert.equal(wrongRubric.status, 400);
    assert.equal(wrongRubric.body.error, 'A soma dos critérios da rubrica (4) precisa ser igual aos pontos da questão (5).');
    const badDifficulty = await asAdmin('post', '/api/admin/question-bank/create').send({ ...ITEMS.true_false, difficulty: 'impossivel' });
    assert.equal(badDifficulty.status, 400);
    assert.equal(badDifficulty.body.error, 'A dificuldade deve ser fácil, média ou difícil.');
    const badField = await asAdmin('post', '/api/admin/question-bank/create').send({ ...ITEMS.numeric, numeric: 'sessenta' });
    assert.equal(badField.status, 400);
    assert.equal(badField.body.field, 'numeric');
    const empty = await asAdmin('post', '/api/admin/question-bank/create').send({});
    assert.equal(empty.body.error, 'Texto da questão é obrigatório.');
    assert.equal(db.memory.questionBank.length, 6, 'nada recusado foi gravado');
    assert.equal(audits('question_created').length, 6);
});

test('[UC-BANCO-001] alterar sobe a revisão e audita os campos; salvar igual não grava; item antigo ganha revisão 1', async () => {
    seed();
    const item = await create(ITEMS.multiple_choice);
    const updated = await asAdmin('post', '/api/admin/question-bank/update').send({ ...ITEMS.multiple_choice, key: item.key, points: 3, difficulty: '', tags: [] });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.question.revision, 2);
    const stored = db.memory.questionBank.find(entry => entry.key === item.key);
    assert.equal(stored.points, 3);
    assert.equal('difficulty' in stored, false, 'dificuldade vazia limpa');
    assert.equal('tags' in stored, false, 'etiquetas vazias limpam');
    assert.deepEqual(stored.skills, ['Competência 3'], 'o que não veio fica');
    assert.equal(stored.author, adminEmail);
    const change = audits('question_updated').pop();
    assert.equal(change.details.key, item.key);
    assert.equal(change.details.revision, 2);
    assert.deepEqual(change.details.campos.sort(), ['difficulty', 'points', 'tags']);

    // Mesma coisa de novo: nada muda, nada é gravado.
    const before = audits('question_updated').length;
    const same = await asAdmin('post', '/api/admin/question-bank/update').send({ ...ITEMS.multiple_choice, key: item.key, points: 3, difficulty: '', tags: [] });
    assert.equal(same.status, 200);
    assert.equal(same.body.unchanged, true);
    assert.equal(same.body.question.revision, 2);
    assert.equal(audits('question_updated').length, before);

    // Só a letra certa: a marca antiga não conta junto (antes daria "marque exatamente uma").
    const letter = await asAdmin('post', '/api/admin/question-bank/update').send({ key: item.key, correctAnswer: 'B' });
    assert.equal(letter.status, 200, JSON.stringify(letter.body));
    assert.equal(stored.correctAnswer, 'B');
    assert.deepEqual(stored.alternatives.map(alternative => alternative.isCorrect), [false, true]);
    // Trocar o tipo pelo pedido inteiro, como o editor faz.
    const toEssay = await asAdmin('post', '/api/admin/question-bank/update').send({ ...ITEMS.essay, key: item.key });
    assert.equal(toEssay.status, 200, JSON.stringify(toEssay.body));
    assert.equal(stored.type, 'essay');
    assert.deepEqual(stored.alternatives, []);
    assert.equal('explanation' in stored, true, 'a explicação de antes fica (o pedido não mandou)');

    // Item antigo (281029f): sem revisão, sem type, com o enunciado em text.
    db.memory.questionBank.push({ key: 'qb_antigo', category: 'Fundamentos', curriculumKey: '', text: 'Quanto é 2 + 2?', alternatives: [{ letter: 'A', text: '3' }, { letter: 'B', text: '4', isCorrect: true }], correctAnswer: 'B', sourceExamKey: null, createdAt: '2026-10-19T13:20:00.000Z' });
    const list = await asAdmin('get', '/api/admin/question-bank').expect(200);
    const old = list.body.questions.find(question => question.key === 'qb_antigo');
    assert.equal(old.type, 'multiple_choice');
    assert.equal(old.questionText, 'Quanto é 2 + 2?');
    assert.equal(old.revision, 0);
    assert.equal(old.archived, false);
    assert.deepEqual(old.stats, { usos: 0, respostas: 0, pendentes: 0, acertoPct: null });
    const legacyStored = db.memory.questionBank.find(entry => entry.key === 'qb_antigo');
    assert.equal(legacyStored.text, 'Quanto é 2 + 2?', 'o GET não regrava');
    // Salvar o item antigo como está (o que a tela manda ao abrir e salvar) não reescreve nem audita.
    const auditBefore = db.memory.auditLogs.length;
    const untouched = await asAdmin('post', '/api/admin/question-bank/update').send({ key: 'qb_antigo', category: 'Fundamentos', curriculumKey: '', type: 'multiple_choice', points: 1, questionText: 'Quanto é 2 + 2?', alternatives: old.alternatives, correctAnswer: 'B', difficulty: '', skills: [], tags: [] }).expect(200);
    assert.equal(untouched.body.unchanged, true, JSON.stringify(untouched.body));
    assert.equal(legacyStored.text, 'Quanto é 2 + 2?');
    assert.equal('revision' in legacyStored, false);
    assert.equal(db.memory.auditLogs.length, auditBefore);
    const saved = await asAdmin('post', '/api/admin/question-bank/update').send({ key: 'qb_antigo', category: 'Fundamentos', questionText: 'Quanto é 2 + 2?', alternatives: old.alternatives, correctAnswer: 'B', difficulty: 'facil' });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(legacyStored.revision, 1);
    assert.equal(legacyStored.type, 'multiple_choice');
    assert.equal(legacyStored.points, 1);
    assert.equal(legacyStored.questionText, 'Quanto é 2 + 2?');
    assert.equal('text' in legacyStored, false);
    assert.equal(legacyStored.createdAt, '2026-10-19T13:20:00.000Z');
});

test('[UC-BANCO-001] arquivar tira da lista padrão sem apagar; desarquivar devolve; a auditoria registra cada um', async () => {
    seed();
    const kept = await create(ITEMS.true_false);
    const archived = await create(ITEMS.numeric);
    const done = await asAdmin('post', '/api/admin/question-bank/archive').send({ key: archived.key, archived: true }).expect(200);
    assert.equal(done.body.question.archived, true);
    assert.equal(audits('question_archived').length, 1);
    assert.equal(audits('question_archived')[0].details.key, archived.key);
    // Arquivar de novo não grava outra vez.
    await asAdmin('post', '/api/admin/question-bank/archive').send({ key: archived.key }).expect(200);
    assert.equal(audits('question_archived').length, 1);

    const standard = await asAdmin('get', '/api/admin/question-bank').expect(200);
    assert.deepEqual(standard.body.questions.map(question => question.key), [kept.key]);
    assert.equal(standard.body.total, 1);
    assert.equal(standard.body.archivedCount, 1);
    const all = await asAdmin('get', '/api/admin/question-bank?arquivadas=1').expect(200);
    assert.deepEqual(all.body.questions.map(question => question.key), [kept.key, archived.key]);
    assert.equal(db.memory.questionBank.length, 2, 'nada foi apagado');

    await asAdmin('post', '/api/admin/question-bank/archive').send({ key: archived.key, archived: false }).expect(200);
    assert.equal(audits('question_restored').length, 1);
    assert.equal((await asAdmin('get', '/api/admin/question-bank').expect(200)).body.questions.length, 2);
    assert.equal((await asAdmin('post', '/api/admin/question-bank/archive').send({ key: 'nao-existe' })).status, 404);
    assert.equal((await asAdmin('post', '/api/admin/question-bank/archive').send({ key: archived.key, archived: 'sim' })).status, 400);
});

test('[UC-BANCO-001] filtros por categoria, tipo, dificuldade, etiqueta e busca; categorias e etiquetas para a tela', async () => {
    seed();
    await create(ITEMS.multiple_choice, { category: 'Redes' });
    await create(ITEMS.multiple_answer, { category: 'redes' });
    await create(ITEMS.numeric, { category: 'Sub-redes' });
    await create(ITEMS.short_answer, { category: 'Linux' });
    const get = async query => (await asAdmin('get', `/api/admin/question-bank${query}`).expect(200)).body;
    const types = body => body.questions.map(question => question.type);

    assert.deepEqual(types(await get('?categoria=Redes')), ['multiple_choice', 'multiple_answer'], 'categoria sem diferença de maiúscula');
    assert.deepEqual(types(await get('?tipo=numeric')), ['numeric']);
    assert.deepEqual(types(await get('?dificuldade=facil')), ['multiple_choice']);
    assert.deepEqual(types(await get('?dificuldade=sem')), ['short_answer']);
    assert.deepEqual(types(await get('?tag=REDES')), ['multiple_choice', 'multiple_answer'], 'etiqueta sem diferença de maiúscula');
    assert.deepEqual(types(await get('?tag=sub-rede')), ['numeric']);
    assert.deepEqual(types(await get('?q=62')), [], 'o gabarito da numérica não entra na busca');
    assert.deepEqual(types(await get('?q=TRANSPORTE')), ['multiple_answer']);
    assert.deepEqual(types(await get('?q=arquivos')), ['short_answer']);
    assert.deepEqual(types(await get('?q=udp')), ['multiple_answer'], 'busca no texto das alternativas');
    assert.deepEqual(types(await get('?categoria=Redes&dificuldade=media')), ['multiple_answer']);
    const facets = await get('');
    assert.deepEqual(facets.categorias, ['Linux', 'Redes', 'Sub-redes']);
    assert.deepEqual(facets.etiquetas, ['HTTP', 'redes', 'sub-rede']);

    for (const [query, field] of [['?tipo=desenho', 'tipo'], ['?dificuldade=extrema', 'dificuldade'], ['?arquivadas=talvez', 'arquivadas'], [`?q=${'x'.repeat(81)}`, 'q']]) {
        const refused = await asAdmin('get', `/api/admin/question-bank${query}`);
        assert.equal(refused.status, 400, query);
        assert.equal(refused.body.field, field, query);
    }
    // Parâmetro repetido: vale o último (parseQueryLastValue do servidor), como nas outras rotas.
    assert.deepEqual(types(await get('?tipo=essay&tipo=numeric')), ['numeric']);
});

// Rodada de ajuste 2 do A7: a categoria do item aceita 500 caracteres (vem do tema da
// prova pelo "Salvar no banco"), mas o filtro ?categoria= recusava mais de 80, e a tela,
// que filtra pela categoria inteira de "categorias", mostrava o erro com a lista sem filtro.
test('[UC-BANCO-001] filtro de categoria aceita a categoria inteira (até 500 caracteres), como a criação', async () => {
    seed();
    const longCategory = `Camada de transporte e ${'protocolos orientados a conexão '.repeat(16)}`.slice(0, 499) + 'x';
    assert.equal(longCategory.length, 500);
    const ninety = longCategory.slice(0, 90).trim();
    await create(ITEMS.multiple_choice, { category: longCategory });
    await create(ITEMS.true_false, { category: ninety });
    await create(ITEMS.numeric, { category: 'Redes' });
    const get = async query => (await asAdmin('get', `/api/admin/question-bank${query}`).expect(200)).body;
    const facets = await get('');
    assert.ok(facets.categorias.includes(longCategory), 'a categoria vai inteira para a tela');
    assert.ok(facets.categorias.includes(ninety));
    const filtered = await get(`?categoria=${encodeURIComponent(longCategory)}`);
    assert.deepEqual(filtered.questions.map(question => question.type), ['multiple_choice']);
    assert.deepEqual((await get(`?categoria=${encodeURIComponent(ninety)}`)).questions.map(question => question.type), ['true_false']);
    // Mais que a categoria aceita continua recusado, com o teto certo na mensagem.
    const refused = await asAdmin('get', `/api/admin/question-bank?categoria=${'x'.repeat(501)}`);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.field, 'categoria');
    assert.match(refused.body.error, /500 caracteres/);
    // A busca e a etiqueta continuam com o teto de 80.
    assert.equal((await asAdmin('get', `/api/admin/question-bank?tag=${'x'.repeat(81)}`)).body.field, 'tag');
});

test('[UC-BANCO-001] estatística: usos e % de acerto contam só entregas consideradas e só as turmas de quem vê', () => {
    const snapshot = (keys) => [{ version: 'A', questions: keys.map((key, index) => ({ originalNumber: index + 1, ...(key ? { bankKey: key } : {}) })) }];
    const answer = (questionNumber, fields) => ({ questionNumber, ...fields });
    const memory = {
        examApplications: [
            { id: 'app_1', status: 'finished', studentClass, courseId, versionSnapshots: snapshot(['qb_a', 'qb_b', null]) },
            { id: 'app_2', status: 'running', studentClass, courseId, versionSnapshots: [...snapshot(['qb_a']), ...snapshot(['qb_a'])] },
            { id: 'app_cancelada', status: 'cancelled', studentClass, courseId, versionSnapshots: snapshot(['qb_a']) },
            { id: 'app_outra', status: 'finished', studentClass: '2OUT', courseId: otherCourse, versionSnapshots: snapshot(['qb_a']) },
            // Troca de questão no Monitor: sourceBankKey na questão acrescentada.
            { id: 'app_troca', status: 'finished', studentClass, courseId, versionSnapshots: [{ version: 'A', questions: [{ originalNumber: 1 }, { originalNumber: 2, sourceBankKey: 'qb_c', isAdditional: true }] }] },
        ],
        classes: [{ name: studentClass, courseId, examHistory: { [examKey]: [
            { id: 'eh_impressa', type: 'impressa', printSnapshot: snapshot(['qb_b']) },
            { id: 'eh_online', type: 'online', versionSnapshots: snapshot(['qb_b']) },
        ] } }],
        submissions: [
            // Com o snapshot da entrega: 1 de 2 pontos na qb_a, acerto na qb_b.
            { id: 's1', applicationId: 'app_1', student: { studentClass, courseId }, examSnapshot: { questions: snapshot(['qb_a', 'qb_b', null])[0].questions }, gradedAnswers: [answer(1, { isCorrect: false, pointsEarned: 1, pointsPossible: 2 }), answer(2, { isCorrect: true, pointsEarned: 1, pointsPossible: 1 }), answer(3, { isCorrect: true })] },
            // Entrega antiga sem snapshot e sem pontos: o snapshot da aplicação e o acerto.
            { id: 's2', applicationId: 'app_1', student: { studentClass, courseId }, gradedAnswers: [answer(1, { isCorrect: true }), answer(2, { isCorrect: false })] },
            // Aguardando o professor e anulada.
            { id: 's3', applicationId: 'app_2', student: { studentClass, courseId }, gradedAnswers: [answer(1, { isCorrect: null, pending: true, pointsEarned: 0, pointsPossible: 2 })] },
            { id: 's4', applicationId: 'app_1', student: { studentClass, courseId }, gradedAnswers: [answer(1, { isCorrect: true, annulled: true, pointsEarned: 2, pointsPossible: 2 })] },
            // Fora da conta: arquivada, anulada por integridade, invalidada.
            { id: 's5', applicationId: 'app_1', resultStatus: 'archived', student: { studentClass, courseId }, gradedAnswers: [answer(1, { isCorrect: true, pointsEarned: 2, pointsPossible: 2 })] },
            { id: 's6', applicationId: 'app_1', integrity: { decisao: 'zero' }, student: { studentClass, courseId }, gradedAnswers: [answer(1, { isCorrect: true, pointsEarned: 2, pointsPossible: 2 })] },
            { id: 's7', applicationId: 'app_1', resultStatus: 'invalidated', student: { studentClass, courseId }, gradedAnswers: [answer(1, { isCorrect: true })] },
            // Anulação desfeita volta a contar.
            { id: 's8', applicationId: 'app_1', integrity: { decisao: 'desconsiderar', desfeitaEm: 1 }, student: { studentClass, courseId }, gradedAnswers: [answer(1, { isCorrect: false, pointsEarned: 0, pointsPossible: 2 })] },
            // Outra turma (fora do escopo do professor).
            { id: 's9', applicationId: 'app_outra', student: { studentClass: '2OUT', courseId: otherCourse }, gradedAnswers: [answer(1, { isCorrect: true, pointsEarned: 2, pointsPossible: 2 })] },
            { id: 's10', applicationId: 'app_troca', student: { studentClass, courseId }, gradedAnswers: [answer(1, { isCorrect: false }), answer(2, { isCorrect: true, pointsEarned: 1, pointsPossible: 1 })] },
            null,
        ],
    };
    const all = questionBankStats(memory);
    // qb_a: s1 (0,5), s2 (1), s8 (0), s9 (1) = 2,5 de 4; s3 pendente.
    assert.deepEqual(all.get('qb_a'), { usos: 3, respostas: 4, pendentes: 1, acertoPct: 63 });
    // qb_b: app_1 e a impressa (a configuração online do histórico não é uso).
    assert.deepEqual(all.get('qb_b'), { usos: 2, respostas: 2, pendentes: 0, acertoPct: 50 });
    assert.deepEqual(all.get('qb_c'), { usos: 1, respostas: 1, pendentes: 0, acertoPct: 100 });
    const scoped = questionBankStats(memory, { canAccessClass: (name, course) => name === studentClass && course === courseId });
    assert.deepEqual(scoped.get('qb_a'), { usos: 2, respostas: 3, pendentes: 1, acertoPct: 50 });
});

// Snapshot como a tela monta (examTools.buildExamVersions): sem bankKey nenhum, e uma
// chave inventada numa questão que não veio do banco.
function browserSnapshot(evaluation) {
    return [{
        version: 'A',
        questions: evaluation.questions.map((question, index) => ({
            originalNumber: question.originalNumber,
            examNumber: index + 1,
            text: question.text,
            questionText: question.text,
            correctAnswer: question.correctAnswer || '',
            alternatives: (question.alternatives || []).map((alternative, position) => ({ ...alternative, displayLetter: 'ABCDEFGH'[position] })),
            ...(index === 1 ? { bankKey: 'qb_inventada' } : {}),
        })),
    }];
}

test('[UC-BANCO-001] questão vinda do banco leva bankKey até a entrega, e a estatística aparece no banco', async () => {
    seed();
    const fromBank = await create(ITEMS.multiple_choice);
    const numericItem = await create(ITEMS.numeric);
    const put = await asAdmin('put', `/api/admin/evaluation/${examKey}`).send({
        title: 'Prova de redes', theme: 'Redes', rubric: '',
        questions: [
            { ...ITEMS.multiple_choice, bankKey: fromBank.key },
            { type: 'true_false', text: 'Questão própria da prova.', correctAnswer: 'B' },
        ],
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const evaluation = put.body.evaluation;
    assert.equal(evaluation.questions[0].bankKey, fromBank.key);
    const history = await asAdmin('post', '/api/admin/exam-history/add').send({
        studentClass, courseId, examKey, type: 'online',
        questionNumbers: [1, 2], printSnapshot: browserSnapshot(evaluation),
        shuffleAnswers: false, durationMinutes: 30, waitingRoomMinutes: 0, maxAttempts: 1,
    }).expect(200);
    const frozen = history.body.entry.versionSnapshots[0].questions;
    assert.equal(frozen[0].bankKey, fromBank.key, 'a chave vem da avaliação');
    assert.equal('bankKey' in frozen[1], false, 'a chave inventada pelo navegador não fica');

    const created = await asAdmin('post', '/api/admin/exam-applications').send({ studentClass, courseId, examKey, historyId: history.body.entry.id, applicationOptions: { timerMode: 'per_attempt', waitingRoomMinutes: 0, maxAttempts: 1 } }).expect(201);
    const applicationId = created.body.application.id;
    await asAdmin('post', `/api/admin/exam-applications/${applicationId}/control`).send({ action: 'start' }).expect(200);
    assert.equal(db.memory.examApplications.find(item => item.id === applicationId).versionSnapshots[0].questions[0].bankKey, fromBank.key);

    const sync = () => request(app).get('/api/student/sync').set('x-session-token', student.token).query({ email: student.email, studentClass, courseId, examKey, applicationId }).expect(200);
    await sync();
    await request(app).post(`/api/student/exam-applications/${applicationId}/start-attempt`).set('x-session-token', student.token).send({}).expect(200);
    const synced = await sync();
    // Nada do banco chega ao aluno.
    assert.equal(JSON.stringify(synced.body).includes(fromBank.key), false);

    // Troca da questão 2 no Monitor por uma numérica do banco: vai com o tipo e a chave.
    const replaced = await asAdmin('post', '/api/admin/replace-question').send({ applicationId, questionNumber: 2, bankQuestionKey: numericItem.key, extraMinutes: 0 });
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    const added = db.memory.examApplications.find(item => item.id === applicationId).versionSnapshots[0].questions.find(question => question.isAdditional);
    assert.equal(added.type, 'numeric');
    assert.deepEqual(added.numeric, { value: 62, tolerance: 0, unit: 'hosts' });
    assert.equal(added.points, 1.5);
    assert.equal(added.sourceBankKey, numericItem.key);

    const again = await sync();
    await request(app).post('/api/student/submit').set('x-session-token', student.token).send({
        studentClass, courseId, examKey, applicationId, attemptId: again.body.attemptId,
        answers: { 1: alternativeAnswerId(applicationId, 1, 'A'), 3: { numero: '62' } },
        examConfigVersion: again.body.examConfigVersion,
    }).expect(200);
    const submission = db.memory.submissions.find(item => item.applicationId === applicationId);
    assert.equal(submission.examSnapshot.questions.find(question => Number(question.originalNumber) === 1).bankKey, fromBank.key);

    const list = await asAdmin('get', '/api/admin/question-bank').expect(200);
    const byKey = Object.fromEntries(list.body.questions.map(question => [question.key, question.stats]));
    assert.deepEqual(byKey[fromBank.key], { usos: 1, respostas: 1, pendentes: 0, acertoPct: 100 });
    assert.deepEqual(byKey[numericItem.key], { usos: 1, respostas: 1, pendentes: 0, acertoPct: 100 });
});

// Rodada de ajuste 2 do A7: freezeSnapshotGrading apagava só o bankKey, e só da questão
// com origem na avaliação; um sourceBankKey (ou um bankKey numa questão que não está na
// avaliação) mandado em exam-history/add ficava no snapshot e contava como uso do item.
test('[UC-BANCO-001] exam-history/add não aceita chave do banco vinda do navegador (sourceBankKey nem questão sem origem)', async () => {
    seed();
    const fromBank = await create(ITEMS.multiple_choice);
    const outsider = await create(ITEMS.true_false);
    const put = await asAdmin('put', `/api/admin/evaluation/${examKey}`).send({
        title: 'Prova de redes', theme: 'Redes', rubric: '',
        questions: [
            { ...ITEMS.multiple_choice, bankKey: fromBank.key },
            { type: 'true_false', text: 'Questão própria da prova.', correctAnswer: 'B' },
        ],
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const printSnapshot = browserSnapshot(put.body.evaluation);
    const questions = printSnapshot[0].questions;
    questions[0].sourceBankKey = outsider.key;
    questions[1] = { ...questions[1], sourceBankKey: outsider.key };
    delete questions[1].bankKey;
    // Questão que não existe na avaliação, com bankKey e sourceBankKey: desde o P3-S11 a
    // montagem inteira é recusada (D23: cada questão é conferida com a avaliação).
    questions.push({ originalNumber: 9, examNumber: 3, text: 'Inventada', questionText: 'Inventada', alternatives: [], bankKey: outsider.key, sourceBankKey: outsider.key });
    for (const type of ['impressa', 'online']) {
        const refused = await asAdmin('post', '/api/admin/exam-history/add').send({
            studentClass, courseId, examKey, type, label: type, questionNumbers: [1, 2, 9], printSnapshot,
        });
        assert.equal(refused.status, 400, JSON.stringify(refused.body));
        assert.equal(refused.body.code, 'snapshot_mismatch');
        assert.match(refused.body.error, /questão 9 não existe na prova/);
    }
    questions.pop();
    for (const type of ['impressa', 'online']) {
        const history = await asAdmin('post', '/api/admin/exam-history/add').send({
            studentClass, courseId, examKey, type, label: type, questionNumbers: [1, 2], printSnapshot,
        });
        assert.equal(history.status, 200, JSON.stringify(history.body));
        const frozen = history.body.entry.versionSnapshots[0].questions;
        assert.equal(frozen[0].bankKey, fromBank.key, 'a chave da avaliação fica');
        frozen.forEach(question => assert.equal('sourceBankKey' in question, false, 'sourceBankKey do navegador sai'));
        assert.equal('bankKey' in frozen[1], false);
        assert.equal(frozen.length, 2);
        assert.equal(JSON.stringify(history.body.entry.versionSnapshots).includes(outsider.key), false);
        // A montagem guardada (a da tela e da impressão) também sai sem a chave do navegador.
        assert.equal(JSON.stringify(history.body.entry.printSnapshot).includes(outsider.key), false);
    }
    const stats = Object.fromEntries((await asAdmin('get', '/api/admin/question-bank').expect(200)).body.questions.map(question => [question.key, question.stats]));
    assert.equal(stats[outsider.key].usos, 0, 'o item que não está na prova não ganha uso');
    assert.equal(stats[fromBank.key].usos, 1, 'a turma conta um uso por questão, impressa ou online');
});

// Rodada de ajuste 1 do A7: a prova impressa contava como uso, mas as respostas lançadas
// pelo cartão-resposta (sem examSnapshot e sem applicationId) nunca entravam no % de
// acerto ("Usada em 1 aplicação · Sem respostas corrigidas" com a prova já corrigida).
test('[UC-BANCO-001] prova impressa: as respostas do cartão-resposta contam no % de acerto da questão do banco', async () => {
    seed();
    db.memory.students.push({ name: 'Bruno', email: 'bruno@banco.local', status: 'Ativo', classes: [{ name: studentClass, courseId }] });
    const fromBank = await create(ITEMS.multiple_choice);
    const trueFalse = await create(ITEMS.true_false);
    const put = await asAdmin('put', `/api/admin/evaluation/${examKey}`).send({
        title: 'Prova de redes', theme: 'Redes', rubric: '',
        questions: [
            { ...ITEMS.multiple_choice, bankKey: fromBank.key },
            { type: 'true_false', text: 'Questão própria da prova.', correctAnswer: 'B' },
            { ...ITEMS.true_false, bankKey: trueFalse.key },
        ],
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    // Versão impressa com as questões em outra ordem (3, 1, 2), como o sorteio da tela faz.
    const printSnapshot = browserSnapshot(put.body.evaluation);
    printSnapshot[0].questions = [printSnapshot[0].questions[2], printSnapshot[0].questions[0], printSnapshot[0].questions[1]]
        .map((question, index) => ({ ...question, examNumber: index + 1 }));
    await asAdmin('post', '/api/admin/exam-history/add').send({
        studentClass, courseId, examKey, type: 'impressa', label: 'Impressa',
        questionNumbers: [1, 2, 3], printSnapshot,
    }).expect(200);
    const statsOf = async key => (await asAdmin('get', '/api/admin/question-bank').expect(200)).body.questions.find(question => question.key === key).stats;
    assert.deepEqual(await statsOf(fromBank.key), { usos: 1, respostas: 0, pendentes: 0, acertoPct: null });

    // Cartão da Ana pela versão impressa: acerta a 1 e erra a 3 (do banco) e a 2 (da prova).
    const card = (studentEmail, answers) => asAdmin('post', '/api/admin/submissions/create')
        .send({ studentEmail, examKey, studentClass, courseId, type: 'impressa', mode: 'card', answers, questionNumbers: [3, 1, 2] });
    const ana = await card(student.email, { 1: 'A', 2: 'A', 3: 'B' });
    assert.equal(ana.status, 200, JSON.stringify(ana.body));
    const stored = db.memory.submissions.find(item => item.student?.email === student.email);
    assert.equal(stored.applicationId, undefined);
    // Desde o P3-S4a o cartão guarda as questões corrigidas (para a correção do professor);
    // a chave e o uso continuam vindo da versão impressa registrada.
    assert.deepEqual(stored.examSnapshot.questions.map(question => question.originalNumber).sort(), [1, 2, 3]);
    assert.deepEqual(await statsOf(fromBank.key), { usos: 1, respostas: 1, pendentes: 0, acertoPct: 100 });
    assert.deepEqual(await statsOf(trueFalse.key), { usos: 1, respostas: 1, pendentes: 0, acertoPct: 0 });
    // Cartão do Bruno: erra a 1, acerta a 3.
    (await card('bruno@banco.local', { 1: 'B', 3: 'A' })).status === 200 || assert.fail('cartão do Bruno');
    assert.deepEqual(await statsOf(fromBank.key), { usos: 1, respostas: 2, pendentes: 0, acertoPct: 50 });
    assert.deepEqual(await statsOf(trueFalse.key), { usos: 1, respostas: 2, pendentes: 0, acertoPct: 50 });
    // Arquivar a entrega tira a resposta da conta.
    stored.resultStatus = 'archived';
    assert.deepEqual(await statsOf(fromBank.key), { usos: 1, respostas: 1, pendentes: 0, acertoPct: 0 });
});

test('[UC-BANCO-001] cartão-resposta sem prova impressa registrada: as questões da avaliação dão a chave e o uso', () => {
    const evaluationQuestions = [{ originalNumber: 1, bankKey: 'qb_a' }, { originalNumber: 2 }, { originalNumber: 3, bankKey: 'qb_b' }];
    const cardSubmission = (id, answers, extra = {}) => ({
        id, examKey, type: 'impressa', entryMode: 'card', student: { studentClass, courseId },
        gradedAnswers: answers.map(([questionNumber, isCorrect]) => ({ questionNumber, studentChoice: 'A', correctAnswer: 'A', isCorrect })),
        ...extra,
    });
    const memory = {
        evaluations: { [examKey]: { questions: evaluationQuestions } },
        classes: [
            { name: studentClass, courseId, examHistory: {} },
            // Turma com prova impressa registrada: o uso já vem do histórico; o cartão lançado
            // pela avaliação (números que não batem com a versão) usa as questões dela.
            { name: '2OUT', courseId, examHistory: { [examKey]: [{ id: 'eh_1', type: 'impressa', versionSnapshots: [{ version: 'A', questions: [{ originalNumber: 1, bankKey: 'qb_a' }] }] }] } },
        ],
        submissions: [
            cardSubmission('s1', [[1, true], [2, true], [3, false]]),
            cardSubmission('s2', [[1, false], [3, false]]),
            cardSubmission('s3', [[1, true], [3, true]], { student: { studentClass: '2OUT', courseId } }),
            // Lançamento rápido (sem cartão) não tem respostas por questão.
            { id: 's4', examKey, type: 'impressa', entryMode: 'quick', student: { studentClass, courseId }, gradedAnswers: [] },
            // Entrega online antiga sem snapshot e sem aplicação: não vira resposta de cartão,
            // nem na turma com prova impressa registrada.
            { id: 's5', examKey, type: 'online', student: { studentClass, courseId }, gradedAnswers: [{ questionNumber: 1, isCorrect: true }] },
            { id: 's6', examKey, type: 'online', student: { studentClass: '2OUT', courseId }, gradedAnswers: [{ questionNumber: 1, isCorrect: true }] },
        ],
    };
    const stats = questionBankStats(memory);
    // qb_a: uso da turma 1RED (sem registro) + impressa da 2OUT; respostas s1, s2, s3.
    assert.deepEqual(stats.get('qb_a'), { usos: 2, respostas: 3, pendentes: 0, acertoPct: 67 });
    // qb_b: só o uso da 1RED (a versão impressa da 2OUT não tem a qb_b).
    assert.deepEqual(stats.get('qb_b'), { usos: 1, respostas: 3, pendentes: 0, acertoPct: 33 });
    const scoped = questionBankStats(memory, { canAccessClass: name => name === '2OUT' });
    assert.deepEqual(scoped.get('qb_a'), { usos: 1, respostas: 1, pendentes: 0, acertoPct: 100 });
});

test('[UC-BANCO-001] professor: vê e altera só o que é do escopo dele; a estatística conta só as turmas dele', async () => {
    seed();
    const shared = await create(ITEMS.true_false);
    const outside = await create(ITEMS.multiple_choice, { sourceExamKey: otherExamKey });
    const mine = await create(ITEMS.short_answer, { sourceExamKey: examKey });
    db.memory.examApplications = [
        { id: 'app_m', status: 'finished', studentClass, courseId, versionSnapshots: [{ version: 'A', questions: [{ originalNumber: 1, bankKey: shared.key }] }] },
        { id: 'app_o', status: 'finished', studentClass: '2OUT', courseId: otherCourse, versionSnapshots: [{ version: 'A', questions: [{ originalNumber: 1, bankKey: shared.key }] }] },
    ];
    const list = await asProfessor('get', '/api/admin/question-bank').expect(200);
    assert.deepEqual(list.body.questions.map(question => question.key), [shared.key, mine.key]);
    assert.equal(list.body.questions[0].stats.usos, 1, 'a aplicação da outra turma não conta para ele');
    assert.equal((await asAdmin('get', '/api/admin/question-bank').expect(200)).body.questions.find(question => question.key === shared.key).stats.usos, 2);

    for (const [url, body] of [
        ['/api/admin/question-bank/update', { key: outside.key, questionText: 'Mudei', alternatives: ITEMS.multiple_choice.alternatives, correctAnswer: 'A' }],
        ['/api/admin/question-bank/archive', { key: outside.key }],
        ['/api/admin/question-bank/delete', { key: outside.key }],
    ]) {
        const refused = await asProfessor('post', url).send(body);
        assert.equal(refused.status, 403, url);
    }
    assert.equal(db.memory.questionBank.find(item => item.key === outside.key).questionText, 'Qual porta o HTTP usa?');
    assert.equal(db.memory.questionBank.find(item => item.key === outside.key).archived, false);
    const own = await asProfessor('post', '/api/admin/question-bank/update').send({ ...ITEMS.short_answer, key: mine.key, tags: ['linux'] });
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(db.memory.questionBank.find(item => item.key === mine.key).updatedBy, professorEmail);
    assert.equal(db.memory.questionBank.find(item => item.key === mine.key).author, adminEmail, 'quem criou fica');
    await asProfessor('post', '/api/admin/question-bank/archive').send({ key: shared.key }).expect(200);
    assert.equal(audits('question_archived').pop().actor, professorEmail);
});

test('[UC-BANCO-001] normalizeBankQuestion: item antigo com marca e letra juntos, alternativa em texto e tipo desconhecido', () => {
    const legacy = { key: 'qb_x', type: 'qualquer', questionText: 'Q?', alternatives: ['um', 'dois'], correctAnswer: 'B' };
    const normalized = normalizeBankQuestion({ explanation: 'Porque sim.' }, { previous: legacy });
    assert.equal(normalized.type, 'multiple_choice');
    assert.equal(normalized.correctAnswer, 'B');
    assert.deepEqual(normalized.alternatives, [{ letter: 'A', text: 'um', isCorrect: false }, { letter: 'B', text: 'dois', isCorrect: true }]);
    assert.equal(normalized.explanation, 'Porque sim.');
    assert.equal(normalized.questionText, 'Q?');
    assert.equal('bankKey' in normalizeBankQuestion({ text: 'Q', type: 'true_false', correctAnswer: 'A', bankKey: 'qb_y' }), false, 'item do banco não aponta para outro item');
    // Alternativas marcadas sem a letra: a letra de antes não vale junto.
    const marked = normalizeBankQuestion({ alternatives: [{ text: 'um', isCorrect: true }, { text: 'dois' }] }, { previous: legacy });
    assert.equal(marked.correctAnswer, 'A');
});

// ---------------------------------------------------------------- P3-S9b: GIFT e planilha

const FIXTURES = path.join(__dirname, 'fixtures');
const coordToken = 'coord-token-question-bank';
const coordEmail = 'coord@banco.local';
const fixture = name => fs.readFileSync(path.join(FIXTURES, name));
const asFile = (formato, buffer, nomeArquivo, extra = {}) => ({ formato, arquivo: buffer.toString('base64'), nomeArquivo, ...extra });
const preview = (payload, who = asAdmin) => who('post', '/api/admin/question-bank/import/preview').send(payload);
const confirm = (payload, sha256, extra = {}, who = asAdmin) => who('post', '/api/admin/question-bank/import').send({ ...payload, sha256, ...extra });
const bankItems = () => db.memory.questionBank.filter(Boolean);
const withoutKey = question => {
    const { questionText, ...rest } = question;
    return { ...rest, questionText };
};

function seedWithCoordination() {
    seed();
    db.memory.schools = [{ id: 'esc_banco', name: 'Escola' }];
    db.memory.admins.push({ email: coordEmail, name: 'Coord', role: 'coordenacao', password: db.hashPassword('senha-administrativa'), assignedSchoolIds: ['esc_banco'], additionalPermissions: ['page.exams'] });
    db.memory.adminSessions[coordToken] = { email: coordEmail, createdAt: Date.now(), lastSeen: Date.now() };
}

test('[UC-BANCO-002] GIFT do Moodle: a prévia lê os seis tipos sem gravar; a confirmação grava com autor, revisão e auditoria', async () => {
    seed();
    const payload = asFile('gift', fixture('banco.gift'), 'banco.gift', { categoriaPadrao: 'Importadas' });
    const res = await preview(payload);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(bankItems().length, 0, 'a prévia não grava');
    assert.equal(audits('question_bank_imported').length, 0);
    assert.equal(res.body.sha256, require('node:crypto').createHash('sha256').update(fixture('banco.gift')).digest('hex'));
    assert.deepEqual(res.body.erros, []);
    assert.equal(res.body.validas, 8);
    assert.equal(res.body.comErro, 0);
    const byLine = Object.fromEntries(res.body.itens.map(item => [item.linha, item]));
    assert.deepEqual(res.body.itens.map(item => item.type), ['multiple_choice', 'multiple_answer', 'true_false', 'numeric', 'numeric', 'short_answer', 'essay', 'multiple_choice']);
    // [html] vira Markdown, o título sai, a categoria é a última parte do caminho do Moodle.
    assert.equal(byLine[9].questionText, 'Qual porta o **HTTP** usa por padrão?');
    assert.equal(byLine[9].category, 'Protocolos');
    assert.deepEqual(byLine[9].tags, ['redes', 'HTTP']);
    assert.deepEqual(byLine[9].avisos, ['O comentário de cada resposta (#) não existe no IClass e ficou de fora.']);
    assert.deepEqual(byLine[16].alternatives.filter(item => item.isCorrect).map(item => item.text), ['TCP', 'UDP']);
    assert.equal(byLine[22].correctAnswer, 'A');
    assert.deepEqual(byLine[26].numeric, { value: 62, tolerance: 0 });
    assert.deepEqual(byLine[28].numeric, { value: 2, tolerance: 1 }, '{#1..3} é 2 com tolerância 1');
    assert.equal(byLine[26].category, 'Sub-redes');
    assert.deepEqual(byLine[33].acceptedAnswers, ['ls', 'dir']);
    assert.equal(byLine[35].type, 'essay');
    assert.equal(byLine[39].questionText, 'Use {chaves}, = e ~ e # e : no texto: qual é o sinal de atribuição em C?');
    assert.equal(byLine[39].category, 'Linux');

    const saved = await confirm(payload, res.body.sha256);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.importadas, 8);
    assert.equal(saved.body.ignoradas, 0);
    const items = bankItems();
    assert.equal(items.length, 8);
    assert.equal(new Set(items.map(item => item.key)).size, 8);
    items.forEach(item => {
        assert.equal(item.author, adminEmail);
        assert.equal(item.revision, 1);
        assert.equal(item.archived, false);
        assert.equal(item.sourceExamKey, null, 'acervo comum');
        assert.ok(item.createdAt && item.updatedAt);
    });
    const essay = items.find(item => item.type === 'essay');
    assert.equal(essay.questionText, 'Explique o handshake de três vias do TCP.\nUse as palavras SYN e ACK.');
    assert.equal(essay.explanation, 'Espera-se SYN, SYN-ACK e ACK.');
    const entry = audits('question_bank_imported').pop();
    assert.equal(entry.actor, adminEmail);
    assert.equal(entry.details.formato, 'gift');
    assert.equal(entry.details.importadas, 8);
    assert.equal(entry.details.arquivo, 'banco.gift');
    assert.equal(entry.details.keys.length, 8);
    // O GET mostra as importadas como as outras.
    const list = await asAdmin('get', '/api/admin/question-bank?categoria=Linux');
    assert.equal(list.body.questions.length, 3);
});

test('[UC-BANCO-002] questão com erro vem com a linha e não impede as outras; arquivo diferente da prévia é recusado', async () => {
    seed();
    const gift = [
        '// cabeçalho',
        '',
        'Qual porta o HTTP usa? {=80 ~21}',
        '',
        'Associe as camadas {=Rede -> 3 =Enlace -> 2}',
        '',
        'Sem respostas aqui',
        '',
        'Uma alternativa só {=única}',
        '',
        'Só erradas {~a ~b}',
        '',
        'Quanto é 2+2? {#quatro}',
    ].join('\n');
    const payload = { formato: 'gift', conteudo: gift };
    const res = await preview(payload);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.validas, 2, 'a de uma alternativa só com "=" é resposta curta');
    assert.deepEqual(res.body.erros.map(item => item.linha), [5, 7, 11, 13]);
    assert.match(res.body.erros[0].mensagem, /associação/);
    assert.match(res.body.erros[1].mensagem, /chaves/);
    assert.equal(res.body.erros[2].mensagem, 'Marque exatamente uma alternativa correta.');
    assert.match(res.body.erros[3].mensagem, /numérica/);
    assert.equal(bankItems().length, 0);

    // Outro arquivo com o sha256 da prévia: 409, nada gravado.
    const changed = await confirm({ ...payload, conteudo: `${gift}\n` }, res.body.sha256);
    assert.equal(changed.status, 409);
    assert.equal(changed.body.code, 'import_changed');
    assert.equal(bankItems().length, 0);
    // sha256 em formato errado: 400 do schema.
    assert.equal((await confirm(payload, 'abc')).status, 400);

    const saved = await confirm(payload, res.body.sha256);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.importadas, 2);
    assert.equal(saved.body.comErro, 4);
    assert.equal(audits('question_bank_imported').pop().details.comErro, 4);
    assert.deepEqual(bankItems().map(item => item.category), ['Geral', 'Geral']);
});

test('[UC-BANCO-002] planilha: ";" com aspas e quebra de linha, Windows-1252 e XLSX dão as mesmas questões; o apóstrofo do csvSafe sai', async () => {
    seed();
    const csv = fixture('banco.csv');
    const res = await preview(asFile('csv', csv, 'banco.csv'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.erros, []);
    assert.equal(res.body.validas, 7);
    const [first, many, trueFalse, numeric, short, essay, formula] = res.body.itens;
    assert.equal(first.questionText, 'Qual porta o "HTTP" usa?\nResponda pelo número.');
    assert.equal(first.points, 2);
    assert.equal(first.difficulty, 'facil');
    assert.deepEqual(first.tags, ['redes', 'HTTP']);
    assert.deepEqual(many.correctAnswers, ['A', 'C'], '"A e C"');
    assert.equal(trueFalse.type, 'true_false');
    assert.equal(trueFalse.correctAnswer, 'A');
    assert.deepEqual(numeric.numeric, { value: 62, tolerance: 0, unit: 'hosts' });
    assert.equal(numeric.points, 1.5, '"1,5"');
    assert.deepEqual(short.acceptedAnswers, ['ls', 'ls -l']);
    assert.equal(essay.type, 'essay');
    assert.equal(formula.alternatives[0].text, '=1+1', "o \"'=1+1\" do csvSafe volta a ser =1+1");
    assert.equal(formula.category, 'Geral');

    // Windows-1252 (o "CSV" do Excel em português).
    const ansi = Buffer.from(csv.subarray(3).toString('utf8'), 'latin1');
    const ansiRes = await preview(asFile('csv', ansi, 'banco.csv'));
    assert.equal(ansiRes.status, 200, JSON.stringify(ansiRes.body));
    assert.deepEqual(ansiRes.body.itens.map(item => item.questionText), res.body.itens.map(item => item.questionText));

    // XLSX com a mesma planilha (parseTabularFile lê os dois).
    const table = csv.subarray(3).toString('utf8');
    const { _internals } = require('../../backend/utils/tabularFile.js');
    const rows = _internals.splitCsvRecords(table, ';').records.map(record => record.valores.map(value => (value.startsWith("'") ? value.slice(1) : value)));
    const xlsx = buildXlsx(rows.slice(1), { cabecalho: rows[0] });
    const xlsxRes = await preview(asFile('csv', xlsx, 'banco.xlsx'));
    assert.equal(xlsxRes.status, 200, JSON.stringify(xlsxRes.body));
    assert.deepEqual(xlsxRes.body.itens.map(item => [item.type, item.questionText]), res.body.itens.map(item => [item.type, item.questionText]));

    // Sem cabeçalho com "Enunciado": erro do arquivo inteiro.
    const noHeader = await preview({ formato: 'csv', conteudo: 'Qual?;Sim;Não;A\r\n' });
    assert.equal(noHeader.status, 400);
    assert.equal(noHeader.body.code, 'csv_header');
    // Tipo que não existe e letra fora das alternativas: erro da linha.
    const wrong = await preview({ formato: 'csv', conteudo: 'Tipo;Enunciado;Alternativa A;Alternativa B;Correta\r\nAssociação;Q1;a;b;A\r\nUma correta;Q2;a;b;C\r\n' });
    assert.equal(wrong.status, 200);
    assert.deepEqual(wrong.body.erros.map(item => item.linha), [2, 3]);
    assert.match(wrong.body.erros[0].mensagem, /tipo "Associação" não existe/);
    assert.match(wrong.body.erros[1].mensagem, /letra C, mas a linha só tem 2 alternativas \(A a B\)/);
    assert.equal(bankItems().length, 0);
});

test('[UC-BANCO-002] repetida: no banco (também arquivada) ou mais acima no arquivo fica de fora, a não ser que o professor peça', async () => {
    seed();
    await create(ITEMS.multiple_choice);
    const archived = await create(ITEMS.true_false);
    await asAdmin('post', '/api/admin/question-bank/archive').send({ key: archived.key }).expect(200);
    const gift = [
        'Qual porta o HTTP usa? {=80 ~21}', '',
        '  IPV4 tem 32 BITS. {T}', '',
        'Nova questão? {=sim ~não}', '',
        'Nova questão? {=sim ~não}',
    ].join('\n');
    const payload = { formato: 'gift', conteudo: gift };
    const res = await preview(payload);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.validas, 1);
    assert.equal(res.body.duplicadas, 3);
    assert.deepEqual(res.body.itens.map(item => [item.duplicada, item.arquivada, item.noArquivo]), [[true, false, null], [true, true, null], [false, false, null], [true, false, 5]]);

    const saved = await confirm(payload, res.body.sha256);
    assert.equal(saved.body.importadas, 1);
    assert.equal(saved.body.ignoradas, 3);
    assert.equal(bankItems().length, 3);
    // Agora tudo já está no banco: nada a importar (400), a não ser com ignorarDuplicadas false.
    const again = await preview(payload);
    assert.equal(again.body.validas, 0);
    const nothing = await confirm(payload, again.body.sha256);
    assert.equal(nothing.status, 400);
    assert.equal(nothing.body.code, 'nothing_to_import');
    const forced = await confirm(payload, again.body.sha256, { ignorarDuplicadas: false });
    assert.equal(forced.status, 200);
    assert.equal(forced.body.importadas, 4);
    assert.equal(bankItems().length, 7);
});

test('[UC-BANCO-002] exportar e importar de novo dá as mesmas questões, em GIFT e em planilha; CSV com BOM e fórmula neutralizada', async () => {
    seed();
    for (const item of Object.values(ITEMS)) await create(item, { category: item.type === 'essay' ? 'Redes/TCP: avançado' : 'Redes' });
    await create({ type: 'multiple_choice', text: '=CMD()|calc', alternatives: [{ text: '+1', isCorrect: true }, { text: '-1' }, { text: '@x' }], explanation: 'Linha 1\n\nLinha 3 com \\d+ e {chave} # = ~ :' }, { category: 'Fórmulas' });
    // Item antigo do banco, sem tipo e com alternativas em texto.
    db.memory.questionBank.push({ key: 'qb_antigo', category: 'Antigas', questionText: 'Qual é a capital?', alternatives: ['Brasília', 'Rio'], correctAnswer: 'A', createdAt: '2025-01-01' });
    const original = bankItems().map(item => ({ category: item.category, question: withoutKey(normalizeBankQuestion({}, { previous: item })) }));
    const sortKey = entry => `${entry.category}\u0000${entry.question.questionText}`;
    original.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

    for (const formato of ['gift', 'csv']) {
        const exported = await asAdmin('get', `/api/admin/question-bank/export?formato=${formato}`).buffer(true).parse((res, cb) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => cb(null, Buffer.concat(chunks)));
        });
        assert.equal(exported.status, 200);
        const file = exported.body;
        const entry = audits('question_bank_exported').pop();
        assert.equal(entry.details.formato, formato);
        assert.equal(entry.details.quantidade, original.length);
        if (formato === 'gift') {
            assert.match(exported.headers['content-type'], /^text\/plain; charset=utf-8/);
            assert.match(exported.headers['content-disposition'], /banco-de-questoes_\d{4}-\d{2}-\d{2}\.gift\.txt/);
            const text = file.toString('utf8');
            // O Moodle lê o nome da categoria sem tirar as barras de escape: o ":" vai como está.
            assert.match(text, /\$CATEGORY: Redes\/\/TCP: avançado\r\n/);
            assert.match(text, /\/\/ \[tag:redes\] \[tag:HTTP\]/);
            assert.match(text, /\/\/ iclass: \{"points":2,"difficulty":"facil","skills":\["Competência 3"\]\}/);
        } else {
            assert.match(exported.headers['content-type'], /^text\/csv; charset=utf-8/);
            assert.deepEqual([...file.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'BOM para o Excel');
            const text = file.toString('utf8');
            assert.ok(text.includes('\r\n'));
            assert.ok(text.split('\r\n')[0].includes('Categoria;Tipo;Enunciado;Alternativa A'));
            assert.ok(text.includes(`"'=CMD()|calc"`) || text.includes("'=CMD()|calc"), 'enunciado que começa com = não vira fórmula');
            assert.ok(text.includes(";'+1;'-1;'@x;"), 'alternativa com +, - e @ neutralizada');
            assert.ok(!/;=CMD/.test(text));
        }
        // Importa num banco vazio.
        const saved = db.memory.questionBank;
        db.memory.questionBank = [];
        const res = await preview(asFile(formato, file, formato === 'gift' ? 'banco.gift.txt' : 'banco.csv'));
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.deepEqual(res.body.erros, [], formato);
        const confirmRes = await confirm(asFile(formato, file, 'x'), res.body.sha256);
        assert.equal(confirmRes.body.importadas, original.length, formato);
        const back = bankItems().map(item => ({ category: item.category, question: withoutKey(normalizeBankQuestion({}, { previous: item })) }));
        back.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
        // A rubrica volta com os ids c1, c2 (o modelo dá de novo).
        assert.deepEqual(back, original, formato);
        db.memory.questionBank = saved;
    }
});

test('[UC-BANCO-002] exportar segue os filtros e o escopo de quem pede; a coordenação exporta e não importa', async () => {
    seedWithCoordination();
    await create(ITEMS.multiple_choice, { category: 'Redes' });
    await create(ITEMS.short_answer, { category: 'Linux' });
    await create(ITEMS.numeric, { category: 'Redes', sourceExamKey: otherExamKey });
    const csvOf = async (who, query) => {
        const res = await who('get', `/api/admin/question-bank/export?formato=csv${query}`);
        return res;
    };
    const filtered = await csvOf(asAdmin, '&categoria=Linux');
    assert.equal(filtered.status, 200);
    assert.equal(filtered.text.trim().split('\r\n').length, 2, 'cabeçalho e a questão de Linux');
    assert.deepEqual(audits('question_bank_exported').pop().details.filtros, { categoria: 'Linux' });
    // O professor não leva a questão da prova de outro curso.
    const professor = await csvOf(asProfessor, '');
    assert.equal(professor.status, 200);
    assert.ok(!professor.text.includes('Quantos hosts numa /26?'));
    assert.ok(professor.text.includes('Qual porta o HTTP usa?'));
    const admin = await csvOf(asAdmin, '');
    assert.ok(admin.text.includes('Quantos hosts numa /26?'));
    // Sem questão: 404; formato errado: 400.
    const none = await csvOf(asAdmin, '&categoria=Nada');
    assert.equal(none.status, 404);
    assert.equal(none.body.code, 'nothing_to_export');
    const badFormat = await asAdmin('get', '/api/admin/question-bank/export?formato=xml');
    assert.equal(badFormat.status, 400);
    assert.equal(badFormat.body.field, 'formato');
    // Arquivadas só com arquivadas=1.
    const linux = bankItems().find(item => item.category === 'Linux');
    await asAdmin('post', '/api/admin/question-bank/archive').send({ key: linux.key }).expect(200);
    assert.equal((await csvOf(asAdmin, '&categoria=Linux')).status, 404);
    assert.equal((await csvOf(asAdmin, '&categoria=Linux&arquivadas=1')).status, 200);
    // Coordenação com Provas concedido: só de consulta, exporta e não importa.
    const asCoord = (method, url) => request(app)[method](url).set('x-admin-session', coordToken);
    assert.equal((await asCoord('get', '/api/admin/question-bank/export?formato=gift')).status, 200);
    const refused = await preview({ formato: 'gift', conteudo: 'Q? {=a ~b}' }, asCoord);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'read_only_account');
});

test('[UC-BANCO-002] limites: 2 MB, 2.000 questões, arquivo que não é GIFT nem planilha e formato desconhecido', async () => {
    seed();
    const tooBig = await preview({ formato: 'gift', conteudo: `Q? {=a ~b}\n\n// ${'x'.repeat(2 * 1024 * 1024)}` });
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.body.code, 'file_too_large');
    const many = Array.from({ length: 2001 }, (_, index) => `Questão ${index}? {=a ~b}`).join('\n\n');
    const tooMany = await preview({ formato: 'gift', conteudo: many });
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.body.code, 'too_many_questions');
    const exactly = await preview({ formato: 'gift', conteudo: Array.from({ length: 2000 }, (_, index) => `Questão ${index}? {=a ~b}`).join('\n\n') });
    assert.equal(exactly.status, 200);
    assert.equal(exactly.body.validas, 2000);
    const rows = ['Enunciado;Alternativa A;Alternativa B;Correta', ...Array.from({ length: 2001 }, (_, index) => `Q${index};a;b;A`)].join('\r\n');
    const tooManyRows = await preview({ formato: 'csv', conteudo: rows });
    assert.equal(tooManyRows.status, 400);
    assert.equal(tooManyRows.body.code, 'too_many_rows');
    const zip = await preview(asFile('gift', buildXlsx([['a']]), 'banco.xlsx'));
    assert.equal(zip.status, 400);
    assert.equal(zip.body.code, 'unsupported_format');
    const pdf = await preview(asFile('csv', Buffer.from('%PDF-1.4 ...'), 'banco.pdf'));
    assert.equal(pdf.status, 400);
    assert.equal(pdf.body.code, 'unsupported_format');
    assert.equal((await preview({ formato: 'xml', conteudo: 'x' })).status, 400);
    const empty = await preview({ formato: 'gift', conteudo: '   \n' });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.code, 'file_empty');
    const comments = await preview({ formato: 'gift', conteudo: '// só comentário\n' });
    assert.equal(comments.status, 400);
    assert.equal(comments.body.code, 'no_questions');
    const badBase64 = await preview({ formato: 'gift', arquivo: '%%%' });
    assert.equal(badBase64.status, 400);
    assert.equal(bankItems().length, 0);
});

test('[UC-BANCO-002] GIFT: escapes, peso parcial, palavra que falta, HTML do Moodle e o comentário // iclass:', () => {
    const { giftEscape, protectGift, restoreGift, htmlToText } = questionFormats._internals;
    for (const sample of ['a{b}c', 'x = y ~ z # w : v', 'barra \\ e \\n literal', 'linha 1\nlinha 2\r\nlinha 3', '\\{já escapado\\}']) {
        const escaped = giftEscape(sample);
        assert.ok(!/\n/.test(escaped));
        assert.equal(restoreGift(protectGift(escaped)), sample.replace(/\r\n/g, '\n'));
    }
    assert.deepEqual(htmlToText('<p>Um <strong>dois</strong> &amp; <code>tr&eacute;s</code></p><p>Linha<br>nova</p><img src="x">'), { text: 'Um **dois** & `tr&eacute;s`\nLinha\nnova', image: true });
    const parsed = questionFormats.parseGift([
        '// [tag:a] [tag:b]',
        '// iclass: {"points":2.5,"difficulty":"dificil","skills":["S1"],"partialCredit":false,"ignorado":1}',
        'Quais? {~%50%x ~%50%y ~%-100%z}',
        '',
        'Uma com meio ponto {=certa ~%50%quase ~errada}',
        '',
        'O Moodle custa {~muito =nada} para baixar.',
        '',
        '// iclass: {quebrado',
        '::T::[html]<p>Qual &lt;b&gt;?</p><img src="@@PLUGINFILE@@/x.png">{=sim ~não}',
        '',
        '$CATEGORY: $course$/top',
        '',
        'Numérica com várias {#=10:0 =%50%9:1}',
        '',
        '// iclass: {"unit":"ms","review":"professor"}',
        'Tempo? {#3,5:0,5}',
    ].join('\n'));
    assert.deepEqual(parsed.erros, []);
    const [many, partial, missing, html, numeric, comma] = parsed.entradas;
    assert.equal(many.questao.type, 'multiple_answer');
    assert.equal(many.questao.points, 2.5);
    assert.equal(many.questao.partialCredit, false);
    assert.deepEqual(many.questao.tags, ['a', 'b']);
    assert.equal(many.questao.ignorado, undefined, 'só os campos conhecidos do comentário');
    assert.equal(partial.questao.type, 'multiple_choice');
    assert.deepEqual(partial.questao.alternatives.map(item => item.isCorrect), [true, false, false]);
    assert.match(partial.avisos[0], /virou errada/);
    assert.equal(missing.questao.text, 'O Moodle custa _____ para baixar.');
    assert.equal(html.questao.text, 'Qual <b>?');
    assert.ok(html.avisos.some(text => /imagem/.test(text)));
    assert.ok(html.avisos.some(text => /iclass/.test(text)), 'comentário // iclass: quebrado vira aviso');
    assert.equal(numeric.categoria, '', '$course$/top não é categoria');
    assert.deepEqual(numeric.questao.numeric, { value: 10, tolerance: 0 });
    assert.match(numeric.avisos[0], /primeira que vale 100%/);
    assert.deepEqual(comma.questao.numeric, { value: 3.5, tolerance: 0.5, unit: 'ms' });
    assert.equal(comma.questao.review, 'professor');
});

// Rodada de ajuste 1 do A13 (verificação): "->" nas alternativas, "|" nas listas da
// planilha, {=a =b ~c}, formato por resposta, texto que parece peso ou formato, categoria
// com ":" e as imagens pelo referencedExamUploads (contrato C8).
const exportFile = formato => asAdmin('get', `/api/admin/question-bank/export?formato=${formato}`).buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
});

test('[UC-BANCO-002] GIFT: "->" numa alternativa é texto (como no Moodle); só sem "~" é associação', () => {
    const parsed = questionFormats.parseGift([
        'Qual acessa o campo pelo ponteiro? {=p->next ~p.next ~*p.next}',
        '',
        'Várias {~%50%a->b ~%50%c ~%-100%d}',
        '',
        'Associe {=cão -> late =gato -> mia}',
        '',
        '// iclass: {"type":"short_answer"}',
        'Resposta curta exportada pelo IClass {=a->b =c}',
    ].join('\n'));
    assert.deepEqual(parsed.erros, [{ linha: 5, mensagem: 'Questão de associação (->) não existe no IClass.' }]);
    const [pointer, many, short] = parsed.entradas;
    assert.equal(pointer.questao.type, 'multiple_choice');
    assert.deepEqual(pointer.questao.alternatives, [{ text: 'p->next', isCorrect: true }, { text: 'p.next', isCorrect: false }, { text: '*p.next', isCorrect: false }]);
    assert.equal(many.questao.type, 'multiple_answer');
    assert.equal(many.questao.alternatives[0].text, 'a->b');
    assert.equal(short.questao.type, 'short_answer');
    assert.deepEqual(short.questao.acceptedAnswers, ['a->b', 'c']);
    assert.equal(short.questao.type, 'short_answer');
});

test('[UC-BANCO-002] GIFT: {=a =b ~c} avisa que virou "Várias corretas"; formato por resposta; "=%50%x" numa de alternativas é a certa com esse texto', () => {
    const parsed = questionFormats.parseGift([
        'Porta do HTTP? {=80 =8080 ~21}',
        '',
        '[html]<p>Qual?</p>{=[html]<p>um <b>dois</b></p> ~[plain]três ####[html]<p>Porque <i>sim</i></p>}',
        '',
        'Desconto? {=%50% de desconto ~nenhum}',
    ].join('\n'));
    assert.deepEqual(parsed.erros, []);
    const [two, html, percent] = parsed.entradas;
    assert.equal(two.questao.type, 'multiple_answer');
    assert.ok(two.avisos.some(text => /qualquer uma das certas valia a nota toda/.test(text) && /Várias corretas/.test(text)), JSON.stringify(two.avisos));
    assert.deepEqual(html.questao.alternatives.map(item => item.text), ['um **dois**', 'três']);
    assert.equal(html.questao.text, 'Qual?');
    assert.equal(html.questao.explanation, 'Porque *sim*');
    assert.deepEqual(percent.questao.alternatives, [{ text: '%50% de desconto', isCorrect: true }, { text: 'nenhum', isCorrect: false }]);
});

test('[UC-BANCO-002] ida e volta: "->", "|", texto que parece peso ou formato e categoria com ":" voltam iguais em GIFT e em planilha', async () => {
    seed();
    await create({ type: 'multiple_choice', text: 'Ponteiro em C?', alternatives: [{ text: 'p->next', isCorrect: true }, { text: '%50% de desconto' }, { text: '[html] é uma marca' }], explanation: '[html] também aqui' }, { category: 'Linguagem C: ponteiros / listas' });
    await create({ type: 'short_answer', text: 'Filtre a listagem pelos .txt', acceptedAnswers: ['ls | grep txt', 'ls|grep txt', 'a->b', '%50%x', '[plain]y'], tags: ['shell|pipe', 'linux'], skills: ['Usar | no shell'] }, { category: 'Linux' });
    await create({ type: 'multiple_answer', text: 'Quais acessam membro?', alternatives: [{ text: 'p->x', isCorrect: true }, { text: '%10% s.x', isCorrect: true }, { text: 'p=>x' }], partialCredit: true }, { category: 'Linguagem C: ponteiros / listas' });
    await create({ type: 'essay', points: 2, text: 'Explique o pipe.', rubric: [{ nome: 'Usa | certo', pontos: 1 }, { nome: 'Clareza', pontos: 1 }] }, { category: 'Linux' });
    const original = bankItems().map(item => ({ category: item.category, question: withoutKey(normalizeBankQuestion({}, { previous: item })) }));
    const sortKey = entry => `${entry.category}\u0000${entry.question.questionText}`;
    original.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    for (const formato of ['gift', 'csv']) {
        const exported = await exportFile(formato);
        assert.equal(exported.status, 200);
        if (formato === 'gift') {
            const text = exported.body.toString('utf8');
            assert.match(text, /\$CATEGORY: Linguagem C: ponteiros \/\/ listas\r\n/);
            assert.match(text, /\t~%0%%50% de desconto\r\n/, 'errada que começa com "%50%" leva o peso 0 explícito');
            assert.match(text, /\t~\[markdown\]\[html\] é uma marca\r\n/);
            assert.match(text, /\/\/ iclass: \{"type":"short_answer"/);
        } else {
            const text = exported.body.toString('utf8');
            assert.ok(text.includes('ls \\| grep txt | ls\\|grep txt | a->b'), 'o "|" do item vai como "\\|"');
        }
        const saved = db.memory.questionBank;
        db.memory.questionBank = [];
        const res = await preview(asFile(formato, exported.body, formato === 'gift' ? 'banco.gift.txt' : 'banco.csv'));
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.deepEqual(res.body.erros, [], formato);
        const confirmRes = await confirm(asFile(formato, exported.body, 'x'), res.body.sha256);
        assert.equal(confirmRes.body.importadas, original.length, formato);
        const back = bankItems().map(item => ({ category: item.category, question: withoutKey(normalizeBankQuestion({}, { previous: item })) }));
        back.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
        assert.deepEqual(back, original, formato);
        db.memory.questionBank = saved;
    }
});

test('[UC-BANCO-002] planilha: lista com "\\|" é um item só; "|" sozinho separa', () => {
    const { splitList, joinList } = questionFormats._internals;
    assert.deepEqual(splitList('ls \\| grep txt | ls | pwd'), ['ls | grep txt', 'ls', 'pwd']);
    assert.deepEqual(splitList('a|b'), ['a', 'b']);
    const items = ['ls | grep txt', 'a\\|b', 'C:\\temp', 'fim\\'];
    assert.deepEqual(splitList(joinList(items)), items);
});

test('[UC-BANCO-002] GIFT em Windows-1252 e UTF-16 (BOM) é lido sem pacote nem o leitor da planilha', async () => {
    seed();
    const text = 'Questão de configuração? {=sim ~não}\r\n';
    const cp1252 = Buffer.from(text.replace('ã', '\u00e3'), 'latin1');
    const utf16be = Buffer.concat([Buffer.from([0xFE, 0xFF]), Buffer.from(text, 'utf16le').swap16()]);
    const utf16le = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]);
    const curly = Buffer.from([...Buffer.from('Aspas '), 0x93, ...Buffer.from('x'), 0x94, ...Buffer.from(' {=a ~b}')]);
    for (const [buffer, expected] of [[cp1252, 'Questão de configuração?'], [utf16be, 'Questão de configuração?'], [utf16le, 'Questão de configuração?'], [curly, 'Aspas \u201Cx\u201D']]) {
        const res = await preview(asFile('gift', buffer, 'banco.txt'));
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.itens[0].questionText, expected);
    }
});

test('[UC-BANCO-002] imagens (contrato C8): o GET traz as de cada questão; a exportação lista no GIFT, no cabeçalho e na auditoria', async () => {
    seed();
    const withImage = await create({ type: 'essay', text: 'Veja ![rede](/uploads/rede.png)', expectedAnswer: 'Como em <img src="/uploads/resposta.jpg">', explanation: 'Detalhe ![x](/uploads/rede.png)' });
    await create({ type: 'multiple_choice', text: 'Sem imagem', alternatives: [{ text: 'a', isCorrect: true }, { text: '![b](/uploads/alt.png)' }] });
    await create({ type: 'true_false', text: 'Nada aqui', correctAnswer: 'A' });
    assert.deepEqual(withImage.imagens, ['rede.png', 'resposta.jpg'], 'a resposta esperada também conta');
    const list = await asAdmin('get', '/api/admin/question-bank');
    assert.deepEqual(list.body.questions.map(item => item.imagens), [['rede.png', 'resposta.jpg'], ['alt.png'], []]);
    const gift = await exportFile('gift');
    assert.equal(gift.headers['x-iclass-imagens'], '3');
    assert.match(gift.body.toString('utf8'), /\/\/ As 3 imagens citadas nas questões não vão neste arquivo \(no outro computador, envie de novo pelo editor\): alt\.png, rede\.png, resposta\.jpg\./);
    const entry = audits('question_bank_exported').pop();
    assert.equal(entry.details.imagens, 3);
    assert.deepEqual(entry.details.arquivosDeImagem, ['alt.png', 'rede.png', 'resposta.jpg']);
    const csv = await exportFile('csv');
    assert.equal(csv.headers['x-iclass-imagens'], '3');
    // O arquivo GIFT com o comentário das imagens importa de volta sem erro.
    const res = await preview(asFile('gift', gift.body, 'banco.gift.txt'));
    assert.deepEqual(res.body.erros, []);
    assert.equal(res.body.duplicadas, 3);
});
