import { describe, expect, it, vi } from 'vitest'
import { markdownToHtml } from './contentMarkdown'
import { MINIGAME_CSP, minigameNameFromHref, mountMinigames, withMinigameCsp } from './minigames'

function renderArticle(markdown) {
  const article = document.createElement('article')
  article.innerHTML = markdownToHtml(markdown)
  document.body.replaceChildren(article)
  return article
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('minigameNameFromHref', () => {
  it('aceita só nomes simples terminados em .html', () => {
    expect(minigameNameFromHref('/minigames/SREDS_1_cap1_servidor-dhcp.html')).toBe('SREDS_1_cap1_servidor-dhcp.html')
    expect(minigameNameFromHref('/minigames/../x.html')).toBeNull()
    expect(minigameNameFromHref('/minigames/sub/x.html')).toBeNull()
    expect(minigameNameFromHref('/minigames/x.js')).toBeNull()
    expect(minigameNameFromHref('https://exemplo.com/minigames/x.html')).toBeNull()
  })
})

describe('withMinigameCsp', () => {
  it('coloca a CSP logo no começo do head', () => {
    const html = withMinigameCsp('<!doctype html><html><head><title>J</title></head><body></body></html>')
    expect(html).toContain(`<head><meta http-equiv="Content-Security-Policy" content="${MINIGAME_CSP}"><title>`)
  })

  it('cria o head quando o jogo não tem um', () => {
    expect(withMinigameCsp('<p>oi</p>')).toMatch(/^<!doctype html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"/)
  })
})

describe('mountMinigames', () => {
  it('monta o jogo num iframe isolado só quando o aluno pede', async () => {
    const article = renderArticle('[Servidor DHCP por um turno](minigames/jogo.html)')
    const loader = vi.fn().mockResolvedValue('<html><head></head><body>jogo</body></html>')
    expect(mountMinigames(article, loader)).toEqual(['jogo.html'])
    expect(article.querySelector('iframe')).toBeNull()
    expect(article.querySelector('.iclass-minigame-title').textContent).toBe('Servidor DHCP por um turno')

    article.querySelector('.iclass-minigame-btn').click()
    await flush()
    expect(loader).toHaveBeenCalledWith('jogo.html')
    const frame = article.querySelector('iframe')
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('srcdoc')).toContain('Content-Security-Policy')
    expect(frame.getAttribute('src')).toBeNull()
  })

  it('não monta duas vezes o mesmo bloco', () => {
    const article = renderArticle('[Jogo](minigames/jogo.html)')
    mountMinigames(article, vi.fn())
    expect(mountMinigames(article, vi.fn())).toEqual([])
    expect(article.querySelectorAll('.iclass-minigame-bar')).toHaveLength(1)
  })

  it('avisa quando o minigame não está no IClass', async () => {
    const article = renderArticle('[Jogo](minigames/sumiu.html)')
    const error = Object.assign(new Error('Minigame não encontrado.'), { status: 404 })
    mountMinigames(article, vi.fn().mockRejectedValue(error))
    article.querySelector('.iclass-minigame-btn').click()
    await flush()
    expect(article.querySelector('iframe')).toBeNull()
    expect(article.querySelector('.iclass-minigame-status').textContent).toBe('Este minigame ainda não está no IClass.')
  })
})
