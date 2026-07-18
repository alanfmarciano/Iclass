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
})

export const ADMIN_PATH_PERMISSIONS = Object.freeze({
  '/': ADMIN_PERMISSIONS.PAGE_DASHBOARD,
  '/provas': ADMIN_PERMISSIONS.PAGE_EXAMS,
  '/monitor': ADMIN_PERMISSIONS.PAGE_MONITOR,
  '/resultados': ADMIN_PERMISSIONS.PAGE_RESULTS,
  '/materiais': ADMIN_PERMISSIONS.PAGE_MATERIALS,
  '/editor': ADMIN_PERMISSIONS.PAGE_EDITOR,
  '/biblioteca': ADMIN_PERMISSIONS.PAGE_EDITOR,
  '/turmas': ADMIN_PERMISSIONS.PAGE_CLASSES,
  '/alunos': ADMIN_PERMISSIONS.PAGE_STUDENTS,
  '/matriculas': ADMIN_PERMISSIONS.PAGE_STUDENTS,
  '/chamada': ADMIN_PERMISSIONS.PAGE_STUDENTS,
  '/diretorio': ADMIN_PERMISSIONS.PAGE_STUDENTS,
  '/admins': ADMIN_PERMISSIONS.PAGE_ACCOUNTS,
  '/avisos': ADMIN_PERMISSIONS.PAGE_FORUM,
  '/calendario': ADMIN_PERMISSIONS.PAGE_FORUM,
  '/forum': ADMIN_PERMISSIONS.PAGE_FORUM,
  '/escolas': ADMIN_PERMISSIONS.PAGE_BRANDING,
  '/identidade': ADMIN_PERMISSIONS.SCHOOLS_SCOPE,
  '/sistema': ADMIN_PERMISSIONS.PAGE_SYSTEM,
})

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
])

const ACTION_DEPENDENCIES = Object.freeze({
  [ADMIN_PERMISSIONS.CLASSES_MANAGE]: ADMIN_PERMISSIONS.PAGE_CLASSES,
  [ADMIN_PERMISSIONS.ACCOUNTS_MANAGE]: ADMIN_PERMISSIONS.PAGE_ACCOUNTS,
  [ADMIN_PERMISSIONS.BRANDING_MANAGE]: ADMIN_PERMISSIONS.PAGE_BRANDING,
  [ADMIN_PERMISSIONS.SYSTEM_MANAGE]: ADMIN_PERMISSIONS.PAGE_SYSTEM,
})

export const GRANTABLE_ADMIN_PERMISSIONS = Object.freeze([
  { permission: ADMIN_PERMISSIONS.PAGE_CLASSES, group: 'Turmas', label: 'Visualizar tela', description: 'Exibe a página de turmas em modo consulta.' },
  { permission: ADMIN_PERMISSIONS.CLASSES_MANAGE, group: 'Turmas', label: 'Gerenciar turmas', description: 'Exibe ações de criação, alteração e exclusão de turmas.' },
  { permission: ADMIN_PERMISSIONS.PAGE_ACCOUNTS, group: 'Contas', label: 'Visualizar tela', description: 'Exibe a lista de contas administrativas.' },
  { permission: ADMIN_PERMISSIONS.ACCOUNTS_MANAGE, group: 'Contas', label: 'Gerenciar contas', description: 'Exibe ações para criar, editar e remover contas.' },
  { permission: ADMIN_PERMISSIONS.PAGE_BRANDING, group: 'Identidade', label: 'Visualizar tela', description: 'Exibe as configurações de identidade visual.' },
  { permission: ADMIN_PERMISSIONS.BRANDING_MANAGE, group: 'Identidade', label: 'Alterar identidade', description: 'Permite usar os controles de edição visual.' },
  { permission: ADMIN_PERMISSIONS.PAGE_SYSTEM, group: 'Sistema', label: 'Visualizar tela', description: 'Exibe informações de rede e manutenção.' },
  { permission: ADMIN_PERMISSIONS.SYSTEM_MANAGE, group: 'Sistema', label: 'Executar manutenção', description: 'Exibe reinício, limpeza e reset da sala.' },
  { permission: ADMIN_PERMISSIONS.COURSE_MANAGE, group: 'Cursos', label: 'Gerenciar cursos', description: 'Exibe criação, edição, exclusão e restauração de cursos.' },
])

const ALL_ADMIN_PERMISSIONS = new Set([
  ...Object.values(ADMIN_PERMISSIONS),
])

export function getEffectiveAdminPermissions(auth) {
  const accountRole = auth?.accountRole || 'admin'
  if (accountRole !== 'professor') return new Set(ALL_ADMIN_PERMISSIONS)
  return new Set([
    ...PROFESSOR_DEFAULT_PERMISSIONS,
    ...(Array.isArray(auth?.additionalPermissions) ? auth.additionalPermissions : []),
  ])
}

export function canAccessAdminPermission(auth, permission) {
  return getEffectiveAdminPermissions(auth).has(permission)
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
