// Conferências do envio da atividade antes de mandar (fase 3, C9 / P1-g; D5, D6 e D12 do
// P1). Sem import: o teste do servidor (test/backend/assignments-student-screen.test.js)
// carrega este arquivo no Node e compara cada frase com a resposta de verdade de POST
// /api/student/assignments/:id/submit e com utils/assignmentFiles.classifyFileName. Assim a
// tela avisa antes do upload com a mesma frase que o servidor daria depois dele; o
// servidor continua conferindo tudo (assinatura, tamanho real, sha256).

export const MB = 1024 * 1024

// Executáveis e atalhos que o servidor sempre recusa (assignmentFiles.BLOCKED_EXECUTABLES;
// o teste confere que as duas listas são iguais).
export const BLOCKED_EXECUTABLES = Object.freeze([
  '.exe', '.com', '.bat', '.cmd', '.ps1', '.msi', '.scr', '.jar', '.vbs', '.vbe', '.lnk', '.dll',
  '.reg', '.hta', '.wsf', '.cpl', '.msc', '.appx', '.msix', '.apk', '.iso',
  '.jse', '.pif', '.scf', '.url', '.msp', '.mst', '.msu', '.psm1', '.psd1', '.ps1xml', '.ps2',
  '.ps2xml', '.psc1', '.psc2', '.vb', '.ws', '.wsc', '.wsh', '.sct', '.shb', '.shs', '.inf',
  '.ins', '.isp', '.chm', '.hlp', '.gadget', '.application', '.appref-ms', '.xbap', '.xll',
  '.settingcontent-ms', '.library-ms', '.searchconnector-ms', '.diagcab', '.msh', '.msh1',
  '.msh2', '.mshxml', '.msh1xml', '.msh2xml', '.cab', '.appinstaller', '.vhd', '.vhdx', '.img',
])
const BLOCKED_SET = new Set(BLOCKED_EXECUTABLES)
const ORIGINAL_NAME_MAX = 120

export function mbText(value) {
  return String(value).replace('.', ',')
}

// Extensão como o path.extname do Node ('.pdf'; '' sem extensão ou só '.oculto').
export function extensionOf(name) {
  const base = String(name || '').split(/[\\/]/).pop()
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot).toLowerCase()
}

// O nome como o servidor guarda e escreve nas frases (assignmentFiles.sanitizeOriginalName).
export function sanitizeFileName(value) {
  const base = String(value === undefined || value === null ? '' : value).split(/[\\/]/).pop()
  const clean = base
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\x00-\x1f\x7f]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim()
  if (clean.length <= ORIGINAL_NAME_MAX) return clean
  const dot = clean.lastIndexOf('.')
  const ext = dot > 0 ? clean.slice(dot) : ''
  const keep = ext.length < 12 ? ext : ''
  return clean.slice(0, ORIGINAL_NAME_MAX - keep.length).trimEnd() + keep
}

// Problema de um arquivo antes de mandar, ou ''. aceita: o bloco 'aceita' do detalhe da
// atividade ({ extensoes, maxSizeMb }).
export function fileProblem(file, aceita) {
  const raw = String(file?.name ?? '')
  const name = sanitizeFileName(raw)
  if (!name || raw.includes('\0')) return 'Arquivo sem nome. Renomeie o arquivo e envie de novo.'
  const ext = extensionOf(name)
  if (!ext) return `O arquivo "${name}" não tem extensão (como .pdf ou .jpg). Renomeie e envie de novo.`
  if (BLOCKED_SET.has(ext)) return `O arquivo "${name}" não pode ser enviado: arquivos executáveis (${ext}) são sempre recusados.`
  const accepted = Array.isArray(aceita?.extensoes) ? aceita.extensoes.map((item) => String(item).toLowerCase()) : []
  if (!accepted.includes(ext)) return `O arquivo "${name}" (${ext}) não é aceito nesta tarefa. Formatos aceitos: ${accepted.join(', ') || 'nenhum'}.`
  const maxSizeMb = Number(aceita?.maxSizeMb) || 0
  if (maxSizeMb && Number(file.size) > maxSizeMb * MB) return `O arquivo "${name}" passa do limite de ${mbText(maxSizeMb)} MB por arquivo desta tarefa.`
  if (!(Number(file.size) > 0)) return `O arquivo "${name}" está vazio.`
  return ''
}

// Problema do conjunto escolhido (quantidade e total do envio), ou ''.
export function selectionProblem(files, aceita) {
  const list = Array.isArray(files) ? files : []
  const maxFiles = Number(aceita?.maxFiles) || 0
  if (maxFiles && list.length > maxFiles) return `Envie no máximo ${maxFiles} arquivo(s) por vez nesta tarefa.`
  const maxTotalMb = Number(aceita?.maxTotalMb) || 0
  const total = list.reduce((sum, file) => sum + (Number(file?.size) || 0), 0)
  if (maxTotalMb && total > maxTotalMb * MB) return `O envio passa do limite de ${maxTotalMb} MB por envio. Envie menos arquivos ou arquivos menores.`
  return ''
}

// Link digitado: vazio, ou http(s) com endereço; senão a frase do servidor.
export function linkProblem(link) {
  const value = String(link || '').trim()
  if (!value) return ''
  try {
    const url = new URL(value)
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname) return ''
  } catch { /* cai na frase abaixo */ }
  return 'Informe um link que comece com http:// ou https://.'
}

// Envio vazio: 'O envio está vazio. Envie um arquivo, a resposta em texto ou o link.'
export function emptySubmissionText(resposta) {
  const options = [resposta?.files && 'um arquivo', resposta?.text && 'a resposta em texto', resposta?.link && 'o link'].filter(Boolean)
  const joined = options.length > 1 ? `${options.slice(0, -1).join(', ')} ou ${options[options.length - 1]}` : (options[0] || 'a resposta')
  return `O envio está vazio. Envie ${joined}.`
}
