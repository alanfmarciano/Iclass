import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FinishApplicationModal } from './FinishApplicationModal'

afterEach(cleanup)

describe('FinishApplicationModal', () => {
  it('exige uma escolha clara quando existem tentativas em andamento', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    const onDiscard = vi.fn()
    render(<FinishApplicationModal
      open
      onClose={() => {}}
      summary={{ inProgressAttempts: 2, answeredQuestions: 7, waitingToStart: 1 }}
      onSubmit={onSubmit}
      onDiscard={onDiscard}
    />)

    expect(screen.getByText('Tentativas em andamento')).toBeVisible()
    expect(screen.getByText('7')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Salvar e entregar respostas' }))
    expect(onSubmit).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: 'Desconsiderar e finalizar' }))
    expect(onDiscard).toHaveBeenCalledOnce()
  })

  it('permite finalizar diretamente quando ninguem iniciou', async () => {
    const user = userEvent.setup()
    const onDiscard = vi.fn()
    render(<FinishApplicationModal
      open
      onClose={() => {}}
      summary={{ inProgressAttempts: 0, answeredQuestions: 0, waitingToStart: 3 }}
      onSubmit={() => {}}
      onDiscard={onDiscard}
    />)

    expect(screen.queryByRole('button', { name: 'Salvar e entregar respostas' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Finalizar aplicação' }))
    expect(onDiscard).toHaveBeenCalledOnce()
  })
})
