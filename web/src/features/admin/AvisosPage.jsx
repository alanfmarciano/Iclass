import { useState, useMemo } from 'react'
import { Megaphone, Send, Trash2, Pin, AlertTriangle, Eye, X, Save, Search } from 'lucide-react'
import { Select } from '../../components/ui/Select'
import { Input } from '../../components/ui/Input'
import { Textarea } from '../../components/ui/Textarea'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { Card } from '../../components/ui/Card'
import { PageState } from '../../components/ui/PageState'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { useApi } from '../../hooks/useApi'
import { api } from '../../lib/api'
import { useToast } from '../../context/ToastProvider'
import { useAuth } from '../../context/AuthProvider'
import { useAdminWorkspace } from '../../hooks/useAdminWorkspace'

function when(ts) { try { return new Date(ts).toLocaleString('pt-BR') } catch { return '' } }

export default function AvisosPage() {
  const { auth } = useAuth()
  const { courseId: activeCourseId, courseName, className: activeClassName } = useAdminWorkspace()
  const isAdmin = (auth.accountRole || 'admin') === 'admin'
  const contextQuery = new URLSearchParams({ courseId: activeCourseId, studentClass: activeClassName }).toString()
  const { data: classes } = useApi(`/api/admin/classes?${contextQuery}`)
  const { data: list, loading, error, refetch } = useApi(`/api/admin/announcements?${contextQuery}`)
  const toast = useToast()

  const courseClasses = useMemo(() => (classes || []).filter((c) => c.courseId === activeCourseId && c.name === activeClassName), [classes, activeCourseId, activeClassName])
  const courseClassNames = useMemo(() => new Set(courseClasses.map((c) => c.name)), [courseClasses])
  const visible = useMemo(() => (list || []).filter((a) =>
    a.target === 'todos' ||
    (a.target === 'curso' && a.targetValue === activeCourseId) ||
    (a.target === 'turma' && courseClassNames.has(a.targetValue)) ||
    a.target === 'aluno'
  ), [list, activeCourseId, courseClassNames])

  const [editingId, setEditingId] = useState(null)
  const [target, setTarget] = useState('turma')
  const [targetValue, setTargetValue] = useState(activeClassName)
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [priority, setPriority] = useState('normal')
  const [pinned, setPinned] = useState(false)
  const [expiresAt, setExpiresAt] = useState('')
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [view, setView] = useState('todos')
  const [page, setPage] = useState(1)

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    const today = new Date().toISOString().slice(0, 10)
    return visible.filter((a) => {
      if (view === 'fixados' && !a.pinned) return false
      if (view === 'alta' && a.priority !== 'alta') return false
      if (view === 'ativos' && a.expiresAt && a.expiresAt < today) return false
      if (view === 'expirados' && (!a.expiresAt || a.expiresAt >= today)) return false
      if (!term) return true
      return [a.title, a.message, a.authorName, a.author, a.targetValue]
        .some((value) => String(value || '').toLowerCase().includes(term))
    })
  }, [visible, query, view])
  const pageSize = 10
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const pageRows = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize)

  const targetLabel = (a) => a.target === 'todos' ? 'Toda a instituição'
    : a.target === 'curso' ? `Curso: ${a.targetValue}`
    : a.target === 'turma' ? `Turma: ${a.targetValue}`
    : `Aluno: ${a.targetValue}`

  function reset() { setEditingId(null); setTarget('turma'); setTargetValue(activeClassName); setTitle(''); setMessage(''); setPriority('normal'); setPinned(false); setExpiresAt('') }

  function startEdit(a) {
    setEditingId(a.id)
    setTarget(a.target); setTargetValue(a.targetValue || '')
    setTitle(a.title || ''); setMessage(a.message || '')
    setPriority(a.priority || 'normal'); setPinned(!!a.pinned); setExpiresAt(a.expiresAt || '')
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function submit() {
    if (!title.trim() || !message.trim()) return toast.error('Preencha título e mensagem')
    const tv = target === 'curso' ? activeCourseId : target === 'todos' ? '' : targetValue
    if ((target === 'turma' || target === 'aluno') && !tv.trim()) return toast.error('Informe o destino')
    setBusy(true)
    try {
      const payload = { title, message, target, targetValue: tv, courseId: activeCourseId, studentClass: activeClassName, priority, pinned, expiresAt: expiresAt || null }
      if (editingId) { await api.post('/api/admin/announcements/update', { id: editingId, ...payload }); toast.success('Aviso atualizado') }
      else { await api.post('/api/admin/announcements', payload); toast.success('Aviso publicado') }
      reset(); refetch()
    } catch (e) { toast.error(e.message) } finally { setBusy(false) }
  }

  async function remove(id) {
    try { await api.post('/api/admin/announcements/delete', { id }); toast.success('Aviso removido'); if (editingId === id) reset(); refetch() }
    catch (e) { toast.error(e.message) }
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <PageHeader title="Avisos & Comunicados" subtitle={`Comunique alunos e turmas · ${courseName || activeCourseId} · ${activeClassName}`} />

      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-text">{editingId ? 'Editar aviso' : 'Novo aviso'}</p>
          {editingId && <Button size="sm" variant="ghost" icon={X} onClick={reset}>Cancelar edição</Button>}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Select label="Destino" value={target} onChange={(e) => { const next = e.target.value; setTarget(next); setTargetValue(next === 'turma' ? activeClassName : '') }}>
            <option value="turma">Somente esta turma</option>
            <option value="curso">Todas as turmas do curso</option>
            <option value="aluno">Um aluno (e-mail)</option>
            {isAdmin && <option value="todos">Toda a instituição</option>}
          </Select>
          {target === 'turma' && (
            <div><p className="mb-1 text-sm font-medium text-text">Turma</p><div className="h-[38px] rounded-md border border-border bg-surface-2 px-3 py-2 text-sm font-semibold text-text">{activeClassName}</div></div>
          )}
          {target === 'aluno' && (
            <Input id="av-al" label="E-mail do aluno" value={targetValue} onChange={(e) => setTargetValue(e.target.value)} placeholder="aluno@exemplo.com" />
          )}
        </div>
        <Input id="av-t" label="Título" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex.: Prova remarcada" />
        <Textarea id="av-m" label="Mensagem" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Escreva o comunicado…" className="min-h-[90px]" />
        <div className="flex flex-wrap items-end gap-3">
          <Select label="Prioridade" value={priority} onChange={(e) => setPriority(e.target.value)} className="w-40">
            <option value="normal">Normal</option>
            <option value="alta">Alta</option>
          </Select>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="av-expires" className="text-sm font-medium text-text">Expira em (opcional)</label>
            <input id="av-expires" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="h-[38px] px-3 rounded-md bg-surface border border-border text-text text-sm" />
          </div>
          <label className="flex items-center gap-2 text-sm text-text h-[38px]">
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> Fixar no topo
          </label>
          <Button className="ml-auto" icon={editingId ? Save : Send} loading={busy} onClick={submit}>{editingId ? 'Salvar alterações' : 'Publicar aviso'}</Button>
        </div>
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="relative w-full sm:max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPage(1) }}
            placeholder="Buscar por título, mensagem ou destinatário…"
            aria-label="Buscar avisos"
            className="h-[38px] w-full rounded-md border border-border bg-surface pl-9 pr-3 text-sm text-text"
          />
        </div>
        <Select label="Exibir" value={view} onChange={(e) => { setView(e.target.value); setPage(1) }} className="w-full sm:w-48">
          <option value="todos">Todos os avisos</option>
          <option value="ativos">Ativos</option>
          <option value="fixados">Fixados</option>
          <option value="alta">Alta prioridade</option>
          <option value="expirados">Expirados</option>
        </Select>
      </div>

      <PageState loading={loading} error={error} onRetry={refetch}>
        {filtered.length === 0 ? (
          <Card><EmptyState icon={Megaphone} title="Nenhum aviso encontrado" description={visible.length ? 'Tente mudar a busca ou o filtro.' : 'Publique o primeiro comunicado acima.'} /></Card>
        ) : (
          <div className="space-y-2">
            <p className="px-1 text-xs text-subtle">
              Mostrando {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, filtered.length)} de {filtered.length} avisos
            </p>
            {pageRows.map((a) => (
              <Card key={a.id} onClick={() => startEdit(a)}
                className={`p-4 cursor-pointer transition hover:border-primary/50 ${editingId === a.id ? 'border-primary' : ''}`}>
                <div className="flex items-start gap-3">
                  <span className={`w-8 h-8 rounded-md grid place-items-center shrink-0 ${a.priority === 'alta' ? 'bg-danger/15 text-danger' : 'bg-primary-soft text-primary'}`}>
                    {a.priority === 'alta' ? <AlertTriangle size={16} /> : <Megaphone size={16} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-text">{a.title}</span>
                      {a.pinned && <Badge tone="warning"><Pin size={11} /> Fixado</Badge>}
                      {a.priority === 'alta' && <Badge tone="danger">Alta</Badge>}
                      <Badge tone="info">{targetLabel(a)}</Badge>
                    </div>
                    <p className="text-sm text-muted mt-1 line-clamp-2 whitespace-pre-wrap">{a.message}</p>
                    <p className="text-xs text-subtle mt-2 flex items-center gap-3">
                      <span>{a.authorName || a.author} · {when(a.createdAt)}</span>
                      <span className="flex items-center gap-1"><Eye size={12} /> {a.readCount || 0} leram</span>
                      {a.expiresAt && <span>expira {a.expiresAt}</span>}
                    </p>
                  </div>
                  <Button size="sm" variant="ghost" icon={Trash2} onClick={(ev) => { ev.stopPropagation(); remove(a.id) }} className="text-danger shrink-0">Excluir</Button>
                </div>
              </Card>
            ))}
            {pageCount > 1 && (
              <div className="flex items-center justify-end gap-2 pt-2">
                <Button size="sm" variant="secondary" disabled={currentPage === 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Anterior</Button>
                <span className="min-w-20 text-center text-sm text-muted">{currentPage} de {pageCount}</span>
                <Button size="sm" variant="secondary" disabled={currentPage === pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>Próxima</Button>
              </div>
            )}
          </div>
        )}
      </PageState>
    </div>
  )
}
