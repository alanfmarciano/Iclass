import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CalendarioPage from './CalendarioPage'

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  refetch: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  events: [],
  auth: undefined,
}))

vi.mock('../../lib/api', () => ({ api: { post: mocks.post, get: vi.fn() } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: mocks.auth }) }))
vi.mock('../../hooks/useAdminWorkspace', () => ({
  useAdminWorkspace: () => ({ courseId: 'TI', courseName: 'Informática', className: '1DES' }),
}))
vi.mock('../../hooks/useApi', () => ({
  useApi: (path) => (path && path.startsWith('/api/admin/announcements/calendar')
    ? { data: mocks.events, loading: false, error: null, refetch: mocks.refetch }
    : { data: null, loading: false, error: null, refetch: vi.fn() }),
}))

// Dias do mês corrente (o calendário abre no mês de hoje).
const now = new Date()
const ymd = (day) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`

beforeEach(() => {
  window.scrollTo = vi.fn()
  mocks.post.mockResolvedValue({ success: true })
  mocks.events = [
    { id: 'cal_1', title: 'Prova de Redes', message: 'Trazer calculadora', eventDate: ymd(10), startTime: '08:00', endTime: '', eventType: 'prova', target: 'turma', targetValue: '1DES', courseId: 'TI' },
    { kind: 'nonSchoolDay', id: 'nl_1', title: 'Recesso escolar', message: 'Recesso: não há aula de 12/xx a 14/xx.', eventDate: ymd(12), endDate: ymd(14), startTime: '', endTime: '', eventType: 'nao_letivo', readOnly: true },
  ]
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.auth = undefined
})

describe('Calendário do painel', () => {
  it('[UC-PRESENCA-005] dia não letivo abre só para leitura, sem Excluir nem Salvar', async () => {
    const user = userEvent.setup()
    render(<CalendarioPage />)
    await user.click(screen.getByRole('button', { name: 'Recesso escolar' }))
    // Antes abria o formulário de evento e "Salvar" criava um evento com o id do dia.
    const dialog = await screen.findByRole('dialog', { name: 'Recesso escolar' })
    expect(within(dialog).getByText(/não há aula/)).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Excluir' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Salvar' })).toBeNull()
    await user.click(within(dialog).getAllByRole('button', { name: 'Fechar' }).at(-1))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Recesso escolar' })).toBeNull())
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('[UC-PRESENCA-005] excluir evento pede confirmação no diálogo da tela', async () => {
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm')
    render(<CalendarioPage />)
    await user.click(screen.getByRole('button', { name: /Prova de Redes/ }))
    const form = await screen.findByRole('dialog', { name: 'Editar evento' })
    await user.click(within(form).getByRole('button', { name: 'Excluir' }))
    expect(mocks.post).not.toHaveBeenCalled()
    const confirm = await screen.findByRole('dialog', { name: 'Excluir este evento?' })
    await user.click(within(confirm).getByRole('button', { name: 'Excluir' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/announcements/calendar/delete', { id: 'cal_1' }))
    expect(confirmSpy).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })
})

describe('Calendário da Coordenação (só consulta)', () => {
  it('[UC-PAPEIS-004] sem "Novo evento"; o evento abre só para ler, sem Salvar nem Excluir (403)', async () => {
    mocks.auth = {
      role: 'admin', accountRole: 'coordenacao', readOnly: true,
      effectivePermissions: ['page.dashboard', 'page.results', 'page.classes', 'page.students', 'page.forum', 'page.assignments', 'reports.view'],
    }
    const user = userEvent.setup()
    render(<CalendarioPage />)
    // Antes: "Novo evento" e o formulário de editar apareciam e o POST dava 403.
    expect(screen.queryByRole('button', { name: 'Novo evento' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Prova de Redes/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Prova de Redes' })
    expect(screen.queryByRole('dialog', { name: 'Editar evento' })).toBeNull()
    expect(within(dialog).getByText('Trazer calculadora')).toBeInTheDocument()
    expect(within(dialog).getByText(/08:00/)).toBeInTheDocument()
    expect(within(dialog).getByText('Prova')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Excluir' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Salvar' })).toBeNull()
    expect(within(dialog).queryByRole('textbox')).toBeNull()
    expect(mocks.post).not.toHaveBeenCalled()
  })
})
