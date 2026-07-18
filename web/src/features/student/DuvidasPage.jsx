import { useState, useEffect } from 'react'
import { Send, MessagesSquare } from 'lucide-react'
import { Card } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { Textarea } from '../../components/ui/Textarea'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageState } from '../../components/ui/PageState'
import { api } from '../../lib/api'
import { useStudent } from './useStudent'
import { useToast } from '../../context/ToastProvider'

export default function DuvidasPage() {
  const { email, name, courseId, studentClass } = useStudent()
  const key = 'geral'
  const [comments, setComments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [text, setText] = useState('')
  const toast = useToast()

  async function load() {
    setLoading(true); setError(null)
    try { const r = await api.get(`/api/forum?key=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}&courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(studentClass)}`); setComments(r.comments || []) }
    catch (e) { setError(e) } finally { setLoading(false) }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [])
  async function post() {
    if (!text.trim()) return
    try { await api.post('/api/forum/comment', { key, studentName: name, studentEmail: email, courseId, studentClass, text }); setText(''); toast.success('Dúvida enviada'); load() }
    catch (e) { toast.error(e.message) }
  }
  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div><h1 className="text-2xl font-bold text-text">Dúvidas</h1><p className="text-sm text-muted">Pergunte e acompanhe as respostas do instrutor.</p></div>
      <Card className="p-4">
        <Textarea id="q" value={text} onChange={(e) => setText(e.target.value)} placeholder="Escreva sua dúvida…" className="min-h-[90px]" />
        <div className="flex justify-end mt-3"><Button icon={Send} onClick={post}>Enviar</Button></div>
      </Card>
      <PageState loading={loading} error={error} onRetry={load}>
        {comments.length === 0 ? <Card><EmptyState icon={MessagesSquare} title="Nenhuma dúvida ainda" description="Seja o primeiro a perguntar." /></Card>
          : comments.map((c, i) => (
            <Card key={c.id || i} className="p-4">
              <div className="flex items-center gap-2 mb-1"><span className="w-7 h-7 rounded-full bg-primary-soft text-primary grid place-items-center text-xs font-semibold">{(c.studentName || '?')[0]}</span><span className="font-medium text-text text-sm">{c.studentName || 'Aluno'}</span></div>
              <p className="text-sm text-text">{c.text}</p>
              {Array.isArray(c.replies) && c.replies.map((r, j) => (
                <div key={j} className="mt-2 pl-3 border-l-2 border-primary/40 text-sm"><span className="font-medium text-primary">{r.authorName || r.authorRole}:</span> <span className="text-muted">{r.text}</span></div>
              ))}
            </Card>
          ))}
      </PageState>
    </div>
  )
}
