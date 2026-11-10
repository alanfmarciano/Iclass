import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AlunosGlobalPage from './AlunosGlobalPage'

// Diretório de alunos (/diretorio): o filtro de situação acha os anonimizados (H7c) e
// compara sem acento ("Concluido" de banco antigo entra em Concluído).
const STUDENTS = [
  { name: 'Ana Ativa', email: 'ana@x.local', status: 'Ativo', classes: [] },
  { name: 'Aluno anonimizado AAAAAA', email: 'anonimizado-aaa@anonimizado.invalid', status: 'Anonimizado', classes: [] },
  { name: 'Carla Antiga', email: 'carla@x.local', status: 'Concluido', classes: [] },
]
vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }))
vi.mock('../../hooks/useApi', () => ({
  useApi: (path) => ({ data: String(path).startsWith('/api/admin/students?') ? STUDENTS : [], loading: false, error: null, refetch: vi.fn() }),
}))
afterEach(cleanup)

function renderPage(url = '/diretorio') {
  return render(<MemoryRouter initialEntries={[url]}><AlunosGlobalPage /></MemoryRouter>)
}

describe('[UC-ENCERRADOS-003] Diretório: situação Anonimizado e situação sem acento', () => {
  it('o filtro tem Anonimizado e acha o cadastro anonimizado', async () => {
    renderPage()
    const filter = screen.getByLabelText('Situação')
    expect(within(filter).getByRole('option', { name: 'Anonimizado' })).toBeTruthy()
    await userEvent.selectOptions(filter, 'Anonimizado')
    expect(screen.getByText('Aluno anonimizado AAAAAA')).toBeTruthy()
    expect(screen.queryByText('Ana Ativa')).toBeNull()
  })

  it('Concluído acha a situação antiga "Concluido"', () => {
    renderPage('/diretorio?situacao=Conclu%C3%ADdo')
    expect(screen.getByText('Carla Antiga')).toBeTruthy()
    expect(screen.queryByText('Ana Ativa')).toBeNull()
  })
})
