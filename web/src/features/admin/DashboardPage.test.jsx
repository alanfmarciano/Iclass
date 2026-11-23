import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DashboardPage from './DashboardPage'
import { riskReasons } from './dashboard/RiskList'

// Dashboard por papel (B1): cada seção só aparece para quem abre a tela dela, e quem não lê
// nota (Professor auxiliar) vê a média como oculta, não como "sem dado".
const mocks = vi.hoisted(() => ({ auth: {}, paths: [], now: null, calendar: null }))

const MONITOR = { accountRole: 'monitor', roleLabel: 'Professor auxiliar', effectivePermissions: ['page.dashboard', 'page.classes', 'page.students', 'page.monitor'] }
const SECRETARIA = { accountRole: 'secretaria', roleLabel: 'Secretaria', effectivePermissions: ['page.dashboard', 'page.classes', 'page.students', 'students.edit', 'students.import', 'enrollments.approve', 'students.certificates', 'reports.view'] }

const trends = (gradesHidden) => ({
  ...(gradesHidden ? { gradesHidden: true } : {}),
  disciplinas: { exibir: false, itens: [], limiar: 75, cobertura: { total: 0, comDisciplina: 0 } },
  frequencia: { atual: 90, deltaPP: null, base: { comChamada: 2, total: 2 }, serie: [] },
  media: gradesHidden
    ? { atual: null, anterior: null, delta: null, base: { provas: 0, alunos: 0 }, serie: [] }
    : { atual: 7.5, anterior: null, delta: null, base: { provas: 3, alunos: 2 }, serie: [] },
  engajamento: { atual: 2, total: 2, anterior: null, semAcessoMais14d: 0, serie: [] },
})

vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: mocks.auth }) }))
vi.mock('../../context/PreferencesProvider', () => ({ usePreferences: () => ({ pref: (_key, fallback) => fallback, setPref: vi.fn() }) }))
vi.mock('../../hooks/useAdminWorkspace', () => ({ useAdminWorkspace: () => ({ courseId: 'C1', courseName: 'Curso', className: '1DES', period: '' }) }))
vi.mock('./RoomAddress', () => ({ RoomAddressButton: () => null }))
vi.mock('../../hooks/useApi', () => ({
  useApi: (path) => {
    mocks.paths.push(path)
    const ok = (data) => ({ data, loading: false, error: null, refetch: vi.fn(), setData: vi.fn() })
    if (!path) return ok(null)
    if (path.startsWith('/api/admin/dashboard/students-overview')) {
      return ok([{ email: 'ana@x.local', name: 'Ana', className: '1DES', frequencia: 50, presentes: 1, totalAulas: 2, faltas: 1, media: null, riscoLevel: 'alto' }])
    }
    if (path.startsWith('/api/admin/dashboard/now')) return ok(mocks.now || { aula: null, proximaAula: null, aplicacao: null, proximaAplicacao: null, online: { count: 0 } })
    if (path.startsWith('/api/admin/dashboard/queue')) return ok([])
    if (path.startsWith('/api/admin/dashboard/trends')) return ok(trends(mocks.auth?.accountRole === 'monitor'))
    if (path.startsWith('/api/admin/announcements/calendar')) return ok(mocks.calendar || [])
    return ok(null)
  },
}))

beforeEach(() => { mocks.paths = [] })
afterEach(() => { mocks.auth = {}; mocks.now = null; mocks.calendar = null; cleanup() })

const renderDashboard = () => render(<MemoryRouter><DashboardPage /></MemoryRouter>)
const pulse = () => within(screen.getByRole('region', { name: 'Pulso da turma' }))

describe('[UC-PAPEIS-001] Dashboard por papel', () => {
  it('o professor vê o calendário, "Ver resultados" e a média das provas', () => {
    mocks.auth = { accountRole: 'professor' }
    renderDashboard()
    expect(mocks.paths.some((path) => String(path).startsWith('/api/admin/announcements/calendar'))).toBe(true)
    expect(screen.getByText('Próximos 7 dias')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ver resultados' })).toBeInTheDocument()
    expect(pulse().getByText('7,5')).toBeInTheDocument()
    expect(screen.getByText('nenhuma prova entregue')).toBeInTheDocument()
  })

  it('o professor auxiliar: sem calendário (nem a consulta), sem "Ver resultados" e com a média oculta', () => {
    mocks.auth = MONITOR
    renderDashboard()
    expect(mocks.paths.some((path) => String(path).startsWith('/api/admin/announcements/calendar'))).toBe(false)
    expect(screen.queryByText('Próximos 7 dias')).toBeNull()
    expect(screen.queryByText('Não foi possível carregar esta seção.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Ver resultados' })).toBeNull()
    expect(pulse().getByText('oculta')).toBeInTheDocument()
    expect(pulse().getByText('As notas não aparecem para o seu papel.')).toBeInTheDocument()
    // Sem o selo de tendência ao lado de "oculta" (lia "oculta sem base"); a frequência e o
    // engajamento, sem base de comparação, continuam com o deles.
    const mediaCard = pulse().getByText('oculta').closest('.premium-card')
    expect(within(mediaCard).queryByText('sem base')).toBeNull()
    expect(pulse().getAllByText('sem base')).toHaveLength(2)
    expect(pulse().queryByText(/alunos avaliados/)).toBeNull()
    // A média vazia não vira "nenhuma prova entregue" nos motivos de risco.
    expect(screen.queryByText('nenhuma prova entregue')).toBeNull()
    expect(screen.getByRole('button', { name: 'Lançar chamada' })).toBeInTheDocument()
  })

  it('a Secretaria (sem Fórum nem Resultados) não recebe seção quebrada nem link para tela que não abre', () => {
    mocks.auth = SECRETARIA
    renderDashboard()
    expect(mocks.paths.some((path) => String(path).startsWith('/api/admin/announcements/calendar'))).toBe(false)
    expect(screen.queryByText('Próximos 7 dias')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Ver resultados' })).toBeNull()
    // Ela lê nota (reports.view): a média aparece.
    expect(pulse().getByText('7,5')).toBeInTheDocument()
  })

  it('[UC-PAPEIS-004] a Coordenação (só consulta) vê "Ver chamada", não "Lançar chamada"', () => {
    mocks.auth = { role: 'admin', accountRole: 'coordenacao', readOnly: true, roleLabel: 'Coordenação', effectivePermissions: ['page.dashboard', 'page.results', 'page.classes', 'page.students', 'page.forum', 'page.assignments', 'reports.view'] }
    renderDashboard()
    expect(screen.getByRole('button', { name: 'Ver chamada' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Lançar chamada' })).toBeNull()
  })

  it('riskReasons: com a nota oculta, a média vazia não é motivo', () => {
    const row = { frequencia: 90, faltas: 0, media: null }
    expect(riskReasons(row, 75).map((item) => item.text)).toEqual(['nenhuma prova entregue'])
    expect(riskReasons(row, 75, true)).toEqual([])
  })

  it('[UC-TENTATIVA-003] riskReasons: média abaixo da mínima do critério, na nota como aparece', () => {
    const texts = (media, criterio) => riskReasons({ frequencia: 90, faltas: 0, media }, 75, false, criterio).map((item) => item.text)
    expect(texts(5)).toEqual(['média 5,0 — abaixo de 6,0'])
    expect(texts(5.95)).toEqual([])
    expect(texts(6)).toEqual([])
    expect(texts(5, { mediaMinima: 5 })).toEqual([])
    expect(texts(4.5, { mediaMinima: 5 })).toEqual(['média 4,5 — abaixo de 5,0'])
  })

  it('[UC-TENTATIVA-003] riskReasons usa o critério que vem do servidor em cada linha', () => {
    const row = { frequencia: 90, faltas: 0, media: 5.5, criterio: { mediaMinima: 5, mencoes: null, regraAntiga: false } }
    expect(riskReasons(row, 75).map((item) => item.text)).toEqual([])
    expect(riskReasons({ ...row, media: 4.5 }, 75).map((item) => item.text)).toEqual(['média 4,5 — abaixo de 5,0'])
    // Sem o campo (resposta antiga), o padrão 6,0.
    expect(riskReasons({ ...row, criterio: undefined }, 75).map((item) => item.text)).toEqual(['média 5,5 — abaixo de 6,0'])
  })
})

describe('[UC-DASH-005] Dashboard em dia não letivo', () => {
  const localYmd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

  it('a faixa "Agora" diz que hoje não tem aula e mostra a próxima aula depois do feriado', () => {
    mocks.auth = { accountRole: 'professor' }
    mocks.now = {
      aula: null, aplicacao: null, proximaAplicacao: null, online: { count: 0 },
      proximaAula: { data: '2027-11-16', inicio: '08:00', nome: 'Fundamentos de TI' },
      naoLetivo: { id: 'nl_1', nome: 'Proclamação da República', tipo: 'feriado', tipoRotulo: 'Feriado', inicio: '2027-11-15', fim: '2027-11-15', escopo: 'instituicao' },
      foraDoPeriodo: false,
    }
    renderDashboard()
    // Antes a faixa só dizia "Próxima aula: ...", como num dia qualquer sem aula.
    const agora = within(screen.getByRole('region', { name: 'Agora' }))
    expect(agora.getByRole('status')).toHaveTextContent('Hoje não tem aula: Proclamação da República (feriado)')
    expect(agora.getByText(/Próxima aula:/)).toBeInTheDocument()
  })

  it('fora do período letivo a faixa também diz que não tem aula', () => {
    mocks.auth = { accountRole: 'professor' }
    mocks.now = { aula: null, proximaAula: null, aplicacao: null, proximaAplicacao: null, online: { count: 0 }, naoLetivo: null, foraDoPeriodo: true }
    renderDashboard()
    expect(within(screen.getByRole('region', { name: 'Agora' })).getByRole('status')).toHaveTextContent('Hoje não tem aula: a turma está fora do período letivo')
  })

  it('o recesso que começou antes de hoje e continua aparece nos próximos 7 dias como "sem aula"', () => {
    mocks.auth = { accountRole: 'professor' }
    const ontem = new Date(); ontem.setDate(ontem.getDate() - 2)
    const depois = new Date(); depois.setDate(depois.getDate() + 3)
    mocks.calendar = [{ kind: 'nonSchoolDay', id: 'nl_2', title: 'Recesso de fim de ano', eventDate: localYmd(ontem), endDate: localYmd(depois), eventType: 'nao_letivo', readOnly: true }]
    renderDashboard()
    // Antes só entrava o evento que começava dentro dos 7 dias (eventDate).
    expect(screen.getByText('Recesso de fim de ano')).toBeInTheDocument()
    expect(screen.getByText('sem aula')).toBeInTheDocument()
    // E aparece no dia de hoje, não no de início (que já passou).
    const hoje = new Date()
    const linha = screen.getByRole('button', { name: /Recesso de fim de ano/ })
    const dias = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']
    expect(linha).toHaveTextContent(new RegExp(`^${hoje.getDate()}${dias[hoje.getDay()]}`))
    expect(linha).not.toHaveTextContent(new RegExp(`^${ontem.getDate()}${dias[ontem.getDay()]}`))
  })

  it('o recesso em andamento fica antes do evento de amanhã nos próximos 7 dias', () => {
    mocks.auth = { accountRole: 'professor' }
    const antes = new Date(); antes.setDate(antes.getDate() - 5)
    const amanha = new Date(); amanha.setDate(amanha.getDate() + 1)
    const depois = new Date(); depois.setDate(depois.getDate() + 3)
    mocks.calendar = [
      { id: 'cal_1', title: 'Reunião de pais', eventDate: localYmd(amanha), eventType: 'reuniao', startTime: '19:00' },
      { kind: 'nonSchoolDay', id: 'nl_3', title: 'Recesso longo', eventDate: localYmd(antes), endDate: localYmd(depois), eventType: 'nao_letivo', readOnly: true },
    ]
    renderDashboard()
    const titulos = screen.getAllByRole('button', { name: /Reunião de pais|Recesso longo/ }).map((el) => el.textContent)
    expect(titulos[0]).toMatch(/Recesso longo/)
    expect(titulos[1]).toMatch(/Reunião de pais/)
  })
})
