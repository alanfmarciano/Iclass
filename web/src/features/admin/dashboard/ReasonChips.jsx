import { cn } from '../../../lib/cn'

const TONE = {
  danger: 'bg-danger-soft text-danger border-transparent',
  warning: 'bg-warning-soft text-warning border-transparent',
  neutral: 'bg-surface-2 text-muted border-border',
}

// Motivos do risco em chips. Corta em `max` (padrão 2) + "mais N" — com 4
// motivos a linha estouraria e empurraria o badge de risco para fora.
export function ReasonChips({ reasons = [], max = 2, className }) {
  if (!reasons.length) return null
  const visiveis = reasons.slice(0, max)
  const resto = reasons.length - visiveis.length
  return (
    <div className={cn('mt-1.5 flex flex-wrap items-center gap-1.5', className)}>
      {visiveis.map((r, i) => {
        const item = typeof r === 'string' ? { text: r, tone: 'neutral' } : r
        return (
          <span key={i} className={cn('whitespace-nowrap rounded-md border px-2 py-0.5 text-[11.5px]', TONE[item.tone] || TONE.neutral)}>
            {item.text}
          </span>
        )
      })}
      {resto > 0 && (
        <span className="text-[11.5px] text-subtle" title={reasons.slice(max).map((r) => (typeof r === 'string' ? r : r.text)).join(' · ')}>
          mais {resto}
        </span>
      )}
    </div>
  )
}
