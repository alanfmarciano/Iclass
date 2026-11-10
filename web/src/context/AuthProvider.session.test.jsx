import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 2, H5b (DES-X2, SEG-10, SEG-16): o "Sair" do aluno encerra a sessão no servidor, e o
// navegador guarda só o perfil que o portal usa.
const mocks = vi.hoisted(() => ({
  provider: () => ({}),
  get: vi.fn(),
  post: vi.fn(),
  tokensAtPost: [],
}))

vi.mock('../lib/api', () => ({
  api: { get: mocks.get, post: mocks.post },
  setAuthProvider: (fn) => { mocks.provider = fn },
  setAdminAccessDeniedHandler: () => {},
  setPasswordChangeRequiredHandler: () => {},
}))
vi.mock('../hooks/usePolling', () => ({ usePolling: () => ({ runNow: () => {} }) }))

import { AuthProvider, useAuth } from './AuthProvider'

const LS = 'iclass-v3-auth'
const FULL_STUDENT = {
  email: 'ana@escola.local',
  name: 'Ana',
  nomeSocial: '',
  status: 'active',
  matricula: '2024-01',
  classes: [{ name: 'T1', courseId: 'c1' }],
  courses: [{ id: 'c1', name: 'Curso' }],
  guardian: 'Maria',
  guardianPhone: '11 99999-0000',
  phone: '11 98888-0000',
  accessibility: { needs: 'baixa visão' },
  birthDate: '2008-02-01',
  password: 'scrypt$segredo',
}

let ctx = null
function Probe() {
  ctx = useAuth()
  return <div data-testid="role">{ctx.auth.role || 'none'}</div>
}
function renderProvider() {
  return render(<AuthProvider><Probe /></AuthProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.tokensAtPost = []
  mocks.get.mockImplementation(async (path) => {
    if (path === '/api/session/status') return { instanceId: 'inst-1' }
    if (path.startsWith('/api/ping')) return { ok: true }
    if (path === '/api/settings/public') return {}
    return {}
  })
  mocks.post.mockImplementation(async (path, body) => {
    // A sessão que o pedido leva é a do momento da chamada (os cabeçalhos saem na hora).
    mocks.tokensAtPost.push({ path, token: mocks.provider()?.sessionToken || null })
    if (path === '/api/student/login') {
      return { success: true, sessionToken: 'tok-novo', instanceId: 'inst-1', student: { ...FULL_STUDENT, email: body.email } }
    }
    return { success: true }
  })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  sessionStorage.clear()
  ctx = null
})

describe('[UC-AUTH-003] sessão do aluno no navegador', () => {
  it('"Sair" do aluno chama /api/student/logout com a sessão ainda nos cabeçalhos e limpa o navegador', async () => {
    localStorage.setItem(LS, JSON.stringify({ role: 'student', email: 'ana@escola.local', sessionToken: 'tok-1', serverInstanceId: 'inst-1', loginAt: Date.now(), student: { email: 'ana@escola.local', name: 'Ana' } }))
    renderProvider()
    await waitFor(() => expect(screen.getByTestId('role')).toHaveTextContent('student'))
    act(() => { ctx.logout() })
    expect(mocks.post).toHaveBeenCalledWith('/api/student/logout', {}, { keepalive: true })
    expect(mocks.tokensAtPost).toContainEqual({ path: '/api/student/logout', token: 'tok-1' })
    await waitFor(() => expect(screen.getByTestId('role')).toHaveTextContent('none'))
    expect(localStorage.getItem(LS)).toBeNull()
  })

  it('a falha de rede no logout não segura a saída', async () => {
    mocks.post.mockImplementation(async () => { throw Object.assign(new Error('Sem conexão'), { status: 0, network: true }) })
    localStorage.setItem(LS, JSON.stringify({ role: 'student', email: 'ana@escola.local', sessionToken: 'tok-1', serverInstanceId: 'inst-1', loginAt: Date.now(), student: { email: 'ana@escola.local' } }))
    renderProvider()
    await waitFor(() => expect(screen.getByTestId('role')).toHaveTextContent('student'))
    act(() => { ctx.logout() })
    await waitFor(() => expect(screen.getByTestId('role')).toHaveTextContent('none'))
    expect(localStorage.getItem(LS)).toBeNull()
  })

  it('a sessão guardada por uma versão anterior perde os dados pessoais ao abrir', async () => {
    localStorage.setItem(LS, JSON.stringify({ role: 'student', email: 'ana@escola.local', sessionToken: 'tok-1', serverInstanceId: 'inst-1', loginAt: Date.now(), student: FULL_STUDENT }))
    renderProvider()
    await waitFor(() => expect(screen.getByTestId('role')).toHaveTextContent('student'))
    const stored = JSON.parse(localStorage.getItem(LS))
    expect(stored.sessionToken).toBe('tok-1')
    expect(stored.student).toEqual({
      email: 'ana@escola.local', name: 'Ana', nomeSocial: '', status: 'active', matricula: '2024-01',
      classes: [{ name: 'T1', courseId: 'c1' }], courses: [{ id: 'c1', name: 'Curso' }],
    })
    for (const field of ['guardian', 'guardianPhone', 'phone', 'accessibility', 'birthDate', 'password']) {
      expect(JSON.stringify(stored)).not.toContain(field)
    }
  })

  it('o login do aluno guarda só o perfil do portal, mesmo que o servidor mande mais', async () => {
    renderProvider()
    await waitFor(() => expect(ctx).not.toBeNull())
    await act(async () => { await ctx.loginStudent('ana@escola.local', 'segredo') })
    const stored = JSON.parse(localStorage.getItem(LS))
    expect(stored.role).toBe('student')
    expect(stored.student.name).toBe('Ana')
    expect(stored.student.guardianPhone).toBeUndefined()
    expect(stored.student.accessibility).toBeUndefined()
    expect(stored.student.password).toBeUndefined()
  })

  it('o "Sair" do instrutor continua revogando no /api/session/logout', async () => {
    mocks.get.mockImplementation(async (path) => {
      if (path === '/api/session/status') return { instanceId: 'inst-1' }
      if (path === '/api/admin/whoami') return { email: 'prof@escola.local', role: 'professor', sessionToken: 'adm-1', instanceId: 'inst-1' }
      return {}
    })
    localStorage.setItem(LS, JSON.stringify({ role: 'admin', email: 'prof@escola.local', adminSession: 'adm-1', serverInstanceId: 'inst-1', loginAt: Date.now() }))
    renderProvider()
    await waitFor(() => expect(screen.getByTestId('role')).toHaveTextContent('admin'))
    act(() => { ctx.logout() })
    expect(mocks.post).toHaveBeenCalledWith('/api/session/logout', {}, { keepalive: true })
    expect(mocks.post).not.toHaveBeenCalledWith('/api/student/logout', expect.anything(), expect.anything())
  })
})
