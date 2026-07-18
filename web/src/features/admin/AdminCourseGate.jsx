import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ArrowRight, BookOpen, Clock3, Search, Star, Users } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Card, CardBody } from '../../components/ui/Card'
import { PageState } from '../../components/ui/PageState'
import { EmptyState } from '../../components/ui/EmptyState'
import { useApi } from '../../hooks/useApi'
import { useAuth } from '../../context/AuthProvider'
import { usePreferences } from '../../context/PreferencesProvider'

const INSTITUTION_PATHS = ['/turmas', '/diretorio', '/escolas', '/identidade', '/admins', '/sistema']

function isDeleted(course) {
  return course?.deleted === true || course?.status === 'deleted' || course?.status === 'inactive' || !!course?.deletedAt
}

function normalized(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

function contextKey(courseId, className) {
  return `${courseId}::${className}`
}

function WorkspaceCard({ item, favorite, onFavorite, onOpen, onManage, isProfessor }) {
  const { course, cls } = item
  const enabled = !!cls
  const label = enabled ? `Entrar em ${course.name}, turma ${cls.name}` : `${course.name} sem turma disponível`

  function open() {
    if (enabled) onOpen(item)
  }

  return (
    <Card
      className={`group relative h-full transition-all duration-300 ${enabled ? 'hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-[0_18px_45px_var(--primary-glow)]' : 'opacity-80'}`}
    >
      {enabled && <button type="button" aria-label={label} onClick={open} className="absolute inset-0 z-0 cursor-pointer rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" />}
      <CardBody className={`relative z-10 flex h-full flex-col gap-4 pt-5 ${enabled ? 'pointer-events-none' : ''}`}>
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><BookOpen size={19} /></span>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-text">{course.name}</h3>
            <p className="mt-1 line-clamp-2 text-xs text-subtle">{course.description || 'Ambiente de aprendizagem'}</p>
          </div>
          {enabled && (
            <button
              type="button"
              onClick={(event) => { event.stopPropagation(); onFavorite(item) }}
              aria-label={favorite ? `Remover ${course.name}, ${cls.name} dos favoritos` : `Adicionar ${course.name}, ${cls.name} aos favoritos`}
              className={`pointer-events-auto relative z-20 grid h-8 w-8 shrink-0 place-items-center rounded-lg ${favorite ? 'text-warning' : 'text-subtle hover:bg-surface-2 hover:text-warning'}`}
            >
              <Star size={19} fill={favorite ? 'currentColor' : 'none'} />
            </button>
          )}
        </div>

        {enabled ? (
          <>
            <div className="rounded-xl border border-primary/15 bg-primary-soft px-3.5 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-[.16em] text-primary">Turma</p>
              <div className="mt-1 flex items-center justify-between gap-3">
                <p className="truncate text-lg font-semibold text-text">{cls.name}</p>
                {cls.period && <span className="rounded-full border border-border bg-surface px-2.5 py-1 text-[11px] text-muted">{cls.period}</span>}
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted"><Users size={14} /><span>{cls.studentCount || 0} aluno(s)</span></div>
            <Button
              className="pointer-events-auto relative z-20 mt-auto w-full"
              icon={ArrowRight}
              onClick={(event) => { event.stopPropagation(); onOpen(item) }}
            >
              Entrar na turma
            </Button>
          </>
        ) : (
          <>
            <div className="rounded-xl border border-warning/25 bg-warning-soft px-3.5 py-3">
              <p className="font-semibold text-text">Sem turma</p>
              <p className="mt-1 text-xs text-muted">Este curso ainda não possui um ambiente de turma disponível.</p>
            </div>
            {isProfessor ? (
              <p className="mt-auto text-xs text-subtle">Solicite à administração a criação da primeira turma.</p>
            ) : (
              <Button className="pointer-events-auto relative z-20 mt-auto w-full" variant="secondary" onClick={(event) => { event.stopPropagation(); onManage(course) }}>Criar turma</Button>
            )}
          </>
        )}
      </CardBody>
    </Card>
  )
}

export function AdminCourseGate({ children }) {
  const { auth, setActiveWorkspace, clearActiveWorkspace } = useAuth()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { pref, setPref } = usePreferences()
  const [search, setSearch] = useState('')
  const courses = useApi('/api/admin/course-summaries')
  const schools = useApi('/api/admin/schools')

  const activeCourses = useMemo(() => (courses.data || []).filter(course => !isDeleted(course)), [courses.data])
  const allItems = useMemo(() => activeCourses.flatMap(course => {
    const classes = Array.isArray(course.classes) ? course.classes : []
    return classes.length ? classes.map(cls => ({ course, cls, key: contextKey(course.id, cls.name) })) : [{ course, cls: null, key: `empty::${course.id}` }]
  }), [activeCourses])
  const workspace = auth.activeWorkspace
  const activeItem = workspace ? allItems.find(item => item.cls && item.course.id === workspace.courseId && item.cls.name === workspace.className) : null

  useEffect(() => {
    if (!workspace || courses.loading) return
    if (!activeItem) clearActiveWorkspace(false)
    else {
      const canonical = {
        courseId: activeItem.course.id,
        courseName: activeItem.course.name,
        schoolId: activeItem.course.schoolId || '',
        className: activeItem.cls.name,
        period: activeItem.cls.period || '',
      }
      if (Object.keys(canonical).some(key => String(workspace[key] || '') !== String(canonical[key] || ''))) setActiveWorkspace(canonical)
    }
  }, [workspace, courses.loading, activeItem, clearActiveWorkspace, setActiveWorkspace])

  if (activeItem) return children
  if (INSTITUTION_PATHS.some(path => pathname === path || pathname.startsWith(`${path}/`))) return children

  const schoolMap = new Map((schools.data || []).map(school => [school.id, school.name]))
  const favorites = pref('gate.favorites', [])
  const recent = pref('gate.recentContexts', [])

  const expandedFavoriteKeys = new Set(favorites.flatMap(value => {
    if (String(value).includes('::')) return [value]
    return allItems.filter(item => item.cls && item.course.id === value).map(item => item.key)
  }))

  const query = normalized(search)
  const filtered = allItems.filter(item => {
    if (!query) return true
    const schoolName = schoolMap.get(item.course.schoolId) || ''
    return normalized(`${item.course.name} ${item.course.id} ${item.course.description || ''} ${schoolName} ${item.cls?.name || ''} ${item.cls?.period || ''}`).includes(query)
  })

  const groups = (() => {
    const map = new Map()
    filtered.forEach(item => {
      const schoolId = item.course.schoolId || 'escola_default'
      if (!map.has(schoolId)) map.set(schoolId, { id: schoolId, name: schoolMap.get(schoolId) || 'Sem escola definida', items: [] })
      map.get(schoolId).items.push(item)
    })
    return [...map.values()]
      .map(group => ({ ...group, items: group.items.sort((a, b) => `${a.course.name} ${a.cls?.name || ''}`.localeCompare(`${b.course.name} ${b.cls?.name || ''}`, 'pt-BR')) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
  })()

  const favoriteItems = filtered.filter(item => item.cls && expandedFavoriteKeys.has(item.key))
  const recentItems = recent.map(key => filtered.find(item => item.key === key)).filter(Boolean).slice(0, 3)

  function toggleFavorite(item) {
    const normalizedFavorites = [...expandedFavoriteKeys]
    const next = expandedFavoriteKeys.has(item.key)
      ? normalizedFavorites.filter(key => key !== item.key)
      : [...normalizedFavorites, item.key]
    setPref('gate.favorites', next)
  }

  function openWorkspace(item) {
    let preservePath = false
    try {
      preservePath = sessionStorage.getItem('iclass-workspace-switch') === '1'
      sessionStorage.removeItem('iclass-workspace-switch')
    } catch {}
    setActiveWorkspace({
      courseId: item.course.id,
      courseName: item.course.name,
      schoolId: item.course.schoolId || '',
      className: item.cls.name,
      period: item.cls.period || '',
    })
    setPref('gate.recentContexts', [item.key, ...recent.filter(key => key !== item.key)].slice(0, 5))
    if (!preservePath && pathname !== '/') navigate('/')
  }

  const renderGrid = items => (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {items.map(item => (
        <WorkspaceCard
          key={item.key}
          item={item}
          favorite={expandedFavoriteKeys.has(item.key)}
          onFavorite={toggleFavorite}
          onOpen={openWorkspace}
          onManage={course => navigate(`/turmas?courseId=${encodeURIComponent(course.id)}`)}
          isProfessor={auth.accountRole === 'professor'}
        />
      ))}
    </div>
  )

  return (
    <div className="mx-auto max-w-6xl space-y-7">
      <div>
        <h1 className="text-[2rem] font-semibold tracking-[-0.045em] text-text">Selecione o curso e a turma</h1>
        <p className="mt-1.5 text-sm text-muted">Escolha o contexto em que você deseja trabalhar.</p>
      </div>

      <PageState loading={courses.loading || schools.loading} error={courses.error || schools.error} onRetry={() => { courses.refetch(); schools.refetch() }}>
        <label className="relative block max-w-xl">
          <Search size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-subtle" />
          <span className="sr-only">Buscar curso ou turma</span>
          <input
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Buscar por curso, turma, período ou escola"
            className="h-11 w-full rounded-lg border border-border bg-surface pl-11 pr-4 text-sm text-text placeholder:text-subtle"
          />
        </label>

        {favoriteItems.length > 0 && (
          <section className="space-y-3" aria-labelledby="favorite-workspaces">
            <h2 id="favorite-workspaces" className="flex items-center gap-2 text-base font-semibold text-text"><Star size={17} className="text-warning" /> Favoritos</h2>
            {renderGrid(favoriteItems)}
          </section>
        )}

        {recentItems.length > 0 && (
          <section className="space-y-3" aria-labelledby="recent-workspaces">
            <h2 id="recent-workspaces" className="flex items-center gap-2 text-base font-semibold text-text"><Clock3 size={17} className="text-primary" /> Recentes</h2>
            {renderGrid(recentItems)}
          </section>
        )}

        {groups.length === 0 ? (
          <Card><CardBody className="pt-5"><EmptyState icon={BookOpen} title="Nenhum contexto encontrado" description={search ? 'Tente outro termo de busca.' : 'Não há cursos e turmas disponíveis para o seu perfil.'} /></CardBody></Card>
        ) : groups.map(group => {
          const courseCount = new Set(group.items.map(item => item.course.id)).size
          const classCount = group.items.filter(item => item.cls).length
          return (
            <section key={group.id} className="space-y-3" aria-labelledby={`school-${group.id}`}>
              <div className="flex items-center justify-between gap-3">
                <h2 id={`school-${group.id}`} className="text-base font-semibold text-text">{group.name}</h2>
                <span className="text-xs text-subtle">{courseCount} curso(s) · {classCount} turma(s)</span>
              </div>
              {renderGrid(group.items)}
            </section>
          )
        })}
      </PageState>
    </div>
  )
}
