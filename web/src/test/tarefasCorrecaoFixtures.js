// Dados de exemplo das telas de entrega e correção das tarefas (testes do C8 em
// features/admin/TarefaDetalhePage.test.jsx e features/admin/tarefas/*.test.jsx).
export const NOW = Date.UTC(2026, 10, 22, 15, 0)
export const DAY = 24 * 3600 * 1000
export const TZ = 'America/Sao_Paulo'
export const SEM_EMAIL = 'aluno-alu_0123456789abcdef@sem-email.invalid'

export function assignmentData(extra = {}) {
  return {
    id: 'asg_1_aaaaaa',
    title: 'Relatório de redes',
    status: 'publicada',
    courseId: 'DES',
    studentClass: '1DES',
    dueAt: NOW - 2 * DAY,
    closeAt: null,
    opensAt: null,
    publishedAt: 1,
    latePolicy: { mode: 'desconto', penaltyPerDayPct: 10, penaltyMaxPct: 30 },
    local: { dueDate: '2026-11-20', dueTime: '12:00', opensDate: '', opensTime: '', closeDate: '', closeTime: '' },
    counts: { alunos: 5, enviadas: 3, paraCorrigir: 2, atrasadas: 1, naoEntregues: 2, devolvidas: 0 },
    deletable: false,
    ...extra,
  }
}

export function rowData(key, extra = {}) {
  return {
    studentEmail: key,
    studentId: null,
    semEmail: false,
    name: '',
    matricula: '',
    enrolled: true,
    submissionId: null,
    status: 'nao_entregue',
    versions: 0,
    lastVersion: null,
    newVersionAfterGrade: false,
    grade: null,
    returnedAt: null,
    extension: null,
    manualEntry: null,
    ...extra,
  }
}

export function rosterData() {
  return [
    rowData('ana@x.com', { name: 'Ana Lima', matricula: '001', submissionId: 'asub_1_aaaaaa', status: 'para_corrigir', versions: 2, lastVersion: { n: 2, requestAt: NOW - DAY, late: false, lateMs: 0, filesCount: 1, bytes: 2048 } }),
    rowData(SEM_EMAIL, { name: 'Bia Reis', matricula: '002', semEmail: true, submissionId: 'asub_2_bbbbbb', status: 'para_corrigir', versions: 1, lastVersion: { n: 1, requestAt: NOW - DAY, late: true, lateMs: 1.5 * DAY, filesCount: 1, bytes: 100 } }),
    rowData('caio@x.com', { name: 'Caio Melo', submissionId: 'asub_3_cccccc', status: 'corrigida', versions: 1, lastVersion: { n: 1, requestAt: NOW - 3 * DAY, late: false, lateMs: 0, filesCount: 1, bytes: 10 }, grade: { score: 70, penaltyPct: 0, finalScore: 70, comment: 'Ok', versionGraded: 1, penaltyWaived: false } }),
    rowData('davi@x.com', { name: 'Davi Souza' }),
    rowData('eva@x.com', { name: 'Eva Rocha', submissionId: 'asub_5_eeeeee', status: 'devolvida', versions: 1, lastVersion: { n: 1, requestAt: NOW - 4 * DAY, late: false, lateMs: 0, filesCount: 0, bytes: 0 }, grade: { score: 90, penaltyPct: 0, finalScore: 90, comment: 'Ótimo', versionGraded: 1, penaltyWaived: false }, returnedAt: NOW - DAY }),
  ]
}

export function submissionData(row, extra = {}) {
  const versions = Array.from({ length: row.versions || 0 }, (_, index) => ({
    n: index + 1,
    requestAt: NOW - (row.versions - index) * DAY,
    receivedAt: NOW - (row.versions - index) * DAY,
    late: index === row.versions - 1 ? !!row.lastVersion?.late : false,
    lateMs: index === row.versions - 1 ? row.lastVersion?.lateMs || 0 : 0,
    penaltyPct: index === row.versions - 1 && row.lastVersion?.late ? 20 : 0,
    text: index === row.versions - 1 ? 'Minha resposta <b>não é HTML</b>' : '',
    link: index === row.versions - 1 ? 'https://example.com/diagrama' : '',
    bytes: 2048,
    comprovante: `CODV${index + 1}`,
    files: [{ id: `f_${index + 1}aaaaaaaaaaaa`, name: `relatório v${index + 1}.pdf`, size: 2048, mime: 'application/pdf', ext: '.pdf', category: 'pdf', comprovante: 'ABCD1234', preview: 'pdf', missing: false }],
  }))
  return {
    id: row.submissionId,
    assignmentId: 'asg_1_aaaaaa',
    studentEmail: row.studentEmail,
    semEmail: row.semEmail,
    name: row.name,
    matricula: row.matricula,
    status: row.status === 'para_corrigir' ? 'enviada' : row.status,
    instructorStatus: row.status,
    window: { dueAt: NOW - 2 * DAY, closeAt: null, individual: false },
    versions,
    grade: row.grade,
    returnedAt: row.returnedAt,
    extension: null,
    manualEntry: null,
    ...extra,
  }
}
