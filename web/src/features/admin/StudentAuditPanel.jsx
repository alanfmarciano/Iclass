import { useState, useMemo } from 'react'
import { Select } from '../../components/ui/Select'

function fmtDateTime(t) { return t ? new Date(t).toLocaleString('pt-BR') : '—' }

// Tipo da entrada no filtro: o campo alterado do cadastro ou, sem ele (nota, certificado,
// conta...), o rótulo da ação. A presença leva a data no campo ("Presença em 10/11/2026"):
// o filtro fica pelo rótulo ("Presença alterada"), sem uma opção por dia.
function kindOf(row) {
  if (row.category === 'attendance') return row.label || row.field || row.action || ''
  return row.field || row.label || row.action || ''
}

// Título do registro: o campo (com a data, na presença) e, na presença, o rótulo da ação.
function titleOf(row) {
  if (row.category === 'attendance' && row.field && row.label) return `${row.field} · ${row.label}`
  return kindOf(row)
}

function text(value) {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}

// Painel de auditoria da ficha do aluno (só o administrador), com filtro por tipo.
// As entradas vêm normalizadas (GET /api/admin/student/audit): cadastro, notas,
// certificados e o resto da trilha que cita o aluno.
export function StudentAuditPanel({ rows }) {
  const [field, setField] = useState('all')
  const list = rows || []
  const fields = useMemo(() => [...new Set(list.map(kindOf).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR')), [list])
  const filtered = list.filter((r) => field === 'all' || kindOf(r) === field)

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="max-w-[260px] w-full sm:w-auto min-w-[200px]">
          <Select value={field} onChange={(e) => setField(e.target.value)} aria-label="Tipo de alteração">
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
          {filtered.map((a, index) => {
            const oldValue = text(a.oldValue)
            const newValue = text(a.newValue)
            return (
              <div key={a.id || `${a.timestamp}-${index}`} className="rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-text">{titleOf(a)}</span>
                  <span className="text-xs text-subtle">{fmtDateTime(a.timestamp)}</span>
                </div>
                {a.action !== 'create' && (oldValue || newValue) && <p className="text-xs text-muted mt-1 break-words"><span className="line-through text-subtle">{oldValue || '(vazio)'}</span> {'→'} <span className="text-text">{newValue || '(vazio)'}</span></p>}
                {a.reason && <p className="text-xs text-text mt-1 break-words"><span className="text-subtle">Motivo: </span>{a.reason}</p>}
                <p className="text-xs text-subtle mt-1">por {a.actor}{a.ip ? ` · ${a.ip}` : ''}</p>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
