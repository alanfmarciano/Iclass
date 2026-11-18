import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 2, H5a (UXA-13, decisão P3): com a troca de senha pedida, o portal mostra só o
// formulário de troca no lugar da página; depois da troca, a página volta.
const state = vi.hoisted(() => ({ auth: {}, setAuth: vi.fn(), apiPost: vi.fn(), toast: { success: vi.fn() } }))
vi.mock('../../lib/api', () => ({ api: { post: state.apiPost } }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: state.auth, setAuth: state.setAuth }) }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => state.toast }))

import { StudentPasswordChangeGate } from './StudentPasswordChangeGate'

beforeEach(() => {
  state.apiPost.mockReset()
  state.setAuth.mockReset()
  state.toast.success.mockReset()
})
afterEach(() => { cleanup() })

const renderGate = () => render(<StudentPasswordChangeGate><p>Início do aluno</p></StudentPasswordChangeGate>)

describe('[UC-SENHA-001] troca de senha obrigatória no portal do aluno', () => {
  it('sem a troca pedida, a página aparece', () => {
    state.auth = { role: 'student', email: 'ana@escola.local' }
    renderGate()
    expect(screen.getByText('Início do aluno')).toBeInTheDocument()
  })

  it('senha dada pelo professor: pede a senha temporária e a nova; depois da troca, libera', async () => {
    state.auth = { role: 'student', email: 'ana@escola.local', mustChangePassword: true, passwordChangeReason: 'reset' }
    state.apiPost.mockResolvedValue({ success: true })
    const user = userEvent.setup()
    renderGate()
    expect(screen.queryByText('Início do aluno')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Escolha uma senha nova' })).toBeInTheDocument()
    expect(screen.getByText(/O professor redefiniu a sua senha/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Senha temporária'), 'abcde-fghjk')
    await user.type(screen.getByLabelText('Nova senha'), 'Ponte-Velha-48')
    await user.type(screen.getByLabelText('Confirmar nova senha'), 'Ponte-Velha-48')
    await user.click(screen.getByRole('button', { name: 'Salvar nova senha' }))
    expect(state.apiPost).toHaveBeenCalledWith('/api/student/change-password', { currentPassword: 'abcde-fghjk', newPassword: 'Ponte-Velha-48' })
    expect(state.setAuth).toHaveBeenCalledOnce()
    const next = state.setAuth.mock.calls[0][0](state.auth)
    expect(next.mustChangePassword).toBe(false)
    expect(next.passwordChangeReason).toBe(null)
    expect(state.toast.success).toHaveBeenCalled()
  })

  it('senha fraca: explica o motivo e pede a senha atual', () => {
    state.auth = { role: 'student', email: 'ana@escola.local', mustChangePassword: true, passwordChangeReason: 'weak' }
    renderGate()
    expect(screen.getByText(/A sua senha é fácil de adivinhar/)).toBeInTheDocument()
    expect(screen.getByLabelText('Senha atual')).toBeInTheDocument()
  })
})
