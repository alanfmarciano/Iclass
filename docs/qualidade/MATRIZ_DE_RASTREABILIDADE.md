# Matriz de rastreabilidade

| Caso | Estado | Tela principal | API/Regra | Teste automatizado |
|---|---|---|---|---|
| UC-AUTH-001 | Automatizado | `/login` | login e sessão | `student-login.spec.js` |
| UC-ADMIN-001 | Automatizado | `/admins` | RBAC administrativo | `admin-access.spec.js`, `admin-rbac-catalog.test.js` |
| UC-PROVA-001 | Automatizado | `/provas`, `/monitor`, `/aluno/prova/:key` | aplicação e submissão | `exam-flow.spec.js`, `exam-applications.test.js` |
| UC-PROVA-002 | Automatizado | `/aluno/provas` | tentativas e retomada | `exam-flow.spec.js`, `exam-attempts.test.js` |
| UC-TENTATIVA-001 | Automatizado | `/aluno/prova/:key`, `/monitor` | fim do tempo, envio atrasado, pausa, encerramento, bloqueio por foco no fim do tempo, recarga e cópia local cifrada das respostas | `exam-attempt-lifecycle.test.js`, `ExamRunner.test.jsx`, `examDrafts.test.js`, `examAutoSubmit.test.js`, `attemptDelivery.test.js`, `monitorTimer.test.js`, `FinishApplicationModal.test.jsx` |
| UC-PROVA-003 | Automatizado | `/aluno/prova/:key`, `/monitor`, `/resultados` | letras da posição na versão do aluno com identificadores opacos (sem letra original no navegador) e revisão com a letra vista e a original; aparelho sem tela cheia; layout da prova sem menu do portal e confirmação ao sair pelo voltar do navegador ou por link; cabeçalho da prova no celular | `exam-answer-ids.test.js`, `ExamRunner.test.jsx`, `StudentExamShell.test.jsx`, `StudentAnswersModal.test.jsx` |
| UC-CURSO-001 | Automatizado | `/turmas` | herança Escola → Curso → Turma | `course-management.spec.js` |
| UC-PRESENCA-001 | Automatizado | `/turmas` | disciplinas e grade horária por turma | `attendance-flow.spec.js`, `TurmaPresencaConfig.test.jsx`, `attendance-utils.test.js` |
| UC-PRESENCA-002 | Automatizado | `/chamada` | chamada por aula, justificativa, abono e frequência | `attendance-flow.spec.js`, `student-analytics.test.js`, `attendance-utils.test.js` |
| UC-LAYOUT-001 | Automatizado | login e shells | Premium/Lumen | `visual-layout.spec.js`, `branding-interface-preset.test.js` |
| UC-SEC-001 | Automatizado | arquivos | upload e path traversal | `upload-security.test.js`, `safe-path.test.js` |
| UC-DASH-001 | Automatizado | `/` (Dashboard) | faixa "Agora": aula corrente, aplicação e presença online | `dashboard-aggregates.test.js` |
| UC-DASH-002 | Automatizado | `/` (Dashboard) | fila "Precisa de você" com snooze de 24h | `dashboard-aggregates.test.js` |
| UC-DASH-003 | Automatizado | `/` (Dashboard) | Pulso: janelas móveis de 30 dias, sem dado ≠ zero | `dashboard-aggregates.test.js` |
| UC-DASH-004 | Automatizado | `/` (Dashboard) | escopo de professor e permissões nas rotas /now /queue /trends | `dashboard-aggregates.test.js` |
| UC-CONTEUDO-001 | Adiado | apostilas/unidades | nova arquitetura pendente | sem novos testes nesta etapa |

Ao adicionar ou renomear um teste, esta matriz deve ser atualizada no mesmo conjunto de mudanças.
