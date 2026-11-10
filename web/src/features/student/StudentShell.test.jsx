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
const apiPost = vi.hoisted(() => vi.fn())
vi.mock('../../lib/api', () => ({ api: { get: vi.fn().mockResolvedValue({}), post: apiPost }, hasActiveSession: () => true }))
const branding = vi.hoisted(() => ({ interfacePreset: 'classic' }))
vi.mock('../../context/BrandingProvider', () => ({ useBranding: () => ({ branding: {}, interfacePreset: branding.interfacePreset }) }))
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
import { resetClientErrorReportsForTests } from '../../lib/clientErrors'

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
  apiPost.mockReset()
  apiPost.mockResolvedValue({})
  branding.interfacePreset = 'classic'
  resetClientErrorReportsForTests()
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

// Fase 2, H9c (ENG-05): um erro de renderização numa página do aluno troca só a página
// pela tela de erro, com o menu do portal à vista, e o aviso vai ao servidor
// (POST /api/client-error) uma vez. Antes, o portal inteiro virava a tela de erro.
function TelaQuebrada() {
  throw new Error("Cannot read properties of undefined (reading 'titulo'); veja http://192.168.0.10:3000/aluno")
}

describe('[UC-ERRO-002] portal do aluno · erro de tela dentro do layout', () => {
  for (const preset of ['classic', 'lumen']) {
    it(`no visual ${preset}, mostra a tela de erro só na página, com o menu à vista, e avisa o servidor uma vez`, async () => {
      branding.interfacePreset = preset
      // O App usa o BrowserRouter: o caminho do aviso é o da barra de endereço.
      window.history.replaceState(null, '', '/aluno')
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        renderPortal(<TelaQuebrada />)
        expect(screen.getByRole('heading', { name: 'Algo deu errado nesta tela' })).toBeVisible()
        expect(screen.getByText('Recarregue a página ou escolha outra opção no menu.')).toBeVisible()
        expect(screen.getAllByRole('link', { name: /Provas/ }).length).toBeGreaterThan(0)
        const reports = apiPost.mock.calls.filter(([path]) => path === '/api/client-error')
        expect(reports).toHaveLength(1)
        expect(reports[0][1]).toEqual(expect.objectContaining({ area: 'aluno', path: '/aluno' }))
        expect(reports[0][1].message).toMatch(/reading 'titulo'/)
        expect(reports[0][1].message).not.toMatch(/192\.168/)
        expect(reports[0][2]).toEqual({ background: true, timeoutMs: 10000 })

        // O mesmo erro outra vez (ex.: voltou à página) não manda outro aviso.
        cleanup()
        renderPortal(<TelaQuebrada />)
        expect(screen.getByRole('heading', { name: 'Algo deu errado nesta tela' })).toBeVisible()
        expect(apiPost.mock.calls.filter(([path]) => path === '/api/client-error')).toHaveLength(1)
      } finally {
        consoleError.mockRestore()
        window.history.replaceState(null, '', '/')
      }
    })
  }
})
