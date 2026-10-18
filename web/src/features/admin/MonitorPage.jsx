import { useState, useEffect, useMemo, useRef } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { AlertTriangle, ArrowRight, Ban, CheckCircle2, Clock, Copy, Eye, GitBranch, History, Keyboard, Library, ListFilter, MonitorPlay, Pause, Pencil, Play, Send, Square, Trash2, Unlock, Users } from 'lucide-react'
import { Card } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { Select } from '../../components/ui/Select'
import { Input } from '../../components/ui/Input'
import { Textarea } from '../../components/ui/Textarea'
import { EmptyState } from '../../components/ui/EmptyState'
import { Modal } from '../../components/ui/Modal'
import { PageHeader } from '../../components/ui/PageHeader'
import { useApi } from '../../hooks/useApi'
import { api } from '../../lib/api'
import { useToast } from '../../context/ToastProvider'
import { useAdminWorkspace } from '../../hooks/useAdminWorkspace'
import { classTimeExtraFeedback, resolveMonitorTimer } from './monitorTimer'
import { deliveryLabel, deliveryTone } from './attemptDelivery'
import { FinishApplicationModal } from './FinishApplicationModal'
import { StudentAnswersModal } from './StudentAnswersModal'

const ACTIVE_EXAM_STATUSES = new Set(['running', 'waiting', 'paused'])
const ACTIVE_EXAM_STATUS_PRIORITY = { running: 0, waiting: 1, paused: 2 }
const DEFAULT_WAITING_ROOM_MINUTES = 10
const STATUS = { online: ['success', 'Online'], active: ['success', 'Online'], blur: ['warning', 'Saiu da aba'], absent: ['neutral', 'Ausente'], ausente: ['neutral', 'Ausente'], finished: ['info', 'Finalizou'], focus_locked: ['danger', 'Foco bloqueado'], time_over: ['warning', 'Tempo esgotado'] }
const EXAM_STATUS = {
  prepared: ['neutral', 'Preparada'],
  running: ['success', 'Em andamento'],
  waiting: ['warning', 'Sala de espera'],
  paused: ['warning', 'Pausada'],
  finished: ['info', 'Finalizada'],
}
const REPORT_REASON_LABELS = {
  sem_resposta_correta: 'Nenhuma resposta correta',
  duas_corretas: 'Mais de uma resposta correta',
  enunciado_confuso: 'Enunciado confuso',
  erro_digitacao: 'Erro de digitação',
  outro: 'Outro',
}

function fmt(sec) { if (sec == null) return '-'; const m = Math.floor(sec / 60), s = sec % 60; return `${m}:${String(s).padStart(2, '0')}` }
function formatApplicationTimestamp(value) {
  if (!value) return 'Data não informada'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'Data não informada'
  return date.toLocaleString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace('.', '')
}
function isActiveExamConfig(config) { return !!config && (ACTIVE_EXAM_STATUSES.has(config.status) || config.onlineActive === true) }
function examStatusLabel(status) { return EXAM_STATUS[status]?.[1] || status || 'Ativa' }
function examStatusTone(status) { return EXAM_STATUS[status]?.[0] || 'neutral' }
function applicationTime(application) {
  const value = application?.startsAt || application?.createdAt || 0
  const parsed = typeof value === 'number' ? value : new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}
function keystrokeText(ev) {
  if (ev.kind === 'clipboard') return ev.key === 'cut' ? '✂ recortar' : '⧉ copiar'
  if (ev.kind === 'contextmenu') return '☰ menu (botão direito)'
  if (ev.mods) return `${ev.mods}+${(ev.key || '').toUpperCase()}`
  if (ev.key === ' ') return '␣ espaço'
  if (ev.key === 'Enter') return '⏎ enter'
  if (ev.key === 'Backspace') return '⌫ backspace'
  if (ev.key === 'Tab') return '⇥ tab'
  return ev.key || ev.code || '?'
}
function focusLogLabel(log) {
  const type = log?.eventType
  if (type === 'tab_blur') return 'Foco perdido'
  if (type === 'tab_focus') return 'Foco recuperado'
  if (type === 'exam_left') return 'Saiu da prova'
  if (type === 'exam_return') return 'Retornou a prova'
  return type || 'Evento'
}

/* ────────────────────────────────────────────────────────────────────────
 * KeystrokeViewer — leitura legível dos comandos capturados (Fase 1)
 * Dicionário canônico (§4.1 do plano): rótulo humano + gravidade por evento.
 * Tudo é derivado no cliente a partir do que o backend já entrega.
 * ──────────────────────────────────────────────────────────────────────── */

// Re-deriva a intenção do atalho a partir de mods+key (o backend guarda kind, não o reason).
function shortcutReason(ev) {
  const k = (ev.key || '').toLowerCase()
  const mods = ev.mods || ''
  const ctrlOrMeta = /Ctrl|Meta/.test(mods)
  const alt = /Alt/.test(mods)
  const shift = /Shift/.test(mods)
  if (ctrlOrMeta && ['c', 'x'].includes(k)) return 'copiar_recortar'
  if (ctrlOrMeta && k === 'v') return 'colar'
  if (ctrlOrMeta && ['f', 'p', 's'].includes(k)) return 'buscar_imprimir_salvar'
  if (ctrlOrMeta && shift && ['i', 'j', 'c'].includes(k)) return 'devtools'
  if (k === 'f12') return 'devtools'
  if (alt && k === 'g') return 'assistente_ia'
  if (/Meta/.test(mods)) return 'tecla_sistema'
  return 'atalho'
}

const SHORTCUT_INFO = {
  copiar_recortar: { label: 'Tentou copiar / recortar', icon: '⧉', sev: 'high' },
  colar: { label: 'Colou conteúdo', icon: '📋', sev: 'med' },
  buscar_imprimir_salvar: { label: 'Buscar / imprimir / salvar página', icon: '🔎', sev: 'med' },
  devtools: { label: 'Abriu ferramentas de desenvolvedor', icon: '🛠', sev: 'high' },
  assistente_ia: { label: 'Atalho de assistente de IA (Alt+G)', icon: '✨', sev: 'high' },
  tecla_sistema: { label: 'Tecla de sistema', icon: '⊞', sev: 'low' },
  atalho: { label: 'Atalho de teclado', icon: '⌘', sev: 'low' },
}
const LOG_INFO = {
  tab_blur: { label: 'Saiu do foco da prova', icon: '⇄', sev: 'high' },
  exam_left: { label: 'Fechou ou recarregou a prova', icon: '⎋', sev: 'high' },
  fullscreen_exit: { label: 'Saiu da tela cheia', icon: '⛶', sev: 'high' },
}
const ALERT_LOG_TYPES = new Set(Object.keys(LOG_INFO))
const SEV_RANK = { high: 3, med: 2, low: 1 }

// Classifica um keystroke → { reason, label, icon, sev }. Char/key não são comandos.
function classifyKeystroke(ev) {
  if (ev.kind === 'clipboard') {
    const cut = ev.key === 'cut'
    return { reason: 'clipboard', label: cut ? 'Recorte bloqueado' : 'Cópia bloqueada', icon: cut ? '✂' : '⧉', sev: 'high' }
  }
  if (ev.kind === 'contextmenu') return { reason: 'contextmenu', label: 'Menu do botão direito', icon: '☰', sev: 'med' }
  if (ev.kind === 'paste') return { reason: 'paste', label: `Colou ${ev.pasteLen != null ? ev.pasteLen + ' caracteres' : 'conteúdo'}`, icon: '📋', sev: 'high' }
  if (ev.kind === 'shortcut') {
    const r = shortcutReason(ev)
    return { reason: r, ...(SHORTCUT_INFO[r] || SHORTCUT_INFO.atalho) }
  }
  return { reason: ev.kind || 'key', label: keystrokeText(ev), icon: '•', sev: 'low' }
}
const isTypingEvent = (ev) => ev.kind === 'char' || ev.kind === 'key'
const evTime = (ev) => Number(ev.serverTs) || Number(ev.clientTs) || 0

// Monta a linha do tempo unificada (keystrokes + logs de foco), ordenada por tempo.
function buildItems(events, logs) {
  const ks = (events || []).map((ev) => {
    const t = evTime(ev)
    if (isTypingEvent(ev)) return { cat: 'type', kind: ev.kind, key: ev.key, t, ev }
    const info = classifyKeystroke(ev)
    return { cat: 'cmd', kind: ev.kind, key: ev.key, mods: ev.mods, t, sig: info.reason, ...info, ev }
  })
  const lg = (logs || []).filter((l) => ALERT_LOG_TYPES.has(l.eventType)).map((l) => {
    const info = LOG_INFO[l.eventType]
    return { cat: 'cmd', kind: 'focus', t: Number(l.timestamp) || 0, sig: l.eventType, ...info, log: l }
  })
  return [...ks, ...lg].sort((a, b) => a.t - b.t)
}

// Agrupa a linha do tempo: digitação vira bloco único; comandos iguais em sequência colapsam.
function groupStream(items) {
  const segs = []
  let typing = null
  const flush = () => { if (typing) { segs.push({ type: 'typing', ...typing }); typing = null } }
  for (const it of items) {
    if (it.cat === 'type') {
      if (!typing) typing = { text: '', keys: 0, corr: 0, start: it.t, end: it.t }
      typing.keys++; typing.end = it.t
      if (it.key === 'Backspace') { typing.text = typing.text.slice(0, -1); typing.corr++ }
      else if (it.key === 'Enter') typing.text += ' ⏎ '
      else if (it.kind === 'char') typing.text += it.key === ' ' ? ' ' : (it.key || '')
    } else {
      flush()
      const last = segs[segs.length - 1]
      if (last && last.type === 'cmd' && last.sig === it.sig) { last.count++; last.end = it.t }
      else segs.push({ type: 'cmd', count: 1, end: it.t, ...it })
    }
  }
  flush()
  return segs
}

// Alertas = comandos de gravidade média/alta + logs de foco, com duplicados consecutivos colapsados.
function buildAlerts(items) {
  const out = []
  for (const it of items) {
    if (it.cat !== 'cmd') continue
    if (SEV_RANK[it.sev] < SEV_RANK.med) continue
    const last = out[out.length - 1]
    if (last && last.sig === it.sig) { last.count++; last.lastT = it.t }
    else out.push({ ...it, count: 1, lastT: it.t })
  }
  return out
}

function buildCounters(items) {
  const c = { copy: 0, paste: 0, focus: 0, ia: 0, devtools: 0, menu: 0 }
  for (const it of items) {
    if (it.cat !== 'cmd') continue
    if (it.reason === 'copiar_recortar' || it.reason === 'clipboard') c.copy++
    else if (it.reason === 'colar' || it.reason === 'paste') c.paste++
    else if (it.reason === 'assistente_ia') c.ia++
    else if (it.reason === 'devtools') c.devtools++
    else if (it.reason === 'contextmenu') c.menu++
    if (it.kind === 'focus') c.focus++
  }
  return c
}

function buildTimeline(items, now, binMs = 10000, bins = 30) {
  const end = now
  const start = end - binMs * bins
  const arr = Array.from({ length: bins }, () => ({ count: 0, sus: false }))
  for (const it of items) {
    if (it.t < start || it.t > end) continue
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((it.t - start) / binMs)))
    arr[idx].count++
    if (it.cat === 'cmd' && SEV_RANK[it.sev] >= SEV_RANK.med) arr[idx].sus = true
  }
  const max = Math.max(1, ...arr.map((b) => b.count))
  return { arr, max, start, end }
}

const SEV_TONE = { high: 'danger', med: 'warning', low: 'subtle' }
const hhmmss = (t) => (t ? new Date(t).toLocaleTimeString('pt-BR', { hour12: false }) : '')

function exportKeystrokesCsv(events, name) {
  const header = ['seq', 'hora', 'questao', 'tipo', 'rotulo', 'gravidade', 'tecla', 'mods', 'suspeito', 'bloqueado']
  const lines = (events || []).map((ev) => {
    const info = isTypingEvent(ev) ? { label: 'digitação', sev: '-' } : classifyKeystroke(ev)
    return [ev.seq ?? '', ev.serverTs ? new Date(ev.serverTs).toLocaleString('pt-BR') : '', ev.question ?? '', ev.kind ?? '', info.label, info.sev, ev.key ?? '', ev.mods ?? '', ev.suspicious ? 'sim' : 'nao', ev.blocked ? 'sim' : 'nao']
  })
  const csv = [header, ...lines].map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `digitacao-${String(name || 'aluno').replace(/\s+/g, '_')}.csv`
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function Stat({ k, v, sub, warn }) {
  return (
    <div className="px-4 py-3 bg-surface">
      <div className="text-[11px] uppercase tracking-wide text-subtle mb-1.5">{k}</div>
      <div className={`text-xl font-bold font-mono leading-none ${warn ? 'text-danger' : 'text-text'}`}>{v}</div>
      {sub && <div className={`text-[11px] mt-1.5 ${warn ? 'text-danger' : 'text-subtle'}`}>{sub}</div>}
    </div>
  )
}

function KeystrokeViewer({ events, row, loading }) {
  const [tab, setTab] = useState('resumo')
  const [susOnly, setSusOnly] = useState(false)
  const logs = row?.logs || []
  const items = useMemo(() => buildItems(events, logs), [events, logs])
  const alerts = useMemo(() => buildAlerts(items), [items])
  const counters = useMemo(() => buildCounters(items), [items])
  const stream = useMemo(() => groupStream(items), [items])
  const timeline = useMemo(() => buildTimeline(items, Date.now()), [items])
  const suspCount = alerts.reduce((n, a) => n + a.count, 0)
  const focusExits = counters.focus
  const lastTs = row?.lastKeystrokeAt || (items.length ? items[items.length - 1].t : null)
  const lastAgo = lastTs ? Math.max(0, Math.round((Date.now() - lastTs) / 1000)) : null

  const counterCards = [
    { n: counters.copy, l: 'Cópia / recorte bloqueados', ic: '⧉', tone: 'danger' },
    { n: counters.ia, l: 'Atalho de IA (Alt+G)', ic: '✨', tone: 'danger' },
    { n: counters.devtools, l: 'Ferramentas de dev', ic: '🛠', tone: 'danger' },
    { n: counters.paste, l: 'Colagens sinalizadas', ic: '📋', tone: 'warning' },
    { n: counters.menu, l: 'Menu do botão direito', ic: '☰', tone: 'warning' },
    { n: focusExits, l: 'Saídas de foco', ic: '⇄', tone: 'warning' },
  ].filter((c) => c.n > 0)

  return (
    <div className="space-y-4">
      {/* STATS */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-border rounded-lg overflow-hidden border border-border">
        <Stat k="Eventos capturados" v={row?.keystrokeCount ?? events.length} sub={lastAgo != null ? `última atividade há ${lastAgo}s` : 'aguardando'} />
        <Stat k="Comandos suspeitos" v={suspCount} sub={suspCount ? 'ver aba Resumo' : 'nenhum'} warn={suspCount > 0} />
        <Stat k="Progresso" v={row?.progress || '—'} sub="respondidas / total" />
        <Stat k="Saídas de foco" v={focusExits} sub={focusExits ? 'prova pausou' : 'sem saídas'} warn={focusExits > 0} />
      </div>

      {/* TABS + FILTRO */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="inline-flex bg-surface-2 border border-border rounded-lg p-1">
          <button onClick={() => setTab('resumo')} className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-md text-xs font-semibold transition ${tab === 'resumo' ? 'bg-primary text-primary-fg' : 'text-muted hover:text-text'}`}>
            Resumo {suspCount > 0 && <span className="font-mono text-[10px] rounded px-1.5 bg-danger text-white">{suspCount}</span>}
          </button>
          <button onClick={() => setTab('stream')} className={`px-3.5 py-1.5 rounded-md text-xs font-semibold transition ${tab === 'stream' ? 'bg-primary text-primary-fg' : 'text-muted hover:text-text'}`}>
            Fluxo completo
          </button>
          <button disabled title="Disponível com questões dissertativas" className="px-3.5 py-1.5 rounded-md text-xs font-semibold text-subtle opacity-40 cursor-not-allowed">Texto 🔒</button>
        </div>
        <label className="inline-flex items-center gap-2 text-xs text-muted cursor-pointer select-none ml-auto">
          <input type="checkbox" checked={susOnly} onChange={(e) => setSusOnly(e.target.checked)} className="accent-danger" />
          Só suspeitos
        </label>
        {loading && <span className="text-[11px] text-subtle">carregando…</span>}
      </div>

      {/* BODY */}
      <div className="max-h-[52vh] overflow-y-auto pr-1">
        {tab === 'resumo' && (
          <div className="space-y-4">
            {counterCards.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                {counterCards.map((c, i) => (
                  <div key={i} className={`flex items-center gap-3 rounded-xl border p-3 ${c.tone === 'danger' ? 'bg-danger-soft border-danger/30' : 'bg-warning-soft border-warning/30'}`}>
                    <div className="w-9 h-9 shrink-0 grid place-items-center rounded-lg bg-surface-2 text-base">{c.ic}</div>
                    <div>
                      <div className={`text-xl font-bold font-mono leading-none ${c.tone === 'danger' ? 'text-danger' : 'text-warning'}`}>{c.n}</div>
                      <div className="text-[11px] text-subtle mt-0.5">{c.l}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div>
              <div className="text-[11px] uppercase tracking-wide text-subtle mb-2.5 px-0.5">Comandos capturados — em ordem</div>
              {alerts.length === 0 ? (
                <div className="rounded-xl border border-success/25 bg-success-soft px-4 py-6 text-center">
                  <div className="text-2xl mb-1">✓</div>
                  <p className="text-sm text-success font-medium">Nenhum comando suspeito até agora</p>
                  <p className="text-xs text-subtle mt-1">Atalhos, cópia, colagem e saídas de foco apareceriam aqui.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {alerts.map((a, i) => {
                    const tone = SEV_TONE[a.sev]
                    const cls = tone === 'danger' ? 'bg-danger-soft border-danger/25' : 'bg-warning-soft border-warning/25'
                    const ttone = tone === 'danger' ? 'text-danger' : 'text-warning'
                    return (
                      <div key={i} className={`flex items-center gap-3 rounded-xl border p-3 ${cls}`}>
                        <div className="w-9 h-9 shrink-0 grid place-items-center rounded-lg bg-surface-2 text-base">{a.icon}</div>
                        <div className="flex-1 min-w-0">
                          <div className={`text-sm font-semibold flex items-center gap-2 flex-wrap ${ttone}`}>
                            {a.label}
                            {a.count > 1 && <span className="font-mono text-[10px] font-bold rounded-full px-1.5 py-0.5 bg-surface-2 text-danger border border-danger/30">×{a.count}</span>}
                            {a.kind === 'focus' && <span className="text-[10px] font-semibold uppercase rounded-full px-2 py-0.5 bg-surface-2 text-warning border border-warning/30">pausou a prova</span>}
                          </div>
                          {(a.mods || a.key) && a.kind !== 'focus' && <div className="text-[11px] text-subtle mt-0.5 font-mono">{[a.mods, a.key].filter(Boolean).join('+')}</div>}
                        </div>
                        <div className="font-mono text-[11px] text-subtle whitespace-nowrap">{hhmmss(a.lastT || a.t)}</div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* TIMELINE */}
            <div className="rounded-xl border border-border bg-surface-2 p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[11px] uppercase tracking-wide text-subtle">Ritmo de atividade · últimos 5 min</span>
                <span className="text-[10px] text-subtle flex gap-3">
                  <span className="inline-flex items-center gap-1"><b className="w-2 h-2 rounded-sm inline-block bg-primary" />teclas</span>
                  <span className="inline-flex items-center gap-1"><b className="w-2 h-2 rounded-sm inline-block bg-danger" />suspeito</span>
                </span>
              </div>
              <div className="flex items-end gap-0.5 h-14">
                {timeline.arr.map((b, i) => (
                  <div key={i} className={`flex-1 rounded-t-sm ${b.sus ? 'bg-danger' : 'bg-primary'} ${b.count ? 'opacity-90' : 'opacity-20'}`} style={{ height: `${Math.max(6, (b.count / timeline.max) * 100)}%` }} title={`${b.count} evento(s)`} />
                ))}
              </div>
            </div>
          </div>
        )}

        {tab === 'stream' && (
          <div>
            <p className="text-[11.5px] text-subtle mb-3">Eventos agrupados na ordem em que aconteceram: digitação normal vira um bloco só; cada comando fica destacado. “Só suspeitos” esconde os blocos de digitação.</p>
            {stream.length === 0 && !loading && <p className="text-sm text-muted text-center py-8">Nenhuma digitação registrada ainda.</p>}
            <div className="space-y-2">
              {stream.map((seg, i) => {
                if (seg.type === 'typing') {
                  if (susOnly) return null
                  return (
                    <div key={i} className="flex items-center gap-3 rounded-xl border border-border bg-surface-2 p-2.5">
                      <div className="w-8 h-8 shrink-0 grid place-items-center rounded-lg bg-surface text-sm">⌨</div>
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-[13px] text-text break-words leading-snug">{seg.text.trim() || <span className="text-subtle">(teclas sem campo de texto)</span>}</div>
                        <div className="text-[11px] text-subtle mt-0.5">{seg.keys} tecla(s){seg.corr ? ` · ${seg.corr} correção(ões)` : ''} · {hhmmss(seg.start)}{seg.end !== seg.start ? ` → ${hhmmss(seg.end)}` : ''}</div>
                      </div>
                    </div>
                  )
                }
                const tone = SEV_TONE[seg.sev]
                const cls = tone === 'danger' ? 'bg-danger-soft border-danger/28' : tone === 'warning' ? 'bg-warning-soft border-warning/28' : 'bg-surface-2 border-border'
                const ttone = tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-muted'
                return (
                  <div key={i} className={`flex items-center gap-3 rounded-xl border p-2.5 ${cls}`}>
                    <div className="w-8 h-8 shrink-0 grid place-items-center rounded-lg bg-surface text-sm">{seg.icon}</div>
                    <div className="flex-1 min-w-0">
                      <div className={`text-[13px] font-semibold flex items-center gap-2 flex-wrap ${ttone}`}>
                        {seg.label}
                        {seg.count > 1 && <span className="font-mono text-[10px] font-bold rounded-full px-1.5 bg-surface-2 text-danger border border-danger/30">×{seg.count}</span>}
                        {(seg.mods || seg.key) && seg.kind !== 'focus' && <span className="font-mono text-[10px] text-subtle bg-surface border border-border rounded px-1.5">{[seg.mods, seg.key].filter(Boolean).join('+')}</span>}
                      </div>
                    </div>
                    <div className="font-mono text-[11px] text-subtle whitespace-nowrap">{hhmmss(seg.t)}</div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* FOOT */}
      <div className="flex items-center gap-2 pt-2 border-t border-border text-[11.5px] text-subtle">
        <span className="text-success">●</span> Captura ativa · atualiza a cada 2s
        <Button size="sm" variant="secondary" className="ml-auto" onClick={() => exportKeystrokesCsv(events, row?.name)}>Exportar histórico (CSV)</Button>
      </div>
    </div>
  )
}

export default function MonitorPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { courseId: activeCourseId, courseName, className: activeClassName } = useAdminWorkspace()
  const { data: classes, refetch: refetchClasses } = useApi(`/api/admin/classes?courseId=${encodeURIComponent(activeCourseId)}&studentClass=${encodeURIComponent(activeClassName)}`)
  const [className, setClassName] = useState(activeClassName)
  const [courseId, setCourseId] = useState(activeCourseId)
  const [examKey, setExamKey] = useState('')
  const [applicationId, setApplicationId] = useState('')
  const [applications, setApplications] = useState([])
  const [applicationCatalog, setApplicationCatalog] = useState([])
  const [applicationChooserOpen, setApplicationChooserOpen] = useState(false)
  const [applicationChooserLoading, setApplicationChooserLoading] = useState(false)
  const [applicationSearch, setApplicationSearch] = useState('')
  const [finishOpen, setFinishOpen] = useState(false)
  const [finishSummary, setFinishSummary] = useState(null)
  const [finishBusy, setFinishBusy] = useState(null)
  const [releaseBusy, setReleaseBusy] = useState(false)
  const [reportGroups, setReportGroups] = useState([])
  const [reportTotal, setReportTotal] = useState(0)
  const [previewIssue, setPreviewIssue] = useState(null)
  const [correctIssue, setCorrectIssue] = useState(null)
  const [annulIssue, setAnnulIssue] = useState(null)
  const [replaceIssue, setReplaceIssue] = useState(null)
  const [bankQuestions, setBankQuestions] = useState([])
  const [issueBusy, setIssueBusy] = useState(null)
  const [rows, setRows] = useState([])
  const [rowsSyncedAt, setRowsSyncedAt] = useState(() => Date.now())
  const [waitMinutes, setWaitMinutes] = useState(DEFAULT_WAITING_ROOM_MINUTES)
  const [clockNow, setClockNow] = useState(() => Date.now())
  const [analytics, setAnalytics] = useState(null)
  const [messageHistory, setMessageHistory] = useState([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [answersFor, setAnswersFor] = useState(null) // aluno cuja prova/respostas está aberta
  const [keystrokeWatch, setKeystrokeWatch] = useState(null) // { email, name }
  const [keystrokeEvents, setKeystrokeEvents] = useState([])
  const [keystrokeLoading, setKeystrokeLoading] = useState(false)
  const [err, setErr] = useState(null)
  const timer = useRef(null)
  const keystrokeTimer = useRef(null)
  const toast = useToast()
  const activeApplicationsPath = `/api/admin/exam-applications?courseId=${encodeURIComponent(activeCourseId)}&studentClass=${encodeURIComponent(activeClassName)}`
  const activeApplicationsRequest = useApi(activeApplicationsPath, [activeCourseId, activeClassName], { pollMs: 5000 })

  const courseClasses = useMemo(() => (classes || []).filter((c) => !activeCourseId || c.courseId === activeCourseId), [classes, activeCourseId])
  const activeApplications = useMemo(() => (activeApplicationsRequest.data?.applications || [])
    .filter((application) => ACTIVE_EXAM_STATUSES.has(application.status))
    .sort((a, b) => (ACTIVE_EXAM_STATUS_PRIORITY[a.status] ?? 99) - (ACTIVE_EXAM_STATUS_PRIORITY[b.status] ?? 99) || applicationTime(b) - applicationTime(a)), [activeApplicationsRequest.data])
  const selectedClass = useMemo(() => courseClasses.find((c) => c.name === className && (!courseId || c.courseId === courseId)), [courseClasses, className, courseId])
  const selectedApplication = useMemo(() => applications.find((item) => item.id === applicationId) || null, [applications, applicationId])
  const selectedConfig = useMemo(() => {
    const current = selectedClass?.onlineExamConfigs?.[examKey] || {}
    if (!selectedApplication) return current
    const sameCurrentApplication = current.applicationId === selectedApplication.id
    return {
      ...(sameCurrentApplication ? current : {}),
      applicationId: selectedApplication.id,
      status: selectedApplication.status,
      onlineActive: ACTIVE_EXAM_STATUSES.has(selectedApplication.status),
      startTime: selectedApplication.startsAt,
      durationMinutes: selectedApplication.durationMinutes,
      timerEnabled: selectedApplication.timerEnabled,
      timerMode: selectedApplication.timerMode,
      globalTimeAdjustment: selectedApplication.globalTimeAdjustment,
      waitingRoomDuration: selectedApplication.waitingRoomDuration,
      pauses: selectedApplication.pauses || [],
      maxAttempts: selectedApplication.maxAttempts,
      requiresToken: selectedApplication.tokenEnabled === true,
    }
  }, [selectedClass, examKey, selectedApplication])
  const waitingStartsAt = Number(selectedConfig.startTime || 0)
  const waitingHasEnded = selectedConfig.status === 'waiting' && waitingStartsAt > 0 && clockNow >= waitingStartsAt
  const displayedStatus = waitingHasEnded ? 'running' : selectedConfig.status
  const waitingRemaining = selectedConfig.status === 'waiting' && waitingStartsAt > clockNow
    ? Math.ceil((waitingStartsAt - clockNow) / 1000)
    : null
  const monitorTimer = resolveMonitorTimer({ config: selectedConfig, rows, now: clockNow, rowsSyncedAt })
  const examHasStarted = monitorTimer.started
  const examRemaining = monitorTimer.remaining
  const applicationPrepared = selectedConfig.status === 'prepared'
  const applicationFinished = selectedConfig.status === 'finished'
  const activeExamOptions = useMemo(() => applications
    .filter((item) => !['cancelled'].includes(item.status))
    .map((application) => ({ key: application.examKey, application, config: { status: application.status } })), [applications])
  const applicationCatalogGroups = useMemo(() => {
    const query = applicationSearch.trim().toLocaleLowerCase('pt-BR')
    const groups = new Map()
    applicationCatalog
      .filter((application) => application.status !== 'cancelled')
      .filter((application) => !query || `${application.studentClass || ''} ${application.examKey || ''} ${examStatusLabel(application.status)}`.toLocaleLowerCase('pt-BR').includes(query))
      .forEach((application) => {
        const key = `${application.courseId || ''}::${application.studentClass || 'Sem turma'}`
        if (!groups.has(key)) groups.set(key, { key, className: application.studentClass || 'Sem turma', applications: [] })
        groups.get(key).applications.push(application)
      })
    return [...groups.values()]
      .map((group) => ({ ...group, applications: group.applications.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)) }))
      .sort((a, b) => a.className.localeCompare(b.className, 'pt-BR'))
  }, [applicationCatalog, applicationSearch])

  useEffect(() => {
    setCourseId(activeCourseId)
    setClassName(activeClassName)
    if (className && className !== activeClassName) {
      setExamKey('')
      setApplicationId('')
      setApplications([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCourseId, activeClassName, classes])

  useEffect(() => {
    if (!classes?.length) return
    const queryCourseId = searchParams.get('courseId') || activeCourseId
    const queryClassName = searchParams.get('className')
    const queryExamKey = searchParams.get('examKey')
    const queryApplicationId = searchParams.get('applicationId')
    if (queryClassName && (queryClassName !== activeClassName || queryCourseId !== activeCourseId)) return
    const match = (classes || []).find((c) => c.name === activeClassName && c.courseId === activeCourseId)
    if (!match) return
    setCourseId(activeCourseId)
    setClassName(activeClassName)
    if (queryExamKey) setExamKey(queryExamKey)
    if (queryApplicationId) setApplicationId(queryApplicationId)
  }, [classes, searchParams, activeCourseId, activeClassName])

  useEffect(() => {
    let cancelled = false
    if (!selectedClass) {
      setApplications([])
      return () => { cancelled = true }
    }
    const params = new URLSearchParams({ studentClass: selectedClass.name, courseId: selectedClass.courseId || courseId })
    api.get(`/api/admin/exam-applications?${params.toString()}`)
      .then((response) => { if (!cancelled) setApplications(response.applications || []) })
      .catch((error) => { if (!cancelled) setErr(error) })
    return () => { cancelled = true }
  }, [selectedClass, courseId])

  useEffect(() => {
    if (!selectedClass) return
    const selected = activeExamOptions.find((item) => item.application.id === applicationId)
    if (selected) {
      if (examKey !== selected.key) setExamKey(selected.key)
      return
    }
    if (activeExamOptions.length > 0) {
      setApplicationId(activeExamOptions[0].application.id)
      setExamKey(activeExamOptions[0].key)
    } else {
      setApplicationId('')
      setExamKey('')
      setRows([])
    }
  }, [selectedClass, activeExamOptions, applicationId, examKey])

  useEffect(() => {
    setWaitMinutes(DEFAULT_WAITING_ROOM_MINUTES)
  }, [className, examKey, applicationId])

  async function poll() {
    if (!className || !examKey) return
    try {
      const params = new URLSearchParams()
      if (courseId) params.set('courseId', courseId)
      if (applicationId) params.set('applicationId', applicationId)
      const qs = params.toString() ? `?${params.toString()}` : ''
      const [r, reports] = await Promise.all([
        api.get(`/api/admin/monitor-status/${encodeURIComponent(className)}/${encodeURIComponent(examKey)}${qs}`),
        applicationId
          ? api.get(`/api/admin/question-reports/${encodeURIComponent(className)}/${encodeURIComponent(examKey)}?applicationId=${encodeURIComponent(applicationId)}`)
          : Promise.resolve({ groups: [], totalOpen: 0 }),
      ])
      setRows(Array.isArray(r) ? r : (r.monitorList || []))
      setReportGroups(reports.groups || [])
      setReportTotal(Number(reports.totalOpen || 0))
      setRowsSyncedAt(Date.now())
      setErr(null)
    } catch (e) { setErr(e) }
  }

  useEffect(() => {
    clearInterval(timer.current)
    if (className && examKey) { poll(); timer.current = setInterval(poll, 3000) }
    return () => clearInterval(timer.current)
    // eslint-disable-next-line
  }, [className, examKey, courseId, applicationId])

  useEffect(() => {
    setRows([])
    setReportGroups([])
    setReportTotal(0)
    setRowsSyncedAt(Date.now())
  }, [applicationId])

  useEffect(() => {
    const shouldTick = selectedConfig.status === 'waiting'
      || (selectedConfig.status === 'running' && selectedConfig.timerEnabled !== false)
    if (!shouldTick) return
    setClockNow(Date.now())
    const id = setInterval(() => setClockNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [selectedConfig.status, selectedConfig.startTime, selectedConfig.timerEnabled])

  async function fetchKeystrokes(email) {
    if (!className || !examKey || !email) return
    try {
      const params = new URLSearchParams({ email })
      if (applicationId) params.set('applicationId', applicationId)
      const r = await api.get(`/api/admin/exam-keystrokes/${encodeURIComponent(className)}/${encodeURIComponent(examKey)}?${params.toString()}`)
      setKeystrokeEvents(r.events || [])
    } catch (e) {
      setErr(e)
    } finally {
      setKeystrokeLoading(false)
    }
  }

  function openKeystrokeWatch(row) {
    setKeystrokeWatch({ email: row.email, name: row.name || row.email })
    setKeystrokeEvents([])
    setKeystrokeLoading(true)
  }

  useEffect(() => {
    clearInterval(keystrokeTimer.current)
    if (keystrokeWatch?.email) {
      fetchKeystrokes(keystrokeWatch.email)
      keystrokeTimer.current = setInterval(() => fetchKeystrokes(keystrokeWatch.email), 2000)
    }
    return () => clearInterval(keystrokeTimer.current)
    // eslint-disable-next-line
  }, [keystrokeWatch?.email, className, examKey, applicationId])

  async function control(action, extra = {}) {
    try {
      const response = applicationId
        ? await api.post(`/api/admin/exam-applications/${encodeURIComponent(applicationId)}/control`, { action, ...extra })
        : await api.post('/api/admin/server-exam-control', { studentClass: className, courseId, examKey, action, ...extra })
      if (response.application) {
        setApplications((items) => items.map((item) => item.id === response.application.id ? response.application : item))
      }
      const messages = {
        start: 'Prova iniciada. O aviso já está disponível para os alunos.',
        resume: 'Prova retomada. O aviso aos alunos continua ativo.',
        pause: 'Prova pausada. Os alunos verão o estado de pausa.',
        waiting: 'Sala de espera aberta. Os alunos já podem entrar.',
        adjust_waiting: 'Tempo da sala de espera ajustado.',
      }
      toast.success(messages[action] || `Ação concluída: ${action}`)
      await refetchClasses(true)
      await activeApplicationsRequest.refetch(true)
      poll()
      return response
    } catch (e) { toast.error(e.message); return null }
  }

  async function openFinishDecision() {
    if (!applicationId) return
    try {
      const response = await api.get(`/api/admin/exam-applications/${encodeURIComponent(applicationId)}/finish-summary`)
      setFinishSummary(response.summary || {})
      setFinishOpen(true)
    } catch (error) {
      toast.error(error.message)
    }
  }

  async function finishApplication(inProgressPolicy) {
    setFinishBusy(inProgressPolicy)
    const response = await control('finish', { inProgressPolicy })
    setFinishBusy(null)
    if (response) {
      setFinishOpen(false)
      setFinishSummary(null)
    }
  }

  async function dismissReports(group) {
    setIssueBusy(`dismiss-${group.questionNumber}`)
    try {
      await api.post('/api/admin/question-reports/resolve', {
        applicationId,
        questionNumber: group.questionNumber,
      })
      toast.success('Contestações marcadas como revisadas')
      await poll()
    } catch (error) {
      toast.error(error.message)
    } finally {
      setIssueBusy(null)
    }
  }

  function openCorrection(group) {
    const question = group.question || {}
    const alternatives = (question.alternatives || []).map((alternative, index) => ({
      letter: String(alternative.letter || String.fromCharCode(65 + index)).toUpperCase(),
      text: alternative.text || '',
    }))
    const correctAnswer = String(question.correctAnswer || alternatives.find((alternative, index) => question.alternatives?.[index]?.isCorrect)?.letter || alternatives[0]?.letter || 'A').toUpperCase()
    setCorrectIssue({
      group,
      text: question.questionText || question.text || '',
      alternatives,
      correctAnswer,
    })
  }

  async function saveCorrection() {
    if (!correctIssue) return
    setIssueBusy('correct')
    try {
      await api.post('/api/admin/correct-live-question', {
        applicationId,
        questionNumber: correctIssue.group.questionNumber,
        question: {
          text: correctIssue.text,
          alternatives: correctIssue.alternatives,
          correctAnswer: correctIssue.correctAnswer,
        },
      })
      setCorrectIssue(null)
      toast.success('Questão corrigida. Os alunos foram avisados.')
      await poll()
    } catch (error) {
      toast.error(error.message)
    } finally {
      setIssueBusy(null)
    }
  }

  async function annulQuestion() {
    if (!annulIssue) return
    setIssueBusy('annul')
    try {
      await api.post('/api/admin/annul-question', {
        applicationId,
        questionNumber: annulIssue.group.questionNumber,
        mode: annulIssue.mode,
        reason: annulIssue.reason,
      })
      setAnnulIssue(null)
      toast.success('Questão anulada e resultados recalculados.')
      await poll()
    } catch (error) {
      toast.error(error.message)
    } finally {
      setIssueBusy(null)
    }
  }

  async function openReplacement(group) {
    try {
      const response = await api.get('/api/admin/question-bank')
      setBankQuestions(response.questions || [])
      setReplaceIssue({ group, bankQuestionKey: '', extraMinutes: 5, search: '' })
    } catch (error) {
      toast.error(error.message)
    }
  }

  async function replaceQuestion() {
    if (!replaceIssue?.bankQuestionKey) return
    setIssueBusy('replace')
    try {
      await api.post('/api/admin/replace-question', {
        applicationId,
        questionNumber: replaceIssue.group.questionNumber,
        bankQuestionKey: replaceIssue.bankQuestionKey,
        extraMinutes: Number(replaceIssue.extraMinutes) || 0,
      })
      setReplaceIssue(null)
      toast.success('Questão substituída. Os alunos receberão a nova questão em instantes.')
      await refetchClasses(true)
      await poll()
    } catch (error) {
      toast.error(error.message)
    } finally {
      setIssueBusy(null)
    }
  }

  function startApplication() {
    if (selectedConfig.status === 'paused') return control('resume')
    if (selectedConfig.status === 'waiting') return control('start')
    const configuredWaitingSeconds = Math.max(0, Number(selectedApplication?.waitingRoomDuration ?? selectedConfig.waitingRoomDuration) || 0)
    if (configuredWaitingSeconds > 0) {
      return control('waiting', { waitingRoomDuration: configuredWaitingSeconds })
    }
    return control('start')
  }

  async function addTime(targetEmail = null, adjustmentMinutes = 5) {
    try {
      const r = await api.post('/api/admin/adjust-student-time', { studentClass: className, courseId, examKey, applicationId, targetEmail, adjustmentMinutes })
      if (r?.appliesToNextAttempt) toast.info('Ajuste registrado: vale quando o aluno iniciar a tentativa.')
      else if (targetEmail) toast.success('Tempo do aluno ajustado')
      else {
        const feedback = classTimeExtraFeedback(r, adjustmentMinutes)
        toast[feedback.tone](feedback.message)
      }
      if (!targetEmail) await refetchClasses(true)
      poll()
    } catch (e) { toast.error(e.message) }
  }

  async function broadcast(targetEmail = null) {
    const messageText = prompt(targetEmail ? 'Mensagem para o aluno:' : 'Mensagem para a turma:')
    if (!messageText) return
    try {
      await api.post('/api/admin/send-broadcast-message', { studentClass: className, courseId, examKey, applicationId, targetEmail, messageText })
      toast.success('Aviso enviado')
      loadMessageHistory()
    }
    catch (e) { toast.error(e.message) }
  }

  async function loadMessageHistory() {
    if (!className) return
    try {
      const qs = new URLSearchParams({ studentClass: className, courseId, examKey, applicationId }).toString()
      const r = await api.get(`/api/admin/message-history?${qs}`)
      setMessageHistory(r.messages || [])
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function openMessageHistory() {
    await loadMessageHistory()
    setHistoryOpen(true)
  }

  async function deleteMessageHistory(messageId = null) {
    try {
      await api.post('/api/admin/message-history/delete', { messageId, studentClass: className, courseId, examKey, applicationId })
      toast.success(messageId ? 'Mensagem removida do histórico' : 'Histórico limpo')
      loadMessageHistory()
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function waitingRoom() {
    await control('waiting', { waitingRoomDuration: Math.max(0, Number(waitMinutes) || 0) * 60 })
  }

  async function adjustWaiting(minutes) {
    await control('adjust_waiting', { adjustmentSeconds: minutes * 60 })
  }

  async function toggleApplicationChooser() {
    if (applicationChooserOpen) {
      setApplicationChooserOpen(false)
      return
    }
    setApplicationChooserOpen(true)
    setApplicationChooserLoading(true)
    setApplicationSearch('')
    try {
      const params = new URLSearchParams()
      if (activeCourseId) params.set('courseId', activeCourseId)
      if (activeClassName) params.set('studentClass', activeClassName)
      const response = await api.get(`/api/admin/exam-applications${params.toString() ? `?${params.toString()}` : ''}`)
      setApplicationCatalog(response.applications || [])
    } catch (error) {
      toast.error(error.message || 'Não foi possível carregar as aplicações')
    } finally {
      setApplicationChooserLoading(false)
    }
  }

  function selectApplication(application, availableApplications) {
    if (application.courseId !== activeCourseId || application.studentClass !== activeClassName) return toast.error('A aplicação não pertence à turma ativa')
    const nextClass = courseClasses.find((item) => item.name === application.studentClass && (!application.courseId || item.courseId === application.courseId))
    if (!nextClass) return toast.error('A turma desta aplicação não está disponível neste curso')
    const classApplications = (availableApplications || []).filter((item) => item.studentClass === application.studentClass && item.courseId === application.courseId)
    setCourseId(application.courseId || nextClass.courseId || activeCourseId)
    setClassName(application.studentClass)
    setApplications(classApplications.length > 0 ? classApplications : [application])
    setExamKey(application.examKey || '')
    setApplicationId(application.id)
    setApplicationChooserOpen(false)
    setApplicationSearch('')
  }

  function selectCatalogApplication(application) {
    selectApplication(application, applicationCatalog)
  }

  function resumeActiveApplication(application) {
    selectApplication(application, activeApplicationsRequest.data?.applications || activeApplications)
  }

  async function copyToken() {
    const token = applicationId ? sessionStorage.getItem(`exam-token:${applicationId}`) || '' : selectedConfig.accessToken || ''
    if (!token) return toast.info('O token está desativado nesta prova')
    try { await navigator.clipboard.writeText(token); toast.success('Token copiado') }
    catch { toast.error('Não foi possível copiar') }
  }

  async function unlock(email) {
    try { await api.post('/api/admin/unlock-student-focus', { studentEmail: email, studentClass: className, courseId, examKey, applicationId }); toast.success('Aluno desbloqueado'); poll() }
    catch (e) { toast.error(e.message) }
  }

  async function adjustOne(email) {
    const minutes = Number(prompt('Minutos para adicionar ou remover:', '5'))
    if (!Number.isFinite(minutes)) return
    addTime(email, minutes)
  }

  async function assignVersion(email) {
    const version = prompt('Versão do aluno:', 'A')
    if (!version) return
    try { await api.post('/api/admin/assign-student-version', { studentEmail: email, examKey, applicationId, version: version.toUpperCase() }); toast.success('Versão atribuída'); poll() }
    catch (e) { toast.error(e.message) }
  }

  async function loadAnalytics() {
    try { setAnalytics(await api.get(`/api/admin/exam-analytics/${encodeURIComponent(className)}/${encodeURIComponent(examKey)}?applicationId=${encodeURIComponent(applicationId)}`)) }
    catch (e) { toast.error(e.message) }
  }

  function goToResults() {
    const params = new URLSearchParams()
    if (courseId) params.set('courseId', courseId)
    if (className) params.set('studentClass', className)
    if (examKey) params.set('examKey', examKey)
    const qs = params.toString()
    navigate(qs ? `/resultados?${qs}` : '/resultados')
  }

  async function releaseGrades() {
    if (!applicationId) return
    if (!window.confirm('Liberar as notas desta aplicação para os alunos? Eles passarão a ver a nota no portal.')) return
    setReleaseBusy(true)
    try {
      const params = new URLSearchParams()
      if (courseId) params.set('courseId', courseId)
      if (className) params.set('studentClass', className)
      const list = await api.get(`/api/admin/submissions?${params.toString()}`)
      const subs = Array.isArray(list) ? list : (list?.submissions || [])
      const ids = subs
        .filter((s) => String(s.applicationId || '') === String(applicationId) && s.gradePublished !== true)
        .map((s) => s.id)
      if (ids.length === 0) { toast.success('Nenhuma nota pendente para liberar.'); return }
      const res = await api.post('/api/admin/submissions/publish', { ids, published: true })
      toast.success(`${res.updated ?? ids.length} nota(s) liberada(s) para os alunos.`)
    } catch (e) { toast.error(e.message) }
    finally { setReleaseBusy(false) }
  }

  const totalStudents = rows.length
  const online = rows.filter((r) => ['online', 'active'].includes(r.status)).length
  const finished = rows.filter((r) => r.status === 'finished').length
  const started = rows.filter((r) => !['absent', 'ausente'].includes(r.status)).length
  const alerts = rows.filter((r) => r.status === 'blur' || r.status === 'focus_locked' || r.focusLocked).length
  const absent = rows.filter((r) => ['absent', 'ausente'].includes(r.status)).length
  const applicationToken = applicationId ? sessionStorage.getItem(`exam-token:${applicationId}`) || '' : selectedConfig.accessToken || ''

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <PageHeader title="Monitor Online" subtitle={`Acompanhe a prova em tempo real · ${courseName || activeCourseId} · ${activeClassName}.`} />
      {activeApplications.length > 0 && (
        <section className="border-y border-success/45 bg-success-soft/20" aria-labelledby="active-monitor-applications-title">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="relative grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-success-soft text-success" aria-hidden>
                <MonitorPlay size={19} />
                <span className="absolute right-0 top-0 h-2.5 w-2.5 rounded-full bg-success ring-2 ring-bg" />
              </span>
              <div className="min-w-0">
                <h2 id="active-monitor-applications-title" className="font-semibold text-text">Provas em andamento agora</h2>
                <p className="text-xs text-muted">Acesse diretamente o acompanhamento sem procurar a turma novamente.</p>
              </div>
            </div>
            <Badge tone="success" dot>{activeApplications.length} {activeApplications.length === 1 ? 'ativa' : 'ativas'}</Badge>
          </div>
          <div className="divide-y divide-success/20 border-t border-success/25">
            {activeApplications.map((application) => (
              <button
                key={application.id}
                type="button"
                onClick={() => resumeActiveApplication(application)}
                className={`grid w-full gap-3 px-4 py-3 text-left transition hover:bg-success-soft/35 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center ${application.id === applicationId ? 'bg-success-soft/30' : ''}`}
              >
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <strong className="truncate text-sm text-text">{application.examKey}</strong>
                    <Badge tone={examStatusTone(application.status)} dot>{examStatusLabel(application.status)}</Badge>
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                    <span className="font-semibold text-text">Turma {application.studentClass || 'não informada'}</span>
                    <span>{formatApplicationTimestamp(application.startsAt || application.createdAt)}</span>
                  </span>
                </span>
                <span className="inline-flex items-center gap-2 justify-self-start text-sm font-semibold text-success sm:justify-self-end">
                  {application.id === applicationId ? 'Monitor aberto' : 'Retomar monitor'} <ArrowRight size={16} />
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
      <div>
        <span className="mb-2 block text-sm font-semibold text-text">Aplicação monitorada</span>
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border-y border-border py-3 md:grid-cols-[auto_minmax(0,1fr)_auto]">
          <span className="grid h-10 w-10 place-items-center rounded-lg bg-surface-2 text-muted" aria-hidden><MonitorPlay size={18} /></span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-text">{selectedApplication?.examKey || 'Nenhuma aplicação selecionada'}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
              <Badge tone="neutral">{className || 'Sem turma'}</Badge>
              {selectedApplication?.id && <span className="font-mono text-subtle">{selectedApplication.id.slice(0, 16)}</span>}
            </div>
          </div>
          <Button
            className="col-start-2 justify-self-start md:col-start-auto"
            variant="secondary"
            icon={ListFilter}
            onClick={toggleApplicationChooser}
            aria-expanded={applicationChooserOpen}
            aria-controls="monitor-application-chooser"
          >
            {selectedApplication ? 'Trocar aplicação' : 'Escolher aplicação'}
          </Button>
        </div>

        {applicationChooserOpen && (
          <div id="monitor-application-chooser" className="border-b border-border py-4">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <Input
                label="Buscar turma ou prova"
                type="search"
                placeholder="Ex.: 1DES ou FUTEC"
                value={applicationSearch}
                onChange={(event) => setApplicationSearch(event.target.value)}
              />
              <Button variant="ghost" onClick={() => setApplicationChooserOpen(false)}>Fechar</Button>
            </div>
            {applicationChooserLoading ? (
              <p className="py-5 text-sm text-muted">Carregando aplicações...</p>
            ) : applicationCatalogGroups.length === 0 ? (
              <p className="py-5 text-sm text-muted">Nenhuma aplicação encontrada.</p>
            ) : (
              <div className="mt-4 space-y-4">
                {applicationCatalogGroups.map((group) => (
                  <section key={group.key}>
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <h3 className="text-xs font-semibold uppercase tracking-[.12em] text-muted">Turma {group.className}</h3>
                      <span className="text-xs text-subtle">{group.applications.length} {group.applications.length === 1 ? 'aplicação' : 'aplicações'}</span>
                    </div>
                    <div className="grid gap-2 lg:grid-cols-2">
                      {group.applications.map((application) => (
                        <Button
                          key={application.id}
                          variant="secondary"
                          className={`h-auto min-h-14 w-full justify-between px-3 py-2.5 text-left ${application.id === applicationId ? 'border-primary bg-primary-soft' : ''}`}
                          onClick={() => selectCatalogApplication(application)}
                        >
                          <span className="min-w-0">
                            <strong className="block truncate text-sm">{application.examKey}</strong>
                            <span className="mt-0.5 block text-xs font-normal text-muted">{formatApplicationTimestamp(application.createdAt)}</span>
                          </span>
                          <Badge tone={examStatusTone(application.status)} dot>{examStatusLabel(application.status)}</Badge>
                        </Button>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        )}

      </div>

      {!className || !examKey ? (
        <Card><EmptyState icon={Play} title={!className ? 'Selecione uma turma' : 'Nenhuma prova ativa selecionada'} description={!className ? 'Escolha a turma para ver somente as provas ativas dela.' : 'Prepare uma prova em Provas ou escolha uma avaliação ativa para monitorar.'} /></Card>
      ) : (
        <>
          <Card className={`p-4 ${applicationPrepared ? 'border-warning/55 bg-warning-soft/20' : ''} ${applicationFinished ? 'border-info/45 bg-info-soft/15' : ''}`}>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={examStatusTone(displayedStatus)} dot>{waitingHasEnded ? 'Prova liberada' : examStatusLabel(displayedStatus)}</Badge>
                  {applicationFinished && <Badge tone="neutral">Somente leitura</Badge>}
                  {selectedConfig.timerEnabled !== false && <Badge tone="info">{monitorTimer.collective ? 'Cronômetro coletivo' : 'Cronômetro por aluno'}</Badge>}
                  <span className="text-xs text-muted">Turma {className}</span>
                  <span className="text-xs text-muted">{examKey}</span>
                  {applicationId && <span className="text-xs font-mono text-subtle">{applicationId.slice(0, 12)}</span>}
                </div>
                <h2 className="text-lg font-bold text-text">{applicationFinished ? 'Aplicação encerrada — pronta para correção' : applicationPrepared ? 'Aplicação preparada — ainda não iniciada' : 'Aplicação online em acompanhamento'}</h2>
                <p className="text-sm text-muted">{applicationFinished ? 'A prova não está mais visível para os alunos. Nenhuma resposta pode ser enviada.' : applicationPrepared ? 'A prova ainda não aparece para os alunos. Inicie agora ou abra a sala de espera.' : 'A prova já está visível no portal do aluno enquanto permanecer ativa.'}</p>
                {applicationFinished && (
                  <div className="mt-3 flex items-start gap-2 rounded-lg border border-info/40 bg-info-soft px-3 py-2.5 text-sm text-info" role="status">
                    <CheckCircle2 size={17} className="mt-0.5 shrink-0" />
                    <span><strong>Aplicação encerrada.</strong> Os cronômetros foram congelados e o portal do aluno foi bloqueado. {finished} {finished === 1 ? 'entregou' : 'entregaram'} · {absent} {absent === 1 ? 'não entregou' : 'não entregaram'}.</span>
                  </div>
                )}
                {applicationPrepared && (
                  <div className="mt-3 flex items-start gap-2 rounded-lg border border-warning/45 bg-warning-soft px-3 py-2.5 text-sm text-warning" role="status">
                    <AlertTriangle size={17} className="mt-0.5 shrink-0" />
                    <span><strong>Não visível aos alunos.</strong> “Preparar” monta a aplicação; o aviso só será enviado depois de clicar em “Iniciar prova e avisar alunos” ou “Sala de espera”.</span>
                  </div>
                )}
                {waitingRemaining != null && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <p className="mr-1 font-mono text-lg font-bold tabular-nums text-warning">Liberação em {fmt(waitingRemaining)}</p>
                    <Button size="sm" variant="secondary" onClick={() => adjustWaiting(-1)}>−1 min</Button>
                    <Button size="sm" variant="secondary" onClick={() => adjustWaiting(1)}>+1 min</Button>
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="rounded-lg border border-border bg-surface-2 px-4 py-3 min-w-[190px]" aria-live="polite">
                  <p className="text-[11px] font-semibold uppercase text-muted">{applicationFinished ? 'Aplicação' : monitorTimer.collective ? (examHasStarted ? 'Tempo restante' : 'Duração da prova') : (examHasStarted ? 'Menor tempo restante' : 'Duração por aluno')}</p>
                  <div className="mt-1 flex items-center gap-2">
                    <Clock size={17} className={applicationFinished ? 'text-info' : examRemaining != null && examRemaining <= 300 && examHasStarted ? 'text-danger' : 'text-primary'} />
                    <span className={`font-mono text-xl font-bold tabular-nums ${applicationFinished ? 'text-info' : examRemaining != null && examRemaining <= 300 && examHasStarted ? 'text-danger' : 'text-text'}`}>
                      {applicationFinished ? 'Encerrada' : selectedConfig.timerEnabled === false ? 'Desativado' : fmt(examRemaining)}
                    </span>
                  </div>
                  {applicationFinished && (
                    <p className="mt-1 text-[11px] text-subtle">Cronômetros parados no encerramento</p>
                  )}
                  {!applicationFinished && selectedConfig.timerEnabled !== false && (
                    <p className="mt-1 text-[11px] text-subtle">
                      {monitorTimer.collective
                        ? (examHasStarted ? 'Cronômetro coletivo da turma' : 'Inicia após a sala de espera')
                        : (examHasStarted
                            ? `${monitorTimer.activeCount} ${monitorTimer.activeCount === 1 ? 'cronômetro individual em andamento' : 'cronômetros individuais em andamento'}`
                            : 'Começa quando cada aluno confirmar o início')}
                    </p>
                  )}
                </div>
                <div className="rounded-lg border border-border bg-surface-2 px-4 py-3 min-w-[190px]">
                  <p className="text-[11px] font-semibold uppercase text-muted">Token de acesso</p>
                  <div className="mt-1 flex items-center gap-2">
                    <span className={`font-mono font-bold ${applicationToken ? 'text-lg tracking-[0.2em] text-warning' : 'text-sm text-muted'}`}>{applicationToken || (selectedConfig.requiresToken ? 'Definido na preparação' : 'Desativado')}</span>
                    {applicationToken && <Button size="sm" variant="ghost" icon={Copy} onClick={copyToken}>Copiar</Button>}
                  </div>
                </div>
              </div>
            </div>
          </Card>
          <div className="flex flex-wrap gap-2">
            {applicationFinished ? (
              <>
                <Button icon={CheckCircle2} loading={releaseBusy} onClick={releaseGrades}>Liberar nota para o aluno</Button>
                <Button variant="secondary" icon={ArrowRight} onClick={goToResults}>Ver resultados</Button>
                <Button variant="secondary" icon={History} onClick={openMessageHistory}>Histórico msgs</Button>
                <Button variant="secondary" onClick={loadAnalytics}>Analytics</Button>
              </>
            ) : (
              <>
                <Button icon={Play} disabled={selectedConfig.status === 'running' || waitingHasEnded} onClick={startApplication}>{applicationPrepared ? 'Iniciar prova e avisar alunos' : selectedConfig.status === 'waiting' ? (waitingHasEnded ? 'Prova liberada' : 'Iniciar agora') : selectedConfig.status === 'running' ? 'Prova iniciada' : selectedConfig.status === 'paused' ? 'Retomar prova' : 'Iniciar prova'}</Button>
                <Button variant="secondary" disabled={applicationPrepared} icon={selectedConfig.status === 'paused' ? Play : Pause} onClick={() => control(selectedConfig.status === 'paused' ? 'resume' : 'pause')}>{selectedConfig.status === 'paused' ? 'Retomar' : 'Pausar'}</Button>
                <Button variant="secondary" icon={Clock} onClick={waitingRoom}>{selectedConfig.status === 'waiting' ? 'Redefinir espera' : 'Sala de espera'}</Button>
                <Button variant="secondary" icon={Clock} onClick={() => addTime()}>+5 min</Button>
                <Button variant="secondary" icon={Send} onClick={() => broadcast()}>Aviso turma</Button>
                <Button variant="secondary" icon={History} onClick={openMessageHistory}>Histórico msgs</Button>
                <Button variant="secondary" onClick={loadAnalytics}>Analytics</Button>
                <Button variant="destructive" icon={Square} onClick={openFinishDecision}>Finalizar</Button>
              </>
            )}
          </div>
          {reportGroups.length > 0 && (
            <Card className="overflow-hidden border-warning/50">
              <div className="flex items-center gap-3 border-b border-border bg-warning-soft px-4 py-3 text-warning">
                <AlertTriangle className="h-5 w-5" />
                <div className="flex-1">
                  <h3 className="font-semibold">Contestações ({reportTotal})</h3>
                  <p className="text-xs opacity-90">Atualização automática pelo monitor, sem recarregar a página.</p>
                </div>
                <Badge tone="warning">{reportGroups.length} {reportGroups.length === 1 ? 'questão' : 'questões'}</Badge>
              </div>
              <div className="divide-y divide-border">
                {reportGroups.map((group) => {
                  const reasonSummary = Object.entries(group.reasons || {})
                    .map(([reason, count]) => `${count}× ${REPORT_REASON_LABELS[reason] || reason}`)
                    .join(', ')
                  return (
                    <div key={group.questionNumber} className="p-4">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h4 className="font-semibold text-text">Questão {group.questionPosition || group.questionNumber}</h4>
                            <Badge tone="warning">{group.count} {group.count === 1 ? 'aluno' : 'alunos'}</Badge>
                          </div>
                          <p className="mt-1 text-xs text-muted">{reasonSummary}</p>
                          <p className="mt-2 line-clamp-2 text-sm text-text">{group.question?.questionText || group.question?.text || 'Enunciado indisponível'}</p>
                          <p className="mt-1 text-xs text-subtle">{group.reports.map((report) => report.studentName || report.studentEmail).join(', ')}</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" variant="ghost" icon={Eye} onClick={() => setPreviewIssue(group)}>Ver questão</Button>
                          <Button size="sm" variant="secondary" icon={Pencil} onClick={() => openCorrection(group)}>Corrigir</Button>
                          <Button size="sm" variant="secondary" loading={issueBusy === `dismiss-${group.questionNumber}`} onClick={() => dismissReports(group)}>Descartar</Button>
                          <Button size="sm" variant="secondary" icon={Ban} onClick={() => setAnnulIssue({ group, mode: 'remover_do_total', reason: '' })}>Anular...</Button>
                          <Button size="sm" icon={Library} onClick={() => openReplacement(group)}>Anular e substituir...</Button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </Card>
          )}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <Card className="p-4"><div className="flex items-center justify-between gap-2"><span className="text-xs text-muted">Alunos</span><Users className="h-4 w-4 text-muted" /></div><div className="text-2xl font-bold text-text tabular-nums">{totalStudents}</div></Card>
            <Card className="p-4"><div className="flex items-center justify-between gap-2"><span className="text-xs text-muted">Online</span><Play className="h-4 w-4 text-success" /></div><div className="text-2xl font-bold text-success tabular-nums">{online}</div></Card>
            <Card className="p-4"><div className="flex items-center justify-between gap-2"><span className="text-xs text-muted">Iniciaram</span><Clock className="h-4 w-4 text-primary" /></div><div className="text-2xl font-bold text-primary tabular-nums">{started}</div></Card>
            <Card className="p-4"><div className="flex items-center justify-between gap-2"><span className="text-xs text-muted">Entregaram</span><CheckCircle2 className="h-4 w-4 text-info" /></div><div className="text-2xl font-bold text-info tabular-nums">{finished}</div></Card>
            <Card className="p-4"><div className="flex items-center justify-between gap-2"><span className="text-xs text-muted">Alertas</span><AlertTriangle className="h-4 w-4 text-warning" /></div><div className="text-2xl font-bold text-warning tabular-nums">{alerts}</div><p className="text-xs text-subtle">{absent} ausentes</p></Card>
          </div>
          {err && <p className="text-sm text-danger">Erro ao atualizar: {err.message}</p>}
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-muted border-b border-border bg-surface-2">
                <th className="px-4 py-3 font-semibold">Aluno</th><th className="px-4 py-3 font-semibold">IP</th><th className="px-4 py-3 font-semibold">Status</th><th className="px-4 py-3 font-semibold">Versão</th><th className="px-4 py-3 font-semibold">Tempo</th><th className="px-4 py-3 font-semibold">Progresso</th><th className="px-4 py-3 font-semibold">Digitação</th><th className="px-4 py-3 font-semibold">Foco</th><th className="px-4 py-3 font-semibold">Ações</th>
              </tr></thead>
              <tbody>
                {rows.map((r, i) => {
                  const st = STATUS[r.status] || ['neutral', r.status || '-']
                  const recentLogs = (r.logs || []).slice(-2).map(focusLogLabel)
                  return (
                    <tr key={r.email || i} className="border-b border-border last:border-0">
                      <td className="px-4 py-3"><div className="font-medium text-text">{r.name || r.email}</div><div className="text-xs text-muted">{r.email}</div></td>
                      <td className="px-4 py-3 font-mono text-xs text-muted">{r.ip || '-'}</td>
                      <td className="px-4 py-3">
                        <Badge tone={st[0]} dot>{st[1]}</Badge>
                        {r.status === 'time_over' && <p className="mt-1 text-[11px] text-subtle">Entrega automática em instantes</p>}
                        {r.status === 'finished' && deliveryLabel(r) && <p className={`mt-1 max-w-[220px] text-[11px] ${deliveryTone(r) === 'warning' ? 'text-warning' : 'text-subtle'}`}>{deliveryLabel(r)}</p>}
                      </td>
                      <td className="px-4 py-3"><Button size="sm" variant="ghost" icon={GitBranch} onClick={() => assignVersion(r.email)}>{r.assignedVersion || 'A'}</Button></td>
                      <td className="px-4 py-3 font-mono text-muted">{fmt(r.timerRemaining)}</td>
                      <td className="px-4 py-3 font-mono text-muted">{r.progress || '-'}</td>
                      <td className="px-4 py-3">
                        <button
                          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-surface-2"
                          onClick={() => openKeystrokeWatch(r)}
                          title="Ver digitação ao vivo"
                        >
                          <Keyboard size={13} />
                          <span className="font-mono">{r.keystrokeCount || 0}</span>
                          {r.suspiciousCount > 0 && <Badge tone="danger">{r.suspiciousCount}</Badge>}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        {r.focusLocked ? <Badge tone="danger">Bloqueado</Badge> : recentLogs.length > 0 ? <span className="text-xs text-muted">{recentLogs.join(' | ')}</span> : <span className="text-subtle">ok</span>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {applicationFinished ? (
                            <Button size="sm" variant="secondary" icon={Eye} onClick={() => setAnswersFor(r)}>Ver respostas</Button>
                          ) : (
                            <>
                              <Button size="sm" variant="secondary" icon={Eye} onClick={() => setAnswersFor(r)}>Ver respostas</Button>
                              {r.focusLocked && <Button size="sm" variant="secondary" icon={Unlock} onClick={() => unlock(r.email)}>Foco</Button>}
                              <Button size="sm" variant="secondary" icon={Clock} onClick={() => adjustOne(r.email)}>Tempo</Button>
                              <Button size="sm" variant="secondary" icon={Send} onClick={() => broadcast(r.email)}>Msg</Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {rows.length === 0 && <tr><td colSpan="9" className="py-6 text-center text-muted">Nenhum aluno cadastrado nesta turma.</td></tr>}
              </tbody>
            </table>
          </Card>
        </>
      )}
      <Modal
        open={!!keystrokeWatch}
        onClose={() => setKeystrokeWatch(null)}
        title={`Digitação ao vivo — ${keystrokeWatch?.name || ''}`}
        description="Leitura dos comandos capturados. Atualiza a cada 2s."
        size="lg"
      >
        <KeystrokeViewer
          events={keystrokeEvents}
          row={rows.find((r) => r.email === keystrokeWatch?.email) || keystrokeWatch}
          loading={keystrokeLoading}
        />
      </Modal>
      <Modal open={!!previewIssue} onClose={() => setPreviewIssue(null)} title={`Questão ${previewIssue?.questionPosition || previewIssue?.questionNumber || ''}`} description={`${previewIssue?.count || 0} contestação(ões) recebida(s)`}>
        {previewIssue && (
          <div className="space-y-4">
            <Card className="p-4">
              <p className="font-medium text-text">{previewIssue.question?.questionText || previewIssue.question?.text}</p>
              <div className="mt-3 space-y-2">
                {(previewIssue.question?.alternatives || []).map((alternative, index) => {
                  const letter = String(alternative.letter || String.fromCharCode(65 + index)).toUpperCase()
                  const correct = letter === String(previewIssue.question?.correctAnswer || '').toUpperCase() || alternative.isCorrect === true
                  return <div key={letter} className={`rounded-md border p-3 text-sm ${correct ? 'border-success/50 bg-success-soft text-success' : 'border-border text-text'}`}><strong>{letter})</strong> {alternative.text} {correct && '— gabarito'}</div>
                })}
              </div>
            </Card>
            <div className="space-y-2">
              {previewIssue.reports?.map((report) => (
                <div key={report.id} className="rounded-md border border-border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2"><strong className="text-text">{report.studentName || report.studentEmail}</strong><Badge tone="warning">{REPORT_REASON_LABELS[report.reason] || report.reason}</Badge></div>
                  {report.text && <p className="mt-2 text-muted">{report.text}</p>}
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={!!correctIssue}
        onClose={() => !issueBusy && setCorrectIssue(null)}
        title={`Corrigir questão ${correctIssue?.group?.questionPosition || correctIssue?.group?.questionNumber || ''}`}
        description="A alteração vale para esta aplicação. Alunos e entregas já realizadas serão atualizados."
        footer={<><Button variant="ghost" onClick={() => setCorrectIssue(null)} disabled={!!issueBusy}>Cancelar</Button><Button icon={Pencil} onClick={saveCorrection} loading={issueBusy === 'correct'}>Salvar correção e avisar</Button></>}
      >
        {correctIssue && (
          <div className="space-y-4">
            <Textarea label="Enunciado" value={correctIssue.text} onChange={(event) => setCorrectIssue((current) => ({ ...current, text: event.target.value }))} />
            <div className="space-y-2">
              <p className="text-sm font-medium text-text">Alternativas e gabarito</p>
              {correctIssue.alternatives.map((alternative, index) => (
                <div key={alternative.letter} className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-lg border border-border p-2">
                  <input type="radio" name="live-correct-answer" checked={correctIssue.correctAnswer === alternative.letter} onChange={() => setCorrectIssue((current) => ({ ...current, correctAnswer: alternative.letter }))} aria-label={`Marcar ${alternative.letter} como correta`} />
                  <Input value={alternative.text} onChange={(event) => setCorrectIssue((current) => ({ ...current, alternatives: current.alternatives.map((item, itemIndex) => itemIndex === index ? { ...item, text: event.target.value } : item) }))} aria-label={`Texto da alternativa ${alternative.letter}`} />
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={!!annulIssue}
        onClose={() => !issueBusy && setAnnulIssue(null)}
        title={`Anular questão ${annulIssue?.group?.questionPosition || annulIssue?.group?.questionNumber || ''}?`}
        description="A recorreção de entregas existentes será automática."
        footer={<><Button variant="ghost" onClick={() => setAnnulIssue(null)} disabled={!!issueBusy}>Cancelar</Button><Button variant="destructive" icon={Ban} onClick={annulQuestion} loading={issueBusy === 'annul'}>Anular e avisar alunos</Button></>}
      >
        {annulIssue && <div className="space-y-4">
          <Select label="Como calcular a nota?" value={annulIssue.mode} onChange={(event) => setAnnulIssue((current) => ({ ...current, mode: event.target.value }))}>
            <option value="remover_do_total">Remover a questão do total</option>
            <option value="ponto_para_todos">Dar o ponto para todos</option>
          </Select>
          <Textarea label="Motivo da anulação" value={annulIssue.reason} maxLength={300} onChange={(event) => setAnnulIssue((current) => ({ ...current, reason: event.target.value }))} />
        </div>}
      </Modal>

      <Modal
        open={!!replaceIssue}
        onClose={() => !issueBusy && setReplaceIssue(null)}
        title={`Substituir questão ${replaceIssue?.group?.questionPosition || replaceIssue?.group?.questionNumber || ''}`}
        description="A original será anulada e a nova questão aparecerá no final da prova."
        size="lg"
        footer={<><Button variant="ghost" onClick={() => setReplaceIssue(null)} disabled={!!issueBusy}>Cancelar</Button><Button icon={Library} onClick={replaceQuestion} loading={issueBusy === 'replace'} disabled={!replaceIssue?.bankQuestionKey || displayedStatus !== 'running' || (examRemaining != null && examRemaining < 300)}>Confirmar substituição</Button></>}
      >
        {replaceIssue && <div className="space-y-4">
          {(displayedStatus !== 'running' || (examRemaining != null && examRemaining < 300)) && (
            <div className="rounded-lg border border-danger/50 bg-danger-soft p-3 text-sm text-danger">Não é possível substituir agora — tempo restante insuficiente ou prova pausada.</div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label="Buscar no banco" value={replaceIssue.search} onChange={(event) => setReplaceIssue((current) => ({ ...current, search: event.target.value }))} />
            <Input label="Minutos extras para a turma" type="number" min="0" max="30" value={replaceIssue.extraMinutes} onChange={(event) => setReplaceIssue((current) => ({ ...current, extraMinutes: event.target.value }))} />
          </div>
          <p className="text-xs text-subtle">O tempo extra compensa os alunos que já tinham respondido à questão anulada.</p>
          <div className="max-h-[380px] space-y-2 overflow-auto">
            {bankQuestions.filter((question) => !replaceIssue.search || String(question.questionText || '').toLowerCase().includes(replaceIssue.search.toLowerCase())).map((question) => (
              <label key={question.key} className={`block cursor-pointer rounded-lg border p-3 ${replaceIssue.bankQuestionKey === question.key ? 'border-primary bg-primary-soft' : 'border-border hover:bg-surface-2'}`}>
                <div className="flex items-start gap-3">
                  <input type="radio" name="replacement-question" className="mt-1" checked={replaceIssue.bankQuestionKey === question.key} onChange={() => setReplaceIssue((current) => ({ ...current, bankQuestionKey: question.key }))} />
                  <div><p className="text-sm font-medium text-text">{question.questionText}</p><p className="mt-1 text-xs text-subtle">{question.category || 'Geral'} · gabarito {question.correctAnswer || '-'}</p></div>
                </div>
              </label>
            ))}
            {bankQuestions.filter((question) => !replaceIssue.search || String(question.questionText || '').toLowerCase().includes(replaceIssue.search.toLowerCase())).length === 0 && (
              <EmptyState icon={Library} title="Nenhuma questão compatível no banco" description="Importe ou crie questões em Provas antes de fazer a substituição." />
            )}
          </div>
        </div>}
      </Modal>

      <Modal open={!!analytics} onClose={() => setAnalytics(null)} title="Analytics da prova" description={`${className} - ${examKey}`}>
        {analytics && <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <Card className="p-3"><span className="text-xs text-muted">Entregas</span><div className="text-2xl font-bold text-text">{analytics.totalSubmissions}</div></Card>
            <Card className="p-3"><span className="text-xs text-muted">Média</span><div className="text-2xl font-bold text-text">{analytics.averageScore}</div></Card>
            <Card className="p-3"><span className="text-xs text-muted">Perdas de foco</span><div className="text-2xl font-bold text-text">{analytics.proctoringSummary?.totalFocusLosses || 0}</div></Card>
          </div>
          <div className="space-y-2">
            {(analytics.questions || []).map((q) => <div key={q.questionNumber} className="flex items-center justify-between rounded-md border border-border p-3 text-sm"><span>Questão {q.questionNumber}</span><Badge tone={q.difficulty === 'alta' ? 'danger' : q.difficulty === 'media' ? 'warning' : 'success'}>{q.accuracyPercent}%</Badge></div>)}
          </div>
        </div>}
      </Modal>
      <Modal open={historyOpen} onClose={() => setHistoryOpen(false)} title="Histórico de mensagens" description={`${className || '-'} - ${examKey || '-'}`}>
        <div className="space-y-3">
          <div className="flex justify-end">
            <Button size="sm" variant="secondary" icon={Trash2} onClick={() => deleteMessageHistory(null)} disabled={messageHistory.length === 0}>Limpar histórico</Button>
          </div>
          <div className="space-y-2 max-h-[420px] overflow-auto">
            {messageHistory.map((m) => (
              <div key={m.id} className="rounded-lg border border-border p-3">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-text whitespace-pre-wrap">{m.messageText}</p>
                    <p className="text-xs text-subtle mt-1">
                      {m.targetEmail ? `Aluno: ${m.targetEmail}` : 'Turma toda'} - {m.createdAt ? new Date(m.createdAt).toLocaleString('pt-BR') : new Date(Number(m.timestamp || Date.now())).toLocaleString('pt-BR')}
                    </p>
                  </div>
                  <Button size="sm" variant="ghost" icon={Trash2} onClick={() => deleteMessageHistory(m.id)}>Excluir</Button>
                </div>
              </div>
            ))}
            {messageHistory.length === 0 && <p className="text-sm text-muted text-center py-6">Nenhuma mensagem no histórico.</p>}
          </div>
        </div>
      </Modal>
      <FinishApplicationModal
        open={finishOpen}
        onClose={() => setFinishOpen(false)}
        summary={finishSummary}
        busy={finishBusy}
        onSubmit={() => finishApplication('submit')}
        onDiscard={() => finishApplication('discard')}
      />
      <StudentAnswersModal
        open={!!answersFor}
        onClose={() => setAnswersFor(null)}
        student={answersFor}
        className={className}
        courseId={courseId}
        examKey={examKey}
        applicationId={applicationId}
        onOpenResults={() => { setAnswersFor(null); goToResults() }}
      />
    </div>
  )
}
