import { useEffect, useSyncExternalStore } from 'react'

// Contador de "Mensagens" no menu do portal e do painel (fase 3, C14 / P5-S7b, FUN-14).
//
// O contador não faz consulta própria (D13 do P5: fora da conversa aberta, só o sino
// pergunta ao servidor, na cadência de sempre). Ele lê o que o sino já trouxe:
// - no portal do aluno, cada item 'mensagem' do sino é uma conversa da turma com mensagem
//   do professor que o aluno ainda não leu (pela marca lidaAte, contrato C7 do P5);
// - no painel, o item 'mensagens' da fila traz em count quantas conversas do instrutor
//   têm mensagem nova de aluno (no modo instituição vem um por turma, e os counts somam).
// O "Marcar como lidas" do sino não muda nada disso: o item só some quando a conversa é
// lida na tela Mensagens.
//
// Depois de ler ou responder uma conversa, a tela Mensagens pede ao sino uma consulta na
// hora (requestNotificationsRefresh), para o contador e o sino baixarem sem esperar os
// 30 s do intervalo.
export const NOTIFICATIONS_REFRESH_EVENT = 'iclass:notifications-refresh'

let count = 0
const listeners = new Set()

function emit() {
  listeners.forEach((listener) => {
    try { listener() } catch { /* um ouvinte com erro não para os outros */ }
  })
}

export function getMessageCount() {
  return count
}

export function setMessageCount(value) {
  const next = Math.max(0, Math.trunc(Number(value) || 0))
  if (next === count) return
  count = next
  emit()
}

export function subscribeMessageCount(listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

// Conversas com mensagem nova na resposta do sino do aluno (GET /api/student/notifications).
export function studentMessageCount(data) {
  const items = Array.isArray(data?.items) ? data.items : []
  return items.filter((item) => item && item.type === 'mensagem').length
}

// Conversas com mensagem nova na resposta do sino do painel (GET /api/admin/notifications).
export function adminMessageCount(data) {
  const items = Array.isArray(data?.items) ? data.items : []
  return items
    .filter((item) => item && item.type === 'mensagens')
    .reduce((sum, item) => sum + Math.max(0, Math.trunc(Number(item.count) || 0)), 0)
}

// Pede ao sino (NotificationBell) uma consulta agora.
export function requestNotificationsRefresh() {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
  try { window.dispatchEvent(new Event(NOTIFICATIONS_REFRESH_EVENT)) } catch { /* navegador sem Event */ }
}

// Número no item do menu (matrículas pendentes; conversas com mensagem nova), com o texto
// para o leitor de tela.
export function navBadgeLabel(item) {
  const count = Number(item?.badge) || 0
  if (count <= 0) return ''
  if (item.to === '/mensagens' || item.to === '/aluno/mensagens') return count === 1 ? '1 conversa com mensagem nova' : `${count} conversas com mensagem nova`
  return count === 1 ? '1 pendente' : `${count} pendentes`
}

// O número para o item "Mensagens" do menu.
export function useMessageCount() {
  return useSyncExternalStore(subscribeMessageCount, getMessageCount, getMessageCount)
}

// O contador é do sino de uma turma (ou do painel inteiro): trocar de turma, sair da conta
// ou fechar o portal volta a zero até o sino novo responder (sem mostrar o número da
// turma anterior).
export function useMessageCountScope(key) {
  useEffect(() => {
    setMessageCount(0)
    return () => setMessageCount(0)
  }, [key])
}

// Só nos testes.
export function resetMessageCountForTests() {
  count = 0
  listeners.clear()
}
