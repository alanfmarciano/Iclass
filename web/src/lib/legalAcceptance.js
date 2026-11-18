// Primeiro acesso do aluno no navegador (H8a-2; SEG-08, SEG-09): data de nascimento,
// idade, responsável de menor e o texto de um aceite gravado. As mesmas regras do
// servidor (backend/utils/birthDate.js e utils/legalAcceptance.js); quem decide é sempre
// o servidor, e a tela só antecipa a mensagem.

export const MINOR_GUARDIAN_MESSAGE = 'Para menores de 18 anos, informe o nome e um telefone ou e-mail do responsável.'
export const DOCUMENTS_CHANGED_MESSAGE = 'Os documentos foram atualizados. Leia a nova versão e marque o aceite de novo.'

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

// Hoje no relógio do aparelho ('AAAA-MM-DD'), para o max do campo de data.
export function todayIso(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function parse(value) {
  const match = ISO_DATE.exec(String(value || ''))
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return { year, month, day }
}

export function ageOn(birthDate, today = todayIso()) {
  const birth = parse(birthDate)
  const now = parse(today)
  if (!birth || !now) return null
  let age = now.year - birth.year
  if (now.month < birth.month || (now.month === birth.month && now.day < birth.day)) age -= 1
  return age
}

export function isMinorBirthDate(birthDate, today = todayIso()) {
  const age = ageOn(birthDate, today)
  return age !== null && age < 18
}

// Data de nascimento como o professor lê: '06/05/2009 (17 anos, menor de idade)'.
export function birthDateText(birthDate, today = todayIso()) {
  const birth = parse(birthDate)
  if (!birth) return ''
  const age = ageOn(birthDate, today)
  const date = `${String(birth.day).padStart(2, '0')}/${String(birth.month).padStart(2, '0')}/${birth.year}`
  if (age === null || age < 0) return date
  return `${date} (${age} ${age === 1 ? 'ano' : 'anos'}${age < 18 ? ', menor de idade' : ''})`
}

// Nome com 3 letras ou mais e um telefone (8 a 13 dígitos) ou e-mail.
export function guardianComplete(guardian) {
  const g = guardian || {}
  const name = String(g.name || '').trim()
  const phoneDigits = String(g.phone || '').replace(/\D/g, '').length
  const email = String(g.email || '').trim()
  const hasPhone = phoneDigits >= 8 && phoneDigits <= 13
  const hasEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  return name.length >= 3 && (hasPhone || hasEmail)
}

function fmtDate(value) {
  const time = typeof value === 'number' ? value : Date.parse(String(value || ''))
  if (!Number.isFinite(time) || time <= 0) return ''
  return new Date(time).toLocaleDateString('pt-BR')
}

// Texto de um aceite gravado (termsAcceptance ou privacyAcceptance):
// - documento publicado: 'Versão 2 · 10/11/2026';
// - modelo, antes de a escola publicar: 'Modelo padrão do IClass · 10/11/2026';
// - aceite antigo, de antes do H8a-2 ({ version: '1.0' }): 'v1.0, aceite antigo sem documento · ...';
// - sem aceite: 'Nenhum aceite registrado'.
export function acceptanceText(acceptance) {
  if (!acceptance || typeof acceptance !== 'object') return 'Nenhum aceite registrado'
  const date = fmtDate(acceptance.at)
  const suffix = date ? ` · ${date}` : ''
  const documentId = typeof acceptance.documentId === 'string' ? acceptance.documentId : ''
  if (documentId && acceptance.version) return `Versão ${acceptance.version}${suffix}`
  if (documentId) return `Modelo padrão do IClass${suffix}`
  if (acceptance.version) return `v${acceptance.version}, aceite antigo sem documento${suffix}`
  return `Aceite sem versão${suffix}`
}
