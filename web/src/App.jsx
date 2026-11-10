import { Suspense } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './context/AuthProvider'
import { canAccessAdminPath } from './lib/adminPermissions'
import { lazyPage } from './lib/lazyPage'
import { PasswordChangeForm } from './components/PasswordChangeForm'
import { PageLoading } from './components/ui/PageLoading'
import LoginPage from './features/LoginPage'

// Telas e layouts sob demanda (H2-A, DES-06): cada um é um arquivo próprio do build, e o
// navegador só baixa o que abre. O login continua no pacote inicial (é a primeira tela).
// Tela nova entra aqui com lazyPage(() => import(...)). Layout cujo arquivo não chegou
// (servidor fora, Wi-Fi caída) espera na tela inteira (LayoutLoading); a tela dentro do
// layout espera no lugar da página, com o menu à vista.
const layoutOptions = { loading: LayoutLoading }
const AppShell = lazyPage(() => import('./components/layout/AppShell'), 'AppShell', layoutOptions)
const StudentShell = lazyPage(() => import('./features/student/StudentShell'), 'StudentShell', layoutOptions)
const StudentExamShell = lazyPage(() => import('./features/student/StudentExamShell'), 'StudentExamShell', layoutOptions)
// Instrutor
const DashboardPage = lazyPage(() => import('./features/admin/DashboardPage'))
const ProvasPage = lazyPage(() => import('./features/admin/ProvasPage'))
const MonitorPage = lazyPage(() => import('./features/admin/MonitorPage'))
const ResultadosPage = lazyPage(() => import('./features/admin/ResultadosPage'))
const MateriaisPage = lazyPage(() => import('./features/admin/MateriaisPage'))
const ChamadaPage = lazyPage(() => import('./features/admin/ChamadaPage'))
const AvisosPage = lazyPage(() => import('./features/admin/AvisosPage'))
const CalendarioPage = lazyPage(() => import('./features/admin/CalendarioPage'))
const BibliotecaPage = lazyPage(() => import('./features/admin/BibliotecaPage'))
const EditorPage = lazyPage(() => import('./features/admin/EditorPage'))
const TurmasPage = lazyPage(() => import('./features/admin/TurmasPage'))
const AssistenteHorariosPage = lazyPage(() => import('./features/admin/AssistenteHorariosPage'))
const AlunosPage = lazyPage(() => import('./features/admin/AlunosPage'))
const MatriculasPage = lazyPage(() => import('./features/admin/MatriculasPage'))
const AlunosGlobalPage = lazyPage(() => import('./features/admin/AlunosGlobalPage'))
const AlunoGlobalEditPage = lazyPage(() => import('./features/admin/AlunoGlobalEditPage'))
const AlunoDetailPage = lazyPage(() => import('./features/admin/AlunoDetailPage'))
const AdminsPage = lazyPage(() => import('./features/admin/AdminsPage'))
const AdminEditPage = lazyPage(() => import('./features/admin/AdminEditPage'))
const ForumPage = lazyPage(() => import('./features/admin/ForumPage'))
const IdentidadePage = lazyPage(() => import('./features/admin/IdentidadePage'))
const EscolasPage = lazyPage(() => import('./features/admin/EscolasPage'))
const EscolaEditPage = lazyPage(() => import('./features/admin/EscolaEditPage'))
const SistemaPage = lazyPage(() => import('./features/admin/SistemaPage'))
const AuditoriaPage = lazyPage(() => import('./features/admin/AuditoriaPage'))
const PrivacidadePage = lazyPage(() => import('./features/admin/PrivacidadePage'))
// Públicas (sem login): Termos de Uso e Política de Privacidade (H8a-1).
const LegalDocumentPage = lazyPage(() => import('./features/LegalDocumentPage'))
// Aluno
const InicioPage = lazyPage(() => import('./features/student/InicioPage'))
const ModulosPage = lazyPage(() => import('./features/student/ModulosPage'))
const ProvasStudentPage = lazyPage(() => import('./features/student/ProvasPage'))
const ExamRunner = lazyPage(() => import('./features/student/exam/ExamRunner'))
const CadernoPage = lazyPage(() => import('./features/student/CadernoPage'))
const DuvidasPage = lazyPage(() => import('./features/student/DuvidasPage'))
const AvisosStudentPage = lazyPage(() => import('./features/student/AvisosPage'))
const CalendarioStudentPage = lazyPage(() => import('./features/student/CalendarioPage'))
const BibliotecaStudentPage = lazyPage(() => import('./features/student/BibliotecaPage'))
const ContaStudentPage = lazyPage(() => import('./features/student/ContaPage'))

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

function LayoutLoading() {
  return (
    <div className="min-h-screen grid place-items-center bg-bg text-text">
      <PageLoading />
    </div>
  )
}

export default function App() {
  const { auth, authReady, maintenance, setAuth } = useAuth()
  if (!authReady) return <SessionLoading />
  if (auth.role === 'student' && maintenance?.enabled) return <MaintenanceScreen message={maintenance.message} />
  if (auth.role === 'admin' && auth.mustChangePassword) return <PasswordChangeScreen reason={auth.passwordChangeReason} onChanged={() => setAuth((current) => ({ ...current, mustChangePassword: false, passwordChangeReason: null }))} />
  // O layout (painel do instrutor, portal do aluno ou prova) chega sob demanda: até lá,
  // a mesma tela de "Validando sessão...". As telas dentro do layout têm o próprio
  // "Carregando..." (PageLoading), com o menu à vista.
  return (
    <Suspense fallback={<SessionLoading />}>
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
        <Route path="auditoria" element={<RequireAdministrator><RequireAdminPath path="/auditoria"><AuditoriaPage /></RequireAdminPath></RequireAdministrator>} />
        <Route path="lgpd" element={<RequireAdministrator><RequireAdminPath path="/lgpd"><PrivacidadePage /></RequireAdminPath></RequireAdministrator>} />
      </Route>

      {/* Aluno */}
      {/* Prova online em layout próprio, sem o menu, o sino e os links do portal (AVA-12). */}
      <Route path="/aluno/prova/:examKey" element={<RequireRole role="student"><StudentExamShell /></RequireRole>}>
        <Route index element={<ExamRunner />} />
      </Route>
      <Route path="/aluno" element={<RequireRole role="student"><StudentShell /></RequireRole>}>
        <Route index element={<InicioPage />} />
        <Route path="modulos" element={<ModulosPage />} />
        <Route path="provas" element={<ProvasStudentPage />} />
        <Route path="caderno" element={<CadernoPage />} />
        <Route path="duvidas" element={<DuvidasPage />} />
        <Route path="avisos" element={<AvisosStudentPage />} />
        <Route path="calendario" element={<CalendarioStudentPage />} />
        <Route path="biblioteca" element={<BibliotecaStudentPage />} />
        <Route path="conta" element={<ContaStudentPage />} />
      </Route>

      {/* Termos e Privacidade: abertos a qualquer um, com ou sem login (H8a-1). */}
      <Route path="/termos" element={<LegalDocumentPage kind="termos" />} />
      <Route path="/privacidade" element={<LegalDocumentPage kind="privacidade" />} />

        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </Suspense>
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

// Troca obrigatória do instrutor (senha temporária do launcher, conta criada pelo
// administrador ou senha fraca, H5a): o mesmo formulário do aluno, com o mínimo de 10
// caracteres. A senha atual é pedida na conta criada pelo administrador e na senha fraca
// (o servidor também pede, com 400 currentPasswordRequired, e o campo aparece).
const ADMIN_PASSWORD_INTRO = {
  created: 'A sua conta foi criada com uma senha definida pelo administrador. Antes de acessar o painel, escolha uma senha só sua.',
  weak: 'A sua senha é fácil de adivinhar. Antes de acessar o painel, escolha uma senha nova.',
}
function PasswordChangeScreen({ reason, onChanged }) {
  const askCurrent = reason === 'created' || reason === 'weak'
  return (
    <main className="min-h-screen grid place-items-center bg-bg p-6 text-text">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-6 shadow-lg space-y-4">
        <div>
          <h1 className="text-xl font-bold">{reason === 'weak' ? 'Troque a sua senha' : 'Troque a senha temporária'}</h1>
          <p className="mt-1 text-sm text-muted">{ADMIN_PASSWORD_INTRO[reason] || 'Esta etapa é obrigatória antes de acessar o painel.'}</p>
        </div>
        <PasswordChangeForm
          kind="instructor"
          endpoint="/api/admin/change-password"
          askCurrent={askCurrent}
          currentLabel={reason === 'created' ? 'Senha recebida' : 'Senha atual'}
          onChanged={onChanged}
        />
      </div>
    </main>
  )
}
