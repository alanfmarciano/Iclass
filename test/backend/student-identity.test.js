// Identidade do aluno (fase 3, C1 / P4-S3: CRIT-05; D21, D22 e D23 do P4). Antes o
// cadastro do aluno não tinha id (o e-mail era a chave de tudo), o login aceitava só o
// e-mail, o aluno sem e-mail não podia ser cadastrado e as telas abriam a ficha com o
// e-mail no endereço. Agora:
// - todo aluno tem students[].id ('alu_' + 16 hex), dado pela migração
//   '2026-11-p4-ids-alunos' e conferido em todo boot e depois de toda restauração
//   (BOOT_NORMALIZATIONS); ao restaurar um backup sem ids, o aluno reaproveita o id que o
//   mesmo e-mail tinha antes e os registros das coleções novas são religados pelo e-mail;
// - o login e o "Esqueci a senha" aceitam a matrícula;
// - o aluno sem e-mail ganha o endereço interno aluno-<id>@sem-email.invalid, que nunca
//   aparece em CSV, boletim, auditoria exportada nem Meus dados;
// - GET /api/admin/students/by-id/:id e o aviso de matrícula repetida.
// Os boots rodam em processos próprios (fixtures/schema-boot-child.js) sobre cópias de
// fixtures/banco-281029f.db; as rotas, num app em memória.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-student-identity-test-'));
process.env.ICLASS_DATA_DIR = path.join(tempRoot, 'app-data');
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'app-content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'app-archives');
process.env.TEST_MODE = '1';
fs.mkdirSync(process.env.ICLASS_DATA_DIR, { recursive: true });

const proc = require('./fixtures/server-process.js');
const identity = require('../../backend/utils/studentIdentity.js');
const studentData = require('../../backend/utils/studentDataHandlers.js');
const { validateStudentFields } = require('../../backend/utils/students.js');
const { MIGRATIONS, BOOT_NORMALIZATIONS } = require('../../backend/migrations/index.js');

const fixtureDb = path.join(__dirname, 'fixtures', 'banco-281029f.db');
const childScript = path.join(__dirname, 'fixtures', 'schema-boot-child.js');
const cli = path.join(__dirname, '..', '..', 'backend', 'scripts', 'backup-cli.js');
const handlersRoot = path.join(__dirname, '..', '..', 'backend', 'utils', 'studentDataHandlers.js');

test.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

// ------------------------------------------------------------ funções puras
test('[UC-IDENT-001] ensureStudentIds dá id a todo aluno (inclusive anonimizado), não troca o que existe e rodar de novo não muda nada', () => {
    const memory = {
        students: [
            { email: 'ana@x.local', name: 'Ana' },
            { email: 'bia@x.local', name: 'Bia', id: 'alu_00000000000000b1' },
            { email: 'anon@anonimizado.invalid', status: 'Anonimizado', anonymizedAt: 1 },
        ],
    };
    assert.equal(identity.ensureStudentIds(memory, {}), true);
    memory.students.forEach(student => assert.match(student.id, /^alu_[0-9a-f]{16}$/));
    assert.equal(memory.students[1].id, 'alu_00000000000000b1');
    assert.equal(new Set(memory.students.map(student => student.id)).size, 3);
    const snapshot = JSON.stringify(memory);
    assert.equal(identity.ensureStudentIds(memory, {}), false);
    assert.equal(JSON.stringify(memory), snapshot);
});

test('[UC-IDENT-001] ensureStudentIds reaproveita o id de antes do mesmo e-mail, só cria id para aluno novo e desfaz id repetido', () => {
    const previous = new Map([['ana@x.local', 'alu_00000000000000a1'], ['caio@x.local', 'alu_00000000000000c1']]);
    const memory = {
        students: [
            { email: 'ANA@x.local' },
            { email: 'bia@x.local', id: 'alu_00000000000000b1' },
            { email: 'dup@x.local', id: 'alu_00000000000000b1' },
            { email: 'novo@x.local' },
            // O id de antes deste e-mail já é de outro cadastro no backup: ganha um novo.
            { email: 'caio@x.local' },
            { email: 'outro@x.local', id: 'alu_00000000000000c1' },
        ],
    };
    assert.equal(identity.ensureStudentIds(memory, { previousStudentIds: previous }), true);
    const byEmail = Object.fromEntries(memory.students.map(student => [student.email.toLowerCase(), student.id]));
    assert.equal(byEmail['ana@x.local'], 'alu_00000000000000a1', 'o id de antes do mesmo e-mail volta');
    assert.equal(byEmail['bia@x.local'], 'alu_00000000000000b1', 'o id do backup fica');
    assert.equal(byEmail['outro@x.local'], 'alu_00000000000000c1');
    assert.notEqual(byEmail['dup@x.local'], 'alu_00000000000000b1', 'id repetido ganha um novo');
    assert.notEqual(byEmail['caio@x.local'], 'alu_00000000000000c1');
    assert.ok(![...previous.values()].includes(byEmail['novo@x.local']), 'aluno novo não pega id de outro');
    assert.equal(new Set(memory.students.map(student => student.id)).size, memory.students.length);
    // Objeto simples também vale como mapa (contexto vindo de JSON).
    const plain = { students: [{ email: 'ana@x.local' }] };
    identity.ensureStudentIds(plain, { previousStudentIds: { 'ANA@x.local': 'alu_00000000000000a1' } });
    assert.equal(plain.students[0].id, 'alu_00000000000000a1');
});

test('[UC-IDENT-001] ensureStudentIds religa pelo e-mail os registros das coleções novas cujo studentId não resolve (handler.relink)', () => {
    const remove = studentData.registerStudentDataHandler({
        collection: 'colecaoDeTeste',
        label: 'Coleção de teste',
        relink: (memory, ids) => studentData.relinkRecordsByEmail(memory, memory.colecaoDeTeste, ids),
    });
    try {
        const memory = {
            students: [{ email: 'ana@x.local' }, { email: 'bia@x.local', id: 'alu_00000000000000b1' }],
            colecaoDeTeste: [
                { id: 'r1', studentEmail: 'ana@x.local', studentId: 'alu_0000000000000old' },
                { id: 'r2', studentEmail: 'bia@x.local', studentId: 'alu_00000000000000b1' },
                { id: 'r3', studentEmail: 'bia@x.local', studentId: null },
                { id: 'r4', studentEmail: 'fora@x.local', studentId: 'alu_00000000000000f1' },
            ],
        };
        assert.equal(identity.ensureStudentIds(memory, {}), true);
        const ana = memory.students[0].id;
        assert.deepEqual(memory.colecaoDeTeste.map(record => record.studentId), [ana, 'alu_00000000000000b1', 'alu_00000000000000b1', 'alu_00000000000000f1']);
        assert.equal(identity.ensureStudentIds(memory, {}), false);
    } finally {
        remove();
    }
});

test('[UC-IDENT-001] registro: a migração 2026-11-p4-ids-alunos e a normalização de todo boot chamam ensureStudentIds', () => {
    const row = MIGRATIONS.find(item => item.id === '2026-11-p4-ids-alunos');
    assert.ok(row);
    assert.equal(row.tipo, 'memoria');
    const normalization = BOOT_NORMALIZATIONS.find(item => item.id === '2026-11-p4-ids-alunos-sempre');
    assert.ok(normalization);
    [row, normalization].forEach(item => {
        const memory = { students: [{ email: 'ana@x.local' }] };
        assert.equal(item.run(memory, { previousStudentIds: new Map([['ana@x.local', 'alu_00000000000000a1']]) }), true);
        assert.equal(memory.students[0].id, 'alu_00000000000000a1');
        assert.equal(item.run(memory, { previousStudentIds: new Map() }), false);
    });
});

test('[UC-IDENT-002] resolveStudentLogin: matrícula com espaços e maiúsculas acha a conta; repetida, inexistente ou de anonimizado não acha nenhuma', () => {
    const memory = {
        students: [
            { email: 'ana@x.local', matricula: '2024 001' },
            { email: 'bia@x.local', matricula: 'ab-7' },
            { email: 'caio@x.local', matricula: 'AB-7' },
            { email: 'anon@anonimizado.invalid', matricula: '999', status: 'Anonimizado' },
            { email: 'aluno-alu_00000000000000e1@sem-email.invalid', matricula: '555', semEmail: true },
        ],
    };
    assert.deepEqual(identity.resolveStudentLogin(memory, ' 2024001 ').login, 'ana@x.local');
    assert.equal(identity.resolveStudentLogin(memory, '2024 001').via, 'matricula');
    assert.equal(identity.resolveStudentLogin(memory, '555').login, 'aluno-alu_00000000000000e1@sem-email.invalid');
    assert.equal(identity.resolveStudentLogin(memory, 'Ana@X.local').login, 'Ana@X.local', 'com @ é o e-mail, como sempre');
    assert.equal(identity.resolveStudentLogin(memory, 'Ana@X.local').via, 'email');
    ['ab-7', '999', '123'].forEach(text => {
        const resolved = identity.resolveStudentLogin(memory, text);
        assert.equal(resolved.student, null, text);
        assert.equal(resolved.login, text, 'segue como veio: nenhuma conta tem esse e-mail');
    });
    assert.deepEqual([...identity.duplicateMatriculas(memory)], ['ab-7']);
});

test('[UC-IDENT-003] endereço interno do aluno sem e-mail: formato, publicStudentEmail, máscara em texto e em objeto; ninguém o digita', () => {
    const email = identity.placeholderEmail('alu_00000000000000e1');
    assert.equal(email, 'aluno-alu_00000000000000e1@sem-email.invalid');
    assert.equal(identity.isPlaceholderEmail(email.toUpperCase()), true);
    assert.equal(identity.isPlaceholderEmail('ana@x.local'), false);
    assert.equal(identity.publicStudentEmail({ email }), 'sem e-mail');
    assert.equal(identity.publicStudentEmail(email), 'sem e-mail');
    assert.equal(identity.publicStudentEmail({ email: 'Ana@X.local' }), 'ana@x.local');
    assert.equal(identity.maskPlaceholderEmails(`Ana (${email}); outro`), 'Ana (sem e-mail); outro');
    const masked = identity.maskPlaceholderEmailsDeep({ profile: { email }, lista: [email, 3], [email]: { ok: true } });
    assert.deepEqual(masked, { profile: { email: 'sem e-mail' }, lista: ['sem e-mail', 3], 'sem e-mail': { ok: true } });
    // Autocadastro e cadastro pelo painel não aceitam um endereço desse domínio digitado.
    assert.equal(validateStudentFields({ email: 'eu@sem-email.invalid' }, [], null).ok, false);
    assert.equal(validateStudentFields({ email }, [], null, { allowPlaceholder: true }).ok, true);
    // Matrícula repetida comparada como o login compara (sem espaços, sem maiúsculas).
    const students = [{ email: 'ana@x.local', matricula: 'AB 7' }, { email: 'bia@x.local', matricula: '9' }, { email: 'caio@x.local', matricula: '9' }];
    assert.equal(validateStudentFields({ matricula: 'ab7' }, students, null).field, 'matricula');
    // Cadastro antigo com matrícula repetida continua editável sem mudar a matrícula.
    assert.equal(validateStudentFields({ matricula: '9' }, students, 'bia@x.local').ok, true);
});

// ------------------------------------------------------------ boots sobre o banco 281029f
let dirCounter = 0;
function newDataDir(name) {
    dirCounter += 1;
    const root = path.join(tempRoot, `${name}-${dirCounter}`);
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'content'), { recursive: true });
    fs.copyFileSync(fixtureDb, path.join(dataDir, 'database.db'));
    return { root, dataDir, dbFile: path.join(dataDir, 'database.db'), backupsDir: path.join(dataDir, 'backups') };
}

// Pré-carga dos filhos: um handler de teste na coleção assignmentSubmissions que religa
// pelo e-mail (como o das entregas do P1 vai fazer).
function writeRelinkPreload(root) {
    const file = path.join(root, 'religar-entregas.js');
    fs.writeFileSync(file, `const handlers = require(${JSON.stringify(handlersRoot)});
handlers.registerStudentDataHandler({
    collection: 'assignmentSubmissions',
    label: 'Entregas (teste)',
    relink: (memory, ids) => handlers.relinkRecordsByEmail(memory, memory.assignmentSubmissions, ids),
});
`);
    return file;
}

function envFor(dataDir, { port = 1, preload } = {}) {
    const env = {
        ...process.env,
        ICLASS_DATA_DIR: dataDir,
        ICLASS_CONTENT_DIR: path.join(path.dirname(dataDir), 'content'),
        ICLASS_ARCHIVE_DIR: path.join(path.dirname(dataDir), 'arquivados'),
        TEST_MODE: '1',
        PORT: String(port),
    };
    delete env.NODE_TEST_CONTEXT;
    delete env.ICLASS_VERIFY_SAVES;
    delete env.ICLASS_ATUALIZAR_SEM_BACKUP;
    delete env.ICLASS_TEST_MIGRATIONS;
    if (preload) env.NODE_OPTIONS = `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ''}--require ${JSON.stringify(preload)}`;
    return env;
}

function bootOnce(dataDir, { scenario, argument, preload } = {}) {
    const args = [childScript];
    if (scenario) args.push(scenario);
    if (argument) args.push(argument);
    const result = spawnSync(process.execPath, args, { env: envFor(dataDir, { preload }), encoding: 'utf8', timeout: 90000, maxBuffer: 32 * 1024 * 1024 });
    const marker = String(result.stdout || '').lastIndexOf('@@');
    assert.notEqual(marker, -1, `${result.stdout}\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout.slice(marker + 2));
    assert.equal(result.status, 0, parsed.message);
    return parsed;
}

function runCli(dataDir, port, args, options = {}) {
    const result = spawnSync(process.execPath, [cli, ...args], { env: envFor(dataDir, { ...options, port }), encoding: 'utf8', input: '', timeout: 120000 });
    return { code: result.status, output: `${result.stdout}\n${result.stderr}` };
}

async function withDb(file, mode, fn) {
    const connection = await new Promise((resolve, reject) => {
        const handle = new sqlite3.Database(file, mode, err => (err ? reject(err) : resolve(handle)));
    });
    const all = (sql, params = []) => new Promise((resolve, reject) => connection.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
    const run = (sql, params = []) => new Promise((resolve, reject) => connection.run(sql, params, err => (err ? reject(err) : resolve())));
    try {
        return await fn({ all, run });
    } finally {
        await new Promise(resolve => connection.close(() => resolve()));
    }
}

async function studentRows(file) {
    return withDb(file, sqlite3.OPEN_READONLY, async ({ all }) => Object.fromEntries((await all('SELECT key, value FROM students ORDER BY key'))
        .map(row => [row.key, JSON.parse(row.value)])));
}

async function studentIdsOf(file) {
    return Object.fromEntries(Object.entries(await studentRows(file)).map(([key, value]) => [key, value.id || null]));
}

test('[UC-IDENT-001] banco 281029f: o primeiro boot dá id a todos os alunos (só o campo id muda), o segundo não grava e um aluno criado depois pela versão antiga ganha id no boot seguinte', async () => {
    const dir = newDataDir('boot');
    const before = await studentRows(dir.dbFile);
    assert.ok(Object.keys(before).length >= 10);
    assert.ok(Object.values(before).every(student => !student.id), 'a fixture é de antes do id');

    const first = bootOnce(dir.dataDir);
    assert.ok(first.info.aplicadasAgora.includes('2026-11-p4-ids-alunos'));
    const after = await studentRows(dir.dbFile);
    assert.deepEqual(Object.keys(after), Object.keys(before));
    Object.entries(after).forEach(([key, student]) => {
        assert.match(student.id, /^alu_[0-9a-f]{16}$/, key);
        const { id, ...rest } = student;
        assert.deepEqual(rest, before[key], `${key}: só o id muda no cadastro`);
    });
    assert.equal(new Set(Object.values(after).map(student => student.id)).size, Object.keys(after).length);
    assert.ok(first.schemaMeta.aplicadas.some(entry => entry.id === '2026-11-p4-ids-alunos'));

    const second = bootOnce(dir.dataDir);
    assert.deepEqual(second.info.aplicadasAgora, []);
    assert.equal(second.savesSinceBoot, 0, 'o segundo boot não grava');
    assert.deepEqual(await studentIdsOf(dir.dbFile), Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value.id])));

    // A versão 281029f abre o banco migrado (não recusa) e cadastra um aluno, sem id.
    await withDb(dir.dbFile, sqlite3.OPEN_READWRITE, async ({ run }) => {
        await run('INSERT INTO students (key, value) VALUES (?, ?)', ['novo@antiga.local', JSON.stringify({ name: 'Criado na 281029f', email: 'novo@antiga.local', status: 'Ativo', classes: [] })]);
    });
    const third = bootOnce(dir.dataDir);
    assert.deepEqual(third.info.aplicadasAgora, [], 'a migração não roda de novo: quem dá o id é a normalização de todo boot');
    const ids = await studentIdsOf(dir.dbFile);
    assert.match(ids['novo@antiga.local'], /^alu_[0-9a-f]{16}$/);
    Object.entries(after).forEach(([key, value]) => assert.equal(ids[key], value.id, `${key}: o id não muda`));
    const fourth = bootOnce(dir.dataDir);
    assert.equal(fourth.savesSinceBoot, 0);
});

test('[UC-IDENT-001] restaurar backup 281029f pela tela: o id do mesmo e-mail volta, aluno que não existia ganha um novo e o registro da coleção nova é religado pelo e-mail', async () => {
    const dir = newDataDir('restaurar-tela');
    const preload = writeRelinkPreload(dir.root);
    bootOnce(dir.dataDir, { preload });
    const [zip] = fs.readdirSync(dir.backupsDir).filter(name => /^pre-atualizacao_.+\.zip$/.test(name));
    assert.ok(zip);
    const idsBefore = await studentIdsOf(dir.dbFile);
    const emails = Object.keys(idsBefore);
    const [kept, removed] = emails;
    // Depois da atualização: um aluno sai do banco (o backup ainda o traz) e há uma entrega
    // da coleção nova com o studentId de um cadastro que não existe mais e outra com o id de
    // hoje.
    await withDb(dir.dbFile, sqlite3.OPEN_READWRITE, async ({ run }) => {
        await run('DELETE FROM students WHERE key = ?', [removed]);
        await run('INSERT INTO assignment_submissions (key, value) VALUES (?, ?)', ['asub_1', JSON.stringify({ id: 'asub_1', assignmentId: 'asg_1', studentEmail: kept, studentId: 'alu_ffffffffffffffff' })]);
        await run('INSERT INTO assignment_submissions (key, value) VALUES (?, ?)', ['asub_2', JSON.stringify({ id: 'asub_2', assignmentId: 'asg_1', studentEmail: emails[2], studentId: idsBefore[emails[2]] })]);
    });

    const restored = bootOnce(dir.dataDir, { scenario: 'restaurar', argument: path.join(dir.backupsDir, zip), preload });
    assert.equal(restored.restore.ok, true, restored.restore.message);
    const idsAfter = await studentIdsOf(dir.dbFile);
    emails.filter(email => email !== removed).forEach(email => assert.equal(idsAfter[email], idsBefore[email], `${email}: o id de antes volta`));
    assert.match(idsAfter[removed], /^alu_[0-9a-f]{16}$/);
    assert.notEqual(idsAfter[removed], idsBefore[removed], 'quem não estava no banco de antes ganha id novo');
    assert.equal(new Set(Object.values(idsAfter)).size, emails.length);
    const submissions = await withDb(dir.dbFile, sqlite3.OPEN_READONLY, async ({ all }) => Object.fromEntries((await all('SELECT key, value FROM assignment_submissions'))
        .map(row => [row.key, JSON.parse(row.value).studentId])));
    assert.deepEqual(submissions, { asub_1: idsAfter[kept], asub_2: idsBefore[emails[2]] }, 'a entrega fica e o studentId resolve');
    // O boot seguinte não troca nenhum id (a liberação das provas que ele zera não é daqui).
    bootOnce(dir.dataDir, { preload });
    assert.deepEqual(await studentIdsOf(dir.dbFile), idsAfter);
});

test('[UC-IDENT-001] restaurar backup 281029f pela backup-cli: os ids de antes (do banco que foi para a quarentena) voltam e a entrega é religada', async () => {
    const dir = newDataDir('restaurar-cli');
    const preload = writeRelinkPreload(dir.root);
    bootOnce(dir.dataDir, { preload });
    const [zip] = fs.readdirSync(dir.backupsDir).filter(name => /^pre-atualizacao_.+\.zip$/.test(name));
    const idsBefore = await studentIdsOf(dir.dbFile);
    const [first] = Object.keys(idsBefore);
    await withDb(dir.dbFile, sqlite3.OPEN_READWRITE, async ({ run }) => {
        await run('INSERT INTO assignment_submissions (key, value) VALUES (?, ?)', ['asub_1', JSON.stringify({ id: 'asub_1', assignmentId: 'asg_1', studentEmail: first, studentId: null })]);
    });
    const port = await proc.freePort();
    const restored = runCli(dir.dataDir, port, ['restaurar', path.join(dir.backupsDir, zip), '--sim'], { preload });
    assert.equal(restored.code, 0, restored.output);
    assert.deepEqual(await studentIdsOf(dir.dbFile), idsBefore, 'cada aluno do backup recebe o mesmo id de antes');
    const submission = await withDb(dir.dbFile, sqlite3.OPEN_READONLY, async ({ all }) => JSON.parse((await all("SELECT value FROM assignment_submissions WHERE key = 'asub_1'"))[0].value));
    assert.equal(submission.studentId, idsBefore[first]);
});

// ------------------------------------------------------------ rotas
const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const loginGuard = require('../../backend/utils/loginGuard.js');
const rateLimiter = require('../../backend/utils/rateLimit.js');

const ADMIN = { email: 'adm@ident.local', password: 'senha-adm-forte-1' };
const PROF = { email: 'prof@ident.local', password: 'senha-prof-forte-1' };
const OTHER_PROF = { email: 'outro@ident.local', password: 'senha-outro-forte-1' };
const STUDENT_PASSWORD = 'aluno-senha-forte-1';
let app;

function student(email, extra = {}) {
    return {
        email, name: email.split('@')[0], password: db.hashPassword(STUDENT_PASSWORD),
        classes: [{ name: '1DES', courseId: 'DES' }], studentClass: '1DES', status: 'Ativo', ...extra,
    };
}

function seed() {
    db.memory.config = { ...(db.memory.config || {}), settings: {} };
    db.memory.admins = [
        { email: ADMIN.email, name: 'Admin', role: 'admin', password: db.hashPassword(ADMIN.password) },
        { email: PROF.email, name: 'Professor', role: 'professor', password: db.hashPassword(PROF.password), assignedClasses: [{ courseId: 'DES', className: '1DES' }], assignedCourseIds: ['DES'] },
        { email: OTHER_PROF.email, name: 'Outro', role: 'professor', password: db.hashPassword(OTHER_PROF.password), assignedClasses: [{ courseId: 'ADM', className: '2ADM' }], assignedCourseIds: ['ADM'] },
    ];
    db.memory.students = [
        student('ana@ident.local', { id: 'alu_00000000000000a1', matricula: '2024 001' }),
        student('bia@ident.local', { id: 'alu_00000000000000b1', matricula: 'R 7' }),
        student('caio@ident.local', { id: 'alu_00000000000000c1', matricula: 'r7' }),
        student('duda@ident.local', { id: 'alu_00000000000000d1', matricula: 'X1', classes: [{ name: '2ADM', courseId: 'ADM' }], studentClass: '2ADM' }),
    ];
    db.memory.sessions = {};
    db.memory.adminSessions = {};
    db.memory.classes = [{ name: '1DES', courseId: 'DES' }, { name: '2ADM', courseId: 'ADM' }];
    db.memory.courses = [{ id: 'DES', name: 'Desenvolvimento' }, { id: 'ADM', name: 'Administração' }];
    db.memory.examApplications = [];
    db.memory.studentExamState = {};
    db.memory.submissions = [];
    db.memory.attendance = [];
    db.memory.loginLogs = [];
    db.memory.auditLogs = [];
}

async function adminToken(account = ADMIN) {
    const res = await request(app).post('/api/session/admin-login').send({ email: account.email, password: account.password }).expect(200);
    return res.body.sessionToken;
}

const studentLogin = (email, password = STUDENT_PASSWORD) => request(app).post('/api/student/login').send({ email, password });

test.describe('rotas', () => {
    test.before(async () => { await db.init(); app = createApp(); });
    test.beforeEach(() => {
        seed();
        loginGuard.resetForTests();
        rateLimiter.resetForTests();
    });

    test('[UC-IDENT-002] login por matrícula (com espaços e minúsculas) entra; matrícula repetida e inexistente dão o mesmo erro da senha errada; o atraso conta a conta achada', async () => {
        const ok = await studentLogin(' 2024001 ').expect(200);
        assert.equal(ok.body.success, true);
        assert.equal(ok.body.student.email, 'ana@ident.local');
        const wrong = await studentLogin('ana@ident.local', 'senha-errada-1').expect(401);
        const repeated = await studentLogin('r7').expect(401);
        const unknown = await studentLogin('99999').expect(401);
        assert.deepEqual(repeated.body, wrong.body);
        assert.deepEqual(unknown.body, wrong.body);
        // A senha errada pela matrícula conta no atraso da conta (a do e-mail).
        loginGuard.resetForTests();
        for (let i = 0; i < 6; i += 1) await studentLogin('2024001', 'senha-errada-1');
        const protection = loginGuard.protectionFor(loginGuard.accountKey('student', 'ana@ident.local'), Date.now());
        assert.ok(protection, 'o atraso progressivo ficou na conta da Ana');
    });

    test('[UC-IDENT-002] Esqueci a senha pela matrícula marca o pedido; repetida não marca ninguém; a resposta é sempre a mesma', async () => {
        const res = await request(app).post('/api/student/recover').send({ email: '2024001' }).expect(200);
        const none = await request(app).post('/api/student/recover').send({ email: 'r7' }).expect(200);
        assert.deepEqual(res.body, none.body);
        assert.equal(db.memory.students.find(item => item.email === 'ana@ident.local').recoveryRequested, true);
        assert.ok(!db.memory.students.find(item => item.email === 'bia@ident.local').recoveryRequested);
        assert.ok(!db.memory.students.find(item => item.email === 'caio@ident.local').recoveryRequested);
    });

    test('[UC-IDENT-003] aluno sem e-mail: create exige matrícula, grava o endereço interno com id, entra pela matrícula e o endereço não sai no CSV, no boletim nem em Meus dados', async () => {
        const token = await adminToken();
        const base = { name: 'Eva Sem Email', classes: [{ name: '1DES', courseId: 'DES' }], semEmail: true };
        const missing = await request(app).post('/api/admin/student/create').set('x-admin-session', token).send(base).expect(400);
        assert.equal(missing.body.field, 'matricula');
        assert.equal(missing.body.error, 'Para aluno sem e-mail, informe a matrícula.');
        const typed = await request(app).post('/api/admin/student/create').set('x-admin-session', token)
            .send({ ...base, semEmail: false, email: 'eva@sem-email.invalid' }).expect(400);
        assert.equal(typed.body.field, 'email');
        const created = await request(app).post('/api/admin/student/create').set('x-admin-session', token)
            .send({ ...base, matricula: '7070', studentPassword: 'Quadro-Verde-2024' }).expect(200);
        assert.match(created.body.id, /^alu_[0-9a-f]{16}$/);
        const eva = db.memory.students.find(item => item.id === created.body.id);
        assert.equal(eva.email, `aluno-${created.body.id}@sem-email.invalid`);
        assert.equal(eva.semEmail, true);

        // Login pela matrícula.
        const login = await studentLogin('7070', 'Quadro-Verde-2024').expect(200);
        assert.equal(login.body.student.email, eva.email);

        // Presença, quadro de notas, boletim, auditoria exportada e Meus dados.
        db.memory.attendance.push({ id: 'p1', studentEmail: eva.email, studentClass: '1DES', courseId: 'DES', date: '2026-11-10', status: 'presente' });
        const leaks = [];
        const check = (label, text) => { if (String(text).includes('sem-email.invalid')) leaks.push(label); };
        const attendance = await request(app).get('/api/admin/attendance/export?studentClass=1DES').set('x-admin-session', token).expect(200);
        check('presença', attendance.text);
        assert.match(attendance.text, /sem e-mail/);
        const gradebook = await request(app).get('/api/admin/gradebook?courseId=DES&studentClass=1DES&format=csv').set('x-admin-session', token).expect(200);
        check('quadro', gradebook.text);
        const report = await request(app).get(`/api/admin/student/report?email=${encodeURIComponent(eva.email)}`).set('x-admin-session', token).expect(200);
        check('boletim', JSON.stringify(report.body));
        assert.equal(report.body.student.email, 'sem e-mail');
        const audit = await request(app).get('/api/admin/audit/export').set('x-admin-session', token).expect(200);
        check('auditoria', audit.text);
        const exported = await request(app).get(`/api/admin/lgpd/students/export?email=${encodeURIComponent(eva.email)}&finalidade=baixar`).set('x-admin-session', token).expect(200);
        check('Meus dados (admin)', JSON.stringify(exported.body));
        assert.equal(exported.body.profile.email, 'sem e-mail');
        assert.deepEqual(leaks, []);

        // Ganhar um e-mail depois é a troca de e-mail de sempre.
        const updated = await request(app).post('/api/admin/student/update').set('x-admin-session', token).send({
            originalEmail: eva.email, name: 'Eva Sem Email', email: 'eva@ident.local', matricula: '7070', semEmail: false, classes: [{ name: '1DES', courseId: 'DES' }],
        }).expect(200);
        assert.equal(updated.body.success, true);
        const now = db.memory.students.find(item => item.id === created.body.id);
        assert.equal(now.email, 'eva@ident.local');
        assert.equal(now.semEmail, undefined);
        assert.ok(db.memory.attendance.some(item => item.id === 'p1' && item.studentEmail === 'eva@ident.local'));
        // E o caminho de volta: fica sem e-mail de novo (a matrícula continua obrigatória).
        await request(app).post('/api/admin/student/update').set('x-admin-session', token).send({
            originalEmail: 'eva@ident.local', name: 'Eva Sem Email', matricula: '', semEmail: true, classes: [{ name: '1DES', courseId: 'DES' }],
        }).expect(400);
        await request(app).post('/api/admin/student/update').set('x-admin-session', token).send({
            originalEmail: 'eva@ident.local', name: 'Eva Sem Email', matricula: '7070', semEmail: true, classes: [{ name: '1DES', courseId: 'DES' }],
        }).expect(200);
        assert.equal(db.memory.students.find(item => item.id === created.body.id).email, `aluno-${created.body.id}@sem-email.invalid`);
        const trail = db.memory.auditLogs.filter(entry => entry.field === 'E-mail/login').map(entry => [entry.oldValue, entry.newValue]);
        assert.deepEqual(trail, [['sem e-mail', 'eva@ident.local'], ['eva@ident.local', 'sem e-mail']]);
    });

    test('[UC-IDENT-001] aluno criado pelo painel nasce com id; GET /api/admin/students/by-id/:id com escopo; lista marca matrícula repetida', async () => {
        const token = await adminToken();
        const created = await request(app).post('/api/admin/student/create').set('x-admin-session', token)
            .send({ name: 'Fábio', email: 'fabio@ident.local', classes: [{ name: '1DES', courseId: 'DES' }] }).expect(200);
        assert.match(created.body.id, /^alu_[0-9a-f]{16}$/);
        assert.equal(db.memory.students.find(item => item.email === 'fabio@ident.local').id, created.body.id);

        const byId = await request(app).get(`/api/admin/students/by-id/${created.body.id}`).set('x-admin-session', token).expect(200);
        assert.equal(byId.body.email, 'fabio@ident.local');
        assert.equal(byId.body.password, undefined);
        await request(app).get('/api/admin/students/by-id/alu_ffffffffffffffff').set('x-admin-session', token).expect(404);

        const prof = await adminToken(PROF);
        await request(app).get('/api/admin/students/by-id/alu_00000000000000a1').set('x-admin-session', prof).expect(200);
        await request(app).get('/api/admin/students/by-id/alu_00000000000000d1').set('x-admin-session', prof).expect(403);

        const list = await request(app).get('/api/admin/students').set('x-admin-session', token).expect(200);
        const flagged = list.body.filter(item => item.matriculaRepetida).map(item => item.email).sort();
        assert.deepEqual(flagged, ['bia@ident.local', 'caio@ident.local']);
        assert.ok(list.body.every(item => typeof item.id === 'string' && item.id));
    });
});
