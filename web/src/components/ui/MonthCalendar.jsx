import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { api } from '../../lib/api'

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
const WD = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S']

function pad(n) { return String(n).padStart(2, '0') }

export function MonthCalendar({ email }) {
  const now = new Date()
  const [cur, setCur] = useState(new Date(now.getFullYear(), now.getMonth(), 1))
  const [days, setDays] = useState({})
  const monthKey = `${cur.getFullYear()}-${pad(cur.getMonth() + 1)}`

  useEffect(() => {
    let alive = true
    if (!email) return
    api.get(`/api/admin/student/attendance?email=${encodeURIComponent(email)}&month=${monthKey}`)
      .then((r) => { if (alive) setDays(r.days || {}) })
      .catch(() => { if (alive) setDays({}) })
    return () => { alive = false }
  }, [email, monthKey])

  const cells = useMemo(() => {
    const year = cur.getFullYear(), month = cur.getMonth()
    const offset = new Date(year, month, 1).getDay()
    const total = new Date(year, month + 1, 0).getDate()
    const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    const out = []
    for (let i = 0; i < offset; i++) out.push(null)
    for (let d = 1; d <= total; d++) {
      const dateStr = `${year}-${pad(month + 1)}-${pad(d)}`
      const col = (offset + d - 1) % 7
      const weekend = col === 0 || col === 6
      const present = !!days[dateStr]
      const future = dateStr > todayStr
      out.push({ d, present, weekend, future, today: dateStr === todayStr })
    }
    return out
  }, [cur, days])

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-medium text-text capitalize">{MONTHS[cur.getMonth()]} {cur.getFullYear()}</p>
        <div className="flex items-center gap-1">
          <button aria-label="Mês anterior" onClick={() => setCur(new Date(cur.getFullYear(), cur.getMonth() - 1, 1))} className="p-1 rounded-md text-muted hover:bg-surface-2 hover:text-text"><ChevronLeft size={16} /></button>
          <button aria-label="Próximo mês" onClick={() => setCur(new Date(cur.getFullYear(), cur.getMonth() + 1, 1))} className="p-1 rounded-md text-muted hover:bg-surface-2 hover:text-text"><ChevronRight size={16} /></button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1.5 mb-1.5">
        {WD.map((w, i) => <div key={i} className="text-center text-[10px] text-subtle">{w}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {cells.map((c, i) => c === null ? <div key={i} /> : (
          <div key={i} className={`aspect-square grid place-items-center text-xs rounded-md ${c.today ? 'ring-2 ring-primary ' : ''}${c.present ? 'bg-success-soft text-success' : c.weekend || c.future ? 'text-subtle' : 'bg-surface-2 text-muted'}`}>{c.d}</div>
        ))}
      </div>
      <div className="flex gap-4 mt-3 text-[11px] text-subtle">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-success-soft inline-block" />Presente</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-surface-2 inline-block" />Sem registro</span>
      </div>
    </div>
  )
}
