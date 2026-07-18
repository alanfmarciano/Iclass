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
| `auditLogs` | array | auditoria de alterações no perfil do aluno |
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
