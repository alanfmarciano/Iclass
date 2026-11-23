import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ScheduledExams } from './ScheduledExams'

describe('ScheduledExams (P3-S12)', () => {
  afterEach(cleanup)

  it('[UC-PROVA-008] aluno vê "Agendada" com a janela, sem botão de começar; lista vazia não mostra nada', () => {
    const { container, rerender } = render(<ScheduledExams items={[{
      id: 'app1', examKey: 'Avaliacao_U1', examTitle: 'Prova da Unidade 1', status: 'scheduled',
      janela: 'abre em 20/11 às 08:00 e fecha às 09:30', abreEmLabel: '20/11 às 08:00',
      timerEnabled: true, durationMinutes: 50, tokenEnabled: true,
    }]} />)
    const card = screen.getByTestId('scheduled-exam-app1')
    expect(card).toHaveTextContent('Prova da Unidade 1')
    expect(card).toHaveTextContent('A prova abre em 20/11 às 08:00 e fecha às 09:30.')
    expect(card).toHaveTextContent('Agendada')
    expect(card).toHaveTextContent('Duração: 50 min.')
    expect(card).toHaveTextContent('token')
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    rerender(<ScheduledExams items={[]} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<ScheduledExams />)
    expect(container).toBeEmptyDOMElement()
  })
})
