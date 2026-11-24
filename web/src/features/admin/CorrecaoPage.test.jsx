import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, RouterProvider, createMemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CorrecaoPage from './CorrecaoPage'
import { correctionBody, initialDraft, missingQuestions, parsePoints, queueLabel, validateDraft } from './correctionForm'

const mocks = vi.hoisted(() => {
  const state = { get: vi.fn(), post: vi.fn(), auth: undefined, toast: { success: vi.fn(), error: vi.fn() }, leaveGuard: null }
  // Guarda de saída do AuthProvider (A18): a tela registra aqui; "Trocar curso ou turma" e o
  // "Sair" do topo chamam leaveGuard(proceed) antes de limpar a turma ou a sessão.
  state.setLeaveGuard = (guard) => {
    state.leaveGuard = guard
    return () => { if (state.leaveGuard === guard) state.leaveGuard = null }
  }
  return state
})

vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }))
vi.mock('../../hooks/useAdminWorkspace', () => ({ useAdminWorkspace: () => ({ courseId: 'DES', courseName: 'Desenvolvimento', className: '1DES' }) }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: mocks.auth, setLeaveGuard: mocks.setLeaveGuard }) }))
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

// Roteador de dados como o do app (main.jsx): o useBlocker da tela só funciona nele. O
// link "Chamada" faz o papel do menu lateral.
let router
function renderPage(entry = '/resultados/correcao', { history = [] } = {}) {
  router = createMemoryRouter([
    { path: '/resultados/correcao', element: <><Link to="/chamada">Chamada</Link><CorrecaoPage /><Where /></> },
    { path: '/resultados', element: <Where /> },
    { path: '/chamada', element: <Where /> },
  ], { initialEntries: [...history, entry], initialIndex: history.length })
  return render(<RouterProvider router={router} />)
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

  it('[UC-CORRECAO-001] sair pelo menu, pelo voltar do navegador ou por Próxima com mudanças pede confirmação', async () => {
    const user = userEvent.setup()
    renderPage('/resultados/correcao', { history: ['/resultados'] })
    await screen.findByRole('heading', { name: 'Ana Souza' })
    // Sem mudanças, nada pergunta.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.type(screen.getByLabelText(/Comentário geral/), 'Bom trabalho.')

    // Menu lateral: antes, ia para /chamada sem perguntar e o texto se perdia.
    await user.click(screen.getByRole('link', { name: 'Chamada' }))
    let dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Sair sem salvar?')).toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent('/resultados/correcao')
    await user.click(within(dialog).getByRole('button', { name: 'Continuar corrigindo' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByLabelText(/Comentário geral/)).toHaveValue('Bom trabalho.')

    // Voltar do navegador.
    await act(async () => { await router.navigate(-1) })
    dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Continuar corrigindo' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByTestId('where')).toHaveTextContent('/resultados/correcao')

    // Próxima da fila (troca só o endereço de busca) também pergunta; confirmar sai.
    await user.click(screen.getByRole('button', { name: /Próxima/ }))
    dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Sair sem salvar' }))
    expect(await screen.findByRole('heading', { name: 'Bia Lima' })).toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent('submissionId=s2')
    // Na entrega nova, sem mudanças, o menu sai direto.
    await user.click(screen.getByRole('link', { name: 'Chamada' }))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/chamada'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('[UC-CORRECAO-001] "Trocar curso ou turma" e o "Sair" do topo com mudanças também perguntam antes de descartar', async () => {
    // Antes (ajuste 2 do A18): a troca de turma só limpava o estado no AuthProvider, sem
    // mudar o endereço; nem o useBlocker nem o beforeunload viam, e o texto se perdia.
    const user = userEvent.setup()
    const { unmount } = renderPage()
    await screen.findByRole('heading', { name: 'Ana Souza' })
    expect(typeof mocks.leaveGuard).toBe('function')
    // Sem mudanças: a guarda deixa sair na hora.
    const free = vi.fn()
    expect(mocks.leaveGuard(free)).toBe(false)
    expect(free).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText(/Comentário geral/), 'Rascunho do professor.')
    const proceed = vi.fn()
    let held
    act(() => { held = mocks.leaveGuard(proceed) })
    expect(held).toBe(true)
    let dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Sair sem salvar?')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Continuar corrigindo' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(proceed).not.toHaveBeenCalled()
    expect(screen.getByLabelText(/Comentário geral/)).toHaveValue('Rascunho do professor.')
    expect(screen.getByTestId('where')).toHaveTextContent('/resultados/correcao')

    // Confirmar segue a saída pedida (limpar a turma ou a sessão), uma vez só.
    act(() => { mocks.leaveGuard(proceed) })
    dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Sair sem salvar' }))
    expect(proceed).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // Fora da tela, a guarda sai do registro.
    unmount()
    expect(mocks.leaveGuard).toBe(null)
  })

  it('[UC-CORRECAO-001] a Coordenação (só consulta) sai sem pergunta pela troca de turma', async () => {
    mocks.auth = { role: 'admin', accountRole: 'coordenacao', readOnly: true, effectivePermissions: ['page.results'] }
    renderPage()
    await screen.findByRole('heading', { name: 'Ana Souza' })
    const proceed = vi.fn()
    expect(mocks.leaveGuard(proceed)).toBe(false)
  })

  it('[UC-CORRECAO-001] fechar ou recarregar a aba com mudanças pede a confirmação do navegador', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: 'Ana Souza' })
    const clean = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(clean)
    expect(clean.defaultPrevented).toBe(false)
    await user.type(screen.getByLabelText(/Ideia central/), '1')
    const dirty = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirty)
    expect(dirty.defaultPrevented).toBe(true)
  })

  it('[UC-CORRECAO-001] "Cancelar ajuste" volta à conta do sistema sem deixar mudança pendente', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: 'Ana Souza' })
    const objective = screen.getByText('Porta do HTTP?').closest('li')
    await user.click(within(objective).getByRole('button', { name: 'Ajustar pontos' }))
    expect(within(objective).getByLabelText(/^Pontos/)).toHaveValue('1')
    expect(screen.getByRole('button', { name: 'Salvar' })).toBeEnabled()
    await user.click(within(objective).getByRole('button', { name: 'Cancelar ajuste' }))
    expect(within(objective).queryByLabelText(/^Pontos/)).not.toBeInTheDocument()
    expect(within(objective).getByRole('button', { name: 'Ajustar pontos' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Salvar' })).toBeDisabled()
    await user.click(screen.getByRole('link', { name: 'Chamada' }))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/chamada'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('[UC-CORRECAO-001] sem ver o nome, o número de cada entrega não muda quando outra sai da fila', async () => {
    const user = userEvent.setup()
    try { window.localStorage.setItem('iclass.correcao.semNome', '1') } catch { /* sem armazenamento */ }
    let queue = QUEUE
    mocks.get.mockImplementation(async (path) => {
      if (path.startsWith('/api/admin/corrections')) return queue
      const match = path.match(/submissions\/([^/]+)\/correction/)
      if (match) return correction(decodeURIComponent(match[1]))
      return {}
    })
    mocks.post.mockImplementation(async () => {
      // Concluir a Ana tira a entrega dela da fila.
      queue = { ...QUEUE, total: 1, pendentes: QUEUE.pendentes.slice(1) }
      return { success: true, submissionId: 's1', score: 100, scoreBefore: 50, gradePublished: false, situacao: 'concluida', versao: 1, comentarioGeral: '', questoes: correction('s1').questoes }
    })
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Aluno 1' })).toBeInTheDocument()
    await user.type(screen.getByLabelText(/Ideia central/), '1')
    await user.type(screen.getByLabelText(/Clareza/), '1')
    await user.click(screen.getByRole('button', { name: 'Concluir correção' }))
    await screen.findByText('Correção concluída.')
    // O resultado continua no endereço da Ana, sem pedir confirmação.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent('submissionId=s1')
    await user.click(await screen.findByRole('button', { name: 'Corrigir a próxima' }))
    // A Bia continua "Aluno 2" (antes, virava "Aluno 1" quando a Ana saía da fila).
    expect(await screen.findByRole('heading', { name: 'Aluno 2' })).toBeInTheDocument()
    expect(screen.queryByText('Bia Lima')).not.toBeInTheDocument()
  })

  it('[UC-CORRECAO-001] ?applicationId= (o filtro de Resultados) mostra só as entregas daquela aplicação', async () => {
    const user = userEvent.setup()
    const queue = { ...QUEUE, pendentes: [{ ...QUEUE.pendentes[0], applicationId: 'app-1' }, { ...QUEUE.pendentes[1], applicationId: 'app-2' }] }
    mocks.get.mockImplementation(async (path) => {
      if (path.startsWith('/api/admin/corrections')) return queue
      const match = path.match(/submissions\/([^/]+)\/correction/)
      if (match) return correction(decodeURIComponent(match[1]))
      return {}
    })
    renderPage('/resultados/correcao?applicationId=app-2')
    expect(await screen.findByRole('heading', { name: 'Bia Lima' })).toBeInTheDocument()
    expect(screen.getByText('1 de 1')).toBeInTheDocument()
    expect(screen.getByText('Só a aplicação escolhida em Resultados.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Ver todas' }))
    expect(await screen.findByRole('heading', { name: 'Ana Souza' })).toBeInTheDocument()
    expect(screen.getByText('1 de 2')).toBeInTheDocument()
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

describe('Pedidos de revisão na tela Corrigir (A19)', () => {
  const OPEN = { id: 'rev_1', questionNumber: 2, texto: 'Acho que minha resposta da 2 merecia mais.', criadoEm: Date.parse('2026-11-22T10:00:00Z'), situacao: 'aberto', resposta: '', notaMudou: false, respondidoPor: null, respondidoEm: null }

  function withReviews() {
    mocks.get.mockImplementation(async (path) => {
      if (path.startsWith('/api/admin/corrections')) {
        return { success: true, total: 0, pendentes: [], pedidosRevisao: [{ submissionId: 's9', requestId: 'rev_1', aluno: { email: 'caio@x.local', name: 'Caio Reis' }, examKey: 'P1', prova: 'Prova 1', questionNumber: 2, criadoEm: OPEN.criadoEm }] }
      }
      const match = path.match(/submissions\/([^/]+)\/correction/)
      if (match) return correction(decodeURIComponent(match[1]), { aluno: { email: 'caio@x.local', name: 'Caio Reis' }, situacao: 'concluida', gradePublished: true, score: 70, pedidosRevisao: [OPEN] })
      return {}
    })
  }

  it('[UC-CORRECAO-001] o pedido aberto aparece no topo; abrir a entrega mostra o texto e a resposta vai para o servidor', async () => {
    const user = userEvent.setup()
    withReviews()
    mocks.post.mockResolvedValue({ success: true, submissionId: 's9', pedido: { ...OPEN, situacao: 'respondido', resposta: 'A nota está certa.', respondidoPor: 'prof@x.local', respondidoEm: Date.now() }, pedidosRevisao: [{ ...OPEN, situacao: 'respondido', resposta: 'A nota está certa.', respondidoPor: 'prof@x.local', respondidoEm: Date.now() }] })
    renderPage()
    const list = await screen.findByRole('region', { name: 'Pedidos de revisão' })
    expect(list).toHaveTextContent('1 pedido de revisão de nota')
    expect(screen.getByText(/1 pedido de revisão$/)).toBeInTheDocument()
    expect(screen.getByText('Toque num pedido de revisão acima para abrir a entrega e responder ao aluno.')).toBeInTheDocument()
    await user.click(within(list).getByRole('button', { name: /Caio Reis/ }))
    expect(await screen.findByRole('heading', { name: 'Caio Reis' })).toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent('submissionId=s9')
    const box = screen.getByRole('region', { name: 'Pedidos de revisão do aluno' })
    // A questão pela posição na prova do aluno (a mesma dos cartões de correção).
    expect(box).toHaveTextContent('Questão 2')
    expect(box).toHaveTextContent('Acho que minha resposta da 2 merecia mais.')
    const send = within(box).getByRole('button', { name: 'Responder ao aluno' })
    expect(send).toBeDisabled()
    await user.type(within(box).getByLabelText('Resposta para o aluno'), 'A nota está certa.')
    await user.click(send)
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/submissions/s9/review-requests/rev_1/answer', { resposta: 'A nota está certa.' }))
    expect(await within(box).findByText('Respondido · nota mantida')).toBeInTheDocument()
    expect(box).toHaveTextContent('Resposta de prof@x.local')
    expect(mocks.toast.success).toHaveBeenCalledWith('Resposta enviada. O aluno vê a resposta; a nota ficou como estava.')
  })

  it('[UC-CORRECAO-001] resposta digitada e não enviada pede confirmação ao sair; a Coordenação vê sem o campo', async () => {
    const user = userEvent.setup()
    withReviews()
    renderPage('/resultados/correcao?submissionId=s9')
    const box = await screen.findByRole('region', { name: 'Pedidos de revisão do aluno' })
    await user.type(within(box).getByLabelText('Resposta para o aluno'), 'Vou rever.')
    await user.click(screen.getByRole('link', { name: 'Chamada' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('A resposta ao pedido de revisão que você digitou ainda não foi enviada.')
    expect(screen.getByTestId('where')).toHaveTextContent('/resultados/correcao')
    cleanup()

    mocks.auth = { role: 'coordenacao', accountRole: 'coordenacao', readOnly: true, effectivePermissions: ['page.results'] }
    renderPage('/resultados/correcao?submissionId=s9')
    const readOnlyBox = await screen.findByRole('region', { name: 'Pedidos de revisão do aluno' })
    expect(within(readOnlyBox).queryByLabelText('Resposta para o aluno')).not.toBeInTheDocument()
    expect(readOnlyBox).toHaveTextContent('Quem responde é o professor da turma.')
  })
})
