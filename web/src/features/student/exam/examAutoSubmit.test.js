import { describe, expect, it } from 'vitest'
import { autoSubmitExtendedMessage, autoSubmitRetryDelay, classifyAutoSubmitError, countAnswered } from './examAutoSubmit'

describe('[UC-TENTATIVA-001] envio automático do fim do tempo (CONF-01, UXA-01)', () => {
  it('insiste quando não há rede ou o servidor falha, com espera crescente e limitada', () => {
    expect(classifyAutoSubmitError(new TypeError('Failed to fetch'))).toBe('retry')
    expect(classifyAutoSubmitError({ status: 503 })).toBe('retry')
    expect(classifyAutoSubmitError({ status: 429 })).toBe('retry')
    expect([0, 1, 2, 3, 4, 9].map(autoSubmitRetryDelay)).toEqual([1000, 2000, 4000, 8000, 15000, 15000])
  })

  it('reconhece as respostas definitivas do servidor', () => {
    expect(classifyAutoSubmitError({ status: 408, data: { deadlineExceeded: true } })).toBe('finalized')
    expect(classifyAutoSubmitError({ status: 423 })).toBe('locked')
    expect(classifyAutoSubmitError({ status: 403, data: { applicationPaused: true } })).toBe('paused')
    expect(classifyAutoSubmitError({ status: 409 })).toBe('fatal')
    expect(countAnswered({ 1: 'A', 2: '', 3: null, 4: 'C' })).toBe(2)
  })

  it('tempo devolvido pela queda do servidor: o aviso diz que foi o servidor, não o professor (CONF-03)', () => {
    const outage = { status: 409, data: { deadlineExtended: true, timerRemaining: 40, reason: 'server_outage' } }
    const teacher = { status: 409, data: { deadlineExtended: true, timerRemaining: 300 } }
    expect(classifyAutoSubmitError(outage)).toBe('extended')
    expect(autoSubmitExtendedMessage(outage)).toBe('O servidor ficou fora do ar e o tempo foi devolvido. A prova continua.')
    expect(autoSubmitExtendedMessage(teacher)).toBe('O professor deu mais tempo. A prova continua.')
    expect(autoSubmitExtendedMessage(null)).toBe('O professor deu mais tempo. A prova continua.')
  })
})
