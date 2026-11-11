import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ExternalLink, LogOut, ShieldCheck } from 'lucide-react'
import { useAuth } from '../../context/AuthProvider'
import { useToast } from '../../context/ToastProvider'
import { api } from '../../lib/api'
import { legalMarkdownToHtml } from '../../lib/legalMarkdown'
import { DOCUMENTS_CHANGED_MESSAGE, MINOR_GUARDIAN_MESSAGE, guardianComplete, isMinorBirthDate, todayIso } from '../../lib/legalAcceptance'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { PageLoading } from '../../components/ui/PageLoading'

// Primeiro acesso no portal do aluno (H8a-2; SEG-08, OPS-12, SEG-09, decisão P4).
// Fica entre a troca obrigatória de senha e o StudentCourseGate. Pede, no lugar da
// página, só o que falta (GET /api/student/privacy/status):
// - a data de nascimento, a todos que ainda não a têm;
// - para menor de 18 anos sem responsável completo, o nome e um telefone ou e-mail dele;
// - depois que a escola publica os Termos de Uso ou a Política de Privacidade, o aceite
//   da versão publicada (o texto aparece aqui mesmo e num link para nova aba).
// "Continuar" grava (POST /api/student/privacy/accept) e libera; "Sair" encerra a sessão.
// Política 'ciência': o login não é bloqueado e o servidor não recusa as outras rotas.
// A prova (StudentExamShell) nunca passa por aqui, e a faixa "Prova disponível" continua
// à vista. Falha ao consultar não prende o aluno: o portal abre (a próxima visita pergunta
// de novo). Com TEST_MODE (demonstração) o servidor responde required: false.
//
// O layout remonta a página a cada navegação (key={pathname}): o resultado fica guardado
// por conta (STATUS_TTL_MS) para o portão não consultar o servidor a cada clique.
const STATUS_TTL_MS = 10 * 60 * 1000
const statusCache = { email: '', at: 0, status: null }

export function resetPrivacyGateCache() {
  statusCache.email = ''
  statusCache.at = 0
  statusCache.status = null
}

function cachedStatus(email) {
  if (!email || statusCache.email !== email) return null
  if (Date.now() - statusCache.at > STATUS_TTL_MS) return null
  return statusCache.status
}

function remember(email, status) {
  statusCache.email = email
  statusCache.at = Date.now()
  statusCache.status = status
}

function legalQuery(courseId) {
  return courseId ? `?courseId=${encodeURIComponent(courseId)}` : ''
}

function versionLine(doc) {
  if (!doc) return ''
  const time = Date.parse(String(doc.publishedAt || ''))
  const date = Number.isFinite(time) ? new Date(time).toLocaleDateString('pt-BR') : ''
  return date ? `Versão ${doc.version}, publicada em ${date}` : `Versão ${doc.version}`
}

export function StudentPrivacyGate({ children }) {
  const { auth, logout } = useAuth()
  const toast = useToast()
  const nav = useNavigate()
  const email = auth.email || auth.student?.email || ''
  const courseId = auth.activeClass?.courseId || ''
  const [status, setStatus] = useState(() => cachedStatus(email))
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!email || cachedStatus(email)) return undefined
    let active = true
    setFailed(false)
    api.get(`/api/student/privacy/status${legalQuery(courseId)}`)
      .then((data) => {
        if (!active) return
        remember(email, data)
        setStatus(data)
      })
      .catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [email, courseId])

  if (!email || failed) return children
  if (!status) return <PageLoading />
  if (!status.required) return children
  return (
    <PrivacyForm
      status={status}
      courseId={courseId}
      onStatus={(next) => { remember(email, next); setStatus(next) }}
      onDone={(next) => {
        remember(email, next)
        setStatus(next)
        if (toast) toast.success('Pronto. Bom estudo!')
      }}
      onLogout={() => { resetPrivacyGateCache(); logout(); nav('/login') }}
    />
  )
}

function PendingDocument({ doc, courseId, path }) {
  const html = useMemo(() => legalMarkdownToHtml(doc?.markdown || ''), [doc?.markdown])
  if (!doc) return null
  return (
    <details className="rounded-lg border border-border bg-surface-2/40">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-text">
        {doc.title} <span className="font-normal text-muted">· {versionLine(doc)}</span>
      </summary>
      <div className="max-h-80 overflow-y-auto border-t border-border px-3 py-3">
        <div className="prose-iclass break-words text-sm [&_a]:text-text" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
      <p className="border-t border-border px-3 py-2 text-xs">
        <a href={`${path}${legalQuery(courseId)}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-text underline">
          Abrir em outra aba <ExternalLink aria-hidden="true" size={12} />
        </a>
      </p>
    </details>
  )
}

function acceptLabel(termsPending, privacyPending) {
  if (termsPending && privacyPending) return 'Li e aceito os Termos de Uso e li a Política de Privacidade.'
  if (termsPending) return 'Li e aceito os Termos de Uso.'
  return 'Li a Política de Privacidade.'
}

function PrivacyForm({ status, courseId, onStatus, onDone, onLogout }) {
  const [birthDate, setBirthDate] = useState('')
  const [guardian, setGuardian] = useState({ name: '', phone: '', email: '', parentesco: '' })
  const [accepted, setAccepted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [fieldError, setFieldError] = useState({})
  const docs = status.documents || {}
  const needsDocs = status.termsPending || status.privacyPending
  const minorNow = status.birthDateMissing ? isMinorBirthDate(birthDate) : status.isMinor
  const askGuardian = status.guardianMissing || (status.birthDateMissing && minorNow && !status.guardianInformed)
  const setG = (patch) => setGuardian((current) => ({ ...current, ...patch }))

  async function submit(event) {
    event.preventDefault()
    setError('')
    setFieldError({})
    if (status.birthDateMissing && !birthDate) { setFieldError({ birthDate: 'Informe a data de nascimento.' }); return }
    if (askGuardian && !guardianComplete(guardian)) { setFieldError({ guardian: MINOR_GUARDIAN_MESSAGE }); return }
    if (needsDocs && !accepted) { setError('Marque a caixa de leitura e aceite para continuar.'); return }
    const body = {}
    if (courseId) body.courseId = courseId
    if (status.birthDateMissing) body.birthDate = birthDate
    if (askGuardian) body.guardian = guardian
    if (status.termsPending) body.termsDocumentId = docs.terms?.documentId
    if (status.privacyPending) body.privacyDocumentId = docs.privacy?.documentId
    setBusy(true)
    try {
      const next = await api.post('/api/student/privacy/accept', body)
      onDone(next)
    } catch (err) {
      if (err?.status === 409 && err?.data?.status) {
        // A escola publicou outra versão com a tela aberta: mostra a nova, sem o aceite.
        setAccepted(false)
        onStatus(err.data.status)
        setError(err.data.error || DOCUMENTS_CHANGED_MESSAGE)
      } else if (err?.status === 400 && err?.data?.field) {
        const field = String(err.data.field)
        setFieldError({ [field.startsWith('guardian') ? 'guardian' : field === 'birthDate' ? 'birthDate' : 'other']: err.message })
        if (!field.startsWith('guardian') && field !== 'birthDate') setError(err.message)
      } else {
        setError(err?.message || 'Não foi possível gravar agora. Tente de novo em instantes.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mx-auto w-full max-w-xl" aria-labelledby="primeiro-acesso-titulo">
      <form onSubmit={submit} className="premium-card rounded-xl p-5 sm:p-6 space-y-5" noValidate>
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary"><ShieldCheck size={20} aria-hidden="true" /></span>
          <div>
            <h1 id="primeiro-acesso-titulo" className="text-lg font-semibold">Antes de continuar</h1>
            <p className="mt-1 text-sm text-muted">
              {needsDocs
                ? 'A escola publicou os documentos que valem para o uso do IClass. Leia e confirme para continuar.'
                : 'A escola precisa de alguns dados do seu cadastro. Leva menos de um minuto.'}
            </p>
          </div>
        </div>

        {status.birthDateMissing && (
          <Input id="pg-nascimento" label="Data de nascimento" type="date" max={todayIso()} min="1900-01-01" value={birthDate}
            onChange={(e) => setBirthDate(e.target.value)} required error={fieldError.birthDate}
            helper="A escola usa a data para saber se precisa do contato de um responsável." />
        )}

        {askGuardian && (
          <fieldset className="space-y-3 rounded-lg border border-border p-3">
            <legend className="px-1 text-sm font-medium text-text">Responsável</legend>
            <p className="text-xs text-subtle">{MINOR_GUARDIAN_MESSAGE}</p>
            <Input id="pg-resp-nome" label="Nome do responsável" value={guardian.name} onChange={(e) => setG({ name: e.target.value })} autoComplete="off" />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input id="pg-resp-tel" label="Telefone do responsável" value={guardian.phone} onChange={(e) => setG({ phone: e.target.value })} placeholder="(11) 90000-0000" inputMode="tel" />
              <Input id="pg-resp-email" label="E-mail do responsável" type="email" value={guardian.email} onChange={(e) => setG({ email: e.target.value })} />
            </div>
            <Input id="pg-resp-par" label="Parentesco (opcional)" value={guardian.parentesco} onChange={(e) => setG({ parentesco: e.target.value })} placeholder="Mãe, pai, tutor..." />
            {fieldError.guardian && <p role="alert" className="text-xs text-danger">{fieldError.guardian}</p>}
          </fieldset>
        )}

        {needsDocs && (
          <div className="space-y-3">
            {status.termsPending && <PendingDocument doc={docs.terms} courseId={courseId} path="/termos" />}
            {status.privacyPending && <PendingDocument doc={docs.privacy} courseId={courseId} path="/privacidade" />}
            <label className="flex items-start gap-2 text-sm text-text">
              <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-0.5" />
              <span>{acceptLabel(status.termsPending, status.privacyPending)}</span>
            </label>
          </div>
        )}

        {error && <p role="alert" className="rounded-lg border border-danger bg-danger-soft px-3 py-2 text-sm text-text">{error}</p>}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" icon={LogOut} onClick={onLogout} disabled={busy}>Sair</Button>
          <Button type="submit" loading={busy}>Continuar</Button>
        </div>
      </form>
    </section>
  )
}
