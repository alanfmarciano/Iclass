import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RETENTION_ADMIN_ONLY, RETENTION_NEVER_DELETED, RETENTION_NOT_REVIEWED, RetencaoCard, lastRunText, retentionPreviewText } from './RetencaoCard'

const mocks = vi.hoisted(() => ({
  results: {},
  refetch: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  calls: [],
}))

vi.mock('../../../hooks/useApi', () => ({
  useApi: (path) => { mocks.calls.push(path); return { data: null, error: null, ...(mocks.results[path] || {}), loading: false, refetch: mocks.refetch } },
}))
vi.mock('../../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }))
vi.mock('../../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))

function payload(extra = {}) {
  return {
    success: true,
    settings: { proctoringDays: 0, loginLogsDays: 0, trashDays: 0, reviewedAt: null, reviewedBy: null },
    limits: {},
    recommended: { proctoringDays: 180, loginLogsDays: 365, trashDays: 30 },
    reviewed: false,
    lastRun: null,
    activeApplications: 0,
    volume: { keystrokes: 1200, proctoringLogs: 40, loginLogs: 300, trash: 2 },
    preview: { values: { proctoringDays: 0, loginLogsDays: 0, trashDays: 0 }, counts: { keystrokes: 0, proctoringLogs: 0, loginLogs: 0, trash: 0 } },
    ...extra,
  }
}

describe('[UC-LGPD-008] RetencaoCard · Retenção de dados', () => {
  beforeEach(() => {
    mocks.results = {}
    mocks.calls.length = 0
    mocks.get.mockReset()
    mocks.post.mockReset()
    mocks.refetch.mockReset()
  })
  afterEach(() => { cleanup(); vi.clearAllMocks() })

  it('prazos não revisados: aviso, o que nunca é apagado, prévia e "Usar prazos recomendados" pede a prévia', async () => {
    const user = userEvent.setup()
    mocks.results['/api/admin/lgpd/retention'] = { data: payload() }
    mocks.get.mockResolvedValue({ success: true, values: { proctoringDays: 180, loginLogsDays: 365, trashDays: 30 }, counts: { keystrokes: 900, proctoringLogs: 12, loginLogs: 1, trash: 2 }, adjusted: [] })
    render(<RetencaoCard isAdmin />)
    expect(mocks.calls[0]).toBe('/api/admin/lgpd/retention')
    expect(screen.getByText(`${RETENTION_NOT_REVIEWED}.`)).toBeVisible()
    expect(screen.getByText(RETENTION_NEVER_DELETED)).toBeVisible()
    expect(screen.getByTestId('retention-preview')).toHaveTextContent('Com estes prazos, a próxima limpeza apaga 0 teclas, 0 saídas de tela, 0 registros de acesso e 0 itens da lixeira.')
    expect(screen.getByTestId('retention-last-run')).toHaveTextContent('Nenhuma limpeza feita ainda.')
    expect(screen.getByRole('button', { name: 'Limpar agora' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Usar prazos recomendados' }))
    expect(screen.getByLabelText('Monitoramento da prova')).toHaveValue(180)
    expect(screen.getByLabelText('Registros de acesso')).toHaveValue(365)
    expect(screen.getByLabelText('Lixeira')).toHaveValue(30)
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/admin/lgpd/retention/preview?proctoringDays=180&loginLogsDays=365&trashDays=30', { background: true }))
    await waitFor(() => expect(screen.getByTestId('retention-preview')).toHaveTextContent('apaga 900 teclas, 12 saídas de tela, 1 registro de acesso e 2 itens da lixeira.'))
    expect(screen.getByRole('button', { name: 'Limpar agora' })).toBeDisabled()

    mocks.post.mockResolvedValue({ ...payload({ reviewed: true, settings: { proctoringDays: 180, loginLogsDays: 365, trashDays: 30, reviewedAt: '2026-11-11T10:00:00Z', reviewedBy: 'admin@x' } }), adjusted: [] })
    await user.click(screen.getByRole('button', { name: 'Salvar prazos' }))
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/lgpd/retention', { proctoringDays: 180, loginLogsDays: 365, trashDays: 30 })
    expect(mocks.toast.success).toHaveBeenCalledWith('Prazos de retenção salvos.')
    expect(mocks.refetch).toHaveBeenCalled()
  })

  it('valor abaixo do mínimo: o servidor ajusta e a tela avisa; prévia inválida mostra o erro', async () => {
    const user = userEvent.setup()
    mocks.results['/api/admin/lgpd/retention'] = { data: payload({ reviewed: true, settings: { proctoringDays: 180, loginLogsDays: 365, trashDays: 30, reviewedAt: 'x', reviewedBy: 'a' } }) }
    mocks.get.mockRejectedValue(new Error('Informe o prazo de monitoramento da prova em dias inteiros, de 0 a 3.650 (0 = não apagar).'))
    render(<RetencaoCard isAdmin />)
    expect(screen.queryByText(`${RETENTION_NOT_REVIEWED}.`)).not.toBeInTheDocument()
    const field = screen.getByLabelText('Monitoramento da prova')
    await user.clear(field)
    await user.type(field, '99999')
    await waitFor(() => expect(screen.getByTestId('retention-preview')).toHaveTextContent('dias inteiros, de 0 a 3.650'))

    mocks.post.mockResolvedValue({ ...payload({ reviewed: true, settings: { proctoringDays: 30, loginLogsDays: 365, trashDays: 30, reviewedAt: 'x', reviewedBy: 'a' } }), adjusted: [{ field: 'proctoringDays', value: 30, message: 'O prazo de monitoramento da prova subiu para 30 dias, o mínimo.' }] })
    await user.clear(field)
    await user.type(field, '7')
    await user.click(screen.getByRole('button', { name: 'Salvar prazos' }))
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/lgpd/retention', { proctoringDays: 7, loginLogsDays: 365, trashDays: 30 })
    expect(mocks.toast.info).toHaveBeenCalledWith('O prazo de monitoramento da prova subiu para 30 dias, o mínimo.')
  })

  it('"Limpar agora" pede APAGAR; com prova em andamento fica desligado com o aviso', async () => {
    const user = userEvent.setup()
    const saved = { proctoringDays: 180, loginLogsDays: 365, trashDays: 30, reviewedAt: 'x', reviewedBy: 'a' }
    const lastRun = { at: '2026-11-11T13:00:00Z', trigger: 'manual', by: 'admin@escola', counts: { keystrokes: 5, proctoringLogs: 3, loginLogs: 1, trash: 1 }, remaining: { keystrokes: 0, proctoringLogs: 0, loginLogs: 0 } }
    mocks.results['/api/admin/lgpd/retention'] = { data: payload({ reviewed: true, settings: saved, preview: { counts: { keystrokes: 5, proctoringLogs: 3, loginLogs: 1, trash: 1 } } }) }
    render(<RetencaoCard isAdmin />)
    const run = screen.getByRole('button', { name: 'Limpar agora' })
    expect(run).toBeEnabled()
    await user.click(run)
    const apagar = screen.getByRole('button', { name: 'Apagar' })
    expect(apagar).toBeDisabled()
    expect(screen.getByText('Esta limpeza apaga 5 teclas, 3 saídas de tela, 1 registro de acesso e 1 item da lixeira.')).toBeVisible()
    await user.type(screen.getByLabelText('Digite APAGAR para confirmar'), 'apagar')
    mocks.post.mockResolvedValue({ ...payload({ reviewed: true, settings: saved, lastRun }), counts: lastRun.counts, remaining: lastRun.remaining })
    await user.click(screen.getByRole('button', { name: 'Apagar' }))
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/lgpd/retention/run', { confirm: 'APAGAR' }, { timeoutMs: 0 })
    expect(mocks.toast.success).toHaveBeenCalledWith(expect.stringContaining('apagou 5 teclas, 3 saídas de tela, 1 registros de acesso e 1 itens da lixeira'))
    cleanup()

    mocks.results['/api/admin/lgpd/retention'] = { data: payload({ reviewed: true, settings: saved, activeApplications: 1, lastRun }) }
    render(<RetencaoCard isAdmin />)
    expect(screen.getByRole('button', { name: 'Limpar agora' })).toBeDisabled()
    expect(screen.getByText('Há prova em andamento; a limpeza roda quando ela terminar.')).toBeVisible()
    expect(screen.getByTestId('retention-last-run')).toHaveTextContent('(pedida por admin@escola)')
  })

  it('professor: cartão desligado, sem chamar a rota do administrador', () => {
    mocks.results['/api/admin/settings'] = { data: { retention: { proctoringDays: 180, loginLogsDays: 0 }, trash: { retentionDays: 30 } } }
    render(<RetencaoCard isAdmin={false} />)
    expect(mocks.calls).toEqual(['/api/admin/settings'])
    expect(screen.getByText(`${RETENTION_ADMIN_ONLY}.`)).toBeVisible()
    expect(screen.getByLabelText('Monitoramento da prova')).toBeDisabled()
    expect(screen.getByLabelText('Monitoramento da prova')).toHaveValue(180)
    expect(screen.getByLabelText('Lixeira')).toHaveValue(30)
    expect(screen.queryByRole('button', { name: 'Salvar prazos' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Limpar agora' })).not.toBeInTheDocument()
  })

  it('textos da prévia e da última limpeza (automática, com sobra)', () => {
    expect(retentionPreviewText({ keystrokes: 1, proctoringLogs: 2, loginLogs: 20000, trash: 0 })).toBe('Com estes prazos, a próxima limpeza apaga 1 tecla, 2 saídas de tela, 20.000 registros de acesso e 0 itens da lixeira.')
    expect(lastRunText({ at: '2026-11-11T03:00:00Z', trigger: 'automatic', counts: { keystrokes: 20000, proctoringLogs: 0, loginLogs: 0 }, remaining: { keystrokes: 15 } }))
      .toMatch(/\(automática\), apagou 20\.000 teclas, 0 saídas de tela, 0 registros de acesso\. Ficou sobra para a próxima hora\.$/)
  })
})
