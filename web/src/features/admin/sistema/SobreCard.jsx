// Cartão "Sobre o IClass" da tela Sistema (fase 3, A1 / P6-S2: OPS-02, ENG-10, OPS-21;
// D22 do P6): a versão instalada, o build, a versão dos dados, a última atualização, a
// identidade desta instalação e as Novidades (o CHANGELOG.md que vem no build). Junta num
// lugar só o que o suporte pergunta primeiro; antes a versão só aparecia no meio do
// cartão Saúde e a barra lateral dizia "v3" fixo. As pastas do computador só aparecem
// para o administrador (o servidor nem as manda para as outras contas).
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Info, Sparkles, CircleHelp } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../../components/ui/Card'
import { Button } from '../../../components/ui/Button'
import { Modal } from '../../../components/ui/Modal'
import { PageLoading } from '../../../components/ui/PageLoading'
import { useApi } from '../../../hooks/useApi'
import { APP_VERSION } from '../../../lib/appVersion'
import { loadChangelog } from '../../../lib/changelog'
import { HelpArticle } from '../../help/HelpArticle'
import { stripComments } from '../../help/helpDocs'

const MODES = { pacote: 'Pacote de instalação', desenvolvimento: 'Pasta de desenvolvimento (git)' }

function toMs(value) {
  if (value === null || value === undefined || value === '') return null
  const ms = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

export function formatDate(value) {
  const ms = toMs(value)
  if (!ms) return ''
  try { return new Date(ms).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }) } catch { return '' }
}

function formatDateTime(value) {
  const ms = toMs(value)
  if (!ms) return ''
  try { return new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) } catch { return '' }
}

// "Atualizado em 18/11/2026 (de 3.0.0; backup antes da atualização: pre-atualizacao_...zip)".
export function updateText(update) {
  if (!update) return 'Nenhuma atualização registrada desde que a versão dos dados começou a ser guardada.'
  const when = formatDateTime(update.em)
  if (update.instalacaoNova) return `Instalado em ${when || 'data desconhecida'} (versão ${update.para || 'desconhecida'}).`
  const parts = []
  if (update.de) parts.push(`de ${update.de}`)
  else parts.push('de uma versão anterior')
  if (update.backup) parts.push(`backup antes da atualização: ${update.backup}`)
  else if (update.semBackup) parts.push('feita sem backup, a pedido')
  return `${when ? `Em ${when}` : 'Data desconhecida'} para a ${update.para || 'versão atual'} (${parts.join('; ')}).`
}

// "6 atualizações aplicadas · última: Identifica esta instalação (18/11/2026)".
export function schemaText(esquema) {
  if (!esquema) return ''
  const total = Number(esquema.aplicadas) || 0
  const parts = [`${total} ${total === 1 ? 'atualização aplicada' : 'atualizações aplicadas'}`]
  if (esquema.ultima) {
    const date = formatDate(esquema.ultima.em)
    parts.push(`última: ${esquema.ultima.nome || esquema.ultima.id}${date ? ` (${date})` : ''}`)
  }
  if (Number(esquema.pendentes) > 0) parts.push(`${esquema.pendentes} pendente(s): reinicie o IClass`)
  if (Number(esquema.desconhecidas) > 0) parts.push('dados de uma versão mais nova do IClass')
  return parts.join(' · ')
}

// Código curto da instalação (o começo do UUID), para ditar ao suporte.
export function shortInstallId(id) {
  const text = String(id || '')
  return text ? text.split('-')[0].toUpperCase() : ''
}

function Row({ label, children }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-baseline gap-0.5 sm:gap-3 py-1.5 border-b border-border last:border-b-0">
      <dt className="text-sm text-muted sm:w-48 shrink-0">{label}</dt>
      <dd className="text-sm text-text break-all min-w-0">{children}</dd>
    </div>
  )
}

export function NovidadesModal({ open, onClose }) {
  const [state, setState] = useState({ text: null, error: '' })
  useEffect(() => {
    if (!open || state.text !== null) return undefined
    let active = true
    loadChangelog()
      .then((text) => { if (active) setState({ text: stripComments(text), error: '' }) })
      .catch((error) => { if (active) setState({ text: null, error: error?.message || 'Não foi possível abrir as Novidades.' }) })
    return () => { active = false }
  }, [open, state.text])
  return (
    <Modal open={open} onClose={onClose} title="Novidades do IClass" size="lg">
      {state.text === null && !state.error && <PageLoading />}
      {state.error && <p role="alert" className="text-sm text-danger">{state.error}</p>}
      {state.text !== null && <HelpArticle markdown={state.text.replace(/^#\s+.*\n?/, '')} shift={1} />}
    </Modal>
  )
}

export function SobreCard() {
  const { data, error, loading } = useApi('/api/admin/system/about')
  const [newsOpen, setNewsOpen] = useState(false)
  const version = data?.versao || APP_VERSION
  const install = data?.instalacao || {}
  const build = data?.build || {}
  // O navegador ainda com o bundle de outra versão (recarrega sozinho pelo X-IClass-Build).
  const bundleDiffers = !!(data?.versao && APP_VERSION && data.versao !== APP_VERSION)
  return (
    <Card>
      <CardHeader
        title={<span className="inline-flex items-center gap-2"><Info size={16} /> Sobre o IClass</span>}
        subtitle="Versão, dados e identificação desta instalação."
      />
      <CardBody>
        {loading && !data && <p className="text-sm text-muted">Carregando…</p>}
        {error && !data && <p className="text-sm text-danger" role="alert">Não foi possível consultar o servidor agora. {error.message}</p>}
        {data && (
          <dl>
            <Row label="Versão">{version || 'desconhecida'}{bundleDiffers ? ` (esta tela ainda é da ${APP_VERSION}; ela recarrega sozinha)` : ''}</Row>
            <Row label="Última atualização">{updateText(data.ultimaAtualizacao)}</Row>
            <Row label="Dados na versão">{schemaText(data.esquema)}</Row>
            <Row label="Instalação">{install.id ? <><span className="font-semibold">{shortInstallId(install.id)}</span>{install.criadaEm ? ` · desde ${formatDate(install.criadaEm)}` : ''} <span className="text-subtle">({install.id})</span></> : 'Ainda sem identificação (reinicie o IClass).'}</Row>
            <Row label="Licenciado para">{install.licenciadoPara || 'Não informado'}</Row>
            <Row label="Modo">{MODES[data.modo] || data.modo}</Row>
            <Row label="Build">{[build.id, build.geradoEm ? `feito em ${formatDateTime(build.geradoEm)}` : ''].filter(Boolean).join(' · ') || 'sem informação'}</Row>
            <Row label="Node e sistema">{[data.node, data.plataforma].filter(Boolean).join(' · ')}</Row>
            {data.pastas && <Row label="Pasta dos dados">{data.pastas.dados}</Row>}
            {data.pastas && <Row label="Pasta do conteúdo">{data.pastas.conteudo}</Row>}
            {data.pastas && <Row label="Pasta do programa">{data.pastas.programa}</Row>}
          </dl>
        )}
        <div className="flex flex-wrap gap-2 pt-4">
          <Button variant="secondary" icon={Sparkles} onClick={() => setNewsOpen(true)}>Novidades</Button>
          <Link to="/ajuda" className="inline-flex h-[38px] items-center gap-2 rounded-lg border border-border bg-surface-raised px-4 text-sm font-semibold text-text hover:bg-surface-2">
            <CircleHelp aria-hidden="true" size={16} /> Ajuda
          </Link>
        </div>
      </CardBody>
      <NovidadesModal open={newsOpen} onClose={() => setNewsOpen(false)} />
    </Card>
  )
}

export default SobreCard
