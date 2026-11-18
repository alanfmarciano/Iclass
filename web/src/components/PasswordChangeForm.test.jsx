import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 2, H5a (UXA-13, SEG-06): um formulário de troca de senha para a troca obrigatória
// (aluno e instrutor) e para o "Alterar senha" de Minha conta.
const apiPost = vi.hoisted(() => vi.fn())
vi.mock('../lib/api', () => ({ api: { post: apiPost } }))

import { PasswordChangeForm } from './PasswordChangeForm'
import { checkNewPassword, passwordHint, passwordMinLength } from '../lib/passwordPolicy'

beforeEach(() => { apiPost.mockReset() })
afterEach(() => { cleanup() })

describe('[UC-SENHA-001] política de senha na tela', () => {
  it('mínimo de 8 para aluno e 10 para instrutor, a dica e a confirmação', () => {
    expect(passwordMinLength('student')).toBe(8)
    expect(passwordMinLength('instructor')).toBe(10)
    expect(passwordHint()).toBe('Use pelo menos 8 caracteres. Evite senhas óbvias, como 12345678 ou o seu nome.')
    expect(passwordHint('instructor')).toMatch(/pelo menos 10 caracteres/)
    expect(checkNewPassword('1234567', '1234567')).toBe('A senha precisa ter pelo menos 8 caracteres.')
    expect(checkNewPassword('Ponte-Velha-48', 'Ponte-Velha-4')).toBe('As senhas não coincidem.')
    expect(checkNewPassword('Ponte-Velha-48', 'Ponte-Velha-48')).toBe('')
    expect(checkNewPassword('Mesa-Red-7', 'Mesa-Red-7', 'instructor')).toBe('')
    expect(checkNewPassword('Mesa-Red7', 'Mesa-Red7', 'instructor')).toMatch(/pelo menos 10/)
  })
})

describe('[UC-SENHA-001] formulário de troca de senha', () => {
  it('confere tamanho e confirmação antes de enviar e manda a senha atual e a nova', async () => {
    apiPost.mockResolvedValue({ success: true })
    const onChanged = vi.fn()
    const user = userEvent.setup()
    render(<PasswordChangeForm endpoint="/api/student/change-password" currentLabel="Senha temporária" onChanged={onChanged} />)
    await user.type(screen.getByLabelText('Senha temporária'), 'abcde-fghjk')
    await user.type(screen.getByLabelText('Nova senha'), 'curta')
    await user.type(screen.getByLabelText('Confirmar nova senha'), 'curta')
    await user.click(screen.getByRole('button', { name: 'Salvar nova senha' }))
    expect(screen.getByText('A senha precisa ter pelo menos 8 caracteres.')).toBeInTheDocument()
    expect(apiPost).not.toHaveBeenCalled()

    await user.clear(screen.getByLabelText('Nova senha'))
    await user.type(screen.getByLabelText('Nova senha'), 'Ponte-Velha-48')
    await user.clear(screen.getByLabelText('Confirmar nova senha'))
    await user.type(screen.getByLabelText('Confirmar nova senha'), 'Ponte-Velha-4')
    await user.click(screen.getByRole('button', { name: 'Salvar nova senha' }))
    expect(screen.getByText('As senhas não coincidem.')).toBeInTheDocument()
    expect(apiPost).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText('Confirmar nova senha'), '8')
    await user.click(screen.getByRole('button', { name: 'Salvar nova senha' }))
    expect(apiPost).toHaveBeenCalledWith('/api/student/change-password', { currentPassword: 'abcde-fghjk', newPassword: 'Ponte-Velha-48' })
    expect(onChanged).toHaveBeenCalledOnce()
  })

  it('mostra a recusa do servidor no campo certo (senha atual ou senha nova)', async () => {
    const user = userEvent.setup()
    render(<PasswordChangeForm endpoint="/api/student/change-password" onChanged={vi.fn()} />)
    await user.type(screen.getByLabelText('Senha atual'), 'errada')
    await user.type(screen.getByLabelText('Nova senha'), 'Ponte-Velha-48')
    await user.type(screen.getByLabelText('Confirmar nova senha'), 'Ponte-Velha-48')
    apiPost.mockRejectedValueOnce(Object.assign(new Error('Senha atual incorreta.'), { status: 400, data: { field: 'currentPassword' } }))
    await user.click(screen.getByRole('button', { name: 'Salvar nova senha' }))
    expect(await screen.findByText('Senha atual incorreta.')).toBeInTheDocument()
    expect(screen.getByLabelText('Senha atual')).toHaveAttribute('aria-invalid', 'true')

    apiPost.mockRejectedValueOnce(Object.assign(new Error('Essa senha é muito comum. Escolha outra.'), { status: 400, data: { passwordPolicy: true, field: 'password' } }))
    await user.click(screen.getByRole('button', { name: 'Salvar nova senha' }))
    expect(await screen.findByText('Essa senha é muito comum. Escolha outra.')).toBeInTheDocument()
    expect(screen.getByLabelText('Nova senha')).toHaveAttribute('aria-invalid', 'true')
  })

  it('instrutor sem o campo da senha atual: o campo aparece quando o servidor pede', async () => {
    const user = userEvent.setup()
    render(<PasswordChangeForm kind="instructor" endpoint="/api/admin/change-password" askCurrent={false} onChanged={vi.fn()} />)
    expect(screen.queryByLabelText('Senha atual')).toBeNull()
    expect(screen.getByText(/pelo menos 10 caracteres/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Nova senha'), 'Mesa-Redonda-77')
    await user.type(screen.getByLabelText('Confirmar nova senha'), 'Mesa-Redonda-77')
    apiPost.mockRejectedValueOnce(Object.assign(new Error('Informe a senha atual.'), { status: 400, data: { currentPasswordRequired: true } }))
    await user.click(screen.getByRole('button', { name: 'Salvar nova senha' }))
    expect(apiPost).toHaveBeenLastCalledWith('/api/admin/change-password', { newPassword: 'Mesa-Redonda-77' })
    expect(await screen.findByLabelText('Senha atual')).toBeInTheDocument()
    apiPost.mockResolvedValueOnce({ success: true })
    await user.type(screen.getByLabelText('Senha atual'), 'admin')
    await user.click(screen.getByRole('button', { name: 'Salvar nova senha' }))
    expect(apiPost).toHaveBeenLastCalledWith('/api/admin/change-password', { currentPassword: 'admin', newPassword: 'Mesa-Redonda-77' })
  })
})
