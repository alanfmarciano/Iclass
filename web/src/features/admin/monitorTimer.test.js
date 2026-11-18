import { describe, expect, it } from 'vitest'
import { classTimeExtraFeedback, resolveMonitorTimer, rowStartedAttempt, rowTimerLabel } from './monitorTimer'

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

  it('[UC-TENTATIVA-001] cronometro por aluno: quem nao comecou fica fora do menor tempo e da contagem', () => {
    const timer = resolveMonitorTimer({
      config: { timerMode: 'per_attempt', timerEnabled: true, durationMinutes: 2 },
      rows: [
        { status: 'online', attemptStarted: true, timerRemaining: 20 },
        // Linhas antigas com o tempo contado desde a abertura da aplicação.
        { status: 'online', attemptStarted: false, timerRemaining: 0 },
        { status: 'online', attemptStarted: false, timerRemaining: null },
        { status: 'finished', attemptStarted: true, timerRemaining: 5 },
      ],
      now: 10000,
      rowsSyncedAt: 10000,
    })
    expect(timer.activeCount).toBe(1)
    expect(timer.remaining).toBe(20)
    const nobody = resolveMonitorTimer({
      config: { timerMode: 'per_attempt', timerEnabled: true, durationMinutes: 2 },
      rows: [{ status: 'online', attemptStarted: false, timerRemaining: 95 }],
    })
    expect(nobody.started).toBe(false)
    expect(nobody.remaining).toBe(120)
  })

  it('[UC-TENTATIVA-001] "Iniciaram" conta so quem comecou nesta aplicacao e a coluna Tempo diz "Nao iniciou"', () => {
    expect(rowStartedAttempt({ status: 'online', attemptStarted: false })).toBe(false)
    expect(rowStartedAttempt({ status: 'online', attemptStarted: true })).toBe(true)
    expect(rowStartedAttempt({ status: 'finished' })).toBe(true)
    expect(rowStartedAttempt({ status: 'time_over' })).toBe(true)
    expect(rowStartedAttempt({ status: 'absent' })).toBe(false)
    const fmt = (value) => (value == null ? '-' : `${value}s`)
    const perAttempt = { collective: false, enabled: true }
    expect(rowTimerLabel({ status: 'online', attemptStarted: false, timerRemaining: null }, perAttempt, fmt)).toBe('Não iniciou')
    expect(rowTimerLabel({ status: 'online', attemptStarted: true, timerRemaining: 30 }, perAttempt, fmt)).toBe('30s')
    expect(rowTimerLabel({ status: 'finished', timerRemaining: null }, perAttempt, fmt)).toBe('-')
    expect(rowTimerLabel({ status: 'online', attemptStarted: false, timerRemaining: 300 }, { collective: true, enabled: true }, fmt)).toBe('300s')
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
  it('conta quem voltou para a prova e avisa quem já tinha entregue e ficou sem o extra (AVA-03)', () => {
    expect(classTimeExtraFeedback({ success: true, deliveredAtDeadline: 0 })).toEqual({ tone: 'success', message: '+5 min para a turma' })
    expect(classTimeExtraFeedback({ success: true })).toEqual({ tone: 'success', message: '+5 min para a turma' })
    const reopened = classTimeExtraFeedback({ success: true, reopenedAtDeadline: 2 })
    expect(reopened.tone).toBe('success')
    expect(reopened.message).toBe('+5 min para a turma. 2 alunos entregues automaticamente no fim do tempo voltaram para a prova com o tempo extra.')
    const one = classTimeExtraFeedback({ success: true, deliveredAtDeadline: 1 })
    expect(one.tone).toBe('warning')
    expect(one.message).toBe('+5 min para a turma. 1 aluno que já tinha entregue ficou sem o tempo extra: 1 foi entregue automaticamente no fim do tempo e não pôde ser reaberto (nota publicada ou fim do tempo há mais de 2 min).')
    const mixed = classTimeExtraFeedback({ success: true, reopenedAtDeadline: 1, deliveredAtDeadline: 2, deliveredByStudent: 1 }, 10)
    expect(mixed.tone).toBe('warning')
    expect(mixed.message).toBe('+10 min para a turma. 1 aluno entregue automaticamente no fim do tempo voltou para a prova com o tempo extra. 3 alunos que já tinham entregue ficaram sem o tempo extra: 1 enviou a prova por conta própria; 2 foram entregues automaticamente no fim do tempo e não puderam ser reabertos (nota publicada ou fim do tempo há mais de 2 min).')
  })

  it('o tempo extra que não cobre o tempo já passado desde o fim é avisado com esse motivo, não com "nota publicada"', () => {
    // Antes: +1 min 90 s depois do fim dizia "nota publicada ou fim do tempo há mais de 2 min".
    const short = classTimeExtraFeedback({ success: true, deliveredAtDeadline: 1, deliveredAtDeadlineTooShort: 1 }, 1)
    expect(short.tone).toBe('warning')
    expect(short.message).toBe('+1 min para a turma. 1 aluno que já tinha entregue ficou sem o tempo extra: 1 foi entregue automaticamente no fim do tempo e os 1 min não cobrem o tempo que já passou desde o fim.')
    const both = classTimeExtraFeedback({ success: true, deliveredAtDeadline: 3, deliveredAtDeadlineTooShort: 2 }, 1)
    expect(both.message).toBe('+1 min para a turma. 3 alunos que já tinham entregue ficaram sem o tempo extra: 2 foram entregues automaticamente no fim do tempo e os 1 min não cobrem o tempo que já passou desde o fim; 1 foi entregue automaticamente no fim do tempo e não pôde ser reaberto (nota publicada ou fim do tempo há mais de 2 min).')
  })

  it('quem já começou a tentativa seguinte (2+ tentativas) é contado e avisado', () => {
    const next = classTimeExtraFeedback({ success: true, nextAttemptStarted: 1 })
    expect(next.tone).toBe('warning')
    expect(next.message).toBe('+5 min para a turma. 1 aluno entregue automaticamente no fim do tempo já tinha começado a tentativa seguinte: a entrega anterior ficou como estava e o tempo extra vale para a tentativa em andamento.')
  })

  it('no meio da prova (ninguém com o tempo acabado) o aviso é só de sucesso', () => {
    // O servidor só conta quem enviou por conta própria depois que o tempo dele acabou.
    expect(classTimeExtraFeedback({ success: true, reopenedAtDeadline: 0, deliveredAtDeadline: 0, deliveredByStudent: 0 })).toEqual({ tone: 'success', message: '+5 min para a turma' })
  })

  it('quem voltou bloqueado por perda de foco não é dado como "de volta à prova" sem aviso', () => {
    const allLocked = classTimeExtraFeedback({ success: true, reopenedAtDeadline: 1, reopenedLocked: 1 })
    expect(allLocked.tone).toBe('warning')
    expect(allLocked.message).toBe('+5 min para a turma. 1 aluno entregue automaticamente no fim do tempo voltou para a prova com o tempo extra, mas continua bloqueado por perda de foco: desbloqueie no Monitor para ele continuar.')
    const someLocked = classTimeExtraFeedback({ success: true, reopenedAtDeadline: 3, reopenedLocked: 1 })
    expect(someLocked.tone).toBe('warning')
    expect(someLocked.message).toBe('+5 min para a turma. 3 alunos entregues automaticamente no fim do tempo voltaram para a prova com o tempo extra (1 continua bloqueado por perda de foco: desbloqueie no Monitor para continuar).')
  })
})
