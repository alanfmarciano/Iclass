import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 3, C15 / P5-S6b (CRIT-08, D20/D21 do P5): na pré-visualização como aluno as telas do
// portal leem tudo e nada grava: os botões que gravam ficam desativados com o texto
// "Desativado na pré-visualização" e o que gravava sozinho (registro de acesso da
// apostila, aviso lido) não sai.
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), preview: null }))
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post }, hasActiveSession: () => true, downloadFile: vi.fn(), uploadWithProgress: vi.fn() }))
vi.mock('../../hooks/usePreview', () => ({ usePreview: () => mocks.preview }))
vi.mock('./useStudent', () => ({ useStudent: () => ({ email: 'previa-ab@previa.invalid', name: 'Pré-visualização', displayName: 'Pré-visualização', studentClass: '1DES', courseId: 'DES', classes: [{ name: '1DES', courseId: 'DES' }], courses: [{ id: 'DES', name: 'Desenvolvimento' }] }) }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }))
vi.mock('../../context/AuthProvider', () => ({
  useAuth: () => ({ auth: { role: 'student', email: 'previa-ab@previa.invalid', preview: mocks.preview, student: { name: 'Pré-visualização', email: 'previa-ab@previa.invalid', classes: [{ name: '1DES', courseId: 'DES' }], courses: [] } } }),
}))

import ModulosPage from './ModulosPage'
import CadernoPage from './CadernoPage'
import AvisosPage from './AvisosPage'
import MeusDadosPage from './MeusDadosPage'
import ContaPage from './ContaPage'
import DuvidasPage from './DuvidasPage'
import ExamRunner from './exam/ExamRunner'

const PREVIEW = { token: 'tok-previa', rotulo: 'Pré-visualização como aluno de 1DES', origem: '/turmas', expiraEm: Date.now() + 3600000 }
const courseData = {
  Apostila_DES_1: '# Unidade 1\n\nTexto da apostila.',
  courses: [{ id: 'DES', structure: [{ id: 'M1', name: 'Módulo 1', units: [{ id: '1', name: 'Introdução', apostilaKey: 'Apostila_DES_1' }] }] }],
}

beforeEach(() => {
  mocks.preview = PREVIEW
  mocks.get.mockImplementation(async (url) => {
    if (url.startsWith('/api/data.js')) return `const courseData = ${JSON.stringify(courseData)};`
    if (url.startsWith('/api/status')) return { releasedItems: { Apostila_DES_1: true } }
    if (url.startsWith('/api/student/progress')) return { completedUnits: {} }
    if (url.startsWith('/api/student/annotations')) return { annotations: {} }
    if (url.startsWith('/api/forum')) return { comments: [] }
    if (url.startsWith('/api/student/announcements')) return [{ id: 'a1', title: 'Prova sexta', body: 'Estudem.', read: false, createdAt: Date.now() }]
    if (url.startsWith('/api/student/my-forum')) return { comments: [], topics: [{ key: 'geral', title: 'Geral' }] }
    if (url.startsWith('/api/student/account')) return { matricula: '' }
    return {}
  })
  mocks.post.mockResolvedValue({ note: '' })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const disabledText = 'Desativado na pré-visualização'

describe('[UC-PREVIA-004] telas do portal na pré-visualização', () => {
  it('Módulos: abre a apostila sem registrar o acesso; concluir, caderno, anotação e fórum desativados', async () => {
    render(<MemoryRouter><ModulosPage /></MemoryRouter>)
    fireEvent.click(await screen.findByTitle('Introdução'))
    expect(await screen.findByText('Texto da apostila.')).toBeInTheDocument()
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/student/notes/get', expect.anything()))
    expect(mocks.post.mock.calls.some(([url]) => url === '/api/student/track-access')).toBe(false)
    expect(screen.getByRole('button', { name: /Concluir unidade/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Marcar tópico como concluído/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Salvar/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Postar/ })).toBeDisabled()
    expect(screen.getAllByText(disabledText).length).toBeGreaterThan(0)
  })

  it('Módulos fora da prévia continua registrando o acesso e com os botões ativos', async () => {
    mocks.preview = null
    render(<MemoryRouter><ModulosPage /></MemoryRouter>)
    fireEvent.click(await screen.findByTitle('Introdução'))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/student/track-access', expect.anything()))
    expect(screen.getByRole('button', { name: /Concluir unidade/ })).not.toBeDisabled()
    expect(screen.queryByText(disabledText)).not.toBeInTheDocument()
  })

  it('Caderno: lê e não salva', async () => {
    render(<MemoryRouter><CadernoPage /></MemoryRouter>)
    expect(screen.getByRole('button', { name: /Salvar/ })).toBeDisabled()
    expect(screen.getByText(disabledText)).toBeInTheDocument()
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/student/notes/get', expect.anything()))
    expect(mocks.post.mock.calls.some(([url]) => url === '/api/student/notes/save')).toBe(false)
  })

  it('Avisos: abrir o aviso não o marca como lido', async () => {
    render(<MemoryRouter><AvisosPage /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: /Prova sexta/ }))
    await act(async () => {})
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('Dúvidas, Minha conta e Meus dados: enviar, alterar a senha e baixar a cópia desativados', async () => {
    const duvidas = render(<MemoryRouter><DuvidasPage /></MemoryRouter>)
    expect(await screen.findByRole('button', { name: /Enviar/ })).toBeDisabled()
    duvidas.unmount()
    const conta = render(<MemoryRouter><ContaPage /></MemoryRouter>)
    expect(screen.getByRole('button', { name: /Alterar senha/ })).toBeDisabled()
    // O endereço interno do aluno virtual nunca aparece.
    expect(screen.queryByText(/previa\.invalid/)).not.toBeInTheDocument()
    conta.unmount()
    render(<MemoryRouter><MeusDadosPage /></MemoryRouter>)
    expect(screen.getByRole('button', { name: /Baixar meus dados/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Ver para imprimir/ })).toBeDisabled()
    expect(mocks.get.mock.calls.some(([url]) => url.startsWith('/api/student/my-data'))).toBe(false)
  })

  it('a tela da prova, se montada na prévia, só mostra o aviso e não pede nada', async () => {
    render(<MemoryRouter><ExamRunner /></MemoryRouter>)
    expect(screen.getByText('Na pré-visualização a prova não começa. Para ver as questões, use Provas > Visualizar.')).toBeInTheDocument()
    await act(async () => {})
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.post).not.toHaveBeenCalled()
  })
})
