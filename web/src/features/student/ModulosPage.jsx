import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, BookOpen, CheckCircle2, Highlighter, Lock, MessageSquare, NotebookPen, Reply, Save, Trash2 } from 'lucide-react'
import { Card, CardBody, CardHeader } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageState } from '../../components/ui/PageState'
import { Modal, ConfirmDialog } from '../../components/ui/Modal'
import { Textarea } from '../../components/ui/Textarea'
import { api } from '../../lib/api'
import { markdownToHtml } from '../../lib/contentMarkdown'
import { useApi } from '../../hooks/useApi'
import { useToast } from '../../context/ToastProvider'
import { useStudent } from './useStudent'

function parseDataJs(source) {
  const text = String(source || '').trim().replace(/^const\s+courseData\s*=\s*/, '').replace(/;?\s*$/, '')
  try { return JSON.parse(text) } catch { return {} }
}

function normalizeUnit(mod, unit, index) {
  return {
    key: unit.apostilaKey || unit.key,
    examKey: unit.avaliacaoKey,
    title: unit.name || unit.title || `Unidade ${index + 1}`,
    moduleKey: mod.id || mod.key || mod.title || mod.name || 'module',
    moduleTitle: mod.title || mod.name || mod.id || 'Módulo',
  }
}

function unitKey(unit) {
  return unit.apostilaKey || unit.key
}

function moduleUnitKeys(mod) {
  return (mod.units || mod.items || []).map(unitKey).filter(Boolean)
}

function moduleProgress(mod, completed) {
  const keys = moduleUnitKeys(mod)
  const done = keys.filter((key) => completed[key]).length
  const total = keys.length
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 }
}

export default function ModulosPage() {
  const { email, name, studentClass, courseId } = useStudent()
  const toast = useToast()
  const articleRef = useRef(null)
  const status = useApi(`/api/status?studentClass=${encodeURIComponent(studentClass)}&courseId=${encodeURIComponent(courseId)}&email=${encodeURIComponent(email)}`, [], { pollMs: 5000 })
  const progress = useApi(`/api/student/progress?email=${encodeURIComponent(email)}`, [email])
  const [courseData, setCourseData] = useState({})
  const [dataError, setDataError] = useState(null)
  const [openUnit, setOpenUnit] = useState(null)
  const [html, setHtml] = useState('')
  const [note, setNote] = useState('')
  const [comments, setComments] = useState([])
  const [commentText, setCommentText] = useState('')
  const [replyDrafts, setReplyDrafts] = useState({})
  const [annotation, setAnnotation] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!courseId) return
    // Passa pelo cliente de API para enviar o token do aluno (a rota agora exige sessão).
    api.get(`/api/data.js?courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(studentClass)}`, { raw: true })
      .then((text) => setCourseData(parseDataJs(text)))
      .catch((e) => setDataError(e))
  }, [courseId, studentClass])

  const released = (status.data && status.data.releasedItems) || {}
  const completed = (progress.data && progress.data.completedUnits) || {}
  const rawModules = (courseData.courses && courseData.courses[0]?.structure) || courseData.courseStructure || []
  const baseModules = Array.isArray(rawModules) ? rawModules : []
  const fallbackUnits = Object.keys(released)
    .filter((key) => released[key] && key.startsWith('Apostila_'))
    .map((key, index) => ({ id: String(index + 1), name: key.replace(/_/g, ' '), apostilaKey: key }))
  const modules = baseModules.length > 0 ? baseModules : (fallbackUnits.length > 0 ? [{ id: 'released', name: 'Materiais liberados', units: fallbackUnits }] : [])
  const units = useMemo(() => modules.flatMap((mod) => (mod.units || mod.items || []).map((unit, i) => normalizeUnit(mod, unit, i))).filter((u) => u.key), [modules])
  const openModuleUnits = useMemo(() => openUnit ? units.filter((unit) => unit.moduleKey === openUnit.moduleKey) : [], [openUnit, units])
  const openModuleDone = openModuleUnits.filter((unit) => completed[unit.key]).length
  const openModuleTotal = openModuleUnits.length
  const openModulePct = openModuleTotal ? Math.round((openModuleDone / openModuleTotal) * 100) : 0

  async function openReader(unit) {
    setOpenUnit(unit)
    let text = courseData[unit.key]
    if (typeof text !== 'string') {
      // O data.js só traz apostilas já liberadas; se o professor liberou esta unidade
      // depois que a página abriu, busca só ela (o servidor confere a liberação).
      text = await api.get(`/${encodeURIComponent(unit.key)}.md`, { raw: true }).catch(() => '')
      if (text) setCourseData((current) => ({ ...current, [unit.key]: text }))
    }
    setHtml(markdownToHtml(text || ''))
    api.post('/api/student/track-access', { email, key: unit.key, moduleKey: unit.moduleKey || '', courseId }).catch(() => {})
    await Promise.all([loadNote(unit.key), loadComments(unit.key), loadAnnotations(unit.key)])
  }

  async function loadNote(key) {
    try { setNote((await api.post('/api/student/notes/get', { email, moduleKey: key })).note || '') } catch { setNote('') }
  }

  async function saveNote() {
    if (!openUnit) return
    setSaving(true)
    try { await api.post('/api/student/notes/save', { email, moduleKey: openUnit.key, note }); toast.success('Caderno salvo') }
    catch (e) { toast.error(e.message) } finally { setSaving(false) }
  }

  async function markDone(done) {
    if (!openUnit) return
    const next = { ...completed, [openUnit.key]: done }
    try {
      await api.post('/api/student/progress', { email, completedUnits: next })
      progress.refetch()
      toast.success(done ? 'Unidade concluída' : 'Conclusão removida')
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function loadAnnotations(key) {
    try {
      // Com a sessão do aluno: sem ela a rota responde 401 e as anotações nunca aparecem (UXA-10).
      const r = await api.get(`/api/student/annotations?email=${encodeURIComponent(email)}&key=${encodeURIComponent(key)}`)
      paintAnnotations(r.annotations || {})
    } catch {
      paintAnnotations({})
    }
  }

  function paintAnnotations(annotations) {
    setTimeout(() => {
      const nodes = articleRef.current?.querySelectorAll('p, li, blockquote') || []
      nodes.forEach((node, index) => {
        const id = `p${index + 1}`
        node.dataset.paraId = id
        node.classList.toggle('bg-warning/10', !!annotations[id])
        node.classList.toggle('rounded-md', !!annotations[id])
        node.classList.toggle('px-2', !!annotations[id])
        node.onclick = () => setAnnotation({ paragraphId: id, highlightedText: node.textContent.trim(), note: annotations[id]?.note || '' })
      })
    }, 0)
  }

  async function saveAnnotation() {
    if (!openUnit || !annotation) return
    try {
      await api.post('/api/student/annotation', { email, key: openUnit.key, ...annotation })
      setAnnotation(null)
      loadAnnotations(openUnit.key)
      toast.success('Anotação salva')
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function deleteAnnotation() {
    if (!openUnit || !annotation) return
    try {
      await api.post('/api/student/annotation', { email, key: openUnit.key, paragraphId: annotation.paragraphId, highlightedText: null, note: null })
      setAnnotation(null)
      loadAnnotations(openUnit.key)
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function loadComments(key) {
    try { setComments((await api.get(`/api/forum?key=${encodeURIComponent(key)}&courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(studentClass)}`)).comments || []) } catch { setComments([]) }
  }

  async function postComment() {
    if (!openUnit || !commentText.trim()) return
    try {
      await api.post('/api/forum/comment', { key: openUnit.key, studentName: name, studentEmail: email, courseId, studentClass, text: commentText })
      setCommentText('')
      loadComments(openUnit.key)
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function postReply(commentId) {
    const text = replyDrafts[commentId]
    if (!text?.trim()) return
    try {
      await api.post('/api/forum/reply', { commentId, courseId, studentClass, authorName: name, authorRole: 'Aluno', authorEmail: email, text })
      setReplyDrafts((d) => ({ ...d, [commentId]: '' }))
      loadComments(openUnit.key)
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function removeForumItem() {
    if (!deleteTarget) return
    try {
      if (deleteTarget.replyId) await api.post('/api/forum/reply/delete', { commentId: deleteTarget.commentId, replyId: deleteTarget.replyId, courseId, studentClass, email })
      else await api.post('/api/forum/comment/delete', { commentId: deleteTarget.commentId, courseId, studentClass, email })
      setDeleteTarget(null)
      loadComments(openUnit.key)
    } catch (e) {
      toast.error(e.message)
    }
  }

  if (openUnit) return (
    <div className="max-w-6xl mx-auto space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" icon={ArrowLeft} onClick={() => setOpenUnit(null)}>Voltar aos módulos</Button>
        <Badge tone={completed[openUnit.key] ? 'success' : 'neutral'}>{completed[openUnit.key] ? 'Concluída' : 'Em estudo'}</Badge>
        <Button size="sm" variant="secondary" icon={CheckCircle2} onClick={() => markDone(!completed[openUnit.key])}>{completed[openUnit.key] ? 'Desmarcar' : 'Concluir unidade'}</Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-4">
        <Card className="p-6">
          <article ref={articleRef} className="prose-iclass cursor-text" dangerouslySetInnerHTML={{ __html: html || '<p>Conteúdo indisponível.</p>' }} />
          <div className="mt-8 pt-5 border-t border-border">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-text">Progresso deste módulo</p>
                <p className="text-xs text-muted">{openModuleDone} de {openModuleTotal} tópicos concluídos em {openUnit.moduleTitle}</p>
              </div>
              <Badge tone={completed[openUnit.key] ? 'success' : 'neutral'}>{openModulePct}%</Badge>
            </div>
            <div className="mt-3 h-2 rounded-full bg-surface-2 overflow-hidden">
              <div className="h-full bg-primary transition-all" style={{ width: `${openModulePct}%` }} />
            </div>
            <div className="mt-4 flex justify-end">
              <Button icon={CheckCircle2} onClick={() => markDone(!completed[openUnit.key])}>
                {completed[openUnit.key] ? 'Desmarcar tópico' : 'Marcar tópico como concluído'}
              </Button>
            </div>
          </div>
          <p className="mt-6 text-xs text-subtle flex items-center gap-1"><Highlighter size={14} /> Clique em um parágrafo para criar ou revisar uma anotação.</p>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Caderno desta unidade" action={<Button size="sm" icon={Save} loading={saving} onClick={saveNote}>Salvar</Button>} />
            <CardBody><Textarea id="unit-note" value={note} onChange={(e) => setNote(e.target.value)} className="min-h-[180px]" placeholder="Suas anotações..." /></CardBody>
          </Card>
          <Card>
            <CardHeader title="Fórum da unidade" />
            <CardBody className="space-y-3">
              <Textarea id="unit-comment" value={commentText} onChange={(e) => setCommentText(e.target.value)} placeholder="Escreva sua dúvida..." />
              <Button size="sm" icon={MessageSquare} onClick={postComment}>Postar</Button>
              {comments.map((c) => (
                <div key={c.id} className="rounded-md border border-border p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <b className="text-text">{c.studentName}</b>
                    {c.studentEmail?.toLowerCase() === email?.toLowerCase() && <button className="text-subtle hover:text-danger" onClick={() => setDeleteTarget({ commentId: c.id })}><Trash2 size={14} /></button>}
                  </div>
                  <p className="text-muted mt-1">{c.text}</p>
                  {(c.replies || []).map((r) => (
                    <div key={r.id} className="mt-2 pl-3 border-l-2 border-border">
                      <div className="flex items-center justify-between gap-2">
                        <span><b className="text-text">{r.authorName || r.authorRole}</b>: <span className="text-muted">{r.text}</span></span>
                        {r.authorEmail?.toLowerCase() === email?.toLowerCase() && <button className="text-subtle hover:text-danger" onClick={() => setDeleteTarget({ commentId: c.id, replyId: r.id })}><Trash2 size={14} /></button>}
                      </div>
                    </div>
                  ))}
                  <div className="mt-2 flex gap-2">
                    <input value={replyDrafts[c.id] || ''} onChange={(e) => setReplyDrafts((d) => ({ ...d, [c.id]: e.target.value }))} placeholder="Responder..." className="min-w-0 flex-1 h-8 px-2 rounded-md bg-surface border border-border text-text text-xs" />
                    <Button size="sm" variant="secondary" icon={Reply} onClick={() => postReply(c.id)}>Responder</Button>
                  </div>
                </div>
              ))}
            </CardBody>
          </Card>
        </div>
      </div>

      <Modal open={!!annotation} onClose={() => setAnnotation(null)} title="Anotação do parágrafo" description={annotation?.highlightedText?.slice(0, 120)}>
        <Textarea id="ann" value={annotation?.note || ''} onChange={(e) => setAnnotation((a) => ({ ...a, note: e.target.value }))} className="min-h-[140px]" />
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="destructive" icon={Trash2} onClick={deleteAnnotation}>Excluir</Button>
          <Button icon={NotebookPen} onClick={saveAnnotation}>Salvar</Button>
        </div>
      </Modal>
      <ConfirmDialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} onConfirm={removeForumItem} danger title="Excluir mensagem?" description="A mensagem será removida do fórum desta unidade." confirmLabel="Excluir" />
    </div>
  )

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text">Módulos</h1>
        <p className="text-sm text-muted">Apostilas, progresso e atividades liberadas para sua turma.</p>
      </div>
      <PageState loading={status.loading} error={status.error || dataError} onRetry={() => { status.refetch(); progress.refetch() }}>
        {modules.length === 0 ? (
          <Card><EmptyState icon={BookOpen} title="Curso sem estrutura" description="Nenhum módulo foi encontrado para seu curso." /></Card>
        ) : modules.map((mod, mi) => {
          const modProgress = moduleProgress(mod, completed)
          return (
            <Card key={mod.id || mi}>
              <CardHeader title={mod.title || mod.name || `Módulo ${mi + 1}`} subtitle={`${modProgress.done} de ${modProgress.total} tópicos concluídos`} action={<Badge tone={modProgress.pct === 100 ? 'success' : 'neutral'}>{modProgress.pct}%</Badge>} />
              <CardBody>
                <div className="mb-4 h-2 rounded-full bg-surface-2 overflow-hidden">
                  <div className="h-full bg-primary transition-all" style={{ width: `${modProgress.pct}%` }} />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {(mod.units || mod.items || []).map((unit, ui) => {
                    const u = normalizeUnit(mod, unit, ui)
                    const on = !!released[u.key]
                    const done = !!completed[u.key]
                    return (
                      // Título em até duas linhas: o nome do tópico era cortado ("Sistemas Opera…")
                      // e a chave técnica (Apostila_FUTEC_1) ocupava o lugar do status.
                      <button type="button" key={u.key} disabled={!on} onClick={() => openReader(u)} title={u.title} className="w-full flex items-center gap-3 p-3 rounded-lg border border-border text-left transition hover:border-primary/50 disabled:cursor-default disabled:hover:border-border">
                        <span className={`w-10 h-10 shrink-0 grid place-items-center rounded-md ${done ? 'bg-success-soft text-success' : on ? 'bg-primary-soft text-primary' : 'bg-surface-2 text-subtle'}`}>{done ? <CheckCircle2 size={18} /> : on ? <BookOpen size={18} /> : <Lock size={18} />}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium leading-snug text-text line-clamp-2">{u.title}</p>
                          <p className={`mt-0.5 text-xs ${done ? 'text-success' : 'text-subtle'}`}>{done ? 'Concluído' : on ? 'Disponível' : 'Bloqueado pelo instrutor'}</p>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </CardBody>
            </Card>
          )
        })}
        {units.length === 0 && <Card><EmptyState icon={BookOpen} title="Sem unidades" description="A estrutura do curso não possui apostilas." /></Card>}
      </PageState>
    </div>
  )
}
