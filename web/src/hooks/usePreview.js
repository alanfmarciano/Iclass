import { useAuth } from '../context/AuthProvider'

// A pré-visualização como aluno aberta, vista de uma tela do portal (C15 / P5-S6b): o
// PreviewStudentScope (context/AuthProvider.jsx) põe a prévia em auth.preview. Fora dela
// (painel, aluno de verdade), null.
export function usePreview() {
  const ctx = useAuth()
  return (ctx && ctx.auth && ctx.auth.preview) || null
}
