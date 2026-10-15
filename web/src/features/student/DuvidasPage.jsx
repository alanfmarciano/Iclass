import { useState, useEffect, useMemo } from 'react'
import { Send, MessagesSquare, CheckCircle2, Clock3 } from 'lucide-react'
import { Card } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { Select } from '../../components/ui/Select'
import { Textarea } from '../../components/ui/Textarea'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageState } from '../../components/ui/PageState'
import { api } from '../../lib/api'
import { useStudent } from './useStudent'
import { useToast } from '../../context/ToastProvider'

const FILTERS = [
  { key: 'all', label: 'Todas' },
  { key: 'aberta', label: 'Aguardando resposta' },
  { key: 'respondida', label: 'Respondidas' },
]

function when(value) {
  const date = new Date(value || 0)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

// "Minhas dúvidas": todas as perguntas do aluno na turma (gerais e feitas dentro
// das apostilas), com filtro por situação e por tópico. Antes a tela só mostrava
// o tópico "geral" e abria vazia.
export default function DuvidasPage() {
  const { email, name, courseId, studentClass } = useStudent()
  const [comments, setComments] = useState([])
  const [topics, setTopics] = useState([{ key: 'geral', title: 'Dúvida geral', module: '' }])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [text, setText] = useState('')
  const [topic, setTopic] = useState('geral')
  const [filter, setFilter] = useState('all')
  const [topicFilter, setTopicFilter] = useState('all')
  const [sending, setSending] = useState(false)
  const toast = useToast()

  async function load(silent = false) {
    if (!silent) { setLoading(true); setError(null) }
    try {
      const r = await api.get(`/api/student/my-forum?courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(studentClass)}`)
      setComments(r.comments || [])
      if (Array.isArray(r.topics) && r.topics.length) setTopics(r.topics)
    } catch (e) { if (!silent) setError(e) } finally { if (!silent) setLoading(false) }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [courseId, studentClass])
  useEffect(() => {
    const id = setInterval(() => load(true), 15000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, studentClass])

  async function post() {
    if (!text.trim()) return
    setSending(true)
    try {
      await api.post('/api/forum/comment', { key: topic, studentName: name, studentEmail: email, courseId, studentClass, text })
      setText('')
      toast.success('Dúvida enviada ao instrutor')
      load(true)
    } catch (e) { toast.error(e.message) } finally { setSending(false) }
  }

  const pendingCount = comments.filter((c) => c.status !== 'respondida').length
  const visible = useMemo(() => comments
    .filter((c) => filter === 'all' || c.status === filter)
    .filter((c) => topicFilter === 'all' || c.key === topicFilter), [comments, filter, topicFilter])
  const usedTopics = useMemo(() => topics.filter((t) => comments.some((c) => c.key === t.key)), [topics, comments])

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text">Dúvidas</h1>
        <p className="text-sm text-muted">Pergunte ao instrutor e acompanhe aqui todas as suas dúvidas, inclusive as feitas dentro das apostilas.</p>
      </div>

      <Card className="p-4 space-y-3">
        <Select label="Sobre qual tópico?" value={topic} onChange={(e) => setTopic(e.target.value)}>
          {topics.map((t) => <option key={t.key} value={t.key}>{t.module ? `${t.module} · ${t.title}` : t.title}</option>)}
        </Select>
        <Textarea id="q" value={text} onChange={(e) => setText(e.target.value)} placeholder="Escreva sua dúvida…" className="min-h-[90px]" />
        <div className="flex justify-end"><Button icon={Send} loading={sending} onClick={post} disabled={!text.trim()}>Enviar</Button></div>
      </Card>

      <PageState loading={loading} error={error} onRetry={() => load()}>
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.map((f) => (
            <button key={f.key} type="button" onClick={() => setFilter(f.key)} className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${filter === f.key ? 'border-primary bg-primary-soft text-primary' : 'border-border text-muted hover:text-text'}`}>
              {f.label}{f.key === 'aberta' && pendingCount > 0 ? ` (${pendingCount})` : ''}
            </button>
          ))}
          {usedTopics.length > 1 && (
            <select value={topicFilter} onChange={(e) => setTopicFilter(e.target.value)} aria-label="Filtrar por tópico" className="ml-auto h-8 rounded-lg border border-border bg-surface-2 px-2 text-xs text-text">
              <option value="all">Todos os tópicos</option>
              {usedTopics.map((t) => <option key={t.key} value={t.key}>{t.title}</option>)}
            </select>
          )}
        </div>

        {visible.length === 0 ? (
          <Card><EmptyState icon={MessagesSquare} title={comments.length === 0 ? 'Você ainda não fez nenhuma dúvida' : 'Nenhuma dúvida com esse filtro'} description={comments.length === 0 ? 'Escreva acima ou pergunte direto na apostila: tudo aparece aqui.' : 'Troque o filtro para ver as demais.'} /></Card>
        ) : visible.map((c) => {
          const answered = c.status === 'respondida'
          return (
            <Card key={c.id} className="p-4">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <Badge tone="neutral">{c.unitTitle}</Badge>
                <Badge tone={answered ? 'success' : 'warning'} dot>{answered ? 'Respondida' : 'Aguardando resposta'}</Badge>
                {c.isFaq && <Badge tone="info">FAQ</Badge>}
                <span className="ml-auto text-xs text-subtle">{when(c.timestamp)}</span>
              </div>
              <p className="text-sm text-text whitespace-pre-wrap">{c.text}</p>
              {c.replies.length > 0 ? c.replies.map((r) => (
                <div key={r.id} className="mt-3 rounded-lg border-l-2 border-primary/50 bg-surface-2/60 px-3 py-2 text-sm">
                  <div className="flex items-center gap-2 text-xs text-subtle"><CheckCircle2 size={13} className="text-success" /><span className="font-medium text-primary">{r.authorName || r.authorRole}</span><span>{when(r.timestamp)}</span></div>
                  <p className="mt-1 text-text whitespace-pre-wrap">{r.text}</p>
                </div>
              )) : (
                <p className="mt-3 flex items-center gap-1.5 text-xs text-muted"><Clock3 size={13} /> O instrutor ainda não respondeu.</p>
              )}
            </Card>
          )
        })}
      </PageState>
    </div>
  )
}
