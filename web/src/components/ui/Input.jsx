import { cn } from '../../lib/cn'
import { useId } from 'react'
import { formatCharCount } from './Textarea'

// maxLength e counterFrom como no Textarea (H9b): a partir de counterFrom caracteres a
// contagem "N de M caracteres" aparece embaixo do campo.
export function Input({ label, error, helper, id, className, maxLength, counterFrom, ...props }) {
  const generatedId = useId()
  const fieldId = id || generatedId
  const helpId = `${fieldId}-help`
  const counterId = `${fieldId}-counter`
  const length = typeof props.value === 'string' ? props.value.length : 0
  const showCounter = !!maxLength && counterFrom !== undefined && length >= counterFrom
  const describedBy = [(error || helper) ? helpId : null, showCounter ? counterId : null].filter(Boolean).join(' ') || undefined
  return (
    <div className="min-w-0 flex flex-col gap-1.5">
      {label && <label htmlFor={fieldId} className="text-[13px] font-medium text-muted">{label}</label>}
      <input id={fieldId}
        className={cn('h-11 min-w-0 w-full px-3.5 rounded-lg bg-surface-2 border text-text text-sm placeholder:text-subtle transition-all duration-300 hover:border-[var(--border-strong)] focus:bg-surface', error ? 'border-danger' : 'border-border', className)}
        maxLength={maxLength} aria-invalid={!!error} aria-describedby={describedBy} {...props} />
      {showCounter && (
        <span id={counterId} aria-live="polite" className={cn('text-xs self-end', length >= maxLength ? 'text-warning' : 'text-muted')}>
          {formatCharCount(length)} de {formatCharCount(maxLength)} caracteres
        </span>
      )}
      {error ? <span id={helpId} role="alert" className="text-xs text-danger">{error}</span> : helper && <span id={helpId} className="text-xs text-subtle">{helper}</span>}
    </div>
  )
}
