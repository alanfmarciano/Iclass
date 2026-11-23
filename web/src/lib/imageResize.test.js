import { describe, expect, it, vi } from 'vitest'
import { RESIZE_MAX_SIDE, RESIZE_QUALITY, RESIZE_THRESHOLD_BYTES, isResizableImage, jpegName, resizeImage, shouldResizeImage, targetSize } from './imageResize'

// Fase 3, C9 (P1-g; D12 do P1): foto acima de 3 MB é reduzida no celular antes do envio.
// O jsdom não tem canvas: o desenho entra pelos deps do resizeImage.

const MB = 1024 * 1024
const JPG = ['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic']

function photo(size, { name = 'IMG_0001.jpg', type = 'image/jpeg' } = {}) {
  const file = new File(['x'], name, { type, lastModified: 1700000000000 })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

function fakeCanvas(blobSize, calls) {
  return (width, height) => {
    calls.size = { width, height }
    return {
      getContext: () => ({
        set fillStyle(value) { calls.fill = value },
        fillRect: (...args) => { calls.fillRect = args },
        drawImage: (...args) => { calls.draw = args },
      }),
      toBlob: (cb, type, quality) => {
        calls.type = type
        calls.quality = quality
        cb(new Blob([new Uint8Array(blobSize)], { type }))
      },
    }
  }
}

describe('redução de foto antes do envio (D12)', () => {
  it('só reduz JPEG, PNG e WebP acima de 3 MB, e só quando a tarefa aceita .jpg', () => {
    expect(RESIZE_THRESHOLD_BYTES).toBe(3 * MB)
    expect(shouldResizeImage(photo(3 * MB + 1), { acceptedExtensions: JPG })).toBe(true)
    expect(shouldResizeImage(photo(3 * MB), { acceptedExtensions: JPG })).toBe(false)
    expect(shouldResizeImage(photo(8 * MB, { name: 'tela.png', type: 'image/png' }), { acceptedExtensions: JPG })).toBe(true)
    expect(shouldResizeImage(photo(8 * MB, { name: 'anim.gif', type: 'image/gif' }), { acceptedExtensions: JPG })).toBe(false)
    expect(shouldResizeImage(photo(8 * MB, { name: 'IMG.HEIC', type: 'image/heic' }), { acceptedExtensions: JPG })).toBe(false)
    expect(shouldResizeImage(photo(8 * MB, { name: 'doc.pdf', type: 'application/pdf' }), { acceptedExtensions: JPG })).toBe(false)
    // Tarefa que só aceita .png (formato do curso): a reduzida em JPEG seria recusada.
    expect(shouldResizeImage(photo(8 * MB, { name: 'tela.png', type: 'image/png' }), { acceptedExtensions: ['.png'] })).toBe(false)
    // Sem tipo informado (alguns Android): vale a extensão.
    expect(isResizableImage(photo(8 * MB, { name: 'foto.jpeg', type: '' }))).toBe(true)
    expect(isResizableImage(null)).toBe(false)
  })

  it('o lado maior fica em até 2560 px, com a proporção, e nunca aumenta', () => {
    expect(RESIZE_MAX_SIDE).toBe(2560)
    expect(targetSize(4032, 3024)).toEqual({ width: 2560, height: 1920 })
    expect(targetSize(3024, 4032)).toEqual({ width: 1920, height: 2560 })
    expect(targetSize(1200, 900)).toEqual({ width: 1200, height: 900 })
    expect(targetSize(0, 0)).toEqual({ width: 1, height: 1 })
  })

  it('o nome da reduzida termina em .jpg', () => {
    expect(jpegName('Relatório.PNG')).toBe('Relatório.jpg')
    expect(jpegName('IMG_0001.jpeg')).toBe('IMG_0001.jpg')
    expect(jpegName('sem-extensao')).toBe('sem-extensao.jpg')
    expect(jpegName('')).toBe('foto.jpg')
  })

  it('desenha em JPEG 0,85 com fundo branco e devolve o arquivo novo, menor', async () => {
    const calls = {}
    const close = vi.fn()
    const original = photo(6 * MB, { name: 'quadro.png', type: 'image/png' })
    const result = await resizeImage(original, { deps: { loadImage: async () => ({ source: 'img', width: 4000, height: 3000, close }), createCanvas: fakeCanvas(900 * 1024, calls) } })
    expect(result).not.toBeNull()
    expect(result.file.name).toBe('quadro.jpg')
    expect(result.file.type).toBe('image/jpeg')
    expect(result.file.size).toBe(900 * 1024)
    expect(result).toMatchObject({ width: 2560, height: 1920, originalSize: 6 * MB })
    expect(calls).toMatchObject({ size: { width: 2560, height: 1920 }, fill: '#ffffff', type: 'image/jpeg', quality: RESIZE_QUALITY })
    expect(calls.draw).toEqual(['img', 0, 0, 2560, 1920])
    expect(close).toHaveBeenCalledOnce()
  })

  it('não troca a foto quando a reduzida não fica menor ou o aparelho não consegue desenhar', async () => {
    const calls = {}
    const original = photo(3.5 * MB)
    const bigger = await resizeImage(original, { deps: { loadImage: async () => ({ source: 'img', width: 2000, height: 1500 }), createCanvas: fakeCanvas(4 * MB, calls) } })
    expect(bigger).toBeNull()
    const broken = await resizeImage(original, { deps: { loadImage: async () => { throw new Error('sem memória') }, createCanvas: fakeCanvas(1, calls) } })
    expect(broken).toBeNull()
    const noContext = await resizeImage(original, { deps: { loadImage: async () => ({ source: 'img', width: 10, height: 10 }), createCanvas: () => ({ getContext: () => null }) } })
    expect(noContext).toBeNull()
    expect(await resizeImage(photo(8 * MB, { name: 'a.gif', type: 'image/gif' }))).toBeNull()
  })
})
