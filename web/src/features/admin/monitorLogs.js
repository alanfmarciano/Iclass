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
export function focusLogLabel(log) {
  const type = log?.eventType
  if (type === 'tab_blur') return 'Foco perdido'
  if (type === 'tab_focus') return 'Foco recuperado'
  if (type === 'exam_left') return examLeftLabel(log?.details)
  if (type === 'exam_return') return 'Retornou a prova'
  if (type === 'fullscreen_exit') return 'Saiu da tela cheia'
  if (type === 'fullscreen_unsupported') return 'Dispositivo sem tela cheia'
  if (type === 'focus_unlocked') return 'Liberado pelo professor'
  return type || 'Evento'
}

export const LOG_INFO = {
  tab_blur: { label: 'Saiu do foco da prova', icon: '⇄', sev: 'high' },
  exam_left: { label: 'Saiu da prova', icon: '⎋', sev: 'high' },
  fullscreen_exit: { label: 'Saiu da tela cheia', icon: '⛶', sev: 'high' },
  // Aparelho sem tela cheia (iPhone): a prova abriu sem ela e não foi pausada (UXA-02).
  // É um aviso ao professor, não um comando do aluno: aparece no painel, mas não conta
  // como comando suspeito nem pinta a linha do tempo de vermelho.
  fullscreen_unsupported: { label: 'Dispositivo sem tela cheia', icon: '📱', sev: 'info', pauses: false, informative: true },
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
