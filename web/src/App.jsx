import { useState } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './context/AuthProvider'
import { canAccessAdminPath } from './lib/adminPermissions'
import { AppShell } from './components/layout/AppShell'
import { StudentShell } from './features/student/StudentShell'
import { Input } from './components/ui/Input'
import { Button } from './components/ui/Button'
import { api } from './lib/api'
import LoginPage from './features/LoginPage'
// Instrutor
import DashboardPage from './features/admin/DashboardPage'
import ProvasPage from './features/admin/ProvasPage'
import MonitorPage from './features/admin/MonitorPage'
import ResultadosPage from './features/admin/ResultadosPage'
import MateriaisPage from './features/admin/MateriaisPage'
import ChamadaPage from './features/admin/ChamadaPage'
import AvisosPage from './features/admin/AvisosPage'
import CalendarioPage from './features/admin/CalendarioPage'
import BibliotecaPage from './features/admin/BibliotecaPage'
import EditorPage from './features/admin/EditorPage'
import TurmasPage from './features/admin/TurmasPage'
import AssistenteHorariosPage from './features/admin/AssistenteHorariosPage'
import AlunosPage from './features/admin/AlunosPage'
import MatriculasPage from './features/admin/MatriculasPage'
import AlunosGlobalPage from './features/admin/AlunosGlobalPage'
import AlunoGlobalEditPage from './features/admin/AlunoGlobalEditPage'
import AlunoDetailPage from './features/admin/AlunoDetailPage'
import AdminsPage from './features/admin/AdminsPage'
import AdminEditPage from './features/admin/AdminEditPage'
import ForumPage from './features/admin/ForumPage'
import IdentidadePage from './features/admin/IdentidadePage'
import EscolasPage from './features/admin/EscolasPage'
import EscolaEditPage from './features/admin/EscolaEditPage'
import SistemaPage from './features/admin/SistemaPage'
// Aluno
import InicioPage from './features/student/InicioPage'
import ModulosPage from './features/student/ModulosPage'
import ProvasStudentPage from './features/student/ProvasPage'
import ExamRunner from './features/student/exam/ExamRunner'
import CadernoPage from './features/student/CadernoPage'
import DuvidasPage from './features/student/DuvidasPage'
import AvisosStudentPage from './features/student/AvisosPage'
import CalendarioStudentPage from './features/student/CalendarioPage'
import BibliotecaStudentPage from './features/student/BibliotecaPage'

function RequireRole({ role, children }) {
  const { auth, authReady } = useAuth()
  const loc = useLocation()
  if (!authReady) return <SessionLoading />
  if (!auth.role) return <Navigate to="/login" state={{ from: loc }} replace />
  if (role && auth.role !== role) return <Navigate to={auth.role === 'admin' ? '/' : '/aluno'} replace />
  return children
}

function RequireAdminPath({ path, children }) {
  const { auth } = useAuth()
  if (!canAccessAdminPath(auth, path)) {
    return <Navigate to="/" replace state={{ accessDenied: true, deniedPath: path }} />
  }
  return children
}

function RequireAdministrator({ children }) {
  const { auth } = useAuth()
  return auth.accountRole === 'professor' ? <Navigate to="/" replace /> : children
}

function SessionLoading() {
  return (
    <div className="min-h-screen grid place-items-center bg-bg text-text">
      <div className="text-sm text-muted">Validando sessão...</div>
    </div>
  )
}

export default function App() {
  const { auth, authReady, maintenance, setAuth } = useAuth()
  if (!authReady) return <SessionLoading />
  if (auth.role === 'student' && maintenance?.enabled) return <MaintenanceScreen message={maintenance.message} />
  if (auth.role === 'admin' && auth.mustChangePassword) return <PasswordChangeScreen onChanged={() => setAuth((current) => ({ ...current, mustChangePassword: false }))} />
  return (
    <>
      <Routes>
      <Route path="/login" element={auth.role ? <Navigate to={auth.role === 'admin' ? '/' : '/aluno'} replace /> : <LoginPage />} />

      {/* Instrutor */}
      <Route element={<RequireRole role="admin"><AppShell /></RequireRole>}>
        <Route index element={<RequireAdminPath path="/"><DashboardPage /></RequireAdminPath>} />
        <Route path="provas" element={<RequireAdminPath path="/provas"><ProvasPage /></RequireAdminPath>} />
        <Route path="monitor" element={<RequireAdminPath path="/monitor"><MonitorPage /></RequireAdminPath>} />
        <Route path="resultados" element={<RequireAdminPath path="/resultados"><ResultadosPage /></RequireAdminPath>} />
        <Route path="resultados/aluno/:studentId" element={<RequireAdminPath path="/resultados"><ResultadosPage /></RequireAdminPath>} />
        <Route path="resultados/aluno/:studentId/prova/:submissionId" element={<RequireAdminPath path="/resultados"><ResultadosPage /></RequireAdminPath>} />
        <Route path="materiais" element={<RequireAdminPath path="/materiais"><MateriaisPage /></RequireAdminPath>} />
        <Route path="chamada" element={<RequireAdminPath path="/chamada"><ChamadaPage /></RequireAdminPath>} />
        <Route path="avisos" element={<RequireAdminPath path="/avisos"><AvisosPage /></RequireAdminPath>} />
        <Route path="calendario" element={<RequireAdminPath path="/calendario"><CalendarioPage /></RequireAdminPath>} />
        <Route path="editor" element={<RequireAdminPath path="/editor"><EditorPage /></RequireAdminPath>} />
        <Route path="biblioteca" element={<RequireAdminPath path="/biblioteca"><BibliotecaPage /></RequireAdminPath>} />
        <Route path="turmas" element={<RequireAdminPath path="/turmas"><TurmasPage /></RequireAdminPath>} />
        <Route path="turmas/:courseId/:className/assistente" element={<RequireAdminPath path="/turmas"><AssistenteHorariosPage /></RequireAdminPath>} />
        <Route path="alunos" element={<RequireAdminPath path="/alunos"><AlunosPage /></RequireAdminPath>} />
        <Route path="matriculas" element={<RequireAdministrator><RequireAdminPath path="/matriculas"><MatriculasPage /></RequireAdminPath></RequireAdministrator>} />
        <Route path="diretorio" element={<RequireAdminPath path="/diretorio"><AlunosGlobalPage /></RequireAdminPath>} />
        <Route path="diretorio/:email" element={<RequireAdminPath path="/diretorio"><AlunoGlobalEditPage /></RequireAdminPath>} />
        <Route path="alunos/:id" element={<RequireAdminPath path="/alunos"><AlunoDetailPage /></RequireAdminPath>} />
        <Route path="admins" element={<RequireAdminPath path="/admins"><AdminsPage /></RequireAdminPath>} />
        <Route path="admins/:email" element={<RequireAdminPath path="/admins"><AdminEditPage /></RequireAdminPath>} />
        <Route path="forum" element={<RequireAdminPath path="/forum"><ForumPage /></RequireAdminPath>} />
        <Route path="escolas" element={<RequireAdminPath path="/escolas"><EscolasPage /></RequireAdminPath>} />
        <Route path="escolas/:id" element={<RequireAdminPath path="/escolas"><EscolaEditPage /></RequireAdminPath>} />
        <Route path="identidade" element={<RequireAdminPath path="/identidade"><IdentidadePage /></RequireAdminPath>} />
        <Route path="sistema" element={<RequireAdminPath path="/sistema"><SistemaPage /></RequireAdminPath>} />
      </Route>

      {/* Aluno */}
      <Route path="/aluno" element={<RequireRole role="student"><StudentShell /></RequireRole>}>
        <Route index element={<InicioPage />} />
        <Route path="modulos" element={<ModulosPage />} />
        <Route path="provas" element={<ProvasStudentPage />} />
        <Route path="prova/:examKey" element={<ExamRunner />} />
        <Route path="caderno" element={<CadernoPage />} />
        <Route path="duvidas" element={<DuvidasPage />} />
        <Route path="avisos" element={<AvisosStudentPage />} />
        <Route path="calendario" element={<CalendarioStudentPage />} />
        <Route path="biblioteca" element={<BibliotecaStudentPage />} />
      </Route>

        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </>
  )
}

function MaintenanceScreen({ message }) {
  return (
    <main className="min-h-screen grid place-items-center bg-bg p-6 text-text">
      <div className="max-w-md rounded-xl border border-border bg-surface p-8 text-center shadow-lg" role="status">
        <h1 className="text-xl font-bold">Sistema em manutenção</h1>
        <p className="mt-3 text-sm text-muted">{message || 'Tente novamente em alguns instantes.'}</p>
      </div>
    </main>
  )
}

function PasswordChangeScreen({ onChanged }) {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event) {
    event.preventDefault()
    if (password.length < 10) return setError('Use pelo menos 10 caracteres.')
    if (password !== confirmation) return setError('As senhas não coincidem.')
    setBusy(true); setError('')
    try { await api.post('/api/admin/change-password', { newPassword: password }); onChanged() }
    catch (submitError) { setError(submitError.message) } finally { setBusy(false) }
  }
  return (
    <main className="min-h-screen grid place-items-center bg-bg p-6 text-text">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-border bg-surface p-6 shadow-lg space-y-4">
        <div><h1 className="text-xl font-bold">Troque a senha temporária</h1><p className="mt-1 text-sm text-muted">Esta etapa é obrigatória antes de acessar o painel.</p></div>
        <Input label="Nova senha" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
        <Input label="Confirmar nova senha" type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} error={error} />
        <Button type="submit" className="w-full" loading={busy}>Salvar nova senha</Button>
      </form>
    </main>
  )
}
