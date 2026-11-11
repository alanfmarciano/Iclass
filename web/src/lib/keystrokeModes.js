// Registro do teclado de uma aplicação de prova (H8b, CRIT-04; decisões P2), escolhido
// ao preparar (Provas) e mostrado no Monitor. A regra fica no servidor
// (backend/utils/keystrokePolicy.js) e na prova (features/student/exam/keystrokePolicy.js).
export const DEFAULT_KEYSTROKE_MODE = 'eventos'

export const KEYSTROKE_MODE_OPTIONS = Object.freeze([
  { value: 'eventos', label: 'Só atalhos suspeitos (padrão)', description: 'Guarda copiar, colar, recortar, o menu do botão direito e a troca de janela. O que o aluno digita não é guardado.' },
  { value: 'tudo', label: 'Toda a digitação', description: 'Guarda cada tecla da tela da prova. Use só quando precisar rever a digitação: as provas são de múltipla escolha.' },
  { value: 'nada', label: 'Não registrar o teclado', description: 'Nenhuma tecla é guardada. Os atalhos continuam bloqueados e as saídas da tela continuam registradas.' },
])

export function normalizeKeystrokeMode(value) {
  return KEYSTROKE_MODE_OPTIONS.some((option) => option.value === value) ? value : DEFAULT_KEYSTROKE_MODE
}

export function keystrokeModeDescription(value) {
  const mode = normalizeKeystrokeMode(value)
  return KEYSTROKE_MODE_OPTIONS.find((option) => option.value === mode).description
}

// Título da coluna do teclado no Monitor: o que ela mostra nesta aplicação.
export function keystrokeColumnLabel(value) {
  const mode = normalizeKeystrokeMode(value)
  if (mode === 'tudo') return 'Digitação'
  if (mode === 'nada') return 'Teclado'
  return 'Atalhos'
}
