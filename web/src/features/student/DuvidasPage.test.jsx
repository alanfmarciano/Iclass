import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 2, H2-C (DES-09): a resposta que chega depois de trocar de curso ou turma não
// vale mais (antes, a consulta lenta da turma anterior voltava por cima da nova).
const apiGet = vi.hoisted(() => vi.fn())
const student = vi.hoisted(() => ({ current: { email: 'ana@escola.local', name: 'Ana', courseId: 'curso-a', studentClass: 'A' } }))
vi.mock('../../lib/api', () => ({ api: { get: apiGet, post: vi.fn().mockResolvedValue({}) } }))
vi.mock('./useStudent', () => ({ useStudent: () => student.current }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }))

import DuvidasPage from './DuvidasPage'

const comment = (id, text) => ({ id, key: 'geral', unitTitle: 'Dúvida geral', text, status: 'aberta', replies: [], timestamp: '2026-11-10T10:00:00.000Z' })

beforeEach(() => {
  apiGet.mockReset()
  student.current = { email: 'ana@escola.local', name: 'Ana', courseId: 'curso-a', studentClass: 'A' }
})

afterEach(() => cleanup())

describe('[UC-DESEMPENHO-002] Dúvidas do aluno: troca de turma no meio da consulta', () => {
  it('a resposta atrasada da turma anterior não substitui as dúvidas da turma nova', async () => {
    let releaseA
    apiGet.mockImplementation((url) => {
      if (url.includes('studentClass=A')) return new Promise((resolve) => { releaseA = () => resolve({ comments: [comment('a1', 'Dúvida da turma A')] }) })
      return Promise.resolve({ comments: [comment('b1', 'Dúvida da turma B')] })
    })
    const view = render(<DuvidasPage />)
    student.current = { ...student.current, courseId: 'curso-b', studentClass: 'B' }
    view.rerender(<DuvidasPage />)
    expect(await screen.findByText('Dúvida da turma B')).toBeInTheDocument()
    await act(async () => { releaseA() })
    await act(async () => {})
    expect(screen.queryByText('Dúvida da turma A')).not.toBeInTheDocument()
    expect(screen.getByText('Dúvida da turma B')).toBeInTheDocument()
  })
})

describe('[UC-CADERNO-001] Dúvidas do aluno: teto de 5.000 caracteres', () => {
  it('o campo da dúvida tem maxLength 5.000 e mostra a contagem a partir de 4.500', async () => {
    apiGet.mockResolvedValue({ comments: [], topics: [{ key: 'geral', title: 'Dúvida geral', module: '' }] })
    const { container } = render(<DuvidasPage />)
    const field = container.querySelector('#q')
    expect(field.getAttribute('maxLength')).toBe('5000')
    fireEvent.change(field, { target: { value: 'd'.repeat(4500) } })
    expect(screen.getByText('4.500 de 5.000 caracteres')).toBeInTheDocument()
  })
})
