import { useEffect, useMemo, useState } from 'react'
import { Save, Building2, GraduationCap, LayoutGrid, Check, Layers3, RotateCcw, BookmarkPlus, Trash2, Play, SwatchBook } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import { PageState } from '../../components/ui/PageState'
import { PageHeader } from '../../components/ui/PageHeader'
import { useApi } from '../../hooks/useApi'
import { api } from '../../lib/api'
import { useToast } from '../../context/ToastProvider'
import { useAuth } from '../../context/AuthProvider'
import { useBranding } from '../../context/BrandingProvider'
import { ADMIN_PERMISSIONS, canAccessAdminPermission } from '../../lib/adminPermissions'

const PALETTE = ['#ef4444', '#6d28d9', '#2563eb', '#059669', '#d97706', '#db2777', '#0891b2', '#111827']
const SCOPES = [
  { id: 'system', label: 'Sistema', icon: LayoutGrid },
  { id: 'school', label: 'Escola', icon: Building2 },
  { id: 'course', label: 'Curso', icon: GraduationCap },
]

function initials(n) { return (n || 'IC').split(' ').map((x) => x[0]).slice(0, 2).join('').toUpperCase() }

function ColorRow({ label, value, placeholder, disabled, onChange }) {
  return (
    <div className="min-w-0 flex flex-col gap-1.5">
      <span className="text-sm font-medium text-text">{label}</span>
      <div className="flex items-center gap-2">
        <input aria-label={`${label}: seletor de cor`} type="color" value={value || placeholder || '#888888'} disabled={disabled} onChange={(e) => onChange(e.target.value)} className="h-[38px] w-12 rounded-md bg-surface border border-border" />
        <Input aria-label={`${label}: valor hexadecimal`} value={value || ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} placeholder={placeholder || 'herda'} className="min-w-0 w-full font-mono" />
      </div>
    </div>
  )
}

const INTERFACE_PRESETS = [
  { id: 'premium', name: 'Premium', description: 'Profundo, sofisticado e imersivo.' },
  { id: 'lumen', name: 'Lumen', description: 'Claro, editorial e focado em fluidez.' },
]

const VISUAL_THEME_KEYS = [
  'primaryColor', 'secondaryColor', 'themeMode', 'palettePreset', 'interfacePreset',
  'accentColor', 'successColor', 'warningColor', 'dangerColor',
  'radius', 'density', 'fontHeading', 'fontBody', 'fontScale',
  'loginLayout', 'loginBgUrl', 'loginBgColor', 'customCss',
]

const FACTORY_VISUAL = {
  primaryColor: '#ef4444', secondaryColor: '', themeMode: 'auto', palettePreset: '', interfacePreset: 'premium',
  accentColor: '', successColor: '', warningColor: '', dangerColor: '',
  radius: 'padrao', density: 'confortavel', fontHeading: 'Inter', fontBody: 'Inter', fontScale: 'padrao',
  loginLayout: 'centralizado', loginBgUrl: '', loginBgColor: '', customCss: '',
}

const THEME_MODE_LABELS = { light: 'Claro', dark: 'Escuro', auto: 'Automático' }

function normalizeInterfacePreset(value) {
  return INTERFACE_PRESETS.some((preset) => preset.id === value) ? value : 'premium'
}

function InterfaceMiniPreview({ preset }) {
  if (preset === 'lumen') {
    return (
      <div aria-hidden className="h-28 overflow-hidden rounded-xl border border-[#dfe2d9] bg-[#f0f2eb] p-2.5 shadow-inner">
        <div className="mb-2 flex h-4 items-center justify-between rounded-md bg-white px-1.5 shadow-[0_1px_4px_rgba(20,25,35,.08)]">
          <span className="h-2 w-2 rounded-[3px] bg-[#171a24]" />
          <span className="flex gap-1"><i className="h-1.5 w-5 rounded-full bg-[#dfe2d9]" /><i className="h-1.5 w-5 rounded-full bg-[#dfe2d9]" /><i className="h-1.5 w-5 rounded-full bg-[#3048e8]" /></span>
          <span className="h-2 w-2 rounded-[3px] bg-[#c8f04b]" />
        </div>
        <div className="grid h-[70px] grid-cols-[1.65fr_.7fr] gap-2">
          <div className="relative overflow-hidden rounded-lg bg-[#3048e8] p-2">
            <span className="block h-1.5 w-12 rounded-full bg-white/45" />
            <span className="mt-2 block h-2 w-20 rounded-full bg-white/90" />
            <span className="mt-1 block h-1.5 w-14 rounded-full bg-white/35" />
            <span className="absolute bottom-2 left-2 h-3 w-9 rounded bg-[#c8f04b]" />
            <span className="absolute -right-3 -top-4 h-12 w-12 rounded-full border border-white/25" />
          </div>
          <div className="grid gap-2"><span className="rounded-lg bg-white shadow-[0_1px_4px_rgba(20,25,35,.07)]" /><span className="rounded-lg bg-white shadow-[0_1px_4px_rgba(20,25,35,.07)]" /></div>
        </div>
      </div>
    )
  }

  return (
    <div aria-hidden className="h-28 overflow-hidden rounded-xl border border-[#222936] bg-[#090c13] p-2.5 shadow-inner">
      <div className="flex h-full gap-2">
        <div className="flex w-7 flex-col items-center gap-2 rounded-lg bg-[#111722] py-2">
          <span className="h-2.5 w-2.5 rounded-[4px] bg-[#ef4444]" />
          <span className="h-1.5 w-3 rounded-full bg-[#ef4444]/70" />
          <span className="h-1.5 w-3 rounded-full bg-white/15" />
          <span className="h-1.5 w-3 rounded-full bg-white/15" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex h-3 items-center justify-between"><span className="h-1.5 w-10 rounded-full bg-white/30" /><span className="h-2 w-8 rounded-full bg-white/10" /></div>
          <div className="h-9 rounded-lg border border-white/10 bg-gradient-to-r from-[#171d28] to-[#29171c] p-2"><span className="block h-1.5 w-16 rounded-full bg-white/65" /><span className="mt-1.5 block h-1 w-10 rounded-full bg-[#ef4444]" /></div>
          <div className="mt-2 grid grid-cols-3 gap-1.5"><span className="h-7 rounded-md border border-white/10 bg-[#151a24]" /><span className="h-7 rounded-md border border-white/10 bg-[#151a24]" /><span className="h-7 rounded-md border border-white/10 bg-[#151a24]" /></div>
        </div>
      </div>
    </div>
  )
}

function InterfaceStyleCard({ preset, selected, effective, inherited, disabled, onSelect }) {
  const active = selected || effective
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      tabIndex={active ? 0 : -1}
      disabled={disabled}
      onClick={onSelect}
      className={`group relative rounded-2xl border p-2.5 text-left transition-all duration-300 disabled:cursor-not-allowed disabled:opacity-60 ${active ? 'border-primary bg-primary-soft ring-2 ring-primary/20' : 'border-border bg-surface hover:-translate-y-0.5 hover:border-[var(--border-strong)] hover:shadow-md'}`}
    >
      <InterfaceMiniPreview preset={preset.id} />
      <span className="flex items-start gap-2 px-1 pb-1 pt-3">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-semibold text-text">{preset.name}{inherited && <small className="rounded-full bg-surface-2 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted">Herdado</small>}</span>
          <span className="mt-1 block text-[11px] leading-relaxed text-muted">{preset.description}</span>
        </span>
        <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border transition ${active ? 'border-primary bg-primary text-primary-fg' : 'border-border text-transparent group-hover:border-[var(--border-strong)]'}`}><Check size={12} strokeWidth={3} /></span>
      </span>
    </button>
  )
}

function LumenLivePreview({ name, primary, secondary }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-[#dfe2d9] bg-[#f2f3ed] p-3" style={{ height: 300 }}>
      <div className="flex h-11 items-center gap-2 rounded-xl bg-white px-3 shadow-[0_4px_16px_rgba(23,26,36,.07)]">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-[#171a24] text-[9px] font-bold text-white">{initials(name)}</span>
        <span className="min-w-0 truncate text-[10px] font-bold text-[#171a24]">{name}</span>
        <span className="ml-auto hidden gap-1 sm:flex"><i className="h-5 w-12 rounded-lg bg-[#f2f3ed]" /><i className="h-5 w-12 rounded-lg bg-[#f2f3ed]" /><i className="h-5 w-12 rounded-lg bg-[#e8ebff]" /></span>
        <span className="h-7 w-7 rounded-lg bg-[#c8f04b]" />
      </div>
      <div className="mt-3 grid grid-cols-[1.55fr_.72fr] gap-3">
        <div className="relative h-[124px] overflow-hidden rounded-2xl bg-[#3048e8] p-4 text-white shadow-[0_18px_35px_rgba(48,72,232,.2)]">
          <span className="block text-[7px] font-bold uppercase tracking-[.15em] text-white/65">Visão geral</span>
          <strong className="mt-2 block max-w-[70%] text-base leading-tight">Aprendizado em movimento</strong>
          <span className="mt-2 block h-1.5 w-20 rounded-full bg-white/35"><i className="block h-full w-14 rounded-full" style={{ background: primary }} /></span>
          <span className="absolute bottom-3 left-4 rounded-lg bg-[#c8f04b] px-2.5 py-1.5 text-[7px] font-bold text-[#243000]">Continuar</span>
          <span className="absolute -right-5 -top-7 h-24 w-24 rounded-full border border-white/20" />
        </div>
        <div className="grid gap-3">
          <span className="rounded-2xl bg-white p-3 shadow-[0_4px_16px_rgba(23,26,36,.06)]"><i className="block h-2 w-8 rounded-full bg-[#dfe2d9]" /><strong className="mt-3 block text-lg text-[#171a24]">248</strong></span>
          <span className="rounded-2xl bg-[#171a24] p-3"><i className="block h-2 w-9 rounded-full bg-white/20" /><strong className="mt-3 block text-lg" style={{ color: secondary || '#c8f04b' }}>72%</strong></span>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {[58, 82, 43].map((width, index) => <span key={width} className="h-[76px] rounded-xl border border-[#e1e4dc] bg-white p-3"><i className="block h-2 w-10 rounded-full bg-[#dfe2d9]" /><i className="mt-5 block h-1.5 rounded-full bg-[#eceee8]"><b className="block h-full rounded-full bg-[#3048e8]" style={{ width: `${width}%` }} /></i><small className="mt-2 block text-[7px] text-[#626862]">Módulo {index + 1}</small></span>)}
      </div>
    </div>
  )
}

export default function IdentidadePage() {
  const { auth } = useAuth()
  const { refreshBranding } = useBranding()
  const isProfessor = auth.accountRole === 'professor'
  const { data: schools, setData: setSchools } = useApi('/api/admin/schools')
  const { data: courses, setData: setCourses } = useApi('/api/courses')
  const toast = useToast()

  const [scope, setScope] = useState(isProfessor ? 'school' : 'system')
  const [schoolId, setSchoolId] = useState('')
  const [courseId, setCourseId] = useState('')
  const canManage = scope === 'system'
    ? canAccessAdminPermission(auth, ADMIN_PERMISSIONS.BRANDING_MANAGE)
    : scope === 'course'
      ? canAccessAdminPermission(auth, ADMIN_PERMISSIONS.COURSE_MANAGE)
      : (canAccessAdminPermission(auth, ADMIN_PERMISSIONS.BRANDING_MANAGE) || isProfessor)
  const [form, setForm] = useState({})
  const [inherited, setInherited] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [themeName, setThemeName] = useState('')
  const [themeLibraryBusy, setThemeLibraryBusy] = useState(false)

  useEffect(() => { if (!schoolId && schools?.length) setSchoolId(schools[0].id) }, [schools])
  useEffect(() => { if (!courseId && courses?.length) setCourseId(courses[0].id) }, [courses])
  useEffect(() => setThemeName(''), [scope, schoolId, courseId])

  const target = useMemo(() => {
    if (scope === 'school') return (schools || []).find((s) => s.id === schoolId)
    if (scope === 'course') return (courses || []).find((c) => c.id === courseId)
    return null
  }, [scope, schoolId, courseId, schools, courses])

  useEffect(() => {
    let alive = true
    async function load() {
      setLoading(true)
      try {
        if (scope === 'system') {
          const raw = await api.get('/api/branding?raw=1')
          const eff = await api.get('/api/branding')
          if (alive) { setForm(raw || {}); setInherited(eff || {}) }
        } else if (scope === 'school') {
          const eff = await api.get('/api/branding')
          if (alive) { setForm((target && target.branding) || {}); setInherited(eff || {}) }
        } else {
          const parentUrl = target?.schoolId
            ? `/api/branding?schoolId=${encodeURIComponent(target.schoolId)}`
            : '/api/branding'
          const eff = await api.get(parentUrl)
          if (alive) { setForm((target && target.branding) || {}); setInherited(eff || {}) }
        }
      } catch (e) { toast.error(e.message) } finally { if (alive) setLoading(false) }
    }
    if ((scope === 'school' && !target) || (scope === 'course' && !target)) { setLoading(false); return }
    load()
    return () => { alive = false }
  }, [scope, schoolId, courseId, target?.id])

  const set = (patch) => setForm((f) => ({ ...f, ...patch }))
  const val = (k) => (form[k] !== undefined && form[k] !== '' ? form[k] : (inherited[k] || ''))
  const primary = form.primaryColor || inherited.primaryColor || '#ef4444'
  const name = val('displayName') || 'Instituição'

  const rawInterfacePreset = form.interfacePreset || ''
  const validInterfacePreset = INTERFACE_PRESETS.some((preset) => preset.id === rawInterfacePreset)
  const inheritsInterface = scope !== 'system' && rawInterfacePreset === ''
  const effectiveInterfacePreset = validInterfacePreset ? rawInterfacePreset : normalizeInterfacePreset(inherited.interfacePreset)
  const effectiveInterfaceName = INTERFACE_PRESETS.find((preset) => preset.id === effectiveInterfacePreset)?.name || 'Premium'
  const savedThemes = Array.isArray(form.savedThemes) ? form.savedThemes : []

  const handleInterfaceKeys = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    const radios = [...event.currentTarget.querySelectorAll('[role="radio"]:not([disabled])')]
    if (!radios.length) return
    event.preventDefault()
    const current = Math.max(0, radios.indexOf(document.activeElement))
    const nextIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? radios.length - 1
        : (current + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) + radios.length) % radios.length
    radios[nextIndex].focus()
    radios[nextIndex].click()
  }

  function cacheTargetBranding(patch) {
    if (scope === 'school') {
      setSchools((current) => (current || []).map((school) => school.id === schoolId ? { ...school, branding: { ...(school.branding || {}), ...patch } } : school))
    } else if (scope === 'course') {
      setCourses((current) => (current || []).map((course) => course.id === courseId ? { ...course, branding: { ...(course.branding || {}), ...patch } } : course))
    }
  }

  const captureThemeValues = () => Object.fromEntries(VISUAL_THEME_KEYS.map((key) => {
    if (key === 'interfacePreset') return [key, effectiveInterfacePreset]
    const ownValue = form[key]
    if (ownValue !== undefined && ownValue !== '') return [key, String(ownValue)]
    const inheritedValue = inherited[key]
    if (inheritedValue !== undefined && inheritedValue !== '') return [key, String(inheritedValue)]
    return [key, FACTORY_VISUAL[key] || '']
  }))

  async function persistSavedThemes(nextThemes) {
    setThemeLibraryBusy(true)
    try {
      if (scope === 'system') await api.post('/api/branding', { savedThemes: nextThemes })
      else if (scope === 'school') await api.post('/api/admin/schools/update', { id: schoolId, branding: { savedThemes: nextThemes } })
      else await api.put(`/api/courses/${encodeURIComponent(courseId)}`, { branding: { savedThemes: nextThemes } })
      cacheTargetBranding({ savedThemes: nextThemes })
      setForm((current) => ({ ...current, savedThemes: nextThemes }))
      return true
    } catch (error) {
      toast.error(error.message)
      return false
    } finally {
      setThemeLibraryBusy(false)
    }
  }

  async function saveCurrentTheme(event) {
    event.preventDefault()
    const name = themeName.trim()
    if (!name) { toast.warning('Dê um nome ao tema antes de salvar.'); return }
    const existingIndex = savedThemes.findIndex((theme) => String(theme.name || '').toLocaleLowerCase('pt-BR') === name.toLocaleLowerCase('pt-BR'))
    const existing = existingIndex >= 0 ? savedThemes[existingIndex] : null
    if (!existing && savedThemes.length >= 24) { toast.warning('Você pode salvar no máximo 24 temas neste nível.'); return }
    const entry = {
      id: existing?.id || `visual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      createdAt: new Date().toISOString(),
      values: captureThemeValues(),
    }
    const nextThemes = existing ? savedThemes.map((theme, index) => index === existingIndex ? entry : theme) : [...savedThemes, entry]
    if (await persistSavedThemes(nextThemes)) {
      setThemeName('')
      toast.success(existing ? `Tema “${name}” atualizado.` : `Tema “${name}” salvo para usar depois.`)
    }
  }

  function applySavedTheme(theme) {
    setForm((current) => ({ ...current, ...theme.values }))
    toast.info(`Tema “${theme.name}” carregado. Clique em Salvar para aplicar.`)
  }

  async function deleteSavedTheme(theme) {
    if (!window.confirm(`Excluir o tema salvo “${theme.name}”?`)) return
    if (await persistSavedThemes(savedThemes.filter((item) => item.id !== theme.id))) toast.success(`Tema “${theme.name}” excluído.`)
  }

  function restoreVisualDefaults() {
    const values = scope === 'system'
      ? FACTORY_VISUAL
      : Object.fromEntries(VISUAL_THEME_KEYS.map((key) => [key, '']))
    setForm((current) => ({ ...current, ...values }))
    toast.info(scope === 'system'
      ? 'Padrões visuais de fábrica carregados. Clique em Salvar para aplicar.'
      : 'Personalizações visuais deste nível foram limpas. Clique em Salvar para voltar a herdar.')
  }

  async function save() {
    setSaving(true)
    try {
      if (scope === 'system') {
        await api.post('/api/branding', form)
      } else if (scope === 'school') {
        await api.post('/api/admin/schools/update', { id: schoolId, branding: form })
      } else {
        await api.put(`/api/courses/${encodeURIComponent(courseId)}`, { branding: form })
      }
      cacheTargetBranding(form)
      if (form.primaryColor) document.documentElement.style.setProperty('--primary', form.primaryColor)
      let refreshFailed = false
      if (typeof refreshBranding === 'function') {
        try { await refreshBranding() } catch { refreshFailed = true }
      }
      if (refreshFailed) toast.warning('Identidade salva. Recarregue a página para aplicar a interface atualizada.')
      else toast.success('Identidade salva')
    } catch (e) { toast.error(e.message) } finally { setSaving(false) }
  }

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <PageHeader title="Identidade visual" subtitle="Personalize a marca por sistema, escola ou curso. Campos vazios herdam o nível acima.">
        {canManage && <Button variant="secondary" icon={RotateCcw} disabled={saving || themeLibraryBusy} onClick={restoreVisualDefaults}>Restaurar padrões</Button>}
        {canManage && <Button icon={Save} loading={saving} disabled={themeLibraryBusy} onClick={save}>Salvar</Button>}
      </PageHeader>

      <div className="inline-flex rounded-lg bg-surface-2 p-1 text-sm">
        {(isProfessor ? SCOPES.filter((s) => s.id === 'school') : SCOPES).map((sc) => (
          <button key={sc.id} type="button" aria-pressed={scope === sc.id} onClick={() => setScope(sc.id)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium ${scope === sc.id ? 'bg-surface text-text shadow-sm' : 'text-muted'}`}>
            <sc.icon size={15} /> {sc.label}
          </button>
        ))}
      </div>

      {scope === 'school' && (
        <Select label="Escola" value={schoolId} onChange={(e) => setSchoolId(e.target.value)}>
          {(schools || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
      )}
      {scope === 'course' && (
        <Select label="Curso" value={courseId} onChange={(e) => setCourseId(e.target.value)}>
          {(courses || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      )}

      <PageState loading={loading}>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
          <div className="bg-surface border border-border rounded-xl p-5 space-y-4">
            <Input label="Nome de exibição" value={form.displayName || ''} disabled={!canManage} onChange={(e) => set({ displayName: e.target.value })} placeholder={inherited.displayName || 'Herda o nível acima'} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Input label="Nome curto" value={form.shortName || ''} disabled={!canManage} onChange={(e) => set({ shortName: e.target.value })} placeholder={inherited.shortName || initials(name)} />
              <Select label="Tema" value={form.themeMode || ''} disabled={!canManage} onChange={(e) => set({ themeMode: e.target.value })}>
                <option value="">Herda ({inherited.themeMode || 'auto'})</option>
                <option value="light">Claro</option>
                <option value="dark">Escuro</option>
                <option value="auto">Automático</option>
              </Select>
            </div>
            <section className="border-y border-border py-5" aria-labelledby="interface-style-title">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary"><Layers3 size={17} /></span>
                  <div><h2 id="interface-style-title" className="text-sm font-semibold text-text">Estilo da interface</h2><p className="mt-1 max-w-md text-[11px] leading-relaxed text-muted">Escolha a organização visual do aplicativo. Cores, logo e conteúdo continuam personalizados abaixo.</p></div>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${!validInterfacePreset && rawInterfacePreset ? 'bg-danger-soft text-danger' : 'bg-success-soft text-success'}`}>
                  {!validInterfacePreset && rawInterfacePreset ? 'Seleção inválida' : inheritsInterface ? `Herdado: ${effectiveInterfaceName}` : `Selecionado: ${effectiveInterfaceName}`}
                </span>
              </div>

              {scope !== 'system' && (
                <button
                  type="button"
                  disabled={!canManage}
                  onClick={() => set({ interfacePreset: '' })}
                  className={`mb-3 flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${inheritsInterface ? 'border-primary bg-primary-soft' : 'border-border bg-surface-2 hover:border-[var(--border-strong)]'}`}
                  aria-pressed={inheritsInterface}
                >
                  <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${inheritsInterface ? 'bg-primary text-primary-fg' : 'bg-surface text-muted'}`}>{inheritsInterface ? <Check size={15} strokeWidth={3} /> : <RotateCcw size={15} />}</span>
                  <span className="min-w-0 flex-1"><span className="block text-xs font-semibold text-text">Herdar estilo {scope === 'school' ? 'do sistema' : 'da escola'}</span><span className="mt-0.5 block text-[10px] text-muted">Usará {normalizeInterfacePreset(inherited.interfacePreset) === 'lumen' ? 'Lumen' : 'Premium'} enquanto a configuração superior não mudar.</span></span>
                </button>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Estilo da interface" onKeyDown={handleInterfaceKeys}>
                {INTERFACE_PRESETS.map((preset) => {
                  const selected = scope === 'system'
                    ? (validInterfacePreset ? rawInterfacePreset === preset.id : effectiveInterfacePreset === preset.id)
                    : rawInterfacePreset === preset.id
                  const effective = effectiveInterfacePreset === preset.id
                  return <InterfaceStyleCard key={preset.id} preset={preset} selected={selected} effective={effective} inherited={inheritsInterface && effective} disabled={!canManage} onSelect={() => set({ interfacePreset: preset.id })} />
                })}
              </div>
              <p className="mt-3 text-[10px] leading-relaxed text-subtle">A escolha fica somente nesta prévia até você clicar em <span className="font-semibold text-text">Salvar</span>. O estilo não altera dados, permissões ou conteúdo dos cursos.</p>
            </section>
            <section className="border-b border-border pb-5" aria-labelledby="saved-themes-title">
              <div className="mb-4 flex items-start gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-info-soft text-info"><SwatchBook size={17} /></span>
                <div>
                  <h2 id="saved-themes-title" className="text-sm font-semibold text-text">Meus temas salvos</h2>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted">Guarde as cores e o estilo visual atuais neste nível para alternar depois. Nome e logos não entram no tema.</p>
                </div>
              </div>

              <form className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[minmax(0,1fr)_auto]" onSubmit={saveCurrentTheme}>
                <Input label="Nome do tema" value={themeName} maxLength={60} disabled={!canManage || themeLibraryBusy} onChange={(event) => setThemeName(event.target.value)} placeholder="Ex.: Azul institucional" />
                <Button type="submit" variant="secondary" icon={BookmarkPlus} loading={themeLibraryBusy} disabled={!canManage}>Salvar tema atual</Button>
              </form>

              {savedThemes.length > 0 ? (
                <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {savedThemes.map((theme) => {
                    const values = theme.values || {}
                    const presetName = normalizeInterfacePreset(values.interfacePreset) === 'lumen' ? 'Lumen' : 'Premium'
                    const modeName = THEME_MODE_LABELS[values.themeMode] || 'Automático'
                    return (
                      <article key={theme.id} className="rounded-xl border border-border bg-surface-2 p-3">
                        <div className="flex items-start gap-3">
                          <span className="flex shrink-0 -space-x-1" aria-hidden="true">
                            <i className="h-8 w-8 rounded-lg border-2 border-surface" style={{ background: values.primaryColor || '#ef4444' }} />
                            <i className="h-8 w-8 rounded-lg border-2 border-surface" style={{ background: values.secondaryColor || '#c8f04b' }} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <strong className="block truncate text-xs text-text">{theme.name}</strong>
                            <small className="mt-1 block text-[10px] text-muted">{presetName} · {modeName}</small>
                          </span>
                          <button type="button" disabled={!canManage || themeLibraryBusy} onClick={() => deleteSavedTheme(theme)} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-subtle transition hover:bg-danger-soft hover:text-danger disabled:opacity-50" aria-label={`Excluir tema ${theme.name}`}><Trash2 size={15} /></button>
                        </div>
                        <Button type="button" variant="ghost" size="sm" icon={Play} disabled={!canManage || themeLibraryBusy} onClick={() => applySavedTheme(theme)} className="mt-2 w-full">Carregar para aplicar</Button>
                      </article>
                    )
                  })}
                </div>
              ) : <p className="mt-4 rounded-xl border border-dashed border-border px-3 py-4 text-center text-[11px] text-subtle">Nenhum tema salvo neste nível.</p>}
              <p className="mt-3 text-[10px] leading-relaxed text-subtle">Salvar um tema cria uma cópia reutilizável sem alterar a interface ativa. Depois de carregar um tema, use o botão <span className="font-semibold text-text">Salvar</span> no topo para aplicá-lo.</p>
            </section>
            <Input label="Logo (tema claro) — URL" value={form.logoLightUrl || ''} disabled={!canManage} onChange={(e) => set({ logoLightUrl: e.target.value })} placeholder="https://... ou /uploads/..." />
            <Input label="Logo (tema escuro) — URL" value={form.logoDarkUrl || ''} disabled={!canManage} onChange={(e) => set({ logoDarkUrl: e.target.value })} placeholder="opcional (usa o claro)" />
            <Input label="Favicon — URL" value={form.faviconUrl || ''} disabled={!canManage} onChange={(e) => set({ faviconUrl: e.target.value })} placeholder="opcional" />
            <Input label="Login: mensagem de boas-vindas" value={form.loginWelcome || ''} disabled={!canManage} onChange={(e) => set({ loginWelcome: e.target.value })} placeholder={inherited.loginWelcome || 'opcional'} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text">Cor primária</label>
                <div className="flex items-center gap-2">
                  <input aria-label="Cor primária: seletor" type="color" value={form.primaryColor || inherited.primaryColor || '#ef4444'} disabled={!canManage} onChange={(e) => set({ primaryColor: e.target.value })} className="h-[38px] w-12 rounded-md bg-surface border border-border" />
                  <Input aria-label="Cor primária: valor hexadecimal" value={form.primaryColor || ''} disabled={!canManage} onChange={(e) => set({ primaryColor: e.target.value })} placeholder={inherited.primaryColor || '#ef4444'} className="font-mono" />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text">Cor secundária</label>
                <div className="flex items-center gap-2">
                  <input aria-label="Cor secundária: seletor" type="color" value={form.secondaryColor || inherited.secondaryColor || '#22d3a7'} disabled={!canManage} onChange={(e) => set({ secondaryColor: e.target.value })} className="h-[38px] w-12 rounded-md bg-surface border border-border" />
                  <Input aria-label="Cor secundária: valor hexadecimal" value={form.secondaryColor || ''} disabled={!canManage} onChange={(e) => set({ secondaryColor: e.target.value })} placeholder="opcional" className="font-mono" />
                </div>
              </div>
            </div>
            <div>
              <p className="text-sm font-medium text-text mb-2">Paletas</p>
              <div className="flex gap-2 flex-wrap">
                {PALETTE.map((c) => (
                  <button key={c} disabled={!canManage} onClick={() => set({ primaryColor: c })} aria-label={c}
                    className={`w-7 h-7 rounded-md border border-border ${(form.primaryColor || '').toLowerCase() === c ? 'ring-2 ring-text' : ''}`} style={{ background: c }} />
                ))}
              </div>
            </div>
            <div className="pt-3 border-t border-border">
              <p className="text-sm font-medium text-text mb-2">Cores avançadas</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <ColorRow label="Destaque" value={form.accentColor} placeholder={inherited.accentColor} disabled={!canManage} onChange={(v) => set({ accentColor: v })} />
                <ColorRow label="Sucesso" value={form.successColor} placeholder={inherited.successColor} disabled={!canManage} onChange={(v) => set({ successColor: v })} />
                <ColorRow label="Alerta" value={form.warningColor} placeholder={inherited.warningColor} disabled={!canManage} onChange={(v) => set({ warningColor: v })} />
                <ColorRow label="Erro" value={form.dangerColor} placeholder={inherited.dangerColor} disabled={!canManage} onChange={(v) => set({ dangerColor: v })} />
              </div>
            </div>
            <div className="pt-3 border-t border-border space-y-3">
              <p className="text-sm font-medium text-text">Tela de login</p>
              <ColorRow label="Cor de fundo" value={form.loginBgColor} placeholder={inherited.loginBgColor} disabled={!canManage} onChange={(v) => set({ loginBgColor: v })} />
              <Input label="Imagem de fundo — URL" value={form.loginBgUrl || ''} disabled={!canManage} onChange={(e) => set({ loginBgUrl: e.target.value })} placeholder="opcional" />
            </div>
          </div>

          <div>
            <p className="text-xs text-muted mb-2">Pré-visualização ao vivo</p>
            {effectiveInterfacePreset === 'lumen'
              ? <LumenLivePreview name={name} primary={primary} secondary={form.secondaryColor || inherited.secondaryColor} />
              : <div className="rounded-2xl border border-border overflow-hidden" style={{ background: '#0d1117' }}>
              <div className="flex" style={{ height: 300 }}>
                <div className="w-20 p-3 flex flex-col items-center gap-4" style={{ background: '#131a24' }}>
                  <span className="w-9 h-9 rounded-lg grid place-items-center text-white text-xs font-semibold" style={{ background: primary }}>{initials(name)}</span>
                  <div className="w-5 h-5 rounded" style={{ background: primary, opacity: 0.9 }} />
                  <div className="w-5 h-5 rounded bg-white/10" />
                  <div className="w-5 h-5 rounded bg-white/10" />
                </div>
                <div className="flex-1 p-4" style={{ color: '#e8edf6' }}>
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-sm font-semibold truncate">{name}</span>
                    <span className="text-xs px-3 py-1.5 rounded-md text-white" style={{ background: primary }}>Ação</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mb-4">
                    <div className="rounded-lg p-3" style={{ background: '#131a24' }}><p className="text-[11px] mb-1.5" style={{ color: '#8b95a5' }}>Alunos</p><p className="text-xl font-semibold">248</p></div>
                    <div className="rounded-lg p-3" style={{ background: '#131a24' }}><p className="text-[11px] mb-1.5" style={{ color: '#8b95a5' }}>Progresso</p><p className="text-xl font-semibold" style={{ color: form.secondaryColor || inherited.secondaryColor || primary }}>72%</p></div>
                  </div>
                  <div className="flex gap-4 mb-2" style={{ borderBottom: '1px solid #1f2733' }}>
                    <span className="text-xs pb-2" style={{ borderBottom: `2px solid ${primary}` }}>Visão geral</span>
                    <span className="text-xs pb-2" style={{ color: '#8b95a5' }}>Turmas</span>
                  </div>
                  <div className="h-1 rounded" style={{ background: '#1f2733' }}><div className="h-full rounded" style={{ width: '72%', background: primary }} /></div>
                </div>
              </div>
            </div>}
            {scope !== 'system' && <p className="text-xs text-subtle mt-2">Editando <span className="text-text font-medium">{scope === 'school' ? 'a escola' : 'o curso'}</span>: {target?.name}. Campos vazios herdam do nível acima.</p>}
          </div>
        </div>
      </PageState>
    </div>
  )
}
