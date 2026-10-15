import { useState, useEffect, useMemo } from 'react'
import { MessagesSquare, Send, Trash2, Star, CircleCheck, RotateCcw, History, Search, Zap, Plus, X, Clock, ChevronDown } from 'lucide-react'
import { Card } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Textarea } from '../../components/ui/Textarea'
import { StatCard } from '../../components/ui/StatCard'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageState } from '../../components/ui/PageState'
import { PageHeader } from '../../components/ui/PageHeader'
import { Modal, ConfirmDialog } from '../../components/ui/Modal'
import { api } from '../../lib/api'
import { useAuth } from '../../context/AuthProvider'
import { useAdminWorkspace } from '../../hooks/useAdminWorkspace'
import { useToast } from '../../context/ToastProvider'
import { usePreferences } from '../../context/PreferencesProvider'

const EVENT_LABEL = {
  reply: 'respondeu', edit_comment: 'editou a dúvida', edit_reply: 'editou uma resposta',
  delete_reply: 'excluiu uma resposta', resolved: 'resolveu', reopened: 'reabriu',
  faq_added: 'marcou como FAQ', faq_removed: 'removeu do FAQ',
  delete_comment: 'excluiu a dúvida', restore_comment: 'restaurou a dúvida', restore_reply: 'restaurou uma resposta',
}
const STATUS_TONE = { aberta: 'warning', respondida: 'info', resolvida: 'success' }
const STATUS_LABEL = { aberta: 'Pendente', respondida: 'Respondida', resolvida: 'Resolvida' }

function relTime(iso) {
  if (!iso) return ''
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'agora'
  if (s < 3600) return `ha ${Math.floor(s / 60)} min`
  if (s < 86400) return `ha ${Math.floor(s / 3600)} h`
  const d = Math.floor(s / 86400)
  if (d < 30) return `ha ${d} ${d === 1 ? 'dia' : 'dias'}`
  return new Date(iso).toLocaleDateString('pt-BR')
}
function hoursSince(iso) { return iso ? (Date.now() - new Date(iso).getTime()) / 3600000 : 0 }
function initials(n) { return (n || '?').split(' ').map((x) => x[0]).slice(0, 2).join('').toUpperCase() }
function hasInstructorReply(c) { return Array.isArray(c.replies) && c.replies.some((r) => r.authorRole === 'Instrutor') }
function effectiveStatus(c) { return c.status || (hasInstructorReply(c) ? 'respondida' : 'aberta') }

export default function ForumPage() {
  const { auth } = useAuth()
  const { courseId: activeCourseId, courseName, className: activeClassName } = useAdminWorkspace()
  const isAdmin = auth.accountRole !== 'professor'
  const toast = useToast()
  const { pref, setPref } = usePreferences()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [reply, setReply] = useState({})
  const [filter, setFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [del, setDel] = useState(null)
  const [courseKeys, setCourseKeys] = useState(null)
  const [historyTarget, setHistoryTarget] = useState(null)
  const [tplOpen, setTplOpen] = useState(false)
  const [tplForm, setTplForm] = useState({ title: '', text: '' })
  const [showTrash, setShowTrash] = useState(false)
  const [purgeTarget, setPurgeTarget] = useState(null)

  const templates = pref('forum.templates', [])
  const lastSeen = pref('forum.lastSeen', null)

  const load = async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    try { setData(await api.post('/api/admin/forum/all', { courseId: activeCourseId, studentClass: activeClassName })) } catch (e) { if (!silent) setError(e) } finally { if (!silent) setLoading(false) }
  }
  useEffect(() => { load() }, [activeCourseId, activeClassName])
  useEffect(() => { const id = setInterval(() => load(true), 12000); return () => clearInterval(id) }, [activeCourseId, activeClassName])

  useEffect(() => {
    if (!activeCourseId) { setCourseKeys(null); return }
    api.get(`/api/admin/courses/${encodeURIComponent(activeCourseId)}/structure?studentClass=${encodeURIComponent(activeClassName)}`)
      .then((r) => {
        const keys = new Set()
        ;(r.structure || []).forEach((mod) => (mod.units || mod.items || []).forEach((u) => {
          if (u.apostilaKey) keys.add(u.apostilaKey)
          if (u.avaliacaoKey) keys.add(u.avaliacaoKey)
        }))
        setCourseKeys(keys)
      })
      .catch(() => setCourseKeys(new Set()))
  }, [activeCourseId, activeClassName])

  const allComments = (data && (data.comments || data.forum || (Array.isArray(data) ? data : []))) || []
  const courseComments = allComments.filter((c) => !courseKeys || courseKeys.has(c.key))
  const keys = [...new Set(courseComments.map((c) => c.key).filter(Boolean))]

  const isNew = (c) => lastSeen && c.timestamp && new Date(c.timestamp).getTime() > new Date(lastSeen).getTime()

  const comments = courseComments.filter((c) => {
    if (c.deleted) return false
    if (filter && c.key !== filter) return false
    if (statusFilter !== 'all' && effectiveStatus(c) !== statusFilter) return false
    if (search) {
      const q = search.toLowerCase()
      const inText = (c.text || '').toLowerCase().includes(q)
      const inName = (c.studentName || '').toLowerCase().includes(q)
      if (!inText && !inName) return false
    }
    return true
  }).sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))

  const stats = useMemo(() => {
    const total = courseComments.length
    const abertas = courseComments.filter((c) => effectiveStatus(c) === 'aberta').length
    const resolvidas = courseComments.filter((c) => effectiveStatus(c) === 'resolvida').length
    const answered = courseComments.map((c) => {
      const first = (c.replies || []).find((r) => r.authorRole === 'Instrutor')
      return first && c.timestamp ? (new Date(first.timestamp).getTime() - new Date(c.timestamp).getTime()) / 3600000 : null
    }).filter((x) => x !== null && x >= 0)
    const avg = answered.length ? (answered.reduce((a, b) => a + b, 0) / answered.length) : null
    return { total, abertas, resolvidas, avg }
  }, [courseComments])

  const unreadCount = courseComments.filter(isNew).length
  const trashComments = courseComments.filter((c) => c.deleted)
  const trashReplies = courseComments.filter((c) => !c.deleted).flatMap((c) => (c.replies || []).filter((r) => r.deleted).map((r) => ({ comment: c, reply: r })))
  const trashCount = trashComments.length + trashReplies.length

  async function sendReply(commentId) {
    const text = reply[commentId]
    if (!text?.trim()) return
    try {
      await api.post('/api/forum/reply', { commentId, courseId: activeCourseId, studentClass: activeClassName, authorName: auth.email || 'Instrutor', authorRole: 'Instrutor', authorEmail: auth.email, text })
      setReply((r) => ({ ...r, [commentId]: '' }))
      load()
    } catch (e) { toast.error(e.message) }
  }
  async function remove() {
    try {
      if (del.replyId) await api.post('/api/forum/reply/delete', { commentId: del.commentId, replyId: del.replyId, courseId: activeCourseId, studentClass: activeClassName, email: auth.email })
      else await api.post('/api/forum/comment/delete', { commentId: del.commentId, courseId: activeCourseId, studentClass: activeClassName, email: auth.email })
      setDel(null); load()
    } catch (e) { toast.error(e.message) }
  }
  async function editText(target) {
    const text = prompt('Editar texto:', target.text)
    if (!text || text === target.text) return
    try {
      if (target.replyId) await api.post('/api/forum/reply/edit', { commentId: target.commentId, replyId: target.replyId, courseId: activeCourseId, studentClass: activeClassName, email: auth.email, text })
      else await api.post('/api/forum/comment/edit', { commentId: target.commentId, courseId: activeCourseId, studentClass: activeClassName, email: auth.email, text })
      load()
    } catch (e) { toast.error(e.message) }
  }
  async function resolveToggle(c) {
    try { await api.post('/api/admin/forum/resolve', { commentId: c.id, courseId: activeCourseId, studentClass: activeClassName, resolved: effectiveStatus(c) !== 'resolvida' }); load() }
    catch (e) { toast.error(e.message) }
  }
  async function faqToggle(c) {
    try { await api.post('/api/admin/forum/faq', { commentId: c.id, courseId: activeCourseId, studentClass: activeClassName, faq: !c.isFaq }); toast.success(!c.isFaq ? 'Marcada como FAQ' : 'Removida do FAQ'); load() }
    catch (e) { toast.error(e.message) }
  }
  function markAllRead() { setPref('forum.lastSeen', new Date().toISOString()); toast.success('Marcadas como lidas') }
  function applyTemplate(commentId, text) { setReply((r) => ({ ...r, [commentId]: (r[commentId] ? r[commentId] + '\n' : '') + text })) }
  function addTemplate() {
    if (!tplForm.title.trim() || !tplForm.text.trim()) return toast.error('Preencha titulo e texto')
    setPref('forum.templates', [...templates, { id: 'tpl_' + Date.now(), title: tplForm.title.trim(), text: tplForm.text.trim() }])
    setTplForm({ title: '', text: '' })
  }
  function deleteTemplate(id) { setPref('forum.templates', templates.filter((t) => t.id !== id)) }
  async function restoreItem(t) { try { await api.post('/api/admin/forum/restore', { ...t, courseId: activeCourseId, studentClass: activeClassName }); toast.success('Restaurado'); load() } catch (e) { toast.error(e.message) } }
  async function purgeItem() { try { await api.post('/api/admin/forum/purge', { ...purgeTarget, courseId: activeCourseId, studentClass: activeClassName }); toast.success('Apagado definitivamente'); setPurgeTarget(null); load() } catch (e) { toast.error(e.message) } }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageHeader title="Fórum e dúvidas" subtitle={`Modere as dúvidas · ${courseName || activeCourseId} · ${activeClassName}`}>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" icon={Zap} onClick={() => setTplOpen(true)}>Respostas rapidas</Button>
          {unreadCount > 0 && <Button size="sm" variant="secondary" onClick={markAllRead}>Marcar lidas ({unreadCount})</Button>}
        </div>
      </PageHeader>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total de duvidas" value={stats.total} icon="MessagesSquare" />
        <StatCard label="Pendentes" value={stats.abertas} icon="AlertCircle" />
        <StatCard label="Resolvidas" value={stats.resolvidas} icon="CircleCheck" />
        <StatCard label="Tempo medio" value={stats.avg !== null ? `${stats.avg.toFixed(1)}h` : '-'} icon="Clock" />
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por texto ou aluno..." className="pl-9" />
          </div>
          <div className="inline-flex rounded-lg bg-surface-2 p-1 text-sm">
            {[['all', 'Todas'], ['aberta', 'Pendentes'], ['respondida', 'Respondidas'], ['resolvida', 'Resolvidas']].map(([v, label]) => (
              <button key={v} onClick={() => setStatusFilter(v)} className={`px-3 py-1.5 rounded-md font-medium ${statusFilter === v ? 'bg-surface text-text shadow-sm' : 'text-muted'}`}>{label}</button>
            ))}
          </div>
        </div>
        {keys.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={!filter ? 'primary' : 'secondary'} onClick={() => setFilter('')}>Todos os módulos</Button>
            {keys.map((k) => <Button key={k} size="sm" variant={filter === k ? 'primary' : 'secondary'} onClick={() => setFilter(k)}>{k}</Button>)}
          </div>
        )}
      </div>

      <PageState loading={loading} error={error} onRetry={load}>
        {comments.length === 0 ? (
          <Card><EmptyState icon={MessagesSquare} title="Nenhuma dúvida" description="Ajuste os filtros ou aguarde os alunos postarem." /></Card>
        ) : comments.map((c) => {
          const status = effectiveStatus(c)
          const overdue = status === 'aberta' && hoursSince(c.timestamp) > 24
          const nova = isNew(c)
          return (
            <Card key={c.id} className={`p-4 ${status === 'aberta' ? 'border-warning/40' : ''}`}>
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <span className="w-8 h-8 rounded-full bg-primary-soft text-primary grid place-items-center text-xs font-semibold">{initials(c.studentName)}</span>
                <span className="font-medium text-text">{c.studentName || 'Aluno'}</span>
                <span className="text-xs text-subtle">{relTime(c.timestamp)}</span>
                <Badge tone="neutral">{c.key || 'geral'}</Badge>
                {nova && <Badge tone="info">Novo</Badge>}
                {c.isFaq && <Badge tone="success">FAQ</Badge>}
                {overdue && <span className="inline-flex items-center gap-1 text-xs text-danger"><Clock size={12} /> {Math.floor(hoursSince(c.timestamp))}h sem resposta</span>}
                <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
                <div className="ml-auto flex items-center gap-1">
                  <button aria-label="FAQ" className={`w-7 h-7 grid place-items-center rounded-md hover:bg-surface-2 ${c.isFaq ? 'text-warning' : 'text-subtle'}`} onClick={() => faqToggle(c)}><Star size={15} className={c.isFaq ? 'fill-warning' : ''} /></button>
                  <button aria-label="Histórico" className="w-7 h-7 grid place-items-center rounded-md text-subtle hover:bg-surface-2 hover:text-text" onClick={() => setHistoryTarget(c)}><History size={15} /></button>
                  <button aria-label="Editar" className="text-xs text-subtle hover:text-text px-1" onClick={() => editText({ commentId: c.id, text: c.text })}>Editar</button>
                  <button aria-label="Excluir" className="w-7 h-7 grid place-items-center rounded-md text-subtle hover:text-danger" onClick={() => setDel({ commentId: c.id })}><Trash2 size={15} /></button>
                </div>
              </div>
              <p className="text-sm text-text">{c.text}</p>

              {Array.isArray(c.replies) && c.replies.some((r) => !r.deleted) && (
                <div className="mt-3 pl-3 border-l-2 border-border flex flex-col gap-3">
                  {c.replies.filter((r) => !r.deleted).map((r, j) => (
                    <div key={r.id || j} className="flex items-start gap-2.5">
                      <span className={`w-7 h-7 rounded-full grid place-items-center text-[10px] font-semibold shrink-0 ${r.authorRole === 'Instrutor' ? 'bg-primary text-primary-fg' : 'bg-surface-2 text-muted'}`}>{initials(r.authorName || r.authorRole)}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-text"><span className="font-medium">{r.authorName || r.authorRole}</span> <span className="text-subtle">- {relTime(r.timestamp)}</span></p>
                        <p className="text-sm text-muted mt-0.5">{r.text}</p>
                      </div>
                      <button className="text-xs text-subtle hover:text-text" onClick={() => editText({ commentId: c.id, replyId: r.id, text: r.text })}>Editar</button>
                      <button className="text-subtle hover:text-danger" onClick={() => setDel({ commentId: c.id, replyId: r.id })}><Trash2 size={14} /></button>
                    </div>
                  ))}
                </div>
              )}

              {templates.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {templates.map((t) => (
                    <button key={t.id} onClick={() => applyTemplate(c.id, t.text)} className="text-xs px-2.5 py-1 rounded-full border border-border text-muted hover:bg-surface-2 hover:text-text">{t.title}</button>
                  ))}
                </div>
              )}
              <div className="mt-3 flex gap-2">
                <Textarea id={`reply-${c.id}`} value={reply[c.id] || ''} onChange={(e) => setReply((r) => ({ ...r, [c.id]: e.target.value }))} placeholder="Responder como instrutor..." className="min-h-[70px]" />
                <div className="flex flex-col gap-2">
                  <Button icon={Send} onClick={() => sendReply(c.id)}>Enviar</Button>
                  <Button variant="secondary" icon={status === 'resolvida' ? RotateCcw : CircleCheck} onClick={() => resolveToggle(c)}>{status === 'resolvida' ? 'Reabrir' : 'Resolver'}</Button>
                </div>
              </div>
            </Card>
          )
        })}
      </PageState>

      {trashCount > 0 && (
        <div className="space-y-2">
          <button type="button" onClick={() => setShowTrash((v) => !v)} className="inline-flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm font-semibold text-text hover:bg-surface-2">
            <ChevronDown size={16} className={`transition ${showTrash ? 'rotate-180' : ''}`} />
            Excluidas
            <Badge tone="neutral">{trashCount}</Badge>
          </button>
          {showTrash && (
            <Card className="p-4 space-y-2">
              {trashComments.map((c) => (
                <div key={c.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
                  <div className="flex-1 min-w-[220px]">
                    <p className="text-sm text-text"><span className="font-medium">{c.studentName || 'Aluno'}</span> <span className="text-subtle">- dúvida excluída {relTime(c.deletedAt)}</span></p>
                    <p className="text-xs text-muted line-clamp-2">{c.text}</p>
                  </div>
                  <Button size="sm" variant="secondary" icon={RotateCcw} onClick={() => restoreItem({ commentId: c.id })}>Restaurar</Button>
                  {isAdmin && <button className="text-subtle hover:text-danger" aria-label="Apagar de vez" onClick={() => setPurgeTarget({ commentId: c.id })}><Trash2 size={15} /></button>}
                </div>
              ))}
              {trashReplies.map(({ comment, reply }) => (
                <div key={reply.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
                  <div className="flex-1 min-w-[220px]">
                    <p className="text-sm text-text"><span className="font-medium">{reply.authorName || reply.authorRole}</span> <span className="text-subtle">- resposta excluída {relTime(reply.deletedAt)}</span></p>
                    <p className="text-xs text-muted line-clamp-2">{reply.text}</p>
                  </div>
                  <Button size="sm" variant="secondary" icon={RotateCcw} onClick={() => restoreItem({ commentId: comment.id, replyId: reply.id })}>Restaurar</Button>
                  {isAdmin && <button className="text-subtle hover:text-danger" aria-label="Apagar de vez" onClick={() => setPurgeTarget({ commentId: comment.id, replyId: reply.id })}><Trash2 size={15} /></button>}
                </div>
              ))}
            </Card>
          )}
        </div>
      )}

      <Modal open={!!historyTarget} onClose={() => setHistoryTarget(null)} title="Histórico da dúvida" description={historyTarget?.studentName}>
        <div className="space-y-3">
          <div className="text-xs text-muted">Criada por {historyTarget?.studentName} {relTime(historyTarget?.timestamp)}</div>
          {(historyTarget?.events || []).length === 0 ? (
            <p className="text-sm text-muted">Sem eventos de moderacao registrados ainda.</p>
          ) : (
            <div className="pl-3 border-l-2 border-border flex flex-col gap-3">
              {[...(historyTarget?.events || [])].reverse().map((e, i) => (
                <div key={i} className="flex items-start gap-2.5">
                  <span className="w-6 h-6 rounded-full bg-surface-2 text-muted grid place-items-center text-[10px] font-semibold shrink-0">{initials(e.byName)}</span>
                  <div>
                    <p className="text-sm text-text"><span className="font-medium">{e.byName}</span> {EVENT_LABEL[e.type] || e.type}</p>
                    <p className="text-xs text-subtle">{relTime(e.at)}{e.detail ? ` - "${e.detail}"` : ''}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>

      <Modal open={tplOpen} onClose={() => setTplOpen(false)} title="Respostas rapidas" description="Modelos reutilizaveis, salvos na sua conta.">
        <div className="space-y-3">
          {templates.length === 0 && <p className="text-sm text-muted">Nenhum modelo ainda. Crie abaixo.</p>}
          {templates.map((t) => (
            <div key={t.id} className="flex items-start gap-2 rounded-lg border border-border p-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text">{t.title}</p>
                <p className="text-xs text-muted mt-0.5 line-clamp-2">{t.text}</p>
              </div>
              <button className="text-subtle hover:text-danger" onClick={() => deleteTemplate(t.id)}><X size={16} /></button>
            </div>
          ))}
          <div className="pt-3 border-t border-border space-y-2">
            <Input label="Titulo" value={tplForm.title} onChange={(e) => setTplForm({ ...tplForm, title: e.target.value })} placeholder="Ex.: Prazo da prova" />
            <Textarea label="Texto" value={tplForm.text} onChange={(e) => setTplForm({ ...tplForm, text: e.target.value })} placeholder="Resposta padrao..." className="min-h-[70px]" />
            <Button icon={Plus} onClick={addTemplate}>Adicionar modelo</Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog open={!!del} onClose={() => setDel(null)} onConfirm={remove} danger title="Excluir mensagem?" description="A mensagem vai para Excluidas e pode ser restaurada." confirmLabel="Excluir" />
      <ConfirmDialog open={!!purgeTarget} onClose={() => setPurgeTarget(null)} onConfirm={purgeItem} danger title="Apagar definitivamente?" description="Remove a mensagem para sempre. Não será possível restaurar." confirmLabel="Apagar de vez" />
    </div>
  )
}
