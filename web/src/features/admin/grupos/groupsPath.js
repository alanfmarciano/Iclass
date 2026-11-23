// Endereço da tela Grupos de uma turma (fase 3, P5-S4): /turmas/<curso>/<turma>/grupos.
// Fica fora da GruposPage para Turmas e Alunos abrirem a tela sem carregar o código dela.
export function groupsPath(courseId, className) {
  return `/turmas/${encodeURIComponent(courseId)}/${encodeURIComponent(className)}/grupos`
}
