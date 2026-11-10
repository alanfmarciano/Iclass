import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AvisosPage from './AvisosPage'

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  refetch: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  announcements: [],
}))

vi.mock('../../lib/api', () => ({ api: { post: mocks.post, get: vi.fn() } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: { accountRole: 'professor' } }) }))
vi.mock('../../hooks/useAdminWorkspace', () => ({
  useAdminWorkspace: () => ({ courseId: 'DES', courseName: 'Desenvolvimento', className: '1DES' }),
}))
vi.mock('../../hooks/useApi', () => ({
  useApi: (path) => {
    if (path.startsWith('/api/admin/classes')) return { data: [{ name: '1DES', courseId: 'DES' }], loading: false, error: null, refetch: vi.fn() }
    if (path.startsWith('/api/admin/announcements')) return { data: mocks.announcements, loading: false, error: null, refetch: mocks.refetch }
    return { data: null, loading: false, error: null, refetch: vi.fn() }
  },
}))

beforeEach(() => {
  window.scrollTo = vi.fn()
  mocks.post.mockResolvedValue({ success: true })
  mocks.announcements = [
    { id: 'ann_dir', title: 'Recado da direção', message: 'Reunião geral', target: 'todos', targetValue: '', canEdit: false, createdAt: 2 },
    { id: 'ann_turma', title: 'Prova remarcada', message: 'Sexta', target: 'turma', targetValue: '1DES', courseId: 'DES', canEdit: true, createdAt: 1 },
  ]
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const cardOf = (title) => screen.getByText(title).closest('.p-4')

describe('Avisos', () => {
  it('[UC-ADMIN-001] "Excluir" pede confirmação com o diálogo padrão antes de apagar', async () => {
    const user = userEvent.setup()
    render(<AvisosPage />)
    await user.click(within(cardOf('Prova remarcada')).getByRole('button', { name: 'Excluir' }))
    // Antes apagava no clique, sem confirmação.
    expect(mocks.post).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog', { name: 'Excluir aviso?' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(mocks.post).not.toHaveBeenCalled()

    await user.click(within(cardOf('Prova remarcada')).getByRole('button', { name: 'Excluir' }))
    await user.click(within(await screen.findByRole('dialog', { name: 'Excluir aviso?' })).getByRole('button', { name: 'Excluir' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/announcements/delete', { id: 'ann_turma' }))
    expect(mocks.refetch).toHaveBeenCalled()
  })

  it('[UC-ADMIN-001] aviso para toda a instituição aparece ao professor sem editar nem excluir', async () => {
    const user = userEvent.setup()
    render(<AvisosPage />)
    const card = cardOf('Recado da direção')
    expect(within(card).queryByRole('button', { name: 'Excluir' })).not.toBeInTheDocument()
    expect(within(card).getByText('Só o administrador edita')).toBeInTheDocument()
    await user.click(card)
    expect(screen.queryByText('Editar aviso')).not.toBeInTheDocument()
    await user.click(cardOf('Prova remarcada'))
    expect(screen.getByText('Editar aviso')).toBeInTheDocument()
  })
})
