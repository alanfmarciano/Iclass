// Minigames das apostilas.
// O autor liga o jogo com um link comum no Markdown: [Jogar](minigames/nome.html).
// contentMarkdown.js transforma o parágrafo desse link num bloco .iclass-minigame
// e o leitor do aluno chama mountMinigames() para montar o jogo ali.
//
// Isolamento: o HTML do jogo chega pelo cliente de API (token só no cabeçalho) e
// roda num iframe com sandbox="allow-scripts" e srcdoc. Sem allow-same-origin o
// jogo não lê o localStorage, os cookies nem a página do IClass; a CSP injetada
// impede o jogo de buscar qualquer coisa na rede.

export const MINIGAME_HREF_RE = /^\/minigames\/([A-Za-z0-9][A-Za-z0-9._-]{0,120}\.html)$/
export const MINIGAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'"

export function minigameNameFromHref(href) {
  const match = MINIGAME_HREF_RE.exec(String(href || ''))
  if (!match || match[1].includes('..')) return null
  return match[1]
}

// Coloca a CSP como primeiro elemento do <head> do jogo. Uma CSP que o jogo
// declare depois só soma restrições: não consegue afrouxar esta.
export function withMinigameCsp(html) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${MINIGAME_CSP}">`
  const source = String(html || '')
  if (/<head[^>]*>/i.test(source)) return source.replace(/<head[^>]*>/i, (tag) => `${tag}${meta}`)
  if (/<html[^>]*>/i.test(source)) return source.replace(/<html[^>]*>/i, (tag) => `${tag}<head>${meta}</head>`)
  return `<!doctype html><head><meta charset="utf-8">${meta}</head>${source}`
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

// loadHtml(nome) devolve uma Promise com o HTML do jogo.
export function mountMinigames(root, loadHtml) {
  if (!root) return []
  const doc = root.ownerDocument
  const mounted = []
  root.querySelectorAll('.iclass-minigame').forEach((block) => {
    if (block.dataset.minigameReady === '1') return
    const anchor = Array.from(block.querySelectorAll('a')).find((a) => minigameNameFromHref(a.getAttribute('href')))
    if (!anchor) return
    const name = minigameNameFromHref(anchor.getAttribute('href'))
    const title = anchor.textContent.trim() || 'Minigame'
    block.dataset.minigameReady = '1'

    const bar = el(doc, 'div', 'iclass-minigame-bar')
    const label = el(doc, 'span', 'iclass-minigame-title', title)
    const play = el(doc, 'button', 'iclass-minigame-btn', 'Jogar aqui')
    play.type = 'button'
    const full = el(doc, 'button', 'iclass-minigame-btn secondary', 'Tela cheia')
    full.type = 'button'
    full.hidden = true
    const status = el(doc, 'span', 'iclass-minigame-status')
    status.setAttribute('role', 'status')
    bar.append(label, play, full, status)
    const stage = el(doc, 'div', 'iclass-minigame-stage')
    stage.hidden = true
    // O texto original do autor (o link e o que estiver em volta) fica guardado,
    // escondido, e o título do link vira o título do bloco.
    const source = el(doc, 'span', 'iclass-minigame-source')
    source.hidden = true
    while (block.firstChild) source.appendChild(block.firstChild)
    block.append(source, bar, stage)

    let frame = null
    play.addEventListener('click', async () => {
      if (frame) {
        frame.remove(); frame = null
        stage.hidden = true; full.hidden = true
        play.textContent = 'Jogar aqui'
        return
      }
      play.disabled = true
      status.textContent = 'Carregando o jogo…'
      try {
        const html = await loadHtml(name)
        frame = el(doc, 'iframe', 'iclass-minigame-frame')
        frame.setAttribute('sandbox', 'allow-scripts')
        frame.setAttribute('referrerpolicy', 'no-referrer')
        frame.setAttribute('title', title)
        frame.srcdoc = withMinigameCsp(html)
        stage.replaceChildren(frame)
        stage.hidden = false
        full.hidden = typeof stage.requestFullscreen !== 'function'
        play.textContent = 'Fechar o jogo'
        status.textContent = ''
      } catch (error) {
        status.textContent = error && error.status === 404 ? 'Este minigame ainda não está no IClass.' : 'Não foi possível abrir o jogo. Tente de novo.'
      } finally {
        play.disabled = false
      }
    })
    full.addEventListener('click', () => {
      if (stage.requestFullscreen) stage.requestFullscreen().catch(() => {})
    })
    mounted.push(name)
  })
  return mounted
}
