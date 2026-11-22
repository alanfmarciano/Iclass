import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Conta do painel por papel (fase 3, B1; FUN-13, UXI-07): papel em lista de rádio com a
// frase do catálogo, escolas para Secretaria e Coordenação, turmas para professor, o
// Professor auxiliar escondido (decisão do plano) e "Redefinir senha" de outra conta.
const state = vi.hoisted(() => ({
  post: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  auth: { accountRole: 'admin', email: 'admin@escola.local' },
  refetch: vi.fn(),
}))

const ROLES = [
  { id: 'admin', rotulo: 'Administrador', descricao: 'Tudo.', escopo: 'tudo', somenteLeitura: false, oculto: false, permissoesPadrao: [], concediveis: [] },
  { id: 'professor', rotulo: 'Professor', descricao: 'Turmas atribuídas.', escopo: 'turmas', somenteLeitura: false, oculto: false, permissoesPadrao: ['page.dashboard', 'page.results'], concediveis: ['page.accounts'] },
  { id: 'monitor', rotulo: 'Professor auxiliar', descricao: 'Chamada e Monitor.', escopo: 'turmas', somenteLeitura: false, oculto: true, permissoesPadrao: ['page.monitor'], concediveis: ['page.forum'] },
  { id: 'secretaria', rotulo: 'Secretaria', descricao: 'Matrículas e cadastro.', escopo: 'escolas', somenteLeitura: false, oculto: false, permissoesPadrao: ['page.students'], concediveis: [] },
  { id: 'coordenacao', rotulo: 'Coordenação', descricao: 'Consulta da escola.', escopo: 'escolas', somenteLeitura: true, oculto: false, permissoesPadrao: ['page.dashboard'], concediveis: ['page.exams'] },
]
const DATA = {
  '/api/admin/accounts': [
    { email: 'admin@escola.local', name: 'Admin', role: 'admin' },
    { email: 'prof@escola.local', name: 'Prof', role: 'professor', assignedClasses: [{ courseId: 'DES', className: '1DES' }], additionalPermissions: ['page.accounts'] },
    { email: 'aux@escola.local', name: 'Auxiliar', role: 'monitor', assignedClasses: [] },
  ],
  '/api/admin/classes': [{ name: '1DES', courseId: 'DES' }],
  '/api/courses': [{ id: 'DES', name: 'Desenvolvimento', schoolId: 'e1' }],
  '/api/admin/schools': [{ id: 'e1', name: 'Escola Centro' }, { id: 'e2', name: 'Escola Norte' }],
  '/api/admin/roles': { roles: ROLES },
}

vi.mock('../../lib/api', () => ({ api: { post: state.post, get: vi.fn() } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => state.toast }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: state.auth }) }))
vi.mock('../../hooks/useApi', () => ({
  useApi: (path) => ({ data: DATA[path] ?? null, loading: false, error: null, refetch: state.refetch }),
}))

import AdminEditPage, { roleChoices } from './AdminEditPage'

function renderAt(email) {
  return render(
    <MemoryRouter initialEntries={[`/admins/${email}`]}>
      <Routes>
        <Route path="/admins/:email" element={<AdminEditPage />} />
        <Route path="/admins" element={<h1>Lista de contas</h1>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  state.auth = { accountRole: 'admin', email: 'admin@escola.local' }
  state.post.mockReset()
  state.post.mockResolvedValue({ success: true })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('[UC-PAPEIS-005] conta do painel por papel', () => {
  it('roleChoices: esconde o papel oculto, menos na conta que já o tem', () => {
    expect(roleChoices(ROLES, 'professor').map((role) => role.id)).toEqual(['admin', 'professor', 'secretaria', 'coordenacao'])
    expect(roleChoices(ROLES, 'monitor').map((role) => role.id)).toContain('monitor')
    expect(roleChoices([], null).map((role) => role.id)).not.toContain('monitor')
  })

  it('nova conta de Secretaria: papel em rádio com a frase, escolas no lugar das turmas, e manda só as escolas', async () => {
    const user = userEvent.setup()
    renderAt('novo')
    const papel = screen.getByRole('group', { name: 'Papel' })
    expect(within(papel).queryByRole('radio', { name: /Professor auxiliar/ })).toBeNull()
    expect(within(papel).getByText('Coordenação (só consulta)')).toBeInTheDocument()
    expect(within(papel).getByText('Matrículas e cadastro.')).toBeInTheDocument()
    await user.click(within(papel).getByRole('radio', { name: /Secretaria/ }))
    expect(screen.queryByText('Turmas atribuídas')).toBeNull()
    expect(screen.getByText('Escolas atribuídas')).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'Escola Norte' }))
    await user.type(screen.getByLabelText('Nome'), 'Sandra')
    await user.type(screen.getByLabelText('E-mail'), 'sandra@escola.local')
    await user.type(screen.getByLabelText('Senha'), 'Senha-forte-2026')
    await user.click(screen.getAllByRole('button', { name: 'Cadastrar' })[0])
    await waitFor(() => expect(state.post).toHaveBeenCalled())
    const [url, body] = state.post.mock.calls[0]
    expect(url).toBe('/api/admin/accounts/create')
    expect(body).toMatchObject({ role: 'secretaria', assignedSchoolIds: ['e2'], email: 'sandra@escola.local', name: 'Sandra', requirePasswordChange: true })
    expect(body.assignedClasses).toBeUndefined()
  })

  it('professor: turmas atribuídas e as extras do papel; trocar para Coordenação tira a extra que ela não aceita', async () => {
    const user = userEvent.setup()
    renderAt('prof%40escola.local')
    expect(screen.getByText('Turmas atribuídas')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /1DES/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Contas · Visualizar tela/ })).toBeChecked()
    await user.click(screen.getByRole('radio', { name: /Coordenação/ }))
    expect(screen.queryByRole('checkbox', { name: /Contas · Visualizar tela/ })).toBeNull()
    await user.click(screen.getAllByRole('button', { name: 'Salvar' })[0])
    await waitFor(() => expect(state.post).toHaveBeenCalled())
    const [url, body] = state.post.mock.calls[0]
    expect(url).toBe('/api/admin/accounts/update')
    expect(body).toMatchObject({ role: 'coordenacao', additionalPermissions: [], assignedSchoolIds: [] })
    expect(body.assignedClasses).toBeUndefined()
  })

  it('a conta que já é Professor auxiliar continua com o papel na lista', () => {
    renderAt('aux%40escola.local')
    expect(screen.getByRole('radio', { name: /Professor auxiliar/ })).toBeChecked()
  })
})

describe('[UC-CONTA-002] Redefinir senha de outra conta', () => {
  it('o administrador redefine a senha de outra conta e vê a temporária uma vez', async () => {
    state.post.mockResolvedValue({ success: true, mustChangePassword: true, temporaryPassword: 'abcde-fghjk', endedSessions: 1 })
    const user = userEvent.setup()
    renderAt('prof%40escola.local')
    await user.click(screen.getByRole('button', { name: 'Redefinir senha' }))
    const dialog = screen.getByRole('dialog', { name: 'Redefinir senha' })
    expect(within(dialog).getByLabelText(/Gerar senha temporária/)).toBeChecked()
    await user.click(within(dialog).getByRole('button', { name: 'Redefinir' }))
    expect(state.post).toHaveBeenCalledWith('/api/admin/accounts/reset-password', { email: 'prof@escola.local' })
    expect(await screen.findByTestId('temporary-password')).toHaveTextContent('abcde-fghjk')
    expect(screen.getByText('Entregue esta senha à pessoa. No próximo acesso ela vai escolher uma senha nova.')).toBeInTheDocument()
    expect(state.refetch).toHaveBeenCalled()
  })

  it('senha definida pelo administrador vai no pedido; sem digitar, avisa sem chamar o servidor', async () => {
    const user = userEvent.setup()
    renderAt('prof%40escola.local')
    await user.click(screen.getByRole('button', { name: 'Redefinir senha' }))
    const dialog = screen.getByRole('dialog', { name: 'Redefinir senha' })
    await user.click(within(dialog).getByLabelText('Definir eu mesmo'))
    await user.click(within(dialog).getByRole('button', { name: 'Redefinir' }))
    expect(state.post).not.toHaveBeenCalled()
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Digite a senha nova')
    await user.type(within(dialog).getByLabelText('Senha nova'), 'Janela-Clara-2026')
    await user.click(within(dialog).getByRole('button', { name: 'Redefinir' }))
    expect(state.post).toHaveBeenCalledWith('/api/admin/accounts/reset-password', { email: 'prof@escola.local', newPassword: 'Janela-Clara-2026' })
    await waitFor(() => expect(state.toast.success).toHaveBeenCalled())
  })

  it('na própria conta não aparece (a troca é em Minha conta); sem gerenciar contas, também não', () => {
    renderAt('admin%40escola.local')
    expect(screen.queryByRole('button', { name: 'Redefinir senha' })).toBeNull()
    cleanup()
    state.auth = { accountRole: 'secretaria', email: 'sec@escola.local', effectivePermissions: ['page.accounts'] }
    renderAt('prof%40escola.local')
    expect(screen.queryByRole('button', { name: 'Redefinir senha' })).toBeNull()
  })
})
