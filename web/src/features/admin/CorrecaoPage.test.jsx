import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CorrecaoPage from './CorrecaoPage'
import { correctionBody, initialDraft, missingQuestions, parsePoints, queueLabel, validateDraft } from './correctionForm'

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), auth: undefined, toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }))
vi.mock('../../hooks/useAdminWorkspace', () => ({ useAdminWorkspace: () => ({ courseId: 'DES', courseName: 'Desenvolvimento', className: '1DES' }) }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: mocks.auth }) }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))

// Fila e entrega como GET /api/admin/corrections e GET /api/admin/submissions/:id/correction
// devolvem (adminCorrections.js, A9).
const QUEUE = {
  success: true,
  total: 2,
  pendentes: [
    { submissionId: 's1', aluno: { email: 'ana@x.local', name: 'Ana Souza' }, examKey: 'P1', prova: 'Prova 1', attemptNumber: 1, enviadaEm: '2026-11-20T13:00:00Z', questoesPendentes: [2], versao: 0 },
    { submissionId: 's2', aluno: { email: 'bia@x.local', name: 'Bia Lima' }, examKey: 'P1', prova: 'Prova 1', attemptNumber: 1, enviadaEm: '2026-11-20T13:05:00Z', questoesPendentes: [2], versao: 0 },
  ],
}

function correction(id = 's1', extra = {}) {
  const name = id === 's1' ? 'Ana Souza' : 'Bia Lima'
  return {
    success: true, submissionId: id, aluno: { email: `${id}@x.local`, name }, examKey: 'P1', prova: 'Prova 1', attemptNumber: 1,
    enviadaEm: '2026-11-20T13:00:00Z', gradePublished: false, score: 50, situacao: 'pendente', versao: 0, comentarioGeral: '',
    questoes: [
      {
        position: 1, questionNumber: 1, type: 'multiple_choice', text: 'Porta do HTTP?', points: 1, answerText: 'A', studentChoices: [],
        annulled: false, automatico: { pointsEarned: 1, pointsPossible: 1, isCorrect: true, pending: false }, precisaDoProfessor: false, item: null,
        alternatives: [{ letter: 'A', canonicalLetter: 'A', text: '80' }, { letter: 'B', canonicalLetter: 'B', text: '21' }], correctAnswerSeen: 'A',
      },
      {
        position: 2, questionNumber: 2, type: 'essay', text: 'Explique o que é um **protocolo**.', points: 2, answerText: 'Resposta escrita',
        studentResponse: 'Regras de comunicação entre computadores.', annulled: false,
        automatico: { pointsEarned: 0, pointsPossible: 2, isCorrect: null, pending: true }, precisaDoProfessor: true, item: null, alternatives: [],
        expectedAnswer: 'Conjunto de regras de comunicação.', rubric: [{ id: 'ideia', nome: 'Ideia central', pontos: 1 }, { id: 'clareza', nome: 'Clareza', pontos: 1 }],
      },
    ],
    ...extra,
  }
}

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.pathname}{location.search}</output>
}

function renderPage(entry = '/resultados/correcao') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/resultados/correcao" element={<><CorrecaoPage /><Where /></>} />
        <Route path="/resultados" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  try { window.localStorage.clear() } catch { /* sem armazenamento */ }
  mocks.auth = { role: 'admin', accountRole: 'professor', readOnly: false }
  mocks.get.mockImplementation(async (path) => {
    if (path.startsWith('/api/admin/corrections')) return QUEUE
    const match = path.match(/submissions\/([^/]+)\/correction/)
    if (match) return correction(decodeURIComponent(match[1]))
    return {}
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Corrigir provas (A18)', () => {
  it('[UC-CORRECAO-001] abre a primeira da fila, lança a rubrica e o comentário e conclui com a nota antes e depois', async () => {
    const user = userEvent.setup()
    mocks.post.mockResolvedValue({ success: true, submissionId: 's1', score: 75, scoreBefore: 50, gradePublished: false, situacao: 'concluida', versao: 1, comentarioGeral: 'Bom trabalho.', questoes: correction('s1').questoes })
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Ana Souza' })).toBeInTheDocument()
    expect(screen.getByText('Regras de comunicação entre computadores.')).toBeInTheDocument()
    expect(screen.getByText('Conjunto de regras de comunicação.')).toBeInTheDocument()
    expect(screen.getByText('protocolo', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText('Falta a questão 2')).toBeInTheDocument()

    await user.type(screen.getByLabelText(/Ideia central/), '1')
    await user.type(screen.getByLabelText(/Clareza/), '0,5')
    expect(screen.getByLabelText(/^Pontos/)).toHaveValue('1,5')
    const essay = screen.getByText('Regras de comunicação entre computadores.').closest('li')
    await user.type(within(essay).getByLabelText(/Comentário para o aluno/), 'Faltou dar exemplos.')
    await user.type(screen.getByLabelText(/Comentário geral/), 'Bom trabalho.')
    await user.click(screen.getByRole('button', { name: 'Concluir correção' }))

    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1))
    const [path, body] = mocks.post.mock.calls[0]
    expect(path).toBe('/api/admin/submissions/s1/correction')
    expect(body).toEqual({ versao: 0, itens: { 2: { comentario: 'Faltou dar exemplos.', rubrica: { ideia: 1, clareza: 0.5 } } }, comentarioGeral: 'Bom trabalho.', concluir: true })
    const done = await screen.findByText('Correção concluída.')
    expect(done.parentElement).toHaveTextContent('Nota: 5,0 → 7,5')
    // A entrega fica no endereço (saiu da fila) e "Corrigir a próxima" leva para a da Bia.
    expect(screen.getByTestId('where')).toHaveTextContent('submissionId=s1')
    await user.click(screen.getByRole('button', { name: 'Corrigir a próxima' }))
    expect(await screen.findByRole('heading', { name: 'Bia Lima' })).toBeInTheDocument()
  })

  it('[UC-CORRECAO-001] "Corrigir sem ver o nome" troca o nome por "Aluno N" e fica lembrado', async () => {
    const user = userEvent.setup()
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Ana Souza' })).toBeInTheDocument()
    await user.click(screen.getByLabelText(/Corrigir sem ver o nome/))
    expect(screen.getByRole('heading', { name: 'Aluno 1' })).toBeInTheDocument()
    expect(screen.queryByText('Ana Souza')).not.toBeInTheDocument()
    expect(screen.queryByText('Bia Lima')).not.toBeInTheDocument()
    cleanup()
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Aluno 1' })).toBeInTheDocument()
  })

  it('[UC-CORRECAO-001] concluir sem os pontos da dissertativa avisa na tela e não manda nada', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: 'Ana Souza' })
    await user.click(screen.getByRole('button', { name: 'Concluir correção' }))
    expect(screen.getByText('Falta lançar os pontos da questão 2.')).toBeInTheDocument()
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('[UC-CORRECAO-001] pontos acima do possível e ajuste da objetiva sem motivo ficam no campo, antes de mandar', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: 'Ana Souza' })
    await user.type(screen.getByLabelText(/Ideia central/), '3')
    await user.click(screen.getByRole('button', { name: 'Ajustar pontos' }))
    const objective = screen.getByText('Porta do HTTP?').closest('li')
    const points = within(objective).getByLabelText(/^Pontos/)
    await user.clear(points)
    await user.type(points, '0,5')
    await user.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(screen.getByText('De 0 a 1 ponto.')).toBeInTheDocument()
    expect(within(objective).getByText(/Informe o motivo: o sistema corrigiu/)).toBeInTheDocument()
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('[UC-CORRECAO-001] outra aba gravou antes (409): aviso com "Recarregar", que busca a versão atual', async () => {
    const user = userEvent.setup()
    mocks.post.mockRejectedValue(Object.assign(new Error('Esta correção foi alterada em outra tela.'), { status: 409, data: { code: 'correction_conflict', versao: 3 } }))
    renderPage()
    await screen.findByRole('heading', { name: 'Ana Souza' })
    await user.type(screen.getByLabelText(/Ideia central/), '1')
    await user.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(await screen.findByText(/foi alterada em outra tela enquanto você corrigia/)).toBeInTheDocument()
    const loads = mocks.get.mock.calls.filter(([path]) => path.includes('/s1/correction')).length
    await user.click(screen.getByRole('button', { name: 'Recarregar' }))
    await waitFor(() => expect(mocks.get.mock.calls.filter(([path]) => path.includes('/s1/correction')).length).toBe(loads + 1))
  })

  it('[UC-AUDITORIA-004] nota já publicada que muda: pede o motivo no diálogo e manda junto', async () => {
    const user = userEvent.setup()
    mocks.post
      .mockRejectedValueOnce(Object.assign(new Error('Informe o motivo: esta nota já foi publicada para o aluno.'), { status: 400, data: { code: 'reason_required', field: 'motivo' } }))
      .mockResolvedValueOnce({ success: true, submissionId: 's1', score: 100, scoreBefore: 50, gradePublished: true, situacao: 'concluida', versao: 1, comentarioGeral: '', questoes: correction('s1').questoes })
    renderPage()
    await screen.findByRole('heading', { name: 'Ana Souza' })
    await user.type(screen.getByLabelText(/Ideia central/), '1')
    await user.type(screen.getByLabelText(/Clareza/), '1')
    await user.click(screen.getByRole('button', { name: 'Concluir correção' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByRole('textbox'), 'Revisão pedida pelo aluno')
    await user.click(within(dialog).getByRole('button', { name: 'Concluir correção' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2))
    expect(mocks.post.mock.calls[1][1]).toMatchObject({ concluir: true, motivo: 'Revisão pedida pelo aluno' })
    expect(await screen.findByText(/o aluno já vê a nota nova/)).toBeInTheDocument()
  })

  it('[UC-PAPEIS-004] a Coordenação vê a correção sem campos nem botões de gravar', async () => {
    mocks.auth = { role: 'admin', accountRole: 'coordenacao', readOnly: true, effectivePermissions: ['page.results'] }
    renderPage()
    await screen.findByRole('heading', { name: 'Ana Souza' })
    expect(screen.getByText(/só para consulta/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Concluir correção' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Salvar' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Ideia central/)).not.toBeInTheDocument()
  })

  it('[UC-CORRECAO-001] o filtro de prova e o endereço com submissionId abrem a entrega pedida', async () => {
    renderPage('/resultados/correcao?examKey=P1&submissionId=s2')
    expect(await screen.findByRole('heading', { name: 'Bia Lima' })).toBeInTheDocument()
    expect(screen.getByText('2 de 2')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Prova' })).toHaveValue('P1')
  })

  it('[UC-CORRECAO-001] fila vazia: diz que não há prova aguardando', async () => {
    mocks.get.mockImplementation(async (path) => (path.startsWith('/api/admin/corrections') ? { success: true, pendentes: [], total: 0 } : {}))
    renderPage()
    expect(await screen.findByText('Nenhuma prova aguardando correção')).toBeInTheDocument()
  })
})

describe('Corrigir provas · formulário (correctionForm)', () => {
  it('[UC-CORRECAO-001] pontos com vírgula, só as questões que mudaram e a questão apagada como null', () => {
    expect(parsePoints('1,5')).toBe(1.5)
    expect(parsePoints('')).toBe(null)
    expect(Number.isNaN(parsePoints('um'))).toBe(true)
    const questoes = correction('s1').questoes.map((question) => (question.questionNumber === 2 ? { ...question, rubric: undefined, item: { pontos: 1, comentario: 'ok' } } : question))
    const initial = initialDraft(questoes)
    expect(initial[2]).toMatchObject({ pontos: '1', comentario: 'ok' })
    const draft = { ...initial, 2: { ...initial[2], pontos: '' } }
    expect(correctionBody({ questoes, draft, initial, versao: 4 })).toEqual({ versao: 4, itens: { 2: { comentario: 'ok', pontos: null } } })
    expect(missingQuestions(questoes, draft)).toEqual([2])
    expect(validateDraft(questoes, { ...draft, 2: { ...draft[2], pontos: '2,5' } })).toEqual({ 'itens.2.pontos': 'No máximo 2 pontos.' })
    expect(queueLabel({ aluno: { name: 'Ana' } }, 0)).toBe('Ana')
    expect(queueLabel({ aluno: { name: 'Ana' } }, 2, { anonymous: true })).toBe('Aluno 3')
  })
})
