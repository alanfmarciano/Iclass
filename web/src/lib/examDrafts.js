// Cópia local CIFRADA das respostas da prova (AVA-11). Serve para não perder o que
// ainda não chegou ao servidor quando a rede cai, o sistema fecha a aba ou a página é
// recarregada.
// - A chave (32 bytes, uma por tentativa) é gerada e guardada no servidor e só chega ao
//   dono da tentativa enquanto ela está aberta. Aqui ela fica apenas em memória, como
//   chave WebCrypto não exportável: nunca é gravada no navegador e é pedida de novo ao
//   servidor depois de recarregar.
// - Cada gravação cifra as respostas com AES-GCM e um IV aleatório novo e vai para o
//   localStorage numa chave por tentativa (o identificador da tentativa entra como dado
//   autenticado, então uma cópia não serve para outra tentativa).
// - A cópia é apagada no envio aceito, no logout e quando a tentativa já está finalizada
//   no servidor; cópias de outras tentativas ou alunos encontradas no aparelho também.
// - Sem WebCrypto (página aberta por http fora de localhost, contexto inseguro) a cópia
//   não é gravada e a prova segue normalmente. Limitação conhecida até o HTTPS (fase 2).
// Toda leitura e escrita tolera armazenamento indisponível (aba privada, cota cheia).
const PREFIX = 'iclass-exam-draft:'
const FORMAT = 2
const IV_BYTES = 12
const KEY_BYTES = 32

function storage() {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

function subtleCrypto() {
  try {
    if (globalThis.isSecureContext === false) return null
    const webCrypto = globalThis.crypto
    if (!webCrypto?.subtle || typeof webCrypto.getRandomValues !== 'function') return null
    return webCrypto.subtle
  } catch { return null }
}

export function examDraftCryptoAvailable() {
  return !!subtleCrypto()
}

export function examDraftStorageKey(attemptId) {
  return `${PREFIX}${attemptId}`
}

function toBase64(bytes) {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index])
  return btoa(binary)
}

function fromBase64(text) {
  const binary = atob(String(text || ''))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function attemptData(attemptId) {
  return new TextEncoder().encode(`iclass-exam-draft:${attemptId}`)
}

// Chave recebida do servidor (base64 de 32 bytes) → chave AES-GCM só para cifrar e
// decifrar, não exportável. Devolve null sem WebCrypto ou com chave inválida.
export async function importExamDraftKey(rawKey) {
  const subtle = subtleCrypto()
  if (!subtle || typeof rawKey !== 'string' || !rawKey) return null
  try {
    const bytes = fromBase64(rawKey)
    if (bytes.length !== KEY_BYTES) return null
    return await subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  } catch { return null }
}

// Gravações da mesma tentativa terminam fora de ordem (cifrar é assíncrono): vale a
// mais recente, e uma limpeza descarta as que ainda estavam a caminho.
const writeSequence = new Map()
function nextSequence(storageKey) {
  const value = (writeSequence.get(storageKey) || 0) + 1
  writeSequence.set(storageKey, value)
  return value
}

// saved: true quando o servidor já confirmou estas respostas.
export async function writeExamDraft({ attemptId, applicationId = null, cryptoKey, answers, saved = false }) {
  const subtle = subtleCrypto()
  const store = storage()
  if (!subtle || !store || !attemptId || !cryptoKey) return false
  const storageKey = examDraftStorageKey(attemptId)
  const sequence = nextSequence(storageKey)
  try {
    const updatedAt = Date.now()
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES))
    const plain = new TextEncoder().encode(JSON.stringify({ answers: answers || {}, saved: saved === true, updatedAt }))
    const cipher = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: attemptData(attemptId) }, cryptoKey, plain)
    if (writeSequence.get(storageKey) !== sequence) return false
    store.setItem(storageKey, JSON.stringify({
      v: FORMAT,
      attemptId: String(attemptId),
      applicationId: applicationId || null,
      iv: toBase64(iv),
      data: toBase64(new Uint8Array(cipher)),
      updatedAt,
    }))
    return true
  } catch { return false }
}

function readEnvelope(store, storageKey) {
  try {
    const envelope = JSON.parse(store.getItem(storageKey) || 'null')
    if (!envelope || envelope.v !== FORMAT || typeof envelope.iv !== 'string' || typeof envelope.data !== 'string') return null
    return envelope
  } catch { return null }
}

// Decifra a cópia da tentativa. Cópia corrompida, de outro formato ou que não abre com
// esta chave é apagada.
export async function readExamDraft({ attemptId, cryptoKey }) {
  const subtle = subtleCrypto()
  const store = storage()
  if (!subtle || !store || !attemptId || !cryptoKey) return null
  const storageKey = examDraftStorageKey(attemptId)
  let present = false
  try { present = store.getItem(storageKey) !== null } catch { return null }
  if (!present) return null
  const envelope = readEnvelope(store, storageKey)
  try {
    if (!envelope || envelope.attemptId !== String(attemptId)) throw new Error('cópia inválida')
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: attemptData(attemptId) }, cryptoKey, fromBase64(envelope.data))
    const draft = JSON.parse(new TextDecoder().decode(plain))
    if (!draft || typeof draft !== 'object' || !draft.answers || typeof draft.answers !== 'object' || Array.isArray(draft.answers)) throw new Error('cópia inválida')
    return { attemptId: String(attemptId), answers: draft.answers, saved: draft.saved === true, updatedAt: Number(draft.updatedAt) || 0 }
  } catch {
    clearExamDraft(attemptId)
    return null
  }
}

function draftKeys(store) {
  const keys = []
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index)
    if (key && key.startsWith(PREFIX)) keys.push(key)
  }
  return keys
}

// Tentativa desta aplicação que tem cópia neste aparelho (sem decifrar nada): depois de
// recarregar, o servidor diz o que aconteceu com ela.
export function findExamDraftAttempt(applicationId) {
  const store = storage()
  if (!store || !applicationId) return null
  try {
    let found = null
    draftKeys(store).forEach((key) => {
      const envelope = readEnvelope(store, key)
      if (!envelope || envelope.applicationId !== applicationId || !envelope.attemptId) return
      if (!found || Number(envelope.updatedAt) > Number(found.updatedAt)) found = envelope
    })
    return found ? found.attemptId : null
  } catch { return null }
}

export function clearExamDraft(attemptId) {
  const store = storage()
  if (!attemptId) return
  const storageKey = examDraftStorageKey(attemptId)
  nextSequence(storageKey)
  if (!store) return
  try { store.removeItem(storageKey) } catch { /* ignora */ }
}

// Cópias da versão anterior (texto puro no sessionStorage) não ficam no aparelho.
function clearLegacySessionDrafts() {
  try {
    if (typeof sessionStorage === 'undefined') return
    draftKeys(sessionStorage).forEach((key) => sessionStorage.removeItem(key))
  } catch { /* ignora */ }
}

// Apaga as cópias de uma aplicação (a tentativa já virou entrega no servidor).
export function clearExamDraftsForApplication(applicationId, { except = null } = {}) {
  const store = storage()
  clearLegacySessionDrafts()
  if (!store || !applicationId) return
  try {
    draftKeys(store).forEach((key) => {
      const envelope = readEnvelope(store, key)
      if (envelope?.applicationId !== applicationId) return
      if (except && envelope.attemptId === String(except)) return
      clearExamDraft(envelope.attemptId)
    })
  } catch { /* ignora */ }
}

// Mantém só a cópia da tentativa em andamento: as de outras tentativas ou de outros
// alunos que usaram este aparelho são apagadas.
export function clearOtherExamDrafts(keepAttemptId) {
  const store = storage()
  clearLegacySessionDrafts()
  if (!store) return
  try {
    const keep = keepAttemptId ? examDraftStorageKey(keepAttemptId) : null
    draftKeys(store).forEach((key) => {
      if (key === keep) return
      nextSequence(key)
      store.removeItem(key)
    })
  } catch { /* ignora */ }
}

// Logout: nenhuma cópia fica para o próximo usuário do computador.
export function clearAllExamDrafts() {
  clearOtherExamDrafts(null)
}

// Mesmas respostas? (as chaves são números de questão; a ordem não importa)
export function sameExamAnswers(a, b) {
  const left = a || {}
  const right = b || {}
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    if ((left[key] ?? null) !== (right[key] ?? null)) return false
  }
  return true
}
