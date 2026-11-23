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
    // Seção de hoje trocada por replaceCore já tem nome na tela: fica fora de extraSections.
    assert.deepEqual(handlers.studentDataSectionsMeta({ certificates: ['novo'] }), []);
    assert.throws(() => handlers.registerStudentDataHandler({ collection: 'y', label: 'Y', printColumns: [] }), /lista de colunas/);
    assert.throws(() => handlers.registerStudentDataHandler({ collection: 'y', label: 'Y', printColumns: [{ field: 'a' }] }), /sem field ou label/);
    assert.throws(() => handlers.registerStudentDataHandler({ collection: 'y', label: 'Y', printColumns: [{ field: 'a', label: 'A', format: 'cor' }] }), /formato 'cor'/);
    assert.throws(() => handlers.registerStudentDataHandler({ collection: 'nova', label: 'Nova', exportKey: 'extraSections', exportSection: () => [] }), /já existe em Meus dados/);
    // Mesma coleção de novo troca o handler.
    keep(handlers.registerStudentDataHandler({ collection: 'certificates', label: 'Certificados (2)', replaceCore: true }));
    // Conta só os desta coleção: os módulos das trilhas já registram os deles ao carregar
    // (examParticipation do P3-S7, em utils/examParticipants.js).
    const certificateHandlers = handlers.studentDataHandlers().filter(handler => handler.collection === 'certificates');
    assert.equal(certificateHandlers.length, 1);
    assert.equal(certificateHandlers[0].label, 'Certificados (2)');
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
    // C10 (P1-h) e C12 (P5-S4): os handlers de Trabalhos entregues (assignmentSubmissions) e
    // de Grupos de alunos (classGroups) agora ficam sempre registrados (classGroups carrega
    // antes, pelo middlewares.js).
    assert.deepEqual(Object.keys(response.body.kept), ['submissions', 'attendance', 'certificates', 'classGroups', 'assignmentSubmissions', 'entregasTeste']);
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
    // C10 (P1-h): o handler de Trabalhos entregues (assignmentSubmissions) agora fica sempre registrado.
    assert.deepEqual(rows.map(row => [row.email, row.counts]), [
        [BIA, { submissions: 0, attendance: 0, certificates: 0, assignmentSubmissions: 0, classGroups: 0, entregasTeste: 1 }],
        [CAIO, { submissions: 0, attendance: 0, certificates: 0, assignmentSubmissions: 0, classGroups: 0, entregasTeste: 1 }],
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

test('[UC-FUNDACAO-003] Meus dados leva o nome e as colunas da seção nova (extraSections); Cadastros encerrados leva o nome da contagem (countLabels)', async () => {
    registerTestHandler({ printColumns: [{ field: 'tarefa', label: 'Tarefa' }, { field: 'texto', label: 'Texto', format: 'text' }] });
    const forStudent = buildStudentDataExport(db.memory, ANA, { audience: 'aluno', now: NOW });
    assert.deepEqual(forStudent.extraSections, [{ key: 'entregasTeste', label: 'Entregas de teste', columns: [
        { field: 'tarefa', label: 'Tarefa', format: 'text' }, { field: 'texto', label: 'Texto', format: 'text' },
    ] }]);
    const keys = Object.keys(forStudent);
    assert.equal(keys.indexOf('extraSections'), keys.indexOf('entregasTeste') + 1);
    assert.ok(!('extraSections' in forStudent.counts));
    const route = await request(app).get('/api/admin/students/closed').set(adminHeaders());
    // C10 (P1-h): o handler de Trabalhos entregues (assignmentSubmissions) agora fica sempre registrado.
    assert.deepEqual(route.body.countLabels, { assignmentSubmissions: 'Trabalhos entregues', classGroups: 'Grupos de alunos', entregasTeste: 'Entregas de teste' });
    // Sem o handler de teste, a seção dele some. O de Trabalhos entregues segue: sem tarefas
    // na base, não gera seção em Meus dados, mas a contagem dele tem nome em Cadastros encerrados.
    while (cleanups.length) cleanups.pop()();
    assert.ok(!('extraSections' in buildStudentDataExport(db.memory, ANA, { audience: 'aluno', now: NOW })));
    const plain = await request(app).get('/api/admin/students/closed').set(adminHeaders());
    assert.deepEqual(plain.body.countLabels, { assignmentSubmissions: 'Trabalhos entregues', classGroups: 'Grupos de alunos' });
});

test('[UC-FUNDACAO-003] contagem com replaceCore substitui a de hoje igual em Cadastros encerrados, no anonimizar e no apagar', async () => {
    db.memory.certificates = [{ id: 'c1', studentEmail: BIA, code: 'IC-1' }, { id: 'c2', studentEmail: CAIO, code: 'IC-2' }];
    // Como o B16 vai contar o certificado: pelo handler, no lugar da contagem de hoje.
    keep(handlers.registerStudentDataHandler({
        collection: 'certificates',
        label: 'Certificados',
        replaceCore: true,
        count: (memory, aluno) => (memory.certificates || []).filter(item => aluno.owns(item.studentEmail, item, 'renamed')).length,
    }));
    const rows = closedStudentRows(db.memory, { sinceOf: student => student.statusChangedAt || null });
    assert.deepEqual(rows.map(row => [row.email, row.counts]), [
        [BIA, { submissions: 0, attendance: 0, certificates: 1, assignmentSubmissions: 0, classGroups: 0 }],
        [CAIO, { submissions: 0, attendance: 0, certificates: 1, assignmentSubmissions: 0, classGroups: 0 }],
    ]);
    const route = await request(app).get('/api/admin/students/closed').set(adminHeaders());
    // C10 (P1-h): o handler de Trabalhos entregues (assignmentSubmissions) agora fica sempre registrado.
    assert.deepEqual(route.body.countLabels, { assignmentSubmissions: 'Trabalhos entregues', classGroups: 'Grupos de alunos' }, 'a contagem de hoje (certificados) já tem nome na tela');
    const anonymized = await request(app).post('/api/admin/students/anonymize').set(adminHeaders())
        .send({ email: BIA, confirm: 'ANONIMIZAR', reason: 'Pedido da família' });
    assert.equal(anonymized.status, 200, JSON.stringify(anonymized.body));
    assert.equal(anonymized.body.kept.certificates, 1);
    const purged = await request(app).post('/api/admin/students/purge').set(adminHeaders())
        .send({ email: CAIO, confirm: 'APAGAR', reason: 'Pedido do titular' });
    assert.equal(purged.status, 200, JSON.stringify(purged.body));
    assert.equal(purged.body.removed.certificates, 1);
});

test('[UC-FUNDACAO-003] handler que falha no anonimizar ou no apagar: a memória volta inteira, nada é gravado e o pedido é recusado', async () => {
    db.memory.submissions = [{ id: 's1', examKey: 'P1', score: 70, student: { name: 'Bia Lima', email: BIA, studentClass: '1DES', courseId: 'DES' }, timestamp: new Date(NOW - 15 * DAY).toISOString() }];
    db.memory.attendance = [{ id: 'a1', studentEmail: CAIO, date: '2026-10-01', studentClass: '1DES', courseId: 'DES', aulas: [] }];
    db.memory.sessions[BIA] = { token: 'x', createdAt: NOW };
    const savesBefore = [];
    const originalSave = db.save;
    db.save = (...args) => { savesBefore.push(args); return originalSave.apply(db, args); };
    try {
        registerTestHandler();
        // Um handler depois do de teste, que falha: o de teste já mudou entregasTeste.
        keep(handlers.registerStudentDataHandler({
            collection: 'quebra',
            label: 'Quebra',
            anonymize() { throw new Error('falha de propósito'); },
            purge() { throw new Error('falha de propósito'); },
        }));
        const before = structuredClone(Object.fromEntries(Object.entries(db.memory).filter(([, value]) => typeof value !== 'function')));
        const anonymized = await request(app).post('/api/admin/students/anonymize').set(adminHeaders())
            .send({ email: BIA, confirm: 'ANONIMIZAR', reason: 'Pedido da família' });
        assert.equal(anonymized.status, 500, JSON.stringify(anonymized.body));
        assert.equal(anonymized.body.code, 'student_data_handler_failed');
        assert.match(anonymized.body.error, /Nada foi alterado/);
        assert.deepEqual(db.memory.students, before.students, 'o cadastro não ficou no pseudônimo');
        assert.deepEqual(db.memory.submissions, before.submissions, 'as notas não ficaram no pseudônimo');
        assert.deepEqual(db.memory.entregasTeste, before.entregasTeste, 'o que o handler anterior mudou também voltou');
        assert.deepEqual(db.memory.sessions, before.sessions);
        assert.ok(!db.memory.auditLogs.some(entry => entry.action === 'student_anonymized'));

        const purged = await request(app).post('/api/admin/students/purge').set(adminHeaders())
            .send({ email: CAIO, confirm: 'APAGAR', reason: 'Pedido do titular' });
        assert.equal(purged.status, 500, JSON.stringify(purged.body));
        assert.match(purged.body.error, /Não foi possível apagar/);
        assert.deepEqual(db.memory.students, before.students);
        assert.deepEqual(db.memory.attendance, before.attendance);
        assert.deepEqual(db.memory.entregasTeste, before.entregasTeste);
        assert.ok(!db.memory.auditLogs.some(entry => entry.action === 'student_purged'));
        assert.equal(savesBefore.length, 0, 'nada foi gravado');

        // Sem o handler que falha, o mesmo pedido passa.
        cleanups.pop()();
        const again = await request(app).post('/api/admin/students/anonymize').set(adminHeaders())
            .send({ email: BIA, confirm: 'ANONIMIZAR', reason: 'Pedido da família' });
        assert.equal(again.status, 200, JSON.stringify(again.body));
    } finally {
        db.save = originalSave;
        delete db.memory.sessions[BIA];
    }
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
    // As versões do que sai entram ANTES das do que fica (entre si por requestAt), mesmo a
    // de 400, mais nova que a 300 do que fica: a versão atual continua a do que fica (500).
    assert.deepEqual(f1.versions.map(version => [version.n, version.requestAt]), [[1, 100], [2, 400], [3, 300], [4, 500]]);
    assert.deepEqual(f1.mergedFrom, [{ studentEmail: BIA, studentId: 'alu_sai', recordId: 's1', at: 1000, grade: 40 }]);
    const s2 = result.records[1];
    assert.equal(s2.studentEmail, ANA);
    assert.equal(s2.studentId, 'alu_fica');
    assert.deepEqual(s2.versions.map(version => [version.n, version.requestAt]), [[1, 200], [2, 250]]);
    assert.deepEqual(s2.mergedFrom, [{ studentEmail: BIA, studentId: 'alu_sai', recordId: 's3', at: 1000, grade: null }]);
    assert.equal(result.records[2].studentEmail, CAIO, 'o registro de outro aluno não muda');
});

test('[UC-FUNDACAO-003] mesclar: versão do que sai mais nova que a do que fica não vira a atual nem leva a nota do que fica', () => {
    const records = [
        { id: 'fica', studentEmail: ANA, tarefa: 't1', grade: 90, versions: [{ requestAt: 100, file: 'f1' }] },
        { id: 'sai', studentEmail: BIA, tarefa: 't1', grade: 30, versions: [{ requestAt: 200, file: 's-new' }, { requestAt: 50, file: 's-old' }] },
    ];
    const result = handlers.mergeOwnedRecords(records, {
        isFica: item => item.studentEmail === ANA,
        isSai: item => item.studentEmail === BIA,
        keyOf: item => item.tarefa,
        reassign: item => { item.studentEmail = ANA; },
        versions: { field: 'versions', orderBy: 'requestAt', number: 'n' },
        summary: item => ({ grade: item.grade }),
        origin: { studentEmail: BIA },
        at: 3000,
    });
    assert.deepEqual(result.records.map(item => item.id), ['fica']);
    const [fica] = result.records;
    assert.deepEqual(fica.versions.map(version => [version.n, version.file]), [[1, 's-old'], [2, 's-new'], [3, 'f1']]);
    assert.equal(fica.versions[fica.versions.length - 1].file, 'f1', 'a versão atual é a do que fica');
    assert.equal(fica.grade, 90);
    assert.deepEqual(fica.mergedFrom, [{ studentEmail: BIA, studentId: null, recordId: 'sai', at: 3000, grade: 30 }]);
});

test('[UC-FUNDACAO-003] mesclar: duas entregas do que sai na tarefa em que o que fica tem uma, versões do que sai entre si por requestAt', () => {
    const options = {
        isFica: item => item.owner === 'fica',
        isSai: item => item.owner === 'sai',
        keyOf: item => item.k,
        reassign: item => { item.owner = 'fica'; },
        versions: { field: 'v', orderBy: 'requestAt', number: 'n' },
        summary: item => ({ id: item.id }),
        origin: { studentEmail: BIA },
        at: 4000,
    };
    const records = [
        { id: 'f', owner: 'fica', k: 't1', v: [{ requestAt: 300 }] },
        { id: 's1', owner: 'sai', k: 't1', v: [{ requestAt: 100 }] },
        { id: 's2', owner: 'sai', k: 't1', v: [{ requestAt: 50 }, { requestAt: 120 }] },
    ];
    const result = handlers.mergeOwnedRecords(records, options);
    assert.deepEqual(result.records.map(item => item.id), ['f']);
    assert.deepEqual({ moved: result.moved, joined: result.joined, archived: result.archived }, { moved: 0, joined: 2, archived: 0 });
    const [fica] = result.records;
    assert.deepEqual(fica.v.map(version => [version.n, version.requestAt]), [[1, 50], [2, 100], [3, 120], [4, 300]]);
    assert.deepEqual(fica.mergedFrom.map(entry => entry.recordId), ['s1', 's2']);
    // O caso do revisor: fica [300], sai [50] e sai [100], em qualquer ordem na lista.
    const again = [
        { id: 'f', owner: 'fica', k: 't1', v: [{ requestAt: 300 }] },
        { id: 's1', owner: 'sai', k: 't1', v: [{ requestAt: 50 }] },
        { id: 's2', owner: 'sai', k: 't1', v: [{ requestAt: 100 }] },
    ];
    assert.deepEqual(handlers.mergeOwnedRecords(again, options).records[0].v.map(version => version.requestAt), [50, 100, 300]);
    const reversed = [
        { id: 's2', owner: 'sai', k: 't1', v: [{ requestAt: 100 }] },
        { id: 'f', owner: 'fica', k: 't1', v: [{ requestAt: 300 }] },
        { id: 's1', owner: 'sai', k: 't1', v: [{ requestAt: 50 }] },
    ];
    assert.deepEqual(handlers.mergeOwnedRecords(reversed, options).records[0].v.map(version => version.requestAt), [50, 100, 300]);
    // Três entregas do que sai, sem entrega do que fica: uma só, todas por requestAt.
    const onlySai = [
        { id: 's1', owner: 'sai', k: 't2', v: [{ requestAt: 90 }] },
        { id: 's2', owner: 'sai', k: 't2', v: [{ requestAt: 30 }] },
        { id: 's3', owner: 'sai', k: 't2', v: [{ requestAt: 60 }] },
    ];
    const single = handlers.mergeOwnedRecords(onlySai, options);
    assert.deepEqual(single.records.map(item => item.id), ['s1']);
    assert.deepEqual(single.records[0].v.map(version => [version.n, version.requestAt]), [[1, 30], [2, 60], [3, 90]]);
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
