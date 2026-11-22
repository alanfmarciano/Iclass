import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { ConnectionStatus, connectionStatusFor } from './ConnectionStatus'
import { LumenShell } from './LumenShell'
import { getAdminNavGroups } from './Sidebar'
import { APP_VERSION, versionLabel } from '../../lib/appVersion'
import { reportFailure, reportResponse, resetConnectionForTests } from '../../lib/connection'
import rootPackage from '../../../../package.json'

vi.mock('../ui/ThemeToggle', () => ({ ThemeToggle: () => null }))

// Rodapé do menu (fase 3, A1 / P6-S2: ENG-10, OPS-02): a versão vem do package.json da raiz
// pelo define __ICLASS_VERSION__ do vite.config.js, e o estado é o da conexão com o
// servidor. Antes: "Sistema ativo" e "v3" fixos.
describe('[UC-VERSAO-004] versão e conexão no rodapé do menu', () => {
  afterEach(() => { cleanup(); resetConnectionForTests() })

  it('a versão do bundle é a do package.json da raiz (não "v3")', () => {
    expect(APP_VERSION).toBe(rootPackage.version)
    expect(versionLabel()).toBe(`v${rootPackage.version}`)
    expect(versionLabel('')).toBe('')
    render(<ConnectionStatus />)
    expect(screen.getByTestId('app-version')).toHaveTextContent(`v${rootPackage.version}`)
    expect(screen.queryByText('v3')).not.toBeInTheDocument()
    expect(screen.queryByText('Sistema ativo')).not.toBeInTheDocument()
  })

  it('mostra Conectado, Sem conexão e Servidor reiniciando pelo estado de lib/connection.js', () => {
    render(<ConnectionStatus />)
    expect(screen.getByText('Conectado')).toBeInTheDocument()
    act(() => { reportFailure(new TypeError('Failed to fetch')); reportFailure(new TypeError('Failed to fetch')) })
    expect(screen.getByText('Sem conexão')).toBeInTheDocument()
    act(() => { reportResponse(503, { starting: true }) })
    expect(screen.getByText('Servidor reiniciando')).toBeInTheDocument()
    act(() => { reportResponse(200, {}) })
    expect(screen.getByText('Conectado')).toBeInTheDocument()
    expect(connectionStatusFor('desconhecido').text).toBe('Conectado')
  })

  it('o menu completo do visual Lumen traz o mesmo rodapé e o item Ajuda', async () => {
    const groups = getAdminNavGroups({ accountRole: 'admin', activeWorkspace: null })
    render(
      <MemoryRouter>
        <LumenShell navGroups={groups} pathname="/" onLogout={() => {}}><p>conteúdo</p></LumenShell>
      </MemoryRouter>,
    )
    act(() => { screen.getByRole('button', { name: 'Abrir todos os módulos' }).click() })
    expect(screen.getByTestId('connection-status')).toHaveTextContent(`Conectado`)
    expect(screen.getByTestId('connection-status')).toHaveTextContent(`v${rootPackage.version}`)
    expect(screen.getByRole('link', { name: 'Ajuda' })).toHaveAttribute('href', '/ajuda')
  })

  it('o item Ajuda está nos dois menus do painel, para qualquer conta', () => {
    const paths = (auth) => getAdminNavGroups(auth).flatMap((group) => group.items.map((item) => item.to))
    expect(paths({ accountRole: 'admin', activeWorkspace: null })).toContain('/ajuda')
    expect(paths({ accountRole: 'professor', additionalPermissions: [], activeWorkspace: { courseId: 'c', className: '1A' } })).toContain('/ajuda')
  })
})
