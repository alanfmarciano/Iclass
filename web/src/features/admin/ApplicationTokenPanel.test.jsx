import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApplicationTokenPanel } from './ApplicationTokenPanel'

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

vi.mock('../../lib/api', () => ({ api: { post: mocks.post, get: mocks.get } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))

describe('ApplicationTokenPanel · token perdido', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    mocks.post.mockResolvedValue({ success: true, accessToken: 'QWERT', applicationId: 'app-1' })
  })
  afterEach(cleanup)

  it('[UC-APLICACAO-001] em outro navegador o professor gera um novo token sem preparar de novo a prova', async () => {
    const user = userEvent.setup()
    render(<ApplicationTokenPanel applicationId="app-1" requiresToken closed={false} />)
    expect(screen.getByText('Definido na preparação')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Gerar novo token' }))
    expect(mocks.post).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toHaveTextContent(/Quem já validou o token continua/)
    const confirm = screen.getAllByRole('button', { name: 'Gerar novo token' }).at(-1)
    await user.click(confirm)
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/exam-applications/app-1/access-token', {}))
    expect(await screen.findByText('QWERT')).toBeVisible()
    expect(sessionStorage.getItem('exam-token:app-1')).toBe('QWERT')
    expect(screen.getByRole('button', { name: 'Copiar' })).toBeVisible()
  })

  it('não oferece novo token para prova encerrada nem sem token', () => {
    const { rerender } = render(<ApplicationTokenPanel applicationId="app-1" requiresToken closed />)
    expect(screen.queryByRole('button', { name: 'Gerar novo token' })).not.toBeInTheDocument()
    rerender(<ApplicationTokenPanel applicationId="app-1" requiresToken={false} closed={false} />)
    expect(screen.getByText('Desativado')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Gerar novo token' })).not.toBeInTheDocument()
  })

  it('[UC-APLICACAO-001] esconde o token desta aba quando ele foi trocado em outro navegador', async () => {
    const user = userEvent.setup()
    sessionStorage.setItem('exam-token:app-1', 'ABCDE')
    sessionStorage.setItem('exam-token-issued:app-1', '2026-10-18T10:00:00.000Z')
    const { rerender } = render(<ApplicationTokenPanel applicationId="app-1" requiresToken closed={false} tokenIssuedAt="2026-10-18T10:00:00.000Z" />)
    expect(screen.getByText('ABCDE')).toBeVisible()

    // Outro navegador gerou um token novo: a marca do servidor ficou mais nova.
    rerender(<ApplicationTokenPanel applicationId="app-1" requiresToken closed={false} tokenIssuedAt="2026-10-18T10:05:00.000Z" />)
    expect(screen.queryByText('ABCDE')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copiar' })).not.toBeInTheDocument()
    expect(screen.getByText('Trocado em outra tela')).toBeVisible()
    expect(screen.getByText(/foi trocado em outro navegador e não vale mais/)).toBeVisible()

    // Gerar de novo aqui volta a mostrar o token, mesmo antes da lista do Monitor atualizar.
    mocks.post.mockResolvedValue({ success: true, accessToken: 'ZXCVB', accessTokenIssuedAt: '2026-10-18T10:06:00.000Z', applicationId: 'app-1' })
    await user.click(screen.getByRole('button', { name: 'Gerar novo token' }))
    await user.click(screen.getAllByRole('button', { name: 'Gerar novo token' }).at(-1))
    expect(await screen.findByText('ZXCVB')).toBeVisible()
    expect(sessionStorage.getItem('exam-token-issued:app-1')).toBe('2026-10-18T10:06:00.000Z')
  })

  it('[UC-APLICACAO-001] prova encerrada com o token trocado em outra tela: aviso sem mandar gerar outro e a situação não aparece como se fosse o token', () => {
    sessionStorage.setItem('exam-token:app-1', 'ABCDE')
    sessionStorage.setItem('exam-token-issued:app-1', '2026-10-18T10:00:00.000Z')
    render(<ApplicationTokenPanel applicationId="app-1" requiresToken closed tokenIssuedAt="2026-10-18T10:05:00.000Z" />)
    expect(screen.queryByText('ABCDE')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Gerar novo token' })).not.toBeInTheDocument()
    const situation = screen.getByText('Trocado em outra tela')
    expect(situation).toBeVisible()
    expect(situation.className).not.toMatch(/font-mono/)
    expect(screen.queryByText(/gere outro/)).not.toBeInTheDocument()
    expect(screen.getByText(/A prova já foi encerrada: nenhum aluno entra mais com token\./)).toBeVisible()
  })

  it('token guardado antes da marca de versão some depois de uma troca em outra tela', () => {
    sessionStorage.setItem('exam-token:app-1', 'ABCDE')
    const { rerender } = render(<ApplicationTokenPanel applicationId="app-1" requiresToken closed={false} />)
    expect(screen.getByText('ABCDE')).toBeVisible()
    rerender(<ApplicationTokenPanel applicationId="app-1" requiresToken closed={false} tokenIssuedAt="2026-10-18T10:05:00.000Z" />)
    expect(screen.queryByText('ABCDE')).not.toBeInTheDocument()
  })

  it('[UC-TENTATIVA-004] em outro computador "Mostrar token" traz o mesmo token do servidor, sem trocá-lo', async () => {
    const user = userEvent.setup()
    mocks.get.mockResolvedValue({ success: true, accessToken: 'ABCDE', accessTokenIssuedAt: '2026-11-20T10:00:00.000Z', applicationId: 'app-1' })
    render(<ApplicationTokenPanel applicationId="app-1" requiresToken closed={false} tokenIssuedAt="2026-11-20T10:00:00.000Z" />)
    expect(screen.getByText(/use Mostrar token: o token continua o mesmo/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Mostrar token' }))
    expect(mocks.get).toHaveBeenCalledWith('/api/admin/exam-applications/app-1/access-token')
    expect(mocks.post).not.toHaveBeenCalled()
    expect(await screen.findByText('ABCDE')).toBeVisible()
    expect(sessionStorage.getItem('exam-token:app-1')).toBe('ABCDE')
    expect(screen.queryByRole('button', { name: 'Mostrar token' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Trocar' })).toBeVisible()
  })

  it('[UC-TENTATIVA-004] token que o servidor não tem como mostrar: explica e oferece gerar outro', async () => {
    const user = userEvent.setup()
    const error = Object.assign(new Error('Não dá para mostrar o token desta aplicação de novo. Gere outro token: quem já entrou continua na prova.'), { status: 404, data: { code: 'token_unavailable' } })
    mocks.get.mockRejectedValue(error)
    render(<ApplicationTokenPanel applicationId="app-1" requiresToken closed={false} />)
    await user.click(screen.getByRole('button', { name: 'Mostrar token' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/Não dá para mostrar o token desta aplicação de novo/)
    expect(screen.queryByRole('button', { name: 'Mostrar token' })).not.toBeInTheDocument()
    expect(mocks.toast.error).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Gerar outro' }))
    await user.click(screen.getAllByRole('button', { name: 'Gerar novo token' }).at(-1))
    expect(await screen.findByText('QWERT')).toBeVisible()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('outro erro ao mostrar o token vai para o aviso e o botão continua', async () => {
    const user = userEvent.setup()
    mocks.get.mockRejectedValue(Object.assign(new Error('Sem conexão com o servidor do IClass.'), { status: 0 }))
    render(<ApplicationTokenPanel applicationId="app-1" requiresToken closed={false} />)
    await user.click(screen.getByRole('button', { name: 'Mostrar token' }))
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Sem conexão com o servidor do IClass.'))
    expect(screen.getByRole('button', { name: 'Mostrar token' })).toBeVisible()
  })

  it('prova encerrada ou sem token não oferece "Mostrar token"', () => {
    const { rerender } = render(<ApplicationTokenPanel applicationId="app-1" requiresToken closed />)
    expect(screen.queryByRole('button', { name: 'Mostrar token' })).not.toBeInTheDocument()
    rerender(<ApplicationTokenPanel applicationId="app-1" requiresToken={false} closed={false} />)
    expect(screen.queryByRole('button', { name: 'Mostrar token' })).not.toBeInTheDocument()
  })

  it('mostra o token guardado na aba que preparou e permite trocá-lo', () => {
    sessionStorage.setItem('exam-token:app-1', 'ABCDE')
    render(<ApplicationTokenPanel applicationId="app-1" requiresToken closed={false} />)
    expect(screen.getByText('ABCDE')).toBeVisible()
    expect(screen.getByText('ABCDE').className).toMatch(/font-mono/)
    expect(screen.getByRole('button', { name: 'Trocar' })).toBeVisible()
  })
})
