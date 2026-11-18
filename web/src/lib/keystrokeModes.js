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

// Título da coluna do teclado no Monitor: o que ela mostra nesta aplicação. Aplicação de
// antes desta versão (keystrokeModeLegacy, sem o campo no banco) vale 'eventos' daqui em
// diante, mas já guardou a digitação completa: a coluna diz só "Teclado".
export function keystrokeColumnLabel(value, legacy = false) {
  if (legacy) return 'Teclado'
  const mode = normalizeKeystrokeMode(value)
  if (mode === 'tudo') return 'Digitação'
  if (mode === 'nada') return 'Teclado'
  return 'Atalhos'
}

// Dica do botão do teclado no Monitor (abre a janela ao vivo).
export function keystrokeWatchTitle(value, legacy = false) {
  if (legacy) return 'Ver teclado ao vivo (aplicação de antes desta versão: guardou toda a digitação até a atualização; daqui em diante, só atalhos suspeitos)'
  return normalizeKeystrokeMode(value) === 'tudo' ? 'Ver digitação ao vivo' : 'Ver atalhos ao vivo'
}

// Janela ao vivo do teclado no Monitor (decisões §12, sobra do H8b): o título e o texto
// sem eventos seguem o modo da aplicação. Aplicação de antes desta versão guardou a
// digitação completa: fica como 'tudo'.
export function keystrokeLiveTitle(value, legacy = false, name = '') {
  const mode = legacy ? 'tudo' : normalizeKeystrokeMode(value)
  const who = name || ''
  if (mode === 'tudo') return `Digitação ao vivo — ${who}`
  if (mode === 'nada') return `Teclado — ${who}`
  return `Atalhos ao vivo — ${who}`
}

export function keystrokeLiveEmptyText(value, legacy = false) {
  const mode = legacy ? 'tudo' : normalizeKeystrokeMode(value)
  if (mode === 'tudo') return 'Nenhuma digitação registrada ainda.'
  if (mode === 'nada') return 'Registro de teclado desligado nesta prova.'
  return 'Nenhum atalho registrado ainda.'
}
