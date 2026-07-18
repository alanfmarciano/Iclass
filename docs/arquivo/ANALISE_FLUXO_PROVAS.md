# Análise Completa do Fluxo de Provas — IclassV3

Data da análise: 14/07/2026
Escopo: backend (`backend/routes`, `backend/middlewares.js`, `backend/utils`) e frontend (`web/src/features`), cobrindo os perfis **Administrador**, **Professor** e **Aluno**.

---

## 1. Visão geral do fluxo atual (ciclo de vida)

```
AUTORIA                    CONFIGURAÇÃO/APLICAÇÃO             EXECUÇÃO (ALUNO)              CORREÇÃO/RESULTADO
─────────                  ───────────────────────            ────────────────              ──────────────────
Editor de avaliação   →    exam-config (impressa)        →    Lista de provas          →    Correção automática
(questões objetivas)       online-exam-config (online)        Token (opcional)              no servidor (submit)
Banco de questões          Histórico de aplicações            Sala de espera                Tentativas múltiplas
Duplicar avaliação         Versões A–D (embaralhadas)         Prova ativa (timer,           (highest/latest/
Migração de .md            release-item (liberar)             autosave, antifraude)         average/selected)
                           server-exam-control:               Envio manual ou               Publicação de notas
                           waiting → running →                automático (prazo)            Gabarito liberável
                           paused → finished                                                CSV / Analytics
```

Estados da prova online (`onlineExamConfigs[examKey].status`): `not_applied` → `prepared` → `waiting` → `running` → `paused` → `finished`.

---

## 2. O que está IMPLEMENTADO

### 2.1 Autoria (Admin/Professor)

| Funcionalidade | Status | Evidência |
|---|---|---|
| Editor de avaliação estruturada (título, tema, questões) | Completo | `GET/PUT /api/admin/evaluation/:key` (`admin.js:1592-1645`), `EditorPage.jsx` |
| Migração automática de provas legadas `.md` | Completo | `parseEvaluationMarkdown` (`utils/parser.js`), fallback em `admin.js:1597` e `student.js:735` |
| Duplicar avaliação | Completo | `POST /api/admin/evaluation/duplicate` (`admin.js:1646`) |
| Banco de questões (listar, criar, importar de avaliação, excluir) | Parcial | `admin.js:2579-2658` — **não há edição** de questão nem montagem de prova a partir do banco |
| Backup automático antes de salvar avaliação | Completo | `makeBackup` em `admin.js:1620` |

### 2.2 Configuração e aplicação (Admin/Professor)

| Funcionalidade | Status | Evidência |
|---|---|---|
| Config. de prova impressa por turma (nº questões, exclusões, embaralhar) | Completo | `POST /api/admin/exam-config` (`adminExamConfig.js:79`) |
| Config. de prova online (duração, timer on/off, embaralhar) | Completo | `POST /api/admin/online-exam-config` (`adminExamConfig.js:100`) |
| Histórico de aplicações (registrar, listar, excluir, reimprimir) | Completo | `adminExamConfig.js:201-266`, `ProvasPage.jsx` (admin) |
| Versões A–D com embaralhamento determinístico e código de prova | Completo | `examTools.js` (seededRandom, snapshots), `VERSION_LABELS` |
| Impressão de provas (snapshot para papel) | Completo | `printAndRegister()` em `ProvasPage.jsx:284` |
| Liberação por turma e por aluno individual | Completo | `POST /api/admin/release-item` (`adminExamConfig.js:135`), `studentReleasedItems` |
| Token de acesso (5 letras, validado só no servidor, rate-limited) | Completo | `utils/examToken.js`, `proctoring.js:259-303` |
| Sala de espera com contagem regressiva e ajuste de tempo | Completo | `waiting`/`adjust_waiting` em `admin.js:2072-2170` |
| Controle da aplicação: iniciar, pausar, retomar, encerrar | Completo | `POST /api/admin/server-exam-control` (`admin.js:2072`) |

### 2.3 Monitoramento em tempo real (Admin/Professor)

| Funcionalidade | Status | Evidência |
|---|---|---|
| Monitor da turma (online/ausente/finalizado/bloqueado, progresso, versão, IP) | Completo | `GET /api/admin/monitor-status/:class/:examKey` (`admin.js:2359`), `MonitorPage.jsx` |
| Ajuste de tempo global e individual | Completo | `POST /api/admin/adjust-student-time` (`admin.js:2173`) |
| Atribuir versão específica a um aluno | Completo | `POST /api/admin/assign-student-version` (`admin.js:2222`) |
| Bloqueio automático por perda de foco + desbloqueio pelo instrutor | Completo | `proctoring.js:9-55`, `admin.js:2249-2288` |
| Mensagens broadcast (turma/aluno) com histórico e confirmação de leitura | Completo | `admin.js:2291-2356`, `proctoring.js:187-255` |
| Logs de proctoring para auditoria | Completo | `GET /api/admin/proctoring-logs/:class/:examKey` (`proctoring.js:96`) |

### 2.4 Execução da prova (Aluno)

| Funcionalidade | Status | Evidência |
|---|---|---|
| Lista de provas liberadas + histórico de concluídas (polling 5s) | Completo | `student/ProvasPage.jsx` |
| Runner com fases: loading → token → waiting → active → paused → done | Completo | `ExamRunner.jsx` |
| Sincronização com servidor a cada 4s (estado, mensagens, versão da config) | Completo | `ExamRunner.jsx:113-168`, `GET /api/student/exam-state` |
| Autosave de respostas a cada 15s com indicador visual | Completo | `ExamRunner.jsx:89-98`, `proctoring.js:58-93` |
| Timer com prazo calculado no servidor (`deadlineAt`) e envio automático | Completo | `middlewares.js:672-726` (initializeExamState), `ExamRunner.jsx:100-111` |
| Tolerância de 30s para envio automático após o prazo | Completo | `student.js:705-709` |
| Antifraude: blur/aba oculta pausa a prova e trava no servidor | Completo | `ExamRunner.jsx:73-87`, `proctoring.js:31-47` |
| Sorteio automático de versão (estável, display-only) | Completo | `assignRandomExamVersion` (`middlewares.js:661-670`) |
| Retomada de rascunho (respostas salvas) após reconexão | Completo | `ExamRunner.jsx:127` |
| Invalidação quando o professor atualiza a prova (`examConfigVersion`) | Completo | `student.js:754-761` |

### 2.5 Correção e resultados

| Funcionalidade | Status | Evidência |
|---|---|---|
| Correção automática no servidor (nunca confia no cliente) | Completo | `POST /api/student/submit` (`student.js:663-887`) — valida turma, status, token, prazo, foco e conjunto de questões |
| Gabarito removido dos dados enviados ao aluno | Completo | `middlewares.js:153`, `sanitizeSubmissionForStudent` |
| Tentativas múltiplas com políticas de consolidação (maior/última/média/selecionada) | Completo | `utils/submissionAttempts.js`, `POST /api/admin/submissions/result-control` (`admin.js:271`) |
| Arquivar/restaurar tentativas | Completo | `admin.js:283-291` |
| Publicação/despublicação de notas (aluno só vê após publicar) | Completo | `POST /api/admin/submissions/publish` (`admin.js:410`), `ExamRunner.jsx:293-295` |
| Liberação de gabarito por turma ou aluno | Completo | `canStudentViewAnswerKey` (`middlewares.js:602`) |
| Revisão detalhada de tentativa (questão a questão, alternativas) | Completo | `GET /api/admin/submissions/:id/review` (`admin.js:318`) |
| Lançamento manual de nota (prova impressa: cartão-resposta ou nota direta) | Completo | `POST /api/admin/submissions/create` (`admin.js:456`) |
| Exportação CSV de notas (com proteção contra CSV injection) | Completo | `admin.js:2463-2505` |
| Analytics da prova (acerto por questão, dificuldade, distribuição, resumo de proctoring) | Completo | `GET /api/admin/exam-analytics/:class/:examKey` (`admin.js:2507`) |
| Média do aluno, risco e evolução no dashboard | Completo | `utils/studentAnalytics.js` |

### 2.6 Perfis e permissões

| Funcionalidade | Status | Evidência |
|---|---|---|
| Papel **professor** como conta administrativa restrita | Completo | `utils/adminPermissions.js` (permissões padrão: exams, monitor, results, materials, editor, students, forum) |
| Escopo do professor validado centralmente (turmas, cursos, itens, alunos) | Completo | `validateProfessorRequestScope` (`middlewares.js:385-451`) — cobre inclusive rotas por path (`monitor-status`, `export-grades`, `exam-analytics`, `proctoring-logs`) |
| Filtragem de submissões pelo escopo do professor | Completo | `filterSubmissionsForAdmin` (`middlewares.js:350`) |
| Banco de questões filtrado por escopo do professor | Completo | `admin.js:2581` |
| Ações exclusivas do admin (contas, exclusão definitiva, matrículas) | Completo | `ADMIN_ONLY_PERMISSION_SET`, `adminAccounts.js:14-23`, `adminArchive.js:46` |
| Guard de rotas no frontend por permissão de página | Completo | `RequireAdminPath` em `App.jsx` |

---

## 3. O que NÃO está implementado (gap analysis)

### 3.1 Crítico

**C1. Apenas questões de múltipla escolha.**
Todo o pipeline (parser, editor, runner, correção) assume alternativas A–E com uma correta (`parser.js:51`, `ExamRunner.jsx:373-385`, `student.js:798-822`). Não existem questões dissertativas, verdadeiro/falso, múltiplas corretas ou associação. O campo `rubric` é salvo na avaliação (`admin.js:1633`) mas **nunca é usado** na correção.
Sugestão: adicionar `type` por questão (`multiple_choice`, `essay`, `true_false`), fila de correção manual para dissertativas (professor atribui pontos + comentário) e status de submissão `pending_review` até a correção completa.
Impacto: Aluno (runner), Professor (correção), Admin (relatórios).

**C2. Sem limite de tentativas.**
Após o envio, o estado do aluno é apagado (`student.js:876-878`); enquanto a prova estiver `running`, o aluno pode reabri-la e gerar nova tentativa (`attemptNumber` incrementa sem teto). As políticas de consolidação existem, mas o professor não controla *quantas* tentativas são permitidas.
Sugestão: campo `maxAttempts` em `onlineExamConfigs` e bloqueio no `sync`/`submit`.

**C3. Sem nota de aprovação nem pontos por questão configuráveis.**
A nota é sempre `% de acertos` (`student.js:824`) e o corte 60/6,0 está fixo no código (`studentAnalytics.js:127`, buckets em `admin.js:2528`, badge em `student/ProvasPage.jsx`). Não há peso por questão nem valor total da prova.
Sugestão: `passingScore` e `points` por questão na avaliação, refletidos na correção, no monitor e nos relatórios.

### 3.2 Importante

**I1. Sem agendamento de prova por data/hora.**
O início é sempre manual (Monitor) ou via sala de espera em minutos. Não é possível agendar "prova dia 20/07 às 19h" com abertura/fechamento automáticos — o calendário (`announcements/calendar`) é apenas informativo.

**I2. Sem notificação ao aluno na publicação de notas ou liberação de prova.**
A publicação (`submissions/publish`) não gera aviso; o aluno depende do polling da página de provas. Integrar com o sistema de avisos existente (`announcements`) seria de baixo custo.

**I3. Banco de questões incompleto.**
Não há: edição de questão, metadados (dificuldade, tags além de categoria), busca, nem **montagem de avaliação a partir do banco** (o fluxo hoje é só avaliação → banco, não o inverso).

**I4. Sem sorteio de questões por aluno.**
O conjunto de questões é fixado por versão (A–D). Não há modo "sortear N questões do banco por aluno", útil contra cola em provas online.

**I5. Recuperação/segunda chamada sem fluxo formal.**
É possível liberar a prova para um aluno individual (`studentReleasedItems`), mas não há conceito de "reaplicação" com registro próprio — a nova tentativa se mistura com as anteriores na mesma política de consolidação.

**I6. Sem trilha de auditoria completa de notas.**
`publish` grava `gradePublishedBy/At`, mas o lançamento manual (`submissions/create`) não registra **qual admin/professor** lançou, e edições de política/arquivamento não geram histórico consultável.

**I7. Boletim consolidado inexistente.**
Existe média geral por aluno (`studentAnalytics.js`), mas não há boletim por curso (nota de cada avaliação × peso → média final, situação aprovado/reprovado) nem exportação em PDF — apenas CSV por prova.

### 3.3 Desejável

**D1. Antifraude limitado a perda de foco.** Não há: fullscreen obrigatório, bloqueio/registro de copiar-colar, detecção de DevTools, restrição por IP/dispositivo, foto/webcam. O modelo atual (blur → trava servidor) é bom, mas pode ser contornado com segundo dispositivo.

**D2. UX do runner.** Faltam: tela de instruções antes de iniciar, confirmação antes do envio manual (o botão envia direto, `ExamRunner.jsx:362`), painel de navegação entre questões, marcar questão para revisão e alerta visual de questões em branco.

**D3. Feedback qualitativo ao aluno.** Não há comentário do professor por questão ou por tentativa — o retorno se resume a nota + gabarito.

**D4. Estatísticas comparativas.** O analytics é por prova/turma; faltam comparativos entre turmas/versões e histórico de desempenho da mesma avaliação ao longo do tempo.

**D5. Persistência em JSON + memória.** Submissões e estado de prova vivem em arquivos JSON gravados de forma síncrona (`writeJSON`), com risco de corrida em aplicações simultâneas grandes. Para o porte atual funciona; vale documentar o limite.

---

## 4. Priorização sugerida de implementação

| # | Item | Criticidade | Esforço estimado | Perfis beneficiados |
|---|---|---|---|---|
| 1 | Limite de tentativas (`maxAttempts`) | Crítico | Baixo | Professor, Aluno |
| 2 | Nota de aprovação e pontos por questão | Crítico | Médio | Todos |
| 3 | Questões dissertativas + correção manual | Crítico | Alto | Todos |
| 4 | Notificação de nota publicada / prova liberada | Importante | Baixo | Aluno |
| 5 | Agendamento de prova por data/hora | Importante | Médio | Professor, Aluno |
| 6 | Auditoria de lançamentos manuais (quem lançou) | Importante | Baixo | Admin |
| 7 | Montar prova a partir do banco de questões + edição de questões | Importante | Médio | Professor |
| 8 | Fluxo formal de recuperação/segunda chamada | Importante | Médio | Todos |
| 9 | Boletim consolidado por curso (com PDF) | Importante | Médio | Todos |
| 10 | Confirmação de envio + navegação de questões no runner | Desejável | Baixo | Aluno |
| 11 | Sorteio de questões por aluno | Desejável | Médio | Professor |
| 12 | Fullscreen obrigatório + log de copiar/colar | Desejável | Médio | Professor |
| 13 | Feedback do professor por questão/tentativa | Desejável | Médio | Aluno |

---

## 5. Arquivos analisados

Backend: `routes/admin.js`, `routes/adminExamConfig.js`, `routes/proctoring.js`, `routes/student.js`, `routes/adminAccounts.js`, `routes/adminArchive.js`, `routes/common.js`, `middlewares.js`, `utils/examToken.js`, `utils/submissionAttempts.js`, `utils/studentAnalytics.js`, `utils/adminPermissions.js`, `utils/parser.js`.
Frontend: `features/admin/ProvasPage.jsx`, `MonitorPage.jsx`, `ResultadosPage.jsx`, `EditorPage.jsx`, `examTools.js`, `features/student/ProvasPage.jsx`, `exam/ExamRunner.jsx`, `exam/examUtils.js`, `App.jsx`.
