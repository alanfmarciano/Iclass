import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MonthCalendar } from './MonthCalendar'

const mocks = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../../lib/api', () => ({ api: { get: mocks.get } }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const pad = (n) => String(n).padStart(2, '0')

describe('Calendário de presença da ficha do aluno', () => {
  it('[UC-PRESENCA-005] o acesso num dia não letivo não aparece como presença', async () => {
    const now = new Date()
    const month = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`
    mocks.get.mockResolvedValue({ month, days: { [`${month}-02`]: 'chamada', [`${month}-03`]: 'nao_letivo' } })
    render(<MonthCalendar email="ana@x.local" />)
    expect(await screen.findByText('Dia não letivo (não conta)')).toBeInTheDocument()
    expect(mocks.get).toHaveBeenCalledWith(expect.stringContaining(`month=${month}`))
    const presente = screen.getByText('2', { selector: 'div' })
    const naoLetivo = screen.getByText('3', { selector: 'div' })
    expect(presente.className).toContain('bg-success-soft')
    expect(naoLetivo.className).not.toContain('bg-success-soft')
    expect(naoLetivo).toHaveAttribute('title', 'Acesso em dia não letivo: não conta na frequência')
  })

  it('[UC-PRESENCA-005] mês sem dia não letivo não mostra a legenda dele', async () => {
    const now = new Date()
    const month = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`
    mocks.get.mockResolvedValue({ month, days: { [`${month}-02`]: 'login' } })
    render(<MonthCalendar email="ana@x.local" />)
    expect(await screen.findByText('2', { selector: 'div.bg-success-soft' })).toBeInTheDocument()
    expect(screen.queryByText('Dia não letivo (não conta)')).not.toBeInTheDocument()
  })
})
