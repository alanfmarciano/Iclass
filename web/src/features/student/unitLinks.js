// Endereço de uma unidade no leitor do aluno (fase 3, C16 / P5-S2; contrato C8 do P5):
// /aluno/modulos?unidade=<chave> abre a apostila; &busca=<termo> marca o termo e rola até
// o primeiro trecho; &secao=<n> (o n-ésimo título, contado como em busca/contentText.js)
// começa a procurar a partir daquela seção. A fase 4 pode trocar por /aluno/modulos/:chave
// desde que estes parâmetros continuem valendo (links do sino, da Início e da Busca).
export const UNIT_PARAM = 'unidade'
export const SEARCH_PARAM = 'busca'
export const SECTION_PARAM = 'secao'

export function unitHref(key, { busca = '', secao = 0 } = {}) {
  const params = new URLSearchParams()
  params.set(UNIT_PARAM, String(key || ''))
  const term = String(busca || '').trim()
  if (term) params.set(SEARCH_PARAM, term)
  const section = Number(secao)
  if (term && Number.isInteger(section) && section > 0) params.set(SECTION_PARAM, String(section))
  return `/aluno/modulos?${params.toString()}`
}
