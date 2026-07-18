# 📊 FUTEC 3: O Arsenal de Produtividade Corporativa

> **Carga Horária Estimada:** 16 Horas
> **Foco:** Lógica Estrutural de Planilhas Eletrônicas, Etiqueta/Governança de E-mail (SMTP/Exchange) e a Engenharia do Pitch em Apresentações.
> **Baseado nos Tópicos Oficiais do SENAI:** Tópico 4, Tópico 5 e Tópico 11.

Em uma indústria moderna, ter o melhor hardware da Missão 1 e a melhor rede da Missão 2 não gera lucro se o dado bruto não puder ser processado, comunicado de forma auditável e apresentado de forma convincente para atrair investidores. 

Esta missão abandona o uso amador do "Pacote Office" e mergulha no seu uso como Arquitetura de Negócios. Planilhas deixam de ser tabelas e viram Motores Matemáticos; E-mails deixam de ser cartas e viram Documentos Legais com peso jurídico; e Apresentações deixam de ser leituras tediosas e se tornam Armas de Persuasão (O Pitch).

---

## 📈 CAPÍTULO 1: Planilhas Eletrônicas e o Motor Matemático (Tópico 4)

Softwares como Microsoft Excel e Google Sheets são processadores lógicos. Uma planilha de medição de pressão de caldeiras mal configurada pode gerar dados irreais, levando o setor de manutenção a aprovar o uso de um equipamento prestes a explodir. Na indústria 4.0, o profissional que domina planilhas não é um usuário — é um **engenheiro de dados visuais** que transforma planilhas em sistemas de apoio à decisão em tempo real.

### 1.1 A Malha Infinita e o Paradigma de Tipagem
A tela é dividida por Colunas (Letras) e Linhas (Números). O cruzamento forma uma **Célula** (ex: `D4`), o átomo do dado. O Excel moderno possui 1.048.576 linhas e 16.384 colunas (até a coluna `XFD`), o que permite criar planilhas com mais de 17 bilhões de células — suficiente para processar bases de dados inteiras sem usar banco de dados.

![Excel - Funções e Fórmulas](imagens/futec/cap3/excel-formulas.svg)
![Dashboard de Dados](imagens/futec/cap3/excel-dashboard.jpg)

O erro fatal do analista júnior é o "Erro de Tipagem" (misturar tipos de dados). Esse erro simples pode derramar uma empresa inteira em auditorias financeiras. Vamos entender a fundo:

*   **O Tempo como Número Serial:** O Excel não entende "Datas" como conceitos humanos. Se você digita `01/01/2024`, o motor matemático interno grava o número `45292` (A quantidade de dias que se passaram desde 01 de janeiro de 1900). Isso permite que você subtraia a data de hoje pela data do vencimento do boleto e o Excel devolva o número exato de dias de atraso. A data `01/03/2024 15:30:00` é internamente armazenada como `45351,64583` — a parte inteira representa os dias e a decimal representa as horas.

*   **O Pecado Original:** Digitar o texto "kg" ou "R$" manualmente numa célula. Ao ver letras misturadas, o Excel classifica a célula como `String` (Texto). Você acaba de destruir o núcleo matemático; aquela célula nunca mais poderá ser multiplicada ou somada em uma equação de balanço patrimonial. A regra é: Digite o número cru (ex: `50`) e use a formatação do menu superior para vesti-lo com o símbolo monetário.

*   **O Paradoxo do Zero:** No Excel, uma célula vazia é diferente de zero. Se você subtrai `A1 - B1`, onde `A1 = 5` e `B1` está vazio, o resultado é `5` (não zero). Porém, se `B1` contém zero explicitamente, o resultado é `5`. Isso pode gerar erros catastróficos em planilhas de controle financeiro — sempre use `=SE(É.CÉL.VAZIA(B1); 0; B1)` para normalizar.

### 1.2 Referências Relativas, Absolutas e Mistas (A Arte do Copiar-Colar)

A verdadeira força do Excel reside na capacidade de copiar fórmulas. Porém, cada tipo de referência comporta-se diferente quando copiada:

| Tipo de Referência | Sintaxe | Comportamento ao Copiar | Exemplo Industrial |
|---|---|---|---|
| **Relativa** | `A1` | A coluna e linha ajustam-se relativamente | `=B2*C2` copiada para baixo vira `=B3*C3` |
| **Absoluta** | `$A$1` | Fixada permanentemente | `=B2*$H$1` (taxa de câmbio fixa) |
| **Mista** | `$A1` ou `A$1` | Apenas uma dimensão é fixada | `=$A2*B$1` (matriz de preços) |

**Caso Real de Engenharia:** Uma usina de açúcar precisa calcular o preço de venda de 50 produtos em 12 meses diferentes. A taxa de imposto (ICMS de 18%) deve ser aplicada a todos os produtos. A fórmula correta é `=B2*(1+$H$1)` — o `H1` com o imposto fica **absoluto** (`$H$1`) para que ao copiar para as 600 células da matriz, a referência ao imposto nunca se mova. Se o analista usar `H1` (relativo), a fórmula quebrará ao copiar para a coluna errada.

### 1.3 Funções de Agregação e Tabelas Dinâmicas

O Excel possui funções que processam milhões de dados instantaneamente:

| Função | Sintaxe | Uso Industrial |
|---|---|---|
| `SOMA()` | `=SOMA(A1:A1000)` | Total de produção mensal |
| `MEDIA()` | `=MEDIA(B:B)` | Tempo médio de reparo de máquinas |
| `CONT.SE()` | `=CONT.SE(A:A; "Defeito")` | Contagem de itens específicos |
| `SOMASE()` | `=SOMASE(A:A; "SP"; B:B)` | Soma condicional por região |
| `PROCV()` | `=PROCV(código; tabela; 2; FALSO)` | Busca vertical em catálogos de peças |
| `ÍNDICE(CORRESP())` | `=ÍNDICE(A:A; CORRESP("peça"; B:B; 0))` | Busca bidimensional avançada |
| `SES()` | `=SES(A1>90;"A"; A1>80;"B"; A1>70;"C"; VERDADEIRO;"D")` | Múltiplas condições (Excel 2019+) |

**PROCV vs. ÍNDICE/CORRESP:** O PROCV é limitado — só busca da esquerda para a direita e quebra se a tabela for reorganizada. O combo `ÍNDICE(CORRESP())` é mais robusto e tolerante a mudanças na estrutura da planilha. Em ambientes corporativos críticos, use ÍNDICE/CORRESP.

### 1.4 Validação de Dados e Proteção de Planilhas

Em uma usina com 50 analistas alimentando a mesma planilha de produção, você precisa controlar o que pode ou não ser digitado:

*   **Validação de Dados (Data Validation):** Clique em Dados > Validação de Dados. Restringir entrada:
    *   Lista suspensa: `={"Aprovado";"Reprovado";"Em Análise"}`
    *   Número inteiro entre 0 e 1000
    *   Data entre 01/01/2024 e 31/12/2024
    *   Comprimento de texto máximo de 50 caracteres

*   **Proteção de Células:** Não é só colocar senha na planilha. Você pode:
    *   Proteger toda a planilha com senha
    *   Destravar células específicas para edição (clique direito > Formatar Células > Proteger > Desmarcar "Bloqueada")
    *   Permitir que apenas usuários específicos editem intervalos

> **Caso Real:** Uma empresa de engenharia civil perdeu R$ 2 milhões porque um estagiário digitou "5000" em vez de "500" em uma planilha de orçamento de concreto. O erro passou despercebido até a obra iniciar. Com validação de dados (número máximo de 1000 por célula), isso seria impossível.

### 1.5 Formatação Condicional e Alertas Visuais Automatizados

A formatação condicional transforma a planilha em um **painel de monitoramento ativo**:

*   **Escala de Cores:** Valores altos em vermelho, médios em amarelo, baixos em verde
*   **Conjuntos de Ícones:** Setas para cima/baixo, círculos de alerta
*   **Regras de Destaque:** Células que contém texto específico, datas vencidas, valores duplicados
*   **Barras de Dados:** Representação gráfica dentro da própria célula

**Exemplo Industrial:** Uma planilha de manutenção preditiva usa formatação condicional:
*   Se `Dias_Desde_Ultima_Manutenção > 30` → Célula fica **vermelha**
*   Se `Dias_Entre_15_e_30` → Célula fica **amarela**
*   Se `Dias < 15` → Célula fica **verde**

O gestor olha para a planilha e já sabe, sem ler números, quais equipamentos estão em risco.

### 1.6 A Inteligência Lógica: A Função =SE() e Filtros

O Excel é uma máquina de Turing completa. Através da condicional `=SE()`, ele toma decisões sozinho, assumindo a postura de um vigilante da fábrica.
*A sintaxe de programação exige rigor:* `=SE( Teste Lógico ; "Valor Verdadeiro" ; "Valor Falso" )`

**Exemplo Avançado com Aninhamento:**
```excel
=SE(A2="Aprovado"; SE(B2>1000; "Premium"; "Padrão"); "Reprovado")
```

**Função SES (Excel 2019+):**
```excel
=SE(A1>90; "A"; A1>80; "B"; A1>70; "C"; VERDADEIRO; "Reprovado")
```
Mais legível que aninhar 10 =SE() uns dentro dos outros.

---

### 👨‍🏫 ATIVIDADE DE LABORATÓRIO 1: O Motor Matemático e Alertas Automatizados
**Objetivo Tático:** Desconstruir a visão de que o Excel é um "caderno pautado". A turma construirá um micro-sistema automatizado de gestão de estoque utilizando condicionais matemáticas.

**Passo a Passo em Sala de Aula:**
1.  **Criação do Banco de Dados Bruto:** Os alunos abrem o Excel. Digitam nas colunas superiores (A1, B1, C1): `Peça`, `Quantidade em Estoque`, `Status de Compra`.
2.  Preenchem 3 linhas com dados de maquinário: (Porca 8mm, Quantidade: 5), (Correia, Quantidade: 40), (Rolamento, Quantidade: 8).
3.  **O Poder das Tabelas Oficiais:** O professor manda os alunos selecionarem tudo, irem no menu "Página Inicial" e clicarem em **Formatar como Tabela**. *O milagre acontece:* Filtros são adicionados ao topo automaticamente, permitindo ocultar milhares de dados com um clique.
4.  **Injeção de Código Condicional (A Função SE):** Na célula `C2` (Status de Compra da Porca), o aluno digitará a lógica da máquina: `=SE(B2 < 10; "ALERTA: COMPRAR"; "ESTOQUE OK")`.
5.  Ao arrastar a fórmula para as outras linhas, o sistema criará um vigia virtual. Tudo que tiver menos de 10 unidades piscará com a ordem de "COMPRAR". A planilha deixou de ser um arquivo inerte e virou um Software de Gestão reativo.

---

## 📧 CAPÍTULO 2: Correio Eletrônico, SMTP e LGPD (Tópico 5)

WhatsApp não possui validade jurídica intrínseca no ambiente corporativo (arquivos são apagados, celulares quebram, conversas podem ser manipuladas). Uma ordem de demissão ou aprovação de compra de R$ 5 Milhões via E-mail Corporativo tem peso irrefutável e é protegido por lei. O e-mail corporativo é um **documento jurídico com força de prova em tribunal**, regido pela LGPD e pelas políticas internas de retenção de dados corporativos.

### 2.1 A Arquitetura Técnica do E-mail (SMTP, POP3 e IMAP)

Entender como o e-mail funciona tecnicamente é essencial para diagnosticar falhas e garantir segurança:

*   **SMTP (Simple Mail Transfer Protocol):** O protocolo de **envio**. Opera na porta 25 (ou 587 para autenticado). Quando você clica em "Enviar", seu cliente de e-mail (Outlook, Gmail) conecta-se ao servidor SMTP e transfere a mensagem. O SMTP não exige autenticação em servidores abertos, o que o torna vulnerável a spam — servidores modernos exigem autenticação TLS.

*   **POP3 (Post Office Protocol v3):** O protocolo de **download**. Baixa os e-mails do servidor para o cliente local e os remove do servidor (comportamento padrão). Usado em cenários onde o usuário precisa acessar e-mails offline ou em uma única máquina.

*   **IMAP (Internet Message Access Protocol):** O protocolo de **sincronização** (padrão corporativo). Mantém os e-mails no servidor, permitindo acesso simultâneo de múltiplos dispositivos (celular, notebook, tablet). Alterações em um dispositivo refletem em todos. **Obrigatório em ambientes corporativos com múltiplos pontos de acesso.**

*   **Exchange/Microsoft 365:** O servidor corporativo da Microsoft vai além do POP3/IMAP. Oferece:
    *   Calendário integrado com salas de reunião
    *   Contatos compartilhados da empresa
    *   Políticas de retenção e archive
    *   DLP (Data Loss Prevention) — bloqueia envio de dados sensíveis

> **Troubleshooting Real:** Um usuário reclama que não recebe e-mails no celular mas recebe no computador. Diagnóstico: está usando POP3 (baixa e apaga do servidor) em vez de IMAP. Solução: configurar o celular para IMAP ou deixar uma cópia no servidor.

### 2.2 A Estrutura Perfeita e o CCO (A Arma da LGPD)

O envio corporativo é uma ferramenta jurídica que exige disciplina:

*   **Para (To):** Exclusivo para quem tem a obrigação de agir e resolver o problema. Use para o destinatário principal que precisa executar a ação.

*   **CC (Com Cópia):** Para quem deve ser testemunha (O Diretor, o Gestor de Área), mas não deve responder. Útil para manter gestores informados sem impor obrigação de resposta.

*   **CCO (Com Cópia Oculta / Blind Carbon Copy):** O pilar da segurança da LGPD (Lei Geral de Proteção de Dados). Se a usina for mandar um convite de festa para 5.000 fornecedores, **NUNCA** se usa o campo "Para" ou "CC". Ao fazer isso, o sistema entrega a lista completa com os e-mails de todos os fornecedores para os concorrentes que estiverem na lista, gerando um crime de vazamento de dados gravíssimo com multas de até R$ 50 milhões. Coloca-se o seu próprio e-mail no "Para" e os 5.000 contatos no "CCO". Ninguém enxerga a existência do outro.

> **Multa Real LGPD (2022):** Uma empresa de Call Center enviou newsletter para 20.000 clientes colocando todos os e-mails no campo "Para:". A ANPD (Autoridade Nacional de Proteção de Dados) aplicou multa de R$ 750.000 por vazamento de dados pessoais (exposição de e-mails entre concorrentes).

### 2.3 Assinatura Corporativa e Assinatura Digital

O e-mail corporativo exige uma **assinatura padronizada** que transmite profissionalismo e fornece informações de contato:

```
Atenciosamente,

Carlos Silva
Engenheiro de Manutenção | SENAI Sertãozinho
Tel: (16) 3609-7700 | Ramal: 234
E-mail: carlos.silva@sp.senai.br
```

**Assinatura Digital (Certificado):** Para documentos jurídicos (contratos, propostas comerciais), utilize **certificado digital ICP-Brasil** (A1 ou A3). Ele garante:
*   Integridade: o documento não foi alterado após a assinatura
*   Autenticidade: prova inequívoca de quem assinou
*   Não-repúdio: o signatário não pode negar que assinou
*   Validade jurídica: equivalente a assinatura manuscrita em cartório

### 2.4 Anexos vs. Nuvens e a Assinatura Institucional

A malha mundial de servidores trava se um e-mail ultrapassar a carga útil de **25 Megabytes**. Se a engenharia tentar anexar uma planta do Autocad de 300MB, o e-mail explode e nunca chega. O protocolo correto é subir o projeto para a Nuvem (OneDrive, Google Drive, Dropbox) e mandar por e-mail apenas o *Link de Texto Segurado*, que pesa meros `2 Kilobytes`.

**Limites Reais de Tamanho por Plataforma:**
| Serviço | Limite por Anexo | Limite por Link (OneDrive) |
|---|---|---|
| Gmail | 25 MB | 5 GB (arquivos únicos) |
| Outlook.com | 20 MB | 2 GB (OneDrive) |
| Microsoft 365 | 150 MB | 10 GB (SharePoint/OneDrive) |
| Exchange on-premise | 10-100 MB (configurável) | Depende da infraestrutura |

### 2.5 Classificação e Retenção de E-mails (Policies)

Corporações não podem guardar e-mails para sempre. A LGPD estabelece princípios de **limitação da finalidade** — dados devem ser mantidos apenas pelo tempo necessário:

*   **Política de Retenção:**
    *   E-mails operacionais: 1 ano
    *   Documentos contábeis (notas fiscais): 5 anos (obrigação legal)
    *   Contratos: 10 anos após expiração
    *   E-mails de RH (admissão, demissão): prazo indeterminado (LGPD exige justificativa)

*   **Exchange Retention Policies:**
    *   Marcar itens como "Expire" após X dias
    *   Mover automaticamente para archive morto
    *   Permanently delete após Y dias

> **Caso Real:** Uma empresa foi processada em litigância trabalhista. O advogado pediu os e-mails de 3 anos atrás. A empresa havia configurado retenção de apenas 1 ano. Sem os e-mails, perdeu a ação trabalhista. O juiz considerou a ausência como "prova destruída pela própria empresa", favorecendo o reclamante.

### 2.6 Phishing, Spear Phishing e Defesa Corporativa

O e-mail corporativo é o vetor número 1 de ataques cibernéticos:

*   **Phishing:** E-mail massivo fingindo ser do banco, receita federal ou fornecedor. Um ataque "cego" que espera que 1% dos destinatários clique.

*   **Spear Phishing:** Ataque direcionado. O hacker pesquisa no LinkedIn: "Ricardo - Gerente de Compras - Usina XYZ". Envia e-mail personalizado: "Prezado Ricardo, seguem as novas condições do edit...". Muito mais eficaz.

*   **Indicadores de Phishing:**
    *   Remetente suspeito: @gmail.com fingindo ser @banco.com
    *   Links hover (passe o mouse): mostra URL diferente do texto
    *   Urgência injustificada: "Sua conta será bloqueada em 24h"
    *   Anexos .exe, .scr, .zip inesperados
    *   Erros ortográficos óbvios

*   **Defesa:**
    *   Nunca clique em links de e-mails não solicitados
    *   Verifique o remetente oficialmente (ligando para a empresa)
    *   Use MFA (Autenticação Multifator) em todas as contas corporativas
    *   Reporte e-mails suspeitos para o TI

---

### 👨‍🏫 ATIVIDADE DE LABORATÓRIO 2: Governança e Automação de Caixas (Inbox Zero)
**Objetivo Tático:** Eliminar o caos visual. Profissionais de alta gestão lidam com 200 e-mails diários. A turma criará Regras Automatizadas para que o "robô" do servidor leia, classifique e mova os e-mails vitais antes mesmo que o humano abra a caixa de entrada.

**Passo a Passo em Sala de Aula:**
1.  **A Engenharia da Etiqueta:** Os alunos acessam seu e-mail do Outlook (ou Gmail). O professor orienta a criação de uma Pasta/Marcador (Etiqueta) chamada **`[ 🚨 INCIDENTES DE ALTA PRIORIDADE ]`**.
2.  **Criação do Algoritmo de Triagem (Regra):** No Outlook, os alunos clicam com o botão direito num e-mail qualquer (ou vão em Configurações > Regras > Nova Regra).
3.  **Estabelecendo a Condição:** O aluno programa: *"Se o Assunto ou o Corpo do e-mail contiver a palavra 'FALHA' ou 'PARALISAÇÃO'..."*.
4.  **Estabelecendo a Ação:** *"Então, não jogue na caixa de entrada geral. Mova automaticamente para a pasta 'Incidentes' e marque com a cor vermelha"*.
5.  *Moral da Dinâmica:* O aluno deixa de ser "vítima" da enxurrada de comunicações corporativas e torna-se um administrador sistêmico. Quando 100 e-mails chegarem na segunda-feira, a inteligência do servidor já os terá catalogado, permitindo que a falha da máquina seja resolvida antes do funcionário perder tempo lendo spams ou recados irrelevantes do RH.

---

## 🎤 CAPÍTULO 3: Apresentações Eletrônicas e o Pitch (Tópico 11)

A maior das armadilhas dos recém-formados é acreditar que bons projetos se vendem sozinhos. Se um engenheiro construir a melhor válvula do mundo, mas gaguejar na frente do Conselho Diretor apresentando slides ilegíveis, o projeto perde o financiamento e morre na gaveta. Editores como *PowerPoint* e *Google Slides* não são processadores de texto; eles são "Suportes Cognitivos Visuais" que ditam a diferença entre um projeto aprovado e um projeto arquivado.

### 3.1 A Morte da Leitura e a Carga Cognitiva

A mente humana não consegue ler um texto complexo e escutar uma pessoa falando ao mesmo tempo (Sobrecarga Cognitiva). Isso é um fato neurológico comprovado: o córtex visual compete com o córtex auditivo pela memória de trabalho. Se o aluno criar um slide com fonte tamanho 12 lotado de parágrafos gigantes e der as costas para a plateia para lê-lo em voz alta, a apresentação afunda no primeiro minuto.

A regra de ouro global ditada pelos bilionários do Vale do Silício e das Startups é simples: **Textos Curtos (Mínimo de Fonte Tamanho 30), Alto Contraste e Imagens de Choque**. O conteúdo pesado você envia em PDF antes da reunião; o slide serve apenas para gerar emoção e foco enquanto a **Sua Voz** carrega os argumentos de venda.

**Anatomia do Slide de Alto Impacto:**
| Elemento | Regra | Exemplo |
|---|---|---|
| Fonte Título | ≥40pt | "SOLUÇÃO: SISTEMA DE RESFRIAMENTO" |
| Fonte Corpo | ≥24pt | Lista de 3 bullet points máximo |
| Imagem | Ocupa 60-70% do slide | Foto da máquina problema |
| Contraste | Fundo escuro + texto claro | Fundo #1a1a2e + texto branco |
| Logo | Canto inferior direito | SENAI 4.0 |

### 3.2 O Pitch (O Elevador da Persuasão)

Nesse escopo de velocidade agressiva, o mercado B2B (Business to Business) criou a técnica letal chamada de *Elevator Pitch* (O Pitch de Elevador).
A premissa: "Se você encontrasse o bilionário investidor no elevador, você teria 3 minutos até chegar ao saguão para convencê-lo a dar 1 milhão de reais na sua ideia. O que você diria?"

**A Estrutura do Pitch Profissional:**
1.  **Gancho (5 segundos):** "Você sabia que a usina perde R$ 500 mil por ano em paradas não planejadas?"
2.  **Problema (30 segundos):** "As caldeiras superaquecem porque o sistema de monitoramento atual tem 20 minutos de atraso."
3.  **Solução (45 segundos):** "Criamos um sensor IoT que detecta superaquecimento em 2 segundos."
4.  **Prova Social (30 segundos):** "A WEG já economizou R$ 1,2 milhão no primeiro ano."
5.  **Pedido (15 segundos):** "Precisamos de R$ 200 mil para ampliar para as 10 filiais."

**Total: 2:15 minutos** — direto, sem enrolação.

### 3.3 Design de Apresentações e Hierarquia Visual

O PowerPoint não é um processador de texto — é uma ferramenta de design:

*   **Regra dos 10/20/30 (Guy Kawasaki):**
    *   10 slides no máximo
    *   20 minutos de apresentação
    *   30pt de fonte mínimo

*   **Hierarquia Visual:**
    *   Título em Negrito e Maiúsculo
    *   Subtítulo descritivo
    *   Imagem impactante
    *   3 bullet points curtos

*   **Paleta de Cores Corporativa:**
    *   Use no máximo 3 cores principais
    *   Cor 1: Fundo/estrutura
    *   Cor 2: Destaque/branding
    *   Cor 3: Texto/leitura

*   **Transições:**
    *   Evite animações complexas que distraem
    *   Fade simple para entrada/saída
    *   Nunca use "texto voando" ou "carrossel seguindo" — passa imagem amadora

### 3.4 Multimídia e Inserção de Vídeo

O slide moderno integra vídeos diretamente. Isso multiplica o impacto:

*   **Inserir > Vídeo > Vídeo deste PC:** Para vídeos locais (mp4)
*   **Inserir > Vídeo > Vídeo Online:** Para YouTube/Vimeo (requer internet)
*   **Configurações de Vídeo:**
    *   Auto-play ao clicar
    *   Ocultar quando não estiver em reprodução
    *   Loop até parar (para demonstrações contínuas)
    *   Volume ajustável

> **Caso Real:** Um vendedor de máquinas industriais apresentou um slide com apenas um vídeo de 15 segundos da máquina operando em velocidade lenta ao lado de um competidor operando em velocidade normal. Fim da dúvida do cliente. Venda fechada em 5 minutos.

### 3.5 Apresentação Remota e Ferramentas Digitais

O mercado pós-pandemia migrou para apresentações remotas:

*   **Microsoft Teams / Zoom / Google Meet:**
    *   Compartilhar tela (mostrar slide ou janela específica)
    *   Gravação automática para revisão
    *   Compartilhamento de controle (entregar ao cliente)
    *   Quadro branco digital para anotações

*   **Regras do Remote Pitch:**
    *   Teste áudio/vídeo 10 minutos antes
    *   Use fones de ouvido (eco ZERO)
    *   Câmera ao nível dos olhos
    *   Iluminação frontal (nunca luz atrás = silhouette)
    *  Internet mínima: 10 Mbps upload

*   **Zoom Fatigue:** Meetings remotos cansam mais que presenciais.
    *   Intervalos a cada 45 minutos
    *   Câmera ligada optional (não obrigatório)
    *   Usar modo "speaker view" para focar no apresentador

---

### 👨‍🏫 ATIVIDADE DE LABORATÓRIO 3: A Engenharia do Pitch (Apresentação de Alto Impacto)
**Objetivo Tático:** Destruir o medo de palco e extirpar o hábito terrível do "Slide Teleprompter". Os alunos devem projetar e arquitetar uma mini-apresentação técnica inquebrável, utilizando recursos multimídia de persuasão em apenas 3 minutos.

**Passo a Passo em Sala de Aula:**
1.  **Desafio de Startup:** O professor divide a turma em duplas e os transforma em "Fundadores de uma Empresa de Robótica". Eles têm 10 minutos para abrir o PowerPoint e criar uma apresentação de estritamente **Três Slides Gigantes**.
2.  **O Slide da DOR (Slide 1):** Proibir o uso de mais de 5 palavras. O aluno deve encontrar a imagem de algo terrível (Ex: um trator pegando fogo ou uma engrenagem arrebentada). Ele apresentará o problema real que destrói o dinheiro do cliente no presente. (Ex: *"As caldeiras da Usina explodem por superaquecimento a cada 2 anos, custando R$ 500.000 em perdas"*, falado de boca, e não escrito no slide).
3.  **O Slide da SOLUÇÃO (Slide 2 - A Injeção Multimídia):** Ao invés de escrever "Meu software é bom", o aluno deve utilizar a inserção multimídia (Tópico 11.1). Os alunos devem ir em *Inserir > Vídeo > Vídeos Online* (ou colar um Youtube Embed). Um slide contendo apenas um vídeo de 15 segundos da nova peça robótica que eles inventaram apagando o fogo ou resfriando o aço. Uma prova irrefutável em movimento que quebra as dúvidas da diretoria imediatamente.
4.  **O Slide de TRAÇÃO / LUCRO (Slide 3):** Um único gráfico gigante de colunas em cor verde mostrando o retorno financeiro. ("Nossa solução custa R$ 50 Mil, mas economiza R$ 500 Mil"). 
5.  *O Choque Final:* O professor manda as duplas se levantarem e defenderem esse projeto em 3 minutos de cronômetro ligado. A turma descobre a pressão implacável e o poder avassalador de uma comunicação livre de textos excessivos.

---

## ⚔️ PROVA FINAL: O Estrategista do Escritório

Prove que você domina o arsenal corporativo de produtividade:

---

**Questão 1:**
O analista digitou o valor `R$ 1.500 kg` diretamente em uma célula do Excel e depois tentou usar essa célula numa fórmula de soma. O resultado foi um erro `#VALOR!`. Qual foi o erro fundamental cometido (Tópico 4)?

1.  A) O Excel não suporta valores acima de R$ 1.000.
2.  B) O analista misturou texto com número na mesma célula, convertendo-a em String e inutilizando-a matematicamente.
3.  C) A fórmula de SOMA exige vírgula, não ponto decimal.
4.  D) O tamanho da fonte estava muito grande para a célula calcular.

<details>
<summary>👀 Ver Resposta e Explicação</summary>

**Resposta:** B) O analista misturou texto com número na mesma célula, convertendo-a em String.
**Por que?** O Excel classifica células como "Número" ou "Texto". Ao digitar "kg" ou "R$" junto ao valor, o motor matemático classifica a célula como texto puro, impossibilitando operações de soma, multiplicação ou média. A regra é: insira o número cru e aplique a formatação visual pelo menu de células.
</details>

---

**Questão 2:**
A usina precisa enviar uma newsletter de novos produtos para 8.000 fornecedores cadastrados. Um estagiário colocou todos os 8.000 e-mails no campo "Para:" do Outlook. Qual foi o crime LGPD cometido e qual a solução correta (Tópico 5)?

1.  A) Nenhum crime; o campo "Para:" aceita múltiplos destinatários sem restrição.
2.  B) Violação da LGPD por exposição da lista de contatos de todos os fornecedores entre si. A solução é usar o campo CCO (Cópia Oculta).
3.  C) O Outlook bloqueia automaticamente envios com mais de 100 destinatários no campo "Para:".
4.  D) O crime foi não usar o campo "CC" em vez do "Para:".

<details>
<summary>👀 Ver Resposta e Explicação</summary>

**Resposta:** B) Violação da LGPD por exposição da lista de contatos entre si. Solução: CCO.
**Por que?** Ao colocar 8.000 e-mails no campo "Para:", todos os destinatários recebem a lista completa dos outros 7.999, expondo dados pessoais de clientes/fornecedores sem consentimento — crime gravíssimo pela LGPD. O CCO (Cópia Oculta) garante que cada destinatário só veja o próprio endereço.
</details>

---

**Questão 3:**
Um analista criou uma apresentação de 45 slides com fonte tamanho 10, texto denso e leu cada slide de costas para a plateia durante 1 hora. O resultado foi o abandono total da atenção. Qual é o princípio fundamental do Pitch Corporativo (Tópico 11) que ele violou?

1.  A) Ele deveria ter usado mais transições animadas entre slides.
2.  B) Ele violou a lei da Sobrecarga Cognitiva: o cérebro não consegue ler texto e escutar simultâneamente. Slides devem ter máximo 5 palavras em fonte grande, enquanto a voz carrega o argumento.
3.  C) O problema foi a ausência de bordas coloridas nos slides.
4.  D) Ele deveria ter usado o formato PDF em vez de PowerPoint.

<details>
<summary>👀 Ver Resposta e Explicação</summary>

**Resposta:** B) Violação da lei da Sobrecarga Cognitiva.
**Por que?** O cérebro humano não processa leitura e escuta simultâneas. Um slide denso rouba 100% da atenção visual do espectador, deixando a voz do palestrante sem audiência cerebral. Slides corporativos de impacto usam apenas uma imagem forte + máximo 5 palavras em fonte ≥30pt, enquanto o palestrante carrega os detalhes verbalmente.
</details>

---

*Parabéns. O escritório corporativo está sob controle. Avance para a Missão 4: Os Cofres de Dados e a Lógica Algorítmica.*

