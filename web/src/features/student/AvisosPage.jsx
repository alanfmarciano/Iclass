import { useState, useEffect } from 'react'
import { Megaphone, AlertTriangle, Pin } from 'lucide-react'
import { Card } from '../../components/ui/Card'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageState } from '../../components/ui/PageState'
import { api } from '../../lib/api'
import { useStudent } from './useStudent'

function when(ts) { try { return new Date(ts).toLocaleString('pt-BR') } catch { return '' } }

export default function AvisosPage() {
  const { email, courseId, studentClass } = useStudent()
  const [list, setList] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [opened, setOpened] = useState(null)

  async function load() {
    setLoading(true); setError(null)
    try {
      const response = await api.get(`/api/student/announcements?courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(studentClass)}`)
      setList(Array.isArray(response) ? response : [])
    } catch (loadError) { setError(loadError) } finally { setLoading(false) }
  }
  useEffect(() => { if (email && courseId && studentClass) load() /* eslint-disable-next-line */ }, [email, courseId, studentClass])

  function openAnnouncement(announcement) {
    setOpened((current) => current === announcement.id ? null : announcement.id)
    if (!announcement.read) {
      setList((current) => current.map((item) => item.id === announcement.id ? { ...item, read: true } : item))
      api.post('/api/student/announcements/read', { email, id: announcement.id }).catch(() => {})
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div><h1 className="text-2xl font-bold text-text">Avisos</h1><p className="text-sm text-muted">Comunicados do seu instrutor e da instituição.</p></div>
      <PageState loading={loading} error={error} onRetry={load}>
        {list.length === 0 ? (
          <Card><EmptyState icon={Megaphone} title="Nenhum aviso" description="Você está em dia. Novos comunicados aparecem aqui." /></Card>
        ) : (
          <div className="space-y-2">
            {list.map((announcement) => (
              <Card key={announcement.id} className={`p-4 ${!announcement.read ? 'border-primary/40' : ''}`}>
                <button type="button" className="w-full text-left" aria-expanded={opened === announcement.id} onClick={() => openAnnouncement(announcement)}>
                  <div className="flex items-start gap-3">
                    <span className={`w-8 h-8 rounded-md grid place-items-center shrink-0 ${announcement.priority === 'alta' ? 'bg-danger/15 text-danger' : 'bg-primary-soft text-primary'}`}>
                      {announcement.priority === 'alta' ? <AlertTriangle size={16} /> : <Megaphone size={16} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-text">{announcement.title}</span>
                        {announcement.pinned && <span className="text-warning flex items-center gap-1 text-xs"><Pin size={11} /> Fixado</span>}
                        {!announcement.read && <span className="text-[11px] font-semibold text-primary">NOVO</span>}
                      </div>
                      {opened === announcement.id && <p className="text-sm text-text mt-1 whitespace-pre-wrap">{announcement.message}</p>}
                      <p className="text-xs text-subtle mt-2">{announcement.authorName || 'Instrutor'} · {when(announcement.createdAt)}</p>
                    </div>
                  </div>
                </button>
              </Card>
            ))}
          </div>
        )}
      </PageState>
    </div>
  )
}
