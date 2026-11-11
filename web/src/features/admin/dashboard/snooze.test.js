import { describe, expect, it } from 'vitest'
import { SNOOZE_MS, snoozedWith } from './snooze'

// Fase 2, H9b (ENG-03): "Adiar 24h" gravava cada item para sempre em dashboard.snoozed;
// a lista só crescia e podia levar as preferências da conta ao teto de 64 KB.
describe('[UC-ERRO-003] Adiar item do "Precisa de você": só os adiamentos válidos ficam', () => {
  it('tira os vencidos e os que não são número e acrescenta o novo', () => {
    const now = 1_800_000_000_000
    const current = { velho: now - SNOOZE_MS - 1, limite: now - SNOOZE_MS, recente: now - 1000, lixo: 'ontem' }
    expect(snoozedWith(current, 'novo', now)).toEqual({ recente: now - 1000, novo: now })
  })

  it('aceita a preferência ausente ou em outro formato', () => {
    expect(snoozedWith(undefined, 'a', 5)).toEqual({ a: 5 })
    expect(snoozedWith(['x'], 'a', 5)).toEqual({ a: 5 })
  })
})
