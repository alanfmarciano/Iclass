import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApplicationTokenPanel } from './ApplicationTokenPanel'

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

vi.mock('../../lib/api', () => ({ api: { post: mocks.post } }))
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

  it('mostra o token guardado na aba que preparou e permite trocá-lo', () => {
    sessionStorage.setItem('exam-token:app-1', 'ABCDE')
    render(<ApplicationTokenPanel applicationId="app-1" requiresToken closed={false} />)
    expect(screen.getByText('ABCDE')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Trocar' })).toBeVisible()
  })
})
