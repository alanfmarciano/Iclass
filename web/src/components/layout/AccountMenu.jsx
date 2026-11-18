import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { LogOut, UserRound } from 'lucide-react'
import { cn } from '../../lib/cn'

// Palavras que não entram nas iniciais ("Maria da Silva" -> "MS").
const NAME_CONNECTORS = new Set(['da', 'das', 'de', 'do', 'dos', 'e'])

// Iniciais do avatar (UXI-07): primeira e última palavra do nome; sem nome, o começo do
// e-mail (como era antes); sem os dois, o texto de reserva.
export function accountInitials(name = '', email = '', fallback = 'IC') {
  const words = String(name || '').trim().split(/\s+/).filter((word) => word && !NAME_CONNECTORS.has(word.toLowerCase()))
  if (words.length) {
    const first = words[0][0] || ''
    const last = words.length > 1 ? (words[words.length - 1][0] || '') : ''
    return `${first}${last}`.toUpperCase()
  }
  const fromEmail = String(email || '').split(/[@.\s_-]/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('')
  return fromEmail || fallback
}

// Avatar do topo do painel com menu (UXI-07): Minha conta e Sair. Fecha com Esc, com um
// toque fora e ao escolher um item; os itens têm 44 px de altura (celular).
// - name, email, detail (rótulo do papel): o que o menu mostra no cabeçalho;
// - accountPath: o caminho de Minha conta; onLogout: o Sair;
// - buttonClassName, avatarClassName: o visual de cada layout (clássico ou lumen);
//   children: o que vai ao lado do avatar dentro do botão (nome e papel no lumen).
export function AccountMenu({ name = '', email = '', detail = '', accountPath = '/minha-conta', onLogout, buttonClassName = '', avatarClassName = '', children = null }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const buttonRef = useRef(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event) => {
      if (event.key === 'Escape') { setOpen(false); buttonRef.current?.focus() }
    }
    const onPointerDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown, { passive: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
    }
  }, [open])

  const label = name || email || 'Sua conta'
  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        className={buttonClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Menu da conta: ${label}`}
        title={email || label}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={avatarClassName} aria-hidden="true">{accountInitials(name, email)}</span>
        {children}
      </button>
      {open && (
        <div id={menuId} role="menu" aria-label="Sua conta" className="absolute right-0 top-full z-50 mt-2 w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface shadow-xl">
          <div className="border-b border-border px-4 py-3">
            <p className="truncate text-sm font-semibold text-text">{name || email}</p>
            {name && email && <p className="truncate text-xs text-muted">{email}</p>}
            {detail && <p className="mt-1 truncate text-xs text-subtle">{detail}</p>}
          </div>
          <Link role="menuitem" to={accountPath} onClick={() => setOpen(false)}
            className={cn('flex min-h-[44px] items-center gap-2 px-4 text-sm text-text hover:bg-surface-2 focus:bg-surface-2 focus:outline-none')}>
            <UserRound size={16} aria-hidden="true" />Minha conta
          </Link>
          <button role="menuitem" type="button" onClick={() => { setOpen(false); if (onLogout) onLogout() }}
            className="flex min-h-[44px] w-full items-center gap-2 px-4 text-left text-sm text-danger hover:bg-danger-soft focus:bg-danger-soft focus:outline-none">
            <LogOut size={16} aria-hidden="true" />Sair
          </button>
        </div>
      )}
    </div>
  )
}
