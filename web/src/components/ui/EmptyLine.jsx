import { cn } from '../../lib/cn'

// Estado vazio horizontal (padrão Lúcida: linha, não caixa central).
// Para vazios que convivem com conteúdo — fim de lista, seção parcial.
// O EmptyState (caixa) continua sendo o certo para telas inteiras vazias.
export function EmptyLine({ icon: Icon, title, description, action, className }) {
  return (
    <div className={cn('flex items-center gap-4 px-5 py-4', className)}>
      {Icon && (
        <div className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] border border-border bg-surface-2 text-subtle">
          <Icon size={16} />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text">{title}</p>
        {description && <p className="mt-0.5 text-[12.5px] text-subtle">{description}</p>}
      </div>
      {action}
    </div>
  )
}
