import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TarefasPage from './TarefasPage'

// Tela Tarefas (fase 3, C7 / P1-e; FUN-01). Antes do C7 não havia tela: /tarefas (o link
// da fila "Precisa de você") caía no Dashboard.
const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  refetch: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  auth: { accountRole: 'professor' },
  paths: [],
  lists: {},
}))

vi.mock('../../lib/api', () => ({ api: { post: mocks.post, get: vi.fn() } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: mocks.auth }) }))
vi.mock('../../hooks/useAdminWorkspace', () => ({
  useAdminWorkspace: () => ({ courseId: 'DES', courseName: 'Desenvolvimento', className: '1DES' }),
}))
vi.mock('../../hooks/useApi', () => ({
  useApi: (path) => {
    mocks.paths.push(path)
    const status = new URLSearchParams(String(path || '').split('?')[1] || '').get('status')
    return { data: { success: true, assignments: mocks.lists[status] || [], serverNow: NOW, timezone: 'America/Sao_Paulo' }, loading: false, error: null, refetch: mocks.refetch }
  },
}))

const NOW = Date.UTC(2026, 11, 2, 15, 0)
const DAY = 24 * 3600 * 1000

function task(id, extra = {}) {
  return {
    id,
    title: `Tarefa ${id}`,
    status: 'publicada',
    dueAt: NOW + 2 * DAY + 60000,
    opensAt: null,
    closeAt: null,
    publishedAt: 1,
    local: { dueDate: '2026-12-04', dueTime: '12:01', opensDate: '', opensTime: '', closeDate: '', closeTime: '' },
    counts: { alunos: 20, enviadas: 5, paraCorrigir: 3, atrasadas: 1, naoEntregues: 15, devolvidas: 2 },
    ...extra,
  }
}

function Where() {
  const location = useLocation()
  return <p data-testid="where">{location.pathname}{location.search}</p>
}

function renderAt(url = '/tarefas') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/tarefas" element={<><TarefasPage /><Where /></>} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
}

const cardOf = (title) => screen.getByRole('link', { name: title }).closest('li')

beforeEach(() => {
  mocks.auth = { accountRole: 'professor' }
  mocks.paths = []
  mocks.post.mockResolvedValue({ success: true, changed: true })
  mocks.lists = {
    ativas: [
      task('asg_1_aaaaaa', { title: 'Relatório de redes' }),
      task('asg_2_bbbbbb', { title: 'Projeto integrador', status: 'rascunho', dueAt: null, publishedAt: null, local: {}, counts: { alunos: 20, enviadas: 0, paraCorrigir: 0, atrasadas: 0, naoEntregues: 20, devolvidas: 0 } }),
      task('asg_3_cccccc', { title: 'Lista de exercícios', counts: { alunos: 20, enviadas: 20, paraCorrigir: 0, atrasadas: 0, naoEntregues: 0, devolvidas: 20 } }),
    ],
    arquivada: [task('asg_4_dddddd', { title: 'Tarefa antiga', status: 'arquivada' })],
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Tarefas', () => {
  it('lista a turma em cartões com a situação, o prazo no relógio da escola e as contagens', () => {
    renderAt()
    expect(mocks.paths).toContain('/api/admin/assignments?courseId=DES&studentClass=1DES&status=ativas')
    const card = cardOf('Relatório de redes')
    expect(within(card).getByText('Publicada')).toBeInTheDocument()
    expect(within(card).getByText('Prazo: sex., 04/12/2026 às 12:01 (faltam 2 dias)')).toBeInTheDocument()
    expect(within(card).getByText('Para corrigir 3 · Atrasadas 1 · Sem envio 15')).toBeInTheDocument()
    const draft = cardOf('Projeto integrador')
    expect(within(draft).getByText('Rascunho')).toBeInTheDocument()
    expect(within(draft).getByText('Sem prazo definido')).toBeInTheDocument()
    expect(within(draft).queryByText(/Para corrigir/)).not.toBeInTheDocument()
    expect(within(draft).getByRole('button', { name: 'Publicar a tarefa Projeto integrador' })).toBeInTheDocument()
    // Com entrega não aparece "Excluir" (o servidor recusaria: arquive).
    expect(within(card).queryByRole('button', { name: /Excluir/ })).not.toBeInTheDocument()
    expect(within(draft).getByRole('button', { name: 'Excluir a tarefa Projeto integrador' })).toBeInTheDocument()
  })

  it('o link da fila "Precisa de você" (?filtro=para-corrigir) abre só as tarefas com entrega para corrigir', () => {
    renderAt('/tarefas?filtro=para-corrigir')
    expect(screen.getByRole('link', { name: 'Relatório de redes' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Projeto integrador' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Lista de exercícios' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Mostrar')).toHaveValue('para-corrigir')
  })

  it('filtro e aba Arquivadas, que pede a lista arquivada ao servidor e oferece Reativar', async () => {
    const user = userEvent.setup()
    renderAt()
    await user.selectOptions(screen.getByLabelText('Mostrar'), 'rascunho')
    expect(screen.getByTestId('where')).toHaveTextContent('/tarefas?filtro=rascunho')
    expect(screen.queryByRole('link', { name: 'Relatório de redes' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Projeto integrador' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Arquivadas' }))
    expect(mocks.paths).toContain('/api/admin/assignments?courseId=DES&studentClass=1DES&status=arquivada')
    const card = cardOf('Tarefa antiga')
    await user.click(within(card).getByRole('button', { name: 'Reativar a tarefa Tarefa antiga' }))
    const dialog = await screen.findByRole('dialog', { name: 'Reativar a tarefa?' })
    await user.click(within(dialog).getByRole('button', { name: 'Reativar' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/assignments/asg_4_dddddd/unarchive', {}))
    expect(mocks.refetch).toHaveBeenCalled()
  })

  it('publicar, arquivar e excluir confirmam antes; a recusa do servidor aparece no diálogo', async () => {
    const user = userEvent.setup()
    renderAt()
    await user.click(screen.getByRole('button', { name: 'Arquivar a tarefa Relatório de redes' }))
    expect(mocks.post).not.toHaveBeenCalled()
    let dialog = await screen.findByRole('dialog', { name: 'Arquivar a tarefa?' })
    await user.click(within(dialog).getByRole('button', { name: 'Arquivar' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/assignments/asg_1_aaaaaa/archive', {}))

    await user.click(screen.getByRole('button', { name: 'Publicar a tarefa Projeto integrador' }))
    dialog = await screen.findByRole('dialog', { name: 'Publicar a tarefa?' })
    await user.click(within(dialog).getByRole('button', { name: 'Publicar' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/assignments/asg_2_bbbbbb/publish', {}))

    mocks.post.mockRejectedValueOnce(Object.assign(new Error('Esta tarefa já tem entregas ou registros de alunos e não pode ser excluída. Arquive a tarefa para ela sumir para os alunos.'), { status: 409 }))
    await user.click(screen.getByRole('button', { name: 'Excluir a tarefa Projeto integrador' }))
    dialog = await screen.findByRole('dialog', { name: 'Excluir a tarefa?' })
    await user.click(within(dialog).getByRole('button', { name: 'Excluir' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/assignments/asg_2_bbbbbb/delete', { confirm: 'EXCLUIR' }))
    expect(await within(dialog).findByText(/não pode ser excluída/)).toBeInTheDocument()
  })

  it('"Nova tarefa" e "Editar" abrem o formulário', async () => {
    const user = userEvent.setup()
    renderAt()
    expect(screen.getByRole('link', { name: 'Editar a tarefa Relatório de redes' })).toHaveAttribute('href', '/tarefas/asg_1_aaaaaa/editar')
    expect(screen.getByRole('link', { name: 'Relatório de redes' })).toHaveAttribute('href', '/tarefas/asg_1_aaaaaa/editar')
    await user.click(screen.getByRole('button', { name: 'Nova tarefa' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/tarefas/nova')
  })

  it('conta só de consulta (Coordenação) vê a lista sem os botões de mudar', () => {
    mocks.auth = { accountRole: 'coordenacao', readOnly: true }
    renderAt()
    expect(screen.queryByRole('button', { name: 'Nova tarefa' })).not.toBeInTheDocument()
    const card = cardOf('Relatório de redes')
    expect(within(card).queryByRole('button', { name: /Arquivar|Publicar|Excluir/ })).not.toBeInTheDocument()
    expect(within(card).getByRole('link', { name: 'Ver a tarefa Relatório de redes' })).toHaveAttribute('href', '/tarefas/asg_1_aaaaaa/editar')
  })

  it('turma sem tarefa mostra o convite para criar a primeira', () => {
    mocks.lists = { ativas: [] }
    renderAt()
    expect(screen.getByText('Nenhuma tarefa nesta turma')).toBeInTheDocument()
  })
})
