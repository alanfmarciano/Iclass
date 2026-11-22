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

**Montagem e impressão.** A prévia da montagem mostra o tipo, os pontos e o total. Na prova online, **Versões online** vai até 4. Na impressa, cada folha tem o cabeçalho da escola (nome e dados de **Escolas / Instituições**, logo da **Identidade visual**); a numérica tem uma linha para a resposta, a resposta curta tem duas e a dissertativa tem doze; o verdadeiro ou falso é marcado no cartão-resposta (V ou F); o cartão-resposta traz só as questões de escolha, e o gabarito do professor traz as respostas de todos os tipos e a rubrica das dissertativas.

**Para quem é a aplicação.** No cartão **Para quem**, escolha **Turma inteira** (o normal), **Segunda chamada** ou **Escolher alunos**. Na segunda chamada, o IClass já marca quem ainda não fez a prova regular; quem já fez aparece com a etiqueta **Já fez**. Numa nova segunda chamada, quem já entregou a anterior continua marcado e aparece com **Fez a segunda chamada**: desmarque se ele não precisa fazer de novo. Só os alunos marcados veem a prova e conseguem começar. Depois de preparar, o botão **Alunos desta aplicação** muda a lista enquanto a aplicação não terminar.

**Exceção por aluno.** Em **Exceção por aluno**, dê até 5 tentativas extras para um aluno ou, com o cronômetro **Quando cada aluno iniciar**, um prazo **Pode começar até** só para ele. Escreva o motivo: ele fica na Auditoria. O aluno vê o limite dele no cartão da prova e, nas instruções da prova, o limite e o prazo. Quem já começou antes do prazo continua a prova depois dele. Para tirar só o prazo e manter as tentativas extras, use **Tirar o prazo**.

**Corrigir o gabarito depois da prova.** Descobriu, depois de encerrar, que a resposta certa de uma questão era outra (um aluno reclamou, por exemplo)? Em **Aplicações anteriores**, abra a preparação: o cartão **Aplicações online desta preparação** tem **Corrigir gabarito** em cada aplicação encerrada ou em andamento. Escolha a questão, marque a resposta certa (as letras são as da prova original, com o texto de cada alternativa; na numérica, o valor e a tolerância; na resposta curta, as respostas aceitas, uma por linha) e escreva o motivo. **Ver impacto** mostra, sem mudar nada, quem muda de nota ("Muda a nota de 7 alunos (3 já publicadas: eles serão avisados)."); depois dele, **Corrigir gabarito** grava. Só a resposta certa muda: o texto e a ordem da prova ficam como os alunos viram, inclusive nas versões embaralhadas. A nota de antes fica no histórico da nota com o motivo, a correção fica na Auditoria e no registro da aplicação, e quem já tinha a nota publicada recebe **Nota alterada** no sino. A dissertativa não tem gabarito para corrigir aqui. Questão anulada só é corrigida marcando **Tirar a anulação**. A preparação de onde a aplicação saiu também passa a usar a resposta certa: **Imprimir** e **Aplicar online** de novo nela (a segunda chamada, por exemplo) já saem com ela, e a aplicação dela já preparada que ainda não começou também. Se outra aplicação online da mesma preparação, nesta turma, já começou (uma segunda chamada já feita, por exemplo), ela fica com as notas dela: **Ver impacto** avisa, e você corrige cada uma pelo botão dela. A preparação é de cada turma: a mesma prova em outra turma tem a preparação dela e é corrigida lá. A avaliação no editor não muda: corrija lá também para as provas que você montar de novo. A aplicação que ainda não começou não tem este botão, porque ninguém tem nota: ela guarda o gabarito de quando foi preparada, então corrija a questão no editor e prepare de novo por **Preparar e abrir monitor** (a nova preparação substitui a antiga). Não use o **Aplicar online** dessa preparação: ele reaplica a resposta antiga. Se outra aplicação dessa preparação já começou, corrigir o gabarito por ela já leva a resposta certa à que está preparada.

## Banco de questões {#banco-de-questoes}

O banco guarda questões para usar em outras provas, nos seis tipos. Abra pelo botão **Ver banco de questões** em Provas ou, com a prova aberta no editor, pelo botão **Banco de questões** (aí cada item tem **Adicionar**).

**Encontrar.** Busque pelo texto (sem se preocupar com acento) e filtre por categoria, tipo, dificuldade e etiqueta. Cada questão mostra em quantas aplicações foi usada e o % de acerto; a conta usa só as entregas consideradas das suas turmas e não conta a dissertativa que ainda aguarda correção.

**Guardar e editar.** Na questão da prova, **Salvar no banco** guarda uma cópia (a categoria é o tema da prova). **Nova questão** e **Editar** usam o mesmo cartão do editor da prova; em **Mais detalhes** ficam a dificuldade, as habilidades e as etiquetas. Cada alteração sobe a revisão e fica na Auditoria. A questão que veio do banco aparece com a etiqueta **Do banco**; é por ela que o banco conta os usos e os acertos.

**Arquivar e excluir.** **Arquivar** tira a questão da lista sem apagar (ligue **Mostrar arquivadas** e use **Desarquivar** para trazer de volta). **Excluir** apaga de vez e pede confirmação.

<!-- P3 (A13) escreve aqui: importar e exportar GIFT e CSV. -->

## Monitor {#monitor}

Acompanha a prova em andamento: quem entrou, quem está respondendo, quem saiu da tela e quem já entregou. Pelo Monitor você manda mensagem para um aluno ou para a turma, ajusta o tempo e encerra a aplicação. O botão **Endereço da sala** mostra o QR para quem ainda não entrou.

No botão **⋯** (Mais ações) da linha do aluno ficam as ações só dele:

- **Recolher prova**: entrega a prova agora, com as respostas que o servidor já salvou. Use quando o aluno precisa sair ou quando a prova dele tem de terminar antes da turma. O motivo é opcional.
- **Reabrir prova**: a entrega volta para a mesma tentativa, com as respostas e o tempo que faltava quando ela foi entregue. Não conta como tentativa nova. Só funciona com a prova em andamento e a nota ainda não publicada, e o motivo é obrigatório (fica no registro da aplicação). Entrega feita antes desta versão do IClass não pode ser reaberta: dê uma tentativa extra.
- **Dar tentativa extra**: o aluno ganha mais tentativas nesta aplicação (até 5 no total). As entregas que ele já fez continuam valendo.

Em **Tempo**, os botões −5, +5 e +10 preenchem os minutos, e o motivo é opcional. Em **Msg** e **Aviso turma** há avisos prontos, e a janela mostra para quem a mensagem vai.

Abriu o Monitor em outro computador, no projetor ou fechou a aba? Em **Token de acesso**, **Mostrar token** traz o mesmo token, sem trocar (cada vez fica no registro da aplicação). Se a aplicação é de antes desta versão ou veio de um backup de outro computador, o IClass não tem como mostrar o token de novo: use **Gerar outro**. Quem já entrou continua na prova.

## Tarefas {#tarefas}

Tarefa é um trabalho com prazo que o aluno entrega pelo IClass: um arquivo (PDF, foto, documento, código, o arquivo do programa do curso), um texto ou um link. Fica em **Avaliações > Tarefas**, dentro da turma.

**A lista.** Cada cartão mostra o prazo (com quanto falta), a situação (**Rascunho**, **Publicada** ou **Arquivada**) e, depois de publicada, quantas entregas estão **Para corrigir**, quantas chegaram **Atrasadas** e quantos alunos estão **Sem envio**. Em **Mostrar** você vê só as publicadas, só os rascunhos ou só as que têm entrega para corrigir (o aviso do Dashboard abre assim).

**Criar.** Toque em **Nova tarefa**. Escreva o título e as instruções (negrito, listas e links como nas apostilas; **Prévia** mostra como o aluno vai ler). Se quiser, ligue a tarefa a um módulo e a uma unidade e escolha materiais de apoio da Biblioteca. Em **O aluno responde com**, marque arquivo, texto ou link. Com arquivo, escolha os tipos aceitos, até quantos arquivos e de quantos MB cada; o tamanho vai até o limite das entregas em **Sistema**. Programa do curso que não está na lista (Packet Tracer, por exemplo)? Escreva a extensão em **Formatos do curso** (.pkt). Programas que se instalam ou rodam sozinhos (.exe, .bat e afins) nunca são aceitos.

**Prazo.** O prazo é a data e a hora no relógio da escola. **Encerrar envios em** é opcional: depois dele, nada chega, nem atrasado. Em **Depois do prazo**, escolha entre aceitar e marcar como atrasada, aceitar com desconto na nota (tanto por dia, até um máximo) ou não aceitar. A frase "O aluno lê" mostra como a regra aparece para ele. **Aparecer para os alunos** pode ser assim que publicar ou numa data.

**Rascunho e publicar.** **Salvar como rascunho** guarda sem os alunos verem (o rascunho pode ficar sem prazo). **Publicar** exige o prazo; a tarefa aparece para a turma e o aluno recebe o aviso no sino. Mudar o prazo de uma tarefa que já tem entrega ou nota lançada pede o motivo, que fica na Auditoria.

**Arquivar e excluir.** **Arquivar** tira a tarefa dos alunos e guarda as entregas e as notas; ela fica na aba **Arquivadas**, de onde volta com **Reativar**. **Excluir** só aparece na tarefa sem nenhum registro de aluno: nem entrega, nem nota lançada, nem prazo prorrogado.

**Entregas da turma.** Toque no título da tarefa (ou em **Entregas**) para ver a lista da turma: cada aluno com a situação (**Sem envio**, **Para corrigir**, **Corrigida, sem devolver**, **Refazer (esperando o aluno)** ou **Devolvida**), quando enviou, se chegou atrasada e a nota. Em **Mostrar**, veja só quem está para corrigir, as corrigidas, as atrasadas, quem não enviou ou as devolvidas. No celular, a lista vira cartões.

**Corrigir.** Toque em **Corrigir** (ou **Abrir**) no aluno. O painel mostra a entrega: a versão (o aluno pode mandar de novo; escolha em **Versão**), a hora que chegou no relógio da escola, os arquivos, o texto e o link. Foto (JPG, PNG, WebP, GIF) e texto aparecem ali mesmo; PDF abre em outra aba com **Abrir**; o resto (Word, planilha, ZIP, arquivo do programa do curso, foto HEIC do iPhone) você baixa com **Baixar**. O link do aluno aparece como texto: confira antes de tocar em **Abrir**.

**Nota e comentário.** Digite a nota de 0 a 10 (aceita vírgula: 8,5) e o comentário para o aluno. Se a entrega chegou atrasada numa tarefa com desconto, o painel mostra a conta antes de salvar ("Atraso de 2 dias: -20%, nota final 6,4."); cada dia começado conta como um dia. **Dispensar desconto** tira o desconto só deste aluno. **Salvar** guarda sem o aluno ver; **Devolver ao aluno** mostra a nota e o comentário para ele e avisa no sino. **Próximo aluno** segue a ordem da lista que estava na tela quando você abriu o painel. Se você digitou e não salvou, o IClass pergunta antes de sair.

**Nota já devolvida.** Mudar a nota ou o comentário de uma correção que o aluno já vê pede o motivo, que fica na Auditoria.

**Outras ações.** Em **Pedir para refazer**, escreva o que o aluno precisa refazer e o novo prazo; ele manda uma versão nova e a correção volta para você. **Prorrogar prazo** dá um prazo só para aquele aluno (o da turma não muda) e pede o motivo; o aluno aparece com **Prazo próprio**. **Entrega em mãos** registra o trabalho entregue fora do IClass (papel, pendrive, apresentação), com uma observação e, se quiser, a nota. Aluno sem entrega nunca recebe zero sozinho: sem envio, só a nota zero que você lança ou a entrega em mãos.

**Devolver todas.** **Devolver todas as corrigidas** devolve de uma vez as correções salvas com nota. A que recebeu versão nova depois da correção fica de fora, para você conferir.

**Baixar entregas (ZIP).** Baixa os arquivos da turma num ZIP, uma pasta por aluno, só a última versão ou todas. Serve para corrigir no computador ou guardar.

**Copiar para outra turma.** Cria a mesma tarefa como rascunho noutra turma sua, com o prazo que você escolher (ou sem prazo). As entregas não vão junto.

A Coordenação vê as entregas, abre os arquivos e baixa o ZIP, mas não corrige.

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
