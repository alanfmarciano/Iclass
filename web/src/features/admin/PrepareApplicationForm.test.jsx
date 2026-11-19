import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// "Para quem" da aplicação (fase 3, P3-S7: AVA-09; D15, D16 e D17 do desenho do P3).
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }))

import {
  ApplicationAudienceFields,
  ApplicationAudienceModal,
  RECUPERACAO_VISIVEL,
  audiencePayload,
  audienceProblem,
  initialAudience,
} from './PrepareApplicationForm'

const CANDIDATES = {
  success: true,
  students: [
    { email: 'alice@x.local', name: 'Alice Souza', fezRegular: true },
    { email: 'bruno@x.local', name: 'Bruno Lima', fezRegular: false },
    { email: 'carla@x.local', name: 'Carla Dias', fezRegular: false },
  ],
  segundaChamada: ['bruno@x.local', 'carla@x.local'],
}

function Harness({ candidates = CANDIDATES, timerMode = 'per_attempt', onValue }) {
  const [value, setValue] = useState(initialAudience())
  return (
    <>
      <ApplicationAudienceFields value={value} onChange={(next) => { setValue(next); onValue?.(next) }} candidates={candidates} timerMode={timerMode} />
      <output data-testid="payload">{JSON.stringify(audiencePayload(value, { timerMode }))}</output>
    </>
  )
}

const payload = () => JSON.parse(screen.getByTestId('payload').textContent)

beforeEach(() => { mocks.get.mockReset(); mocks.post.mockReset() })
afterEach(() => cleanup())

describe('[UC-PROVA-006] Para quem da aplicação', () => {
  it('Recuperação fica escondida até a J2 (D17): só turma inteira, segunda chamada e escolher alunos', () => {
    expect(RECUPERACAO_VISIVEL).toBe(false)
    render(<Harness />)
    const group = screen.getByRole('radiogroup', { name: 'Para quem' })
    expect(within(group).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['Turma inteira', 'Segunda chamada', 'Escolher alunos'])
    expect(screen.queryByText('Recuperação')).not.toBeInTheDocument()
    // Sem mudança: turma inteira, como antes.
    expect(payload()).toEqual({ finalidade: 'regular', participants: null })
  })

  it('segunda chamada vem marcada com quem não fez; desmarcar e marcar muda a lista do pedido', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('radio', { name: 'Segunda chamada' }))
    expect(screen.getByRole('checkbox', { name: 'Bruno Lima' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Carla Dias' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Alice Souza' })).not.toBeChecked()
    expect(screen.getByText('Já fez')).toBeVisible()
    expect(payload()).toEqual({ finalidade: 'segunda_chamada', participants: ['bruno@x.local', 'carla@x.local'] })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Carla Dias' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Alice Souza' }))
    expect(payload().participants).toEqual(['bruno@x.local', 'alice@x.local'])
    // Busca sem acento.
    fireEvent.change(screen.getByLabelText('Buscar aluno'), { target: { value: 'carla' } })
    expect(screen.queryByRole('checkbox', { name: 'Bruno Lima' })).not.toBeInTheDocument()
  })

  it('segunda chamada escolhida antes de a lista chegar marca quem não fez assim que ela chega', () => {
    const { rerender } = render(<Harness candidates={null} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Segunda chamada' }))
    rerender(<Harness candidates={CANDIDATES} />)
    // O Harness guarda o estado: o efeito marca a lista quando os candidatos chegam.
    expect(screen.getByRole('checkbox', { name: 'Bruno Lima' })).toBeChecked()
  })

  it('escolher alunos sem ninguém marcado não deixa preparar', () => {
    let last = null
    render(<Harness onValue={(value) => { last = value }} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Escolher alunos' }))
    expect(audienceProblem(last)).toBe('Escolha pelo menos um aluno para esta aplicação.')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bruno Lima' }))
    expect(audienceProblem(last)).toBeNull()
  })

  it('exceção por aluno: tentativa extra e prazo para começar (só com o cronômetro por aluno)', () => {
    render(<Harness />)
    fireEvent.change(screen.getByLabelText('Aluno'), { target: { value: 'bruno@x.local' } })
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar' }))
    const row = screen.getByTestId('exception-bruno@x.local')
    fireEvent.change(within(row).getByLabelText('Tentativas extras'), { target: { value: '2' } })
    fireEvent.change(within(row).getByLabelText('Pode começar até'), { target: { value: '2026-11-20T08:00' } })
    fireEvent.change(within(row).getByLabelText('Motivo (opcional)'), { target: { value: 'Atestado' } })
    expect(payload().studentOverrides).toEqual({ 'bruno@x.local': { extraAttempts: 2, prazoAteLocal: '2026-11-20T08:00', motivo: 'Atestado' } })
    fireEvent.click(within(row).getByRole('button', { name: /Retirar a exceção/ }))
    expect(payload().studentOverrides).toEqual({ 'bruno@x.local': null })
  })

  it('com o cronômetro junto da turma não há prazo por aluno', () => {
    render(<Harness timerMode="collective" />)
    fireEvent.change(screen.getByLabelText('Aluno'), { target: { value: 'carla@x.local' } })
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar' }))
    expect(screen.queryByLabelText('Pode começar até')).not.toBeInTheDocument()
    expect(payload().studentOverrides).toEqual({ 'carla@x.local': { extraAttempts: 1, prazoAte: null, motivo: '' } })
  })

  it('Alunos desta aplicação: com a prova em andamento só acrescenta; salva pela rota de participantes', async () => {
    mocks.get.mockResolvedValue({
      ...CANDIDATES,
      students: CANDIDATES.students.map((student) => student.email === 'bruno@x.local' ? { ...student, override: { extraAttempts: 1, prazoAte: null, motivo: '' } } : student),
      application: { id: 'app_2', status: 'running', timerMode: 'per_attempt', finalidade: 'segunda_chamada', participants: ['bruno@x.local'] },
    })
    mocks.post.mockResolvedValue({ success: true, application: { id: 'app_2' } })
    const toast = { success: vi.fn(), error: vi.fn() }
    const onSaved = vi.fn()
    const onClose = vi.fn()
    render(<ApplicationAudienceModal open application={{ id: 'app_2', status: 'running' }} onClose={onClose} onSaved={onSaved} toast={toast} />)
    const bruno = await screen.findByRole('checkbox', { name: 'Bruno Lima' })
    expect(mocks.get).toHaveBeenCalledWith('/api/admin/exam-applications/participant-candidates?applicationId=app_2')
    expect(bruno).toBeChecked()
    expect(bruno).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'Turma inteira' })).toBeDisabled()
    expect(screen.getByTestId('exception-bruno@x.local')).toBeVisible()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Carla Dias' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Salvar' })) })
    await waitFor(() => expect(mocks.post).toHaveBeenCalled())
    const [url, body] = mocks.post.mock.calls[0]
    expect(url).toBe('/api/admin/exam-applications/app_2/participants')
    expect(body.finalidade).toBe('segunda_chamada')
    expect(body.participants).toEqual(['bruno@x.local', 'carla@x.local'])
    expect(body.studentOverrides).toEqual({ 'bruno@x.local': { extraAttempts: 1, prazoAte: null, motivo: '' } })
    expect(onSaved).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})
