# Plano de implementação — Dashboard v3

Redesenho da tela `web/src/features/admin/DashboardPage.jsx`, de "relatório em miniatura" para
"fila de trabalho do dia". Mockup aprovado: `mockup-dashboard-v3.html` (raiz).

Princípio de ordenação: **cada fase deixa o app funcionando e testável**. A Fase 1 entrega valor
sozinha, mesmo que o redesenho visual pare ali — ela corrige bugs que afetam a tela do aluno também.

---

## Decisões necessárias antes de começar

| # | Decisão | Recomendação |
|---|---|---|
| D1 | O mockup usa tokens do preset **premium**. Existe também o preset **lumen** (`web/src/styles/lumen.css`), com paleta e bordas diferentes. A tela precisa funcionar nos 4 cruzamentos (2 presets × 2 temas). | Implementar só com classes de token (`bg-surface`, `text-muted`…), nunca hex. Aí os 4 cruzamentos saem de graça. Validar visualmente em `lumen dark` antes de fechar. |
| D2 | A fila de pendências permite dispensar/adiar item? | **Sim, adiar por 24 h.** Persistir em `PreferencesProvider` (`dashboard.snoozed`), que já é servidor-side por conta. Sem isso, a fila vira papel de parede. |
| D3 | Um endpoint agregado ou três especializados? | **Três** (`/now`, `/queue`, `/trends`). Cada um tem custo e volatilidade diferente — `/now` é de segundos, `/trends` é de dias. Um payload só obrigaria a recarregar tudo a cada poll. |
| D4 | Manter a tela antiga durante a transição? | **Não.** Não há infra de feature flag e a Fase 1 já a deixa correta. Substituir de uma vez, com os snapshots atualizados na mesma leva. |
| D5 | Frequência por disciplina fica no Dashboard ou volta para Chamada? | Fica, **mas condicionada**: só renderiza se ≥ 50 % dos registros tiverem `disciplinaId`. Hoje são 16 de 223 — na base atual o bloco ficaria oculto, o que é o comportamento correto. |

---

## Fase 0 — Rede de segurança  ·  P

Hoje `.git/` está **vazia**: `git log` falha, não há histórico nem rollback.

- [ ] `git init` + commit inicial de tudo que está em disco
- [ ] `npm run test:full` — registrar o resultado como linha de base
- [ ] `npm run test:e2e` — confirmar que os 8 snapshots do dashboard passam **antes** de mexer
- [ ] Congelar os números atuais da turma 1DES (print da tela) para comparar depois da Fase 1

> Sem isso, qualquer divergência numérica na Fase 1 vira discussão sem árbitro.

---

## Fase 1 — Correções de dados no backend  ·  M

Bugs reais que existem hoje e contaminam Dashboard **e** tela do aluno. Nenhuma mudança visual.

### 1.1 `backend/utils/studentAnalytics.js`

| Linha | Bug | Correção |
|---|---|---|
| `:29-32` `mediaOf()` | Retorna `0` para lista vazia → "nunca fez prova" vira nota mínima | Retornar `null`; quem chama decide como exibir |
| `:189` `studentOverview()` | Soma **todas** as submissões do e-mail, sem filtrar por curso — diverge da média geral da tela | Aplicar o mesmo filtro de `courseId` |
| `:193` | `frequencia = 0` quando não há aula lançada → "sem dado" vira "0 % de presença" | Preservar `null` e devolver `presentes`, `faltasContam`, `totalAulas` no payload |
| `:161-173` `temporal` | Compara mês corrente (18 dias) contra mês anterior (30 dias) | Janela móvel: últimos 30 dias vs. os 30 anteriores |
| `:78` | `Object.keys(progressMap).filter(k => progressMap[k])` conta `[]` como concluído | Tratar array vazio como não concluído |

### 1.2 Consumidores a ajustar na mesma leva

Mudar `media` de `0` para `null` **quebra** quem chama `.toFixed()` direto:

- `web/src/features/admin/DashboardPage.jsx:232` — `o.media.toFixed(1)`
- `web/src/features/admin/AlunoDetailPage.jsx` — KPIs de média e comparativo com a turma
- Qualquer consumo de `computeStudentDashboard().kpis.media`

- [ ] Varrer com `grep -rn "\.media" web/src` antes de mudar a assinatura
- [ ] Guardas defensivas: `media == null ? '—' : media.toFixed(1)`

### 1.3 Frontend — `DashboardPage.jsx:100-102`

- [ ] `averageFrequency` deixa de fazer média aritmética incluindo zeros coeridos.
      Passa a ser **ponderada por aula** (`Σ presentes / Σ totalAulas`) e ignora quem tem `null`.
- [ ] `withoutAbsences` deixa de contar quem nunca teve chamada como "sem faltas"

### 1.4 Testes

- [ ] `test/backend/` — casos para: aluno sem prova (`media === null`), aluno sem chamada
      (`frequencia === null`), aluno com submissão de outro curso (não entra na média do curso)
- [ ] `npm run test:backend` verde

> **Ponto de verificação:** ao fim da Fase 1, a tela antiga continua de pé e já mostra números
> corretos. Se o projeto parar aqui, ainda houve ganho.

---

## Fase 2 — Endpoints de agregação  ·  G

Nenhum destes existe hoje. Todos em `backend/routes/admin.js`, com `validateAdmin` e escopo de
professor via `filterStudentsForAdmin`.

### 2.1 `GET /api/admin/dashboard/now`
Query: `courseId`, `studentClass`. Alimenta a faixa "Agora". Poll de ~30 s.
```
{
  aula:      { ordem, disciplinaId, nome, inicio, fim, toleranciaMin,
               chamadaStatus: 'nao_lancada'|'rascunho'|'concluida' } | null,
  proximaAula: { data, inicio, nome } | null,     // quando fora de horário
  aplicacao: { id, examKey, titulo, status, entregues, total, endsAt } | null,
  proximaAplicacao: { id, titulo, startsAt } | null,
  online:    { count, janelaMin: 5, ultimoAcessoAt }
}
```
Fontes: `classes.attendanceConfig.grade` + `gradeForDate()` (`attendance.js:124`) · `examApplications`
(FSM em `examApplications.js:14`) · `sessions`.

> **Atenção:** `database.js:719-756` reseta `activeExamKey` e re-bloqueia avaliações a cada boot.
> `proximaAplicacao` deve ler `examApplications.startsAt`, não o estado ativo da turma.

### 2.2 `GET /api/admin/dashboard/queue`
Cada item já vem com destino e contagem. Respeita `dashboard.snoozed` e permissões.
```
[{ id, tipo, titulo, detalhe, count, tone, href, permissao }]
```
Itens da v1:

| Tipo | Regra | Destino |
|---|---|---|
| `chamada_pendente` | aulas de hoje na grade sem registro `concluida` | `/chamada` |
| `duvidas_paradas` | fórum, sem resposta há > 24 h | `/forum` |
| `sem_avaliacao` | alunos da turma sem nenhuma submission no curso | `/resultados` |
| `matriculas` | solicitações pendentes — **só admin** (`page.matriculas`) | `/matriculas` |
| `conteudo_bloqueado` | `classes.releasedItems` falso para unidade cuja prova tem `startsAt` ≤ 7 dias | `/materiais` |

O último é o único cruzamento que nenhuma tela faz hoje.

### 2.3 `GET /api/admin/dashboard/trends`
Query: `courseId`, `studentClass`, `janela=30d`. Alimenta o Pulso.
```
{
  frequencia:  { atual, anterior, deltaPP, serie:[{label, valor}] , base:{comChamada, total} },
  media:       { atual, anterior, delta,   serie:[...],             base:{provas, alunos} },
  engajamento: { atual, total, anterior,   serie:[...],             semAcessoMais14d }
}
```
Agrega `submissions.timestamp` (ISO), `attendance.date` e `moduleAccess.timestamp` (ms).

> **Armadilha:** `submissions.timestamp` é string ISO e `attendance.timestamp` é número em ms.
> Normalizar na entrada do agregador, não em cada consumidor.

### 2.4 Permissões

- [ ] Registrar as 3 rotas em `backend/utils/adminPermissions.js` (padrão de `:153`), permissão `page.dashboard`
- [ ] Espelhar em `web/src/lib/adminPermissions.js`

> Os dois arquivos **já divergem hoje**: o front concede `page.classes` ao professor por padrão e o
> backend não. Vale confirmar se é intencional enquanto se mexe ali.

### 2.5 Testes

- [ ] `test/backend/` com `supertest`: escopo de professor (professor de outra turma recebe lista vazia),
      item de matrícula ausente para professor, `now` fora de horário devolve `aula: null` + `proximaAula`

---

## Fase 3 — Primitivos de UI  ·  M

`docs/PADROES_UI.md` proíbe primitivos ad-hoc: o que for reutilizável entra em `web/src/components/ui/`.

**Novos em `components/ui/`**
- `Sparkline({ points, tone, height })` — barras com rótulo e `title` por ponto.
  *Sem rótulo o gráfico é decorativo; ou ganha eixo, ou não entra.*
- `TrendPill({ delta, unit, direction })` — não codificar só por cor: glifo + texto (a11y)
- `EmptyLine({ icon, title, description, action })` — estado vazio horizontal (padrão de
  `mockup-provas-lucida.html`), não caixa central
- `SectionLabel({ children, action })` — o rótulo em maiúsculas com régua

**Locais, em `features/admin/dashboard/`**
- `NowBand`, `ActionQueue`, `QueueRow`, `PulseGrid`, `MetricCard`, `RiskList`, `ReasonChips`,
  `DisciplineFrequency`, `WeekAgenda`, `DataQualityNote`

**Regras**
- [ ] Zero hex — só classes de token (garante os 4 cruzamentos preset × tema de D1)
- [ ] `tabular-nums` em todo número
- [ ] `ReasonChips` corta em 2 motivos + "mais N" (senão a linha estoura com 4 motivos)
- [ ] Testes de componente em `web/` para `Sparkline`, `TrendPill` e o corte de `ReasonChips`

---

## Fase 4 — A tela  ·  G

Reescrever `DashboardPage.jsx` seção a seção, na ordem do mockup.

- [ ] Header com contexto e data · **manter** o alerta `location.state?.accessDenied`
      (`:121-123`) — o Dashboard é o destino de acesso negado do app inteiro
- [ ] Faixa "Agora"
- [ ] Fila "Precisa de você" + "Próximos 7 dias"
- [ ] "Pulso da turma" — 3 métricas com tendência
- [ ] "Alunos que precisam de atenção" — lista única com `risco.reasons` (hoje descartado)
- [ ] "Frequência por disciplina" — condicionada por D5
- [ ] Aviso de qualidade de dados **junto do card de Frequência**, não no rodapé
      *(se 3 alunos somem de todas as métricas, o aviso não pode morar no porão)*

**Limpezas na mesma passagem**
- [ ] Remover os 4 fetches + refiltro no cliente (`:50-60`): `students-overview` já vem escopado
- [ ] Remover o fallback multi-turma de `:109-112` — inalcançável, o filtro de `:57` sempre dá 0 ou 1 turma
- [ ] "Exportar" deixa de ser `window.print()` (`:125`): separar exportar de imprimir
- [ ] Preservar `dashboard.absencesCount` / `dashboard.riskCount`

---

## Fase 5 — Os quatro estados  ·  M

`docs/PADROES_UI.md` exige carregamento, erro, vazio e sucesso. O mockup só cobriu vazio.

- [ ] **Carregando** — `Skeleton` por seção, não bloqueio da tela inteira.
      São 4 endpoints: carregamento parcial é o caso comum, não a exceção.
- [ ] **Erro** — `PageState` com retry por seção; `/trends` falhar não pode derrubar a fila
- [ ] **Fora de horário** — faixa "Agora" colapsa em uma linha
      ("Próxima aula: segunda, 07:30 · Lógica de Programação") e devolve o espaço à fila.
      *Sem isso, às 22h de sábado a tela abre com três caixas vazias.*
- [ ] **Fila vazia** — estado calmo e afirmativo ("Nada pendente nesta turma"), não caixa triste.
      É o melhor dia possível do professor.
- [ ] **Turma sem dado nenhum** — turma recém-criada, sem aula, sem prova, sem acesso

---

## Fase 6 — Testes e rastreabilidade  ·  M

- [ ] **Snapshots visuais**: os 8 do dashboard (`admin-dashboard-{premium,lumen}-{light,dark}-{desktop,mobile}`)
      vão quebrar por definição. Rodar `npx playwright test --update-snapshots` **e revisar cada
      imagem à mão** antes de aceitar — atualizar sem olhar transforma o teste em carimbo.
- [ ] **Mobile (390×844)**: o snapshot mobile é obrigatório. Na vertical, a fila deve vir **antes**
      do Pulso — o professor no celular quer a pendência, não a tendência.
- [ ] **Rastreabilidade**: `npm run test:docs` exige que caso marcado `Automatizado` tenha
      `[UC-XXX-NNN]` no teste. Registrar os novos casos em
      `docs/qualidade/MATRIZ_DE_RASTREABILIDADE.md` e marcar os IDs nos specs.
- [ ] **E2E**: usar `POST /api/test/seed` para cenário determinístico
- [ ] `npm run test:full` verde · `npm run build` sem aviso

---

## Fase 7 — Depois (não bloqueia o lançamento)

- **Recorte temporal** — seletor "30 dias / bimestre / tudo". Hoje "média 7,8" é de todo o histórico;
  o seletor muda o significado do Pulso inteiro.
- **Personalização de blocos** — ordem e visibilidade por professor via `PreferencesProvider`
  (a infra já existe e aceita qualquer chave). Turma sem provas quer um dashboard diferente de
  turma em semana de avaliação.
- **Folha de impressão** — o dashboard é o material de conselho de classe.

---

## Ordem sugerida de execução

```
Fase 0  →  Fase 1  →  [verificar números com a tela antiga]
                          ↓
                      Fase 2  →  Fase 3  (podem correr em paralelo)
                          ↓
                      Fase 4  →  Fase 5  →  Fase 6
```

**Risco maior:** Fase 1 muda a assinatura de `media`/`frequencia` e a tela do aluno consome as mesmas
funções. Se algo vai quebrar silenciosamente, é ali — daí a varredura de consumidores em 1.2 antes
de mudar qualquer coisa.

**Ganho maior por esforço:** Fase 1 (bugs reais, afeta duas telas) e a exibição de `risco.reasons`
na Fase 4 (o dado já chega pronto do backend e é jogado fora).
