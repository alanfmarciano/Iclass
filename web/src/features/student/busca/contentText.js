// Texto da apostila como o aluno lê no leitor (fase 3, C16 / P5-S2): a Busca e o leitor
// (Módulos) usam as mesmas regras para que "seção 3" e o trecho marcado sejam os mesmos
// nos dois lados.
//
// - Seções: cada título h1 a h4 começa uma seção; a seção 0 é o que vem antes do primeiro
//   título. O número da seção é o do título na ordem do documento (querySelectorAll), o
//   mesmo que o leitor conta para rolar até ela (?secao=).
// - Marcar: o leitor embrulha em <mark> os pedaços de nós de texto onde o termo aparece
//   (document.createElement e splitText, nunca innerHTML) e sabe desfazer.
import { findTermRanges } from '../../../lib/searchHighlight'

export const SECTION_HEADINGS = 'h1, h2, h3, h4'
const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4'])
const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, pre, dt, dd, figcaption, caption, div, section, article, main'
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'])
export const MARK_CLASS = 'busca-marca'
export const MARK_CURRENT_CLASS = 'busca-marca-atual'

// Raiz para o HTML já limpo do markdownToHtml (DOMParser: documento inerte, nada carrega
// nem roda, nem o onerror de uma imagem).
export function htmlRoot(html) {
  if (typeof DOMParser === 'undefined') return null
  const doc = new DOMParser().parseFromString(`<main>${html || ''}</main>`, 'text/html')
  return doc.body.firstElementChild
}

function clean(text) {
  return text.replace(/\s+/g, ' ').trim()
}

// Seções do texto: [{ secao, title, text }] na ordem do documento.
export function splitSections(root, { firstTitle = '' } = {}) {
  if (!root) return []
  const sections = [{ secao: 0, title: firstTitle, text: '' }]
  let headings = 0
  let buffer = []
  const flush = () => {
    const current = sections[sections.length - 1]
    current.text = clean(`${current.text} ${buffer.join('')}`)
    buffer = []
  }
  const walk = (node) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) { buffer.push(child.nodeValue || ''); return }
      if (child.nodeType !== 1 || SKIP_TAGS.has(child.tagName)) return
      if (HEADING_TAGS.has(child.tagName)) {
        flush()
        headings += 1
        sections.push({ secao: headings, title: clean(child.textContent || ''), text: '' })
        return
      }
      walk(child)
      if (child.matches && child.matches(BLOCK_SELECTOR)) buffer.push(' ')
      if (child.tagName === 'BR') buffer.push(' ')
    })
  }
  walk(root)
  flush()
  return sections.filter((section) => section.secao > 0 || section.text)
}

function blockOf(node) {
  const parent = node.parentElement
  return parent ? (parent.closest(BLOCK_SELECTOR) || parent) : null
}

// Marca o termo dentro de root. Devolve as marcas criadas (na ordem do documento).
// Palavra quebrada por formatação ("re<b>des</b>") é achada; texto de blocos diferentes
// não se junta (o fim de um parágrafo e o começo do outro não formam palavra).
export function markTerm(root, term, { limit = 300 } = {}) {
  if (!root || typeof document === 'undefined') return []
  const walker = document.createTreeWalker(root, 4)
  const groups = []
  let group = null
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue || (node.parentElement && SKIP_TAGS.has(node.parentElement.tagName))) continue
    const block = blockOf(node)
    if (!group || group.block !== block) { group = { block, nodes: [], text: '' }; groups.push(group) }
    group.nodes.push({ node, from: group.text.length })
    group.text += node.nodeValue
  }
  const marks = []
  for (const item of groups) {
    if (marks.length >= limit) break
    const ranges = findTermRanges(item.text, term, { limit: limit - marks.length })
    if (!ranges.length) continue
    const perNode = new Map()
    ranges.forEach(([start, end]) => {
      item.nodes.forEach(({ node, from }) => {
        const to = from + node.nodeValue.length
        if (end <= from || start >= to) return
        if (!perNode.has(node)) perNode.set(node, [])
        perNode.get(node).push([Math.max(start, from) - from, Math.min(end, to) - from])
      })
    })
    const created = []
    perNode.forEach((slices, node) => {
      // Do fim para o começo: splitText não mexe no que vem antes.
      slices.sort((a, b) => b[0] - a[0]).forEach(([start, end]) => {
        if (end > node.nodeValue.length) return
        node.splitText(end)
        const middle = node.splitText(start)
        const mark = document.createElement('mark')
        mark.className = MARK_CLASS
        middle.parentNode.insertBefore(mark, middle)
        mark.appendChild(middle)
        created.push(mark)
      })
    })
    marks.push(...created)
  }
  // Ordem do documento (o laço acima cria do fim para o começo em cada nó).
  return marks.sort((a, b) => (a === b ? 0 : (a.compareDocumentPosition(b) & 4 ? -1 : 1)))
}

// Desfaz as marcas (as que ainda estão na página).
export function unmarkTerm(marks) {
  const parents = new Set()
  ;(marks || []).forEach((mark) => {
    const parent = mark.parentNode
    if (!parent) return
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
    parent.removeChild(mark)
    parents.add(parent)
  })
  parents.forEach((parent) => parent.normalize())
}

// Primeira marca da seção pedida (ou depois dela); sem seção, a primeira de todas.
export function firstMarkFrom(root, marks, secao) {
  if (!marks || !marks.length) return null
  const index = Number(secao)
  if (!root || !Number.isInteger(index) || index <= 0) return marks[0]
  const heading = root.querySelectorAll(SECTION_HEADINGS)[index - 1]
  if (!heading) return marks[0]
  return marks.find((mark) => heading.compareDocumentPosition(mark) & 4) || marks[0]
}

// Título da seção pedida, para rolar até ela quando o termo não está no texto (achado só
// no título da unidade, ou a apostila mudou).
export function sectionHeading(root, secao) {
  const index = Number(secao)
  if (!root || !Number.isInteger(index) || index <= 0) return null
  return root.querySelectorAll(SECTION_HEADINGS)[index - 1] || null
}
