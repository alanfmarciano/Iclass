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
├── database.js        # SQLite key-value + espelho em memória (db.memory) + db.save() + registro COLLECTION_TABLES
├── middlewares.js     # validateAdmin, validateStudentSession, sanitização, RBAC
├── routes/            # um router por área funcional
└── utils/             # regras isoladas e reutilizáveis (backup, provas, segurança, etc.)
```

### server.js — ordem de montagem (importa)

1. `assignRequestId` (X-Request-Id), `cors`, cabeçalho do build, `Cache-Control: no-store` em todo `/api` (e em `.html`/`.js` fora de `/assets`, como `/data.js`), `compressTextResponses` (gzip das respostas de texto acima de 1 KB, `utils/httpCompression.js`; fica antes de quem espera o COMMIT para responder) e leitor JSON com limite por sessão (10 MB com sessão de instrutor, 512 KB nos demais, inclusive o lote de teclas da prova, que o cliente manda em lotes de até 500 desde o H2-C), seguido de `req.body = {}` quando não há corpo. O leitor de query fica com o último valor de parâmetro repetido.
2. `/assets` → `serveBuildAssets` (`utils/staticAssets.js`): terminal, com cache imutável de um ano e as versões `.br`/`.gz` do build; nome que não existe é 404 com no-store, nunca o `index.html`. A regra de nomes (`isServableAssetName`: letras sem acento, números, `.`, `_` e `-`, sem ponto no começo nem no fim) é a mesma que o build usa para dar nome aos arquivos (`toServableAssetName` no `sanitizeFileName` do `vite.config.js`) e que o `check:bundle` confere em cada arquivo de `web/dist/assets`. Por isso o `staticAssets.js` entra no hash do build (`BACKEND_BUILD_FILES` em `utils/buildIntegrity.js`): mudar a regra deixa o build desatualizado e o servidor pede `npm run build`.
3. Rotas de arquivos controlados: `/uploads/:filename`, `/imagens/:filename` (passam por `sendControlledFile`).
4. `express.static(web/dist, { index: false })` — o resto da raiz do build, sem entregar o `index.html` sozinho.
5. Guard de RBAC do admin em `/api/admin` (`adminRbacGuard`).
6. Routers montados: `proctoring`, `testmode`, `setupMode`, `common`, `student`, `admin`.
7. Fallback do app: qualquer outro caminho (inclusive `/`) recebe o `index.html` com no-store; `/assets` nunca chega aqui.
8. `errorHandler` no fim.

### Entrega do app na rede da sala (cache e compressão)

- **`/assets`**: os nomes têm o hash do conteúdo (`index-<hash>.js`), então ficam no aparelho para sempre (`public, max-age=31536000, immutable`). O build grava ao lado de cada arquivo de texto de 1 KB ou mais a versão `.gz` (gzip 9) e a `.br` (brotli 11) (`web/scripts/compress-assets.mjs`, no `npm run build`). O servidor manda a `.br` quando o navegador aceita br (só em HTTPS), senão a `.gz`, senão o original. Build antigo sem as versões comprimidas continua funcionando (original com cache imutável).
- **API e `index.html`**: sempre `no-store`. A recarga automática depois de uma atualização (cabeçalho `X-IClass-Build`) e o `index.html`, que aponta para os arquivos do build atual, dependem disso.
- **Respostas de texto da API** (JSON, `data.js`, apostilas `.md`, CSV) acima de 1 KB: gzip na hora, no pool de threads, quando o navegador aceita (`utils/httpCompression.js`). Fica de fora: HEAD, 204/304, `Cache-Control: no-transform`, resposta que já tem `Content-Encoding`, arquivos (`sendFile`), streams e ZIP. Enquanto o gzip roda, a resposta guarda o status e os cabeçalhos do envio: se a rota responde e depois lança, o que o `errorHandler` muda (tirar o `Content-Disposition`, pôr o 500) não alcança a resposta, que sai igual à de sem compressão.
- Sem pacote npm novo: só `zlib` do Node.

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

Cada arquivo encapsula uma responsabilidade testável: `backup.js`, `examApplications.js`, `examAttempts.js`, `examGrading.js`, `examToken.js`, `security.js`, `safePath.js`, `rateLimit.js`, `uploadSecurity.js`, `authSessions.js` (único módulo de sessão: cria, procura pelo hash do token, confere e revoga), `studentSessions.js`, `students.js`, `branding.js`, `buildIntegrity.js`, `parser.js`, entre outros. Novas regras de negócio devem nascer aqui, não dentro do handler da rota.

## 3. Persistência — o padrão `db.memory` + `db.save()`

O SQLite é usado como **key-value** (tabelas no formato `NOME (key TEXT PRIMARY KEY, value TEXT)`). O estado vive espelhado em memória em `db.memory` (um objeto com uma coleção por chave) e é serializado para o disco em `db.save()`.

```js
const db = require('../database.js');

db.memory.students.push(novoAluno);   // mutação em memória
await db.save();                       // persiste no SQLite
```

- `db.memory` é o objeto de estado (ver [MODELO_DADOS.md](./MODELO_DADOS.md)).
- `db.save()` (alias de `saveToDisk`) entra na fila do motor de gravação (`utils/dbWriter.js`): uma transação por vez, só com as linhas que mudaram, e resolve depois do `COMMIT`. Dentro de um pedido, a resposta espera as gravações dele (`utils/persistenceContext.js`); falha de gravação vira 503 `retryable`. Detalhes em [MODELO_DADOS.md](./MODELO_DADOS.md) e [PADROES_CODIGO.md](./PADROES_CODIGO.md).
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
├── lib/               # api.js (cliente único), requestTimeouts.js, clientErrors.js, lazyPage.js, cn.js, contentMarkdown.js, sessionActivity.js
├── hooks/             # useApi.js, usePolling.js, useAdminWorkspace.js
└── styles/
```

- **Telas sob demanda** (`lib/lazyPage.js`): o `App.jsx` carrega cada tela e cada layout (painel do instrutor, portal do aluno, prova) com `lazyPage(() => import(...))`; só o login fica no pacote inicial. Cada tela vira um arquivo do build e o celular do aluno não baixa o painel do instrutor. Os ícones (`lucide-react`) ficam num arquivo só (`manualChunks` em `vite.config.js`), sempre importados pelo nome (`StatCard` usa o mapa `STAT_CARD_ICONS`). Em volta de cada `<Outlet />` dos layouts há um `<Suspense fallback={<PageLoading />}>`, na ordem área de erro → Suspense → portões → `StudentCourseGate`/`AdminCourseGate` → `<Outlet />`: o "Carregando..." aparece dentro do layout, com o menu à vista. Quando o arquivo de uma tela não chega, a falha nunca fica guardada pelo `React.lazy` (que guardaria o erro para toda visita seguinte): no lugar da tela entra uma tela de espera (`RecoveringPage`) que, cada vez que abre, confere se o servidor entrega a página (HEAD no endereço atual, sem cache, com `X-IClass-Background: 1` e prazo de 10 s por conferência, para o prazo de 3 minutos valer também com o servidor travado). Fora do ar (Reiniciar, queda, build sendo refeito) ou sem rede, fica no "Carregando..." e confere de novo (1 s, 2 s, 3 s e depois a cada 5 s, por até 3 minutos), sem recarregar, porque a recarga cairia na página de erro do navegador; quando ele volta, busca o arquivo outra vez e a tela abre. Se o servidor responde e o arquivo continua faltando (atualização que apagou o build anterior, ou o Chrome, que guarda a falha do import na mesma página), a página recarrega uma vez (marca de 30 s no sessionStorage, sem laço). Quem sai da tela para a espera, sem recarga; ao voltar, a espera recomeça. Passado o prazo, ou com a recarga recente, aparece a tela de erro do app. A espera é curta e com fim, encadeada por `setTimeout`, e não uma consulta periódica (`usePolling`). O portal do aluno busca o arquivo da prova 2 s depois de abrir. Toda tela nova entra no `App.jsx` com `lazyPage`. O `npm run check:bundle` (`web/scripts/check-bundle-size.mjs`) falha com o JavaScript da primeira abertura acima de 130 KB em gzip, com um `.js` acima de 350 KB, com `import * as` de `lucide-react` ou com um arquivo de `web/dist/assets` cujo nome o servidor não entrega.
- **Cliente único de API** (`lib/api.js`): nenhuma tela usa `fetch` cru. Repository pattern — tudo passa por `api.get/post/put/delete`. Cada pedido tem prazo (fase 2, H2-C e H9c): 60 s para o instrutor (pedido com a sessão do painel e o login dele), nenhum para o aluno (a prova tem as próprias tentativas), 10 s para as consultas periódicas e o envio da digitação, 15 s para o salvamento automático da prova (constantes em `lib/requestTimeouts.js`); as operações longas do professor (backup, restauração, compactar, limpar estado de prova, resetar, clonar, apagar e restaurar curso) vão com `timeoutMs: 0`, e os caminhos delas também ficam sem prazo quando a tela não diz nada. Prazo estourado ou sem rede: erro com `status: 0`, `err.timeout` ou `err.network` e mensagem fixa em português ("O servidor do IClass demorou demais para responder..." e "Sem conexão com o servidor do IClass..."). `background: true` manda `X-IClass-Background: 1` (o servidor não conta como uso da sessão); `signal` é o cancelamento de quem chama. O pedido com `keepalive` (saída da página) nunca tem prazo.
- **Consultas periódicas** (`hooks/usePolling.js`): toda tela que pergunta ao servidor de tempos em tempos (sino de notificações, fórum, dúvidas, provas do aluno, espera da matrícula, respostas do aluno no painel, configurações públicas e revalidação da sessão no `AuthProvider`, presença do aluno a cada 15 s e o `pollMs` do `useApi`) usa o `usePolling`, e não `setInterval`: uma consulta por vez, a próxima agendada só depois da resposta, recuo na falha (o dobro a cada falha, até 15 s ou o próprio intervalo, com variação de 0,8 a 1,2), nada com a aba oculta e consulta na hora quando ela volta, `runNow()` para consultar depois de uma ação, `resetKey` para recomeçar quando muda o que a consulta pergunta (o sino consulta a turma nova na hora; fórum e dúvidas descartam a resposta atrasada do curso anterior), prazo de 10 s e `X-IClass-Background: 1`. Exceções: a sincronização da prova (4 s) e o envio da digitação (2 s, lotes de até 500 teclas) não pausam com a aba oculta e têm a própria guarda de uma por vez no `ExamRunner`; o envio da digitação pedido durante outro sai logo depois dele, mesmo com a prova já fora da tela (Sair, desmontagem: o resto sai na hora), e a falha de rede espera o recuo (2 s dobrando até 30 s, com variação) em vez de reenviar a cada tecla; as duas consultas do Monitor ficam para o H2-D. O teste `hooks/pollingSources.test.js` falha com um `setInterval` novo que não seja relógio da tela.
- **Erro de tela** (`components/ui/ErrorScreen.jsx`, fase 2, H9c): cada layout tem a área de erro (`AppErrorBoundary`) em volta do `<Outlet />`, dentro do `div` com `key={pathname}`: um erro numa página troca só a página pela tela de erro, com o menu à vista (texto próprio do painel e do portal, prop `description`), e trocar de página pelo menu volta ao normal. A raiz (`RouteErrorScreen`) continua pegando o erro fora dos layouts, e a prova continua com a `ExamErrorScreen`. A área de erro com `area` (`admin`, `aluno`, `prova`) e a raiz (`raiz`) mandam um aviso para `POST /api/client-error` (`lib/clientErrors.js`: mensagem sem endereços, caminho da página e versão do build; um envio por mensagem e no máximo cinco por carga da página), que vira a linha "erro de tela" no `crash.log` da pasta de dados. Cada campo do aviso vira uma linha só, e no `crash.log` só o cabeçalho de um bloco começa com "[" (linha de mensagem ou stack que comece assim é recuada): o texto mandado pelo navegador não forja um registro de outro usuário.
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
