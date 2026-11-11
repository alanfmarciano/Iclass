import { useEffect, useState } from 'react'
import { AlertTriangle, ShieldCheck, Upload } from 'lucide-react'
import { Modal } from '../../../components/ui/Modal'
import { Button } from '../../../components/ui/Button'
import { TypedConfirm, typedConfirmMatches } from '../../../components/ui/TypedConfirm'

// Prévia da restauração (H4a, CONF-08, CONF-11): o que o backup traz ao lado do que há
// hoje, antes de mudar qualquer coisa. Substitui o window.confirm e o diálogo do 409 de
// backup de versão anterior: o aviso de versão anterior, as provas em andamento, os
// alunos anonimizados que voltam com dados pessoais e o que ficará vazio aparecem aqui,
// e o botão Restaurar só libera com RESTAURAR digitado.

const FOLDER_LABEL = {
  content: 'Apostilas e avaliações (content)',
  'data/uploads': 'Biblioteca e arquivos enviados',
  'data/alunos': 'Documentos dos alunos',
  'cursos_arquivados': 'Cursos arquivados (só acrescenta os que faltam)',
}

const FORMAT_LABEL = {
  'zip-2': 'ZIP (formato 2)',
  'zip-1': 'ZIP antigo',
  json: 'JSON',
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1).replace('.', ',')} GB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1).replace('.', ',')} MB`
  if (value >= 1024) return `${Math.round(value / 1024)} KB`
  return `${value} bytes`
}

function count(value) {
  return value === null || value === undefined ? '—' : Number(value).toLocaleString('pt-BR')
}

export function restorePreviewDescription(preview) {
  if (!preview) return undefined
  const when = preview.geradoEm && Number.isFinite(Date.parse(preview.geradoEm)) ? new Date(preview.geradoEm).toLocaleString('pt-BR') : 'data desconhecida'
  const kind = preview.variante === 'completo' ? 'completo' : 'só os dados'
  return `Gerado em ${when}${preview.computador ? ` no computador ${preview.computador}` : ''} · ${FORMAT_LABEL[preview.formato] || preview.formato} · ${kind}`
}

// - preview: a resposta do POST /api/admin/backup/restore/preview;
// - onConfirm({ replaceAccounts }): restaurar (a tela manda o token com RESTAURAR);
// - networkNote: a linha de que a regra de rede fica a de hoje.
export function RestorePreview({ preview, busy = false, onCancel, onConfirm, networkNote }) {
  const [confirmTxt, setConfirmTxt] = useState('')
  const [replaceAccounts, setReplaceAccounts] = useState(false)
  useEffect(() => { setConfirmTxt(''); setReplaceAccounts(false) }, [preview?.token])
  const open = !!preview
  const ready = typedConfirmMatches(confirmTxt, 'RESTAURAR') && !busy
  const confirm = () => { if (ready) onConfirm({ replaceAccounts }) }
  const rows = (preview?.contagens || []).filter((row) => (Number(row.backup) || 0) > 0 || (Number(row.atual) || 0) > 0)
  const empty = preview?.ficaraoVazias || []
  const running = preview?.provasEmAndamento || []
  const folders = preview?.arquivos?.inclui || []
  const accountsOut = Number(preview?.contas?.foraDaqui) || 0
  return (
    <Modal
      open={open}
      onClose={() => !busy && onCancel()}
      size="lg"
      title="Conferir antes de restaurar"
      description={restorePreviewDescription(preview)}
      footer={<>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancelar</Button>
        <Button variant="destructive" icon={Upload} loading={busy} disabled={!typedConfirmMatches(confirmTxt, 'RESTAURAR')} onClick={confirm}>Restaurar</Button>
      </>}
    >
      {preview && <div className="space-y-4 text-sm text-text min-w-0">
        <p className={`flex items-start gap-2 text-xs ${preview.integridade?.verificada ? 'text-success' : 'text-muted'}`}>
          <ShieldCheck size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{preview.integridade?.verificada ? preview.integridade.texto : `Integridade: ${preview.integridade?.texto || 'sem soma de verificação (formato antigo)'}`}</span>
        </p>

        {preview.legado?.aviso && (
          <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-soft p-3" role="note" aria-label="Backup de uma versão anterior">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
            <p className="text-sm">{preview.legado.aviso}</p>
          </div>
        )}

        {running.length > 0 && (
          <div className="rounded-lg border border-danger/40 bg-danger-soft p-3" role="note" aria-label="Provas em andamento">
            <p className="font-medium">{running.length === 1 ? 'Há 1 prova em andamento agora.' : `Há ${running.length} provas em andamento agora.`} Restaurar troca as tentativas e entregas pelas do backup.</p>
            <ul className="mt-1 list-disc pl-5 text-xs text-muted">
              {running.map((item) => <li key={item.id}>{item.examKey} · {item.studentClass}</li>)}
            </ul>
          </div>
        )}

        {(preview.avisos || []).length > 0 && (
          <ul className="space-y-1" aria-label="Avisos do backup">
            {preview.avisos.map((warning) => (
              <li key={warning} className="flex items-start gap-2 text-sm"><AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />{warning}</li>
            ))}
          </ul>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-xs" aria-label="No backup e hoje">
            <thead>
              <tr className="text-left text-muted">
                <th scope="col" className="py-1 pr-2 font-medium">O que</th>
                <th scope="col" className="py-1 px-2 text-right font-medium">No backup</th>
                <th scope="col" className="py-1 pl-2 text-right font-medium">Hoje</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={row.colecao}>
                  <th scope="row" className="py-1 pr-2 text-left font-normal break-words">{row.rotulo}</th>
                  <td className="py-1 px-2 text-right tabular-nums">{count(row.backup)}</td>
                  <td className="py-1 pl-2 text-right tabular-nums">{count(row.atual)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {empty.length > 0 && (
          <div>
            <p className="font-medium">Ficarão vazios</p>
            <p className="text-xs text-muted">O backup não traz estes dados; os de hoje saem.</p>
            <ul className="mt-1 list-disc pl-5 text-xs" aria-label="Ficarão vazios">
              {empty.map((item) => <li key={item.colecao}>{item.rotulo} ({count(item.atual)} hoje)</li>)}
            </ul>
          </div>
        )}

        <div>
          <p className="font-medium">Arquivos</p>
          {folders.length ? (
            <p className="text-xs text-muted">{folders.map((prefix) => FOLDER_LABEL[prefix] || prefix).join('; ')}. {count(preview.arquivos?.quantidade)} arquivo(s), {formatBytes(preview.arquivos?.bytes)}. As pastas de hoje são trocadas pelas do backup.</p>
          ) : (
            <p className="text-xs text-muted">{preview.formato === 'json' ? `Este backup traz só os dados e ${count(preview.arquivos?.quantidade)} apostila(s) em Markdown; as pastas de hoje continuam.` : 'Este backup não traz pastas; as de hoje continuam.'}</p>
          )}
        </div>

        <p className="text-xs text-muted">Um backup de segurança dos dados atuais é criado antes. Todos precisarão entrar de novo. {networkNote}</p>

        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={replaceAccounts} onChange={(e) => setReplaceAccounts(e.target.checked)} disabled={busy} />
          <span>Substituir também as contas de acesso pelas do backup ({count(preview.contas?.noBackup)} no backup{accountsOut ? `, ${accountsOut === 1 ? '1 não existe aqui' : `${accountsOut} não existem aqui`}` : ''})</span>
        </label>

        <TypedConfirm id="bk-preview-confirm" word="RESTAURAR" value={confirmTxt} onChange={setConfirmTxt} disabled={busy} onConfirm={confirm} autoFocus />
      </div>}
    </Modal>
  )
}
