import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { LumenShell } from './LumenShell'
import { getAdminNavGroups } from './Sidebar'

vi.mock('../ui/ThemeToggle', () => ({ ThemeToggle: () => null }))

// Fase 3, C14 (P5-S7b; FUN-14), revisão da rodada 2: no modo instituição o professor tem só
// 4 itens no menu, e "Mensagens" fica na barra de cima e na de baixo do Lumen. Essas barras
// não desenhavam o número, e o ponto do "Mais" só soma os itens escondidos: o professor não
// via que tinha mensagem nova sem abrir o menu completo.
function renderShell(auth, newMessages) {
  const groups = getAdminNavGroups(auth, 0, newMessages)
  return render(
    <MemoryRouter>
      <LumenShell navGroups={groups} pathname="/" onLogout={() => {}}><p>conteúdo</p></LumenShell>
    </MemoryRouter>,
  )
}

const professorSemTurma = { accountRole: 'professor', additionalPermissions: [], activeWorkspace: null }

describe('[UC-MENSAGEM-006] visual Lumen · número de Mensagens nas barras', () => {
  afterEach(() => cleanup())

  it('professor sem turma: Mensagens está nas barras de cima e de baixo com o número', () => {
    renderShell(professorSemTurma, 1)
    const top = screen.getByRole('navigation', { name: 'Navegação principal' })
    const bottom = screen.getByRole('navigation', { name: 'Navegação móvel' })
    for (const nav of [top, bottom]) {
      const link = within(nav).getAllByRole('link').find((item) => item.getAttribute('href') === '/mensagens')
      expect(link).toBeTruthy()
      expect(link).toHaveTextContent('1, 1 conversa com mensagem nova')
    }
    // Nada escondido no menu completo: o "Mais" fica sem o ponto.
    expect(screen.getByRole('button', { name: 'Abrir todos os módulos' })).toBeInTheDocument()
  })

  it('sem mensagem nova, as barras mostram só o nome; com mais de 99, "99+"', () => {
    renderShell(professorSemTurma, 0)
    const top = screen.getByRole('navigation', { name: 'Navegação principal' })
    const link = within(top).getAllByRole('link').find((item) => item.getAttribute('href') === '/mensagens')
    expect(link).toHaveTextContent(/^Mensagens$/)
    cleanup()
    renderShell(professorSemTurma, 120)
    const bottom = screen.getByRole('navigation', { name: 'Navegação móvel' })
    const many = within(bottom).getAllByRole('link').find((item) => item.getAttribute('href') === '/mensagens')
    expect(many).toHaveTextContent('99+')
    expect(many).toHaveTextContent('120 conversas com mensagem nova')
  })

  it('administrador: Mensagens fica no menu completo e o "Mais" ganha o ponto, como antes', () => {
    renderShell({ accountRole: 'admin', activeWorkspace: null }, 2)
    const bottom = screen.getByRole('navigation', { name: 'Navegação móvel' })
    expect(within(bottom).getAllByRole('link').some((item) => item.getAttribute('href') === '/mensagens')).toBe(false)
    expect(screen.getByRole('button', { name: 'Mais (há novidades no menu)' })).toBeInTheDocument()
  })
})
