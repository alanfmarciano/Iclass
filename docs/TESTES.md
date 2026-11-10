# Estratégia de Testes — IClass V3

Como o projeto é testado e o que se espera ao contribuir. Fonte: `package.json`, `test/`, arquivos `*.test.js`/`*.test.jsx`.

## Camadas de teste

| Camada | Ferramenta | Local | Cobre |
|--------|-----------|-------|-------|
| Backend | `node:test` + Supertest | `test/backend/*.test.js` | regras de negócio, rotas, segurança, persistência |
| Frontend (unidade) | Vitest + Testing Library | `web/src/**/*.test.jsx` (e `.test.js`) | componentes, utils, hooks |
| E2E | Playwright | `test/e2e/*.spec.js` | fluxos ponta a ponta (login, provas, gestão de curso) |

## Comandos

```bash
npm run test:backend   # node --test test/backend/*.test.js
npm run test:web       # vitest run (dentro de web/)
npm run test:e2e       # playwright test
npm run build          # gera web/dist com as versões .gz/.br (obrigatório antes do e2e/start)
npm run check:bundle   # orçamento do pacote da interface (não roda no build)
npm run check          # test:docs + test:backend + test:web + build + check:bundle + test:e2e (verificação completa)
```

O `check:bundle` (`web/scripts/check-bundle-size.mjs`) falha com o JavaScript da primeira abertura (script de entrada mais os `modulepreload` do `index.html`) acima de 130 KB em gzip, com qualquer `.js` do build acima de 350 KB, com `import * as` de `lucide-react` em `web/src` ou com um arquivo de `web/dist/assets` cujo nome o servidor não entrega em `/assets` (a mesma regra de `backend/utils/staticAssets.js`). Sem `web/dist`, confere só o código-fonte e avisa "Sem build da interface: orçamento não conferido.". Ele fica de fora do `npm run build` de propósito: o orçamento é para quem desenvolve e nunca impede compilar e ligar o sistema.

### Execução modular

Os mesmos testes podem ser acionados sem IA pela opção **Central de Testes e Qualidade** do `ligarIclassV3.bat` ou diretamente pelo `VALIDAR_ICLASS.bat`.

```bash
npm run test:setup              # prepara dependências e Chromium (uma vez)
npm run test:quick              # documentação, backend, frontend e orçamento do pacote, sem navegador
npm run test:module -- provas   # somente provas
npm run test:module -- admins   # administradores e permissões
npm run test:module -- alunos   # alunos, sessões e matrículas
npm run test:module -- cursos   # cursos e turmas
npm run test:attendance         # disciplinas, grade, chamada e frequência
npm run test:visual             # Premium/Lumen e responsividade
npm run test:security           # segurança e RBAC
npm run test:full               # validação completa
```

Cada execução grava `test-results/ultimo-relatorio.html` e `test-results/resumo.json`. Ausência do Chromium é classificada como ambiente bloqueado, não como falha do produto.

`npm run check` é a barreira antes de considerar qualquer tarefa "pronta".

## Convenções

- **Backend** usa diretórios temporários via `ICLASS_DATA_DIR` / `ICLASS_CONTENT_DIR` / `ICLASS_ARCHIVE_DIR`. Nunca teste contra `data/` real.
- **Isolamento**: cada teste monta seu próprio estado; não dependa de ordem de execução nem de dados de outro teste.
- **Nomeação**: backend `assunto.test.js` em `test/backend/`; frontend `Componente.test.jsx` ao lado do componente; E2E `fluxo.spec.js` em `test/e2e/`.
- **E2E** sobe servidor local isolado (ver `test/e2e/start-test-server.js`) em `TEST_MODE`, usando o seed controlado.

## O que testar ao contribuir

- **Regra de negócio nova** → teste de backend cobrindo caminho feliz e borda (ex.: limite atingido, dado ausente, sem permissão).
- **Correção de segurança** → teste que reproduz a falha e prova que foi fechada (ver exemplos em `upload-security.test.js`, `safe-path.test.js`).
- **Componente/hook novo** → teste de render + interação principal.
- **Fluxo sensível** (provas, login, matrícula) → cobertura E2E; é o fluxo mais crítico do produto.

## Testes existentes (referência)

Backend: `admin-rbac-catalog`, `branding-interface-preset`, `class-content`, `database-persistence`, `exam-applications`, `exam-attempts`, `launcher-safety`, `safe-path`, `student-analytics`, `student-sessions`, `upload-security`.

Frontend: `Modal.test.jsx`, `AdminCourseGate.test.jsx`, `FinishApplicationModal.test.jsx`, `StudentExamAvailability.test.jsx`, `monitorTimer.test.js`, `contentMarkdown.test.js`, `sessionActivity.test.js`.

E2E: `course-management.spec.js`, `exam-flow.spec.js`, `student-login.spec.js`.

Entrega do app (fase 2, H2-A, `[UC-DESEMPENHO-001]`): `static-assets.test.js` (cache imutável e `.gz`/`.br` em `/assets`, nomes começando com `_` ou `-`, 404 sem `index.html`, 500 do contrato com o código do erro numa falha de disco, no-store na API e no `index.html`, rota com o próprio Cache-Control), `http-compression.test.js` (gzip das respostas de texto, composição com o redator de privacidade e com a resposta que espera o COMMIT, download que responde e depois lança), `bundle-budget.test.js` (pré-compressão do build e `check:bundle`, também chamados por um caminho com link simbólico, e nomes do build que o servidor entrega), `StatCard.test.jsx` (ícones nomeados), `lazyPage.test.jsx` (telas sob demanda, recarga depois de uma atualização, nenhuma recarga com o servidor fora do ar ou sem rede, tela deixada durante a queda que se recupera na volta em vez de mostrar a tela de erro, e a ordem dos invólucros em volta do Outlet nos layouts), `AuthProvider.test.jsx` (a sessão do instrutor fica gravada no navegador no instante do login, sem esperar o arquivo do painel) e os testes de layout (`AppShell.test.jsx`, `StudentShell.test.jsx`, `StudentExamShell.test.jsx`) com o "Carregando..." dentro do layout.

Consultas periódicas e prazos (fase 2, H2-C, `[UC-DESEMPENHO-002]`): `usePolling.test.js` (uma consulta por vez com o servidor lento, a próxima só depois da resposta, recuo na falha até o teto, pausa com a aba oculta e consulta na volta, `runNow` com uma só na fila, `resetKey` que recomeça a consulta, desligar e desmontar), `NotificationBell.test.jsx` (trocar de turma consulta o sino novo na hora, sem mostrar nem marcar a contagem da anterior), `StudentCourseGate.test.jsx` (uma consulta só quando a espera da matrícula começa), `DuvidasPage.test.jsx` e `ForumPage.test.jsx` (resposta atrasada do curso anterior descartada), `useApi.test.js` (o `pollMs` atualiza a tela com o servidor mais lento que o intervalo), `useStudentHeartbeat.test.jsx` (presença a cada 15 s, sem ping com a aba oculta), `pollingSources.test.js` (nenhum `setInterval` de consulta fora das exceções conhecidas: relógios, sincronização e digitação da prova e, até o H2-D, as duas consultas do Monitor) e o bloco do `ExamRunner.test.jsx` (digitação em lotes de até 500, um envio por vez, falha de rede de volta ao buffer com recuo em vez de um envio por tecla, 413 descartado, Sair da prova e desmontagem com um envio em andamento sem perder tecla, keepalive dentro do limite do navegador e de volta ao buffer se falhar, e uma sincronização por vez).

Erro de tela e cliente que não gira para sempre (fase 2, H9c, `[UC-ERRO-002]`): `client-error.test.js` (`POST /api/client-error`: 401 sem sessão, 204 com a linha "erro de tela" no `crash.log`, campos conferidos com 400 e o campo, 429 no 11º aviso do minuto, que não conta os recusados, e quebra de linha ou caractere de controle sem forjar bloco no `crash.log`; o bloco do `crash.log` em `entrada-e-erros.test.js` confere o mesmo para qualquer erro), `clientErrors.test.js` (um aviso por mensagem, no máximo cinco por carga da página, sem endereços), `api.test.js` (prazos de 60 s, 10 s e sem prazo, operações longas, mensagens de rede e de prazo em português, `X-IClass-Background`), `AppShell.test.jsx` e `StudentShell.test.jsx` (erro numa página com o menu à vista, o texto do layout e a volta pelo menu), `appRoutes.test.jsx` (a raiz também avisa) e `lazyPage.test.jsx` (conferência do servidor com prazo: o limite de 3 minutos vale com o servidor travado).

## Notas de ambiente

- Requer **Node 20.19+**. O `sqlite3` é binário nativo — em ambientes não-Windows a suíte pode acusar falhas de binário; a validação canônica é no Windows do projeto.
- `npm run build` precisa rodar antes do E2E porque o servidor recusa iniciar sem build íntegro (`utils/buildIntegrity.js`).

## Documentação viva

A estratégia, os casos de uso e a matriz que liga regra → tela → API → teste ficam em [`docs/qualidade/`](./qualidade/README.md). Apostilas e conteúdo pedagógico estão explicitamente adiados enquanto a nova arquitetura desse módulo é definida.
