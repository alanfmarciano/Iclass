// Uma atividade no portal do aluno (fase 3, C9 / P1-g; FUN-01, D8, D9 e D12 do P1): as
// instruções, o que enviar, o envio pelo celular, o comprovante e as versões enviadas, e a
// devolução do professor.
//
// - Envio: um pedido multipart por versão (arquivos, texto e link juntos) por
//   uploadWithProgress (lib/api.js): a barra mostra quanto já subiu. Foto acima de 3 MB é
//   reduzida no próprio celular (lib/imageResize.js) com o aviso "Foto reduzida para
//   enviar mais rápido" e a opção "Enviar original" quando a original cabe no limite.
// - Antes de mandar, a tela confere tipo, tamanho, quantidade e link com as frases do
//   servidor (atividadeText.js); o servidor confere de novo.
// - Rede caiu no meio: "Tentar de novo" com os mesmos arquivos escolhidos. Se a resposta
//   se perdeu mas o envio chegou (a versão aparece ao recarregar), a tela mostra o
//   comprovante dessa versão em vez de pedir para mandar outra.
// - Comprovante: a linha "Recebido às 14:32 de 20/11 — versão 2 — ..." recebe o foco
//   depois do envio, e "Imprimir comprovante" sai pelo printDocument (cabeçalho da escola).
// - Hora: prazo, "faltam" e o relógio mostrados são os do computador do professor (o
//   servidor manda serverNow e o fuso); o do celular pode estar errado (D8).
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Camera, CheckCircle2, Clock, Download, ExternalLink, FileText, Printer, RotateCcw, Send, Trash2 } from 'lucide-react'
import { Card } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { PageState } from '../../components/ui/PageState'
import { Textarea } from '../../components/ui/Textarea'
import { Input } from '../../components/ui/Input'
import { HelpLink } from '../../components/ui/HelpLink'
import { useApi } from '../../hooks/useApi'
import { useBranding } from '../../context/BrandingProvider'
import { downloadFile, uploadWithProgress } from '../../lib/api'
import { markdownToHtml } from '../../lib/contentMarkdown'
import { openPrintWindow, printDocument, schoolFromBranding } from '../../lib/printDocument'
import { resizeImage, shouldResizeImage } from '../../lib/imageResize'
import { useStudent } from './useStudent'
import { ASSIGNMENTS_POLL_MS } from './AtividadesPage'
import {
  MB, buildSubmissionForm, closeLine, dateTimeText, deadlineLine, emptySubmissionText, fileProblem, formatBytes,
  limitsText, linkProblem, receiptDocument, receiptLine, responseKindsText, returnSummary, safeExternalLink,
  selectionProblem, situationTone, timeText, versionTimingText, withExtension,
} from './atividades/atividadeText'

const CLOCK_TICK_MS = 30000
let itemSeq = 0

export function detailPath(id, courseId, studentClass) {
  if (!id || !courseId || !studentClass) return null
  return `/api/student/assignments/${encodeURIComponent(id)}?courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(studentClass)}`
}

export function submitPath(id) {
  return `/api/student/assignments/${encodeURIComponent(id)}/submit`
}

export function filePath(id, fileId) {
  return `/api/student/assignments/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}`
}

// O arquivo que vai no envio: a foto reduzida ou, com "Enviar original", a de antes.
export function chosenFile(item) {
  return item.useOriginal && item.original ? item.original : item.file
}

// Hora do servidor agora: a da resposta mais o tempo que passou neste aparelho desde que
// ela chegou (o relógio do celular pode estar errado, mas conta o tempo direito).
function useServerClock(serverNow) {
  const [, setTick] = useState(0)
  // Diferença entre o relógio do servidor e o deste aparelho, medida quando a resposta
  // chegou (o render em que serverNow muda).
  const offset = useMemo(() => (typeof serverNow === 'number' ? serverNow - Date.now() : 0), [serverNow])
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [])
  return Date.now() + offset
}

function ProgressBar({ percent }) {
  const value = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)))
  return (
    <div className="flex items-center gap-3">
      <div role="progressbar" aria-label="Envio dos arquivos" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-valuetext={`${value}% enviado`} className="h-2.5 flex-1 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${value}%` }} />
      </div>
      <span className="w-12 text-right text-sm font-semibold tabular-nums text-text" aria-hidden="true">{value}%</span>
    </div>
  )
}

function FileRow({ item, maxSizeMb, onRemove, onToggleOriginal, disabled }) {
  const file = chosenFile(item)
  const originalFits = item.original && Number(item.original.size) <= Number(maxSizeMb) * MB
  return (
    <li className="rounded-lg border border-border bg-surface p-3">
      <div className="flex items-start gap-3">
        <FileText aria-hidden="true" size={18} className="mt-0.5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="break-all text-sm font-medium text-text">{file.name}</p>
          <p className="text-xs text-muted">{item.preparing ? 'Preparando a foto…' : formatBytes(file.size)}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" icon={Trash2} className="h-11 shrink-0 px-3" onClick={() => onRemove(item.id)} disabled={disabled} aria-label={`Remover ${file.name}`}>Remover</Button>
      </div>
      {item.original && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-info-soft px-3 py-2 text-xs text-info">
          <span className="min-w-0 flex-1">
            {item.useOriginal
              ? `Vai a foto original (${formatBytes(item.original.size)}).`
              : `Foto reduzida para enviar mais rápido (${formatBytes(item.original.size)} para ${formatBytes(item.file.size)}).`}
          </span>
          {(item.useOriginal || originalFits) && (
            <button type="button" className="min-h-[44px] rounded-md px-2 font-semibold underline underline-offset-2 disabled:opacity-50" onClick={() => onToggleOriginal(item.id)} disabled={disabled}>
              {item.useOriginal ? 'Usar a foto reduzida' : 'Enviar original'}
            </button>
          )}
        </div>
      )}
      {item.problem && <p role="alert" className="mt-2 text-xs text-danger">{item.problem}</p>}
    </li>
  )
}

function VersionCard({ version, assignmentId, timezone, onPrint, highlight }) {
  const [downloadError, setDownloadError] = useState('')
  const link = safeExternalLink(version.link)
  const download = async (file) => {
    setDownloadError('')
    try { await downloadFile(filePath(assignmentId, file.id), file.name) } catch (err) { setDownloadError(err.message || 'Não foi possível baixar o arquivo agora.') }
  }
  return (
    <li className={`rounded-xl border p-4 ${highlight ? 'border-primary/50 bg-primary-soft/40' : 'border-border bg-surface'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-text">Versão {version.n}</h3>
        <Badge tone={version.late ? 'warning' : 'success'}>{versionTimingText(version)}</Badge>
      </div>
      <p className="mt-1 break-words text-sm text-muted">{receiptLine(version, timezone)}</p>
      {version.files.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {version.files.map((file) => (
            <li key={file.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 break-all text-sm text-text">{file.name} <span className="text-xs text-subtle">({formatBytes(file.size)})</span></span>
              <Button type="button" variant="secondary" size="sm" icon={Download} className="h-11 shrink-0" onClick={() => download(file)} aria-label={`Baixar ${file.name}`}>Baixar</Button>
            </li>
          ))}
        </ul>
      )}
      {version.text && (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-subtle">Resposta em texto</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-text">{version.text}</p>
        </div>
      )}
      {version.link && (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-subtle">Link</p>
          <div className="mt-1 flex items-center gap-2">
            <span className="min-w-0 flex-1 break-all text-sm text-text">{version.link}</span>
            {link && <a href={link} target="_blank" rel="noopener noreferrer" className="inline-flex h-11 shrink-0 items-center gap-1 rounded-lg px-3 text-sm font-semibold text-primary hover:bg-surface-2"><ExternalLink aria-hidden="true" size={15} /> Abrir</a>}
          </div>
        </div>
      )}
      {downloadError && <p role="alert" className="mt-2 text-xs text-danger">{downloadError}</p>}
      <div className="mt-3">
        <Button type="button" variant="ghost" size="sm" icon={Printer} className="h-11" onClick={() => onPrint(version)}>Imprimir comprovante</Button>
      </div>
    </li>
  )
}

export default function AtividadeDetalhePage() {
  const { id = '' } = useParams()
  const { courseId, studentClass, displayName, name, email, courses } = useStudent()
  const { branding } = useBranding()
  const detail = useApi(detailPath(id, courseId, studentClass), [id, courseId, studentClass], { pollMs: ASSIGNMENTS_POLL_MS })
  const data = detail.data || null
  const [items, setItems] = useState([])
  const [text, setText] = useState('')
  const [link, setLink] = useState('')
  const [phase, setPhase] = useState('idle') // idle | sending
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState(null) // { message, retry }
  const [receipt, setReceipt] = useState(null) // { version, recovered }
  const [printError, setPrintError] = useState('')
  const inputRef = useRef(null)
  const receiptRef = useRef(null)
  const mountedRef = useRef(true)
  const now = useServerClock(data?.serverNow)
  const timezone = data?.timezone || ''

  useEffect(() => () => { mountedRef.current = false }, [])
  // Sair da página no meio do envio pergunta antes (o navegador mostra a caixa dele).
  useEffect(() => {
    if (phase !== 'sending') return undefined
    const warn = (event) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [phase])
  useEffect(() => {
    if (receipt && receiptRef.current) receiptRef.current.focus()
  }, [receipt])

  const assignment = data?.assignment || null
  const aceita = data?.aceita || {}
  const resposta = aceita.resposta || {}
  const versions = data?.minhaEntrega?.versoes || []
  const devolucao = returnSummary(data?.devolucao)
  const instructionsHtml = useMemo(() => (assignment?.instructions ? markdownToHtml(assignment.instructions) : ''), [assignment?.instructions])
  const sending = phase === 'sending'
  const preparing = items.some((item) => item.preparing)
  const accepts = !!data?.aceitaEnvio
  const lateNow = accepts && typeof assignment?.dueAt === 'number' ? now > assignment.dueAt : !!data?.atrasoAgora
  const row = data ? { situacao: data.situacao, situacaoTexto: data.situacaoTexto, aceitaEnvio: data.aceitaEnvio, dueAt: assignment?.dueAt } : null
  const courseName = (courses || []).find((course) => course.id === courseId)?.name || ''

  const files = items.map(chosenFile)
  const problems = items.map((item) => item.problem).filter(Boolean)
  const groupProblem = selectionProblem(files, aceita)
  const linkError = resposta.link ? linkProblem(link) : ''

  async function addFiles(fileList) {
    const picked = Array.from(fileList || []).map(withExtension)
    if (!picked.length) return
    setError(null)
    const fresh = picked.map((file) => {
      itemSeq += 1
      const resize = shouldResizeImage(file, { acceptedExtensions: aceita.extensoes })
      return { id: `f${itemSeq}`, file, original: null, useOriginal: false, preparing: resize, problem: resize ? '' : fileProblem(file, aceita) }
    })
    setItems((current) => [...current, ...fresh])
    for (const item of fresh) {
      if (!item.preparing) continue
      const result = await resizeImage(item.file)
      if (!mountedRef.current) return
      setItems((current) => current.map((entry) => {
        if (entry.id !== item.id) return entry
        if (!result) return { ...entry, preparing: false, problem: fileProblem(entry.file, aceita) }
        return { ...entry, file: result.file, original: entry.file, preparing: false, problem: fileProblem(result.file, aceita) }
      }))
    }
  }

  function removeItem(itemId) {
    setItems((current) => current.filter((item) => item.id !== itemId))
  }

  function toggleOriginal(itemId) {
    setItems((current) => current.map((item) => {
      if (item.id !== itemId || !item.original) return item
      const useOriginal = !item.useOriginal
      return { ...item, useOriginal, problem: fileProblem(useOriginal ? item.original : item.file, aceita) }
    }))
  }

  async function submit() {
    if (sending || preparing || !assignment) return
    setError(null)
    const hasText = resposta.text && text.trim()
    const hasLink = resposta.link && link.trim()
    if (!files.length && !hasText && !hasLink) { setError({ message: emptySubmissionText(resposta), retry: false }); return }
    const blocking = problems[0] || groupProblem || linkError
    if (blocking) { setError({ message: blocking, retry: false }); return }
    const versionsBefore = versions.length
    setPhase('sending')
    setProgress(0)
    try {
      const form = buildSubmissionForm({ files, text, link, resposta })
      const result = await uploadWithProgress(submitPath(assignment.id), form, { onProgress: ({ percent }) => { if (mountedRef.current) setProgress(percent) } })
      if (!mountedRef.current) return
      setItems([])
      setText('')
      setLink('')
      setReceipt({ version: result?.version || null, recovered: false })
      detail.refetch(true)
    } catch (err) {
      if (!mountedRef.current) return
      // Sem resposta (rede caiu, prazo): o envio pode ter chegado. Confere antes de pedir
      // para mandar de novo (mandar de novo criaria outra versão).
      if (err && err.status === 0 && !err.aborted) await detail.refetch(true)
      setError({ message: err?.message || 'Não foi possível enviar agora. Tente de novo.', retry: err?.status === 0 || err?.retryable === true || err?.data?.retryable === true, versionsBefore })
    } finally {
      if (mountedRef.current) setPhase('idle')
    }
  }

  // A resposta do envio se perdeu, mas a versão nova apareceu ao recarregar: o envio
  // chegou. Mostra o comprovante dela e limpa a escolha (mandar de novo duplicaria).
  useEffect(() => {
    if (!error || typeof error.versionsBefore !== 'number' || !error.retry) return
    if (versions.length > error.versionsBefore) {
      setReceipt({ version: versions[versions.length - 1], recovered: true })
      setItems([])
      setText('')
      setLink('')
      setError(null)
    }
  }, [versions, error])

  function printReceipt(version) {
    setPrintError('')
    const win = openPrintWindow('Preparando o comprovante…')
    const ok = printDocument(receiptDocument({
      assignment,
      version,
      student: { name: displayName || name || '', email, studentClass, courseName },
      escola: schoolFromBranding(branding),
      displayName: branding?.displayName || '',
      timezone,
      geradoEm: now,
    }), win)
    if (!ok) setPrintError('O navegador bloqueou a janela do comprovante. Permita janelas deste endereço e tente de novo.')
  }

  const receiptVersion = receipt?.version ? (versions.find((item) => item.n === receipt.version.n) || receipt.version) : null

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex items-center justify-between gap-3">
        <Link to="/aluno/atividades" className="inline-flex min-h-[44px] items-center gap-2 rounded-lg px-2 text-sm text-muted hover:bg-surface-2 hover:text-text"><ArrowLeft aria-hidden="true" size={16} /> Atividades</Link>
        <HelpLink topic="atividades" doc="aluno" className="h-11 w-11" />
      </div>
      <PageState loading={detail.loading && !data} error={data ? null : detail.error} onRetry={detail.refetch}>
        {assignment && (
          <>
            <div>
              <h1 className="break-words text-2xl font-bold text-text">{assignment.title}</h1>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge tone={situationTone(row)}>{data.situacaoTexto}</Badge>
                {assignment.prazoIndividual && <Badge tone="info">Prazo combinado só para você</Badge>}
              </div>
              <p className="mt-3 text-sm text-text">{deadlineLine(row, now, timezone)}</p>
              {closeLine(assignment.closeAt, timezone, now) && <p className="text-sm text-muted">{closeLine(assignment.closeAt, timezone, now)}</p>}
              <p className="mt-1 text-sm text-muted">{assignment.regraAtraso}</p>
              <p className="mt-1 flex items-center gap-1.5 text-xs text-subtle"><Clock aria-hidden="true" size={13} /> Hora no computador do professor: {timeText(now, timezone)}</p>
            </div>

            {devolucao && (
              <Card className="space-y-3 p-5">
                <h2 className="flex items-center gap-2 font-semibold text-text"><CheckCircle2 aria-hidden="true" size={18} className="text-success" /> Devolvida pelo professor</h2>
                <div className="flex flex-wrap items-end gap-6">
                  <div><p className="text-xs uppercase tracking-wider text-subtle">Nota final</p><p className="text-4xl font-semibold tabular-nums text-text">{devolucao.notaFinal}</p></div>
                  {devolucao.desconto > 0 && <div className="text-sm text-muted"><p>Nota: {devolucao.nota}</p><p>{devolucao.descontoTexto}</p></div>}
                </div>
                {data.devolucao.comentario && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-subtle">Comentário do professor</p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm text-text">{data.devolucao.comentario}</p>
                  </div>
                )}
              </Card>
            )}

            {data.refazer && (
              <Card className="space-y-2 border-warning/40 p-5">
                <h2 className="flex items-center gap-2 font-semibold text-text"><RotateCcw aria-hidden="true" size={18} className="text-warning" /> O professor pediu para refazer</h2>
                <p className="text-sm text-text">Envie a nova versão até {dateTimeText(data.refazer.ate, timezone, now)}.</p>
                {data.refazer.comentario && <p className="whitespace-pre-wrap break-words text-sm text-muted">{data.refazer.comentario}</p>}
              </Card>
            )}

            {receiptVersion && (
              <div ref={receiptRef} tabIndex={-1} role="status" className="rounded-xl border border-success/40 bg-success-soft p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                <p className="flex items-center gap-2 font-semibold text-success"><CheckCircle2 aria-hidden="true" size={18} /> {receipt.recovered ? 'O seu envio chegou ao professor.' : 'Envio recebido.'}</p>
                <p className="mt-1 break-words text-sm text-text">{receiptLine(receiptVersion, timezone)}</p>
                <Button type="button" variant="secondary" size="sm" icon={Printer} className="mt-3 h-11" onClick={() => printReceipt(receiptVersion)}>Imprimir comprovante</Button>
              </div>
            )}
            {printError && <p role="alert" className="text-sm text-danger">{printError}</p>}

            {(instructionsHtml || (assignment.materiais || []).length > 0) && (
              <Card className="space-y-4 p-5">
                {instructionsHtml && (
                  <div>
                    <h2 className="mb-2 font-semibold text-text">Instruções</h2>
                    <div className="prose-iclass break-words text-sm" dangerouslySetInnerHTML={{ __html: instructionsHtml }} />
                  </div>
                )}
                {(assignment.materiais || []).length > 0 && (
                  <div>
                    <h2 className="mb-2 font-semibold text-text">Materiais de apoio</h2>
                    <ul className="space-y-1">
                      {assignment.materiais.map((item) => (
                        <li key={item.id}><a href={item.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[44px] items-center gap-2 break-all text-sm font-medium text-primary hover:underline"><ExternalLink aria-hidden="true" size={15} /> {item.name || 'Material'}</a></li>
                      ))}
                    </ul>
                  </div>
                )}
              </Card>
            )}

            <Card className="space-y-2 p-5">
              <h2 className="font-semibold text-text">O que enviar</h2>
              {responseKindsText(resposta) && <p className="text-sm text-text">Responda com {responseKindsText(resposta)}.</p>}
              {resposta.files && (
                <>
                  <p className="text-sm text-muted">Tipos aceitos: {(aceita.tipos || []).join(', ') || (aceita.extensoes || []).join(', ')}.</p>
                  <p className="text-sm text-muted">{limitsText(aceita)}</p>
                </>
              )}
            </Card>

            {accepts ? (
              <Card className="space-y-4 p-5">
                <h2 className="font-semibold text-text">{versions.length ? 'Enviar nova versão' : 'Enviar'}</h2>
                {versions.length > 0 && <p className="text-sm text-muted">As versões anteriores continuam guardadas. O professor corrige a mais recente.</p>}
                {resposta.files && (
                  <div className="space-y-3">
                    <input
                      ref={inputRef}
                      id="atividade-arquivos"
                      type="file"
                      className="sr-only"
                      accept={aceita.accept || undefined}
                      multiple={(Number(aceita.maxFiles) || 1) > 1}
                      disabled={sending}
                      onChange={(event) => { addFiles(event.target.files); event.target.value = '' }}
                    />
                    <label htmlFor="atividade-arquivos" className={`flex min-h-[56px] w-full cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary/40 bg-primary-soft px-4 py-3 text-center text-sm font-semibold text-primary transition hover:border-primary focus-within:ring-2 focus-within:ring-primary ${sending ? 'pointer-events-none opacity-50' : ''}`}>
                      <Camera aria-hidden="true" size={18} /> Escolher arquivo ou tirar foto
                    </label>
                    {items.length > 0 && (
                      <ul className="space-y-2" aria-label="Arquivos escolhidos">
                        {items.map((item) => <FileRow key={item.id} item={item} maxSizeMb={aceita.maxSizeMb} onRemove={removeItem} onToggleOriginal={toggleOriginal} disabled={sending} />)}
                      </ul>
                    )}
                    {groupProblem && <p role="alert" className="text-sm text-danger">{groupProblem}</p>}
                  </div>
                )}
                {resposta.text && (
                  <Textarea label="Resposta em texto" value={text} onChange={(event) => setText(event.target.value)} maxLength={aceita.textMax || undefined} counterFrom={Math.max(0, (aceita.textMax || 0) - 500)} disabled={sending} rows={5} />
                )}
                {resposta.link && (
                  <Input label="Link (endereço que comece com http:// ou https://)" type="url" inputMode="url" autoComplete="off" value={link} onChange={(event) => setLink(event.target.value)} maxLength={aceita.linkMax || undefined} error={link.trim() ? linkError : ''} disabled={sending} placeholder="https://" />
                )}
                {lateNow && (
                  <p className="flex items-start gap-2 rounded-lg bg-warning-soft p-3 text-sm text-warning"><AlertTriangle aria-hidden="true" size={16} className="mt-0.5 shrink-0" /> <span>Você está enviando com atraso. {assignment.regraAtraso}</span></p>
                )}
                <div className="atividade-envio-barra space-y-3 rounded-xl border border-border bg-surface p-3 shadow-[var(--shadow-float,0_8px_24px_rgba(0,0,0,.12))]">
                  {sending && <ProgressBar percent={progress} />}
                  <div aria-live="polite" className="text-sm">
                    {sending && <span className="text-muted">{progress >= 100 ? 'Arquivos enviados. Esperando a confirmação do professor…' : 'Enviando… não feche esta página.'}</span>}
                    {error && !sending && <span role="alert" className="text-danger">{error.message}</span>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="lg" icon={error?.retry ? RotateCcw : Send} className="h-12 flex-1" onClick={submit} loading={sending} disabled={preparing}>
                      {sending ? 'Enviando…' : error?.retry ? 'Tentar de novo' : lateNow ? 'Enviar com atraso' : 'Enviar'}
                    </Button>
                  </div>
                  {preparing && <p className="text-xs text-muted">Preparando a foto para enviar…</p>}
                </div>
              </Card>
            ) : (
              data.motivo && !devolucao && <p role="status" className="rounded-lg border border-border bg-surface-2 p-3 text-sm text-muted">{data.motivo}</p>
            )}

            {data.minhaEntrega?.entregaEmMaos && <p className="rounded-lg border border-border bg-surface-2 p-3 text-sm text-muted">O professor registrou a entrega em mãos em {dateTimeText(data.minhaEntrega.entregaEmMaos.at, timezone, now)}.</p>}

            {versions.length > 0 && (
              <section aria-labelledby="atividade-versoes" className="space-y-2">
                <h2 id="atividade-versoes" className="px-1 text-xs font-semibold uppercase tracking-wider text-subtle">Versões enviadas ({versions.length})</h2>
                <ul className="space-y-2">
                  {[...versions].reverse().map((version) => (
                    <VersionCard key={version.n} version={version} assignmentId={assignment.id} timezone={timezone} onPrint={printReceipt} highlight={devolucao && data.devolucao.versaoCorrigida === version.n} />
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </PageState>
    </div>
  )
}
