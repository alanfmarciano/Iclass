// Professor auxiliar (papel 'monitor') e as notas: pendência conhecida da J0 da fase 3.
//
// O contrato (shared_contracts.rbac.papeis do plano) diz que o professor auxiliar faz
// chamada e usa o Monitor, sem notas, provas, conteúdo e mensagens. Ele já não muda nota
// (admin-roles-matrix.test.js), mas ainda LÊ notas: recebe page.students, page.dashboard
// e page.monitor, e estas rotas pedem só isso:
// - ficha do aluno (/student/report, /student/academic, /student/dashboard), page.students;
// - resumo dos alunos e tendências do Dashboard (/dashboard/students-overview e
//   /dashboard/trends, com a média de notas da turma), page.dashboard;
// - revisão da prova no Monitor (/monitor-review/:class/:examKey, com o acerto de cada
//   questão do aluno), page.monitor. Se a trilha B decidir que isso faz parte de "usa o
//   Monitor", tira a rota daqui e escreve o motivo neste cabeçalho.
// Separar a leitura de nota dessas rotas mexe na ficha do aluno, no Dashboard e no Monitor
// da tela e fica com a trilha B (B1 ou depois; a J3 confere "monitor sem notas e mensagens").
//
// Enquanto isso não muda, o papel fica oculto: fora da criação de conta na tela e na API
// (POST /api/admin/accounts/create e /update recusam o papel novo) e não existe no banco do
// Alan. Este teste segura as duas pontas: se o papel deixar de ser oculto ainda lendo nota,
// ou se a API aceitar criar conta com ele, falha; quando a trilha B tirar a leitura, o
// teste continua passando (e a parte de baixo passa a conferir que nenhuma rota abre).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-monitor-pendencia-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');

const { findAdminRole } = require('../../backend/utils/adminRoles.js');
const {
    resolveAdminApiPermission,
    canAccessAdminPermission,
    roleGrantablePermissions,
} = require('../../backend/utils/adminPermissions.js');

// Rotas do painel que devolvem nota de aluno e hoje pedem page.students, page.dashboard ou
// page.monitor: [método, rota como está em admin.js, um caminho concreto para o guarda].
const ROTAS_QUE_LEEM_NOTA = [
    ['GET', '/student/report', '/student/report'],
    ['GET', '/student/academic', '/student/academic'],
    ['GET', '/student/dashboard', '/student/dashboard'],
    ['GET', '/dashboard/students-overview', '/dashboard/students-overview'],
    ['GET', '/dashboard/trends', '/dashboard/trends'],
    ['GET', '/monitor-review/:class/:examKey', '/monitor-review/1A/prova1'],
];

function monitorLeNota(account) {
    return ROTAS_QUE_LEEM_NOTA.filter(([method, , sample]) =>
        canAccessAdminPermission(account, resolveAdminApiPermission(method, sample)));
}

test('[UC-PAPEIS-001] professor auxiliar: enquanto lê nota pela ficha do aluno, pelo Dashboard ou pela revisão do Monitor, o papel fica escondido', () => {
    const role = findAdminRole('monitor');
    assert.ok(role, 'papel monitor no catálogo');
    // Com tudo o que se pode conceder ao papel, para a regra valer também com extras.
    const comExtras = { role: 'monitor', additionalPermissions: roleGrantablePermissions('monitor') };
    const lidas = [...new Set([...monitorLeNota({ role: 'monitor' }), ...monitorLeNota(comExtras)])];
    if (lidas.length) {
        assert.equal(role.oculto, true,
            `o professor auxiliar ainda lê nota por ${lidas.map(([method, route]) => `${method} ${route}`).join(', ')}; `
            + 'tire essa leitura (trilha B) antes de mostrar o papel na criação de conta');
    }
});

test('a lista de rotas que leem nota não ficou cega: cada uma existe e o professor lê', () => {
    const adminRoutes = fs.readFileSync(path.join(__dirname, '../../backend/routes/admin.js'), 'utf8');
    for (const [method, route, sample] of ROTAS_QUE_LEEM_NOTA) {
        assert.ok(adminRoutes.includes(`router.${method.toLowerCase()}('/api/admin${route}'`), `rota ${route} em admin.js`);
        const permission = resolveAdminApiPermission(method, sample);
        assert.ok(permission, `regra para ${route}`);
        assert.equal(canAccessAdminPermission({ role: 'professor' }, permission), true, `professor lê ${route}`);
    }
});

test('[UC-PAPEIS-001] professor auxiliar: enquanto lê nota, a API também não cria conta com o papel nem troca outra conta para ele', async () => {
    const lidas = monitorLeNota({ role: 'monitor', additionalPermissions: roleGrantablePermissions('monitor') });
    if (!lidas.length) return; // a trilha B tirou a leitura: o papel pode aparecer.
    await db.init();
    try {
        const app = createApp();
        db.memory.classes = [{ name: '1A', courseId: 'curso_a', onlineExamConfigs: {} }];
        db.memory.courses = [{ id: 'curso_a', name: 'Curso A', structure: [] }];
        db.memory.admins = [
            { email: 'admin@pendencia.local', name: 'Admin', role: 'admin', password: db.hashPassword('x') },
            { email: 'prof@pendencia.local', name: 'Prof', role: 'professor', password: db.hashPassword('x'), assignedClasses: [{ courseId: 'curso_a', className: '1A' }] },
        ];
        db.memory.adminSessions = { 'token-pendencia': { email: 'admin@pendencia.local', createdAt: Date.now(), lastSeen: Date.now() } };
        const asAdmin = req => req.set('x-admin-session', 'token-pendencia');
        const created = await asAdmin(request(app).post('/api/admin/accounts/create')).send({
            name: 'Auxiliar', email: 'aux@pendencia.local', password: 'Senha-forte-2026-x', requirePasswordChange: false,
            role: 'monitor', assignedClasses: [{ courseId: 'curso_a', className: '1A' }],
        });
        assert.equal(created.status, 400, JSON.stringify(created.body));
        assert.equal(db.memory.admins.some(item => item.email === 'aux@pendencia.local'), false);
        const changed = await asAdmin(request(app).post('/api/admin/accounts/update')).send({ email: 'prof@pendencia.local', role: 'monitor' });
        assert.equal(changed.status, 400, JSON.stringify(changed.body));
        assert.equal(db.memory.admins.find(item => item.email === 'prof@pendencia.local').role, 'professor');
    } finally {
        await new Promise(resolve => setTimeout(resolve, 1500));
        await db.close();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});
