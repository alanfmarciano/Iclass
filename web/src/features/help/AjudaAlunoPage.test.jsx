import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import AjudaAlunoPage from './AjudaAlunoPage'

const mocks = vi.hoisted(() => ({ auth: {} }))
vi.mock('../../context/AuthProvider', () => ({ useAuth: () => ({ auth: mocks.auth }) }))

function renderAt(entry) {
  return render(<MemoryRouter initialEntries={[entry]}><AjudaAlunoPage /></MemoryRouter>)
}

// Ajuda do aluno, /ajuda/aluno (fase 3, A1 / P6-S9: OPS-13): abre sem login, com os temas
// de quem não consegue entrar, cada um recolhível.
describe('[UC-AJUDA-001] ajuda do aluno', () => {
  afterEach(() => { cleanup(); mocks.auth = {} })

  it('abre sem login, com os temas de entrar recolhidos e o link de volta para a entrada', async () => {
    renderAt('/ajuda/aluno')
    expect(await screen.findByRole('heading', { level: 1, name: 'Ajuda para o aluno' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Voltar para a entrada' })).toHaveAttribute('href', '/login')
    // O título aparece antes do texto chegar (import sob demanda): espera os temas.
    await screen.findByText('Esqueci a senha', { selector: 'summary span' }, { timeout: 5000 })
    ;['Como achar o endereço do IClass', 'Esqueci a senha', 'Troca de senha obrigatória', 'A prova travou ou a conexão caiu'].forEach((name) => {
      expect(screen.getByText(name, { selector: 'summary span' })).toBeInTheDocument()
    })
    // Tema ainda sem texto não aparece.
    expect(screen.queryByText('Atividades', { selector: 'summary span' })).not.toBeInTheDocument()
    const details = document.getElementById('esqueci-a-senha')
    expect(details.open).toBe(false)
    await userEvent.setup().click(screen.getByText('Esqueci a senha', { selector: 'summary span' }))
    await waitFor(() => expect(document.getElementById('esqueci-a-senha').open).toBe(true))
    expect(screen.getByText(/Solicitar nova senha/)).toBeInTheDocument()
    expect(document.title).toBe('Ajuda para o aluno')
  })

  it('a âncora abre o tema certo; aluno logado volta ao portal', async () => {
    mocks.auth = { role: 'student' }
    renderAt('/ajuda/aluno#prova-e-conexao')
    await screen.findByRole('heading', { level: 1, name: 'Ajuda para o aluno' })
    await waitFor(() => expect(document.getElementById('prova-e-conexao')?.open).toBe(true), { timeout: 5000 })
    expect(document.getElementById('endereco').open).toBe(false)
    expect(screen.getByRole('link', { name: 'Voltar ao portal' })).toHaveAttribute('href', '/aluno')
  })
})
