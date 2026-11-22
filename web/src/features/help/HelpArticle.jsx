import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { markdownToHtml } from '../../lib/contentMarkdown'

// Texto de um tema da Ajuda: o Markdown passa pelo markdownToHtml (marked + DOMPurify,
// sem script nem atributo on*). Os títulos de dentro do tema descem `shift` níveis, para
// a página ter um só h1 e a ordem dos títulos fazer sentido no leitor de tela. Link para
// uma tela do IClass (/sistema, /certificado) abre sem recarregar a página.
export function helpMarkdownToHtml(markdown, shift = 2) {
  const html = markdownToHtml(String(markdown || ''))
  if (!shift) return html
  return html.replace(/<(\/?)h([1-6])(?=[\s>])/gi, (_match, slash, level) => `<${slash}h${Math.min(6, Number(level) + shift)}`)
}

export function HelpArticle({ markdown, shift = 2, className = '' }) {
  const navigate = useNavigate()
  const html = useMemo(() => helpMarkdownToHtml(markdown, shift), [markdown, shift])
  function onClick(event) {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const href = anchor.getAttribute('href') || ''
    if (anchor.getAttribute('target') === '_blank' || !href.startsWith('/') || href.startsWith('//')) return
    // Arquivo do servidor (/uploads, /imagens) abre normal; tela do app vai pelo roteador.
    if (/^\/(uploads|imagens|api)\//.test(href)) return
    event.preventDefault()
    navigate(href)
  }
  return (
    <div className={`prose-iclass break-words [&_a]:text-text [&_a]:underline [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto ${className}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
  )
}
