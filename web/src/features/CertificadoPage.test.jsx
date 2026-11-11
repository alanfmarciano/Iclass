import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fase 2, H6c (OPS-08): guia público /certificado. Abre sem login; a impressão digital
// vem do servidor (GET /api/connection/certificate) para comparar com a do computador.
const mocks = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../lib/api', () => ({ api: { get: mocks.get } }))

import CertificadoPage, { PLATFORM_STEPS } from './CertificadoPage'

const AVAILABLE = {
  available: true,
  fingerprintSha256: '12:34:56:78:9A:BC',
  validFrom: '2026-11-10T12:00:00.000Z',
  validTo: '2036-11-08T12:00:00.000Z',
  recreatedAt: null,
  httpsUrl: 'https://192.168.0.10:3000',
}

function renderPage() {
  return render(<MemoryRouter><CertificadoPage /></MemoryRouter>)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.get.mockResolvedValue(AVAILABLE)
})
afterEach(cleanup)

describe('[UC-REDE-004] guia /certificado', () => {
  it('mostra o download, a impressão digital, a validade e o endereço seguro, sem login', async () => {
    renderPage()
    expect(await screen.findByTestId('certificate-fingerprint')).toHaveTextContent('12:34:56:78:9A:BC')
    expect(mocks.get).toHaveBeenCalledWith('/api/connection/certificate', { auth: false })
    const download = screen.getByRole('link', { name: /Baixar certificado/ })
    expect(download).toHaveAttribute('href', '/iclass-ca.crt')
    expect(download).toHaveAttribute('download', 'iclass-ca.crt')
    expect(screen.getByText(/Válido até 08\/11\/2036/)).toBeInTheDocument()
    expect(screen.getByTestId('certificate-https-url')).toHaveAttribute('href', 'https://192.168.0.10:3000/login')
    expect(document.title).toBe('Conexão segura do IClass')
  })

  it('traz o passo a passo de Android, iPhone, Windows, Mac, Firefox e Chromebook', async () => {
    renderPage()
    await screen.findByTestId('certificate-fingerprint')
    for (const id of ['android', 'ios', 'windows', 'mac', 'firefox', 'chromebook']) {
      expect(screen.getByTestId(`platform-${id}`)).toBeInTheDocument()
    }
    expect(PLATFORM_STEPS.find((p) => p.id === 'ios').steps.join(' ')).toMatch(/Ajustes de Confiança de Certificado/)
    expect(PLATFORM_STEPS.find((p) => p.id === 'windows').steps.join(' ')).toMatch(/Autoridades de Certificação Raiz Confiáveis/)
  })

  it('sem a conexão segura neste IClass: explica e não oferece o download', async () => {
    mocks.get.mockResolvedValue({ available: false, error: 'Conexão segura indisponível: disco cheio: não foi possível gravar o certificado.' })
    renderPage()
    expect(await screen.findByTestId('certificate-unavailable')).toHaveTextContent('disco cheio')
    expect(screen.queryByRole('link', { name: /Baixar certificado/ })).toBeNull()
    expect(screen.queryByTestId('certificate-https-url')).toBeNull()
    expect(screen.getByTestId('platform-android')).toBeInTheDocument()
  })

  it('falha de rede mostra "Tentar de novo", que consulta outra vez', async () => {
    mocks.get.mockRejectedValueOnce(Object.assign(new Error('Sem conexão com o servidor.'), { status: 0 }))
    const user = userEvent.setup()
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('Sem conexão com o servidor.')
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    await waitFor(() => expect(screen.getByTestId('certificate-fingerprint')).toBeInTheDocument())
    expect(mocks.get).toHaveBeenCalledTimes(2)
  })
})
