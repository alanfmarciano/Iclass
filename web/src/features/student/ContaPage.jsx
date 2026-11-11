import { useState } from 'react'
import { Link } from 'react-router-dom'
import { KeyRound, ShieldCheck } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { PageHeader } from '../../components/ui/PageHeader'
import { PasswordChangeForm } from '../../components/PasswordChangeForm'
import { useAuth } from '../../context/AuthProvider'
import { useToast } from '../../context/ToastProvider'
import { useApi } from '../../hooks/useApi'

// Minha conta (/aluno/conta, H5a; UXA-13): os dados da conta, só para ler (quem muda
// nome, e-mail e turma é o professor), e o "Alterar senha", que pede a senha atual.
// A matrícula vem do servidor na hora (GET /api/student/account): ela não fica guardada no
// navegador com a sessão (H5b, SEG-16). O cartão do fim leva a "Meus dados" (H8c, SEG-14).
export default function ContaPage() {
  const { auth } = useAuth()
  const account = useApi(auth.email ? '/api/student/account' : null, [auth.email])
  const matricula = account.data && typeof account.data.matricula === 'string' ? account.data.matricula : ''
  const toast = useToast()
  const [changing, setChanging] = useState(false)
  const student = auth.student || {}
  const name = (student.nomeSocial && student.nomeSocial.trim()) || student.name || ''
  const classes = Array.isArray(student.classes) ? student.classes : []
  const courses = Array.isArray(student.courses) ? student.courses : []
  const classLabel = (item) => {
    const course = courses.find((entry) => entry.id === item.courseId)
    return course?.name ? `${item.name} (${course.name})` : item.name
  }
  const rows = [
    ['Nome', name],
    ['E-mail', student.email || auth.email || ''],
    ...(matricula ? [['Matrícula', matricula]] : []),
    ...(classes.length ? [[classes.length > 1 ? 'Turmas' : 'Turma', classes.map(classLabel).join(', ')]] : []),
  ]
  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <PageHeader title="Minha conta" subtitle="Para corrigir nome, e-mail ou turma, fale com o professor." />
      <Card>
        <CardHeader title="Seus dados" />
        <CardBody>
          <dl className="grid gap-3 sm:grid-cols-[140px_1fr] text-sm">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted">{label}</dt>
                <dd className="min-w-0 break-words font-medium text-text">{value || '—'}</dd>
              </div>
            ))}
          </dl>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Senha" subtitle="Para trocar, informe a senha atual e escolha uma nova." />
        <CardBody>
          {changing ? (
            <PasswordChangeForm
              kind="student"
              endpoint="/api/student/change-password"
              askCurrent
              currentLabel="Senha atual"
              onCancel={() => setChanging(false)}
              onChanged={() => {
                setChanging(false)
                if (toast) toast.success('Senha alterada. Use a senha nova no próximo acesso.')
              }}
            />
          ) : (
            <Button variant="secondary" icon={KeyRound} onClick={() => setChanging(true)}>Alterar senha</Button>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Seus dados pessoais" subtitle="Baixe ou imprima uma cópia do que o IClass guarda sobre você (LGPD)." />
        <CardBody>
          <Link to="/aluno/meus-dados" className="inline-flex h-[38px] items-center gap-2 rounded-lg border border-border bg-surface-raised px-4 text-sm font-semibold text-text transition-all duration-300 hover:border-[var(--border-strong)] hover:bg-surface-2">
            <ShieldCheck aria-hidden="true" size={16} />Ver meus dados
          </Link>
        </CardBody>
      </Card>
    </div>
  )
}
