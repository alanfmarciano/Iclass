import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BibliotecaPage, { embed } from './BibliotecaPage'

const mocks = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: vi.fn() } }))
vi.mock('./useStudent', () => ({ useStudent: () => ({ email: 'ana@x.local', studentClass: '1DES', courseId: 'DES' }) }))

// H5d (SEG-16): a CSP do IClass (frame-src) só deixa embutir o próprio IClass e os
// players do YouTube e do Vimeo. A prévia de PDF fica para o PDF enviado ao IClass; o PDF
// de link externo deixou de virar um iframe que o navegador recusaria (tela em branco) e
// abre pelo botão "Abrir em nova aba".
describe('Biblioteca do aluno · prévia compatível com a CSP', () => {
  it('[UC-SEC-002] YouTube e Vimeo continuam no player embutido', () => {
    expect(embed({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })).toEqual({ kind: 'iframe', src: 'https://www.youtube.com/embed/dQw4w9WgXcQ' })
    expect(embed({ url: 'https://vimeo.com/123456' })).toEqual({ kind: 'iframe', src: 'https://player.vimeo.com/video/123456' })
  })

  it('[UC-SEC-002] PDF enviado ao IClass tem prévia; PDF de outro site não vira iframe', () => {
    expect(embed({ type: 'pdf', url: '/uploads/apostila.pdf' })).toEqual({ kind: 'pdf', src: '/uploads/apostila.pdf?preview=1' })
    expect(embed({ type: 'pdf', url: '/uploads/apostila.pdf?access=abc' })).toEqual({ kind: 'pdf', src: '/uploads/apostila.pdf?access=abc&preview=1' })
    expect(embed({ type: 'pdf', url: `${window.location.origin}/uploads/a.pdf` }).kind).toBe('pdf')
    expect(embed({ type: 'pdf', url: 'https://outro-site.example/material.pdf' })).toEqual({ kind: 'none' })
    expect(embed({ url: 'http://192.168.0.50/material.pdf' })).toEqual({ kind: 'none' })
  })
})

// Fase 3, C16 (P5-S2): o resultado da Busca abre o material pelo endereço (?material=<id>).
describe('[UC-BUSCA-003] Biblioteca do aluno · material aberto pelo endereço', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks() })

  it('?material= abre o material; fechar tira o parâmetro (o voltar não reabre)', async () => {
    mocks.get.mockResolvedValue([
      { id: 'lib1', name: 'Guia do roteador', description: 'Passo a passo.', type: 'link', kind: 'link', url: 'https://exemplo.invalid/guia', tags: [], materia: 'Geral' },
      { id: 'lib2', name: 'Outro', description: '', type: 'link', kind: 'link', url: 'https://exemplo.invalid/outro', tags: [], materia: 'Geral' },
    ])
    function Probe() { const location = useLocation(); return <p data-testid="local">{location.search}</p> }
    render(
      <MemoryRouter initialEntries={['/aluno/biblioteca?material=lib1']}>
        <Routes><Route path="/aluno/biblioteca" element={<><BibliotecaPage /><Probe /></>} /></Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByRole('dialog', { name: 'Guia do roteador' })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('local').textContent).toBe('')
  })
})
