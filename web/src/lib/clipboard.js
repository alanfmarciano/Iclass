// Copiar texto com plano B (fase 2, H6a; OPS-08).
//
// O navigator.clipboard só existe em contexto seguro (https ou o próprio computador em
// localhost). O IClass na rede da sala abre por http://IP:3000, e ali o "Copiar token",
// o "Copiar endereço" e o "copiar link" falhavam sem dizer nada. Ordem:
// 1. contexto seguro com navigator.clipboard.writeText: usa a API;
// 2. sem ela, ou se ela falhar: textarea fora da tela, select e execCommand('copy');
// 3. se também falhar: devolve 'manual', e quem chamou mostra o texto selecionado para a
//    pessoa copiar com Ctrl+C (ManualCopyModal / useCopyText).
// Devolve 'copied' ou 'manual'; nunca lança. Nenhuma tela usa navigator.clipboard direto
// (um teste varre web/src).

function copyWithTextarea(text) {
  if (typeof document === 'undefined' || !document.body || typeof document.execCommand !== 'function') return false
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.setAttribute('aria-hidden', 'true')
  // Fora da tela, sem rolar a página nem abrir o teclado do celular.
  area.style.position = 'fixed'
  area.style.top = '0'
  area.style.left = '-9999px'
  area.style.opacity = '0'
  area.style.fontSize = '12pt'
  const previousFocus = document.activeElement
  document.body.appendChild(area)
  try {
    area.focus()
    area.select()
    try { area.setSelectionRange(0, text.length) } catch { /* alguns navegadores não deixam */ }
    return document.execCommand('copy') === true
  } catch {
    return false
  } finally {
    area.remove()
    try { previousFocus?.focus?.() } catch { /* o elemento pode ter saído da tela */ }
  }
}

export async function copyText(value) {
  const text = value == null ? '' : String(value)
  try {
    const secure = typeof window !== 'undefined' && window.isSecureContext === true
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (secure && clipboard && typeof clipboard.writeText === 'function') {
      await clipboard.writeText(text)
      return 'copied'
    }
  } catch { /* permissão negada ou API quebrada: tenta o caminho antigo */ }
  return copyWithTextarea(text) ? 'copied' : 'manual'
}
