import { describe, expect, it } from 'vitest'
import { htmlToMarkdown, markdownToHtml, stripFileAccess } from './contentMarkdown'

describe('markdownToHtml', () => {
  it('remove scripts, handlers e links javascript', () => {
    const html = markdownToHtml('<script>alert(1)</script><img src=x onerror=alert(2)> [clique](javascript:alert(3))')
    expect(html).not.toMatch(/<script|onerror|href=["']javascript:/i)
    expect(html).not.toContain('href=')
  })

  it('preserva links https e imagens locais seguras', () => {
    const html = markdownToHtml('[site](https://example.com) ![foto](uploads/foto.png)')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('src="/uploads/foto.png"')
  })
})

describe('sessão fora do Markdown salvo (UXA-X2)', () => {
  it('[UC-IMAGENS-001] stripFileAccess tira só o access= dos links de arquivo internos', () => {
    expect(stripFileAccess('/uploads/foto.png?access=sessao-do-prof')).toBe('/uploads/foto.png')
    expect(stripFileAccess('/imagens/fecop/cap1/x.svg?v=2&access=abc#topo')).toBe('/imagens/fecop/cap1/x.svg?v=2#topo')
    expect(stripFileAccess('https://example.com/a?access=1')).toBe('https://example.com/a?access=1')
  })

  it('[UC-IMAGENS-001] voltar do editor visual para Markdown não grava a sessão do instrutor', () => {
    localStorage.setItem('iclass-v3-auth', JSON.stringify({ adminSession: 'sessao-do-prof' }))
    try {
      const html = markdownToHtml('![foto](/uploads/foto.png)\n\n[apostila](/uploads/apostila.pdf) [topo](#topo)')
      expect(html).toContain('sessao-do-prof')
      const root = document.createElement('div')
      root.innerHTML = html
      const markdown = htmlToMarkdown(root)
      expect(markdown).not.toContain('sessao-do-prof')
      expect(markdown).toContain('![foto](/uploads/foto.png)')
      expect(markdown).toContain('[apostila](/uploads/apostila.pdf)')
      expect(markdown).toContain('[topo](#topo)')
    } finally {
      localStorage.removeItem('iclass-v3-auth')
    }
  })
})
