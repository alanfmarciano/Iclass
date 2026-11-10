# Convenções de API — IClass V3

Padrões para os endpoints Express. Fonte: `backend/server.js`, `backend/middlewares.js`, `backend/routes/*`.

## Princípios

- **Server-authoritative**: a API decide tudo (autenticação, liberação, correção). O cliente nunca é confiável.
- **JSON in/out**: corpo JSON até 10 MB só com sessão de instrutor válida (`x-admin-session`); aluno, rotas públicas e login legado ficam com 512 KB (413; com `x-admin-session` vencida ou desconhecida, 401 `{ sessionRevoked:true, reason:'expired' }`). Exceção provisória: `POST /api/student/log-keystrokes` com `x-session-token` de uma sessão existente segue com 10 MB até o H2-C mandar lotes de no máximo 500 eventos (o servidor guarda no máximo 500 por envio). Sem corpo, `req.body` é `{}`. Parâmetro de query repetido vale o último, sempre texto. Respostas em JSON.
- **Erros**: toda resposta leva `X-Request-Id`. Erro interno responde 500 `{ success:false, error:'Ocorreu um erro interno no servidor. Código do erro: <id>.', requestId }`, com esse mesmo texto em todas as rotas, e o stack vai para `data/crash.log` (só por `utils/errorLog.js`, que roda em 5 MB para `crash.log.1`) com o que a rota tentava fazer (linha `contexto:`, por exemplo "Falha ao gravar arquivo no disco."). Todo 500 de rota passa por `sendInternalError` (ou `sendRouteError`, que mantém a recusa prevista com status 4xx e a mensagem dela); falha prevista e tratada antes de uma ação destrutiva (o backup de segurança que não pôde ser salvo antes de "Limpar estado de prova" ou "Resetar sala") não é erro interno: responde 503 `{ success:false, error:'Não foi possível salvar o backup de segurança; nada foi apagado. Código do erro: <id>.', requestId }` ("nada foi alterado." no reset), por `sendHandledFailure`, com o mesmo registro no `crash.log`; nenhuma resposta leva a mensagem de uma falha inesperada (o teste `entrada-e-erros` procura qualquer `<variável>.message` no campo `error` ou em `.json()`/`.send()` das rotas). Restaurar backup: arquivo inválido, de versão incompatível ou cortado (JSON ou ZIP pela metade) responde 400 com a mensagem em português; falha do disco ou inesperada no meio da restauração responde o 500 com o código, e o histórico de backup guarda o mesmo texto. Envio de arquivo (multer): recusa (tipo, tamanho, formulário cortado) responde 400 `'Erro no upload: ...'`; falha do disco ao gravar o arquivo recebido responde o 500 com o código. Erro numa rota de download (ZIP, CSV) sai em JSON, sem `Content-Disposition`; se o ZIP do backup completo já começou a descer, a conexão é cortada (o navegador acusa o download como falho) e o erro fica no `crash.log`. Toda resposta sai só depois do `COMMIT` das gravações pedidas durante o pedido (`utils/persistenceContext.js`): o "salvo" já está no disco. Falha de gravação (`ICLASS_DB_WRITE`) responde 503 `{ success:false, error:'Não foi possível gravar os dados agora. Tente de novo em alguns segundos.', retryable:true }`, sem derrubar a sessão. Parâmetro de caminho com `%` inválido responde 400 em português.
- **Prefixos**: rotas administrativas sob `/api/admin/...`, rotas do aluno sob `/api/student/...`, compartilhadas em `common.js`.

## Autenticação

O cliente (`web/src/lib/api.js`) envia credenciais por header conforme o perfil:

| Perfil | Header preferido | Fallback legado |
|--------|------------------|-----------------|
| Instrutor/Admin | `x-admin-session: <token>` | `Authorization: email:senha` |
| Aluno | `x-session-token: <token>` | — |

- **Preferir sempre o token de sessão** (não expõe senha). O `Authorization: email:senha` existe só por compatibilidade.
- Sessão de aluno tem **token único + trava por IP** (anti-sequestro). Ver [SEGURANCA.md](./SEGURANCA.md).
- O token de sessão (aluno e instrutor) é opaco: 32 bytes aleatórios em base64url, devolvido só na resposta do login. O servidor guarda apenas o sha256 (`utils/authSessions.js`); token vencido (prazo absoluto) ou de conta apagada responde 401 também em `/uploads`, `/imagens` (`?access=`) e nas rotas de conteúdo de prova.

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

- **Callback com `(config, conta)`.** O callback de `validateAdmin` e `validateAdminPermission` recebe a configuração primeiro e a conta depois. Com um parâmetro só (`async matchedAdmin => ...`) a variável recebe a configuração e o professor passa como administrador (SEG-05); `test/backend/admin-callback-signature.test.js` recusa essa assinatura em qualquer arquivo do backend.
- **Listas filtradas item a item.** O que o professor lê sem informar a turma vem só das turmas dele: `GET /api/admin/message-history` (mensagens do Monitor), `POST /api/admin/forum/all` e `GET /api/forum` com sessão de instrutor (dúvida antiga sem turma que se possa inferir fica só com o administrador) e `GET /api/courses` (só os cursos de `adminAllowedCourseIds`). `POST /api/admin/message-history/delete` exige `messageId` ou `studentClass` de todos (400 "Informe a mensagem ou a turma."), e mensagem fora do escopo dá 403. O aluno em `GET /api/forum` informa `courseId` e `studentClass` (400 "Informe o curso e a turma." sem eles). (SEG-11)
- **Cursos pelo painel.** Criar, alterar e excluir curso: `POST /api/admin/courses`, `PUT /api/admin/courses/:id` e `DELETE /api/admin/courses/:id` (`routes/adminCourses.js`, permissão `course.manage`), que passam pelo `adminRbacGuard` com o id do caminho conferido no escopo, como `/structure` e `/clone`. O POST aceita `id` (letras sem acento, números, `-` e `_`, até 64), `name` (1 a 120), `description` (até 2.000), `schoolId` (escola existente; o professor só numa escola atribuída a ele) e `branding`; a estrutura começa vazia. O PUT aceita `name`, `description`, `schoolId` (só o administrador muda: 403 para o professor), `branding` (em merge) e restaurar (`deleted: false` ou `status: 'active'`); o resto do corpo é ignorado e a estrutura continua só em `/structure`. Cada mudança grava `course_created`, `course_updated` (só quando algo mudou) ou `course_deleted`, com antes e depois dos campos permitidos e `details.brandingKeys` com os nomes do que mudou na identidade visual. O `/clone` confere o código novo pelas mesmas regras e, para o professor, a escola de destino em `adminAllowedSchoolIds`. As rotas antigas `POST /api/courses`, `PUT` e `DELETE /api/courses/:id` respondem 410 "O IClass foi atualizado. Recarregue a página (F5) para continuar." sem gravar nada. (SEG-12)

## Formato de resposta

**Sucesso**: `res.json(dados)` (200). Para criação, retorne o recurso criado.

**Erro**: status apropriado + `{ error: 'mensagem em pt-BR' }`.

```js
if (!cls) return res.status(404).json({ error: 'Turma não encontrada.' });
```

Convenções de status: `400` dados inválidos, `401/403` não autenticado/sem permissão, `404` não encontrado, `409` conflito, `429` rate limit (ver `utils/rateLimit.js`).

Campos extras podem acompanhar o erro para o cliente reagir (ex.: `{ error: 'Limite de tentativas atingido.', attemptsExhausted: true }`).

O cliente (`lib/api.js`) transforma respostas não-OK em `Error` com `.status` e `.data`, exibido via `toast.error(e.message)`.

**Cache e compressão** (fase 2, H2-A): toda resposta de `/api` sai com `Cache-Control: no-store` (a rota que define o próprio `Cache-Control` continua valendo). Respostas de texto (`application/json`, `application/javascript`, `text/*`) entre 1 KB e 32 MB saem em gzip quando o pedido traz `Accept-Encoding: gzip`, com `Vary: Accept-Encoding` (`utils/httpCompression.js`); vale também para `/data.js`, apostilas `.md` e CSV. A rota não faz nada para isso: basta `res.json`/`res.send`. Para não comprimir uma resposta, a rota define `Cache-Control: no-transform`. Arquivos enviados com `res.sendFile`/`res.download`, streams e ZIP não passam pela compressão. Um segundo `res.send` (ou um `res.end`) enquanto a primeira resposta ainda está no gzip é ignorado com aviso no console, e a resposta sai com o status e os cabeçalhos do primeiro envio, como sairia sem compressão (rota que responde um CSV e depois lança continua entregando o CSV com o nome do arquivo).

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
- **Auditoria**: lançar, publicar/ocultar, excluir, mudar a composição (`result-control`) e recorrigir (anulação/troca de questão) gravam em `auditLogs` (`recordGradeAudit` em `utils/gradebook.js`), visíveis na ficha do aluno (aba Auditoria, só administrador) e no "Histórico da nota" de `GET /api/admin/submissions/:id/review` (`history`, com o `reason`). A exclusão guarda uma cópia do registro em `details.deletedSubmission`; a recorreção guarda a nota anterior em `submission.scoreHistory`.
- **Motivo ao mudar nota publicada** (`gradeChangeReason`, `utils/gradebook.js`): ocultar (`publish` com `published: false`), excluir (`delete`) e qualquer ação de `result-control` (regra, "Usar esta nota", desconsiderar, reconsiderar) sobre nota que o aluno já viu (`gradePublished: true` na nota ou no grupo) exigem `reason` (texto, 3 a 500 letras). Sem ele: 400 `{ success: false, code: 'reason_required', error, field: 'reason' }` antes de qualquer mudança. O motivo vai para a entrada da auditoria (`reason`). Publicar e mexer em nota ainda em revisão não pedem motivo (se vier, é gravado).
- **Total da turma no lançamento rápido**: `GET /api/admin/submissions/manual-context?courseId&studentClass&examKey` devolve `questionCount` (questões da prova) e `defaultTotal` (a "Quantidade de questões" da turma, sem as excluídas), o mesmo total que `create` usa quando `totalCount` vem vazio; a tela usa esses números na prévia "Nota que será gravada" e na validação. Nota e acertos enviados juntos precisam conferir: a nota **gravada** (`scoreFromGrade`, uma casa) pode diferir da conta acertos/total só pelo arredondamento (menos de 0,1), então 7,41 com 3 de 4 é recusada como 7,4.
- **Lixeira de notas**: `POST /api/admin/submissions/delete` tira a entrega das listas; `GET /api/admin/submissions/deleted?courseId&studentClass` lista as notas excluídas que não existem hoje em `submissions`, uma por entrega, pela entrada `grade_delete` mais recente (H7a-2: com a trilha juntada na restauração de backup, o `grade_restore` só conta quando nenhuma restauração de backup — `backup_restored` — veio depois dele; a nota que voltou da lixeira e saiu depois por outro caminho, como curso arquivado ou aluno excluído, não reaparece com a cópia velha), e `POST /api/admin/submissions/restore { auditId }` devolve o registro como estava (publicado ou não), gravando `grade_restore`; restaurar por uma exclusão antiga da mesma nota, ou de nota que já voltou e saiu por outro caminho, responde 409 com a explicação. A auditoria nunca é reescrita. A nota volta para o grupo de tentativas como ele está hoje: se o número da tentativa já foi usado por um lançamento novo, ela recebe o próximo número (`restoredFromAttemptNumber` guarda o antigo); segue a regra atual do grupo e não fica escolhida se outra tentativa já está. A troca de e-mail do aluno acompanha a cópia na lixeira.
- **Grupo de tentativas nas ações**: `result-control` (regra, "Usar esta nota", desconsiderar) e a restauração montam o grupo com curso/turma completados pela matrícula (`createResolvedGroupKey`), o mesmo grupo que Resultados, boletim e quadro mostram: o registro antigo sem curso e o lançamento novo da mesma prova mudam juntos.
- **Registro da aplicação**: `GET /api/admin/exam-applications/:id/audit` (permissão `page.results`, escopo da turma) junta o ciclo da aplicação, os eventos de `recordExamAudit` (encerramento, anulação com motivo, troca e correção de questão, contestações) e as alterações de nota das entregas dessa aplicação, em ordem cronológica. Na tela Resultados: filtro de aplicação → "Registro da aplicação".
- **Arredondamento único**: `roundGrade` (`utils/submissionAttempts.js`) e `fmtGrade`/`roundGrade` (`web/src/lib/grades.js`) arredondam a nota 0–100 para 0–10 com uma casa, metade para cima (73,5 → 7,4); boletim, quadro, planilhas, portal do aluno e telas usam essa conta.
- **Consolidação única** (`utils/gradebook.js`): cada aplicação da prova é um grupo com a regra do professor; a média é a dos grupos. A tela Resultados, o boletim (`GET /api/admin/student/report?email&courseId&studentClass`, só notas publicadas), a planilha, o painel do aluno e a tela Provas do aluno (`consolidatedAverage` sobre `POST /api/student/my-submissions`, que também inclui o registro antigo sem curso do curso da matrícula) usam esse mesmo cálculo. Prova aplicada mais de uma vez vira uma linha (boletim) ou coluna (planilha) por aplicação, rotulada "Nª aplicação, dd/mm/aaaa" pela ordem de criação das aplicações da turma.
- **Exportação**: `GET /api/admin/gradebook?courseId&studentClass` (JSON do quadro de notas; `&format=csv` para a planilha aluno × prova + média) e `GET /api/admin/export-grades/:turma/:prova?courseId` (tentativas de uma prova). CSV com `;`, BOM UTF-8, nota com vírgula e células que começam com `= + - @` neutralizadas. O navegador baixa com `downloadFile` (`lib/api.js`), que envia a sessão; `window.open` não envia o cabeçalho e não funciona.

## Auditoria (H7a-2)

- **Gravação**: só por `recordAudit` (`utils/audit.js`). Além das notas, do cadastro e do backup, ficam na trilha: configurações (`settings_updated`, `details.changes` com `{ key, before, after }` de cada chave que mudou), certificados emitidos e cancelados, escolas criadas/alteradas/excluídas, avisos, eventos do calendário e questões do banco excluídos (cópia em `details.deleted`), curso criado, alterado e excluído (`course_created`, `course_updated`, `course_deleted`, H5c), curso arquivado, restaurado do arquivo e apagado de vez, lixeira de arquivos (restaurar, apagar de vez, esvaziar; `details.item.name` é o nome do material ou do arquivo enviado, e `file` o nome gerado em `/uploads`), dúvida/resposta apagada de vez (`forum_purged`, sem o texto) e a própria exportação (`audit_exported`).
- **Restauração de backup**: a trilha do backup é juntada com a atual (`mergeAuditTrails`): o que foi feito depois do backup continua no registro; backup sem `auditLogs` deixa a trilha como está. Se a restauração falha no meio, tudo volta exatamente como estava antes (sem juntar).
- **Permissão `audit.view`**: só administrador; não é concedível ao professor. O professor recebe 403 em `GET /api/admin/audit`, `GET /api/admin/audit/export` e `GET /api/admin/student/audit` (a aba Auditoria da ficha some para ele) e continua vendo o histórico de cada nota em Resultados.
- **Fuso das configurações**: `POST /api/admin/settings` com um `timezone` que o `Intl` não conhece responde 400 `{ success: false, error, field: 'timezone' }` e não grava nada; o fuso inválido que já esteja gravado (banco ou backup antigo) vale `America/Sao_Paulo` na leitura (`getSettings`).
- **`GET /api/admin/audit`**: a trilha inteira lida por `normalizeAuditEntry` (formatos antigos inclusive), do mais novo para o mais antigo. Filtros (todos opcionais): `from` e `to` (`AAAA-MM-DD`, dias inteiros no fuso das configurações), `category`, `action`, `actor` e `student` (com `@` o e-mail exato; sem, um pedaço do e-mail ou do nome), `courseId`, `studentClass`, `examKey`, `applicationId` e `q` (texto, sem diferenciar acento). Página: `offset` e `limit` (padrão 100, máximo 500). Resposta `{ success, items, total, offset, limit }`, cada item com os nomes do dia (`actorName`, `studentName`, `courseName`, `examTitle`, `categoryLabel`) e o aparelho (`device`); `facets=1` acrescenta as opções dos filtros. Filtro inválido: 400 `{ success: false, error, field }`.
- **`GET /api/admin/audit/export`**: os mesmos filtros, em CSV no padrão do Excel pt-BR (BOM UTF-8, `;`, fórmula neutralizada), colunas Data/hora, Quem, Ação, Categoria, Aluno, Curso, Turma, Prova, Aplicação, Antes, Depois, Motivo, IP. Mais de 50.000 eventos: 400 pedindo para filtrar por período. Cada exportação grava `audit_exported` com os filtros e o número de linhas.
- **`GET /api/admin/student/audit?email`**: a trilha do aluno, normalizada (`audit.view`). Como na tela Auditoria, valores, antes, depois e detalhes passam de novo pela limpeza de segredos (`auditEntryWithoutSecrets`), para a entrada antiga vinda de backup.

## Arquivos controlados

`/uploads/:filename` e `/imagens/:filename` passam por `sendControlledFile` com resolução segura de caminho (`utils/safePath.js`) — nunca sirva arquivo por concatenação direta de path.

Arquivos do app em `/assets/<nome>` (`utils/staticAssets.js`): só GET e HEAD (outro método é 405); nome simples como os do Vite (`[A-Za-z0-9._-]`, inclusive começando com `_` ou `-`, como `_commonjsHelpers-<hash>.js`; sem começar nem terminar com ponto, sem `.gz`/`.br` no fim). Responde com `Cache-Control: public, max-age=31536000, immutable`, `Vary: Accept-Encoding`, `X-Content-Type-Options: nosniff` e `Content-Encoding: br` ou `gzip` quando a versão comprimida do build existe e o navegador aceita. Nome que não existe: 404 `Arquivo não encontrado.` com no-store, nunca o `index.html`. Falha inesperada no envio (disco): o 500 do contrato de erros (`{ success: false, error: 'Ocorreu um erro interno no servidor. Código do erro: <id>.', requestId }`), com no-store e o registro no `crash.log`. Qualquer outro caminho fora de `/api`, `/uploads` e `/imagens` recebe o `index.html` com no-store (503 `O IClass está sendo atualizado...` com `Retry-After: 3` enquanto o build é refeito).

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
