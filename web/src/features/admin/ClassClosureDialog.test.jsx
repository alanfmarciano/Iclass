import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClassClosureDialog } from './ClassClosureDialog'

// Encerrar e reabrir turma (B10 / P2-S9). Antes não havia como encerrar a turma.
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))

const T1 = { courseId: 'DES', courseName: 'Técnico em TI', name: '1DES' }
const T2 = { courseId: 'DES', courseName: 'Técnico em TI', name: '2DES' }

function summary(name, extra = {}) {
  return {
    turma: { courseId: 'DES', courseName: 'Técnico em TI', name, periodoLetivo: '2027 · 1º semestre' },
    encerramento: null,
    alunos: 3,
    situacoes: [{ situacao: 'aprovado', rotulo: 'Aprovado', total: 2 }, { situacao: 'em_recuperacao', rotulo: 'Em recuperação', total: 1 }],
    pendencias: [],
    avisos: ['1 aluno está em recuperação. Lance a recuperação antes de encerrar, se ela já aconteceu.'],
    podeEncerrar: true,
    podeReabrir: false,
    ...extra,
  }
}

beforeEach(() => {
  mocks.get.mockReset()
  mocks.post.mockReset()
  Object.values(mocks.toast).forEach(fn => fn.mockReset())
})
afterEach(() => cleanup())

describe('Encerrar turma', () => {
  it('[UC-CURSO-003] mostra o resumo de situações e só encerra com ENCERRAR digitado', async () => {
    const user = userEvent.setup()
    const onDone = vi.fn()
    const onClose = vi.fn()
    mocks.get.mockResolvedValue(summary('1DES'))
    mocks.post.mockResolvedValue({ success: true, encerramento: { encerrada: true } })
    render(<ClassClosureDialog open mode="close" targets={[T1]} onClose={onClose} onDone={onDone} />)
    const dialog = await screen.findByRole('dialog')
    expect(mocks.get).toHaveBeenCalledWith('/api/admin/class/close-summary?courseId=DES&name=1DES')
    expect(within(dialog).getByText('Encerrar a turma 1DES?')).toBeInTheDocument()
    expect(await within(dialog).findByText('Aprovado: 2')).toBeInTheDocument()
    expect(within(dialog).getByText('Em recuperação: 1')).toBeInTheDocument()
    expect(within(dialog).getByText(/Lance a recuperação antes de encerrar/)).toBeInTheDocument()
    const confirm = within(dialog).getByRole('button', { name: 'Encerrar turma' })
    expect(confirm).toBeDisabled()
    // O primeiro passo é digitar a palavra: o foco começa nela, não no motivo.
    await waitFor(() => expect(within(dialog).getByLabelText('Digite ENCERRAR para confirmar')).toHaveFocus())
    // Em minúsculas não vale (o servidor também recusa): o campo diz o que falta.
    const word = within(dialog).getByLabelText('Digite ENCERRAR para confirmar')
    await user.type(word, 'encerrar')
    expect(confirm).toBeDisabled()
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Digite em letras maiúsculas: ENCERRAR.')
    expect(word).toHaveAttribute('autocapitalize', 'characters')
    await user.clear(word)
    await user.type(word, 'ENCERRAR')
    expect(within(dialog).queryByText('Digite em letras maiúsculas: ENCERRAR.')).not.toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Motivo (opcional)'), 'fim do semestre')
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/class/close', { courseId: 'DES', name: '1DES', confirm: 'ENCERRAR', reason: 'fim do semestre' }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(mocks.toast.success).toHaveBeenCalledWith('Turma 1DES encerrada. Notas e presença ficam travadas até reabrir.')
  })

  it('[UC-CURSO-003] turma com prova aberta mostra o motivo e não deixa encerrar; no lote, só encerra as outras', async () => {
    const user = userEvent.setup()
    mocks.get.mockImplementation(url => Promise.resolve(url.includes('name=1DES')
      ? summary('1DES', { podeEncerrar: false, pendencias: [{ code: 'exam_in_progress', texto: 'A prova "Redes" está aberta no Monitor. Encerre a aplicação antes de encerrar a turma.' }] })
      : summary('2DES')))
    mocks.post.mockResolvedValue({ success: true })
    render(<ClassClosureDialog open mode="close" targets={[T1, T2]} onClose={vi.fn()} onDone={vi.fn()} />)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Encerrar 2 turmas?')).toBeInTheDocument()
    expect(await within(dialog).findByText(/"Redes" está aberta no Monitor/)).toBeInTheDocument()
    expect(within(dialog).getByText('Só a turma sem pendência é encerrada.')).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Digite ENCERRAR para confirmar'), 'ENCERRAR')
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar 1 turma' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1))
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/class/close', { courseId: 'DES', name: '2DES', confirm: 'ENCERRAR' })
  })

  it('[UC-CURSO-003] reabrir pede o motivo', async () => {
    const user = userEvent.setup()
    mocks.post.mockResolvedValue({ success: true })
    const onDone = vi.fn()
    render(<ClassClosureDialog open mode="reopen" targets={[T1]} onClose={vi.fn()} onDone={onDone} />)
    const dialog = await screen.findByRole('dialog')
    expect(mocks.get).not.toHaveBeenCalled()
    const confirm = within(dialog).getByRole('button', { name: 'Reabrir turma' })
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Motivo para reabrir'), 'nota lançada errada')
    await user.click(confirm)
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/class/reopen', { courseId: 'DES', name: '1DES', reason: 'nota lançada errada' }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })
})
