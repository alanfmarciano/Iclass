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

describe('Provas do aluno · notas das tarefas (C18)', () => {
  it('[UC-TAREFAS-003] sem critérios, "Minhas notas" lista as tarefas devolvidas com a nota e o link para a atividade; a que não conta na média vem marcada', async () => {
    mocks.submissions = [sub('a1', { score: 70 })]
    mocks.summary = summary({
      notasPublicadas: 3, mediaFinal: 8,
      itens: [
        { id: 'Avaliacao_FUTEC_1', titulo: 'Prova 1', moduloId: null, modulo: 'Outras avaliações', nota: 7, publicada: true },
        { id: 'asg_1', titulo: 'Relatório de redes', origem: 'tarefa', tipo: 'Tarefa', moduloId: null, modulo: 'Outras avaliações', nota: 9, publicada: true },
        { id: 'asg_2', titulo: 'Exercício extra', origem: 'tarefa', tipo: 'Tarefa', moduloId: null, modulo: 'Outras avaliações', nota: 2, publicada: true, foraDaMedia: true },
        { id: 'asg_3', titulo: 'Ainda sem nota', origem: 'tarefa', tipo: 'Tarefa', moduloId: null, modulo: 'Outras avaliações', nota: null, publicada: false },
      ],
    })
    render(<MemoryRouter><ProvasPage /></MemoryRouter>)
    const heading = await screen.findByRole('heading', { name: 'Tarefas' })
    const list = heading.parentElement
    const link = within(list).getByRole('link', { name: /Relatório de redes/ })
    expect(link).toHaveAttribute('href', '/aluno/atividades/asg_1')
    expect(link.closest('li')).toHaveTextContent('9,0')
    expect(within(list).getByRole('link', { name: /Exercício extra · fora da média/ }).closest('li')).toHaveTextContent('2,0')
    expect(within(list).queryByText(/Ainda sem nota/)).not.toBeInTheDocument()
  })

  it('[UC-TAREFAS-003] sem tarefa devolvida, "Minhas notas" não ganha a lista de tarefas', async () => {
    mocks.submissions = [sub('a1', { score: 70 })]
    mocks.summary = summary({ notasPublicadas: 1, mediaFinal: 7, itens: [{ id: 'Avaliacao_FUTEC_1', titulo: 'Prova 1', moduloId: null, modulo: 'Outras avaliações', nota: 7, publicada: true }] })
    render(<MemoryRouter><ProvasPage /></MemoryRouter>)
    await screen.findByText('Melhor nota')
    expect(screen.queryByRole('heading', { name: 'Tarefas' })).not.toBeInTheDocument()
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

