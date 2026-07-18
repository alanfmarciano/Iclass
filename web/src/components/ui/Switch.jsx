import { cn } from '../../lib/cn'
export function Switch({ checked, onChange, label, id, disabled = false }) {
  return (
    <label htmlFor={id} className={cn('inline-flex items-center gap-2 select-none', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
      <button id={id} type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => !disabled && onChange(!checked)}
        className={cn('w-10 h-6 rounded-full transition relative', checked ? 'bg-primary' : 'bg-surface-2')}>
        <span className={cn('absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
      </button>
      {label && <span className="text-sm text-text">{label}</span>}
    </label>
  )
}
