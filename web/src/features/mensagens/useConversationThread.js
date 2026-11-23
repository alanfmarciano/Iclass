import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { usePolling } from '../../hooks/usePolling'
import { requestNotificationsRefresh } from '../../lib/messageCounter'
import { THREAD_POLL_MS, firstTimestamp, lastFromOtherSide, lastTimestamp, mergeMessages } from './conversationFormat'

// Uma conversa aberta na tela Mensagens (fase 3, C14 / P5-S7b, FUN-14), no portal do aluno
// (side 'aluno', basePath '/api/student/conversations') e no painel (side 'instrutor',
// basePath '/api/admin/conversations'):
// - abre com as últimas mensagens (GET /:id/messages, que não grava nada no servidor);
// - com a conversa aberta, pergunta a cada 10 s só pelas novas (?depois=<a última>), pelo
//   usePolling (uma consulta por vez, pausa com a aba oculta, recuo com o servidor fora).
//   Fora da conversa, quem avisa é o sino (D13 do P5);
// - "Mensagens anteriores" busca as de antes da primeira (?antes=);
// - marca como lida (POST /:id/read { ate }) a última mensagem do outro lado que está na
//   tela, só com a aba visível e só quando ela passa da marca que já está gravada; depois
//   pede ao sino uma consulta na hora (o contador do menu baixa). canMarkRead false: o
//   administrador lendo a conversa de outra pessoa não marca nada;
// - send(texto) manda a mensagem (POST /:id/messages) e a põe na tela sem esperar a
//   consulta seguinte; a mesma mensagem que vier depois pela consulta não se repete.
// O erro de abrir fica em `error` (com `error.data.code` do servidor: 404
// conversation_not_found, 403 admin_open_required...). onChange(conversa) avisa a lista
// quando a conversa mudou (mensagem nova, lida, encerrada).
const EMPTY = { conversa: null, mensagens: [], temAnteriores: false, meta: {} }

function pathFor(basePath, id, suffix = '') {
  return `${basePath}/${encodeURIComponent(id)}${suffix}`
}

function metaOf(response) {
  if (!response || typeof response !== 'object') return {}
  const meta = {}
  ;['aviso', 'avisoGuardadas', 'emProva', 'limites', 'leituraAdministrativa'].forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(response, key)) meta[key] = response[key]
  })
  return meta
}

function pageHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

export function useConversationThread({ basePath, conversationId, side, canMarkRead = true, enabled = true, onChange }) {
  const id = enabled && conversationId ? String(conversationId) : ''
  const [state, setState] = useState(EMPTY)
  const [loading, setLoading] = useState(!!id)
  const [error, setError] = useState(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const idRef = useRef(id)
  idRef.current = id
  const stateRef = useRef(state)
  stateRef.current = state
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  // Até onde esta tela já pediu a marca de leitura (para não repetir o mesmo POST).
  const markedRef = useRef(0)
  const [visibleTick, setVisibleTick] = useState(0)

  const notifyChange = useCallback((conversa) => {
    if (conversa && onChangeRef.current) {
      try { onChangeRef.current(conversa) } catch { /* a lista se atualiza na próxima vez */ }
    }
  }, [])

  const load = useCallback(async () => {
    if (!id) { setState(EMPTY); setLoading(false); setError(null); return }
    setLoading(true)
    setError(null)
    try {
      const response = await api.get(pathFor(basePath, id, '/messages'))
      if (idRef.current !== id) return
      setState({
        conversa: response?.conversa || null,
        mensagens: mergeMessages([], response?.mensagens),
        temAnteriores: response?.temAnteriores === true,
        meta: metaOf(response),
      })
    } catch (err) {
      if (idRef.current !== id) return
      setState(EMPTY)
      setError(err)
    } finally {
      if (idRef.current === id) setLoading(false)
    }
  }, [basePath, id])

  useEffect(() => {
    markedRef.current = 0
    setState(EMPTY)
    load()
  }, [load])

  // Consulta a cada 10 s: só as novas, depois da última que está na tela.
  const poll = useCallback(async (requestOptions) => {
    const current = stateRef.current
    if (!id || !current.conversa) return true
    const last = lastTimestamp(current.mensagens)
    const query = last ? `?depois=${last}` : ''
    try {
      const response = await api.get(pathFor(basePath, id, `/messages${query}`), requestOptions)
      if (idRef.current !== id) return true
      const incoming = Array.isArray(response?.mensagens) ? response.mensagens : []
      setState((prev) => ({
        conversa: response?.conversa || prev.conversa,
        mensagens: mergeMessages(prev.mensagens, incoming),
        temAnteriores: last ? prev.temAnteriores : response?.temAnteriores === true,
        meta: { ...prev.meta, ...metaOf(response) },
      }))
      if (incoming.length) notifyChange(response?.conversa)
      return true
    } catch (err) {
      if (idRef.current !== id) return true
      // A conversa sumiu (curso excluído, aluno trocou de turma) ou o acesso acabou.
      if (err && (err.status === 404 || err.status === 403)) { setState(EMPTY); setError(err); return true }
      return false
    }
  }, [basePath, id, notifyChange])

  const polling = usePolling(poll, {
    intervalMs: THREAD_POLL_MS,
    enabled: !!id && !!state.conversa && !error,
    immediate: false,
    resetKey: id,
  })

  // Aba que volta a ficar visível: confere a marca de leitura de novo.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const onVisible = () => { if (!pageHidden()) setVisibleTick((tick) => tick + 1) }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  // Marca de leitura: a última mensagem do outro lado que está na tela.
  useEffect(() => {
    if (!id || !canMarkRead || !state.conversa || pageHidden()) return
    // O administrador lendo a conversa de outra pessoa não marca leitura (o servidor
    // recusa com 403 not_participant).
    if (state.meta.leituraAdministrativa === true || state.conversa.participante === false) return
    const target = lastFromOtherSide(state.mensagens, side)
    const stored = Number(state.conversa.lidaAte) || 0
    if (!target || target <= stored || target <= markedRef.current) return
    markedRef.current = target
    let cancelled = false
    api.post(pathFor(basePath, id, '/read'), { ate: target }).then((response) => {
      if (cancelled || idRef.current !== id) return
      const lidaAte = Number(response?.lidaAte) || target
      setState((prev) => (prev.conversa ? { ...prev, conversa: { ...prev.conversa, lidaAte, naoLidas: 0 } } : prev))
      requestNotificationsRefresh()
      notifyChange({ ...stateRef.current.conversa, lidaAte, naoLidas: 0 })
    }).catch(() => {
      // Tenta de novo na próxima consulta (sem rede, servidor ocupado).
      if (markedRef.current === target) markedRef.current = 0
    })
    return () => { cancelled = true }
  }, [basePath, canMarkRead, id, notifyChange, side, state.conversa, state.mensagens, state.meta.leituraAdministrativa, visibleTick])

  const loadOlder = useCallback(async () => {
    const current = stateRef.current
    const first = firstTimestamp(current.mensagens)
    if (!id || !first || loadingOlder) return
    setLoadingOlder(true)
    try {
      const response = await api.get(pathFor(basePath, id, `/messages?antes=${first}`))
      if (idRef.current !== id) return
      setState((prev) => ({
        ...prev,
        mensagens: mergeMessages(response?.mensagens, prev.mensagens),
        temAnteriores: response?.temAnteriores === true,
      }))
    } catch {
      /* o botão continua para tentar de novo */
    } finally {
      if (idRef.current === id) setLoadingOlder(false)
    }
  }, [basePath, id, loadingOlder])

  // Manda a mensagem. Rejeita com o erro do servidor (a tela mostra err.message e decide
  // pelo err.data.code); sucesso devolve a mensagem gravada.
  const send = useCallback(async (texto) => {
    if (!id) throw new Error('Abra uma conversa.')
    const response = await api.post(pathFor(basePath, id, '/messages'), { texto })
    if (idRef.current === id) {
      setState((prev) => ({
        ...prev,
        conversa: response?.conversa ? { ...prev.conversa, ...response.conversa } : prev.conversa,
        mensagens: mergeMessages(prev.mensagens, response?.mensagem ? [response.mensagem] : []),
      }))
      notifyChange(response?.conversa)
    }
    return response?.mensagem || null
  }, [basePath, id, notifyChange])

  // A tela trocou a conversa por fora (encerrar, reabrir, arquivar): guarda a nova.
  const updateConversation = useCallback((conversa) => {
    if (!conversa) return
    setState((prev) => (prev.conversa ? { ...prev, conversa: { ...prev.conversa, ...conversa } } : prev))
    notifyChange(conversa)
  }, [notifyChange])

  return {
    conversa: state.conversa,
    mensagens: state.mensagens,
    temAnteriores: state.temAnteriores,
    meta: state.meta,
    loading,
    error,
    loadingOlder,
    reload: load,
    pollNow: polling.runNow,
    loadOlder,
    send,
    updateConversation,
  }
}
