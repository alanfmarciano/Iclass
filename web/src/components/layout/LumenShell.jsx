import { useEffect, useMemo, useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { GraduationCap, LogOut, Menu, X } from 'lucide-react'
import { ThemeToggle } from '../ui/ThemeToggle'
import { cn } from '../../lib/cn'
import { ConnectionStatus } from './ConnectionStatus'
import { AccountMenu } from './AccountMenu'
import { navBadgeLabel } from '../../lib/messageCounter'

function initials(value = '') {
  return value
    .split(/[ @.]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'IC'
}

// Número de um item que está na barra de cima ou na de baixo (Mensagens do professor no
// modo instituição, que fica entre os 4 primeiros). Antes só o menu completo desenhava o
// número, e o "Mais" só soma os itens escondidos: o aviso não aparecia em lugar nenhum
// (revisão do C14, rodada 2).
function NavCount({ item, className }) {
  const count = Number(item.badge) || 0
  if (count <= 0) return null
  return (
    <>
      <b aria-hidden="true" className={cn(className, item.badgeTone === 'primary' ? 'bg-primary text-primary-fg' : 'bg-warning text-white')}>{count > 99 ? '99+' : count}</b>
      <span className="sr-only">{`, ${navBadgeLabel(item)}`}</span>
    </>
  )
}

export function LumenShell({
  navGroups,
  brandName = 'IClass',
  logo = '',
  conceptLabel = 'Learning OS',
  userName = '',
  userDetail = '',
  contextAction = null,
  notifications = null,
  // { accountPath, email }: o avatar vira o menu Minha conta · Sair (painel, UXI-07).
  accountMenu = null,
  pathname,
  onLogout,
  // Texto do botão de sair (a pré-visualização como aluno usa 'Sair da pré-visualização').
  logoutLabel = 'Sair',
  // Faixa acima do cabeçalho, no fluxo da página (pré-visualização como aluno, C15).
  banner = null,
  children,
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuTriggerRef = useRef(null)
  const closeButtonRef = useRef(null)
  const menuPanelRef = useRef(null)
  const allItems = useMemo(() => navGroups.flatMap((group) => group.items), [navGroups])
  const primaryItems = allItems.slice(0, 4)
  // Número de algum item que só está no menu completo (Mensagens, Matrículas): o botão
  // "Mais" do celular e o do menu completo no computador ganham um ponto, para o aviso não
  // ficar escondido.
  const hiddenBadge = allItems.slice(4).reduce((sum, item) => sum + (Number(item.badge) > 0 ? Number(item.badge) : 0), 0)
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

      {banner}
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
              <NavCount item={item} className="lumen-nav-count" />
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
          {notifications}
          <ThemeToggle />
          {accountMenu ? (
            <AccountMenu
              name={userName === accountMenu.email ? '' : userName}
              email={accountMenu.email || ''}
              detail={userDetail}
              accountPath={accountMenu.accountPath}
              onLogout={onLogout}
              buttonClassName="lumen-profile text-left"
              avatarClassName="lumen-avatar"
            >
              <span className="lumen-profile-copy"><strong>{userName || 'Usuário'}</strong><span>{userDetail}</span></span>
            </AccountMenu>
          ) : (
            <div className="lumen-profile" title={userDetail || userName}>
              <span className="lumen-avatar">{initials(userName || userDetail)}</span>
              <span className="lumen-profile-copy"><strong>{userName || 'Usuário'}</strong><span>{userDetail}</span></span>
            </div>
          )}
          <button type="button" className="lumen-icon-button lumen-logout" onClick={onLogout} aria-label={logoutLabel}><LogOut size={18} /></button>
          <button
            type="button"
            className={cn('lumen-icon-button lumen-menu-trigger', menuOpen && 'is-active')}
            onClick={toggleMenu}
            aria-expanded={menuOpen}
            aria-controls="lumen-navigation-panel"
            aria-label={hiddenBadge > 0 ? 'Abrir todos os módulos (há novidades no menu)' : 'Abrir todos os módulos'}
          >
            <Menu size={20} />
            {hiddenBadge > 0 && <i aria-hidden="true" className="lumen-more-dot" />}
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
                      {item.badge > 0 && <><span aria-hidden="true" className={cn('ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold', item.badgeTone === 'primary' ? 'bg-primary text-primary-fg' : 'bg-warning text-white')}>{item.badge > 99 ? '99+' : item.badge}</span><span className="sr-only">{`, ${navBadgeLabel(item)}`}</span></>}
                    </NavLink>
                  ))}
                </section>
              ))}
            </nav>
            <div className="lumen-menu-footer">
              <ConnectionStatus variant="lumen" />
              <button type="button" onClick={onLogout}><LogOut size={15} /> {logoutLabel}</button>
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
            className={({ isActive }) => cn('relative', isActive && 'is-active')}
          >
            <item.icon size={19} aria-hidden="true" />
            <span>{item.text}</span>
            <NavCount item={item} className="lumen-bottom-count" />
          </NavLink>
        ))}
        <button
          type="button"
          onClick={openMenu}
          className={cn('relative', menuOpen && 'is-active')}
          aria-label={hiddenBadge > 0 ? 'Mais (há novidades no menu)' : undefined}
          aria-expanded={menuOpen}
          aria-controls="lumen-navigation-panel"
        >
          <Menu size={20} aria-hidden="true" />
          <span>Mais</span>
          {hiddenBadge > 0 && <i aria-hidden="true" className="lumen-more-dot" />}
        </button>
      </nav>
    </div>
  )
}
