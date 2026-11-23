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
const { ticketUrl } = require('./fixtures/backupDownload.js');

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

// Banco de questões (fase 3, P3-S9a): cada rota que muda o banco grava na trilha (contrato
// auditoria.regra), e salvar sem mudar ou arquivar o que já está arquivado não grava.
test('[UC-AUDITORIA-002] banco de questões: criar, alterar, arquivar, desarquivar e levar a avaliação ficam na trilha', async () => {
    const created = await admin(request(app).post('/api/admin/question-bank/create')).send({
        category: 'Redes', type: 'true_false', text: 'IPv4 tem 32 bits.', correctAnswer: 'A', sourceExamKey: 'Avaliacao_P1',
    });
    assert.equal(created.status, 200, created.body.error);
    const key = created.body.question.key;
    const create = last('question_created');
    assert.equal(create.actor, 'admin@cobertura.local');
    assert.equal(create.examKey, 'Avaliacao_P1');
    assert.deepEqual(create.details, { key, categoria: 'Redes', tipo: 'true_false' });

    const changed = await admin(request(app).post('/api/admin/question-bank/update')).send({ key, category: 'Sub-redes' });
    assert.equal(changed.status, 200, changed.body.error);
    const update = last('question_updated');
    assert.deepEqual(update.details, { key, revision: 2, tipo: 'true_false', campos: ['category'] });
    assert.equal((await admin(request(app).post('/api/admin/question-bank/update')).send({ key, category: 'Sub-redes' })).body.unchanged, true);
    assert.equal(entries('question_updated').length, 1, 'nada mudou: sem entrada nova');

    assert.equal((await admin(request(app).post('/api/admin/question-bank/archive')).send({ key })).status, 200);
    assert.deepEqual(last('question_archived').details, { key, categoria: 'Sub-redes', texto: 'IPv4 tem 32 bits.' });
    assert.equal((await admin(request(app).post('/api/admin/question-bank/archive')).send({ key })).body.unchanged, true);
    assert.equal(entries('question_archived').length, 1);
    assert.equal((await admin(request(app).post('/api/admin/question-bank/archive')).send({ key, archived: false })).status, 200);
    assert.equal(last('question_restored').details.key, key);

    const imported = await admin(request(app).post('/api/admin/question-bank/import-evaluation')).send({ examKey: 'Avaliacao_P1', category: 'Prova 1' });
    assert.equal(imported.status, 200, imported.body.error);
    assert.equal(imported.body.importedCount, 2);
    const fromEvaluation = last('question_created');
    assert.equal(fromEvaluation.examKey, 'Avaliacao_P1');
    assert.equal(fromEvaluation.details.origem, 'avaliacao');
    assert.equal(fromEvaluation.details.quantidade, 2);
    assert.deepEqual(fromEvaluation.details.keys, imported.body.questions.map(question => question.key));
    // Levar de novo não traz nada e não grava.
    assert.equal((await admin(request(app).post('/api/admin/question-bank/import-evaluation')).send({ examKey: 'Avaliacao_P1' })).body.importedCount, 0);
    assert.equal(entries('question_created').length, 2);
});

// Importar e exportar o banco (fase 3, P3-S9b): a prévia não grava nem audita; a
// confirmação grava question_bank_imported e a exportação question_bank_exported, na
// mesma gravação; a confirmação recusada (arquivo mudou, nada para importar) não audita.
test('[UC-AUDITORIA-002] banco de questões: importar e exportar (GIFT e planilha) ficam na trilha; a prévia e a recusa não', async () => {
    const before = (db.memory.auditLogs || []).length;
    const payload = { formato: 'gift', conteudo: '$CATEGORY: Redes\n\nPorta do HTTP? {=80 ~21}\n\nIPv4 tem 32 bits. {T}\n' };
    const previewRes = await admin(request(app).post('/api/admin/question-bank/import/preview')).send(payload);
    assert.equal(previewRes.status, 200, previewRes.body.error);
    assert.equal((db.memory.auditLogs || []).length, before, 'a prévia não grava na trilha');
    const changed = await admin(request(app).post('/api/admin/question-bank/import')).send({ ...payload, conteudo: `${payload.conteudo}\nOutra? {=a ~b}\n`, sha256: previewRes.body.sha256 });
    assert.equal(changed.status, 409);
    assert.equal(entries('question_bank_imported').length, 0, 'arquivo diferente da prévia: sem entrada');

    const saved = await admin(request(app).post('/api/admin/question-bank/import')).send({ ...payload, sha256: previewRes.body.sha256 });
    assert.equal(saved.status, 200, saved.body.error);
    const imported = last('question_bank_imported');
    assert.equal(imported.actor, 'admin@cobertura.local');
    assert.equal(imported.category, 'academic');
    assert.equal(imported.details.formato, 'gift');
    assert.equal(imported.details.importadas, 2);
    assert.equal(imported.details.sha256, previewRes.body.sha256);
    assert.deepEqual(imported.details.categorias, ['Redes']);
    const again = await admin(request(app).post('/api/admin/question-bank/import')).send({ ...payload, sha256: previewRes.body.sha256 });
    assert.equal(again.body.code, 'nothing_to_import');
    assert.equal(entries('question_bank_imported').length, 1, 'tudo repetido: sem entrada nova');

    for (const formato of ['gift', 'csv']) {
        const exported = await admin(request(app).get(`/api/admin/question-bank/export?formato=${formato}&categoria=Redes`));
        assert.equal(exported.status, 200);
        const entry = last('question_bank_exported');
        assert.equal(entry.category, 'academic');
        assert.equal(entry.details.formato, formato);
        assert.equal(entry.details.quantidade, 2);
        assert.equal(entry.details.filtros.categoria, 'Redes');
    }
    assert.equal(entries('question_bank_exported').length, 2);
    // Nada para exportar (404) não grava.
    assert.equal((await admin(request(app).get('/api/admin/question-bank/export?formato=gift&categoria=Nenhuma'))).status, 404);
    assert.equal(entries('question_bank_exported').length, 2);
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

test('[UC-AUDITORIA-002] lixeira de arquivos: a trilha guarda o nome do material, não o nome gerado em /uploads', async () => {
    // Arquivo da biblioteca com o nome gerado pelo envio ('<hora>-<sorteio>.pdf').
    const stored = `${Date.now()}-123456789.pdf`;
    fs.mkdirSync(path.join(tempRoot, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'uploads', stored), 'apostila');
    db.memory.library = [{ id: 'lib_redes', kind: 'file', courseId: COURSE, studentClass: '', name: 'Apostila de Redes', originalName: 'redes-v2.pdf', filename: stored, url: `/uploads/${stored}` }];
    assert.equal((await admin(request(app).post('/api/admin/library/delete')).send({ id: 'lib_redes', courseId: COURSE })).status, 200);
    const inTrash = fileStore.listTrash().find(entry => entry.name === stored);
    assert.ok(inTrash, 'o arquivo foi para a lixeira');
    assert.equal(inTrash.originalName, 'Apostila de Redes');

    assert.equal((await admin(request(app).post('/api/admin/trash/delete')).send({ id: inTrash.id })).status, 200);
    // Antes: details.item.name era '<hora>-123456789.pdf', sem como saber que material era.
    assert.deepEqual(last('trash_deleted').details.item, { name: 'Apostila de Redes', size: 8, isDir: false, file: stored, courseId: COURSE });

    // Envio recusado (tipo não permitido) também guarda o nome do arquivo enviado.
    const refusedId = trashFile('1700000000000-42.exe', { originalName: 'instalador.exe' });
    assert.equal((await admin(request(app).post('/api/admin/trash/restore')).send({ id: refusedId })).status, 200);
    assert.equal(last('trash_restored').details.item.name, 'instalador.exe');
    assert.equal(last('trash_restored').details.item.file, '1700000000000-42.exe');
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
    const response = await admin(request(app).get(await ticketUrl(app, adminToken, 'x', '/api/admin/backup/data'))).buffer(true).parse((res, done) => {
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

test('[UC-AUDITORIA-002] nota que voltou da lixeira e saiu com o curso arquivado não reaparece na lixeira', async () => {
    // Ana também está numa turma de outro curso: continua no cadastro depois do arquivamento.
    db.memory.courses.push({ id: 'curso-outro', name: 'Administração', structure: [] });
    db.memory.classes.push({ name: '2ADM', courseId: 'curso-outro', period: 'Tarde' });
    db.memory.students[0].classes.push({ name: '2ADM', courseId: 'curso-outro' });
    // O arquivamento leva as entregas com curso e turma no topo do registro.
    const create = async grade => {
        const created = await admin(request(app).post('/api/admin/submissions/create')).send({ studentEmail: 'ana@cobertura.local', examKey: 'Avaliacao_P1', grade, courseId: COURSE, studentClass: '1DES', type: 'impressa' });
        assert.equal(created.status, 200, created.body.error);
        const submission = db.memory.submissions.find(item => item.id === created.body.submissionId);
        Object.assign(submission, { courseId: COURSE, studentClass: '1DES' });
        return created.body.submissionId;
    };
    const restoredId = await create(7);
    const neverRestoredId = await create(5);
    assert.equal((await admin(request(app).post('/api/admin/submissions/delete')).send({ id: restoredId })).status, 200);
    const firstDelete = last('grade_delete').id;
    assert.equal((await admin(request(app).post('/api/admin/submissions/restore')).send({ auditId: firstDelete })).status, 200);
    assert.equal((await admin(request(app).post('/api/admin/submissions/delete')).send({ id: neverRestoredId })).status, 200);
    const neverRestoredDelete = last('grade_delete').id;

    const purge = await admin(request(app).post(`/api/admin/courses/${COURSE}/purge`)).send({});
    assert.equal(purge.status, 200, purge.body.error);
    assert.equal(db.memory.submissions.some(item => item.id === restoredId), false, 'a nota foi para o curso arquivado');
    const trash = async () => (await admin(request(app).get(`/api/admin/submissions/deleted?courseId=${COURSE}&studentClass=1DES`))).body.items.map(item => item.auditId);
    // Antes: a exclusão velha voltava para a lixeira, e restaurá-la punha de volta a cópia
    // velha, que depois fazia a restauração do curso arquivado pular a nota guardada lá.
    assert.deepEqual(await trash(), [neverRestoredDelete], 'só a nota que nunca voltou continua na lixeira');
    const stale = await admin(request(app).post('/api/admin/submissions/restore')).send({ auditId: firstDelete });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /já voltou da lixeira antes e depois saiu das notas por outro caminho/);
    assert.equal(db.memory.submissions.some(item => item.id === restoredId), false, 'nada voltou');

    // O curso volta do arquivo com a nota que estava lá.
    assert.equal((await admin(request(app).post('/api/admin/archived-courses/restore')).send({ folder: purge.body.folder })).status, 200);
    assert.equal(db.memory.submissions.filter(item => item.id === restoredId).length, 1);
    assert.deepEqual(await trash(), [neverRestoredDelete]);
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

// Tarefas (fase 3, C4 / P1-b): toda rota do cadastro da tarefa que muda dado grava na
// trilha, na categoria 'assignment', com o curso e a turma da tarefa (a cópia, com os do
// destino). Repetir a ação que não muda nada não grava.
test('tarefas: criar, alterar, publicar, arquivar, reativar, copiar e excluir ficam na trilha', async () => {
    db.memory.classes.push({ name: '2DES', courseId: COURSE, period: 'Tarde' });
    db.memory.assignments = [];
    db.memory.assignmentSubmissions = [];
    const created = await professor(request(app).post('/api/admin/assignments')).send({ courseId: COURSE, studentClass: '1DES', title: 'Relatório de redes' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.assignment.id;
    const steps = [
        ['/update', { title: 'Relatório final', dueDate: '2026-12-04', dueTime: '23:00' }, 'assignment_updated'],
        ['/publish', {}, 'assignment_published'],
        ['/archive', {}, 'assignment_archived'],
        ['/unarchive', {}, 'assignment_unarchived'],
    ];
    for (const [suffix, payload, action] of steps) {
        const res = await professor(request(app).post(`/api/admin/assignments/${id}${suffix}`)).send(payload);
        assert.equal(res.status, 200, `${suffix}: ${JSON.stringify(res.body)}`);
        assert.equal(entries(action).length, 1, `${suffix} sem ${action}`);
        // A mesma ação de novo não muda nada e não grava outra entrada.
        await professor(request(app).post(`/api/admin/assignments/${id}${suffix}`)).send(payload);
        assert.equal(entries(action).length, 1, `${suffix} repetido gravou de novo`);
    }
    const copied = await admin(request(app).post(`/api/admin/assignments/${id}/copy`)).send({ courseId: COURSE, studentClass: '2DES' });
    assert.equal(copied.status, 201, JSON.stringify(copied.body));
    assert.equal(last('assignment_copied').studentClass, '2DES');
    assert.equal((await professor(request(app).post(`/api/admin/assignments/${id}/delete`)).send({ confirm: 'EXCLUIR' })).status, 200);
    for (const action of ['assignment_created', 'assignment_updated', 'assignment_published', 'assignment_archived', 'assignment_unarchived', 'assignment_deleted']) {
        const entry = last(action);
        assert.equal(entry.category, 'assignment', action);
        assert.equal(entry.courseId, COURSE, action);
        assert.equal(entry.studentClass, '1DES', action);
        assert.equal(entry.actor, 'prof@cobertura.local', action);
    }
    assert.equal(last('assignment_deleted').details.deleted.title, 'Relatório final');
});

// Tarefas (fase 3, C5 / P1-c): o envio do aluno grava assignment_submitted na mesma
// gravação da versão, com o aluno como ator; envio recusado não grava nada.
test('tarefas: envio do aluno fica na trilha (assignment_submitted); recusado não', async () => {
    const { createStudentSession } = require('../../backend/utils/authSessions.js');
    db.memory.config = { ...(db.memory.config || {}), settings: { entregas: { discoLivreMinimoMb: 0 } } };
    db.memory.assignments = [{
        id: 'asg_1700000000000_c0be01', schemaVersion: 1, courseId: COURSE, studentClass: '1DES', title: 'Relatório', status: 'publicada',
        response: { files: true, text: true, link: false }, files: { maxFiles: 2, maxSizeMb: 5, types: ['pdf'], extraExtensions: [] },
        opensAt: null, dueAt: Date.now() + 86400000, closeAt: null, publishedAt: Date.now() - 1000,
    }];
    db.memory.assignmentSubmissions = [];
    const token = createStudentSession(db.memory, 'ana@cobertura.local');
    const refused = await request(app).post('/api/student/assignments/asg_1700000000000_c0be01/submit').set('x-session-token', token)
        .attach('files', Buffer.from('MZ'), 'programa.exe');
    assert.equal(refused.status, 400);
    assert.equal(entries('assignment_submitted').length, 0);
    const sent = await request(app).post('/api/student/assignments/asg_1700000000000_c0be01/submit').set('x-session-token', token)
        .field('text', 'Minha resposta');
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const entry = last('assignment_submitted');
    assert.equal(entry.category, 'assignment');
    assert.equal(entry.actor, 'ana@cobertura.local');
    assert.equal(entry.actorRole, 'aluno');
    assert.equal(entry.courseId, COURSE);
    assert.equal(entry.studentClass, '1DES');
    assert.equal(entry.details.version, 1);
    assert.equal(entry.submissionId, db.memory.assignmentSubmissions[0].id);
});

// Tarefas (fase 3, C6 / P1-d): nota, devolução, "devolver todas", mudança com motivo,
// refazer, prorrogação, entrega em mãos e o ZIP gravam na trilha, com o professor como
// ator, o curso e a turma da tarefa e o aluno; as ações de nota na categoria 'grade'.
// Pedido recusado ou que não muda nada não grava.
test('tarefas: correção, devolução, refazer, prorrogação, entrega em mãos e ZIP ficam na trilha', async () => {
    const assignments = require('../../backend/utils/assignments.js');
    db.memory.students.push({ name: 'Bia', email: 'bia@cobertura.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: COURSE }] });
    const task = assignments.newAssignmentRecord({
        courseId: COURSE, studentClass: '1DES', title: 'Relatório', status: 'publicada',
        response: { files: false, text: true, link: false }, dueAt: Date.now() + 86400000,
        latePolicy: { mode: 'aceitar', penaltyPerDayPct: 0, penaltyMaxPct: 0 },
    }, { actor: 'prof@cobertura.local', now: Date.now() - 1000 });
    db.memory.assignments = [task];
    const sub = assignments.newSubmissionRecord(task, db.memory.students[0], { now: Date.now() - 500 });
    sub.versions = [{ n: 1, requestAt: Date.now() - 500, receivedAt: Date.now() - 400, late: false, lateMs: 0, text: 'Minha resposta', link: '', files: [], ip: '', device: '' }];
    sub.status = 'enviada';
    db.memory.assignmentSubmissions = [sub];
    const url = suffix => `/api/admin/assignments/${task.id}${suffix}`;
    const later = new Date(Date.now() + 5 * 86400000).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    const ANA = 'ana@cobertura.local';
    const BIA = 'bia@cobertura.local';

    const steps = [
        ['/grade', { studentEmail: ANA, grade: '8', action: 'salvar' }, 'assignment_grade_saved', 'grade', ANA],
        ['/return-all', {}, 'assignment_grade_returned', 'grade', ANA],
        ['/grade', { studentEmail: ANA, grade: '9', action: 'salvar', reason: 'Revisão em sala' }, 'assignment_grade_changed', 'grade', ANA],
        ['/grade', { studentEmail: ANA, action: 'refazer', comment: 'Refaça a conclusão.', redoDueDate: later, reason: 'Pedido do aluno' }, 'assignment_redo_requested', 'grade', ANA],
        ['/extension', { studentEmail: BIA, dueDate: later, reason: 'Atestado médico' }, 'assignment_extension_granted', 'assignment', BIA],
        ['/manual-entry', { studentEmail: BIA, note: 'Entregou impresso.' }, 'assignment_manual_entry', 'assignment', BIA],
    ];
    for (const [suffix, payload, action, category, student] of steps) {
        const res = await professor(request(app).post(url(suffix))).send(payload);
        assert.equal(res.status, 200, `${suffix}: ${JSON.stringify(res.body)}`);
        const entry = last(action);
        assert.ok(entry, `${suffix} sem ${action}`);
        assert.equal(entry.category, category, action);
        assert.equal(entry.actor, 'prof@cobertura.local', action);
        assert.equal(entry.courseId, COURSE, action);
        assert.equal(entry.studentClass, '1DES', action);
        assert.equal(entry.studentEmail, student, action);
        assert.ok(entry.submissionId, action);
    }
    assert.equal(last('assignment_grade_changed').reason, 'Revisão em sala');
    assert.equal(last('assignment_extension_granted').reason, 'Atestado médico');
    // A mesma prorrogação de novo e a nota devolvida mudada sem motivo não gravam nada.
    const before = db.memory.auditLogs.length;
    assert.equal((await professor(request(app).post(url('/extension'))).send({ studentEmail: BIA, dueDate: later, reason: 'Atestado médico' })).body.changed, false);
    assert.equal((await professor(request(app).post(url('/manual-entry'))).send({ studentEmail: BIA, note: 'Entregou impresso.' })).body.changed, false);
    assert.equal(db.memory.auditLogs.length, before);

    const zip = await professor(request(app).get(url('/export'))).buffer(true).parse((res, callback) => {
        res.on('data', () => {});
        res.on('end', () => callback(null, null));
    });
    assert.equal(zip.status, 200);
    const exported = last('assignment_files_exported');
    assert.equal(exported.category, 'assignment');
    assert.equal(exported.actor, 'prof@cobertura.local');
    assert.deepEqual([exported.courseId, exported.studentClass, exported.details.alunos], [COURSE, '1DES', 2]);
});

// Correção do professor e anulação por cola (fase 3, A9 / P3-S4a): a gravação da
// correção, a conclusão, o ajuste de questão objetiva, anular e desfazer a anulação ficam
// na trilha (categoria nota), com o professor como ator, o curso, a turma e o aluno da
// entrega e o motivo. Pedido recusado não grava.
test('[UC-CORRECAO-001] correção, conclusão, ajuste, anulação e desfazer a anulação ficam na trilha', async () => {
    const { createSubmissionFromAttempt } = require('../../backend/utils/examGrading.js');
    const questions = [
        { originalNumber: 1, number: 1, type: 'multiple_choice', points: 1, text: 'Questão 1', correctAnswer: 'A', alternatives: [{ letter: 'A', text: 'Sim' }, { letter: 'B', text: 'Não' }] },
        { originalNumber: 2, number: 2, type: 'essay', points: 2, text: 'Explique.', expectedAnswer: 'Uma explicação.' },
    ];
    db.memory.evaluations.Avaliacao_P1 = { title: 'Prova 1', questions: JSON.parse(JSON.stringify(questions)) };
    const application = { id: 'app_cobertura', examKey: 'Avaliacao_P1', studentClass: '1DES', courseId: COURSE, status: 'finished', versionSnapshots: [{ version: 'A', questions: JSON.parse(JSON.stringify(questions)) }], annulledQuestions: [] };
    db.memory.examApplications = [application];
    const submission = createSubmissionFromAttempt({
        application,
        onlineConfig: {},
        state: { studentEmail: 'ana@cobertura.local', studentClass: '1DES', courseId: COURSE, examKey: 'Avaliacao_P1', applicationId: application.id, assignedVersion: 'A', assignedQuestionNumbers: [1, 2], attemptNumber: 1 },
        evaluation: db.memory.evaluations.Avaliacao_P1,
        student: db.memory.students[0],
        answers: { 1: 'A', 2: { texto: 'Minha explicação.' } },
    });
    db.memory.submissions = [submission];
    const correction = payload => professor(request(app).post(`/api/admin/submissions/${submission.id}/correction`)).send(payload);
    const attempt = payload => professor(request(app).post(`/api/admin/exam-applications/${application.id}/attempt-action`)).send({ studentEmail: 'ana@cobertura.local', ...payload });

    const refusedBefore = db.memory.auditLogs.length;
    await correction({ versao: 1, itens: { 2: { pontos: 5 } } }).expect(400);
    await attempt({ action: 'anular', motivo: 'x' }).expect(400);
    assert.equal(db.memory.auditLogs.length, refusedBefore, 'recusa não grava');

    const steps = [
        [() => correction({ versao: 1, itens: { 2: { pontos: 1.5 } } }), 'grade_manual_correction', undefined],
        [() => correction({ versao: 2, itens: { 1: { pontos: 0.5, motivo: 'Marcou duas no papel' } } }), 'grade_item_override', 'Marcou duas no papel'],
        [() => correction({ versao: 3, concluir: true }), 'grade_correction_completed', undefined],
        [() => attempt({ action: 'anular', motivo: 'Cola com celular', decisao: 'zero' }), 'grade_invalidated', 'Cola com celular'],
        [() => attempt({ action: 'desfazer_anulacao', motivo: 'Engano na sala' }), 'grade_invalidation_undone', 'Engano na sala'],
    ];
    for (const [run, action, reason] of steps) {
        const res = await run();
        assert.equal(res.status, 200, `${action}: ${JSON.stringify(res.body)}`);
        const entry = last(action);
        assert.ok(entry, `sem ${action}`);
        assert.equal(entry.category, 'grade', action);
        assert.equal(entry.actor, 'prof@cobertura.local', action);
        assert.equal(entry.courseId, COURSE, action);
        assert.equal(entry.studentClass, '1DES', action);
        assert.equal(entry.studentEmail, 'ana@cobertura.local', action);
        assert.equal(entry.submissionId, submission.id, action);
        if (reason) assert.equal(entry.reason, reason, action);
    }
    assert.match(last('grade_correction_completed').newValue, /correção concluída/);
    // O mesmo pedido de novo (nada muda) não grava.
    const before = db.memory.auditLogs.length;
    const unchanged = await correction({ versao: 4, itens: { 2: { pontos: 1.5 } } }).expect(200);
    assert.equal(unchanged.body.unchanged, true);
    assert.equal(db.memory.auditLogs.length, before);
});

// Pacote de curso (fase 3, A14 / P4-S14): exportar e importar ficam na trilha (categoria
// acadêmica, com o curso); a prévia e a importação recusada não gravam nada.
test('[UC-PACOTE-001] pacote de curso: exportar e importar ficam na trilha; a prévia e a recusa não', async () => {
    const res = await admin(request(app).get(`/api/admin/courses/${COURSE}/package`)).buffer(true)
        .parse((response, callback) => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => callback(null, Buffer.concat(chunks))); });
    assert.equal(res.status, 200, String(res.body));
    const exported = last('course_package_exported');
    assert.ok(exported, 'sem course_package_exported');
    assert.equal(exported.category, 'academic');
    assert.equal(exported.courseId, COURSE);
    assert.equal(exported.actor, 'admin@cobertura.local');
    assert.equal(exported.details.bytes, res.body.length);

    const post = (url, fields = {}) => {
        let req = admin(request(app).post(url));
        Object.entries(fields).forEach(([key, value]) => { req = req.field(key, value); });
        return req.attach('arquivo', res.body, 'curso.iclass-curso.zip');
    };
    const before = db.memory.auditLogs.length;
    const preview = await post('/api/admin/course-packages/preview');
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const refused = await post('/api/admin/course-packages/import', { sha256: preview.body.sha256, newId: COURSE, newName: 'Repetido' });
    assert.equal(refused.status, 400);
    const changed = await post('/api/admin/course-packages/import', { sha256: 'b'.repeat(64), newId: 'COBERTURA_2', newName: 'Outro arquivo' });
    assert.equal(changed.status, 409);
    assert.equal(db.memory.auditLogs.length, before, 'a prévia e a recusa não gravam');

    const done = await post('/api/admin/course-packages/import', { sha256: preview.body.sha256, newId: 'COBERTURA_2', newName: 'Cobertura importada' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const imported = last('course_package_imported');
    assert.ok(imported, 'sem course_package_imported');
    assert.equal(imported.category, 'academic');
    assert.equal(imported.courseId, 'COBERTURA_2');
    assert.equal(imported.actor, 'admin@cobertura.local');
    assert.equal(imported.details.origemCodigo, COURSE);
    assert.equal(imported.details.sha256, preview.body.sha256);
});

// Critérios, plano da turma e avaliação manual (fase 3, B6 / P2-S3): cada rota que grava
// registra a sua ação (categoria academic) na mesma gravação, com curso e turma; pedido
// que não muda nada não grava outra entrada.
test('[UC-AUDITORIA-002] critérios, plano da turma e avaliação manual ficam na trilha', async () => {
    const criteria = {
        courseId: COURSE,
        ativo: true,
        mediaMinima: 6,
        etapas: [{ ordem: 1, nome: '1º bimestre', peso: 1 }, { ordem: 2, nome: '2º bimestre', peso: 1 }],
    };
    const saved = await admin(request(app).post('/api/admin/grading/criteria')).send(criteria);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((await admin(request(app).post('/api/admin/grading/criteria')).send(criteria)).body.semMudanca, true);
    assert.equal(entries('grading_criteria_updated').length, 1);
    assert.equal(last('grading_criteria_updated').after.mediaMinima, 6);

    const plan = { courseId: COURSE, studentClass: '1DES', itens: { Avaliacao_P1: { etapa: 1, peso: 2 } } };
    assert.equal((await professor(request(app).post('/api/admin/grading/plan')).send(plan)).status, 200);
    assert.equal((await professor(request(app).post('/api/admin/grading/plan')).send(plan)).body.semMudanca, true);
    assert.equal(entries('grading_plan_updated').length, 1);
    assert.equal(last('grading_plan_updated').after.Avaliacao_P1.peso, 2);

    const created = await professor(request(app).post('/api/admin/grading/manual-items/create')).send({ courseId: COURSE, studentClass: '1DES', titulo: 'Seminário', tipo: 'seminario' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.item.id;
    const manual = (suffix, payload = {}) => professor(request(app).post(`/api/admin/grading/manual-items/${suffix}`)).send({ courseId: COURSE, studentClass: '1DES', id, ...payload });
    assert.equal((await manual('update', { titulo: 'Seminário final' })).status, 200);
    assert.equal((await manual('update', { titulo: 'Seminário final' })).body.semMudanca, true);
    assert.equal((await manual('archive')).status, 200);
    assert.equal((await manual('archive')).body.semMudanca, true);
    assert.equal((await manual('restore')).status, 200);
    assert.equal((await manual('restore')).body.semMudanca, true);
    for (const action of ['grading_plan_updated', 'manual_assessment_created', 'manual_assessment_updated', 'manual_assessment_archived', 'manual_assessment_restored']) {
        assert.equal(entries(action).length, 1, action);
        const entry = last(action);
        assert.equal(entry.category, 'academic', action);
        assert.equal(entry.courseId, COURSE, action);
        assert.equal(entry.studentClass, '1DES', action);
        assert.equal(entry.actor, 'prof@cobertura.local', action);
    }
    assert.equal(last('grading_criteria_updated').category, 'academic');
    assert.equal(last('grading_criteria_updated').actor, 'admin@cobertura.local');
    assert.equal(last('manual_assessment_updated').after.titulo, 'Seminário final');
    assert.equal(last('manual_assessment_archived').details.titulo, 'Seminário final');
    // A prévia só lê: nada na trilha.
    const before = db.memory.auditLogs.length;
    assert.equal((await professor(request(app).post('/api/admin/grading/preview')).send({ courseId: COURSE, studentClass: '1DES', criterios: { mediaMinima: 7 } })).status, 200);
    assert.equal(db.memory.auditLogs.length, before);
});

// Grupos de alunos (fase 3, C12 / P5-S4, CRIT-11): criar, alterar (com quem entrou e
// saiu), arquivar, reativar e sortear ficam na trilha, na categoria 'academic', com o
// curso e a turma do grupo e o professor como ator. Alterar sem mudar nada não grava.
test('[UC-GRUPO-001] grupos: criar, alterar, arquivar, reativar e sortear ficam na trilha', async () => {
    db.memory.classGroups = [];
    db.memory.students.push({ name: 'Bia', email: 'bia@cobertura.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: COURSE }] });
    const created = await professor(request(app).post('/api/admin/class-groups')).send({ courseId: COURSE, studentClass: '1DES', nome: 'Equipe 1', membros: ['ana@cobertura.local'] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.grupo.id;
    const updated = await professor(request(app).post(`/api/admin/class-groups/${id}/update`)).send({ adicionar: ['bia@cobertura.local'], atualizadoEm: created.body.grupo.atualizadoEm });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.deepEqual(last('class_group_updated').details.adicionados, ['bia@cobertura.local']);
    const before = db.memory.auditLogs.length;
    const same = await professor(request(app).post(`/api/admin/class-groups/${id}/update`)).send({ nome: 'Equipe 1', atualizadoEm: updated.body.grupo.atualizadoEm });
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.equal(same.body.changed, false);
    assert.equal(db.memory.auditLogs.length, before, 'sem mudança, sem entrada');
    assert.equal((await professor(request(app).post(`/api/admin/class-groups/${id}/archive`)).send({ motivo: 'Fim do projeto' })).status, 200);
    assert.equal(last('class_group_archived').details.motivo, 'Fim do projeto');
    assert.equal((await professor(request(app).post(`/api/admin/class-groups/${id}/restore`)).send({})).status, 200);
    const proposal = await professor(request(app).post('/api/admin/class-groups/draw')).send({ courseId: COURSE, studentClass: '1DES', conjunto: 'Seminário', criterio: 'quantidade', valor: 2 });
    assert.equal(proposal.status, 200, JSON.stringify(proposal.body));
    const drawn = await professor(request(app).post('/api/admin/class-groups/draw')).send({ courseId: COURSE, studentClass: '1DES', conjunto: 'Seminário', criterio: 'quantidade', valor: 2, semente: proposal.body.semente, assinatura: proposal.body.assinatura, confirmar: true });
    assert.equal(drawn.status, 201, JSON.stringify(drawn.body));
    for (const action of ['class_group_created', 'class_group_updated', 'class_group_archived', 'class_group_restored', 'class_groups_drawn']) {
        const entry = last(action);
        assert.ok(entry, action);
        assert.equal(entry.category, 'academic', action);
        assert.equal(entry.courseId, COURSE, action);
        assert.equal(entry.studentClass, '1DES', action);
        assert.equal(entry.actor, 'prof@cobertura.local', action);
    }
    assert.equal(last('class_groups_drawn').details.semente, proposal.body.semente);
});

// Conversas com professores (fase 3, C13 / P5-S7a, FUN-14): encerrar e reabrir ficam na
// trilha do aluno (categoria 'student', com o curso, a turma e o e-mail dele), e a leitura
// pela administração de conversa de outro professor fica na de privacidade. Mensagem não
// entra na trilha (o texto fica só na conversa).
test('[UC-MENSAGEM-002] mensagens: encerrar, reabrir e a leitura pela administração ficam na trilha; mensagem não', async () => {
    db.memory.conversations = [];
    db.memory.conversationMessages = [];
    const started = await professor(request(app).post('/api/admin/conversations')).send({ courseId: COURSE, studentClass: '1DES', studentEmail: 'ana@cobertura.local', assunto: 'Recuperação', texto: 'Ana, vamos combinar a recuperação?' });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const id = started.body.conversa.id;
    assert.equal(db.memory.auditLogs.filter(entry => /^conversation_/.test(entry.action)).length, 0, 'mensagem não entra na trilha');
    assert.equal((await professor(request(app).post(`/api/admin/conversations/${id}/close`)).send({ motivo: 'Combinado em sala' })).status, 200);
    assert.equal((await professor(request(app).post(`/api/admin/conversations/${id}/reopen`)).send({})).status, 200);
    for (const action of ['conversation_closed', 'conversation_reopened']) {
        const entry = last(action);
        assert.ok(entry, action);
        assert.equal(entry.category, 'student', action);
        assert.equal(entry.studentEmail, 'ana@cobertura.local', action);
        assert.equal(entry.courseId, COURSE, action);
        assert.equal(entry.studentClass, '1DES', action);
        assert.equal(entry.actor, 'prof@cobertura.local', action);
        assert.equal(entry.details.conversationId, id, action);
    }
    assert.equal(last('conversation_closed').details.motivo, 'Combinado em sala');
    assert.equal((await admin(request(app).get(`/api/admin/conversations/${id}/messages`))).status, 403);
    assert.equal((await admin(request(app).post(`/api/admin/conversations/${id}/admin-open`)).send({})).status, 200);
    const opened = last('conversation_read_by_admin');
    assert.equal(opened.category, 'privacy');
    assert.equal(opened.actor, 'admin@cobertura.local');
    assert.equal(opened.details.conversationId, id);
    assert.equal((await admin(request(app).get(`/api/admin/conversations/${id}/messages`))).status, 200);
});
