import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ModulosPage from './ModulosPage'

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))

vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }))
vi.mock('./useStudent', () => ({ useStudent: () => ({ email: 'ana@x.local', name: 'Ana', studentClass: '1DES', courseId: 'DES' }) }))
vi.mock('../../hooks/useApi', () => ({
  useApi: () => ({ data: { releasedItems: { Apostila_DES_1: true }, completedUnits: {} }, loading: false, error: null, refetch: vi.fn() }),
}))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))

const courseData = {
  Apostila_DES_1: '# Unidade 1\n\nTexto da apostila.',
  courses: [{ id: 'DES', structure: [{ id: 'M1', name: 'Módulo 1', units: [{ id: '1', name: 'Introdução', apostilaKey: 'Apostila_DES_1' }] }] }],
}

beforeEach(() => {
  mocks.get.mockImplementation(async (url) => {
    if (url.startsWith('/api/data.js')) return `const courseData = ${JSON.stringify(courseData)};`
    if (url.startsWith('/api/student/annotations')) return { annotations: {} }
    if (url.startsWith('/api/forum')) return { comments: [] }
    return {}
  })
  mocks.post.mockResolvedValue({})
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Módulos do aluno · sessão nas chamadas da apostila', () => {
  it('[UC-SIGILO-001] anotações e comentários da unidade vão com a sessão do aluno (sem auth: false, que dava 401)', async () => {
    render(<MemoryRouter><ModulosPage /></MemoryRouter>)
    fireEvent.click(await screen.findByTitle('Introdução'))
    await waitFor(() => {
      expect(mocks.get.mock.calls.some(([url]) => url.startsWith('/api/student/annotations'))).toBe(true)
      expect(mocks.get.mock.calls.some(([url]) => url.startsWith('/api/forum'))).toBe(true)
    })
    const unitCalls = mocks.get.mock.calls.filter(([url]) => url.startsWith('/api/student/annotations') || url.startsWith('/api/forum'))
    unitCalls.forEach(([url, options]) => {
      expect(options?.auth, url).not.toBe(false)
    })
  })
})
