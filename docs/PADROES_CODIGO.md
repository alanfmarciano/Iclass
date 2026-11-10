# Padrões de Código — IClass V3

Convenções para manter o código consistente. Onde o código atual já estabelece um padrão, ele é a referência.

## Stack

- **Backend**: Node.js 20.19+, Express 5, SQLite (`sqlite3`), CommonJS (`require`/`module.exports`).
- **Frontend**: React 18, Vite 7, Tailwind 3, React Router 6, ES Modules (`import`/`export`).
- **Bibliotecas de frontend permitidas**: `lucide-react` (ícones), `marked` + `dompurify` (Markdown seguro). Não adicionar libs de UI.

## Estrutura de pastas

Ver [ARQUITETURA.md](./ARQUITETURA.md). Regra prática:

- Backend: rota fina em `routes/`, regra de negócio em `utils/`.
- Frontend: uma tela por arquivo em `features/`, primitivo reutilizável em `components/ui/`.
- Teste ao lado do código no frontend (`Componente.test.jsx`) e em `test/` no backend.

## Nomenclatura

| Item | Convenção | Exemplo |
|------|-----------|---------|
| Componente React / arquivo de tela | PascalCase `.jsx` | `AlunosPage.jsx`, `StatCard.jsx` |
| Util/módulo JS | camelCase `.js` | `examGrading.js`, `useApi.js` |
| Função e variável | camelCase | `validateAdmin`, `activeExamKey` |
| Coleção em `db.memory` | camelCase plural | `students`, `examApplications` |
| Rota de API | kebab/lowercase sob `/api/...` | `/api/admin/online-exam-config` |
| Constante de módulo | UPPER_SNAKE | `DATA_DIR`, `MAX_UNCOMPRESSED_BYTES` |
| Teste backend | `*.test.js` em `test/backend/` | `exam-attempts.test.js` |

## Backend — convenções

- **CommonJS**: `const x = require(...)`, `module.exports = { ... }`.
- **Rota fina**: o handler valida credencial, lê `req.body`, chama util e responde. Nada de regra de negócio complexa inline.
- **Acesso a estado**: sempre via `db.memory` + `db.save()`. Nunca SQL cru fora de `database.js`.
- **Autorização primeiro**: todo handler admin começa com `validateAdmin(req, res, cb)`; aluno com `validateStudentSession`. Ver [API.md](./API.md).
- **Erros**: responder `res.status(4xx).json({ error: 'mensagem em pt-BR' })`. Deixar exceções não tratadas subirem para o `errorHandler`: o callback de `validateAdmin`/`validateAdminPermission` já roda dentro da guarda (`runGuarded`), o callback do multer vai embrulhado em `guarded(req, res, fn)` e um `catch` que não sabe tratar o erro devolve `sendInternalError(err, req, res)` (500 com o texto padrão "Ocorreu um erro interno no servidor. Código do erro: <id>." e registro no `crash.log`), opcionalmente com o contexto em pt-BR, que vai só para o `crash.log` (`sendInternalError(err, req, res, 'Falha ao gravar arquivo no disco.')`). Um `catch` que recebe tanto a recusa prevista (erro com `status` 4xx e mensagem em português, como o de `forkMaterial`, `transitionExamApplication` ou as recusas de `utils/backup.js`) quanto a falha inesperada usa `sendRouteError(err, req, res)`: a recusa responde com a própria mensagem e o resto vira o 500 com o código; `publicErrorMessage(err, req)` dá o mesmo texto para quem também precisa registrá-lo (histórico de backup). Erro do multer passa por `sendUploadError` (admin.js): recusa do envio é 400, falha do disco é 500. Nenhum `res.status(500)` escrito à mão nas rotas e nenhuma mensagem de erro (`<variável>.message`) devolvida direto na resposta, salvo as de validadores com texto fixo em português (o teste `entrada-e-erros` confere).
- **Padrão de router com fábrica** quando precisa de config (ex.: `createAdminSystemRouter({ port })`).
- **Auditoria**: entrada nova em `auditLogs` só por `recordAudit(db.memory, { req, actor, action, category, ... })` (`utils/audit.js`), com um nome de ação fixo e o rótulo em português em `ACTION_LABELS`; senha, hash, sal e token nunca entram (a função tira de `before`, `after` e `details` toda chave com esses nomes ou terminada neles, como `accessTokenHash`). A trilha só cresce: nada altera ou remove uma entrada existente fora da troca de e-mail do aluno, da anonimização, do apagar de vez e da restauração (`test/backend/audit-trail.test.js` confere no código, seguindo a lista e suas entradas por apelido, índice, `find`, `filter`, desestruturação, `for...of` e callbacks; função nova que precise mexer numa entrada entra na lista `MAY_ALTER` do teste). A exceção são as entradas de prova (`type: 'exam_...'` escrito no objeto + `applicationId`), lidas por `buildApplicationAuditTrail`; com o `type` numa variável, só dentro do registrador de prova (`recordExamAudit`), que é sempre chamado com um `'exam_...'` escrito. Para ler, `normalizeAuditEntry` entende os formatos antigos sem reescrever nada. Ver [MODELO_DADOS.md](./MODELO_DADOS.md#auditoria-auditlogs).

```js
router.post('/api/admin/config', (req, res) => {
    validateAdmin(req, res, config => {
        const { studentClass, courseId } = req.body;
        // ...regra via util...
        res.json(responseData);
    });
});
```

## Frontend — convenções

- **ES Modules** e componentes funcionais com hooks. Sem class components.
- **Chamadas de API só via `lib/api.js`** (`api.get/post/put/delete`). Nunca `fetch` cru numa tela.
- **Estado transversal via contexto**: auth (`AuthProvider`), tema (`ThemeProvider`), toasts (`ToastProvider`), branding (`BrandingProvider`), preferências (`PreferencesProvider`).
- **Composição de UI**: usar os primitivos de `components/ui/` (`Card`, `Button`, `Table`, `Modal`, `PageState`, etc.). Ver [PADROES_UI.md](./PADROES_UI.md).
- **Markdown**: renderizar sempre via `lib/contentMarkdown.js` (usa `marked` + `dompurify`). Nunca `dangerouslySetInnerHTML` com HTML não sanitizado.
- **Classes CSS**: helper `cn()` (`lib/cn.js`) para compor classes Tailwind. Sem cor hexadecimal hardcoded — usar tokens.

## Idioma

- Interface, mensagens de erro e comentários voltados ao domínio: **pt-BR**.
- Sem anglicismos na UI (`Tentativas`, não `Attempts`).
- Datas: `toLocaleString('pt-BR')` / `toLocaleDateString('pt-BR')`.

## Formatação

- Siga o estilo do arquivo que está editando (indentação, aspas, ponto e vírgula).
- Funções pequenas e com responsabilidade única. Se um handler cresce, extraia para `utils/`.
- Evite dependências novas; prefira o que já existe no projeto.

## Compatibilidade retroativa (obrigatória)

Campos novos em coleções existentes precisam de **default seguro**. Código que lê dados antigos não pode assumir a presença do campo:

```js
const maxAttempts = config.maxAttempts ?? null; // null = ilimitado (default seguro)
```

Nunca escreva uma migração que impeça `data/database.db` antigo de carregar.
