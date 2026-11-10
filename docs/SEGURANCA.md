# Segurança — IClass V3

Regras de segurança do sistema e histórico de correções. Complementa [OPERACAO_SEGURANCA_TESTES.md](./OPERACAO_SEGURANCA_TESTES.md) (operação/backup/recuperação).

## Modelo de ameaça

Rede local de sala de aula: os "atacantes" plausíveis são alunos na mesma LAN tentando ver gabarito antecipado, sequestrar sessão de colega, acessar material não liberado ou escalar privilégio. Por isso o sistema é **server-authoritative**: o cliente nunca é confiável.

## Regras invioláveis

1. **Gabarito nunca vai ao cliente; questões só da tentativa iniciada.** O aluno recebe da configuração da prova apenas metadados (`studentExamConfigSummary` em `middlewares.js`). Enunciados e alternativas saem só por `utils/attemptQuestions.js` (sync e start-attempt), da versão sorteada para o aluno, depois que a tentativa começou de fato (aplicação em andamento, token validado, tentativa iniciada) e sem `correctAnswer`/`isCorrect`. A correção acontece só em `/api/student/submit`.
2. **Token de prova com hash.** Armazenado via `utils/examToken.js`, exibido ao professor apenas na preparação, validado no servidor e nunca ecoado ao cliente.
3. **Sessão de aluno = token único + trava por IP.** Impede sequestro de sessão na LAN (`validateStudentSession`). **Token de sessão só como hash no servidor:** o token (32 bytes aleatórios) vai só para o navegador; a memória guarda `sha256` (`sessions[email].tokenHash` e `adminSessions['h:' + sha256]`). Um único módulo cria, procura, confere e revoga sessão (`utils/authSessions.js`); fora dele ninguém lê `adminSessions[...]` nem compara o token cru (teste estático em `auth-sessions.test.js`). A chave ou o hash guardados não servem como token. Arquivo controlado (`/uploads`, `/imagens`, `?access=`), modo manutenção e as rotas de conteúdo de prova (`resolveRequester`) só aceitam sessão de instrutor dentro do prazo absoluto e de conta que existe, e sessão de aluno de conta ativa.
4. **Liberação decidida no servidor.** O aluno só acessa conteúdo/prova liberados para sua turma; o servidor decide, não o frontend.
5. **Senhas com scrypt.** `hashPasswordAsync`/`verifyPasswordAsync` em `database.js` nas rotas (o scrypt roda no pool de threads e não para o servidor; `hashPassword`/`verifyPassword` síncronos só no boot, nos scripts e no modo de teste); comparação com `timingSafeEqual`. Hash legado sha256 vira `scrypt-sha256$` no boot e na restauração de backup (H5a, SEG-X2), e texto puro vira `scrypt$` no boot; os dois são regravados em `scrypt$` no login, só se a senha guardada não mudou durante a conferência. Se a senha foi trocada (ou a conta apagada) enquanto o scrypt rodava, a digitada é conferida de novo contra o valor atual: a senha antiga nunca abre sessão depois de trocada. Toda senha é conferida pelo `attemptPasswordLogin` (`utils/passwordLogin.js`), inclusive a senha atual da troca de senha, que assim fica sob um teto por IP (429 `loginDelayed`; o mesmo do login para o instrutor e um próprio, do mesmo tamanho, para o aluno): uma sessão roubada não testa senhas sem limite. A senha do instrutor vai uma vez, no corpo do `POST /api/session/admin-login`; o cabeçalho `Authorization: email:senha` e o `password` no corpo das rotas do painel não autenticam mais (SEG-03).
6. **Painel do professor conforme o aparelho.** Sistema → Rede (`settings.network.adminAccess`, só o administrador muda, com auditoria): todos os aparelhos da rede (padrão; fora do computador do IClass a tela avisa que a senha passa sem proteção), só o computador do IClass, ou outros aparelhos só com conexão segura (disponível com o https, H6c). A regra vale para todo pedido de professor e usa o endereço da conexão, nunca um cabeçalho (`utils/networkPolicy.js`). A tela de login e o aviso do painel releem a regra (`GET /api/connection`) quando a tela volta a ficar visível e no "Verificar de novo": o aparelho liberado com a tela aberta entra sem recarregar.
7. **RBAC do admin.** Permissões sensíveis (ex.: `accounts.manage`) são exclusivas de administrador; professor não pode se auto-promover (defesa em camadas em `adminAccounts.js` + `adminPermissions.js`).
8. **Matrícula aprovada antes de qualquer dado de prova.** `/api/status`, `/api/student/sync`, `/data.js` e as rotas de proctoring conferem `studentBelongsToClass`; autocadastro pendente não vê nada de prova. As mensagens do professor (estado da prova, histórico, confirmação e exclusão) passam por `studentCanSeeBroadcastMessage` e chegam ao aluno sem a lista de quem já confirmou a leitura (`sanitizeBroadcastMessageForStudent`).
9. **Material por lista do que é permitido.** `/:key.md` e o `data.js` do aluno comparam a chave pedida (sem diferenciar maiúsculas, como o Windows) com as apostilas liberadas para a turma e abrem o arquivo pelo nome canônico (`utils/contentAccess.js`). `Avaliacao_*` e `Gabarito_*` nunca são servidos por essas rotas. Defesa extra na apostila servida ao aluno (`stripAnswerKeyBlocks`, em `utils/answerKey.js`): o texto é dividido em blocos numa varredura linear (cercas de código, `<pre>`, comentários, títulos, itens de lista, citações, blocos HTML e parágrafos) depois de uma pré-passagem que tira todos os comentários HTML fora de código (antes de procurar títulos e rótulos), e saem o `<details>` com "gabarito" + marca do professor (professor(a), prof., profs., profa., instrutor(a), docente, exclusivo(a)) ou "gabarito oficial" no `<summary>`, o título com "gabarito" + marca até o próximo título de nível igual ou menor, e o rótulo em negrito com "gabarito" + marca no começo de um bloco (sozinho ou com as respostas, sempre até o fim da seção). A função é idempotente. Código nunca é cortado, a remoção não atravessa o fechamento de um contêiner aberto antes dela e o custo é linear (2.000 títulos HTML sem fechamento em menos de 200 ms); regras e casos em `test/backend/answer-key-rules.test.js`. Regra para o professor: o gabarito dele fica sob o título `## Gabarito do professor` (ou num `<details>` com esse resumo); o rótulo em negrito protege até o fim da seção em que está. Rótulo em célula de tabela e negrito quebrado em duas linhas não são reconhecidos.

## Controles implementados

| Área | Controle | Onde |
|------|----------|------|
| Atraso no login e limites | atraso progressivo por conta da 5.ª senha errada seguida (30 s até 15 min, sem trava definitiva; "Liberar login" em Alunos e Contas), teto de 300 tentativas/min por IP só para proteger o servidor, alerta na fila com 50 senhas erradas em 10 min do mesmo IP; código da prova com 10 erros em 5 min por aluno (os certos não contam). Só na memória: reiniciar zera | `utils/loginGuard.js`, `utils/rateLimit.js`, `utils/passwordLogin.js` |
| Fim da sessão | "Sair" do aluno encerra a sessão no servidor (`/api/student/logout`); "Redefinir senha" encerra a do aluno (depois da prova, se ele estiver em uma); troca de senha do instrutor encerra as outras sessões dele; token do aluno só no cabeçalho, nunca na URL; o navegador guarda só o perfil do portal (sem responsável, telefones e acessibilidade) | `routes/student.js`, `middlewares.js`, `utils/studentProfile.js`, `web/src/lib/studentProfile.js` |
| CORS | Restrito a mesma origem e hosts locais/LAN (localhost, 10.x, 192.168.x, 172.16–31.x) | `server.js` |
| Path traversal | Resolução segura de caminho ao servir arquivos | `utils/safePath.js`, `sendControlledFile` |
| Upload | Validação de upload; aluno só acessa itens de biblioteca dentro de seus cursos | `utils/uploadSecurity.js`, `server.js` |
| CSV injection | `csvSafe()` neutraliza fórmulas (`= + - @`) e escapa delimitadores na exportação de notas | `routes/admin.js` |
| Troca de senha | Exige senha atual (fora da troca obrigatória da senha temporária do launcher); o aluno sempre informa a atual | `routes/adminAccounts.js`, `routes/student.js` |
| Política de senha | Toda senha nova digitada: 8 caracteres (aluno) ou 10 (instrutor), sem senha comum nem dado pessoal; senha temporária gerada pelo servidor | `utils/passwordPolicy.js` |
| Troca obrigatória | Senha criada ou redefinida pelo professor e senha fraca no login: 403 `passwordChangeRequired` até a troca, nunca no meio de uma prova (nem com a prova aberta na turma, para quem ainda não abriu a tentativa e dentro da janela da prova: uma aplicação esquecida aberta não adia a troca para sempre); o `TEST_MODE` ignora a regra | `utils/passwordChange.js`, `middlewares.js` |
| Seed/reset | Só sob `TEST_MODE=1` | `routes/testmode.js` |
| Integridade de build | Servidor recusa iniciar com build ausente/divergente | `utils/buildIntegrity.js` |

## Regras ao desenvolver

- Todo endpoint admin começa com `validateAdmin`/`validateAdminPermission`; todo endpoint de aluno com `validateStudentSession`. Ver [API.md](./API.md).
- Verifique o **escopo do professor** (`adminCanAccessCourse`, `adminCanAccessClass`) antes de operar sobre curso/turma.
- Nunca sirva arquivo por concatenação de path — use `safePath`.
- Nunca coloque senha em query string ou em resposta. A única exceção é a senha temporária gerada pelo servidor (`temporaryPassword`), devolvida uma vez ao professor que criou ou redefiniu a conta; ela nunca vai para a auditoria.
- Sanitize qualquer HTML derivado de Markdown (`marked` + `dompurify`).
- Ao exportar dados tabulares, passe pelos utilitários de escape.

## Histórico de correções

### 2026-11 — senhas das contas (fase 2, H5a)

- Política de senha única no servidor (`utils/passwordPolicy.js`): antes o cadastro, a criação pelo professor e o "Resetar senha" aceitavam a senha "1". (SEG-06)
- "Redefinir senha" gera uma senha temporária (ou aceita a do professor, pela política), pede a troca no próximo acesso e fica na auditoria (`student_password_reset`); a edição do aluno não troca mais a senha (antes gravava até um hash vindo do navegador). Contas de instrutor com `account_created`, `account_updated`, `account_deleted` e `account_password_changed`. (SEG-06)
- Troca obrigatória para senha criada ou redefinida pelo professor e para senha fraca no login (decisão P3), nunca no meio de uma prova; o aluno troca a senha em Minha conta (`/aluno/conta`). (UXA-13)
- Hashes SHA-256 antigos (inclusive de ex-alunos que não entram mais) viram `scrypt-sha256$` (scrypt do hash antigo) no boot e na restauração de backup, sem precisar da senha; no próximo login a conta passa para `scrypt$`. (SEG-X2)

### 2026-11 — senha do instrutor e painel por aparelho (fase 2, H2-B e H6b)

- Login do instrutor pelo `POST /api/session/admin-login`; fim do `Authorization: email:senha` e do `password` no corpo como credencial do painel. Sessão guardada no navegador só com e-mail e senha (formato antigo) cai no login. (SEG-03)
- Senhas conferidas e gravadas com o scrypt assíncrono: uma turma inteira entrando junto não para o servidor. (DES-07)
- Sistema → Rede: onde o painel do professor abre; aviso fixo de conexão sem proteção no painel aberto por http em outro aparelho. (SEG-03)

### 2026-10-16 — sigilo da prova (fase 1, G3)

- `/:key.md` exige sessão; aluno só lê apostila liberada para a sua turma; avaliações bloqueadas em qualquer grafia do nome (antes `/avaliacao_X.md` abria o gabarito no Windows). (SEG-01, SEG-18)
- `/data.js` do aluno exige curso e matrícula, traz só apostilas liberadas e nunca avaliações. (AVA-01, UXA-07)
- `/api/status`, `/api/student/sync`, `/api/student/exam-applications` não enviam mais `versionSnapshots` nem dados internos da aplicação ao aluno; as questões vêm só da tentativa iniciada e só quando o cliente ainda não as tem (`questionsVersion`). (AVA-02, DES-X1)
- Status, sync e proctoring exigem matrícula aprovada na turma. (SEG-02)
- `/api/courses` completo só para instrutor; sem sessão de instrutor devolve só id e nome dos cursos com cadastro aberto. (SEG-18)

### 2026-07-14 — passe de segurança

Correções aplicadas (backup pré-correção registrado em `data/backups/`):

**Críticos**
- Fechada porta dos fundos no seed (`/api/test/seed` só com `TEST_MODE=1`).
- Bloqueado escalonamento de privilégio via `accounts.manage` (exclusivo de admin; professor recusado nos handlers de contas).

**Altos**
- Corrigido IDOR de upload entre cursos (aluno só acessa itens de biblioteca dos seus cursos).
- Adicionado rate limiting em login e validação de token de prova.

**Médios**
- `flush-exam-state`: lógica OR → AND (não apaga dados de toda a turma) e correção de colisão de prefixo de e-mail.
- CSV/formula injection neutralizado na exportação de notas.
- CORS restrito a mesma origem e hosts locais.
- `change-password` passa a exigir senha atual.

**Baixos**
- Status HTTP inválido no recover (`444` → `404`).
- Removida aceitação de senha via query string no login admin legado.
- Textos com codificação quebrada ("nÃ£o" no lugar de "não") regravados em UTF-8 nas rotas (fase 1); um teste varre o repositório para não voltarem.

### Pendências conhecidas (não corrigidas — com motivo)

- ~~Endpoints GET pós-login sem sessão na área de material/leitura~~: corrigido em 2026-10-16 (ver acima).
- `localStorage` → cookie HttpOnly e modularização de `admin.js`: mudanças arquiteturais fora do escopo daquele passe.

> O registro detalhado original está arquivado em [`docs/arquivo/CORRECOES_SEGURANCA_2026-07-14.md`](./arquivo/CORRECOES_SEGURANCA_2026-07-14.md).

## Validação após mudanças de segurança

Rode `npm run check` (ver [TESTES.md](./TESTES.md)) e um smoke test manual: login admin e aluno; download de arquivo da biblioteca (IDOR); prova com token (rate limit não atrapalha); exportar CSV de notas; conta professor sem acesso a gestão de contas; troca de senha de primeiro acesso.
