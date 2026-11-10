import { act, cleanup, render } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 2, H2-C (DES-09): a presença do aluno no portal vai a cada 15 s (antes, 4 s), uma
// por vez, sem ping com a aba oculta e com ping na hora quando ela volta. Com 30 alunos,
// eram 7,5 pedidos por segundo só de presença; agora são 2.
const apiGet = vi.hoisted(() => vi.fn())
const authMock = vi.hoisted(() => ({ endSessionFromError: vi.fn(), syncPasswordChange: vi.fn() }))
vi.mock('../../lib/api', () => ({ api: { get: apiGet } }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: { role: 'student', email: 'ana@escola.local' }, endSessionFromError: authMock.endSessionFromError, syncPasswordChange: authMock.syncPasswordChange }) }))

import { HEARTBEAT_MS, useStudentHeartbeat } from './useStudentHeartbeat'

function Portal() {
  useStudentHeartbeat()
  return <p>Portal</p>
}

function renderPortal() {
  return render(
    <MemoryRouter initialEntries={['/aluno']}>
      <Routes>
        <Route path="/aluno" element={<Portal />} />
        <Route path="/login" element={<p>Tela de login</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

function setHidden(hidden) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers()
  apiGet.mockReset()
  apiGet.mockResolvedValue({ success: true })
  authMock.endSessionFromError.mockReset()
  authMock.endSessionFromError.mockResolvedValue(undefined)
  authMock.syncPasswordChange.mockReset()
  setHidden(false)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  setHidden(false)
})

describe('[UC-DESEMPENHO-002] presença do aluno no portal', () => {
  it('ping ao abrir e depois a cada 15 s, como consulta de fundo com prazo de 10 s', async () => {
    expect(HEARTBEAT_MS).toBe(15000)
    renderPortal()
    expect(apiGet).toHaveBeenCalledTimes(1)
    expect(apiGet).toHaveBeenCalledWith('/api/ping?email=ana%40escola.local', { background: true, timeoutMs: 10000 })
    await act(async () => { await vi.advanceTimersByTimeAsync(14999) })
    expect(apiGet).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(apiGet).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(15000 * 4) })
    expect(apiGet).toHaveBeenCalledTimes(6)
  })

  it('com a aba oculta não manda ping; ao voltar, manda na hora', async () => {
    renderPortal()
    expect(apiGet).toHaveBeenCalledTimes(1)
    await act(async () => { setHidden(true) })
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000) })
    expect(apiGet).toHaveBeenCalledTimes(1)
    await act(async () => { setHidden(false) })
    expect(apiGet).toHaveBeenCalledTimes(2)
  })

  it('servidor lento: nunca dois pings ao mesmo tempo', async () => {
    let release
    apiGet.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    renderPortal()
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    expect(apiGet).toHaveBeenCalledTimes(1)
    await act(async () => { release({ success: true }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
    expect(apiGet).toHaveBeenCalledTimes(2)
  })

  it('sessão revogada: sai para o login na hora', async () => {
    const err = Object.assign(new Error('Sessão encerrada'), { status: 401, data: { sessionRevoked: true } })
    apiGet.mockRejectedValueOnce(err)
    const view = renderPortal()
    await act(async () => {})
    expect(authMock.endSessionFromError).toHaveBeenCalledTimes(1)
    expect(authMock.endSessionFromError).toHaveBeenCalledWith(err)
    expect(view.getByText('Tela de login')).toBeInTheDocument()
  })
})

// Fase 2, H5a (UXA-13): o ping diz se a troca de senha obrigatória vale para a sessão (o
// professor redefiniu a senha com o aluno no portal); o portal passa a mostrar a troca.
describe('[UC-SENHA-001] presença e troca de senha obrigatória', () => {
  it('passa ao AuthProvider o que o ping diz da troca de senha', async () => {
    apiGet.mockResolvedValueOnce({ success: true, passwordChangeRequired: true, passwordChangeReason: 'reset' })
    renderPortal()
    await act(async () => { await Promise.resolve() })
    expect(authMock.syncPasswordChange).toHaveBeenCalledWith(true, 'reset')
    apiGet.mockResolvedValueOnce({ success: true, passwordChangeRequired: false })
    await act(async () => { await vi.advanceTimersByTimeAsync(HEARTBEAT_MS) })
    expect(authMock.syncPasswordChange).toHaveBeenLastCalledWith(false, undefined)
  })

  it('resposta de servidor antigo (sem o campo) não mexe na troca', async () => {
    renderPortal()
    await act(async () => { await Promise.resolve() })
    expect(authMock.syncPasswordChange).not.toHaveBeenCalled()
  })
})

// Fase 2, H5b ajuste 2 (contrato 401 { sessionRevoked, reason }): a senha redefinida pelo
// professor chega ao login com o texto do servidor, e não como "sessão expirada".
describe('[UC-AUTH-003] presença com a sessão encerrada no servidor', () => {
  const RESET = 'A senha desta conta foi redefinida pelo professor. Entre de novo com a senha nova.'

  // O motivo (e o "servidor reiniciado" quando a sessão não voltou depois do reinício) é
  // decidido no AuthProvider (endSessionFromError), com o mesmo critério da abertura e da
  // revalidação; o ping só entrega o erro e vai para o login.
  it('401 com reason password_reset: entrega o erro ao AuthProvider e vai para o login', async () => {
    const err = Object.assign(new Error(RESET), { status: 401, data: { error: RESET, sessionRevoked: true, reason: 'password_reset' } })
    apiGet.mockRejectedValue(err)
    const view = renderPortal()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(authMock.endSessionFromError).toHaveBeenCalledWith(err)
    expect(view.getByText('Tela de login')).toBeInTheDocument()
  })

  it('401 expired (servidor reiniciado mais de 60 min fora do ar): também passa pelo AuthProvider', async () => {
    const err = Object.assign(new Error('Sessão expirada.'), { status: 401, data: { sessionRevoked: true, reason: 'expired' } })
    apiGet.mockRejectedValue(err)
    renderPortal()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(authMock.endSessionFromError).toHaveBeenCalledWith(err)
  })

  it('falha de rede ou 503: não sai da sessão', async () => {
    apiGet.mockRejectedValue(Object.assign(new Error('Sem conexão'), { status: 0, network: true }))
    renderPortal()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    apiGet.mockRejectedValue(Object.assign(new Error('Iniciando'), { status: 503, data: { starting: true } }))
    await act(async () => { await vi.advanceTimersByTimeAsync(HEARTBEAT_MS) })
    expect(authMock.endSessionFromError).not.toHaveBeenCalled()
  })
})

