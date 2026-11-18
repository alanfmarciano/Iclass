import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from './ConfirmDialog'
import { ConfirmDialog as LegacyConfirmDialog } from './Modal'

afterEach(cleanup)

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function Harness({ onConfirm, ...props }) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <span data-testid="estado">{open ? 'aberto' : 'fechado'}</span>
      <ConfirmDialog open={open} onClose={() => setOpen(false)} title="Excluir o material?" message="O arquivo sai da biblioteca da turma."
        confirmLabel="Excluir" tone="danger" onConfirm={async (reason) => { await onConfirm(reason); setOpen(false) }} {...props} />
    </>
  )
}

// Fase 3, C0a (contrato C12 do P3): diálogo de confirmação da tela no lugar das caixas do
// navegador, com motivo, espera da ação e erro no próprio diálogo.
describe('[UC-CONFIRMACAO-001] ConfirmDialog', () => {
  it('mostra título, mensagem e botão no tom pedido; Cancelar fecha sem confirmar', () => {
    const onConfirm = vi.fn()
    render(<Harness onConfirm={onConfirm} />)
    const dialog = screen.getByRole('dialog', { name: 'Excluir o material?' })
    expect(dialog).toHaveTextContent('O arquivo sai da biblioteca da turma.')
    expect(screen.getByRole('button', { name: 'Excluir' }).className).toMatch(/bg-danger/)
    expect(screen.getByRole('button', { name: 'Cancelar' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByTestId('estado')).toHaveTextContent('fechado')
  })

  it('enquanto a ação roda, os botões travam, o clique duplo não repete e Esc não fecha', async () => {
    const pending = deferred()
    const onConfirm = vi.fn(() => pending.promise)
    render(<Harness onConfirm={onConfirm} />)
    const confirm = screen.getByRole('button', { name: 'Excluir' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(confirm).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeDisabled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByTestId('estado')).toHaveTextContent('aberto')
    await act(async () => { pending.resolve() })
    expect(screen.getByTestId('estado')).toHaveTextContent('fechado')
  })

  it('erro da ação aparece no diálogo, que continua aberto para tentar de novo', async () => {
    const onConfirm = vi.fn().mockRejectedValueOnce(new Error('Sem conexão com o servidor.')).mockResolvedValueOnce()
    render(<Harness onConfirm={onConfirm} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Excluir' })) })
    expect(screen.getByRole('alert')).toHaveTextContent('Sem conexão com o servidor.')
    expect(screen.getByTestId('estado')).toHaveTextContent('aberto')
    expect(screen.getByRole('button', { name: 'Excluir' })).not.toBeDisabled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Excluir' })) })
    expect(onConfirm).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('estado')).toHaveTextContent('fechado')
  })

  it('requireReason: só confirma com o motivo e o entrega aparado', async () => {
    const onConfirm = vi.fn().mockResolvedValue()
    render(<Harness onConfirm={onConfirm} requireReason reasonLabel="Motivo da anulação" />)
    const field = screen.getByLabelText('Motivo da anulação')
    expect(field).toHaveFocus()
    expect(field).toHaveAttribute('maxLength', '500')
    const confirm = screen.getByRole('button', { name: 'Excluir' })
    expect(confirm).toBeDisabled()
    fireEvent.change(field, { target: { value: '   ' } })
    expect(confirm).toBeDisabled()
    fireEvent.change(field, { target: { value: '  Cola comprovada  ' } })
    await act(async () => { fireEvent.click(confirm) })
    expect(onConfirm).toHaveBeenCalledWith('Cola comprovada')
  })

  it('askReason: motivo opcional; sem pedir motivo, onConfirm recebe undefined', async () => {
    const onConfirm = vi.fn().mockResolvedValue()
    const { unmount } = render(<Harness onConfirm={onConfirm} askReason tone="primary" confirmLabel="Encerrar" />)
    expect(screen.getByLabelText('Motivo (opcional)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Encerrar' }).className).toMatch(/bg-primary/)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Encerrar' })) })
    expect(onConfirm).toHaveBeenLastCalledWith('')
    unmount()
    render(<Harness onConfirm={onConfirm} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Excluir' })) })
    expect(onConfirm).toHaveBeenLastCalledWith(undefined)
  })

  it('confirmDisabled trava só o confirmar; Cancelar e Esc continuam fechando', () => {
    const onConfirm = vi.fn()
    render(<Harness onConfirm={onConfirm} confirmDisabled><input aria-label="Minutos" defaultValue="" autoFocus /></Harness>)
    expect(screen.getByLabelText('Minutos')).toHaveFocus()
    const confirm = screen.getByRole('button', { name: 'Excluir' })
    expect(confirm).toBeDisabled()
    fireEvent.click(confirm)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Cancelar' })).not.toBeDisabled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByTestId('estado')).toHaveTextContent('fechado')
  })

  it('texto do aluno na mensagem aparece como texto, nunca como HTML', () => {
    render(<Harness onConfirm={vi.fn()} message={'Excluir "<img src=x onerror=alert(1)>"?'} />)
    expect(screen.getByRole('dialog')).toHaveTextContent('Excluir "<img src=x onerror=alert(1)>"?')
    expect(document.querySelector('img')).toBeNull()
  })

  it('as chamadas antigas (Modal.jsx: danger, description, note) continuam com o mesmo texto', () => {
    const onConfirm = vi.fn()
    const { rerender } = render(<LegacyConfirmDialog open onClose={() => {}} onConfirm={onConfirm} danger title="Excluir aviso?" description="Deixa de aparecer para os alunos." confirmLabel="Excluir" />)
    expect(screen.getByRole('dialog', { name: 'Excluir aviso?' })).toHaveTextContent('Deixa de aparecer para os alunos.')
    expect(screen.getByText('Esta ação não pode ser desfeita.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Excluir' }).className).toMatch(/bg-danger/)
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    rerender(<LegacyConfirmDialog open onClose={() => {}} onConfirm={onConfirm} title="Enviar a prova?" confirmLabel="Enviar prova" />)
    expect(screen.getByText('Esta ação será aplicada imediatamente.')).toBeInTheDocument()
    rerender(<LegacyConfirmDialog open onClose={() => {}} onConfirm={onConfirm} danger note="Vai para a lixeira." title="Excluir?" />)
    expect(screen.getByText('Vai para a lixeira.')).toBeInTheDocument()
  })
})
