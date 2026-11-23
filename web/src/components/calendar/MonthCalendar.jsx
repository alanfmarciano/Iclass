import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, CalendarOff, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '../ui/Button'

// Calendário do mês do painel e do portal do aluno.
//
// - events: [{ id, title, eventDate, endDate?, startTime?, eventType }]. O evento com
//   endDate (o recesso de vários dias, B3 / P2-S5) aparece em todos os dias do intervalo.
// - Dia não letivo (eventType 'nao_letivo': feriado, recesso, ponto facultativo) pinta o
//   dia inteiro e mostra o selo "Sem aula" (B7 / P2-S6, FUN-15).
// - No celular (abaixo de 768 px) a grade de 7 colunas não cabe com texto: o mês vira uma
//   lista por dia, só com os dias que têm evento (o resto da tela não rola para o lado).
const TYPE_STYLE = {
  aula: 'border-l-info bg-info/10 text-text',
  prova: 'border-l-danger bg-danger/10 text-text',
  entrega: 'border-l-warning bg-warning/10 text-text',
  aviso: 'border-l-primary bg-primary-soft text-text',
  reuniao: 'border-l-success bg-success/10 text-text',
  nao_letivo: 'border-l-warning bg-warning-soft text-text font-medium',
  outro: 'border-l-muted bg-surface-2 text-text',
}

export const NON_SCHOOL_EVENT_TYPE = 'nao_letivo'
export const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
// Um recesso cobre no máximo 120 dias (academicCalendar.MAX_NON_SCHOOL_DAY_SPAN); o laço
// para aí mesmo que um registro venha com o fim errado.
const MAX_SPAN_DAYS = 120
const COMPACT_MEDIA = '(max-width: 767px)'

export function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function firstOfMonth(date = new Date()) { return new Date(date.getFullYear(), date.getMonth(), 1) }

// 'AAAA-MM-DD' → Date ao meio-dia local (sem pular de dia no horário de verão).
export function parseDateKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''))
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12) : null
}

// As datas que o evento cobre: só eventDate, ou de eventDate a endDate.
export function eventDates(event) {
  const start = parseDateKey(event?.eventDate)
  if (!start) return []
  const end = parseDateKey(event.endDate)
  if (!end || end <= start) return [event.eventDate]
  const out = []
  const cursor = new Date(start)
  while (cursor <= end && out.length < MAX_SPAN_DAYS) {
    out.push(dateKey(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
}

// O evento cruza o mês mostrado?
export function eventInMonth(event, month) {
  const first = dateKey(firstOfMonth(month))
  const last = dateKey(new Date(month.getFullYear(), month.getMonth() + 1, 0))
  const end = event.endDate && event.endDate > event.eventDate ? event.endDate : event.eventDate
  return !!event.eventDate && event.eventDate <= last && end >= first
}

// 'Seg., 23 de nov.' (só a primeira letra maiúscula; o capitalize do CSS faria "De Nov.").
function dayHeading(date) {
  const text = date.toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'short' })
  return text.charAt(0).toLocaleUpperCase('pt-BR') + text.slice(1)
}

function useCompact() {
  const read = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && !!window.matchMedia(COMPACT_MEDIA)?.matches
  const [compact, setCompact] = useState(read)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const media = window.matchMedia(COMPACT_MEDIA)
    if (!media) return undefined
    const onChange = () => setCompact(!!media.matches)
    onChange()
    if (media.addEventListener) media.addEventListener('change', onChange)
    else if (media.addListener) media.addListener(onChange)
    return () => {
      if (media.removeEventListener) media.removeEventListener('change', onChange)
      else if (media.removeListener) media.removeListener(onChange)
    }
  }, [])
  return compact
}

function EventChip({ event, onEventClick, compact = false }) {
  const naoLetivo = event.eventType === NON_SCHOOL_EVENT_TYPE
  return (
    <button
      type="button"
      onClick={(click) => { click.stopPropagation(); onEventClick?.(event) }}
      className={`block w-full rounded border-l-[3px] text-left hover:brightness-110 ${compact ? 'px-3 py-2 text-sm' : 'truncate px-1.5 py-1 text-[11px]'} ${TYPE_STYLE[event.eventType] || TYPE_STYLE.outro}`}
      title={event.title}
    >
      {naoLetivo && <span className="sr-only">Sem aula: </span>}
      {event.startTime ? `${event.startTime} ` : ''}{event.title}
    </button>
  )
}

export function MonthCalendar({ month, onMonthChange, events = [], onDayClick, onEventClick }) {
  const today = dateKey(new Date())
  const compact = useCompact()
  const cells = useMemo(() => {
    const first = firstOfMonth(month)
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay())
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start)
      date.setDate(start.getDate() + index)
      return date
    })
  }, [month])
  const byDate = useMemo(() => {
    const grouped = {}
    events.forEach((event) => {
      eventDates(event).forEach((key) => {
        if (!grouped[key]) grouped[key] = []
        grouped[key].push(event)
      })
    })
    // O dia não letivo vem primeiro (diz que não há aula); depois, pela hora.
    Object.values(grouped).forEach((items) => items.sort((a, b) => (
      (b.eventType === NON_SCHOOL_EVENT_TYPE) - (a.eventType === NON_SCHOOL_EVENT_TYPE)
      || String(a.startTime || '').localeCompare(String(b.startTime || ''), 'pt-BR')
    )))
    return grouped
  }, [events])
  const monthEvents = useMemo(() => events.filter((event) => eventInMonth(event, month)), [events, month])
  // 'Novembro de 2026' (o capitalize do CSS escrevia "Novembro De 2026").
  const monthText = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(month)
  const title = monthText.charAt(0).toLocaleUpperCase('pt-BR') + monthText.slice(1)
  const move = (amount) => onMonthChange(new Date(month.getFullYear(), month.getMonth() + amount, 1))
  const monthPrefix = dateKey(firstOfMonth(month)).slice(0, 7)
  const listDays = Object.keys(byDate).filter((key) => key.startsWith(monthPrefix)).sort()

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-3">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => onMonthChange(firstOfMonth())}>Hoje</Button>
          <Button size="sm" variant="ghost" icon={ChevronLeft} aria-label="Mês anterior" onClick={() => move(-1)} />
          <Button size="sm" variant="ghost" icon={ChevronRight} aria-label="Próximo mês" onClick={() => move(1)} />
          <h2 className="ml-1 text-base font-semibold text-text">{title}</h2>
        </div>
        <span className="inline-flex items-center gap-2 text-xs text-muted"><CalendarDays size={15} /> {monthEvents.length} evento(s)</span>
      </div>
      {compact ? (
        <ol aria-label={`Dias de ${title}`} className="divide-y divide-border">
          {listDays.length === 0 && <li className="p-4 text-sm text-muted">Nenhum evento neste mês.</li>}
          {listDays.map((key) => {
            const date = parseDateKey(key)
            const items = byDate[key]
            const semAula = items.some((event) => event.eventType === NON_SCHOOL_EVENT_TYPE)
            return (
              <li key={key} className={`p-3 ${semAula ? 'bg-warning-soft/40' : ''}`}>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className={`text-sm font-semibold ${key === today ? 'text-primary' : 'text-text'}`}>
                    {dayHeading(date)}{key === today ? ' · hoje' : ''}
                  </span>
                  {semAula && <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning"><CalendarOff size={12} aria-hidden="true" />Sem aula</span>}
                </div>
                <div className="space-y-1.5">
                  {items.map((event) => <EventChip key={`${event.id}-${key}`} event={event} onEventClick={onEventClick} compact />)}
                </div>
              </li>
            )
          })}
        </ol>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[760px]">
            <div className="grid grid-cols-7 border-b border-border bg-surface-2/50">
              {WEEKDAYS.map((day) => <div key={day} className="px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-subtle">{day}</div>)}
            </div>
            <div className="grid grid-cols-7">
              {cells.map((date, index) => {
                const key = dateKey(date)
                const items = byDate[key] || []
                const outside = date.getMonth() !== month.getMonth()
                const semAula = items.some((event) => event.eventType === NON_SCHOOL_EVENT_TYPE)
                return (
                  <div
                    key={key}
                    data-date={key}
                    data-sem-aula={semAula ? 'true' : undefined}
                    onClick={() => onDayClick?.(key)}
                    className={`min-h-28 border-b border-r border-border p-2 transition ${index % 7 === 6 ? 'border-r-0' : ''} ${index >= 35 ? 'border-b-0' : ''} ${outside ? 'bg-bg/35 text-subtle' : semAula ? 'bg-warning-soft/40 text-text' : 'text-text'} ${onDayClick ? 'cursor-pointer hover:bg-surface-2/45' : ''}`}
                  >
                    <div className="mb-1 flex items-center justify-between gap-1">
                      <span className={`grid h-6 w-6 place-items-center rounded-full text-xs font-semibold ${key === today ? 'bg-primary text-primary-fg' : ''}`}>{date.getDate()}</span>
                      {semAula && !outside && <span className="text-[10px] font-semibold uppercase tracking-wide text-warning">Sem aula</span>}
                    </div>
                    <div className="space-y-1">
                      {items.slice(0, 3).map((event) => <EventChip key={`${event.id}-${key}`} event={event} onEventClick={onEventClick} />)}
                      {items.length > 3 && <p className="px-1 text-[11px] text-muted">+{items.length - 3} evento(s)</p>}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
