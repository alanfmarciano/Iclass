import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CalendarioPage from './CalendarioPage'

const mocks = vi.hoisted(() => ({ events: [], downloadFile: vi.fn(), toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('../../context/AuthProvider', () => ({
  useAuth: () => ({ auth: { email: 'ana@x.local', activeClass: { courseId: 'TI', name: '1DES' } } }),
}))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() }, downloadFile: mocks.downloadFile }))
vi.mock('../../hooks/useApi', () => ({
  useApi: (path) => ({ data: path && path.startsWith('/api/student/calendar-events') ? mocks.events : null, loading: false, error: null, refetch: vi.fn() }),
}))

const now = new Date()
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const plus = (days) => { const d = new Date(now); d.setDate(d.getDate() + days); return ymd(d) }

beforeEach(() => {
  window.scrollTo = vi.fn()
  mocks.downloadFile.mockResolvedValue('agenda.ics')
  // Recesso que começou anteontem e vai até depois de amanhã, mais uma prova daqui a 3 dias.
  mocks.events = [
    { id: 'nao-letivo:nl_1', title: 'Recesso escolar', description: 'Recesso: não há aula.', eventDate: plus(-2), endDate: plus(2), eventType: 'nao_letivo' },
    { id: 'cal_1', title: 'Prova de Redes', description: '', eventDate: plus(3), startTime: '08:00', eventType: 'prova', target: 'turma', targetValue: '1DES' },
  ]
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Calendário do aluno', () => {
  it('[UC-PRESENCA-005] o recesso em andamento fica em "Próximos compromissos" como "Sem aula" e abre sem turma nem curso', async () => {
    const user = userEvent.setup()
    render(<CalendarioPage />)
    // Antes o recesso que já tinha começado saía da lista (eventDate antes de hoje).
    const card = screen.getByRole('heading', { name: 'Próximos compromissos' }).parentElement
    const recesso = within(card).getByRole('button', { name: /Recesso escolar/ })
    expect(within(recesso).getByText('Sem aula')).toBeInTheDocument()
    await user.click(recesso)
    const dialog = await screen.findByRole('dialog', { name: 'Recesso escolar' })
    expect(within(dialog).getByText('Recesso: não há aula.')).toBeInTheDocument()
    expect(within(dialog).queryByText('Curso inteiro')).toBeNull()
    expect(within(dialog).queryByText('Todos os alunos do curso')).toBeNull()
  })

  it('[UC-PRESENCA-005] "Baixar agenda (.ics)" baixa a agenda da turma do aluno', async () => {
    const user = userEvent.setup()
    render(<CalendarioPage />)
    await user.click(screen.getByRole('button', { name: 'Baixar agenda (.ics)' }))
    expect(mocks.downloadFile).toHaveBeenCalledWith('/api/student/calendar.ics?courseId=TI&studentClass=1DES', 'agenda.ics')
  })

  it('[UC-PRESENCA-005] no celular o mês vira lista por dia, com "Sem aula" nos dias do recesso', () => {
    const original = window.matchMedia
    window.matchMedia = vi.fn((query) => ({ matches: query === '(max-width: 767px)', media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    try {
      render(<CalendarioPage />)
      const lista = screen.getByRole('list', { name: /^Dias de / })
      const hoje = within(lista).getAllByRole('listitem').find((item) => item.textContent.includes('hoje'))
      expect(hoje).toBeTruthy()
      expect(within(hoje).getByText('Sem aula')).toBeInTheDocument()
    } finally { window.matchMedia = original }
  })
})

describe('Calendário do aluno: evento de um grupo (P5-S5)', () => {
  it('[UC-GRUPO-003] o evento de um grupo abre com o nome do grupo, não como "Curso inteiro"', async () => {
    const user = userEvent.setup()
    mocks.events = [
      { id: 'cal_g', title: 'Bancada no laboratório', description: '', eventDate: plus(2), startTime: '10:00', eventType: 'aula', target: 'grupo', targetValue: 'grp_a', grupo: 'Laboratório A' },
    ]
    render(<CalendarioPage />)
    const card = screen.getByRole('heading', { name: 'Próximos compromissos' }).parentElement
    await user.click(within(card).getByRole('button', { name: /Bancada no laboratório/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Bancada no laboratório' })
    expect(within(dialog).getByText('Grupo Laboratório A')).toBeInTheDocument()
    expect(within(dialog).getByText('Só o grupo Laboratório A')).toBeInTheDocument()
    expect(within(dialog).queryByText('Curso inteiro')).toBeNull()
  })
})
