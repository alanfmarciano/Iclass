// Tetos de texto do aluno, do fórum e da observação pedagógica, os mesmos do servidor
// (fase 2, H9b: ENG-03; backend/utils/studentNotes.js, FORUM_TEXT_MAX em
// backend/routes/student.js e ADMIN_SCHEMAS.observationCreate em backend/routes/admin.js).
// A contagem "N de M caracteres" aparece a partir de 90% do teto.
export const NOTE_MAX_CHARS = 50000
export const NOTE_COUNTER_FROM = 45000
export const ANNOTATION_NOTE_MAX_CHARS = 5000
export const FORUM_TEXT_MAX_CHARS = 5000
export const SHORT_TEXT_COUNTER_FROM = 4500
export const OBSERVATION_TEXT_MAX_CHARS = 5000

// Milhar em pt-BR (5.000), sem depender do ICU do navegador.
export function formatCount(value) {
  return String(Math.trunc(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

// Texto que o campo não deixa digitar mas chega por outro caminho (modelo de resposta
// somado ao que já estava escrito): cortado no teto, com `cut` dizendo se cortou.
export function clampText(text, max) {
  const value = String(text ?? '')
  return value.length > max ? { text: value.slice(0, max), cut: true } : { text: value, cut: false }
}

// Mensagem de texto longo demais para um caminho sem maxLength (como o prompt de edição).
export function tooLongMessage(length, max) {
  return `O texto aceita no máximo ${formatCount(max)} caracteres (este tem ${formatCount(length)}).`
}
