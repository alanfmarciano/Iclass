# Plano de Implementação — Digitação ao vivo (reformulada) — v2 revisada

Documento de planejamento. Base: mockup `mockup-digitacao-ao-vivo.html`. Nada aqui altera o sistema até aprovação explícita ("execute").

> **Revisão v2 (2026-07-16):** o plano foi conferido contra o código real (`ExamRunner.jsx`, `proctoring.js`, `admin.js`, `adminPermissions.js`, `middlewares.js`, `adminSystem.js`, `database.js`). As correções estão marcadas com **[CORRIGIDO]** e resumidas na §0.

---

## 0. Correções da revisão (o que mudou em relação ao plano original)

1. **Duração de "saída de foco" não é calculável com os dados atuais.** Não existe evento de *retorno* (`tab_focus`). O aluno só emite `tab_blur`, `exam_left` e `fullscreen_exit`; ao perder foco a prova **pausa** e é o professor quem destrava (`unlock-student-focus`). A §6.4 original prometia "duração até o próximo `tab_focus`/retorno" — isso foi removido/ajustado.
2. **A aba "Texto" (reconstrução) tem valor quase nulo hoje.** As questões atuais são **múltipla escolha por clique** (`<button>`), não há `<textarea>`. O listener de `keydown` é global (window/capture), então `char` captura teclas soltas digitadas em lugar nenhum. A reconstrução só passa a fazer sentido com as dissertativas. A aba deve nascer **oculta/desabilitada** até existir questão digitável (ver §6.2).
3. **Fase 2 (paste + `question`) não entrega valor isolada da Fase 3.** Sem campo editável, `question` sempre resolve `null` e o evento `paste` provavelmente nem dispara (não há alvo editável). Fase 2 e Fase 3 foram **fundidas** (ver §8).
4. **O backend já está mais pronto do que o plano assumia:** `proctoring.js` já persiste `question` (linha 146) e `kind` é livre — portanto `kind:'paste'` já é aceito hoje. Só faltam de fato `pasteLen`/`pastePreview`.
5. **`examKeystrokes` é persistido em disco** (tabela `exam_keystrokes`, `database.js:547/816`), não é só memória — e a rotina de flush (`adminSystem.js`) **não** o limpa. Reforça a §10.
6. **`progress` do monitor-status vem como string** `"respondidas/total"` (não objeto); `logs` usam os campos `eventType` e `timestamp`. Detalhes para o viewer não assumir forma errada.

---

## 1. Objetivo

A prova já **captura tudo** que o aluno faz durante a aplicação (teclas, atalhos, comandos, cópia/recorte, menu, saída de foco). O problema **não é capturar** — isso já funciona e está validado. O problema é que o painel "Digitação ao vivo" mostra essa telemetria como **lista crua** (na prática "0 eventos" ou eventos ilegíveis), então o professor não consegue interpretar o que foi acionado.

**Objetivo central: tornar o que já é capturado fácil de ler e entender**, para o professor saber num relance se o aluno acionou algo suspeito. Em ordem de prioridade:

1. **Ler os comandos/atalhos capturados de forma legível:** cada evento classificado e destacado (ex.: "Ctrl+C — cópia bloqueada", "Alt+G — assistente de IA?", "colou N caracteres", "saiu do foco"), separando ruído (teclas normais) de sinal (atalhos/comandos/foco).
2. **Detectar tentativa de fraude / uso de IA externa** a partir desses sinais: cópia, colagem, atalhos e, principalmente, **saída de foco** (o sinal mais forte hoje).
3. **Dar leitura rápida** do estado do aluno (ritmo, gaps, última atividade, progresso) sem interpretar evento por evento.
4. **(Futuro) Ver o que o aluno escreveu** (texto reconstruído) — só faz sentido quando existirem questões dissertativas (ver §0.2); hoje não há campo digitável.

Escopo estrito: **frontend do professor** (`MonitorPage.jsx`) e **captura no aluno** (`ExamRunner.jsx`), com ajustes mínimos e pontuais no backend. Não altera o modelo de avaliação, correção nem o fluxo de prova.

---

## 2. Estado atual (ponto de partida, verificado no código)

**O que já funciona:**

- Captura no aluno via `keydown`/`copy`/`cut`/`contextmenu` (ExamRunner:149–192), com flush em lote a cada 2s (ou a cada 20 eventos) para `POST /api/student/log-keystrokes`. Beacon no `pagehide` (linha 232).
- Persistência em `db.memory.examKeystrokes` com os campos: `id`, `seq`, `clientTs`, `serverTs`, `key`, `code`, `mods`, `kind`, `question`, `blocked`, `suspicious`, `studentEmail`, `studentClass`, `courseId`, `examKey`, `applicationId`, `attemptId` (proctoring.js:129–149). **[CORRIGIDO]** `question` **já é gravado** quando enviado; `kind` é livre (aceita `paste` hoje). Cap de 20.000 eventos/tentativa (poda por `serverTs`).
- Persistência **em disco**: tabela `exam_keystrokes` (database.js:141/547/816). **[CORRIGIDO]** não é volátil.
- Leitura ao vivo via `GET /api/admin/exam-keystrokes/:class/:examKey` com polling de 2s (MonitorPage:275–303). Suporta `sinceSeq` e `limit` (proctoring.js:180–195), mas o cliente hoje **não** usa `sinceSeq` (refaz o fetch inteiro).
- `monitor-status` (admin.js:2837+) devolve, por aluno: `keystrokeCount`, `suspiciousCount`, `lastKeystrokeAt`, `progress` (**string** `"resp/total"`), `logs` (proctoring: `tab_blur`, `exam_left`, `fullscreen_exit`, com campos `eventType`/`timestamp`).
- `classifyCombo` (ExamRunner:23–35) classifica atalhos: `copiar_recortar` (bloqueia), `colar` Ctrl+V (permite, sinaliza), `buscar_imprimir_salvar`, `devtools`, `assistente_ia` (Alt+G — **candidato a validar**).

**O que já foi corrigido nesta frente (pré-requisito, concluído e confirmado):**

- Permissão da rota `exam-keystrokes` liberada para professores (`adminPermissions.js:145`, junto de `monitor-status`/`proctoring-logs`, exigindo `page.monitor`) e incluída no escopo de turma (`middlewares.js:464`). Sem isso o painel retornava 403 → "0 eventos". **Verificado: está aplicado.**

**Realidade atual da prova (contexto que muda o valor de cada feature):** **[CORRIGIDO/NOVO]**

- As questões são **múltipla escolha respondida por clique** (ExamRunner:742–782, `<button>` por alternativa). **Não há campo digitável.**
- Logo, hoje **não há texto de resposta para reconstruir**. Os eventos `char` capturados são teclas soltas (o listener é global), sem destino. A colagem também não tem onde cair.
- **Consequência:** no estado atual o valor real está em **Alertas** (atalhos/cópia/foco) e **Timeline/stats**. A **reconstrução de texto** e a **captura de `paste`/`question`** só entregam valor com as dissertativas.

**Lacunas a resolver:**

- Eventos gravam `question: null` no cliente (ExamRunner:162) → não há como agrupar por questão (irrelevante até existir dissertativa).
- Não existe listener de `paste` → não se captura tamanho/conteúdo colado.
- Frontend só lista eventos crus; não separa alertas, não mostra ritmo, não tem stats/filtro/export.
- `examKeystrokes` não entra na rotina de expurgo (§10).

---

## 3. Arquitetura da solução

Fluxo de dados (sem novas dependências):

```
ALUNO (ExamRunner)                    BACKEND                         PROFESSOR (MonitorPage)
─────────────────                     ───────                         ──────────────────────
keydown/paste/copy  ──lote 2s──▶  POST log-keystrokes ──▶ examKeystrokes[] (em disco)
                                                                  │
                                   GET exam-keystrokes  ◀──poll 2s─┤ fetchKeystrokes()
                                        (events[])       ──────────▶│
                                                                  │
                                   monitor-status (logs[]) ───────▶│ (já vem no poll das linhas)
                                                                  ▼
                                              Camada de derivação no cliente:
                                              • (F2) reconstrução de texto por questão
                                              • merge keystrokes + logs de foco → Alertas
                                              • agregação por janela de tempo → Timeline
                                              • stats (total, suspeitos, gap, última atividade)
```

**Decisão-chave:** quase tudo é **derivado no cliente** a partir de dados que o backend já entrega. As únicas mudanças de captura/persistência (preencher `question`, capturar `paste`, campos novos) ficam para a fase das dissertativas, onde passam a ter sentido.

---

## 4. Modelo de dados

Nenhuma tabela nova. O store `examKeystrokes` já aceita `kind` e `question` livres e **já grava `question`**; só passaremos a preenchê-los melhor no cliente.

| Campo | Hoje | Depois |
|---|---|---|
| `kind` | `char` / `key` / `shortcut` / `clipboard` / `contextmenu` | + `paste` (backend já aceita) |
| `question` | enviado `null` pelo cliente (backend grava o que vier) | número da questão em foco (quando houver campo digitável) |
| `key` | tecla | inalterado |
| `blocked` / `suspicious` | ok | inalterado |
| `pasteLen` (novo, opcional) | — | nº de caracteres colados (kind=`paste`) |
| `pastePreview` (novo, opcional) | — | prévia curta e truncada (ver §10 privacidade) |

Migração: nenhuma. Eventos antigos com `question:null` caem no balde "sem questão".

---

## 4.1 Dicionário de eventos capturados e níveis de suspeita (fonte única) **[NOVO]**

Esta é a **lista canônica** do que é capturado, como o painel deve rotular cada coisa e qual a gravidade. Serve de fonte de verdade tanto para a classificação (`classifyCombo`, `kind`) quanto para a renderização legível no `KeystrokeViewer`. Baseada no código atual (`classifyCombo` ExamRunner:23–35 + `kind` gravado + logs de proctoring).

**Legenda de gravidade:** 🔴 Alta (sinal forte de fraude) · 🟡 Média (registrar/observar) · ⚪ Baixa (ruído, não deve contar como suspeito).

| # | Evento capturado | Gatilho / `reason` | Bloqueia hoje? | Rótulo no painel | Gravidade sugerida |
|---|---|---|---|---|---|
| 1 | Copiar / recortar | `Ctrl/Cmd + C` ou `X` (`copiar_recortar`) | Sim | "Tentou copiar / recortar" | 🔴 Alta |
| 2 | Evento de cópia/recorte real | `copy`/`cut` (`kind:clipboard`) | Sim | "Cópia bloqueada" | 🔴 Alta |
| 3 | Menu do botão direito | `contextmenu` (`kind:contextmenu`) | Sim | "Abriu menu do botão direito" | 🟡 Média |
| 4 | Atalho de assistente de IA | `Alt + G` (`assistente_ia`) | Sim | "Atalho de IA (Alt+G)" | 🔴 Alta **(validar tecla)** |
| 5 | DevTools / inspecionar | `Ctrl/Cmd+Shift+I/J/C` ou `F12` (`devtools`) | Sim | "Abriu ferramentas de desenvolvedor" | 🔴 Alta |
| 6 | Buscar / imprimir / salvar | `Ctrl/Cmd + F/P/S` (`buscar_imprimir_salvar`) | Sim | "Buscar/Imprimir/Salvar página" | 🟡 Média |
| 7 | Colar | `Ctrl/Cmd + V` (`colar`) | Não (permitido) | "Colou conteúdo" | 🟡 Média (🔴 se houver `pasteLen` grande — F2) |
| 8 | Colagem com conteúdo | `paste` (`kind:paste`, F2) | Não | "Colou N caracteres" | 🔴 Alta se N alto |
| 9 | Tecla de sistema | `Meta`/Win sozinha (`tecla_sistema`) | Não | — (não exibir como alerta) | ⚪ Baixa (ruído) |
| 10 | Atalho genérico | qualquer outro `Ctrl`/`Alt` (`atalho`) | Não | "Atalho: <combo>" | ⚪ Baixa por padrão |
| 11 | Saiu do foco / trocou de aba | `tab_blur` (proctoring, pausa a prova) | Pausa | "Saiu do foco da prova" | 🔴 Alta |
| 12 | Saiu da prova / recarregou | `exam_left` (proctoring) | Pausa | "Fechou ou recarregou a prova" | 🔴 Alta |
| 13 | Saiu da tela cheia | `fullscreen_exit` (proctoring, pausa) | Pausa | "Saiu da tela cheia" | 🔴 Alta |
| 14 | Digitação normal | `kind:char` (tecla imprimível) | Não | agrupado em bloco de texto | ⚪ Não é alerta |
| 15 | Tecla de controle | `kind:key` (setas, Tab, etc.) | Não | contexto do fluxo | ⚪ Não é alerta |

**Decisões que a tabela força (a validar com você):**

1. **`suspicious` hoje é amplo demais.** No código, `suspicious = !!cls`, então itens 9 e 10 (tecla Windows, Ctrl+A, Ctrl+setas) entram na conta de suspeitos e poluem o contador/alertas. Proposta: o painel usa a **gravidade** desta tabela — só 🔴/🟡 contam como "comandos suspeitos"; ⚪ fica no fluxo mas não vira alerta nem incha o número. (Sem mexer na captura; é filtro de exibição. Opcionalmente, ajustar a flag na origem numa etapa posterior.)
2. **Validar `Alt+G`** (item 4): o comentário no código diz "atalho candidato do Gemini". Confirmar antes de rotular como "IA" com destaque forte.
3. **Colar (itens 7/8):** hoje só se vê o `Ctrl+V`; o tamanho/conteúdo do que foi colado só existe na Fase 2 (`pasteLen`/`pastePreview`). Sem isso, o rótulo fica "Colou conteúdo" sem o "N caracteres".
4. **A lista `blocked` × `suspicious`** já vem por evento do backend; o painel não precisa reclassificar — só mapear `reason`/`kind`/`eventType` → rótulo + gravidade desta tabela.

---

## 5. Backend — mudanças (mínimas)

### 5.1 Aceitar novos campos no `log-keystrokes` (proctoring.js:129–149)
`kind` e `question` **já são aceitos/gravados**. Falta apenas incluir, de forma defensiva (com limite de tamanho, igual aos demais):

- `pasteLen`: `Number(ev.pasteLen) || null`.
- `pastePreview`: `typeof ev.pastePreview === 'string' ? ev.pastePreview.slice(0, 120) : null` (respeitando §10).

Risco: baixo. Aditivo; nenhum campo existente muda.

### 5.2 Export de histórico (opcional, recomendável)
- **Opção A (recomendada, zero backend):** gerar CSV no cliente a partir dos `events` já carregados.
- **Opção B:** nova rota `GET /api/admin/exam-keystrokes-export/:class/:examKey` devolvendo CSV. Exigiria registrar a permissão `page.monitor` (mesmo padrão de `adminPermissions.js:145`) e o escopo de turma (`middlewares.js:464`).

Recomendo A no MVP.

### 5.3 Permissão/escopo
Já resolvido para `exam-keystrokes`. Se a Opção B for adotada, replicar o padrão nos dois arquivos (senão o professor toma 403).

### 5.4 Expurgo **[NOVO]**
Incluir `db.memory.examKeystrokes` na rotina de flush de estado de prova (`adminSystem.js:~60`, hoje limpa `studentExamState`/`proctoringLogs`/`broadcastMessages`/`submissions`, mas **não** os keystrokes). Sem isso os keystrokes acumulam em disco indefinidamente. Ver §10.

---

## 6. Frontend — professor (`MonitorPage.jsx`)

Refatorar o `Modal` de digitação (hoje ~linhas 936–964) em um componente dedicado, ex.: `KeystrokeViewer`, mantendo `openKeystrokeWatch`/`fetchKeystrokes`/polling que já existem.

### 6.1 Estados novos
- `viewMode`: `'alerts' | 'stream' | 'text'` (aba ativa). **[CORRIGIDO]** default = `'alerts'` (é o que tem valor hoje); `'text'` só aparece se houver questão digitável.
- `susOnly`: boolean (filtro "só suspeitos" no fluxo de teclas).
- Passar os `logs` do aluno ao viewer. **[CORRIGIDO]** hoje `openKeystrokeWatch(row)` guarda só `{email, name}` (MonitorPage:289–293); precisa também repassar `row.logs` (vêm do monitor-status) para o merge de alertas.

### 6.2 Reconstrução de texto por questão (view "text") — **só com dissertativas** **[CORRIGIDO]**
A aba nasce **oculta/desabilitada** enquanto não houver evento com `question` preenchido / campo digitável. Quando existir, algoritmo (puro, memoizado sobre `keystrokeEvents`):

1. Ordenar por `seq`.
2. Agrupar por `question` (`null` → grupo "Sem questão / digitação avulsa").
3. Varrer os eventos: `char`→concatena `key`; `Backspace`→remove último (clampar em 0); `Enter`→quebra de linha; `paste`→marcador "⧉ [colado: N caracteres]" (+prévia se houver); atalhos/clipboard/contextmenu→ignorados no texto (vão para Alertas).
4. Rodapé com métricas (edições, backspaces, houve colagem).

**Rótulo obrigatório na UI ("aproximado"):** a reconstrução por `keydown` não captura cursor (setas), seleção+substituição, IME/autocorreção/voz. É **aproximação**, não transcrição. Para exatidão, ver §7.3 (snapshots de `input`).

### 6.3 Fluxo de teclas (view "stream")
Lista cronológica de chips (como hoje, estilizada): `char` neutro, suspeitos em vermelho. Filtro `susOnly`. Timestamp por evento — usar `clientTs` para exibição e `serverTs` para ordenação (ver §9).

### 6.4 Alertas (view "alerts") — merge de duas fontes **[CORRIGIDO]**
Combinar, ordenado por tempo:

- De `keystrokeEvents`: `suspicious || blocked` (cópia, recorte, menu, atalhos, colagem, `assistente_ia`).
- De `row.logs` (proctoring): `tab_blur`, `exam_left`, `fullscreen_exit` → "Saiu do foco / Fechou ou recarregou / Saiu da tela cheia".

**Sobre duração:** **não há evento de retorno (`tab_focus`)** — não dá para medir quanto tempo o aluno ficou fora. Mostrar **horário do evento** e, no máximo, o intervalo até a **próxima atividade** (keystroke/log seguinte) rotulado como "tempo até retomar (aprox.)". Não prometer duração exata de ausência.

Cada alerta: ícone, título, descrição curta, horário. Destaque para **saída de foco** e **colagem**. Badge numérico na aba = total de alertas.

### 6.5 Timeline de ritmo **[CORRIGIDO]**
- Agregar eventos em janelas fixas (bins de ~10s cobrindo os últimos ~5 min). Altura = nº de teclas no bin; vermelho se contém suspeito.
- **Atenção ao comportamento do sistema:** ao perder foco a prova **pausa** e a captura de teclas para (o `useEffect` sai da fase `active`). Portanto todo `tab_blur` já vira, por natureza, um vazio no timeline **e** um log de foco. A "detecção de gap coincidindo com `tab_blur`" é então **redundante** com o próprio alerta de foco — evitar duplicar o aviso. O gap "puro" (sem log de foco, aluno parado dentro da prova) é fraco como sinal de fraude; tratar como informativo, não como alerta forte.

### 6.6 Header de stats
Derivar do que já vem: `keystrokeCount`, `suspiciousCount`, `progress` (**string** `"resp/total"` — usar direto), `lastKeystrokeAt` → "última atividade há Xs".

### 6.7 Export (Opção A)
Botão "Exportar histórico" → CSV client-side dos `events` (colunas: seq, hora, questão, tipo, tecla, suspeito, bloqueado). `Blob` + download. Sem backend.

---

## 7. Captura no aluno (`ExamRunner.jsx`) — **fase das dissertativas**

### 7.1 Preencher `question`
- **Questões de clique (atuais):** sem campo digitável; seguem `question:null` (correto).
- **Questões dissertativas (futuras):** `<textarea>` com `data-question={q.number}`; no handler, `e.target.closest('[data-question]')?.dataset.question` → grava em `question`.

### 7.2 Capturar colagem (`paste`)
Listener `paste` (capture) durante `phase==='active'`: ler `e.clipboardData.getData('text')`, gravar `kind:'paste'`, `pasteLen`, `suspicious:true`, `blocked:false`, `question` do campo em foco; flush imediato.
**Nota [CORRIGIDO]:** sem alvo editável o evento `paste` normalmente **não dispara**; por isso este item vive junto das dissertativas, não antes.

### 7.3 (Opcional, exatidão) Snapshots de `input`
Para transcrição fiel, capturar `value` do textarea via `input` (debounce ~1s) associado à questão. Mais preciso e imune a IME/colagem. Trade-off de dados/privacidade. Fica para a fase das dissertativas.

### 7.4 Não regredir o antifraude existente
Manter intactos: pausa por foco/blur, tela cheia, bloqueio de copy/cut/contextmenu, `beforeunload`/`pagehide`. As adições são apenas observacionais.

---

## 8. Fases de entrega **[REORDENADO]**

**Fase 1 — MVP do monitor (só `MonitorPage.jsx`, backend já pronto):**
Abas **Alertas + Fluxo** (default Alertas) + Timeline + stats + filtro "só suspeitos" + export CSV client-side. Merge de `keystrokeEvents` com `row.logs`. Aba **Texto oculta** (sem questão digitável ainda). Entrega de valor imediata: atalhos, colagem via Ctrl+V, e principalmente **saídas de foco**.
_Arquivos: `MonitorPage.jsx` (+ subcomponente `KeystrokeViewer`)._

**Fase 2 — Dissertativas + captura rica (acopladas):** _(antes eram Fase 2 e 3 separadas)_
`data-question` nos `<textarea>` + binding de `question` + listener `paste` (`pasteLen`/`pastePreview`) + (opcional) snapshots `input` para transcrição fiel; campos novos no backend; aba **Texto** passa a aparecer e a reconstrução vira precisa por questão.
_Arquivos: `ExamRunner.jsx`, `proctoring.js`, `MonitorPage.jsx` (mostrar aba Texto)._

**Fase 3 — Higiene:** incluir `examKeystrokes` no expurgo (`adminSystem.js`) e definir retenção (§10). Pode ir junto da Fase 1 (é barato e independente).

---

## 9. Casos de borda

- **Aluno em fase não-ativa** (espera/pausa): captura desligada; viewer deve indicar "aluno pausado / sem captura no momento".
- **Muitos eventos:** cap de 20.000/tentativa no backend; no cliente, virtualizar/limitar render do fluxo cru.
- **`question:null` em massa** (provas de clique): grupo único discreto; e a aba Texto fica oculta (§6.2).
- **Backspace além do início do buffer:** clampar em 0.
- **Relógios divergentes** (`clientTs` vs `serverTs`): ordenar/timeline por `serverTs`; `clientTs` só exibição.
- **Colagem sem `clipboardData`:** registrar `paste` com `pasteLen:null` e marcar "colagem detectada (tamanho indisponível)".
- **Troca de aluno no viewer:** o `useEffect` (MonitorPage:295–303) já reinicia ao trocar `email`; garantir reset de abas/filtro junto.
- **Sem logs de foco:** Alertas mostra estado vazio positivo ("nenhum evento suspeito").

---

## 10. Segurança e privacidade

- **Escopo:** professor só vê alunos das turmas atribuídas — garantido por `middlewares.js:464`. Replicar na rota de export se criada.
- **Conteúdo colado / texto digitado é sensível.** Decidir: (a) só **tamanho**; (b) **prévia truncada**; (c) conteúdo completo (só dissertativas, com aviso ao aluno). Sugestão: MVP guarda só tamanho.
- **Aviso ao aluno:** a tela de instruções deve informar que digitação e eventos são monitorados durante a prova.
- **Retenção [CORRIGIDO]:** `examKeystrokes` **persiste em disco** (tabela `exam_keystrokes`) e **não** é limpo pela rotina de flush atual (`adminSystem.js`). Incluir no ciclo de expurgo e definir política de retenção pós-correção/encerramento.

---

## 11. Performance

- Polling 2s (já existe). `sinceSeq` está suportado na rota mas **não é usado** hoje pelo `fetchKeystrokes` — adotar para buscar só o delta em provas longas (otimização opcional).
- Derivações (reconstrução/timeline/merge) memoizadas (`useMemo`) sobre `keystrokeEvents`+`logs`.
- Render do fluxo cru limitado/virtualizado.

---

## 12. Testes

- **Unit (derivações):** reconstrução (char/backspace/enter/paste), agrupamento por questão, merge de alertas, binning da timeline. Funções puras.
- **E2E (Playwright, já configurado):** simular prova ativa, gerar keydown/blur, abrir o viewer como professor e assertir Alertas/Timeline/stats; validar filtro "só suspeitos" e export. (Paste/Texto só na Fase 2.)
- **Regressão:** múltipla escolha e antifraude de foco idênticos.
- **Permissão:** professor com `page.monitor` acessa; rota continua negando quem não tem escopo da turma.

---

## 13. Checklist de arquivos

| Arquivo | Fase | Mudança |
|---|---|---|
| `web/src/features/admin/MonitorPage.jsx` | 1 | `KeystrokeViewer`: abas (Alertas/Fluxo), timeline, stats, filtro, export; passar `row.logs`; aba Texto oculta |
| `backend/routes/adminSystem.js` | 1/3 | incluir `examKeystrokes` no expurgo |
| `web/src/features/student/exam/ExamRunner.jsx` | 2 | `data-question` nos textareas; binding `question`; listener `paste`; (opcional) snapshots `input` |
| `backend/routes/proctoring.js` | 2 | aceitar `pasteLen`/`pastePreview` (defensivo) — `kind:'paste'` e `question` já aceitos |
| `web/src/features/admin/MonitorPage.jsx` | 2 | exibir aba Texto quando houver `question` |
| `backend/utils/adminPermissions.js` | (feito) | `exam-keystrokes` liberada (linha 145); + export se Opção B |
| `backend/middlewares.js` | (feito) | escopo de turma p/ `exam-keystrokes` (linha 464) |

---

## 14. Estimativa (ordem de grandeza)

- **Fase 1 (MVP monitor):** ~1 dia — UI/derivações; backend já pronto. Inclui o expurgo (barato).
- **Fase 2 (dissertativas + paste + question + backend):** depende da feature de questão digitada; ~1–1,5 dia sobre ela.

---

## 15. Riscos e mitigação

- **Expectativa de "capturar tudo":** a página não vê digitação fora dela (outra aba/app/celular). O sinal anti-IA real é a **saída de foco** (destacada em Alertas/Timeline), não o keylog.
- **Aba Texto vazia/confusa antes das dissertativas:** por isso nasce oculta (§6.2).
- **Reconstrução aproximada:** rotular como "aproximado"; transcrição fiel só na Fase 2.
- **Duração de foco enganosa:** não há evento de retorno; não exibir duração de ausência como se fosse exata (§6.4).
- **Privacidade do conteúdo:** definir política de prévia/retenção antes de gravar texto colado/digitado.

---

**Próximo passo:** se aprovar, começo pela **Fase 1** (só `MonitorPage.jsx` + expurgo em `adminSystem.js`; sem risco ao fluxo de prova). Diga "execute Fase 1".
