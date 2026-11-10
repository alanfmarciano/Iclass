import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RedeCard } from './RedeCard'

// Fase 2, H6b (SEG-03): cartão Rede da tela Sistema. Mostra os endereços e, para quem
// gerencia o sistema, onde o painel do professor abre. Só o administrador troca.
const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  refetch: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  apiData: {},
}))

vi.mock('../../../lib/api', () => ({ api: { get: vi.fn(), post: mocks.post } }))
vi.mock('../../../hooks/useApi', () => ({ useApi: (path) => ({ data: (path && mocks.apiData[path]) || null, loading: false, error: null, refetch: mocks.refetch }) }))
vi.mock('../../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))

function networkSettings(patch = {}) {
  return { adminAccess: 'rede-sem-https', modes: ['rede-sem-https', 'local', 'rede'], httpsAvailable: false, thisComputer: true, secure: false, ...patch }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.apiData = {
    '/api/admin/network-info': [{ address: '192.168.0.10', name: 'Wi-Fi' }],
    '/api/admin/network-settings': networkSettings(),
  }
  mocks.post.mockResolvedValue({ success: true })
})
afterEach(cleanup)

describe('[UC-REDE-001] Sistema → Rede: onde o painel do professor abre', () => {
  it('administrador vê as três opções; a da conexão segura fica desligada e explica por quê', () => {
    render(<RedeCard canManage isAdmin />)
    // O título é o nome que a recusa do painel cita ("Sistema → Rede").
    expect(screen.getByRole('heading', { level: 2, name: 'Rede' })).toBeInTheDocument()
    expect(screen.getByText('192.168.0.10')).toBeInTheDocument()
    const open = screen.getByRole('radio', { name: /Todos os aparelhos da rede/ })
    expect(open).toBeChecked()
    expect(screen.getByRole('radio', { name: /Só o computador do IClass/ })).toBeEnabled()
    expect(screen.getByRole('radio', { name: /Outros aparelhos só com conexão segura/ })).toBeDisabled()
    expect(screen.getByText(/Ainda não disponível: esta versão do IClass ainda não tem a conexão segura/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Salvar acesso ao painel' })).toBeDisabled()
  })

  it('no computador do IClass, escolher "Só o computador do IClass" salva direto', async () => {
    const user = userEvent.setup()
    render(<RedeCard canManage isAdmin />)
    await user.click(screen.getByRole('radio', { name: /Só o computador do IClass/ }))
    await user.click(screen.getByRole('button', { name: 'Salvar acesso ao painel' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/network-settings', { adminAccess: 'local' }))
    expect(mocks.toast.success).toHaveBeenCalled()
    expect(mocks.refetch).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('em outro aparelho, "Só o computador do IClass" pede confirmação antes de salvar', async () => {
    mocks.apiData['/api/admin/network-settings'] = networkSettings({ thisComputer: false })
    const user = userEvent.setup()
    render(<RedeCard canManage isAdmin />)
    await user.click(screen.getByRole('radio', { name: /Só o computador do IClass/ }))
    await user.click(screen.getByRole('button', { name: 'Salvar acesso ao painel' }))
    const dialog = await screen.findByRole('dialog')
    expect(mocks.post).not.toHaveBeenCalled()
    expect(dialog).toHaveTextContent('Este aparelho sai do painel na hora')
    await user.click(within(dialog).getByRole('button', { name: 'Salvar mesmo assim' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/network-settings', { adminAccess: 'local' }))
  })

  it('recusa do servidor aparece no aviso', async () => {
    mocks.post.mockRejectedValue(new Error('Só o administrador pode mudar onde o painel do professor abre.'))
    const user = userEvent.setup()
    render(<RedeCard canManage isAdmin />)
    await user.click(screen.getByRole('radio', { name: /Só o computador do IClass/ }))
    await user.click(screen.getByRole('button', { name: 'Salvar acesso ao painel' }))
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Só o administrador pode mudar onde o painel do professor abre.'))
  })

  it('professor vê a regra em uso, sem opções para trocar', () => {
    mocks.apiData['/api/admin/network-settings'] = networkSettings({ adminAccess: 'local' })
    render(<RedeCard canManage isAdmin={false} />)
    expect(screen.getByText(/Em uso:/)).toHaveTextContent('Só o computador do IClass')
    expect(screen.getByText(/Só o administrador muda esta opção/)).toBeInTheDocument()
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Salvar' })).toBeNull()
  })

  it('sem "Executar manutenção" o cartão mostra só os endereços', () => {
    render(<RedeCard canManage={false} isAdmin={false} />)
    expect(screen.getByText('192.168.0.10')).toBeInTheDocument()
    expect(screen.queryByTestId('admin-access-settings')).toBeNull()
  })
})
