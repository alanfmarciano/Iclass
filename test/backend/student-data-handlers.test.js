// Ciclo de vida dos dados do aluno nas coleções novas (backend/utils/studentDataHandlers.js,
// fundação C0b da fase 3; K14 do plano). Cada coleção nova registra um handler, e a troca
// de e-mail, o anonimizar, o apagar de vez, as contagens de Cadastros encerrados, Meus
// dados, a mesclagem (P4-S4) e o religar depois de restaurar (C1) percorrem a lista
// depois dos blocos de hoje. Aqui, com uma coleção de teste ('entregasTeste', com versões
// como as entregas de tarefa do P1). A saída sem handler é a de antes
// (igualdade-c0b.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-student-data-handlers-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const handlers = require('../../backend/utils/studentDataHandlers.js');
const { buildStudentDataExport } = require('../../backend/utils/studentDataExport.js');
const { closedStudentRows } = require('../../backend/utils/studentLifecycle.js');
const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { createAdminSession } = require('../../backend/utils/authSessions.js');

const ADMIN = 'adm@handlers.local';
const ANA = 'ana@handlers.local';
const ANA_OLD = 'ana.antiga@handlers.local';
const BIA = 'bia@handlers.local';
const CAIO = 'caio@handlers.local';
const DAY = 86400000;
const NOW = Date.now();
let app;
const cleanups = [];
const keep = unregister => { cleanups.push(unregister); return unregister; };
const adminHeaders = () => ({ 'x-admin-session': createAdminSession(db.memory, ADMIN) });

function seed() {
    db.memory.config = { ...(db.memory.config || {}), settings: {} };
    db.memory.admins = [{ email: ADMIN, name: 'Administração', role: 'admin', password: 'x' }];
    db.memory.courses = [{ id: 'DES', name: 'Desenvolvimento', structure: [] }];
    db.memory.classes = [{ name: '1DES', courseId: 'DES', status: 'active', releasedItems: {} }];
    const student = (name, email, extra = {}) => ({ name, email, status: 'Ativo', classes: [{ name: '1DES', courseId: 'DES' }], studentClass: '1DES', ...extra });
    db.memory.students = [
        student('Ana Souza', ANA, { matricula: '2026-001' }),
        student('Bia Lima', BIA, { status: 'Inativo', statusChangedAt: NOW - 10 * DAY, statusChangedBy: ADMIN }),
        student('Caio Prado', CAIO, { status: 'Transferido', statusChangedAt: NOW - 5 * DAY, statusChangedBy: ADMIN }),
    ];
    db.memory.submissions = [];
    db.memory.attendance = [];
    db.memory.certificates = [];
    db.memory.auditLogs = [
        { id: 'aud_email', action: 'update', category: 'student', actor: ADMIN, studentEmail: ANA, field: 'E-mail/login', oldValue: ANA_OLD, newValue: ANA, timestamp: NOW - 50 * DAY },
    ];
    db.memory.entregasTeste = [
        { id: 'e1', studentEmail: ANA, tarefa: 't1', texto: 'Trabalho da Ana', timestamp: NOW - 60 * DAY },
        { id: 'e2', studentEmail: ANA_OLD, tarefa: 't2', texto: 'Feito com o e-mail antigo', timestamp: NOW - 60 * DAY },
        { id: 'e3', studentEmail: BIA, tarefa: 't1', texto: 'Trabalho da Bia Lima', timestamp: NOW - 20 * DAY },
        { id: 'e4', studentEmail: CAIO, tarefa: 't1', texto: 'Do Caio', timestamp: NOW - 20 * DAY },
    ];
}

// Handler de teste no formato que as coleções novas vão usar.
function registerTestHandler(extra = {}) {
    const calls = [];
    const owned = (aluno, item) => aluno.owns(item.studentEmail, item, 'renamed');
    keep(handlers.registerStudentDataHandler({
        collection: 'entregasTeste',
        label: 'Entregas de teste',
        rename(memory, de, para) {
            calls.push(['rename', de, para]);
            memory.entregasTeste.forEach(item => { if (item.studentEmail === de) item.studentEmail = para; });
        },
        anonymize(memory, aluno, pseudonimo) {
            calls.push(['anonymize', aluno, pseudonimo]);
            memory.entregasTeste.forEach(item => {
                if (!owned(aluno, item)) return;
                item.studentEmail = pseudonimo.email;
                item.texto = '';
            });
        },
        purge(memory, aluno) {
            calls.push(['purge', aluno]);
            memory.entregasTeste = memory.entregasTeste.filter(item => !owned(aluno, item));
        },
        count: (memory, aluno) => memory.entregasTeste.filter(item => owned(aluno, item)).length,
        exportSection: (memory, aluno, audience) => memory.entregasTeste
            .filter(item => owned(aluno, item))
            .map(item => (audience === 'admin' ? { ...item } : { tarefa: item.tarefa, texto: item.texto })),
        ...extra,
    }));
    return calls;
}

test.before(async () => { await db.init(); app = createApp(); });
test.beforeEach(() => seed());
test.afterEach(() => { while (cleanups.length) cleanups.pop()(); delete db.memory.entregasTeste; });

test('[UC-FUNDACAO-003] registro: coleção e nome obrigatórios, funções de verdade e sem tomar seção de hoje', () => {
    assert.throws(() => handlers.registerStudentDataHandler({ label: 'X' }), /sem collection/);
    assert.throws(() => handlers.registerStudentDataHandler({ collection: 'x' }), /sem label/);
    assert.throws(() => handlers.registerStudentDataHandler({ collection: 'x', label: 'X', rename: 'não' }), /precisa ser função/);
    assert.throws(() => handlers.registerStudentDataHandler({ collection: 'certificates', label: 'Certificados', exportSection: () => [] }), /já existe em Meus dados/);
    assert.throws(() => handlers.registerStudentDataHandler({ collection: 'submissions', label: 'Notas', count: () => 0 }), /já existe/);
    assert.throws(() => handlers.registerStudentDataHandler({ collection: 'nova', label: 'Nova', exportKey: 'forum', exportSection: () => [] }), /já existe em Meus dados/);
    // O B16 passa o certificado ao handler assim.
    keep(handlers.registerStudentDataHandler({ collection: 'certificates', label: 'Certificados', replaceCore: true, exportSection: () => ['novo'] }));
    assert.deepEqual(handlers.studentDataLabels(), { certificates: 'Certificados' });
    // Mesma coleção de novo troca o handler.
    keep(handlers.registerStudentDataHandler({ collection: 'certificates', label: 'Certificados (2)', replaceCore: true }));
    assert.equal(handlers.studentDataHandlers().length, 1);
    assert.equal(handlers.studentDataHandlers()[0].label, 'Certificados (2)');
});

test('[UC-FUNDACAO-003] troca de e-mail do aluno passa pelo handler, depois dos blocos de hoje', async () => {
    const calls = registerTestHandler();
    const response = await request(app).post('/api/admin/student/update').set(adminHeaders()).send({
        originalEmail: CAIO, email: 'Caio.Novo@Handlers.local', name: 'Caio Prado', status: 'Transferido', classes: [{ name: '1DES', courseId: 'DES' }],
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(calls, [['rename', CAIO, 'caio.novo@handlers.local']]);
    assert.equal(db.memory.entregasTeste.find(item => item.id === 'e4').studentEmail, 'caio.novo@handlers.local');
    // Mesmo e-mail (só outra grafia) não chama o handler.
    calls.length = 0;
    handlers.renameStudentData(db.memory, 'X@a.local', 'x@A.local');
    assert.deepEqual(calls, []);
});

test('[UC-FUNDACAO-003] anonimizar: o handler recebe o aluno com os e-mails dele e o pseudônimo, e a contagem entra no resultado e na auditoria', async () => {
    const calls = registerTestHandler();
    const response = await request(app).post('/api/admin/students/anonymize').set(adminHeaders())
        .send({ email: BIA, confirm: 'ANONIMIZAR', reason: 'Pedido da família' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.kept.entregasTeste, 1);
    assert.deepEqual(Object.keys(response.body.kept), ['submissions', 'attendance', 'certificates', 'entregasTeste']);
    assert.equal(calls.length, 1);
    const [, aluno, pseudonimo] = calls[0];
    assert.equal(aluno.email, BIA);
    assert.equal(aluno.student.name, 'Bia Lima', 'o cadastro como estava antes');
    assert.deepEqual(aluno.emails, [BIA]);
    assert.equal(pseudonimo.email, response.body.email);
    const record = db.memory.entregasTeste.find(item => item.id === 'e3');
    assert.equal(record.studentEmail, response.body.email);
    assert.equal(record.texto, '');
    const audit = db.memory.auditLogs.find(entry => entry.action === 'student_anonymized');
    assert.equal(audit.details.kept.entregasTeste, 1);
});

test('[UC-FUNDACAO-003] apagar de vez: o handler tira os registros do aluno, inclusive os do e-mail que ele usava antes', async () => {
    const calls = registerTestHandler();
    db.memory.students[0].status = 'Inativo';
    db.memory.students[0].statusChangedAt = NOW - DAY;
    const response = await request(app).post('/api/admin/students/purge').set(adminHeaders())
        .send({ email: ANA, confirm: 'APAGAR', reason: 'Pedido da titular' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.removed.entregasTeste, 2);
    assert.deepEqual(calls.map(call => call[0]), ['purge']);
    assert.deepEqual(calls[0][1].emails.sort(), [ANA_OLD, ANA].sort());
    assert.deepEqual(db.memory.entregasTeste.map(item => item.id), ['e3', 'e4']);
    const audit = db.memory.auditLogs.find(entry => entry.action === 'student_purged');
    assert.equal(audit.details.removed.entregasTeste, 2);
});

test('[UC-FUNDACAO-003] Cadastros encerrados e Meus dados trazem a coleção nova (versão do aluno e do administrador)', async () => {
    registerTestHandler();
    const rows = closedStudentRows(db.memory, { sinceOf: student => student.statusChangedAt || null });
    assert.deepEqual(rows.map(row => [row.email, row.counts]), [
        [BIA, { submissions: 0, attendance: 0, certificates: 0, entregasTeste: 1 }],
        [CAIO, { submissions: 0, attendance: 0, certificates: 0, entregasTeste: 1 }],
    ]);
    const route = await request(app).get('/api/admin/students/closed').set(adminHeaders());
    assert.equal(route.body.items[0].counts.entregasTeste, 1);

    const forStudent = buildStudentDataExport(db.memory, ANA, { audience: 'aluno', now: NOW });
    assert.deepEqual(forStudent.entregasTeste, [{ tarefa: 't1', texto: 'Trabalho da Ana' }, { tarefa: 't2', texto: 'Feito com o e-mail antigo' }]);
    assert.equal(forStudent.counts.entregasTeste, 2);
    const keys = Object.keys(forStudent);
    assert.ok(keys.indexOf('entregasTeste') > keys.indexOf('profileHistory') && keys.indexOf('entregasTeste') < keys.indexOf('examTitles'), keys.join(', '));
    const forAdmin = buildStudentDataExport(db.memory, ANA, { audience: 'admin', now: NOW });
    assert.equal(forAdmin.entregasTeste[0].id, 'e1');
    assert.ok(Object.keys(forAdmin).indexOf('entregasTeste') > Object.keys(forAdmin).indexOf('audit'));
    // Seção undefined fica de fora (e sem contagem).
    cleanups.pop()();
    keep(handlers.registerStudentDataHandler({ collection: 'entregasTeste', label: 'Entregas de teste', exportSection: () => undefined }));
    const without = buildStudentDataExport(db.memory, ANA, { audience: 'aluno', now: NOW });
    assert.ok(!('entregasTeste' in without));
    assert.ok(!('entregasTeste' in without.counts));
});

test('[UC-FUNDACAO-003] religar pelo e-mail: registro com id de aluno que não existe (ou sem id) ganha o id do aluno do mesmo e-mail', () => {
    db.memory.students[0].id = 'alu_0000000000000001';
    db.memory.students[1].id = 'alu_0000000000000002';
    db.memory.entregasTeste = [
        { id: 'a', studentEmail: ANA, studentId: 'alu_velho0000000000' },
        { id: 'b', studentEmail: 'BIA@handlers.local' },
        { id: 'c', studentEmail: ANA, studentId: 'alu_0000000000000002' }, // id que existe: fica
        { id: 'd', studentEmail: 'ninguem@handlers.local', studentId: 'alu_x' },
    ];
    keep(handlers.registerStudentDataHandler({
        collection: 'entregasTeste',
        label: 'Entregas de teste',
        relink: (memory, idsPorEmail) => handlers.relinkRecordsByEmail(memory, memory.entregasTeste, idsPorEmail),
    }));
    const ids = { [ANA]: 'alu_0000000000000001', 'Bia@Handlers.local': 'alu_0000000000000002' };
    assert.equal(handlers.relinkStudentData(db.memory, ids), true);
    assert.deepEqual(db.memory.entregasTeste.map(item => item.studentId), ['alu_0000000000000001', 'alu_0000000000000002', 'alu_0000000000000002', 'alu_x']);
    assert.equal(handlers.relinkStudentData(db.memory, new Map(Object.entries(ids))), false, 'idempotente');
});

test('[UC-FUNDACAO-003] mesclar: entrega na mesma tarefa junta as versões no registro que fica, sem linha repetida', () => {
    const fica = { email: ANA, id: 'alu_fica' };
    const sai = { email: BIA, id: 'alu_sai' };
    const records = [
        { id: 'f1', studentEmail: ANA, tarefa: 't1', grade: 90, versions: [{ n: 1, requestAt: 300 }, { n: 2, requestAt: 500 }] },
        { id: 's1', studentEmail: BIA, tarefa: 't1', grade: 40, versions: [{ n: 1, requestAt: 100 }, { n: 2, requestAt: 400 }] },
        { id: 's2', studentEmail: BIA, tarefa: 't2', grade: 70, versions: [{ n: 1, requestAt: 200 }] },
        { id: 's3', studentEmail: BIA, tarefa: 't2', versions: [{ n: 1, requestAt: 250 }] }, // repetida antes da mesclagem
        { id: 'o1', studentEmail: CAIO, tarefa: 't1', versions: [] },
    ];
    const result = handlers.mergeOwnedRecords(records, {
        isFica: item => item.studentEmail === fica.email,
        isSai: item => item.studentEmail === sai.email,
        keyOf: item => item.tarefa,
        reassign: item => { item.studentEmail = fica.email; item.studentId = fica.id; },
        versions: { field: 'versions', orderBy: 'requestAt', number: 'n' },
        summary: item => ({ grade: item.grade === undefined ? null : item.grade }),
        origin: { studentEmail: sai.email, studentId: sai.id },
        at: 1000,
    });
    assert.deepEqual(result.records.map(item => item.id), ['f1', 's2', 'o1']);
    assert.deepEqual({ moved: result.moved, joined: result.joined, archived: result.archived }, { moved: 1, joined: 2, archived: 0 });
    const f1 = result.records[0];
    assert.equal(f1.grade, 90, 'a nota do que fica vale');
    assert.deepEqual(f1.versions.map(version => [version.n, version.requestAt]), [[1, 100], [2, 300], [3, 400], [4, 500]]);
    assert.deepEqual(f1.mergedFrom, [{ studentEmail: BIA, studentId: 'alu_sai', recordId: 's1', at: 1000, grade: 40 }]);
    const s2 = result.records[1];
    assert.equal(s2.studentEmail, ANA);
    assert.equal(s2.studentId, 'alu_fica');
    assert.deepEqual(s2.versions.map(version => [version.n, version.requestAt]), [[1, 200], [2, 250]]);
    assert.deepEqual(s2.mergedFrom, [{ studentEmail: BIA, studentId: 'alu_sai', recordId: 's3', at: 1000, grade: null }]);
    assert.equal(result.records[2].studentEmail, CAIO, 'o registro de outro aluno não muda');
});

test('[UC-FUNDACAO-003] mesclar sem versões: o registro repetido do que sai muda de dono e fica arquivado com mergedFrom', () => {
    const records = [
        { id: 'g1', membro: ANA, grupo: 'g' },
        { id: 'g2', membro: BIA, grupo: 'g' },
        { id: 'g3', membro: BIA, grupo: 'h' },
        { id: 'g4', membro: BIA },
    ];
    const result = handlers.mergeOwnedRecords(records, {
        isFica: item => item.membro === ANA,
        isSai: item => item.membro === BIA,
        keyOf: item => item.grupo,
        reassign: item => { item.membro = ANA; },
        origin: { studentEmail: 'BIA@handlers.local' },
        at: 2000,
    });
    assert.equal(result.records, records, 'nenhuma linha sai');
    assert.deepEqual({ moved: result.moved, joined: result.joined, archived: result.archived }, { moved: 2, joined: 0, archived: 1 });
    assert.deepEqual(records[1], { id: 'g2', membro: ANA, grupo: 'g', archived: true, archivedAt: 2000, mergedFrom: [{ studentEmail: BIA, studentId: null, recordId: 'g2', at: 2000 }] });
    assert.deepEqual(records[2], { id: 'g3', membro: ANA, grupo: 'h' });
    assert.deepEqual(records[3], { id: 'g4', membro: ANA });
    assert.throws(() => handlers.mergeOwnedRecords(records, {}), /obrigatórios/);
});

test('[UC-FUNDACAO-003] mesclar percorre os handlers com merge, na ordem de registro', () => {
    const order = [];
    keep(handlers.registerStudentDataHandler({ collection: 'a', label: 'A', merge: (memory, fica, sai) => order.push(['a', fica.email, sai.email]) }));
    keep(handlers.registerStudentDataHandler({ collection: 'b', label: 'B' }));
    keep(handlers.registerStudentDataHandler({ collection: 'c', label: 'C', merge: () => order.push(['c']) }));
    const fica = handlers.studentDataContext(db.memory, ANA);
    const sai = handlers.studentDataContext(db.memory, db.memory.students[1]);
    handlers.mergeStudentData(db.memory, fica, sai);
    assert.deepEqual(order, [['a', ANA, BIA], ['c']]);
    assert.equal(handlers.studentDataContext(db.memory, 'ninguem@handlers.local'), null);
    assert.deepEqual(fica.emails.sort(), [ANA_OLD, ANA].sort());
    assert.equal(fica.owns(ANA_OLD, { timestamp: NOW - 60 * DAY }, 'renamed'), true);
});
