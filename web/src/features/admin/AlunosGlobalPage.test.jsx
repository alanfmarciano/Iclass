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
  { id: 'alu_00000000000000d1', name: 'Davi Repetido', email: 'davi@x.local', matricula: 'R7', matriculaRepetida: true, status: 'Ativo', classes: [] },
  { id: 'alu_00000000000000d2', name: 'Dora Repetida', email: 'dora@x.local', matricula: 'r7', matriculaRepetida: true, status: 'Ativo', classes: [] },
  { id: 'alu_00000000000000f2', name: 'Bruno Sem Email', email: 'aluno-alu_00000000000000f2@sem-email.invalid', matricula: 'B9', status: 'Ativo', classes: [] },
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

// P4-S3 (fase 3): matrícula repetida em dado antigo desliga o login por matrícula desses
// cadastros; o Diretório avisa e marca as linhas. O aluno sem e-mail aparece como "sem e-mail".
describe('[UC-IDENT-002] Diretório: aviso de matrícula repetida e aluno sem e-mail', () => {
  it('aviso com a contagem e selo nas linhas; o endereço interno não aparece', () => {
    renderPage()
    expect(screen.getByRole('status').textContent).toMatch(/^2 alunos estão com a matrícula repetida: o login por matrícula não funciona/)
    expect(screen.getAllByText('matrícula repetida')).toHaveLength(2)
    expect(screen.getByText('sem e-mail')).toBeTruthy()
    expect(screen.queryByText(/sem-email\.invalid/)).toBeNull()
  })

  it('a busca acha o aluno por "sem e-mail" e não pelo endereço interno', async () => {
    renderPage()
    const search = screen.getByLabelText('Buscar')
    await userEvent.type(search, 'sem e-mail')
    expect(screen.getByText('Bruno Sem Email')).toBeTruthy()
    expect(screen.queryByText('Ana Ativa')).toBeNull()
    await userEvent.clear(search)
    await userEvent.type(search, 'invalid')
    expect(screen.queryByText('Bruno Sem Email')).toBeNull()
  })
})
