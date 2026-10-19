// Letras na revisão da prova (AVA-05): a revisão mostra a letra que o aluno viu na tela
// (a posição na versão dele, ou a letra impressa) e, ao lado, a letra original do
// gabarito quando ela é outra.
export function reviewLettersNote(mode) {
  if (mode === 'position') return 'Letras como apareceram para o aluno, na ordem da versão dele. Quando a letra original do gabarito é outra, ela aparece ao lado.'
  if (mode === 'printed') return 'Letras da versão impressa do aluno. Quando a letra original do gabarito é outra, ela aparece ao lado.'
  return null
}

export function OriginalLetter({ seen, original }) {
  if (!original || !seen || String(original).toUpperCase() === String(seen).toUpperCase()) return null
  return <span className="shrink-0 font-mono text-[11px] text-subtle" title="Letra original no gabarito">(original {original})</span>
}

// Texto "A (original C)" para as tabelas sem alternativas.
export function seenWithOriginal(seen, original) {
  const shown = seen || original
  if (!shown) return '—'
  return original && seen && String(original).toUpperCase() !== String(seen).toUpperCase() ? `${seen} (original ${original})` : shown
}
