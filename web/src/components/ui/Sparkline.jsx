import { cn } from '../../lib/cn'

const TONE = {
  success: 'bg-success', danger: 'bg-danger', warning: 'bg-warning',
  info: 'bg-info', primary: 'bg-primary', neutral: 'bg-subtle',
}

// Barras com rótulo e title por ponto. Sem rótulo o gráfico é decorativo —
// por isso cada barra expõe `title` ("dd/mm · valor") e a série toda tem
// um aria-label com o resumo. Pontos null viram barra vazia ("sem dado").
export function Sparkline({ points = [], tone = 'info', height = 34, unit = '', className }) {
  const valores = points.map((p) => (p && p.valor != null ? Number(p.valor) : null))
  const max = Math.max(1, ...valores.filter((v) => v != null))
  const resumo = points.map((p) => `${p.label}: ${p.valor == null ? 'sem dado' : `${p.valor}${unit}`}`).join(' · ')
  return (
    <div className={cn('flex items-end gap-[3px]', className)} style={{ height }} role="img" aria-label={`Série: ${resumo}`}>
      {points.map((p, i) => {
        const v = valores[i]
        const pct = v == null ? 0 : Math.max(8, Math.round((v / max) * 100))
        return (
          <div key={i} className="relative flex-1 self-stretch rounded-[2px] bg-surface-2" title={`${p.label} · ${v == null ? 'sem dado' : `${p.valor}${unit}`}`}>
            {v != null && <div className={cn('absolute inset-x-0 bottom-0 rounded-[2px]', TONE[tone] || TONE.info)} style={{ height: `${pct}%` }} />}
          </div>
        )
      })}
    </div>
  )
}
