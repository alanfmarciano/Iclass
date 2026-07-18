// Impressão da grade horária semanal (o usuário salva como PDF pela caixa de impressão).
// Segue o padrão do projeto (window.print + @media print), sem dependências externas.

const WD_PRINT = [
  { key: '1', label: 'Segunda' },
  { key: '2', label: 'Terça' },
  { key: '3', label: 'Quarta' },
  { key: '4', label: 'Quinta' },
  { key: '5', label: 'Sexta' },
  { key: '6', label: 'Sábado' },
  { key: '0', label: 'Domingo' },
]

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
}

// Monta o HTML da grade a partir do attendanceConfig e da lista de disciplinas do curso.
export function gradePrintHtml({ courseName, turmaName, attendanceConfig, disciplinas }) {
  const grade = (attendanceConfig && attendanceConfig.grade) || {}
  const discById = new Map((disciplinas || []).map(d => [String(d.id).toUpperCase(), d]))
  const activeDays = WD_PRINT.filter(d => Array.isArray(grade[d.key]) && grade[d.key].length)

  // Linhas = união das ordens presentes; horário exibido é o início da 1ª ocorrência daquela ordem.
  const maxOrdem = activeDays.reduce((max, d) => Math.max(max, ...grade[d.key].map(a => a.ordem || 0)), 0)
  const inicioPorOrdem = {}
  activeDays.forEach(d => grade[d.key].forEach(a => { if (a.inicio && !inicioPorOrdem[a.ordem]) inicioPorOrdem[a.ordem] = a.inicio }))

  const cell = (dayKey, ordem) => {
    const aula = (grade[dayKey] || []).find(a => a.ordem === ordem)
    if (!aula) return '<td class="empty">—</td>'
    const disc = discById.get(String(aula.disciplinaId || '').toUpperCase())
    const nome = disc ? disc.nome : (aula.disciplinaId || '—')
    const cor = disc && /^#[0-9a-fA-F]{6}$/.test(disc.cor || '') ? disc.cor : '#8790a0'
    return `<td><span class="dot" style="background:${cor}"></span>${escapeHtml(nome)}</td>`
  }

  const rows = []
  for (let ordem = 1; ordem <= maxOrdem; ordem++) {
    rows.push(`<tr><th class="time">${escapeHtml(inicioPorOrdem[ordem] || `${ordem}ª`)}</th>${activeDays.map(d => cell(d.key, ordem)).join('')}</tr>`)
  }

  const title = `Grade horária — ${turmaName || ''}`
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
    *{box-sizing:border-box} body{font-family:Arial,Helvetica,sans-serif;color:#171a21;margin:0;background:#fff}
    .wrap{padding:32px 38px}
    header{margin-bottom:18px} header h1{font-size:20px;margin:0 0 2px} header p{margin:0;color:#596273;font-size:13px}
    table{border-collapse:collapse;width:100%;font-size:13px}
    th,td{border:1px solid #d7dbe3;padding:8px 10px;text-align:left;vertical-align:middle}
    thead th{background:#182033;color:#fff;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
    th.time{background:#eef1f6;color:#596273;font-weight:700;white-space:nowrap;width:78px;font-size:12px}
    td.empty{color:#aab;text-align:center}
    .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;vertical-align:baseline}
    footer{margin-top:16px;color:#8790a0;font-size:11px}
    @media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}.wrap{padding:0}}
  </style></head><body><div class="wrap">
    <header><h1>${escapeHtml(turmaName || 'Turma')}</h1><p>${escapeHtml(courseName || '')} · Grade horária semanal</p></header>
    ${activeDays.length
      ? `<table><thead><tr><th class="time">Horário</th>${activeDays.map(d => `<th>${d.label}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`
      : '<p>Nenhum dia letivo configurado.</p>'}
    <footer>Gerado pelo assistente de horários.</footer>
  </div></body></html>`
}

// Abre a janela de impressão com a grade. Retorna false se o pop-up foi bloqueado.
export function printGrade(params) {
  const win = window.open('', '_blank')
  if (!win) return false
  win.document.write(gradePrintHtml(params))
  win.document.close()
  win.onload = () => setTimeout(() => win.print(), 300)
  return true
}
