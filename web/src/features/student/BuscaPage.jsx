import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { BookOpen, FolderOpen, Megaphone, Search } from 'lucide-react'
import { Card } from '../../components/ui/Card'
import { EmptyState } from '../../components/ui/EmptyState'
import { HelpLink } from '../../components/ui/HelpLink'
import { PageState } from '../../components/ui/PageState'
import { useApi } from '../../hooks/useApi'
import { useStudent } from './useStudent'
import { useCourseContent } from './useCourseContent'
import { SEARCH_MIN_CHARS, SEARCH_RESULT_LIMIT, announcementEntries, apostilaEntries, libraryEntries, runSearch } from './busca/searchIndex'

// Busca do portal do aluno (fase 3, C16 / P5-S2; CRIT-07, D24 do P5): nas apostilas
// liberadas para a turma (por seção), na Biblioteca e nos avisos, sem acento e no próprio
// aparelho. O clique numa apostila abre o leitor na unidade, rolando até o trecho achado
// (/aluno/modulos?unidade=&busca=&secao=). O termo fica no endereço (?q=): voltar do
// leitor devolve a mesma busca.

// Espera entre as teclas antes de buscar (celular antigo com apostila grande).
export const SEARCH_DEBOUNCE_MS = 250

function Highlighted({ parts }) {
  return (parts || []).map((part, index) => (part.mark
    ? <mark key={index} className="busca-marca">{part.text}</mark>
    : <span key={index}>{part.text}</span>))
}

function ResultGroup({ title, icon: Icon, items }) {
  if (!items.length) return null
  return (
    <section aria-label={title} className="space-y-2">
      <h2 className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wider text-subtle"><Icon size={14} aria-hidden="true" /> {title} ({items.length})</h2>
      <Card className="divide-y divide-border overflow-hidden">
        {items.map((item) => (
          <Link key={`${item.kind}:${item.id}`} to={item.href} className="block min-h-[44px] px-4 py-3 transition hover:bg-surface-2/50 focus:outline-none focus-visible:bg-surface-2/60">
            <span className="block break-words text-sm font-semibold text-text">{item.title}</span>
            {item.context && <span className="mt-0.5 block break-words text-xs text-muted">{item.context}</span>}
            {item.snippet?.length > 0 && <span className="mt-1.5 block break-words text-sm text-muted"><Highlighted parts={item.snippet} /></span>}
          </Link>
        ))}
      </Card>
    </section>
  )
}

export default function BuscaPage() {
  const { email, courseId, studentClass } = useStudent()
  const [params, setParams] = useSearchParams()
  const initial = params.get('q') || ''
  const [input, setInput] = useState(initial)
  const [term, setTerm] = useState(initial)
  const inputRef = useRef(null)
  const ready = !!(email && courseId && studentClass)
  const context = `courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(studentClass)}`
  // Liberação de agora (a mesma do leitor): unidade bloqueada depois do download do
  // data.js não aparece, e a liberação nova faz o data.js vir de novo.
  const status = useApi(ready ? `/api/status?studentClass=${encodeURIComponent(studentClass)}&courseId=${encodeURIComponent(courseId)}&email=${encodeURIComponent(email)}` : null, [email, courseId, studentClass])
  const released = status.data && status.data.releasedItems && typeof status.data.releasedItems === 'object' ? status.data.releasedItems : null
  const content = useCourseContent({ releasedItems: released })
  const library = useApi(ready ? `/api/student/library?${context}` : null, [email, courseId, studentClass])
  const announcements = useApi(ready ? `/api/student/announcements?${context}` : null, [email, courseId, studentClass])

  useEffect(() => { inputRef.current?.focus() }, [])

  // Termo no endereço sem empilhar uma entrada por tecla (replace).
  useEffect(() => {
    const timer = setTimeout(() => {
      setTerm(input)
      const next = new URLSearchParams(params)
      if (input.trim()) next.set('q', input.trim())
      else next.delete('q')
      if (next.toString() !== params.toString()) setParams(next, { replace: true })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input])

  // Índice das apostilas montado uma vez por conteúdo (e por liberação), não a cada tecla.
  // Só monta quando há o que buscar: abrir a tela não trava o celular antigo.
  const trimmed = term.trim()
  const wantIndex = content.loaded && trimmed.replace(/\s+/g, '').length >= SEARCH_MIN_CHARS
  const apostilas = useMemo(() => (wantIndex ? apostilaEntries(content.data, released) : []), [wantIndex, content.data, released])
  const biblioteca = useMemo(() => libraryEntries(library.data), [library.data])
  const avisos = useMemo(() => announcementEntries(announcements.data), [announcements.data])
  const results = useMemo(() => runSearch({ apostilas, biblioteca, avisos }, term), [apostilas, biblioteca, avisos, term])

  const tooShort = trimmed.length > 0 && trimmed.replace(/\s+/g, '').length < SEARCH_MIN_CHARS
  const sideErrors = [library.error && 'na Biblioteca', announcements.error && 'nos avisos'].filter(Boolean)

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-text">Busca</h1>
          <p className="text-sm text-muted">Procure uma palavra nas apostilas liberadas para a sua turma, na Biblioteca e nos avisos.</p>
        </div>
        <HelpLink topic="busca" doc="aluno" className="h-11 w-11 shrink-0" />
      </div>
      <form role="search" onSubmit={(event) => { event.preventDefault(); setTerm(input) }}>
        <label htmlFor="busca-aluno" className="sr-only">Buscar</label>
        <div className="relative">
          <Search size={18} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
          <input
            ref={inputRef}
            id="busca-aluno"
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            maxLength={120}
            placeholder="Buscar nas apostilas, na biblioteca e nos avisos"
            className="h-12 w-full rounded-xl border border-border bg-surface pl-10 pr-3 text-base text-text placeholder:text-subtle focus:border-primary focus:outline-none"
          />
        </div>
      </form>
      <PageState loading={content.loading && !!trimmed} error={content.error} onRetry={() => { content.reload(); status.refetch() }}>
        {!trimmed ? (
          <Card><EmptyState icon={Search} title="O que você procura?" description="Digite uma palavra, por exemplo um assunto da aula. Não precisa digitar acento nem letra maiúscula." /></Card>
        ) : tooShort ? (
          <p className="px-1 text-sm text-muted">Digite pelo menos {SEARCH_MIN_CHARS} letras.</p>
        ) : results.total === 0 ? (
          <Card><EmptyState icon={Search} title={`Nenhum resultado para “${trimmed}”.`} description="Tente outra palavra." /></Card>
        ) : (
          <div className="space-y-5">
            <p className="px-1 text-sm text-muted" aria-live="polite">
              {results.total === 1 ? '1 resultado' : `${results.total} resultados`}
              {results.shown < results.total ? `. Mostrando ${results.shown} (no máximo ${SEARCH_RESULT_LIMIT}); use mais palavras para achar o trecho.` : '.'}
            </p>
            <ResultGroup title="Apostilas" icon={BookOpen} items={results.apostilas} />
            <ResultGroup title="Biblioteca" icon={FolderOpen} items={results.biblioteca} />
            <ResultGroup title="Avisos" icon={Megaphone} items={results.avisos} />
          </div>
        )}
        {trimmed && sideErrors.length > 0 && <p className="px-1 text-xs text-warning">Não foi possível buscar {sideErrors.join(' nem ')} agora. Tente de novo mais tarde.</p>}
      </PageState>
    </div>
  )
}
