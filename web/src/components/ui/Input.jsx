import { cn } from '../../lib/cn'
import { useId } from 'react'
export function Input({ label, error, helper, id, className, ...props }) {
  const generatedId = useId()
  const fieldId = id || generatedId
  const helpId = `${fieldId}-help`
  return (
    <div className="min-w-0 flex flex-col gap-1.5">
      {label && <label htmlFor={fieldId} className="text-[13px] font-medium text-muted">{label}</label>}
      <input id={fieldId}
        className={cn('h-11 min-w-0 w-full px-3.5 rounded-lg bg-surface-2 border text-text text-sm placeholder:text-subtle transition-all duration-300 hover:border-[var(--border-strong)] focus:bg-surface', error ? 'border-danger' : 'border-border', className)}
        aria-invalid={!!error} aria-describedby={(error || helper) ? helpId : undefined} {...props} />
      {error ? <span id={helpId} role="alert" className="text-xs text-danger">{error}</span> : helper && <span id={helpId} className="text-xs text-subtle">{helper}</span>}
    </div>
  )
}
