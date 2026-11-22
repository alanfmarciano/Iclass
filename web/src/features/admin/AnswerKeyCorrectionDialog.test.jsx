import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnswerKeyCorrectionDialog, answerKeyPayload, correctableQuestions, currentKeyDraft, impactSummary, preparationNotice, previewNeedsSave } from './AnswerKeyCorrectionDialog'
import { ExamApplicationDetail } from './ExamApplicationDetail'

const mocks = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }))
vi.mock('../../lib/api', () => ({ api: { post: mocks.post, get: mocks.get } }))

// Aplicação encerrada com duas versões: na B as alternativas estão ao contrário (a letra
// original fica em letter). A questão 4 foi cadastrada com a C, e a certa era a B.
function application(extra = {}) {
  const q4 = (reverse) => {
    const alternatives = [
      { letter: 'A', text: '255.0.0.0' }, { letter: 'B', text: '255.255.255.0' },
      { letter: 'C', text: '255.255.0.0', isCorrect: true }, { letter: 'D', text: '0.0.0.0' },
    ]
    return { originalNumber: 4, type: 'multiple_choice', text: 'Qual é a máscara /24?', correctAnswer: 'C', alternatives: reverse ? [...alternatives].reverse() : alternatives }
  }
  return {
    id: 'app_1',
    status: 'finished',
    historyId: 'hist_1',
    finishedAt: '2026-11-20T13:00:00.000Z',
    annulledQuestions: [],
    versionSnapshots: [
      { version: 'A', questions: [
        q4(false),
        { originalNumber: 5, type: 'numeric', text: 'Latência?', numeric: { value: 3.5, tolerance: 0.25, unit: 'ms' }, alternatives: [] },
        { originalNumber: 6, type: 'essay', text: 'Explique.', alternatives: [] },
        { originalNumber: 7, type: 'multiple_answer', text: 'Transporte?', alternatives: [{ letter: 'A', text: 'TCP', isCorrect: true }, { letter: 'B', text: 'HTTP' }, { letter: 'C', text: 'UDP' }] },
      ] },
      { version: 'B', questions: [q4(true)] },
    ],
    ...extra,
  }
}

const PREVIEW = {
  success: true, dryRun: true, regraded: 9, changed: 3, published: 2,
  question: { number: 4, type: 'multiple_choice', antes: 'C · 255.255.0.0', depois: 'B · 255.255.255.0' },
  students: [
    { submissionId: 's1', name: 'Ana Lima', from: 71, to: 86, published: true },
    { submissionId: 's2', name: 'Bruno Costa', from: 86, to: 71, published: true },
    { submissionId: 's3', name: 'Dani Rocha', from: 57, to: 71, published: false },
  ],
}

describe('Corrigir gabarito depois da prova', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(cleanup)

  it('[UC-PROVA-005] mostra a prévia do impacto antes de gravar e só grava depois dela', async () => {
    const user = userEvent.setup()
    const onCorrected = vi.fn()
    mocks.post.mockImplementation(async (url, body) => (body.dryRun ? PREVIEW : { success: true, changed: 3, notifiedStudents: 2 }))
    render(<AnswerKeyCorrectionDialog open application={application()} onClose={() => {}} onCorrected={onCorrected} />)

    const dialog = screen.getByRole('dialog')
    // A dissertativa fica de fora; a questão 4 vem com a letra de hoje marcada, pela letra original.
    const select = within(dialog).getByLabelText('Questão')
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Questão 4 · Uma correta · Qual é a máscara /24?',
      'Questão 5 · Numérica · Latência?',
      'Questão 7 · Várias corretas · Transporte?',
    ])
    const radios = within(dialog).getAllByRole('radio')
    expect(radios.map((radio) => radio.checked)).toEqual([false, false, true, false])
    const save = within(dialog).getByRole('button', { name: 'Corrigir gabarito' })
    const preview = within(dialog).getByRole('button', { name: 'Ver impacto' })
    expect(save).toBeDisabled()
    expect(preview).toBeDisabled()
    expect(within(dialog).getByText('Escreva o motivo (pelo menos 5 caracteres).')).toBeVisible()

    await user.click(within(dialog).getByText('255.255.255.0'))
    await user.type(within(dialog).getByLabelText(/^Motivo/), 'A máscara /24 é 255.255.255.0.')
    expect(save).toBeDisabled()
    await user.click(preview)
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/exam-applications/app_1/answer-key-correction', {
      questionNumber: 4, correctAnswer: 'B', motivo: 'A máscara /24 é 255.255.255.0.', dryRun: true,
    }))
    const status = await within(dialog).findByRole('status')
    expect(status).toHaveTextContent('Muda a nota de 3 alunos (2 já publicadas: eles serão avisados).')
    expect(status).toHaveTextContent('Resposta certa: C · 255.255.0.0 → B · 255.255.255.0')
    expect(status).toHaveTextContent('Ana Lima7,1 → 8,6publicada')
    expect(status).toHaveTextContent('Dani Rocha5,7 → 7,1')
    expect(save).toBeEnabled()

    // Mudar um campo pede a prévia de novo.
    await user.type(within(dialog).getByLabelText(/^Motivo/), '!')
    expect(within(dialog).queryByRole('status')).not.toBeInTheDocument()
    expect(save).toBeDisabled()
    await user.click(preview)
    await within(dialog).findByRole('status')
    await user.click(save)
    await waitFor(() => expect(mocks.post).toHaveBeenLastCalledWith('/api/admin/exam-applications/app_1/answer-key-correction', {
      questionNumber: 4, correctAnswer: 'B', motivo: 'A máscara /24 é 255.255.255.0.!',
    }))
    expect(onCorrected).toHaveBeenCalledWith({ success: true, changed: 3, notifiedStudents: 2 })
  })

  it('[UC-PROVA-005] a prévia diz que a preparação (segunda chamada e impressão) também muda e quem fica com a resposta antiga', async () => {
    const user = userEvent.setup()
    mocks.post.mockResolvedValue({ ...PREVIEW, preparacao: { atualizada: true, preparadas: 1, outrasAplicacoes: 2 } })
    render(<AnswerKeyCorrectionDialog open application={application()} onClose={() => {}} />)
    const dialog = screen.getByRole('dialog')
    // O conselho de antes ("corrija lá também para as próximas aplicações") levava a
    // reaplicar a preparação com o gabarito errado.
    expect(dialog).not.toHaveTextContent('para as próximas aplicações')
    expect(dialog).toHaveTextContent('A preparação desta aplicação também passa a usar a resposta certa ("Imprimir" e "Aplicar online" de novo, como na segunda chamada).')
    await user.click(within(dialog).getByText('255.255.255.0'))
    await user.type(within(dialog).getByLabelText(/^Motivo/), 'A máscara /24 é 255.255.255.0.')
    await user.click(within(dialog).getByRole('button', { name: 'Ver impacto' }))
    const status = await within(dialog).findByRole('status')
    expect(status).toHaveTextContent('A preparação desta prova passa a usar a resposta certa: "Imprimir" e "Aplicar online" de novo (como na segunda chamada) saem com ela. A aplicação dela já preparada, que ainda não começou, também.')
    expect(status).toHaveTextContent('Outras 2 aplicações desta preparação já começaram e continuam com a resposta antiga: corrija em cada uma, pelo botão dela.')
  })

  it('[UC-PROVA-005] aplicação que já tem a resposta certa (corrigida ao vivo) ainda grava para acertar a preparação', async () => {
    expect(previewNeedsSave(null)).toBe(false)
    expect(previewNeedsSave({ changed: 0 })).toBe(true)
    expect(previewNeedsSave({ unchanged: true, preparacao: { atualizada: false, preparadas: 0, outrasAplicacoes: 1 } })).toBe(false)
    expect(previewNeedsSave({ unchanged: true, preparacao: { atualizada: true, preparadas: 0 } })).toBe(true)
    expect(previewNeedsSave({ unchanged: true, preparacao: { atualizada: false, preparadas: 2 } })).toBe(true)
    expect(preparationNotice({ preparacao: { atualizada: false, preparadas: 0, outrasAplicacoes: 1 } })).toEqual([
      'Outra aplicação desta preparação já começou e continua com a resposta antiga: corrija nela também, pelo botão dela.',
    ])
    expect(preparationNotice({ preparacao: { atualizada: false, preparadas: 3, outrasAplicacoes: 0 } })[0]).toMatch(/As 3 aplicações dela já preparadas, que ainda não começaram, também\.$/)
    expect(preparationNotice({})).toEqual([])

    const user = userEvent.setup()
    const message = 'O gabarito da questão 4 já é este nesta aplicação: nenhuma nota muda. A preparação vai passar a usar este gabarito também.'
    mocks.post.mockResolvedValue({ success: true, unchanged: true, dryRun: true, changed: 0, message, preparacao: { atualizada: true, preparadas: 0, outrasAplicacoes: 0 } })
    render(<AnswerKeyCorrectionDialog open application={application()} onClose={() => {}} />)
    const dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByLabelText(/^Motivo/), 'Acertar a preparação.')
    await user.click(within(dialog).getByRole('button', { name: 'Ver impacto' }))
    expect(await within(dialog).findByRole('status')).toHaveTextContent(message)
    expect(within(dialog).getByRole('button', { name: 'Corrigir gabarito' })).toBeEnabled()
  })

  it('[UC-PROVA-005] no celular o diálogo ocupa a tela inteira e os botões não espremem o texto', () => {
    render(<AnswerKeyCorrectionDialog open application={application()} onClose={() => {}} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toMatch(/(^| )h-full( |$)/)
    expect(dialog.className).toMatch(/rounded-none/)
    expect(dialog.className).toMatch(/sm:rounded-xl/)
    expect(dialog.parentElement.className).toMatch(/p-0 sm:p-4/)
    const footer = within(dialog).getByRole('button', { name: 'Ver impacto' }).parentElement
    expect(footer.className).toMatch(/flex-wrap/)
  })

  it('[UC-PROVA-005] questão anulada pede "Tirar a anulação"; erro do servidor aparece no diálogo', async () => {
    const user = userEvent.setup()
    mocks.post.mockRejectedValue(new Error('A aplicação foi cancelada.'))
    render(<AnswerKeyCorrectionDialog open application={application({ annulledQuestions: [{ questionNumber: 4, mode: 'ponto_para_todos' }] })} onClose={() => {}} />)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByLabelText('Questão').options[0].textContent).toBe('Questão 4 · Uma correta · anulada · Qual é a máscara /24?')
    await user.type(within(dialog).getByLabelText(/^Motivo/), 'Gabarito estava errado.')
    expect(within(dialog).getByRole('button', { name: 'Ver impacto' })).toBeDisabled()
    expect(within(dialog).getByText('Esta questão está anulada: marque "Tirar a anulação" para corrigir pelo gabarito.')).toBeVisible()
    await user.click(within(dialog).getByRole('checkbox', { name: /Tirar a anulação desta questão \(ponto para todos\)/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Ver impacto' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/exam-applications/app_1/answer-key-correction', expect.objectContaining({ tirarAnulacao: true, dryRun: true })))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('A aplicação foi cancelada.')
  })

  it('[UC-PROVA-005] gabarito por tipo: numérica com vírgula, várias corretas e respostas aceitas', () => {
    const [q4, q5, q7] = correctableQuestions(application())
    expect(q4.alternatives.map((alternative) => alternative.letter)).toEqual(['A', 'B', 'C', 'D'])
    expect(currentKeyDraft(q5)).toEqual({ value: '3,5', tolerance: '0,25' })
    expect(answerKeyPayload(q5, { value: ' 3,6 ', tolerance: '' })).toEqual({ numeric: { value: '3,6', tolerance: '0' } })
    expect(currentKeyDraft(q7)).toEqual({ letters: ['A'] })
    expect(answerKeyPayload(q7, { letters: ['C', 'A'] })).toEqual({ correctAnswers: ['A', 'C'] })
    expect(answerKeyPayload({ type: 'short_answer' }, { accepted: 'máscara\n\n  máscara de rede  ' })).toEqual({ acceptedAnswers: ['máscara', 'máscara de rede'] })
    expect(impactSummary({ changed: 1, published: 1 })).toBe('Muda a nota de 1 aluno (1 já publicada: o aluno será avisado).')
    expect(impactSummary({ changed: 2, published: 0 })).toBe('Muda a nota de 2 alunos (nenhuma publicada ainda).')
    expect(impactSummary({ changed: 0 })).toBe('Nenhuma nota muda com o gabarito novo.')
    expect(impactSummary({ unchanged: true, message: 'O gabarito da questão 4 já é este: nenhuma nota muda.' })).toBe('O gabarito da questão 4 já é este: nenhuma nota muda.')
    // A questão trocada no Monitor sai da lista.
    const replaced = application()
    replaced.versionSnapshots[0].questions.push({ originalNumber: 8, isAdditional: true, replacedQuestionNumber: 5, type: 'multiple_choice', text: 'Nova', alternatives: [{ letter: 'A', text: 'x', isCorrect: true }, { letter: 'B', text: 'y' }] })
    expect(correctableQuestions(replaced).map((item) => item.number)).toEqual([4, 7, 8])
  })

  it('[UC-PROVA-005] a aplicação da preparação mostra "Corrigir gabarito" só para quem muda nota e as correções feitas', async () => {
    const user = userEvent.setup()
    const entry = { id: 'hist_1', type: 'online', questionNumbers: [4], printSnapshot: [] }
    const corrected = application({ answerKeyCorrections: [{ questionNumber: 4, antes: 'C · 255.255.0.0', depois: 'B · 255.255.255.0', changed: 3, motivo: 'Máscara /24.', em: '2026-11-20T14:00:00.000Z' }] })
    const cancelled = application({ id: 'app_2', status: 'cancelled', finishedAt: null, createdAt: '2026-11-19T10:00:00.000Z' })
    render(<ExamApplicationDetail entry={entry} title="Prova" applications={[corrected, cancelled]} canCorrectAnswerKey onBack={() => {}} />)
    expect(screen.getByText('Aplicações online desta preparação')).toBeVisible()
    expect(screen.getAllByRole('button', { name: 'Corrigir gabarito' })).toHaveLength(1)
    expect(screen.getByText(/C · 255\.255\.0\.0 → B · 255\.255\.255\.0 · 3 notas mudaram/)).toBeVisible()
    expect(screen.getByText('Cancelada')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Corrigir gabarito' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Muda só a resposta certa desta aplicação')
    cleanup()
    render(<ExamApplicationDetail entry={entry} title="Prova" applications={[corrected]} canCorrectAnswerKey={false} onBack={() => {}} />)
    expect(screen.getByText(/3 notas mudaram/)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Corrigir gabarito' })).not.toBeInTheDocument()
  })
})
