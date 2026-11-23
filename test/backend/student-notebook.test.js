// Fase 3, C17 / P5-S3 (UXA-14, D25 do P5): o aluno imprime a apostila e leva o caderno.
// Antes o caderno só saía em Meus dados, como dado bruto por chave e sem título de
// unidade, e o curso não tinha como desligar a impressão.
//
// [UC-CADERNO-002] GET /api/student/notebook: só as notas e destaques do próprio aluno,
//   com o título da unidade e do módulo da estrutura da turma, na ordem do curso; unidade
//   fora da estrutura não sai; formato antigo vai em `anteriores`; na prévia, vazio; só lê.
// [UC-CONTEUDO-002] courses[].permitirImpressao: PUT/POST de curso (booleano, auditado), o
//   data.js do aluno manda o valor (ausente = true) e o curso antigo continua imprimindo.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-notebook-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { buildNotebook } = require('../../backend/utils/studentNotes.js');
const { createApp } = require('../../backend/server.js');

const COURSE = 'curso-caderno';
const CLASS = '1DES';
const Q = `courseId=${COURSE}&studentClass=${CLASS}`;
const ANA = 'ana@caderno.local';
const BIA = 'bia@caderno.local';
const tokens = { admin: 'admin-token-caderno', prof: 'prof-token-caderno', ana: 'ana-token-caderno', bia: 'bia-token-caderno' };
let app;

const STRUCTURE = [
    { id: 'm1', name: 'Fundamentos', units: [
        { id: 'u1', name: 'Redes <b>locais</b>', apostilaKey: 'Ap_1' },
        { id: 'u2', name: 'Endereçamento', apostilaKey: 'Ap_2' },
    ] },
    { id: 'm2', title: 'Prática', units: [
        { id: 'u3', name: 'Laboratório', apostilaKey: 'Ap_3' },
        { id: 'u4', name: 'Prova', avaliacaoKey: 'Avaliacao_P1' },
    ] },
];

function seed() {
    const now = Date.now();
    db.memory.admins = [
        { email: 'admin@caderno.local', name: 'Admin', role: 'admin', password: db.hashPassword('Senha-Antiga-2026') },
        { email: 'prof@caderno.local', name: 'Professora', role: 'professor', password: db.hashPassword('Senha-Antiga-2026'),
            assignedClasses: [{ courseId: COURSE, className: CLASS }] },
    ];
    db.memory.adminSessions = {
        [tokens.admin]: { email: 'admin@caderno.local', createdAt: now, lastSeen: now },
        [tokens.prof]: { email: 'prof@caderno.local', createdAt: now, lastSeen: now },
    };
    db.memory.schools = [{ id: 'escola_a', name: 'Escola A', info: {}, branding: {} }];
    db.memory.courses = [{ id: COURSE, name: 'Desenvolvimento', schoolId: 'escola_a', structure: JSON.parse(JSON.stringify(STRUCTURE)) }];
    db.memory.classes = [
        { name: CLASS, courseId: COURSE, period: 'Manhã', releasedItems: { Ap_1: true, Ap_2: true, Ap_3: false }, onlineExamConfigs: {} },
        { name: '2DES', courseId: COURSE, period: 'Tarde', releasedItems: {}, onlineExamConfigs: {} },
    ];
    db.memory.students = [
        { id: 'alu_00000000000000a1', name: 'Ana', email: ANA, status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: CLASS, courseId: COURSE }], studentClass: CLASS },
        { id: 'alu_00000000000000b2', name: 'Bia', email: BIA, status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '2DES', courseId: COURSE }], studentClass: '2DES' },
    ];
    db.memory.sessions = {
        [ANA]: { token: tokens.ana, createdAt: now, lastSeen: now, ip: '::ffff:127.0.0.1' },
        [BIA]: { token: tokens.bia, createdAt: now, lastSeen: now, ip: '::ffff:127.0.0.1' },
    };
    db.memory.notes = {
        [ANA]: {
            geral: 'Nota geral da Ana',
            Ap_3: 'Nota do laboratório',
            Ap_1: 'Nota de redes',
            Ap_removida: 'Unidade que saiu do curso',
            Ap_2: '   ',
        },
        [BIA]: { geral: 'Da Bia', Ap_1: 'Bia em redes' },
    };
    db.memory.annotations = {
        [ANA]: {
            Ap_1: {
                p10: { highlightedText: 'Décimo parágrafo', note: 'depois', timestamp: '2026-11-20T10:00:00.000Z' },
                p2: { highlightedText: 'Segundo parágrafo', note: 'antes', timestamp: '2026-11-20T10:00:00.000Z' },
                p3: { highlightedText: null, note: null, timestamp: '2026-11-20T10:00:00.000Z' },
            },
            Ap_2: { p1: { highlightedText: 'Máscara /24', note: { velho: true }, timestamp: null } },
            Ap_removida: { p1: { highlightedText: 'some', note: 'some', timestamp: null } },
        },
        [BIA]: { Ap_1: { p1: { highlightedText: 'da Bia', note: 'da Bia', timestamp: null } } },
    };
    db.memory.auditLogs = [];
    delete db.memory.previewSessions;
}

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const memoryHash = () => sha256(JSON.stringify(db.memory));
// Aluno de verdade: a sessão (lastSeen) anda em toda rota do portal; o caderno não.
const notebookHash = () => sha256(JSON.stringify([db.memory.notes, db.memory.annotations, db.memory.courses, db.memory.auditLogs]));
const onlySessions = args => {
    const only = args[0] && Array.isArray(args[0].only) ? args[0].only : null;
    return !!only && only.every(name => name === 'sessions' || name === 'authSessions');
};

function spySaves() {
    const original = db.save;
    const calls = [];
    db.save = function spiedSave(...args) { calls.push(args); return original.apply(this, args); };
    return { calls, restore: () => { db.save = original; } };
}

test.before(async () => {
    await db.init();
    fs.mkdirSync(process.env.ICLASS_CONTENT_DIR, { recursive: true });
    for (const key of ['Ap_1', 'Ap_2', 'Ap_3']) fs.writeFileSync(path.join(process.env.ICLASS_CONTENT_DIR, `${key}.md`), `# ${key}\n\nTexto.\n`);
    app = createApp();
});
test.beforeEach(() => { seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 300));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// [UC-CADERNO-002] caderno para levar
// ---------------------------------------------------------------------------

test('[UC-CADERNO-002] notebook: nota geral e unidades da estrutura na ordem do curso, com título e módulo; só do próprio aluno; não grava', async () => {
    const spy = spySaves();
    const before = notebookHash();
    let response;
    try {
        response = await request(app).get(`/api/student/notebook?${Q}`).set('x-session-token', tokens.ana);
    } finally { spy.restore(); }
    assert.equal(response.status, 200, response.text);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.body.geral, 'Nota geral da Ana');
    // Ordem do curso (Ap_1, Ap_2, Ap_3), mesmo com as chaves gravadas fora de ordem; Ap_2
    // entra pelo destaque (a nota dela é só espaço); a unidade que saiu do curso não entra.
    assert.deepEqual(response.body.unidades.map(unit => unit.chave), ['Ap_1', 'Ap_2', 'Ap_3']);
    const [redes, enderecamento, laboratorio] = response.body.unidades;
    assert.deepEqual(redes, {
        chave: 'Ap_1',
        titulo: 'Redes <b>locais</b>',
        modulo: 'Fundamentos',
        nota: 'Nota de redes',
        // p2 antes de p10 (ordem do parágrafo, não do texto); p3 vazio fica de fora.
        destaques: [
            { paragrafo: 'p2', trecho: 'Segundo parágrafo', nota: 'antes' },
            { paragrafo: 'p10', trecho: 'Décimo parágrafo', nota: 'depois' },
        ],
    });
    // Nota antiga gravada como objeto vem como texto (sem "[object Object]").
    assert.deepEqual(enderecamento.destaques, [{ paragrafo: 'p1', trecho: 'Máscara /24', nota: '{"velho":true}' }]);
    assert.equal(enderecamento.nota, '   ');
    assert.equal(laboratorio.modulo, 'Prática');
    assert.deepEqual(laboratorio.destaques, []);
    // Nada da Bia (outro aluno, mesma chave Ap_1) e nada da unidade fora da estrutura.
    assert.doesNotMatch(response.text, /Bia|removida|some/);
    assert.equal(response.body.anteriores, undefined);
    assert.equal(notebookHash(), before, 'a leitura não muda o caderno nem as anotações');
    assert.equal(spy.calls.filter(args => !onlySessions(args)).length, 0, 'a leitura não grava (só a sessão do aluno, como em toda rota do portal)');
});

test('[UC-CADERNO-002] notebook pede a sessão e a matrícula na turma pedida', async () => {
    const noSession = await request(app).get(`/api/student/notebook?${Q}`);
    assert.ok([400, 401].includes(noSession.status), `sem sessão: ${noSession.status}`);
    assert.doesNotMatch(noSession.text, /Ana|redes/);
    const otherClass = await request(app).get(`/api/student/notebook?${Q}`).set('x-session-token', tokens.bia);
    assert.equal(otherClass.status, 403);
    assert.doesNotMatch(otherClass.text, /Ana/);
    const missing = await request(app).get('/api/student/notebook').set('x-session-token', tokens.ana);
    assert.equal(missing.status, 403);
    db.memory.courses[0].deleted = true;
    const deleted = await request(app).get(`/api/student/notebook?${Q}`).set('x-session-token', tokens.ana);
    assert.equal(deleted.status, 403);
});

test('[UC-CADERNO-002] caderno sem nada: geral vazio e nenhuma unidade; caderno num formato antigo vai em anteriores sem regravar', async () => {
    db.memory.notes = {};
    db.memory.annotations = {};
    const empty = await request(app).get(`/api/student/notebook?${Q}`).set('x-session-token', tokens.ana);
    assert.equal(empty.status, 200);
    assert.deepEqual({ geral: empty.body.geral, unidades: empty.body.unidades }, { geral: '', unidades: [] });

    // Banco mexido à mão ou de versão muito antiga: o caderno era um texto e as anotações,
    // uma lista. Nada some do caderno, e nada é gravado na leitura.
    db.memory.notes = { [ANA]: 'Caderno antigo inteiro' };
    db.memory.annotations = { [ANA]: ['lista', 'antiga'] };
    const before = notebookHash();
    const legacy = await request(app).get(`/api/student/notebook?${Q}`).set('x-session-token', tokens.ana);
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.geral, '');
    assert.deepEqual(legacy.body.unidades, []);
    assert.equal(legacy.body.anteriores.nota, 'Caderno antigo inteiro');
    assert.equal(legacy.body.anteriores.destaques.length, 1);
    assert.match(legacy.body.anteriores.destaques[0].nota, /lista/);
    assert.equal(notebookHash(), before);
    assert.equal(typeof db.memory.notes[ANA], 'string', 'o formato antigo continua como estava');
});

test('[UC-CADERNO-002] buildNotebook: estrutura estranha não derruba e chave herdada nunca é lida', () => {
    const notes = { 'a@x': { constructor: 'x', Ap_1: 'um' } };
    const structure = [null, 'texto', { name: 'M', items: [{ name: 'U', key: 'Ap_1' }, { name: 'Dup', apostilaKey: 'Ap_1' }, { name: 'Herdada', apostilaKey: 'constructor' }, null] }];
    const notebook = buildNotebook(notes, {}, 'a@x', structure);
    assert.deepEqual(notebook.unidades, [{ chave: 'Ap_1', titulo: 'U', modulo: 'M', nota: 'um', destaques: [] }]);
    assert.deepEqual(buildNotebook(null, null, 'a@x', null), { geral: '', unidades: [] });
});

test('[UC-CADERNO-002] na pré-visualização o caderno volta vazio e nada grava', async () => {
    const opened = await request(app).post('/api/admin/preview-sessions').set('x-admin-session', tokens.prof).send({ courseId: COURSE, studentClass: CLASS });
    assert.equal(opened.status, 200, opened.text);
    const spy = spySaves();
    const before = memoryHash();
    let response;
    try {
        response = await request(app).get(`/api/student/notebook?${Q}`).set('x-preview-session', opened.body.previewToken);
    } finally { spy.restore(); }
    assert.equal(response.status, 200, response.text);
    assert.deepEqual({ geral: response.body.geral, unidades: response.body.unidades }, { geral: '', unidades: [] });
    assert.equal(memoryHash(), before);
    assert.equal(spy.calls.length, 0);
});

// ---------------------------------------------------------------------------
// [UC-CONTEUDO-002] permitirImpressao
// ---------------------------------------------------------------------------

function courseDataOf(text) {
    return JSON.parse(String(text).replace(/^const courseData = /, '').replace(/;\s*$/, ''));
}

test('[UC-CONTEUDO-002] data.js do aluno: curso sem o campo (de antes desta versão) imprime; false desliga', async () => {
    const legacy = await request(app).get(`/api/data.js?${Q}`).set('x-session-token', tokens.ana);
    assert.equal(legacy.status, 200, legacy.text);
    assert.equal(courseDataOf(legacy.text).courses[0].permitirImpressao, true);
    assert.equal('permitirImpressao' in db.memory.courses[0], false, 'nada é gravado no curso antigo');

    db.memory.courses[0].permitirImpressao = false;
    const off = await request(app).get(`/api/data.js?${Q}`).set('x-session-token', tokens.ana);
    assert.equal(courseDataOf(off.text).courses[0].permitirImpressao, false);
});

test('[UC-CONTEUDO-002] PUT do curso grava permitirImpressao (booleano) com auditoria; valor igual não grava; outro tipo é recusado', async () => {
    const off = await request(app).put(`/api/admin/courses/${COURSE}`).set('x-admin-session', tokens.admin).send({ permitirImpressao: false });
    assert.equal(off.status, 200, off.text);
    assert.equal(off.body.course.permitirImpressao, false);
    assert.equal(db.memory.courses[0].permitirImpressao, false);
    const audit = db.memory.auditLogs.filter(entry => entry.action === 'course_updated');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].before.permitirImpressao, true);
    assert.equal(audit[0].after.permitirImpressao, false);

    const same = await request(app).put(`/api/admin/courses/${COURSE}`).set('x-admin-session', tokens.admin).send({ permitirImpressao: false, name: 'Desenvolvimento' });
    assert.equal(same.status, 200);
    assert.equal(db.memory.auditLogs.filter(entry => entry.action === 'course_updated').length, 1, 'sem mudança, sem auditoria');

    for (const value of ['false', 0, null, {}]) {
        const bad = await request(app).put(`/api/admin/courses/${COURSE}`).set('x-admin-session', tokens.admin).send({ permitirImpressao: value });
        assert.equal(bad.status, 400, `valor ${JSON.stringify(value)}`);
        assert.equal(bad.body.field, 'permitirImpressao');
    }
    assert.equal(db.memory.courses[0].permitirImpressao, false);

    const on = await request(app).put(`/api/admin/courses/${COURSE}`).set('x-admin-session', tokens.admin).send({ permitirImpressao: true });
    assert.equal(on.status, 200);
    assert.equal(db.memory.courses[0].permitirImpressao, true);
    assert.equal(db.memory.auditLogs.filter(entry => entry.action === 'course_updated').length, 2);

    // Curso que nunca teve o campo: "ligar" não é mudança (ausente já vale true).
    delete db.memory.courses[0].permitirImpressao;
    db.memory.auditLogs = [];
    await request(app).put(`/api/admin/courses/${COURSE}`).set('x-admin-session', tokens.admin).send({ permitirImpressao: true });
    assert.equal(db.memory.auditLogs.length, 0);
    assert.equal('permitirImpressao' in db.memory.courses[0], false);
});

test('[UC-CONTEUDO-002] POST do curso aceita permitirImpressao e o curso novo sem o campo imprime', async () => {
    const created = await request(app).post('/api/admin/courses').set('x-admin-session', tokens.admin)
        .send({ id: 'SEMPDF', name: 'Sem PDF', schoolId: 'escola_a', permitirImpressao: false });
    assert.equal(created.status, 200, created.text);
    assert.equal(created.body.course.permitirImpressao, false);
    const plain = await request(app).post('/api/admin/courses').set('x-admin-session', tokens.admin)
        .send({ id: 'COMPDF', name: 'Com PDF', schoolId: 'escola_a' });
    assert.equal(plain.status, 200);
    assert.equal('permitirImpressao' in plain.body.course, false);
    const bad = await request(app).post('/api/admin/courses').set('x-admin-session', tokens.admin)
        .send({ id: 'RUIM', name: 'Ruim', schoolId: 'escola_a', permitirImpressao: 'sim' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.field, 'permitirImpressao');
    assert.equal(db.memory.courses.some(course => course.id === 'RUIM'), false);
});
