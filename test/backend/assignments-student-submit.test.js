// Tarefas no portal do aluno (fase 3, C5 / P1-c; FUN-01, D5, D6, D8, D9, D16 e D17 do P1).
// Antes deste caso, GET /api/student/assignments respondia 404 e o aluno não tinha onde
// entregar um trabalho. Confere: a lista e o detalhe só com tarefa publicada e aberta da
// turma do aluno; o envio multipart (uma versão por pedido, tudo ou nada), com os limites
// da tarefa, o tipo, a assinatura, o executável sempre recusado, o vazio, o link; o atraso
// pela CHEGADA do pedido; aceitar, bloquear e encerramento; reenvio com as versões
// guardadas, 20 no máximo, dois envios ao mesmo tempo sem repetir a versão; disco abaixo
// do mínimo (507), falha de gravação (503, versão desfeita e arquivos na lixeira), turma
// encerrada (409 class_closed); o download só do próprio arquivo, sempre como anexo; a
// auditoria; o sino (nova tarefa e prazo em 24 h) e o calendário (entrega); e a
// pré-visualização (lê, não envia).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-assignments-student-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

// Módulos antes do servidor: server.js registra o process.on('uncaughtException'), que
// engoliria a falha destes require.
const db = require('../../backend/database.js');
const runtimePaths = require('../../backend/runtimePaths.js');
const assignmentFiles = require('../../backend/utils/assignmentFiles.js');
const assignments = require('../../backend/utils/assignments.js');
const academicCalendar = require('../../backend/utils/academicCalendar.js');
const studentFeeds = require('../../backend/utils/studentFeeds.js');
const fileStore = require('../../backend/utils/storage.js');
const { createStudentSession, createAdminSession } = require('../../backend/utils/authSessions.js');
const { createApp } = require('../../backend/server.js');

const COURSE = 'curso-entregas';
const CLASS = '1DES';
const OTHER = '2DES';
const ANA = 'ana@entregas.local';
const BIA = 'bia@entregas.local';
const DUDA = 'duda@entregas.local';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2048, 0x20), Buffer.from('\n%%EOF\n')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
let app;
const tokens = {};

function task(fields = {}) {
    const now = Date.now();
    return assignments.newAssignmentRecord({
        courseId: COURSE,
        studentClass: CLASS,
        title: 'Relatório da prática',
        instructions: 'Envie o relatório em PDF.',
        response: { files: true, text: true, link: true },
        files: { maxFiles: 3, maxSizeMb: 1, types: ['pdf', 'image', 'code'], extraExtensions: ['.pkt'] },
        dueAt: now + 3 * DAY,
        closeAt: null,
        latePolicy: { mode: 'aceitar', penaltyPerDayPct: 10, penaltyMaxPct: 50 },
        status: 'publicada',
        ...fields,
    }, { actor: 'prof@entregas.local', now: now - HOUR });
}

function seed() {
    db.memory.config = { ...(db.memory.config || {}), settings: {
        timezone: 'America/Sao_Paulo',
        entregas: { maxMbPorArquivo: 1, maxMbPorEnvio: 2, discoLivreMinimoMb: 0 },
    } };
    db.memory.courses = [{ id: COURSE, name: 'Desenvolvimento', structure: [{ id: 'm1', name: 'Módulo 1', units: [] }] }];
    db.memory.classes = [{ name: CLASS, courseId: COURSE, period: 'Manhã' }, { name: OTHER, courseId: COURSE, period: 'Tarde' }];
    db.memory.students = [
        { id: 'alu_00000000000000a1', name: 'Ana Lima', email: ANA, status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: CLASS, courseId: COURSE }] },
        { id: 'alu_00000000000000b2', name: 'Bia Reis', email: BIA, status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: CLASS, courseId: COURSE }] },
        { id: 'alu_00000000000000d4', name: 'Duda Melo', email: DUDA, status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: OTHER, courseId: COURSE }] },
    ];
    db.memory.admins = [{ email: 'prof@entregas.local', name: 'Professora', role: 'professor', password: db.hashPassword('Senha-forte-2026'), assignedClasses: [{ courseId: COURSE, className: CLASS }] }];
    db.memory.adminSessions = {};
    db.memory.library = [{ id: 'lib_1', name: 'Modelo do relatório', url: '/uploads/modelo.pdf', kind: 'file', type: 'pdf', courseId: COURSE }];
    db.memory.assignments = [];
    db.memory.assignmentSubmissions = [];
    db.memory.announcements = [];
    db.memory.forum = [];
    db.memory.submissions = [];
    db.memory.examApplications = [];
    db.memory.auditLogs = [];
    db.memory.sessions = {};
    [ANA, BIA, DUDA].forEach(email => { tokens[email] = createStudentSession(db.memory, email); });
    tokens.prof = createAdminSession(db.memory, 'prof@entregas.local');
    fs.rmSync(runtimePaths.ASSIGNMENT_FILES_DIR, { recursive: true, force: true });
}

const as = (email, req) => req.set('x-session-token', tokens[email]);
const Q = `courseId=${COURSE}&studentClass=${CLASS}`;
const audits = action => (db.memory.auditLogs || []).filter(entry => entry.action === action);

function submit(email, id, { files = [], text, link, field = 'files' } = {}) {
    let req = as(email, request(app).post(`/api/student/assignments/${id}/submit`));
    files.forEach(([name, buffer]) => { req = req.attach(field, buffer, name); });
    if (text !== undefined) req = req.field('text', text);
    if (link !== undefined) req = req.field('link', link);
    if (!files.length && text === undefined && link === undefined) req = req.field('nada', '');
    return req;
}

function listDir(dir) {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    const walk = current => fs.readdirSync(current, { withFileTypes: true }).forEach(entry => {
        const abs = path.join(current, entry.name);
        if (entry.isDirectory()) walk(abs); else out.push(path.relative(runtimePaths.ASSIGNMENT_FILES_DIR, abs).split(path.sep).join('/'));
    });
    walk(dir);
    return out.sort();
}

const storedFiles = () => listDir(runtimePaths.ASSIGNMENT_FILES_DIR).filter(rel => !rel.startsWith('.recebendo/'));
const receivingFiles = () => listDir(runtimePaths.ASSIGNMENT_RECEIVING_DIR);

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

test('FUN-01: lista do aluno (era 404) só com tarefa publicada e aberta da turma dele, por prazo; outra turma 403', async () => {
    const later = task({ title: 'Depois', dueAt: Date.now() + 5 * DAY });
    const soon = task({ title: 'Antes', dueAt: Date.now() + DAY });
    const draft = task({ title: 'Rascunho', status: 'rascunho' });
    const future = task({ title: 'Abre depois', opensAt: Date.now() + DAY });
    const archived = task({ title: 'Arquivada', status: 'arquivada' });
    const other = task({ title: 'Da 2DES', studentClass: OTHER });
    db.memory.assignments = [later, soon, draft, future, archived, other];

    const res = await as(ANA, request(app).get(`/api/student/assignments?${Q}`));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.assignments.map(item => item.title), ['Antes', 'Depois']);
    const first = res.body.assignments[0];
    assert.equal(first.situacao, 'a_fazer');
    assert.equal(first.situacaoTexto, 'A fazer');
    assert.equal(first.aceitaEnvio, true);
    assert.equal(first.dueAt, soon.dueAt);
    assert.equal(first.nota, null);
    assert.equal(typeof res.body.serverNow, 'number');

    const forbidden = await as(DUDA, request(app).get(`/api/student/assignments?${Q}`));
    assert.equal(forbidden.status, 403);
    const duda = await as(DUDA, request(app).get(`/api/student/assignments?courseId=${COURSE}&studentClass=${OTHER}`));
    assert.deepEqual(duda.body.assignments.map(item => item.title), ['Da 2DES']);

    // Detalhe: rascunho, abertura futura, arquivada e de outra turma não existem para o aluno.
    for (const hidden of [draft, future, archived, other]) {
        const detail = await as(ANA, request(app).get(`/api/student/assignments/${hidden.id}`));
        assert.equal(detail.status, 404, hidden.title);
    }
    const wrongContext = await as(ANA, request(app).get(`/api/student/assignments/${soon.id}?courseId=${COURSE}&studentClass=${OTHER}`));
    assert.equal(wrongContext.status, 403);
    const noAuth = await request(app).get(`/api/student/assignments?${Q}`);
    assert.equal(noAuth.status, 400);
});

test('detalhe: o que enviar, regra de atraso por extenso, materiais da Biblioteca e hora do servidor; nunca caminho de arquivo', async () => {
    const item = task({ libraryIds: ['lib_1', 'lib_que_nao_existe'], latePolicy: { mode: 'desconto', penaltyPerDayPct: 10, penaltyMaxPct: 30 } });
    db.memory.assignments = [item];
    const res = await as(ANA, request(app).get(`/api/student/assignments/${item.id}?${Q}`));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.assignment.title, 'Relatório da prática');
    assert.equal(res.body.assignment.regraAtraso, 'Depois do prazo, a entrega é aceita com desconto de 10% por dia de atraso, até 30%.');
    assert.deepEqual(res.body.assignment.materiais.map(entry => entry.name), ['Modelo do relatório']);
    assert.match(res.body.assignment.materiais[0].url, /^\/uploads\/modelo\.pdf\?access=/);
    assert.deepEqual(res.body.aceita.resposta, { files: true, text: true, link: true });
    assert.equal(res.body.aceita.maxFiles, 3);
    assert.equal(res.body.aceita.maxSizeMb, 1);
    assert.equal(res.body.aceita.maxTotalMb, 2);
    assert.ok(res.body.aceita.accept.includes('image/*'));
    assert.ok(res.body.aceita.extensoes.includes('.pkt'));
    assert.ok(res.body.aceita.tipos.includes('PDF'));
    assert.ok(res.body.aceita.tipos.some(label => label.includes('.pkt')));
    assert.equal(res.body.aceitaEnvio, true);
    assert.equal(res.body.minhaEntrega, null);
    assert.equal(res.body.devolucao, null);
    assert.equal(typeof res.body.serverNow, 'number');
    assert.equal(res.body.timezone, 'America/Sao_Paulo');
});

test('FUN-01: envio com PDF (nome acentuado) grava a versão 1, move o arquivo para data/entregas, limpa .recebendo e audita', async () => {
    const item = task();
    db.memory.assignments = [item];
    const before = Date.now();
    const res = await submit(ANA, item.id, { files: [['Relatório final.pdf', PDF]], text: '  Segue o relatório.  ' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.version.n, 1);
    assert.equal(res.body.version.late, false);
    assert.equal(res.body.version.files.length, 1);
    assert.equal(res.body.version.files[0].name, 'Relatório final.pdf');
    assert.equal(res.body.version.files[0].size, PDF.length);
    assert.match(res.body.version.files[0].comprovante, /^[0-9A-F]{8}$/);
    assert.match(res.body.version.comprovante, /^[0-9A-F]{8}$/);
    assert.equal(res.body.situacao, 'enviada');
    assert.ok(!JSON.stringify(res.body).includes('storedRel'));
    assert.ok(!JSON.stringify(res.body).includes('entregas/'));

    assert.equal(db.memory.assignmentSubmissions.length, 1);
    const sub = db.memory.assignmentSubmissions[0];
    assert.match(sub.id, /^asub_\d+_[0-9a-f]{6}$/);
    assert.equal(sub.studentEmail, ANA);
    assert.equal(sub.studentId, 'alu_00000000000000a1');
    assert.equal(sub.status, 'enviada');
    assert.equal(sub.versions.length, 1);
    const version = sub.versions[0];
    assert.ok(version.requestAt >= before && version.requestAt <= version.receivedAt);
    assert.equal(version.text, '  Segue o relatório.  ');
    const [file] = version.files;
    assert.equal(file.storedRel, `entregas/${item.id}/${sub.id}/${file.id}.pdf`);
    assert.equal(file.category, 'pdf');
    assert.equal(file.mime, 'application/pdf');
    assert.equal(file.sha256, require('node:crypto').createHash('sha256').update(PDF).digest('hex'));
    assert.deepEqual(storedFiles(), [`${item.id}/${sub.id}/${file.id}.pdf`]);
    assert.deepEqual(receivingFiles(), []);
    assert.equal(res.body.version.comprovante, assignments.versionReceiptCode(sub, version));

    const [entry] = audits('assignment_submitted');
    assert.ok(entry, 'auditoria');
    assert.equal(entry.category, 'assignment');
    assert.equal(entry.actor, ANA);
    assert.equal(entry.actorRole, 'aluno');
    assert.equal(entry.studentEmail, ANA);
    assert.equal(entry.courseId, COURSE);
    assert.equal(entry.studentClass, CLASS);
    assert.equal(entry.submissionId, sub.id);
    assert.deepEqual(entry.details, { assignmentId: item.id, version: 1, files: 1, bytes: PDF.length, late: false, lateMs: 0, text: true, link: false, sha256s: [file.sha256] });

    // O registro gravado no banco (não só a memória).
    const stored = (await db.readStoredData()).memory;
    assert.equal(stored.assignmentSubmissions.length, 1);
    assert.equal(stored.assignmentSubmissions[0].versions[0].files[0].sha256, file.sha256);
    assert.ok(stored.auditLogs.some(item => item.action === 'assignment_submitted'));

    // O detalhe mostra a versão com o comprovante, sem caminho.
    const detail = await as(ANA, request(app).get(`/api/student/assignments/${item.id}`));
    assert.equal(detail.body.minhaEntrega.versoes.length, 1);
    assert.equal(detail.body.minhaEntrega.versoes[0].files[0].name, 'Relatório final.pdf');
    assert.equal(detail.body.situacao, 'enviada');
    assert.ok(!JSON.stringify(detail.body).includes('storedRel'));
});

test('recusas do envio: executável, assinatura errada, tamanho, arquivos demais, vazio, link, tipo de resposta; nada fica em data/entregas', async () => {
    const item = task();
    const textOnly = task({ title: 'Só texto', response: { files: false, text: true, link: false } });
    db.memory.assignments = [item, textOnly];
    const cases = [
        [{ files: [['programa.exe', Buffer.from('MZ\x90\x00')]] }, 400, 'file_blocked', /executáveis/],
        [{ files: [['falso.pdf', Buffer.from('isto não é um PDF de verdade')]] }, 400, 'file_signature', /não confere com o formato \.pdf/],
        [{ files: [['planilha.xlsx', Buffer.from('PK\x03\x04')]] }, 400, 'file_type', /não é aceito nesta tarefa/],
        [{ files: [['grande.pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1024 * 1024 + 10, 0x20)])]] }, 413, 'file_too_large', /"grande\.pdf" passa do limite de 1 MB/],
        [{ files: [['a.pdf', PDF], ['b.pdf', PDF], ['c.pdf', PDF], ['d.pdf', PDF]] }, 400, 'too_many_files', /no máximo 3 arquivo/],
        [{ files: [['ok.pdf', PDF], ['vírus.bat', Buffer.from('echo')]] }, 400, 'file_blocked', /vírus\.bat/],
        [{}, 400, 'empty_submission', /O envio está vazio\. Envie um arquivo, a resposta em texto ou o link\./],
        [{ text: '   ' }, 400, 'empty_submission', /vazio/],
        [{ link: 'javascript:alert(1)' }, 400, 'invalid_link', /http:\/\/ ou https:\/\//],
        [{ link: 'ftp://servidor/arquivo' }, 400, 'invalid_link', /http/],
        [{ files: [['ok.pdf', PDF]], field: 'outro' }, 400, 'unexpected_field', /campo de arquivo inesperado/],
        [{ text: 'x'.repeat(10001) }, 400, undefined, /no máximo 10\.000 caracteres/],
    ];
    for (const [payload, status, code, message] of cases) {
        const res = await submit(ANA, item.id, payload);
        assert.equal(res.status, status, `${JSON.stringify(Object.keys(payload))} ${JSON.stringify(res.body)}`);
        if (code) assert.equal(res.body.code, code, JSON.stringify(res.body));
        assert.match(res.body.error, message);
    }
    const noFiles = await submit(ANA, textOnly.id, { files: [['ok.pdf', PDF]] });
    assert.equal(noFiles.status, 400);
    assert.equal(noFiles.body.code, 'files_not_accepted');
    const noLink = await submit(ANA, textOnly.id, { link: 'https://exemplo.com' });
    assert.equal(noLink.status, 400);
    assert.equal(noLink.body.code, 'link_not_accepted');

    assert.deepEqual(storedFiles(), [], 'nada recusado ficou em data/entregas');
    assert.deepEqual(receivingFiles(), [], 'nem em .recebendo');
    assert.equal(db.memory.assignmentSubmissions.length, 0);
    assert.equal(audits('assignment_submitted').length, 0);

    // O envio que passa do limite do envio (soma) também é recusado (413).
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(900 * 1024, 0x20)]);
    const total = await submit(ANA, item.id, { files: [['a.pdf', big], ['b.pdf', big], ['c.pdf', big]] });
    assert.equal(total.status, 413);
    assert.equal(total.body.code, 'submission_too_large');
    assert.deepEqual(storedFiles(), []);
    assert.deepEqual(receivingFiles(), []);
});

test('aceita código, imagem e formato do curso (.pkt), texto e link https; executável como formato do curso continua recusado', async () => {
    const item = task();
    db.memory.assignments = [item];
    const res = await submit(ANA, item.id, {
        files: [['main.py', Buffer.from('print("olá")\n')], ['rede.pkt', Buffer.from([0, 1, 2, 3, 4])], ['foto.png', PNG]],
        link: 'https://github.com/turma/projeto',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const version = db.memory.assignmentSubmissions[0].versions[0];
    assert.deepEqual(version.files.map(file => [file.originalName, file.category]), [['main.py', 'code'], ['rede.pkt', 'curso'], ['foto.png', 'image']]);
    assert.equal(version.link, 'https://github.com/turma/projeto');
    assert.equal(version.text, '');
    assert.equal(storedFiles().length, 3);
});

test('reenvio: a versão 2 guarda a 1; a 21ª é recusada; refazer volta a "enviada"; devolvida não recebe', async () => {
    const item = task();
    db.memory.assignments = [item];
    assert.equal((await submit(ANA, item.id, { files: [['v1.pdf', PDF]] })).status, 201);
    const second = await submit(ANA, item.id, { text: 'Versão corrigida' });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(second.body.version.n, 2);
    const sub = db.memory.assignmentSubmissions[0];
    assert.equal(db.memory.assignmentSubmissions.length, 1, 'uma linha por aluno e tarefa');
    assert.deepEqual(sub.versions.map(version => version.n), [1, 2]);
    assert.equal(sub.versions[0].files[0].originalName, 'v1.pdf');
    assert.equal(storedFiles().length, 1, 'o arquivo da versão 1 continua');

    // Pedido para refazer (C6 grava assim): o envio novo volta a situação para 'enviada'.
    sub.status = 'refazer';
    sub.grade = { score: 40, penaltyPct: 0, finalScore: 40, comment: 'Falta o diagrama.', versionGraded: 2, gradedBy: 'prof@entregas.local', gradedAt: Date.now() };
    sub.extension = { dueAt: Date.now() + DAY, closeAt: null, by: 'prof@entregas.local', at: Date.now() - 1000, reason: 'Refazer' };
    const redo = await as(ANA, request(app).get(`/api/student/assignments/${item.id}`));
    assert.equal(redo.body.situacao, 'refazer');
    assert.equal(redo.body.refazer.comentario, 'Falta o diagrama.');
    assert.equal(redo.body.devolucao, null, 'nota não sai antes de devolvida');
    const third = await submit(ANA, item.id, { text: 'Com o diagrama' });
    assert.equal(third.status, 201);
    assert.equal(db.memory.assignmentSubmissions[0].status, 'enviada');
    assert.equal(assignments.instructorStatus(db.memory.assignmentSubmissions[0]), 'para_corrigir');

    // Devolvida: não recebe versão nova (409) e a nota aparece para o aluno.
    const current = db.memory.assignmentSubmissions[0];
    current.status = 'devolvida';
    current.returnedAt = Date.now();
    current.grade = { ...current.grade, score: 90, finalScore: 90, versionGraded: 3, comment: 'Ótimo.' };
    const returned = await submit(ANA, item.id, { text: 'Mais uma' });
    assert.equal(returned.status, 409);
    assert.equal(returned.body.code, 'assignment_devolvida');
    const list = await as(ANA, request(app).get(`/api/student/assignments?${Q}`));
    assert.deepEqual(list.body.assignments[0].nota, { nota: 90, desconto: 0, notaFinal: 90 });
    const detail = await as(ANA, request(app).get(`/api/student/assignments/${item.id}`));
    assert.equal(detail.body.devolucao.comentario, 'Ótimo.');

    // 20 versões: a 21ª é recusada.
    current.status = 'enviada';
    current.returnedAt = null;
    current.versions = Array.from({ length: 20 }, (_, index) => ({ n: index + 1, requestAt: Date.now() - 1000, receivedAt: Date.now() - 1000, late: false, lateMs: 0, text: `v${index + 1}`, link: '', files: [] }));
    const limit = await submit(ANA, item.id, { text: 'Versão 21' });
    assert.equal(limit.status, 409);
    assert.equal(limit.body.code, 'assignment_limite_versoes');
    assert.match(limit.body.error, /20 versões/);
});

test('correção salva (não devolvida) não aparece para o aluno; versão nova depois dela continua "corrigida" para o professor rever', async () => {
    const item = task();
    db.memory.assignments = [item];
    await submit(ANA, item.id, { text: 'v1' });
    const sub = db.memory.assignmentSubmissions[0];
    sub.status = 'corrigida';
    sub.grade = { score: 70, penaltyPct: 0, finalScore: 70, comment: 'Rascunho do professor', versionGraded: 1 };
    const detail = await as(ANA, request(app).get(`/api/student/assignments/${item.id}`));
    assert.equal(detail.body.devolucao, null);
    assert.ok(!JSON.stringify(detail.body).includes('Rascunho do professor'));
    const list = await as(ANA, request(app).get(`/api/student/assignments?${Q}`));
    assert.equal(list.body.assignments[0].nota, null);
    assert.equal((await submit(ANA, item.id, { text: 'v2' })).status, 201);
    assert.equal(db.memory.assignmentSubmissions[0].status, 'corrigida');
    assert.equal(assignments.instructorStatus(db.memory.assignmentSubmissions[0]), 'para_corrigir');
});

test('D8: atraso medido pela chegada do pedido; aceitar marca atrasada; bloquear recusa; encerramento sempre fecha', async () => {
    const original = assignmentFiles.validateReceivedFile;
    try {
        // Upload que começou antes do prazo e terminou depois: não é atrasado.
        const due = Date.now() + 400;
        const slow = task({ title: 'Prazo apertado', dueAt: due, latePolicy: { mode: 'bloquear', penaltyPerDayPct: 0, penaltyMaxPct: 0 } });
        db.memory.assignments = [slow];
        assignmentFiles.validateReceivedFile = async (...args) => {
            await new Promise(resolve => setTimeout(resolve, 700));
            return original(...args);
        };
        const res = await submit(ANA, slow.id, { files: [['ultimo-minuto.pdf', PDF]] });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        const version = db.memory.assignmentSubmissions[0].versions[0];
        assert.ok(version.requestAt < due, 'pedido chegou antes do prazo');
        assert.ok(version.receivedAt > due, 'e terminou depois');
        assert.equal(version.late, false);
        assert.equal(version.lateMs, 0);
    } finally {
        assignmentFiles.validateReceivedFile = original;
    }

    const lateAccept = task({ title: 'Aceita atrasada', dueAt: Date.now() - 2 * HOUR });
    const lateBlock = task({ title: 'Não aceita atrasada', dueAt: Date.now() - 2 * HOUR, latePolicy: { mode: 'bloquear', penaltyPerDayPct: 0, penaltyMaxPct: 0 } });
    const closed = task({ title: 'Encerrada', dueAt: Date.now() - 3 * HOUR, closeAt: Date.now() - HOUR });
    db.memory.assignments = [lateAccept, lateBlock, closed];
    db.memory.assignmentSubmissions = [];

    const list = await as(ANA, request(app).get(`/api/student/assignments?${Q}`));
    const byTitle = Object.fromEntries(list.body.assignments.map(item => [item.title, item]));
    assert.equal(byTitle['Aceita atrasada'].situacao, 'atrasada');
    assert.equal(byTitle['Não aceita atrasada'].situacao, 'encerrada_sem_envio');
    assert.equal(byTitle['Encerrada'].aceitaEnvio, false);
    const detail = await as(ANA, request(app).get(`/api/student/assignments/${lateAccept.id}`));
    assert.equal(detail.body.atrasoAgora, true);

    const accepted = await submit(ANA, lateAccept.id, { text: 'Atrasado, mas foi' });
    assert.equal(accepted.status, 201);
    assert.equal(accepted.body.version.late, true);
    assert.ok(accepted.body.version.lateMs >= 2 * HOUR - 1000);
    assert.equal(accepted.body.situacaoTexto, 'Enviada com atraso');
    const blocked = await submit(ANA, lateBlock.id, { text: 'Tarde demais' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'assignment_prazo_encerrado');
    const afterClose = await submit(ANA, closed.id, { text: 'Tarde demais' });
    assert.equal(afterClose.status, 409);
    assert.equal(afterClose.body.code, 'assignment_encerrada');
    assert.equal(db.memory.assignmentSubmissions.length, 1);
});

test('dois envios ao mesmo tempo do mesmo aluno viram as versões 1 e 2 (trava), e de alunos diferentes correm juntos', async () => {
    const item = task();
    db.memory.assignments = [item];
    const results = await Promise.all([
        submit(ANA, item.id, { files: [['a.pdf', PDF]] }),
        submit(ANA, item.id, { files: [['b.pdf', PDF]] }),
        submit(ANA, item.id, { text: 'c' }),
        submit(BIA, item.id, { files: [['bia.pdf', PDF]] }),
    ]);
    results.forEach(res => assert.equal(res.status, 201, JSON.stringify(res.body)));
    const ana = db.memory.assignmentSubmissions.filter(sub => sub.studentEmail === ANA);
    assert.equal(ana.length, 1, 'uma linha da Ana');
    assert.deepEqual(ana[0].versions.map(version => version.n), [1, 2, 3]);
    assert.deepEqual(results.slice(0, 3).map(res => res.body.version.n).sort(), [1, 2, 3]);
    assert.equal(db.memory.assignmentSubmissions.filter(sub => sub.studentEmail === BIA).length, 1);
    assert.equal(storedFiles().length, 3);
    assert.deepEqual(receivingFiles(), []);
    assert.equal(require('../../backend/routes/studentAssignments.js').pendingLocks(), 0);
});

test('disco abaixo do mínimo: 507 com a mensagem para avisar o professor, antes de receber o corpo', async () => {
    const item = task();
    db.memory.assignments = [item];
    db.memory.config.settings.entregas.discoLivreMinimoMb = 1024 * 1024;
    const res = await submit(ANA, item.id, { files: [['a.pdf', PDF]] });
    assert.equal(res.status, 507);
    assert.equal(res.body.code, 'disk_full');
    assert.equal(res.body.error, assignmentFiles.DISK_FULL_MESSAGE);
    assert.deepEqual(storedFiles(), []);
    assert.deepEqual(receivingFiles(), []);
    assert.equal(db.memory.assignmentSubmissions.length, 0);
});

test('falha de gravação: 503 retryable, versão desfeita na memória, auditoria fora e arquivos na lixeira (só do administrador)', async () => {
    const item = task();
    db.memory.assignments = [item];
    assert.equal((await submit(ANA, item.id, { files: [['v1.pdf', PDF]] })).status, 201);
    const before = JSON.stringify(db.memory.assignmentSubmissions);
    const auditCount = (db.memory.auditLogs || []).length;
    const originalSave = db.save;
    db.save = function failingSave(options) {
        if (options && Array.isArray(options.only) && options.only.includes('assignmentSubmissions')) {
            const error = new Error('Não foi possível gravar os dados agora.');
            error.code = 'ICLASS_DB_WRITE';
            return Promise.reject(error);
        }
        return originalSave.call(this, options);
    };
    let res;
    try {
        res = await submit(ANA, item.id, { files: [['v2.pdf', PDF]] });
    } finally {
        db.save = originalSave;
    }
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.equal(res.body.retryable, true);
    assert.equal(res.body.code, 'write_failed');
    assert.equal(JSON.stringify(db.memory.assignmentSubmissions), before, 'a versão 2 não ficou na memória');
    assert.equal((db.memory.auditLogs || []).length, auditCount);
    assert.equal(storedFiles().length, 1, 'só o arquivo da versão 1 ficou em data/entregas');
    assert.deepEqual(receivingFiles(), []);
    const trashed = fileStore.listTrash().filter(entry => /^entregas\//.test(entry.originalRel));
    assert.equal(trashed.length, 1);
    assert.equal(trashed[0].originalName, 'v2.pdf');
    assert.equal(fileStore.isAdminOnlyTrashEntry(trashed[0]), true);

    // De novo, sem falha: vira a versão 2.
    const retry = await submit(ANA, item.id, { files: [['v2.pdf', PDF]] });
    assert.equal(retry.status, 201);
    assert.equal(retry.body.version.n, 2);
});

test('turma encerrada: o envio recebe 409 class_closed com a mensagem do envio, sem gravar (assertClassOpen)', async () => {
    const item = task();
    db.memory.assignments = [item];
    const original = academicCalendar.assertClassOpen;
    academicCalendar.assertClassOpen = cls => { throw new academicCalendar.ClassClosedError(cls); };
    try {
        const res = await submit(ANA, item.id, { files: [['a.pdf', PDF]] });
        assert.equal(res.status, 409);
        assert.deepEqual(res.body, { success: false, error: 'Esta turma foi encerrada. O envio não é mais aceito.', code: 'class_closed' });
        // Encerrada no meio do upload: a gravação confere de novo.
        let calls = 0;
        academicCalendar.assertClassOpen = cls => { calls += 1; if (calls > 1) throw new academicCalendar.ClassClosedError(cls); return true; };
        const during = await submit(ANA, item.id, { files: [['a.pdf', PDF]] });
        assert.equal(during.status, 409);
        assert.equal(during.body.code, 'class_closed');
    } finally {
        academicCalendar.assertClassOpen = original;
    }
    assert.equal(db.memory.assignmentSubmissions.length, 0);
    assert.deepEqual(storedFiles(), []);
    assert.deepEqual(receivingFiles(), []);
    // Sem efeito ainda (o B10 liga): a turma passa.
    assert.equal((await submit(ANA, item.id, { text: 'ok' })).status, 201);
});

test('download: só o arquivo do próprio aluno, como anexo, nosniff e CSP sandbox; HTML sai como texto', async () => {
    const item = task();
    db.memory.assignments = [item];
    const html = Buffer.from('<script>alert("oi")</script>\n');
    const sent = await submit(ANA, item.id, { files: [['página.html', html], ['Relatório.pdf', PDF]] });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const [htmlFile, pdfFile] = sent.body.version.files;

    const res = await as(ANA, request(app).get(`/api/student/assignments/${item.id}/files/${htmlFile.id}`)).buffer(true).parse((r, cb) => {
        const chunks = [];
        r.on('data', chunk => chunks.push(chunk));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
    assert.match(res.headers['content-disposition'], /^attachment; filename="pagina\.html"; filename\*=UTF-8''p%C3%A1gina\.html$/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['content-security-policy'], 'sandbox');
    assert.deepEqual(res.body, html);
    const pdf = await as(ANA, request(app).get(`/api/student/assignments/${item.id}/files/${pdfFile.id}`));
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.match(pdf.headers['content-disposition'], /^attachment;/);

    // A colega não baixa o arquivo da Ana (troca de fileId), nem com o id certo.
    const other = await as(BIA, request(app).get(`/api/student/assignments/${item.id}/files/${pdfFile.id}`));
    assert.equal(other.status, 404);
    const bogus = await as(ANA, request(app).get(`/api/student/assignments/${item.id}/files/..%2F..%2Fdatabase.db`));
    assert.equal(bogus.status, 404);
    // Arquivo que saiu do disco: 404 com a mensagem.
    fs.rmSync(assignmentFiles.absFromStoredRel(db.memory.assignmentSubmissions[0].versions[0].files[1].storedRel));
    const missing = await as(ANA, request(app).get(`/api/student/assignments/${item.id}/files/${pdfFile.id}`));
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'file_missing');
});

test('D16: sino com "Nova tarefa" e "prazo em 24 h" (some depois do envio) e calendário com a entrega no prazo do aluno', async () => {
    const soon = task({ title: 'Entrega de amanhã', dueAt: Date.now() + 5 * HOUR });
    const later = task({ title: 'Entrega da semana', dueAt: Date.now() + 4 * DAY });
    const draft = task({ title: 'Rascunho', status: 'rascunho' });
    db.memory.assignments = [soon, later, draft];

    let bell = await as(ANA, request(app).get(`/api/student/notifications?${Q}`));
    assert.equal(bell.status, 200);
    let ids = bell.body.items.map(item => item.id);
    assert.ok(ids.includes(`tarefa:${soon.id}:nova`));
    assert.ok(ids.includes(`tarefa:${later.id}:nova`));
    assert.ok(ids.includes(`tarefa:${soon.id}:prazo`));
    assert.ok(!ids.includes(`tarefa:${later.id}:prazo`), 'prazo em 4 dias não entra');
    assert.ok(!ids.some(id => id.includes(draft.id)));
    const deadline = bell.body.items.find(item => item.id === `tarefa:${soon.id}:prazo`);
    assert.equal(deadline.type, 'tarefa');
    assert.equal(deadline.href, `/aluno/atividades/${soon.id}`);
    assert.equal(deadline.unread, true);
    assert.match(deadline.text, /^Entrega de amanhã · até \d{2}\/\d{2} às \d{2}:\d{2}$/);

    // Depois do envio, o lembrete do prazo sai (a "Nova tarefa" fica no histórico).
    assert.equal((await submit(ANA, soon.id, { text: 'feito' })).status, 201);
    bell = await as(ANA, request(app).get(`/api/student/notifications?${Q}`));
    ids = bell.body.items.map(item => item.id);
    assert.ok(!ids.includes(`tarefa:${soon.id}:prazo`));
    assert.ok(ids.includes(`tarefa:${soon.id}:nova`));
    // Marcar como lidas vale para os itens de tarefa.
    await as(ANA, request(app).post(`/api/student/notifications/seen?${Q}`)).send({});
    bell = await as(ANA, request(app).get(`/api/student/notifications?${Q}`));
    assert.ok(bell.body.items.filter(item => item.type === 'tarefa').every(item => item.unread === false));

    // Calendário: um evento 'entrega' por tarefa visível, na data e hora do prazo (fuso da escola).
    const calendar = await as(ANA, request(app).get(`/api/student/calendar-events?${Q}`));
    assert.equal(calendar.status, 200);
    const events = calendar.body.filter(event => event.source === 'tarefas');
    assert.deepEqual(events.map(event => event.id).sort(), [`tarefa:${soon.id}`, `tarefa:${later.id}`].sort());
    const laterEvent = events.find(event => event.id === `tarefa:${later.id}`);
    const local = require('../../backend/utils/schoolTime.js').localParts(later.dueAt, 'America/Sao_Paulo');
    assert.equal(laterEvent.eventDate, local.date);
    assert.equal(laterEvent.startTime, local.time);
    assert.equal(laterEvent.eventType, 'entrega');
    assert.equal(laterEvent.href, `/aluno/atividades/${later.id}`);
    assert.match(laterEvent.description, /Situação: A fazer\./);
    // Prorrogação individual: o calendário da Ana usa o prazo dela.
    db.memory.assignmentSubmissions.push({ ...assignments.newSubmissionRecord(later, db.memory.students[0]), extension: { dueAt: later.dueAt + 2 * DAY, closeAt: null, by: 'prof@entregas.local', at: Date.now(), reason: 'Atestado' } });
    const extended = await as(ANA, request(app).get(`/api/student/calendar-events?${Q}`));
    const extendedEvent = extended.body.find(event => event.id === `tarefa:${later.id}`);
    assert.equal(extendedEvent.eventDate, require('../../backend/utils/schoolTime.js').localParts(later.dueAt + 2 * DAY, 'America/Sao_Paulo').date);
    const bia = await as(BIA, request(app).get(`/api/student/calendar-events?${Q}`));
    assert.equal(bia.body.find(event => event.id === `tarefa:${later.id}`).eventDate, local.date);
    assert.deepEqual(studentFeeds.providerIds('notifications').filter(id => id === 'tarefas'), ['tarefas']);
});

test('conta: sem troca de senha pendente e ativa (o envio passa por validateStudentSession)', async () => {
    const item = task();
    db.memory.assignments = [item];
    db.memory.students[0].status = 'Inativo';
    const inactive = await submit(ANA, item.id, { text: 'oi' });
    assert.equal(inactive.status, 403);
    assert.equal(db.memory.assignmentSubmissions.length, 0);
    const anonymous = await request(app).post(`/api/student/assignments/${item.id}/submit`).field('text', 'oi');
    assert.ok([400, 401].includes(anonymous.status), String(anonymous.status));
    assert.equal(db.memory.assignmentSubmissions.length, 0);
});

test('pré-visualização: lista e detalhe como aluno sem entrega; envio e download recusados (preview_read_only)', async () => {
    const item = task();
    db.memory.assignments = [item];
    assert.equal((await submit(ANA, item.id, { files: [['ana.pdf', PDF]] })).status, 201);
    const fileId = db.memory.assignmentSubmissions[0].versions[0].files[0].id;
    db.memory.admins[0].role = 'professor';
    const opened = await request(app).post('/api/admin/preview-sessions').set('x-admin-session', tokens.prof).send({ courseId: COURSE, studentClass: CLASS });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const token = opened.body.previewToken;
    const before = JSON.stringify(db.memory.assignmentSubmissions);
    const list = await request(app).get(`/api/student/assignments?${Q}`).set('x-preview-session', token);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.assignments[0].situacao, 'a_fazer', 'a entrega da Ana não aparece na prévia');
    const detail = await request(app).get(`/api/student/assignments/${item.id}?${Q}`).set('x-preview-session', token);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.minhaEntrega, null);
    const sent = await request(app).post(`/api/student/assignments/${item.id}/submit`).set('x-preview-session', token).field('text', 'teste');
    assert.equal(sent.status, 403);
    assert.equal(sent.body.code, 'preview_read_only');
    const download = await request(app).get(`/api/student/assignments/${item.id}/files/${fileId}`).set('x-preview-session', token);
    assert.equal(download.status, 403);
    assert.equal(JSON.stringify(db.memory.assignmentSubmissions), before);
});

// ------------------------------------------------------------ ajuste 1 do C5
test('download: falha ao ler o arquivo responde 503 retryable em JSON, sem cabeçalho de anexo (contrato de erros)', async () => {
    const item = task();
    db.memory.assignments = [item];
    const sent = await submit(ANA, item.id, { files: [['Relatório.pdf', PDF]] });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const fileId = sent.body.version.files[0].id;
    const { Readable } = require('node:stream');
    const original = fs.createReadStream;
    fs.createReadStream = () => {
        const stream = new Readable({ read() {} });
        process.nextTick(() => stream.emit('error', Object.assign(new Error('falha de leitura simulada'), { code: 'EIO' })));
        return stream;
    };
    let res;
    try {
        res = await as(ANA, request(app).get(`/api/student/assignments/${item.id}/files/${fileId}`));
    } finally {
        fs.createReadStream = original;
    }
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { success: false, error: 'Não foi possível ler o arquivo agora. Tente de novo em alguns segundos.', code: 'read_failed', retryable: true });
    assert.match(res.headers['content-type'], /^application\/json/);
    assert.equal(res.headers['content-disposition'], undefined);
    // A leitura seguinte funciona.
    const again = await as(ANA, request(app).get(`/api/student/assignments/${item.id}/files/${fileId}`));
    assert.equal(again.status, 200);
    assert.match(again.headers['content-disposition'], /^attachment;/);
});

test('sino: tarefa publicada já com menos de 24 h de prazo traz o lembrete não lido, mesmo depois de um "Marcar como lidas" anterior', async () => {
    await as(ANA, request(app).post(`/api/student/notifications/seen?${Q}`)).send({});
    await new Promise(resolve => setTimeout(resolve, 15));
    const item = task({ title: 'Entrega relâmpago', dueAt: Date.now() + 3 * HOUR });
    item.publishedAt = Date.now();
    db.memory.assignments = [item];
    const bell = await as(ANA, request(app).get(`/api/student/notifications?${Q}`));
    assert.equal(bell.status, 200);
    const fresh = bell.body.items.find(entry => entry.id === `tarefa:${item.id}:nova`);
    const deadline = bell.body.items.find(entry => entry.id === `tarefa:${item.id}:prazo`);
    assert.ok(fresh && deadline, JSON.stringify(bell.body.items));
    assert.equal(fresh.unread, true);
    assert.equal(deadline.unread, true, 'o lembrete nunca mostrado não pode sair como lido');
    assert.ok(new Date(deadline.at).getTime() >= item.publishedAt, 'o lembrete não nasce antes da publicação');
    // Tarefa antiga (publicada há dias) com prazo em 5 h: o lembrete continua em prazo - 24 h.
    const old = task({ title: 'Antiga', dueAt: Date.now() + 5 * HOUR });
    old.publishedAt = Date.now() - 3 * DAY;
    db.memory.assignments = [old];
    const oldBell = await as(ANA, request(app).get(`/api/student/notifications?${Q}`));
    const oldDeadline = oldBell.body.items.find(entry => entry.id === `tarefa:${old.id}:prazo`);
    assert.equal(new Date(oldDeadline.at).getTime(), old.dueAt - DAY);
    assert.equal(oldDeadline.unread, false, 'apareceu antes do último "Marcar como lidas"');
});

test('turma encerrada: a lista, o detalhe, o sino e o calendário não oferecem envio (mesma regra do POST)', async () => {
    const item = task({ title: 'Projeto final', dueAt: Date.now() + 5 * HOUR });
    db.memory.assignments = [item];
    const original = academicCalendar.assertClassOpen;
    academicCalendar.assertClassOpen = cls => { if (cls && cls.name === CLASS) throw new academicCalendar.ClassClosedError(cls); return true; };
    try {
        const list = await as(ANA, request(app).get(`/api/student/assignments?${Q}`));
        assert.equal(list.status, 200);
        assert.equal(list.body.turmaEncerrada, true);
        const row = list.body.assignments[0];
        assert.equal(row.aceitaEnvio, false);
        assert.equal(row.situacao, 'a_fazer');
        assert.equal(row.situacaoTexto, 'Turma encerrada');
        const detail = await as(ANA, request(app).get(`/api/student/assignments/${item.id}?${Q}`));
        assert.equal(detail.status, 200);
        assert.equal(detail.body.aceitaEnvio, false);
        assert.equal(detail.body.turmaEncerrada, true);
        assert.equal(detail.body.motivo, 'Esta turma foi encerrada. O envio não é mais aceito.');
        assert.equal(detail.body.situacaoTexto, 'Turma encerrada');
        const bell = await as(ANA, request(app).get(`/api/student/notifications?${Q}`));
        const ids = bell.body.items.map(entry => entry.id);
        assert.ok(ids.includes(`tarefa:${item.id}:nova`));
        assert.ok(!ids.includes(`tarefa:${item.id}:prazo`), 'turma encerrada não pede envio no sino');
        const calendar = await as(ANA, request(app).get(`/api/student/calendar-events?${Q}`));
        const event = calendar.body.find(entry => entry.id === `tarefa:${item.id}`);
        assert.match(event.description, /Situação: Turma encerrada\./);
        assert.equal((await submit(ANA, item.id, { text: 'oi' })).body.code, 'class_closed');
    } finally {
        academicCalendar.assertClassOpen = original;
    }
    // Turma aberta (hoje, sem efeito): tudo como antes.
    const open = await as(ANA, request(app).get(`/api/student/assignments/${item.id}?${Q}`));
    assert.equal(open.body.aceitaEnvio, true);
    assert.equal(open.body.turmaEncerrada, false);
    assert.equal(open.body.situacaoTexto, 'A fazer');
});

test('formulário com defeito (corpo JSON, nome de arquivo com caractere de controle) recebe invalid_form, não a mensagem de conexão', async () => {
    const item = task();
    db.memory.assignments = [item];
    const json = await as(ANA, request(app).post(`/api/student/assignments/${item.id}/submit`)).send({ text: 'oi' });
    assert.equal(json.status, 400);
    assert.equal(json.body.code, 'invalid_form');
    assert.doesNotMatch(json.body.error, /conexão/);
    const boundary = '----iclass-teste';
    const raw = `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="relat\u0000orio.pdf"\r\nContent-Type: application/pdf\r\n\r\n${PDF.toString('latin1')}\r\n--${boundary}--\r\n`;
    const nul = await as(ANA, request(app).post(`/api/student/assignments/${item.id}/submit`))
        .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
        .send(Buffer.from(raw, 'latin1'));
    assert.equal(nul.status, 400);
    assert.equal(nul.body.code, 'invalid_form');
    assert.equal(nul.body.error, 'O envio não chegou no formato esperado. Atualize a página e tente de novo. Se continuar, renomeie o arquivo com um nome simples.');
    // Cortado no meio (sem o fim do formulário): continua a mensagem de conexão.
    const cut = await as(ANA, request(app).post(`/api/student/assignments/${item.id}/submit`))
        .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
        .send(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\n`, 'latin1'));
    assert.equal(cut.status, 400);
    assert.equal(cut.body.code, 'bad_upload');
    assert.match(cut.body.error, /conexão/);
    assert.equal(db.memory.assignmentSubmissions.length, 0);
    assert.deepEqual(storedFiles(), []);
    assert.deepEqual(receivingFiles(), []);
});
