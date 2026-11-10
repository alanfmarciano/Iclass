// Resto da trilha de auditoria (H7a-2; SEG-07, FUN-03, FUN-04, CONF-09).
// 1) As rotas que ficavam fora da trilha agora gravam pelo recordAudit: configurações
//    (settings_updated com antes e depois de cada chave), certificados, escolas, avisos,
//    eventos do calendário e questões excluídos (com a cópia em details.deleted), curso
//    arquivado, restaurado e apagado de vez, lixeira de arquivos e dúvida apagada de vez.
// 2) Restaurar um backup junta a trilha dele com a atual (mergeAuditTrails): o que foi
//    feito depois do backup continua no registro, e a lixeira de notas segue a regra nova
//    (a nota está lá enquanto não existe; vale a exclusão mais recente).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-audit-coverage-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

// Módulos antes do servidor: server.js registra o process.on('uncaughtException'), que
// engoliria a falha destes require e o arquivo passaria sem rodar nenhum teste.
const { mergeAuditTrails } = require('../../backend/utils/audit.js');
const { mergeRowsByKey } = require('../../backend/utils/backup.js');
const fileStore = require('../../backend/utils/storage.js');
const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');

const adminToken = 'admin-token-audit-coverage';
const professorToken = 'professor-token-audit-coverage';
const COURSE = 'curso-cobertura';
let app;

const admin = req => req.set('x-admin-session', adminToken);
const professor = req => req.set('x-admin-session', professorToken);
const entries = action => (db.memory.auditLogs || []).filter(entry => entry.action === action);
const last = action => entries(action).pop();

function seed() {
    db.memory.admins = [
        { email: 'admin@cobertura.local', name: 'Admin', role: 'admin', password: db.hashPassword('x') },
        { email: 'prof@cobertura.local', name: 'Professor', role: 'professor', password: db.hashPassword('x'), assignedClasses: [{ courseId: COURSE, className: '1DES' }] },
    ];
    db.memory.adminSessions = {
        [adminToken]: { email: 'admin@cobertura.local', createdAt: Date.now(), lastSeen: Date.now() },
        [professorToken]: { email: 'prof@cobertura.local', createdAt: Date.now(), lastSeen: Date.now() },
    };
    db.memory.courses = [{ id: COURSE, name: 'Desenvolvimento', schoolId: 'escola_a', structure: [
        { id: 'm1', name: 'Módulo 1', units: [{ key: 'u1', name: 'Prova 1', avaliacaoKey: 'Avaliacao_P1' }] },
    ] }];
    db.memory.classes = [{ name: '1DES', courseId: COURSE, period: 'Manhã' }];
    db.memory.schools = [{ id: 'escola_a', name: 'Escola A', info: { cidade: 'Recife' }, branding: {} }];
    db.memory.students = [
        { name: 'Ana', email: 'ana@cobertura.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: COURSE }] },
    ];
    db.memory.evaluations = { Avaliacao_P1: { title: 'Prova 1', questions: [1, 2].map(number => ({
        originalNumber: number, text: `Questão ${number}`, correctAnswer: 'A',
        alternatives: ['A', 'B'].map(letter => ({ letter, text: `Alternativa ${letter}` })),
    })) } };
    db.memory.submissions = [];
    db.memory.announcements = [];
    db.memory.certificates = [];
    db.memory.questionBank = [];
    db.memory.forum = [];
    db.memory.auditLogs = [];
    db.memory.sessions = {};
    if (db.memory.config) delete db.memory.config.settings;
}

test.before(async () => {
    await db.init();
    app = createApp();
});
test.beforeEach(() => { seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-AUDITORIA-002] gravar configurações registra settings_updated com antes e depois de cada chave', async () => {
    const saved = await admin(request(app).post('/api/admin/settings')).send({ timezone: 'America/Manaus', session: { idleMinutes: 30 } });
    assert.equal(saved.status, 200, saved.body.error);
    const entry = last('settings_updated');
    assert.ok(entry, 'antes: gravar configurações não deixava registro');
    assert.equal(entry.category, 'system');
    assert.equal(entry.actor, 'admin@cobertura.local');
    assert.deepEqual(entry.details.changes, [
        { key: 'timezone', before: 'America/Sao_Paulo', after: 'America/Manaus' },
        { key: 'session.idleMinutes', before: 60, after: 30 },
    ]);
    // Salvar de novo o mesmo não grava outra entrada.
    assert.equal((await admin(request(app).post('/api/admin/settings')).send({ timezone: 'America/Manaus' })).status, 200);
    assert.equal(entries('settings_updated').length, 1);
});

test('[UC-AUDITORIA-002] certificado emitido e cancelado ficam na trilha do aluno', async () => {
    const issued = await admin(request(app).post('/api/admin/student/certificates/issue')).send({ email: 'ana@cobertura.local', courseName: 'Desenvolvimento', courseId: COURSE });
    assert.equal(issued.status, 200, issued.body.error);
    const issue = last('certificate_issued');
    assert.equal(issue.studentEmail, 'ana@cobertura.local');
    assert.equal(issue.courseId, COURSE);
    assert.equal(issue.category, 'academic');
    assert.deepEqual(issue.details, { certificateId: issued.body.certificate.id, code: issued.body.certificate.code, courseName: 'Desenvolvimento' });

    assert.equal((await admin(request(app).post('/api/admin/student/certificates/revoke')).send({ id: issued.body.certificate.id })).status, 200);
    const revoke = last('certificate_revoked');
    assert.deepEqual([revoke.before, revoke.after], [{ status: 'Emitido' }, { status: 'Cancelado' }]);
    assert.equal(db.memory.certificates[0].revokedBy, 'admin@cobertura.local');
    // A ficha do aluno (aba Auditoria) mostra as duas.
    const audit = await admin(request(app).get('/api/admin/student/audit?email=ana@cobertura.local'));
    assert.deepEqual(audit.body.map(item => item.action).sort(), ['certificate_issued', 'certificate_revoked']);
});

test('[UC-AUDITORIA-002] escola criada, alterada e excluída; salvar sem mudar nada não registra', async () => {
    const created = await admin(request(app).post('/api/admin/schools/create')).send({ name: 'Escola B', info: { cidade: 'Olinda' } });
    assert.equal(created.status, 200, created.body.error);
    const id = created.body.school.id;
    assert.equal(last('school_created').after.name, 'Escola B');
    assert.equal(last('school_created').after.id, id);

    assert.equal((await admin(request(app).post('/api/admin/schools/update')).send({ id, name: 'Escola B Centro' })).status, 200);
    const update = last('school_updated');
    assert.deepEqual([update.before.name, update.after.name], ['Escola B', 'Escola B Centro']);
    assert.equal((await admin(request(app).post('/api/admin/schools/update')).send({ id, name: 'Escola B Centro' })).status, 200);
    assert.equal(entries('school_updated').length, 1, 'nada mudou: sem entrada nova');

    assert.equal((await admin(request(app).post('/api/admin/schools/delete')).send({ id })).status, 200);
    assert.equal(last('school_deleted').before.name, 'Escola B Centro');
});

test('[UC-AUDITORIA-002] aviso, evento do calendário e questão excluídos guardam a cópia em details.deleted', async () => {
    db.memory.announcements = [
        { id: 'ann_1', title: 'Prova sexta', message: 'Estudem o módulo 1', target: 'turma', targetValue: '1DES', courseId: COURSE, studentClass: '1DES', readBy: ['ana@cobertura.local'], createdAt: Date.now() },
        { id: 'cal_1', kind: 'calendar', title: 'Feriado', eventDate: '2026-11-20', target: 'turma', targetValue: '1DES', courseId: COURSE, createdAt: Date.now() },
    ];
    db.memory.questionBank = [{ key: 'q_1', text: 'Quanto é 2 + 2?', sourceExamKey: 'Avaliacao_P1', correctAnswer: 'B' }];

    assert.equal((await professor(request(app).post('/api/admin/announcements/delete')).send({ id: 'ann_1' })).status, 200);
    const ann = last('announcement_deleted');
    assert.equal(ann.actor, 'prof@cobertura.local');
    assert.equal(ann.actorRole, 'professor');
    assert.equal(ann.courseId, COURSE);
    assert.equal(ann.studentClass, '1DES');
    assert.equal(ann.details.deleted.title, 'Prova sexta');
    assert.equal(ann.details.deleted.message, 'Estudem o módulo 1');
    assert.equal(ann.details.deleted.readCount, 1, 'quem leu vira só a contagem');
    assert.equal('readBy' in ann.details.deleted, false);

    assert.equal((await admin(request(app).post('/api/admin/announcements/calendar/delete')).send({ id: 'cal_1' })).status, 200);
    assert.equal(last('calendar_event_deleted').details.deleted.eventDate, '2026-11-20');

    assert.equal((await admin(request(app).post('/api/admin/question-bank/delete')).send({ key: 'q_1' })).status, 200);
    const question = last('question_deleted');
    assert.equal(question.examKey, 'Avaliacao_P1');
    assert.equal(question.details.deleted.text, 'Quanto é 2 + 2?');
});

test('[UC-AUDITORIA-002] curso arquivado, restaurado do arquivo e apagado de vez ficam na trilha', async () => {
    const purge = await admin(request(app).post(`/api/admin/courses/${COURSE}/purge`)).send({});
    assert.equal(purge.status, 200, purge.body.error);
    const archived = last('course_archived');
    assert.equal(archived.courseId, COURSE);
    assert.equal(archived.details.folder, purge.body.folder);
    assert.equal(archived.details.name, 'Desenvolvimento');
    assert.deepEqual(archived.details.classes, ['1DES']);
    assert.equal(archived.details.counts.turmas, 1);

    assert.equal((await admin(request(app).post('/api/admin/archived-courses/restore')).send({ folder: purge.body.folder })).status, 200);
    assert.equal(last('course_archive_restored').details.folder, purge.body.folder);
    assert.ok(db.memory.courses.some(course => course.id === COURSE));

    const again = await admin(request(app).post(`/api/admin/courses/${COURSE}/purge`)).send({});
    assert.equal(again.status, 200, again.body.error);
    assert.equal((await admin(request(app).post('/api/admin/archived-courses/delete')).send({ folder: again.body.folder })).status, 200);
    const deleted = last('course_archive_deleted');
    assert.equal(deleted.courseId, COURSE);
    assert.equal(deleted.details.name, 'Desenvolvimento');
    assert.equal(deleted.details.folder, again.body.folder);
    assert.equal(deleted.details.counts.turmas, 1);
});

function trashFile(name, meta = {}) {
    const dir = path.join(tempRoot, 'uploads', 'cobertura');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, 'conteúdo de teste');
    return fileStore.moveToTrash(file, meta);
}

test('[UC-AUDITORIA-002] lixeira de arquivos: restaurar, apagar de vez e esvaziar ficam na trilha', async () => {
    const restoredId = trashFile('apostila.pdf', { courseId: COURSE, studentClass: '1DES' });
    const deletedId = trashFile('rascunho.txt');
    trashFile('velho-1.txt');
    trashFile('velho-2.txt');

    assert.equal((await admin(request(app).post('/api/admin/trash/restore')).send({ id: restoredId })).status, 200);
    const restored = last('trash_restored');
    assert.equal(restored.category, 'system');
    assert.equal(restored.courseId, COURSE);
    assert.equal(restored.details.item.name, 'apostila.pdf');
    assert.ok(restored.details.item.size > 0);
    assert.match(restored.details.restoredTo, /apostila\.pdf$/);

    assert.equal((await admin(request(app).post('/api/admin/trash/delete')).send({ id: deletedId })).status, 200);
    assert.equal(last('trash_deleted').details.item.name, 'rascunho.txt');

    const emptied = await admin(request(app).post('/api/admin/trash/empty')).send({});
    assert.equal(emptied.status, 200);
    const empty = last('trash_emptied');
    assert.equal(empty.details.removed, 2);
    assert.deepEqual(empty.details.items.map(item => item.name).sort(), ['velho-1.txt', 'velho-2.txt']);
    assert.equal(empty.details.moreItems, 0);
    // Esvaziar a lixeira vazia não grava nada.
    assert.equal((await admin(request(app).post('/api/admin/trash/empty')).send({})).status, 200);
    assert.equal(entries('trash_emptied').length, 1);
});

test('[UC-AUDITORIA-002] dúvida e resposta apagadas de vez registram forum_purged sem o texto', async () => {
    db.memory.forum = [{ id: 'c1', key: 'u1', courseId: COURSE, studentClass: '1DES', studentEmail: 'ana@cobertura.local', text: 'texto da dúvida', replies: [{ id: 'r1', text: 'resposta' }, { id: 'r2', text: 'outra' }] }];
    assert.equal((await admin(request(app).post('/api/admin/forum/purge')).send({ commentId: 'c1', replyId: 'r1' })).status, 200);
    const reply = last('forum_purged');
    assert.deepEqual(reply.details, { scope: 'resposta', commentId: 'c1', replyId: 'r1', removedReplies: 1 });
    assert.equal(reply.courseId, COURSE);
    assert.equal(reply.studentClass, '1DES');
    assert.equal((await admin(request(app).post('/api/admin/forum/purge')).send({ commentId: 'c1' })).status, 200);
    assert.deepEqual(last('forum_purged').details, { scope: 'dúvida', commentId: 'c1', removedReplies: 1 });
    assert.equal(JSON.stringify(entries('forum_purged')).includes('texto da dúvida'), false);
});

// ------------------------------------------------------------ restauração
async function downloadBackup() {
    const response = await admin(request(app).get('/api/admin/backup/data')).buffer(true).parse((res, done) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
    });
    assert.equal(response.status, 200);
    return JSON.parse(response.body.toString('utf8'));
}

// Restaurar desconecta todos (as sessões não vão no backup): a sessão do teste volta.
async function restoreBackup(backup, name = 'backup-cobertura.json') {
    const response = await admin(request(app).post('/api/admin/backup/restore'))
        .field('confirm', 'RESTAURAR')
        .attach('file', Buffer.from(JSON.stringify(backup)), name);
    db.memory.adminSessions = { [adminToken]: { email: 'admin@cobertura.local', createdAt: Date.now(), lastSeen: Date.now() } };
    return response;
}

test('[UC-AUDITORIA-002] restaurar backup não apaga o que foi registrado depois dele', async () => {
    db.memory.auditLogs = [{ id: 'audit_antiga', actor: 'admin@cobertura.local', studentEmail: 'ana@cobertura.local', action: 'update', field: 'Telefone', oldValue: '1', newValue: '2', timestamp: Date.now() - 60000 }];
    await db.save();
    const backup = await downloadBackup();
    assert.ok(backup.data.auditLogs.some(entry => entry.id === 'audit_antiga'));

    // Depois do backup: mudança de configuração registrada.
    assert.equal((await admin(request(app).post('/api/admin/settings')).send({ timezone: 'America/Manaus' })).status, 200);
    const afterBackup = last('settings_updated').id;

    const restored = await restoreBackup(backup);
    assert.equal(restored.status, 200, restored.body.error);
    const ids = db.memory.auditLogs.map(entry => entry.id);
    assert.ok(ids.includes('audit_antiga'), 'entrada do backup');
    assert.ok(ids.includes(afterBackup), 'antes: a trilha do backup substituía a atual e a mudança sumia');
    assert.equal(entries('backup_restored').length, 1, 'a própria restauração fica registrada');
    assert.equal(new Set(ids).size, ids.length, 'sem entrada repetida');
    const times = db.memory.auditLogs.map(entry => Number(entry.timestamp) || Date.parse(entry.at || entry.timestamp) || 0);
    assert.deepEqual(times, [...times].sort((a, b) => a - b), 'em ordem de hora');
});

test('[UC-AUDITORIA-002] backup antigo sem a trilha deixa a trilha atual como está', async () => {
    db.memory.auditLogs = [{ id: 'audit_atual', action: 'settings_updated', category: 'system', actor: 'admin@cobertura.local', timestamp: Date.now() - 1000, details: { changes: [] } }];
    await db.save();
    const backup = await downloadBackup();
    delete backup.data.auditLogs;
    const restored = await restoreBackup(backup, 'backup-sem-trilha.json');
    assert.equal(restored.status, 200, restored.body.error);
    assert.ok(db.memory.auditLogs.some(entry => entry.id === 'audit_atual'));
});

test('[UC-AUDITORIA-002] lixeira de notas depois de restaurar backup: nota viva não aparece; a que saiu volta para a lixeira', async () => {
    const created = await admin(request(app).post('/api/admin/submissions/create')).send({ studentEmail: 'ana@cobertura.local', examKey: 'Avaliacao_P1', grade: 7, courseId: COURSE, studentClass: '1DES', type: 'impressa' });
    assert.equal(created.status, 200, created.body.error);
    const id = created.body.submissionId;
    await db.save();
    const withGrade = await downloadBackup();

    // Exclui e restaura a nota: com a trilha juntada, a exclusão e a volta ficam.
    assert.equal((await admin(request(app).post('/api/admin/submissions/delete')).send({ id })).status, 200);
    const firstDelete = last('grade_delete').id;
    assert.equal((await admin(request(app).post('/api/admin/submissions/restore')).send({ auditId: firstDelete })).status, 200);
    // Exclui de novo e restaura o backup em que a nota existe.
    assert.equal((await admin(request(app).post('/api/admin/submissions/delete')).send({ id })).status, 200);
    assert.equal((await restoreBackup(withGrade)).status, 200);
    assert.ok(db.memory.submissions.some(item => item.id === id), 'a nota do backup voltou');
    const trash = async () => (await admin(request(app).get(`/api/admin/submissions/deleted?courseId=${COURSE}&studentClass=1DES`))).body.items;
    assert.deepEqual(await trash(), [], 'a nota existe: não aparece na lixeira (antes dependia do grade_restore)');

    // Exclui mais uma vez: um item só na lixeira (a exclusão mais recente).
    assert.equal((await admin(request(app).post('/api/admin/submissions/delete')).send({ id })).status, 200);
    const latest = last('grade_delete').id;
    const items = await trash();
    assert.equal(items.length, 1, 'três exclusões da mesma nota na trilha, um item na lixeira');
    assert.equal(items[0].auditId, latest);
    // Restaurar por uma exclusão antiga explica o que fazer.
    const stale = await admin(request(app).post('/api/admin/submissions/restore')).send({ auditId: firstDelete });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /excluída de novo depois/);
    assert.equal((await admin(request(app).post('/api/admin/submissions/restore')).send({ auditId: latest })).status, 200);
    assert.deepEqual(await trash(), []);

    // Backup em que a nota não existe: a nota restaurada sai e volta para a lixeira.
    const withoutGrade = structuredClone(withGrade);
    withoutGrade.data.submissions = [];
    assert.equal((await restoreBackup(withoutGrade, 'backup-sem-nota.json')).status, 200);
    assert.equal(db.memory.submissions.some(item => item.id === id), false);
    const back = await trash();
    assert.equal(back.length, 1, 'a exclusão continua na trilha juntada e a nota pode ser restaurada');
    assert.equal(back[0].submissionId, id);
});

test('[UC-AUDITORIA-002] mergeRowsByKey e mergeAuditTrails: o backup vence na mesma chave e o resto fica', () => {
    const entry = { key: 'id' };
    assert.deepEqual(
        mergeRowsByKey(entry, [{ id: 'a', v: 1 }, { id: 'b', v: 1 }], [{ id: 'b', v: 2 }, { id: 'c', v: 2 }, { v: 'sem chave' }]),
        [{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'c', v: 2 }, { v: 'sem chave' }],
    );
    assert.deepEqual(mergeRowsByKey(entry, undefined, [{ id: 'x' }]), [{ id: 'x' }], 'backup sem a coleção: a atual fica');
    const merged = mergeAuditTrails([{ id: 'a', timestamp: 2, v: 'backup' }], [{ id: 'a', timestamp: 2, v: 'atual' }, { id: 'b', timestamp: 1 }]);
    assert.deepEqual(merged.map(item => [item.id, item.v]), [['b', undefined], ['a', 'backup']]);
});
