import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { StudentAuditPanel } from './StudentAuditPanel'

afterEach(() => cleanup())

const presenca = (id, date, label, extra = {}) => ({
  id, action: label === 'Presença alterada' ? 'attendance_changed' : 'attendance_marked', category: 'attendance', label,
  field: `Presença em ${date}`, oldValue: 'Presente (2 aulas)', newValue: 'Falta (2 aulas)', actor: 'prof@x.local', timestamp: 1_800_000_000_000, ...extra,
})

describe('Auditoria da ficha do aluno', () => {
  it('[UC-PRESENCA-004] presença filtra pelo tipo de ação (não uma opção por dia) e o título mostra a data', () => {
    const rows = [
      presenca('a1', '02/03/2026', 'Presença alterada'),
      presenca('a2', '03/03/2026', 'Presença alterada'),
      presenca('a3', '04/03/2026', 'Presença marcada manualmente'),
      { id: 's1', action: 'update', category: 'student', label: 'Cadastro do aluno alterado', field: 'Telefone', oldValue: '1', newValue: '2', actor: 'admin@x.local', timestamp: 1_800_000_000_000 },
    ]
    render(<StudentAuditPanel rows={rows} />)
    const select = screen.getByLabelText('Tipo de alteração')
    const options = within(select).getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['Todas as categorias', 'Presença alterada', 'Presença marcada manualmente', 'Telefone'])
    expect(screen.getByText('Presença em 02/03/2026 · Presença alterada')).toBeInTheDocument()
    fireEvent.change(select, { target: { value: 'Presença alterada' } })
    expect(screen.getByText('2 de 4 registro(s)')).toBeInTheDocument()
    expect(screen.queryByText('Presença em 04/03/2026 · Presença marcada manualmente')).not.toBeInTheDocument()
    expect(screen.getByText('Presença em 03/03/2026 · Presença alterada')).toBeInTheDocument()
  })
})
