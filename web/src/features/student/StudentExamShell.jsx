import { Outlet } from 'react-router-dom'
import { StudentCourseGate } from './StudentCourseGate'
import { useStudentHeartbeat } from './useStudentHeartbeat'

// Layout da prova online (AVA-12, UXA-X1): sem o menu lateral do portal, o sino, o aviso
// de provas disponíveis e o botão de sair da conta. A saída da prova é a da própria
// prova (Sair, com confirmação e registro no Monitor); o voltar do navegador também
// pede confirmação (useBlocker no ExamRunner).
export function StudentExamShell() {
  useStudentHeartbeat()
  return (
    <div className="app-canvas h-full flex flex-col text-text">
      <main className="flex-1 overflow-y-auto overflow-x-hidden px-4 md:px-6">
        <StudentCourseGate><Outlet /></StudentCourseGate>
      </main>
    </div>
  )
}
