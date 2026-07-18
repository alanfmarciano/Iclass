# Arquitetura — IClass V3

Documento para quem mantém o projeto. Explica as camadas, o fluxo de dados e as decisões estruturais. Escrito para ser compreensível inclusive por dev júnior.

## 1. Visão macro

```
Navegador (React SPA)  ──HTTP /api──►  Express (Node)  ──►  SQLite (arquivo)
   web/                                   backend/            data/database.db
```

- **Frontend** (`web/`): apenas apresentação e chamadas de API. Não decide regra de negócio.
- **Backend** (`backend/`): **fonte de verdade** (server-authoritative). Autenticação, liberação de conteúdo, correção de prova e sanitização de gabarito ficam aqui.
- **Local-first**: tudo roda na máquina do professor; alunos acessam pela rede local. O mesmo processo Express serve a API e o build estático do React (`web/dist`).

## 2. Camadas do backend

```
backend/
├── server.js          # bootstrap: CORS, static, monta routers, error handler, listen
├── runtimePaths.js    # resolve DATA_DIR, CONTENT_DIR, ARCHIVE_DIR (configuráveis por env)
├── database.js        # SQLite key-value + espelho em memória (db.memory) + db.save()
├── middlewares.js     # validateAdmin, validateStudentSession, sanitização, RBAC
├── routes/            # um router por área funcional
└── utils/             # regras isoladas e reutilizáveis (backup, provas, segurança, etc.)
```

### server.js — ordem de montagem (importa)

1. `cors` + `express.json({ limit: '10mb' })`.
2. Rotas de arquivos controlados: `/uploads/:filename`, `/imagens/:filename` (passam por `sendControlledFile`).
3. `express.static(web/dist)` — serve a SPA.
4. Guard de RBAC do admin em `/api/admin` (`adminRbacGuard`).
5. Routers montados: `proctoring`, `testmode`, `setupMode`, `common`, `student`, `admin`.
6. `errorHandler` no fim.

### routes/ — divisão por área

| Router | Responsabilidade |
|--------|------------------|
| `common.js` | endpoints públicos/compartilhados |
| `student.js` | portal do aluno, submissão de prova, progresso |
| `admin.js` | núcleo administrativo do instrutor |
| `adminAccounts.js` | contas de administradores/professores |
| `adminArchive.js` | arquivamento de cursos |
| `adminExamConfig.js` | configuração e aplicação de provas |
| `adminRecovery.js` | recuperação/restore |
| `adminSystem.js` | configuração de sistema, IP, flush de estado |
| `proctoring.js` | monitoramento antifraude da prova |
| `setupMode.js` | modo de setup/acesso rápido local |
| `testmode.js` | seed/reset apenas sob `TEST_MODE=1` |

### utils/ — regras isoladas

Cada arquivo encapsula uma responsabilidade testável: `backup.js`, `examApplications.js`, `examAttempts.js`, `examGrading.js`, `examToken.js`, `security.js`, `safePath.js`, `rateLimit.js`, `uploadSecurity.js`, `studentSessions.js`, `students.js`, `branding.js`, `buildIntegrity.js`, `parser.js`, entre outros. Novas regras de negócio devem nascer aqui, não dentro do handler da rota.

## 3. Persistência — o padrão `db.memory` + `db.save()`

O SQLite é usado como **key-value** (tabelas no formato `NOME (key TEXT PRIMARY KEY, value TEXT)`). O estado vive espelhado em memória em `db.memory` (um objeto com uma coleção por chave) e é serializado para o disco em `db.save()`.

```js
const db = require('../database.js');

db.memory.students.push(novoAluno);   // mutação em memória
await db.save();                       // persiste no SQLite
```

- `db.memory` é o objeto de estado (ver [MODELO_DADOS.md](./MODELO_DADOS.md)).
- `db.save()` (alias de `saveToDisk`) serializa a escrita (flags internas `isSaving`/`hasPendingSave`).
- Sempre **mute e depois salve**; nunca escreva SQL cru fora de `database.js`.

## 4. Camadas do frontend

```
web/src/
├── components/ui/     # primitivos reutilizáveis (design system)
├── components/layout/ # shell: sidebar, topbar
├── components/calendar/
├── features/admin/    # telas do instrutor
├── features/student/  # portal do aluno (+ exam/ = runner de prova)
├── context/           # AuthProvider, ThemeProvider, ToastProvider, BrandingProvider, PreferencesProvider
├── lib/               # api.js (cliente único), cn.js, contentMarkdown.js, sessionActivity.js
├── hooks/             # useApi.js, useAdminWorkspace.js
└── styles/
```

- **Cliente único de API** (`lib/api.js`): nenhuma tela usa `fetch` cru. Repository pattern — tudo passa por `api.get/post/put/delete`.
- **Providers de contexto** injetam auth, tema, toasts e branding. Ex.: `AuthProvider` injeta as credenciais no `api.js` via `setAuthProvider`.
- **features/** contém as telas; **components/ui/** contém os primitivos. Telas compõem primitivos, não os reinventam.

## 5. O problema dos arquivos monolíticos (resolvido)

A interface anterior concentrava lógica em poucos arquivos gigantes. A V3 quebra isso em: primitivos de UI reutilizáveis, uma tela por arquivo em `features/`, contextos para estado transversal e um cliente de API único. Ao adicionar telas, mantenha esse particionamento.

## 6. Decisões-chave (e o porquê)

- **SQLite key-value + memória**: simplicidade local-first; backup e restore viram serialização de JSON (ver `utils/backup.js`).
- **Server-authoritative**: segurança em rede local não pode depender do cliente. Gabarito e correção nunca saem do servidor.
- **Um router por área**: evita o retorno dos monólitos e facilita RBAC granular em `/api/admin`.
- **Paths configuráveis por env** (`ICLASS_DATA_DIR`, `ICLASS_CONTENT_DIR`, `ICLASS_ARCHIVE_DIR`): permite testes isolados em diretórios temporários.

Ver decisões de dado em [MODELO_DADOS.md](./MODELO_DADOS.md) e de segurança em [SEGURANCA.md](./SEGURANCA.md).
