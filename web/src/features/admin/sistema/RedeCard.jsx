import { useEffect, useState } from 'react'
import { MonitorSmartphone, Save, Wifi } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../../components/ui/Card'
import { Button } from '../../../components/ui/Button'
import { Badge } from '../../../components/ui/Badge'
import { Modal } from '../../../components/ui/Modal'
import { useApi } from '../../../hooks/useApi'
import { api } from '../../../lib/api'
import { useToast } from '../../../context/ToastProvider'
import { ADMIN_ACCESS_MODES, ADMIN_ACCESS_OPTIONS, adminAccessLabel } from '../../../lib/adminAccess'

// Cartão Rede da tela Sistema (H6): endereços para os alunos e, para quem gerencia o
// sistema, onde o painel do professor abre (settings.network.adminAccess, SEG-03). Só o
// administrador troca a regra; o professor vê qual vale. A opção da conexão segura fica
// desligada enquanto o IClass não tiver https (H6c).
export function RedeCard({ canManage = false, isAdmin = false }) {
  const { data: net } = useApi('/api/admin/network-info')
  const settings = useApi(canManage ? '/api/admin/network-settings' : null, [canManage])
  const current = settings.data?.adminAccess || ''
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmLocal, setConfirmLocal] = useState(false)
  const toast = useToast()
  useEffect(() => { if (current) setChoice(current) }, [current])

  const ips = (net && (net.addresses || net.ips || net)) || []
  const list = Array.isArray(ips) ? ips : []
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
        <div className="space-y-2">
          {list.length === 0 && <p className="text-sm text-muted flex items-center gap-2"><Wifi size={16} /> Endereços aparecem quando o servidor estiver rodando.</p>}
          {list.map((ip, i) => (
            <div key={i} className="flex items-center gap-2 text-sm">
              <Wifi size={15} className="text-info" />
              <code className="font-mono text-text">{ip.address || ip}</code>
              {ip.name && <Badge tone="neutral">{ip.name}</Badge>}
            </div>
          ))}
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
    </Card>
  )
}
