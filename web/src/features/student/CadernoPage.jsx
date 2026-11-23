import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Download, Printer, Save } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../components/ui/Card'
import { Textarea } from '../../components/ui/Textarea'
import { Button } from '../../components/ui/Button'
import { HelpLink } from '../../components/ui/HelpLink'
import { api } from '../../lib/api'
import { useStudent } from './useStudent'
import { usePreview } from '../../hooks/usePreview'
import { PREVIEW_DISABLED_TEXT } from '../../lib/previewSession'
import { PreviewDisabledNote } from './PreviewBanner'
import { useToast } from '../../context/ToastProvider'
import { useBranding } from '../../context/BrandingProvider'
import { NOTE_COUNTER_FROM, NOTE_MAX_CHARS } from '../../lib/textLimits'
import { openPrintWindow, printDocument, schoolFromBranding } from '../../lib/printDocument'
import { notebookFileName, notebookPrintOptions, notebookSections, notebookText } from './cadernoExport'
import { unitHref } from './unitLinks'

// Caderno do aluno. A nota geral continua editável aqui; "Minhas notas por unidade"
// (fase 3, C17 / P5-S3; UXA-14, D25 do P5) mostra a nota de cada unidade e os destaques
// de parágrafo, com o título da unidade, e o aluno leva tudo: "Imprimir caderno" (folha
// da escola, printDocument) e "Baixar caderno (.txt)" (arquivo gerado no aparelho, sem
// internet). A nota de cada unidade continua sendo escrita no leitor da apostila.
export default function CadernoPage() {
  const { email, displayName, name, courseId, studentClass, courses } = useStudent()
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [notebook, setNotebook] = useState(null)
  const [notebookError, setNotebookError] = useState('')
  const [printError, setPrintError] = useState('')
  const moduleKey = 'geral'
  const toast = useToast()
  const { branding } = useBranding()
  const courseName = (courses || []).find((course) => course && course.id === courseId)?.name || ''
  const studentName = displayName || name || ''
  // Pré-visualização como aluno (C15 / P5-S6b): o caderno do aluno virtual vem vazio e
  // Salvar fica desativado.
  const preview = usePreview()
  useEffect(() => {
    api.post('/api/student/notes/get', { email, moduleKey }).then((r) => setNote(r.note || '')).catch(() => {})
    // eslint-disable-next-line
  }, [])

  const loadNotebook = useCallback(() => {
    if (!courseId || !studentClass) return
    setNotebookError('')
    api.get(`/api/student/notebook?courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(studentClass)}`)
      .then((data) => setNotebook(data && typeof data === 'object' ? data : { geral: '', unidades: [] }))
      .catch((error) => setNotebookError(error?.message || 'Não foi possível carregar as notas das unidades.'))
  }, [courseId, studentClass])
  useEffect(() => { loadNotebook() }, [loadNotebook])

  async function save() {
    if (preview) return
    setSaving(true)
    try { await api.post('/api/student/notes/save', { email, moduleKey, note }); toast.success('Caderno salvo') }
    catch (e) { toast.error(e.message) } finally { setSaving(false) }
  }

  // O que sai no papel e no .txt: a nota geral como está na tela (também a que ainda não
  // foi salva) e as notas das unidades como estão gravadas.
  const exportInput = () => ({
    notebook,
    geral: note,
    studentName,
    courseName,
    studentClass,
    timeZone: (notebook && notebook.timezone) || undefined,
    when: new Date(),
  })

  function printNotebook() {
    setPrintError('')
    const win = openPrintWindow('Preparando o caderno…')
    const ok = printDocument(notebookPrintOptions({
      ...exportInput(),
      escola: schoolFromBranding(branding),
      displayName: branding?.displayName || '',
    }), win)
    if (!ok) setPrintError('O navegador bloqueou a janela do caderno. Permita janelas deste endereço e tente de novo.')
  }

  function downloadNotebook() {
    const input = exportInput()
    const blob = new Blob([notebookText(input)], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = notebookFileName(courseName, input.when)
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const units = notebookSections(notebook, { geral: '' })

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0"><h1 className="text-2xl font-bold text-text">Caderno</h1><p className="text-sm text-muted">Suas anotações, salvas na sua conta.</p></div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={Printer} className="h-11" onClick={printNotebook}>Imprimir caderno</Button>
          <Button variant="secondary" icon={Download} className="h-11" onClick={downloadNotebook}>Baixar caderno (.txt)</Button>
          <HelpLink topic="caderno" doc="aluno" className="h-11 w-11 shrink-0" />
        </div>
      </div>
      {printError && <p role="alert" className="text-sm text-danger">{printError}</p>}
      <Card>
        <CardHeader title="Minhas anotações" action={<Button icon={Save} loading={saving} disabled={!!preview} title={preview ? PREVIEW_DISABLED_TEXT : undefined} onClick={save}>Salvar</Button>} />
        <CardBody><Textarea id="nb" value={note} onChange={(e) => setNote(e.target.value)} maxLength={NOTE_MAX_CHARS} counterFrom={NOTE_COUNTER_FROM} className="min-h-[360px]" placeholder="Escreva aqui…" /><PreviewDisabledNote className="mt-2" /></CardBody>
      </Card>
      <Card>
        <CardHeader title="Minhas notas por unidade" subtitle="O que você escreveu no caderno de cada unidade e nos parágrafos da apostila." />
        <CardBody className="space-y-4">
          {notebookError ? (
            <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-danger">
              <span className="min-w-0 flex-1 break-words">{notebookError}</span>
              <Button size="sm" variant="secondary" onClick={loadNotebook}>Tentar de novo</Button>
            </div>
          ) : !notebook ? (
            <p role="status" className="text-sm text-muted">Carregando…</p>
          ) : units.length === 0 ? (
            <p className="text-sm text-muted">Nenhuma nota de unidade ainda. Abra uma apostila em Módulos e escreva no caderno da unidade ou toque num parágrafo para anotar.</p>
          ) : units.map((unit, index) => {
            const key = unit.chave
            return (
              <section key={`${key || unit.titulo}-${index}`} aria-label={unit.titulo} className="rounded-lg border border-border p-3 space-y-2">
                <div className="min-w-0">
                  <h2 className="break-words text-sm font-semibold text-text">{key ? <Link to={unitHref(key)} className="hover:underline">{unit.titulo}</Link> : unit.titulo}</h2>
                  {unit.modulo && <p className="break-words text-xs text-subtle">{unit.modulo}</p>}
                </div>
                {unit.nota && <p className="whitespace-pre-wrap break-words text-sm text-text">{unit.nota}</p>}
                {unit.destaques.length > 0 && (
                  <ul className="space-y-2">
                    {unit.destaques.map((item, i) => (
                      <li key={`${item.paragrafo || i}`} className="border-l-2 border-warning pl-3 text-sm">
                        {item.trecho && <p className="break-words italic text-muted">“{item.trecho}”</p>}
                        {item.nota && <p className="whitespace-pre-wrap break-words text-text">{item.nota}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )
          })}
        </CardBody>
      </Card>
    </div>
  )
}
