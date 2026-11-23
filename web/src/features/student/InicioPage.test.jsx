import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { fireEvent, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import InicioPage from './InicioPage'

const mocks = vi.hoisted(() => ({ dashboard: null, assignments: null }))

vi.mock('./useStudent', () => ({ useStudent: () => ({ email: 'ana@x.local', name: 'Ana', studentClass: '1DES', courseId: 'DES' }) }))
vi.mock('../../hooks/useApi', () => ({
  useApi: (url) => ({ data: String(url || '').includes('/dashboard') ? mocks.dashboard : String(url || '').startsWith('/api/student/assignments') ? mocks.assignments : null, loading: false, error: null, refetch: vi.fn() }),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Início do aluno · notas', () => {
  it('[UC-NOTAS-003] notas do painel e das barras de desempenho saem com vírgula', () => {
    // Antes as barras de "Seu desempenho" mostravam item.note.toFixed(1) ("7.5").
    mocks.dashboard = {
      courseName: 'Desenvolvimento',
      overallNote: 8.25,
      modules: [{ id: 'm1', name: 'FUTEC', done: 1, total: 2, progress: 50, note: 6.5, noteStatus: 'published' }],
      performance: [
        { id: 's1', examKey: 'Avaliacao_FUTEC_1', note: 7.5 },
        { id: 's2', examKey: 'Avaliacao_FUTEC_2', note: 9 },
      ],
      announcements: [],
      calendar: [],
    }
    render(<MemoryRouter><InicioPage /></MemoryRouter>)
    expect(screen.getByText('Nota geral').parentElement.parentElement).toHaveTextContent('8,3')
    expect(screen.getByText('6,5')).toBeInTheDocument()
    expect(screen.getByText('7,5')).toBeInTheDocument()
    expect(screen.getByText('9,0')).toBeInTheDocument()
    expect(screen.queryByText('7.5')).not.toBeInTheDocument()
    expect(screen.queryByText('9.0')).not.toBeInTheDocument()
  })
})

// Fase 3, C9 (P1-g; parte de UXA-25): a Início mostra as atividades esperando o envio do
// aluno, com o prazo e o link, e "Ver todas" leva à lista.
const navigate = vi.hoisted(() => vi.fn())
vi.mock('react-router-dom', async (importOriginal) => ({ ...(await importOriginal()), useNavigate: () => navigate }))

describe('Início do aluno · atividades a fazer', () => {
  it('lista só as que esperam o envio, por prazo, com o link de cada uma', () => {
    const now = Date.UTC(2026, 10, 22, 15, 0)
    mocks.dashboard = { modules: [], announcements: [], calendar: [] }
    mocks.assignments = {
      serverNow: now,
      timezone: 'America/Sao_Paulo',
      assignments: [
        { id: 'asg_a', title: 'Relatório de redes', situacao: 'a_fazer', situacaoTexto: 'A fazer', aceitaEnvio: true, dueAt: now + 26 * 60 * 60 * 1000 },
        { id: 'asg_b', title: 'Já enviada', situacao: 'enviada', situacaoTexto: 'Enviada', aceitaEnvio: true, dueAt: now + 60 * 60 * 1000 },
        { id: 'asg_c', title: 'Diagrama', situacao: 'atrasada', situacaoTexto: 'Atrasada', aceitaEnvio: true, dueAt: now - 60 * 60 * 1000 },
      ],
    }
    render(<MemoryRouter><InicioPage /></MemoryRouter>)
    const card = screen.getByRole('heading', { name: 'Atividades a fazer (2)' }).closest('.premium-card')
    expect(within(card).getByText('Relatório de redes')).toBeInTheDocument()
    expect(within(card).getByText('Prazo: seg., 23/11 às 14:00 (falta 1 dia e 2 horas)')).toBeInTheDocument()
    expect(within(card).getByText('Diagrama')).toBeInTheDocument()
    expect(within(card).queryByText('Já enviada')).not.toBeInTheDocument()
    fireEvent.click(within(card).getByText('Relatório de redes'))
    expect(navigate).toHaveBeenCalledWith('/aluno/atividades/asg_a')
    fireEvent.click(within(card).getByRole('button', { name: 'Ver todas' }))
    expect(navigate).toHaveBeenCalledWith('/aluno/atividades')
  })
})

// C9 ajuste 2 (UXA-25): o número "Pendências" não levava a nada; agora abre os conteúdos.
describe('Início do aluno · Pendências', () => {
  it('o cartão "Pendências" abre os conteúdos liberados', () => {
    mocks.dashboard = { modules: [], announcements: [], calendar: [], pendingCount: 6 }
    mocks.assignments = { serverNow: Date.now(), timezone: 'America/Sao_Paulo', assignments: [] }
    render(<MemoryRouter><InicioPage /></MemoryRouter>)
    const button = screen.getByRole('button', { name: /Pendências\s*6\s*Conteúdos liberados para estudar/ })
    fireEvent.click(button)
    expect(navigate).toHaveBeenCalledWith('/aluno/modulos')
  })
})
