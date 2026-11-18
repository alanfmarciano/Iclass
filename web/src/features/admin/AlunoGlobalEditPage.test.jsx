import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AlunoGlobalEditPage from './AlunoGlobalEditPage'
import { STUDENT_CLOSE_WARNING, STUDENT_DELETE_KEEPS, STUDENT_DELETE_REMOVES, isClosedStatus } from './studentDeletion'

const mocks = vi.hoisted(() => ({
  get: vi.fn(async () => []),
  post: vi.fn(async () => ({ success: true, updated: 1, skipped: [] })),
  toast: { success: vi.fn(), error: vi.fn() },
  role: 'admin',
}))
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: { accountRole: mocks.role } }) }))
vi.mock('./AlunosPage', () => ({ StudentFormTabs: () => null }))
vi.mock('./StudentAuditPanel', () => ({ StudentAuditPanel: () => null }))
// Respostas estáveis entre renderizações (como o useApi real), senão a ficha refaz a
// busca da auditoria a cada renderização.
const apiData = vi.hoisted(() => ({
  students: { data: [
    { name: 'Ana Souza', email: 'ana@x.local', status: 'Ativo', classes: [{ name: '1DES', courseId: 'DES' }] },
    { name: 'Aluno anonimizado 1A2B3C', email: 'anonimizado-1a2b3c4d5e6f@anonimizado.invalid', status: 'Anonimizado', classes: [{ name: '1DES', courseId: 'DES' }] },
  ], loading: false, error: null, refetch: () => {} },
  empty: { data: [], loading: false, error: null, refetch: () => {} },
}))
vi.mock('../../hooks/useApi', () => ({
  useApi: (path) => (path === '/api/admin/students' ? apiData.students : apiData.empty),
}))

beforeEach(() => {
  mocks.role = 'admin'
  mocks.post.mockClear()
})
afterEach(cleanup)

function renderFicha(email) {
  return render(
    <MemoryRouter initialEntries={[`/diretorio/${encodeURIComponent(email)}`]}>
      <Routes><Route path="/diretorio/:email" element={<AlunoGlobalEditPage />} /></Routes>
    </MemoryRouter>,
  )
}

describe('[UC-ENCERRADOS-001] "Desligar aluno" no lugar de "Excluir aluno"', () => {
  it('textos: desligar guarda tudo; apagar de vez diz o que sai e o que fica', () => {
    expect(STUDENT_CLOSE_WARNING).toBe('O aluno não consegue mais entrar. Notas, presença e certificados ficam guardados. Para anonimizar ou apagar, use Cadastros encerrados.')
    expect(STUDENT_DELETE_REMOVES).toMatch(/as entregas e as notas/)
    expect(STUDENT_DELETE_KEEPS).toMatch(/^Fica, sem nome, e-mail nem matrícula: o histórico da auditoria/)
    expect(isClosedStatus('Concluido')).toBe(true)
    expect(isClosedStatus('Ativo')).toBe(false)
    expect(isClosedStatus('Bloqueado')).toBe(false)
  })

  it('a ficha desliga pelo bulk-status com situação e motivo, sem chamar delete-student', async () => {
    renderFicha('ana@x.local')
    expect(screen.queryByRole('button', { name: /^Excluir/ })).toBeNull()
    await userEvent.click(await screen.findByRole('button', { name: 'Desligar aluno' }))
    expect(screen.getByText(STUDENT_CLOSE_WARNING)).toBeTruthy()
    const situacao = screen.getByLabelText('Nova situação')
    expect(situacao.value).toBe('Inativo')
    expect([...situacao.options].map((option) => option.value)).toEqual(['Inativo', 'Transferido', 'Evadido', 'Concluído'])
    await userEvent.selectOptions(situacao, 'Transferido')
    await userEvent.type(screen.getByLabelText('Motivo (opcional)'), 'Mudou de cidade')
    await userEvent.click(screen.getByRole('button', { name: 'Desligar' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/student/bulk-status', { emails: ['ana@x.local'], status: 'Transferido', reason: 'Mudou de cidade' }))
    expect(mocks.post.mock.calls.some(([path]) => path === '/api/admin/delete-student')).toBe(false)
  })

  it('professor não vê o Desligar aluno', async () => {
    mocks.role = 'professor'
    renderFicha('ana@x.local')
    await screen.findByText('ana@x.local')
    expect(screen.queryByRole('button', { name: 'Desligar aluno' })).toBeNull()
  })

  it('cadastro anonimizado: sem salvar, redefinir senha nem desligar', async () => {
    renderFicha('anonimizado-1a2b3c4d5e6f@anonimizado.invalid')
    expect(await screen.findByText(/Cadastro anonimizado: os dados pessoais saíram/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Desligar aluno' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Salvar' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Redefinir senha' })).toBeNull()
  })
})
