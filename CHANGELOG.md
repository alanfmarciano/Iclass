# Novidades do IClass

O que mudou em cada versão, em português simples. O que já está pronto e ainda não saiu numa versão fica em "Não publicado".

## Não publicado

### Minha conta e papéis no painel
- Novo: Minha conta. O avatar no topo do painel mostra as iniciais do seu nome e abre um menu com Minha conta e Sair. Em Minha conta você corrige o seu nome, troca a senha (com a senha atual) e usa "Sair dos outros aparelhos" para fechar a conta esquecida aberta em outro computador. (UXI-07)
- O administrador agora redefine a senha de outra conta do painel em Contas: o IClass gera uma senha temporária (mostrada uma vez, com Copiar) ou o administrador digita uma. A pessoa sai dos aparelhos onde estava conectada e escolhe uma senha nova no próximo acesso. (UXI-07)
- Na criação e na edição de contas, o papel é escolhido numa lista com a explicação de cada um: Administrador, Professor, Secretaria e Coordenação (só consulta). Secretaria e Coordenação recebem escolas; o professor, turmas. (FUN-13)
- O painel segue o que a conta pode fazer de verdade: Secretaria e Coordenação não aparecem mais como administrador no topo nem ganham botões de administrador (contas, sistema, lixeira, auditoria). A Secretaria abre Matrículas. (FUN-13)
- O Professor auxiliar (papel ainda escondido na criação de contas) não vê mais nota: a ficha do aluno, o Dashboard e o Monitor aparecem sem notas, sem boletim e sem "Ver respostas" para ele; no Dashboard, a média das provas aparece como "oculta". No Monitor ele escolhe a prova, inicia, pausa, retoma e encerra, sem os botões que mexem em nota (liberar nota, Analytics, corrigir e anular questão), e em Contestações > "Ver questão" vê o enunciado e as alternativas sem a marca do gabarito. O gabarito da prova também não chega mais a quem não prepara prova (Professor auxiliar, Secretaria e Coordenação) pela configuração da turma. (FUN-13)
- Cada tela mostra só as ações que a conta pode fazer: Novo aluno, Editar, Redefinir senha e as ações em lote do Diretório ficam com quem altera cadastro (não aparecem para a Coordenação nem para o Professor auxiliar). No Dashboard, o calendário, "Ver resultados" e as pendências de Resultados e do Fórum só aparecem para quem abre essas telas (antes a Secretaria via a seção "Não foi possível carregar"). Liberações, no menu do aluno, fica com quem libera conteúdo (antes aparecia para o Professor auxiliar, a Secretaria e a Coordenação e dava erro), e a Coordenação lê as observações sem o formulário de registrar. (FUN-13)
- Em Identidade (excluir tema) e Sistema (esvaziar a lixeira e excluir de vez), a pergunta abre na janela do IClass, e não na caixa do navegador.

### Notas com uma regra só
- As cores das notas (verde, amarelo e vermelho), a "Aprovação" de Resultados, a nota em vermelho do boletim impresso, o motivo "média abaixo de 6,0" do Dashboard e da ficha do aluno e os gráficos de distribuição seguem a mesma regra (a média do motivo aparece com uma casa, como "5,0"), pela média mínima de 6,0. A comparação é feita com a nota como ela aparece, e isso muda as bordas: de 5,95 a 5,99 (mostrado como 6,0) a nota conta como aprovada e sai da lista de risco, na análise da prova de 8,45 a 8,49 (mostrado 8,5) passa à faixa alta, e a ficha do aluno arredonda a média como o boletim. (ENG-02)
- "Distribuição de notas" em Resultados passa a ter uma barra por faixa da nota (0–3,9, 4–5,9, 6–6,9, 7–8,9 e 9–10, com as mesmas cores da lista); antes eram 0-4, 5-6, 7-8 e 9-10 sobre a nota sem arredondar, e um 4,96 (mostrado 5,0) contava em "0-4". No gráfico "Distribuição" das Provas do aluno, as faixas são as mesmas de antes, mas a nota conta como aparece no cartão (5,96 entra em "6–6,9"). (ENG-02)
- Resultados mostra sempre a nota da prova calculada pelo servidor (maior, última, média ou escolhida), sem refazer a conta na tela. (ENG-02)
- Provas antigas em Markdown aceitam a alternativa e) e o gabarito "E" (antes a e) ficava colada no texto da d)), e também alternativas em lista ("- a) texto") ou em negrito ("**a)** texto"). Letra depois de e) e questão com menos de duas alternativas ficam de fora com um aviso em Provas, que aparece toda vez que a prova é aberta até ela ser salva no editor, mesmo que ela tenha sido aberta antes em Resultados ou pelo aluno; nunca somem sem avisar. Prova já lida por uma versão anterior com a e) colada no texto da d) também avisa, para ser corrigida no editor. Uma prova gravada com conteúdo diferente do arquivo não mostra os avisos do arquivo. Um texto livre no gabarito ("Nota: a questão 2. O enunciado...") não apaga mais a letra da questão, e a alternativa "**a)** usa **ls**" mantém o negrito do fim. (ENG-02)
- Nota gravada só com espaços conta como nota vazia (antes valia 0). (ENG-02)

### Busca e ordem das listas
- Agora dá para buscar sem acento e sem se preocupar com maiúsculas: "joao" acha "João" e "avaliacao" acha "Avaliação". Vale nas tabelas do painel, na Biblioteca, em Matrículas, na Chamada, no Fórum, em Provas (do professor e do aluno), em Avisos, em Cadastros encerrados, no Monitor, em Turmas, no seletor de curso e na Auditoria.
- A busca aceita mais de uma palavra, em qualquer ordem: "martins joão" acha "João Martins". Na Auditoria, as palavras podem estar em campos diferentes da mesma entrada.
- As listas saem em ordem alfabética do português: "Ângela" fica junto de "ana" e "Érica" antes de "Zélia", e "Turma 2" vem antes de "Turma 10".

### Confirmações na própria tela
- As perguntas antes de excluir ou alterar abrem uma janela do próprio IClass, que diz o que vai acontecer, em vez da caixa do navegador. Enquanto a pergunta está aberta, o Monitor continua se atualizando.
- No Monitor, a mensagem para o aluno ou para a turma, o ajuste de tempo, a versão da prova e a liberação das notas abrem essa janela. No ajuste de tempo, Cancelar não muda nada (antes virava um ajuste de 0 minutos), e o tempo vai de 30 minutos a menos a 120 a mais.
- Em Provas, salvar a prova para todas as turmas do curso mostra as turmas que vão mudar, e excluir questão do banco pergunta antes na mesma janela.
- Na Biblioteca, excluir um material em todas as turmas do curso pergunta antes; no Fórum, a edição da mensagem abre numa janela com o limite de 5.000 caracteres, e a lixeira se chama "Excluídas".
