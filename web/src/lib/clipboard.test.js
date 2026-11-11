import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyText } from './clipboard'

// Fase 2, H6a (OPS-08): copiar com plano B. Pelo IP da rede (http) o navegador não tem
// navigator.clipboard, e o "Copiar token" do Monitor e o "Copiar URL" da Biblioteca
// falhavam ("Não foi possível copiar") sem alternativa. Antes este módulo não existia.
const SOURCES = import.meta.glob('../**/*.{js,jsx}', { query: '?raw', import: 'default', eager: true })

function setSecure(value) {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value })
}
function setClipboard(value) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value })
}

describe('[UC-REDE-002] copiar com plano B (lib/clipboard.js)', () => {
  let execCommand
  beforeEach(() => {
    execCommand = vi.fn(() => true)
    document.execCommand = execCommand
  })
  afterEach(() => {
    setClipboard(undefined)
    setSecure(true)
    delete document.execCommand
  })

  it('em contexto seguro usa a API de copiar', async () => {
    const writeText = vi.fn(async () => {})
    setSecure(true)
    setClipboard({ writeText })
    expect(await copyText('http://192.168.0.10:3000')).toBe('copied')
    expect(writeText).toHaveBeenCalledWith('http://192.168.0.10:3000')
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('pelo IP da rede (http, sem navigator.clipboard) copia pelo execCommand e não deixa o campo na página', async () => {
    setSecure(false)
    setClipboard(undefined)
    let selected = ''
    execCommand.mockImplementation(() => {
      const area = document.querySelector('textarea')
      selected = area ? area.value.slice(area.selectionStart, area.selectionEnd) : ''
      return true
    })
    expect(await copyText('QWERT')).toBe('copied')
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(selected).toBe('QWERT')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('API recusada (permissão negada) cai no execCommand', async () => {
    setSecure(true)
    setClipboard({ writeText: vi.fn(async () => { throw new Error('NotAllowedError') }) })
    expect(await copyText('abc')).toBe('copied')
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('sem nenhum jeito de copiar devolve "manual" (a tela mostra o texto para o Ctrl+C), sem lançar', async () => {
    setSecure(false)
    setClipboard(undefined)
    execCommand.mockReturnValue(false)
    expect(await copyText('abc')).toBe('manual')
    execCommand.mockImplementation(() => { throw new Error('não suportado') })
    expect(await copyText('abc')).toBe('manual')
    delete document.execCommand
    expect(await copyText('abc')).toBe('manual')
  })

  it('nenhuma tela usa navigator.clipboard direto: só lib/clipboard.js', () => {
    const offenders = Object.entries(SOURCES)
      .map(([file, source]) => [file.replace(/^\.\.\//, '').replace(/^\.\//, 'lib/'), source])
      .filter(([file]) => !/\.test\.[jt]sx?$/.test(file) && file !== 'lib/clipboard.js')
      .filter(([, source]) => /navigator\.clipboard|navigator\s*\?\.\s*clipboard/.test(source))
      .map(([file]) => file)
    expect(offenders).toEqual([])
    expect(Object.keys(SOURCES).length).toBeGreaterThan(50)
  })
})
