# Segurança — IClass V3

Regras de segurança do sistema e histórico de correções. Complementa [OPERACAO_SEGURANCA_TESTES.md](./OPERACAO_SEGURANCA_TESTES.md) (operação/backup/recuperação).

## Modelo de ameaça

Rede local de sala de aula: os "atacantes" plausíveis são alunos na mesma LAN tentando ver gabarito antecipado, sequestrar sessão de colega, acessar material não liberado ou escalar privilégio. Por isso o sistema é **server-authoritative**: o cliente nunca é confiável.

## Regras invioláveis

1. **Gabarito nunca vai ao cliente; questões só da tentativa iniciada.** O aluno recebe da configuração da prova apenas metadados (`studentExamConfigSummary` em `middlewares.js`). Enunciados e alternativas saem só por `utils/attemptQuestions.js` (sync e start-attempt), da versão sorteada para o aluno, depois que a tentativa começou de fato (aplicação em andamento, token validado, tentativa iniciada) e sem `correctAnswer`/`isCorrect`. A correção acontece só em `/api/student/submit`.
2. **Token de prova com hash.** Armazenado via `utils/examToken.js`, exibido ao professor apenas na preparação, validado no servidor e nunca ecoado ao cliente.
3. **Sessão de aluno = token único + trava por IP.** Impede sequestro de sessão na LAN (`validateStudentSession`). **Token de sessão só como hash no servidor:** o token (32 bytes aleatórios) vai só para o navegador; a memória guarda `sha256` (`sessions[email].tokenHash` e `adminSessions['h:' + sha256]`). Um único módulo cria, procura, confere e revoga sessão (`utils/authSessions.js`); fora dele ninguém lê `adminSessions[...]` nem compara o token cru (teste estático em `auth-sessions.test.js`). A chave ou o hash guardados não servem como token. **Sessões no disco (H3a-2):** a tabela `auth_sessions` guarda só o sha256 do token, o e-mail, o tipo, o início, o IP do aluno e a origem, nunca o token cru nem a presença; um reinício rápido (até 60 min fora do ar, pelo heartbeat) não desconecta ninguém, e a sessão continua presa ao prazo absoluto de 8 h contado do login. Mais de 60 min fora do ar ou sem heartbeat: ninguém volta. A sessão do acesso rápido local (`origin: 'setup'`) só volta com o modo setup ligado. Sair, `/api/student/leave`, a exclusão do aluno, o Resetar sala, a exclusão de conta de instrutor, a exclusão definitiva de curso (alunos que vão para o arquivo) e a sessão derrubada por um 401/403 (vencida, conta apagada ou bloqueada) tiram a sessão da tabela antes da resposta; restaurar backup esvazia a tabela. A retomada só traz de volta sessão de conta que ainda pode entrar (aluno cadastrado e ativo, instrutor cadastrado): a de aluno bloqueado ou de conta apagada não volta, e o token antigo não entra depois do desbloqueio nem numa conta recriada com o mesmo e-mail. Redefinir a senha pelo launcher (`reset-admin-password.js`, com o servidor parado) encerra as sessões daquela conta também na tabela: a sessão de quem motivou a redefinição não volta no boot seguinte (antes ela voltava e, com a troca obrigatória, trocava a senha sem conhecer a temporária); as das outras contas ficam. Fora de `authSessions.js`, nenhum código lê ou grava `db.memory.sessions` e `adminSessions` (teste estático em `auth-sessions.test.js`). Arquivo controlado (`/uploads`, `/imagens`, `?access=`), modo manutenção e as rotas de conteúdo de prova (`resolveRequester`) só aceitam sessão de instrutor dentro do prazo absoluto e de conta que existe, e sessão de aluno de conta ativa.
4. **Liberação decidida no servidor.** O aluno só acessa conteúdo/prova liberados para sua turma; o servidor decide, não o frontend.
5. **Senhas com scrypt.** `hashPasswordAsync`/`verifyPasswordAsync` em `database.js` nas rotas (o scrypt roda no pool de threads e não para o servidor; `hashPassword`/`verifyPassword` síncronos só no boot, nos scripts e no modo de teste); comparação com `timingSafeEqual`. Hash legado sha256 vira `scrypt-sha256$` no boot e na restauração de backup (H5a, SEG-X2), e texto puro vira `scrypt$` no boot; os dois são regravados em `scrypt$` no login, só se a senha guardada não mudou durante a conferência. Se a senha foi trocada (ou a conta apagada) enquanto o scrypt rodava, a digitada é conferida de novo contra o valor atual: a senha antiga nunca abre sessão depois de trocada. Toda senha é conferida pelo `attemptPasswordLogin` (`utils/passwordLogin.js`), inclusive a senha atual da troca de senha, que assim fica sob um teto por IP (429 `loginDelayed`; o mesmo do login para o instrutor e um próprio, do mesmo tamanho, para o aluno): uma sessão roubada não testa senhas sem limite. A senha do instrutor vai uma vez, no corpo do `POST /api/session/admin-login`; o cabeçalho `Authorization: email:senha` e o `password` no corpo das rotas do painel não autenticam mais (SEG-03).
6. **Painel do professor conforme o aparelho.** Sistema → Rede (`settings.network.adminAccess`, só o administrador muda, com auditoria): todos os aparelhos da rede (padrão; fora do computador do IClass a tela avisa que a senha passa sem proteção), só o computador do IClass, ou outros aparelhos só com conexão segura (https, H6c: por http a página do painel vai para o https e a API recusa com 403 `https-required`; só pode ser escolhida com o https funcionando). A regra vale para todo pedido de professor e usa o endereço da conexão, nunca um cabeçalho (`utils/networkPolicy.js`). A tela de login e o aviso do painel releem a regra (`GET /api/connection`) quando a tela volta a ficar visível e no "Verificar de novo": o aparelho liberado com a tela aberta entra sem recarregar.
6a. **Conexão segura (https, H6c).** http e https na mesma porta (`utils/dualListener.js`, pelo primeiro byte). CA própria por instalação (`utils/tlsCertificates.js`): ECDSA P-256, 10 anos, com *name constraints* (só `.local`, `localhost` e as faixas privadas 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16): mesmo que a chave vaze, ela não serve para nenhum site da internet. Certificado do servidor de 397 dias com os IPs da rede no SAN, refeito e trocado a quente quando o IP muda ou faltam 30 dias. Chaves em `DATA_DIR/tls` com 0600 (no Windows, a permissão da pasta de dados), gravação atômica, nunca no backup nem na resposta de nenhuma rota; arquivo danificado é guardado como `.invalido-<data>` e a CA recriada é avisada na tela (os aparelhos precisam instalar de novo). O aparelho baixa o certificado por http (`/iclass-ca.crt`) antes de existir confiança: o guia `/certificado` mostra a impressão digital SHA-256 para conferir com a de Sistema → Rede no computador do IClass. Sem conseguir gravar a pasta, o IClass sobe só em http e diz o motivo. `settings.network.studentsHttps` (padrão desligado) leva os alunos para o https; o "Host" do pedido só vira link quando é `localhost` ou um IP desta máquina que está no certificado. Endereço seguro só com IP do certificado: numa rede da escola fora das faixas locais, o https vale só no próprio computador e Sistema → Rede diz por quê (sem "funcionando", sem liberar 'rede' nem os alunos). O motivo de "indisponível" não leva o caminho da pasta de dados nem a mensagem do sistema, e as rotas públicas dizem só "indisponível". O aviso de CA recriada fica 30 dias na tela e sai também no console.
7. **RBAC do admin.** Permissões sensíveis (ex.: `accounts.manage`) são exclusivas de administrador; professor não pode se auto-promover (defesa em camadas em `adminAccounts.js` + `adminPermissions.js`).
8. **Matrícula aprovada antes de qualquer dado de prova.** `/api/status`, `/api/student/sync`, `/data.js` e as rotas de proctoring conferem `studentBelongsToClass`; autocadastro pendente não vê nada de prova. As mensagens do professor (estado da prova, histórico, confirmação e exclusão) passam por `studentCanSeeBroadcastMessage` e chegam ao aluno sem a lista de quem já confirmou a leitura (`sanitizeBroadcastMessageForStudent`).
9. **Material por lista do que é permitido.** `/:key.md` e o `data.js` do aluno comparam a chave pedida (sem diferenciar maiúsculas, como o Windows) com as apostilas liberadas para a turma e abrem o arquivo pelo nome canônico (`utils/contentAccess.js`). `Avaliacao_*` e `Gabarito_*` nunca são servidos por essas rotas. Defesa extra na apostila servida ao aluno (`stripAnswerKeyBlocks`, em `utils/answerKey.js`): o texto é dividido em blocos numa varredura linear (cercas de código, `<pre>`, comentários, títulos, itens de lista, citações, blocos HTML e parágrafos) depois de uma pré-passagem que tira todos os comentários HTML fora de código (antes de procurar títulos e rótulos), e saem o `<details>` com "gabarito" + marca do professor (professor(a), prof., profs., profa., instrutor(a), docente, exclusivo(a)) ou "gabarito oficial" no `<summary>`, o título com "gabarito" + marca até o próximo título de nível igual ou menor, e o rótulo em negrito com "gabarito" + marca no começo de um bloco (sozinho ou com as respostas, sempre até o fim da seção). A função é idempotente. Código nunca é cortado, a remoção não atravessa o fechamento de um contêiner aberto antes dela e o custo é linear (2.000 títulos HTML sem fechamento em menos de 200 ms); regras e casos em `test/backend/answer-key-rules.test.js`. Regra para o professor: o gabarito dele fica sob o título `## Gabarito do professor` (ou num `<details>` com esse resumo); o rótulo em negrito protege até o fim da seção em que está. Rótulo em célula de tabela e negrito quebrado em duas linhas não são reconhecidos.

## Controles implementados

| Área | Controle | Onde |
|------|----------|------|
| Atraso no login e limites | atraso progressivo por conta da 5.ª senha errada seguida (30 s até 15 min, sem trava definitiva; "Liberar login" em Alunos e Contas), teto de 300 tentativas/min por IP só para proteger o servidor, alerta na fila com 50 senhas erradas em 10 min do mesmo IP; código da prova com 10 erros em 5 min por aluno (os certos não contam). Só na memória: reiniciar zera | `utils/loginGuard.js`, `utils/rateLimit.js`, `utils/passwordLogin.js` |
| Fim da sessão | "Sair" do aluno encerra a sessão no servidor (`/api/student/logout`); "Redefinir senha" encerra a do aluno (depois da prova, se ele estiver em uma; até lá o token antigo vale só nas rotas da prova); troca de senha do instrutor encerra as outras sessões dele; o pedido seguinte do token encerrado recebe 401 com o motivo (`logout`, `password_reset`, `password_changed`) e o login mostra o texto do servidor; tentativa aberta numa aplicação esquecida não segura a sessão antiga além da janela da prova; token do aluno só no cabeçalho, nunca na URL; o navegador guarda só o perfil do portal (sem matrícula, responsável, telefones e acessibilidade; Minha conta lê a matrícula na hora) | `routes/student.js`, `middlewares.js`, `utils/studentProfile.js`, `web/src/lib/studentProfile.js` |
| CORS | Restrito a mesma origem e hosts locais/LAN (localhost, 10.x, 192.168.x, 172.16–31.x) | `server.js` |
| Path traversal | Resolução segura de caminho ao servir arquivos | `utils/safePath.js`, `sendControlledFile` |
| Upload | Validação de upload; aluno só acessa itens de biblioteca dentro de seus cursos | `utils/uploadSecurity.js`, `server.js` |
| CSV injection | `csvSafe()` neutraliza fórmulas (`= + - @`) e escapa delimitadores na exportação de notas | `routes/admin.js` |
| Troca de senha | Exige senha atual (fora da troca obrigatória da senha temporária do launcher); o aluno sempre informa a atual | `routes/adminAccounts.js`, `routes/student.js` |
| Política de senha | Toda senha nova digitada: 8 caracteres (aluno) ou 10 (instrutor), sem senha comum nem dado pessoal; senha temporária gerada pelo servidor | `utils/passwordPolicy.js` |
| Troca obrigatória | Senha criada ou redefinida pelo professor e senha fraca no login: 403 `passwordChangeRequired` até a troca, nunca no meio de uma prova (nem com a prova aberta na turma, para quem ainda não abriu a tentativa e dentro da janela da prova: uma aplicação esquecida aberta não adia a troca para sempre); o `TEST_MODE` ignora a regra | `utils/passwordChange.js`, `middlewares.js` |
| Cabeçalhos de segurança | Toda resposta (páginas, API, `/assets` e a tela "iniciando" do boot) sai com CSP (`script-src 'self'`, sem script inline nem `eval`; `style-src` com `'unsafe-inline'` para os atributos `style` e o `<style>` das impressões; imagens e vídeos de fora por `http:`/`https:`; `frame-src` só o próprio IClass, YouTube e Vimeo; `frame-ancestors 'self'`; `object-src 'none'`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN` (a prévia de PDF da biblioteca é um iframe do próprio IClass) e `Referrer-Policy: strict-origin-when-cross-origin` (o caminho e o `?access=` não saem para sites de fora), sem `X-Powered-By`. Arquivos de `/uploads` e `/imagens` trocam a CSP por uma sandbox própria (`default-src 'none'; sandbox`). Sem HSTS em nenhuma conexão, nem na https (H6c): os alunos e o computador do IClass continuam usando http no mesmo endereço, e um HSTS gravado no navegador trancaria esse acesso | `utils/securityHeaders.js`, `server.js` |
| Dependências | `npm run test:audit` (também no `npm run check`): `npm audit --omit=dev --audit-level=high` no servidor e em `web/`; reprova só com alta ou crítica; sem rede avisa e passa. Dependabot semanal para `/` e `/web` | `test/audit-deps.js`, `.github/dependabot.yml` |
| Seed/reset | Só sob `TEST_MODE=1` | `routes/testmode.js` |
| Integridade de build | Servidor recusa iniciar com build ausente/divergente | `utils/buildIntegrity.js` |

## Regras ao desenvolver

- Todo endpoint admin começa com `validateAdmin`/`validateAdminPermission`; todo endpoint de aluno com `validateStudentSession`. Ver [API.md](./API.md).
- Verifique o **escopo do professor** (`adminCanAccessCourse`, `adminCanAccessClass`) antes de operar sobre curso/turma.
- Nunca sirva arquivo por concatenação de path — use `safePath`.
- Nunca coloque senha em query string ou em resposta. A única exceção é a senha temporária gerada pelo servidor (`temporaryPassword`), devolvida uma vez ao professor que criou ou redefiniu a conta; ela nunca vai para a auditoria.
- Sanitize qualquer HTML derivado de Markdown (`marked` + `dompurify`).
- Nada de `<script>` inline, `onclick=`/`onload=` em HTML gerado nem `eval`: a CSP bloqueia. Janela de impressão (`window.open('')`) recebe só HTML e CSS; quem chama `win.print()` é a janela de origem (ex.: `openExamPrintWindow` em `ProvasPage.jsx`, `openPrintWindow` em `examTools.js`).
- Embed novo de outro site (outro player de vídeo, por exemplo) precisa entrar no `frame-src` de `utils/securityHeaders.js`, com o teste `security-headers.test.js`.
- Ao exportar dados tabulares, passe pelos utilitários de escape.

## Histórico de correções

### 2026-11-11 — cabeçalhos e dependências (fase 2, H5d)

- CSP, `nosniff`, `X-Frame-Options: SAMEORIGIN` e `Referrer-Policy` em toda resposta, sem `X-Powered-By: Express`; arquivos enviados mantêm a sandbox própria. Antes páginas e API saíam sem nenhum desses cabeçalhos. (SEG-16)
- A impressão da prova do aluno não leva mais `<script>` dentro da janela (seria bloqueado pela CSP): a página chama `print()` de fora, como as impressões do professor. A prévia da biblioteca embute só PDF enviado ao IClass; PDF de outro site abre em nova aba. (SEG-16)
- Pacotes atualizados dentro da mesma versão maior (só o `adm-zip` passa de 0.5 para 0.6): `adm-zip` 0.6.1, `multer` 2.5.0, `proxy-addr`, `qs`, `tar`, `undici`, `brace-expansion`, `dompurify` 3.4.17 e `react-router-dom` 6.30.6. O `npm audit` de produção fica sem alta e crítica; sobram moderadas que só fecham com versão maior (`archiver` 8, `react-router` 7). (SEG-17, ENG-07)
- `npm run test:audit` no `npm run check` e Dependabot semanal. (SEG-17, ENG-07)
### 2026-11-11 — primeiro acesso do aluno (fase 2, H8a-2)

- O aceite dos Termos e da Política passa a guardar o id exato do documento aceito (com a escola, a data, o IP e o aparelho), no autocadastro e no portal, e só é pedido depois que o administrador publica o texto. Cada publicação nova pede um aceite novo, e o anterior fica no histórico; cada aceite vai para a auditoria (`privacy_accept`). (SEG-08, OPS-12)
- Data de nascimento no cadastro e, para menor de 18 anos, nome e contato do responsável, pedidos a todos no próximo acesso sem bloquear o login (política "ciência", decisão P4). A rota da prova não passa pelo portão, e a faixa "Prova disponível" aparece por cima dele, também para o aluno em mais de uma turma que ainda não escolheu a turma. (SEG-09)
- Anonimizar o aluno tira o IP e o aparelho das entradas de auditoria que ele mesmo gravou (aceite, data de nascimento, responsável). (SEG-09)

### 2026-11-10 — Termos e Privacidade (fase 2, H8a-1)

- O aluno passa a poder ler o que aceita: `/termos` e `/privacidade` são públicas, com o texto atual e os dados da escola, inclusive o encarregado (DPO). Sem publicação, mostram o modelo do IClass como não revisado, e ninguém precisa aceitar nada. (SEG-08, OPS-12)
- Só o administrador revisa e publica (`students.security`); a versão publicada não muda mais e cada publicação vai para a auditoria (`legal_publish`). O encarregado só muda pela página Privacidade (LGPD), com `dpo_changed`. O texto passa pelo DOMPurify no navegador, e os dados da escola entram nele como texto literal (toda pontuação escapada, sem formatação nem link), com exceção do e-mail e do site da escola e do e-mail do encarregado, que viram link com o endereço exato. (SEG-08, OPS-12)

### 2026-11-10 — escopo do professor (fase 2, H5c)

- O professor só vê e só apaga as mensagens do Monitor das turmas dele; apagar do histórico exige a mensagem ou a turma de todos, inclusive do administrador (antes o corpo vazio apagava as mensagens de todas as turmas). (SEG-11)
- Fórum: o painel do professor filtra dúvida por dúvida pela turma (gravada ou inferida pelo aluno); a dúvida antiga sem turma fica só com o administrador. O aluno precisa informar curso e turma para listar as dúvidas. (SEG-11)
- Cursos: criar, alterar e excluir passam por `/api/admin/courses`, com a guarda do painel e o escopo pelo id do caminho; só os campos permitidos são gravados, a escola só o administrador muda, e tudo vai para a auditoria. Duplicar confere a origem, a escola de destino (o professor só duplica para uma escola atribuída a ele) e o código novo (antes `../` no código gravava fora da pasta de conteúdo). As rotas antigas de `/api/courses` respondem 410. (SEG-12)
- Guarda estática da assinatura dos callbacks de `validateAdmin`/`validateAdminPermission`, para o SEG-05 não voltar numa rota nova. (SEG-05)

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
- Token de sessão em `localStorage` e `?access=` nos links de arquivo (SEG-16): continuam nesta fase; o cookie HttpOnly com anti-CSRF e o link assinado de vida curta ficam para depois do HTTPS (H6c). A CSP e o `Referrer-Policy` reduzem o risco até lá.
- Moderadas do `npm audit` de produção que pedem versão maior (`archiver` 7 → 8 no backup completo; `react-router` 6 → 7 na interface) e as do ambiente de desenvolvimento (`vitest`): atualização própria, com teste das telas e do backup.

> O registro detalhado original está arquivado em [`docs/arquivo/CORRECOES_SEGURANCA_2026-07-14.md`](./arquivo/CORRECOES_SEGURANCA_2026-07-14.md).

## Validação após mudanças de segurança

Rode `npm run check` (ver [TESTES.md](./TESTES.md)) e um smoke test manual: login admin e aluno; download de arquivo da biblioteca (IDOR); prova com token (rate limit não atrapalha); exportar CSV de notas; conta professor sem acesso a gestão de contas; troca de senha de primeiro acesso.
