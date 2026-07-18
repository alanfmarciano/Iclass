import { cn } from '../../lib/cn'

// Rótulo de seção em maiúsculas com régua ("rótulo de museu" do mockup v3).
// `action` fica à direita da régua — link ou controle pequeno.
export function SectionLabel({ children, action, className }) {
  return (
    <div className={cn('mb-3 flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[.16em] text-subtle', className)}>
      <span className="flex-none">{children}</span>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
      {action && <span className="flex-none normal-case tracking-normal">{action}</span>}
    </div>
  )
}
