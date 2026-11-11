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
- Testes: `backup-restauracao.test.js`, `database-persistence.test.js`

ZIP com soma do banco diferente da do manifesto, entrada com CRC errado, arquivo cortado, entrada que descompacta mais do que declara, link simbólico, caminho para fora da pasta ou coleção com estrutura errada é recusado com a mensagem em português antes de mudar qualquer coisa.

