# Operação, segurança, backup e testes

## Diretórios operacionais

Por padrão, o sistema mantém `data/`, `content/` e `cursos_arquivados/`. Testes e instalações isoladas podem definir `ICLASS_DATA_DIR`, `ICLASS_CONTENT_DIR` e `ICLASS_ARCHIVE_DIR`. Testes automatizados devem sempre usar diretórios temporários.

## Inicialização e build

Requer Node.js 20.19 ou superior. Execute `npm run build` antes de `npm start`. O build gera `web/dist/build-meta.json`; o servidor recusa iniciar se o build estiver ausente ou se o hash das fontes e dependências divergir.

## Testes

```powershell
npm run test:backend
npm run test:web
npm run test:e2e
npm run check
```

O backend usa `node:test` e Supertest, o frontend usa Vitest/Testing Library e os fluxos completos usam Playwright.

## Acessibilidade

O fluxo E2E de login executa `axe-core` na tela de autenticação e no portal do aluno com regras WCAG 2.2 nível AA. O teste falha quando encontra violações automatizáveis. O frontend também fornece foco visível global, redução de movimento, contraste calculado para cores de branding, modais com trap de foco e erros de formulário associados aos respectivos campos.

O teste automatizado não substitui a verificação manual de navegação por teclado, zoom de 200%, reflow em 320 px e leitores de tela nas demais páginas administrativas e estudantis.

## Segurança

- Senhas novas usam `scrypt` com salt individual. Hashes legados migram depois de login válido.
- A sessão define identidade, autor e proprietário; campos equivalentes enviados no body não concedem identidade.
- Provas mantêm versão, questões, início e prazo no servidor. O cliente envia somente respostas e contexto compatível.
- Uploads têm limite antes da gravação, bloqueio de formatos executáveis e validação de extensão, MIME e assinatura.
- Markdown é sanitizado com DOMPurify e protocolos executáveis são removidos.
- Toda rota `/api/admin` consta no catálogo RBAC; o teste de catálogo impede rotas novas sem decisão explícita.
- Professores recebem turmas por `{courseId, className}`. Nomes legados duplicados ficam sem acesso automático.

## Backup e restauração

Antes de cada fase ou operação sensível, faça snapshot completo externo com SHA-256. A restauração in-app cria backup completo de segurança, valida tipo, versão e schema, rejeita traversal, duplicidades e ZIP acima do limite descompactado, extrai em staging e invalida sessões.

A restauração só responde sucesso depois do `COMMIT` do SQLite. Em falha, arquivos e coleções anteriores são recolocados.

## Modo manutenção

O modo manutenção bloqueia login, APIs, fórum e conteúdos estudantis, inclusive para sessões já abertas. O painel administrativo permanece disponível.

## Configuração inicial pelo inicializador

A opção 5 do `ligarIclassV3.bat` inicia o servidor normal com os diretórios reais e mostra os botões de acesso rápido para Administrador, Professor e Aluno. Ela não define `TEST_MODE`, não cria fixtures e não altera senhas. Cada botão abre exclusivamente a conta oficial correspondente: `admin@teste.local`, `professor@teste.local` ou `aluno@teste.local`; nunca escolhe outro usuário pela posição na lista. O inicializador gera uma autorização aleatória e abre uma janela normal e outra privada/anônima com o mesmo fragmento temporário, permitindo testar dois perfis simultaneamente com armazenamentos isolados. O frontend remove o fragmento imediatamente. Durante uma hora, o token funciona somente quando a conexão vem de loopback (`127.0.0.1` ou `::1`). Outros dispositivos da rede continuam exigindo autenticação normal.

Quando ainda não existe administrador, o bootstrap cria `admin@local`, grava uma senha aleatória em `data/bootstrap-admin.txt` e exige a definição de uma nova senha. Se uma conta oficial de teste estiver ausente ou incompatível com o perfil do botão, a tela informa o problema em vez de entrar em outra conta. O modo local não exibe um banner persistente depois da entrada.

O `TEST_MODE` com acessos sem senha permanece exclusivo do Playwright, que define banco, conteúdo e arquivo em diretórios temporários.
