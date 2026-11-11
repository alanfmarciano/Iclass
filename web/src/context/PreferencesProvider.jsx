import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import { api } from '../lib/api'
import { useAuth } from './AuthProvider'
import { useToast } from './ToastProvider'

const PrefsCtx = createContext({ prefs: {}, pref: () => undefined, setPref: () => {} })

// Espera entre uma alteração e a gravação (várias alterações seguidas vão num pedido só).
export const PREFERENCES_SAVE_DELAY_MS = 400
// Nova tentativa depois de uma falha de rede ou do servidor (503).
export const PREFERENCES_RETRY_MS = 5000
export const PREFERENCES_RETRY_MESSAGE = 'Não foi possível salvar sua preferência agora. O IClass tenta de novo em instantes.'

// Recusa pelo conteúdo (fase 2, H9b: ENG-03): o servidor responde 400 quando as
// preferências passam de 100 chaves ou 64 KB (por exemplo, modelos de resposta demais).
// Repetir daria o mesmo erro; a alteração volta ao que está gravado e o professor vê o motivo.
function refusedByContent(err) {
  return err?.status === 400 || err?.status === 413
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
  const toastRef = useRef(toast)
  toastRef.current = toast

  useEffect(() => {
    let alive = true
    clearTimeout(timer.current)
    pending.current = {}
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
    api.post('/api/admin/preferences', batch).then((r) => {
      warnedRetry.current = false
      confirmed.current = r?.preferences && typeof r.preferences === 'object' ? r.preferences : { ...confirmed.current, ...batch }
    }).catch((err) => {
      if (refusedByContent(err)) {
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
        return
      }
      // Rede ou servidor fora: guarda de novo (sem passar por cima de uma alteração mais
      // nova) e tenta outra vez; avisa uma vez só.
      pending.current = { ...batch, ...pending.current }
      if (!warnedRetry.current) {
        warnedRetry.current = true
        toastRef.current?.warning(PREFERENCES_RETRY_MESSAGE)
      }
      clearTimeout(timer.current)
      timer.current = setTimeout(() => flushRef.current(), PREFERENCES_RETRY_MS)
    })
  }, [])
  const flushRef = useRef(flush)
  flushRef.current = flush

  // Grava qualquer personalização por conta (debounce), para persistir entre sessões.
  // As chaves alteradas dentro da espera vão juntas (antes só a última chegava ao servidor).
  const setPref = useCallback((key, value) => {
    setPrefs((cur) => ({ ...cur, [key]: value }))
    pending.current = { ...pending.current, [key]: value }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => flushRef.current(), PREFERENCES_SAVE_DELAY_MS)
  }, [])

  const pref = useCallback((key, def) => (prefs[key] !== undefined ? prefs[key] : def), [prefs])

  return <PrefsCtx.Provider value={{ prefs, pref, setPref }}>{children}</PrefsCtx.Provider>
}

export const usePreferences = () => useContext(PrefsCtx)
