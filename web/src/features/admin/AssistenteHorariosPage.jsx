import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { Card, CardBody } from '../../components/ui/Card'
import { PageHeader } from '../../components/ui/PageHeader'
import { PageState } from '../../components/ui/PageState'
import { useApi } from '../../hooks/useApi'
import { api } from '../../lib/api'
import { useAuth } from '../../context/AuthProvider'
import { useToast } from '../../context/ToastProvider'
import { AssistenteHorariosWizard } from './TurmaPresencaConfig'

export default function AssistenteHorariosPage() {
  const { courseId, className } = useParams()
  const nav = useNavigate()
  const toast = useToast()
  const { auth } = useAuth()
  const isAdmin = auth.accountRole !== 'professor'
  const coursesApi = useApi('/api/admin/course-summaries?includeDeleted=1')
  const classesApi = useApi('/api/admin/classes')
  const accountsApi = useApi(isAdmin ? '/api/admin/accounts' : null)
  const [saving, setSaving] = useState(false)

  const wantedCourseId = decodeURIComponent(courseId || '')
  const wantedClassName = decodeURIComponent(className || '')
  const course = (coursesApi.data || []).find(item => String(item.id) === wantedCourseId) || null
  const classes = classesApi.data || []
  const turma = classes.find(item => String(item.courseId) === wantedCourseId && item.name === wantedClassName) || null
  const professors = (accountsApi.data || []).filter(account => account.role === 'professor')

  async function handleSave({ attendanceConfig, newDisciplinas, template }) {
    setSaving(true)
    try {
      if (newDisciplinas.length) {
        await api.post('/api/admin/course/disciplinas', { courseId: course.id, disciplinas: [...(course.disciplinas || []), ...newDisciplinas] })
      }
      if (template) {
        const templates = [...(course.gradeTemplates || []).filter(item => item.id !== template.id), template]
        await api.post('/api/admin/course/grade-templates', { courseId: course.id, templates })
      }
      // Envia apenas a grade: período e matrículas não são assunto do assistente.
      await api.post('/api/admin/class/update', { name: turma.name, courseId: course.id, attendanceConfig })
      toast.success('Grade horária salva.')
      nav('/turmas')
    } catch (error) {
      toast.error(error.message)
    } finally {
      setSaving(false)
    }
  }

  const loading = coursesApi.loading || classesApi.loading || (isAdmin && accountsApi.loading)
  const error = coursesApi.error || classesApi.error

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <button onClick={() => nav('/turmas')} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-text">
        <ArrowLeft size={16} />Voltar para cursos e turmas
      </button>

      <PageState loading={loading} error={error} onRetry={() => { coursesApi.refetch(); classesApi.refetch() }}>
        {!course || !turma ? (
          <Card><CardBody className="pt-5"><p className="text-sm text-muted">Turma não encontrada. Ela pode ter sido removida ou renomeada.</p></CardBody></Card>
        ) : (
          <>
            <PageHeader title="Assistente de horários" subtitle={`${course.name} · ${turma.name}`} />
            <AssistenteHorariosWizard
              key={`${course.id}::${turma.name}`}
              course={course}
              turma={turma}
              allClasses={classes}
              professors={professors}
              onSave={handleSave}
              onCancel={() => nav('/turmas')}
              saving={saving}
            />
          </>
        )}
      </PageState>
    </div>
  )
}
