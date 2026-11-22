// Perfil do aluno guardado no navegador (H5b; SEG-10, SEG-16).
//
// O login do aluno devolvia o cadastro inteiro (responsável, telefones, acessibilidade...)
// e o portal guardava tudo em localStorage ('iclass-v3-auth'). O servidor agora manda só
// estes campos (backend/utils/studentProfile.js, mesma lista); aqui o portal reduz também
// o que já estava guardado de uma versão anterior, ao abrir. A matrícula fica fora: Minha
// conta a lê na hora (GET /api/student/account).
export const STUDENT_SESSION_PROFILE_FIELDS = Object.freeze([
  'email',
  'name',
  'nomeSocial',
  'status',
  'studentClass',
  'period',
  'classes',
  'courses',
  'courseId',
  'currentCourseId',
  'enrollmentRequests',
  'mustChangePassword',
  'passwordChangeReason',
])

export function studentSessionProfile(student) {
  const profile = {}
  if (!student || typeof student !== 'object') return profile
  for (const field of STUDENT_SESSION_PROFILE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(student, field) && student[field] !== undefined) profile[field] = student[field]
  }
  return profile
}

// Sessão guardada com o perfil reduzido (só a do aluno muda). Devolve o mesmo objeto
// quando não há nada a tirar, para não regravar à toa.
export function reduceStoredStudentAuth(auth) {
  if (!auth || auth.role !== 'student' || !auth.student || typeof auth.student !== 'object') return auth
  const extra = Object.keys(auth.student).some((key) => !STUDENT_SESSION_PROFILE_FIELDS.includes(key))
  if (!extra) return auth
  return { ...auth, student: studentSessionProfile(auth.student) }
}

// Aluno sem e-mail (fase 3, C1 / P4-S3, D23): o cadastro guarda o endereço interno
// 'aluno-<id>@sem-email.invalid' (backend/utils/studentIdentity.js), que nunca aparece:
// a tela, os CSV e as impressões mostram 'sem e-mail'. O endereço interno continua sendo
// o que a tela manda nas rotas (é a chave do cadastro).
export const NO_EMAIL_LABEL = 'sem e-mail'
const PLACEHOLDER_EMAIL = /@sem-email\.invalid$/i

export function isPlaceholderEmail(email) {
  return typeof email === 'string' && PLACEHOLDER_EMAIL.test(email.trim())
}

// O e-mail para mostrar: o do cadastro ou 'sem e-mail'. Aceita o e-mail ou o aluno.
export function displayEmail(studentOrEmail) {
  const email = typeof studentOrEmail === 'string' ? studentOrEmail : (studentOrEmail && studentOrEmail.email) || ''
  return isPlaceholderEmail(email) ? NO_EMAIL_LABEL : email
}

// Endereço da ficha do aluno no painel: pelo id estável (/alunos/alu_...); cadastro sem
// id (dado de antes da atualização, ainda não carregado de novo) cai no e-mail, que a
// ficha aceita e troca pelo id.
export function studentRouteKey(student) {
  if (!student) return ''
  if (typeof student.id === 'string' && student.id) return student.id
  return encodeURIComponent(student.email || '')
}

// O parâmetro da rota é um id de aluno ou o e-mail do formato antigo (/diretorio/<e-mail>)?
export function isStudentIdParam(value) {
  return typeof value === 'string' && /^alu_[0-9a-f]{16}$/i.test(value)
}

// Formulário do cadastro (Alunos da turma e Diretório). O cadastro sem e-mail abre com a
// caixa "O aluno não tem e-mail" marcada e o campo de e-mail vazio; originalEmail guarda o
// endereço interno, que é a chave do cadastro na rota de alteração.
export function studentFormIdentity(student) {
  const email = (student && student.email) || ''
  const semEmail = isPlaceholderEmail(email)
  return { semEmail, email: semEmail ? '' : email, originalEmail: email }
}

// O que vai no corpo de create/update: com a caixa marcada, e-mail vazio e semEmail.
export function studentIdentityPayload(form) {
  const semEmail = !!(form && form.semEmail)
  return { email: semEmail ? '' : ((form && form.email) || ''), semEmail }
}

// Conferência antes de salvar (o servidor confere de novo). Devolve a mensagem ou ''.
export function studentFormProblem(form) {
  if (!form || !String(form.name || '').trim()) return 'Informe o nome do aluno.'
  if (form.semEmail) {
    if (!String(form.matricula || '').trim()) return 'Para aluno sem e-mail, informe a matrícula.'
  } else if (!String(form.email || '').trim()) {
    return 'Informe o e-mail do aluno ou marque "O aluno não tem e-mail".'
  }
  if (!Array.isArray(form.classes) || form.classes.length === 0) return 'Escolha ao menos uma turma.'
  return ''
}

// O login que o aluno usa (aviso da senha temporária): sem e-mail, a matrícula.
export function studentLoginLabel(form) {
  if (form && (form.semEmail || isPlaceholderEmail(form.email))) {
    const matricula = String(form.matricula || '').trim()
    return matricula ? `Matrícula ${matricula}` : NO_EMAIL_LABEL
  }
  return (form && form.email) || ''
}
