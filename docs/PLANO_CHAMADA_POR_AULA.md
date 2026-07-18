# Plano de Implementação — Chamada por Aula (Frequência por Disciplina)

> Documento de planejamento. **Nenhum código foi alterado até aqui.**
> Base de referência: mockup `mockup-chamada-melhorada.html` + código atual do IClass V3.
> Idioma do projeto: PT-BR. Stack: Express + SQLite (regras no servidor) / React (web/).

---

## 1. Objetivo

Evoluir a Chamada existente de um modelo **por dia** (um status por aluno/dia) para um modelo **por aula**, com:

- Grade horária semanal configurada na turma (dias letivos × aulas, cada aula com horário e disciplina).
- Frequência calculada **por disciplina** (além de uma visão geral).
- Registro de atraso, saída antecipada e justificativa com **abono opcional** da falta.
- Presença automática por login que respeita os horários e a tolerância de atraso.

A funcionalidade **já existe** parcialmente e será estendida, não recriada:
`web/src/features/admin/ChamadaPage.jsx` (front) + rotas `/api/admin/attendance/*` em `backend/routes/admin.js` + tabela `attendance` (`backend/database.js`).

---

## 2. Decisões fechadas

| # | Tema | Decisão |
|---|------|---------|
| 1 | Granularidade | Contagem **por aula** (não por dia). |
| 2 | Onde configurar | Na **turma**, no painel do administrador (grade horária). |
| 3 | Disciplinas | Cadastradas **no curso** (reutilizáveis); a **grade é montada por turma**. |
| 4 | Nº de aulas/dia | **Configurável pela grade** — cada dia letivo pode ter uma quantidade diferente. |
| 5 | Horários | **Grade com horário de início fixo** por aula (ex.: 1ª 08:00, 2ª 08:50…). |
| 6 | Tolerância de atraso | Valor em minutos **por turma**, aplicado ao início de cada aula. |
| 7 | Atraso | **Reduz a frequência** — chegou na 3ª aula ⇒ falta nas aulas 1ª e 2ª. |
| 8 | Frequência | **Geral + por disciplina**. Limiar de risco avaliado **por disciplina**. |
| 9 | Limiar de risco | **Configurável na turma** (ex.: 75%). Hoje está cravado no código. |
| 10 | Abono | Toggle **abona / não abona** funcional. Abonado não conta como falta. |
| 11 | Validação | **Sem** etapa de validação de secretaria — o lançamento do professor já vale. |
| 12 | Login automático | **Continua ligado**, agora *time-aware*: marca por aula conforme horário + tolerância; o professor pode sobrescrever na chamada. |
| 13 | Dados antigos | São dados de teste — **reescrever o seed** no formato novo; sem lógica de migração pesada (leitura tolerante de registros soltos como 1 aula). |

---

## 3. Modelo de dados proposto

### 3.1 Disciplinas (no curso)

Cada curso ganha uma lista de disciplinas reutilizáveis. Armazenado no objeto do curso em `db.memory.courses`.

```js
course.disciplinas = [
  { id: 'MAT', nome: 'Matemática', cor: '#4f9bf5' },
  { id: 'HIS', nome: 'História',   cor: '#f0a929' },
  { id: 'INF', nome: 'Informática', cor: '#33c579' },
]
```

- `id` curto e estável (usado como chave nos registros de presença).
- `cor` opcional, só para UI.

### 3.2 Configuração de presença da turma

Novo campo `attendanceConfig` no objeto da turma (`db.memory.classes`, persistido em `db_classes.json`). Retrocompatível: turmas sem o campo caem em defaults.

```js
class.attendanceConfig = {
  toleranciaMin: 15,          // tolerância de atraso, por aula
  limiarRiscoPct: 75,         // abaixo disso, "em risco" (por disciplina)
  grade: {                    // chave = dia da semana (1=seg … 6=sáb, 0=dom)
    '1': [
      { ordem: 1, inicio: '08:00', disciplinaId: 'MAT' },
      { ordem: 2, inicio: '08:50', disciplinaId: 'MAT' },
      { ordem: 3, inicio: '09:50', disciplinaId: 'HIS' },
      { ordem: 4, inicio: '10:40', disciplinaId: 'HIS' },
    ],
    '2': [
      { ordem: 1, inicio: '08:00', disciplinaId: 'INF' },
      { ordem: 2, inicio: '08:50', disciplinaId: 'INF' },
      { ordem: 3, inicio: '09:50', disciplinaId: 'INF' },
      { ordem: 4, inicio: '10:40', disciplinaId: 'INF' },
    ],
    // dias sem entrada = não letivos
  },
}
```

- **Dias letivos** = dias presentes em `grade`. Fim de semana sem entrada não entra no cálculo.
- **Nº de aulas do dia** = tamanho do array daquele dia (configurável por dia).
- Defaults quando ausente: `toleranciaMin: 10`, `limiarRiscoPct: 75`, `grade: {}` (turma sem grade ⇒ chamada cai no modo simples/legado por dia).

### 3.3 Registro de presença (por aula)

Um registro por aluno/data/turma, contendo o array de aulas do dia.

```js
{
  id, studentEmail, studentClass, courseId, date,
  origin: 'chamada' | 'login',
  aulas: [
    { ordem: 1, disciplinaId: 'MAT', inicio: '08:00',
      status: 'presente' | 'falta' | 'justificada',
      hora: '08:05' },     // hora real de chegada/registro (opcional)
    // ...
  ],
  justificativa: {         // opcional, nível do dia
    tipo: 'atestado' | 'responsavel' | 'declaracao' | 'outro',
    de: '2026-07-14', ate: '2026-07-16',
    abonado: true,         // decide se as faltas justificadas do dia contam
    texto: '', arquivo: '', arquivoNome: '',
  } | null,
  markedBy, timestamp,
}
```

- Status por aula ∈ `presente` | `falta` | `justificada`. "Atrasado" é derivado (aluno com faltas nas aulas iniciais + presença nas seguintes) e exibido na UI, mas cada aula é P/F/J.
- `justificativa.abonado === true` ⇒ as aulas `justificada` daquele dia **não contam** como falta em nenhuma disciplina.
- Retrocompat: registro antigo sem `aulas` é lido como 1 aula presente (ou falta, conforme `status` legado) sem disciplina (`disciplinaId: null` ⇒ entra só na frequência geral).

---

## 4. Regras de negócio

### 4.1 Frequência

Para cada disciplina `d`:

```
aulasDadas(d)   = nº de aulas de d em registros lançados (chamada/login) até a data
presentes(d)    = aulas de d com status 'presente'
faltasContam(d) = aulas de d com status 'falta'
                + aulas 'justificada' cujo dia NÃO está abonado
frequencia(d)   = presentes(d) / (presentes(d) + faltasContam(d)) * 100
```

- **Geral** = mesma fórmula somando todas as disciplinas.
- **Denominador = aulas efetivamente lançadas** (dias sem chamada não viram falta automática — mantém o comportamento atual documentado em `studentAnalytics.js`).
- **Abono** remove a falta do numerador/denominador de falta (não conta).
- **Risco**: `frequencia(d) < limiarRiscoPct` da turma ⇒ disciplina em risco. O aluno está "em risco" se qualquer disciplina estiver abaixo do limiar.

### 4.2 Atraso (derivação por horário)

Ao lançar por hora (ou no login automático):

```
Para cada aula: cutoff = inicio + toleranciaMin
  hora_chegada <= cutoff  ⇒ presente
  hora_chegada >  cutoff  ⇒ falta
```

Ex.: início 08:00, tolerância 15 ⇒ chegou 08:40: falta nas aulas cujo cutoff já passou, presente nas demais. O professor pode sobrescrever qualquer aula na tela de chamada.

### 4.3 Login automático (time-aware)

`ensureDailyLoginAttendance` (em `backend/routes/student.js`) passa a:

1. Buscar a grade do dia da turma do aluno (dia da semana da data).
2. Se o dia não é letivo ⇒ não cria registro.
3. Calcular status por aula a partir da hora do login vs `inicio + toleranciaMin`.
4. Gravar registro `origin: 'login'` com o array `aulas`.
5. Um lançamento posterior do professor (`origin: 'chamada'`) **sobrescreve** o do login (o upsert por aluno/data/turma já faz isso hoje).

Mantém as configs globais de `settings.attendance` (`autoOnLogin`, janela) como liga/desliga geral.

---

## 5. Impacto no código (mapa de arquivos)

### Backend

| Arquivo | O que muda |
|---------|-----------|
| `backend/database.js` | Tabela `attendance` (JSON key-value) segue igual — só o formato do objeto muda. `memory.courses` ganha `disciplinas`; `memory.classes` ganha `attendanceConfig`. Sem alteração de schema SQL. |
| `backend/routes/admin.js` | `ATT_STATUS`; `/attendance/roster` (montar aulas da grade + status salvos); `/attendance/bulk` (persistir por aula + justificativa/abono, sem validação); `/attendance/export` (colunas por aula/disciplina); `/student/attendance/mark` (marca rápida); `/student/attendance` (calendário); `/class/create` e `/class/update` (aceitar `attendanceConfig`); rotas novas de disciplinas do curso; `/student/academic` (usa novo motor). |
| `backend/routes/student.js` | `ensureDailyLoginAttendance` (time-aware); cálculo de frequência (~L1381) → motor por disciplina. |
| `backend/utils/studentAnalytics.js` | Reescrever `isPresentAtt`, `presentDaysLast30`/`freqPct`, `absenceCount`, `computeStudentDashboard`, `studentOverview` para por-aula + por-disciplina + abono + limiar da turma. |
| `backend/routes/testmode.js` | Reescrever seed de `attendance` (L218–282) no formato por aula; semear `disciplinas` no curso e `attendanceConfig` na turma de teste. |
| `backend/utils/settings.js` | `attendance.autoOnLogin`/janela permanecem; nenhuma mudança estrutural. |
| `backend/utils/backup.js` | `attendance` continua no backup — só validar round-trip com o novo formato. |

### Frontend

| Arquivo | O que muda |
|---------|-----------|
| `web/src/features/admin/TurmasPage.jsx` | Novo painel/modal de **grade horária + config de presença** da turma; UI de **cadastro de disciplinas** do curso. |
| `web/src/features/admin/ChamadaPage.jsx` | Reescrita para por aula: disciplinas/horários da grade, atraso, saída antecipada, justificativa com abono (sem validação), badges de frequência/risco, barra de progresso, filtros, densidade, teclado, modal de conclusão. |
| `web/src/features/admin/AlunoDetailPage.jsx` | Frequência e risco **por disciplina** (KPI, aba Frequência, timeline). |
| `web/src/features/admin/DashboardPage.jsx` | Média de frequência e lista "em risco" considerando por-disciplina. |
| `web/src/components/ui/MonthCalendar.jsx` | Calendário de presença do aluno lendo o formato por aula. |
| `web/src/features/admin/AlunosPage.jsx` | Marca rápida e lista de registros recentes no novo formato. |
| `web/src/features/admin/SistemaPage.jsx` | Sem mudança obrigatória (liga/desliga global permanece). |

### Testes

| Arquivo | O que muda |
|---------|-----------|
| `test/backend/student-analytics.test.js` | Reescrever asserts (hoje esperam `absenceCount` e `faltas` por dia). |
| `test/backend/student-sessions.test.js` | Ajustar o que tocar em presença/login. |
| e2e Playwright | Atualizar/1 novo fluxo de chamada por aula. |

---

## 6. Plano por blocos (ordem de execução)

### Bloco 1 — Config da turma (base) ⭐ começar aqui
1. Modelo: `disciplinas` no curso; `attendanceConfig` na turma (com defaults).
2. Rotas: CRUD de disciplinas do curso; `class/create` e `class/update` aceitando `attendanceConfig`; validação (horário `HH:MM`, ordem única, dias 0–6, tolerância/limiar numéricos).
3. UI TurmasPage: cadastro de disciplinas do curso; editor de grade semanal por turma; campos de tolerância e limiar.
4. Teste de round-trip da config (salvar → ler).

### Bloco 2 — Modelo de presença por aula
1. Formato do registro (`aulas[]` + `justificativa`).
2. Helpers de leitura retrocompatível (registro legado → 1 aula).
3. Reescrever seed do testmode.

### Bloco 3 — Motor de frequência por disciplina
1. Reescrever `studentAnalytics.js` (geral + por disciplina + abono + limiar).
2. Alinhar o cálculo em `student.js` (visão do aluno) à mesma regra.
3. Ajustar `absenceCount`, risco e `studentOverview`.

### Bloco 4 — Login automático time-aware
1. `ensureDailyLoginAttendance` usa grade + tolerância.
2. Garantir sobrescrita pelo lançamento da chamada.

### Bloco 5 — Tela de Chamada (UI)
1. Portar o mockup para React/Tailwind com os tokens do tema.
2. Fonte de dados: grade da turma (aulas/horários/disciplinas) + roster.
3. Atraso, saída antecipada, justificativa+abono, progresso, filtros, teclado, modal de conclusão.

### Bloco 6 — Telas dependentes
1. AlunoDetail, Dashboard, MonthCalendar, AlunosPage no novo modelo.

### Bloco 7 — Testes e verificação
1. Reescrever testes de analytics; cobrir por-disciplina, abono, atraso, login time-aware.
2. `npm run check` (backend + web + build + e2e).
3. Backup → restore com o novo formato.
4. Conferir que Dashboard, AlunoDetail e visão do aluno mostram a **mesma** frequência.
5. Validar CSV no Excel com as colunas novas.

---

## 7. Pontos de atenção / riscos

- **Dois motores de frequência** hoje divergem (dias úteis vs dias com registro). Precisam ser unificados na mesma regra, senão aluno e admin veem números diferentes.
- **Denominador da frequência**: manter "aulas lançadas" (não gerar falta automática por dia sem chamada) para não punir dias sem aula registrada.
- **Abono em nível de dia**: cobre todas as faltas justificadas daquele dia. Se no futuro precisar abono por aula/disciplina, o modelo comporta (basta mover `abonado` para a aula).
- **Retrocompatibilidade de leitura**: toda função que lê `attendance` deve tolerar registros sem `aulas[]`.
- **Turma sem grade**: a chamada deve degradar para um modo simples (por dia) em vez de quebrar.
- **Backup/restore**: validar que o novo objeto sobrevive ao ciclo.

---

## 8. Checklist rápido

- [x] Bloco 1 — disciplinas no curso + `attendanceConfig` na turma + UI TurmasPage
- [x] Bloco 2 — registro por aula + leitura retrocompatível + seed reescrito
- [x] Bloco 3 — motor de frequência por disciplina (unificado admin + aluno)
- [x] Bloco 4 — login automático time-aware + dedupe por data
- [x] Bloco 5 — tela de Chamada por aula
- [x] Bloco 6 — telas dependentes (AlunoDetail por disciplina, AlunosPage, Dashboard)
- [x] Bloco 7 — testes de analytics reescritos (6/6 passam) + RBAC + verificação

## 9. Status da implementação (2026-07-17)

Todos os 7 blocos implementados. Arquivos principais:

- **Novo** `backend/utils/attendance.js` — grade, validação, derivação de atraso, frequência por aula/disciplina, dedupe.
- `backend/routes/admin.js` — rota de disciplinas do curso; `class/create`/`class/update` com `attendanceConfig`; `roster`/`bulk`/`export`/`mark` por aula.
- `backend/routes/student.js` — login time-aware; frequência do aluno pelo motor unificado.
- `backend/utils/studentAnalytics.js` — frequência geral + por disciplina, abono, limiar da turma, risco.
- `backend/routes/testmode.js` — seed reescrito no formato por aula (grade + disciplinas).
- `backend/utils/adminPermissions.js` — RBAC da nova rota.
- **Novo** `web/src/features/admin/TurmaPresencaConfig.jsx` — disciplinas + editor de grade.
- `web/src/features/admin/{TurmasPage,ChamadaPage,AlunoDetailPage,AlunosPage}.jsx`.
- `test/backend/student-analytics.test.js` — reescrito (6/6 passam).

**Verificação feita no sandbox:** testes de analytics (6/6), RBAC (2/2), suíte backend (17 passam; 5 falham só por binário nativo do sqlite compilado para Windows), sintaxe de todos os arquivos e compilação JSX via `@babel/parser`.

**Pendente na máquina do usuário (ambiente Windows):** rodar `npm run check` (build Vite + Playwright e2e não rodam no sandbox por causa dos binários nativos Rollup/esbuild/sqlite) e testar o fluxo completo na UI.

## 10. Redesenho da tela de Chamada (2026-07-18)

Tela reescrita a partir do mockup `docs/mockups/mockup-chamada-completo.html`.

**Decisões novas (complementam a seção 2):**

| # | Tema | Decisão |
|---|------|---------|
| 14 | Validação de atestado | **Confirmada a decisão #11**: sem etapa de secretaria. O professor é a autoridade e o toggle "Abona falta" é editável direto. |
| 15 | Salvamento | **Autosave de rascunho** (2s após a última alteração, `concluida: false`) + botão **"Concluir chamada"** (`concluida: true`) com modal de validação. Ambos contam na frequência; `concluida` é só marcador de workflow. |
| 16 | Atraso / saída antecipada | Continuam **derivados**, sem novo status no backend: faltas no início do dia = atraso, faltas no fim = saída antecipada. A hora fica no campo `aula.hora` que já existia. |

**Mudanças de dados (retrocompatíveis, sem migração):**
- Registro de presença ganhou `concluida` (bool) e `observacao` (string, ≤500).
- `/attendance/roster` passou a devolver, por aluno: `frequencia`, `faltasAcumuladas`, `emRisco` (via `computeAttendanceStats` + `limiarRiscoPct` da turma), `concluida` e `observacao`.
- `/attendance/bulk` aceita `concluida` e `entries[].observacao`.
- Token de tema novo `--early` / `--early-soft` (`tokens.css` + `tailwind.config.js`) para "saiu cedo".

**Recursos da tela:** status por aluno P/A/F/J · atraso por aula ou hora · saída antecipada · justificativa (tipo, anexo, período, abono, texto) · observação · selo de frequência com risco · barra de progresso segmentada · filtros (sem marcar / atrasados / saíram cedo / em risco) · busca · densidade confortável/compacto · navegação por teclado (↑↓ P A F J S N 1-9) · desfazer ação em massa · modal de conclusão com validação de pendências.

**Verificação:** `npm run build` OK · backend 54/54 · web 30/30 · fluxo exercitado via API (rascunho→concluída, derivação de atraso e de saída antecipada, abono, frequência/risco).
