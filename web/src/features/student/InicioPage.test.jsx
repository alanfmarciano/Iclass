import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import InicioPage from './InicioPage'

const mocks = vi.hoisted(() => ({ dashboard: null, calendar: null }))

vi.mock('./useStudent', () => ({ useStudent: () => ({ email: 'ana@x.local', name: 'Ana', studentClass: '1DES', courseId: 'DES' }) }))
vi.mock('../../hooks/useApi', () => ({
  useApi: (url) => ({ data: String(url || '').includes('/dashboard') ? mocks.dashboard : String(url || '').includes('/calendar-events') ? mocks.calendar : null, loading: false, error: null, refetch: vi.fn() }),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.calendar = null
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

  it('[UC-NOTAS-006] barra de avaliação manual mostra o título dela, não o id', () => {
    // Antes a barra mostrava o examKey ("man_1795397447192_410b1b").
    mocks.dashboard = {
      courseName: 'Desenvolvimento',
      overallNote: 8,
      modules: [],
      performance: [
        { id: 's1', examKey: 'Avaliacao_FUTEC_1', note: 7 },
        { id: 's2', examKey: 'man_1795397447192_410b1b', title: 'Seminário de redes', note: 9 },
      ],
      announcements: [],
      calendar: [],
    }
    render(<MemoryRouter><InicioPage /></MemoryRouter>)
    expect(screen.getByText('Seminário de redes')).toBeInTheDocument()
    expect(screen.getByText('FUTEC_1')).toBeInTheDocument()
    expect(screen.queryByText(/man_1795397447192/)).not.toBeInTheDocument()
  })
})

describe('Início do aluno · dias sem aula', () => {
  const localYmd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

  it('[UC-PRESENCA-005] hoje sem aula: faixa no topo, "Sem aula" nos compromissos e os dias do recesso marcados no mês', () => {
    const hoje = new Date()
    const amanha = new Date(); amanha.setDate(hoje.getDate() + 1)
    mocks.dashboard = {
      courseName: 'Desenvolvimento', overallNote: null, modules: [], performance: [], announcements: [],
      calendar: [{ id: 'nao-letivo:nl_1', title: 'Recesso escolar', eventDate: localYmd(hoje), endDate: localYmd(amanha), startTime: '', eventType: 'nao_letivo', hoje: true }],
    }
    mocks.calendar = [{ id: 'nao-letivo:nl_1', title: 'Recesso escolar', eventDate: localYmd(hoje), endDate: localYmd(amanha), eventType: 'nao_letivo' }]
    render(<MemoryRouter><InicioPage /></MemoryRouter>)
    expect(screen.getByRole('status')).toHaveTextContent('Hoje não tem aula: Recesso escolar')
    expect(screen.getByText('Sem aula')).toBeInTheDocument()
    expect(screen.queryByText('nao_letivo')).toBeNull()
    // O dia de amanhã (dentro do recesso) também aparece como sem aula no mês.
    if (amanha.getMonth() === hoje.getMonth()) expect(screen.getByRole('button', { name: `${amanha.getDate()}: sem aula` })).toBeInTheDocument()
  })

  it('[UC-PRESENCA-005] sem dia sem aula hoje, sem a faixa', () => {
    mocks.dashboard = { courseName: 'Desenvolvimento', overallNote: null, modules: [], performance: [], announcements: [], calendar: [] }
    render(<MemoryRouter><InicioPage /></MemoryRouter>)
    expect(screen.queryByText(/Hoje não tem aula/)).toBeNull()
  })
})
