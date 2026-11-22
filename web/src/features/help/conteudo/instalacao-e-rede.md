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

<!-- P6 (A17) escreve aqui: instalador, pasta C:\IClass, atalhos e ligar com o Windows. -->

## Atualizar e voltar de versão {#atualizar}

<!-- P6 (A17) escreve aqui: atualizar, o backup antes da atualização e Voltar para a versão anterior. -->

## Backup {#backup}

Todo dia o IClass guarda no próprio computador um backup dos dados (contas, alunos, provas, notas, presença e configurações), sem os arquivos da Biblioteca. Em **Sistema > Backup**, escolha um destino fora do computador (pendrive, HD externo ou pasta de rede): a cópia que vai para lá é completa, com os arquivos da Biblioteca, e serve se o computador quebrar. O botão **Baixar completo (ZIP)** da mesma tela (só para o administrador) baixa na hora uma cópia com tudo.

## Nome na rede (iclass.local) {#nome-na-rede}

<!-- P6 (A21c) escreve aqui: nome fixo iclass.local por mDNS e a porta UDP 5353. -->
