# Plano de Implementação — Melhorias do Módulo de Provas

Base: `docs/ANALISE_FLUXO_PROVAS.md` (14/07/2026).
Regra geral do plano: cada passo é pequeno, termina em estado funcional e tem um roteiro **"Como testar"** que deve passar antes de avançar. Compatibilidade retroativa é obrigatória: submissões e configs antigas sem os novos campos usam defaults seguros. Preservar padrões existentes: rotas `/api/admin/...`, `db.memory` + `db.save()`, `validateAdmin`, escopo do professor via `validateProfessorRequestScope`.

Preparação antes de qualquer passo: fazer backup da pasta `data/` (o sistema já tem `utils/backup.js`; basta copiar a pasta manualmente também).

---

## FASE 1 — Ganhos rápidos (esforço baixo)

### Passo 1 — Limite de tentativas (`maxAttempts`) — item C2

**Objetivo:** o professor define quantas tentativas cada aluno pode fazer em uma prova online; o servidor bloqueia o excedente.

**Modelo de dados:** novo campo `maxAttempts` (inteiro ≥ 1 ou `null` = ilimitado, default `null`) em `onlineExamConfigs[examKey]` e no `examHistory` (para reaproveitar na preparação).

**Backend:**
- `adminExamConfig.js`: aceitar `maxAttempts` em `/api/admin/online-exam-config`, `/api/admin/exam-history/add` e em `buildPreparedOnlineExamConfig` (via `applicationOptions`).
- `student.js /api/student/submit`: antes de corrigir, contar `previousAttempts` (já calculado na linha ~845) e recusar com HTTP 403 `{ error: 'Limite de tentativas atingido.', attemptsExhausted: true }` se `previousAttempts.length >= maxAttempts`.
- `student.js /api/student/sync` e `proctoring.js /api/student/exam-state`: expor `attemptsUsed` e `maxAttempts` para o frontend.

**Frontend:**
- `admin/ProvasPage.jsx`: campo "Tentativas permitidas" no formulário de aplicação (junto de duração/token).
- `student/exam/ExamRunner.jsx`: se tentativas esgotadas, mostrar tela terminal "Você já usou todas as tentativas" (nova fase `exhausted`) em vez de reabrir a prova.
- `student/ProvasPage.jsx`: badge "Tentativa X de Y".

**Como testar:**
1. (Professor) Provas → escolher avaliação → preparar aplicação online com "Tentativas permitidas = 1" → iniciar pelo Monitor.
2. (Aluno) Abrir a prova, responder e enviar. Confirmar tela de sucesso.
3. (Aluno) Voltar em Provas e clicar na mesma prova de novo → deve aparecer "tentativas esgotadas", sem carregar questões.
4. (Aluno, via DevTools) Repetir o POST `/api/student/submit` manualmente → deve retornar 403 `attemptsExhausted`.
5. (Professor) Reaplicar com "Tentativas = 2" → aluno consegue enviar duas vezes e a terceira é bloqueada; em Resultados as duas tentativas aparecem com a política de consolidação.
6. Regressão: aplicar prova SEM preencher o campo → comportamento atual (ilimitado) preservado; provas antigas em `data/` continuam abrindo.

---

### Passo 2 — Auditoria de lançamentos e ações de resultado — item I6

**Objetivo:** registrar QUEM fez cada ação sobre notas (lançamento manual, arquivar/restaurar/selecionar tentativa, mudança de política, exclusão).

**Modelo de dados:**
- Em `submissions/create`: gravar `createdBy: matchedAdmin.email`, `createdByName`, `origin: 'manual'`.
- Novo array `db.memory.gradeAuditLog` (novo arquivo JSON no mesmo padrão de `database.js`): `{ id, at, by, action, submissionId, studentEmail, examKey, details }`.

**Backend:**
- `admin.js`: nos handlers `submissions/create`, `submissions/result-control`, `submissions/delete`, `submissions/publish` — acrescentar push no `gradeAuditLog` (o `matchedAdmin` já está disponível no callback do `validateAdmin`).
- Nova rota `GET /api/admin/grade-audit?studentEmail=&examKey=` (admin pleno; professor vê apenas registros de alunos do seu escopo, reutilizando `filterSubmissionsForAdmin`/`adminCanAccessStudent`).

**Frontend:**
- `admin/ResultadosPage.jsx`: no modal de revisão da tentativa, aba/bloco "Histórico de ações" listando o log.

**Como testar:**
1. (Professor) Resultados → "Lançar nota manual" para um aluno → em seguida abrir a revisão da tentativa: deve constar "Lançada manualmente por <email> em <data>".
2. (Professor) Arquivar a tentativa, mudar política para "média", publicar a nota → o histórico deve mostrar as 4 ações em ordem, com autor.
3. (Admin) Repetir uma ação com a conta admin → autor muda no log.
4. (Professor de outra turma) Chamar `GET /api/admin/grade-audit?studentEmail=<aluno fora do escopo>` → 403 ou lista vazia.
5. Regressão: submissões antigas sem `createdBy` continuam renderizando (campo ausente exibe "—").

---

### Passo 3 — Notificações automáticas ao aluno — item I2

**Objetivo:** avisar o aluno quando (a) uma nota é publicada e (b) uma prova é liberada, reutilizando o sistema de avisos (`announcements`) já lido pelo aluno em `/api/student/announcements`.

**Backend:**
- Criar helper `utils/systemNotices.js` com `pushSystemAnnouncement({ targetEmail | studentClass, courseId, title, body, kind })` gravando em `db.memory.announcements` com flag `system: true`.
- `admin.js /api/admin/submissions/publish`: ao publicar, gerar aviso individual por aluno ("Sua nota de <prova> foi publicada").
- `adminExamConfig.js /api/admin/release-item`: ao liberar prova online (`released: true` em chave `Avaliacao_*`), gerar aviso para a turma ("A prova <nome> foi liberada").
- Evitar duplicados: não criar novo aviso se já existir um `system` igual (mesmo alvo + prova + kind) nos últimos 10 minutos.

**Frontend:** nenhum obrigatório — a página de Avisos do aluno já lista; opcionalmente destacar avisos `system: true` com ícone.

**Como testar:**
1. (Professor) Preparar e liberar uma prova online para a turma.
2. (Aluno) Abrir Avisos → deve existir "A prova ... foi liberada" com data/hora.
3. (Aluno) Fazer a prova e enviar. (Professor) Resultados → publicar a nota.
4. (Aluno) Avisos → deve existir "Sua nota ... foi publicada"; outro aluno da turma que não fez a prova NÃO deve receber esse aviso individual.
5. (Professor) Publicar de novo (despublicar/republicar) em menos de 10 min → não duplica aviso.

---

### Passo 4 — UX do runner: confirmação de envio + navegação de questões — item D2 (nº 10 do ranking)

**Objetivo:** reduzir envios acidentais e facilitar revisão antes do envio.

**Frontend (somente `ExamRunner.jsx` + `examUtils.js`):**
- Modal de confirmação ao clicar "Enviar" (manual): mostrar respondidas/total e listar números em branco; botões "Revisar" / "Enviar assim mesmo". Envio automático por tempo NÃO abre modal.
- Painel de navegação fixo (grade de números 1..N): respondida = cheia, em branco = vazia, clicada rola até a questão (`scrollIntoView`).
- Marcar questão "para revisão" (estado local + persistir junto do autosave em `answersMeta` opcional, sem quebrar o backend — enviar apenas `answers` como hoje).

**Como testar:**
1. (Aluno) Iniciar prova com 5+ questões, responder 3 → clicar "Enviar" → modal deve dizer "3/5 respondidas" e listar as questões 4 e 5 em branco.
2. "Revisar" fecha o modal sem enviar; clicar no número 4 no painel rola até a questão 4.
3. Marcar a questão 2 para revisão → indicador aparece no painel; recarregar a página (F5) → respostas persistem via autosave/state.
4. "Enviar assim mesmo" envia e cai na tela de sucesso.
5. Deixar o tempo acabar em outra tentativa → envio automático continua ocorrendo SEM modal.
6. Regressão: fluxo com token e sala de espera intactos.

---

## FASE 2 — Modelo de notas (pré-requisito para boletim)

### Passo 5 — Nota de aprovação e pontos por questão — item C3

**Objetivo:** nota deixa de ser sempre "% de acertos": cada questão pode ter peso, e cada prova tem nota de corte configurável.

**Modelo de dados:**
- `evaluations[key].questions[n].points` (número > 0, default 1).
- `evaluations[key].passingScore` (0–100, default 60) — com override opcional por aplicação em `onlineExamConfigs[examKey].passingScore`.
- Em submissões novas: gravar `earnedPoints`, `totalPoints`, `passingScore` (o campo `score` continua 0–100, agora = `earnedPoints/totalPoints*100`, mantendo TODOS os consumidores atuais funcionando: políticas de consolidação, CSV, analytics, dashboards).

**Backend:**
- `student.js /api/student/submit` e `admin.js /api/admin/submissions/create`: correção soma pontos em vez de contar acertos (peso 1 reproduz o comportamento atual).
- `admin.js`: `exam-analytics` e `studentAnalytics.js` passam a usar `passingScore` do registro (fallback 60) nos buckets/risco.
- `PUT /api/admin/evaluation/:key`: validar `points` numérico > 0.

**Frontend:**
- `admin/EditorPage.jsx`: campo "Pontos" por questão e "Nota de corte" da avaliação.
- `admin/ResultadosPage.jsx` e `student/ProvasPage.jsx`: badge aprovado/reprovado usa o `passingScore` da submissão (fallback 60).

**Como testar:**
1. (Professor) Editor → definir prova de 4 questões com pontos 1, 1, 2, 4 (total 8) e corte 50.
2. (Aluno) Acertar só a questão de peso 4 → nota exibida deve ser 5,0 (4/8) e badge "aprovado" (corte 50). Acertar só as duas de peso 1 → 2,5, "reprovado".
3. (Professor) Resultados → conferir que a nota consolidada e o CSV exportado refletem 5,0/2,5.
4. Analytics da prova → distribuição usa corte 50 (aluno de 5,0 não conta como "baixo").
5. Regressão: prova antiga sem `points` → todas as questões valem 1 e corte 60; comparar a nota de uma submissão antiga antes/depois (não pode mudar).

---

### Passo 6 — Boletim consolidado por curso + exportação PDF — item I7

**Objetivo:** visão por aluno/curso: nota consolidada de cada avaliação (respeitando política de tentativas), peso por avaliação, média final e situação.

**Modelo de dados:** `courses[id].gradeWeights = { [examKey]: number }` (default: pesos iguais); `courses[id].passingAverage` (default 60).

**Backend:**
- Nova rota `GET /api/admin/report-card/:courseId/:class` → por aluno: `{ exams: [{examKey, consolidatedScore, published}], finalAverage, status: 'aprovado'|'reprovado'|'pendente' }` (pendente se faltar avaliação publicada). Reutilizar `enrichSubmissionsWithAttemptResult`.
- Rota espelho para o aluno: `GET /api/student/report-card` (somente notas publicadas).
- Exportação: `GET /api/admin/report-card/:courseId/:class/export` gerando PDF simples (ou HTML print-friendly, alinhado ao padrão de impressão já usado em `ProvasPage`).

**Frontend:** nova aba "Boletim" em `admin/ResultadosPage.jsx` (tabela alunos × avaliações + média final + botão exportar); bloco "Meu boletim" em `student/ProvasPage.jsx` ou `InicioPage.jsx`.

**Como testar:**
1. (Professor) Curso com 2 avaliações; alunos com notas publicadas nas duas → Boletim mostra as duas notas, média e situação corretas (conferir na mão: pesos iguais = média aritmética das consolidadas).
2. Definir peso 2 para a Prova 2 → média recalcula ((n1 + 2·n2)/3).
3. Aluno com apenas 1 nota publicada → situação "pendente".
4. (Aluno) "Meu boletim" mostra o mesmo número que o professor vê; nota não publicada NÃO aparece.
5. Exportar → PDF/impressão legível com nome da turma, curso e data.
6. (Professor de outra turma) Não consegue abrir boletim de turma fora do escopo (403).

---

## FASE 3 — Autoria e aplicação

### Passo 7 — Banco de questões completo: editar + montar prova a partir do banco — itens I3 e I4(parcial)

**Objetivo:** transformar o banco de questões em fonte de autoria: editar questões, metadados de dificuldade/tags, e criar avaliação selecionando questões do banco.

**Backend:**
- `POST /api/admin/question-bank/update` (por `key`; professor só edita questão cujo `sourceExamKey` está no escopo — o guard central já cobre via `sourceExamKey`, replicar o padrão do delete em `middlewares.js:428-431`).
- Campos novos: `difficulty` (`facil|media|dificil`), `tags: []`.
- `POST /api/admin/evaluation/compose`: recebe `targetKey`, `title`, `questionKeys[]` → cria `evaluations[targetKey]` copiando as questões (renumeradas 1..N, preservando `points`).

**Frontend:** tela do banco (hoje embutida) ganha: busca por texto/categoria/dificuldade/tag, edição inline e seleção múltipla → "Criar avaliação com N selecionadas".

**Como testar:**
1. (Professor) Importar uma avaliação existente para o banco → editar o enunciado de uma questão e trocar a alternativa correta → salvar → reabrir e conferir persistência.
2. Filtrar por dificuldade "difícil" → só as marcadas aparecem.
3. Selecionar 5 questões → "Criar avaliação" → nova avaliação aparece no Editor com 5 questões numeradas 1–5.
4. Aplicar essa avaliação online para uma turma e fazer como aluno → correção funciona (gabarito da questão editada vale o novo).
5. (Professor) Tentar editar questão originada de prova fora do escopo → 403.

---

### Passo 8 — Agendamento de prova por data/hora — item I1

**Objetivo:** professor agenda início (e opcionalmente encerramento) automáticos: "dia 20/07 às 19h, encerra 21h".

**Modelo de dados:** em `onlineExamConfigs[examKey]`: `scheduledStartAt` (epoch ms), `scheduledEndAt` (epoch ms, opcional). Status novo: `scheduled`.

**Backend:**
- `release-item`/`buildPreparedOnlineExamConfig`: aceitar agendamento — se `scheduledStartAt` futuro, `status: 'scheduled'`, `startTime: scheduledStartAt`.
- Ativação **lazy** (sem cron, coerente com a arquitetura): nos handlers de leitura (`/api/status`, `/api/student/sync`, `/api/student/exam-state`, `/api/admin/monitor-status`) — se `status === 'scheduled'` e `now >= scheduledStartAt`, promover para `running` (+ `onlineActive: true`, `activeExamKey`) e salvar; se `scheduledEndAt` e `now >= scheduledEndAt` com status `running`, promover para `finished`. Extrair para helper único `utils/examSchedule.js` para não duplicar.
- `submit`: recusar após `scheduledEndAt` (mesma mensagem de prazo).
- Registrar o evento no calendário (`announcements/calendar`) automaticamente.

**Frontend:** `admin/ProvasPage.jsx` — opção "Agendar" com datetime-local de início/fim; `MonitorPage` mostra "Agendada para <data>"; aluno vê card "Agendada — inicia em <contagem>".

**Como testar:**
1. (Professor) Agendar prova para daqui a 2 minutos, com fim 5 minutos depois do início.
2. (Aluno) Antes do horário: card "Agendada", runner mostra contagem e não exibe questões. (Verificar também via `GET /api/student/sync`: sem snapshot de questões antes da hora.)
3. Aguardar o horário → sem qualquer ação do professor, o aluno entra e as questões carregam; Monitor mostra `running`.
4. Aguardar o fim → prova encerra sozinha; envio após o fim retorna erro de prazo; quem estava com a prova aberta é auto-enviado pelo timer normal.
5. Calendário (admin e aluno) exibe o evento da prova.
6. Regressão: fluxo manual (waiting/iniciar pelo Monitor) continua funcionando quando não há agendamento.

---

### Passo 9 — Fluxo formal de recuperação / segunda chamada — item I5

**Objetivo:** reaplicar prova para alunos específicos com registro separado, sem misturar com as tentativas regulares.

**Modelo de dados:** em submissões novas: `applicationType: 'regular' | 'recuperacao' | 'segunda_chamada'` (default `regular`). Na liberação individual (`studentReleasedItems`), permitir objeto `{ released, applicationType, maxAttempts }`.

**Backend:**
- `release-item`: aceitar `applicationType` quando `studentEmail` informado.
- `submit`: carimbar `applicationType` da liberação individual ativa; contagem de `maxAttempts` separada por `applicationType`.
- `submissionAttempts.js`: consolidação considera recuperação conforme regra configurável no curso: `recoveryPolicy: 'substitui' | 'maior' | 'media'` (default `maior`).
- Boletim (Passo 6) exibe coluna/badge "Rec".

**Como testar:**
1. Aluno reprovado na prova regular (nota 4,0 publicada).
2. (Professor) Resultados → aluno → "Liberar recuperação" (1 tentativa) → aluno vê a prova disponível de novo, com selo "Recuperação"; os demais alunos da turma NÃO veem.
3. (Aluno) Fazer e tirar 8,0. (Professor) Publicar.
4. Com `recoveryPolicy: 'maior'`: consolidada = 8,0; mudar para `media`: consolidada = 6,0; boletim reflete e marca "Rec".
5. Tentar segunda tentativa de recuperação → bloqueado (maxAttempts=1 do escopo da recuperação).

---

## FASE 4 — Antifraude e feedback

### Passo 10 — Fullscreen obrigatório + log de copiar/colar — itens D1/D12

**Objetivo:** endurecer o proctoring sem mudar o modelo (eventos → `proctoringLogs`).

**Backend:** aceitar novos `eventType` em `/api/student/log-activity`: `fullscreen_exit`, `copy_attempt`, `paste_attempt`, `contextmenu`. Configurável por aplicação: `onlineExamConfigs[examKey].requireFullscreen` (bool), `lockOnFullscreenExit` (bool — se true, trata como `tab_blur`: trava no servidor).

**Frontend (`ExamRunner.jsx`):** ao iniciar, se `requireFullscreen`, pedir fullscreen (`requestFullscreen`) numa tela intermediária "Entrar na prova"; listener de `fullscreenchange` → loga e (se configurado) pausa; bloquear `copy/paste/contextmenu` na área da prova e logar tentativas. Monitor: exibir os novos eventos nos logs e no resumo do analytics.

**Como testar:**
1. (Professor) Aplicar prova com "Exigir tela cheia" + "Travar ao sair da tela cheia".
2. (Aluno) Ao entrar, botão "Entrar na prova em tela cheia" → prova só aparece em fullscreen.
3. Apertar ESC → prova pausa com a mesma tela de bloqueio de foco; (Professor) Monitor mostra `focus_locked` com motivo "saiu da tela cheia" e consegue desbloquear.
4. (Aluno) Tentar Ctrl+C num enunciado e Ctrl+V numa resposta → nada copia/cola; (Professor) logs mostram `copy_attempt`/`paste_attempt`.
5. Aplicar prova SEM exigir fullscreen → comportamento atual intacto.

---

### Passo 11 — Feedback do professor por questão/tentativa — item D3

**Objetivo:** professor comenta a tentativa (geral) e questões específicas; aluno vê após publicação.

**Modelo de dados:** na submissão: `feedback: { general: string, byQuestion: { [questionNumber]: string }, updatedAt, updatedBy }`.

**Backend:** `POST /api/admin/submissions/:id/feedback` (escopo do professor via `filterSubmissionsForAdmin`); `sanitizeSubmissionForStudent` inclui `feedback` somente se `gradePublished === true`.

**Frontend:** modal de revisão em `ResultadosPage.jsx` ganha campos de comentário (geral + por questão); no aluno, detalhe da submissão exibe os comentários (e o gabarito segue a regra atual de liberação).

**Como testar:**
1. (Professor) Revisar tentativa → escrever comentário geral e comentário na questão 2 → salvar → reabrir e conferir.
2. (Aluno) Antes da publicação: detalhe da tentativa NÃO mostra comentários. Após publicar: mostra ambos.
3. Auditoria (Passo 2): ação `feedback` registrada com autor.

---

## FASE 5 — Tipos de questão (a maior mudança, por último)

### Passo 12 — Verdadeiro/Falso e múltiplas corretas — item C1 (parte 1)

**Objetivo:** introduzir `type` por questão com correção ainda 100% automática, preparando o terreno para dissertativas.

**Modelo de dados:** `question.type: 'multiple_choice' (default) | 'true_false' | 'multi_select'`; para `multi_select`, `correctAnswers: ['A','C']` e resposta do aluno vira array; pontuação tudo-ou-nada (simples e sem ambiguidade).

**Backend:** `submit`/`submissions/create`: correção por `type` (helper único `utils/grading.js` usado pelos dois); validação no `PUT /evaluation/:key`. Formato de `gradedAnswers` ganha `studentChoices[]` quando aplicável (manter `studentChoice` para MC — compatibilidade com review/analytics).

**Frontend:** Editor: seletor de tipo por questão; Runner: radio (MC/VF) vs checkbox (multi); review do professor e do aluno renderizam por tipo.

**Como testar:**
1. (Professor) Criar prova com 1 MC, 1 VF e 1 multi (corretas A e C).
2. (Aluno) VF correta + multi marcando só A → multi deve contar como ERRADA (tudo-ou-nada); nota = pontos da VF + MC conforme acerto.
3. Review (professor e aluno pós-gabarito) mostra corretamente as marcações múltiplas.
4. Analytics: distribução de escolhas da multi aparece por combinação ou por alternativa (definir na implementação, validar que não quebra).
5. Regressão: prova antiga só-MC → correção idêntica à anterior.

### Passo 13 — Questões dissertativas + fila de correção manual — item C1 (parte 2)

**Objetivo:** questão aberta com resposta em texto, corrigida pelo professor com o `rubric` (campo já existente e hoje não usado).

**Modelo de dados:**
- `question.type: 'essay'`, `question.maxPoints` (usa `points` do Passo 5), `question.rubric` (texto).
- Submissão: `gradedAnswers[n] = { questionNumber, studentText, awardedPoints: null, gradedBy, gradedAt, comment }`; novo `gradingStatus: 'auto' | 'pending_review' | 'reviewed'` na submissão (qualquer essay sem `awardedPoints` ⇒ `pending_review`).
- Publicação bloqueada enquanto `pending_review` (aviso claro no publish).

**Backend:**
- `submit`: essays não entram na nota automática; `score` provisório = parte objetiva; `gradingStatus: 'pending_review'`.
- `POST /api/admin/submissions/:id/grade-essay`: `{ questionNumber, awardedPoints, comment }` → quando todas corrigidas, recalcula `score` final e marca `reviewed` (+ auditoria do Passo 2).
- `publish`: recusar ids com `pending_review` (`error` listando quais).

**Frontend:**
- Editor: tipo "Dissertativa" com rubrica e pontos.
- Runner: textarea com autosave (o autosave já envia `answers`; valores string longos funcionam — validar limite de tamanho, ex. 10k chars).
- `ResultadosPage.jsx`: aba "Correção pendente" com fila (aluno × questão), rubrica visível, campo de pontos + comentário.
- Aluno: vê "aguardando correção" até `reviewed` + publicação.

**Como testar:**
1. (Professor) Prova com 2 MC (1 pt cada) + 1 dissertativa (3 pts, rubrica preenchida).
2. (Aluno) Responder tudo (dissertativa com texto longo, >1 parágrafo) e enviar → tela final NÃO mostra nota; status "aguardando correção".
3. (Professor) Resultados → tentar publicar → bloqueado com mensagem de correção pendente.
4. Fila de correção → abrir a dissertativa (texto do aluno + rubrica lado a lado) → dar 2/3 pts + comentário → submissão vira `reviewed` e nota recalcula (MC acertadas + 2 de 3 → conferir na mão).
5. Publicar → (Aluno) vê nota final, pontos da dissertativa e comentário; gabarito das objetivas segue regra de liberação.
6. Autosave: digitar na dissertativa, F5 no meio → texto recuperado.
7. Regressão: prova só objetiva → `gradingStatus: 'auto'`, publicação direta como hoje.

---

## FASE 6 — Operação da prova na vida real (adições aprovadas)

### Passo 14 — Tempo adicional automático por acessibilidade

**Objetivo:** aplicar automaticamente o tempo adicional já cadastrado no aluno (`accessibility.tempoAdicional` + `tempoAdicionalPercent`) ao timer da prova online — hoje esses campos existem no cadastro mas o fluxo de prova os ignora.

**Backend:** em `initializeExamState` (`middlewares.js`), ao calcular `deadlineAt`, somar `durationMinutes * (tempoAdicionalPercent/100)` quando o aluno tiver `tempoAdicional: true`. Registrar no estado: `accessibilityExtraMinutes`. O ajuste manual do Monitor continua somando por cima.

**Frontend:** `MonitorPage.jsx` mostra badge "+25%" ao lado do timer do aluno; `ExamRunner.jsx` não muda (o timer já vem do servidor).

**Como testar:**
1. (Admin) Cadastro do aluno → ativar "Tempo adicional 25%".
2. (Professor) Aplicar prova de 40 min → (Aluno) timer inicia em 50 min; outro aluno sem o cadastro inicia em 40.
3. Monitor mostra o badge no aluno com tempo estendido; ajuste manual de +10 min soma (60 total).
4. Regressão: aluno sem acessibilidade → 40 min exatos.

---

### Passo 15 — Anular questão após a aplicação (recorreção automática)

**Objetivo:** professor anula uma questão problemática e o sistema recorrige todas as tentativas, sem apagar nada.

**Modelo de dados:** `onlineExamConfigs[examKey].annulledQuestions: [{ questionNumber, mode: 'ponto_para_todos' | 'remover_do_total', by, at, reason }]`. **NUNCA alterar `updatedAt`** ao anular (isso resetaria a prova dos alunos em andamento — ver comentário em `admin.js:2118`).

**Backend:**
- `POST /api/admin/annul-question`: `{ studentClass, courseId, examKey, questionNumber, mode, reason }` → grava na config, recorrige as submissões existentes da turma×prova (recalcula `score`/`correctCount`/`totalCount` a partir de `gradedAnswers`, marcando `annulled: true` na resposta) e registra na auditoria (P2).
- `submit` (aluno): ignora questões anuladas conforme o `mode` na correção de novas entregas.
- `sync`/`exam-state`: expor `annulledQuestions` para o runner.

**Frontend:**
- `admin/ResultadosPage.jsx` (ou analytics): na visão por questão, ação "Anular questão" com escolha do modo e motivo (`ConfirmDialog`).
- `ExamRunner.jsx`: questão anulada durante a prova aparece acinzentada com badge "Questão anulada — não será corrigida" e conta como respondida no painel.
- Revisão (professor e aluno): questão anulada marcada como tal, fora do cálculo.

**Como testar:**
1. Prova de 4 questões aplicada e enviada por 2 alunos (um acertou a Q3, outro errou).
2. (Professor) Anular Q3 modo "remover do total" → notas recalculam para base 3 (conferir na mão); auditoria registra.
3. Anular modo "ponto para todos" em outra prova → todos ganham o ponto.
4. (Aluno em prova) anulação no meio da prova → sem reset, questão fica cinza, envio corrige sem a Q3.
5. Regressão: provas sem anulação idênticas ao comportamento atual.

---

### Passo 16 — Contestação de questão em tempo real + ação no Monitor

**Objetivo:** durante a prova, o aluno sinaliza "esta questão parece errada"; o professor vê a contestação ao vivo no Monitor e pode, na hora, anular a questão (P15) e opcionalmente substituí-la por outra do banco (P7). Depende de P15; substituição depende de P7.

**Modelo de dados:** novo array `db.memory.questionReports`: `{ id, examKey, studentClass, courseId, questionNumber, studentEmail, reason, text, status: 'open'|'reviewed'|'annulled', createdAt, resolvedBy, resolvedAt }`.

**Backend:**
- `POST /api/student/report-question` (validateStudentSession): 1 contestação por aluno×questão×prova; rate-limit 5/min; motivo em enum: `sem_resposta_correta | duas_corretas | enunciado_confuso | erro_digitacao | outro` + texto livre opcional (máx. 300 chars).
- `GET /api/admin/question-reports/:class/:examKey` (escopo professor via path, mesmo padrão de `proctoring-logs`): agrupado por questão com contagem de alunos.
- `POST /api/admin/question-reports/resolve`: `{ reportIds | questionNumber, action: 'reviewed' }` (descartar) — anulação usa o endpoint do P15, que marca os reports da questão como `annulled`.
- **Substituição (opcional):** `POST /api/admin/replace-question`: `{ ..., questionNumber, bankQuestionKey, extraMinutes }` → anula a original (modo `remover_do_total`), acrescenta a questão do banco ao final dos `versionSnapshots` e dos `assignedQuestionNumbers` de cada aluno **sem tocar em `updatedAt`**, e aplica `globalTimeAdjustment += extraMinutes`. Servidor recusa se a prova não estiver `running` ou se restarem menos de 5 min.
- Aluno recebe a questão nova via `sync` (o runner já reconstrói a lista de questões a cada poll).

**Frontend:**
- `ExamRunner.jsx`: em cada questão, botão discreto "Reportar problema" (ícone `AlertTriangle`) → modal com os motivos + texto; após enviar, vira "Problema reportado" (desabilitado). Toast: "O professor foi notificado.". Questão substituída chega ao final da lista com badge "Questão adicional".
- `MonitorPage.jsx`: painel "Contestações" com badge de contagem ao vivo (mesmo polling atual). Cada linha: "Q7 — 5 alunos — Sem resposta correta". Ações por questão: "Ver questão" (preview), "Descartar", "Anular..." (abre o fluxo P15) e "Anular e substituir..." (lista questões do banco da mesma categoria + campo "minutos extras para a turma", sugerido 5).

**Como testar:**
1. (Aluno A e B, em prova) Reportar a Q2 com motivos diferentes → (Professor) Monitor mostra "Q2 — 2 alunos" em segundos, sem recarregar a página.
2. Reportar a Q2 de novo pelo mesmo aluno → bloqueado ("já reportada").
3. (Professor) "Descartar" → some do painel; alunos não são afetados.
4. (Professor) Em outra contestação, "Anular" → alunos veem a questão anulada em tempo real (P15.4) e a correção sai sem ela.
5. (Professor) "Anular e substituir" escolhendo questão do banco + 5 min extras → alunos recebem a questão nova ao final com badge, timer de todos aumenta 5 min, e o envio corrige a nova questão normalmente.
6. Substituir com prova pausada ou com 3 min restantes → servidor recusa com mensagem clara.

---

### Passo 17 — Invalidar e reabrir tentativa (envio acidental)

**Objetivo:** professor invalida um envio (não conta como tentativa nem no resultado) e reabre a prova para o aluno. Complementa P1 (limite) e P2 (auditoria).

**Backend:** `POST /api/admin/submissions/invalidate`: marca `resultStatus: 'invalidated'` (novo status, fora de qualquer consolidação e da contagem de tentativas do P1) e, se a prova ainda estiver `running`, recria o `studentExamState` do aluno (sem respostas ou preservando o rascunho — parâmetro `keepAnswers`). Auditoria P2 registra.

**Frontend:** `ResultadosPage.jsx` → ação "Invalidar e reabrir" com `ConfirmDialog`; tentativa invalidada aparece riscada com badge "Invalidada". Aluno vê a prova disponível de novo.

**Como testar:**
1. Aluno envia por engano (prova com maxAttempts=1) → não consegue reabrir.
2. (Professor) Invalidar e reabrir → aluno entra de novo e envia; nova tentativa conta como nº 1.
3. A invalidada não aparece no resultado consolidado nem no boletim; auditoria mostra as duas ações.

---

### Passo 18 — Tela de instruções da prova

**Objetivo:** professor escreve instruções; aluno as vê e aceita antes de iniciar.

**Modelo de dados:** `onlineExamConfigs[examKey].instructions` (texto, máx. 2000 chars), definido na preparação da aplicação (e reaproveitado do `examHistory`).

**Backend:** aceitar `instructions` em `online-exam-config`/`exam-history/add`/`buildPreparedOnlineExamConfig`; expor no `sync`.

**Frontend:** `ProvasPage.jsx` (admin): `Textarea` "Instruções para o aluno" na aplicação. `ExamRunner.jsx`: nova fase `instructions` entre waiting/token e active — card com o texto, checkbox "Li e entendi as instruções" e botão "Iniciar prova" (só habilita com o aceite). Sem instruções definidas, a fase é pulada (comportamento atual).

**Como testar:**
1. Aplicar prova com instruções → aluno vê a tela, botão desabilitado até marcar o aceite, depois inicia normalmente.
2. Aplicar sem instruções → entra direto como hoje.
3. Timer só começa a valer como hoje (a tela de instruções não consome tempo de prova — validar que `startedAt` não muda).

---

### Passo 19 — Pedido de revisão de nota (pós-gabarito)

**Objetivo:** vista de prova formal: aluno contesta uma questão da tentativa corrigida; professor responde mantendo ou ajustando; tudo auditado. Depende de P2; a contestação em tempo real (P16) cobre o "durante", esta cobre o "depois".

**Modelo de dados:** `db.memory.gradeReviewRequests`: `{ id, submissionId, questionNumber, studentEmail, text, status: 'open'|'kept'|'adjusted', professorResponse, createdAt, resolvedBy, resolvedAt }`.

**Backend:** `POST /api/student/review-request` (só para tentativa com `gradePublished` e gabarito liberado; 1 pedido por questão); `GET /api/admin/review-requests` (escopo professor); `POST /api/admin/review-requests/resolve` (`kept` com resposta, ou `adjusted` → ajusta a resposta em `gradedAnswers` e recorrige a tentativa, com auditoria P2).

**Frontend:** aluno — no detalhe da tentativa, por questão: "Pedir revisão" + texto; status visível ("Em análise" / resposta do professor). Professor — `ResultadosPage.jsx`, aba/badge "Revisões (N)" com fila: questão, argumento do aluno, resposta e ação Manter/Ajustar.

**Como testar:**
1. (Aluno) Pedir revisão da Q3 com justificativa → (Professor) fila mostra o pedido.
2. "Manter" com resposta → aluno vê a resposta; nota inalterada.
3. "Ajustar" (marcar a alternativa do aluno como correta) → nota recalcula, auditoria registra, aluno vê nota nova.
4. Pedido duplicado na mesma questão → bloqueado.

---

### Passo 20 — Alertas de tempo no runner

**Objetivo:** avisos claros nos minutos finais.

**Frontend (só `ExamRunner.jsx`):** aos 5 min: toast "Restam 5 minutos" + timer fica `text-warning`; a 1 min: timer `text-danger` pulsando + toast; a 10s: contagem grande sobreposta discreta. Tudo com `aria-live="polite"`. Sem som por padrão (evita constrangimento em sala); opcional `Switch` "Alerta sonoro" no próprio runner (preferência local).

**Como testar:** prova de 6 min → conferir os três marcos; envio automático ao zerar continua; leitor de tela anuncia os avisos.

---

### Passo 21 — Importar questões por arquivo

**Objetivo:** professor importa questões em lote (CSV e texto colado no formato do parser existente) direto para o banco de questões (P7) ou para uma avaliação.

**Backend:** `POST /api/admin/question-bank/import-file`: aceita CSV (`enunciado;altA;altB;altC;altD;correta;categoria;dificuldade`) ou texto markdown no formato já suportado por `parseEvaluationMarkdown` (`utils/parser.js`). Validar linha a linha; retorno lista erros por linha sem abortar as válidas.

**Frontend:** tela do banco (P7): botão "Importar" → modal com abas "Colar texto" (`Textarea` + exemplo do formato) e "Arquivo CSV" (upload) → pré-visualização das questões reconhecidas com erros destacados → "Importar N questões".

**Como testar:**
1. Colar 3 questões no formato markdown → pré-visualização mostra as 3 → importar → aparecem no banco.
2. CSV com 5 linhas, 1 inválida (sem resposta correta) → importa 4 e lista o erro da linha 3.
3. Montar avaliação com as importadas (P7) e aplicar → correção funciona.

---

## Dependências entre passos

```
P1 (maxAttempts) ──────────────► P9 (recuperação), P17 (invalidar/reabrir)
P2 (auditoria) ────────────────► P11 (feedback), P13 (correção manual), P15, P17, P19
P5 (pontos/corte) ─────────────► P6 (boletim), P12, P13
P7 (banco completo) ───────────► P16 (substituição), P21 (importação), sorteio por aluno (futuro)
P12 (tipos automáticos) ───────► P13 (dissertativas)
P15 (anular questão) ──────────► P16 (contestação em tempo real)
Demais passos: independentes.
```

Nota: o item D11 da análise (sorteio de questões por aluno) fica como extensão pós-P7/P12 — exige mudar `assignedQuestionNumbers` para sorteio por aluno no `initializeExamState`, o que conflita com o modelo de versões A–D. Recomendo decidir depois do P8 se ainda é necessário.

## Testes automatizados

- A cada passo de backend: adicionar caso em `test/` (o projeto tem Playwright e modo de teste `routes/testmode.js` com `/api/test/seed` — usar o seed para montar turma+prova e validar as regras novas por API).
- Passos 4, 10 e 13 (UX do runner): cenário Playwright cobrindo o fluxo feliz do aluno.
- Rodar sempre a suíte existente antes de dar o passo como concluído (`npx playwright test` na raiz + `npm test` em `web/` se configurado).

## Ordem de execução resumida

| Ordem | Passo | Esforço | Entrega |
|---|---|---|---|
| 1 | P1 Limite de tentativas | Baixo | Controle de retakes |
| 2 | P2 Auditoria de notas | Baixo | Rastreabilidade |
| 3 | P3 Notificações | Baixo | Aluno informado |
| 4 | P4 UX do runner | Baixo | Menos envios acidentais |
| 5 | P5 Pontos + nota de corte | Médio | Modelo de notas real |
| 6 | P6 Boletim + PDF | Médio | Visão consolidada |
| 7 | P7 Banco de questões completo | Médio | Autoria ágil |
| 8 | P8 Agendamento | Médio | Provas automáticas |
| 9 | P9 Recuperação | Médio | Fluxo formal |
| 10 | P10 Fullscreen + copy/paste | Médio | Antifraude |
| 11 | P11 Feedback do professor | Médio | Retorno qualitativo |
| 12 | P12 VF + múltiplas corretas | Médio | Novos tipos automáticos |
| 13 | P13 Dissertativas | Alto | Correção manual completa |
| 14 | P14 Tempo adicional automático | Baixo | Inclusão/acessibilidade |
| 15 | P15 Anular questão + recorreção | Médio | Corrige injustiças |
| 16 | P16 Contestação em tempo real | Médio | Professor age durante a prova |
| 17 | P17 Invalidar e reabrir tentativa | Baixo | Resolve envio acidental |
| 18 | P18 Tela de instruções | Baixo | Acabamento profissional |
| 19 | P19 Pedido de revisão de nota | Médio | Vista de prova formal |
| 20 | P20 Alertas de tempo | Baixo | Menos envios perdidos |
| 21 | P21 Importar questões | Médio | Adoção por professores |

Sugestão de encaixe: P14, P17, P18 e P20 são baixo esforço e podem ser feitos junto da Fase 1; P15→P16 logo após P7 (banco); P19 depois de P11; P21 junto de P7.
