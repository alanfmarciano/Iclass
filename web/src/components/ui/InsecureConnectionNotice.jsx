import { useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { fetchConnectionInfo, INSECURE_ADMIN_TEXT, INSECURE_ADMIN_TITLE } from '../../lib/adminAccess'

// Aviso fixo do painel do professor aberto por http em outro aparelho da rede (modo
// 'rede-sem-https', SEG-03): a senha passa pela rede sem proteção. Não fecha. No
// computador do IClass, ou com a conexão segura, não aparece. `connection` (opcional)
// evita uma segunda consulta quando a tela já tem a resposta de /api/connection.
export function InsecureConnectionNotice({ connection: given, className = '' }) {
  const [fetched, setFetched] = useState(null)
  useEffect(() => {
    if (given !== undefined) return undefined
    let cancelled = false
    fetchConnectionInfo().then((info) => { if (!cancelled) setFetched(info) })
    return () => { cancelled = true }
  }, [given])
  const connection = given !== undefined ? given : fetched
  if (!connection || connection.insecureAdmin !== true) return null
  return (
    <div role="status" data-testid="insecure-connection-notice" className={`flex items-start gap-2.5 rounded-lg border border-warning bg-warning-soft px-4 py-3 text-sm text-text ${className}`}>
      <ShieldAlert aria-hidden="true" size={18} className="mt-0.5 shrink-0 text-warning" />
      <p><strong className="font-semibold">{INSECURE_ADMIN_TITLE}.</strong> {INSECURE_ADMIN_TEXT}</p>
    </div>
  )
}
