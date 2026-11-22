import { useEffect, useId, useRef, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { cn } from '../../lib/cn'

// Menu "Mais ações" da linha do aluno no Monitor (fase 3, P3-S8: AVA-14). items:
// [{ id, label, icon, onSelect, tone }]; sem itens, o botão não aparece. Abre com clique,
// Enter ou espaço; fecha com Esc, clique fora ou ao escolher (o foco volta ao botão).
// Setas para cima e para baixo andam pelos itens. O menu é fixo na janela (a tabela do
// Monitor rola de lado e cortaria um menu absoluto nas últimas linhas) e abre para cima
// perto do fim da tela; rolar a página ou mudar o tamanho da janela leva o menu junto com
// o botão, e ele fecha quando o botão sai da tela.
export function MonitorRowMenu({ label, items }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState(null)
  const buttonRef = useRef(null)
  const menuRef = useRef(null)
  const menuId = useId()
  const list = (items || []).filter(Boolean)

  useEffect(() => {
    if (!open) return undefined
    function onPointer(event) {
      if (menuRef.current?.contains(event.target) || buttonRef.current?.contains(event.target)) return
      setOpen(false)
    }
    function onMove() {
      const next = menuPosition()
      if (next === false) setOpen(false)
      else setPosition(next)
    }
    document.addEventListener('mousedown', onPointer)
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    // Sem rolar a página: a rolagem fecha o menu.
    const first = menuRef.current?.querySelector('[role="menuitem"]')
    first?.focus({ preventScroll: true })
    return () => {
      document.removeEventListener('mousedown', onPointer)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [open])

  if (list.length === 0) return null

  function close(returnFocus = true) {
    setOpen(false)
    if (returnFocus) buttonRef.current?.focus()
  }

  // Posição fixa do menu junto ao botão; null sem medidas (testes), false com o botão
  // fora da tela.
  function menuPosition() {
    const rect = buttonRef.current?.getBoundingClientRect()
    const height = window.innerHeight || 0
    const width = window.innerWidth || 0
    if (!rect || !height || (!rect.width && !rect.height)) return null
    if (rect.bottom < 0 || rect.top > height) return false
    const upward = rect.bottom + 48 * list.length + 16 > height && rect.top > height / 2
    return {
      right: Math.max(8, width - rect.right),
      ...(upward ? { bottom: Math.max(8, height - rect.top + 4) } : { top: rect.bottom + 4 }),
    }
  }

  function toggle() {
    if (open) return setOpen(false)
    const next = menuPosition()
    setPosition(next || null)
    setOpen(true)
  }

  function onMenuKey(event) {
    const entries = [...(menuRef.current?.querySelectorAll('[role="menuitem"]') || [])]
    const index = entries.indexOf(document.activeElement)
    if (event.key === 'Escape') { event.preventDefault(); close() }
    else if (event.key === 'ArrowDown') { event.preventDefault(); entries[(index + 1) % entries.length]?.focus({ preventScroll: true }) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); entries[(index - 1 + entries.length) % entries.length]?.focus({ preventScroll: true }) }
    else if (event.key === 'Tab') close(false)
  }

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={toggle}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted hover:bg-surface-2 hover:text-text"
      >
        <MoreHorizontal size={16} aria-hidden />
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          style={position ? { position: 'fixed', ...position } : undefined}
          className={cn('z-50 min-w-[210px] rounded-md border border-border bg-surface py-1 shadow-lg', position ? '' : 'absolute right-0 mt-1')}
        >
          {list.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                onClick={() => { close(); item.onSelect() }}
                className={cn('flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2 focus:bg-surface-2 focus:outline-none', item.tone === 'danger' ? 'text-danger' : 'text-text')}
              >
                {Icon && <Icon size={14} aria-hidden />}
                <span>{item.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
