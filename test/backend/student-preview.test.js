// Fase 3, P5-S6a (CRIT-08): "Ver como aluno" no servidor. O instrutor abre uma sessão de
// leitura de uma turma (POST /api/admin/preview-sessions) e o portal, com o cabeçalho
// x-preview-session, responde como a um aluno daquela turma sem exceções individuais,
// sem gravar nada. Antes não havia prévia nenhuma: o professor precisava criar um aluno
// de teste, que sujava presença, progresso e registros.
//
// [UC-PREVIA-001] abrir e encerrar a prévia (escopo, token só em hash, Sair, troca de
//   senha, 60 min, restauração).
// [UC-PREVIA-002] a prévia vê o mesmo que um aluno real da turma sem exceções.
// [UC-PREVIA-003] nada grava: passeio por todas as rotas fora de /api/admin pela pilha do
//   Express; rota nova sem decisão nesta tabela falha o teste (contrato C4 do P5).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const express = require('express');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-preview-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

// Módulos antes do servidor: server.js registra o process.on('uncaughtException'), que
// engoliria a falha destes require.
const db = require('../../backend/database.js');
const runtimePaths = require('../../backend/runtimePaths.js');
const previewAccess = require('../../backend/utils/previewAccess.js');
const { PREVIEW_READ_ROUTES, isPreviewReadRoute } = previewAccess;
const { createApp } = require('../../backend/server.js');

const COURSE = 'curso-previa';
const CLASS = '1DES';
const OTHER_CLASS = '2DES';
const Q = `courseId=${COURSE}&studentClass=${CLASS}`;
const VARIANT_KEY = 'Ap_1__turma_previa';
const tokens = {
    admin: 'admin-token-previa',
    prof: 'prof-token-previa',
    prof2: 'prof2-token-previa',
    coord: 'coord-token-previa',
    ana: 'ana-token-previa',
    bia: 'bia-token-previa',
};
const ASSIGNMENT_ID = 'asg_1700000000000_abcdef';
const ANA = 'ana@previa.local';
const BIA = 'bia@previa.local';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let app;

function writeFiles() {
    const content = process.env.ICLASS_CONTENT_DIR;
    fs.mkdirSync(path.join(content, 'imagens'), { recursive: true });
    fs.mkdirSync(runtimePaths.UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(content, 'Ap_1.md'), '# Unidade 1 (curso)\n');
    fs.writeFileSync(path.join(content, `${VARIANT_KEY}.md`), '# Unidade 1 (versão da turma)\n\n![Figura](imagens/figura.png)\n');
    fs.writeFileSync(path.join(content, 'Ap_2.md'), '# Unidade 2 (oculta para a turma)\n');
    fs.writeFileSync(path.join(content, 'Ap_3.md'), '# Unidade 3\n');
    fs.writeFileSync(path.join(content, 'imagens', 'figura.png'), PNG);
    fs.writeFileSync(path.join(runtimePaths.UPLOADS_DIR, 'material.pdf'), '%PDF-1.4\n');
    fs.writeFileSync(path.join(runtimePaths.UPLOADS_DIR, 'oculto.pdf'), '%PDF-1.4\n');
}

function seed() {
    const now = Date.now();
    db.memory.admins = [
        { email: 'admin@previa.local', name: 'Admin', role: 'admin', password: db.hashPassword('Senha-Antiga-2026') },
        { email: 'prof@previa.local', name: 'Professora', role: 'professor', password: db.hashPassword('Senha-Antiga-2026'),
            assignedClasses: [{ courseId: COURSE, className: CLASS }] },
        { email: 'prof2@previa.local', name: 'Outro professor', role: 'professor', password: db.hashPassword('Senha-Antiga-2026'),
            assignedClasses: [{ courseId: COURSE, className: OTHER_CLASS }] },
        { email: 'coord@previa.local', name: 'Coordenação', role: 'coordenacao', password: db.hashPassword('Senha-Antiga-2026'),
            assignedSchoolIds: ['escola_a'] },
    ];
    db.memory.adminSessions = {};
    for (const [name, email] of [['admin', 'admin@previa.local'], ['prof', 'prof@previa.local'], ['prof2', 'prof2@previa.local'], ['coord', 'coord@previa.local']]) {
        db.memory.adminSessions[tokens[name]] = { email, createdAt: now, lastSeen: now };
    }
    db.memory.schools = [{ id: 'escola_a', name: 'Escola A', info: {}, branding: {} }];
    db.memory.courses = [{ id: COURSE, name: 'Desenvolvimento', schoolId: 'escola_a', structure: [{ id: 'm1', name: 'Módulo 1', units: [
        { id: 'u1', name: 'Unidade 1', apostilaKey: 'Ap_1' },
        { id: 'u2', name: 'Unidade 2', apostilaKey: 'Ap_2' },
        { id: 'u3', name: 'Unidade 3', apostilaKey: 'Ap_3', avaliacaoKey: 'Avaliacao_P1' },
        { id: 'u4', name: 'Prova antiga', avaliacaoKey: 'Avaliacao_P2' },
    ] }] }];
    db.memory.classes = [
        {
            name: CLASS, courseId: COURSE, period: 'Manhã',
            // Unidade 2 oculta para a turma e liberada só para a Ana (exceção individual).
            releasedItems: { Ap_2: false },
            studentReleasedItems: { [ANA]: { Ap_2: true } },
            // Variante de conteúdo da turma: a Unidade 1 tem a versão própria da 1DES.
            contentOverrides: { materials: { Ap_1: { key: VARIANT_KEY } } },
            onlineExamConfigs: {
                Avaliacao_P1: { applicationId: 'app_1', onlineActive: true, timerEnabled: false, updatedAt: '2026-11-18T10:00:00.000Z' },
                // Prova do formato antigo, sem aplicação: o sync de antes gravava um estado.
                Avaliacao_P2: { onlineActive: true, timerEnabled: false, updatedAt: '2026-11-18T10:00:00.000Z' },
            },
        },
        { name: OTHER_CLASS, courseId: COURSE, period: 'Tarde', releasedItems: {}, onlineExamConfigs: {} },
    ];
    db.memory.examApplications = [{
        id: 'app_1', examKey: 'Avaliacao_P1', courseId: COURSE, studentClass: CLASS, status: 'running',
        timerEnabled: false, timerMode: 'collective', durationMinutes: 60, maxAttempts: null,
        createdAt: new Date(now - 60000).toISOString(), startedAt: new Date(now - 60000).toISOString(),
    }];
    db.memory.evaluations = {
        Avaliacao_P1: { title: 'Prova 1', questions: [{ originalNumber: 1, text: 'Q1', correctAnswer: 'A', alternatives: [{ letter: 'A', text: 'a' }, { letter: 'B', text: 'b' }] }] },
        Avaliacao_P2: { title: 'Prova 2', questions: [{ originalNumber: 1, text: 'Q1', correctAnswer: 'A', alternatives: [{ letter: 'A', text: 'a' }, { letter: 'B', text: 'b' }] }] },
    };
    db.memory.studentExamState = {};
    db.memory.students = [
        { id: 'alu_00000000000000a1', name: 'Ana', email: ANA, status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: CLASS, courseId: COURSE }], studentClass: CLASS },
        { id: 'alu_00000000000000b2', name: 'Bia', email: BIA, status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: CLASS, courseId: COURSE }], studentClass: CLASS },
    ];
    db.memory.sessions = {
        [ANA]: { token: tokens.ana, createdAt: now, lastSeen: now, ip: '::ffff:127.0.0.1' },
        [BIA]: { token: tokens.bia, createdAt: now, lastSeen: now, ip: '::ffff:127.0.0.1' },
    };
    db.memory.library = [
        { id: 'lib_1', name: 'Material', filename: 'material.pdf', url: '/uploads/material.pdf', kind: 'file', type: 'pdf', courseId: COURSE, createdAt: 1 },
        { id: 'lib_2', name: 'Oculto', filename: 'oculto.pdf', url: '/uploads/oculto.pdf', kind: 'file', type: 'pdf', courseId: COURSE, studentClass: CLASS, hidden: true, createdAt: 2 },
    ];
    db.memory.announcements = [
        { id: 'av_turma', title: 'Aviso da turma', message: 'Para a 1DES', target: 'turma', targetValue: CLASS, courseId: COURSE, createdAt: now - 1000, readBy: [] },
        { id: 'av_ana', title: 'Só para a Ana', message: 'Particular', target: 'aluno', targetValue: ANA, courseId: COURSE, studentClass: CLASS, createdAt: now - 500, readBy: [] },
        { id: 'ev_turma', kind: 'calendar', title: 'Visita técnica', message: '', target: 'turma', targetValue: CLASS, courseId: COURSE, eventDate: '2099-01-10', startTime: '08:00', createdAt: now - 800 },
    ];
    // Dúvida antiga da Ana sem curso nem turma: a lista do fórum grava a turma inferida
    // (migração), o que a prévia não pode fazer.
    db.memory.forum = [{ id: 'c_1', key: 'Ap_3', studentEmail: ANA, studentName: 'Ana', text: 'Como faz?', timestamp: new Date(now - 5000).toISOString(), replies: [] }];
    db.memory.submissions = [];
    db.memory.progress = { [ANA]: { Ap_3: true } };
    db.memory.notes = { [ANA]: { Ap_3: 'Anotação da Ana' } };
    db.memory.annotations = {};
    db.memory.attendance = [];
    db.memory.moduleAccess = [];
    // Formato do modelo do P5 (modelo_de_dados.classGroups): membros com e-mail e id,
    // arquivadoEm em ms (null = ativo).
    const member = (email, studentId) => ({ email, studentId, adicionadoEm: now - 5000, adicionadoPor: 'prof@previa.local' });
    const groupRow = (id, nome, extra = {}) => ({
        id, schemaVersion: 1, courseId: COURSE, studentClass: CLASS, nome, conjunto: 'Laboratório', tipo: 'subturma',
        membros: [member(BIA, 'alu_00000000000000b2')], criadoEm: now - 6000, criadoPor: 'prof@previa.local',
        atualizadoEm: now - 6000, atualizadoPor: 'prof@previa.local', arquivadoEm: null, arquivadoPor: null, ...extra,
    });
    db.memory.classGroups = [
        groupRow('grp_1', 'Laboratório A'),
        groupRow('grp_arq', 'Arquivado', { arquivadoEm: now - 1, arquivadoPor: 'prof@previa.local' }),
        groupRow('grp_outra', 'Da 2DES', { studentClass: OTHER_CLASS }),
    ];
    // Tarefa publicada da turma com a entrega da Ana (fase 3, C5): a prévia vê a tarefa
    // como um aluno sem entrega e não envia nem baixa arquivo.
    db.memory.assignments = [{
        id: ASSIGNMENT_ID, schemaVersion: 1, courseId: COURSE, studentClass: CLASS, title: 'Relatório', status: 'publicada',
        response: { files: true, text: true, link: false }, files: { maxFiles: 2, maxSizeMb: 5, types: ['pdf'], extraExtensions: [] },
        opensAt: null, dueAt: now + 3 * 86400000, closeAt: null, publishedAt: now - 10000, createdAt: now - 20000,
    }];
    db.memory.assignmentSubmissions = [{
        id: 'asub_1700000000000_abcdef', schemaVersion: 1, assignmentId: ASSIGNMENT_ID, courseId: COURSE, studentClass: CLASS,
        studentEmail: ANA, studentId: 'alu_00000000000000a1', status: 'enviada', createdAt: now - 5000, updatedAt: now - 5000,
        versions: [{ n: 1, requestAt: now - 5000, receivedAt: now - 5000, late: false, lateMs: 0, text: 'Da Ana', link: '', files: [] }],
    }];
    db.memory.auditLogs = [];
    delete db.memory.previewSessions;
}

async function openPreview(adminToken = tokens.prof, body = { courseId: COURSE, studentClass: CLASS }) {
    return request(app).post('/api/admin/preview-sessions').set('x-admin-session', adminToken).send(body);
}

async function previewToken(adminToken, body) {
    const response = await openPreview(adminToken, body);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
}

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const memoryHash = () => sha256(JSON.stringify(db.memory));

test.before(async () => {
    await db.init();
    writeFiles();
    app = createApp();
});
test.beforeEach(() => { seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 300));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// [UC-PREVIA-001] abrir e encerrar
// ---------------------------------------------------------------------------

test('[UC-PREVIA-001] professor da turma abre a prévia; token só em hash, rótulo e aluno virtual', async () => {
    const response = await openPreview();
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const { previewToken: token, expiraEm, rotulo, aluno } = response.body;
    assert.equal(typeof token, 'string');
    assert.ok(token.length >= 40);
    assert.equal(rotulo, 'Pré-visualização como aluno de 1DES');
    assert.ok(expiraEm > Date.now() + 59 * 60000 && expiraEm <= Date.now() + 60 * 60000, 'vale 60 min');
    assert.match(aluno.email, /^previa-[0-9a-f]{16}@previa\.invalid$/);
    assert.equal(aluno.name, 'Pré-visualização');
    assert.equal(aluno.preview, true);
    assert.deepEqual(aluno.classes, [{ name: CLASS, courseId: COURSE, period: 'Manhã' }]);
    assert.deepEqual(aluno.courses, [{ id: COURSE, name: 'Desenvolvimento', description: '', className: CLASS }]);

    // Só o hash na memória; o aluno virtual não entra no cadastro.
    assert.equal(JSON.stringify(db.memory).includes(token), false, 'token cru fora da memória');
    assert.deepEqual(Object.keys(db.memory.previewSessions), [sha256(token)]);
    assert.equal(db.memory.students.some(student => student.email === aluno.email), false);
    assert.equal(db.memory.students.length, 2);

    // Auditoria content_preview_started com a turma.
    const entry = db.memory.auditLogs.find(item => item.action === 'content_preview_started');
    assert.ok(entry, 'auditoria gravada');
    assert.equal(entry.courseId, COURSE);
    assert.equal(entry.studentClass, CLASS);
    assert.equal(entry.category, 'content');

    // O token da prévia não vale como sessão de aluno nem de instrutor.
    const asStudent = await request(app).get(`/api/student/dashboard?${Q}`).set('x-session-token', token);
    assert.equal(asStudent.status, 401);
    const asAdmin = await request(app).get('/api/admin/whoami').set('x-admin-session', token);
    assert.equal(asAdmin.status, 401);
    // E o token de aluno real não vale como prévia.
    const studentAsPreview = await request(app).get(`/api/student/dashboard?${Q}`).set('x-preview-session', tokens.ana);
    assert.equal(studentAsPreview.status, 401);
    assert.equal(studentAsPreview.body.code, 'preview_ended');
});

test('[UC-PREVIA-001] escopo: professor de outra turma 403, coordenação só consulta, turma e grupo conferidos', async () => {
    const outside = await openPreview(tokens.prof2);
    assert.equal(outside.status, 403);
    assert.equal(db.memory.previewSessions, undefined, 'nada aberto');

    const coord = await openPreview(tokens.coord);
    assert.equal(coord.status, 403);
    assert.equal(coord.body.code, 'read_only_account');

    const own = await openPreview(tokens.prof2, { courseId: COURSE, studentClass: OTHER_CLASS });
    assert.equal(own.status, 200);
    assert.equal(own.body.rotulo, 'Pré-visualização como aluno de 2DES');

    const missingClass = await openPreview(tokens.admin, { courseId: COURSE, studentClass: '9ZZZ' });
    assert.equal(missingClass.status, 404);
    const noBody = await openPreview(tokens.admin, { courseId: COURSE });
    assert.equal(noBody.status, 400);
    assert.equal(noBody.body.field, 'studentClass');

    const withGroup = await openPreview(tokens.prof, { courseId: COURSE, studentClass: CLASS, groupId: 'grp_1' });
    assert.equal(withGroup.status, 200);
    assert.equal(withGroup.body.rotulo, 'Pré-visualização como aluno de 1DES · grupo Laboratório A');
    assert.equal(withGroup.body.aluno.previewGroupId, 'grp_1');
    assert.equal(db.memory.auditLogs.filter(item => item.action === 'content_preview_started').pop().details.groupId, 'grp_1');
    for (const groupId of ['grp_arq', 'grp_outra', 'grp_inexistente']) {
        const refused = await openPreview(tokens.prof, { courseId: COURSE, studentClass: CLASS, groupId });
        assert.equal(refused.status, 404, groupId);
        assert.equal(refused.body.field, 'groupId');
    }
});

async function stillWorks(token) {
    return request(app).get(`/api/student/dashboard?${Q}`).set('x-preview-session', token);
}

test('[UC-PREVIA-001] a prévia acaba com o Sair do instrutor', async () => {
    const { previewToken: token } = await previewToken(tokens.prof);
    assert.equal((await stillWorks(token)).status, 200);
    const logout = await request(app).post('/api/session/logout').set('x-admin-session', tokens.prof).send({});
    assert.equal(logout.status, 200);
    const after = await stillWorks(token);
    assert.equal(after.status, 401);
    assert.equal(after.body.code, 'preview_ended');
    assert.equal(after.body.sessionRevoked, true);
    // Ajuste 2: a prévia fica no mapa (sem valer) para o portal saber o motivo.
    assert.equal(after.body.previewReason, 'admin_session');
    assert.equal(after.body.error, previewAccess.PREVIEW_ENDED_MESSAGES.admin_session);
    // Entrar de novo no painel não a revive.
    db.memory.adminSessions['prof-token-nova'] = { email: 'prof@previa.local', createdAt: Date.now(), lastSeen: Date.now() };
    assert.equal((await stillWorks(token)).status, 401);
});

test('[UC-PREVIA-001] a prévia acaba com a troca de senha do instrutor (também a da própria sessão)', async () => {
    const { previewToken: token } = await previewToken(tokens.prof);
    const change = await request(app).post('/api/admin/change-password').set('x-admin-session', tokens.prof)
        .send({ currentPassword: 'Senha-Antiga-2026', newPassword: 'Trocada#Segura-2026' });
    assert.equal(change.status, 200, JSON.stringify(change.body));
    // A sessão do painel continua (regra da troca de senha), a prévia não.
    assert.equal((await request(app).get('/api/admin/whoami').set('x-admin-session', tokens.prof)).status, 200);
    const after = await stillWorks(token);
    assert.equal(after.status, 401);
    assert.equal(after.body.code, 'preview_ended');
});

test('[UC-PREVIA-001] a prévia acaba em 60 min, quando a turma sai do escopo e quando o backup é restaurado', async () => {
    const { previewToken: expiring } = await previewToken(tokens.prof);
    db.memory.previewSessions[sha256(expiring)].expiresAt = Date.now() - 1;
    assert.equal((await stillWorks(expiring)).status, 401);

    const { previewToken: scoped } = await previewToken(tokens.prof);
    assert.equal((await stillWorks(scoped)).status, 200);
    db.memory.admins.find(item => item.email === 'prof@previa.local').assignedClasses = [{ courseId: COURSE, className: OTHER_CLASS }];
    assert.equal((await stillWorks(scoped)).status, 401, 'turma fora do escopo');

    const { previewToken: restored } = await previewToken(tokens.admin);
    assert.equal((await stillWorks(restored)).status, 200);
    const hook = db.afterRestore.find(item => item.name === 'authSessions');
    await hook.run(db.memory, {});
    assert.equal(db.memory.previewSessions, undefined, 'restauração encerra as prévias');
    db.memory.adminSessions[tokens.admin] = { email: 'admin@previa.local', createdAt: Date.now(), lastSeen: Date.now() };
    assert.equal((await stillWorks(restored)).status, 401, 'nem com o instrutor de volta');
});

test('[UC-PREVIA-001] encerrar: a prévia do cabeçalho (só da própria conta) ou todas da conta', async () => {
    const { previewToken: first } = await previewToken(tokens.prof);
    const { previewToken: second } = await previewToken(tokens.prof);
    const { previewToken: adminPreview } = await previewToken(tokens.admin);

    const notMine = await request(app).post('/api/admin/preview-sessions/end').set('x-admin-session', tokens.prof).set('x-preview-session', adminPreview).send({});
    assert.equal(notMine.status, 200);
    assert.equal(notMine.body.encerradas, 0);
    assert.equal((await stillWorks(adminPreview)).status, 200);

    const one = await request(app).post('/api/admin/preview-sessions/end').set('x-admin-session', tokens.prof).set('x-preview-session', first).send({});
    assert.equal(one.body.encerradas, 1);
    assert.equal((await stillWorks(first)).status, 401);
    assert.equal((await stillWorks(second)).status, 200);

    const all = await request(app).post('/api/admin/preview-sessions/end').set('x-admin-session', tokens.prof).send({});
    assert.equal(all.body.encerradas, 1);
    assert.equal((await stillWorks(second)).status, 401);
    assert.equal((await stillWorks(adminPreview)).status, 200, 'a do administrador continua');
    // Fim da prévia fica fora da auditoria.
    assert.equal(db.memory.auditLogs.filter(item => /preview/.test(item.action)).length, 3);
});

test('[UC-PREVIA-001] cada sessão de instrutor guarda até 5 prévias (a mais antiga sai)', async () => {
    const opened = [];
    for (let index = 0; index < 6; index += 1) opened.push((await previewToken(tokens.prof)).previewToken);
    assert.equal(Object.keys(db.memory.previewSessions).length, 5);
    assert.equal((await stillWorks(opened[0])).status, 401);
    assert.equal((await stillWorks(opened[5])).status, 200);
});

// ---------------------------------------------------------------------------
// [UC-PREVIA-002] a mesma visão de um aluno real da turma sem exceções individuais
// ---------------------------------------------------------------------------

// data.js é 'const courseData = {...};' com as apostilas na ordem em que a leitura terminou.
const courseDataOf = text => JSON.parse(String(text).replace(/^const courseData = /, '').replace(/;\s*$/, ''));

function withoutAccess(list) {
    return list.map(item => ({ ...item, url: String(item.url || '').replace(/([?&])access=[^&]*/, '$1access=') }));
}

test('[UC-PREVIA-002] data.js, status, biblioteca, avisos, calendário, sino e Início iguais aos da Bia (aluna sem exceções)', async () => {
    const { previewToken: token } = await previewToken(tokens.prof);
    const urls = [
        `/api/data.js?${Q}`,
        `/api/status?${Q}`,
        `/api/student/library?${Q}`,
        `/api/student/announcements?${Q}`,
        `/api/student/calendar-events?${Q}`,
        `/api/student/notifications?${Q}`,
        `/api/student/dashboard?${Q}`,
        `/api/student/exam-applications?${Q}`,
        `/api/student/my-forum?${Q}`,
        `/api/forum?key=Ap_3&${Q}`,
    ];
    for (const url of urls) {
        const real = await request(app).get(url).set('x-session-token', tokens.bia);
        const preview = await request(app).get(url).set('x-preview-session', token);
        assert.equal(real.status, 200, `${url}: ${real.text}`);
        assert.equal(preview.status, 200, `${url}: ${preview.text}`);
        if (url.includes('/library')) assert.deepEqual(withoutAccess(preview.body), withoutAccess(real.body), url);
        else if (url.includes('data.js')) assert.deepEqual(courseDataOf(preview.text), courseDataOf(real.text), url);
        else assert.deepEqual(preview.body, real.body, url);
    }

    // O que a prévia vê de fato: a versão da turma da Unidade 1, sem a Unidade 2 (oculta
    // para a turma e liberada só para a Ana), sem o aviso particular da Ana.
    const data = await request(app).get(`/api/data.js?${Q}`).set('x-preview-session', token);
    assert.match(data.text, /versão da turma/);
    assert.doesNotMatch(data.text, /oculta para a turma/);
    const status = await request(app).get(`/api/status?${Q}`).set('x-preview-session', token);
    assert.equal(status.body.releasedItems.Ap_2, false);
    const announcements = await request(app).get(`/api/student/announcements?${Q}`).set('x-preview-session', token);
    assert.deepEqual(announcements.body.map(item => item.id), ['av_turma']);
    // A Ana (com exceção) vê outra coisa: o teste distingue as duas visões.
    const ana = await request(app).get(`/api/status?${Q}`).set('x-session-token', tokens.ana);
    assert.equal(ana.body.releasedItems.Ap_2, true);

    // Apostila liberada e bloqueada pelo /:key.md; a figura da apostila e o arquivo da
    // biblioteca pelo link da lista (?access= com o token da prévia).
    assert.equal((await request(app).get(`/${VARIANT_KEY}.md`).set('x-preview-session', token)).status, 200);
    assert.equal((await request(app).get('/Ap_2.md').set('x-preview-session', token)).status, 403);
    const library = await request(app).get(`/api/student/library?${Q}`).set('x-preview-session', token);
    assert.deepEqual(library.body.map(item => item.id), ['lib_1']);
    assert.ok(library.body[0].url.includes(`access=${encodeURIComponent(token)}`), 'link com a sessão da prévia');
    const download = await request(app).get(library.body[0].url);
    assert.equal(download.status, 200);
    assert.equal((await request(app).get(`/uploads/oculto.pdf?access=${encodeURIComponent(token)}`)).status, 403, 'arquivo oculto para a turma');
    assert.equal((await request(app).get('/imagens/figura.png').set('x-preview-session', token)).status, 200);

    // Sem portão de primeiro acesso para o aluno virtual.
    const privacy = await request(app).get(`/api/student/privacy/status?courseId=${COURSE}`).set('x-preview-session', token);
    assert.equal(privacy.status, 200);
    assert.equal(privacy.body.required, false);
    assert.equal(privacy.body.pending, false);
    assert.equal(privacy.body.preview, true);
});

// ---------------------------------------------------------------------------
// [UC-PREVIA-003] nada grava: passeio por todas as rotas fora de /api/admin
// ---------------------------------------------------------------------------

// Rotas do app (pilha do Express), 'METODO caminho'.
function appRoutes(application) {
    const routes = [];
    const walk = stack => stack.forEach(layer => {
        if (layer.route) {
            const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
            paths.forEach(routePath => Object.keys(layer.route.methods)
                .filter(method => layer.route.methods[method] && method !== '_all')
                .forEach(method => routes.push(`${method.toUpperCase()} ${routePath}`)));
        } else if (layer.handle && Array.isArray(layer.handle.stack)) {
            walk(layer.handle.stack);
        }
    });
    walk(application.router.stack);
    return [...new Set(routes)];
}

// Decisão de cada rota fora de /api/admin com x-preview-session. 'recusada': 403
// preview_read_only. Na lista: o pedido de exemplo, que precisa dar 200 sem mudar nada.
// Rota nova sem linha aqui falha o teste: decida se ela entra na lista
// (utils/previewAccess.js PREVIEW_READ_ROUTES), conforme o contrato C4 do P5.
function decisions(virtualEmail) {
    const read = (url, extra = {}) => ({ url, ...extra });
    return {
        'GET /uploads/:filename': read('/uploads/material.pdf'),
        'GET /imagens/*path': read('/imagens/figura.png'),
        'POST /api/student/log-activity': 'recusada',
        'POST /api/student/log-keystrokes': 'recusada',
        'POST /api/student/autosave-progress': 'recusada',
        'GET /api/student/exam-state': 'recusada',
        'POST /api/student/acknowledge-message': 'recusada',
        'GET /api/student/message-history': 'recusada',
        'POST /api/student/message-history/delete': 'recusada',
        'POST /api/student/validate-exam-token': 'recusada',
        'GET /api/test-mode': 'recusada',
        'POST /api/test/crash': 'recusada',
        'POST /api/test/seed': 'recusada',
        'POST /api/setup/quick-session': 'recusada',
        'POST /api/setup/admin-session': 'recusada',
        'GET /api/settings/public': read('/api/settings/public'),
        'GET /api/session/status': read('/api/session/status'),
        'GET /api/connection': read('/api/connection'),
        'GET /iclass-ca.crt': 'recusada',
        'GET /api/connection/certificate': 'recusada',
        // Só o crash.log (fora do banco e da memória); responde 204.
        'POST /api/client-error': read('/api/client-error', { method: 'POST', body: { area: 'aluno', message: 'Erro de teste na prévia' }, status: 204 }),
        'GET /data.js': read(`/data.js?${Q}`),
        'GET /api/data.js': read(`/api/data.js?${Q}`),
        'GET /:key.md': read('/Ap_3.md'),
        'GET /api/branding': read(`/api/branding?courseId=${COURSE}`),
        'POST /api/branding': 'recusada',
        'GET /api/courses': 'recusada',
        'POST /api/courses': 'recusada',
        'PUT /api/courses/:id': 'recusada',
        'DELETE /api/courses/:id': 'recusada',
        'GET /api/legal/documents': read('/api/legal/documents'),
        'GET /api/student/privacy/status': read(`/api/student/privacy/status?courseId=${COURSE}`),
        'POST /api/student/privacy/accept': 'recusada',
        'GET /api/student/my-data': 'recusada',
        'GET /api/ping': 'recusada',
        'POST /api/student/logout': 'recusada',
        'POST /api/student/leave': 'recusada',
        'GET /api/classes': 'recusada',
        'GET /api/status': read(`/api/status?${Q}`),
        'GET /api/student/exam-applications': read(`/api/student/exam-applications?${Q}`),
        'GET /api/student/sync': read(`/api/student/sync?${Q}&examKey=Avaliacao_P1&applicationId=app_1`),
        'POST /api/student/register': 'recusada',
        'GET /api/student/account': read('/api/student/account'),
        'GET /api/student/enrollments': read('/api/student/enrollments'),
        'POST /api/student/enrollments/request': 'recusada',
        'POST /api/student/enrollments/cancel': 'recusada',
        'GET /api/student/library': read(`/api/student/library?${Q}`),
        'GET /api/student/announcements': read(`/api/student/announcements?${Q}`),
        'POST /api/student/announcements/read': 'recusada',
        'GET /api/student/calendar-events': read(`/api/student/calendar-events?${Q}`),
        // Agenda .ics da turma (fase 3, B3): só lê o calendário da turma, como calendar-events.
        'GET /api/student/calendar.ics': read(`/api/student/calendar.ics?${Q}`),
        'POST /api/student/login': 'recusada',
        'POST /api/student/recover': 'recusada',
        'POST /api/student/change-password': 'recusada',
        'POST /api/student/exam-applications/:applicationId/start-attempt': 'recusada',
        'POST /api/student/report-question': 'recusada',
        'POST /api/student/submit': 'recusada',
        'POST /api/student/my-submissions': read('/api/student/my-submissions', { method: 'POST', body: { courseId: COURSE, studentClass: CLASS } }),
        'GET /api/student/progress': read(`/api/student/progress?email=${encodeURIComponent(virtualEmail)}`),
        'GET /api/student/notifications': read(`/api/student/notifications?${Q}`),
        'POST /api/student/notifications/seen': 'recusada',
        'GET /api/student/dashboard': read(`/api/student/dashboard?${Q}`),
        'POST /api/student/progress': 'recusada',
        'POST /api/student/track-access': 'recusada',
        'POST /api/student/notes/save': 'recusada',
        'POST /api/student/notes/get': read('/api/student/notes/get', { method: 'POST', body: { moduleKey: 'Ap_3' } }),
        'POST /api/student/annotation': 'recusada',
        'GET /api/student/annotations': read('/api/student/annotations?key=Ap_3'),
        'GET /api/forum': read(`/api/forum?key=Ap_3&${Q}`),
        'GET /api/student/my-forum': read(`/api/student/my-forum?${Q}`),
        'POST /api/forum/comment': 'recusada',
        'POST /api/forum/reply': 'recusada',
        'POST /api/forum/comment/edit': 'recusada',
        'POST /api/forum/comment/delete': 'recusada',
        'POST /api/forum/reply/edit': 'recusada',
        'POST /api/forum/reply/delete': 'recusada',
        'POST /api/session/admin-login': 'recusada',
        'POST /api/session/logout': 'recusada',
        'GET /api/health': 'recusada',
        'POST /api/system/control': 'recusada',
        // Tarefas (fase 3, C5 / P1-c): a prévia lê a lista e o detalhe; envio e download não.
        'GET /api/student/assignments': read(`/api/student/assignments?${Q}`),
        'GET /api/student/assignments/:id': read(`/api/student/assignments/${ASSIGNMENT_ID}?${Q}`),
        'POST /api/student/assignments/:id/submit': 'recusada',
        'GET /api/student/assignments/:id/files/:fileId': 'recusada',
        // Grupos do aluno (fase 3, C12 / P5-S4): só lê.
        'GET /api/student/groups': read(`/api/student/groups?${Q}`),
        // Conversas com professores (fase 3, C13 / P5-S7a): a prévia vê a lista (sempre
        // vazia: a pessoa virtual não tem conversa) e quem atende a turma; começar,
        // responder, ler, marcar e arquivar não.
        'GET /api/student/conversations': read(`/api/student/conversations?${Q}`),
        'GET /api/student/conversations/recipients': read(`/api/student/conversations/recipients?${Q}`),
        'POST /api/student/conversations': 'recusada',
        'GET /api/student/conversations/:id/messages': 'recusada',
        'POST /api/student/conversations/:id/messages': 'recusada',
        'POST /api/student/conversations/:id/read': 'recusada',
        'POST /api/student/conversations/:id/archive': 'recusada',
        // Caderno para levar (fase 3, C17 / P5-S3): só lê; na prévia, vazio.
        'GET /api/student/notebook': read(`/api/student/notebook?${Q}`),
    };
}

const exampleUrl = route => route
    .replace('*path', 'figura.png')
    .replace(/:key\.md$/, 'Ap_3.md')
    .replace(/:[A-Za-z]+/g, 'exemplo');

test('[UC-PREVIA-003] passeio: toda rota fora de /api/admin tem decisão; fora da lista 403 preview_read_only; na lista, nada muda e nada grava', async () => {
    const { previewToken: token, aluno } = await previewToken(tokens.prof);
    const table = decisions(aluno.email);
    const routes = appRoutes(app).filter(route => !/^[A-Z]+ \/api\/admin(?:\/|$)/.test(route));

    const undecided = routes.filter(route => !Object.prototype.hasOwnProperty.call(table, route));
    assert.deepEqual(undecided, [], `Rotas sem decisão na pré-visualização (contrato C4 do P5):\n${undecided.join('\n')}`);
    const stale = Object.keys(table).filter(route => !routes.includes(route));
    assert.deepEqual(stale, [], `Linhas para rotas que não existem mais:\n${stale.join('\n')}`);

    const originalSave = db.save;
    const saves = [];
    db.save = function spiedSave(...args) {
        saves.push(args);
        return originalSave.apply(this, args);
    };
    try {
        const problems = [];
        for (const route of routes) {
            const decision = table[route];
            const [method, routePath] = route.split(' ');
            const sample = decision === 'recusada'
                ? { method, url: exampleUrl(routePath), body: {} }
                : { method: decision.method || method, url: decision.url, body: decision.body };
            const before = memoryHash();
            saves.length = 0;
            const verb = sample.method.toLowerCase();
            let call = request(app)[verb](sample.url).set('x-preview-session', token);
            if (sample.body !== undefined && verb !== 'get') call = call.send(sample.body);
            const response = await call;
            if (decision === 'recusada') {
                if (response.status !== 403 || response.body.code !== 'preview_read_only') problems.push(`${route}: esperado 403 preview_read_only, veio ${response.status} ${response.text.slice(0, 120)}`);
                if (isPreviewReadRoute(method, sample.url.split('?')[0])) problems.push(`${route}: recusada na tabela, mas casa com PREVIEW_READ_ROUTES`);
            } else {
                const expected = decision.status || 200;
                if (response.status !== expected) problems.push(`${route}: esperado ${expected}, veio ${response.status} ${response.text.slice(0, 160)}`);
                if (!isPreviewReadRoute(sample.method, sample.url.split('?')[0])) problems.push(`${route}: na tabela como leitura, mas fora de PREVIEW_READ_ROUTES`);
            }
            if (memoryHash() !== before) problems.push(`${route}: a memória mudou`);
            if (saves.length) problems.push(`${route}: db.save chamado ${saves.length} vez(es)`);
        }
        assert.deepEqual(problems, [], problems.join('\n'));
    } finally {
        db.save = originalSave;
    }

    // Toda entrada da lista branca serve a pelo menos uma rota de verdade.
    const samples = Object.values(table).filter(value => value !== 'recusada');
    const unused = PREVIEW_READ_ROUTES.filter(entry => !samples.some(sample => entry.method === (sample.method || 'GET') && entry.pattern.test(sample.url.split('?')[0])));
    assert.deepEqual(unused.map(entry => `${entry.method} ${entry.pattern}`), [], 'entrada da lista sem rota no passeio');
});

test('[UC-PREVIA-003] sync com prova aberta não cria tentativa (aplicação e prova antiga sem aplicação), fórum não migra dúvida antiga, nada de presença', async () => {
    const { previewToken: token } = await previewToken(tokens.prof);
    const before = memoryHash();
    const withApplication = await request(app).get(`/api/student/sync?${Q}&examKey=Avaliacao_P1&applicationId=app_1`).set('x-preview-session', token);
    assert.equal(withApplication.status, 200);
    assert.equal(withApplication.body.state.attemptId, undefined);
    assert.equal(withApplication.body.attemptId, null);
    assert.equal(withApplication.body.questions, null, 'questões da prova não saem');
    const legacy = await request(app).get(`/api/student/sync?${Q}&examKey=Avaliacao_P2`).set('x-preview-session', token);
    assert.equal(legacy.status, 200);
    const forum = await request(app).get(`/api/forum?key=Ap_3&${Q}`).set('x-preview-session', token);
    assert.equal(forum.status, 200);
    assert.deepEqual(forum.body.comments.map(item => item.id), ['c_1'], 'a dúvida antiga aparece (turma inferida)');
    assert.equal(forum.body.comments[0].isOwner, false);
    assert.equal(forum.body.comments[0].studentEmail, undefined);
    assert.deepEqual(db.memory.studentExamState, {}, 'nenhum estado de prova');
    assert.equal(db.memory.forum[0].courseId, undefined, 'dúvida antiga sem turma gravada');
    assert.deepEqual(db.memory.attendance, []);
    assert.equal(memoryHash(), before);

    // Um aluno de verdade, no mesmo sync, cria a tentativa (o teste distingue).
    const real = await request(app).get(`/api/student/sync?${Q}&examKey=Avaliacao_P1&applicationId=app_1`).set('x-session-token', tokens.bia);
    assert.equal(real.status, 200);
    assert.equal(Object.keys(db.memory.studentExamState).length, 1);
});

test('[UC-PREVIA-003] a lista branca vale também sem o previewSessionGuard (validateStudentSession recusa)', async () => {
    const { previewToken: token } = await previewToken(tokens.prof);
    const bare = express();
    bare.use(express.json());
    bare.use(require('../../backend/routes/proctoring.js'));
    bare.use(require('../../backend/routes/student.js'));
    const before = memoryHash();
    for (const [method, url, body] of [
        ['post', '/api/student/log-activity', { type: 'blur' }],
        ['post', '/api/student/progress', { completedUnits: { Ap_3: true } }],
        ['get', '/api/ping', undefined],
        ['post', '/api/student/notifications/seen', {}],
    ]) {
        let call = request(bare)[method](url).set('x-preview-session', token);
        if (body) call = call.send(body);
        const response = await call;
        assert.equal(response.status, 403, `${url}: ${response.text}`);
        assert.equal(response.body.code, 'preview_read_only', url);
    }
    assert.equal(memoryHash(), before);
    assert.equal((await request(bare).get(`/api/student/dashboard?${Q}`).set('x-preview-session', token)).status, 200);
});

test('[UC-PREVIA-003] a guarda casa como o Express (caixa e barra no fim) e ignora /api/admin', async () => {
    const { previewToken: token } = await previewToken(tokens.prof);
    const before = memoryHash();
    const upper = await request(app).post('/API/Student/Progress/').set('x-preview-session', token).send({ completedUnits: { Ap_3: true } });
    assert.equal(upper.status, 403);
    assert.equal(upper.body.code, 'preview_read_only');
    const trailing = await request(app).get(`/api/student/dashboard/?${Q}`).set('x-preview-session', token);
    assert.equal(trailing.status, 200);
    // Identidade diferente do aluno virtual na query: 403.
    const other = await request(app).get(`/api/student/progress?email=${encodeURIComponent(ANA)}`).set('x-preview-session', token);
    assert.equal(other.status, 403);
    assert.equal(memoryHash(), before);
    // Pedido do painel com o cabeçalho da prévia segue a sessão do painel.
    const panel = await request(app).get('/api/admin/whoami').set('x-admin-session', tokens.prof).set('x-preview-session', token);
    assert.equal(panel.status, 200);
    // Com o cabeçalho da prévia, o token de aluno junto não vale (a prévia manda).
    const both = await request(app).post('/api/student/progress').set('x-preview-session', token).set('x-session-token', tokens.ana).send({ completedUnits: { Ap_1: true } });
    assert.equal(both.status, 403);
    assert.deepEqual(db.memory.progress[ANA], { Ap_3: true });
});

test('[UC-PREVIA-003] prévia vencida ou desconhecida: 401 preview_ended nas rotas de leitura, 403 nas outras', async () => {
    const read = await request(app).get(`/api/student/dashboard?${Q}`).set('x-preview-session', 'nao-existe');
    assert.equal(read.status, 401);
    assert.equal(read.body.code, 'preview_ended');
    const dataJs = await request(app).get(`/api/data.js?${Q}`).set('x-preview-session', 'nao-existe');
    assert.equal(dataJs.status, 401);
    assert.equal(dataJs.body.code, 'preview_ended');
    const write = await request(app).post('/api/student/progress').set('x-preview-session', 'nao-existe').send({ completedUnits: {} });
    assert.equal(write.status, 403);
    assert.equal(write.body.code, 'preview_read_only');
    const file = await request(app).get('/uploads/material.pdf?access=nao-existe');
    assert.equal(file.status, 401);
});

// ---------------------------------------------------------------------------
// Rodada de ajuste 1 do C2
// ---------------------------------------------------------------------------

test('[UC-PREVIA-001] a prévia acaba quando a sessão do instrutor passa do prazo absoluto, antes da limpeza periódica', async () => {
    const { previewToken: token } = await previewToken(tokens.prof);
    assert.equal((await stillWorks(token)).status, 200);
    // Sessão do painel aberta há 9 h (prazo padrão de 8 h), ainda na memória: nem a limpeza
    // de 15 min nem um pedido do painel a removeram.
    db.memory.adminSessions[tokens.prof].createdAt = Date.now() - 9 * 3600000;
    const before = memoryHash();
    const after = await stillWorks(token);
    assert.equal(after.status, 401, JSON.stringify(after.body));
    assert.equal(after.body.code, 'preview_ended');
    assert.equal(after.body.previewReason, 'admin_session');
    assert.equal(memoryHash(), before, 'a recusa não muda nada');
    // Na manutenção também não vale como sessão de instrutor.
    db.memory.config.settings = { ...(db.memory.config.settings || {}), maintenance: { enabled: true, message: 'Em manutenção.' } };
    try {
        assert.equal((await stillWorks(token)).status, 503);
    } finally {
        delete db.memory.config.settings.maintenance;
    }
    // A sessão do painel vencida também dá 401 lá.
    assert.equal((await request(app).get('/api/admin/whoami').set('x-admin-session', tokens.prof)).status, 401);
});

test('[UC-PREVIA-001] o 401 preview_ended diz a causa (previewReason) e mantém reason "expired"', async () => {
    // Abre todas antes de mudar qualquer coisa: abrir uma prévia limpa as vencidas.
    const { previewToken: expired } = await previewToken(tokens.prof);
    const { previewToken: outOfScope } = await previewToken(tokens.prof);
    const { previewToken: scoped } = await previewToken(tokens.admin);
    const { previewToken: deleted } = await previewToken(tokens.admin, { courseId: COURSE, studentClass: OTHER_CLASS });
    const { previewToken: password } = await previewToken(tokens.prof2, { courseId: COURSE, studentClass: OTHER_CLASS });

    db.memory.previewSessions[sha256(expired)].expiresAt = Date.now() - 1;
    db.memory.admins.find(item => item.email === 'prof@previa.local').assignedClasses = [];
    db.memory.admins.find(item => item.email === 'prof2@previa.local').password = db.hashPassword('Outra-Senha-2026#');
    db.memory.classes = db.memory.classes.filter(cls => cls.name !== OTHER_CLASS);
    const cases = [
        [expired, 'expired'],
        [outOfScope, 'permission'],
        [deleted, 'class'],
        [password, 'account'],
        ['nao-existe', 'missing'],
    ];

    for (const [token, cause] of cases) {
        for (const url of [`/api/student/dashboard?${Q}`, `/api/data.js?${Q}`]) {
            const response = await request(app).get(url).set('x-preview-session', token);
            assert.equal(response.status, 401, `${cause} ${url}`);
            assert.equal(response.body.code, 'preview_ended');
            assert.equal(response.body.reason, 'expired');
            assert.equal(response.body.sessionRevoked, true);
            assert.equal(response.body.previewReason, cause, url);
            assert.equal(response.body.error, previewAccess.PREVIEW_ENDED_MESSAGES[cause]);
        }
    }
    assert.match(previewAccess.PREVIEW_ENDED_MESSAGES.expired, /60 minutos/);

    // O Sair do instrutor encerra a prévia com o motivo 'admin_session' (antes da rodada
    // de ajuste 2, a prévia saía da memória e o portal recebia o genérico 'missing').
    assert.equal((await stillWorks(scoped)).status, 200);
    await request(app).post('/api/session/logout').set('x-admin-session', tokens.admin).send({});
    assert.equal((await stillWorks(scoped)).body.previewReason, 'admin_session');
});

test('[UC-PREVIA-001] Professor auxiliar e Secretaria (sem conteúdo) não abrem a prévia; quem perde page.materials perde a prévia', async () => {
    const now = Date.now();
    db.memory.admins.push(
        { email: 'monitor@previa.local', name: 'Auxiliar', role: 'monitor', password: db.hashPassword('Senha-Antiga-2026'),
            assignedClasses: [{ courseId: COURSE, className: CLASS }] },
        { email: 'sec@previa.local', name: 'Secretaria', role: 'secretaria', password: db.hashPassword('Senha-Antiga-2026'),
            assignedSchoolIds: ['escola_a'] },
    );
    db.memory.adminSessions['monitor-token-previa'] = { email: 'monitor@previa.local', createdAt: now, lastSeen: now };
    db.memory.adminSessions['sec-token-previa'] = { email: 'sec@previa.local', createdAt: now, lastSeen: now };

    for (const adminToken of ['monitor-token-previa', 'sec-token-previa']) {
        // O painel nega o conteúdo da turma a essas contas...
        const panelData = await request(app).get(`/api/data.js?${Q}`).set('x-admin-session', adminToken);
        assert.equal(panelData.status, 403, adminToken);
        // ...e a prévia, que o mostraria, não abre.
        const refused = await openPreview(adminToken);
        assert.equal(refused.status, 403, `${adminToken}: ${JSON.stringify(refused.body)}`);
        assert.match(refused.body.error, /conteúdo/);
    }
    assert.equal(db.memory.previewSessions, undefined, 'nenhuma prévia aberta');
    assert.equal(db.memory.auditLogs.filter(item => item.action === 'content_preview_started').length, 0);

    // A prévia aberta pela professora acaba se a conta deixa de ter page.materials.
    const { previewToken: token } = await previewToken(tokens.prof);
    assert.equal((await stillWorks(token)).status, 200);
    const prof = db.memory.admins.find(item => item.email === 'prof@previa.local');
    prof.role = 'monitor';
    const after = await stillWorks(token);
    assert.equal(after.status, 401);
    assert.equal(after.body.previewReason, 'permission');
});

test('[UC-PREVIA-003] em manutenção, a prévia válida lê o portal (e continua sem gravar); aluno e prévia inválida recebem 503', async () => {
    const { previewToken: token } = await previewToken(tokens.prof);
    db.memory.config.settings = { ...(db.memory.config.settings || {}), maintenance: { enabled: true, message: 'Em manutenção.' } };
    try {
        const before = memoryHash();
        const read = await stillWorks(token);
        assert.equal(read.status, 200, JSON.stringify(read.body));
        assert.equal((await request(app).get(`/data.js?${Q}`).set('x-preview-session', token)).status, 200);
        const write = await request(app).post('/api/student/progress').set('x-preview-session', token).send({ completedUnits: { Ap_3: true } });
        assert.equal(write.status, 403);
        assert.equal(write.body.code, 'preview_read_only');
        assert.equal((await request(app).get('/api/ping').set('x-preview-session', token)).status, 403);
        assert.equal(memoryHash(), before);

        const student = await request(app).get(`/api/student/dashboard?${Q}`).set('x-session-token', tokens.bia);
        assert.equal(student.status, 503);
        assert.equal(student.body.maintenance, true);
        const unknown = await request(app).get(`/api/student/dashboard?${Q}`).set('x-preview-session', 'nao-existe');
        assert.equal(unknown.status, 503);
    } finally {
        delete db.memory.config.settings.maintenance;
    }
});

test('[UC-PREVIA-003] HEAD vale como GET nas rotas de leitura e o aviso de erro de tela vai só para o crash.log', async () => {
    const { previewToken: token } = await previewToken(tokens.prof);
    const before = memoryHash();
    const head = await request(app).head(`/api/student/dashboard?${Q}`).set('x-preview-session', token);
    assert.equal(head.status, 200);
    const headWrite = await request(app).head('/api/ping').set('x-preview-session', token);
    assert.equal(headWrite.status, 403);
    assert.equal(previewAccess.isPreviewReadRoute('HEAD', '/api/student/library'), true);
    assert.equal(previewAccess.isPreviewReadRoute('HEAD', '/api/student/progress/x'), false);

    const crashLog = path.join(tempRoot, 'crash.log');
    const sizeBefore = fs.existsSync(crashLog) ? fs.statSync(crashLog).size : 0;
    const originalSave = db.save;
    let saves = 0;
    db.save = function spiedSave(...args) { saves += 1; return originalSave.apply(this, args); };
    try {
        const report = await request(app).post('/api/client-error').set('x-preview-session', token)
            .send({ area: 'aluno', message: 'Falha ao desenhar a unidade', path: '/aluno/unidade' });
        assert.equal(report.status, 204, report.text);
    } finally {
        db.save = originalSave;
    }
    assert.equal(saves, 0, 'db.save não é chamado');
    assert.equal(memoryHash(), before);
    const logText = fs.existsSync(crashLog) ? fs.readFileSync(crashLog, 'utf8').slice(sizeBefore) : '';
    assert.match(logText, /Falha ao desenhar a unidade/);
    // Corpo inválido continua 400 e prévia desconhecida, 401.
    assert.equal((await request(app).post('/api/client-error').set('x-preview-session', token).send({ area: 'x', message: 'a' })).status, 400);
    assert.equal((await request(app).post('/api/client-error').set('x-preview-session', 'nao-existe').send({ area: 'aluno', message: 'a' })).status, 401);
});

// ---------------------------------------------------------------------------
// Rodada de ajuste 2 do C2
// ---------------------------------------------------------------------------

test('[UC-PREVIA-001] grupo arquivado (arquivadoEm, formato do P5) não abre a prévia; o grupo é lido por classGroups.js', async () => {
    const classGroups = require('../../backend/utils/classGroups.js');
    // Antes: findPreviewGroup conferia archivedAt e status 'arquivado', campos que o modelo
    // do P5 não tem, e o grupo com arquivadoEm abria a prévia com 200.
    db.memory.classGroups.push({ ...db.memory.classGroups[1], id: 'grp_arq_ms', arquivadoEm: 1763500000000 });
    for (const groupId of ['grp_arq', 'grp_arq_ms']) {
        const refused = await openPreview(tokens.prof, { courseId: COURSE, studentClass: CLASS, groupId });
        assert.equal(refused.status, 404, groupId);
        assert.equal(refused.body.field, 'groupId');
        assert.ok(classGroups.findGroup(db.memory, groupId), 'o grupo existe, só está arquivado');
    }
    assert.equal(db.memory.previewSessions, undefined, 'nada aberto');
    assert.deepEqual(classGroups.activeGroupsForClass(db.memory, { courseId: COURSE, name: CLASS }).map(group => group.id), ['grp_1']);
    assert.deepEqual(classGroups.activeGroupsForClass(db.memory, { courseId: COURSE, studentClass: OTHER_CLASS }).map(group => group.id), ['grp_outra']);
    assert.equal(classGroups.findGroup(db.memory, 'grp_inexistente'), null);
    assert.equal(classGroups.findGroup(db.memory, ''), null);
    // Leitura tolerante: sem arquivadoEm é ativo; um valor estranho conta como arquivado.
    assert.equal(classGroups.isGroupArchived({ id: 'x' }), false);
    assert.equal(classGroups.isGroupArchived({ id: 'x', arquivadoEm: null }), false);
    assert.equal(classGroups.isGroupArchived({ id: 'x', arquivadoEm: 'sim' }), true);
    // Sem a coleção (antes do P5-S4 ou backup antigo), nenhum grupo existe.
    assert.deepEqual(classGroups.activeGroupsForClass({}, { courseId: COURSE, name: CLASS }), []);
    assert.equal(previewAccess.findPreviewGroup({}, { courseId: COURSE, studentClass: CLASS, groupId: 'grp_1' }), null);

    // O grupo ativo da turma abre, com o nome no rótulo; ler não muda a coleção.
    const before = JSON.stringify(db.memory.classGroups);
    const opened = await openPreview(tokens.prof, { courseId: COURSE, studentClass: CLASS, groupId: 'grp_1' });
    assert.equal(opened.status, 200);
    assert.equal(opened.body.rotulo, 'Pré-visualização como aluno de 1DES · grupo Laboratório A');
    assert.equal(JSON.stringify(db.memory.classGroups), before);
});

test('[UC-PREVIA-001] troca de senha em outro aparelho e conta apagada encerram a prévia com previewReason "account"', async () => {
    const now = Date.now();
    // A professora tem outra sessão no painel (outro aparelho) e abre a prévia por ela.
    db.memory.adminSessions['prof-outro-aparelho'] = { email: 'prof@previa.local', createdAt: now, lastSeen: now };
    const { previewToken: token } = await previewToken('prof-outro-aparelho');
    assert.equal((await stillWorks(token)).status, 200);
    const change = await request(app).post('/api/admin/change-password').set('x-admin-session', tokens.prof)
        .send({ currentPassword: 'Senha-Antiga-2026', newPassword: 'Trocada#Segura-2026' });
    assert.equal(change.status, 200, JSON.stringify(change.body));
    assert.equal(db.memory.adminSessions['prof-outro-aparelho'], undefined, 'a troca encerra a outra sessão do painel');
    const after = await stillWorks(token);
    assert.equal(after.status, 401);
    assert.equal(after.body.code, 'preview_ended');
    // Antes: 'missing', com o texto genérico.
    assert.equal(after.body.previewReason, 'account');
    assert.equal(after.body.error, previewAccess.PREVIEW_ENDED_MESSAGES.account);

    // Conta apagada (as sessões do painel saem junto): também 'account'.
    const { previewToken: adminPreview } = await previewToken(tokens.admin);
    db.memory.admins = db.memory.admins.filter(item => item.email !== 'admin@previa.local');
    delete db.memory.adminSessions[tokens.admin];
    assert.equal((await stillWorks(adminPreview)).body.previewReason, 'account');
});

test('[UC-PREVIA-001] prévias de sessões do painel encerradas saem da memória no prazo delas', async () => {
    const { previewToken: old } = await previewToken(tokens.prof);
    await request(app).post('/api/session/logout').set('x-admin-session', tokens.prof).send({});
    assert.equal(Object.keys(db.memory.previewSessions).length, 1, 'fica até o prazo, sem valer');
    db.memory.previewSessions[sha256(old)].expiresAt = Date.now() - 1;
    assert.equal((await stillWorks(old)).body.previewReason, 'expired');
    // Abrir uma prévia nova limpa as vencidas.
    const { previewToken: fresh } = await previewToken(tokens.admin);
    assert.deepEqual(Object.keys(db.memory.previewSessions), [sha256(fresh)]);
});

test('[UC-PREVIA-001] contrato classGroups: fora de utils/classGroups.js, nenhum arquivo do servidor lê memory.classGroups direto', () => {
    const backendRoot = path.join(__dirname, '..', '..', 'backend');
    const offenders = [];
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.js') && full !== path.join(backendRoot, 'utils', 'classGroups.js')) {
                const text = fs.readFileSync(full, 'utf8');
                if (/\.classGroups\b|\[\s*['"`]classGroups['"`]\s*\]/.test(text)) offenders.push(path.relative(backendRoot, full));
            }
        }
    };
    walk(backendRoot);
    assert.deepEqual(offenders, [], 'grupos só pelos leitores e regras de utils/classGroups.js');
});

// ---------------------------------------------------------------------------
// Grupos do aluno na prévia (fase 3, C12 / P5-S4)
// ---------------------------------------------------------------------------

test('[UC-PREVIA-002] Meus grupos: sem grupo a prévia não está em nenhum; com o grupo, vê o grupo como um membro (os colegas pelo nome)', async () => {
    const { previewToken: plain } = await previewToken(tokens.prof);
    const none = await request(app).get(`/api/student/groups?${Q}`).set('x-preview-session', plain);
    assert.equal(none.status, 200);
    assert.deepEqual(none.body, []);

    const { previewToken: withGroup } = await previewToken(tokens.prof, { courseId: COURSE, studentClass: CLASS, groupId: 'grp_1' });
    const before = memoryHash();
    const member = await request(app).get(`/api/student/groups?${Q}`).set('x-preview-session', withGroup);
    assert.equal(member.status, 200);
    assert.deepEqual(member.body, [{ id: 'grp_1', nome: 'Laboratório A', conjunto: 'Laboratório', tipo: 'subturma', tipoTexto: 'Subturma', colegas: ['Bia'] }]);
    assert.equal(memoryHash(), before, 'ler não muda nada');

    // A aluna real do grupo vê o mesmo grupo (sem ela mesma entre os colegas); a de fora, nada.
    const bia = await request(app).get(`/api/student/groups?${Q}`).set('x-session-token', tokens.bia);
    assert.deepEqual(bia.body.map(group => [group.id, group.colegas]), [['grp_1', []]]);
    const ana = await request(app).get(`/api/student/groups?${Q}`).set('x-session-token', tokens.ana);
    assert.deepEqual(ana.body, []);
    // Grupo arquivado depois de abrir a prévia não aparece mais.
    db.memory.classGroups[0].arquivadoEm = Date.now();
    const archived = await request(app).get(`/api/student/groups?${Q}`).set('x-preview-session', withGroup);
    assert.equal(archived.status, 200);
    assert.deepEqual(archived.body, []);
});
