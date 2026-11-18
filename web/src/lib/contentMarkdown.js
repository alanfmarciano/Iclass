import { marked } from 'marked'
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

export function markdownToHtml(markdownText) {
  const html = marked.parse(markdownText || '', { gfm: true, breaks: false })
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
