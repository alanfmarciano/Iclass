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
})
