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
- **Erros**: responder `res.status(4xx).json({ error: 'mensagem em pt-BR' })`. Deixar exceções não tratadas subirem para o `errorHandler`.
- **Padrão de router com fábrica** quando precisa de config (ex.: `createAdminSystemRouter({ port })`).

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
