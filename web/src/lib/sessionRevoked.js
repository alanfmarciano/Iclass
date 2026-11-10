// Sessão encerrada no servidor por uma ação (H5b; contrato das respostas de estado: 401
// { sessionRevoked: true, reason }). Para estes motivos o servidor manda o texto certo e o
// login o mostra, em vez do "Sua sessão expirou" genérico:
// - 'password_reset': o professor redefiniu a senha do aluno;
// - 'password_changed': o instrutor trocou a senha em outro aparelho;
// - 'logout': a sessão saiu pelo "Sair" (em outra aba): o login não mostra aviso.
export const SERVER_REVOKED_REASONS = Object.freeze(['logout', 'password_reset', 'password_changed'])

// { reason, message } para o doLogout a partir do erro de uma chamada, ou null quando o
// erro não traz um desses motivos.
export function revokedLogoutFromError(err) {
  const data = err && err.data
  const reason = data && data.sessionRevoked === true && typeof data.reason === 'string' ? data.reason : ''
  if (!SERVER_REVOKED_REASONS.includes(reason)) return null
  return { reason, message: reason === 'logout' ? '' : String(data.error || '') }
}
