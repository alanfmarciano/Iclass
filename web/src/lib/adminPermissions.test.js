import { describe, expect, it } from 'vitest'
import {
  ADMIN_PATH_PERMISSIONS,
  ADMIN_PERMISSIONS,
  accountRoleLabel,
  adminAccountFields,
  canAccessAdminPath,
  canAccessAdminPermission,
  canReadStudentGrades,
  getEffectiveAdminPermissions,
  grantableOptionsForRole,
  isFullAdmin,
  roleLabelOf,
  roleScopeOf,
} from './adminPermissions'

// Papéis na tela (fase 3, B1; FUN-13, contrato C2): o painel usa a lista que o servidor
// manda (effectivePermissions do whoami e do login), não "papel diferente de professor é
// administrador". Antes, a Secretaria e a Coordenação viam o painel como administrador.
const secretaria = {
  accountRole: 'secretaria',
  effectivePermissions: ['page.dashboard', 'page.classes', 'page.students', 'students.edit', 'students.import', 'enrollments.approve', 'students.certificates', 'reports.view'],
  scopeKind: 'escolas',
  readOnly: false,
  roleLabel: 'Secretaria',
}
const monitor = {
  accountRole: 'monitor',
  effectivePermissions: ['page.dashboard', 'page.classes', 'page.students', 'page.monitor'],
  scopeKind: 'turmas',
  readOnly: false,
  roleLabel: 'Professor auxiliar',
}

describe('[UC-PAPEIS-004] permissões da tela pela lista do servidor', () => {
  it('a Secretaria não é administrador pleno nem ganha contas, backup ou sistema', () => {
    expect(isFullAdmin(secretaria)).toBe(false)
    expect(canAccessAdminPermission(secretaria, ADMIN_PERMISSIONS.ACCOUNTS_MANAGE)).toBe(false)
    expect(canAccessAdminPath(secretaria, '/admins')).toBe(false)
    expect(canAccessAdminPath(secretaria, '/sistema')).toBe(false)
    expect(canAccessAdminPath(secretaria, '/matriculas')).toBe(true)
    expect(canAccessAdminPath(secretaria, '/minha-conta')).toBe(true)
  })

  it('effectivePermissions vale mais que o papel: o professor com a lista do servidor fica com ela', () => {
    const auth = { accountRole: 'professor', effectivePermissions: ['page.dashboard'] }
    expect([...getEffectiveAdminPermissions(auth)]).toEqual(['page.dashboard'])
    expect(canAccessAdminPermission(auth, ADMIN_PERMISSIONS.PAGE_RESULTS)).toBe(false)
  })

  it('sessão guardada antes da lista: administrador tem tudo, professor o padrão, outro papel nada', () => {
    expect(getEffectiveAdminPermissions({ accountRole: 'admin' }).has(ADMIN_PERMISSIONS.ACCOUNTS_MANAGE)).toBe(true)
    expect(getEffectiveAdminPermissions({}).has(ADMIN_PERMISSIONS.ACCOUNTS_MANAGE)).toBe(true)
    const professor = getEffectiveAdminPermissions({ accountRole: 'professor', additionalPermissions: ['page.accounts'] })
    expect(professor.has(ADMIN_PERMISSIONS.PAGE_RESULTS)).toBe(true)
    expect(professor.has('page.accounts')).toBe(true)
    expect(professor.has(ADMIN_PERMISSIONS.ACCOUNTS_MANAGE)).toBe(false)
    expect(getEffectiveAdminPermissions({ accountRole: 'coordenacao' }).size).toBe(0)
  })

  it('aceita uma lista de permissões (qualquer uma basta), como as regras do servidor', () => {
    expect(canAccessAdminPermission(monitor, [ADMIN_PERMISSIONS.PAGE_RESULTS, ADMIN_PERMISSIONS.PAGE_MONITOR])).toBe(true)
    expect(canAccessAdminPermission(monitor, [ADMIN_PERMISSIONS.PAGE_RESULTS, ADMIN_PERMISSIONS.REPORTS_VIEW])).toBe(false)
  })

  it('Minha conta e Matrículas pedem as permissões do servidor', () => {
    expect(ADMIN_PATH_PERMISSIONS['/minha-conta']).toBe('page.dashboard')
    expect(ADMIN_PATH_PERMISSIONS['/matriculas']).toBe('enrollments.approve')
  })

  it('Tarefas (/tarefas) pede page.assignments, a permissão das rotas de tarefa', () => {
    expect(ADMIN_PATH_PERMISSIONS['/tarefas']).toBe('page.assignments')
    expect(canAccessAdminPath({ accountRole: 'professor', effectivePermissions: ['page.dashboard', 'page.assignments'] }, '/tarefas')).toBe(true)
    // Antes do C7 o caminho não estava na lista e abria para qualquer conta do painel.
    expect(canAccessAdminPath({ accountRole: 'monitor', effectivePermissions: ['page.dashboard', 'page.monitor'] }, '/tarefas')).toBe(false)
    expect(canAccessAdminPath({ accountRole: 'secretaria', effectivePermissions: ['page.dashboard', 'page.students'] }, '/tarefas')).toBe(false)
  })

  it('adminAccountFields guarda o que o whoami manda (nome, lista, escopo, só consulta, rótulo)', () => {
    const fields = adminAccountFields({ name: 'Rita', role: 'coordenacao', effectivePermissions: ['page.dashboard'], scopeKind: 'escolas', readOnly: true, roleLabel: 'Coordenação', assignedSchoolIds: ['e1'] })
    expect(fields).toMatchObject({ name: 'Rita', accountRole: 'coordenacao', effectivePermissions: ['page.dashboard'], scopeKind: 'escolas', readOnly: true, roleLabel: 'Coordenação', assignedSchoolIds: ['e1'] })
    expect(adminAccountFields({}).accountRole).toBe('admin')
    expect('effectivePermissions' in adminAccountFields({ role: 'professor' })).toBe(false)
  })

  it('rótulo do papel: o do servidor; sessão antiga, o de antes', () => {
    expect(accountRoleLabel(secretaria)).toBe('Secretaria')
    expect(accountRoleLabel({ accountRole: 'professor' })).toBe('Professor')
    expect(accountRoleLabel({})).toBe('Administrador')
  })
})

describe('[UC-PAPEIS-001] professor auxiliar sem notas na tela', () => {
  it('lê nota quem tem Resultados ou relatórios; o professor auxiliar não', () => {
    expect(canReadStudentGrades({ accountRole: 'admin' })).toBe(true)
    expect(canReadStudentGrades({ accountRole: 'professor' })).toBe(true)
    expect(canReadStudentGrades(secretaria)).toBe(true)
    expect(canReadStudentGrades(monitor)).toBe(false)
    expect(canReadStudentGrades({ accountRole: 'coordenacao', effectivePermissions: ['page.dashboard', 'reports.view'] })).toBe(true)
  })
})

describe('[UC-PAPEIS-005] papéis na tela de contas', () => {
  const roles = [
    { id: 'professor', rotulo: 'Professor', escopo: 'turmas', permissoesPadrao: ['page.dashboard', 'page.results'], concediveis: ['page.results', 'page.accounts', 'algo.novo'] },
    { id: 'secretaria', rotulo: 'Secretaria', escopo: 'escolas', permissoesPadrao: [], concediveis: [] },
  ]

  it('as extras oferecidas são as concedíveis que o papel ainda não tem, com rótulo', () => {
    const options = grantableOptionsForRole(roles, 'professor')
    expect(options.map((item) => item.permission)).toEqual(['page.accounts', 'algo.novo'])
    expect(options[0].group).toBe('Contas')
    expect(options[1]).toMatchObject({ group: 'Outras', label: 'algo.novo' })
    expect(grantableOptionsForRole(roles, 'secretaria')).toEqual([])
  })

  it('rótulo e escopo do catálogo, com a reserva enquanto ele carrega', () => {
    expect(roleLabelOf(roles, 'secretaria')).toBe('Secretaria')
    expect(roleScopeOf(roles, 'secretaria')).toBe('escolas')
    expect(roleLabelOf([], 'coordenacao')).toBe('Coordenação')
    expect(roleScopeOf([], 'admin')).toBe('tudo')
    expect(roleLabelOf([], '')).toBe('Administrador')
    expect(roleLabelOf([], 'zelador')).toBe('Papel desconhecido')
  })
})

describe('[UC-PAPEIS-003] isProfessorRoleAccount: listas de professores sem comparar o papel na tela', () => {
  it('só a conta de papel professor; sem papel é administrador', async () => {
    const { isProfessorRoleAccount } = await import('./adminPermissions')
    expect(isProfessorRoleAccount({ role: 'professor' })).toBe(true)
    expect(isProfessorRoleAccount({ role: ' Professor ' })).toBe(true)
    expect(['admin', 'monitor', 'secretaria', 'coordenacao', ''].map((role) => isProfessorRoleAccount({ role }))).toEqual([false, false, false, false, false])
    expect(isProfessorRoleAccount(null)).toBe(false)
  })
})
