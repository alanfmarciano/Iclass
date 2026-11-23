import { useState, useEffect } from 'react'
import { Save, NotebookPen } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../components/ui/Card'
import { Textarea } from '../../components/ui/Textarea'
import { Button } from '../../components/ui/Button'
import { api } from '../../lib/api'
import { useStudent } from './useStudent'
import { usePreview } from '../../hooks/usePreview'
import { PREVIEW_DISABLED_TEXT } from '../../lib/previewSession'
import { PreviewDisabledNote } from './PreviewBanner'
import { useToast } from '../../context/ToastProvider'
import { NOTE_COUNTER_FROM, NOTE_MAX_CHARS } from '../../lib/textLimits'

export default function CadernoPage() {
  const { email } = useStudent()
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const moduleKey = 'geral'
  const toast = useToast()
  // Pré-visualização como aluno (C15 / P5-S6b): o caderno do aluno virtual vem vazio e
  // Salvar fica desativado.
  const preview = usePreview()
  useEffect(() => {
    api.post('/api/student/notes/get', { email, moduleKey }).then((r) => setNote(r.note || '')).catch(() => {})
    // eslint-disable-next-line
  }, [])
  async function save() {
    if (preview) return
    setSaving(true)
    try { await api.post('/api/student/notes/save', { email, moduleKey, note }); toast.success('Caderno salvo') }
    catch (e) { toast.error(e.message) } finally { setSaving(false) }
  }
  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div><h1 className="text-2xl font-bold text-text">Caderno</h1><p className="text-sm text-muted">Suas anotações, salvas na sua conta.</p></div>
      <Card>
        <CardHeader title="Minhas anotações" action={<Button icon={Save} loading={saving} disabled={!!preview} title={preview ? PREVIEW_DISABLED_TEXT : undefined} onClick={save}>Salvar</Button>} />
        <CardBody><Textarea id="nb" value={note} onChange={(e) => setNote(e.target.value)} maxLength={NOTE_MAX_CHARS} counterFrom={NOTE_COUNTER_FROM} className="min-h-[360px]" placeholder="Escreva aqui…" /><PreviewDisabledNote className="mt-2" /></CardBody>
      </Card>
    </div>
  )
}
