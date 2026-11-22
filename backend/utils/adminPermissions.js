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
    // Fase 3 (B0a, D16 do P4): alterar cadastro de aluno (criar, alterar, lote e senha)
    // separado de page.students, que fica para ver a lista, a ficha e fazer a chamada.
    // Entra aqui, e não no bloco do B0b, porque a divisão de /student(/.*) precisa vir
    // antes da regra genérica de aluno. O professor e a Secretaria têm por padrão.
    'students.edit',
    // ---------------------------------------------------------------- fase 3 (B0b)
    // Valores novos da fase 3 (seção rbac do plano). Entram no fim, para a ordem das
    // listas de hoje (effectivePermissions, catálogo da tela de contas) não mudar. Quem
    // recebe cada um sai do catálogo de papéis (adminRoles.js), que já os cita:
    // - page.assignments (P1, Tarefas): professor e coordenação (consulta);
    // - page.messages (P5, Mensagens): professor; não é do professor auxiliar nem da
    //   coordenação;
    // - messages.readAll (P5): só o administrador pleno lê qualquer conversa (resposta
    //   do Alan: "Sim, com registro"; cada leitura vai para a auditoria);
    // - reports.view (P4, Relatórios): professor (turmas dele), secretaria e coordenação;
    // - students.import (P4, importar planilha): professor (turma dele) e secretaria;
    // - enrollments.approve (P4, aprovar matrícula): secretaria; o professor continua sem
    //   (NEVER_FOR_PROFESSOR) e o administrador sempre tem (hasAdminCapability);
    // - students.merge (P4, mesclar cadastros): só o administrador pleno.
    'page.assignments',
    'page.messages',
    'messages.readAll',
    'reports.view',
    'students.import',
    'enrollments.approve',
    'students.merge',
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

// Quem lê nota de aluno (pendência da J0, B1 da fase 3): a ficha do aluno (boletim,
// histórico e indicadores), o resumo dos alunos e as tendências do Dashboard e a revisão
// da prova no Monitor (acerto e gabarito) só mostram nota a quem tem uma destas: a tela
// Resultados (page.results) ou Relatórios (reports.view, que imprime boletins). O
// professor, a Coordenação e a Secretaria leem; o Professor auxiliar (papel 'monitor',
// contrato rbac.papeis: "sem notas") faz a chamada e acompanha a prova, mas recebe essas
// respostas sem nota. A tela usa a mesma lista (web/src/lib/adminPermissions.js).
const GRADE_READ_PERMISSIONS = Object.freeze(['page.results', 'reports.view']);

function canReadStudentGrades(account) {
    return isFullAdmin(account) || hasAnyAdminPermission(getEffectiveAdminPermissions(account), GRADE_READ_PERMISSIONS);
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
    // Fase 3 (B0b, P3): ações da prova de um aluno, ver o token e corrigir o gabarito depois
    // da prova. Ficam aqui, e não no bloco 'fase 3' do fim, porque são mais específicas que
    // a regra genérica de exam-applications logo abaixo (a primeira que casa é a que vale).
    // Recolher, reabrir e tentativa extra: no Monitor (o professor auxiliar também). Anular
    // e desfazer a anulação mudam nota: além de page.monitor, pedem page.results (o
    // professor tem as duas; o professor auxiliar, que não lança nem muda nota, só a
    // primeira), como corrigir e anular questão na prova ao vivo, mais abaixo. Qualquer
    // ação que não seja uma das três do Monitor pede as duas (bodyExtra).
    {
        methods: ['POST'],
        pattern: /^\/exam-applications\/[^/]+\/attempt-action$/,
        permission: 'page.monitor',
        bodyExtra: { field: 'action', exempt: ['recolher', 'reabrir', 'tentativa_extra'], permission: 'page.results' },
    },
    // Ver o token selado da aplicação (o botão fica no Monitor).
    { methods: ['GET'], pattern: /^\/exam-applications\/[^/]+\/access-token$/, permission: 'page.monitor' },
    // Corrigir o gabarito depois da prova recorrige as notas: page.results. O professor
    // corrige por Resultados ou pelo Monitor (tem as duas); o professor auxiliar, não.
    // O plano dizia ['page.results', 'page.monitor'], o que deixava o professor auxiliar
    // mudar nota; vale o papel (shared_contracts.rbac.papeis: monitor sem notas).
    { methods: ['POST'], pattern: /^\/exam-applications\/[^/]+\/answer-key-correction$/, permission: 'page.results' },
    // Monitor (B1, papel Professor auxiliar): a tela escolhe a prova pela lista das
    // aplicações, inicia, pausa, retoma e encerra pela ação da aplicação e, ao encerrar,
    // lê o resumo de quem ainda está fazendo a prova. Quem tem só page.monitor recebe a
    // lista sempre resumida (sem as versões com o gabarito; a rota decide). O mesmo que a
    // regra antiga de server-exam-control (page.monitor) já deixava fazer sem aplicação.
    { methods: ['GET'], pattern: /^\/exam-applications$/, permission: ['page.exams', 'page.monitor'] },
    { methods: ['GET'], pattern: /^\/exam-applications\/[^/]+\/finish-summary$/, permission: ['page.exams', 'page.monitor'] },
    { methods: ['POST'], pattern: /^\/exam-applications\/[^/]+\/control$/, permission: ['page.exams', 'page.monitor'] },
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
    // Alterar cadastro de aluno (D16 do P4): criar, alterar, matrícula e situação em lote
    // e redefinir a senha pedem students.edit. Ver a lista e a ficha, a chamada, as
    // observações e o desbloqueio do login continuam com page.students (regra genérica
    // logo abaixo). Antes da genérica, porque a primeira regra que casa é a que vale.
    { methods: ['POST'], pattern: /^\/(student\/(create|update|bulk-enroll|bulk-status)|reset-password)$/, permission: 'students.edit' },
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
    // Corrigir gabarito, anular e trocar questão na prova ao vivo mudam nota: pedem
    // page.results (o professor tem as duas; o Professor auxiliar, só page.monitor).
    { methods: ['POST'], pattern: /^\/(correct-live-question|annul-question|replace-question)$/, permission: 'page.results' },
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

    // ---------------------------------------------------------------- fase 3 (B0b)
    // Regras das rotas novas da fase 3 já desenhadas (seção rbac do plano), todas de uma
    // vez, para as trilhas não disputarem este arquivo. Nenhuma casa com rota que já
    // existe. O escopo (turma, curso, escola) continua no guarda e em cada rota.
    // Rotas novas que as regras de cima já cobrem com a permissão certa (não precisam de
    // linha aqui; o teste admin-rbac-catalog.test.js confere a decisão de cada uma):
    // /attendance/diary e /attendance/diary/month (page.students), /submissions/import e
    // /submissions/:id/correction|review-requests/... (page.results), /exam-applications/
    // :id/schedule|participants e /question-bank/import|export (page.exams) e
    // /backup/entregas/recuperar (system.manage). As três de exam-applications que pedem
    // outra permissão ficam antes da regra genérica, lá em cima.
    // Regra mais específica antes da genérica do mesmo prefixo, também dentro do bloco.

    // P1 Tarefas: cadastro, correção, devolução, prazo e entregas (escopo pela turma e
    // pelo curso da tarefa).
    { methods: ['GET', 'POST'], pattern: /^\/assignments(?:\/.*)?$/, permission: 'page.assignments' },

    // P2 Notas e calendário: critérios do curso (alterar é de quem mexe no curso), plano
    // e avaliações manuais da turma, período letivo, encerrar turma e dias não letivos.
    { methods: ['GET'], pattern: /^\/grading\/criteria$/, permission: 'page.results' },
    { methods: ['POST'], pattern: /^\/grading\/criteria$/, permission: 'course.manage' },
    { methods: ['GET', 'POST'], pattern: /^\/grading\/(plan|preview|manual-items(?:\/.*)?)$/, permission: 'page.results' },
    { methods: ['GET'], pattern: /^\/academic\/terms$/, permission: 'page.dashboard' },
    { methods: ['POST'], pattern: /^\/academic\/terms(?:\/.*)?$/, permission: 'classes.manage' },
    { methods: ['POST'], pattern: /^\/class\/(close|reopen)$/, permission: 'classes.manage' },
    // A mesma permissão do Calendário; quem pode cadastrar dia de toda a escola, do curso
    // ou da turma a rota decide pelo escopo do dia.
    { methods: ['GET', 'POST'], pattern: /^\/calendar\/non-school-days(?:\/.*)?$/, permission: 'page.forum' },
    { methods: ['GET'], pattern: /^\/calendar\/ics$/, permission: 'page.forum' },

    // P3 Correção: fila de correção (as rotas de uma entrega ficam na regra /submissions).
    { methods: ['GET', 'POST'], pattern: /^\/corrections(?:\/.*)?$/, permission: 'page.results' },

    // P4 Secretaria: relatórios, importação e mesclagem de alunos, aluno pelo id,
    // certificados, pacote de curso, Minha conta e redefinir a senha de outra conta.
    { methods: ['GET', 'POST'], pattern: /^\/reports(?:\/.*)?$/, permission: 'reports.view' },
    { methods: ['GET', 'POST'], pattern: /^\/students\/import(?:\/.*)?$/, permission: 'students.import' },
    { methods: ['GET', 'POST'], pattern: /^\/students\/merge(?:\/.*)?$/, permission: 'students.merge' },
    { methods: ['GET'], pattern: /^\/students\/by-id\/[^/]+$/, permission: 'page.students' },
    { methods: ['GET', 'POST'], pattern: /^\/certificates(?:\/.*)?$/, permission: 'students.certificates' },
    { methods: ['GET'], pattern: /^\/courses\/[^/]+\/package$/, permission: 'course.manage' },
    { methods: ['POST'], pattern: /^\/course-packages\/(preview|import)$/, permission: 'course.manage' },
    // Autoatendimento da própria conta: todo papel tem page.dashboard (e o somente leitura
    // deixa passar, adminRoles.READ_ONLY_EXCEPTIONS).
    { methods: ['POST'], pattern: /^\/account\/(profile|end-other-sessions)$/, permission: 'page.dashboard' },
    { methods: ['POST'], pattern: /^\/accounts\/reset-password$/, permission: 'accounts.manage' },

    // P5 Alunos e comunicação: grupos, ver como aluno, mensagens e responsáveis. Abrir a
    // conversa dos outros (admin-open) é só de quem lê todas; vem antes da genérica.
    { methods: ['GET', 'POST'], pattern: /^\/class-groups(?:\/.*)?$/, permission: 'page.students' },
    { methods: ['POST'], pattern: /^\/preview-sessions(?:\/end)?$/, permission: ['page.materials', 'page.classes'] },
    { methods: ['POST'], pattern: /^\/conversations\/[^/]+\/admin-open$/, permission: 'messages.readAll' },
    { methods: ['GET', 'POST'], pattern: /^\/conversations(?:\/.*)?$/, permission: 'page.messages' },
    { methods: ['GET'], pattern: /^\/guardian-notices(?:\/.*)?$/, permission: 'page.students' },
    { methods: ['GET', 'POST'], pattern: /^\/guardian-contacts(?:\/.*)?$/, permission: 'page.students' },

    // P6 Instalação: Sobre o IClass, primeiros passos, assistente e curso de exemplo (as
    // pastas, o assistente e o curso de exemplo são só do administrador, na rota).
    { methods: ['GET'], pattern: /^\/system\/about$/, permission: 'page.system' },
    { methods: ['GET'], pattern: /^\/setup\/checklist$/, permission: 'page.dashboard' },
    { methods: ['POST'], pattern: /^\/setup\/wizard$/, permission: 'system.manage' },
    { methods: ['POST'], pattern: /^\/setup\/example-course$/, permission: 'course.manage' },
]);

// Caminho de /api/admin como o Express 5 o casa com as rotas: sem a query string, sem
// diferença entre maiúsculas e minúsculas e com a barra no fim opcional ('/student/Update'
// e '/student/update/' rodam a rota '/student/update'). O guarda decide sobre esta forma;
// antes comparava o caminho cru, e uma variante caía numa regra genérica mais frouxa (o
// professor auxiliar alterava aluno por '/student/Update', o professor emitia certificado
// por '/student/certificates/issue/'). trimAdminPath guarda a caixa, para os ids do
// caminho (curso, conteúdo, turma); canonicalAdminPath é a forma de comparar.
function trimAdminPath(path) {
    const raw = String(path || '/').split('?')[0];
    return raw.replace(/\/+$/, '') || '/';
}

function canonicalAdminPath(path) {
    return trimAdminPath(path).toLowerCase();
}

function findAdminApiRule(method, path) {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const normalizedPath = canonicalAdminPath(path);
    return ADMIN_API_PERMISSION_RULES.find(item => item.methods.includes(normalizedMethod) && item.pattern.test(normalizedPath));
}

function resolveAdminApiPermission(method, path) {
    const rule = findAdminApiRule(method, path);
    return rule ? rule.permission : undefined;
}

// Permissão a mais que o corpo do pedido exige, além da regra (bodyExtra): numa rota que
// junta ações de peso diferente (attempt-action: recolher no Monitor x anular, que muda
// nota). O valor do campo é comparado sem caixa nem espaço; campo ausente ou vazio não
// pede nada a mais (a rota recusa a ação que falta). Devolve null quando não há.
function resolveAdminApiExtraPermission(method, path, body) {
    const rule = findAdminApiRule(method, path);
    if (!rule || !rule.bodyExtra) return null;
    const raw = body && typeof body === 'object' ? body[rule.bodyExtra.field] : undefined;
    if (raw === undefined || raw === null) return null;
    const value = String(raw).trim().toLowerCase();
    if (!value || rule.bodyExtra.exempt.includes(value)) return null;
    return rule.bodyExtra.permission;
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
    GRADE_READ_PERMISSIONS,
    canReadStudentGrades,
    adminAccessSummary,
    adminRoleCatalogForScreen,
    canAccessAdminPermission,
    hasAnyAdminPermission,
    resolveAdminApiPermission,
    resolveAdminApiExtraPermission,
    trimAdminPath,
    canonicalAdminPath,
};
