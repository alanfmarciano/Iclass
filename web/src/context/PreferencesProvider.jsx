import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import { api } from '../lib/api'
import { useAuth } from './AuthProvider'

const PrefsCtx = createContext({ prefs: {}, pref: () => undefined, setPref: () => {} })

export function PreferencesProvider({ children }) {
  const { auth } = useAuth()
  const [prefs, setPrefs] = useState({})
  const timer = useRef(null)

  useEffect(() => {
    let alive = true
    if (auth?.role === 'admin') {
      api.get('/api/admin/preferences').then((p) => { if (alive) setPrefs(p || {}) }).catch(() => {})
    } else {
      setPrefs({})
    }
    return () => { alive = false }
  }, [auth?.role, auth?.email])

  // Grava qualquer personalização por conta (debounce), para persistir entre sessões.
  const setPref = useCallback((key, value) => {
    setPrefs((cur) => ({ ...cur, [key]: value }))
    clearTimeout(timer.current)
    timer.current = setTimeout(() => { api.post('/api/admin/preferences', { [key]: value }).catch(() => {}) }, 400)
  }, [])

  const pref = useCallback((key, def) => (prefs[key] !== undefined ? prefs[key] : def), [prefs])

  return <PrefsCtx.Provider value={{ prefs, pref, setPref }}>{children}</PrefsCtx.Provider>
}

export const usePreferences = () => useContext(PrefsCtx)
