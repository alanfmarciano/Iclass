import { useEffect, useState } from 'react'
import { AlertTriangle, BookOpen, Copy, Download, Lock, Save } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Badge } from '../../../components/ui/Badge'
import { Modal } from '../../../components/ui/Modal'
import { api } from '../../../lib/api'
import { useToast } from '../../../context/ToastProvider'
import { CA_DOWNLOAD_PATH, CERTIFICATE_GUIDE_PATH, formatCertificateDate } from '../../../lib/adminAccess'

// Seção "Conexão segura (https)" do cartão Rede (H6c, SEG-03 e OPS-08), só para o
// administrador. Mostra se o https funciona neste IClass (ou o motivo), o endereço
// seguro, a impressão digital do certificado do IClass (CA) para conferir nos aparelhos,
// as validades, o download do certificado e o guia /certificado; e a opção de os alunos
// entrarem pela conexão segura (settings.network.studentsHttps, padrão desligado).
//
// https: o bloco `https` de GET /api/admin/network-info
//   { available, error, studentsHttps, studentsHttpsSetting, url, ca, server }.
// settings: GET /api/admin/network-settings ({ studentsHttps, httpsAvailable, ... }).
export function ConexaoSeguraSection({ https, settings, onSaved, copy }) {
  const toast = useToast()
  const stored = settings?.studentsHttps === true
  const [studentsChoice, setStudentsChoice] = useState(stored)
  const [busy, setBusy] = useState(false)
  const [confirmOn, setConfirmOn] = useState(false)
  useEffect(() => { setStudentsChoice(stored) }, [stored])

  if (!https) return null
  const available = https.available === true
  const ca = https.ca || null
  const server = https.server || null
  const changed = studentsChoice !== stored

  async function save() {
    setBusy(true)
    try {
      const r = await api.post('/api/admin/network-settings', { studentsHttps: studentsChoice })
      setConfirmOn(false)
      toast.success(r?.unchanged ? 'Nada mudou.' : (studentsChoice ? 'Os alunos agora entram pela conexão segura (https).' : 'Os alunos voltam a entrar por http.'))
      onSaved?.()
    } catch (e) {
      setConfirmOn(false)
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }
  function requestSave() {
    if (studentsChoice && !stored) { setConfirmOn(true); return }
    save()
  }

  return (
    <div className="border-t border-border pt-4 space-y-3" data-testid="secure-connection-settings">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-text inline-flex items-center gap-2"><Lock size={16} aria-hidden="true" /> Conexão segura (https)</p>
        {available ? <Badge tone="success">funcionando</Badge> : <Badge tone="warning">indisponível</Badge>}
      </div>
      {!available && (
        <p role="status" data-testid="secure-connection-error" className="text-sm text-warning flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{https.error || 'Conexão segura indisponível.'} O IClass continua funcionando por http. Confira a pasta de dados e ligue o IClass de novo.</span>
        </p>
      )}
      {available && (
        <div className="space-y-3 text-sm">
          <p className="text-xs text-muted">O IClass atende http e https na mesma porta. Para o https abrir sem o aviso &quot;Sua conexão não é particular&quot;, cada aparelho instala uma vez o certificado do IClass (passo a passo no guia).</p>
          {https.url && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase text-muted">Endereço seguro</span>
              <code className="font-mono text-text break-all" data-testid="secure-url">{https.url}</code>
              {copy && <Button size="sm" variant="ghost" icon={Copy} onClick={() => copy(https.url, { success: 'Endereço copiado', label: 'Endereço seguro' })}>Copiar</Button>}
            </div>
          )}
          {ca && (
            <div className="rounded-lg border border-border bg-surface-2 p-3 space-y-1">
              <p className="text-xs font-semibold text-text">Impressão digital do certificado (SHA-256)</p>
              <p className="font-mono text-xs break-all text-text" data-testid="ca-fingerprint">{ca.fingerprintSha256}</p>
              <p className="text-xs text-muted">No aparelho, a página /certificado mostra a mesma sequência: se for diferente, não instale.</p>
              <p className="text-xs text-muted">
                Certificado do IClass válido até {formatCertificateDate(ca.validTo)}
                {server?.validTo ? `; o deste computador, até ${formatCertificateDate(server.validTo)} (renovado sozinho, sem instalar de novo).` : '.'}
              </p>
            </div>
          )}
          {ca?.recreatedAt && (
            <p role="status" data-testid="ca-recreated" className="text-sm text-warning flex items-start gap-2">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>O certificado do IClass foi criado de novo em {formatCertificateDate(ca.recreatedAt)} (o anterior estava faltando ou danificado). Os aparelhos que já tinham instalado o antigo precisam instalar este.</span>
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <a href={CA_DOWNLOAD_PATH} download="iclass-ca.crt" className="inline-flex h-8 items-center gap-2 rounded-lg border border-border px-3 text-sm font-semibold text-text hover:bg-surface-2">
              <Download size={15} aria-hidden="true" /> Baixar certificado
            </a>
            <a href={CERTIFICATE_GUIDE_PATH} target="_blank" rel="noopener" className="inline-flex h-8 items-center gap-2 rounded-lg px-3 text-sm font-semibold text-muted hover:bg-surface-2 hover:text-text">
              <BookOpen size={15} aria-hidden="true" /> Guia de instalação
            </a>
          </div>
        </div>
      )}

      <fieldset className="space-y-2" disabled={busy || (!available && !stored)}>
        <legend className="sr-only">Alunos pela conexão segura</legend>
        <label htmlFor="students-https" className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm ${studentsChoice ? 'border-primary bg-primary-soft' : 'border-border'} ${!available && !stored ? 'opacity-60' : 'cursor-pointer'}`}>
          <input id="students-https" type="checkbox" checked={studentsChoice} onChange={(e) => setStudentsChoice(e.target.checked)} className="mt-1" />
          <span>
            <span className="font-medium text-text">Alunos entram pela conexão segura</span>
            {stored && <Badge tone="neutral" className="ml-2">ligado</Badge>}
            <span className="block text-xs text-muted mt-0.5">Desligado (padrão): os alunos entram por http, como sempre. Ligado: o endereço da sala e o QR code passam a usar https, e cada aparelho dos alunos precisa ter o certificado instalado antes. Não troque com prova em andamento.</span>
            {stored && !available && <span className="block text-xs text-warning mt-0.5">Enquanto a conexão segura não funcionar, os alunos continuam entrando por http.</span>}
          </span>
        </label>
      </fieldset>
      <div className="flex justify-end">
        <Button size="sm" icon={Save} loading={busy} disabled={!changed} onClick={requestSave}>Salvar conexão dos alunos</Button>
      </div>

      <Modal open={confirmOn} onClose={() => !busy && setConfirmOn(false)} title="Alunos pela conexão segura?"
        description="O endereço da sala passa a começar com https."
        footer={<><Button variant="ghost" disabled={busy} onClick={() => setConfirmOn(false)}>Cancelar</Button><Button loading={busy} onClick={save}>Ligar para os alunos</Button></>}>
        <div className="space-y-2 text-sm text-text">
          <p>Antes de ligar, instale o certificado do IClass em cada aparelho dos alunos (guia em /certificado). Num aparelho sem ele, o navegador mostra &quot;Sua conexão não é particular&quot; e o aluno não entra.</p>
          <p>Quem já está com o IClass aberto continua até recarregar a página; depois, vai para o endereço seguro e entra de novo.</p>
        </div>
      </Modal>
    </div>
  )
}
