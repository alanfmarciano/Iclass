// Histórico de matrícula (fase 3, B10 / P2-S9; FUN-05, D19 do P2): students[].classes[].desde
// e students[].historicoMatriculas[] por uma função só (utils/enrollmentHistory.js) em todos os
// caminhos que mudam turmas: ficha do aluno, cadastro, matrícula em lote, aprovação de
// matrícula, desligamento e reativação (bulk-status e ficha). Meus dados traz a seção
// "Histórico de matrículas" nas versões do aluno e do administrador, e anonimizar mantém o
// histórico (só curso, turma e datas). Falha no código de antes (não havia desde nem
// histórico: a turma que saía sumia sem rastro).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-enrollment-history-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const enrollmentHistory = require('../../backend/utils/enrollmentHistory.js');
const db = require('../../backend/database.js');
const settingsUtil = require('../../backend/utils/settings.js');
const { createApp } = require('../../backend/server.js');
const { createStudentSession } = require('../../backend/utils/authSessions.js');

const COURSE = 'TI';
const ADMIN_TOKEN = 'tok-history-admin';
let app;
const admin = (method, url) => request(app)[method](url).set('x-admin-session', ADMIN_TOKEN);
const student = email => db.memory.students.find(item => item.email === email);

function seed() {
    db.memory.config = { ...(db.memory.config || {}), settings: { timezone: 'America/Sao_Paulo' } };
    db.memory.courses = [{ id: COURSE, name: 'Informática', structure: [] }, { id: 'ADM', name: 'Administração', structure: [] }];
    db.memory.classes = [
        { name: '1DES', courseId: COURSE, period: 'Manhã' },
        { name: '2DES', courseId: COURSE, period: 'Noite' },
        { name: '1ADM', courseId: 'ADM', period: 'Tarde' },
    ];
    db.memory.admins = [{ email: 'admin@hist.local', name: 'Admin', role: 'admin', password: db.hashPassword('senha-admin-ok') }];
    db.memory.adminSessions = { [ADMIN_TOKEN]: { email: 'admin@hist.local', createdAt: Date.now(), lastSeen: Date.now() } };
    db.memory.students = [
        // Matrícula antiga: sem 'desde' (vale "desde sempre"; nada é reescrito no boot).
        { id: 'alu_00000000000000a1', name: 'Ana Souza', email: 'ana@hist.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: COURSE, period: 'Manhã' }], studentClass: '1DES', period: 'Manhã' },
        { id: 'alu_00000000000000b2', name: 'Bia Lima', email: 'bia@hist.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: COURSE, period: 'Manhã', desde: '2026-02-01' }], studentClass: '1DES', period: 'Manhã' },
    ];
    db.memory.auditLogs = [];
    db.memory.submissions = [];
    db.memory.attendance = [];
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

test('[UC-MATRICULA-002] applyClassMembershipChange: continua com o desde, a nova ganha hoje, a que saiu vai para o histórico com o motivo', () => {
    const memory = { classes: [{ name: '1DES', courseId: 'TI', period: 'Manhã', periodoLetivoId: 'per_1' }, { name: '2DES', courseId: 'TI' }, { name: '1ADM', courseId: 'ADM' }, { name: '9X', courseId: 'TI', encerramento: { em: 1, data: '2026-06-20' } }] };
    const before = { courseId: 'TI', classes: [{ name: '1DES', courseId: 'TI', period: 'Manhã', desde: '2026-02-01' }, '1ADM', { name: '9X', courseId: 'TI' }] };
    const isClosed = cls => !!(cls && cls.encerramento);
    // Sai da 1DES e entra na 2DES (mesmo curso): mudou de turma. 1ADM (texto antigo) continua.
    // 9X encerrada sai: a matrícula terminou com o encerramento (ate = a data dele).
    const change = enrollmentHistory.applyClassMembershipChange(memory, before, ['1ADM', { name: '2DES', courseId: 'TI' }], { today: '2026-06-30', isClosed });
    assert.deepEqual(change.classes, ['1ADM', { name: '2DES', courseId: 'TI', desde: '2026-06-30' }]);
    assert.deepEqual(change.added, [{ name: '2DES', courseId: 'TI' }]);
    assert.deepEqual(change.historicoMatriculas, [
        { schemaVersion: 1, courseId: 'TI', name: '1DES', ate: '2026-06-30', motivo: 'mudou_de_turma', period: 'Manhã', periodoLetivoId: 'per_1', desde: '2026-02-01', paraTurma: '2DES' },
        { schemaVersion: 1, courseId: 'TI', name: '9X', ate: '2026-06-20', motivo: 'turma_encerrada' },
    ]);
    // Nada mudou: o histórico não ganha campo vazio.
    const same = enrollmentHistory.applyClassMembershipChange(memory, { classes: ['1ADM'] }, ['1ADM'], { today: '2026-06-30' });
    assert.equal(same.historicoMatriculas, undefined);
    assert.deepEqual(same.classes, ['1ADM']);
    // Sem data de hoje válida, não inventa datas.
    const noDate = enrollmentHistory.applyClassMembershipChange(memory, before, [], { today: 'ontem' });
    assert.equal(noDate.historicoMatriculas, undefined);
    // Leitura para a tela: atuais com desde e encerradas da mais nova para a mais antiga.
    const view = enrollmentHistory.enrollmentHistoryView({ courses: [{ id: 'TI', name: 'Informática' }] }, { classes: change.classes, historicoMatriculas: change.historicoMatriculas });
    assert.deepEqual(view.atuais.map(item => [item.turma, item.desde]), [['1ADM', null], ['2DES', '2026-06-30']]);
    assert.deepEqual(view.encerradas.map(item => [item.turma, item.motivoRotulo]), [['1DES', 'Mudou de turma'], ['9X', 'Turma encerrada']], 'da que terminou por último para a primeira');
    assert.equal(view.encerradas[1].curso, 'Informática');
});

test('[UC-MATRICULA-002] ficha do aluno: trocar de turma grava o histórico; a matrícula que continua guarda o desde', async () => {
    const today = settingsUtil.today();
    const res = await admin('post', '/api/admin/student/update').send({
        originalEmail: 'bia@hist.local', name: 'Bia Lima', email: 'bia@hist.local', status: 'Ativo',
        classes: [{ name: '1DES', courseId: COURSE, period: 'Manhã' }, { name: '1ADM', courseId: 'ADM', period: 'Tarde' }],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(student('bia@hist.local').classes, [
        { name: '1DES', courseId: COURSE, period: 'Manhã', desde: '2026-02-01' },
        { name: '1ADM', courseId: 'ADM', period: 'Tarde', desde: today },
    ]);
    assert.equal(student('bia@hist.local').historicoMatriculas, undefined);

    const moved = await admin('post', '/api/admin/student/update').send({
        originalEmail: 'bia@hist.local', name: 'Bia Lima', email: 'bia@hist.local', status: 'Ativo',
        classes: [{ name: '2DES', courseId: COURSE, period: 'Noite' }, { name: '1ADM', courseId: 'ADM', period: 'Tarde' }],
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const bia = student('bia@hist.local');
    assert.deepEqual(bia.classes, [{ name: '2DES', courseId: COURSE, period: 'Noite', desde: today }, { name: '1ADM', courseId: 'ADM', period: 'Tarde', desde: today }]);
    assert.deepEqual(bia.historicoMatriculas, [{ schemaVersion: 1, courseId: COURSE, name: '1DES', ate: today, motivo: 'mudou_de_turma', period: 'Manhã', desde: '2026-02-01', paraTurma: '2DES' }]);
    // Só tirar da turma: 'removido'.
    await admin('post', '/api/admin/student/update').send({
        originalEmail: 'bia@hist.local', name: 'Bia Lima', email: 'bia@hist.local', status: 'Ativo', classes: [{ name: '2DES', courseId: COURSE, period: 'Noite' }],
    }).expect(200);
    assert.deepEqual(student('bia@hist.local').historicoMatriculas.map(item => [item.name, item.motivo]), [['1DES', 'mudou_de_turma'], ['1ADM', 'removido']]);
});

test('[UC-MATRICULA-002] cadastro, matrícula em lote e aprovação de matrícula dão desde à turma nova', async () => {
    const today = settingsUtil.today();
    const created = await admin('post', '/api/admin/student/create').send({ name: 'Caio Dias', email: 'caio@hist.local', courseId: COURSE, classes: [{ name: '1DES', courseId: COURSE, period: 'Manhã' }] });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(student('caio@hist.local').classes[0].desde, today);

    const bulk = await admin('post', '/api/admin/student/bulk-enroll').send({ emails: ['ana@hist.local'], className: '2DES', courseId: COURSE });
    assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
    assert.deepEqual(student('ana@hist.local').classes, [{ name: '1DES', courseId: COURSE, period: 'Manhã' }, { name: '2DES', courseId: COURSE, period: 'Noite', desde: today }]);

    db.memory.students.push({ id: 'alu_00000000000000d4', name: 'Duda', email: 'duda@hist.local', status: 'Ativo', password: db.hashPassword('123'), classes: [],
        enrollmentRequests: [{ id: 'req_1', courseId: COURSE, requestedClassName: '1DES', status: 'pending', createdAt: Date.now() }] });
    const approved = await admin('post', '/api/admin/enrollment-requests/req_1/approve').send({ className: '1DES' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.deepEqual(student('duda@hist.local').classes, [{ name: '1DES', courseId: COURSE, period: 'Manhã', desde: today }]);
});

test('[UC-MATRICULA-002] desligar (bulk-status e ficha) guarda as matrículas no histórico sem tirar da turma; reativar começa outra', async () => {
    const today = settingsUtil.today();
    const closed = await admin('post', '/api/admin/student/bulk-status').send({ emails: ['bia@hist.local'], status: 'Concluído', reason: 'formou' });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    let bia = student('bia@hist.local');
    assert.deepEqual(bia.classes, [{ name: '1DES', courseId: COURSE, period: 'Manhã', desde: '2026-02-01' }], 'continua na turma (chamada e notas antigas)');
    assert.deepEqual(bia.historicoMatriculas, [{ schemaVersion: 1, courseId: COURSE, name: '1DES', ate: today, motivo: 'concluido', period: 'Manhã', desde: '2026-02-01' }]);

    const reopened = await admin('post', '/api/admin/student/bulk-status').send({ emails: ['bia@hist.local'], status: 'Ativo' });
    assert.equal(reopened.status, 200);
    bia = student('bia@hist.local');
    assert.equal(bia.classes[0].desde, today, 'reativar começa matrícula nova');
    assert.equal(bia.historicoMatriculas.length, 1);

    // Pela ficha: Inativo vira 'desligado'.
    const update = await admin('post', '/api/admin/student/update').send({
        originalEmail: 'ana@hist.local', name: 'Ana Souza', email: 'ana@hist.local', status: 'Inativo', statusReason: 'mudou de cidade',
        classes: [{ name: '1DES', courseId: COURSE, period: 'Manhã' }],
    });
    assert.equal(update.status, 200, JSON.stringify(update.body));
    assert.deepEqual(student('ana@hist.local').historicoMatriculas.map(item => [item.name, item.motivo, item.desde]), [['1DES', 'desligado', undefined]]);
});

test('[UC-MATRICULA-002] Meus dados (aluno e administrador) traz o histórico; anonimizar mantém o histórico sem nome', async () => {
    const today = settingsUtil.today();
    student('bia@hist.local').historicoMatriculas = [{ schemaVersion: 1, courseId: 'ADM', name: '1ADM', desde: '2025-08-01', ate: '2025-12-15', motivo: 'mudou_de_turma', paraTurma: '1DES' }];
    const token = createStudentSession(db.memory, 'bia@hist.local');
    const mine = await request(app).get('/api/student/my-data').set('x-session-token', token);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    const own = mine.body.data || mine.body;
    assert.deepEqual(own.enrollmentHistory, [{ curso: 'Administração', turma: '1ADM', periodoLetivo: null, desde: '2025-08-01', ate: '2025-12-15', motivo: 'Mudou de turma', paraTurma: '1DES' }]);
    assert.ok((own.extraSections || []).some(section => section.key === 'enrollmentHistory' && section.label === 'Histórico de matrículas'), JSON.stringify(own.extraSections));
    const adminExport = await admin('get', '/api/admin/lgpd/students/export?email=bia@hist.local&finalidade=baixar');
    assert.equal(adminExport.status, 200, JSON.stringify(adminExport.body));
    const adminData = adminExport.body.data || adminExport.body;
    assert.equal(adminData.enrollmentHistory.length, 1);
    // Sem histórico, a seção não aparece (o arquivo fica como antes).
    const anaExport = await admin('get', '/api/admin/lgpd/students/export?email=ana@hist.local&finalidade=baixar');
    assert.equal((anaExport.body.data || anaExport.body).enrollmentHistory, undefined);

    // Desligar e anonimizar: o cadastro anonimizado fica com as turmas e o histórico.
    await admin('post', '/api/admin/student/bulk-status').send({ emails: ['bia@hist.local'], status: 'Transferido', reason: 'outra escola' }).expect(200);
    const anon = await admin('post', '/api/admin/students/anonymize').send({ email: 'bia@hist.local', confirm: 'ANONIMIZAR', reason: 'Pedido da família' });
    assert.equal(anon.status, 200, JSON.stringify(anon.body));
    const record = db.memory.students.find(item => item.status === 'Anonimizado');
    assert.ok(record, 'cadastro anonimizado');
    assert.equal(record.name.startsWith('Aluno anonimizado'), true);
    assert.deepEqual(record.historicoMatriculas, [
        { schemaVersion: 1, courseId: 'ADM', name: '1ADM', ate: '2025-12-15', motivo: 'mudou_de_turma', desde: '2025-08-01', paraTurma: '1DES' },
        { schemaVersion: 1, courseId: COURSE, name: '1DES', ate: today, motivo: 'transferido', period: 'Manhã', desde: '2026-02-01' },
    ]);
    assert.equal(JSON.stringify(record.historicoMatriculas).includes('Bia'), false);
});

// Rodada de ajuste 1 do B10 (FUN-05): encerrar a turma termina a matrícula nela. O aluno
// continua na lista de turmas (lê as notas, e reabrir devolve tudo), mas a ficha, Meus dados
// e a contagem mostram a matrícula como terminada na data do encerramento, com o motivo
// 'Turma encerrada'; o fluxo "encerrar e rematricular" (matrícula em lote na turma nova)
// deixa o histórico completo. Falhava antes: a matrícula na turma encerrada ficava "atual"
// para sempre e Meus dados vinha sem a seção.
async function closeClass(name, reason = 'fim do semestre') {
    const res = await admin('post', '/api/admin/class/close').send({ courseId: COURSE, name, confirm: 'ENCERRAR', reason });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
}

test('[UC-MATRICULA-002] encerrar a turma termina a matrícula: Meus dados e a contagem mostram ate = data do encerramento; reabrir devolve', async () => {
    const today = settingsUtil.today();
    const closed = await closeClass('1DES');
    assert.equal(closed.encerramento.data, today, 'o encerramento guarda a data civil');
    assert.equal(db.memory.classes.find(item => item.name === '1DES').encerramento.data, today);

    // Encerrar e rematricular: a Ana vai para a 2DES pela matrícula em lote.
    const bulk = await admin('post', '/api/admin/student/bulk-enroll').send({ emails: ['ana@hist.local'], className: '2DES', courseId: COURSE });
    assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
    const ana = student('ana@hist.local');
    assert.deepEqual(ana.classes.map(item => item.name), ['1DES', '2DES'], 'continua na turma encerrada (lê as notas dela)');
    const view = enrollmentHistory.enrollmentHistoryView(db.memory, ana);
    assert.deepEqual(view.atuais.map(item => [item.turma, item.desde]), [['2DES', today]]);
    assert.deepEqual(view.encerradas.map(item => [item.turma, item.ate, item.motivo]), [['1DES', today, 'turma_encerrada']]);

    const token = createStudentSession(db.memory, 'ana@hist.local');
    const mine = await request(app).get('/api/student/my-data').set('x-session-token', token);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    const own = mine.body.data || mine.body;
    assert.deepEqual(own.enrollmentHistory, [{ curso: 'Informática', turma: '1DES', periodoLetivo: null, desde: null, ate: today, motivo: 'Turma encerrada', paraTurma: null }]);
    const adminExport = await admin('get', '/api/admin/lgpd/students/export?email=bia@hist.local&finalidade=baixar');
    assert.deepEqual((adminExport.body.data || adminExport.body).enrollmentHistory.map(item => [item.turma, item.desde, item.ate, item.motivo]), [['1DES', '2026-02-01', today, 'Turma encerrada']]);
    const { countStudentData } = require('../../backend/utils/studentDataHandlers.js');
    assert.equal(countStudentData(db.memory, { student: student('bia@hist.local') }).historicoMatriculas, 1, 'Cadastros encerrados conta a matrícula encerrada');

    // Reaberta, a matrícula volta a ser atual (nada foi gravado no cadastro).
    const reopened = await admin('post', '/api/admin/class/reopen').send({ courseId: COURSE, name: '1DES', reason: 'nota lançada errada' });
    assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
    assert.equal(student('bia@hist.local').historicoMatriculas, undefined);
    const after = enrollmentHistory.enrollmentHistoryView(db.memory, student('bia@hist.local'));
    assert.deepEqual(after.atuais.map(item => item.turma), ['1DES']);
    assert.deepEqual(after.encerradas, []);
});

test('[UC-MATRICULA-002] sair da turma encerrada ou ser desligado depois do encerramento grava ate = data do encerramento e motivo turma_encerrada', async () => {
    const today = settingsUtil.today();
    await closeClass('1DES');
    // A data do encerramento é a que fica (encerrada "ontem", tirada hoje).
    db.memory.classes.find(item => item.name === '1DES').encerramento.data = '2026-06-30';
    await admin('post', '/api/admin/student/update').send({
        originalEmail: 'bia@hist.local', name: 'Bia Lima', email: 'bia@hist.local', status: 'Ativo', classes: [{ name: '2DES', courseId: COURSE, period: 'Noite' }],
    }).expect(200);
    assert.deepEqual(student('bia@hist.local').historicoMatriculas.map(item => [item.name, item.ate, item.motivo, item.desde]), [['1DES', '2026-06-30', 'turma_encerrada', '2026-02-01']]);
    assert.equal(student('bia@hist.local').classes[0].desde, today);

    // Desligada depois do encerramento: a turma encerrada termina no encerramento; a aberta, hoje.
    db.memory.students.find(item => item.email === 'ana@hist.local').classes.push({ name: '2DES', courseId: COURSE, period: 'Noite', desde: '2026-05-01' });
    await admin('post', '/api/admin/student/bulk-status').send({ emails: ['ana@hist.local'], status: 'Transferido', reason: 'outra escola' }).expect(200);
    const ana = student('ana@hist.local');
    assert.deepEqual(ana.historicoMatriculas.map(item => [item.name, item.ate, item.motivo]), [['1DES', '2026-06-30', 'turma_encerrada'], ['2DES', today, 'transferido']]);
    // Desligada, a leitura não repete a turma encerrada.
    assert.deepEqual(enrollmentHistory.enrollmentHistoryView(db.memory, ana).encerradas.map(item => item.turma).sort(), ['1DES', '2DES']);
});
