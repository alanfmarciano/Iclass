import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GradingCriteriaDialog, criteriaPayload, formFromCriteria, recoveryExample } from './GradingCriteriaDialog'

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), toast: { success: vi.fn(), error: vi.fn() }, criteria: null }))
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))

// GET /api/admin/grading/criteria como o servidor devolve (B6), com os critérios desligados.
function criterios(extra = {}) {
  const padrao = { versao: 1, ativo: true, mediaMinima: 6, frequenciaMinima: 75, etapas: [{ ordem: 1, nome: 'Etapa única', peso: 1 }], recuperacao: { etapa: 'nenhuma', final: 'substitui_se_maior' }, mencoes: null, unidadeSituacao: 'disciplina' }
  return {
    courseId: 'DES', courseName: 'Desenvolvimento', ativo: false, regraAntiga: true,
    criterio: { mediaMinima: 6, mencoes: null, regraAntiga: true },
    criterios: { ...padrao, ativo: false }, padrao,
    regrasRecuperacao: [
      { value: 'nenhuma', label: 'Sem recuperação' },
      { value: 'substitui_se_maior', label: 'A recuperação substitui a média, se for maior' },
      { value: 'media', label: 'Média entre a média e a recuperação' },
      { value: 'ate_a_minima', label: 'A recuperação sobe a média no máximo até a média mínima' },
    ],
    unidades: [{ value: 'disciplina', label: 'Por disciplina' }, { value: 'turma', label: 'Uma situação para a turma' }],
    limites: { etapasMax: 6, mencoesMax: 8, pesoMin: 0.1, pesoMax: 10 },
    temNotaPublicada: false,
    podeAlterar: true,
    ...extra,
  }
}

beforeEach(() => {
  mocks.criteria = criterios()
  mocks.get.mockImplementation(async (path) => (path.startsWith('/api/admin/grading/criteria') ? mocks.criteria : {}))
  mocks.post.mockResolvedValue({ success: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderDialog(props = {}) {
  return render(<GradingCriteriaDialog open course={{ id: 'DES', name: 'Desenvolvimento' }} onClose={vi.fn()} {...props} />)
}

describe('Critérios de avaliação do curso', () => {
  it('[UC-NOTAS-008] o formulário e o pedido usam vírgula e numeram as etapas em sequência', () => {
    const form = formFromCriteria(criterios())
    expect(form).toMatchObject({ ativo: false, mediaMinima: '6', frequenciaMinima: '75', usarMencoes: false })
    const payload = criteriaPayload({ ...form, ativo: true, mediaMinima: '5,5', etapas: [{ nome: '1º bimestre', peso: '1' }, { nome: '', peso: '2,5' }] })
    expect(payload).toMatchObject({ ativo: true, mediaMinima: '5,5', etapas: [{ ordem: 1, nome: '1º bimestre', peso: '1' }, { ordem: 2, nome: 'Etapa 2', peso: '2,5' }], mencoes: null })
    expect(recoveryExample('ate_a_minima', '5,5')).toContain('5,5')
  })

  it('[UC-NOTAS-008] liga os critérios com 2 etapas e menções, vê a prévia e salva', async () => {
    const user = userEvent.setup()
    mocks.post.mockImplementation(async (path) => (path === '/api/admin/grading/preview'
      ? { success: true, resumo: 'Com esta regra, 1 aluno muda de situação.', mudancas: [{ studentClass: '1DES', email: 'ana@x.local', nome: 'Ana', mediaAntes: 5.5, mediaDepois: 6.5, situacaoAntesRotulo: null, situacaoDepoisRotulo: 'Aprovado' }] }
      : { success: true }))
    const onSaved = vi.fn()
    renderDialog({ onSaved })
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByLabelText('Média mínima (0 a 10)')
    await user.click(within(dialog).getByRole('switch', { name: /Usar critérios/ }))
    const minima = within(dialog).getByLabelText('Média mínima (0 a 10)')
    await user.clear(minima)
    await user.type(minima, '5,5')
    await user.click(within(dialog).getByRole('button', { name: 'Adicionar etapa' }))
    const peso2 = within(dialog).getAllByLabelText('Peso')[1]
    await user.clear(peso2)
    await user.type(peso2, '2')
    await user.click(within(dialog).getByRole('switch', { name: /menção/ }))
    expect(within(dialog).getAllByLabelText('Sigla').map((input) => input.value)).toEqual(['MB', 'B', 'R', 'I'])
    await user.click(within(dialog).getByRole('button', { name: 'Ver prévia' }))
    expect(await within(dialog).findByText('Com esta regra, 1 aluno muda de situação.')).toBeInTheDocument()
    expect(within(dialog).getByText('5,5 → 6,5')).toBeInTheDocument()
    const preview = mocks.post.mock.calls.find(([path]) => path === '/api/admin/grading/preview')[1]
    expect(preview).toMatchObject({ courseId: 'DES', criterios: { ativo: true, mediaMinima: '5,5', etapas: [{ ordem: 1 }, { ordem: 2, peso: '2' }] } })
    await user.click(within(dialog).getByRole('button', { name: 'Salvar critérios' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/grading/criteria', expect.objectContaining({
      courseId: 'DES', ativo: true, mediaMinima: '5,5',
      etapas: [{ ordem: 1, nome: 'Etapa única', peso: '1' }, { ordem: 2, nome: '2ª etapa', peso: '2' }],
      mencoes: [{ sigla: 'MB', nome: 'Muito bom', min: '9' }, { sigla: 'B', nome: 'Bom', min: '7' }, { sigla: 'R', nome: 'Regular', min: '6' }, { sigla: 'I', nome: 'Insuficiente', min: '0' }],
    })))
    expect(onSaved).toHaveBeenCalled()
  })

  it('[UC-NOTAS-008] recusa do servidor aparece no campo apontado', async () => {
    const user = userEvent.setup()
    mocks.criteria = criterios({ ativo: true, criterios: { ...criterios().padrao, ativo: true } })
    mocks.post.mockRejectedValueOnce(Object.assign(new Error('O peso da etapa vai de 0,1 a 10.'), { status: 400, data: { field: 'etapas[0].peso' } }))
    renderDialog()
    const dialog = await screen.findByRole('dialog')
    const peso = await within(dialog).findByLabelText('Peso')
    await user.clear(peso)
    await user.type(peso, '20')
    await user.click(within(dialog).getByRole('button', { name: 'Salvar critérios' }))
    expect(await within(dialog).findByText('O peso da etapa vai de 0,1 a 10.')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Peso')).toHaveAttribute('aria-invalid', 'true')
  })

  it('[UC-NOTAS-008] curso com nota publicada: pede o motivo e manda junto', async () => {
    const user = userEvent.setup()
    mocks.criteria = criterios({ temNotaPublicada: true })
    renderDialog()
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByLabelText('Média mínima (0 a 10)')
    await user.click(within(dialog).getByRole('switch', { name: /Usar critérios/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Salvar critérios' }))
    const ask = (await screen.findAllByRole('dialog')).at(-1)
    await user.type(within(ask).getByRole('textbox'), 'Regimento novo da escola')
    await user.click(within(ask).getByRole('button', { name: 'Salvar critérios' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/grading/criteria', expect.objectContaining({ ativo: true, reason: 'Regimento novo da escola' })))
  })

  it('[UC-NOTAS-008] professor e Coordenação veem os critérios sem alterar', async () => {
    mocks.criteria = criterios({ podeAlterar: false })
    renderDialog()
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(/Só quem gerencia cursos pode alterá-los/)).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Média mínima (0 a 10)')).toBeDisabled()
    expect(within(dialog).getByRole('switch', { name: /Usar critérios/ })).toBeDisabled()
    expect(within(dialog).queryByRole('button', { name: 'Salvar critérios' })).not.toBeInTheDocument()
    expect(within(dialog).getAllByRole('button', { name: 'Fechar' }).length).toBeGreaterThan(0)
  })
})
