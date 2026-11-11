import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RedeCard, networkAdapters } from './RedeCard'
import { NO_NETWORK_TEXT } from '../RoomAddress'

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
vi.mock('../../../lib/clipboard', () => ({ copyText: vi.fn(async () => 'copied') }))

// Formato do H6a (OPS-10): { recommended, addresses } com a url completa (com a porta).
const NETWORK_INFO = {
  port: 3000,
  recommended: { name: 'Wi-Fi', address: '192.168.0.10', kind: 'rede', url: 'http://192.168.0.10:3000' },
  addresses: [
    { name: 'Wi-Fi', address: '192.168.0.10', kind: 'rede', recommended: true, url: 'http://192.168.0.10:3000' },
    { name: 'Ethernet', address: '10.0.0.5', kind: 'rede', recommended: false, url: 'http://10.0.0.5:3000' },
    { name: 'vEthernet (WSL)', address: '172.20.48.1', kind: 'virtual', recommended: false, url: 'http://172.20.48.1:3000' },
    { name: 'Wi-Fi 2', address: '169.254.10.20', kind: 'link-local', recommended: false, url: 'http://169.254.10.20:3000' },
  ],
}
const ROOM = { success: true, studentUrl: 'http://192.168.0.10:3000', qr: { version: 1, size: 3, rows: ['101', '010', '111'] } }

function networkSettings(patch = {}) {
  return { adminAccess: 'rede-sem-https', modes: ['rede-sem-https', 'local', 'rede'], httpsAvailable: false, thisComputer: true, secure: false, ...patch }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.apiData = {
    '/api/admin/network-info': NETWORK_INFO,
    '/api/admin/room-address': ROOM,
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
    expect(screen.getByTestId('student-url')).toHaveTextContent('http://192.168.0.10:3000')
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
    expect(screen.getByTestId('student-url')).toHaveTextContent('http://192.168.0.10:3000')
    expect(screen.queryByTestId('admin-access-settings')).toBeNull()
  })
})

describe('[UC-REDE-002] Sistema → Rede: endereço completo para os alunos', () => {
  it('mostra o endereço com o esquema e a porta, o QR e os outros endereços da rede', () => {
    render(<RedeCard canManage={false} isAdmin={false} />)
    expect(screen.getByTestId('student-url')).toHaveTextContent('http://192.168.0.10:3000')
    expect(screen.getByRole('img', { name: 'QR code do endereço http://192.168.0.10:3000' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copiar endereço' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Projetar em tela cheia/ })).toHaveAttribute('href', '/endereco')
    expect(screen.getByText('http://10.0.0.5:3000')).toBeInTheDocument()
  })

  it('adaptadores virtuais e sem endereço da rede ficam recolhidos em "Outros adaptadores (não use)"', () => {
    const { container } = render(<RedeCard canManage={false} isAdmin={false} />)
    const details = container.querySelector('details')
    expect(details).not.toBeNull()
    expect(details.open).toBe(false)
    expect(within(details).getByText('Outros adaptadores (não use)')).toBeInTheDocument()
    expect(within(details).getByText('http://172.20.48.1:3000')).toBeInTheDocument()
    expect(within(details).getByText('http://169.254.10.20:3000')).toBeInTheDocument()
    expect(within(details).queryByText('http://10.0.0.5:3000')).toBeNull()
  })

  it('computador sem rede explica o que fazer, sem QR', () => {
    mocks.apiData['/api/admin/network-info'] = { port: 3000, recommended: null, addresses: [] }
    mocks.apiData['/api/admin/room-address'] = { success: true, studentUrl: null, qr: null }
    render(<RedeCard canManage={false} isAdmin={false} />)
    expect(screen.getByText(NO_NETWORK_TEXT)).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /QR code/ })).toBeNull()
    expect(screen.queryByTestId('student-url')).toBeNull()
  })

  it('tolera o formato antigo da lista ([{ name, address }])', () => {
    const old = networkAdapters([{ address: '192.168.0.10', name: 'Wi-Fi' }, { address: '10.0.0.5', name: 'Ethernet' }])
    expect(old.recommended).toEqual({ address: '192.168.0.10', name: 'Wi-Fi' })
    expect(old.network).toEqual([{ address: '10.0.0.5', name: 'Ethernet' }])
    expect(old.hidden).toEqual([])
    expect(networkAdapters(null)).toEqual({ recommended: null, network: [], hidden: [] })
  })
})
