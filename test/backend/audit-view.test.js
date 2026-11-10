// Tela Auditoria, exportação em CSV e motivo ao mudar nota publicada (H7a-2; SEG-07,
// FUN-04). A trilha é só do administrador (audit.view, decisão P5): o professor recebe
// 403 na tela, na exportação e na aba Auditoria da ficha do aluno, e continua vendo o
// histórico de cada nota em Resultados.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-audit-view-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

// Módulos novos antes do servidor: server.js registra o process.on('uncaughtException'),
// que engoliria a falha destes require e o arquivo passaria sem rodar nenhum teste.
const { parseAuditQuery, zonedDayStart } = require('../../backend/routes/adminAudit.js');
const { gradeChangeReason, GRADE_REASON_REQUIRED_MESSAGE } = require('../../backend/utils/gradebook.js');
const { canAccessAdminPermission, parseAdditionalPermissions } = require('../../backend/utils/adminPermissions.js');
if (typeof gradeChangeReason !== 'function' || typeof zonedDayStart !== 'function') throw new Error('H7a-2: gradeChangeReason e zonedDayStart ausentes.');
const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');

const adminToken = 'admin-token-audit-view';
const professorToken = 'professor-token-audit-view';
const COURSE = 'curso-auditoria';
const DAY = 24 * 60 * 60 * 1000;
let app;

const admin = req => req.set('x-admin-session', adminToken);
const professor = req => req.set('x-admin-session', professorToken);
const entries = action => (db.memory.auditLogs || []).filter(entry => entry.action === action);

function question(number) {
    return { originalNumber: number, text: `Questão ${number}`, correctAnswer: 'A', alternatives: ['A', 'B'].map(letter => ({ letter, text: `Alternativa ${letter}` })) };
}

// Trilha com os formatos que existem nos bancos: canônico, de prova (type/at), de
// backup antigo (type/actorEmail/at e dados soltos) e do cadastro do aluno sem categoria.
const T = Date.parse('2026-03-10T15:00:00.000Z');
function legacyTrail() {
    return [
        { id: 'a_cadastro', actor: 'admin@auditoria.local', studentEmail: 'ana@auditoria.local', action: 'update', field: 'Telefone', oldValue: '(81) 1111', newValue: '(81) 2222', timestamp: T - 2 * DAY },
        { id: 'a_backup', type: 'backup_download', actorEmail: 'admin@auditoria.local', at: new Date(T - DAY).toISOString(), file: 'backup.json', size: 10 },
        { id: 'a_prova', type: 'exam_application_finished', actor: 'prof@auditoria.local', at: new Date(T).toISOString(), applicationId: 'app_1', examKey: 'Avaliacao_P1', courseId: COURSE, studentClass: '1DES', details: { submitted: 2 } },
        { id: 'a_nota', action: 'grade_update', category: 'grade', actor: 'prof@auditoria.local', actorRole: 'professor', timestamp: T + DAY, studentEmail: 'ana@auditoria.local', courseId: COURSE, studentClass: '1DES', examKey: 'Avaliacao_P1', applicationId: 'app_1', submissionId: 's1', field: 'Nota', oldValue: '5,0', newValue: '=1+1', reason: 'Revisão pedida pela aluna', ip: '10.0.0.5' },
        { id: 'a_config', action: 'settings_updated', category: 'system', actor: 'admin@auditoria.local', timestamp: T + 2 * DAY, details: { changes: [{ key: 'timezone', before: 'America/Sao_Paulo', after: 'America/Recife' }] } },
    ];
}

function seed() {
    db.memory.admins = [
        { email: 'admin@auditoria.local', name: 'Coordenação', role: 'admin', password: db.hashPassword('x') },
        { email: 'prof@auditoria.local', name: 'Professora Júlia', role: 'professor', password: db.hashPassword('x'), assignedClasses: [{ courseId: COURSE, className: '1DES' }] },
    ];
    db.memory.adminSessions = {
        [adminToken]: { email: 'admin@auditoria.local', createdAt: Date.now(), lastSeen: Date.now() },
        [professorToken]: { email: 'prof@auditoria.local', createdAt: Date.now(), lastSeen: Date.now() },
    };
    db.memory.courses = [{ id: COURSE, name: 'Desenvolvimento', structure: [{ id: 'm1', name: 'Módulo 1', units: [{ key: 'u1', name: 'Prova 1', avaliacaoKey: 'Avaliacao_P1' }] }] }];
    db.memory.classes = [{ name: '1DES', courseId: COURSE, period: 'Manhã' }];
    db.memory.students = [{ name: 'Ana Souza', email: 'ana@auditoria.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: COURSE }] }];
    db.memory.evaluations = { Avaliacao_P1: { title: 'Prova 1 — Fundamentos', questions: [question(1), question(2)] } };
    db.memory.examApplications = [{ id: 'app_1', examKey: 'Avaliacao_P1', studentClass: '1DES', courseId: COURSE, status: 'finished', createdAt: '2026-03-10T10:00:00.000Z' }];
    db.memory.submissions = [];
    db.memory.sessions = {};
    db.memory.auditLogs = legacyTrail();
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

// ------------------------------------------------------------ permissão
test('[UC-AUDITORIA-003] audit.view é só do administrador: o professor recebe 403 na tela, no CSV e na aba da ficha', async () => {
    const professorAccount = db.memory.admins[1];
    assert.equal(canAccessAdminPermission(db.memory.admins[0], 'audit.view'), true);
    assert.equal(canAccessAdminPermission(professorAccount, 'audit.view'), false);
    assert.equal(parseAdditionalPermissions(['audit.view']).ok, false, 'não pode ser concedida ao professor');

    for (const url of ['/api/admin/audit', '/api/admin/audit/export', '/api/admin/student/audit?email=ana@auditoria.local']) {
        const denied = await professor(request(app).get(url));
        assert.equal(denied.status, 403, `${url}: antes a aba da ficha respondia 200 para o professor`);
        assert.equal(JSON.stringify(denied.body).includes('Telefone'), false);
        assert.equal((await admin(request(app).get(url))).status, 200, url);
    }
    // Mesmo com a permissão extra gravada à mão no banco, continua 403.
    professorAccount.additionalPermissions = ['audit.view'];
    assert.equal((await professor(request(app).get('/api/admin/audit'))).status, 403);
    assert.equal(entries('audit_exported').length, 1, 'só a exportação do administrador fica registrada');
});

test('[UC-AUDITORIA-003] o professor continua vendo o histórico da nota, com o motivo, em Resultados', async () => {
    const created = await professor(request(app).post('/api/admin/submissions/create')).send({ studentEmail: 'ana@auditoria.local', examKey: 'Avaliacao_P1', grade: 6, courseId: COURSE, studentClass: '1DES', type: 'impressa' });
    assert.equal(created.status, 200, created.body.error);
    const id = created.body.submissionId;
    assert.equal((await professor(request(app).post('/api/admin/submissions/publish')).send({ ids: [id], published: true })).status, 200);
    assert.equal((await professor(request(app).post('/api/admin/submissions/publish')).send({ ids: [id], published: false, reason: 'Nota lançada antes da revisão' })).status, 200);
    const review = await professor(request(app).get(`/api/admin/submissions/${id}/review`));
    assert.equal(review.status, 200);
    const hide = review.body.history.find(entry => entry.reason);
    assert.ok(hide, 'o histórico da nota traz o motivo');
    assert.equal(hide.reason, 'Nota lançada antes da revisão');
    assert.equal(hide.field, 'Publicação da nota');
});

// ------------------------------------------------------------ tela
test('[UC-AUDITORIA-003] GET /api/admin/audit lê os formatos antigos, do mais novo para o mais antigo, com os nomes', async () => {
    const response = await admin(request(app).get('/api/admin/audit?facets=1'));
    assert.equal(response.status, 200);
    assert.equal(response.body.total, 5);
    assert.deepEqual(response.body.items.map(item => item.id), ['a_config', 'a_nota', 'a_prova', 'a_backup', 'a_cadastro']);
    const byId = Object.fromEntries(response.body.items.map(item => [item.id, item]));
    assert.equal(byId.a_backup.action, 'backup_download');
    assert.equal(byId.a_backup.actor, 'admin@auditoria.local');
    assert.equal(byId.a_backup.timestamp, T - DAY);
    assert.equal(byId.a_backup.category, 'backup');
    assert.deepEqual(byId.a_backup.details, { file: 'backup.json', size: 10 });
    assert.equal(byId.a_cadastro.category, 'student');
    assert.equal(byId.a_cadastro.studentName, 'Ana Souza');
    assert.equal(byId.a_prova.category, 'exam');
    assert.equal(byId.a_nota.actorName, 'Professora Júlia');
    assert.equal(byId.a_nota.courseName, 'Desenvolvimento');
    assert.equal(byId.a_nota.examTitle, 'Prova 1 — Fundamentos');
    assert.equal(byId.a_nota.reason, 'Revisão pedida pela aluna');
    assert.equal(byId.a_nota.categoryLabel, 'Notas');
    // Opções dos filtros saem da própria trilha.
    const { facets } = response.body;
    assert.ok(facets.actors.some(item => item.value === 'prof@auditoria.local' && /Professora Júlia/.test(item.label)));
    assert.deepEqual(facets.exams.map(item => item.value), ['Avaliacao_P1']);
    assert.deepEqual(facets.applications.map(item => item.value), ['app_1']);
    assert.match(facets.applications[0].label, /Prova 1 — Fundamentos · 1DES/);
    assert.ok(facets.categories.some(item => item.value === 'grade'));
    // Ler não muda a trilha gravada.
    assert.deepEqual(db.memory.auditLogs, legacyTrail());
});

test('[UC-AUDITORIA-003] filtros: período no fuso, categoria, quem fez, aluno, prova, aplicação, turma e busca sem acento', async () => {
    const ids = async query => (await admin(request(app).get(`/api/admin/audit?${query}`))).body.items.map(item => item.id);
    // 10/03 às 12:00 em São Paulo é 15:00 UTC: o dia 10 inteiro, no fuso das configurações.
    assert.deepEqual(await ids('from=2026-03-10&to=2026-03-10'), ['a_prova']);
    assert.deepEqual(await ids('from=2026-03-09'), ['a_config', 'a_nota', 'a_prova', 'a_backup']);
    assert.deepEqual(await ids('to=2026-03-09'), ['a_backup', 'a_cadastro']);
    assert.deepEqual(await ids('category=grade'), ['a_nota']);
    assert.deepEqual(await ids('category=exam'), ['a_prova']);
    assert.deepEqual(await ids('actor=prof@auditoria.local'), ['a_nota', 'a_prova']);
    assert.deepEqual(await ids('actor=julia'), ['a_nota', 'a_prova'], 'pedaço do nome, sem acento');
    assert.deepEqual(await ids('student=ana@auditoria.local'), ['a_nota', 'a_cadastro']);
    assert.deepEqual(await ids('student=Souza'), ['a_nota', 'a_cadastro']);
    assert.deepEqual(await ids('examKey=Avaliacao_P1'), ['a_nota', 'a_prova']);
    assert.deepEqual(await ids('applicationId=app_1'), ['a_nota', 'a_prova']);
    assert.deepEqual(await ids('applicationId=app_outra'), []);
    assert.deepEqual(await ids(`courseId=${COURSE}&studentClass=1des`), ['a_nota', 'a_prova']);
    assert.deepEqual(await ids('q=revisao'), ['a_nota'], 'motivo, sem acento');
    assert.deepEqual(await ids('q=telefone'), ['a_cadastro']);
    // Página: offset e limit, com o total de tudo o que passou.
    const page = await admin(request(app).get('/api/admin/audit?limit=2&offset=1'));
    assert.deepEqual([page.body.total, page.body.items.map(item => item.id)], [5, ['a_nota', 'a_prova']]);
});

test('[UC-AUDITORIA-003] filtro inválido responde 400 com o campo', async () => {
    for (const [query, field] of [['from=2026-02-30', 'from'], ['to=10/03/2026', 'to'], ['from=2026-03-10&to=2026-03-09', 'from'], ['category=qualquer', 'category']]) {
        const response = await admin(request(app).get(`/api/admin/audit?${query}`));
        assert.equal(response.status, 400, query);
        assert.equal(response.body.success, false);
        assert.equal(response.body.field, field);
        assert.match(response.body.error, /[áéíóúãç]|inválida|desconhecida/);
        assert.equal((await admin(request(app).get(`/api/admin/audit/export?${query}`))).status, 400);
    }
    assert.equal(entries('audit_exported').length, 0, 'exportação recusada não grava');
    // A query repetida vale pelo último valor (H9a).
    const repeated = await admin(request(app).get('/api/admin/audit?category=exam&category=grade'));
    assert.deepEqual(repeated.body.items.map(item => item.id), ['a_nota']);
});

test('[UC-AUDITORIA-003] parseAuditQuery e zonedDayStart: dia inteiro no fuso, inclusive no fim do horário de verão', () => {
    assert.equal(zonedDayStart({ year: 2026, month: 3, day: 10 }, 'America/Sao_Paulo'), Date.parse('2026-03-10T03:00:00.000Z'));
    assert.equal(zonedDayStart({ year: 2026, month: 3, day: 10 }, 'UTC'), Date.parse('2026-03-10T00:00:00.000Z'));
    // Nova York muda para o horário de verão em 08/03/2026.
    assert.equal(zonedDayStart({ year: 2026, month: 3, day: 8 }, 'America/New_York'), Date.parse('2026-03-08T05:00:00.000Z'));
    assert.equal(zonedDayStart({ year: 2026, month: 3, day: 9 }, 'America/New_York'), Date.parse('2026-03-09T04:00:00.000Z'));
    const parsed = parseAuditQuery({ from: '2026-03-10', to: '2026-03-10', limit: '9999', offset: '-4' }, { timeZone: 'America/Sao_Paulo' });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.toMs - parsed.fromMs, DAY);
    assert.equal(parsed.limit, 500);
    assert.equal(parsed.offset, 0);
});

// ------------------------------------------------------------ CSV
function parseCsv(text) {
    assert.equal(text.charCodeAt(0), 0xFEFF, 'CSV começa com BOM UTF-8 para o Excel');
    return text.slice(1).replace(/\r\n$/, '').split(/\r\n/).map(line => line.split(';'));
}

test('[UC-AUDITORIA-003] exportar CSV: padrão do Excel pt-BR, fórmula neutralizada, mesmos filtros e registro audit_exported', async () => {
    const response = await admin(request(app).get('/api/admin/audit/export?category=grade')).buffer(true).parse((res, done) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks).toString('utf8')));
    });
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /text\/csv; charset=utf-8/);
    assert.match(response.headers['content-disposition'], /attachment; filename="auditoria_\d{4}-\d{2}-\d{2}\.csv"/);
    const rows = parseCsv(response.body);
    assert.deepEqual(rows[0], ['Data/hora', 'Quem', 'Ação', 'Categoria', 'Aluno', 'Curso', 'Turma', 'Prova', 'Aplicação', 'Antes', 'Depois', 'Motivo', 'IP']);
    assert.equal(rows.length, 2, 'só a categoria pedida');
    const row = rows[1];
    assert.equal(row[0], '11/03/2026 12:00:00', 'hora no fuso das configurações');
    assert.equal(row[1], 'Professora Júlia (prof@auditoria.local)');
    assert.equal(row[4], 'Ana Souza (ana@auditoria.local)');
    assert.equal(row[5], 'Desenvolvimento');
    assert.equal(row[7], 'Prova 1 — Fundamentos');
    assert.equal(row[8], 'app_1');
    assert.equal(row[9], '5,0');
    assert.equal(row[10], "'=1+1", 'fórmula vira texto');
    assert.equal(row[11], 'Revisão pedida pela aluna');
    assert.equal(row[12], '10.0.0.5');

    const exported = entries('audit_exported');
    assert.equal(exported.length, 1);
    assert.equal(exported[0].actor, 'admin@auditoria.local');
    assert.equal(exported[0].category, 'system');
    assert.deepEqual(exported[0].details, { filters: { category: 'grade' }, rows: 1 });

    // Configurações: antes e depois saem das mudanças.
    const all = parseCsv((await admin(request(app).get('/api/admin/audit/export'))).text);
    const settings = all.find(line => line[2] === 'Configurações alteradas');
    assert.ok(settings, all.map(line => line[2]).join(' | '));
    assert.deepEqual([settings[9], settings[10]], ['timezone: America/Sao_Paulo', 'timezone: America/Recife']);
});

test('[UC-AUDITORIA-003] exportação acima do limite pede para filtrar por período', async () => {
    const base = Date.parse('2026-01-01T12:00:00.000Z');
    db.memory.auditLogs = Array.from({ length: 50001 }, (_, index) => ({ id: `x${index}`, action: 'update', actor: 'admin@auditoria.local', timestamp: base + index }));
    const response = await admin(request(app).get('/api/admin/audit/export'));
    assert.equal(response.status, 400);
    assert.equal(response.body.field, 'from');
    assert.match(response.body.error, /Filtre por período/);
    assert.equal(entries('audit_exported').length, 0);
});

// ------------------------------------------------------------ motivo
async function publishedGrade(grade = 7) {
    const created = await admin(request(app).post('/api/admin/submissions/create')).send({ studentEmail: 'ana@auditoria.local', examKey: 'Avaliacao_P1', grade, courseId: COURSE, studentClass: '1DES', type: 'impressa' });
    assert.equal(created.status, 200, created.body.error);
    const id = created.body.submissionId;
    assert.equal((await admin(request(app).post('/api/admin/submissions/publish')).send({ ids: [id], published: true })).status, 200, 'publicar não pede motivo');
    return id;
}

test('[UC-AUDITORIA-004] nota já publicada: mudar a regra, escolher, ocultar ou excluir sem motivo responde 400 e nada muda', async () => {
    const id = await publishedGrade();
    const trailBefore = db.memory.auditLogs.length;
    const stored = () => db.memory.submissions.find(item => item.id === id);
    const before = JSON.stringify(stored());

    const attempts = [
        ['/api/admin/submissions/result-control', { submissionId: id, action: 'policy', policy: 'average' }],
        ['/api/admin/submissions/result-control', { submissionId: id, action: 'archive' }],
        ['/api/admin/submissions/result-control', { submissionId: id, action: 'select', reason: '  ' }],
        ['/api/admin/submissions/publish', { ids: [id], published: false }],
        ['/api/admin/submissions/delete', { id }],
    ];
    for (const [url, body] of attempts) {
        const response = await admin(request(app).post(url)).send(body);
        assert.equal(response.status, 400, `${url} ${JSON.stringify(body)}`);
        assert.equal(response.body.success, false);
        assert.equal(response.body.code, 'reason_required');
        assert.equal(response.body.field, 'reason');
        assert.equal(response.body.error, GRADE_REASON_REQUIRED_MESSAGE);
    }
    const short = await admin(request(app).post('/api/admin/submissions/delete')).send({ id, reason: 'ok' });
    assert.equal(short.status, 400);
    assert.equal(short.body.code, 'reason_required');
    assert.match(short.body.error, /pelo menos 3 letras/);
    const wrongType = await admin(request(app).post('/api/admin/submissions/delete')).send({ id, reason: { texto: 'x' } });
    assert.equal(wrongType.status, 400);
    assert.equal(wrongType.body.field, 'reason');

    assert.equal(JSON.stringify(stored()), before, 'a nota não mudou');
    assert.equal(db.memory.auditLogs.length, trailBefore, 'nada foi registrado');
    // Ação inválida continua com a mensagem dela (não vira pedido de motivo).
    const invalid = await admin(request(app).post('/api/admin/submissions/result-control')).send({ submissionId: id, action: 'qualquer' });
    assert.equal(invalid.status, 400);
    assert.notEqual(invalid.body.code, 'reason_required');
});

test('[UC-AUDITORIA-004] com o motivo a mudança passa e o motivo fica na entrada da auditoria', async () => {
    const id = await publishedGrade();
    const policy = await admin(request(app).post('/api/admin/submissions/result-control')).send({ submissionId: id, action: 'policy', policy: 'average', reason: '  Média combinada com a turma  ' });
    assert.equal(policy.status, 200, policy.body.error);
    assert.equal(entries('grade_result_policy').pop().reason, 'Média combinada com a turma');

    const hidden = await admin(request(app).post('/api/admin/submissions/publish')).send({ ids: [id], published: false, reason: 'Revisão da correção' });
    assert.equal(hidden.status, 200, hidden.body.error);
    assert.equal(entries('grade_unpublish').pop().reason, 'Revisão da correção');
    assert.equal(db.memory.submissions.find(item => item.id === id).gradePublished, false);

    // Nota que não está publicada: sem motivo.
    assert.equal((await admin(request(app).post('/api/admin/submissions/result-control')).send({ submissionId: id, action: 'select' })).status, 200);
    assert.equal((await admin(request(app).post('/api/admin/submissions/delete')).send({ id })).status, 200);
    assert.equal(entries('grade_delete').pop().reason, undefined);

    const other = await publishedGrade(8);
    const removed = await admin(request(app).post('/api/admin/submissions/delete')).send({ id: other, reason: 'Lançada no aluno errado' });
    assert.equal(removed.status, 200, removed.body.error);
    const deletion = entries('grade_delete').pop();
    assert.equal(deletion.reason, 'Lançada no aluno errado');
    // A lixeira de notas mostra a exclusão; a tela Auditoria acha pelo motivo.
    const found = await admin(request(app).get('/api/admin/audit?q=aluno%20errado'));
    assert.deepEqual(found.body.items.map(item => item.id), [deletion.id]);
});

test('[UC-AUDITORIA-004] gradeChangeReason: texto aparado e cortado em 500, obrigatório só quando pedido', () => {
    assert.deepEqual(gradeChangeReason({}), { ok: true, reason: '' });
    assert.deepEqual(gradeChangeReason({ reason: '  abc ' }, { required: true }), { ok: true, reason: 'abc' });
    assert.equal(gradeChangeReason({ reason: 'x'.repeat(900) }).reason.length, 500);
    assert.equal(gradeChangeReason({ reason: 12 }).ok, false);
    assert.equal(gradeChangeReason({}, { required: true }).body.code, 'reason_required');
    assert.equal(gradeChangeReason(null, { required: true }).ok, false);
});
