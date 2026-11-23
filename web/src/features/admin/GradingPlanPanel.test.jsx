import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GradingPlanPanel, parseWeightInput, planChanges } from './GradingPlanPanel'

const mocks = vi.hoisted(() => ({ post: vi.fn(), toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: mocks.post } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))

// Plano como GET /api/admin/grading/plan devolve (B6).
function plano(extra = {}) {
  return {
    ativo: true,
    criterio: { mediaMinima: 6, mencoes: null, regraAntiga: false },
    etapas: [{ ordem: 1, nome: '1º bimestre', peso: 1 }, { ordem: 2, nome: '2º bimestre', peso: 2 }],
    itens: [
      { id: 'P1', titulo: 'Prova 1', origem: 'prova', tipo: null, moduloId: 'm1', modulo: 'Módulo 1', etapa: 1, peso: 1, recuperacaoDe: null, fora: false, notasLancadas: 3, notasPublicadas: 0 },
      { id: 'man_1', titulo: 'Seminário', origem: 'manual', tipo: 'seminario', tipoRotulo: 'Seminário', moduloId: null, modulo: '', etapa: 2, peso: 1, recuperacaoDe: null, fora: false, notasLancadas: 0, notasPublicadas: 0 },
      { id: 'man_2', titulo: 'Trabalho antigo', origem: 'manual', tipo: 'trabalho', tipoRotulo: 'Trabalho', arquivado: true, etapa: null, peso: 1, notasLancadas: 2, notasPublicadas: 2 },
    ],
    manuais: [
      { id: 'man_1', titulo: 'Seminário', tipo: 'seminario', tipoRotulo: 'Seminário', descricao: '', data: '', moduloId: null, arquivado: false, notasLancadas: 0, notasPublicadas: 0 },
      { id: 'man_2', titulo: 'Trabalho antigo', tipo: 'trabalho', tipoRotulo: 'Trabalho', descricao: '', data: '', moduloId: null, arquivado: true, notasLancadas: 2, notasPublicadas: 2 },
    ],
    modulos: [{ id: 'm1', nome: 'Módulo 1' }],
    tipos: [{ value: 'trabalho', label: 'Trabalho' }, { value: 'seminario', label: 'Seminário' }],
    avisos: [],
    encerrada: false,
    podeAlterar: true,
    ...extra,
  }
}

const planApi = (data) => ({ data, loading: false, error: null, refetch: vi.fn(async () => {}) })

beforeEach(() => {
  mocks.post.mockResolvedValue({ success: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Plano de avaliação da turma', () => {
  it('[UC-NOTAS-008] peso com vírgula e só os campos que mudaram vão no pedido', () => {
    expect(parseWeightInput('2,5')).toBe(2.5)
    expect(parseWeightInput('')).toBe(1)
    expect(Number.isNaN(parseWeightInput('11'))).toBe(true)
    const itens = plano().itens
    expect(planChanges(itens, { P1: { etapa: '2', peso: '1', recuperacaoDe: '', fora: false } })).toEqual({ itens: { P1: { etapa: 2 } }, erros: {} })
    expect(planChanges(itens, { P1: { etapa: '1', peso: '0', recuperacaoDe: '', fora: false } }).erros.P1).toMatch(/Peso de 0,1 a 10/)
  })

  it('[UC-NOTAS-008] troca a etapa e o peso e salva o plano; a recusa do servidor aparece na linha', async () => {
    const user = userEvent.setup()
    const api = planApi(plano())
    const onChanged = vi.fn()
    render(<GradingPlanPanel plan={api} courseId="DES" studentClass="1DES" onChanged={onChanged} />)
    const prova = screen.getByRole('listitem', { name: 'Prova 1' })
    await user.selectOptions(within(prova).getByLabelText('Etapa'), '2')
    const peso = within(prova).getByLabelText('Peso')
    await user.clear(peso)
    await user.type(peso, '2,5')
    expect(screen.getByText('1 alteração')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Salvar plano' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/grading/plan', { courseId: 'DES', studentClass: '1DES', itens: { P1: { etapa: 2, peso: 2.5 } } }))
    expect(api.refetch).toHaveBeenCalled()
    expect(onChanged).toHaveBeenCalled()

    const refusal = Object.assign(new Error('A etapa 3 não existe nos critérios do curso.'), { status: 400, data: { field: 'itens.P1.etapa' } })
    mocks.post.mockRejectedValueOnce(refusal)
    await user.click(within(prova).getByLabelText('Não conta'))
    await user.click(screen.getByRole('button', { name: 'Salvar plano' }))
    expect(await within(prova).findByRole('alert')).toHaveTextContent('A etapa 3 não existe')
  })

  it('[UC-NOTAS-008] nota publicada: o servidor pede o motivo e o plano vai de novo com ele', async () => {
    const user = userEvent.setup()
    const refusal = Object.assign(new Error('Informe o motivo: a turma tem nota publicada.'), { status: 400, data: { code: 'reason_required', field: 'reason' } })
    mocks.post.mockRejectedValueOnce(refusal).mockResolvedValueOnce({ success: true })
    render(<GradingPlanPanel plan={planApi(plano())} courseId="DES" studentClass="1DES" />)
    const prova = screen.getByRole('listitem', { name: 'Prova 1' })
    await user.click(within(prova).getByLabelText('Não conta'))
    await user.click(screen.getByRole('button', { name: 'Salvar plano' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByRole('textbox'), 'Simulado não conta')
    await user.click(within(dialog).getByRole('button', { name: 'Salvar plano' }))
    await waitFor(() => expect(mocks.post).toHaveBeenLastCalledWith('/api/admin/grading/plan', { courseId: 'DES', studentClass: '1DES', itens: { P1: { fora: true } }, reason: 'Simulado não conta' }))
  })

  it('[UC-NOTAS-008] cria avaliação da turma (seminário na etapa 2) e reativa a arquivada', async () => {
    const user = userEvent.setup()
    render(<GradingPlanPanel plan={planApi(plano())} courseId="DES" studentClass="1DES" />)
    await user.click(screen.getByRole('button', { name: 'Nova avaliação da turma' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Título'), 'Seminário de redes')
    await user.selectOptions(within(dialog).getByLabelText('Tipo'), 'seminario')
    await user.selectOptions(within(dialog).getByLabelText('Etapa'), '2')
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/grading/manual-items/create', expect.objectContaining({ courseId: 'DES', studentClass: '1DES', titulo: 'Seminário de redes', tipo: 'seminario', etapa: 2, peso: 1 })))

    // Arquivada com nota publicada: reativar pede o motivo.
    expect(screen.getByText(/Trabalho antigo · 2 nota\(s\) guardada\(s\)/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reativar' }))
    const ask = await screen.findByRole('dialog')
    await user.type(within(ask).getByRole('textbox'), 'Lançada por engano')
    await user.click(within(ask).getByRole('button', { name: 'Reativar' }))
    await waitFor(() => expect(mocks.post).toHaveBeenLastCalledWith('/api/admin/grading/manual-items/restore', { courseId: 'DES', studentClass: '1DES', id: 'man_2', reason: 'Lançada por engano' }))
  })

  it('[UC-NOTAS-008] critérios desligados ou Coordenação: só consulta, sem salvar nem criar', () => {
    const { unmount } = render(<GradingPlanPanel plan={planApi(plano({ ativo: false }))} courseId="DES" studentClass="1DES" />)
    expect(screen.getByText(/critérios de avaliação deste curso estão desligados/)).toBeInTheDocument()
    expect(within(screen.getByRole('listitem', { name: 'Prova 1' })).getByLabelText('Etapa')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Salvar plano' })).not.toBeInTheDocument()
    // Sem critérios, a avaliação da turma já pode ser criada.
    expect(screen.getByRole('button', { name: 'Nova avaliação da turma' })).toBeInTheDocument()
    unmount()
    render(<GradingPlanPanel plan={planApi(plano({ podeAlterar: false }))} courseId="DES" studentClass="1DES" />)
    expect(screen.queryByRole('button', { name: 'Nova avaliação da turma' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Salvar plano' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reativar' })).not.toBeInTheDocument()
  })
})
