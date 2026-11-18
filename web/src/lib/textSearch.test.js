import { describe, expect, it } from 'vitest'
import { compareOrdinal, compareText, matchesSearch, normalizeSearch, searchTerms } from './textSearch'

// Fase 3, C0a (CRIT-07, D23 do P5): busca sem acento e ordem do português, a mesma regra
// do servidor (test/backend/text-search.test.js roda o mesmo quadro nos dois lados).
describe('[UC-BUSCA-001] textSearch: busca sem acento e ordem pt-BR', () => {
  it('normalizeSearch tira acento, maiúscula e espaços repetidos; ausente vira texto vazio', () => {
    expect(normalizeSearch('João')).toBe('joao')
    expect(normalizeSearch('AÇÃO')).toBe('acao')
    expect(normalizeSearch('  Maria   da\tSilva ')).toBe('maria da silva')
    expect(normalizeSearch(null)).toBe('')
    expect(normalizeSearch(undefined)).toBe('')
    expect(normalizeSearch(10)).toBe('10')
    expect(normalizeSearch(['Redes', 'Lógica'])).toBe('redes logica')
    expect(normalizeSearch({ toString: () => 'objeto' })).toBe('')
    expect(searchTerms('  ana  ANA souza ')).toEqual(['ana', 'souza'])
  })

  it('matchesSearch: "joao" acha "João" e cada palavra pode estar num campo diferente', () => {
    expect(matchesSearch(['João da Silva'], 'joao')).toBe(true)
    expect(matchesSearch('AÇÃO educativa', 'acao')).toBe(true)
    expect(matchesSearch(['Ana Souza', '1DES'], 'ana 1des')).toBe(true)
    expect(matchesSearch(['Ana Souza'], 'ana 1des')).toBe(false)
    expect(matchesSearch(['qualquer'], '')).toBe(true)
    expect(matchesSearch(['qualquer'], '   ')).toBe(true)
  })

  it('null e undefined não viram "null" nem "undefined" (antes casavam com "und")', () => {
    expect(matchesSearch([undefined, null], 'und')).toBe(false)
    expect(matchesSearch([undefined], 'null')).toBe(false)
    expect(matchesSearch([], 'a')).toBe(false)
  })

  it('compareText ordena como no português e com números em ordem natural', () => {
    expect(['Zélia', 'Bruno', 'ana', 'Érica', 'Ângela', 'Carlos'].sort(compareText)).toEqual(['ana', 'Ângela', 'Bruno', 'Carlos', 'Érica', 'Zélia'])
    expect(['Turma 10', 'Turma 2', 'Turma 1'].sort(compareText)).toEqual(['Turma 1', 'Turma 2', 'Turma 10'])
    expect(compareText('Ana', 'ana')).toBe(0)
    expect(compareText(undefined, null)).toBe(0)
  })

  it('compareOrdinal ordena chaves e datas ISO pelo código dos caracteres', () => {
    expect(['2026-11-10T09:00', '2026-11-02T10:00', '2026-11-10T08:00'].sort(compareOrdinal)).toEqual(['2026-11-02T10:00', '2026-11-10T08:00', '2026-11-10T09:00'])
    expect(compareOrdinal(undefined, '')).toBe(0)
  })
})
