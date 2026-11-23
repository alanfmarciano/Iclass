import { useMemo, useState } from 'react'
import { ArrowRight, CalendarOff, Clock, Download, Users } from 'lucide-react'
import { Link } from 'react-router-dom'
import { MonthCalendar, firstOfMonth, dateKey, parseDateKey, NON_SCHOOL_EVENT_TYPE } from '../../components/calendar/MonthCalendar'
import { PageState } from '../../components/ui/PageState'
import { Modal } from '../../components/ui/Modal'
import { Badge } from '../../components/ui/Badge'
import { Card } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { useApi } from '../../hooks/useApi'
import { useAuth } from '../../context/AuthProvider'
import { useToast } from '../../context/ToastProvider'
import { downloadFile } from '../../lib/api'

// Prazo de atividade (fase 3, C9): o evento leva à atividade, onde o aluno envia. Só o
// endereço da própria tela de atividades vira link.
export function eventActivityHref(event) {
  const href = String(event?.href || '')
  return /^\/aluno\/atividades\/[^/?#]+$/.test(href) ? href : ''
}

// Calendário do aluno: eventos do curso e da turma e os dias sem aula (feriado, recesso,
// ponto facultativo; B3 e B7 / P2-S6, FUN-15), que aparecem como "Sem aula" e pintam o
// dia. "Baixar agenda (.ics)" leva o calendário para o Google Agenda, o Outlook ou o
// celular (GET /api/student/calendar.ics; importar de novo atualiza, não repete).
const TYPE_LABELS = { aula: 'Aula', prova: 'Prova', entrega: 'Entrega', aviso: 'Aviso', reuniao: 'Reunião', outro: 'Outro', nao_letivo: 'Sem aula' }

function brDate(value) {
  const date = parseDateKey(value)
  return date ? date.toLocaleDateString('pt-BR') : ''
}

function eventWhen(item) {
  const range = item.endDate && item.endDate !== item.eventDate ? `de ${brDate(item.eventDate)} a ${brDate(item.endDate)}` : brDate(item.eventDate)
  return `${range}${item.startTime ? ` - ${item.startTime}` : ''}`
}

export default function CalendarioPage() {
  const { auth } = useAuth()
  const toast = useToast()
  const [month, setMonth] = useState(firstOfMonth())
  const [detail, setDetail] = useState(null)
  const [downloading, setDownloading] = useState(false)
  const courseId = auth.activeClass?.courseId || auth.student?.courseId || ''
  const studentClass = auth.activeClass?.name || auth.student?.studentClass || ''
  const email = auth.email || ''
  const query = `courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(studentClass)}`
  const eventsApi = useApi(email && courseId && studentClass ? `/api/student/calendar-events?${query}` : null, [email, courseId, studentClass])
  const upcoming = useMemo(() => {
    // Hoje pelo relógio do aparelho (não em UTC: às 22 h ainda é hoje); o recesso que já
    // começou e ainda não acabou continua na lista.
    const today = dateKey(new Date())
    return (eventsApi.data || []).filter((item) => (item.endDate && item.endDate > item.eventDate ? item.endDate : item.eventDate) >= today).slice(0, 5)
  }, [eventsApi.data])

  async function downloadIcs() {
    setDownloading(true)
    try {
      await downloadFile(`/api/student/calendar.ics?${query}`, 'agenda.ics')
    } catch (error) { toast?.error?.(error.message) } finally { setDownloading(false) }
  }

  const semAula = detail?.eventType === NON_SCHOOL_EVENT_TYPE
  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="text-2xl font-bold text-text">Calendário</h1><p className="text-sm text-muted">Acompanhe aulas, provas, entregas, avisos e os dias sem aula do seu curso.</p></div>
        {courseId && studentClass && <Button variant="secondary" icon={Download} loading={downloading} onClick={downloadIcs} className="w-full sm:w-auto">Baixar agenda (.ics)</Button>}
      </div>
      <PageState loading={eventsApi.loading} error={eventsApi.error} onRetry={eventsApi.refetch}>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
          <MonthCalendar month={month} onMonthChange={setMonth} events={eventsApi.data || []} onEventClick={setDetail} />
          <Card className="h-fit p-4">
            <h2 className="mb-3 font-semibold text-text">Próximos compromissos</h2>
            {upcoming.length === 0 ? <p className="text-sm text-muted">Nenhum evento agendado.</p> : <div className="space-y-1">
              {upcoming.map((item) => <button key={item.id} type="button" onClick={() => setDetail(item)} className="w-full rounded-lg border-b border-border px-2 py-3 text-left transition last:border-0 hover:bg-surface-2">
                <p className="text-xs font-semibold text-primary">{eventWhen(item)}</p>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-sm font-medium text-text">{item.title}{item.eventType === NON_SCHOOL_EVENT_TYPE && <Badge tone="warning">Sem aula</Badge>}</p>
              </button>)}
            </div>}
          </Card>
        </div>
      </PageState>

      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.title || 'Evento'} description={detail ? eventWhen(detail) : ''}>
        {detail && (semAula ? (
          <div className="space-y-3">
            <Badge tone="warning">Sem aula</Badge>
            <p className="flex items-start gap-2 text-sm text-text"><CalendarOff size={15} className="mt-0.5 shrink-0 text-warning" /> {detail.description || 'Não há aula neste dia.'}</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2"><Badge tone="neutral">{TYPE_LABELS[detail.eventType] || 'Evento'}</Badge><Badge tone="info">{detail.target === 'turma' ? detail.targetValue : detail.target === 'grupo' ? `Grupo ${detail.grupo || ''}`.trim() : 'Curso inteiro'}</Badge></div>
            {detail.endTime && <p className="flex items-center gap-2 text-sm text-muted"><Clock size={15} /> Termina às {detail.endTime}</p>}
            <p className="flex items-center gap-2 text-sm text-muted"><Users size={15} /> {detail.target === 'turma' ? `Turma ${detail.targetValue}` : detail.target === 'grupo' ? (detail.grupo ? `Só o grupo ${detail.grupo}` : 'Só o seu grupo') : 'Todos os alunos do curso'}</p>
            {detail.description ? <p className="whitespace-pre-wrap text-sm text-text">{detail.description}</p> : <p className="text-sm text-muted">Sem informações adicionais.</p>}
            {eventActivityHref(detail) && <Link to={eventActivityHref(detail)} className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-fg hover:bg-primary-hover">Abrir a atividade <ArrowRight aria-hidden="true" size={15} /></Link>}
          </div>
        ))}
      </Modal>
    </div>
  )
}
