import { useMemo, useState } from 'react'
import { markdownToHtml } from '../../lib/contentMarkdown'
import { Modal } from '../../components/ui/Modal'

// Texto de questão de prova no navegador (fase 3, P3-S2: UXA-12, AVA-06; contrato C4 do
// desenho P3): enunciado, alternativa e explicação são Markdown e só aparecem por aqui.
// - A limpeza é a do leitor das apostilas (markdownToHtml: marked + DOMPurify, sem
//   script, iframe, svg nem atributo on*), com o conversor das questões (question: true):
//   quebra de linha mantida (o enunciado digitado em várias linhas não vira uma linha só,
//   como acontecia no <p>), HTML cru mostrado como texto ('<p>', 'Lista<String>') e
//   asterisco entre números ('2*3*4') sem virar ênfase. O texto antigo aparece como foi
//   escrito; só o Markdown formata.
// - Imagem de /uploads ganha ?access=<sessão> (o servidor só entrega a imagem da questão
//   ao aluno durante a tentativa aberta ou com o gabarito liberado, backend/utils/
//   examMedia.js) e cabe na largura (max-width 100%). Com zoom, tocar na imagem abre a
//   imagem grande numa janela do IClass.
// - Tabela ganha um contêiner com rolagem própria e o bloco de código rola dentro dele:
//   no celular de 375 px a página nunca rola para o lado por causa da questão.
// - links={false} (prova em andamento): o link vira texto. Tocar num link no meio da
//   prova levaria o aluno para fora dela, e a saída trava a prova.
// O servidor nunca monta HTML de questão; esta é a única porta de entrada no navegador.

export function questionMarkdownHtml(text, { links = true, zoom = false } = {}) {
  const html = markdownToHtml(String(text ?? ''), { question: true })
  if (typeof DOMParser === 'undefined') return html
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  const root = doc.body.firstElementChild
  if (!root) return html
  root.querySelectorAll('table').forEach((table) => {
    const wrapper = doc.createElement('div')
    wrapper.className = 'question-md-table'
    wrapper.setAttribute('role', 'region')
    wrapper.setAttribute('aria-label', 'Tabela (role para o lado para ver tudo)')
    wrapper.setAttribute('tabindex', '0')
    table.replaceWith(wrapper)
    wrapper.appendChild(table)
  })
  // Bloco de código com rolagem própria: o teclado também alcança a rolagem.
  root.querySelectorAll('pre').forEach((pre) => pre.setAttribute('tabindex', '0'))
  if (!links) {
    root.querySelectorAll('a').forEach((anchor) => {
      anchor.removeAttribute('href')
      anchor.removeAttribute('target')
      anchor.removeAttribute('rel')
    })
  }
  if (zoom) {
    root.querySelectorAll('img').forEach((img) => {
      img.setAttribute('data-zoomable', '')
      img.setAttribute('tabindex', '0')
      img.setAttribute('role', 'button')
      img.setAttribute('title', 'Toque para ampliar')
      if (!img.getAttribute('alt')) img.setAttribute('alt', 'Imagem da questão (toque para ampliar)')
    })
  }
  return root.innerHTML
}

export default function QuestionMarkdown({ text, className = '', links = true, zoom = true, id }) {
  const html = useMemo(() => questionMarkdownHtml(text, { links, zoom }), [text, links, zoom])
  const [zoomed, setZoomed] = useState(null)

  function openZoom(target) {
    if (!zoom || !target || target.tagName !== 'IMG' || !target.hasAttribute('data-zoomable')) return false
    setZoomed({ src: target.getAttribute('src') || '', alt: target.getAttribute('alt') || '' })
    return true
  }

  return (
    <>
      <div
        id={id}
        className={`question-md ${className}`.trim()}
        onClick={(event) => { if (openZoom(event.target)) event.preventDefault() }}
        onKeyDown={(event) => {
          if ((event.key === 'Enter' || event.key === ' ') && openZoom(event.target)) event.preventDefault()
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {zoom && (
        <Modal open={!!zoomed} onClose={() => setZoomed(null)} title="Imagem da questão" size="xl">
          {zoomed && <img src={zoomed.src} alt={zoomed.alt} className="mx-auto block h-auto max-w-full" />}
        </Modal>
      )}
    </>
  )
}
