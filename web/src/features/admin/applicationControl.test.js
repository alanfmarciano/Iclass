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
    expect(controlResultMessage('finish', { finish: { policy: 'submit', submitted: 1 } }).text).toMatch(/salvas como entrega/)
    expect(controlResultMessage('finish', { finish: { policy: 'none' } }).text).toBe('Aplicação encerrada.')
    expect(controlResultMessage('stop', {}).text).toBe('Aplicação encerrada.')
    expect(controlResultMessage('qualquer', {}).text).toBe('Estado atualizado.')
    expect(controlResultMessage('qualquer', {}).text).not.toMatch(/qualquer/)
  })
})
