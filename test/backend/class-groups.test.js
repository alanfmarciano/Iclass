// Grupos de alunos da turma (fase 3, C12 / P5-S4, CRIT-11; D16 e D17 do P5).
// [UC-GRUPO-001] criar, alterar, mover, arquivar e reativar, com escopo, exclusividade
//   por conjunto, nome único sem acento, aluno de fora 400 e versão velha 409.
// [UC-GRUPO-002] sorteio: mesma semente, mesma proposta; tamanhos diferem no máximo em 1;
//   confirmar com a turma mudada 409 roster_changed; somenteSemGrupo respeita quem tem grupo.
// [UC-GRUPO-004] ciclo de vida do aluno nos grupos: troca de e-mail, anonimizar, apagar de
//   vez, Meus dados, Cadastros encerrados, religar o id e backup antigo (missing 'keep').
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-grupos-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const classGroups = require('../../backend/utils/classGroups.js');
const studentData = require('../../backend/utils/studentDataHandlers.js');
const { missingCollectionOutcome } = require('../../backend/utils/backupSchema.js');
const { anonymizeStudentAuditTrail, studentEmailOwnership } = require('../../backend/utils/gradebook.js');
const { createAdminSession, createStudentSession } = require('../../backend/utils/authSessions.js');
const { createApp } = require('../../backend/server.js');

const COURSE = 'curso-grupos';
const CLASS = '1GRU';
const OTHER = '2GRU';
const ANA = 'ana@grupos.local';
const BIA = 'bia@grupos.local';
const CAIO = 'caio@grupos.local';
const DUDA = 'duda@grupos.local';
const EDU = 'edu@grupos.local';
const FABIO = 'fabio@grupos.local';
const GIL = 'gil@grupos.local';
const SEM_EMAIL = 'aluno-alu_00000000000000h8@sem-email.invalid';
const tokens = {};
let app;

const as = (name, req) => req.set('x-admin-session', tokens[name]);
const asStudent = (email, req) => req.set('x-session-token', tokens[email]);
const audits = action => (db.memory.auditLogs || []).filter(entry => entry.action === action);
const Q = `courseId=${COURSE}&studentClass=${CLASS}`;

function student(id, name, email, extra = {}) {
    return { id, name, email, matricula: `M-${id.slice(-2)}`, status: 'Ativo', password: db.hashPassword('Senha-forte-123'), classes: [{ name: CLASS, courseId: COURSE }], ...extra };
}

function seed() {
    db.memory.config = { ...(db.memory.config || {}), settings: { timezone: 'America/Sao_Paulo' } };
    db.memory.schools = [{ id: 'escola_g', name: 'Escola G', info: {}, branding: {} }];
    db.memory.courses = [{ id: COURSE, name: 'Curso dos grupos', schoolId: 'escola_g', structure: [] }];
    db.memory.classes = [{ name: CLASS, courseId: COURSE, period: 'Manhã' }, { name: OTHER, courseId: COURSE, period: 'Tarde' }];
    db.memory.students = [
        student('alu_00000000000000a1', 'Ana Souza', ANA),
        student('alu_00000000000000b2', 'Beatriz Lima', BIA, { nomeSocial: 'Bia' }),
        student('alu_00000000000000c3', 'Caio Prado', CAIO),
        student('alu_00000000000000d4', 'Duda Reis', DUDA),
        student('alu_00000000000000e5', 'Edu Teles', EDU),
        student('alu_00000000000000f6', 'Fábio Nunes', FABIO, { classes: [{ name: OTHER, courseId: COURSE }] }),
        student('alu_00000000000000g7', 'Gil Mota', GIL, { status: 'Inativo' }),
        student('alu_00000000000000h8', 'Hana Sem Email', SEM_EMAIL),
    ];
    db.memory.admins = [
        { email: 'adm@grupos.local', name: 'Administração', role: 'admin', password: db.hashPassword('Senha-forte-2026') },
        { email: 'prof@grupos.local', name: 'Professora', role: 'professor', password: db.hashPassword('Senha-forte-2026'), assignedClasses: [{ courseId: COURSE, className: CLASS }] },
        { email: 'prof2@grupos.local', name: 'Outro', role: 'professor', password: db.hashPassword('Senha-forte-2026'), assignedClasses: [{ courseId: COURSE, className: OTHER }] },
        { email: 'coord@grupos.local', name: 'Coordenação', role: 'coordenacao', password: db.hashPassword('Senha-forte-2026'), assignedSchoolIds: ['escola_g'] },
    ];
    db.memory.adminSessions = {};
    db.memory.sessions = {};
    db.memory.classGroups = [];
    db.memory.auditLogs = [];
    db.memory.submissions = [];
    db.memory.attendance = [];
    db.memory.certificates = [];
    tokens.admin = createAdminSession(db.memory, 'adm@grupos.local');
    tokens.prof = createAdminSession(db.memory, 'prof@grupos.local');
    tokens.prof2 = createAdminSession(db.memory, 'prof2@grupos.local');
    tokens.coord = createAdminSession(db.memory, 'coord@grupos.local');
    [ANA, BIA, FABIO].forEach(email => { tokens[email] = createStudentSession(db.memory, email); });
}

async function create(body, who = 'prof') {
    return as(who, request(app).post('/api/admin/class-groups')).send({ courseId: COURSE, studentClass: CLASS, ...body });
}

async function createOk(body, who) {
    const res = await create(body, who);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.grupo;
}

async function update(id, body, who = 'prof') {
    return as(who, request(app).post(`/api/admin/class-groups/${id}/update`)).send(body);
}

async function draw(body, who = 'prof') {
    return as(who, request(app).post('/api/admin/class-groups/draw')).send({ courseId: COURSE, studentClass: CLASS, ...body });
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
// [UC-GRUPO-001] criar, alterar, arquivar e reativar
// ---------------------------------------------------------------------------

test('[UC-GRUPO-001] o professor da turma cria um grupo; a linha segue o modelo e a auditoria vai na mesma gravação', async () => {
    const saves = [];
    const original = db.save;
    db.save = function spied(...args) { saves.push(args[0]); return original.apply(this, args); };
    let res;
    try {
        res = await create({ nome: '  Laboratório   A ', conjunto: 'Laboratório', tipo: 'subturma', membros: [ANA, 'BIA@grupos.local', ANA] });
    } finally { db.save = original; }
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(saves, [{ only: ['classGroups', 'auditLogs'] }]);
    const row = db.memory.classGroups[0];
    assert.match(row.id, /^grp_\d{13}_[0-9a-f]{6}$/);
    assert.equal(row.schemaVersion, 1);
    assert.equal(row.nome, 'Laboratório A');
    assert.equal(row.conjunto, 'Laboratório');
    assert.equal(row.tipo, 'subturma');
    assert.equal(row.arquivadoEm, null);
    assert.deepEqual(row.membros.map(member => [member.email, member.studentId, member.adicionadoPor]), [
        [ANA, 'alu_00000000000000a1', 'prof@grupos.local'],
        [BIA, 'alu_00000000000000b2', 'prof@grupos.local'],
    ]);
    assert.equal(typeof row.membros[0].adicionadoEm, 'number');
    // Resposta: membros por nome (nome social), com a matrícula e na turma.
    assert.deepEqual(res.body.grupo.membros.map(member => [member.nome, member.matricula, member.naTurma]), [['Ana Souza', 'M-a1', true], ['Bia', 'M-b2', true]]);
    const [entry] = audits('class_group_created');
    assert.equal(entry.category, 'academic');
    assert.equal(entry.courseId, COURSE);
    assert.equal(entry.studentClass, CLASS);
    assert.deepEqual(entry.details, { groupId: row.id, nome: 'Laboratório A', conjunto: 'Laboratório', tipo: 'subturma', membros: 2 });
    // Sem conjunto: 'Grupos'; sem tipo: equipe.
    const plain = await createOk({ nome: 'Turma toda', membros: [] });
    assert.equal(plain.conjunto, 'Grupos');
    assert.equal(plain.tipo, 'equipe');
});

test('[UC-GRUPO-001] aluno em dois grupos do mesmo conjunto 409; em conjuntos diferentes pode', async () => {
    await createOk({ nome: 'Equipe 2', conjunto: 'Projeto', membros: [ANA] });
    const busy = await create({ nome: 'Equipe 3', conjunto: 'projeto', membros: [BIA, ANA] });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.code, 'student_in_other_group');
    assert.equal(busy.body.error, 'Ana Souza já está no grupo Equipe 2 deste conjunto.');
    assert.equal(db.memory.classGroups.length, 1, 'nada criado');
    const otherSet = await createOk({ nome: 'Lab A', conjunto: 'Laboratório', membros: [ANA] });
    assert.equal(otherSet.membros[0].email, ANA);
    // O conjunto digitado sem acento entra na grafia do que já existe.
    const same = await createOk({ nome: 'Lab B', conjunto: 'LABORATORIO', membros: [BIA] });
    assert.equal(same.conjunto, 'Laboratório');
});

test('[UC-GRUPO-001] nome repetido sem acento e maiúscula no mesmo conjunto 409; em outro conjunto pode', async () => {
    await createOk({ nome: 'Equipe Única', conjunto: 'Projeto' });
    const repeated = await create({ nome: 'equipe unica', conjunto: 'Projeto' });
    assert.equal(repeated.status, 409);
    assert.equal(repeated.body.code, 'group_name_taken');
    assert.equal(repeated.body.field, 'nome');
    await createOk({ nome: 'Equipe Única', conjunto: 'Outro projeto' });
});

test('[UC-GRUPO-001] aluno de outra turma, desligado ou desconhecido 400; campos inválidos 400', async () => {
    for (const email of [FABIO, GIL, 'ninguem@grupos.local']) {
        const res = await create({ nome: 'Equipe', membros: [email] });
        assert.equal(res.status, 400, email);
        assert.equal(res.body.code, 'student_not_in_class', email);
        assert.equal(res.body.field, 'membros');
    }
    assert.match((await create({ nome: 'Equipe', membros: [FABIO] })).body.error, /Fábio Nunes não está matriculado nesta turma/);
    assert.equal((await create({ nome: '' })).status, 400);
    assert.equal((await create({ nome: 'x'.repeat(61) })).status, 400);
    assert.equal((await create({ nome: 'Ok', conjunto: 'y'.repeat(41) })).status, 400);
    assert.equal((await create({ nome: 'Ok', tipo: 'turma' })).status, 400);
    assert.equal((await create({ nome: 'Ok', membros: 'ana' })).status, 400);
    assert.equal((await as('admin', request(app).post('/api/admin/class-groups')).send({ courseId: COURSE, studentClass: 'NAO', nome: 'X' })).status, 404);
    assert.equal((await as('prof', request(app).post('/api/admin/class-groups')).send({ courseId: COURSE, studentClass: 'NAO', nome: 'X' })).status, 403, 'professor: turma fora do escopo');
    // Aluno sem e-mail (endereço interno) entra pelo endereço da lista; a tela mostra 'sem e-mail'.
    const group = await createOk({ nome: 'Com Hana', membros: [SEM_EMAIL] });
    assert.equal(group.membros[0].nome, 'Hana Sem Email');
    assert.equal(db.memory.classGroups.length, 1);
});

test('[UC-GRUPO-001] alterar: nome, tipo, entra e sai com auditoria; versão velha 409 group_changed; sem mudança não grava', async () => {
    const group = await createOk({ nome: 'Equipe 1', conjunto: 'Projeto', membros: [ANA, BIA] });
    const stale = await update(group.id, { nome: 'Nova', atualizadoEm: group.atualizadoEm - 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'group_changed');
    assert.equal((await update(group.id, { nome: 'Sem versão' })).status, 400);

    const res = await update(group.id, { nome: 'Equipe Alfa', tipo: 'subturma', adicionar: [CAIO], remover: [BIA], atualizadoEm: group.atualizadoEm });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.changed, true);
    assert.deepEqual(res.body.grupo.membros.map(member => member.email), [ANA, CAIO]);
    assert.equal(res.body.grupo.tipo, 'subturma');
    const [entry] = audits('class_group_updated');
    assert.deepEqual(entry.details, { groupId: group.id, adicionados: [CAIO], removidos: [BIA], nome: { antes: 'Equipe 1', depois: 'Equipe Alfa' }, tipo: { antes: 'equipe', depois: 'subturma' } });

    const before = audits('class_group_updated').length;
    const again = await update(group.id, { nome: 'Equipe Alfa', adicionar: [ANA], atualizadoEm: res.body.grupo.atualizadoEm });
    assert.equal(again.status, 200);
    assert.equal(again.body.changed, false);
    assert.equal(audits('class_group_updated').length, before);
    // Quem entra precisa estar na turma.
    assert.equal((await update(group.id, { adicionar: [FABIO], atualizadoEm: res.body.grupo.atualizadoEm })).status, 400);
});

test('[UC-GRUPO-001] "Mover para": sem mover 409; com mover, sai do outro grupo do conjunto e os dois ficam na auditoria', async () => {
    const one = await createOk({ nome: 'Equipe 1', conjunto: 'Projeto', membros: [ANA, BIA] });
    const two = await createOk({ nome: 'Equipe 2', conjunto: 'Projeto', membros: [CAIO] });
    const refused = await update(two.id, { adicionar: [ANA], atualizadoEm: two.atualizadoEm });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.groupId, one.id);
    const moved = await update(two.id, { adicionar: [ANA], mover: true, atualizadoEm: two.atualizadoEm });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual(moved.body.grupo.membros.map(member => member.email), [ANA, CAIO]);
    assert.deepEqual(moved.body.alterados.map(group => [group.id, group.membros.map(member => member.email)]), [[one.id, [BIA]]]);
    assert.deepEqual(classGroups.groupsOfStudent(db.memory, { courseId: COURSE, name: CLASS }, ANA).map(group => group.id), [two.id]);
    const entries = audits('class_group_updated');
    assert.deepEqual(entries.map(entry => [entry.details.groupId, entry.details.adicionados, entry.details.removidos]), [
        [two.id, [ANA], []],
        [one.id, [], [ANA]],
    ]);
    // Trocar o conjunto do grupo confere a regra no conjunto novo.
    await createOk({ nome: 'Lab A', conjunto: 'Laboratório', membros: [CAIO] });
    const clash = await update(two.id, { conjunto: 'Laboratório', atualizadoEm: moved.body.grupo.atualizadoEm });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.code, 'student_in_other_group');
});

test('[UC-GRUPO-001] arquivar e reativar: some da lista, deixa de valer, reativar confere nome e membros', async () => {
    const group = await createOk({ nome: 'Lab A', conjunto: 'Laboratório', membros: [ANA] });
    const archived = await as('prof', request(app).post(`/api/admin/class-groups/${group.id}/archive`)).send({ motivo: 'Fim do semestre' });
    assert.equal(archived.status, 200, JSON.stringify(archived.body));
    assert.equal(archived.body.grupo.arquivado, true);
    assert.deepEqual(audits('class_group_archived')[0].details, { groupId: group.id, nome: 'Lab A', motivo: 'Fim do semestre' });
    assert.equal(db.memory.classGroups.length, 1, 'nada sai da coleção');
    const list = await as('prof', request(app).get(`/api/admin/class-groups?${Q}`));
    assert.deepEqual(list.body.grupos, []);
    const withArchived = await as('prof', request(app).get(`/api/admin/class-groups?${Q}&arquivados=1`));
    assert.deepEqual(withArchived.body.grupos.map(item => [item.id, item.arquivado]), [[group.id, true]]);
    assert.deepEqual(classGroups.groupMemberEmails(db.memory, group.id), [], 'arquivado não vale');
    assert.deepEqual(classGroups.groupsOfStudent(db.memory, { courseId: COURSE, name: CLASS }, ANA), []);
    const blocked = await update(group.id, { nome: 'X', atualizadoEm: archived.body.grupo.atualizadoEm });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'group_archived');
    // Arquivar de novo não grava nem registra.
    assert.equal((await as('prof', request(app).post(`/api/admin/class-groups/${group.id}/archive`)).send({})).body.changed, false);
    assert.equal(audits('class_group_archived').length, 1);

    // Enquanto estava arquivado, a Ana entrou em outro grupo do conjunto e outro grupo pegou o nome.
    const other = await createOk({ nome: 'Lab A', conjunto: 'Laboratório', membros: [BIA] });
    const nameClash = await as('prof', request(app).post(`/api/admin/class-groups/${group.id}/restore`)).send({});
    assert.equal(nameClash.status, 409);
    assert.equal(nameClash.body.code, 'group_name_taken');
    await update(other.id, { nome: 'Lab B', adicionar: [ANA], atualizadoEm: other.atualizadoEm });
    const memberClash = await as('prof', request(app).post(`/api/admin/class-groups/${group.id}/restore`)).send({});
    assert.equal(memberClash.status, 409);
    assert.equal(memberClash.body.code, 'student_in_other_group');
    assert.match(memberClash.body.error, /Ana Souza já está no grupo Lab B/);
    const current = classGroups.findGroup(db.memory, other.id);
    await update(other.id, { remover: [ANA], atualizadoEm: current.atualizadoEm });
    const restored = await as('prof', request(app).post(`/api/admin/class-groups/${group.id}/restore`)).send({});
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.grupo.arquivado, false);
    assert.equal(audits('class_group_restored').length, 1);
});

test('[UC-GRUPO-001] escopo: professor de outra turma 403 pela turma e pelo grupo; coordenação só consulta; grupo inexistente 404', async () => {
    const group = await createOk({ nome: 'Equipe 1', membros: [ANA] });
    assert.equal((await as('prof2', request(app).get(`/api/admin/class-groups?${Q}`))).status, 403);
    assert.equal((await create({ nome: 'Intruso' }, 'prof2')).status, 403);
    assert.equal((await draw({ criterio: 'quantidade', valor: 2 }, 'prof2')).status, 403);
    for (const suffix of ['update', 'archive', 'restore']) {
        const res = await as('prof2', request(app).post(`/api/admin/class-groups/${group.id}/${suffix}`)).send({ nome: 'X', atualizadoEm: group.atualizadoEm });
        assert.equal(res.status, 403, suffix);
        // Outra caixa no caminho não escapa do escopo.
        const upper = await as('prof2', request(app).post(`/api/admin/CLASS-GROUPS/${group.id}/${suffix}`)).send({ nome: 'X', atualizadoEm: group.atualizadoEm });
        assert.equal(upper.status, 403, `${suffix} (caixa)`);
    }
    assert.equal(classGroups.findGroup(db.memory, group.id).nome, 'Equipe 1');
    const coordList = await as('coord', request(app).get(`/api/admin/class-groups?${Q}`));
    assert.equal(coordList.status, 200);
    assert.equal(coordList.body.grupos.length, 1);
    const coordWrite = await create({ nome: 'Coord' }, 'coord');
    assert.equal(coordWrite.status, 403);
    assert.equal(coordWrite.body.code, 'read_only_account');
    assert.equal((await as('prof', request(app).post('/api/admin/class-groups/grp_nao_existe/archive')).send({})).status, 404);
    // O administrador pleno vê qualquer turma.
    assert.equal((await as('admin', request(app).get(`/api/admin/class-groups?courseId=${COURSE}&studentClass=${OTHER}`))).status, 200);
});

test('[UC-GRUPO-001] lista do painel: quem saiu da turma fica marcado e não conta; sem grupo por conjunto; leitores do contrato C2', async () => {
    const lab = await createOk({ nome: 'Lab A', conjunto: 'Laboratório', membros: [ANA, BIA, CAIO] });
    await createOk({ nome: 'Equipe 1', conjunto: 'Projeto', membros: [DUDA] });
    // A Bia sai da turma; o Caio é desligado.
    db.memory.students.find(item => item.email === BIA).classes = [{ name: OTHER, courseId: COURSE }];
    db.memory.students.find(item => item.email === CAIO).status = 'Transferido';
    const res = await as('prof', request(app).get(`/api/admin/class-groups?${Q}`));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.turma, { courseId: COURSE, nome: CLASS, curso: 'Curso dos grupos' });
    assert.equal(res.body.limites.nameMax, 60);
    const shown = res.body.grupos.find(item => item.id === lab.id);
    assert.deepEqual(shown.membros.map(member => [member.email, member.naTurma]), [[ANA, true], [BIA, false], [CAIO, false]]);
    assert.equal(shown.membrosNaTurma, 1);
    assert.deepEqual(res.body.conjuntos, ['Laboratório', 'Projeto']);
    assert.deepEqual(res.body.semGrupo['Laboratório'], [SEM_EMAIL, DUDA, EDU].sort((a, b) => {
        const name = email => db.memory.students.find(item => item.email === email).name;
        return name(a).localeCompare(name(b), 'pt-BR');
    }));
    assert.deepEqual(res.body.alunos.map(item => item.nome), ['Ana Souza', 'Duda Reis', 'Edu Teles', 'Hana Sem Email']);
    assert.deepEqual(classGroups.groupMemberEmails(db.memory, lab.id), [ANA]);
    assert.deepEqual(classGroups.groupMemberEmails(db.memory, lab.id, { cls: { courseId: COURSE, name: OTHER } }), [], 'turma de outro grupo');
    assert.deepEqual(classGroups.groupMemberEmails(db.memory, 'grp_nao'), []);
    assert.deepEqual(classGroups.groupsOfStudent(db.memory, { courseId: COURSE, name: CLASS }, 'ANA@grupos.local').map(group => group.id), [lab.id]);
    assert.deepEqual(classGroups.groupsOfStudent(db.memory, { courseId: COURSE, name: CLASS }, ''), []);
    assert.deepEqual(classGroups.activeGroupsForClass(db.memory, { courseId: COURSE, studentClass: CLASS }).length, 2);
});

test('[UC-GRUPO-001] portal: Meus grupos com o nome dos colegas que estão na turma, sem e-mail; turma de fora 403', async () => {
    await createOk({ nome: 'Equipe 1', conjunto: 'Projeto', membros: [ANA, BIA, CAIO, SEM_EMAIL] });
    await createOk({ nome: 'Lab A', conjunto: 'Laboratório', tipo: 'subturma', membros: [ANA] });
    db.memory.students.find(item => item.email === CAIO).status = 'Evadido';
    const res = await asStudent(ANA, request(app).get(`/api/student/groups?${Q}`));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.map(group => [group.nome, group.conjunto, group.tipoTexto, group.colegas]), [
        ['Lab A', 'Laboratório', 'Subturma', []],
        ['Equipe 1', 'Projeto', 'Equipe', ['Bia', 'Hana Sem Email']],
    ]);
    const text = JSON.stringify(res.body);
    [BIA, SEM_EMAIL, 'M-b2', 'Beatriz', 'Caio'].forEach(piece => assert.equal(text.includes(piece), false, piece));
    assert.equal((await asStudent(FABIO, request(app).get(`/api/student/groups?${Q}`))).status, 403);
    assert.equal((await request(app).get(`/api/student/groups?${Q}`)).status, 400, 'sem sessão: o mesmo 400 das outras rotas do aluno sem e-mail');
});

// ---------------------------------------------------------------------------
// [UC-GRUPO-002] sorteio
// ---------------------------------------------------------------------------

test('[UC-GRUPO-002] sorteio: mesma semente, mesma proposta; tamanhos diferem no máximo em 1; confirmar cria exatamente a proposta', async () => {
    const first = await draw({ conjunto: 'Projeto', criterio: 'quantidade', valor: 2 });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.match(first.body.semente, /^[0-9a-f]{16}$/);
    assert.equal(first.body.alunos, 6, 'Ana, Bia, Caio, Duda, Edu e Hana (Gil desligado e Fábio, de outra turma, não entram)');
    const sizes = first.body.proposta.map(group => group.membros.length);
    assert.deepEqual(sizes.sort(), [3, 3]);
    assert.deepEqual(first.body.proposta.map(group => group.nome), ['Grupo 1', 'Grupo 2']);
    assert.equal(db.memory.classGroups.length, 0, 'a proposta não grava');
    const again = await draw({ conjunto: 'Projeto', criterio: 'quantidade', valor: 2, semente: first.body.semente });
    assert.deepEqual(again.body.proposta, first.body.proposta);
    assert.equal(again.body.assinatura, first.body.assinatura);
    // Outras sementes mudam a proposta em algum momento.
    const seen = new Set();
    for (let i = 0; i < 8; i++) seen.add(JSON.stringify((await draw({ conjunto: 'Projeto', criterio: 'quantidade', valor: 2 })).body.proposta));
    assert.ok(seen.size > 1, 'o sorteio não é sempre igual');

    const confirmed = await draw({ conjunto: 'Projeto', criterio: 'quantidade', valor: 2, semente: first.body.semente, assinatura: first.body.assinatura, confirmar: true });
    assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
    assert.deepEqual(confirmed.body.grupos.map(group => [group.nome, group.membros.map(member => member.email)]),
        first.body.proposta.map(group => [group.nome, group.membros.map(member => member.email)]));
    const rows = db.memory.classGroups;
    assert.equal(rows.length, 2);
    rows.forEach(row => assert.deepEqual(row.sorteio, { semente: first.body.semente, criterio: 'quantidade', valor: 2 }));
    const [entry] = audits('class_groups_drawn');
    assert.equal(entry.details.semente, first.body.semente);
    assert.equal(entry.details.grupos, 2);
    assert.equal(entry.details.alunos, 6);
    assert.deepEqual(entry.details.groupIds, rows.map(row => row.id));
});

test('[UC-GRUPO-002] sorteio por tamanho e com quem já tem grupo; confirmar com a turma mudada 409 roster_changed', async () => {
    const bySize = await draw({ conjunto: 'Lab', criterio: 'tamanho', valor: 4 });
    assert.equal(bySize.status, 200);
    assert.deepEqual(bySize.body.proposta.map(group => group.membros.length).sort(), [3, 3], '6 alunos em grupos de até 4: dois de 3');
    await createOk({ nome: 'Grupo 1', conjunto: 'Lab', membros: [ANA, BIA] });
    const rest = await draw({ conjunto: 'lab', criterio: 'quantidade', valor: 2, somenteSemGrupo: true });
    assert.equal(rest.status, 200);
    assert.equal(rest.body.conjunto, 'Lab');
    assert.equal(rest.body.alunos, 4);
    const drawn = rest.body.proposta.flatMap(group => group.membros.map(member => member.email));
    assert.equal(drawn.includes(ANA) || drawn.includes(BIA), false, 'quem já tem grupo fica de fora');
    assert.deepEqual(rest.body.proposta.map(group => group.nome), ['Grupo 2', 'Grupo 3'], 'o nome que já existe é pulado');
    const inUse = await draw({ conjunto: 'Lab', criterio: 'quantidade', valor: 2, somenteSemGrupo: false });
    assert.equal(inUse.status, 409);
    assert.equal(inUse.body.code, 'set_in_use');

    // Um aluno entra na turma entre a proposta e o confirmar.
    db.memory.students.find(item => item.email === FABIO).classes.push({ name: CLASS, courseId: COURSE });
    const stale = await draw({ conjunto: 'Lab', criterio: 'quantidade', valor: 2, semente: rest.body.semente, assinatura: rest.body.assinatura, confirmar: true });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'roster_changed');
    assert.equal(db.memory.classGroups.length, 1, 'nada criado');
    assert.equal(audits('class_groups_drawn').length, 0);
    // Confirmar sem ter sorteado: 400.
    assert.equal((await draw({ conjunto: 'Lab', criterio: 'quantidade', valor: 2, confirmar: true })).status, 400);
    // Mais grupos que alunos e valor fora da faixa: 400.
    assert.equal((await draw({ conjunto: 'Novo', criterio: 'quantidade', valor: 20 })).status, 400);
    assert.equal((await draw({ conjunto: 'Novo', criterio: 'quantidade', valor: 1 })).status, 400);
    assert.equal((await draw({ conjunto: 'Novo', criterio: 'sorte', valor: 2 })).status, 400);
    assert.equal((await draw({ conjunto: 'Novo', criterio: 'quantidade', valor: 2, semente: 'zz' })).status, 400);
});

test('[UC-GRUPO-002] distribuição equilibrada em turmas de vários tamanhos (função pura)', () => {
    const memory = { classes: [{ name: 'T', courseId: 'C' }], students: [], classGroups: [] };
    for (let n = 2; n <= 31; n++) {
        memory.students = Array.from({ length: n }, (_, index) => ({ email: `a${String(index).padStart(2, '0')}@t.local`, name: `Aluno ${index}`, status: 'Ativo', classes: [{ name: 'T', courseId: 'C' }] }));
        for (const [criterio, valor] of [['quantidade', 2], ['quantidade', 5], ['tamanho', 3], ['tamanho', 4]]) {
            const result = classGroups.drawProposal(memory, { courseId: 'C', name: 'T' }, { criterio, valor });
            if (!result.ok) {
                assert.ok(criterio === 'quantidade' && valor > n, `${n} ${criterio} ${valor}: ${result.error}`);
                continue;
            }
            const sizes = result.proposta.map(group => group.membros.length);
            assert.equal(sizes.reduce((a, b) => a + b, 0), n);
            assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `${n} ${criterio} ${valor}: ${sizes}`);
            if (criterio === 'tamanho') assert.ok(Math.max(...sizes) <= valor);
            const all = result.proposta.flatMap(group => group.membros.map(member => member.email));
            assert.equal(new Set(all).size, n, 'cada aluno uma vez');
        }
    }
});

// ---------------------------------------------------------------------------
// [UC-GRUPO-004] ciclo de vida do aluno
// ---------------------------------------------------------------------------

test('[UC-GRUPO-004] troca de e-mail renomeia o membro; Meus dados traz a seção Grupos sem os colegas', async () => {
    const group = await createOk({ nome: 'Equipe 1', conjunto: 'Projeto', membros: [ANA, BIA] });
    const res = await as('admin', request(app).post('/api/admin/student/update')).send({ originalEmail: BIA, email: 'bia.nova@grupos.local', name: 'Beatriz Lima', studentClass: CLASS, classes: [{ name: CLASS, courseId: COURSE }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(classGroups.findGroup(db.memory, group.id).membros.map(member => member.email), [ANA, 'bia.nova@grupos.local']);
    assert.equal(classGroups.findGroup(db.memory, group.id).membros[1].studentId, 'alu_00000000000000b2');

    const mine = await asStudent(ANA, request(app).get('/api/student/my-data?finalidade=baixar'));
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.deepEqual(mine.body.grupos.map(row => [row.grupo, row.conjunto, row.tipo, row.turma, row.situacao]), [['Equipe 1', 'Projeto', 'Equipe', CLASS, 'Ativo']]);
    assert.equal(typeof mine.body.grupos[0].entrouEm, 'number');
    assert.equal(mine.body.extraSections.find(item => item.key === 'grupos').label, 'Grupos de alunos');
    assert.equal(JSON.stringify(mine.body.grupos).includes('bia'), false, 'sem os colegas');
    assert.equal(JSON.stringify(mine.body.grupos).includes('prof@grupos.local'), false, 'sem quem incluiu');
    const admin = await as('admin', request(app).get(`/api/admin/lgpd/students/export?email=${encodeURIComponent(ANA)}&finalidade=baixar`));
    assert.equal(admin.status, 200);
    assert.equal(admin.body.grupos[0].incluidoPor, 'prof@grupos.local');
    assert.equal(admin.body.grupos[0].groupId, group.id);
});

test('[UC-GRUPO-004] anonimizar troca o e-mail do membro pelo pseudônimo (sem o id, como o cadastro); apagar de vez tira do grupo; Cadastros encerrados conta', async () => {
    const group = await createOk({ nome: 'Equipe 1', conjunto: 'Projeto', membros: [ANA, BIA, CAIO] });
    await update(group.id, { remover: [CAIO], atualizadoEm: group.atualizadoEm });
    db.memory.students.find(item => item.email === ANA).status = 'Transferido';
    db.memory.students.find(item => item.email === BIA).status = 'Concluído';
    const closed = await as('admin', request(app).get('/api/admin/students/closed'));
    assert.equal(closed.status, 200);
    assert.equal(closed.body.items.find(item => item.email === ANA).counts.classGroups, 1);
    assert.equal(closed.body.countLabels.classGroups, 'Grupos de alunos');

    const anonymized = await as('admin', request(app).post('/api/admin/students/anonymize')).send({ email: ANA, confirm: 'ANONIMIZAR', reason: 'Pedido da família' });
    assert.equal(anonymized.status, 200, JSON.stringify(anonymized.body));
    assert.equal(anonymized.body.kept.classGroups, 1);
    const pseudonym = db.memory.students.find(item => item.status === 'Anonimizado').email;
    assert.match(pseudonym, /@anonimizado\.invalid$/);
    const row = classGroups.findGroup(db.memory, group.id);
    assert.deepEqual(row.membros.map(member => [member.email, member.studentId]), [[pseudonym, null], [BIA, 'alu_00000000000000b2']]);
    // A auditoria do grupo (adicionados e removidos por e-mail) não guarda mais o e-mail dela.
    const trail = JSON.stringify(db.memory.auditLogs.filter(entry => String(entry.action).startsWith('class_group')));
    assert.equal(trail.includes(ANA), false);
    assert.equal(trail.includes(CAIO), true, 'o do Caio fica');

    const purged = await as('admin', request(app).post('/api/admin/students/purge')).send({ email: BIA, confirm: 'APAGAR', reason: 'Pedido da família' });
    assert.equal(purged.status, 200, JSON.stringify(purged.body));
    assert.equal(purged.body.removed.classGroups, 1);
    assert.deepEqual(classGroups.findGroup(db.memory, group.id).membros.map(member => member.email), [pseudonym], 'o grupo fica, sem a Bia');
    assert.equal(JSON.stringify(db.memory.classGroups).includes(BIA), false);
});

test('[UC-GRUPO-004] trilha do grupo: anonimizar limpa os e-mails de adicionados e removidos (função da auditoria)', () => {
    const memory = {
        students: [{ email: ANA, name: 'Ana Souza', status: 'Ativo' }],
        auditLogs: [{ id: 'a1', action: 'class_group_updated', category: 'academic', actor: 'prof@grupos.local', timestamp: Date.now(), details: { groupId: 'grp_1', adicionados: [ANA, CAIO], removidos: [ANA] } }],
    };
    const ownership = studentEmailOwnership(memory, ANA);
    anonymizeStudentAuditTrail(memory, { emails: ownership.emails, owns: ownership.owns, replacementEmail: 'anonimizado-1@anonimizado.invalid', replacementName: 'Aluno anonimizado' });
    assert.deepEqual(memory.auditLogs[0].details.adicionados, ['anonimizado-1@anonimizado.invalid', CAIO]);
    assert.deepEqual(memory.auditLogs[0].details.removidos, ['anonimizado-1@anonimizado.invalid']);
});

test('[UC-GRUPO-004] mesclar: o que fica entra no grupo do outro sem duplicar; religar o id pelo e-mail depois de restaurar', () => {
    const memory = {
        classes: [{ name: CLASS, courseId: COURSE }],
        students: [
            { id: 'alu_000000000000fica', email: ANA, name: 'Ana', status: 'Ativo', classes: [{ name: CLASS, courseId: COURSE }] },
            { id: 'alu_0000000000000sai', email: 'ana.dup@grupos.local', name: 'Ana dup', status: 'Ativo', classes: [{ name: CLASS, courseId: COURSE }] },
        ],
        classGroups: [
            { id: 'grp_a', courseId: COURSE, studentClass: CLASS, nome: 'A', conjunto: 'Projeto', membros: [{ email: 'ana.dup@grupos.local', studentId: 'alu_0000000000000sai' }] },
            { id: 'grp_b', courseId: COURSE, studentClass: CLASS, nome: 'B', conjunto: 'Lab', membros: [{ email: ANA }, { email: 'ana.dup@grupos.local' }] },
            { id: 'grp_c', courseId: COURSE, studentClass: CLASS, nome: 'C', conjunto: 'Extra', membros: [{ email: ANA }] },
            { id: 'grp_d', courseId: COURSE, studentClass: CLASS, nome: 'D', conjunto: 'Extra', membros: [{ email: 'ana.dup@grupos.local' }] },
        ],
    };
    const fica = studentData.studentDataContext(memory, ANA);
    const sai = studentData.studentDataContext(memory, 'ana.dup@grupos.local');
    studentData.mergeStudentData(memory, fica, sai);
    const members = id => classGroups.findGroup(memory, id).membros.map(member => member.email);
    assert.deepEqual(members('grp_a'), [ANA], 'entra no grupo do outro');
    assert.equal(classGroups.findGroup(memory, 'grp_a').membros[0].studentId, 'alu_000000000000fica');
    assert.deepEqual(members('grp_b'), [ANA], 'sem repetir');
    assert.deepEqual(members('grp_d'), [], 'um grupo por conjunto: o do que fica vale');
    assert.equal(classGroups.findGroup(memory, 'grp_d').mergedFrom.length, 1);

    // Religar: membro com id que não existe mais (backup antigo) ou sem id ganha o do e-mail.
    memory.classGroups[2].membros[0].studentId = 'alu_00000000000velho';
    memory.classGroups[0].membros[0].studentId = null;
    assert.equal(studentData.relinkStudentData(memory, { [ANA]: 'alu_000000000000fica' }), true);
    assert.equal(classGroups.findGroup(memory, 'grp_c').membros[0].studentId, 'alu_000000000000fica');
    assert.equal(classGroups.findGroup(memory, 'grp_a').membros[0].studentId, 'alu_000000000000fica');
    assert.equal(studentData.relinkStudentData(memory, { [ANA]: 'alu_000000000000fica' }), false, 'idempotente');
});

test('[UC-GRUPO-004] backup de antes dos grupos mantém os grupos de agora (missing keep); leitura tolerante de linha antiga', () => {
    const entry = db.COLLECTION_TABLES.find(item => item.collection === 'classGroups');
    assert.ok(entry, 'a coleção classGroups está no registro');
    assert.equal(missingCollectionOutcome(entry), 'keep');
    // Linha sem campos novos (padrões na leitura, sem reescrever).
    const memory = { classes: [{ name: CLASS, courseId: COURSE }], students: [], classGroups: [{ id: 'grp_velho', courseId: COURSE, studentClass: CLASS, membros: [{ email: 'X@Y.local' }] }] };
    const before = JSON.stringify(memory.classGroups);
    const view = classGroups.classGroupsView(memory, { courseId: COURSE, name: CLASS });
    assert.deepEqual(view.grupos.map(group => [group.nome, group.conjunto, group.tipo, group.membros[0].email]), [['Grupo sem nome', 'Grupos', 'equipe', 'x@y.local']]);
    assert.equal(JSON.stringify(memory.classGroups), before);
});
