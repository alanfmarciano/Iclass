import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TarefaForm from './TarefaForm'

// Formulário "Nova tarefa" / "Editar tarefa" (fase 3, C7 / P1-e; FUN-01, D6, D8 e D17).
const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  auth: { accountRole: 'professor' },
  paths: [],
  assignment: null,
  roster: [],
}))

const OPTIONS = {
  success: true,
  courseId: 'DES',
  studentClass: '1DES',
  timezone: 'America/Sao_Paulo',
  fileTypes: [
    { key: 'pdf', label: 'PDF', extensions: ['.pdf'] },
    { key: 'image', label: 'Imagem (foto)', extensions: ['.jpg', '.jpeg', '.png', '.webp'] },
    { key: 'code', label: 'Código e texto', extensions: ['.txt', '.py', '.html', '.c'] },
  ],
  blockedExtensions: ['.exe', '.bat'],
  lateModes: ['aceitar', 'desconto', 'bloquear'],
  limits: { titleMin: 3, titleMax: 160, instructionsMax: 10000, libraryIdsMax: 10, maxFilesMin: 1, maxFilesMax: 10, maxSizeMbMin: 1, maxSizeMbMax: 20, maxMbPorEnvio: 50, extraExtensionsMax: 10, reasonMin: 3, reasonMax: 500 },
  defaults: { response: { files: true, text: false, link: false }, files: { maxFiles: 5, maxSizeMb: 10, types: ['pdf', 'image'], extraExtensions: [] }, latePolicy: { mode: 'aceitar', penaltyPerDayPct: 10, penaltyMaxPct: 50 }, countsInAverage: true, dueTime: '23:59' },
  modules: [{ id: 'm1', name: 'Módulo 1', units: [{ key: 'Apostila_m1_1', keys: ['Apostila_m1_1'], name: 'Redes' }] }],
  library: [{ id: 'lib_1', name: 'Guia do laboratório', kind: 'file', moduleId: '' }],
}

vi.mock('../../../lib/api', () => ({ api: { post: mocks.post, get: vi.fn() } }))
vi.mock('../../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
vi.mock('../../../context/AuthProvider', () => ({ useAuth: () => ({ auth: mocks.auth }) }))
vi.mock('../../../hooks/useAdminWorkspace', () => ({
  useAdminWorkspace: () => ({ courseId: 'DES', courseName: 'Desenvolvimento', className: '1DES' }),
}))
vi.mock('../../../hooks/useApi', () => ({
  useApi: (path) => {
    if (path) mocks.paths.push(path)
    if (!path) return { data: null, loading: false, error: null, refetch: vi.fn() }
    if (path.startsWith('/api/admin/assignments/form-options')) return { data: OPTIONS, loading: false, error: null, refetch: vi.fn() }
    return { data: { success: true, assignment: mocks.assignment, roster: mocks.roster }, loading: false, error: null, refetch: vi.fn() }
  },
}))

function Where() {
  const location = useLocation()
  return <p data-testid="where">{location.pathname}</p>
}

function renderAt(url) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/tarefas/nova" element={<TarefaForm />} />
        <Route path="/tarefas/:id/editar" element={<TarefaForm />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
}

const SAVED = {
  id: 'asg_1_aaaaaa',
  courseId: 'DES',
  studentClass: '1DES',
  title: 'Relatório de redes',
  instructions: 'Envie o **relatório**.',
  moduleId: 'm1',
  unitKey: 'Apostila_m1_1',
  libraryIds: [],
  status: 'publicada',
  response: { files: true, text: false, link: false },
  files: { maxFiles: 3, maxSizeMb: 8, types: ['pdf'], extraExtensions: ['.pkt'] },
  latePolicy: { mode: 'aceitar', penaltyPerDayPct: 10, penaltyMaxPct: 50 },
  countsInAverage: true,
  opensAt: null,
  dueAt: 1796436000000,
  closeAt: null,
  publishedAt: 1,
  local: { opensDate: '', opensTime: '', dueDate: '2026-12-04', dueTime: '23:00', closeDate: '', closeTime: '' },
  counts: { alunos: 20, enviadas: 2, paraCorrigir: 2, atrasadas: 0, naoEntregues: 18, devolvidas: 0 },
}

beforeEach(() => {
  mocks.auth = { accountRole: 'professor' }
  mocks.paths = []
  mocks.assignment = { ...SAVED }
  mocks.roster = []
  mocks.post.mockResolvedValue({ success: true, changed: true, assignment: SAVED })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Nova tarefa', () => {
  it('pede as opções da turma escolhida e mostra os tipos em português, com exemplo', () => {
    renderAt('/tarefas/nova')
    expect(mocks.paths).toContain('/api/admin/assignments/form-options?courseId=DES&studentClass=1DES')
    expect(screen.getByRole('heading', { name: 'Nova tarefa' })).toBeInTheDocument()
    expect(screen.getByLabelText('Código e texto (.txt, .py, .html...)')).not.toBeChecked()
    expect(screen.getByLabelText('PDF (.pdf)')).toBeChecked()
    expect(screen.getByLabelText('Tamanho máximo de cada arquivo (MB)')).toHaveValue(10)
    expect(screen.getByText(/Até 20 MB \(limite das entregas em Sistema\); cada envio vai até 50 MB no total/)).toBeInTheDocument()
    expect(screen.getByText('O aluno lê: “Depois do prazo, a entrega é aceita e marcada como atrasada.”')).toBeInTheDocument()
  })

  it('publicar sem prazo avisa no campo, com a frase do servidor, e não manda nada', async () => {
    const user = userEvent.setup()
    renderAt('/tarefas/nova')
    await user.type(screen.getByLabelText('Título'), 'Relatório de redes')
    await user.click(screen.getByRole('button', { name: 'Publicar' }))
    expect(mocks.post).not.toHaveBeenCalled()
    expect(screen.getAllByText('Informe o prazo da tarefa (data e hora) antes de publicar.').length).toBeGreaterThan(0)
    await waitFor(() => expect(screen.getByLabelText('Prazo: data')).toHaveFocus())
    expect(screen.getByLabelText('Prazo: data')).toHaveAttribute('aria-invalid', 'true')
  })

  it('publica com o corpo que o servidor espera e volta para a lista', async () => {
    const user = userEvent.setup()
    renderAt('/tarefas/nova')
    await user.type(screen.getByLabelText('Título'), 'Relatório de redes')
    await user.type(screen.getByLabelText('Instruções'), 'Envie o PDF.')
    await user.selectOptions(screen.getByLabelText('Módulo (opcional)'), 'm1')
    await user.selectOptions(screen.getByLabelText('Unidade (opcional)'), 'Apostila_m1_1')
    await user.click(screen.getByLabelText('Guia do laboratório'))
    await user.click(screen.getByLabelText('Texto'))
    await user.click(screen.getByLabelText('Código e texto (.txt, .py, .html...)'))
    await user.type(screen.getByLabelText('Formatos do curso (opcional)'), 'pkt, .fzz')
    await user.type(screen.getByLabelText('Prazo: data'), '2026-12-04')
    await user.click(screen.getByLabelText('Aceitar com desconto na nota'))
    await user.clear(screen.getByLabelText('Desconto máximo (%)'))
    await user.type(screen.getByLabelText('Desconto máximo (%)'), '30')
    // C18 / P1-j: o texto ao lado diz o que a escolha faz com a nota.
    expect(screen.getByLabelText('Conta na média')).toHaveAccessibleDescription(/entra na média do aluno como uma avaliação de peso 1/)
    await user.click(screen.getByLabelText('Conta na média'))
    expect(screen.getByLabelText('Conta na média')).toHaveAccessibleDescription('A nota devolvida aparece no quadro de notas, mas não entra na média.')
    await user.click(screen.getByRole('button', { name: 'Publicar' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1))
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/assignments', {
      courseId: 'DES',
      studentClass: '1DES',
      title: 'Relatório de redes',
      instructions: 'Envie o PDF.',
      moduleId: 'm1',
      unitKey: 'Apostila_m1_1',
      libraryIds: ['lib_1'],
      response: { files: true, text: true, link: false },
      files: { maxFiles: 5, maxSizeMb: 10, types: ['pdf', 'image', 'code'], extraExtensions: ['.pkt', '.fzz'] },
      opensDate: null,
      opensTime: null,
      dueDate: '2026-12-04',
      dueTime: '23:59',
      closeDate: null,
      closeTime: null,
      latePolicy: { mode: 'desconto', penaltyPerDayPct: 10, penaltyMaxPct: 30 },
      countsInAverage: false,
      publish: true,
    })
    expect(mocks.toast.success).toHaveBeenCalledWith('Tarefa publicada')
    expect(screen.getByTestId('where')).toHaveTextContent('/tarefas')
  })

  it('recusa do servidor aparece no campo que ele indicar', async () => {
    const user = userEvent.setup()
    mocks.post.mockRejectedValueOnce(Object.assign(new Error('Material de apoio não encontrado na Biblioteca deste curso ou desta turma.'), { status: 400, data: { field: 'libraryIds[0]' } }))
    renderAt('/tarefas/nova')
    await user.type(screen.getByLabelText('Título'), 'Relatório de redes')
    await user.click(screen.getByLabelText('Guia do laboratório'))
    await user.click(screen.getByRole('button', { name: 'Salvar como rascunho' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1))
    expect(mocks.post.mock.calls[0][1]).toMatchObject({ publish: false, dueDate: null, dueTime: null })
    const fieldset = screen.getByRole('group', { name: 'Materiais de apoio da Biblioteca (opcional)' })
    expect(await within(fieldset).findByText('Material de apoio não encontrado na Biblioteca deste curso ou desta turma.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Nova tarefa' })).toBeInTheDocument()
  })

  it('a prévia das instruções mostra o Markdown como o aluno vê', async () => {
    const user = userEvent.setup()
    renderAt('/tarefas/nova')
    await user.type(screen.getByLabelText('Instruções'), 'Envie o **relatório**.')
    await user.click(screen.getByRole('button', { name: 'Prévia' }))
    expect(screen.getByText('relatório').tagName).toBe('STRONG')
  })
})

describe('Editar tarefa', () => {
  it('abre com a tarefa e as opções da turma dela e manda só o que mudou', async () => {
    const user = userEvent.setup()
    mocks.assignment = { ...SAVED, studentClass: '2DES' }
    renderAt('/tarefas/asg_1_aaaaaa/editar')
    expect(mocks.paths).toContain('/api/admin/assignments/asg_1_aaaaaa')
    expect(mocks.paths).toContain('/api/admin/assignments/form-options?courseId=DES&studentClass=2DES')
    expect(screen.getByLabelText('Título')).toHaveValue('Relatório de redes')
    expect(screen.getByLabelText('Formatos do curso (opcional)')).toHaveValue('.pkt')
    await user.clear(screen.getByLabelText('Título'))
    await user.type(screen.getByLabelText('Título'), 'Relatório final de redes')
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/assignments/asg_1_aaaaaa/update', { title: 'Relatório final de redes' }))
    expect(mocks.toast.success).toHaveBeenCalledWith('Alterações salvas')
  })

  it('tirar o módulo manda o módulo e a unidade vazios juntos', async () => {
    const user = userEvent.setup()
    renderAt('/tarefas/asg_1_aaaaaa/editar')
    expect(screen.getByLabelText('Unidade (opcional)')).toHaveValue('Apostila_m1_1')
    await user.selectOptions(screen.getByLabelText('Módulo (opcional)'), '')
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/assignments/asg_1_aaaaaa/update', { moduleId: null, unitKey: null }))
  })

  it('mudar o prazo de tarefa com entrega pede o motivo antes de mandar', async () => {
    const user = userEvent.setup()
    renderAt('/tarefas/asg_1_aaaaaa/editar')
    expect(screen.queryByLabelText('Motivo da mudança de prazo')).not.toBeInTheDocument()
    await user.clear(screen.getByLabelText('Prazo: data'))
    await user.type(screen.getByLabelText('Prazo: data'), '2026-12-08')
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }))
    expect(mocks.post).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Motivo da mudança de prazo')).toHaveAttribute('aria-invalid', 'true')
    await user.type(screen.getByLabelText('Motivo da mudança de prazo'), 'Laboratório fechado')
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/assignments/asg_1_aaaaaa/update', { dueDate: '2026-12-08', dueTime: '23:00', reason: 'Laboratório fechado' }))
  })

  it('tarefa só com nota lançada (enviadas 0): o motivo aparece já na tela, pela regra do servidor, sem um 400 antes', async () => {
    const user = userEvent.setup()
    mocks.assignment = { ...SAVED, deadlineReasonRequired: true, counts: { ...SAVED.counts, enviadas: 0, paraCorrigir: 0 } }
    renderAt('/tarefas/asg_1_aaaaaa/editar')
    expect(screen.queryByLabelText('Motivo da mudança de prazo')).not.toBeInTheDocument()
    await user.clear(screen.getByLabelText('Prazo: data'))
    await user.type(screen.getByLabelText('Prazo: data'), '2026-12-08')
    expect(screen.getByLabelText('Motivo da mudança de prazo')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }))
    expect(mocks.post).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByLabelText('Motivo da mudança de prazo')).toHaveFocus())
    await user.type(screen.getByLabelText('Motivo da mudança de prazo'), 'Laboratório fechado')
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1))
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/assignments/asg_1_aaaaaa/update', { dueDate: '2026-12-08', dueTime: '23:00', reason: 'Laboratório fechado' })
  })

  it('o servidor diz que o prazo muda sem motivo (deadlineReasonRequired false): o campo não aparece', async () => {
    const user = userEvent.setup()
    mocks.assignment = { ...SAVED, deadlineReasonRequired: false }
    renderAt('/tarefas/asg_1_aaaaaa/editar')
    await user.clear(screen.getByLabelText('Prazo: data'))
    await user.type(screen.getByLabelText('Prazo: data'), '2026-12-08')
    expect(screen.queryByLabelText('Motivo da mudança de prazo')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/assignments/asg_1_aaaaaa/update', { dueDate: '2026-12-08', dueTime: '23:00' }))
  })

  it('no celular as listas de módulo e unidade, as abas Escrever/Prévia e a ajuda são alvos de toque de 44 px', () => {
    renderAt('/tarefas/asg_1_aaaaaa/editar')
    const touch = /(^|\s)min-h-\[44px\](\s|$)/
    expect(screen.getByLabelText('Módulo (opcional)').className).toMatch(touch)
    expect(screen.getByLabelText('Unidade (opcional)').className).toMatch(touch)
    expect(screen.getByRole('button', { name: 'Escrever' }).className).toMatch(touch)
    expect(screen.getByRole('button', { name: 'Prévia' }).className).toMatch(touch)
    const help = screen.getByRole('link', { name: 'Ajuda sobre esta tela' })
    expect(help.className).toMatch(touch)
    expect(help.className).toMatch(/(^|\s)min-w-\[44px\](\s|$)/)
    // No computador, o tamanho de sempre.
    expect(screen.getByLabelText('Módulo (opcional)').className).toMatch(/(^|\s)sm:min-h-0(\s|$)/)
  })

  it('rascunho: "Salvar e publicar" grava e publica', async () => {
    const user = userEvent.setup()
    mocks.assignment = { ...SAVED, status: 'rascunho', publishedAt: null, counts: { ...SAVED.counts, enviadas: 0 } }
    renderAt('/tarefas/asg_1_aaaaaa/editar')
    await user.click(screen.getByLabelText('Texto'))
    await user.click(screen.getByRole('button', { name: 'Salvar e publicar' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/assignments/asg_1_aaaaaa/publish', {}))
    expect(mocks.post.mock.calls[0]).toEqual(['/api/admin/assignments/asg_1_aaaaaa/update', { response: { files: true, text: true, link: false } }])
  })

  it('aluno sem e-mail na lista da tarefa: o endereço interno nunca aparece no formulário (pendência da J1)', async () => {
    const internal = 'aluno-alu_00000000000000a1@sem-email.invalid'
    mocks.roster = [
      { studentEmail: internal, studentId: 'alu_00000000000000a1', semEmail: true, name: 'Zeca Sem Email', matricula: '2026-009', status: 'para_corrigir', versions: 1 },
      { studentEmail: 'ana@x.com', studentId: 'alu_00000000000000a2', semEmail: false, name: 'Ana Lima', matricula: '2026-001', status: 'nao_entregue', versions: 0 },
    ]
    // Recusa do servidor que cite o aluno também não mostra o endereço interno.
    mocks.post.mockRejectedValueOnce(Object.assign(new Error(`Aluno ${internal} já enviou.`), { field: 'reason', data: { error: `Aluno ${internal} já enviou.`, field: 'reason' } }))
    const user = userEvent.setup()
    const { container } = renderAt('/tarefas/asg_1_aaaaaa/editar')
    expect(container.textContent).not.toMatch(/sem-email\.invalid/)
    await user.clear(screen.getByLabelText('Título'))
    await user.type(screen.getByLabelText('Título'), 'Relatório final')
    await user.click(screen.getByRole('button', { name: /^Salvar/ }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalled())
    expect(document.body.textContent).not.toMatch(/sem-email\.invalid/)
  })

  it('arquivada e conta só de consulta: formulário sem poder mudar e sem os botões de salvar', () => {
    mocks.assignment = { ...SAVED, status: 'arquivada' }
    renderAt('/tarefas/asg_1_aaaaaa/editar')
    expect(screen.getByText(/Esta tarefa está arquivada/)).toBeInTheDocument()
    expect(screen.getByLabelText('Título')).toBeDisabled()
    expect(screen.queryByRole('button', { name: /Salvar/ })).not.toBeInTheDocument()
    cleanup()
    mocks.auth = { accountRole: 'coordenacao', readOnly: true }
    mocks.assignment = { ...SAVED }
    renderAt('/tarefas/asg_1_aaaaaa/editar')
    expect(screen.getByRole('heading', { name: 'Tarefa' })).toBeInTheDocument()
    expect(screen.getByText(/só de consulta/)).toBeInTheDocument()
    expect(screen.getByLabelText('Título')).toBeDisabled()
    expect(screen.queryByRole('button', { name: /Salvar/ })).not.toBeInTheDocument()
  })
})
