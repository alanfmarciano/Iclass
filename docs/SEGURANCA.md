# Segurança — IClass V3

Regras de segurança do sistema e histórico de correções. Complementa [OPERACAO_SEGURANCA_TESTES.md](./OPERACAO_SEGURANCA_TESTES.md) (operação/backup/recuperação).

## Modelo de ameaça

Rede local de sala de aula: os "atacantes" plausíveis são alunos na mesma LAN tentando ver gabarito antecipado, sequestrar sessão de colega, acessar material não liberado ou escalar privilégio. Por isso o sistema é **server-authoritative**: o cliente nunca é confiável.

## Regras invioláveis

1. **Gabarito nunca vai ao cliente; questões só da tentativa iniciada.** O aluno recebe da configuração da prova apenas metadados (`studentExamConfigSummary` em `middlewares.js`). Enunciados e alternativas saem só por `utils/attemptQuestions.js` (sync e start-attempt), da versão sorteada para o aluno, depois que a tentativa começou de fato (aplicação em andamento, token validado, tentativa iniciada) e sem `correctAnswer`/`isCorrect`. A correção acontece só em `/api/student/submit`.
2. **Token de prova com hash.** Armazenado via `utils/examToken.js`, exibido ao professor apenas na preparação, validado no servidor e nunca ecoado ao cliente.
3. **Sessão de aluno = token único + trava por IP.** Impede sequestro de sessão na LAN (`validateStudentSession`).
4. **Liberação decidida no servidor.** O aluno só acessa conteúdo/prova liberados para sua turma; o servidor decide, não o frontend.
5. **Senhas com scrypt.** `hashPassword`/`verifyPassword` em `database.js`; comparação com `timingSafeEqual`. Hash legado sha256 é reidratado.
6. **RBAC do admin.** Permissões sensíveis (ex.: `accounts.manage`) são exclusivas de administrador; professor não pode se auto-promover (defesa em camadas em `adminAccounts.js` + `adminPermissions.js`).
7. **Matrícula aprovada antes de qualquer dado de prova.** `/api/status`, `/api/student/sync`, `/data.js` e as rotas de proctoring conferem `studentBelongsToClass`; autocadastro pendente não vê nada de prova.
8. **Material por lista do que é permitido.** `/:key.md` e o `data.js` do aluno comparam a chave pedida (sem diferenciar maiúsculas, como o Windows) com as apostilas liberadas para a turma e abrem o arquivo pelo nome canônico (`utils/contentAccess.js`). `Avaliacao_*` e `Gabarito_*` nunca são servidos por essas rotas.

## Controles implementados

| Área | Controle | Onde |
|------|----------|------|
| Rate limiting | 30 req/min por IP em login (aluno e admin legado) e validação de token | `utils/rateLimit.js` |
| CORS | Restrito a mesma origem e hosts locais/LAN (localhost, 10.x, 192.168.x, 172.16–31.x) | `server.js` |
| Path traversal | Resolução segura de caminho ao servir arquivos | `utils/safePath.js`, `sendControlledFile` |
| Upload | Validação de upload; aluno só acessa itens de biblioteca dentro de seus cursos | `utils/uploadSecurity.js`, `server.js` |
| CSV injection | `csvSafe()` neutraliza fórmulas (`= + - @`) e escapa delimitadores na exportação de notas | `routes/admin.js` |
| Troca de senha | Exige senha atual (fora da troca obrigatória inicial `mustChangePassword`) | `routes/adminAccounts.js` |
| Seed/reset | Só sob `TEST_MODE=1` | `routes/testmode.js` |
| Integridade de build | Servidor recusa iniciar com build ausente/divergente | `utils/buildIntegrity.js` |

## Regras ao desenvolver

- Todo endpoint admin começa com `validateAdmin`/`validateAdminPermission`; todo endpoint de aluno com `validateStudentSession`. Ver [API.md](./API.md).
- Verifique o **escopo do professor** (`adminCanAccessCourse`, `adminCanAccessClass`) antes de operar sobre curso/turma.
- Nunca sirva arquivo por concatenação de path — use `safePath`.
- Nunca coloque senha em query string ou em resposta.
- Sanitize qualquer HTML derivado de Markdown (`marked` + `dompurify`).
- Ao exportar dados tabulares, passe pelos utilitários de escape.

## Histórico de correções

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

### Pendências conhecidas (não corrigidas — com motivo)

- ~~Endpoints GET pós-login sem sessão na área de material/leitura~~: corrigido em 2026-10-16 (ver acima).
- Mojibake de encoding (`nÃ£o`, `AvaliaÃ§Ã£o`): exige passe deliberado de re-gravação em UTF-8.
- `localStorage` → cookie HttpOnly e modularização de `admin.js`: mudanças arquiteturais fora do escopo daquele passe.

> O registro detalhado original está arquivado em [`docs/arquivo/CORRECOES_SEGURANCA_2026-07-14.md`](./arquivo/CORRECOES_SEGURANCA_2026-07-14.md).

## Validação após mudanças de segurança

Rode `npm run check` (ver [TESTES.md](./TESTES.md)) e um smoke test manual: login admin e aluno; download de arquivo da biblioteca (IDOR); prova com token (rate limit não atrapalha); exportar CSV de notas; conta professor sem acesso a gestão de contas; troca de senha de primeiro acesso.
