import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { BookOpen, Search } from 'lucide-react'
import { PageHeader } from '../../components/ui/PageHeader'
import { PageLoading } from '../../components/ui/PageLoading'
import { Button } from '../../components/ui/Button'
import { cn } from '../../lib/cn'
import { matchesSearch } from '../../lib/textSearch'
import { DEFAULT_HELP_DOC, HELP_DOCS, findHelpDoc, loadHelpDoc, visibleSections } from './helpDocs'
import { HelpArticle } from './HelpArticle'

// Tela /ajuda do painel (fase 3, A1 / P6-S9: OPS-13, UXI-04; D20 do P6): o índice dos
// cinco textos da Ajuda e as Novidades, a busca pelo título dos temas (sem acento, em
// todos os textos) e o texto escolhido. ?doc=<texto> escolhe o texto (o manual do
// professor sem ele) e #<âncora> leva ao tema (o HelpLink das telas usa os dois).
// No celular o índice vira um seletor no topo; o texto tem largura de leitura e tabela
// larga rola dentro dela.

function docHref(docId, anchor = '') {
  const query = docId && docId !== DEFAULT_HELP_DOC ? `?doc=${encodeURIComponent(docId)}` : ''
  return `/ajuda${query}${anchor ? `#${anchor}` : ''}`
}

function useHelpDoc(docId) {
  const [state, setState] = useState({ docId: null, doc: null, error: '' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setState((current) => ({ ...current, error: '' }))
    loadHelpDoc(docId)
      .then((doc) => { if (active) setState({ docId, doc, error: '' }) })
      .catch((error) => { if (active) setState({ docId, doc: null, error: error?.message || 'Não foi possível abrir este texto da ajuda.' }) })
    return () => { active = false }
  }, [docId, attempt])
  const current = state.docId === docId ? state : { docId, doc: null, error: '' }
  return { ...current, retry: () => setAttempt((value) => value + 1) }
}

// Busca pelo título dos temas em todos os textos (carrega os que faltam na primeira busca).
function useHelpSearch(term) {
  const [docs, setDocs] = useState(null)
  const active = term.trim().length > 0
  useEffect(() => {
    if (!active || docs) return undefined
    let alive = true
    Promise.all(HELP_DOCS.map((entry) => loadHelpDoc(entry.id).then((doc) => ({ entry, doc })).catch(() => null)))
      .then((list) => { if (alive) setDocs(list.filter(Boolean)) })
    return () => { alive = false }
  }, [active, docs])
  return useMemo(() => {
    if (!active) return null
    if (!docs) return []
    return docs.flatMap(({ entry, doc }) => visibleSections(doc)
      .filter((section) => matchesSearch([section.titulo], term))
      .map((section) => ({ docId: entry.id, docTitle: entry.titulo, id: section.id, titulo: section.titulo })))
  }, [active, docs, term])
}

export default function AjudaPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const params = new URLSearchParams(location.search)
  const requested = params.get('doc') || DEFAULT_HELP_DOC
  const entry = findHelpDoc(requested) || findHelpDoc(DEFAULT_HELP_DOC)
  const { doc, error, retry } = useHelpDoc(entry.id)
  const [term, setTerm] = useState('')
  const results = useHelpSearch(term)
  const anchor = decodeURIComponent((location.hash || '').replace(/^#/, ''))
  const sections = useMemo(() => visibleSections(doc), [doc])
  const articleRef = useRef(null)

  // Vai ao tema da âncora quando o texto chega (ou quando a âncora muda).
  useEffect(() => {
    if (!doc) return
    if (!anchor) return
    const target = Array.from(articleRef.current?.querySelectorAll('[id]') || []).find((element) => element.id === anchor)
    if (target) {
      target.scrollIntoView?.({ block: 'start' })
      target.focus?.({ preventScroll: true })
    }
  }, [doc, anchor])

  const anchorMissing = !!(doc && anchor && !sections.some((section) => section.id === anchor))

  return (
    <div className="space-y-5">
      <PageHeader title="Ajuda" subtitle="Manual do IClass para o professor, o aluno e quem cuida do computador da escola." />

      <div className="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="space-y-4 min-w-0">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-text">Buscar na ajuda</span>
            <span className="relative">
              <Search aria-hidden="true" size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
              <input
                type="search"
                value={term}
                onChange={(event) => setTerm(event.target.value)}
                placeholder="Ex.: senha, backup, prova"
                className="h-11 w-full rounded-lg border border-border bg-surface pl-9 pr-3 text-sm text-text"
              />
            </span>
          </label>

          <label className="flex flex-col gap-1.5 lg:hidden">
            <span className="text-sm font-medium text-text">Assunto</span>
            <select
              value={entry.id}
              onChange={(event) => navigate(docHref(event.target.value))}
              className="h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text"
            >
              {HELP_DOCS.map((item) => <option key={item.id} value={item.id}>{item.titulo}</option>)}
            </select>
          </label>

          <nav aria-label="Assuntos da ajuda" className="hidden lg:block">
            <ul className="space-y-1">
              {HELP_DOCS.map((item) => (
                <li key={item.id}>
                  <Link
                    to={docHref(item.id)}
                    aria-current={item.id === entry.id ? 'page' : undefined}
                    className={cn('flex items-center gap-2 rounded-lg px-3 py-2 text-sm', item.id === entry.id ? 'bg-primary-soft font-semibold text-text' : 'text-muted hover:bg-surface-2 hover:text-text')}
                  >
                    <BookOpen aria-hidden="true" size={15} /> {item.titulo}
                  </Link>
                  {item.id === entry.id && sections.length > 0 && (
                    <ul className="mt-1 mb-2 ml-6 space-y-0.5 border-l border-border pl-3">
                      {sections.map((section) => (
                        <li key={section.id}>
                          <Link to={docHref(item.id, section.id)} className={cn('block rounded px-1 py-0.5 text-[13px]', section.id === anchor ? 'font-semibold text-text' : 'text-muted hover:text-text')}>{section.titulo}</Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        </aside>

        <div className="min-w-0 space-y-4">
          {results && (
            <section aria-label="Resultado da busca" className="rounded-xl border border-border bg-surface p-4">
              <h2 className="text-sm font-semibold text-text">Resultado da busca</h2>
              {results.length === 0 ? (
                <p className="mt-2 text-sm text-muted" role="status">Nenhum tema com “{term.trim()}” no título.</p>
              ) : (
                <ul className="mt-2 space-y-1" role="list">
                  {results.map((item) => (
                    <li key={`${item.docId}#${item.id}`}>
                      <Link to={docHref(item.docId, item.id)} onClick={() => setTerm('')} className="text-sm text-text underline">{item.titulo}</Link>
                      <span className="text-xs text-subtle"> · {item.docTitle}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {!doc && !error && <PageLoading />}
          {error && !doc && (
            <div role="alert" className="rounded-xl border border-border bg-surface p-6 text-center space-y-3">
              <p className="text-sm">Não foi possível abrir este texto da ajuda. {error}</p>
              <Button variant="secondary" onClick={retry}>Tentar de novo</Button>
            </div>
          )}

          {doc && (
            <article ref={articleRef} className="max-w-prose rounded-xl border border-border bg-surface p-5 sm:p-7" aria-labelledby="ajuda-titulo">
              <h2 id="ajuda-titulo" className="text-xl font-bold text-text">{doc.titulo || entry.titulo}</h2>
              {anchorMissing && <p className="mt-2 text-sm text-muted" role="status">O texto sobre esta tela ainda está sendo escrito. Veja os outros temas abaixo.</p>}
              {doc.intro && <HelpArticle markdown={doc.intro} shift={1} className="mt-2" />}
              {sections.map((section) => (
                <section key={section.id} aria-labelledby={`tema-${section.id}`} className="mt-6 scroll-mt-24">
                  <h3 id={section.id} tabIndex={-1} className="scroll-mt-24 text-lg font-semibold text-text focus:outline-none">
                    <span id={`tema-${section.id}`}>{section.titulo}</span>
                  </h3>
                  <HelpArticle markdown={section.corpo} shift={1} className="mt-1" />
                </section>
              ))}
              {sections.length === 0 && !doc.intro && <p className="mt-3 text-sm text-muted">Este texto ainda está sendo escrito.</p>}
            </article>
          )}
        </div>
      </div>
    </div>
  )
}
