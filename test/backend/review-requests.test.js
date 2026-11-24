// Pedido de revisão da nota pelo aluno e aviso de nota alterada (fase 3, P3-S5 / A19:
// AVA-07; D13 do desenho do P3, P-B2 com o padrão "até 7 dias depois da publicação, um
// aberto por prova").
//
// - POST /api/student/submissions/:id/review-request: só o dono, só com a nota publicada e
//   visível, até 7 dias depois da publicação, um aberto por vez (e no máximo 5 na mesma
//   entrega); a questão é opcional e precisa ser da prova; texto de 10 a 1 000.
// - o professor vê os pedidos na fila da tela Corrigir, na entrega e na fila "Precisa de
//   você", e responde por POST /api/admin/submissions/:id/review-requests/:id/answer;
//   notaMudou sai do histórico da nota, não da tela.
// - o sino do aluno avisa "Seu pedido de revisão foi respondido" e "Nota alterada" para
//   toda mudança da nota depois da publicação (scoreHistory), não só a do gabarito.
// - anonimizar apaga o texto do pedido e tira o nome da resposta; Meus dados do aluno
//   traz os pedidos sem a conta de quem respondeu.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-review-requests-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { createAdminSession, createStudentSession } = require('../../backend/utils/authSessions.js');
const { createSubmissionFromAttempt } = require('../../backend/utils/examGrading.js');
const { buildStudentDataExport } = require('../../backend/utils/studentDataExport.js');
const studentLifecycle = require('../../backend/utils/studentLifecycle.js');
const reviews = require('../../backend/utils/examReviewRequests.js');
const { noticeText } = require('../../backend/utils/gradeChangeNotices.js');

const ADMIN = 'adm@revisao.local';
const PROF = 'prof@revisao.local';
const OTHER_PROF = 'outro@revisao.local';
const COORD = 'coord@revisao.local';
const COURSE = 'curso-revisao';
const CLASS = '1RED';
const EXAM = 'Avaliacao_Revisao';
const APP = 'app_revisao';
const DAY = 24 * 60 * 60 * 1000;
const STUDENTS = {
    ana: { email: 'ana@revisao.local', name: 'Ana Lima' },
    bruno: { email: 'bruno@revisao.local', name: 'Bruno Costa' },
};
let app;

const QUESTIONS = [
    { originalNumber: 1, number: 1, type: 'multiple_choice', points: 1, text: 'Porta do HTTP?', correctAnswer: 'A', alternatives: [{ letter: 'A', text: '80', isCorrect: true }, { letter: 'B', text: '21', isCorrect: false }] },
    { originalNumber: 2, number: 2, type: 'multiple_choice', points: 1, text: 'Porta do SSH?', correctAnswer: 'B', alternatives: [{ letter: 'A', text: '80', isCorrect: false }, { letter: 'B', text: '22', isCorrect: true }] },
    { originalNumber: 3, number: 3, type: 'essay', points: 2, text: 'Explique o que é um protocolo.', expectedAnswer: 'Regras.' },
];

const clone = value => JSON.parse(JSON.stringify(value));

function seed() {
    db.memory.config = { ...(db.memory.config || {}), settings: {} };
    db.memory.admins = [
        { email: ADMIN, name: 'Administração', role: 'admin', password: 'x' },
        { email: PROF, name: 'Professora Paula', role: 'professor', password: 'x', assignedClasses: [{ courseId: COURSE, className: CLASS }] },
        { email: OTHER_PROF, name: 'Outro Professor', role: 'professor', password: 'x', assignedClasses: [{ courseId: COURSE, className: '2RED' }] },
        { email: COORD, name: 'Coordenação', role: 'coordenacao', password: 'x', assignedSchoolIds: ['esc_revisao'] },
    ];
    db.memory.schools = [{ id: 'esc_revisao', name: 'Escola' }];
    db.memory.courses = [{ id: COURSE, schoolId: 'esc_revisao', name: 'Redes', structure: [{ id: 'm1', name: 'Módulo 1', units: [{ key: 'u1', name: 'Prova de revisão', avaliacaoKey: EXAM }] }] }];
    db.memory.classes = [
        { name: CLASS, courseId: COURSE, status: 'active', releasedItems: {}, examHistory: {}, onlineExamConfigs: {} },
        { name: '2RED', courseId: COURSE, status: 'active', releasedItems: {}, examHistory: {}, onlineExamConfigs: {} },
    ];
    db.memory.students = Object.values(STUDENTS).map(student => ({
        name: student.name, email: student.email, status: 'Ativo', classes: [{ name: CLASS, courseId: COURSE }], studentClass: CLASS, notificationsSeenAt: 0,
    }));
    db.memory.evaluations = { [EXAM]: { key: EXAM, title: 'Prova de revisão', questions: clone(QUESTIONS) } };
    db.memory.examApplications = [{
        id: APP, examKey: EXAM, courseId: COURSE, studentClass: CLASS, status: 'finished',
        versionSnapshots: [{ version: 'A', questions: clone(QUESTIONS) }], annulledQuestions: [],
    }];
    db.memory.submissions = [];
    db.memory.auditLogs = [];
    db.memory.announcements = [];
    db.memory.studentExamState = {};
}

// Entrega pelo mesmo caminho do envio do aluno; só as duas objetivas (sem dissertativa)
// quando objectiveOnly.
function deliver(key, answers, { objectiveOnly = true, publishedDaysAgo = null } = {}) {
    const application = db.memory.examApplications[0];
    const student = STUDENTS[key];
    const submission = createSubmissionFromAttempt({
        application,
        onlineConfig: {},
        state: { studentEmail: student.email, studentClass: CLASS, courseId: COURSE, examKey: EXAM, applicationId: APP, assignedVersion: 'A', assignedQuestionNumbers: objectiveOnly ? [1, 2] : [1, 2, 3], attemptNumber: 1 },
        evaluation: db.memory.evaluations[EXAM],
        student: db.memory.students.find(item => item.email === student.email),
        answers,
        now: Date.now() - 10 * DAY,
    });
    if (publishedDaysAgo !== null) {
        submission.gradePublished = true;
        submission.gradePublishedAt = Date.now() - publishedDaysAgo * DAY;
    }
    db.memory.submissions.push(submission);
    return submission;
}

const adminAs = email => ({ 'x-admin-session': createAdminSession(db.memory, email) });
const studentAs = key => ({ 'x-session-token': createStudentSession(db.memory, STUDENTS[key].email) });
const ask = (key, id, payload) => request(app).post(`/api/student/submissions/${encodeURIComponent(id)}/review-request`).set(studentAs(key)).send(payload);
const answer = (who, id, requestId, payload) => request(app).post(`/api/admin/submissions/${encodeURIComponent(id)}/review-requests/${encodeURIComponent(requestId)}/answer`).set(adminAs(who)).send(payload);
const mine = async key => (await request(app).post('/api/student/my-submissions').set(studentAs(key)).send({ courseId: COURSE, studentClass: CLASS }).expect(200)).body.submissions;
const bell = async key => (await request(app).get(`/api/student/notifications?courseId=${COURSE}&studentClass=${CLASS}`).set(studentAs(key)).expect(200)).body.items;
const TEXT = 'Acho que a questão 2 tinha duas respostas certas.';

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

test('[UC-CORRECAO-001] aluno pede revisão da nota publicada; a auditoria guarda a questão sem o texto', async () => {
    const sub = deliver('ana', { 1: 'A', 2: 'A' }, { publishedDaysAgo: 2 });
    const before = await mine('ana');
    assert.equal(before[0].revisao.podePedir, true);
    assert.ok(Math.abs(before[0].revisao.prazoAte - (sub.gradePublishedAt + 7 * DAY)) < 5, 'prazo de 7 dias da publicação');

    const res = await ask('ana', sub.id, { questionNumber: 2, texto: `  ${TEXT}  ` });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.pedido.texto, TEXT);
    assert.equal(res.body.pedido.situacao, 'aberto');
    assert.equal(res.body.pedido.questionNumber, 2);
    assert.match(res.body.pedido.id, /^rev_\d+_[0-9a-f]{6}$/);
    assert.equal(res.body.revisao.podePedir, false);
    assert.equal(res.body.revisao.motivo, 'already_open');

    const stored = db.memory.submissions[0].pedidosRevisao;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].texto, TEXT);
    assert.equal(typeof stored[0].criadoEm, 'number');
    const audit = db.memory.auditLogs.filter(entry => entry.action === 'grade_review_requested');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].field, 'Questão 2');
    assert.equal(audit[0].studentEmail, STUDENTS.ana.email);
    assert.equal(JSON.stringify(audit[0]).includes('duas respostas'), false, 'o texto do pedido não vai para a auditoria');

    // O aluno vê o pedido dele na tela Provas, sem o motivo do bloqueio virar erro.
    const after = await mine('ana');
    assert.deepEqual(after[0].pedidosRevisao.map(item => [item.situacao, item.texto, item.questionNumber]), [['aberto', TEXT, 2]]);
    assert.equal(after[0].revisao.motivo, 'already_open');
    assert.equal(JSON.stringify(after[0]).includes('respondidoPor'), false);

    // Um aberto por vez.
    const again = await ask('ana', sub.id, { texto: 'Quero que revise a prova toda, por favor.' });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'review_already_open');
    assert.match(again.body.error, /já tem um pedido de revisão aberto/);
});

test('[UC-CORRECAO-001] recusas: nota não publicada, aguardando correção, fora do prazo, entrega de outro aluno, questão de fora e texto curto', async () => {
    const hidden = deliver('ana', { 1: 'A', 2: 'B' });
    const late = deliver('bruno', { 1: 'A', 2: 'B' }, { publishedDaysAgo: 8 });
    const pending = deliver('ana', { 1: 'A', 2: 'B', 3: { texto: 'Regras de comunicação.' } }, { objectiveOnly: false, publishedDaysAgo: 1 });
    assert.equal(pending.correcao.situacao, 'pendente');
    const snapshot = JSON.stringify(db.memory.submissions);

    const notPublished = await ask('ana', hidden.id, { texto: TEXT });
    assert.equal(notPublished.status, 409);
    assert.equal(notPublished.body.code, 'review_not_published');
    // Publicada, mas a dissertativa ainda espera o professor: o aluno não vê a nota.
    assert.equal((await ask('ana', pending.id, { texto: TEXT })).body.code, 'review_not_published');
    const tooLate = await ask('bruno', late.id, { texto: TEXT });
    assert.equal(tooLate.status, 409);
    assert.equal(tooLate.body.code, 'review_deadline_passed');
    assert.match(tooLate.body.error, /7 dias/);
    assert.equal((await mine('bruno'))[0].revisao.motivo, 'deadline_passed');

    const other = await ask('ana', late.id, { texto: TEXT });
    assert.equal(other.status, 403);
    assert.equal((await ask('ana', 'sub_que_nao_existe', { texto: TEXT })).status, 404);

    const fresh = deliver('ana', { 1: 'A', 2: 'B' }, { publishedDaysAgo: 0 });
    const shortText = await ask('ana', fresh.id, { texto: 'errado' });
    assert.equal(shortText.status, 400);
    assert.equal(shortText.body.field, 'texto');
    assert.match(shortText.body.error, /pelo menos 10 letras/);
    const outside = await ask('ana', fresh.id, { questionNumber: 3, texto: TEXT });
    assert.equal(outside.status, 400);
    assert.equal(outside.body.field, 'questionNumber');
    const tooLong = await ask('ana', fresh.id, { texto: 'x'.repeat(1001) });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.field, 'texto');

    assert.equal(JSON.stringify(db.memory.submissions.filter(item => item.id !== fresh.id)), snapshot, 'nenhuma recusa mudou a entrega');
    assert.equal(fresh.pedidosRevisao, undefined);
    assert.equal(db.memory.auditLogs.filter(entry => entry.action === 'grade_review_requested').length, 0);
});

test('[UC-CORRECAO-001] professor vê o pedido na fila e na entrega, muda a nota e responde; o aluno é avisado no sino', async () => {
    const sub = deliver('ana', { 1: 'A', 2: 'A' }, { publishedDaysAgo: 1 });
    assert.equal(sub.score, 50);
    const asked = await ask('ana', sub.id, { questionNumber: 2, texto: TEXT });
    assert.equal(asked.status, 201);
    const requestId = asked.body.pedido.id;

    // Fila da tela Corrigir: o pedido aparece mesmo sem correção pendente.
    const queue = await request(app).get(`/api/admin/corrections?courseId=${COURSE}&studentClass=${CLASS}`).set(adminAs(PROF)).expect(200);
    assert.equal(queue.body.total, 0);
    assert.deepEqual(queue.body.pedidosRevisao.map(item => [item.submissionId, item.requestId, item.questionNumber, item.aluno.name]), [[sub.id, requestId, 2, 'Ana Lima']]);
    assert.equal(JSON.stringify(queue.body.pedidosRevisao).includes('duas respostas'), false, 'a fila não traz o texto');
    // Fila "Precisa de você": um pedido leva direto à entrega.
    const dashboard = await request(app).get(`/api/admin/dashboard/queue?courseId=${COURSE}&studentClass=${CLASS}`).set(adminAs(PROF)).expect(200);
    const item = (Array.isArray(dashboard.body) ? dashboard.body : []).find(entry => entry.id === 'pedidos_de_revisao');
    assert.ok(item, JSON.stringify(dashboard.body));
    assert.equal(item.count, 1);
    assert.equal(item.href, `/resultados/correcao?submissionId=${encodeURIComponent(sub.id)}`);

    const detail = await request(app).get(`/api/admin/submissions/${sub.id}/correction`).set(adminAs(PROF)).expect(200);
    assert.deepEqual(detail.body.pedidosRevisao.map(item => [item.id, item.texto, item.situacao]), [[requestId, TEXT, 'aberto']]);

    // Outro professor não alcança a entrega; a Coordenação vê e não responde.
    assert.equal((await answer(OTHER_PROF, sub.id, requestId, { resposta: 'Ok.' })).status, 404);
    assert.equal((await request(app).get(`/api/admin/submissions/${sub.id}/correction`).set(adminAs(COORD))).status, 200);
    assert.equal((await answer(COORD, sub.id, requestId, { resposta: 'Ok.' })).status, 403);
    assert.equal((await answer(PROF, sub.id, requestId, { resposta: '   ' })).status, 400);
    assert.equal((await answer(PROF, sub.id, 'rev_1_abcdef', { resposta: 'Ok.' })).status, 404);

    // A mudança da nota vem pela correção (nota publicada: com motivo).
    const changed = await request(app).post(`/api/admin/submissions/${sub.id}/correction`).set(adminAs(PROF))
        .send({ versao: detail.body.versao, itens: { 2: { pontos: 1, motivo: 'A alternativa A também vale.' } }, motivo: 'Pedido de revisão aceito.' });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.score, 100);
    assert.equal(changed.body.pedidosRevisao.length, 1, 'a entrega gravada continua com o pedido');

    const answered = await answer(PROF, sub.id, requestId, { resposta: 'Você tem razão: a alternativa A também vale. Sua nota subiu.' });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.equal(answered.body.pedido.situacao, 'respondido');
    assert.equal(answered.body.pedido.notaMudou, true);
    assert.equal(answered.body.pedido.respondidoPor, PROF);
    const audit = db.memory.auditLogs.filter(entry => entry.action === 'grade_review_answered');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].details.notaMudou, true);
    assert.equal(JSON.stringify(audit[0]).includes('Sua nota subiu'), false, 'a resposta não vai para a auditoria');
    assert.equal((await answer(PROF, sub.id, requestId, { resposta: 'De novo.' })).body.code, 'review_already_answered');

    // O aluno vê a resposta (sem quem respondeu) e pode pedir de novo, dentro do prazo.
    const view = (await mine('ana'))[0];
    assert.equal(view.pedidosRevisao[0].resposta, 'Você tem razão: a alternativa A também vale. Sua nota subiu.');
    assert.equal(view.pedidosRevisao[0].notaMudou, true);
    assert.equal(JSON.stringify(view).includes(PROF), false);
    assert.equal(view.revisao.podePedir, true);

    const items = await bell('ana');
    const answeredItem = items.find(entry => entry.title === 'Seu pedido de revisão foi respondido');
    assert.ok(answeredItem, JSON.stringify(items));
    assert.equal(answeredItem.text, 'Prova de revisão: a sua nota mudou. Veja a resposta do professor.');
    assert.equal(answeredItem.href, `/aluno/provas?entrega=${encodeURIComponent(sub.id)}`);
    assert.equal(answeredItem.unread, true);
    assert.deepEqual(items.filter(entry => entry.title === 'Nota alterada').map(entry => entry.text), ['Prova de revisão: O professor revisou a correção e a sua nota mudou.']);
    // Sem fila depois da resposta.
    const after = await request(app).get(`/api/admin/corrections?courseId=${COURSE}&studentClass=${CLASS}`).set(adminAs(PROF)).expect(200);
    assert.deepEqual(after.body.pedidosRevisao, []);
});

test('[UC-CORRECAO-001] resposta sem mudar a nota: "a nota foi mantida"; o limite de pedidos na mesma entrega', async () => {
    const sub = deliver('bruno', { 1: 'A', 2: 'B' }, { publishedDaysAgo: 3 });
    for (let index = 0; index < reviews.MAX_REQUESTS_PER_SUBMISSION; index += 1) {
        const asked = await ask('bruno', sub.id, { texto: `Pedido número ${index + 1} sobre a prova.` });
        assert.equal(asked.status, 201, JSON.stringify(asked.body));
        const answered = await answer(PROF, sub.id, asked.body.pedido.id, { resposta: 'A nota está certa.' });
        assert.equal(answered.body.pedido.notaMudou, false);
    }
    const limit = await ask('bruno', sub.id, { texto: 'Mais um pedido sobre a prova.' });
    assert.equal(limit.status, 409);
    assert.equal(limit.body.code, 'review_limit');
    const items = (await bell('bruno')).filter(entry => entry.title === 'Seu pedido de revisão foi respondido');
    assert.equal(items.length, reviews.MAX_REQUESTS_PER_SUBMISSION);
    assert.ok(items.every(entry => entry.text === 'Prova de revisão: a nota foi mantida. Veja a resposta do professor.'));
    assert.equal((await bell('bruno')).some(entry => entry.title === 'Nota alterada'), false);
});

test('"Nota alterada": só mudança depois da publicação e com a nota à vista; publicar de novo não muda a hora', async () => {
    const publishedAt = Date.parse('2026-11-10T12:00:00Z');
    assert.equal(noticeText({ at: '2026-11-10T11:00:00Z', from: 50, to: 100 }, publishedAt), '', 'antes da publicação');
    assert.equal(noticeText({ at: '2026-11-10T13:00:00Z', from: 50, to: 50 }, publishedAt), '', 'só os acertos mudaram');
    assert.equal(noticeText({ at: '2026-11-10T13:00:00Z', from: 50, to: 100 }, 0), '', 'sem a hora da publicação');
    assert.match(noticeText({ at: '2026-11-10T13:00:00Z', from: 50, to: 100 }, publishedAt), /revisou a correção/);
    assert.match(noticeText({ at: '2026-11-10T11:00:00Z', from: 50, to: 100, avisoAluno: { tipo: 'gabarito_corrigido', numeroNaProva: 2 } }, publishedAt), /gabarito da questão 2/);

    // Publicar pela rota, mudar a nota depois e publicar de novo.
    const sub = deliver('ana', { 1: 'A', 2: 'A' });
    const publish = () => request(app).post('/api/admin/submissions/publish').set(adminAs(PROF)).send({ ids: [sub.id], published: true }).expect(200);
    await publish();
    const firstAt = sub.gradePublishedAt;
    assert.ok(firstAt > 0);
    sub.scoreHistory = [{ at: new Date(firstAt + 1000).toISOString(), from: 50, to: 100, reason: 'troca de questão', by: PROF }];
    sub.score = 100;
    await new Promise(resolve => setTimeout(resolve, 5));
    await publish();
    assert.equal(sub.gradePublishedAt, firstAt, 'a nota já publicada mantém a hora da publicação');
    assert.deepEqual((await bell('ana')).filter(entry => entry.title === 'Nota alterada').map(entry => entry.text), ['Prova de revisão: O professor revisou a correção e a sua nota mudou.']);
    // Voltou a aguardar a correção: o aluno não vê a nota, nem o aviso.
    sub.correcao = { situacao: 'pendente', versao: 3, itens: {} };
    assert.equal((await bell('ana')).some(entry => entry.title === 'Nota alterada'), false);
});

test('anonimizar apaga o texto do pedido e o nome da resposta; Meus dados traz os pedidos', async () => {
    const sub = deliver('ana', { 1: 'A', 2: 'A' }, { publishedDaysAgo: 1 });
    const asked = await ask('ana', sub.id, { texto: 'Professora, eu, Ana Lima, acho que errou a 2.' });
    await answer(PROF, sub.id, asked.body.pedido.id, { resposta: 'Ana Lima, a nota está certa.' }).expect(200);

    const forStudent = buildStudentDataExport(db.memory, STUDENTS.ana.email, { audience: 'aluno' });
    const studentView = forStudent.submissions.find(item => item.id === sub.id);
    assert.deepEqual(studentView.pedidosRevisao.map(item => [item.texto, item.resposta, item.situacao]), [['Professora, eu, Ana Lima, acho que errou a 2.', 'Ana Lima, a nota está certa.', 'respondido']]);
    assert.equal(JSON.stringify(studentView).includes(PROF), false, 'o aluno não vê quem respondeu');
    const forAdmin = buildStudentDataExport(db.memory, STUDENTS.ana.email, { audience: 'admin' });
    assert.equal(forAdmin.submissions.find(item => item.id === sub.id).pedidosRevisao[0].respondidoPor, PROF);

    db.memory.students.find(item => item.email === STUDENTS.ana.email).status = 'Inativo';
    await studentLifecycle.runStudentLifecycle(db, { mode: 'anonymize', email: STUDENTS.ana.email, actor: ADMIN, reason: 'Pedido da família' });
    const anonymized = db.memory.submissions.find(item => item.id === sub.id);
    assert.equal(anonymized.pedidosRevisao[0].texto, '');
    assert.equal(anonymized.pedidosRevisao[0].studentAnonymized, true);
    assert.equal(anonymized.pedidosRevisao[0].resposta.includes('Ana'), false, anonymized.pedidosRevisao[0].resposta);
    assert.equal(anonymized.pedidosRevisao[0].situacao, 'respondido');
});

test('elegibilidade: registro antigo sem gradePublishedAt conta da hora da entrega; tentativa arquivada não pede', () => {
    const now = Date.now();
    const base = { gradePublished: true, score: 70, gradedAnswers: [{ questionNumber: 1 }] };
    assert.equal(reviews.reviewEligibility({ ...base, timestamp: new Date(now - DAY).toISOString() }, { now }).podePedir, true);
    assert.equal(reviews.reviewEligibility({ ...base, timestamp: new Date(now - 8 * DAY).toISOString() }, { now }).motivo, 'deadline_passed');
    assert.equal(reviews.reviewEligibility({ ...base, gradePublishedAt: now, resultStatus: 'archived' }, { now }).motivo, 'archived');
    assert.equal(reviews.reviewEligibility({ ...base, gradePublishedAt: now, integrity: { decisao: 'desconsiderar' } }, { now }).motivo, 'not_published');
    assert.equal(reviews.reviewEligibility({ ...base, gradePublishedAt: now, score: '' }, { now }).motivo, 'not_published');
    // Entrega antiga sem nenhum pedido: o aluno lê a lista vazia (sem o campo).
    assert.deepEqual(reviews.reviewRequestsForStudent({}), []);
});
