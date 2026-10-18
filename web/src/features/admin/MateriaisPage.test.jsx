import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MateriaisPage, { batchReleaseKeys } from './MateriaisPage'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  navigate: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return { ...actual, useNavigate: () => mocks.navigate }
})
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
vi.mock('../../hooks/useAdminWorkspace', () => ({
  useAdminWorkspace: () => ({ courseId: 'DES', courseName: 'Técnico em TI', className: '1DES' }),
}))

const STRUCTURE = [{
  id: 'm1',
  name: 'Módulo 1',
  units: [
    { name: 'Unidade 1', apostilaKey: 'Apostila_U1', avaliacaoKey: 'Avaliacao_U1' },
    { name: 'Unidade 2', apostilaKey: 'Apostila_U2', avaliacaoKey: 'Avaliacao_U2' },
  ],
}]

function mockServer({ released = {}, configs = {} } = {}) {
  mocks.get.mockImplementation(async (url) => {
    if (url.includes('/structure')) return { structure: STRUCTURE }
    return { releasedItems: released, releaseMeta: {}, onlineExamConfigs: configs }
  })
  mocks.post.mockResolvedValue({ success: true })
}

describe('MateriaisPage', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(cleanup)

  it('[UC-APLICACAO-001] liberar em lote só libera apostilas e bloquear não mexe na prova online (AVA-X1)', () => {
    const items = [
      { key: 'Apostila_U1', type: 'Apostila' },
      { key: 'Avaliacao_U1', type: 'Prova online' },
      { key: 'Gabarito_Avaliacao_U1', type: 'Gabarito' },
    ]
    expect(batchReleaseKeys(items, true)).toEqual(['Apostila_U1'])
    expect(batchReleaseKeys(items, false)).toEqual(['Apostila_U1', 'Gabarito_Avaliacao_U1'])
  })

  it('[UC-APLICACAO-001] "Liberar todas as apostilas" não envia prova nem gabarito ao servidor', async () => {
    const user = userEvent.setup()
    mockServer()
    render(<MateriaisPage />)
    await user.click(await screen.findByRole('button', { name: 'Liberar todas as apostilas' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2))
    const sentKeys = mocks.post.mock.calls.map(([, body]) => body.itemKey)
    expect(sentKeys).toEqual(['Apostila_U1', 'Apostila_U2'])
    mocks.post.mock.calls.forEach(([url, body]) => {
      expect(url).toBe('/api/admin/release-item')
      expect(body.released).toBe(true)
    })
    expect(mocks.toast.info).toHaveBeenCalledWith(expect.stringMatching(/Provas e gabaritos não são liberados em lote/))
  })

  it('[UC-APLICACAO-001] prova em andamento aparece com o status e leva ao Monitor, sem chave de liga/desliga', async () => {
    const user = userEvent.setup()
    mockServer({ configs: { Avaliacao_U1: { status: 'running', applicationId: 'app-1' } } })
    render(<MateriaisPage />)
    expect(await screen.findByText('Em andamento')).toBeVisible()
    expect(screen.getByText('Não aplicada')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Abrir Monitor' }))
    expect(mocks.navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/monitor\?.*applicationId=app-1/))
    // Apostila e gabarito de cada unidade têm chave; a prova online não.
    expect(screen.getAllByRole('switch')).toHaveLength(4)
    // O gabarito da prova em andamento fica travado até ela ser encerrada.
    const unitOne = screen.getByText('Unidade 1').closest('.border-b')
    const switches = within(unitOne).getAllByRole('switch')
    expect(switches[switches.length - 1]).toBeDisabled()
    expect(within(unitOne).getByText('Disponível depois que a aplicação da prova for encerrada.')).toBeVisible()
  })
})
