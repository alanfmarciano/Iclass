// Rótulos dos registros de foco e saída da prova no Monitor (AVA-12, UXA-02).

// Como o aluno saiu da prova (exam_left), pelo texto que o navegador registrou.
export function examLeftLabel(details) {
  const text = String(details || '').toLowerCase()
  if (text.includes('voltar do navegador')) return 'Saiu pelo voltar do navegador'
  if (text.includes('link do portal')) return 'Saiu por um link do portal'
  if (text.includes('botão da prova')) return 'Saiu pelo botão Sair'
  if (text.includes('fechada ou recarregada')) return 'Fechou ou recarregou a prova'
  if (text.includes('pela navegação')) return 'Saiu da prova pela navegação'
  return 'Saiu da prova'
}
// Volta à prova logo depois de recarregar ou sair da página: a prova destravou sozinha
// (regra de retorno em até 60 s, backend/utils/examFocusRules.js).
export function pageReturnLabel(details) {
  const match = /voltou em (\d+) s/i.exec(String(details || ''))
  return match ? `Recarregou ou saiu da página e voltou em ${match[1]} s` : 'Recarregou ou saiu da página e voltou'
}

// Rótulo de um registro da prova no painel do Monitor.
export function logLabel(log) {
  const type = log?.eventType
  if (type === 'exam_left') return examLeftLabel(log?.details)
  if (type === 'page_return') return pageReturnLabel(log?.details)
  return LOG_INFO[type]?.label || focusLogLabel(log)
}

export function focusLogLabel(log) {
  const type = log?.eventType
  if (type === 'tab_blur') return 'Foco perdido'
  if (type === 'tab_focus') return 'Foco recuperado'
  if (type === 'exam_left') return examLeftLabel(log?.details)
  if (type === 'exam_return') return 'Retornou a prova'
  if (type === 'fullscreen_exit') return 'Saiu da tela cheia'
  if (type === 'fullscreen_unsupported') return 'Dispositivo sem tela cheia'
  if (type === 'page_return') return pageReturnLabel(log?.details)
  if (type === 'exam_render_error') return 'Erro técnico na tela da prova'
  if (type === 'exam_error_reload') return 'Recarregou depois do erro de tela'
  if (type === 'exam_update_reload') return 'Recarregou com a atualização do IClass'
  if (type === 'focus_unlocked') return 'Liberado pelo professor'
  // Ações por aluno do Monitor (P3-S8): ficam no registro, sem contar como saída de foco.
  if (type === 'attempt_collected') return 'Recolhida pelo professor'
  if (type === 'attempt_reopened') return 'Reaberta pelo professor'
  // Anulação por cola (P3-S4a): o texto do registro diz a decisão (nota zero ou não conta).
  if (type === 'attempt_invalidated') {
    const details = String(log?.details || '').toLowerCase()
    if (details.includes('nota zero')) return 'Tentativa anulada (nota zero)'
    if (details.includes('não conta')) return 'Tentativa anulada (não conta)'
    return 'Tentativa anulada pelo professor'
  }
  if (type === 'attempt_invalidation_undone') return 'Anulação desfeita pelo professor'
  // Outro login e troca de IP durante a prova (P3-S13).
  if (type === 'session_replaced') return 'Entrou de outro aparelho'
  if (type === 'ip_changed') return 'Mudou de endereço de rede (IP)'
  if (type === 'time_adjusted') {
    const amount = String(log?.details || '').match(/^[+-]?\d+ min/)
    return amount ? `Tempo ajustado (${amount[0]})` : 'Tempo ajustado pelo professor'
  }
  return type || 'Evento'
}

export const LOG_INFO = {
  tab_blur: { label: 'Saiu do foco da prova', icon: '⇄', sev: 'high' },
  exam_left: { label: 'Saiu da prova', icon: '⎋', sev: 'high' },
  fullscreen_exit: { label: 'Saiu da tela cheia', icon: '⛶', sev: 'high' },
  // Aparelho sem tela cheia (iPhone): a prova abriu sem ela e não foi pausada (UXA-02).
  // É um aviso ao professor, não um comando do aluno: aparece no painel, mas não conta
  // como comando suspeito nem pinta a linha do tempo de vermelho.
  fullscreen_unsupported: { label: 'Dispositivo sem tela cheia', icon: '📱', sev: 'info', pauses: false, informative: true, badge: 'prova sem tela cheia' },
  // Recarregou ou saiu da página e a mesma sessão voltou logo: a prova destravou sozinha.
  page_return: { label: 'Recarregou ou saiu da página e voltou', icon: '↻', sev: 'info', pauses: false, informative: true, badge: 'destravou sozinha' },
  // Erro de tela na prova (falha do sistema, não do aluno): não trava a prova.
  exam_render_error: { label: 'Erro técnico na tela da prova', icon: '⚠', sev: 'info', pauses: false, informative: true, badge: 'não travou a prova' },
  // Recarga pelo botão da tela de erro da prova: volta à mesma tentativa, não é saída.
  exam_error_reload: { label: 'Recarregou depois do erro de tela', icon: '↻', sev: 'info', pauses: false, informative: true, badge: 'não travou a prova' },
  // O IClass foi atualizado com a prova aberta e a página recarregou sozinha (não é saída).
  exam_update_reload: { label: 'Recarregou com a atualização do IClass', icon: '↻', sev: 'info', pauses: false, informative: true, badge: 'não travou a prova' },
  // Outro login com a mesma conta no meio da prova (P3-S13, D28): trava pela política da
  // aplicação ('travar', o padrão); com 'avisar', fica só o aviso (logInfoFor).
  session_replaced: { label: 'Entrou de outro aparelho', icon: '⇆', sev: 'high' },
  // Troca de endereço de rede (celular que troca de Wi-Fi para 4G): só aviso, nunca trava.
  ip_changed: { label: 'Mudou de endereço de rede (IP)', icon: '⇄', sev: 'info', pauses: false, informative: true, badge: 'não travou a prova' },
}

// Informação do painel para um registro: a de LOG_INFO e, no outro login, se ele travou a
// prova (o registro guarda sessionChange.travou).
export function logInfoFor(log) {
  const info = LOG_INFO[log?.eventType]
  if (!info) return info
  if (log.eventType === 'session_replaced' && log.sessionChange && log.sessionChange.travou !== true) {
    return { ...info, pauses: false, badge: 'não travou a prova' }
  }
  return info
}

// Motivo da trava mostrado na linha do Monitor: o código do servidor vira texto.
export function lockReasonLabel(reason) {
  if (reason === 'session_replaced') return 'Entrou de outro aparelho'
  return reason || ''
}

function clockTime(ms) {
  const at = Number(ms)
  if (!Number.isFinite(at) || at <= 0) return ''
  return new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

// Selos da linha do Monitor para o outro login e a troca de IP (P3-S13, D28):
// [{ key, tone, text, title }].
export function sessionRowBadges(row) {
  const badges = []
  if (Number(row?.sessionReplacedCount) > 0) {
    const time = clockTime(row.sessionReplacedAt)
    const times = Number(row.sessionReplacedCount)
    badges.push({
      key: 'session_replaced',
      tone: 'danger',
      text: time ? `Entrou de outro aparelho às ${time}` : 'Entrou de outro aparelho',
      title: times > 1
        ? `A conta entrou em outro aparelho ${times} vezes durante esta tentativa. Veja os detalhes no histórico do aluno.`
        : 'A conta entrou em outro aparelho durante esta tentativa. Veja o IP e o navegador no histórico do aluno.',
    })
  }
  if (Number(row?.ipChangeCount) > 0) {
    const times = Number(row.ipChangeCount)
    badges.push({
      key: 'ip_changed',
      tone: 'warning',
      text: times > 1 ? `Mudou de IP (${times}×)` : 'Mudou de IP',
      title: 'O endereço de rede do aparelho mudou durante a prova (por exemplo, o celular trocou de Wi-Fi para 4G). A prova não foi travada.',
    })
  }
  return badges
}

// "Mesmo IP de Fulano" (D29): o servidor só manda sameIpAs com 2 ou 3 alunos no mesmo IP
// numa sala com pelo menos 5 IPs diferentes. nameOf: (pessoa) => nome para mostrar.
export function sameIpLabel(row, nameOf = (person) => person?.name || '') {
  const others = (Array.isArray(row?.sameIpAs) ? row.sameIpAs : []).map(nameOf).filter(Boolean)
  if (!others.length) return ''
  return `Mesmo IP de ${others.join(' e ')}`
}

const SEV_RANK = { high: 3, med: 2, low: 1 }

// Item da linha do tempo do painel que é suspeito (comando de gravidade média ou alta).
export function isSuspiciousItem(item) {
  if (!item || item.cat !== 'cmd' || item.informative) return false
  return (SEV_RANK[item.sev] || 0) >= SEV_RANK.med
}

// Alertas do painel: comandos suspeitos e avisos ao professor (sem tela cheia), com
// repetidos em sequência colapsados.
export function buildAlerts(items) {
  const out = []
  for (const item of items || []) {
    if (!isSuspiciousItem(item) && !(item?.cat === 'cmd' && item.informative)) continue
    const last = out[out.length - 1]
    if (last && last.sig === item.sig) { last.count++; last.lastT = item.t }
    else out.push({ ...item, count: 1, lastT: item.t })
  }
  return out
}

// Quantos comandos suspeitos (os avisos ao professor não contam).
export function suspiciousCount(alerts) {
  return (alerts || []).reduce((total, alert) => total + (isSuspiciousItem(alert) ? alert.count || 1 : 0), 0)
}
