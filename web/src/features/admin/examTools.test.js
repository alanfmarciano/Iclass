import { describe, expect, it } from 'vitest'
import { editorQuestionPayload, liveCorrectionDraft, preservedModelFields, runningApplicationOf } from './examTools'

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

describe('editorQuestionPayload', () => {
  it('[UC-PROVA-004] salvar pela tela Provas mantém o tipo, os pontos e o gabarito dos tipos novos que o editor ainda não mostra', () => {
    const numeric = { type: 'numeric', points: 2, text: 'Latência?', alternatives: [], correctAnswer: '', numeric: { value: 3.5, tolerance: 0.25, unit: 'ms' }, review: 'auto', explanation: 'Média.' }
    const model = preservedModelFields(numeric)
    expect(model).toEqual({ type: 'numeric', points: 2, numeric: { value: 3.5, tolerance: 0.25, unit: 'ms' }, review: 'auto', explanation: 'Média.' })
    const editorQuestion = { model, text: 'Latência média?', alternatives: [{ letter: 'A', text: '', isCorrect: true }] }
    expect(editorQuestionPayload(editorQuestion)).toEqual({
      type: 'numeric', points: 2, numeric: { value: 3.5, tolerance: 0.25, unit: 'ms' }, review: 'auto', explanation: 'Média.',
      text: 'Latência média?', alternatives: [{ letter: 'A', text: '', isCorrect: true }], correctAnswer: 'A',
    })
    // Várias corretas: valem as marcas do editor, não a lista correctAnswers de antes.
    const multiple = preservedModelFields({ type: 'multiple_answer', points: 3, correctAnswers: ['A', 'C'], partialCredit: false })
    expect(multiple).toEqual({ type: 'multiple_answer', points: 3, partialCredit: false })
    // Questão antiga (sem tipo) continua indo só com enunciado, alternativas e letra.
    expect(editorQuestionPayload({ model: preservedModelFields({ text: 'x' }), text: 'x', alternatives: [{ letter: 'A', text: 'a', isCorrect: false }, { letter: 'B', text: 'b', isCorrect: true }] }))
      .toEqual({ text: 'x', alternatives: [{ letter: 'A', text: 'a', isCorrect: false }, { letter: 'B', text: 'b', isCorrect: true }], correctAnswer: 'B' })
  })
})
