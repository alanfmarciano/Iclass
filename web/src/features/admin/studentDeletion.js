// Textos do ciclo de vida do cadastro do aluno (H7c; FUN-03, decisão 4 do Alan): o
// "Desligar aluno" (tela de Alunos e ficha do diretório) e as ações de Cadastros
// encerrados (/encerrados). Dizem exatamente o que cada rota faz:
// - desligar: POST /api/admin/student/bulk-status (situação + motivo);
// - anonimizar: POST /api/admin/students/anonymize (utils/studentLifecycle.js);
// - apagar de vez: POST /api/admin/students/purge (a cascata do antigo delete-student).
// Se uma rota mudar, mude aqui e as linhas UC-NOTAS-004 e UC-ENCERRADOS-* da matriz.

// Situações de cadastro encerrado que o "Desligar aluno" oferece (Inativo é o padrão).
export const CLOSE_STATUS_OPTIONS = ['Inativo', 'Transferido', 'Evadido', 'Concluído']
// Situação do cadastro anonimizado: só aparece em Cadastros encerrados, nunca no seletor.
export const ANONYMIZED_STATUS = 'Anonimizado'
export const STATUS_REASON_MAX = 500
export const LIFECYCLE_REASON_MIN = 3

export const STUDENT_CLOSE_WARNING = 'O aluno não consegue mais entrar. Notas, presença e certificados ficam guardados. Para anonimizar ou apagar, use Cadastros encerrados.'

export const STUDENT_ANONYMIZE_KEEPS = 'Ficam, com um código no lugar do nome e do e-mail: as notas, a presença (sem o texto e o arquivo das justificativas) e os certificados. A auditoria continua, sem nome, e-mail nem matrícula.'
export const STUDENT_ANONYMIZE_REMOVES = 'Saem: nome, nome social, e-mail, matrícula, telefones, responsável, acessibilidade, senha, progresso e caderno, observações, registros de prova e de login, mensagens só para ele e as dúvidas dele no fórum. O e-mail fica livre para um cadastro novo. Não dá para desfazer.'

export const STUDENT_DELETE_REMOVES = 'Sai de vez: o cadastro e o acesso, as entregas e as notas (das provas online e as lançadas), a presença, as observações, os certificados, o progresso e o caderno, os registros de prova e de login, as mensagens e avisos só para ele e as dúvidas e respostas dele no fórum.'
export const STUDENT_DELETE_KEEPS = 'Fica, sem nome, e-mail nem matrícula: o histórico da auditoria, as notas que já estavam na lixeira (só prova e nota), as contestações de questão e a dúvida do fórum que outra pessoa respondeu. A pasta de documentos dele vai para a lixeira de arquivos.'
export const STUDENT_DELETE_WARNING = `${STUDENT_DELETE_REMOVES} ${STUDENT_DELETE_KEEPS}`

// Lembrete do backup: anonimizar e apagar não mexem nos backups que já existem.
export function backupReminder(lastBackupAt) {
  const when = lastBackupAt ? new Date(lastBackupAt) : null
  const date = when && !Number.isNaN(when.getTime()) ? when.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : null
  return date
    ? `Os backups feitos antes (o último automático é de ${date}) ainda têm os dados deste aluno.`
    : 'Os backups feitos antes ainda têm os dados deste aluno.'
}

// Situação de cadastro encerrado (a mesma lista do servidor, utils/students.js), sem
// diferenciar acento nem maiúscula: "Concluido" de banco antigo também conta.
const CLOSED_KEYS = new Set([...CLOSE_STATUS_OPTIONS, ANONYMIZED_STATUS].map(foldStatus))
function foldStatus(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
}
export function isClosedStatus(status) {
  return CLOSED_KEYS.has(foldStatus(status))
}
export function isAnonymizedStatus(status) {
  return foldStatus(status) === foldStatus(ANONYMIZED_STATUS)
}
