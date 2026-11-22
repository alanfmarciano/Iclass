// Banco de questões no modelo único, com metadados e estatística (fase 3, P3-S9a:
// AVA-15; decisões D3 e D21 do desenho P3). O banco guarda os seis tipos pela mesma regra
// da avaliação, com dificuldade, habilidades, etiquetas, autor, revisão e "Arquivar"; o
// GET filtra e devolve a estatística calculada na hora (usos e % de acerto, só com as
// entregas consideradas); a questão que veio do banco leva bankKey na avaliação e no
// snapshot da aplicação, e é por ela que as entregas contam.
// (A importação e a exportação GIFT e CSV, P3-S9b, acrescentam casos aqui.)
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
