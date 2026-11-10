import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { examLeftLabel, focusLogLabel, LOG_INFO } from './monitorLogs'
import { seenWithOriginal } from './reviewLetters'

const apiMock = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../../lib/api', () => ({ api: apiMock }))

import { StudentAnswersModal } from './StudentAnswersModal'

afterEach(() => {
  cleanup()
  apiMock.get.mockReset()
})

// Tentativa nova: a revisão traz a letra vista (posição) e a original (gabarito).
function positionReview() {
  return {
    status: 'finished',
    alternativeLabels: 'position',
    assignedVersion: 'A',
    answeredCount: 1,
    totalCount: 1,
    correctCount: 1,
    hasSnapshot: true,
    questions: [{
      position: 1,
      questionNumber: 1,
      text: 'Qual alternativa?',
      studentChoice: 'C',
      studentChoiceSeen: 'A',
      correctAnswer: 'C',
      correctAnswerSeen: 'A',
      isCorrect: true,
      answered: true,
      alternatives: [
        { letter: 'A', canonicalLetter: 'C', text: 'Certa', selectedByStudent: true, correct: true },
        { letter: 'B', canonicalLetter: 'A', text: 'Errada um', selectedByStudent: false, correct: false },
        { letter: 'C', canonicalLetter: 'B', text: 'Errada dois', selectedByStudent: false, correct: false },
        { letter: 'D', canonicalLetter: 'D', text: 'Errada três', selectedByStudent: false, correct: false },
      ],
    }],
  }
}

describe('[UC-PROVA-003] revisão das respostas no Monitor', () => {
  it('mostra a letra que o aluno viu e a original ao lado quando é outra (AVA-05)', async () => {
    apiMock.get.mockResolvedValue(positionReview())
    render(<StudentAnswersModal open onClose={() => {}} student={{ email: 'ana@escola.local', name: 'Ana' }} className="1DES" courseId="curso" examKey="Avaliacao" applicationId="app-1" />)
    expect(await screen.findByText(/Letras como apareceram para o aluno/)).toBeVisible()
    const chosen = screen.getByText('Certa').parentElement
    expect(within(chosen).getByText('A')).toBeVisible()
    expect(within(chosen).getByText('(original C)')).toBeVisible()
    expect(within(chosen).getByText('Resposta do aluno')).toBeVisible()
    const same = screen.getByText('Errada três').parentElement
    expect(within(same).queryByText(/original/)).not.toBeInTheDocument()
  })

  it('prova online antiga: sem a nota de letras e sem letra original repetida', async () => {
    const review = positionReview()
    review.alternativeLabels = 'original'
    review.questions[0].alternatives = review.questions[0].alternatives.map((alternative) => ({ ...alternative, letter: alternative.canonicalLetter }))
    apiMock.get.mockResolvedValue(review)
    render(<StudentAnswersModal open onClose={() => {}} student={{ email: 'ana@escola.local', name: 'Ana' }} className="1DES" examKey="Avaliacao" />)
    expect(await screen.findByText('Certa')).toBeVisible()
    expect(screen.queryByText(/Letras como apareceram/)).not.toBeInTheDocument()
    expect(screen.queryByText(/\(original/)).not.toBeInTheDocument()
  })

  it('tabela sem alternativas mostra a letra vista com a original entre parênteses', () => {
    expect(seenWithOriginal('A', 'C')).toBe('A (original C)')
    expect(seenWithOriginal('B', 'B')).toBe('B')
    expect(seenWithOriginal(null, 'C')).toBe('C')
    expect(seenWithOriginal(null, null)).toBe('—')
  })
})

describe('[UC-PROVA-003] registros de foco e saída no Monitor', () => {
  it('diz como o aluno saiu da prova e marca o aparelho sem tela cheia sem "pausou a prova" (AVA-12, UXA-02)', () => {
    expect(examLeftLabel('Saiu da prova pelo botão voltar do navegador')).toBe('Saiu pelo voltar do navegador')
    expect(examLeftLabel('Saiu da prova por um link do portal')).toBe('Saiu por um link do portal')
    expect(examLeftLabel('Aluno saiu usando o botão da prova')).toBe('Saiu pelo botão Sair')
    expect(examLeftLabel('Página da prova foi fechada ou recarregada')).toBe('Fechou ou recarregou a prova')
    expect(focusLogLabel({ eventType: 'fullscreen_unsupported' })).toBe('Dispositivo sem tela cheia')
    expect(focusLogLabel({ eventType: 'fullscreen_exit' })).toBe('Saiu da tela cheia')
    expect(focusLogLabel({ eventType: 'focus_unlocked' })).toBe('Liberado pelo professor')
    expect(LOG_INFO.fullscreen_unsupported.pauses).toBe(false)
    expect(LOG_INFO.exam_left.pauses).toBeUndefined()
  })
})
