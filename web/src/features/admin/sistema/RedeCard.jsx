import { useEffect, useState } from 'react'
import { Copy, ExternalLink, MonitorSmartphone, Save, Wifi, WifiOff } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../../components/ui/Card'
import { Button } from '../../../components/ui/Button'
import { Badge } from '../../../components/ui/Badge'
import { Modal } from '../../../components/ui/Modal'
import { QrCode } from '../../../components/ui/QrCode'
import { useCopyText } from '../../../components/ui/ManualCopyModal'
import { useApi } from '../../../hooks/useApi'
import { NO_NETWORK_TEXT, ROOM_ADDRESS_PATH } from '../RoomAddress'
import { api } from '../../../lib/api'
import { useToast } from '../../../context/ToastProvider'
import { ADMIN_ACCESS_MODES, ADMIN_ACCESS_OPTIONS, adminAccessLabel } from '../../../lib/adminAccess'

// Cartão Rede da tela Sistema (H6): endereço para os alunos, com o QR code (H6a, OPS-10),
// os outros adaptadores desta máquina e, para quem gerencia o sistema, onde o painel do
// professor abre (settings.network.adminAccess, SEG-03, H6b). Só o administrador troca a
// regra; o professor vê qual vale. A opção da conexão segura fica desligada enquanto o
// IClass não tiver https (H6c).

// GET /api/admin/network-info: { recommended, addresses: [{ name, address, kind, recommended,
// url }] }. A versão anterior devolvia só [{ name, address }]: sem url, mostra o IP.
export function networkAdapters(net) {
  const raw = Array.isArray(net) ? net : (net && Array.isArray(net.addresses) ? net.addresses : [])
  const list = raw.filter(Boolean).map((item) => (typeof item === 'string' ? { address: item } : item))
  // No formato antigo não havia recomendado: vale o primeiro, como a tela mostrava.
  const recommended = (net && !Array.isArray(net) && net.recommended) || list.find((item) => item.recommended) || (Array.isArray(net) ? list[0] || null : null)
  const isRecommended = (item) => !!recommended && item.address === recommended.address && (item.name || '') === (recommended.name || '')
  const others = list.filter((item) => !isRecommended(item))
  return {
    recommended,
    network: others.filter((item) => !item.kind || item.kind === 'rede'),
    hidden: others.filter((item) => item.kind === 'virtual' || item.kind === 'link-local'),
  }
}

const KIND_LABELS = { virtual: 'virtual', 'link-local': 'sem endereço da rede' }

function AdapterLine({ item }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Wifi size={15} className="text-info shrink-0" aria-hidden="true" />
      <code className="font-mono text-text break-all">{item.url || item.address}</code>
      {item.name && <Badge tone="neutral">{item.name}</Badge>}
      {KIND_LABELS[item.kind] && <span className="text-xs text-muted">({KIND_LABELS[item.kind]})</span>}
    </div>
  )
}

export function RedeCard({ canManage = false, isAdmin = false }) {
  const { data: net } = useApi('/api/admin/network-info')
  const room = useApi(ROOM_ADDRESS_PATH)
  const { copy, manualCopy } = useCopyText()
  const settings = useApi(canManage ? '/api/admin/network-settings' : null, [canManage])
  const current = settings.data?.adminAccess || ''
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmLocal, setConfirmLocal] = useState(false)
  const toast = useToast()
  useEffect(() => { if (current) setChoice(current) }, [current])

  const adapters = networkAdapters(net)
  const studentUrl = room.data?.studentUrl || adapters.recommended?.url || ''
  const qrRows = room.data?.studentUrl ? room.data?.qr?.rows : null
  const httpsReady = settings.data?.httpsAvailable === true
  // Quem muda daqui para "só o computador do IClass" estando em outro aparelho perde o
  // painel neste aparelho logo depois de salvar: pede confirmação antes.
  const elsewhere = settings.data?.thisComputer === false
  const changed = !!choice && choice !== current

  async function save() {
    setBusy(true)
    try {
      const r = await api.post('/api/admin/network-settings', { adminAccess: choice })
      setConfirmLocal(false)
      toast.success(r?.unchanged ? 'Nada mudou.' : `Painel do professor agora abre em: ${adminAccessLabel(choice)}.`)
      settings.refetch(true)
    } catch (e) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }
  function requestSave() {
    if (choice === ADMIN_ACCESS_MODES.LOCAL && elsewhere) { setConfirmLocal(true); return }
    save()
  }

  return (
    <Card>
      {/* "Rede": o nome que as mensagens de recusa e de ajuda citam (Sistema → Rede). */}
      <CardHeader title="Rede" subtitle="Endereços da rede local para os alunos acessarem e onde o painel do professor abre" />
      <CardBody className="space-y-5">
        <div className="space-y-3" data-testid="room-address-card">
          {!net && <p className="text-sm text-muted flex items-center gap-2"><Wifi size={16} aria-hidden="true" /> Endereços aparecem quando o servidor estiver rodando.</p>}
          {net && !adapters.recommended && (
            <p className="text-sm text-warning flex items-start gap-2" role="status"><WifiOff size={16} className="mt-0.5 shrink-0" aria-hidden="true" /> {NO_NETWORK_TEXT}</p>
          )}
          {adapters.recommended && (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              {qrRows && <QrCode rows={qrRows} url={studentUrl} size={140} className="shrink-0 self-center sm:self-auto" />}
              <div className="min-w-0 space-y-1.5">
                <p className="text-xs font-semibold uppercase text-muted">Para os alunos</p>
                <p className="font-mono text-lg font-bold text-text break-all" data-testid="student-url">{studentUrl}</p>
                {adapters.recommended.name && <p className="text-xs text-muted">Adaptador: {adapters.recommended.name}. Digite com o número da porta depois dos dois-pontos.</p>}
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button size="sm" variant="secondary" icon={Copy} onClick={() => copy(studentUrl, { success: 'Endereço copiado', label: 'Endereço da sala' })}>Copiar endereço</Button>
                  <a href="/endereco" target="_blank" rel="noopener" className="inline-flex h-8 items-center gap-2 rounded-lg px-3 text-sm font-semibold text-muted hover:bg-surface-2 hover:text-text">
                    <ExternalLink size={15} aria-hidden="true" /> Projetar em tela cheia
                  </a>
                </div>
              </div>
            </div>
          )}
          {adapters.network.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs text-muted">Outros endereços desta máquina na rede:</p>
              {adapters.network.map((item, i) => <AdapterLine key={`${item.name}-${item.address}-${i}`} item={item} />)}
            </div>
          )}
          {adapters.hidden.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted">Outros adaptadores (não use)</summary>
              <p className="mt-1 text-xs text-muted">Máquinas virtuais, VPN e adaptadores sem endereço da rede: os celulares dos alunos não chegam por eles.</p>
              <div className="mt-2 space-y-1.5">
                {adapters.hidden.map((item, i) => <AdapterLine key={`${item.name}-${item.address}-${i}`} item={item} />)}
              </div>
            </details>
          )}
        </div>

        {canManage && current && (
          <div className="border-t border-border pt-4 space-y-3" data-testid="admin-access-settings">
            <div>
              <p className="text-sm font-semibold text-text inline-flex items-center gap-2"><MonitorSmartphone size={16} /> Painel do professor</p>
              <p className="text-xs text-muted mt-1">Em quais aparelhos o painel do professor abre. Os alunos entram do mesmo jeito em qualquer opção.</p>
            </div>
            {isAdmin ? (
              <fieldset className="space-y-2" disabled={busy}>
                <legend className="sr-only">Onde o painel do professor abre</legend>
                {ADMIN_ACCESS_OPTIONS.map((option) => {
                  const unavailable = option.value === ADMIN_ACCESS_MODES.SECURE && !httpsReady
                  const id = `admin-access-${option.value}`
                  return (
                    <label key={option.value} htmlFor={id} className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm ${choice === option.value ? 'border-primary bg-primary-soft' : 'border-border'} ${unavailable ? 'opacity-60' : 'cursor-pointer'}`}>
                      <input id={id} type="radio" name="admin-access" value={option.value} checked={choice === option.value} disabled={unavailable} onChange={() => setChoice(option.value)} className="mt-1" />
                      <span>
                        <span className="font-medium text-text">{option.label}</span>
                        {option.value === current && <Badge tone="neutral" className="ml-2">em uso</Badge>}
                        <span className="block text-xs text-muted mt-0.5">{option.description}</span>
                        {unavailable && <span className="block text-xs text-warning mt-0.5">{option.unavailable}</span>}
                      </span>
                    </label>
                  )
                })}
              </fieldset>
            ) : (
              <p className="text-sm text-text">Em uso: <strong className="font-semibold">{adminAccessLabel(current)}</strong>. Só o administrador muda esta opção.</p>
            )}
            {isAdmin && (
              <div className="flex justify-end">
                <Button size="sm" icon={Save} loading={busy} disabled={!changed} onClick={requestSave}>Salvar acesso ao painel</Button>
              </div>
            )}
          </div>
        )}
      </CardBody>
      <Modal open={confirmLocal} onClose={() => !busy && setConfirmLocal(false)} title="Fechar o painel neste aparelho?"
        description="Você está usando o painel em outro aparelho, fora do computador do IClass."
        footer={<><Button variant="ghost" disabled={busy} onClick={() => setConfirmLocal(false)}>Cancelar</Button><Button loading={busy} onClick={save}>Salvar mesmo assim</Button></>}>
        <p className="text-sm text-text">Depois de salvar, o painel do professor só abre no computador onde o IClass está ligado. Este aparelho sai do painel na hora, e para voltar a usar daqui alguém precisa trocar a opção nesse computador.</p>
      </Modal>
      {manualCopy}
    </Card>
  )
}
