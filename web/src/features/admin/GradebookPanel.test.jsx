import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GradebookPanel, columnGroupOf, gradebookGroups } from './GradebookPanel'

vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }))

afterEach(() => cleanup())

// Quadro como GET /api/admin/gradebook devolve com os critérios do curso ligados (B6).
function quadroComCriterios() {
  return {
    criterio: { mediaMinima: 5, mencoes: [{ sigla: 'B', nome: 'Bom', min: 7 }, { sigla: 'I', nome: 'Insuficiente', min: 0 }], regraAntiga: false },
    etapas: [{ ordem: 1, nome: '1º bimestre', peso: 1 }, { ordem: 2, nome: '2º bimestre', peso: 2 }],
    mencoes: [{ sigla: 'B', nome: 'Bom', min: 7 }, { sigla: 'I', nome: 'Insuficiente', min: 0 }],
    avisos: [{ codigo: 'itens_sem_etapa', texto: 'Quiz sem etapa: não entra na média.' }],
    columns: [
      { id: 'P1', examKey: 'P1', label: 'Prova 1', moduleName: 'Módulo 1', etapa: 1, peso: 1 },
      { id: 'man_1', examKey: 'man_1', label: 'Seminário', moduleName: 'Avaliações da turma', origem: 'manual', tipo: 'Seminário', etapa: 2, peso: 1 },
      { id: 'REC1', examKey: 'REC1', label: 'Recuperação 1', moduleName: 'Módulo 1', etapa: 1, recuperacaoDe: 'etapa:1' },
      { id: 'Q', examKey: 'Q', label: 'Quiz', moduleName: 'Módulo 1', etapa: null },
      { id: 'X', examKey: 'X', label: 'Simulado', moduleName: 'Módulo 1', fora: true },
    ],
    rows: [
      {
        email: 'ana@x.local', name: 'Ana', cells: { P1: { score: 40, grade: 4, pending: 0 }, REC1: { score: 70, grade: 7, pending: 0 }, man_1: { score: 85, grade: 8.5, pending: 1 } },
        average: 8, averageScore: 80, gradedCount: 3, pendingCount: 1,
        etapas: [
          { ordem: 1, nome: '1º bimestre', peso: 1, media: 4, recuperacao: 7, recuperacaoAplicada: true, final: 7, semNota: false },
          { ordem: 2, nome: '2º bimestre', peso: 2, media: 8.5, recuperacao: null, final: 8.5, semNota: false },
        ],
        mediaFinal: 8, situacao: 'aprovado', situacaoRotulo: 'Aprovado', mencao: { sigla: 'B', nome: 'Bom' }, frequencia: 95, avisos: [],
      },
      {
        email: 'bia@x.local', name: 'Bia', cells: { P1: { score: 45, grade: 4.5, pending: 0 } },
        average: 4.5, averageScore: 45, gradedCount: 1, pendingCount: 0,
        etapas: [
          { ordem: 1, nome: '1º bimestre', peso: 1, media: 4.5, recuperacao: null, final: 4.5, semNota: false },
          { ordem: 2, nome: '2º bimestre', peso: 2, media: null, recuperacao: null, final: null, semNota: true },
        ],
        mediaFinal: 4.5, situacao: 'cursando', situacaoRotulo: 'Cursando', mencao: { sigla: 'I', nome: 'Insuficiente' }, frequencia: 70, avisos: [],
      },
    ],
  }
}

const api = (data) => ({ data, loading: false, error: null, refetch: vi.fn() })

describe('Quadro de notas com critérios', () => {
  it('[UC-NOTAS-008] agrupa as colunas por etapa (recuperação na etapa dela) e separa sem etapa e fora da média', () => {
    const data = quadroComCriterios()
    expect(data.columns.map(columnGroupOf)).toEqual(['etapa:1', 'etapa:2', 'etapa:1', 'sem_etapa', 'fora'])
    const groups = gradebookGroups(data)
    expect(groups.map((group) => group.titulo)).toEqual(['1º bimestre · peso 1', '2º bimestre · peso 2', 'Sem etapa (fora da média)', 'Não contam na média'])
    expect(groups[0].colunas.map((column) => column.id)).toEqual(['P1', 'REC1'])
  })

  it('[UC-NOTAS-008] mostra a média da etapa, a média final, a situação e a menção do servidor, com a mínima do curso', () => {
    render(<GradebookPanel courseId="DES" studentClass="1DES" gradebook={api(quadroComCriterios())} />)
    const table = screen.getByRole('table')
    expect(within(table).getAllByText('Média da etapa')).toHaveLength(2)
    for (const name of ['Média final', 'Frequência', 'Situação', 'Menção']) expect(within(table).getByRole('columnheader', { name })).toBeInTheDocument()
    const ana = within(table).getByRole('rowheader', { name: /Ana/ }).closest('tr')
    // 1º bimestre com a recuperação aplicada (7,0), média final 8,0 do servidor (não conta local).
    expect(within(ana).getAllByText('7,0').some((el) => el.closest('span')?.textContent === '7,0(rec.)')).toBe(true)
    expect(within(ana).getByText('8,0')).toBeInTheDocument()
    expect(within(ana).getByText('Aprovado')).toBeInTheDocument()
    expect(within(ana).getByText('B')).toBeInTheDocument()
    const bia = within(table).getByRole('rowheader', { name: /Bia/ }).closest('tr')
    // Mínima 5,0 do curso: 4,5 abaixo (vermelho/aviso), situação "Cursando" (etapa sem nota).
    expect(within(bia).getAllByText('4,5').some((el) => /text-(warning|danger)/.test(el.className))).toBe(true)
    expect(within(bia).getByText('Cursando')).toBeInTheDocument()
    expect(screen.getByText(/média mínima 5,0/)).toBeInTheDocument()
    expect(screen.getByText(/Quiz sem etapa: não entra na média\. Ajuste no Plano de avaliação\./)).toBeInTheDocument()
  })

  it('[UC-NOTAS-008] no celular, a lista de alunos abre as notas por etapa', async () => {
    const user = userEvent.setup()
    const onOpenStudent = vi.fn()
    render(<GradebookPanel courseId="DES" studentClass="1DES" gradebook={api(quadroComCriterios())} onOpenStudent={onOpenStudent} />)
    const list = screen.getByRole('list', { name: 'Alunos e notas' })
    expect(list.className).toMatch(/md:hidden/)
    expect(screen.getByRole('table').closest('div').className).toMatch(/\bhidden\b.*\bmd:block\b/)
    const ana = within(list).getByRole('button', { name: /Ana/ })
    expect(ana).toHaveAttribute('aria-expanded', 'false')
    await user.click(ana)
    expect(ana).toHaveAttribute('aria-expanded', 'true')
    const item = ana.closest('li')
    expect(within(item).getByText('1º bimestre · peso 1')).toBeInTheDocument()
    expect(within(item).getByText('Seminário')).toBeInTheDocument()
    expect(within(item).getByText('Frequência 95%')).toBeInTheDocument()
    await user.click(within(item).getByRole('button', { name: 'Ver as provas do aluno' }))
    expect(onOpenStudent).toHaveBeenCalledWith('ana@x.local')
  })

  it('[UC-NOTAS-008] sem critérios, o quadro de sempre (Média, sem etapas nem situação)', () => {
    const data = { columns: [{ id: 'P1', examKey: 'P1', label: 'Prova 1', moduleName: 'Módulo 1' }], rows: [{ email: 'ana@x.local', name: 'Ana', cells: { P1: { score: 70 } }, average: 7, averageScore: 70, gradedCount: 1, pendingCount: 0 }], etapas: [], avisos: [] }
    render(<GradebookPanel courseId="DES" studentClass="1DES" gradebook={api(data)} />)
    const table = screen.getByRole('table')
    expect(within(table).getByRole('columnheader', { name: 'Média' })).toBeInTheDocument()
    expect(within(table).queryByText('Situação')).not.toBeInTheDocument()
    expect(within(table).queryByText('Média da etapa')).not.toBeInTheDocument()
  })
})
