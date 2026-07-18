import { cn } from '../../lib/cn'
import { useId } from 'react'
export function Textarea({ label, id, error, className, ...props }) {
  const generatedId = useId()
  const fieldId = id || generatedId
  const errorId = `${fieldId}-error`
  return (
    <div className="flex flex-col gap-1.5">
      {label && <label htmlFor={fieldId} className="text-sm font-medium text-text">{label}</label>}
      <textarea id={fieldId} aria-invalid={!!error} aria-describedby={error ? errorId : undefined} className={cn('px-3 py-2 rounded-md bg-surface border text-text text-sm min-h-[100px]', error ? 'border-danger' : 'border-border', className)} {...props} />
      {error && <span id={errorId} role="alert" className="text-xs text-danger">{error}</span>}
    </div>
  )
}
