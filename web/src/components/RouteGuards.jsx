import { useEffect } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { PreviewStudentScope, useAuth } from '../context/AuthProvider'
import { useToast } from '../context/ToastProvider'

// Guardas das rotas por papel (App.jsx). Separadas do App para os testes da
// pré-visualização como aluno (C15) montarem só o que precisam.

export function SessionLoading() {
  return (
    <div className="min-h-screen grid place-items-center bg-bg text-text">
      <div className="text-sm text-muted">Validando sessão...</div>
    </div>
  )
}

// Pré-visualização como aluno (C15 / P5-S6b, D21 do P5): o portal aceita o instrutor com
// a prévia aberta nesta aba e mostra o aluno virtual (PreviewStudentScope); sem prévia, o
// instrutor que abre /aluno volta para a tela do painel de onde a prévia saiu. Uma tela do
// painel aberta com a prévia (o voltar do navegador, um endereço digitado) fecha a prévia
// antes de desenhar, para nenhuma tela do painel pedir dados com o token da prévia.
export function RequireRole({ role, children }) {
  const { auth, authReady, preview, previewReturn } = useAuth()
  const loc = useLocation()
  if (!authReady) return <SessionLoading />
  if (!auth.role) return <Navigate to="/login" state={{ from: loc }} replace />
  if (role === 'student' && auth.role === 'admin') {
    if (preview) return <PreviewStudentScope>{children}</PreviewStudentScope>
    return <Navigate to={previewReturn || '/'} replace />
  }
  if (role === 'admin' && auth.role === 'admin' && preview) return <EndPreviewBeforeAdmin />
  if (role && auth.role !== role) return <Navigate to={auth.role === 'admin' ? '/' : '/aluno'} replace />
  return children
}

export function EndPreviewBeforeAdmin() {
  const { endPreview } = useAuth()
  useEffect(() => { endPreview() }, [endPreview])
  return <SessionLoading />
}

// Aviso do fim da prévia pelo servidor ou pelo prazo, já na tela do painel.
export function PreviewNotice() {
  const { auth, previewNotice, clearPreviewNotice } = useAuth()
  const toast = useToast()
  useEffect(() => {
    if (!previewNotice || auth.role !== 'admin') return
    if (toast) toast.info(previewNotice.message)
    clearPreviewNotice()
  }, [previewNotice, auth.role, toast, clearPreviewNotice])
  return null
}

