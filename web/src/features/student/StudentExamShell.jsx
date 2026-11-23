import { Suspense } from 'react'
import { Outlet } from 'react-router-dom'
import { usePreview } from '../../hooks/usePreview'
import { PreviewBanner } from './PreviewBanner'
import { PreviewExamNotice } from './exam/PreviewExamNotice'
import { AppErrorBoundary } from '../../components/ui/ErrorScreen'
import { PageLoading } from '../../components/ui/PageLoading'
import { ExamErrorScreen } from './exam/ExamErrorScreen'
import { StudentCourseGate } from './StudentCourseGate'
import { useStudentHeartbeat } from './useStudentHeartbeat'

// Layout da prova online (AVA-12, UXA-X1): sem o menu lateral do portal, o sino, o aviso
// de provas disponíveis e o botão de sair da conta. A saída da prova é a da própria
// prova (Sair, com confirmação e registro no Monitor); o voltar do navegador também
// pede confirmação (useBlocker no ExamRunner). Um erro de tela na prova mostra a tela de
// erro com o botão de recarregar e não conta como saída da prova; sair dela pelo voltar
// ou por um link pede a mesma confirmação e fica registrado (ExamErrorScreen).
// O erro de tela da prova também vai para o registro do servidor (area="prova", H9c).
// Invólucros em volta do Outlet na ordem dos layouts (fase 2): área de erro → Suspense
// ("Carregando..." enquanto o arquivo da prova chega) → StudentCourseGate. A rota da
// prova nunca passa pelos portões de troca de senha e de privacidade.
// Na pré-visualização como aluno (C15 / P5-S6b, D21 do P5) a prova não abre: a faixa da
// prévia e o aviso no lugar da tela da prova (o arquivo dela nem é baixado), sem presença.
export function StudentExamShell() {
  const preview = usePreview()
  useStudentHeartbeat({ enabled: !preview })
  if (preview) {
    return (
      <div className="app-canvas h-full flex flex-col text-text">
        <PreviewBanner />
        <main className="flex-1 overflow-y-auto overflow-x-hidden px-4 md:px-6"><PreviewExamNotice /></main>
      </div>
    )
  }
  return (
    <div className="app-canvas h-full flex flex-col text-text">
      <main className="flex-1 overflow-y-auto overflow-x-hidden px-4 md:px-6">
        <AppErrorBoundary area="prova" fallback={ExamErrorScreen}><Suspense fallback={<PageLoading />}><StudentCourseGate><Outlet /></StudentCourseGate></Suspense></AppErrorBoundary>
      </main>
    </div>
  )
}
