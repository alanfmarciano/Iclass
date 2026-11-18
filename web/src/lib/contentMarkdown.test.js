import { describe, expect, it } from 'vitest'
import { markdownToHtml } from './contentMarkdown'

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

  it('transforma o parágrafo com link de minigame num bloco próprio', () => {
    const html = markdownToHtml('Texto antes.\n\n👉 [Abrir o jogo](minigames/SREDS_1_cap1_servidor-dhcp.html)\n\nTexto depois.')
    expect(html).toContain('<div class="iclass-minigame">')
    expect(html).toContain('href="/minigames/SREDS_1_cap1_servidor-dhcp.html"')
    expect(html).not.toMatch(/<p>[^<]*<a href="\/minigames/)
    expect(html).toContain('<p>Texto antes.</p>')
  })

  it('não transforma links que não são minigames válidos', () => {
    const html = markdownToHtml('[outro](minigames/../segredo.html) [pagina](paginas/x.html)')
    expect(html).not.toContain('iclass-minigame')
  })

  it('mantém imagens em subpastas e SVG no caminho de imagens', () => {
    const html = markdownToHtml('![agenda](imagens/fecop/cap1/agenda.svg)')
    expect(html).toContain('src="/imagens/fecop/cap1/agenda.svg"')
  })
})

