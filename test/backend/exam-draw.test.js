// Versões no servidor e sorteio por aluno (fase 3, P3-S11: AVA-16; D23 e D24 do desenho do
// P3). Antes: o navegador montava as versões online (no máximo 4, o servidor cortava a 5ª
// sem avisar), o gabarito de cada versão vinha do navegador sem conferência e toda a turma
// recebia as mesmas questões, só em outra ordem.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-exam-draw-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const examVersions = require('../../backend/utils/examVersions.js');
const examDraw = require('../../backend/utils/examDraw.js');
const { questionsForAttempt } = require('../../backend/utils/examGrading.js');

let app;
const adminToken = 'admin-token-draw';
const adminEmail = 'admin@draw.local';
const studentClass = 'Turma Sorteio';
const courseId = 'curso-sorteio';
const examKey = 'Avaliacao_Sorteio';
const STUDENTS = ['ana', 'bruno', 'carla', 'davi'].map(name => ({ email: `${name}@draw.local`, token: `token-${name}-draw` }));

// Oito questões: 1 a 4 fáceis (etiqueta "redes"), 5 e 6 difíceis, 7 e 8 vieram do banco
// (categoria "Protocolos", média). A certa é sempre a B.
function evaluationQuestions() {
    return Array.from({ length: 8 }, (_, index) => {
        const number = index + 1;
        return {
            number,
            originalNumber: number,
            text: `Enunciado ${number}`,
            correctAnswer: 'B',
            alternatives: ['A', 'B', 'C', 'D'].map(letter => ({ letter, text: `Q${number} alternativa ${letter}`, isCorrect: letter === 'B' })),
            ...(number <= 4 ? { difficulty: 'facil', tags: ['redes'] } : {}),
            ...(number === 5 || number === 6 ? { difficulty: 'dificil' } : {}),
            ...(number >= 7 ? { difficulty: 'media', bankKey: `qb_draw_${number}` } : {}),
        };
    });
}

function reset() {
    db.memory.admins = [{ email: adminEmail, name: 'Admin', role: 'admin', password: db.hashPassword('senha-administrativa') }];
    db.memory.adminSessions = { [adminToken]: { email: adminEmail, createdAt: Date.now(), lastSeen: Date.now() } };
    db.memory.students = STUDENTS.map((student, index) => ({ name: `Aluno ${index + 1}`, email: student.email, status: 'Ativo', classes: [{ name: studentClass, courseId }] }));
    db.memory.sessions = Object.fromEntries(STUDENTS.map(student => [student.email, { token: student.token, lastSeen: Date.now(), ip: '127.0.0.1' }]));
    db.memory.courses = [{ id: courseId, structure: [{ name: 'Módulo', units: [{ avaliacaoKey: examKey }] }] }];
    db.memory.classes = [{ name: studentClass, courseId, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} }];
    db.memory.evaluations = { [examKey]: { key: examKey, title: 'Prova do sorteio', questions: evaluationQuestions() } };
    db.memory.questionBank = [7, 8].map(number => ({
        key: `qb_draw_${number}`, category: 'Protocolos', questionText: `Enunciado ${number}`, correctAnswer: 'B',
        alternatives: ['A', 'B', 'C', 'D'].map(letter => ({ letter, text: `Q${number} alternativa ${letter}`, isCorrect: letter === 'B' })),
    }));
    db.memory.submissions = [];
    db.memory.examApplications = [];
    db.memory.studentExamState = {};
    db.memory.proctoringLogs = [];
    db.memory.broadcastMessages = [];
}

test.before(async () => {
    await db.init();
    app = createApp();
    reset();
});

test.beforeEach(() => reset());

test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

function admin(method, url) {
    return request(app)[method](url).set('x-admin-session', adminToken);
}

function addHistory(body) {
    return admin('post', '/api/admin/exam-history/add').send({
        studentClass, courseId, examKey, type: 'online', durationMinutes: 30, waitingRoomMinutes: 0, maxAttempts: 1, ...body,
    });
}

// O snapshot que o navegador monta (examTools.buildExamVersions): enunciado, alternativas
// com a letra da versão, a letra certa e o gabarito impresso.
function browserVersion(numbers, { version = 'A', correct = 'B', answerKey } = {}) {
    const questions = numbers.map((number, index) => ({
        originalNumber: number,
        examNumber: index + 1,
        text: `Enunciado ${number}`,
        questionText: `Enunciado ${number}`,
        correctAnswer: correct,
        alternatives: ['A', 'B', 'C', 'D'].map((letter, position) => ({ letter, displayLetter: 'ABCD'[position], text: `Q${number} alternativa ${letter}`, isCorrect: letter === correct })),
    }));
    return { version, examCode: 'AB12', count: questions.length, answerKey: answerKey || Object.fromEntries(questions.map((_, index) => [index + 1, correct])), questions };
}

async function prepareAndStart(historyId, applicationOptions = {}) {
    const created = await admin('post', '/api/admin/exam-applications').send({
        studentClass, courseId, examKey, historyId,
        applicationOptions: { timerMode: 'per_attempt', waitingRoomMinutes: 0, maxAttempts: 1, ...applicationOptions },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    await admin('post', `/api/admin/exam-applications/${created.body.application.id}/control`).send({ action: 'start' }).expect(200);
    return created.body.application;
}

async function startAttempt(student, applicationId) {
    await request(app).get('/api/student/sync').set('x-session-token', student.token)
        .query({ email: student.email, studentClass, courseId, examKey, applicationId }).expect(200);
    const started = await request(app).post(`/api/student/exam-applications/${applicationId}/start-attempt`)
        .set('x-session-token', student.token).send({}).expect(200);
    return started.body;
}

function stateOf(attemptId) {
    return Object.values(db.memory.studentExamState).find(state => state && state.attemptId === attemptId) || null;
}

const DRAW = { modo: 'por_aluno', grupos: [{ filtro: { dificuldade: 'facil' }, quantidade: 2 }, { filtro: { dificuldade: 'dificil' }, quantidade: 1 }] };

test('[UC-PROVA-007] o servidor monta as versões online pela avaliação: até 4, a 5ª é recusada com mensagem', async () => {
    const built = examVersions.buildOnlineVersions({ questions: evaluationQuestions() }, { questionNumbers: [1, 2, 3, 5], versionCount: 4, shuffleQuestions: true, shuffleAnswers: true });
    assert.equal(built.ok, true);
    assert.deepEqual(built.versions.map(version => version.version), ['A', 'B', 'C', 'D']);
    built.versions.forEach(version => {
        assert.deepEqual(version.questions.map(question => question.originalNumber).sort(), [1, 2, 3, 5]);
        version.questions.forEach((question, index) => {
            assert.equal(question.examNumber, index + 1);
            assert.equal(question.correctAnswer, 'B', 'a letra certa é a da avaliação');
            assert.deepEqual(question.alternatives.map(alternative => alternative.displayLetter), ['A', 'B', 'C', 'D']);
            // O gabarito impresso é a letra de exibição da alternativa certa (B original).
            const shown = question.alternatives.find(alternative => alternative.letter === 'B').displayLetter;
            assert.equal(version.answerKey[index + 1], shown);
        });
    });
    const fifth = examVersions.buildOnlineVersions({ questions: evaluationQuestions() }, { questionNumbers: [1], versionCount: 5 });
    assert.equal(fifth.ok, false);
    assert.equal(fifth.error, 'No máximo 4 versões online (A a D).');

    // Pela rota: online sem as versões no pedido é montada no servidor e fica conferida.
    const saved = await addHistory({ questionNumbers: [1, 2, 3, 5], versionCount: 4, shuffleQuestions: true, shuffleAnswers: true });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const entry = saved.body.entry;
    assert.equal(entry.montadaNoServidor, true);
    assert.ok(entry.gabaritoConferidoEm);
    assert.equal(entry.versionSnapshots.length, 4);
    assert.equal(entry.printSnapshot.length, 4, 'a tela de detalhe e a impressão leem as versões do servidor');
    entry.versionSnapshots.forEach(snapshot => snapshot.questions.forEach(question => {
        assert.equal(question.type, 'multiple_choice');
        assert.equal(question.points, 1);
        assert.equal(question.alternatives.find(alternative => alternative.isCorrect).letter, 'B');
    }));
    assert.deepEqual(entry.questionNumbers.sort(), [1, 2, 3, 5]);

    const refused = await addHistory({ questionNumbers: [1, 2], versionCount: 5 });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, 'No máximo 4 versões online (A a D).');
    assert.equal(refused.body.code, 'too_many_versions');
    // O cliente de antes, que manda as versões montadas: a 5ª também é recusada (antes o
    // servidor cortava em 4 sem avisar).
    const fiveVersions = ['A', 'B', 'C', 'D', 'E'].map(version => browserVersion([1, 2], { version }));
    const refusedSnapshot = await addHistory({ questionNumbers: [1, 2], printSnapshot: fiveVersions });
    assert.equal(refusedSnapshot.status, 400);
    assert.equal(refusedSnapshot.body.error, 'No máximo 4 versões online (A a D).');
    // Questão que não existe na prova não é montada.
    const unknown = await addHistory({ questionNumbers: [1, 99], versionCount: 1 });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /questão 99 não existe nesta prova/);
    assert.equal(db.memory.classes[0].examHistory[examKey].length, 1, 'nada recusado foi gravado');

    // Preparar com mais de 4 versões também é recusado com a mensagem.
    const prepared = await admin('post', '/api/admin/exam-applications').send({
        studentClass, courseId, examKey, historyId: entry.id, applicationOptions: { onlineVersions: 5 },
    });
    assert.equal(prepared.status, 400);
    assert.equal(prepared.body.error, 'No máximo 4 versões online (A a D).');
});

test('[UC-PROVA-007] versão montada no navegador com gabarito, enunciado ou alternativas diferentes da avaliação dá 400', async () => {
    const wrongKey = await addHistory({ type: 'impressa', questionNumbers: [1, 2], printSnapshot: [browserVersion([1, 2], { correct: 'C' })] });
    assert.equal(wrongKey.status, 400);
    assert.equal(wrongKey.body.code, 'snapshot_mismatch');
    assert.match(wrongKey.body.error, /resposta certa da questão 1 \(versão A\) não é a da prova \(na prova: B · Q1 alternativa B\)/);

    const wrongPrinted = await addHistory({ type: 'impressa', questionNumbers: [1, 2], printSnapshot: [browserVersion([1, 2], { answerKey: { 1: 'B', 2: 'D' } })] });
    assert.equal(wrongPrinted.status, 400);
    assert.match(wrongPrinted.body.error, /gabarito impresso da versão A na questão 2 não confere com a prova \(deveria ser B\)/);

    const changedText = browserVersion([1, 2]);
    changedText.questions[1].text = 'Outro enunciado';
    const wrongText = await addHistory({ type: 'impressa', questionNumbers: [1, 2], printSnapshot: [changedText] });
    assert.equal(wrongText.status, 400);
    assert.match(wrongText.body.error, /enunciado da questão 2 \(versão A\) não é o da prova/);

    const changedAlternative = browserVersion([1, 2]);
    changedAlternative.questions[0].alternatives[2].text = 'Inventada';
    const wrongAlternative = await addHistory({ type: 'online', questionNumbers: [1, 2], printSnapshot: [changedAlternative] });
    assert.equal(wrongAlternative.status, 400);
    assert.match(wrongAlternative.body.error, /alternativas da questão 1 \(versão A\) não são as da prova/);
    assert.equal(db.memory.classes[0].examHistory[examKey].length, 0);

    // A montagem certa passa e fica conferida.
    const ok = await addHistory({ type: 'impressa', questionNumbers: [1, 2], printSnapshot: [browserVersion([1, 2]), browserVersion([2, 1], { version: 'B' })] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.entry.gabaritoConferidoEm);
    assert.deepEqual(ok.body.entry.printSnapshot[1].answerKey, { 1: 'B', 2: 'B' });

    // O snapshot mínimo de um cliente de antes (sem a letra certa): a resposta certa e o
    // gabarito impresso saem da avaliação, nunca do navegador.
    const minimal = await addHistory({
        questionNumbers: [3],
        printSnapshot: [{ version: 'A', questions: [{ originalNumber: 3, text: 'Enunciado 3', alternatives: ['A', 'B', 'C', 'D'].map(letter => ({ letter, text: `Q3 alternativa ${letter}` })) }] }],
    });
    assert.equal(minimal.status, 200, JSON.stringify(minimal.body));
    const frozen = minimal.body.entry.versionSnapshots[0];
    assert.equal(frozen.questions[0].correctAnswer, 'B');
    assert.equal(frozen.questions[0].alternatives.find(alternative => alternative.isCorrect).letter, 'B');
    assert.deepEqual(frozen.answerKey, { 1: 'B' });
});

test('[UC-PROVA-007] configuração salva antes da conferência: gabarito diferente do da prova de hoje não vira aplicação; o corrigido depois da prova vale', async () => {
    const cls = db.memory.classes[0];
    const legacy = { id: 'eh_legado_1', type: 'online', questionNumbers: [1, 2], printSnapshot: [browserVersion([1, 2])], versionSnapshots: [browserVersion([1, 2])], durationMinutes: 30, waitingRoomMinutes: 0, maxAttempts: 1, createdAt: new Date().toISOString() };
    cls.examHistory[examKey] = [legacy];
    // Igual à avaliação: prepara como antes.
    const same = await admin('post', '/api/admin/exam-applications').send({ studentClass, courseId, examKey, historyId: legacy.id, applicationOptions: { waitingRoomMinutes: 0 } });
    assert.equal(same.status, 201, JSON.stringify(same.body));

    // A resposta certa da questão 2 mudou na prova depois que a configuração foi salva.
    db.memory.evaluations[examKey].questions[1].correctAnswer = 'C';
    db.memory.evaluations[examKey].questions[1].alternatives.forEach(alternative => { alternative.isCorrect = alternative.letter === 'C'; });
    const refused = await admin('post', '/api/admin/exam-applications').send({ studentClass, courseId, examKey, historyId: legacy.id, applicationOptions: { waitingRoomMinutes: 0 } });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'snapshot_mismatch');
    assert.match(refused.body.error, /resposta certa da questão 2 na configuração salva não é a da prova \(na prova: C · Q2 alternativa C\)/);

    // "Corrigir gabarito" depois da prova (A8) acertou a questão na configuração: vale como
    // foi corrigida, mesmo que a prova no editor diga outra coisa.
    const { applyAnswerKeyToPreparation } = require('../../backend/utils/examAnswerKeyCorrection.js');
    assert.ok(applyAnswerKeyToPreparation(legacy, 2, { type: 'multiple_choice', correctAnswer: 'D' }));
    assert.deepEqual(legacy.gabaritoCorrigido, [2]);
    const corrected = await admin('post', '/api/admin/exam-applications').send({ studentClass, courseId, examKey, historyId: legacy.id, applicationOptions: { waitingRoomMinutes: 0 } });
    assert.equal(corrected.status, 201, JSON.stringify(corrected.body));
});

test('[UC-PROVA-007] sorteio por aluno: cada aluno recebe a quantidade de cada grupo, sem repetir, em ordem própria; recarregar e trocar a versão mantêm o sorteio', async () => {
    const saved = await addHistory({ questionNumbers: [1, 2, 3, 4, 5, 6, 7, 8], versionCount: 2, shuffleQuestions: true, shuffleAnswers: true });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const application = await prepareAndStart(saved.body.entry.id, { sorteio: DRAW, onlineVersions: 2 });
    const stored = db.memory.examApplications.find(item => item.id === application.id);
    assert.deepEqual(stored.sorteio.grupos.map(group => [...group.numeros].sort((a, b) => a - b)), [[1, 2, 3, 4], [5, 6]]);
    assert.equal(stored.sorteio.total, 3);
    assert.equal(stored.questionCount, 3, 'o Monitor conta "respondidas de 3"');
    assert.equal(application.sorteioView.modo, 'por_aluno');
    assert.equal(application.sorteioView.grupos[0].descricao, 'questões fáceis');
    const audit = (db.memory.auditLogs || []).find(entry => entry.type === 'exam_application_draw_set' || entry.action === 'exam_application_draw_set');
    assert.ok(audit, 'a preparação com sorteio fica na Auditoria');
    assert.equal(audit.details.total, 3);
    assert.deepEqual(audit.details.grupos.map(group => [group.descricao, group.quantidade, group.disponiveis]), [['questões fáceis', 2, 4], ['questões difíceis', 1, 2]]);

    const seen = new Set();
    for (const student of STUDENTS) {
        const started = await startAttempt(student, application.id);
        assert.equal(started.questions.length, 3);
        const numbers = started.questions.map(question => question.originalNumber);
        assert.equal(new Set(numbers).size, 3, 'a mesma questão não aparece duas vezes');
        assert.equal(numbers.filter(number => number <= 4).length, 2, 'duas fáceis');
        assert.equal(numbers.filter(number => number === 5 || number === 6).length, 1, 'uma difícil');
        assert.deepEqual(started.questions.map(question => question.examNumber), [1, 2, 3], 'examNumber pela posição na tentativa');
        // O aluno não recebe o que não sorteou (nem o enunciado das outras).
        const raw = JSON.stringify(started);
        [1, 2, 3, 4, 5, 6, 7, 8].filter(number => !numbers.includes(number)).forEach(number => assert.equal(raw.includes(`Enunciado ${number}"`), false));
        const state = stateOf(started.attemptId);
        assert.match(state.drawSeed, /^[0-9a-f]{16}$/);
        assert.deepEqual(state.drawGroups, [2, 1]);
        assert.deepEqual(state.assignedQuestionNumbers, numbers);
        numbers.forEach(number => seen.add(number));

        // Recarregar a página: o mesmo sorteio.
        const again = await request(app).get('/api/student/sync').set('x-session-token', student.token)
            .query({ email: student.email, studentClass, courseId, examKey, applicationId: application.id }).expect(200);
        const syncedNumbers = (again.body.questions || []).map(question => question.originalNumber);
        if (again.body.questions) assert.deepEqual(syncedNumbers, numbers);
        assert.deepEqual(stateOf(started.attemptId).assignedQuestionNumbers, numbers);

        // Trocar a versão no Monitor: as questões sorteadas ficam (só a ordem das alternativas muda).
        const other = state.assignedVersion === 'A' ? 'B' : 'A';
        await admin('post', '/api/admin/assign-student-version').send({ studentEmail: student.email, examKey, applicationId: application.id, version: other }).expect(200);
        assert.deepEqual(stateOf(started.attemptId).assignedQuestionNumbers, numbers);
        const afterSwap = await request(app).get('/api/student/sync').set('x-session-token', student.token)
            .query({ email: student.email, studentClass, courseId, examKey, applicationId: application.id }).expect(200);
        assert.equal(stateOf(started.attemptId).assignedVersion, other);
        if (afterSwap.body.questions) assert.deepEqual(afterSwap.body.questions.map(question => question.originalNumber), numbers);

        // A mesma semente refaz o mesmo sorteio, mesmo sem os números guardados.
        const rebuilt = questionsForAttempt({ application: stored, onlineConfig: db.memory.classes[0].onlineExamConfigs[examKey], state: { ...state, assignedQuestionNumbers: null }, evaluation: db.memory.evaluations[examKey] });
        assert.deepEqual(rebuilt.assignedNumbers, numbers);

        // A entrega corrige só as questões sorteadas.
        const delivered = await request(app).post('/api/student/submit').set('x-session-token', student.token).send({
            studentClass, courseId, examKey, applicationId: application.id, attemptId: started.attemptId,
            answers: Object.fromEntries(numbers.map(number => [number, 'B'])), examConfigVersion: started.examConfigVersion,
        });
        assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
        const submission = db.memory.submissions.find(item => item.attemptId === started.attemptId);
        assert.equal(submission.totalCount, 3);
        assert.deepEqual(submission.gradedAnswers.map(answer => answer.questionNumber), numbers);
        assert.deepEqual(submission.examSnapshot.questions.map(question => question.examNumber), [1, 2, 3]);
    }
    // As questões 7 e 8 (médias) não entram em nenhum grupo.
    assert.equal(seen.has(7) || seen.has(8), false);
});

test('[UC-PROVA-007] sorteio por aluno: grupo maior que a montagem dá 400; filtro por origem, categoria do banco e etiqueta', async () => {
    const saved = await addHistory({ questionNumbers: [1, 2, 3, 4, 5, 6, 7, 8], versionCount: 1 });
    const historyId = saved.body.entry.id;
    const tooMany = await admin('post', '/api/admin/exam-applications').send({
        studentClass, courseId, examKey, historyId,
        applicationOptions: { sorteio: { modo: 'por_aluno', grupos: [{ filtro: { dificuldade: 'dificil' }, quantidade: 3 }] } },
    });
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.body.error, 'Grupo 1: pediu 3 questões difíceis, mas a montagem só tem 2.');
    assert.equal(tooMany.body.field, 'applicationOptions.sorteio.grupos[0].quantidade');
    // A questão que serve para dois grupos fica no primeiro.
    const overlap = await admin('post', '/api/admin/exam-applications').send({
        studentClass, courseId, examKey, historyId,
        applicationOptions: { sorteio: { modo: 'por_aluno', grupos: [{ filtro: { tag: 'REDES' }, quantidade: 1 }, { filtro: { dificuldade: 'facil' }, quantidade: 1 }] } },
    });
    assert.equal(overlap.status, 400);
    assert.match(overlap.body.error, /^Grupo 2: nenhuma questão da montagem combina com o filtro \(questões fáceis\) \(a questão que serve para dois grupos fica no primeiro\)\.$/);
    const badMode = await admin('post', '/api/admin/exam-applications').send({ studentClass, courseId, examKey, historyId, applicationOptions: { sorteio: { modo: 'todos' } } });
    assert.equal(badMode.status, 400);
    assert.equal(db.memory.examApplications.length, 0, 'nada recusado foi preparado');

    // Origem e categoria do banco (7 e 8 vieram do banco, categoria Protocolos).
    const pool = await admin('get', `/api/admin/exam-applications/draw-pool?studentClass=${encodeURIComponent(studentClass)}&courseId=${courseId}&examKey=${examKey}&historyId=${historyId}`).expect(200);
    assert.equal(pool.body.questions.length, 8);
    assert.deepEqual(pool.body.questions.find(question => question.number === 7), { number: 7, origem: 'banco', categoria: 'Protocolos', dificuldade: 'media', tags: [] });
    assert.deepEqual(pool.body.categorias, ['Protocolos']);
    assert.deepEqual(pool.body.etiquetas, ['redes']);
    const chosen = await admin('get', `/api/admin/exam-applications/draw-pool?studentClass=${encodeURIComponent(studentClass)}&courseId=${courseId}&examKey=${examKey}&numbers=1,7`).expect(200);
    assert.deepEqual(chosen.body.questions.map(question => question.number), [1, 7]);

    const application = await prepareAndStart(historyId, { sorteio: { modo: 'por_aluno', grupos: [{ filtro: { origem: 'banco', categoria: 'protocolos' }, quantidade: 2 }, { filtro: { origem: 'avaliacao' }, quantidade: 1 }] } });
    const started = await startAttempt(STUDENTS[0], application.id);
    const numbers = started.questions.map(question => question.originalNumber);
    assert.equal(numbers.length, 3);
    assert.deepEqual(numbers.filter(number => number >= 7).sort(), [7, 8]);
});

test('[UC-PROVA-007] sorteio por aluno: a troca de questão no Monitor vai só para quem tirou a questão trocada', async () => {
    const saved = await addHistory({ questionNumbers: [1, 2, 3, 4, 5, 6], versionCount: 1 });
    const application = await prepareAndStart(saved.body.entry.id, { sorteio: { modo: 'por_aluno', grupos: [{ filtro: {}, quantidade: 2 }] }, durationMinutes: 30 });
    const attempts = [];
    for (const student of STUDENTS) attempts.push(await startAttempt(student, application.id));
    const target = attempts[0].questions[0].originalNumber;
    db.memory.questionBank.push({ key: 'qb_troca', category: 'Geral', questionText: 'Questão nova', correctAnswer: 'A', alternatives: [{ letter: 'A', text: 'Sim', isCorrect: true }, { letter: 'B', text: 'Não' }] });
    const replaced = await admin('post', '/api/admin/replace-question').send({ applicationId: application.id, questionNumber: target, bankQuestionKey: 'qb_troca' }).expect(200);
    attempts.forEach(started => {
        const state = stateOf(started.attemptId);
        const hadTarget = started.questions.some(question => question.originalNumber === target);
        assert.equal(state.assignedQuestionNumbers.includes(replaced.body.replacementNumber), hadTarget);
        assert.equal(state.assignedQuestionNumbers.length, hadTarget ? 3 : 2);
    });
    // O total da aplicação continua o do sorteio (o de cada um está na tentativa dele).
    assert.equal(db.memory.examApplications.find(item => item.id === application.id).questionCount, 2);
});

test('[UC-PROVA-007] sorteio pela semente: determinístico, sem repetir, e 200 sorteios usam todas as questões do pool', () => {
    const sorteio = { modo: 'por_aluno', grupos: [{ quantidade: 2, numeros: [1, 2, 3, 4, 5] }, { quantidade: 1, numeros: [6, 7, 8] }] };
    const first = examDraw.drawNumbers(sorteio, 'a1b2c3d4e5f60708');
    assert.deepEqual(examDraw.drawNumbers(sorteio, 'a1b2c3d4e5f60708'), first, 'a mesma semente dá o mesmo sorteio');
    const used = new Map();
    for (let i = 0; i < 200; i++) {
        const drawn = examDraw.drawNumbers(sorteio, examDraw.newDrawSeed());
        assert.equal(drawn.numbers.length, 3);
        assert.equal(new Set(drawn.numbers).size, 3);
        assert.equal(drawn.numbers.filter(number => number <= 5).length, 2);
        assert.deepEqual(drawn.drawGroups, [2, 1]);
        drawn.numbers.forEach(number => used.set(number, (used.get(number) || 0) + 1));
    }
    assert.deepEqual([...used.keys()].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8], 'todas as questões do pool aparecem');
    // Sem embaralhar as questões: a ordem do pool.
    const ordered = examDraw.drawNumbers(sorteio, 'ff00ff00ff00ff00', { shuffleOrder: false });
    assert.deepEqual(ordered.numbers, [...ordered.numbers].sort((a, b) => a - b));
    // A questão que entrou no lugar de uma sorteada vai junto.
    assert.deepEqual(examDraw.withReplacements([2, 6], { questions: [{ originalNumber: 9, isAdditional: true, replacedQuestionNumber: 6 }, { originalNumber: 10, isAdditional: true, replacedQuestionNumber: 3 }] }), [2, 6, 9]);
    // Aplicação de antes (sem sorteio): nada muda na tentativa.
    const state = { assignedQuestionNumbers: null };
    assert.equal(examDraw.ensureAttemptDraw(state, { versionSnapshots: [] }, null), false);
    assert.equal(state.assignedQuestionNumbers, null);
});

// Ajuste 1 da revisão (P3-S11): a entrada nova passa pelo inputSchema (um formato só de
// campo no erro), o aluno não recebe a semente do sorteio, a revisão do Monitor não mostra
// o pool inteiro de quem ainda não sorteou e a frase dos dois grupos só sai quando é a causa.
test('[UC-PROVA-007] versões e sorteio: entrada conferida por schema, semente fora da resposta do aluno e revisão de quem não sorteou', async () => {
    // versionCount: inteiro (também em texto); o resto é recusado com a frase de sempre.
    for (const bad of [4.5, 'abc', true, '2,5']) {
        const refused = await addHistory({ questionNumbers: [1, 2], versionCount: bad });
        assert.equal(refused.status, 400, `versionCount ${JSON.stringify(bad)}`);
        assert.equal(refused.body.error, 'Informe quantas versões online (de 1 a 4).');
        assert.equal(refused.body.field, 'versionCount');
    }
    const alias = await addHistory({ questionNumbers: [1, 2], onlineVersions: 'x' });
    assert.equal(alias.status, 400);
    assert.equal(alias.body.field, 'onlineVersions');
    const zero = await addHistory({ questionNumbers: [1, 2], versionCount: 0 });
    assert.equal(zero.status, 400);
    assert.equal(zero.body.error, 'Informe quantas versões online (de 1 a 4).');
    const asText = await addHistory({ questionNumbers: [1, 2], versionCount: '3' });
    assert.equal(asText.status, 200, JSON.stringify(asText.body));
    assert.equal(asText.body.entry.versionSnapshots.length, 3);
    const asNull = await addHistory({ questionNumbers: [1, 2], versionCount: null });
    assert.equal(asNull.status, 200);
    assert.equal(asNull.body.entry.versionSnapshots.length, 1);

    // draw-pool: numbers é uma lista de números separados por vírgula.
    const poolUrl = `/api/admin/exam-applications/draw-pool?studentClass=${encodeURIComponent(studentClass)}&courseId=${courseId}&examKey=${examKey}`;
    for (const bad of ['1;2', 'abc', '1,,2']) {
        const refused = await admin('get', `${poolUrl}&numbers=${encodeURIComponent(bad)}`);
        assert.equal(refused.status, 400, `numbers ${bad}`);
        assert.equal(refused.body.field, 'numbers');
        assert.equal(refused.body.error, 'O campo "questões" tem caracteres não permitidos.');
    }
    // Parâmetro repetido: vale o último (parseQueryLastValue do server.js).
    const repeated = await admin('get', `${poolUrl}&numbers=1&numbers=2`).expect(200);
    assert.deepEqual(repeated.body.questions.map(question => question.number), [2]);
    const spaced = await admin('get', `${poolUrl}&numbers=${encodeURIComponent('1, 7')}`).expect(200);
    assert.deepEqual(spaced.body.questions.map(question => question.number), [1, 7]);

    // O campo do erro no mesmo formato do schema, venha a recusa do tipo ou da quantidade.
    const saved = await addHistory({ questionNumbers: [1, 2, 3, 4, 5, 6, 7, 8], versionCount: 1 });
    const historyId = saved.body.entry.id;
    const prepare = sorteio => admin('post', '/api/admin/exam-applications').send({ studentClass, courseId, examKey, historyId, applicationOptions: { sorteio } });
    const asWord = await prepare({ modo: 'por_aluno', grupos: [{ filtro: {}, quantidade: 'dois' }] });
    assert.equal(asWord.status, 400);
    assert.equal(asWord.body.field, 'applicationOptions.sorteio.grupos[0].quantidade');
    const none = await prepare({ modo: 'por_aluno', grupos: [{ filtro: {}, quantidade: 0 }] });
    assert.equal(none.status, 400);
    assert.equal(none.body.field, 'applicationOptions.sorteio.grupos[0].quantidade');
    // Etiqueta que não existe no grupo 2: o filtro não combina com nada, sem a frase dos
    // dois grupos (ela só sai quando o grupo de cima levou as questões).
    const missingTag = await prepare({ modo: 'por_aluno', grupos: [{ filtro: { dificuldade: 'facil' }, quantidade: 1 }, { filtro: { tag: 'inexistente' }, quantidade: 1 }] });
    assert.equal(missingTag.status, 400);
    assert.equal(missingTag.body.error, 'Grupo 2: nenhuma questão da montagem combina com o filtro (questões com a etiqueta inexistente).');
    assert.equal(missingTag.body.field, 'applicationOptions.sorteio.grupos[1].quantidade');
    const taken = await prepare({ modo: 'por_aluno', grupos: [{ filtro: {}, quantidade: 1 }, { filtro: { dificuldade: 'dificil' }, quantidade: 1 }] });
    assert.equal(taken.status, 400);
    assert.match(taken.body.error, /\(a questão que serve para dois grupos fica no primeiro\)\.$/);

    const application = await prepareAndStart(historyId, { sorteio: DRAW });
    const [ana, bruno] = STUDENTS;
    const reviewOf = student => admin('get', `/api/admin/monitor-review/${encodeURIComponent(studentClass)}/${examKey}?courseId=${courseId}&applicationId=${application.id}&studentEmail=${encodeURIComponent(student.email)}`);

    // Quem ainda não abriu a prova não sorteou: a revisão não mostra as 8 questões do pool.
    const pending = await reviewOf(ana).expect(200);
    assert.equal(pending.body.drawPending, true);
    assert.equal(pending.body.status, 'not_started');
    assert.deepEqual(pending.body.questions, []);
    assert.equal(pending.body.totalCount, 3);

    // O aluno recebe as questões que tirou, nunca a semente nem a contagem por grupo.
    const before = await request(app).get('/api/student/sync').set('x-session-token', ana.token)
        .query({ email: ana.email, studentClass, courseId, examKey, applicationId: application.id }).expect(200);
    assert.equal(JSON.stringify(before.body).includes('drawSeed'), false);
    assert.equal(JSON.stringify(before.body).includes('drawGroups'), false);
    const started = await request(app).post(`/api/student/exam-applications/${application.id}/start-attempt`)
        .set('x-session-token', ana.token).send({}).expect(200);
    assert.equal(JSON.stringify(started.body).includes('drawSeed'), false);
    assert.equal(JSON.stringify(started.body).includes('drawGroups'), false);
    assert.equal(started.body.questions.length, 3);
    const after = await request(app).get('/api/student/sync').set('x-session-token', ana.token)
        .query({ email: ana.email, studentClass, courseId, examKey, applicationId: application.id }).expect(200);
    assert.equal(JSON.stringify(after.body).includes('drawSeed'), false);
    assert.ok(stateOf(started.body.attemptId).drawSeed, 'a semente continua guardada no servidor');

    // Depois de sortear, a revisão mostra só as 3 dele; a de quem não abriu continua vazia.
    const drawn = await reviewOf(ana).expect(200);
    assert.equal(drawn.body.drawPending, undefined);
    assert.deepEqual(drawn.body.questions.map(question => question.questionNumber), started.body.questions.map(question => question.originalNumber));
    assert.equal(drawn.body.totalCount, 3);
    const other = await reviewOf(bruno).expect(200);
    assert.equal(other.body.drawPending, true);
    assert.deepEqual(other.body.questions, []);
});

test('[UC-PROVA-007] impressa com alternativa vazia na prova passa na conferência (a tela de antes mandava "[object Object]")', async () => {
    db.memory.evaluations[examKey].questions[0].alternatives[2].text = '';
    const garbled = browserVersion([1, 2]);
    garbled.questions[0].alternatives[2].text = '[object Object]';
    const saved = await addHistory({ type: 'impressa', questionNumbers: [1, 2], printSnapshot: [garbled] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.entry.printSnapshot[0].questions[0].alternatives[2].text, '', 'o texto guardado é o da prova');
    assert.equal(saved.body.entry.versionSnapshots[0].questions[0].alternatives[2].text, '');

    const blank = browserVersion([1, 2]);
    blank.questions[0].alternatives[2].text = '';
    assert.equal((await addHistory({ type: 'impressa', questionNumbers: [1, 2], printSnapshot: [blank] })).status, 200);

    // Texto de verdade diferente do da prova continua recusado, e '[object Object]' só vale
    // onde a prova tem a alternativa vazia.
    const invented = browserVersion([1, 2]);
    invented.questions[0].alternatives[2].text = 'Inventada';
    assert.equal((await addHistory({ type: 'impressa', questionNumbers: [1, 2], printSnapshot: [invented] })).status, 400);
    const elsewhere = browserVersion([1, 2]);
    elsewhere.questions[1].alternatives[2].text = '[object Object]';
    const refused = await addHistory({ type: 'impressa', questionNumbers: [1, 2], printSnapshot: [elsewhere] });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, 'snapshot_mismatch');
});
