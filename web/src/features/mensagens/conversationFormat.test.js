import { describe, expect, it } from 'vitest'
import { firstTimestamp, isOwnMessage, lastFromOtherSide, lastTimestamp, mergeMessages, messageTime, timeAgo, unreadLabel } from './conversationFormat'

// Mensagens (fase 3, C14 / P5-S7b, FUN-14): o que as duas telas fazem com o que o servidor
// mandou.
describe('[UC-MENSAGEM-006] mensagens na tela', () => {
  it('junta as novas sem repetir a mesma mensagem (a do envio e a da consulta seguinte) e na ordem de envio', () => {
    const current = [{ id: 'm1', criadaEm: 10, texto: 'a' }, { id: 'm3', criadaEm: 30, texto: 'c' }]
    const merged = mergeMessages(current, [{ id: 'm3', criadaEm: 30, texto: 'c' }, { id: 'm2', criadaEm: 20, texto: 'b' }, null, { texto: 'sem id' }])
    expect(merged.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect(lastTimestamp(merged)).toBe(30)
    expect(firstTimestamp(merged)).toBe(10)
    expect(mergeMessages(null, undefined)).toEqual([])
  })

  it('a marca de leitura alcança só a última do outro lado (portal: autor voce; painel: voce)', () => {
    const portal = [{ id: 'a', autor: 'voce', criadaEm: 5 }, { id: 'b', autor: 'instrutor', criadaEm: 7 }, { id: 'c', autor: 'voce', criadaEm: 9 }]
    expect(lastFromOtherSide(portal, 'aluno')).toBe(7)
    const painel = [{ id: 'a', autor: 'aluno', voce: false, criadaEm: 5 }, { id: 'b', autor: 'instrutor', voce: true, criadaEm: 8 }]
    expect(lastFromOtherSide(painel, 'instrutor')).toBe(5)
    // Administrador lendo a conversa dos outros: nenhuma é dele (voce false em todas).
    expect(isOwnMessage({ autor: 'instrutor', voce: false }, 'instrutor')).toBe(false)
  })

  it('tempo da lista e hora do balão em português', () => {
    const now = new Date(2026, 10, 23, 15, 0).getTime()
    expect(timeAgo(now - 20 * 1000, now)).toBe('agora')
    expect(timeAgo(now - 5 * 60000, now)).toBe('há 5 min')
    expect(timeAgo(now - 2 * 3600000, now)).toBe('há 2 h')
    expect(timeAgo(new Date(2026, 10, 22, 20, 0).getTime(), now)).toBe('ontem')
    expect(timeAgo(new Date(2026, 10, 19, 9, 0).getTime(), now)).toBe('há 4 dias')
    expect(timeAgo(new Date(2026, 9, 2, 9, 0).getTime(), now)).toBe('02/10')
    expect(timeAgo(0, now)).toBe('')
    expect(messageTime(new Date(2026, 10, 23, 9, 5).getTime(), now)).toBe('09:05')
    expect(messageTime(new Date(2026, 10, 22, 9, 5).getTime(), now)).toBe('ontem 09:05')
    expect(messageTime(new Date(2025, 0, 2, 9, 5).getTime(), now)).toBe('02/01/2025 09:05')
    expect(unreadLabel(1)).toBe('1 mensagem nova')
    expect(unreadLabel(3)).toBe('3 mensagens novas')
    expect(unreadLabel(0)).toBe('')
  })
})
