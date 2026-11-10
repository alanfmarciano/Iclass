import { markdownToHtml } from './contentMarkdown'

// Texto dos Termos e da Política (H8a-1). O modelo começa com "# Título", mas a página
// já tem o seu título (h1) acima do texto: os títulos do markdown descem um nível
// (h1 vira h2 ... h5 vira h6), para a página ter um só h1 e a ordem dos títulos fazer
// sentido para quem usa leitor de tela. O HTML já vem limpo do markdownToHtml.
export function legalMarkdownToHtml(markdown) {
  const html = markdownToHtml(String(markdown || ''))
  return html.replace(/<(\/?)h([1-5])(?=[\s>])/gi, (_match, slash, level) => `<${slash}h${Number(level) + 1}`)
}
