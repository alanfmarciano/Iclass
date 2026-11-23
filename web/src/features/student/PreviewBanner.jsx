import { Eye, LogOut } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthProvider'
import { usePreview } from '../../hooks/usePreview'
import { PREVIEW_DISABLED_TEXT, previewBannerText } from '../../lib/previewSession'

// Faixa da pré-visualização como aluno (C15 / P5-S6b, D21 do P5): no fluxo da página,
// acima do cabeçalho do portal (nunca fixa por cima: no celular não cobre o menu nem o
// foco, ACS-17), com o rótulo do servidor ('Pré-visualização como aluno de 1DES · grupo
// Laboratório A') e o botão que volta para a tela do painel de onde a prévia saiu. No
// celular o texto e o botão quebram em duas linhas, com o botão inteiro à vista.
export function PreviewBanner({ className = '' }) {
  const preview = usePreview()
  const { endPreview } = useAuth() || {}
  const nav = useNavigate()
  if (!preview) return null
  const leave = () => {
    const origem = endPreview()
    nav(origem || '/')
  }
  return (
    <div role="region" aria-label="Pré-visualização como aluno" className={`flex w-full flex-wrap items-center gap-x-3 gap-y-2 border-b border-warning/40 bg-warning-soft px-4 py-2.5 text-sm text-text ${className}`}>
      <p className="flex min-w-0 flex-1 basis-[220px] items-start gap-2 font-medium">
        <Eye size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
        <span className="min-w-0 break-words" data-testid="preview-banner-text">{previewBannerText(preview)}</span>
      </p>
      <button
        type="button"
        onClick={leave}
        className="inline-flex min-h-[44px] shrink-0 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-semibold text-text hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <LogOut size={16} aria-hidden="true" /> Sair da pré-visualização
      </button>
    </div>
  )
}

// Aviso ao lado de um botão que grava, desativado na prévia.
export function PreviewDisabledNote({ className = '' }) {
  const preview = usePreview()
  if (!preview) return null
  return <p className={`text-xs text-muted ${className}`}>{PREVIEW_DISABLED_TEXT}</p>
}
