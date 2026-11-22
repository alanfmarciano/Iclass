// Tarefas pelo painel (fase 3, C4 / P1-b; FUN-01, D11 e D13 do P1): cadastro da tarefa em
// /api/admin/assignments. Antes deste caso, GET /api/admin/assignments respondia 404 (não
// existia tarefa nenhuma: o professor não tinha como pedir um trabalho com prazo).
// Confere: criar rascunho e publicada (prazo digitado no relógio da escola e gravado em
// ms), validação com mensagem e campo em português, escopo pela turma do REGISTRO em toda
// rota, papéis (coordenação só lê; Professor auxiliar e Secretaria sem a tela), lista da
// turma no detalhe, alterar com motivo quando a tarefa tem entrega, publicar, arquivar,
// reativar, excluir só sem entrega, copiar para outra turma e a auditoria de cada uma.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-assignments-admin-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { createAdminSession } = require('../../backend/utils/authSessions.js');
const schoolTime = require('../../backend/utils/schoolTime.js');

const COURSE = 'curso-tarefas';
const OTHER_COURSE = 'curso-outro';
const SCHOOL = 'escola-tarefas';
const ACCOUNTS = {
    admin: { email: 'adm@tarefas.local', role: 'admin' },
    professor: { email: 'prof@tarefas.local', role: 'professor', assignedClasses: [{ courseId: COURSE, className: '1DES' }] },
    professor2: { email: 'prof2@tarefas.local', role: 'professor', assignedClasses: [{ courseId: COURSE, className: '1DES' }, { courseId: COURSE, className: '2DES' }] },
    monitor: { email: 'monitor@tarefas.local', role: 'monitor', assignedClasses: [{ courseId: COURSE, className: '1DES' }] },
    secretaria: { email: 'secretaria@tarefas.local', role: 'secretaria', assignedSchoolIds: [SCHOOL] },
    coordenacao: { email: 'coord@tarefas.local', role: 'coordenacao', assignedSchoolIds: [SCHOOL] },
};
const tokens = {};
let app;

const as = (name, req) => req.set('x-admin-session', tokens[name]);
const get = (name, url) => as(name, request(app).get(url));
const post = (name, url, payload = {}) => as(name, request(app).post(url)).send(payload);
const audits = action => (db.memory.auditLogs || []).filter(entry => entry.action === action);
const deadline = (date, time) => schoolTime.deadlineFromLocal(date, time, 'America/Sao_Paulo');

function seed() {
    db.memory.config = { ...(db.memory.config || {}), settings: { timezone: 'America/Sao_Paulo' } };
    db.memory.schools = [{ id: SCHOOL, name: 'Escola das Tarefas' }];
    db.memory.courses = [
        { id: COURSE, name: 'Desenvolvimento', schoolId: SCHOOL, structure: [
            { id: 'm1', name: 'Módulo 1', units: [{ id: '1', name: 'Redes', apostilaKey: 'Apostila_m1_1', avaliacaoKey: 'Avaliacao_m1_1' }] },
            { id: 'm2', name: 'Módulo 2', units: [{ id: '1', name: 'Banco de dados', apostilaKey: 'Apostila_m2_1' }] },
        ] },
        { id: OTHER_COURSE, name: 'Outro curso', schoolId: 'escola-outra', structure: [{ id: 'x1', name: 'X', units: [] }] },
    ];
    db.memory.classes = [
        { name: '1DES', courseId: COURSE, period: 'Manhã' },
        { name: '2DES', courseId: COURSE, period: 'Tarde' },
        { name: '1OUT', courseId: OTHER_COURSE, period: 'Noite' },
    ];
    db.memory.students = [
        { id: 'alu_00000000000000a1', name: 'Ana Lima', email: 'ana@tarefas.local', matricula: '2026-001', status: 'Ativo', classes: [{ name: '1DES', courseId: COURSE }] },
        { id: 'alu_00000000000000b2', name: 'Bruno Reis', nomeSocial: 'Bia Reis', email: 'bruno@tarefas.local', matricula: '2026-002', status: 'Ativo', classes: [{ name: '1DES', courseId: COURSE }] },
        { id: 'alu_00000000000000c3', name: 'Caio Dias', email: 'caio@tarefas.local', matricula: '2026-003', status: 'Inativo', classes: [{ name: '1DES', courseId: COURSE }] },
        { id: 'alu_00000000000000d4', name: 'Duda Melo', email: 'duda@tarefas.local', matricula: '2026-004', status: 'Ativo', classes: [{ name: '2DES', courseId: COURSE }] },
    ];
    db.memory.library = [
        { id: 'lib_curso', courseId: COURSE, title: 'Guia do curso', kind: 'file', filename: 'guia.pdf', url: '/uploads/guia.pdf' },
        { id: 'lib_2des', courseId: COURSE, studentClass: '2DES', title: 'Só da 2DES', kind: 'file', filename: 'so2.pdf', url: '/uploads/so2.pdf' },
        { id: 'lib_oculto', courseId: COURSE, title: 'Oculto', hidden: true, kind: 'file', filename: 'oculto.pdf', url: '/uploads/oculto.pdf' },
    ];
    db.memory.assignments = [];
    db.memory.assignmentSubmissions = [];
    db.memory.auditLogs = [];
    db.memory.sessions = {};
    db.memory.adminSessions = {};
    db.memory.admins = Object.entries(ACCOUNTS).map(([name, account]) => ({
        name: `Conta ${name}`,
        password: db.hashPassword('Senha-forte-2026'),
        assignedClasses: [],
        assignedSchoolIds: [],
        assignedCourseIds: [],
        additionalPermissions: [],
        ...account,
    }));
    Object.entries(ACCOUNTS).forEach(([name, account]) => { tokens[name] = createAdminSession(db.memory, account.email); });
}

const DRAFT = { courseId: COURSE, studentClass: '1DES', title: 'Relatório da prática de redes' };
const PUBLISHED = {
    ...DRAFT,
    instructions: 'Envie o **relatório** em PDF.\n\nCapriche no diagrama.  ',
    response: { files: true, text: true, link: false },
    files: { maxFiles: 3, maxSizeMb: 8, types: ['pdf', 'image'], extraExtensions: ['PKT', '.fzz'] },
    dueDate: '2026-12-04',
    dueTime: '23:00',
    closeDate: '2026-12-06',
    closeTime: '12:00',
    latePolicy: { mode: 'desconto', penaltyPerDayPct: 10, penaltyMaxPct: 30 },
    countsInAverage: false,
    publish: true,
};

async function create(payload = PUBLISHED, name = 'professor') {
    const res = await post(name, '/api/admin/assignments', payload);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.assignment;
}

function addSubmission(assignmentId, email, extra = {}) {
    const row = {
        id: `asub_${Date.now()}_${Math.random().toString(16).slice(2, 8).padEnd(6, '0')}`,
        schemaVersion: 1,
        assignmentId,
        courseId: COURSE,
        studentClass: '1DES',
        studentEmail: email,
        studentId: null,
        groupId: null,
        status: 'enviada',
        versions: [{ n: 1, requestAt: Date.now() - 1000, receivedAt: Date.now(), late: false, lateMs: 0, text: '', link: '', files: [{ id: 'f_0123456789abcdef', originalName: 'relatorio.pdf', storedRel: `entregas/${assignmentId}/x/f_0123456789abcdef.pdf`, size: 1234, sha256: 'a'.repeat(64), mime: 'application/pdf', ext: '.pdf', category: 'pdf' }] }],
        extension: null,
        grade: null,
        returnedAt: null,
        returnedBy: '',
        manualEntry: null,
        anonymized: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...extra,
    };
    db.memory.assignmentSubmissions.push(row);
    return row;
}

test.before(async () => { await db.init(); app = createApp(); });
test.beforeEach(() => { seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1000));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('FUN-01: a lista de tarefas existe (era 404) e começa vazia', async () => {
    const res = await get('professor', '/api/admin/assignments?courseId=curso-tarefas&studentClass=1DES');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.deepEqual(res.body.assignments, []);
    assert.equal(typeof res.body.serverNow, 'number');
    assert.equal(res.body.timezone, 'America/Sao_Paulo');
});

test('criar rascunho: só o título basta, sem prazo, com os padrões e a auditoria', async () => {
    const before = Date.now();
    const task = await create(DRAFT);
    assert.match(task.id, /^asg_\d+_[0-9a-f]{6}$/);
    assert.equal(task.status, 'rascunho');
    assert.equal(task.dueAt, null);
    assert.equal(task.publishedAt, null);
    assert.deepEqual(task.response, { files: true, text: false, link: false });
    assert.deepEqual(task.files, { maxFiles: 5, maxSizeMb: 10, types: ['pdf', 'image', 'doc'], extraExtensions: [] });
    assert.deepEqual(task.latePolicy, { mode: 'aceitar', penaltyPerDayPct: 10, penaltyMaxPct: 50 });
    assert.equal(task.countsInAverage, true);
    assert.deepEqual(task.local, { opensDate: '', opensTime: '', dueDate: '', dueTime: '', closeDate: '', closeTime: '' });
    assert.equal(task.counts.alunos, 2, 'Ana e Bia ativas na 1DES (Caio está inativo)');
    assert.equal(task.counts.naoEntregues, 2);
    const stored = db.memory.assignments[0];
    assert.equal(stored.createdBy, 'prof@tarefas.local');
    assert.ok(stored.createdAt >= before);
    assert.equal(stored.schemaVersion, 1);
    assert.equal('weight' in stored, false, 'o peso reservado saiu (K1: o peso é do plano da turma)');
    assert.equal('publish' in stored, false);
    const [entry] = audits('assignment_created');
    assert.equal(entry.category, 'assignment');
    assert.equal(entry.actor, 'prof@tarefas.local');
    assert.equal(entry.courseId, COURSE);
    assert.equal(entry.studentClass, '1DES');
    assert.equal(entry.details.id, task.id);
    assert.equal(audits('assignment_published').length, 0);
});

test('criar publicada: prazo digitado no relógio da escola vira ms; instruções sem aparar; formatos do curso normalizados', async () => {
    const task = await create();
    assert.equal(task.status, 'publicada');
    assert.equal(task.dueAt, deadline('2026-12-04', '23:00'));
    assert.equal(task.dueAt, Date.UTC(2026, 11, 5, 2, 0), '23:00 em São Paulo é 02:00 UTC do dia seguinte');
    assert.equal(task.closeAt, deadline('2026-12-06', '12:00'));
    assert.equal(task.opensAt, null);
    assert.deepEqual(task.local, { opensDate: '', opensTime: '', dueDate: '2026-12-04', dueTime: '23:00', closeDate: '2026-12-06', closeTime: '12:00' });
    assert.equal(task.instructions, PUBLISHED.instructions);
    assert.deepEqual(task.files.extraExtensions, ['.pkt', '.fzz']);
    assert.ok(task.accept.includes('.pkt') && task.accept.includes('.pdf') && task.accept.includes('.heic'));
    assert.deepEqual(task.latePolicy, { mode: 'desconto', penaltyPerDayPct: 10, penaltyMaxPct: 30 });
    assert.equal(task.countsInAverage, false);
    assert.ok(task.publishedAt > 0);
    assert.equal(typeof db.memory.assignments[0].dueAt, 'number', 'gravado em ms, nunca ISO (K21)');
    assert.equal(audits('assignment_created').length, 1);
    const [published] = audits('assignment_published');
    assert.equal(published.category, 'assignment');
    assert.equal(published.details.id, task.id);

    // Hora ausente: o prazo vale o fim do dia; abertura sem hora vale o começo do dia.
    const noTime = await create({ ...DRAFT, dueDate: '2026-12-10', opensDate: '2026-12-01' });
    assert.equal(noTime.local.dueTime, '23:59');
    assert.equal(noTime.local.opensTime, '00:00');
});

test('validação: cada recusa diz o campo e o motivo em português, e nada é gravado', async () => {
    const cases = [
        [{ ...DRAFT, title: 'ab' }, 'title', /título da tarefa precisa ter de 3 a 160/],
        [{ ...DRAFT, title: 42 }, 'title', /formato inválido/],
        [{ ...DRAFT, title: 'x'.repeat(161) }, 'title', /no máximo 160/],
        [{ ...DRAFT, response: { files: false, text: false, link: false } }, 'response', /ao menos uma forma de resposta/],
        [{ ...DRAFT, files: { types: [], extraExtensions: [] } }, 'files.types', /ao menos um tipo de arquivo/],
        [{ ...DRAFT, files: { types: ['executavel'] } }, 'files.types[0]', /valor não permitido/],
        [{ ...DRAFT, files: { extraExtensions: ['.exe'] } }, 'files.extraExtensions', /executáveis são sempre recusados/],
        [{ ...DRAFT, files: { extraExtensions: ['pk t'] } }, 'files.extraExtensions', /Formato do curso inválido/],
        [{ ...DRAFT, files: { maxSizeMb: 21 } }, 'files.maxSizeMb', /vai até 20 MB/],
        [{ ...DRAFT, files: { maxFiles: 11 } }, 'files.maxFiles', /entre 1 e 10/],
        [{ ...DRAFT, dueDate: '2026-02-30', dueTime: '10:00' }, 'dueDate', /Data do prazo inválida/],
        [{ ...DRAFT, dueDate: '2026-12-04', dueTime: '24:00' }, 'dueTime', /Hora do prazo inválida/],
        [{ ...DRAFT, dueTime: '10:00' }, 'dueDate', /Informe a data do prazo/],
        [{ ...DRAFT, dueDate: '2026-12-04', closeDate: '2026-12-03' }, 'closeDate', /encerramento precisa ser no prazo ou depois/],
        [{ ...DRAFT, dueDate: '2026-12-04', opensDate: '2026-12-05' }, 'opensDate', /abertura precisa ser antes do prazo/],
        [{ ...DRAFT, closeDate: '2026-12-03' }, 'dueDate', /Informe o prazo antes do encerramento/],
        [{ ...DRAFT, latePolicy: { mode: 'desconto', penaltyPerDayPct: 0 } }, 'latePolicy.penaltyPerDayPct', /desconto por dia/],
        [{ ...DRAFT, latePolicy: { mode: 'castigo' } }, 'latePolicy.mode', /valor não permitido/],
        [{ ...DRAFT, moduleId: 'm9' }, 'moduleId', /Módulo não encontrado/],
        [{ ...DRAFT, moduleId: 'm2', unitKey: 'Apostila_m1_1' }, 'unitKey', /Unidade não encontrada no módulo/],
        [{ ...DRAFT, libraryIds: ['lib_2des'] }, 'libraryIds[0]', /Material de apoio não encontrado/],
        [{ ...DRAFT, libraryIds: ['lib_oculto'] }, 'libraryIds[0]', /Material de apoio não encontrado/],
        [{ ...DRAFT, countsInAverage: 'sim' }, 'countsInAverage', /formato inválido/],
        [{ ...DRAFT, publish: true }, 'dueDate', /Informe o prazo da tarefa/],
        [{ ...DRAFT, courseId: undefined }, 'courseId', /obrigatório/],
    ];
    for (const [payload, field, message] of cases) {
        const res = await post('professor', '/api/admin/assignments', payload);
        assert.equal(res.status, 400, `${JSON.stringify(payload)}: ${res.status} ${JSON.stringify(res.body)}`);
        assert.equal(res.body.success, false);
        assert.equal(res.body.field, field, JSON.stringify(payload));
        assert.match(res.body.error, message, JSON.stringify(payload));
    }
    const missing = await post('professor', '/api/admin/assignments', { ...DRAFT, studentClass: '9ZZ' });
    // A turma que não existe nem é do professor: o guarda recusa pelo escopo antes.
    assert.equal(missing.status, 403);
    const adminMissing = await post('admin', '/api/admin/assignments', { ...DRAFT, studentClass: '9ZZ' });
    assert.equal(adminMissing.status, 404);
    assert.equal(adminMissing.body.field, 'studentClass');
    assert.deepEqual(db.memory.assignments, []);
    assert.equal(audits('assignment_created').length, 0);
});

test('módulo, unidade e materiais: unidade sem módulo leva o módulo dela; material da turma vale só para ela', async () => {
    const byUnit = await create({ ...DRAFT, unitKey: 'Apostila_m2_1', libraryIds: ['lib_curso', 'lib_curso'] });
    assert.equal(byUnit.moduleId, 'm2');
    assert.equal(byUnit.unitKey, 'Apostila_m2_1');
    assert.deepEqual(byUnit.libraryIds, ['lib_curso']);
    const byEvaluation = await create({ ...DRAFT, moduleId: 'm1', unitKey: 'Avaliacao_m1_1' });
    assert.equal(byEvaluation.moduleId, 'm1');
    const in2 = await create({ ...DRAFT, studentClass: '2DES', libraryIds: ['lib_2des', 'lib_curso'] }, 'professor2');
    assert.deepEqual(in2.libraryIds, ['lib_2des', 'lib_curso']);
    // Trocar só o módulo na alteração: a unidade do módulo antigo sai.
    const moved = await post('professor', `/api/admin/assignments/${byUnit.id}/update`, { moduleId: 'm1' });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.assignment.moduleId, 'm1');
    assert.equal(moved.body.assignment.unitKey, '');
});

test('papéis: Professor auxiliar e Secretaria sem a tela; coordenação lê e não grava; professor só na turma dele', async () => {
    const task = await create();
    const other = await create({ ...DRAFT, studentClass: '2DES' }, 'professor2');

    for (const name of ['monitor', 'secretaria']) {
        assert.equal((await get(name, '/api/admin/assignments')).status, 403, name);
        assert.equal((await get(name, `/api/admin/assignments/${task.id}`)).status, 403, name);
        assert.equal((await post(name, '/api/admin/assignments', PUBLISHED)).status, 403, name);
    }
    const coordList = await get('coordenacao', '/api/admin/assignments');
    assert.equal(coordList.status, 200);
    assert.deepEqual(coordList.body.assignments.map(item => item.id).sort(), [task.id, other.id].sort());
    assert.equal((await get('coordenacao', `/api/admin/assignments/${task.id}`)).status, 200);
    const coordWrite = await post('coordenacao', `/api/admin/assignments/${task.id}/archive`);
    assert.equal(coordWrite.status, 403);
    assert.equal(coordWrite.body.code, 'read_only_account');

    // O professor da 1DES não vê nem mexe na tarefa da 2DES, em nenhuma rota.
    const list = await get('professor', '/api/admin/assignments');
    assert.deepEqual(list.body.assignments.map(item => item.id), [task.id]);
    assert.equal((await get('professor', '/api/admin/assignments?studentClass=2DES&courseId=curso-tarefas')).status, 403);
    const routes = [
        ['GET', ''], ['POST', '/update', { title: 'Tomada' }], ['POST', '/publish'], ['POST', '/archive'], ['POST', '/unarchive'],
        ['POST', '/delete', { confirm: 'EXCLUIR' }], ['POST', '/copy', { courseId: COURSE, studentClass: '1DES' }],
    ];
    for (const [method, suffix, payload] of routes) {
        const url = `/api/admin/assignments/${other.id}${suffix}`;
        const res = method === 'GET' ? await get('professor', url) : await post('professor', url, payload || {});
        assert.equal(res.status, 403, `${method} ${suffix}: ${res.status}`);
        assert.match(res.body.error, /não pertence/);
    }
    // O corpo com a turma do professor não engana o escopo: vale a turma do registro.
    const disguised = await post('professor', `/api/admin/assignments/${other.id}/update`, { courseId: COURSE, studentClass: '1DES', title: 'Tomada' });
    assert.equal(disguised.status, 403);
    assert.equal(db.memory.assignments.find(item => item.id === other.id).title, DRAFT.title);
    // Criar ou copiar para turma fora do escopo: recusado.
    assert.equal((await post('professor', '/api/admin/assignments', { ...DRAFT, studentClass: '2DES' })).status, 403);
    assert.equal((await post('professor', `/api/admin/assignments/${task.id}/copy`, { courseId: COURSE, studentClass: '2DES' })).status, 403);
    assert.equal(db.memory.assignments.length, 2);
});

test('detalhe: tarefa completa e a lista da turma (ativos e quem já entregou), sem caminho de arquivo', async () => {
    const task = await create();
    addSubmission(task.id, 'ana@tarefas.local', { status: 'devolvida', grade: { score: 80, penaltyPct: 0, finalScore: 80, comment: 'Bom', versionGraded: 1, gradedBy: 'prof@tarefas.local', gradedAt: Date.now() }, returnedAt: Date.now() });
    addSubmission(task.id, 'caio@tarefas.local', { versions: [{ n: 1, requestAt: Date.now(), late: true, lateMs: 3600000, files: [], text: 'feito', link: '' }] });
    const res = await get('professor', `/api/admin/assignments/${task.id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.assignment.instructions, PUBLISHED.instructions);
    assert.equal(typeof res.body.serverNow, 'number');
    const rows = Object.fromEntries(res.body.roster.map(row => [row.studentEmail, row]));
    assert.deepEqual(res.body.roster.map(row => row.name), ['Ana Lima', 'Bia Reis', 'Caio Dias'], 'ordem alfabética do nome (social)');
    assert.equal(rows['ana@tarefas.local'].status, 'devolvida');
    assert.equal(rows['ana@tarefas.local'].grade.finalScore, 80);
    assert.equal(rows['ana@tarefas.local'].lastVersion.filesCount, 1);
    assert.equal(rows['ana@tarefas.local'].lastVersion.bytes, 1234);
    assert.equal(rows['ana@tarefas.local'].matricula, '2026-001');
    assert.equal(rows['ana@tarefas.local'].studentId, 'alu_00000000000000a1');
    assert.equal(rows['bruno@tarefas.local'].status, 'nao_entregue');
    assert.equal(rows['bruno@tarefas.local'].lastVersion, null);
    assert.equal(rows['caio@tarefas.local'].enrolled, false, 'inativo continua na lista porque entregou');
    assert.equal(rows['caio@tarefas.local'].status, 'para_corrigir');
    assert.equal(rows['caio@tarefas.local'].lastVersion.late, true);
    assert.equal(rows['caio@tarefas.local'].lastVersion.hasText, true);
    assert.equal(res.body.assignment.counts.alunos, 3);
    assert.equal(res.body.assignment.counts.paraCorrigir, 1);
    assert.equal(res.body.assignment.counts.devolvidas, 1);
    assert.equal(res.body.assignment.counts.atrasadas, 1);
    assert.doesNotMatch(JSON.stringify(res.body), /storedRel|entregas\//, 'nenhum caminho de arquivo sai');

    assert.equal((await get('professor', '/api/admin/assignments/asg_1_abcdef')).status, 404);
    assert.equal((await get('professor', `/api/admin/assignments/${'a'.repeat(200)}`)).status, 404);
});

test('lista: filtro por situação (padrão sem as arquivadas), contagens e ordem pelo prazo', async () => {
    const late = await create({ ...PUBLISHED, title: 'Segunda entrega', dueDate: '2026-12-20', closeDate: null, closeTime: null });
    const early = await create({ ...PUBLISHED, title: 'Primeira entrega', dueDate: '2026-12-01', closeDate: null, closeTime: null });
    const draft = await create(DRAFT);
    const archived = await create({ ...DRAFT, title: 'Arquivada' });
    assert.equal((await post('professor', `/api/admin/assignments/${archived.id}/archive`)).status, 200);
    addSubmission(early.id, 'ana@tarefas.local');

    const ids = async query => (await get('professor', `/api/admin/assignments${query}`)).body.assignments.map(item => item.id);
    assert.deepEqual(await ids('?courseId=curso-tarefas&studentClass=1DES'), [early.id, late.id, draft.id]);
    assert.deepEqual(await ids('?status=arquivada'), [archived.id]);
    assert.deepEqual(await ids('?status=rascunho'), [draft.id]);
    assert.equal((await ids('?status=todas')).length, 4);
    const first = (await get('professor', '/api/admin/assignments')).body.assignments[0];
    assert.equal(first.counts.enviadas, 1);
    assert.equal(first.counts.paraCorrigir, 1);
    assert.equal('instructions' in first, false, 'a lista não leva as instruções');
    const bad = await get('professor', '/api/admin/assignments?status=perdida');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.field, 'status');
    // Parâmetro repetido vale o último (parseQueryLastValue do server.js), nunca 500.
    assert.deepEqual(await ids('?status=publicada&status=rascunho'), [draft.id]);
});

test('alterar: só o que mudou vai para a auditoria; nada mudou não grava; prazo de tarefa com entrega pede motivo', async () => {
    const task = await create();
    const same = await post('professor', `/api/admin/assignments/${task.id}/update`, { title: PUBLISHED.title, dueDate: '2026-12-04', dueTime: '23:00' });
    assert.equal(same.status, 200);
    assert.equal(same.body.changed, false);
    assert.equal(audits('assignment_updated').length, 0);

    const renamed = await post('professor', `/api/admin/assignments/${task.id}/update`, { title: 'Relatório final de redes', files: { maxFiles: 4 } });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.changed, true);
    assert.equal(renamed.body.assignment.files.maxFiles, 4);
    assert.deepEqual(renamed.body.assignment.files.types, ['pdf', 'image'], 'os outros campos do bloco ficam');
    const [entry] = audits('assignment_updated');
    assert.deepEqual(Object.keys(entry.before).sort(), ['files', 'title']);
    assert.equal(entry.before.title, PUBLISHED.title);
    assert.equal(entry.after.title, 'Relatório final de redes');
    assert.equal(db.memory.assignments[0].updatedBy, 'prof@tarefas.local');

    // Publicada não fica sem prazo.
    const cleared = await post('professor', `/api/admin/assignments/${task.id}/update`, { dueDate: null, dueTime: null, closeDate: null, closeTime: null });
    assert.equal(cleared.status, 400);
    assert.equal(cleared.body.field, 'dueDate');
    // A turma não muda pela alteração.
    const moved = await post('professor2', `/api/admin/assignments/${task.id}/update`, { studentClass: '2DES', title: 'Outra' });
    assert.equal(moved.status, 400);
    assert.equal(moved.body.field, 'studentClass');

    addSubmission(task.id, 'ana@tarefas.local');
    const noReason = await post('professor', `/api/admin/assignments/${task.id}/update`, { dueDate: '2026-12-05', dueTime: '23:00' });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.code, 'reason_required');
    assert.equal(noReason.body.field, 'reason');
    assert.equal(db.memory.assignments[0].dueAt, deadline('2026-12-04', '23:00'));
    // Mudar o que não é prazo continua sem motivo.
    assert.equal((await post('professor', `/api/admin/assignments/${task.id}/update`, { countsInAverage: true })).status, 200);
    const withReason = await post('professor', `/api/admin/assignments/${task.id}/update`, { dueDate: '2026-12-05', dueTime: '23:00', reason: 'Laboratório fechado na quinta' });
    assert.equal(withReason.status, 200, JSON.stringify(withReason.body));
    assert.equal(withReason.body.assignment.dueAt, deadline('2026-12-05', '23:00'));
    const last = audits('assignment_updated').pop();
    assert.equal(last.reason, 'Laboratório fechado na quinta');
    assert.deepEqual(last.before, { dueAt: deadline('2026-12-04', '23:00') });
    assert.deepEqual(last.after, { dueAt: deadline('2026-12-05', '23:00') });
});

test('publicar, arquivar e reativar: idempotentes, com a auditoria e a situação de antes ao reativar', async () => {
    const draft = await create(DRAFT);
    const noDue = await post('professor', `/api/admin/assignments/${draft.id}/publish`);
    assert.equal(noDue.status, 400);
    assert.equal(noDue.body.field, 'dueDate');
    assert.equal((await post('professor', `/api/admin/assignments/${draft.id}/update`, { dueDate: '2026-12-10', dueTime: '18:00' })).status, 200);
    // Só a data nova: a hora gravada fica (não vira o padrão 23:59); só a hora: a data fica.
    const onlyDate = await post('professor', `/api/admin/assignments/${draft.id}/update`, { dueDate: '2026-12-11' });
    assert.deepEqual([onlyDate.body.assignment.local.dueDate, onlyDate.body.assignment.local.dueTime], ['2026-12-11', '18:00']);
    const onlyTime = await post('professor', `/api/admin/assignments/${draft.id}/update`, { dueTime: '07:30' });
    assert.deepEqual([onlyTime.body.assignment.local.dueDate, onlyTime.body.assignment.local.dueTime], ['2026-12-11', '07:30']);
    assert.equal(onlyTime.body.assignment.dueAt, deadline('2026-12-11', '07:30'));
    const published = await post('professor', `/api/admin/assignments/${draft.id}/publish`);
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.equal(published.body.assignment.status, 'publicada');
    assert.ok(published.body.assignment.publishedAt > 0);
    const again = await post('professor', `/api/admin/assignments/${draft.id}/publish`);
    assert.equal(again.body.changed, false);
    assert.equal(audits('assignment_published').length, 1);

    addSubmission(draft.id, 'ana@tarefas.local');
    const archived = await post('professor', `/api/admin/assignments/${draft.id}/archive`);
    assert.equal(archived.body.assignment.status, 'arquivada');
    assert.equal(archived.body.assignment.archivedBy, 'prof@tarefas.local');
    assert.equal(audits('assignment_archived')[0].details.entregas, 1);
    assert.equal((await post('professor', `/api/admin/assignments/${draft.id}/archive`)).body.changed, false);
    const blocked = await post('professor', `/api/admin/assignments/${draft.id}/update`, { title: 'Mudou' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'assignment_archived');
    assert.equal((await post('professor', `/api/admin/assignments/${draft.id}/publish`)).status, 409);

    const back = await post('professor', `/api/admin/assignments/${draft.id}/unarchive`);
    assert.equal(back.body.assignment.status, 'publicada', 'já tinha sido publicada');
    assert.equal(back.body.assignment.archivedAt, null);
    assert.equal(audits('assignment_unarchived')[0].details.status, 'publicada');
    assert.equal((await post('professor', `/api/admin/assignments/${draft.id}/unarchive`)).body.changed, false);

    const neverPublished = await create({ ...DRAFT, title: 'Nunca publicada' });
    await post('professor', `/api/admin/assignments/${neverPublished.id}/archive`);
    const backDraft = await post('professor', `/api/admin/assignments/${neverPublished.id}/unarchive`);
    assert.equal(backDraft.body.assignment.status, 'rascunho');
});

test('excluir: pede EXCLUIR, recusa com qualquer registro de aluno e guarda a cópia na auditoria', async () => {
    const task = await create();
    const noConfirm = await post('professor', `/api/admin/assignments/${task.id}/delete`, {});
    assert.equal(noConfirm.status, 400);
    assert.equal(noConfirm.body.code, 'confirm_required');
    addSubmission(task.id, 'bruno@tarefas.local', { versions: [], status: 'pendente', extension: { dueAt: Date.now(), by: 'prof@tarefas.local', at: Date.now(), reason: 'Atestado' } });
    const withRows = await post('professor', `/api/admin/assignments/${task.id}/delete`, { confirm: 'EXCLUIR' });
    assert.equal(withRows.status, 409);
    assert.equal(withRows.body.code, 'assignment_has_submissions');
    assert.equal(db.memory.assignments.length, 1);
    assert.equal(db.memory.assignmentSubmissions.length, 1, 'nada do aluno sai');

    db.memory.assignmentSubmissions = [];
    const removed = await post('professor', `/api/admin/assignments/${task.id}/delete`, { confirm: 'EXCLUIR' });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(db.memory.assignments, []);
    const [entry] = audits('assignment_deleted');
    assert.equal(entry.category, 'assignment');
    assert.equal(entry.details.deleted.title, PUBLISHED.title);
    assert.equal(entry.details.deleted.dueAt, deadline('2026-12-04', '23:00'));
    assert.equal((await get('professor', `/api/admin/assignments/${task.id}`)).status, 404);
});

test('copiar para outra turma: rascunho novo com o prazo pedido; o que não existe no destino fica de fora com aviso', async () => {
    const task = await create({ ...PUBLISHED, moduleId: 'm1', unitKey: 'Apostila_m1_1', libraryIds: ['lib_curso'] });
    addSubmission(task.id, 'ana@tarefas.local');
    const copied = await post('professor2', `/api/admin/assignments/${task.id}/copy`, { courseId: COURSE, studentClass: '2DES', dueDate: '2026-12-11', dueTime: '22:00' });
    assert.equal(copied.status, 201, JSON.stringify(copied.body));
    const copy = copied.body.assignment;
    assert.notEqual(copy.id, task.id);
    assert.equal(copy.studentClass, '2DES');
    assert.equal(copy.status, 'rascunho');
    assert.equal(copy.dueAt, deadline('2026-12-11', '22:00'));
    assert.equal(copy.closeAt, null, 'o encerramento não vem junto (prazo novo)');
    assert.equal(copy.title, task.title);
    assert.equal(copy.instructions, task.instructions);
    assert.deepEqual(copy.files, task.files);
    assert.deepEqual(copy.latePolicy, task.latePolicy);
    assert.equal(copy.moduleId, 'm1');
    assert.deepEqual(copy.libraryIds, ['lib_curso']);
    assert.equal(copy.counts.alunos, 1, 'só a Duda na 2DES; entrega da 1DES não vem');
    assert.deepEqual(copied.body.avisos, []);
    const [entry] = audits('assignment_copied');
    assert.equal(entry.studentClass, '2DES');
    assert.deepEqual([entry.details.fromId, entry.details.toId, entry.details.toClass], [task.id, copy.id, '2DES']);
    assert.equal(db.memory.assignments.find(item => item.id === task.id).status, 'publicada', 'a original fica como estava');

    // Para outro curso (administrador): módulo e material que não existem lá ficam de fora.
    const other = await post('admin', `/api/admin/assignments/${task.id}/copy`, { courseId: OTHER_COURSE, studentClass: '1OUT' });
    assert.equal(other.status, 201, JSON.stringify(other.body));
    assert.equal(other.body.assignment.moduleId, '');
    assert.equal(other.body.assignment.unitKey, '');
    assert.deepEqual(other.body.assignment.libraryIds, []);
    assert.equal(other.body.assignment.dueAt, null);
    assert.equal(other.body.avisos.length, 2);
    const wrongDate = await post('admin', `/api/admin/assignments/${task.id}/copy`, { courseId: COURSE, studentClass: '2DES', dueDate: '04/12/2026' });
    assert.equal(wrongDate.status, 400);
    assert.equal(wrongDate.body.field, 'dueDate');
    assert.equal((await post('admin', `/api/admin/assignments/${task.id}/copy`, { courseId: COURSE, studentClass: '9ZZ' })).status, 404);
});

test('limite por arquivo segue o teto de Sistema (settings.entregas) e o padrão nunca passa dele', async () => {
    db.memory.config.settings = { timezone: 'America/Sao_Paulo', entregas: { maxMbPorArquivo: 6 } };
    const task = await create(DRAFT);
    assert.equal(task.files.maxSizeMb, 6, 'o padrão de 10 MB fica no teto de 6 MB');
    const over = await post('professor', '/api/admin/assignments', { ...DRAFT, files: { maxSizeMb: 7 } });
    assert.equal(over.status, 400);
    assert.match(over.body.error, /vai até 6 MB/);
});

// Formulário da tarefa na tela (C7 / P1-e): as opções vêm do servidor, com os mesmos
// tipos, limites e padrões que a gravação usa, e só o que a gravação aceita da turma.
test('opções do formulário: catálogo em português, limites com o teto de Sistema, módulos, unidades e materiais da turma', async () => {
    db.memory.config.settings = { timezone: 'America/Sao_Paulo', entregas: { maxMbPorArquivo: 6, maxMbPorEnvio: 30 } };
    // Antes do C7 esta rota caía no GET /:id e respondia 404 "Tarefa não encontrada.".
    const res = await get('professor', '/api/admin/assignments/form-options?courseId=curso-tarefas&studentClass=1DES');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.deepEqual(res.body.fileTypes.map(item => item.key), ['pdf', 'image', 'doc', 'sheet', 'slides', 'archive', 'code']);
    assert.equal(res.body.fileTypes.find(item => item.key === 'code').label, 'Código e texto');
    assert.ok(res.body.fileTypes.find(item => item.key === 'code').extensions.includes('.py'));
    assert.deepEqual(res.body.lateModes, ['aceitar', 'desconto', 'bloquear']);
    assert.ok(res.body.blockedExtensions.includes('.exe') && res.body.blockedExtensions.includes('.bat'));
    assert.equal(res.body.limits.maxSizeMbMax, 6);
    assert.equal(res.body.limits.maxMbPorEnvio, 30);
    assert.equal(res.body.limits.titleMax, 160);
    assert.equal(res.body.defaults.files.maxSizeMb, 6, 'o padrão de 10 MB fica no teto');
    assert.deepEqual(res.body.defaults.response, { files: true, text: false, link: false });
    assert.equal(res.body.timezone, 'America/Sao_Paulo');
    assert.deepEqual(res.body.modules.map(module => module.id), ['m1', 'm2']);
    assert.deepEqual(res.body.modules[0].units, [{ key: 'Apostila_m1_1', keys: ['Apostila_m1_1', 'Avaliacao_m1_1'], name: 'Redes' }]);
    // Material só da 2DES e o oculto não aparecem para a 1DES (a gravação recusaria).
    assert.deepEqual(res.body.library.map(entry => entry.id), ['lib_curso']);
    assert.equal(res.body.library[0].name, 'Guia do curso');
    // A unidade escolhida pela chave principal grava como a tela mandou.
    const created = await post('professor', '/api/admin/assignments', { ...DRAFT, moduleId: 'm1', unitKey: res.body.modules[0].units[0].key, libraryIds: ['lib_curso'] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.assignment.unitKey, 'Apostila_m1_1');

    // Escopo e papéis: turma de fora, turma que não existe, pedido sem turma e sem a tela.
    const other = await get('professor', '/api/admin/assignments/form-options?courseId=curso-tarefas&studentClass=2DES');
    assert.equal(other.status, 403);
    assert.equal((await get('admin', '/api/admin/assignments/form-options?courseId=curso-tarefas&studentClass=9ZZ')).status, 404);
    const missing = await get('professor', '/api/admin/assignments/form-options?courseId=curso-tarefas');
    assert.equal(missing.status, 400);
    assert.equal(missing.body.field, 'studentClass');
    assert.equal((await get('monitor', '/api/admin/assignments/form-options?courseId=curso-tarefas&studentClass=1DES')).status, 403);
    assert.equal((await get('secretaria', '/api/admin/assignments/form-options?courseId=curso-tarefas&studentClass=1DES')).status, 403);
    assert.equal((await get('coordenacao', '/api/admin/assignments/form-options?courseId=curso-tarefas&studentClass=1DES')).status, 200);
});

// "Validação na tela e no servidor com as mesmas mensagens" (telas do P1, C7): para cada
// recusa, o formulário da tela (web/src/features/admin/tarefas/assignmentForm.js) e o
// servidor, com o corpo que a tela monta, dizem a mesma frase no mesmo campo. Se uma
// mensagem do servidor mudar, este caso falha até a tela acompanhar.
test('a tela e o servidor recusam com a mesma mensagem no mesmo campo', async () => {
    const { pathToFileURL } = require('node:url');
    const web = await import(pathToFileURL(path.join(__dirname, '..', '..', 'web', 'src', 'features', 'admin', 'tarefas', 'assignmentForm.js')).href);
    db.memory.config.settings = { timezone: 'America/Sao_Paulo', entregas: { maxMbPorArquivo: 6 } };
    const options = (await get('professor', '/api/admin/assignments/form-options?courseId=curso-tarefas&studentClass=1DES')).body;
    const base = { ...web.emptyForm(options), title: 'Relatório de redes', dueDate: '2026-12-04', dueTime: '23:00' };
    const cases = [
        ['título curto', { title: 'ab' }],
        ['sem forma de resposta', { response: { files: false, text: false, link: false } }],
        ['arquivo sem tipo', { types: [], extraExtensions: '' }],
        ['publicar sem prazo', { dueDate: '' }, true],
        ['desconto sem o valor por dia', { lateMode: 'desconto', penaltyPerDayPct: '0' }],
        ['desconto sem o máximo', { lateMode: 'desconto', penaltyPerDayPct: '10', penaltyMaxPct: '0' }],
        ['tamanho acima do teto de Sistema', { maxSizeMb: '7' }],
        ['arquivos demais por envio', { maxFiles: '11' }],
        ['data inválida', { dueDate: '2026-02-30' }],
        ['hora inválida', { dueTime: '24:00' }],
        ['hora da abertura sem a data', { opensTime: '08:00' }],
        ['abertura depois do prazo', { opensDate: '2026-12-05', opensTime: '08:00' }],
        ['encerramento antes do prazo', { closeDate: '2026-12-03', closeTime: '10:00' }],
        ['encerramento sem prazo', { dueDate: '', closeDate: '2026-12-03', closeTime: '10:00' }],
        ['formato do curso inválido', { extraExtensions: '.pkt, abc!' }],
        ['executável como formato do curso', { extraExtensions: 'bat' }],
    ];
    for (const [label, change, publish = false] of cases) {
        const form = { ...base, ...change };
        const screen = web.validateForm(form, options, { publish });
        assert.ok(screen, `${label}: a tela deixou passar`);
        const res = await post('professor', '/api/admin/assignments', web.createBody(form, options, { courseId: COURSE, studentClass: '1DES', publish }));
        assert.equal(res.status, 400, `${label}: ${res.status} ${JSON.stringify(res.body)}`);
        assert.equal(screen.error, res.body.error, `${label}: mensagens diferentes`);
        assert.equal(screen.field, web.formFieldOf(res.body.field), `${label}: campos diferentes`);
    }
    assert.equal(db.memory.assignments.length, 0, 'nada recusado foi gravado');

    // O formulário válido passa nos dois, como rascunho e publicada.
    assert.equal(web.validateForm(base, options, { publish: true }), null);
    const created = await post('professor', '/api/admin/assignments', web.createBody(base, options, { courseId: COURSE, studentClass: '1DES', publish: true }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.assignment.dueAt, deadline('2026-12-04', '23:00'));

    // Mudar o prazo de tarefa com entrega pede o motivo, com a mesma frase.
    addSubmission(created.body.assignment.id, 'ana@tarefas.local');
    const initial = web.formFromAssignment(created.body.assignment, options);
    const moved = { ...initial, dueDate: '2026-12-08' };
    assert.equal(web.deadlineChanged(initial, moved), true);
    const screen = web.validateForm(moved, options, { publish: true, needsReason: true });
    const res = await post('professor', `/api/admin/assignments/${created.body.assignment.id}/update`, web.updateBody(initial, moved, options));
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'reason_required');
    assert.deepEqual([screen.error, screen.field], [res.body.error, web.formFieldOf(res.body.field)]);
    const withReason = await post('professor', `/api/admin/assignments/${created.body.assignment.id}/update`, web.updateBody(initial, { ...moved, reason: 'Laboratório fechado na sexta' }, options, { withReason: true }));
    assert.equal(withReason.status, 200, JSON.stringify(withReason.body));
    assert.deepEqual(withReason.body.assignment.local.dueDate, '2026-12-08');
});
