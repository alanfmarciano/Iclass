import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AtividadesPage from './AtividadesPage'

// Fase 3, C9 (P1-g; FUN-01): a lista de atividades do aluno. Antes do C9 não existia (o
// aluno não tinha onde ver nem enviar um trabalho).

const NOW = Date.UTC(2026, 10, 22, 15, 0)
const DAY = 24 * 60 * 60 * 1000
const mocks = vi.hoisted(() => ({ data: null, urls: [] }))

vi.mock('./useStudent', () => ({ useStudent: () => ({ email: 'ana@x.local', studentClass: '1DES', courseId: 'DES' }) }))
vi.mock('../../hooks/useApi', () => ({
  useApi: (url, deps, options) => { mocks.urls.push({ url, options }); return { data: mocks.data, loading: false, error: null, refetch: vi.fn() } },
}))

afterEach(() => { cleanup(); mocks.urls = [] })

function row(id, fields) {
  return { id, title: `Atividade ${id}`, dueAt: NOW + DAY * 3, closeAt: null, aceitaEnvio: true, versoes: 0, nota: null, ...fields }
}

describe('atividades do aluno: lista', () => {
  it('cartões em A fazer, Enviadas e Devolvidas, com o prazo, o selo escrito e o link da atividade', () => {
    mocks.data = {
      success: true,
      serverNow: NOW,
      timezone: 'America/Sao_Paulo',
      turmaEncerrada: false,
      assignments: [
        row('a1', { title: 'Relatório de redes', situacao: 'a_fazer', situacaoTexto: 'A fazer', unidade: 'Módulo 1 · Redes locais' }),
        row('a2', { situacao: 'refazer', situacaoTexto: 'Refazer até 25/11 às 23:00', versoes: 1 }),
        row('a3', { situacao: 'enviada', situacaoTexto: 'Enviada com atraso', versoes: 2 }),
        row('a4', { situacao: 'devolvida', situacaoTexto: 'Devolvida', aceitaEnvio: false, versoes: 1, nota: { nota: 90, desconto: 0, notaFinal: 90 } }),
      ],
    }
    render(<MemoryRouter><AtividadesPage /></MemoryRouter>)
    expect(mocks.urls[0]).toEqual({ url: '/api/student/assignments?courseId=DES&studentClass=1DES', options: { pollMs: 30000 } })
    const todo = screen.getByRole('region', { name: 'A fazer (2)' })
    const link = within(todo).getByRole('link', { name: /Relatório de redes/ })
    expect(link).toHaveAttribute('href', '/aluno/atividades/a1')
    expect(within(link).getByText('Prazo: qua., 25/11 às 12:00 (faltam 3 dias)')).toBeInTheDocument()
    expect(within(link).getByText('A fazer')).toBeInTheDocument()
    // A unidade da atividade (C9 ajuste 1: o desenho pede título, unidade, prazo e selo).
    expect(within(link).getByText('Módulo 1 · Redes locais')).toBeInTheDocument()
    expect(within(todo).getByText('Refazer até 25/11 às 23:00')).toBeInTheDocument()
    const sent = screen.getByRole('region', { name: 'Enviadas (1)' })
    expect(within(sent).getByText('Enviada com atraso')).toBeInTheDocument()
    expect(within(sent).getByText('2 versões enviadas')).toBeInTheDocument()
    const returned = screen.getByRole('region', { name: 'Devolvidas (1)' })
    expect(within(returned).getByText('Nota 9,0')).toBeInTheDocument()
    // Seção vazia de encerradas não aparece.
    expect(screen.queryByRole('region', { name: /Encerradas/ })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Ajuda sobre esta tela' })).toHaveAttribute('href', '/ajuda/aluno#atividades')
  })

  it('C9 ajuste 1: refazer com o prazo vencido fica em Enviadas, não em "Encerradas sem envio"', () => {
    mocks.data = {
      success: true,
      serverNow: NOW,
      timezone: 'America/Sao_Paulo',
      turmaEncerrada: false,
      assignments: [
        row('r1', { title: 'Refazer vencido', situacao: 'refazer', situacaoTexto: 'Refazer até 21/11 às 23:00', aceitaEnvio: false, versoes: 1, dueAt: NOW - DAY }),
        row('e1', { title: 'Nunca enviada', situacao: 'encerrada_sem_envio', situacaoTexto: 'Encerrada sem envio', aceitaEnvio: false, dueAt: NOW - DAY }),
      ],
    }
    render(<MemoryRouter><AtividadesPage /></MemoryRouter>)
    const sent = screen.getByRole('region', { name: 'Enviadas (1)' })
    expect(within(sent).getByRole('link', { name: /Refazer vencido/ })).toBeInTheDocument()
    expect(within(sent).getByText('Prazo para refazer encerrado')).toBeInTheDocument()
    expect(screen.queryByText('Refazer até 21/11 às 23:00')).not.toBeInTheDocument()
    const closed = screen.getByRole('region', { name: 'Encerradas sem envio (1)' })
    expect(within(closed).getByRole('link', { name: /Nunca enviada/ })).toBeInTheDocument()
  })

  it('sem atividades, diz que aparecem aqui quando o professor publicar; turma encerrada avisa', () => {
    mocks.data = { success: true, serverNow: NOW, timezone: 'America/Sao_Paulo', turmaEncerrada: true, assignments: [] }
    render(<MemoryRouter><AtividadesPage /></MemoryRouter>)
    expect(screen.getByText('Nenhuma atividade por enquanto')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Esta turma foi encerrada.')
  })
})
