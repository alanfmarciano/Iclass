import { useState, useMemo, useEffect } from 'react'
import { Search, ArrowUpDown, MoreVertical } from 'lucide-react'
import { EmptyState } from './EmptyState'
// Tabela padrão: busca + ordenação + estado vazio + ações em linha (menu ⋯).
// Seleção (selectable) e paginação (paginated) são opcionais e desligadas por padrão,
// para não alterar o comportamento das telas que já usam este componente.
export function DataTable({
  columns, rows, searchKeys = [], rowActions, onRowClick, emptyTitle = 'Nenhum registro', emptyDesc,
  selectable = false, selectedIds = [], onSelectionChange,
  paginated = false, pageSize = 25,
}) {
  const [q, setQ] = useState('')
  const [sort, setSort] = useState({ key: null, dir: 1 })
  const [page, setPage] = useState(1)
  const filtered = useMemo(() => {
    let r = rows
    if (q && searchKeys.length) r = r.filter((x) => searchKeys.some((k) => String(x[k]).toLowerCase().includes(q.toLowerCase())))
    if (sort.key) r = [...r].sort((a, b) => (a[sort.key] > b[sort.key] ? 1 : -1) * sort.dir)
    return r
  }, [rows, q, sort, searchKeys])

  const totalPages = paginated ? Math.max(1, Math.ceil(filtered.length / pageSize)) : 1
  // A busca/filtro pode encolher a lista abaixo da página atual — volta para uma página válida.
  useEffect(() => { setPage((p) => Math.min(p, totalPages)) }, [totalPages])
  const visible = paginated ? filtered.slice((page - 1) * pageSize, page * pageSize) : filtered

  // "Selecionar tudo" cobre todo o resultado filtrado, não só a página visível:
  // o fluxo esperado é filtrar → selecionar tudo → agir em lote.
  const selected = useMemo(() => new Set(selectedIds), [selectedIds])
  const allSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.id))
  const toggleAll = () => onSelectionChange && onSelectionChange(allSelected ? [] : filtered.map((r) => r.id))
  const toggleOne = (id) => {
    if (!onSelectionChange) return
    const next = new Set(selected)
    if (next.has(id)) next.delete(id); else next.add(id)
    onSelectionChange([...next])
  }

  const colCount = columns.length + (selectable ? 1 : 0) + (rowActions ? 1 : 0)

  return (
    <div>
      {searchKeys.length > 0 && (
        <div className="flex items-center gap-2 mb-3 h-[38px] px-3 rounded-md bg-surface border border-border max-w-xs">
          <Search size={16} className="text-subtle" />
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} placeholder="Buscar…"
            className="bg-transparent text-sm text-text placeholder:text-subtle w-full outline-none" aria-label="Buscar" />
        </div>
      )}
      <div className="overflow-x-auto border border-border rounded-lg">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-2">
              {selectable && (
                <th className="w-10 px-4">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll}
                    className="accent-primary align-middle" aria-label="Selecionar todos" />
                </th>
              )}
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
            {visible.map((row) => (
              <tr key={row.id} onClick={() => onRowClick && onRowClick(row)}
                className={`border-b border-border last:border-0 hover:bg-surface-2/60 ${onRowClick ? 'cursor-pointer' : ''} ${selected.has(row.id) ? 'bg-primary-soft' : ''}`}>
                {selectable && (
                  <td className="px-4" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(row.id)} onChange={() => toggleOne(row.id)}
                      className="accent-primary align-middle" aria-label={`Selecionar ${row.name || row.id}`} />
                  </td>
                )}
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
          {paginated && filtered.length > 0 && (
            <tfoot>
              <tr className="border-t border-border bg-surface-2">
                <td colSpan={colCount} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-3 text-xs text-muted">
                    <span>Mostrando {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, filtered.length)} de {filtered.length}</span>
                    <div className="flex items-center gap-2">
                      <button className="px-2 py-1 rounded-md border border-border disabled:opacity-40 hover:text-text"
                        onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>Anterior</button>
                      <span className="tabular-nums">{page} / {totalPages}</span>
                      <button className="px-2 py-1 rounded-md border border-border disabled:opacity-40 hover:text-text"
                        onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}>Próxima</button>
                    </div>
                  </div>
                </td>
              </tr>
            </tfoot>
          )}
        </table>
        {filtered.length === 0 && <EmptyState title={emptyTitle} description={emptyDesc} />}
      </div>
    </div>
  )
}
