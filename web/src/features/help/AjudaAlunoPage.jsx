import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ArrowLeft, ChevronDown } from 'lucide-react'
import { useAuth } from '../../context/AuthProvider'
import { PageLoading } from '../../components/ui/PageLoading'
import { Button } from '../../components/ui/Button'
import { anchorFromHash, loadHelpDoc, visibleSections } from './helpDocs'
import { HelpArticle } from './HelpArticle'

// Ajuda do aluno, /ajuda/aluno (fase 3, A1 / P6-S9: OPS-13; D20 do P6). Pública: abre
// sem login, porque é justamente quem não consegue entrar que procura ajuda (o login leva
// aqui por "Problemas para entrar?", e o menu do aluno pelo item Ajuda). O texto é o
// aluno.md; cada tema é uma seção recolhível (details), com letra de 16 px e sem rolagem
// horizontal a 375 px. #<âncora> abre o tema e vai até ele.
export const STUDENT_HELP_TITLE = 'Ajuda para o aluno'

export default function AjudaAlunoPage() {
  const { auth } = useAuth()
  const location = useLocation()
  const anchor = anchorFromHash(location.hash)
  const [state, setState] = useState({ doc: null, error: '' })
  const [attempt, setAttempt] = useState(0)
  const [open, setOpen] = useState(() => new Set(anchor ? [anchor] : []))
  const listRef = useRef(null)

  useEffect(() => {
    let active = true
    setState((current) => ({ ...current, error: '' }))
    loadHelpDoc('aluno')
      .then((doc) => { if (active) setState({ doc, error: '' }) })
      .catch((error) => { if (active) setState({ doc: null, error: error?.message || 'Não foi possível abrir a ajuda.' }) })
    return () => { active = false }
  }, [attempt])

  useEffect(() => {
    document.title = STUDENT_HELP_TITLE
  }, [])

  // A âncora abre o tema e rola até ele.
  useEffect(() => {
    if (!anchor) return
    setOpen((current) => (current.has(anchor) ? current : new Set([...current, anchor])))
  }, [anchor])
  useEffect(() => {
    if (!state.doc || !anchor) return
    const target = Array.from(listRef.current?.querySelectorAll('details[id]') || []).find((element) => element.id === anchor)
    target?.scrollIntoView?.({ block: 'start' })
  }, [state.doc, anchor])

  const sections = visibleSections(state.doc)
  // Âncora de um tema ainda sem texto (ou que não existe): avisa, como a Ajuda do painel.
  const anchorMissing = !!(state.doc && anchor && !sections.some((section) => section.id === anchor))
  const back = auth?.role === 'student' ? { to: '/aluno', label: 'Voltar ao portal' } : auth?.role === 'admin' ? { to: '/', label: 'Voltar ao painel' } : { to: '/login', label: 'Voltar para a entrada' }

  function toggle(id, isOpen) {
    setOpen((current) => {
      const next = new Set(current)
      if (isOpen) next.add(id)
      else next.delete(id)
      return next
    })
  }

  return (
    <main className="min-h-screen bg-bg text-text">
      <div className="mx-auto max-w-2xl px-4 py-6 sm:py-10 text-base">
        <nav className="mb-5">
          <Link to={back.to} className="inline-flex min-h-[44px] items-center gap-1.5 text-muted hover:text-text">
            <ArrowLeft aria-hidden="true" size={16} /> {back.label}
          </Link>
        </nav>

        <h1 className="text-2xl font-bold">{state.doc?.titulo || STUDENT_HELP_TITLE}</h1>
        {state.doc?.intro && <HelpArticle markdown={state.doc.intro} shift={1} className="mt-2 text-base" />}

        {!state.doc && !state.error && <PageLoading />}
        {state.error && !state.doc && (
          <div role="alert" className="mt-4 rounded-xl border border-border bg-surface p-6 text-center space-y-3">
            <p>Não foi possível abrir a ajuda. {state.error}</p>
            <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>Tentar de novo</Button>
          </div>
        )}

        {anchorMissing && <p className="mt-4 text-sm text-muted" role="status">O texto sobre este assunto ainda está sendo escrito. Veja os outros temas abaixo.</p>}

        {state.doc && (
          <div ref={listRef} className="mt-5 space-y-3">
            {sections.map((section) => (
              <details
                key={section.id}
                id={section.id}
                open={open.has(section.id)}
                onToggle={(event) => toggle(section.id, event.currentTarget.open)}
                className="group scroll-mt-4 rounded-xl border border-border bg-surface"
              >
                <summary className="flex min-h-[48px] cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 font-semibold [&::-webkit-details-marker]:hidden">
                  <span>{section.titulo}</span>
                  <ChevronDown aria-hidden="true" size={18} className="shrink-0 transition-transform group-open:rotate-180" />
                </summary>
                <div className="border-t border-border px-4 pb-4 pt-2">
                  <HelpArticle markdown={section.corpo} shift={2} className="text-base" />
                </div>
              </details>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
