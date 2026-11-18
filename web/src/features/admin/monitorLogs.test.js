import { describe, expect, it } from 'vitest'
import { LOG_INFO, buildAlerts, examLeftLabel, focusLogLabel, isSuspiciousItem, logLabel, suspiciousCount } from './monitorLogs'

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
