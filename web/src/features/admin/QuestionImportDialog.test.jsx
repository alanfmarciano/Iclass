import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Importar e exportar o banco de questões (fase 3, P3-S9b: AVA-15; D22): prévia no
// servidor antes de gravar, erros por linha, repetidas, confirmação com o sha256 da prévia
// e exportação com os filtros da lista. A Coordenação (só de consulta) exporta e não
// importa.
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  downloadFile: vi.fn(),
  auth: { auth: {} },
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post }, downloadFile: mocks.downloadFile }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => mocks.auth }))

import QuestionImportDialog, { QuestionExportDialog } from './QuestionImportDialog'
import QuestionBankPanel from './QuestionBankPanel'
import {
  bankExportPath,
  importConfirmLabel,
  importCount,
  importDuplicateText,
  importSummaryText,
  markdownPlain,
  bankExcerpt,
  questionsWithImages,
} from './questionBankModel'

const SHA = 'a'.repeat(64)
const previewResponse = {
  success: true,
  formato: 'gift',
  sha256: SHA,
  total: 5,
  validas: 2,
  duplicadas: 1,
  comErro: 2,
  itens: [
    { linha: 3, category: 'Redes', type: 'multiple_choice', points: 1, questionText: 'Qual porta o HTTP usa?', alternatives: [{ letter: 'A', text: '80', isCorrect: true }, { letter: 'B', text: '21', isCorrect: false }], correctAnswer: 'A', tags: ['redes'], duplicada: false, arquivada: false, noArquivo: null, avisos: ['O comentário de cada resposta (#) não existe no IClass e ficou de fora.'] },
    { linha: 7, category: 'Geral', type: 'numeric', points: 2, questionText: 'Hosts numa /26?', alternatives: [], correctAnswer: '', numeric: { value: 62, tolerance: 0 }, tags: [], duplicada: false, arquivada: false, noArquivo: null, avisos: [] },
    { linha: 9, category: 'Geral', type: 'true_false', points: 1, questionText: 'IPv4 tem 32 bits.', alternatives: [{ letter: 'A', text: 'Verdadeiro', isCorrect: true }, { letter: 'B', text: 'Falso', isCorrect: false }], correctAnswer: 'A', tags: [], duplicada: true, arquivada: true, noArquivo: null, avisos: [] },
  ],
  erros: [{ linha: 5, mensagem: 'Questão de associação (->) não existe no IClass.' }, { linha: 11, mensagem: 'Marque exatamente uma alternativa correta.' }],
  avisos: [],
}

let nativeSpies = []
beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth = { auth: {} }
  mocks.get.mockImplementation(async () => ({ success: true, questions: [], total: 0, archivedCount: 0, categorias: [], etiquetas: [] }))
  nativeSpies = ['prompt', 'confirm', 'alert'].map((name) => vi.spyOn(window, name).mockImplementation(() => { throw new Error(`window.${name}`) }))
})
afterEach(() => {
  for (const spy of nativeSpies) {
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  }
  cleanup()
})

const importDialog = () => screen.getByRole('dialog', { name: 'Importar questões' })

describe('[UC-BANCO-002] questionBankModel: importar e exportar', () => {
  it('resume a prévia, conta o que entra e monta o caminho da exportação com os filtros', () => {
    expect(importSummaryText(previewResponse)).toBe('2 questões prontas para importar, 1 repetida (já está no banco ou mais acima no arquivo) e 2 com erro.')
    expect(importSummaryText({ validas: 1, duplicadas: 0, comErro: 0 })).toBe('1 questão pronta para importar.')
    expect(importCount(previewResponse)).toBe(2)
    expect(importCount(previewResponse, true)).toBe(3)
    expect(importConfirmLabel(1)).toBe('Importar 1 questão')
    expect(importConfirmLabel(3)).toBe('Importar 3 questões')
    expect(importDuplicateText({ duplicada: true, noArquivo: 4 })).toBe('Repetida da linha 4')
    expect(importDuplicateText({ duplicada: true, arquivada: true })).toBe('Já está no banco (arquivada)')
    expect(importDuplicateText({ duplicada: false })).toBe('')
    expect(bankExportPath({}, 'gift')).toBe('/api/admin/question-bank/export?formato=gift')
    expect(bankExportPath({ categoria: 'Sub-redes', tag: 'ipv4', q: 'host', arquivadas: true }, 'csv'))
      .toBe('/api/admin/question-bank/export?formato=csv&categoria=Sub-redes&tag=ipv4&q=host&arquivadas=1')
    // Quem diz se a questão tem imagem é o servidor (imagens, pelo referencedExamUploads):
    // a resposta esperada conta, e o texto sem o campo não conta.
    expect(questionsWithImages([{ imagens: ['a.png'] }, { imagens: [] }, { questionText: 'Veja ![rede](/uploads/a.png)' }, { imagens: ['b.png', 'c.png'] }])).toBe(2)
  })

  it('sem nada para importar, o botão diz isso; a prévia e o cartão mostram o enunciado sem as marcas do Markdown', () => {
    expect(importConfirmLabel(0)).toBe('Nada para importar')
    expect(markdownPlain('Qual porta o **HTTP** usa por _padrão_? Veja `curl` e ![rede](/uploads/a.png)')).toBe('Qual porta o HTTP usa por _padrão_? Veja curl e [imagem: rede]')
    expect(markdownPlain('2 * 3 * 4 = 24 e *itálico*')).toBe('2 * 3 * 4 = 24 e itálico')
    expect(bankExcerpt('# Título\n\n- item **um**\n```js\nx = 1\n```')).toBe('Título item um x = 1')
  })
})

describe('[UC-BANCO-002] QuestionImportDialog', () => {
  it('cola o GIFT, vê a prévia com erros por linha e repetidas e confirma com o sha256 da prévia', async () => {
    const onImported = vi.fn()
    const onClose = vi.fn()
    mocks.post.mockImplementation(async (url) => {
      if (url === '/api/admin/question-bank/import/preview') return previewResponse
      if (url === '/api/admin/question-bank/import') return { success: true, importadas: 3, ignoradas: 0, comErro: 2 }
      throw new Error(url)
    })
    render(<QuestionImportDialog open onClose={onClose} onImported={onImported} />)
    fireEvent.click(within(importDialog()).getByRole('button', { name: 'Colar o texto' }))
    fireEvent.change(within(importDialog()).getByLabelText('Texto GIFT'), { target: { value: 'Qual porta o HTTP usa? {=80 ~21}' } })
    fireEvent.change(within(importDialog()).getByLabelText('Categoria das questões sem categoria'), { target: { value: ' Redes ' } })
    await act(async () => { fireEvent.click(within(importDialog()).getByRole('button', { name: 'Ver prévia' })) })
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/question-bank/import/preview', { formato: 'gift', categoriaPadrao: 'Redes', conteudo: 'Qual porta o HTTP usa? {=80 ~21}' })

    expect(within(importDialog()).getByRole('status').textContent).toBe('2 questões prontas para importar, 1 repetida (já está no banco ou mais acima no arquivo) e 2 com erro.')
    const errors = within(importDialog()).getByRole('list', { name: 'Erros da importação' })
    expect(within(errors).getByText('Linha 5: Questão de associação (->) não existe no IClass.')).toBeTruthy()
    expect(within(errors).getByText('Linha 11: Marque exatamente uma alternativa correta.')).toBeTruthy()
    const items = within(importDialog()).getByRole('list', { name: 'Questões do arquivo' })
    const first = within(items).getByRole('listitem', { name: 'Linha 3' })
    expect(within(first).getByText('Uma correta')).toBeTruthy()
    expect(within(first).getByText('Redes · resposta A · redes')).toBeTruthy()
    expect(within(first).getByText('O comentário de cada resposta (#) não existe no IClass e ficou de fora.')).toBeTruthy()
    expect(within(within(items).getByRole('listitem', { name: 'Linha 7' })).getByText('Geral · resposta 62')).toBeTruthy()
    expect(within(within(items).getByRole('listitem', { name: 'Linha 9' })).getByText('Já está no banco (arquivada)')).toBeTruthy()

    // Repetidas ficam de fora; ligar a chave leva também.
    expect(within(importDialog()).getByRole('button', { name: 'Importar 2 questões' })).toBeTruthy()
    fireEvent.click(within(importDialog()).getByRole('switch'))
    const confirm = within(importDialog()).getByRole('button', { name: 'Importar 3 questões' })
    await act(async () => { fireEvent.click(confirm) })
    expect(mocks.post).toHaveBeenLastCalledWith('/api/admin/question-bank/import', { formato: 'gift', categoriaPadrao: 'Redes', conteudo: 'Qual porta o HTTP usa? {=80 ~21}', sha256: SHA, ignorarDuplicadas: false })
    expect(mocks.toast.success).toHaveBeenCalledWith('3 questões importadas para o banco')
    expect(onImported).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('arquivo diferente da prévia: a prévia sai e o motivo aparece; Voltar também apaga a prévia', async () => {
    mocks.post.mockImplementation(async (url) => {
      if (url === '/api/admin/question-bank/import/preview') return previewResponse
      const error = new Error('O arquivo não é o mesmo da prévia. Veja a prévia de novo antes de importar.')
      error.status = 409
      error.data = { code: 'import_changed' }
      throw error
    })
    render(<QuestionImportDialog open onClose={() => {}} />)
    fireEvent.click(within(importDialog()).getByRole('button', { name: 'Colar o texto' }))
    fireEvent.change(within(importDialog()).getByLabelText('Texto GIFT'), { target: { value: 'Q? {=a ~b}' } })
    await act(async () => { fireEvent.click(within(importDialog()).getByRole('button', { name: 'Ver prévia' })) })
    await act(async () => { fireEvent.click(within(importDialog()).getByRole('button', { name: 'Importar 2 questões' })) })
    expect(within(importDialog()).getByRole('alert').textContent).toMatch(/não é o mesmo da prévia/)
    expect(within(importDialog()).queryByRole('list', { name: 'Questões do arquivo' })).toBeNull()
    expect(within(importDialog()).getByLabelText('Texto GIFT').value).toBe('Q? {=a ~b}')

    await act(async () => { fireEvent.click(within(importDialog()).getByRole('button', { name: 'Ver prévia' })) })
    fireEvent.click(within(importDialog()).getByRole('button', { name: 'Voltar' }))
    expect(within(importDialog()).queryByRole('status')).toBeNull()
    expect(within(importDialog()).getByRole('button', { name: 'Ver prévia' })).toBeTruthy()
  })

  it('escolher a planilha manda o arquivo em base64 com o nome e troca o formato; arquivo de mais de 2 MB nem vai', async () => {
    mocks.post.mockImplementation(async () => ({ ...previewResponse, formato: 'csv', erros: [], comErro: 0 }))
    render(<QuestionImportDialog open onClose={() => {}} />)
    expect(within(importDialog()).getByLabelText('Formato').value).toBe('gift')
    const input = within(importDialog()).getByLabelText(/Arquivo/)
    const big = new File(['x'], 'grande.gift', { type: 'text/plain' })
    Object.defineProperty(big, 'size', { value: 2 * 1024 * 1024 + 1 })
    await act(async () => { fireEvent.change(input, { target: { files: [big] } }) })
    expect(within(importDialog()).getByRole('alert').textContent).toBe('O arquivo passa de 2 MB. Divida em arquivos menores.')

    const csv = new File(['Enunciado;Alternativa A;Alternativa B;Correta\r\nQual?;Sim;Não;A\r\n'], 'banco.csv', { type: 'text/csv' })
    await act(async () => { fireEvent.change(input, { target: { files: [csv] } }) })
    await waitFor(() => expect(within(importDialog()).getByText('banco.csv')).toBeTruthy())
    expect(within(importDialog()).getByLabelText('Formato').value).toBe('csv')
    await act(async () => { fireEvent.click(within(importDialog()).getByRole('button', { name: 'Ver prévia' })) })
    const [url, body] = mocks.post.mock.calls[0]
    expect(url).toBe('/api/admin/question-bank/import/preview')
    expect(body.formato).toBe('csv')
    expect(body.nomeArquivo).toBe('banco.csv')
    expect(body.categoriaPadrao).toBeNull()
    expect(atob(body.arquivo)).toBe(String.fromCharCode(...new TextEncoder().encode('Enunciado;Alternativa A;Alternativa B;Correta\r\nQual?;Sim;Não;A\r\n')))
  })

  it('sem arquivo nem texto, a prévia não vai ao servidor', async () => {
    render(<QuestionImportDialog open onClose={() => {}} />)
    await act(async () => { fireEvent.click(within(importDialog()).getByRole('button', { name: 'Ver prévia' })) })
    expect(mocks.post).not.toHaveBeenCalled()
    expect(within(importDialog()).getByRole('alert').textContent).toBe('Escolha o arquivo com as questões.')
  })
})

describe('[UC-BANCO-002] QuestionExportDialog e o painel do banco', () => {
  it('baixa em GIFT ou CSV com os filtros da lista e avisa das imagens', async () => {
    mocks.downloadFile.mockResolvedValue('banco-de-questoes_2026-11-23.csv')
    const onClose = vi.fn()
    render(<QuestionExportDialog open onClose={onClose} filters={{ categoria: 'Redes', tipo: '', q: '' }} questions={[{ questionText: '![a](/uploads/a.png)', imagens: ['a.png'] }, { questionText: 'b', imagens: [] }]} />)
    const dialog = screen.getByRole('dialog', { name: 'Exportar questões' })
    expect(within(dialog).getByText(/1 questão tem imagem/)).toBeTruthy()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Baixar planilha (CSV)' })) })
    expect(mocks.downloadFile).toHaveBeenCalledWith('/api/admin/question-bank/export?formato=csv&categoria=Redes', 'banco-de-questoes.csv')
    expect(mocks.toast.success).toHaveBeenCalledWith('Arquivo banco-de-questoes_2026-11-23.csv baixado')
    expect(onClose).toHaveBeenCalled()
  })

  it('o painel tem Importar e Exportar; a conta só de consulta não vê Importar', async () => {
    mocks.get.mockImplementation(async () => ({ success: true, questions: [{ key: 'q1', type: 'true_false', questionText: 'V?', category: 'Geral', correctAnswer: 'A', alternatives: [], tags: [], stats: {} }], total: 1, archivedCount: 0, categorias: ['Geral'], etiquetas: [] }))
    const { unmount } = render(<QuestionBankPanel open onClose={() => {}} />)
    const bank = () => screen.getByRole('dialog', { name: 'Banco de questões' })
    await waitFor(() => expect(within(bank()).getByRole('button', { name: 'Exportar' }).disabled).toBe(false))
    fireEvent.click(within(bank()).getByRole('button', { name: 'Importar' }))
    expect(screen.getByRole('dialog', { name: 'Importar questões' })).toBeTruthy()
    unmount()

    mocks.auth = { auth: { readOnly: true } }
    render(<QuestionBankPanel open onClose={() => {}} />)
    await waitFor(() => expect(within(bank()).getByRole('button', { name: 'Exportar' }).disabled).toBe(false))
    expect(within(bank()).queryByRole('button', { name: 'Importar' })).toBeNull()
    fireEvent.click(within(bank()).getByRole('button', { name: 'Exportar' }))
    expect(screen.getByRole('dialog', { name: 'Exportar questões' })).toBeTruthy()
  })
})
