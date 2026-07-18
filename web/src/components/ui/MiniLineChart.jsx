export function MiniLineChart({ points = [], min = 0, max = 10, height = 150 }) {
  if (!points.length) return <div className="grid place-items-center text-sm text-muted" style={{ height }}>Sem dados no período.</div>
  const w = 320, h = height, pad = 24
  const span = Math.max(1, max - min)
  const xs = (i) => points.length === 1 ? w / 2 : pad + (i * (w - pad * 2)) / (points.length - 1)
  const ys = (v) => h - pad - ((v - min) / span) * (h - pad * 2)
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xs(i).toFixed(1)} ${ys(p.value).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height }} preserveAspectRatio="none">
      {[0, 0.5, 1].map((t) => <line key={t} x1={pad} x2={w - pad} y1={pad + t * (h - pad * 2)} y2={pad + t * (h - pad * 2)} className="text-border" stroke="currentColor" strokeWidth="0.5" />)}
      <path d={d} fill="none" className="text-primary" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => <circle key={i} cx={xs(i)} cy={ys(p.value)} r="3" className="text-primary" fill="currentColor" />)}
      {points.map((p, i) => <text key={`t${i}`} x={xs(i)} y={h - 6} textAnchor="middle" className="fill-current text-subtle" style={{ fontSize: 9 }}>{p.label}</text>)}
    </svg>
  )
}
