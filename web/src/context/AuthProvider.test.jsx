import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Fase 2, H2-A (DES-06): com as telas sob demanda, o React espera o arquivo do painel
// antes de desenhar a tela seguinte ao login. A sessão do instrutor era gravada no
// navegador só num efeito, depois desse desenho; nesse intervalo, um envio que lê a sessão
// guardada (backup, biblioteca, chamada) ou uma recarga saía sem sessão e levava 401.
const apiMock = vi.hoisted(() => ({
  get: vi.fn(async (url) => {
    if (url === '/api/admin/whoami') {
      return { sessionToken: 'sessao-nova', instanceId: 'inst-1', email: 'professor@teste.local', role: 'professor', assignedClasses: ['1DES'] }
    }
    return {}
  }),
  post: vi.fn(async () => ({})),
}))
vi.mock('../lib/api', () => ({ api: apiMock, setAuthProvider: vi.fn() }))

import { AuthProvider, useAuth } from './AuthProvider'

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
})

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
