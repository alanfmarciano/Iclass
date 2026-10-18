import { describe, expect, it } from 'vitest'
import { runningApplicationOf } from './examTools'

describe('runningApplicationOf', () => {
  it('[UC-APLICACAO-001] acha a aplicação em andamento (sala de espera, rodando ou pausada) e ignora as demais', () => {
    expect(runningApplicationOf([{ id: 'a', status: 'finished' }, { id: 'b', status: 'prepared' }])).toBeNull()
    expect(runningApplicationOf([{ id: 'a', status: 'finished' }, { id: 'b', status: 'paused' }])?.id).toBe('b')
    expect(runningApplicationOf([{ id: 'c', status: 'waiting' }])?.id).toBe('c')
    expect(runningApplicationOf(null)).toBeNull()
  })
})
