import { Inbox } from 'lucide-react'
import { Button } from './Button'
export function EmptyState({ icon: Icon = Inbox, title, description, action, onAction }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-14 px-6">
      <div className="w-14 h-14 grid place-items-center rounded-full bg-surface-2 text-muted mb-4"><Icon size={26} /></div>
      <h3 className="text-[16px] font-semibold text-text">{title}</h3>
      {description && <p className="text-sm text-muted mt-1 max-w-sm">{description}</p>}
      {action && <Button className="mt-4" onClick={onAction}>{action}</Button>}
    </div>
  )
}
