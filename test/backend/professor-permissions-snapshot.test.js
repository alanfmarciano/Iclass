// Fase 3, B0a (FUN-13, P4-S1): o conjunto efetivo de um professor de hoje só cresce.
// A referência é a 281029f (test/backend/fixtures/professor-permissoes-281029f.json):
// o que o servidor dava ao professor, o que a tela dava (com page.classes, que o servidor
// não tinha) e os caminhos do menu. Agora o servidor manda effectivePermissions no whoami
// e no login, e o menu montado dessa lista não pode perder nenhum caminho.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-prof-snapshot-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const {
    ADMIN_PERMISSION_VALUES,
    PROFESSOR_DEFAULT_PERMISSIONS,
    getEffectiveAdminPermissions,
    resolveAdminApiPermission,
} = require('../../backend/utils/adminPermissions.js');

const baseline = require('./fixtures/professor-permissoes-281029f.json');
const WEB_PERMISSIONS = path.join(__dirname, '..', '..', 'web', 'src', 'lib', 'adminPermissions.js');

let app;
const COURSE = 'curso-snap';
const tokens = { prof: 'token-prof-snapshot', extra: 'token-prof-extra-snapshot' };

function seed() {
    db.memory.schools = [{ id: 'escola_default', name: 'Escola' }];
    db.memory.courses = [{ id: COURSE, name: 'Curso', schoolId: 'escola_default', structure: [] }];
    db.memory.classes = [{ name: '1A', courseId: COURSE, period: 'Manhã', onlineExamConfigs: {} }];
    db.memory.admins = [
        { email: 'admin@snap.local', name: 'Admin', role: 'admin', password: db.hashPassword('x') },
        { email: 'prof@snap.local', name: 'Professor', role: 'professor', password: db.hashPassword('x'), assignedClasses: [{ courseId: COURSE, className: '1A' }], additionalPermissions: [] },
        { email: 'extra@snap.local', name: 'Professor com extras', role: 'professor', password: db.hashPassword('x'), assignedClasses: [{ courseId: COURSE, className: '1A' }], additionalPermissions: ['system.manage', 'course.manage'] },
    ];
    db.memory.adminSessions = {
        [tokens.prof]: { email: 'prof@snap.local', createdAt: Date.now(), lastSeen: Date.now() },
        [tokens.extra]: { email: 'extra@snap.local', createdAt: Date.now(), lastSeen: Date.now() },
    };
    db.memory.students = [];
}

test.before(async () => { await db.init(); app = createApp(); });
test.beforeEach(() => { seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1000));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

const professor = () => db.memory.admins.find(account => account.email === 'prof@snap.local');

test('[UC-PAPEIS-004] o professor sem extras tem tudo o que o servidor e a tela davam na 281029f (page.classes entra no servidor)', () => {
    const effective = getEffectiveAdminPermissions(professor());
    const lost = [...new Set([...baseline.servidor, ...baseline.tela])].filter(permission => !effective.has(permission));
    assert.deepEqual(lost, [], `o professor perdeu: ${lost.join(', ')}`);
    assert.ok(effective.has('page.classes'), 'antes: a tela mostrava Turmas, mas o servidor não tinha page.classes');
    assert.ok(PROFESSOR_DEFAULT_PERMISSIONS.includes('page.classes'));
    // Consulta não é gerência: alterar turma continua com classes.manage.
    assert.equal(effective.has('classes.manage'), false);
    assert.equal(resolveAdminApiPermission('POST', '/class/update'), 'classes.manage');
});

test('[UC-PAPEIS-004] cada permissão concedível ao professor na 281029f continua concedível e soma ao padrão', () => {
    for (const permission of baseline.concediveis) {
        const effective = getEffectiveAdminPermissions({ role: 'professor', additionalPermissions: [permission] });
        assert.ok(effective.has(permission), `extra ${permission} deixou de valer`);
        baseline.tela.forEach(base => assert.ok(effective.has(base), `${base} sumiu com a extra ${permission}`));
    }
    // As exclusivas do administrador continuam fora do professor.
    for (const permission of ['page.accounts', 'accounts.manage', 'students.destroy', 'students.certificates', 'students.security', 'course.purge', 'forum.purge', 'audit.view']) {
        assert.equal(getEffectiveAdminPermissions({ role: 'professor', additionalPermissions: [permission] }).has(permission), false, permission);
    }
});

test('[UC-PAPEIS-004] whoami e login mandam effectivePermissions, escopo, somente leitura e rótulo; a lista é a do servidor', async () => {
    const whoami = await request(app).get('/api/admin/whoami').set('x-admin-session', tokens.prof).expect(200);
    assert.deepEqual(whoami.body.effectivePermissions, ADMIN_PERMISSION_VALUES.filter(permission => getEffectiveAdminPermissions(professor()).has(permission)));
    assert.equal(whoami.body.scopeKind, 'turmas');
    assert.equal(whoami.body.readOnly, false);
    assert.equal(whoami.body.roleLabel, 'Professor');
    assert.equal(whoami.body.role, 'professor');

    const extra = await request(app).get('/api/admin/whoami').set('x-admin-session', tokens.extra).expect(200);
    ['system.manage', 'page.system', 'course.manage', ...baseline.tela].forEach(permission => assert.ok(extra.body.effectivePermissions.includes(permission), permission));

    const login = await request(app).post('/api/session/admin-login').send({ email: 'prof@snap.local', password: 'x' }).expect(200);
    assert.deepEqual(login.body.effectivePermissions, whoami.body.effectivePermissions);
    assert.equal(login.body.scopeKind, 'turmas');
});

test('[UC-PAPEIS-004] o menu montado de effectivePermissions mostra todos os caminhos que o professor via na 281029f', async () => {
    const web = await import(pathToFileURL(WEB_PERMISSIONS).href);
    const whoami = await request(app).get('/api/admin/whoami').set('x-admin-session', tokens.prof).expect(200);
    const granted = new Set(whoami.body.effectivePermissions);
    const missing = [...baseline.menu.instituicao, ...baseline.menu.curso]
        .filter(item => web.ADMIN_PATH_PERMISSIONS[item] && !granted.has(web.ADMIN_PATH_PERMISSIONS[item]))
        .map(item => `${item} (${web.ADMIN_PATH_PERMISSIONS[item]})`);
    assert.deepEqual(missing, [], `caminhos do menu sem a permissão no servidor: ${missing.join(', ')}`);
});

test('[UC-PAPEIS-004] as constantes da tela batem com ADMIN_PERMISSION_VALUES do servidor (sem "page.fórum")', async () => {
    const web = await import(pathToFileURL(WEB_PERMISSIONS).href);
    const unknown = Object.values(web.ADMIN_PERMISSIONS).filter(value => !ADMIN_PERMISSION_VALUES.includes(value));
    assert.deepEqual(unknown, [], `constantes da tela que o servidor não conhece: ${unknown.join(', ')}`);
    const pathPermissions = Object.values(web.ADMIN_PATH_PERMISSIONS).filter(value => !ADMIN_PERMISSION_VALUES.includes(value));
    assert.deepEqual(pathPermissions, []);
    assert.equal(fs.readFileSync(WEB_PERMISSIONS, 'utf8').includes('page.fórum'), false);
});

test('[UC-PAPEIS-004] o guarda deixa o professor seguir em cada permissão que ele tinha (Turmas em consulta passa a valer)', async () => {
    // Uma rota de leitura por permissão do professor, sem mudar nada.
    const probes = [
        ['/api/admin/classes', 'page.dashboard'],
        [`/api/admin/exam-applications?courseId=${COURSE}&studentClass=1A`, 'page.exams'],
        [`/api/admin/gradebook?courseId=${COURSE}&studentClass=1A`, 'page.results'],
        [`/api/admin/attendance?courseId=${COURSE}&studentClass=1A&date=2026-11-18`, 'page.students'],
        [`/api/admin/announcements?courseId=${COURSE}&studentClass=1A`, 'page.forum'],
        [`/api/admin/library?courseId=${COURSE}&studentClass=1A`, 'page.editor'],
        ['/api/admin/schools', 'schools.scope'],
    ];
    for (const [url, permission] of probes) {
        // A regra pode aceitar mais de uma permissão (GET /schools: schools.scope ou page.classes).
        const rule = resolveAdminApiPermission('GET', url.replace('/api/admin', ''));
        assert.ok([].concat(rule).includes(permission), `${url}: ${JSON.stringify(rule)}`);
        const res = await request(app).get(url).set('x-admin-session', tokens.prof);
        assert.notEqual(res.status, 403, `${url}: ${JSON.stringify(res.body)}`);
        assert.notEqual(res.status, 401, url);
    }
});
