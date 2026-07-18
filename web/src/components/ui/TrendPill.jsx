import { cn } from '../../lib/cn'

// Tendência com glifo + texto — nunca só cor (a11y). `delta` null = sem base
// de comparação ("novo"), 0 = estável. `invert` para métricas onde subir é ruim.
export function TrendPill({ delta, unit = '', invert = false, className }) {
  if (delta == null) {
    return <span className={cn('inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-semibold text-subtle', className)}>sem base</span>
  }
  const flat = delta === 0
  const up = delta > 0
  const good = flat ? null : (invert ? !up : up)
  const tone = flat ? 'bg-surface-2 text-subtle' : good ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'
  const glyph = flat ? '=' : up ? '▲' : '▼'
  const texto = flat ? 'estável' : `${Math.abs(delta).toLocaleString('pt-BR')}${unit}`
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums', tone, className)}>
      <span aria-hidden="true">{glyph}</span>
      <span className="sr-only">{flat ? 'estável' : up ? 'subiu' : 'caiu'}</span>
      {texto}
    </span>
  )
}
