import { cn } from '../../lib/cn'
import { useId } from 'react'

// Milhar em pt-BR (50.000), igual em qualquer navegador.
export function formatCharCount(value) {
  return String(Math.max(0, Math.trunc(Number(value) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

// maxLength: o mesmo teto do servidor (H9b, ENG-03). counterFrom: a partir de quantos
// caracteres a contagem "N de M caracteres" aparece embaixo do campo (sem ela, só o
// teto). Texto antigo maior que o teto continua aparecendo inteiro e pode ser apagado.
export function Textarea({ label, id, error, className, maxLength, counterFrom, value, ...props }) {
  const generatedId = useId()
  const fieldId = id || generatedId
  const errorId = `${fieldId}-error`
  const counterId = `${fieldId}-counter`
  const length = typeof value === 'string' ? value.length : 0
  const showCounter = !!maxLength && counterFrom !== undefined && length >= counterFrom
  const describedBy = [error ? errorId : null, showCounter ? counterId : null].filter(Boolean).join(' ') || undefined
  return (
    <div className="flex flex-col gap-1.5">
      {label && <label htmlFor={fieldId} className="text-sm font-medium text-text">{label}</label>}
      <textarea id={fieldId} value={value} maxLength={maxLength} aria-invalid={!!error} aria-describedby={describedBy} className={cn('px-3 py-2 rounded-md bg-surface border text-text text-sm min-h-[100px]', error ? 'border-danger' : 'border-border', className)} {...props} />
      {showCounter && (
        <span id={counterId} aria-live="polite" className={cn('text-xs self-end', length >= maxLength ? 'text-warning' : 'text-muted')}>
          {formatCharCount(length)} de {formatCharCount(maxLength)} caracteres
        </span>
      )}
      {error && <span id={errorId} role="alert" className="text-xs text-danger">{error}</span>}
    </div>
  )
}
