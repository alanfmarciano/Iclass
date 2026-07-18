export function Timeline({ items = [] }) {
  if (!items.length) return <p className="text-sm text-muted">Nenhuma atividade registrada.</p>
  return (
    <div className="flex flex-col">
      {items.map((it, i) => (
        <div key={it.id || i} className="flex gap-3">
          <div className="flex flex-col items-center">
            <span className={`w-2.5 h-2.5 rounded-full mt-1.5 ${it.tone || 'bg-primary'}`} />
            {i < items.length - 1 && <span className="w-px flex-1 bg-border mt-1" />}
          </div>
          <div className="flex-1 pb-4">
            <p className="text-sm text-text">{it.title}</p>
            <p className="text-xs text-subtle mt-0.5">{it.time}</p>
          </div>
        </div>
      ))}
    </div>
  )
}
