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

**Como montar.** Na prova online, o cartão **Montagem** tem **Como montar**. Com **Versões (máx. 4)**, todos recebem as mesmas questões; cada versão (de A a D) muda a ordem das questões e das alternativas. Com **Sorteio por aluno**, cada aluno recebe questões sorteadas da montagem, sem repetir: crie um grupo para cada parte da prova (por exemplo, **Quantidade** 2 com **Dificuldade** Fácil e outro grupo com 1 Difícil) e, se quiser, filtre por **Origem** (escritas na prova ou vindas do banco), **Categoria do banco** e **Etiqueta**. Embaixo de cada grupo aparece quantas questões combinam com o filtro; uma questão que serve para dois grupos fica no primeiro. No sorteio, a montagem é a prova inteira, menos as questões que você tirou da prévia com **Remover**. O sorteio é feito quando o aluno começa a prova: recarregar a página ou trocar a versão dele no Monitor não muda as questões que ele tirou. **Aplicar prova novamente** também tem **Como montar**, com as questões daquela configuração. A prova online é montada pelo IClass a partir da prova gravada, e a impressa é conferida com ela antes de ir para o histórico: se a prova foi editada em outra aba, recarregue a página e monte de novo.

**Para quem é a aplicação.** No cartão **Para quem**, escolha **Turma inteira** (o normal), **Segunda chamada**, **Escolher alunos** ou **Recuperação**. A nota da segunda chamada conta como a da prova regular; a da recuperação entra como recuperação, pela regra dos critérios de avaliação do curso (sem critérios, como mais uma nota). Na segunda chamada, o IClass já marca quem ainda não fez a prova regular; quem já fez aparece com a etiqueta **Já fez**. Numa nova segunda chamada, quem já entregou a anterior continua marcado e aparece com **Fez a segunda chamada**: desmarque se ele não precisa fazer de novo. Só os alunos marcados veem a prova e conseguem começar. Depois de preparar, o botão **Alunos desta aplicação** muda a lista enquanto a aplicação não terminar.

**Exceção por aluno.** Em **Exceção por aluno**, dê até 5 tentativas extras para um aluno ou, com o cronômetro **Quando cada aluno iniciar**, um prazo **Pode começar até** só para ele. Escreva o motivo: ele fica na Auditoria. O aluno vê o limite dele no cartão da prova e, nas instruções da prova, o limite e o prazo. Quem já começou antes do prazo continua a prova depois dele. Para tirar só o prazo e manter as tentativas extras, use **Tirar o prazo**.

**Corrigir o gabarito depois da prova.** Descobriu, depois de encerrar, que a resposta certa de uma questão era outra (um aluno reclamou, por exemplo)? Em **Aplicações anteriores**, abra a preparação: o cartão **Aplicações online desta preparação** tem **Corrigir gabarito** em cada aplicação encerrada ou em andamento. Escolha a questão, marque a resposta certa (as letras são as da prova original, com o texto de cada alternativa; na numérica, o valor e a tolerância; na resposta curta, as respostas aceitas, uma por linha) e escreva o motivo. **Ver impacto** mostra, sem mudar nada, quem muda de nota ("Muda a nota de 7 alunos (3 já publicadas: eles serão avisados)."); depois dele, **Corrigir gabarito** grava. Só a resposta certa muda: o texto e a ordem da prova ficam como os alunos viram, inclusive nas versões embaralhadas. A nota de antes fica no histórico da nota com o motivo, a correção fica na Auditoria e no registro da aplicação, e quem já tinha a nota publicada recebe **Nota alterada** no sino. A dissertativa não tem gabarito para corrigir aqui. Questão anulada só é corrigida marcando **Tirar a anulação**. A preparação de onde a aplicação saiu também passa a usar a resposta certa: **Imprimir** e **Aplicar online** de novo nela (a segunda chamada, por exemplo) já saem com ela, e a aplicação dela já preparada que ainda não começou também. Se outra aplicação online da mesma preparação, nesta turma, já começou (uma segunda chamada já feita, por exemplo), ela fica com as notas dela: **Ver impacto** avisa, e você corrige cada uma pelo botão dela. A preparação é de cada turma: a mesma prova em outra turma tem a preparação dela e é corrigida lá. A avaliação no editor não muda: corrija lá também para as provas que você montar de novo. A aplicação que ainda não começou não tem este botão, porque ninguém tem nota: ela guarda o gabarito de quando foi preparada, então corrija a questão no editor e prepare de novo por **Preparar e abrir monitor** (a nova preparação substitui a antiga). Não use o **Aplicar online** dessa preparação: ele reaplica a resposta antiga. Se outra aplicação dessa preparação já começou, corrigir o gabarito por ela já leva a resposta certa à que está preparada.

**Agendar a prova.** No cartão **Quando**, **Eu abro pelo Monitor** é o de sempre: a aplicação fica preparada até você iniciar. Com **Agendar dia e horário**, escolha o dia, a hora de abrir e a de fechar (no relógio da escola; de 5 minutos a 12 horas, até 60 dias à frente). Se a prova passa da meia-noite, marque **Fecha no dia seguinte**. A prova abre sozinha no horário (na sala de espera, se ela tiver) e fecha sozinha, entregando o que cada aluno salvou. Os alunos veem **Agendada** com o horário em **Provas** e no **Calendário**, sem as questões. Se o dia não tem aula na turma ou se o horário é menor que a duração da prova, o cartão avisa antes de preparar. O computador do IClass precisa estar ligado: se ele ligar depois da hora de abrir, a prova abre na hora em que ele ligou e o **Precisa de você** avisa; se ligar só depois da hora de fechar, a prova não abre sozinha, e o Monitor e o **Precisa de você** mostram **A prova agendada não abriu** (agende de novo ou inicie pelo Monitor).

## Banco de questões {#banco-de-questoes}

O banco guarda questões para usar em outras provas, nos seis tipos. Abra pelo botão **Ver banco de questões** em Provas ou, com a prova aberta no editor, pelo botão **Banco de questões** (aí cada item tem **Adicionar**).

**Encontrar.** Busque pelo texto (sem se preocupar com acento) e filtre por categoria, tipo, dificuldade e etiqueta. Cada questão mostra em quantas aplicações foi usada e o % de acerto; a conta usa só as entregas consideradas das suas turmas e não conta a dissertativa que ainda aguarda correção.

**Guardar e editar.** Na questão da prova, **Salvar no banco** guarda uma cópia (a categoria é o tema da prova). **Nova questão** e **Editar** usam o mesmo cartão do editor da prova; em **Mais detalhes** ficam a dificuldade, as habilidades e as etiquetas. Cada alteração sobe a revisão e fica na Auditoria. A questão que veio do banco aparece com a etiqueta **Do banco**; é por ela que o banco conta os usos e os acertos.

**Arquivar e excluir.** **Arquivar** tira a questão da lista sem apagar (ligue **Mostrar arquivadas** e use **Desarquivar** para trazer de volta). **Excluir** apaga de vez e pede confirmação.

**Importar.** No banco, **Importar** traz questões de um arquivo **GIFT** (o formato de texto do Moodle: no Moodle, use Banco de questões > Exportar > Formato GIFT; também é o que outro IClass exporta) ou de uma **planilha CSV** (no Excel, use **Salvar como** e escolha **CSV UTF-8 (separado por vírgulas)**; o arquivo .xlsx não é aceito). Escolha o arquivo ou cole o texto e toque em **Ver prévia**: nada entra no banco antes disso. A prévia mostra quantas questões estão prontas, as que têm erro (com a linha do arquivo, por exemplo "Linha 12: Marque exatamente uma alternativa correta.") e as repetidas, que já estão no banco ou aparecem duas vezes no arquivo. As repetidas ficam de fora, a não ser que você ligue **Importar também as repetidas**. As questões com erro ficam de fora; corrija o arquivo e importe de novo só elas. A questão sem categoria entra na categoria que você escrever (ou em **Geral**). O limite é de 2 MB e 2.000 questões por arquivo.

No GIFT, uma questão por bloco, com uma linha em branco entre elas: `{=certa ~errada}` é uma correta, `{~%50%A ~%50%B ~%-100%C}` várias corretas, `{T}` ou `{F}` verdadeiro ou falso, `{#3.5:0.1}` numérica (valor e tolerância), `{=resposta =outra}` resposta curta e `{}` dissertativa. Seta numa alternativa (`{=p->next ~p.next}`) é texto normal; a questão de associação do Moodle (só com `=` e `->`, sem `~`) não existe no IClass e aparece como erro. A questão do Moodle com duas certas em que o aluno marca uma (`{=80 =8080 ~21}`) vira **Várias corretas**, e a prévia avisa para você conferir. O texto informativo do Moodle (a "descrição", sem as chaves `{ }`) não existe no IClass e aparece como erro da linha; se a ideia era uma dissertativa, escreva `{}` no fim.

Na planilha, a primeira linha é o cabeçalho: **Enunciado** é obrigatória; as outras colunas são **Categoria**, **Tipo** (Uma correta, Várias corretas, Verdadeiro ou falso, Numérica, Resposta curta ou Dissertativa), **Alternativa A** a **Alternativa H**, **Correta** (B, ou A, C), **Pontos**, **Valor**, **Tolerância**, **Unidade**, **Respostas aceitas**, **Revisão**, **Resposta esperada**, **Rubrica** (Ideia: 2 | Clareza: 1), **Explicação**, **Dificuldade**, **Habilidades**, **Etiquetas** e **Pontuação parcial**. Listas são separadas por "|"; para um "|" dentro do item (como em `ls | grep txt`), escreva `\|` (`ls \| grep txt`), como a exportação faz. O jeito mais fácil de ter o modelo é exportar o banco em planilha.

**Exportar.** **Exportar** baixa as questões da lista, com os filtros de agora: em **GIFT**, para levar ao Moodle ou a outro IClass (pontos, dificuldade e rubrica vão juntos), ou em **planilha (CSV)**, que abre no Excel com os acentos. A imagem da questão não vai no arquivo, só o endereço dela: a tela avisa quantas questões têm imagem, o arquivo GIFT lista os nomes das imagens e, em outro computador, você envia cada imagem de novo pelo editor.

## Monitor {#monitor}

Acompanha a prova em andamento: quem entrou, quem está respondendo, quem saiu da tela e quem já entregou. Pelo Monitor você manda mensagem para um aluno ou para a turma, ajusta o tempo e encerra a aplicação. O botão **Endereço da sala** mostra o QR para quem ainda não entrou.

No botão **⋯** (Mais ações) da linha do aluno ficam as ações só dele:

- **Recolher prova**: entrega a prova agora, com as respostas que o servidor já salvou. Use quando o aluno precisa sair ou quando a prova dele tem de terminar antes da turma. O motivo é opcional.
- **Reabrir prova**: a entrega volta para a mesma tentativa, com as respostas e o tempo que faltava quando ela foi entregue. Não conta como tentativa nova. Só funciona com a prova em andamento e a nota ainda não publicada, e o motivo é obrigatório (fica no registro da aplicação). Entrega feita antes desta versão do IClass não pode ser reaberta: dê uma tentativa extra.
- **Dar tentativa extra**: o aluno ganha mais tentativas nesta aplicação (até 5 no total). As entregas que ele já fez continuam valendo.
- **Anular tentativa**: para cola ou outra quebra das regras. Escolha **Fica zero (recomendado)**, e a tentativa conta na nota com zero, ou **Não conta**, como se o aluno não tivesse feito. O motivo é obrigatório e fica na Auditoria. Se a prova ainda está em andamento, ela é recolhida antes, com as respostas salvas. A nota não é apagada: **Desfazer anulação** (também com motivo) devolve a nota de antes. Funciona também depois de encerrar a aplicação. A tentativa anulada não volta para a prova pelo **Reabrir** nem pelo **+N min** da turma: desfaça a anulação antes. Precisa da permissão de Resultados: o Professor auxiliar não vê estas duas opções.

**Outro aparelho e troca de rede.** Se o aluno entra com a mesma conta em outro aparelho no meio da prova, a linha dele mostra **Entrou de outro aparelho às 10:42** e, se a aplicação foi preparada com **Travar até eu liberar** (o padrão, em **Outro aparelho no meio da prova**), a prova fica **Bloqueado** até você clicar em **Foco**. Entrar de novo com a prova aberta também conta, mesmo no mesmo computador (outro navegador, janela anônima): quando o computador do aluno travou e ele passou para outro, é só liberar em **Foco**. Com **Só avisar no Monitor**, a prova continua no aparelho novo. Sair da conta com a prova em andamento e entrar de novo conta do mesmo jeito. O IP e o navegador de antes e de agora aparecem ao passar o mouse no selo, no painel do aluno (o botão do teclado na linha, quando o registro do teclado está ligado; conta em **Entradas em outro aparelho**) e no **Registro da aplicação**, em **Resultados**. **Mudou de IP** aparece quando o mesmo aparelho troca de rede (o celular que passa do Wi-Fi para os dados, por exemplo): a prova não trava. **Mesmo IP de Fulano** aparece quando 2 ou 3 alunos estão no mesmo endereço de rede numa sala em que os outros têm endereços diferentes: confira se não estão no mesmo aparelho. Se a rede da escola mostra o mesmo endereço para todos, o Monitor avisa e não marca ninguém.

Em **Tempo**, os botões −5, +5 e +10 preenchem os minutos, e o motivo é opcional. Em **Msg** e **Aviso turma** há avisos prontos, e a janela mostra para quem a mensagem vai.

**Prova agendada.** No topo do Monitor, **Abre sozinha em 20/11 às 08:00** mostra o horário, com **Mudar horário** e **Cancelar agendamento** (a aplicação continua preparada). Para começar antes, inicie como sempre: ela fecha sozinha no horário marcado do mesmo jeito. Depois de aberta, **Fecha sozinha em ...** mostra a hora do fechamento, que anda junto com as pausas e com os minutos dados à turma (**+N min**). **Não encerrar sozinha** tira o fechamento automático: aí você encerra pelo Monitor. Quem estava fazendo a prova no fechamento aparece com **Entregue no horário de fechar da agenda, com as respostas salvas** (também em **Resultados**).

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

**Quando o aluno sai da escola.** Em **Cadastros encerrados**, **Anonimizar** guarda as entregas com um código no lugar do nome (a situação, as datas, o atraso e a nota ficam; o texto, o link, o seu comentário e o nome dos arquivos saem) e **Apagar de vez** tira as entregas. Nos dois casos, os arquivos vão para a lixeira de arquivos em **Sistema**, que só o administrador vê; na correção, o arquivo aparece como "tirado da entrega quando o cadastro do aluno foi anonimizado". O seu comentário, a observação da entrega em mãos e o motivo da prorrogação saem também da Auditoria. Ao arquivar um curso em **Turmas**, as tarefas e as entregas vão junto para o pacote do curso e voltam quando ele é restaurado.

**Cópia dos arquivos enviados.** Os arquivos dos alunos não entram no arquivo de backup: o backup de todo dia os copia para a pasta "entregas" do pendrive ou HD externo escolhido em **Sistema**, só o que é novo. O cartão **Armazenamento** mostra quantos ainda não têm cópia e quando foi a última; se o computador for trocado, o administrador liga o mesmo pendrive ou HD no computador novo, escolhe-o como destino no cartão **Backup** e usa **Trazer arquivos do destino externo** para trazê-los de volta (o IClass acha a pasta que o computador de antes deixou lá). Se um arquivo deste computador deixar de conferir com o que o aluno enviou (disco com defeito, vírus), a cópia do pendrive não é trocada por ele: o cartão mostra "Diferentes do registro" e **Trazer arquivos do destino externo** põe a cópia boa no lugar (o arquivo estragado vai para a lixeira). Restaurar um backup antigo não apaga os arquivos, mas tira as entregas feitas depois dele (a prévia avisa).

## Resultados {#resultados}

Mostra as entregas das provas da turma, aluno por aluno, com as notas. Daqui você abre a prova de cada aluno, confere as respostas e libera as notas.

<!-- P2 escreve aqui: quadro de notas, plano de avaliação, média, etapas, situação e boletim. -->

No alto, **Média geral** é a média das médias dos alunos da turma (a mesma do quadro de notas) e **Aprovação** diz quantos alunos passam: com os critérios de avaliação do curso, os aprovados entre os que já têm a situação fechada; sem eles, os alunos com média a partir da média mínima. Com o filtro de uma prova ou de uma aplicação, as duas contas valem só para ela.

### Quadro de notas

A aba **Quadro de notas** mostra uma linha por aluno e uma coluna por prova ou avaliação da turma. Com os critérios de avaliação do curso ligados (veja "Cursos e turmas"), as colunas ficam agrupadas por etapa ("1º bimestre · peso 1"), cada etapa tem a **Média da etapa** (com "(rec.)" quando a recuperação mudou a nota) e, no fim, vêm a **Média final**, a **Frequência**, a **Situação** (Aprovado, Em recuperação, Reprovado por nota, Reprovado por falta, Cursando ou Sem notas) e a **Menção**, se o curso usa menções. A cor de cada nota e das médias segue a média mínima do curso. Tudo é calculado pelo IClass com a mesma conta do boletim e da planilha exportada.

No celular, o quadro vira uma lista de alunos: toque no aluno para ver as notas de cada etapa.

### Plano de avaliação

A aba **Plano de avaliação** diz em que etapa e com que peso entra cada avaliação da turma:

- **Etapa** e **Peso**: o peso aceita vírgula (1,5).
- **Recuperação de**: marque quando a avaliação é a recuperação de uma etapa ou a recuperação final. A regra da recuperação é a dos critérios do curso.
- **Não conta**: a avaliação fica no quadro e sai da média (um simulado, por exemplo).

Clique em **Salvar plano** para gravar. Se a turma já tem nota publicada, o IClass pede o motivo, que fica na Auditoria. Se uma avaliação ficou sem etapa, o quadro avisa no alto.

**Nova avaliação da turma** cria um trabalho, uma prática, um seminário ou a participação: uma avaliação sem questões, com título, tipo, data, módulo, etapa e peso. Para lançar a nota, use **Lançar nota**: a avaliação aparece na lista com o tipo na frente ("Seminário - Seminário de redes") e você digita só a nota de 0 a 10, sem acertos nem cartão-resposta. A nota aparece para o aluno depois de publicada. **Arquivar** tira a avaliação da média e guarda as notas; **Reativar** devolve.

Com os critérios do curso desligados, a média é a de sempre (a média simples das notas), e etapa, peso e recuperação só passam a valer quando os critérios forem ligados.

### Boletim

O **Boletim (PDF)**, na página do aluno e na ficha dele, sai com o cabeçalho e o nome da escola. Ele mostra a média final, a situação e a menção, as notas por etapa, as avaliações de cada módulo, a frequência por disciplina (com a carga horária e as aulas previstas no período letivo) e os avisos da conta. Salve como PDF pela caixa de impressão do navegador.

## Correção de provas {#correcao}

<!-- P3 (A9 e A18) escreve aqui: correção manual, anular por cola, revisão pedida pelo aluno e corrigir gabarito. -->

Prova com questão dissertativa, ou com resposta curta e numérica em que você marcou "Mandar para mim quando a resposta não bater", fica **Aguardando correção** até você corrigir. Enquanto isso, a nota não entra na média, no boletim nem no quadro de notas, e **Liberar notas** deixa a entrega de fora. O aluno não vê nota parcial: para ele, a prova aparece como **Aguardando correção do professor**. Em **Precisa de você** e no aviso do alto de **Resultados** aparece quantas provas da turma esperam a sua correção; no quadro de notas, a célula mostra "aguardando correção".

A prova impressa lançada pelo cartão-resposta também espera a sua correção quando tem dissertativa (ou outra questão sem letra para marcar): a letra marcada vale nas questões de escolha, e as outras ficam com você.

Para corrigir, toque em **Corrigir provas** no aviso de **Resultados** (ou em **Corrigir**, na tentativa do aluno). A tela mostra uma entrega por vez, da mais antiga para a mais nova, com **Anterior** e **Próxima**; escolha a prova no filtro para corrigir uma só. Marque **Corrigir sem ver o nome** para ver "Aluno 1", "Aluno 2"... no lugar dos nomes (a escolha fica guardada neste navegador; o número de cada entrega não muda enquanto a tela está aberta). Com uma aplicação escolhida no filtro de Resultados, a tela mostra só as entregas dela, com **Ver todas** para voltar à turma inteira.

Em cada questão aparecem a resposta do aluno, a resposta esperada e a explicação. Lance os pontos (aceita vírgula: 1,5) ou os pontos de cada critério da rubrica, que somam os pontos da questão, e escreva, se quiser, um comentário para o aluno. No fim, há o comentário geral da prova. **Salvar** guarda sem concluir; **Concluir correção** pede os pontos de todas as questões que esperam você, recalcula a nota e mostra a nota antes e depois, com **Corrigir a próxima**. A nota só aparece para o aluno depois que você a liberar em Resultados.

Se você sair da tela (por outra entrega, pelo menu, pelo voltar do navegador ou fechando a aba) com pontos ou comentários ainda não salvos, o IClass pergunta antes de descartar.

Para mudar os pontos de uma questão que o sistema corrigiu pelo gabarito, toque em **Ajustar pontos** e informe o motivo (**Cancelar ajuste** volta à conta do sistema antes de salvar); para mudar uma nota já liberada, o IClass também pede o motivo. Se outra pessoa (ou outra aba sua) gravou a mesma correção enquanto você corrigia, o IClass avisa e oferece **Recarregar**: nada do que você digitou é gravado por cima. A Coordenação vê a correção, sem os campos.

Se você apagar os pontos de uma questão que espera você depois de concluir, a prova volta a **Aguardando correção** até você concluir de novo.

Com a nota liberada, o aluno vê a nota e o comentário geral. Os pontos de cada questão, a explicação, o comentário de cada questão e os pontos de cada critério da rubrica só aparecem quando o gabarito também é liberado (antes disso, os pontos de cada questão mostrariam quais ele acertou). A resposta esperada da dissertativa nunca vai para o aluno.

Para anular a tentativa de um aluno por cola, use **Anular tentativa** no Monitor (veja Monitor). Para corrigir uma resposta certa que estava errada no gabarito, use **Corrigir gabarito** em Provas, na aplicação anterior. Se a preparação da prova foi excluída de **Aplicações anteriores**, a aplicação aparece em **Aplicações online sem preparação salva**, com o mesmo botão.

## Materiais e liberação {#materiais}

<!-- P3 (A11) e P5 escrevem aqui: liberar unidades, agendamento de material e liberação por grupo. -->

**Liberar em um dia e horário.** Na apostila ou no gabarito ainda bloqueado, **Agendar** escolhe o dia e a hora (no relógio da escola) em que o item é liberado sozinho para a turma inteira. A linha mostra **Libera sozinho em ...**, com **Mudar** e **Cancelar**, e o aluno vê a liberação no **Calendário**. Ligar o interruptor antes libera na hora e tira o agendamento. O gabarito de uma prova que ainda está aberta no horário espera: a linha mostra **Adiado: sai quando a prova for encerrada** e ele é liberado logo depois do encerramento. Se o que segura o gabarito é uma aplicação preparada que não abriu, a linha diz isso: aplique e encerre a prova, ou bloqueie a prova em **Materiais** (a preparação é cancelada) para o gabarito sair. A prova online não é agendada aqui: use o **Quando** ao preparar a aplicação em **Provas**.

## Editor de conteúdo {#editor}

## Biblioteca {#biblioteca}

## Alunos {#alunos}

<!-- P4 escreve aqui: cadastro, matrícula, login por matrícula e aluno sem e-mail. -->

## Grupos {#grupos}

Grupo é uma parte da turma: uma equipe de trabalho ou uma subturma (a metade que vai ao laboratório, por exemplo). Abra em **Turmas** (botão **Grupos** na turma) ou em **Alunos** (botão **Grupos** no topo).

**Conjuntos.** Cada grupo pertence a um conjunto, que junta as divisões de uma mesma atividade: "Projeto integrador" com as equipes 1, 2 e 3; "Laboratório" com as subturmas A e B. O aluno fica em **no máximo um grupo de cada conjunto**, mas pode estar ao mesmo tempo numa equipe do projeto e numa subturma do laboratório. Abaixo do nome do conjunto aparece quem ainda está **sem grupo** nele.

**Criar.** Toque em **Novo grupo**, escreva o nome, o conjunto (escolha um que já existe ou escreva um novo) e o tipo (**Equipe** ou **Subturma**), e marque os alunos. Quem já está em outro grupo do mesmo conjunto aparece com "Em Equipe 1" e não pode ser marcado aqui.

**Editar.** Em **Editar**, mude o nome, o conjunto, o tipo e quem está no grupo. Marcar um aluno que está em outro grupo do conjunto mostra "Sai de Equipe 2": ao salvar, ele sai de lá e entra neste. Aluno que saiu da turma (transferido, desligado) continua no grupo com a etiqueta **Saiu da turma**, sem contar no total; desmarque para tirar. Se outra pessoa mudou o mesmo grupo enquanto você editava, o IClass avisa, atualiza a lista e você salva de novo.

**Sortear.** **Sortear grupos** divide a turma (só os alunos ativos) pela **quantidade de grupos** ou pelo **número de alunos por grupo**; os tamanhos diferem no máximo em um aluno. Escolha o conjunto e, se quiser, o começo do nome ("Grupo" vira Grupo 1, Grupo 2...). Nada é gravado até você conferir a proposta e tocar em **Criar estes grupos**; **Sortear de novo** faz outra divisão. Num conjunto que já tem grupos, o sorteio pega só quem está sem grupo nele (para sortear a turma toda de novo, use outro conjunto ou arquive os grupos antes). Se a turma mudou entre o sorteio e a confirmação, o IClass pede outro sorteio.

**Arquivar e reativar.** **Arquivar** tira o grupo da lista (o motivo é opcional e fica na Auditoria) e deixa os alunos livres para outro grupo do conjunto. **Mostrar arquivados** traz os arquivados de volta à tela, com **Reativar**; se algum aluno entrou em outro grupo do conjunto nesse meio-tempo, o IClass avisa e não reativa.

**O que o aluno vê.** Na **Início** do portal, o aluno vê o cartão **Meus grupos** com o nome dos grupos dele e dos colegas (só o nome; e-mail e telefone não aparecem). Criar, mudar, arquivar e sortear grupos ficam na **Auditoria**. A Coordenação vê os grupos sem poder mudar.

<!-- P5 (C19) escreve aqui: grupos em avisos, liberação e provas. -->

## Ver como aluno {#ver-como-aluno}

Mostra o portal do aluno exatamente como um aluno da turma o vê, sem criar um aluno de teste e sem sair do painel. Toque em **Ver como aluno**: na linha da turma em **Turmas**, no topo de **Materiais** (com a turma escolhida) ou no cartão da turma ao escolher a turma no **Dashboard**.

**Escolher o grupo.** O diálogo "Ver o portal como um aluno de 1DES" deixa escolher, se quiser, um grupo ativo da turma (**Ver como membro de um grupo**): a prévia mostra então o que um membro desse grupo vê, como o cartão **Meus grupos**. Sem grupo, você vê só o que a turma inteira vê. Não existe "ver como um aluno específico": liberações individuais e avisos particulares de um aluno não aparecem.

**Nada é gravado.** O portal abre na mesma aba com a faixa "Pré-visualização como aluno de 1DES · nada é gravado". Você lê apostilas, biblioteca, avisos, calendário, fórum e provas abertas, mas os botões que gravam (Concluir unidade, Salvar o caderno, anotações, Postar no fórum, Enviar dúvida, entregar tarefa, Nova mensagem, Alterar senha, Baixar meus dados) ficam desativados com o texto "Desativado na pré-visualização". Abrir a apostila não conta como acesso do aluno, abrir um aviso não o marca como lido e a presença não é registrada. **A prova não começa**: para ver as questões, use **Provas > Visualizar**.

**Sair.** **Sair da pré-visualização** (na faixa ou no Sair do menu do portal) fecha a prévia e volta para a tela do painel de onde você veio; o seu login no painel continua. A prévia dura 60 minutos e também termina quando você sai do painel, troca a senha ou perde o acesso à turma; nesses casos o IClass volta ao painel e avisa o motivo. Abrir uma tela do painel (pelo voltar do navegador, por exemplo) também fecha a prévia.

**Quem pode.** Quem cuida do conteúdo das turmas (Professor e Administrador) nas turmas dele. A Coordenação, que só consulta, não tem o botão.

## Chamada {#chamada}

Registra a presença por aula. Escolha a data, marque quem veio e salve. A presença também pode ser marcada sozinha quando o aluno entra no IClass, se a turma estiver configurada assim.

<!-- P4 (B11) escreve aqui: conteúdo das aulas e diário de classe. P5 (B19): avisar o responsável. -->

## Diário de classe {#diario}

<!-- P4 (B11 e B12) escreve aqui: diário, documento impresso e aulas previstas x dadas. -->

## Avisos {#avisos}

## Calendário {#calendario}

Mostra as aulas, provas, entregas e avisos do curso e os dias sem aula. Clique num dia para criar um evento; o aluno vê o evento no calendário dele.

**Dia não letivo** cadastra um feriado, recesso, ponto facultativo ou evento da escola. Para vários dias seguidos (o recesso de julho, por exemplo), preencha também "Até". Em "Para quem vale" aparecem só os alcances que a sua conta pode usar: o professor cadastra para a própria turma; o administrador e quem gerencia as turmas cadastram também para o curso, a escola ou a instituição inteira. Nesses dias:

- a Chamada avisa que não há aula e o Dashboard não cobra a chamada (se houve reposição, use "Fazer a chamada mesmo assim": ela conta normalmente);
- a presença automática de quem entrou no IClass não conta na frequência (o registro fica guardado e volta a contar se você excluir o dia);
- o aluno vê "Sem aula" no calendário e no Início.

Os dias do mês aparecem pintados e listados em "Feriados e recessos deste mês"; clique num deles para alterar ou excluir. O dia que vale para toda a instituição só o administrador ou quem gerencia as turmas altera.

**Feriados nacionais de 2027** (o ano do mês que está na tela) traz de uma vez os feriados nacionais do ano, calculados pelo próprio IClass, sem internet. Carnaval e Corpus Christi vêm como ponto facultativo: desmarque se a escola tem aula nesses dias. Feriados estaduais e municipais você cadastra em "Dia não letivo". Adicionar de novo não repete nenhum.

**Baixar agenda (.ics)** gera um arquivo com os eventos e os dias sem aula da turma para abrir no Google Agenda, no Outlook ou no celular. Importar de novo atualiza a agenda em vez de repetir os eventos.

No celular, o mês aparece como uma lista dos dias que têm evento.

## Fórum e dúvidas {#forum}

## Mensagens {#mensagens}

**Mensagens** (no menu, em Gestão dentro de uma turma, ou em Gestão acadêmica sem turma escolhida) é a conversa particular entre você e um aluno de uma das suas turmas. A turma não vê. Para dúvidas da matéria, o **Fórum** continua sendo o melhor lugar.

**A lista.** Mostra as suas conversas da turma escolhida no painel (sem turma escolhida, as de todas as suas turmas), da mais recente para a mais antiga, com o nome e a matrícula do aluno, o assunto e o selo **nova** quando o aluno escreveu e você ainda não leu. Filtre por **Abertas**, **Encerradas** ou **Todas**, troque, no seletor **Turmas** da própria tela Mensagens, para **Todas as minhas turmas** e busque pelo nome (sem precisar de acento). O item **Mensagens** do menu e o **sino** mostram quantas conversas têm mensagem nova.

**Começar.** O aluno pode começar a conversa pelo portal (ele escolhe entre os professores da turma) ou você toca em **Nova conversa**, escolhe a turma (já vem a do painel; dá para trocar por outra das suas turmas) e o aluno, escreve o assunto (opcional) e a mensagem. Se já existe uma conversa aberta com o mesmo aluno, a mensagem entra nela.

**Responder.** Toque na conversa, escreva no campo de baixo e toque em **Enviar** (ou **Ctrl+Enter**). Com a conversa aberta, as mensagens novas do aluno aparecem sozinhas. Só texto, até 2.000 caracteres; as mensagens **não podem ser apagadas** nem editadas.

**Encerrar e reabrir.** **Encerrar conversa** (o motivo é opcional e fica na Auditoria) deixa o aluno só lendo: ele não responde, mas pode começar outra. Você ainda pode escrever na encerrada. **Reabrir** devolve a conversa ao aluno. Durante uma prova, o aluno não consegue mandar mensagem (ele usa o botão da prova); você pode escrever, e ele lê depois.

**Aluno com o cadastro encerrado** (desligado ou anonimizado): a conversa fica só para consulta. Anonimizar o aluno tira o texto dele e o nome dele das suas mensagens.

**Não quer receber mensagens?** Em **Minha conta**, desligue **Receber mensagens de alunos**: os alunos deixam de ver você na lista para começar conversa nova. As conversas que já existem continuam.

**Quem lê.** Você e o aluno da conversa. **O administrador da escola pode ler estas mensagens** (decisão da escola), e as duas telas mostram esse aviso. Para o administrador: na tela **Mensagens**, no seletor **Turmas** acima da lista (não é a tela Turmas do menu), escolha **Todas da escola**; as conversas de outros professores aparecem sem o assunto, e abrir uma delas pede **Ler como administrador**, que fica registrado na **Auditoria** (uma vez por dia e conversa). Lendo a conversa de outra pessoa, o administrador não responde nem encerra.

## Responsáveis {#responsaveis}

<!-- P5 (B19 e B20) escreve aqui: aviso de faltas, registro do contato e comunicado impresso. -->

## Relatórios {#relatorios}

<!-- P4 (B13 e B14) escreve aqui: relatórios, impressão e boletins em lote. -->

## Cursos e turmas {#turmas}

Lista os cursos da instituição e as turmas de cada um. Daqui você cria turmas e abre ou fecha o autocadastro dos alunos em cada uma.

**Impressão da apostila.** Em **Novo curso** e **Editar**, a chave **Alunos podem imprimir ou salvar a apostila em PDF** vem ligada (também nos cursos que já existiam). Ligada, o aluno tem o botão **Imprimir ou salvar em PDF** na apostila aberta: sai só o texto da unidade, com o nome da escola e "Material de uso dos alunos de <curso>" no rodapé, sem o menu, o caderno nem o fórum. Desligue se o material do curso não pode sair da escola: o botão some e quem tentar imprimir a página pelo navegador recebe só "Impressão desativada pela escola.". A mudança fica na Auditoria. Isso não impede uma foto da tela; é um aviso claro de que o material é da escola. O curso duplicado leva a mesma escolha.

<!-- P2 (B6, B8, B10) escreve aqui: critérios de avaliação, disciplinas, período letivo e encerrar turma. -->

**Levar um curso para outro IClass.** Escolha o curso e clique em **Exportar curso**. O IClass baixa um arquivo `.iclass-curso.zip` com a estrutura (módulos e unidades), as apostilas com as imagens, as avaliações, os arquivos anexados às unidades, os itens da Biblioteca do curso, as questões do banco usadas nas provas, as disciplinas, as grades de horário e o nome das turmas como modelo. O pacote não leva alunos, notas nem presença. O arquivo tem as provas e os gabaritos: guarde como guardaria a prova impressa (não mande por grupo de mensagens nem deixe num computador da sala).

**Trazer um curso de outro IClass.** Clique em **Importar curso** e escolha o arquivo `.iclass-curso.zip`. Antes de gravar, o IClass confere o arquivo e mostra o que vai entrar: quantos módulos, apostilas, avaliações, arquivos e questões. Se já existe um curso com o mesmo código, a tela avisa ("Já existe um curso FUTEC: será importado como FUTEC2") e você pode trocar o código e o nome. Escolha também a escola. Apostilas, avaliações e arquivos com o nome de um que já existe aqui ganham o código do curso no fim, para não misturar com os daqui, e as apostilas são ajustadas para continuar mostrando as imagens. Marque **Criar as turmas modelo** para já ter as turmas, vazias, com os horários do curso de origem; os alunos se cadastram depois. Se aqui já houver alunos com uma turma de mesmo nome gravada só pelo nome (cadastros antigos), essa turma não é criada, porque eles entrariam nela: a prévia avisa, e você cria a turma depois com outro nome em **Nova turma**.

A importação é tudo ou nada: se o arquivo estiver corrompido, for alterado depois da prévia ou tiver algo que não é de um curso (um programa, um backup do IClass, um caminho para fora das pastas do pacote), nada é gravado e a tela diz o motivo. Uma prova do pacote com questão que o editor não aceitaria (tipo desconhecido, sem enunciado) também recusa o pacote, com o número da questão. Pacote feito por uma versão mais nova do IClass só entra depois de atualizar este. A prévia também avisa quando uma avaliação da estrutura não existia no computador de origem (a unidade chega sem as questões) e quando o pacote traz um arquivo que nenhuma apostila, avaliação ou item da Biblioteca usa (esse arquivo não é gravado). Exportar e importar ficam na Auditoria.

**Critérios de avaliação** (botão do curso) define como a média final e a situação do aluno são calculadas em todas as turmas do curso:

1. Ligue **Usar critérios de avaliação neste curso**.
2. Informe a **média mínima** (de 0 a 10, com vírgula) e a **frequência mínima** (%).
3. Monte as **etapas** (de 1 a 6, por exemplo dois bimestres), cada uma com o nome e o peso.
4. Escolha a regra da **recuperação de cada etapa** e da **recuperação final**. Embaixo de cada regra aparece um exemplo.
5. Se a escola usa conceitos, ligue as **menções** (MB, B, R, I) e ajuste a nota a partir da qual cada uma vale. A mais baixa começa em 0,0.
6. Clique em **Salvar critérios**. Antes de gravar, o IClass mostra a prévia: quantos alunos mudam de média ou de situação, e quem. Confira e clique em **Salvar critérios** de novo para gravar. O botão **Ver prévia** mostra a prévia sem salvar.

Se o curso já tem nota publicada, o IClass pede o motivo, que fica na Auditoria. Desligar os critérios volta à média de sempre e guarda os valores para quando você ligar de novo. Só quem gerencia cursos altera os critérios; o professor e a Coordenação veem os critérios sem alterar. A etapa e o peso de cada avaliação ficam no **Plano de avaliação**, em Resultados.

No formulário da turma, **Turno** é Manhã, Tarde ou Noite, e **Período letivo** liga a turma ao semestre ou ano letivo (veja "Período letivo", abaixo). Cada turma mostra o período dela ou o selo "Sem período letivo".

**Disciplinas** (botão do curso) lista as disciplinas usadas na grade horária. Em cada uma você informa:

- a **carga horária** em horas (deixe em branco se não souber; apagar o número apaga o valor);
- o **professor responsável** (só informativo: não muda quem acessa a turma);
- os **módulos do curso** que são dela. Cada módulo fica em uma disciplina só: o módulo que já está em outra aparece travado, com o nome dela. Assim o boletim liga a frequência, que é por disciplina, às notas, que são por módulo.

## Período letivo {#periodo-letivo}

<!-- P2 (B5 e B8) escreve aqui: períodos, etapas e carga horária. -->

Em **Cursos e turmas**, a seção **Períodos letivos** guarda o semestre ou o ano letivo (por exemplo, "2027 · 1º semestre"), com o início, o fim e as etapas (bimestres, trimestres). O período vale para toda a instituição ou para uma escola.

1. Clique em **Novo período letivo**, dê o nome e preencha o início e o fim.
2. Em **Dividir o período em**, escolha quantas etapas (o IClass já sugere o número de etapas dos critérios de avaliação do curso escolhido) e clique em **Sugerir datas das etapas**. As etapas saem em partes iguais; ajuste as datas se houver recesso. As etapas são opcionais.
3. Salve. Se uma data estiver errada (etapa fora do período ou cruzada com a anterior), o IClass mostra o aviso no campo.
4. Ligue cada turma ao período em **Editar** da turma, no campo **Período letivo**.

Com a turma ligada, fora das datas do período a Chamada avisa que não há aula e o Dashboard não cobra a chamada. A turma sem período continua como sempre: todo dia da grade tem aula. Nenhuma turma é ligada sozinha.

**Encerrar** o período não encerra as turmas nem muda nota ou chamada: o período só deixa de receber turma nova e de mudar as datas. **Reabrir** pede o motivo, que fica na Auditoria.

Na ficha do aluno, a "Evolução das notas" passa a filtrar pelo período letivo; as notas de antes do período (ou de turma sem período) continuam pelo semestre ("2026.2").

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
