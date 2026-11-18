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
  it('[UC-NOTIF-001] trocar de turma consulta o sino da turma nova na hora e não mostra nem marca a contagem da anterior', async () => {
    const turmaA = { unread: 3, items: [{ id: 'nota:a', key: 'c1::A::nota:a', type: 'nota', title: 'Nota da turma A', unread: true }] }
    const turmaB = { unread: 1, items: [{ id: 'nota:b', key: 'c1::B::nota:b', type: 'nota', title: 'Nota da turma B', unread: true }] }
    let releaseB
    mocks.get.mockImplementation((url) => {
      if (url.includes('studentClass=A')) return Promise.resolve(turmaA)
      return new Promise((resolve) => { releaseB = () => resolve(turmaB) })
    })
    const bell = (cls) => <MemoryRouter><NotificationBell endpoint={`/api/student/notifications?courseId=c1&studentClass=${cls}`} seenEndpoint={`/api/student/notifications/seen?courseId=c1&studentClass=${cls}`} /></MemoryRouter>
    const view = render(bell('A'))
    expect(await screen.findByRole('button', { name: 'Notificações: 3 novas' })).toBeInTheDocument()
    view.rerender(bell('B'))
    // Antes, a consulta da turma B só saía no intervalo seguinte (30 s) e o sino seguia
    // com as 3 da turma A.
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/student/notifications?courseId=c1&studentClass=B', expect.anything()))
    expect(screen.getByRole('button', { name: 'Notificações' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Notificações' }))
    expect(screen.queryByText('Nota da turma A')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Marcar como lidas/ })).not.toBeInTheDocument()
    releaseB()
    expect(await screen.findByText('Nota da turma B')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Marcar como lidas/ }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalled())
    expect(mocks.post).toHaveBeenCalledWith('/api/student/notifications/seen?courseId=c1&studentClass=B', { keys: ['c1::B::nota:b'], ids: ['nota:b'] })
  })

  it('[UC-NOTIF-001] a resposta atrasada da turma anterior não sobrescreve a da turma nova', async () => {
    let releaseA
    mocks.get.mockImplementation((url) => {
      if (url.includes('studentClass=A')) return new Promise((resolve) => { releaseA = () => resolve({ unread: 5, items: [{ id: 'x', type: 'nota', title: 'Antiga', unread: true }] }) })
      return Promise.resolve({ unread: 1, items: [{ id: 'y', type: 'nota', title: 'Nova', unread: true }] })
    })
    const bell = (cls) => <MemoryRouter><NotificationBell endpoint={`/api/student/notifications?studentClass=${cls}`} seenEndpoint="/api/student/notifications/seen" /></MemoryRouter>
    const view = render(bell('A'))
    view.rerender(bell('B'))
    expect(await screen.findByRole('button', { name: 'Notificações: 1 nova' })).toBeInTheDocument()
    releaseA()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.getByRole('button', { name: 'Notificações: 1 nova' })).toBeInTheDocument()
  })

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

  it('[UC-NOTIF-001] no modo instituição o curso e a turma ficam em linha própria e a descrição continua visível', async () => {
    mocks.get.mockResolvedValue({
      unread: 1,
      items: [{
        id: 'sem_avaliacao@c1::1DES', key: 'c1::1DES::sem_avaliacao:2', type: 'sem_avaliacao', count: 2, unread: true,
        title: 'Alunos sem nenhuma avaliação', text: 'nunca entregaram prova neste curso · Resultados',
        context: 'Curso Técnico em TI (Legado) · 1DES',
      }],
    })
    render(<MemoryRouter><NotificationBell endpoint="/api/admin/notifications" seenEndpoint="/api/admin/notifications/seen" /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'Notificações: 1 nova' }))
    const context = screen.getByText('Curso Técnico em TI (Legado) · 1DES')
    const text = screen.getByText('nunca entregaram prova neste curso · Resultados')
    expect(context).not.toBe(text)
    expect(text.className).toContain('line-clamp-2')
    expect(text.className).not.toContain('truncate')
  })

  it('[UC-NOTIF-001] no celular o painel é deslocado para caber na tela (o sino não fica na borda)', async () => {
    const originalWidth = window.innerWidth
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 160, right: 200, top: 8, bottom: 48, width: 40, height: 40, x: 160, y: 8 })
    try {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
      render(<MemoryRouter><NotificationBell endpoint="/api/student/notifications" seenEndpoint="/api/student/notifications/seen" /></MemoryRouter>)
      fireEvent.click(await screen.findByRole('button', { name: 'Notificações: 2 novas' }))
      // Painel de 358px ancorado à direita do sino (x=200) começava em x=-158; agora começa em x=16.
      expect(screen.getByRole('dialog', { name: 'Notificações' }).style.right).toBe('-174px')
      cleanup()

      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
      rect.mockReturnValue({ left: 1160, right: 1200, top: 8, bottom: 48, width: 40, height: 40, x: 1160, y: 8 })
      render(<MemoryRouter><NotificationBell endpoint="/api/student/notifications" seenEndpoint="/api/student/notifications/seen" /></MemoryRouter>)
      fireEvent.click(await screen.findByRole('button', { name: 'Notificações: 2 novas' }))
      expect(screen.getByRole('dialog', { name: 'Notificações' }).style.right).toBe('0px')
    } finally {
      rect.mockRestore()
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
    }
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
