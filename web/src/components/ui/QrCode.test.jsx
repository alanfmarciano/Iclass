import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { QR_MARGIN, QrCode, qrPath } from './QrCode'

// Fase 2, H6a (OPS-10): o QR code do endereço da sala, desenhado da matriz do servidor.
afterEach(cleanup)

function countModules(d) {
  // Cada segmento é "M<x> <y>h<n>v1h-<n>z": soma as corridas.
  return [...d.matchAll(/h(\d+)v1h-\1z/g)].reduce((total, match) => total + Number(match[1]), 0)
}

describe('[UC-REDE-002] QrCode', () => {
  const rows = ['1110001', '1000101', '0011100', '1111111', '0000000', '1010101', '0110110']

  it('desenha um path só, com um módulo escuro para cada "1" e a margem de 4 módulos', () => {
    render(<QrCode rows={rows} url="http://192.168.0.10:3000" />)
    const svg = screen.getByRole('img', { name: 'QR code do endereço http://192.168.0.10:3000' })
    const paths = svg.querySelectorAll('path')
    expect(paths).toHaveLength(1)
    const dark = rows.join('').split('').filter((c) => c === '1').length
    expect(countModules(paths[0].getAttribute('d'))).toBe(dark)
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${rows.length + QR_MARGIN * 2} ${rows.length + QR_MARGIN * 2}`)
    // Preto sobre branco também no tema escuro.
    expect(paths[0].getAttribute('fill')).toBe('#000000')
    expect(svg.querySelector('rect').getAttribute('fill')).toBe('#ffffff')
  })

  it('a primeira corrida começa depois da margem', () => {
    expect(qrPath(['11'])).toBe(`M${QR_MARGIN} ${QR_MARGIN}h2v1h-2z`)
    expect(qrPath(['0101'])).toBe(`M${QR_MARGIN + 1} ${QR_MARGIN}h1v1h-1zM${QR_MARGIN + 3} ${QR_MARGIN}h1v1h-1z`)
  })

  it('sem matriz não desenha nada', () => {
    const { container } = render(<QrCode rows={null} url="x" />)
    expect(container.querySelector('svg')).toBeNull()
  })
})
