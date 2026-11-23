// Redução de foto no navegador antes do envio (fase 3, C9 / P1-g; D12 do P1). Quarenta
// celulares mandando fotos de 5 a 8 MB no fim do prazo congestionam o ponto de acesso da
// sala; a foto acima de 3 MB vira um JPEG com o lado maior de até 2560 px e qualidade
// 0,85 (uma foto de 12 MP fica com cerca de 1 MB e o texto de uma folha continua legível).
// Só canvas do próprio navegador, sem pacote.
//
// - Reduz só JPEG, PNG e WebP (o navegador sabe desenhar). GIF (perderia a animação),
//   HEIC (o Chrome e o Edge não abrem) e o resto vão como estão.
// - A foto reduzida é sempre JPEG ('foto.png' vira 'foto.jpg'): só reduz quando a tarefa
//   aceita .jpg. PNG com fundo transparente ganha fundo branco (o JPEG não tem
//   transparência; papel fotografado não tem).
// - A orientação da câmera (EXIF) vale: createImageBitmap com imageOrientation
//   'from-image' e, sem ele, a <img>, que os navegadores atuais já desenham virada certo.
// - Reduzir que não diminui (a foto já era leve, a conta deu maior) devolve null: vai a
//   original. Qualquer falha (memória, formato que o aparelho não abre) também devolve
//   null, e a original segue; nunca trava o envio.

export const RESIZE_THRESHOLD_BYTES = 3 * 1024 * 1024
export const RESIZE_MAX_SIDE = 2560
export const RESIZE_QUALITY = 0.85
export const RESIZABLE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp'])
const RESIZABLE_EXTENSIONS = /\.(jpe?g|png|webp)$/i

function extensionOf(name) {
  const match = /\.[^./\\]+$/.exec(String(name || ''))
  return match ? match[0].toLowerCase() : ''
}

// O arquivo é uma foto que este navegador sabe reduzir? (tipo ou, sem tipo, a extensão)
export function isResizableImage(file) {
  if (!file) return false
  const type = String(file.type || '').toLowerCase()
  if (type) return RESIZABLE_TYPES.includes(type)
  return RESIZABLE_EXTENSIONS.test(String(file.name || ''))
}

// Vale a pena reduzir? Foto que o navegador desenha, acima do limite, e a tarefa aceita
// .jpg (a reduzida sai em JPEG). acceptedExtensions: as extensões da tarefa ('.jpg', ...).
export function shouldResizeImage(file, { acceptedExtensions = [], thresholdBytes = RESIZE_THRESHOLD_BYTES } = {}) {
  if (!isResizableImage(file)) return false
  if (!(Number(file.size) > thresholdBytes)) return false
  const accepted = (Array.isArray(acceptedExtensions) ? acceptedExtensions : []).map((ext) => String(ext).toLowerCase())
  return accepted.includes('.jpg') || accepted.includes('.jpeg')
}

// Tamanho de destino mantendo a proporção: o lado maior em até maxSide (nunca aumenta).
export function targetSize(width, height, maxSide = RESIZE_MAX_SIDE) {
  const w = Math.max(1, Math.round(Number(width) || 0))
  const h = Math.max(1, Math.round(Number(height) || 0))
  const longest = Math.max(w, h)
  if (longest <= maxSide) return { width: w, height: h }
  const ratio = maxSide / longest
  return { width: Math.max(1, Math.round(w * ratio)), height: Math.max(1, Math.round(h * ratio)) }
}

// Nome do arquivo reduzido: a mesma base com .jpg ('Relatório.PNG' -> 'Relatório.jpg';
// sem nome, 'foto.jpg').
export function jpegName(name) {
  const raw = String(name || '').trim()
  if (!raw) return 'foto.jpg'
  const ext = extensionOf(raw)
  const base = ext ? raw.slice(0, -ext.length) : raw
  return `${base || 'foto'}.jpg`
}

// Desenhável da foto: { source, width, height, close }. Padrão: createImageBitmap (com a
// orientação da câmera) e, sem ele, a <img> por um endereço blob: (a CSP permite img blob:).
async function defaultLoadImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => { try { bitmap.close() } catch {} } }
    } catch { /* tenta pela <img> */ }
  }
  if (typeof Image !== 'function' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') throw new Error('sem decodificador de imagem')
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.decoding = 'async'
    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = () => reject(new Error('imagem ilegível'))
      img.src = url
    })
    return { source: img, width: img.naturalWidth || img.width, height: img.naturalHeight || img.height, close: () => URL.revokeObjectURL(url) }
  } catch (err) {
    URL.revokeObjectURL(url)
    throw err
  }
}

function defaultCreateCanvas(width, height) {
  if (typeof document === 'undefined') throw new Error('sem canvas')
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function canvasToBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality })
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas vazio'))), type, quality)
    } catch (err) {
      reject(err)
    }
  })
}

// Reduz a foto. { file, width, height, originalSize } com o File novo (JPEG), ou null
// quando não reduziu (não precisava, ficou maior ou o aparelho não conseguiu).
// deps (só nos testes): { loadImage(file), createCanvas(width, height) }.
export async function resizeImage(file, { maxSide = RESIZE_MAX_SIDE, quality = RESIZE_QUALITY, deps = {} } = {}) {
  if (!isResizableImage(file)) return null
  const loadImage = deps.loadImage || defaultLoadImage
  const createCanvas = deps.createCanvas || defaultCreateCanvas
  let image = null
  try {
    image = await loadImage(file)
    const size = targetSize(image.width, image.height, maxSide)
    const canvas = createCanvas(size.width, size.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, size.width, size.height)
    ctx.drawImage(image.source, 0, 0, size.width, size.height)
    const blob = await canvasToBlob(canvas, 'image/jpeg', quality)
    if (!blob || !(blob.size > 0) || blob.size >= file.size) return null
    const resized = new File([blob], jpegName(file.name), { type: 'image/jpeg', lastModified: Number(file.lastModified) || Date.now() })
    return { file: resized, width: size.width, height: size.height, originalSize: file.size }
  } catch {
    return null
  } finally {
    if (image && typeof image.close === 'function') image.close()
  }
}
