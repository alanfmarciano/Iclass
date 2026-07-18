import { cn } from '../../lib/cn'
const MAP = {
  neutral: 'bg-surface-2 text-muted', success: 'bg-success-soft text-success',
  danger: 'bg-danger-soft text-danger', warning: 'bg-warning-soft text-warning', info: 'bg-info-soft text-info',
}
export function Badge({ tone = 'neutral', dot, children, className }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium', MAP[tone], className)}>
      {dot && <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  )
}
