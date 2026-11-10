import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { Modal } from './Modal'
import { TypedConfirm } from './TypedConfirm'

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

  // Regressão (H8a-1): com a confirmação digitada em autoFocus, o foco ia para o botão
  // Fechar no quadro seguinte e o que a pessoa digitava logo ao abrir se perdia.
  it('mantém o foco no campo com autoFocus e devolve o foco a quem abriu', async () => {
    function TypedHarness() {
      const [open, setOpen] = useState(false)
      const [value, setValue] = useState('')
      return <><button onClick={() => setOpen(true)}>Publicar</button><Modal open={open} onClose={() => setOpen(false)} title="Publicar"><TypedConfirm word="PUBLICAR" value={value} onChange={setValue} autoFocus /></Modal></>
    }
    const user = userEvent.setup()
    render(<TypedHarness />)
    const opener = screen.getByRole('button', { name: 'Publicar' })
    await user.click(opener)
    await new Promise(resolve => requestAnimationFrame(resolve))
    await new Promise(resolve => requestAnimationFrame(resolve))
    const input = screen.getByRole('textbox', { name: 'Digite PUBLICAR para confirmar' })
    expect(input).toHaveFocus()
    await user.keyboard('PUBLICAR')
    expect(input).toHaveValue('PUBLICAR')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })
});
