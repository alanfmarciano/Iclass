import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import GruposPage from './GruposPage'

// Tela Grupos da turma (fase 3, C12 / P5-S4, CRIT-11). Antes não havia tela de grupos:
// /turmas/<curso>/<turma>/grupos caía na tela inicial.
const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  refetch: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  auth: { accountRole: 'professor' },
  data: null,
  paths: [],
}))

vi.mock('../../lib/api', () => ({ api: { post: mocks.post, get: vi.fn() } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: mocks.auth }) }))
vi.mock('../../hooks/useApi', () => ({
  useApi: (path) => {
    mocks.paths.push(path)
    return { data: mocks.data, loading: false, error: null, refetch: mocks.refetch }
  },
}))

const ANA = 'ana@x.local'
const BIA = 'bia@x.local'
const CAIO = 'caio@x.local'
const DUDA = 'duda@x.local'

const member = (email, nome, extra = {}) => ({ email, nome, matricula: '', naTurma: true, adicionadoEm: 1, ...extra })

function view() {
  return {
    success: true,
    turma: { courseId: 'DES', nome: '1DES', curso: 'Desenvolvimento' },
    grupos: [
      { id: 'grp_a', nome: 'Equipe 1', conjunto: 'Projeto', tipo: 'equipe', tipoTexto: 'Equipe', membros: [member(ANA, 'Ana'), member(CAIO, 'Caio', { naTurma: false })], membrosNaTurma: 1, atualizadoEm: 111, arquivado: false, sorteio: null },
      { id: 'grp_b', nome: 'Equipe 2', conjunto: 'Projeto', tipo: 'equipe', tipoTexto: 'Equipe', membros: [member(BIA, 'Bia')], membrosNaTurma: 1, atualizadoEm: 222, arquivado: false, sorteio: null },
      { id: 'grp_old', nome: 'Antigo', conjunto: 'Projeto', tipo: 'subturma', tipoTexto: 'Subturma', membros: [], membrosNaTurma: 0, atualizadoEm: 5, arquivado: true, sorteio: null },
    ],
    conjuntos: ['Projeto'],
    semGrupo: { Projeto: [DUDA] },
    alunos: [
      { email: ANA, nome: 'Ana', matricula: 'M1', studentId: 'alu_1' },
      { email: BIA, nome: 'Bia', matricula: 'M2', studentId: 'alu_2' },
      { email: DUDA, nome: 'Duda', matricula: 'M4', studentId: 'alu_4' },
    ],
    limites: { nameMax: 60, setMax: 40, reasonMax: 200, drawMin: 2, drawMax: 20, drawBaseMax: 40 },
  }
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/turmas/DES/1DES/grupos']}>
      <Routes><Route path="/turmas/:courseId/:className/grupos" element={<GruposPage />} /></Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  mocks.data = view()
  mocks.auth = { accountRole: 'professor' }
  mocks.paths = []
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Grupos da turma', () => {
  it('[UC-GRUPO-001] lista os grupos por conjunto, quem está sem grupo e quem saiu da turma; arquivados só com a chave', async () => {
    renderPage()
    expect(mocks.paths).toContain('/api/admin/class-groups?courseId=DES&studentClass=1DES&arquivados=1')
    expect(screen.getByRole('heading', { name: 'Grupos' })).toBeInTheDocument()
    expect(screen.getByText('Desenvolvimento · 1DES')).toBeInTheDocument()
    const set = screen.getByRole('region', { name: 'Conjunto Projeto' })
    expect(within(set).getByText('2 grupos ativos')).toBeInTheDocument()
    expect(within(set).getByText(/Sem grupo neste conjunto \(1\):/).parentElement).toHaveTextContent('Duda')
    expect(within(set).getByText('Saiu da turma')).toBeInTheDocument()
    expect(within(set).queryByText('Antigo')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('switch'))
    expect(within(set).getByText('Antigo')).toBeInTheDocument()
    expect(within(set).getByRole('button', { name: 'Reativar' })).toBeInTheDocument()
  })

  it('[UC-GRUPO-001] coordenação (só consulta) vê os grupos sem os botões', () => {
    mocks.auth = { accountRole: 'coordenacao', readOnly: true }
    renderPage()
    expect(screen.getByText('Equipe 1')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Novo grupo' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sortear grupos' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Editar o grupo/ })).not.toBeInTheDocument()
  })

  it('[UC-GRUPO-001] Novo grupo: quem já está em outro grupo do conjunto não pode ser marcado; cria com os marcados', async () => {
    mocks.post.mockResolvedValueOnce({ success: true, grupo: { id: 'grp_n', nome: 'Equipe 3' } })
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Novo grupo' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Nome do grupo'), 'Equipe 3')
    expect(within(dialog).getByLabelText('Conjunto')).toHaveValue('Projeto')
    const ana = within(dialog).getByText('Ana').closest('label').querySelector('input')
    expect(ana).toBeDisabled()
    expect(within(dialog).getByText('Em Equipe 1')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByText('Duda'))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Criar grupo' }))
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/class-groups', { courseId: 'DES', studentClass: '1DES', nome: 'Equipe 3', conjunto: 'Projeto', tipo: 'equipe', membros: [DUDA] })
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith('Grupo "Equipe 3" criado.'))
    expect(mocks.refetch).toHaveBeenCalled()
  })

  it('[UC-GRUPO-001] Editar: tirar quem saiu da turma e trazer de outro grupo (mover), com a versão lida', async () => {
    mocks.post.mockResolvedValueOnce({ success: true, changed: true, grupo: { id: 'grp_a', nome: 'Equipe 1' }, alterados: [] })
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Editar o grupo Equipe 1' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.click(within(dialog).getByText('Caio'))
    await userEvent.click(within(dialog).getByText('Bia'))
    expect(within(dialog).getByText('Sai de Equipe 2')).toBeInTheDocument()
    expect(within(dialog).getByRole('status')).toHaveTextContent('1 aluno vai sair de outro grupo deste conjunto ao salvar.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/class-groups/grp_a/update', {
      nome: 'Equipe 1', conjunto: 'Projeto', tipo: 'equipe', adicionar: [BIA], remover: [CAIO], atualizadoEm: 111, mover: true,
    })
  })

  it('[UC-GRUPO-001] grupo mudado por outra pessoa (409 group_changed): avisa e recarrega a lista', async () => {
    mocks.post.mockRejectedValueOnce(Object.assign(new Error('Este grupo mudou.'), { status: 409, data: { code: 'group_changed' } }))
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Editar o grupo Equipe 2' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.clear(within(dialog).getByLabelText('Nome do grupo'))
    await userEvent.type(within(dialog).getByLabelText('Nome do grupo'), 'Equipe B')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith(expect.stringMatching(/Outra pessoa mudou este grupo/)))
    expect(mocks.refetch).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('[UC-GRUPO-002] Sortear: mostra a proposta e cria exatamente ela com a semente e a assinatura', async () => {
    const proposta = { success: true, proposta: [{ nome: 'Grupo 1', membros: [{ email: DUDA, nome: 'Duda' }] }], semente: 'abcd1234abcd1234', assinatura: 'sig', conjunto: 'Seminário', tipo: 'equipe', criterio: 'quantidade', valor: 2, alunos: 3 }
    mocks.post.mockResolvedValueOnce(proposta).mockResolvedValueOnce({ success: true, grupos: [{ id: 'g1' }, { id: 'g2' }] })
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Sortear grupos' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Conjunto'), 'Seminário')
    await userEvent.clear(within(dialog).getByLabelText('Quantos grupos'))
    await userEvent.type(within(dialog).getByLabelText('Quantos grupos'), '2')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sortear' }))
    expect(mocks.post).toHaveBeenNthCalledWith(1, '/api/admin/class-groups/draw', { courseId: 'DES', studentClass: '1DES', conjunto: 'Seminário', tipo: 'equipe', criterio: 'quantidade', valor: 2, nomeBase: undefined, somenteSemGrupo: true })
    expect(await within(dialog).findByText('3 alunos em 1 grupo no conjunto Seminário:')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Criar estes grupos' }))
    expect(mocks.post).toHaveBeenNthCalledWith(2, '/api/admin/class-groups/draw', expect.objectContaining({ semente: 'abcd1234abcd1234', assinatura: 'sig', confirmar: true, conjunto: 'Seminário' }))
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith('2 grupos criados pelo sorteio.'))
  })

  it('[UC-GRUPO-002] Sortear: turma mudada (409 roster_changed) pede outro sorteio', async () => {
    mocks.post
      .mockResolvedValueOnce({ success: true, proposta: [{ nome: 'Grupo 1', membros: [] }], semente: 's', assinatura: 'a', conjunto: 'Grupos', alunos: 3 })
      .mockRejectedValueOnce(Object.assign(new Error('mudou'), { status: 409, data: { code: 'roster_changed' } }))
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Sortear grupos' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Conjunto'), 'Grupos')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sortear' }))
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Criar estes grupos' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('A turma mudou depois do sorteio')
    expect(within(dialog).getByRole('button', { name: 'Sortear' })).toBeInTheDocument()
  })

  it('[UC-GRUPO-001] Arquivar pede confirmação (sem janela do navegador) e manda o motivo', async () => {
    mocks.post.mockResolvedValueOnce({ success: true, changed: true })
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Arquivar o grupo Equipe 2' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Arquivar Equipe 2?')).toBeInTheDocument()
    await userEvent.type(within(dialog).getByLabelText('Motivo (opcional)'), 'Fim do bimestre')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Arquivar' }))
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/class-groups/grp_b/archive', { motivo: 'Fim do bimestre' })
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith('Grupo arquivado.'))
  })
})
