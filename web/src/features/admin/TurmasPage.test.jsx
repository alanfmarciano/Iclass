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
  auth: { role: 'admin', accountRole: 'admin' },
}))

vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post, put: mocks.put, delete: mocks.del } }))
vi.mock('../../hooks/useApi', () => ({
  useApi: (path) => ({ data: (path && mocks.apiData[path]) || null, loading: false, error: null, refetch: vi.fn() }),
}))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: mocks.auth }) }))

function renderPage() {
  return render(<MemoryRouter><TurmasPage /></MemoryRouter>)
}

describe('TurmasPage · cursos', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth = { role: 'admin', accountRole: 'admin' }
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
    // O curso excluído pode ser restaurado: o diálogo não diz mais que não tem volta (C0a).
    expect(confirm).toHaveTextContent('O curso ficará desativado e poderá ser restaurado.')
    expect(confirm).not.toHaveTextContent('não pode ser desfeita')
    await user.click(within(confirm).getByRole('button', { name: 'Excluir' }))
    await waitFor(() => expect(mocks.del).toHaveBeenCalledWith('/api/admin/courses/DES', { timeoutMs: 0 }))
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

  it('conta que não é administrador vê o total de professores da turma que o servidor manda (não "0 professor(es)")', async () => {
    const user = userEvent.setup()
    mocks.auth = { role: 'admin', accountRole: 'secretaria', effectivePermissions: ['page.classes'] }
    mocks.apiData['/api/admin/classes'] = [
      { name: '1DES', courseId: 'DES', period: 'Manhã', professorCount: 2 },
      { name: '2DES', courseId: 'DES', period: 'Tarde', professorCount: 0 },
    ]
    delete mocks.apiData['/api/admin/accounts']
    renderPage()
    await user.click(screen.getByRole('button', { name: /Técnico em TI/ }))
    expect(screen.getByText('2 professor(es)')).toBeInTheDocument()
    expect(screen.getByText('0 professor(es)')).toBeInTheDocument()
    expect(screen.getAllByText('Sem professor')).toHaveLength(1)
  })

  // Fase 3, C12 (P5-S4, CRIT-11): "Grupos" na turma para quem tem a tela Alunos, também o
  // professor (que não vê as ações de administração da turma).
  it('[UC-GRUPO-001] o professor vê "Grupos" na turma e abre a tela da turma', async () => {
    const { Routes, Route, useLocation } = await import('react-router-dom')
    function Where() { return <p data-testid="where">{useLocation().pathname}</p> }
    mocks.auth = { role: 'professor', accountRole: 'professor' }
    render(<MemoryRouter initialEntries={['/turmas']}><Routes><Route path="/turmas" element={<TurmasPage />} /><Route path="*" element={<Where />} /></Routes></MemoryRouter>)
    expect(screen.queryByRole('button', { name: /Editar turma 1DES/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Grupos da turma 1DES' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/turmas/DES/1DES/grupos')
  })
})
