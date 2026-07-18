import { cn } from '../../lib/cn'
import { useId } from 'react'
export function Select({ label, error, id, className, children, ...props }) {
  const generatedId = useId()
  const fieldId = id || generatedId
  const errorId = `${fieldId}-error`
  return (
    <div className="min-w-0 flex flex-col gap-1.5">
      {label && <label htmlFor={fieldId} className="text-sm font-medium text-text">{label}</label>}
      <select id={fieldId} aria-invalid={!!error} aria-describedby={error ? errorId : undefined} className={cn('h-[38px] min-w-0 w-full px-3 rounded-md bg-surface border text-text text-sm', error ? 'border-danger' : 'border-border', className)} {...props}>
        {children}
      </select>
      {error && <span id={errorId} role="alert" className="text-xs text-danger">{error}</span>}
    </div>
  )
}
