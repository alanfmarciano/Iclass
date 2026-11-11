import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Input } from './Input'

// Campo de uma linha com teto e contagem, como o Textarea (decisões §12, sobra do H9b:
// o Tema da prova e a Categoria do banco de questões aceitam até 500 caracteres).
describe('Input · maxLength e contagem', () => {
  afterEach(() => cleanup())

  it('sem counterFrom só aplica o teto', () => {
    render(<Input label="Tema" value="abc" maxLength={500} onChange={() => {}} />)
    expect(screen.getByLabelText('Tema')).toHaveAttribute('maxLength', '500')
    expect(screen.queryByText(/caracteres/)).toBeNull()
  })

  it('a partir de counterFrom mostra "N de M caracteres" ligado ao campo', () => {
    render(<Input label="Tema" value={'t'.repeat(460)} maxLength={500} counterFrom={450} onChange={() => {}} />)
    const counter = screen.getByText('460 de 500 caracteres')
    expect(screen.getByLabelText('Tema').getAttribute('aria-describedby')).toContain(counter.id)
  })

  it('abaixo de counterFrom, sem contagem', () => {
    render(<Input label="Tema" value={'t'.repeat(10)} maxLength={500} counterFrom={450} onChange={() => {}} />)
    expect(screen.queryByText(/de 500 caracteres/)).toBeNull()
  })
})
