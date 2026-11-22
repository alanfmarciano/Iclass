import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 3, C0a (contrato C12 do P3): na tela Provas do professor, salvar a prova para o
// curso inteiro e excluir questão do banco perguntam no ConfirmDialog, sem o confirm do
// navegador (que congelava a página).
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  branding: { displayName: 'ETC', schoolName: 'Escola Técnica Centro', institution: { tradeName: 'Escola Técnica Centro', cityState: 'Recife - PE' } },
  // Sessão do painel: sem nada, como antes (administrador); o teste do gabarito troca.
  auth: undefined,
}))

vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post, put: mocks.put } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
vi.mock('../../context/BrandingProvider', () => ({ useBranding: () => ({ branding: mocks.branding }) }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => mocks.auth }))
vi.mock('../../hooks/useAdminWorkspace', () => ({ useAdminWorkspace: () => ({ courseId: 'C1', courseName: 'Curso', className: '1DES' }) }))
vi.mock('../../hooks/useApi', () => ({
  useApi: (path) => {
    if (path === '/api/courses') return { data: [{ id: 'C1', name: 'Curso' }], loading: false, refetch: vi.fn() }
    if (path === '/api/admin/course-summaries') return { data: [{ id: 'C1', classes: [{ name: '1DES' }, { name: '2DES' }] }], loading: false, refetch: vi.fn() }
    if (String(path).startsWith('/api/admin/classes')) return { data: [{ name: '1DES', courseId: 'C1', onlineExamConfigs: {} }], loading: false, refetch: vi.fn() }
    return { data: null, loading: false, refetch: vi.fn() }
  },
}))

import ProvasPage from './ProvasPage'

const bankQuestion = { key: 'q1', category: 'Redes', questionText: 'O que é <b>DNS</b>?', alternatives: [{ letter: 'A', text: 'Nomes' }, { letter: 'B', text: 'Cabos' }], correctAnswer: 'A' }

let nativeSpies = []

beforeEach(() => {
  vi.clearAllMocks()
  mocks.get.mockImplementation(async (url) => {
    if (url.startsWith('/api/admin/courses/C1/structure')) return { structure: [{ id: 'm1', name: 'Módulo 1', units: [{ avaliacaoKey: 'Avaliacao_1', name: 'Avaliação 1' }] }] }
    if (url === '/api/admin/question-bank') return { questions: [bankQuestion] }
    if (url.startsWith('/api/status')) return {}
    if (url.startsWith('/api/admin/exam-history')) return { history: [] }
    if (url.startsWith('/api/admin/exam-applications')) return { applications: [] }
    return {}
  })
  mocks.post.mockResolvedValue({ success: true, key: 'Avaliacao_2' })
  mocks.auth = undefined
  nativeSpies = ['prompt', 'confirm', 'alert'].map((name) => vi.spyOn(window, name).mockImplementation(() => { throw new Error(`window.${name}`) }))
})

afterEach(() => {
  for (const spy of nativeSpies) {
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  }
  cleanup()
})

async function openEditor() {
  render(<MemoryRouter><ProvasPage /></MemoryRouter>)
  const button = await screen.findByRole('button', { name: 'Nova prova' })
  await waitFor(() => expect(button).not.toBeDisabled())
  fireEvent.click(button)
  return screen.getByRole('dialog', { name: /prova/i })
}

const posts = (path) => mocks.post.mock.calls.filter(([url]) => url === path)

// Preenche a questão nova (enunciado e as quatro alternativas): desde o P3-S3 a tela
// confere a questão antes de enviar, como o servidor.
function fillFirstQuestion(editor, text = 'Qual protocolo usa a porta 80?') {
  const card = within(editor).getByRole('group', { name: 'Questão 1' })
  fireEvent.change(within(card).getByLabelText('Enunciado'), { target: { value: text } })
  ;['HTTP', 'FTP', 'SSH', 'DNS'].forEach((value, index) => {
    fireEvent.change(within(card).getByLabelText(`Texto da alternativa ${'ABCD'[index]} da questão 1`), { target: { value } })
  })
  return card
}

describe('[UC-BANCO-001] ProvasPage do professor · banco de questões', () => {
  it('"Ver banco de questões" abre o banco sem "Adicionar"; no editor, a questão adicionada vem com "Do banco"', async () => {
    render(<MemoryRouter><ProvasPage /></MemoryRouter>)
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Ver banco de questões' })) })
    let bank = await screen.findByRole('dialog', { name: 'Banco de questões' })
    await within(bank).findByRole('button', { name: 'Editar' })
    expect(within(bank).queryByRole('button', { name: 'Adicionar' })).toBeNull()
    fireEvent.click(within(bank).getByRole('button', { name: 'Fechar' }))
    cleanup()

    const editor = await openEditor()
    // Com o editor aberto, o banco abre pelo botão do editor.
    expect(screen.queryByRole('button', { name: 'Ver banco de questões' })).toBeNull()
    await act(async () => { fireEvent.click(within(editor).getByRole('button', { name: 'Banco de questões' })) })
    bank = await screen.findByRole('dialog', { name: 'Banco de questões' })
    fireEvent.click(await within(bank).findByRole('button', { name: 'Adicionar' }))
    const added = within(editor).getByRole('group', { name: 'Questão 2' })
    expect(within(added).getByText('Do banco')).toBeTruthy()
    expect(within(added).getByRole('button', { name: 'Salvar no banco (questão 2)' })).toBeDisabled()
    expect(within(within(editor).getByRole('group', { name: 'Questão 1' })).getByRole('button', { name: 'Salvar no banco (questão 1)' })).not.toBeDisabled()
  })
})

describe('[UC-CONFIRMACAO-001] ProvasPage do professor · confirmações no diálogo da tela', () => {
  it('excluir questão do banco: Cancelar não exclui; Excluir exclui e tira da lista', async () => {
    await openEditor()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Banco de questões' })) })
    const bank = await screen.findByRole('dialog', { name: 'Banco de questões' })
    fireEvent.click(within(bank).getByRole('button', { name: 'Excluir questão do banco' }))
    let dialog = screen.getByRole('dialog', { name: 'Excluir a questão do banco?' })
    // O texto da questão aparece como texto, não como HTML.
    expect(dialog).toHaveTextContent('"O que é <b>DNS</b>?"')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog', { name: 'Excluir a questão do banco?' })).toBeNull()
    expect(posts('/api/admin/question-bank/delete')).toHaveLength(0)

    fireEvent.click(within(bank).getByRole('button', { name: 'Excluir questão do banco' }))
    dialog = screen.getByRole('dialog', { name: 'Excluir a questão do banco?' })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Excluir' })) })
    await waitFor(() => expect(posts('/api/admin/question-bank/delete')).toHaveLength(1))
    expect(posts('/api/admin/question-bank/delete')[0][1]).toEqual({ key: 'q1' })
    expect(screen.queryByRole('dialog', { name: 'Excluir a questão do banco?' })).toBeNull()
    expect(within(screen.getByRole('dialog', { name: 'Banco de questões' })).queryByRole('button', { name: 'Excluir questão do banco' })).toBeNull()
  })

  it('salvar para todas as turmas do curso pergunta antes e lista as turmas; Cancelar não grava', async () => {
    const editor = await openEditor()
    fillFirstQuestion(editor)
    fireEvent.change(within(editor).getByLabelText('Aplicar alterações em'), { target: { value: 'course' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Salvar prova' }))
    let dialog = screen.getByRole('dialog', { name: 'Substituir a prova nas turmas?' })
    expect(dialog).toHaveTextContent('Esta alteração substituirá esta prova em: 1DES, 2DES.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(posts('/api/admin/evaluation')).toHaveLength(0)

    fireEvent.click(within(editor).getByRole('button', { name: 'Salvar prova' }))
    dialog = screen.getByRole('dialog', { name: 'Substituir a prova nas turmas?' })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar prova' })) })
    await waitFor(() => expect(posts('/api/admin/evaluation')).toHaveLength(1))
    expect(posts('/api/admin/evaluation')[0][1]).toMatchObject({ scope: 'course', courseId: 'C1', studentClass: '1DES', moduleId: 'm1' })
    expect(screen.queryByRole('dialog', { name: 'Substituir a prova nas turmas?' })).toBeNull()
  })

  it('salvar só para esta turma não pergunta', async () => {
    const editor = await openEditor()
    fillFirstQuestion(editor)
    await act(async () => { fireEvent.click(within(editor).getByRole('button', { name: 'Salvar prova' })) })
    await waitFor(() => expect(posts('/api/admin/evaluation')).toHaveLength(1))
    expect(screen.queryByRole('dialog', { name: 'Substituir a prova nas turmas?' })).toBeNull()
  })
})

// Fase 3, P3-S3 (AVA-06, FUN-10, UXA-12): editor com os tipos novos dentro da tela Provas,
// prévia da montagem com tipo, pontos e Markdown, e "Versões online" com o limite do
// servidor (4).
const typedEvaluation = {
  title: 'Prova de redes',
  questions: [
    { number: 1, originalNumber: 1, type: 'multiple_choice', points: 2, text: 'Qual a **topologia**?', alternatives: [{ letter: 'A', text: 'Estrela', isCorrect: true }, { letter: 'B', text: 'Anel', isCorrect: false }], correctAnswer: 'A' },
    { number: 2, originalNumber: 2, type: 'numeric', points: 1.5, text: 'Latência média?', alternatives: [], correctAnswer: '', numeric: { value: 3.5, tolerance: 0.25, unit: 'ms' }, review: 'auto', explanation: 'Média das três.' },
  ],
}

async function openTypedExam() {
  mocks.get.mockImplementation(async (url) => {
    if (url.startsWith('/api/admin/courses/C1/structure')) return { structure: [{ id: 'm1', name: 'Módulo 1', units: [{ avaliacaoKey: 'Avaliacao_1', name: 'Avaliação 1' }] }] }
    if (url === '/api/admin/evaluation/Avaliacao_1') return { evaluation: typedEvaluation }
    if (url.startsWith('/api/status')) return {}
    if (url.startsWith('/api/admin/exam-history')) return { history: [] }
    if (url.startsWith('/api/admin/exam-applications')) return { applications: [] }
    return {}
  })
  mocks.put.mockResolvedValue({ success: true, key: 'Avaliacao_1', evaluation: typedEvaluation })
  render(<MemoryRouter><ProvasPage /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: /Avaliação 1/ }))
  await screen.findByRole('heading', { name: 'Prova de redes' })
}

describe('[UC-PROVA-004] ProvasPage do professor · questões com os tipos novos', () => {
  it('a prévia da montagem mostra tipo, pontos, Markdown e a resposta da numérica; o total de pontos aparece', async () => {
    await openTypedExam()
    expect(screen.getByText('3,5 pontos nesta montagem')).toBeInTheDocument()
    expect(screen.getByText('Numérica')).toBeInTheDocument()
    expect(screen.getByText('1,5 ponto')).toBeInTheDocument()
    expect(screen.getByText('topologia').tagName).toBe('STRONG')
    expect(screen.getByText(/3,5 ms \(± 0,25\)/)).toBeInTheDocument()
  })

  // Rodada de ajuste 1 do A6 (contrato printDocument): a prova impressa sai com o
  // cabeçalho da escola (identidade da escola do curso) e o rodapé "Gerado por".
  it('"Gerar prova + gabarito" imprime pelo documento da escola, com cabeçalho e rodapé', async () => {
    const written = []
    const win = { document: { write: (html) => written.push(html), close: vi.fn() }, print: vi.fn() }
    const open = vi.spyOn(window, 'open').mockReturnValue(win)
    try {
      await openTypedExam()
      fireEvent.click(screen.getByRole('button', { name: 'Impressa' }))
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Gerar prova + gabarito' })) })
      expect(open).toHaveBeenCalledTimes(1)
      const doc = new DOMParser().parseFromString(written.join(''), 'text/html')
      const sheets = [...doc.querySelectorAll('article.folha')]
      expect(sheets.length).toBeGreaterThanOrEqual(2)
      sheets.forEach((sheet) => {
        expect(sheet.querySelector('.nome-escola').textContent).toBe('Escola Técnica Centro')
        expect(sheet.querySelector('.rodape').textContent).toMatch(/Gerado por ETC em \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}/)
      })
      expect(sheets.at(-1).querySelector('.doc-titulo h1').textContent).toBe('GABARITO DO PROFESSOR')
      expect(posts('/api/admin/exam-history/add')).toHaveLength(1)
    } finally {
      open.mockRestore()
    }
  })

  it('"Versões online" vai até 4, o limite do servidor', async () => {
    await openTypedExam()
    const versions = screen.getByLabelText('Versões online')
    expect(versions).toHaveAttribute('max', '4')
    fireEvent.change(versions, { target: { value: '5' } })
    expect(versions).toHaveValue(4)
    expect(screen.getByText('Máx. 4.')).toBeInTheDocument()
  })

  it('editar a prova abre os campos do tipo e salva o mesmo modelo; questão com problema não vai ao servidor', async () => {
    await openTypedExam()
    fireEvent.click(screen.getByRole('button', { name: 'Editar conteúdo' }))
    const editor = screen.getByRole('dialog', { name: 'Editar prova' })
    expect(within(editor).getByText('Total da prova: 3,5 pontos')).toBeInTheDocument()
    const numeric = within(editor).getByRole('group', { name: 'Questão 2' })
    expect(within(numeric).getByLabelText('Resposta certa')).toHaveValue('3,5')
    expect(within(numeric).getByLabelText('Unidade (opcional)')).toHaveValue('ms')
    // Apagar o valor: a tela avisa e não envia.
    fireEvent.change(within(numeric).getByLabelText('Resposta certa'), { target: { value: '' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Salvar prova' }))
    expect(mocks.toast.error).toHaveBeenCalledWith('Questão 2: informe o valor da resposta numérica.')
    expect(mocks.put).not.toHaveBeenCalled()
    expect(within(numeric).getByRole('list', { name: 'O que falta na questão 2' })).toHaveTextContent('Informe o valor da resposta numérica.')
    fireEvent.change(within(numeric).getByLabelText('Resposta certa'), { target: { value: '3,75' } })
    await act(async () => { fireEvent.click(within(editor).getByRole('button', { name: 'Salvar prova' })) })
    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(1))
    const [url, body] = mocks.put.mock.calls[0]
    expect(url).toBe('/api/admin/evaluation/Avaliacao_1')
    expect(body.questions).toEqual([
      { type: 'multiple_choice', points: 2, text: 'Qual a **topologia**?', alternatives: [{ letter: 'A', text: 'Estrela', isCorrect: true }, { letter: 'B', text: 'Anel', isCorrect: false }], correctAnswer: 'A', explanation: '' },
      { type: 'numeric', points: 1.5, text: 'Latência média?', numeric: { value: 3.75, tolerance: 0.25, unit: 'ms' }, review: 'auto', explanation: 'Média das três.' },
    ])
  })
})

// Fase 3, A8 ajuste 1 (P3-S6, AVA-X2): corrigir o gabarito de uma aplicação encerrada muda
// também a preparação; a tela de detalhe aberta mostra o gabarito novo logo depois, e a
// conta só de consulta (Coordenação) não vê o botão.
function preparationEntry(letter) {
  const alternatives = ['A', 'B', 'C', 'D'].map((item) => ({ letter: item, displayLetter: item, text: `Alternativa ${item}`, isCorrect: item === letter }))
  return {
    id: 'hist_1', type: 'online', label: 'Online #1', questionNumbers: [1], questionCount: 1, durationMinutes: 60,
    printSnapshot: [{ version: 'A', examCode: 'A1', answerKey: { 1: letter }, questions: [{ originalNumber: 1, examNumber: 1, type: 'multiple_choice', text: 'Qual a máscara /24?', correctAnswer: letter, alternatives }] }],
  }
}

function finishedApplication(letter) {
  const entry = preparationEntry(letter)
  return { id: 'app_1', historyId: 'hist_1', status: 'finished', finishedAt: '2026-11-20T13:00:00.000Z', annulledQuestions: [], versionSnapshots: entry.printSnapshot }
}

async function openPreparation(state) {
  mocks.get.mockImplementation(async (url) => {
    if (url.startsWith('/api/admin/courses/C1/structure')) return { structure: [{ id: 'm1', name: 'Módulo 1', units: [{ avaliacaoKey: 'Avaliacao_1', name: 'Avaliação 1' }] }] }
    if (url === '/api/admin/evaluation/Avaliacao_1') return { evaluation: typedEvaluation }
    if (url.startsWith('/api/status')) return {}
    if (url.startsWith('/api/admin/exam-history')) return { history: [preparationEntry(state.letter)] }
    if (url.startsWith('/api/admin/exam-applications')) return { applications: [finishedApplication(state.letter)] }
    return {}
  })
  render(<MemoryRouter><ProvasPage /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: /Avaliação 1/ }))
  await screen.findByRole('heading', { name: 'Prova de redes' })
  fireEvent.click(await screen.findByRole('button', { name: /Online #1/ }))
  await screen.findByText('Aplicações online desta preparação')
}

describe('[UC-PROVA-005] ProvasPage do professor · gabarito corrigido depois da prova', () => {
  it('depois de corrigir, a tela de detalhe aberta mostra o gabarito novo da preparação', async () => {
    const state = { letter: 'C' }
    await openPreparation(state)
    expect(screen.getByText('Gabarito — Versão A')).toBeInTheDocument()
    const keyBadges = () => [...document.querySelectorAll('span.font-mono.text-subtle')].map((node) => `${node.textContent} ${node.nextElementSibling?.textContent}`)
    expect(keyBadges()).toEqual(['1 C'])
    mocks.post.mockImplementation(async (url, body) => {
      if (!url.endsWith('/answer-key-correction')) return { success: true }
      if (body.dryRun) return { success: true, dryRun: true, changed: 1, published: 1, question: { number: 1, antes: 'C', depois: 'B' }, students: [], preparacao: { atualizada: true, preparadas: 0, outrasAplicacoes: 0 } }
      state.letter = 'B'
      return { success: true, changed: 1, notifiedStudents: 1, preparacao: { atualizada: true, preparadas: 0, outrasAplicacoes: 0 } }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Corrigir gabarito' }))
    const dialog = screen.getByRole('dialog', { name: 'Corrigir gabarito' })
    fireEvent.click(within(dialog).getByText('Alternativa B'))
    fireEvent.change(within(dialog).getByLabelText(/^Motivo/), { target: { value: 'A certa era a B.' } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Ver impacto' })) })
    await within(dialog).findByRole('status')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Corrigir gabarito' })) })
    await waitFor(() => expect(keyBadges()).toEqual(['1 B']))
    expect(mocks.toast.success).toHaveBeenCalledWith('Gabarito corrigido. 1 nota mudou e 1 aluno foi avisado.')
  })

  // A9 (pendência do A8): a preparação excluída de "Aplicações anteriores" deixava a
  // aplicação encerrada sem caminho para corrigir o gabarito.
  it('preparação excluída: a aplicação encerrada aparece em "sem preparação salva" com "Corrigir gabarito"', async () => {
    const prepared = { id: 'app_2', historyId: 'hist_apagado', status: 'prepared', createdAt: '2026-11-21T10:00:00.000Z', versionSnapshots: [] }
    mocks.get.mockImplementation(async (url) => {
      if (url.startsWith('/api/admin/courses/C1/structure')) return { structure: [{ id: 'm1', name: 'Módulo 1', units: [{ avaliacaoKey: 'Avaliacao_1', name: 'Avaliação 1' }] }] }
      if (url === '/api/admin/evaluation/Avaliacao_1') return { evaluation: typedEvaluation }
      if (url.startsWith('/api/status')) return {}
      if (url.startsWith('/api/admin/exam-history')) return { history: [] }
      if (url.startsWith('/api/admin/exam-applications')) return { applications: [finishedApplication('C'), prepared] }
      return {}
    })
    mocks.post.mockImplementation(async (url, body) => {
      if (!url.endsWith('/answer-key-correction')) return { success: true }
      if (body.dryRun) return { success: true, dryRun: true, changed: 1, published: 0, question: { number: 1, antes: 'C', depois: 'B' }, students: [], preparacao: { atualizada: false, preparadas: 0, outrasAplicacoes: 0 } }
      return { success: true, changed: 1, notifiedStudents: 0, preparacao: { atualizada: false, preparadas: 0, outrasAplicacoes: 0 } }
    })
    render(<MemoryRouter><ProvasPage /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: /Avaliação 1/ }))
    await screen.findByRole('heading', { name: 'Prova de redes' })
    expect(await screen.findByText('Nenhuma aplicação registrada para esta turma.')).toBeInTheDocument()
    expect(await screen.findByText('Aplicações online sem preparação salva')).toBeInTheDocument()
    expect(screen.getByText(/Encerrada em/)).toBeInTheDocument()
    expect(screen.queryByText(/Preparada em/)).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Corrigir gabarito' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Corrigir gabarito' }))
    const dialog = screen.getByRole('dialog', { name: 'Corrigir gabarito' })
    fireEvent.click(within(dialog).getByText('Alternativa B'))
    fireEvent.change(within(dialog).getByLabelText(/^Motivo/), { target: { value: 'A certa era a B.' } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Ver impacto' })) })
    await within(dialog).findByRole('status')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Corrigir gabarito' })) })
    await waitFor(() => expect(posts('/api/admin/exam-applications/app_1/answer-key-correction').filter(([, body]) => !body.dryRun)).toHaveLength(1))
    expect(mocks.toast.success).toHaveBeenCalledWith('Gabarito corrigido. 1 nota mudou.')
    cleanup()

    // A Coordenação vê a lista, sem o botão.
    mocks.auth = { role: 'admin', accountRole: 'coordenacao', readOnly: true }
    render(<MemoryRouter><ProvasPage /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: /Avaliação 1/ }))
    expect(await screen.findByText('Aplicações online sem preparação salva')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Corrigir gabarito' })).not.toBeInTheDocument()
  })

  it('a Coordenação (só de consulta) vê as correções, mas não o botão "Corrigir gabarito"', async () => {
    mocks.auth = { role: 'admin', accountRole: 'coordenacao', readOnly: true }
    await openPreparation({ letter: 'C' })
    expect(screen.queryByRole('button', { name: 'Corrigir gabarito' })).not.toBeInTheDocument()
  })
})
