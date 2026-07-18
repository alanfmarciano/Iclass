import { Loader2 } from 'lucide-react'
import { cn } from '../../lib/cn'
const VARIANTS = {
  primary: 'bg-primary text-primary-fg shadow-[0_8px_22px_var(--primary-glow)] hover:bg-primary-hover',
  secondary: 'bg-surface-raised text-text border border-border hover:border-[var(--border-strong)] hover:bg-surface-2',
  destructive: 'bg-danger text-white shadow-[0_8px_22px_var(--danger-soft)] hover:brightness-110',
  ghost: 'text-muted hover:bg-surface-2 hover:text-text',
}
const SIZES = { sm: 'h-8 px-3 text-sm', md: 'h-[38px] px-4 text-sm', lg: 'h-11 px-5 text-base' }
export function Button({ variant = 'primary', size = 'md', loading, disabled, className, children, icon: Icon, ...props }) {
  return (
    <button
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn('inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-all duration-300 ease-out active:translate-y-px disabled:opacity-50 disabled:pointer-events-none', VARIANTS[variant], SIZES[size], className)}
      {...props}
    >
      {loading ? <Loader2 aria-hidden="true" size={16} className="animate-spin" /> : Icon && <Icon aria-hidden="true" size={16} />}
      {children}
    </button>
  )
}
