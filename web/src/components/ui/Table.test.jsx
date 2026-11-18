import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { compareTableValues, DataTable } from './Table'

afterEach(cleanup)

const columns = [{ key: 'name', label: 'Nome' }, { key: 'turma', label: 'Turma' }, { key: 'faltas', label: 'Faltas' }]
const rows = [
  { id: 1, name: 'Zélia', turma: 'Turma 10', faltas: 2 },
  { id: 2, name: 'Bruno', turma: 'Turma 2', faltas: 10 },
  { id: 3, name: 'ana', turma: 'Turma 1', faltas: 0 },
  { id: 4, name: 'Érica', faltas: 1 },
  { id: 5, name: 'Ângela', turma: 'Turma 3', faltas: null },
  { id: 6, name: 'João Carlos', turma: 'Turma 2', faltas: 3 },
]

function names() {
  return screen.getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[0].textContent)
}

// Fase 3, C0a (CRIT-07): a tabela padrão buscava com toLowerCase().includes (sem tirar o
// acento, e campo ausente virava 'undefined') e ordenava pelo código Unicode
// ("Bruno, Carlos, Zélia, ana, Ângela, Érica").
describe('[UC-BUSCA-001] DataTable: busca sem acento e ordem pt-BR', () => {
  it('"joao" acha "João Carlos" e a busca vale por palavras em colunas diferentes', () => {
    render(<DataTable columns={columns} rows={rows} searchKeys={['name', 'turma']} />)
    const search = screen.getByRole('textbox', { name: 'Buscar' })
    fireEvent.change(search, { target: { value: 'joao' } })
    expect(names()).toEqual(['João Carlos'])
    fireEvent.change(search, { target: { value: 'ANGELA' } })
    expect(names()).toEqual(['Ângela'])
    fireEvent.change(search, { target: { value: 'carlos turma 2' } })
    expect(names()).toEqual(['João Carlos'])
  })

  it('valor ausente não casa com "und" nem com "null"', () => {
    render(<DataTable columns={columns} rows={rows} searchKeys={['turma']} />)
    const search = screen.getByRole('textbox', { name: 'Buscar' })
    fireEvent.change(search, { target: { value: 'und' } })
    expect(screen.queryAllByRole('row').slice(1)).toHaveLength(0)
    expect(screen.getByText('Nenhum registro')).toBeInTheDocument()
    fireEvent.change(search, { target: { value: 'null' } })
    expect(screen.queryAllByRole('row').slice(1)).toHaveLength(0)
  })

  it('ordena como no português nas duas direções, com números pelo valor e vazios no fim', () => {
    render(<DataTable columns={columns} rows={rows} />)
    fireEvent.click(screen.getByRole('button', { name: /Nome/ }))
    expect(names()).toEqual(['ana', 'Ângela', 'Bruno', 'Érica', 'João Carlos', 'Zélia'])
    fireEvent.click(screen.getByRole('button', { name: /Nome/ }))
    expect(names()).toEqual(['Zélia', 'João Carlos', 'Érica', 'Bruno', 'Ângela', 'ana'])
    fireEvent.click(screen.getByRole('button', { name: /Turma/ }))
    // "Turma 2" antes de "Turma 10"; a linha sem turma fica no fim; empate mantém a ordem recebida.
    expect(names()).toEqual(['ana', 'Bruno', 'João Carlos', 'Ângela', 'Zélia', 'Érica'])
    fireEvent.click(screen.getByRole('button', { name: /Turma/ }))
    expect(names()).toEqual(['Zélia', 'Ângela', 'Bruno', 'João Carlos', 'ana', 'Érica'])
    fireEvent.click(screen.getByRole('button', { name: /Faltas/ }))
    expect(names()).toEqual(['ana', 'Érica', 'Zélia', 'João Carlos', 'Bruno', 'Ângela'])
  })

  it('compareTableValues: número com número, texto pt-BR, vazio no fim nas duas direções', () => {
    expect(compareTableValues(2, 10)).toBeLessThan(0)
    expect(compareTableValues(2, 10, -1)).toBeGreaterThan(0)
    expect(compareTableValues('', 'a')).toBeGreaterThan(0)
    expect(compareTableValues('', 'a', -1)).toBeGreaterThan(0)
    expect(compareTableValues(undefined, null)).toBe(0)
    expect(compareTableValues('Érica', 'Eduardo')).toBeGreaterThan(0)
  })
})
