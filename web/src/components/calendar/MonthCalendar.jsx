import { useMemo } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '../ui/Button'

const TYPE_STYLE = {
  aula: 'border-l-info bg-info/10 text-text',
  prova: 'border-l-danger bg-danger/10 text-text',
  entrega: 'border-l-warning bg-warning/10 text-text',
  aviso: 'border-l-primary bg-primary-soft text-text',
  reuniao: 'border-l-success bg-success/10 text-text',
  outro: 'border-l-muted bg-surface-2 text-text',
}

const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab']

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function firstOfMonth(date = new Date()) { return new Date(date.getFullYear(), date.getMonth(), 1) }

export function MonthCalendar({ month, onMonthChange, events = [], onDayClick, onEventClick }) {
  const today = dateKey(new Date())
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
      if (!grouped[event.eventDate]) grouped[event.eventDate] = []
      grouped[event.eventDate].push(event)
    })
    Object.values(grouped).forEach((items) => items.sort((a, b) => String(a.startTime || '').localeCompare(String(b.startTime || ''))))
    return grouped
  }, [events])
  const title = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(month)
  const move = (amount) => onMonthChange(new Date(month.getFullYear(), month.getMonth() + amount, 1))

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-3">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => onMonthChange(firstOfMonth())}>Hoje</Button>
          <Button size="sm" variant="ghost" icon={ChevronLeft} aria-label="Mes anterior" onClick={() => move(-1)} />
          <Button size="sm" variant="ghost" icon={ChevronRight} aria-label="Proximo mes" onClick={() => move(1)} />
          <h2 className="ml-1 text-base font-semibold capitalize text-text">{title}</h2>
        </div>
        <span className="inline-flex items-center gap-2 text-xs text-muted"><CalendarDays size={15} /> {events.length} evento(s)</span>
      </div>
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
              return (
                <div
                  key={key}
                  onClick={() => onDayClick?.(key)}
                  className={`min-h-28 border-b border-r border-border p-2 transition ${index % 7 === 6 ? 'border-r-0' : ''} ${index >= 35 ? 'border-b-0' : ''} ${outside ? 'bg-bg/35 text-subtle' : 'text-text'} ${onDayClick ? 'cursor-pointer hover:bg-surface-2/45' : ''}`}
                >
                  <span className={`mb-1 grid h-6 w-6 place-items-center rounded-full text-xs font-semibold ${key === today ? 'bg-primary text-primary-fg' : ''}`}>{date.getDate()}</span>
                  <div className="space-y-1">
                    {items.slice(0, 3).map((event) => (
                      <button
                        key={event.id}
                        type="button"
                        onClick={(click) => { click.stopPropagation(); onEventClick?.(event) }}
                        className={`block w-full truncate rounded border-l-[3px] px-1.5 py-1 text-left text-[11px] hover:brightness-110 ${TYPE_STYLE[event.eventType] || TYPE_STYLE.outro}`}
                        title={event.title}
                      >
                        {event.startTime ? `${event.startTime} ` : ''}{event.title}
                      </button>
                    ))}
                    {items.length > 3 && <p className="px-1 text-[11px] text-muted">+{items.length - 3} evento(s)</p>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

