import { useEffect, useState } from 'react'
import { Clock3, GraduationCap, RefreshCw, XCircle } from 'lucide-react'
import { Card, CardBody, CardHeader } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { useAuth } from '../../context/AuthProvider'
import { useToast } from '../../context/ToastProvider'
import { api } from '../../lib/api'

function classKey(cls) {
  return `${cls?.courseId || ''}|${cls?.name || ''}`
}

function sameClass(a, b) {
  return classKey(a) === classKey(b)
}

function courseForClass(courses, cls) {
  return courses.find((course) => course.id === cls.courseId) || null
}

export function StudentCourseGate({ children }) {
  const { auth, setAuth, setActiveClass } = useAuth()
  const toast = useToast()
  const [busy, setBusy] = useState(null)
  const student = auth.student || {}
  const classes = student.classes || []
  const courses = student.courses || []
  const requests = student.enrollmentRequests || []
  const pending = requests.filter((request) => request.status === 'pending')
  const rejected = requests.filter((request) => request.status === 'rejected')
  const activeClass = auth.activeClass
  const activeStillValid = activeClass && classes.some((cls) => sameClass(cls, activeClass))

  function applyPayload(payload) {
    const nextClasses = payload.classes || []
    setAuth((current) => {
      const currentActive = current.activeClass
      const activeValid = currentActive && nextClasses.some((item) => sameClass(item, currentActive))
      return {
        ...current,
        activeClass: activeValid ? currentActive : (nextClasses.length === 1 ? nextClasses[0] : null),
        student: {
          ...(current.student || {}),
          classes: nextClasses,
          courses: payload.courses || [],
          enrollmentRequests: payload.requests || [],
          studentClass: nextClasses[0]?.name || '',
        },
      }
    })
  }

  async function refresh() {
    applyPayload(await api.get('/api/student/enrollments'))
  }

  useEffect(() => {
    if (!auth.email || (classes.length > 0 && pending.length === 0)) return undefined
    refresh().catch(() => {})
    const id = setInterval(() => refresh().catch(() => {}), 5000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.email, classes.length, pending.length])

  async function cancel(request) {
    setBusy(request.id)
    try {
      await api.post('/api/student/enrollments/cancel', { id: request.id })
      await refresh()
      toast.success('Solicitação cancelada')
    } catch (error) { toast.error(error.message) } finally { setBusy(null) }
  }

  async function requestAgain(request) {
    setBusy(request.id)
    try {
      await api.post('/api/student/enrollments/request', { courseId: request.courseId, studentClass: request.requestedClassName })
      await refresh()
      toast.success('Nova solicitação enviada')
    } catch (error) { toast.error(error.message) } finally { setBusy(null) }
  }

  if (classes.length === 1 || activeStillValid) return children

  return (
    <div className="min-h-[70vh] flex items-center justify-center">
      <div className="w-full max-w-5xl space-y-5">
        <div>
          <h1 className="text-2xl font-bold text-text">{classes.length === 0 ? 'Situação da matrícula' : 'Escolha seu curso'}</h1>
          <p className="text-sm text-muted">{classes.length === 0 ? 'Acompanhe aqui a análise da sua solicitação.' : 'Selecione em qual curso e turma você quer entrar agora.'}</p>
        </div>

        {classes.length === 0 ? (
          pending.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {pending.map((request) => (
                <Card key={request.id}>
                  <CardHeader title={request.courseName || request.courseId || 'Curso'} subtitle={`Turma solicitada: ${request.requestedClassName || '-'}`} action={<Badge tone="warning">Aguardando aprovação</Badge>} />
                  <CardBody>
                    <div className="flex items-center gap-2 text-sm text-muted"><Clock3 size={16} /> Enviada em {new Date(Number(request.createdAt || Date.now())).toLocaleString('pt-BR')}</div>
                    <p className="mt-3 text-sm text-muted">A instituição está analisando sua matrícula. O acesso será liberado automaticamente após a aprovação.</p>
                    <Button className="mt-4" size="sm" variant="ghost" icon={XCircle} loading={busy === request.id} onClick={() => cancel(request)}>Cancelar solicitação</Button>
                  </CardBody>
                </Card>
              ))}
            </div>
          ) : rejected.length > 0 ? (
            <Card>
              <CardHeader title="Solicitação recusada" subtitle={rejected[0].courseName || rejected[0].courseId} action={<Badge tone="danger">Recusada</Badge>} />
              <CardBody>
                <p className="text-sm text-muted">Motivo: {rejected[0].rejectionReason || 'Não informado.'}</p>
                <Button className="mt-4" size="sm" icon={RefreshCw} loading={busy === rejected[0].id} onClick={() => requestAgain(rejected[0])}>Solicitar novamente</Button>
              </CardBody>
            </Card>
          ) : (
            <Card>
              <CardBody className="pt-5">
                <EmptyState icon={GraduationCap} title="Nenhuma matrícula ativa" description="Faça uma nova solicitação de matrícula ou procure a instituição." />
              </CardBody>
            </Card>
          )
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {classes.map((cls, index) => {
              const course = courseForClass(courses, cls)
              return (
                <Card key={`${classKey(cls)}-${index}`} onClick={() => setActiveClass(cls)} className="cursor-pointer hover:border-primary/60 hover:bg-surface-2/40 transition">
                  <CardHeader
                    title={course?.name || cls.courseId || 'Curso'}
                    subtitle={course?.description || `Turma ${cls.name || '-'}`}
                    action={<Badge tone="neutral">{cls.courseId || '-'}</Badge>}
                  />
                  <CardBody>
                    <div className="flex flex-wrap items-center gap-2 mb-3">
                      <Badge tone="info">{cls.name || 'Turma'}</Badge>
                      {cls.period && <Badge tone="neutral">{cls.period}</Badge>}
                    </div>
                  </CardBody>
                </Card>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
