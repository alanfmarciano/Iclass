// Professor auxiliar (papel 'monitor') e as notas: pendência conhecida da J0 da fase 3.
//
// O contrato (shared_contracts.rbac.papeis do plano) diz que o professor auxiliar faz
// chamada e usa o Monitor, sem notas, provas, conteúdo e mensagens. Ele já não muda nota
// (admin-roles-matrix.test.js), mas ainda LÊ notas: recebe page.students e page.dashboard,
// e a ficha do aluno (/student/report, /student/academic, /student/dashboard) e o resumo
// dos alunos do Dashboard (/dashboard/students-overview) pedem só essas permissões.
// Separar a leitura de nota dessas rotas mexe na ficha do aluno e no Dashboard da tela e
// fica com a trilha B (B1 ou depois; a J3 confere "monitor sem notas e mensagens").
//
// Enquanto isso não muda, o papel fica escondido na criação de conta (oculto) e não
// existe no banco do Alan. Este teste segura as duas pontas: se o papel aparecer na tela
// ainda lendo nota, falha; quando a trilha B tirar a leitura, o teste continua passando
// (e a parte de baixo passa a conferir que nenhuma das rotas abre para o papel).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { findAdminRole } = require('../../backend/utils/adminRoles.js');
const {
    resolveAdminApiPermission,
    canAccessAdminPermission,
    roleGrantablePermissions,
} = require('../../backend/utils/adminPermissions.js');

// Rotas do painel que devolvem nota de aluno e hoje pedem page.students ou page.dashboard.
const ROTAS_QUE_LEEM_NOTA = [
    ['GET', '/student/report'],
    ['GET', '/student/academic'],
    ['GET', '/student/dashboard'],
    ['GET', '/dashboard/students-overview'],
];

function monitorLeNota(account) {
    return ROTAS_QUE_LEEM_NOTA.filter(([method, route]) =>
        canAccessAdminPermission(account, resolveAdminApiPermission(method, route)));
}

test('[UC-PAPEIS-001] professor auxiliar: enquanto lê nota pela ficha do aluno ou pelo Dashboard, o papel fica escondido', () => {
    const role = findAdminRole('monitor');
    assert.ok(role, 'papel monitor no catálogo');
    // Com tudo o que se pode conceder ao papel, para a regra valer também com extras.
    const comExtras = { role: 'monitor', additionalPermissions: roleGrantablePermissions('monitor') };
    const lidas = [...new Set([...monitorLeNota({ role: 'monitor' }), ...monitorLeNota(comExtras)])];
    if (lidas.length) {
        assert.equal(role.oculto, true,
            `o professor auxiliar ainda lê nota por ${lidas.map(item => item.join(' ')).join(', ')}; `
            + 'tire essa leitura (trilha B) antes de mostrar o papel na criação de conta');
    }
});

test('a lista de rotas que leem nota não ficou cega: cada uma existe e o professor lê', () => {
    const adminRoutes = fs.readFileSync(path.join(__dirname, '../../backend/routes/admin.js'), 'utf8');
    for (const [method, route] of ROTAS_QUE_LEEM_NOTA) {
        assert.ok(adminRoutes.includes(`router.${method.toLowerCase()}('/api/admin${route}'`), `rota ${route} em admin.js`);
        const permission = resolveAdminApiPermission(method, route);
        assert.ok(permission, `regra para ${route}`);
        assert.equal(canAccessAdminPermission({ role: 'professor' }, permission), true, `professor lê ${route}`);
    }
});
