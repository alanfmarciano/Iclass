// Grupos em avisos, liberação, chamada e prova (fase 3, C19 / P5-S5, CRIT-11; D18 do P5).
// [UC-GRUPO-003] uso do grupo:
//   - aviso e evento do calendário com destino 'grupo' vistos só pelos membros atuais
//     (avisos, sino, Início e calendar-events); grupo arquivado deixa de valer;
//   - liberação de apostila e gabarito por grupo: libera para o membro e não para os
//     outros, exceção individual vence, grupo arquivado não vale, gabarito com prova
//     aberta continua bloqueado; prova online com grupo 400; sem grupos, o mesmo de antes;
//   - chamada com groupId: o roster só com os membros, o bulk só grava membros e não muda
//     a frequência dos outros, a exportação filtra;
//   - pré-visualização com grupo vê o que um membro vê.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-grupos-uso-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const runtimePaths = require('../../backend/runtimePaths.js');
const { getReleasedItemsForClass } = require('../../backend/middlewares.js');
const classGroups = require('../../backend/utils/classGroups.js');
const { createAdminSession, createStudentSession } = require('../../backend/utils/authSessions.js');
const { createApp } = require('../../backend/server.js');

const COURSE = 'curso-uso';
const CLASS = '1USO';
const OTHER = '2USO';
const ANA = 'ana@uso.local';
const BIA = 'bia@uso.local';
const CAIO = 'caio@uso.local';
const DUDA = 'duda@uso.local';
const EDU = 'edu@uso.local';
const GRP_A = 'grp_1_aaaaaa';
const GRP_B = 'grp_1_bbbbbb';
const GRP_OLD = 'grp_1_cccccc';
const GRP_OTHER = 'grp_1_dddddd';
const DATE = '2026-11-10';
const tokens = {};
let app;

const as = (name, req) => req.set('x-admin-session', tokens[name]);
const asStudent = (email, req) => req.set('x-session-token', tokens[email]);
const Q = { courseId: COURSE, studentClass: CLASS };

function student(id, name, email, cls = CLASS) {
    return { id, name, email, status: 'Ativo', password: db.hashPassword('Senha-forte-123'), classes: [{ name: cls, courseId: COURSE }] };
}

function group(id, nome, membros, extra = {}) {
    return {
        id, schemaVersion: 1, courseId: COURSE, studentClass: CLASS, nome, conjunto: 'Laboratório', tipo: 'subturma',
        membros: membros.map(email => ({ email, studentId: null, adicionadoEm: 1, adicionadoPor: 'prof@uso.local' })),
        criadoEm: 1, criadoPor: 'prof@uso.local', atualizadoEm: 1, atualizadoPor: 'prof@uso.local', arquivadoEm: null, arquivadoPor: null,
        ...extra,
    };
}

function seed() {
    const contentDir = runtimePaths.CONTENT_DIR;
    fs.mkdirSync(contentDir, { recursive: true });
    fs.writeFileSync(path.join(contentDir, 'Apostila_U1.md'), '# Unidade 1\n');
    fs.writeFileSync(path.join(contentDir, 'Apostila_U2.md'), '# Unidade 2 (laboratório)\n');
    db.memory.config = { ...(db.memory.config || {}), settings: { timezone: 'America/Sao_Paulo' } };
    db.memory.schools = [{ id: 'escola_u', name: 'Escola U', info: {}, branding: {} }];
    db.memory.courses = [{ id: COURSE, name: 'Curso de uso', schoolId: 'escola_u', structure: [{ id: 'm1', name: 'Módulo 1', units: [
        { id: 'u1', name: 'Unidade 1', apostilaKey: 'Apostila_U1' },
        { id: 'u2', name: 'Unidade 2', apostilaKey: 'Apostila_U2', avaliacaoKey: 'Avaliacao_P1' },
    ] }] }];
    db.memory.classes = [
        { name: CLASS, courseId: COURSE, period: 'Manhã', releasedItems: { Apostila_U1: true, Apostila_U2: false, Avaliacao_P1: false, Gabarito_Avaliacao_P1: false }, onlineExamConfigs: {} },
        { name: OTHER, courseId: COURSE, period: 'Tarde', releasedItems: {}, onlineExamConfigs: {} },
    ];
    db.memory.students = [
        student('alu_00000000000000a1', 'Ana Souza', ANA),
        student('alu_00000000000000b2', 'Bia Lima', BIA),
        student('alu_00000000000000c3', 'Caio Prado', CAIO),
        student('alu_00000000000000d4', 'Duda Reis', DUDA),
        student('alu_00000000000000e5', 'Edu Teles', EDU, OTHER),
    ];
    db.memory.classGroups = [
        group(GRP_A, 'Laboratório A', [ANA, BIA]),
        group(GRP_B, 'Laboratório B', [CAIO]),
        group(GRP_OLD, 'Antigo', [DUDA], { conjunto: 'Projeto', arquivadoEm: 5, arquivadoPor: 'prof@uso.local' }),
        { ...group(GRP_OTHER, 'Outra turma', [EDU]), studentClass: OTHER },
    ];
    db.memory.admins = [
        { email: 'adm@uso.local', name: 'Administração', role: 'admin', password: db.hashPassword('Senha-forte-2026') },
        { email: 'prof@uso.local', name: 'Professora', role: 'professor', password: db.hashPassword('Senha-forte-2026'), assignedClasses: [{ courseId: COURSE, className: CLASS }] },
        { email: 'prof2@uso.local', name: 'Outro', role: 'professor', password: db.hashPassword('Senha-forte-2026'), assignedClasses: [{ courseId: COURSE, className: OTHER }] },
    ];
    db.memory.adminSessions = {};
    db.memory.sessions = {};
    db.memory.announcements = [];
    db.memory.auditLogs = [];
    db.memory.attendance = [];
    db.memory.examApplications = [];
    db.memory.studentExamState = {};
    db.memory.submissions = [];
    db.memory.forum = [];
    delete db.memory.previewSessions;
    tokens.admin = createAdminSession(db.memory, 'adm@uso.local');
    tokens.prof = createAdminSession(db.memory, 'prof@uso.local');
    tokens.prof2 = createAdminSession(db.memory, 'prof2@uso.local');
    [ANA, BIA, CAIO, DUDA].forEach(email => { tokens[email] = createStudentSession(db.memory, email); });
}

async function release(body, who = 'prof') {
    return as(who, request(app).post('/api/admin/release-item')).send({ ...Q, ...body });
}

async function releasedFor(email) {
    const res = await asStudent(email, request(app).get('/api/status')).query(Q);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.releasedItems;
}

async function announcementsOf(email) {
    const res = await asStudent(email, request(app).get('/api/student/announcements')).query(Q);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
}

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

// ---------------------------------------------------------------------------
// Liberação por grupo
// ---------------------------------------------------------------------------

test('[UC-GRUPO-003] sem liberação por grupo, getReleasedItemsForClass é o mesmo de antes (igualdade)', () => {
    const cls = db.memory.classes[0];
    cls.studentReleasedItems = { [BIA]: { Apostila_U2: true } };
    const before = [ANA, BIA, CAIO, ''].map(email => getReleasedItemsForClass(cls, email));
    cls.groupReleasedItems = {};
    const withEmptyMap = [ANA, BIA, CAIO, ''].map(email => getReleasedItemsForClass(cls, email));
    assert.deepEqual(withEmptyMap, before);
    assert.deepEqual(before[0], { Apostila_U1: true, Apostila_U2: false, Avaliacao_P1: false, Gabarito_Avaliacao_P1: false });
    assert.equal(before[1].Apostila_U2, true, 'a exceção individual de antes continua valendo');
});

test('[UC-GRUPO-003] liberar a apostila para um grupo: membro vê e abre, os outros não; auditoria content_released com o grupo na mesma gravação', async () => {
    const saves = [];
    const original = db.save;
    db.save = function spied(...args) { saves.push(args[0]); return original.apply(this, args); };
    let res;
    try {
        res = await release({ itemKey: 'Apostila_U2', released: true, groupId: GRP_A });
    } finally { db.save = original; }
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.scope, 'group');
    assert.deepEqual(res.body.groupReleases, { Apostila_U2: [{ id: GRP_A, nome: 'Laboratório A', conjunto: 'Laboratório' }] });
    assert.deepEqual(saves, [{ only: ['classes', 'auditLogs'] }]);
    assert.deepEqual(db.memory.classes[0].groupReleasedItems, { [GRP_A]: { Apostila_U2: true } });
    assert.equal(db.memory.classes[0].releasedItems.Apostila_U2, false, 'a turma continua bloqueada');
    const audit = db.memory.auditLogs.filter(entry => entry.action === 'content_released');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].details.groupId, GRP_A);
    assert.equal(audit[0].details.itemKey, 'Apostila_U2');
    assert.equal(audit[0].studentClass, CLASS);

    assert.equal((await releasedFor(ANA)).Apostila_U2, true);
    assert.equal((await releasedFor(BIA)).Apostila_U2, true);
    assert.equal((await releasedFor(CAIO)).Apostila_U2, false);
    assert.equal((await releasedFor(DUDA)).Apostila_U2, false);
    await asStudent(ANA, request(app).get('/Apostila_U2.md')).expect(200);
    await asStudent(CAIO, request(app).get('/Apostila_U2.md')).expect(403);

    // O painel vê o selo e a lista de grupos para o seletor.
    const status = await as('prof', request(app).get('/api/status')).query(Q).expect(200);
    assert.deepEqual(status.body.groupReleases.Apostila_U2.map(item => item.id), [GRP_A]);
    assert.deepEqual(status.body.grupos.map(item => item.nome), ['Laboratório A', 'Laboratório B']);
    assert.equal(status.body.grupos[0].quantidade, 2);
    assert.equal(status.body.releasedItems.Apostila_U2, false, 'a visão da turma não muda');

    // Liberar de novo não grava; desligar tira a liberação do grupo e registra content_hidden.
    const again = await release({ itemKey: 'Apostila_U2', released: true, groupId: GRP_A });
    assert.equal(again.body.unchanged, true);
    const off = await release({ itemKey: 'Apostila_U2', released: false, groupId: GRP_A });
    assert.equal(off.status, 200);
    assert.deepEqual(db.memory.classes[0].groupReleasedItems, {});
    assert.equal(db.memory.auditLogs.filter(entry => entry.action === 'content_hidden').length, 1);
    assert.equal((await releasedFor(ANA)).Apostila_U2, false);
});

test('[UC-GRUPO-003] fusão: turma -> grupos (liberado em qualquer grupo vence) -> exceção individual; grupo arquivado não vale', async () => {
    const cls = db.memory.classes[0];
    cls.groupReleasedItems = { [GRP_A]: { Apostila_U2: true, Apostila_U1: false }, [GRP_OLD]: { Apostila_U2: true } };
    db.memory.classGroups.push({ ...classGroups.findGroup(db.memory, GRP_B), id: 'grp_1_eeeeee', nome: 'Projeto X', conjunto: 'Projeto', membros: [{ email: ANA }] });
    cls.groupReleasedItems.grp_1_eeeeee = { Apostila_U1: true };
    cls.studentReleasedItems = { [BIA]: { Apostila_U2: false } };
    assert.equal(getReleasedItemsForClass(cls, ANA).Apostila_U2, true);
    assert.equal(getReleasedItemsForClass(cls, ANA).Apostila_U1, true, 'liberado em outro grupo dela vence o bloqueio do Laboratório A');
    assert.equal(getReleasedItemsForClass(cls, BIA).Apostila_U1, false, 'o grupo da Bia bloqueia a unidade 1 para ela');
    assert.equal(getReleasedItemsForClass(cls, BIA).Apostila_U2, false, 'a exceção individual vence o grupo');
    assert.equal(getReleasedItemsForClass(cls, DUDA).Apostila_U2, false, 'grupo arquivado não vale');
    assert.equal(getReleasedItemsForClass(cls, '').Apostila_U2, false, 'a visão da turma não muda');

    // Arquivar o grupo pela tela: a liberação deixa de valer; reativar volta.
    await as('prof', request(app).post(`/api/admin/class-groups/${GRP_A}/archive`)).send({}).expect(200);
    assert.equal((await releasedFor(BIA)).Apostila_U1, true);
    assert.equal((await releasedFor(ANA)).Apostila_U2, false);
    await as('prof', request(app).post(`/api/admin/class-groups/${GRP_A}/restore`)).send({}).expect(200);
    assert.equal((await releasedFor(ANA)).Apostila_U2, true);

    // Quem sai do grupo perde a liberação dele; quem sai da turma também.
    db.memory.students.find(item => item.email === ANA).classes = [{ name: OTHER, courseId: COURSE }];
    assert.equal(getReleasedItemsForClass(cls, ANA).Apostila_U2, false);
});

test('[UC-GRUPO-003] gabarito por grupo: 409 com prova aberta; liberado, continua bloqueado quando a prova volta a abrir', async () => {
    db.memory.examApplications = [{ id: 'app_aberta', examKey: 'Avaliacao_P1', courseId: COURSE, studentClass: CLASS, status: 'running', createdAt: new Date().toISOString() }];
    const blocked = await release({ itemKey: 'Gabarito_Avaliacao_P1', released: true, groupId: GRP_A });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(db.memory.classes[0].groupReleasedItems, undefined);

    db.memory.examApplications[0].status = 'finished';
    const ok = await release({ itemKey: 'Gabarito_Avaliacao_P1', released: true, groupId: GRP_A });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await releasedFor(ANA)).Gabarito_Avaliacao_P1, true);
    assert.equal((await releasedFor(CAIO)).Gabarito_Avaliacao_P1, false);

    // Outra aplicação da mesma prova aberta: o gabarito do grupo aparece bloqueado.
    db.memory.examApplications.push({ id: 'app_nova', examKey: 'Avaliacao_P1', courseId: COURSE, studentClass: CLASS, status: 'prepared', createdAt: new Date().toISOString() });
    assert.equal((await releasedFor(ANA)).Gabarito_Avaliacao_P1, false);
});

test('[UC-GRUPO-003] liberação por grupo recusada: prova online, grupo + aluno, agenda, grupo de outra turma ou arquivado, fora do escopo', async () => {
    const exam = await release({ itemKey: 'Avaliacao_P1', released: true, groupId: GRP_A });
    assert.equal(exam.status, 400);
    assert.equal(exam.body.code, 'group_exam');
    assert.match(exam.body.error, /Para quem/);
    const both = await release({ itemKey: 'Apostila_U2', released: true, groupId: GRP_A, studentEmail: ANA });
    assert.equal(both.status, 400);
    const scheduled = await release({ itemKey: 'Apostila_U2', released: true, groupId: GRP_A, releaseAtLocal: '2099-01-01T08:00' });
    assert.equal(scheduled.status, 400);
    const other = await release({ itemKey: 'Apostila_U2', released: true, groupId: GRP_OTHER });
    assert.equal(other.status, 404);
    assert.equal(other.body.code, 'group_not_found');
    const archived = await release({ itemKey: 'Apostila_U2', released: true, groupId: GRP_OLD });
    assert.equal(archived.status, 404);
    const outside = await release({ itemKey: 'Apostila_U2', released: true, groupId: GRP_A }, 'prof2');
    assert.equal(outside.status, 403);
    assert.equal(db.memory.classes[0].groupReleasedItems, undefined, 'nada foi gravado');
    // Chave fora do esquema (objeto) é recusada pelo inputSchema.
    const bad = await release({ itemKey: 'Apostila_U2', released: true, groupId: { $ne: 1 } });
    assert.equal(bad.status, 400);
});

test('[UC-GRUPO-003] a variante "só desta turma" nasce liberada para os mesmos grupos; o curso clonado não leva a liberação por grupo', () => {
    const { remapCourseKeys } = require('../../backend/utils/coursePackage.js');
    const { forkMaterial, forkEvaluation } = require('../../backend/utils/classContent.js');
    const cls = db.memory.classes[0];
    cls.groupReleasedItems = { [GRP_A]: { Apostila_U2: true, Gabarito_Avaliacao_P1: true } };
    db.memory.evaluations = { Avaliacao_P1: { title: 'Prova 1', questions: [] } };
    const material = forkMaterial({ courseId: COURSE, className: CLASS, key: 'Apostila_U2' });
    const evaluation = forkEvaluation({ courseId: COURSE, className: CLASS, key: 'Avaliacao_P1' });
    assert.equal(cls.groupReleasedItems[GRP_A][material.key], true);
    assert.equal(cls.groupReleasedItems[GRP_A][`Gabarito_${evaluation.key}`], true);
    assert.equal(getReleasedItemsForClass(cls, ANA)[material.key], true, 'o membro vê a variante da turma');
    assert.equal(getReleasedItemsForClass(cls, CAIO)[material.key], false);
    cls.groupReleasedItems = { [GRP_A]: { Apostila_U2: true } };
    const cloned = remapCourseKeys({ course: db.memory.courses[0], classes: [cls], newCourseId: 'curso-novo', mapKey: key => `${key}_n` });
    assert.equal(cloned.classes[0].groupReleasedItems, undefined);
    assert.deepEqual(cls.groupReleasedItems, { [GRP_A]: { Apostila_U2: true } }, 'o original não muda');
});

// ---------------------------------------------------------------------------
// Avisos e calendário
// ---------------------------------------------------------------------------

test('[UC-GRUPO-003] aviso para um grupo: só os membros veem (avisos, sino e Início); arquivar o grupo tira; o painel mostra o grupo', async () => {
    const missing = await as('prof', request(app).post('/api/admin/announcements')).send({ title: 'Lab', message: 'Tragam o kit', target: 'grupo', targetValue: '', ...Q });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, 'Escolha o grupo.');
    const archived = await as('prof', request(app).post('/api/admin/announcements')).send({ title: 'Lab', message: 'x', target: 'grupo', targetValue: GRP_OLD, ...Q });
    assert.equal(archived.status, 400);
    const wrongClass = await as('prof', request(app).post('/api/admin/announcements')).send({ title: 'Lab', message: 'x', target: 'grupo', targetValue: GRP_OTHER, ...Q });
    assert.equal(wrongClass.status, 400);
    const outside = await as('prof2', request(app).post('/api/admin/announcements')).send({ title: 'Lab', message: 'x', target: 'grupo', targetValue: GRP_A, ...Q });
    assert.equal(outside.status, 403);
    assert.equal(db.memory.announcements.length, 0);

    const created = await as('prof', request(app).post('/api/admin/announcements')).send({ title: 'Laboratório amanhã', message: 'Tragam o kit', target: 'grupo', targetValue: GRP_A, ...Q });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const ann = db.memory.announcements[0];
    assert.equal(ann.target, 'grupo');
    assert.equal(ann.targetValue, GRP_A);
    assert.equal(ann.courseId, COURSE);
    assert.equal(ann.studentClass, CLASS);
    assert.equal(created.body.announcement.grupo.nome, 'Laboratório A');

    const anaList = await announcementsOf(ANA);
    assert.deepEqual(anaList.map(item => [item.id, item.grupo]), [[ann.id, 'Laboratório A']]);
    assert.deepEqual(await announcementsOf(CAIO), []);
    assert.deepEqual(await announcementsOf(DUDA), []);
    const bell = await asStudent(ANA, request(app).get('/api/student/notifications')).query(Q).expect(200);
    assert.ok(JSON.stringify(bell.body).includes(`aviso:${ann.id}`));
    const bellCaio = await asStudent(CAIO, request(app).get('/api/student/notifications')).query(Q).expect(200);
    assert.ok(!JSON.stringify(bellCaio.body).includes(`aviso:${ann.id}`));
    const home = await asStudent(BIA, request(app).get('/api/student/dashboard')).query(Q).expect(200);
    assert.deepEqual(home.body.announcements.map(item => item.id), [ann.id]);
    const homeCaio = await asStudent(CAIO, request(app).get('/api/student/dashboard')).query(Q).expect(200);
    assert.deepEqual(homeCaio.body.announcements, []);
    await asStudent(CAIO, request(app).post('/api/student/announcements/read')).send({ id: ann.id }).expect(404);
    await asStudent(ANA, request(app).post('/api/student/announcements/read')).send({ id: ann.id }).expect(200);

    // Painel: a lista da turma traz o aviso com o grupo; o professor de outra turma não vê.
    const panel = await as('prof', request(app).get('/api/admin/announcements')).query(Q).expect(200);
    assert.deepEqual(panel.body.map(item => [item.id, item.grupo && item.grupo.nome, item.canEdit]), [[ann.id, 'Laboratório A', true]]);
    const panel2 = await as('prof2', request(app).get('/api/admin/announcements')).expect(200);
    assert.deepEqual(panel2.body, []);

    // Editar o texto de um aviso de grupo arquivado continua possível; trocar para outro
    // grupo arquivado não.
    await as('prof', request(app).post(`/api/admin/class-groups/${GRP_A}/archive`)).send({}).expect(200);
    assert.deepEqual(await announcementsOf(ANA), [], 'grupo arquivado: o aviso deixa de valer');
    await as('prof', request(app).post('/api/admin/announcements/update')).send({ id: ann.id, title: 'Laboratório (corrigido)' }).expect(200);
    const toArchived = await as('prof', request(app).post('/api/admin/announcements/update')).send({ id: ann.id, target: 'grupo', targetValue: GRP_OLD, ...Q });
    assert.equal(toArchived.status, 400);
    await as('prof', request(app).post(`/api/admin/class-groups/${GRP_A}/restore`)).send({}).expect(200);
    assert.deepEqual((await announcementsOf(ANA)).map(item => item.title), ['Laboratório (corrigido)']);

    // Trocar o destino para a turma: todos veem.
    await as('prof', request(app).post('/api/admin/announcements/update')).send({ id: ann.id, target: 'turma', targetValue: CLASS, courseId: COURSE }).expect(200);
    assert.equal(db.memory.announcements[0].studentClass, CLASS);
    assert.equal((await announcementsOf(CAIO)).length, 1);
});

test('[UC-GRUPO-003] evento do calendário para um grupo: só os membros veem; o painel e a agenda .ics da turma mostram', async () => {
    const body = { title: 'Prática no laboratório', eventDate: '2099-03-10', startTime: '08:00', courseId: COURSE, target: 'grupo', targetValue: GRP_B, studentClass: CLASS, eventType: 'aula' };
    const outside = await as('prof2', request(app).post('/api/admin/announcements/calendar')).send(body);
    assert.equal(outside.status, 403);
    const created = await as('prof', request(app).post('/api/admin/announcements/calendar')).send(body);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const event = db.memory.announcements[0];
    assert.equal(event.kind, 'calendar');
    assert.equal(event.target, 'grupo');
    assert.equal(event.studentClass, CLASS);

    const caio = await asStudent(CAIO, request(app).get('/api/student/calendar-events')).query(Q).expect(200);
    assert.deepEqual(caio.body.filter(item => item.id === event.id).map(item => item.grupo), ['Laboratório B']);
    const ana = await asStudent(ANA, request(app).get('/api/student/calendar-events')).query(Q).expect(200);
    assert.equal(ana.body.some(item => item.id === event.id), false);
    const homeCaio = await asStudent(CAIO, request(app).get('/api/student/dashboard')).query(Q).expect(200);
    assert.ok(homeCaio.body.calendar.some(item => item.id === event.id));

    const panel = await as('prof', request(app).get('/api/admin/announcements/calendar')).query(Q).expect(200);
    assert.deepEqual(panel.body.filter(item => item.id === event.id).map(item => item.grupo.nome), ['Laboratório B']);
    const ics = await as('prof', request(app).get('/api/admin/calendar/ics')).query(Q).expect(200);
    assert.match(ics.text, /Prática no laboratório/);

    // Editar para a turma tira o studentClass do grupo; voltar para grupo exige o grupo.
    const noGroup = await as('prof', request(app).post('/api/admin/announcements/calendar/update')).send({ ...body, id: event.id, targetValue: '' });
    assert.equal(noGroup.status, 400);
    await as('prof', request(app).post('/api/admin/announcements/calendar/update')).send({ ...body, id: event.id, target: 'turma', targetValue: CLASS }).expect(200);
    assert.equal(db.memory.announcements[0].target, 'turma');
    assert.equal(db.memory.announcements[0].studentClass, undefined);
    const anaAfter = await asStudent(ANA, request(app).get('/api/student/calendar-events')).query(Q).expect(200);
    assert.equal(anaAfter.body.some(item => item.id === event.id), true);
});

// ---------------------------------------------------------------------------
// Chamada por grupo
// ---------------------------------------------------------------------------

function attendanceRecord(email, status) {
    return { id: `att_${email}`, studentEmail: email, studentClass: CLASS, courseId: COURSE, date: DATE, origin: 'chamada', concluida: true, aulas: [{ ordem: 1, disciplinaId: '', status, hora: '' }], markedBy: 'prof@uso.local', timestamp: 1 };
}

test('[UC-GRUPO-003] chamada com groupId: roster só com os membros, bulk só grava membros e não muda os outros, exportação filtra', async () => {
    db.memory.attendance = [attendanceRecord(CAIO, 'falta'), attendanceRecord(DUDA, 'presente')];
    const roster = await as('prof', request(app).get('/api/admin/attendance/roster')).query({ ...Q, date: DATE, groupId: GRP_A, mesmoAssim: '1' }).expect(200);
    assert.deepEqual(roster.body.roster.map(item => item.email).sort(), [ANA, BIA]);
    assert.deepEqual(roster.body.grupo, { id: GRP_A, nome: 'Laboratório A', conjunto: 'Laboratório', arquivado: false });
    assert.deepEqual(roster.body.grupos.map(item => item.id), [GRP_A, GRP_B]);
    const whole = await as('prof', request(app).get('/api/admin/attendance/roster')).query({ ...Q, date: DATE, mesmoAssim: '1' }).expect(200);
    assert.deepEqual(whole.body.roster.map(item => item.email).sort(), [ANA, BIA, CAIO, DUDA], 'sem grupo, a turma inteira como antes');
    assert.equal(whole.body.grupo, null);

    const before = JSON.stringify(db.memory.attendance.filter(item => item.studentEmail !== ANA));
    const aula = status => [{ ordem: 1, disciplinaId: '', status }];
    const saved = await as('prof', request(app).post('/api/admin/attendance/bulk')).send({
        ...Q, date: DATE, groupId: GRP_A, concluida: true,
        entries: [{ email: ANA, aulas: aula('falta') }, { email: CAIO, aulas: aula('presente') }, { email: DUDA, aulas: aula('falta') }],
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.saved, 1);
    assert.equal(saved.body.skipped, 2);
    assert.equal(saved.body.foraDoGrupo, 2);
    assert.equal(JSON.stringify(db.memory.attendance.filter(item => item.studentEmail !== ANA)), before, 'quem não é do grupo fica como estava');
    assert.equal(db.memory.attendance.find(item => item.studentEmail === ANA).aulas[0].status, 'falta');

    const csv = await as('prof', request(app).get('/api/admin/attendance/export')).query({ ...Q, groupId: GRP_B }).expect(200);
    const lines = csv.text.replace(/^﻿/, '').trim().split(/\r?\n/);
    assert.equal(lines.length, 2, csv.text);
    assert.match(lines[1], /Caio Prado/);
    assert.match(csv.headers['content-disposition'], /presenca_1USO_Laboratorio_B\.csv/);
    const all = await as('prof', request(app).get('/api/admin/attendance/export')).query(Q).expect(200);
    assert.equal(all.text.trim().split(/\r?\n/).length, 4);

    for (const groupId of [GRP_OLD, GRP_OTHER, 'grp_inexistente']) {
        const res = await as('prof', request(app).get('/api/admin/attendance/roster')).query({ ...Q, date: DATE, groupId });
        assert.equal(res.status, 404, groupId);
        assert.equal(res.body.code, 'group_not_found');
        const bulk = await as('prof', request(app).post('/api/admin/attendance/bulk')).send({ ...Q, date: DATE, groupId, entries: [] });
        assert.equal(bulk.status, 404, groupId);
    }
});

// ---------------------------------------------------------------------------
// Pré-visualização com grupo (UC-PREVIA-002, com o grupo)
// ---------------------------------------------------------------------------

test('[UC-GRUPO-003] pré-visualização com grupo vê o que um membro vê (liberação e aviso do grupo); sem grupo, o que a turma vê', async () => {
    db.memory.classes[0].groupReleasedItems = { [GRP_A]: { Apostila_U2: true } };
    db.memory.announcements = [{ id: 'ann_g', title: 'Só do lab A', message: 'x', target: 'grupo', targetValue: GRP_A, courseId: COURSE, studentClass: CLASS, createdAt: 1, readBy: [] }];
    const withGroup = await as('prof', request(app).post('/api/admin/preview-sessions')).send({ ...Q, groupId: GRP_A });
    assert.equal(withGroup.status, 200, JSON.stringify(withGroup.body));
    const without = await as('prof', request(app).post('/api/admin/preview-sessions')).send(Q);
    assert.equal(without.status, 200);
    const view = async token => {
        const status = await request(app).get('/api/status').set('x-preview-session', token).query(Q).expect(200);
        const anns = await request(app).get('/api/student/announcements').set('x-preview-session', token).query(Q).expect(200);
        return { u2: status.body.releasedItems.Apostila_U2, avisos: anns.body.map(item => item.id) };
    };
    assert.deepEqual(await view(withGroup.body.previewToken), { u2: true, avisos: ['ann_g'] });
    assert.deepEqual(await view(without.body.previewToken), { u2: false, avisos: [] });
    // Arquivado depois de abrir a prévia: deixa de valer também nela.
    await as('prof', request(app).post(`/api/admin/class-groups/${GRP_A}/archive`)).send({}).expect(200);
    assert.deepEqual(await view(withGroup.body.previewToken), { u2: false, avisos: [] });
});
