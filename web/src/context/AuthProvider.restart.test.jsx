import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Frente do H3 (CONF-03, UXA-06): reinício do servidor sem expulsar ninguém. Antes, ao ver
// o instanceId novo do servidor, o AuthProvider chamava doLogout('restart') direto: todos
// iam para o login (inclusive quem estava no meio da prova) e a cópia local das respostas
// era apagada, mesmo com o servidor tendo retomado as sessões. Agora a sessão é conferida
// (ping do aluno, whoami do instrutor) e só um 401/403 de verdade desloga.
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  polls: [],
  clearAllExamDrafts: vi.fn(),
  connectionListeners: new Set(),
}))

vi.mock('../lib/api', () => ({
  api: { get: mocks.get, post: mocks.post },
  setAuthProvider: () => {},
  setAdminAccessDeniedHandler: () => {},
  setPasswordChangeRequiredHandler: () => {},
}))
vi.mock('../lib/examDrafts', () => ({ clearAllExamDrafts: mocks.clearAllExamDrafts }))
// As consultas periódicas ficam guardadas: o teste roda cada uma quando quiser.
vi.mock('../hooks/usePolling', () => ({
  usePolling: (task) => {
    mocks.polls.push(task)
    return { runNow: () => task({}) }
  },
}))
vi.mock('../hooks/useServerConnection', () => ({
  useOnReconnect: (fn) => { mocks.connectionListeners.add(fn) },
}))

import { AuthProvider, useAuth } from './AuthProvider'

const LS = 'iclass-v3-auth'
let ctx = null
let serverInstance = 'inst-1'
let pingResult = () => ({ success: true })
let whoamiResult = () => ({ sessionToken: 'adm-1', instanceId: serverInstance, email: 'prof@x.local', role: 'professor' })

function Probe() {
  ctx = useAuth()
  return <div data-testid="role">{ctx.auth.role || 'none'}</div>
}

// A conferência da instância é a consulta periódica que chama /api/session/status.
async function runInstanceCheck() {
  const tasks = [...mocks.polls]
  for (const task of tasks) {
    const before = mocks.get.mock.calls.length
    await act(async () => { await task({}) })
    const paths = mocks.get.mock.calls.slice(before).map(([path]) => path)
    if (paths.includes('/api/session/status')) return
  }
}

function storeStudent() {
  localStorage.setItem(LS, JSON.stringify({ role: 'student', email: 'ana@x.local', sessionToken: 'tok-ana', serverInstanceId: 'inst-1', loginAt: Date.now(), student: { email: 'ana@x.local', name: 'Ana' } }))
}

function storeAdmin() {
  localStorage.setItem(LS, JSON.stringify({ role: 'admin', email: 'prof@x.local', adminSession: 'adm-1', serverInstanceId: 'inst-1', loginAt: Date.now() }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.polls = []
  mocks.connectionListeners = new Set()
  serverInstance = 'inst-1'
  pingResult = () => ({ success: true })
  whoamiResult = () => ({ sessionToken: 'adm-1', instanceId: serverInstance, email: 'prof@x.local', role: 'professor' })
  mocks.get.mockImplementation(async (path) => {
    if (path === '/api/session/status') return { instanceId: serverInstance }
    if (path.startsWith('/api/ping')) return pingResult()
    if (path === '/api/admin/whoami') return whoamiResult()
    return {}
  })
  mocks.post.mockResolvedValue({ success: true })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  sessionStorage.clear()
  ctx = null
})

describe('[UC-AUTH-001] servidor reiniciado: o navegador confere a sessão em vez de deslogar', () => {
  it('aluno: instanceId novo e /api/ping 200 continua logado, guarda o instanceId novo e não apaga a cópia local da prova', async () => {
    storeStudent()
    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(ctx.authReady).toBe(true))
    serverInstance = 'inst-2'
    await runInstanceCheck()
    expect(mocks.get.mock.calls.some(([path]) => path.startsWith('/api/ping'))).toBe(true)
    expect(screen.getByTestId('role')).toHaveTextContent('student')
    await waitFor(() => expect(ctx.auth.serverInstanceId).toBe('inst-2'))
    expect(mocks.clearAllExamDrafts).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('iclass-logout-reason')).toBeNull()
  })

  it('aluno: instanceId novo e /api/ping 401 vai para o login com "O servidor foi reiniciado"', async () => {
    storeStudent()
    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(ctx.authReady).toBe(true))
    serverInstance = 'inst-2'
    pingResult = () => { throw Object.assign(new Error('Sessão expirada'), { status: 401, data: { sessionRevoked: true, reason: 'expired' } }) }
    await runInstanceCheck()
    await waitFor(() => expect(screen.getByTestId('role')).toHaveTextContent('none'))
    expect(sessionStorage.getItem('iclass-logout-reason')).toBe('restart')
  })

  it('aluno: 401 com motivo do servidor (senha redefinida) leva o motivo ao login', async () => {
    storeStudent()
    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(ctx.authReady).toBe(true))
    serverInstance = 'inst-2'
    pingResult = () => { throw Object.assign(new Error('A senha desta conta foi redefinida pelo professor.'), { status: 401, data: { sessionRevoked: true, reason: 'password_reset', error: 'A senha desta conta foi redefinida pelo professor.' } }) }
    await runInstanceCheck()
    await waitFor(() => expect(screen.getByTestId('role')).toHaveTextContent('none'))
    expect(sessionStorage.getItem('iclass-logout-reason')).toBe('password_reset')
    expect(sessionStorage.getItem('iclass-logout-message')).toMatch(/redefinida/)
  })

  it('aluno: erro de rede ou servidor iniciando (503) na conferência mantém a sessão e o instanceId antigo, para tentar de novo', async () => {
    storeStudent()
    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(ctx.authReady).toBe(true))
    serverInstance = 'inst-2'
    for (const failure of [
      Object.assign(new Error('Sem conexão'), { status: 0, network: true }),
      Object.assign(new Error('O IClass está iniciando.'), { status: 503, starting: true, data: { starting: true } }),
    ]) {
      pingResult = () => { throw failure }
      await runInstanceCheck()
      expect(screen.getByTestId('role')).toHaveTextContent('student')
      expect(ctx.auth.serverInstanceId).toBe('inst-1')
    }
    pingResult = () => ({ success: true })
    await runInstanceCheck()
    await waitFor(() => expect(ctx.auth.serverInstanceId).toBe('inst-2'))
  })

  it('instrutor: instanceId novo e whoami 200 continua logado; whoami 401 vai para o login', async () => {
    storeAdmin()
    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(ctx.authReady).toBe(true))
    serverInstance = 'inst-2'
    await runInstanceCheck()
    expect(screen.getByTestId('role')).toHaveTextContent('admin')
    await waitFor(() => expect(ctx.auth.serverInstanceId).toBe('inst-2'))

    serverInstance = 'inst-3'
    whoamiResult = () => { throw Object.assign(new Error('Sessão expirada.'), { status: 401, data: { sessionRevoked: true, reason: 'expired' } }) }
    await runInstanceCheck()
    await waitFor(() => expect(screen.getByTestId('role')).toHaveTextContent('none'))
    expect(sessionStorage.getItem('iclass-logout-reason')).toBe('restart')
  })

  it('página aberta depois do reinício (instanceId guardado é o antigo): confere a sessão e não desloga', async () => {
    serverInstance = 'inst-2'
    storeStudent()
    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(ctx.authReady).toBe(true))
    expect(screen.getByTestId('role')).toHaveTextContent('student')
    await waitFor(() => expect(ctx.auth.serverInstanceId).toBe('inst-2'))
    expect(mocks.clearAllExamDrafts).not.toHaveBeenCalled()
  })

  it('a volta da conexão confere a sessão na hora', async () => {
    storeStudent()
    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(ctx.authReady).toBe(true))
    expect(mocks.connectionListeners.size).toBeGreaterThan(0)
    serverInstance = 'inst-2'
    const before = mocks.get.mock.calls.length
    await act(async () => { [...mocks.connectionListeners].forEach((fn) => fn()) })
    await waitFor(() => expect(mocks.get.mock.calls.slice(before).some(([path]) => path === '/api/session/status')).toBe(true))
    await waitFor(() => expect(ctx.auth.serverInstanceId).toBe('inst-2'))
    expect(screen.getByTestId('role')).toHaveTextContent('student')
  })
})

// Frente do H3, ajuste 1: o ping de presença do aluno (15 s) recebe o 401 antes da
// conferência da instância (60 s). Ele saía sem motivo, e o aluno chegava ao login sem
// aviso nenhum quando a sessão não voltou depois do reinício (mais de 60 min fora do ar),
// enquanto o professor via "O servidor foi reiniciado". Agora o ping entrega o erro ao
// AuthProvider (endSessionFromError), com o mesmo critério da revalidação.
describe('[UC-AUTH-001] sessão recusada numa chamada de fundo (ping do aluno)', () => {
  const expired = () => Object.assign(new Error('Sessão expirada'), { status: 401, data: { sessionRevoked: true, reason: 'expired' } })

  it('401 expired com o servidor de instância nova: login com "O servidor foi reiniciado"', async () => {
    storeStudent()
    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(ctx.authReady).toBe(true))
    serverInstance = 'inst-2'
    await act(async () => { await ctx.endSessionFromError(expired()) })
    expect(screen.getByTestId('role')).toHaveTextContent('none')
    expect(sessionStorage.getItem('iclass-logout-reason')).toBe('restart')
  })

  it('401 expired com o mesmo servidor: login com "Sua sessão expirou"', async () => {
    storeStudent()
    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(ctx.authReady).toBe(true))
    await act(async () => { await ctx.endSessionFromError(expired()) })
    expect(screen.getByTestId('role')).toHaveTextContent('none')
    expect(sessionStorage.getItem('iclass-logout-reason')).toBe('expired')
  })

  it('401 expired sem resposta do /api/session/status: login com "Sua sessão expirou"', async () => {
    storeStudent()
    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(ctx.authReady).toBe(true))
    mocks.get.mockImplementation(async () => { throw Object.assign(new Error('Sem conexão'), { status: 0, network: true }) })
    await act(async () => { await ctx.endSessionFromError(expired()) })
    expect(sessionStorage.getItem('iclass-logout-reason')).toBe('expired')
  })

  it('401 com motivo do servidor (outro aparelho) leva o motivo, sem consultar a instância', async () => {
    storeStudent()
    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(ctx.authReady).toBe(true))
    serverInstance = 'inst-2'
    const before = mocks.get.mock.calls.length
    const replaced = Object.assign(new Error('Outro aparelho'), { status: 401, data: { sessionRevoked: true, reason: 'replaced', error: 'Sessão encerrada porque a conta foi acessada em outro dispositivo.' } })
    await act(async () => { await ctx.endSessionFromError(replaced) })
    expect(sessionStorage.getItem('iclass-logout-reason')).toBe('replaced')
    expect(sessionStorage.getItem('iclass-logout-message')).toMatch(/outro dispositivo/)
    expect(mocks.get.mock.calls.slice(before).map(([p]) => p)).not.toContain('/api/session/status')
  })
})
