import { useState } from 'react'
import { Copy, RefreshCw } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Modal } from '../../components/ui/Modal'
import { api } from '../../lib/api'
import { useToast } from '../../context/ToastProvider'

function tokenStorageKey(applicationId) { return `exam-token:${applicationId}` }
function tokenIssuedStorageKey(applicationId) { return `exam-token-issued:${applicationId}` }

export function storedApplicationToken(applicationId) {
  if (!applicationId) return ''
  try { return sessionStorage.getItem(tokenStorageKey(applicationId)) || '' } catch { return '' }
}

function storedApplicationTokenIssuedAt(applicationId) {
  if (!applicationId) return ''
  try { return sessionStorage.getItem(tokenIssuedStorageKey(applicationId)) || '' } catch { return '' }
}

// Guarda nesta aba o token em texto puro e a marca da versão dele (accessTokenIssuedAt
// da aplicação), para perceber depois se ele foi trocado em outra tela.
export function rememberApplicationToken(applicationId, token, issuedAt) {
  if (!applicationId || !token) return
  try {
    sessionStorage.setItem(tokenStorageKey(applicationId), token)
    if (issuedAt) sessionStorage.setItem(tokenIssuedStorageKey(applicationId), issuedAt)
    else sessionStorage.removeItem(tokenIssuedStorageKey(applicationId))
  } catch { /* navegador sem armazenamento: o token aparece só nesta tela */ }
}

// Aviso do token trocado em outra tela: só sugere gerar outro quando o botão existe
// (aplicação encerrada não aceita mais ninguém, então não há token a usar).
export function staleTokenMessage(canRegenerate, closed) {
  const base = 'O token desta tela foi trocado em outro navegador e não vale mais.'
  if (canRegenerate) return `${base} Use o token novo ou gere outro.`
  if (closed) return `${base} A prova já foi encerrada: nenhum aluno entra mais com token.`
  return `${base} Use o token novo.`
}

// Token de acesso da aplicação no Monitor. O servidor guarda só o hash: o token em
// texto puro fica na aba que preparou a prova. Em outra máquina (ou com a aba fechada)
// o professor gera um novo aqui, sem preparar de novo nem encerrar a prova; quem já
// validou o token continua fazendo a prova. tokenIssuedAt é a versão atual do token no
// servidor: se ele foi trocado em outra tela, o token guardado aqui não vale mais e
// deixa de aparecer (o professor não dita um token recusado).
export function ApplicationTokenPanel({ applicationId, requiresToken, closed, legacyToken = '', tokenIssuedAt = '' }) {
  const toast = useToast()
  const [, setRefresh] = useState(0)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const storedToken = applicationId ? storedApplicationToken(applicationId) : ''
  const storedIssuedAt = storedApplicationTokenIssuedAt(applicationId)
  // Só é antigo quando o servidor tem uma troca mais nova que a guardada aqui (logo
  // depois de trocar nesta aba, a lista do Monitor ainda pode trazer a marca anterior).
  const staleToken = !!storedToken && !!tokenIssuedAt && (!storedIssuedAt || storedIssuedAt < tokenIssuedAt)
  const token = applicationId ? (staleToken ? '' : storedToken) : (legacyToken || '')
  const canRegenerate = !!applicationId && !!requiresToken && !closed

  async function copy() {
    if (!token) return toast.info('O token está desativado nesta prova')
    try { await navigator.clipboard.writeText(token); toast.success('Token copiado') }
    catch { toast.error('Não foi possível copiar') }
  }

  async function regenerate() {
    setBusy(true)
    try {
      const response = await api.post(`/api/admin/exam-applications/${encodeURIComponent(applicationId)}/access-token`, {})
      rememberApplicationToken(applicationId, response.accessToken, response.accessTokenIssuedAt)
      setRefresh((value) => value + 1)
      setConfirmOpen(false)
      toast.success('Novo token gerado. Passe-o aos alunos que ainda vão entrar.')
    } catch (error) {
      toast.error(error.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface-2 px-4 py-3 min-w-[190px]">
      <p className="text-[11px] font-semibold uppercase text-muted">Token de acesso</p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {/* Só o token vai em fonte monoespaçada; a situação dele é texto comum. */}
        {token
          ? <span data-testid="application-token" className="font-mono font-bold text-lg tracking-[0.2em] text-warning">{token}</span>
          : <span className="text-sm font-semibold text-muted">{staleToken ? 'Trocado em outra tela' : requiresToken ? 'Definido na preparação' : 'Desativado'}</span>}
        {token && <Button size="sm" variant="ghost" icon={Copy} onClick={copy}>Copiar</Button>}
        {canRegenerate && <Button size="sm" variant={token ? 'ghost' : 'secondary'} icon={RefreshCw} onClick={() => setConfirmOpen(true)}>{token ? 'Trocar' : 'Gerar novo token'}</Button>}
      </div>
      {staleToken && <p className="mt-1 text-[11px] text-warning">{staleTokenMessage(canRegenerate, closed)}</p>}
      {canRegenerate && !token && !staleToken && <p className="mt-1 text-[11px] text-subtle">O token só aparece no navegador que preparou a prova. Perdeu? Gere um novo.</p>}
      <Modal open={confirmOpen} onClose={() => { if (!busy) setConfirmOpen(false) }} title="Gerar novo token"
        description="O token atual deixa de valer para quem ainda vai entrar. Quem já validou o token continua fazendo a prova normalmente."
        footer={<><Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={busy}>Cancelar</Button><Button loading={busy} icon={RefreshCw} onClick={regenerate}>Gerar novo token</Button></>}>
        <p className="text-sm text-muted">A aplicação continua como está: nada é encerrado e nenhuma resposta é perdida.</p>
      </Modal>
    </div>
  )
}
