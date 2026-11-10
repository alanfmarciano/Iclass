import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 2, H2-A (DES-06): com as telas sob demanda, o React espera o arquivo do painel
// antes de desenhar a tela seguinte ao login. A sessão do instrutor era gravada no
// navegador só num efeito, depois desse desenho; nesse intervalo, um envio que lê a sessão
// guardada (backup, biblioteca, chamada) ou uma recarga saía sem sessão e levava 401.
const SESSION = { sessionToken: 'sessao-nova', instanceId: 'inst-1', email: 'professor@teste.local', role: 'professor', assignedClasses: ['1DES'] }
const apiMock = vi.hoisted(() => ({
  get: vi.fn(async () => ({})),
  post: vi.fn(async () => ({})),
  setAuthProvider: vi.fn(),
  deniedHandler: null,
}))
vi.mock('../lib/api', () => ({
  api: apiMock,
  setAuthProvider: apiMock.setAuthProvider,
  setAdminAccessDeniedHandler: (fn) => { apiMock.deniedHandler = fn },
}))

import { AuthProvider, useAuth } from './AuthProvider'

beforeEach(() => {
  apiMock.get.mockReset().mockImplementation(async (url) => (url === '/api/admin/whoami' ? SESSION : {}))
  apiMock.post.mockReset().mockImplementation(async (url) => (url === '/api/session/admin-login' ? SESSION : {}))
  apiMock.setAuthProvider.mockReset()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  sessionStorage.clear()
  vi.restoreAllMocks()
})

async function mountAuth() {
  const ref = { current: null }
  function Probe() { ref.current = useAuth(); return null }
  render(<AuthProvider><Probe /></AuthProvider>)
  await act(async () => {})
  return ref
}

describe('[UC-DESEMPENHO-001] sessão do instrutor gravada no momento do login', () => {
  it('loginAdmin grava a sessão no navegador antes do próximo desenho da tela', async () => {
    let ctx = null
    function Probe() { ctx = useAuth(); return null }
    render(<AuthProvider><Probe /></AuthProvider>)
    await act(async () => {})

    // Sem act de propósito: o desenho seguinte ainda não aconteceu quando o login termina,
    // como no navegador enquanto o arquivo do painel chega.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    await ctx.loginAdmin('professor@teste.local', 'teste')
    const stored = JSON.parse(localStorage.getItem('iclass-v3-auth') || '{}')
    expect(stored.role).toBe('admin')
    expect(stored.adminSession).toBe('sessao-nova')
    expect(stored.accountRole).toBe('professor')
    expect(stored.adminAuth).toBeUndefined()
    expect(JSON.stringify(stored)).not.toContain('teste"')
    await act(async () => {})
    consoleError.mockRestore()
    expect(ctx.auth.adminSession).toBe('sessao-nova')
  })
})

// Fase 2, H6b (SEG-03): a senha do instrutor vai uma vez, no corpo do POST de login. Nenhum
// pedido leva mais o cabeçalho com e-mail e senha, e a sessão guardada só tem o token.
describe('[UC-AUTH-001] login do instrutor pelo POST /api/session/admin-login', () => {
  it('manda e-mail e senha só no corpo do POST, sem sessão e sem consultar o whoami para entrar', async () => {
    const ctx = await mountAuth()
    await act(async () => { await ctx.current.loginAdmin('professor@teste.local', 'segredo-123') })
    expect(apiMock.post).toHaveBeenCalledWith('/api/session/admin-login', { email: 'professor@teste.local', password: 'segredo-123' }, { auth: false })
    expect(apiMock.get).not.toHaveBeenCalledWith('/api/admin/whoami')
    // O provedor de credenciais nunca devolve e-mail e senha para um cabeçalho.
    for (const [provider] of apiMock.setAuthProvider.mock.calls) {
      const value = typeof provider === 'function' ? provider() : provider
      expect(JSON.stringify(value || {})).not.toContain('segredo-123')
      expect(value?.adminAuth).toBeUndefined()
    }
    const stored = localStorage.getItem('iclass-v3-auth') || ''
    expect(stored).not.toContain('segredo-123')
    expect(JSON.parse(stored).adminSession).toBe('sessao-nova')
  })

  it('sessão guardada no formato antigo (só e-mail:senha, sem token) cai no login e some do navegador', async () => {
    localStorage.setItem('iclass-v3-auth', JSON.stringify({ role: 'admin', email: 'professor@teste.local', adminAuth: 'professor@teste.local:teste' }))
    const ctx = await mountAuth()
    expect(ctx.current.auth?.role).toBeUndefined()
    expect(localStorage.getItem('iclass-v3-auth')).toBeNull()
    expect(apiMock.get).not.toHaveBeenCalledWith('/api/admin/whoami')
  })
})

describe('[UC-REDE-001] painel do professor recusado neste aparelho', () => {
  it('403 com adminAccess encerra a sessão do instrutor e guarda o motivo do servidor para o login', async () => {
    const ctx = await mountAuth()
    await act(async () => { await ctx.current.loginAdmin('professor@teste.local', 'teste') })
    expect(ctx.current.auth?.adminSession).toBe('sessao-nova')
    const text = 'O painel do professor só abre no computador onde o IClass está ligado. O administrador pode liberar outros aparelhos em Sistema → Rede.'
    await act(async () => { apiMock.deniedHandler({ adminAccess: 'local-only', error: text }) })
    expect(ctx.current.auth?.role).toBeUndefined()
    expect(localStorage.getItem('iclass-v3-auth')).toBeNull()
    expect(sessionStorage.getItem('iclass-logout-reason')).toBe('admin-network')
    expect(sessionStorage.getItem('iclass-logout-message')).toBe(text)
  })

  it('a recusa não encerra a sessão do aluno (o painel do aluno nunca é bloqueado pela rede)', async () => {
    apiMock.post.mockImplementation(async (url) => (url === '/api/student/login' ? { sessionToken: 'tok-aluno', student: { email: 'aluno@teste.local', name: 'Aluno' }, instanceId: 'inst-1' } : {}))
    const ctx = await mountAuth()
    await act(async () => { await ctx.current.loginStudent('aluno@teste.local', 'teste') })
    const before = ctx.current.auth
    expect(before?.role).toBe('student')
    await act(async () => { apiMock.deniedHandler({ adminAccess: 'local-only', error: 'x' }) })
    expect(ctx.current.auth).toEqual(before)
    expect(sessionStorage.getItem('iclass-logout-reason')).toBeNull()
  })

  it('validação da sessão guardada com 403 de rede encerra com o motivo, não como "sessão expirada"', async () => {
    localStorage.setItem('iclass-v3-auth', JSON.stringify({ role: 'admin', email: 'professor@teste.local', adminSession: 'sessao-antiga', serverInstanceId: 'inst-1' }))
    apiMock.get.mockImplementation(async (url) => {
      if (url === '/api/admin/whoami') throw Object.assign(new Error('Só no computador do IClass.'), { status: 403, data: { adminAccess: 'local-only', error: 'Só no computador do IClass.' } })
      if (url === '/api/session/status') return { instanceId: 'inst-1' }
      return {}
    })
    const ctx = await mountAuth()
    await act(async () => {})
    expect(ctx.current.auth?.role).toBeUndefined()
    expect(sessionStorage.getItem('iclass-logout-reason')).toBe('admin-network')
    expect(sessionStorage.getItem('iclass-logout-message')).toBe('Só no computador do IClass.')
  })
})
