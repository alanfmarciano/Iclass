import { cleanup, render, screen } from '@testing-library/react'
import { Route, Routes, createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appRoutes } from './appRoutes'
import { clearRenderError, markRenderError, recentRenderError } from './lib/renderErrors'

function TelaQuebrada() {
  throw new Error('Cannot read properties of undefined (reading \'name\')')
}

// Como no App: as rotas de verdade ficam num <Routes> dentro do elemento raiz.
function AppDeTeste() {
  return (
    <Routes>
      <Route path="/aluno" element={<TelaQuebrada />} />
      <Route path="*" element={<p>Outra página</p>} />
    </Routes>
  )
}

afterEach(() => {
  cleanup()
  clearRenderError()
})

describe('[UC-PROVA-003] tela de erro do sistema (G4)', () => {
  it('erro de renderização mostra a tela de erro em português com o botão de recarregar, nunca a tela do roteador em inglês', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const router = createMemoryRouter(appRoutes(<AppDeTeste />), { initialEntries: ['/aluno'] })
      render(<RouterProvider router={router} />)
      expect(screen.getByRole('heading', { name: 'Algo deu errado nesta tela' })).toBeVisible()
      expect(screen.getByRole('button', { name: 'Recarregar a página' })).toBeVisible()
      expect(screen.getByText('Detalhes técnicos')).toBeInTheDocument()
      expect(screen.queryByText(/Unexpected Application Error/)).not.toBeInTheDocument()
      // A prova que desmontar logo depois sabe que foi erro de tela, não saída.
      expect(recentRenderError()?.message).toMatch(/Cannot read properties of undefined/)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('no build de produção o Monitor recebe só o código do erro do React, sem o endereço', () => {
    markRenderError(new Error('Minified React error #31; visit https://reactjs.org/docs/error-decoder.html?invariant=31 for the full message'))
    expect(recentRenderError().message).toBe('Minified React error #31')
  })
})
