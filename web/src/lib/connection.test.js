import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PROBE_FIRST_MS,
  getConnectionState,
  probeDelay,
  reportFailure,
  reportResponse,
  reportSuccess,
  resetConnectionForTests,
  setConnectionProbe,
  subscribeConnection,
} from './connection'

// Frente do H3 (CONF-03, UXA-06, DES-08): estado da conexão com o servidor, alimentado por
// todas as respostas do cliente da API. Antes não existia: cada tela via um erro solto.
const network = () => Object.assign(new Error('Sem conexão'), { status: 0, network: true })

beforeEach(() => {
  resetConnectionForTests()
  setConnectionProbe(null)
})
afterEach(() => {
  vi.useRealTimers()
  resetConnectionForTests()
  setConnectionProbe(null)
})

describe('[UC-AUTH-001] estado da conexão com o servidor', () => {
  it('1 falha de rede continua online; 2 seguidas levam a offline; qualquer resposta volta a online e avisa quem assina', () => {
    const seen = []
    subscribeConnection((state, previous) => seen.push([state, previous]))
    reportFailure(network())
    expect(getConnectionState()).toBe('online')
    reportFailure(Object.assign(new Error('demorou'), { status: 0, timeout: true }))
    expect(getConnectionState()).toBe('offline')
    reportResponse(404, { error: 'Não encontrado.' })
    expect(getConnectionState()).toBe('online')
    expect(seen).toEqual([['offline', 'online'], ['online', 'offline']])
  })

  it('uma resposta entre duas falhas zera a contagem', () => {
    reportFailure(network())
    reportSuccess()
    reportFailure(network())
    expect(getConnectionState()).toBe('online')
  })

  it('503 starting vai para starting na hora; 503 de manutenção não muda; 503 retryable é resposta (online)', () => {
    reportResponse(503, { maintenance: true })
    expect(getConnectionState()).toBe('online')
    reportResponse(503, { starting: true })
    expect(getConnectionState()).toBe('starting')
    reportResponse(503, { maintenance: true })
    expect(getConnectionState()).toBe('starting')
    reportResponse(503, { retryable: true })
    expect(getConnectionState()).toBe('online')
  })

  it('pedido cancelado por quem chamou não conta como falha', () => {
    const aborted = Object.assign(new Error('Pedido cancelado.'), { name: 'AbortError', aborted: true, status: 0 })
    reportFailure(aborted)
    reportFailure(aborted)
    expect(getConnectionState()).toBe('online')
  })

  it('fora de online confere o servidor a cada 2 s, recuando até 5 s, uma conferência por vez; a resposta para a conferência', async () => {
    vi.useFakeTimers()
    const probe = vi.fn(async () => {})
    setConnectionProbe(probe)
    reportFailure(network())
    reportFailure(network())
    expect(probe).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(PROBE_FIRST_MS)
    expect(probe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(probeDelay(1))
    expect(probe).toHaveBeenCalledTimes(2)
    expect([probeDelay(0), probeDelay(1), probeDelay(3), probeDelay(10)]).toEqual([2000, 3000, 5000, 5000])
    reportSuccess()
    await vi.advanceTimersByTimeAsync(20000)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('quem assina pode sair, e um assinante com erro não derruba os outros', () => {
    const second = vi.fn()
    const stop = subscribeConnection(() => { throw new Error('quebrou') })
    subscribeConnection(second)
    reportResponse(503, { starting: true })
    expect(second).toHaveBeenCalledWith('starting', 'online')
    stop()
    reportSuccess()
    expect(second).toHaveBeenLastCalledWith('online', 'starting')
  })
})
