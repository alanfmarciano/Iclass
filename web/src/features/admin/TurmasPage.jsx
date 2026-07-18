import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Archive, BookCopy, BookOpen, Building2, Pencil, Plus, RotateCcw, Search, School, Trash2, UserPlus, Users, Wand2 } from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Card, CardBody } from '../../components/ui/Card'
import { ConfirmDialog, Modal } from '../../components/ui/Modal'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import { PageState } from '../../components/ui/PageState'
import { EmptyState } from '../../components/ui/EmptyState'
import { useApi } from '../../hooks/useApi'
import { api } from '../../lib/api'
import { useAuth } from '../../context/AuthProvider'
import { useToast } from '../../context/ToastProvider'
import { DisciplinasModal, GradeEditor } from './TurmaPresencaConfig'

const CLASS_PERIODS = ['Manhã', 'Tarde', 'Noite']

function isDeleted(course) {
  return course?.deleted === true || course?.status === 'deleted' || course?.status === 'inactive' || !!course?.deletedAt
}

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

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

export default function TurmasPage() {
  const { auth } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()
  const isAdmin = auth.accountRole !== 'professor'
  const coursesApi = useApi('/api/admin/course-summaries?includeDeleted=1')
  const classesApi = useApi('/api/admin/classes')
  const schoolsApi = useApi('/api/admin/schools')
  const accountsApi = useApi(isAdmin ? '/api/admin/accounts' : null)
  const archivedApi = useApi(isAdmin ? '/api/admin/archived-courses' : null)
  const [search, setSearch] = useState('')
  const [schoolFilter, setSchoolFilter] = useState('')
  const [professorFilter, setProfessorFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('active')
  const [onlyUnassigned, setOnlyUnassigned] = useState(false)
  const [selectedCourseId, setSelectedCourseId] = useState('')
  const [courseForm, setCourseForm] = useState(null)
  const [classForm, setClassForm] = useState(null)
  const [disciplinasForm, setDisciplinasForm] = useState(null)
  const [assignmentForm, setAssignmentForm] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const [saving, setSaving] = useState(false)

  const courses = coursesApi.data || []
  const classes = classesApi.data || []
  const schools = schoolsApi.data || []
  const professors = (accountsApi.data || []).filter(account => account.role === 'professor')

  const filteredCourses = useMemo(() => courses.filter(course => {
    const courseClasses = classes.filter(cls => cls.courseId === course.id)
    const school = schools.find(item => item.id === course.schoolId)
    const query = normalize(search)
    if (statusFilter === 'active' && isDeleted(course)) return false
    if (statusFilter === 'deleted' && !isDeleted(course)) return false
    if (schoolFilter && course.schoolId !== schoolFilter) return false
    if (professorFilter) {
      const professor = professors.find(item => item.email === professorFilter)
      if (!professor || !hasCourseAccess(professor, course)) return false
    }
    if (onlyUnassigned && !courseClasses.some(cls => Number(cls.professorCount || 0) === 0)) return false
    if (query && !normalize(`${course.name} ${course.id} ${course.description || ''} ${school?.name || ''} ${courseClasses.map(cls => cls.name).join(' ')}`).includes(query)) return false
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
    await Promise.all([coursesApi.refetch(), classesApi.refetch(), schoolsApi.refetch(), accountsApi.refetch(), archivedApi.refetch()])
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

  const openNewCourse = () => setCourseForm({ mode: 'create', id: '', name: '', description: '', schoolId: schools[0]?.id || '' })
  const openEditCourse = () => setCourseForm({ mode: 'edit', id: selectedCourse.id, name: selectedCourse.name || '', description: selectedCourse.description || '', schoolId: selectedCourse.schoolId || '' })
  const openCloneCourse = () => setCourseForm({ mode: 'clone', sourceId: selectedCourse.id, id: `${selectedCourse.id}_COPIA`, name: `${selectedCourse.name} (cópia)`, description: selectedCourse.description || '', schoolId: selectedCourse.schoolId || '' })

  async function saveCourse() {
    const form = courseForm
    if (!form.name?.trim() || !form.schoolId || (form.mode !== 'edit' && !form.id?.trim())) return toast.error('Informe os dados obrigatórios do curso.')
    const ok = await run(async () => {
      if (form.mode === 'create') {
        const result = await api.post('/api/courses', { id: form.id.trim().toUpperCase(), name: form.name.trim(), description: form.description?.trim(), schoolId: form.schoolId, structure: [] })
        setSelectedCourseId(result.course.id)
      } else if (form.mode === 'edit') {
        await api.put(`/api/courses/${encodeURIComponent(form.id)}`, { name: form.name.trim(), description: form.description?.trim(), schoolId: form.schoolId })
      } else {
        const result = await api.post(`/api/admin/courses/${encodeURIComponent(form.sourceId)}/clone`, { newId: form.id.trim().toUpperCase(), newName: form.name.trim(), schoolId: form.schoolId })
        setSelectedCourseId(result.course.id)
      }
    }, form.mode === 'clone' ? 'Curso duplicado.' : form.mode === 'edit' ? 'Curso atualizado.' : 'Curso criado.')
    if (ok) setCourseForm(null)
  }

  async function saveClass() {
    if (!classForm?.name?.trim() || !CLASS_PERIODS.includes(classForm?.period)) return toast.error('Informe o nome e selecione Manhã, Tarde ou Noite.')
    const attendanceConfig = classForm.attendanceConfig || { toleranciaMin: 10, limiarRiscoPct: 75, grade: {} }
    const ok = await run(() => classForm.mode === 'create'
      ? api.post('/api/admin/class/create', { name: classForm.name, period: classForm.period, courseId: selectedCourse.id, attendanceConfig })
      : api.post('/api/admin/class/update', { name: classForm.name, period: classForm.period, registrationEnabled: classForm.registrationEnabled, courseId: selectedCourse.id, attendanceConfig }),
    classForm.mode === 'create' ? 'Turma criada.' : 'Turma atualizada.')
    if (ok) setClassForm(null)
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
    if (current.type === 'course') ok = await run(() => api.delete(`/api/courses/${encodeURIComponent(current.target.id)}`), 'Curso excluído e preservado para restauração.')
    if (current.type === 'archive') ok = await run(() => api.post(`/api/admin/courses/${encodeURIComponent(current.target.id)}/purge`, {}), 'Curso arquivado com segurança.')
    if (current.type === 'archive-delete') ok = await run(() => api.post('/api/admin/archived-courses/delete', { folder: current.target.folder }), 'Arquivo excluído definitivamente.')
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
        </div>
        {isAdmin && <div className="flex gap-2"><Button variant="secondary" icon={Plus} onClick={openNewCourse}>Novo curso</Button><Button icon={Plus} disabled={!selectedCourse || isDeleted(selectedCourse)} onClick={() => setClassForm({ mode: 'create', name: '', period: 'Manhã', registrationEnabled: true, attendanceConfig: { toleranciaMin: 10, limiarRiscoPct: 75, grade: {} } })}>Nova turma</Button></div>}
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
                  {isAdmin && <div className="flex flex-wrap gap-2">{isDeleted(selectedCourse) ? <Button size="sm" icon={RotateCcw} onClick={() => run(() => api.put(`/api/courses/${encodeURIComponent(selectedCourse.id)}`, { status: 'active', deleted: false, deletedAt: null }), 'Curso restaurado.')}>Restaurar</Button> : <><Button size="sm" variant="secondary" icon={Pencil} onClick={openEditCourse}>Editar</Button><Button size="sm" variant="secondary" icon={BookOpen} onClick={() => setDisciplinasForm(selectedCourse)}>Disciplinas</Button><Button size="sm" variant="secondary" icon={BookCopy} onClick={openCloneCourse}>Duplicar</Button><Button size="sm" variant="secondary" icon={Archive} onClick={() => setConfirm({ type: 'archive', target: selectedCourse })}>Arquivar</Button><Button size="sm" variant="destructive" icon={Trash2} onClick={() => setConfirm({ type: 'course', target: selectedCourse })}>Excluir</Button></>}</div>}
                </div>

                <div className="border-t border-border pt-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-semibold text-text">Professores do curso</h3><p className="text-xs text-subtle">A etiqueta mostra se o acesso vem da escola, do curso ou de turma específica.</p></div>{isAdmin && !isDeleted(selectedCourse) && <Button size="sm" icon={UserPlus} onClick={() => openAssignments()}>Atribuir professor</Button>}</div>
                  {courseProfessors.length === 0 ? <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted">Nenhum professor atribuído.</p> : <div className="grid gap-2 md:grid-cols-2">{courseProfessors.map(professor => <button key={professor.email} disabled={!isAdmin || isDeleted(selectedCourse)} onClick={() => openAssignments(professor.email)} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-left hover:bg-surface-2 disabled:cursor-default"><span><span className="block text-sm font-medium text-text">{professor.name}</span><span className="text-xs text-subtle">{professor.email}</span></span><OriginBadges sources={teacherSources(professor, selectedCourse)} /></button>)}</div>}
                </div>
              </CardBody></Card>

              <Card><CardBody className="pt-5">
                <div className="mb-4 flex items-center justify-between"><div><h3 className="font-semibold text-text">Turmas</h3><p className="text-xs text-subtle">Período, matrículas e equipe por turma.</p></div><Badge tone="neutral">{selectedClasses.length}</Badge></div>
                {selectedClasses.length === 0 ? <EmptyState icon={School} title="Nenhuma turma" description="Crie a primeira turma deste curso." /> : <div className="space-y-3">{selectedClasses.map(cls => {
                  const classProfessors = professors.filter(professor => teacherSources(professor, selectedCourse, cls.name).length > 0)
                  return <div key={`${cls.courseId}-${cls.name}`} className="rounded-lg border border-border p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="font-semibold text-text">{cls.name}</h4><p className="text-sm text-muted">{cls.period ? canonicalClassPeriod(cls.period) : 'Sem período'}</p></div><div className="flex flex-wrap items-center gap-2"><Badge tone={cls.registrationEnabled ? 'success' : 'neutral'}>{cls.registrationEnabled ? 'Matrícula aberta' : 'Matrícula fechada'}</Badge><Badge tone="neutral">{cls.studentCount || 0} aluno(s)</Badge><Badge tone={classProfessors.length ? 'info' : 'warning'}>{classProfessors.length} professor(es)</Badge></div></div>
                    <div className="mt-3 flex flex-wrap gap-2">{classProfessors.length === 0 ? <span className="text-xs text-warning">Sem professor</span> : classProfessors.map(professor => <span key={professor.email} className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-xs text-text">{professor.name}<span className="text-subtle">· {teacherSources(professor, selectedCourse, cls.name)[0]}</span></span>)}</div>
                    {isAdmin && !isDeleted(selectedCourse) && <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3"><Button size="sm" variant="secondary" className="border-primary/60 bg-primary/10 text-primary hover:bg-primary/20 hover:border-primary" icon={Wand2} aria-label={`Abrir assistente de horários da turma ${cls.name}`} onClick={() => navigate(`/turmas/${encodeURIComponent(selectedCourse.id)}/${encodeURIComponent(cls.name)}/assistente`)}>Assistente de horários</Button><Button size="sm" variant="secondary" icon={Users} aria-label={`Atribuir professor à turma ${cls.name}`} onClick={() => openAssignments()}>Atribuir</Button><Button size="sm" variant="ghost" icon={Pencil} aria-label={`Editar turma ${cls.name}`} onClick={() => setClassForm({ mode: 'edit', name: cls.name, period: canonicalClassPeriod(cls.period), registrationEnabled: cls.registrationEnabled !== false, attendanceConfig: cls.attendanceConfig || { toleranciaMin: 10, limiarRiscoPct: 75, grade: {} } })}>Editar</Button><Button size="sm" variant="ghost" icon={Trash2} aria-label={`Excluir turma ${cls.name}`} onClick={() => setConfirm({ type: 'class', target: cls })}>Excluir</Button></div>}
                  </div>
                })}</div>}
              </CardBody></Card>
            </div>
          )}
        </div>

        {isAdmin && (archivedApi.data || []).length > 0 && <Card><CardBody className="pt-5"><div className="mb-3 flex items-center gap-2"><Archive size={18} className="text-muted" /><h2 className="font-semibold text-text">Cursos arquivados</h2></div><div className="space-y-2">{archivedApi.data.map(item => <div key={item.folder} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"><span><span className="block text-sm font-medium text-text">{item.name}</span><span className="text-xs text-subtle">{item.counts?.turmas || 0} turma(s) · arquivado em {new Date(item.archivedAt).toLocaleDateString('pt-BR')}</span></span><span className="flex gap-2"><Button size="sm" variant="secondary" icon={RotateCcw} onClick={() => run(() => api.post('/api/admin/archived-courses/restore', { folder: item.folder }), 'Curso restaurado do arquivo.')}>Restaurar</Button><Button size="sm" variant="ghost" icon={Trash2} onClick={() => setConfirm({ type: 'archive-delete', target: item })}>Excluir arquivo</Button></span></div>)}</div></CardBody></Card>}
      </PageState>

      <Modal open={!!courseForm} onClose={() => setCourseForm(null)} title={courseForm?.mode === 'edit' ? 'Editar curso' : courseForm?.mode === 'clone' ? 'Duplicar curso' : 'Novo curso'} description="Defina a escola responsável e os dados do curso." footer={<><Button variant="ghost" onClick={() => setCourseForm(null)}>Cancelar</Button><Button loading={saving} onClick={saveCourse}>Salvar</Button></>}>
        {courseForm && <div className="space-y-4">{courseForm.mode !== 'edit' && <Input label="Código do curso" value={courseForm.id} onChange={event => setCourseForm({ ...courseForm, id: event.target.value })} placeholder="EX.: DES" />}<Input label="Nome" value={courseForm.name} onChange={event => setCourseForm({ ...courseForm, name: event.target.value })} /><Input label="Descrição" value={courseForm.description} onChange={event => setCourseForm({ ...courseForm, description: event.target.value })} /><Select label="Escola" value={courseForm.schoolId} onChange={event => setCourseForm({ ...courseForm, schoolId: event.target.value })}><option value="">Selecione</option>{schools.map(school => <option key={school.id} value={school.id}>{school.name}</option>)}</Select></div>}
      </Modal>

      <Modal open={!!classForm} onClose={() => setClassForm(null)} size="lg" title={classForm?.mode === 'edit' ? 'Editar turma' : 'Nova turma'} description={selectedCourse?.name} footer={<><Button variant="ghost" onClick={() => setClassForm(null)}>Cancelar</Button><Button loading={saving} onClick={saveClass}>Salvar</Button></>}>
        {classForm && <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Nome da turma" disabled={classForm.mode === 'edit'} value={classForm.name} onChange={event => setClassForm(current => ({ ...current, name: event.target.value }))} placeholder="EX.: 1DES" />
            <Select label="Período" value={classForm.period} onChange={event => setClassForm(current => ({ ...current, period: event.target.value }))}>{CLASS_PERIODS.map(period => <option key={period} value={period}>{period}</option>)}</Select>
          </div>
          {classForm.mode === 'edit' && <label className="flex items-center gap-2 text-sm text-text"><input type="checkbox" checked={classForm.registrationEnabled} onChange={event => setClassForm(current => ({ ...current, registrationEnabled: event.target.checked }))} /> Matrículas abertas</label>}
          <div className="border-t border-border pt-4">
            <h3 className="mb-3 font-semibold text-text">Presença e grade horária</h3>
            <GradeEditor config={classForm.attendanceConfig} disciplinas={selectedCourse?.disciplinas || []} onChange={cfg => setClassForm(current => ({ ...current, attendanceConfig: cfg }))} />
          </div>
        </div>}
      </Modal>

      <DisciplinasModal open={!!disciplinasForm} onClose={() => setDisciplinasForm(null)} course={disciplinasForm} onSave={saveDisciplinas} saving={saving} />

      <Modal open={!!assignmentForm} onClose={() => setAssignmentForm(null)} title="Atribuir professor" description="Vínculos amplos são herdados por turmas atuais e futuras. Vínculos específicos permanecem separados." size="lg" footer={<><Button variant="ghost" onClick={() => setAssignmentForm(null)}>Cancelar</Button><Button loading={saving} onClick={saveAssignments}>Salvar atribuições</Button></>}>
        {assignmentForm && <div className="space-y-5"><Select label="Professor" value={assignmentForm.professorEmail} onChange={event => changeAssignmentProfessor(event.target.value)}>{professors.map(professor => <option key={professor.email} value={professor.email}>{professor.name} — {professor.email}</option>)}</Select><div className="grid gap-3 md:grid-cols-2"><label className="rounded-lg border border-border p-4"><span className="flex items-center gap-2 font-medium text-text"><input type="checkbox" checked={assignmentForm.school} onChange={event => setAssignmentForm({ ...assignmentForm, school: event.target.checked })} /> Escola inteira</span><span className="mt-1 block text-xs text-subtle">Todos os cursos e turmas atuais e futuros de {selectedSchool?.name}.</span></label><label className="rounded-lg border border-border p-4"><span className="flex items-center gap-2 font-medium text-text"><input type="checkbox" checked={assignmentForm.course} onChange={event => setAssignmentForm({ ...assignmentForm, course: event.target.checked })} /> Curso inteiro</span><span className="mt-1 block text-xs text-subtle">Todas as turmas atuais e futuras de {selectedCourse?.name}.</span></label></div><div><h3 className="font-medium text-text">Turmas específicas</h3><p className="mb-3 text-xs text-subtle">As marcações diretas são preservadas mesmo ao adicionar ou remover um vínculo amplo.</p><div className="grid gap-2 md:grid-cols-2">{selectedClasses.map(cls => { const inherited = assignmentForm.school || assignmentForm.course; const checked = assignmentForm.classes.includes(cls.name); return <label key={cls.name} className={`flex items-center justify-between rounded-lg border border-border p-3 ${inherited ? 'opacity-70' : ''}`}><span className="flex items-center gap-2 text-sm text-text"><input type="checkbox" disabled={inherited} checked={checked} onChange={event => setAssignmentForm({ ...assignmentForm, classes: event.target.checked ? [...assignmentForm.classes, cls.name] : assignmentForm.classes.filter(name => name !== cls.name) })} /> {cls.name}</span>{inherited && <Badge tone="info">Acesso herdado</Badge>}</label>})}{selectedClasses.length === 0 && <p className="text-sm text-muted">O curso ainda não possui turmas.</p>}</div></div></div>}
      </Modal>

      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} onConfirm={executeConfirm} danger={confirm?.type !== 'archive'} title={confirm?.type === 'class' ? 'Excluir turma?' : confirm?.type === 'archive' ? 'Arquivar curso?' : confirm?.type === 'archive-delete' ? 'Excluir arquivo definitivamente?' : 'Excluir curso?'} description={confirm?.type === 'archive' ? 'Será criado um pacote restaurável com curso, turmas e dados relacionados.' : confirm?.type === 'course' ? 'O curso ficará desativado e poderá ser restaurado.' : 'Confirme a operação.'} confirmLabel={confirm?.type === 'archive' ? 'Arquivar' : 'Excluir'} />
    </div>
  )
}
