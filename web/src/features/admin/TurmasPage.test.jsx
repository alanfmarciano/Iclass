import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TurmasPage from './TurmasPage'

// Criar, alterar, excluir e restaurar curso vão pelas rotas novas do painel
// (/api/admin/courses, SEG-12): as antigas (/api/courses) respondem 410.
const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  get: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  apiData: {},
}))

vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post, put: mocks.put, delete: mocks.del } }))
vi.mock('../../hooks/useApi', () => ({
  useApi: (path) => ({ data: (path && mocks.apiData[path]) || null, loading: false, error: null, refetch: vi.fn() }),
}))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: { role: 'admin', accountRole: 'admin' } }) }))

function renderPage() {
  return render(<MemoryRouter><TurmasPage /></MemoryRouter>)
}

describe('TurmasPage · cursos', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.apiData = {
      '/api/admin/course-summaries?includeDeleted=1': [
        { id: 'DES', name: 'Técnico em TI', description: 'Desenvolvimento', schoolId: 'escola-a', status: 'active', stats: { classCount: 1, studentCount: 3 } },
      ],
      '/api/admin/classes': [{ name: '1DES', courseId: 'DES', period: 'Manhã' }],
      '/api/admin/schools': [{ id: 'escola-a', name: 'Escola A' }, { id: 'escola-b', name: 'Escola B' }],
      '/api/admin/accounts': [],
      '/api/admin/archived-courses': [],
    }
    mocks.post.mockResolvedValue({ success: true, course: { id: 'NOVO' } })
    mocks.put.mockResolvedValue({ success: true })
    mocks.del.mockResolvedValue({ success: true })
  })
  afterEach(cleanup)

  it('[UC-CURSO-001] "Novo curso" cria pelo painel (/api/admin/courses), sem mandar a estrutura', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Novo curso' }))
    const dialog = screen.getByRole('dialog', { name: 'Novo curso' })
    await user.type(within(dialog).getByLabelText('Código do curso'), 'novo')
    await user.type(within(dialog).getByLabelText('Nome'), 'Curso novo')
    await user.selectOptions(within(dialog).getByLabelText('Escola'), 'escola-b')
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/courses', { id: 'NOVO', name: 'Curso novo', description: '', schoolId: 'escola-b' }))
    expect(mocks.post.mock.calls.some(([path]) => path === '/api/courses')).toBe(false)
  })

  it('[UC-CURSO-001] "Editar" e "Excluir" usam PUT e DELETE em /api/admin/courses/:id', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Editar' }))
    const dialog = screen.getByRole('dialog', { name: 'Editar curso' })
    const name = within(dialog).getByLabelText('Nome')
    await user.clear(name)
    await user.type(name, 'Técnico em Informática')
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith('/api/admin/courses/DES', { name: 'Técnico em Informática', description: 'Desenvolvimento', schoolId: 'escola-a' }))

    await user.click(screen.getByRole('button', { name: 'Excluir' }))
    const confirm = screen.getByRole('dialog', { name: 'Excluir curso?' })
    await user.click(within(confirm).getByRole('button', { name: 'Excluir' }))
    await waitFor(() => expect(mocks.del).toHaveBeenCalledWith('/api/admin/courses/DES'))
  })

  it('[UC-CURSO-001] "Restaurar" um curso excluído usa PUT em /api/admin/courses/:id', async () => {
    mocks.apiData['/api/admin/course-summaries?includeDeleted=1'] = [
      { id: 'OLD', name: 'Curso antigo', schoolId: 'escola-a', status: 'deleted', deleted: true, deletedAt: '2026-01-01T00:00:00Z' },
    ]
    const user = userEvent.setup()
    renderPage()
    await user.selectOptions(screen.getByLabelText('Filtrar por status'), 'deleted')
    await user.click(await screen.findByRole('button', { name: 'Restaurar' }))
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith('/api/admin/courses/OLD', { status: 'active', deleted: false, deletedAt: null }))
  })
})
