import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReviewRequestPanel, reviewQuestionNumbers } from './ReviewRequestPanel'
import ProvasPage from './ProvasPage'

const mocks = vi.hoisted(() => ({ post: vi.fn(), submissions: [] }))

vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: mocks.post } }))
vi.mock('./useStudent', () => ({ useStudent: () => ({ email: 'ana@x.local', studentClass: '1DES', courseId: 'DES' }) }))
vi.mock('../../hooks/useApi', () => ({
  useApi: () => ({ data: { applications: [] }, loading: false, error: null, refetch: vi.fn(), pollNow: vi.fn() }),
}))
vi.mock('../../components/ui/MiniLineChart', () => ({ MiniLineChart: () => null }))

const DAY = 24 * 60 * 60 * 1000

// Entrega como /api/student/my-submissions devolve (P3-S5 / A19: revisao e pedidosRevisao).
function submission(extra = {}) {
  return {
    id: 'sub_1', examKey: 'Avaliacao_Redes', examTitle: 'Prova de redes', score: 70, gradePublished: true, consolidatedScore: 70,
    countsTowardResult: true, resultStatus: 'considered', type: 'online', attemptNumber: 1, timestamp: '2026-11-20T12:00:00.000Z',
    gradedAnswers: [{ questionNumber: 1, studentChoice: 'A' }, { questionNumber: 2, studentChoice: 'B' }, { questionNumber: 4, studentChoice: 'C' }],
    revisao: { podePedir: true, motivo: null, mensagem: '', prazoAte: Date.parse('2026-11-27T12:00:00.000Z') },
    ...extra,
  }
}

beforeEach(() => {
  window.matchMedia = vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Pedido de revisão (aluno)', () => {
  it('[UC-CORRECAO-001] pede revisão de uma questão: o servidor recebe a questão e o texto; texto curto não sai', async () => {
    const onSent = vi.fn()
    mocks.post.mockResolvedValueOnce({ success: true, pedido: { id: 'rev_1', situacao: 'aberto' } })
    render(<ReviewRequestPanel submission={submission()} onSent={onSent} />)
    expect(screen.getByText(/pedir revisão até 27\/11, um pedido por vez/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Pedir revisão' }))
    const select = screen.getByLabelText('Sobre o quê?')
    expect([...select.options].map((option) => option.textContent)).toEqual(['A prova toda', 'Questão 1', 'Questão 2', 'Questão 4'])
    fireEvent.change(select, { target: { value: '4' } })
    const box = screen.getByLabelText('Explique o que deve ser revisto')
    fireEvent.change(box, { target: { value: 'curto' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar pedido' }))
    expect(await screen.findByText('Explique o pedido com pelo menos 10 letras.')).toBeInTheDocument()
    expect(mocks.post).not.toHaveBeenCalled()
    // A contagem de caracteres aparece desde o começo (teto do servidor: 1.000).
    expect(screen.getByText('5 de 1.000 caracteres')).toBeInTheDocument()

    fireEvent.change(box, { target: { value: 'A alternativa B também está certa.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar pedido' }))
    await waitFor(() => expect(onSent).toHaveBeenCalled())
    expect(mocks.post).toHaveBeenCalledWith('/api/student/submissions/sub_1/review-request', { questionNumber: 4, texto: 'A alternativa B também está certa.' })
    expect(screen.getByRole('status')).toHaveTextContent('Pedido enviado.')
    expect(screen.queryByLabelText('Explique o que deve ser revisto')).not.toBeInTheDocument()
  })

  it('[UC-CORRECAO-001] mostra o pedido aberto e a resposta do professor; recusa do servidor aparece no formulário', async () => {
    const answered = submission({
      revisao: { podePedir: false, motivo: 'deadline_passed', mensagem: 'O prazo para pedir revisão desta prova (7 dias depois da publicação da nota) já terminou.', prazoAte: Date.now() - DAY },
      pedidosRevisao: [
        { id: 'rev_1', questionNumber: 2, texto: 'A 2 tinha duas certas.', criadoEm: Date.parse('2026-11-21T10:00:00Z'), situacao: 'respondido', resposta: 'Você tem razão.', notaMudou: true, respondidoEm: Date.parse('2026-11-22T10:00:00Z') },
        { id: 'rev_2', questionNumber: null, texto: 'Revise a prova toda.', criadoEm: Date.parse('2026-11-23T10:00:00Z'), situacao: 'aberto', resposta: '', notaMudou: false, respondidoEm: null },
      ],
    })
    render(<ReviewRequestPanel submission={answered} />)
    const items = screen.getAllByRole('listitem')
    // O mais novo primeiro.
    expect(items[0]).toHaveTextContent('A prova toda')
    expect(within(items[0]).getByText('Aguardando o professor')).toBeInTheDocument()
    expect(items[1]).toHaveTextContent('Questão 2')
    expect(within(items[1]).getByText('Respondido · a nota mudou')).toBeInTheDocument()
    expect(items[1]).toHaveTextContent('Você tem razão.')
    expect(screen.getByText(/já terminou/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Pedir revisão' })).not.toBeInTheDocument()
    cleanup()

    mocks.post.mockRejectedValueOnce(Object.assign(new Error('Você já tem um pedido de revisão aberto nesta prova. Espere a resposta do professor.'), { status: 409 }))
    render(<ReviewRequestPanel submission={submission()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pedir revisão' }))
    fireEvent.change(screen.getByLabelText('Explique o que deve ser revisto'), { target: { value: 'Revise a prova toda, por favor.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar pedido' }))
    expect(await screen.findByText(/já tem um pedido de revisão aberto/)).toBeInTheDocument()
    expect(mocks.post).toHaveBeenCalledWith('/api/student/submissions/sub_1/review-request', { questionNumber: null, texto: 'Revise a prova toda, por favor.' })
  })

  it('nota não publicada e sem pedido: nada aparece; números das questões sem repetir', () => {
    const { container } = render(<ReviewRequestPanel submission={submission({ gradePublished: false, revisao: { podePedir: false, motivo: 'not_published', mensagem: 'x', prazoAte: null } })} />)
    expect(container).toBeEmptyDOMElement()
    expect(reviewQuestionNumbers({ gradedAnswers: [{ questionNumber: 3 }, { questionNumber: 3 }, { questionNumber: 'x' }, { questionNumber: 1 }] })).toEqual([3, 1])
  })

  it('[UC-CORRECAO-001] o aviso do sino (?entrega=) abre o resultado com a resposta do professor', async () => {
    mocks.submissions = [submission({
      revisao: { podePedir: true, motivo: null, mensagem: '', prazoAte: Date.now() + DAY },
      pedidosRevisao: [{ id: 'rev_1', questionNumber: 1, texto: 'Revise a 1.', criadoEm: Date.now() - DAY, situacao: 'respondido', resposta: 'A nota está certa.', notaMudou: false, respondidoEm: Date.now() }],
    })]
    mocks.post.mockImplementation(async () => ({ submissions: mocks.submissions }))
    render(<MemoryRouter initialEntries={['/aluno/provas?entrega=sub_1']}><ProvasPage /></MemoryRouter>)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('A nota está certa.')).toBeInTheDocument()
    expect(within(dialog).getByText('Respondido · nota mantida')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Pedir revisão' })).toBeInTheDocument()
  })
})
