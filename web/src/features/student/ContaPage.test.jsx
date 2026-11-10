import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Fase 2, H5b ajuste 2 (SEG-16): a matrícula não fica guardada no navegador com a sessão;
// Minha conta a lê do servidor na hora (GET /api/student/account).
const mocks = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: vi.fn() } }))
vi.mock('../../hooks/usePolling', () => ({ usePolling: () => ({ runNow: () => {} }) }))
vi.mock('../../context/AuthProvider', () => ({
  useAuth: () => ({ auth: { role: 'student', email: 'ana@escola.local', student: { email: 'ana@escola.local', name: 'Ana Souza', classes: [{ name: '1DES', courseId: 'DES' }], courses: [{ id: 'DES', name: 'Desenvolvimento' }] } } }),
}))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))

import ContaPage from './ContaPage'

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('[UC-AUTH-003] Minha conta', () => {
  it('mostra a matrícula que vem do servidor, sem depender do perfil guardado', async () => {
    mocks.get.mockResolvedValue({ success: true, matricula: '2026-07' })
    render(<MemoryRouter><ContaPage /></MemoryRouter>)
    expect(await screen.findByText('2026-07')).toBeInTheDocument()
    expect(mocks.get).toHaveBeenCalledWith('/api/student/account', undefined)
    expect(screen.getByText('Ana Souza')).toBeInTheDocument()
    expect(screen.getByText('1DES (Desenvolvimento)')).toBeInTheDocument()
  })

  it('sem matrícula (ou com o servidor fora), a linha não aparece e a página abre assim mesmo', async () => {
    mocks.get.mockRejectedValue(Object.assign(new Error('Sem conexão'), { status: 0, network: true }))
    render(<MemoryRouter><ContaPage /></MemoryRouter>)
    await waitFor(() => expect(mocks.get).toHaveBeenCalled())
    expect(screen.queryByText('Matrícula')).toBeNull()
    expect(screen.getByText('Ana Souza')).toBeInTheDocument()
  })
})
