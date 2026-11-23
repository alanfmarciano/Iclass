import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import { api } from '../../lib/api'
import { normalizeSearch } from '../../lib/textSearch'

// "Como montar" da aplicação online (fase 3, P3-S11: AVA-16; D23 e D24 do desenho do P3).
// Versões (como sempre foi): até 4 versões (A a D), montadas e conferidas no servidor.
// Sorteio por aluno: cada aluno recebe, da montagem salva, a quantidade pedida em cada
// grupo (por origem, categoria do banco, dificuldade ou etiqueta), sem repetir e em ordem
// própria. Quem sorteia é o servidor, ao começar a tentativa; a tela só conta quantas
// questões cabem em cada grupo (a mesma conta de backend/utils/examDraw.js: a questão que
// serve para dois grupos fica no primeiro) e monta o pedido.

export const MAX_DRAW_GROUPS = 10
export const ONLINE_VERSIONS_LIMIT = 4

export const DRAW_MODES = [
  { value: 'versoes', label: `Versões (máx. ${ONLINE_VERSIONS_LIMIT})`, hint: 'Todos recebem as mesmas questões; cada versão muda a ordem das questões e das alternativas.' },
  { value: 'por_aluno', label: 'Sorteio por aluno', hint: 'Cada aluno recebe questões sorteadas da montagem, na quantidade de cada grupo, sem repetir.' },
]

export const DRAW_ORIGINS = [
  { value: '', label: 'Qualquer origem' },
  { value: 'avaliacao', label: 'Escritas na prova' },
  { value: 'banco', label: 'Vindas do banco' },
]

export const DRAW_DIFFICULTIES = [
  { value: '', label: 'Qualquer dificuldade' },
  { value: 'facil', label: 'Fácil' },
  { value: 'media', label: 'Média' },
  { value: 'dificil', label: 'Difícil' },
]

const DIFFICULTY_PLURAL = { facil: 'fáceis', media: 'médias', dificil: 'difíceis' }

let groupSeq = 0
export function newDrawGroup(patch = {}) {
  groupSeq += 1
  return { id: `grupo-${groupSeq}`, quantidade: '', origem: '', categoria: '', dificuldade: '', tag: '', ...patch }
}

export function initialDraw() {
  return { modo: 'versoes', grupos: [newDrawGroup()] }
}

export function isPerStudent(draw) {
  return draw?.modo === 'por_aluno'
}

function filterOf(group) {
  const filtro = {}
  ;['origem', 'categoria', 'dificuldade', 'tag'].forEach((field) => {
    const text = String(group?.[field] || '').trim()
    if (text) filtro[field] = text
  })
  return filtro
}

// O grupo em palavras (igual a describeDrawFilter do servidor): "questões fáceis da categoria Redes".
export function describeGroup(group) {
  const filtro = filterOf(group)
  const parts = [filtro.dificuldade ? `questões ${DIFFICULTY_PLURAL[filtro.dificuldade] || filtro.dificuldade}` : 'questões']
  if (filtro.origem === 'banco') parts.push('vindas do banco')
  if (filtro.origem === 'avaliacao') parts.push('escritas na prova')
  if (filtro.categoria) parts.push(`da categoria ${filtro.categoria}`)
  if (filtro.tag) parts.push(`com a etiqueta ${filtro.tag}`)
  return parts.join(' ')
}

function matches(meta, filtro) {
  if (filtro.origem && meta.origem !== filtro.origem) return false
  if (filtro.dificuldade && meta.dificuldade !== filtro.dificuldade) return false
  if (filtro.categoria && normalizeSearch(meta.categoria) !== normalizeSearch(filtro.categoria)) return false
  if (filtro.tag) {
    const wanted = normalizeSearch(filtro.tag)
    if (!(meta.tags || []).some((tag) => normalizeSearch(tag) === wanted)) return false
  }
  return true
}

// Quantas questões da montagem cabem em cada grupo (cada questão vai para o primeiro grupo
// que a aceita, como no servidor).
export function drawAvailability(pool, draw) {
  const filters = (draw?.grupos || []).map(filterOf)
  const counts = filters.map(() => 0)
  ;(pool || []).forEach((meta) => {
    const index = filters.findIndex((filtro) => matches(meta, filtro))
    if (index >= 0) counts[index] += 1
  })
  return counts
}

function quantityOf(group) {
  const value = Number(group?.quantidade)
  return Number.isInteger(value) && value >= 1 ? value : null
}

export function drawTotal(draw) {
  return (draw?.grupos || []).reduce((sum, group) => sum + (quantityOf(group) || 0), 0)
}

// O que impede o sorteio antes de mandar (o servidor confere de novo), ou null. Sem a
// montagem carregada (pool null) só confere as quantidades.
export function drawProblem(draw, pool) {
  if (!isPerStudent(draw)) return null
  const grupos = draw.grupos || []
  if (!grupos.length) return 'No sorteio por aluno, diga quantas questões sortear (pelo menos um grupo).'
  for (let index = 0; index < grupos.length; index++) {
    if (!quantityOf(grupos[index])) return `Grupo ${index + 1}: informe quantas questões sortear (um número inteiro a partir de 1).`
  }
  if (!Array.isArray(pool)) return null
  const available = drawAvailability(pool, draw)
  for (let index = 0; index < grupos.length; index++) {
    const wanted = quantityOf(grupos[index])
    if (wanted > available[index]) {
      const what = describeGroup(grupos[index])
      const others = index > 0 ? ' (a questão que serve para dois grupos fica no primeiro)' : ''
      return available[index] === 0
        ? `Grupo ${index + 1}: nenhuma questão da montagem combina com o filtro (${what})${others}.`
        : `Grupo ${index + 1}: pediu ${wanted} ${what}, mas a montagem só tem ${available[index]}${others}.`
    }
  }
  return null
}

// O pedido para applicationOptions: nada nas versões (o de sempre); no sorteio, os grupos.
export function drawPayload(draw) {
  if (!isPerStudent(draw)) return {}
  return {
    sorteio: {
      modo: 'por_aluno',
      grupos: (draw.grupos || []).map((group) => ({ filtro: filterOf(group), quantidade: quantityOf(group) || 0 })),
    },
  }
}

// As questões que o sorteio pode usar: as da configuração salva (historyId) ou as escolhidas
// na montagem (numbers). Só busca no modo sorteio.
export function useDrawPool({ studentClass, courseId, examKey, historyId, numbers, enabled }) {
  const [state, setState] = useState({ data: null, loading: false, error: '' })
  const numbersKey = Array.isArray(numbers) ? numbers.join(',') : ''
  useEffect(() => {
    if (!enabled || !studentClass || !examKey || (!historyId && !numbersKey)) {
      setState({ data: null, loading: false, error: '' })
      return undefined
    }
    let cancelled = false
    setState((current) => ({ ...current, loading: true, error: '' }))
    const params = new URLSearchParams({ studentClass, courseId: courseId || '', examKey })
    if (historyId) params.set('historyId', historyId)
    else params.set('numbers', numbersKey)
    api.get(`/api/admin/exam-applications/draw-pool?${params.toString()}`)
      .then((data) => { if (!cancelled) setState({ data, loading: false, error: '' }) })
      .catch((e) => { if (!cancelled) setState({ data: null, loading: false, error: e.message || 'Não foi possível ler as questões da montagem.' }) })
    return () => { cancelled = true }
  }, [enabled, studentClass, courseId, examKey, historyId, numbersKey])
  return state
}

function DrawGroupRow({ group, index, available, categorias, etiquetas, canRemove, onChange, onRemove }) {
  const set = (patch) => onChange({ ...group, ...patch })
  const listId = `${group.id}-categorias`
  const tagListId = `${group.id}-etiquetas`
  const wanted = quantityOf(group)
  const short = available !== null && wanted !== null && wanted > available
  return (
    <fieldset className="rounded-lg border border-border p-3 space-y-2" data-testid="draw-group">
      <legend className="sr-only">Grupo {index + 1}</legend>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-text" aria-hidden="true">Grupo {index + 1}</p>
        {canRemove && (
          <Button type="button" size="sm" variant="ghost" icon={Trash2} className="min-h-[44px]" aria-label={`Remover grupo ${index + 1}`} onClick={onRemove}>Remover</Button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Input
          label="Quantidade"
          type="number"
          min="1"
          step="1"
          inputMode="numeric"
          value={group.quantidade}
          onChange={(e) => set({ quantidade: e.target.value })}
          helper={available === null ? 'Questões deste grupo para cada aluno.' : `${available} ${available === 1 ? 'questão combina' : 'questões combinam'} com o filtro.`}
        />
        <Select label="Origem" className="h-11" value={group.origem} onChange={(e) => set({ origem: e.target.value })}>
          {DRAW_ORIGINS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select>
        <Select label="Dificuldade" className="h-11" value={group.dificuldade} onChange={(e) => set({ dificuldade: e.target.value })}>
          {DRAW_DIFFICULTIES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select>
        <div>
          <Input label="Categoria do banco" list={listId} maxLength={80} placeholder="Qualquer categoria" value={group.categoria} onChange={(e) => set({ categoria: e.target.value })} />
          <datalist id={listId}>{(categorias || []).map((item) => <option key={item} value={item} />)}</datalist>
        </div>
        <div className="sm:col-span-2">
          <Input label="Etiqueta" list={tagListId} maxLength={40} placeholder="Qualquer etiqueta" value={group.tag} onChange={(e) => set({ tag: e.target.value })} />
          <datalist id={tagListId}>{(etiquetas || []).map((item) => <option key={item} value={item} />)}</datalist>
        </div>
      </div>
      {short && <p className="text-xs text-danger" role="alert">Pediu {wanted}, mas só {available === 1 ? 'há 1 questão' : `há ${available} questões`} para este grupo.</p>}
    </fieldset>
  )
}

// A seção "Como montar". versionsField: o campo "Versões online" da tela (aparece nos dois
// modos: no sorteio, a versão muda a ordem das alternativas). pool: o retorno de useDrawPool.
export function ApplicationDrawFields({ value, onChange, versionsField = null, pool = null, poolSize = null }) {
  const draw = value || initialDraw()
  const perStudent = isPerStudent(draw)
  const questions = Array.isArray(pool?.data?.questions) ? pool.data.questions : null
  const available = useMemo(() => (questions ? drawAvailability(questions, draw) : null), [questions, draw])
  const problem = perStudent ? drawProblem(draw, questions) : null
  const total = drawTotal(draw)
  const size = questions ? questions.length : poolSize
  const setGroup = (index, group) => onChange({ ...draw, grupos: draw.grupos.map((item, position) => (position === index ? group : item)) })
  const removeGroup = (index) => onChange({ ...draw, grupos: draw.grupos.filter((_, position) => position !== index) })
  const addGroup = () => onChange({ ...draw, grupos: [...draw.grupos, newDrawGroup()] })
  const choose = (modo) => onChange({ ...draw, modo, grupos: draw.grupos?.length ? draw.grupos : [newDrawGroup()] })
  const current = DRAW_MODES.find((option) => option.value === draw.modo) || DRAW_MODES[0]
  return (
    <div className="space-y-3" data-testid="application-draw">
      <fieldset className="space-y-2">
        <legend className="text-[13px] font-medium text-muted">Como montar</legend>
        <div role="radiogroup" aria-label="Como montar" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {DRAW_MODES.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={draw.modo === option.value}
              onClick={() => choose(option.value)}
              className={`min-h-[44px] rounded-lg border px-3 py-2 text-left text-sm font-semibold transition ${draw.modo === option.value ? 'border-primary bg-primary-soft text-primary' : 'border-border bg-surface text-text hover:bg-surface-2'}`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-subtle">{current.hint}</p>
      </fieldset>
      {versionsField}
      {perStudent && (
        <div className="space-y-2">
          {pool?.loading && <p className="text-xs text-muted">Lendo as questões da montagem...</p>}
          {pool?.error && <p className="text-xs text-danger" role="alert">{pool.error}</p>}
          {draw.grupos.map((group, index) => (
            <DrawGroupRow
              key={group.id}
              group={group}
              index={index}
              available={available ? available[index] : null}
              categorias={pool?.data?.categorias}
              etiquetas={pool?.data?.etiquetas}
              canRemove={draw.grupos.length > 1}
              onChange={(next) => setGroup(index, next)}
              onRemove={() => removeGroup(index)}
            />
          ))}
          {draw.grupos.length < MAX_DRAW_GROUPS && (
            <Button type="button" size="sm" variant="secondary" icon={Plus} className="min-h-[44px]" onClick={addGroup}>Adicionar grupo</Button>
          )}
          <p className="text-xs text-subtle">Cada questão entra no primeiro grupo que combina com ela.</p>
          {problem
            ? <p className="text-xs text-danger" role="alert" data-testid="draw-problem">{problem}</p>
            : <p className="text-sm text-text" data-testid="draw-summary">Cada aluno recebe {size ? `${total} de ${size} questões` : `${total} ${total === 1 ? 'questão' : 'questões'}`}, {total === 1 ? 'sorteada' : 'sorteadas'} ao começar a prova.</p>}
        </div>
      )}
    </div>
  )
}
