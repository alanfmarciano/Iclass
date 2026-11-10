import { KeyRound } from 'lucide-react'
import { useAuth } from '../../context/AuthProvider'
import { useToast } from '../../context/ToastProvider'
import { PasswordChangeForm } from '../../components/PasswordChangeForm'

// Troca de senha obrigatória no portal do aluno (H5a; UXA-13, SEG-06, decisão P3).
// Fica entre o <Suspense> do layout e o StudentCourseGate: com a troca pedida, o lugar
// da página mostra só o formulário (o servidor recusa o resto com 403
// passwordChangeRequired). O menu continua à vista, com o Sair. A prova (StudentExamShell)
// não passa por aqui: durante uma prova o servidor adia a troca para o próximo acesso.
const INTRO = {
  created: 'O professor criou a sua conta com uma senha temporária. Antes de continuar, escolha uma senha só sua.',
  reset: 'O professor redefiniu a sua senha. Antes de continuar, escolha uma senha nova, só sua.',
  weak: 'A sua senha é fácil de adivinhar. Antes de continuar, escolha uma senha nova.',
}

export function passwordChangeIntro(reason) {
  return INTRO[reason] || INTRO.reset
}

export function StudentPasswordChangeGate({ children }) {
  const { auth, setAuth } = useAuth()
  const toast = useToast()
  if (!auth.mustChangePassword) return children
  const reason = auth.passwordChangeReason || 'reset'
  const usesTemporary = reason === 'created' || reason === 'reset'
  return (
    <section className="mx-auto w-full max-w-md" aria-labelledby="troca-senha-titulo">
      <div className="premium-card rounded-xl p-6 space-y-5">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary"><KeyRound size={20} aria-hidden="true" /></span>
          <div>
            <h1 id="troca-senha-titulo" className="text-lg font-semibold">Escolha uma senha nova</h1>
            <p className="mt-1 text-sm text-muted">{passwordChangeIntro(reason)}</p>
          </div>
        </div>
        <PasswordChangeForm
          kind="student"
          endpoint="/api/student/change-password"
          askCurrent
          currentLabel={usesTemporary ? 'Senha temporária' : 'Senha atual'}
          onChanged={() => {
            setAuth((current) => ({ ...current, mustChangePassword: false, passwordChangeReason: null }))
            if (toast) toast.success('Senha alterada. Use a senha nova no próximo acesso.')
          }}
        />
      </div>
    </section>
  )
}
