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
    expect(screen.getByText(/Indisponível agora: a conexão segura \(https\) não está funcionando neste IClass/)).toBeInTheDocument()
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

// Fase 2, H6c (SEG-03, OPS-08): conexão segura na tela Sistema, só para o administrador.
const HTTPS_ON = {
  available: true,
  error: null,
  studentsHttps: false,
  studentsHttpsSetting: false,
  url: 'https://192.168.0.10:3000',
  ca: { fingerprintSha256: 'AB:CD:EF:01', validFrom: '2026-11-10T00:00:00.000Z', validTo: '2036-11-08T12:00:00.000Z', recreatedAt: null },
  server: { validFrom: '2026-11-10T00:00:00.000Z', validTo: '2027-12-12T00:00:00.000Z', names: ['localhost'], ips: ['127.0.0.1', '192.168.0.10'] },
}

describe('[UC-REDE-005] Sistema → Rede: conexão segura (https)', () => {
  function withHttps(httpsPatch = {}, settingsPatch = {}) {
    mocks.apiData['/api/admin/network-info'] = { ...NETWORK_INFO, https: { ...HTTPS_ON, ...httpsPatch } }
    mocks.apiData['/api/admin/network-settings'] = networkSettings({ httpsAvailable: httpsPatch.available !== false, httpsUrl: 'https://192.168.0.10:3000', studentsHttps: false, ...settingsPatch })
  }

  it('administrador vê a impressão digital, as validades, o download e o guia; "só com conexão segura" fica liberada', () => {
    withHttps()
    render(<RedeCard canManage isAdmin />)
    const section = screen.getByTestId('secure-connection-settings')
    expect(section).toHaveTextContent('Conexão segura (https)')
    expect(section).toHaveTextContent('funcionando')
    expect(screen.getByTestId('ca-fingerprint')).toHaveTextContent('AB:CD:EF:01')
    expect(screen.getByTestId('secure-url')).toHaveTextContent('https://192.168.0.10:3000')
    expect(section).toHaveTextContent('válido até 08/11/2036')
    expect(within(section).getByRole('link', { name: /Baixar certificado/ })).toHaveAttribute('href', '/iclass-ca.crt')
    expect(within(section).getByRole('link', { name: /Guia de instalação/ })).toHaveAttribute('href', '/certificado')
    expect(screen.getByRole('radio', { name: /Outros aparelhos só com conexão segura/ })).toBeEnabled()
    expect(screen.getByRole('radio', { name: /Outros aparelhos só com conexão segura/ }).closest('label')).toHaveTextContent('instale o certificado do IClass em cada aparelho')
    expect(screen.getByRole('checkbox', { name: /Alunos entram pela conexão segura/ })).not.toBeChecked()
    expect(screen.queryByTestId('ca-recreated')).toBeNull()
  })

  it('professor não vê a seção', () => {
    withHttps()
    render(<RedeCard canManage isAdmin={false} />)
    expect(screen.queryByTestId('secure-connection-settings')).toBeNull()
  })

  it('certificado recriado avisa que os aparelhos precisam instalar de novo', () => {
    withHttps({ ca: { ...HTTPS_ON.ca, recreatedAt: '2026-11-09T12:00:00.000Z' } })
    render(<RedeCard canManage isAdmin />)
    expect(screen.getByTestId('ca-recreated')).toHaveTextContent('precisam instalar este')
  })

  it('sem a conexão segura: mostra o motivo, sem download, e não deixa ligar para os alunos', () => {
    withHttps({ available: false, error: 'Conexão segura indisponível: sem permissão para gravar o certificado na pasta de dados (tls).', url: null, ca: null, server: null }, { httpsAvailable: false, httpsUrl: null })
    render(<RedeCard canManage isAdmin />)
    expect(screen.getByTestId('secure-connection-error')).toHaveTextContent('sem permissão para gravar o certificado')
    expect(screen.queryByRole('link', { name: /Baixar certificado/ })).toBeNull()
    expect(screen.getByRole('checkbox', { name: /Alunos entram pela conexão segura/ })).toBeDisabled()
    expect(screen.getByRole('radio', { name: /Outros aparelhos só com conexão segura/ })).toBeDisabled()
  })

  it('ligar o https dos alunos pede confirmação e salva { studentsHttps: true }', async () => {
    withHttps()
    const user = userEvent.setup()
    render(<RedeCard canManage isAdmin />)
    await user.click(screen.getByRole('checkbox', { name: /Alunos entram pela conexão segura/ }))
    await user.click(screen.getByRole('button', { name: 'Salvar conexão dos alunos' }))
    const dialog = await screen.findByRole('dialog')
    expect(mocks.post).not.toHaveBeenCalled()
    expect(dialog).toHaveTextContent('instale o certificado do IClass em cada aparelho dos alunos')
    await user.click(within(dialog).getByRole('button', { name: 'Ligar para os alunos' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/network-settings', { studentsHttps: true }))
    expect(mocks.refetch).toHaveBeenCalled()
  })

  it('desligar salva direto; a recusa por prova em andamento aparece no aviso', async () => {
    withHttps({ studentsHttps: true, studentsHttpsSetting: true }, { studentsHttps: true })
    mocks.post.mockRejectedValue(new Error('Há prova em andamento: Prova 1 (Turma A).'))
    const user = userEvent.setup()
    render(<RedeCard canManage isAdmin />)
    const box = screen.getByRole('checkbox', { name: /Alunos entram pela conexão segura/ })
    expect(box).toBeChecked()
    await user.click(box)
    await user.click(screen.getByRole('button', { name: 'Salvar conexão dos alunos' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/network-settings', { studentsHttps: false }))
    expect(mocks.toast.error).toHaveBeenCalledWith('Há prova em andamento: Prova 1 (Turma A).')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('em outro aparelho por http, "só com conexão segura" confirma e depois vai para o login no endereço seguro', async () => {
    withHttps({}, { thisComputer: false, secure: false })
    const assign = vi.fn()
    const original = window.location
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, assign } })
    try {
      const user = userEvent.setup()
      render(<RedeCard canManage isAdmin />)
      await user.click(screen.getByRole('radio', { name: /Outros aparelhos só com conexão segura/ }))
      await user.click(screen.getByRole('button', { name: 'Salvar acesso ao painel' }))
      const dialog = await screen.findByRole('dialog')
      expect(dialog).toHaveTextContent('https://192.168.0.10:3000')
      expect(within(dialog).getByRole('link', { name: '/certificado' })).toHaveAttribute('href', '/certificado')
      await user.click(within(dialog).getByRole('button', { name: 'Salvar e abrir o endereço seguro' }))
      await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/network-settings', { adminAccess: 'rede' }))
      await waitFor(() => expect(assign).toHaveBeenCalledWith('https://192.168.0.10:3000/login?mode=admin'))
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original })
    }
  })

  it('no computador do IClass, "só com conexão segura" salva direto, sem sair da tela', async () => {
    withHttps()
    const user = userEvent.setup()
    render(<RedeCard canManage isAdmin />)
    await user.click(screen.getByRole('radio', { name: /Outros aparelhos só com conexão segura/ }))
    await user.click(screen.getByRole('button', { name: 'Salvar acesso ao painel' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/network-settings', { adminAccess: 'rede' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mocks.refetch).toHaveBeenCalled()
  })
})
