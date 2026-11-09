# Modelo de Dados — IClass V3

Como o estado é organizado, persistido e evoluído. Fonte no código: `backend/database.js` e `backend/runtimePaths.js`.

## Persistência

- **SQLite key-value**: cada coleção tem uma tabela `NOME (key TEXT PRIMARY KEY, value TEXT)`, onde `value` é JSON serializado.
- **Espelho em memória**: `db.memory` é um objeto com uma propriedade por coleção. Toda leitura/escrita da aplicação passa por ele.
- **Salvar**: `db.save()` (alias de `saveToDisk`) serializa `db.memory` para o SQLite. A escrita é serializada internamente para evitar corridas.

```js
const db = require('../database.js');
db.memory.courses.push(novoCurso);
await db.save();
```

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
| `sessions` | objeto | sessões de aluno online (`email` → dados/ping) |
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

> A lista canônica usada por backup/restore está em `COLLECTIONS` (`backend/utils/backup.js`). Ao criar uma coleção nova, adicione-a lá para que entre no backup.

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
3. **Registrar no backup**: coleção nova entra em `COLLECTIONS`.
4. **Nada de migração destrutiva** sobre `data/database.db` existente.
5. Ao aposentar algo (como `courseStructure`), manter leitura tolerante durante a transição.

## Auditoria (`auditLogs`)

Fonte: `backend/utils/audit.js`. A coleção é uma lista que só cresce.

- **Gravar**: `recordAudit(db.memory, { req, actor, action, category, studentEmail, targetEmail, courseId, studentClass, examKey, applicationId, submissionId, field, oldValue, newValue, reason, before, after, details })` acrescenta no fim e devolve a entrada; quem chama faz o `db.save()`. Os registradores de cada área (`recordGradeAudit`, `recordStudentAudit`, `recordAcademicAudit`, `recordAssignmentAudit`, `recordMaintenanceAudit`, `recordBackupAudit`) são atalhos dela.
- **Entrada nova (formato canônico)**: `id` (`audit_<categoria>_<ms>_<8 hex>`), `action` (nome fixo, rótulo em `ACTION_LABELS`), `category` (`grade`, `student`, `attendance`, `exam`, `academic`, `content`, `account`, `security`, `system`, `backup`, `privacy`, `other`), `actor` (e-mail em minúsculas, `sistema` ou `launcher-local`), `actorRole` (`admin`, `professor`, `aluno` ou `sistema`, quando se sabe), `timestamp` (ms), `ip`, `device` (navegador, até 160 caracteres) e os campos opcionais que vierem. `before`, `after` e `details` são cópias (não mudam quando o objeto original muda) sem `password`, `hash`, `salt`, `token`, `sessionToken`, `accessToken` nem chave terminada em `password`, `senha`, `token` ou `secret`. Os atalhos de turma, escopo do professor, manutenção e modo de configuração local gravam também os campos antigos (`type`, `actorEmail`, `at`, `target`, `profile`), que as telas de hoje leem.
- **Entradas de prova**: `type` + `applicationId` + `actor` + `timestamp` em ISO, gravadas por `recordExamAudit` (`examFinish.js`), `examDeadline.js` e pela contestação do aluno; `buildApplicationAuditTrail` lê pelo `type`.
- **Formatos antigos** (nunca reescritos; `normalizeAuditEntry(entrada)` lê todos): `action`/`actor`/`timestamp` em ms (notas, cadastro, backup), `type`/`actorEmail`/`at` em ms (turmas e conteúdo, escopo do professor, manutenção), `type`/`actor`/`timestamp` em ISO (provas) e `type`/`actorEmail`/`at` em ISO (modo de configuração local). A categoria que falta sai do nome da ação (`ACTION_CATEGORIES` e o começo do nome); ação desconhecida aparece como "Outro evento (nome)".
- **Quem pode alterar uma entrada existente**: só a troca de e-mail do aluno (`renameStudentEmailEverywhere`), a anonimização (`anonymizeStudentAuditTrail`), o apagar de vez do aluno e a restauração de backup. `mergeAuditTrails(trilhaDoBackup, trilhaAtual)` é a junção para a restauração não apagar o que foi registrado depois do backup: todas as entradas do backup (a do backup vence no mesmo `id`) mais as atuais que ele não tem, em ordem de hora; backup sem a trilha deixa a atual como está. Enquanto a restauração não usa a junção, ela troca a trilha pela do backup e devolve só o histórico de backup (`keepBackupHistory`, `adminRecovery.js`).
