import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AlunoGlobalEditPage from './AlunoGlobalEditPage'
import { STUDENT_DELETE_KEEPS, STUDENT_DELETE_REMOVES, STUDENT_DELETE_WARNING } from './studentDeletion'

vi.mock('../../lib/api', () => ({ api: { get: vi.fn(async () => []), post: vi.fn() } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: { accountRole: 'admin' } }) }))
vi.mock('./AlunosPage', () => ({ StudentFormTabs: () => null }))
vi.mock('./StudentAuditPanel', () => ({ StudentAuditPanel: () => null }))
// Respostas estáveis entre renderizações (como o useApi real), senão a ficha refaz a
// busca da auditoria a cada renderização.
const apiData = vi.hoisted(() => ({
  students: { data: [{ name: 'Ana Souza', email: 'ana@x.local', status: 'Ativo', classes: [{ name: '1DES', courseId: 'DES' }] }], loading: false, error: null, refetch: () => {} },
  empty: { data: [], loading: false, error: null, refetch: () => {} },
}))
vi.mock('../../hooks/useApi', () => ({
  useApi: (path) => (path === '/api/admin/students' ? apiData.students : apiData.empty),
}))

afterEach(cleanup)

describe('[UC-NOTAS-004] aviso de "Excluir aluno"', () => {
  it('diz que as entregas e as notas saem e o que fica anônimo', () => {
    // Antes: "A conta e submissões vinculadas podem ser afetadas." (não dizia que as notas saem).
    expect(STUDENT_DELETE_REMOVES).toMatch(/as entregas e as notas/)
    expect(STUDENT_DELETE_REMOVES).toMatch(/presença/)
    expect(STUDENT_DELETE_KEEPS).toMatch(/^Fica, sem nome, e-mail nem matrícula: o histórico da auditoria/)
    expect(STUDENT_DELETE_KEEPS).toMatch(/notas que já estavam na lixeira \(só prova e nota\)/)
    expect(STUDENT_DELETE_WARNING).not.toMatch(/podem ser afetadas/)
  })

  it('a ficha do diretório mostra o aviso completo antes de excluir', async () => {
    render(
      <MemoryRouter initialEntries={['/diretorio/ana%40x.local']}>
        <Routes><Route path="/diretorio/:email" element={<AlunoGlobalEditPage />} /></Routes>
      </MemoryRouter>,
    )
    await userEvent.click(await screen.findByRole('button', { name: /^Excluir$/ }))
    expect(screen.getByText(/Excluir Ana Souza\? Não dá para desfazer\./)).toBeTruthy()
    expect(screen.getByText(STUDENT_DELETE_REMOVES)).toBeTruthy()
    expect(screen.getByText(STUDENT_DELETE_KEEPS)).toBeTruthy()
  })
})
