import { lazy } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 2, H2-A (DES-06): as telas do portal do aluno chegam sob demanda, com o
// "Carregando..." dentro do portal, e o arquivo da prova é buscado 2 s depois de o
// portal abrir, uma vez só: quando o professor libera a prova, a turma não baixa o mesmo
// arquivo no mesmo instante.
const loads = vi.hoisted(() => ({ examRunner: 0, examShell: 0 }))
vi.mock('./exam/ExamRunner', () => { loads.examRunner += 1; return { default: () => null } })
vi.mock('./StudentExamShell', () => { loads.examShell += 1; return { StudentExamShell: () => null } })
vi.mock('../../lib/api', () => ({ api: { get: vi.fn().mockResolvedValue({}), post: vi.fn().mockResolvedValue({}) } }))
vi.mock('../../context/BrandingProvider', () => ({ useBranding: () => ({ branding: {}, interfacePreset: 'classic' }) }))
vi.mock('../../context/AuthProvider', () => ({
  useAuth: () => ({
    logout: vi.fn(),
    setActiveClass: vi.fn(),
    auth: {
      role: 'student',
      email: 'ana@escola.local',
      activeClass: { name: '1DES', courseId: 'curso' },
      student: { name: 'Ana', classes: [{ name: '1DES', courseId: 'curso' }], courses: [{ id: 'curso', name: 'Curso' }] },
    },
  }),
}))
vi.mock('./StudentCourseGate', () => ({ StudentCourseGate: ({ children }) => children }))
vi.mock('./StudentExamAvailability', () => ({ StudentExamAvailability: () => null }))
vi.mock('./useStudentHeartbeat', () => ({ useStudentHeartbeat: () => {} }))
vi.mock('../../components/ui/NotificationBell', () => ({ NotificationBell: () => null }))
vi.mock('../../components/ui/ThemeToggle', () => ({ ThemeToggle: () => null }))

import { EXAM_PREFETCH_DELAY_MS, StudentShell } from './StudentShell'

function renderPortal(child = <p>Início do aluno</p>) {
  return render(
    <MemoryRouter initialEntries={['/aluno']}>
      <Routes>
        <Route path="/aluno" element={<StudentShell />}>
          <Route index element={child} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('[UC-DESEMPENHO-001] portal do aluno com telas sob demanda', () => {
  it('enquanto o arquivo da tela chega, mostra "Carregando..." dentro do portal, com o menu à vista', async () => {
    let resolveModule
    const pending = new Promise((resolve) => { resolveModule = resolve })
    const TelaSobDemanda = lazy(() => pending)
    renderPortal(<TelaSobDemanda />)
    expect(screen.getByRole('status')).toHaveTextContent('Carregando...')
    expect(screen.getByRole('link', { name: /Provas/ })).toBeInTheDocument()
    await act(async () => { resolveModule({ default: () => <p>Módulos da turma</p> }) })
    expect(await screen.findByText('Módulos da turma')).toBeInTheDocument()
  })

  it('busca o arquivo da prova 2 s depois de abrir o portal, uma vez só', async () => {
    vi.useFakeTimers()
    const first = renderPortal()
    expect(EXAM_PREFETCH_DELAY_MS).toBe(2000)
    await act(async () => { vi.advanceTimersByTime(EXAM_PREFETCH_DELAY_MS - 100) })
    expect(loads.examRunner).toBe(0)
    await act(async () => { vi.advanceTimersByTime(100) })
    await vi.waitFor(() => {
      expect(loads.examRunner).toBe(1)
      expect(loads.examShell).toBe(1)
    })
    first.unmount()

    // Portal aberto de novo (trocar de turma, voltar da prova): não busca outra vez.
    renderPortal()
    await act(async () => { vi.advanceTimersByTime(EXAM_PREFETCH_DELAY_MS * 2) })
    expect(loads.examRunner).toBe(1)
    expect(loads.examShell).toBe(1)
  })
})
