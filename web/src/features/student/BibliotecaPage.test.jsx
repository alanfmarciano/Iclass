import { describe, expect, it } from 'vitest'
import { embed } from './BibliotecaPage'

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
