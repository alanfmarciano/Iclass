import { useEffect, useRef, useSyncExternalStore } from 'react'
import { getConnectionState, subscribeConnection } from '../lib/connection'

// Estado da conexão com o servidor ('online', 'offline' ou 'starting'; lib/connection.js)
// para as telas, atualizado a cada troca.
export function useServerConnection() {
  return useSyncExternalStore(subscribeConnection, getConnectionState, getConnectionState)
}

// onReconnect() quando a conexão volta a 'online' vindo de 'offline' ou 'starting' (a
// prova salva as respostas na hora; o AuthProvider confere a sessão).
export function useOnReconnect(onReconnect) {
  const ref = useRef(onReconnect)
  ref.current = onReconnect
  useEffect(() => subscribeConnection((next, previous) => {
    if (next === 'online' && previous !== 'online') {
      try { ref.current?.() } catch { /* quem chama trata */ }
    }
  }), [])
}
