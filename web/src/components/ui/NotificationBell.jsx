import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, BellOff, CheckCheck, ChevronRight } from 'lucide-react'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'

const TONE = {
  aviso: 'bg-info-soft text-info',
  duvida: 'bg-success-soft text-success',
  nota: 'bg-primary-soft text-primary',
  prova: 'bg-warning-soft text-warning',
  chamada_pendente: 'bg-danger-soft text-danger',
  duvidas_paradas: 'bg-warning-soft text-warning',
  sem_avaliacao: 'bg-info-soft text-info',
  matriculas: 'bg-early-soft text-early',
  conteudo_bloqueado: 'bg-surface-2 text-subtle',
}

function timeAgo(at) {
  const diff = Date.now() - Number(at || 0)
  if (!at || diff < 0) return ''
  const min = Math.round(diff / 60000)
  if (min < 1) return 'agora'
  if (min < 60) return `${min} min`
  const hours = Math.round(min / 60)
  if (hours < 24) return `${hours} h`
  return `${Math.round(hours / 24)} d`
}

// Sino de notificações real: busca `endpoint` (lista + contador de não lidas),
// mostra um painel e "marca como lidas" via `seenEndpoint`. O badge só aparece
// quando há algo novo, em vez do ponto vermelho fixo que existia antes.
// `onOpenItem(item)` (opcional) abre o item: troca de turma no painel do instrutor,
// marca o aviso como lido no do aluno. Se devolver true, o item fica lido na hora.
export function NotificationBell({ endpoint, seenEndpoint, pollMs = 30000, className, buttonClassName, onOpenItem }) {
  const [data, setData] = useState({ items: [], unread: 0 })
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const navigate = useNavigate()

  const load = useCallback(async () => {
    if (!endpoint) return
    try { setData(await api.get(endpoint)) } catch { /* mantém o último estado */ }
  }, [endpoint])

  useEffect(() => {
    load()
    if (!endpoint) return undefined
    const id = setInterval(load, pollMs)
    const onFocus = () => { if (document.visibilityState !== 'hidden') load() }
    window.addEventListener('focus', onFocus)
    return () => { clearInterval(id); window.removeEventListener('focus', onFocus) }
  }, [load, endpoint, pollMs])

  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => { if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false) }
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  async function markAllSeen() {
    // `key` vem do servidor (curso + turma + item); `ids` deixa o aluno marcar os avisos.
    const keys = data.items.map((item) => item.key || `${item.id}:${item.count || 0}`)
    const ids = data.items.map((item) => item.id)
    setData((current) => ({ ...current, unread: 0, items: current.items.map((item) => ({ ...item, unread: false })) }))
    try { await api.post(seenEndpoint, { keys, ids }) } catch { /* silencioso */ }
  }

  async function openItem(item) {
    setOpen(false)
    if (!onOpenItem) {
      if (item.href) navigate(item.href)
      return
    }
    let markedRead = false
    try { markedRead = await onOpenItem(item) } catch { /* a navegação já aconteceu */ }
    if (markedRead && item.unread) {
      setData((current) => ({
        ...current,
        unread: Math.max(0, Number(current.unread || 0) - 1),
        items: current.items.map((other) => (other.id === item.id ? { ...other, unread: false } : other)),
      }))
    }
  }

  const unread = Number(data.unread || 0)
  const label = unread > 0 ? `Notificações: ${unread} nova${unread > 1 ? 's' : ''}` : 'Notificações'

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={buttonClassName || 'relative grid h-10 w-10 place-items-center rounded-lg text-muted transition-all duration-300 hover:bg-surface-2 hover:text-text'}
      >
        <Bell size={17} />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-fg ring-2 ring-surface">{unread > 9 ? '9+' : unread}</span>
        )}
      </button>
      {open && (
        <div role="dialog" aria-label="Notificações" className="absolute right-0 top-12 z-50 w-[min(360px,calc(100vw-32px))] overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-float)]">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="text-sm font-semibold text-text">Notificações</p>
            {data.items.length > 0 && (
              <button type="button" onClick={markAllSeen} disabled={unread === 0} className="inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-text disabled:opacity-50">
                <CheckCheck size={14} /> Marcar como lidas
              </button>
            )}
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {data.items.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-muted"><BellOff size={20} className="text-subtle" /> Nada novo por aqui.</div>
            ) : data.items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => openItem(item)}
                className={cn('flex w-full items-start gap-3 border-b border-border px-4 py-3 text-left transition last:border-b-0 hover:bg-surface-2/60', item.unread && 'bg-primary-soft/20')}
              >
                <span className={cn('mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-xs font-bold', TONE[item.type] || 'bg-surface-2 text-subtle')}>
                  {item.count ? item.count : <Bell size={14} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate text-sm', item.unread ? 'font-semibold text-text' : 'font-medium text-text')}>{item.title}</span>
                  {item.text && <span className="mt-0.5 block truncate text-xs text-muted">{item.text}</span>}
                </span>
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-subtle">{timeAgo(item.at)}<ChevronRight size={13} /></span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
