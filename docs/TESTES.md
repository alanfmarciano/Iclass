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
npm run build          # gera web/dist (obrigatório antes do e2e/start)
npm run check          # test:backend + test:web + build + test:e2e (verificação completa)
```

### Execução modular

Os mesmos testes podem ser acionados sem IA pela opção **Central de Testes e Qualidade** do `ligarIclassV3.bat` ou diretamente pelo `VALIDAR_ICLASS.bat`.

```bash
npm run test:setup              # prepara dependências e Chromium (uma vez)
npm run test:quick              # backend + frontend, sem navegador
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

## Notas de ambiente

- Requer **Node 20.19+**. O `sqlite3` é binário nativo — em ambientes não-Windows a suíte pode acusar falhas de binário; a validação canônica é no Windows do projeto.
- `npm run build` precisa rodar antes do E2E porque o servidor recusa iniciar sem build íntegro (`utils/buildIntegrity.js`).

## Documentação viva

A estratégia, os casos de uso e a matriz que liga regra → tela → API → teste ficam em [`docs/qualidade/`](./qualidade/README.md). Apostilas e conteúdo pedagógico estão explicitamente adiados enquanto a nova arquitetura desse módulo é definida.
