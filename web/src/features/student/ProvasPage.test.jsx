import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProvasPage, { buildExamPrintHtml } from './ProvasPage'

const mocks = vi.hoisted(() => ({ post: vi.fn(), submissions: [] }))

vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: mocks.post } }))
vi.mock('./useStudent', () => ({ useStudent: () => ({ email: 'ana@x.local', studentClass: '1DES', courseId: 'DES' }) }))
vi.mock('../../hooks/useApi', () => ({
  useApi: () => ({ data: { applications: [] }, loading: false, error: null, refetch: vi.fn() }),
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
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Provas do aluno · média', () => {
  it('[UC-NOTAS-003] "Média das consideradas" usa uma nota por prova, igual ao painel e ao boletim', async () => {
    // Regra "média" com 6,0 e 8,0 (= 7,0) mais uma prova 10,0: painel e boletim dão 8,5.
    // Antes a tela fazia a média por tentativa e mostrava 8.0.
    mocks.submissions = [
      sub('a1', { score: 60, consolidatedScore: 70, policy: 'average' }),
      sub('a2', { score: 80, consolidatedScore: 70, policy: 'average', attemptNumber: 2 }),
      sub('b1', { examKey: 'Avaliacao_FUTEC_2', score: 100 }),
      sub('c1', { examKey: 'Avaliacao_FUTEC_3', score: 40, published: false }),
    ]
    render(<MemoryRouter><ProvasPage /></MemoryRouter>)
    const label = await screen.findByText('Média das consideradas')
    expect(within(label.parentElement).getByText('8,5')).toBeInTheDocument()
    expect(screen.queryByText('8.0')).not.toBeInTheDocument()
    // Média da matéria (FUTEC) pela mesma regra, e a nota em revisão com acento.
    const materia = screen.getAllByText('média').find((el) => el.classList.contains('pvb-mk'))
    expect(materia.previousSibling).toHaveTextContent('8,5')
    expect(screen.getByText('Em revisão')).toBeInTheDocument()
    expect(screen.getByText('Melhor nota').parentElement).toHaveTextContent('10,0')
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
