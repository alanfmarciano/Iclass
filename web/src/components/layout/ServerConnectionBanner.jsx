import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { CheckCircle2, RefreshCw, WifiOff } from 'lucide-react'
import { useServerConnection } from '../../hooks/useServerConnection'
import { isStudentExamPath } from '../../lib/sessionActivity'

// Faixa de conexão com o servidor (frente do H3: CONF-03, UXA-06, DES-08). Mostra quando o
// servidor não responde ou está reiniciando (lib/connection.js), para o aluno saber que é
// o servidor, não a prova, e não recarregar a página: no http://IP do celular não há cópia
// local das respostas, e recarregar perderia o que ainda não chegou ao servidor.
// - Só aparece depois de 1,5 s no mesmo estado (o Wi-Fi da sala oscila; a conexão já
//   precisa de 2 falhas seguidas para virar 'offline').
// - Na rota da prova, pede para continuar respondendo sem fechar nem recarregar.
// - Na volta, "Conexão restabelecida." por 4 s (só se a faixa chegou a aparecer).
// Faixa fixa no topo, role="status" com aria-live, sem rolagem horizontal a 375 px.
export const BANNER_DELAY_MS = 1500
export const RECOVERED_MS = 4000
export const OFFLINE_TEXT = 'Sem conexão com o servidor. Tentando reconectar…'
export const STARTING_TEXT = 'O servidor está reiniciando. Aguarde alguns segundos…'
export const EXAM_HINT_TEXT = 'Continue respondendo e não feche nem recarregue esta página: as respostas são enviadas quando a conexão voltar.'
export const RECOVERED_TEXT = 'Conexão restabelecida.'

export function ServerConnectionBanner() {
  const state = useServerConnection()
  const { pathname } = useLocation()
  const [shown, setShown] = useState(null) // 'offline' | 'starting' | 'recovered' | null
  const shownRef = useRef(shown)
  shownRef.current = shown

  useEffect(() => {
    if (state === 'online') {
      if (shownRef.current === 'offline' || shownRef.current === 'starting') {
        setShown('recovered')
        const timer = setTimeout(() => setShown(null), RECOVERED_MS)
        return () => clearTimeout(timer)
      }
      if (shownRef.current !== 'recovered') setShown(null)
      return undefined
    }
    // Já à vista (de offline para starting, ou vice-versa): troca o texto na hora.
    if (shownRef.current === 'offline' || shownRef.current === 'starting') {
      setShown(state)
      return undefined
    }
    if (shownRef.current === 'recovered') setShown(null)
    const timer = setTimeout(() => setShown(state), BANNER_DELAY_MS)
    return () => clearTimeout(timer)
  }, [state])

  const exam = isStudentExamPath(pathname)
  const visible = !!shown
  const recovered = shown === 'recovered'
  const Icon = recovered ? CheckCircle2 : shown === 'starting' ? RefreshCw : WifiOff
  const text = recovered ? RECOVERED_TEXT : shown === 'starting' ? STARTING_TEXT : OFFLINE_TEXT
  return (
    <div role="status" aria-live="polite" data-testid="server-connection-banner" className="fixed inset-x-0 top-0 z-[60] pointer-events-none">
      {visible && (
        // Os tons "soft" são translúcidos: a faixa fica sobre o cabeçalho da prova, então
        // leva o fundo opaco da superfície por baixo (senão o texto de trás aparece junto).
        <div data-testid="server-connection-banner-box" className="mx-auto w-full max-w-3xl bg-surface shadow-sm">
          <div className={`flex items-start gap-2 border-b px-4 py-2.5 text-sm text-text break-words ${recovered ? 'border-success bg-success-soft' : 'border-warning bg-warning-soft'}`}>
            <Icon aria-hidden="true" size={18} className={`mt-0.5 shrink-0 ${recovered ? 'text-success' : 'text-warning'}`} />
            <p className="min-w-0">
              <strong className="font-semibold">{text}</strong>
              {!recovered && exam && <span className="block">{EXAM_HINT_TEXT}</span>}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
