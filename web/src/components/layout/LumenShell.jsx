import { useEffect, useMemo, useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { Bell, GraduationCap, LogOut, Menu, Search, X } from 'lucide-react'
import { ThemeToggle } from '../ui/ThemeToggle'
import { cn } from '../../lib/cn'

function initials(value = '') {
  return value
    .split(/[ @.]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'IC'
}

export function LumenShell({
  navGroups,
  brandName = 'IClass',
  logo = '',
  conceptLabel = 'Learning OS',
  userName = '',
  userDetail = '',
  contextAction = null,
  pathname,
  onLogout,
  children,
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuTriggerRef = useRef(null)
  const closeButtonRef = useRef(null)
  const menuPanelRef = useRef(null)
  const allItems = useMemo(() => navGroups.flatMap((group) => group.items), [navGroups])
  const primaryItems = allItems.slice(0, 4)
  const activeItem = [...allItems]
    .sort((a, b) => b.to.length - a.to.length)
    .find((item) => item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`))

  const closeMenu = (restoreFocus = true) => {
    setMenuOpen(false)
    if (restoreFocus) window.setTimeout(() => menuTriggerRef.current?.focus(), 0)
  }

  const toggleMenu = (event) => {
    menuTriggerRef.current = event.currentTarget
    setMenuOpen((value) => !value)
  }

  const openMenu = (event) => {
    menuTriggerRef.current = event.currentTarget
    setMenuOpen(true)
  }

  useEffect(() => {
    if (!menuOpen) return undefined
    const onKeyDown = (event) => {
      if (event.key === 'Escape') closeMenu()
      if (event.key === 'Tab') {
        const focusable = [...(menuPanelRef.current?.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])]
        if (!focusable.length) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    closeButtonRef.current?.focus()
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [menuOpen])

  useEffect(() => setMenuOpen(false), [pathname])

  return (
    <div className="lumen-shell app-canvas h-full text-text">
      <a className="lumen-skip-link" href="#lumen-main" aria-hidden={menuOpen ? 'true' : undefined} tabIndex={menuOpen ? -1 : undefined}>Ir para o conteúdo</a>

      <header className="lumen-topbar" aria-hidden={menuOpen ? 'true' : undefined} inert={menuOpen ? '' : undefined}>
        <div className="lumen-brand">
          {logo ? (
            <img src={logo} alt={brandName} className="lumen-brand-logo" />
          ) : (
            <span className="lumen-brand-mark" aria-hidden="true"><GraduationCap size={21} /></span>
          )}
          <span className="lumen-brand-copy">
            <strong>{brandName}</strong>
            <span>{conceptLabel}</span>
          </span>
        </div>

        <nav className="lumen-desktop-nav" aria-label="Navegação principal">
          {primaryItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => cn('lumen-nav-link', isActive && 'is-active')}
            >
              <item.icon size={17} aria-hidden="true" />
              <span>{item.text}</span>
            </NavLink>
          ))}
        </nav>

        <div className="lumen-top-actions">
          {contextAction && (
            <button type="button" className="lumen-context-action" onClick={contextAction.onClick} title={contextAction.title || contextAction.label}>
              {contextAction.icon && <contextAction.icon size={16} aria-hidden="true" />}
              <span>{contextAction.label}</span>
            </button>
          )}
          <button type="button" className="lumen-icon-button lumen-search-button" aria-label="Buscar"><Search size={18} /></button>
          <ThemeToggle />
          <button type="button" className="lumen-icon-button" aria-label="Notificações">
            <Bell size={18} />
            <span className="lumen-notification-dot" aria-hidden="true" />
          </button>
          <div className="lumen-profile" title={userDetail || userName}>
            <span className="lumen-avatar">{initials(userName || userDetail)}</span>
            <span className="lumen-profile-copy"><strong>{userName || 'Usuário'}</strong><span>{userDetail}</span></span>
          </div>
          <button type="button" className="lumen-icon-button lumen-logout" onClick={onLogout} aria-label="Sair"><LogOut size={18} /></button>
          <button
            type="button"
            className={cn('lumen-icon-button lumen-menu-trigger', menuOpen && 'is-active')}
            onClick={toggleMenu}
            aria-expanded={menuOpen}
            aria-controls="lumen-navigation-panel"
            aria-label="Abrir todos os módulos"
          >
            <Menu size={20} />
          </button>
        </div>
      </header>

      {menuOpen && (
        <div className="lumen-menu-layer">
          <button type="button" className="lumen-menu-backdrop" onClick={() => closeMenu()} aria-hidden="true" tabIndex="-1" />
          <aside ref={menuPanelRef} id="lumen-navigation-panel" className="lumen-menu-panel" role="dialog" aria-modal="true" aria-label="Todos os módulos">
            <div className="lumen-menu-head">
              <div><span>Menu completo</span><strong>{activeItem?.text || conceptLabel}</strong></div>
              <button ref={closeButtonRef} type="button" className="lumen-icon-button" onClick={() => closeMenu()} aria-label="Fechar menu"><X size={20} /></button>
            </div>
            <nav className="lumen-menu-groups" aria-label="Todos os módulos">
              {navGroups.map((group) => (
                <section key={group.label} className="lumen-menu-group" aria-labelledby={`lumen-group-${group.label.replace(/\W+/g, '-').toLowerCase()}`}>
                  <h2 id={`lumen-group-${group.label.replace(/\W+/g, '-').toLowerCase()}`}>{group.label}</h2>
                  {group.items.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.end}
                      onClick={() => closeMenu(false)}
                      className={({ isActive }) => cn('lumen-menu-link', isActive && 'is-active')}
                    >
                      <span className="lumen-menu-icon"><item.icon size={17} aria-hidden="true" /></span>
                      <span>{item.text}</span>
                      {item.badge > 0 && <span className="ml-auto rounded-full bg-warning px-2 py-0.5 text-[10px] font-bold text-white">{item.badge}</span>}
                    </NavLink>
                  ))}
                </section>
              ))}
            </nav>
            <div className="lumen-menu-footer">
              <span className="lumen-status-dot" aria-hidden="true" />
              Sistema ativo
              <button type="button" onClick={onLogout}><LogOut size={15} /> Sair</button>
            </div>
          </aside>
        </div>
      )}

      <main id="lumen-main" className="lumen-main" tabIndex="-1" aria-hidden={menuOpen ? 'true' : undefined} inert={menuOpen ? '' : undefined}>
        <div className="lumen-page-context" aria-hidden="true">
          <span>{conceptLabel}</span>
          <strong>{activeItem?.text || 'Visão geral'}</strong>
        </div>
        {children}
      </main>

      <nav className="lumen-bottom-nav" aria-label="Navegação móvel" aria-hidden={menuOpen ? 'true' : undefined} inert={menuOpen ? '' : undefined}>
        {primaryItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => cn(isActive && 'is-active')}
          >
            <item.icon size={19} aria-hidden="true" />
            <span>{item.text}</span>
          </NavLink>
        ))}
        <button
          type="button"
          onClick={openMenu}
          className={menuOpen ? 'is-active' : ''}
          aria-expanded={menuOpen}
          aria-controls="lumen-navigation-panel"
        >
          <Menu size={20} aria-hidden="true" />
          <span>Mais</span>
        </button>
      </nav>
    </div>
  )
}
