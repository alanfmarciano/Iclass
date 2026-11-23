import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'

// Folha de impressão da apostila (fase 3, C17 / P5-S3; UXA-14, D25 do P5). "Imprimir ou
// salvar em PDF" no leitor abre a caixa de impressão do próprio navegador (window.print,
// sem janela nova: o celular bloqueia pop-up) e sai só a apostila: o cabeçalho com a escola
// e o curso, o título da unidade, o texto e o rodapé "Material de uso dos alunos de
// <curso>". Menu, faixas, caderno, fórum, anotações e o destaque da busca não saem.
//
// Como: a folha (.folha-impressao) é um filho direto do <body> (portal). Enquanto ela
// está montada, <html data-impressao="..."> faz o @media print de index.css esconder
// todo o resto do <body> (o #root inteiro) e mostrar só ela. Ela só ganha o texto na hora
// de imprimir (pelo botão ou pelo Ctrl+P do navegador, no evento beforeprint), e as
// imagens dela carregam de uma vez (a apostila na tela carrega as imagens só quando
// chegam perto, loading="lazy", e no papel sairia o espaço vazio).
//
// Curso com a impressão desligada (courses[].permitirImpressao false): o botão some e a
// folha, montada o tempo todo com o leitor aberto, diz só "Impressão desativada pela
// escola." (Ctrl+P também não leva a apostila).

export const PRINT_ATTRIBUTE = 'impressao'
export const PRINT_DISABLED_TEXT = 'Impressão desativada pela escola.'
// Espera máxima pelas imagens antes de abrir a caixa de impressão (rede da sala lenta):
// depois disso imprime com o que chegou.
export const PRINT_IMAGE_WAIT_MS = 4000

// O HTML da apostila (já limpo por markdownToHtml) com as imagens sem carregamento tardio.
export function eagerImagesHtml(html) {
  return String(html || '').replace(/\sloading=(["'])lazy\1/gi, '')
}

// A apostila já começa com o título da unidade (o # do Markdown igual ao nome da unidade)?
// Aí a folha não repete o título.
export function startsWithTitle(html, title) {
  const wanted = String(title || '').replace(/\s+/g, ' ').trim().toLowerCase()
  if (!wanted || typeof document === 'undefined') return false
  const template = document.createElement('template')
  template.innerHTML = String(html || '')
  const first = template.content.firstElementChild
  if (!first || !/^H[1-3]$/.test(first.tagName)) return false
  return first.textContent.replace(/\s+/g, ' ').trim().toLowerCase() === wanted
}

function waitForImages(root, timeoutMs) {
  const pending = Array.from(root ? root.querySelectorAll('img') : []).filter((img) => !img.complete)
  if (!pending.length) return Promise.resolve()
  return new Promise((resolve) => {
    let left = pending.length
    const timer = setTimeout(resolve, timeoutMs)
    const done = () => {
      left -= 1
      if (left <= 0) { clearTimeout(timer); resolve() }
    }
    pending.forEach((img) => {
      img.addEventListener('load', done, { once: true })
      img.addEventListener('error', done, { once: true })
    })
  })
}

function setPrintMode(value) {
  if (typeof document === 'undefined') return
  if (value) document.documentElement.dataset[PRINT_ATTRIBUTE] = value
  else delete document.documentElement.dataset[PRINT_ATTRIBUTE]
}

// open: o leitor está com uma unidade aberta. allowed: o curso permite imprimir.
// Devolve { printing, print }: print() prepara a folha, espera as imagens e chama
// window.print().
export function useApostilaPrint({ open, allowed }) {
  const [printing, setPrinting] = useState(false)
  const sheetRef = useRef(null)
  const busyRef = useRef(false)

  useEffect(() => {
    if (!open) return undefined
    // Desligada: a folha (só o aviso) vale o tempo todo, também para o Ctrl+P.
    setPrintMode(allowed ? '' : 'bloqueada')
    const before = () => {
      if (!allowed) return
      flushSync(() => setPrinting(true))
      setPrintMode('apostila')
    }
    const after = () => {
      busyRef.current = false
      setPrinting(false)
      setPrintMode(allowed ? '' : 'bloqueada')
    }
    window.addEventListener('beforeprint', before)
    window.addEventListener('afterprint', after)
    return () => {
      window.removeEventListener('beforeprint', before)
      window.removeEventListener('afterprint', after)
      busyRef.current = false
      setPrinting(false)
      setPrintMode('')
    }
  }, [open, allowed])

  const print = useCallback(async () => {
    if (!open || !allowed || busyRef.current || typeof window.print !== 'function') return
    busyRef.current = true
    flushSync(() => setPrinting(true))
    setPrintMode('apostila')
    await waitForImages(sheetRef.current, PRINT_IMAGE_WAIT_MS)
    try { window.print() } catch { /* navegador sem impressão: nada a fazer */ }
    // Navegador que não avisa o fim (afterprint) e não segura o window.print(): o botão
    // volta a funcionar; a folha fica até o próximo afterprint ou até sair da unidade.
    busyRef.current = false
  }, [open, allowed])

  return { printing, print, sheetRef }
}

// A folha em si: portal no <body>, escondida na tela (index.css) e só com o texto na hora
// de imprimir. Todo texto entra como texto (React escapa); o HTML é o da apostila, o
// mesmo que o leitor mostra.
export function ApostilaPrintSheet({ open, allowed, printing, sheetRef, html, unitTitle, moduleTitle, courseName, schoolName }) {
  if (!open || typeof document === 'undefined') return null
  const material = courseName ? `Material de uso dos alunos de ${courseName}` : 'Material de uso dos alunos'
  return createPortal(
    <div ref={sheetRef} className="folha-impressao" aria-hidden="true" data-testid="folha-impressao">
      {!allowed ? (
        <p className="folha-impressao-bloqueada">{PRINT_DISABLED_TEXT}</p>
      ) : printing ? (
        <>
          <header className="folha-impressao-cabecalho">
            <span>{schoolName}</span>
            <span>{[courseName, moduleTitle].filter(Boolean).join(' · ')}</span>
          </header>
          {!startsWithTitle(html, unitTitle) && <h1 className="folha-impressao-titulo">{unitTitle}</h1>}
          <article className="prose-iclass" dangerouslySetInnerHTML={{ __html: eagerImagesHtml(html) || '<p>Conteúdo indisponível.</p>' }} />
          <footer className="folha-impressao-rodape">{[material, schoolName].filter(Boolean).join(' · ')}</footer>
        </>
      ) : null}
    </div>,
    document.body,
  )
}
