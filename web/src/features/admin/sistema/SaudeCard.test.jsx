import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SaudeCard, crashText, formatDuration, healthState, lastSaveText, outageText, supervisorText, HEALTH_POLL_MS, HEALTH_STALE_MS } from './SaudeCard'

const mocks = vi.hoisted(() => ({ result: { data: null, error: null }, calls: [] }))

vi.mock('../../../hooks/useApi', () => ({
  useApi: (path, deps, options) => { mocks.calls.push({ path, deps, options }); return { ...mocks.result, loading: false, refetch: vi.fn() } },
}))

const NOW = Date.parse('2026-11-10T13:00:00Z')

function health(extra = {}) {
  return {
    success: true,
    status: 'ok',
    instanceId: 'abc',
    version: '3.0.0',
    startedAt: '2026-11-10T10:55:00Z',
    uptimeSeconds: 2 * 3600 + 5 * 60,
    rssMb: 132.4,
    heapUsedMb: 60.2,
    dbFileMb: 48.7,
    database: 'ok',
    save: { lastOkAt: NOW - 4000, lastDurationMs: 230, consecutiveFailures: 0 },
    supervised: true,
    restarts: 2,
    lastExit: '75',
    degraded: null,
    lastCrash: { at: '2026-11-09T18:00:00Z', kind: 'uncaughtException', summary: 'Error: Falha simulada' },
    lastOutage: { from: NOW - 60000, to: NOW - 30000, durationMs: 30000, reason: 'crash', compensated: true, examKey: 'Avaliacao_X', studentClass: '2DES' },
    sessionsRestored: { students: 3, admins: 1, dropped: 0 },
    ...extra,
  }
}

describe('SaudeCard · Saúde do servidor', () => {
  afterEach(() => { cleanup(); mocks.calls.length = 0; vi.useRealTimers() })

  it('[UC-SAUDE-001] mostra os campos do /api/admin/system/health e atualiza a cada 15 s', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    mocks.result = { data: health(), error: null }
    render(<SaudeCard />)
    expect(mocks.calls[0].path).toBe('/api/admin/system/health')
    expect(mocks.calls[0].options).toEqual({ pollMs: HEALTH_POLL_MS })
    expect(HEALTH_POLL_MS).toBe(15000)
    expect(screen.getByText('Saúde do servidor')).toBeVisible()
    expect(screen.getByText('Funcionando')).toBeVisible()
    expect(screen.getByText(/^2 h 05 min/)).toBeVisible()
    expect(screen.getByText('132,4 MB')).toBeVisible()
    expect(screen.getByText('48,7 MB')).toBeVisible()
    expect(screen.getByText('há 4 s, levou 230 ms')).toBeVisible()
    expect(screen.getByText('Reinício automático: ligado (2 reinícios)')).toBeVisible()
    expect(screen.getByText(/uncaughtException · Error: Falha simulada/)).toBeVisible()
    expect(screen.getByText(/fora do ar por 30 s · queda do servidor · Avaliacao_X · turma 2DES · tempo devolvido aos alunos/)).toBeVisible()
  })

  it('[UC-SAUDE-001] com problemas e sem supervisor: diz que o reinício automático está desligado', () => {
    mocks.result = { data: health({ status: 'degraded', supervised: false, restarts: 0, degraded: { at: '2026-11-10T12:00:00Z', reason: 'x' }, lastCrash: null, lastOutage: null, save: { lastOkAt: null } }), error: null }
    render(<SaudeCard />)
    expect(screen.getByText('Com problemas')).toBeVisible()
    expect(screen.getByText('Reinício automático: desligado nesta forma de abrir o IClass')).toBeVisible()
    expect(screen.getByText(/Reinicie o IClass assim que possível/)).toBeVisible()
    expect(screen.getByText('Nenhuma falha registrada.')).toBeVisible()
    expect(screen.getByText('Nenhuma queda durante prova.')).toBeVisible()
    expect(screen.getByText('Ainda não houve salvamento desde que o servidor ligou.')).toBeVisible()
  })

  it('[UC-SAUDE-001] servidor sem responder: o cartão avisa em vez de ficar vazio', () => {
    mocks.result = { data: null, error: new Error('Sem conexão com o servidor.') }
    render(<SaudeCard />)
    expect(screen.getByText('Com problemas')).toBeVisible()
    expect(screen.getByText(/Não foi possível consultar o servidor agora/)).toBeVisible()
  })

  // Antes o selo vinha só de data.status: o useApi guarda a leitura antiga junto com o
  // erro, e durante o reinício (503 starting) ou com o servidor travado o cartão seguia
  // "Funcionando" com "Ligado há 1 s" parado.
  it('[UC-SAUDE-001] reinício: com a leitura antiga na mão e 503 starting, mostra Iniciando e avisa que os números são de antes', () => {
    const old = health()
    mocks.result = { data: old, error: null }
    const view = render(<SaudeCard />)
    expect(screen.getByText('Funcionando')).toBeVisible()
    const starting = Object.assign(new Error('O IClass está iniciando. Aguarde alguns segundos.'), { status: 503, data: { starting: true } })
    mocks.result = { data: old, error: starting }
    view.rerender(<SaudeCard />)
    expect(screen.getByText('Iniciando')).toBeVisible()
    expect(screen.queryByText('Funcionando')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent(/O servidor está iniciando; o cartão atualiza sozinho.*Os números abaixo são da última resposta/)
    // O useApi limpa o erro no começo da consulta seguinte, ainda com a leitura antiga:
    // o selo não volta a "Funcionando" antes de chegar uma leitura nova.
    mocks.result = { data: old, error: null }
    view.rerender(<SaudeCard />)
    expect(screen.getByText('Iniciando')).toBeVisible()
    // Leitura nova (outro instanceId): volta ao normal e o aviso some.
    mocks.result = { data: health({ instanceId: 'novo', uptimeSeconds: 3 }), error: null }
    view.rerender(<SaudeCard />)
    expect(screen.getByText('Funcionando')).toBeVisible()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText(/^3 s/)).toBeVisible()
  })

  it('[UC-SAUDE-001] servidor fora depois de uma leitura boa: Com problemas e o aviso de sem resposta, não Funcionando', () => {
    const old = health()
    mocks.result = { data: old, error: null }
    const view = render(<SaudeCard />)
    mocks.result = { data: old, error: Object.assign(new Error('Sem conexão com o servidor.'), { status: 0, network: true }) }
    view.rerender(<SaudeCard />)
    expect(screen.getByText('Com problemas')).toBeVisible()
    expect(screen.queryByText('Funcionando')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent(/O servidor não está respondendo\..*veja a janela do IClass/)
  })

  it('[UC-SAUDE-001] pedido preso (servidor travado): sem erro nenhum, a leitura velha vira Com problemas (sem resposta) depois de duas consultas perdidas', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(NOW)
    mocks.result = { data: health(), error: null }
    render(<SaudeCard />)
    expect(screen.getByText('Funcionando')).toBeVisible()
    act(() => { vi.advanceTimersByTime(HEALTH_POLL_MS + 5000) })
    expect(screen.getByText('Funcionando')).toBeVisible()
    act(() => { vi.advanceTimersByTime(HEALTH_STALE_MS - HEALTH_POLL_MS) })
    expect(screen.getByText('Com problemas')).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('O servidor não está respondendo.')
  })

  it('[UC-SAUDE-001] primeira consulta ainda no boot: Iniciando, sem a mensagem de erro', () => {
    mocks.result = { data: null, error: Object.assign(new Error('O IClass está iniciando.'), { status: 503, data: { starting: true } }) }
    render(<SaudeCard />)
    expect(screen.getByText('Iniciando')).toBeVisible()
    expect(screen.getByText(/O servidor está iniciando/)).toBeVisible()
    expect(screen.queryByText(/Não foi possível consultar/)).toBeNull()
  })

  it('healthState: problema vence a leitura, 503 sem starting é sem resposta, status desconhecido vale ok', () => {
    const data = health()
    expect(healthState({ data, problem: null, receivedAt: NOW, now: NOW + HEALTH_STALE_MS })).toBe('ok')
    expect(healthState({ data, problem: null, receivedAt: NOW, now: NOW + HEALTH_STALE_MS + 1 })).toBe('unreachable')
    expect(healthState({ data, problem: Object.assign(new Error('x'), { status: 503, data: { retryable: true } }), receivedAt: NOW, now: NOW })).toBe('unreachable')
    expect(healthState({ data: null, problem: Object.assign(new Error('x'), { status: 503, data: { status: 'starting' } }) })).toBe('starting')
    expect(healthState({ data: health({ status: 'degraded' }), problem: null, receivedAt: NOW, now: NOW })).toBe('degraded')
    expect(healthState({ data: health({ status: 'estranho' }), problem: null, receivedAt: NOW, now: NOW })).toBe('ok')
    expect(healthState({ data: null, problem: null })).toBe(null)
  })

  it('formatos: duração, salvamento com falhas, reinícios no singular, queda sem compensação e falha sem resumo', () => {
    expect(formatDuration(45)).toBe('45 s')
    expect(formatDuration(12 * 60 + 5)).toBe('12 min')
    expect(formatDuration(26 * 3600)).toBe('1 dia e 2 h')
    expect(formatDuration(-3)).toBe('0 s')
    expect(lastSaveText({ lastOkAt: 1000, lastDurationMs: 1500, consecutiveFailures: 2 }, 61000)).toBe('há 1 min, levou 1,5 s · 2 falhas seguidas depois dele')
    expect(supervisorText({ supervised: true, restarts: 1 })).toBe('Reinício automático: ligado (1 reinício)')
    expect(supervisorText(null)).toBe('Reinício automático: desligado nesta forma de abrir o IClass')
    expect(outageText({ to: NOW, durationMs: 90000, reason: 'suspended', compensated: false })).toMatch(/fora do ar por 1 min · computador suspenso ou travado · tempo não devolvido$/)
    expect(crashText({ at: null, kind: 'listen', summary: '' })).toBe('listen')
  })
})
