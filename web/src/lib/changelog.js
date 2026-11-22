// Novidades do IClass (fase 3, A1 / P6-S2: ENG-10, OPS-02): o CHANGELOG.md da raiz, em
// português simples, entra no build como texto (módulo virtual:iclass-changelog do
// web/vite.config.js) e no hash do build (backend/utils/buildIntegrity.js
// ROOT_BUILD_FILES). Carregado sob demanda: só quem abre as Novidades (Sistema > Sobre o
// IClass ou a Ajuda) baixa o texto.
export function loadChangelog() {
  return import('virtual:iclass-changelog').then((module) => module.default || '')
}
