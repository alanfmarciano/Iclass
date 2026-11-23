import { describe, expect, it } from 'vitest'
import { findTermRanges, firstTermRange, foldWithMap, highlightParts, makeSnippet } from './searchHighlight'

describe('[UC-BUSCA-003] searchHighlight: onde o termo está no texto original', () => {
  it('acha a palavra sem acento e devolve o trecho do texto com acento', () => {
    const text = 'Montagem de Redes e AÇÃO'
    const ranges = findTermRanges(text, 'redes acao')
    expect(ranges.map(([a, b]) => text.slice(a, b))).toEqual(['Redes', 'AÇÃO'])
  })

  it('o mapa de volta aguenta letra já decomposta e espaços repetidos', () => {
    const decomposed = 'Ação   final'
    const { folded } = foldWithMap(decomposed)
    expect(folded).toBe('acao final')
    const [range] = findTermRanges(decomposed, 'acao')
    expect(decomposed.slice(range[0], range[1])).toBe('Ação')
    const [second] = findTermRanges(decomposed, 'final')
    expect(decomposed.slice(second[0], second[1])).toBe('final')
  })

  it('junta trechos que se sobrepõem e respeita o limite', () => {
    expect(findTermRanges('redes redes redes', 'rede redes')).toEqual([[0, 5], [6, 11], [12, 17]])
    expect(findTermRanges('a a a a a', 'a', { limit: 2 })).toHaveLength(2)
    expect(findTermRanges('qualquer', '')).toEqual([])
  })

  it('partes marcadas são texto puro (o HTML digitado não vira tag)', () => {
    const text = 'veja <img src=x onerror=alert(1)> redes'
    const parts = highlightParts(text, findTermRanges(text, 'redes'))
    expect(parts).toEqual([{ text: 'veja <img src=x onerror=alert(1)> ', mark: false }, { text: 'redes', mark: true }])
  })

  it('trecho curto em volta da primeira palavra, com reticências', () => {
    const text = `${'palavra '.repeat(30)}o protocolo TCP garante a entrega ${'outra '.repeat(40)}`
    const snippet = makeSnippet(text, 'tcp')
    const joined = snippet.parts.map((part) => part.text).join('')
    expect(snippet.found).toBe(true)
    expect(joined.startsWith('… ')).toBe(true)
    expect(joined.endsWith(' …')).toBe(true)
    expect(joined.length).toBeLessThan(220)
    expect(snippet.parts.filter((part) => part.mark).map((part) => part.text)).toEqual(['TCP'])
  })

  it('seção grande: acha a primeira palavra sem dobrar o texto todo, também perto do corte e com acento', () => {
    const far = `${'abc '.repeat(5000)}a Configuração do servidor ${'xyz '.repeat(2000)}`
    expect(firstTermRange(far, ['configuracao'])).toEqual([20002, 20014])
    const snippet = makeSnippet(far, 'configuracao servidor')
    expect(snippet.found).toBe(true)
    expect(snippet.parts.filter((part) => part.mark).map((part) => part.text)).toEqual(['Configuração', 'servidor'])
    // Palavra que começa antes do corte do primeiro pedaço e termina depois dele.
    const edge = `${'a'.repeat(1020)} paralelepipedo e tcp`
    expect(firstTermRange(edge, ['tcp', 'paralelepipedo'])).toEqual([1021, 1035])
    // A mais cedo das palavras, não a primeira digitada.
    expect(firstTermRange('rede antes de tcp', ['tcp', 'rede'])).toEqual([0, 4])
    expect(firstTermRange('nada aqui', ['tcp'])).toBeNull()
  })
})
