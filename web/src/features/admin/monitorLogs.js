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
  fullscreen_unsupported: { label: 'Dispositivo sem tela cheia', icon: '📱', sev: 'info', pauses: false, informative: true, badge: 'prova sem tela cheia' },
  // Recarregou ou saiu da página e a mesma sessão voltou logo: a prova destravou sozinha.
  page_return: { label: 'Recarregou ou saiu da página e voltou', icon: '↻', sev: 'info', pauses: false, informative: true, badge: 'destravou sozinha' },
  // Erro de tela na prova (falha do sistema, não do aluno): não trava a prova.
  exam_render_error: { label: 'Erro técnico na tela da prova', icon: '⚠', sev: 'info', pauses: false, informative: true, badge: 'não travou a prova' },
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
