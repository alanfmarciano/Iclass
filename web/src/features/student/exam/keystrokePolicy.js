// Registro do teclado na prova (fase 2, H8b: CRIT-04, decisões P2). O professor escolhe
// ao preparar a aplicação (cfg.keystrokeMode), e o servidor filtra de novo
// (backend/utils/keystrokePolicy.js):
// - 'eventos' (padrão, e o de aplicação de antes desta versão): só os atalhos suspeitos
//   (copiar, colar, recortar, menu do botão direito, troca de janela e as tentativas de
//   atalho que a prova bloqueia);
// - 'tudo': todas as teclas da tela da prova;
// - 'nada': nenhuma tecla.
// Em todos os modos, o que se digita num campo de texto fora das alternativas (o
// "Reportar problema") nunca é registrado. O bloqueio dos atalhos e o registro das
// saídas da tela não mudam com o modo.
export const KEYSTROKE_MODES = Object.freeze(['eventos', 'tudo', 'nada'])
export const DEFAULT_KEYSTROKE_MODE = 'eventos'

const SUSPICIOUS_KINDS = new Set(['shortcut', 'clipboard', 'contextmenu'])
const TEXT_FIELD_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]'

export function normalizeKeystrokeMode(value) {
  return KEYSTROKE_MODES.includes(value) ? value : DEFAULT_KEYSTROKE_MODE
}

// Tecla AltGr (teclado ABNT2 e outros do Windows): o navegador manda ctrlKey e altKey
// juntos para os caracteres digitados com AltGr (/, ?, °, ª, ², €...). É digitação, não
// atalho: sem isto, o modo 'eventos' guardaria esses caracteres como 'atalho'. Vale o
// estado AltGraph do navegador e, sem ele, Ctrl+Alt com um caractere que não é letra
// nem número (o atalho de verdade, como Ctrl+Alt+V, chega com a letra).
export function isAltGrTyping(e) {
  if (!e || e.metaKey) return false
  try {
    if (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph')) return true
  } catch { /* navegador sem getModifierState('AltGraph') */ }
  if (!e.ctrlKey || !e.altKey) return false
  const key = typeof e.key === 'string' ? e.key : ''
  return Array.from(key).length === 1 && !/[a-z0-9]/i.test(key)
}

// O evento veio de um campo de texto fora das alternativas da prova (data-exam-answer)?
export function isOutsideAnswerTextField(target) {
  if (!target || typeof target.closest !== 'function') return false
  const field = target.closest(TEXT_FIELD_SELECTOR)
  return !!field && !field.closest('[data-exam-answer]')
}

// O evento (entrada do buffer de teclas) entra no registro deste modo?
export function shouldRecordKeystroke(mode, target, entry) {
  const normalized = normalizeKeystrokeMode(mode)
  if (normalized === 'nada') return false
  if (isOutsideAnswerTextField(target)) return false
  if (normalized === 'tudo') return true
  return SUSPICIOUS_KINDS.has(entry && entry.kind)
}

// Frase das instruções sobre o teclado, conforme o modo e o prazo de guarda
// (settings.retention.proctoringDays; 0 = sem prazo automático).
export function keystrokeNotice(mode, retentionDays = 0) {
  const normalized = normalizeKeystrokeMode(mode)
  const days = Math.floor(Number(retentionDays) || 0)
  const keep = days > 0
    ? ` Esses registros são apagados ${days.toLocaleString('pt-BR')} dias depois do encerramento da prova.`
    : ' Esses registros ficam guardados até a escola apagá-los.'
  if (normalized === 'tudo') {
    return 'Durante a prova, as teclas digitadas na tela da prova e os atalhos (copiar, colar, recortar, menu do botão direito, troca de janela) são registrados para o professor. O que você escreve em "Reportar problema" não é registrado.' + keep
  }
  if (normalized === 'nada') {
    const keepExits = days > 0
      ? ` As saídas da tela são apagadas ${days.toLocaleString('pt-BR')} dias depois do encerramento da prova.`
      : ' As saídas da tela ficam guardadas até a escola apagá-las.'
    return 'Nesta prova o teclado não é registrado. Atalhos de copiar, imprimir e buscar continuam bloqueados.' + keepExits
  }
  return 'Durante a prova, só os atalhos suspeitos (copiar, colar, recortar, menu do botão direito, troca de janela) são registrados para o professor. O que você digita não é registrado.' + keep
}
