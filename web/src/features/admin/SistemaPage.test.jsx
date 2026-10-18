import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { BackupHistory } from './SistemaPage'

afterEach(() => cleanup())

describe('Sistema · histórico de backup', () => {
  it('[UC-BACKUP-001] mostra restaurações, falhas e cópias com quem fez e quando', () => {
    // Antes nenhuma tela mostrava os registros de restauração.
    const entries = [
      { id: 'a3', action: 'backup_server_created', actor: 'prof@x.local', timestamp: Date.parse('2026-10-18T12:00:00Z'), ip: '10.0.0.2', file: 'manual_2026-10-18.json' },
      { id: 'a2', action: 'backup_restored', actor: 'admin@x.local', timestamp: Date.parse('2026-10-18T11:00:00Z'), ip: '10.0.0.1', file: 'escola.json', format: 'json' },
      { id: 'a1', action: 'backup_restore_failed', actor: 'admin@x.local', timestamp: Date.parse('2026-10-18T10:00:00Z'), file: 'velho.json', error: 'Arquivo de backup inválido.' },
      { id: 'a0', action: 'backup_downloaded', actor: 'admin@x.local', timestamp: Date.parse('2026-10-18T09:00:00Z'), format: 'zip' },
    ]
    render(<BackupHistory entries={entries} />)
    const list = screen.getByRole('list', { name: 'Histórico de backup' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(4)
    expect(items[0]).toHaveTextContent('Cópia gerada no servidor')
    expect(items[0]).toHaveTextContent('prof@x.local')
    expect(items[1]).toHaveTextContent('Restauração concluída')
    expect(items[1]).toHaveTextContent('escola.json')
    expect(items[2]).toHaveTextContent('Restauração com falha')
    expect(items[2]).toHaveTextContent('Arquivo de backup inválido.')
    expect(within(items[2]).getByText('Falhou')).toBeInTheDocument()
    expect(items[3]).toHaveTextContent('Backup baixado (ZIP)')
  })

  it('[UC-BACKUP-001] sem registros avisa que ainda não há histórico', () => {
    render(<BackupHistory entries={[]} />)
    expect(screen.getByText('Nenhum registro ainda.')).toBeInTheDocument()
  })
})
