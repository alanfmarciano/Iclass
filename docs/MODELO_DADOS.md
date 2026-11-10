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

O banco abre em modo WAL com `synchronous=FULL` (o "salvo" sobrevive a queda de energia) e `busy_timeout` de 5 s (`ICLASS_DB_BUSY_TIMEOUT_MS`). Com o servidor ligado, `data/` tem três arquivos: `database.db`, `database.db-wal` (gravações ainda não aplicadas ao arquivo principal) e `database.db-shm` (índice do WAL). Ao desligar com Ctrl+C (ou SIGTERM) o servidor grava, fecha o banco e o `-wal` some. Fechar a janela do console e o botão Reiniciar ainda saem sem fechar o banco: o que já foi confirmado está no `-wal`, que o SQLite aplica na subida seguinte. Copiar o banco com o servidor ligado exige os três arquivos juntos; o certo é usar o backup do sistema. Em pasta de rede ou sincronizada (OneDrive) o modo WAL pode não pegar: o servidor segue com aviso no console e o modo real aparece em `db.storageStatus().journalMode`.

`db.storageStatus()` é a fonte única do estado do armazenamento: modo do diário, `synchronous`, `busy_timeout`, tamanho do banco e do `-wal`, linhas por coleção, teclas da prova gravadas (`keystrokes`), última gravação completa, p95 do `COMMIT`, último erro de gravação e se há regravação pendente.

## Coleções em `db.memory`

| Coleção | Tipo | Conteúdo |
|---------|------|----------|
| `students` | array | alunos (perfil, turmas, credencial) |
| `classes` | array | turmas; `activeExamKey`, `examConfigs`, `onlineExamConfigs`, liberações |
| `courses` | array | cursos (multi-curso); `structure`, `schoolId` |
| `branding` | objeto | identidade white-label global |
| `schools` | array | escolas/instituições (white-label, compartilháveis) |
| `submissions` | array | submissões de prova |
| `examApplications` | array | aplicações de prova (ciclo de vida próprio, `applicationId` imutável) |
| `questionBank` | array | banco de questões reutilizáveis |
| `evaluations` | objeto | avaliações |
| `courseStructure` | array | estrutura legada (**em obsolescência**, migrada para `courses[].structure`) |
| `notes` | objeto | caderno do aluno por material |
| `annotations` | objeto | anotações por parágrafo |
| `forum` | array | dúvidas/fórum por unidade |
| `progress` | objeto | progresso por aluno/unidade |
| `uploads` | objeto | metadados de arquivos enviados |
| `config` | objeto | configuração global; `releasedItems` |
| `admins` | array | administradores/professores (RBAC) |
| `sessions` | objeto | sessões de aluno (só na memória): `email` → `{ tokenHash, createdAt, lastSeen, lastActivityAt, ip, origin? }`; `tokenHash` = sha256 do token, que fica só no navegador (`utils/authSessions.js`). `lastSeen` é a presença ("online"). |
| `adminSessions` | objeto | sessões de instrutor (só na memória): `'h:' + sha256(token)` → `{ email, createdAt, lastSeen, lastActivityAt, origin? }`. `origin` só aparece quando não é `login` (`setup` no acesso rápido local). |
| `studentExamState` | objeto | estado da prova por `studentEmail_examKey` |
| `proctoringLogs` | array | eventos de antifraude |
| `broadcastMessages` | array | mensagens do professor no monitor |
| `announcements` | array | avisos/comunicados (professor → turma/curso/aluno) |
| `attendance` | array | presença |
| `certificates` | array | certificados emitidos |
| `moduleAccess` | array | histórico de módulos acessados |
| `auditLogs` | array | trilha de auditoria (notas, cadastro do aluno, turmas e conteúdo, contas, sistema, backup, provas); ver [Auditoria](#auditoria-auditlogs) |
| `loginLogs` | array | logs de login (segurança/LGPD) |
| `pedagogicalObservations` | array | observações pedagógicas controladas |
| `library` | array | biblioteca de materiais reutilizáveis |

> A lista usada por backup/restore (`COLLECTIONS` em `backend/utils/backup.js`) é derivada do registro `COLLECTION_TABLES` (`backend/database.js`): toda entrada com `backup` diferente de `false` e que não é `derived`, na ordem do registro. Ao criar uma coleção nova, acrescente-a ao registro; ela entra no backup sozinha. As tabelas próprias (`kind: 'store'`, hoje só `examKeystrokes`) estão na lista, mas o JSON do backup e a restauração ainda não as levam: entram pelo `exportRows`/`importRows` do H4a; até lá o backup continua sem as teclas, como sempre foi, e restaurar não mexe nelas.

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
- **`DATA_DIR/runtime/heartbeat.json`** (fora do banco e do backup): `{ at, clean, reason, instanceId, pid }`, regravado a cada 5 s (arquivo temporário e `rename`; se o `rename` falhar, escrita direta). `clean: true` quando o processo saiu com código 0 (Ctrl+C, SIGTERM, Reiniciar); kill -9, `taskkill /f` e falta de energia deixam `clean: false` (queda). Um heartbeat de menos de 15 s de outro processo ainda vivo é de outro servidor no ar com a mesma pasta: o segundo processo não devolve tempo nem regrava o arquivo. Apagar a pasta `runtime` só faz o próximo boot não saber quanto tempo ficou fora (o tempo não é devolvido, com aviso no console).

## Auditoria (`auditLogs`)

Fonte: `backend/utils/audit.js`. A coleção é uma lista que só cresce.

- **Gravar**: `recordAudit(db.memory, { req, actor, action, category, studentEmail, targetEmail, courseId, studentClass, examKey, applicationId, submissionId, field, oldValue, newValue, reason, before, after, details })` acrescenta no fim e devolve a entrada; quem chama faz o `db.save()`. Os registradores de cada área (`recordGradeAudit`, `recordStudentAudit`, `recordAcademicAudit`, `recordAssignmentAudit`, `recordMaintenanceAudit`, `recordBackupAudit`) são atalhos dela.
- **Entrada nova (formato canônico)**: `id` (`audit_<categoria>_<ms>_<8 hex>`), `action` (nome fixo, rótulo em `ACTION_LABELS`), `category` (`grade`, `student`, `attendance`, `exam`, `academic`, `content`, `account`, `security`, `system`, `backup`, `privacy`, `other`), `actor` (e-mail em minúsculas, `sistema` ou `launcher-local`), `actorRole` (`admin`, `professor`, `aluno` ou `sistema`, quando se sabe), `timestamp` (ms), `ip`, `device` (navegador, até 160 caracteres) e os campos opcionais que vierem. `before`, `after` e `details` são cópias (não mudam quando o objeto original muda) sem `password`, `hash`, `salt`, `token`, `sessionToken`, `accessToken` nem chave terminada em `password`, `senha`, `token`, `secret`, `hash` ou `salt` (como `accessTokenHash`, o sha256 sem sal do token da prova, que se desfaz por tentativa, e `tokenHash` das sessões); a chave sai mesmo com valor vazio, e só um valor booleano fica (`mustChangePassword`, `tokenEnabled`). Os atalhos de turma, escopo do professor, manutenção e modo de configuração local gravam também os campos antigos (`type`, `actorEmail`, `at`, `target`, `profile`), que as telas de hoje leem.
- **Entradas de prova**: `type` + `applicationId` + `actor` + `timestamp` em ISO, gravadas por `recordExamAudit` (`examFinish.js`), `examDeadline.js` e pela contestação do aluno; `buildApplicationAuditTrail` lê pelo `type` (inclusive `exam_application_server_outage`, do `utils/serverLifecycle.js`).
- **Formatos antigos** (nunca reescritos; `normalizeAuditEntry(entrada)` lê todos): `action`/`actor`/`timestamp` em ms (notas, cadastro, backup), `type`/`actorEmail`/`at` em ms (turmas e conteúdo, escopo do professor, manutenção), `type`/`actor`/`timestamp` em ISO (provas) e `type`/`actorEmail`/`at` em ISO (modo de configuração local). A categoria que falta sai do nome da ação (`ACTION_CATEGORIES` e o começo do nome); ação desconhecida aparece como "Outro evento (nome)".
- **Quem pode alterar uma entrada existente**: só a troca de e-mail do aluno (`renameStudentEmailEverywhere`), a anonimização (`anonymizeStudentAuditTrail`), o apagar de vez do aluno e a restauração de backup. `mergeAuditTrails(trilhaDoBackup, trilhaAtual)` é a junção para a restauração não apagar o que foi registrado depois do backup: todas as entradas do backup (a do backup vence no mesmo `id`) mais as atuais que ele não tem, em ordem de hora; backup sem a trilha deixa a atual como está. Enquanto a restauração não usa a junção, ela troca a trilha pela do backup e devolve só o histórico de backup (`keepBackupHistory`, `adminRecovery.js`).
