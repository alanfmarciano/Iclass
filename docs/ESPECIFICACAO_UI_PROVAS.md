# Especificação de UI — Melhorias do Módulo de Provas

Complemento do `docs/arquivo/PLANO_IMPLEMENTACAO_PROVAS.md` (histórico). Este documento diz **como as telas devem ser** em cada passo: onde ficam, quais componentes usar, textos exatos (pt-BR), estados e comportamento. Destina-se a execução por agente de código (Codex/Claude) sem decisões de design em aberto.

## Regras gerais de UI (valem para todos os passos)

- **Usar SOMENTE o design system existente** em `web/src/components/ui/`: `Card`, `Button`, `Badge`, `Modal`, `ConfirmDialog`, `Tabs`, `Table`, `Select`, `Switch`, `Input`, `Textarea`, `EmptyState`, `PageState`, `PageHeader`, `StatCard`, `Skeleton`, `Timeline`. Não criar novos primitivos nem importar bibliotecas de UI.
- **Tokens de cor via classes já usadas no projeto**: `text-text`, `text-muted`, `text-subtle`, `bg-surface`, `bg-surface-2`, `border-border`, `bg-primary-soft text-primary`, `bg-danger-soft text-danger`, `bg-success-soft text-success`, `bg-warning-soft text-warning`, `bg-info-soft text-info`. Nunca cor hexadecimal hardcoded.
- **Tons de Badge**: `success` (aprovado/ok), `warning` (atenção/reprovado leve), `danger` (bloqueio/erro), `info` (informativo/em andamento), `neutral` (inativo/indefinido).
- **Toasts** via `useToast()` existente: `toast.success(...)`, `toast.error(...)`, `toast.info(...)`. Erros de API sempre `toast.error(e.message)`.
- **Datas** sempre `toLocaleString('pt-BR')` / `toLocaleDateString('pt-BR')`. Notas exibidas em escala 0–10 com 1 casa: `(score/10).toFixed(1)` (padrão já usado).
- **Carregamento/erro de página**: envolver conteúdo em `PageState` quando a tela depende de fetch inicial (padrão de `student/ProvasPage.jsx`).
- **Acessibilidade mínima**: todo campo com `label`; contadores/timers com `aria-live="polite"`; botões só-ícone com `aria-label`; foco visível preservado; modais fecham com ESC (o `Modal` já faz).
- **Responsivo**: grids colapsam para 1 coluna abaixo de `md`; nenhuma tabela nova sem scroll horizontal em telas pequenas (`overflow-x-auto`).
- **Idioma**: todos os textos em pt-BR, sem anglicismos na UI (usar "Tentativas", não "Attempts").

---

## P1 — Limite de tentativas

### Tela 1: `admin/ProvasPage.jsx` — formulário de aplicação online

**Onde:** no modal/painel de preparação da aplicação, na mesma seção dos campos "Duração (min)" e "Token de acesso" já existentes.

**Novo campo:**
- `Input` numérico com label **"Tentativas permitidas"** e placeholder **"Ilimitadas"**.
- Abaixo do campo, texto auxiliar (`text-xs text-subtle`): **"Deixe em branco para não limitar. Cada envio do aluno conta como uma tentativa."**
- Validação: aceitar vazio (= `null`) ou inteiro 1–10; valor inválido mostra `toast.error('Tentativas deve ser um número entre 1 e 10.')` e não envia.

### Tela 2: `student/ProvasPage.jsx` — card da prova

- No rodapé do card (linha do `Clock`), acrescentar quando `maxAttempts` existir: **"Tentativa X de Y"** (X = `attemptsUsed + 1` limitado a Y). Se esgotado, substituir o `Badge` de status por `Badge tone="neutral"` com texto **"Tentativas esgotadas"** e o card deixa de navegar para o runner (sem `cursor-pointer`).

### Tela 3: `student/exam/ExamRunner.jsx` — nova fase `exhausted`

- Layout idêntico às fases terminais existentes (componente `Center`):
  - Ícone: círculo `bg-warning-soft text-warning` com `ShieldAlert` 26px.
  - Título (`text-lg font-semibold text-text`): **"Tentativas esgotadas"**.
  - Texto (`text-sm text-muted`, máx. `max-w-sm`): **"Você já usou todas as N tentativas desta prova. Procure o professor se acredita que houve um engano."**
  - Botão `variant="secondary"` icon `ArrowLeft`: **"Voltar às provas"** → `nav('/aluno/provas')`.
- A fase é ativada quando o `sync` retornar `attemptsUsed >= maxAttempts` (antes das fases token/waiting), ou quando o submit responder 403 `attemptsExhausted`.

---

## P2 — Auditoria de lançamentos

### Tela: `admin/ResultadosPage.jsx` — modal de revisão da tentativa

**Onde:** dentro do modal de revisão já existente (aberto por `openSubmissionReview`), adicionar seção ao final.

- Título da seção (`font-semibold text-text text-sm`, com ícone `History` 16px): **"Histórico de ações"**.
- Lista vertical (sem tabela): cada entrada em uma linha `border-b border-border py-2`:
  - Linha 1 (`text-sm text-text`): descrição da ação. Mapeamento de `action` → texto: `manual_create` → "Nota lançada manualmente"; `archive` → "Tentativa arquivada"; `restore` → "Tentativa restaurada"; `select` → "Tentativa selecionada para o resultado"; `policy` → "Regra de cálculo alterada para {política}"; `publish` → "Nota publicada"; `unpublish` → "Publicação desfeita"; `delete` → "Tentativa excluída"; `feedback` → "Feedback registrado".
  - Linha 2 (`text-xs text-subtle`): **"por {nome ou e-mail} em {data pt-BR}"**. Autor ausente (registros antigos) exibe **"—"**.
- Estado vazio: `text-sm text-muted text-center py-4`: **"Nenhuma ação registrada para esta tentativa."**
- Na linha da tentativa lançada manualmente (tabela principal), adicionar `Badge tone="info"`: **"Manual"** quando `origin === 'manual'`.

---

## P3 — Notificações automáticas

### Tela: `student/AvisosPage.jsx` (ajuste opcional, fazer)

- Avisos com `system: true` recebem à esquerda do título um ícone `Bell` (ou `BellRing`) 14px `text-primary` e `Badge tone="info"` com texto **"Automático"**.
- Ordenação e comportamento de leitura permanecem os atuais.
- Textos gerados pelo backend (exatos):
  - Liberação: título **"Prova liberada: {título da avaliação}"**, corpo **"A prova {título} foi liberada para a sua turma. Acesse a página Provas para participar."**
  - Nota: título **"Nota publicada: {título da avaliação}"**, corpo **"Sua nota da prova {título} foi publicada. Veja o resultado na página Provas."**
  - `{título da avaliação}` = `examKey.replace(/_/g, ' ')` a menos que exista `evaluations[examKey].title`.

---

## P4 — UX do runner (confirmação + navegação)

### Tela: `student/exam/ExamRunner.jsx` (fase `active`)

**1. Painel de navegação de questões**
- Posição: coluna fixa à direita em telas `lg+` (`hidden lg:block`, `sticky top-20`, largura ~`w-40`); em telas menores, barra horizontal rolável (`flex overflow-x-auto gap-1.5`) logo abaixo do header sticky.
- Conteúdo: grade de botões quadrados 32×32 (`grid grid-cols-4 gap-1.5` na coluna; linha única no mobile), um por questão, numerados 1..N.
- Estados visuais do botão:
  - Respondida: `bg-primary text-primary-fg`.
  - Em branco: `bg-surface-2 text-muted border border-border`.
  - Marcada para revisão: acrescenta um ponto amarelo no canto (`after:` ou span absoluto `bg-warning`), independente de respondida.
  - Questão atualmente visível (opcional): anel `ring-2 ring-primary/50`.
- Clique: `scrollIntoView({ behavior: 'smooth', block: 'start' })` no card da questão (dar `id={'q-'+q.number}` aos cards).
- Acessibilidade: cada botão com `aria-label="Ir para a questão N"`.

**2. Marcar para revisão**
- Em cada card de questão, no canto superior direito: botão ícone `Flag` 16px, `variant="ghost"`, `aria-label="Marcar questão para revisão"`. Ativo = `text-warning`; inativo = `text-subtle`.
- Estado em `useState` local `flags` (Set de números); persistir junto do autosave apenas se trivial (campo extra ignorado pelo backend) — caso contrário somente local.

**3. Modal de confirmação de envio**
- Usar `Modal` com `title="Enviar prova?"`.
- Corpo:
  - Linha resumo (`text-sm text-text`): **"Você respondeu X de N questões."**
  - Se houver questões em branco, bloco `bg-warning-soft text-warning rounded-lg p-3 text-sm`: **"Em branco: 4, 7, 9"** (números clicáveis: fecham o modal e rolam até a questão).
  - Se houver marcadas para revisão: linha `text-xs text-muted`: **"Marcadas para revisão: 2, 5"**.
- Rodapé (footer do Modal): botão `variant="secondary"` **"Continuar revisando"** (fecha) e botão primário icon `Send` **"Enviar prova"** (chama `submit(false)`).
- O envio automático por tempo esgotado NÃO abre o modal (comportamento atual intacto).

---

## P5 — Pontos por questão + nota de corte

### Tela 1: `admin/EditorPage.jsx` (modo avaliação)

- No cabeçalho da avaliação (junto do título/tema): `Input` numérico **"Nota de corte (0–100)"**, largura ~`w-40`, default 60. Texto auxiliar: **"Alunos com nota igual ou acima são considerados aprovados."**
- Em cada questão: `Input` numérico **"Pontos"** (largura `w-24`, min 0.5, step 0.5, default 1) ao lado do número da questão.
- Rodapé da lista de questões (`text-sm text-muted`): **"Total da prova: {soma} pontos"** — recalcula ao digitar.
- Validação no salvar: pontos ≤ 0 → `toast.error('Cada questão deve valer mais que zero pontos.')`.

### Tela 2: `admin/ResultadosPage.jsx` e `student/ProvasPage.jsx`

- Onde já existe badge de nota com corte fixo 60, passar a usar `submission.passingScore ?? 60`. Sem mudança visual além do limiar.
- No detalhe da tentativa (aluno) e na revisão (professor), acrescentar linha (`text-xs text-subtle`): **"{earnedPoints} de {totalPoints} pontos · corte {passingScore/10 exibido como 0–10}"** quando os campos existirem.

---

## P6 — Boletim consolidado

### Tela 1: `admin/ResultadosPage.jsx` — nova aba

- Adicionar `Tabs` no topo da página com abas **"Notas"** (conteúdo atual) e **"Boletim"** (novo). Estado da aba em `useState`, não em rota.
- Aba Boletim:
  - Filtros no topo (mesma linha, `flex gap-2 flex-wrap`): `Select` de curso e `Select` de turma (reaproveitar os selects já existentes na página).
  - Conteúdo: `Table` com colunas: **Aluno** | uma coluna por avaliação (cabeçalho = título curto da prova, `max-w-[120px] truncate`, `title=` nome completo) | **Média final** | **Situação**.
  - Célula de nota: `(score/10).toFixed(1)`; não publicada = **"—"** com `title="Nota ainda não publicada"`; recuperação (P9) acrescenta `Badge tone="info"` "Rec".
  - Situação: `Badge tone="success"` **"Aprovado"** / `tone="danger"` **"Reprovado"** / `tone="neutral"` **"Pendente"**.
  - Acima da tabela, à direita: `Button variant="secondary"` icon `Download` **"Exportar boletim"**.
  - Configuração de pesos: botão `variant="ghost"` icon `Settings2` **"Pesos das avaliações"** → `Modal` com uma linha por avaliação (`label` = título, `Input` numérico peso, default 1) e **"Média para aprovação"** (`Input` 0–100, default 60). Salvar → `toast.success('Pesos atualizados')` e tabela recalcula.
  - Estado vazio: `EmptyState` icon `GraduationCap`, título **"Sem notas publicadas"**, descrição **"O boletim aparece quando houver avaliações com notas publicadas para esta turma."**

### Tela 2: aluno — bloco "Meu boletim" em `student/ProvasPage.jsx`

- `Card` ao final da página (depois de "Concluídas"), título com ícone `GraduationCap`: **"Meu boletim"**.
- Lista simples: uma linha por avaliação publicada — nome da prova à esquerda, nota à direita (mesmo padrão visual das linhas de "Concluídas"). Última linha destacada (`font-semibold`): **"Média final"** + nota + `Badge` de situação.
- Se nada publicado: não renderizar o card.

---

## P7 — Banco de questões completo

### Tela: seção do banco de questões (em `admin/ProvasPage.jsx` ou onde está hoje embutida)

- **Barra de filtros** (linha única, `flex gap-2 flex-wrap`): `Input` busca com placeholder **"Buscar por texto..."** (filtra com debounce 300ms), `Select` **Categoria** (opções distintas existentes + "Todas"), `Select` **Dificuldade** (Todas/Fácil/Média/Difícil), `Input` **Tag** (texto livre, contém).
- **Lista**: cada questão em `Card` compacto com: enunciado truncado em 2 linhas (`line-clamp-2`), `Badge tone="neutral"` categoria, `Badge` dificuldade (`success` fácil / `warning` média / `danger` difícil), tags como chips `text-xs bg-surface-2 rounded-full px-2 py-0.5`, origem (`text-xs text-subtle`: "Origem: {sourceExamKey}" ou "Criada no banco").
- **Ações por questão**: botão ícone `Pencil` (**editar**) e `Trash2` (**excluir**, com `ConfirmDialog`: título **"Excluir questão?"**, descrição **"Esta ação não pode ser desfeita."**, `danger`).
- **Edição**: `Modal size="lg"` com: `Textarea` **"Enunciado"**, lista de alternativas (`Input` texto + radio "Correta" por linha, mínimo 2, botão "Adicionar alternativa" até 5), `Select` **Dificuldade**, `Input` **Tags (separadas por vírgula)**, `Select` **Categoria**. Salvar → `toast.success('Questão atualizada')`.
- **Seleção múltipla**: checkbox no canto de cada card; barra fixa inferior (aparece quando ≥1 selecionada, `sticky bottom-4`, `Card` com sombra): **"N questões selecionadas"** + `Button` primário **"Criar avaliação"** + `Button variant="ghost"` **"Limpar seleção"**.
- **Criar avaliação**: `Modal` com `Input` **"Título da avaliação"** (obrigatório) e `Select` **"Vincular à unidade"** (opcional; lista unidades do curso ativo). Confirmar → `toast.success('Avaliação criada com N questões')`.
- Estado vazio da lista: `EmptyState` icon `DatabaseZap` título **"Banco vazio"** descrição **"Importe questões de uma avaliação existente ou crie uma nova questão."**

---

## P8 — Agendamento de prova

### Tela 1: `admin/ProvasPage.jsx` — aplicação

- Na preparação da aplicação online, acrescentar `Switch` **"Agendar início e fim"** (default off).
  - Off: fluxo atual (sala de espera/manual).
  - On: dois campos `Input type="datetime-local"`: **"Início"** (obrigatório, futuro) e **"Encerramento"** (opcional, > início). Validação: início no passado → `toast.error('O horário de início deve ser no futuro.')`; fim ≤ início → `toast.error('O encerramento deve ser depois do início.')`.
- Após confirmar, o card/linha da prova mostra `Badge tone="info"`: **"Agendada · {dd/mm hh:mm}"**.

### Tela 2: `admin/MonitorPage.jsx`

- Quando `status === 'scheduled'`: banner `Card` no topo (`bg-info-soft`): ícone `CalendarClock`, texto **"Prova agendada para {data}. Iniciará automaticamente."** + botão `variant="secondary"` **"Iniciar agora"** (chama o control `running` atual, que sobrepõe o agendamento).

### Tela 3: aluno

- `student/ProvasPage.jsx`: card com `Badge tone="info"` **"Agendada"** e subtítulo **"Inicia em {contagem hh:mm:ss}"** (mesma linha do relógio). Card clicável leva ao runner.
- `ExamRunner.jsx`: nova fase `scheduled` reutilizando o layout da fase `waiting` — ícone `Clock` em `bg-info-soft text-info`, título **"Prova agendada"**, texto **"A prova iniciará automaticamente no horário definido pelo professor."**, contagem grande `fmtTime` com `aria-live="polite"`. Ao zerar, chama `sync()` e entra no fluxo normal.

---

## P9 — Recuperação / segunda chamada

### Tela 1: `admin/ResultadosPage.jsx` (ou `AlunoDetailPage`) — liberar reaplicação

- No agrupamento de tentativas de um aluno×prova, menu de ações ganha item **"Liberar recuperação"** (icon `RotateCcw`).
- `Modal` **"Liberar reaplicação"** com: `Select` **"Tipo"** (Recuperação / Segunda chamada), `Input` numérico **"Tentativas"** (default 1), texto informativo (`text-xs text-muted`): **"Somente este aluno verá a prova novamente. As notas de recuperação seguem a regra definida no curso."** Confirmar → `toast.success('Reaplicação liberada para {nome}')`.
- Tentativas de recuperação na tabela recebem `Badge tone="info"` **"Rec"** (ou **"2ª ch."**).
- Configuração da regra: no modal de pesos do boletim (P6), acrescentar `Select` **"Nota de recuperação"** com opções **"Vale a maior"** / **"Substitui a nota"** / **"Média das duas"**.

### Tela 2: aluno

- `student/ProvasPage.jsx`: card da prova reaberta mostra `Badge tone="info"` **"Recuperação"**.
- `ExamRunner.jsx`: na fase ativa, ao lado da versão no header, mesmo badge.

---

## P10 — Fullscreen + copiar/colar

### Tela 1: `admin/ProvasPage.jsx` — aplicação

- Dois `Switch` na seção de segurança da aplicação (criar subseção com título `text-xs uppercase tracking-wider text-subtle`: **"Segurança"**, onde já fica o token):
  - **"Exigir tela cheia"**
  - **"Travar prova ao sair da tela cheia"** (desabilitado/cinza quando o primeiro está off).

### Tela 2: `ExamRunner.jsx`

- Nova tela intermediária (fase `fullscreen-gate`, antes de `active`, layout `Center`): ícone `Maximize` em `bg-primary-soft text-primary`, título **"Modo tela cheia"**, texto **"Esta prova exige tela cheia. Ao sair dela, a prova será pausada e o professor será notificado."**, botão primário **"Entrar na prova em tela cheia"** (chama `requestFullscreen()` e avança).
- Saída de fullscreen com trava ativa → reutilizar a tela `paused` atual, trocando o texto para **"Detectamos que você saiu da tela cheia. Aguarde a liberação do instrutor para continuar."**
- Bloqueio de copiar/colar: sem UI adicional; ao bloquear, mostrar `toast.info('Copiar e colar está desativado durante a prova.')` no máximo 1 vez por minuto.

### Tela 3: `admin/MonitorPage.jsx`

- Nos logs por aluno, novos eventos com rótulos: `fullscreen_exit` → **"Saiu da tela cheia"**; `copy_attempt` → **"Tentou copiar"**; `paste_attempt` → **"Tentou colar"**; `contextmenu` → **"Abriu menu de contexto"**. Mesmo estilo visual dos eventos atuais.

---

## P11 — Feedback do professor

### Tela 1: `admin/ResultadosPage.jsx` — modal de revisão

- Abaixo do cabeçalho do modal: `Textarea` **"Comentário geral para o aluno"** (placeholder **"Visível para o aluno após a publicação da nota."**, 3 linhas).
- Em cada questão renderizada na revisão: link/botão `variant="ghost"` `text-xs` **"+ Comentar questão"** que expande um `Textarea` compacto (2 linhas). Com texto salvo, o botão vira **"Editar comentário"** e o texto aparece em bloco `bg-info-soft rounded-lg p-2 text-sm`.
- Rodapé do modal: `Button` primário **"Salvar feedback"** → `toast.success('Feedback salvo')`.

### Tela 2: aluno — detalhe da tentativa (`student/ProvasPage.jsx`, modal `detail`)

- Após publicação: bloco no topo `bg-info-soft rounded-lg p-3` com ícone `MessageSquare` e o comentário geral; comentários por questão aparecem sob a questão correspondente (quando o gabarito estiver liberado) ou em lista **"Comentários do professor"** (quando não estiver).
- Antes da publicação: nada é exibido.

---

## P12 — Verdadeiro/Falso e múltipla seleção

### Tela 1: `admin/EditorPage.jsx`

- Em cada questão: `Select` **"Tipo"** com opções **"Múltipla escolha"** (default), **"Verdadeiro ou Falso"**, **"Múltiplas corretas"**.
  - VF: alternativas fixas **"Verdadeiro"** / **"Falso"** (inputs de texto desabilitados), radio para a correta.
  - Múltiplas corretas: radios viram checkboxes (≥1 correta obrigatória; salvar com 0 corretas → `toast.error('Marque ao menos uma alternativa correta.')`).

### Tela 2: `ExamRunner.jsx`

- MC e VF: visual atual (botões-alternativa exclusivos).
- Múltiplas corretas: mesmos botões, mas com marcador quadrado (checkbox visual) em vez do círculo com letra; seleção alterna sem desmarcar as demais; abaixo do enunciado, linha `text-xs text-muted`: **"Marque todas as alternativas corretas."**
- Painel de navegação (P4): questão multi conta como respondida se ≥1 marcada.

### Tela 3: revisões (professor e aluno)

- Multi: cada alternativa mostra os mesmos indicadores atuais de correta/selecionada; acerto da questão = `Badge tone="success"` **"Correta"** ou `tone="danger"` **"Incorreta"** no cabeçalho da questão (tudo-ou-nada).

---

## P13 — Dissertativas + fila de correção

### Tela 1: `admin/EditorPage.jsx`

- `Select` Tipo ganha **"Dissertativa"**. Ao escolher: some a lista de alternativas; aparecem `Textarea` **"Rubrica de correção (visível só para o professor)"** e o campo **"Pontos"** (P5) permanece.

### Tela 2: `ExamRunner.jsx`

- Questão dissertativa: `Textarea` auto-expansível (mín. 4 linhas, `maxLength` 10000) com contador `text-xs text-subtle` **"{n}/10000"** e placeholder **"Escreva sua resposta..."**. Conta como respondida no painel se texto não vazio.
- Tela final pós-envio quando houver dissertativa: em vez de nota, ícone `Clock` `bg-info-soft text-info` e texto **"Prova enviada! Sua nota sairá depois que o professor corrigir as questões dissertativas e publicar o resultado."**

### Tela 3: `admin/ResultadosPage.jsx` — aba "Correção pendente"

- Nova aba no `Tabs` (P6): **"Correção pendente"** com contador no rótulo quando > 0: **"Correção pendente (3)"**.
- Lista: um `Card` por submissão pendente: nome do aluno, prova, data, `Badge tone="warning"` **"Aguardando correção"**, botão **"Corrigir"**.
- Tela de correção (`Modal size="lg"` ou painel): para cada dissertativa da tentativa, layout em duas colunas (`grid md:grid-cols-2 gap-4`):
  - Esquerda: enunciado + resposta do aluno (`bg-surface-2 rounded-lg p-3 whitespace-pre-wrap`).
  - Direita: rubrica (`bg-info-soft rounded-lg p-3 text-sm`), `Input` numérico **"Pontos (0 a {max})"** (validação: 0 ≤ x ≤ max), `Textarea` **"Comentário (opcional)"**.
- Rodapé: **"Salvar correção"**; quando todas as dissertativas da tentativa tiverem pontos, `toast.success('Correção concluída — nota recalculada.')` e o card sai da fila.
- Tentar publicar com pendência: `toast.error('Há questões dissertativas sem correção nesta seleção.')` e nenhuma nota é publicada.

### Tela 4: aluno

- Em "Concluídas": tentativa pendente mostra `Badge tone="warning"` **"Em correção"** no lugar da nota.
- Detalhe pós-publicação: dissertativa exibe resposta enviada, **"{pontos} de {max} pontos"** e comentário do professor (bloco `bg-info-soft`).

---

## P14 — Tempo adicional automático

### `admin/MonitorPage.jsx`
- Na linha do aluno com tempo estendido: `Badge tone="info"` **"+{percent}%"** ao lado do timer, com `title="Tempo adicional de acessibilidade aplicado automaticamente"`.
- Sem nenhuma mudança no runner do aluno (timer já vem do servidor).

---

## P15 — Anular questão

### `admin/ResultadosPage.jsx` (visão por questão do analytics) 
- Ao lado de cada questão: botão `variant="ghost"` icon `Ban` **"Anular"**.
- `Modal` **"Anular questão {N}?"** com:
  - Radio (2 opções): **"Dar o ponto para todos"** / **"Remover a questão do total"** (default).
  - `Textarea` **"Motivo (registrado na auditoria)"** (obrigatório, mín. 5 chars).
  - Aviso `bg-warning-soft rounded-lg p-3 text-sm`: **"Todas as tentativas desta turma serão recorrigidas agora. Esta ação não pode ser desfeita."**
  - Botões: "Cancelar" / `Button` com `danger` **"Anular e recorrigir"** → `toast.success('Questão {N} anulada — {X} tentativas recorrigidas.')`.
- Questão anulada na lista: título riscado (`line-through text-subtle`) + `Badge tone="neutral"` **"Anulada"**.

### `ExamRunner.jsx` (aluno em prova)
- Card da questão anulada: `opacity-60`, alternativas desabilitadas, `Badge tone="neutral"` no topo: **"Questão anulada — não será corrigida"**. No painel de navegação (P4), o número aparece riscado.

### Revisões (professor e aluno)
- Questão anulada exibida com o mesmo badge e fora do cálculo mostrado ("{earned} de {total} pontos" já reflete).

---

## P16 — Contestação em tempo real

### `ExamRunner.jsx` — reportar problema
- Em cada card de questão, canto superior direito (ao lado do `Flag` do P4): botão ícone `AlertTriangle` 16px `variant="ghost"` `text-subtle`, `aria-label="Reportar problema nesta questão"`.
- Clique → `Modal` **"Reportar problema na questão {N}"**:
  - `Select` **"Qual é o problema?"**: "Nenhuma resposta parece correta" / "Há mais de uma resposta correta" / "Enunciado confuso" / "Erro de digitação" / "Outro".
  - `Textarea` **"Detalhe (opcional)"**, `maxLength` 300.
  - Botão **"Enviar para o professor"** → `toast.success('O professor foi notificado.')`.
- Depois de reportar: ícone vira `text-warning` fixo com `title="Problema reportado"`; novo clique mostra `toast.info('Você já reportou esta questão.')`.
- Questão substituída (chega via sync): entra ao final da lista com `Badge tone="info"` **"Questão adicional"** e o painel de navegação ganha o número novo.

### `admin/MonitorPage.jsx` — painel de contestações
- Novo bloco `Card` acima da tabela de alunos, visível só quando houver contestação aberta:
  - Cabeçalho: ícone `AlertTriangle` `text-warning` + **"Contestações ({N})"**.
  - Uma linha por questão contestada: **"Questão {N}"** + `Badge tone="warning"` **"{X} aluno(s)"** + motivos resumidos (`text-xs text-muted`, ex.: "2× sem resposta correta, 1× enunciado confuso").
  - Ações por linha (botões `size="sm"`): `variant="ghost"` **"Ver questão"** (Modal com enunciado + alternativas + gabarito destacado), `variant="secondary"` **"Descartar"**, `variant="secondary"` **"Anular..."** (abre o modal do P15), `Button` primário **"Anular e substituir..."**.
- Modal **"Substituir questão {N}"**:
  - Lista de questões do banco da mesma categoria (`Card` compacto selecionável por radio; busca por texto no topo). Vazio → `EmptyState`: **"Nenhuma questão compatível no banco. Importe ou crie questões primeiro."**
  - `Input` numérico **"Minutos extras para a turma"** (default 5, 0–30), com texto auxiliar: **"Compensa o tempo dos alunos que já tinham respondido a questão anulada."**
  - Aviso quando a prova estiver com menos de 5 min restantes ou pausada: bloco `bg-danger-soft` **"Não é possível substituir agora — tempo restante insuficiente ou prova pausada."** (botão confirmar desabilitado).
  - Confirmar → `toast.success('Questão substituída. Os alunos receberão a nova questão em instantes.')`.
- O contador do bloco atualiza pelo polling normal do Monitor (sem reload).

---

## P17 — Invalidar e reabrir tentativa

### `admin/ResultadosPage.jsx`
- No menu de ações da tentativa: item **"Invalidar e reabrir"** icon `RotateCcw`.
- `ConfirmDialog` título **"Invalidar esta tentativa?"**, descrição **"Ela não contará como tentativa nem entrará no resultado. Se a prova ainda estiver em andamento, o aluno poderá refazê-la."** + `Switch` **"Manter as respostas salvas do aluno"** (default off).
- Tentativa invalidada na tabela: linha com `opacity-60`, nota riscada, `Badge tone="neutral"` **"Invalidada"**.

### Aluno
- Em "Concluídas": tentativa invalidada aparece com o mesmo badge **"Invalidada"** e sem nota; o card da prova volta a ficar clicável se a prova estiver em andamento.

---

## P18 — Tela de instruções

### `admin/ProvasPage.jsx`
- Na preparação da aplicação: `Textarea` **"Instruções para o aluno (opcional)"**, placeholder **"Ex.: É proibido o uso de calculadora. A prova vale 40% da média."**, `maxLength` 2000, contador.

### `ExamRunner.jsx` — fase `instructions`
- Layout `Center` com `Card` `max-w-lg`:
  - Título com ícone `ClipboardList`: **"Instruções da prova"**.
  - Texto das instruções (`text-sm text-text whitespace-pre-wrap`).
  - Linha informativa (`text-xs text-muted`): **"Duração: {X} min · {N} questões · Tentativas: {Y ou 'ilimitadas'}"**.
  - Checkbox: **"Li e entendi as instruções"**.
  - `Button` primário largura total, desabilitado até o aceite: **"Iniciar prova"**.
- Sem instruções configuradas → fase pulada (comportamento atual).

---

## P19 — Pedido de revisão de nota

### Aluno — detalhe da tentativa (`student/ProvasPage.jsx`)
- Em cada questão (com gabarito liberado e nota publicada): link `text-xs` **"Discordo da correção"** → `Modal` **"Pedir revisão da questão {N}"** com `Textarea` **"Explique por que você acredita que a correção está incorreta"** (obrigatório, mín. 20 chars, máx. 500) e botão **"Enviar pedido"** → `toast.success('Pedido enviado ao professor.')`.
- Estados na questão: `Badge tone="warning"` **"Revisão em análise"**; resolvido: `Badge tone="neutral"` **"Nota mantida"** ou `tone="success"` **"Nota ajustada"**, com a resposta do professor em bloco `bg-info-soft rounded-lg p-2 text-sm`.

### `admin/ResultadosPage.jsx`
- Aba do `Tabs` (P6): **"Revisões"** com contador quando > 0.
- Fila: `Card` por pedido — aluno, prova, questão, argumento (`whitespace-pre-wrap`), a questão renderizada (enunciado + alternativas + escolhas) e:
  - `Textarea` **"Resposta ao aluno"** (obrigatória).
  - Botões: `variant="secondary"` **"Manter nota"** / `Button` primário **"Ajustar correção"** (marca a escolha do aluno como correta e recorrige) → toasts correspondentes.
- Vazio: `EmptyState` icon `CheckCircle2` **"Nenhum pedido de revisão pendente."**

---

## P20 — Alertas de tempo

### `ExamRunner.jsx`
- 5 min: timer do header vira `text-warning`; `toast.info('Restam 5 minutos de prova.')` (1×).
- 1 min: timer `text-danger` com `animate-pulse`; `toast.info('Último minuto!')` (1×).
- 10s: sobreposição discreta no canto inferior direito (`Card` pequeno `bg-danger-soft text-danger font-mono text-2xl`) com a contagem.
- `Switch` pequeno no header (ícone `Volume2`/`VolumeX`, `aria-label="Alerta sonoro"`): quando ativo, beep curto via WebAudio nos marcos de 5 min e 1 min. Preferência guardada só em memória.
- Todos os marcos com `aria-live="polite"`. Nada disso altera o envio automático.

---

## P21 — Importar questões

### Tela do banco de questões (P7)
- Botão no topo: `variant="secondary"` icon `Upload` **"Importar"**.
- `Modal size="lg"` **"Importar questões"** com `Tabs`:
  - **"Colar texto"**: `Textarea` grande (10 linhas) + bloco `bg-surface-2 rounded-lg p-3 text-xs font-mono` mostrando o formato de exemplo (mesmo formato markdown do parser existente).
  - **"Arquivo CSV"**: input de arquivo `.csv` + linha de exemplo do cabeçalho: `enunciado;altA;altB;altC;altD;correta;categoria;dificuldade`.
- Botão **"Pré-visualizar"** → lista de cards: questões válidas com check `text-success`; inválidas com `text-danger` e o motivo (**"Linha 3: nenhuma alternativa correta indicada"**). Contagem no topo: **"{X} válidas · {Y} com erro"**.
- Botão final **"Importar {X} questões"** (desabilitado com X=0) → `toast.success('{X} questões importadas para o banco.')`.

---

## Checklist final para o executor (todo passo)

1. Nenhum componente novo fora de `web/src/components/ui/`; nenhuma cor hardcoded.
2. Todos os textos acima são literais — usar exatamente como especificado.
3. Estados cobertos: loading (`PageState`/`Skeleton`), vazio (`EmptyState`), erro (`toast.error`).
4. Testar com perfil professor (escopo restrito) além do admin: telas devem esconder/bloquear o que o backend recusa.
5. Rodar `npm run build` em `web/` e a suíte de testes antes de dar o passo como concluído.
