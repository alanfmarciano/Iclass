// QR code desenhado a partir da matriz que o servidor gera (fase 2, H6a;
// backend/utils/qrCode.js): rows[y][x] = '1' para módulo escuro. Um <svg> com um único
// <path> (uma corrida horizontal de módulos escuros por segmento), margem de 4 módulos e
// preto sobre branco fixo, também no tema escuro: leitor de QR não lê o código invertido.
export const QR_MARGIN = 4

export function qrPath(rows) {
  let d = ''
  ;(rows || []).forEach((row, y) => {
    const line = String(row)
    let x = 0
    while (x < line.length) {
      if (line[x] !== '1') { x += 1; continue }
      let end = x
      while (end < line.length && line[end] === '1') end += 1
      d += `M${x + QR_MARGIN} ${y + QR_MARGIN}h${end - x}v1h-${end - x}z`
      x = end
    }
  })
  return d
}

export function QrCode({ rows, url, size = 240, className = '' }) {
  const modules = Array.isArray(rows) ? rows.length : 0
  if (!modules) return null
  const total = modules + QR_MARGIN * 2
  return (
    <svg
      role="img"
      aria-label={`QR code do endereço ${url || ''}`.trim()}
      viewBox={`0 0 ${total} ${total}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className={`block h-auto max-w-full rounded-md ${className}`}
      style={{ background: '#ffffff' }}
      data-modules={modules}
    >
      <rect width={total} height={total} fill="#ffffff" />
      <path d={qrPath(rows)} fill="#000000" />
    </svg>
  )
}
