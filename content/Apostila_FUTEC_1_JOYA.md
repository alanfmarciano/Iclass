**Video:** [Video da aula](https://www.youtube.com/watch?v=f5Tl17u_yTM)

# 🖥️ FUTEC 1: Fundamentos de Hardware e Sistemas Operacionais

> **Carga Horária Estimada:** 16 Horas **Foco:** Arquitetura de Hardware (CPU/RAM/SSD), Virtualização de Servidores, Ambientes Windows e Linux (Kernel/CLI). **Baseado nos Tópicos Oficiais do SENAI:** Tópico 6, Tópico 1 e Tópico 2.

Bem-vindo à primeira e mais fundamental missão da sua jornada técnica no **SENAI Sertãozinho**. O objetivo desta apostila não é apenas passar conceitos superficiais, mas formar uma base arquitetônica sólida e inabalável que a alta performance exige. Na Indústria 4.0, o profissional que apenas "sabe clicar" está completamente obsoleto. O mercado global exige profissionais que compreendam as engrenagens físicas (eletrônicas) e as leis lógicas da computação.

Neste material, nós abandonaremos a visão de "usuário" e mergulharemos no papel de Analista de Sistemas. Ao final de cada capítulo conceitual, aplicaremos esse conhecimento nas máquinas do laboratório escolar.

---

## 🖨️ CAPÍTULO 1: Arquitetura de Hardware e Bottlenecks (Tópico 6)

A tecnologia da informação corporativa existe para o processamento massivo de dados físicos e reais. Para que isso ocorra perfeitamente, dependemos da fundação elétrica: o Hardware.

### 1.1 A Estrutura de von Neumann e o Gargalo de Paginação

Todo computador moderno obedece à genial arquitetura desenvolvida por John von Neumann na década de 40. O computador é dividido em subsistemas interdependentes:

![Arquitetura de von Neumann](imagens/futec/cap1/von-neumann.svg)

- **Hardware:** O tecido físico. Circuitos integrados, resistores e capacitores de silício.
- **Software:** A alma lógica. Códigos abstratos armazenados em campos magnéticos.

O Arquiteto de Sistemas não conserta computadores, ele estuda os **"Gargalos de Desempenho" (Bottlenecks)**. A cadeia de processamento funciona na seguinte ordem:

1. A **CPU (Processador)** é a central que calcula bilhões de equações por segundo (Gigahertz).
2. Para não parar, a CPU pede dados à **Memória RAM** (uma memória de curtíssimo prazo, extremamente volátil, mas que envia dados à velocidade da luz).
3. A RAM, por sua vez, quando fica sem dados, busca as informações esquecidas no **Disco Rígido (HD ou SSD)**, que é o cofre permanente, gigante, porém lento.

> **A Crise do Hardware Mecânico:** Se a usina comprar um Servidor com um Processador da NASA, mas usar um Disco Rígido Mecânico (HD) e apenas 4GB de RAM, o que acontece? A RAM lota de dados rapidamente. Desesperado, o computador começa a usar um pedaço do Disco Rígido Lento como se fosse uma "Memória RAM Falsa" (processo chamado de *Swap* ou Arquivo de Paginação). Como o HD tem peças físicas (agulhas e discos giratórios), ele leva milhares de vezes mais tempo para enviar o dado do que um chip elétrico. O processador da NASA passa 99% do seu dia ocioso ("parado") esperando o disco girar. O sistema congela.

A solução física da Indústria 4.0 foi abolir HDs mecânicos adotando **SSDs (Solid State Drives)** e Memórias NVMe, que não possuem peças móveis, injetando dados puramente por transistores.

![SSD vs HD Mecânico](imagens/futec/cap1/ssd-vs-hd.svg)

### 1.2 A Hierarquia de Memória: Do Cache à Nuvem

A Engenharia de Sistemas não trata memória como uma coisa única — ela é uma **pirâmide estratégica de velocidade versus custo**. Quanto mais rápida a memória, mais cara e menor ela é:

![Hierarquia de Memória](imagens/futec/cap1/hierarquia-memoria.svg)

| Nível | Tipo | Velocidade | Capacidade Típica | Localização |
| --- | --- | --- | --- | --- |
| L1 | Cache da CPU | ~1 ns | 32–512 KB | Dentro do núcleo do processador |
| L2 | Cache da CPU | ~5 ns | 256 KB – 8 MB | Próximo ao núcleo |
| L3 | Cache Compartilhado | ~20 ns | 8 – 64 MB | No chip da CPU (compartilhado entre núcleos) |
| RAM | Memória Principal | ~60-100 ns | 8 – 256 GB | Na placa-mãe (DIMM) |
| SSD NVMe | Armazenamento Rápido | ~100 μs | 256 GB – 4 TB | Slot M.2 ou PCIe |
| SSD SATA | Armazenamento | ~500 μs | 128 GB – 4 TB | Conector SATA |
| HD Mecânico | Armazenamento Lento | ~5-10 ms | 500 GB – 20 TB | Conector SATA |
| Fita Magnética | Arquivo Morto | Segundos | Terabytes | Sala-cofre externa |

**Por que isso importa na usina?** Quando o software do ERP (Sistema Integrado de Gestão como o SAP) processa a folha de pagamento de 2.000 funcionários, a CPU repete as mesmas fórmulas salariais em loop. Se essas fórmulas couberem no Cache L3 (24MB, por exemplo), a CPU nunca precisará ir até a RAM — o cálculo ocorre internamente no chip em velocidade de luz. O mesmo cálculo que levaria 4 segundos na RAM leva 0,2 segundos no cache. Numa usina que roda 300 relatórios por dia, isso representa **horas de produtividade recuperadas**.

> **Observação Técnica:** A velocidade da RAM também depende do tipo: DDR4 (padrão atual empresarial) opera a 2.133–3.200 MHz. DDR5 (nova geração) já ultrapassa 4.800 MHz, dobrando a taxa de transferência. Além da velocidade, a **Latência CAS (CL)** importa — um CL16 entrega o dado 16 ciclos de clock após a solicitação, enquanto CL18 leva 18 ciclos. Em servidores de banco de dados, a diferença é mensurável.

### 1.3 A Placa-Mãe: O Painel de Controle Eletrônico

A **Placa-Mãe (Motherboard)** é frequentemente ignorada por profissionais inexperientes — eles focam na CPU e na RAM, mas esquecem que é a placa-mãe que **decide o teto de desempenho** de todo o sistema.

![Componentes da Placa-Mãe](imagens/futec/cap1/placa-mae.svg)

**Componentes críticos da placa-mãe que o Analista de TI deve dominar:**

1. **Socket (Encaixe da CPU):** Define qual processador pode ser instalado. Um Socket AM5 aceita apenas processadores AMD Ryzen 7000+. Um LGA1700 aceita Intel Core 12ª/13ª/14ª geração. Misturar CPU e socket incorretos resulta em destruição física imediata do processador — não há aviso, o chip queima.
2. **Chipset:** O gerente de tráfego da placa. O chipset Intel Z790 (topo) permite **overclocking** (forçar a CPU acima da velocidade de fábrica), enquanto o B660 (intermediário) bloqueia essa função. Na indústria, servidores usam chipsets ECC (Error Correcting Code) que **detectam e corrigem automaticamente erros de memória em tempo real** — essencial para evitar corrupção de dados financeiros.
3. **Slots PCIe (Peripheral Component Interconnect Express):** As vias expressas de dados. Uma GPU (placa de vídeo) para processamento de IA em visão computacional industrial ocupa um slot PCIe 4.0 x16. O protocolo PCIe 5.0 dobra a largura de banda para 128 GB/s por slot. Um cartão de rede 10GbE (para redes de datacenter de altíssima velocidade) ocupa um slot x4.
4. **BIOS/UEFI (Firmware de Inicialização):** Antes mesmo do Windows ou Linux "acordar", o computador executa um pequeno programa guardado em um chip de flash na própria placa-mãe: o **BIOS** (Basic Input/Output System) — ou sua versão moderna, o **UEFI** (Unified Extensible Firmware Interface). Este firmware realiza o **POST (Power-On Self-Test)**: testa se a CPU, RAM, GPU e discos estão respondendo fisicamente antes de passar o controle ao sistema operacional. Se um técnico instalar um módulo de RAM defeituoso, o UEFI emite uma sequência de **bipes sonoros em código Morse** (ex: 3 bipes longos = problema de RAM) antes mesmo da tela acender — o técnico diagnostica a falha sem precisar de software. O UEFI também controla a ordem de boot (de qual dispositivo o sistema inicia: SSD, pen-drive ou rede) e implementa o **Secure Boot**, que bloqueia a execução de sistemas operacionais não assinados digitalmente — camada de segurança obrigatória em ambientes corporativos.

### 1.4 CPU Moderna: Núcleos, Threads e TDP

![CPU e Hardware](imagens/futec/cap1/cpu-hardware.jpg)

A CPU deixou de ser um chip único em 2001 com o lançamento dos primeiros multiprocessadores. Hoje, um servidor de datacenter pode ter **96 núcleos físicos** (AMD EPYC Genoa). Entenda a diferença:

- **Núcleo Físico (Core):** Uma unidade de cálculo independente. Um processador de 8 núcleos pode executar genuinamente 8 tarefas diferentes ao mesmo tempo (Paralelismo Real).
- **Thread (Hyper-Threading / SMT):** A Intel e AMD permitem que cada núcleo físico simule 2 núcleos lógicos. Um processador de 8 núcleos com HT aparece ao sistema operacional como **16 processadores lógicos**. Ideal para servidores web que atendem centenas de requisições simultâneas.
- **TDP (Thermal Design Power):** O calor (em Watts) que o sistema de refrigeração precisa dissipar. Um processador de 125W TDP exige um dissipador ou sistema de resfriamento a líquido compatível. Em datacenters, racks inteiros são resfriados por **imersão em fluidos dielétricos** — os servidores ficam literalmente submersos em óleo mineral não-condutor.

**Aplicação Industrial:** O sistema de visão computacional de uma esteira de seleção de peças (que descarta peças fora de especificação em tempo real, processando 120 frames por segundo) não pode usar um processador de 2 núcleos. Ele requer uma CPU com pelo menos 16 núcleos E uma GPU dedicada (como a NVIDIA RTX 4090 ou Tesla T4) para as redes neurais de detecção de defeitos.

### 1.5 Classificação Industrial de Dispositivos (Tópicos 6.2.2 a 6.2.5)

Na indústria, abandonamos o termo "computador pessoal" em prol de um ecossistema tático:

![Tipos de Dispositivos Computacionais](imagens/futec/cap1/dispositivos.svg) ![Servidor de Datacenter](imagens/futec/cap1/servidor.jpg)

- **Servidores Dedicados:** Robustos, operam em salas de Datacenter congeladas. Sem interface de vídeo, focados apenas na transação dos bancos de dados do maquinário 24/7.
- **Tablets Industriais:** Substituem antigas pranchetas analógicas. Fiscais e engenheiros agrônomos os utilizam desconectados na roça para validar sistemas geo-referenciados que, ao voltarem ao Wi-Fi, sincronizam os ERPs.
- **E-readers (Leitores de Tela E-ink):** Como a matriz Kindle. Não emitem luz direta contra a pupila do operário. Com bateria durando meses, são perfeitos para carregar PDF's contendo esquemas elétricos pesados de 2.000 páginas nas plantas da fábrica sem causar exaustão visual na equipe de manutenção.
- **Smartglasses (Realidade Aumentada Corporativa):** O topo da evolução. Ao invés do técnico de reparos olhar para o manual impresso de um torno CNC e depois para a máquina, ele veste os óculos. Os óculos projetam hologramas de "setas em 3D" diretamente flutuando sobre o parafuso danificado na máquina, guiando a mão do mecânico com precisão militar, sem que ele precise largar a ferramenta.
- **Thin Clients:** Terminais leves sem armazenamento local. Toda a computação ocorre em um servidor central remoto. Usados em setores financeiros onde **nenhum dado corporativo pode jamais residir fisicamente no computador do funcionário** — se o thin client for roubado, o ladrão obtém apenas uma caixa plástica sem informação alguma.
- **PLCs (Controladores Lógicos Programáveis):** Computadores industriais robustos que controlam diretamente máquinas (tornos, prensas, esteiras). Operam em temperaturas extremas (-40°C a +70°C), com proteção contra vibração e umidade (grau IP65/IP67). O código que os programa é chamado de **Ladder Diagram** (Diagrama de Escada) — uma linguagem gráfica que simula circuitos elétricos de relés.

---

### 👨‍🏫 ATIVIDADE DE LABORATÓRIO 1: Análise Forense de Desempenho e Paginação

**Objetivo Tático:** Capacitar o aluno a realizar um diagnóstico sistêmico de hardware via Windows, provando através de gráficos se o computador sofre de falta de CPU, esgotamento de RAM ou falha mecânica de Disco (Gargalo/Bottleneck).

**Passo a Passo em Sala de Aula:**

1. **Abertura de Monitoramento:** Os alunos devem pressionar simultaneamente as teclas **Ctrl + Shift + Esc** para forçar a interrupção do sistema e abrir o painel oculto do **Gerenciador de Tarefas**. (Caso a tela seja muito simples, devem clicar na seta inferior esquerda "Mais detalhes").
2. **Mergulho nos Sensores:** Solicite que naveguem até a aba superior **Desempenho** (Performance).
3. **Auditoria do Processador (CPU):** Cliquem na aba CPU. Analisem o gráfico principal. O professor deve pedir aos alunos para abrirem vários programas (Navegador, Explorador de Arquivos, Calculadora) violentamente. O gráfico sofrerá **Picos de Carga**. Se a linha não ultrapassa 100% de forma contínua e logo cai para perto de 5% em repouso, o processador é saudável e adequado para a carga do SENAI.
4. **O Teste do Gargalo (Disco e RAM):** Os alunos devem clicar na aba **Disco (C:)**. Aqui reside o diagnóstico mestre. Se este gráfico formar uma parede sólida em 100% durante atividades comuns (como apenas abrir o Google Chrome) e o computador travar, o aluno deve assinalar o laudo: **Falha de I/O de Leitura**. O gargalo mecânico está matando o PC. A peça deve ser enviada para "Upcycling" (Troca por um componente SSD).

---

### 1.2 Classificação Industrial de Dispositivos (Tópicos 6.2.2 a 6.2.5)

Na indústria, abandonamos o termo "computador pessoal" em prol de um ecossistema tático:

- **Servidores Dedicados:** Robustos, operam em salas de Datacenter congeladas. Sem interface de vídeo, focados apenas na transação dos bancos de dados do maquinário 24/7.
- **Tablets Industriais:** Substituem antigas pranchetas analógicas. Fiscais e engenheiros agrônomos os utilizam desconectados na roça para validar sistemas geo-referenciados que, ao voltarem ao Wi-Fi, sincronizam os ERPs.
- **E-readers (Leitores de Tela E-ink):** Como a matriz Kindle. Não emitem luz direta contra a pupila do operário. Com bateria durando meses, são perfeitos para carregar PDF's contendo esquemas elétricos pesados de 2.000 páginas nas plantas da fábrica sem causar exaustão visual na equipe de manutenção.
- **Smartglasses (Realidade Aumentada Corporativa):** O topo da evolução. Ao invés do técnico de reparos olhar para o manual impresso de um torno CNC e depois para a máquina, ele veste os óculos. Os óculos projetam hologramas de "setas em 3D" diretamente flutuando sobre o parafuso danificado na máquina, guiando a mão do mecânico com precisão militar, sem que ele precise largar a ferramenta.

---

## 🪟 CAPÍTULO 2: Governança do Windows e Licenciamentos (Tópico 1)

O Windows lidera soberanamente os PCs administrativos de estações de trabalho mundiais.

### 2.1 A Hierarquia das Licenças de Software (Tópicos 1.2.1 a 1.2.5)

O Windows é um sistema de **Código Fechado (Software Proprietário)**. A Microsoft impede criminalmente (por meio da engenharia reversa) que você modifique o DNA da programação base do sistema operativo. Quando uma usina compra o Windows, ela não "compra" o software. Ela adquire juridicamente o direito de usá-lo através de uma **Licença de Uso**, carimbada em um código encriptado de 25 caracteres chamado de **Chave de Ativação** (Key).

Para não infligir processos gigantescos contra pirataria, o departamento de T.I de Sertãozinho deve dominar as outras três classificações absolutas de softwares:

1. **Software Livre (Open Source):** O código é aberto, auditável publicamente e permitida sua redistribuição irrestrita (ex: O *Linux*, que veremos abaixo).
2. **Freeware:** Softwares corporativos que são distribuídos grátis legalmente e sem limites de tempo, MAS não liberam o código-fonte para modificação (ex: Navegador *Google Chrome*).
3. **Shareware (O Canto da Sereia):** Uma tática violenta de marketing. O fornecedor fornece o programa completo de graça, mas embutiu um "Relógio Bomba Lógica". Após exatos 30 dias de uso na fábrica, o software se auto-bloqueia, paralisando a equipe e exigindo o pagamento de uma licença (ex: O clássico compactador *WinRAR*).

### 2.2 Virtualização de Infraestrutura

A virtude máxima da engenharia corporativa é não gastar o orçamento milionário com computadores físicos desnecessários. A usina usa um programa de balança rodoviária que foi criado em 2001 e só funciona estritamente no obsoleto Windows XP. Porém, o TI da empresa acabou de comprar computadores top de linha rodando Windows 11. O sistema não abre e a balança fica travada.

O Arquiteto de TI não chora e manda comprar peças antigas do ferro velho. Ele injeta **Máquinas Virtuais (VMs)**. Utilizando softwares hypervisores (como VirtualBox ou o Hyper-V nativo do Windows), o analista recruta uma porcentagem da CPU e da RAM do PC poderoso e "Engana" a máquina, recriando o chip físico de um PC antigo virtualmente. Um computador inteiro invisível "nasce" rodando Windows XP dentro de uma janela no desktop moderno, isolado e executando o sistema da balança sem atritos.

---

### 2.3 Licenciamento Corporativo por Volume (VLK e Microsoft 365)

Uma usina com 500 computadores não compra 500 caixas individuais do Windows na loja. Isso é legalmente inviável e financeiramente catastrófico. O departamento de TI opera com **Licenciamento por Volume (VLK — Volume License Key)**:

- **Open License / CSP (Cloud Solution Provider):** A empresa assina um contrato diretamente com a Microsoft ou um distribuidor certificado. Uma única chave é aplicada em todos os computadores da empresa via servidor KMS (Key Management Service) interno. O servidor KMS "conversa" com os PCs da rede a cada 180 dias para revalidar as licenças — sem internet externa necessária.
- **Microsoft 365 Empresarial (Modelo SaaS de Licença):** Ao invés de comprar o Office permanentemente, a empresa paga mensalmente por usuário (modelo por assinatura). Vantagem: qualquer atualização (Word, Excel, Teams, OneDrive) chega automaticamente. Desvantagem: se a empresa parar de pagar, **todos os documentos tornam-se somente leitura imediatamente**.
- **Windows LTSC (Long Term Servicing Channel):** Versão do Windows para ambientes industriais críticos (usinas, hospitais, bancos). O LTSC **não recebe atualizações de funcionalidades** por até 10 anos — apenas patches de segurança emergenciais. Por que isso importa? Um sistema CNC (Controle Numérico Computadorizado) certificado pelo fabricante para rodar em Windows 10 LTSC 2021 **pode ser invalidado pela garantia** se uma atualização automática do Windows alterar drivers ou comportamentos do sistema operacional. Estabilidade e previsibilidade têm mais valor que novidades.

> **Crime Corporativo Real:** Em 2020, uma empresa brasileira de médio porte foi multada em R$ 800.000 pelo BSA (Business Software Alliance) após uma auditoria revelar 180 computadores rodando Windows e Office sem licença. A multa superou em 15x o custo das licenças legítimas. O TI que "economizou" custou o equivalente a 3 anos de salário de toda a equipe.

---

### 2.4 Active Directory e Controle Centralizado de Usuários

Em uma usina com 500 funcionários, o TI não configura cada computador individualmente. Ele usa o **Active Directory (AD)** — o sistema de gerenciamento centralizado de usuários e computadores da Microsoft.

**Como funciona na prática:**

1. **Domínio:** Todos os PCs da empresa são "ingressados" (joined) em um Domínio Windows (ex: `usina.local`). A partir desse momento, o computador "obedece" ao servidor central.
2. **GPO (Group Policy Object — Política de Grupo):** O administrador define regras que se aplicam automaticamente a grupos de usuários ou computadores. Exemplos reais de GPOs em uma usina: *"Bloquear acesso ao Painel de Controle para todos os usuários do grupo Operação"* *"Força proteção de tela com senha após 5 minutos de inatividade"* *"Proibir instalação de programas sem senha de administrador"* *"Mapear automaticamente o drive Z: para o servidor de arquivos \servidor\producao ao fazer login"*
3. **OU (Organizational Unit — Unidade Organizacional):** Pastas lógicas dentro do AD que organizam usuários e computadores por departamento. A OU `RH` recebe políticas diferentes da OU `TI`, que recebe políticas diferentes da OU `Produção`.
4. **Protocolo LDAP (Lightweight Directory Access Protocol):** O idioma técnico que os sistemas usam para "consultar" o Active Directory. Quando você entra com login e senha no computador da empresa, o Windows faz uma consulta LDAP ao servidor AD: *"Esse usuário existe? A senha está correta? A quais grupos ele pertence?"* — tudo em milissegundos, invisível ao usuário final.

---

### 2.5 Hardening do Windows: Blindagem Pós-Instalação

Um Windows recém-instalado não está pronto para ambientes corporativos — ele precisa de **Hardening (Endurecimento de Segurança)**. O Analista de TI aplica uma lista de configurações que eliminam vetores de ataque conhecidos:

| Ação de Hardening | Por que é necessária |
| --- | --- |
| Desativar o protocolo SMBv1 | Vulnerabilidade explorada pelo ransomware WannaCry (2017) que paralisou hospitais mundiais |
| Desativar o Remote Desktop (RDP) se não utilizado | RDP é o vetor de entrada nº 1 de ataques de ransomware corporativo |
| Ativar o Windows Defender + Firewall | Primeira barreira contra malwares comuns |
| Configurar Windows Update para modo automático | Patches de segurança corrigem 90% das vulnerabilidades exploradas ativamente |
| Criar contas de usuário padrão (não Administrador) | Se um vírus infectar a conta, não terá permissão para instalar-se no sistema |
| Criptografar o disco com BitLocker | Se o notebook for roubado, os dados são ilegíveis sem a chave de recuperação |
| Remover softwares pré-instalados (Bloatware) | Reduz superfície de ataque e melhora desempenho |
| Configurar auditoria de logs (Event Viewer) | Registra todas as tentativas de login, falhas e alterações de sistema |

> **Curiosidade Técnica:** O ataque WannaCry de 2017 explorou uma vulnerabilidade no protocolo SMBv1 do Windows que a Microsoft havia corrigido 2 meses antes com uma atualização de segurança. Mais de 200.000 computadores em 150 países foram infectados porque os administradores de TI não aplicaram o patch. O prejuízo global foi estimado em US$ 4 bilhões.

---

### 👨‍🏫 ATIVIDADE DE LABORATÓRIO 2: Acessando o Hyper-V Nativo e Políticas de Pasta Oculta

**Objetivo Tático:** Demonstrar ao aluno que o Windows moderno possui as matrizes para hospedar outros computadores virtualizados na mesma máquina e treinar a segurança visual da árvore de diretórios (ocultando caminhos sensíveis `C:\`).

**Passo a Passo em Sala de Aula:**

1. **Auditoria de Arquitetura Virtual:** Os alunos devem pressionar a **Tecla Windows**, digitar literalmente "Ativar ou desativar recursos do Windows" e acionar o Enter.
2. Neste quadro administrativo arcaico de extrema importância, peçam aos alunos para pesquisar pelo **Hyper-V**. (A ativação final e reinício pode não ser possível se as máquinas do laboratório estiverem congeladas contra gravações pelo TI, mas a análise do painel onde a mágica ocorre é imperativa). O aluno que dominar o Hyper-V nunca precisará ter 5 computadores na mesma mesa para fazer testes em 5 sistemas.
3. **Higiene da Árvore de Arquivos (C:):** O aluno pressionará o atalho mestre **Windows + E** (Explorador de Arquivos).
4. Compreender a diferença brutal entre um arquivo deletado normalmente, que reside preguiçosamente na Lixeira para ser recuperado e um arquivo "Deletado Forçado" usando **Shift + Delete** (que sobreescreve trilhas magnéticas do disco pulando a Lixeira, sem devolução, perigoso em ambientes corporativos).
5. Naveguem até a pasta Meus Documentos, criem uma pasta "Balança_BKP". Botão direito nela > Propriedades. Marquem a caixa **Oculto**. A pasta ficará cinza-fantasma ou desaparecerá. Um simples analista acaba de dificultar o acesso não autorizado de invasores comuns.

---

## 🐧 CAPÍTULO 3: O Pinguim e a Linha de Comando de Dados (Tópico 2)

Na indústria de altíssima criticidade, sistemas de mísseis da Força Aérea a robôs colheitadores não utilizam janelas bonitas para rodar as engrenagens. Eles usam o SO (Sistema Operacional) de Código Aberto: O Gigante **GNU/Linux**.

Como o núcleo do sistema (o *Kernel*) é aberto aos brilhantes matemáticos do globo, ele se subdivide em vertentes focadas chamadas **Distribuições** (Distros). A distribuição *Ubuntu* é desenhada para iniciantes usarem com mouse e clique. A distribuição *CentOS/Debian/RedHat* é desenhada para datacenters industriais globais, operando inteiramente em texto bruto.

### 3.1 A Supressão Visual pelo Modo Texto (CLI - Command Line Interface)

Por que a usina joga fora a comodidade do mouse e obriga o profissional de dados a administrar o sistema por uma tela preta apenas com letras verdes, chamada de "Terminal"?

Pois gerar o peso de "Sombreados de Janela em HD", "Ícones Animados" e "Cursores" consome até 40% de todo o processamento de vídeo e RAM do computador (A Carga Gráfica / *GUI - Graphical User Interface*).

No Modo Texto (Terminal de Linha de Comando), a Carga Gráfica é literalmente desligada, caindo para `0%`. Deixando todo o sangue vital do Processador focado no que dá lucro à companhia: Extração e Criptografia Massiva dos dados financeiros que trafegam na rede.

![Terminal Linux](imagens/futec/cap1/terminal-linux.svg)

E se o administrador da usina esquecer o que o comando faz, estando na tela preta, ele não pode acessar a página de ajuda do Google. Para isso, o Linux embutiu "O Menu de Ajuda Oficial" no próprio kernel: o sistema **Man Pages (Manual Pages)**. O engenheiro digita `man [nome_do_comando]` e a tela preta preenche as entrelinhas exatas de como a matemática do sistema deve operar. É o **F1** glorificado da tela pura.

---

### 3.2 Distribuições Linux: O Ecossistema Industrial

O Linux não é "um" sistema operacional — é um **Kernel** (núcleo) em torno do qual a comunidade global constrói sistemas completos. Cada "sabor" é chamado de **Distribuição (Distro)**:

| Distribuição | Foco | Usado por |
| --- | --- | --- |
| **Ubuntu** | Desktop para usuários finais | Desenvolvedores, educação, iniciantes |
| **Debian** | Estabilidade máxima, base de outras distros | Servidores corporativos, pesquisa |
| **Red Hat Enterprise Linux (RHEL)** | Suporte comercial pago, ambientes críticos | Bancos, telecom, governo federal |
| **CentOS Stream** | Versão comunitária gratuita do RHEL | Servidores de médio porte |
| **Ubuntu Server** | Servidor sem interface gráfica | Startups, nuvem (AWS, Azure, Google Cloud) |
| **Kali Linux** | Testes de penetração e auditoria de segurança | Analistas de Cibersegurança, pentesters |
| **Alpine Linux** | Ultraleve (5MB), para containers Docker | Microserviços, IoT industrial |
| **Android** | Mobile — baseado no Kernel Linux | 3,5 bilhões de smartphones no mundo |

> **Fato Surpreendente:** 96,3% dos 1.000 maiores supercomputadores do planeta rodam Linux. A ISS (Estação Espacial Internacional) migrou de Windows para Linux em 2013 por questões de **confiabilidade e controle**. O Android — que roda em seu smartphone — é baseado no Kernel Linux.

---

### 3.3 A Hierarquia de Diretórios Linux (FHS)

No Linux, tudo é arquivo — inclusive hardware. A estrutura de pastas segue o padrão **FHS (Filesystem Hierarchy Standard)**:

![Hierarquia de Diretórios Linux](imagens/futec/cap1/linux-tree.svg)

```
/ (Raiz — equivalente ao C:\ do Windows)
├── /bin         → Binários essenciais do sistema (ls, cp, mv, ping)
├── /etc         → Arquivos de configuração do sistema (senhas, rede, SSH)
├── /home        → Pastas pessoais dos usuários (/home/alan, /home/joao)
├── /var         → Logs e dados variáveis (/var/log/syslog — registro de eventos)
├── /tmp         → Arquivos temporários (apagados ao reiniciar)
├── /usr         → Programas instalados pelo usuário
├── /root        → Pasta home do superusuário (root)
├── /dev         → Dispositivos de hardware (/dev/sda = primeiro disco)
├── /proc        → Informações em tempo real do kernel e processos
└── /mnt         → Ponto de montagem de discos externos (pen-drives, HDs)
```

**Aplicação prática:** Quando o servidor da usina apresenta comportamento estranho, o primeiro lugar que o administrador verifica é `/var/log/syslog` — o diário de bordo do sistema que registra cada evento com timestamp. Um ataque hacker, uma falha de hardware ou um serviço que travou **sempre deixa rastros nesse arquivo**.

---

### 3.4 Sistema de Permissões: chmod e chown

O Linux implementa um sistema de **controle de acesso granular** baseado em três categorias de usuário e três tipos de permissão:

**Categorias:**

- **u (user):** O dono do arquivo
- **g (group):** Membros do grupo ao qual o arquivo pertence
- **o (others):** Todos os demais usuários do sistema

**Permissões:**

- **r (read = 4):** Pode ler o conteúdo do arquivo
- **w (write = 2):** Pode modificar o arquivo
- **x (execute = 1):** Pode executar o arquivo como programa

Ao rodar o comando `ls -la` no terminal, cada arquivo mostra sua permissão assim:

```
-rwxr-xr-- 1 alan producao 4096 abr 20 09:30 relatorio.sh
```

Lendo da esquerda: `rwx` (dono alan pode ler/escrever/executar) | `r-x` (grupo producao pode ler/executar) | `r--` (outros só podem ler).

Para alterar permissões:

```
chmod 755 relatorio.sh    # Dono: tudo | Grupo: ler+executar | Outros: ler+executar
chmod 600 senhas.txt      # Apenas o dono pode ler e escrever — ninguém mais acessa
chown alan:producao arquivo.txt  # Transfere a propriedade para o usuário 'alan', grupo 'producao'
```

> **Cena Real de Segurança:** Um banco de dados de senhas armazenado com permissão `chmod 777` (qualquer usuário do servidor pode ler, escrever e executar) é uma brecha catastrófica. Qualquer processo comprometido no servidor teria acesso total ao arquivo. A configuração correta é `chmod 600` com `chown root:root` — só o superusuário acessa.

---

### 3.5 Comandos Essenciais e Pipe de Dados

O poder real do terminal Linux está na capacidade de **encadear comandos via Pipe (`|`)** — a saída de um comando alimenta diretamente a entrada do próximo, criando cadeias de processamento poderosas:

| Comando | Função | Exemplo Industrial |
| --- | --- | --- |
| `ls -la` | Lista arquivos com permissões | `ls -la /var/log` — ver logs do servidor |
| `grep "ERRO" arquivo.log` | Filtra linhas que contém o texto | `grep "FALHA" syslog` — localizar falhas |
| `cat arquivo.txt` | Exibe o conteúdo do arquivo | `cat /etc/hosts` — ver mapeamento de IPs |
| `cp origem destino` | Copia arquivo/pasta | `cp backup.sql /mnt/hd_externo/` |
| `rm -rf pasta/` | Remove pasta e conteúdo (IRREVERSÍVEL) | Usar com extrema cautela em servidores |
| `ps aux` | Lista todos os processos rodando | `ps aux |
| `kill -9 PID` | Mata forçadamente um processo | `kill -9 4821` — encerrar processo travado |
| `df -h` | Mostra espaço disponível nos discos | `df -h` — checar se servidor está com disco cheio |
| `top` | Monitor de processos em tempo real | Equivalente ao Gerenciador de Tarefas |
| `ssh usuario@IP` | Acesso remoto seguro a outro servidor | `ssh alan@192.168.1.50` — administrar servidor remotamente |

**Exemplo de Pipe em Produção:**

```
cat /var/log/syslog | grep "ERRO" | sort | uniq -c | sort -rn | head -10
```

Este único comando: lê o log do sistema → filtra apenas linhas de ERRO → ordena → conta duplicatas → ordena por frequência → mostra os 10 erros mais frequentes. Em um único comando, o analista obtém o relatório de saúde do servidor.

---

### 👨‍🏫 ATIVIDADE DE LABORATÓRIO 3: Manipulação de Dados Estruturados via Terminal

**Objetivo Tático:** Quebrar o medo visual. O aluno operará a mesma lógica do Linux Terminal mas no emulador nativo do Windows, criando um diretório profundo em segundos através da força bruta de códigos lógicos, sem jamais tocar no cursor do mouse.

**Passo a Passo em Sala de Aula:**

1. **Abertura do Console Raiz:** No Windows da escola, o aluno pressiona **Tecla Windows + R** (Comando Executar), digita o clássico sigiloso `cmd` e atira Enter. A temida tela preta sobe. As mãos saem do mouse obrigatoriamente.
2. **O Ping (Testando o Mundo Exterior):** Os alunos farão o teste de sonar nuclear contra a nuvem da Google. O professor manda digitarem: `ping www.google.com`. *(Os pacotes de radar sairão do laboratório e o terminal imprimirá o Retorno em milissegundos). Prove que a conexão do SENAI está viva.*
3. **Localização Territorial:** Digitem `cd Desktop` (Enter) ou `cd OneDrive` para penetrar na área de trabalho. O caminho (`C:\Users\...\Desktop>`) prova o salto. O `cd` significa "Change Directory".
4. **Criação Rápida de Lote (A Mágica do Terminal):** Digitem a ordem vitalícia para o sistema alocar memória para um banco de dados: `mkdir BD_Contabilidade` e pressionem Enter. (Make Directory).
5. O laboratório de informática acaba de forjar um bloco de pasta sem encostar na inferface do clique e arrasta. O conceito raiz da T.I está absorvido.

---

## ⚔️ PROVA FINAL: O Desafio do Arquiteto Híbrido

Você dominou as entranhas físicas e lógicas da Missão 1. Prove agora ao Engenheiro Chefe que absorveu a essência resolvendo as 3 questões de diagnóstico técnico abaixo:

---

**Questão 1:** O gerente de RH exige um dispositivo ultraportátil com bateria de um mês de duração e que não cause fadiga visual após 8 horas lendo manuais de engenharia de 2.000 páginas no pátio da usina. A qual dispositivo computacional (Tópico 6) ele se refere?

1. A) Smartphone top de linha com tela AMOLED.
2. B) Tablet robusto com processador de núcleo quádruplo.
3. C) Servidor Desktop Fanless sem monitor.
4. D) Leitor de Livros Digitais (E-reader com tecnologia E-ink).

👀 Ver Resposta e Explicação**Resposta:** D) Leitor de Livros Digitais (E-reader com tecnologia E-ink). **Por que?** Apenas a tecnologia E-ink não emite luz diretamente contra a pupila (zero fadiga visual) e possui consumo elétrico absurdamente baixo, garantindo semanas de uso contínuo sem recarga — atributos impossíveis em telas AMOLED ou LCD de tablets convencionais.

---

**Questão 2:** Um software de monitoramento de câmeras foi instalado gratuitamente. Após 30 dias, o programa bloqueou todos os recursos avançados e exibiu uma janela exigindo pagamento em dólar para "Desbloquear a Versão PRO". Qual é a classificação oficial (Tópico 1) deste tipo de software?

1. A) Freeware — Software gratuito e irrestrito para sempre.
2. B) Software Livre com filosofia GNU/GPL.
3. C) Shareware (Versão de Avaliação/Trial com Bomba-Relógio).
4. D) Sistema Operacional de Código Aberto.

👀 Ver Resposta e Explicação**Resposta:** C) Shareware (Versão de Avaliação/Trial com Bomba-Relógio). **Por que?** O Shareware é uma estratégia comercial onde o fornecedor libera o produto completo como "isca", embutindo um gatilho temporal (30, 60 ou 90 dias) após o qual o sistema se auto-bloqueia até o pagamento da licença. Diferente do Freeware, que é gratuito permanentemente sem restrições de funcionalidade.

---

**Questão 3:** O administrador de redes desativou completamente o Ambiente Gráfico (GUI) do servidor Linux, eliminando janelas, ícones e o cursor do mouse, para maximizar a RAM disponível ao banco de dados da folha de pagamento. Qual modo operacional (Tópico 2) ele passou a utilizar?

1. A) O Modo Texto / Interface de Linha de Comando (CLI).
2. B) O Menu de Ajuda Man Pages interativo.
3. C) O Desktop Virtual do diretório `/home`.
4. D) O Spooler de Impressão Centralizado.

👀 Ver Resposta e Explicação**Resposta:** A) O Modo Texto / Interface de Linha de Comando (CLI). **Por que?** Renderizar a interface gráfica consome até 40% dos recursos de CPU e RAM. Ao desligar a GUI e operar exclusivamente em CLI (Terminal de tela preta), 100% do poder de processamento fica disponível para o banco de dados — padrão de ouro em servidores de produção globais.

---

*Parabéns! A base sólida foi cimentada. Avance para a Missão 2: A Matriz Conectada e a Indústria 4.0.*
