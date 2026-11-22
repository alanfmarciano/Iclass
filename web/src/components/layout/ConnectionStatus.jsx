import { useServerConnection } from '../../hooks/useServerConnection'
import { APP_VERSION, versionLabel } from '../../lib/appVersion'
import { cn } from '../../lib/cn'

// Rodapé do menu (fase 3, A1 / P6-S2: ENG-10, OPS-02): o estado da conexão com o servidor
// (lib/connection.js, o mesmo da faixa ServerConnectionBanner) e a versão real do bundle.
// Antes era "Sistema ativo" e "v3" fixos, mesmo com o servidor fora do ar.
export const CONNECTION_STATUS = Object.freeze({
  online: { text: 'Conectado', color: 'var(--success)', glow: 'var(--success-soft)' },
  offline: { text: 'Sem conexão', color: 'var(--danger)', glow: 'var(--danger-soft)' },
  starting: { text: 'Servidor reiniciando', color: 'var(--warning)', glow: 'var(--warning-soft)' },
})

export function connectionStatusFor(state) {
  return CONNECTION_STATUS[state] || CONNECTION_STATUS.online
}

// variant 'sidebar' (visual clássico) ou 'lumen' (menu completo do visual Lumen, que já tem
// a própria bolinha .lumen-status-dot).
export function ConnectionStatus({ variant = 'sidebar', className }) {
  const status = connectionStatusFor(useServerConnection())
  const version = versionLabel(APP_VERSION)
  const dotStyle = { background: status.color, boxShadow: `0 0 0 4px ${status.glow}` }
  return (
    <span className={cn('inline-flex min-w-0 flex-1 items-center gap-2', className)} data-testid="connection-status">
      <span aria-hidden="true" className={variant === 'lumen' ? 'lumen-status-dot' : 'h-1.5 w-1.5 shrink-0 rounded-full'} style={dotStyle} />
      <span>{status.text}</span>
      {version && <span className="ml-auto" title={`Versão ${APP_VERSION} do IClass`} data-testid="app-version">{version}</span>}
    </span>
  )
}
