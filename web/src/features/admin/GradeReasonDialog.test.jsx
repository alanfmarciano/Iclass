import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GradeReasonDialog, gradeReasonError, isReasonRequiredError } from './GradeReasonDialog'

afterEach(() => cleanup())

function reasonRequired() {
  const error = new Error('Informe o motivo: esta nota já foi publicada para o aluno.')
  error.status = 400
  error.data = { success: false, code: 'reason_required', field: 'reason', error: error.message }
  return error
}

describe('Diálogo do motivo da nota', () => {
  it('[UC-AUDITORIA-004] nota não publicada: o motivo é opcional e vai em branco', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<GradeReasonDialog open title="Excluir esta entrega?" confirmLabel="Excluir registro" reason="optional" onConfirm={onConfirm} onClose={() => {}} />)
    expect(screen.getByLabelText('Motivo (opcional)')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Excluir registro' }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(''))
  })

  it('[UC-AUDITORIA-004] o servidor pede o motivo (nota publicada nesse meio-tempo): o diálogo passa a exigir e mostra a mensagem', async () => {
    const onConfirm = vi.fn().mockRejectedValueOnce(reasonRequired()).mockResolvedValueOnce(undefined)
    const user = userEvent.setup()
    render(<GradeReasonDialog open title="Usar esta tentativa para a nota?" confirmLabel="Usar esta nota" reason="optional" onConfirm={onConfirm} onClose={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Usar esta nota' }))
    expect(await screen.findByText('Informe o motivo: esta nota já foi publicada para o aluno.')).toBeInTheDocument()
    expect(screen.getByLabelText('Motivo (obrigatório: a nota já foi publicada)')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Usar esta nota' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    await user.type(screen.getByLabelText(/^Motivo/), 'Pedido da coordenação')
    await user.click(screen.getByRole('button', { name: 'Usar esta nota' }))
    await waitFor(() => expect(onConfirm).toHaveBeenLastCalledWith('Pedido da coordenação'))
  })

  it('[UC-AUDITORIA-004] regras do motivo iguais às do servidor', () => {
    expect(gradeReasonError('', false)).toBe('')
    expect(gradeReasonError('  ', true)).toMatch(/Informe o motivo/)
    expect(gradeReasonError(' ab ', true)).toMatch(/pelo menos 3 letras/)
    expect(gradeReasonError('abc', true)).toBe('')
    expect(isReasonRequiredError(reasonRequired())).toBe(true)
    expect(isReasonRequiredError(Object.assign(new Error('x'), { status: 400, data: { field: 'reason' } }))).toBe(false)
  })
})
