import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

// Fase 2, H8a-2 (SEG-08, SEG-09): o login mostra os links dos Termos e da Política, e o
// cadastro pede a data de nascimento, o responsável do menor e manda o id dos documentos.
describe('[UC-LGPD-006] cadastro com data de nascimento, responsável e aceite do documento', () => {
  const LEGAL = {
    terms: { documentId: 'termos_v2', version: 2 },
    privacy: { documentId: 'privacidade_v1', version: 1 },
  }
  function mockRegisterApis() {
    mocks.get.mockImplementation(async (path) => {
      if (path === '/api/connection') return mocks.connection
      if (path === '/api/test-mode') return { enabled: false }
      if (path === '/api/classes') return [{ courseId: 'c1', courseName: 'Informática', name: 'Turma A' }]
      if (path.startsWith('/api/legal/documents')) return LEGAL
      return []
    })
  }
  async function fillRegister(user, birthDate) {
    await user.click(screen.getByRole('button', { name: 'Cadastro' }))
    await user.type(screen.getByLabelText('Nome completo'), 'Ana Souza')
    await user.type(screen.getByLabelText('E-mail'), 'ana@escola.local')
    await user.type(screen.getByLabelText('Senha'), 'Ponte-Velha-48')
    await user.selectOptions(await screen.findByLabelText('Curso'), 'c1')
    await user.selectOptions(screen.getByLabelText('Turma'), 'Turma A')
    fireEvent.change(screen.getByLabelText('Data de nascimento'), { target: { value: birthDate } })
  }

  it('o rodapé do login tem os links dos Termos e da Política, em outra aba', () => {
    renderLogin()
    const links = within(screen.getByTestId('login-legal-links')).getAllByRole('link')
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/termos', '/privacidade'])
    for (const link of links) expect(link).toHaveAttribute('target', '_blank')
  })

  it('adulto: manda a data e o id dos documentos lidos; os links do aceite levam a escola do curso', async () => {
    mockRegisterApis()
    mocks.post.mockResolvedValue({ success: true })
    const user = userEvent.setup()
    const { container } = renderLogin()
    await fillRegister(user, '2000-03-15')
    expect(screen.getByText('Responsável (opcional)')).toBeInTheDocument()
    const acceptLabel = screen.getByText(/Li e aceito os/)
    expect(within(acceptLabel).getByRole('link', { name: 'Termos de Uso' })).toHaveAttribute('href', '/termos?courseId=c1')
    await user.click(screen.getByRole('checkbox'))
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/legal/documents?courseId=c1', { auth: false }))
    fireEvent.submit(container.querySelector('form'))
    await waitFor(() => expect(mocks.post).toHaveBeenCalled())
    const [path, body] = mocks.post.mock.calls[0]
    expect(path).toBe('/api/student/register')
    expect(body).toMatchObject({ birthDate: '2000-03-15', acceptedTerms: true, termsDocumentId: 'termos_v2', privacyDocumentId: 'privacidade_v1', courseId: 'c1' })
    expect(body.guardian).toBeUndefined()
  })

  it('sem a data de nascimento, o cadastro não é enviado', async () => {
    mockRegisterApis()
    const user = userEvent.setup()
    const { container } = renderLogin()
    await fillRegister(user, '')
    await user.click(screen.getByRole('checkbox'))
    fireEvent.submit(container.querySelector('form'))
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Informe a data de nascimento.'))
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('menor de 18 anos: a seção do responsável abre, é obrigatória e vai no cadastro', async () => {
    mockRegisterApis()
    mocks.post.mockResolvedValue({ success: true })
    const user = userEvent.setup()
    const { container } = renderLogin()
    const year = new Date().getFullYear() - 15
    await fillRegister(user, `${year}-01-10`)
    expect(screen.getByText('Responsável (obrigatório para menores de 18 anos)')).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox'))
    fireEvent.submit(container.querySelector('form'))
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Para menores de 18 anos, informe o nome e um telefone ou e-mail do responsável.'))
    expect(mocks.post).not.toHaveBeenCalled()
    await user.type(screen.getByLabelText('Nome do responsável'), 'Maria Souza')
    await user.type(screen.getByLabelText('Telefone do responsável'), '11 98888-7777')
    fireEvent.submit(container.querySelector('form'))
    await waitFor(() => expect(mocks.post).toHaveBeenCalled())
    expect(mocks.post.mock.calls[0][1].guardian).toMatchObject({ name: 'Maria Souza', phone: '11 98888-7777' })
  })

  it('documento trocado com a tela aberta (409): desmarca o aceite e busca a versão nova', async () => {
    mockRegisterApis()
    mocks.post.mockRejectedValue(Object.assign(new Error('Os documentos foram atualizados. Leia a nova versão e marque o aceite de novo.'), {
      status: 409, data: { code: 'documents_changed', error: 'Os documentos foram atualizados. Leia a nova versão e marque o aceite de novo.' },
    }))
    const user = userEvent.setup()
    const { container } = renderLogin()
    await fillRegister(user, '2000-03-15')
    await user.click(screen.getByRole('checkbox'))
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/legal/documents?courseId=c1', { auth: false }))
    const before = mocks.get.mock.calls.filter(([path]) => path.startsWith('/api/legal/documents')).length
    fireEvent.submit(container.querySelector('form'))
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Os documentos foram atualizados. Leia a nova versão e marque o aceite de novo.'))
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    await waitFor(() => expect(mocks.get.mock.calls.filter(([path]) => path.startsWith('/api/legal/documents')).length).toBe(before + 1))
    expect(mocks.loginStudent).not.toHaveBeenCalled()
  })
})
