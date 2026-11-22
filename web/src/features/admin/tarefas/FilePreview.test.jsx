import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FilePreview, fileUrl } from './FilePreview'

// Prévia dos arquivos da entrega (fase 3, C8 / P1-f; D7 do P1). Antes do C8 não havia
// prévia nenhuma no painel.
const mocks = vi.hoisted(() => ({ fetchBlob: vi.fn(), downloadFile: vi.fn() }))
vi.mock('../../../lib/api', () => ({ fetchBlob: mocks.fetchBlob, downloadFile: mocks.downloadFile }))

const BASE = '/api/admin/assignments/asg_1_aaaaaa'
let created
let originalCreate
let originalRevoke
let originalOpen

beforeEach(() => {
  created = []
  originalCreate = URL.createObjectURL
  originalRevoke = URL.revokeObjectURL
  originalOpen = window.open
  URL.createObjectURL = vi.fn((blob) => {
    created.push(blob)
    return `blob:prevista-${created.length}`
  })
  URL.revokeObjectURL = vi.fn()
  mocks.downloadFile.mockResolvedValue('x')
})

afterEach(() => {
  cleanup()
  URL.createObjectURL = originalCreate
  URL.revokeObjectURL = originalRevoke
  window.open = originalOpen
  vi.clearAllMocks()
})

describe('FilePreview', () => {
  it('imagem: lida com a sessão (?inline=1), mostrada como blob: com o tipo da lista branca e liberada ao sair', async () => {
    // O servidor (ou alguém no meio) mandou SVG: o Blob é refeito como PNG.
    mocks.fetchBlob.mockResolvedValue({ blob: new Blob(['<svg onload="alert(1)"/>'], { type: 'image/svg+xml' }), name: 'foto.png', type: 'image/svg+xml' })
    const file = { id: 'f_1aaaaaaaaaaaa', name: 'foto.png', size: 1536, ext: '.png', preview: 'image', missing: false }
    const { unmount } = render(<FilePreview base={BASE} file={file} />)
    const img = await screen.findByRole('img', { name: 'Prévia de foto.png' })
    expect(img).toHaveAttribute('src', 'blob:prevista-1')
    expect(mocks.fetchBlob).toHaveBeenCalledWith(`${BASE}/files/f_1aaaaaaaaaaaa?inline=1`, expect.objectContaining({ signal: expect.anything() }))
    expect(created[0].type).toBe('image/png')
    expect(screen.getByText('1,5 KB')).toBeInTheDocument()
    unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:prevista-1')
  })

  it('texto: mostrado como texto puro (nada vira HTML)', async () => {
    mocks.fetchBlob.mockResolvedValue({ blob: new Blob(['<b>oi</b>\nlinha 2']), name: 'a.txt', type: 'text/plain' })
    const { container } = render(<FilePreview base={BASE} file={{ id: 'f_2', name: 'notas.txt', size: 20, ext: '.txt', preview: 'text' }} />)
    const pre = await screen.findByLabelText('Conteúdo de notas.txt')
    expect(pre.textContent).toBe('<b>oi</b>\nlinha 2')
    expect(container.querySelector('b')).toBeNull()
    expect(mocks.fetchBlob).toHaveBeenCalledWith(`${BASE}/files/f_2`, expect.anything())
  })

  it('texto grande: a prévia para em 200 KB', async () => {
    mocks.fetchBlob.mockResolvedValue({ blob: new Blob(['a'.repeat(250 * 1024)]), name: 'log.txt', type: 'text/plain' })
    render(<FilePreview base={BASE} file={{ id: 'f_7', name: 'log.txt', size: 250 * 1024, ext: '.txt', preview: 'text' }} />)
    const pre = await screen.findByLabelText('Conteúdo de log.txt')
    expect(pre.textContent).toHaveLength(200 * 1024)
  })

  it('PDF: abre em aba nova (aberta no clique, sem acesso a esta página) com um Blob application/pdf', async () => {
    const user = userEvent.setup()
    const tab = { opener: window, closed: false, location: { href: '' }, close: vi.fn() }
    window.open = vi.fn(() => tab)
    mocks.fetchBlob.mockResolvedValue({ blob: new Blob(['%PDF-1.4'], { type: 'text/html' }), name: 'r.pdf', type: 'text/html' })
    render(<FilePreview base={BASE} file={{ id: 'f_3', name: 'relatório.pdf', size: 2048, ext: '.pdf', preview: 'pdf' }} />)
    // Não carrega sozinho.
    expect(mocks.fetchBlob).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Abrir relatório.pdf em outra aba' }))
    expect(window.open).toHaveBeenCalledWith('', '_blank')
    expect(tab.opener).toBeNull()
    await waitFor(() => expect(tab.location.href).toBe('blob:prevista-1'))
    expect(created[0].type).toBe('application/pdf')
    expect(mocks.fetchBlob).toHaveBeenCalledWith(`${BASE}/files/f_3?inline=1`)
  })

  it('PDF que falha: fecha a aba e avisa sem o endereço interno do aluno', async () => {
    const user = userEvent.setup()
    const tab = { opener: window, closed: false, location: { href: '' }, close: vi.fn() }
    window.open = vi.fn(() => tab)
    mocks.fetchBlob.mockRejectedValue(new Error('Arquivo de aluno-alu_0123456789abcdef@sem-email.invalid não encontrado'))
    render(<FilePreview base={BASE} file={{ id: 'f_3', name: 'r.pdf', size: 10, ext: '.pdf', preview: 'pdf' }} />)
    await user.click(screen.getByRole('button', { name: 'Abrir r.pdf em outra aba' }))
    const alert = await screen.findByRole('alert')
    expect(tab.close).toHaveBeenCalled()
    expect(alert.textContent).not.toContain('sem-email.invalid')
  })

  it('HEIC e outros tipos: sem prévia, só "Baixar" (anexo pelo servidor)', async () => {
    const user = userEvent.setup()
    render(<FilePreview base={BASE} file={{ id: 'f_4', name: 'foto.HEIC', size: 10, ext: '.heic', preview: null }} />)
    expect(screen.getByText(/HEIC \(do iPhone\) não tem prévia/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Abrir/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Baixar foto.HEIC' }))
    expect(mocks.downloadFile).toHaveBeenCalledWith(`${BASE}/files/f_4`, 'foto.HEIC')
    expect(mocks.fetchBlob).not.toHaveBeenCalled()
    cleanup()
    render(<FilePreview base={BASE} file={{ id: 'f_5', name: 'planilha.xlsx', size: 10, ext: '.xlsx', preview: null }} />)
    expect(screen.getByText('Sem prévia para este tipo de arquivo: baixe para abrir.')).toBeInTheDocument()
  })

  it('arquivo que sumiu do computador: o aviso no lugar da prévia e sem "Baixar"', () => {
    render(<FilePreview base={BASE} file={{ id: 'f_6', name: 'foto.png', size: 10, ext: '.png', preview: 'image', missing: true }} />)
    expect(screen.getByRole('status')).toHaveTextContent('não está mais no computador')
    expect(screen.queryByRole('button', { name: /Baixar/ })).not.toBeInTheDocument()
    expect(mocks.fetchBlob).not.toHaveBeenCalled()
  })

  it('endereço do arquivo codifica o id', () => {
    expect(fileUrl(BASE, { id: 'a/b' })).toBe(`${BASE}/files/a%2Fb`)
    expect(fileUrl(BASE, { id: 'f_1' }, { inline: true })).toBe(`${BASE}/files/f_1?inline=1`)
  })
})
