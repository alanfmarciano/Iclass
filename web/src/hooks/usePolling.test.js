import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MAX_BACKOFF_MS, pollingDelay, usePolling } from './usePolling'

// Fase 2, H2-C (DES-09): as consultas periódicas passam pelo usePolling. Antes eram
// setInterval: com o servidor lento, uma consulta nova saía antes de a anterior voltar e
// as consultas se acumulavam; com a aba em segundo plano, continuavam à toa.
function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function setHidden(hidden) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers()
  setHidden(false)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  setHidden(false)
})

describe('[UC-DESEMPENHO-002] usePolling: uma consulta por vez, pausa com a aba oculta e recuo na falha', () => {
  it('com o servidor mais lento que o intervalo, nunca há duas consultas ao mesmo tempo e a próxima espera o intervalo depois da resposta', async () => {
    const pending = []
    let inFlight = 0
    let maxInFlight = 0
    const task = vi.fn(() => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      const call = deferred()
      pending.push(call)
      return call.promise.finally(() => { inFlight -= 1 })
    })
    renderHook(() => usePolling(task, { intervalMs: 1000 }))
    expect(task).toHaveBeenCalledTimes(1)
    // O servidor demora 5 s: nada de consulta nova enquanto a primeira não volta.
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(task).toHaveBeenCalledTimes(1)
    await act(async () => { pending[0].resolve(true) })
    await act(async () => { await vi.advanceTimersByTimeAsync(999) })
    expect(task).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(task).toHaveBeenCalledTimes(2)
    expect(maxInFlight).toBe(1)
  })

  it('passa à consulta a marca de consulta de fundo e o prazo de 10 s', () => {
    const task = vi.fn(async () => true)
    renderHook(() => usePolling(task, { intervalMs: 1000 }))
    expect(task).toHaveBeenCalledWith({ background: true, timeoutMs: 10000 })
  })

  it('falha (false ou erro) espera mais a cada vez, até o teto, com variação; o primeiro sucesso volta ao intervalo', async () => {
    const results = [false, 'erro', false, false, true, true]
    const task = vi.fn(async () => {
      const next = results.shift()
      if (next === 'erro') throw new Error('servidor fora')
      return next
    })
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5) // variação 1,0
    try {
      renderHook(() => usePolling(task, { intervalMs: 2000 }))
      expect(task).toHaveBeenCalledTimes(1) // falha 1 → 4 s
      await act(async () => { await vi.advanceTimersByTimeAsync(3999) })
      expect(task).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(task).toHaveBeenCalledTimes(2) // falha 2 → 8 s
      await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
      expect(task).toHaveBeenCalledTimes(3) // falha 3 → 15 s (teto)
      await act(async () => { await vi.advanceTimersByTimeAsync(14999) })
      expect(task).toHaveBeenCalledTimes(3)
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(task).toHaveBeenCalledTimes(4) // falha 4 → 15 s
      await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
      expect(task).toHaveBeenCalledTimes(5) // sucesso → 2 s
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      expect(task).toHaveBeenCalledTimes(6)
    } finally {
      random.mockRestore()
    }
  })

  it('pollingDelay: dobra a cada falha até o teto, nunca abaixo do intervalo, com variação de 0,8 a 1,2', () => {
    expect(DEFAULT_MAX_BACKOFF_MS).toBe(15000)
    expect(pollingDelay(5000, 0)).toBe(5000)
    expect(pollingDelay(5000, 1, 15000, () => 0.5)).toBe(10000)
    expect(pollingDelay(5000, 5, 15000, () => 0.5)).toBe(15000)
    expect(pollingDelay(5000, 5, 15000, () => 0)).toBe(12000)
    expect(pollingDelay(5000, 5, 15000, () => 0.999999)).toBe(18000)
    // Intervalo maior que o teto (presença, 30 s): a falha nunca deixa mais frequente.
    expect(pollingDelay(30000, 3, 15000, () => 0.5)).toBe(30000)
    expect(pollingDelay(1000, 1000, 15000, () => 0.5)).toBe(15000)
  })

  it('com a aba oculta não consulta; ao voltar a ficar visível, consulta na hora', async () => {
    const task = vi.fn(async () => true)
    renderHook(() => usePolling(task, { intervalMs: 1000 }))
    expect(task).toHaveBeenCalledTimes(1)
    await act(async () => { setHidden(true) })
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    expect(task).toHaveBeenCalledTimes(1)
    await act(async () => { setHidden(false) })
    expect(task).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(task).toHaveBeenCalledTimes(3)
  })

  it('aberta com a aba oculta não consulta até ela ficar visível; pauseWhenHidden: false continua', async () => {
    setHidden(true)
    const paused = vi.fn(async () => true)
    const always = vi.fn(async () => true)
    renderHook(() => usePolling(paused, { intervalMs: 1000 }))
    renderHook(() => usePolling(always, { intervalMs: 1000, pauseWhenHidden: false }))
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(paused).not.toHaveBeenCalled()
    expect(always).toHaveBeenCalledTimes(4)
    await act(async () => { setHidden(false) })
    expect(paused).toHaveBeenCalledTimes(1)
  })

  it('runNow consulta na hora; com uma consulta em andamento, marca só uma para logo depois dela', async () => {
    const pending = []
    const task = vi.fn(() => { const call = deferred(); pending.push(call); return call.promise })
    const { result } = renderHook(() => usePolling(task, { intervalMs: 10000, immediate: false }))
    expect(task).not.toHaveBeenCalled()
    await act(async () => { result.current.runNow() })
    expect(task).toHaveBeenCalledTimes(1)
    await act(async () => { result.current.runNow(); result.current.runNow(); result.current.runNow() })
    expect(task).toHaveBeenCalledTimes(1)
    await act(async () => { pending[0].resolve(true) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(task).toHaveBeenCalledTimes(2)
    await act(async () => { pending[1].resolve(true) })
    await act(async () => { await vi.advanceTimersByTimeAsync(9999) })
    expect(task).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(task).toHaveBeenCalledTimes(3)
  })

  it('desligar, desmontar ou intervalo 0 para tudo; a resposta que chega depois não agenda outra', async () => {
    const pending = []
    const task = vi.fn(() => { const call = deferred(); pending.push(call); return call.promise })
    const { rerender, unmount } = renderHook(({ enabled }) => usePolling(task, { intervalMs: 1000, enabled }), { initialProps: { enabled: true } })
    expect(task).toHaveBeenCalledTimes(1)
    rerender({ enabled: false })
    await act(async () => { pending[0].resolve(true) })
    await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
    expect(task).toHaveBeenCalledTimes(1)
    rerender({ enabled: true })
    expect(task).toHaveBeenCalledTimes(2)
    unmount()
    await act(async () => { pending[1].resolve(true) })
    await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
    expect(task).toHaveBeenCalledTimes(2)

    const never = vi.fn(async () => true)
    renderHook(() => usePolling(never, { intervalMs: 0 }))
    await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
    expect(never).not.toHaveBeenCalled()
  })

  it('usa sempre a versão mais nova da consulta, sem reiniciar o agendamento', async () => {
    const first = vi.fn(async () => true)
    const second = vi.fn(async () => true)
    const { rerender } = renderHook(({ task }) => usePolling(task, { intervalMs: 1000 }), { initialProps: { task: first } })
    expect(first).toHaveBeenCalledTimes(1)
    rerender({ task: second })
    expect(second).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('resetKey: o endereço da consulta mudou, então ela recomeça e pergunta na hora (sem immediate, depois de um intervalo)', async () => {
    const task = vi.fn(async () => true)
    const { rerender } = renderHook(({ resetKey }) => usePolling(task, { intervalMs: 30000, resetKey }), { initialProps: { resetKey: 'turma=A' } })
    expect(task).toHaveBeenCalledTimes(1)
    rerender({ resetKey: 'turma=A' })
    expect(task).toHaveBeenCalledTimes(1)
    // Antes, trocar de turma não consultava: a contagem da turma anterior ficava até 30 s.
    rerender({ resetKey: 'turma=B' })
    expect(task).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(29999) })
    expect(task).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(task).toHaveBeenCalledTimes(3)

    const later = vi.fn(async () => true)
    const view = renderHook(({ resetKey }) => usePolling(later, { intervalMs: 1000, immediate: false, resetKey }), { initialProps: { resetKey: 'curso=1' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    view.rerender({ resetKey: 'curso=2' })
    await act(async () => { await vi.advanceTimersByTimeAsync(999) })
    expect(later).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(later).toHaveBeenCalledTimes(1)
  })

  it('resetKey: a troca zera o recuo das falhas do endereço anterior', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    try {
      const task = vi.fn(async () => false)
      const { rerender } = renderHook(({ resetKey }) => usePolling(task, { intervalMs: 1000, maxBackoffMs: 15000, resetKey }), { initialProps: { resetKey: 'a' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(2000 + 4000 + 8000) })
      expect(task).toHaveBeenCalledTimes(4)
      task.mockImplementation(async () => true)
      rerender({ resetKey: 'b' })
      expect(task).toHaveBeenCalledTimes(5)
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(task).toHaveBeenCalledTimes(6)
    } finally {
      Math.random.mockRestore()
    }
  })
})
