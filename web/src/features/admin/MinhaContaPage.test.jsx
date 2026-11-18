import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Minha conta do instrutor (fase 3, B1; UXI-07): nome, senha e "Sair dos outros aparelhos".
const state = vi.hoisted(() => ({
  post: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  auth: null,
  setAuth: vi.fn(),
}))
vi.mock('../../lib/api', () => ({ api: { post: state.post, get: vi.fn() } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => state.toast }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: state.auth, setAuth: state.setAuth }) }))
vi.mock('../../components/PasswordChangeForm', () => ({
  PasswordChangeForm: (props) => (
    <div data-testid="password-form" data-endpoint={props.endpoint} data-ask-current={String(!!props.askCurrent)} data-kind={props.kind}>
      <button type="button" onClick={props.onChanged}>Trocar (simulado)</button>
    </div>
  ),
}))

import MinhaContaPage, { END_OTHER_SESSIONS_TEXT } from './MinhaContaPage'

beforeEach(() => {
  state.auth = { role: 'admin', accountRole: 'professor', name: 'Paula Souza', email: 'paula@escola.local', roleLabel: 'Professor', readOnly: false }
  state.post.mockReset()
  state.setAuth.mockReset()
  state.toast.success.mockReset()
})
afterEach(() => { cleanup() })

describe('[UC-CONTA-001] Minha conta', () => {
  it('mostra nome editável, e-mail e papel só para ler; salva o nome aparado e atualiza a sessão', async () => {
    state.post.mockResolvedValue({ success: true, name: 'Paula de Souza', changed: true })
    const user = userEvent.setup()
    render(<MinhaContaPage />)
    expect(screen.getByText('paula@escola.local')).toBeInTheDocument()
    expect(screen.getByText('Professor')).toBeInTheDocument()
    const save = screen.getByRole('button', { name: 'Salvar nome' })
    expect(save).toBeDisabled()
    const input = screen.getByLabelText('Nome')
    expect(input).toHaveAttribute('maxLength', '120')
    await user.clear(input)
    await user.type(input, '  Paula de Souza ')
    await user.click(save)
    expect(state.post).toHaveBeenCalledWith('/api/admin/account/profile', { name: 'Paula de Souza' })
    await waitFor(() => expect(state.toast.success).toHaveBeenCalledWith('Nome atualizado.'))
    const update = state.setAuth.mock.calls[0][0]
    expect(update({ role: 'admin', name: 'Paula Souza' })).toEqual({ role: 'admin', name: 'Paula de Souza' })
  })

  it('nome vazio não vai ao servidor; o erro do servidor aparece no campo', async () => {
    const user = userEvent.setup()
    render(<MinhaContaPage />)
    const input = screen.getByLabelText('Nome')
    await user.clear(input)
    await user.type(input, '   ')
    await user.click(screen.getByRole('button', { name: 'Salvar nome' }))
    expect(state.post).not.toHaveBeenCalled()
    expect(screen.getByText('Informe o seu nome.')).toBeInTheDocument()
    state.post.mockRejectedValue(new Error('Conta não encontrada.'))
    await user.clear(input)
    await user.type(input, 'Outra')
    await user.click(screen.getByRole('button', { name: 'Salvar nome' }))
    expect(await screen.findByText('Conta não encontrada.')).toBeInTheDocument()
  })

  it('Alterar senha abre o formulário com a senha atual, no endpoint do instrutor', async () => {
    const user = userEvent.setup()
    render(<MinhaContaPage />)
    await user.click(screen.getByRole('button', { name: 'Alterar senha' }))
    const form = screen.getByTestId('password-form')
    expect(form).toHaveAttribute('data-endpoint', '/api/admin/change-password')
    expect(form).toHaveAttribute('data-ask-current', 'true')
    expect(form).toHaveAttribute('data-kind', 'instructor')
    await user.click(screen.getByRole('button', { name: 'Trocar (simulado)' }))
    expect(state.toast.success).toHaveBeenCalledWith('Senha atualizada.')
    expect(screen.queryByTestId('password-form')).toBeNull()
  })

  it('Sair dos outros aparelhos pede confirmação (sem window.confirm) e mostra a resposta', async () => {
    state.post.mockResolvedValue({ success: true, endedSessions: 2, message: '2 outros aparelhos saíram desta conta.' })
    const confirmSpy = vi.spyOn(window, 'confirm')
    const user = userEvent.setup()
    render(<MinhaContaPage />)
    await user.click(screen.getByRole('button', { name: 'Sair dos outros aparelhos' }))
    expect(screen.getByRole('dialog', { name: 'Sair dos outros aparelhos?' })).toBeInTheDocument()
    expect(screen.getByText(END_OTHER_SESSIONS_TEXT)).toBeInTheDocument()
    expect(state.post).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Sair dos outros' }))
    expect(state.post).toHaveBeenCalledWith('/api/admin/account/end-other-sessions', {})
    await waitFor(() => expect(state.toast.success).toHaveBeenCalledWith('2 outros aparelhos saíram desta conta.'))
    expect(confirmSpy).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('a Coordenação (só consulta) vê o papel com "(só consulta)" e pode salvar o nome', () => {
    state.auth = { role: 'admin', accountRole: 'coordenacao', name: 'Rita', email: 'rita@escola.local', roleLabel: 'Coordenação', readOnly: true }
    render(<MinhaContaPage />)
    expect(screen.getByText('Coordenação (só consulta)')).toBeInTheDocument()
    expect(screen.getByLabelText('Nome')).not.toBeDisabled()
  })
})
