import { useState, useEffect, useMemo } from 'react'
import { FolderOpen, ExternalLink, FileText, Image as ImageIcon, Film, FileArchive, File, Globe, Play } from 'lucide-react'
import { Card } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageState } from '../../components/ui/PageState'
import { Button } from '../../components/ui/Button'
import { Modal } from '../../components/ui/Modal'
import { api } from '../../lib/api'
import { useStudent } from './useStudent'

const ICON = { image: ImageIcon, pdf: FileText, video: Film, link: Globe, zip: FileArchive, doc: FileText, sheet: FileText, other: File }
function ytId(url) { const m = (url || '').match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([\w-]{11})/); return m ? m[1] : null }
function vimeoId(url) { const m = (url || '').match(/vimeo\.com\/(?:video\/)?(\d+)/); return m ? m[1] : null }

// Miniatura mostrada direto no card (sem clique).
function thumbFor(e) {
  const url = e.url || ''
  const yt = ytId(url); if (yt) return { kind: 'img', src: `https://img.youtube.com/vi/${yt}/mqdefault.jpg`, play: true }
  if (e.type === 'image') return { kind: 'img', src: url }
  if (e.kind !== 'link' && (e.type === 'video' || /\.(mp4|webm|ogg)(\?|$)/i.test(url))) return { kind: 'video', src: url, play: true }
  return { kind: 'none' }
}
// Player/visualizador grande (ao abrir).
function embed(e) {
  const url = e.url || ''
  const yt = ytId(url); if (yt) return { kind: 'iframe', src: `https://www.youtube.com/embed/${yt}` }
  const vm = vimeoId(url); if (vm) return { kind: 'iframe', src: `https://player.vimeo.com/video/${vm}` }
  if (e.type === 'video' || /\.(mp4|webm|ogg)(\?|$)/i.test(url)) return { kind: 'video', src: url }
  if (e.type === 'image') return { kind: 'image', src: url }
  if (e.type === 'pdf' || /\.pdf(\?|$)/i.test(url)) return { kind: 'pdf', src: `${url}${url.includes('?') ? '&' : '?'}preview=1` }
  return { kind: 'none' }
}

function Thumb({ e }) {
  const t = thumbFor(e)
  const Ico = ICON[e.type] || File
  return (
    <div className="relative w-28 h-16 rounded-md overflow-hidden bg-surface-2 grid place-items-center shrink-0">
      {t.kind === 'img' && <img src={t.src} alt="" loading="lazy" className="w-full h-full object-cover" />}
      {t.kind === 'video' && <video src={t.src} muted preload="metadata" className="w-full h-full object-cover" />}
      {t.kind === 'none' && <Ico size={22} className="text-primary" />}
      {t.play && <span className="absolute inset-0 grid place-items-center"><span className="w-7 h-7 rounded-full bg-black/55 grid place-items-center"><Play size={14} className="text-white ml-0.5" /></span></span>}
    </div>
  )
}
function Preview({ e }) {
  const p = embed(e)
  if (p.kind === 'iframe') return <div className="relative w-full rounded-lg overflow-hidden bg-black" style={{ aspectRatio: '16/9' }}><iframe src={p.src} title={e.name} className="absolute inset-0 w-full h-full" frameBorder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen /></div>
  if (p.kind === 'video') return <video src={p.src} controls className="w-full rounded-lg max-h-[70vh] bg-black" />
  if (p.kind === 'image') return <img src={p.src} alt={e.name} className="max-h-[70vh] rounded-lg mx-auto" />
  if (p.kind === 'pdf') return <iframe src={p.src} title={e.name} className="w-full rounded-lg border border-border" style={{ height: '70vh' }} />
  return <div className="rounded-lg border border-border bg-surface-2 p-6 text-center text-sm text-muted">Pré-visualização não disponível para este tipo. Use "Abrir externamente".</div>
}

export default function BibliotecaPage() {
  const { email, courseId, studentClass } = useStudent()
  const [list, setList] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)

  async function load() {
    setLoading(true); setError(null)
    try { const r = await api.get(`/api/student/library?courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(studentClass)}`); setList(Array.isArray(r) ? r : []) }
    catch (e) { setError(e) } finally { setLoading(false) }
  }
  useEffect(() => { if (email && courseId && studentClass) load() /* eslint-disable-next-line */ }, [email, courseId, studentClass])

  const groups = useMemo(() => {
    const map = new Map()
    list.forEach((e) => { const k = e.materia || 'Geral'; if (!map.has(k)) map.set(k, []); map.get(k).push(e) })
    return [...map.entries()]
  }, [list])

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div><h1 className="text-2xl font-bold text-text">Biblioteca</h1><p className="text-sm text-muted">Apostilas, links e vídeos das suas matérias. Clique para ver em tela cheia.</p></div>
      <PageState loading={loading} error={error} onRetry={load}>
        {list.length === 0 ? (
          <Card><EmptyState icon={FolderOpen} title="Nada por aqui ainda" description="Quando o instrutor publicar materiais, eles aparecem aqui." /></Card>
        ) : groups.map(([materia, items]) => (
          <div key={materia} className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-subtle px-1">{materia}</p>
            {items.map((e) => (
                <Card key={e.id} className="p-4 transition hover:border-primary/50">
                  <button type="button" className="w-full text-left" onClick={() => setSelected(e)}>
                  <div className="flex items-start gap-3">
                    <Thumb e={e} />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-text">{e.name}</p>
                      {e.description && <p className="text-sm text-muted mt-0.5">{e.description}</p>}
                      {(e.tags || []).length > 0 && <div className="flex flex-wrap gap-1 mt-2">{e.tags.map((t, i) => <Badge key={i} tone="neutral">{t}</Badge>)}</div>}
                    </div>
                  </div>
                  </button>
                </Card>
              ))}
          </div>
        ))}
      </PageState>

      <Modal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected?.name || 'Material'}
        description={selected?.description}
        size="xl"
        footer={selected && (
          <Button
            icon={ExternalLink}
            onClick={() => window.open(embed(selected).src || selected.url, '_blank', 'noopener,noreferrer')}
          >
            {embed(selected).kind === 'pdf' ? 'Abrir PDF' : 'Abrir em nova aba'}
          </Button>
        )}
      >
        {selected && <Preview e={selected} />}
      </Modal>
    </div>
  )
}
