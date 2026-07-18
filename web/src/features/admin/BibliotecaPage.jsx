import { useState, useMemo } from 'react'
import { FolderOpen, Upload, Search, Copy, Trash2, FileText, Image as ImageIcon, Film, FileArchive, File, Link2, Check, Globe, X, Save } from 'lucide-react'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { Card } from '../../components/ui/Card'
import { PageState } from '../../components/ui/PageState'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { useApi } from '../../hooks/useApi'
import { api } from '../../lib/api'
import { useToast } from '../../context/ToastProvider'
import { useAdminWorkspace } from '../../hooks/useAdminWorkspace'

const ICON = { image: ImageIcon, pdf: FileText, video: Film, link: Globe, zip: FileArchive, doc: FileText, sheet: FileText, other: File }
function human(b) { if (!b) return ''; const u = ['B', 'KB', 'MB', 'GB']; let i = 0, n = b; while (n >= 1024 && i < 3) { n /= 1024; i++ } return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}` }
function authHeaders() { try { const a = JSON.parse(localStorage.getItem('iclass-v3-auth')) || {}; const h = {}; if (a.adminSession) h['x-admin-session'] = a.adminSession; else if (a.adminAuth) h['Authorization'] = a.adminAuth; return h } catch { return {} } }

export default function BibliotecaPage() {
  const { courseId, courseName, className } = useAdminWorkspace()
  const { data: struct } = useApi(courseId ? `/api/admin/courses/${courseId}/structure?studentClass=${encodeURIComponent(className)}` : null, [courseId, className])
  const { data: summaries } = useApi('/api/admin/course-summaries')
  const { data: list, loading, error, refetch } = useApi(courseId && className ? `/api/admin/library?courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(className)}` : null, [courseId, className])
  const toast = useToast()

  const modules = useMemo(() => ((struct?.structure) || []).map((m) => ({ id: m.id, name: m.name || m.id })), [struct])
  const modName = useMemo(() => Object.fromEntries(modules.map((m) => [m.id, m.name])), [modules])

  const [editingId, setEditingId] = useState(null)
  const [kind, setKind] = useState('file')
  const [moduleId, setModuleId] = useState('')
  const [file, setFile] = useState(null)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [tags, setTags] = useState('')
  const [desc, setDesc] = useState('')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState('')
  const [scope, setScope] = useState('class')

  const affectedClasses = useMemo(() => {
    const course = (summaries || []).find((item) => String(item.id) === String(courseId))
    return (course?.classes || []).map((item) => item.name).filter(Boolean)
  }, [summaries, courseId])

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase()
    return (list || []).filter((e) => e.courseId === courseId)
      .filter((e) => !term || (e.name || '').toLowerCase().includes(term) || (e.tags || []).some((t) => t.toLowerCase().includes(term)))
  }, [list, courseId, q])

  function reset() { setEditingId(null); setKind('file'); setFile(null); setName(''); setUrl(''); setTags(''); setDesc(''); setModuleId(''); setScope('class'); const i = document.getElementById('lib-file'); if (i) i.value = '' }

  function startEdit(e) {
    setEditingId(e.id); setKind(e.kind || 'file'); setName(e.name || '')
    setTags((e.tags || []).join(', ')); setDesc(e.description || ''); setModuleId(e.moduleId || ''); setUrl(e.url || '')
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function submit() {
    if (scope === 'course' && !confirm(`Esta alteração substituirá este recurso em: ${affectedClasses.join(', ') || 'todas as turmas do curso'}. Deseja continuar?`)) return
    setBusy(true)
    try {
      const context = { courseId, studentClass: className, scope }
      if (editingId) {
        await api.post('/api/admin/library/update', { id: editingId, name, description: desc, tags, moduleId, ...context, ...(kind === 'link' ? { url } : {}) })
        toast.success('Material atualizado')
      } else if (kind === 'file') {
        if (!file) { toast.error('Escolha um arquivo'); setBusy(false); return }
        const fd = new FormData()
        fd.append('file', file); fd.append('courseId', courseId); fd.append('studentClass', className); fd.append('scope', scope); fd.append('moduleId', moduleId)
        if (name) fd.append('name', name); if (tags) fd.append('tags', tags); if (desc) fd.append('description', desc)
        const res = await fetch('/api/admin/library/upload', { method: 'POST', headers: authHeaders(), body: fd })
        const data = await res.json().catch(() => null)
        if (!res.ok) throw new Error((data && data.error) || 'Falha no upload')
        toast.success('Material adicionado')
      } else {
        if (!name || !url) { toast.error('Informe título e URL'); setBusy(false); return }
        await api.post('/api/admin/library/link', { title: name, url, description: desc, tags, moduleId, ...context })
        toast.success('Material adicionado')
      }
      reset(); refetch()
    } catch (e) { toast.error(e.message) } finally { setBusy(false) }
  }

  async function copy(u) { try { await navigator.clipboard.writeText(u); setCopied(u); setTimeout(() => setCopied(''), 1500) } catch { toast.error('Não foi possível copiar') } }

  async function remove(e) {
    if (scope === 'course' && !confirm(`A exclusão será aplicada em: ${affectedClasses.join(', ') || 'todas as turmas do curso'}. Deseja continuar?`)) return
    const context = { courseId, studentClass: className, scope }
    try { await api.post('/api/admin/library/delete', { id: e.id, ...context }); toast.success('Removido'); if (editingId === e.id) reset(); refetch() }
    catch (err) {
      if (err.status === 409) {
        const usados = (err.data && err.data.usedIn) || []
        if (confirm(`Usado em ${usados.length} apostila(s): ${usados.join(', ')}. Excluir mesmo assim?`)) {
          try { await api.post('/api/admin/library/delete', { id: e.id, force: true, ...context }); toast.success('Removido'); refetch() } catch (e2) { toast.error(e2.message) }
        }
      } else toast.error(err.message)
    }
  }

  if (!courseId) return <div className="max-w-4xl mx-auto"><Card><EmptyState icon={FolderOpen} title="Escolha um curso" description="Entre em um curso para gerenciar sua biblioteca." /></Card></div>

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageHeader title="Biblioteca de Materiais" subtitle={`Apostilas, links e vídeos por matéria · ${courseName} · ${className}`} />

      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-text">{editingId ? 'Editar material' : 'Novo material'}</p>
          {editingId && <Button size="sm" variant="ghost" icon={X} onClick={reset}>Cancelar edição</Button>}
        </div>
        {!editingId && (
          <div className="flex gap-2">
            <Button size="sm" variant={kind === 'file' ? 'primary' : 'secondary'} icon={Upload} onClick={() => setKind('file')}>Arquivo</Button>
            <Button size="sm" variant={kind === 'link' ? 'primary' : 'secondary'} icon={Globe} onClick={() => setKind('link')}>Link / Vídeo</Button>
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Select label="Matéria (módulo)" value={moduleId} onChange={(e) => setModuleId(e.target.value)}>
            <option value="">Curso todo (sem matéria)</option>
            {modules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
          {!editingId && kind === 'file' && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="lib-file" className="text-sm font-medium text-text">Arquivo</label>
              <input id="lib-file" type="file" onChange={(e) => { setFile(e.target.files?.[0] || null); if (!name && e.target.files?.[0]) setName(e.target.files[0].name) }}
                className="text-sm text-muted file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:bg-primary file:text-primary-fg file:font-medium" />
            </div>
          )}
          {kind === 'link' && (
            <Input id="lib-url" label="URL (site ou vídeo)" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
          )}
          <Input id="lib-name" label={kind === 'link' ? 'Título' : 'Nome'} value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome do material" />
          <Input id="lib-tags" label="Tags (vírgula)" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="ex.: redes, aula 3" />
        </div>
        <Input id="lib-desc" label="Descrição (opcional)" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Do que se trata" />
        <Select label="Aplicar alterações em" value={scope} onChange={(event) => setScope(event.target.value)}>
          <option value="class">Somente esta turma ({className})</option>
          <option value="course">Todas as turmas do curso</option>
        </Select>
        {editingId && <p className="text-xs text-subtle">Na edição você altera nome, matéria, tags, descrição e (para link) a URL. Para trocar um arquivo, exclua e crie de novo.</p>}
        <div className="flex justify-end"><Button icon={editingId ? Save : (kind === 'file' ? Upload : Link2)} loading={busy} onClick={submit}>{editingId ? 'Salvar alterações' : 'Adicionar à biblioteca'}</Button></div>
      </Card>

      <div className="relative max-w-sm">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nome ou tag…" className="w-full h-9 pl-9 pr-3 rounded-md bg-surface border border-border text-text text-sm" />
      </div>

      <PageState loading={loading} error={error} onRetry={refetch}>
        {rows.length === 0 ? (
          <Card><EmptyState icon={FolderOpen} title="Biblioteca vazia" description="Adicione apostilas, links ou vídeos acima. O aluno verá aqui na matéria." /></Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {rows.map((e) => {
              const Ico = ICON[e.type] || File
              return (
                <Card key={e.id} onClick={() => startEdit(e)} className={`p-4 transition hover:border-primary/50 cursor-pointer ${editingId === e.id ? 'border-primary' : ''}`}>
                  <div className="flex items-start gap-3">
                    <span className="w-10 h-10 rounded-md bg-primary-soft text-primary grid place-items-center shrink-0"><Ico size={18} /></span>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-text truncate">{e.name}</p>
                      <p className="text-xs text-subtle">{e.kind === 'link' ? (e.type === 'video' ? 'vídeo' : 'link') : e.type}{e.size ? ` · ${human(e.size)}` : ''} · {e.moduleId ? modName[e.moduleId] || e.moduleId : 'Curso todo'}</p>
                      {e.description && <p className="text-sm text-muted mt-1">{e.description}</p>}
                      {(e.tags || []).length > 0 && <div className="flex flex-wrap gap-1 mt-2">{e.tags.map((t, i) => <Badge key={i} tone="neutral">{t}</Badge>)}</div>}
                      <div className="flex flex-wrap gap-2 mt-3">
                        <Button size="sm" variant="secondary" onClick={(ev) => { ev.stopPropagation(); startEdit(e) }}>Editar</Button>
                        {e.kind !== 'link' && <Button size="sm" variant="secondary" icon={copied === e.url ? Check : Copy} onClick={(ev) => { ev.stopPropagation(); copy(e.url) }}>{copied === e.url ? 'Copiado' : 'Copiar URL'}</Button>}
                        <Button size="sm" variant="ghost" icon={Trash2} className="text-danger" onClick={(ev) => { ev.stopPropagation(); remove(e) }}>Excluir</Button>
                      </div>
                    </div>
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </PageState>
    </div>
  )
}
