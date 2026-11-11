# Casos de uso — Segurança e backup

## UC-SEC-001 — Impedir arquivos e caminhos maliciosos

- Estado: automatizado
- Testes: `upload-security.test.js` e `safe-path.test.js`

Uploads executáveis, assinaturas incompatíveis, caminhos absolutos e traversal devem ser recusados antes de qualquer leitura, gravação ou extração.

Esses testes permanecem ativos mesmo com a reformulação das apostilas, pois protegem toda a plataforma.

## UC-GRAVACAO-001 — Gravar sem perder o que foi confirmado

- Estado: automatizado
- Testes: `database-storage.test.js`, `save-response.test.js` e `armazenamento.test.js`

Toda resposta de "salvo" só sai depois que o dado está no disco (COMMIT do SQLite em modo WAL com `synchronous=FULL`): um kill -9, o Reiniciar ou uma queda logo depois do 200 não perdem a gravação. Um leitor externo do banco não trava a gravação; outro programa prendendo o arquivo por mais que o `busy_timeout` faz a tela receber 503 "Não foi possível gravar os dados agora. Tente de novo em alguns segundos." (sem pendurar e sem derrubar a sessão) e o servidor regrava sozinho quando a trava sai. A espera pela trava conta por pedido: quem chega durante uma gravação travada recebe o 503 em cerca de um `busy_timeout`, não dois. A primeira gravação depois do boot escreve só o que mudou, linhas com JSON ilegível nunca são apagadas nem sobrescritas (quando a chave volta a ser usada, por exemplo a configuração que voltou ao padrão, o texto original fica guardado como `<chave>.ilegivel-<data>`), e um erro no meio da gravação desfaz a transação inteira sem obrigar a regravar o banco todo. Falha de gravação que a rota trata de propósito (presença automática, Reiniciar) mantém a resposta da rota.

As rotas mais usadas durante a aula e a prova (rascunho e sincronização da prova, logs do Monitor, presença, caderno, anotações, progresso) gravam só as coleções que mudaram, em vez de regravar o banco inteiro a cada pedido. De 10 em 10 minutos, fora de prova em andamento (com teto de 2 h de espera), uma gravação completa (rede de segurança) leva ao disco o que uma rota tenha deixado de fora e registra no `crash.log` a coleção, para corrigir a rota.

## UC-ARMAZENAMENTO-001 — Ver o tamanho do banco e compactar

- Estado: automatizado
- Testes: `armazenamento.test.js` e `ArmazenamentoCard.test.jsx`

Na tela Sistema, o cartão Armazenamento mostra o tamanho do banco e do `-wal`, o espaço recuperável depois de apagar dados, as maiores coleções, as teclas da prova gravadas, a última gravação completa, o tempo de gravação (p95) e a última falha de gravação em vermelho. Com a pasta de dados dentro do OneDrive, o cartão e o console do servidor avisam para mover a pasta. O administrador compacta o banco (VACUUM) digitando COMPACTAR: o servidor recusa com prova em andamento ou sem espaço em disco, o professor não vê o botão (e recebe 403), e a compactação fica na Auditoria com o tamanho antes e depois, sem perder dados. Com mais de 25% do arquivo livre, o administrador vê "Compactar o banco" no Precisa de você.

## UC-BACKUP-001 — Restaurar backup conferindo antes

- Estado: automatizado
- Testes: `backup-restauracao.test.js`, `SistemaPage.test.jsx`, `backup-versao-anterior.test.js`, `student-records-privacy.test.js`

O administrador envia o arquivo e vê a prévia antes de mudar qualquer coisa: o que o backup traz ao lado do que há hoje, o que ficará vazio, as provas em andamento, os alunos anonimizados que voltariam com dados pessoais, o aviso de backup de versão anterior e a integridade conferida. "Restaurar" só libera com RESTAURAR digitado e usa o token da prévia (uso único, só de quem fez a prévia, 1 hora). A restauração segue o modo de cada coleção no registro, leva as teclas da prova, mantém a regra de rede e a configuração protegida deste computador e volta tudo se falhar no meio. Backups antigos (JSON e ZIP formato 1) continuam restaurando.

## UC-BACKUP-002 — Banco danificado e backup pela linha de comando

- Estado: automatizado
- Testes: `database-integridade.test.js`, `backup-cli.test.js`

Com o banco danificado o servidor não sobe (código 3), não grava no arquivo e manda para o `backup-cli.js`. Com o servidor parado, o `backup-cli.js` lista, cria, confere e restaura backups ZIP formato 2; o banco de antes vai para a quarentena e nada é apagado.

## UC-BACKUP-003 — Recusar backup alterado, cortado ou malicioso

- Estado: automatizado
- Testes: `backup-restauracao.test.js`, `backup-restauracao-queda.test.js`, `backup-restauracao-marcador.test.js`, `backup-destino.test.js`, `backup-cli.test.js`, `database-persistence.test.js`

ZIP com soma do banco diferente da do manifesto, entrada com CRC errado, arquivo cortado, entrada que descompacta mais do que declara, link simbólico, caminho para fora da pasta ou coleção com estrutura errada é recusado com a mensagem em português antes de mudar qualquer coisa. Restauração interrompida (queda do processo ou desligamento do servidor no meio) volta tudo ao que era antes dela; a que terminou nunca é desfeita no boot seguinte. Com uma restauração interrompida ainda a desfazer, outra restauração (pela tela ou pela backup-cli) é recusada com "Uma restauração anterior foi interrompida e ainda não foi desfeita. Feche e abra o IClass de novo para terminar de desfazer antes de restaurar outro backup.". A restauração entra na Auditoria antes de o marcador sair; se o servidor cair nesse instante, o boot não desfaz nada e completa o registro com a observação "registrado ao reiniciar".

## UC-BACKUP-004 — Backup diário com cópia fora do computador

- Estado: automatizado
- Testes: `backup-destino.test.js`, `backup-cli.test.js` e `BackupCard.test.jsx`

O administrador escolhe na tela Sistema (cartão Backup) a pasta do destino externo: um pendrive, HD externo ou pasta de rede, com o caminho completo. O IClass só aceita pasta que existe, fora da pasta do IClass, e testa a gravação na hora (cria `<destino>/IClass-<computador>`, grava e apaga um arquivo de teste); a resposta diz o espaço livre e avisa quando a pasta fica no mesmo disco. A tela lembra que o backup traz dados pessoais de alunos e senhas protegidas. Com o servidor ligado, o backup automático roda no boot e de hora em hora quando o último tem 20 horas ou mais: o ZIP dos dados em `data/backups` e o completo (com a biblioteca) no destino, da mesma cópia do banco, cada um com o `.sha256`. Com prova em andamento ele espera, até o último passar de 48 horas. O resultado fica em `data/backups/estado.json` e na Auditoria (ator "sistema"). Pendrive desconectado não impede o backup local: a falha aparece em vermelho no cartão e no "Precisa de você" do administrador; atraso de mais de 26 horas e destino não escolhido também aparecem lá (o professor não vê esses itens). "Fazer backup agora" faz o mesmo na hora, e o `backup-cli.js criar` grava no destino externo quando ele está conectado.

## UC-BACKUP-005 — Retenção dos backups e nada pela metade

- Estado: automatizado
- Testes: `backup-destino.test.js`

Cada grupo guarda os mais recentes: automático 14 neste computador e o número escolhido no destino (1 a 90, padrão 14), manual 20, segurança 5, antes de limpar o estado de prova 10, antes de resetar a sala 10, e 30 `.bak` por apostila ou avaliação editada. Os JSON antigos contam no grupo, o mais novo nunca sai e arquivo fora do padrão de nome do IClass nunca é apagado. Desligar o servidor no meio de um backup espera alguns segundos, interrompe a gravação e apaga o `.parcial`; sobras `.parcial` antigas saem no boot, e as de uma queda logo antes do boot saem pouco mais de um minuto depois. Se o desligamento chega durante a cópia para o destino externo, o backup deste computador já gravado vale.

## UC-BACKUP-006 — Lista, download com a senha de novo e restaurar da lista

- Estado: automatizado
- Testes: `backup-destino.test.js`, `BackupCard.test.jsx` e `SistemaPage.test.jsx`

O cartão Backup lista os backups deste computador e do destino externo. Baixar qualquer backup (da lista, completo, só os dados ou o JSON) pede a senha do administrador de novo, e a tela diz em uma linha o motivo (o backup traz os dados pessoais de todos os alunos); a senha errada fica no diálogo e conta no atraso da conta, o bilhete vale uma vez, por 2 minutos, para aquele arquivo, e o download vai para a Auditoria. Errar a senha demais faz esperar, com o texto do download (o login da conta espera o mesmo tempo). Nome com caminho ou fora do padrão é recusado. "Restaurar" num item da lista confere o `.sha256` ao lado e abre a mesma prévia do arquivo enviado; o backup escolhido continua na lista depois. Na prévia, a linha da Auditoria diz que a de hoje é mantida e somada à do backup.

## UC-BACKUP-007 — Backup e compactação com o banco em uso

- Estado: automatizado
- Testes: `backup-vacuum-leituras.test.js`

O backup do boot, o "Fazer backup agora" e o Compactar usam o `VACUUM` do sqlite, que falha se houver uma consulta em andamento na mesma conexão. O launcher e o Reiniciar consultam o `/api/health` durante a subida, o cartão Saúde consulta o banco e o Monitor lê as teclas ao vivo; nada disso pode fazer o backup falhar. Toda leitura direta do banco conta até o sqlite responder, o `VACUUM` espera essas leituras acabarem (as novas esperam o `VACUUM` terminar) e, se ainda assim o sqlite responder "SQL statements in progress", tenta de novo até 5 vezes, com 200 ms entre as tentativas.

