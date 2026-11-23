import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CalendarioPage, { eventActivityHref } from './CalendarioPage'

// Fase 3, C9 (P1-g; D16 do P1): o prazo de uma atividade no Calendário do aluno leva à
// atividade, onde ele envia.
const mocks = vi.hoisted(() => ({ events: [] }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: { email: 'ana@x.local', activeClass: { name: '1DES', courseId: 'DES' } } }) }))
vi.mock('../../hooks/useApi', () => ({ useApi: () => ({ data: mocks.events, loading: false, error: null, refetch: vi.fn() }) }))

afterEach(() => { cleanup() })

describe('calendário do aluno · prazo de atividade', () => {
  it('só o endereço da própria tela de atividades vira link', () => {
    expect(eventActivityHref({ href: '/aluno/atividades/asg_1' })).toBe('/aluno/atividades/asg_1')
    expect(eventActivityHref({ href: 'https://outro.site/aluno/atividades/x' })).toBe('')
    expect(eventActivityHref({ href: '/aluno/atividades/x/../../admin' })).toBe('')
    expect(eventActivityHref({ href: 'javascript:alert(1)' })).toBe('')
    expect(eventActivityHref({})).toBe('')
  })

  it('o detalhe do prazo tem "Abrir a atividade"', () => {
    const today = new Date()
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    mocks.events = [{ id: 'tarefa:asg_1', title: 'Relatório de redes', eventType: 'entrega', eventDate: date, startTime: '23:00', target: 'turma', targetValue: '1DES', description: 'Prazo de entrega da tarefa às 23:00.', href: '/aluno/atividades/asg_1' }]
    render(<MemoryRouter><CalendarioPage /></MemoryRouter>)
    fireEvent.click(screen.getAllByText('Relatório de redes').at(-1))
    expect(screen.getByRole('link', { name: 'Abrir a atividade' })).toHaveAttribute('href', '/aluno/atividades/asg_1')
  })
})
