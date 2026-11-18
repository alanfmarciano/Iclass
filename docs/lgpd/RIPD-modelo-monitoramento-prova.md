# Modelo de RIPD: monitoramento da prova online no IClass

> **Modelo de referência; não substitui orientação jurídica.** Este é um ponto de partida para o Relatório de Impacto à Proteção de Dados Pessoais (RIPD, art. 5º, XVII, e art. 38 da LGPD) do monitoramento das provas feitas no IClass. Preencha os campos entre colchetes, apague o que não se aplica à escola, revise com a direção e com o encarregado (DPO) e, se possível, com um advogado. Guarde a versão assinada fora do IClass.
>
> As descrições técnicas abaixo valem para o IClass V3 a partir da fase 2 (registro do teclado por aplicação e retenção dos registros técnicos). Se a escola mudar uma configuração citada aqui (o modo do teclado, os prazos de retenção, o acesso ao painel em outros aparelhos), atualize o relatório.

## 1. Identificação

| Campo | Preencher |
|---|---|
| Controlador (escola) | [razão social, CNPJ, endereço] |
| Encarregado (DPO) | [nome e contato; o mesmo de Instituição → Privacidade (LGPD) → Controlador e encarregado] |
| Responsável pelo IClass na escola | [nome e função; quem é administrador do IClass] |
| Operadores | Nenhum, na instalação padrão: o IClass roda no computador da escola, sem serviço de nuvem. [Se a escola usar outro serviço (cópia em nuvem, pasta sincronizada), descreva aqui.] |
| Data e versão deste relatório | [dd/mm/aaaa, versão 1] |
| Revisão prevista | [a cada ano letivo, ou quando mudar o modo do teclado ou os prazos de retenção] |

## 2. O que é o tratamento

Durante a prova online, o IClass registra sinais que ajudam o professor a acompanhar a aplicação e a rever uma prova contestada. O tratamento acontece só enquanto o aluno está na tela da prova.

### 2.1 Dados tratados

| Dado | Quando | Onde fica |
|---|---|---|
| Identificação do aluno (nome, e-mail, turma) | Cadastro, já existente | Banco do IClass (`students`) |
| Saídas da tela e da tela cheia (troca de aba, janela minimizada, saída da tela cheia), com data e hora e um detalhe curto | Sempre, em todos os modos | `proctoringLogs` (tabela `proctoring_logs`) |
| Teclado: conforme o modo escolhido ao preparar a aplicação (seção 2.2) | Durante a prova | `exam_keystroke_events` (tecla, código, modificadores, tipo, se foi bloqueada, hora do aparelho e do servidor) |
| Respostas e entrega da prova | Durante a prova | `submissions`, estado da tentativa |
| Registros de acesso (login): e-mail, data e hora, IP, navegador, sistema e tipo de aparelho | A cada entrada no sistema | `loginLogs` |
| Auditoria das ações do professor e do administrador | Sempre | `auditLogs` |

Não são coletados: imagem da câmera, áudio, tela do aparelho, localização, conteúdo de outras abas ou programas.

### 2.2 Registro do teclado (escolhido por aplicação)

O professor escolhe ao preparar cada aplicação; depois de preparada, ela não muda de modo.

| Modo | O que guarda |
|---|---|
| **Só atalhos suspeitos** (padrão) | Copiar, colar, recortar, menu do botão direito, troca de janela (Alt+Tab, tecla Windows) e as tentativas de atalho que a prova bloqueia (imprimir, buscar, ferramentas do navegador). O que o aluno digita não é guardado. |
| Toda a digitação | Cada tecla da tela da prova. |
| Não registrar o teclado | Nenhuma tecla. |

Em todos os modos: o que o aluno escreve em "Reportar problema" nunca é registrado; os caracteres digitados com AltGr (teclado ABNT2) contam como digitação, não como atalho; o bloqueio de copiar, imprimir e buscar continua; as saídas da tela continuam registradas. O servidor confere o modo de novo antes de gravar, então um navegador com uma versão antiga da prova também segue a regra.

Aplicações preparadas antes desta versão valem como "Só atalhos suspeitos" daqui em diante, mas o que elas já tinham guardado é a digitação completa (o Monitor mostra a coluna como "Teclado"). [Se a escola quiser apagar esses registros antes do prazo, descreva aqui como e quando.]

### 2.3 Titulares

Alunos da escola, entre eles **crianças e adolescentes** (art. 14 da LGPD). [Informe as faixas de idade das turmas que fazem prova online.]

### 2.4 Quem acessa

| Perfil | Acesso |
|---|---|
| Professor | Só as turmas atribuídas a ele: Monitor (saídas da tela e teclado ao vivo) e revisão da aplicação. |
| Administrador | Todas as turmas; prazos de retenção, documentos de privacidade e auditoria. |
| Aluno | Vê, antes de iniciar, o que é registrado na prova e por quanto tempo. |

O painel do professor abre no computador da escola e, conforme Sistema → Rede, em outros aparelhos da rede (por https quando a escola liga a conexão segura). [Descreva a configuração da escola.]

## 3. Finalidade, necessidade e base legal

- **Finalidade:** garantir a integridade da avaliação e permitir rever uma prova contestada (por exemplo, saber se houve troca de janela ou colagem de texto).
- **Necessidade e proporcionalidade:** as provas do IClass são de múltipla escolha; o que o aluno digita não serve para corrigir nada. Por isso o padrão é guardar só os atalhos suspeitos. "Toda a digitação" só deve ser escolhida com motivo registrado. [Descreva quando a escola usa esse modo, se usa.]
- **Base legal:** [escolha e justifique com o jurídico da escola. Exemplos: escola pública, execução de políticas públicas e obrigação legal (art. 7º, II e III, e art. 23); escola particular, execução do contrato de prestação de serviços educacionais (art. 7º, V) ou legítimo interesse (art. 7º, IX, com teste de balanceamento e sem afastar o melhor interesse do aluno).]
- **Crianças e adolescentes:** o tratamento deve atender ao melhor interesse do aluno (art. 14). [Registre como a escola avalia isso; por exemplo, o modo padrão e o aviso nas instruções da prova.]

## 4. Transparência

- As instruções da prova dizem, antes de iniciar, o que é registrado naquela aplicação e por quanto tempo fica guardado (prazo de Sistema → Retenção; sem prazo, "até a escola apagá-los").
- Os Termos de Uso e a Política de Privacidade publicados em Instituição → Privacidade (LGPD) trazem os prazos pelos marcadores `{{prazo_monitoramento}}` e `{{prazo_acessos}}`. [Confirme que a versão publicada fala do monitoramento da prova.]
- [Descreva outros canais: reunião com responsáveis, contrato, regimento.]

## 5. Retenção e descarte

| Registro | Prazo na escola | Como é apagado |
|---|---|---|
| Teclas e saídas da tela | [N dias depois do encerramento da aplicação; mínimo do IClass: 30] | Sistema → Retenção; a limpeza roda uma vez por dia, só sem prova aberta, e entra na auditoria (`retention_purge`). |
| Registros de acesso | [N dias; mínimo do IClass: 180, Marco Civil da Internet, art. 15] | Idem. |
| Lixeira | [N dias] | Idem. |
| Cópias de segurança automáticas | 14 cópias (uma por dia), trocadas sozinhas | Um registro apagado pela retenção ainda fica nelas por até 14 dias. |

A retenção vem desligada: até o administrador salvar os prazos, teclas, saídas da tela e registros de acesso não são apagados. Cadastro do aluno, notas, entregas, frequência, auditoria, observações e mensagens nunca são apagados por prazo.

## 6. Medidas de segurança

- Dados no computador da escola (banco SQLite em `data/`), sem envio para a internet pelo IClass.
- Senhas guardadas com scrypt; sessões com prazo e revogação; bloqueio temporário depois de muitas senhas erradas.
- Permissões por perfil (professor só nas suas turmas; dados de privacidade só para o administrador) e auditoria das ações.
- Conexão segura (https com certificado próprio da escola) para o painel em outros aparelhos. [Informe se está ligada.]
- Cópias de segurança automáticas; baixar uma cópia pede a senha do administrador de novo.
- [Medidas da escola: acesso físico ao computador, conta do Windows com senha, antivírus, quem tem a senha de administrador do IClass.]

## 7. Riscos e medidas

Classifique cada risco por probabilidade e impacto (baixo, médio, alto) para a realidade da escola.

| Risco | Probabilidade | Impacto | Medidas | Risco que resta |
|---|---|---|---|---|
| Coleta além do necessário (digitação completa sem motivo) | [ ] | [ ] | Padrão "Só atalhos suspeitos"; escolha por aplicação; filtro também no servidor; "Reportar problema" nunca registrado. | [ ] |
| Conclusão errada de cola a partir de um sinal isolado (por exemplo, saída da tela por notificação do celular) | [ ] | [ ] | O registro é indício, não prova; o professor conversa com o aluno antes de decidir; [procedimento de contestação da escola]. | [ ] |
| Acesso indevido por outro professor ou pessoa na rede | [ ] | [ ] | Escopo por turma; https no painel; sessões revogáveis; auditoria. | [ ] |
| Guarda por tempo indefinido | [ ] | [ ] | Prazos em Sistema → Retenção; aviso enquanto não definidos. | [ ] |
| Perda ou vazamento do computador ou das cópias de segurança | [ ] | [ ] | [Medidas da escola]; cópias com senha para baixar. | [ ] |
| Dados de crianças e adolescentes | [ ] | [ ] | Melhor interesse; coleta mínima; aviso claro antes da prova; contato do encarregado. | [ ] |

## 8. Direitos dos titulares

- Pedidos de acesso, correção, informação e eliminação: [canal da escola e prazo de resposta]. O contato do encarregado aparece nos Termos e na Política publicados.
- [Descreva como a escola atende o pedido de um registro de monitoramento: quem consulta, como entrega ao aluno ou responsável.]

## 9. Parecer do encarregado e aprovação

| | |
|---|---|
| Parecer do encarregado | [texto] |
| Decisão da direção | [aprovado / aprovado com ajustes / não aprovado] |
| Assinaturas e data | [ ] |
