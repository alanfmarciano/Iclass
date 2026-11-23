# Instalação e rede

Para quem instala e cuida do computador do IClass na escola (o professor ou o técnico de TI).

<!--
Regras para escrever aqui (contrato C4 do P6, fase 3): este é o guia do técnico. O release
gera o "Guia de instalação.html" a partir deste arquivo (P6-S9). Escreva debaixo do título do
seu tema, sem mudar títulos nem âncoras, e não crie arquivo novo nesta pasta.
-->

## Como o IClass funciona na sala {#como-funciona}

O IClass roda num computador da escola (normalmente o do professor). Os alunos entram pelo navegador, no celular ou no computador, pela rede Wi-Fi da sala. Não precisa de internet: tudo fica neste computador.

## Rede e firewall {#rede-e-firewall}

Para os aparelhos dos alunos chegarem ao IClass:

- o computador do IClass e os aparelhos precisam estar na **mesma rede** (a mesma Wi-Fi ou a rede cabeada ligada a ela);
- o firewall do Windows precisa liberar a **porta TCP 3000** para o IClass, com a rede marcada como **Privada**;
- a Wi-Fi não pode ter o **isolamento de clientes** ligado (em algumas redes de visitantes ele vem ligado e um aparelho não enxerga o outro).

O endereço para os alunos e o QR code ficam em **Sistema > Rede** e em **Endereço da sala**.

## Instalar {#instalar}

1. Extraia o ZIP do IClass numa pasta qualquer (por exemplo, em Downloads). Não rode de dentro do ZIP.
2. Dê dois cliques em **Instalar IClass.cmd**. Se o Windows mostrar "O Windows protegeu o computador", clique em **Mais informações** e depois em **Executar assim mesmo**.
3. O instalador pergunta a pasta: **Enter** aceita **C:\IClass**. O programa fica em `C:\IClass\programa` e os dados em `C:\IClass\dados`, `C:\IClass\conteudo` e `C:\IClass\cursos-arquivados`.
4. Se o computador já tinha o IClass antigo (a pasta com o `ligarIclassV3.bat`), o instalador oferece **trazer os dados dele**. A pasta antiga fica como está: os dados são copiados, conferidos (o banco precisa abrir sem problemas) e só então entram na instalação nova. Se o IClass antigo estiver ligado, ele é desligado antes, a não ser que haja prova em andamento: aí nada é feito.
5. O Windows pede permissão de administrador uma vez, para liberar no firewall a porta do IClass (TCP 3000) e o nome na rede (UDP 5353), só nas redes **Privadas** e de domínio. Se você não permitir, o IClass instala do mesmo jeito, mas os alunos podem não conseguir entrar até alguém liberar a porta.
6. No fim, o instalador pergunta se o IClass deve **ligar junto com o Windows** (dá para mudar depois na opção **[9]** do menu) e abre o IClass.

Ficam um atalho **IClass** na Área de Trabalho e, no menu Iniciar, a pasta **IClass** com o IClass e **Desinstalar o IClass**. O IClass também aparece em **Configurações > Aplicativos**.

Para desinstalar: **Desinstalar o IClass** desliga o servidor, tira o programa, os atalhos e as regras do firewall. Os dados ficam na pasta, a não ser que você digite **APAGAR** quando ele perguntar. Instalando de novo na mesma pasta, o IClass continua com os dados que ficaram.

Durante uma prova, o IClass não deixa o computador dormir (a tela ainda pode apagar). Mesmo assim, deixe o notebook na tomada e com a tampa aberta.

## Atualizar e voltar de versão {#atualizar}

Para atualizar, extraia o ZIP da versão nova e dê dois cliques em **Instalar IClass.cmd**: ele acha a instalação e pergunta se pode atualizar. Com prova em andamento, nada é feito: atualize depois que ela terminar. Sem prova, o IClass é desligado, a versão nova é copiada ao lado da atual e o IClass liga de novo já na versão nova.

Na primeira vez que liga, a versão nova faz um **backup dos dados antes de atualizar** o formato deles (fica em **Sistema > Backup**, com o nome começando por `pre-atualizacao`). Se esse backup não der certo (por exemplo, sem espaço no disco), nada é alterado e o IClass não liga na versão nova. A janela do IClass oferece atualizar sem esse backup, só se você digitar **SIM** (aí não há como voltar para a versão anterior com os dados de antes).

A versão anterior fica guardada (o IClass guarda as duas últimas). Se a versão nova der problema, use a opção **[V] Voltar para a versão anterior** do menu do IClass:

- o IClass faz um backup de agora, com tudo o que foi feito até aqui;
- se a atualização mudou o formato dos dados, ele restaura o backup de antes da atualização. O que foi feito depois da atualização (notas, presença, provas) não fica nos dados restaurados, só no backup de agora;
- se a atualização não mudou os dados, ele só volta para a versão anterior, com os dados como estão;
- com prova em andamento, nada é feito.

Para ir de novo para a versão nova depois de voltar, rode o **Instalar IClass.cmd** dela outra vez.

## Backup {#backup}

Todo dia o IClass guarda no próprio computador um backup dos dados (contas, alunos, provas, notas, presença e configurações), sem os arquivos da Biblioteca. Em **Sistema > Backup**, escolha um destino fora do computador (pendrive, HD externo ou pasta de rede): a cópia que vai para lá é completa, com os arquivos da Biblioteca, e serve se o computador quebrar. O botão **Baixar completo (ZIP)** da mesma tela (só para o administrador) baixa na hora uma cópia com tudo.

## Nome na rede (iclass.local) {#nome-na-rede}

<!-- P6 (A21c) escreve aqui: nome fixo iclass.local por mDNS e a porta UDP 5353. -->
