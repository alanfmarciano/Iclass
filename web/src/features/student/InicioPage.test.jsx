import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import InicioPage from './InicioPage'

const mocks = vi.hoisted(() => ({ dashboard: null }))

vi.mock('./useStudent', () => ({ useStudent: () => ({ email: 'ana@x.local', name: 'Ana', studentClass: '1DES', courseId: 'DES' }) }))
vi.mock('../../hooks/useApi', () => ({
  useApi: (url) => ({ data: String(url || '').includes('/dashboard') ? mocks.dashboard : null, loading: false, error: null, refetch: vi.fn() }),
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
