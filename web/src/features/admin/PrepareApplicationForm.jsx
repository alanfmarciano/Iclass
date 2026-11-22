import { useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, UserPlus, Users, X } from 'lucide-react'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Modal } from '../../components/ui/Modal'
import { Select } from '../../components/ui/Select'
import { Switch } from '../../components/ui/Switch'
import { api } from '../../lib/api'
import { matchesSearch } from '../../lib/textSearch'
import { DEFAULT_KEYSTROKE_MODE, KEYSTROKE_MODE_OPTIONS, keystrokeModeDescription } from '../../lib/keystrokeModes'

// Preparar a aplicação da prova (fase 3, P3-S7: AVA-09; D15, D16 e D17 do desenho do P3).
// Extraído da tela Provas: os campos da aplicação ("Aplicar prova novamente") e o "Para
// quem", usado também na montagem online e na edição da aplicação já preparada.
//
// "Para quem": a turma inteira (como sempre foi), a segunda chamada (a lista vem marcada
// com quem ainda não fez a prova numa aplicação regular; o professor desmarca e marca) ou
// alunos escolhidos. Exceção por aluno: tentativas a mais e, com o cronômetro por aluno,
// prazo para começar. Quem pode fazer é decidido no servidor (applicationParticipant); a
// tela só monta o pedido.
//
// Recuperação (finalidade 'recuperacao') fica escondida até o gradebook tratar a
// finalidade (P2-S3, junção J2; D17): sem a regra do P2, a nota da recuperação entraria
// como mais uma aplicação na média e baixaria a média de quem foi bem.
export const RECUPERACAO_VISIVEL = false

export const MAX_EXTRA_ATTEMPTS = 5
const MAX_REASON_CHARS = 300

const AUDIENCE_MODES = [
  { value: 'turma', label: 'Turma inteira', hint: 'Todos os alunos da turma podem fazer.' },
  { value: 'segunda_chamada', label: 'Segunda chamada', hint: 'Já vem marcado quem ainda não fez a prova. Desmarque ou marque quem precisar.' },
  { value: 'escolher', label: 'Escolher alunos', hint: 'Só os alunos marcados veem e fazem esta aplicação.' },
  { value: 'recuperacao', label: 'Recuperação', hint: 'Só os alunos marcados fazem a recuperação.', hidden: !RECUPERACAO_VISIVEL },
]

export function audienceModes() {
  return AUDIENCE_MODES.filter((mode) => !mode.hidden)
}

// Estado inicial do "Para quem": turma inteira, sem exceções.
export function initialAudience() {
  return { mode: 'turma', selected: [], overrides: {}, touched: false }
}

// Estado do "Para quem" a partir de uma aplicação já preparada (a resposta de
// participant-candidates).
export function audienceFromApplication(data) {
  const application = data?.application || {}
  const students = data?.students || []
  const list = Array.isArray(application.participants) ? application.participants : null
  const finalidade = application.finalidade || 'regular'
  const mode = finalidade === 'segunda_chamada' ? 'segunda_chamada'
    : finalidade === 'recuperacao' ? 'recuperacao'
      : list ? 'escolher' : 'turma'
  const overrides = {}
  students.forEach((student) => {
    if (!student.override) return
    overrides[student.email] = {
      extraAttempts: String(student.override.extraAttempts || 0),
      prazoAte: student.override.prazoAte || null,
      prazoAteLabel: student.override.prazoAteLabel || '',
      prazoAteLocal: '',
      motivo: student.override.motivo || '',
    }
  })
  return { mode, selected: list || [], overrides, touched: true }
}

function finalidadeOf(mode) {
  if (mode === 'segunda_chamada') return 'segunda_chamada'
  if (mode === 'recuperacao') return 'recuperacao'
  return 'regular'
}

// Problema do "Para quem" antes de mandar (o servidor confere de novo), ou null.
export function audienceProblem(audience) {
  if (!audience || audience.mode === 'turma') return overridesProblem(audience)
  if (!audience.selected.length) return 'Escolha pelo menos um aluno para esta aplicação.'
  return overridesProblem(audience)
}

function overridesProblem(audience) {
  for (const [email, entry] of Object.entries(audience?.overrides || {})) {
    const extra = entry.extraAttempts === '' ? 0 : Number(entry.extraAttempts)
    if (!Number.isInteger(extra) || extra < 0 || extra > MAX_EXTRA_ATTEMPTS) return `Tentativas extras de ${email}: use um número de 0 a ${MAX_EXTRA_ATTEMPTS}.`
    if (String(entry.motivo || '').length > MAX_REASON_CHARS) return `O motivo da exceção de ${email} aceita no máximo ${MAX_REASON_CHARS} caracteres.`
  }
  return null
}

// O pedido do "Para quem" (applicationOptions na preparação e corpo da rota de
// participantes). Sem mudança nenhuma (turma inteira, sem exceção) não manda nada: o
// servidor faz como antes.
export function audiencePayload(audience, { timerMode } = {}) {
  if (!audience) return {}
  const studentOverrides = {}
  Object.entries(audience.overrides || {}).forEach(([email, entry]) => {
    const extraAttempts = entry.extraAttempts === '' ? 0 : Number(entry.extraAttempts)
    const deadline = timerMode === 'per_attempt'
      ? (entry.prazoAteLocal ? { prazoAteLocal: entry.prazoAteLocal } : { prazoAte: entry.prazoAte || null })
      : { prazoAte: null }
    const motivo = String(entry.motivo || '').trim()
    if (!extraAttempts && !deadline.prazoAteLocal && !deadline.prazoAte) {
      studentOverrides[email] = null
      return
    }
    studentOverrides[email] = { extraAttempts, ...deadline, motivo }
  })
  const payload = {
    finalidade: finalidadeOf(audience.mode),
    participants: audience.mode === 'turma' ? null : [...audience.selected],
  }
  if (Object.keys(studentOverrides).length) payload.studentOverrides = studentOverrides
  return payload
}

// Intervalo mínimo entre duas buscas da lista ao voltar para a janela.
const REFRESH_ON_FOCUS_MS = 10000

// Alunos da turma para o "Para quem" (GET participant-candidates). Só busca quando
// enabled: a tela que nunca abre o "Para quem" não faz o pedido. A lista se atualiza ao
// voltar para a janela (uma entrega pode ter chegado com a tela aberta) e pelo botão
// "Atualizar"; a atualização mantém a lista na tela enquanto busca (refreshing) e, se
// falhar, fica com a que já tinha.
export function useParticipantCandidates({ studentClass, courseId, examKey, applicationId, enabled = true }) {
  const [state, setState] = useState({ data: null, loading: false, refreshing: false, error: '' })
  const [reload, setReload] = useState(0)
  const lastFetchRef = useRef(0)
  const query = applicationId
    ? `applicationId=${encodeURIComponent(applicationId)}`
    : `studentClass=${encodeURIComponent(studentClass || '')}&courseId=${encodeURIComponent(courseId || '')}&examKey=${encodeURIComponent(examKey || '')}`
  const ready = enabled && (applicationId || (studentClass && examKey))
  const queryRef = useRef(query)
  useEffect(() => {
    if (!ready) return undefined
    let alive = true
    // Outra prova ou turma: começa do zero; a mesma: atualiza sem tirar a lista da tela.
    const sameQuery = queryRef.current === query
    queryRef.current = query
    lastFetchRef.current = Date.now()
    setState((current) => (sameQuery && current.data
      ? { ...current, refreshing: true, error: '' }
      : { data: null, loading: true, refreshing: false, error: '' }))
    api.get(`/api/admin/exam-applications/participant-candidates?${query}`)
      .then((data) => { if (alive) setState({ data: data || null, loading: false, refreshing: false, error: '' }) })
      .catch((e) => {
        if (!alive) return
        setState((current) => (current.data
          ? { ...current, refreshing: false }
          : { data: null, loading: false, refreshing: false, error: e?.message || 'Não foi possível carregar os alunos da turma.' }))
      })
    return () => { alive = false }
  }, [ready, query, reload])
  useEffect(() => {
    if (!ready) return undefined
    const refresh = () => {
      if (document.visibilityState === 'hidden') return
      if (Date.now() - lastFetchRef.current < REFRESH_ON_FOCUS_MS) return
      setReload((value) => value + 1)
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [ready])
  return { ...state, refetch: () => setReload((value) => value + 1) }
}

function formatDeadline(ms) {
  if (!ms) return ''
  try {
    return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ms)).replace(',', ' às')
  } catch {
    return ''
  }
}

// "Para quem" da aplicação. value/onChange: o estado de initialAudience. candidates: a
// resposta de participant-candidates. lockedEmails: quem não pode sair da lista (prova em
// andamento). lockMode: a finalidade não muda mais (prova já começou).
export function ApplicationAudienceFields({ value, onChange, candidates, loading = false, refreshing = false, error = '', onRetry, timerMode, lockedEmails = [], lockMode = false }) {
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState('')
  const [lateDeliveries, setLateDeliveries] = useState([])
  const previousCandidatesRef = useRef(candidates)
  const audience = value || initialAudience()
  const students = useMemo(() => candidates?.students || [], [candidates])
  const nameOf = useMemo(() => new Map(students.map((student) => [student.email, student.name || student.email])), [students])
  const locked = useMemo(() => new Set(lockedEmails), [lockedEmails])
  const selected = useMemo(() => new Set(audience.selected), [audience.selected])
  const restricted = audience.mode !== 'turma'
  const visible = useMemo(() => students.filter((student) => matchesSearch([student.name, student.email], query)), [students, query])
  const modeInfo = AUDIENCE_MODES.find((mode) => mode.value === audience.mode) || AUDIENCE_MODES[0]
  const exceptionEmails = Object.keys(audience.overrides || {})
  // Segunda chamada escolhida antes de a lista chegar: marca quem não fez assim que ela chega.
  useEffect(() => {
    if (audience.pendingSeed && candidates) onChange({ ...audience, selected: [...(candidates.segundaChamada || [])], pendingSeed: false, touched: true })
  }, [audience, candidates, onChange])
  // A lista chegou de novo (voltar para a janela, "Atualizar") e alguém que estava marcado
  // na segunda chamada entregou a prova regular nesse meio tempo: sai da lista, com aviso.
  // Quem o professor marcou já com "Já fez" fica como ele deixou.
  useEffect(() => {
    const previous = previousCandidatesRef.current
    previousCandidatesRef.current = candidates
    if (!previous || !candidates || previous === candidates || audience.mode !== 'segunda_chamada') return
    const before = new Map((previous.students || []).map((student) => [student.email, student.fezRegular]))
    const nowDone = (candidates.students || [])
      .filter((student) => student.fezRegular && before.get(student.email) === false && audience.selected.includes(student.email) && !locked.has(student.email))
      .map((student) => student.email)
    if (!nowDone.length) return
    setLateDeliveries(nowDone)
    onChange({
      ...audience,
      selected: audience.selected.filter((email) => !nowDone.includes(email)),
      overrides: Object.fromEntries(Object.entries(audience.overrides || {}).filter(([email]) => !nowDone.includes(email))),
      touched: true,
    })
  }, [audience, candidates, locked, onChange])
  const eligible = students.filter((student) => !exceptionEmails.includes(student.email) && (!restricted || selected.has(student.email)))

  function update(next) { setLateDeliveries([]); onChange({ ...audience, ...next, touched: true }) }

  function chooseMode(mode) {
    if (lockMode || mode === audience.mode) return
    let nextSelected = audience.selected
    // Segunda chamada: a lista vem marcada com quem ainda não fez a prova.
    if (mode === 'segunda_chamada') nextSelected = [...(candidates?.segundaChamada || [])]
    else if (mode === 'turma') nextSelected = []
    else if (!audience.selected.length || audience.mode === 'turma') nextSelected = []
    const overrides = mode === 'turma'
      ? audience.overrides
      : Object.fromEntries(Object.entries(audience.overrides || {}).filter(([email]) => nextSelected.includes(email)))
    update({ mode, selected: nextSelected, overrides, pendingSeed: mode === 'segunda_chamada' && !candidates })
  }

  function toggle(email) {
    if (locked.has(email) && selected.has(email)) return
    const nextSelected = selected.has(email) ? audience.selected.filter((item) => item !== email) : [...audience.selected, email]
    const overrides = { ...(audience.overrides || {}) }
    if (!nextSelected.includes(email)) delete overrides[email]
    update({ selected: nextSelected, overrides })
  }

  function setAll(checked) {
    const emails = visible.map((student) => student.email)
    const nextSelected = checked
      ? [...new Set([...audience.selected, ...emails])]
      : audience.selected.filter((email) => !emails.includes(email) || locked.has(email))
    const overrides = Object.fromEntries(Object.entries(audience.overrides || {}).filter(([email]) => nextSelected.includes(email)))
    update({ selected: nextSelected, overrides })
  }

  function addException() {
    if (!adding) return
    update({ overrides: { ...(audience.overrides || {}), [adding]: { extraAttempts: '1', prazoAte: null, prazoAteLocal: '', motivo: '' } } })
    setAdding('')
  }

  function changeException(email, patch) {
    update({ overrides: { ...(audience.overrides || {}), [email]: { ...audience.overrides[email], ...patch } } })
  }

  function removeException(email) {
    // Na aplicação já preparada a exceção que existia é retirada no servidor: zero
    // tentativas e sem prazo.
    update({ overrides: { ...(audience.overrides || {}), [email]: { extraAttempts: '0', prazoAte: null, prazoAteLocal: '', motivo: audience.overrides[email]?.motivo || '', removed: true } } })
  }

  const shownExceptions = exceptionEmails.filter((email) => !audience.overrides[email]?.removed)

  return (
    <div className="space-y-3" data-testid="application-audience">
      <fieldset className="space-y-2">
        <legend className="text-[13px] font-medium text-muted">Para quem</legend>
        <div role="radiogroup" aria-label="Para quem" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {audienceModes().map((mode) => (
            <button
              key={mode.value}
              type="button"
              role="radio"
              aria-checked={audience.mode === mode.value}
              disabled={lockMode && audience.mode !== mode.value}
              onClick={() => chooseMode(mode.value)}
              className={`min-h-[44px] rounded-lg border px-3 py-2 text-left text-sm font-semibold transition disabled:opacity-50 ${audience.mode === mode.value ? 'border-primary bg-primary-soft text-primary' : 'border-border bg-surface text-text hover:bg-surface-2'}`}
            >
              {mode.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-subtle">{lockMode ? 'A prova já começou: dá para acrescentar alunos, não tirar.' : modeInfo.hint}</p>
      </fieldset>

      {(restricted || exceptionEmails.length > 0) && loading && <p className="text-sm text-muted">Carregando os alunos da turma...</p>}
      {(restricted || exceptionEmails.length > 0) && error && (
        <div role="alert" className="rounded-lg border border-danger/40 bg-danger-soft/40 p-3 text-sm text-text">
          {error} {onRetry && <Button size="sm" variant="secondary" icon={RefreshCw} onClick={onRetry}>Tentar de novo</Button>}
        </div>
      )}

      {lateDeliveries.length > 0 && (
        <p role="status" className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-text" data-testid="late-deliveries">
          {lateDeliveries.length === 1
            ? `${nameOf.get(lateDeliveries[0]) || lateDeliveries[0]} entregou a prova regular agora há pouco e saiu da segunda chamada. Marque de novo se precisar.`
            : `${lateDeliveries.length} alunos entregaram a prova regular agora há pouco e saíram da segunda chamada. Marque de novo se precisar.`}
        </p>
      )}

      {restricted && !loading && !error && (
        // Recolhível (no celular a lista longa empurra o resto da preparação para baixo); o
        // resumo continua dizendo quantos estão marcados.
        <details className="group rounded-lg border border-border p-3" open data-testid="audience-list">
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-2 text-sm font-semibold text-text">
            <span><Users size={15} className="inline mr-1" aria-hidden />{audience.selected.length} de {students.length} {students.length === 1 ? 'aluno marcado' : 'alunos marcados'}</span>
            <span className="text-xs font-normal text-subtle"><span className="group-open:hidden">Mostrar a lista</span><span className="hidden group-open:inline">Recolher</span></span>
          </summary>
          <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {onRetry && <Button size="sm" variant="ghost" icon={RefreshCw} loading={refreshing} onClick={onRetry}>Atualizar</Button>}
            <Button size="sm" variant="ghost" onClick={() => setAll(true)}>Marcar todos</Button>
            <Button size="sm" variant="ghost" onClick={() => setAll(false)}>Desmarcar todos</Button>
          </div>
          <Input label="Buscar aluno" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nome ou e-mail" />
          {students.length === 0 && <p className="text-sm text-muted">Nenhum aluno ativo nesta turma.</p>}
          <ul className="max-h-72 overflow-y-auto divide-y divide-border" aria-label="Alunos da turma">
            {visible.map((student) => {
              const checked = selected.has(student.email)
              const fixed = checked && locked.has(student.email)
              return (
                <li key={student.email}>
                  <label className="flex min-h-[44px] cursor-pointer items-center gap-3 py-2">
                    <input
                      type="checkbox"
                      className="h-5 w-5 shrink-0"
                      checked={checked}
                      disabled={fixed}
                      onChange={() => toggle(student.email)}
                      aria-label={student.name || student.email}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-text">{student.name || student.email}</span>
                      <span className="block truncate text-xs text-subtle">{student.email}</span>
                      {/* Entregou numa segunda chamada anterior: continua marcado (a lista
                          pré-marcada é de quem não fez a regular), mas o professor vê o aviso,
                          embaixo do nome para não cortá-lo no celular. */}
                      {!student.fezRegular && student.fezSegundaChamada && <span className="mt-1 block"><Badge tone="neutral">Fez a segunda chamada</Badge></span>}
                    </span>
                    {student.fezRegular && <Badge tone="info">Já fez</Badge>}
                  </label>
                </li>
              )
            })}
          </ul>
          </div>
        </details>
      )}

      <details className="rounded-lg border border-border p-3" open={shownExceptions.length > 0 || undefined}>
        <summary className="cursor-pointer text-sm font-semibold text-text min-h-[32px]">Exceção por aluno {shownExceptions.length ? `(${shownExceptions.length})` : ''}</summary>
        <div className="mt-3 space-y-3">
          <p className="text-xs text-subtle">
            Tentativas a mais para um aluno só, sem reabrir a prova para a turma.
            {timerMode === 'per_attempt' ? ' Também dá para marcar até quando ele pode começar.' : ' O prazo para começar só vale com o cronômetro “Quando cada aluno iniciar”.'}
          </p>
          {shownExceptions.map((email) => {
            const entry = audience.overrides[email]
            return (
              <div key={email} className="space-y-2 rounded-lg border border-border p-3" data-testid={`exception-${email}`}>
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 text-sm font-semibold text-text break-words">{nameOf.get(email) || email}</p>
                  <Button size="sm" variant="ghost" icon={X} aria-label={`Retirar a exceção de ${nameOf.get(email) || email}`} onClick={() => removeException(email)}>Retirar</Button>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Input label="Tentativas extras" type="number" min="0" max={MAX_EXTRA_ATTEMPTS} step="1" value={entry.extraAttempts} onChange={(e) => changeException(email, { extraAttempts: e.target.value })} />
                  {timerMode === 'per_attempt' && (
                    <div className="space-y-1">
                      <Input
                        label="Pode começar até"
                        type="datetime-local"
                        value={entry.prazoAteLocal}
                        helper={entry.prazoAte && !entry.prazoAteLocal ? `Prazo atual: até ${entry.prazoAteLabel || formatDeadline(entry.prazoAte)}. Escolha outra data para mudar.` : 'Deixe em branco para não ter prazo.'}
                        onChange={(e) => changeException(email, { prazoAteLocal: e.target.value })}
                      />
                      {(entry.prazoAte || entry.prazoAteLocal) && (
                        <Button size="sm" variant="ghost" icon={X} aria-label={`Tirar o prazo de ${nameOf.get(email) || email}`} onClick={() => changeException(email, { prazoAte: null, prazoAteLabel: '', prazoAteLocal: '' })}>Tirar o prazo</Button>
                      )}
                    </div>
                  )}
                </div>
                <Input label="Motivo (opcional)" value={entry.motivo} maxLength={MAX_REASON_CHARS} counterFrom={250} onChange={(e) => changeException(email, { motivo: e.target.value })} />
              </div>
            )
          })}
          {!loading && !error && candidates && (
            eligible.length ? (
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
                <Select label="Aluno" value={adding} onChange={(e) => setAdding(e.target.value)}>
                  <option value="">Escolha o aluno</option>
                  {eligible.map((student) => <option key={student.email} value={student.email}>{student.name || student.email}</option>)}
                </Select>
                <Button type="button" variant="secondary" icon={UserPlus} disabled={!adding} onClick={addException}>Adicionar</Button>
              </div>
            ) : <p className="text-xs text-muted">{restricted ? 'Marque o aluno na lista para dar uma exceção a ele.' : 'Nenhum aluno para adicionar.'}</p>
          )}
        </div>
      </details>
    </div>
  )
}

// Campo "Registro do teclado" das telas de preparar (H8b, CRIT-04): vale para a
// aplicação inteira e não muda depois de preparada.
export function KeystrokeModeSelect({ value, onChange }) {
  return (
    <div className="flex flex-col gap-1">
      <Select label="Registro do teclado" value={value || DEFAULT_KEYSTROKE_MODE} onChange={(e) => onChange(e.target.value)}>
        {KEYSTROKE_MODE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </Select>
      <span className="text-xs text-subtle">{keystrokeModeDescription(value)}</span>
    </div>
  )
}

// Campos de "Aplicar prova novamente" (extraídos da tela Provas): versões, duração, sala
// de espera, cronômetro, tentativas, teclado, token e o "Para quem". value/onChange: o
// estado applyHistory da tela; tokenTools: { normalize, generate } do token.
export function PrepareApplicationForm({ value, onChange, candidates, tokenTools }) {
  const set = (patch) => onChange({ ...value, ...patch })
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-surface-2/60 p-3">
        <p className="text-sm font-semibold text-text">{value.entry.label || 'Aplicação salva'}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Badge tone="neutral">{value.entry.questionCount || value.entry.questionNumbers?.length || 0} questões fixas</Badge>
          <Badge tone="info">{value.availableVersions} {value.availableVersions === 1 ? 'versão disponível' : 'versões disponíveis'}</Badge>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input label="Versões online" type="number" min="1" max={value.availableVersions} value={value.onlineVersions} onChange={(e) => set({ onlineVersions: Math.max(1, Math.min(value.availableVersions, Number(e.target.value) || 1)) })} />
        <Input label="Duração (min)" type="number" min="1" value={value.durationMinutes} onChange={(e) => set({ durationMinutes: e.target.value })} />
        <Input label="Sala de espera (min)" type="number" min="0" value={value.waitingRoomMinutes} helper="Padrão: 10 minutos" onChange={(e) => set({ waitingRoomMinutes: e.target.value })} />
        <Select label="Início do cronômetro" value={value.timerMode} onChange={(e) => set({ timerMode: e.target.value })}>
          <option value="per_attempt">Quando cada aluno iniciar</option>
          <option value="collective">Junto com a turma</option>
        </Select>
        <div className="sm:col-span-2">
          <Input label="Tentativas permitidas" type="number" min="1" max="10" step="1" placeholder="Ilimitadas" value={value.maxAttempts} onChange={(e) => set({ maxAttempts: e.target.value })} helper="Padrão: 1 tentativa. Deixe em branco para não limitar." />
        </div>
        <div className="sm:col-span-2">
          <KeystrokeModeSelect value={value.keystrokeMode} onChange={(keystrokeMode) => set({ keystrokeMode })} />
        </div>
        {value.tokenEnabled && <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
          <Input label="Token de acesso" value={value.accessToken} maxLength={5} autoComplete="off" spellCheck={false} className="font-mono text-base font-semibold tracking-[0.2em]" helper="Obrigatório · 5 letras" onChange={(e) => set({ accessToken: tokenTools.normalize(e.target.value) })} />
          <Button type="button" variant="secondary" icon={RefreshCw} aria-label="Gerar novo token" onClick={() => set({ accessToken: tokenTools.generate() })}>Novo</Button>
        </div>}
      </div>

      <div className="rounded-lg border border-border p-3">
        <div className="space-y-3">
          <Switch label="Cronômetro ativo" checked={value.timerEnabled} onChange={(checked) => set({ timerEnabled: checked })} />
          <Switch label="Exigir token de acesso" checked={value.tokenEnabled} onChange={(checked) => set({ tokenEnabled: checked, accessToken: value.accessToken || tokenTools.generate() })} />
        </div>
      </div>

      <ApplicationAudienceFields
        value={value.audience}
        onChange={(audience) => set({ audience })}
        candidates={candidates.data}
        loading={candidates.loading}
        refreshing={candidates.refreshing}
        error={candidates.error}
        onRetry={candidates.refetch}
        timerMode={value.timerMode}
      />
    </div>
  )
}

// "Alunos desta aplicação" para a aplicação já preparada ou em andamento: muda a lista,
// a finalidade (só antes de começar) e as exceções por aluno (POST .../participants).
export function ApplicationAudienceModal({ open, application, onClose, onSaved, toast }) {
  const candidates = useParticipantCandidates({ applicationId: application?.id, enabled: open && !!application?.id })
  const [audience, setAudience] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (!open) setAudience(null) }, [open])
  useEffect(() => {
    if (open && candidates.data && !audience) setAudience(audienceFromApplication(candidates.data))
  }, [open, candidates.data, audience])
  const started = ['waiting', 'running', 'paused'].includes(application?.status)
  const lockedEmails = started && Array.isArray(candidates.data?.application?.participants) ? candidates.data.application.participants : []
  const timerMode = candidates.data?.application?.timerMode || application?.timerMode

  async function save() {
    const problem = audienceProblem(audience)
    if (problem) return toast?.error(problem)
    setBusy(true)
    try {
      const response = await api.post(`/api/admin/exam-applications/${encodeURIComponent(application.id)}/participants`, audiencePayload(audience, { timerMode }))
      toast?.success(response?.unchanged ? 'Nada mudou na lista desta aplicação.' : 'Alunos da aplicação atualizados.')
      onSaved?.(response?.application)
      onClose()
    } catch (e) {
      toast?.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title="Alunos desta aplicação"
      description="Quem pode fazer esta aplicação e as exceções por aluno."
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancelar</Button>
        <Button loading={busy} disabled={!audience} onClick={save}>Salvar</Button>
      </>}
    >
      {candidates.loading && !audience && <p className="text-sm text-muted">Carregando os alunos da turma...</p>}
      {candidates.error && !audience && <p role="alert" className="text-sm text-danger">{candidates.error}</p>}
      {audience && (
        <ApplicationAudienceFields
          value={audience}
          onChange={setAudience}
          candidates={candidates.data}
          loading={false}
          refreshing={candidates.refreshing}
          onRetry={candidates.refetch}
          timerMode={timerMode}
          lockedEmails={lockedEmails}
          lockMode={started}
        />
      )}
    </Modal>
  )
}
