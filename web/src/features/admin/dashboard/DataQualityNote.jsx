import { Database } from 'lucide-react'

// "Um dashboard escolar precisa dizer no que ele não confia": lacunas reais de
// lançamento, com ação. Fica junto do conteúdo, não escondido no rodapé.
export function DataQualityNote({ notes = [] }) {
  if (!notes.length) return null
  return (
    <div className="flex items-start gap-3.5 rounded-2xl border border-dashed border-strong bg-transparent px-5 py-4">
      <span className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] border border-border bg-surface-2 text-subtle">
        <Database size={15} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="mb-1.5 text-[13px] font-semibold text-text">O que está faltando lançar</p>
        <ul className="flex flex-col gap-1">
          {notes.map((n, i) => (
            <li key={i} className="flex items-baseline gap-2 text-[12.5px] text-muted">
              <span className="h-1 w-1 flex-none translate-y-[-2px] rounded-full bg-subtle" aria-hidden="true" />
              <span>
                {n.text}
                {n.action && <button onClick={n.action.onClick} className="ml-1.5 font-medium text-primary hover:text-primary-hover">{n.action.label} →</button>}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
