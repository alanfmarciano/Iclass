# 💾 FUTEC 4: O Mestre dos Dados e da Lógica Algorítmica

> **Carga Horária Estimada:** 16 Horas
> **Foco:** Sistemas Gerenciadores de Banco de Dados Relacionais (SGBD / SQL) e Lógica de Programação Algorítmica Estruturada.
> **Baseado nos Tópicos Oficiais do SENAI:** Tópico 3 e Tópico 13.

Chegamos ao cerne intelectual do Módulo de Fundamentos (FUTEC). A partir deste ponto, abandonamos as ferramentas prontas de escritório criadas para usuários comuns e invadimos a fronteira do Engenheiro de Dados e do Desenvolvedor de Sistemas Industriais.

Se o século XX foi movido a petróleo, a Indústria 4.0 é inteiramente movida a **Dados**. Mas dados soltos e desestruturados são lixo digital. Para extrair valor, a inteligência corporativa depende de cofres invioláveis de alta disponibilidade (Os Bancos de Dados) e de regras de automação robótica inquebráveis e matemáticas (A Lógica de Programação). 
Entenda esta missão como o rito de passagem definitivo para quem deseja comandar a tecnologia, e não ser apenas um escravo dela.

---

## 🗄️ CAPÍTULO 1: Sistemas Gerenciadores de Banco de Dados (SGBD - Tópico 3)

Por que a Bolsa de Valores, o Itaú ou o RH de uma gigantesca Usina não guardam o saldo de milhões de clientes em planilhas do Microsoft Excel?
Porque planilhas corrompem sob múltiplos acessos simultâneos, travam e não possuem arquitetura de integridade ácida. Quando 100 analistas tentam editar a mesma célula simultaneamente no Excel, a última alteração sobrescreve todas as outras sem rastro auditável. No banco de dados, isso é impossível — há controles de concorrência, logs de transação e integridade referencial.

Para proteger os dados e garantir que eles durem 100 anos, a engenharia criou os **Bancos de Dados (BD)**, protegidos e orquestrados por uma central nuclear chamada **SGBD** (Sistema Gerenciador de Banco de Dados). É o SGBD que decide quem pode ler, quem pode apagar e garante que se a energia cair durante uma transferência bancária, o dinheiro não desapareça no vácuo quântico, devolvendo-o para a conta de origem (Transação ACID).

### 1.1 ACID: As Quatro Leis da Integridade de Dados

Todo SGBD relacional respeita o princípio ACID — não se trata de filosofia, mas de obrigatoriedade matemática:

![Modelo Relacional de Banco de Dados](imagens/futec/cap4/banco-dados.svg)
![Banco de Dados Corporativo](imagens/futec/cap4/bancodedados.jpg)

*   **A (Atomicity):** "É tudo ou nada." Uma transferência de R$ 1.000 entre duas contas é constituída de duas operações: `-1000` na origem e `+1000` no destino. Se a energia cair no meio do processo, ou as duas operações ocorrem, ou nenhuma ocorre. Não existe "dinheiro sumido" no vácuo.

*   **C (Consistency):** "Regras são regras." Se o campo é `INTEGER` (número inteiro), o banco recusa letras e caracteres especiais. Se o campo tem uma regra de `CHECK valor > 0`, um valor negativo é imediatamente rejeitado.

*   **I (Isolation):** "O que concorrentes não se vê." Se dois caixas atendem o mesmo cliente ao mesmo tempo, cada transação enxerga apenas seu próprio estado, não o estado intermediário da outra. O SGBD serializa as operações.

*   **D (Durability):** "Dado gravado não morre." Uma vez confirmado o commit, o dado persiste mesmo que o datacenter inteiro pegue fogo. O SGBD grava em disco antes de confirmar a transação.

### 1.2 O Choque Arquitetural: O Relacional (SQL) vs O Flexível (NoSQL)

A nuvem global é dividida em duas filosofias fundamentais:
*   **Bancos Relacionais (SQL):** Os mais rígidos, milenares e confiáveis do planeta (Ex: Microsoft SQL Server, Oracle, MySQL, PostgreSQL). A informação é trancada em matrizes matemáticas chamadas "Tabelas". Se a regra diz que o campo exige números, e você digita letras, o banco trava e impede a gravação instantaneamente. Usado na indústria para dinheiro, contabilidade, ERP e controle de peças precisas (dados que exigem integridade).

*   **Bancos Não-Relacionais (NoSQL):** Os flexíveis e imprevisíveis (Ex: MongoDB, Cassandra, Redis). Ao invés de tabelas de linhas, usam "Documentos" expansíveis ou "chaves-valor". Criados para suprir as exigências da Amazon e Facebook de guardarem bilhões de fotos e textos que variam de tamanho todo segundo em hiper-velocidade. Não garantem ACID completo — garantem "BASE" (Basically Available, Soft state, Eventual consistency).

**Quando usar SQL vs NoSQL:**
| Cenário | Banco Ideal | Motivo |
|---|---|---|
| Sistema financeiro, contabilidade | SQL (relacional) | Integridade ACID é inegociável |
| Catálogo de produtos e-commerce | SQL | Consultas complexas com JOINs |
| Logs de sensor IoT (milhões/s) | NoSQL (MongoDB, InfluxDB) | write massivo e rápido |
| Cache de sessão | NoSQL (Redis) | Memória extremamente rápida |
| Análise de big data | NoSQL (Cassandra, Hadoop) | Escala horizontal massiva |
| Conteúdo CMS/blog | NoSQL (MongoDB) | Esquema flexível de documentos |

### 1.3 A Estrutura Cirúrgica do Banco Relacional

O programador deve dobrar o joelho perante a hierarquia de uma modelagem de SGBD:
*   **Tabela (A Entidade):** O macro, algo real. (Ex: criar a tabela `Caminhões`).
*   **Campo (As Colunas):** Os atributos imutáveis. (`Placa`, `Capacidade`, `Chassi`).
*   **Tipo de Dados:** Cada campo é engessado. Se a capacidade do caminhão é um `INTEGER` (Número Inteiro), tentar inserir um texto quebra a matriz.
*   **Registro (As Linhas):** A vida física alimentando a máquina. (`"GHI-8910", "40", "A1B2C3"`).

**Tipos de Dados mais comuns:**
| Tipo | Uso | Exemplo |
|---|---|---|
| INT / BIGINT | IDs, quantidades inteiras | `150` |
| VARCHAR(n) | Textos variáveis (n = limite) | nome do cliente |
| TEXT | Textos longos sem limite | Descrição do produto |
| DECIMAL(p,s) | Valores monetários precisos | `1500.99` |
| DATETIME / TIMESTAMP | Datas e horas | `2024-03-15 14:30:00` |
| BIT / BOOLEAN | Verdadeiro ou Falso | `1` = TRUE |
| BLOB | Arquivos binários (imagens) | Foto do produto |

### 1.4 Chaves, Índices e Integridade Referencial

Para garantir que a usina não compre 2 tratores idênticos por falha de duplicação, implementa-se as **Chaves (Keys)**.

A **Chave Primária (PK - Primary Key)** é a identidade sagrada e irrepetível de uma linha (como o CPF de um cidadão ou a Placa de um carro). O SGBD jamais aceitará uma Chave Primária duplicada em sua história inteira. Pode ser um ID sequencial (`1, 2, 3...`) ou um dado natural (CPF, CNPJ, Placa).

A **Chave Estrangeira (FK - Foreign Key)** é como amarramos tabelas separadas. Se o João trabalha na "Manutenção", não digitamos "Manutenção" na tabela dele, colocamos o `ID Setor 5`, que é a Chave Primária da tabela de Setores. Isso evita erros de digitação catastróficos e dá o nome de "Banco RELACIONAL".

O **Índice** é como o índice de um livro — acelera buscas massivas. Se você busca frequentemente por `CPF`, crie um índice. Cuidado: índices aceleram leitura, mas retardam escrita (INSERT/UPDATE).

> **Caso Real:** Uma usina tinha tabela de 10 milhões de notas fiscais sem índice em `data_emissao`. Um relatório mensal levava 4 horas. Após criar índice em `data_emissao`, o relatório passou a rodar em 3 segundos.

### 1.5 Normalização: Eliminando a Redundância

A **Normalização** é a ciência de organizar tabelas para eliminar dados duplicados:

*   **1FN (Primeira Forma Normal):** Colunas atômicas (não listas). Cada célula contém 1 único valor.
*   **2FN:** Satisfaz 1FN + todo campo depende da PK inteira (não parcial).
*   **3FN:** Satisfaz 2FN + não há dependências transitivas (campo que depende de outro campo que não é PK).

**Exemplo de Normalização:**
```
Tabela RUIM (não normalizada):
| ID_Pedido | Produto | Preço | Cliente | Email | Telefone |
| 1        | Parafuso | 5 | João | joao@teste.com | 99999 |

Tabela NORMALIZADA:
| ID_Pedido | FK_ID_Produto | FK_ID_Cliente |
| 1         | 1            | 1             |

| ID_Produto | Nome     | Preço |
| 1         | Parafuso | 5    |

| ID_Cliente | Nome | Email          | Telefone |
| 1          | João | joao@teste.com | 99999   |
```
Se o João mudar de telefone, altero em 1 lugar apenas — não preciso atualizar 1000 pedidos.

---

### 👨‍🏫 ATIVIDADE DE LABORATÓRIO 1: A Construção do CRUD em SQL (O Script Lógico)
**Objetivo Tático:** Provar que os dados não se extraem com o "mouse", e sim operando a Linguagem Mestre dos computadores globais: o Script de Consulta (Query) do SQL (Structured Query Language). A classe executará as 4 ordens sagradas (Create, Read, Update, Delete).

**Passo a Passo em Sala de Aula:**
1.  **Lousa de Comando (Modelagem):** O professor divide o quadro ou abre o bloco de notas projetado para emular um Terminal SGBD puro. Cria-se o conceito de uma fábrica de autopeças.
2.  **INSERT (O Nascimento do Dado):** O professor propõe o desafio. Como ensinamos à máquina burra que nós produzimos um pistão? Os alunos redigem a sentença matricial absoluta de injeção: `INSERT INTO Pecas (nome, quantidade) VALUES ('Pistão Mestre', 500);`
3.  **SELECT (O Raio-X Forense):** A tabela possui 150 milhões de linhas. O diretor exige achar apenas as peças onde há zero estoque em 0,3 segundos. Os alunos criam a query de extração seletiva usando a condicional secreta `WHERE`: `SELECT nome FROM Pecas WHERE quantidade = 0;` (Esse é o núcleo de toda auditoria corporativa do mundo).
4.  **UPDATE (A Correção Cirúrgica):** Erramos na fábrica! Eram 600 pistões, não 500. Os alunos dão o comando de alteração pontual: `UPDATE Pecas SET quantidade = 600 WHERE nome = 'Pistão Mestre';` 
    *(Alerta de Tensão: O professor avisa que quem esquecer a regra `WHERE` irá aplicar os "600" para as 150 milhões de peças diferentes inteiras da usina, falindo a empresa num milissegundo de desatenção. É o poder absoluto).*
5.  **DELETE (A Aniquilação):** A remoção permanente do registro: `DELETE FROM Pecas WHERE nome = 'Pistão Mestre';`

---

## 💻 CAPÍTULO 2: A Mente Algorítmica e a Programação Estruturada (Tópico 13)

Você já construiu o Cofre de Dados (SGBD). Mas quem é o "robô" invisível, 24 horas por dia, varrendo o banco e tomando as atitudes drásticas, girando válvulas e bloqueando catracas sem intervenção humana?
Isso não é mágica, isso é **Lógica de Programação**. O computador não possui intuição. Se uma parede estiver à frente, o humano desvia, o robô andará de encontro a ela até os fios derreterem e a placa queimar, caso não seja explicitamente instruído a pensar.

A programação é a língua universal entre homem e máquina. Não saber programar na era da Indústria 4.0 é como saber dirigir sem conhecer o motor — você depende inteiramente de outros para manutenção e debugging de falhas.

### 2.1 O Algoritmo e a Lógica em Blocos Visuais

Antes de decorar línguas arcanas cheias de vírgulas (`C++`, `Python` ou `Java`), o arquiteto domina a Lógica Algorítmica. Um **Algoritmo** é meramente uma receita de bolo: um *Conjunto de Instruções* inquebráveis passo a passo. (1. Pegue o ovo. 2. Quebre o ovo. 3. Bata. 4. Asse). Se a máquina tentar a instrução 3 antes da 2, ocorrerá o temido **Bug** (Falha do Código) — ou pior, um ovo inteiro no forno.

![Fluxograma - Lógica de Programação](imagens/futec/cap4/fluxograma.svg)
![Programação e Código](imagens/futec/cap4/programacao.jpg)

**Pseudocódigo — A Linguagem Universal Antes do Código:**

```
INÍCIO
    SE temperatura > 300
        EXECUTAR Ligar_Exaustor()
    SENÃO
        EXECUTAR Manter_Operação()
FIM
```

Note que o pseudocódigo independe de linguagem. Ele define a lógica antes de escrever a sintaxe.

No treinamento de robótica pesada, a engenharia inicia com **Blocos Lógicos** de arrastar (como *Scratch* ou *Blockly*). Você arrasta o bloco [Andar], encaixa embaixo do bloco condicional [Se houver obstáculo], e encaixa o bloco vermelho [Parar]. O Cérebro do operador mecânico passa a treinar "Causas Gerando Consequências Sistêmicas" sem se perder em ponto e vírgula.

### 2.2 O Paradigma Estruturado e Suas Três Armas (A Programação Clássica)

Na Linguagem Estruturada de alto nível, os robôs e compiladores leem o código de Cima para Baixo impiedosamente, suportados pelos três pilares supremos de raciocínio da civilização tecnológica:

**1. Variáveis (Alocação Dinâmica de RAM):**
O computador não tem memória de curto prazo orgânica. Você exige que a RAM crie caixas virtuais batizadas e injete valores dentro. Ex: `caixa_peso_atual = 50`. Conforme os tratores descarregam, o sistema lê os sensores físicos e atualiza a matemática lógica dentro dessa variável na memória: `caixa_peso_atual = 60`.

Tipos de variáveis primitivos:
*   **Inteiro (INT):** Números sem vírgula. `150`, `-42`, `0`
*   **Real/Decimal:** Números com vírgula. `15.50`, `3.14159`
*   **Caractere/Char:** Um único caractere. `'A'`, `'@'`
*   **String:** Texto. `"SENAI 4.0"`
*   **Lógico/Boolean:** Verdadeiro ou Falso. `TRUE` / `FALSE`

**2. Estruturas Condicionais (SE / ENTÃO / SENÃO) (O famoso *If/Else*):**
O exato instante da vida em que a máquina "Toma uma Decisão" simulando arbítrio livre frente a uma bifurcação crítica de dados:

```
SE temperatura > 300
    ENTÃO ligar_exaustores()
    SENÃO SE temperatura > 250
        ENTÃO alerta_operador()
        SENÃO continuar_operacao()
```

Operadores de comparação:
*   `=` (igual a)
*   `<>` ou `!=` (diferente de)
*   `>` (maior que)
*   `<` (menor que)
*   `>=` (maior ou igual)
*   `<=` (menor ou igual)

Operadores lógicos:
*   `E` — ambas as condições precisam ser verdadeiras
*   `OU` — pelo menos uma condição precisa ser verdadeira
*   `NÃO` — inverte o resultado

**3. Laços de Repetição Iterativos (FOR / WHILE - *Enquanto*):**
A repetição exaustiva em microsegundos é a esmagadora vantagem da máquina sobre o ser humano, que cansa. A máquina verifica o processo eternamente:

```
ENQUANTO Usina = Aberta
    FAÇA Verificar_Catracas()
```

**Loop FOR (contado):**
```
PARA i DE 1 ATÉ 100
    EXECUTAR Calcular_Imposto(i)
PRÓXIMO i
```

### 2.3 Funções e Procedimentos: O Reaproveitamento de Código

A programação profissional não repete código. Se você precisa calcular imposto em 50 lugares diferentes, escreve a função uma vez e chama 50 vezes:

**Procedimento (não retorna valor):**
```
PROCEDIMENTO limpar_tela()
    LIMPAR()
    POSICIONAR(0,0)
FIM

// Para usar:
limpar_tela()
```

**Função (retorna valor):**
```
FUNÇÃO somar(a, b)
    RETORNAR a + b
FIM

// Para usar:
total = somar(100, 50)  // resultado: 150
```

### 2.4 Arquitetura de Dados e Estruturas Fundamentais

Além de variáveis individuais, a programação usa estruturas complexas:

*   **Vetor/Array (lista indexada):** `notas[1] = 8.5, notas[2] = 7.0`
*   **Matriz (tabela):** `matriz[linha][coluna]`
*   **Lista (Collection):** Array que cresce dinamicamente
*   **Dicionário (HashMap):** Pares chave-valor. `preços["aço"] = 150.00`

### 2.5 Debugging: A Arte de Encontrar Erros

Todo programador passa 80% do tempo debugando, não escrevendo. Técnicas essenciais:

*   **Print debugging:** `print("Chegou aqui!")`
*   **Breakpoints:** Pausar o código em linha específica
*   **Stack trace:** Rastrear a cadeia de chamadas
*   **Log de erros:** Arquivo externo com histórico de falhas

> **Regra de Ouro:** O maior erro do programador júnior é não testar o código. Sempre teste com dados de borda: zero, negativo, máximo, vazio.

### 2.6 Introdução às Linguagens de Programação Industriais

Na indústria 4.0, diferentes tarefas exigem diferentes linguagens:

| Linguagem | Foco Industrial | Por que usar |
|---|---|---|
| **Python** | Automação, IoT, Data Science | Bibliotecas massivas (Pandas, NumPy), fácil integração com sensores |
| **C#** | Aplicações Windows, Games, Unity | Integração Microsoft, Unity 3D |
| **Java** | Sistemas corporativos, Android | Maturidade, portabilidade (JVM) |
| **JavaScript** | Web apps, automação Node.js | Front-end + Back-end, IoT (ESP8266) |
| **C/C++** | Sistemas embarcados, CLP, CNC | Performance máxima, próximo do hardware |
| **SQL** | Manipulação de bancos de dados | Obrigatório para qualquer sistema com dados |

### 2.7 Versionamento de Código (Git)

Em equipes de desenvolvimento, o controle de versão é obrigatório:

*   **Git:** Sistema de versionamento distribuído
*   **GitHub/GitLab:** Repositórios online
*   **Branch:** Ramificação do código (trabalhar em paralelo)
*   **Merge:** Unir branches
*   **Commit:** Snapshot do código
*   **Pull Request:** Proposta de integração de código

> **Caso Real:** Uma equipe de 10 desenvolvedores trabalha no mesmo sistema de ERP. Sem Git, as alterações se sobrescrevem. Com Git, cada um trabalha no seu branch e o líder de projeto aprova (merge) o que entra no código principal.

---

### 👨‍🏫 ATIVIDADE DE LABORATÓRIO 2: A Engenharia de um Bug (Loop Infinito) e o Fluxograma
**Objetivo Tático:** Retirar a abstração do código ensinando o Fluxograma Matemático e aplicar o desastre catastrófico do "Loop Infinito" nas memórias visuais dos estudantes, para que provem como um erro de instrução humana sobrecarrega o hardware até o derretimento do sistema operacional.

**Passo a Passo em Sala de Aula:**
1.  **A Lógica do Estacionamento (Fluxograma):** O instrutor propõe que os alunos desenhem (em blocos num papel ou software visual) a cancela automática da fábrica usando os três pilares estruturados.
2.  Eles definem a variável: `vagas_totais = 100`.
3.  Iniciam a condição de tomada de decisão: **SE** a câmera ler uma placa de carro oficial **E** a variável `vagas_totais > 0`, **ENTÃO** `abrir_cancela`, e matematicamente deduzir 1 da variável de RAM `vagas_totais = vagas_totais - 1`. **SENÃO**, manter trancado.
4.  **O Vírus Criado Acidentalmente (O Loop Cego):** O professor ensina a falha máxima. E se o desenvolvedor inexperiente esquecer de colocar a subtração da variável `- 1`? O programa fará um teste **Laço de Repetição de Teste (While)** para contar as vagas. Como o valor jamais diminui (ficará sempre em 100), o contador nunca atinge a regra de encerramento do bloco.
5.  *O Efeito Colateral Físico:* O processador Core i9 da Intel da Missão 1 será instruído a rodar aquele código de verificação milhões de vezes por microssegundo sem jamais parar, sem pausa para respirar. Em 5 segundos, a ventoinha gritará no máximo, o Gerenciador de Tarefas disparará a CPU para 100% permanente, a máquina travará violentamente e a T.I precisará puxar a tomada do servidor do RH da tomada física. A má Lógica de Programação do software sobrecarrega e frita o Hardware. O controle algorítmico exige prudência militar.

---

### 👨‍🏫 ATIVIDADE DE LABORATÓRIO 3: A Programação Física (Lendo o Código G do CNC)
**Objetivo Tático:** Acoplar a Lógica Algorítmica abstrata à realidade brutal da Usinagem Pesada do SENAI, provando que um Torno Computadorizado não passa de um código estruturado de alto risco cravando facas no aço maciço industrial.

**Passo a Passo em Sala de Aula:**
1.  **A Linguagem-Mãe da Máquina:** O Professor apresenta as diretrizes brutais do Código Numérico (Código G e M das máquinas CNC).
2.  Na tela (ou papel), o instrutor apresenta a linha imperativa do código de um braço de usinagem real:
    `N10 G00 X50 Y50 Z10`
    `N20 G01 Z-5 F100`
3.  Os alunos decodificam a lógica condicional estruturada: `G00` não é uma palavra vã. Ele instrui os motores elétricos passo-a-passo a moverem o eixo do braço gigantesco rapidamente, em segurança através do ar, para a coordenada 50.
4.  Já o laço lógico `G01` obriga a ponta de diamante a perfurar o aço a exatos -5 de profundidade numa velocidade constante `F100`. 
5.  *A Conclusão Tática:* Se o aluno trocar a letra condicional `G01` pelo rápido `G00` no momento em que a broca tocar a placa grossa de aço maciço, o computador fará a broca mergulhar em hiper-velocidade gerando um choque mecânico brutal de fragmentação que destruirá uma ferramenta importada de mil dólares no pátio em frações de segundos. Código sujo, na fábrica, gera prejuízo milionário. A Programação Algorítmica na Indústria 4.0 é sagrada.

---

## ⚔️ PROVA FINAL: O Arquiteto de Dados

Prove que você domina os cofres de dados e a lógica algorítmica:

---

**Questão 1:**
O auditor da usina precisa localizar, em uma tabela com 2 milhões de registros, apenas as peças com `quantidade = 0` para emitir uma ordem de compra emergencial. Qual comando SQL (Tópico 3) realiza essa extração cirúrgica?

1.  A) `DELETE FROM Pecas WHERE quantidade = 0;`
2.  B) `INSERT INTO Pecas (quantidade) VALUES (0);`
3.  C) `SELECT nome FROM Pecas WHERE quantidade = 0;`
4.  D) `UPDATE Pecas SET quantidade = 0;`

<details>
<summary>👀 Ver Resposta e Explicação</summary>

**Resposta:** C) `SELECT nome FROM Pecas WHERE quantidade = 0;`
**Por que?** O comando `SELECT` extrai (lê) dados sem modificar o banco. A cláusula `WHERE` filtra apenas os registros que atendem à condição — neste caso, estoque zerado. É a operação mais crítica em auditorias corporativas: extrair inteligência de volumes massivos de dados com precisão milimétrica.
</details>

---

**Questão 2:**
Um desenvolvedor criou um loop `WHILE` para verificar vagas no estacionamento da usina, mas esqueceu de decrementar a variável contadora. O processador travou em 100% de uso contínuo até o servidor precisar ser desligado fisicamente. Qual falha lógica (Tópico 13) gerou esse desastre?

1.  A) Erro de Tipagem de Variável (String no lugar de Integer).
2.  B) Loop Infinito — condição de saída do laço nunca foi atingida, forçando o processador a iterar eternamente.
3.  C) Falta de Chave Primária na tabela de vagas do banco de dados.
4.  D) Uso incorreto do operador `SELECT` dentro de um laço `FOR`.

<details>
<summary>👀 Ver Resposta e Explicação</summary>

**Resposta:** B) Loop Infinito — condição de saída nunca atingida.
**Por que?** Um laço de repetição (`WHILE` ou `FOR`) exige uma variável que evolui a cada iteração até atingir a condição de parada. Sem esse decremento/incremento, o teste lógico sempre retorna `verdadeiro`, e o processador executa o bloco de código para sempre — consumindo 100% da CPU até o sistema congelar ou travar.
</details>

---

**Questão 3:**
No código CNC de um torno industrial, o comando `G00` move o eixo em velocidade máxima pelo ar (sem contato com o material). O comando `G01` perfura o material em velocidade controlada. Se um programador usar `G00` enquanto a broca já está em contato com a chapa de aço, o que ocorre?

1.  A) O torno pausa e pede confirmação do operador antes de avançar.
2.  B) A broca avança em altíssima velocidade contra o aço, gerando um choque mecânico que quebra a ferramenta e pode danificar o torno.
3.  C) O sistema SAP é notificado automaticamente e bloqueia a operação.
4.  D) O `G00` é convertido automaticamente em `G01` pelo controle CNC como proteção.

<details>
<summary>👀 Ver Resposta e Explicação</summary>

**Resposta:** B) A broca avança em alta velocidade contra o aço, quebrando a ferramenta.
**Por que?** Os comandos G são instruções diretas ao hardware mecânico sem validação de segurança implícita. O `G00` ordena deslocamento rápido independente do contexto físico — se a broca já estiver encostada no material, o choque entre metal e metal em alta velocidade é instantâneo e destrutivo. Na programação CNC, um único caractere errado pode significar perda de peças, equipamentos e até acidentes de trabalho.
</details>

---

*Parabéns. O cofre de dados foi aberto e a lógica algorítmica foi dominada. Avance para a Missão 5: Aplicações, Nuvem e Influência B2B.*

