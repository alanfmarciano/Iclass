# Manual do professor

Como usar o painel do IClass no dia a dia da sala. Cada parte tem o nome do item do menu. Nas telas com o botão **?** ao lado do título, ele abre a parte certa deste manual.

<!--
Regras para escrever aqui (contrato C4 do P6, fase 3):
- Este arquivo é o manual das telas do PAINEL. As telas do aluno ficam em aluno.md.
- Cada tema já tem o seu título com a âncora ("## Tarefas {#tarefas}"). Escreva só debaixo do
  título do seu tema; não mude o título, a âncora nem a ordem (é a ordem do menu).
- Não crie arquivo novo em web/src/features/help/conteudo/ (são só os cinco da D20).
- Tela nova do painel com PageHeader recebe helpTopic="<âncora>" e o botão "?" aparece sozinho;
  o npm run test:docs confere que a âncora existe aqui.
- Tema sem texto não aparece na Ajuda (fica só o título guardado aqui).
- Português simples, frases curtas, os nomes dos botões como estão na tela.
-->

## Primeiros passos {#primeiros-passos}

<!-- P6 (A21, assistente e cartão Primeiros passos) escreve aqui. -->

## Dashboard {#dashboard}

A primeira tela depois de escolher o curso e a turma. Mostra o resumo da turma e, em **Precisa de você**, o que está esperando uma ação sua. O sino no alto junta os mesmos avisos.

## Endereço da sala {#endereco-da-sala}

Mostra o endereço que os alunos digitam no navegador e o QR code dele, em tela cheia, para projetar no quadro. Os alunos precisam estar na mesma rede Wi-Fi do computador do IClass.

## Matrículas {#matriculas}

<!-- Tela de pedidos de matrícula (só administrador). P4 escreve aqui o que mudar na aprovação (enrollments.approve). -->

## Provas {#provas}

Aqui você monta as avaliações do curso e aplica na turma. Escolha a prova, prepare a aplicação e abra a sala de espera quando os alunos estiverem prontos. Durante a prova, acompanhe tudo pelo **Monitor**.

<!-- P3 escreve aqui: editor de questões, tipos novos, preparar aplicação, segunda chamada e agendamento. -->

**Tipos de questão.** Em **Editar conteúdo** (ou **Nova prova**), escolha o **Tipo da questão**:

- **Uma correta**: marque a alternativa certa (de 2 a 8 alternativas).
- **Várias corretas**: marque todas as certas. Com **Pontuação parcial** ligada, cada certa marcada vale uma parte e cada errada desconta uma parte, sem ficar negativa; desligada, é tudo ou nada.
- **Verdadeiro ou falso**: escreva a afirmação e marque se ela é Verdadeiro ou Falso.
- **Numérica**: a resposta certa (aceita vírgula), a tolerância (por exemplo, 3,5 com tolerância 0,25 aceita de 3,25 a 3,75) e a unidade, que aparece ao lado do campo do aluno.
- **Resposta curta**: as respostas aceitas. Maiúsculas, acentos e espaços a mais não contam.
- **Dissertativa**: a resposta esperada (só você vê) e, se quiser, a rubrica: os critérios e os pontos de cada um. A soma dos critérios precisa ser igual aos pontos da questão; o editor mostra a soma e oferece **Usar ... como pontos**.

Na numérica e na resposta curta, **Mandar para mim quando a resposta não bater** deixa a resposta diferente para você corrigir, em vez de valer zero.

**Pontos.** Cada questão vale de 0,1 a 100 pontos (padrão 1). O topo do editor mostra o total da prova. A nota é a proporção dos pontos que o aluno fez.

**Texto, imagem e prévia.** O enunciado, as alternativas e a explicação aceitam Markdown: `**negrito**`, `` `código` ``, bloco de código entre três crases, tabela e imagem. No enunciado e na explicação, use a barra acima do campo (Negrito, Código, Tabela, Imagem); nas alternativas, digite o Markdown direto no campo (por exemplo, `` `ls -l` ``). A imagem é enviada do computador ou do celular (JPG, PNG, GIF ou WebP) e só aparece para o aluno durante a prova dele. Ao lado do campo (no celular, na aba **Prévia**) a questão aparece como o aluno vai ver, com a resposta certa embaixo. A **Explicação** aparece para o aluno só quando você libera o gabarito. Em **Mais detalhes** ficam a dificuldade, as habilidades e as etiquetas.

**Antes de salvar.** Trocar o tipo não apaga o que já foi escrito. Se faltar alguma coisa, o editor diz o que é ("Questão 2: informe o valor da resposta numérica.") e não salva até você completar. Excluir uma questão preenchida pede confirmação; ela só sai da prova quando você salva.

**Montagem e impressão.** A prévia da montagem mostra o tipo, os pontos e o total. Na prova online, **Versões online** vai até 4. Na impressa, cada folha tem o cabeçalho da escola (nome e dados de **Escolas / Instituições**, logo da **Identidade visual**); a numérica tem uma linha para a resposta, a resposta curta tem duas e a dissertativa tem doze; o verdadeiro ou falso é marcado no cartão-resposta (V ou F); o cartão-resposta traz só as questões de escolha, e o gabarito do professor traz as respostas de todos os tipos e a rubrica das dissertativas. O banco de questões ainda guarda só questões de **Uma correta**.

**Para quem é a aplicação.** No cartão **Para quem**, escolha **Turma inteira** (o normal), **Segunda chamada** ou **Escolher alunos**. Na segunda chamada, o IClass já marca quem ainda não fez a prova regular; quem já fez aparece com a etiqueta **Já fez**. Numa nova segunda chamada, quem já entregou a anterior continua marcado e aparece com **Fez a segunda chamada**: desmarque se ele não precisa fazer de novo. Só os alunos marcados veem a prova e conseguem começar. Depois de preparar, o botão **Alunos desta aplicação** muda a lista enquanto a aplicação não terminar.

**Exceção por aluno.** Em **Exceção por aluno**, dê até 5 tentativas extras para um aluno ou, com o cronômetro **Quando cada aluno iniciar**, um prazo **Pode começar até** só para ele. Escreva o motivo: ele fica na Auditoria. O aluno vê o limite dele no cartão da prova e, nas instruções da prova, o limite e o prazo. Quem já começou antes do prazo continua a prova depois dele. Para tirar só o prazo e manter as tentativas extras, use **Tirar o prazo**.

## Banco de questões {#banco-de-questoes}

<!-- P3 (A7 e A13) escreve aqui: metadados, estatística, importar e exportar GIFT e CSV. -->

## Monitor {#monitor}

Acompanha a prova em andamento: quem entrou, quem está respondendo, quem saiu da tela e quem já entregou. Pelo Monitor você manda mensagem para um aluno ou para a turma, ajusta o tempo e encerra a aplicação. O botão **Endereço da sala** mostra o QR para quem ainda não entrou.

No botão **⋯** (Mais ações) da linha do aluno ficam as ações só dele:

- **Recolher prova**: entrega a prova agora, com as respostas que o servidor já salvou. Use quando o aluno precisa sair ou quando a prova dele tem de terminar antes da turma. O motivo é opcional.
- **Reabrir prova**: a entrega volta para a mesma tentativa, com as respostas e o tempo que faltava quando ela foi entregue. Não conta como tentativa nova. Só funciona com a prova em andamento e a nota ainda não publicada, e o motivo é obrigatório (fica no registro da aplicação). Entrega feita antes desta versão do IClass não pode ser reaberta: dê uma tentativa extra.
- **Dar tentativa extra**: o aluno ganha mais tentativas nesta aplicação (até 5 no total). As entregas que ele já fez continuam valendo.

Em **Tempo**, os botões −5, +5 e +10 preenchem os minutos, e o motivo é opcional. Em **Msg** e **Aviso turma** há avisos prontos, e a janela mostra para quem a mensagem vai.

Abriu o Monitor em outro computador, no projetor ou fechou a aba? Em **Token de acesso**, **Mostrar token** traz o mesmo token, sem trocar (cada vez fica no registro da aplicação). Se a aplicação é de antes desta versão ou veio de um backup de outro computador, o IClass não tem como mostrar o token de novo: use **Gerar outro**. Quem já entrou continua na prova.

## Tarefas {#tarefas}

<!-- P1 (trilha C) escreve aqui: criar tarefa, prazos, entregas, correção, devolução e ZIP. -->

## Resultados {#resultados}

Mostra as entregas das provas da turma, aluno por aluno, com as notas. Daqui você abre a prova de cada aluno, confere as respostas e libera as notas.

<!-- P2 escreve aqui: quadro de notas, plano de avaliação, média, etapas, situação e boletim. -->

## Correção de provas {#correcao}

<!-- P3 (A9 e A18) escreve aqui: correção manual, anular por cola, revisão pedida pelo aluno e corrigir gabarito. -->

## Materiais e liberação {#materiais}

<!-- P3 (A11) e P5 escrevem aqui: liberar unidades, agendamento de material e liberação por grupo. -->

## Editor de conteúdo {#editor}

## Biblioteca {#biblioteca}

## Alunos {#alunos}

<!-- P4 escreve aqui: cadastro, matrícula, login por matrícula e aluno sem e-mail. -->

## Grupos {#grupos}

<!-- P5 (C12 e C19) escreve aqui: grupos da turma, sorteio e grupos em avisos, liberação e provas. -->

## Ver como aluno {#ver-como-aluno}

<!-- P5 (C2 e C15) escreve aqui. -->

## Chamada {#chamada}

Registra a presença por aula. Escolha a data, marque quem veio e salve. A presença também pode ser marcada sozinha quando o aluno entra no IClass, se a turma estiver configurada assim.

<!-- P4 (B11) escreve aqui: conteúdo das aulas e diário de classe. P5 (B19): avisar o responsável. -->

## Diário de classe {#diario}

<!-- P4 (B11 e B12) escreve aqui: diário, documento impresso e aulas previstas x dadas. -->

## Avisos {#avisos}

## Calendário {#calendario}

<!-- P2 (B7) escreve aqui: dias não letivos e feriados. -->

## Fórum e dúvidas {#forum}

## Mensagens {#mensagens}

<!-- P5 (C13 e C14) escreve aqui: conversas com os alunos e o aviso de leitura pelo administrador. -->

## Responsáveis {#responsaveis}

<!-- P5 (B19 e B20) escreve aqui: aviso de faltas, registro do contato e comunicado impresso. -->

## Relatórios {#relatorios}

<!-- P4 (B13 e B14) escreve aqui: relatórios, impressão e boletins em lote. -->

## Cursos e turmas {#turmas}

Lista os cursos da instituição e as turmas de cada um. Daqui você cria turmas e abre ou fecha o autocadastro dos alunos em cada uma.

<!-- P2 (B6, B8, B10) escreve aqui: critérios de avaliação, disciplinas, período letivo e encerrar turma. P4 (A14): exportar e importar curso. -->

## Período letivo {#periodo-letivo}

<!-- P2 (B5 e B8) escreve aqui: períodos, etapas e carga horária. -->

## Certificados {#certificados}

<!-- P4 (B16 e B17) escreve aqui: emitir, modelo e validar certificado. -->

## Importar alunos {#importar-alunos}

<!-- P4 (C20 e C21) escreve aqui: importar alunos e notas por planilha. -->

## Diretório de alunos {#diretorio}

<!-- P4 (C22) escreve aqui: mesclar cadastros. -->

## Cadastros encerrados {#cadastros-encerrados}

## Escolas {#escolas}

## Identidade visual {#identidade}

## Contas e papéis {#contas}

<!-- P4 (B1) escreve aqui: papéis (Professor, Secretaria, Coordenação) e o que cada um pode fazer. -->

## Minha conta {#minha-conta}

<!-- P4 (B1) escreve aqui: nome, senha e encerrar as outras sessões. -->

## Sistema {#sistema}

Reúne o que mantém o IClass funcionando neste computador:

- **Sobre o IClass**: a versão instalada, a versão dos dados, o código desta instalação e as **Novidades** de cada versão.
- **Saúde do servidor**: se o servidor está funcionando, há quanto tempo está ligado e a última falha.
- **Rede**: o endereço para os alunos e a conexão segura.
- **Backup**: as cópias de segurança, o destino externo (pendrive ou HD) e a restauração.

<!-- P6 (A20, A21, A21c) escreve aqui: primeiro acesso, nome iclass.local e licença. -->

## Auditoria {#auditoria}

## Privacidade (LGPD) {#privacidade}
