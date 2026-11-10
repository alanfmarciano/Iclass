import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
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
  vi.restoreAllMocks()
})

const connectionCalls = () => mocks.get.mock.calls.filter(([path]) => path === '/api/connection').length
const LOCAL_REFUSED = { secure: false, thisComputer: false, adminAccess: 'local-only', adminAccessMode: 'local', insecureAdmin: false }
const OPEN_INSECURE = { secure: false, thisComputer: false, adminAccess: 'ok', adminAccessMode: 'rede-sem-https', insecureAdmin: true }

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

  it('administrador libera o aparelho com a tela aberta: "Verificar de novo" tira o aviso e liga o botão, sem recarregar', async () => {
    mocks.connection = LOCAL_REFUSED
    const user = userEvent.setup()
    renderLogin()
    await user.click(screen.getByRole('button', { name: 'Instrutor' }))
    expect(await screen.findByTestId('admin-access-refused')).toHaveTextContent(LOCAL_ONLY)
    expect(screen.getByRole('button', { name: /Entrar como instrutor/ })).toBeDisabled()
    // No computador do IClass, o administrador volta para "Todos os aparelhos da rede".
    mocks.connection = OPEN_INSECURE
    await user.click(screen.getByRole('button', { name: 'Verificar de novo' }))
    await waitFor(() => expect(screen.queryByTestId('admin-access-refused')).toBeNull())
    expect(screen.getByRole('button', { name: /Entrar como instrutor/ })).toBeEnabled()
    expect(screen.getByTestId('insecure-connection-notice')).toHaveTextContent('Conexão sem proteção')
  })

  it('a regra é lida de novo quando a tela volta a ficar visível ou ganha o foco', async () => {
    mocks.connection = LOCAL_REFUSED
    const user = userEvent.setup()
    renderLogin()
    await user.click(screen.getByRole('button', { name: 'Instrutor' }))
    expect(await screen.findByTestId('admin-access-refused')).toBeInTheDocument()
    const before = connectionCalls()
    mocks.connection = OPEN_INSECURE
    // O tablet acorda (a aba volta) mais de 1 s depois da última consulta.
    const later = Date.now() + 5000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await waitFor(() => expect(screen.queryByTestId('admin-access-refused')).toBeNull())
    expect(connectionCalls()).toBe(before + 1)
    expect(screen.getByRole('button', { name: /Entrar como instrutor/ })).toBeEnabled()
    // Foco junto com a volta da aba não gera uma segunda consulta.
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(connectionCalls()).toBe(before + 1)
    Date.now.mockReturnValue(later + 5000)
    mocks.connection = LOCAL_REFUSED
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(await screen.findByTestId('admin-access-refused')).toHaveTextContent(LOCAL_ONLY)
  })

  it('acesso rápido de demonstração: Administrador e Professor desligados quando o painel é recusado; Aluno segue', async () => {
    mocks.connection = LOCAL_REFUSED
    mocks.get.mockImplementation(async (path) => {
      if (path === '/api/connection') return mocks.connection
      if (path === '/api/test-mode') return { enabled: true }
      return []
    })
    renderLogin()
    expect(await screen.findByTestId('quick-admin-refused')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Administrador' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Professor' })).toBeDisabled()
    // A aba Aluno e o acesso rápido do aluno.
    for (const button of screen.getAllByRole('button', { name: 'Aluno' })) expect(button).toBeEnabled()
  })

  it('acesso rápido de demonstração no computador do IClass: os três botões ligados', async () => {
    mocks.get.mockImplementation(async (path) => {
      if (path === '/api/connection') return mocks.connection
      if (path === '/api/test-mode') return { enabled: true }
      return []
    })
    renderLogin()
    expect(await screen.findByRole('button', { name: 'Administrador' })).toBeEnabled()
    await waitFor(() => expect(connectionCalls()).toBeGreaterThan(0))
    expect(screen.getByRole('button', { name: 'Professor' })).toBeEnabled()
    expect(screen.queryByTestId('quick-admin-refused')).toBeNull()
  })
})

// Fase 2, H5a (UXA-13): o cadastro diz como é uma senha aceita, sem caixa rolável no
// celular, e o pedido de nova senha explica o próximo passo.
describe('[UC-SENHA-001] cadastro e pedido de nova senha', () => {
  it('o formulário não tem altura máxima nem rolagem própria, e o cadastro mostra a dica da senha', async () => {
    const user = userEvent.setup()
    const { container } = renderLogin()
    const form = container.querySelector('form')
    expect(form.className).not.toMatch(/max-h-/)
    expect(form.className).not.toMatch(/overflow-auto/)
    await user.click(screen.getByRole('button', { name: 'Cadastro' }))
    expect(screen.getByText('Use pelo menos 8 caracteres. Evite senhas óbvias, como 12345678 ou o seu nome.')).toBeInTheDocument()
    expect(screen.getByLabelText('Senha')).toHaveAttribute('autocomplete', 'new-password')
  })

  it('pedido de nova senha: mostra o que fazer e volta para o login', async () => {
    mocks.post.mockResolvedValue({ success: true })
    const user = userEvent.setup()
    renderLogin()
    await user.click(screen.getByRole('button', { name: 'Senha' }))
    await user.type(screen.getByLabelText('E-mail'), 'ana@escola.local')
    await user.click(screen.getByRole('button', { name: /Solicitar nova senha/ }))
    expect(await screen.findByTestId('recover-sent')).toHaveTextContent('Pedido enviado. Avise o professor: ele vai gerar uma senha temporária para você. No próximo acesso, entre com ela e escolha uma senha nova.')
    expect(mocks.post).toHaveBeenCalledWith('/api/student/recover', { email: 'ana@escola.local' }, { auth: false })
    await user.click(screen.getByRole('button', { name: /Voltar para o login/ }))
    expect(screen.getByRole('button', { name: /Entrar como aluno/ })).toBeInTheDocument()
    expect(screen.queryByTestId('recover-sent')).toBeNull()
  })
})
