import { describe, expect, it } from 'vitest'
import { liveCorrectionDraft, runningApplicationOf } from './examTools'

describe('runningApplicationOf', () => {
  it('[UC-APLICACAO-001] acha a aplicação em andamento (sala de espera, rodando ou pausada) e ignora as demais', () => {
    expect(runningApplicationOf([{ id: 'a', status: 'finished' }, { id: 'b', status: 'prepared' }])).toBeNull()
    expect(runningApplicationOf([{ id: 'a', status: 'finished' }, { id: 'b', status: 'paused' }])?.id).toBe('b')
    expect(runningApplicationOf([{ id: 'c', status: 'waiting' }])?.id).toBe('c')
    expect(runningApplicationOf(null)).toBeNull()
  })
})

describe('liveCorrectionDraft', () => {
  it('[UC-APLICACAO-001] lista as alternativas na ordem original (A, B, C, D) mesmo vindas de uma versão embaralhada', () => {
    const draft = liveCorrectionDraft({
      text: 'Enunciado',
      correctAnswer: 'B',
      alternatives: [
        { letter: 'C', displayLetter: 'A', text: 'Terceira' },
        { letter: 'A', displayLetter: 'B', text: 'Primeira' },
        { letter: 'D', displayLetter: 'C', text: 'Quarta' },
        { letter: 'B', displayLetter: 'D', text: 'Segunda', isCorrect: true },
      ],
    })
    expect(draft.alternatives).toEqual([
      { letter: 'A', text: 'Primeira' },
      { letter: 'B', text: 'Segunda' },
      { letter: 'C', text: 'Terceira' },
      { letter: 'D', text: 'Quarta' },
    ])
    expect(draft.correctAnswer).toBe('B')
    expect(draft.text).toBe('Enunciado')
  })

  it('[UC-APLICACAO-001] sem correctAnswer usa a alternativa marcada como correta', () => {
    const draft = liveCorrectionDraft({ questionText: 'Q', alternatives: [{ letter: 'B', text: 'x', isCorrect: true }, { letter: 'A', text: 'y' }] })
    expect(draft.correctAnswer).toBe('B')
    expect(draft.alternatives.map((alternative) => alternative.letter)).toEqual(['A', 'B'])
  })
})
