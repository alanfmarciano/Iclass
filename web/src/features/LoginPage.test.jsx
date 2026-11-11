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

// Fase 2, H5b (SEG-06): a conta com muitas senhas erradas espera antes de tentar de novo
// (429 { loginDelayed, retryAfterSeconds }). O aviso fica na tela, e não só no toast.
describe('[UC-AUTH-002] login com atraso por senha errada', () => {
  const DELAYED = 'Muitas tentativas com senha errada para esta conta. Tente de novo em 30 segundos ou peça ao professor para liberar o seu login.'
  const delayedError = () => Object.assign(new Error(DELAYED), { status: 429, data: { error: DELAYED, loginDelayed: true, retryAfterSeconds: 30 } })

  it('aluno: mostra a espera na tela e some na tentativa seguinte', async () => {
    mocks.loginStudent.mockRejectedValueOnce(delayedError()).mockRejectedValueOnce(Object.assign(new Error('E-mail ou senha incorretos'), { status: 401, data: {} }))
    const user = userEvent.setup()
    renderLogin()
    await user.type(screen.getByLabelText('E-mail'), 'ana@escola.local')
    await user.type(screen.getByLabelText('Senha'), 'errada-123')
    await user.click(screen.getByRole('button', { name: /Entrar como aluno/ }))
    expect(await screen.findByTestId('login-delayed')).toHaveTextContent(DELAYED)
    // Um aviso só: o toast repetido cobria o botão "Entrar" no celular (H5b, ajuste 2).
    expect(mocks.toast.error).not.toHaveBeenCalled()
    // A aba do instrutor não herda o aviso do aluno.
    await user.click(screen.getByRole('button', { name: 'Instrutor' }))
    expect(screen.queryByTestId('login-delayed')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Aluno' }))
    await user.click(screen.getByRole('button', { name: /Entrar como aluno/ }))
    await waitFor(() => expect(mocks.loginStudent).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByTestId('login-delayed')).toBeNull())
  })

  it('outro erro (401) não mostra o aviso de espera', async () => {
    mocks.loginStudent.mockRejectedValueOnce(Object.assign(new Error('E-mail ou senha incorretos'), { status: 401, data: {} }))
    const user = userEvent.setup()
    renderLogin()
    await user.type(screen.getByLabelText('E-mail'), 'ana@escola.local')
    await user.type(screen.getByLabelText('Senha'), 'errada-123')
    await user.click(screen.getByRole('button', { name: /Entrar como aluno/ }))
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('E-mail ou senha incorretos'))
    expect(screen.queryByTestId('login-delayed')).toBeNull()
  })

  it('instrutor: o aviso de espera também aparece uma vez só, sem toast', async () => {
    mocks.loginAdmin.mockRejectedValueOnce(delayedError())
    const user = userEvent.setup()
    renderLogin()
    await user.click(screen.getByRole('button', { name: 'Instrutor' }))
    await user.type(screen.getByLabelText('E-mail'), 'coordenacao@teste.local')
    await user.type(screen.getByLabelText('Senha'), 'errada-123')
    await user.click(screen.getByRole('button', { name: /Entrar como instrutor/ }))
    expect(await screen.findByTestId('login-delayed')).toHaveTextContent(DELAYED)
    expect(mocks.toast.error).not.toHaveBeenCalled()
  })
})

// Fase 2, H5b ajuste 2 (contrato 401 { sessionRevoked, reason }): a sessão encerrada por
// uma ação no servidor mostra o motivo dele, e não o "Sua sessão expirou" genérico.
describe('[UC-AUTH-003] motivo da sessão encerrada no login', () => {
  const RESET = 'A senha desta conta foi redefinida pelo professor. Entre de novo com a senha nova.'

  it('senha redefinida pelo professor: mostra o texto do servidor', async () => {
    sessionStorage.setItem('iclass-logout-reason', 'password_reset')
    sessionStorage.setItem('iclass-logout-message', RESET)
    renderLogin()
    await waitFor(() => expect(mocks.toast.info).toHaveBeenCalledWith(RESET))
    expect(mocks.toast.info).not.toHaveBeenCalledWith('Sua sessão expirou. Faça login novamente.')
    expect(sessionStorage.getItem('iclass-logout-reason')).toBeNull()
  })

  it('Sair em outra aba: nenhum aviso', async () => {
    sessionStorage.setItem('iclass-logout-reason', 'logout')
    renderLogin()
    await waitFor(() => expect(sessionStorage.getItem('iclass-logout-reason')).toBeNull())
    expect(mocks.toast.info).not.toHaveBeenCalled()
    expect(mocks.toast.error).not.toHaveBeenCalled()
  })
})

// Fase 2, H6c (SEG-03, OPS-08): conexão segura no login.
const HTTPS_REQUIRED = 'O painel do professor em outro aparelho só abre pela conexão segura (https). Abra o endereço seguro. Se o navegador avisar que a conexão não é particular, instale antes o certificado do IClass neste aparelho: o passo a passo está na página /certificado.'

describe('[UC-REDE-005] login com a conexão segura', () => {
  it('"Só com conexão segura" em outro aparelho por http: botão para o endereço seguro e link para o guia', async () => {
    mocks.connection = { secure: false, thisComputer: false, adminAccess: 'https-required', adminAccessMode: 'rede', adminAccessError: HTTPS_REQUIRED, insecureAdmin: false, tlsAvailable: true, httpsUrl: 'https://192.168.0.10:3000' }
    const user = userEvent.setup()
    renderLogin()
    await user.click(screen.getByRole('button', { name: 'Instrutor' }))
    const refused = await screen.findByTestId('admin-access-refused')
    expect(refused).toHaveTextContent('Abra o endereço seguro')
    expect(screen.getByTestId('open-secure-address')).toHaveAttribute('href', 'https://192.168.0.10:3000/login?mode=admin')
    expect(screen.getByTestId('certificate-guide-link')).toHaveAttribute('href', '/certificado')
    expect(screen.getByRole('button', { name: /Entrar como instrutor/ })).toBeDisabled()
  })

  it('sem a conexão segura funcionando (httpsUrl null): texto de indisponível e nenhum botão para o https', async () => {
    mocks.connection = { secure: false, thisComputer: false, adminAccess: 'https-required', adminAccessMode: 'rede', insecureAdmin: false, tlsAvailable: false, httpsUrl: null }
    const user = userEvent.setup()
    renderLogin()
    await user.click(screen.getByRole('button', { name: 'Instrutor' }))
    expect(await screen.findByTestId('admin-access-refused')).toHaveTextContent('ela não está funcionando neste IClass agora')
    expect(screen.queryByTestId('open-secure-address')).toBeNull()
  })

  it('"Todos os aparelhos da rede" com a conexão segura funcionando: o aviso traz "Usar conexão segura"', async () => {
    mocks.connection = { ...OPEN_INSECURE, tlsAvailable: true, httpsUrl: 'https://192.168.0.10:3000' }
    const user = userEvent.setup()
    renderLogin()
    await user.click(screen.getByRole('button', { name: 'Instrutor' }))
    const notice = await screen.findByTestId('insecure-connection-notice')
    expect(notice.querySelector('a')).toHaveAttribute('href', '/certificado')
    expect(notice).toHaveTextContent('Usar conexão segura')
  })

  it('aluno com a tela aberta por http depois de o https dos alunos ser ligado: vai para o login no endereço seguro', async () => {
    mocks.loginStudent.mockRejectedValue(Object.assign(new Error('Abra o endereço seguro para entrar.'), { status: 403, data: { error: 'Abra o endereço seguro para entrar.', adminAccess: 'https-required', httpsUrl: 'https://192.168.0.10:3000' } }))
    const assign = vi.fn()
    const original = window.location
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, assign, search: '' } })
    try {
      const user = userEvent.setup()
      renderLogin()
      await user.type(screen.getByLabelText('E-mail'), 'aluno@teste.local')
      await user.type(screen.getByLabelText('Senha'), 'teste')
      await user.click(screen.getByRole('button', { name: /Entrar como aluno/ }))
      await waitFor(() => expect(assign).toHaveBeenCalledWith('https://192.168.0.10:3000/login'))
      expect(mocks.toast.error).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original })
    }
  })

  it('httpsUrl que não é https não vira redirecionamento', async () => {
    mocks.loginStudent.mockRejectedValue(Object.assign(new Error('Abra o endereço seguro para entrar.'), { status: 403, data: { adminAccess: 'https-required', httpsUrl: 'javascript:alert(1)' } }))
    const assign = vi.fn()
    const original = window.location
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, assign, search: '' } })
    try {
      const user = userEvent.setup()
      renderLogin()
      await user.type(screen.getByLabelText('E-mail'), 'aluno@teste.local')
      await user.type(screen.getByLabelText('Senha'), 'teste')
      await user.click(screen.getByRole('button', { name: /Entrar como aluno/ }))
      await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Abra o endereço seguro para entrar.'))
      expect(assign).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original })
    }
  })
})
