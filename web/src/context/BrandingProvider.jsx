import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useAuth } from './AuthProvider'
import { useTheme } from './ThemeProvider'

const INTERFACE_PRESETS = new Set(['premium', 'lumen'])
const normalizeInterfacePreset = (value) => INTERFACE_PRESETS.has(value) ? value : 'premium'
const BrandingCtx = createContext({ branding: null, brandingReady: false, interfacePreset: 'premium', refreshBranding: () => {} })

function hexToRgb(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || '').trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}
function darken(hex, amt) {
  const c = hexToRgb(hex); if (!c) return hex
  const f = (v) => Math.max(0, Math.round(v * (1 - amt))).toString(16).padStart(2, '0')
  return `#${f(c.r)}${f(c.g)}${f(c.b)}`
}
function rgba(hex, a) { const c = hexToRgb(hex); return c ? `rgba(${c.r},${c.g},${c.b},${a})` : hex }
function readableFg(hex) {
  const c = hexToRgb(hex); if (!c) return '#ffffff'
  const channel = (value) => {
    const normalized = value / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }
  const lum = 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
  const contrastWithBlack = (lum + 0.05) / 0.05
  const contrastWithWhite = 1.05 / (lum + 0.05)
  return contrastWithBlack >= contrastWithWhite ? '#000000' : '#ffffff'
}

export function BrandingProvider({ children }) {
  const { auth } = useAuth()
  const { setTheme } = useTheme()
  const [branding, setBranding] = useState(null)
  const [brandingReady, setBrandingReady] = useState(false)
  const [revision, setRevision] = useState(0)
  const loadedScopeRef = useRef(null)

  const courseId = useMemo(() => {
    if (auth?.role === 'student') {
      return auth?.activeClass?.courseId || auth?.student?.classes?.[0]?.courseId || ''
    }
    return auth?.activeWorkspace?.courseId || ''
  }, [auth])

  useEffect(() => {
    let alive = true
    if (loadedScopeRef.current !== courseId) {
      loadedScopeRef.current = courseId
      setBranding(null)
      setBrandingReady(false)
    }
    const url = `/api/branding${courseId ? `?courseId=${encodeURIComponent(courseId)}` : ''}`
    api.get(url, { auth: false })
      .then((b) => { if (alive) { setBranding(b); setBrandingReady(true) } })
      .catch(() => { if (alive) { setBranding(null); setBrandingReady(true) } })
    return () => { alive = false }
  }, [courseId, revision])

  const refreshBranding = useCallback(() => setRevision((value) => value + 1), [])
  const interfacePreset = normalizeInterfacePreset(branding?.interfacePreset)
  const currentScopeReady = brandingReady && loadedScopeRef.current === courseId

  useLayoutEffect(() => {
    const root = document.documentElement
    root.dataset.interface = interfacePreset
    if (!branding) {
      ['--primary', '--primary-hover', '--primary-fg', '--primary-soft', '--primary-glow', '--secondary', '--secondary-fg', '--success', '--warning', '--danger', '--info'].forEach((property) => root.style.removeProperty(property))
      document.querySelector("link[rel='icon'][data-branding-managed='true']")?.remove()
      document.title = 'IClass'
      return
    }
    const primary = branding.primaryColor || '#ef4444'
    root.style.setProperty('--primary', primary)
    root.style.setProperty('--primary-hover', darken(primary, 0.14))
    root.style.setProperty('--primary-fg', readableFg(primary))
    root.style.setProperty('--primary-soft', rgba(primary, 0.16))
    root.style.setProperty('--primary-glow', rgba(primary, 0.22))
    const optionalTokens = [
      ['--secondary', branding.secondaryColor],
      ['--success', branding.successColor],
      ['--warning', branding.warningColor],
      ['--danger', branding.dangerColor],
      ['--info', branding.accentColor],
    ]
    optionalTokens.forEach(([property, value]) => value ? root.style.setProperty(property, value) : root.style.removeProperty(property))
    if (branding.secondaryColor) root.style.setProperty('--secondary-fg', readableFg(branding.secondaryColor))
    else root.style.removeProperty('--secondary-fg')
    document.title = branding.displayName || 'IClass'
    let favicon = document.querySelector("link[rel='icon'][data-branding-managed='true']")
    if (branding.faviconUrl) {
      if (!favicon) { favicon = document.createElement('link'); favicon.rel = 'icon'; favicon.dataset.brandingManaged = 'true'; document.head.appendChild(favicon) }
      favicon.href = branding.faviconUrl
    } else favicon?.remove()
  }, [branding, interfacePreset])

  useEffect(() => {
    const mode = branding?.themeMode
    if (mode === 'light' || mode === 'dark') {
      setTheme(mode)
      return undefined
    }
    if (mode !== 'auto' || typeof window === 'undefined' || !window.matchMedia) return undefined
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const applySystemTheme = () => setTheme(media.matches ? 'dark' : 'light')
    applySystemTheme()
    media.addEventListener?.('change', applySystemTheme)
    return () => media.removeEventListener?.('change', applySystemTheme)
  }, [branding?.themeMode, setTheme])

  return (
    <BrandingCtx.Provider value={{ branding, brandingReady: currentScopeReady, interfacePreset, refreshBranding }}>
      {currentScopeReady ? children : (
        <div className="grid h-full place-items-center bg-bg text-text" role="status" aria-label="Carregando identidade visual">
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-primary" aria-hidden="true" />
        </div>
      )}
    </BrandingCtx.Provider>
  )
}

export const useBranding = () => useContext(BrandingCtx)
