import { CalendarPlus } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { EmptyLine } from '../../../components/ui/EmptyLine'

const TIPO_BORDA = {
  prova: 'border-primary', entrega: 'border-warning', aula: 'border-info',
  reuniao: 'border-primary/60', aviso: 'border-border', outro: 'border-border',
}
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']

// Agenda dos próximos 7 dias: eventos do calendário + próxima aplicação de prova.
export function WeekAgenda({ events = [], onOpen }) {
  return (
    <div className="premium-card flex flex-col rounded-2xl p-0">
      {events.map((ev) => {
        const d = new Date(`${ev.eventDate}T12:00:00`)
        return (
          <button key={ev.id} onClick={() => onOpen && onOpen(ev)}
            className="flex items-center gap-3.5 border-b border-border px-5 py-3 text-left transition-colors last:border-0 hover:bg-surface-2">
            <span className="w-11 flex-none text-center">
              <span className="block text-[17px] font-semibold leading-none tracking-[-0.02em] text-text tabular-nums">{d.getDate()}</span>
              <span className="mt-1 block text-[10px] uppercase tracking-[.1em] text-subtle">{DIAS[d.getDay()]}</span>
            </span>
            <span className={cn('min-w-0 flex-1 border-l-2 pl-3.5', TIPO_BORDA[ev.eventType] || TIPO_BORDA.outro)}>
              <span className="block truncate text-[13.5px] font-medium text-text">{ev.title}</span>
              <span className="mt-0.5 block truncate text-xs text-subtle">
                {[ev.startTime, ev.subtitle].filter(Boolean).join(' · ') || (ev.eventType === 'prova' ? 'avaliação' : ev.eventType)}
              </span>
            </span>
          </button>
        )
      })}
      <EmptyLine className={events.length ? 'border-t border-border' : ''} icon={CalendarPlus}
        title={events.length ? 'Nada mais agendado nesta semana' : 'Nada agendado nesta semana'}
        description="Eventos criados no Calendário aparecem aqui" />
    </div>
  )
}
