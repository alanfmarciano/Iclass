import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 2, H8a-2 (decisão P4: "a rota da prova nunca passa por essa tela"). O aluno em duas
// turmas entra com activeClass null (a turma é escolhida no StudentCourseGate, por dentro
// do StudentPrivacyGate). Antes, a faixa "Prova disponível" só consultava com a turma
// escolhida: com o primeiro acesso pendente, o aluno não tinha como chegar à prova, nem
// para voltar a uma em andamento depois de entrar de novo.
const state = vi.hoisted(() => ({
  auth: {}, setActiveClass: vi.fn(), logout: vi.fn(), apiGet: vi.fn(), apiPost: vi.fn(),
}))
vi.mock('../../lib/api', () => ({ api: { get: state.apiGet, post: state.apiPost } }))
vi.mock('../../context/AuthProvider', () => ({
  useAuth: () => ({ auth: state.auth, setActiveClass: state.setActiveClass, logout: state.logout }),
}))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => ({ success: vi.fn() }) }))

import { StudentExamAvailability } from './StudentExamAvailability'
import { StudentPrivacyGate, resetPrivacyGateCache } from './StudentPrivacyGate'

const CLASSES = [{ name: '1DES', courseId: 'curso_des' }, { name: '1RED', courseId: 'curso_redes' }]
const PENDING = {
  success: true, required: true, termsPending: true, privacyPending: false, birthDateMissing: true,
  guardianMissing: false, isMinor: false, guardianInformed: false,
  documents: { terms: { documentId: 'termos_v1', version: 1, title: 'Termos de Uso', publishedAt: '2026-11-11T10:00:00.000Z', markdown: 'Texto.' } },
}
const RUNNING = {
  id: 'app_a3ff1c98', examKey: 'Avaliacao_FUTEC_5', examTitle: 'FUTEC 5', status: 'running',
  studentClass: '1DES', courseId: 'curso_des', attemptsExhausted: false,
}

function routeGet(applications) {
  state.apiGet.mockImplementation(async (path) => {
    if (String(path).startsWith('/api/student/privacy/status')) return PENDING
    if (String(path).startsWith('/api/student/exam-applications')) return { success: true, applications }
    throw new Error(`rota inesperada ${path}`)
  })
}

const calledPaths = () => state.apiGet.mock.calls.map(([path]) => String(path))

function renderPortal() {
  return render(
    <MemoryRouter initialEntries={['/aluno']}>
      <Routes>
        <Route path="/aluno" element={<><StudentPrivacyGate><p>Início do aluno</p></StudentPrivacyGate><StudentExamAvailability /></>} />
        <Route path="/aluno/prova/:examKey" element={<p>Tela da prova</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  resetPrivacyGateCache()
  state.apiGet.mockReset()
  state.apiPost.mockReset()
  state.setActiveClass.mockReset()
  state.auth = { role: 'student', email: 'bruno@escola.local', activeClass: null, student: { email: 'bruno@escola.local', classes: CLASSES } }
})
afterEach(() => { cleanup() })

describe('[UC-LGPD-007] faixa da prova com o primeiro acesso pendente', () => {
  it('aluno em duas turmas, sem turma escolhida: a faixa aparece por cima do portão e abre a prova na turma dela', async () => {
    const user = userEvent.setup()
    routeGet([RUNNING])
    renderPortal()
    expect(await screen.findByRole('heading', { name: 'Antes de continuar' })).toBeInTheDocument()
    expect(await screen.findByText('PROVA DISPONÍVEL')).toBeInTheDocument()
    // Sem turma escolhida, procura em todas as turmas do aluno (o servidor filtra).
    expect(calledPaths()).toContain('/api/student/exam-applications')
    await user.click(screen.getByRole('button', { name: /abrir prova/i }))
    expect(state.setActiveClass).toHaveBeenCalledWith(CLASSES[0])
    expect(await screen.findByText('Tela da prova')).toBeInTheDocument()
  })

  it('com a turma escolhida, a consulta continua só daquela turma', async () => {
    state.auth = { ...state.auth, activeClass: CLASSES[1] }
    routeGet([])
    renderPortal()
    await waitFor(() => expect(calledPaths()).toContain('/api/student/exam-applications?courseId=curso_redes&studentClass=1RED'))
    expect(calledPaths()).not.toContain('/api/student/exam-applications')
  })

  it('aluno sem nenhuma turma (cadastro aguardando matrícula) não consulta provas', async () => {
    state.auth = { ...state.auth, student: { email: 'bruno@escola.local', classes: [] } }
    routeGet([RUNNING])
    renderPortal()
    expect(await screen.findByRole('heading', { name: 'Antes de continuar' })).toBeInTheDocument()
    expect(calledPaths().some((path) => path.startsWith('/api/student/exam-applications'))).toBe(false)
    expect(screen.queryByText('PROVA DISPONÍVEL')).not.toBeInTheDocument()
  })
})
