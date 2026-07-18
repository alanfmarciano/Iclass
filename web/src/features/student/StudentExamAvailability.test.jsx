import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExamAvailabilityPopup } from './StudentExamAvailability'

const runningApplication = {
  id: 'app-1',
  examKey: 'Avaliacao_FUTEC_1',
  examTitle: 'Fundamentos de Tecnologia',
  studentClass: '1DES',
  courseName: 'Desenvolvimento de Sistemas',
  status: 'running',
}

afterEach(cleanup)

describe('ExamAvailabilityPopup', () => {
  it('permanece visível e abre a prova sem oferecer botão de dispensar', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    render(<ExamAvailabilityPopup application={runningApplication} onOpen={onOpen} />)

    expect(screen.getByRole('status', { name: 'Aviso de prova disponível' })).toBeVisible()
    expect(screen.getByText('PROVA DISPONÍVEL')).toBeVisible()
    expect(screen.getByText('Fundamentos de Tecnologia')).toBeVisible()
    expect(screen.queryByRole('button', { name: /fechar/i })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /abrir prova/i }))
    expect(onOpen).toHaveBeenCalledWith(runningApplication)
  })

  it('mostra a contagem regressiva da sala de espera', () => {
    render(<ExamAvailabilityPopup
      application={{ ...runningApplication, status: 'waiting', startsAt: 70000 }}
      now={10000}
    />)

    expect(screen.getByText('SALA DE ESPERA ABERTA')).toBeVisible()
    expect(screen.getByText(/começa em 01:00/i)).toBeVisible()
    expect(screen.getByRole('button', { name: /entrar na sala/i })).toBeVisible()
  })

  it('troca automaticamente da sala de espera para prova disponível ao chegar a zero', () => {
    const popup = render(<ExamAvailabilityPopup
      application={{ ...runningApplication, status: 'waiting', startsAt: 10000 }}
      now={10001}
    />)

    expect(popup.getByText('PROVA DISPONÍVEL')).toBeVisible()
    expect(popup.queryByText('SALA DE ESPERA ABERTA')).not.toBeInTheDocument()
    expect(popup.getByRole('button', { name: /abrir prova/i })).toBeVisible()
  })
})
