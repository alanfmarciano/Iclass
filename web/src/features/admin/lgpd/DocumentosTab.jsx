import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, FileText, RotateCcw, Save, Send } from 'lucide-react'
import { Card, CardBody, CardHeader } from '../../../components/ui/Card'
import { Button } from '../../../components/ui/Button'
import { Badge } from '../../../components/ui/Badge'
import { Input } from '../../../components/ui/Input'
import { Select } from '../../../components/ui/Select'
import { Textarea } from '../../../components/ui/Textarea'
import { Modal } from '../../../components/ui/Modal'
import { PageLoading } from '../../../components/ui/PageLoading'
import { TypedConfirm, typedConfirmMatches } from '../../../components/ui/TypedConfirm'
import { api } from '../../../lib/api'
import { legalMarkdownToHtml } from '../../../lib/legalMarkdown'
import { useToast } from '../../../context/ToastProvider'

// Aba "Documentos" da página Privacidade (LGPD) (H8a-1; SEG-08, OPS-12).
// Para cada documento (Termos de Uso e Política de Privacidade):
// - a situação: publicado (versão e data) ou ainda o modelo do IClass;
// - o rascunho em markdown, com título e resumo da mudança, gravado à parte: o aluno só
//   vê o texto depois de publicado (o rascunho nunca vai para /termos nem /privacidade);
// - a prévia com os dados de uma escola e o aviso de marcador desconhecido;
// - publicar, com a confirmação digitada PUBLICAR: a versão publicada não muda mais. O
//   diálogo avisa quando o texto é o modelo sem mudança ou ainda traz o aviso do modelo
//   para o administrador (que ficaria para os alunos). O aceite pelos alunos no próximo
//   acesso é do H8a-2 (portão): até lá, o diálogo não promete pedir aceite a ninguém;
//   quando o portão existir, ele volta a dizer quantos alunos terão de aceitar;
// - o histórico das versões publicadas, com o texto de cada uma.

const PUBLISH_WORD = 'PUBLICAR'
const KIND_ORDER = ['termos', 'privacidade']
const PUBLIC_PATH = { termos: '/termos', privacidade: '/privacidade' }
// Mesmo teste do servidor (MODEL_NOTICE_RE em backend/utils/legalTemplates.js): o texto
// em edição ainda traz o aviso do modelo para o administrador.
const MODEL_NOTICE_RE = /Modelo de referência; não substitui orientação jurídica|Revise este texto com a direção da escola/i

export function fmtDocDate(iso, withTime = false) {
  const time = Date.parse(String(iso || ''))
  if (!Number.isFinite(time)) return ''
  const options = { day: '2-digit', month: '2-digit', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) }
  return new Date(time).toLocaleString('pt-BR', options)
}

function editorFrom(draft) {
  return { title: draft?.title || '', markdown: draft?.markdown || '', changeSummary: draft?.changeSummary || '' }
}

function sameEditor(a, b) {
  return a.title === b.title && a.markdown === b.markdown && a.changeSummary === b.changeSummary
}

function UnknownPlaceholders({ names }) {
  if (!names?.length) return null
  return (
    <div role="alert" className="rounded-md border border-warning bg-warning-soft px-3 py-2 text-sm text-text">
      Marcador desconhecido: {names.map((name) => `{{${name}}}`).join(', ')}. Ele aparece como está no texto para os alunos. Confira a lista de marcadores.
    </div>
  )
}

export function DocumentosTab() {
  const toast = useToast()
  const [escola, setEscola] = useState('')
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [kind, setKind] = useState('termos')
  // Texto em edição de cada documento: trocar de documento não perde o que foi digitado.
  const [editors, setEditors] = useState({})
  const [previews, setPreviews] = useState({})
  const [busy, setBusy] = useState('')
  const [fieldError, setFieldError] = useState('')
  const [publishOpen, setPublishOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [publishError, setPublishError] = useState('')
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [version, setVersion] = useState(null)

  // A escola da prévia não recarrega a página: a troca pede só a prévia nova.
  const escolaRef = useRef('')
  escolaRef.current = escola

  const load = useCallback(async ({ keepEditors = false } = {}) => {
    setLoadError('')
    const school = escolaRef.current
    try {
      const result = await api.get(`/api/admin/lgpd/documents${school ? `?escola=${encodeURIComponent(school)}` : ''}`)
      setData(result)
      setPreviews((current) => {
        const next = { ...current }
        KIND_ORDER.forEach((item) => { if (!keepEditors || !next[item]) next[item] = result.documents[item].preview })
        return next
      })
      setEditors((current) => {
        const next = { ...current }
        KIND_ORDER.forEach((item) => { if (!keepEditors || !next[item]) next[item] = editorFrom(result.documents[item].draft) })
        return next
      })
      if (!school && result.school?.id) setEscola(result.school.id)
    } catch (error) {
      setLoadError(error.message || 'Não foi possível carregar os documentos.')
    }
  }, [])

  useEffect(() => { load() }, [load])

  const doc = data?.documents?.[kind]
  const editor = editors[kind] || editorFrom(doc?.draft)
  const savedEditor = editorFrom(doc?.draft)
  const dirty = !!doc && !sameEditor(editor, savedEditor)
  const preview = previews[kind] || doc?.preview
  const previewHtml = useMemo(() => legalMarkdownToHtml(preview?.markdown || ''), [preview?.markdown])

  const setField = (key) => (event) => {
    const value = event.target.value
    setEditors((current) => ({ ...current, [kind]: { ...(current[kind] || editor), [key]: value } }))
    if (key === 'markdown') setFieldError('')
  }

  async function refreshPreview(markdown = editor.markdown, school = escola) {
    setBusy('preview')
    try {
      const result = await api.post('/api/admin/lgpd/documents/preview', { kind, markdown, escola: school })
      setPreviews((current) => ({ ...current, [kind]: { markdown: result.markdown, unknownPlaceholders: result.unknownPlaceholders || [] } }))
    } catch (error) {
      toast?.error?.(error.message || 'Não foi possível montar a prévia.')
    } finally {
      setBusy('')
    }
  }

  // Grava o rascunho; devolve o rascunho gravado (ou null se falhou).
  async function saveDraft({ quiet = false } = {}) {
    setBusy('save'); setFieldError('')
    try {
      const result = await api.post('/api/admin/lgpd/documents/draft', { kind, ...editor })
      setData((current) => current && ({ ...current, documents: { ...current.documents, [kind]: { ...current.documents[kind], draft: result.draft } } }))
      setEditors((current) => ({ ...current, [kind]: editorFrom(result.draft) }))
      if (!quiet) toast?.success?.('Rascunho salvo. Os alunos continuam vendo o texto publicado até você publicar.')
      await refreshPreview(result.draft.markdown)
      return result.draft
    } catch (error) {
      if (error?.data?.field === 'markdown') setFieldError(error.message)
      else toast?.error?.(error.message || 'Não foi possível salvar o rascunho.')
      return null
    } finally {
      setBusy('')
    }
  }

  async function restoreModel() {
    setBusy('restore')
    try {
      const result = await api.post('/api/admin/lgpd/documents/restore-model', { kind })
      setRestoreOpen(false)
      setEditors((current) => ({ ...current, [kind]: editorFrom(result.draft) }))
      setData((current) => current && ({ ...current, documents: { ...current.documents, [kind]: { ...current.documents[kind], draft: result.draft } } }))
      toast?.success?.('O rascunho voltou ao texto do modelo.')
      await refreshPreview(result.draft.markdown)
    } catch (error) {
      toast?.error?.(error.message || 'Não foi possível restaurar o modelo.')
    } finally {
      setBusy('')
    }
  }

  async function publish() {
    if (!typedConfirmMatches(confirmText, PUBLISH_WORD)) return
    setPublishError('')
    let draftUpdatedAt = doc.draft.saved ? doc.draft.updatedAt : null
    if (dirty) {
      const saved = await saveDraft({ quiet: true })
      if (!saved) { setPublishError('O rascunho não foi salvo; nada foi publicado.'); return }
      draftUpdatedAt = saved.updatedAt
    }
    setBusy('publish')
    try {
      const result = await api.post('/api/admin/lgpd/documents/publish', { kind, confirm: confirmText, draftUpdatedAt })
      setPublishOpen(false); setConfirmText('')
      toast?.success?.(`${doc.label}: versão ${result.document.version} publicada.`)
      await load()
    } catch (error) {
      setPublishError(error.message || 'Não foi possível publicar.')
    } finally {
      setBusy('')
    }
  }

  async function openVersion(id) {
    try {
      const result = await api.get(`/api/admin/lgpd/documents/version?id=${encodeURIComponent(id)}${escola ? `&escola=${encodeURIComponent(escola)}` : ''}`)
      setVersion(result)
    } catch (error) {
      toast?.error?.(error.message || 'Não foi possível abrir a versão.')
    }
  }

  if (loadError && !data) {
    return (
      <div role="alert" className="rounded-xl border border-border bg-surface p-5 space-y-3">
        <p className="text-sm">{loadError}</p>
        <Button variant="secondary" onClick={() => load()}>Tentar de novo</Button>
      </div>
    )
  }
  if (!data || !doc) return <PageLoading />

  const current = doc.current
  const nextVersion = (current.version || 0) + 1
  const cannotPublish = !current.isModel && doc.draft.sameAsCurrent && !dirty
  const editorHasNotice = MODEL_NOTICE_RE.test(editor.markdown || '')
  const publicLink = `${PUBLIC_PATH[kind]}${escola ? `?escola=${encodeURIComponent(escola)}` : ''}`

  return (
    <div className="space-y-5">
      <div role="tablist" aria-label="Documento" className="flex flex-wrap gap-2">
        {KIND_ORDER.map((item) => {
          const info = data.documents[item]
          return (
            <button key={item} type="button" role="tab" aria-selected={kind === item} onClick={() => { setKind(item); setFieldError('') }}
              className={`rounded-lg border px-3 py-2 text-sm ${kind === item ? 'border-primary bg-surface-2 text-text' : 'border-border text-muted hover:text-text'}`}>
              <span className="font-medium">{info.label}</span>{' '}
              <span className="text-xs">{info.current.isModel ? '(não publicado)' : `(versão ${info.current.version})`}</span>
            </button>
          )
        })}
      </div>

      <Card>
        <CardBody className="pt-5 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {current.isModel
              ? <Badge tone="warning">Não publicado</Badge>
              : <Badge tone="success">Versão {current.version} publicada em {fmtDocDate(current.publishedAt)}</Badge>}
            <a href={publicLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-primary underline">
              Ver a página pública <ExternalLink aria-hidden="true" size={14} />
            </a>
          </div>
          <p className="text-sm text-muted">
            {current.isModel
              ? 'Os alunos veem o modelo padrão do IClass, com o aviso de que ainda não foi revisado. Revise o texto abaixo, ajuste o que for preciso e publique.'
              : `Publicada por ${current.publishedBy || 'administrador'}. Para mudar o texto, edite o rascunho e publique uma nova versão: a versão publicada não muda mais.`}
          </p>
          {current.isModel && data.modelNotice && (
            <p className="rounded-md border border-warning bg-warning-soft px-3 py-2 text-sm text-text" data-testid="model-notice">
              <b>{data.modelNotice}</b> {data.modelReviewHint}
            </p>
          )}
        </CardBody>
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Rascunho"
            subtitle={doc.draft.saved
              ? `Salvo em ${fmtDocDate(doc.draft.updatedAt, true)}${doc.draft.updatedBy ? ` por ${doc.draft.updatedBy}` : ''}.`
              : (current.isModel ? 'Ainda não salvo: o texto abaixo é o modelo do IClass.' : 'Ainda não salvo: o texto abaixo é o da versão publicada.')}
          />
          <CardBody className="space-y-3">
            {dirty && <p className="text-sm font-medium text-text" role="status">Alterações não salvas.</p>}
            <Input label="Título" value={editor.title} onChange={setField('title')} maxLength={200} />
            <Textarea label="Texto (markdown)" value={editor.markdown} onChange={setField('markdown')} error={fieldError} rows={22} className="font-mono text-xs leading-relaxed" spellCheck />
            <p className="text-xs text-muted">{editor.markdown.length.toLocaleString('pt-BR')} de {Number(data.markdownMax || 100000).toLocaleString('pt-BR')} caracteres.</p>
            <Input label="Resumo da mudança (vai para o histórico)" value={editor.changeSummary} onChange={setField('changeSummary')} maxLength={500} placeholder="Ex.: inclui o contato do encarregado." />
            <details className="rounded-md border border-border px-3 py-2 text-sm">
              <summary className="cursor-pointer font-medium">Marcadores que o IClass preenche</summary>
              <p className="mt-2 text-muted">Escreva o marcador entre chaves duplas. Ele é trocado pelos dados da escola na hora de mostrar o texto; o que estiver vazio aparece como [não informado].</p>
              <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                {(data.placeholders || []).map((item) => (
                  <li key={item.key}><code>{`{{${item.key}}}`}</code> <span className="text-muted">{item.label}</span></li>
                ))}
              </ul>
            </details>
            <div className="flex flex-wrap gap-2">
              <Button icon={Save} onClick={() => saveDraft()} loading={busy === 'save'} disabled={!dirty || !!busy}>Salvar rascunho</Button>
              <Button variant="secondary" icon={Send} onClick={() => { setPublishOpen(true); setConfirmText(''); setPublishError('') }} disabled={cannotPublish || !!busy}>Publicar versão {nextVersion}</Button>
              <Button variant="ghost" icon={RotateCcw} onClick={() => setRestoreOpen(true)} disabled={!!busy}>Restaurar modelo</Button>
            </div>
            {cannotPublish && <p className="text-xs text-muted">O rascunho é igual à versão publicada. Altere o texto para publicar uma nova versão.</p>}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Prévia" subtitle="Como os alunos vão ler, com os dados da escola escolhida." />
          <CardBody className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              {(data.schools || []).length > 1 && (
                <div className="min-w-[12rem] flex-1">
                  <Select label="Dados da escola" value={escola} onChange={(event) => { setEscola(event.target.value); refreshPreview(editor.markdown, event.target.value) }}>
                    {data.schools.map((school) => <option key={school.id} value={school.id}>{school.name || school.id}</option>)}
                  </Select>
                </div>
              )}
              <Button variant="secondary" onClick={() => refreshPreview()} loading={busy === 'preview'} disabled={!!busy && busy !== 'preview'}>Atualizar prévia</Button>
            </div>
            <UnknownPlaceholders names={preview?.unknownPlaceholders} />
            <div className="max-h-[36rem] overflow-y-auto rounded-md border border-border p-4">
              <div className="prose-iclass break-words text-sm" data-testid="legal-preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
            </div>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Versões publicadas" subtitle="Cada versão fica guardada como foi publicada: é o registro do texto que os alunos aceitaram." />
        <CardBody>
          {doc.history.length === 0
            ? <p className="text-sm text-muted">Nenhuma versão publicada ainda.</p>
            : (
              <ul className="divide-y divide-border">
                {doc.history.map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <div>
                      <span className="font-medium">Versão {item.version}</span>{' '}
                      <span className="text-muted">publicada em {fmtDocDate(item.publishedAt, true)}{item.publishedBy ? ` por ${item.publishedBy}` : ''}</span>
                      {item.changeSummary && <p className="text-muted">{item.changeSummary}</p>}
                    </div>
                    <Button size="sm" variant="ghost" icon={FileText} onClick={() => openVersion(item.id)}>Ver texto</Button>
                  </li>
                ))}
              </ul>
            )}
        </CardBody>
      </Card>

      <Modal
        open={publishOpen}
        onClose={() => { if (busy !== 'publish' && busy !== 'save') setPublishOpen(false) }}
        title={`Publicar ${doc.label}, versão ${nextVersion}`}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setPublishOpen(false)} disabled={busy === 'publish' || busy === 'save'}>Cancelar</Button>
            <Button onClick={publish} loading={busy === 'publish' || busy === 'save'} disabled={!typedConfirmMatches(confirmText, PUBLISH_WORD)}>Publicar</Button>
          </>
        )}
      >
        <div className="space-y-3 text-sm">
          <p>Depois de publicada, esta versão passa a ser o texto de {doc.label} para todos e não pode mais ser alterada: uma mudança futura vira uma versão nova.</p>
          <p>
            {data.activeStudents === 1
              ? `1 aluno com cadastro ativo passa a ver esta versão em ${doc.label}.`
              : `${data.activeStudents} alunos com cadastro ativo passam a ver esta versão em ${doc.label}.`}
            {' '}A prova em andamento não é interrompida.
          </p>
          {dirty && <p className="font-medium">As alterações ainda não salvas serão salvas antes.</p>}
          {editorHasNotice && (
            <p role="alert" className="rounded-md border border-warning bg-warning-soft px-3 py-2 text-text">
              O texto ainda traz o aviso “{data.modelNotice || 'Modelo de referência'}” para o administrador. Se publicar assim, os alunos vão ler esse aviso numa versão que não muda mais. Tire o aviso do texto antes de publicar.
            </p>
          )}
          {!dirty && doc.draft.sameAsModel && (
            <p className="rounded-md border border-warning bg-warning-soft px-3 py-2 text-text" data-testid="publish-model-warning">
              Você vai publicar o modelo do IClass sem nenhuma mudança. {data.modelReviewHint} Confira na prévia os dados da escola e do encarregado.
            </p>
          )}
          <UnknownPlaceholders names={preview?.unknownPlaceholders} />
          <TypedConfirm word={PUBLISH_WORD} value={confirmText} onChange={setConfirmText} onConfirm={publish} disabled={busy === 'publish' || busy === 'save'} autoFocus />
          {publishError && <p role="alert" className="text-danger">{publishError}</p>}
        </div>
      </Modal>

      <Modal
        open={restoreOpen}
        onClose={() => setRestoreOpen(false)}
        title="Restaurar o texto do modelo?"
        footer={(
          <>
            <Button variant="secondary" onClick={() => setRestoreOpen(false)}>Cancelar</Button>
            <Button onClick={restoreModel} loading={busy === 'restore'}>Restaurar modelo</Button>
          </>
        )}
      >
        <p className="text-sm">O rascunho volta ao texto do modelo do IClass e o que foi editado nele se perde. A versão publicada continua valendo até você publicar outra.</p>
      </Modal>

      <Modal open={!!version} onClose={() => setVersion(null)} size="lg" title={version ? `${doc.label}, versão ${version.document.version}` : ''}
        footer={<Button variant="secondary" onClick={() => setVersion(null)}>Fechar</Button>}>
        {version && (
          <div className="space-y-2">
            <p className="text-sm text-muted">Publicada em {fmtDocDate(version.document.publishedAt, true)}{version.document.publishedBy ? ` por ${version.document.publishedBy}` : ''}.</p>
            <div className="max-h-[60vh] overflow-y-auto rounded-md border border-border p-4">
              <div className="prose-iclass break-words text-sm" dangerouslySetInnerHTML={{ __html: legalMarkdownToHtml(version.preview?.markdown || '') }} />
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
