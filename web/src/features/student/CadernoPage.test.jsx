import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 2, H9b (ENG-03): o caderno tem o mesmo teto do servidor (50.000 caracteres por
// unidade) e mostra a contagem a partir de 45.000. Antes não havia limite nenhum e o
// aluno gravava notas de 9 MB que pesavam a sala inteira.
const apiPost = vi.hoisted(() => vi.fn())
vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: apiPost } }))
vi.mock('./useStudent', () => ({ useStudent: () => ({ email: 'ana@escola.local', name: 'Ana' }) }))
vi.mock('../../context/ToastProvider', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }))

import CadernoPage from './CadernoPage'
import { Textarea, formatCharCount } from '../../components/ui/Textarea'

beforeEach(() => apiPost.mockReset())
afterEach(() => cleanup())

describe('[UC-CADERNO-001] Caderno do aluno: teto de 50.000 caracteres e contagem', () => {
  it('o campo tem maxLength 50.000 e a contagem só aparece a partir de 45.000', async () => {
    apiPost.mockResolvedValue({ note: 'curta' })
    const { container } = render(<CadernoPage />)
    const field = container.querySelector('#nb')
    await waitFor(() => expect(field.value).toBe('curta'))
    expect(field.getAttribute('maxLength')).toBe('50000')
    expect(screen.queryByText(/caracteres$/)).not.toBeInTheDocument()

    fireEvent.change(field, { target: { value: 'a'.repeat(45000) } })
    expect(screen.getByText('45.000 de 50.000 caracteres')).toBeInTheDocument()
    expect(field.getAttribute('aria-describedby')).toBe('nb-counter')
  })

  it('nota antiga maior que o teto aparece inteira, com a contagem em destaque', async () => {
    apiPost.mockResolvedValue({ note: 'b'.repeat(60000) })
    const { container } = render(<CadernoPage />)
    await waitFor(() => expect(container.querySelector('#nb').value.length).toBe(60000))
    expect(screen.getByText('60.000 de 50.000 caracteres')).toHaveClass('text-warning')
  })

  it('Textarea sem counterFrom só aplica o teto; formatCharCount usa o milhar com ponto', () => {
    const { container } = render(<Textarea id="x" value={'c'.repeat(4999)} maxLength={5000} onChange={() => {}} />)
    expect(container.querySelector('#x').getAttribute('maxLength')).toBe('5000')
    expect(screen.queryByText(/caracteres$/)).not.toBeInTheDocument()
    expect(formatCharCount(1000000)).toBe('1.000.000')
    expect(formatCharCount(999)).toBe('999')
  })
})
