import { Link } from 'react-router-dom'
import { CircleHelp } from 'lucide-react'
import { cn } from '../../lib/cn'

// Ajuda sobre a tela (fase 3, A1 / P6-S9: OPS-13; D20 do P6): o botão "?" ao lado do
// título leva à parte certa da Ajuda. Tela nova do painel com PageHeader recebe
// helpTopic="<âncora>" e o botão aparece sozinho; a âncora é um "## Tema {#ancora}" de
// web/src/features/help/conteudo/instrutor.md (painel) ou aluno.md (aluno), e o
// npm run test:docs confere que ela existe.
export const HELP_LINK_LABEL = 'Ajuda sobre esta tela'

// Endereço da Ajuda para um tema: /ajuda#<âncora> (manual do professor, no painel),
// /ajuda/aluno#<âncora> (ajuda do aluno, aberta sem login) ou /ajuda?doc=<arquivo>#<âncora>.
export function helpHref(topic, doc = 'instrutor') {
  const hash = topic ? `#${encodeURIComponent(String(topic))}` : ''
  if (doc === 'aluno') return `/ajuda/aluno${hash}`
  if (!doc || doc === 'instrutor') return `/ajuda${hash}`
  return `/ajuda?doc=${encodeURIComponent(doc)}${hash}`
}

export function HelpLink({ topic, doc = 'instrutor', className }) {
  if (!topic) return null
  return (
    <Link
      to={helpHref(topic, doc)}
      aria-label={HELP_LINK_LABEL}
      title={HELP_LINK_LABEL}
      data-help-topic={topic}
      className={cn('inline-grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary', className)}
    >
      <CircleHelp aria-hidden="true" size={19} />
    </Link>
  )
}
