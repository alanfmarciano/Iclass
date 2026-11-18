import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
vi.mock('../../hooks/useAdminWorkspace', () => ({ useAdminWorkspace: () => ({ courseId: 'DES', courseName: 'Técnico em TI', className: '1DES' }) }))

import BibliotecaPage from './BibliotecaPage'

const LIBRARY = [
  { id: 'lib_1', courseId: 'DES', kind: 'file', type: 'pdf', name: 'Lógica de programação', tags: ['Algoritmos'], url: '/uploads/l.pdf' },
  { id: 'lib_2', courseId: 'DES', kind: 'file', type: 'pdf', name: 'Cabeamento estruturado', tags: ['Redes', 'Infraestrutura'], url: '/uploads/c.pdf' },
  { id: 'lib_3', courseId: 'DES', kind: 'link', type: 'video', name: 'Introdução à Computação', tags: [], url: 'https://video.local/1' },
]

beforeEach(() => {
  window.scrollTo = vi.fn()
  Object.values(mocks.toast).forEach((fn) => fn.mockReset())
  mocks.get.mockReset()
  mocks.post.mockReset()
  mocks.get.mockImplementation(async (url) => {
    if (url.startsWith('/api/admin/library')) return LIBRARY
    if (url === '/api/admin/course-summaries') return [{ id: 'DES', classes: [{ name: '1DES' }, { name: '2DES' }] }]
    return { structure: [] }
  })
})
afterEach(cleanup)

const cards = () => screen.queryAllByRole('button', { name: 'Editar' }).map((button) => button.closest('.p-4').querySelector('p.font-medium').textContent)

// Fase 3, C0a (CRIT-07): a busca da Biblioteca não tirava o acento ("logica" não achava
// "Lógica"); e as confirmações eram caixas do navegador (window.confirm).
describe('[UC-BUSCA-001] Biblioteca do professor: busca sem acento no nome e nas etiquetas', () => {
  it('"logica" acha "Lógica", "introducao computacao" acha por palavras e a etiqueta conta', async () => {
    render(<BibliotecaPage />)
    await screen.findByText('Lógica de programação')
    const search = screen.getByRole('textbox', { name: 'Buscar na biblioteca' })
    fireEvent.change(search, { target: { value: 'logica' } })
    expect(cards()).toEqual(['Lógica de programação'])
    fireEvent.change(search, { target: { value: 'introducao   computacao' } })
    expect(cards()).toEqual(['Introdução à Computação'])
    fireEvent.change(search, { target: { value: 'REDES' } })
    expect(cards()).toEqual(['Cabeamento estruturado'])
    fireEvent.change(search, { target: { value: '' } })
    expect(cards()).toHaveLength(3)
  })
})

describe('[UC-CONFIRMACAO-001] Biblioteca do professor: confirmações no diálogo da tela', () => {
  it('excluir em todas as turmas pede confirmação no ConfirmDialog e o material usado em apostila pede outra', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm')
    mocks.post.mockImplementation(async (url, body) => {
      if (url === '/api/admin/library/delete' && !body.force) {
        const error = new Error('Material usado em apostilas.')
        error.status = 409
        error.data = { usedIn: ['Apostila 1', 'Apostila 3'] }
        throw error
      }
      return { success: true }
    })
    render(<BibliotecaPage />)
    await screen.findByText('Lógica de programação')
    fireEvent.change(screen.getByLabelText('Aplicar alterações em'), { target: { value: 'course' } })
    const card = screen.getByText('Lógica de programação').closest('.p-4')
    fireEvent.click(within(card).getByRole('button', { name: 'Excluir' }))

    const first = screen.getByRole('dialog', { name: 'Excluir em todas as turmas?' })
    expect(first).toHaveTextContent('A exclusão será aplicada em: 1DES, 2DES.')
    expect(mocks.post).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(within(first).getByRole('button', { name: 'Excluir' })) })
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/library/delete', { id: 'lib_1', courseId: 'DES', studentClass: '1DES', scope: 'course' })

    const second = screen.getByRole('dialog', { name: 'Excluir material usado em apostilas?' })
    expect(second).toHaveTextContent('Usado em 2 apostila(s): Apostila 1, Apostila 3.')
    await act(async () => { fireEvent.click(within(second).getByRole('button', { name: 'Excluir mesmo assim' })) })
    expect(mocks.post).toHaveBeenLastCalledWith('/api/admin/library/delete', { id: 'lib_1', force: true, courseId: 'DES', studentClass: '1DES', scope: 'course' })
    expect(mocks.toast.success).toHaveBeenCalledWith('Removido')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(confirmSpy).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('Cancelar não exclui; só nesta turma exclui sem perguntar', async () => {
    mocks.post.mockResolvedValue({ success: true })
    render(<BibliotecaPage />)
    await screen.findByText('Lógica de programação')
    fireEvent.change(screen.getByLabelText('Aplicar alterações em'), { target: { value: 'course' } })
    fireEvent.click(within(screen.getByText('Cabeamento estruturado').closest('.p-4')).getByRole('button', { name: 'Excluir' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(mocks.post).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Aplicar alterações em'), { target: { value: 'class' } })
    await act(async () => { fireEvent.click(within(screen.getByText('Cabeamento estruturado').closest('.p-4')).getByRole('button', { name: 'Excluir' })) })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/library/delete', { id: 'lib_2', courseId: 'DES', studentClass: '1DES', scope: 'class' })
  })

  it('salvar a edição em todas as turmas confirma antes de mandar', async () => {
    mocks.post.mockResolvedValue({ success: true })
    render(<BibliotecaPage />)
    await screen.findByText('Lógica de programação')
    fireEvent.click(within(screen.getByText('Lógica de programação').closest('.p-4')).getByRole('button', { name: 'Editar' }))
    fireEvent.change(screen.getByLabelText('Aplicar alterações em'), { target: { value: 'course' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }))
    const dialog = screen.getByRole('dialog', { name: 'Aplicar em todas as turmas do curso?' })
    expect(dialog).toHaveTextContent('Esta alteração substituirá este recurso em: 1DES, 2DES.')
    expect(mocks.post).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Continuar' })) })
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/library/update', expect.objectContaining({ id: 'lib_1', scope: 'course', courseId: 'DES', studentClass: '1DES' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
