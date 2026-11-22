import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Banco de questões na tela Provas (fase 3, P3-S9a: AVA-15): lista com tipo, dificuldade,
// uso e % de acerto; filtros vão ao servidor; editar manda o modelo único com os
// metadados; arquivar tira da lista sem apagar; "Adicionar" leva a questão com bankKey.
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))

import QuestionBankPanel from './QuestionBankPanel'
import { bankAccuracyText, bankItemPayload, bankQuery, bankQuestionForExam, bankUsageText, mergeFacet } from './questionBankModel'
import { editorQuestion } from './questionEditorModel'

const numericItem = {
  key: 'qb_num',
  type: 'numeric',
  questionText: 'Quantos hosts cabem numa /26?',
  category: 'Sub-redes',
  points: 2,
  numeric: { value: 62, tolerance: 0 },
  difficulty: 'media',
  skills: ['Calcular sub-redes'],
  tags: ['ipv4'],
  revision: 3,
  archived: false,
  stats: { usos: 3, respostas: 4, pendentes: 1, acertoPct: 63 },
}
const choiceItem = {
  key: 'qb_mc',
  type: 'multiple_choice',
  questionText: 'Qual camada do modelo OSI cuida do roteamento?',
  category: 'Redes',
  points: 1,
  alternatives: [{ letter: 'A', text: 'Enlace' }, { letter: 'B', text: 'Rede' }],
  correctAnswer: 'B',
  tags: [],
  revision: 1,
  archived: false,
  stats: { usos: 0, respostas: 0, pendentes: 0, acertoPct: null },
}

function bankResponse(questions = [numericItem, choiceItem]) {
  return { success: true, questions, total: questions.length, archivedCount: 1, categorias: ['Redes', 'Sub-redes'], etiquetas: ['ipv4'] }
}

let nativeSpies = []
beforeEach(() => {
  vi.clearAllMocks()
  mocks.get.mockImplementation(async () => bankResponse())
  nativeSpies = ['prompt', 'confirm', 'alert'].map((name) => vi.spyOn(window, name).mockImplementation(() => { throw new Error(`window.${name}`) }))
})
afterEach(() => {
  for (const spy of nativeSpies) {
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  }
  cleanup()
})

const posts = (url) => mocks.post.mock.calls.filter(([path]) => path === url)
const bankDialog = () => screen.getByRole('dialog', { name: 'Banco de questões' })
const itemCard = (text) => within(bankDialog()).getByRole('listitem', { name: text })

describe('[UC-BANCO-001] questionBankModel', () => {
  it('monta a consulta dos filtros, o corpo do banco e a questão que vai para a prova', () => {
    expect(bankQuery({})).toBe('')
    expect(bankQuery({ q: '  hosts ', categoria: 'Redes', tipo: 'numeric', dificuldade: 'sem', tag: '', arquivadas: true }))
      .toBe('?categoria=Redes&tipo=numeric&dificuldade=sem&q=hosts&arquivadas=1')

    const question = editorQuestion({ ...numericItem, bankKey: 'qb_num' })
    const payload = bankItemPayload({ ...question, difficulty: '', skills: '', tags: ' redes, ipv4 ,' }, { category: '   ' })
    expect(payload).toMatchObject({ type: 'numeric', category: 'Geral', difficulty: '', skills: [], tags: ['redes', 'ipv4'] })
    expect(payload).not.toHaveProperty('bankKey')
    expect(bankItemPayload(question, { category: 'x'.repeat(600) }).category).toHaveLength(500)

    expect(bankQuestionForExam(numericItem)).toMatchObject({ bankKey: 'qb_num', type: 'numeric' })
    expect(bankUsageText(numericItem.stats)).toBe('Usada em 3 aplicações')
    expect(bankUsageText({ usos: 1 })).toBe('Usada em 1 aplicação')
    expect(bankUsageText(undefined)).toBe('Ainda não usada')
    expect(bankAccuracyText(numericItem.stats)).toBe('63% de acerto em 4 respostas · 1 aguardando correção')
    expect(bankAccuracyText(choiceItem.stats)).toBe('Sem respostas corrigidas')
  })
})

describe('[UC-BANCO-001] mergeFacet', () => {
  // Rodada de ajuste 1 do A7: depois de salvar, a tela comparava só maiúsculas e tratava
  // "Redes" e "Rêdes" como categorias diferentes até recarregar (o servidor não).
  it('não repete a categoria por acento ou maiúscula e põe na ordem do português', () => {
    const list = ['Linux', 'Redes']
    expect(mergeFacet(list, 'Rêdes')).toBe(list)
    expect(mergeFacet(list, '  REDES ')).toBe(list)
    expect(mergeFacet(list, '')).toBe(list)
    expect(mergeFacet(list, 'Álgebra')).toEqual(['Álgebra', 'Linux', 'Redes'])
    expect(mergeFacet(undefined, 'ipv4')).toEqual(['ipv4'])
  })
})

describe('[UC-BANCO-001] QuestionBankPanel', () => {
  it('lista tipo, dificuldade, revisão, uso e acerto; os filtros vão ao servidor', async () => {
    render(<QuestionBankPanel open onClose={() => {}} />)
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/admin/question-bank'))
    const numeric = await waitFor(() => itemCard('Quantos hosts cabem numa /26?'))
    expect(within(numeric).getByText('Numérica')).toBeTruthy()
    expect(within(numeric).getByText('Média')).toBeTruthy()
    expect(within(numeric).getByText('Revisão 3')).toBeTruthy()
    expect(within(numeric).getByText('Usada em 3 aplicações · 63% de acerto em 4 respostas · 1 aguardando correção')).toBeTruthy()
    expect(within(itemCard('Qual camada do modelo OSI cuida do roteamento?')).getByText('Ainda não usada · Sem respostas corrigidas')).toBeTruthy()
    // Sem prova aberta, não há "Adicionar".
    expect(within(bankDialog()).queryByRole('button', { name: 'Adicionar' })).toBeNull()

    fireEvent.change(within(bankDialog()).getByLabelText('Tipo'), { target: { value: 'numeric' } })
    await waitFor(() => expect(mocks.get).toHaveBeenLastCalledWith('/api/admin/question-bank?tipo=numeric'))
    fireEvent.change(within(bankDialog()).getByLabelText('Etiqueta'), { target: { value: 'ipv4' } })
    await waitFor(() => expect(mocks.get).toHaveBeenLastCalledWith('/api/admin/question-bank?tipo=numeric&tag=ipv4'))
    fireEvent.click(within(bankDialog()).getByRole('switch'))
    await waitFor(() => expect(mocks.get).toHaveBeenLastCalledWith('/api/admin/question-bank?tipo=numeric&tag=ipv4&arquivadas=1'))
    fireEvent.click(within(bankDialog()).getByRole('button', { name: 'Limpar filtros' }))
    await waitFor(() => expect(mocks.get).toHaveBeenLastCalledWith('/api/admin/question-bank?arquivadas=1'))
  })

  it('arquivar tira da lista sem excluir; Adicionar entrega a questão com a chave do banco', async () => {
    const onAddToExam = vi.fn()
    mocks.post.mockImplementation(async (url, body) => {
      if (url === '/api/admin/question-bank/archive') return { success: true, question: { ...choiceItem, archived: body.archived } }
      return { success: true }
    })
    render(<QuestionBankPanel open onClose={() => {}} onAddToExam={onAddToExam} />)
    const numeric = await waitFor(() => itemCard('Quantos hosts cabem numa /26?'))
    fireEvent.click(within(numeric).getByRole('button', { name: 'Adicionar' }))
    expect(onAddToExam).toHaveBeenCalledTimes(1)
    expect(bankQuestionForExam(onAddToExam.mock.calls[0][0])).toMatchObject({ bankKey: 'qb_num', type: 'numeric' })

    const choice = itemCard('Qual camada do modelo OSI cuida do roteamento?')
    await act(async () => { fireEvent.click(within(choice).getByRole('button', { name: 'Arquivar' })) })
    expect(posts('/api/admin/question-bank/archive')).toEqual([['/api/admin/question-bank/archive', { key: 'qb_mc', archived: true }]])
    expect(posts('/api/admin/question-bank/delete')).toHaveLength(0)
    await waitFor(() => expect(within(bankDialog()).queryByRole('listitem', { name: 'Qual camada do modelo OSI cuida do roteamento?' })).toBeNull())
    expect(within(bankDialog()).getByRole('switch').parentElement.textContent).toContain('Mostrar arquivadas (2)')
  })

  it('editar abre o cartão do editor e manda o modelo único com categoria e metadados', async () => {
    mocks.post.mockImplementation(async (url, body) => ({ success: true, question: { ...numericItem, ...body, questionText: body.text, revision: 4 } }))
    render(<QuestionBankPanel open onClose={() => {}} />)
    const numeric = await waitFor(() => itemCard('Quantos hosts cabem numa /26?'))
    fireEvent.click(within(numeric).getByRole('button', { name: 'Editar' }))
    const dialog = bankDialog()
    fireEvent.change(within(dialog).getByLabelText('Categoria'), { target: { value: 'Redes' } })
    fireEvent.change(within(dialog).getByLabelText('Enunciado'), { target: { value: 'Quantos hosts úteis cabem numa /26?' } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar alterações' })) })
    const calls = posts('/api/admin/question-bank/update')
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toMatchObject({
      key: 'qb_num',
      type: 'numeric',
      text: 'Quantos hosts úteis cabem numa /26?',
      category: 'Redes',
      difficulty: 'media',
      skills: ['Calcular sub-redes'],
      tags: ['ipv4'],
    })
    expect(calls[0][1]).not.toHaveProperty('bankKey')
    expect(mocks.toast.success).toHaveBeenCalledWith('Questão do banco atualizada')
    await waitFor(() => expect(within(bankDialog()).getByRole('listitem', { name: 'Quantos hosts úteis cabem numa /26?' })).toBeTruthy())
  })

  // Rodada de ajuste 2 do A7: com filtro, a questão editada que deixava de bater com ele
  // continuava na lista até o próximo GET; e um GET recusado deixava a lista velha com o
  // texto "com estes filtros".
  it('com filtro, salvar recarrega a lista do servidor (a questão que não bate mais sai)', async () => {
    mocks.post.mockImplementation(async (url, body) => ({ success: true, question: { ...numericItem, ...body, questionText: body.text, revision: 4 } }))
    render(<QuestionBankPanel open onClose={() => {}} />)
    await waitFor(() => itemCard('Quantos hosts cabem numa /26?'))
    fireEvent.change(within(bankDialog()).getByLabelText('Categoria'), { target: { value: 'Sub-redes' } })
    await waitFor(() => expect(mocks.get).toHaveBeenLastCalledWith('/api/admin/question-bank?categoria=Sub-redes'))
    mocks.get.mockImplementation(async () => bankResponse([choiceItem]))
    const before = mocks.get.mock.calls.length
    fireEvent.click(within(itemCard('Quantos hosts cabem numa /26?')).getByRole('button', { name: 'Editar' }))
    const dialog = bankDialog()
    fireEvent.change(within(dialog).getAllByLabelText('Categoria')[0], { target: { value: 'Redes' } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar alterações' })) })
    await waitFor(() => expect(mocks.get.mock.calls.length).toBe(before + 1))
    expect(mocks.get).toHaveBeenLastCalledWith('/api/admin/question-bank?categoria=Sub-redes')
    await waitFor(() => expect(within(bankDialog()).queryByRole('listitem', { name: 'Quantos hosts cabem numa /26?' })).toBeNull())
    // A categoria some das que o servidor manda, mas o filtro continua visível no campo.
    mocks.get.mockImplementation(async () => ({ ...bankResponse([]), categorias: ['Redes'] }))
    fireEvent.change(within(bankDialog()).getByLabelText('Tipo'), { target: { value: 'numeric' } })
    await waitFor(() => expect(mocks.get).toHaveBeenLastCalledWith('/api/admin/question-bank?categoria=Sub-redes&tipo=numeric'))
    await waitFor(() => expect(within(bankDialog()).getByText('Nenhuma questão com estes filtros')).toBeTruthy())
    expect(within(bankDialog()).getByLabelText('Categoria').value).toBe('Sub-redes')
  })

  it('categoria longa vai inteira no filtro; GET recusado não deixa a lista velha "com estes filtros"', async () => {
    const longCategory = 'Camada de transporte '.repeat(5).trim()
    expect(longCategory.length).toBeGreaterThan(80)
    expect(bankQuery({ categoria: longCategory })).toBe(`?${new URLSearchParams({ categoria: longCategory })}`)
    mocks.get.mockImplementation(async (url) => {
      if (url.includes('categoria=')) throw new Error('O campo "categoria" está em formato inválido.')
      return { ...bankResponse(), categorias: [longCategory, 'Redes'] }
    })
    render(<QuestionBankPanel open onClose={() => {}} />)
    await waitFor(() => itemCard('Quantos hosts cabem numa /26?'))
    fireEvent.change(within(bankDialog()).getByLabelText('Categoria'), { target: { value: longCategory } })
    await waitFor(() => expect(within(bankDialog()).getByRole('alert').textContent).toContain('formato inválido'))
    expect(within(bankDialog()).getByRole('status').textContent).toBe('Não foi possível carregar o banco com estes filtros.')
    expect(within(bankDialog()).queryByRole('listitem', { name: 'Quantos hosts cabem numa /26?' })).toBeNull()
  })

  it('questão com problema não vai ao servidor', async () => {
    render(<QuestionBankPanel open onClose={() => {}} defaultCategory="Linux" />)
    await waitFor(() => itemCard('Quantos hosts cabem numa /26?'))
    fireEvent.click(within(bankDialog()).getByRole('button', { name: 'Nova questão' }))
    expect(within(bankDialog()).getByLabelText('Categoria').value).toBe('Linux')
    await act(async () => { fireEvent.click(within(bankDialog()).getByRole('button', { name: 'Salvar no banco' })) })
    expect(posts('/api/admin/question-bank/create')).toHaveLength(0)
    expect(mocks.toast.error).toHaveBeenCalled()
  })
})
