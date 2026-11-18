import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import { api } from '../lib/api'
import { useAuth } from './AuthProvider'
import { useToast } from './ToastProvider'

const PrefsCtx = createContext({ prefs: {}, pref: () => undefined, setPref: () => Promise.resolve(false) })

// Espera entre uma alteração e a gravação (várias alterações seguidas vão num pedido só).
export const PREFERENCES_SAVE_DELAY_MS = 400
// Nova tentativa depois de uma falha de rede ou do servidor (5xx, 503).
export const PREFERENCES_RETRY_MS = 5000
export const PREFERENCES_RETRY_MESSAGE = 'Não foi possível salvar sua preferência agora. O IClass tenta de novo em instantes.'

// O que fazer com uma gravação que falhou (fase 2, H9b: ENG-03; decisões §12):
// - 'retry': rede fora, prazo estourado ou erro do servidor (5xx, 503): tenta de novo
//   em PREFERENCES_RETRY_MS, avisando uma vez;
// - 'later': 429 (pedidos demais): tenta de novo depois do retryAfter do servidor;
// - 'stop': qualquer outra recusa (400/413 pelo conteúdo, como passar de 100 chaves ou
//   64 KB; 401, 403, 404, 409): repetir daria o mesmo erro. A alteração volta ao que
//   está gravado e o professor vê o motivo.
function failureKind(err) {
  const status = Number(err?.status) || 0
  if (status === 0 || err?.network || err?.timeout || status >= 500) return 'retry'
  if (status === 429) return 'later'
  return 'stop'
}

// Espera do 429: retryAfterSeconds (ou retryAfter, em segundos) da resposta; sem ela, a
// espera de sempre.
function retryAfterMs(err) {
  const data = err?.data || {}
  const seconds = Number(data.retryAfterSeconds ?? data.retryAfter)
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : PREFERENCES_RETRY_MS
}

export function PreferencesProvider({ children }) {
  const { auth } = useAuth()
  const toast = useToast()
  const [prefs, setPrefs] = useState({})
  const timer = useRef(null)
  // Alterações ainda não gravadas ({ chave: valor }) e o último estado confirmado pelo servidor.
  const pending = useRef({})
  const confirmed = useRef({})
  const warnedRetry = useRef(false)
  // Quem espera a gravação das alterações pendentes (setPref devolve uma promessa: true
  // quando o servidor gravou, false quando recusou). O formulário do modelo de resposta
  // só se limpa depois do sucesso.
  const waiters = useRef([])
  const toastRef = useRef(toast)
  toastRef.current = toast

  useEffect(() => {
    let alive = true
    clearTimeout(timer.current)
    pending.current = {}
    waiters.current.splice(0).forEach((resolve) => resolve(false))
    if (auth?.role === 'admin') {
      api.get('/api/admin/preferences').then((p) => {
        if (!alive) return
        confirmed.current = p || {}
        setPrefs(p || {})
      }).catch(() => {})
    } else {
      confirmed.current = {}
      setPrefs({})
    }
    return () => { alive = false }
  }, [auth?.role, auth?.email])

  useEffect(() => () => clearTimeout(timer.current), [])

  const flush = useCallback(() => {
    timer.current = null
    const batch = pending.current
    if (!Object.keys(batch).length) return
    pending.current = {}
    const batchWaiters = waiters.current.splice(0)
    api.post('/api/admin/preferences', batch).then((r) => {
      warnedRetry.current = false
      confirmed.current = r?.preferences && typeof r.preferences === 'object' ? r.preferences : { ...confirmed.current, ...batch }
      batchWaiters.forEach((resolve) => resolve(true))
    }).catch((err) => {
      const kind = failureKind(err)
      if (kind === 'stop') {
        // Antes a falha era engolida: o modelo novo aparecia na tela e sumia ao recarregar.
        // Volta cada chave recusada ao valor gravado (se não mudou de novo nesse meio tempo).
        setPrefs((cur) => {
          const next = { ...cur }
          for (const key of Object.keys(batch)) {
            if (Object.prototype.hasOwnProperty.call(pending.current, key) || next[key] !== batch[key]) continue
            if (Object.prototype.hasOwnProperty.call(confirmed.current, key)) next[key] = confirmed.current[key]
            else delete next[key]
          }
          return next
        })
        toastRef.current?.error(`Preferência não salva: ${err.message}`)
        batchWaiters.forEach((resolve) => resolve(false))
        return
      }
      // Rede ou servidor fora (ou 429): guarda de novo (sem passar por cima de uma
      // alteração mais nova) e tenta outra vez; avisa uma vez só.
      pending.current = { ...batch, ...pending.current }
      waiters.current = [...batchWaiters, ...waiters.current]
      if (!warnedRetry.current) {
        warnedRetry.current = true
        if (kind === 'later') toastRef.current?.warning(err.message || PREFERENCES_RETRY_MESSAGE)
        else toastRef.current?.warning(PREFERENCES_RETRY_MESSAGE)
      }
      clearTimeout(timer.current)
      timer.current = setTimeout(() => flushRef.current(), kind === 'later' ? retryAfterMs(err) : PREFERENCES_RETRY_MS)
    })
  }, [])
  const flushRef = useRef(flush)
  flushRef.current = flush

  // Grava qualquer personalização por conta (debounce), para persistir entre sessões.
  // As chaves alteradas dentro da espera vão juntas (antes só a última chegava ao servidor).
  // Devolve uma promessa: true quando o servidor gravou, false quando recusou.
  const setPref = useCallback((key, value) => {
    setPrefs((cur) => ({ ...cur, [key]: value }))
    pending.current = { ...pending.current, [key]: value }
    const saved = new Promise((resolve) => { waiters.current.push(resolve) })
    clearTimeout(timer.current)
    timer.current = setTimeout(() => flushRef.current(), PREFERENCES_SAVE_DELAY_MS)
    return saved
  }, [])

  const pref = useCallback((key, def) => (prefs[key] !== undefined ? prefs[key] : def), [prefs])

  return <PrefsCtx.Provider value={{ prefs, pref, setPref }}>{children}</PrefsCtx.Provider>
}

export const usePreferences = () => useContext(PrefsCtx)
