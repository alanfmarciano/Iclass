// Fase 3, B0a (FUN-13, P4-S1): papéis das contas do painel. Catálogo único em
// backend/utils/adminRoles.js (admin, professor, monitor = "Professor auxiliar",
// secretaria, coordenacao), guarda com somente leitura e escopo por papel. Antes, toda
// conta que não era professor virava superusuária (82 testes de isProfessorAccount).
// Matriz: para cada papel e cada rota de /api/admin, o guarda deixa passar exatamente as
// permissões do catálogo (regras de ADMIN_API_PERMISSION_RULES), também nas variantes de
// caminho que o Express entrega à mesma rota (outra caixa, barra no fim); a matriz ganha
// linha a cada rota nova (contrato C2 do P4).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const express = require('express');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-papeis-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { adminRbacGuard } = require('../../backend/middlewares.js');
const {
    ADMIN_PERMISSION_VALUES,
    getEffectiveAdminPermissions,
    hasAnyAdminPermission,
    resolveAdminApiPermission,
    rolePermissionDefaults,
} = require('../../backend/utils/adminPermissions.js');
const {
    ROLE_CATALOG,
    READ_ONLY_EXCEPTIONS,
    isFullAdmin,
    accountScopeKind,
    isReadOnlyAccount,
} = require('../../backend/utils/adminRoles.js');

const ROOT = path.join(__dirname, '..', '..');
const ROUTES_DIR = path.join(ROOT, 'backend', 'routes');
let app;
let guardApp;

const SCHOOL_A = 'escola_a';
const SCHOOL_B = 'escola_b';
const COURSE_A = 'curso_a';
const COURSE_B = 'curso_b';
const ACCOUNTS = {
    admin: { email: 'admin@papeis.local', role: 'admin' },
    legado: { email: 'legado@papeis.local' },
    professor: { email: 'prof@papeis.local', role: 'professor', assignedClasses: [{ courseId: COURSE_A, className: '1A' }] },
    monitor: { email: 'monitor@papeis.local', role: 'monitor', assignedClasses: [{ courseId: COURSE_A, className: '1A' }] },
    secretaria: { email: 'secretaria@papeis.local', role: 'secretaria', assignedSchoolIds: [SCHOOL_A] },
    coordenacao: { email: 'coord@papeis.local', role: 'coordenacao', assignedSchoolIds: [SCHOOL_A] },
    semEscola: { email: 'sem-escola@papeis.local', role: 'secretaria', assignedSchoolIds: [] },
    desconhecido: { email: 'diretor@papeis.local', role: 'diretor' },
};
const token = name => `token-papeis-${name}`;
const as = (name, req) => req.set('x-admin-session', token(name));

function seed() {
    db.memory.schools = [{ id: SCHOOL_A, name: 'Escola A' }, { id: SCHOOL_B, name: 'Escola B' }];
    db.memory.courses = [
        { id: COURSE_A, name: 'Curso A', schoolId: SCHOOL_A, structure: [] },
        { id: COURSE_B, name: 'Curso B', schoolId: SCHOOL_B, structure: [] },
    ];
    db.memory.classes = [
        { name: '1A', courseId: COURSE_A, period: 'Manhã', onlineExamConfigs: {} },
        { name: '1B', courseId: COURSE_B, period: 'Tarde', onlineExamConfigs: {} },
    ];
    db.memory.students = [
        { name: 'Ana', email: 'ana@papeis.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1A', courseId: COURSE_A }], studentClass: '1A', accessibility: { tempoExtraMin: 10, observacao: 'Laudo médico' } },
        { name: 'Bia', email: 'bia@papeis.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1B', courseId: COURSE_B }], studentClass: '1B' },
    ];
    db.memory.admins = Object.entries(ACCOUNTS).map(([name, account]) => ({
        name: `Conta ${name}`,
        password: db.hashPassword('Senha-forte-2026'),
        assignedClasses: [],
        assignedSchoolIds: [],
        assignedCourseIds: [],
        additionalPermissions: [],
        ...account,
    }));
    db.memory.adminSessions = Object.fromEntries(Object.entries(ACCOUNTS).map(([name, account]) => [
        token(name), { email: account.email, createdAt: Date.now(), lastSeen: Date.now() },
    ]));
    db.memory.sessions = {};
    db.memory.forum = [];
    db.memory.pedagogicalObservations = [];
    db.memory.enrollmentRequests = [];
    db.memory.certificates = [];
    db.memory.auditLogs = [];
}

const account = name => db.memory.admins.find(item => item.email === ACCOUNTS[name].email);

test.before(async () => {
    await db.init();
    app = createApp();
    // Só o guarda: o que passa recebe 200 { passou: true } e nada roda depois dele.
    guardApp = express();
    guardApp.use(express.json());
    guardApp.use('/api/admin', adminRbacGuard);
    guardApp.use((req, res) => res.json({ passou: true }));
});
test.beforeEach(() => { seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

// Toda rota /api/admin declarada em backend/routes (como em admin-rbac-catalog.test.js).
function adminRoutes() {
    const routes = [];
    for (const filename of fs.readdirSync(ROUTES_DIR).filter(name => name.endsWith('.js'))) {
        const source = fs.readFileSync(path.join(ROUTES_DIR, filename), 'utf8');
        const routePattern = /router\.(get|post|put|delete)\(\s*['"](\/api\/admin[^'"]*)['"]/g;
        let match;
        while ((match = routePattern.exec(source))) {
            routes.push({ method: match[1].toUpperCase(), route: match[2], file: filename });
        }
    }
    return routes;
}

const PERMISSION_REFUSALS = new Set([
    'Sua conta não possui permissão para esta operação.',
    'Esta operação administrativa não está liberada para professores.',
    'Esta operação administrativa é só do administrador.',
]);

// O que o catálogo diz para a conta nesta rota: 'leitura' (403 read_only_account),
// 'permissao' (403 do guarda) ou 'passa' (o guarda deixa seguir; o escopo da turma
// ainda pode recusar um caminho de exemplo).
function expectedDecision(acc, method, route) {
    const fullPath = route.replace(/:[^/]+/g, 'example');
    if (isReadOnlyAccount(acc) && !['GET', 'HEAD', 'OPTIONS'].includes(method) && !READ_ONLY_EXCEPTIONS.includes(fullPath)) return 'leitura';
    const permission = resolveAdminApiPermission(method, fullPath.replace('/api/admin', '') || '/');
    if (permission === undefined) return isFullAdmin(acc) ? 'passa' : 'permissao';
    return hasAnyAdminPermission(getEffectiveAdminPermissions(acc), permission) ? 'passa' : 'permissao';
}

async function guardDecision(name, method, route) {
    const fullPath = route.replace(/:[^/]+/g, 'example');
    const res = await as(name, request(guardApp)[method.toLowerCase()](fullPath)).send({});
    if (res.status === 200 && res.body.passou) return 'passa';
    if (res.status === 403 && res.body.code === 'read_only_account') return 'leitura';
    if (res.status === 403 && PERMISSION_REFUSALS.has(res.body.error)) return 'permissao';
    // Recusa de escopo (turma, curso ou aluno do caminho de exemplo): o papel passou no
    // guarda de permissão.
    if (res.status === 403) return 'passa';
    return `inesperado ${res.status} ${JSON.stringify(res.body)}`;
}

test('[UC-PAPEIS-001] matriz: para cada papel e cada rota de /api/admin, o guarda decide pelo catálogo', async () => {
    const routes = adminRoutes();
    assert.ok(routes.length > 150, `rotas encontradas: ${routes.length}`);
    const wrong = [];
    const tally = {};
    for (const name of ['admin', 'legado', 'professor', 'monitor', 'secretaria', 'coordenacao', 'desconhecido']) {
        const acc = account(name);
        tally[name] = { passa: 0, permissao: 0, leitura: 0, postPassa: [] };
        for (const { method, route, file } of routes) {
            const expected = expectedDecision(acc, method, route);
            const got = await guardDecision(name, method, route);
            if (got !== expected) wrong.push(`${name} ${method} ${route} (${file}): esperado ${expected}, veio ${got}`);
            if (tally[name][got] !== undefined) tally[name][got] += 1;
            if (got === 'passa' && method !== 'GET') tally[name].postPassa.push(route);
        }
    }
    assert.deepEqual(wrong, [], wrong.slice(0, 40).join('\n'));
    // O administrador (e a conta antiga sem papel) passa em tudo; o papel desconhecido em nada.
    assert.equal(tally.admin.permissao + tally.admin.leitura, 0);
    assert.equal(tally.legado.permissao + tally.legado.leitura, 0);
    assert.equal(tally.desconhecido.passa, 0);
    // A coordenação não grava nada além do autoatendimento.
    assert.ok(tally.coordenacao.leitura > 50, `recusas de somente leitura: ${tally.coordenacao.leitura}`);
    assert.deepEqual(tally.coordenacao.postPassa.filter(route => !READ_ONLY_EXCEPTIONS.includes(route)), []);
    // A secretaria fica no meio: nem tudo, nem nada.
    assert.ok(tally.secretaria.passa > 10 && tally.secretaria.permissao > 50, JSON.stringify(tally.secretaria));
});

test('[UC-PAPEIS-001] secretaria: alunos, matrícula e certificados sim; backup, restauração, sala, identidade, provas, Monitor, editor e contas não', async () => {
    const denied = [
        ['GET', '/api/admin/backup/status'], ['POST', '/api/admin/backup/restore'], ['POST', '/api/admin/reset'],
        ['POST', '/api/admin/flush-exam-state'], ['POST', '/api/admin/schools/create'], ['POST', '/api/admin/exam-config'],
        ['GET', '/api/admin/exam-applications'], ['GET', '/api/admin/monitor-status/1A/prova'], ['POST', '/api/admin/server-exam-control'],
        ['GET', '/api/admin/material/apostila'], ['POST', '/api/admin/upload'], ['GET', '/api/admin/accounts'], ['POST', '/api/admin/accounts/create'],
        ['GET', '/api/admin/audit'], ['GET', '/api/admin/students/closed'], ['GET', '/api/admin/lgpd/documents'], ['GET', '/api/admin/settings'],
    ];
    for (const [method, url] of denied) {
        assert.equal(await guardDecision('secretaria', method, url), 'permissao', `${method} ${url}`);
    }
    for (const [method, url] of [['GET', '/api/admin/students'], ['POST', '/api/admin/student/create'], ['POST', '/api/admin/student/certificates/issue'], ['GET', '/api/admin/classes'], ['GET', '/api/admin/attendance']]) {
        assert.equal(await guardDecision('secretaria', method, url), 'passa', `${method} ${url}`);
    }
    // Identidade visual fica fora de /api/admin (POST /api/branding): branding.manage.
    const branding = await as('secretaria', request(app).post('/api/branding')).send({ displayName: 'Outra' });
    assert.equal(branding.status, 403);
});

test('[UC-PAPEIS-001] professor auxiliar: chamada e Monitor; sem notas, provas, conteúdo nem contas', async () => {
    for (const [method, url] of [['GET', '/api/admin/attendance'], ['POST', '/api/admin/attendance/bulk'], ['POST', '/api/admin/server-exam-control'], ['GET', '/api/admin/classes']]) {
        assert.equal(await guardDecision('monitor', method, url), 'passa', `${method} ${url}`);
    }
    for (const [method, url] of [['GET', '/api/admin/gradebook'], ['GET', '/api/admin/submissions'], ['POST', '/api/admin/exam-config'], ['GET', '/api/admin/material/apostila'], ['POST', '/api/admin/release-item'], ['GET', '/api/admin/accounts'], ['POST', '/api/admin/announcements']]) {
        assert.equal(await guardDecision('monitor', method, url), 'permissao', `${method} ${url}`);
    }
});

test('[UC-PAPEIS-001] alterar cadastro de aluno pede students.edit: o professor auxiliar vê a ficha e faz a chamada, mas não cria, altera nem redefine senha; o professor continua', async () => {
    // Antes a regra /student(/.*) inteira era page.students: o professor auxiliar mudava
    // o nome do aluno, criava aluno e redefinia senha (D16 do P4).
    const writes = [
        ['POST', '/api/admin/student/create'], ['POST', '/api/admin/student/update'], ['POST', '/api/admin/student/bulk-enroll'],
        ['POST', '/api/admin/student/bulk-status'], ['POST', '/api/admin/reset-password'],
    ];
    for (const [method, url] of writes) {
        assert.equal(resolveAdminApiPermission(method, url.replace('/api/admin', '')), 'students.edit', url);
        assert.equal(await guardDecision('monitor', method, url), 'permissao', `monitor ${url}`);
        assert.equal(await guardDecision('professor', method, url), 'passa', `professor ${url}`);
        assert.equal(await guardDecision('secretaria', method, url), 'passa', `secretaria ${url}`);
    }
    // Ver e fazer chamada continua com page.students.
    for (const [method, url] of [['GET', '/api/admin/students'], ['GET', '/api/admin/student/observations'], ['POST', '/api/admin/student/attendance/mark'], ['POST', '/api/admin/student/observations/create'], ['POST', '/api/admin/attendance/bulk']]) {
        assert.equal(await guardDecision('monitor', method, url), 'passa', `monitor ${url}`);
    }
    assert.equal(getEffectiveAdminPermissions(account('monitor')).has('students.edit'), false);
    assert.equal(getEffectiveAdminPermissions(account('coordenacao')).has('students.edit'), false);

    // Pelo app inteiro: o nome do aluno não muda pelo professor auxiliar; pelo professor, muda.
    const body = { originalEmail: 'ana@papeis.local', name: 'Ana Trocada', email: 'ana@papeis.local', classes: [{ name: '1A', courseId: COURSE_A }] };
    const byMonitor = await as('monitor', request(app).post('/api/admin/student/update')).send(body);
    assert.equal(byMonitor.status, 403);
    assert.equal(db.memory.students.find(student => student.email === 'ana@papeis.local').name, 'Ana');
    const created = await as('monitor', request(app).post('/api/admin/student/create')).send({ name: 'Caio Novo', email: 'caio@papeis.local', classes: [{ name: '1A', courseId: COURSE_A }] });
    assert.equal(created.status, 403);
    assert.equal(db.memory.students.some(student => student.email === 'caio@papeis.local'), false);
    const reset = await as('monitor', request(app).post('/api/admin/reset-password')).send({ email: 'ana@papeis.local' });
    assert.equal(reset.status, 403);
    const byProfessor = await as('professor', request(app).post('/api/admin/student/update')).send(body);
    assert.equal(byProfessor.status, 200, JSON.stringify(byProfessor.body));
    assert.equal(db.memory.students.find(student => student.email === 'ana@papeis.local').name, 'Ana Trocada');
});

// Variantes que o Express 5 entrega à mesma rota: outra caixa (inclusive no ponto de
// montagem) e uma barra no fim. O guarda decide sobre a forma canônica.
function pathVariants(fullPath) {
    return [
        fullPath.toUpperCase(),
        `${fullPath}/`,
        `${fullPath.replace(/\/([a-z])/g, (whole, letter) => `/${letter.toUpperCase()}`)}/`,
    ];
}

test('[UC-PAPEIS-001] matriz com variantes de caminho: outra caixa ou barra no fim não muda a decisão do guarda', async () => {
    // Antes o guarda comparava o caminho cru e o Express rodava a rota mesmo assim:
    // '/student/Update' caía na regra genérica de aluno (page.students) e o professor
    // auxiliar alterava cadastro; '/student/certificates/issue/' deixava o professor
    // emitir certificado.
    const routes = adminRoutes();
    const wrong = [];
    for (const name of ['professor', 'monitor', 'secretaria', 'coordenacao', 'desconhecido']) {
        const acc = account(name);
        for (const { method, route, file } of routes) {
            const fullPath = route.replace(/:[^/]+/g, 'example');
            const expected = expectedDecision(acc, method, route);
            for (const variant of pathVariants(fullPath)) {
                const got = await guardDecision(name, method, variant);
                if (got !== expected) wrong.push(`${name} ${method} ${variant} (${file}): esperado ${expected}, veio ${got}`);
            }
        }
    }
    assert.deepEqual(wrong, [], wrong.slice(0, 40).join('\n'));
    // A regra específica vale na variante.
    for (const variant of ['/student/Update', '/student/update/', '/STUDENT/CREATE', '/Reset-Password/']) {
        assert.equal(resolveAdminApiPermission('POST', variant), 'students.edit', variant);
    }
    assert.equal(resolveAdminApiPermission('POST', '/student/Certificates/Issue'), 'students.certificates');
    assert.equal(resolveAdminApiPermission('GET', '/student/login-logs/'), 'students.security');
    assert.equal(resolveAdminApiPermission('GET', '/student/login-logs/?x=1'), 'students.security');
});

test('[UC-PAPEIS-001] pelo app inteiro: variante de caminho não deixa o professor auxiliar alterar aluno nem o professor emitir certificado ou ler o login do aluno', async () => {
    const body = { originalEmail: 'ana@papeis.local', name: 'Ana Mudada', email: 'ana@papeis.local', classes: [{ name: '1A', courseId: COURSE_A }] };
    for (const url of ['/api/admin/student/Update', '/api/admin/student/update/', '/API/ADMIN/STUDENT/UPDATE']) {
        const res = await as('monitor', request(app).post(url)).send(body);
        assert.equal(res.status, 403, `monitor ${url}: ${JSON.stringify(res.body)}`);
    }
    assert.equal(db.memory.students.find(student => student.email === 'ana@papeis.local').name, 'Ana');
    for (const url of ['/api/admin/student/Create', '/api/admin/student/create/']) {
        const res = await as('monitor', request(app).post(url)).send({ name: 'Caio Novo', email: 'caio@papeis.local', classes: [{ name: '1A', courseId: COURSE_A }] });
        assert.equal(res.status, 403, `monitor ${url}`);
    }
    assert.equal(db.memory.students.some(student => student.email === 'caio@papeis.local'), false);
    assert.equal((await as('monitor', request(app).post('/api/admin/Reset-Password/')).send({ email: 'ana@papeis.local' })).status, 403);

    for (const url of ['/api/admin/student/certificates/issue/', '/api/admin/student/Certificates/Issue']) {
        const res = await as('professor', request(app).post(url)).send({ email: 'ana@papeis.local', courseName: 'Curso A', courseId: COURSE_A });
        assert.equal(res.status, 403, `professor ${url}: ${JSON.stringify(res.body)}`);
    }
    assert.equal(db.memory.certificates.length, 0);
    for (const url of ['/api/admin/student/login-logs/?email=ana@papeis.local', '/api/admin/Student/Login-Logs?email=ana@papeis.local']) {
        assert.equal((await as('professor', request(app).get(url))).status, 403, `professor ${url}`);
    }
    // O professor continua alterando o aluno da turma dele pela forma canônica.
    await as('professor', request(app).post('/api/admin/student/update')).send(body).expect(200);

    // Somente leitura: a variante do autoatendimento passa e a de gravação é recusada.
    await as('coordenacao', request(app).post('/api/admin/Preferences/')).send({ 'dashboard.layout': 'compacto' }).expect(200);
    const write = await as('coordenacao', request(app).post('/API/ADMIN/STUDENT/CREATE')).send({ name: 'Novo', email: 'novo@papeis.local' });
    assert.equal(write.status, 403);
    assert.equal(write.body.code, 'read_only_account');
});

test('[UC-PAPEIS-002] escopo com variante de caminho: o curso e o conteúdo do caminho continuam conferidos', async () => {
    // Com o guarda reconhecendo '/Courses/<id>/Structure', o id do caminho precisa sair
    // da variante também; senão o curso de outra turma escaparia da conferência.
    for (const url of [`/api/admin/Courses/${COURSE_B}/Structure`, `/api/admin/courses/${COURSE_B}/structure/`, `/API/ADMIN/COURSES/${COURSE_B}/STRUCTURE`]) {
        const method = url.startsWith('/API') ? 'post' : 'get';
        const res = await as('professor', request(guardApp)[method](url)).send({});
        assert.equal(res.status, 403, url);
        assert.equal(res.body.error, 'O curso solicitado não pertence às turmas atribuídas a esta conta.', url);
    }
    const own = await as('professor', request(guardApp).get(`/api/admin/Courses/${COURSE_A}/Structure/`));
    assert.equal(own.status, 200, 'o curso da turma dele passa pela variante');
    const otherSchool = await as('secretaria', request(guardApp).post('/api/admin/Schools/Update/')).send({ id: SCHOOL_B, name: 'Trocada' });
    assert.equal(otherSchool.status, 403);
});

test('[UC-PAPEIS-002] recusa de escopo fala da escola para a secretaria e a coordenação e da turma para o professor', async () => {
    for (const name of ['secretaria', 'coordenacao']) {
        const res = await as(name, request(app).get('/api/admin/student/observations?email=bia@papeis.local'));
        assert.equal(res.status, 403, name);
        assert.equal(res.body.error, 'O aluno solicitado não pertence às escolas desta conta.', name);
    }
    // Turma de outra escola na lista de turmas do cadastro (a secretaria cria aluno).
    const newStudent = { name: 'Caio', email: 'caio@papeis.local', classes: [{ name: '1B', courseId: COURSE_B }] };
    const cls = await as('secretaria', request(app).post('/api/admin/student/create')).send(newStudent);
    assert.equal(cls.status, 403);
    assert.equal(cls.body.error, 'A turma solicitada não pertence às escolas desta conta.');
    const prof = await as('professor', request(app).get('/api/admin/student/observations?email=bia@papeis.local'));
    assert.equal(prof.body.error, 'O aluno solicitado não pertence às turmas atribuídas a esta conta.');
    const profClass = await as('professor', request(app).post('/api/admin/student/create')).send(newStudent);
    assert.equal(profClass.body.error, 'A turma solicitada não está atribuída a esta conta.');
});

test('[UC-PAPEIS-001] conteúdo pelo painel (/data.js e /:key.md): só quem mexe em conteúdo; professor auxiliar, secretaria e coordenação não leem apostila nem avaliação', async () => {
    const contentDir = process.env.ICLASS_CONTENT_DIR;
    fs.mkdirSync(contentDir, { recursive: true });
    fs.writeFileSync(path.join(contentDir, 'Apostila_Papeis_1.md'), '# Apostila dos papéis\n');
    for (const name of ['monitor', 'secretaria', 'coordenacao', 'desconhecido']) {
        assert.equal((await as(name, request(app).get('/data.js'))).status, 403, `${name} /data.js`);
        assert.equal((await as(name, request(app).get('/api/data.js'))).status, 403, `${name} /api/data.js`);
        assert.equal((await as(name, request(app).get('/Apostila_Papeis_1.md'))).status, 403, `${name} .md`);
    }
    for (const name of ['admin', 'legado', 'professor']) {
        const data = await as(name, request(app).get('/api/data.js')).expect(200);
        assert.match(data.text, /Apostila dos papéis/, name);
        const md = await as(name, request(app).get('/Apostila_Papeis_1.md')).expect(200);
        assert.match(md.text, /Apostila dos papéis/, name);
    }
});

test('[UC-PAPEIS-001] professor auxiliar não muda nota na prova ao vivo (anular, corrigir e trocar questão pedem page.results) nem recebe conteúdo como extra', async () => {
    for (const url of ['/api/admin/annul-question', '/api/admin/correct-live-question', '/api/admin/replace-question']) {
        assert.equal(await guardDecision('monitor', 'POST', url), 'permissao', `monitor ${url}`);
        assert.equal(await guardDecision('professor', 'POST', url), 'passa', `professor ${url}`);
    }
    // O Monitor em si continua: controle da prova, tempo, foco e recado.
    for (const url of ['/api/admin/server-exam-control', '/api/admin/adjust-student-time', '/api/admin/unlock-student-focus', '/api/admin/send-broadcast-message']) {
        assert.equal(await guardDecision('monitor', 'POST', url), 'passa', `monitor ${url}`);
    }
    const catalog = ROLE_CATALOG.find(role => role.id === 'monitor');
    ['page.results', 'page.materials', 'page.editor', 'page.exams', 'students.edit'].forEach(permission => {
        assert.equal(rolePermissionDefaults('monitor').includes(permission), false, permission);
        assert.equal(getEffectiveAdminPermissions({ role: 'monitor', additionalPermissions: [permission] }).has(permission), false, `extra ${permission}`);
    });
    assert.equal(catalog.concediveis.includes('page.materials'), false);
    const refused = await as('admin', request(app).post('/api/admin/accounts/create')).send({ name: 'Aux', email: 'aux@papeis.local', password: 'Senha-forte-2026-x', requirePasswordChange: false, role: 'monitor', assignedClasses: [{ courseId: COURSE_A, className: '1A' }], additionalPermissions: ['page.materials'] });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /não concedível ao papel Professor auxiliar: page\.materials/);
});

test('[UC-PAPEIS-001] coordenação só consulta: 403 read_only_account em todo POST fora do autoatendimento, dentro e fora de /api/admin', async () => {
    const createStudent = await as('coordenacao', request(app).post('/api/admin/student/create')).send({ name: 'Novo', email: 'novo@papeis.local', studentClass: '1A', courseId: COURSE_A });
    assert.equal(createStudent.status, 403);
    assert.deepEqual(createStudent.body, { error: 'Sua conta é só de consulta.', code: 'read_only_account' });
    assert.equal(db.memory.students.some(student => student.email === 'novo@papeis.local'), false);

    // Fórum (fora de /api/admin) e notas também.
    db.memory.forum = [{ id: 'c1', key: 'geral', studentEmail: 'ana@papeis.local', courseId: COURSE_A, studentClass: '1A', text: 'Dúvida', replies: [] }];
    const reply = await as('coordenacao', request(app).post('/api/forum/reply')).send({ commentId: 'c1', text: 'Resposta', courseId: COURSE_A, studentClass: '1A' });
    assert.equal(reply.status, 403);
    assert.equal(reply.body.code, 'read_only_account');
    assert.equal(db.memory.forum[0].replies.length, 0);

    // Leitura passa (escopo das escolas dela).
    const students = await as('coordenacao', request(app).get('/api/admin/students')).expect(200);
    assert.deepEqual(students.body.map(student => student.email), ['ana@papeis.local']);
    await as('coordenacao', request(app).get(`/api/admin/gradebook?courseId=${COURSE_A}&studentClass=1A`)).expect(200);
    const config = await as('coordenacao', request(app).post('/api/admin/config')).send({ studentClass: '1A', courseId: COURSE_A });
    assert.equal(config.status, 200, 'a configuração do painel é lida por POST');

    // Autoatendimento da própria conta continua.
    await as('coordenacao', request(app).post('/api/admin/preferences')).send({ 'dashboard.layout': 'compacto' }).expect(200);
    const password = await as('coordenacao', request(app).post('/api/admin/change-password')).send({ newPassword: '' });
    assert.equal(password.status, 400, 'chega na rota (falta a senha nova), não é recusa de somente leitura');
    await as('coordenacao', request(app).post('/api/session/logout')).send({}).expect(200);
});

test('[UC-PAPEIS-001] tentativa de restaurar backup pela coordenação é recusada como só consulta e fica no histórico de segurança', async () => {
    for (const url of ['/api/admin/backup/restore', '/api/admin/backup/restore/preview']) {
        db.memory.auditLogs = [];
        const res = await as('coordenacao', request(app).post(url)).send({});
        assert.equal(res.status, 403, url);
        assert.equal(res.body.code, 'read_only_account', url);
        const entries = db.memory.auditLogs.filter(entry => entry.action === 'backup_restore_failed');
        assert.equal(entries.length, 1, `${url}: antes a recusa de somente leitura não entrava no histórico`);
        assert.equal(String(entries[0].actor || entries[0].actorEmail || JSON.stringify(entries[0])).includes(ACCOUNTS.coordenacao.email), true);
        assert.match(entries[0].details.error, /Sua conta é só de consulta/);
    }
    // Outro POST recusado por somente leitura não vira registro de backup.
    db.memory.auditLogs = [];
    assert.equal((await as('coordenacao', request(app).post('/api/admin/student/create')).send({})).status, 403);
    assert.equal(db.memory.auditLogs.some(entry => entry.action === 'backup_restore_failed'), false);
});

test('[UC-PAPEIS-002] escopo por escola: secretaria e coordenação da escola A não veem aluno, turma nem curso da escola B', async () => {
    for (const name of ['secretaria', 'coordenacao']) {
        const students = await as(name, request(app).get('/api/admin/students')).expect(200);
        assert.deepEqual(students.body.map(student => student.email), ['ana@papeis.local'], name);
        const classes = await as(name, request(app).get('/api/admin/classes')).expect(200);
        assert.deepEqual(classes.body.map(cls => cls.name), ['1A'], name);
        const courses = await as(name, request(app).get('/api/courses')).expect(200);
        assert.deepEqual(courses.body.map(course => course.id), [COURSE_A], name);
        const other = await as(name, request(app).get('/api/admin/student/observations?email=bia@papeis.local'));
        assert.equal(other.status, 403, `${name}: ficha de aluno da escola B`);
        const otherClass = await as(name, request(app).get(`/api/admin/students?courseId=${COURSE_B}&studentClass=1B`));
        assert.equal(otherClass.status, 403, `${name}: turma da escola B`);
        const schools = await as(name, request(app).get('/api/admin/schools')).expect(200);
        assert.deepEqual(schools.body.map(school => school.id), [SCHOOL_A], name);
        assert.equal((await as(name, request(app).post('/api/admin/schools/update')).send({ id: SCHOOL_A, name: 'Trocada' })).status, 403, name);
    }
    // Secretaria sem escola atribuída não vê aluno nenhum (antes: superusuária).
    const none = await as('semEscola', request(app).get('/api/admin/students')).expect(200);
    assert.deepEqual(none.body, []);
    // Professor como hoje; administrador e conta antiga sem papel veem tudo.
    const prof = await as('professor', request(app).get('/api/admin/students')).expect(200);
    assert.deepEqual(prof.body.map(student => student.email), ['ana@papeis.local']);
    for (const name of ['admin', 'legado']) {
        const all = await as(name, request(app).get('/api/admin/students')).expect(200);
        assert.deepEqual(all.body.map(student => student.email).sort(), ['ana@papeis.local', 'bia@papeis.local'], name);
    }
    assert.equal(accountScopeKind(account('secretaria')), 'escolas');
    assert.equal(accountScopeKind(account('monitor')), 'turmas');
    assert.equal(accountScopeKind(account('legado')), 'tudo');
});

test('[UC-PAPEIS-002] o que era "só administrador" continua só dele: acessibilidade, matrícula e lixeira de backup', async () => {
    // Observação de acessibilidade (SEG-04): a secretaria recebe a ficha sem o laudo.
    const students = await as('secretaria', request(app).get('/api/admin/students')).expect(200);
    assert.equal(students.body[0].accessibility.observacao, '');
    assert.equal(students.body[0].accessibilityNoteRestricted, true);
    const adminView = await as('admin', request(app).get('/api/admin/students')).expect(200);
    assert.equal(adminView.body.find(student => student.email === 'ana@papeis.local').accessibility.observacao, 'Laudo médico');

    // Aprovar matrícula: administrador sim, professor não; a secretaria tem
    // enrollments.approve (bloco 'fase 3' do B0b), só nas escolas dela (teste abaixo).
    await as('admin', request(app).get('/api/admin/enrollment-requests')).expect(200);
    const professorRefused = await as('professor', request(app).get('/api/admin/enrollment-requests'));
    assert.equal(professorRefused.status, 403);
    assert.equal(professorRefused.body.error, 'Sua conta não pode analisar pedidos de matrícula.');
    assert.ok(ADMIN_PERMISSION_VALUES.includes('enrollments.approve'));
    await as('secretaria', request(app).get('/api/admin/enrollment-requests')).expect(200);

    // Baixar backup e status com o destino: só o administrador (a secretaria nem passa
    // do guarda: não tem system.manage).
    assert.equal((await as('secretaria', request(app).get('/api/admin/backup/status'))).status, 403);
    // Papel desconhecido gravado na conta (versão mais nova, dado editado): nada passa.
    assert.equal((await as('desconhecido', request(app).get('/api/admin/students'))).status, 403);
    assert.equal(getEffectiveAdminPermissions(account('desconhecido')).size, 0);
});

// Pedidos de matrícula com a Secretaria (escopo 'escolas'): antes do ajuste, com
// enrollments.approve ligada, ela via, aprovava (sem className no corpo nada passava pelo
// escopo) e recusava pedidos de curso de outra escola, com telefone e responsável.
function seedEnrollmentRequests() {
    const pending = (id, courseId, requestedClassName, createdAt) => ({
        id, courseId, requestedClassName, requestedPeriod: '', status: 'pending', createdAt, updatedAt: createdAt,
    });
    const ana = db.memory.students.find(student => student.email === 'ana@papeis.local');
    const bia = db.memory.students.find(student => student.email === 'bia@papeis.local');
    ana.phone = '11 90000-0001';
    ana.guardian = { name: 'Responsável da Ana', phone: '11 90000-0002' };
    // Ana (escola A) pede o curso da escola B; Bia (escola B) pede o da escola A; Caio
    // acabou de se cadastrar (sem turma) e pede o da escola A.
    ana.enrollmentRequests = [pending('req_ana_b', COURSE_B, '1B', 1000)];
    bia.enrollmentRequests = [pending('req_bia_a', COURSE_A, '1A', 2000)];
    db.memory.students.push({
        name: 'Caio', email: 'caio@papeis.local', status: 'Ativo', password: db.hashPassword('123'), classes: [], studentClass: '',
        enrollmentRequests: [pending('req_caio_a', COURSE_A, '1A', 3000)],
    });
}

test('[UC-PAPEIS-002] matrícula pela Secretaria: só pedidos de curso das escolas dela, na lista, no aprovar, no recusar e na fila', async () => {
    seedEnrollmentRequests();
    const list = await as('secretaria', request(app).get('/api/admin/enrollment-requests')).expect(200);
    assert.deepEqual(list.body.requests.map(item => item.id).sort(), ['req_bia_a', 'req_caio_a']);
    assert.equal(list.body.pendingCount, 2);
    assert.equal(JSON.stringify(list.body).includes('90000-0001'), false, 'telefone do aluno de fora do escopo');
    // O administrador continua vendo todos; o filtro pela turma da outra escola é recusado.
    const all = await as('admin', request(app).get('/api/admin/enrollment-requests')).expect(200);
    assert.deepEqual(all.body.requests.map(item => item.id).sort(), ['req_ana_b', 'req_bia_a', 'req_caio_a']);
    assert.equal((await as('secretaria', request(app).get(`/api/admin/enrollment-requests?courseId=${COURSE_B}`))).status, 403);
    // Secretaria sem escola atribuída: lista vazia.
    const none = await as('semEscola', request(app).get('/api/admin/enrollment-requests')).expect(200);
    assert.deepEqual(none.body.requests, []);

    // Fila do Dashboard: a contagem da Secretaria é a da tela Matrículas (2), sem o texto
    // "visível apenas para administrador"; o professor não vê o item.
    const queueOf = async name => (await as(name, request(app).get('/api/admin/dashboard/queue')).expect(200)).body
        .find(item => item.id === 'matriculas');
    const secQueue = await queueOf('secretaria');
    assert.equal(secQueue.count, 2);
    assert.equal(secQueue.detalhe, 'aguardando aprovação · Matrículas');
    assert.equal((await queueOf('admin')).count, 3);
    assert.equal(await queueOf('professor'), undefined);

    // Aprovar e recusar pedido da outra escola: 403, com ou sem turma no corpo, e nada muda.
    for (const body of [{}, { className: '1B' }]) {
        const approve = await as('secretaria', request(app).post('/api/admin/enrollment-requests/req_ana_b/approve')).send(body);
        assert.equal(approve.status, 403, JSON.stringify(body));
    }
    const reject = await as('secretaria', request(app).post('/api/admin/enrollment-requests/req_ana_b/reject')).send({ reason: 'Fora do prazo' });
    assert.equal(reject.status, 403);
    assert.match(reject.body.error, /escola/);
    const ana = db.memory.students.find(student => student.email === 'ana@papeis.local');
    assert.equal(ana.enrollmentRequests[0].status, 'pending');
    assert.equal(ana.enrollmentRequests[0].reviewedBy, undefined);
    assert.deepEqual(ana.classes, [{ name: '1A', courseId: COURSE_A }]);

    // Na escola dela, aprova (Caio entra na 1A) e recusa (Bia).
    const ok = await as('secretaria', request(app).post('/api/admin/enrollment-requests/req_caio_a/approve')).send({}).expect(200);
    assert.equal(ok.body.request.status, 'approved');
    assert.equal(ok.body.request.reviewedBy, ACCOUNTS.secretaria.email);
    assert.deepEqual(db.memory.students.find(student => student.email === 'caio@papeis.local').classes.map(item => item.name), ['1A']);
    await as('secretaria', request(app).post('/api/admin/enrollment-requests/req_bia_a/reject')).send({ reason: 'Turma cheia' }).expect(200);
    // O administrador aprova o da outra escola.
    await as('admin', request(app).post('/api/admin/enrollment-requests/req_ana_b/approve')).send({}).expect(200);
});

// Professor auxiliar no Monitor (shared_contracts.rbac.papeis: sem notas): recolher,
// reabrir e tentativa extra passam; anular, desfazer a anulação e corrigir o gabarito
// depois da prova (recorrige notas) não. Só o guarda (as rotas entram nas trilhas).
test('[UC-PAPEIS-001] professor auxiliar não muda nota pelas ações novas do Monitor', async () => {
    const post = (name, url, body = {}) => as(name, request(guardApp).post(`/api/admin${url}`)).send(body);
    const attempt = '/exam-applications/app_x/attempt-action';
    for (const action of ['recolher', 'reabrir', 'tentativa_extra']) {
        assert.equal((await post('monitor', attempt, { action, studentEmail: 'ana@papeis.local' })).status, 200, action);
        assert.equal((await post('professor', attempt, { action, studentEmail: 'ana@papeis.local' })).status, 200, action);
    }
    for (const [variant, action] of [[attempt, 'anular'], [attempt, 'desfazer_anulacao'], [`${attempt}/`, 'Anular'], [attempt.toUpperCase(), ' anular ']]) {
        const refused = await post('monitor', variant, { action, studentEmail: 'ana@papeis.local' });
        assert.equal(refused.status, 403, `${variant} ${action}`);
        assert.equal(refused.body.error, 'Sua conta não possui permissão para esta operação.');
        assert.equal((await post('professor', variant, { action, studentEmail: 'ana@papeis.local' })).status, 200, `${variant} ${action}`);
        assert.equal((await post('admin', variant, { action })).status, 200, `${variant} ${action}`);
    }
    assert.equal((await post('secretaria', attempt, { action: 'recolher' })).status, 403);
    const correction = '/exam-applications/app_x/answer-key-correction';
    assert.equal((await post('monitor', correction, { motivo: 'Gabarito errado' })).status, 403);
    assert.equal((await post('professor', correction, { motivo: 'Gabarito errado' })).status, 200);
    assert.equal((await post('secretaria', correction, { motivo: 'Gabarito errado' })).status, 403);
});

// Qualquer identificador terminado em role/Role (account.role, actualRole, nextRole...)
// comparado com 'professor', dos dois lados. Antes só '.role' contava, e o
// actualRole !== 'professor' do acesso rápido local (setupMode.js) escapava.
function usesProfessorRoleCheck(line) {
    return /isProfessorAccount/.test(line)
        || /[Rr]ole\??\s*(?:!==|===|!=|==)\s*['"]professor['"]/.test(line)
        || /['"]professor['"]\s*(?:!==|===|!=|==)\s*[\w.?]*[Rr]ole\b/.test(line);
}

test('[UC-PAPEIS-003] o teste de guarda reconhece as formas antigas de "não é professor"', () => {
    [
        "const hasExpectedRole = profile === 'professor' ? actualRole === 'professor' : actualRole !== 'professor';",
        "if (account.role !== 'professor') return true;",
        "if (admin?.role === 'professor') return [];",
        "const isAdmin = nextRole != 'professor';",
        "if ('professor' !== currentAdmin.role) next();",
        "return isProfessorAccount(account) ? [] : all;",
    ].forEach(line => assert.equal(usesProfessorRoleCheck(line), true, line));
    ["const professors = list.filter(item => item.kind === 'professor');", "if (profile === 'professor') return;"]
        .forEach(line => assert.equal(usesProfessorRoleCheck(line), false, line));
});

test('[UC-PAPEIS-003] guarda: nenhum arquivo do backend usa isProfessorAccount nem role de professor como "é administrador"', () => {
    const files = [];
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); } else if (entry.name.endsWith('.js')) files.push(full);
    });
    walk(path.join(ROOT, 'backend'));
    // Usos permitidos: a definição e os que querem dizer "papel professor" mesmo.
    const allowed = [
        { file: 'backend/utils/adminPermissions.js', pattern: /function isProfessorAccount\(account\)/ },
        { file: 'backend/utils/adminPermissions.js', pattern: /^\s*isProfessorAccount,$/ },
        { file: 'backend/middlewares.js', pattern: /^\s*isProfessorAccount,$/ },
        // Texto da recusa do guarda para o professor (a de antes).
        { file: 'backend/middlewares.js', pattern: /return refuse\(\{ error: isProfessorAccount\(matchedAdmin\)$/ },
        // Contagem dos professores da turma (GET /classes e /course-summaries).
        { file: 'backend/routes/admin.js', pattern: /^\s*isProfessorAccount,$/ },
        { file: 'backend/routes/admin.js', pattern: /const professors = \(db\.memory\.admins \|\| \[\]\)\.filter\(account => isProfessorAccount\(account\)\);/ },
        { file: 'backend/routes/admin.js', pattern: /professorCount: \(db\.memory\.admins \|\| \[\]\)\.filter\(account => isProfessorAccount\(account\) && adminCanAccessClass/ },
        { file: 'backend/routes/admin.js', pattern: /Contagem dos professores da turma: papel professor mesmo \(isProfessorAccount\)/ },
        // Acesso rápido local: o perfil 'professor' abre a conta de papel professor mesmo; o
        // perfil 'admin', só administrador pleno (isFullAdmin).
        { file: 'backend/routes/setupMode.js', pattern: /^const \{ isFullAdmin, isProfessorAccount, adminAccessSummary \} = require/ },
        { file: 'backend/routes/setupMode.js', pattern: /const hasExpectedRole = profile === 'professor' \? isProfessorAccount\(admin\) : isFullAdmin\(admin\);/ },
    ];
    const offenders = [];
    for (const file of files) {
        const rel = path.relative(ROOT, file).split(path.sep).join('/');
        if (rel === 'backend/utils/adminRoles.js') continue;
        fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
            if (!usesProfessorRoleCheck(line)) return;
            if (allowed.some(item => item.file === rel && item.pattern.test(line))) return;
            offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        });
    }
    assert.deepEqual(offenders, [], `use isFullAdmin/accountScopeKind (backend/utils/adminRoles.js):\n${offenders.join('\n')}`);
});

test('[UC-PAPEIS-004] acesso local do launcher: os dois logins mandam effectivePermissions, escopo, somente leitura e rótulo; o perfil admin só abre administrador pleno', async () => {
    const { createSetupModeRouter } = require('../../backend/routes/setupMode.js');
    const { DEMO_ACCOUNTS } = require('../../backend/utils/demoAccounts.js');
    const local = express();
    local.use(express.json());
    local.use(createSetupModeRouter({ enabled: true, setupToken: 'token-papeis-local' }));
    const quick = profile => request(local).post('/api/setup/quick-session').send({ token: 'token-papeis-local', profile });
    const base = { password: db.hashPassword('teste'), assignedClasses: [], assignedSchoolIds: [], assignedCourseIds: [], additionalPermissions: [] };

    // A conta de demonstração do administrador com papel Secretaria não entra como
    // administrador (antes: actualRole !== 'professor' bastava).
    db.memory.admins.push({ ...base, name: 'Demo', email: DEMO_ACCOUNTS.admin.email, role: 'secretaria', assignedSchoolIds: [SCHOOL_A] });
    const refused = await quick('admin');
    assert.equal(refused.status, 404, JSON.stringify(refused.body));
    account('admin'); // as contas do seed continuam
    db.memory.admins.find(item => item.email === DEMO_ACCOUNTS.admin.email).role = 'coordenacao';
    assert.equal((await quick('admin')).status, 404);
    db.memory.admins.find(item => item.email === DEMO_ACCOUNTS.admin.email).role = 'admin';
    const adminQuick = await quick('admin');
    assert.equal(adminQuick.status, 200, JSON.stringify(adminQuick.body));
    assert.deepEqual(adminQuick.body.effectivePermissions, [...ADMIN_PERMISSION_VALUES]);
    assert.deepEqual([adminQuick.body.scopeKind, adminQuick.body.readOnly, adminQuick.body.roleLabel], ['tudo', false, 'Administrador']);

    db.memory.admins.push({ ...base, name: 'Demo Prof', email: DEMO_ACCOUNTS.professor.email, role: 'professor', assignedClasses: [{ courseId: COURSE_A, className: '1A' }] });
    const profQuick = await quick('professor');
    assert.equal(profQuick.status, 200, JSON.stringify(profQuick.body));
    const profAccount = db.memory.admins.find(item => item.email === DEMO_ACCOUNTS.professor.email);
    assert.deepEqual(profQuick.body.effectivePermissions, ADMIN_PERMISSION_VALUES.filter(permission => getEffectiveAdminPermissions(profAccount).has(permission)));
    assert.deepEqual([profQuick.body.scopeKind, profQuick.body.readOnly, profQuick.body.roleLabel], ['turmas', false, 'Professor']);

    // Modo administrativo local (opção do launcher): só conta de administrador pleno, com
    // os mesmos campos do admin-login.
    db.memory.admins = db.memory.admins.map(item => (isFullAdmin(item) ? { ...item, role: 'secretaria' } : item));
    const noAdmin = await request(local).post('/api/setup/admin-session').send({ token: 'token-papeis-local' });
    assert.equal(noAdmin.status, 503, 'sem administrador pleno, nenhuma conta serve (antes: só role ausente ou admin; agora pela mesma regra do servidor)');
    seed();
    const other = express();
    other.use(express.json());
    other.use(createSetupModeRouter({ enabled: true, setupToken: 'token-papeis-local-2' }));
    const session = await request(other).post('/api/setup/admin-session').send({ token: 'token-papeis-local-2' });
    assert.equal(session.status, 200, JSON.stringify(session.body));
    assert.equal(isFullAdmin(db.memory.admins.find(item => item.email === session.body.email)), true);
    assert.deepEqual(session.body.effectivePermissions, [...ADMIN_PERMISSION_VALUES]);
    assert.deepEqual([session.body.scopeKind, session.body.readOnly, session.body.roleLabel], ['tudo', false, 'Administrador']);
});

test('[UC-PAPEIS-004] whoami de cada papel: effectivePermissions iguais às do servidor, escopo, somente leitura e rótulo', async () => {
    const labels = Object.fromEntries(ROLE_CATALOG.map(role => [role.id, role.rotulo]));
    for (const name of ['admin', 'legado', 'professor', 'monitor', 'secretaria', 'coordenacao']) {
        const acc = account(name);
        const res = await as(name, request(app).get('/api/admin/whoami')).expect(200);
        const expected = ADMIN_PERMISSION_VALUES.filter(permission => getEffectiveAdminPermissions(acc).has(permission));
        assert.deepEqual(res.body.effectivePermissions, expected, name);
        assert.equal(res.body.scopeKind, accountScopeKind(acc), name);
        assert.equal(res.body.readOnly, name === 'coordenacao', name);
        assert.equal(res.body.roleLabel, labels[acc.role || 'admin'], name);
    }
    const admin = await as('admin', request(app).get('/api/admin/whoami')).expect(200);
    assert.deepEqual(admin.body.effectivePermissions, [...ADMIN_PERMISSION_VALUES]);
    const monitor = await as('monitor', request(app).get('/api/admin/whoami')).expect(200);
    assert.equal(monitor.body.roleLabel, 'Professor auxiliar');

    // Catálogo para a tela de contas: só quem vê Contas.
    const roles = await as('admin', request(app).get('/api/admin/roles')).expect(200);
    assert.deepEqual(roles.body.roles.map(role => role.id), ['admin', 'professor', 'monitor', 'secretaria', 'coordenacao']);
    const coord = roles.body.roles.find(role => role.id === 'coordenacao');
    assert.equal(coord.somenteLeitura, true);
    assert.equal(coord.escopo, 'escolas');
    assert.deepEqual(coord.permissoesPadrao, rolePermissionDefaults('coordenacao').sort((a, b) => ADMIN_PERMISSION_VALUES.indexOf(a) - ADMIN_PERMISSION_VALUES.indexOf(b)));
    assert.equal(roles.body.roles.find(role => role.id === 'monitor').oculto, true);
    roles.body.roles.forEach(role => [...role.permissoesPadrao, ...role.concediveis].forEach(permission => assert.ok(ADMIN_PERMISSION_VALUES.includes(permission), `${role.id}: ${permission}`)));
    assert.equal((await as('professor', request(app).get('/api/admin/roles'))).status, 403);
    assert.equal((await as('secretaria', request(app).get('/api/admin/roles'))).status, 403);
});

test('[UC-PAPEIS-005] contas: cria cada papel com o escopo dele, recusa papel e extra que não valem e não deixa a instalação sem administrador', async () => {
    const create = (body) => as('admin', request(app).post('/api/admin/accounts/create')).send({ password: 'Senha-forte-2026-x', requirePasswordChange: false, ...body });
    const sec = await create({ name: 'Secretária', email: 'nova.sec@papeis.local', role: 'secretaria', assignedSchoolIds: [SCHOOL_A], assignedClasses: [{ courseId: COURSE_B, className: '1B' }], assignedCourseIds: [COURSE_B] });
    assert.equal(sec.status, 200, JSON.stringify(sec.body));
    const stored = db.memory.admins.find(item => item.email === 'nova.sec@papeis.local');
    assert.equal(stored.role, 'secretaria');
    assert.deepEqual([stored.assignedSchoolIds, stored.assignedClasses, stored.assignedCourseIds], [[SCHOOL_A], [], []], 'secretaria tem só escolas');
    const logged = await request(app).post('/api/session/admin-login').send({ email: 'nova.sec@papeis.local', password: 'Senha-forte-2026-x' }).expect(200);
    assert.equal(logged.body.role, 'secretaria');
    assert.equal(logged.body.roleLabel, 'Secretaria');
    assert.equal(logged.body.scopeKind, 'escolas');
    assert.equal(db.memory.loginLogs.filter(entry => entry.email === 'nova.sec@papeis.local').pop().role, 'secretaria');

    const coord = await create({ name: 'Coordenação', email: 'nova.coord@papeis.local', role: 'coordenacao', assignedSchoolIds: [SCHOOL_A], additionalPermissions: ['page.exams'] });
    assert.equal(coord.status, 200, JSON.stringify(coord.body));
    assert.deepEqual(db.memory.admins.find(item => item.email === 'nova.coord@papeis.local').additionalPermissions, ['page.exams']);
    const mon = await create({ name: 'Auxiliar', email: 'novo.mon@papeis.local', role: 'monitor', assignedClasses: [{ courseId: COURSE_A, className: '1A' }] });
    assert.equal(mon.status, 200, JSON.stringify(mon.body));
    assert.deepEqual(db.memory.admins.find(item => item.email === 'novo.mon@papeis.local').assignedClasses, [{ courseId: COURSE_A, className: '1A' }]);

    const invalid = await create({ name: 'X', email: 'x@papeis.local', role: 'diretor' });
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error, /Papel inválido/);
    assert.match(invalid.body.error, /secretaria \(Secretaria\)/);
    const notGrantable = await create({ name: 'Y', email: 'y@papeis.local', role: 'secretaria', additionalPermissions: ['system.manage'] });
    assert.equal(notGrantable.status, 400);
    assert.match(notGrantable.body.error, /não concedível ao papel Secretaria: system\.manage/);
    const profCert = await create({ name: 'Z', email: 'z@papeis.local', role: 'professor', additionalPermissions: ['students.certificates'] });
    assert.equal(profCert.status, 400, 'certificado continua fora do professor');
    // Só o administrador gerencia contas (a secretaria nem passa do guarda).
    assert.equal((await as('secretaria', request(app).post('/api/admin/accounts/create')).send({ name: 'W', email: 'w@papeis.local', password: 'Senha-forte-2026-x', role: 'admin' })).status, 403);

    // Trocar de papel: professor vira coordenação, perde as turmas e as extras que o papel
    // novo não aceita.
    const prof = account('professor');
    prof.additionalPermissions = ['page.system', 'system.manage'];
    const update = await as('admin', request(app).post('/api/admin/accounts/update')).send({ email: prof.email, role: 'coordenacao', assignedSchoolIds: [SCHOOL_A] });
    assert.equal(update.status, 200, JSON.stringify(update.body));
    assert.deepEqual([prof.role, prof.assignedClasses, prof.assignedSchoolIds, prof.additionalPermissions], ['coordenacao', [], [SCHOOL_A], []]);
    assert.equal(db.memory.auditLogs.some(entry => entry.action === 'account_updated' && entry.after && entry.after.role === 'coordenacao'), true);

    // O último administrador não perde o papel (as contas 'admin' e 'legado' são as duas).
    await as('admin', request(app).post('/api/admin/accounts/update')).send({ email: ACCOUNTS.legado.email, role: 'secretaria', assignedSchoolIds: [SCHOOL_A] }).expect(200);
    const last = await as('admin', request(app).post('/api/admin/accounts/update')).send({ email: ACCOUNTS.admin.email, role: 'professor' });
    assert.equal(last.status, 400);
    assert.match(last.body.error, /única conta de administrador/);
    assert.equal(account('admin').role, 'admin');
    const deleteLast = await as('legado', request(app).post('/api/admin/accounts/delete')).send({ email: ACCOUNTS.admin.email });
    assert.equal(deleteLast.status, 403, 'a conta legada agora é da secretaria e não gerencia contas');
});

test('[UC-PAPEIS-005] backup que só traz contas de outros papéis não substitui as contas (nenhum administrador)', async () => {
    const backupUtil = require('../../backend/utils/backup.js');
    const snapshot = backupUtil.buildDataSnapshot();
    const hashed = db.hashPassword('x');
    snapshot.data.admins = [
        { email: 'sec@x.local', name: 'Secretaria', role: 'secretaria', password: hashed },
        { email: 'prof@x.local', name: 'Professor', role: 'professor', password: hashed },
    ];
    // Antes: "role !== 'professor'" contava a secretaria como administrador e o backup
    // trocava as contas por uma instalação sem administrador.
    await assert.rejects(() => backupUtil.restoreDataSnapshot(snapshot, { replaceAccounts: true }), /nenhuma conta de administrador/);
    assert.equal(account('admin').role, 'admin');
});

test('[UC-PAPEIS-005] boot: os papéis novos ficam gravados com o escopo do papel; conta sem papel continua administrador', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-papeis-boot-'));
    const child = path.join(__dirname, 'fixtures', 'admin-roles-boot-child.js');
    const env = { ...process.env, ICLASS_DATA_DIR: dataDir, ICLASS_CONTENT_DIR: path.join(dataDir, 'content'), ICLASS_ARCHIVE_DIR: path.join(dataDir, 'archives'), TEST_MODE: '1' };
    const run = scenario => {
        const out = spawnSync(process.execPath, [child, scenario], { env, encoding: 'utf8', timeout: 60000 });
        const line = String(out.stdout || '').split('\n').find(item => item.startsWith('@@'));
        assert.ok(line, `${scenario}: ${out.stderr}`);
        return JSON.parse(line.slice(2));
    };
    try {
        run('seed');
        const first = run('read');
        const second = run('read');
        assert.deepEqual(second, first, 'o segundo boot não muda nada');
        const byEmail = Object.fromEntries(first.admins.map(item => [item.email, item]));
        assert.equal(byEmail['sec@boot.local'].role, 'secretaria');
        assert.deepEqual(byEmail['sec@boot.local'].assignedSchoolIds, ['escola_a']);
        assert.deepEqual(byEmail['sec@boot.local'].assignedClasses, [], 'secretaria não recebe todas as turmas como o administrador');
        assert.deepEqual(byEmail['sec@boot.local'].assignedCourseIds, []);
        assert.deepEqual(byEmail['sec@boot.local'].additionalPermissions, ['page.forum'], 'extra não concedível ao papel sai');
        assert.equal(byEmail['coord@boot.local'].role, 'coordenacao');
        assert.equal(byEmail['mon@boot.local'].role, 'monitor');
        assert.deepEqual(byEmail['mon@boot.local'].assignedClasses, [{ courseId: 'curso_a', className: '1A' }]);
        assert.equal(byEmail['legado@boot.local'].role, 'admin');
        assert.equal(byEmail['estranho@boot.local'].role, 'admin', 'papel desconhecido gravado continua administrador (regra antiga dos dados)');
        assert.equal(byEmail['prof@boot.local'].role, 'professor');
        assert.equal(first.whoami['sec@boot.local'].scopeKind, 'escolas');
    } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});
