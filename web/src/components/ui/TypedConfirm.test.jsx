import { useState } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TypedConfirm, typedConfirmMatches } from './TypedConfirm'

afterEach(cleanup)

function Harness({ word = 'APAGAR', onConfirm, disabled = false, description }) {
  const [value, setValue] = useState('')
  return (
    <>
      <TypedConfirm word={word} value={value} onChange={setValue} onConfirm={onConfirm} disabled={disabled} description={description} />
      <button disabled={!typedConfirmMatches(value, word)}>Apagar de vez</button>
    </>
  )
}

describe('TypedConfirm', () => {
  it('[UC-MANUT-001] compara como o servidor: sem espaços nas pontas e sem diferenciar maiúsculas', () => {
    expect(typedConfirmMatches('RESETAR', 'RESETAR')).toBe(true)
    expect(typedConfirmMatches('  resetar ', 'RESETAR')).toBe(true)
    expect(typedConfirmMatches('RESETA', 'RESETAR')).toBe(false)
    expect(typedConfirmMatches('RESETAR!', 'RESETAR')).toBe(false)
    expect(typedConfirmMatches('', 'RESETAR')).toBe(false)
    expect(typedConfirmMatches(undefined, 'RESETAR')).toBe(false)
    // Sem palavra definida nada libera (nem o campo vazio).
    expect(typedConfirmMatches('', '')).toBe(false)
    expect(typedConfirmMatches('x', undefined)).toBe(false)
  })

  it('[UC-MANUT-001] pede a palavra pelo rótulo do campo e só libera a ação com ela', async () => {
    const user = userEvent.setup()
    render(<Harness description="O cadastro sai de vez, sem volta." />)
    const field = screen.getByLabelText('Digite APAGAR para confirmar')
    expect(field).toHaveAttribute('placeholder', 'APAGAR')
    expect(field).toHaveAttribute('autocomplete', 'off')
    expect(field).toHaveAccessibleDescription('O cadastro sai de vez, sem volta.')
    expect(screen.getByText('APAGAR', { selector: 'b' })).toBeVisible()
    const action = screen.getByRole('button', { name: 'Apagar de vez' })
    expect(action).toBeDisabled()
    await user.type(field, 'apaga')
    expect(action).toBeDisabled()
    await user.type(field, 'r')
    expect(action).toBeEnabled()
  })

  it('[UC-MANUT-001] Enter confirma só com a palavra certa e nunca com o campo desligado', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<Harness onConfirm={onConfirm} />)
    const field = screen.getByLabelText('Digite APAGAR para confirmar')
    await user.type(field, 'APAGA{Enter}')
    expect(onConfirm).not.toHaveBeenCalled()
    await user.type(field, 'R{Enter}')
    expect(onConfirm).toHaveBeenCalledTimes(1)
    cleanup()

    const blocked = vi.fn()
    render(<Harness onConfirm={blocked} disabled />)
    expect(screen.getByLabelText('Digite APAGAR para confirmar')).toBeDisabled()
    expect(blocked).not.toHaveBeenCalled()
  })
})
