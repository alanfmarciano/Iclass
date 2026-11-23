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

describe('[UC-PROVA-007] revisão de quem ainda não sorteou', () => {
  it('no sorteio por aluno, quem não abriu a prova não tem questões: a tela diz que elas são sorteadas ao começar', async () => {
    apiMock.get.mockResolvedValue({ status: 'not_started', alternativeLabels: 'position', assignedVersion: 'A', answeredCount: 0, totalCount: 3, correctCount: 0, hasSnapshot: true, drawPending: true, questions: [] })
    render(<StudentAnswersModal open onClose={() => {}} student={{ email: 'ana@escola.local', name: 'Ana' }} className="1DES" courseId="curso" examKey="Avaliacao" applicationId="app-1" />)
    expect(await screen.findByText('As questões deste aluno são sorteadas quando ele começar a prova.')).toBeVisible()
    expect(screen.getByText('Progresso 0/3')).toBeInTheDocument()
    expect(screen.queryByText('Este aluno ainda não respondeu nenhuma questão.')).not.toBeInTheDocument()
  })
})

describe('[UC-IDENT-003] revisão das respostas de aluno sem e-mail', () => {
  it('o subtítulo mostra "sem e-mail", nunca o endereço interno', async () => {
    apiMock.get.mockResolvedValue(positionReview())
    render(<StudentAnswersModal open onClose={() => {}} student={{ email: 'aluno-alu_00000000000000f2@sem-email.invalid', name: 'Bruno' }} className="1DES" courseId="curso" examKey="Avaliacao" applicationId="app-1" />)
    expect(await screen.findByText(/Letras como apareceram para o aluno/)).toBeVisible()
    expect(screen.getByText(/^sem e-mail · Versão A$/)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/sem-email\.invalid/)
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

// A18 (P3-S4b: AVA-07): os tipos novos na revisão do Monitor, com os campos de
// reviewAnswerFields (type, answerText, answerKeyText, studentResponse, pontos, pending).
describe('[UC-CORRECAO-001] revisão do Monitor com os tipos novos', () => {
  it('dissertativa aguarda o professor (não conta como errada), numérica e várias corretas por tipo', async () => {
    apiMock.get.mockResolvedValue({
      status: 'finished', alternativeLabels: 'original', assignedVersion: 'A', answeredCount: 3, totalCount: 3, correctCount: 0, hasSnapshot: true,
      questions: [
        { position: 1, questionNumber: 1, type: 'essay', text: 'Explique o **TCP**.', answered: true, isCorrect: false, pending: true, studentResponse: 'Protocolo com conexão.', pointsEarned: 0, pointsPossible: 2, alternatives: [] },
        { position: 2, questionNumber: 2, type: 'numeric', text: 'Latência?', answered: true, isCorrect: false, pending: false, studentResponse: '4', answerText: '4 ms', answerKeyText: '3,5 (± 0,25) ms', pointsEarned: 0, pointsPossible: 1, alternatives: [] },
        {
          position: 3, questionNumber: 3, type: 'multiple_answer', text: 'Protocolos?', answered: true, isCorrect: false, pending: false, studentChoices: ['A'], correctAnswersSeen: ['A', 'C'], pointsEarned: 1, pointsPossible: 2,
          alternatives: [
            { letter: 'A', canonicalLetter: 'A', text: 'TCP', selectedByStudent: true, correct: true },
            { letter: 'B', canonicalLetter: 'B', text: 'HTML', selectedByStudent: false, correct: false },
            { letter: 'C', canonicalLetter: 'C', text: 'UDP', selectedByStudent: false, correct: true },
          ],
        },
      ],
    })
    render(<StudentAnswersModal open onClose={() => {}} student={{ email: 'ana@escola.local', name: 'Ana' }} className="1DES" examKey="Avaliacao" />)
    expect(await screen.findByText('Protocolo com conexão.')).toBeVisible()
    // Antes: "3 erradas" (a dissertativa contava como errada) e a resposta escrita sumia.
    expect(screen.getByText('2 erradas')).toBeVisible()
    expect(screen.getByText('1 aguarda correção')).toBeVisible()
    expect(screen.getByText('Aguardando correção')).toBeVisible()
    expect(screen.getByText('TCP', { selector: 'strong' })).toBeVisible()
    expect(screen.getByText('4 ms')).toBeVisible()
    expect(screen.getByText('3,5 (± 0,25) ms')).toBeVisible()
    expect(screen.getByText('Parcial · 1 de 2 pontos')).toBeVisible()
    expect(within(screen.getByText('UDP').parentElement).getByText('Gabarito')).toBeVisible()
  })
})
