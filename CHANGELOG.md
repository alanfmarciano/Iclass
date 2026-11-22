# Novidades do IClass

O que mudou em cada versão, em português simples. O que já está pronto e ainda não saiu numa versão fica em "Não publicado".

## Não publicado

### Editor de questões do professor
- Em Provas, "Editar conteúdo" e "Nova prova" têm os seis tipos de questão: Uma correta, Várias corretas, Verdadeiro ou falso, Numérica, Resposta curta e Dissertativa. Cada tipo mostra uma frase de exemplo e só os campos dele: a marca da correta (ou das corretas, com "Pontuação parcial" ou tudo ou nada), Verdadeiro ou Falso, o número certo com tolerância e unidade, as respostas aceitas, e na dissertativa a resposta esperada (só você vê) e a rubrica com os critérios e os pontos.
- Cada questão tem os seus pontos (de 0,1 a 100, com vírgula) e o topo do editor mostra o total da prova. Na dissertativa, a soma dos critérios da rubrica aparece ao lado e o botão "Usar ... como pontos" acerta a diferença.
- Na numérica e na resposta curta, "Mandar para mim quando a resposta não bater" deixa a resposta diferente para você corrigir, em vez de valer zero.
- O enunciado e a explicação têm uma barra com Negrito, Código, Tabela e Imagem (JPG, PNG, GIF ou WebP, enviada do computador ou do celular). Ao lado (no celular, na aba "Prévia") a questão aparece como o aluno vai ver, com o campo de resposta para testar e a resposta certa embaixo.
- Explicação da questão (o aluno vê com o gabarito liberado) e, em "Mais detalhes", dificuldade, habilidades e etiquetas.
- Trocar o tipo não apaga o que já foi escrito: voltar ao tipo de antes traz as alternativas e as respostas de volta. Antes de salvar, o editor mostra o que falta em cada questão ("Questão 2: informe o valor da resposta numérica.") e não envia a prova incompleta. Excluir uma questão já preenchida pergunta antes.
- A prévia da montagem mostra o tipo, os pontos e o Markdown de cada questão, a resposta certa da numérica e da resposta curta e o total de pontos. "Versões online" vai até 4, o máximo que o servidor guarda (antes a tela deixava pôr 5 e a quinta sumia).
- A prova impressa e o gabarito do professor saem com o cabeçalho da escola (nome e dados de Escolas / Instituições, logo da Identidade visual) em cada folha e o rodapé "Gerado por" com o nome da escola, a data e a hora.
- A prova impressa mostra os pontos de cada questão e o total quando eles não são todos 1, o Markdown (negrito, código, tabela e imagem), linha para a resposta numérica, duas linhas para a resposta curta e doze para a dissertativa. O verdadeiro ou falso é respondido no cartão-resposta (V ou F), como as outras questões de escolha. O cartão-resposta tem só as questões de escolha; numa prova com os tipos novos ou com pontos, cada questão tem só as letras dela, e a prova de antes continua de A a E. O gabarito pinta todas as corretas de "Várias corretas" e descreve o número com a tolerância, as respostas aceitas e, na dissertativa, a resposta esperada e a rubrica.
- Verdadeiro ou falso nunca embaralha: Verdadeiro vem sempre antes de Falso, na prova online e na impressa.
- "Salvar no banco" vale para os seis tipos de questão.

### Banco de questões com os tipos novos, metadados e estatística
- O banco de questões guarda os seis tipos, com pontos, gabarito, explicação, dificuldade, habilidades, etiquetas e categoria. Antes, pela tela, só as de "Uma correta" podiam ir para o banco.
- Em Provas, o botão "Ver banco de questões" abre o banco também fora do editor. A lista filtra por busca (sem acento), categoria, tipo, dificuldade e etiqueta, e cada questão mostra o tipo, a dificuldade, a resposta, as etiquetas, em quantas aplicações foi usada e o % de acerto (só das entregas consideradas das suas turmas). A prova impressa conta também: as respostas lançadas pelo cartão-resposta entram no % de acerto.
- "Editar" e "Nova questão" usam o mesmo cartão do editor da prova. Cada alteração sobe a revisão e fica na Auditoria; salvar sem mudar nada não grava.
- "Arquivar" tira a questão da lista sem apagar; "Mostrar arquivadas" mostra de novo e "Desarquivar" devolve. "Excluir" pergunta antes.
- A questão adicionada do banco aparece com a etiqueta "Do banco" e não é salva no banco de novo. Se você muda o enunciado ou o gabarito dela na prova, ela vira uma questão da prova: a etiqueta sai, "Salvar no banco" volta a funcionar e os usos e acertos dela não contam mais para a questão do banco (desfazer a mudança religa). Na troca de questão do Monitor, a nova questão vem com o tipo, os pontos e o gabarito dela, e a lista mostra o tipo e a resposta.
- O professor vê, altera, arquiva e exclui as questões do banco que vieram das avaliações dele e as do acervo comum (criadas por "Nova questão", sem prova de origem), que todo professor vê e pode alterar. As que vieram de avaliação de outro professor ele não vê.

### Prova do aluno com os tipos novos de questão
- Na prova, cada tipo de questão tem o seu campo: verdadeiro ou falso em dois botões grandes, "Marque todas as corretas." com caixas de marcar, número com o teclado numérico do celular (aceita vírgula) e a unidade ao lado, resposta curta numa linha e dissertativa numa área que cresce, com o contador "1.230 de 10.000". Cada questão mostra quanto vale ("2 pontos").
- Na prova, o enunciado e as alternativas aceitam Markdown: negrito, listas, bloco de código, tabela e imagem. O texto digitado em várias linhas não vira mais uma linha só. No celular, a tabela e o código rolam dentro do próprio quadro, e a página não rola para o lado. Tocar na imagem abre a imagem grande.
- O texto das questões de programação e de conta aparece como foi escrito: "<p>", "<br>" e "Lista<String>" mostram esses sinais, "2*3*4" não perde os asteriscos, "__init__" não vira negrito, a barra invertida de "\d+\.\d+" ou de "\"" fica e "~x" não risca o texto. Na questão, itálico e negrito são com asterisco ("*itálico*", "**negrito**").
- A alternativa que é um sinal ou começa com um ("+", "-", "*", ">=", "#", "- 1", "1984.") aparece como foi escrita. Antes do ajuste, ela podia aparecer vazia ou, no caso de ">=", só com "=".
- A imagem da questão só aparece para o aluno enquanto a prova dele está aberta. Antes do início, com a aplicação pausada, depois da entrega e para outra turma, ela não abre. (A revisão da prova com imagem e explicação chega numa próxima versão.)
- Na prova, os links do enunciado aparecem como texto: tocar num link levaria o aluno para fora da prova.
- Ao enviar, a janela diz quais questões estão em branco ("As questões 2 e 5 estão em branco."). Apagar a resposta faz a questão voltar a contar como em branco.
- Com questão dissertativa, a tela final mostra uma frase só, "Sua prova foi entregue. As dissertativas serão corrigidas.", sem nota parcial e sem repetir que a nota sai depois.
- Desfazer, selecionar tudo e apagar com o teclado (Ctrl+Z, Ctrl+A) dentro das respostas escritas não entram mais no registro de atalhos suspeitos.
- No celular, tocar e segurar dentro da resposta escrita (para mover o cursor ou selecionar uma palavra) funciona e não aparece mais no Monitor como "menu do botão direito". No computador, o botão direito do mouse continua bloqueado e registrado em toda a prova, inclusive na resposta escrita. Copiar continua bloqueado, e colar na resposta, pelo teclado ou pelo menu do toque, aparece no Monitor como "Colou conteúdo".

### Segunda chamada e exceção por aluno
- Em Provas, o cartão "Para quem" escolhe se a aplicação é para a turma inteira, para a segunda chamada ou só para alguns alunos ("Escolher alunos"). Na segunda chamada, a lista já vem marcada com quem ainda não fez a prova regular, e quem já fez aparece com "Já fez". Numa nova segunda chamada, quem entregou a anterior aparece com "Fez a segunda chamada".
- Quem não está na lista não vê a prova e não consegue começar; quem já tinha começado continua vendo a própria tentativa. O Monitor e o Dashboard contam só os alunos da lista.
- O botão "Alunos desta aplicação" muda a lista depois de preparar, enquanto a aplicação não terminar. "Aplicar prova novamente" também pergunta para quem é.
- Exceção por aluno: até 5 tentativas extras e, com o cronômetro "Quando cada aluno iniciar", um prazo "Pode começar até" só para aquele aluno, com motivo. Cada mudança fica na Auditoria.
- O aluno com exceção vê o próprio limite ("Tentativa 1 de 2") no cartão da prova e, nas instruções, o limite e o prazo "Pode começar até". Quem começou antes do prazo continua a prova depois dele, sem aviso de prazo terminado. Na segunda chamada, quem já fez a prova do curso conta como feito também na versão "só desta turma".

### Ações por aluno no Monitor
- Na linha de cada aluno, o botão "⋯" (Mais ações) traz "Recolher prova" (entrega na hora, com as respostas já salvas), "Reabrir prova" (a entrega volta para a mesma tentativa, com as respostas e o tempo que faltava, sem contar como tentativa nova; pede o motivo) e "Dar tentativa extra" (até 5, só para aluno ativo). Tudo fica na Auditoria e no registro da aplicação. O menu abre junto do botão mesmo com a página rolada, no computador e no celular.
- O aluno vê "Prova recolhida pelo professor" quando a prova é recolhida e "O professor reabriu a sua prova" quando ela volta. No Monitor e em Resultados, a entrega aparece como "Recolhida pelo professor" ou "Reaberta pelo professor".
- A mensagem tem avisos prontos ("Faltam 10 minutos", "Confira se respondeu todas" e "Levante a mão se precisar de ajuda"), aceita várias linhas e mostra para quem vai. O ajuste de tempo tem os botões −5, +5 e +10 e um motivo opcional, que fica no registro mesmo quando o aluno ainda não começou. A versão da prova só oferece as versões que a aplicação tem. Liberar notas diz quantas notas vão para os alunos e quantas, aguardando correção, ficam de fora.
- O token da prova aparece de novo no Monitor de outro computador, no projetor ou depois de fechar a aba: "Mostrar token" traz o mesmo token, sem trocar. Em aplicação preparada antes desta versão (ou vinda de um backup de outro computador), o Monitor explica e oferece "Gerar outro".
- As configurações salvas da prova não guardam mais o token em texto: ao atualizar, o IClass tira os tokens que estavam lá.
- Em Resultados, lançar o cartão-resposta com questões em branco pergunta numa janela do IClass, em vez da caixa do navegador.

### Versão, Novidades e Ajuda
- O rodapé do menu mostra a versão de verdade do IClass (por exemplo, "v3.0.0") e se a tela está falando com o servidor: "Conectado", "Sem conexão" ou "Servidor reiniciando". Antes ficava "Sistema ativo" e "v3", mesmo com o servidor fora do ar.
- Na tela Sistema, o cartão novo "Sobre o IClass" mostra a versão instalada, a última atualização (com o nome do backup feito antes dela), a versão dos dados, o código desta instalação e o botão "Novidades", que abre esta lista.
- Agora há Ajuda dentro do IClass: item "Ajuda" no menu do professor e do aluno, com o manual separado por tela e busca sem acento. Em Provas, Monitor e Sistema, o botão "?" ao lado do título abre a parte da ajuda sobre aquela tela.
- No login, o link "Problemas para entrar?" abre a ajuda do aluno sem precisar entrar: como achar o endereço da sala, esqueci a senha, troca de senha e o que fazer se a conexão cair durante a prova.

### Busca e ordem das listas
- Agora dá para buscar sem acento e sem se preocupar com maiúsculas: "joao" acha "João" e "avaliacao" acha "Avaliação". Vale nas tabelas do painel, na Biblioteca, em Matrículas, na Chamada, no Fórum, em Provas (do professor e do aluno), em Avisos, em Cadastros encerrados, no Monitor, em Turmas, no seletor de curso e na Auditoria.
- A busca aceita mais de uma palavra, em qualquer ordem: "martins joão" acha "João Martins". Na Auditoria, as palavras podem estar em campos diferentes da mesma entrada.
- As listas saem em ordem alfabética do português: "Ângela" fica junto de "ana" e "Érica" antes de "Zélia", e "Turma 2" vem antes de "Turma 10".

### Confirmações na própria tela
- As perguntas antes de excluir ou alterar abrem uma janela do próprio IClass, que diz o que vai acontecer, em vez da caixa do navegador. Enquanto a pergunta está aberta, o Monitor continua se atualizando.
- No Monitor, a mensagem para o aluno ou para a turma, o ajuste de tempo, a versão da prova e a liberação das notas abrem essa janela. No ajuste de tempo, Cancelar não muda nada (antes virava um ajuste de 0 minutos), e o tempo vai de 30 minutos a menos a 120 a mais.
- Em Provas, salvar a prova para todas as turmas do curso mostra as turmas que vão mudar, e excluir questão do banco pergunta antes na mesma janela.
- Na Biblioteca, excluir um material em todas as turmas do curso pergunta antes; no Fórum, a edição da mensagem abre numa janela com o limite de 5.000 caracteres, e a lixeira se chama "Excluídas".
- Na Lixeira da tela Sistema, "Excluir" e "Esvaziar" também perguntam nessa janela, com o nome do item, em vez da caixa do navegador.

## 3.0.0 · 18/11/2026

A versão das fases 1 e 2, a que está hoje nos computadores das escolas.

- Prova mais segura e notas certas: uma aplicação por turma, com token, sala de espera, Monitor ao vivo, regra de foco, tempo devolvido quando o servidor cai e notas conferidas no servidor.
- Permissões por conta: o professor vê só as turmas dele, e cada ação importante fica na Auditoria.
- Dados protegidos: backup diário dos dados em ZIP, com prévia antes de restaurar e cópia completa (com os arquivos da Biblioteca) num destino externo (pendrive ou HD).
- Senhas com regras e troca obrigatória da senha temporária, atraso depois de senhas erradas e conexão segura (https) com o guia do certificado.
- Endereço da sala com QR code, Termos de Uso e Política de Privacidade da escola, Meus dados para o aluno e desligar ou anonimizar o cadastro de quem saiu.
