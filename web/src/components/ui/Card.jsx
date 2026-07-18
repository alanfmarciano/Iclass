import { cn } from '../../lib/cn'
export function Card({ className, children, ...p }) {
  return <div className={cn('premium-card rounded-xl', className)} {...p}>{children}</div>
}
export function CardHeader({ title, subtitle, action }) {
  return (
    <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-3">
      <div>
        <h2 className="text-[16px] font-semibold tracking-[-0.015em] text-text">{title}</h2>
        {subtitle && <p className="text-sm text-muted mt-0.5">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}
export function CardBody({ className, children }) { return <div className={cn('px-5 pb-5', className)}>{children}</div> }
