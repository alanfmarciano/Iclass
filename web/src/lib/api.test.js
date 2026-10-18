import { afterEach, describe, expect, it } from 'vitest'
import { hasActiveSession, setAuthProvider } from './api'

afterEach(() => {
  setAuthProvider(() => ({}))
  localStorage.clear()
})

describe('[UC-PROVA-003] sessão aberta no navegador (AVA-12)', () => {
  it('fica fechada logo depois do logout, mesmo com a sessão antiga ainda no armazenamento', () => {
    localStorage.setItem('iclass-v3-auth', JSON.stringify({ role: 'student', sessionToken: 'token-antigo' }))
    setAuthProvider(() => ({ role: 'student', sessionToken: 'token-aluno' }))
    expect(hasActiveSession()).toBe(true)
    // O AuthProvider limpa o provedor na hora do logout, antes de trocar de rota.
    setAuthProvider(() => ({}))
    expect(hasActiveSession()).toBe(false)
  })

  it('instrutor com sessão também conta como sessão aberta', () => {
    setAuthProvider(() => ({ role: 'admin', adminSession: 'sessao-admin' }))
    expect(hasActiveSession()).toBe(true)
  })
})
