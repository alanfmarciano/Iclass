# Novidades do IClass

O que mudou em cada versão, em português simples. O que já está pronto e ainda não saiu numa versão fica em "Não publicado".

## Não publicado

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
