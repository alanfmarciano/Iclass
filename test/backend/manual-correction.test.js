// Correção do professor no servidor (fase 3, P3-S4a: AVA-07; D7, D8, D12 e P-B6 do
// desenho do P3; contrato C1).
//
// - a entrega com questão que espera o professor nasce com correcao.situacao 'pendente'
//   (online e cartão-resposta da prova impressa) e fica fora da nota consolidada, da
//   publicação e das médias (aguardandoCorrecao);
// - GET /api/admin/corrections é a fila; GET/POST /api/admin/submissions/:id/correction
//   leem e gravam os pontos, a rubrica, os comentários e a conclusão;
// - concluir recalcula a nota (pontos obtidos / possíveis) com o histórico (scoreHistory)
//   e a auditoria (grade_manual_correction, grade_item_override, grade_correction_completed);
// - recusas: versão velha (409), pontos acima do possível, rubrica fora do máximo, ajuste
//   de questão corrigida pelo sistema sem motivo, concluir sem todos os pontos, nota
//   publicada que muda sem motivo (400), fora do escopo (404);
// - o aluno não vê nota parcial enquanto a correção está pendente; o comentário geral e
//   os pontos da correção só com a nota publicada; a explicação e o comentário por
//   questão só com o gabarito liberado (D12).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-manual-correction-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { createSubmissionFromAttempt } = require('../../backend/utils/examGrading.js');
const { calculateAttemptResult } = require('../../backend/utils/submissionAttempts.js');
const { sanitizeSubmissionForStudent } = require('../../backend/middlewares.js');
const { queueItems } = require('../../backend/routes/adminCorrections.js');

let app;
const adminToken = 'admin-token-correction';
const professorToken = 'professor-token-correction';
const otherProfessorToken = 'other-professor-token-correction';
const coordToken = 'coord-token-correction';
const studentClass = '1INF';
const otherClass = '2INF';
const courseId = 'curso-correcao';
const examKey = 'Avaliacao_Correcao';
const ALICE = 'alice@correcao.local';
const BRUNO = 'bruno@correcao.local';

const as = token => req => req.set('x-admin-session', token);
const admin = as(adminToken);
const professor = as(professorToken);

const QUESTIONS = [
    {
        originalNumber: 1, number: 1, type: 'multiple_choice', points: 1, text: 'Qual porta do HTTP?', correctAnswer: 'A',
        alternatives: [{ letter: 'A', text: '80', isCorrect: true }, { letter: 'B', text: '21', isCorrect: false }],
        explanation: 'A porta padrão do HTTP é a **80**.',
    },
    {
        originalNumber: 2, number: 2, type: 'essay', points: 2, text: 'Explique o que é um protocolo.',
        expectedAnswer: 'Conjunto de regras de comunicação.',
        rubric: [{ id: 'ideia', nome: 'Ideia central', pontos: 1 }, { id: 'clareza', nome: 'Clareza', pontos: 1 }],
        explanation: 'Protocolo é um acordo de regras.',
    },
    {
        originalNumber: 3, number: 3, type: 'short_answer', points: 1, text: 'Sigla do protocolo de transporte confiável.',
        acceptedAnswers: ['TCP'],
    },
];

function seed() {
    db.memory.admins = [
        { email: 'admin@correcao.local', name: 'Admin', role: 'admin', password: db.hashPassword('senha-administrativa') },
        { email: 'prof@correcao.local', name: 'Prof Turma', role: 'professor', password: db.hashPassword('senha-professor-x'), assignedClasses: [{ courseId, className: studentClass }] },
        { email: 'prof@outra.local', name: 'Prof Outra', role: 'professor', password: db.hashPassword('senha-professor-y'), assignedClasses: [{ courseId, className: otherClass }] },
        { email: 'coord@correcao.local', name: 'Coordenação', role: 'coordenacao', password: db.hashPassword('senha-coordenacao'), assignedSchoolIds: ['esc_correcao'] },
    ];
    db.memory.adminSessions = {
        [adminToken]: { email: 'admin@correcao.local', createdAt: Date.now(), lastSeen: Date.now() },
        [professorToken]: { email: 'prof@correcao.local', createdAt: Date.now(), lastSeen: Date.now() },
        [otherProfessorToken]: { email: 'prof@outra.local', createdAt: Date.now(), lastSeen: Date.now() },
        [coordToken]: { email: 'coord@correcao.local', createdAt: Date.now(), lastSeen: Date.now() },
    };
    const student = (name, email) => ({ name, email, status: 'Ativo', classes: [{ name: studentClass, courseId }] });
    db.memory.students = [student('Alice Souza', ALICE), student('Bruno Lima', BRUNO)];
    db.memory.schools = [{ id: 'esc_correcao', name: 'Escola' }];
    db.memory.courses = [{ id: courseId, schoolId: 'esc_correcao', structure: [{ name: 'Módulo', units: [{ avaliacaoKey: examKey }] }] }];
    db.memory.classes = [
        { name: studentClass, courseId, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} },
        { name: otherClass, courseId, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} },
    ];
    db.memory.evaluations = { [examKey]: { key: examKey, title: 'Prova de redes', questions: JSON.parse(JSON.stringify(QUESTIONS)) } };
    db.memory.examApplications = [{
        id: 'app_correcao', examKey, studentClass, courseId, status: 'finished',
        versionSnapshots: [{ version: 'A', questions: JSON.parse(JSON.stringify(QUESTIONS)) }],
        annulledQuestions: [],
    }];
    db.memory.submissions = [];
    db.memory.auditLogs = [];
    db.memory.studentExamState = {};
}

test.before(async () => {
    await db.init();
    app = createApp();
});
test.beforeEach(() => seed());
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

// Entrega online pelo mesmo caminho do envio do aluno (createSubmissionFromAttempt).
function deliver(email, answers, extra = {}) {
    const application = db.memory.examApplications[0];
    const submission = createSubmissionFromAttempt({
        application,
        onlineConfig: {},
        state: { studentEmail: email, studentClass, courseId, examKey, applicationId: application.id, assignedVersion: 'A', assignedQuestionNumbers: [1, 2, 3], attemptNumber: extra.attemptNumber || 1 },
        evaluation: db.memory.evaluations[examKey],
        student: db.memory.students.find(item => item.email === email),
        answers,
    });
    Object.assign(submission, extra);
    db.memory.submissions.push(submission);
    return submission;
}

const getCorrection = (id, who = admin) => who(request(app).get(`/api/admin/submissions/${id}/correction`));
const postCorrection = (id, payload, who = admin) => who(request(app).post(`/api/admin/submissions/${id}/correction`)).send(payload);

test('[UC-CORRECAO-001] entrega com dissertativa nasce aguardando correção e fica fora da nota consolidada', () => {
    const pending = deliver(ALICE, { 1: 'A', 2: { texto: 'Regras de comunicação entre máquinas.' }, 3: { texto: 'tcp' } });
    assert.equal(pending.correcao.situacao, 'pendente');
    assert.equal(pending.correcao.versao, 1);
    const essay = pending.gradedAnswers.find(item => Number(item.questionNumber) === 2);
    assert.equal(essay.pending, true);
    // Sem a correção, a nota de 2 de 4 pontos (parcial) não entra no consolidado.
    const result = calculateAttemptResult([pending]);
    assert.equal(result.score, null);
    assert.equal(result.aguardandoCorrecao, true);
    // Entrega toda objetiva: sem correção pendente.
    db.memory.evaluations[examKey].questions = QUESTIONS.slice(0, 1);
    db.memory.examApplications[0].versionSnapshots[0].questions = QUESTIONS.slice(0, 1).map(item => ({ ...item }));
    const objective = deliver(BRUNO, { 1: 'A' });
    assert.equal(objective.correcao, undefined);
    assert.equal(calculateAttemptResult([objective]).aguardandoCorrecao, false);
});

test('[UC-CORRECAO-001] fila, leitura com gabarito, gravação parcial e conclusão com nota, histórico e auditoria', async () => {
    const submission = deliver(ALICE, { 1: 'A', 2: { texto: 'Regras de comunicação entre máquinas.' }, 3: { texto: 'tcp' } });
    // Dissertativa em branco vale 0 sem esperar o professor (P3-S1): o Bruno escreveu.
    deliver(BRUNO, { 1: 'B', 2: { texto: 'Não sei.' } });

    const queue = await professor(request(app).get('/api/admin/corrections')).query({ courseId, studentClass }).expect(200);
    assert.equal(queue.body.total, 2);
    const aliceRow = queue.body.pendentes.find(row => row.aluno.email === ALICE);
    assert.equal(aliceRow.submissionId, submission.id);
    assert.equal(aliceRow.prova, 'Prova de redes');
    assert.deepEqual(aliceRow.questoesPendentes, [2]);
    assert.equal(aliceRow.versao, 1);
    // Fora do escopo da conta: fila vazia e entrega não encontrada.
    const foreign = await as(otherProfessorToken)(request(app).get('/api/admin/corrections')).expect(200);
    assert.equal(foreign.body.total, 0);
    await getCorrection(submission.id, as(otherProfessorToken)).expect(404);
    await postCorrection(submission.id, { versao: 1, itens: { 2: { pontos: 1 } } }, as(otherProfessorToken)).expect(404);

    const read = await getCorrection(submission.id, professor).expect(200);
    assert.equal(read.body.situacao, 'pendente');
    assert.equal(read.body.versao, 1);
    const essayRow = read.body.questoes.find(row => row.questionNumber === 2);
    assert.equal(essayRow.precisaDoProfessor, true);
    assert.equal(essayRow.studentResponse, 'Regras de comunicação entre máquinas.');
    assert.equal(essayRow.expectedAnswer, 'Conjunto de regras de comunicação.');
    assert.equal(essayRow.rubric.length, 2);
    const shortRow = read.body.questoes.find(row => row.questionNumber === 3);
    assert.equal(shortRow.precisaDoProfessor, false, 'a resposta curta que bate é corrigida pelo sistema');
    assert.equal(shortRow.pointsEarned, 1);

    // Gravação parcial: rubrica e comentário, sem concluir. A nota continua fora.
    const partial = await postCorrection(submission.id, {
        versao: 1, itens: { 2: { rubrica: { ideia: 1, clareza: 0.5 }, comentario: 'Faltou um exemplo.' } }, comentarioGeral: 'Bom trabalho.',
    }, professor).expect(200);
    assert.equal(partial.body.situacao, 'pendente');
    assert.equal(partial.body.versao, 2);
    const stored = () => db.memory.submissions.find(item => item.id === submission.id);
    assert.equal(stored().correcao.itens['2'].pontos, 1.5, 'sem pontos, vale a soma da rubrica');
    assert.equal(stored().correcao.itens['2'].por, 'prof@correcao.local');
    assert.equal(calculateAttemptResult([stored()]).score, null, 'gravar sem concluir não solta a nota');
    assert.ok(db.memory.auditLogs.some(entry => entry.action === 'grade_manual_correction' && entry.submissionId === submission.id));

    // Duas abas: a versão velha é recusada sem mudar nada.
    const conflict = await postCorrection(submission.id, { versao: 1, itens: { 2: { pontos: 2 } } }, professor).expect(409);
    assert.equal(conflict.body.code, 'correction_conflict');
    assert.equal(stored().correcao.itens['2'].pontos, 1.5);

    // Concluir: a nota sai (1 + 1,5 + 1 = 3,5 de 4 → 87,5%, gravada como 88), com o histórico.
    const done = await postCorrection(submission.id, { versao: 2, concluir: true }, professor).expect(200);
    assert.equal(done.body.situacao, 'concluida');
    assert.equal(done.body.pointsEarned, 3.5);
    assert.equal(done.body.pointsPossible, 4);
    assert.equal(stored().score, 88);
    assert.equal(stored().correcao.concluidaPor, 'prof@correcao.local');
    assert.ok(stored().correcao.concluidaEm);
    assert.ok(Array.isArray(stored().scoreHistory) && stored().scoreHistory.length >= 1);
    const essayGraded = stored().gradedAnswers.find(item => Number(item.questionNumber) === 2);
    assert.equal(essayGraded.pending, false);
    assert.equal(essayGraded.pointsEarned, 1.5);
    const completed = db.memory.auditLogs.find(entry => entry.action === 'grade_correction_completed');
    assert.ok(completed, 'concluir grava grade_correction_completed');
    assert.match(completed.newValue, /8,8/);
    assert.equal(calculateAttemptResult([stored()]).score, 88);
    assert.equal(calculateAttemptResult([stored()]).aguardandoCorrecao, false);

    // A fila não traz mais a Alice; o item "Precisa de você" conta o Bruno.
    const after = await professor(request(app).get('/api/admin/corrections')).query({ courseId, studentClass }).expect(200);
    assert.deepEqual(after.body.pendentes.map(row => row.aluno.email), [BRUNO]);
    const cls = db.memory.classes.find(item => item.name === studentClass);
    const [item] = queueItems({ memory: db.memory, cls });
    assert.equal(item.id, 'provas_aguardando_correcao');
    assert.equal(item.count, 1);
    assert.equal(item.permissao, 'page.results');
    assert.equal(item.somenteQuemAltera, true);
});

test('[UC-CORRECAO-001] recusas: acima do possível, rubrica fora do máximo, ajuste sem motivo, concluir incompleto', async () => {
    const submission = deliver(ALICE, { 1: 'A', 2: { texto: 'Resposta.' }, 3: { texto: 'udp' } });
    const stored = () => db.memory.submissions.find(item => item.id === submission.id);

    const above = await postCorrection(submission.id, { versao: 1, itens: { 2: { pontos: 3 } } }).expect(400);
    assert.match(above.body.error, /2/);
    const rubric = await postCorrection(submission.id, { versao: 1, itens: { 2: { rubrica: { ideia: 1.5 } } } }).expect(400);
    assert.match(rubric.body.field, /rubrica/);
    const mismatch = await postCorrection(submission.id, { versao: 1, itens: { 2: { pontos: 2, rubrica: { ideia: 1, clareza: 0.5 } } } }).expect(400);
    assert.match(mismatch.body.field, /itens\.2/);
    const unknown = await postCorrection(submission.id, { versao: 1, itens: { 9: { pontos: 1 } } }).expect(400);
    assert.match(unknown.body.field, /itens\.9/);
    // A questão 1 foi corrigida pelo sistema (1 ponto): mudar pede motivo.
    const override = await postCorrection(submission.id, { versao: 1, itens: { 1: { pontos: 0 } } }).expect(400);
    assert.equal(override.body.code, 'reason_required');
    // A resposta curta "udp" não bate e a questão não manda revisar: 0 pelo sistema.
    const incomplete = await postCorrection(submission.id, { versao: 1, concluir: true }).expect(400);
    assert.equal(incomplete.body.code, 'correction_incomplete');
    assert.deepEqual(incomplete.body.missing, [2]);
    assert.equal(stored().correcao.versao, 1, 'nenhuma recusa grava');
    assert.equal(db.memory.auditLogs.filter(entry => /^grade_/.test(entry.action)).length, 0);

    // Com motivo, o ajuste da objetiva vale e vai para a auditoria como grade_item_override.
    const adjusted = await postCorrection(submission.id, { versao: 1, itens: { 1: { pontos: 0.5, motivo: 'Resposta incompleta no papel' }, 2: { pontos: 2 } }, concluir: true }).expect(200);
    assert.equal(adjusted.body.situacao, 'concluida');
    assert.equal(stored().score, 63, '0,5 + 2 + 0 de 4 (62,5%)');
    const audit = db.memory.auditLogs.find(entry => entry.action === 'grade_item_override');
    assert.ok(audit);
    assert.equal(audit.reason, 'Resposta incompleta no papel');
});

test('[UC-CORRECAO-001] nota publicada que muda pede motivo; a Coordenação só lê', async () => {
    const submission = deliver(ALICE, { 1: 'A', 2: { texto: 'Resposta.' }, 3: { texto: 'tcp' } });
    await postCorrection(submission.id, { versao: 1, itens: { 2: { pontos: 1 } }, concluir: true }).expect(200);
    const stored = () => db.memory.submissions.find(item => item.id === submission.id);
    stored().gradePublished = true;
    const before = stored().score;

    await getCorrection(submission.id, as(coordToken)).expect(200);
    await postCorrection(submission.id, { versao: 2, itens: { 2: { pontos: 2 } } }, as(coordToken)).expect(403);

    const noReason = await postCorrection(submission.id, { versao: 2, itens: { 2: { pontos: 2 } } }).expect(400);
    assert.equal(noReason.body.code, 'reason_required');
    assert.equal(stored().score, before);
    // Só comentário (a nota não muda): não pede motivo.
    await postCorrection(submission.id, { versao: 2, comentarioGeral: 'Revise a questão 2.' }).expect(200);
    const withReason = await postCorrection(submission.id, { versao: 3, itens: { 2: { pontos: 2 } }, motivo: 'Revisão pedida pelo aluno' }).expect(200);
    assert.equal(withReason.body.score, 100);
    assert.equal(stored().score, 100);
});

test('[UC-CORRECAO-001] publicar pula a entrega aguardando correção', async () => {
    const pending = deliver(ALICE, { 1: 'A', 2: { texto: 'Resposta.' }, 3: { texto: 'tcp' } });
    db.memory.evaluations[examKey].questions = QUESTIONS.slice(0, 1);
    db.memory.examApplications[0].versionSnapshots[0].questions = QUESTIONS.slice(0, 1).map(item => ({ ...item }));
    const objective = deliver(BRUNO, { 1: 'A' });
    const published = await admin(request(app).post('/api/admin/submissions/publish')).send({ ids: [pending.id, objective.id], published: true }).expect(200);
    assert.equal(published.body.skippedPendingCorrection, 1);
    assert.equal(db.memory.submissions.find(item => item.id === pending.id).gradePublished, false);
    assert.equal(db.memory.submissions.find(item => item.id === objective.id).gradePublished, true);
});

test('[UC-CORRECAO-001] prova impressa pelo cartão-resposta: a dissertativa espera o professor', async () => {
    const response = await admin(request(app).post('/api/admin/submissions/create')).send({
        studentEmail: ALICE, examKey, studentClass, courseId, type: 'impressa', mode: 'card', answers: { 1: 'A' }, questionNumbers: [1, 2],
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.awaitingCorrection, true);
    assert.match(response.body.message, /aguarda a sua correção/);
    const stored = db.memory.submissions.find(item => item.student?.email === ALICE);
    assert.equal(stored.answersOnPaper, true);
    assert.equal(stored.correcao.situacao, 'pendente');
    assert.equal(stored.gradedAnswers.find(item => Number(item.questionNumber) === 2).pending, true);
    assert.equal(stored.examSnapshot.questions.length, 2);

    const read = await getCorrection(stored.id).expect(200);
    assert.deepEqual(read.body.questoes.filter(row => row.precisaDoProfessor).map(row => row.questionNumber), [2]);
    const done = await postCorrection(stored.id, { versao: 1, itens: { 2: { pontos: 1 } }, concluir: true }).expect(200);
    // 1 (a marcada) + 1 (dissertativa) de 3 pontos.
    assert.equal(done.body.pointsEarned, 2);
    assert.equal(done.body.pointsPossible, 3);
    const after = db.memory.submissions.find(item => item.id === stored.id);
    assert.equal(after.answersOnPaper, true);
    assert.equal(after.gradedAnswers.find(item => Number(item.questionNumber) === 2).pending, false);
    assert.equal(after.score, 67);

    // Cartão só de escolha única: como antes (acertos / total), sem correção.
    const objective = await admin(request(app).post('/api/admin/submissions/create')).send({
        studentEmail: BRUNO, examKey, studentClass, courseId, type: 'impressa', mode: 'card', answers: { 1: 'B' }, questionNumbers: [1],
    }).expect(200);
    assert.notEqual(objective.body.awaitingCorrection, true);
    const bruno = db.memory.submissions.find(item => item.student?.email === BRUNO);
    assert.equal(bruno.correcao, undefined);
    assert.equal(bruno.score, 0);
});

test('[UC-CORRECAO-001] aluno: sem nota parcial com correção pendente; comentário e explicação pelo D12', () => {
    const pending = deliver(ALICE, { 1: 'A', 2: { texto: 'Resposta.' }, 3: { texto: 'tcp' } }, { gradePublished: true });
    const hidden = sanitizeSubmissionForStudent(pending, true);
    assert.equal(hidden.aguardandoCorrecao, true);
    assert.equal(hidden.gradePublished, false, 'pendente não aparece como publicada');
    assert.equal(hidden.score ?? null, null);
    assert.equal(hidden.correcao, undefined);
    assert.equal(hidden.integrity, undefined);
    assert.doesNotMatch(JSON.stringify(hidden), /Conjunto de regras/, 'a resposta esperada nunca vai ao aluno');
    (hidden.gradedAnswers || []).forEach(item => assert.equal(item.pointsEarned, undefined));

    const corrected = JSON.parse(JSON.stringify(pending));
    corrected.correcao = {
        situacao: 'concluida', versao: 3, comentarioGeral: 'Bom trabalho.', concluidaPor: 'prof@correcao.local', concluidaEm: new Date().toISOString(),
        itens: { 2: { pontos: 2, comentario: 'Ótima explicação.', por: 'prof@correcao.local', em: Date.now() } },
    };
    corrected.score = 100;
    corrected.gradePublished = false;
    // Gabarito liberado, nota não publicada: explicação sim; comentário e pontos da correção não.
    const keyOnly = sanitizeSubmissionForStudent(corrected, true);
    assert.equal(keyOnly.comentarioGeral, undefined);
    assert.ok(keyOnly.examQuestions.some(question => question.explanation === 'Protocolo é um acordo de regras.'));
    assert.doesNotMatch(JSON.stringify(keyOnly), /Ótima explicação/);
    // Nota publicada, gabarito não liberado: comentário geral sim, explicação e comentário por questão não.
    corrected.gradePublished = true;
    const gradeOnly = sanitizeSubmissionForStudent(corrected, false);
    assert.equal(gradeOnly.comentarioGeral, 'Bom trabalho.');
    assert.equal(gradeOnly.score, 100);
    assert.doesNotMatch(JSON.stringify(gradeOnly), /acordo de regras|Ótima explicação/);
    // Os dois: tudo.
    const both = sanitizeSubmissionForStudent(corrected, true);
    assert.match(JSON.stringify(both), /Ótima explicação/);
});

test('[UC-CORRECAO-001] entrega antiga (sem correcao) com dissertativa pendente também espera; a concluída antiga conta', () => {
    const legacy = deliver(ALICE, { 1: 'A', 2: { texto: 'Resposta.' }, 3: { texto: 'tcp' } });
    delete legacy.correcao;
    assert.equal(calculateAttemptResult([legacy]).aguardandoCorrecao, true, 'questão pendente sem correcao ainda espera');
    const older = deliver(ALICE, { 1: 'A' }, { attemptNumber: 2 });
    delete older.correcao;
    older.gradedAnswers = older.gradedAnswers.map(item => ({ ...item, pending: false }));
    older.score = 5;
    const result = calculateAttemptResult([legacy, older]);
    assert.equal(result.score, 5, 'a tentativa sem pendência conta; a que espera fica fora');
    assert.equal(result.aguardandoCorrecao, true);
});

// A9, ajuste 1 (D7): apagar os pontos de uma questão que espera o professor numa correção
// concluída reabre a correção; antes ela ficava 'concluida' com a nota só das objetivas,
// que entrava nas médias e podia ser publicada.
test('[UC-CORRECAO-001] apagar os pontos da dissertativa numa correção concluída a reabre', async () => {
    const submission = deliver(ALICE, { 1: 'A', 2: { texto: 'Regras.' }, 3: { texto: 'tcp' } });
    const stored = () => db.memory.submissions.find(item => item.id === submission.id);
    await postCorrection(submission.id, { versao: 1, itens: { 2: { pontos: 2 } }, concluir: true }, professor).expect(200);
    assert.equal(stored().score, 100);
    const versao = stored().correcao.versao;

    // Concluir de novo sem os pontos: recusado sem mudar nada.
    const refused = await postCorrection(submission.id, { versao, itens: { 2: null }, concluir: true }, professor).expect(400);
    assert.equal(refused.body.code, 'correction_incomplete');
    assert.deepEqual(refused.body.missing, [2]);
    assert.equal(stored().correcao.situacao, 'concluida');
    assert.equal(stored().correcao.versao, versao);

    const reopened = await postCorrection(submission.id, { versao, itens: { 2: null } }, professor).expect(200);
    assert.equal(reopened.body.situacao, 'pendente');
    assert.equal(reopened.body.reaberta, true);
    assert.equal(stored().correcao.situacao, 'pendente');
    assert.equal(stored().correcao.reabertaPor, 'prof@correcao.local');
    assert.ok(stored().correcao.reabertaEm);
    assert.equal(stored().correcao.itens['2'], undefined);
    const result = calculateAttemptResult([stored()]);
    assert.equal(result.score, null, 'a parcial das objetivas não entra na conta');
    assert.equal(result.aguardandoCorrecao, true);
    const queue = await professor(request(app).get('/api/admin/corrections')).query({ courseId, studentClass }).expect(200);
    assert.deepEqual(queue.body.pendentes.map(row => row.aluno.email), [ALICE]);
    assert.deepEqual(queue.body.pendentes[0].questoesPendentes, [2]);
    const audit = db.memory.auditLogs.filter(entry => entry.action === 'grade_manual_correction').pop();
    assert.match(audit.newValue, /aguardando correção/);
    // Publicar pula a entrega reaberta.
    const published = await admin(request(app).post('/api/admin/submissions/publish')).send({ ids: [submission.id], published: true }).expect(200);
    assert.equal(published.body.skippedPendingCorrection, 1);
    assert.equal(stored().gradePublished, false);

    // Com a nota publicada, reabrir pede o motivo (o aluno deixa de ver a nota).
    const again = stored().correcao.versao;
    await postCorrection(submission.id, { versao: again, itens: { 2: { pontos: 1 } }, concluir: true }, professor).expect(200);
    stored().gradePublished = true;
    const v3 = stored().correcao.versao;
    const noReason = await postCorrection(submission.id, { versao: v3, itens: { 2: null } }, professor).expect(400);
    assert.equal(noReason.body.code, 'reason_required');
    assert.equal(stored().correcao.situacao, 'concluida');
    await postCorrection(submission.id, { versao: v3, itens: { 2: null }, motivo: 'Vou corrigir de novo' }, professor).expect(200);
    assert.equal(stored().correcao.situacao, 'pendente');
    const forStudent = sanitizeSubmissionForStudent(stored(), true);
    assert.equal(forStudent.aguardandoCorrecao, true);
    assert.equal(forStudent.score ?? null, null);
});

// syncCorrectionWithGrade (examGrading.js): a recorreção (anulação de questão, gabarito)
// mantém a correção manual, conclui pelo sistema a entrega que esperava sem nada lançado
// e reabre a concluída que passou a ter questão esperando o professor.
test('[UC-CORRECAO-001] recorreção por anulação mantém a correção manual das dissertativas', async () => {
    const alice = deliver(ALICE, { 1: 'A', 2: { texto: 'Regras de comunicação.' }, 3: { texto: 'tcp' } });
    const bruno = deliver(BRUNO, { 1: 'B', 2: { texto: 'Não sei bem.' }, 3: { texto: 'tcp' } });
    const stored = id => db.memory.submissions.find(item => item.id === id);
    await postCorrection(alice.id, { versao: 1, itens: { 2: { pontos: 1.5, comentario: 'Faltou exemplo.' } }, comentarioGeral: 'Bom.', concluir: true }).expect(200);
    assert.equal(stored(alice.id).score, 88, '1 + 1,5 + 1 de 4');
    const annul = number => admin(request(app).post('/api/admin/annul-question')).send({ applicationId: 'app_correcao', questionNumber: number, mode: 'remover_do_total', reason: 'Enunciado ambíguo' });

    // Anular a questão 1 (objetiva): a Alice continua com os pontos e o comentário da
    // dissertativa e a nota é refeita sem a questão 1; o Bruno continua esperando.
    await annul(1).expect(200);
    const a1 = stored(alice.id);
    assert.equal(a1.correcao.situacao, 'concluida');
    assert.equal(a1.correcao.itens['2'].pontos, 1.5);
    assert.equal(a1.correcao.itens['2'].comentario, 'Faltou exemplo.');
    assert.equal(a1.correcao.comentarioGeral, 'Bom.');
    assert.equal(a1.gradedAnswers.find(item => Number(item.questionNumber) === 2).studentResponse, 'Regras de comunicação.');
    assert.equal(a1.score, 83, '1,5 + 1 de 3');
    assert.equal(stored(bruno.id).correcao.situacao, 'pendente');
    assert.equal(calculateAttemptResult([stored(bruno.id)]).aguardandoCorrecao, true);

    // Anular a dissertativa: o Bruno, que esperava sem nada lançado, é concluído pelo
    // sistema; a Alice fica como estava (concluída pelo professor).
    await annul(2).expect(200);
    const b2 = stored(bruno.id);
    assert.equal(b2.correcao.situacao, 'concluida');
    assert.equal(b2.correcao.concluidaPeloSistema, true);
    assert.equal(calculateAttemptResult([b2]).aguardandoCorrecao, false);
    assert.equal(b2.score, 100, 'só a questão 3 conta');
    const a2 = stored(alice.id);
    assert.equal(a2.correcao.situacao, 'concluida');
    assert.equal(a2.correcao.concluidaPeloSistema, undefined);
    assert.equal(a2.correcao.itens['2'].pontos, 1.5, 'os pontos lançados continuam guardados');
});

test('[UC-CORRECAO-001] syncCorrectionWithGrade: nasce pendente, reabre a concluída, conclui a vazia e respeita a lançada', () => {
    const { syncCorrectionWithGrade } = require('../../backend/utils/examGrading.js');
    const fresh = {};
    assert.equal(syncCorrectionWithGrade(fresh, 1), 'pendente');
    assert.equal(fresh.correcao.situacao, 'pendente');
    assert.equal(fresh.correcao.versao, 1);

    const done = { correcao: { situacao: 'concluida', versao: 4, itens: { 2: { pontos: 1 } } } };
    assert.equal(syncCorrectionWithGrade(done, 1, { by: 'prof@x', now: 1234 }), 'reaberta');
    assert.equal(done.correcao.situacao, 'pendente');
    assert.equal(done.correcao.versao, 5);
    assert.equal(done.correcao.reabertaPor, 'prof@x');
    assert.equal(done.correcao.reabertaEm, 1234);
    assert.equal(syncCorrectionWithGrade(done, 1), null, 'já pendente: nada muda');

    const empty = { correcao: { situacao: 'pendente', versao: 1, itens: {} } };
    assert.equal(syncCorrectionWithGrade(empty, 0, { by: 'sistema' }), 'concluida');
    assert.equal(empty.correcao.situacao, 'concluida');
    assert.equal(empty.correcao.concluidaPeloSistema, true);
    assert.equal(empty.correcao.versao, 2);

    const started = { correcao: { situacao: 'pendente', versao: 2, itens: { 2: { pontos: 1 } } } };
    assert.equal(syncCorrectionWithGrade(started, 0), null, 'com pontos lançados, quem conclui é o professor');
    assert.equal(started.correcao.situacao, 'pendente');

    const legacy = {};
    assert.equal(syncCorrectionWithGrade(legacy, 0), null, 'entrega sem questão para o professor não ganha correcao');
    assert.equal(legacy.correcao, undefined);
});

// A9, ajuste 1: o que o aluno e a ficha mostram da tentativa anulada e da que aguarda
// correção.
test('[UC-CORRECAO-001] anulada com zero: o aluno vê 0 sem os acertos; "não conta" e reaberta não avisam "Nota publicada"', async () => {
    const studentToken = 'aluno-token-correcao';
    db.memory.students.find(item => item.email === ALICE).password = db.hashPassword('123');
    db.memory.sessions = { [ALICE]: { token: studentToken, lastSeen: Date.now(), ip: '127.0.0.1' } };
    const zero = deliver(ALICE, { 1: 'A', 2: { texto: 'Regras.' }, 3: { texto: 'tcp' } });
    await postCorrection(zero.id, { versao: 1, itens: { 2: { pontos: 2 } }, concluir: true }).expect(200);
    const stored = id => db.memory.submissions.find(item => item.id === id);
    Object.assign(stored(zero.id), { gradePublished: true, integrity: { decisao: 'zero', motivo: 'Cola', por: 'prof', em: Date.now() } });
    const seen = sanitizeSubmissionForStudent(stored(zero.id), true);
    assert.equal(seen.score, 0);
    assert.equal(seen.anulada, 'zero');
    assert.equal(seen.correctCount, undefined);
    assert.equal(seen.totalCount, undefined);
    (seen.gradedAnswers || []).forEach(item => assert.equal(item.pointsEarned, undefined));
    assert.doesNotMatch(JSON.stringify(seen), /Cola/, 'o motivo não vai ao aluno');

    const bell = async () => (await request(app).get(`/api/student/notifications?courseId=${courseId}&studentClass=${studentClass}`).set('x-session-token', studentToken).expect(200)).body.items
        .filter(item => item.title === 'Nota publicada').map(item => item.id);
    assert.deepEqual(await bell(), [`nota:${zero.id}`], '"Fica zero" com a nota publicada avisa (o aluno vê 0)');
    stored(zero.id).integrity.decisao = 'desconsiderar';
    assert.deepEqual(await bell(), [], '"Não conta" não tem nota para avisar');
    delete stored(zero.id).integrity;
    stored(zero.id).correcao.situacao = 'pendente';
    assert.deepEqual(await bell(), [], 'a que voltou a aguardar correção não avisa');
});

test('[UC-CORRECAO-001] ficha do aluno: a anulada com zero conta 0, a "não conta" e a que aguarda correção ficam sem nota', async () => {
    const zero = deliver(ALICE, { 1: 'A', 2: { texto: 'Regras.' }, 3: { texto: 'tcp' } });
    await postCorrection(zero.id, { versao: 1, itens: { 2: { pontos: 2 } }, concluir: true }).expect(200);
    db.memory.submissions.find(item => item.id === zero.id).integrity = { decisao: 'zero', motivo: 'Cola', por: 'prof', em: Date.now() };
    const pending = deliver(ALICE, { 1: 'A', 2: { texto: 'Outra.' }, 3: { texto: 'tcp' } }, { attemptNumber: 2 });
    const ignored = deliver(ALICE, { 1: 'A', 2: { texto: 'Mais uma.' }, 3: { texto: 'tcp' } }, { attemptNumber: 3 });
    await postCorrection(ignored.id, { versao: 1, itens: { 2: { pontos: 2 } }, concluir: true }).expect(200);
    db.memory.submissions.find(item => item.id === ignored.id).integrity = { decisao: 'desconsiderar', motivo: 'Cola', por: 'prof', em: Date.now() };

    const academic = await professor(request(app).get('/api/admin/student/academic')).query({ email: ALICE }).expect(200);
    const row = id => academic.body.submissions.find(item => item.id === id);
    assert.deepEqual([row(zero.id).score, row(zero.id).integrity, row(zero.id).awaitingCorrection, row(zero.id).scoreInvalid], [0, 'zero', false, false]);
    assert.deepEqual([row(pending.id).score, row(pending.id).integrity, row(pending.id).awaitingCorrection, row(pending.id).scoreInvalid], [null, null, true, false]);
    assert.deepEqual([row(ignored.id).score, row(ignored.id).integrity, row(ignored.id).scoreInvalid], [null, 'desconsiderar', false]);

    const dashboard = await professor(request(app).get('/api/admin/student/dashboard')).query({ email: ALICE, courseId, studentClass }).expect(200);
    assert.deepEqual(dashboard.body.notas.map(item => item.value), [0], 'o gráfico leva só a anulada com zero, com 0');
});

// A9, ajuste 2: a planilha por prova (GET /api/admin/export-grades/:class/:examKey)
// mostrava em "Nota da tentativa" a nota gravada (a original na anulada, a parcial das
// objetivas na que aguarda correção) e "Sim" em Publicada na que voltou a aguardar.
test('[UC-CORRECAO-001] planilha por prova: anulada e aguardando correção não mostram a nota gravada', async () => {
    const zero = deliver(ALICE, { 1: 'A', 2: { texto: 'Regras.' }, 3: { texto: 'tcp' } });
    await postCorrection(zero.id, { versao: 1, itens: { 2: { pontos: 2 } }, concluir: true }).expect(200);
    Object.assign(db.memory.submissions.find(item => item.id === zero.id), { gradePublished: true, integrity: { decisao: 'zero', motivo: 'Cola', por: 'prof', em: Date.now() } });
    // Publicada e depois reaberta (apagaram os pontos): o aluno não vê a nota.
    const pending = deliver(ALICE, { 1: 'A', 2: { texto: 'Outra.' }, 3: { texto: 'tcp' } }, { attemptNumber: 2, gradePublished: true });
    const ignored = deliver(ALICE, { 1: 'A', 2: { texto: 'Mais uma.' }, 3: { texto: 'tcp' } }, { attemptNumber: 3 });
    await postCorrection(ignored.id, { versao: 1, itens: { 2: { pontos: 2 } }, concluir: true }).expect(200);
    Object.assign(db.memory.submissions.find(item => item.id === ignored.id), { gradePublished: true, integrity: { decisao: 'desconsiderar', motivo: 'Cola', por: 'prof', em: Date.now() } });
    const done = deliver(BRUNO, { 1: 'A', 2: { texto: 'Regras.' }, 3: { texto: 'tcp' } });
    await postCorrection(done.id, { versao: 1, itens: { 2: { pontos: 1 } }, concluir: true }).expect(200);
    db.memory.submissions.find(item => item.id === done.id).gradePublished = true;
    assert.ok(pending.score > 0, 'a pendente tem a parcial das objetivas gravada');

    const res = await professor(request(app).get(`/api/admin/export-grades/${studentClass}/${examKey}`)).query({ courseId }).expect(200);
    assert.equal(res.text.charCodeAt(0), 0xFEFF);
    const [header, ...lines] = res.text.slice(1).trim().split(/\r\n/).map(line => line.split(';'));
    const col = name => header.indexOf(name);
    const byAttempt = (name, attempt) => lines.find(line => line[0] === name && line[col('Tentativa')] === String(attempt));
    const cells = line => [line[col('Nota da tentativa')], line[col('Publicada')]];
    assert.deepEqual(cells(byAttempt('Alice Souza', 1)), ['anulada (zero)', 'Sim']);
    assert.deepEqual(cells(byAttempt('Alice Souza', 2)), ['aguardando correção', 'Não (aguardando correção)']);
    assert.deepEqual(cells(byAttempt('Alice Souza', 3)), ['anulada (não conta)', 'Não (anulada, não conta)']);
    assert.deepEqual(cells(byAttempt('Bruno Lima', 1)), ['7,5', 'Sim']);
});
