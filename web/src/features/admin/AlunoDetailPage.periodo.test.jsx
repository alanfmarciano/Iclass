import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AlunoDetailPage, { notePeriodOf } from './AlunoDetailPage'

// Ficha do aluno: a "Evolução das notas" filtra por período letivo (B8 / P2-S8, FUN-05).
// O servidor manda periodoLetivo em cada entrega (GET /api/admin/student/academic) quando
// a data dela cai dentro do período da turma; a entrega sem período continua no semestre
// do calendário. Antes o seletor era só "2026.1"/"2026.2", pelo mês da entrega.
const mocks = vi.hoisted(() => ({ get: vi.fn(), academic: null }))

vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: vi.fn() } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: { accountRole: 'admin' } }) }))
vi.mock('../../hooks/useAdminWorkspace', () => ({ useAdminWorkspace: () => ({ courseId: 'DES', courseName: 'Técnico', className: '1DES' }) }))
vi.mock('../../components/ui/MonthCalendar', () => ({ MonthCalendar: () => null }))
// O gráfico vira uma lista com os rótulos e as notas, para conferir o filtro.
vi.mock('../../components/ui/MiniLineChart', () => ({
  MiniLineChart: ({ points }) => <ul aria-label="Pontos do gráfico">{points.map((point, index) => <li key={index}>{`${point.label}=${point.value}`}</li>)}</ul>,
}))
vi.mock('../../hooks/useApi', () => ({
  useApi: () => ({ data: [{ id: 'alu_0123456789abcdef', name: 'Bia', email: 'bia@x.local', status: 'Ativo', classes: [{ name: '1DES', courseId: 'DES' }] }], loading: false, error: null, refetch: vi.fn() }),
}))

const TERM = { id: 'per_1', nome: '2027 · 1º semestre', inicio: '2027-02-01', fim: '2027-07-09' }
const sub = (id, examKey, score, timestamp, periodoLetivo = null) => ({ id, examKey, score, timestamp, gradePublished: true, periodoLetivo })

beforeEach(() => {
  mocks.academic = {
    submissions: [
      sub('s3', 'Avaliacao_REDES_2', 90, '2027-05-10T12:00:00.000Z', TERM),
      sub('s2', 'Avaliacao_REDES_1', 70, '2027-03-10T12:00:00.000Z', TERM),
      sub('s1', 'Avaliacao_LOGI_1', 50, '2026-10-01T12:00:00.000Z'),
    ],
    progress: { completedCount: 0 }, moduleAccess: [], attendance: { count: 0, recent: [] }, certificates: [],
  }
  mocks.get.mockImplementation(async (path) => {
    if (path.startsWith('/api/admin/student/academic')) return mocks.academic
    if (path.startsWith('/api/admin/student/dashboard')) return { kpis: { media: 7, provasFeitas: 3, provasTotais: 3, frequencia: 90, progresso: 10 }, comparativo: {}, risco: { level: 'baixo', reasons: [] }, engajamento: { weeks: [] }, streak: {}, temporal: {}, modulos: [] }
    return []
  })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/alunos/alu_0123456789abcdef']}>
      <Routes><Route path="/alunos/:id" element={<AlunoDetailPage />} /></Routes>
    </MemoryRouter>,
  )
}

describe('Ficha do aluno · filtro por período letivo', () => {
  it('[UC-CURSO-002] notePeriodOf: o período letivo quando vem; senão o semestre do calendário', () => {
    expect(notePeriodOf(sub('a', 'x', 1, '2027-03-10T12:00:00.000Z', TERM))).toMatchObject({ key: 'per:per_1', label: '2027 · 1º semestre', sort: '2027-02-01', term: true })
    expect(notePeriodOf(sub('b', 'x', 1, '2026-10-01T12:00:00.000Z'))).toMatchObject({ key: 'sem:2026.2', label: '2026.2', sort: '2026-07-01', term: false })
  })

  it('[UC-CURSO-002] o seletor lista os períodos na ordem das datas e filtra as notas do gráfico', async () => {
    const user = userEvent.setup()
    renderPage()
    const select = await screen.findByLabelText('Filtrar por período letivo')
    expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual(['Todos os períodos', '2026.2', '2027 · 1º semestre'])
    expect(within(screen.getByRole('list', { name: 'Pontos do gráfico' })).getAllByRole('listitem')).toHaveLength(3)
    await user.selectOptions(select, 'per:per_1')
    const points = within(screen.getByRole('list', { name: 'Pontos do gráfico' })).getAllByRole('listitem').map(item => item.textContent)
    expect(points).toEqual(['REDES 1=7', 'REDES 2=9'])
    await user.selectOptions(select, 'sem:2026.2')
    expect(within(screen.getByRole('list', { name: 'Pontos do gráfico' })).getAllByRole('listitem').map(item => item.textContent)).toEqual(['LOGI 1=5'])
  })

  it('[UC-CURSO-002] sem nenhuma entrega em período letivo, o seletor continua por semestre, como antes', async () => {
    mocks.academic.submissions = mocks.academic.submissions.map(item => ({ ...item, periodoLetivo: null }))
    renderPage()
    const select = await screen.findByLabelText('Filtrar por semestre')
    expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual(['Todos os semestres', '2026.2', '2027.1'])
  })
})
