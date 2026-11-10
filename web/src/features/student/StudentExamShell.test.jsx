import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
const authMock = vi.hoisted(() => ({ logout: vi.fn(), setAuth: vi.fn(), setActiveClass: vi.fn() }))
vi.mock('../../lib/api', () => ({ api: apiMock }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }) }))
vi.mock('../../context/AuthProvider', () => ({
  useAuth: () => ({
    ...authMock,
    auth: {
      role: 'student',
      email: 'ana@escola.local',
      activeClass: { name: '1DES', courseId: 'curso' },
      student: { name: 'Ana', classes: [{ name: '1DES', courseId: 'curso' }], courses: [{ id: 'curso', name: 'Curso' }], enrollmentRequests: [] },
    },
  }),
}))

import { StudentExamShell } from './StudentExamShell'

function renderShell(child = <p>Conteúdo da prova</p>) {
  const router = createMemoryRouter([
    { path: '/aluno/prova/:examKey', element: <StudentExamShell />, children: [{ index: true, element: child }] },
    { path: '/login', element: <p>Tela de login</p> },
  ], { initialEntries: ['/aluno/prova/Avaliacao?applicationId=app-1'] })
  render(<RouterProvider router={router} />)
  return router
}

beforeEach(() => {
  apiMock.get.mockReset()
  apiMock.get.mockResolvedValue({ success: true })
  Object.values(authMock).forEach((fn) => fn.mockReset())
})

afterEach(cleanup)

describe('[UC-PROVA-003] layout da prova online (AVA-12, UXA-X1)', () => {
  it('não tem menu do portal, sino, links nem botão de sair da conta', async () => {
    renderShell()
    const main = screen.getByRole('main')
    expect(main).toHaveTextContent('Conteúdo da prova')
    expect(screen.queryAllByRole('link')).toHaveLength(0)
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /notifica/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sair' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Menu' })).not.toBeInTheDocument()
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/api/ping?email=ana%40escola.local'))
  })

  it('mantém a presença e leva ao login quando a sessão é revogada durante a prova', async () => {
    apiMock.get.mockRejectedValue(Object.assign(new Error('Sessão encerrada'), { status: 401 }))
    const router = renderShell()
    expect(await screen.findByText('Tela de login')).toBeVisible()
    expect(authMock.logout).toHaveBeenCalled()
    expect(router.state.location.pathname).toBe('/login')
  })

  it('erro de tela na prova mostra a tela de erro em português com o botão de recarregar, dentro do layout da prova (G4)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    function TelaQuebrada() { throw new Error('Cannot read properties of undefined') }
    try {
      renderShell(<TelaQuebrada />)
      const main = screen.getByRole('main')
      expect(main).toHaveTextContent('Algo deu errado nesta tela')
      expect(main).toHaveTextContent('as respostas já salvas continuam guardadas e a prova não foi encerrada')
      expect(screen.getByRole('button', { name: 'Recarregar a página' })).toBeVisible()
      expect(screen.queryByText(/Unexpected Application Error/)).not.toBeInTheDocument()
      expect(screen.getByText('Detalhes técnicos')).toBeInTheDocument()
    } finally {
      consoleError.mockRestore()
    }
  })
})
