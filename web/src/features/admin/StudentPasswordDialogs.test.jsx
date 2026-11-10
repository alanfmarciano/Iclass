import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 2, H5a (SEG-06, UXA-13): "Redefinir senha" gera uma senha temporária por padrão
// (ou o professor define), mostra a senha uma vez com o Copiar e avisa da troca.
const state = vi.hoisted(() => ({ apiPost: vi.fn(), toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../lib/api', () => ({ api: { post: state.apiPost } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => state.toast }))

import { StudentPasswordResetDialog, TemporaryPasswordNotice, TEMPORARY_PASSWORD_KEPT_TEXT, TEMPORARY_PASSWORD_TEXT } from './StudentPasswordDialogs'
import { StudentAuditPanel } from './StudentAuditPanel'

beforeEach(() => {
  state.apiPost.mockReset()
  state.toast.success.mockReset()
  state.toast.error.mockReset()
})
afterEach(() => { cleanup() })

describe('[UC-SENHA-001] redefinir senha do aluno pelo painel', () => {
  it('padrão: gera a senha temporária e mostra com o Copiar e o texto de entrega', async () => {
    state.apiPost.mockResolvedValue({ success: true, mustChangePassword: true, temporaryPassword: 'abcde-fghjk' })
    const onDone = vi.fn()
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<StudentPasswordResetDialog email="ana@escola.local" onClose={onClose} onDone={onDone} />)
    expect(screen.getByLabelText(/Gerar senha temporária/)).toBeChecked()
    expect(screen.queryByLabelText('Senha nova')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Redefinir' }))
    expect(state.apiPost).toHaveBeenCalledWith('/api/admin/reset-password', { email: 'ana@escola.local' })
    expect(onDone).toHaveBeenCalledOnce()
    expect(await screen.findByTestId('temporary-password')).toHaveTextContent('abcde-fghjk')
    expect(screen.getByText(TEMPORARY_PASSWORD_TEXT)).toBeInTheDocument()
    expect(TEMPORARY_PASSWORD_TEXT).toBe('Entregue esta senha ao aluno. No próximo acesso ele vai escolher uma senha nova.')
    expect(screen.getByRole('button', { name: 'Copiar' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Pronto' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('"Definir eu mesmo": manda a senha digitada e mostra a recusa da política', async () => {
    const user = userEvent.setup()
    render(<StudentPasswordResetDialog email="ana@escola.local" onClose={vi.fn()} />)
    await user.click(screen.getByLabelText('Definir eu mesmo'))
    expect(screen.getByText('Use pelo menos 8 caracteres. Evite senhas óbvias, como 12345678 ou o seu nome.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Redefinir' }))
    expect(state.apiPost).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Digite a senha nova')
    state.apiPost.mockRejectedValueOnce(Object.assign(new Error('Essa senha é muito comum. Escolha outra.'), { status: 400 }))
    await user.type(screen.getByLabelText('Senha nova'), '12345678')
    await user.click(screen.getByRole('button', { name: 'Redefinir' }))
    expect(state.apiPost).toHaveBeenCalledWith('/api/admin/reset-password', { email: 'ana@escola.local', newPassword: '12345678' })
    expect(await screen.findByText('Essa senha é muito comum. Escolha outra.')).toBeInTheDocument()
  })
})

describe('[UC-SENHA-001] aviso da senha temporária segue a troca pedida', () => {
  it('caixa "Pedir troca no primeiro acesso" desmarcada: não promete a troca', () => {
    render(<TemporaryPasswordNotice open email="ana@escola.local" password="abcde-fghjk" mustChangePassword={false} onClose={vi.fn()} />)
    expect(screen.getByText(TEMPORARY_PASSWORD_KEPT_TEXT)).toBeInTheDocument()
    expect(TEMPORARY_PASSWORD_KEPT_TEXT).toBe('Entregue esta senha ao aluno. Ela continua valendo até ele trocar em Minha conta.')
    expect(screen.queryByText(TEMPORARY_PASSWORD_TEXT)).toBeNull()
  })

  it('reset com o servidor dizendo que a troca não vale (demonstração): texto sem a troca', async () => {
    state.apiPost.mockResolvedValue({ success: true, mustChangePassword: false, temporaryPassword: 'abcde-fghjk' })
    const user = userEvent.setup()
    render(<StudentPasswordResetDialog email="ana@escola.local" onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Redefinir' }))
    expect(await screen.findByText(TEMPORARY_PASSWORD_KEPT_TEXT)).toBeInTheDocument()
  })
})

describe('[UC-SENHA-001] redefinição de senha na aba Auditoria da ficha', () => {
  it('a entrada sem campo do cadastro aparece pelo rótulo, sem "(vazio) → (vazio)"', () => {
    const rows = [
      { id: 'r1', action: 'student_password_reset', category: 'security', label: 'Senha do aluno redefinida', field: '', oldValue: null, newValue: null, actor: 'prof@escola.local', timestamp: 1_800_000_000_000, details: { mode: 'generated' } },
      { id: 'r2', action: 'update', category: 'student', label: 'Cadastro do aluno alterado', field: 'Telefone', oldValue: '1', newValue: '2', actor: 'admin@escola.local', timestamp: 1_800_000_000_000 },
    ]
    render(<StudentAuditPanel rows={rows} />)
    expect(screen.getAllByText('Senha do aluno redefinida').length).toBeGreaterThan(0)
    expect(screen.queryByText('(vazio)')).toBeNull()
    expect(screen.getByText('por prof@escola.local')).toBeInTheDocument()
  })
})
