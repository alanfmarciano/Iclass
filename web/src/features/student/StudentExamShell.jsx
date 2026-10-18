import { Outlet } from 'react-router-dom'
import { AppErrorBoundary } from '../../components/ui/ErrorScreen'
import { ExamErrorScreen } from './exam/ExamErrorScreen'
import { StudentCourseGate } from './StudentCourseGate'
import { useStudentHeartbeat } from './useStudentHeartbeat'

// Layout da prova online (AVA-12, UXA-X1): sem o menu lateral do portal, o sino, o aviso
// de provas disponíveis e o botão de sair da conta. A saída da prova é a da própria
// prova (Sair, com confirmação e registro no Monitor); o voltar do navegador também
// pede confirmação (useBlocker no ExamRunner). Um erro de tela na prova mostra a tela de
// erro com o botão de recarregar e não conta como saída da prova; sair dela pelo voltar
// ou por um link pede a mesma confirmação e fica registrado (ExamErrorScreen).
export function StudentExamShell() {
  useStudentHeartbeat()
  return (
    <div className="app-canvas h-full flex flex-col text-text">
      <main className="flex-1 overflow-y-auto overflow-x-hidden px-4 md:px-6">
        <StudentCourseGate><AppErrorBoundary fallback={ExamErrorScreen}><Outlet /></AppErrorBoundary></StudentCourseGate>
      </main>
    </div>
  )
}
