import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationBell } from './NotificationBell'

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }))

const studentItems = {
  unread: 2,
  items: [
    { id: 'aviso:a1', type: 'aviso', title: 'Prova adiada', text: 'Nova data', unread: true, href: '/aluno/avisos' },
    { id: 'nota:s1', type: 'nota', title: 'Nota publicada', text: 'P1', unread: true, href: '/aluno/provas' },
  ],
}

beforeEach(() => {
  mocks.get.mockResolvedValue(studentItems)
  mocks.post.mockResolvedValue({ success: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Sino de notificações', () => {
  it('[UC-NOTIF-001] "Marcar como lidas" envia os ids (avisos) e as chaves por curso + turma do servidor', async () => {
    mocks.get.mockResolvedValue({
      unread: 1,
      items: [{ id: 'sem_avaliacao@c1::TURMA A', key: 'c1::TURMA A::sem_avaliacao:3', type: 'sem_avaliacao', title: 'Alunos sem avaliação', count: 3, unread: true }],
    })
    render(<MemoryRouter><NotificationBell endpoint="/api/admin/notifications" seenEndpoint="/api/admin/notifications/seen" /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'Notificações: 1 nova' }))
    fireEvent.click(screen.getByRole('button', { name: /Marcar como lidas/ }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalled())
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/notifications/seen', {
      keys: ['c1::TURMA A::sem_avaliacao:3'],
      ids: ['sem_avaliacao@c1::TURMA A'],
    })
  })

  it('[UC-NOTIF-001] abrir um item passa por onOpenItem e, se ele marcou como lido, o contador baixa na hora', async () => {
    const onOpenItem = vi.fn(async () => true)
    render(<MemoryRouter><NotificationBell endpoint="/api/student/notifications" seenEndpoint="/api/student/notifications/seen" onOpenItem={onOpenItem} /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'Notificações: 2 novas' }))
    fireEvent.click(screen.getByText('Prova adiada'))
    await waitFor(() => expect(onOpenItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'aviso:a1' })))
    expect(await screen.findByRole('button', { name: 'Notificações: 1 nova' })).toBeInTheDocument()
  })
})
