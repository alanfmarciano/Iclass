import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MateriaisPage, { batchReleaseKeys, examApplicationState } from './MateriaisPage'

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

function mockServer({ released = {}, configs = {}, applications = [] } = {}) {
  mocks.get.mockImplementation(async (url) => {
    if (url.includes('/structure')) return { structure: STRUCTURE }
    if (url.startsWith('/api/admin/exam-applications')) return { success: true, applications }
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
    mockServer({
      configs: { Avaliacao_U1: { status: 'running', applicationId: 'app-1' } },
      applications: [{ id: 'app-1', examKey: 'Avaliacao_U1', status: 'running', createdAt: '2026-10-18T10:00:00Z' }],
    })
    render(<MateriaisPage />)
    expect(await screen.findByText('Em andamento')).toBeVisible()
    expect(mocks.get).toHaveBeenCalledWith('/api/admin/exam-applications?studentClass=1DES&courseId=DES')
    expect(screen.getByText('Não aplicada')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Abrir Monitor' }))
    expect(mocks.navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/monitor\?.*applicationId=app-1/))
    // Apostila e gabarito de cada unidade têm chave; a prova online não.
    expect(screen.getAllByRole('switch')).toHaveLength(4)
    // O gabarito da prova em andamento fica travado até ela ser encerrada.
    const unitOne = screen.getByText('Unidade 1').closest('.border-b')
    const switches = within(unitOne).getAllByRole('switch')
    expect(switches[switches.length - 1]).toBeDisabled()
    expect(within(unitOne).getByText('Disponível depois que a aplicação da prova for encerrada no Monitor.')).toBeVisible()
    // No celular o selo e o botão descem para a linha de baixo em vez de espremer o texto.
    const row = screen.getByTestId('exam-row-Avaliacao_U1')
    expect(row.className).toContain('flex-wrap')
    expect(within(row).getByText(/Controlada pelo Monitor/).parentElement.className).toContain('min-w-[12rem]')
    expect(within(row).getByRole('button', { name: 'Abrir Monitor' }).parentElement.className).toContain('ml-auto')
  })

  it('[UC-APLICACAO-001] aplicação só preparada: texto de preparada, Monitor da aplicação e gabarito com o motivo certo', async () => {
    const user = userEvent.setup()
    mockServer({ applications: [{ id: 'app-prep', examKey: 'Avaliacao_U1', status: 'prepared', createdAt: '2026-10-18T10:00:00Z' }] })
    render(<MateriaisPage />)
    expect(await screen.findByText('Preparada')).toBeVisible()
    const row = screen.getByTestId('exam-row-Avaliacao_U1')
    expect(within(row).getByText(/Preparada e ainda sem alunos/)).toBeVisible()
    expect(within(row).queryByText(/salvando ou desconsiderando/)).not.toBeInTheDocument()
    expect(screen.getByText('Bloqueado: a prova tem uma aplicação preparada. Libere depois que ela for encerrada no Monitor.')).toBeVisible()
    await user.click(within(row).getByRole('button', { name: 'Abrir Monitor' }))
    expect(mocks.navigate).toHaveBeenCalledWith(expect.stringMatching(/applicationId=app-prep/))
  })

  it('[UC-APLICACAO-001] configuração antiga "preparada" sem aplicação não trava o gabarito nem leva ao Monitor', async () => {
    const user = userEvent.setup()
    mockServer({ configs: { Avaliacao_U1: { status: 'prepared', onlineActive: false } }, applications: [] })
    render(<MateriaisPage />)
    const row = await screen.findByTestId('exam-row-Avaliacao_U1')
    expect(within(row).getByText('Não aplicada')).toBeVisible()
    expect(screen.queryByText('Preparada')).not.toBeInTheDocument()
    const unitOne = screen.getByText('Unidade 1').closest('.border-b')
    const switches = within(unitOne).getAllByRole('switch')
    expect(switches[switches.length - 1]).toBeEnabled()
    await user.click(within(row).getByRole('button', { name: 'Ir para Provas' }))
    expect(mocks.navigate).toHaveBeenCalledWith('/provas')
  })

  it('situação da prova vem da aplicação mais recente; cancelada não conta', () => {
    const applications = [
      { id: 'a1', examKey: 'Avaliacao_U1', status: 'finished', createdAt: '2026-10-01T10:00:00Z' },
      { id: 'a2', examKey: 'Avaliacao_U1', status: 'cancelled', createdAt: '2026-10-02T10:00:00Z' },
      { id: 'a3', examKey: 'Avaliacao_U2', status: 'cancelled', createdAt: '2026-10-02T10:00:00Z' },
    ]
    expect(examApplicationState(applications, 'Avaliacao_U1')).toEqual({ status: 'finished', applicationId: 'a1' })
    expect(examApplicationState(applications, 'Avaliacao_U2')).toEqual({ status: 'none', applicationId: null })
    expect(examApplicationState([...applications, { id: 'a4', examKey: 'Avaliacao_U1', status: 'paused', createdAt: '2026-09-01T10:00:00Z' }], 'Avaliacao_U1'))
      .toEqual({ status: 'paused', applicationId: 'a4' })
  })
})
