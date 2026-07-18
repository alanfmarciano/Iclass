import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { Modal } from './Modal'

afterEach(cleanup)

function Harness() {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  return <><button onClick={() => setOpen(true)}>Abrir</button><Modal open={open} onClose={() => setOpen(false)} title="Teste"><label>Nome<input value={value} onChange={event => setValue(event.target.value)} /></label><button>Último</button></Modal></>
}

describe('Modal', () => {
  it('fecha com Escape e restaura o foco', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Abrir' })
    await user.click(opener)
    expect(await screen.findByRole('dialog')).toBeVisible()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })

  it('mantém o foco do campo enquanto o formulário controlado atualiza', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Abrir' }))
    const input = screen.getByRole('textbox', { name: 'Nome' })
    await user.click(input)
    await user.type(input, '2DES')
    expect(input).toHaveValue('2DES')
    expect(input).toHaveFocus()
  })
});
