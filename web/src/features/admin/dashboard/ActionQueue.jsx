import { ArrowRight, CheckCircle2, Clock3, FileQuestion, Inbox, Lock, UserPlus } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { EmptyLine } from '../../../components/ui/EmptyLine'

const ICONE = {
  chamada_pendente: Clock3, duvidas_paradas: FileQuestion, sem_avaliacao: Inbox,
  matriculas: UserPlus, conteudo_bloqueado: Lock,
}
const TONE_ICO = {
  danger: 'bg-danger-soft text-danger', warning: 'bg-warning-soft text-warning',
  info: 'bg-info-soft text-info', early: 'bg-primary-soft text-primary', neutral: 'bg-surface-2 text-subtle',
}
const TONE_N = {
  danger: 'text-danger', warning: 'text-warning', info: 'text-info', early: 'text-primary', neutral: 'text-subtle',
}

function QueueRow({ item, onOpen, onSnooze }) {
  const Icon = ICONE[item.tipo] || Inbox
  return (
    <div className="group flex items-center gap-3.5 border-b border-border px-5 py-3.5 transition-colors last:border-0 hover:bg-surface-2">
      <button onClick={() => onOpen(item)} className="flex min-w-0 flex-1 items-center gap-3.5 text-left" aria-label={`${item.titulo} — abrir ${item.href}`}>
        <span className={cn('grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px]', TONE_ICO[item.tone] || TONE_ICO.neutral)}>
          <Icon size={15} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium text-text">{item.titulo}</span>
          <span className="mt-0.5 block truncate text-xs text-subtle">{item.detalhe}</span>
        </span>
        <span className={cn('flex-none text-[19px] font-semibold tabular-nums tracking-[-0.02em]', TONE_N[item.tone] || TONE_N.neutral)}>{item.count}</span>
        <ArrowRight size={14} className="flex-none text-subtle" aria-hidden="true" />
      </button>
      {onSnooze && (
        <button onClick={() => onSnooze(item)} title="Adiar por 24 horas" aria-label={`Adiar "${item.titulo}" por 24 horas`}
          className="flex-none rounded-md px-1.5 py-1 text-[11px] text-subtle opacity-0 transition-opacity hover:bg-surface hover:text-text focus-visible:opacity-100 group-hover:opacity-100">
          adiar 24h
        </button>
      )}
    </div>
  )
}

// Fila "Precisa de você" — cada linha é uma pendência com destino clicável.
// Fila vazia é o melhor dia possível do professor: estado calmo e afirmativo.
export function ActionQueue({ items = [], onOpen, onSnooze }) {
  if (!items.length) {
    return (
      <div className="premium-card rounded-2xl">
        <EmptyLine icon={CheckCircle2} title="Nada pendente nesta turma" description="Chamada em dia, dúvidas respondidas e todos avaliados." />
      </div>
    )
  }
  return (
    <div className="premium-card flex flex-col rounded-2xl p-0">
      {items.map((item) => <QueueRow key={item.id} item={item} onOpen={onOpen} onSnooze={onSnooze} />)}
    </div>
  )
}
