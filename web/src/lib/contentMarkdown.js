import { Marked, marked } from 'marked'
import DOMPurify from 'dompurify'

const SAFE_URL_RE = /^(https?:|mailto:|tel:|#|\/)/i
const SAFE_IMAGE_DATA_RE = /^data:image\/(png|jpe?g|gif|webp);base64,/i

// Tira ?access=<sessão> de links internos de arquivo. A sessão é acrescentada só na
// hora de exibir e nunca pode ir para o Markdown salvo (o editor antigo gravava a
// sessão do instrutor dentro da apostila).
export function stripFileAccess(value) {
  const url = String(value || '')
  const match = /^(\/(?:uploads|imagens)\/[^?#]*)\?([^#]*)(#.*)?$/.exec(url)
  if (!match) return url
  const kept = match[2].split('&').filter((part) => part && !/^access=/i.test(part))
  return `${match[1]}${kept.length ? `?${kept.join('&')}` : ''}${match[3] || ''}`
}

function withFileAccess(value) {
  const url = stripFileAccess(value)
  if (!/^\/(uploads|imagens)\//.test(url) || typeof localStorage === 'undefined') return url
  try {
    const auth = JSON.parse(localStorage.getItem('iclass-v3-auth')) || {}
    const access = auth.adminSession || auth.sessionToken
    if (!access) return url
    const separator = url.includes('?') ? '&' : '?'
    return `${url}${separator}access=${encodeURIComponent(access)}`
  } catch { return url }
}

export function resolveContentUrl(value) {
  const src = String(value || '').trim()
  if (!src) return src
  if (SAFE_URL_RE.test(src) || SAFE_IMAGE_DATA_RE.test(src)) return withFileAccess(src)
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return ''
  if (src.startsWith('/')) return src

  const normalized = src.replace(/^\.?\//, '')
  if (normalized.startsWith('uploads/')) return withFileAccess(`/${normalized}`)
  if (normalized.startsWith('content/imagens/')) return withFileAccess(`/${normalized.replace(/^content\//, '')}`)
  if (normalized.startsWith('imagens/')) return withFileAccess(`/${normalized}`)
  return `/${normalized}`
}

function cleanGeneratedHtml(html) {
  const sanitized = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'style', 'svg', 'math'],
    FORBID_ATTR: ['srcdoc'],
    ALLOW_DATA_ATTR: false,
  })
  if (typeof DOMParser === 'undefined') return sanitized

  const doc = new DOMParser().parseFromString(`<main>${sanitized}</main>`, 'text/html')
  const root = doc.body.firstElementChild
  if (!root) return html

  root.querySelectorAll('script, iframe, object, embed').forEach((el) => el.remove())
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith('on')) el.removeAttribute(attr.name)
    }
  })

  root.querySelectorAll('img').forEach((img) => {
    img.setAttribute('src', resolveContentUrl(img.getAttribute('src')))
    img.setAttribute('loading', 'lazy')
    img.setAttribute('decoding', 'async')
    if (!img.getAttribute('alt')) img.setAttribute('alt', '')
  })

  root.querySelectorAll('a').forEach((anchor) => {
    const href = resolveContentUrl(anchor.getAttribute('href'))
    if (href) anchor.setAttribute('href', href)
    else anchor.removeAttribute('href')
    if (anchor.getAttribute('target') === '_blank') anchor.setAttribute('rel', 'noopener noreferrer')
  })

  return DOMPurify.sanitize(root.innerHTML, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'style', 'svg', 'math'],
    ALLOW_DATA_ATTR: false,
  })
}

function escapeHtmlText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const WORD_CHAR_RE = /[\p{L}\p{N}]/u

// Conversor só das questões de prova (fase 3, P3-S2, contrato C4 do P3). Difere do das
// apostilas em três pontos, para o texto escrito antes do Markdown (e as questões de TI)
// aparecer como foi escrito:
// - quebra de linha mantida (breaks): o enunciado digitado em várias linhas não se junta;
// - HTML cru é texto: '<p>', '<br>', 'Lista<String>' e '#include <stdio.h>' aparecem
//   literais. O bloco HTML não existe (a linha vira parágrafo comum) e a tag no meio da
//   linha vira texto escapado; a formatação é só a do Markdown;
// - asterisco entre letras ou números não é ênfase: '2*3*4' e 'x**2' ficam com os
//   sinais (o Markdown padrão faria '2<em>3</em>4'). '*palavra*' e '**negrito**' com
//   espaço ou pontuação em volta continuam valendo.
// Código entre crases e blocos de código não passam por essas regras (são do Markdown).
const questionMarked = new Marked({ gfm: true, breaks: true }, {
  tokenizer: {
    // undefined (e não false) desliga o bloco HTML: false cairia no tokenizador padrão.
    html() { return undefined },
    tag(src) {
      const cap = this.rules.inline.tag.exec(src)
      if (!cap) return undefined
      return { type: 'text', raw: cap[0], text: escapeHtmlText(cap[0]) }
    },
    emStrong(src, maskedSrc, prevChar = '') {
      const run = /^\*+/.exec(src)
      if (!run || !WORD_CHAR_RE.test(prevChar || '') || !WORD_CHAR_RE.test(src.charAt(run[0].length))) return false
      return { type: 'text', raw: run[0], text: run[0] }
    },
  },
  renderer: {
    // Defesa a mais: nenhum token HTML sai cru deste conversor.
    html({ text }) { return escapeHtmlText(text) },
  },
})

// question: true usa o conversor das questões de prova (acima). Sem a opção, o Markdown
// padrão das apostilas, da ajuda e dos termos (linha em branco separa parágrafos).
export function markdownToHtml(markdownText, { question = false } = {}) {
  const html = question === true
    ? questionMarked.parse(markdownText || '')
    : marked.parse(markdownText || '', { gfm: true, breaks: false })
  return cleanGeneratedHtml(html)
}

function textOf(node) {
  return (node.textContent || '').replace(/\s+/g, ' ').trim()
}

function srcForMarkdown(src) {
  if (!src) return ''
  try {
    const url = new URL(src, window.location.origin)
    if (url.origin === window.location.origin) return stripFileAccess(`${url.pathname}${url.search}${url.hash}`)
  } catch {}
  return src
}

// Link do texto: endereço absoluto do próprio site vira caminho; âncora (#), mailto e
// caminho relativo ficam como estão. Em qualquer caso a sessão sai do link de arquivo.
function hrefForMarkdown(href) {
  const value = String(href || '')
  if (/^https?:/i.test(value)) return srcForMarkdown(value)
  return stripFileAccess(value)
}

function serializeChildren(node) {
  return Array.from(node.childNodes).map(serializeNode).join('')
}

function serializeList(node, ordered) {
  return Array.from(node.children)
    .filter((child) => child.tagName === 'LI')
    .map((child, index) => {
      const marker = ordered ? `${index + 1}. ` : '- '
      return `${marker}${serializeChildren(child).trim()}`
    })
    .join('\n') + '\n\n'
}

function serializeNode(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || ''
  if (node.nodeType !== Node.ELEMENT_NODE) return ''

  const tag = node.tagName.toLowerCase()
  if (tag === 'br') return '\n'
  if (tag === 'h1') return `\n# ${textOf(node)}\n\n`
  if (tag === 'h2') return `\n## ${textOf(node)}\n\n`
  if (tag === 'h3') return `\n### ${textOf(node)}\n\n`
  if (tag === 'p') return `${serializeChildren(node).trim()}\n\n`
  if (tag === 'strong' || tag === 'b') return `**${serializeChildren(node)}**`
  if (tag === 'em' || tag === 'i') return `*${serializeChildren(node)}*`
  if (tag === 'code') return `\`${node.textContent || ''}\``
  if (tag === 'pre') return `\n\`\`\`\n${node.textContent || ''}\n\`\`\`\n\n`
  if (tag === 'ul') return serializeList(node, false)
  if (tag === 'ol') return serializeList(node, true)
  if (tag === 'blockquote') {
    return serializeChildren(node)
      .trim()
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n') + '\n\n'
  }
  if (tag === 'a') return `[${serializeChildren(node).trim() || node.getAttribute('href')}](${hrefForMarkdown(node.getAttribute('href') || '')})`
  if (tag === 'img') return `\n\n![${node.getAttribute('alt') || ''}](${srcForMarkdown(node.getAttribute('src') || '')})\n\n`
  if (tag === 'li') return serializeChildren(node)

  return serializeChildren(node)
}

export function htmlToMarkdown(root) {
  if (!root) return ''
  return serializeChildren(root)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n'
}
