import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SistemaPage from './SistemaPage'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }))
vi.mock('../../hooks/useApi', () => ({ useApi: () => ({ data: null, loading: false, error: null, refetch: vi.fn() }) }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
vi.mock('../../context/AuthProvider', () => ({
  useAuth: () => ({ auth: { role: 'admin', accountRole: 'admin', activeWorkspace: { courseId: 'DES', className: '1DES' } } }),
}))
vi.mock('../../hooks/useAdminWorkspace', () => ({
  useAdminWorkspace: () => ({ courseId: 'DES', courseName: 'Técnico em TI', className: '1DES' }),
}))

function preview({ blocked = false } = {}) {
  return {
    success: true,
    studentClass: '1DES',
    restart: { activeApplications: [{ id: 'app-1', examKey: 'Avaliacao_X', examTitle: 'Prova X', status: 'running', studentClass: '2DES' }] },
    applications: [{ id: 'app-2', examKey: 'Avaliacao_Y', examTitle: 'Prova Y', status: 'finished' }],
    flush: {
      blockedBy: blocked ? [{ id: 'app-3', examTitle: 'Prova Z', status: 'running' }] : [],
      counts: { examStates: 3, pendingAnswers: 1, messages: 2 },
      preserved: { proctoringLogs: 5, keystrokes: 7 },
    },
    reset: {
      activeApplications: [{ id: 'app-4', examKey: 'Avaliacao_W', examTitle: 'Prova W', status: 'running', inProgressAttempts: 4, waitingToStart: 1 }],
      counts: { sessions: 6, examStates: 0, messages: 1 },
    },
  }
}

describe('SistemaPage · manutenção', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.get.mockResolvedValue(preview())
    mocks.post.mockResolvedValue({ success: true, message: 'ok' })
  })
  afterEach(cleanup)

  it('[UC-MANUT-001] "Limpar estado de prova" abre a confirmação com o que será apagado e só envia com LIMPAR (UXI-02, OPS-X3)', async () => {
    const user = userEvent.setup()
    render(<SistemaPage />)
    await user.click(screen.getByRole('button', { name: 'Limpar estado de prova' }))
    expect(mocks.post).not.toHaveBeenCalled()
    expect(await screen.findByText(/3 estados de tentativa sem entrega/)).toBeVisible()
    expect(screen.getByText(/1 com respostas não entregues/)).toBeVisible()
    expect(screen.getByText(/5 registros de monitoramento/)).toBeVisible()
    expect(mocks.get).toHaveBeenCalledWith(expect.stringContaining('studentClass=1DES'))

    const confirmButton = screen.getByRole('button', { name: 'Limpar estado' })
    expect(confirmButton).toBeDisabled()
    await user.type(screen.getByLabelText('Digite LIMPAR para confirmar'), 'LIMPAR')
    expect(confirmButton).toBeEnabled()
    await user.click(confirmButton)
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/flush-exam-state', expect.objectContaining({ studentClass: '1DES', courseId: 'DES', confirm: 'LIMPAR' })))
  })

  it('[UC-MANUT-001] limpeza fica travada com prova em andamento na turma', async () => {
    const user = userEvent.setup()
    mocks.get.mockResolvedValue(preview({ blocked: true }))
    render(<SistemaPage />)
    await user.click(screen.getByRole('button', { name: 'Limpar estado de prova' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Prova Z/)
    expect(screen.getByRole('button', { name: 'Limpar estado' })).toBeDisabled()
    expect(screen.queryByLabelText('Digite LIMPAR para confirmar')).not.toBeInTheDocument()
  })

  it('[UC-MANUT-001] "Reiniciar servidor" pede confirmação e avisa das provas em andamento (CONF-10)', async () => {
    const user = userEvent.setup()
    render(<SistemaPage />)
    await user.click(screen.getByRole('button', { name: 'Reiniciar servidor' }))
    expect(mocks.post).not.toHaveBeenCalled()
    expect(await screen.findByText(/1 prova em andamento/)).toBeVisible()
    expect(screen.getByText(/2DES · Prova X/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Reiniciar agora' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/server/restart', { confirm: 'REINICIAR' }))
  })

  it('[UC-MANUT-001] "Resetar sala" nomeia a turma, mostra as provas que serão encerradas e envia a confirmação ao servidor (CONF-X3)', async () => {
    const user = userEvent.setup()
    render(<SistemaPage />)
    expect(screen.getByText(/Só na turma 1DES/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Resetar sala' }))
    expect(await screen.findByText(/Prova W/)).toBeVisible()
    expect(screen.getByText(/4 tentativas em andamento/)).toBeVisible()
    expect(screen.getByText(/6 alunos desconectados/)).toBeVisible()
    await user.type(screen.getByLabelText('Digite RESETAR para confirmar'), 'RESETAR')
    await user.click(screen.getByRole('button', { name: 'Confirmar reset' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/reset', { studentClass: '1DES', courseId: 'DES', confirm: 'RESETAR' }))
  })
})
