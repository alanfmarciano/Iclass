// Nota da tarefa no quadro de notas e na média (fase 3, C18 / P1-j; FUN-01, D15 do P1, K1
// do plano e P-ALAN-3). A tarefa publicada vira item do plano da turma pelo provedor
// 'tarefa' do gradebook (contrato C2 do P2): coluna 'Tarefa: <título>' no quadro logo
// depois das provas do módulo dela, a nota devolvida entra na média (peso 1, desmarcável
// em "Conta na média"), o aluno a vê em Minhas notas e no Início. Uma fonte só: a nota
// mora em assignmentSubmissions.grade (lida por assignmentGradeEntries) e nada vai para
// submissions. Cada caso falha no código de antes (não havia provedor registrado: o quadro
// não tinha coluna de tarefa e a média não a contava).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-assignments-gradebook-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const gradebook = require('../../backend/utils/gradebook.js');
const assignments = require('../../backend/utils/assignments.js');
const assignmentGrades = require('../../backend/utils/assignmentGrades.js');
const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { createStudentSession } = require('../../backend/utils/authSessions.js');

const COURSE = 'TI';
const HOUR = 60 * 60 * 1000;
const tokens = { admin: 'tok-tarefa-nota-admin', prof: 'tok-tarefa-nota-prof' };
let app;
const as = (who, method, url) => request(app)[method](url).set('x-admin-session', tokens[who]);
const asStudent = (email, url) => request(app).get(url).set('x-session-token', createStudentSession(db.memory, email));

let subSeq = 0;
function examSub(email, examKey, score) {
    subSeq += 1;
    return {
        id: `sub_tarefa_nota_${subSeq}`,
        student: { name: email.split('@')[0], email, studentClass: '1DES', courseId: COURSE },
        examKey,
        score,
        type: 'impressa',
        entryMode: 'quick',
        attemptNumber: 1,
        resultStatus: 'considered',
        aggregationPolicy: 'highest',
        selectedForResult: false,
        gradePublished: true,
        timestamp: '2026-03-10T12:00:00.000Z',
    };
}

function task(fields) {
    const record = assignments.newAssignmentRecord({ courseId: COURSE, studentClass: '1DES', response: { files: false, text: true, link: false }, dueAt: Date.now() - 24 * HOUR, closeAt: null, status: 'publicada', ...fields }, { actor: 'prof@tarefa-nota.local', now: Date.now() - 72 * HOUR });
    db.memory.assignments.push(record);
    return record;
}

// Entrega corrigida (score de 0 a 100); returned: devolvida ao aluno.
function graded(taskRecord, email, score, { returned = true, returnedAt = Date.now() - HOUR } = {}) {
    const student = db.memory.students.find(item => item.email === email);
    const sub = assignments.newSubmissionRecord(taskRecord, student, { now: Date.now() - 48 * HOUR });
    sub.versions = [{ n: 1, requestAt: Date.now() - 30 * HOUR, receivedAt: Date.now() - 30 * HOUR, late: false, lateMs: 0, text: 'Resposta', link: '', files: [], ip: '10.0.0.2', device: 'Celular' }];
    sub.grade = { score, penaltyPct: 0, finalScore: score, comment: '', versionGraded: 1, gradedBy: 'prof@tarefa-nota.local', gradedAt: Date.now() - 2 * HOUR, penaltyWaived: false };
    sub.status = returned ? 'devolvida' : 'corrigida';
    sub.returnedAt = returned ? returnedAt : null;
    sub.returnedBy = returned ? 'prof@tarefa-nota.local' : '';
    db.memory.assignmentSubmissions.push(sub);
    return sub;
}

function seed() {
    db.memory.courses = [{
        id: COURSE,
        name: 'Informática',
        structure: [
            { id: 'M1', name: 'Redes', units: [{ key: 'u1', name: 'Prova 1', avaliacaoKey: 'Av_P1' }] },
            { id: 'M2', name: 'Banco de Dados', units: [{ key: 'u2', name: 'Prova 2', avaliacaoKey: 'Av_P2' }] },
        ],
        disciplinas: [],
    }];
    db.memory.classes = [{ name: '1DES', courseId: COURSE, period: 'Manhã' }];
    db.memory.evaluations = { Av_P1: { title: 'Prova 1', questions: [] }, Av_P2: { title: 'Prova 2', questions: [] } };
    db.memory.examApplications = [];
    db.memory.attendance = [];
    db.memory.academicTerms = [];
    db.memory.admins = [
        { email: 'admin@tarefa-nota.local', name: 'Admin', role: 'admin', password: db.hashPassword('senha-admin-ok') },
        { email: 'prof@tarefa-nota.local', name: 'Prof', role: 'professor', password: db.hashPassword('senha-prof-ok'), assignedClasses: [{ courseId: COURSE, className: '1DES' }] },
    ];
    const now = Date.now();
    db.memory.adminSessions = {
        [tokens.admin]: { email: 'admin@tarefa-nota.local', createdAt: now, lastSeen: now },
        [tokens.prof]: { email: 'prof@tarefa-nota.local', createdAt: now, lastSeen: now },
    };
    db.memory.students = [
        { id: 'alu_00000000000a0a0a', name: 'Ana', email: 'ana@tarefa-nota.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: COURSE }], studentClass: '1DES' },
        { id: 'alu_00000000000b0b0b', name: 'Bia', email: 'bia@tarefa-nota.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: COURSE }], studentClass: '1DES' },
    ];
    // Ana: 4,0 na P1 e 8,0 na P2 (média simples 6,0 sem tarefa).
    db.memory.submissions = [examSub('ana@tarefa-nota.local', 'Av_P1', 40), examSub('ana@tarefa-nota.local', 'Av_P2', 80), examSub('bia@tarefa-nota.local', 'Av_P1', 70)];
    db.memory.assignments = [];
    db.memory.assignmentSubmissions = [];
    db.memory.auditLogs = [];
    db.memory.studentSessions = {};
}

test.before(async () => { await db.init(); app = createApp(); });
test.beforeEach(() => seed());
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1000));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function gradebookOf(who = 'prof') {
    const res = await as(who, 'get', `/api/admin/gradebook?courseId=${COURSE}&studentClass=1DES`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
}

const rowOf = (gb, email) => gb.rows.find(row => row.email === email);
const keyOf = column => column.examKey || column.id;
const summaryOf = async email => {
    const res = await asStudent(email, `/api/student/grades-summary?courseId=${COURSE}&studentClass=1DES`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
};

test('[UC-TAREFAS-001] o provedor \'tarefa\' fica registrado ao carregar o servidor', () => {
    assert.deepEqual(gradebook.gradeItemProviderList().map(provider => provider.origem), ['tarefa']);
    // Registrar de novo não duplica.
    assignmentGrades.registerAssignmentGradeProvider();
    assert.deepEqual(gradebook.gradeItemProviderList().map(provider => provider.origem), ['tarefa']);
});

test('[UC-TAREFAS-001] quadro: coluna "Tarefa: título" depois das provas do módulo, a nota devolvida entra na média e a não devolvida aparece só para o professor', async () => {
    const before = await gradebookOf();
    const relatorio = task({ title: 'Relatório de Redes', moduleId: 'M1' });
    const pesquisa = task({ title: 'Pesquisa livre' });
    task({ title: 'Rascunho', status: 'rascunho' });
    graded(relatorio, 'ana@tarefa-nota.local', 100);
    graded(pesquisa, 'bia@tarefa-nota.local', 90, { returned: false });

    const gb = await gradebookOf();
    assert.deepEqual(gb.columns.map(keyOf), ['Av_P1', relatorio.id, 'Av_P2', pesquisa.id], 'tarefa do módulo logo depois da prova dele; sem módulo, no fim; rascunho não entra');
    const column = gb.columns.find(item => keyOf(item) === relatorio.id);
    assert.equal(column.label, 'Tarefa: Relatório de Redes');
    assert.equal(column.origem, 'tarefa');
    const ana = rowOf(gb, 'ana@tarefa-nota.local');
    assert.equal(rowOf(before, 'ana@tarefa-nota.local').average, 6, 'antes: (4 + 8) / 2');
    assert.equal(ana.average, 7.3, '(4 + 8 + 10) / 3');
    // A correção salva e ainda não devolvida: o professor vê, a média do quadro a conta
    // como a nota de prova não publicada, e o aluno não vê.
    const bia = rowOf(gb, 'bia@tarefa-nota.local');
    assert.equal(bia.average, 8, '(7 + 9) / 2');
    const biaSummary = await summaryOf('bia@tarefa-nota.local');
    const biaItem = biaSummary.itens.find(item => item.id === pesquisa.id);
    assert.ok(!biaItem || biaItem.nota === null, JSON.stringify(biaItem));
    assert.equal(biaSummary.mediaFinal, 7, 'o aluno só conta o devolvido');
    // Nada foi para submissions (que é de prova).
    assert.equal(db.memory.submissions.length, 3);
});

test('[UC-TAREFAS-001] sem tarefa (ou só rascunho), o quadro, o boletim e o resumo do aluno ficam iguais aos de antes', async () => {
    const strip = value => JSON.parse(JSON.stringify(value, (key, item) => (key === 'generatedAt' ? undefined : item)));
    const empty = strip(await gradebookOf());
    const emptySummary = strip(await summaryOf('ana@tarefa-nota.local'));
    const emptyReport = await as('admin', 'get', `/api/admin/student/report?email=ana@tarefa-nota.local&courseId=${COURSE}&studentClass=1DES`);
    task({ title: 'Rascunho', status: 'rascunho' });
    assert.deepEqual(strip(await gradebookOf()), empty);
    assert.deepEqual(strip(await summaryOf('ana@tarefa-nota.local')), emptySummary);
    const report = await as('admin', 'get', `/api/admin/student/report?email=ana@tarefa-nota.local&courseId=${COURSE}&studentClass=1DES`);
    assert.deepEqual(strip(report.body), strip(emptyReport.body));
});

test('[UC-TAREFAS-002] "Conta na média" desmarcado: a nota aparece no quadro e em Minhas notas, mas fora da média', async () => {
    const extra = task({ title: 'Exercício extra', moduleId: 'M2', countsInAverage: false });
    graded(extra, 'ana@tarefa-nota.local', 20);
    const gb = await gradebookOf();
    const column = gb.columns.find(item => keyOf(item) === extra.id);
    assert.equal(column.label, 'Tarefa: Exercício extra');
    assert.equal(column.foraDaMedia, true);
    assert.equal(rowOf(gb, 'ana@tarefa-nota.local').average, 6, 'a nota 2,0 não entra');
    const summary = await summaryOf('ana@tarefa-nota.local');
    const item = summary.itens.find(entry => entry.id === extra.id);
    assert.equal(item.nota, 2);
    assert.equal(item.origem, 'tarefa');
    assert.equal(item.foraDaMedia, true);
    assert.equal(summary.mediaFinal, 6);
});

test('[UC-TAREFAS-002] tarefa arquivada: a nota fica guardada na coluna do professor, sai da média com aviso e some para o aluno', async () => {
    const velha = task({ title: 'Tarefa velha', moduleId: 'M1' });
    graded(velha, 'ana@tarefa-nota.local', 0);
    assert.equal(rowOf(await gradebookOf(), 'ana@tarefa-nota.local').average, 4, '(4 + 8 + 0) / 3');
    // Rodada 1: a nota devolvida sai da média, então arquivar pede o motivo (como a avaliação
    // manual arquivada).
    const noReason = await as('prof', 'post', `/api/admin/assignments/${velha.id}/archive`).send({});
    assert.equal(noReason.status, 400, JSON.stringify(noReason.body));
    assert.equal(noReason.body.code, 'reason_required');
    const archived = await as('prof', 'post', `/api/admin/assignments/${velha.id}/archive`).send({ reason: 'Tarefa substituída' });
    assert.equal(archived.status, 200, JSON.stringify(archived.body));
    assert.equal(db.memory.auditLogs.filter(entry => entry.action === 'assignment_archived').pop().reason, 'Tarefa substituída');
    const gb = await gradebookOf();
    const column = gb.columns.find(item => keyOf(item) === velha.id);
    assert.ok(column, 'a coluna continua no quadro do professor');
    assert.equal(column.arquivado, true);
    assert.equal(rowOf(gb, 'ana@tarefa-nota.local').average, 6, 'a nota da arquivada sai da média');
    const summary = await summaryOf('ana@tarefa-nota.local');
    assert.equal(summary.itens.some(entry => entry.id === velha.id), false);
    assert.equal(summary.mediaFinal, 6);
    const report = await as('admin', 'get', `/api/admin/student/report?email=ana@tarefa-nota.local&courseId=${COURSE}&studentClass=1DES`);
    assert.ok(report.body.avisosNotas.some(text => /arquivada/.test(text)), JSON.stringify(report.body.avisosNotas));
    // A tarefa arquivada que nunca foi publicada (rascunho arquivado) não vira coluna.
    const nunca = task({ title: 'Nunca publicada', status: 'rascunho' });
    nunca.status = 'arquivada';
    assert.equal((await gradebookOf()).columns.some(item => keyOf(item) === nunca.id), false);
});

test('[UC-TAREFAS-002] com critérios: a tarefa é item do plano (peso 1 por padrão), o plano escolhe etapa e peso, e "Conta na média" no formulário acompanha a linha do plano', async () => {
    const criteria = await as('admin', 'post', '/api/admin/grading/criteria').send({
        courseId: COURSE, ativo: true, mediaMinima: 6, frequenciaMinima: 75,
        etapas: [{ ordem: 1, nome: '1º bimestre', peso: 1 }, { ordem: 2, nome: '2º bimestre', peso: 1 }],
        recuperacao: { etapa: 'nenhuma', final: 'substitui_se_maior' },
        mencoes: [{ sigla: 'A', nome: 'Apto', min: 6 }, { sigla: 'I', nome: 'Insuficiente', min: 0 }],
        unidadeSituacao: 'turma', reason: 'Critérios do curso',
    });
    assert.equal(criteria.status, 200, JSON.stringify(criteria.body));
    const relatorio = task({ title: 'Relatório', moduleId: 'M1' });
    graded(relatorio, 'ana@tarefa-nota.local', 100);
    const plan = await as('prof', 'get', `/api/admin/grading/plan?courseId=${COURSE}&studentClass=1DES`);
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    assert.ok(JSON.stringify(plan.body).includes(relatorio.id), 'a tarefa aparece no plano da turma');
    // 1º bimestre: P1 (4,0) e a tarefa (10,0) com peso 1 cada; 2º: P2 (8,0).
    const saved = await as('prof', 'post', '/api/admin/grading/plan').send({ courseId: COURSE, studentClass: '1DES', itens: { Av_P1: { etapa: 1 }, Av_P2: { etapa: 2 }, [relatorio.id]: { etapa: 1 } }, reason: 'Plano do semestre' });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    let ana = rowOf(await gradebookOf(), 'ana@tarefa-nota.local');
    assert.deepEqual(ana.etapas.map(etapa => etapa.media), [7, 8]);
    assert.equal(ana.mediaFinal, 7.5);

    // Desmarcar "Conta na média" no formulário tira a linha do plano da média. Com a nota
    // já devolvida, pede o motivo, como o plano em Resultados (rodada 1; antes passava sem).
    const noReason = await as('prof', 'post', `/api/admin/assignments/${relatorio.id}/update`).send({ countsInAverage: false });
    assert.equal(noReason.status, 400, JSON.stringify(noReason.body));
    assert.equal(noReason.body.code, 'reason_required');
    assert.equal(noReason.body.field, 'reason');
    assert.equal(db.memory.classes[0].avaliacao.itens[relatorio.id].fora, false, 'nada mudou sem o motivo');
    const off = await as('prof', 'post', `/api/admin/assignments/${relatorio.id}/update`).send({ countsInAverage: false, reason: 'Tarefa de revisão' });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.assignment.countsInAverage, false);
    assert.equal(db.memory.classes[0].avaliacao.itens[relatorio.id].fora, true);
    assert.equal(db.memory.classes[0].avaliacao.itens[relatorio.id].etapa, 1, 'a etapa fica');
    ana = rowOf(await gradebookOf(), 'ana@tarefa-nota.local');
    assert.deepEqual(ana.etapas.map(etapa => etapa.media), [4, 8]);
    const audit = db.memory.auditLogs.filter(entry => entry.action === 'assignment_updated').pop();
    assert.deepEqual(audit.before, { countsInAverage: true });
    assert.deepEqual(audit.after, { countsInAverage: false });
    assert.equal(audit.details.planoDaTurma, true);
    assert.equal(audit.reason, 'Tarefa de revisão');

    // Pôr de volta pelo plano (Resultados): a tela da tarefa mostra o que vale.
    const back = await as('prof', 'post', '/api/admin/grading/plan').send({ courseId: COURSE, studentClass: '1DES', itens: { [relatorio.id]: { fora: false } }, reason: 'Volta para a média' });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    const shown = await as('prof', 'get', `/api/admin/assignments/${relatorio.id}`);
    assert.equal(shown.status, 200, JSON.stringify(shown.body));
    const shownTask = shown.body.assignment || shown.body;
    assert.equal(shownTask.countsInAverage, true, 'a linha do plano manda');
    assert.equal(rowOf(await gradebookOf(), 'ana@tarefa-nota.local').mediaFinal, 7.5);
    // Mandar o mesmo valor que já vale não muda nada.
    const same = await as('prof', 'post', `/api/admin/assignments/${relatorio.id}/update`).send({ countsInAverage: true });
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.equal(same.body.changed, false);
});

test('[UC-TAREFAS-002] mudar "Conta na média" da tarefa passa pelo portão da turma encerrada (muda a média da turma); mudar só o título não', async () => {
    // O portão (assertClassOpen) ainda está sem efeito até o B10 ligar o encerramento da
    // turma; aqui ele é trocado por um que recusa a turma marcada como encerrada.
    const calendar = require('../../backend/utils/academicCalendar.js');
    const relatorio = task({ title: 'Relatório', moduleId: 'M1' });
    graded(relatorio, 'ana@tarefa-nota.local', 100);
    db.memory.classes[0].status = 'encerrada';
    const original = calendar.assertClassOpen;
    const calls = [];
    calendar.assertClassOpen = (target, { res } = {}) => {
        calls.push(target);
        if (target && target.status === 'encerrada') { res.status(409).json({ success: false, code: 'class_closed', error: 'Turma encerrada.' }); return false; }
        return true;
    };
    try {
        const res = await as('admin', 'post', `/api/admin/assignments/${relatorio.id}/update`).send({ countsInAverage: false });
        assert.equal(res.status, 409, JSON.stringify(res.body));
        assert.equal(res.body.code, 'class_closed');
        assert.equal(calls.length, 1);
        assert.equal(calls[0], db.memory.classes[0], 'a turma da tarefa');
        assert.equal(db.memory.assignments.find(item => item.id === relatorio.id).countsInAverage, true, 'nada mudou');
        const title = await as('admin', 'post', `/api/admin/assignments/${relatorio.id}/update`).send({ title: 'Relatório final' });
        assert.equal(title.status, 200, JSON.stringify(title.body));
        assert.equal(calls.length, 1, 'mudar o título não passa pelo portão');
    } finally {
        calendar.assertClassOpen = original;
    }
});

test('[UC-TAREFAS-003] aluno: Minhas notas e o Início mostram a nota devolvida da tarefa (com o desconto de atraso), não a salva sem devolver', async () => {
    const relatorio = task({ title: 'Relatório de Redes', moduleId: 'M1' });
    const sub = graded(relatorio, 'ana@tarefa-nota.local', 90);
    sub.grade.penaltyPct = 10;
    sub.grade.finalScore = 81;
    const pendente = task({ title: 'Ainda corrigindo' });
    graded(pendente, 'ana@tarefa-nota.local', 50, { returned: false });
    const summary = await summaryOf('ana@tarefa-nota.local');
    const item = summary.itens.find(entry => entry.id === relatorio.id);
    assert.equal(item.nota, 8.1, 'a nota final, já com o desconto');
    assert.equal(item.titulo, 'Relatório de Redes');
    assert.equal(item.origem, 'tarefa');
    assert.equal(item.tipo, 'Tarefa', 'Minhas notas mostra "· Tarefa" ao lado do título');
    const hidden = summary.itens.find(entry => entry.id === pendente.id);
    assert.ok(!hidden || hidden.nota === null, JSON.stringify(hidden));
    assert.equal(summary.mediaFinal, 6.7, '(4 + 8 + 8,1) / 3');

    const dashboard = await asStudent('ana@tarefa-nota.local', `/api/student/dashboard?courseId=${COURSE}&studentClass=1DES`);
    assert.equal(dashboard.status, 200, JSON.stringify(dashboard.body));
    const text = JSON.stringify(dashboard.body);
    assert.ok(text.includes('Tarefa: Relatório de Redes'), 'a nota devolvida aparece no desempenho do Início');
    assert.equal(text.includes('Ainda corrigindo'), false, 'a não devolvida não aparece');
    const performance = JSON.stringify(dashboard.body.performance || dashboard.body);
    assert.ok(/"note":8\.1/.test(performance), performance);
});

// --- Rodada 1 do C18 (revisão): arquivar, reativar e publicar de novo mudam a média ------
// A tarefa arquivada sai da média (como a avaliação manual arquivada). Então arquivar,
// reativar e publicar de novo o rascunho que já foi publicado passam pelo portão da turma
// encerrada (409 class_closed) e, com nota devolvida que conta na média, pedem motivo
// (como manual-items/archive|restore e o "Não conta" do plano em Resultados). Antes da
// rodada 1, /archive e /unarchive davam 200 numa turma encerrada e sem motivo.
function withClosedGate(fn) {
    const calendar = require('../../backend/utils/academicCalendar.js');
    const original = calendar.assertClassOpen;
    const calls = [];
    calendar.assertClassOpen = (target, { res } = {}) => {
        calls.push(target);
        if (target && target.status === 'encerrada') {
            if (res) res.status(409).json({ success: false, code: 'class_closed', error: 'Turma encerrada.' });
            return false;
        }
        return true;
    };
    return Promise.resolve().then(() => fn(calls)).finally(() => { calendar.assertClassOpen = original; });
}

test('[UC-TAREFAS-002] arquivar e reativar a tarefa publicada passam pelo portão da turma encerrada e pedem motivo com nota devolvida na média', async () => {
    const relatorio = task({ title: 'Relatório', moduleId: 'M1' });
    graded(relatorio, 'ana@tarefa-nota.local', 100);
    const base = `/api/admin/assignments/${relatorio.id}`;
    assert.equal(rowOf(await gradebookOf(), 'ana@tarefa-nota.local').average, 7.3);
    const shown = await as('prof', 'get', base);
    assert.equal(shown.body.assignment.averageReasonRequired, true, 'a tela já sabe que pede motivo');

    await withClosedGate(async (calls) => {
        db.memory.classes[0].status = 'encerrada';
        const closed = await as('admin', 'post', `${base}/archive`).send({ reason: 'Limpeza' });
        assert.equal(closed.status, 409, JSON.stringify(closed.body));
        assert.equal(closed.body.code, 'class_closed');
        assert.equal(calls[calls.length - 1], db.memory.classes[0], 'a turma da tarefa');
        assert.equal(db.memory.assignments.find(item => item.id === relatorio.id).status, 'publicada', 'nada mudou');
        assert.equal(rowOf(await gradebookOf(), 'ana@tarefa-nota.local').average, 7.3, 'a média da turma encerrada fica');

        db.memory.classes[0].status = undefined;
        const noReason = await as('prof', 'post', `${base}/archive`).send({});
        assert.equal(noReason.status, 400, JSON.stringify(noReason.body));
        assert.equal(noReason.body.code, 'reason_required');
        assert.match(noReason.body.error, /sai da média/);
        const shortReason = await as('prof', 'post', `${base}/archive`).send({ reason: 'ok' });
        assert.equal(shortReason.status, 400, 'motivo de 3 a 500 caracteres');
        const archived = await as('prof', 'post', `${base}/archive`).send({ reason: 'Tarefa refeita em sala' });
        assert.equal(archived.status, 200, JSON.stringify(archived.body));
        assert.equal(rowOf(await gradebookOf(), 'ana@tarefa-nota.local').average, 6);
        const archiveAudit = db.memory.auditLogs.filter(entry => entry.action === 'assignment_archived').pop();
        assert.equal(archiveAudit.reason, 'Tarefa refeita em sala');
        assert.equal(archiveAudit.details.notasDevolvidas, 1);

        db.memory.classes[0].status = 'encerrada';
        const closedBack = await as('admin', 'post', `${base}/unarchive`).send({ reason: 'Volta' });
        assert.equal(closedBack.status, 409, JSON.stringify(closedBack.body));
        assert.equal(db.memory.assignments.find(item => item.id === relatorio.id).status, 'arquivada');

        db.memory.classes[0].status = undefined;
        const backNoReason = await as('prof', 'post', `${base}/unarchive`).send({});
        assert.equal(backNoReason.status, 400, JSON.stringify(backNoReason.body));
        assert.match(backNoReason.body.error, /volta para a média/);
        const back = await as('prof', 'post', `${base}/unarchive`).send({ reason: 'Arquivada por engano' });
        assert.equal(back.status, 200, JSON.stringify(back.body));
        assert.equal(back.body.assignment.status, 'publicada');
        assert.equal(rowOf(await gradebookOf(), 'ana@tarefa-nota.local').average, 7.3);
        assert.equal(db.memory.auditLogs.filter(entry => entry.action === 'assignment_unarchived').pop().reason, 'Arquivada por engano');
    });
});

test('[UC-TAREFAS-002] arquivar sem mudar a média não pede motivo: tarefa fora da média, nota só salva ou rascunho (este nem passa pelo portão)', async () => {
    const extra = task({ title: 'Exercício extra', countsInAverage: false });
    graded(extra, 'ana@tarefa-nota.local', 30);
    const salva = task({ title: 'Ainda corrigindo' });
    graded(salva, 'ana@tarefa-nota.local', 50, { returned: false });
    const rascunho = task({ title: 'Rascunho', status: 'rascunho' });
    await withClosedGate(async (calls) => {
        const a = await as('prof', 'post', `/api/admin/assignments/${extra.id}/archive`).send({});
        assert.equal(a.status, 200, JSON.stringify(a.body));
        const b = await as('prof', 'post', `/api/admin/assignments/${salva.id}/archive`).send({});
        assert.equal(b.status, 200, JSON.stringify(b.body));
        const before = calls.length;
        db.memory.classes[0].status = 'encerrada';
        const c = await as('prof', 'post', `/api/admin/assignments/${rascunho.id}/archive`).send({});
        assert.equal(c.status, 200, 'rascunho não é item do quadro');
        assert.equal(calls.length, before, 'rascunho não passa pelo portão');
        const d = await as('prof', 'post', `/api/admin/assignments/${rascunho.id}/unarchive`).send({});
        assert.equal(d.status, 200, JSON.stringify(d.body));
        assert.equal(d.body.assignment.status, 'rascunho');
        assert.equal(calls.length, before, 'volta como rascunho: não passa pelo portão');
    });
});

test('[UC-TAREFAS-002] publicar de novo o rascunho que já foi publicado (com nota devolvida) passa pelo portão e pede motivo', async () => {
    const relatorio = task({ title: 'Relatório', moduleId: 'M1' });
    graded(relatorio, 'ana@tarefa-nota.local', 100);
    // Reativada como rascunho (o caminho do /unarchive quando a tarefa não pode voltar
    // publicada): publishedAt fica.
    relatorio.status = 'rascunho';
    assert.equal(rowOf(await gradebookOf(), 'ana@tarefa-nota.local').average, 6, 'rascunho fora do quadro');
    await withClosedGate(async () => {
        db.memory.classes[0].status = 'encerrada';
        const closed = await as('prof', 'post', `/api/admin/assignments/${relatorio.id}/publish`).send({ reason: 'Volta' });
        assert.equal(closed.status, 409, JSON.stringify(closed.body));
        db.memory.classes[0].status = undefined;
        const noReason = await as('prof', 'post', `/api/admin/assignments/${relatorio.id}/publish`).send({});
        assert.equal(noReason.status, 400, JSON.stringify(noReason.body));
        assert.equal(noReason.body.code, 'reason_required');
        const ok = await as('prof', 'post', `/api/admin/assignments/${relatorio.id}/publish`).send({ reason: 'Corrigido o prazo' });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal(rowOf(await gradebookOf(), 'ana@tarefa-nota.local').average, 7.3);
    });
    // O rascunho novo publica sem motivo e sem portão, como antes.
    const novo = task({ title: 'Nova', status: 'rascunho' });
    const res = await as('prof', 'post', `/api/admin/assignments/${novo.id}/publish`).send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
});

test('[UC-TAREFAS-002] sem critérios, mudar "Conta na média" com nota devolvida pede motivo; só com nota salva, não', async () => {
    const relatorio = task({ title: 'Relatório', moduleId: 'M1' });
    graded(relatorio, 'ana@tarefa-nota.local', 100);
    const salva = task({ title: 'Ainda corrigindo' });
    graded(salva, 'ana@tarefa-nota.local', 50, { returned: false });
    const noReason = await as('prof', 'post', `/api/admin/assignments/${relatorio.id}/update`).send({ countsInAverage: false });
    assert.equal(noReason.status, 400, JSON.stringify(noReason.body));
    assert.equal(noReason.body.code, 'reason_required');
    assert.match(noReason.body.error, /tirar a tarefa da média/);
    // O quadro do professor conta também a nota salva (5,0): (4 + 8 + 10 + 5) / 4.
    assert.equal(rowOf(await gradebookOf(), 'ana@tarefa-nota.local').average, 6.8, 'nada mudou');
    const ok = await as('prof', 'post', `/api/admin/assignments/${relatorio.id}/update`).send({ countsInAverage: false, reason: 'Tarefa opcional' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(db.memory.auditLogs.filter(entry => entry.action === 'assignment_updated').pop().reason, 'Tarefa opcional');
    const saved = await as('prof', 'post', `/api/admin/assignments/${salva.id}/update`).send({ countsInAverage: false });
    assert.equal(saved.status, 200, 'nota ainda não devolvida: o aluno não viu');
    assert.equal(saved.body.assignment.averageReasonRequired, false);
    // Mudar o título da tarefa com nota devolvida continua sem motivo.
    const title = await as('prof', 'post', `/api/admin/assignments/${relatorio.id}/update`).send({ title: 'Relatório final' });
    assert.equal(title.status, 200, JSON.stringify(title.body));
});

// Regressão de desempenho (rodada 1): o resumo de Alunos e o Dashboard montam a média aluno
// por aluno; o provedor 'tarefa' varria todas as entregas da escola a cada aluno (O(alunos x
// tarefas x entregas); 2,5 s com 10 turmas x 40 alunos x 15 tarefas). Agora as notas saem
// uma vez por turma e pedido.
test('[UC-TAREFAS-001] o resumo de Alunos lê as notas de tarefa uma vez por turma, não uma por aluno, e a média é a mesma do quadro', async () => {
    for (let index = 0; index < 20; index += 1) {
        db.memory.students.push({ id: `alu_${String(index).padStart(16, '1')}`, name: `Aluno ${index}`, email: `aluno${index}@tarefa-nota.local`, status: 'Ativo', classes: [{ name: '1DES', courseId: COURSE }], studentClass: '1DES' });
    }
    const tasks = [task({ title: 'T1', moduleId: 'M1' }), task({ title: 'T2', moduleId: 'M2' }), task({ title: 'T3' })];
    db.memory.students.forEach((student, index) => tasks.forEach((item, position) => graded(item, student.email, (index * 7 + position * 13) % 101)));
    const original = assignments.assignmentGradeEntries;
    let calls = 0;
    assignments.assignmentGradeEntries = (...args) => { calls += 1; return original(...args); };
    try {
        const res = await as('admin', 'get', `/api/admin/dashboard/students-overview?courseId=${COURSE}&studentClass=1DES`);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.length, 22);
        assert.ok(calls >= 1 && calls <= 2, `uma leitura por turma (publicadas e, para o professor, as salvas), não uma por aluno: ${calls}`);
        const gb = await gradebookOf('admin');
        res.body.forEach(row => {
            const line = rowOf(gb, row.email);
            assert.equal(row.media, line.average, `${row.email}: a média do resumo é a do quadro`);
        });
    } finally {
        assignments.assignmentGradeEntries = original;
    }
});

test('[UC-TAREFAS-003] Início: a tarefa com "Conta na média" desmarcado vem marcada fora da média no desempenho', async () => {
    const extra = task({ title: 'Exercício extra', countsInAverage: false });
    graded(extra, 'ana@tarefa-nota.local', 30);
    const relatorio = task({ title: 'Relatório' });
    graded(relatorio, 'ana@tarefa-nota.local', 90);
    const dashboard = await asStudent('ana@tarefa-nota.local', `/api/student/dashboard?courseId=${COURSE}&studentClass=1DES`);
    assert.equal(dashboard.status, 200, JSON.stringify(dashboard.body));
    const byTitle = new Map(dashboard.body.performance.map(item => [item.title, item]));
    assert.equal(byTitle.get('Tarefa: Exercício extra').foraDaMedia, true);
    assert.equal('foraDaMedia' in byTitle.get('Tarefa: Relatório'), false);
});
