import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 2, H6b (SEG-03): aviso fixo do painel aberto por http em outro aparelho. O
// administrador pode trocar a regra (Sistema → Rede) com o painel aberto: o aviso relê
// GET /api/connection quando a tela volta a ficar visível, sem recarregar a página.
const mocks = vi.hoisted(() => ({ connection: null, get: vi.fn() }))
vi.mock('../../lib/api', () => ({ api: { get: mocks.get } }))

import { InsecureConnectionNotice } from './InsecureConnectionNotice'

const OPEN_INSECURE = { secure: false, thisComputer: false, adminAccess: 'ok', adminAccessMode: 'rede-sem-https', insecureAdmin: true }
const THIS_COMPUTER = { secure: false, thisComputer: true, adminAccess: 'ok', adminAccessMode: 'rede-sem-https', insecureAdmin: false }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connection = OPEN_INSECURE
  mocks.get.mockImplementation(async (path) => (path === '/api/connection' ? mocks.connection : null))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('[UC-REDE-001] aviso de conexão sem proteção no painel', () => {
  it('aparece em outro aparelho por http, sem link de conexão segura, e é relido quando a tela volta', async () => {
    render(<InsecureConnectionNotice />)
    const notice = await screen.findByTestId('insecure-connection-notice')
    expect(notice).toHaveTextContent('Conexão sem proteção')
    expect(notice.querySelector('a')).toBeNull()
    expect(mocks.get).toHaveBeenCalledWith('/api/connection', { auth: false })

    mocks.connection = THIS_COMPUTER
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000)
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await waitFor(() => expect(screen.queryByTestId('insecure-connection-notice')).toBeNull())
  })

  it('falha de rede na nova consulta mantém o aviso que já estava', async () => {
    render(<InsecureConnectionNotice />)
    await screen.findByTestId('insecure-connection-notice')
    mocks.get.mockRejectedValue(Object.assign(new Error('Sem conexão com o servidor.'), { status: 0, network: true }))
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000)
    await act(async () => { window.dispatchEvent(new Event('online')) })
    expect(screen.getByTestId('insecure-connection-notice')).toBeInTheDocument()
  })

  it('com a resposta já dada pela tela, não consulta o servidor', async () => {
    render(<InsecureConnectionNotice connection={OPEN_INSECURE} />)
    expect(screen.getByTestId('insecure-connection-notice')).toBeInTheDocument()
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(mocks.get).not.toHaveBeenCalled()
  })
})

describe('[UC-REDE-005] link "Usar conexão segura" no aviso (H6c)', () => {
  it('com a conexão segura funcionando, o aviso leva ao guia /certificado', () => {
    render(<InsecureConnectionNotice connection={{ ...OPEN_INSECURE, tlsAvailable: true, httpsUrl: 'https://192.168.0.10:3000' }} />)
    const link = screen.getByTestId('use-secure-connection')
    expect(link).toHaveTextContent('Usar conexão segura')
    expect(link).toHaveAttribute('href', '/certificado')
  })

  it('com o certificado, mas sem endereço seguro para este aparelho (IP da rede fora do certificado), o aviso não traz o link', () => {
    render(<InsecureConnectionNotice connection={{ ...OPEN_INSECURE, tlsAvailable: true, httpsUrl: null }} />)
    expect(screen.getByTestId('insecure-connection-notice')).toBeInTheDocument()
    expect(screen.queryByTestId('use-secure-connection')).toBeNull()
  })

  it('sem a conexão segura neste IClass, o aviso não traz o link', () => {
    render(<InsecureConnectionNotice connection={{ ...OPEN_INSECURE, tlsAvailable: false, httpsUrl: null }} />)
    expect(screen.getByTestId('insecure-connection-notice')).toBeInTheDocument()
    expect(screen.queryByTestId('use-secure-connection')).toBeNull()
  })
})
