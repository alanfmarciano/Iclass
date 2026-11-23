import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AvisosPage from './AvisosPage'

// Fase 3, C16 (P5-S2): o resultado da Busca abre o aviso pelo endereço (?aviso=<id>), que
// conta como lido, como o toque nele.
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }))
vi.mock('./useStudent', () => ({ useStudent: () => ({ email: 'ana@x.local', studentClass: '1DES', courseId: 'DES' }) }))
vi.mock('../../hooks/usePreview', () => ({ usePreview: () => null }))

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  mocks.get.mockResolvedValue([
    { id: 'av1', title: 'Feriado', message: 'Sem aula na segunda.', read: true, createdAt: 1 },
    { id: 'av2', title: 'Prova de redes', message: 'A prova sobre TCP será na sexta.', read: false, createdAt: 2 },
  ])
  mocks.post.mockResolvedValue({})
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('[UC-BUSCA-003] Avisos do aluno · aviso aberto pelo endereço', () => {
  it('?aviso= abre o aviso, rola até ele e marca como lido', async () => {
    render(<MemoryRouter initialEntries={['/aluno/avisos?aviso=av2']}><AvisosPage /></MemoryRouter>)
    expect(await screen.findByText('A prova sobre TCP será na sexta.')).toBeInTheDocument()
    expect(screen.queryByText('Sem aula na segunda.')).not.toBeInTheDocument()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    expect(mocks.post).toHaveBeenCalledWith('/api/student/announcements/read', { email: 'ana@x.local', id: 'av2' })
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('sem o parâmetro, nada abre sozinho', async () => {
    render(<MemoryRouter initialEntries={['/aluno/avisos']}><AvisosPage /></MemoryRouter>)
    expect(await screen.findByText('Prova de redes')).toBeInTheDocument()
    expect(screen.queryByText('A prova sobre TCP será na sexta.')).not.toBeInTheDocument()
    expect(mocks.post).not.toHaveBeenCalled()
  })
})

describe('[UC-GRUPO-003] Avisos do aluno · aviso de um grupo', () => {
  it('o aviso para um grupo leva o selo com o nome do grupo', async () => {
    mocks.get.mockResolvedValue([
      { id: 'av3', title: 'Bancada 2', message: 'Tragam o multímetro.', read: false, createdAt: 3, grupo: 'Laboratório A' },
      { id: 'av1', title: 'Feriado', message: 'Sem aula na segunda.', read: true, createdAt: 1 },
    ])
    render(<MemoryRouter initialEntries={['/aluno/avisos']}><AvisosPage /></MemoryRouter>)
    expect(await screen.findByText('Para o grupo Laboratório A')).toBeInTheDocument()
    expect(screen.getAllByText(/^Para o grupo/)).toHaveLength(1)
  })
})
