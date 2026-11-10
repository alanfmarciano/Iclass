import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 2, H5b (SEG-06, decisão 6 do Alan): a conta com muitas senhas erradas espera antes
// de tentar de novo; Alunos e Contas mostram o selo e o "Liberar login".
const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  refetch: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  auth: { accountRole: 'admin' },
  students: [],
  accounts: [],
}))

vi.mock('../../lib/api', () => ({ api: { post: mocks.post, get: vi.fn(async () => ({})) } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: mocks.auth }) }))
vi.mock('../../hooks/useAdminWorkspace', () => ({
  useAdminWorkspace: () => ({ courseId: 'DES', courseName: 'Desenvolvimento', className: '1DES' }),
}))
vi.mock('../../hooks/useApi', () => ({
  useApi: (path) => {
    if (path.startsWith('/api/admin/students')) return { data: mocks.students, loading: false, error: null, refetch: mocks.refetch }
    if (path.startsWith('/api/admin/accounts')) return { data: mocks.accounts, loading: false, error: null, refetch: mocks.refetch }
    if (path.startsWith('/api/admin/classes')) return { data: [{ name: '1DES', courseId: 'DES' }], loading: false, error: null, refetch: vi.fn() }
    return { data: [], loading: false, error: null, refetch: vi.fn() }
  },
}))

import { loginProtectionLabel } from './loginProtection'
import AlunosPage from './AlunosPage'
import AdminsPage from './AdminsPage'
import { ActionQueue } from './dashboard/ActionQueue'

const NOW = new Date('2026-11-10T14:00:00').getTime()

beforeEach(() => {
  mocks.post.mockResolvedValue({ success: true, unlocked: true, message: 'Login liberado. A conta já pode entrar.' })
  mocks.auth = { accountRole: 'admin' }
  mocks.students = []
  mocks.accounts = []
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('[UC-AUTH-002] selo de login com atraso e "Liberar login"', () => {
  it('o selo diz até que horas a conta espera e, depois, quantas senhas erradas seguidas', () => {
    const retryAt = new Date('2026-11-10T14:05:00').getTime()
    expect(loginProtectionLabel({ failures: 6, retryAt }, NOW)).toBe('Login em espera até 14:05')
    expect(loginProtectionLabel({ failures: 6, retryAt }, retryAt + 1)).toBe('6 senhas erradas seguidas')
    expect(loginProtectionLabel(null, NOW)).toBe('')
  })

  it('Alunos: "Pediu nova senha" no lugar do antigo "senha", selo do atraso e "Liberar login" no menu da linha', async () => {
    const user = userEvent.setup()
    mocks.students = [
      { email: 'ana@escola.local', name: 'Ana Souza', classes: ['1DES'], studentClass: '1DES', status: 'Ativo', recoveryRequested: true, loginProtection: { failures: 5, retryAt: Date.now() + 30000 } },
      { email: 'bia@escola.local', name: 'Bia Lima', classes: ['1DES'], studentClass: '1DES', status: 'Ativo' },
    ]
    render(<MemoryRouter><AlunosPage /></MemoryRouter>)
    expect(screen.getByText('Pediu nova senha')).toBeInTheDocument()
    expect(screen.queryByText('senha')).toBeNull()
    expect(screen.getAllByText(/^Login em espera até /)).toHaveLength(1)

    // A linha sem atraso não oferece "Liberar login".
    const rows = screen.getAllByRole('button', { name: 'Ações' })
    await user.click(rows[1])
    expect(screen.queryByRole('button', { name: /Liberar login/ })).toBeNull()
    await user.keyboard('{Escape}')

    await user.click(rows[0])
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: /Liberar login/ }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/student/unlock-login', { email: 'ana@escola.local' }))
    expect(mocks.toast.success).toHaveBeenCalledWith('Login liberado. A conta já pode entrar.')
    expect(mocks.refetch).toHaveBeenCalled()
  })

  it('Contas: selo e "Liberar login" na linha da conta, só para quem administra contas', async () => {
    const user = userEvent.setup()
    mocks.accounts = [
      { email: 'prof@escola.local', name: 'Prof', role: 'professor', assignedClasses: [], loginProtection: { failures: 7, retryAt: Date.now() + 60000 } },
      { email: 'adm@escola.local', name: 'Adm', role: 'admin', assignedClasses: [] },
    ]
    const { unmount } = render(<MemoryRouter><AdminsPage /></MemoryRouter>)
    expect(screen.getByText(/^Login em espera até /)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Liberar login/ }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/accounts/unlock-login', { email: 'prof@escola.local' }))
    expect(mocks.refetch).toHaveBeenCalled()
    unmount()

    // Professor com "Contas" só para consultar vê o selo, sem o botão.
    mocks.auth = { accountRole: 'professor', additionalPermissions: ['page.accounts'] }
    render(<MemoryRouter><AdminsPage /></MemoryRouter>)
    expect(screen.getByText(/^Login em espera até /)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Liberar login/ })).toBeNull()
  })

  it('a fila "Precisa de você" mostra os itens de acesso com ícone próprio', () => {
    const items = [
      { id: 'login_tentativas', tipo: 'login_tentativas', titulo: 'Alunos com muitas senhas erradas', detalhe: 'libere em Alunos', count: 2, tone: 'danger', href: '/alunos' },
      { id: 'login_ip_alerta', tipo: 'login_ip_alerta', titulo: 'Muitas senhas erradas vindas do mesmo endereço', detalhe: 'IP 10.0.0.9', count: 1, tone: 'danger', href: '/alunos' },
      { id: 'senhas_pedidas', tipo: 'senhas_pedidas', titulo: 'Alunos pediram nova senha', detalhe: 'Redefinir senha', count: 1, tone: 'warning', href: '/alunos' },
    ]
    const { container } = render(<ActionQueue items={items} onOpen={vi.fn()} />)
    expect(screen.getByText('Alunos com muitas senhas erradas')).toBeInTheDocument()
    // Cada tipo tem o seu desenho (o padrão, Inbox, ficaria repetido nos três).
    const icons = [...container.querySelectorAll('svg.lucide')].map((svg) => svg.getAttribute('class'))
    const kinds = icons.filter((name) => !/arrow-right/.test(name))
    expect(kinds.some((name) => /inbox/.test(name))).toBe(false)
    expect(new Set(kinds).size).toBe(3)
  })
})
