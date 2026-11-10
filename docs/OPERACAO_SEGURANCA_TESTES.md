# Operação, segurança, backup e testes

## Diretórios operacionais

Por padrão, o sistema mantém `data/`, `content/` e `cursos_arquivados/`. Testes e instalações isoladas podem definir `ICLASS_DATA_DIR`, `ICLASS_CONTENT_DIR` e `ICLASS_ARCHIVE_DIR`. Testes automatizados devem sempre usar diretórios temporários.

## Inicialização e build

Requer Node.js 20.19 ou superior. Execute `npm run build` antes de `npm start`. O build gera `web/dist/build-meta.json`; o servidor recusa iniciar se o build estiver ausente ou se o hash das fontes e dependências divergir.

### Supervisor, saúde do servidor e logs (fase 2, H3c)

- **Abrir com reinício automático**: `npm run start:supervised` (`node backend/supervisor.js`). Se o servidor cair (erro fatal, kill), o supervisor sobe outro em segundos (espera de 1, 2, 5, 10 e 30 s) e as sessões e o tempo das provas continuam. `npm start` (`node backend/server.js`) continua funcionando, sem o reinício automático.
- **Quando não sobe**: o console e o `data/crash.log` dizem a causa. Código de saída 2: porta ocupada ("A porta 3000 já está em uso por outro programa (talvez outra janela do IClass ou o modo demonstração)") ou build ausente/desatualizado (rode a opção [4] do launcher ou `npm run build`). Código 3: banco danificado (restaure um backup com o `backup-cli.js`). Código 1: o banco não abriu (permissão, disco) ou erro inesperado. Com 2 e 3 o supervisor não tenta de novo; depois de 5 falhas seguidas no boot ele desiste com "⛔ O servidor não conseguiu iniciar 5 vezes seguidas.".
- **`data/logs/servidor.log`**: tudo o que o servidor e o supervisor escreveram, com data e hora em cada linha. Procure `🔁 O servidor parou (código X)` (queda e reinício), `🔁 Reinício pedido` (Reiniciar da tela Sistema) e `⛔` (o supervisor parou). Gira aos 5 MB (`servidor.log.1` a `.3`). O detalhe técnico de cada erro (pilha) fica no `data/crash.log`.
- **Cartão "Saúde do servidor"** (tela Sistema, atualiza a cada 15 s): Funcionando / Iniciando / Com problemas, há quanto tempo está ligado, memória, tamanho do banco, último salvamento (há quanto tempo e quanto levou), se o reinício automático está ligado e quantos reinícios houve, a última falha do `crash.log` e a última queda durante uma prova (com a turma e se o tempo foi devolvido). "Com problemas" depois de um erro inesperado: reinicie o IClass assim que possível. Enquanto o servidor reinicia o selo fica em "Iniciando"; se ele não responder (fora do ar, travado ou o computador suspenso) por mais de 30 s, o selo vai para "Com problemas" e o cartão avisa que os números mostrados são da última resposta, com a hora dela.
- **Monitor externo**: `GET /api/health` responde 200 só com o servidor funcionando (503 iniciando ou com problemas).
- **Parar sem perder a gravação**: Ctrl+C, fechar a janela, `kill`/SIGTERM e a rota de controle do launcher fazem o mesmo desligamento: grava, fecha o banco (o `-wal` é aplicado) e marca a parada limpa. Evite `taskkill /f` e kill -9: contam como queda.

## Testes

```powershell
npm run test:backend
npm run test:web
npm run test:e2e
npm run check
```

O backend usa `node:test` e Supertest, o frontend usa Vitest/Testing Library e os fluxos completos usam Playwright.

Variáveis de gravação usadas nos testes:

- `ICLASS_VERIFY_SAVES=1` liga o verificador de gravação parcial: uma rota que muda uma coleção fora do `only` do `db.save` é acusada no console (`[VERIFICAÇÃO DE GRAVAÇÃO]`) e o dado é gravado assim mesmo. No `node --test` ele liga sozinho e reprova o arquivo de teste; o servidor do e2e (`test/e2e/start-test-server.js`) liga por padrão. `ICLASS_VERIFY_SAVES=0` desliga.
- `ICLASS_DB_BUSY_TIMEOUT_MS` muda a espera pela trava do banco (padrão 5000 ms). Os testes de trava usam valores curtos para o 503 sair logo.
- `ICLASS_KEYSTROKE_CAP` muda o teto do histórico de digitação da prova por aluno e aplicação (padrão 20000). Os testes do teto usam um valor pequeno.

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

### Banco em modo WAL

O banco (`data/database.db`) roda em modo WAL: com o servidor ligado existem também `database.db-wal` e `database.db-shm`. Uma cópia manual do banco feita com o servidor ligado precisa dos três arquivos juntos (só o `.db` pode vir sem as últimas gravações); prefira o backup do sistema ou desligue o servidor antes. Desligar com Ctrl+C, fechar a janela do console e o Reiniciar em Sistema gravam, fecham o banco e apagam o `-wal` (fase 2, H3c); só o processo morto à força (kill -9, `taskkill /f`, falta de energia) deixa o `-wal`, que é aplicado na subida seguinte (por isso a cópia manual com o servidor ligado precisa dos três arquivos). Não deixe a pasta do IClass dentro do OneDrive ou de pasta de rede: o modo WAL pode não pegar (aviso no console) e o sincronizador pode prender o arquivo.

Toda gravação confirmada ao usuário já está no disco: a resposta só sai depois do `COMMIT` (com `synchronous=FULL`). Se outro programa prender o banco por mais que o `busy_timeout` (5 s), a tela recebe 503 "Não foi possível gravar os dados agora. Tente de novo em alguns segundos." e o servidor tenta gravar de novo sozinho (2 s, 5 s, 10 s e depois a cada 30 s); a falha vai para o `crash.log` no máximo uma vez por minuto.

## Modo manutenção

O modo manutenção bloqueia login, APIs, fórum e conteúdos estudantis, inclusive para sessões já abertas. O painel administrativo permanece disponível.

## Configuração inicial pelo inicializador

A opção 5 do `ligarIclassV3.bat` inicia o servidor normal com os diretórios reais e mostra os botões de acesso rápido para Administrador, Professor e Aluno. Ela não define `TEST_MODE`, não cria fixtures e não altera senhas. Cada botão abre exclusivamente a conta oficial correspondente: `admin@teste.local`, `professor@teste.local` ou `aluno@teste.local`; nunca escolhe outro usuário pela posição na lista. O inicializador gera uma autorização aleatória e abre uma janela normal e outra privada/anônima com o mesmo fragmento temporário, permitindo testar dois perfis simultaneamente com armazenamentos isolados. O frontend remove o fragmento imediatamente. Durante uma hora, o token funciona somente quando a conexão vem de loopback (`127.0.0.1` ou `::1`). Outros dispositivos da rede continuam exigindo autenticação normal.

Quando ainda não existe administrador, o bootstrap cria `admin@local`, grava uma senha aleatória em `data/bootstrap-admin.txt` e exige a definição de uma nova senha. Se uma conta oficial de teste estiver ausente ou incompatível com o perfil do botão, a tela informa o problema em vez de entrar em outra conta. O modo local não exibe um banner persistente depois da entrada.

O `TEST_MODE` com acessos sem senha permanece exclusivo do Playwright, que define banco, conteúdo e arquivo em diretórios temporários.
