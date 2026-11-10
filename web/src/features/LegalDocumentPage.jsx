import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ArrowLeft, FileText } from 'lucide-react'
import { api } from '../lib/api'
import { legalMarkdownToHtml } from '../lib/legalMarkdown'
import { Button } from '../components/ui/Button'
import { PageLoading } from '../components/ui/PageLoading'

// Páginas públicas /termos e /privacidade (H8a-1; SEG-08, OPS-12): abrem com ou sem
// login, também no celular do aluno, e mostram o texto atual com os dados da escola
// (GET /api/legal/documents). ?courseId= ou ?escola= escolhem a escola cujos dados
// preenchem o texto (o cadastro do aluno abre com o curso escolhido). O texto passa
// pelo markdownToHtml, que limpa o HTML com o DOMPurify (legalMarkdownToHtml: os títulos
// do texto descem um nível, para a página ter um só h1). Os links usam a cor do texto,
// sublinhados: a cor da marca no fundo claro não tem contraste AA (WCAG 1.4.3).
//
// Enquanto a escola não publica, a página mostra o modelo do IClass com o aviso de que
// ele ainda não foi revisado e o aviso do modelo (notice, que fica fora do texto: a
// versão publicada a partir do modelo não o leva); ninguém precisa aceitar nada até lá
// (decisão P4).

const KINDS = {
  termos: { key: 'terms', path: '/termos', other: 'privacidade' },
  privacidade: { key: 'privacy', path: '/privacidade', other: 'termos' },
}

export const MODEL_NOTICE = 'Modelo padrão do IClass, ainda não revisado e publicado pela instituição'

export function fmtLegalDate(iso) {
  const time = Date.parse(String(iso || ''))
  if (!Number.isFinite(time)) return ''
  return new Date(time).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

// Linha abaixo do título: a versão publicada ou o aviso do modelo.
export function legalVersionLine(doc) {
  if (!doc || doc.isModel) return MODEL_NOTICE
  const date = fmtLegalDate(doc.publishedAt)
  return date ? `Versão ${doc.version}, publicada em ${date}` : `Versão ${doc.version}`
}

// Só os parâmetros que escolhem a escola seguem para o outro documento e para a API.
function schoolQuery(search) {
  const params = new URLSearchParams(search)
  const out = new URLSearchParams()
  ;['courseId', 'escola'].forEach((key) => { const value = params.get(key); if (value) out.set(key, value) })
  const text = out.toString()
  return text ? `?${text}` : ''
}

export default function LegalDocumentPage({ kind = 'termos' }) {
  const config = KINDS[kind] || KINDS.termos
  const location = useLocation()
  const query = schoolQuery(location.search)
  const [state, setState] = useState({ loading: true, error: '', data: null })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    setState((current) => ({ ...current, loading: true, error: '' }))
    api.get(`/api/legal/documents${query}`, { auth: false })
      .then((data) => { if (active) setState({ loading: false, error: '', data }) })
      .catch((error) => { if (active) setState({ loading: false, error: error?.message || 'Não foi possível carregar o documento.', data: null }) })
    return () => { active = false }
  }, [query, attempt])

  const doc = state.data ? state.data[config.key] : null
  const otherDoc = state.data ? state.data[KINDS[config.other].key] : null
  const html = useMemo(() => (doc ? legalMarkdownToHtml(doc.markdown || '') : ''), [doc])

  useEffect(() => {
    if (doc?.title) document.title = doc.title
  }, [doc?.title])

  return (
    <main className="min-h-screen bg-bg text-text">
      <div className="mx-auto max-w-3xl px-4 py-6 sm:py-10">
        <nav className="mb-6 flex flex-wrap items-center justify-between gap-3 text-sm">
          <Link to="/" className="inline-flex items-center gap-1.5 text-muted hover:text-text">
            <ArrowLeft aria-hidden="true" size={16} /> Voltar ao IClass
          </Link>
          {otherDoc && (
            <Link to={`${KINDS[config.other].path}${query}`} className="inline-flex items-center gap-1.5 font-medium text-text underline">
              <FileText aria-hidden="true" size={16} /> {otherDoc.title}
            </Link>
          )}
        </nav>

        {state.loading && !doc && <PageLoading />}

        {state.error && !doc && (
          <div role="alert" className="rounded-xl border border-border bg-surface p-6 text-center space-y-3">
            <p className="text-sm">Não foi possível carregar o documento. {state.error}</p>
            <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>Tentar de novo</Button>
          </div>
        )}

        {doc && (
          <article className="rounded-xl border border-border bg-surface p-5 sm:p-8 shadow-sm">
            <header className="mb-4 border-b border-border pb-4">
              <h1 className="text-2xl font-bold">{doc.title}</h1>
              <p className={doc.isModel ? 'mt-2 inline-block rounded-md bg-warning-soft px-2 py-1 text-sm font-medium text-text' : 'mt-1 text-sm text-muted'} data-testid="legal-version">
                {legalVersionLine(doc)}
              </p>
              {state.data?.school?.name && <p className="mt-1 text-sm text-muted">{state.data.school.name}</p>}
              {doc.isModel && doc.notice && <p className="mt-2 text-sm text-text" data-testid="legal-notice">{doc.notice}</p>}
            </header>
            <div className="prose-iclass break-words [&_a]:text-text" dangerouslySetInnerHTML={{ __html: html }} />
          </article>
        )}
      </div>
    </main>
  )
}
