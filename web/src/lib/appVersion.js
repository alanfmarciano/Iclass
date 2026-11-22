// Versão do IClass que este bundle traz (fase 3, A1 / P6-S2: ENG-10, OPS-02). Vem do
// package.json da raiz, a fonte única (D7 do P6), pelo define __ICLASS_VERSION__ do
// web/vite.config.js, e é a mesma que o servidor mostra em /api/health e no cartão
// Sobre o IClass. Antes a barra lateral mostrava "v3" fixo.
/* global __ICLASS_VERSION__ */
export const APP_VERSION = typeof __ICLASS_VERSION__ === 'string' ? __ICLASS_VERSION__ : ''

// "v3.1.0" (ou "" sem versão, como num teste sem o define).
export function versionLabel(version = APP_VERSION) {
  const value = String(version || '').trim()
  return value ? `v${value.replace(/^v/i, '')}` : ''
}
