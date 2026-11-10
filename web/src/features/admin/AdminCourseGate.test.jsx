import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminCourseGate, INSTITUTION_PATHS } from './AdminCourseGate'
import { getAdminNavGroups } from '../../components/layout/Sidebar'

const mocks = vi.hoisted(() => ({
  setActiveWorkspace: vi.fn(),
  clearActiveWorkspace: vi.fn(),
  navigate: vi.fn(),
  setPref: vi.fn(),
  pathname: '/',
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return { ...actual, useLocation: () => ({ pathname: mocks.pathname }), useNavigate: () => mocks.navigate }
})

vi.mock('../../hooks/useApi', () => ({
  useApi: (path) => path.includes('course-summaries')
    ? {
        data: [{
          id: 'DES',
          name: 'Curso Técnico em TI',
          schoolId: 'school-1',
          description: 'Desenvolvimento de sistemas',
          classes: [
            { name: '1DES', period: 'Manhã', studentCount: 16 },
            { name: '2DES', period: 'Noite', studentCount: 12 },
          ],
        }],
        loading: false,
        error: null,
        refetch: vi.fn(),
      }
    : { data: [{ id: 'school-1', name: 'Escola Técnica' }], loading: false, error: null, refetch: vi.fn() },
}))

vi.mock('../../context/AuthProvider', () => ({
  useAuth: () => ({
    auth: { role: 'admin', accountRole: 'admin', activeWorkspace: null },
    setActiveWorkspace: mocks.setActiveWorkspace,
    clearActiveWorkspace: mocks.clearActiveWorkspace,
  }),
}))

vi.mock('../../context/PreferencesProvider', () => ({
  usePreferences: () => ({ pref: () => [], setPref: mocks.setPref }),
}))

describe('AdminCourseGate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.pathname = '/'
    sessionStorage.clear()
  })
  afterEach(cleanup)

  it('gera exatamente um card navegável para cada turma do curso', () => {
    render(<AdminCourseGate><div>Dashboard</div></AdminCourseGate>)

    expect(screen.getAllByRole('button', { name: /Entrar em Curso Técnico em TI, turma/ })).toHaveLength(2)
    expect(screen.getByText('1DES')).toBeVisible()
    expect(screen.getByText('2DES')).toBeVisible()
  })

  it('entra no contexto correto por mouse ou teclado', async () => {
    const user = userEvent.setup()
    render(<AdminCourseGate><div>Dashboard</div></AdminCourseGate>)

    await user.click(screen.getByRole('button', { name: 'Entrar em Curso Técnico em TI, turma 1DES' }))
    expect(mocks.setActiveWorkspace).toHaveBeenLastCalledWith(expect.objectContaining({ courseId: 'DES', className: '1DES', period: 'Manhã' }))

    const secondCard = screen.getByRole('button', { name: 'Entrar em Curso Técnico em TI, turma 2DES' })
    secondCard.focus()
    await user.keyboard('{Enter}')
    expect(mocks.setActiveWorkspace).toHaveBeenLastCalledWith(expect.objectContaining({ courseId: 'DES', className: '2DES', period: 'Noite' }))
  })

  // Regressão do H8a-1: o item "Privacidade (LGPD)" do ambiente da instituição abria o
  // seletor de curso, porque /lgpd faltava em INSTITUTION_PATHS.
  it('abre sem curso escolhido toda tela do menu do ambiente da instituição', () => {
    const navPaths = getAdminNavGroups({ accountRole: 'admin', activeWorkspace: null })
      .flatMap(group => group.items.map(item => item.to))
      .filter(path => path !== '/')
    expect(navPaths).toEqual(expect.arrayContaining(['/auditoria', '/lgpd']))
    navPaths.forEach(path => expect(INSTITUTION_PATHS).toContain(path))
  })

  it('[UC-LGPD-004] mostra a página Privacidade (LGPD) do administrador sem curso escolhido', () => {
    mocks.pathname = '/lgpd'
    render(<AdminCourseGate><h1>Privacidade (LGPD)</h1></AdminCourseGate>)
    expect(screen.getByRole('heading', { level: 1, name: 'Privacidade (LGPD)' })).toBeVisible()
    expect(screen.queryByText('Selecione o curso e a turma')).not.toBeInTheDocument()
  })
})
