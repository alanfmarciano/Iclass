import { describe, expect, it } from 'vitest'
import { getAdminNavGroups } from './Sidebar'
import { ADMIN_PERMISSIONS, ADMIN_PATH_PERMISSIONS } from '../../lib/adminPermissions'
import baseline from '../../../../test/backend/fixtures/professor-permissoes-281029f.json'

// Menu do professor (fase 3, B0a; FUN-13): o que o professor via no menu na 281029f
// continua aparecendo. A mesma referência é conferida no servidor por
// test/backend/professor-permissions-snapshot.test.js (o servidor dá cada permissão
// que estes caminhos pedem), para a tela poder montar o menu pela lista do servidor.
const menuPaths = (auth) => getAdminNavGroups(auth).flatMap((group) => group.items.map((item) => item.to))

describe('[UC-PAPEIS-004] menu do professor de hoje', () => {
  const professor = { accountRole: 'professor', additionalPermissions: [] }

  it('no ambiente da instituição, mostra pelo menos o menu da 281029f', () => {
    const paths = menuPaths({ ...professor, activeWorkspace: null })
    baseline.menu.instituicao.forEach((path) => expect(paths).toContain(path))
  })

  it('dentro de uma turma, mostra pelo menos o menu da 281029f (Avisos, Calendário e Fórum com page.forum)', () => {
    const paths = menuPaths({ ...professor, activeWorkspace: { courseId: 'curso', className: '1A' } })
    baseline.menu.curso.forEach((path) => expect(paths).toContain(path))
  })

  it('as constantes da tela usam os valores do servidor (sem "page.fórum")', () => {
    const values = Object.values(ADMIN_PERMISSIONS)
    expect(values).not.toContain('page.fórum')
    expect(values).toContain('page.forum')
    ;['/avisos', '/calendario', '/forum'].forEach((path) => expect(ADMIN_PATH_PERMISSIONS[path]).toBe('page.forum'))
  })

  it('com a lista do servidor (effectivePermissions do whoami) o menu do professor não perde nada', () => {
    // Sessão como o whoami devolve agora: a tela ainda calcula pela própria lista, e
    // o campo novo não muda o menu.
    const auth = { ...professor, effectivePermissions: baseline.tela, scopeKind: 'turmas', readOnly: false, roleLabel: 'Professor' }
    baseline.menu.instituicao.forEach((path) => expect(menuPaths({ ...auth, activeWorkspace: null })).toContain(path))
    baseline.menu.curso.forEach((path) => expect(menuPaths({ ...auth, activeWorkspace: { courseId: 'curso', className: '1A' } })).toContain(path))
  })
})

describe('menu Tarefas (fase 3, C7 / P1-e)', () => {
  const inCourse = { activeWorkspace: { courseId: 'curso', className: '1A' } }
  const avaliacoes = (auth) => getAdminNavGroups(auth).find((group) => group.label === 'Avaliações')?.items.map((item) => item.to) || []

  it('aparece em Avaliações para o professor (page.assignments do padrão) e para a Coordenação', () => {
    expect(avaliacoes({ accountRole: 'professor', additionalPermissions: [], ...inCourse })).toContain('/tarefas')
    expect(avaliacoes({ accountRole: 'coordenacao', effectivePermissions: ['page.dashboard', 'page.results', 'page.assignments'], readOnly: true, ...inCourse })).toContain('/tarefas')
  })

  it('não aparece para quem não tem page.assignments (Professor auxiliar, Secretaria) nem fora da turma', () => {
    expect(menuPaths({ accountRole: 'monitor', effectivePermissions: ['page.dashboard', 'page.monitor', 'page.students'], ...inCourse })).not.toContain('/tarefas')
    expect(menuPaths({ accountRole: 'secretaria', effectivePermissions: ['page.dashboard', 'page.students'], ...inCourse })).not.toContain('/tarefas')
    expect(menuPaths({ accountRole: 'professor', additionalPermissions: [], activeWorkspace: null })).not.toContain('/tarefas')
  })
})
