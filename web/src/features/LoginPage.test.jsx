import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 2, H6b (SEG-03): a tela de login conta, na aba do instrutor, como o painel do
// professor é tratado neste aparelho (GET /api/connection).
const LOCAL_ONLY = 'O painel do professor só abre no computador onde o IClass está ligado. O administrador pode liberar outros aparelhos em Sistema → Rede.'

const mocks = vi.hoisted(() => ({
  connection: null,
  get: vi.fn(),
  post: vi.fn(),
  loginAdmin: vi.fn(),
  loginStudent: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

vi.mock('../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }))
vi.mock('../context/AuthProvider', () => ({
  useAuth: () => ({ loginAdmin: mocks.loginAdmin, loginAdminSetup: vi.fn(), loginLocalQuick: vi.fn(), loginStudent: mocks.loginStudent }),
}))
vi.mock('../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
vi.mock('../context/BrandingProvider', () => ({ useBranding: () => ({ branding: {} }) }))
vi.mock('../components/ui/ThemeToggle', () => ({ ThemeToggle: () => null }))

import LoginPage from './LoginPage'

function renderLogin() {
  return render(<MemoryRouter><LoginPage /></MemoryRouter>)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connection = { secure: false, thisComputer: true, adminAccess: 'ok', adminAccessMode: 'rede-sem-https', insecureAdmin: false }
  mocks.get.mockImplementation(async (path) => {
    if (path === '/api/connection') return mocks.connection
    if (path === '/api/test-mode') return { enabled: false }
    return []
  })
})

afterEach(() => {
  cleanup()
  sessionStorage.clear()
})

describe('[UC-REDE-001] login do instrutor conforme o aparelho', () => {
  it('no computador do IClass não há aviso e o botão do instrutor fica liberado', async () => {
    const user = userEvent.setup()
    renderLogin()
    await user.click(screen.getByRole('button', { name: 'Instrutor' }))
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/connection', { auth: false }))
    expect(screen.queryByTestId('admin-access-refused')).toBeNull()
    expect(screen.queryByTestId('insecure-connection-notice')).toBeNull()
    expect(screen.getByRole('button', { name: /Entrar como instrutor/ })).toBeEnabled()
  })

  it('"Só o computador do IClass" em outro aparelho: aviso com o texto fixo e o botão do instrutor desligado', async () => {
    mocks.connection = { secure: false, thisComputer: false, adminAccess: 'local-only', adminAccessMode: 'local', insecureAdmin: false }
    const user = userEvent.setup()
    renderLogin()
    await user.click(screen.getByRole('button', { name: 'Instrutor' }))
    expect(await screen.findByTestId('admin-access-refused')).toHaveTextContent(LOCAL_ONLY)
    expect(screen.getByRole('button', { name: /Entrar como instrutor/ })).toBeDisabled()
    // A aba do aluno segue igual: o aviso é só do painel do professor.
    await user.click(screen.getByRole('button', { name: 'Aluno' }))
    expect(screen.queryByTestId('admin-access-refused')).toBeNull()
    expect(screen.getByRole('button', { name: /Entrar como aluno/ })).toBeEnabled()
  })

  it('"Todos os aparelhos da rede" em outro aparelho por http: aviso fixo de conexão sem proteção, sem link de conexão segura', async () => {
    mocks.connection = { secure: false, thisComputer: false, adminAccess: 'ok', adminAccessMode: 'rede-sem-https', insecureAdmin: true }
    const user = userEvent.setup()
    renderLogin()
    await user.click(screen.getByRole('button', { name: 'Instrutor' }))
    const notice = await screen.findByTestId('insecure-connection-notice')
    expect(notice).toHaveTextContent('Conexão sem proteção')
    expect(notice).toHaveTextContent('a senha e os dados do painel passam pela rede da sala sem proteção')
    expect(notice.querySelector('a')).toBeNull()
    expect(screen.getByRole('button', { name: /Entrar como instrutor/ })).toBeEnabled()
  })

  it('recusa no próprio login (regra mudou com a tela aberta) mostra o motivo e desliga o botão', async () => {
    mocks.loginAdmin.mockRejectedValue(Object.assign(new Error(LOCAL_ONLY), { status: 403, data: { error: LOCAL_ONLY, adminAccess: 'local-only' } }))
    const user = userEvent.setup()
    renderLogin()
    await user.click(screen.getByRole('button', { name: 'Instrutor' }))
    await user.type(screen.getByLabelText('E-mail'), 'admin@teste.local')
    await user.type(screen.getByLabelText('Senha'), 'teste')
    await user.click(screen.getByRole('button', { name: /Entrar como instrutor/ }))
    expect(await screen.findByTestId('admin-access-refused')).toHaveTextContent(LOCAL_ONLY)
    expect(mocks.toast.error).toHaveBeenCalledWith(LOCAL_ONLY)
    expect(screen.getByRole('button', { name: /Entrar como instrutor/ })).toBeDisabled()
  })

  it('sessão encerrada pela recusa da rede volta na aba do instrutor com o motivo do servidor', async () => {
    sessionStorage.setItem('iclass-logout-reason', 'admin-network')
    sessionStorage.setItem('iclass-logout-message', LOCAL_ONLY)
    mocks.connection = { secure: false, thisComputer: false, adminAccess: 'local-only', adminAccessMode: 'local', insecureAdmin: false }
    renderLogin()
    expect(await screen.findByTestId('admin-access-refused')).toHaveTextContent(LOCAL_ONLY)
    expect(mocks.toast.error).toHaveBeenCalledWith(LOCAL_ONLY)
    expect(mocks.toast.info).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('iclass-logout-reason')).toBeNull()
    expect(sessionStorage.getItem('iclass-logout-message')).toBeNull()
  })
})
