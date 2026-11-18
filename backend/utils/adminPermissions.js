const {
    ROLE_CATALOG,
    FULL_ADMIN_ONLY_PERMISSIONS,
    NEVER_FOR_PROFESSOR,
    accountRoleId,
    findAdminRole,
    isFullAdmin,
    accountScopeKind,
    isReadOnlyAccount,
    accountRoleLabel,
} = require('./adminRoles.js');

const ADMIN_PERMISSION_VALUES = Object.freeze([
    'page.dashboard',
    'page.exams',
    'page.monitor',
    'page.results',
    'page.materials',
    'page.editor',
    'page.classes',
    'page.students',
    'page.accounts',
    'page.forum',
    'page.branding',
    'page.system',
    'course.manage',
    'classes.manage',
    'accounts.manage',
    'branding.manage',
    'system.manage',
    'students.destroy',
    'students.certificates',
    'students.security',
    'schools.scope',
    'course.purge',
    'forum.purge',
    'audit.view',
]);

const ADMIN_PERMISSION_SET = new Set(ADMIN_PERMISSION_VALUES);
// Papéis (fase 3, FUN-13): catálogo em adminRoles.js. Daqui saem as listas calculadas
// de cada papel, só com as permissões que existem em ADMIN_PERMISSION_VALUES.
// Exclusivas de administrador: nunca fazem parte de outro papel nem podem ser concedidas.
// audit.view (SEG-07, decisão P5): a trilha de auditoria mostra IP, contas e o que os
// outros professores fizeram; é só do administrador. O professor continua vendo o
// histórico de cada nota em Resultados (rota das entregas, page.results).
// students.certificates deixou de ser exclusiva (pode ser da Secretaria), mas continua
// fora do professor (NEVER_FOR_PROFESSOR).
const ADMIN_ONLY_PERMISSION_SET = new Set(FULL_ADMIN_ONLY_PERMISSIONS);
const NEVER_FOR_PROFESSOR_SET = new Set(NEVER_FOR_PROFESSOR);

const knownPermissions = list => list.filter(permission => ADMIN_PERMISSION_SET.has(permission));

// Permissões padrão de um papel, já filtradas pelas que existem.
function rolePermissionDefaults(roleId) {
    const role = findAdminRole(roleId);
    if (!role) return [];
    if (role.permissoesPadrao === '*') return [...ADMIN_PERMISSION_VALUES];
    return [...new Set(knownPermissions(role.permissoesPadrao))];
}

// Permissões que o administrador pode dar a mais a uma conta do papel.
function roleGrantablePermissions(roleId) {
    const role = findAdminRole(roleId);
    if (!role) return [];
    if (role.concediveis === '*') {
        return ADMIN_PERMISSION_VALUES.filter(permission => !ADMIN_ONLY_PERMISSION_SET.has(permission)
            && !(role.id === 'professor' && NEVER_FOR_PROFESSOR_SET.has(permission)));
    }
    return [...new Set(knownPermissions(role.concediveis))]
        .filter(permission => !ADMIN_ONLY_PERMISSION_SET.has(permission));
}

// Padrão do professor, calculado do catálogo (professores existentes ganham o que entra
// no papel sem migração; o conjunto de um professor de hoje só cresce).
const PROFESSOR_DEFAULT_PERMISSIONS = Object.freeze(rolePermissionDefaults('professor'));
const PERMISSION_DEPENDENCIES = Object.freeze({
    'classes.manage': 'page.classes',
    'accounts.manage': 'page.accounts',
    'branding.manage': 'page.branding',
    'system.manage': 'page.system',
});

function expandPermissionDependencies(permissions) {
    const expanded = new Set(permissions);
    permissions.forEach(permission => {
        const dependency = PERMISSION_DEPENDENCIES[permission];
        if (dependency) expanded.add(dependency);
    });
    return [...expanded];
}

// Permissões extras gravadas na conta, só as concedíveis ao papel (padrão: professor,
// como antes dos papéis). Uma extra que o papel não aceita é ignorada.
function normalizeAdditionalPermissions(value, roleId = 'professor') {
    if (!Array.isArray(value)) return [];
    const grantable = new Set(roleGrantablePermissions(roleId));
    const valid = [...new Set(value
        .map(permission => String(permission).trim())
        .filter(permission => grantable.has(permission)))];
    return expandPermissionDependencies(valid).filter(permission => grantable.has(permission) || rolePermissionDefaults(roleId).includes(permission));
}

function parseAdditionalPermissions(value, roleId = 'professor') {
    if (value === undefined) return { ok: true, permissions: undefined };
    if (!Array.isArray(value)) {
        return { ok: false, error: 'Permissões adicionais devem ser enviadas como uma lista.' };
    }

    const requested = [...new Set(value.map(permission => String(permission).trim()).filter(Boolean))];
    const unknown = requested.find(permission => !ADMIN_PERMISSION_SET.has(permission));
    if (unknown) {
        return { ok: false, error: `Permissão adicional desconhecida: ${unknown}.` };
    }
    const role = findAdminRole(roleId);
    const grantable = new Set(roleGrantablePermissions(roleId));
    const adminOnly = requested.find(permission => !grantable.has(permission));
    if (adminOnly) {
        if (!role || role.id === 'professor') {
            return { ok: false, error: `Permissão exclusiva de administrador e não concedível a professores: ${adminOnly}.` };
        }
        return { ok: false, error: `Permissão não concedível ao papel ${role.rotulo}: ${adminOnly}.` };
    }

    return { ok: true, permissions: expandPermissionDependencies(requested).filter(permission => grantable.has(permission) || rolePermissionDefaults(roleId).includes(permission)) };
}

// Só o papel 'professor' (não quer dizer "não é administrador": use isFullAdmin e
// accountScopeKind de adminRoles.js).
function isProfessorAccount(account) {
    return !!account && accountRoleId(account) === 'professor';
}

// Conjunto efetivo da conta: o administrador tem todas; os outros papéis, o padrão do
// papel mais as extras concedíveis; papel desconhecido, nenhuma.
function getEffectiveAdminPermissions(account) {
    const roleId = accountRoleId(account);
    if (!roleId) return new Set();
    if (roleId === 'admin') return new Set(ADMIN_PERMISSION_VALUES);
    return new Set([
        ...rolePermissionDefaults(roleId),
        ...normalizeAdditionalPermissions(account.additionalPermissions, roleId),
    ]);
}

// Lista para a sessão da tela (whoami e login): em ordem fixa, a do catálogo.
function effectivePermissionList(account) {
    const permissions = getEffectiveAdminPermissions(account);
    return ADMIN_PERMISSION_VALUES.filter(permission => permissions.has(permission));
}

// Capacidade que antes era "só administrador" fixo na rota e passa a ser uma permissão
// (ex.: enrollments.approve, P4 D16): o administrador sempre tem; os outros papéis, só
// com a permissão (enquanto o valor não existir, ninguém além do administrador).
function hasAdminCapability(account, permission) {
    return isFullAdmin(account) || getEffectiveAdminPermissions(account).has(permission);
}

// Catálogo dos papéis para a tela de contas (GET /api/admin/roles).
function adminRoleCatalogForScreen() {
    return ROLE_CATALOG.map(role => ({
        id: role.id,
        rotulo: role.rotulo,
        descricao: role.descricao,
        escopo: role.escopo,
        somenteLeitura: role.somenteLeitura,
        oculto: role.oculto,
        permissoesPadrao: ADMIN_PERMISSION_VALUES.filter(permission => rolePermissionDefaults(role.id).includes(permission)),
        concediveis: ADMIN_PERMISSION_VALUES.filter(permission => roleGrantablePermissions(role.id).includes(permission)),
    }));
}

// A regra pode aceitar mais de uma permissão (lista): basta ter uma delas.
function hasAnyAdminPermission(permissions, required) {
    if (!required) return true;
    const list = Array.isArray(required) ? required : [required];
    return list.some(permission => permissions.has(permission));
}

function canAccessAdminPermission(account, permission) {
    return hasAnyAdminPermission(getEffectiveAdminPermissions(account), permission);
}

// Sessão do painel (whoami e login, D18 do P4): o que a tela usa em vez de recalcular.
function adminAccessSummary(account) {
    return {
        effectivePermissions: effectivePermissionList(account),
        scopeKind: accountScopeKind(account),
        readOnly: isReadOnlyAccount(account),
        roleLabel: accountRoleLabel(account),
    };
}

const ADMIN_API_PERMISSION_RULES = Object.freeze([
    { methods: ['GET'], pattern: /^\/whoami$/, permission: 'page.dashboard' },
    { methods: ['GET'], pattern: /^\/accounts$/, permission: 'page.accounts' },
    // Catálogo dos papéis para a tela de contas (FUN-13).
    { methods: ['GET'], pattern: /^\/roles$/, permission: 'page.accounts' },
    { methods: ['POST'], pattern: /^\/accounts\/(create|update|delete|unlock-login)$/, permission: 'accounts.manage' },
    { methods: ['POST'], pattern: /^\/teacher-assignments$/, permission: 'accounts.manage' },
    { methods: ['GET'], pattern: /^\/network-info$/, permission: 'page.system' },
    // Endereço da sala e QR code (H6a): o professor projeta pelo Dashboard e pelo Monitor.
    { methods: ['GET'], pattern: /^\/room-address$/, permission: ['page.dashboard', 'page.monitor'] },
    // Cartão "Saúde do servidor" da tela Sistema (H3c).
    { methods: ['GET'], pattern: /^\/system\/health$/, permission: 'page.system' },
    // Cartão Armazenamento e Compactar (H1-c); compactar é só do administrador (a rota
    // confere a conta).
    { methods: ['GET'], pattern: /^\/storage$/, permission: 'system.manage' },
    { methods: ['POST'], pattern: /^\/storage\/compact$/, permission: 'system.manage' },
    { methods: ['POST'], pattern: /^\/(flush-exam-state|server\/restart|reset)$/, permission: 'system.manage' },
    { methods: ['GET'], pattern: /^\/maintenance\/preview$/, permission: 'system.manage' },
    { methods: ['GET', 'POST'], pattern: /^\/settings$/, permission: 'system.manage' },
    // Rede (painel em outros aparelhos): system.manage, e a rota recusa o professor.
    { methods: ['GET', 'POST'], pattern: /^\/network-settings$/, permission: 'system.manage' },
    { methods: ['GET', 'POST'], pattern: /^\/trash(?:\/.*)?$/, permission: 'system.manage' },
    { methods: ['GET', 'POST'], pattern: /^\/backup(?:\/.*)?$/, permission: 'system.manage' },
    { methods: ['POST'], pattern: /^\/config$/, permission: 'page.dashboard' },
    { methods: ['POST'], pattern: /^\/(exam-config|online-exam-config)$/, permission: 'page.exams' },
    // Gerar novo token: o botão fica no Monitor (e a aplicação nasce em Provas).
    { methods: ['POST'], pattern: /^\/exam-applications\/[^/]+\/access-token$/, permission: ['page.monitor', 'page.exams'] },
    // Registro da aplicação é lido na tela Resultados (AVA-08).
    { methods: ['GET'], pattern: /^\/exam-applications\/[^/]+\/audit$/, permission: 'page.results' },
    { methods: ['GET', 'POST'], pattern: /^\/exam-applications(?:\/.*)?$/, permission: 'page.exams' },
    { methods: ['GET', 'POST'], pattern: /^\/exam-history(?:\/.*)?$/, permission: 'page.exams' },
    { methods: ['POST'], pattern: /^\/release-item$/, permission: 'page.materials' },
    { methods: ['GET', 'POST'], pattern: /^\/submissions(?:\/.*)?$/, permission: 'page.results' },
    { methods: ['POST'], pattern: /^\/delete-student$/, permission: 'students.destroy' },
    // Cadastros encerrados (H7c): lista, anonimizar e apagar de vez, só do administrador.
    { methods: ['GET'], pattern: /^\/students\/closed$/, permission: 'students.destroy' },
    { methods: ['POST'], pattern: /^\/students\/(anonymize|purge)$/, permission: 'students.destroy' },
    { methods: ['POST'], pattern: /^\/student\/certificates\/(issue|revoke)$/, permission: 'students.certificates' },
    { methods: ['GET'], pattern: /^\/student\/login-logs$/, permission: 'students.security' },
    // Aba Auditoria da ficha do aluno: só o administrador (decisão P5; antes valia
    // page.students e o professor lia a trilha de qualquer aluno pela API). Fica antes da
    // regra genérica de aluno, porque a primeira regra que casa é a que vale.
    { methods: ['GET'], pattern: /^\/student\/audit$/, permission: 'audit.view' },
    // Tela Auditoria e exportação em CSV (SEG-07, FUN-04).
    { methods: ['GET'], pattern: /^\/audit(?:\/export)?$/, permission: 'audit.view' },
    // Privacidade (LGPD): Termos, Política e encarregado (H8a-1). Só o administrador
    // (students.security é exclusiva dele); fica antes das regras genéricas de aluno.
    { methods: ['GET', 'POST'], pattern: /^\/lgpd(?:\/.*)?$/, permission: 'students.security' },
    { methods: ['GET', 'POST'], pattern: /^\/(students|student(?:\/.*)?|reset-password|delete-student)$/, permission: 'page.students' },
    { methods: ['GET', 'POST'], pattern: /^\/enrollment-requests(?:\/.*)?$/, permission: 'page.students' },
    { methods: ['GET', 'POST'], pattern: /^\/attendance(?:\/.*)?$/, permission: 'page.students' },
    { methods: ['GET', 'POST'], pattern: /^\/announcements(?:\/.*)?$/, permission: 'page.forum' },
    { methods: ['POST'], pattern: /^\/forum\/(resolve|faq|restore)$/, permission: 'page.forum' },
    { methods: ['POST'], pattern: /^\/forum\/purge$/, permission: 'forum.purge' },
    { methods: ['GET', 'POST'], pattern: /^\/library(?:\/.*)?$/, permission: 'page.editor' },


    { methods: ['POST'], pattern: /^\/change-password$/, permission: 'page.dashboard' },
    { methods: ['GET'], pattern: /^\/classes$/, permission: 'page.dashboard' },
    { methods: ['GET'], pattern: /^\/course-summaries$/, permission: 'page.dashboard' },
    { methods: ['POST'], pattern: /^\/class\/(create|update|toggle-registration|delete)$/, permission: 'classes.manage' },
    { methods: ['POST'], pattern: /^\/course\/disciplinas$/, permission: 'course.manage' },
    { methods: ['POST'], pattern: /^\/course\/grade-templates$/, permission: 'course.manage' },
    // Criar, alterar e excluir curso (SEG-12): antes em /api/courses, fora desta guarda
    // e do escopo do professor. O id no caminho é conferido em validateProfessorRequestScope.
    { methods: ['POST'], pattern: /^\/courses$/, permission: 'course.manage' },
    { methods: ['PUT', 'DELETE'], pattern: /^\/courses\/[^/]+$/, permission: 'course.manage' },
    { methods: ['GET'], pattern: /^\/courses\/[^/]+\/structure$/, permission: 'page.editor' },
    { methods: ['POST'], pattern: /^\/courses\/[^/]+\/structure$/, permission: 'page.editor' },
    { methods: ['POST'], pattern: /^\/courses\/[^/]+\/clone$/, permission: 'course.manage' },
    { methods: ['POST'], pattern: /^\/courses\/[^/]+\/purge$/, permission: 'course.purge' },
    { methods: ['GET'], pattern: /^\/archived-courses$/, permission: 'course.manage' },
    { methods: ['POST'], pattern: /^\/archived-courses\/restore$/, permission: 'course.manage' },
    { methods: ['POST'], pattern: /^\/archived-courses\/delete$/, permission: 'course.purge' },
    { methods: ['GET', 'PUT', 'POST'], pattern: /^\/(material|evaluation)(?:\/.*)?$/, permission: 'page.editor' },
    { methods: ['POST'], pattern: /^\/(upload|upload-image)$/, permission: 'page.editor' },
    { methods: ['POST'], pattern: /^\/(server-exam-control|adjust-student-time|assign-student-version|unlock-student-focus|send-broadcast-message)$/, permission: 'page.monitor' },
    { methods: ['GET', 'POST'], pattern: /^\/message-history(?:\/.*)?$/, permission: 'page.monitor' },
    { methods: ['GET', 'POST'], pattern: /^\/question-reports(?:\/.*)?$/, permission: 'page.monitor' },
    { methods: ['POST'], pattern: /^\/(correct-live-question|annul-question|replace-question)$/, permission: 'page.monitor' },
    { methods: ['GET'], pattern: /^\/(monitor-status|monitor-review|proctoring-logs|exam-keystrokes)\/.*$/, permission: 'page.monitor' },
    { methods: ['GET'], pattern: /^\/export-grades\/.*$/, permission: 'page.results' },
    { methods: ['GET'], pattern: /^\/gradebook$/, permission: 'page.results' },
    { methods: ['GET'], pattern: /^\/exam-analytics\/.*$/, permission: 'page.results' },
    { methods: ['GET', 'POST'], pattern: /^\/question-bank(?:\/.*)?$/, permission: 'page.exams' },
    { methods: ['POST'], pattern: /^\/forum\/all$/, permission: 'page.forum' },
    { methods: ['GET', 'POST'], pattern: /^\/preferences$/, permission: 'page.dashboard' },
    { methods: ['GET'], pattern: /^\/dashboard\/students-overview$/, permission: 'page.dashboard' },
    { methods: ['GET'], pattern: /^\/dashboard\/(now|queue|trends)$/, permission: 'page.dashboard' },
    { methods: ['GET', 'POST'], pattern: /^\/notifications(?:\/seen)?$/, permission: 'page.dashboard' },
    // Lista das escolas do escopo (filterSchoolsForAdmin): também para quem vê Turmas sem
    // schools.scope (secretaria, coordenação, professor auxiliar), que não altera escola.
    { methods: ['GET'], pattern: /^\/schools$/, permission: ['schools.scope', 'page.classes'] },
    { methods: ['POST'], pattern: /^\/schools\/update$/, permission: 'schools.scope' },
    { methods: ['POST'], pattern: /^\/schools\/(create|delete)$/, permission: 'branding.manage' },
]);

function resolveAdminApiPermission(method, path) {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const normalizedPath = String(path || '/').split('?')[0];
    const rule = ADMIN_API_PERMISSION_RULES.find(item => item.methods.includes(normalizedMethod) && item.pattern.test(normalizedPath));
    return rule ? rule.permission : undefined;
}

module.exports = {
    ADMIN_PERMISSION_VALUES,
    PROFESSOR_DEFAULT_PERMISSIONS,
    rolePermissionDefaults,
    roleGrantablePermissions,
    normalizeAdditionalPermissions,
    parseAdditionalPermissions,
    isProfessorAccount,
    isFullAdmin,
    accountScopeKind,
    getEffectiveAdminPermissions,
    effectivePermissionList,
    hasAdminCapability,
    adminAccessSummary,
    adminRoleCatalogForScreen,
    canAccessAdminPermission,
    hasAnyAdminPermission,
    resolveAdminApiPermission,
};
