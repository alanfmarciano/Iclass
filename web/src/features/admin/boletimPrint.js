// Boletim do aluno para impressão (o usuário salva como PDF pela caixa de impressão).
// Mesmo padrão de gradePrint.js: HTML próprio + window.print, sem dependências.

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
}

const grade = (value) => value == null ? '—' : Number(value).toFixed(1).replace('.', ',')
const pct = (value) => value == null ? '—' : `${value}%`
const date = (value) => value ? new Date(value).toLocaleDateString('pt-BR') : '—'

export function boletimHtml(report) {
  const student = report.student || {}
  const name = (student.nomeSocial && student.nomeSocial.trim()) || student.name || student.email
  const attendance = report.attendance || {}
  const frequencyClass = attendance.frequency == null ? '' : (attendance.frequency < (attendance.riskThreshold || 75) ? ' class="risk"' : '')

  const moduleRows = (report.modules || []).map(module => {
    const exams = module.exams.length
      ? module.exams.map(exam => `<tr>
          <td>${escapeHtml(exam.title)}</td>
          <td class="num">${exam.attempts || 0}${exam.pendingAttempts ? ` <small>(+${exam.pendingAttempts} a publicar)</small>` : ''}</td>
          <td class="num">${date(exam.lastAt)}</td>
          <td class="num grade${exam.grade != null && exam.grade < 6 ? ' low' : ''}">${grade(exam.grade)}</td>
        </tr>`).join('')
      : '<tr><td colspan="4" class="empty">Nenhuma avaliação neste módulo.</td></tr>'
    return `<tr class="module"><th colspan="3">${escapeHtml(module.name)}</th><th class="num">Média ${grade(module.average)}</th></tr>${exams}`
  }).join('')

  const disciplineRows = (attendance.disciplines || []).length
    ? attendance.disciplines.map(d => `<tr><td>${escapeHtml(d.name)}</td><td class="num">${d.presentes}</td><td class="num">${d.faltas}</td><td class="num">${pct(d.frequencia)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">Nenhuma aula lançada.</td></tr>'

  const title = `Boletim — ${name}`
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
    *{box-sizing:border-box} body{font-family:Arial,Helvetica,sans-serif;color:#171a21;margin:0;background:#fff}
    .wrap{padding:32px 38px;max-width:900px;margin:0 auto}
    header{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;border-bottom:2px solid #182033;padding-bottom:14px;margin-bottom:18px}
    header h1{font-size:22px;margin:0 0 4px} header p{margin:0;color:#596273;font-size:13px}
    .inst{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#596273;text-align:right}
    .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:0 0 20px}
    .kpi{border:1px solid #d7dbe3;border-radius:8px;padding:10px 12px}
    .kpi span{display:block;font-size:11px;color:#596273;text-transform:uppercase;letter-spacing:.04em}
    .kpi strong{display:block;font-size:22px;margin-top:4px}
    .kpi strong.risk{color:#cf3943}
    h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:#182033;margin:22px 0 8px}
    table{border-collapse:collapse;width:100%;font-size:13px}
    th,td{border:1px solid #d7dbe3;padding:7px 10px;text-align:left;vertical-align:middle}
    thead th{background:#182033;color:#fff;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
    tr.module th{background:#eef1f6;color:#182033;font-size:12px}
    td.num,th.num{text-align:right;white-space:nowrap}
    td.grade{font-weight:700} td.low{color:#cf3943}
    td.empty{color:#8790a0;text-align:center}
    small{color:#8790a0;font-weight:400}
    footer{margin-top:26px;display:flex;justify-content:space-between;color:#8790a0;font-size:11px}
    .sign{margin-top:42px;display:grid;grid-template-columns:1fr 1fr;gap:40px}
    .sign div{border-top:1px solid #182033;padding-top:6px;text-align:center;font-size:12px;color:#596273}
    @media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}.wrap{padding:0}}
  </style></head><body><div class="wrap">
    <header>
      <div>
        <h1>${escapeHtml(name)}</h1>
        <p>${escapeHtml(report.course?.name || '')}${report.className ? ` · Turma ${escapeHtml(report.className)}` : ''}${report.period ? ` · ${escapeHtml(report.period)}` : ''}</p>
        <p>${student.matricula ? `Matrícula ${escapeHtml(student.matricula)} · ` : ''}${escapeHtml(student.email || '')}</p>
      </div>
      <div class="inst">${escapeHtml(report.institution || 'IClass')}<br><span style="text-transform:none;letter-spacing:0">Boletim emitido em ${date(report.generatedAt)}</span></div>
    </header>
    <div class="kpis">
      <div class="kpi"><span>Média geral</span><strong>${grade(report.overallAverage)}</strong></div>
      <div class="kpi"><span>Frequência</span><strong${frequencyClass}>${pct(attendance.frequency)}</strong></div>
      <div class="kpi"><span>Faltas (aulas)</span><strong>${attendance.faltas ?? 0}</strong></div>
      <div class="kpi"><span>Tópicos concluídos</span><strong>${report.progress?.completedUnits ?? 0}/${report.progress?.totalUnits ?? 0}</strong></div>
    </div>
    <h2>Avaliações</h2>
    <table><thead><tr><th>Avaliação</th><th class="num">Tentativas</th><th class="num">Última</th><th class="num">Nota</th></tr></thead><tbody>${moduleRows || '<tr><td colspan="4" class="empty">Curso sem avaliações.</td></tr>'}</tbody></table>
    <h2>Frequência por disciplina</h2>
    <table><thead><tr><th>Disciplina</th><th class="num">Presenças</th><th class="num">Faltas</th><th class="num">Frequência</th></tr></thead><tbody>${disciplineRows}</tbody></table>
    <p style="font-size:11px;color:#8790a0;margin-top:8px">Só notas publicadas entram na média. Faltas abonadas não contam. ${attendance.days ? `${attendance.days} dia(s) com registro de presença.` : ''}</p>
    <div class="sign"><div>${escapeHtml(report.issuedBy || 'Instrutor')}</div><div>Responsável pelo aluno</div></div>
    <footer><span>${escapeHtml(report.institution || 'IClass')} · ${escapeHtml(report.course?.name || '')}</span><span>Gerado pelo IClass</span></footer>
  </div></body></html>`
}

// Abre a janela de impressão com o boletim. Retorna false se o pop-up foi bloqueado.
export function printBoletim(report) {
  const win = window.open('', '_blank')
  if (!win) return false
  win.document.write(boletimHtml(report))
  win.document.close()
  win.onload = () => setTimeout(() => win.print(), 300)
  return true
}
