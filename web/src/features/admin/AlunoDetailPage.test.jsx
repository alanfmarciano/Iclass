import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AlunoDetailPage from './AlunoDetailPage'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  printBoletim: vi.fn(() => true),
  downloadDataExport: vi.fn(() => 'dados-bia_x.local-2026-11-10.json'),
  openPrintWindow: vi.fn(),
  printDataExport: vi.fn(() => true),
  auth: { accountRole: 'admin' },
  students: null,
}))

vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: vi.fn() } }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => mocks.toast }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: mocks.auth }) }))
vi.mock('../../hooks/useAdminWorkspace', () => ({
  useAdminWorkspace: () => ({ courseId: 'OUTRO', courseName: 'Outro curso', className: 'X' }),
}))
vi.mock('./boletimPrint', () => ({ printBoletim: mocks.printBoletim }))
vi.mock('../../lib/dataExportPrint', () => ({ downloadDataExport: mocks.downloadDataExport, openPrintWindow: mocks.openPrintWindow, printDataExport: mocks.printDataExport }))
vi.mock('../../components/ui/MonthCalendar', () => ({ MonthCalendar: () => null }))
vi.mock('../../hooks/useApi', () => ({
  useApi: () => ({
    data: mocks.students || [{ name: 'Bia', email: 'bia@x.local', status: 'Ativo', classes: [{ name: '1DES', courseId: 'DES' }, { name: '2RED', courseId: 'RED' }] }],
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}))

beforeEach(() => {
  mocks.auth = { accountRole: 'admin' }
  mocks.students = null
  mocks.get.mockImplementation(async (path) => {
    if (path.startsWith('/api/admin/course-summaries')) return [{ id: 'DES', name: 'Técnico em Desenvolvimento' }, { id: 'RED', name: 'Técnico em Redes' }]
    if (path.startsWith('/api/admin/student/report')) return { student: { name: 'Bia' }, modules: [] }
    if (path.startsWith('/api/admin/student/audit')) return []
    if (path.startsWith('/api/admin/student/academic')) return { submissions: [], progress: { completedCount: 0 }, moduleAccess: [], attendance: { count: 0, recent: [] }, certificates: [] }
    return null
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Ficha do aluno · boletim', () => {
  it('[UC-NOTAS-003] aluno em dois cursos fora do curso ativo: o seletor mostra o nome do curso e envia o curso escolhido', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/alunos/bia%40x.local']}>
        <Routes><Route path="/alunos/:id" element={<AlunoDetailPage />} /></Routes>
      </MemoryRouter>,
    )
    await user.click(screen.getByRole('button', { name: 'Boletim (PDF)' }))
    const dialog = await screen.findByRole('dialog', { name: 'Boletim de qual curso?' })
    const redes = within(dialog).getByRole('button', { name: 'Turma 2RED · Técnico em Redes' })
    expect(within(dialog).getByRole('button', { name: 'Turma 1DES · Técnico em Desenvolvimento' })).toBeInTheDocument()
    expect(within(dialog).queryByText(/· RED$/)).not.toBeInTheDocument()
    await user.click(redes)
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/admin/student/report?email=bia%40x.local&courseId=RED&studentClass=2RED'))
    expect(mocks.printBoletim).toHaveBeenCalled()
  })

  it('[UC-NOTAS-003] professor: matrícula em curso fora do seu escopo aparece desativada, sem o id técnico', async () => {
    const user = userEvent.setup()
    mocks.auth = { accountRole: 'professor' }
    const fallback = mocks.get.getMockImplementation()
    mocks.get.mockImplementation(async (path) => (path.startsWith('/api/admin/course-summaries')
      ? [{ id: 'DES', name: 'Técnico em Desenvolvimento', classes: [{ name: '1DES' }] }]
      : fallback(path)))
    render(
      <MemoryRouter initialEntries={['/alunos/bia%40x.local']}>
        <Routes><Route path="/alunos/:id" element={<AlunoDetailPage />} /></Routes>
      </MemoryRouter>,
    )
    await user.click(screen.getByRole('button', { name: 'Boletim (PDF)' }))
    const dialog = await screen.findByRole('dialog', { name: 'Boletim de qual curso?' })
    expect(within(dialog).getByRole('button', { name: 'Turma 2RED · curso fora do seu acesso' })).toBeDisabled()
    expect(within(dialog).queryByText(/RED$/)).not.toBeInTheDocument()
    const des = within(dialog).getByRole('button', { name: 'Turma 1DES · Técnico em Desenvolvimento' })
    expect(des).toBeEnabled()
    await user.click(des)
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/admin/student/report?email=bia%40x.local&courseId=DES&studentClass=1DES'))
  })
})

describe('Ficha do aluno · notas com vírgula', () => {
  it('[UC-NOTAS-003] desempenho por módulo, comparativo e média do mês aparecem com vírgula (antes "7.8", "7.5 vs 6.3")', async () => {
    const fallback = mocks.get.getMockImplementation()
    mocks.get.mockImplementation(async (path) => {
      if (path.startsWith('/api/admin/student/academic')) {
        return {
          submissions: [
            { id: 's1', examKey: 'Avaliacao_FUTEC_1', score: 75, timestamp: '2026-03-01T12:00:00.000Z' },
            { id: 's2', examKey: 'Avaliacao_FUTEC_2', score: 80, timestamp: '2026-03-10T12:00:00.000Z' },
          ],
          progress: { completedCount: 0 }, moduleAccess: [], attendance: { count: 0, recent: [] }, certificates: [],
        }
      }
      if (path.startsWith('/api/admin/student/dashboard')) {
        return {
          kpis: { media: 7.75, provasFeitas: 2, provasTotais: 4, frequencia: 90, progresso: 10 },
          comparativo: { studentMedia: 7.75, turmaMedia: 6.84, studentFreq: 90, turmaFreq: 85, turmaSize: 12 },
          risco: { level: 'baixo', reasons: [] },
          engajamento: { weeks: [], diasAtivos: 3 },
          streak: { atual: 1, recorde: 2 },
          temporal: { mediaAtual: 7.5, mediaAnterior: 6.25, presencaAtual: 3, presencaAnterior: 2 },
          modulos: [{ id: 'm1', modulo: 'FUTEC', media: 7.75 }],
        }
      }
      return fallback(path)
    })
    render(
      <MemoryRouter initialEntries={['/alunos/bia%40x.local']}>
        <Routes><Route path="/alunos/:id" element={<AlunoDetailPage />} /></Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByText('7,5 vs 6,3')).toBeInTheDocument()
    expect(screen.getByText('aluno 7,8 · turma 6,8')).toBeInTheDocument()
    const modulo = screen.getByText('Desempenho por módulo').closest('div').parentElement
    expect(within(modulo).getByText('7,8')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/\b\d\.\d\b/)
    // A média da ficha é a da matrícula no curso/turma ativos (consolidada no servidor).
    expect(mocks.get).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/admin\/student\/dashboard\?email=bia%40x\.local&courseId=OUTRO&studentClass=X$/))
  })
})

describe('Ficha do aluno · desempenho por módulo', () => {
  it('[UC-NOTAS-003] mostra a média por módulo do servidor, igual à "Média geral", e não a média simples das tentativas', async () => {
    const fallback = mocks.get.getMockImplementation()
    mocks.get.mockImplementation(async (path) => {
      if (path.startsWith('/api/admin/student/academic')) {
        // Média simples destas tentativas: (6,0 + 6,8 + 2,0 + 10,0) / 4 = 6,2.
        return {
          submissions: [
            { id: 's1', examKey: 'Avaliacao_IRCOM_1', score: 60, timestamp: '2026-03-01T12:00:00.000Z' },
            { id: 's2', examKey: 'Avaliacao_IRCOM_1', score: 68, timestamp: '2026-03-01T12:30:00.000Z' },
            { id: 's3', examKey: 'Avaliacao_IRCOM_1', score: 20, timestamp: '2026-03-02T12:00:00.000Z' },
            { id: 's4', examKey: 'Avaliacao_IRCOM_1', score: 100, timestamp: '2026-03-03T12:00:00.000Z' },
          ],
          progress: { completedCount: 0 }, moduleAccess: [], attendance: { count: 0, recent: [] }, certificates: [],
        }
      }
      if (path.startsWith('/api/admin/student/dashboard')) {
        return {
          kpis: { media: 8.4, provasFeitas: 1, provasTotais: 2, frequencia: 90, progresso: 10 },
          comparativo: { studentMedia: 8.4, turmaMedia: 7, studentFreq: 90, turmaFreq: 85, turmaSize: 12 },
          risco: { level: 'baixo', reasons: [] },
          engajamento: { weeks: [], diasAtivos: 3 },
          streak: { atual: 1, recorde: 2 },
          temporal: { mediaAtual: null, mediaAnterior: null, presencaAtual: 3, presencaAnterior: 2 },
          modulos: [{ id: 'm1', modulo: 'IRCOM — Redes', media: 8.4 }],
        }
      }
      return fallback(path)
    })
    render(
      <MemoryRouter initialEntries={['/alunos/bia%40x.local']}>
        <Routes><Route path="/alunos/:id" element={<AlunoDetailPage />} /></Routes>
      </MemoryRouter>,
    )
    const label = await screen.findByText('IRCOM — Redes')
    const card = screen.getByText('Desempenho por módulo').closest('div').parentElement
    expect(within(card).getByText('8,4')).toBeInTheDocument()
    expect(within(card).queryByText('6,2')).not.toBeInTheDocument()
    expect(label).toBeInTheDocument()
  })

  it('[UC-NOTAS-003] sem a resposta do servidor não inventa média no navegador', async () => {
    const fallback = mocks.get.getMockImplementation()
    mocks.get.mockImplementation(async (path) => {
      if (path.startsWith('/api/admin/student/academic')) {
        return {
          submissions: [{ id: 's1', examKey: 'Avaliacao_IRCOM_1', score: 60, timestamp: '2026-03-01T12:00:00.000Z' }],
          progress: { completedCount: 0 }, moduleAccess: [], attendance: { count: 0, recent: [] }, certificates: [],
        }
      }
      if (path.startsWith('/api/admin/student/dashboard')) throw new Error('falhou')
      return fallback(path)
    })
    render(
      <MemoryRouter initialEntries={['/alunos/bia%40x.local']}>
        <Routes><Route path="/alunos/:id" element={<AlunoDetailPage />} /></Routes>
      </MemoryRouter>,
    )
    const card = (await screen.findByText('Desempenho por módulo')).closest('div').parentElement
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/admin\/student\/dashboard/)))
    expect(within(card).getByText('Sem notas ainda.')).toBeInTheDocument()
    const kpi = screen.getByText('Média geral').parentElement
    expect(within(kpi).getByText('—')).toBeInTheDocument()
    expect(within(kpi).queryByText('6,0')).not.toBeInTheDocument()
  })
})

describe('Ficha do aluno · aba Auditoria', () => {
  function renderDetail() {
    return render(
      <MemoryRouter initialEntries={['/alunos/bia%40x.local']}>
        <Routes><Route path="/alunos/:id" element={<AlunoDetailPage />} /></Routes>
      </MemoryRouter>,
    )
  }

  it('[UC-AUDITORIA-003] professor: a aba Auditoria some e a trilha nem é pedida ao servidor (que responde 403)', async () => {
    mocks.auth = { accountRole: 'professor' }
    renderDetail()
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/admin\/student\/academic/)))
    expect(screen.getByRole('button', { name: 'Visão geral' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Auditoria' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Segurança' })).not.toBeInTheDocument()
    expect(mocks.get.mock.calls.some(([path]) => String(path).startsWith('/api/admin/student/audit'))).toBe(false)
  })

  it('[UC-AUDITORIA-003] administrador: a aba mostra a trilha do aluno, com o motivo da mudança de nota', async () => {
    const user = userEvent.setup()
    const fallback = mocks.get.getMockImplementation()
    mocks.get.mockImplementation(async (path) => (path.startsWith('/api/admin/student/audit')
      ? [
        { id: 'a1', action: 'grade_unpublish', label: 'Nota ocultada do aluno', field: 'Publicação da nota', oldValue: 'Prova 1: 7,0 · publicada', newValue: 'oculta do aluno', reason: 'Revisão da correção', actor: 'admin@x.local', timestamp: Date.parse('2026-03-02T12:00:00Z') },
        { id: 'a2', action: 'certificate_issued', label: 'Certificado emitido', field: '', oldValue: null, newValue: null, actor: 'admin@x.local', timestamp: Date.parse('2026-03-01T12:00:00Z') },
      ]
      : fallback(path)))
    renderDetail()
    await user.click(screen.getByRole('button', { name: 'Auditoria' }))
    expect(await screen.findByText('Revisão da correção')).toBeInTheDocument()
    // O tipo aparece no cartão e no filtro; a entrada sem campo (certificado) entra pelo
    // rótulo da ação, sem "(vazio) → (vazio)".
    expect(screen.getAllByText('Publicação da nota')).toHaveLength(2)
    expect(screen.getAllByText('Certificado emitido')).toHaveLength(2)
    expect(screen.getByRole('option', { name: 'Certificado emitido' })).toBeInTheDocument()
    expect(screen.queryByText('(vazio)')).not.toBeInTheDocument()
  })
})

describe('[UC-ENCERRADOS-002] Ficha do aluno anonimizado', () => {
  it('não oferece Editar (o cadastro anonimizado não se edita); o aluno comum oferece', async () => {
    mocks.students = [{ name: 'Aluno anonimizado AAAAAA', email: 'anonimizado-aaa@anonimizado.invalid', status: 'Anonimizado', anonymizedAt: 1794341832487, classes: [{ name: '1DES', courseId: 'DES' }] }]
    const { unmount } = render(
      <MemoryRouter initialEntries={['/alunos/anonimizado-aaa%40anonimizado.invalid']}>
        <Routes><Route path="/alunos/:id" element={<AlunoDetailPage />} /></Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByRole('button', { name: 'Boletim (PDF)' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Editar' })).not.toBeInTheDocument()
    unmount()
    mocks.students = null
    render(
      <MemoryRouter initialEntries={['/alunos/bia%40x.local']}>
        <Routes><Route path="/alunos/:id" element={<AlunoDetailPage />} /></Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByRole('button', { name: 'Editar' })).toBeInTheDocument()
  })
})

describe('[UC-LGPD-011] Ficha do aluno · cópia dos dados pessoais', () => {
  const EXPORT = { type: 'iclass-dados-pessoais', audience: 'admin', generatedAt: '2026-11-10T13:00:00Z', profile: { email: 'bia@x.local' } }
  function renderDetail() {
    return render(
      <MemoryRouter initialEntries={['/alunos/bia%40x.local']}>
        <Routes><Route path="/alunos/:id" element={<AlunoDetailPage />} /></Routes>
      </MemoryRouter>,
    )
  }
  function withExport() {
    const fallback = mocks.get.getMockImplementation()
    mocks.get.mockImplementation(async (path) => (path.startsWith('/api/admin/lgpd/students/export') ? EXPORT : fallback(path)))
  }

  it('administrador baixa a cópia pela aba Segurança, com a finalidade, e a auditoria é relida', async () => {
    const user = userEvent.setup()
    withExport()
    renderDetail()
    await user.click(screen.getByRole('button', { name: 'Segurança' }))
    await user.click(screen.getByRole('button', { name: 'Baixar dados (JSON)' }))
    await waitFor(() => expect(mocks.downloadDataExport).toHaveBeenCalledWith(EXPORT))
    expect(mocks.get).toHaveBeenCalledWith('/api/admin/lgpd/students/export?email=bia%40x.local&finalidade=baixar')
    expect(mocks.toast.success).toHaveBeenCalledWith(expect.stringContaining('dados-bia_x.local-2026-11-10.json'))
    await waitFor(() => expect(mocks.get.mock.calls.filter(([path]) => String(path).startsWith('/api/admin/student/audit'))).toHaveLength(2))
  })

  it('imprimir abre a janela no clique e escreve nela a cópia recebida', async () => {
    const user = userEvent.setup()
    const win = { closed: false, close: vi.fn() }
    mocks.openPrintWindow.mockReturnValue(win)
    withExport()
    renderDetail()
    await user.click(screen.getByRole('button', { name: 'Segurança' }))
    await user.click(screen.getByRole('button', { name: 'Imprimir' }))
    await waitFor(() => expect(mocks.printDataExport).toHaveBeenCalledWith(EXPORT, win))
    expect(mocks.get).toHaveBeenCalledWith('/api/admin/lgpd/students/export?email=bia%40x.local&finalidade=imprimir')
  })

  it('janela bloqueada: avisa e não pede a cópia (nada vai para a auditoria)', async () => {
    const user = userEvent.setup()
    mocks.openPrintWindow.mockReturnValue(null)
    withExport()
    renderDetail()
    await user.click(screen.getByRole('button', { name: 'Segurança' }))
    await user.click(screen.getByRole('button', { name: 'Imprimir' }))
    expect(mocks.toast.error).toHaveBeenCalledWith(expect.stringContaining('bloqueou a janela'))
    expect(mocks.get.mock.calls.some(([path]) => String(path).startsWith('/api/admin/lgpd/students/export'))).toBe(false)
  })
})

describe('Ficha do aluno · professor auxiliar sem notas', () => {
  it('[UC-PAPEIS-001] sem Resultados nem relatórios: sem Média, sem quadros de nota, sem Boletim e sem Auditoria nem Segurança', async () => {
    mocks.auth = { accountRole: 'monitor', effectivePermissions: ['page.dashboard', 'page.classes', 'page.students', 'page.monitor'], roleLabel: 'Professor auxiliar' }
    const fallback = mocks.get.getMockImplementation()
    mocks.get.mockImplementation(async (path) => {
      if (path.startsWith('/api/admin/student/dashboard')) {
        return {
          gradesHidden: true,
          kpis: { media: null, provasFeitas: 0, provasTotais: 4, frequencia: 90, progresso: 10 },
          comparativo: { studentMedia: null, turmaMedia: null, studentFreq: 90, turmaFreq: 85, turmaSize: 12 },
          risco: { level: 'baixo', reasons: [] },
          engajamento: { weeks: [], diasAtivos: 3 },
          streak: { atual: 1, recorde: 2 },
          temporal: { mediaAtual: null, mediaAnterior: null, presencaAtual: 3, presencaAnterior: 2 },
          modulos: [],
        }
      }
      return fallback(path)
    })
    render(
      <MemoryRouter initialEntries={['/alunos/bia%40x.local']}>
        <Routes><Route path="/alunos/:id" element={<AlunoDetailPage />} /></Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByText('As notas não aparecem para o seu papel.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Boletim (PDF)' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull()
    expect(screen.queryByText('Evolução das notas')).toBeNull()
    expect(screen.queryByText('Desempenho por módulo')).toBeNull()
    expect(screen.queryByText(/Média \(mês atual vs anterior\)/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Auditoria' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Frequência' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Segurança' })).toBeNull()
    expect(mocks.get).not.toHaveBeenCalledWith(expect.stringMatching(/^\/api\/admin\/student\/audit/))
  })
})

describe('Ficha do aluno · critério de nota', () => {
  function renderWith(criterio) {
    const fallback = mocks.get.getMockImplementation()
    mocks.get.mockImplementation(async (path) => {
      if (path.startsWith('/api/admin/student/academic')) {
        return {
          submissions: [{ id: 's1', examKey: 'Avaliacao_IRCOM_1', score: 55, timestamp: '2026-03-01T12:00:00.000Z' }],
          progress: { completedCount: 0 }, moduleAccess: [], attendance: { count: 0, recent: [] }, certificates: [],
        }
      }
      if (path.startsWith('/api/admin/student/dashboard')) {
        return {
          kpis: { media: 5.5, provasFeitas: 1, provasTotais: 1, frequencia: 90, progresso: 10 },
          comparativo: {}, risco: { level: 'baixo', reasons: [] }, engajamento: { weeks: [] }, streak: {}, temporal: {}, modulos: [],
          ...(criterio ? { criterio } : {}),
        }
      }
      return fallback(path)
    })
    return render(
      <MemoryRouter initialEntries={['/alunos/bia%40x.local']}>
        <Routes><Route path="/alunos/:id" element={<AlunoDetailPage />} /></Routes>
      </MemoryRouter>,
    )
  }

  it('[UC-TENTATIVA-003] a cor da nota no Acadêmico segue o criterio que vem com a ficha (C1), não um 6 fixo', async () => {
    const user = userEvent.setup()
    renderWith({ mediaMinima: 5, mencoes: null, regraAntiga: true })
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/admin\/student\/dashboard/)))
    await user.click(await screen.findByRole('button', { name: 'Acadêmico' }))
    const linha = (await screen.findByText('Avaliacao_IRCOM_1')).closest('div').parentElement
    await waitFor(() => expect(within(linha).getByText('5,5')).toHaveClass('text-success'))
  })

  it('[UC-TENTATIVA-003] sem criterio na resposta, a média mínima padrão (6,0): 5,5 fica em atenção', async () => {
    const user = userEvent.setup()
    renderWith(null)
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/admin\/student\/dashboard/)))
    await user.click(await screen.findByRole('button', { name: 'Acadêmico' }))
    const linha = (await screen.findByText('Avaliacao_IRCOM_1')).closest('div').parentElement
    expect(within(linha).getByText('5,5')).toHaveClass('text-warning')
  })
})

// P4-S3 (fase 3): a ficha abre pelo id estável; o endereço antigo, com o e-mail, troca pelo
// do id. O aluno sem e-mail aparece como "sem e-mail" e a tela segue mandando o endereço
// interno nas rotas (é a chave do cadastro).
describe('[UC-IDENT-001] ficha do aluno pelo id', () => {
  function Where() {
    const location = useLocation()
    return <p data-testid="where">{location.pathname}</p>
  }
  function renderAt(url) {
    return render(
      <MemoryRouter initialEntries={[url]}>
        <Routes><Route path="/alunos/:id" element={<><AlunoDetailPage /><Where /></>} /></Routes>
      </MemoryRouter>,
    )
  }

  it('endereço antigo com o e-mail troca pelo do id', async () => {
    mocks.students = [{ id: 'alu_00000000000000b1', name: 'Bia', email: 'bia@x.local', status: 'Ativo', classes: [{ name: '1DES', courseId: 'DES' }] }]
    renderAt('/alunos/bia%40x.local')
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/alunos/alu_00000000000000b1'))
  })

  it('aluno sem e-mail: "sem e-mail" na tela e o boletim pede pelo endereço interno', async () => {
    const user = userEvent.setup()
    const internal = 'aluno-alu_00000000000000f2@sem-email.invalid'
    mocks.students = [{ id: 'alu_00000000000000f2', name: 'Bruno', email: internal, matricula: 'R7', status: 'Ativo', classes: [{ name: '1DES', courseId: 'DES' }] }]
    renderAt('/alunos/alu_00000000000000f2')
    expect(await screen.findByText(/sem e-mail/)).toBeTruthy()
    expect(screen.queryByText(/sem-email\.invalid/)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Boletim (PDF)' }))
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(`/api/admin/student/report?email=${encodeURIComponent(internal)}&courseId=DES&studentClass=1DES`))
  })
})
