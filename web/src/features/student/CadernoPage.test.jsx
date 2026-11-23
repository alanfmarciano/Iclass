import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 2, H9b (ENG-03): o caderno tem o mesmo teto do servidor (50.000 caracteres por
// unidade) e mostra a contagem a partir de 45.000. Antes não havia limite nenhum e o
// aluno gravava notas de 9 MB que pesavam a sala inteira.
const apiPost = vi.hoisted(() => vi.fn())
const apiGet = vi.hoisted(() => vi.fn())
const printMocks = vi.hoisted(() => ({ open: vi.fn(), print: vi.fn() }))
vi.mock('../../lib/api', () => ({ api: { get: apiGet, post: apiPost } }))
vi.mock('./useStudent', () => ({ useStudent: () => ({ email: 'ana@escola.local', name: 'Ana', displayName: 'Ana Souza', courseId: 'DES', studentClass: '1DES', courses: [{ id: 'DES', name: 'Desenvolvimento de Sistemas' }] }) }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }))
vi.mock('../../context/BrandingProvider', () => ({ useBranding: () => ({ branding: { displayName: 'Escola Técnica Azul', schoolName: 'Escola Técnica Azul' } }) }))
vi.mock('../../lib/printDocument', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, openPrintWindow: printMocks.open, printDocument: printMocks.print }
})

import { MemoryRouter } from 'react-router-dom'
import CadernoPageComponent from './CadernoPage'
import { Textarea, formatCharCount } from '../../components/ui/Textarea'
import { notebookFileName, notebookPrintOptions, notebookSections, notebookText } from './cadernoExport'
import { printDocumentHtml } from '../../lib/printDocument'

const EMPTY_NOTEBOOK = { success: true, geral: '', unidades: [], timezone: 'America/Sao_Paulo' }
function CadernoPage() {
  return <MemoryRouter><CadernoPageComponent /></MemoryRouter>
}

beforeEach(() => {
  apiPost.mockReset()
  apiPost.mockResolvedValue({ note: '' })
  apiGet.mockReset()
  apiGet.mockResolvedValue(EMPTY_NOTEBOOK)
  printMocks.open.mockReset()
  printMocks.print.mockReset()
})
afterEach(() => cleanup())

describe('[UC-CADERNO-001] Caderno do aluno: teto de 50.000 caracteres e contagem', () => {
  it('o campo tem maxLength 50.000 e a contagem só aparece a partir de 45.000', async () => {
    apiPost.mockResolvedValue({ note: 'curta' })
    const { container } = render(<CadernoPage />)
    const field = container.querySelector('#nb')
    await waitFor(() => expect(field.value).toBe('curta'))
    expect(field.getAttribute('maxLength')).toBe('50000')
    expect(screen.queryByText(/caracteres$/)).not.toBeInTheDocument()

    fireEvent.change(field, { target: { value: 'a'.repeat(45000) } })
    expect(screen.getByText('45.000 de 50.000 caracteres')).toBeInTheDocument()
    expect(field.getAttribute('aria-describedby')).toBe('nb-counter')
  })

  it('nota antiga maior que o teto aparece inteira, com a contagem em destaque', async () => {
    apiPost.mockResolvedValue({ note: 'b'.repeat(60000) })
    const { container } = render(<CadernoPage />)
    await waitFor(() => expect(container.querySelector('#nb').value.length).toBe(60000))
    expect(screen.getByText('60.000 de 50.000 caracteres')).toHaveClass('text-warning')
  })

  it('Textarea sem counterFrom só aplica o teto; formatCharCount usa o milhar com ponto', () => {
    const { container } = render(<Textarea id="x" value={'c'.repeat(4999)} maxLength={5000} onChange={() => {}} />)
    expect(container.querySelector('#x').getAttribute('maxLength')).toBe('5000')
    expect(screen.queryByText(/caracteres$/)).not.toBeInTheDocument()
    expect(formatCharCount(1000000)).toBe('1.000.000')
    expect(formatCharCount(999)).toBe('999')
  })
})

// Fase 3, C17 (P5-S3; UXA-14, D25 do P5): o caderno sai do IClass. Antes só a nota geral
// aparecia (e só para editar); as notas das unidades e os destaques ficavam presos no
// leitor, e nada imprimia nem baixava.
const NOTEBOOK = {
  success: true,
  timezone: 'America/Sao_Paulo',
  geral: 'Estudar para a prova',
  unidades: [
    { chave: 'Apostila_DES_1', titulo: 'Redes <locais>', modulo: 'Fundamentos', nota: 'Linha 1\nLinha 2', destaques: [{ paragrafo: 'p2', trecho: 'A rede liga <b>computadores</b>', nota: 'cai na prova' }] },
    { chave: 'Apostila_DES_3', titulo: 'Laboratório', modulo: 'Prática', nota: '', destaques: [{ paragrafo: 'p1', trecho: 'Cabo par trançado', nota: '' }] },
  ],
}

describe('[UC-CADERNO-002] Caderno do aluno: notas por unidade, imprimir e baixar .txt', () => {
  it('"Minhas notas por unidade" lista cada unidade com o módulo, a nota e os destaques, como texto', async () => {
    apiPost.mockResolvedValue({ note: 'Estudar para a prova' })
    apiGet.mockResolvedValue(NOTEBOOK)
    const { container } = render(<CadernoPage />)
    expect(await screen.findByRole('link', { name: 'Redes <locais>' })).toHaveAttribute('href', '/aluno/modulos?unidade=Apostila_DES_1')
    expect(apiGet).toHaveBeenCalledWith('/api/student/notebook?courseId=DES&studentClass=1DES')
    const unit = screen.getByRole('region', { name: 'Redes <locais>' })
    expect(unit).toHaveTextContent('Fundamentos')
    expect(unit).toHaveTextContent('Linha 1 Linha 2')
    expect(unit).toHaveTextContent('“A rede liga <b>computadores</b>”')
    expect(unit).toHaveTextContent('cai na prova')
    expect(container.querySelector('b')).toBeNull()
    expect(screen.getByRole('region', { name: 'Laboratório' })).toHaveTextContent('Cabo par trançado')
  })

  it('sem nota de unidade, diz como começar', async () => {
    render(<CadernoPage />)
    expect(await screen.findByText(/Nenhuma nota de unidade ainda/)).toBeInTheDocument()
  })

  it('falha ao carregar as notas das unidades mostra o erro e "Tentar de novo"', async () => {
    apiGet.mockRejectedValueOnce(new Error('Sem conexão com o servidor.'))
    render(<CadernoPage />)
    expect(await screen.findByText('Sem conexão com o servidor.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    expect(await screen.findByText(/Nenhuma nota de unidade ainda/)).toBeInTheDocument()
  })

  it('"Imprimir caderno" abre o documento da escola com a nota geral da tela e as unidades', async () => {
    apiPost.mockResolvedValue({ note: 'Estudar para a prova' })
    apiGet.mockResolvedValue(NOTEBOOK)
    printMocks.open.mockReturnValue({ fake: true })
    printMocks.print.mockReturnValue(true)
    const { container } = render(<CadernoPage />)
    await screen.findByRole('link', { name: 'Redes <locais>' })
    await waitFor(() => expect(container.querySelector('#nb').value).toBe('Estudar para a prova'))
    fireEvent.change(container.querySelector('#nb'), { target: { value: 'Ainda não salvo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Imprimir caderno' }))
    expect(printMocks.open).toHaveBeenCalledTimes(1)
    const [options, win] = printMocks.print.mock.calls[0]
    expect(win).toEqual({ fake: true })
    expect(options.titulo).toBe('Caderno')
    expect(options.subtitulo).toBe('Ana Souza · Desenvolvimento de Sistemas · Turma 1DES')
    expect(options.escola.nome).toBe('Escola Técnica Azul')
    expect(options.secoes.map((section) => section.titulo)).toEqual(['Anotações gerais', 'Redes <locais>', 'Laboratório'])
    expect(options.secoes[0].paragrafos).toContain('Ainda não salvo')
    // O HTML do documento escapa tudo o que veio do aluno e da apostila.
    const html = printDocumentHtml(options)
    expect(html).toContain('Redes &lt;locais&gt;')
    expect(html).toContain('A rede liga &lt;b&gt;computadores&lt;/b&gt;')
    expect(html).not.toContain('<b>computadores')
    expect(html).toContain('Gerado por Escola Técnica Azul em')
  })

  it('janela bloqueada: avisa como liberar', async () => {
    printMocks.open.mockReturnValue(null)
    printMocks.print.mockReturnValue(false)
    render(<CadernoPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Imprimir caderno' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('O navegador bloqueou a janela do caderno.')
  })

  it('"Baixar caderno (.txt)" baixa no aparelho (Blob), com o nome do curso e a data', async () => {
    apiGet.mockResolvedValue(NOTEBOOK)
    const created = []
    const createObjectURL = vi.fn((blob) => { created.push(blob); return 'blob:caderno' })
    const revokeObjectURL = vi.fn()
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL
    const clicks = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record() { clicks.push({ href: this.href, download: this.download }) })
    try {
      render(<CadernoPage />)
      await screen.findByRole('link', { name: 'Redes <locais>' })
      fireEvent.click(screen.getByRole('button', { name: 'Baixar caderno (.txt)' }))
      expect(clicks).toHaveLength(1)
      expect(clicks[0].download).toMatch(/^caderno-desenvolvimento-de-sistemas-\d{4}-\d{2}-\d{2}\.txt$/)
      expect(created[0].type).toBe('text/plain;charset=utf-8')
      // Blob do jsdom sem .text(): lê pelo FileReader.
      const text = await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(created[0]) })
      expect(text).toContain('Caderno de Ana Souza')
      expect(text).toContain('=== Fundamentos · Redes <locais> ===')
      expect(text).toContain('Linha 1\r\nLinha 2')
      expect(text).toContain('- "A rede liga <b>computadores</b>"\r\n  cai na prova')
    } finally {
      click.mockRestore()
      URL.createObjectURL = originalCreate
      URL.revokeObjectURL = originalRevoke
    }
  })

  it('notebookText e notebookSections: BOM, CRLF, vazio e anotações de antes', () => {
    const when = new Date('2026-11-23T15:05:00Z')
    const text = notebookText({ notebook: NOTEBOOK, studentName: 'Ana', courseName: 'Redes', studentClass: '1DES', when, timeZone: 'America/Sao_Paulo' })
    expect(text.startsWith('﻿Caderno de Ana\r\nRedes · Turma 1DES\r\nBaixado em 23/11/2026 às 12:05\r\n')).toBe(true)
    expect(text).toContain('=== Anotações gerais ===\r\nEstudar para a prova')
    expect(text).toContain('Destaques:\r\n- "Cabo par trançado"')
    expect(text).not.toMatch(/[^\r]\n/)
    expect(notebookText({ notebook: { geral: '', unidades: [] }, when })).toContain('O caderno ainda está vazio.')
    const legacy = notebookSections({ geral: '', unidades: [], anteriores: { nota: 'texto antigo', destaques: [] } })
    expect(legacy).toEqual([{ titulo: 'Anotações anteriores', nota: 'texto antigo', destaques: [] }])
    expect(notebookFileName('Técnico em Informática!', new Date(2026, 10, 3))).toBe('caderno-tecnico-em-informatica-2026-11-03.txt')
    expect(notebookFileName('', new Date(2026, 0, 9))).toBe('caderno-2026-01-09.txt')
    const empty = notebookPrintOptions({ notebook: null })
    expect(empty.secoes).toEqual([{ texto: 'O caderno ainda está vazio.' }])
  })
})
