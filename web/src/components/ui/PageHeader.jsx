import { HelpLink } from './HelpLink'

// Cabeçalho padrão de página: título + subtítulo à esquerda, ações à direita.
// helpTopic (fase 3, A1): a âncora do tema desta tela no manual do professor
// (web/src/features/help/conteudo/instrutor.md); com ela, o botão "?" (Ajuda sobre esta
// tela) aparece ao lado do título. helpClassName: classes a mais no botão (ex.: alvo de
// toque de 44 px no celular).
export function PageHeader({ title, subtitle, helpTopic, helpClassName, children }) {
  return (
    <div className="flex items-start justify-between flex-wrap gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <h1 className="text-2xl font-bold text-text">{title}</h1>
          {helpTopic && <HelpLink topic={helpTopic} className={helpClassName} />}
        </div>
        {subtitle && <p className="text-sm text-muted mt-0.5">{subtitle}</p>}
      </div>
      {children && <div className="flex items-center gap-2 flex-wrap">{children}</div>}
    </div>
  )
}
