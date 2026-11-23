import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { fireEvent, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import InicioPage from './InicioPage'

const mocks = vi.hoisted(() => ({ dashboard: null, calendar: null, assignments: null, groups: null, urls: [] }))

vi.mock('./useStudent', () => ({ useStudent: () => ({ email: 'ana@x.local', name: 'Ana', studentClass: '1DES', courseId: 'DES' }) }))
vi.mock('../../hooks/useApi', () => ({
  useApi: (url) => {
    mocks.urls.push(url)
    const text = String(url || '')
    const data = text.includes('/dashboard') ? mocks.dashboard
      : text.includes('/calendar-events') ? mocks.calendar
        : text.startsWith('/api/student/assignments') ? mocks.assignments
          : text.startsWith('/api/student/groups') ? mocks.groups
            : null
    return { data, loading: false, error: null, refetch: vi.fn() }
  },
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.calendar = null
})

describe('Início do aluno · notas', () => {
  it('[UC-NOTAS-003] notas do painel e das barras de desempenho saem com vírgula', () => {
    // Antes as barras de "Seu desempenho" mostravam item.note.toFixed(1) ("7.5").
    mocks.dashboard = {
      courseName: 'Desenvolvimento',
      overallNote: 8.25,
      modules: [{ id: 'm1', name: 'FUTEC', done: 1, total: 2, progress: 50, note: 6.5, noteStatus: 'published' }],
      performance: [
        { id: 's1', examKey: 'Avaliacao_FUTEC_1', note: 7.5 },
        { id: 's2', examKey: 'Avaliacao_FUTEC_2', note: 9 },
      ],
      announcements: [],
      calendar: [],
    }
    render(<MemoryRouter><InicioPage /></MemoryRouter>)
    expect(screen.getByText('Nota geral').parentElement.parentElement).toHaveTextContent('8,3')
    expect(screen.getByText('6,5')).toBeInTheDocument()
    expect(screen.getByText('7,5')).toBeInTheDocument()
    expect(screen.getByText('9,0')).toBeInTheDocument()
    expect(screen.queryByText('7.5')).not.toBeInTheDocument()
    expect(screen.queryByText('9.0')).not.toBeInTheDocument()
  })

  it('[UC-NOTAS-006] barra de avaliação manual mostra o título dela, não o id', () => {
    // Antes a barra mostrava o examKey ("man_1795397447192_410b1b").
    mocks.dashboard = {
      courseName: 'Desenvolvimento',
      overallNote: 8,
      modules: [],
      performance: [
        { id: 's1', examKey: 'Avaliacao_FUTEC_1', note: 7 },
        { id: 's2', examKey: 'man_1795397447192_410b1b', title: 'Seminário de redes', note: 9 },
      ],
      announcements: [],
      calendar: [],
    }
    render(<MemoryRouter><InicioPage /></MemoryRouter>)
    expect(screen.getByText('Seminário de redes')).toBeInTheDocument()
    expect(screen.getByText('FUTEC_1')).toBeInTheDocument()
    expect(screen.queryByText(/man_1795397447192/)).not.toBeInTheDocument()
  })

  it('[UC-TAREFAS-003] tarefa com "Conta na média" desmarcado aparece no desempenho marcada "fora da média"', () => {
    // C18, rodada 1: antes a barra da tarefa fora da média era igual às que contam.
    mocks.dashboard = {
      courseName: 'Desenvolvimento',
      overallNote: 8,
      modules: [],
      performance: [
        { id: 'tarefa:asg_1', examKey: 'asg_1', title: 'Tarefa: Relatório', note: 9.5 },
        { id: 'tarefa:asg_2', examKey: 'asg_2', title: 'Tarefa: Exercício extra', note: 3, foraDaMedia: true },
      ],
      announcements: [],
      calendar: [],
    }
    render(<MemoryRouter><InicioPage /></MemoryRouter>)
    expect(screen.getAllByText('fora da média')).toHaveLength(1)
    expect(screen.getByText('Tarefa: Exercício extra')).toHaveAttribute('title', 'Tarefa: Exercício extra · fora da média')
    expect(screen.getByText('Tarefa: Relatório')).toHaveAttribute('title', 'Tarefa: Relatório')
  })
})

describe('Início do aluno · dias sem aula', () => {
  const localYmd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

  it('[UC-PRESENCA-005] hoje sem aula: faixa no topo, "Sem aula" nos compromissos e os dias do recesso marcados no mês', () => {
    const hoje = new Date()
    const amanha = new Date(); amanha.setDate(hoje.getDate() + 1)
    mocks.dashboard = {
      courseName: 'Desenvolvimento', overallNote: null, modules: [], performance: [], announcements: [],
      calendar: [{ id: 'nao-letivo:nl_1', title: 'Recesso escolar', eventDate: localYmd(hoje), endDate: localYmd(amanha), startTime: '', eventType: 'nao_letivo', hoje: true }],
    }
    mocks.calendar = [{ id: 'nao-letivo:nl_1', title: 'Recesso escolar', eventDate: localYmd(hoje), endDate: localYmd(amanha), eventType: 'nao_letivo' }]
    render(<MemoryRouter><InicioPage /></MemoryRouter>)
    expect(screen.getByRole('status')).toHaveTextContent('Hoje não tem aula: Recesso escolar')
    expect(screen.getByText('Sem aula')).toBeInTheDocument()
    expect(screen.queryByText('nao_letivo')).toBeNull()
    // O dia de amanhã (dentro do recesso) também aparece como sem aula no mês.
    if (amanha.getMonth() === hoje.getMonth()) expect(screen.getByRole('button', { name: `${amanha.getDate()}: sem aula` })).toBeInTheDocument()
  })

  it('[UC-PRESENCA-005] sem dia sem aula hoje, sem a faixa', () => {
    mocks.dashboard = { courseName: 'Desenvolvimento', overallNote: null, modules: [], performance: [], announcements: [], calendar: [] }
    render(<MemoryRouter><InicioPage /></MemoryRouter>)
    expect(screen.queryByText(/Hoje não tem aula/)).toBeNull()
  })
})

// Fase 3, C9 (P1-g; parte de UXA-25): a Início mostra as atividades esperando o envio do
// aluno, com o prazo e o link, e "Ver todas" leva à lista.
const navigate = vi.hoisted(() => vi.fn())
vi.mock('react-router-dom', async (importOriginal) => ({ ...(await importOriginal()), useNavigate: () => navigate }))

describe('Início do aluno · atividades a fazer', () => {
  it('lista só as que esperam o envio, por prazo, com o link de cada uma', () => {
    const now = Date.UTC(2026, 10, 22, 15, 0)
    mocks.dashboard = { modules: [], announcements: [], calendar: [] }
    mocks.assignments = {
      serverNow: now,
      timezone: 'America/Sao_Paulo',
      assignments: [
        { id: 'asg_a', title: 'Relatório de redes', situacao: 'a_fazer', situacaoTexto: 'A fazer', aceitaEnvio: true, dueAt: now + 26 * 60 * 60 * 1000 },
        { id: 'asg_b', title: 'Já enviada', situacao: 'enviada', situacaoTexto: 'Enviada', aceitaEnvio: true, dueAt: now + 60 * 60 * 1000 },
        { id: 'asg_c', title: 'Diagrama', situacao: 'atrasada', situacaoTexto: 'Atrasada', aceitaEnvio: true, dueAt: now - 60 * 60 * 1000 },
      ],
    }
    render(<MemoryRouter><InicioPage /></MemoryRouter>)
    const card = screen.getByRole('heading', { name: 'Atividades a fazer (2)' }).closest('.premium-card')
    expect(within(card).getByText('Relatório de redes')).toBeInTheDocument()
    expect(within(card).getByText('Prazo: seg., 23/11 às 14:00 (falta 1 dia e 2 horas)')).toBeInTheDocument()
    expect(within(card).getByText('Diagrama')).toBeInTheDocument()
    expect(within(card).queryByText('Já enviada')).not.toBeInTheDocument()
    fireEvent.click(within(card).getByText('Relatório de redes'))
    expect(navigate).toHaveBeenCalledWith('/aluno/atividades/asg_a')
    fireEvent.click(within(card).getByRole('button', { name: 'Ver todas' }))
    expect(navigate).toHaveBeenCalledWith('/aluno/atividades')
  })
})

// C9 ajuste 2 (UXA-25): o número "Pendências" não levava a nada; agora abre os conteúdos.
describe('Início do aluno · Pendências', () => {
  it('o cartão "Pendências" abre os conteúdos liberados', () => {
    mocks.dashboard = { modules: [], announcements: [], calendar: [], pendingCount: 6 }
    mocks.assignments = { serverNow: Date.now(), timezone: 'America/Sao_Paulo', assignments: [] }
    render(<MemoryRouter><InicioPage /></MemoryRouter>)
    const button = screen.getByRole('button', { name: /Pendências\s*6\s*Conteúdos liberados para estudar/ })
    fireEvent.click(button)
    expect(navigate).toHaveBeenCalledWith('/aluno/modulos')
  })
})

// Fase 3, C12 (P5-S4, CRIT-11): "Meus grupos" na Início, com o nome dos colegas (sem
// e-mail); sem grupo, o cartão não aparece.
describe('Início do aluno · Meus grupos', () => {
  it('[UC-GRUPO-001] mostra os grupos da turma com o nome dos colegas; sem grupo, nada', () => {
    mocks.dashboard = { modules: [], announcements: [], calendar: [] }
    mocks.assignments = { serverNow: Date.now(), timezone: 'America/Sao_Paulo', assignments: [] }
    mocks.groups = [
      { id: 'grp_1', nome: 'Laboratório A', conjunto: 'Laboratório', tipo: 'subturma', tipoTexto: 'Subturma', colegas: ['Bia', 'Caio Prado'] },
      { id: 'grp_2', nome: 'Equipe 3', conjunto: 'Projeto integrador', tipo: 'equipe', tipoTexto: 'Equipe', colegas: [] },
    ]
    mocks.urls = []
    render(<MemoryRouter><InicioPage /></MemoryRouter>)
    expect(mocks.urls).toContain('/api/student/groups?courseId=DES&studentClass=1DES')
    const card = screen.getByRole('heading', { name: 'Meus grupos' }).closest('.premium-card')
    expect(within(card).getByText('2 grupos')).toBeInTheDocument()
    expect(within(card).getByText('Laboratório A')).toBeInTheDocument()
    expect(within(card).getByText('Subturma')).toBeInTheDocument()
    expect(within(card).getByText('Com Bia, Caio Prado')).toBeInTheDocument()
    expect(within(card).getByText('Só você neste grupo por enquanto.')).toBeInTheDocument()
    cleanup()
    mocks.groups = []
    render(<MemoryRouter><InicioPage /></MemoryRouter>)
    expect(screen.queryByRole('heading', { name: 'Meus grupos' })).not.toBeInTheDocument()
  })
})

// Fase 3, C16 (P5-S2; contrato C8 do P5): "Continue de onde parou" abre direto a unidade
// pelo endereço (?unidade=); sem unidade, a lista de módulos.
describe('Início do aluno · Continue de onde parou', () => {
  it('[UC-BUSCA-003] leva à unidade pelo endereço do leitor', () => {
    mocks.dashboard = { modules: [], announcements: [], calendar: [], continueItem: { key: 'Apostila_DES 2', title: 'Redes', moduleName: 'Módulo 1' } }
    mocks.assignments = { serverNow: Date.now(), timezone: 'America/Sao_Paulo', assignments: [] }
    render(<MemoryRouter><InicioPage /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: /Redes\s*Módulo 1/ }))
    expect(navigate).toHaveBeenCalledWith('/aluno/modulos?unidade=Apostila_DES+2')
    cleanup()
    navigate.mockClear()
    mocks.dashboard = { modules: [], announcements: [], calendar: [], continueItem: null }
    render(<MemoryRouter><InicioPage /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: /Acesse seus módulos/ }))
    expect(navigate).toHaveBeenCalledWith('/aluno/modulos')
  })
})
