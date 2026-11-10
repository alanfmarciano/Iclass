// Política de senha na tela (H5a; SEG-06, UXA-13). Quem decide é o servidor
// (backend/utils/passwordPolicy.js, com a lista de senhas comuns): aqui ficam só o
// tamanho mínimo, a dica que aparece embaixo do campo e a conferência da confirmação,
// para o aluno não esperar o servidor para descobrir que faltou caractere.

export const PASSWORD_MIN_LENGTH = Object.freeze({ student: 8, instructor: 10 })

export function passwordMinLength(kind) {
  return kind === 'instructor' ? PASSWORD_MIN_LENGTH.instructor : PASSWORD_MIN_LENGTH.student
}

// Dica embaixo do campo de senha nova (cadastro, troca e senha definida pelo professor).
export function passwordHint(kind = 'student') {
  return `Use pelo menos ${passwordMinLength(kind)} caracteres. Evite senhas óbvias, como 12345678 ou o seu nome.`
}

// Conferência rápida antes de enviar: '' quando pode ir para o servidor, ou o texto do erro.
export function checkNewPassword(password, confirmation, kind = 'student') {
  const value = String(password || '').trim()
  const min = passwordMinLength(kind)
  if (value.length < min) return `A senha precisa ter pelo menos ${min} caracteres.`
  if (confirmation !== undefined && String(password || '') !== String(confirmation || '')) return 'As senhas não coincidem.'
  return ''
}
