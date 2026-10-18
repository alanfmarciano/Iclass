import { describe, expect, it } from 'vitest'
import { classTimeExtraFeedback, resolveMonitorTimer } from './monitorTimer'

describe('cronometro do monitor', () => {
  it('acompanha o cronometro coletivo a partir do inicio da aplicacao', () => {
    const timer = resolveMonitorTimer({
      config: { timerMode: 'collective', timerEnabled: true, onlineActive: true, startTime: 10000, durationMinutes: 60 },
      now: 70000,
    })
    expect(timer.started).toBe(true)
    expect(timer.remaining).toBe(3540)
  })

  it('mostra o menor tempo individual e continua contando entre atualizacoes', () => {
    const timer = resolveMonitorTimer({
      config: { timerMode: 'per_attempt', timerEnabled: true, durationMinutes: 60 },
      rows: [{ status: 'online', timerRemaining: 3400 }, { status: 'focus_locked', timerRemaining: 3500 }],
      rowsSyncedAt: 10000,
      now: 15000,
    })
    expect(timer.collective).toBe(false)
    expect(timer.started).toBe(true)
    expect(timer.activeCount).toBe(2)
    expect(timer.remaining).toBe(3395)
  })

  it('nao usa uma entrega finalizada como cronometro em andamento', () => {
    const timer = resolveMonitorTimer({
      config: { timerMode: 'per_attempt', timerEnabled: true, durationMinutes: 60 },
      rows: [{ status: 'finished', timerRemaining: 1200 }],
      now: 20000,
      rowsSyncedAt: 10000,
    })
    expect(timer.started).toBe(false)
    expect(timer.remaining).toBe(3600)
  })

  it('[UC-TENTATIVA-001] pausar congela o cronometro coletivo e a retomada nao devolve tempo cheio (AVA-10)', () => {
    const config = { timerMode: 'collective', timerEnabled: true, onlineActive: true, startTime: 1000, durationMinutes: 60 }
    const duringPause = resolveMonitorTimer({ config: { ...config, pauses: [{ pausedAt: 61000, resumedAt: null }] }, now: 301000 })
    expect(duringPause.remaining).toBe(3540)
    const afterResume = resolveMonitorTimer({ config: { ...config, pauses: [{ pausedAt: 61000, resumedAt: 301000 }] }, now: 361000 })
    expect(afterResume.remaining).toBe(3480)
  })
})

describe('[UC-TENTATIVA-001] +5 min para a turma depois do fim do tempo', () => {
  it('avisa o professor de quem já estava sem tempo e foi entregue sem o extra (AVA-03)', () => {
    expect(classTimeExtraFeedback({ success: true, deliveredAtDeadline: 0 })).toEqual({ tone: 'success', message: '+5 min para a turma' })
    expect(classTimeExtraFeedback({ success: true })).toEqual({ tone: 'success', message: '+5 min para a turma' })
    const one = classTimeExtraFeedback({ success: true, deliveredAtDeadline: 1 })
    expect(one.tone).toBe('warning')
    expect(one.message).toBe('+5 min para a turma. 1 aluno já estava sem tempo e foi entregue automaticamente com as respostas salvas, sem o tempo extra.')
    const two = classTimeExtraFeedback({ success: true, deliveredAtDeadline: 2 }, 10)
    expect(two.tone).toBe('warning')
    expect(two.message).toMatch(/^\+10 min para a turma\. 2 alunos já estavam sem tempo e foram entregues automaticamente/)
  })
})
