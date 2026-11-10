import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthProvider'
import { api } from '../../lib/api'
import { usePolling } from '../../hooks/usePolling'

// Presença do aluno no portal e saída imediata quando a sessão é revogada. Usado pelo
// portal e pelo layout da prova.
// A cada 15 s (fase 2, H2-C: DES-09; antes, 4 s): a presença vale por 90 s no servidor
// e toda requisição do aluno já a renova, e na prova a sincronização a cada 4 s também.
// Pelo usePolling: um ping por vez, prazo de 10 s, sem ping com a aba oculta e ping na
// hora quando ela volta a ficar visível.
export const HEARTBEAT_MS = 15000

// O ping também diz se a troca de senha obrigatória vale para esta sessão (H5a): o
// professor redefiniu a senha com o aluno no portal, ou a prova que adiava a troca acabou.
export function useStudentHeartbeat() {
  const { auth, logout, syncPasswordChange } = useAuth()
  const nav = useNavigate()
  const email = auth.email
  const ping = useCallback(async (requestOptions) => {
    if (!email) return true
    try {
      const presence = await api.get(`/api/ping?email=${encodeURIComponent(email)}`, requestOptions)
      if (syncPasswordChange && presence && typeof presence.passwordChangeRequired === 'boolean') {
        syncPasswordChange(presence.passwordChangeRequired, presence.passwordChangeReason)
      }
      return true
    } catch (err) {
      if (err?.status === 401 || err?.data?.sessionRevoked === true) {
        logout()
        nav('/login')
        return true
      }
      return false
    }
  }, [email, logout, nav, syncPasswordChange])
  usePolling(ping, { intervalMs: HEARTBEAT_MS, enabled: !!email })
}
