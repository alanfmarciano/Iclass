# Plano de correção e estabilização — fluxo de provas

> **Status em 14/07/2026: IMPLEMENTADO E VALIDADO.** As fases deste plano foram executadas no backend e na interface. A validação final passou em 30 testes de backend, 3 testes web, build de produção e 4 testes E2E, além da conferência manual no navegador dos perfis professor e aluno.

## Resultado da execução

- aplicações passaram a ter `applicationId` imutável e ciclo de vida próprio;
- tentativas, autosave, foco, mensagens, monitor e resultados são isolados por aplicação;
- preparar não inicia o cronômetro; o aluno confirma as instruções antes da tentativa;
- saída, retomada, bloqueio de foco, desbloqueio pelo professor, limite de tentativas e reaplicação foram validados;
- provas e questões podem ser criadas, editadas, reordenadas, duplicadas e reutilizadas pelo banco de questões;
- tokens são armazenados com hash e exibidos ao professor somente no contexto da preparação;
- o teste E2E completo está em `test/e2e/exam-flow.spec.js`.

**Data:** 14/07/2026  
**Base:** `ESPECIFICACAO_UI_PROVAS.md`, `PLANO_IMPLEMENTACAO_PROVAS.md` e `RELATORIO_TESTE_MANUAL_FLUXO_PROVAS_2026-07-14.md`  
**Objetivo:** corrigir os 11 problemas encontrados no teste manual e estabelecer uma base segura para continuar as melhorias P1–P21.

## 1. Direção técnica

O problema central é estrutural. Atualmente:

- a configuração ativa fica em `class.onlineExamConfigs[examKey]`;
- o estado do aluno usa a chave `${studentEmail}_${examKey}`;
- monitor, logs e resultados procuram dados por turma + `examKey`;
- uma nova aplicação da mesma prova sobrescreve configuração, mas reutiliza entregas e eventos anteriores.

A correção é introduzir uma entidade `ExamApplication` com `applicationId` imutável. Toda tentativa, estado, entrega, evento de foco, mensagem e operação do monitor deve estar associada a essa aplicação.

### Modelo-alvo

#### `ExamApplication`

```js
{
  id: 'app_<uuid>',
  examKey,
  courseId,
  studentClass,
  historyId,
  status: 'draft|prepared|waiting|running|paused|finished|cancelled',
  timerMode: 'collective|per_attempt',
  durationMinutes,
  waitingRoomMinutes,
  startsAt,
  endsAt,
  maxAttempts,
  accessTokenHash,
  versionSnapshots,
  globalTimeAdjustment,
  createdAt,
  createdBy,
  startedAt,
  finishedAt
}
```

#### `StudentAttemptState`

```js
{
  id: 'attempt_<uuid>',
  applicationId,
  studentEmail,
  attemptNumber,
  status: 'instructions|active|focus_locked|submitted|expired|invalidated',
  answers,
  assignedVersion,
  assignedQuestionNumbers,
  tokenValidatedAt,
  startedAt,
  deadlineAt,
  savedAt,
  individualTimeAdjustment
}
```

#### Campos obrigatórios nas entidades existentes

- `submissions`: adicionar `applicationId` e `attemptId`.
- `proctoringLogs`: adicionar `applicationId` e `attemptId`.
- `broadcastMessages`: adicionar `applicationId` quando a mensagem pertence a uma prova.
- histórico de aplicação: manter `historyId` como snapshot de montagem, não como identidade de execução.

### Regra de tentativas

`maxAttempts` passa a valer por `applicationId`. Uma nova aplicação começa com tentativa 1, sem consumir entregas de aplicações anteriores. Recuperação ou segunda chamada devem ser aplicações próprias ou autorizações explícitas ligadas à aplicação original.

### Regra de tempo

O professor deverá escolher:

- `collective`: todos encerram no mesmo horário; a tela de instruções mostra a hora final;
- `per_attempt`: cada aluno recebe a duração integral após clicar em “Iniciar prova”.

Para preservar o comportamento atual, a migração pode assumir `collective`, mas a interface precisa deixar a regra explícita.

## 2. Fases de implementação

## Fase 0 — Baseline, contratos e proteção de dados

**Estimativa:** 1–2 dias  
**Resolve:** preparação para P-001 e redução de risco de regressão

### Tarefas

1. Criar fixtures determinísticas com duas aplicações da mesma prova e dois alunos.
2. Registrar o comportamento atual em testes que demonstrem a mistura de dados.
3. Adicionar backup automático antes da migração de dados.
4. Definir versão do schema, por exemplo `examApplicationSchemaVersion: 1`.
5. Documentar os contratos de aplicação, tentativa e entrega.

### Testes iniciais obrigatórios

- aplicação B da mesma prova começa sem estados, entregas ou alertas da aplicação A;
- finalizar A não altera B;
- a tentativa de um aluno não altera o estado de outro;
- submissão sem `applicationId` é rejeitada nas rotas novas.

### Critério de aceite

Existe uma suíte vermelha que reproduz P-001 e um backup restaurável dos dados legados.

## Fase 1 — Entidade de aplicação e migração do backend

**Estimativa:** 4–6 dias  
**Resolve:** P-001 e base de P-003, P-005, P-010 e P-011

### Persistência

1. Adicionar tabela key/value `exam_applications` em `backend/database.js`.
2. Adicionar coleção `examApplications` em `db.memory` e sincronização no `db.save()`.
3. Alterar `student_exam_state` para chaves por `applicationId + studentEmail + attemptNumber`.
4. Criar utilitários:
   - `createExamApplication`;
   - `getExamApplication`;
   - `findActiveApplications`;
   - `transitionApplicationStatus`;
   - `getOrCreateAttemptState`;
   - `countApplicationAttempts`.
5. Garantir no máximo uma aplicação ativa para a mesma turma + prova, salvo decisão explícita de permitir paralelismo.

### Migração

1. Entregas antigas recebem `applicationId: null` e ficam classificadas como histórico legado.
2. Estados transitórios antigos `${email}_${examKey}` não são vinculados automaticamente a uma nova aplicação; são arquivados ou descartados após backup.
3. Configurações antigas em `onlineExamConfigs[examKey]` são convertidas apenas se estiverem ativas no momento da migração; caso contrário permanecem como último preset.
4. Monitor ao vivo nunca considera registros com `applicationId: null`.

### Arquivos principais

- `backend/database.js`
- `backend/middlewares.js`
- novo `backend/utils/examApplications.js`
- `backend/utils/examAttempts.js`
- `backend/routes/adminExamConfig.js`

### Critério de aceite

Duas aplicações consecutivas de `Avaliacao_FUTEC_1` possuem IDs, estados, relógios e contadores independentes.

## Fase 2 — APIs orientadas a `applicationId`

**Estimativa:** 3–5 dias  
**Resolve:** P-001 no monitor, resultados e runner

### Rotas administrativas

Implementar rotas novas e manter adaptadores legados temporários:

- `POST /api/admin/exam-applications` — preparar uma aplicação;
- `GET /api/admin/exam-applications` — listar por turma, prova e status;
- `GET /api/admin/exam-applications/:applicationId`;
- `POST /api/admin/exam-applications/:applicationId/control`;
- `POST /api/admin/exam-applications/:applicationId/time-adjustment`;
- `GET /api/admin/exam-applications/:applicationId/monitor`;
- `GET /api/admin/exam-applications/:applicationId/analytics`.

### Rotas do aluno

- `GET /api/student/exam-applications` — listar aplicações liberadas;
- `GET /api/student/exam-applications/:applicationId/sync`;
- `POST /api/student/exam-applications/:applicationId/validate-token`;
- `POST /api/student/exam-applications/:applicationId/start-attempt`;
- `POST /api/student/attempts/:attemptId/autosave`;
- `POST /api/student/attempts/:attemptId/activity`;
- `POST /api/student/attempts/:attemptId/submit`.

### Regras do servidor

1. Não confiar em `examKey`, turma, e-mail ou tentativa enviados pelo cliente quando eles puderem ser obtidos pelo ID.
2. Validar que o aluno pertence à turma da aplicação.
3. Validar status e janela de tempo antes de iniciar, salvar ou enviar.
4. Tornar o envio idempotente por `attemptId`; duplo clique deve devolver a mesma submissão.
5. Filtrar monitor, analytics, mensagens e logs por `applicationId`.

### Arquivos principais

- `backend/routes/adminExamConfig.js`
- `backend/routes/admin.js`
- `backend/routes/student.js`
- `backend/routes/proctoring.js`
- `backend/middlewares.js`

### Critério de aceite

Nenhuma rota de execução nova consulta submissões ou logs apenas por `examKey`.

## Fase 3 — Ciclo de vida, configuração e histórico

**Estimativa:** 2–3 dias  
**Resolve:** P-003, P-005, P-010 e P-011

### Tarefas

1. Separar “Salvar preset” de “Preparar aplicação”.
2. Salvar preset não marca questão como utilizada.
3. Marcar questão como utilizada apenas quando a aplicação transitar para `running`, ou conforme regra pedagógica definida.
4. Recarregar o último preset salvo no formulário do professor.
5. Exibir aplicação atual e aplicações anteriores separadamente.
6. Aplicar transições válidas:
   - `draft -> prepared`;
   - `prepared -> waiting|running`;
   - `waiting -> running|cancelled`;
   - `running -> paused|finished`;
   - `paused -> running|finished`.
7. Rejeitar transições inválidas no backend.
8. Fazer “Preparar agora” criar a aplicação sem necessariamente iniciar o cronômetro.

### Interface do professor

Em `admin/ProvasPage.jsx`:

- botão “Salvar como preset”;
- botão “Preparar aplicação”;
- resumo final com turma, prova, versões, duração, tentativas, política de relógio e token;
- indicação clara do `applicationId` em detalhes técnicos/auditoria;
- carregamento do preset persistido ao revisitar a prova.

### Critério de aceite

Salvar um preset não altera uso das questões, não inicia relógio e não aparece como entrega ou aplicação em andamento.

## Fase 4 — Monitor e resultados por aplicação

**Estimativa:** 3–4 dias  
**Resolve:** P-001 e P-008

### Monitor

1. O seletor passa a mostrar aplicação, data, turma e status, não somente `examKey`.
2. Buscar os alunos em `/exam-applications/:id/monitor`.
3. Contadores iniciam zerados em uma aplicação nova.
4. Exibir tentativa atual, horário de início, prazo individual/coletivo e eventos de foco.
5. Adicionar confirmação para finalizar, contendo:
   - prova e turma;
   - quantidade online;
   - quantidade ainda não entregue;
   - efeito da finalização.
6. Finalização deve ser idempotente e registrar auditoria.

### Resultados

1. Adicionar filtro obrigatório/opcional por aplicação.
2. Mostrar separadamente “Aplicação atual” e “Histórico da prova”.
3. Contadores de entregas usam `applicationId`.
4. Publicação pode ser feita por aplicação ou por submissões selecionadas.
5. Exportações CSV/PDF incluem `applicationId`, data da aplicação e tentativa.

### Arquivos principais

- `web/src/features/admin/MonitorPage.jsx`
- `web/src/features/admin/ResultadosPage.jsx`
- `backend/routes/admin.js`

### Critério de aceite

Uma aplicação nova apresenta 0 iniciados e 0 entregues até os alunos realmente acessarem e enviarem essa aplicação.

## Fase 5 — Runner seguro e política de tempo

**Estimativa:** 3–5 dias  
**Resolve:** P-004, P-005, P-006, P-007 e P-009

### Tela de instruções

Adicionar fase `instructions` em `ExamRunner.jsx` depois do token e antes do início:

- nome da prova;
- duração e política de relógio;
- tentativa atual e limite;
- quantidade de questões;
- regras de foco e envio;
- horário final no modo coletivo;
- botão “Iniciar prova”.

O botão chama `start-attempt`; somente o servidor define `startedAt` e `deadlineAt`.

### Confirmações

1. Ao sair da prova ativa, abrir modal informando se o tempo continuará contando.
2. Interceptar navegação interna e `beforeunload` quando possível.
3. Ao entregar, mostrar:
   - respondidas;
   - em branco;
   - tempo restante;
   - aviso de irreversibilidade.
4. Impedir envio duplicado por interface e backend.

### Foco e proctoring

1. Enviar `applicationId` e `attemptId` em todos os eventos.
2. Não depender apenas de `window.blur`; combinar `visibilitychange`, `pagehide` e retorno à página.
3. Deduplicar eventos produzidos quase simultaneamente.
4. Salvar as respostas antes ou junto do evento de saída.
5. Aplicar política configurável:
   - apenas registrar;
   - avisar;
   - bloquear até liberação do professor.
6. Ao retornar, registrar `tab_focus`/`exam_return` e manter o bloqueio se essa for a política.

### Arquivos principais

- `web/src/features/student/exam/ExamRunner.jsx`
- `web/src/features/student/ProvasPage.jsx`
- `backend/routes/student.js`
- `backend/routes/proctoring.js`
- `backend/middlewares.js`

### Critério de aceite

O aluno não perde tempo antes do evento correto, não sai nem envia sem confirmação e toda perda de foco aparece no monitor da aplicação correta.

## Fase 6 — Autoria completa de provas e questões

**Estimativa:** 4–6 dias  
**Resolve:** P-002 e entrega P7 do plano existente

O backend já possui leitura e atualização de avaliações, duplicação e operações parciais do banco de questões. A maior lacuna está na interface e na validação dos contratos.

### Backend

1. Criar rota explícita de nova avaliação ou formalizar criação vinculada a módulo/unidade.
2. Adicionar atualização de questão no banco central.
3. Validar tipos, enunciado, alternativas, resposta correta e vínculo ao curso.
4. Bloquear alteração destrutiva de uma avaliação já usada sem criar nova revisão.
5. Versionar a avaliação; aplicações mantêm snapshot imutável.

### Frontend

Criar modo “Avaliação” no editor ou uma página própria com:

- nova prova;
- título, tema e instruções;
- adicionar, editar, duplicar, remover e reordenar questões;
- edição de alternativas e resposta correta;
- importação do banco de questões;
- visualização prévia;
- validação antes de salvar;
- confirmação ao excluir.

### Arquivos principais

- `web/src/features/admin/EditorPage.jsx` ou nova `ExamEditorPage.jsx`
- `web/src/features/admin/ProvasPage.jsx`
- `backend/routes/admin.js`

### Critério de aceite

Um professor cria uma prova do zero, adiciona quatro questões, edita uma delas, salva, monta a aplicação e a disponibiliza sem manipulação externa de arquivos ou banco.

## Fase 7 — Migração final, regressão e liberação

**Estimativa:** 2–3 dias  
**Resolve:** fechamento de todos os itens

### Testes backend

- isolamento entre duas aplicações da mesma prova;
- limite de tentativas por aplicação;
- tentativa nova com respostas vazias;
- autosave, retorno e expiração;
- token associado à aplicação;
- relógio coletivo e individual;
- transições inválidas;
- finalização e envio idempotentes;
- logs e mensagens por aplicação;
- compatibilidade de submissões legadas.

### Testes web

- formulário recarrega preset salvo;
- confirmação de preparação;
- confirmação de finalização;
- instruções e início;
- confirmação de saída e envio;
- estados de foco bloqueado e desbloqueado;
- editor completo de prova.

### Testes E2E

Criar `test/e2e/exam-flow.spec.js` com dois contextos de navegador, professor e aluno:

1. criar aluno;
2. criar prova e questões;
3. preparar aplicação A;
4. entrar, responder, sair, voltar e entregar;
5. finalizar e publicar;
6. preparar aplicação B da mesma prova;
7. confirmar monitor zerado e tentativa limpa;
8. testar troca de aba;
9. testar confirmações;
10. validar nota e gabarito.

### Gate de liberação

Executar:

```text
npm run test:backend
npm run test:web
npm run build
npm run test:e2e
```

Fazer também uma rodada manual no navegador com dois perfis antes da liberação.

## 3. Ordem de execução resumida

| Ordem | Fase | Entrega | Dependência |
|---:|---|---|---|
| 0 | Baseline e proteção | Testes de reprodução + backup | Nenhuma |
| 1 | Modelo de aplicação | `applicationId` e migração | Fase 0 |
| 2 | APIs por aplicação | Contratos seguros | Fase 1 |
| 3 | Ciclo de vida e preset | Estados e configuração corretos | Fases 1–2 |
| 4 | Monitor e resultados | Dados isolados e finalização segura | Fases 1–3 |
| 5 | Runner e proctoring | Tempo, instruções e confirmações | Fases 1–3 |
| 6 | Autoria | Criar e editar provas | Fases 1–3 |
| 7 | Regressão e liberação | Suíte completa e validação manual | Todas |

## 4. Estimativa global

Para uma pessoa desenvolvedora familiarizada com o projeto: **22–34 dias úteis**, incluindo testes e migração. Com mais de uma pessoa desenvolvedora, as fases 4, 5 e 6 podem ocorrer parcialmente em paralelo depois da estabilização das APIs da Fase 2, reduzindo o prazo de calendário sem reduzir o esforço total.

Não é recomendado iniciar P12–P21 antes de concluir as fases 1–5. O plano anterior continua válido para expansão, mas este plano de estabilização passa a ser seu pré-requisito técnico.

## 5. Definição de pronto

O fluxo será considerado estabilizado quando:

- toda execução tiver `applicationId`;
- monitor, logs, mensagens e resultados forem isolados por aplicação;
- uma nova aplicação começar zerada;
- tentativas forem contabilizadas no escopo correto;
- preset, preparação, início, pausa e finalização forem estados diferentes;
- o cronômetro seguir a política escolhida e informada ao aluno;
- saída, envio e finalização possuírem confirmação;
- perda de foco for registrada na aplicação correta;
- o professor conseguir criar e editar uma prova pela interface;
- a suíte automatizada e o teste manual professor/aluno forem aprovados.
