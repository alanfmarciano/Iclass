import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useApi } from '../../hooks/useApi'
import { useCopyText } from '../../components/ui/ManualCopyModal'
import { ADMIN_ERROR_DESCRIPTION, AppErrorBoundary } from '../../components/ui/ErrorScreen'
import { ROOM_ADDRESS_PATH, RoomAddressContent } from './RoomAddress'

// Página /endereco (fase 2, H6a; OPS-10): o endereço da sala em tela cheia, sem o menu,
// para projetar no quadro. Atualiza a cada 30 s: se o notebook trocar de Wi-Fi ou o
// roteador mudar o IP, o endereço e o QR projetados acompanham.
export const ROOM_ADDRESS_POLL_MS = 30000

// Fora do AppShell: a página traz a própria área de erro, como os layouts.
export default function EnderecoSalaPage() {
  return (
    <AppErrorBoundary area="admin" description={ADMIN_ERROR_DESCRIPTION}>
      <EnderecoSala />
    </AppErrorBoundary>
  )
}

function EnderecoSala() {
  const { data, loading, error } = useApi(ROOM_ADDRESS_PATH, [], { pollMs: ROOM_ADDRESS_POLL_MS })
  const { copy, manualCopy } = useCopyText()
  return (
    <main className="min-h-screen bg-bg text-text flex flex-col">
      <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Link to="/" className="inline-flex items-center gap-2 text-sm text-muted hover:text-text">
          <ArrowLeft size={16} aria-hidden="true" /> Voltar ao painel
        </Link>
        <span className="text-xs text-muted">Atualiza sozinho a cada 30 segundos.</span>
      </div>
      <section className="flex-1 grid place-items-center px-4 pb-10 sm:px-6" aria-labelledby="endereco-sala-titulo">
        <div className="w-full max-w-6xl space-y-8">
          <h1 id="endereco-sala-titulo" className="text-center text-3xl font-bold sm:text-4xl">Entre no IClass</h1>
          {loading && !data && <p className="text-center text-muted" role="status">Carregando o endereço...</p>}
          {error && !data && <p className="text-center text-danger" role="alert">{error.message || 'Não foi possível carregar o endereço.'}</p>}
          <RoomAddressContent data={data} large qrSize={320} onCopy={(url) => copy(url, { success: 'Endereço copiado', label: 'Endereço da sala' })} />
        </div>
      </section>
      {manualCopy}
    </main>
  )
}
