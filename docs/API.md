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
