import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
// - Enquanto está à vista, a altura dela vai para a variável CSS --connection-banner-h e
//   o #root ganha esse espaço em cima (index.css): a faixa empurra a tela para baixo em vez
//   de ficar por cima. Antes cobria o cabeçalho fixo da prova inteiro (cronômetro, x/y
//   respondidas, o aviso de salvamento e o botão Enviar), e um toque na faixa acionava o
//   Enviar escondido por baixo.
// - Tela estreita ou baixa (zoom de 200% num celular de 390 px dá 195 x 422 px CSS; celular
//   deitado): faixa compacta, sem a coluna do ícone, com textos curtos e a dica da prova na
//   mesma linha do título. A faixa completa ocupava 241 px dos 422 e, com o cabeçalho fixo
//   da prova, sobravam 39 px para as questões: a faixa pedia para continuar respondendo e o
//   aluno quase não conseguia. O tamanho da letra fica o mesmo (quem usa zoom precisa dele).
export const BANNER_DELAY_MS = 1500
export const RECOVERED_MS = 4000
export const OFFLINE_TEXT = 'Sem conexão com o servidor. Tentando reconectar…'
export const STARTING_TEXT = 'O servidor está reiniciando. Aguarde alguns segundos…'
export const EXAM_HINT_TEXT = 'Continue respondendo e não feche nem recarregue esta página: as respostas são enviadas quando a conexão voltar.'
export const RECOVERED_TEXT = 'Conexão restabelecida.'
export const OFFLINE_SHORT_TEXT = 'Sem conexão. Tentando reconectar…'
export const STARTING_SHORT_TEXT = 'Servidor reiniciando…'
export const EXAM_HINT_SHORT_TEXT = 'Continue respondendo e não recarregue a página.'
export const COMPACT_MEDIA = '(max-width: 359px), (max-height: 479px)'

export const BANNER_HEIGHT_VAR = '--connection-banner-h'

function setBannerHeight(px) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (px > 0) root.style.setProperty(BANNER_HEIGHT_VAR, `${Math.ceil(px)}px`)
  else root.style.removeProperty(BANNER_HEIGHT_VAR)
}

function matchesCompact() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return !!window.matchMedia(COMPACT_MEDIA)?.matches
}

// Acompanha a largura e a altura da tela (zoom, giro do celular).
function useCompactBanner() {
  const [compact, setCompact] = useState(matchesCompact)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const media = window.matchMedia(COMPACT_MEDIA)
    if (!media) return undefined
    const update = () => setCompact(!!media.matches)
    update()
    if (typeof media.addEventListener === 'function') media.addEventListener('change', update)
    else if (typeof media.addListener === 'function') media.addListener(update)
    return () => {
      if (typeof media.removeEventListener === 'function') media.removeEventListener('change', update)
      else if (typeof media.removeListener === 'function') media.removeListener(update)
    }
  }, [])
  return compact
}

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
  const compact = useCompactBanner()
  const visible = !!shown
  const boxRef = useRef(null)

  // Reserva o espaço da faixa (e acompanha a altura: texto em duas linhas, giro da tela).
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!visible || !box) { setBannerHeight(0); return undefined }
    const measure = () => setBannerHeight(box.getBoundingClientRect().height)
    measure()
    let observer = null
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(measure)
      observer.observe(box)
    }
    window.addEventListener('resize', measure)
    return () => {
      if (observer) observer.disconnect()
      window.removeEventListener('resize', measure)
      setBannerHeight(0)
    }
  }, [visible, shown, exam, compact])

  const recovered = shown === 'recovered'
  const Icon = recovered ? CheckCircle2 : shown === 'starting' ? RefreshCw : WifiOff
  const text = recovered
    ? RECOVERED_TEXT
    : shown === 'starting'
      ? (compact ? STARTING_SHORT_TEXT : STARTING_TEXT)
      : (compact ? OFFLINE_SHORT_TEXT : OFFLINE_TEXT)
  const hint = !recovered && exam ? (compact ? EXAM_HINT_SHORT_TEXT : EXAM_HINT_TEXT) : null
  const tone = recovered ? 'border-success bg-success-soft' : 'border-warning bg-warning-soft'
  return (
    <div role="status" aria-live="polite" data-testid="server-connection-banner" className="fixed inset-x-0 top-0 z-[60] pointer-events-none">
      {visible && (
        // Os tons "soft" são translúcidos: a faixa leva o fundo opaco da superfície por
        // baixo. Largura inteira (o espaço reservado em cima vai de ponta a ponta) e o texto
        // centralizado. Recebe o toque (pointer-events-auto): nada passa para o que estiver
        // por baixo dela.
        <div ref={boxRef} data-testid="server-connection-banner-box" data-compact={compact ? 'true' : undefined} className="w-full bg-surface shadow-sm pointer-events-auto">
          {compact ? (
            <div className={`border-b px-2 py-1 text-sm leading-snug text-text text-center break-words ${tone}`}>
              <p className="mx-auto max-w-3xl">
                <strong className="font-semibold">{text}</strong>
                {hint && <span> {hint}</span>}
              </p>
            </div>
          ) : (
            <div className={`border-b px-4 py-2.5 text-sm text-text break-words ${tone}`}>
              <div className="mx-auto flex w-full max-w-3xl items-start gap-2">
                <Icon aria-hidden="true" size={18} className={`mt-0.5 shrink-0 ${recovered ? 'text-success' : 'text-warning'}`} />
                <p className="min-w-0">
                  <strong className="font-semibold">{text}</strong>
                  {hint && <span className="block">{hint}</span>}
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
