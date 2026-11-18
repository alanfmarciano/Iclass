// Papéis das contas do painel (fase 3, FUN-13; P4-S1). Catálogo único dos papéis:
// rótulo, descrição, escopo ('tudo' | 'turmas' | 'escolas'), permissões padrão,
// concedíveis e se a conta é só de consulta. Só o papel 'admin' é superusuário.
//
// Regra para quem escreve rota (contrato C2 do P4): "só administrador" é isFullAdmin(conta);
// escopo é accountScopeKind(conta). Nunca use isProfessorAccount nem role !== 'professor'
// como "é administrador" (o teste admin-roles-matrix.test.js recusa o padrão antigo).
//
// Este módulo não depende de adminPermissions.js (que depende dele): as listas daqui
// podem citar permissões que ainda não existem em ADMIN_PERMISSION_VALUES; o cálculo da
// conta (adminPermissions.getEffectiveAdminPermissions) usa só as que existem. Assim um
// valor novo (bloco 'fase 3' do B0b) passa a valer para o papel sem mexer neste arquivo.

// Permissões que só o administrador pleno tem: nenhum outro papel recebe nem pode
// receber. audit.view (SEG-07, decisão P5) e students.security (LGPD) continuam aqui;
// students.certificates saiu (pode ser da Secretaria; ao professor continua não indo).
const FULL_ADMIN_ONLY_PERMISSIONS = Object.freeze([
    'page.accounts',
    'accounts.manage',
    'students.destroy',
    'students.security',
    'course.purge',
    'forum.purge',
    'audit.view',
    'students.merge',
    'messages.readAll',
]);

// Nem padrão nem concedível ao professor, mesmo não sendo exclusivas do administrador.
const NEVER_FOR_PROFESSOR = Object.freeze(['students.certificates', 'enrollments.approve']);

const ROLE_CATALOG = Object.freeze([
    Object.freeze({
        id: 'admin',
        rotulo: 'Administrador',
        descricao: 'Acesso a tudo: contas, cópias de segurança, restauração, identidade visual, sistema e todas as turmas.',
        escopo: 'tudo',
        somenteLeitura: false,
        oculto: false,
        // Todas as permissões que existem (calculado em adminPermissions.js).
        permissoesPadrao: '*',
        concediveis: Object.freeze([]),
    }),
    Object.freeze({
        id: 'professor',
        rotulo: 'Professor',
        descricao: 'Turmas atribuídas: provas, notas, conteúdo, chamada, avisos e alunos dessas turmas.',
        escopo: 'turmas',
        somenteLeitura: false,
        oculto: false,
        // O padrão de hoje mais page.classes (a tela já mostrava Turmas ao professor; o
        // servidor passa a dar a consulta, e alterar turma continua com classes.manage) e
        // as permissões da fase 3 que o professor tem desde já (seção rbac do plano):
        // page.assignments, page.messages, reports.view, students.edit e students.import.
        permissoesPadrao: Object.freeze([
            'page.dashboard',
            'page.exams',
            'page.monitor',
            'page.results',
            'page.materials',
            'page.editor',
            'page.classes',
            'page.students',
            'page.forum',
            'schools.scope',
            'page.assignments',
            'page.messages',
            'reports.view',
            'students.edit',
            'students.import',
        ]),
        // Todas as que existem, menos as do administrador pleno e NEVER_FOR_PROFESSOR.
        concediveis: '*',
    }),
    Object.freeze({
        id: 'monitor',
        // Na tela o papel se chama "Professor auxiliar" (contradição X5 do plano: o painel
        // já tem a tela Monitor, da prova ao vivo); o valor gravado continua 'monitor'.
        rotulo: 'Professor auxiliar',
        descricao: 'Turmas atribuídas: chamada e acompanhamento da prova ao vivo. Não lança notas, não mexe em provas, conteúdo nem mensagens.',
        escopo: 'turmas',
        somenteLeitura: false,
        // Fica fora da criação de conta na tela por enquanto (aviso nas notas do Alan).
        oculto: true,
        permissoesPadrao: Object.freeze(['page.dashboard', 'page.classes', 'page.students', 'page.monitor']),
        concediveis: Object.freeze(['page.forum', 'page.materials']),
    }),
    Object.freeze({
        id: 'secretaria',
        rotulo: 'Secretaria',
        descricao: 'Cadastra e importa alunos, aprova matrículas, emite certificados e tira relatórios. Não mexe em provas, conteúdo, backup nem identidade visual.',
        escopo: 'escolas',
        somenteLeitura: false,
        oculto: false,
        permissoesPadrao: Object.freeze([
            'page.dashboard',
            'page.classes',
            'page.students',
            'students.edit',
            'students.import',
            'enrollments.approve',
            'students.certificates',
            'reports.view',
        ]),
        concediveis: Object.freeze(['page.forum', 'page.results']),
    }),
    Object.freeze({
        id: 'coordenacao',
        rotulo: 'Coordenação',
        descricao: 'Consulta turmas, alunos, notas, frequência e relatórios das escolas atribuídas, sem alterar nada.',
        escopo: 'escolas',
        somenteLeitura: true,
        oculto: false,
        permissoesPadrao: Object.freeze([
            'page.dashboard',
            'page.classes',
            'page.students',
            'page.results',
            'page.forum',
            'page.assignments',
            'reports.view',
        ]),
        concediveis: Object.freeze(['page.exams', 'page.materials', 'page.monitor']),
    }),
]);

const ROLE_BY_ID = new Map(ROLE_CATALOG.map(role => [role.id, role]));
const ADMIN_ROLE_IDS = Object.freeze(ROLE_CATALOG.map(role => role.id));
const SCOPE_KINDS = Object.freeze(['tudo', 'turmas', 'escolas']);

// Papel gravado na conta: ausente ou vazio é 'admin' (contas de antes dos papéis, como
// sempre foi). Papel que o catálogo não conhece devolve null: a conta não recebe
// permissão nenhuma em tempo de execução (o boot de database.js continua tratando o
// papel desconhecido gravado como administrador, a regra antiga dos dados).
function accountRoleId(account) {
    if (!account || typeof account !== 'object') return null;
    const raw = account.role;
    if (raw === undefined || raw === null || String(raw).trim() === '') return 'admin';
    const role = String(raw).trim().toLowerCase();
    return ROLE_BY_ID.has(role) ? role : null;
}

function findAdminRole(roleId) {
    return ROLE_BY_ID.get(String(roleId || '').trim().toLowerCase()) || null;
}

function accountRole(account) {
    const id = accountRoleId(account);
    return id ? ROLE_BY_ID.get(id) : null;
}

// Só administrador pleno (contas, backup, restauração, rede, identidade, apagar de vez).
function isFullAdmin(account) {
    return accountRoleId(account) === 'admin';
}

// Escopo da conta: 'tudo' (administrador), 'turmas' (turmas, cursos e escolas atribuídos,
// como o professor de hoje) ou 'escolas' (só as escolas atribuídas). Papel desconhecido
// fica em 'turmas', sem nada atribuído que valha (a conta não tem permissão nenhuma).
function accountScopeKind(account) {
    const role = accountRole(account);
    return role ? role.escopo : 'turmas';
}

function roleScopeKind(roleId) {
    const role = findAdminRole(roleId);
    return role ? role.escopo : 'turmas';
}

function isReadOnlyAccount(account) {
    const role = accountRole(account);
    return !!(role && role.somenteLeitura);
}

function accountRoleLabel(account) {
    const role = accountRole(account);
    return role ? role.rotulo : 'Papel desconhecido';
}

// Somente leitura (D17 do P4): a conta de papel só de consulta recebe 403 em qualquer
// método que não seja de leitura. Ficam de fora o autoatendimento da própria conta e
// as duas leituras que a tela faz por POST (configuração do painel e lista do fórum).
// Caminhos completos (o guarda de /api/admin e as rotas fora dele usam o mesmo teste).
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const READ_ONLY_EXCEPTIONS = Object.freeze([
    '/api/admin/change-password',
    '/api/admin/account/profile',
    '/api/admin/account/end-other-sessions',
    '/api/admin/preferences',
    '/api/admin/notifications/seen',
    '/api/session/logout',
    '/api/admin/config',
    '/api/admin/forum/all',
]);
const READ_ONLY_EXCEPTION_SET = new Set(READ_ONLY_EXCEPTIONS);
const READ_ONLY_REFUSAL = Object.freeze({ error: 'Sua conta é só de consulta.', code: 'read_only_account' });

function requestFullPath(req) {
    const raw = String((req && (req.originalUrl || req.url)) || '/').split('?')[0];
    const trimmed = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
    return trimmed || '/';
}

// Devolve o corpo da recusa (403) ou null quando o pedido pode seguir.
function readOnlyRefusal(req, account) {
    if (!isReadOnlyAccount(account)) return null;
    const method = String((req && req.method) || 'GET').toUpperCase();
    if (READ_METHODS.has(method)) return null;
    if (READ_ONLY_EXCEPTION_SET.has(requestFullPath(req))) return null;
    return { ...READ_ONLY_REFUSAL };
}

module.exports = {
    ROLE_CATALOG,
    ADMIN_ROLE_IDS,
    SCOPE_KINDS,
    FULL_ADMIN_ONLY_PERMISSIONS,
    NEVER_FOR_PROFESSOR,
    READ_ONLY_EXCEPTIONS,
    READ_ONLY_REFUSAL,
    accountRoleId,
    accountRole,
    findAdminRole,
    isFullAdmin,
    accountScopeKind,
    roleScopeKind,
    isReadOnlyAccount,
    accountRoleLabel,
    readOnlyRefusal,
};
