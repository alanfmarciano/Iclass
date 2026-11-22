import { useEffect, useRef, useState } from 'react'
import { Download, ExternalLink, FileText, Image as ImageIcon } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { downloadFile, fetchBlob } from '../../../lib/api'
import { formatBytes } from './correction'
import { hidePlaceholderEmails } from './assignmentText'
import { TOUCH } from './touch'

// Prévia de um arquivo de entrega no painel de correção (fase 3, C8 / P1-f; D7 do P1).
//
// - Imagem (jpg, png, webp, gif): o arquivo é lido com a sessão do professor (fetchBlob,
//   ?inline=1) e mostrado em <img src="blob:">, que a CSP do IClass já permite. O Blob é
//   refeito com o tipo da lista branca da extensão: nunca vira SVG nem HTML.
// - PDF: botão "Abrir" em aba nova, com um Blob application/pdf (a CSP não deixa blob: em
//   frame, e afrouxar a CSP global não vale a pena). A aba nasce no clique, sem acesso a
//   esta página (opener nulo), para o bloqueio de janelas não engolir a abertura.
// - Texto e código (até 200 KB, o servidor diz quais com preview 'text'): o conteúdo como
//   texto puro (React escapa; nada de HTML).
// - O resto (HEIC, Office, ZIP, formatos do curso): só "Baixar". Todo arquivo tem
//   "Baixar", que sai como anexo pelo servidor (nosniff, CSP sandbox).
// - Arquivo que sumiu do computador (missing): o aviso no lugar da prévia.
//
// A URL do Blob é liberada (revokeObjectURL) quando a prévia sai da tela ou troca de
// arquivo; o pedido em andamento é cancelado.

const IMAGE_TYPES = Object.freeze({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' })
const TEXT_PREVIEW_MAX = 200 * 1024
// Quanto tempo a aba do PDF tem para abrir o Blob antes de ele ser liberado.
const PDF_URL_TTL_MS = 10 * 60 * 1000

function extOf(file) {
  const ext = String(file?.ext || '').toLowerCase()
  if (ext) return ext
  const match = /\.[^.]+$/.exec(String(file?.name || ''))
  return match ? match[0].toLowerCase() : ''
}

// Texto do Blob (navegador sem Blob.text, como o jsdom dos testes: pelo FileReader).
function readBlobText(blob) {
  if (typeof blob.text === 'function') return blob.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('Não foi possível ler o arquivo.'))
    reader.readAsText(blob)
  })
}

export function fileUrl(base, file, { inline = false } = {}) {
  return `${base}/files/${encodeURIComponent(file.id)}${inline ? '?inline=1' : ''}`
}

export function FilePreview({ base, file }) {
  const ext = extOf(file)
  const kind = file?.missing ? null : file?.preview
  const imageType = kind === 'image' ? IMAGE_TYPES[ext] : null
  const [state, setState] = useState({ status: 'idle', url: '', text: '', error: '' })
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState('')
  const pdfUrls = useRef([])

  // Imagem e texto carregam sozinhos (a versão escolhida); o PDF só no clique.
  useEffect(() => {
    if (!file?.id || (kind !== 'text' && !imageType)) return undefined
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    let url = ''
    let alive = true
    setState({ status: 'loading', url: '', text: '', error: '' })
    fetchBlob(fileUrl(base, file, { inline: !!imageType }), { signal: controller?.signal })
      .then(async ({ blob }) => {
        if (!alive) return
        if (imageType) {
          url = URL.createObjectURL(new Blob([blob], { type: imageType }))
          setState({ status: 'ready', url, text: '', error: '' })
        } else {
          const raw = await readBlobText(blob.slice(0, TEXT_PREVIEW_MAX))
          if (alive) setState({ status: 'ready', url: '', text: raw, error: '' })
        }
      })
      .catch((error) => {
        if (!alive || error?.aborted || error?.name === 'AbortError') return
        setState({ status: 'error', url: '', text: '', error: hidePlaceholderEmails(error?.message) || 'Não foi possível abrir a prévia.' })
      })
    return () => {
      alive = false
      controller?.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [base, file?.id, kind, imageType])

  // PDFs abertos: liberados quando a prévia sai da tela.
  useEffect(() => () => {
    pdfUrls.current.forEach((url) => URL.revokeObjectURL(url))
    pdfUrls.current = []
  }, [])

  async function openPdf() {
    setDownloadError('')
    // A aba nasce agora, no clique (o navegador bloquearia a aberta depois do pedido).
    const win = typeof window.open === 'function' ? window.open('', '_blank') : null
    if (win) {
      try { win.opener = null } catch {}
    }
    try {
      const { blob } = await fetchBlob(fileUrl(base, file, { inline: true }))
      const url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }))
      pdfUrls.current.push(url)
      setTimeout(() => {
        URL.revokeObjectURL(url)
        pdfUrls.current = pdfUrls.current.filter((item) => item !== url)
      }, PDF_URL_TTL_MS)
      if (win && !win.closed) {
        win.location.href = url
      } else {
        // Sem aba (bloqueio de janelas): um link para a aba nova, como reserva.
        const a = document.createElement('a')
        a.href = url
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
        document.body.appendChild(a)
        a.click()
        a.remove()
      }
    } catch (error) {
      if (win && !win.closed) win.close()
      setDownloadError(hidePlaceholderEmails(error?.message) || 'Não foi possível abrir o PDF.')
    }
  }

  async function download() {
    setDownloading(true)
    setDownloadError('')
    try {
      await downloadFile(fileUrl(base, file), file?.name || 'arquivo')
    } catch (error) {
      setDownloadError(hidePlaceholderEmails(error?.message) || 'Não foi possível baixar o arquivo.')
    } finally {
      setDownloading(false)
    }
  }

  const name = file?.name || 'arquivo'
  return (
    <div className="min-w-0 space-y-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 break-all text-sm font-medium text-text">
            {imageType ? <ImageIcon aria-hidden="true" size={16} className="shrink-0" /> : <FileText aria-hidden="true" size={16} className="shrink-0" />}
            {name}
          </p>
          <p className="text-xs text-muted">{formatBytes(file?.size)}{file?.comprovante ? ` · código ${file.comprovante}` : ''}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {kind === 'pdf' && <Button size="sm" variant="secondary" icon={ExternalLink} className={TOUCH} onClick={openPdf} aria-label={`Abrir ${name} em outra aba`}>Abrir</Button>}
          {!file?.missing && <Button size="sm" variant="secondary" icon={Download} className={TOUCH} loading={downloading} onClick={download} aria-label={`Baixar ${name}`}>Baixar</Button>}
        </div>
      </div>
      {file?.missing && (
        <p role="status" className="text-sm text-warning">Este arquivo não está mais no computador. Se houver cópia no destino externo do backup, ele pode ser trazido de volta em Sistema.</p>
      )}
      {!file?.missing && kind === null && (
        <p className="text-xs text-muted">{ext === '.heic' || ext === '.heif' ? 'Foto HEIC (do iPhone) não tem prévia no navegador: baixe para abrir.' : 'Sem prévia para este tipo de arquivo: baixe para abrir.'}</p>
      )}
      {state.status === 'loading' && <p className="text-xs text-muted" aria-live="polite">Carregando a prévia...</p>}
      {state.status === 'error' && <p role="alert" className="text-sm text-danger">{state.error}</p>}
      {state.status === 'ready' && state.url && (
        <img src={state.url} alt={`Prévia de ${name}`} className="h-auto max-h-[70vh] w-full rounded-md border border-border object-contain bg-surface-2" />
      )}
      {state.status === 'ready' && !state.url && (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface-2 p-3 text-xs text-text" aria-label={`Conteúdo de ${name}`}>{state.text}</pre>
      )}
      {downloadError && <p role="alert" className="text-sm text-danger">{downloadError}</p>}
    </div>
  )
}
