# Matriz de rastreabilidade

| Caso | Estado | Tela principal | API/Regra | Teste automatizado |
|---|---|---|---|---|
| UC-AUTH-001 | Automatizado | `/login` | login e sessão | `student-login.spec.js` |
| UC-ADMIN-001 | Automatizado | `/admins` | RBAC administrativo | `admin-access.spec.js`, `admin-rbac-catalog.test.js` |
| UC-PROVA-001 | Automatizado | `/provas`, `/monitor`, `/aluno/prova/:key` | aplicação e submissão | `exam-flow.spec.js`, `exam-applications.test.js` |
| UC-PROVA-002 | Automatizado | `/aluno/provas` | tentativas e retomada | `exam-flow.spec.js`, `exam-attempts.test.js` |
| UC-CURSO-001 | Automatizado | `/turmas` | herança Escola → Curso → Turma | `course-management.spec.js` |
| UC-PRESENCA-001 | Automatizado | `/turmas` | disciplinas e grade horária por turma | `attendance-flow.spec.js`, `TurmaPresencaConfig.test.jsx`, `attendance-utils.test.js` |
| UC-PRESENCA-002 | Automatizado | `/chamada` | chamada por aula, justificativa, abono e frequência | `attendance-flow.spec.js`, `student-analytics.test.js`, `attendance-utils.test.js` |
| UC-LAYOUT-001 | Automatizado | login e shells | Premium/Lumen | `visual-layout.spec.js`, `branding-interface-preset.test.js` |
| UC-SEC-001 | Automatizado | arquivos | upload e path traversal | `upload-security.test.js`, `safe-path.test.js` |
| UC-SIGILO-001 | Automatizado | `/aluno/prova/:key`, `/aluno/modulos` | sigilo da prova: questões só da tentativa iniciada e da versão do aluno, gabarito nunca vai ao aluno, apostilas e estrutura só com sessão e liberação da turma | `exam-secrecy.test.js`, `ExamRunner.test.jsx` |
| UC-DASH-001 | Automatizado | `/` (Dashboard) | faixa "Agora": aula corrente, aplicação e presença online | `dashboard-aggregates.test.js` |
| UC-DASH-002 | Automatizado | `/` (Dashboard) | fila "Precisa de você" com snooze de 24h | `dashboard-aggregates.test.js` |
| UC-DASH-003 | Automatizado | `/` (Dashboard) | Pulso: janelas móveis de 30 dias, sem dado ≠ zero | `dashboard-aggregates.test.js` |
| UC-DASH-004 | Automatizado | `/` (Dashboard) | escopo de professor e permissões nas rotas /now /queue /trends | `dashboard-aggregates.test.js` |
| UC-NOTAS-001 | Automatizado | `/resultados` | lançamento manual de nota validado (0 a 10, vírgula, acertos ≤ total da turma, nota pelos acertos, nota que confere com os acertos), prévia igual ao que o servidor grava, auditoria das alterações de nota, nota inválida antiga fora das médias | `grades-gradebook.test.js`, `ResultadosPage.test.jsx`, `grades.test.js` |
| UC-NOTAS-002 | Automatizado | `/resultados` | exportação autenticada: planilha da turma (aluno × prova + média) e CSV da prova no padrão do Excel pt-BR | `grades-gradebook.test.js`, `ResultadosPage.test.jsx`, `api.test.js` |
| UC-NOTAS-003 | Automatizado | `/resultados`, `/alunos/:id` | boletim com a mesma consolidação e o mesmo arredondamento de Resultados, do quadro, das planilhas e do portal do aluno; curso ativo (seletor com o nome do curso); registro antigo sem curso só no curso da matrícula | `grades-gradebook.test.js`, `grades.test.js`, `AlunoDetailPage.test.jsx` |
| UC-NOTAS-004 | Automatizado | `/resultados` | lixeira de notas (exclusão restaurável) e registro da aplicação (criação, encerramento, anulação com motivo, troca/correção de questão e alterações de nota) | `grades-gradebook.test.js`, `ResultadosPage.test.jsx` |
| UC-CONTEUDO-001 | Adiado | apostilas/unidades | nova arquitetura pendente | sem novos testes nesta etapa |

Ao adicionar ou renomear um teste, esta matriz deve ser atualizada no mesmo conjunto de mudanças.
