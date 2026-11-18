import { useState } from 'react'
import { Copy, ExternalLink, QrCode as QrIcon, WifiOff } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Modal } from '../../components/ui/Modal'
import { QrCode } from '../../components/ui/QrCode'
import { useCopyText } from '../../components/ui/ManualCopyModal'
import { useApi } from '../../hooks/useApi'

// Endereço da sala (fase 2, H6a; OPS-10): o endereço que os alunos digitam no celular
// (esquema, IP e porta, nunca só o IP) e o QR code dele, gerado no servidor
// (GET /api/admin/room-address). Aparece no botão "Endereço da sala" do Dashboard e do
// Monitor e na página /endereco, para projetar no quadro.

export const ROOM_ADDRESS_PATH = '/api/admin/room-address'
export const NO_NETWORK_TEXT = 'Este computador não está ligado a nenhuma rede. Conecte-o ao Wi-Fi da sala e o endereço aparece aqui.'

// Se o endereço não couber numa linha, quebra depois de "//" ou antes de ":porta", nunca
// no meio do IP ou da porta.
function UrlWithBreaks({ url }) {
  const match = /^([a-z]+:\/\/)([^:/]+)(:\d+)?(.*)$/i.exec(String(url || ''))
  if (!match) return url
  return <>{match[1]}<wbr />{match[2]}{match[3] && <><wbr />{match[3]}</>}{match[4]}</>
}

export function RoomAddressContent({ data, qrSize = 240, large = false, onCopy }) {
  if (!data) return null
  if (!data.studentUrl) {
    return (
      <p className="flex items-start gap-2 text-sm text-warning" role="status">
        <WifiOff size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>{NO_NETWORK_TEXT}</span>
      </p>
    )
  }
  return (
    <div className={`flex flex-col items-center gap-4 text-center ${large ? 'md:flex-row md:items-center md:gap-12 md:text-left' : ''}`}>
      {data.qr?.rows && <QrCode rows={data.qr.rows} url={data.studentUrl} size={qrSize} className="shrink-0" />}
      <div className="min-w-0 space-y-2">
        <p className={large ? 'text-lg text-muted' : 'text-sm text-muted'}>No celular ou no computador, abra o navegador e digite o endereço completo, com o número depois dos dois-pontos:</p>
        <p
          className={`font-mono font-bold text-text [overflow-wrap:anywhere] ${large ? 'text-2xl sm:text-5xl md:text-4xl xl:text-5xl leading-tight' : 'text-xl sm:text-2xl'}`}
          data-testid="room-address-url"
        >
          <UrlWithBreaks url={data.studentUrl} />
        </p>
        {data.nameUrl && <p className={large ? 'text-xl text-muted' : 'text-sm text-muted'}>ou digite <span className="font-mono text-text">{data.nameUrl}</span></p>}
        <p className={large ? 'text-base text-muted' : 'text-xs text-muted'}>Ou aponte a câmera do celular para o QR code. O celular precisa estar no mesmo Wi-Fi deste computador.</p>
        {onCopy && (
          <div className={`flex flex-wrap gap-2 pt-1 ${large ? 'justify-center md:justify-start' : 'justify-center'}`}>
            <Button variant="secondary" size="sm" icon={Copy} onClick={() => onCopy(data.studentUrl)}>Copiar endereço</Button>
          </div>
        )}
      </div>
    </div>
  )
}

// Botão do PageHeader do Dashboard e do Monitor: abre um modal com o endereço e o QR.
// Consulta o servidor só quando o modal abre (o IP pode ter mudado desde a última vez).
export function RoomAddressButton({ variant = 'secondary' }) {
  const [open, setOpen] = useState(false)
  const [openCount, setOpenCount] = useState(0)
  const { data, loading, error } = useApi(open ? ROOM_ADDRESS_PATH : null, [openCount])
  const { copy, manualCopy } = useCopyText()
  function show() {
    setOpenCount((value) => value + 1)
    setOpen(true)
  }
  return (
    <>
      <Button variant={variant} icon={QrIcon} onClick={show}>Endereço da sala</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Endereço da sala"
        description="Mostre aos alunos para eles entrarem no IClass pelo celular."
        footer={(
          <>
            <a href="/endereco" target="_blank" rel="noopener" className="inline-flex h-[38px] items-center gap-2 rounded-lg px-4 text-sm font-semibold text-muted hover:bg-surface-2 hover:text-text">
              <ExternalLink size={16} aria-hidden="true" /> Projetar em tela cheia
            </a>
            <Button onClick={() => setOpen(false)}>Fechar</Button>
          </>
        )}>
        {loading && !data && <p className="text-sm text-muted" role="status">Carregando o endereço...</p>}
        {error && !data && <p className="text-sm text-danger" role="alert">{error.message || 'Não foi possível carregar o endereço.'}</p>}
        <RoomAddressContent data={data} onCopy={(url) => copy(url, { success: 'Endereço copiado', label: 'Endereço da sala' })} />
      </Modal>
      {manualCopy}
    </>
  )
}
