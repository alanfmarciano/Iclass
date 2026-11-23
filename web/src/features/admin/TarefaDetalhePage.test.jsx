import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TarefaDetalhePage from './TarefaDetalhePage'
import { NOW, SEM_EMAIL, TZ, assignmentData, rosterData, submissionData } from '../../test/tarefasCorrecaoFixtures'

// Detalhe da tarefa com as entregas da turma e a correção (fase 3, C8 / P1-f; FUN-01).
// Antes do C8, /tarefas/:id não existia (o título do cartão abria o formulário) e não
// havia como ver nem corrigir a entrega pela tela.
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  downloadFile: vi.fn(),
  fetchBlob: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  auth: { accountRole: 'professor' },
}))

vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post }, downloadFile: mocks.downloadFile, fetchBlob: mocks.fetchBlob }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: mocks.auth }) }))

let detail
let roster

function Where() {
  const location = useLocation()
  return <p data-testid="where">{location.pathname}{location.search}</p>
}

function renderAt(url = '/tarefas/asg_1_aaaaaa') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/tarefas/:id" element={<><TarefaDetalhePage /><Where /></>} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
}

const rowOf = (name) => screen.getAllByText(name).map((node) => node.closest('tr')).find(Boolean)

beforeEach(() => {
  mocks.auth = { accountRole: 'professor' }
  detail = assignmentData()
  roster = rosterData()
  mocks.get.mockImplementation(async (path) => {
    if (path === '/api/admin/assignments/asg_1_aaaaaa') return { success: true, assignment: detail, roster, serverNow: NOW, timezone: TZ }
    const sub = /\/submissions\/([^/?]+)/.exec(path)
    if (sub) {
      const row = roster.find((item) => item.submissionId === decodeURIComponent(sub[1]))
      return { success: true, submission: submissionData(row), serverNow: NOW, timezone: TZ }
    }
    if (path.startsWith('/api/admin/course-summaries')) return [{ id: 'DES', name: 'Desenvolvimento', classes: [{ name: '1DES' }, { name: '2DES' }] }]
    throw new Error(`GET inesperado ${path}`)
  })
  mocks.post.mockResolvedValue({ success: true, changed: true })
  mocks.downloadFile.mockResolvedValue('entregas.zip')
  mocks.fetchBlob.mockResolvedValue({ blob: new Blob(['x']), name: 'x', type: '' })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Detalhe da tarefa', () => {
  it('mostra o prazo, a regra de atraso, as contagens e a lista da turma com a situação de cada aluno', async () => {
    renderAt()
    expect(await screen.findByRole('heading', { name: 'Relatório de redes' })).toBeInTheDocument()
    expect(screen.getByText('Depois do prazo, a entrega é aceita com desconto de 10% por dia, até 30%.')).toBeInTheDocument()
    expect(screen.getByText('Para corrigir 2 · Atrasadas 1 · Sem envio 2')).toBeInTheDocument()
    const table = screen.getByRole('table', { name: 'Entregas dos alunos da turma' })
    expect(within(table).getAllByRole('row')).toHaveLength(6)
    expect(within(rowOf('Bia Reis')).getByText('Atrasada 2 dias')).toBeInTheDocument()
    expect(within(rowOf('Caio Melo')).getByText('Corrigida, sem devolver')).toBeInTheDocument()
    expect(within(rowOf('Caio Melo')).getByText('7,0')).toBeInTheDocument()
    expect(within(rowOf('Davi Souza')).getByText('Sem envio')).toBeInTheDocument()
    // "Corrigir" só na entrega que espera correção; o resto abre o painel com "Abrir".
    expect(within(rowOf('Ana Lima')).getByRole('button', { name: 'Corrigir: Ana Lima (ana@x.com)' })).toBeInTheDocument()
    expect(within(rowOf('Davi Souza')).getByRole('button', { name: 'Abrir: Davi Souza (davi@x.com)' })).toBeInTheDocument()
    // Os cartões do celular trazem os mesmos alunos.
    expect(within(screen.getByRole('list', { name: 'Entregas dos alunos da turma' })).getAllByRole('listitem')).toHaveLength(5)
  })

  it('aluno sem e-mail aparece como "sem e-mail" na lista e no painel, nunca com o endereço interno', async () => {
    const user = userEvent.setup()
    renderAt()
    await screen.findByRole('heading', { name: 'Relatório de redes' })
    expect(within(rowOf('Bia Reis')).getByText('matrícula 002 · sem e-mail')).toBeInTheDocument()
    await user.click(within(rowOf('Bia Reis')).getByRole('button', { name: 'Corrigir: Bia Reis (sem e-mail)' }))
    const panel = await screen.findByRole('dialog', { name: 'Bia Reis' })
    await within(panel).findByText(/Recebida em/)
    expect(document.body.textContent).not.toMatch(/sem-email\.invalid/)
  })

  it('filtros com as contagens; o link ?filtro=para-corrigir abre só quem espera correção', async () => {
    const user = userEvent.setup()
    renderAt('/tarefas/asg_1_aaaaaa?filtro=para-corrigir')
    await screen.findByRole('heading', { name: 'Relatório de redes' })
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Todos (5)', 'Para corrigir (2)', 'Corrigidas, sem devolver (1)', 'Atrasadas (1)', 'Sem envio (1)', 'Devolvidas (1)',
    ])
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3)
    await user.selectOptions(screen.getByLabelText('Mostrar'), 'devolvidas')
    expect(screen.getByTestId('where')).toHaveTextContent('/tarefas/asg_1_aaaaaa?filtro=devolvidas')
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2)
    expect(rowOf('Eva Rocha')).toBeTruthy()
  })

  it('corrige e devolve: o corpo vai para /grade e a linha muda na hora; "Próximo aluno" segue a fila de quando abriu', async () => {
    const user = userEvent.setup()
    const returnedRow = { ...roster[0], status: 'devolvida', returnedAt: NOW, grade: { score: 85, penaltyPct: 0, finalScore: 85, comment: 'Bom', versionGraded: 2, penaltyWaived: false } }
    mocks.post.mockImplementation(async (path) => {
      if (path.endsWith('/grade')) {
        // O servidor guarda a correção: a próxima leitura da lista já vem com ela.
        roster = roster.map((item) => (item.submissionId === returnedRow.submissionId ? returnedRow : item))
        return { success: true, changed: true, row: returnedRow, submission: submissionData(returnedRow, { status: 'devolvida' }) }
      }
      return { success: true, changed: true }
    })
    renderAt('/tarefas/asg_1_aaaaaa?filtro=para-corrigir')
    await screen.findByRole('heading', { name: 'Relatório de redes' })
    await user.click(within(rowOf('Ana Lima')).getByRole('button', { name: 'Corrigir: Ana Lima (ana@x.com)' }))
    const panel = await screen.findByRole('dialog', { name: 'Ana Lima' })
    expect(within(panel).getByText(/Aluno 1 de 2/)).toBeInTheDocument()
    await within(panel).findByText(/Recebida em/)
    await user.type(within(panel).getByLabelText('Nota (0 a 10)'), '8,5')
    await user.type(within(panel).getByLabelText('Comentário para o aluno'), 'Bom')
    await user.click(within(panel).getByRole('button', { name: 'Devolver ao aluno' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/assignments/asg_1_aaaaaa/grade', {
      studentEmail: 'ana@x.com', action: 'devolver', grade: '8,5', comment: 'Bom', version: 2, waivePenalty: false,
    }))
    expect(mocks.toast.success).toHaveBeenCalledWith('Devolvida ao aluno')
    // A linha da Ana saiu do filtro "Para corrigir"; o painel continua com ela e o
    // "Próximo aluno" vai para a Bia (a fila de quando abriu).
    await waitFor(() => expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2))
    await user.click(within(panel).getByRole('button', { name: 'Próximo aluno' }))
    expect(await screen.findByRole('dialog', { name: 'Bia Reis' })).toBeInTheDocument()
  })

  it('"Devolver todas as corrigidas" mostra quantas, pergunta e chama /return-all', async () => {
    const user = userEvent.setup()
    mocks.post.mockResolvedValue({ success: true, changed: true, returned: 1, newVersionPending: 1 })
    renderAt()
    await screen.findByRole('heading', { name: 'Relatório de redes' })
    await user.click(screen.getByRole('button', { name: 'Devolver todas as corrigidas (1)' }))
    const dialog = await screen.findByRole('dialog', { name: 'Devolver todas as corrigidas?' })
    await user.click(within(dialog).getByRole('button', { name: 'Devolver' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/assignments/asg_1_aaaaaa/return-all', {}))
    expect(mocks.toast.success).toHaveBeenCalledWith('1 correção devolvida ao aluno')
    expect(mocks.toast.warning).toHaveBeenCalledWith(expect.stringMatching(/versão nova depois da correção/))
  })

  it('"Baixar entregas (ZIP)" escolhe a última versão ou todas', async () => {
    const user = userEvent.setup()
    renderAt()
    await screen.findByRole('heading', { name: 'Relatório de redes' })
    await user.click(screen.getByRole('button', { name: 'Baixar entregas (ZIP)' }))
    let dialog = await screen.findByRole('dialog', { name: 'Baixar as entregas em ZIP?' })
    await user.click(within(dialog).getByRole('button', { name: 'Baixar' }))
    await waitFor(() => expect(mocks.downloadFile).toHaveBeenCalledWith('/api/admin/assignments/asg_1_aaaaaa/export?versoes=ultima', 'entregas.zip'))
    await user.click(screen.getByRole('button', { name: 'Baixar entregas (ZIP)' }))
    dialog = await screen.findByRole('dialog', { name: 'Baixar as entregas em ZIP?' })
    await user.click(within(dialog).getByLabelText('Todas as versões'))
    await user.click(within(dialog).getByRole('button', { name: 'Baixar' }))
    await waitFor(() => expect(mocks.downloadFile).toHaveBeenLastCalledWith('/api/admin/assignments/asg_1_aaaaaa/export?versoes=todas', 'entregas.zip'))
  })

  it('"Copiar para outra turma" lista as turmas da conta e cria a cópia como rascunho', async () => {
    const user = userEvent.setup()
    mocks.post.mockResolvedValue({ success: true, assignment: { id: 'asg_9_ffffff' }, avisos: ['A unidade da tarefa não existe na turma de destino; a cópia ficou só com o módulo.'] })
    renderAt()
    await screen.findByRole('heading', { name: 'Relatório de redes' })
    await user.click(screen.getByRole('button', { name: 'Copiar para outra turma' }))
    const dialog = await screen.findByRole('dialog', { name: 'Copiar para outra turma?' })
    const select = await within(dialog).findByLabelText('Turma de destino')
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['Escolha a turma', '1DES · Desenvolvimento (esta turma)', '2DES · Desenvolvimento'])
    expect(within(dialog).getByRole('button', { name: 'Copiar' })).toBeDisabled()
    await user.selectOptions(select, '2DES · Desenvolvimento')
    await user.click(within(dialog).getByRole('button', { name: 'Copiar' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/assignments/asg_1_aaaaaa/copy', { courseId: 'DES', studentClass: '2DES', dueDate: '2026-11-20', dueTime: '12:00' }))
    expect(mocks.toast.success).toHaveBeenCalledWith('Cópia criada como rascunho na turma 2DES')
    expect(mocks.toast.warning).toHaveBeenCalledWith(expect.stringMatching(/unidade da tarefa/))
  })

  it('excluir (só com deletable do servidor) volta para a lista', async () => {
    const user = userEvent.setup()
    detail = assignmentData({ status: 'rascunho', deletable: true, counts: { alunos: 5, enviadas: 0, paraCorrigir: 0, atrasadas: 0, naoEntregues: 5, devolvidas: 0 } })
    roster = rosterData().map((row) => ({ ...row, status: 'nao_entregue', submissionId: null, versions: 0, lastVersion: null, grade: null, returnedAt: null }))
    renderAt()
    await screen.findByRole('heading', { name: 'Relatório de redes' })
    expect(screen.getByText(/Rascunho: os alunos ainda não veem/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Baixar entregas/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Excluir' }))
    const dialog = await screen.findByRole('dialog', { name: 'Excluir a tarefa?' })
    await user.click(within(dialog).getByRole('button', { name: 'Excluir' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/assignments/asg_1_aaaaaa/delete', { confirm: 'EXCLUIR' }))
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/tarefas$/)
  })

  it('conta só de consulta (Coordenação) vê tudo e baixa o ZIP, sem os botões de mudar nem o formulário de nota', async () => {
    const user = userEvent.setup()
    mocks.auth = { accountRole: 'coordenacao', readOnly: true }
    renderAt()
    await screen.findByRole('heading', { name: 'Relatório de redes' })
    expect(screen.getByRole('button', { name: 'Baixar entregas (ZIP)' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Devolver todas|Copiar|Arquivar|Publicar|Excluir/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Corrigir:/ })).not.toBeInTheDocument()
    await user.click(within(rowOf('Ana Lima')).getByRole('button', { name: 'Abrir: Ana Lima (ana@x.com)' }))
    const panel = await screen.findByRole('dialog', { name: 'Ana Lima' })
    expect(within(panel).getByText(/Sua conta é só de consulta/)).toBeInTheDocument()
    expect(within(panel).getByLabelText('Nota (0 a 10)')).toBeDisabled()
    expect(within(panel).queryByRole('button', { name: /Salvar|Devolver|Pedir para refazer|Prorrogar|Entrega em mãos/ })).not.toBeInTheDocument()
  })

  it('tarefa arquivada: as entregas aparecem, sem corrigir nem devolver em lote', async () => {
    const user = userEvent.setup()
    detail = assignmentData({ status: 'arquivada' })
    renderAt()
    await screen.findByRole('heading', { name: 'Relatório de redes' })
    expect(screen.queryByRole('button', { name: /Devolver todas/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reativar' })).toBeInTheDocument()
    await user.click(within(rowOf('Ana Lima')).getByRole('button', { name: 'Abrir: Ana Lima (ana@x.com)' }))
    const panel = await screen.findByRole('dialog', { name: 'Ana Lima' })
    expect(within(panel).getByText(/Esta tarefa está arquivada/)).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Devolver ao aluno' })).not.toBeInTheDocument()
  })

  it('no celular os filtros, os botões e o "Corrigir" dos cartões são alvos de toque de 44 px', async () => {
    renderAt()
    await screen.findByRole('heading', { name: 'Relatório de redes' })
    const touch = /(^|\s)min-h-\[44px\](\s|$)/
    expect(screen.getByLabelText('Mostrar').className).toMatch(touch)
    expect(screen.getByRole('button', { name: 'Baixar entregas (ZIP)' }).className).toMatch(touch)
    const cards = within(screen.getByRole('list', { name: 'Entregas dos alunos da turma' }))
    cards.getAllByRole('button').forEach((button) => expect(button.className).toMatch(touch))
  })
})

// Ninguém pode chegar aqui pelo endereço interno: a chave na fila é usada só para achar a
// linha (o teste de aluno sem e-mail acima confere a tela).
it('a fila do painel usa a chave do aluno, não o texto mostrado', async () => {
  const user = userEvent.setup()
  renderAt('/tarefas/asg_1_aaaaaa?filtro=para-corrigir')
  await screen.findByRole('heading', { name: 'Relatório de redes' })
  await user.click(within(rowOf('Ana Lima')).getByRole('button', { name: 'Corrigir: Ana Lima (ana@x.com)' }))
  const panel = await screen.findByRole('dialog', { name: 'Ana Lima' })
  await user.click(within(panel).getByRole('button', { name: 'Próximo aluno' }))
  const next = await screen.findByRole('dialog', { name: 'Bia Reis' })
  await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/admin/assignments/asg_1_aaaaaa/submissions/asub_2_bbbbbb'))
  expect(within(next).queryByRole('button', { name: 'Próximo aluno' })).not.toBeInTheDocument()
  expect(SEM_EMAIL).toMatch(/sem-email/)
})
