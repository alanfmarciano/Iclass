import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 2, H2-C (DES-09): a resposta que chega depois de trocar de curso ou turma não
// vale mais (antes, a consulta lenta do curso anterior voltava por cima da lista nova).
const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
const workspace = vi.hoisted(() => ({ current: { courseId: 'curso-a', courseName: 'Curso A', className: 'A' } }))
vi.mock('../../lib/api', () => ({ api: apiMock }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: { email: 'admin@escola.local', accountRole: 'admin' } }) }))
vi.mock('../../hooks/useAdminWorkspace', () => ({ useAdminWorkspace: () => workspace.current }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }))
vi.mock('../../context/PreferencesProvider', () => ({ usePreferences: () => ({ pref: (key, fallback) => fallback, setPref: vi.fn() }) }))

import ForumPage from './ForumPage'

const comment = (id, text) => ({ id, key: 'apostila_1', text, studentName: 'Ana', timestamp: '2026-11-10T10:00:00.000Z', replies: [] })

beforeEach(() => {
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
