import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AcademicTermsSection, suggestStages, termOptionsForCourse, termOptionLabel } from './AcademicTermsSection'

// Períodos letivos na tela Turmas (B8 / P2-S8, FUN-05). Antes não havia tela: o período
// só existia pela API (B5).
const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))
vi.mock('../../lib/api', () => ({ api: { post: mocks.post, get: vi.fn() } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))

const OPEN = {
  id: 'per_1', nome: '2027 · 1º semestre', inicio: '2027-02-01', fim: '2027-07-09', schoolId: null, situacao: 'aberto', situacaoRotulo: 'Aberto',
  etapas: [{ ordem: 1, nome: '1º bimestre', inicio: '2027-02-01', fim: '2027-04-16' }, { ordem: 2, nome: '2º bimestre', inicio: '2027-04-19', fim: '2027-07-09' }],
  turmas: [{ courseId: 'DES', courseName: 'Técnico em TI', name: '1DES' }], totalTurmas: 2, podeAlterar: true,
}
const CLOSED = {
  id: 'per_0', nome: '2026 · 2º semestre', inicio: '2026-08-03', fim: '2026-12-18', schoolId: 'esc_b', escolaNome: 'Escola B', situacao: 'encerrado', situacaoRotulo: 'Encerrado',
  etapas: [], turmas: [], totalTurmas: 0, podeAlterar: true, encerradoEm: Date.UTC(2026, 11, 20, 15), encerradoPor: 'admin@escola.local',
}

function termsApi(data) {
  return { data, loading: false, error: null, refetch: vi.fn().mockResolvedValue(undefined) }
}

describe('suggestStages e opções do período', () => {
  it('[UC-CURSO-002] divide o período em etapas seguidas, sem se cruzar e dentro das datas', () => {
    const stages = suggestStages('2027-02-01', '2027-07-09', 4)
    expect(stages.map(stage => stage.ordem)).toEqual([1, 2, 3, 4])
    expect(stages[0].inicio).toBe('2027-02-01')
    expect(stages[3].fim).toBe('2027-07-09')
    for (let i = 1; i < stages.length; i++) {
      // A etapa seguinte começa no dia depois do fim da anterior.
      const next = new Date(`${stages[i - 1].fim}T00:00:00Z`)
      next.setUTCDate(next.getUTCDate() + 1)
      expect(stages[i].inicio).toBe(next.toISOString().slice(0, 10))
      expect(stages[i].inicio <= stages[i].fim).toBe(true)
    }
    expect(stages[0].nome).toBe('1ª etapa')
    expect(suggestStages('2027-02-01', '2027-02-30', 2)).toBeNull()
    expect(suggestStages('2027-07-09', '2027-02-01', 2)).toBeNull()
    expect(suggestStages('2027-02-01', '2027-02-02', 3)).toBeNull()
    expect(suggestStages('2027-02-01', '2027-07-09', 7)).toBeNull()
  })

  it('[UC-CURSO-002] a turma recebe período aberto da instituição ou da escola do curso; o que ela já tem entra sempre', () => {
    const otherSchool = { ...OPEN, id: 'per_x', schoolId: 'esc_b' }
    const ownSchool = { ...OPEN, id: 'per_a', schoolId: 'esc_a' }
    const list = [OPEN, CLOSED, otherSchool, ownSchool]
    expect(termOptionsForCourse(list, { schoolId: 'esc_a' }).map(term => term.id)).toEqual(['per_1', 'per_a'])
    expect(termOptionsForCourse(list, { schoolId: 'esc_a' }, 'per_0').map(term => term.id)).toEqual(['per_1', 'per_0', 'per_a'])
    // Curso antigo sem escola é da escola padrão.
    expect(termOptionsForCourse([{ ...OPEN, id: 'per_d', schoolId: 'escola_default' }], {}).map(term => term.id)).toEqual(['per_d'])
    expect(termOptionLabel(CLOSED)).toBe('2026 · 2º semestre (03/08/2026 a 18/12/2026) · encerrado')
  })
})

describe('AcademicTermsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.post.mockResolvedValue({ success: true })
  })
  afterEach(cleanup)

  it('[UC-CURSO-002] lista os períodos com datas, etapas, turmas ligadas e situação', () => {
    render(<AcademicTermsSection termsApi={termsApi({ periodos: [OPEN, CLOSED], escolas: [], podeCriar: true })} course={null} />)
    const list = screen.getByRole('list', { name: 'Períodos letivos' })
    expect(within(list).getByText('2027 · 1º semestre')).toBeVisible()
    expect(within(list).getByText(/01\/02\/2027 a 09\/07\/2027 · Toda a instituição/)).toBeVisible()
    expect(within(list).getByText('1º bimestre: 01/02 a 16/04')).toBeVisible()
    expect(within(list).getByText('Turmas: Técnico em TI · 1DES e 1 de outros cursos')).toBeVisible()
    expect(within(list).getByText(/18\/12\/2026 · Escola B/)).toBeVisible()
    expect(within(list).getByText(/Encerrado em .* por admin@escola\.local/)).toBeVisible()
    // Aberto: editar e encerrar; encerrado: só reabrir.
    expect(screen.getByRole('button', { name: 'Editar período 2027 · 1º semestre' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Encerrar período 2027 · 1º semestre' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Editar período 2026 · 2º semestre' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Reabrir período 2026 · 2º semestre' })).toBeVisible()
  })

  it('[UC-CURSO-002] sem permissão de gravar, só lê (sem Novo, Editar, Encerrar ou Reabrir)', () => {
    render(<AcademicTermsSection termsApi={termsApi({ periodos: [{ ...OPEN, podeAlterar: false }], escolas: [], podeCriar: false })} course={null} />)
    expect(screen.getByText('2027 · 1º semestre')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Novo período letivo' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Editar período|Encerrar período|Reabrir período/ })).toBeNull()
  })

  it('[UC-CURSO-002] novo período com as etapas sugeridas pelos critérios do curso manda o pedido certo', async () => {
    const user = userEvent.setup()
    const api = termsApi({ periodos: [], escolas: [{ id: 'esc_a', nome: 'Escola A' }], podeCriar: true })
    const onChanged = vi.fn()
    mocks.post.mockResolvedValue({ success: true, periodo: { id: 'per_9' } })
    const course = { id: 'DES', name: 'Técnico em TI', avaliacao: { ativo: true, etapas: [{ ordem: 1 }, { ordem: 2 }, { ordem: 3 }] } }
    render(<AcademicTermsSection termsApi={api} course={course} onChanged={onChanged} />)
    expect(screen.getByText('Nenhum período letivo')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Novo período letivo' }))
    const dialog = screen.getByRole('dialog', { name: 'Novo período letivo' })
    await user.type(within(dialog).getByLabelText('Nome do período'), '2027 · 1º semestre')
    await user.selectOptions(within(dialog).getByLabelText('Vale para'), 'esc_a')
    const suggest = within(dialog).getByRole('button', { name: 'Sugerir datas das etapas' })
    expect(suggest).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Início'), '2027-02-01')
    await user.type(within(dialog).getByLabelText('Fim'), '2027-07-09')
    // O número de etapas vem dos critérios do curso (3).
    expect(within(dialog).getByLabelText('Dividir o período em')).toHaveValue('3')
    expect(within(dialog).getByText(/Os critérios de avaliação de Técnico em TI têm 3 etapas/)).toBeVisible()
    await user.click(suggest)
    expect(within(dialog).getByLabelText('Início da etapa 1')).toHaveValue('2027-02-01')
    expect(within(dialog).getByLabelText('Fim da etapa 3')).toHaveValue('2027-07-09')
    await user.clear(within(dialog).getByLabelText('Nome da etapa 1'))
    await user.type(within(dialog).getByLabelText('Nome da etapa 1'), '1º trimestre')
    await user.click(within(dialog).getByRole('button', { name: 'Salvar período' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1))
    const [path, body] = mocks.post.mock.calls[0]
    expect(path).toBe('/api/admin/academic/terms/create')
    expect(body).toMatchObject({ nome: '2027 · 1º semestre', inicio: '2027-02-01', fim: '2027-07-09', schoolId: 'esc_a' })
    expect(body.etapas).toHaveLength(3)
    expect(body.etapas[0]).toEqual({ ordem: 1, nome: '1º trimestre', inicio: '2027-02-01', fim: body.etapas[0].fim })
    expect(body.etapas[2].fim).toBe('2027-07-09')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Novo período letivo' })).toBeNull())
    expect(mocks.toast.success).toHaveBeenCalledWith('Período letivo criado.')
    expect(api.refetch).toHaveBeenCalled()
    expect(onChanged).toHaveBeenCalled()
  })

  it('[UC-CURSO-002] a recusa do servidor aparece no campo da etapa que ele apontou, e o formulário fica aberto', async () => {
    const user = userEvent.setup()
    const error = Object.assign(new Error('A etapa 2 (2º bimestre) começa antes do fim da etapa 1 (1º bimestre): as etapas não podem se cruzar.'), { status: 400, data: { field: 'etapas[1].inicio' } })
    mocks.post.mockRejectedValueOnce(error)
    render(<AcademicTermsSection termsApi={termsApi({ periodos: [OPEN], escolas: [], podeCriar: true })} course={null} />)
    await user.click(screen.getByRole('button', { name: 'Editar período 2027 · 1º semestre' }))
    const dialog = screen.getByRole('dialog', { name: 'Editar período letivo' })
    expect(within(dialog).getByLabelText('Nome da etapa 2')).toHaveValue('2º bimestre')
    await user.click(within(dialog).getByRole('button', { name: 'Salvar período' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/academic/terms/update', expect.objectContaining({ id: 'per_1', nome: '2027 · 1º semestre', schoolId: null })))
    const field = within(dialog).getByLabelText('Início da etapa 2')
    await waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'))
    expect(within(dialog).getByText(/as etapas não podem se cruzar/)).toBeVisible()
    expect(screen.getByRole('dialog', { name: 'Editar período letivo' })).toBeVisible()
  })

  it('[UC-CURSO-002] remover a etapa renumera as outras e salvar sem etapas manda a lista vazia', async () => {
    const user = userEvent.setup()
    render(<AcademicTermsSection termsApi={termsApi({ periodos: [OPEN], escolas: [], podeCriar: true })} course={null} />)
    await user.click(screen.getByRole('button', { name: 'Editar período 2027 · 1º semestre' }))
    const dialog = screen.getByRole('dialog', { name: 'Editar período letivo' })
    await user.click(within(dialog).getByRole('button', { name: 'Remover etapa 1' }))
    expect(within(dialog).getByLabelText('Nome da etapa 1')).toHaveValue('2º bimestre')
    await user.click(within(dialog).getByRole('button', { name: 'Remover etapa 1' }))
    expect(within(dialog).getByText('Sem etapas: o período vale como um bloco só.')).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'Salvar período' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/academic/terms/update', expect.objectContaining({ id: 'per_1', etapas: [] })))
  })

  it('[UC-CURSO-002] encerrar avisa que as turmas continuam abertas; reabrir pede o motivo', async () => {
    const user = userEvent.setup()
    mocks.post.mockResolvedValueOnce({ success: true, turmas: [{ name: '1DES' }, { name: '2DES' }] })
    render(<AcademicTermsSection termsApi={termsApi({ periodos: [OPEN, CLOSED], escolas: [], podeCriar: true })} course={null} />)
    await user.click(screen.getByRole('button', { name: 'Encerrar período 2027 · 1º semestre' }))
    let dialog = screen.getByRole('dialog', { name: 'Encerrar o período 2027 · 1º semestre?' })
    expect(dialog).toHaveTextContent('As turmas ligadas (2) continuam abertas, com as mesmas notas e chamadas.')
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar período' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/academic/terms/close', { id: 'per_1' }))
    expect(mocks.toast.success).toHaveBeenCalledWith('Período encerrado. As 2 turmas ligadas continuam abertas, com as mesmas notas.')

    await user.click(screen.getByRole('button', { name: 'Reabrir período 2026 · 2º semestre' }))
    dialog = screen.getByRole('dialog', { name: 'Reabrir o período 2026 · 2º semestre?' })
    const confirm = within(dialog).getByRole('button', { name: 'Reabrir período' })
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Motivo para reabrir'), 'Datas mudaram')
    await user.click(confirm)
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/academic/terms/reopen', { id: 'per_0', reason: 'Datas mudaram' }))
  })
})
