import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, BookOpen, Check, Loader2, RotateCcw } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Textarea } from '../../components/ui/Textarea'
import { api } from '../../lib/api'

// ---------------------------------------------------------------------------
// Conteúdo das aulas na Chamada: o diário de classe do dia (fase 3, B11 / P4-S7, FUN-09).
// Um cartão por aula da grade do dia (e as aulas já escritas que saíram da grade), com
// "Conteúdo ministrado" e "Atividade" (opcional). Salva sozinho como a chamada: 2 s depois
// da última tecla, só as aulas que mudaram, com a versão que leu (GET e POST
// /api/admin/attendance/diary). Outra aba ou outra pessoa gravou antes: o servidor
// responde 409 diary_changed com o diário de agora, e a tela pergunta o que fazer (ver a
// versão salva, ou gravar o texto daqui por cima). Trocar de data ou de turma com texto
// ainda não salvo grava antes de sair. Só consulta (Coordenação) e turma encerrada: os
// campos ficam travados.
// ---------------------------------------------------------------------------
const AUTOSAVE_MS = 2000
const brTime = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
const brDateTime = (ms) => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

function textsOf(diario) {
  const out = {}
  ;(diario?.aulas || []).forEach((aula) => { out[aula.ordem] = { conteudo: aula.conteudo || '', atividade: aula.atividade || '' } })
  return out
}

export function ChamadaDiario({ courseId, className, date, readOnly = false, accountEmail = '' }) {
  const [diario, setDiario] = useState(null)
  const [limites, setLimites] = useState({ conteudoMax: 2000, atividadeMax: 1000 })
  const [texts, setTexts] = useState({})
  const [dirtyOrdens, setDirtyOrdens] = useState([])
  const [loadError, setLoadError] = useState(null)
  const [status, setStatus] = useState(null) // null | 'saving' | { savedAt } | { error }
  const [conflict, setConflict] = useState(null)
  const [closed, setClosed] = useState(false)
  // O que a gravação precisa sem esperar o React: versão, textos e aulas por salvar.
  const live = useRef({ versao: null, texts: {}, dirty: new Set(), saving: false, again: false, key: '' })
  const timerRef = useRef(null)
  const conflictRef = useRef(null)
  // Cada leitura passa a frente da anterior: a resposta de uma data que já ficou para trás
  // (trocar de data rápido) não cobre o diário da data de agora.
  const loadSeq = useRef(0)
  const key = `${courseId}::${className}::${date}`
  const locked = readOnly || closed || !!diario?.encerrada

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    if (!courseId || !className || !date) { setDiario(null); return }
    setLoadError(null)
    try {
      const r = await api.get(`/api/admin/attendance/diary?courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(className)}&date=${encodeURIComponent(date)}`)
      if (seq !== loadSeq.current) return
      if (!r || !r.diario) { setDiario(null); return }
      const next = textsOf(r.diario)
      live.current = { ...live.current, versao: r.diario.versao ?? null, texts: next, dirty: new Set() }
      setDiario(r.diario); setTexts(next); setDirtyOrdens([]); setConflict(null); setStatus(null)
      setClosed(!!r.diario.encerrada)
      if (r.limites) setLimites((cur) => ({ ...cur, ...r.limites }))
    } catch (e) { if (seq === loadSeq.current) { setDiario(null); setLoadError(e) } }
  }, [courseId, className, date])

  // Grava as aulas que mudaram (uma gravação por vez; o que mudou durante ela vai logo
  // depois). overwrite: gravar por cima da versão do conflito.
  const flush = useCallback(async (target = live.current.key) => {
    const state = live.current
    if (locked || state.key !== target || !state.dirty.size) return
    if (state.saving) { state.again = true; return }
    const ordens = [...state.dirty]
    const aulas = ordens.map((ordem) => ({ ordem, ...(state.texts[ordem] || { conteudo: '', atividade: '' }) }))
    const [cid, cls, day] = target.split('::')
    state.saving = true
    state.dirty = new Set()
    setStatus('saving')
    try {
      const r = await api.post('/api/admin/attendance/diary', { courseId: cid, studentClass: cls, date: day, versao: state.versao, aulas })
      if (live.current.key !== target) return
      if (r?.diario) {
        live.current.versao = r.diario.versao ?? null
        setDiario((cur) => (cur ? { ...cur, versao: r.diario.versao, atualizadoPor: r.diario.atualizadoPor, atualizadoEm: r.diario.atualizadoEm, registradoPor: r.diario.registradoPor } : r.diario))
      }
      setDirtyOrdens([...live.current.dirty])
      setStatus({ savedAt: brTime(Date.now()) })
    } catch (e) {
      if (live.current.key !== target) return
      ordens.forEach((ordem) => live.current.dirty.add(ordem))
      setDirtyOrdens([...live.current.dirty])
      if (e?.status === 409 && e?.data?.code === 'diary_changed') {
        conflictRef.current = e.data.atual || { versao: null }
        setConflict(conflictRef.current)
        setStatus(null)
      } else if (e?.status === 409 && e?.data?.code === 'class_closed') {
        setClosed(true)
        setStatus({ error: e.message })
      } else {
        setStatus({ error: e?.message || 'Não foi possível salvar o conteúdo das aulas.' })
      }
    } finally {
      if (live.current.key === target) {
        live.current.saving = false
        if (live.current.again) { live.current.again = false; if (!conflictRef.current) flush(target) }
      }
    }
  }, [locked]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { conflictRef.current = conflict }, [conflict])

  // Outra data ou turma: o texto que ficou por salvar vai antes de trocar.
  useEffect(() => {
    live.current = { versao: null, texts: {}, dirty: new Set(), saving: false, again: false, key }
    setDiario(null); setTexts({}); setDirtyOrdens([]); setStatus(null); setConflict(null); setClosed(false)
    load()
    return () => {
      clearTimeout(timerRef.current)
      if (live.current.key === key && live.current.dirty.size && !conflictRef.current) flush(key)
      live.current = { ...live.current, key: '' }
    }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  function edit(ordem, field, value) {
    if (locked) return
    const next = { ...texts, [ordem]: { ...(texts[ordem] || { conteudo: '', atividade: '' }), [field]: value } }
    setTexts(next)
    live.current.texts = next
    live.current.dirty.add(ordem)
    setDirtyOrdens([...live.current.dirty])
    setStatus(null)
    clearTimeout(timerRef.current)
    if (!conflict) timerRef.current = setTimeout(() => flush(key), AUTOSAVE_MS)
  }

  function takeSaved() {
    const atual = conflict
    if (!atual) return
    const next = textsOf(atual)
    live.current = { ...live.current, versao: atual.versao ?? null, texts: next, dirty: new Set() }
    setDiario(atual); setTexts(next); setDirtyOrdens([]); setConflict(null); setStatus(null)
  }

  function keepMine() {
    const atual = conflict
    if (!atual) return
    live.current.versao = atual.versao ?? null
    // As aulas daqui que estão diferentes da versão salva vão todas.
    const saved = textsOf(atual)
    Object.keys(live.current.texts).forEach((ordem) => {
      const mine = live.current.texts[ordem]; const theirs = saved[ordem] || { conteudo: '', atividade: '' }
      if (mine.conteudo !== theirs.conteudo || mine.atividade !== theirs.atividade) live.current.dirty.add(Number(ordem))
    })
    setDiario((cur) => ({ ...(cur || atual), versao: atual.versao, atualizadoPor: atual.atualizadoPor, atualizadoEm: atual.atualizadoEm }))
    setConflict(null)
    conflictRef.current = null
    flush(key)
  }

  if (loadError) {
    return (
      <section aria-label="Conteúdo das aulas" className="rounded-xl border border-border bg-surface p-4 text-sm text-muted flex flex-wrap items-center gap-3">
        <AlertTriangle size={16} className="text-warning shrink-0" />
        <span className="flex-1 min-w-0">Não foi possível abrir o conteúdo das aulas deste dia. {loadError.message}</span>
        <Button size="sm" variant="secondary" icon={RotateCcw} onClick={load}>Tentar de novo</Button>
      </section>
    )
  }
  if (!diario || !Array.isArray(diario.aulas) || diario.aulas.length === 0) return null

  const someContent = diario.aulas.some((aula) => (texts[aula.ordem]?.conteudo || texts[aula.ordem]?.atividade))
  const otherAuthor = diario.atualizadoPor && accountEmail && diario.atualizadoPor.toLowerCase() !== String(accountEmail).toLowerCase()

  return (
    <section aria-labelledby="diario-titulo" className="rounded-xl border border-border bg-surface p-3 sm:p-4 space-y-3">
      <div className="flex flex-wrap items-start gap-2">
        <BookOpen size={18} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 id="diario-titulo" className="text-[15px] font-semibold text-text">Conteúdo das aulas</h3>
          <p className="text-xs text-muted">O que foi dado em cada aula vai para o diário de classe da turma. Não escreva dados de alunos aqui; use a observação do aluno na chamada.</p>
        </div>
        <div className="text-xs" aria-live="polite">
          {status === 'saving' ? (
            <span className="inline-flex items-center gap-1.5 text-muted"><Loader2 size={13} className="animate-spin" /> Salvando…</span>
          ) : status?.error ? (
            <span className="inline-flex items-center gap-1.5 text-danger font-semibold"><AlertTriangle size={13} /> Não salvo: {status.error}</span>
          ) : dirtyOrdens.length && !locked ? (
            <span className="inline-flex items-center gap-1.5 text-warning font-semibold"><span className="w-2 h-2 rounded-full bg-warning" /> Alterações não salvas</span>
          ) : status?.savedAt ? (
            <span className="inline-flex items-center gap-1.5 text-success font-semibold"><Check size={13} /> Salvo às {status.savedAt}</span>
          ) : null}
        </div>
      </div>

      {status?.error && !locked && dirtyOrdens.length > 0 && (
        <Button size="sm" variant="secondary" icon={RotateCcw} onClick={() => flush(key)}>Tentar salvar de novo</Button>
      )}

      {conflict && (
        <div role="alert" className="rounded-lg border border-warning/40 bg-warning-soft p-3 space-y-2 text-sm text-text">
          <p className="font-semibold">O conteúdo deste dia foi alterado em outra aba ou por outra pessoa{conflict.atualizadoPor ? ` (${conflict.atualizadoPor}${conflict.atualizadoEm ? `, ${brDateTime(conflict.atualizadoEm)}` : ''})` : ''}.</p>
          <p className="text-muted">O seu texto ainda não foi salvo. Veja a versão salva ou grave o que está aqui por cima dela.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={takeSaved}>Ver a versão salva</Button>
            <Button size="sm" onClick={keepMine}>Gravar o meu texto por cima</Button>
          </div>
        </div>
      )}

      {(readOnly || locked) && (
        <p role="status" className="text-xs text-muted">
          {closed || diario.encerrada ? 'Turma encerrada: o conteúdo das aulas fica só para consulta.' : 'Sua conta é só de consulta: o conteúdo aparece como foi salvo.'}
          {!someContent ? ' Nenhum conteúdo registrado neste dia.' : ''}
        </p>
      )}
      {otherAuthor && diario.atualizadoEm && !conflict && (
        <p className="text-xs text-subtle">Última alteração por {diario.atualizadoPor} em {brDateTime(diario.atualizadoEm)}.</p>
      )}

      <fieldset disabled={locked} aria-label={locked ? 'Conteúdo das aulas (só consulta)' : undefined} className="m-0 min-w-0 border-0 p-0">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {diario.aulas.map((aula) => {
            const t = texts[aula.ordem] || { conteudo: '', atividade: '' }
            const titulo = [`Aula ${aula.ordem}`, aula.inicio, aula.disciplinaNome].filter(Boolean).join(' · ')
            return (
              <div key={aula.ordem} className="min-w-0 rounded-lg border border-border bg-surface-2 p-3 space-y-2">
                <p className="text-sm font-semibold text-text flex flex-wrap items-center gap-2">
                  {titulo}
                  {!aula.naGrade && <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-warning-soft text-warning">fora da grade deste dia</span>}
                </p>
                <Textarea label="Conteúdo ministrado" value={t.conteudo} maxLength={limites.conteudoMax} counterFrom={Math.floor(limites.conteudoMax * 0.9)}
                  onChange={(e) => edit(aula.ordem, 'conteudo', e.target.value)} placeholder="Ex.: Endereçamento IPv4 e máscara de rede"
                  className="min-h-[80px] w-full" />
                <Textarea label="Atividade (opcional)" value={t.atividade} maxLength={limites.atividadeMax} counterFrom={Math.floor(limites.atividadeMax * 0.9)}
                  onChange={(e) => edit(aula.ordem, 'atividade', e.target.value)} placeholder="Ex.: Lista de exercícios 1 a 5"
                  className="min-h-[56px] w-full" />
              </div>
            )
          })}
        </div>
      </fieldset>
    </section>
  )
}
