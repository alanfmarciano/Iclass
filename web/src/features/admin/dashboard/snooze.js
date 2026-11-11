// "Adiar 24h" de um item do "Precisa de você" (preferência dashboard.snoozed, mapa
// { id do item: hora em ms }). O servidor esconde o item enquanto a hora tem menos de
// 24 h; depois disso a entrada não serve para mais nada. snoozedWith tira as vencidas
// (e as que não são número) ao adiar outro item: antes o mapa só crescia e podia levar as
// preferências da conta ao teto de 64 KB, e a gravação passava a ser recusada (H9b).
export const SNOOZE_MS = 24 * 60 * 60 * 1000

export function snoozedWith(current, itemId, now = Date.now()) {
  const kept = {}
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    for (const [id, ts] of Object.entries(current)) {
      const at = Number(ts)
      if (Number.isFinite(at) && now - at < SNOOZE_MS) kept[id] = at
    }
  }
  kept[itemId] = now
  return kept
}
