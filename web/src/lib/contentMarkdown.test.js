import { describe, expect, it } from 'vitest'
import { htmlToMarkdown, markdownToHtml, shiftHeadingLevels, stripFileAccess } from './contentMarkdown'

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

// Fase 3, C9 ajuste 2: as instruções da atividade do aluno ficam debaixo do <h1> da página;
// um '# Parte 1' virava um segundo <h1>.
describe('shiftHeadingLevels', () => {
  it('desce os títulos em offset níveis (até h6), com a classe do nível de antes e os atributos', () => {
    const html = shiftHeadingLevels(markdownToHtml('# Parte 1\n\n## Passo\n\n###### Nota\n\nTexto com <h1> escrito.'), 2)
    const doc = new DOMParser().parseFromString(`<main>${html}</main>`, 'text/html')
    expect(doc.querySelectorAll('h1, h2')).toHaveLength(0)
    expect(doc.querySelector('h3').textContent).toBe('Parte 1')
    expect(doc.querySelector('h3').className).toBe('prose-nivel-1')
    expect(doc.querySelector('h4').textContent).toBe('Passo')
    expect(doc.querySelectorAll('h6')).toHaveLength(1)
    expect(doc.querySelector('h6').className).toBe('prose-nivel-6')
  })

  it('sem título ou com offset 0 devolve o mesmo HTML', () => {
    expect(shiftHeadingLevels('<p>oi</p>', 2)).toBe('<p>oi</p>')
    expect(shiftHeadingLevels('<h1>Oi</h1>', 0)).toBe('<h1>Oi</h1>')
    expect(shiftHeadingLevels('', 2)).toBe('')
  })
})
