# Modelo de Dados — IClass V3

Como o estado é organizado, persistido e evoluído. Fonte no código: `backend/database.js` e `backend/runtimePaths.js`.

## Persistência

- **SQLite key-value**: cada coleção tem uma tabela `NOME (key TEXT PRIMARY KEY, value TEXT)`, onde `value` é JSON serializado. A exceção são as tabelas próprias (`kind: 'store'`), com colunas e índices: hoje só o histórico de digitação da prova ([abaixo](#histórico-de-digitação-da-prova-exam_keystroke_events)).
- **Registro único** (`COLLECTION_TABLES` em `backend/database.js`): cada coleção e cada tabela aparecem só ali, com `collection`, `table`, `kind` (`array`, `object`, `singleton`, `store` ou `derived`), `key`, `append`, `backup` e `restore`. Dele saem o `CREATE TABLE IF NOT EXISTS`, a carga do boot, a gravação, a lista do backup e a restauração. Coleção ou tabela nova entra só por ele.
- **Espelho em memória**: `db.memory` é um objeto com uma propriedade por coleção. Toda leitura/escrita da aplicação passa por ele.
- **Salvar**: `db.save()` (alias de `saveToDisk`) leva para o SQLite só as linhas que mudaram desde a última gravação (`backend/utils/dbWriter.js`): uma gravação por vez, numa transação (`BEGIN IMMEDIATE` … `COMMIT`, ou `ROLLBACK` se algo falhar, sem perder o que já estava gravado). No boot o motor é semeado com o que foi lido: a primeira gravação não regrava o banco inteiro. A promessa resolve depois do `COMMIT` e rejeita com `DbWriteError` (`code: 'ICLASS_DB_WRITE'`) quando não deu para gravar; aí uma regravação em segundo plano tenta de novo (2 s, 5 s, 10 s e depois a cada 30 s).
- **Linha ilegível**: um registro com JSON quebrado fica no arquivo e fora da memória (aviso no console); a gravação nunca o apaga nem o sobrescreve. Se a memória ganhar um valor com a mesma chave (o aluno volta a gravar a nota, ou o padrão de um singleton como `config`), o texto original é copiado antes, na mesma transação, para a chave `<chave>.ilegivel-<data>` da mesma tabela, que continua no arquivo. Singleton ilegível (`config`, `branding`, `courseStructure`): o servidor segue com o valor padrão dele e registra o aviso no `crash.log` (`[BANCO] Registro ilegível`); para recuperar o conteúdo, restaure um backup.

```js
const db = require('../database.js');
db.memory.courses.push(novoCurso);
await db.save();
```

### Arquivos do banco (modo WAL)

O banco abre em modo WAL com `synchronous=FULL` (o "salvo" sobrevive a queda de energia) e `busy_timeout` de 5 s (`ICLASS_DB_BUSY_TIMEOUT_MS`). Com o servidor ligado, `data/` tem três arquivos: `database.db`, `database.db-wal` (gravações ainda não aplicadas ao arquivo principal) e `database.db-shm` (índice do WAL). No desligamento ordenado (fase 2, H3c: Ctrl+C, SIGTERM, fechar a janela do console, Ctrl+Break, a rota de controle e o botão Reiniciar) o servidor grava, fecha o banco e o `-wal` some. Só kill -9, `taskkill /f` e falta de energia saem sem fechar o banco: o que já foi confirmado está no `-wal`, que o SQLite aplica na subida seguinte. Copiar o banco com o servidor ligado exige os três arquivos juntos; o certo é usar o backup do sistema. Em pasta de rede ou sincronizada (OneDrive) o modo WAL pode não pegar: o servidor segue com aviso no console e o modo real aparece em `db.storageStatus().journalMode`.

`db.storageStatus()` é a fonte única do estado do armazenamento: modo do diário, `synchronous`, `busy_timeout`, tamanho do banco e do `-wal`, linhas por coleção, teclas da prova gravadas (`keystrokes`), última gravação completa, p95 do `COMMIT`, último erro de gravação e se há regravação pendente. Desde o H1-c também: `allocatedBytes` (tamanho do banco para a proporção: o maior entre o arquivo e `page_count × page_size`; em WAL, antes do checkpoint, o `database.db` pode ter só 4 KB), `freeBytes` (espaço recuperável, `freelist_count × page_size`, lido por PRAGMA no boot, na tela e depois da rede de segurança e da compactação; `null` até a primeira leitura) e `freeBytesAt`, `compactSuggested` (`freeBytes` acima de 25% de `allocatedBytes` e de 1 MB), `inSyncedFolder` e `syncedFolderProvider` (pasta de dados dentro do OneDrive, `backend/utils/syncedFolder.js`), `partialSinceFullSave` (houve gravação parcial desde a última completa) e, em `lastCycle`, as linhas gravadas por coleção (`collections`).

- **Gravação parcial nas rotas quentes (H1-c, DES-01)**: as rotas que rodam dezenas de vezes por minuto durante a aula e a prova usam `db.save({ only: [...] })` com as coleções que mudam: rascunho e sincronização da prova, logs do Monitor, presença do ping, caderno, anotações, progresso, acessos às apostilas, login do aluno, início da tentativa, entrega (o caminho comum, que só acrescenta a entrega), ações da aplicação no Monitor (pausar, retomar, encerrar, token, acréscimo de tempo) e mensagens. Toda rota com sessão de aluno inclui `authSessions` (a validação da sessão atualiza o IP e a data dela) e toda rota que chama `recordAudit` inclui `auditLogs`. Os caminhos raros que reescrevem entregas antigas (finalizar uma tentativa já entregue, substituir a nota) continuam com a gravação completa. A promessa do `db.save()` resolve com o que o ciclo gravou: `{ full, rows, collections, requests }`.
- **Rede de segurança (`db.runSafetyNetSave()`)**: timer de 10 min (`save-safety-net`, registrado no `serverLifecycle`). Só roda se houve gravação parcial desde a última completa. Com aplicação de prova em `waiting`, `running` ou `paused` ela espera (`{ ran: false, deferred: true }`), com teto de 2 h desde o primeiro adiamento com aquela aplicação aberta (`SAFETY_NET_MAX_DEFER_MS`, contado por aplicação), para não segurar a fila no meio da prova; a aplicação que sai de andamento perde o adiamento na rodada seguinte, mesmo sem gravação parcial pendente, e por isso o adiamento de uma prova encerrada não faz a gravação completa rodar no meio da próxima; depois, espera a fila esvaziar (até 30 s) e faz uma gravação completa `detached`. Se ela gravar alguma linha sozinha no ciclo (com outro pedido junto no mesmo ciclo não dá para saber de quem era a linha, e ela não acusa), o `crash.log` recebe `[GRAVAÇÃO] Rede de segurança` com `coleção (linhas)`. Nunca rejeita.
- **Compactar (`db.compactDatabase()`)**: `VACUUM` e `PRAGMA wal_checkpoint(TRUNCATE)` por `db.runExclusive` (as gravações pedidas antes passam primeiro; as pedidas durante esperam), com `refreshStorageStats()` antes e depois. Devolve `{ before, after, ms }` (dois `storageStatus()`). Quem chama confere que não há prova em andamento e que há espaço em disco (rota `POST /api/admin/storage/compact`).

## Coleções em `db.memory`

| Coleção | Tipo | Conteúdo |
|---------|------|----------|
| `students` | array | alunos (perfil, turmas, credencial; `sessionsInvalidBefore` opcional, ms: a sessão aberta antes dessa hora acaba fora de prova, gravado pelo "Redefinir senha", H5b; situação com `statusChangedAt` (ms), `statusChangedBy` e `statusReason`, gravados ao mudar a situação, H7c; cadastro anonimizado: `status: 'Anonimizado'`, e-mail `anonimizado-<ref>@anonimizado.invalid`, nome "Aluno anonimizado <REF>", `anonymizedRef`, `anonymizedAt` (ms), `anonymizedBy`, senha vazia e só turmas e datas, H7c. Cadastro antigo sem `statusChangedAt` vale como "data não registrada" ou pela última mudança de "Status" na auditoria; `birthDate` opcional `AAAA-MM-DD`, H8a-2; `termsAcceptance` e `privacyAcceptance` `{ documentId, version, schoolId, at, ip, device }` (modelo do IClass com `version: null`; o formato antigo `{ version: '1.0', at }` continua sendo lido e mostrado como "aceite antigo sem documento"); `legalAcceptances` com os aceites substituídos `{ kind, ...aceite, replacedAt }`, até 50. Cadastro sem `birthDate` continua valendo: o portal pede a data no próximo acesso) |
| `classes` | array | turmas; `activeExamKey`, `examConfigs`, `onlineExamConfigs`, liberações |
| `courses` | array | cursos (multi-curso); `structure`, `schoolId`, `status`/`deleted`/`deletedAt` (lixeira), `branding`. O painel grava só `name`, `description`, `schoolId` e `branding` por `/api/admin/courses` (a estrutura vai por `/api/admin/courses/:id/structure`) |
| `branding` | objeto | identidade white-label global |
| `schools` | array | escolas/instituições (white-label, compartilháveis) |
| `submissions` | array | submissões de prova |
| `examApplications` | array | aplicações de prova (ciclo de vida próprio, `applicationId` imutável); `keystrokeMode` (`eventos`\|`tudo`\|`nada`, H8b; ausente nas de antes vale `eventos`), copiado também para a configuração online da turma |
| `questionBank` | array | banco de questões reutilizáveis |
| `evaluations` | objeto | avaliações |
| `courseStructure` | array | estrutura legada (**em obsolescência**, migrada para `courses[].structure`) |
| `notes` | objeto | caderno do aluno por material (`{ e-mail: { chave: texto } }`; desde o H9b até 50.000 caracteres por chave, 300 chaves e 1.000.000 no total por aluno, e nota vazia apaga a chave; dado antigo acima disso fica como está e só diminui) |
| `annotations` | objeto | anotações por parágrafo (desde o H9b: nota até 5.000, trecho destacado guardado com até 1.000, 500 parágrafos por unidade, 300 unidades por aluno) |
| `forum` | array | dúvidas/fórum por unidade (resposta antiga de aluno sem e-mail ganha no boot o e-mail do dono da dúvida e `authorEmailInferred: true`, para não ser contada como dele em "Meus dados") |
| `progress` | objeto | progresso por aluno/unidade |
| `uploads` | objeto | metadados de arquivos enviados |
| `config` | objeto | configuração global; `releasedItems`; `retentionLastRun` `{ at, trigger: 'automatic'\|'manual', by, counts: { keystrokes, proctoringLogs, loginLogs, trash? }, remaining }` (última limpeza da retenção, H8b) |
| `admins` | array | administradores/professores (RBAC) |
| `sessions` | objeto | sessões de aluno: `email` → `{ tokenHash, createdAt, lastSeen, lastActivityAt, ip, origin? }`; `tokenHash` = sha256 do token, que fica só no navegador (`utils/authSessions.js`). `lastSeen` é a presença ("online"). Gravadas na tabela `auth_sessions` ([abaixo](#sessões-gravadas-auth_sessions)). `{ lastSeen }` sozinho (semente de demonstração do `TEST_MODE`) é só presença: não autentica e não é gravado. |
| `adminSessions` | objeto | sessões de instrutor: `'h:' + sha256(token)` → `{ email, createdAt, lastSeen, lastActivityAt, origin? }`. `origin` só aparece quando não é `login` (`setup` no acesso rápido local). Gravadas na tabela `auth_sessions`. |
| `studentExamState` | objeto | estado da prova por `studentEmail_examKey` |
| `proctoringLogs` | array | eventos de antifraude |
| `broadcastMessages` | array | mensagens do professor no monitor |
| `announcements` | array | avisos/comunicados (professor → turma/curso/aluno) |
| `attendance` | array | presença |
| `certificates` | array | certificados emitidos |
| `moduleAccess` | array | histórico de módulos acessados |
| `auditLogs` | array | trilha de auditoria (notas, cadastro do aluno, turmas e conteúdo, contas, sistema, backup, provas); ver [Auditoria](#auditoria-auditlogs) |
| `loginLogs` | array | logs de login (segurança/LGPD): `{ email, role, status: success\|fail\|throttled\|alert, reason, ip, timestamp, count?, lastAt? }`; falhas seguidas iguais em 60 s viram uma linha com `count` (H5b) |
| `pedagogicalObservations` | array | observações pedagógicas controladas |
| `library` | array | biblioteca de materiais reutilizáveis |
| `legalDocuments` | array | Termos de Uso e Política de Privacidade (tabela `legal_documents`, H8a-1): `{ id, kind: 'termos'\|'privacidade', status: 'rascunho'\|'publicado', version, title, markdown, changeSummary, createdAt, updatedAt, updatedBy, publishedAt, publishedBy, modelId? }`. Rascunho com id fixo `rascunho_<kind>`; cada publicação é `<kind>_v<N>` e não muda mais. Na restauração, junta por id (`restore: 'merge'`). O encarregado (DPO) fica em `schools[].info.dpoName`, `dpoEmail` e `dpoPhone`, gravados só pela rota de LGPD |

> A lista usada por backup/restore (`COLLECTIONS` em `backend/utils/backup.js`) é derivada do registro `COLLECTION_TABLES` (`backend/database.js`): toda entrada com `backup` diferente de `false` e que não é `derived`, na ordem do registro. Ao criar uma coleção nova, acrescente-a ao registro; ela entra no backup sozinha. As tabelas próprias (`kind: 'store'`, hoje só `examKeystrokes`) entram no JSON do backup pelo `exportRows` e voltam pelo `importRows` na mesma transação da gravação (H4a); no ZIP formato 2 elas já estão no `data/database.db` e voltam pelo `copyFromAttached` (ATTACH do banco do backup, inclusive a tabela antiga `exam_keystrokes` de um banco ainda não migrado). Backup sem as teclas (JSON antigo) deixa a tabela vazia, como as demais coleções que o backup não traz. O campo `restore` de cada entrada decide o que a restauração faz: `replace` troca pelo do backup (ausente no backup fica vazio), `merge` junta (auditoria e documentos legais), `keep` mantém o de hoje quando o backup não traz (configuração, identidade visual e estrutura dos cursos) e `reset` zera (sessões).

## Sessões gravadas (`auth_sessions`)

Fase 2, H3a-2 (CONF-03, UXA-06, DES-08). Antes, as sessões de aluno e de instrutor ficavam só na memória e qualquer reinício do servidor (queda, Reiniciar, launcher reaberto) desconectava todos, inclusive quem estava no meio da prova. Agora a entrada `authSessions` do registro (`kind: 'derived'`, `backup: false`, `restore: 'reset'`) grava a tabela `auth_sessions (key TEXT PRIMARY KEY, value TEXT)`, uma linha por sessão, calculada de `sessions` e `adminSessions` por `persistedSessionRows` (`utils/authSessions.js`) a cada gravação:

| Campo | Conteúdo |
|-------|----------|
| `key` | sha256 (hex, 64 caracteres) do token; o token cru nunca vai para o disco |
| `value.kind` | `student` ou `admin` |
| `value.email` | e-mail da conta, em minúsculas |
| `value.createdAt` | início da sessão (ms): o prazo absoluto de 8 h conta daqui |
| `value.ip` | só aluno: o IP do último acesso |
| `value.origin` | só quando não é `login` (`setup` no acesso rápido local) |

- **Sem presença**: `lastSeen` e `lastActivityAt` não entram, para a linha não mudar a cada ping. Na retomada `lastSeen` volta `null` (o aluno aparece offline no Monitor até o próximo ping) e `lastActivityAt` começa no boot.
- **Quando grava**: login (aluno, instrutor, acesso rápido), Sair, `/api/student/leave`, exclusão e troca de e-mail do aluno, Resetar sala, exclusão de conta de instrutor (as sessões dela saem; conta criada com o e-mail de uma excluída não herda sessão) e exclusão definitiva de curso (os alunos que vão para o arquivo com ele perdem a sessão, que não volta quando o curso arquivado é restaurado) gravam antes da resposta. A sessão derrubada por um 401/403 (vencida, conta apagada ou bloqueada) também sai da tabela antes da resposta; se a gravação falhar, a retomada a descarta pelas mesmas regras. A limpeza das vencidas (a cada 15 min) grava em segundo plano.
- **Boot** (`prepareServer`, passo 3): o `db.init()` lê a tabela e guarda as linhas até a retomada (as gravações do próprio boot, como migrações, não as apagam). `restoreSessions` devolve à memória as sessões com menos de 8 h quando o servidor ficou até 60 min fora do ar (`runtime/heartbeat.json`, H3b); com mais de 60 min, ou sem heartbeat (o tempo fora do ar é desconhecido), ninguém volta e todos entram de novo, como antes. `origin: 'setup'` só volta com o modo setup ligado; e-mail de aluno repetido fica com a sessão mais nova. Só volta sessão de conta que ainda pode entrar, conferida no cadastro já lido pelo `db.init()`: aluno cadastrado e com situação Ativo, instrutor cadastrado; a de aluno bloqueado, inativo ou apagado e a de instrutor apagado ficam de fora (desbloqueado o aluno, ou recriada a conta, o token antigo não entra). As que não voltaram saem da tabela no mesmo boot. O console diz o que aconteceu (`Sessões retomadas: N alunos e M professores (K descartadas)` ou `Sessões não retomadas: ...`).
- **Backup**: as sessões não vão no backup, e restaurar um backup desconecta todos e esvazia a tabela. Quem zera é o gancho `authSessions` de `db.afterRestore` (lista de ganchos pós-restauração em `database.js`, rodada por `db.runAfterRestore` no fim do `applySnapshot` de `utils/backup.js`, antes da gravação); o laço da restauração não mexe na entrada `derived`.
- **Senha redefinida pelo launcher** (`backend/scripts/reset-admin-password.js`, com o servidor parado): `db.revokeAccountSessions({ kind: 'admin', email })` tira as sessões da conta da memória e das linhas lidas no boot do script, e a gravação as apaga da tabela. As sessões das outras contas ficam e voltam no boot seguinte pelas regras de sempre.
- **Primeiro boot desta versão**: a tabela ainda não existe; todos entram de novo uma vez, como antes.
- **Motivo das sessões encerradas** (frente do H3): a mesma tabela guarda, por até 8 h, uma linha por sessão encerrada com motivo, para o 401 continuar dizendo por que a sessão caiu depois de um reinício: `key` = sha256 do token, `value` = `{ kind: 'revoked', reason, at }`, com `reason` em `logout`, `password_reset`, `password_changed` ou `replaced` (o aluno entrou em outro aparelho) e `at` em ms. Sem e-mail e sem token cru. Vem de `persistedRevocationRows` (`utils/authSessions.js`, guardadas no máximo 5000); `restoreSessions` as traz de volta mesmo quando as sessões não voltam (mais de 60 min fora do ar ou sem heartbeat) e não as conta como descartadas. Restaurar backup também as apaga. Versão anterior que lê a tabela ignora essas linhas (não são sessão).

## Histórico de digitação da prova (`exam_keystroke_events`)

Fase 2, H1-b (DES-02, CONF-06). As teclas do Modo Prova Rigoroso não ficam em `db.memory`: ficam na tabela própria `exam_keystroke_events` (entrada `examKeystrokes`, `kind: 'store'`, no registro), uma linha por tecla, e todo acesso passa por `db.keystrokes` (`backend/utils/keystrokeStore.js`).

| Coluna | Conteúdo |
|--------|----------|
| `row_id` | `INTEGER PRIMARY KEY AUTOINCREMENT`: ordem de chegada e cursor da digitação ao vivo (nunca reaproveitado) |
| `id` | id da tecla (único) |
| `student_email` | e-mail do aluno, em minúsculas |
| `student_class`, `course_id` | turma e curso da matrícula |
| `exam_key`, `application_id`, `attempt_id` | prova, aplicação e tentativa |
| `seq`, `client_ts` | sequência e hora do navegador (o `seq` recomeça quando a página recarrega) |
| `server_ts` | hora de chegada no servidor (ms) |
| `key`, `code`, `mods`, `kind`, `question` | a tecla, até 40/40/16/24/12 caracteres |
| `blocked`, `suspicious` | 0 ou 1 |

Índices: `(application_id, student_email, seq)` e `(exam_key COLLATE NOCASE, student_email, seq)`.

- **Contadores**: na memória ficam só os contadores por aplicação, prova, aluno e turma (total, suspeitas e bloqueadas, última tecla), montados no boot com um `GROUP BY` e atualizados depois de cada `COMMIT`. O Monitor, a prévia da manutenção e o cartão de armazenamento (`db.storageStatus().keystrokes`) leem deles.
- **Gravação**: `append`, `deleteRows`, `deleteWhere` (retenção), `renameEmail` (troca de e-mail do aluno) e `importRows` (restauração) entram numa fila que o motor de gravação esvazia no próximo ciclo, na mesma transação das coleções da memória; a promessa resolve depois do `COMMIT` e, dentro de um pedido, a resposta espera por ela. Falha de gravação: 503 `retryable` e a regravação em segundo plano grava a fila depois. As escritas do store não passam pelo verificador de gravação parcial (não gravam nada da memória).
- **Teto**: 20 mil teclas por aluno e aplicação (ou por aluno e prova, sem aplicação); `ICLASS_KEYSTROKE_CAP` muda o número. Passando dele, saem as mais antigas (pela hora do servidor) na mesma transação.
- **Maiúsculas**: prova e turma são comparadas sem diferenciar maiúsculas só nas letras A-Z (igual ao `COLLATE NOCASE` e ao `lower()` do SQLite).
- **Migração do banco antigo**: até a fase 1 as teclas ficavam como JSON na tabela chave-valor `exam_keystrokes`. No boot, `migrateLegacy` leva as linhas para a tabela nova numa transação única, com a fila de gravação parada (o console mostra `Migrando histórico de digitação (N registros)...` e o tempo gasto); a chave antiga vira o `id` e o e-mail vai em minúsculas. É idempotente: a migrada sai da tabela antiga e um segundo boot não acha nada. Linha com JSON ilegível ou sem aluno e prova fica na tabela antiga (aviso no console), que continua sendo criada.
- **Cópia de outro banco** (`copyFromAttached`, para a restauração do ZIP formato 2 do H4): lê a tabela nova e, num banco antigo, a tabela `exam_keystrokes` do arquivo anexado.

## Retenção (`settings.retention`, H8b)

Fase 2, H8b (SEG-13). Em `config.settings`: `retention: { proctoringDays, loginLogsDays, reviewedAt, reviewedBy }`, com 0 = não apagar (padrão; o banco antigo sem o bloco vale 0). O prazo da lixeira continua em `settings.trash.retentionDays`. `reviewedAt` (ISO) e `reviewedBy` (e-mail) marcam a primeira revisão pelo administrador; sem eles a tela mostra o aviso de prazos não revisados. Só `POST /api/admin/lgpd/retention` grava o bloco (`retention` está em `PROTECTED_SETTINGS_SECTIONS`). A limpeza (`utils/retention.js`) remove teclas por `db.keystrokes.deleteWhere({ applicationIds, before, max })` (`null` em `applicationIds` são as teclas sem aplicação) e conta por `db.keystrokes.countWhere`; `proctoringLogs` e `loginLogs` saem de `db.memory`; a lixeira, por `storage.purgeTrash`. Nada além disso é apagado por prazo.

## Diretórios em disco (`runtimePaths.js`)

| Constante | Default | Env override |
|-----------|---------|--------------|
| `DATA_DIR` | `./data` | `ICLASS_DATA_DIR` |
| `CONTENT_DIR` | `./content` | `ICLASS_CONTENT_DIR` |
| `ARCHIVE_DIR` | `./cursos_arquivados` | `ICLASS_ARCHIVE_DIR` |
| `UPLOADS_DIR` | `data/uploads` | — |
| `STUDENTS_DIR` | `data/alunos` | — |
| `TRASH_DIR` | `data/lixeira` | — |
| `BACKUPS_DIR` | `data/backups` | — |
| `WEB_DIST_DIR` | `web/dist` | — |

- `content/` guarda apostilas e avaliações em Markdown.
- `data/database.db` é o estado real da aplicação — **não editar à mão, não versionar**.
- **`config.settings.backup`** (fase 2, H4b; seção protegida, fora do `POST /api/admin/settings` e mantida na restauração): `{ destino, guardarExterno }`. `destino` é o caminho absoluto da pasta externa (vazio: só neste computador); os backups vão para `<destino>/IClass-<computador>/`. `guardarExterno` (1 a 90, padrão 14) é quantos automáticos ficam no destino. Banco sem a seção lê o padrão `{ destino: '', guardarExterno: 14 }` (`backupSettings()` em `utils/settings.js`).
- **`data/backups/estado.json`** (fase 2, H4b; fora do banco e do backup, gravado por arquivo temporário e `rename`): `{ local:{ ultimoSucesso, origem, arquivo, bytes, sha256 }, externo:{ destino, pasta, ultimoSucesso, origem, arquivo, bytes, sha256, configuradoEm }, ultimaFalha:{ em, etapa ('local'|'externo'|'verificacao'), alvo, mensagem, origem, destino }, adiadoPorProva:{ desde, ultimaConferencia, aplicacoes } | null }`. Arquivo ausente ou ilegível vale `{}`: o último backup local sai então do `automatico_*` mais novo da pasta. Os backups em si seguem o nome `<grupo>[_<variante>]_<carimbo>.(zip|json)` com um `.sha256` ao lado (`<sha256>  <nome>`, o formato do `sha256sum`).
- **`data/.restauracao/desfazer/`** (fase 2, decisões §12; dentro de `data/.restauracao/`, fora do banco e do backup; a limpeza do boot apaga o resto de `.restauracao`, nunca esta pasta): existe só durante uma restauração. `marcador.json` = `{ id, iniciadoEm, banco: 'antes.db'|null, pastas:[{ target, prep, hadPrevious }], conteudo:[{ target, temporary, saved }], cursos:[caminho], teclas }`, com `antes.db` (a cópia do banco de antes) e `conteudo/` (os `.md` de antes). Presente no boot = restauração interrompida: tudo é desfeito e a pasta sai. No fim de uma restauração, o `marcador.json` sai antes do resto da pasta; se nem ele sai (arquivo preso), o arquivo `concluida` ao lado diz ao boot que não há nada a desfazer.
- Testes devem usar diretórios temporários via as envs acima.

## Senhas

Nunca em texto puro no que sai ao cliente. `database.js` implementa:

- `hashPassword` — `scrypt` com salt aleatório, formato `scrypt$<salt>$<derived>`.
- `verifyPassword` — compara com `timingSafeEqual`; aceita hash legado sha256 e reidrata quando necessário (`needsPasswordRehash`).

## White-label (herança)

Três níveis com herança em cascata (ver [IDENTIDADE_WHITE_LABEL.md](./IDENTIDADE_WHITE_LABEL.md)):

```
Curso[campo] ?? Escola[campo] ?? Sistema[campo] ?? padrãoDeFábrica
```

`course.schoolId` aponta para a escola; trocar um dado na escola reflete em todos os cursos que não sobrescrevem.

## Regras de evolução do schema

1. **Default seguro** para todo campo novo (`?? valorPadrão`).
2. **Retrocompatibilidade**: dados antigos sem o campo devem funcionar.
3. **Registrar no registro único**: coleção nova entra em `COLLECTION_TABLES` (e daí no backup e na restauração).
4. **Nada de migração destrutiva** sobre `data/database.db` existente.
5. Ao aposentar algo (como `courseStructure`), manter leitura tolerante durante a transição.

## Servidor fora do ar durante a prova (fase 2, H3b)

- **`examApplications[].pauses[]`**: `{ pausedAt, resumedAt, reason? }` (ms). Pausa do professor não tem `reason`; o tempo devolvido de uma queda do servidor é uma pausa fechada com `reason: 'server_outage'` (`SERVER_OUTAGE_PAUSE_REASON`, `utils/examApplications.js`). Todas as contas de prazo descontam as duas do mesmo jeito (`extendDeadlineByPauses`). Pausa antiga sem `reason` continua valendo como pausa do professor.
- **`examApplications[].outages[]`** (novo, opcional; as 20 últimas): `{ from, to, durationMs, reason, compensated }`. `from`/`to` em ms; `reason` `restart` (parada limpa antes), `crash` (sem parada limpa) ou `suspended` (computador suspenso ou processo parado por mais de 30 s); `compensated: false` quando passou de 15 min e o tempo não foi devolvido. `from` é o mais tarde entre o último heartbeat, o início da aplicação, o fim da última pausa e o último salvamento de uma tentativa em andamento. Só entra queda de aplicação em que alguém ainda tinha tempo no `from` (tentativa aberta dentro do prazo ou, no cronômetro coletivo, o prazo coletivo com o maior "+N min" guardado e o maior tempo de acessibilidade): aplicação esquecida aberta ou sem ninguém fazendo não acumula quedas a cada reinício. Aplicação antiga sem o campo: sem quedas.
- **Auditoria da prova**: entrada `type: 'exam_application_server_outage'` (gravada por `recordExamAudit`, ator `sistema`, `details: { from, to, durationMs, reason, compensated, maxMinutes }`), lida pelo registro da aplicação e rotulada "Servidor fora do ar durante a prova" (`ACTION_LABELS`).
- **`DATA_DIR/runtime/heartbeat.json`** (fora do banco e do backup): `{ at, clean, reason, instanceId, pid }`, regravado a cada 5 s (arquivo temporário e `rename`; se o `rename` falhar, escrita direta). `clean: true` no fim do desligamento ordenado (fase 2, H3c: Ctrl+C, SIGTERM, fechar a janela, rota de controle, Reiniciar e erro fatal sob o supervisor), com `reason` `stop`, `restart`, `admin_restart` ou `fatal` (este conta como queda no próximo boot, mas as sessões voltam); kill -9, `taskkill /f` e falta de energia deixam `clean: false` (queda). Um heartbeat de menos de 15 s de outro processo ainda vivo é de outro servidor no ar com a mesma pasta: o segundo processo não devolve tempo nem regrava o arquivo. Apagar a pasta `runtime` só faz o próximo boot não saber quanto tempo ficou fora (o tempo não é devolvido, com aviso no console).
- **`DATA_DIR/runtime/control.token`** (fase 2, H3c; fora do banco e do backup): 64 caracteres hexadecimais, novo a cada boot, gravado com permissão 0600 logo depois de abrir a porta e apagado no desligamento ordenado e em toda falha de boot. É a senha do `POST /api/system/control` (cabeçalho `x-iclass-control`, só do próprio computador). Sobrar um arquivo de um processo morto não abre nada: o próximo boot grava outro.
- **`DATA_DIR/runtime/supervisor.pid`** (fase 2, H3c): o PID do `backend/supervisor.js`, gravado ao subir e apagado ao sair. O launcher usa para `taskkill /T` quando a rota de controle não responde. Supervisor morto sozinho: o servidor percebe pelo canal IPC, apaga o arquivo (se ainda tem o PID desse supervisor) e desliga. Depois de falta de energia o arquivo pode sobrar: o launcher confere se o PID ainda é de um `node.exe` antes de usar.
- **`DATA_DIR/logs/servidor.log`** (fase 2, H3c): a saída do servidor sob o supervisor, linha a linha com `[AAAA-MM-DD HH:MM:SS]` e sem as sequências de cor e de link do terminal, mais as linhas do próprio supervisor (`🔁 O servidor parou...`, `⛔ ...`). Gira aos 5 MB: `servidor.log.1` (o mais novo) até `servidor.log.3`. Sem o supervisor, o relançamento do Reiniciar no Linux também escreve nele. Fica fora do banco e do backup; copiar a pasta `data` para outro computador não precisa de `runtime/` nem de `logs/`.

## Auditoria (`auditLogs`)

Fonte: `backend/utils/audit.js`. A coleção é uma lista que só cresce.

- **Gravar**: `recordAudit(db.memory, { req, actor, action, category, studentEmail, targetEmail, courseId, studentClass, examKey, applicationId, submissionId, field, oldValue, newValue, reason, before, after, details })` acrescenta no fim e devolve a entrada; quem chama faz o `db.save()`. Os registradores de cada área (`recordGradeAudit`, `recordStudentAudit`, `recordAcademicAudit`, `recordAssignmentAudit`, `recordMaintenanceAudit`, `recordBackupAudit`) são atalhos dela.
- **Entrada nova (formato canônico)**: `id` (`audit_<categoria>_<ms>_<8 hex>`), `action` (nome fixo, rótulo em `ACTION_LABELS`), `category` (`grade`, `student`, `attendance`, `exam`, `academic`, `content`, `account`, `security`, `system`, `backup`, `privacy`, `other`), `actor` (e-mail em minúsculas, `sistema` ou `launcher-local`), `actorRole` (`admin`, `professor`, `aluno` ou `sistema`, quando se sabe), `timestamp` (ms), `ip`, `device` (navegador, até 160 caracteres) e os campos opcionais que vierem. `before`, `after` e `details` são cópias (não mudam quando o objeto original muda) sem `password`, `hash`, `salt`, `token`, `sessionToken`, `accessToken` nem chave terminada em `password`, `senha`, `token`, `secret`, `hash` ou `salt` (como `accessTokenHash`, o sha256 sem sal do token da prova, que se desfaz por tentativa, e `tokenHash` das sessões); a chave sai mesmo com valor vazio, e só um valor booleano fica (`mustChangePassword`, `tokenEnabled`). Os atalhos de turma, escopo do professor, manutenção e modo de configuração local gravam também os campos antigos (`type`, `actorEmail`, `at`, `target`, `profile`), que as telas de hoje leem.
- **Entradas de prova**: `type` + `applicationId` + `actor` + `timestamp` em ISO, gravadas por `recordExamAudit` (`examFinish.js`), `examDeadline.js` e pela contestação do aluno; `buildApplicationAuditTrail` lê pelo `type` (inclusive `exam_application_server_outage`, do `utils/serverLifecycle.js`).
- **Formatos antigos** (nunca reescritos; `normalizeAuditEntry(entrada)` lê todos): `action`/`actor`/`timestamp` em ms (notas, cadastro, backup), `type`/`actorEmail`/`at` em ms (turmas e conteúdo, escopo do professor, manutenção), `type`/`actor`/`timestamp` em ISO (provas) e `type`/`actorEmail`/`at` em ISO (modo de configuração local). A categoria que falta sai do nome da ação (`ACTION_CATEGORIES` e o começo do nome); ação desconhecida aparece como "Outro evento (nome)".
- **Quem pode alterar uma entrada existente**: só a troca de e-mail do aluno (`renameStudentEmailEverywhere`), a anonimização (`anonymizeStudentAuditTrail`), o apagar de vez do aluno e a restauração de backup. `mergeAuditTrails(trilhaDoBackup, trilhaAtual)` é a junção para a restauração não apagar o que foi registrado depois do backup: todas as entradas do backup (a do backup vence no mesmo `id`) mais as atuais que ele não tem, em ordem de hora; backup sem a trilha deixa a atual como está. Enquanto a restauração não usa a junção, ela troca a trilha pela do backup e devolve só o histórico de backup (`keepBackupHistory`, `adminRecovery.js`).
