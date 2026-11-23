import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 3, C15 / P5-S6b (CRIT-08, D21 do P5): o portal na pré-visualização como aluno tem a
// faixa no fluxo da página, sem presença, sem pré-carregar a prova e sem "Marcar como
// lidas"; a prova não abre.
const loads = vi.hoisted(() => ({ examRunner: 0, examShell: 0 }))
vi.mock('./exam/ExamRunner', () => { loads.examRunner += 1; return { default: () => <p>Tela da prova</p> } })
const apiPost = vi.hoisted(() => vi.fn())
const apiGet = vi.hoisted(() => vi.fn())
vi.mock('../../lib/api', () => ({ api: { get: apiGet, post: apiPost }, hasActiveSession: () => true }))
const branding = vi.hoisted(() => ({ interfacePreset: 'classic' }))
vi.mock('../../context/BrandingProvider', () => ({ useBranding: () => ({ branding: {}, interfacePreset: branding.interfacePreset }) }))
const PREVIEW = vi.hoisted(() => ({
  token: 'tok-previa',
  rotulo: 'Pré-visualização como aluno de 1DES · grupo Laboratório A',
  origem: '/turmas',
  expiraEm: Date.now() + 3600000,
  aluno: { email: 'previa-ab@previa.invalid', name: 'Pré-visualização', classes: [{ name: '1DES', courseId: 'curso' }], courses: [{ id: 'curso', name: 'Curso' }] },
}))
const authMock = vi.hoisted(() => ({ logout: vi.fn(), setActiveClass: vi.fn(), endPreview: vi.fn(() => '/turmas'), endSessionFromError: vi.fn(), syncPasswordChange: vi.fn() }))
vi.mock('../../context/AuthProvider', () => ({
  useAuth: () => ({
    ...authMock,
    auth: { role: 'student', email: PREVIEW.aluno.email, activeClass: PREVIEW.aluno.classes[0], student: PREVIEW.aluno, preview: PREVIEW },
  }),
}))
vi.mock('./StudentCourseGate', () => ({ StudentCourseGate: ({ children }) => children }))
vi.mock('./StudentPrivacyGate', () => ({ StudentPrivacyGate: ({ children }) => children, notePublishedLegalVersion: () => {} }))
vi.mock('./StudentExamAvailability', () => ({ StudentExamAvailability: () => null }))
const bell = vi.hoisted(() => ({ props: null }))
vi.mock('../../components/ui/NotificationBell', () => ({ NotificationBell: (props) => { bell.props = props; return null } }))
vi.mock('../../components/ui/ThemeToggle', () => ({ ThemeToggle: () => null }))

import { EXAM_PREFETCH_DELAY_MS, StudentShell } from './StudentShell'
import { StudentExamShell } from './StudentExamShell'
import { resetMessageCountForTests } from '../../lib/messageCounter'

function renderPortal() {
  return render(
    <MemoryRouter initialEntries={['/aluno']}>
      <Routes>
        <Route path="/aluno" element={<StudentShell />}>
          <Route index element={<p>Início do aluno</p>} />
        </Route>
        <Route path="/turmas" element={<p>Tela Turmas do painel</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  apiPost.mockReset()
  apiPost.mockResolvedValue({})
  apiGet.mockReset()
  apiGet.mockResolvedValue({})
  Object.values(authMock).forEach((fn) => fn.mockClear())
  bell.props = null
  resetMessageCountForTests()
  branding.interfacePreset = 'classic'
  window.matchMedia = vi.fn().mockImplementation((query) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('[UC-PREVIA-004] portal na pré-visualização', () => {
  for (const preset of ['classic', 'lumen']) {
    it(`visual ${preset}: faixa no fluxo com o rótulo e "nada é gravado", sem presença e sem "Marcar como lidas"`, async () => {
      branding.interfacePreset = preset
      vi.useFakeTimers()
      renderPortal()
      const banner = screen.getByRole('region', { name: 'Pré-visualização como aluno' })
      expect(banner).toHaveTextContent('Pré-visualização como aluno de 1DES · grupo Laboratório A · nada é gravado')
      // No fluxo da página: nada de position fixed/sticky na faixa.
      expect(banner.className).not.toMatch(/\b(fixed|sticky)\b/)
      expect(bell.props.seenEndpoint).toBeNull()
      expect(bell.props.seenDisabledText).toBe('Desativado na pré-visualização')
      await act(async () => { vi.advanceTimersByTime(EXAM_PREFETCH_DELAY_MS * 3) })
      expect(loads.examRunner).toBe(0)
      expect(apiGet.mock.calls.some(([url]) => String(url).startsWith('/api/ping'))).toBe(false)
    })
  }

  it('"Sair da pré-visualização" fecha a prévia e volta para a tela do painel de onde veio', () => {
    renderPortal()
    const banner = screen.getByRole('region', { name: 'Pré-visualização como aluno' })
    fireEvent.click(within(banner).getByRole('button', { name: 'Sair da pré-visualização' }))
    expect(authMock.endPreview).toHaveBeenCalled()
    expect(authMock.logout).not.toHaveBeenCalled()
    expect(screen.getByText('Tela Turmas do painel')).toBeInTheDocument()
  })

  it('o Sair do menu do portal também fecha só a prévia', () => {
    renderPortal()
    const buttons = screen.getAllByRole('button', { name: /Sair da pré-visualização/ })
    fireEvent.click(buttons[buttons.length - 1])
    expect(authMock.endPreview).toHaveBeenCalled()
    expect(authMock.logout).not.toHaveBeenCalled()
  })

  it('abrir um aviso pelo sino não o marca como lido', async () => {
    renderPortal()
    await act(async () => { await bell.props.onOpenItem({ type: 'aviso', id: 'aviso:a1', href: '/aluno/avisos' }) })
    expect(apiPost).not.toHaveBeenCalled()
  })

  it('a prova não começa: o aviso no lugar da tela da prova, sem presença nem estado da prova', async () => {
    const router = createMemoryRouter([
      { path: '/aluno/prova/:examKey', element: <StudentExamShell />, children: [{ index: true, element: <p>Tela da prova</p> }] },
    ], { initialEntries: ['/aluno/prova/Avaliacao_1?applicationId=app-1'] })
    render(<RouterProvider router={router} />)
    expect(screen.getByText('Na pré-visualização a prova não começa. Para ver as questões, use Provas > Visualizar.')).toBeInTheDocument()
    expect(screen.queryByText('Tela da prova')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Pré-visualização como aluno' })).toBeInTheDocument()
    await act(async () => {})
    expect(apiGet).not.toHaveBeenCalled()
    expect(apiPost).not.toHaveBeenCalled()
  })
})
