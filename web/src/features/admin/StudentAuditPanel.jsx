import { useState, useMemo } from 'react'
import { Select } from '../../components/ui/Select'

function fmtDateTime(t) { return t ? new Date(t).toLocaleString('pt-BR') : '—' }

// Painel de auditoria do cadastro do aluno, com filtro por categoria (campo alterado).
export function StudentAuditPanel({ rows }) {
  const [field, setField] = useState('all')
  const list = rows || []
  const fields = useMemo(() => [...new Set(list.map((r) => r.field).filter(Boolean))].sort(), [list])
  const filtered = list.filter((r) => field === 'all' || r.field === field)

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="max-w-[260px] w-full sm:w-auto min-w-[200px]">
          <Select value={field} onChange={(e) => setField(e.target.value)}>
            <option value="all">Todas as categorias</option>
            {fields.map((f) => <option key={f} value={f}>{f}</option>)}
          </Select>
        </div>
        <span className="text-xs text-subtle">{filtered.length} de {list.length} registro(s)</span>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-muted">Nenhuma alteração {field !== 'all' ? `de "${field}" ` : ''}registrada.</p>
      ) : (
        <div className="space-y-2 max-h-[30rem] overflow-auto">
          {filtered.map((a) => (
            <div key={a.id} className="rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-text">{a.field}</span>
                <span className="text-xs text-subtle">{fmtDateTime(a.timestamp)}</span>
              </div>
              {a.action !== 'create' && <p className="text-xs text-muted mt-1"><span className="line-through text-subtle">{a.oldValue || '(vazio)'}</span> {'→'} <span className="text-text">{a.newValue || '(vazio)'}</span></p>}
              <p className="text-xs text-subtle mt-1">por {a.actor}{a.ip ? ` · ${a.ip}` : ''}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
