# Convenções de API — IClass V3

Padrões para os endpoints Express. Fonte: `backend/server.js`, `backend/middlewares.js`, `backend/routes/*`.

## Princípios

- **Server-authoritative**: a API decide tudo (autenticação, liberação, correção). O cliente nunca é confiável.
- **JSON in/out**: `express.json({ limit: '10mb' })`. Respostas em JSON.
- **Prefixos**: rotas administrativas sob `/api/admin/...`, rotas do aluno sob `/api/student/...`, compartilhadas em `common.js`.

## Autenticação

O cliente (`web/src/lib/api.js`) envia credenciais por header conforme o perfil:

| Perfil | Header preferido | Fallback legado |
|--------|------------------|-----------------|
| Instrutor/Admin | `x-admin-session: <token>` | `Authorization: email:senha` |
| Aluno | `x-session-token: <token>` | — |

- **Preferir sempre o token de sessão** (não expõe senha). O `Authorization: email:senha` existe só por compatibilidade.
- Sessão de aluno tem **token único + trava por IP** (anti-sequestro). Ver [SEGURANCA.md](./SEGURANCA.md).

### Validação nos handlers

```js
// Admin
router.post('/api/admin/algo', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        // ... autorizado; ler req.body, aplicar regra, responder
    });
});

// Admin com permissão específica (RBAC)
validateAdminPermission(req, res, 'nomeDaPermissao', (config, admin) => { /* ... */ });

// Aluno (middleware)
router.post('/api/student/algo', validateStudentSession, (req, res) => { /* ... */ });
```

- `validateAdmin(req, res, cb)` — resolve a conta e chama `cb(config, matchedAdmin)` só se autenticado.
- `validateAdminPermission(req, res, permission, cb)` — idem, checando permissão RBAC.
- `validateStudentSession` — middleware que valida token + IP do aluno.
- `/api/admin/*` ainda passa por `adminRbacGuard` global em `server.js`.

## Escopo do professor (multi-tenant leve)

Contas de professor têm acesso restrito a cursos/turmas atribuídos. Use os helpers de `middlewares.js` antes de operar sobre um recurso: `adminCanAccessClass`, `adminCanAccessCourse`, `adminAllowedCourseIds`, `adminAssignedClasses`. Nunca confie no `courseId`/`className` do body sem checar o escopo.

## Formato de resposta

**Sucesso**: `res.json(dados)` (200). Para criação, retorne o recurso criado.

**Erro**: status apropriado + `{ error: 'mensagem em pt-BR' }`.

```js
if (!cls) return res.status(404).json({ error: 'Turma não encontrada.' });
```

Convenções de status: `400` dados inválidos, `401/403` não autenticado/sem permissão, `404` não encontrado, `409` conflito, `429` rate limit (ver `utils/rateLimit.js`).

Campos extras podem acompanhar o erro para o cliente reagir (ex.: `{ error: 'Limite de tentativas atingido.', attemptsExhausted: true }`).

O cliente (`lib/api.js`) transforma respostas não-OK em `Error` com `.status` e `.data`, exibido via `toast.error(e.message)`.

## Persistência dentro do handler

Mutação em `db.memory` e depois `await db.save()` (ver [MODELO_DADOS.md](./MODELO_DADOS.md)):

```js
db.memory.questionBank.push(questao);
await db.save();
res.json(questao);
```

## Provas — pontos sensíveis da API

- **Gabarito nunca vai ao cliente.** Configs de prova passam por `sanitizeOnlineExamConfigsForStudent` antes de qualquer resposta ao aluno.
- **Token de prova**: armazenado com hash (`utils/examToken.js`), exibido ao professor só no contexto de preparação; validado no servidor, nunca ecoado.
- **Correção** acontece em `/api/student/submit` (nunca no cliente); limite de tentativas conferido antes de corrigir.
- **Aplicações** têm `applicationId` imutável e ciclo `waiting → running → paused → finished` isolado por aplicação (`utils/examApplications.js`).

## Notas — escala, lançamento e exportação

- **Escala**: `submission.score` é guardado de 0 a 100 (inteiro, como a correção online); toda tela, boletim e planilha mostra 0 a 10 com uma casa e vírgula. Nota vazia, texto ou fora de 0 a 100 (registros antigos) é tratada como inválida por `normalizeScore` (`utils/submissionAttempts.js`): não entra em média, não é publicada e não chega ao aluno.
- **`POST /api/admin/submissions/create`**: modo rápido recebe `grade` (0 a 10, aceita `"8,5"`) e/ou `correctCount`/`totalCount` (inteiros, acertos ≤ total ≤ questões da prova); sem `grade`, a nota vem dos acertos. O campo antigo `score` é recusado com 400 (evita gravar 8,5 como 9%). Modo cartão-resposta: `answers` `{ número: letra }` e `questionNumbers` da versão aplicada. `courseId`/`studentClass` do workspace definem a turma da nota. Erros sempre 400 com mensagem em pt-BR.
- **Auditoria**: lançar, publicar/ocultar, excluir, mudar a composição (`result-control`) e recorrigir (anulação/troca de questão) gravam em `auditLogs` (`recordGradeAudit` em `utils/gradebook.js`), visíveis na ficha do aluno (aba Auditoria) e no "Histórico da nota" de `GET /api/admin/submissions/:id/review` (`history`). A exclusão guarda uma cópia do registro em `details.deletedSubmission`; a recorreção guarda a nota anterior em `submission.scoreHistory`.
- **Total da turma no lançamento rápido**: `GET /api/admin/submissions/manual-context?courseId&studentClass&examKey` devolve `questionCount` (questões da prova) e `defaultTotal` (a "Quantidade de questões" da turma, sem as excluídas), o mesmo total que `create` usa quando `totalCount` vem vazio; a tela usa esses números na prévia "Nota que será gravada" e na validação. Nota e acertos enviados juntos precisam conferir (diferença menor que 0,1).
- **Lixeira de notas**: `POST /api/admin/submissions/delete` tira a entrega das listas; `GET /api/admin/submissions/deleted?courseId&studentClass` lista as exclusões que ainda não voltaram (a partir das entradas `grade_delete` da auditoria) e `POST /api/admin/submissions/restore { auditId }` devolve o registro como estava (publicado ou não), gravando `grade_restore`. A auditoria nunca é reescrita.
- **Registro da aplicação**: `GET /api/admin/exam-applications/:id/audit` (permissão `page.results`, escopo da turma) junta o ciclo da aplicação, os eventos de `recordExamAudit` (encerramento, anulação com motivo, troca e correção de questão, contestações) e as alterações de nota das entregas dessa aplicação, em ordem cronológica. Na tela Resultados: filtro de aplicação → "Registro da aplicação".
- **Arredondamento único**: `roundGrade` (`utils/submissionAttempts.js`) e `fmtGrade`/`roundGrade` (`web/src/lib/grades.js`) arredondam a nota 0–100 para 0–10 com uma casa, metade para cima (73,5 → 7,4); boletim, quadro, planilhas, portal do aluno e telas usam essa conta.
- **Consolidação única** (`utils/gradebook.js`): cada aplicação da prova é um grupo com a regra do professor; a média é a dos grupos. A tela Resultados, o boletim (`GET /api/admin/student/report?email&courseId&studentClass`, só notas publicadas) e a planilha usam esse mesmo cálculo. Prova aplicada mais de uma vez vira uma linha (boletim) ou coluna (planilha) por aplicação, rotulada "Nª aplicação, dd/mm/aaaa" pela ordem de criação das aplicações da turma.
- **Exportação**: `GET /api/admin/gradebook?courseId&studentClass` (JSON do quadro de notas; `&format=csv` para a planilha aluno × prova + média) e `GET /api/admin/export-grades/:turma/:prova?courseId` (tentativas de uma prova). CSV com `;`, BOM UTF-8, nota com vírgula e células que começam com `= + - @` neutralizadas. O navegador baixa com `downloadFile` (`lib/api.js`), que envia a sessão; `window.open` não envia o cabeçalho e não funciona.

## Arquivos controlados

`/uploads/:filename` e `/imagens/:filename` passam por `sendControlledFile` com resolução segura de caminho (`utils/safePath.js`) — nunca sirva arquivo por concatenação direta de path.

## Modo de teste

`testmode.js` (`/api/test/seed`, reset) só executa com `TEST_MODE=1`. Nunca deixe seed/reset acessível fora de teste.

## Checklist ao criar um endpoint

- [ ] Prefixo correto (`/api/admin` ou `/api/student`).
- [ ] Autenticação no início (`validateAdmin` / `validateStudentSession`).
- [ ] Escopo do professor verificado quando aplicável.
- [ ] Regra de negócio em `utils/`, não inline.
- [ ] `db.save()` após mutar estado.
- [ ] Nenhum dado sensível (gabarito/token/senha) na resposta.
- [ ] Erros em pt-BR com status adequado.
- [ ] Teste em `test/backend/`.
