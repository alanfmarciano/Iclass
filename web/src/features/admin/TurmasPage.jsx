import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Archive, BookCopy, BookOpen, Building2, ClipboardList, Lock, LockOpen, Pencil, Plus, RotateCcw, Search, School, Trash2, UserPlus, Users, UsersRound, Wand2 } from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Card, CardBody } from '../../components/ui/Card'
import { ConfirmDialog, Modal } from '../../components/ui/Modal'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import { Switch } from '../../components/ui/Switch'
import { PageState } from '../../components/ui/PageState'
import { EmptyState } from '../../components/ui/EmptyState'
import { useApi } from '../../hooks/useApi'
import { matchesSearch, normalizeSearch } from '../../lib/textSearch'
import { api } from '../../lib/api'
import { useAuth } from '../../context/AuthProvider'
import { CourseExportButton, CourseImportButton } from './CoursePackageDialog'
import { useToast } from '../../context/ToastProvider'
import { DisciplinasModal, GradeEditor } from './TurmaPresencaConfig'
import { ADMIN_PERMISSIONS, canAccessAdminPermission, isFullAdmin, isProfessorRoleAccount } from '../../lib/adminPermissions'
import { GradingCriteriaDialog } from './GradingCriteriaDialog'
import { AcademicTermsSection, brDate, termOptionLabel, termOptionsForCourse } from './AcademicTermsSection'
import { groupsPath } from './grupos/groupsPath'
import { PreviewButton, canPreviewAsStudent } from './PreviewLauncher'
import { ClassClosureDialog } from './ClassClosureDialog'

const CLASS_PERIODS = ['Manhã', 'Tarde', 'Noite']

function isDeleted(course) {
  return course?.deleted === true || course?.status === 'deleted' || course?.status === 'inactive' || !!course?.deletedAt
}

// Texto sem acento e sem maiúscula: a regra única da busca (lib/textSearch.js, CRIT-07).
const normalize = normalizeSearch

function canonicalClassPeriod(value) {
  return CLASS_PERIODS.find(period => normalize(period) === normalize(value)) || 'Manhã'
}

function teacherSources(teacher, course, className) {
  const sources = []
  if ((teacher.assignedSchoolIds || []).includes(course.schoolId)) sources.push('Escola')
  if ((teacher.assignedCourseIds || []).includes(course.id)) sources.push('Curso')
  if ((teacher.assignedClasses || []).some(item => item.courseId === course.id && (!className || item.className === className))) sources.push('Turma específica')
  return sources
}

function hasCourseAccess(teacher, course) {
  return teacherSources(teacher, course).length > 0
}

function OriginBadges({ sources }) {
  return <span className="flex flex-wrap gap-1">{sources.map(source => <Badge key={source} tone={source === 'Turma específica' ? 'neutral' : 'info'}>{source}</Badge>)}</span>
}

// Seletor "Período letivo" do formulário da turma (B8 / P2-S8): os períodos abertos de
// toda a instituição ou da escola do curso, mais o que a turma já tem. Enquanto a lista
// não carrega (ou falhou), o seletor fica travado e o pedido não leva o campo.
function ClassTermField({ form, setForm, termsApi, course }) {
  const periodos = Array.isArray(termsApi?.data?.periodos) ? termsApi.data.periodos : []
  const ready = !!termsApi?.data && !termsApi?.error
  const options = termOptionsForCourse(periodos, course, form.periodoLetivoInicial || '')
  const current = options.find(term => term.id === form.periodoLetivoId)
  const missing = !!form.periodoLetivoId && !current
  const helper = !ready
    ? (termsApi?.error ? 'Não foi possível carregar os períodos letivos; o período da turma fica como está.' : 'Carregando os períodos letivos...')
    : current
      ? `Aulas de ${brDate(current.inicio)} a ${brDate(current.fim)}: fora dessas datas a Chamada avisa que não há aula e o Dashboard não cobra a chamada.`
      : options.length === 0
        ? `Nenhum período letivo aberto para ${course?.name || 'este curso'}. Cadastre em "Períodos letivos", nesta tela.`
        : 'Sem período, todo dia da grade horária tem aula, como antes.'
  return (
    <div className="space-y-1.5">
      <Select label="Período letivo" value={form.periodoLetivoId || ''} disabled={!ready}
        onChange={event => setForm(currentForm => ({ ...currentForm, periodoLetivoId: event.target.value }))}>
        <option value="">Sem período letivo</option>
        {missing && <option value={form.periodoLetivoId}>Período atual da turma</option>}
        {options.map(term => <option key={term.id} value={term.id}>{termOptionLabel(term)}</option>)}
      </Select>
      <p className="text-xs text-subtle">{helper}</p>
    </div>
  )
}

export default function TurmasPage() {
  const { auth } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()
  // Criar e mudar cursos e turmas, atribuir professor e arquivo: só o administrador pleno
  // (contrato C2 do P4; antes era "não é professor").
  const isAdmin = isFullAdmin(auth)
  // Critérios de avaliação do curso (B9): abrir pede page.results, como GET /grading/criteria
  // e /grading/preview no servidor; quem também gerencia cursos (course.manage) altera, e
  // o resto (professor, Coordenação) vê sem alterar (o diálogo segue o podeAlterar).
  const canSeeCriteria = canAccessAdminPermission(auth, ADMIN_PERMISSIONS.PAGE_RESULTS)
  // Grupos da turma (fase 3, P5-S4): quem tem a tela Alunos (o professor também).
  const canGroups = canAccessAdminPermission(auth, ADMIN_PERMISSIONS.PAGE_STUDENTS)
  // Ver como aluno (fase 3, C15 / P5-S6b): quem tem o conteúdo das turmas (page.materials).
  const canPreview = canPreviewAsStudent(auth)
  // Encerrar e reabrir turma (B10 / P2-S9): quem tem "Gerenciar turmas" (classes.manage),
  // como POST /api/admin/class/close no servidor (o escopo da turma o servidor confere).
  const canCloseClasses = canAccessAdminPermission(auth, ADMIN_PERMISSIONS.CLASSES_MANAGE)
  const coursesApi = useApi('/api/admin/course-summaries?includeDeleted=1')
  const classesApi = useApi('/api/admin/classes')
  const schoolsApi = useApi('/api/admin/schools')
  const accountsApi = useApi(isAdmin ? '/api/admin/accounts' : null)
  const archivedApi = useApi(isAdmin ? '/api/admin/archived-courses' : null)
  // Períodos letivos (B8 / P2-S8): a seção da tela, o seletor do formulário da turma e o
  // selo de cada turma leem a mesma lista (GET /api/admin/academic/terms, page.dashboard).
  const termsApi = useApi('/api/admin/academic/terms')
  const [search, setSearch] = useState('')
  const [schoolFilter, setSchoolFilter] = useState('')
  const [professorFilter, setProfessorFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('active')
  const [onlyUnassigned, setOnlyUnassigned] = useState(false)
  const [selectedCourseId, setSelectedCourseId] = useState('')
  const [courseForm, setCourseForm] = useState(null)
  const [classForm, setClassForm] = useState(null)
  const [disciplinasForm, setDisciplinasForm] = useState(null)
  const [criteriaCourse, setCriteriaCourse] = useState(null)
  const [assignmentForm, setAssignmentForm] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const [closure, setClosure] = useState(null)
  const [saving, setSaving] = useState(false)

  const courses = coursesApi.data || []
  const classes = classesApi.data || []
  const schools = schoolsApi.data || []
  const professors = (accountsApi.data || []).filter(isProfessorRoleAccount)
  const periodos = Array.isArray(termsApi.data?.periodos) ? termsApi.data.periodos : []

  const filteredCourses = useMemo(() => courses.filter(course => {
    const courseClasses = classes.filter(cls => cls.courseId === course.id)
    const school = schools.find(item => item.id === course.schoolId)
    if (statusFilter === 'active' && isDeleted(course)) return false
    if (statusFilter === 'deleted' && !isDeleted(course)) return false
    if (schoolFilter && course.schoolId !== schoolFilter) return false
    if (professorFilter) {
      const professor = professors.find(item => item.email === professorFilter)
      if (!professor || !hasCourseAccess(professor, course)) return false
    }
    if (onlyUnassigned && !courseClasses.some(cls => Number(cls.professorCount || 0) === 0)) return false
    if (search && !matchesSearch([course.name, course.id, course.description, school?.name, courseClasses.map(cls => cls.name)], search)) return false
    return true
  }), [courses, classes, schools, professors, search, statusFilter, schoolFilter, professorFilter, onlyUnassigned])

  const selectedCourse = filteredCourses.find(course => course.id === selectedCourseId) || filteredCourses[0] || null
  const selectedClasses = selectedCourse ? classes.filter(cls => cls.courseId === selectedCourse.id) : []
  const selectedSchool = selectedCourse ? schools.find(school => school.id === selectedCourse.schoolId) : null
  const courseProfessors = selectedCourse ? professors.filter(professor => hasCourseAccess(professor, selectedCourse)) : []

  useEffect(() => {
    if (selectedCourse && !selectedCourseId) setSelectedCourseId(selectedCourse.id)
  }, [selectedCourse, selectedCourseId])

  const refresh = async () => {
    await Promise.all([coursesApi.refetch(), classesApi.refetch(), schoolsApi.refetch(), accountsApi.refetch(), archivedApi.refetch(), termsApi.refetch()])
  }

  const run = async (operation, success) => {
    setSaving(true)
    try {
      await operation()
      toast.success(success)
      await refresh()
      return true
    } catch (error) {
      toast.error(error.message)
      return false
    } finally {
      setSaving(false)
    }
  }

  // permitirImpressao (fase 3, C17 / P5-S3; D25 do P5): o aluno imprime ou salva em PDF a
  // apostila no leitor. Ausente no curso (de antes desta versão) vale ligado.
  const openNewCourse = () => setCourseForm({ mode: 'create', id: '', name: '', description: '', schoolId: schools[0]?.id || '', permitirImpressao: true })
  const openEditCourse = () => setCourseForm({ mode: 'edit', id: selectedCourse.id, name: selectedCourse.name || '', description: selectedCourse.description || '', schoolId: selectedCourse.schoolId || '', permitirImpressao: selectedCourse.permitirImpressao !== false })
  const openCloneCourse = () => setCourseForm({ mode: 'clone', sourceId: selectedCourse.id, id: `${selectedCourse.id}_COPIA`, name: `${selectedCourse.name} (cópia)`, description: selectedCourse.description || '', schoolId: selectedCourse.schoolId || '' })

  async function saveCourse() {
    const form = courseForm
    if (!form.name?.trim() || !form.schoolId || (form.mode !== 'edit' && !form.id?.trim())) return toast.error('Informe os dados obrigatórios do curso.')
    const ok = await run(async () => {
      if (form.mode === 'create') {
        const result = await api.post('/api/admin/courses', { id: form.id.trim().toUpperCase(), name: form.name.trim(), description: form.description?.trim(), schoolId: form.schoolId, permitirImpressao: form.permitirImpressao !== false })
        setSelectedCourseId(result.course.id)
      } else if (form.mode === 'edit') {
        await api.put(`/api/admin/courses/${encodeURIComponent(form.id)}`, { name: form.name.trim(), description: form.description?.trim(), schoolId: form.schoolId, permitirImpressao: form.permitirImpressao !== false })
      } else {
        const result = await api.post(`/api/admin/courses/${encodeURIComponent(form.sourceId)}/clone`, { newId: form.id.trim().toUpperCase(), newName: form.name.trim(), schoolId: form.schoolId }, { timeoutMs: 0 })
        setSelectedCourseId(result.course.id)
      }
    }, form.mode === 'clone' ? 'Curso duplicado.' : form.mode === 'edit' ? 'Curso atualizado.' : 'Curso criado.')
    if (ok) setCourseForm(null)
  }

  async function saveClass() {
    if (!classForm?.name?.trim() || !CLASS_PERIODS.includes(classForm?.period)) return toast.error('Informe o nome e selecione o turno: Manhã, Tarde ou Noite.')
    const attendanceConfig = classForm.attendanceConfig || { toleranciaMin: 10, limiarRiscoPct: 75, grade: {} }
    // Período letivo só vai no pedido quando mudou: sem o campo o servidor não mexe, e a
    // lista de períodos que não carregou nunca tira a turma do período por engano.
    const term = (classForm.periodoLetivoId || '') !== (classForm.periodoLetivoInicial || '') ? { periodoLetivoId: classForm.periodoLetivoId || null } : {}
    const ok = await run(() => classForm.mode === 'create'
      ? api.post('/api/admin/class/create', { name: classForm.name, period: classForm.period, courseId: selectedCourse.id, attendanceConfig, ...term })
      : api.post('/api/admin/class/update', { name: classForm.name, period: classForm.period, registrationEnabled: classForm.registrationEnabled, courseId: selectedCourse.id, attendanceConfig, ...term }),
    classForm.mode === 'create' ? 'Turma criada.' : 'Turma atualizada.')
    if (ok) setClassForm(null)
  }

  // Período letivo da turma para o selo: pela lista de períodos; o que a conta não vê
  // (escola fora do escopo) vem do resumo do curso (course-summaries).
  function classTerm(cls) {
    const id = cls?.periodoLetivoId || ''
    if (!id) return null
    const found = periodos.find(term => term.id === id)
    if (found) return found
    const summary = (selectedCourse?.classes || []).find(item => item.name === cls.name)?.periodoLetivo
    return summary ? { ...summary, situacao: 'aberto' } : null
  }

  async function saveDisciplinas(disciplinas) {
    const ok = await run(() => api.post('/api/admin/course/disciplinas', { courseId: selectedCourse.id, disciplinas }), 'Disciplinas atualizadas.')
    if (ok) setDisciplinasForm(null)
  }

  function openAssignments(email) {
    const professor = professors.find(item => item.email === email) || professors[0]
    if (!professor || !selectedCourse) return toast.warning('Cadastre uma conta de professor primeiro.')
    setAssignmentForm({
      professorEmail: professor.email,
      school: (professor.assignedSchoolIds || []).includes(selectedCourse.schoolId),
      course: (professor.assignedCourseIds || []).includes(selectedCourse.id),
      classes: selectedClasses.filter(cls => (professor.assignedClasses || []).some(item => item.courseId === selectedCourse.id && item.className === cls.name)).map(cls => cls.name),
    })
  }

  function changeAssignmentProfessor(email) {
    const professor = professors.find(item => item.email === email)
    if (!professor) return
    setAssignmentForm({
      professorEmail: email,
      school: (professor.assignedSchoolIds || []).includes(selectedCourse.schoolId),
      course: (professor.assignedCourseIds || []).includes(selectedCourse.id),
      classes: selectedClasses.filter(cls => (professor.assignedClasses || []).some(item => item.courseId === selectedCourse.id && item.className === cls.name)).map(cls => cls.name),
    })
  }

  async function saveAssignments() {
    const professor = professors.find(item => item.email === assignmentForm.professorEmail)
    if (!professor) return
    const nextSchools = (professor.assignedSchoolIds || []).filter(id => id !== selectedCourse.schoolId)
    if (assignmentForm.school) nextSchools.push(selectedCourse.schoolId)
    const nextCourses = (professor.assignedCourseIds || []).filter(id => id !== selectedCourse.id)
    if (assignmentForm.course) nextCourses.push(selectedCourse.id)
    const nextClasses = (professor.assignedClasses || []).filter(item => item.courseId !== selectedCourse.id)
    assignmentForm.classes.forEach(className => nextClasses.push({ courseId: selectedCourse.id, className }))
    const ok = await run(() => api.post('/api/admin/teacher-assignments', {
      email: professor.email,
      assignedSchoolIds: nextSchools,
      assignedCourseIds: nextCourses,
      assignedClasses: nextClasses,
    }), 'Acessos do professor atualizados.')
    if (ok) setAssignmentForm(null)
  }

  async function executeConfirm() {
    const current = confirm
    if (!current) return
    let ok = false
    if (current.type === 'class') ok = await run(() => api.post('/api/admin/class/delete', { name: current.target.name, courseId: selectedCourse.id }), 'Turma excluída.')
    if (current.type === 'course') ok = await run(() => api.delete(`/api/admin/courses/${encodeURIComponent(current.target.id)}`, { timeoutMs: 0 }), 'Curso excluído e preservado para restauração.')
    if (current.type === 'archive') ok = await run(() => api.post(`/api/admin/courses/${encodeURIComponent(current.target.id)}/purge`, {}, { timeoutMs: 0 }), 'Curso arquivado com segurança.')
    if (current.type === 'archive-delete') ok = await run(() => api.post('/api/admin/archived-courses/delete', { folder: current.target.folder }, { timeoutMs: 0 }), 'Arquivo excluído definitivamente.')
    if (ok) setConfirm(null)
  }

  const loading = coursesApi.loading || classesApi.loading || schoolsApi.loading || (isAdmin && accountsApi.loading)
  const error = coursesApi.error || classesApi.error || schoolsApi.error || (isAdmin && accountsApi.error)

  return (
    <div className="mx-auto max-w-[1500px] space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[2rem] font-semibold tracking-[-0.045em] text-text">Cursos e turmas</h1>
          <p className="mt-1.5 text-sm text-muted">Gerencie cursos, turmas e o escopo de atuação dos professores.</p>
          <CourseImportButton className="mt-3" schools={schools} onImported={course => { setStatusFilter('active'); setSelectedCourseId(course.id); refresh() }} />
        </div>
        {isAdmin && <div className="flex gap-2"><Button variant="secondary" icon={Plus} onClick={openNewCourse}>Novo curso</Button><Button icon={Plus} disabled={!selectedCourse || isDeleted(selectedCourse)} onClick={() => setClassForm({ mode: 'create', name: '', period: 'Manhã', registrationEnabled: true, periodoLetivoId: '', periodoLetivoInicial: '', attendanceConfig: { toleranciaMin: 10, limiarRiscoPct: 75, grade: {} } })}>Nova turma</Button></div>}
      </div>

      <PageState loading={loading} error={error} onRetry={refresh}>
        <Card><CardBody className="grid gap-3 pt-5 md:grid-cols-2 xl:grid-cols-[2fr_1fr_1fr_1fr_auto]">
          <label className="relative"><span className="sr-only">Buscar</span><Search size={17} className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle" /><input className="h-[38px] w-full rounded-md border border-border bg-surface pl-10 pr-3 text-sm text-text" placeholder="Buscar curso ou turma" value={search} onChange={event => setSearch(event.target.value)} /></label>
          <select aria-label="Filtrar por escola" className="h-[38px] rounded-md border border-border bg-surface px-3 text-sm text-text" value={schoolFilter} onChange={event => setSchoolFilter(event.target.value)}><option value="">Todas as escolas</option>{schools.map(school => <option key={school.id} value={school.id}>{school.name}</option>)}</select>
          <select aria-label="Filtrar por professor" className="h-[38px] rounded-md border border-border bg-surface px-3 text-sm text-text" value={professorFilter} onChange={event => setProfessorFilter(event.target.value)}><option value="">Todos os professores</option>{professors.map(professor => <option key={professor.email} value={professor.email}>{professor.name}</option>)}</select>
          <select aria-label="Filtrar por status" className="h-[38px] rounded-md border border-border bg-surface px-3 text-sm text-text" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="active">Ativos</option><option value="deleted">Excluídos</option><option value="all">Todos os status</option></select>
          <label className="flex h-[38px] items-center gap-2 whitespace-nowrap text-sm text-text"><input type="checkbox" checked={onlyUnassigned} onChange={event => setOnlyUnassigned(event.target.checked)} /> Somente sem professor</label>
        </CardBody></Card>

        <div className="grid gap-5 lg:grid-cols-[minmax(270px,0.8fr)_minmax(0,2fr)]">
          <Card className="h-fit"><CardBody className="pt-5">
            <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold text-text">Cursos por escola</h2><Badge tone="neutral">{filteredCourses.length}</Badge></div>
            {filteredCourses.length === 0 ? <EmptyState icon={BookOpen} title="Nenhum curso" description="Ajuste os filtros ou crie um curso." /> : (
              <div className="space-y-2">{filteredCourses.map(course => {
                const school = schools.find(item => item.id === course.schoolId)
                return <button key={course.id} onClick={() => setSelectedCourseId(course.id)} className={`w-full rounded-lg border p-3 text-left transition ${selectedCourse?.id === course.id ? 'border-primary bg-primary/10' : 'border-border hover:bg-surface-2'}`}>
                  <span className="block text-xs text-subtle">{school?.name || 'Sem escola'}</span>
                  <span className="mt-1 block font-medium text-text">{course.name}</span>
                  <span className="mt-1 block text-xs text-muted">{course.stats?.classCount || 0} turma(s) · {course.stats?.studentCount || 0} aluno(s)</span>
                </button>
              })}</div>
            )}
          </CardBody></Card>

          {!selectedCourse ? <Card><CardBody className="pt-5"><EmptyState icon={School} title="Selecione um curso" description="Os detalhes e as turmas aparecerão aqui." /></CardBody></Card> : (
            <div className="space-y-5">
              <Card><CardBody className="space-y-5 pt-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div><div className="flex items-center gap-2"><h2 className="text-xl font-semibold text-text">{selectedCourse.name}</h2>{isDeleted(selectedCourse) && <Badge tone="warning">Excluído</Badge>}</div><p className="mt-1 flex items-center gap-1.5 text-sm text-muted"><Building2 size={15} /> {selectedSchool?.name || 'Sem escola vinculada'}</p></div>
                  {(isAdmin || canSeeCriteria) && <div className="flex flex-wrap gap-2">{isAdmin && (isDeleted(selectedCourse) ? <Button size="sm" icon={RotateCcw} onClick={() => run(() => api.put(`/api/admin/courses/${encodeURIComponent(selectedCourse.id)}`, { status: 'active', deleted: false, deletedAt: null }), 'Curso restaurado.')}>Restaurar</Button> : <><Button size="sm" variant="secondary" icon={Pencil} onClick={openEditCourse}>Editar</Button><Button size="sm" variant="secondary" icon={BookOpen} onClick={() => setDisciplinasForm(selectedCourse)}>Disciplinas</Button><Button size="sm" variant="secondary" icon={BookCopy} onClick={openCloneCourse}>Duplicar</Button><Button size="sm" variant="secondary" icon={Archive} onClick={() => setConfirm({ type: 'archive', target: selectedCourse })}>Arquivar</Button><Button size="sm" variant="destructive" icon={Trash2} onClick={() => setConfirm({ type: 'course', target: selectedCourse })}>Excluir</Button></>)}{canSeeCriteria && !isDeleted(selectedCourse) && <Button size="sm" variant="secondary" icon={ClipboardList} onClick={() => setCriteriaCourse(selectedCourse)}>Critérios de avaliação</Button>}</div>}
                </div>

                {!isDeleted(selectedCourse) && <CourseExportButton course={selectedCourse} />}
                <div className="border-t border-border pt-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-semibold text-text">Professores do curso</h3><p className="text-xs text-subtle">A etiqueta mostra se o acesso vem da escola, do curso ou de turma específica.</p></div>{isAdmin && !isDeleted(selectedCourse) && <Button size="sm" icon={UserPlus} onClick={() => openAssignments()}>Atribuir professor</Button>}</div>
                  {courseProfessors.length === 0 ? <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted">Nenhum professor atribuído.</p> : <div className="grid gap-2 md:grid-cols-2">{courseProfessors.map(professor => <button key={professor.email} disabled={!isAdmin || isDeleted(selectedCourse)} onClick={() => openAssignments(professor.email)} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-left hover:bg-surface-2 disabled:cursor-default"><span><span className="block text-sm font-medium text-text">{professor.name}</span><span className="text-xs text-subtle">{professor.email}</span></span><OriginBadges sources={teacherSources(professor, selectedCourse)} /></button>)}</div>}
                </div>
              </CardBody></Card>

              <Card><CardBody className="pt-5">
                <div className="mb-4 flex items-center justify-between"><div><h3 className="font-semibold text-text">Turmas</h3><p className="text-xs text-subtle">Turno, período letivo, matrículas e equipe por turma.</p></div><Badge tone="neutral">{selectedClasses.length}</Badge></div>
                {selectedClasses.length === 0 ? <EmptyState icon={School} title="Nenhuma turma" description="Crie a primeira turma deste curso." /> : <div className="space-y-3">{selectedClasses.map(cls => {
                  const classProfessors = professors.filter(professor => teacherSources(professor, selectedCourse, cls.name).length > 0)
                  // A lista de contas só vem para o administrador; as outras contas usam a
                  // contagem que o servidor manda com a turma (antes aparecia "0 professor(es)").
                  const professorTotal = isAdmin ? classProfessors.length : Number(cls.professorCount || 0)
                  const term = classTerm(cls)
                  // Sem período letivo: aviso só quando há período aberto que serve a esta
                  // turma (há o que ligar); senão é só a informação (D17: nada é ligado sozinho).
                  const canLink = !term && termOptionsForCourse(periodos, selectedCourse).length > 0
                  return <div key={`${cls.courseId}-${cls.name}`} className="rounded-lg border border-border p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="font-semibold text-text">{cls.name}</h4><p className="text-sm text-muted">{cls.period ? canonicalClassPeriod(cls.period) : 'Sem turno'}</p></div><div className="flex flex-wrap items-center gap-2">{term ? <Badge tone={term.situacao === 'encerrado' ? 'neutral' : 'info'}>{term.situacao === 'encerrado' ? `${term.nome} · encerrado` : term.nome}</Badge> : <Badge tone={canLink ? 'warning' : 'neutral'}>Sem período letivo</Badge>}{cls.encerrada && <Badge tone="warning">Encerrada</Badge>}<Badge tone={cls.registrationEnabled ? 'success' : 'neutral'}>{cls.registrationEnabled ? 'Matrícula aberta' : 'Matrícula fechada'}</Badge><Badge tone="neutral">{cls.studentCount || 0} aluno(s)</Badge><Badge tone={professorTotal ? 'info' : 'warning'}>{professorTotal} professor(es)</Badge></div></div>
                    <div className="mt-3 flex flex-wrap gap-2">{professorTotal === 0 ? <span className="text-xs text-warning">Sem professor</span> : classProfessors.map(professor => <span key={professor.email} className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-xs text-text">{professor.name}<span className="text-subtle">· {teacherSources(professor, selectedCourse, cls.name)[0]}</span></span>)}</div>
                    {cls.encerrada && cls.encerramento?.em && <p className="mt-2 text-xs text-subtle">Encerrada em {new Date(cls.encerramento.em).toLocaleDateString('pt-BR')}{cls.encerramento.por ? ` por ${cls.encerramento.por}` : ''}: notas, chamada, provas e matrícula nova ficam travadas até reabrir.</p>}
                    {(isAdmin || canGroups || canPreview || canCloseClasses) && !isDeleted(selectedCourse) && <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">{canGroups && <Button size="sm" variant="secondary" icon={UsersRound} aria-label={`Grupos da turma ${cls.name}`} onClick={() => navigate(groupsPath(selectedCourse.id, cls.name), { state: { voltar: '/turmas' } })}>Grupos</Button>}<PreviewButton courseId={selectedCourse.id} studentClass={cls.name} courseName={selectedCourse.name} />{isAdmin && <><Button size="sm" variant="secondary" className="border-primary/60 bg-primary/10 text-primary hover:bg-primary/20 hover:border-primary" icon={Wand2} aria-label={`Abrir assistente de horários da turma ${cls.name}`} onClick={() => navigate(`/turmas/${encodeURIComponent(selectedCourse.id)}/${encodeURIComponent(cls.name)}/assistente`)}>Assistente de horários</Button><Button size="sm" variant="secondary" icon={Users} aria-label={`Atribuir professor à turma ${cls.name}`} onClick={() => openAssignments()}>Atribuir</Button><Button size="sm" variant="ghost" icon={Pencil} aria-label={`Editar turma ${cls.name}`} onClick={() => setClassForm({ mode: 'edit', name: cls.name, period: canonicalClassPeriod(cls.period), registrationEnabled: cls.registrationEnabled !== false, periodoLetivoId: cls.periodoLetivoId || '', periodoLetivoInicial: cls.periodoLetivoId || '', attendanceConfig: cls.attendanceConfig || { toleranciaMin: 10, limiarRiscoPct: 75, grade: {} } })}>Editar</Button>{!cls.encerrada && <Button size="sm" variant="ghost" icon={Trash2} aria-label={`Excluir turma ${cls.name}`} onClick={() => setConfirm({ type: 'class', target: cls })}>Excluir</Button>}</>}{canCloseClasses && (cls.encerrada
                      ? <Button size="sm" variant="secondary" icon={LockOpen} aria-label={`Reabrir turma ${cls.name}`} onClick={() => setClosure({ mode: 'reopen', targets: [{ courseId: selectedCourse.id, courseName: selectedCourse.name, name: cls.name }] })}>Reabrir turma</Button>
                      : <Button size="sm" variant="ghost" icon={Lock} aria-label={`Encerrar turma ${cls.name}`} onClick={() => setClosure({ mode: 'close', targets: [{ courseId: selectedCourse.id, courseName: selectedCourse.name, name: cls.name }] })}>Encerrar turma</Button>)}</div>}
                  </div>
                })}</div>}
              </CardBody></Card>
            </div>
          )}
        </div>

        <AcademicTermsSection termsApi={termsApi} course={selectedCourse} onChanged={() => Promise.all([coursesApi.refetch(), classesApi.refetch()])}
          canCloseClasses={canCloseClasses} classes={classes} onCloseClasses={targets => setClosure({ mode: 'close', targets })} />

        {isAdmin && (archivedApi.data || []).length > 0 && <Card><CardBody className="pt-5"><div className="mb-3 flex items-center gap-2"><Archive size={18} className="text-muted" /><h2 className="font-semibold text-text">Cursos arquivados</h2></div><div className="space-y-2">{archivedApi.data.map(item => <div key={item.folder} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"><span><span className="block text-sm font-medium text-text">{item.name}</span><span className="text-xs text-subtle">{item.counts?.turmas || 0} turma(s) · arquivado em {new Date(item.archivedAt).toLocaleDateString('pt-BR')}</span></span><span className="flex gap-2"><Button size="sm" variant="secondary" icon={RotateCcw} onClick={() => run(() => api.post('/api/admin/archived-courses/restore', { folder: item.folder }, { timeoutMs: 0 }), 'Curso restaurado do arquivo.')}>Restaurar</Button><Button size="sm" variant="ghost" icon={Trash2} onClick={() => setConfirm({ type: 'archive-delete', target: item })}>Excluir arquivo</Button></span></div>)}</div></CardBody></Card>}
      </PageState>

      <Modal open={!!courseForm} onClose={() => setCourseForm(null)} title={courseForm?.mode === 'edit' ? 'Editar curso' : courseForm?.mode === 'clone' ? 'Duplicar curso' : 'Novo curso'} description="Defina a escola responsável e os dados do curso." footer={<><Button variant="ghost" onClick={() => setCourseForm(null)}>Cancelar</Button><Button loading={saving} onClick={saveCourse}>Salvar</Button></>}>
        {courseForm && <div className="space-y-4">{courseForm.mode !== 'edit' && <Input label="Código do curso" value={courseForm.id} onChange={event => setCourseForm({ ...courseForm, id: event.target.value })} placeholder="EX.: DES" />}<Input label="Nome" value={courseForm.name} onChange={event => setCourseForm({ ...courseForm, name: event.target.value })} /><Input label="Descrição" value={courseForm.description} onChange={event => setCourseForm({ ...courseForm, description: event.target.value })} /><Select label="Escola" value={courseForm.schoolId} onChange={event => setCourseForm({ ...courseForm, schoolId: event.target.value })}><option value="">Selecione</option>{schools.map(school => <option key={school.id} value={school.id}>{school.name}</option>)}</Select>{courseForm.mode !== 'clone' && <div className="space-y-1"><Switch id="curso-permitir-impressao" checked={courseForm.permitirImpressao !== false} onChange={value => setCourseForm({ ...courseForm, permitirImpressao: value })} label="Alunos podem imprimir ou salvar a apostila em PDF" /><p className="text-xs text-muted">Desligado, o botão "Imprimir ou salvar em PDF" some do leitor e a impressão da apostila sai só com "Impressão desativada pela escola.". A folha impressa leva o nome da escola e do curso.</p></div>}</div>}
      </Modal>

      <Modal open={!!classForm} onClose={() => setClassForm(null)} size="lg" title={classForm?.mode === 'edit' ? 'Editar turma' : 'Nova turma'} description={selectedCourse?.name} footer={<><Button variant="ghost" onClick={() => setClassForm(null)}>Cancelar</Button><Button loading={saving} onClick={saveClass}>Salvar</Button></>}>
        {classForm && <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Nome da turma" disabled={classForm.mode === 'edit'} value={classForm.name} onChange={event => setClassForm(current => ({ ...current, name: event.target.value }))} placeholder="EX.: 1DES" />
            <Select label="Turno" value={classForm.period} onChange={event => setClassForm(current => ({ ...current, period: event.target.value }))}>{CLASS_PERIODS.map(period => <option key={period} value={period}>{period}</option>)}</Select>
          </div>
          <ClassTermField form={classForm} setForm={setClassForm} termsApi={termsApi} course={selectedCourse} />
          {classForm.mode === 'edit' && <label className="flex items-center gap-2 text-sm text-text"><input type="checkbox" checked={classForm.registrationEnabled} onChange={event => setClassForm(current => ({ ...current, registrationEnabled: event.target.checked }))} /> Matrículas abertas</label>}
          <div className="border-t border-border pt-4">
            <h3 className="mb-3 font-semibold text-text">Presença e grade horária</h3>
            <GradeEditor config={classForm.attendanceConfig} disciplinas={selectedCourse?.disciplinas || []} onChange={cfg => setClassForm(current => ({ ...current, attendanceConfig: cfg }))} />
          </div>
        </div>}
      </Modal>

      <ClassClosureDialog open={!!closure} mode={closure?.mode} targets={closure?.targets || []} onClose={() => setClosure(null)}
        onDone={() => Promise.all([classesApi.refetch(), termsApi.refetch()])} />

      <GradingCriteriaDialog open={!!criteriaCourse} onClose={() => setCriteriaCourse(null)} course={criteriaCourse} />

      <DisciplinasModal open={!!disciplinasForm} onClose={() => setDisciplinasForm(null)} course={disciplinasForm} onSave={saveDisciplinas} saving={saving} />

      <Modal open={!!assignmentForm} onClose={() => setAssignmentForm(null)} title="Atribuir professor" description="Vínculos amplos são herdados por turmas atuais e futuras. Vínculos específicos permanecem separados." size="lg" footer={<><Button variant="ghost" onClick={() => setAssignmentForm(null)}>Cancelar</Button><Button loading={saving} onClick={saveAssignments}>Salvar atribuições</Button></>}>
        {assignmentForm && <div className="space-y-5"><Select label="Professor" value={assignmentForm.professorEmail} onChange={event => changeAssignmentProfessor(event.target.value)}>{professors.map(professor => <option key={professor.email} value={professor.email}>{professor.name} — {professor.email}</option>)}</Select><div className="grid gap-3 md:grid-cols-2"><label className="rounded-lg border border-border p-4"><span className="flex items-center gap-2 font-medium text-text"><input type="checkbox" checked={assignmentForm.school} onChange={event => setAssignmentForm({ ...assignmentForm, school: event.target.checked })} /> Escola inteira</span><span className="mt-1 block text-xs text-subtle">Todos os cursos e turmas atuais e futuros de {selectedSchool?.name}.</span></label><label className="rounded-lg border border-border p-4"><span className="flex items-center gap-2 font-medium text-text"><input type="checkbox" checked={assignmentForm.course} onChange={event => setAssignmentForm({ ...assignmentForm, course: event.target.checked })} /> Curso inteiro</span><span className="mt-1 block text-xs text-subtle">Todas as turmas atuais e futuras de {selectedCourse?.name}.</span></label></div><div><h3 className="font-medium text-text">Turmas específicas</h3><p className="mb-3 text-xs text-subtle">As marcações diretas são preservadas mesmo ao adicionar ou remover um vínculo amplo.</p><div className="grid gap-2 md:grid-cols-2">{selectedClasses.map(cls => { const inherited = assignmentForm.school || assignmentForm.course; const checked = assignmentForm.classes.includes(cls.name); return <label key={cls.name} className={`flex items-center justify-between rounded-lg border border-border p-3 ${inherited ? 'opacity-70' : ''}`}><span className="flex items-center gap-2 text-sm text-text"><input type="checkbox" disabled={inherited} checked={checked} onChange={event => setAssignmentForm({ ...assignmentForm, classes: event.target.checked ? [...assignmentForm.classes, cls.name] : assignmentForm.classes.filter(name => name !== cls.name) })} /> {cls.name}</span>{inherited && <Badge tone="info">Acesso herdado</Badge>}</label>})}{selectedClasses.length === 0 && <p className="text-sm text-muted">O curso ainda não possui turmas.</p>}</div></div></div>}
      </Modal>

      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} onConfirm={executeConfirm} danger={confirm?.type !== 'archive'} title={confirm?.type === 'class' ? 'Excluir turma?' : confirm?.type === 'archive' ? 'Arquivar curso?' : confirm?.type === 'archive-delete' ? 'Excluir arquivo definitivamente?' : 'Excluir curso?'} description={confirm?.type === 'archive' ? 'Será criado um pacote restaurável com curso, turmas, tarefas, entregas e dados relacionados. Os arquivos das entregas continuam neste computador e voltam com o curso.' : confirm?.type === 'course' ? undefined : confirm?.type === 'archive-delete' ? 'O pacote do curso é apagado. Os arquivos dos trabalhos entregues vão para a lixeira de arquivos (Sistema, cartão Lixeira).' : 'Confirme a operação.'} note={confirm?.type === 'course' ? 'O curso ficará desativado e poderá ser restaurado.' : undefined} confirmLabel={confirm?.type === 'archive' ? 'Arquivar' : 'Excluir'} />
    </div>
  )
}
