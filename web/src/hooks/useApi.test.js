import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 2, H2-C (DES-09): o pollMs do useApi passa pelo usePolling. Antes era um
// setInterval: com o servidor mais lento que o intervalo, cada consulta nova invalidava a
// anterior e a tela nunca atualizava, enquanto as consultas se acumulavam.
const apiGet = vi.hoisted(() => vi.fn())
vi.mock('../lib/api', () => ({ api: { get: apiGet } }))

import { useApi } from './useApi'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.useFakeTimers()
  apiGet.mockReset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('[UC-DESEMPENHO-002] useApi com pollMs', () => {
  it('servidor mais lento que o intervalo: uma consulta por vez e a tela atualiza com a resposta', async () => {
    const calls = []
    apiGet.mockImplementation(() => { const call = deferred(); calls.push(call); return call.promise })
    const { result } = renderHook(() => useApi('/api/admin/forum', [], { pollMs: 1000 }))
    expect(apiGet).toHaveBeenCalledTimes(1)
    await act(async () => { calls[0].resolve({ versao: 1 }) })
    expect(result.current.data).toEqual({ versao: 1 })
    expect(result.current.loading).toBe(false)

    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(apiGet).toHaveBeenCalledTimes(2)
    // A consulta periódica sai como consulta de fundo, com prazo.
    expect(apiGet).toHaveBeenLastCalledWith('/api/admin/forum', { background: true, timeoutMs: 10000 })
    // O servidor demora 6 s: nenhuma consulta nova nesse meio-tempo.
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(apiGet).toHaveBeenCalledTimes(2)
    await act(async () => { calls[1].resolve({ versao: 2 }) })
    expect(result.current.data).toEqual({ versao: 2 })
    expect(result.current.loading).toBe(false)
  })

  it('com a primeira carga ainda em andamento, a consulta periódica não sai', async () => {
    const calls = []
    apiGet.mockImplementation(() => { const call = deferred(); calls.push(call); return call.promise })
    renderHook(() => useApi('/api/student/forum', [], { pollMs: 1000 }))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(apiGet).toHaveBeenCalledTimes(1)
    await act(async () => { calls[0].resolve({}) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(apiGet).toHaveBeenCalledTimes(2)
  })

  it('falha da consulta periódica mostra o erro, recua e a próxima resposta limpa o erro', async () => {
    apiGet.mockResolvedValueOnce({ ok: 1 })
    const { result } = renderHook(() => useApi('/api/x', [], { pollMs: 1000 }))
    await act(async () => {})
    expect(result.current.data).toEqual({ ok: 1 })
    apiGet.mockRejectedValueOnce(Object.assign(new Error('Sem conexão'), { status: 0, network: true }))
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(result.current.error?.network).toBe(true)
      expect(result.current.data).toEqual({ ok: 1 })
      apiGet.mockResolvedValueOnce({ ok: 2 })
      // Recuo: 2 s depois da falha (não 1 s).
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(apiGet).toHaveBeenCalledTimes(2)
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(apiGet).toHaveBeenCalledTimes(3)
      expect(result.current.error).toBeNull()
      expect(result.current.data).toEqual({ ok: 2 })
    } finally {
      random.mockRestore()
    }
  })

  it('sem pollMs não consulta de novo; refetch continua devolvendo os dados novos', async () => {
    apiGet.mockResolvedValue({ n: 1 })
    const { result } = renderHook(() => useApi('/api/y', []))
    await act(async () => {})
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    expect(apiGet).toHaveBeenCalledTimes(1)
    apiGet.mockResolvedValue({ n: 2 })
    await act(async () => { await result.current.refetch() })
    expect(result.current.data).toEqual({ n: 2 })
    expect(apiGet).toHaveBeenLastCalledWith('/api/y', undefined)
  })
})
