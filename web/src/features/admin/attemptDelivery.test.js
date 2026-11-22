import { describe, expect, it } from 'vitest'
import { deliveryLabel, deliveryTone, formatLateness } from './attemptDelivery'

describe('[UC-TENTATIVA-001] como a entrega chegou (AVA-03, UXA-01)', () => {
  it('mostra ao professor a entrega automática do servidor e o atraso do navegador', () => {
    expect(deliveryLabel({ submissionSource: 'deadline_server_auto_submit' })).toMatch(/Tempo esgotado: entregue automaticamente/)
    expect(deliveryLabel({ submissionSource: 'timer_auto_submit', lateBySeconds: 42 })).toBe('Enviada após o prazo (42 s)')
    expect(deliveryLabel({ submissionSource: 'timer_auto_submit', lateBySeconds: 184 })).toBe('Enviada após o prazo (3 min 4 s)')
    expect(deliveryLabel({ submissionSource: 'timer_auto_submit' })).toBe('Enviada automaticamente no fim do tempo')
    expect(deliveryLabel({ submissionSource: 'instructor_finish' })).toBe('Salva pelo professor ao encerrar')
    expect(deliveryLabel({ submissionSource: 'student' })).toBe('')
    expect(formatLateness(120)).toBe('2 min')
  })

  it('avisa quando a prova terminou bloqueada por foco ou foi recuperada depois do encerramento', () => {
    const locked = { submissionSource: 'deadline_server_auto_submit', focusLockedAtDeadline: true }
    expect(deliveryLabel(locked)).toMatch(/bloqueada por perda de foco/)
    expect(deliveryTone(locked)).toBe('warning')
    const recovered = { submissionSource: 'deadline_server_auto_submit', recoveredAfterFinish: true }
    expect(deliveryLabel(recovered)).toMatch(/Recuperada depois do encerramento/)
    expect(deliveryTone(recovered)).toBe('warning')
  })

  it('mostra a reabertura pelo "+N min" da turma e a entrega do fim do tempo mantida quando o extra foi desconsiderado (G1-mais5)', () => {
    const manualAfterReopen = { submissionSource: 'student', reopenedAt: '2026-10-18T10:00:00.000Z', reopenedFrom: [{ source: 'timer_auto_submit' }] }
    expect(deliveryLabel(manualAfterReopen)).toBe('Reaberta com o tempo extra da turma')
    const twice = { submissionSource: 'timer_auto_submit', reopenedAt: '2026-10-18T10:00:00.000Z', reopenedFrom: [{}, {}] }
    expect(deliveryLabel(twice)).toBe('Enviada automaticamente no fim do tempo · Reaberta 2 vezes com o tempo extra da turma')
    const restored = { submissionSource: 'deadline_server_auto_submit', restoredAfterDiscard: { at: '2026-10-18T10:06:00.000Z' } }
    expect(deliveryLabel(restored)).toBe('Tempo esgotado: entregue automaticamente com as respostas salvas · Reaberta com o tempo extra da turma e desconsiderada no encerramento: vale a entrega do fim do tempo')
    expect(deliveryTone(restored)).toBe('warning')
  })
})

describe('[UC-APLICACAO-001] tentativa mostrada no Monitor', () => {
  it('diz "Tentativa N de M" só quando a aplicação permite mais de uma', async () => {
    const { attemptCountLabel } = await import('./attemptDelivery')
    expect(attemptCountLabel({ attemptNumber: 2, maxAttempts: 3 })).toBe('Tentativa 2 de 3')
    expect(attemptCountLabel({ attemptNumber: 1, maxAttempts: 1 })).toBe('')
    expect(attemptCountLabel({ attemptNumber: 3, maxAttempts: null })).toBe('Tentativa 3')
    expect(attemptCountLabel({ attemptNumber: null, maxAttempts: 2 })).toBe('')
  })
})

describe('[UC-TENTATIVA-004] entrega recolhida e reaberta pelo professor no Monitor (AVA-14)', () => {
  it('diz que a prova foi recolhida pelo professor', () => {
    expect(deliveryLabel({ submissionSource: 'instructor_collect' })).toBe('Recolhida pelo professor com as respostas salvas')
    expect(deliveryTone({ submissionSource: 'instructor_collect' })).toBe('muted')
  })

  it('diz quem reabriu: o professor (linha do Monitor ou última reabertura da entrega) ou o tempo extra da turma', () => {
    expect(deliveryLabel({ submissionSource: 'student', reopenedAt: '2026-11-20T10:00:00Z', reopenedFrom: [{ byInstructor: true }] })).toBe('Reaberta pelo professor')
    expect(deliveryLabel({ submissionSource: 'student', reopenedAt: '2026-11-20T10:00:00Z', reopenedByInstructor: true })).toBe('Reaberta pelo professor')
    expect(deliveryLabel({ submissionSource: 'student', reopenedAt: '2026-11-20T10:00:00Z', reopenedFrom: [{}, { byInstructor: true }] })).toBe('Reaberta 2 vezes (a última pelo professor)')
    expect(deliveryLabel({ submissionSource: 'timer_auto_submit', reopenedAt: '2026-11-20T10:00:00Z', reopenedFrom: [{ byInstructor: true }, {}] })).toBe('Enviada automaticamente no fim do tempo · Reaberta 2 vezes com o tempo extra da turma')
    expect(deliveryLabel({ submissionSource: 'student', restoredAfterDiscard: { byInstructor: true } })).toBe('Reaberta pelo professor e desconsiderada no encerramento: vale a entrega anterior')
  })
})
