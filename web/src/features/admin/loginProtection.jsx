import { Badge } from '../../components/ui/Badge'

// Atraso no login por senha errada (H5b; SEG-06, decisão 6 do Alan): o servidor manda
// loginProtection { failures, retryAt } na conta que já chegou ao atraso (5 senhas erradas
// seguidas ou mais). Não há trava definitiva; o "Liberar login" faz a conta voltar a entrar
// na hora. Usado em Alunos e em Contas.

function hourMinute(ms) {
  return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

// Texto do selo: "Login em espera até 14:32" enquanto a conta espera; depois, só quantas
// senhas erradas seguidas (a próxima errada volta a atrasar).
export function loginProtectionLabel(protection, now = Date.now()) {
  if (!protection) return ''
  const retryAt = Number(protection.retryAt) || 0
  if (retryAt > now) return `Login em espera até ${hourMinute(retryAt)}`
  const failures = Number(protection.failures) || 0
  return `${failures} senhas erradas seguidas`
}

export function LoginProtectionBadge({ protection, now }) {
  if (!protection) return null
  const waiting = (Number(protection.retryAt) || 0) > (now ?? Date.now())
  return (
    <Badge tone={waiting ? 'danger' : 'warning'} className="whitespace-nowrap">
      {loginProtectionLabel(protection, now)}
    </Badge>
  )
}

export const UNLOCK_LOGIN_HINT = 'A conta volta a entrar na hora. A senha não muda.'
