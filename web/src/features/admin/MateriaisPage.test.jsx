import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

function mockServer({ released = {}, configs = {}, applications = [], releaseSchedule } = {}) {
  mocks.get.mockImplementation(async (url) => {
    if (url.includes('/structure')) return { structure: STRUCTURE }
    if (url.startsWith('/api/admin/exam-applications')) return { success: true, applications }
    return { releasedItems: released, releaseMeta: {}, onlineExamConfigs: configs, ...(releaseSchedule ? { releaseSchedule } : {}) }
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
  it('[UC-PROVA-008] "Agendar" na apostila bloqueada manda dia e hora no relógio da escola e mostra "Libera sozinho em"', async () => {
    const user = userEvent.setup()
    mockServer()
    render(<MateriaisPage />)
    const row = await screen.findByTestId('release-row-Apostila_U1')
    // A prova online não tem "Agendar" (abre pela aplicação).
    expect(within(screen.getByTestId('exam-row-Avaliacao_U1')).queryByRole('button', { name: /Agendar/ })).toBeNull()
    mocks.post.mockResolvedValueOnce({
      success: true,
      releaseSchedule: { Apostila_U1: { at: 1, atLabel: '24/11 às 07:30', atLocal: '2026-11-24T07:30', por: 'prof', adiado: false } },
      avisos: [{ code: 'nao_letivo', texto: '24/11 não tem aula. O item é liberado do mesmo jeito.' }],
    })
    await user.click(within(row).getByRole('button', { name: /Agendar a liberação: Apostila de Unidade 1/ }))
    await user.click(screen.getByRole('button', { name: 'Salvar horário' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Escolha o dia da liberação.')
    fireEvent.change(screen.getByLabelText('Dia'), { target: { value: '2026-11-24' } })
    fireEvent.change(screen.getByLabelText('Hora'), { target: { value: '07:30' } })
    await user.click(screen.getByRole('button', { name: 'Salvar horário' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/release-item', { studentClass: '1DES', courseId: 'DES', itemKey: 'Apostila_U1', releaseAtLocal: '2026-11-24T07:30' }))
    expect(mocks.toast.success).toHaveBeenCalledWith('Apostila agendado: libera em 24/11 às 07:30.')
    expect(mocks.toast.info).toHaveBeenCalledWith('24/11 não tem aula. O item é liberado do mesmo jeito.')
    expect(await screen.findByTestId('release-schedule-Apostila_U1')).toHaveTextContent('Libera sozinho em 24/11 às 07:30.')
    expect(within(row).getByText('Agendado')).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: /Agendar a liberação/ })).toBeNull()
  })

  it('[UC-PROVA-008] gabarito adiado avisa que sai no encerramento; cancelar e liberar na mão tiram a agenda', async () => {
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm')
    mockServer({
      applications: [{ id: 'app1', examKey: 'Avaliacao_U1', status: 'running', createdAt: '2026-11-20T10:00:00Z' }],
      releaseSchedule: {
        Gabarito_Avaliacao_U1: { at: 1, atLabel: '20/11 às 10:00', atLocal: '2026-11-20T10:00', adiado: true },
        Apostila_U2: { at: 2, atLabel: '25/11 às 07:30', atLocal: '2026-11-25T07:30', adiado: false },
      },
    })
    render(<MateriaisPage />)
    expect(await screen.findByTestId('release-schedule-Gabarito_Avaliacao_U1')).toHaveTextContent('Adiado: sai quando a prova for encerrada.')
    // Com a agenda, o aviso de "bloqueado pela prova" dá lugar ao do adiamento.
    expect(screen.queryByText(/Disponível depois que a aplicação/)).toBeNull()
    mocks.post.mockResolvedValueOnce({ success: true, releaseSchedule: { Apostila_U2: { at: 2, atLabel: '25/11 às 07:30', atLocal: '2026-11-25T07:30', adiado: false } } })
    await user.click(within(screen.getByTestId('release-schedule-Gabarito_Avaliacao_U1')).getByRole('button', { name: 'Cancelar' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/release-item', { studentClass: '1DES', courseId: 'DES', itemKey: 'Gabarito_Avaliacao_U1', cancelSchedule: true }))
    await waitFor(() => expect(screen.queryByTestId('release-schedule-Gabarito_Avaliacao_U1')).toBeNull())
    // Liberar a apostila agendada pelo interruptor: o servidor tira a agenda e devolve a nova.
    mocks.post.mockResolvedValueOnce({ success: true, releaseSchedule: {}, scheduleDropped: true })
    const row = screen.getByTestId('release-row-Apostila_U2')
    await user.click(within(row).getByRole('switch'))
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith('Liberado agora; o agendamento foi retirado'))
    expect(screen.queryByTestId('release-schedule-Apostila_U2')).toBeNull()
    expect(confirmSpy).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })
})
