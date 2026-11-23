// Período letivo, etapas datadas e carga horária no servidor (fase 3, B5 / P2-S7; FUN-05 e
// FUN-15): o cadastro dos períodos (academicTerms) com etapas em sequência, dentro do
// período e sem se cruzar; a turma ligada ao período em class/create e class/update; a
// disciplina com carga horária, professor e módulos (o pedido de antes não apaga nada);
// a clonagem do curso; o boletim com as aulas previstas. Cada teste falha no código de
// antes (não havia rota de período, a turma ignorava periodoLetivoId e a disciplina
// perdia todo campo além de id, nome e cor).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-academic-terms-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

// Módulos antes do servidor (o uncaughtException do server.js engoliria a falha deles).
const calendar = require('../../backend/utils/academicCalendar.js');
const attendanceUtil = require('../../backend/utils/attendance.js');
const { structureModuleIds } = require('../../backend/utils/gradebook.js');
const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');

// ---------------------------------------------------------------- unidade

const TERM = { nome: '2027 · 1º semestre', inicio: '2027-02-01', fim: '2027-07-09' };
const FOUR_STAGES = [
    { ordem: 1, nome: '1º bimestre', inicio: '2027-02-01', fim: '2027-03-19' },
    { ordem: 2, nome: '2º bimestre', inicio: '2027-03-22', fim: '2027-04-30' },
    { ordem: 3, nome: '3º bimestre', inicio: '2027-05-03', fim: '2027-06-04' },
    { ordem: 4, nome: '4º bimestre', inicio: '2027-06-07', fim: '2027-07-09' },
];

test('[UC-CURSO-002] readTermInput: quatro etapas valem; fim antes do início, mais de 400 dias, etapa fora, cruzada ou com buraco na ordem são recusados', () => {
    const okInput = calendar.readTermInput({ ...TERM, etapas: FOUR_STAGES });
    assert.equal(okInput.error, undefined, okInput.error);
    assert.equal(okInput.term.etapas.length, 4);
    assert.deepEqual(okInput.term.etapas.map(stage => stage.ordem), [1, 2, 3, 4]);
    // Etapa sem ordem e sem nome: a posição e "Nª etapa".
    const noOrder = calendar.readTermInput({ ...TERM, etapas: [{ inicio: '2027-02-01', fim: '2027-04-30' }, { inicio: '2027-05-03', fim: '2027-07-09' }] });
    assert.deepEqual(noOrder.term.etapas.map(stage => [stage.ordem, stage.nome]), [[1, '1ª etapa'], [2, '2ª etapa']]);
    // Sem etapas: o período vale assim mesmo.
    assert.deepEqual(calendar.readTermInput(TERM).term.etapas, []);

    const fails = (input, field) => {
        const parsed = calendar.readTermInput(input);
        assert.ok(parsed.error, `devia recusar ${JSON.stringify(input)}`);
        assert.equal(parsed.field, field, parsed.error);
        assert.match(parsed.error, /[a-zà-ú]/i);
        return parsed;
    };
    fails({ ...TERM, nome: '  ' }, 'nome');
    fails({ ...TERM, fim: '2027-01-31' }, 'fim');
    fails({ ...TERM, fim: TERM.inicio }, 'fim');
    fails({ ...TERM, inicio: '2027-02-30' }, 'inicio');
    fails({ ...TERM, fim: '2028-03-10' }, 'fim');
    fails({ ...TERM, etapas: [{ ...FOUR_STAGES[0], fim: '2027-01-15', inicio: '2027-01-10' }] }, 'etapas[0].inicio');
    fails({ ...TERM, etapas: [{ ...FOUR_STAGES[0], fim: '2027-07-20' }] }, 'etapas[0].inicio');
    fails({ ...TERM, etapas: [FOUR_STAGES[0], { ...FOUR_STAGES[1], inicio: '2027-03-10' }] }, 'etapas[1].inicio');
    fails({ ...TERM, etapas: [FOUR_STAGES[0], { ...FOUR_STAGES[2] }] }, 'etapas[1].ordem');
    fails({ ...TERM, etapas: [FOUR_STAGES[0], { ...FOUR_STAGES[1], ordem: 1 }] }, 'etapas[1].ordem');
    fails({ ...TERM, etapas: [{ ...FOUR_STAGES[0], fim: '2027-01-31' }] }, 'etapas[0].fim');
    fails({ ...TERM, etapas: [{ ...FOUR_STAGES[0], ordem: 7 }] }, 'etapas[0].ordem');
    fails({ ...TERM, etapas: Array.from({ length: 7 }, (_, index) => ({ ordem: index + 1, inicio: '2027-02-01', fim: '2027-02-01' })) }, 'etapas');

    // No update, o campo que não veio fica como estava.
    const kept = calendar.readTermInput({ nome: 'Novo nome' }, { ...TERM, etapas: FOUR_STAGES });
    assert.equal(kept.term.inicio, TERM.inicio);
    assert.equal(kept.term.etapas.length, 4);
    assert.deepEqual(calendar.readTermInput({ etapas: [] }, { ...TERM, etapas: FOUR_STAGES }).term.etapas, [], 'lista vazia tira as etapas');
});

test('[UC-CURSO-002] normalizeTerm e termStageForDate: leitura tolerante e a etapa de cada data', () => {
    const term = calendar.normalizeTerm({ id: 'per_1', ...TERM, etapas: [...FOUR_STAGES, { ordem: 9, inicio: 'x' }], situacao: 'qualquer' });
    assert.equal(term.situacao, 'aberto');
    assert.equal(term.etapas.length, 4, 'a etapa quebrada fica de fora');
    assert.equal(term.schoolId, null);
    assert.equal(calendar.normalizeTerm({ id: 'per_2', nome: 'Sem datas' }), null);
    assert.equal(calendar.normalizeTerm({ ...TERM }), null, 'sem id não vale');
    assert.equal(calendar.termStageForDate(term, '2027-03-22').ordem, 2);
    assert.equal(calendar.termStageForDate(term, '2027-03-20'), null, 'fim de semana entre etapas');
    assert.equal(calendar.termStageForDate(term, '2027-07-09').ordem, 4);
    assert.equal(calendar.termStageForDate({ id: 'per_1', ...TERM, etapas: FOUR_STAGES }, '2027-05-10').nome, '3º bimestre', 'o registro gravado também serve');
});

test('[UC-CURSO-002] sanitizeDisciplinas: carga horária, professor e módulos vão e voltam; o campo ausente fica como estava e null apaga', () => {
    const previous = [{ id: 'REDES', nome: 'Redes', cor: '#112233', cargaHoraria: 80, professor: 'Prof. Carlos', modulos: ['M1', 'M2'] }];
    // Pedido de antes (só id, nome e cor): nada some.
    assert.deepEqual(attendanceUtil.sanitizeDisciplinas([{ id: 'redes', nome: 'Redes de Computadores', cor: '#112233' }], previous),
        [{ id: 'REDES', nome: 'Redes de Computadores', cor: '#112233', cargaHoraria: 80, professor: 'Prof. Carlos', modulos: ['M1', 'M2'] }]);
    // null, texto vazio e lista vazia apagam.
    assert.deepEqual(attendanceUtil.sanitizeDisciplinas([{ id: 'REDES', nome: 'Redes', cor: '', cargaHoraria: null, professor: '', modulos: [] }], previous),
        [{ id: 'REDES', nome: 'Redes', cor: '' }]);
    // Valores novos (carga em texto da tela, módulo repetido na mesma disciplina sai).
    assert.deepEqual(attendanceUtil.sanitizeDisciplinas([{ id: 'BD', nome: 'Banco de Dados', cargaHoraria: '60', professor: '  Profa. Bia ', modulos: ['M3', 'M3', ' M4 '] }], previous),
        [{ id: 'BD', nome: 'Banco de Dados', cor: '', cargaHoraria: 60, professor: 'Profa. Bia', modulos: ['M3', 'M4'] }]);
    // Disciplina de antes sem os campos novos sai como sempre saiu.
    assert.deepEqual(attendanceUtil.sanitizeDisciplinas([{ id: 'A', nome: 'A', cor: '' }]), [{ id: 'A', nome: 'A', cor: '' }]);
    assert.equal(attendanceUtil.sanitizeDisciplinas('x'), null);

    const modules = structureModuleIds([{ id: 'M1' }, { id: 'M2' }, { name: 'Sem id' }], [{ id: 'M9' }]);
    assert.deepEqual([...modules], ['M1', 'M2', 'Sem id', 'M9']);
    const input = [{ id: 'REDES', nome: 'Redes', modulos: ['M1'] }, { id: 'BD', nome: 'BD', modulos: ['M1'] }];
    const twice = attendanceUtil.disciplinasModuleProblem(input, attendanceUtil.sanitizeDisciplinas(input), modules);
    assert.equal(twice.field, 'disciplinas[1].modulos');
    assert.match(twice.error, /já está na disciplina Redes/);
    const unknownInput = [{ id: 'REDES', nome: 'Redes', modulos: ['M7'] }];
    assert.match(attendanceUtil.disciplinasModuleProblem(unknownInput, attendanceUtil.sanitizeDisciplinas(unknownInput), modules).error, /não existe neste curso/);
    // O módulo que ficou de antes (não veio no pedido) não é recusado se saiu da estrutura.
    const oldInput = [{ id: 'REDES', nome: 'Redes' }];
    assert.equal(attendanceUtil.disciplinasModuleProblem(oldInput, attendanceUtil.sanitizeDisciplinas(oldInput, [{ id: 'REDES', nome: 'Redes', modulos: ['M7'] }]), modules), null);
    // Lista inteira mandada de volta (assistente de horários) com o módulo gravado que saiu
    // da estrutura: não é recusado; módulo novo que não existe continua recusado.
    const saved = [{ id: 'REDES', nome: 'Redes', modulos: ['M7'] }];
    const echoed = [{ id: 'REDES', nome: 'Redes', modulos: ['M7'] }, { id: 'LOGI', nome: 'Lógica' }];
    assert.equal(attendanceUtil.disciplinasModuleProblem(echoed, attendanceUtil.sanitizeDisciplinas(echoed, saved), modules, saved), null);
    const added = [{ id: 'REDES', nome: 'Redes', modulos: ['M7', 'M8'] }];
    assert.match(attendanceUtil.disciplinasModuleProblem(added, attendanceUtil.sanitizeDisciplinas(added, saved), modules, saved).error, /"M8" não existe/);
});

// ---------------------------------------------------------------- rotas

let app;
const tokens = { admin: 'admin-token-terms', prof: 'prof-token-terms', gestor: 'gestor-token-terms', coord: 'coord-token-terms', sec: 'sec-token-terms' };
const as = (who, method, url) => request(app)[method](url).set('x-admin-session', tokens[who]);
const audits = action => db.memory.auditLogs.filter(entry => entry.action === action);

// Grade de segunda (1) e quarta (3): duas aulas de REDES; quinta (4) uma de BD.
const GRADE = {
    1: [{ ordem: 1, inicio: '08:00', disciplinaId: 'REDES' }, { ordem: 2, inicio: '08:50', disciplinaId: 'REDES' }],
    3: [{ ordem: 1, inicio: '08:00', disciplinaId: 'REDES' }, { ordem: 2, inicio: '08:50', disciplinaId: 'REDES' }],
    4: [{ ordem: 1, inicio: '19:00', disciplinaId: 'BD' }],
};

function seed() {
    db.memory.schools = [{ id: 'esc_a', name: 'Escola A' }, { id: 'esc_b', name: 'Escola B' }];
    db.memory.courses = [
        { id: 'TI', name: 'Informática', schoolId: 'esc_a', structure: [
            { id: 'M1', name: 'Redes', units: [{ key: 'u1', name: 'Prova de Redes', avaliacaoKey: 'Avaliacao_TI_1' }] },
            { id: 'M2', name: 'Banco de Dados', units: [{ key: 'u2', name: 'Prova de BD', avaliacaoKey: 'Avaliacao_TI_2' }] },
        ], disciplinas: [{ id: 'REDES', nome: 'Redes', cor: '' }, { id: 'BD', nome: 'Banco de Dados', cor: '' }] },
        { id: 'ADM', name: 'Administração', schoolId: 'esc_b', structure: [], disciplinas: [] },
    ];
    db.memory.classes = [
        { name: '1DES', courseId: 'TI', period: 'Manhã', attendanceConfig: { toleranciaMin: 10, limiarRiscoPct: 75, grade: GRADE } },
        { name: '2DES', courseId: 'TI', period: 'Noite', attendanceConfig: { toleranciaMin: 10, limiarRiscoPct: 75, grade: GRADE } },
        { name: '1ADM', courseId: 'ADM', period: 'Tarde', attendanceConfig: { toleranciaMin: 10, limiarRiscoPct: 75, grade: GRADE } },
    ];
    db.memory.academicTerms = [];
    db.memory.nonSchoolDays = [];
    db.memory.attendance = [];
    db.memory.submissions = [];
    db.memory.evaluations = {};
    db.memory.examApplications = [];
    db.memory.admins = [
        { email: 'admin@periodo.local', name: 'Admin', role: 'admin', password: db.hashPassword('senha-admin-ok') },
        { email: 'prof@periodo.local', name: 'Prof', role: 'professor', password: db.hashPassword('senha-prof-ok'), assignedClasses: [{ courseId: 'TI', className: '1DES' }] },
        // Professor com "Gerenciar turmas" só da 1DES e da 2DES.
        { email: 'gestor@periodo.local', name: 'Gestor', role: 'professor', password: db.hashPassword('senha-gestor-ok'), additionalPermissions: ['classes.manage'], assignedClasses: [{ courseId: 'TI', className: '1DES' }, { courseId: 'TI', className: '2DES' }] },
        { email: 'coord@periodo.local', name: 'Coord', role: 'coordenacao', password: db.hashPassword('senha-coord-ok'), assignedSchoolIds: ['esc_a'] },
        { email: 'sec@periodo.local', name: 'Sec', role: 'secretaria', password: db.hashPassword('senha-sec-ok'), assignedSchoolIds: ['esc_a'] },
    ];
    const now = Date.now();
    db.memory.adminSessions = Object.fromEntries(Object.entries({ admin: 'admin', prof: 'prof', gestor: 'gestor', coord: 'coord', sec: 'sec' })
        .map(([who, user]) => [tokens[who], { email: `${user}@periodo.local`, createdAt: now, lastSeen: now }]));
    db.memory.students = [
        { name: 'Ana', email: 'ana@periodo.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: 'TI' }], studentClass: '1DES' },
    ];
    db.memory.auditLogs = [];
}

test.before(async () => { await db.init(); app = createApp(); });
test.beforeEach(() => seed());
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

// As gravações feitas durante fn (db.save), para conferir o only de cada rota.
async function capturingSaves(fn) {
    const originalSave = db.save;
    const calls = [];
    db.save = (...args) => { calls.push(args[0] || null); return originalSave.apply(db, args); };
    try {
        await fn();
    } finally {
        db.save = originalSave;
    }
    return calls;
}

async function createTerm(fields = {}, who = 'admin') {
    const res = await as(who, 'post', '/api/admin/academic/terms/create').send({ ...TERM, etapas: FOUR_STAGES, ...fields });
    return res;
}

test('[UC-CURSO-002] período letivo: criar com 4 etapas, listar e gravar só academicTerms e a auditoria', async () => {
    const created = await createTerm();
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const periodo = created.body.periodo;
    assert.match(periodo.id, /^per_\d+_[0-9a-f]{6}$/);
    assert.equal(periodo.situacao, 'aberto');
    assert.equal(periodo.situacaoRotulo, 'Aberto');
    assert.equal(periodo.etapas.length, 4);
    assert.equal(periodo.schoolId, null);
    assert.equal(periodo.podeAlterar, true);
    const stored = db.memory.academicTerms[0];
    assert.equal(stored.schemaVersion, 1);
    assert.equal(stored.criadoPor, 'admin@periodo.local');
    const entry = audits('academic_term_created').pop();
    assert.equal(entry.category, 'academic');
    assert.equal(entry.after.nome, TERM.nome);

    // Foi para o disco.
    await db.flush();
    const disk = (await db.readStoredData()).memory.academicTerms;
    assert.equal(disk.length, 1);
    assert.equal(disk[0].etapas[3].nome, '4º bimestre');

    const second = await createTerm({ nome: '2027 · 2º semestre', inicio: '2027-08-02', fim: '2027-12-17', etapas: [], schoolId: 'esc_a' });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.periodo.escolaNome, 'Escola A');
    const list = await as('admin', 'get', '/api/admin/academic/terms');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.periodos.map(item => item.nome), ['2027 · 2º semestre', '2027 · 1º semestre'], 'do mais novo para o mais antigo');
    assert.equal(list.body.podeCriar, true);
    assert.deepEqual(list.body.escolas.map(item => item.id), ['esc_a', 'esc_b']);

    // Repetido (mesmo nome na mesma escola): 409.
    const dup = await createTerm({ nome: '2027 · 1º SEMESTRE' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.code, 'duplicate');
});

test('[UC-CURSO-002] período letivo: validação com field e mensagem em português; schema recusa tipo errado', async () => {
    const cases = [
        [{ fim: '2027-01-10' }, 'fim'],
        [{ etapas: [FOUR_STAGES[0], { ...FOUR_STAGES[1], inicio: '2027-03-01' }] }, 'etapas[1].inicio'],
        [{ etapas: [FOUR_STAGES[0], FOUR_STAGES[2]] }, 'etapas[1].ordem'],
        [{ etapas: [{ ...FOUR_STAGES[0], inicio: '2027-01-02' }] }, 'etapas[0].inicio'],
        [{ etapas: [{ ...FOUR_STAGES[0], ordem: 7 }] }, 'etapas[0].ordem'],
        [{ nome: 123 }, 'nome'],
        [{ nome: 'x'.repeat(81) }, 'nome'],
        [{ schoolId: 'esc_nao_existe' }, 'schoolId'],
    ];
    for (const [fields, field] of cases) {
        const res = await createTerm(fields);
        assert.equal(res.status, 400, `${JSON.stringify(fields)}: ${res.status} ${JSON.stringify(res.body)}`);
        assert.equal(res.body.field, field, JSON.stringify(res.body));
    }
    assert.equal(db.memory.academicTerms.length, 0, 'nada gravado');
});

test('[UC-CURSO-002] período letivo: quem pode (classes.manage e o escopo); a Coordenação e a Secretaria só leem', async () => {
    const prof = await createTerm({}, 'prof');
    assert.equal(prof.status, 403, 'professor sem "Gerenciar turmas"');
    const coord = await createTerm({}, 'coord');
    assert.equal(coord.status, 403);
    assert.equal(coord.body.code, 'read_only_account');
    const sec = await createTerm({}, 'sec');
    assert.equal(sec.status, 403, 'Secretaria não gerencia turmas');
    // Professor com "Gerenciar turmas": cria para a escola dele, não para a de outro curso.
    const own = await createTerm({ schoolId: 'esc_a' }, 'gestor');
    assert.equal(own.status, 200, JSON.stringify(own.body));
    const other = await createTerm({ nome: 'Outro', schoolId: 'esc_b' }, 'gestor');
    assert.equal(other.status, 403);
    assert.equal(other.body.field, 'schoolId');

    // Leitura: todos com page.dashboard; o período da escola B não aparece para quem é da A.
    const adminB = await createTerm({ nome: 'Só da escola B', schoolId: 'esc_b' });
    assert.equal(adminB.status, 200);
    const coordList = await as('coord', 'get', '/api/admin/academic/terms');
    assert.equal(coordList.status, 200);
    assert.deepEqual(coordList.body.periodos.map(item => item.nome), [TERM.nome]);
    assert.equal(coordList.body.podeCriar, false);
    assert.equal(coordList.body.periodos[0].podeAlterar, false);
    const profList = await as('prof', 'get', '/api/admin/academic/terms');
    assert.equal(profList.status, 200);
    assert.equal(profList.body.podeCriar, false);
    // O gestor não altera o período ligado a uma turma que não é dele.
    db.memory.classes.find(cls => cls.name === '1ADM').periodoLetivoId = own.body.periodo.id;
    const blocked = await as('gestor', 'post', '/api/admin/academic/terms/update').send({ id: own.body.periodo.id, nome: 'Renomeado' });
    assert.equal(blocked.status, 403);
    db.memory.classes.find(cls => cls.name === '1ADM').periodoLetivoId = undefined;
    const allowed = await as('gestor', 'post', '/api/admin/academic/terms/update').send({ id: own.body.periodo.id, nome: 'Renomeado' });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
});

test('[UC-CURSO-002] turma no período: class/create e class/update ligam e desligam; período inexistente, de outra escola ou encerrado é recusado', async () => {
    const term = (await createTerm()).body.periodo;
    const schoolA = (await createTerm({ nome: 'Escola A 2027', schoolId: 'esc_a' })).body.periodo;
    const schoolB = (await createTerm({ nome: 'Escola B 2027', schoolId: 'esc_b' })).body.periodo;

    let linked;
    const updateSaves = await capturingSaves(async () => {
        linked = await as('admin', 'post', '/api/admin/class/update').send({ name: '1DES', courseId: 'TI', periodoLetivoId: term.id });
    });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    // Gravação parcial: só a turma e a auditoria.
    assert.deepEqual(updateSaves, [{ only: ['classes', 'auditLogs'] }]);
    const cls = () => db.memory.classes.find(item => item.name === '1DES' && item.courseId === 'TI');
    assert.equal(cls().periodoLetivoId, term.id);
    const entry = audits('class_updated').pop();
    assert.equal(entry.before.periodoLetivoId, undefined);
    assert.equal(entry.after.periodoLetivoId, term.id);
    // A Chamada já obedece ao período (lessonsForDate): fora dele não há aula.
    const outside = await as('admin', 'get', '/api/admin/attendance/roster?courseId=TI&studentClass=1DES&date=2027-08-02');
    assert.equal(outside.status, 200);
    assert.equal(outside.body.foraDoPeriodo, true);
    assert.deepEqual(outside.body.aulas, []);
    const inside = await as('admin', 'get', '/api/admin/attendance/roster?courseId=TI&studentClass=1DES&date=2027-03-01');
    assert.equal(inside.body.foraDoPeriodo, false);
    assert.equal(inside.body.aulas.length, 2);

    // Pedido sem o campo (a tela de hoje) não mexe; período da própria escola vale.
    assert.equal((await as('admin', 'post', '/api/admin/class/update').send({ name: '1DES', courseId: 'TI', period: 'Tarde' })).status, 200);
    assert.equal(cls().periodoLetivoId, term.id);
    assert.equal((await as('admin', 'post', '/api/admin/class/update').send({ name: '1DES', courseId: 'TI', periodoLetivoId: schoolA.id })).status, 200);
    assert.equal(cls().periodoLetivoId, schoolA.id);

    const missing = await as('admin', 'post', '/api/admin/class/update').send({ name: '1DES', courseId: 'TI', periodoLetivoId: 'per_nao_existe', period: 'Noite' });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.field, 'periodoLetivoId');
    assert.equal(cls().period, 'Tarde', 'recusado, nada muda');
    const wrongType = await as('admin', 'post', '/api/admin/class/update').send({ name: '1DES', courseId: 'TI', periodoLetivoId: 42 });
    assert.equal(wrongType.status, 400);
    assert.equal(wrongType.body.field, 'periodoLetivoId');
    assert.match(wrongType.body.error, /período letivo/i);
    // O schema (inputSchema) confere tipo e tamanho também na criação.
    const tooLong = await as('admin', 'post', '/api/admin/class/create').send({ name: '9DES', period: 'Noite', courseId: 'TI', periodoLetivoId: 'p'.repeat(121) });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.field, 'periodoLetivoId');
    assert.equal(db.memory.classes.some(item => item.name === '9DES'), false);
    const objectId = await as('admin', 'post', '/api/admin/class/create').send({ name: '9DES', period: 'Noite', courseId: 'TI', periodoLetivoId: { id: term.id } });
    assert.equal(objectId.status, 400);
    assert.equal(objectId.body.field, 'periodoLetivoId');
    const otherSchool = await as('admin', 'post', '/api/admin/class/update').send({ name: '1DES', courseId: 'TI', periodoLetivoId: schoolB.id });
    assert.equal(otherSchool.status, 400);
    assert.match(otherSchool.body.error, /outra escola/);

    // null tira a turma do período (volta a funcionar como sempre).
    assert.equal((await as('admin', 'post', '/api/admin/class/update').send({ name: '1DES', courseId: 'TI', periodoLetivoId: null })).status, 200);
    assert.equal('periodoLetivoId' in cls(), false);

    // Turma nova já no período; com período encerrado, 409.
    let created;
    const createSaves = await capturingSaves(async () => {
        created = await as('admin', 'post', '/api/admin/class/create').send({ name: '3des', period: 'Noite', courseId: 'TI', periodoLetivoId: term.id });
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.deepEqual(createSaves, [{ only: ['classes', 'auditLogs'] }]);
    await db.flush();
    assert.equal((await db.readStoredData()).memory.classes.find(item => item.name === '3DES').periodoLetivoId, term.id, 'foi para o disco');
    assert.equal(db.memory.classes.find(item => item.name === '3DES').periodoLetivoId, term.id);
    assert.equal((await as('admin', 'post', '/api/admin/academic/terms/close').send({ id: term.id })).status, 200);
    const closedNew = await as('admin', 'post', '/api/admin/class/create').send({ name: '4DES', period: 'Noite', courseId: 'TI', periodoLetivoId: term.id });
    assert.equal(closedNew.status, 409);
    assert.equal(closedNew.body.code, 'term_closed');
    assert.equal(db.memory.classes.some(item => item.name === '4DES'), false);
    const closedLink = await as('admin', 'post', '/api/admin/class/update').send({ name: '1DES', courseId: 'TI', periodoLetivoId: term.id });
    assert.equal(closedLink.status, 409);
    // A turma que já estava no período encerrado continua sendo alterada normalmente.
    const keep = await as('admin', 'post', '/api/admin/class/update').send({ name: '3DES', courseId: 'TI', periodoLetivoId: term.id, period: 'Manhã' });
    assert.equal(keep.status, 200, JSON.stringify(keep.body));

    // Turmas: course-summaries traz o período de cada turma.
    const summaries = await as('admin', 'get', '/api/admin/course-summaries');
    const des3 = summaries.body.find(course => course.id === 'TI').classes.find(item => item.name === '3DES');
    assert.equal(des3.periodoLetivoId, term.id);
    assert.deepEqual(des3.periodoLetivo, { id: term.id, nome: TERM.nome, inicio: TERM.inicio, fim: TERM.fim });
    assert.equal(summaries.body.find(course => course.id === 'TI').classes.find(item => item.name === '1DES').periodoLetivo, null);
});

test('[UC-CURSO-002] encerrar o período não encerra a turma nem muda nota; alterar encerrado é 409; reabrir pede motivo', async () => {
    const term = (await createTerm()).body.periodo;
    db.memory.classes.find(cls => cls.name === '1DES').periodoLetivoId = term.id;
    db.memory.submissions = [{ id: 'sub_1', examKey: 'Avaliacao_TI_1', score: 80, gradePublished: true, courseId: 'TI', studentClass: '1DES', timestamp: Date.parse('2027-03-10T12:00:00Z'), student: { email: 'ana@periodo.local', name: 'Ana', studentClass: '1DES', courseId: 'TI' } }];
    const report = async () => (await as('admin', 'get', '/api/admin/student/report?email=ana@periodo.local&courseId=TI&studentClass=1DES')).body;
    const before = await report();
    assert.equal(before.overallAverage, 8);
    const classBefore = JSON.stringify(db.memory.classes);

    const closed = await as('admin', 'post', '/api/admin/academic/terms/close').send({ id: term.id });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.periodo.situacao, 'encerrado');
    assert.ok(closed.body.periodo.encerradoEm > 0);
    assert.equal(closed.body.periodo.encerradoPor, 'admin@periodo.local');
    assert.equal(closed.body.periodo.reabertoEm, null);
    assert.deepEqual(closed.body.turmas, [{ courseId: 'TI', courseName: 'Informática', name: '1DES' }]);
    assert.equal(JSON.stringify(db.memory.classes), classBefore, 'a turma não muda');
    assert.equal((await report()).overallAverage, 8, 'a nota não muda');
    const entry = audits('academic_term_closed').pop();
    assert.deepEqual(entry.details.turmas, ['TI · 1DES']);
    assert.equal(entry.category, 'academic');
    // Encerrar de novo: nada muda nem é registrado.
    const again = await as('admin', 'post', '/api/admin/academic/terms/close').send({ id: term.id });
    assert.equal(again.body.semMudanca, true);
    assert.equal(audits('academic_term_closed').length, 1);

    const edit = await as('admin', 'post', '/api/admin/academic/terms/update').send({ id: term.id, fim: '2027-07-30' });
    assert.equal(edit.status, 409);
    assert.equal(edit.body.code, 'term_closed');

    const noReason = await as('admin', 'post', '/api/admin/academic/terms/reopen').send({ id: term.id });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.code, 'reason_required');
    const reopened = await as('admin', 'post', '/api/admin/academic/terms/reopen').send({ id: term.id, reason: 'Faltou lançar a recuperação' });
    assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
    assert.equal(reopened.body.periodo.situacao, 'aberto');
    // Aberto de novo: a resposta não mostra o encerramento antigo, e mostra a reabertura.
    assert.equal(reopened.body.periodo.encerradoEm, null);
    assert.equal(reopened.body.periodo.encerradoPor, null);
    assert.ok(reopened.body.periodo.reabertoEm > 0);
    assert.equal(reopened.body.periodo.reabertoPor, 'admin@periodo.local');
    const listed = (await as('admin', 'get', '/api/admin/academic/terms')).body.periodos.find(item => item.id === term.id);
    assert.equal(listed.encerradoEm, null);
    assert.equal(listed.reabertoPor, 'admin@periodo.local');
    assert.ok(db.memory.academicTerms.find(item => item.id === term.id).encerradoEm > 0, 'o registro guarda o histórico');
    const reopenEntry = audits('academic_term_reopened').pop();
    assert.equal(reopenEntry.reason, 'Faltou lançar a recuperação');
    assert.equal(reopenEntry.details.id, term.id);

    // Alterar o aberto: antes e depois na auditoria; salvar igual não registra.
    const updated = await as('admin', 'post', '/api/admin/academic/terms/update').send({ id: term.id, fim: '2027-07-16', etapas: [...FOUR_STAGES.slice(0, 3), { ...FOUR_STAGES[3], fim: '2027-07-16' }] });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.periodo.fim, '2027-07-16');
    const upd = audits('academic_term_updated').pop();
    assert.equal(upd.before.fim, '2027-07-09');
    assert.equal(upd.after.fim, '2027-07-16');
    assert.equal(upd.details.turmas, 1);
    const same = await as('admin', 'post', '/api/admin/academic/terms/update').send({ id: term.id, nome: TERM.nome });
    assert.equal(same.body.semMudanca, true);
    assert.equal(audits('academic_term_updated').length, 1);
    // Período de uma escola não fica com turma de curso de outra escola.
    db.memory.classes.find(cls => cls.name === '1ADM').periodoLetivoId = term.id;
    const wrongSchool = await as('admin', 'post', '/api/admin/academic/terms/update').send({ id: term.id, schoolId: 'esc_a' });
    assert.equal(wrongSchool.status, 400);
    assert.equal(wrongSchool.body.field, 'schoolId');
    assert.match(wrongSchool.body.error, /1ADM/);
    assert.equal((await as('admin', 'post', '/api/admin/academic/terms/update').send({ id: 'per_x', nome: 'X' })).status, 404);
});

test('[UC-CURSO-002] disciplinas: carga horária, professor e módulos pela rota; o pedido de antes não apaga; módulo em duas disciplinas ou inexistente é 400', async () => {
    const full = await as('admin', 'post', '/api/admin/course/disciplinas').send({ courseId: 'TI', disciplinas: [
        { id: 'REDES', nome: 'Redes', cor: '', cargaHoraria: 80, professor: 'Prof. Carlos', modulos: ['M1'] },
        { id: 'BD', nome: 'Banco de Dados', cor: '', cargaHoraria: '40', modulos: ['M2'] },
    ] });
    assert.equal(full.status, 200, JSON.stringify(full.body));
    assert.deepEqual(db.memory.courses[0].disciplinas, [
        { id: 'REDES', nome: 'Redes', cor: '', cargaHoraria: 80, professor: 'Prof. Carlos', modulos: ['M1'] },
        { id: 'BD', nome: 'Banco de Dados', cor: '', cargaHoraria: 40, modulos: ['M2'] },
    ]);
    const entry = audits('course_disciplinas_updated').pop();
    assert.equal(entry.after.disciplinas[0].cargaHoraria, 80);
    await db.flush();
    assert.equal((await db.readStoredData()).memory.courses.find(course => course.id === 'TI').disciplinas[0].professor, 'Prof. Carlos');

    // Pedido de antes (a tela de hoje): id, nome e cor.
    const old = await as('admin', 'post', '/api/admin/course/disciplinas').send({ courseId: 'TI', disciplinas: [{ id: 'REDES', nome: 'Redes de Computadores', cor: '#112233' }, { id: 'BD', nome: 'Banco de Dados', cor: '' }] });
    assert.equal(old.status, 200);
    assert.equal(db.memory.courses[0].disciplinas[0].cargaHoraria, 80);
    assert.deepEqual(db.memory.courses[0].disciplinas[1].modulos, ['M2']);

    const twice = await as('admin', 'post', '/api/admin/course/disciplinas').send({ courseId: 'TI', disciplinas: [{ id: 'REDES', nome: 'Redes', modulos: ['M1', 'M2'] }, { id: 'BD', nome: 'Banco de Dados' }] });
    assert.equal(twice.status, 400);
    assert.equal(twice.body.field, 'disciplinas[1].modulos');
    assert.match(twice.body.error, /M2/);
    const unknown = await as('admin', 'post', '/api/admin/course/disciplinas').send({ courseId: 'TI', disciplinas: [{ id: 'REDES', nome: 'Redes', modulos: ['M9'] }] });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /não existe neste curso/);
    const tooMuch = await as('admin', 'post', '/api/admin/course/disciplinas').send({ courseId: 'TI', disciplinas: [{ id: 'REDES', nome: 'Redes', cargaHoraria: 2001 }] });
    assert.equal(tooMuch.status, 400);
    assert.equal(tooMuch.body.field, 'disciplinas[0].cargaHoraria');
    const badProfessor = await as('admin', 'post', '/api/admin/course/disciplinas').send({ courseId: 'TI', disciplinas: [{ id: 'REDES', nome: 'Redes', professor: { nome: 'x' } }] });
    assert.equal(badProfessor.status, 400);
    assert.equal((await as('admin', 'post', '/api/admin/course/disciplinas').send({ courseId: 'TI', disciplinas: 'x' })).body.error, 'Lista de disciplinas inválida.');
    assert.equal(db.memory.courses[0].disciplinas[0].cargaHoraria, 80, 'recusado, nada muda');
    // O campo numérico vazio da tela ('' ou só espaços) apaga a carga horária, igual a null
    // (C6: um campo enviado vazio apaga); texto que não é número continua 400.
    const blank = await as('admin', 'post', '/api/admin/course/disciplinas').send({ courseId: 'TI', disciplinas: [{ id: 'REDES', nome: 'Redes', cargaHoraria: '' }, { id: 'BD', nome: 'Banco de Dados', cargaHoraria: '  ' }] });
    assert.equal(blank.status, 200, JSON.stringify(blank.body));
    assert.equal('cargaHoraria' in db.memory.courses[0].disciplinas[0], false, "'' apaga a carga horária");
    assert.equal('cargaHoraria' in db.memory.courses[0].disciplinas[1], false, "'  ' apaga a carga horária");
    assert.deepEqual(db.memory.courses[0].disciplinas[0].modulos, ['M1'], 'os outros campos ficam');
    const word = await as('admin', 'post', '/api/admin/course/disciplinas').send({ courseId: 'TI', disciplinas: [{ id: 'REDES', nome: 'Redes', cargaHoraria: 'oitenta' }] });
    assert.equal(word.status, 400);
    assert.equal(word.body.field, 'disciplinas[0].cargaHoraria');
    const again = await as('admin', 'post', '/api/admin/course/disciplinas').send({ courseId: 'TI', disciplinas: [{ id: 'REDES', nome: 'Redes', cargaHoraria: ' 80 ' }, { id: 'BD', nome: 'Banco de Dados' }] });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(db.memory.courses[0].disciplinas[0].cargaHoraria, 80);

    // Módulo que só existe na estrutura própria de uma turma também vale.
    db.memory.classes[0].contentOverrides = { materials: {}, evaluations: {}, unitNames: {}, extraUnits: [], structure: [{ id: 'M1', name: 'Redes', units: [] }, { id: 'M_EXTRA', name: 'Extra', units: [] }] };
    const extra = await as('admin', 'post', '/api/admin/course/disciplinas').send({ courseId: 'TI', disciplinas: [{ id: 'REDES', nome: 'Redes', modulos: ['M1', 'M_EXTRA'] }, { id: 'BD', nome: 'Banco de Dados', modulos: null }] });
    assert.equal(extra.status, 200, JSON.stringify(extra.body));
    assert.equal('modulos' in db.memory.courses[0].disciplinas[1], false, 'null tira os módulos');
    // O professor (sem course.manage) não altera.
    assert.equal((await as('prof', 'post', '/api/admin/course/disciplinas').send({ courseId: 'TI', disciplinas: [] })).status, 403);
});

test('[UC-CURSO-002] disciplinas: o assistente de horários salva a lista de volta mesmo com um módulo gravado que saiu da estrutura', async () => {
    const saved = await as('admin', 'post', '/api/admin/course/disciplinas').send({ courseId: 'TI', disciplinas: [
        { id: 'REDES', nome: 'Redes', cor: '', cargaHoraria: 80, modulos: ['M1'] },
        { id: 'BD', nome: 'Banco de Dados', cor: '', modulos: ['M2'] },
    ] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    // O módulo M2 sai da estrutura do curso (ou muda de id) depois de ligado à disciplina.
    db.memory.courses[0].structure = db.memory.courses[0].structure.filter(module => module.id !== 'M2');

    // O corpo do AssistenteHorariosPage: [...course.disciplinas de course-summaries, nova].
    const summaries = await as('admin', 'get', '/api/admin/course-summaries');
    const fromScreen = summaries.body.find(course => course.id === 'TI').disciplinas;
    assert.deepEqual(fromScreen.find(item => item.id === 'BD').modulos, ['M2']);
    const echoed = await as('admin', 'post', '/api/admin/course/disciplinas').send({ courseId: 'TI', disciplinas: [...fromScreen, { id: 'LOGI', nome: 'Lógica', cor: '' }] });
    assert.equal(echoed.status, 200, JSON.stringify(echoed.body));
    assert.deepEqual(db.memory.courses[0].disciplinas.map(item => item.id), ['REDES', 'BD', 'LOGI']);
    assert.deepEqual(db.memory.courses[0].disciplinas[1].modulos, ['M2'], 'o módulo que ninguém mexeu fica como estava');
    assert.equal(db.memory.courses[0].disciplinas[0].cargaHoraria, 80);

    // Ligar o módulo que não existe mais a OUTRA disciplina continua recusado (é novo nela).
    const moved = await as('admin', 'post', '/api/admin/course/disciplinas').send({ courseId: 'TI', disciplinas: [
        { id: 'REDES', nome: 'Redes', modulos: ['M1'] }, { id: 'BD', nome: 'Banco de Dados', modulos: [] }, { id: 'LOGI', nome: 'Lógica', modulos: ['M2'] },
    ] });
    assert.equal(moved.status, 400);
    assert.equal(moved.body.field, 'disciplinas[2].modulos');
    assert.match(moved.body.error, /"M2" não existe neste curso/);
    // E o mesmo módulo gravado em duas disciplinas continua recusado.
    const dup = await as('admin', 'post', '/api/admin/course/disciplinas').send({ courseId: 'TI', disciplinas: [
        { id: 'REDES', nome: 'Redes', modulos: ['M1'] }, { id: 'BD', nome: 'Banco de Dados', modulos: ['M2'] }, { id: 'LOGI', nome: 'Lógica', modulos: ['M1'] },
    ] });
    assert.equal(dup.status, 400);
    assert.match(dup.body.error, /já está na disciplina Redes/);
});

test('[UC-CURSO-002] boletim: período letivo, aulas previstas e carga horária; faltas que ainda pode ter só com a frequência mínima dos critérios', async () => {
    const term = (await createTerm({ inicio: '2027-08-02', fim: '2027-08-29', nome: 'Agosto', etapas: [] })).body.periodo;
    const course = db.memory.courses[0];
    course.disciplinas = [{ id: 'REDES', nome: 'Redes', cor: '', cargaHoraria: 80, professor: 'Prof. Carlos', modulos: ['M1'] }, { id: 'BD', nome: 'Banco de Dados', cor: '' }];
    db.memory.classes[0].periodoLetivoId = term.id;
    db.memory.nonSchoolDays = [{ id: 'nl_1', inicio: '2027-08-11', fim: '2027-08-11', tipo: 'feriado', nome: 'Feriado municipal', escopo: 'instituicao' }];
    db.memory.attendance = [
        { id: 'a1', origin: 'chamada', concluida: true, studentEmail: 'ana@periodo.local', courseId: 'TI', studentClass: '1DES', date: '2027-08-02', aulas: [{ ordem: 1, disciplinaId: 'REDES', status: 'falta' }, { ordem: 2, disciplinaId: 'REDES', status: 'presente' }] },
        { id: 'a2', origin: 'chamada', concluida: true, studentEmail: 'ana@periodo.local', courseId: 'TI', studentClass: '1DES', date: '2027-08-05', aulas: [{ ordem: 1, disciplinaId: 'BD', status: 'presente' }] },
    ];
    const res = await as('admin', 'get', '/api/admin/student/report?email=ana@periodo.local&courseId=TI&studentClass=1DES');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.periodoLetivo, { id: term.id, nome: 'Agosto', inicio: '2027-08-02', fim: '2027-08-29' });
    // 4 segundas e 4 quartas (uma é feriado) com 2 aulas de REDES = 14; 4 quintas de BD.
    assert.equal(res.body.attendance.aulasPrevistas, 18);
    assert.equal(res.body.attendance.frequenciaMinima, null, 'sem critérios, não há mínima');
    assert.equal(res.body.attendance.faltasPermitidasRestantes, null);
    const redes = res.body.attendance.disciplines.find(item => item.id === 'REDES');
    assert.equal(redes.cargaHoraria, 80);
    assert.equal(redes.professor, 'Prof. Carlos');
    assert.equal(redes.aulasPrevistas, 14);
    assert.equal(redes.faltasPermitidasRestantes, null);
    const bd = res.body.attendance.disciplines.find(item => item.id === 'BD');
    assert.equal(bd.cargaHoraria, null);
    assert.equal(bd.aulasPrevistas, 4);

    // Com os critérios do curso (frequência mínima 75%): 25% de 18 = 4 faltas, 1 usada.
    course.avaliacao = { versao: 1, ativo: true, mediaMinima: 6, frequenciaMinima: 75 };
    const withRule = (await as('admin', 'get', '/api/admin/student/report?email=ana@periodo.local&courseId=TI&studentClass=1DES')).body;
    assert.equal(withRule.attendance.frequenciaMinima, 75);
    assert.equal(withRule.attendance.faltasPermitidasRestantes, 3);
    assert.equal(withRule.attendance.disciplines.find(item => item.id === 'REDES').faltasPermitidasRestantes, 2, '25% de 14 = 3, 1 usada');
    assert.equal(withRule.attendance.disciplines.find(item => item.id === 'BD').faltasPermitidasRestantes, 1);

    // Turma sem período letivo: como antes (sem aulas previstas).
    delete db.memory.classes[0].periodoLetivoId;
    const noTerm = (await as('admin', 'get', '/api/admin/student/report?email=ana@periodo.local&courseId=TI&studentClass=1DES')).body;
    assert.equal(noTerm.periodoLetivo, null);
    assert.equal(noTerm.attendance.aulasPrevistas, null);
    assert.equal(noTerm.attendance.disciplines.find(item => item.id === 'REDES').aulasPrevistas, null);
});

test('[UC-CURSO-002] boletim: as faltas de antes do período não gastam a cota do período; disciplina sem chamada aparece com carga horária e aulas previstas', async () => {
    const term = (await createTerm({ inicio: '2027-08-02', fim: '2027-08-29', nome: 'Agosto', etapas: [] })).body.periodo;
    const course = db.memory.courses[0];
    course.disciplinas = [{ id: 'REDES', nome: 'Redes', cor: '', cargaHoraria: 80 }, { id: 'BD', nome: 'Banco de Dados', cor: '', cargaHoraria: 20, professor: 'Profa. Bia' }];
    course.avaliacao = { versao: 1, ativo: true, mediaMinima: 6, frequenciaMinima: 75 };
    // Turma que já existia (faltas em março) e foi ligada ao período de agosto (D17).
    db.memory.classes[0].periodoLetivoId = term.id;
    db.memory.attendance = [
        { id: 'a0', origin: 'chamada', concluida: true, studentEmail: 'ana@periodo.local', courseId: 'TI', studentClass: '1DES', date: '2027-03-01', aulas: [{ ordem: 1, disciplinaId: 'REDES', status: 'falta' }, { ordem: 2, disciplinaId: 'REDES', status: 'falta' }] },
        { id: 'a1', origin: 'chamada', concluida: true, studentEmail: 'ana@periodo.local', courseId: 'TI', studentClass: '1DES', date: '2027-08-02', aulas: [{ ordem: 1, disciplinaId: 'REDES', status: 'falta' }, { ordem: 2, disciplinaId: 'REDES', status: 'presente' }] },
        { id: 'a2', origin: 'chamada', concluida: true, studentEmail: 'ana@periodo.local', courseId: 'TI', studentClass: '1DES', date: '2027-08-30', aulas: [{ ordem: 1, disciplinaId: 'REDES', status: 'falta' }] },
    ];
    const res = await as('admin', 'get', '/api/admin/student/report?email=ana@periodo.local&courseId=TI&studentClass=1DES');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const attendance = res.body.attendance;
    // 4 segundas e 4 quartas com 2 aulas de REDES = 16; 4 quintas de BD = 4.
    assert.equal(attendance.aulasPrevistas, 20);
    // A frequência mostrada é a de todas as aulas lançadas (D10): 4 faltas e 1 presença.
    assert.equal(attendance.faltas, 4);
    assert.equal(attendance.presentes, 1);
    // A cota: 25% de 20 = 5, e só a falta de 02/08 está dentro do período.
    assert.equal(attendance.faltasNoPeriodo, 1);
    assert.equal(attendance.faltasPermitidasRestantes, 4);
    const redes = attendance.disciplines.find(item => item.id === 'REDES');
    assert.equal(redes.faltas, 4, 'a frequência da disciplina continua com todas as aulas');
    assert.equal(redes.faltasPermitidasRestantes, 3, '25% de 16 = 4, 1 usada no período');
    // BD tem aula na grade e nenhuma chamada lançada: entra com carga horária e previstas.
    const bd = attendance.disciplines.find(item => item.id === 'BD');
    assert.ok(bd, 'disciplina sem chamada aparece no boletim');
    assert.equal(bd.name, 'Banco de Dados');
    assert.equal(bd.cargaHoraria, 20);
    assert.equal(bd.professor, 'Profa. Bia');
    assert.equal(bd.aulasPrevistas, 4);
    assert.equal(bd.faltasPermitidasRestantes, 1);
    assert.deepEqual([bd.presentes, bd.faltas, bd.total, bd.frequencia], [0, 0, 0, null]);
    assert.equal(attendance.disciplines.filter(item => item.id === 'BD').length, 1);

    // Curso antigo (sem carga horária) e turma sem período: o boletim lista só as
    // disciplinas com chamada, como sempre.
    course.disciplinas = [{ id: 'REDES', nome: 'Redes', cor: '' }, { id: 'BD', nome: 'Banco de Dados', cor: '' }];
    delete course.avaliacao;
    delete db.memory.classes[0].periodoLetivoId;
    const legacy = (await as('admin', 'get', '/api/admin/student/report?email=ana@periodo.local&courseId=TI&studentClass=1DES')).body.attendance;
    assert.deepEqual(legacy.disciplines.map(item => item.id), ['REDES']);
    assert.equal(legacy.faltasNoPeriodo, null);
    assert.equal(legacy.faltasPermitidasRestantes, null);

    // A função exportada para o resumo do aluno (B6): sem records, usa as faltas de stats.
    const { attendanceAllowanceFor } = require('../../backend/utils/gradebook.js');
    db.memory.classes[0].periodoLetivoId = term.id;
    course.avaliacao = { versao: 1, ativo: true, mediaMinima: 6, frequenciaMinima: 75 };
    const legacyCall = attendanceAllowanceFor(db.memory, { course, cls: db.memory.classes[0], stats: { faltasContam: 2, porDisciplina: {} } });
    assert.equal(legacyCall.faltasPermitidasRestantes, 3);
    assert.equal(legacyCall.disciplina('REDES', 1).faltasPermitidasRestantes, 3);
});

test('[UC-CURSO-002] duplicar curso: disciplinas com carga horária e módulos continuam valendo; período aberto fica, encerrado sai; plano da turma acompanha as provas', async () => {
    const open = (await createTerm()).body.periodo;
    const closed = (await createTerm({ nome: '2026 · 2º semestre', inicio: '2026-08-03', fim: '2026-12-18', etapas: [] })).body.periodo;
    await as('admin', 'post', '/api/admin/academic/terms/close').send({ id: closed.id });
    const course = db.memory.courses[0];
    course.disciplinas = [{ id: 'REDES', nome: 'Redes', cor: '', cargaHoraria: 80, professor: 'Prof. Carlos', modulos: ['M1'] }, { id: 'BD', nome: 'Banco de Dados', cor: '', modulos: ['M2'] }];
    db.memory.classes[0].periodoLetivoId = open.id;
    db.memory.classes[0].avaliacao = { itens: { Avaliacao_TI_1: { etapa: 1, peso: 2 }, man_1_abcdef: { etapa: 2, peso: 1 } }, manuais: [{ id: 'man_1_abcdef', titulo: 'Seminário', tipo: 'seminario' }] };
    db.memory.classes[0].encerramento = { em: Date.now(), por: 'admin@periodo.local' };
    db.memory.classes[1].periodoLetivoId = closed.id;

    const res = await as('admin', 'post', '/api/admin/courses/TI/clone').send({ newId: 'TI27', newName: 'Informática 2027' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const clone = db.memory.courses.find(item => item.id === 'TI27');
    assert.deepEqual(clone.disciplinas, course.disciplinas);
    const cloneModules = structureModuleIds(clone.structure);
    clone.disciplinas.flatMap(item => item.modulos || []).forEach(id => assert.ok(cloneModules.has(id), `módulo ${id} da disciplina existe no curso novo`));
    const des1 = db.memory.classes.find(item => item.courseId === 'TI27' && item.name === '1DES');
    const des2 = db.memory.classes.find(item => item.courseId === 'TI27' && item.name === '2DES');
    assert.equal(des1.periodoLetivoId, open.id);
    assert.equal('periodoLetivoId' in des2, false, 'período encerrado não passa para a cópia');
    assert.deepEqual(Object.keys(des1.avaliacao.itens).sort(), ['Avaliacao_TI_1_TI27', 'man_1_abcdef']);
    assert.equal(des1.avaliacao.itens.Avaliacao_TI_1_TI27.peso, 2);
    assert.equal('encerramento' in des1, false, 'a cópia nasce aberta');
    // A origem continua como estava.
    assert.equal(db.memory.classes[0].periodoLetivoId, open.id);
    assert.ok(db.memory.classes[0].avaliacao.itens.Avaliacao_TI_1);

    // Para outra escola, o período da escola A não vale: a cópia fica sem período.
    db.memory.academicTerms.find(item => item.id === open.id).schoolId = 'esc_a';
    const other = await as('admin', 'post', '/api/admin/courses/TI/clone').send({ newId: 'TIB', newName: 'Informática B', schoolId: 'esc_b' });
    assert.equal(other.status, 200, JSON.stringify(other.body));
    assert.equal('periodoLetivoId' in db.memory.classes.find(item => item.courseId === 'TIB' && item.name === '1DES'), false);
});
