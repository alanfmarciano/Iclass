import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 2, H2-C (DES-09): a resposta que chega depois de trocar de curso ou turma não
// vale mais (antes, a consulta lenta do curso anterior voltava por cima da lista nova).
const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
const workspace = vi.hoisted(() => ({ current: { courseId: 'curso-a', courseName: 'Curso A', className: 'A' } }))
vi.mock('../../lib/api', () => ({ api: apiMock }))
const authMock = vi.hoisted(() => ({ current: { email: 'admin@escola.local', accountRole: 'admin' } }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: authMock.current }) }))
vi.mock('../../hooks/useAdminWorkspace', () => ({ useAdminWorkspace: () => workspace.current }))
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }))
const prefsMock = vi.hoisted(() => ({ current: {}, setPref: null }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => toastMock }))
vi.mock('../../context/PreferencesProvider', () => ({ usePreferences: () => ({ pref: (key, fallback) => (prefsMock.current[key] !== undefined ? prefsMock.current[key] : fallback), setPref: (...args) => prefsMock.setPref(...args) }) }))

import ForumPage from './ForumPage'

const comment = (id, text) => ({ id, key: 'apostila_1', text, studentName: 'Ana', timestamp: '2026-11-10T10:00:00.000Z', replies: [] })

beforeEach(() => {
  prefsMock.current = {}
  prefsMock.setPref = vi.fn().mockResolvedValue(true)
  Object.values(toastMock).forEach((fn) => fn.mockReset())
  apiMock.get.mockReset()
  apiMock.post.mockReset()
  workspace.current = { courseId: 'curso-a', courseName: 'Curso A', className: 'A' }
  apiMock.get.mockResolvedValue({ structure: [{ units: [{ apostilaKey: 'apostila_1' }] }] })
})

afterEach(() => {
  cleanup()
  authMock.current = { email: 'admin@escola.local', accountRole: 'admin' }
})

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

  // Fase 3 (C0a): a edição é um diálogo da tela, não o prompt do navegador. O campo tem o
  // teto do servidor, e texto antigo maior que o teto (que o campo mostra inteiro) não é
  // enviado: o motivo aparece na tela.
  it('a edição acima de 5.000 caracteres não é enviada e mostra o motivo (diálogo, sem prompt)', async () => {
    renderWith([{ ...comment('c1', 'Dúvida da Ana'), replies: [{ id: 'r1', authorRole: 'Instrutor', authorName: 'Prof', text: 'Resposta', timestamp: '2026-11-10T10:00:00.000Z' }] }])
    const promptSpy = vi.spyOn(window, 'prompt')
    const replyRow = (await screen.findByText('Resposta')).parentElement.parentElement
    const editReply = within(replyRow).getByRole('button', { name: 'Editar' })
    fireEvent.click(editReply)
    const dialog = await screen.findByRole('dialog', { name: 'Editar resposta' })
    const field = within(dialog).getByLabelText('Texto da mensagem')
    expect(field.value).toBe('Resposta')
    expect(field).toHaveAttribute('maxLength', '5000')
    fireEvent.change(field, { target: { value: 'e'.repeat(5001) } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    expect(toastMock.error).toHaveBeenCalledWith('O texto aceita no máximo 5.000 caracteres (este tem 5.001).')
    expect(apiMock.post).not.toHaveBeenCalledWith('/api/forum/reply/edit', expect.anything())
    fireEvent.change(field, { target: { value: 'e'.repeat(5000) } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await act(async () => {})
    expect(apiMock.post).toHaveBeenCalledWith('/api/forum/reply/edit', expect.objectContaining({ commentId: 'c1', replyId: 'r1', text: 'e'.repeat(5000) }))
    expect(screen.queryByRole('dialog', { name: 'Editar resposta' })).not.toBeInTheDocument()
    expect(promptSpy).not.toHaveBeenCalled()
    promptSpy.mockRestore()
  })

  it('Cancelar fecha a edição sem enviar nada', async () => {
    renderWith([comment('c1', 'Dúvida da Ana')])
    fireEvent.click(await screen.findByRole('button', { name: 'Editar' }))
    const dialog = await screen.findByRole('dialog', { name: 'Editar dúvida' })
    fireEvent.change(within(dialog).getByLabelText('Texto da mensagem'), { target: { value: 'Outro texto' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog', { name: 'Editar dúvida' })).not.toBeInTheDocument()
    expect(apiMock.post).not.toHaveBeenCalledWith('/api/forum/comment/edit', expect.anything())
  })
})

// Decisões §12 (sobra do H9b): o modelo de resposta recusado pelo servidor (limite de
// 64 KB das preferências, sessão vencida...) não apaga o que o professor digitou.
describe('[UC-ERRO-003] Fórum do instrutor: modelo de resposta recusado não limpa o formulário', () => {
  async function openTemplates() {
    apiMock.post.mockImplementation((url) => (url === '/api/admin/forum/all' ? Promise.resolve({ comments: [] }) : Promise.resolve({ success: true })))
    render(<MemoryRouter><ForumPage /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'Respostas rápidas' }))
    fireEvent.change(screen.getByLabelText('Título'), { target: { value: 'Prazo' } })
    fireEvent.change(screen.getByLabelText('Texto'), { target: { value: 'A prova fecha às 22 h.' } })
  }

  it('recusado: título e texto ficam no formulário', async () => {
    prefsMock.setPref = vi.fn().mockResolvedValue(false)
    await openTemplates()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Adicionar modelo' })) })
    expect(prefsMock.setPref).toHaveBeenCalledWith('forum.templates', [expect.objectContaining({ title: 'Prazo', text: 'A prova fecha às 22 h.' })])
    expect(screen.getByLabelText('Título')).toHaveValue('Prazo')
    expect(screen.getByLabelText('Texto')).toHaveValue('A prova fecha às 22 h.')
  })

  it('gravado: o formulário se limpa depois do sucesso', async () => {
    let release
    prefsMock.setPref = vi.fn(() => new Promise((resolve) => { release = resolve }))
    await openTemplates()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Adicionar modelo' })) })
    expect(screen.getByLabelText('Título')).toHaveValue('Prazo')
    await act(async () => { release(true) })
    expect(screen.getByLabelText('Título')).toHaveValue('')
    expect(screen.getByLabelText('Texto')).toHaveValue('')
  })
})

// Fase 3, C0a: textos da lixeira do Fórum com acento, e o diálogo de excluir não diz mais
// que "não pode ser desfeita" (a mensagem vai para Excluídas e pode ser restaurada).
describe('[UC-CONFIRMACAO-001] Fórum do instrutor: lixeira e diálogo de excluir', () => {
  it('mostra "Excluídas" e o diálogo de excluir diz que dá para restaurar', async () => {
    const comments = [
      comment('c1', 'Dúvida ativa'),
      { ...comment('c2', 'Dúvida apagada'), deleted: true, deletedAt: '2026-11-11T10:00:00.000Z' },
    ]
    apiMock.post.mockImplementation((url) => (url === '/api/admin/forum/all' ? Promise.resolve({ comments }) : Promise.resolve({ success: true })))
    render(<MemoryRouter><ForumPage /></MemoryRouter>)
    expect(await screen.findByText('Dúvida ativa')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Excluídas/ })).toBeInTheDocument()
    expect(screen.queryByText(/Excluidas/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }))
    const dialog = screen.getByRole('dialog', { name: 'Excluir mensagem?' })
    expect(dialog).toHaveTextContent('A mensagem vai para Excluídas e pode ser restaurada.')
    expect(dialog).not.toHaveTextContent('não pode ser desfeita')
  })
})

// Fase 3, B4: a Coordenação (só consulta) lê as dúvidas sem moderar. Antes, abrir o Fórum
// pedia a estrutura do curso (page.editor, 403) e os botões de responder, resolver, FAQ,
// editar, excluir e restaurar davam 403 ao clicar.
describe('[UC-PAPEIS-004] Fórum da Coordenação (só consulta)', () => {
  it('lê dúvidas e respostas sem pedir a estrutura e sem botões de moderar', async () => {
    authMock.current = {
      email: 'coord@escola.local', role: 'admin', accountRole: 'coordenacao', readOnly: true,
      effectivePermissions: ['page.dashboard', 'page.results', 'page.classes', 'page.students', 'page.forum', 'page.assignments', 'reports.view'],
    }
    const comments = [
      { ...comment('c1', 'Dúvida da Ana'), replies: [{ id: 'r1', authorRole: 'Instrutor', authorName: 'Prof', text: 'Resposta do professor', timestamp: '2026-11-10T10:00:00.000Z' }] },
      { ...comment('c2', 'Dúvida apagada'), deleted: true, deletedAt: '2026-11-11T10:00:00.000Z' },
    ]
    apiMock.post.mockImplementation((url) => (url === '/api/admin/forum/all' ? Promise.resolve({ comments }) : Promise.resolve({ success: true })))
    render(<MemoryRouter><ForumPage /></MemoryRouter>)
    expect(await screen.findByText('Dúvida da Ana')).toBeInTheDocument()
    expect(screen.getByText('Resposta do professor')).toBeInTheDocument()
    expect(screen.getByText(/Dúvidas dos alunos \(só consulta\)/)).toBeInTheDocument()
    expect(apiMock.get).not.toHaveBeenCalledWith(expect.stringContaining('/structure'))
    for (const name of ['Respostas rápidas', 'FAQ', 'Editar', 'Excluir', 'Excluir resposta', 'Resolver', 'Reabrir', 'Enviar']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    }
    expect(document.getElementById('reply-c1')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Excluídas/ }))
    expect(await screen.findByText('Dúvida apagada')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Restaurar' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apagar de vez' })).not.toBeInTheDocument()
    expect(apiMock.post.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining(['/api/admin/forum/all']))
    expect(apiMock.post.mock.calls.every(([url]) => url === '/api/admin/forum/all')).toBe(true)
  })

  it('o administrador continua pedindo a estrutura e vendo responder e resolver', async () => {
    apiMock.post.mockImplementation((url) => (url === '/api/admin/forum/all' ? Promise.resolve({ comments: [comment('c1', 'Dúvida da Ana')] }) : Promise.resolve({ success: true })))
    render(<MemoryRouter><ForumPage /></MemoryRouter>)
    expect(await screen.findByText('Dúvida da Ana')).toBeInTheDocument()
    expect(apiMock.get).toHaveBeenCalledWith(expect.stringContaining('/structure'))
    expect(screen.getByRole('button', { name: 'Resolver' })).toBeInTheDocument()
    expect(document.getElementById('reply-c1')).not.toBeNull()
  })
})
