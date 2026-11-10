import { AlertTriangle, ArrowRight, BookOpen, CalendarDays, CheckCircle2, Clock, Megaphone, Sparkles, TrendingUp, UserCheck } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Card } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { PageState } from '../../components/ui/PageState'
import { useApi } from '../../hooks/useApi'
import { useStudent } from './useStudent'
import { fmtGradeValue } from '../../lib/grades'

const EVENT_TONES = { aula: 'info', prova: 'danger', entrega: 'warning', aviso: 'neutral', reuniao: 'success' }

function Metric({ label, value, helper, icon: Icon, tone = 'text-primary' }) {
  return (
    <Card className="premium-card-interactive relative overflow-hidden p-5">
      <span className="absolute -right-5 -top-6 h-20 w-20 rounded-full bg-primary-soft blur-2xl" aria-hidden />
      <div className="flex items-center justify-between gap-3"><span className="text-[13px] font-medium text-muted">{label}</span><span className={`grid h-10 w-10 place-items-center rounded-xl bg-surface-2 ${tone}`}><Icon size={17} /></span></div>
      <p className="mt-4 text-[1.8rem] font-semibold leading-none tracking-[-0.04em] tabular-nums text-text">{value}</p>
      <p className="mt-2 text-xs text-subtle">{helper}</p>
    </Card>
  )
}

function CourseProgress({ value = 0 }) {
  const safe = Math.max(0, Math.min(100, Number(value) || 0))
  return (
    <div className="relative grid h-28 w-28 place-items-center rounded-full" style={{ background: `conic-gradient(var(--primary) ${safe * 3.6}deg, var(--surface-2) 0deg)` }} aria-label={`${safe}% de progresso`}>
      <div className="grid h-[92px] w-[92px] place-items-center rounded-full bg-surface shadow-[inset_0_1px_0_var(--border-strong)]">
        <div className="text-center"><strong className="block text-2xl font-semibold tracking-[-0.04em] text-text">{safe}%</strong><span className="text-[10px] uppercase tracking-[.12em] text-subtle">concluído</span></div>
      </div>
    </div>
  )
}

function formatDate(date) {
  if (!date) return ''
  return new Date(`${date}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '')
}

function MiniCalendar({ events = [], onOpen }) {
  const today = new Date()
  const first = new Date(today.getFullYear(), today.getMonth(), 1)
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay())
  const cells = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    return date
  })
  const keyOf = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const todayKey = keyOf(today)
  const eventDates = new Set(events.map((event) => event.eventDate))
  const title = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(today)

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div><h2 className="flex items-center gap-2 font-semibold text-text"><CalendarDays size={17} /> Calendário</h2><p className="mt-0.5 text-xs capitalize text-muted">{title}</p></div>
        <button type="button" onClick={onOpen} className="text-xs text-muted hover:text-text">Abrir</button>
      </div>
      <div className="grid grid-cols-7 px-3 pt-3 text-center text-[10px] font-semibold uppercase text-subtle">
        {['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}
      </div>
      <div className="grid grid-cols-7 gap-y-1 p-3 pt-2">
        {cells.map((date) => {
          const key = keyOf(date)
          const outside = date.getMonth() !== today.getMonth()
          const isToday = key === todayKey
          return (
            <button key={key} type="button" onClick={onOpen} className={`relative mx-auto grid h-8 w-8 place-items-center rounded-full text-xs transition hover:bg-surface-2 ${outside ? 'text-subtle opacity-40' : 'text-muted'} ${isToday ? 'bg-primary font-bold text-primary-fg hover:bg-primary' : ''}`}>
              {date.getDate()}
              {eventDates.has(key) && <span className={`absolute bottom-0.5 h-1 w-1 rounded-full ${isToday ? 'bg-primary-fg' : 'bg-primary'}`} />}
            </button>
          )
        })}
      </div>
    </Card>
  )
}

export default function InicioPage() {
  const { email, name, displayName, studentClass, courseId } = useStudent()
  const nav = useNavigate()
  const dashboard = useApi(email ? `/api/student/dashboard?email=${encodeURIComponent(email)}&studentClass=${encodeURIComponent(studentClass)}&courseId=${encodeURIComponent(courseId)}` : null, [email, studentClass, courseId], { pollMs: 10000 })
  const calendar = useApi(email ? `/api/student/calendar-events?courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(studentClass)}` : null, [email, courseId, studentClass], { pollMs: 10000 })
  const data = dashboard.data || {}
  const modules = data.modules || []
  const firstName = (displayName || name || 'aluno').split(' ')[0]

  return (
    <div className="mx-auto max-w-[1320px] space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><p className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[.16em] text-primary"><Sparkles size={13} /> Seu espaço de aprendizagem</p><h1 className="text-[2rem] font-semibold leading-tight tracking-[-0.045em] text-text">Olá, {firstName} <span aria-hidden>👋</span></h1><p className="mt-1.5 text-sm text-muted">Aqui está o que merece sua atenção hoje.</p></div>
        <div className="hidden rounded-full border border-border bg-surface-glass px-4 py-2 text-xs text-muted backdrop-blur-lg md:block">{new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' }).format(new Date())}</div>
      </div>
      <PageState loading={dashboard.loading} error={dashboard.error} onRetry={dashboard.refetch}>
        <Card className="relative grid min-h-[210px] items-center gap-6 overflow-hidden p-6 md:grid-cols-[minmax(0,1fr)_auto] md:px-8">
          <span className="ambient-orb pointer-events-none absolute -right-16 -top-20 h-64 w-64 rounded-full bg-primary-soft blur-3xl" aria-hidden />
          <span className="pointer-events-none absolute bottom-0 left-1/3 h-28 w-80 rounded-full bg-info-soft blur-3xl" aria-hidden />
          <div className="relative z-10"><p className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary-soft px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[.14em] text-primary"><BookOpen size={12} /> Seu curso atual</p><h2 className="mt-4 text-2xl font-semibold tracking-[-0.035em] text-text md:text-[1.75rem]">{data.courseName || courseId || 'Curso'}</h2><p className="mt-2 text-sm text-muted">Turma {studentClass || '-'} · {data.completedCount || 0} de {data.totalUnits || 0} tópicos concluídos.</p><button type="button" onClick={() => nav('/aluno/modulos')} className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-text transition-colors hover:text-primary">Continuar aprendendo <ArrowRight size={15} /></button></div>
          <div className="relative z-10 flex items-center justify-center md:pr-3"><CourseProgress value={data.progress} /></div>
        </Card>

        <div className="stagger-grid grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Metric label="Nota geral" value={fmtGradeValue(data.overallNote, '-')} helper={data.overallNote == null ? 'Aguardando publicação' : 'Somente notas publicadas'} icon={TrendingUp} tone="text-success" />
          <Metric label="Frequência" value={data.frequency == null ? '-' : `${data.frequency}%`} helper={data.frequency == null ? 'Sem registros ainda' : 'Presença registrada'} icon={UserCheck} tone="text-info" />
          <Metric label="Tópicos concluídos" value={`${data.completedCount || 0}/${data.totalUnits || 0}`} helper="Progresso no curso" icon={CheckCircle2} tone="text-success" />
          <Metric label="Pendências" value={data.pendingCount || 0} helper="Conteúdos liberados" icon={AlertTriangle} tone="text-warning" />
        </div>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(290px,.75fr)]">
          <div className="space-y-4">
            <Card>
              <div className="flex items-center justify-between border-b border-border px-5 py-4"><h2 className="font-semibold text-text">Continue de onde parou</h2><span className="text-xs text-muted">Seu último conteúdo</span></div>
              <button type="button" onClick={() => nav('/aluno/modulos')} className="group flex w-full items-center gap-4 p-5 text-left transition-all duration-300 hover:bg-surface-2/40">
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary transition-transform duration-300 group-hover:scale-105"><BookOpen size={21} /></span>
                <span className="min-w-0 flex-1"><strong className="block truncate text-sm text-text">{data.continueItem?.title || 'Acesse seus módulos'}</strong><span className="mt-1 block truncate text-xs text-muted">{data.continueItem?.moduleName || 'Continue avançando no curso'}</span></span>
                <span className="grid h-9 w-9 place-items-center rounded-full border border-border text-subtle transition-all duration-300 group-hover:border-primary/30 group-hover:bg-primary-soft group-hover:text-primary"><ArrowRight size={15} /></span>
              </button>
            </Card>

            <Card>
              <div className="flex items-center justify-between border-b border-border px-5 py-4"><h2 className="font-semibold text-text">Meus módulos</h2><button type="button" onClick={() => nav('/aluno/modulos')} className="text-xs text-muted hover:text-text">Ver todos</button></div>
              {modules.length === 0 ? <p className="p-5 text-sm text-muted">Nenhum módulo disponível.</p> : <div className="grid grid-cols-1 md:grid-cols-3">
                {modules.slice(0, 6).map((module, index) => (
                  <button key={module.id || index} type="button" onClick={() => nav('/aluno/modulos')} className="border-b border-border p-4 text-left transition last:border-b-0 hover:bg-surface-2/40 md:border-b-0 md:border-r md:last:border-r-0">
                    <div className="flex items-start justify-between gap-2"><span className="grid h-9 w-9 place-items-center rounded-md bg-surface-2 text-primary"><BookOpen size={17} /></span><span className="text-right">{module.noteStatus === 'published' ? <><small className="block text-[10px] uppercase text-subtle">Nota publicada</small><strong className="text-lg text-text">{fmtGradeValue(module.note)}</strong></> : module.noteStatus === 'review' ? <Badge tone="warning">Nota em revisão</Badge> : <small className="text-subtle">Sem nota</small>}</span></div>
                    <h3 className="mt-4 truncate text-sm font-semibold text-text">{module.name}</h3><p className="mt-1 text-xs text-muted">{module.done} de {module.total} tópicos concluídos</p>
                    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2"><div className="progress-reveal h-full rounded-full bg-primary" style={{ width: `${module.progress}%` }} /></div>
                  </button>
                ))}
              </div>}
              <p className="border-t border-border px-5 py-2.5 text-[11px] text-subtle">🔒 As notas aparecem somente depois da publicação pelo professor.</p>
            </Card>

            {data.performance?.length > 0 && <Card>
              <div className="flex items-center justify-between border-b border-border px-5 py-4"><h2 className="font-semibold text-text">Seu desempenho</h2><span className="text-xs text-muted">Últimas notas publicadas</span></div>
              <div className="flex h-40 items-end gap-3 p-5">
                {data.performance.map((item) => <div key={item.id} className="flex h-full flex-1 flex-col justify-end text-center"><span className="mb-1 text-xs font-semibold text-text">{fmtGradeValue(item.note)}</span><div className="mx-auto w-full max-w-10 rounded-t bg-info" style={{ height: `${Math.max(8, item.note * 10)}%` }} /><span className="mt-2 truncate text-[10px] text-subtle" title={item.examKey}>{item.examKey?.replace(/^Avaliacao_/, '')}</span></div>)}
              </div>
            </Card>}
          </div>

          <div className="space-y-4">
            <MiniCalendar events={calendar.data || []} onOpen={() => nav('/aluno/calendario')} />

            <Card>
              <div className="flex items-center justify-between border-b border-border px-4 py-3"><h2 className="flex items-center gap-2 font-semibold text-text"><CalendarDays size={17} /> Próximos compromissos</h2><button type="button" onClick={() => nav('/aluno/calendario')} className="text-xs text-muted hover:text-text">Calendário</button></div>
              {data.calendar?.length ? data.calendar.map((item) => <button key={item.id} type="button" onClick={() => nav('/aluno/calendario')} className="flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left transition last:border-0 hover:bg-surface-2/40"><span className="grid h-10 min-w-10 place-items-center rounded-md bg-primary-soft px-1 text-[11px] font-semibold uppercase text-primary">{formatDate(item.eventDate)}</span><span className="min-w-0 flex-1"><strong className="block truncate text-sm text-text">{item.title}</strong><span className="mt-0.5 flex items-center gap-1 text-xs text-muted"><Clock size={11} /> {item.startTime || 'Dia todo'}</span></span><Badge tone={EVENT_TONES[item.eventType] || 'neutral'}>{item.eventType}</Badge></button>) : <p className="p-4 text-sm text-muted">Nenhum compromisso agendado.</p>}
            </Card>

            <Card>
              <div className="flex items-center justify-between border-b border-border px-4 py-3"><h2 className="flex items-center gap-2 font-semibold text-text"><Megaphone size={17} /> Avisos recentes</h2><button type="button" onClick={() => nav('/aluno/avisos')} className="text-xs text-muted hover:text-text">Ver todos</button></div>
              {data.announcements?.length ? data.announcements.map((item) => <button key={item.id} type="button" onClick={() => nav('/aluno/avisos')} className="flex w-full gap-3 border-b border-border px-4 py-3 text-left transition last:border-0 hover:bg-surface-2/40"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-surface-2 text-primary"><Megaphone size={16} /></span><span className="min-w-0"><strong className="block truncate text-sm text-text">{item.title}</strong><span className="mt-0.5 line-clamp-2 text-xs text-muted">{item.message}</span></span></button>) : <p className="p-4 text-sm text-muted">Nenhum aviso recente.</p>}
            </Card>
          </div>
        </div>
      </PageState>
    </div>
  )
}
