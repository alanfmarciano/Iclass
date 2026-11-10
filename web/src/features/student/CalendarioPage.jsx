import { useMemo, useState } from 'react'
import { CalendarDays, Clock, Users } from 'lucide-react'
import { MonthCalendar, firstOfMonth } from '../../components/calendar/MonthCalendar'
import { PageState } from '../../components/ui/PageState'
import { Modal } from '../../components/ui/Modal'
import { Badge } from '../../components/ui/Badge'
import { Card } from '../../components/ui/Card'
import { useApi } from '../../hooks/useApi'
import { useAuth } from '../../context/AuthProvider'

const TYPE_LABELS = { aula: 'Aula', prova: 'Prova', entrega: 'Entrega', aviso: 'Aviso', reuniao: 'Reunião', outro: 'Outro' }

export default function CalendarioPage() {
  const { auth } = useAuth()
  const [month, setMonth] = useState(firstOfMonth())
  const [detail, setDetail] = useState(null)
  const courseId = auth.activeClass?.courseId || auth.student?.courseId || ''
  const studentClass = auth.activeClass?.name || auth.student?.studentClass || ''
  const email = auth.email || ''
  const eventsApi = useApi(email && courseId && studentClass ? `/api/student/calendar-events?courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(studentClass)}` : null, [email, courseId, studentClass])
  const upcoming = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10)
    return (eventsApi.data || []).filter((item) => item.eventDate >= today).slice(0, 5)
  }, [eventsApi.data])

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div><h1 className="text-2xl font-bold text-text">Calendário</h1><p className="text-sm text-muted">Acompanhe aulas, provas, entregas e avisos do seu curso.</p></div>
      <PageState loading={eventsApi.loading} error={eventsApi.error} onRetry={eventsApi.refetch}>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
          <MonthCalendar month={month} onMonthChange={setMonth} events={eventsApi.data || []} onEventClick={setDetail} />
          <Card className="h-fit p-4">
            <h2 className="mb-3 font-semibold text-text">Próximos compromissos</h2>
            {upcoming.length === 0 ? <p className="text-sm text-muted">Nenhum evento agendado.</p> : <div className="space-y-1">
              {upcoming.map((item) => <button key={item.id} type="button" onClick={() => setDetail(item)} className="w-full rounded-lg border-b border-border px-2 py-3 text-left transition last:border-0 hover:bg-surface-2">
                <p className="text-xs font-semibold text-primary">{new Date(`${item.eventDate}T12:00:00`).toLocaleDateString('pt-BR')}{item.startTime ? ` - ${item.startTime}` : ''}</p>
                <p className="mt-1 text-sm font-medium text-text">{item.title}</p>
              </button>)}
            </div>}
          </Card>
        </div>
      </PageState>

      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.title || 'Evento'} description={detail ? `${new Date(`${detail.eventDate}T12:00:00`).toLocaleDateString('pt-BR')}${detail.startTime ? ` - ${detail.startTime}` : ''}` : ''}>
        {detail && <div className="space-y-4">
          <div className="flex flex-wrap gap-2"><Badge tone="neutral">{TYPE_LABELS[detail.eventType] || 'Evento'}</Badge><Badge tone="info">{detail.target === 'turma' ? detail.targetValue : 'Curso inteiro'}</Badge></div>
          {detail.endTime && <p className="flex items-center gap-2 text-sm text-muted"><Clock size={15} /> Termina às {detail.endTime}</p>}
          <p className="flex items-center gap-2 text-sm text-muted"><Users size={15} /> {detail.target === 'turma' ? `Turma ${detail.targetValue}` : 'Todos os alunos do curso'}</p>
          {detail.description ? <p className="whitespace-pre-wrap text-sm text-text">{detail.description}</p> : <p className="text-sm text-muted">Sem informações adicionais.</p>}
        </div>}
      </Modal>
    </div>
  )
}
