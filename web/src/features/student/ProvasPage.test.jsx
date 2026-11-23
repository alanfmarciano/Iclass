import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProvasPage, { buildExamPrintHtml, gradesByStage, openExamPrintWindow, sectionsFromSummary } from './ProvasPage'

const mocks = vi.hoisted(() => ({ post: vi.fn(), submissions: [], summary: null, paths: [] }))

vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: mocks.post } }))
vi.mock('./useStudent', () => ({ useStudent: () => ({ email: 'ana@x.local', studentClass: '1DES', courseId: 'DES' }) }))
vi.mock('../../hooks/useApi', () => ({
  useApi: (path) => {
    mocks.paths.push(path)
    if (path && path.startsWith('/api/student/grades-summary')) return { data: mocks.summary, loading: false, error: mocks.summaryError || null, refetch: vi.fn(), pollNow: vi.fn() }
    return { data: { applications: [] }, loading: false, error: null, refetch: vi.fn() }
  },
}))
vi.mock('../../components/ui/MiniLineChart', () => ({ MiniLineChart: () => null }))

// Registro como /api/student/my-submissions devolve (consolidatedScore só das publicadas).
function sub(id, { examKey = 'Avaliacao_FUTEC_1', score, consolidatedScore = score, published = true, attemptNumber = 1, policy = 'highest', counts = true, applicationId = null } = {}) {
  return {
    id, examKey, examTitle: examKey.replace(/_/g, ' '), score, applicationId, attemptNumber, type: 'impressa',
    gradePublished: published, consolidatedScore: published ? consolidatedScore : null, countsTowardResult: published && counts,
    aggregationPolicy: policy, resultStatus: 'considered', timestamp: `2026-03-0${attemptNumber}T12:00:00.000Z`,
  }
}

beforeEach(() => {
  // Sem animação do contador: o valor final aparece direto.
  window.matchMedia = vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  mocks.post.mockImplementation(async () => ({ submissions: mocks.submissions }))
  mocks.summary = null
  mocks.summaryError = null
  mocks.paths = []
})

// Resumo de notas como GET /api/student/grades-summary devolve (só o publicado).
function summary(extra = {}) {
  return {
    courseId: 'DES', studentClass: '1DES', criterio: { mediaMinima: 6, mencoes: null, regraAntiga: true }, regraAntiga: true,
    etapas: [], modulos: [], itens: [], mediaFinal: null, recuperacaoFinal: null, situacao: null, situacaoRotulo: null, mencao: null,
    situacaoPorDisciplina: [], frequencia: null, frequenciaMinima: null, aulasPrevistas: null, faltasPermitidasRestantes: null,
    periodoLetivo: null, notasPublicadas: 0, mediaMinimaTexto: '6,0', ...extra,
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Provas do aluno · média', () => {
  it('[UC-NOTAS-003] a média e a média do módulo vêm do resumo de notas do servidor, sem conta no navegador', async () => {
    // Antes a tela fazia a média (consolidatedAverage) com as entregas. Agora mostra a
    // média do servidor, a mesma do boletim e do Início: 8,5 aqui mesmo que as entregas
    // dessem outra conta, e a nota ainda não publicada fica em "Notas em revisão".
    mocks.submissions = [
      sub('a1', { score: 60, consolidatedScore: 70, policy: 'average' }),
      sub('a2', { score: 80, consolidatedScore: 70, policy: 'average', attemptNumber: 2 }),
      sub('b1', { examKey: 'Avaliacao_FUTEC_2', score: 100 }),
      sub('c1', { examKey: 'Avaliacao_FUTEC_3', score: 40, published: false }),
    ]
    mocks.summary = summary({
      mediaFinal: 8.5, notasPublicadas: 2,
      modulos: [{ id: 'm1', nome: 'Fundamentos', media: 8.5 }],
      itens: [
        { id: 'Avaliacao_FUTEC_1', titulo: 'Prova 1', moduloId: 'm1', modulo: 'Fundamentos', nota: 7, publicada: true },
        { id: 'Avaliacao_FUTEC_2', titulo: 'Prova 2', moduloId: 'm1', modulo: 'Fundamentos', nota: 10, publicada: true },
      ],
    })
    render(<MemoryRouter><ProvasPage /></MemoryRouter>)
    expect(mocks.paths).toContain('/api/student/grades-summary?courseId=DES&studentClass=1DES')
    const label = await screen.findByText('Média geral', { selector: 'p' })
    expect(await within(label.parentElement).findByText('8,5')).toBeInTheDocument()
    expect(screen.queryByText('8.0')).not.toBeInTheDocument()
    // Seção pelo módulo da estrutura (não pelo prefixo FUTEC), com a média do servidor.
    expect(screen.getAllByText('Fundamentos').length).toBeGreaterThan(0)
    expect(screen.queryByText('FUTEC')).not.toBeInTheDocument()
    const materia = screen.getAllByText('média').find((el) => el.classList.contains('pvb-mk'))
    expect(materia.previousSibling).toHaveTextContent('8,5')
    expect(screen.getAllByText('Notas em revisão').length).toBeGreaterThan(0)
    expect(screen.getByText('Em revisão')).toBeInTheDocument()
    expect(screen.getByText('Melhor nota').parentElement).toHaveTextContent('10,0')
  })

  it('[UC-NOTAS-008] "Minhas notas": média final, situação, menção e notas por etapa do servidor, com a média mínima do curso', async () => {
    mocks.submissions = [sub('a1', { score: 85, examKey: 'man_1795397447192_410b1b' })]
    mocks.submissions[0].examTitle = 'Seminário'
    mocks.summary = summary({
      regraAntiga: false, criterio: { mediaMinima: 7, mencoes: [{ sigla: 'B', nome: 'Bom', min: 7 }], regraAntiga: false },
      mediaMinimaTexto: '7,0', notasPublicadas: 1, mediaFinal: 8.5, situacao: 'cursando', situacaoRotulo: 'Cursando', mencao: { sigla: 'B', nome: 'Bom' },
      frequencia: 92, faltasPermitidasRestantes: 6,
      etapas: [
        { ordem: 1, nome: '1º bimestre', peso: 1, media: null, recuperacao: null, final: null, semNota: true },
        { ordem: 2, nome: '2º bimestre', peso: 2, media: 8.5, recuperacao: null, final: 8.5, semNota: false },
      ],
      situacaoPorDisciplina: [
        { id: 'd1', nome: 'Redes', mediaFinal: 8.5, situacao: 'cursando', situacaoRotulo: 'Cursando', mencao: null },
        { id: 'd2', nome: 'Lógica', mediaFinal: null, situacao: 'sem_notas', situacaoRotulo: 'Sem notas', mencao: null },
      ],
      itens: [{ id: 'man_1795397447192_410b1b', titulo: 'Seminário', origem: 'manual', moduloId: null, modulo: 'Outras avaliações', disciplinaId: 'd1', disciplina: 'Redes', etapa: 2, nota: 8.5, publicada: true }],
    })
    render(<MemoryRouter><ProvasPage /></MemoryRouter>)
    const card = (await screen.findByRole('heading', { name: 'Minhas notas' })).closest('section')
    expect(within(card).getByText('Média final').nextSibling).toHaveTextContent('8,5')
    expect(within(card).getAllByText('Cursando').length).toBeGreaterThan(0)
    expect(within(card).getByText('Menção').nextSibling).toHaveTextContent('B')
    // Etapas em acordeão: a etapa mostra a nota e, tocada, as avaliações publicadas dela.
    const etapa1 = within(card).getByRole('button', { name: /1º bimestre/ })
    const etapa2 = within(card).getByRole('button', { name: /2º bimestre/ })
    expect(etapa1).toHaveTextContent('Sem nota')
    expect(etapa2).toHaveTextContent('8,5')
    expect(etapa2).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(etapa2)
    expect(etapa2).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById(etapa2.getAttribute('aria-controls'))).toHaveTextContent('Seminário')
    fireEvent.click(etapa1)
    expect(document.getElementById(etapa1.getAttribute('aria-controls'))).toHaveTextContent('Nenhuma avaliação com nota publicada nesta etapa ainda.')
    // Nenhum texto do cartão abaixo de 14 px (text-sm).
    expect(card.innerHTML).not.toMatch(/text-\[1[0-3]px\]|text-xs/)
    expect(card).toHaveTextContent('Média mínima para aprovação: 7,0.')
    expect(card).toHaveTextContent('Você ainda pode ter 6 faltas no período.')
    expect(within(card).getByText('Lógica')).toBeInTheDocument()
    // A avaliação da turma fica na seção da disciplina (Redes), pelo título.
    expect(screen.getAllByText('Redes').length).toBeGreaterThan(1)
    expect(document.body.textContent).not.toMatch(/man[ _]1795/)
  })

  it('[UC-NOTAS-008] etapas: a recuperação entra na etapa que recupera, a final e o que não conta ficam à parte', () => {
    const grupos = gradesByStage(summary({
      regraAntiga: false,
      etapas: [{ ordem: 1, nome: '1º bimestre', peso: 1 }, { ordem: 2, nome: '2º bimestre', peso: 2 }],
      itens: [
        { id: 'P1', titulo: 'Prova 1', etapa: 1, nota: 5, publicada: true, recuperacaoDe: null },
        { id: 'R1', titulo: 'Recuperação 1', etapa: null, nota: 8, publicada: true, recuperacao: true, recuperacaoDe: 'etapa:1' },
        { id: 'P2', titulo: 'Prova 2', etapa: 2, nota: null, publicada: false, recuperacaoDe: null },
        { id: 'RF', titulo: 'Recuperação final', etapa: null, nota: 7, publicada: true, recuperacao: true, recuperacaoDe: 'final' },
        { id: 'Q', titulo: 'Quiz', etapa: null, nota: 9, publicada: true, recuperacaoDe: null },
        { id: 'N', titulo: 'Não conta', etapa: 2, nota: 6, publicada: true, foraDaMedia: true, recuperacaoDe: null },
      ],
    }))
    expect(grupos.porEtapa.get(1).map((item) => item.id)).toEqual(['P1', 'R1'])
    expect(grupos.porEtapa.get(2)).toEqual([])
    expect(grupos.final.map((item) => item.id)).toEqual(['RF'])
    expect(grupos.fora.map((item) => item.id)).toEqual(['Q', 'N'])
  })

  it('[UC-NOTAS-008] nota publicada de avaliação arquivada fica em "Outras avaliações", e sem o resumo nada vira "Notas em revisão"', async () => {
    // Antes do ajuste: o resumo não traz a avaliação arquivada, e a nota publicada dela caía
    // em "Notas em revisão" (que é das notas ainda não publicadas).
    const sectionOf = sectionsFromSummary(summary({ itens: [{ id: 'Avaliacao_FUTEC_1', moduloId: 'm1', modulo: 'Fundamentos', nota: 7, publicada: true }], modulos: [{ id: 'm1', nome: 'Fundamentos', media: 7 }] }))
    expect(sectionOf({ examKey: 'man_arquivada', gradePublished: true }).name).toBe('Outras avaliações')
    expect(sectionOf({ examKey: 'Avaliacao_FUTEC_9', gradePublished: false }).name).toBe('Notas em revisão')
    expect(sectionOf('Avaliacao_FUTEC_1').name).toBe('Fundamentos')
    expect(sectionsFromSummary(null)({ examKey: 'Avaliacao_FUTEC_1', gradePublished: true }).name).toBe('Avaliações')

    mocks.submissions = [
      sub('a1', { score: 70 }),
      { ...sub('m1', { examKey: 'man_1795397447192_410b1b', score: 85, counts: false }), examTitle: 'Seminário', assessmentArchived: true },
    ]
    mocks.summary = summary({
      notasPublicadas: 1, mediaFinal: 7,
      modulos: [{ id: 'm1', nome: 'Fundamentos', media: 7 }],
      itens: [{ id: 'Avaliacao_FUTEC_1', titulo: 'Prova 1', moduloId: 'm1', modulo: 'Fundamentos', nota: 7, publicada: true }],
    })
    render(<MemoryRouter><ProvasPage /></MemoryRouter>)
    expect(await screen.findByText('Avaliação arquivada · fora da média')).toBeInTheDocument()
    expect(screen.getAllByText('Outras avaliações').length).toBeGreaterThan(0)
    expect(screen.queryByText('Notas em revisão')).not.toBeInTheDocument()
  })

  it('[UC-NOTAS-008] resumo de notas com erro: aviso com "Tentar de novo" e as provas sem "Notas em revisão"', async () => {
    mocks.submissions = [sub('a1', { score: 70 })]
    mocks.summary = null
    mocks.summaryError = new Error('falhou')
    render(<MemoryRouter><ProvasPage /></MemoryRouter>)
    expect(await screen.findByText(/Não deu para carregar o resumo das suas notas agora/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeInTheDocument()
    expect((await screen.findAllByText(/Avaliacao FUTEC 1/)).length).toBeGreaterThan(0)
    expect(screen.queryByText('Notas em revisão')).not.toBeInTheDocument()
  })

  it('[UC-NOTAS-008] sem nota publicada, "Minhas notas" diz que ainda não há nota', async () => {
    mocks.submissions = [sub('c1', { score: 40, published: false })]
    mocks.summary = summary()
    render(<MemoryRouter><ProvasPage /></MemoryRouter>)
    const card = (await screen.findByRole('heading', { name: 'Minhas notas' })).closest('section')
    expect(card).toHaveTextContent('Nenhuma nota publicada ainda.')
    expect(card).toHaveTextContent('Média mínima para aprovação: 6,0.')
  })
})

describe('Provas do aluno · avaliação manual da turma', () => {
  it('[UC-NOTAS-006] a avaliação manual aparece pelo título, na seção do resumo, nunca pelo id', async () => {
    // Antes a tela mostrava "man 1795397447192 410b1b" no gráfico, no destaque e no filtro "MAN".
    mocks.submissions = [
      sub('a1', { score: 70 }),
      { ...sub('m1', { examKey: 'man_1795397447192_410b1b', score: 95 }), examTitle: 'Seminário de redes', type: 'manual' },
    ]
    mocks.summary = summary({
      notasPublicadas: 2, mediaFinal: 8.3,
      modulos: [{ id: 'm1', nome: 'Fundamentos', media: 7 }, { id: '__outras__', nome: 'Outras avaliações', media: 9.5 }],
      itens: [
        { id: 'Avaliacao_FUTEC_1', titulo: 'Prova 1', moduloId: 'm1', modulo: 'Fundamentos', nota: 7, publicada: true },
        { id: 'man_1795397447192_410b1b', titulo: 'Seminário de redes', origem: 'manual', moduloId: null, modulo: 'Outras avaliações', nota: 9.5, publicada: true },
      ],
    })
    render(<MemoryRouter><ProvasPage /></MemoryRouter>)
    const best = (await screen.findByText('Melhor nota')).parentElement
    expect(best).toHaveTextContent('Seminário d…')
    expect(screen.getAllByText(/Seminário de redes/).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Outras avaliações').length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toMatch(/man[ _]1795/)
    expect(screen.queryByText('MAN')).not.toBeInTheDocument()
  })
})

describe('Provas do aluno · avaliação manual arquivada', () => {
  it('[UC-NOTAS-006] nota de avaliação arquivada aparece fora da média, igual ao Início e ao boletim', async () => {
    // my-submissions marca a entrega da avaliação arquivada (assessmentArchived, sem nota
    // consolidada e fora do resultado); a média é a do resumo do servidor (6,0), que já
    // deixa a arquivada de fora. Antes a tela chegou a mostrar 7,3.
    mocks.submissions = [
      sub('a1', { score: 60 }),
      {
        ...sub('m1', { examKey: 'man_1795397447192_410b1b', score: 100, counts: false }),
        consolidatedScore: null, assessmentArchived: true, examTitle: 'Seminário de redes', type: 'manual',
      },
    ]
    mocks.summary = summary({ notasPublicadas: 1, mediaFinal: 6, itens: [{ id: 'Avaliacao_FUTEC_1', titulo: 'Prova 1', moduloId: null, modulo: 'Outras avaliações', nota: 6, publicada: true }] })
    render(<MemoryRouter><ProvasPage /></MemoryRouter>)
    const label = await screen.findByText('Média geral', { selector: 'p' })
    expect(await within(label.parentElement).findByText('6,0')).toBeInTheDocument()
    expect(screen.getByText('Avaliação arquivada · fora da média')).toBeInTheDocument()
    expect(screen.queryByText('7,3')).not.toBeInTheDocument()
    // Fora também da melhor nota (6,0, e não o 10,0 arquivado).
    expect(screen.getByText('Melhor nota').parentElement).toHaveTextContent('6,0')
  })
})

describe('Provas do aluno · distribuição por faixa', () => {
  it('[UC-NOTAS-003] faixas de nota com vírgula decimal, sem ponto', async () => {
    // Antes os rótulos eram '7-8.9', '6-6.9' e '0-5.9'.
    mocks.submissions = [
      sub('a1', { score: 95 }),
      sub('b1', { examKey: 'Avaliacao_FUTEC_2', score: 75 }),
      sub('c1', { examKey: 'Avaliacao_FUTEC_3', score: 50 }),
    ]
    render(<MemoryRouter><ProvasPage /></MemoryRouter>)
    const card = (await screen.findByText('Por faixa de nota')).parentElement
    for (const label of ['9–10', '7–8,9', '6–6,9', '0–5,9']) expect(within(card).getByText(label)).toBeInTheDocument()
    expect(card.textContent).not.toMatch(/\d\.\d/)
  })

  it('[UC-TENTATIVA-003] a barra conta a nota como ela aparece no cartão (gradeBand), não a nota crua', async () => {
    // 59,6 aparece como 6,0 em amarelo (suficiente): antes entrava na barra vermelha
    // "0–5,9". 89,6 aparece como 9,0 e entra em "9–10".
    mocks.submissions = [
      sub('a1', { score: 59.6 }),
      sub('b1', { examKey: 'Avaliacao_FUTEC_2', score: 89.6 }),
      sub('c1', { examKey: 'Avaliacao_FUTEC_3', score: 30 }),
    ]
    render(<MemoryRouter><ProvasPage /></MemoryRouter>)
    const card = (await screen.findByText('Por faixa de nota')).parentElement
    const count = (label) => within(card).getByText(label).parentElement.lastChild.textContent
    expect(await within(card).findByText('9–10')).toBeInTheDocument()
    expect(count('9–10')).toBe('1')
    expect(count('7–8,9')).toBe('0')
    expect(count('6–6,9')).toBe('1')
    expect(count('0–5,9')).toBe('1')
    // A cor do cartão e a da barra são da mesma faixa.
    expect(within(card).getByText('6–6,9').parentElement.querySelector('.bg-warning')).not.toBeNull()
  })
})

describe('Provas do aluno · impressão da prova', () => {
  it('[UC-NOTAS-003] a nota impressa sai com vírgula e a questão com acento', () => {
    // Antes a impressão mostrava "Nota 7.5".
    const detail = { gradePublished: true, score: 75, correctCount: 3, totalCount: 4, examKey: 'Avaliacao_FUTEC_1', assignedVersion: 'A' }
    const questions = [{ number: 1, text: 'Enunciado', alternatives: [{ letter: 'A', text: 'Um' }, { letter: 'B', text: 'Dois' }] }]
    const answers = new Map([[1, { studentChoice: 'B', correctAnswer: 'B', isCorrect: true }]])
    const html = buildExamPrintHtml(detail, questions, answers)
    expect(html).toContain('<span>Nota</span><b>7,5</b>')
    expect(html).not.toContain('7.5')
    expect(html).toContain('Questão 1')
    // Nota não publicada nunca aparece na impressão.
    expect(buildExamPrintHtml({ ...detail, gradePublished: false }, questions, answers)).toContain('<span>Nota</span><b>—</b>')
  })
})

// H5d (SEG-16): a janela de impressão (about:blank) herda a CSP do IClass, com
// script-src 'self'. O <script>window.onload=...print()</script> que ia dentro do HTML
// era bloqueado e a impressão do aluno não abria; agora quem chama print() é a janela
// de origem, como nas impressões do professor.
describe('Provas do aluno · impressão sem script (CSP)', () => {
  const detail = { gradePublished: true, score: 75, correctCount: 3, totalCount: 4, examKey: 'Avaliacao_FUTEC_1', assignedVersion: 'A' }
  const questions = [{ number: 1, text: 'Enunciado', alternatives: [{ letter: 'A', text: 'Um' }, { letter: 'B', text: 'Dois' }] }]
  const answers = new Map([[1, { studentChoice: 'B', correctAnswer: 'B', isCorrect: true }]])

  function fakeWindow(readyState) {
    const listeners = {}
    const written = []
    return {
      written,
      listeners,
      print: vi.fn(),
      focus: vi.fn(),
      addEventListener: vi.fn((name, fn) => { listeners[name] = fn }),
      document: { readyState, open: vi.fn(), write: vi.fn(html => written.push(html)), close: vi.fn() },
    }
  }

  afterEach(() => vi.useRealTimers())

  it('[UC-SEC-002] o HTML da impressão não tem script nem manipulador inline', () => {
    const html = buildExamPrintHtml(detail, questions, answers)
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/\son[a-z]+\s*=/i)
    // O estilo inline continua (style-src 'unsafe-inline' na CSP).
    expect(html).toMatch(/<style>/)
  })

  it('[UC-SEC-002] a janela de origem escreve o HTML e chama print() uma vez', () => {
    vi.useFakeTimers()
    const win = fakeWindow('complete')
    const open = vi.fn(() => win)
    expect(openExamPrintWindow('<html><body>prova</body></html>', open)).toBe(true)
    expect(open).toHaveBeenCalledWith('', '_blank')
    expect(win.written).toEqual(['<html><body>prova</body></html>'])
    expect(win.document.close).toHaveBeenCalled()
    expect(win.print).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(win.focus).toHaveBeenCalled()
    expect(win.print).toHaveBeenCalledTimes(1)
  })

  it('[UC-SEC-002] documento ainda carregando: imprime no load, uma vez só', () => {
    vi.useFakeTimers()
    const win = fakeWindow('loading')
    expect(openExamPrintWindow('<html></html>', () => win)).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(win.print).not.toHaveBeenCalled()
    win.listeners.load()
    win.listeners.load()
    vi.advanceTimersByTime(300)
    expect(win.print).toHaveBeenCalledTimes(1)
  })

  it('[UC-SEC-002] pop-up bloqueado: devolve false sem erro', () => {
    expect(openExamPrintWindow('<html></html>', () => null)).toBe(false)
  })
})


// A18 (P3-S4b: AVA-07, UXA-17): a revisão do aluno com os tipos novos. Entregas como
// sanitizeSubmissionForStudent devolve: aguardandoCorrecao, anulada, comentarioGeral e,
// com o gabarito liberado, examQuestions com tipo, pontos, explicação e rubrica.
function reviewed(extra = {}) {
  return {
    ...sub('r1', { score: 75, published: true }),
    answerKeyReleased: true, assignedVersion: 'A', correctCount: 1, totalCount: 3,
    examQuestions: [
      { number: 1, type: 'multiple_choice', text: 'Qual a **camada** de rede?', points: 1, explanation: 'A camada 3 é a de **rede**.', alternatives: [{ letter: 'A', text: 'Física' }, { letter: 'B', text: 'Rede' }] },
      { number: 2, type: 'multiple_answer', text: 'Quais são protocolos?', points: 2, alternatives: [{ letter: 'A', text: 'TCP' }, { letter: 'B', text: 'HTML' }, { letter: 'C', text: 'UDP' }] },
      { number: 3, type: 'essay', text: 'Explique o modelo OSI.', points: 2, rubric: [{ id: 'c1', nome: 'Camadas', pontos: 1 }, { id: 'c2', nome: 'Exemplos', pontos: 1 }] },
    ],
    gradedAnswers: [
      { questionNumber: 1, type: 'multiple_choice', studentChoice: 'A', correctAnswer: 'B', isCorrect: false, pointsEarned: 0, pointsPossible: 1 },
      { questionNumber: 2, type: 'multiple_answer', studentChoices: ['A'], correctAnswers: ['A', 'C'], isCorrect: false, pointsEarned: 1, pointsPossible: 2 },
      { questionNumber: 3, type: 'essay', studentResponse: 'Sete camadas, da física à aplicação.', isCorrect: false, pointsEarned: 1.5, pointsPossible: 2, comentario: 'Faltou dar exemplos.', rubrica: { c1: 1, c2: 0.5 } },
    ],
    ...extra,
  }
}

async function openDetail(submission) {
  mocks.submissions = [submission]
  render(<MemoryRouter><ProvasPage /></MemoryRouter>)
  const card = (await screen.findAllByText(/Avaliacao FUTEC 1/)).map((el) => el.closest('button')).find(Boolean)
  fireEvent.click(card)
  return screen.findByRole('dialog')
}

describe('Provas do aluno · revisão corrigida (A18)', () => {
  it('[UC-CORRECAO-001] dissertativa corrigida mostra os pontos, a rubrica e o comentário, nunca "Errada"', async () => {
    // Antes a dissertativa aparecia sempre como "Errada" e a resposta escrita sumia.
    const dialog = await openDetail(reviewed())
    const essay = within(dialog).getByText('Explique o modelo OSI.').closest('li')
    expect(within(essay).getByText('1,5 de 2 pontos')).toBeInTheDocument()
    expect(within(essay).queryByText('Errada')).not.toBeInTheDocument()
    expect(within(essay).getByText('Sete camadas, da física à aplicação.')).toBeInTheDocument()
    expect(within(essay).getByText('Faltou dar exemplos.')).toBeInTheDocument()
    expect(within(essay).getByText('Camadas').parentElement).toHaveTextContent('1 de 1 ponto')
    expect(within(essay).getByText('Exemplos').parentElement).toHaveTextContent('0,5 de 1 ponto')
    // Várias corretas com crédito parcial e as duas certas marcadas.
    const multi = within(dialog).getByText('Quais são protocolos?').closest('li')
    expect(within(multi).getByText('Parcial · 1 de 2 pontos')).toBeInTheDocument()
    expect(within(multi).getAllByText(/Resposta correta|Sua resposta · Correta/)).toHaveLength(2)
    // Enunciado e explicação em Markdown.
    const first = within(dialog).getByText('camada', { selector: 'strong' }).closest('li')
    expect(within(first).getByText('Explicação')).toBeInTheDocument()
    expect(within(first).getByText('rede', { selector: 'strong' })).toBeInTheDocument()
  })

  it('[UC-LAYOUT-001] a etiqueta "Sua resposta · Correta" fica numa linha própria, abaixo da alternativa', async () => {
    // No celular de 375 px a etiqueta ao lado espremia o texto da alternativa.
    const dialog = await openDetail(reviewed())
    const tag = within(dialog).getByText('Sua resposta · Correta')
    expect(tag.className).toContain('basis-full')
    expect(tag.parentElement.className).toContain('flex-wrap')
  })

  it('[UC-CORRECAO-001] entrega aguardando o professor diz "Aguardando correção", com o comentário geral', async () => {
    const dialog = await openDetail(reviewed({
      gradePublished: false, score: null, consolidatedScore: null, countsTowardResult: false, aguardandoCorrecao: true,
      answerKeyReleased: false, examQuestions: undefined, comentarioGeral: null,
      gradedAnswers: [
        { questionNumber: 1, type: 'multiple_choice', studentChoice: 'A' },
        { questionNumber: 3, type: 'essay', studentResponse: 'Texto do aluno', isCorrect: null, pending: true },
      ],
    }))
    expect(within(dialog).getByText('Aguardando correção do professor')).toBeInTheDocument()
    expect(within(dialog).getByText(/A nota aparece quando ele terminar a correção/)).toBeInTheDocument()
    expect(within(dialog).queryByText('Em revisão')).not.toBeInTheDocument()
    expect(within(dialog).getByText('Texto do aluno')).toBeInTheDocument()
  })

  it('[UC-CORRECAO-001] nota publicada sem gabarito: a numérica aparece com a unidade e sem repetir a digitada', async () => {
    // Antes, sem o gabarito, a tabela mostrava "3,5" (a unidade vinha só com as questões).
    const dialog = await openDetail(reviewed({
      answerKeyReleased: false, examQuestions: undefined, comentarioGeral: 'Bom trabalho.',
      gradedAnswers: [
        { questionNumber: 1, type: 'numeric', unit: 'ms', studentChoice: null, studentResponse: '3.5' },
        { questionNumber: 2, type: 'numeric', unit: 'ms', studentChoice: null, studentResponse: '4 ms' },
      ],
    }))
    const rows = within(dialog).getAllByRole('row')
    expect(rows[1]).toHaveTextContent('3,5 ms')
    expect(rows[2]).toHaveTextContent('4 ms')
    expect(rows[2]).not.toHaveTextContent('ms ms')
    expect(within(dialog).getByText('Bom trabalho.')).toBeInTheDocument()
  })

  it('[UC-CORRECAO-001] tentativa anulada diz que foi anulada, e o comentário geral do professor aparece', async () => {
    const dialog = await openDetail(reviewed({ anulada: 'zero', comentarioGeral: 'Conversamos na aula sobre a consulta.' }))
    expect(within(dialog).getByText(/O professor anulou esta tentativa e ela vale zero/)).toBeInTheDocument()
    expect(within(dialog).getByText('Conversamos na aula sobre a consulta.').previousSibling).toHaveTextContent('Comentário do professor')
  })

  it('[UC-CORRECAO-001] o cartão da prova diz por que a nota ainda não saiu', async () => {
    mocks.submissions = [
      { ...sub('p1', { published: false, score: null }), aguardandoCorrecao: true },
      { ...sub('p2', { examKey: 'Avaliacao_FUTEC_2', published: false, score: null }), anulada: 'desconsiderar' },
    ]
    render(<MemoryRouter><ProvasPage /></MemoryRouter>)
    expect(await screen.findByText('Aguardando correção do professor')).toBeInTheDocument()
    expect(screen.getByText('Tentativa anulada: não conta')).toBeInTheDocument()
  })

  it('[UC-CORRECAO-001] com o gabarito liberado, a numérica e a resposta curta erradas mostram a resposta correta', async () => {
    // Antes (ajuste 2 do A18): "Errada" e "-" na coluna Correta, sem o valor certo.
    const detail = reviewed({
      examQuestions: [
        { number: 1, type: 'numeric', text: 'Latência medida?', points: 1, unit: 'ms', answerKeyText: '3,5 (± 0,1) ms', alternatives: [] },
        { number: 2, type: 'short_answer', text: 'Protocolo confiável?', points: 1, answerKeyText: 'TCP ou Transmission Control Protocol', alternatives: [] },
        { number: 3, type: 'essay', text: 'Explique o modelo OSI.', points: 2, alternatives: [] },
      ],
      gradedAnswers: [
        { questionNumber: 1, type: 'numeric', studentResponse: '9', isCorrect: false, pointsEarned: 0, pointsPossible: 1 },
        { questionNumber: 2, type: 'short_answer', studentResponse: 'udp', isCorrect: false, pointsEarned: 0, pointsPossible: 1 },
        { questionNumber: 3, type: 'essay', studentResponse: 'Sete camadas.', isCorrect: false, pointsEarned: 1, pointsPossible: 2 },
      ],
    })
    const dialog = await openDetail(detail)
    const numeric = within(dialog).getByText('Latência medida?').closest('li')
    expect(within(numeric).getByText('3,5 (± 0,1) ms').parentElement).toHaveTextContent('Resposta correta: 3,5 (± 0,1) ms')
    const short = within(dialog).getByText('Protocolo confiável?').closest('li')
    expect(within(short).getByText('TCP ou Transmission Control Protocol')).toBeInTheDocument()
    const essay = within(dialog).getByText('Explique o modelo OSI.').closest('li')
    expect(within(essay).queryByText(/Resposta correta:/)).not.toBeInTheDocument()
    const rows = within(dialog).getAllByRole('row')
    expect(rows[1]).toHaveTextContent('3,5 (± 0,1) ms')
    expect(rows[2]).toHaveTextContent('TCP ou Transmission Control Protocol')
    expect(within(rows[3]).getAllByRole('cell')[2]).toHaveTextContent('-')
    // A impressão também.
    const html = buildExamPrintHtml(detail, detail.examQuestions, new Map(detail.gradedAnswers.map((a) => [a.questionNumber, a])))
    expect(html).toContain('<td>3,5 (± 0,1) ms</td>')
    expect(html).toContain('Resposta correta: TCP ou Transmission Control Protocol')
  })

  it('[UC-CORRECAO-001] a impressão traz a resposta escrita, os pontos, o comentário e a explicação', () => {
    const detail = reviewed({ comentarioGeral: 'Bom trabalho.' })
    const answers = new Map(detail.gradedAnswers.map((a) => [a.questionNumber, a]))
    const html = buildExamPrintHtml(detail, detail.examQuestions, answers)
    expect(html).toContain('Sete camadas, da física à aplicação.')
    expect(html).toContain('1,5 de 2 pontos')
    expect(html).toContain('Faltou dar exemplos.')
    expect(html).toContain('<b>Explicação:</b>')
    expect(html).toContain('Bom trabalho.')
    expect(html).toContain('<td>2</td><td>A</td><td>A e C</td><td>Parcial · 1 de 2 pontos</td>')
    expect(html).not.toContain('<td>3</td><td>Resposta escrita</td><td>-</td><td>Errada</td>')
  })
})
