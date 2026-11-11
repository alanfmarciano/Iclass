import { ShieldAlert, ShieldCheck } from 'lucide-react'
import { CERTIFICATE_GUIDE_PATH, INSECURE_ADMIN_TEXT, INSECURE_ADMIN_TITLE, SECURE_CONNECTION_LINK_TEXT } from '../../lib/adminAccess'
import { useConnectionInfo } from '../../hooks/useConnectionInfo'

// Aviso fixo do painel do professor aberto por http em outro aparelho da rede (modo
// 'rede-sem-https', SEG-03): a senha passa pela rede sem proteção. Não fecha. No
// computador do IClass, ou com a conexão segura, não aparece. Com a conexão segura
// funcionando neste IClass (tlsAvailable, H6c), traz o link "Usar conexão segura" para o
// guia /certificado (instalar o certificado e abrir o endereço https).
// `connection` (opcional) evita uma segunda consulta quando a tela já tem a resposta de
// /api/connection; sem ela, a consulta é refeita quando a tela volta a ficar visível
// (useConnectionInfo).
export function InsecureConnectionNotice({ connection: given, className = '' }) {
  const { connection: fetched } = useConnectionInfo({ enabled: given === undefined })
  const connection = given !== undefined ? given : fetched
  if (!connection || connection.insecureAdmin !== true) return null
  return (
    <div role="status" data-testid="insecure-connection-notice" className={`flex items-start gap-2.5 rounded-lg border border-warning bg-warning-soft px-4 py-3 text-sm text-text ${className}`}>
      <ShieldAlert aria-hidden="true" size={18} className="mt-0.5 shrink-0 text-warning" />
      <div className="min-w-0 space-y-1.5">
        <p><strong className="font-semibold">{INSECURE_ADMIN_TITLE}.</strong> {INSECURE_ADMIN_TEXT}</p>
        {connection.tlsAvailable === true && (
          <a href={CERTIFICATE_GUIDE_PATH} data-testid="use-secure-connection" className="inline-flex items-center gap-1.5 font-semibold text-text underline">
            <ShieldCheck aria-hidden="true" size={15} className="shrink-0" /> {SECURE_CONNECTION_LINK_TEXT}
          </a>
        )}
      </div>
    </div>
  )
}
