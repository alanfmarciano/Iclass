import { describe, expect, it } from 'vitest'
import { LOG_INFO, buildAlerts, countsAsFocusExit, examLeftLabel, focusLogLabel, isDeviceChangeItem, isSuspiciousItem, lockReasonLabel, logInfoFor, logLabel, sameIpLabel, sessionChangeText, sessionRowBadges, suspiciousCount } from './monitorLogs'

// Item da linha do tempo do painel como o MonitorPage monta a partir de um registro.
function logItem(eventType, t, details = '') {
  const info = LOG_INFO[eventType]
  return { cat: 'cmd', kind: 'focus', t, sig: eventType, ...info, log: { eventType, details } }
}

describe('[UC-PROVA-003] Monitor: registros da prova (UXA-02, AVA-12)', () => {
  it('"Dispositivo sem tela cheia" aparece no painel, mas não conta como comando suspeito', () => {
    const items = [
      logItem('fullscreen_unsupported', 1),
      logItem('tab_blur', 2),
      { cat: 'cmd', kind: 'shortcut', t: 3, sig: 'atalho', sev: 'low' },
      { cat: 'cmd', kind: 'clipboard', t: 4, sig: 'clipboard', sev: 'high' },
    ]
    const alerts = buildAlerts(items)
    expect(alerts.map((alert) => alert.sig)).toEqual(['fullscreen_unsupported', 'tab_blur', 'clipboard'])
    expect(suspiciousCount(alerts)).toBe(2)
    expect(isSuspiciousItem(items[0])).toBe(false)
    expect(isSuspiciousItem(items[1])).toBe(true)
    // Aluno de iPhone que não fez nada: nenhum comando suspeito.
    expect(suspiciousCount(buildAlerts([logItem('fullscreen_unsupported', 1)]))).toBe(0)
  })

  it('repetidos em sequência colapsam e somam na contagem', () => {
    const alerts = buildAlerts([logItem('tab_blur', 1), logItem('tab_blur', 2), logItem('exam_left', 3)])
    expect(alerts).toHaveLength(2)
    expect(alerts[0]).toMatchObject({ count: 2, lastT: 2 })
    expect(suspiciousCount(alerts)).toBe(3)
  })

  it('saída que escapou da confirmação aparece como saída pela navegação', () => {
    expect(examLeftLabel('Saiu da prova pela navegação')).toBe('Saiu da prova pela navegação')
    expect(focusLogLabel({ eventType: 'exam_left', details: 'Saiu da prova pelo botão voltar do navegador' })).toBe('Saiu pelo voltar do navegador')
    expect(focusLogLabel({ eventType: 'fullscreen_unsupported' })).toBe('Dispositivo sem tela cheia')
  })
})

describe('[UC-TENTATIVA-001] Monitor: volta à prova depois de recarregar e erro técnico na tela', () => {
  it('mostra em quanto tempo o aluno voltou e que a prova destravou sozinha, sem contar como suspeito', () => {
    const details = 'Recarregou ou saiu da página e voltou em 7 s (prova destravada sozinha)'
    expect(logLabel({ eventType: 'page_return', details })).toBe('Recarregou ou saiu da página e voltou em 7 s')
    expect(focusLogLabel({ eventType: 'page_return', details })).toBe('Recarregou ou saiu da página e voltou em 7 s')
    const item = logItem('page_return', 1, details)
    expect(isSuspiciousItem(item)).toBe(false)
    expect(item.badge).toBe('destravou sozinha')
    expect(buildAlerts([item])).toHaveLength(1)
    expect(suspiciousCount(buildAlerts([item]))).toBe(0)
  })

  it('erro técnico na tela da prova aparece para o professor, mas não é saída nem comando suspeito (G4)', () => {
    const item = logItem('exam_render_error', 1, 'Erro na tela da prova: x')
    expect(logLabel(item.log)).toBe('Erro técnico na tela da prova')
    expect(focusLogLabel(item.log)).toBe('Erro técnico na tela da prova')
    expect(item.pauses).toBe(false)
    expect(isSuspiciousItem(item)).toBe(false)
    expect(logLabel({ eventType: 'exam_left', details: 'Saiu da prova pela navegação' })).toBe('Saiu da prova pela navegação')
  })
})

describe('[UC-TENTATIVA-004] Monitor: ações do professor no registro do aluno (AVA-14)', () => {
  it('recolher, reabrir e ajustar o tempo aparecem com nome em português, sem contar como saída de foco', () => {
    expect(focusLogLabel({ eventType: 'attempt_collected' })).toBe('Recolhida pelo professor')
    expect(focusLogLabel({ eventType: 'attempt_reopened' })).toBe('Reaberta pelo professor')
    // Anulação por cola (A9): rótulo em português, não o eventType cru.
    expect(focusLogLabel({ eventType: 'attempt_invalidated', details: 'Tentativa anulada pelo professor (nota zero)' })).toBe('Tentativa anulada (nota zero)')
    expect(focusLogLabel({ eventType: 'attempt_invalidated', details: 'Tentativa anulada pelo professor (não conta (como se não tivesse feito))' })).toBe('Tentativa anulada (não conta)')
    expect(focusLogLabel({ eventType: 'attempt_invalidated' })).toBe('Tentativa anulada pelo professor')
    expect(focusLogLabel({ eventType: 'attempt_invalidation_undone' })).toBe('Anulação desfeita pelo professor')
    expect(logLabel({ eventType: 'attempt_invalidation_undone' })).toBe('Anulação desfeita pelo professor')
    expect(focusLogLabel({ eventType: 'time_adjusted', details: '+10 min pelo professor: Laudo de tempo extra' })).toBe('Tempo ajustado (+10 min)')
    expect(focusLogLabel({ eventType: 'time_adjusted', details: '-5 min pelo professor' })).toBe('Tempo ajustado (-5 min)')
    expect(focusLogLabel({ eventType: 'time_adjusted' })).toBe('Tempo ajustado pelo professor')
    for (const type of ['attempt_collected', 'attempt_reopened', 'attempt_invalidated', 'attempt_invalidation_undone', 'time_adjusted']) expect(LOG_INFO[type]).toBeUndefined()
  })
})

// Outro login e troca de IP durante a prova (fase 3, P3-S13: AVA-17; D28 e D29).
describe('[UC-TENTATIVA-005] Monitor: outro aparelho, troca de IP e IP repetido', () => {
  it('rótulos dos registros novos e o motivo da trava em português', () => {
    expect(focusLogLabel({ eventType: 'session_replaced' })).toBe('Entrou de outro aparelho')
    expect(focusLogLabel({ eventType: 'ip_changed' })).toBe('Mudou de endereço de rede (IP)')
    expect(logLabel({ eventType: 'ip_changed' })).toBe('Mudou de endereço de rede (IP)')
    expect(lockReasonLabel('session_replaced')).toBe('Entrou de outro aparelho')
    expect(lockReasonLabel('Saiu da aba')).toBe('Saiu da aba')
    expect(lockReasonLabel('')).toBe('')
  })

  it('troca de IP é aviso (não trava, não é suspeito); outro login trava, a não ser que a aplicação só avise', () => {
    expect(LOG_INFO.ip_changed.pauses).toBe(false)
    expect(isSuspiciousItem(logItem('ip_changed', 1))).toBe(false)
    // O outro login não é comando do aluno nem saída de foco: tem contador próprio no painel
    // (ajuste 1 do A10; antes contava em "Comandos suspeitos" e em "Saídas de foco").
    expect(isSuspiciousItem(logItem('session_replaced', 1))).toBe(false)
    expect(isDeviceChangeItem(logItem('session_replaced', 1))).toBe(true)
    expect(countsAsFocusExit(logItem('session_replaced', 1))).toBe(false)
    expect(countsAsFocusExit(logItem('tab_blur', 1))).toBe(true)
    expect(countsAsFocusExit(logItem('ip_changed', 1))).toBe(false)
    expect(buildAlerts([logItem('session_replaced', 1)])).toHaveLength(1)
    expect(suspiciousCount(buildAlerts([logItem('session_replaced', 1)]))).toBe(0)
    expect(logInfoFor({ eventType: 'session_replaced', sessionChange: { travou: true } }).pauses).toBeUndefined()
    expect(logInfoFor({ eventType: 'session_replaced', sessionChange: { travou: false } })).toMatchObject({ pauses: false, badge: 'não travou a prova' })
    expect(logInfoFor({ eventType: 'tab_blur' })).toBe(LOG_INFO.tab_blur)
    expect(logInfoFor({ eventType: 'desconhecido' })).toBeUndefined()
  })

  it('selos da linha: hora do outro login e quantas trocas de IP', () => {
    const at = new Date(2026, 10, 22, 10, 42).getTime()
    expect(sessionRowBadges({})).toEqual([])
    const badges = sessionRowBadges({ sessionReplacedCount: 1, sessionReplacedAt: at, ipChangeCount: 2, ipChangedAt: at })
    expect(badges.map((badge) => badge.text)).toEqual(['Entrou de outro aparelho às 10:42', 'Mudou de IP (2×)'])
    expect(badges.map((badge) => badge.tone)).toEqual(['danger', 'warning'])
    expect(sessionRowBadges({ ipChangeCount: 1 })[0].text).toBe('Mudou de IP')
  })

  it('o IP e o navegador de antes e de agora: no selo (título) e no painel do aluno', () => {
    const change = { ipAntes: '10.0.0.5', ipDepois: '10.0.0.9', navegadorAntes: 'Celular da Alice', navegadorDepois: 'Computador do laboratório', travou: true }
    const [replaced, ip] = sessionRowBadges({
      sessionReplacedCount: 1, sessionReplacedAt: Date.now(), lastSessionReplaced: change,
      ipChangeCount: 1, ipChangedAt: Date.now(), lastIpChange: { ipAntes: '10.0.0.9', ipDepois: '10.0.0.10', navegadorAntes: 'Computador do laboratório', navegadorDepois: 'Computador do laboratório' },
    })
    expect(replaced.title).toContain('IP: 10.0.0.5 → 10.0.0.9 · Navegador: Celular da Alice → Computador do laboratório')
    expect(replaced.title).toContain('Registro da aplicação, em Resultados')
    expect(replaced.title).not.toMatch(/histórico do aluno/)
    expect(ip.title).toContain('IP: 10.0.0.9 → 10.0.0.10 · Navegador: Computador do laboratório.')
    // Linha de antes deste ajuste (sem last*): o selo continua, sem os detalhes.
    expect(sessionRowBadges({ sessionReplacedCount: 1 })[0].title).toMatch(/^A conta entrou em outro aparelho durante esta tentativa\. Todas as entradas/)
    expect(sessionRowBadges({ sessionReplacedCount: 1, lastSessionReplaced: { ...change, saiuDaConta: true } })[0].title).toContain('Saiu da conta com a prova em andamento e entrou de novo.')

    expect(sessionChangeText({ eventType: 'session_replaced', sessionChange: change })).toBe('IP: 10.0.0.5 → 10.0.0.9 · Navegador: Celular da Alice → Computador do laboratório')
    expect(sessionChangeText({ eventType: 'session_replaced', sessionChange: { ...change, saiuDaConta: true } })).toMatch(/^Saiu da conta e entrou de novo\. IP/)
    expect(sessionChangeText({ eventType: 'ip_changed', sessionChange: { ipAntes: '1.1.1.1', ipDepois: '2.2.2.2' } })).toBe('IP: 1.1.1.1 → 2.2.2.2 · Navegador: desconhecido')
    expect(sessionChangeText({ eventType: 'tab_blur', sessionChange: change })).toBe('')
    expect(sessionChangeText({ eventType: 'session_replaced' })).toBe('')
  })

  it('"Mesmo IP de" com os nomes dos outros alunos, e nada sem a marca do servidor', () => {
    expect(sameIpLabel({ sameIpAs: [{ email: 'b@x.local', name: 'Bruno' }] })).toBe('Mesmo IP de Bruno')
    expect(sameIpLabel({ sameIpAs: [{ name: 'Bruno' }, { name: 'Carla' }] })).toBe('Mesmo IP de Bruno e Carla')
    expect(sameIpLabel({ sameIpAs: [{ email: 'sem@sem-email.invalid', name: '' }] }, (person) => person.name || 'Aluno sem e-mail')).toBe('Mesmo IP de Aluno sem e-mail')
    expect(sameIpLabel({ sameIpAs: [] })).toBe('')
    expect(sameIpLabel({})).toBe('')
  })
})
