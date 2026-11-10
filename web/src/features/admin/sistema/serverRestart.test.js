import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../../../lib/api', () => ({ api: { get: mocks.get } }))

import { readServerHealth, waitForServerRestart, RESTART_WAIT_MS, REQUEST_TIMEOUT_MS } from './serverRestart'

// Relógio falso: cada espera avança o tempo, sem esperar de verdade.
function fakeClock() {
  let t = 0
  return { now: () => t, sleep: async (ms) => { t += ms } }
}

describe('serverRestart · espera do Reiniciar', () => {
  it('[UC-MANUT-001] volta quando o /api/health mostra outro instanceId já pronto (passa pela queda e pelo "iniciando")', async () => {
    const clock = fakeClock()
    const answers = [
      { status: 'ok', instanceId: 'antigo' },
      null,
      { status: 'starting', instanceId: 'novo' },
      { status: 'ok', instanceId: 'novo' },
    ]
    const readHealth = vi.fn(async () => answers.shift())
    const result = await waitForServerRestart({ previousInstanceId: 'antigo', readHealth, ...clock })
    expect(result).toEqual({ ok: true, health: { status: 'ok', instanceId: 'novo' } })
    expect(readHealth).toHaveBeenCalledTimes(4)
  })

  it('[UC-MANUT-001] desiste em 90 s se o servidor não voltar', async () => {
    const clock = fakeClock()
    const readHealth = vi.fn(async () => null)
    expect(RESTART_WAIT_MS).toBe(90000)
    const result = await waitForServerRestart({ previousInstanceId: 'antigo', readHealth, ...clock })
    expect(result).toEqual({ ok: false })
    expect(clock.now()).toBeGreaterThanOrEqual(90000)
    expect(clock.now()).toBeLessThan(90000 + 2000)
  })

  it('sem o instanceId de antes, vale a primeira resposta pronta depois de o servidor ter ficado fora', async () => {
    const clock = fakeClock()
    const answers = [{ status: 'ok', instanceId: 'x' }, null, { status: 'ok', instanceId: 'y' }]
    const result = await waitForServerRestart({ previousInstanceId: null, readHealth: async () => answers.shift(), ...clock })
    expect(result.health.instanceId).toBe('y')
  })

  it('[UC-MANUT-001] uma consulta que não responde não segura a espera: passa do prazo e a seguinte vale', async () => {
    const clock = fakeClock()
    const answers = [new Promise(() => {}), Promise.resolve({ status: 'ok', instanceId: 'novo' })]
    const readHealth = vi.fn(() => answers.shift())
    const result = await waitForServerRestart({ previousInstanceId: 'antigo', readHealth, requestTimeoutMs: 20, ...clock })
    expect(result).toEqual({ ok: true, health: { status: 'ok', instanceId: 'novo' } })
    expect(readHealth).toHaveBeenCalledTimes(2)
  })

  it('para quando a tela fecha', async () => {
    const clock = fakeClock()
    const readHealth = vi.fn(async () => null)
    const result = await waitForServerRestart({ previousInstanceId: 'a', readHealth, isCancelled: () => true, ...clock })
    expect(result).toEqual({ ok: false, cancelled: true })
    expect(readHealth).not.toHaveBeenCalled()
  })

  it('readServerHealth: usa o corpo do 503 (iniciando, com problemas) e devolve null sem resposta', async () => {
    mocks.get.mockResolvedValueOnce({ status: 'ok', instanceId: 'a' })
    expect(await readServerHealth()).toEqual({ status: 'ok', instanceId: 'a' })
    expect(mocks.get).toHaveBeenCalledWith('/api/health', { auth: false, timeoutMs: REQUEST_TIMEOUT_MS })
    mocks.get.mockRejectedValueOnce(Object.assign(new Error('Erro 503'), { status: 503, data: { status: 'starting', instanceId: 'b' } }))
    expect(await readServerHealth()).toEqual({ status: 'starting', instanceId: 'b' })
    mocks.get.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect(await readServerHealth()).toBeNull()
  })

  it('readServerHealth: resposta presa vira null no prazo de cada consulta', async () => {
    vi.useFakeTimers()
    try {
      mocks.get.mockReturnValueOnce(new Promise(() => {}))
      const pending = readServerHealth()
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS)
      expect(await pending).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
