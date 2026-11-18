import { describe, expect, it } from 'vitest'
import { controlResultMessage } from './applicationControl'

describe('controlResultMessage · encerramento repetido', () => {
  it('[UC-APLICACAO-001] avisa que vale a decisão do primeiro encerramento quando o servidor não muda nada', () => {
    const result = controlResultMessage('finish', {
      unchanged: true,
      application: { status: 'finished', finishResolution: { policy: 'submit' } },
    })
    expect(result.tone).toBe('info')
    expect(result.text).toBe('Esta aplicação já tinha sido encerrada, com as respostas em andamento salvas como entrega. Nada foi alterado: vale a decisão do primeiro encerramento.')
    expect(controlResultMessage('finish', { unchanged: true, application: { status: 'cancelled' } }).text).toMatch(/já estava cancelada/)
  })

  it('nunca mostra o nome interno da ação', () => {
    expect(controlResultMessage('finish', { finish: { policy: 'discard', discarded: 2 } }).text).toBe('Aplicação encerrada. As tentativas em andamento foram desconsideradas.')
    // Tentativa reaberta pelo "+N min" da turma: ao desconsiderar, vale a entrega do fim do tempo (G1-mais5).
    expect(controlResultMessage('finish', { finish: { policy: 'discard', discarded: 1, restoredDeliveries: 1 } }).text).toBe('Aplicação encerrada. As tentativas em andamento foram desconsideradas; 1 tentativa reaberta com o tempo extra ficou com a entrega do fim do tempo.')
    expect(controlResultMessage('finish', { finish: { policy: 'discard', discarded: 0, restoredDeliveries: 2 } }).text).toBe('Aplicação encerrada. 2 tentativas reabertas com o tempo extra ficaram com a entrega do fim do tempo.')
    expect(controlResultMessage('finish', { finish: { policy: 'submit', submitted: 1 } }).text).toMatch(/salvas como entrega/)
    expect(controlResultMessage('finish', { finish: { policy: 'none' } }).text).toBe('Aplicação encerrada.')
    expect(controlResultMessage('stop', {}).text).toBe('Aplicação encerrada.')
    expect(controlResultMessage('qualquer', {}).text).toBe('Estado atualizado.')
    expect(controlResultMessage('qualquer', {}).text).not.toMatch(/qualquer/)
  })
})
