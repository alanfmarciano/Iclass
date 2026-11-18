import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { AdminCourseGate } from '../../features/admin/AdminCourseGate'
import { useBranding } from '../../context/BrandingProvider'
import { LumenAdminShell } from './LumenAdminShell'
const CRUMBS = {
  '/calendario': ['Gestão', 'Calendário'], '/avisos': ['Gestão', 'Avisos'],
  '/': ['Visão geral', 'Dashboard'], '/provas': ['Avaliações', 'Provas'],
  '/monitor': ['Avaliações', 'Monitor Online'], '/resultados': ['Avaliações', 'Resultados'],
  '/materiais': ['Conteúdo', 'Materiais & Liberação'], '/editor': ['Conteúdo', 'Editor'],
  '/turmas': ['Gestão acadêmica', 'Cursos e turmas'], '/alunos': ['Gestão', 'Alunos'], '/matriculas': ['Visão geral', 'Matrículas'], '/admins': ['Instituição', 'Administradores'],
  '/forum': ['Gestão', 'Fórum & Dúvidas'], '/escolas': ['Instituição', 'Escolas'],
  '/identidade': ['Instituição', 'Identidade Visual'], '/sistema': ['Instituição', 'Sistema'],
}
export function AppShell() {
  const [open, setOpen] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches)
  const { pathname } = useLocation()
  const { interfacePreset } = useBranding()
  const breadcrumb = CRUMBS[pathname] || (pathname.startsWith('/resultados/') ? CRUMBS['/resultados'] : ['IClass'])
  // No celular o menu cobre a página: fecha ao escolher um destino (senão os botões da
  // página escolhida ficavam atrás dele até tocar no fundo escurecido).
  const closeOnMobile = () => {
    if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 768px)').matches) setOpen(false)
  }
  useEffect(() => { closeOnMobile() }, [pathname])

  if (interfacePreset === 'lumen') return <LumenAdminShell />

  return (
    <div className="app-canvas h-full flex text-text">
      <Sidebar open={open} onNavigate={closeOnMobile} />
      {open && <button type="button" aria-label="Fechar menu" className="fixed inset-0 z-30 bg-black/55 backdrop-blur-sm md:hidden" onClick={() => setOpen(false)} />}
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar onMenu={() => setOpen((o) => !o)} breadcrumb={breadcrumb} />
        <main className="flex-1 overflow-y-auto px-4 py-6 md:px-8 md:py-8 xl:px-10">
          <div key={pathname} className="app-enter">
            <AdminCourseGate><Outlet /></AdminCourseGate>
          </div>
        </main>
      </div>
    </div>
  )
}
