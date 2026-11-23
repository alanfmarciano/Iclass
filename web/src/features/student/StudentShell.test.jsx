import { lazy } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
const apiGet = vi.hoisted(() => vi.fn())
vi.mock('../../lib/api', () => ({ api: { get: apiGet, post: apiPost }, hasActiveSession: () => true }))
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
const heartbeat = vi.hoisted(() => ({ options: null }))
vi.mock('./useStudentHeartbeat', () => ({ useStudentHeartbeat: (options) => { heartbeat.options = options } }))
const bell = vi.hoisted(() => ({ props: null }))
vi.mock('../../components/ui/NotificationBell', () => ({ NotificationBell: (props) => { bell.props = props; return null } }))
vi.mock('../../components/ui/ThemeToggle', () => ({ ThemeToggle: () => null }))

import { EXAM_PREFETCH_DELAY_MS, StudentShell } from './StudentShell'
import { resetClientErrorReportsForTests } from '../../lib/clientErrors'
import { resetPrivacyGateCache } from './StudentPrivacyGate'
import { resetMessageCountForTests } from '../../lib/messageCounter'

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
  apiGet.mockReset()
  apiGet.mockResolvedValue({})
  heartbeat.options = null
  bell.props = null
  resetMessageCountForTests()
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

// Revisão da J3: o legalVersion só vinha pelo sino, que o aluno sem turma não tem. O ping
// do portal (useStudentHeartbeat) traz a mesma versão, e o StudentShell a passa ao portão.
describe('[UC-LGPD-007] portal do aluno · versão dos documentos pelo ping', () => {
  it('versão diferente vinda do ping faz o portão de primeiro acesso consultar de novo', async () => {
    resetPrivacyGateCache()
    renderPortal()
    await act(async () => {})
    const statusCalls = () => apiGet.mock.calls.filter(([path]) => String(path).startsWith('/api/student/privacy/status')).length
    expect(statusCalls()).toBe(1)
    expect(typeof heartbeat.options?.onPresence).toBe('function')
    await act(async () => { heartbeat.options.onPresence({ success: true, legalVersion: '|' }) })
    expect(statusCalls()).toBe(1)
    await act(async () => { heartbeat.options.onPresence({ success: true, legalVersion: 'termos_v2|privacidade_v1' }) })
    expect(statusCalls()).toBe(2)
  })
})

// Fase 3, C9 (P1-g; FUN-01): o menu do aluno tem "Atividades" entre Provas e Caderno, e o
// título do topo continua "Atividades" dentro de uma atividade (/aluno/atividades/<id>).
describe('portal do aluno · Atividades no menu', () => {
  it('"Atividades" leva a /aluno/atividades, depois de Provas e antes de Caderno', () => {
    renderPortal()
    const nav = screen.getAllByRole('link').map((link) => link.textContent.trim())
    const provas = nav.indexOf('Provas')
    expect(nav[provas + 1]).toBe('Atividades')
    expect(nav[provas + 2]).toBe('Caderno')
    expect(screen.getByRole('link', { name: 'Atividades' })).toHaveAttribute('href', '/aluno/atividades')
  })

  it('o título do topo é "Atividades" também na página de uma atividade', () => {
    render(
      <MemoryRouter initialEntries={['/aluno/atividades/asg_1']}>
        <Routes>
          <Route path="/aluno" element={<StudentShell />}>
            <Route path="atividades/:id" element={<p>Uma atividade</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByText('Uma atividade')).toBeInTheDocument()
    expect(screen.getByText('Atividades', { selector: 'strong' })).toBeInTheDocument()
  })

  it('no celular o menu fecha ao escolher um destino e a página nova fica por cima', () => {
    window.matchMedia = vi.fn().mockImplementation((query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }))
    const { container } = render(
      <MemoryRouter initialEntries={['/aluno']}>
        <Routes>
          <Route path="/aluno" element={<StudentShell />}>
            <Route index element={<p>Início do aluno</p>} />
            <Route path="atividades" element={<p>Lista de atividades</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
    const aside = container.querySelector('aside')
    expect(aside).toHaveAttribute('aria-hidden', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    expect(aside).not.toHaveAttribute('aria-hidden')
    fireEvent.click(screen.getByRole('link', { name: 'Atividades' }))
    expect(screen.getByText('Lista de atividades')).toBeInTheDocument()
    expect(aside).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByRole('button', { name: 'Fechar menu' })).toBeNull()
  })
})

// Fase 3, C14 (P5-S7b; FUN-14): "Mensagens" no menu do aluno, depois de Dúvidas, com o
// número de conversas com mensagem nova lido do sino (sem consulta própria).
describe('[UC-MENSAGEM-006] portal do aluno · Mensagens no menu', () => {
  const mensagensLink = () => screen.getAllByRole('link').find((item) => item.getAttribute('href') === '/aluno/mensagens')
  const bellData = { items: [
    { id: 'mensagem:c1', type: 'mensagem', unread: true },
    { id: 'mensagem:c2', type: 'mensagem', unread: false },
    { id: 'aviso:a1', type: 'aviso', unread: true },
  ] }

  it('no visual clássico, o item vem depois de Dúvidas e mostra o número que o sino trouxe', async () => {
    renderPortal()
    expect(mensagensLink()).toHaveTextContent('Mensagens')
    expect(mensagensLink()).not.toHaveTextContent('conversa')
    expect(typeof bell.props?.onData).toBe('function')
    await act(async () => { bell.props.onData(bellData) })
    expect(mensagensLink()).toHaveTextContent('2 conversas com mensagem nova')
    await act(async () => { bell.props.onData({ items: [] }) })
    expect(mensagensLink()).not.toHaveTextContent('conversa')
    const hrefs = screen.getAllByRole('link').map((item) => item.getAttribute('href'))
    expect(hrefs.indexOf('/aluno/mensagens')).toBe(hrefs.indexOf('/aluno/duvidas') + 1)
  })

  it('no visual Lumen, o item fica no menu completo e o botão que o abre avisa que há novidade', async () => {
    branding.interfacePreset = 'lumen'
    renderPortal()
    expect(screen.getByRole('button', { name: 'Abrir todos os módulos' })).toBeInTheDocument()
    await act(async () => { bell.props.onData(bellData) })
    expect(screen.getByRole('button', { name: 'Mais (há novidades no menu)' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Abrir todos os módulos (há novidades no menu)' }))
    expect(mensagensLink()).toHaveTextContent('2 conversas com mensagem nova')
  })
})

// Fase 3, C16 (P5-S2; CRIT-07): a lupa do cabeçalho leva à Busca, nos dois visuais, e o
// topo diz "Busca" na tela dela.
describe('[UC-BUSCA-003] portal do aluno · lupa da Busca no cabeçalho', () => {
  for (const preset of ['classic', 'lumen']) {
    it(`no visual ${preset}, a lupa abre /aluno/busca`, () => {
      branding.interfacePreset = preset
      render(
        <MemoryRouter initialEntries={['/aluno']}>
          <Routes>
            <Route path="/aluno" element={<StudentShell />}>
              <Route index element={<p>Início do aluno</p>} />
              <Route path="busca" element={<p>Tela da busca</p>} />
            </Route>
          </Routes>
        </MemoryRouter>,
      )
      const lupa = screen.getByRole('link', { name: 'Buscar' })
      expect(lupa).toHaveAttribute('href', '/aluno/busca')
      fireEvent.click(lupa)
      expect(screen.getByText('Tela da busca')).toBeInTheDocument()
      expect(screen.getAllByText('Busca').length).toBeGreaterThan(0)
    })
  }
})
