import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NOTIFICATIONS_REFRESH_EVENT, adminMessageCount, getMessageCount, navBadgeLabel, requestNotificationsRefresh,
  resetMessageCountForTests, setMessageCount, studentMessageCount, subscribeMessageCount,
} from './messageCounter'

afterEach(() => { resetMessageCountForTests() })

// Contador de Mensagens no menu (fase 3, C14 / P5-S7b; D13 e contrato C7 do P5): lido do
// sino, sem consulta própria.
describe('[UC-MENSAGEM-006] contador de mensagens do menu', () => {
  it('portal: uma conversa por item "mensagem" do sino (os outros itens não contam)', () => {
    expect(studentMessageCount({ items: [
      { id: 'mensagem:c1', type: 'mensagem', unread: true },
      { id: 'mensagem:c2', type: 'mensagem', unread: false },
      { id: 'aviso:a', type: 'aviso', unread: true },
    ] })).toBe(2)
    expect(studentMessageCount(null)).toBe(0)
  })

  it('painel: soma o count dos itens "mensagens" (no modo instituição vem um por turma)', () => {
    expect(adminMessageCount({ items: [
      { id: 'mensagens@c::1A', type: 'mensagens', count: 2 },
      { id: 'mensagens@c::1B', type: 'mensagens', count: 1 },
      { id: 'chamada_pendente@c::1A', type: 'chamada_pendente', count: 4 },
    ] })).toBe(3)
    expect(adminMessageCount({})).toBe(0)
  })

  it('usa mensagensNovas do servidor (contado antes do corte da lista do sino) quando vem', () => {
    // 30 itens mais novos no sino do portal empurraram a conversa antiga para fora da lista.
    const items = Array.from({ length: 30 }, (_, index) => ({ id: `aviso:${index}`, type: 'aviso', unread: true }))
    expect(studentMessageCount({ items, mensagensNovas: 2 })).toBe(2)
    expect(studentMessageCount({ items: [{ id: 'mensagem:c1', type: 'mensagem' }], mensagensNovas: 0 })).toBe(0)
    expect(adminMessageCount({ items: [{ id: 'mensagens@c::1A', type: 'mensagens', count: 1 }], mensagensNovas: 5 })).toBe(5)
    // Valor estranho: volta a contar os itens.
    expect(studentMessageCount({ items: [{ id: 'mensagem:c1', type: 'mensagem' }], mensagensNovas: 'x' })).toBe(1)
  })

  it('avisa quem ouve só quando o número muda e nunca fica negativo', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeMessageCount(listener)
    setMessageCount(2)
    setMessageCount(2)
    setMessageCount(-5)
    expect(getMessageCount()).toBe(0)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    setMessageCount(7)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('pede ao sino uma consulta na hora e dá o texto do número para o leitor de tela', () => {
    const onRefresh = vi.fn()
    window.addEventListener(NOTIFICATIONS_REFRESH_EVENT, onRefresh)
    requestNotificationsRefresh()
    window.removeEventListener(NOTIFICATIONS_REFRESH_EVENT, onRefresh)
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(navBadgeLabel({ to: '/aluno/mensagens', badge: 1 })).toBe('1 conversa com mensagem nova')
    expect(navBadgeLabel({ to: '/mensagens', badge: 4 })).toBe('4 conversas com mensagem nova')
    expect(navBadgeLabel({ to: '/matriculas', badge: 2 })).toBe('2 pendentes')
    expect(navBadgeLabel({ to: '/mensagens', badge: 0 })).toBe('')
  })
})
