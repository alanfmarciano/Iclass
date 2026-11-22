import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Editor de questões do professor (fase 3, P3-S3: AVA-06, FUN-10, UXA-12): os seis tipos,
// pontos com vírgula, rubrica com a soma conferida, imagem enviada pelo editor, prévia
// como o aluno vê e confirmação antes de excluir.
const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))
vi.mock('../../lib/api', () => ({ api: { post: mocks.post } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))

import QuestionEditor, { QuestionCard } from './QuestionEditor'
import { editorQuestion, editorQuestionPayload, firstEvaluationProblem } from './questionEditorModel'

let latest = []
function Harness({ initial, showProblems = false, onSaveToBank }) {
  const [questions, setQuestions] = useState(() => initial.map(editorQuestion))
  latest = questions
  return <QuestionEditor questions={questions} onChange={setQuestions} showProblems={showProblems} onSaveToBank={onSaveToBank} />
}

let nativeSpies = []
beforeEach(() => {
  vi.clearAllMocks()
  latest = []
  nativeSpies = ['prompt', 'confirm', 'alert'].map((name) => vi.spyOn(window, name).mockImplementation(() => { throw new Error(`window.${name}`) }))
})
afterEach(() => {
  for (const spy of nativeSpies) {
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  }
  cleanup()
})

const card = (number) => screen.getByRole('group', { name: `Questão ${number}` })
const payloads = () => latest.map(editorQuestionPayload)
const setType = (number, type) => fireEvent.change(within(card(number)).getByLabelText('Tipo da questão'), { target: { value: type } })
const type = (element, value) => fireEvent.change(element, { target: { value } })

describe('[UC-PROVA-004] editor de questões do professor', () => {
  it('cada tipo mostra os seus campos e salva o gabarito do tipo', () => {
    render(<Harness initial={[{}]} />)
    const q = () => within(card(1))
    type(q().getByLabelText('Enunciado'), 'Qual protocolo usa a porta 80?')
    ;['HTTP', 'FTP', 'SSH', 'DNS'].forEach((value, index) => type(q().getByLabelText(`Texto da alternativa ${'ABCD'[index]} da questão 1`), value))
    // Uma correta: rádio; a primeira vem marcada.
    expect(q().getByLabelText('Marcar alternativa A como correta')).toHaveAttribute('type', 'radio')
    fireEvent.click(q().getByLabelText('Marcar alternativa C como correta'))
    expect(payloads()[0]).toMatchObject({ type: 'multiple_choice', points: 1, correctAnswer: 'C' })
    expect(payloads()[0].alternatives.map((alt) => alt.isCorrect)).toEqual([false, false, true, false])

    // Várias corretas: caixas e pontuação parcial (padrão ligada).
    setType(1, 'multiple_answer')
    expect(q().getByText(/Ex\.: "Marque os protocolos da camada de transporte\."/)).toBeInTheDocument()
    expect(q().getByLabelText('Marcar alternativa A como correta')).toHaveAttribute('type', 'checkbox')
    fireEvent.click(q().getByLabelText('Marcar alternativa A como correta'))
    expect(payloads()[0]).toMatchObject({ type: 'multiple_answer', correctAnswers: ['A', 'C'], partialCredit: true })
    fireEvent.click(q().getByRole('switch', { name: 'Pontuação parcial' }))
    expect(q().getByText(/Tudo ou nada/)).toBeInTheDocument()
    expect(payloads()[0].partialCredit).toBe(false)

    // Verdadeiro ou falso: duas respostas, sem alternativas no corpo.
    setType(1, 'true_false')
    expect(q().queryByLabelText('Texto da alternativa A da questão 1')).toBeNull()
    expect(firstEvaluationProblem(latest).message).toBe('Questão 1: marque se a afirmação é verdadeira ou falsa.')
    fireEvent.click(q().getByRole('radio', { name: 'Resposta certa: Falso' }))
    expect(payloads()[0]).toEqual({ type: 'true_false', points: 1, text: 'Qual protocolo usa a porta 80?', correctAnswer: 'B', explanation: '' })

    // Numérica: valor com vírgula, tolerância, unidade e "mandar para mim".
    setType(1, 'numeric')
    type(q().getByLabelText('Resposta certa'), '3,5')
    type(q().getByLabelText('Tolerância (±)'), '0,25')
    type(q().getByLabelText('Unidade (opcional)'), 'ms')
    fireEvent.click(q().getByRole('switch', { name: 'Mandar para mim quando a resposta não bater' }))
    expect(payloads()[0]).toMatchObject({ type: 'numeric', numeric: { value: 3.5, tolerance: 0.25, unit: 'ms' }, review: 'professor' })
    expect(payloads()[0].alternatives).toBeUndefined()

    // Resposta curta: lista de respostas aceitas.
    setType(1, 'short_answer')
    type(q().getByLabelText('Resposta aceita 1 da questão 1'), 'ls')
    fireEvent.click(q().getByRole('button', { name: 'Adicionar resposta aceita' }))
    type(q().getByLabelText('Resposta aceita 2 da questão 1'), 'ls -l')
    expect(payloads()[0]).toMatchObject({ type: 'short_answer', acceptedAnswers: ['ls', 'ls -l'], review: 'professor' })

    // Dissertativa: resposta esperada.
    setType(1, 'essay')
    type(q().getByLabelText(/Resposta esperada/), 'Rota até o destino.')
    expect(payloads()[0]).toMatchObject({ type: 'essay', expectedAnswer: 'Rota até o destino.' })
    expect(payloads()[0].rubric).toBeUndefined()

    // De volta para Uma correta: as alternativas e a marca continuam lá.
    setType(1, 'multiple_choice')
    expect(q().getByLabelText('Texto da alternativa D da questão 1')).toHaveValue('DNS')
    expect(payloads()[0]).toMatchObject({ type: 'multiple_choice', correctAnswer: 'A' })
  })

  it('pontos com vírgula, total da prova e rubrica com a soma conferida', () => {
    render(<Harness initial={[{ text: 'A', alternatives: [{ text: 'x', isCorrect: true }, { text: 'y' }] }, { type: 'essay', text: 'Explique.' }]} />)
    expect(screen.getByText('Total da prova: 2 pontos')).toBeInTheDocument()
    type(within(card(1)).getByLabelText('Pontos'), '2,5')
    type(within(card(2)).getByLabelText('Pontos'), '3')
    expect(screen.getByText('Total da prova: 5,5 pontos')).toBeInTheDocument()
    expect(payloads()[0].points).toBe(2.5)

    const q2 = within(card(2))
    fireEvent.click(q2.getByRole('button', { name: 'Adicionar critério' }))
    type(q2.getByLabelText('Critério 1 da rubrica da questão 2'), 'Conceito')
    type(q2.getByLabelText('Pontos do critério 1 da questão 2'), '2')
    fireEvent.click(q2.getByRole('button', { name: 'Adicionar critério' }))
    type(q2.getByLabelText('Critério 2 da rubrica da questão 2'), 'Exemplo')
    type(q2.getByLabelText('Pontos do critério 2 da questão 2'), '1,5')
    expect(q2.getByRole('status')).toHaveTextContent('Soma dos critérios: 3,5 de 3 (precisa ser igual aos pontos)')
    expect(firstEvaluationProblem(latest).message).toBe('Questão 2: a soma dos critérios da rubrica (3,5) precisa ser igual aos pontos da questão (3).')
    fireEvent.click(q2.getByRole('button', { name: 'Usar 3,5 como pontos' }))
    expect(q2.getByRole('status')).toHaveTextContent('Soma dos critérios: 3,5 de 3,5 (confere)')
    expect(firstEvaluationProblem(latest)).toBeNull()
    expect(payloads()[1]).toMatchObject({ type: 'essay', points: 3.5, rubric: [{ nome: 'Conceito', pontos: 2 }, { nome: 'Exemplo', pontos: 1.5 }] })

    type(within(card(1)).getByLabelText('Pontos'), '0')
    expect(screen.getByText(/1 com pontos inválidos fora da soma/)).toBeInTheDocument()
    expect(firstEvaluationProblem(latest).message).toBe('Questão 1: os pontos devem ficar entre 0,1 e 100, com até duas casas decimais.')
  })

  it('a questão de antes abre com o que tinha: rubrica com os ids, explicação, metadados e o tipo', () => {
    const essay = { type: 'essay', points: 3, text: 'Explique.', expectedAnswer: 'Algo', rubric: [{ id: 'c1', nome: 'A', pontos: 2 }, { id: 'c7', nome: 'B', pontos: 1 }], explanation: 'Porque sim.', difficulty: 'media', skills: ['EM13MAT101'], tags: ['redes', 'ipv4'] }
    render(<Harness initial={[essay]} />)
    expect(screen.getByRole('button', { name: /Mais detalhes/ })).toHaveAttribute('aria-expanded', 'true')
    expect(payloads()[0]).toEqual({
      type: 'essay', points: 3, text: 'Explique.', expectedAnswer: 'Algo',
      rubric: [{ id: 'c1', nome: 'A', pontos: 2 }, { id: 'c7', nome: 'B', pontos: 1 }],
      explanation: 'Porque sim.', difficulty: 'media', skills: ['EM13MAT101'], tags: ['redes', 'ipv4'],
    })
    // Questão antiga sem tipo: "Uma correta" de 1 ponto, com a letra que tinha.
    cleanup()
    render(<Harness initial={[{ text: 'Velha', alternatives: [{ letter: 'A', text: 'x' }, { letter: 'B', text: 'y' }], correctAnswer: 'B', weight: 1 }]} />)
    expect(within(card(1)).getByLabelText('Tipo da questão')).toHaveValue('multiple_choice')
    expect(within(card(1)).getByLabelText('Pontos')).toHaveValue('1')
    expect(payloads()[0]).toMatchObject({ type: 'multiple_choice', points: 1, correctAnswer: 'B' })
  })

  it('a imagem enviada entra no Markdown com o endereço limpo e aparece na prévia', async () => {
    mocks.post.mockResolvedValue({ success: true, url: '/uploads/abc123.png' })
    localStorage.setItem('iclass-v3-auth', JSON.stringify({ adminSession: 'sessao-do-professor' }))
    try {
      render(<Harness initial={[{ text: 'Observe a topologia:', alternatives: [{ text: 'Estrela', isCorrect: true }, { text: 'Anel' }] }]} />)
      const q = within(card(1))
      const file = new File([new Uint8Array([137, 80, 78, 71])], 'topologia [sala].png', { type: 'image/png' })
      await act(async () => {
        fireEvent.change(q.getAllByTestId('question-image-input')[0], { target: { files: [file] } })
      })
      await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1))
      const [url, form] = mocks.post.mock.calls[0]
      expect(url).toBe('/api/admin/upload-image')
      expect(form.get('image')).toBe(file)
      await waitFor(() => expect(latest[0].text).toContain('![topologia sala](/uploads/abc123.png)'))
      expect(latest[0].text).not.toContain('access=')
      const preview = screen.getByLabelText('Prévia da questão 1')
      const img = preview.querySelector('img')
      expect(img.getAttribute('src')).toBe('/uploads/abc123.png?access=sessao-do-professor')
      expect(mocks.toast.success).toHaveBeenCalledWith('Imagem inserida')
    } finally {
      localStorage.removeItem('iclass-v3-auth')
    }
  })

  it('a prévia mostra o Markdown, o campo do aluno e a resposta certa; negrito e tabela pela barra', () => {
    render(<Harness initial={[{ type: 'true_false', text: 'O IPv4 tem **32 bits**.', correctAnswer: 'A', explanation: 'Quatro *octetos*.' }]} />)
    const preview = screen.getByLabelText('Prévia da questão 1')
    expect(preview.querySelector('strong').textContent).toBe('32 bits')
    expect(within(preview).getByRole('radio', { name: 'Verdadeiro' })).toBeInTheDocument()
    expect(preview).toHaveTextContent('Resposta certa: Verdadeiro')
    expect(preview.querySelector('em').textContent).toBe('octetos')
    const text = within(card(1)).getByLabelText('Enunciado')
    text.setSelectionRange(0, 0)
    fireEvent.click(within(card(1)).getByRole('button', { name: 'Tabela em Enunciado' }))
    expect(latest[0].text).toContain('| Coluna 1 | Coluna 2 |\n| --- | --- |')
    expect(screen.getByLabelText('Prévia da questão 1').querySelector('.question-md-table table')).not.toBeNull()
    const len = latest[0].text.length
    within(card(1)).getByLabelText('Enunciado').setSelectionRange(len, len)
    fireEvent.click(within(card(1)).getByRole('button', { name: 'Negrito em Enunciado' }))
    expect(latest[0].text.endsWith('**texto**')).toBe(true)
  })

  it('excluir questão preenchida pergunta antes; Cancelar mantém; questão vazia sai direto', () => {
    render(<Harness initial={[{ text: 'Primeira' }, { text: 'Segunda com texto' }, {}]} />)
    fireEvent.click(within(card(2)).getByRole('button', { name: 'Excluir (questão 2)' }))
    let dialog = screen.getByRole('dialog', { name: 'Excluir a questão 2?' })
    expect(dialog).toHaveTextContent('"Segunda com texto" sai da prova quando você salvar.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(latest).toHaveLength(3)
    fireEvent.click(within(card(2)).getByRole('button', { name: 'Excluir (questão 2)' }))
    dialog = screen.getByRole('dialog', { name: 'Excluir a questão 2?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }))
    expect(latest.map((question) => question.text)).toEqual(['Primeira', ''])
    // A vazia (agora a 2) sai sem perguntar.
    fireEvent.click(within(card(2)).getByRole('button', { name: 'Excluir (questão 2)' }))
    expect(screen.queryByRole('dialog', { name: /Excluir a questão/ })).toBeNull()
    expect(latest).toHaveLength(1)
    expect(within(card(1)).getByRole('button', { name: 'Excluir (questão 1)' })).toBeDisabled()
  })

  // Desde o A7 (P3-S9a) o banco guarda os seis tipos: "Salvar no banco" vale para todos; a
  // questão que já veio do banco (bankKey) mostra "Do banco" e não é salva de novo, e a
  // cópia por "Duplicar" é uma questão nova (sem a chave).
  it('com a conferência ligada, a questão mostra o que falta; salvar no banco em todo tipo, menos a que já é do banco', () => {
    const onSaveToBank = vi.fn()
    render(<Harness initial={[
      { type: 'short_answer', text: '' },
      { type: 'essay', text: 'Explique.' },
      { text: 'Ok', alternatives: [{ text: 'a', isCorrect: true }, { text: 'b' }], bankKey: 'qb_1' },
    ]} showProblems onSaveToBank={onSaveToBank} />)
    const missing = within(card(1)).getByRole('list', { name: 'O que falta na questão 1' })
    expect(missing).toHaveTextContent('Informe o enunciado.')
    expect(missing).toHaveTextContent('Informe pelo menos uma resposta aceita.')
    expect(within(card(2)).queryByRole('list')).toBeNull()
    fireEvent.click(within(card(2)).getByRole('button', { name: 'Salvar no banco (questão 2)' }))
    expect(onSaveToBank).toHaveBeenCalledTimes(1)
    expect(onSaveToBank.mock.calls[0][0].type).toBe('essay')
    expect(within(card(1)).getByRole('button', { name: 'Salvar no banco (questão 1)' })).not.toBeDisabled()
    expect(within(card(3)).getByText('Do banco')).toBeInTheDocument()
    expect(within(card(3)).getByRole('button', { name: 'Salvar no banco (questão 3)' })).toBeDisabled()
    fireEvent.click(within(card(3)).getByRole('button', { name: 'Duplicar (questão 3)' }))
    expect(within(card(4)).queryByText('Do banco')).toBeNull()
    expect(within(card(4)).getByRole('button', { name: 'Salvar no banco (questão 4)' })).not.toBeDisabled()
  })

  it('sem os botões de lista, o cartão serve de editor de um item só (banco de questões)', () => {
    render(<QuestionCard question={editorQuestion({ text: 'Q', type: 'true_false', correctAnswer: 'A' })} index={0} onChange={() => {}} label="Questão do banco" />)
    const group = screen.getByRole('group', { name: 'Questão do banco' })
    for (const name of [/Subir/, /Descer/, /Duplicar/, /Salvar no banco/, /Excluir \(questão/]) {
      expect(within(group).queryByRole('button', { name })).toBeNull()
    }
    expect(within(group).getByLabelText('Tipo da questão')).toHaveValue('true_false')
  })

  // Rodada de ajuste 1 do A6: a numérica voltava ao editor arredondada em 6 casas
  // (3,14159265 virava 3,141593 e 0,0000001 virava 0) e salvar de novo mudava o gabarito.
  it('valor e tolerância da numérica voltam ao editor sem arredondar; salvar de novo não muda nada', () => {
    const numeric = { type: 'numeric', text: 'Pi?', numeric: { value: 3.14159265, tolerance: 5e-8, unit: 'rad' } }
    render(<Harness initial={[numeric, { type: 'numeric', text: 'Pequeno', numeric: { value: 1e-7, tolerance: 0 } }]} />)
    expect(within(card(1)).getByLabelText('Resposta certa')).toHaveValue('3,14159265')
    expect(within(card(1)).getByLabelText('Tolerância (±)')).toHaveValue('0,00000005')
    expect(within(card(2)).getByLabelText('Resposta certa')).toHaveValue('0,0000001')
    expect(payloads()[0].numeric).toEqual({ value: 3.14159265, tolerance: 5e-8, unit: 'rad' })
    expect(payloads()[1].numeric).toEqual({ value: 1e-7, tolerance: 0 })
    // Abrir de novo o que foi salvo dá o mesmo corpo (ida e volta).
    const again = payloads().map((payload) => editorQuestionPayload(editorQuestion(payload)))
    expect(again).toEqual(payloads())
    expect(firstEvaluationProblem(latest)).toBeNull()
  })

  // Rodada de ajuste 1 do A6: etiqueta com mais de 40 letras ia para o servidor e voltava
  // como 400 genérico, sem "Questão N:" e sem levar ao cartão.
  it('etiqueta, habilidade e critério da rubrica compridos demais aparecem no cartão antes de enviar', () => {
    render(<Harness initial={[{ text: 'Ok', alternatives: [{ text: 'a', isCorrect: true }, { text: 'b' }] }]} showProblems />)
    const q = within(card(1))
    fireEvent.click(q.getByRole('button', { name: /Mais detalhes/ }))
    type(q.getByLabelText('Etiquetas'), `redes, ${'x'.repeat(41)}`)
    expect(firstEvaluationProblem(latest).message).toBe('Questão 1: cada item de etiquetas tem no máximo 40 caracteres.')
    expect(q.getByRole('list', { name: 'O que falta na questão 1' })).toHaveTextContent('Cada item de etiquetas tem no máximo 40 caracteres.')
    type(q.getByLabelText('Etiquetas'), `redes, ${'x'.repeat(40)}`)
    type(q.getByLabelText('Habilidades'), 'h'.repeat(81))
    expect(firstEvaluationProblem(latest).message).toBe('Questão 1: cada item de habilidades tem no máximo 80 caracteres.')
    type(q.getByLabelText('Habilidades'), 'h'.repeat(80))
    expect(firstEvaluationProblem(latest)).toBeNull()
    expect(payloads()[0].tags).toEqual(['redes', 'x'.repeat(40)])
    // O nome do critério da rubrica segue o limite do servidor (80).
    const essay = editorQuestion({ type: 'essay', points: 1, text: 'Explique.', rubric: [{ nome: 'n'.repeat(81), pontos: 1 }] })
    expect(firstEvaluationProblem([essay]).message).toBe('Questão 1: o nome do critério 1 da rubrica aceita no máximo 80 caracteres.')
  })

  // Rodada de ajuste 1 do A6: o desenho pede alvos de 44 px nas alternativas (celular).
  it('a marca da correta e os botões de excluir da linha têm alvo de 44 px', () => {
    render(<Harness initial={[{ text: 'Ok', alternatives: [{ text: 'a', isCorrect: true }, { text: 'b' }, { text: 'c' }] }, { type: 'short_answer', text: 'Cmd?', acceptedAnswers: ['ls', 'dir'] }, { type: 'essay', text: 'E', points: 1, rubric: [{ nome: 'A', pontos: 1 }] }]} />)
    const mark = within(card(1)).getByLabelText('Marcar alternativa B como correta')
    // O rótulo inteiro (marca e letra) é o alvo: clicar na letra marca a correta.
    const target = mark.closest('label')
    expect(target).toHaveClass('h-11')
    fireEvent.click(within(target).getByText('B'))
    expect(payloads()[0].correctAnswer).toBe('B')
    ;[
      within(card(1)).getByRole('button', { name: 'Excluir alternativa A' }),
      within(card(2)).getByRole('button', { name: 'Excluir resposta aceita 1' }),
      within(card(3)).getByRole('button', { name: 'Excluir critério 1' }),
    ].forEach((button) => expect(button).toHaveClass('!h-11', '!w-11'))
  })
})
