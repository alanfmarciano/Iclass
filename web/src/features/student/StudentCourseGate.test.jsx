import { useState } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 2, H2-C (DES-09): a espera da matrícula consulta pelo usePolling. Quando a espera
// começa (a lista de turmas mudou e não há turma liberada), sai uma consulta só.
const apiGet = vi.hoisted(() => vi.fn())
const authBox = vi.hoisted(() => ({ current: null }))
vi.mock('../../lib/api', () => ({ api: { get: apiGet, post: vi.fn().mockResolvedValue({}) } }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => authBox.current }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }))

import { StudentCourseGate } from './StudentCourseGate'

const PENDING = { id: 'req-1', status: 'pending', courseId: 'curso', courseName: 'Curso', requestedClassName: '1DES', createdAt: 1_700_000_000_000 }
const enrolled = { email: 'ana@escola.local', activeClass: { name: '1DES', courseId: 'curso' }, student: { classes: [{ name: '1DES', courseId: 'curso' }], courses: [], enrollmentRequests: [] } }
const waiting = { email: 'ana@escola.local', activeClass: null, student: { classes: [], courses: [], enrollmentRequests: [PENDING] } }

let switchAuth
function Portal({ initial }) {
  const [auth, setAuth] = useState(initial)
  switchAuth = setAuth
  authBox.current = { auth, setAuth, setActiveClass: vi.fn() }
  return <StudentCourseGate><p>Conteúdo do curso</p></StudentCourseGate>
}

function enrollmentCalls() {
  return apiGet.mock.calls.filter(([url]) => url === '/api/student/enrollments')
}

beforeEach(() => {
  apiGet.mockReset()
  apiGet.mockResolvedValue({ classes: [], courses: [], requests: [PENDING] })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('[UC-DESEMPENHO-002] StudentCourseGate: espera da matrícula pelo usePolling', () => {
  it('ao abrir esperando a aprovação, consulta uma vez e depois a cada 5 s', async () => {
    vi.useFakeTimers()
    render(<Portal initial={waiting} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(enrollmentCalls()).toHaveLength(1)
    expect(enrollmentCalls()[0][1]).toEqual({ background: true, timeoutMs: 10000 })
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(enrollmentCalls()).toHaveLength(2)
  })

  it('quando a espera começa (a turma deixou de valer), sai uma consulta só, não duas iguais', async () => {
    render(<Portal initial={enrolled} />)
    expect(screen.getByText('Conteúdo do curso')).toBeInTheDocument()
    expect(enrollmentCalls()).toHaveLength(0)
    await act(async () => { switchAuth(waiting) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
    // Antes, o início da consulta periódica e a troca da lista pediam cada um a sua.
    expect(enrollmentCalls()).toHaveLength(1)
    expect(await screen.findByText('Aguardando aprovação')).toBeInTheDocument()
  })
})
