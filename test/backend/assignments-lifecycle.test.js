// Ciclo de vida das entregas de tarefa (fase 3, C10 / P1-h; FUN-01, D4 e D14 do P1;
// contrato ciclo_de_vida_do_aluno do plano). Antes deste caso, anonimizar e apagar de vez
// o aluno não tocavam as entregas de tarefa (o texto, o link, o IP, o comentário e o nome
// dos arquivos ficavam com o pseudônimo ou sem dono, e os arquivos ficavam em
// data/entregas), a troca de e-mail deixava a entrega no e-mail antigo, Meus dados não
// trazia as tarefas, Cadastros encerrados não as contava, e excluir o curso de vez
// deixava tarefas e entregas no banco, sem curso. Confere tudo isso, as lápides do
// espelho e a volta do curso restaurado.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-assignments-lifecycle-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const runtimePaths = require('../../backend/runtimePaths.js');
const assignments = require('../../backend/utils/assignments.js');
const assignmentFiles = require('../../backend/utils/assignmentFiles.js');
const assignmentLifecycle = require('../../backend/utils/assignmentLifecycle.js');
const studentData = require('../../backend/utils/studentDataHandlers.js');
const fileStore = require('../../backend/utils/storage.js');
const { studentEmailOwnership } = require('../../backend/utils/gradebook.js');
const { createAdminSession, createStudentSession } = require('../../backend/utils/authSessions.js');
const { createApp } = require('../../backend/server.js');

const COURSE = 'curso-ciclo';
const OTHER_COURSE = 'curso-outro';
const CLASS = '1CIC';
const ANA = 'ana.souza@ciclo.local';
const BIA = 'bia@ciclo.local';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(256, 0x20), Buffer.from('\n%%EOF\n')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const tokens = {};
let app;

const asAdmin = req => req.set('x-admin-session', tokens.admin);
const asStudent = (email, req) => req.set('x-session-token', tokens[email]);
const audits = action => (db.memory.auditLogs || []).filter(entry => entry.action === action);

function seed() {
    db.memory.config = { ...(db.memory.config || {}), settings: { timezone: 'America/Sao_Paulo' } };
    db.memory.courses = [
        { id: COURSE, name: 'Curso do ciclo', structure: [] },
        { id: OTHER_COURSE, name: 'Outro curso', structure: [] },
    ];
    db.memory.classes = [{ name: CLASS, courseId: COURSE, period: 'Manhã' }, { name: '2OUT', courseId: OTHER_COURSE, period: 'Tarde' }];
    db.memory.students = [
        { id: 'alu_00000000000000a1', name: 'Ana Souza Lima', email: ANA, matricula: 'MAT-4455', status: 'Transferido', statusChangedAt: Date.now() - DAY, password: db.hashPassword('Senha-forte-123'), classes: [{ name: CLASS, courseId: COURSE }] },
        { id: 'alu_00000000000000b2', name: 'Bia Rocha', email: BIA, matricula: 'MAT-5566', status: 'Ativo', password: db.hashPassword('Senha-forte-123'), classes: [{ name: CLASS, courseId: COURSE }] },
    ];
    db.memory.admins = [{ email: 'adm@ciclo.local', name: 'Administração', role: 'admin', password: db.hashPassword('Senha-forte-2026') }];
    db.memory.adminSessions = {};
    db.memory.sessions = {};
    db.memory.assignments = [];
    db.memory.assignmentSubmissions = [];
    db.memory.assignmentFileTombstones = [];
    db.memory.auditLogs = [];
    db.memory.submissions = [];
    db.memory.attendance = [];
    db.memory.certificates = [];
    tokens.admin = createAdminSession(db.memory, 'adm@ciclo.local');
    tokens[BIA] = createStudentSession(db.memory, BIA);
    fs.rmSync(runtimePaths.ASSIGNMENT_FILES_DIR, { recursive: true, force: true });
    fs.rmSync(fileStore.LIXEIRA_DIR, { recursive: true, force: true });
    fs.rmSync(runtimePaths.ARCHIVE_DIR, { recursive: true, force: true });
}

function addTask(fields = {}) {
    const now = Date.now();
    const record = assignments.newAssignmentRecord({
        courseId: COURSE,
        studentClass: CLASS,
        title: 'Relatório da prática',
        response: { files: true, text: true, link: true },
        files: { maxFiles: 3, maxSizeMb: 2, types: ['pdf', 'image'], extraExtensions: [] },
        dueAt: now + 3 * DAY,
        status: 'publicada',
        ...fields,
    }, { actor: 'adm@ciclo.local', now: now - DAY });
    db.memory.assignments.push(record);
    return record;
}

// Entrega gravada como o envio do aluno grava (arquivos de verdade em data/entregas).
function addSubmission(task, email, versions = [{}], extra = {}) {
    const student = db.memory.students.find(item => item.email === email);
    const sub = assignments.newSubmissionRecord(task, student, { now: Date.now() - 2 * HOUR });
    sub.versions = versions.map((spec, index) => {
        const files = (spec.files || [['relatório-ana-souza.pdf', PDF]]).map(([name, content]) => {
            const ext = path.extname(name).toLowerCase();
            const id = assignmentFiles.newFileId();
            const storedRel = assignmentFiles.storedRelFor(task.id, sub.id, id, ext);
            const abs = assignmentFiles.absFromStoredRel(storedRel);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, content);
            return { id, originalName: name, storedRel, size: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex'), mime: assignmentFiles.DOWNLOAD_MIME[ext] || 'application/octet-stream', ext, category: ext === '.pdf' ? 'pdf' : 'image' };
        });
        const requestAt = spec.requestAt || Date.now() - HOUR + index;
        return { n: index + 1, requestAt, receivedAt: requestAt + 100, late: !!spec.lateMs, lateMs: spec.lateMs || 0, text: spec.text || '', link: spec.link || '', files, ip: '10.0.0.5', device: 'Celular da Ana' };
    });
    sub.status = sub.versions.length ? 'enviada' : 'pendente';
    Object.assign(sub, extra);
    db.memory.assignmentSubmissions.push(sub);
    return sub;
}

const filesOf = sub => sub.versions.flatMap(version => version.files);
const onDisk = file => fs.existsSync(path.join(runtimePaths.DATA_DIR, ...file.storedRel.split('/')));

// Ana (encerrada) com duas entregas: uma devolvida com nota e comentário, texto e link;
// outra com entrega em mãos e prazo individual. Bia (ativa) com uma entrega.
function seedDeliveries() {
    const task1 = addTask();
    const task2 = addTask({ title: 'Diagrama de rede' });
    const anaSub = addSubmission(task1, ANA, [
        { files: [['relatório-ana-souza.pdf', PDF], ['foto da Ana.png', PNG]], text: 'Feito pela Ana Souza, matrícula MAT-4455.', link: 'https://exemplo.local/ana-souza' },
        { files: [['versão 2 - Ana.pdf', PDF]], text: 'Segunda versão.', lateMs: 2 * HOUR },
    ], {
        status: 'devolvida',
        grade: { score: 85, penaltyPct: 10, finalScore: 76.5, comment: 'Ana, faltou a conclusão.', versionGraded: 2, gradedBy: 'adm@ciclo.local', gradedAt: Date.now() - HOUR, penaltyWaived: false },
        returnedAt: Date.now() - HOUR,
        returnedBy: 'adm@ciclo.local',
    });
    const anaManual = addSubmission(task2, ANA, [], {
        status: 'entregue_em_maos',
        manualEntry: { note: 'Ana entregou o pendrive na secretaria.', by: 'adm@ciclo.local', at: Date.now() - HOUR },
        extension: { dueAt: Date.now() + 5 * DAY, closeAt: null, by: 'adm@ciclo.local', at: Date.now() - 2 * HOUR, reason: 'Ana estava doente (atestado).' },
    });
    const biaSub = addSubmission(task1, BIA, [{ files: [['bia.pdf', PDF]], text: 'Da Bia.' }], {
        status: 'corrigida',
        grade: { score: 90, penaltyPct: 0, finalScore: 90, comment: 'Ótimo, ainda não devolvi.', versionGraded: 1, gradedBy: 'adm@ciclo.local', gradedAt: Date.now() - HOUR, penaltyWaived: false },
    });
    return { task1, task2, anaSub, anaManual, biaSub };
}

const anonymize = email => asAdmin(request(app).post('/api/admin/students/anonymize')).send({ email, confirm: 'ANONIMIZAR', reason: 'Pedido da família da Ana Souza' });
const purge = email => asAdmin(request(app).post('/api/admin/students/purge')).send({ email, confirm: 'APAGAR', reason: 'Pedido da família' });

test.before(async () => { await db.init(); app = createApp(); });
test.beforeEach(() => seed());
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 300));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-ENCERRADOS-002] anonimizar: a entrega fica com o pseudônimo, a situação, as datas e a nota; sai o dado pessoal e os arquivos vão para a lixeira com lápide', async () => {
    const { anaSub, anaManual, biaSub } = seedDeliveries();
    const anaFiles = filesOf(anaSub);
    const biaFiles = filesOf(biaSub);

    const res = await anonymize(ANA);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const pseudo = res.body.email;
    assert.match(pseudo, /^anonimizado-[0-9a-f]{12}@anonimizado\.invalid$/);
    assert.equal(res.body.kept.assignmentSubmissions, 2);

    const rows = db.memory.assignmentSubmissions.filter(sub => sub.studentEmail === pseudo);
    assert.equal(rows.length, 2);
    const delivered = rows.find(sub => sub.id === anaSub.id);
    assert.equal(delivered.anonymized, true);
    assert.equal(delivered.studentId, null);
    assert.equal(delivered.status, 'devolvida');
    assert.equal(delivered.returnedAt, anaSub.returnedAt);
    assert.equal(delivered.grade.score, 85);
    assert.equal(delivered.grade.finalScore, 76.5);
    assert.equal(delivered.grade.versionGraded, 2);
    assert.equal(delivered.grade.comment, '');
    assert.equal(delivered.versions.length, 2);
    assert.equal(delivered.versions[1].late, true);
    assert.equal(delivered.versions[1].lateMs, 2 * HOUR);
    assert.equal(delivered.versions[0].requestAt, anaSub.versions[0].requestAt);
    delivered.versions.forEach(version => {
        assert.equal(version.text, '');
        assert.equal(version.link, '');
        assert.equal(version.ip, '');
        assert.equal(version.device, '');
    });
    assert.deepEqual(delivered.versions[0].files.map(file => file.originalName), ['arquivo-1.pdf', 'arquivo-2.png']);
    assert.deepEqual(delivered.versions[1].files.map(file => file.originalName), ['arquivo-1.pdf']);
    delivered.versions.flatMap(version => version.files).forEach(file => {
        assert.equal(file.removedReason, 'anonimizar');
        assert.ok(file.removedAt > 0);
        assert.equal(file.size > 0, true);
    });
    const manual = rows.find(sub => sub.id === anaManual.id);
    assert.equal(manual.status, 'entregue_em_maos');
    assert.equal(manual.manualEntry.note, '');
    assert.equal(manual.manualEntry.at, anaManual.manualEntry.at);
    assert.equal(manual.extension.reason, '');
    assert.equal(manual.extension.dueAt, anaManual.extension.dueAt);

    // Nada da pessoa sobra nas entregas.
    const dump = JSON.stringify(db.memory.assignmentSubmissions.filter(sub => sub.studentEmail !== BIA));
    ['Ana', 'ana.souza', 'MAT-4455', 'exemplo.local', '10.0.0.5', 'Celular', 'relatório', 'pendrive', 'atestado'].forEach(piece => assert.equal(dump.includes(piece), false, piece));

    // Arquivos: fora de data/entregas, na lixeira só do administrador e sem nome da pessoa.
    anaFiles.forEach(file => assert.equal(onDisk(file), false, file.storedRel));
    biaFiles.forEach(file => assert.equal(onDisk(file), true, file.storedRel));
    const trash = fileStore.listTrash().filter(item => /^entregas\//.test(item.originalRel));
    assert.ok(trash.length >= 1);
    trash.forEach(item => {
        assert.equal(fileStore.isAdminOnlyTrashEntry(item), true);
        assert.doesNotMatch(`${item.name} ${item.originalRel} ${item.originalName} ${item.id}`, /ana|souza|relat/i);
    });
    // A pasta da entrega dela foi inteira (um item por entrega com arquivo).
    assert.deepEqual(trash.map(item => item.name).sort(), [anaSub.id]);

    // Lápides: uma por arquivo, para o espelho apagar a cópia do destino externo.
    const stones = db.memory.assignmentFileTombstones;
    assert.deepEqual(stones.map(item => item.fileId).sort(), anaFiles.map(file => file.id).sort());
    stones.forEach(item => {
        assert.equal(item.reason, 'anonimizar');
        assert.equal(item.mirroredRemovalAt, null);
        assert.match(item.storedRel, /^entregas\/asg_/);
    });

    // A entrega da Bia não mudou.
    const bia = db.memory.assignmentSubmissions.find(sub => sub.id === biaSub.id);
    assert.equal(bia.versions[0].files[0].originalName, 'bia.pdf');
    assert.equal(bia.versions[0].text, 'Da Bia.');


    // Cadastros encerrados conta os trabalhos entregues guardados.
    const closed = await asAdmin(request(app).get('/api/admin/students/closed'));
    assert.equal(closed.status, 200);
    const row = closed.body.items.find(item => item.email === pseudo);
    assert.equal(row.counts.assignmentSubmissions, 2);
    assert.equal(closed.body.countLabels.assignmentSubmissions, 'Trabalhos entregues');
});

test('[UC-ENCERRADOS-002] apagar de vez: as entregas saem e os arquivos vão para a lixeira com lápide', async () => {
    const { anaSub, biaSub } = seedDeliveries();
    const anaFiles = filesOf(anaSub);
    const closed = await asAdmin(request(app).get('/api/admin/students/closed'));
    assert.equal(closed.body.items.find(item => item.email === ANA).counts.assignmentSubmissions, 2);

    const res = await purge(ANA);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.removed.assignmentSubmissions, 2);
    assert.equal(db.memory.assignmentSubmissions.length, 1);
    assert.equal(db.memory.assignmentSubmissions[0].id, biaSub.id);
    anaFiles.forEach(file => assert.equal(onDisk(file), false));
    assert.deepEqual(db.memory.assignmentFileTombstones.map(item => item.reason), anaFiles.map(() => 'apagar_aluno'));
    const audit = audits('student_purged')[0];
    assert.equal(audit.details.removed.assignmentSubmissions, 2);
    // Apagar um anonimizado não repete lápide nem falha sem arquivo.
    seed();
    const again = seedDeliveries();
    const anon = await anonymize(ANA);
    assert.equal(anon.status, 200);
    const stones = db.memory.assignmentFileTombstones.length;
    const purged = await purge(anon.body.email);
    assert.equal(purged.status, 200, JSON.stringify(purged.body));
    assert.equal(db.memory.assignmentFileTombstones.length, stones);
    assert.equal(db.memory.assignmentSubmissions.some(sub => sub.id === again.anaSub.id), false);
});

test('[UC-FUNDACAO-003] handler que falha depois do das entregas: nada muda, nenhum arquivo sai do lugar e nenhuma lápide fica', async () => {
    const { anaSub } = seedDeliveries();
    const before = JSON.stringify(db.memory.assignmentSubmissions);
    const remove = studentData.registerStudentDataHandler({
        collection: 'colecaoQueFalha',
        label: 'Coleção que falha',
        anonymize() { throw new Error('falhou de propósito'); },
    });
    try {
        const res = await anonymize(ANA);
        assert.equal(res.status, 500);
        assert.equal(res.body.code, 'student_data_handler_failed');
    } finally {
        remove();
    }
    assert.equal(JSON.stringify(db.memory.assignmentSubmissions), before);
    assert.deepEqual(db.memory.assignmentFileTombstones, []);
    filesOf(anaSub).forEach(file => assert.equal(onDisk(file), true));
    assert.equal(fileStore.listTrash().length, 0);
});

test('[UC-FUNDACAO-003] trocar o e-mail do aluno leva as entregas junto (ele continua vendo a dele)', async () => {
    const { task1, biaSub } = seedDeliveries();
    const res = await asAdmin(request(app).post('/api/admin/student/update')).send({ originalEmail: BIA, email: 'bia.nova@ciclo.local', name: 'Bia Rocha', studentClass: CLASS, classes: [{ name: CLASS, courseId: COURSE }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const sub = db.memory.assignmentSubmissions.find(item => item.id === biaSub.id);
    assert.equal(sub.studentEmail, 'bia.nova@ciclo.local');
    assert.equal(assignments.findSubmission(db.memory, task1.id, 'bia.nova@ciclo.local').id, biaSub.id);
    assert.equal(assignments.findSubmission(db.memory, task1.id, BIA), null);
});

test('[UC-LGPD-010] Meus dados do aluno: tarefas com versões, arquivos e comprovante; nota e comentário só depois de devolvida; sem IP', async () => {
    const { task1, biaSub } = seedDeliveries();
    const task3 = addTask({ title: 'Projeto final' });
    addSubmission(task3, BIA, [{ files: [['final.pdf', PDF]] }], {
        status: 'devolvida',
        grade: { score: 70, penaltyPct: 0, finalScore: 70, comment: 'Bom trabalho.', versionGraded: 1, gradedBy: 'adm@ciclo.local', gradedAt: Date.now(), penaltyWaived: false },
        returnedAt: Date.now(),
        returnedBy: 'adm@ciclo.local',
    });
    const res = await asStudent(BIA, request(app).get('/api/student/my-data?finalidade=baixar'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = res.body;
    assert.ok(Array.isArray(data.tarefas));
    assert.equal(data.tarefas.length, 2);
    assert.equal(data.counts.tarefas, 2);
    assert.deepEqual(data.extraSections.find(item => item.key === 'tarefas').label, 'Trabalhos entregues');
    const pending = data.tarefas.find(row => row.assignmentId === task1.id);
    assert.equal(pending.tarefa, 'Relatório da prática');
    assert.equal(pending.situacao, 'Enviada');
    assert.equal(pending.nota, null);
    assert.equal(pending.notaFinal, null);
    assert.equal(pending.comentario, '');
    assert.equal(pending.versoes.length, 1);
    assert.equal(pending.versoes[0].texto, 'Da Bia.');
    assert.deepEqual(pending.versoes[0].arquivos.map(file => file.nome), ['bia.pdf']);
    assert.equal(pending.versoes[0].arquivos[0].comprovante, filesOf(biaSub)[0].sha256.slice(0, 8).toUpperCase());
    assert.equal(pending.versoes[0].comprovante, assignments.versionReceiptCode(biaSub, biaSub.versions[0]));
    const returned = data.tarefas.find(row => row.assignmentId === task3.id);
    assert.equal(returned.situacao, 'Devolvida');
    assert.equal(returned.notaFinal, 70);
    assert.equal(returned.comentario, 'Bom trabalho.');
    const text = JSON.stringify(data.tarefas);
    ['10.0.0.5', 'Celular', 'storedRel', 'entregas/', 'Ótimo, ainda não devolvi', 'adm@ciclo.local', 'sha256'].forEach(piece => assert.equal(text.includes(piece), false, piece));
});

test('[UC-LGPD-011] Meus dados pelo administrador: tudo, inclusive a correção não devolvida e o IP do envio', async () => {
    const { task1, anaManual } = seedDeliveries();
    const res = await asAdmin(request(app).get(`/api/admin/lgpd/students/export?email=${encodeURIComponent(BIA)}&finalidade=baixar`));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = res.body.tarefas.find(item => item.assignmentId === task1.id);
    assert.equal(row.situacao, 'Corrigida (não devolvida)');
    assert.equal(row.notaFinal, 90);
    assert.equal(row.comentario, 'Ótimo, ainda não devolvi.');
    assert.equal(row.correcao.devolvida, false);
    assert.equal(row.correcao.corrigidaPor, 'adm@ciclo.local');
    assert.equal(row.versoes[0].ip, '10.0.0.5');
    assert.equal(row.versoes[0].aparelho, 'Celular da Ana');
    assert.equal(JSON.stringify(res.body.tarefas).includes('storedRel'), false);
    // A entrega em mãos e o prazo individual vêm com a observação e o motivo.
    const ana = await asAdmin(request(app).get(`/api/admin/lgpd/students/export?email=${encodeURIComponent(ANA)}&finalidade=baixar`));
    assert.equal(ana.status, 200);
    const manual = ana.body.tarefas.find(item => item.id === anaManual.id);
    assert.equal(manual.situacao, 'Para corrigir');
    assert.equal(manual.entregaEmMaos.observacao, 'Ana entregou o pendrive na secretaria.');
    assert.equal(manual.prazoIndividual.motivo, 'Ana estava doente (atestado).');
});

test('[UC-FUNDACAO-003] mesclar: as versões do duplicado entram antes, renumeradas, a nota do que fica vale e a versão corrigida acompanha', () => {
    const task1 = addTask();
    const task2 = addTask({ title: 'Só do duplicado' });
    db.memory.students.push({ id: 'alu_00000000000000c3', name: 'Bia (duplicado)', email: 'bia.dup@ciclo.local', status: 'Ativo', classes: [{ name: CLASS, courseId: COURSE }] });
    const base = Date.now() - 10 * HOUR;
    const fica = addSubmission(task1, BIA, [{ requestAt: base + 5 * HOUR }, { requestAt: base + 6 * HOUR }], {
        status: 'corrigida',
        grade: { score: 90, penaltyPct: 0, finalScore: 90, comment: 'Ok', versionGraded: 2, gradedBy: 'adm@ciclo.local', gradedAt: Date.now(), penaltyWaived: false },
    });
    const graded = fica.versions[1];
    const sai = addSubmission(task1, 'bia.dup@ciclo.local', [{ requestAt: base + HOUR }, { requestAt: base + 7 * HOUR }], { status: 'enviada' });
    const onlySai = addSubmission(task2, 'bia.dup@ciclo.local', [{}], { status: 'enviada' });
    const ctx = email => studentData.studentContextFrom(db.memory.students.find(item => item.email === email), studentEmailOwnership(db.memory, email));
    studentData.mergeStudentData(db.memory, ctx(BIA), ctx('bia.dup@ciclo.local'));
    const rows = db.memory.assignmentSubmissions;
    assert.equal(rows.some(item => item.id === sai.id), false);
    const merged = rows.find(item => item.id === fica.id);
    assert.deepEqual(merged.versions.map(version => version.n), [1, 2, 3, 4]);
    assert.deepEqual(merged.versions.map(version => version.requestAt), [base + HOUR, base + 7 * HOUR, base + 5 * HOUR, base + 6 * HOUR]);
    assert.equal(merged.versions[3], graded);
    assert.equal(merged.grade.versionGraded, 4);
    assert.equal(merged.grade.finalScore, 90);
    assert.equal(merged.mergedFrom.length, 1);
    assert.equal(merged.mergedFrom[0].recordId, sai.id);
    assert.equal(merged.mergedFrom[0].versoes, 2);
    const moved = rows.find(item => item.id === onlySai.id);
    assert.equal(moved.studentEmail, BIA);
    assert.equal(moved.studentId, 'alu_00000000000000b2');
    // Nenhuma entrega repetida para o mesmo aluno na mesma tarefa.
    const keys = rows.map(item => `${item.assignmentId}|${item.studentEmail}`);
    assert.equal(new Set(keys).size, keys.length);
});

test('[UC-FUNDACAO-003] religar depois de restaurar: entrega com studentId que não é de ninguém volta ao id do aluno pelo e-mail', () => {
    const task = addTask();
    const sub = addSubmission(task, BIA, [{}]);
    sub.studentId = 'alu_ffffffffffffffff';
    const old = addSubmission(addTask({ title: 'Antiga' }), BIA, [{}]);
    delete old.studentId;
    assert.equal(studentData.relinkStudentData(db.memory, { [BIA]: 'alu_00000000000000b2' }), true);
    assert.equal(sub.studentId, 'alu_00000000000000b2');
    assert.equal(old.studentId, 'alu_00000000000000b2');
    assert.equal(studentData.relinkStudentData(db.memory, { [BIA]: 'alu_00000000000000b2' }), false);
});

test('[UC-CURSO-001] excluir o curso de vez leva tarefas e entregas para o pacote e os arquivos para _cursos_arquivados; restaurar traz de volta', async () => {
    const { task1, task2, anaSub, biaSub } = seedDeliveries();
    const otherTask = addTask({ courseId: OTHER_COURSE, studentClass: '2OUT', title: 'De outro curso' });
    const all = [...filesOf(anaSub), ...filesOf(biaSub)];
    const res = await asAdmin(request(app).post(`/api/admin/courses/${COURSE}/purge`)).send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.counts.tarefas, 2);
    assert.equal(res.body.counts.entregas, 3);
    const folder = res.body.folder;
    assert.deepEqual(db.memory.assignments.map(item => item.id), [otherTask.id]);
    assert.deepEqual(db.memory.assignmentSubmissions, []);
    const bundle = JSON.parse(fs.readFileSync(path.join(runtimePaths.ARCHIVE_DIR, folder, 'curso.json'), 'utf8'));
    assert.deepEqual(bundle.assignments.map(item => item.id).sort(), [task1.id, task2.id].sort());
    assert.equal(bundle.assignmentSubmissions.length, 3);
    const manifest = JSON.parse(fs.readFileSync(path.join(runtimePaths.ARCHIVE_DIR, folder, 'manifesto.json'), 'utf8'));
    assert.equal(manifest.counts.tarefas, 2);
    assert.equal(manifest.counts.entregas, 3);
    assert.equal(manifest.counts.arquivosEntregas, all.length);
    assert.equal(manifest.entregas, `_cursos_arquivados/${folder}`);
    // Os arquivos saíram do lugar, sem ir para o pacote (que vai nos backups): ficam em
    // data/entregas/_cursos_arquivados/<pasta>/<tarefa>/<entrega>/<arquivo>.
    all.forEach(file => {
        assert.equal(onDisk(file), false);
        const archived = path.join(runtimePaths.ASSIGNMENT_FILES_DIR, '_cursos_arquivados', folder, ...file.storedRel.split('/').slice(1));
        assert.equal(fs.existsSync(archived), true, archived);
    });
    assert.equal(fs.existsSync(path.join(runtimePaths.ASSIGNMENT_FILES_DIR, task1.id)), false);
    assert.equal(fs.readdirSync(path.join(runtimePaths.ARCHIVE_DIR, folder)).some(name => /entregas/.test(name)), false);
    const archivedAudit = audits('course_archived')[0];
    assert.equal(archivedAudit.details.counts.tarefas, 2);
    assert.equal(archivedAudit.details.counts.entregas, 3);

    // Restaurar: registros e arquivos de volta, a entrega da Bia baixável de novo.
    const restored = await asAdmin(request(app).post('/api/admin/archived-courses/restore')).send({ folder });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.deepEqual(db.memory.assignments.map(item => item.id).sort(), [otherTask.id, task1.id, task2.id].sort());
    assert.equal(db.memory.assignmentSubmissions.length, 3);
    all.forEach(file => assert.equal(onDisk(file), true, file.storedRel));
    assert.equal(fs.existsSync(path.join(runtimePaths.ASSIGNMENT_FILES_DIR, '_cursos_arquivados')), false);
    const bia = db.memory.assignmentSubmissions.find(item => item.id === biaSub.id);
    assert.equal(bia.studentId, 'alu_00000000000000b2');
    assert.equal(assignmentFiles.storedFileExists(bia.versions[0].files[0]), true);
    assert.equal(audits('course_archive_restored')[0].details.counts.entregas, 3);
});

test('[UC-CURSO-001] excluir o pacote do curso manda os arquivos das entregas para a lixeira com lápide (as duas cópias no espelho)', async () => {
    const { anaSub, biaSub } = seedDeliveries();
    const all = [...filesOf(anaSub), ...filesOf(biaSub)];
    const res = await asAdmin(request(app).post(`/api/admin/courses/${COURSE}/purge`)).send({});
    assert.equal(res.status, 200);
    const folder = res.body.folder;
    const del = await asAdmin(request(app).post('/api/admin/archived-courses/delete')).send({ folder });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal(fs.existsSync(path.join(runtimePaths.ASSIGNMENT_FILES_DIR, '_cursos_arquivados', folder)), false);
    const trash = fileStore.listTrash().filter(item => /^entregas\/_cursos_arquivados\//.test(item.originalRel));
    assert.equal(trash.length, 1);
    assert.equal(fileStore.isAdminOnlyTrashEntry(trash[0]), true);
    const stones = db.memory.assignmentFileTombstones;
    assert.deepEqual(stones.map(item => item.fileId).sort(), all.map(file => file.id).sort());
    stones.forEach(stone => {
        const file = all.find(item => item.id === stone.fileId);
        assert.equal(stone.reason, 'excluir_curso');
        assert.equal(stone.storedRel, file.storedRel);
        assert.equal(stone.archivedRel, `entregas/_cursos_arquivados/${folder}/${file.storedRel.slice('entregas/'.length)}`);
    });
    assert.equal(audits('course_archive_deleted')[0].details.arquivosEntregasNaLixeira, all.length);
});

test('[UC-CURSO-001] pacote de curso de antes do C10 (sem tarefas) restaura e exclui como antes', async () => {
    const folder = `${COURSE}__antigo`;
    const dir = path.join(runtimePaths.ARCHIVE_DIR, folder);
    fs.mkdirSync(dir, { recursive: true });
    db.memory.courses = db.memory.courses.filter(item => item.id !== COURSE);
    fs.writeFileSync(path.join(dir, 'curso.json'), JSON.stringify({ course: { id: COURSE, name: 'Curso do ciclo' }, classes: [], submissions: [], students: [] }));
    fs.writeFileSync(path.join(dir, 'manifesto.json'), JSON.stringify({ folder, courseId: COURSE, name: 'Curso do ciclo', counts: { turmas: 0 } }));
    const res = await asAdmin(request(app).post('/api/admin/archived-courses/restore')).send({ folder });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(db.memory.assignments, []);
    assert.deepEqual(db.memory.assignmentSubmissions, []);
    assert.equal(audits('course_archive_restored')[0].details.counts.tarefas, 0);
});

test('lápides: nunca repetem o fileId (o backup recusa chave repetida) e só aceitam os motivos conhecidos', () => {
    const files = [{ id: 'f_0000000000000001', storedRel: 'entregas/a/b/f_0000000000000001.pdf' }, { id: 'f_0000000000000001', storedRel: 'x' }, { id: '', storedRel: 'y' }];
    assert.equal(assignmentLifecycle.addFileTombstones(db.memory, files, { reason: 'anonimizar', at: 1 }), 1);
    assert.equal(assignmentLifecycle.addFileTombstones(db.memory, files, { reason: 'apagar_aluno', at: 2 }), 0);
    assert.equal(db.memory.assignmentFileTombstones.length, 1);
    assert.throws(() => assignmentLifecycle.addFileTombstones(db.memory, files, { reason: 'qualquer' }), /motivo/);
});
