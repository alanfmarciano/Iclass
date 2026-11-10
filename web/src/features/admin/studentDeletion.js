// Texto do aviso de "Excluir aluno" (tela de Alunos e ficha do diretório). Diz exatamente
// o que a exclusão (POST /api/admin/delete-student) apaga e o que fica anônimo; se a rota
// mudar, mude aqui e a linha UC-NOTAS-004 da matriz de rastreabilidade.
export const STUDENT_DELETE_REMOVES = 'Sai de vez: o cadastro e o acesso, as entregas e as notas (das provas online e as lançadas), a presença, as observações, os certificados, o progresso e o caderno, os registros de prova e de login, as mensagens e avisos só para ele e as dúvidas e respostas dele no fórum.'
export const STUDENT_DELETE_KEEPS = 'Fica, sem nome, e-mail nem matrícula: o histórico da auditoria, as notas que já estavam na lixeira (só prova e nota), as contestações de questão e a dúvida do fórum que outra pessoa respondeu. A pasta de documentos dele vai para a lixeira de arquivos.'
export const STUDENT_DELETE_WARNING = `${STUDENT_DELETE_REMOVES} ${STUDENT_DELETE_KEEPS}`
