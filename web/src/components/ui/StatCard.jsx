import * as Icons from 'lucide-react'
import { Card } from './Card'
import { cn } from '../../lib/cn'
export function StatCard({ label, value, trend, icon }) {
  const Icon = Icons[icon] || Icons.Activity
  const up = trend > 0, down = trend < 0
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted">{label}</span>
        <span className="w-9 h-9 grid place-items-center rounded-md bg-primary-soft text-primary"><Icon size={18} /></span>
      </div>
      <div className="mt-3 text-3xl font-bold text-text tabular-nums">{value}</div>
      {trend !== undefined && trend !== 0 && (
        <div className={cn('mt-1 text-xs font-medium flex items-center gap-1', up && 'text-success', down && 'text-danger')}>
          {up ? '▲' : '▼'} {Math.abs(trend)} <span className="text-subtle font-normal">vs. ontem</span>
        </div>
      )}
    </Card>
  )
}
