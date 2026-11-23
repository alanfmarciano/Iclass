export const ADMIN_PERMISSIONS = Object.freeze({
  PAGE_DASHBOARD: 'page.dashboard',
  PAGE_EXAMS: 'page.exams',
  PAGE_MONITOR: 'page.monitor',
  PAGE_RESULTS: 'page.results',
  PAGE_MATERIALS: 'page.materials',
  PAGE_EDITOR: 'page.editor',
  PAGE_CLASSES: 'page.classes',
  PAGE_STUDENTS: 'page.students',
  PAGE_ACCOUNTS: 'page.accounts',
  PAGE_FORUM: 'page.forum',
  PAGE_BRANDING: 'page.branding',
  PAGE_SYSTEM: 'page.system',
  COURSE_MANAGE: 'course.manage',
  CLASSES_MANAGE: 'classes.manage',
  ACCOUNTS_MANAGE: 'accounts.manage',
  BRANDING_MANAGE: 'branding.manage',
  SYSTEM_MANAGE: 'system.manage',
  SCHOOLS_SCOPE: 'schools.scope',
  // Tela Auditoria e aba Auditoria da ficha do aluno: só o administrador (decisão P5);
  // não é concedível ao professor (o servidor responde 403).
  AUDIT_VIEW: 'audit.view',
  // Página Privacidade (LGPD): Termos, Política e encarregado (H8a-1). Só o
  // administrador; não é concedível ao professor (o servidor responde 403).
  STUDENTS_SECURITY: 'students.security',
  // Cadastros encerrados (H7c): anonimizar e apagar de vez, só o administrador; não é
  // concedível ao professor (o servidor responde 403).
  STUDENTS_DESTROY: 'students.destroy',
  // Fase 3 (papéis, FUN-13): os mesmos valores do servidor (ADMIN_PERMISSION_VALUES de
  // backend/utils/adminPermissions.js; o teste professor-permissions-snapshot confere).
  STUDENTS_EDIT: 'students.edit',
  STUDENTS_IMPORT: 'students.import',
  STUDENTS_CERTIFICATES: 'students.certificates',
  STUDENTS_MERGE: 'students.merge',
  ENROLLMENTS_APPROVE: 'enrollments.approve',
  REPORTS_VIEW: 'reports.view',
  PAGE_ASSIGNMENTS: 'page.assignments',
  PAGE_MESSAGES: 'page.messages',
  MESSAGES_READ_ALL: 'messages.readAll',
  COURSE_PURGE: 'course.purge',
  FORUM_PURGE: 'forum.purge',
})

export const ADMIN_PATH_PERMISSIONS = Object.freeze({
  '/': ADMIN_PERMISSIONS.PAGE_DASHBOARD,
  // Minha conta do instrutor (UXI-07): todo papel tem page.dashboard.
  '/minha-conta': ADMIN_PERMISSIONS.PAGE_DASHBOARD,
  // Endereço da sala em tela cheia, para projetar (H6a).
  '/endereco': ADMIN_PERMISSIONS.PAGE_DASHBOARD,
  '/provas': ADMIN_PERMISSIONS.PAGE_EXAMS,
  '/monitor': ADMIN_PERMISSIONS.PAGE_MONITOR,
  '/resultados': ADMIN_PERMISSIONS.PAGE_RESULTS,
  '/materiais': ADMIN_PERMISSIONS.PAGE_MATERIALS,
  '/editor': ADMIN_PERMISSIONS.PAGE_EDITOR,
  '/biblioteca': ADMIN_PERMISSIONS.PAGE_EDITOR,
  '/turmas': ADMIN_PERMISSIONS.PAGE_CLASSES,
  '/alunos': ADMIN_PERMISSIONS.PAGE_STUDENTS,
  // Aprovar matrícula (P4 D16): administrador e Secretaria; antes era "não é professor".
  '/matriculas': ADMIN_PERMISSIONS.ENROLLMENTS_APPROVE,
  '/chamada': ADMIN_PERMISSIONS.PAGE_STUDENTS,
  '/diretorio': ADMIN_PERMISSIONS.PAGE_STUDENTS,
  '/admins': ADMIN_PERMISSIONS.PAGE_ACCOUNTS,
  '/avisos': ADMIN_PERMISSIONS.PAGE_FORUM,
  '/calendario': ADMIN_PERMISSIONS.PAGE_FORUM,
  '/forum': ADMIN_PERMISSIONS.PAGE_FORUM,
  '/escolas': ADMIN_PERMISSIONS.PAGE_BRANDING,
  '/identidade': ADMIN_PERMISSIONS.SCHOOLS_SCOPE,
  '/sistema': ADMIN_PERMISSIONS.PAGE_SYSTEM,
  '/auditoria': ADMIN_PERMISSIONS.AUDIT_VIEW,
  '/lgpd': ADMIN_PERMISSIONS.STUDENTS_SECURITY,
  '/encerrados': ADMIN_PERMISSIONS.STUDENTS_DESTROY,
})

// Padrão do professor, só para a sessão guardada por uma versão anterior, que ainda não
// tem effectivePermissions (o whoami da abertura completa logo depois). A lista que vale
// é a do servidor (auth.effectivePermissions), igual a esta para o professor sem extras.
const PROFESSOR_DEFAULT_PERMISSIONS = Object.freeze([
  ADMIN_PERMISSIONS.PAGE_DASHBOARD,
  ADMIN_PERMISSIONS.PAGE_EXAMS,
  ADMIN_PERMISSIONS.PAGE_MONITOR,
  ADMIN_PERMISSIONS.PAGE_RESULTS,
  ADMIN_PERMISSIONS.PAGE_MATERIALS,
  ADMIN_PERMISSIONS.PAGE_EDITOR,
  ADMIN_PERMISSIONS.PAGE_CLASSES,
  ADMIN_PERMISSIONS.PAGE_STUDENTS,
  ADMIN_PERMISSIONS.PAGE_FORUM,
  ADMIN_PERMISSIONS.SCHOOLS_SCOPE,
  ADMIN_PERMISSIONS.PAGE_ASSIGNMENTS,
  ADMIN_PERMISSIONS.PAGE_MESSAGES,
  ADMIN_PERMISSIONS.REPORTS_VIEW,
  ADMIN_PERMISSIONS.STUDENTS_EDIT,
  ADMIN_PERMISSIONS.STUDENTS_IMPORT,
])

const ACTION_DEPENDENCIES = Object.freeze({
  [ADMIN_PERMISSIONS.CLASSES_MANAGE]: ADMIN_PERMISSIONS.PAGE_CLASSES,
  [ADMIN_PERMISSIONS.ACCOUNTS_MANAGE]: ADMIN_PERMISSIONS.PAGE_ACCOUNTS,
  [ADMIN_PERMISSIONS.BRANDING_MANAGE]: ADMIN_PERMISSIONS.PAGE_BRANDING,
  [ADMIN_PERMISSIONS.SYSTEM_MANAGE]: ADMIN_PERMISSIONS.PAGE_SYSTEM,
})

// Rótulo de cada permissão que pode ser dada a mais a uma conta (tela Contas). Quais
// aparecem para cada papel vem do servidor (GET /api/admin/roles: concediveis menos
// permissoesPadrao do papel); a ordem é a desta lista.
export const GRANTABLE_ADMIN_PERMISSIONS = Object.freeze([
  { permission: ADMIN_PERMISSIONS.PAGE_DASHBOARD, group: 'Visão geral', label: 'Dashboard', description: 'Exibe o Dashboard da turma e as listas de turmas e cursos.' },
  { permission: ADMIN_PERMISSIONS.PAGE_EXAMS, group: 'Provas', label: 'Visualizar e preparar provas', description: 'Exibe a tela Provas: aplicações, versões e liberação.' },
  { permission: ADMIN_PERMISSIONS.PAGE_MONITOR, group: 'Provas', label: 'Monitor Online', description: 'Acompanha a prova ao vivo (presença, tempo e foco dos alunos).' },
  { permission: ADMIN_PERMISSIONS.PAGE_RESULTS, group: 'Notas', label: 'Resultados', description: 'Vê e lança notas, corrige e libera os resultados para os alunos.' },
  { permission: ADMIN_PERMISSIONS.PAGE_MATERIALS, group: 'Conteúdo', label: 'Materiais e liberação', description: 'Libera e esconde materiais e avaliações para a turma.' },
  { permission: ADMIN_PERMISSIONS.PAGE_EDITOR, group: 'Conteúdo', label: 'Editor e Biblioteca', description: 'Edita apostilas, avaliações e a biblioteca de arquivos.' },
  { permission: ADMIN_PERMISSIONS.PAGE_STUDENTS, group: 'Alunos', label: 'Alunos e chamada', description: 'Vê a lista e a ficha dos alunos e faz a chamada.' },
  { permission: ADMIN_PERMISSIONS.STUDENTS_EDIT, group: 'Alunos', label: 'Alterar cadastro', description: 'Cria e altera alunos, faz a matrícula em lote e redefine a senha do aluno.' },
  { permission: ADMIN_PERMISSIONS.STUDENTS_IMPORT, group: 'Alunos', label: 'Importar planilha', description: 'Importa alunos por planilha.' },
  { permission: ADMIN_PERMISSIONS.PAGE_FORUM, group: 'Comunicação', label: 'Avisos, calendário e fórum', description: 'Escreve avisos e eventos e responde o fórum da turma.' },
  { permission: ADMIN_PERMISSIONS.PAGE_ASSIGNMENTS, group: 'Comunicação', label: 'Tarefas', description: 'Exibe a tela Tarefas.' },
  { permission: ADMIN_PERMISSIONS.PAGE_MESSAGES, group: 'Comunicação', label: 'Mensagens', description: 'Exibe a tela Mensagens com os alunos.' },
  { permission: ADMIN_PERMISSIONS.REPORTS_VIEW, group: 'Relatórios', label: 'Relatórios', description: 'Tira relatórios e boletins das turmas da conta.' },
  { permission: ADMIN_PERMISSIONS.SCHOOLS_SCOPE, group: 'Escolas', label: 'Identidade da escola', description: 'Ajusta a identidade visual das escolas atribuídas.' },
  { permission: ADMIN_PERMISSIONS.PAGE_CLASSES, group: 'Turmas', label: 'Visualizar tela', description: 'Exibe a página de turmas em modo consulta.' },
  { permission: ADMIN_PERMISSIONS.CLASSES_MANAGE, group: 'Turmas', label: 'Gerenciar turmas', description: 'Exibe ações de criação, alteração e exclusão de turmas.' },
  { permission: ADMIN_PERMISSIONS.PAGE_ACCOUNTS, group: 'Contas', label: 'Visualizar tela', description: 'Exibe a lista de contas administrativas.' },
  { permission: ADMIN_PERMISSIONS.ACCOUNTS_MANAGE, group: 'Contas', label: 'Gerenciar contas', description: 'Exibe ações para criar, editar e remover contas.' },
  { permission: ADMIN_PERMISSIONS.PAGE_BRANDING, group: 'Identidade', label: 'Visualizar tela', description: 'Exibe as configurações de identidade visual.' },
  { permission: ADMIN_PERMISSIONS.BRANDING_MANAGE, group: 'Identidade', label: 'Alterar identidade', description: 'Permite usar os controles de edição visual.' },
  { permission: ADMIN_PERMISSIONS.PAGE_SYSTEM, group: 'Sistema', label: 'Visualizar tela', description: 'Exibe informações de rede e manutenção.' },
  { permission: ADMIN_PERMISSIONS.SYSTEM_MANAGE, group: 'Sistema', label: 'Executar manutenção', description: 'Libera configurações, lixeira, reinício do servidor, limpeza e reset da sala e gerar cópia de segurança no servidor. Baixar e restaurar backup continua só do administrador.' },
  { permission: ADMIN_PERMISSIONS.COURSE_MANAGE, group: 'Cursos', label: 'Gerenciar cursos', description: 'Exibe criação, edição, exclusão e restauração de cursos.' },
])

const ALL_ADMIN_PERMISSIONS = new Set([
  ...Object.values(ADMIN_PERMISSIONS),
])

// Valor gravado do papel de professor. Comparar o papel com ele fica só aqui
// (isProfessorRoleAccount e a reserva da sessão antiga, logo abaixo): nas telas, "é
// administrador" é isFullAdmin e o resto é permissão (guarda UC-PAPEIS-003, sem exceções).
const PROFESSOR_ROLE_ID = 'professor'

// Papel da conta do painel: sessão sem papel (de antes dos papéis) é administrador.
export function accountRoleOf(auth) {
  const role = String(auth?.accountRole || '').trim().toLowerCase()
  return role || 'admin'
}

// Só administrador pleno (contas, backup, restauração, rede, apagar de vez, lixeira,
// dados de acessibilidade). Contrato C2 do P4: a tela nunca usa "não é professor" como
// "é administrador"; o escopo e o resto vêm de effectivePermissions.
export function isFullAdmin(auth) {
  return accountRoleOf(auth) === 'admin'
}

// Conjunto efetivo da conta: o do servidor (effectivePermissions do whoami e do login,
// D18 do P4). Sessão guardada por uma versão anterior, sem a lista: o administrador tem
// tudo e o professor o padrão de antes (o whoami da abertura troca pela lista do
// servidor); outro papel sem a lista não tem nada.
export function getEffectiveAdminPermissions(auth) {
  if (Array.isArray(auth?.effectivePermissions)) return new Set(auth.effectivePermissions)
  const role = accountRoleOf(auth)
  if (role === 'admin') return new Set(ALL_ADMIN_PERMISSIONS)
  if (role === PROFESSOR_ROLE_ID) {
    return new Set([
      ...PROFESSOR_DEFAULT_PERMISSIONS,
      ...(Array.isArray(auth?.additionalPermissions) ? auth.additionalPermissions : []),
    ])
  }
  return new Set()
}

// Quem lê nota de aluno: a mesma lista do servidor (GRADE_READ_PERMISSIONS de
// backend/utils/adminPermissions.js). O Professor auxiliar não tem nenhuma: a ficha, o
// Dashboard e o Monitor aparecem sem nota para ele.
export const GRADE_READ_PERMISSIONS = Object.freeze([ADMIN_PERMISSIONS.PAGE_RESULTS, ADMIN_PERMISSIONS.REPORTS_VIEW])

export function canReadStudentGrades(auth) {
  if (isFullAdmin(auth)) return true
  const permissions = getEffectiveAdminPermissions(auth)
  return GRADE_READ_PERMISSIONS.some((permission) => permissions.has(permission))
}

// Rótulo do papel para o topo e para Minha conta: o do servidor (roleLabel); sessão
// antiga sem ele, o de antes.
export function accountRoleLabel(auth) {
  if (auth?.roleLabel) return auth.roleLabel
  return accountRoleOf(auth) === PROFESSOR_ROLE_ID ? 'Professor' : isFullAdmin(auth) ? 'Administrador' : 'Conta do painel'
}

// A permissão pode ser uma lista (qualquer uma basta), como nas regras do servidor.
export function canAccessAdminPermission(auth, permission) {
  const permissions = getEffectiveAdminPermissions(auth)
  return (Array.isArray(permission) ? permission : [permission]).some((item) => permissions.has(item))
}

// Papéis só de consulta (somenteLeitura no catálogo de backend/utils/adminRoles.js): a
// reserva para a sessão guardada por uma versão anterior, sem o readOnly do whoami (a
// abertura troca pelo valor do servidor).
const READ_ONLY_ROLE_FALLBACK = new Set(['coordenacao'])

// Conta só de consulta (Coordenação, D17 do P4): o servidor recusa todo POST com 403
// read_only_account, fora do autoatendimento da própria conta. Vale o readOnly do whoami
// e do login (B0a); a tela nunca mostra botão de gravar a essa conta.
export function isReadOnlyAccount(auth) {
  if (typeof auth?.readOnly === 'boolean') return auth.readOnly
  return READ_ONLY_ROLE_FALLBACK.has(accountRoleOf(auth))
}

// A conta pode GRAVAR com esta permissão: tem a permissão e não é só de consulta. Os
// botões que alteram (lançar nota, publicar, salvar chamada, publicar aviso, criar
// evento, responder no fórum) usam esta conferência; ver usa canAccessAdminPermission.
export function canWriteAdminPermission(auth, permission) {
  return canAccessAdminPermission(auth, permission) && !isReadOnlyAccount(auth)
}

export function canAccessAdminPath(auth, pathname) {
  const cleanPath = pathname === '/' ? '/' : String(pathname || '').replace(/\/+$/, '')
  const permission = ADMIN_PATH_PERMISSIONS[cleanPath]
  return !permission || canAccessAdminPermission(auth, permission)
}

export function toggleAdditionalPermission(current, permission) {
  const next = new Set(Array.isArray(current) ? current : [])
  if (next.has(permission)) {
    next.delete(permission)
    Object.entries(ACTION_DEPENDENCIES).forEach(([action, page]) => {
      if (page === permission) next.delete(action)
    })
  } else {
    next.add(permission)
    const dependency = ACTION_DEPENDENCIES[permission]
    if (dependency) next.add(dependency)
  }
  return [...next]
}

export function permissionLabel(permission) {
  const option = GRANTABLE_ADMIN_PERMISSIONS.find(item => item.permission === permission)
  return option ? `${option.group}: ${option.label}` : permission
}

// O que a sessão do painel guarda da conta (whoami e login): papel, escopo atribuído e o
// que a conta pode, calculado pelo servidor (effectivePermissions, scopeKind, readOnly e
// roleLabel; D18 do P4), mais o nome para o avatar e Minha conta (UXI-07). A tela não
// recalcula as permissões (lib/adminPermissions.js lê effectivePermissions).
export function adminAccountFields(who = {}) {
  return {
    name: typeof who.name === 'string' ? who.name : '',
    accountRole: who.role || 'admin',
    assignedClasses: who.assignedClasses || [],
    assignedCourseIds: who.assignedCourseIds || [],
    assignedSchoolIds: who.assignedSchoolIds || [],
    additionalPermissions: who.additionalPermissions || [],
    ...(Array.isArray(who.effectivePermissions) ? { effectivePermissions: who.effectivePermissions } : {}),
    ...(who.scopeKind ? { scopeKind: who.scopeKind } : {}),
    ...(typeof who.readOnly === 'boolean' ? { readOnly: who.readOnly } : {}),
    ...(who.roleLabel ? { roleLabel: who.roleLabel } : {}),
  }
}

// Papéis das contas do painel (FUN-13). A lista que vale vem do servidor (GET
// /api/admin/roles, catálogo de backend/utils/adminRoles.js: rótulo, descrição, escopo,
// permissões padrão e concedíveis); esta é só a reserva de rótulo e escopo para a tela
// não ficar sem nome enquanto o catálogo carrega.
export const ADMIN_ROLE_FALLBACK = Object.freeze([
  { id: 'admin', rotulo: 'Administrador', escopo: 'tudo' },
  { id: 'professor', rotulo: 'Professor', escopo: 'turmas' },
  { id: 'monitor', rotulo: 'Professor auxiliar', escopo: 'turmas' },
  { id: 'secretaria', rotulo: 'Secretaria', escopo: 'escolas' },
  { id: 'coordenacao', rotulo: 'Coordenação', escopo: 'escolas' },
])

// Papel da linha da lista de contas (conta sem papel é administrador).
export function accountRoleId(account) {
  return String(account?.role || '').trim().toLowerCase() || 'admin'
}

// Conta da lista de contas que é de professor: as telas que atribuem turma ou horário a
// professores (Turmas, Assistente de horários) listam só essas. Não é "é administrador".
export function isProfessorRoleAccount(account) {
  return accountRoleId(account) === PROFESSOR_ROLE_ID
}

export function findRole(roles, roleId) {
  const id = String(roleId || '').trim().toLowerCase() || 'admin'
  return (Array.isArray(roles) ? roles : []).find((role) => role.id === id)
    || ADMIN_ROLE_FALLBACK.find((role) => role.id === id)
    || null
}

export function roleLabelOf(roles, roleId) {
  return findRole(roles, roleId)?.rotulo || 'Papel desconhecido'
}

export function roleScopeOf(roles, roleId) {
  return findRole(roles, roleId)?.escopo || 'turmas'
}

// Permissões que a tela de contas oferece a mais para o papel: as concedíveis do
// catálogo que ainda não vêm no padrão, na ordem de GRANTABLE_ADMIN_PERMISSIONS (com
// rótulo); a do catálogo sem rótulo aparece com o próprio valor no fim.
export function grantableOptionsForRole(roles, roleId) {
  const role = findRole(roles, roleId)
  if (!role || !Array.isArray(role.concediveis)) return []
  const defaults = new Set(Array.isArray(role.permissoesPadrao) ? role.permissoesPadrao : [])
  const offered = role.concediveis.filter((permission) => !defaults.has(permission))
  const known = GRANTABLE_ADMIN_PERMISSIONS.filter((item) => offered.includes(item.permission))
  const unknown = offered
    .filter((permission) => !GRANTABLE_ADMIN_PERMISSIONS.some((item) => item.permission === permission))
    .map((permission) => ({ permission, group: 'Outras', label: permission, description: '' }))
  return [...known, ...unknown]
}
