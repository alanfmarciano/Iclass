import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bold,
  Code2,
  Eye,
  Heading1,
  Heading2,
  Image,
  Italic,
  Link,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Save,
  Plus,
  Type,
  Undo2,
} from 'lucide-react'
import { Card, CardBody, CardHeader } from '../../components/ui/Card'
import { Select } from '../../components/ui/Select'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { Textarea } from '../../components/ui/Textarea'
import { Input } from '../../components/ui/Input'
import { Modal } from '../../components/ui/Modal'
import { useApi } from '../../hooks/useApi'
import { api } from '../../lib/api'
import { markdownToHtml, htmlToMarkdown, resolveContentUrl } from '../../lib/contentMarkdown'
import { useToast } from '../../context/ToastProvider'
import { useAuth } from '../../context/AuthProvider'
import { useAdminWorkspace } from '../../hooks/useAdminWorkspace'

function ToolButton({ icon: Icon, label, onClick, disabled }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="w-9 h-9 inline-grid place-items-center rounded-md border border-border bg-surface text-text hover:bg-surface-2 disabled:opacity-50"
    >
      <Icon size={16} />
    </button>
  )
}

function escapeAttr(value) {
  return String(value || '').replace(/"/g, '&quot;')
}

export default function EditorPage() {
  const { data: summaries } = useApi('/api/admin/course-summaries')
  const { auth } = useAuth()
  const workspace = useAdminWorkspace()
  const courseId = workspace.courseId
  const className = workspace.className
  const [scope, setScope] = useState('class')
  const [structure, setStructure] = useState([])
  const [key, setKey] = useState('')
  const [markdown, setMarkdown] = useState('')
  const [html, setHtml] = useState('')
  const [mode, setMode] = useState('visual')
  const [createOpen, setCreateOpen] = useState(false)
  const [newUnit, setNewUnit] = useState({ moduleId: '', unitName: '' })
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const editorRef = useRef(null)
  const fileRef = useRef(null)
  const toast = useToast()

  useEffect(() => {
    setScope('class')
    setKey('')
    setMarkdown('')
    setHtml('')
  }, [courseId, className])

  useEffect(() => {
    if (!courseId) {
      setStructure([])
      setKey('')
      setMarkdown('')
      setHtml('')
      return
    }
    api.get(`/api/admin/courses/${courseId}/structure?studentClass=${encodeURIComponent(className)}`)
      .then((s) => setStructure(s.structure || []))
      .catch((e) => toast.error(e.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, className])

  const affectedClasses = useMemo(() => {
    const course = (summaries || []).find((item) => String(item.id) === String(courseId))
    return (course?.classes || []).map((item) => item.name).filter(Boolean)
  }, [summaries, courseId])

  function confirmScope() {
    if (scope !== 'course') return true
    const names = affectedClasses.length ? affectedClasses.join(', ') : 'todas as turmas do curso'
    return window.confirm(`Esta alteração substituirá este recurso em: ${names}. Deseja continuar?`)
  }

  const units = useMemo(() => {
    return structure
      .flatMap((mod) => (mod.units || mod.items || []).map((unit) => ({
        key: unit.apostilaKey || unit.key,
        name: `${mod.title || mod.name || ''} - ${unit.name || unit.title || unit.key}`,
      })))
      .filter((unit) => unit.key)
  }, [structure])

  useEffect(() => {
    if (editorRef.current && mode === 'visual' && editorRef.current.innerHTML !== html) {
      editorRef.current.innerHTML = html
    }
  }, [html, mode])

  async function loadMd(nextKey) {
    setKey(nextKey)
    setMarkdown('')
    setHtml('')
    if (!nextKey) return

    setLoading(true)
    try {
      // A rota de apostilas exige sessão: passa pelo cliente de API (envia o token do instrutor).
      const text = await api.get(`/${encodeURIComponent(nextKey)}.md`, { raw: true })
      setMarkdown(text || '')
      setHtml(markdownToHtml(text || ''))
    } catch (error) {
      setMarkdown('')
      setHtml('')
      // 404 = apostila nova (arquivo ainda não existe); outro erro não pode parecer apostila vazia.
      if (error?.status !== 404) toast.error(error?.message || 'Não foi possível carregar a apostila.')
    } finally {
      setLoading(false)
    }
  }

  function syncFromEditor() {
    if (!editorRef.current) return
    const nextMarkdown = htmlToMarkdown(editorRef.current)
    setMarkdown(nextMarkdown)
    setHtml(editorRef.current.innerHTML)
  }

  function runCommand(command, value = null) {
    if (!editorRef.current) return
    editorRef.current.focus()
    document.execCommand(command, false, value)
    syncFromEditor()
  }

  function setBlock(tag) {
    runCommand('formatBlock', tag)
  }

  function addLink() {
    const url = window.prompt('URL do link')
    if (!url) return
    runCommand('createLink', url)
  }

  function onMarkdownChange(value) {
    setMarkdown(value)
    setHtml(markdownToHtml(value))
  }

  function switchMode(nextMode) {
    if (mode === 'visual') syncFromEditor()
    setMode(nextMode)
  }

  async function save() {
    if (!key) return
    if (!confirmScope()) return
    const finalMarkdown = mode === 'visual' && editorRef.current ? htmlToMarkdown(editorRef.current) : markdown
    setSaving(true)
    try {
      const response = await api.put(`/api/admin/material/${encodeURIComponent(key)}`, { markdownText: finalMarkdown, courseId, studentClass: className, scope })
      const nextKey = response.key || key
      setKey(nextKey)
      setMarkdown(finalMarkdown)
      setHtml(markdownToHtml(finalMarkdown))
      toast.success('Apostila salva')
    } catch (e) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function createMaterial() {
    if (!courseId || !newUnit.moduleId || !newUnit.unitName) return toast.error('Selecione módulo e nome da unidade')
    if (!confirmScope()) return
    try {
      const r = await api.post('/api/admin/material/create', { courseId, studentClass: className, scope, moduleId: newUnit.moduleId, unitName: newUnit.unitName })
      const s = await api.get(`/api/admin/courses/${courseId}/structure?studentClass=${encodeURIComponent(className)}`)
      setStructure(s.structure || [])
      setCreateOpen(false)
      setNewUnit({ moduleId: '', unitName: '' })
      await loadMd(r.apostilaKey)
      toast.success('Material criado')
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function uploadImage(file) {
    if (!file) return
    const form = new FormData()
    form.append('image', file)
    setUploading(true)
    try {
      const res = await fetch('/api/admin/upload-image', {
        method: 'POST',
        // Login atual guarda só a sessão (x-admin-session); a credencial legada fica de reserva.
        headers: auth.adminSession ? { 'x-admin-session': auth.adminSession } : (auth.adminAuth ? { Authorization: auth.adminAuth } : {}),
        body: form,
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || 'Falha no upload da imagem')

      // No Markdown vai o endereço limpo; a sessão só entra na imagem exibida no editor.
      const url = resolveContentUrl(data.url)
      if (mode === 'markdown') {
        onMarkdownChange(`${markdown.trimEnd()}\n\n![${file.name}](${data.url})\n`)
      } else {
        editorRef.current?.focus()
        document.execCommand('insertHTML', false, `<p><img src="${escapeAttr(url)}" alt="${escapeAttr(file.name)}"></p>`)
        syncFromEditor()
      }
      toast.success('Imagem inserida')
    } catch (e) {
      toast.error(e.message)
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text">Editor de Conteúdo</h1>
        <p className="text-sm text-muted">Edite apostilas em modo visual e salve em Markdown.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Select label="Curso" value={courseId} onChange={() => {}} disabled>
          <option value={courseId}>{workspace.courseName || courseId} · {className}</option>
        </Select>
        <Select label="Apostila" value={key} onChange={(e) => loadMd(e.target.value)} disabled={!courseId}>
          <option value="">Selecione...</option>
          {units.map((unit) => <option key={unit.key} value={unit.key}>{unit.name}</option>)}
        </Select>
      </div>

      <Card className="p-4">
        <Select label="Aplicar alterações em" value={scope} onChange={(event) => setScope(event.target.value)}>
          <option value="class">Somente esta turma ({className})</option>
          <option value="course">Todas as turmas do curso</option>
        </Select>
        <p className="mt-2 text-xs text-muted">O padrão protege as demais turmas. Alterações no curso inteiro pedem confirmação e substituem apenas este recurso.</p>
      </Card>

      {!key ? (
        <Card><EmptyState title="Escolha uma apostila" description="Selecione curso e apostila para editar." action="Novo material" onAction={() => setCreateOpen(true)} /></Card>
      ) : (
        <Card>
          <CardHeader
            title={loading ? 'Carregando...' : key.replace(/_/g, ' ')}
            subtitle={mode === 'visual' ? 'Editor visual' : 'Codigo Markdown'}
            action={<div className="flex gap-2"><Button variant="secondary" icon={Plus} onClick={() => setCreateOpen(true)}>Novo</Button><Button icon={Save} loading={saving} onClick={save}>Salvar</Button></div>}
          />
          <CardBody className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-md border border-border overflow-hidden">
                <button type="button" onClick={() => switchMode('visual')} className={`h-9 px-3 text-sm font-semibold ${mode === 'visual' ? 'bg-primary text-primary-fg' : 'bg-surface text-text'}`}>Visual</button>
                <button type="button" onClick={() => switchMode('markdown')} className={`h-9 px-3 text-sm font-semibold ${mode === 'markdown' ? 'bg-primary text-primary-fg' : 'bg-surface text-text'}`}>Markdown</button>
              </div>

              <div className="flex flex-wrap gap-1">
                <ToolButton icon={Type} label="Paragrafo" disabled={mode !== 'visual'} onClick={() => setBlock('p')} />
                <ToolButton icon={Heading1} label="Titulo 1" disabled={mode !== 'visual'} onClick={() => setBlock('h1')} />
                <ToolButton icon={Heading2} label="Titulo 2" disabled={mode !== 'visual'} onClick={() => setBlock('h2')} />
                <ToolButton icon={Bold} label="Negrito" disabled={mode !== 'visual'} onClick={() => runCommand('bold')} />
                <ToolButton icon={Italic} label="Italico" disabled={mode !== 'visual'} onClick={() => runCommand('italic')} />
                <ToolButton icon={List} label="Lista" disabled={mode !== 'visual'} onClick={() => runCommand('insertUnorderedList')} />
                <ToolButton icon={ListOrdered} label="Lista numerada" disabled={mode !== 'visual'} onClick={() => runCommand('insertOrderedList')} />
                <ToolButton icon={Quote} label="Citacao" disabled={mode !== 'visual'} onClick={() => setBlock('blockquote')} />
                <ToolButton icon={Link} label="Link" disabled={mode !== 'visual'} onClick={addLink} />
                <ToolButton icon={Undo2} label="Desfazer" disabled={mode !== 'visual'} onClick={() => runCommand('undo')} />
                <ToolButton icon={Redo2} label="Refazer" disabled={mode !== 'visual'} onClick={() => runCommand('redo')} />
                <ToolButton icon={Image} label={uploading ? 'Enviando imagem' : 'Inserir imagem'} onClick={() => fileRef.current?.click()} />
              </div>

              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => uploadImage(e.target.files?.[0])}
              />
            </div>

            {mode === 'visual' ? (
              <div
                ref={editorRef}
                className="wysiwyg-editor prose-iclass min-h-[520px] rounded-md border border-border bg-surface px-5 py-4 focus:outline-none focus:ring-2 focus:ring-primary"
                contentEditable={!loading}
                suppressContentEditableWarning
                onInput={syncFromEditor}
              />
            ) : (
              <Textarea
                id="material-md"
                value={loading ? 'Carregando...' : markdown}
                onChange={(e) => onMarkdownChange(e.target.value)}
                className="font-mono min-h-[520px]"
              />
            )}

            {mode === 'markdown' && (
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-muted mb-2"><Eye size={16} /> Prévia</div>
                <article className="prose-iclass rounded-md border border-border bg-surface px-5 py-4" dangerouslySetInnerHTML={{ __html: html }} />
              </div>
            )}

            <div className="flex items-center gap-2 text-xs text-subtle">
              <Code2 size={14} />
              <span>O conteudo visual e convertido para Markdown ao salvar.</span>
            </div>
          </CardBody>
        </Card>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Novo material" description="Cria uma apostila e avaliação vazia vinculadas ao módulo."
        footer={<><Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancelar</Button><Button onClick={createMaterial}>Criar</Button></>}>
        <div className="space-y-3">
          <Select label="Modulo" value={newUnit.moduleId} onChange={(e) => setNewUnit({ ...newUnit, moduleId: e.target.value })} disabled={!courseId}>
            <option value="">Selecione...</option>
            {structure.map((mod) => <option key={mod.id} value={mod.id}>{mod.name || mod.title || mod.id}</option>)}
          </Select>
          <Input label="Nome da unidade" value={newUnit.unitName} onChange={(e) => setNewUnit({ ...newUnit, unitName: e.target.value })} />
        </div>
      </Modal>
    </div>
  )
}
