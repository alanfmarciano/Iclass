import { useState, useMemo } from 'react'
import { Search, ArrowUpDown, MoreVertical } from 'lucide-react'
import { EmptyState } from './EmptyState'
// Tabela padrão: busca + ordenação + estado vazio + ações em linha (menu ⋯).
export function DataTable({ columns, rows, searchKeys = [], rowActions, onRowClick, emptyTitle = 'Nenhum registro', emptyDesc }) {
  const [q, setQ] = useState('')
  const [sort, setSort] = useState({ key: null, dir: 1 })
  const filtered = useMemo(() => {
    let r = rows
    if (q && searchKeys.length) r = r.filter((x) => searchKeys.some((k) => String(x[k]).toLowerCase().includes(q.toLowerCase())))
    if (sort.key) r = [...r].sort((a, b) => (a[sort.key] > b[sort.key] ? 1 : -1) * sort.dir)
    return r
  }, [rows, q, sort, searchKeys])
  return (
    <div>
      {searchKeys.length > 0 && (
        <div className="flex items-center gap-2 mb-3 h-[38px] px-3 rounded-md bg-surface border border-border max-w-xs">
          <Search size={16} className="text-subtle" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar…"
            className="bg-transparent text-sm text-text placeholder:text-subtle w-full outline-none" aria-label="Buscar" />
        </div>
      )}
      <div className="overflow-x-auto border border-border rounded-lg">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-2">
              {columns.map((c) => (
                <th key={c.key} className="text-left font-semibold text-muted px-4 py-3 whitespace-nowrap">
                  <button className="inline-flex items-center gap-1 hover:text-text"
                    onClick={() => c.sortable !== false && setSort((s) => ({ key: c.key, dir: s.key === c.key ? -s.dir : 1 }))}>
                    {c.label}{c.sortable !== false && <ArrowUpDown size={12} className="text-subtle" />}
                  </button>
                </th>
              ))}
              {rowActions && <th className="w-10" />}
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr key={row.id} onClick={() => onRowClick && onRowClick(row)} className={`border-b border-border last:border-0 hover:bg-surface-2/60 ${onRowClick ? 'cursor-pointer' : ''}`}>
                {columns.map((c) => <td key={c.key} className="px-4 py-3 text-text">{c.render ? c.render(row) : row[c.key]}</td>)}
                {rowActions && (
                  <td className="px-2 text-right">
                    <button className="p-1.5 rounded-md text-subtle hover:bg-surface-2 hover:text-text" aria-label="Ações"
                      onClick={(e) => { e.stopPropagation(); rowActions(row) }}><MoreVertical size={16} /></button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <EmptyState title={emptyTitle} description={emptyDesc} />}
      </div>
    </div>
  )
}
