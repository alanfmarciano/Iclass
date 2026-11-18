import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RoomAddressButton, NO_NETWORK_TEXT } from './RoomAddress'
import EnderecoSalaPage, { ROOM_ADDRESS_POLL_MS } from './EnderecoSalaPage'

// Fase 2, H6a (OPS-10): o botão "Endereço da sala" do Dashboard e do Monitor e a página
// /endereco mostram o endereço completo (com a porta) e o QR code. Antes não existiam: o
// professor só achava o IP sem porta em Sistema, e os alunos digitavam e caíam na porta 80.
const mocks = vi.hoisted(() => ({
  apiData: {},
  calls: [],
  copyText: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

vi.mock('../../hooks/useApi', () => ({
  useApi: (path, deps, options) => {
    mocks.calls.push({ path, options })
    return { data: (path && mocks.apiData[path]) || null, loading: false, error: null, refetch: vi.fn() }
  },
}))
vi.mock('../../lib/clipboard', () => ({ copyText: mocks.copyText }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))

const ROOM = {
  success: true,
  studentUrl: 'http://192.168.0.10:3000',
  nameUrl: null,
  qr: { version: 1, size: 3, rows: ['101', '010', '111'] },
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.calls = []
  mocks.apiData = { '/api/admin/room-address': ROOM }
  mocks.copyText.mockResolvedValue('copied')
})
afterEach(cleanup)

describe('[UC-REDE-002] Endereço da sala', () => {
  it('o botão só consulta o servidor ao abrir e mostra o endereço com a porta e o QR', async () => {
    const user = userEvent.setup()
    render(<MemoryRouter><RoomAddressButton /></MemoryRouter>)
    expect(mocks.calls.every((call) => call.path === null)).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Endereço da sala' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByTestId('room-address-url')).toHaveTextContent('http://192.168.0.10:3000')
    // Na tela estreita o endereço só quebra depois de "//" ou antes de ":3000".
    expect(within(dialog).getByTestId('room-address-url').innerHTML).toBe('http://<wbr>192.168.0.10<wbr>:3000')
    expect(within(dialog).getByRole('img', { name: 'QR code do endereço http://192.168.0.10:3000' })).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: /Projetar em tela cheia/ })).toHaveAttribute('href', '/endereco')
    await user.click(within(dialog).getByRole('button', { name: 'Copiar endereço' }))
    await waitFor(() => expect(mocks.copyText).toHaveBeenCalledWith('http://192.168.0.10:3000'))
    expect(mocks.toast.success).toHaveBeenCalledWith('Endereço copiado')
  })

  it('sem como copiar, o endereço aparece selecionado para o Ctrl+C', async () => {
    mocks.copyText.mockResolvedValue('manual')
    const user = userEvent.setup()
    render(<MemoryRouter><RoomAddressButton /></MemoryRouter>)
    await user.click(screen.getByRole('button', { name: 'Endereço da sala' }))
    await user.click(await screen.findByRole('button', { name: 'Copiar endereço' }))
    const manual = await screen.findByRole('dialog', { name: 'Selecione e copie (Ctrl+C)' })
    const field = within(manual).getByLabelText('Endereço da sala')
    expect(field).toHaveValue('http://192.168.0.10:3000')
    expect(field).toHaveAttribute('readonly')
    expect(mocks.toast.success).not.toHaveBeenCalled()
  })

  it('computador sem rede: explica em vez de mostrar QR', async () => {
    mocks.apiData['/api/admin/room-address'] = { success: true, studentUrl: null, qr: null }
    const user = userEvent.setup()
    render(<MemoryRouter><RoomAddressButton /></MemoryRouter>)
    await user.click(screen.getByRole('button', { name: 'Endereço da sala' }))
    expect(await screen.findByText(NO_NETWORK_TEXT)).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /QR code/ })).toBeNull()
  })

  it('a página /endereco mostra o endereço em tela cheia e atualiza a cada 30 s', () => {
    render(<MemoryRouter><EnderecoSalaPage /></MemoryRouter>)
    expect(screen.getByRole('heading', { level: 1, name: 'Entre no IClass' })).toBeInTheDocument()
    expect(screen.getByTestId('room-address-url')).toHaveTextContent('http://192.168.0.10:3000')
    expect(screen.getByRole('img', { name: /QR code do endereço/ })).toBeInTheDocument()
    expect(ROOM_ADDRESS_POLL_MS).toBe(30000)
    expect(mocks.calls.some((call) => call.path === '/api/admin/room-address' && call.options?.pollMs === 30000)).toBe(true)
    expect(screen.getByRole('link', { name: /Voltar ao painel/ })).toHaveAttribute('href', '/')
  })
})
