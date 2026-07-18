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
})
