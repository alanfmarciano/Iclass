// Documento impresso do IClass (fase 3, contrato C5 do P4; fundação C0a). Todo documento
// que sai em papel ou em PDF pela caixa de impressão do navegador ("Salvar como PDF")
// passa por aqui: boletim, diário, certificado, relatórios, bilhete e comunicado ao
// responsável, comprovante de entrega e senhas da importação.
//
// O que todo documento tem:
// - cabeçalho com os dados da escola (nome, razão social, CNPJ, endereço, contato e logo),
//   repetido em cada folha;
// - rodapé "Gerado por <nome da instituição no white-label> em <data e hora>" em cada
//   folha (nada de "Gerado pelo IClass" fixo: a escola que troca o nome vê o dela);
// - @page A4 em retrato ou paisagem, com margem, e quebra de página entre as folhas;
// - todo texto escapado: nome de aluno, título de prova, observação e o que mais vier do
//   banco nunca vira HTML. HTML só entra como trustedHtml/html`` (montado aqui, com os
//   valores escapados).
//
// Uso:
//   const win = openPrintWindow()            // no clique, antes de esperar o servidor
//   const dados = await api.get(...)
//   printDocument({ titulo, orientacao: 'paisagem', escola: schoolFromBranding(branding),
//     displayName: branding.displayName, secoes: [...] }, win)
//
// Seção: { titulo?, texto?, paragrafos?, pares?: [[rótulo, valor]], tabela?: { colunas,
// linhas, vazio?, alinhar? }, html?: trustedHtml, assinaturas?: [rótulo], quebraAntes? }.
// Folhas: printDocument({ ..., folhas: [{ titulo, subtitulo, secoes }] }) imprime uma
// folha por item (um aluno por folha no boletim em lote, no bilhete e no comunicado).

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml(value) {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch])
}

// HTML já montado e conferido (valores escapados). Só objetos criados aqui passam sem
// escape: um texto comum com '<b>' continua aparecendo como texto.
class TrustedHtml {
  constructor(value) { this.value = String(value ?? '') }
  toString() { return this.value }
}

export function trustedHtml(value) {
  return value instanceof TrustedHtml ? value : new TrustedHtml(value)
}

export function isTrustedHtml(value) {
  return value instanceof TrustedHtml
}

// Valor dentro do HTML: o confiável como está, lista item a item, o resto escapado.
function toHtml(value) {
  if (value instanceof TrustedHtml) return value.value
  if (Array.isArray(value)) return value.map(toHtml).join('')
  return escapeHtml(value)
}

// Modelo com os valores escapados: html`<b>${nome}</b>` (nome com '<' vira '&lt;').
export function html(strings, ...values) {
  let out = strings[0]
  values.forEach((value, index) => { out += toHtml(value) + strings[index + 1] })
  return new TrustedHtml(out)
}

// Endereço de imagem aceito no documento (logo da escola, assinatura): http(s), caminho
// do próprio servidor ou imagem embutida. 'javascript:' e afins ficam de fora.
export function safeImageUrl(value) {
  const url = String(value ?? '').trim()
  if (!url) return ''
  if (/^https?:\/\//i.test(url)) return url
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(url)) return url
  if (url.startsWith('/') && !url.startsWith('//')) return url
  return ''
}

// Escola do cabeçalho a partir da identidade efetiva de GET /api/branding (escola do
// curso): nome fantasia, razão social, CNPJ, endereço e contato de schools[].info.
export function schoolFromBranding(branding) {
  const brand = branding || {}
  const info = brand.institution || {}
  const cityLine = [info.cityState, info.zip ? `CEP ${info.zip}` : ''].filter(Boolean).join(' · ')
  return {
    nome: info.tradeName || brand.schoolName || brand.displayName || '',
    razaoSocial: info.legalName || '',
    registro: info.registrationId || '',
    endereco: [info.address, cityLine].filter(Boolean).join(' · '),
    contato: [info.phone, info.email, info.website].filter(Boolean).join(' · '),
    logoUrl: brand.logoLightUrl || brand.logoUrl || '',
  }
}

const DATE_TIME = { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }

// Data e hora do rodapé, em pt-BR ("18/11/2026 às 10:05"), no fuso pedido (o da escola,
// settings.timezone) ou no do aparelho.
export function formatGeneratedAt(when, timeZone) {
  const date = when instanceof Date ? when : new Date(when ?? Date.now())
  const valid = Number.isNaN(date.getTime()) ? new Date() : date
  let parts
  try {
    parts = new Intl.DateTimeFormat('pt-BR', { ...DATE_TIME, ...(timeZone ? { timeZone } : {}) }).formatToParts(valid)
  } catch {
    parts = new Intl.DateTimeFormat('pt-BR', DATE_TIME).formatToParts(valid)
  }
  const get = (type) => (parts.find((part) => part.type === type) || {}).value || ''
  return `${get('day')}/${get('month')}/${get('year')} às ${get('hour')}:${get('minute')}`
}

function sectionTable(table) {
  const columns = Array.isArray(table.colunas) ? table.colunas : []
  const rows = Array.isArray(table.linhas) ? table.linhas : []
  const align = Array.isArray(table.alinhar) ? table.alinhar : []
  const cls = (index) => (align[index] === 'direita' ? ' class="num"' : align[index] === 'centro' ? ' class="mid"' : '')
  const head = columns.length ? `<thead><tr>${columns.map((col, i) => `<th${cls(i)}>${toHtml(col)}</th>`).join('')}</tr></thead>` : ''
  const body = rows.length
    ? rows.map((row) => `<tr>${(Array.isArray(row) ? row : [row]).map((cell, i) => `<td${cls(i)}>${toHtml(cell)}</td>`).join('')}</tr>`).join('')
    : `<tr><td class="empty" colspan="${Math.max(1, columns.length)}">${toHtml(table.vazio || 'Nada para mostrar.')}</td></tr>`
  return `<table>${head}<tbody>${body}</tbody></table>`
}

function renderSection(section) {
  if (!section) return ''
  if (section instanceof TrustedHtml) return `<section class="bloco">${section.value}</section>`
  const parts = []
  if (section.titulo) parts.push(`<h2>${toHtml(section.titulo)}</h2>`)
  if (section.texto !== undefined && section.texto !== null && section.texto !== '') parts.push(`<p>${toHtml(section.texto)}</p>`)
  if (Array.isArray(section.paragrafos)) section.paragrafos.filter((p) => p !== null && p !== undefined && p !== '').forEach((p) => parts.push(`<p>${toHtml(p)}</p>`))
  if (Array.isArray(section.pares) && section.pares.length) {
    parts.push(`<table class="pares"><tbody>${section.pares.map(([label, value]) => `<tr><th>${toHtml(label)}</th><td>${toHtml(value ?? '—')}</td></tr>`).join('')}</tbody></table>`)
  }
  if (section.tabela) parts.push(sectionTable(section.tabela))
  if (section.html !== undefined && section.html !== null) parts.push(toHtml(section.html))
  if (Array.isArray(section.assinaturas) && section.assinaturas.length) {
    parts.push(`<div class="assinaturas">${section.assinaturas.map((label) => `<div>${toHtml(label)}</div>`).join('')}</div>`)
  }
  if (section.observacao) parts.push(`<p class="obs">${toHtml(section.observacao)}</p>`)
  return `<section class="bloco${section.quebraAntes ? ' quebra' : ''}">${parts.join('')}</section>`
}

function renderHeader(school, title, subtitle) {
  const logo = safeImageUrl(school.logoUrl)
  const lines = [school.razaoSocial, school.registro ? `CNPJ / registro ${school.registro}` : '', school.endereco, school.contato].filter(Boolean)
  return `<header class="cabecalho">
    <div class="escola">
      ${logo ? `<img class="logo" src="${escapeHtml(logo)}" alt="">` : ''}
      <div>
        ${school.nome ? `<p class="nome-escola">${toHtml(school.nome)}</p>` : ''}
        ${lines.map((line) => `<p class="dados-escola">${toHtml(line)}</p>`).join('')}
      </div>
    </div>
    <div class="doc-titulo">
      <h1>${toHtml(title)}</h1>
      ${subtitle ? `<p class="subtitulo">${toHtml(subtitle)}</p>` : ''}
    </div>
  </header>`
}

// HTML completo do documento (sem abrir janela): o que printDocument escreve e o que os
// testes conferem.
export function printDocumentHtml(options = {}) {
  const title = options.titulo || 'Documento'
  const landscape = options.orientacao === 'paisagem'
  const school = { nome: '', razaoSocial: '', registro: '', endereco: '', contato: '', logoUrl: '', ...(options.escola || {}) }
  const displayName = String(options.displayName || school.nome || 'IClass').trim() || 'IClass'
  const generatedAt = formatGeneratedAt(options.geradoEm, options.fuso)
  const footer = `<footer class="rodape"><span>${toHtml(options.rodapeEsquerda || school.nome || '')}</span><span>Gerado por ${escapeHtml(displayName)} em ${escapeHtml(generatedAt)}</span></footer>`
  const sheets = Array.isArray(options.folhas) && options.folhas.length
    ? options.folhas
    : [{ titulo: title, subtitulo: options.subtitulo, secoes: options.secoes }]
  const body = sheets.map((sheet, index) => `<article class="folha${index > 0 ? ' nova-folha' : ''}">
    ${renderHeader(school, sheet.titulo || title, sheet.subtitulo)}
    <main>${(Array.isArray(sheet.secoes) ? sheet.secoes : []).map(renderSection).join('')}</main>
    ${footer}
  </article>`).join('')
  const extraCss = options.estilo instanceof TrustedHtml ? options.estilo.value : ''
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
    @page{size:A4 ${landscape ? 'landscape' : 'portrait'};margin:14mm 12mm}
    *{box-sizing:border-box} body{font-family:Arial,Helvetica,sans-serif;color:#171a21;margin:0;background:#fff;font-size:13px}
    .folha{padding:24px 28px;max-width:${landscape ? '1120px' : '860px'};margin:0 auto;display:flex;flex-direction:column;min-height:100%}
    .nova-folha{break-before:page;page-break-before:always}
    .cabecalho{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;border-bottom:2px solid #182033;padding-bottom:12px;margin-bottom:16px}
    .escola{display:flex;gap:12px;align-items:flex-start;max-width:55%}
    .logo{max-height:56px;max-width:140px;object-fit:contain}
    .nome-escola{font-weight:700;font-size:14px;margin:0 0 2px}
    .dados-escola{margin:0;color:#596273;font-size:11px}
    .doc-titulo{text-align:right}
    .doc-titulo h1{font-size:20px;margin:0 0 4px} .subtitulo{margin:0;color:#596273;font-size:12px}
    main{flex:1}
    .bloco{margin-top:14px;break-inside:auto}
    .bloco.quebra{break-before:page;page-break-before:always}
    h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#182033;margin:0 0 6px}
    p{margin:4px 0;white-space:pre-line}
    table{border-collapse:collapse;width:100%;font-size:12px;margin:4px 0 8px}
    th,td{border:1px solid #d7dbe3;padding:5px 8px;text-align:left;vertical-align:top;word-break:break-word}
    thead th{background:#182033;color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:.03em}
    table.pares th{width:32%;background:#eef1f6;color:#182033;font-weight:600}
    td.num,th.num{text-align:right;white-space:nowrap} td.mid,th.mid{text-align:center}
    tr{break-inside:avoid} td.empty{color:#8790a0;text-align:center}
    .obs{color:#596273;font-size:11px}
    .assinaturas{margin-top:42px;display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:40px}
    .assinaturas div{border-top:1px solid #182033;padding-top:6px;text-align:center;font-size:12px;color:#596273}
    .rodape{margin-top:24px;display:flex;justify-content:space-between;gap:12px;color:#8790a0;font-size:11px;border-top:1px solid #d7dbe3;padding-top:6px}
    @media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}.folha{padding:0;max-width:none}}
    ${extraCss}
  </style></head><body>${body}</body></html>`
}

// Janela aberta já no clique (antes de esperar o servidor): janela aberta depois de um
// await perde o gesto do usuário e o navegador costuma bloquear. null se bloqueou.
export function openPrintWindow(message = 'Preparando o documento…') {
  if (typeof window === 'undefined') return null
  const win = window.open('', '_blank')
  if (!win) return null
  try {
    win.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Preparando…</title></head><body style="font-family:Arial,Helvetica,sans-serif;padding:24px;color:#333">${escapeHtml(message)}</body></html>`)
    win.document.close()
  } catch { /* janela já fechada: printDocument cuida */ }
  return win
}

// Escreve o documento na janela (a de openPrintWindow ou uma nova) e abre a caixa de
// impressão depois de carregar as imagens (logo), uma vez só. false se o navegador
// bloqueou a janela ou ela foi fechada.
export function printDocument(options, targetWindow) {
  if (typeof window === 'undefined') return false
  const win = targetWindow && !targetWindow.closed ? targetWindow : (targetWindow ? null : window.open('', '_blank'))
  if (!win) return false
  try {
    win.document.open()
    win.document.write(printDocumentHtml(options))
    win.document.close()
  } catch {
    return false
  }
  let printed = false
  const print = () => {
    if (printed) return
    printed = true
    setTimeout(() => { try { win.focus(); win.print() } catch { /* janela fechada */ } }, 250)
  }
  if (win.document.readyState === 'complete') print()
  else {
    try { win.addEventListener('load', print, { once: true }) } catch { /* sem eventos: o prazo abaixo imprime */ }
    // Logo que não carrega (servidor sem a imagem) não segura a impressão.
    setTimeout(print, 2000)
  }
  return true
}
