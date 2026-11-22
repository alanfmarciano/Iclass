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
}))

vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post, put: mocks.put } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
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
