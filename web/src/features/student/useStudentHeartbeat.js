import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthProvider'
import { api } from '../../lib/api'

// Presença do aluno no portal (a cada 4 s) e saída imediata quando a sessão é revogada.
// Usado pelo portal e pelo layout da prova.
export function useStudentHeartbeat() {
  const { auth, logout } = useAuth()
  const nav = useNavigate()
  useEffect(() => {
    if (!auth.email) return
    const ping = () => api.get(`/api/ping?email=${encodeURIComponent(auth.email)}`).catch((err) => {
      if (err?.status === 401 || err?.data?.sessionRevoked === true) {
        logout()
        nav('/login')
      }
    })
    ping()
    const id = setInterval(ping, 4000)
    return () => clearInterval(id)
  }, [auth.email, logout, nav])
}
