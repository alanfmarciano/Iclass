import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 2, H2-C (DES-09): a resposta que chega depois de trocar de curso ou turma não
// vale mais (antes, a consulta lenta do curso anterior voltava por cima da lista nova).
const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
const workspace = vi.hoisted(() => ({ current: { courseId: 'curso-a', courseName: 'Curso A', className: 'A' } }))
vi.mock('../../lib/api', () => ({ api: apiMock }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: { email: 'admin@escola.local', accountRole: 'admin' } }) }))
vi.mock('../../hooks/useAdminWorkspace', () => ({ useAdminWorkspace: () => workspace.current }))
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }))
const prefsMock = vi.hoisted(() => ({ current: {} }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => toastMock }))
vi.mock('../../context/PreferencesProvider', () => ({ usePreferences: () => ({ pref: (key, fallback) => (prefsMock.current[key] !== undefined ? prefsMock.current[key] : fallback), setPref: vi.fn() }) }))

import ForumPage from './ForumPage'

const comment = (id, text) => ({ id, key: 'apostila_1', text, studentName: 'Ana', timestamp: '2026-11-10T10:00:00.000Z', replies: [] })

beforeEach(() => {
  prefsMock.current = {}
  Object.values(toastMock).forEach((fn) => fn.mockReset())
  apiMock.get.mockReset()
  apiMock.post.mockReset()
  workspace.current = { courseId: 'curso-a', courseName: 'Curso A', className: 'A' }
  apiMock.get.mockResolvedValue({ structure: [{ units: [{ apostilaKey: 'apostila_1' }] }] })
})

afterEach(() => cleanup())

describe('[UC-DESEMPENHO-002] Fórum do instrutor: troca de curso no meio da consulta', () => {
  it('a resposta atrasada do curso anterior não substitui as dúvidas do curso novo', async () => {
    let releaseA
    apiMock.post.mockImplementation((url, body) => {
      if (url !== '/api/admin/forum/all') return Promise.resolve({ success: true })
      if (body.courseId === 'curso-a') return new Promise((resolve) => { releaseA = () => resolve({ comments: [comment('a1', 'Dúvida do curso A')] }) })
      return Promise.resolve({ comments: [comment('b1', 'Dúvida do curso B')] })
    })
    const page = () => <MemoryRouter><ForumPage /></MemoryRouter>
    const view = render(page())
    workspace.current = { courseId: 'curso-b', courseName: 'Curso B', className: 'B' }
    view.rerender(page())
    expect(await screen.findByText('Dúvida do curso B')).toBeInTheDocument()
    await act(async () => { releaseA() })
    await act(async () => {})
    expect(screen.queryByText('Dúvida do curso A')).not.toBeInTheDocument()
    expect(screen.getByText('Dúvida do curso B')).toBeInTheDocument()
  })
})

// Fase 2, H9b (ENG-03): a resposta do fórum tem o teto de 5.000 caracteres do servidor.
// O campo já não deixava digitar mais, mas o modelo de resposta somado ao texto e o prompt
// de edição (sem limite) passavam do teto e o servidor recusava a resposta inteira.
describe('[UC-ERRO-003] Fórum do instrutor: modelo de resposta e edição respeitam os 5.000 caracteres', () => {
  function renderWith(comments) {
    apiMock.post.mockImplementation((url) => (url === '/api/admin/forum/all' ? Promise.resolve({ comments }) : Promise.resolve({ success: true })))
    return render(<MemoryRouter><ForumPage /></MemoryRouter>)
  }

  it('o modelo que passaria do teto entra cortado e o professor é avisado', async () => {
    prefsMock.current = { 'forum.templates': [{ id: 'tpl_1', title: 'Modelo longo', text: 'm'.repeat(3000) }] }
    renderWith([comment('c1', 'Dúvida da Ana')])
    const button = await screen.findByRole('button', { name: 'Modelo longo' })
    fireEvent.click(button)
    const field = document.getElementById('reply-c1')
    expect(field.value).toHaveLength(3000)
    expect(toastMock.warning).not.toHaveBeenCalled()
    fireEvent.click(button)
    expect(field.value).toHaveLength(5000)
    expect(toastMock.warning).toHaveBeenCalledWith('O modelo foi cortado para a resposta caber em 5.000 caracteres.')
  })

  it('a edição pelo prompt acima de 5.000 caracteres não é enviada e mostra o motivo', async () => {
    renderWith([{ ...comment('c1', 'Dúvida da Ana'), replies: [{ id: 'r1', authorRole: 'Instrutor', authorName: 'Prof', text: 'Resposta', timestamp: '2026-11-10T10:00:00.000Z' }] }])
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('e'.repeat(5001))
    const replyRow = (await screen.findByText('Resposta')).parentElement.parentElement
    const editReply = within(replyRow).getByRole('button', { name: 'Editar' })
    fireEvent.click(editReply)
    expect(toastMock.error).toHaveBeenCalledWith('O texto aceita no máximo 5.000 caracteres (este tem 5.001).')
    expect(apiMock.post).not.toHaveBeenCalledWith('/api/forum/reply/edit', expect.anything())
    promptSpy.mockReturnValue('e'.repeat(5000))
    fireEvent.click(editReply)
    await act(async () => {})
    expect(apiMock.post).toHaveBeenCalledWith('/api/forum/reply/edit', expect.objectContaining({ commentId: 'c1', replyId: 'r1', text: 'e'.repeat(5000) }))
    promptSpy.mockRestore()
  })
})
