// tabClassName: classes a mais em cada aba (ex.: alvo de toque de 44 px no celular).
export function Tabs({ tabs, active, onChange, tabClassName = '' }) {
  return (
    <div className="flex gap-6 border-b border-border overflow-x-auto">
      {tabs.map((t) => (
        <button key={t.id} type="button" onClick={() => onChange(t.id)}
          className={`text-sm py-2.5 -mb-px border-b-2 whitespace-nowrap transition-colors ${active === t.id ? 'border-primary text-text' : 'border-transparent text-muted hover:text-text'}${tabClassName ? ` ${tabClassName}` : ''}`}>
          {t.label}
        </button>
      ))}
    </div>
  )
}
