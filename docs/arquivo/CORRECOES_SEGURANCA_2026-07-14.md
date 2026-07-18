# Correções de Segurança e Bugs — IClass V3

Data: 2026-07-14
Backup pré-correção: `backups/IclassV3_precorrecao_2026-07-14_13-41-31/`

> **Importante:** as correções foram verificadas por leitura do código, mas **não
> foi possível rodar a suíte de testes no ambiente de análise** (o binário nativo
> do `sqlite3` e o build Vite só funcionam no Windows). Rode `npm run check` na sua
> máquina para validar. Veja o checklist no fim.

---

## Críticos

### 1. Porta dos fundos no seed de teste
`backend/routes/testmode.js`
`/api/test/seed` rodava para qualquer requisição de localhost mesmo sem
`TEST_MODE`, recriando `admin@teste.local` (role admin) com senha `teste` em
produção. Agora só executa com o servidor em `TEST_MODE=1`.

### 2. Escalonamento de privilégio via `accounts.manage`
`backend/utils/adminPermissions.js`, `backend/routes/adminAccounts.js`
`accounts.manage`/`page.accounts` passaram a ser exclusivas de administrador
(não concedíveis a professor). Além disso, os handlers `accounts/create|update|delete`
agora recusam qualquer requisitante com role `professor` (defesa em camadas),
impedindo criar conta admin ou auto-promoção.

## Altos

### 3. Vazamento de upload entre cursos (IDOR)
`backend/server.js` (`sendControlledFile`)
Uploads sem registro na biblioteca eram servidos a qualquer aluno autenticado.
Agora o aluno só acessa uploads que sejam item de biblioteca (e, se o item tiver
curso, dentro dos cursos em que está matriculado).
> ⚠️ Testar no Windows: confirmar que nenhum upload legítimo fora da biblioteca
> deixou de abrir para alunos.

### 4. Força bruta em login e token de prova (sem rate limiting)
`backend/utils/rateLimit.js` (novo), `backend/routes/student.js`,
`backend/middlewares.js`, `backend/routes/proctoring.js`
Adicionado rate limiter em memória (30 req/min por IP) no login do aluno, no
login admin legado e na validação do token de prova. Limites generosos para não
afetar uso legítimo em sala.

### 5. Token de sessão na URL de arquivos — NÃO ALTERADO (decisão)
`web/src/lib/contentMarkdown.js`
Por sua orientação, ignorado: essa área (material/apostila) será refeita.

## Médios

### 6. `flush-exam-state` apagava dados de toda a turma
`backend/routes/adminSystem.js`
Lógica OR trocada por AND em `proctoringLogs` e `broadcastMessages` (só remove o
que bate com todos os filtros). Corrigida também a colisão de prefixo de e-mail
(`startsWith(email + '_')`).

### 7. CSV / formula injection na exportação de notas
`backend/routes/admin.js`
Adicionado `csvSafe()`: neutraliza fórmulas (`=`, `+`, `-`, `@`) e escapa
delimitador/aspas/quebra de linha em todos os campos do CSV.

### 8. CORS totalmente aberto
`backend/server.js`
`cors()` restrito a requisições sem Origin (mesma origem) e a hosts locais/LAN
(localhost, 10.x, 192.168.x, 172.16–31.x).

### 9. `change-password` sem senha atual
`backend/routes/adminAccounts.js`
Fora da troca obrigatória inicial (`mustChangePassword`), passa a exigir e
verificar a senha atual. O fluxo forçado de primeira troca continua funcionando
sem mudança no frontend.

## Baixos

### 10. Status HTTP inválido no recover
`backend/routes/student.js` — `444` → `404`.

### 11. Senha aceita via query string no login admin legado
`backend/middlewares.js` — removido `req.query.password` (senha não aparece mais
em logs/histórico do navegador).

---

## Itens NÃO corrigidos (com motivo)

- **Endpoints GET pós-login sem sessão** (`data.js`, `status`, `courses`, `forum`,
  `annotations`): ligados à área de material/leitura que será refeita — não mexi
  para não conflitar com a reescrita.
- **Encoding corrompido** (`nÃ£o`, `AvaliaÃ§Ã£o`): mojibake espalhado em vários
  arquivos; correção segura exige um passe deliberado de re-gravação em UTF-8.
- **`localStorage` → cookie HttpOnly** e **modularizar `admin.js` / normalizar
  SQLite**: fora do escopo acordado (mudanças arquiteturais).
- **Qualidade frontend** (`key={index}`, `prompt()/confirm()` nativos, componentes
  gigantes): não são segurança; ficam para um passe de refino.

---

## Arquivos alterados
- `backend/routes/testmode.js`
- `backend/utils/adminPermissions.js`
- `backend/routes/adminAccounts.js`
- `backend/server.js`
- `backend/utils/rateLimit.js` (novo)
- `backend/routes/student.js`
- `backend/routes/proctoring.js`
- `backend/middlewares.js`
- `backend/routes/adminSystem.js`
- `backend/routes/admin.js`
- `web/src/hooks/useApi.js`

## Checklist de validação (rode no Windows)
1. `npm run test:backend` — deve passar (as 2 falhas do ambiente de análise eram
   só o `sqlite3` nativo do Linux).
2. `npm run check` — testes web + build + e2e.
3. Smoke test manual:
   - Login admin normal; login aluno.
   - Abrir material/apostila e **baixar um arquivo da biblioteca** (valida o IDOR).
   - Fazer uma prova com token (valida rate limit não atrapalha).
   - Exportar CSV de notas (abre no Excel sem erro).
   - Conta professor: confirmar que não acessa gestão de contas.
   - Troca de senha temporária (primeiro acesso) ainda funciona.
