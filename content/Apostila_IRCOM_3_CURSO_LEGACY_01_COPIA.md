# ⚙️ IRCOM 3: Arquitetura de Hardware - Processador, Placa Mãe e Periféricos

> **Carga Horária Estimada:** 24 Horas
> **Foco:** Arquitetura interna do computador, componentes principais (CPU, RAM, Placa Mãe), periféricos e interfaces de conexão.
> **Baseado nos Tópicos Oficiais do SENAI (IRCOM):** Tópico 5.

A arquitetura de hardware é o coração da computação. Compreender como cada componente funciona e se comunica é fundamental para diagnóstico, upgrade e manutenção de sistemas computacionais.

Este capítulo detalha cada subsistema do computador, suas tecnologias e como interoperam.

---

## 🧠 CAPÍTULO 1: O Processador (CPU) (Tópico 5.2)

O processador é o cérebro do computador. Entender sua arquitetura é essencial para escolher e configurar sistemas corretamente.

### 1.1 Anatomia do Processador

| Componente | Função |
|------------|--------|
| **Núcleo (Core)** | Unidade de processamento real |
| **Thread** | Linha de execução virtual (Hyper-Threading/SMT) |
| **Cache L1/L2/L3** | Memória ultrarrápida integrada |
| **Controlador de Memória** | Gerencia acesso à RAM |
| **Controlador de E/S** | Gerencia periféricos |
| **Clock** | Sincroniza operações |
| **Unidade de Controle** | Coordena instruções |
| **ALU** | Realiza cálculos matemáticos |

### 1.2 Características Técnicas

| Especificação | Descrição |
|-------------|-----------|
| **Clock** | Velocidade em GHz (Gigahertz) |
| **Núcleos** | Quantos cores físicos |
| **Threads** | Quantas linhas de execução |
| **Cache** | Memória L1/L2/L3 em MB |
| **TDP** | Calor a dissipar em Watts |
| **Litografia** | Tamanho dos transistores em nm |
| **Soquete** | Tipo de encaixe |

### 1.3 Fabricantes e Linha (Qual escolher?)

**INTEL (atual no mercado brasileiro 2024-2025):**

| Linha | Uso Recomendado | Preço Aproximado | Processador Exemplo |
|-------|-----------------|------------------|---------------------|
| **Celeron** | Básico/Entrada | R$ 1.500 - R$ 2.000 | Celeron N5095 |
| **Pentium** | Entrada básica | R$ 2.000 - R$ 2.500 | Pentium Gold 7505 |
| **Core i3** | Trabalho leve | R$ 2.500 - R$ 4.000 | Core i3-1215U |
| **Core i5** | Trabalho corporativo | R$ 4.000 - R$ 8.000 | Core i5-1240P |
| **Core i7** | Alta performance | R$ 8.000 - R$ 15.000 | Core i7-1270P |
| **Core i9** | Topo de linha | R$ 15.000+ | Core i9-12900H |
| **Xeon** | Servidor/Workstation | R$ 10.000+ | Xeon W-1370P |

> **Dica:** Para trabalho de escritório, Intel Core i5 de 12ª geração (2022) ou 13ª geração (2023) é o ideal! O sufixo indica a finalidade: P = performance, U = Ultrabook (fino), H = High performance.

**AMD (atual no mercado brasileiro 2024-2025):**

| Linha | Uso Recomendado | Preço Aproximado | Processador Exemplo |
|-------|-----------------|------------------|---------------------|
| **Athlon** | Entrada básica | R$ 1.800 - R$ 2.200 | Athlon Silver 3050U |
| **Ryzen 3** | Trabalho leve | R$ 2.500 - R$ 3.500 | Ryzen 3-5425U |
| **Ryzen 5** | Trabalho corporativo | R$ 4.000 - R$ 7.000 | Ryzen 5-5625U |
| **Ryzen 7** | Alta performance | R$ 7.000 - R$ 12.000 | Ryzen 7-5825U |
| **Ryzen 9** | Topo de linha | R$ 12.000+ | Ryzen 9-5900HX |
| **EPYC** | Servidor | R$ 15.000+ | EPYC 7443 |

**Intel vs AMD - Qual escolher?**

| Característica | Intel | AMD |
|----------------|-------|-----|
| **Desempenho single-core** | Vantagem pequena | Quase empatado |
| **Desempenho multi-core** | Bom em i7/i9 | Excelente (Ryzen 5 = i7!) |
| **Consumo de energia** | Um pouco maior | Mais eficiente |
| **Preço** | Mais caro | Melhor custo-benefício |
| **Integrado (laptop)** | UHD Graphics | Radeon Graphics (melhor!) |
| **Suporte no Brasil** | Excelente | Bom |

> **Minha recomendação:** Para orçamento menor, AMD Ryzen 5! Para trabalho corporativo com Intel, Core i5! A diferença de preço entre Ryzen 5 e Core i5 pode chegar a R$ 1.000!

### 1.4 Processadores - Onde Comprar no Brasil

| Loja | Site | Observação |
|------|-----|-----------|
| **Kabum** | kabum.com.br | Uma das mais conhecidas, bons preços |
| **Pichau** | pichau.com.br | Especializada em hardware |
| **TerabyteShop** | terabyteshop.com.br | Bom para notas corporativas |
| **Magazine Luiza** | magazineluiza.com.br | Parcelamento fácil |
| **Americanas** | americanas.com.br | Entrega rápida |
| **Mercado Livre** | mercadolivre.com.br | Used (verificar vendedor!) |

> **Atenção:** Verifique sempre o preço com imposto! Lojas como Magazine Luiza já cobram taxa de 20%+.
| **Ryzen 5** | Linha intermediária |
| **Ryzen 7** | Performance alta |
| **Ryzen 9** | Topo de linha |
| **EPYC** | Servidor |

### 1.4 Tecnologias Importantes

**Hyper-Threading (Intel) / SMT (AMD):**
Permite que cada núcleo físico execute 2 threads. Um i5 de 6 núcleos aparece como 12 processadores.

**Turbo Boost / Precision Boost:**
Aumenta automaticamente o clock quando preciso. clock base vs turbo.

**Cache:**
| Nível | Localização | Velocidade | Tamanho Típico |
|-------|-------------|------------|-----------------|
| L1 | Dentro do core | Mais rápida | 32-64KB por core |
| L2 | Próximo ao core | Muito rápida | 256KB-1MB |
| L3 | Compartilhado | Rápida | 8-64MB |

**Instruções SIMD:**
- SSE (Streaming SIMD Extensions)
- AVX (Advanced Vector Extensions)
- Usadas para multimídia e IA

### 1.5 Soquetes e Gerações

**Intel (atual — 2024/2025):**
| Soquete | Processadores |
|---------|---------------|
| LGA1700 | 12ª, 13ª, 14ª Gen (Core i3-i9) |
| LGA1200 | 10ª, 11ª Gen |
| LGA1151 | 6ª-9ª Gen |

**AMD:**
| Soquete | Processadores |
|---------|---------------|
| AM5 | Ryzen 7000 (DDR5) |
| AM4 | Ryzen 1000-5000 |
| TR4 | Threadripper |

> **Importante:** Soquete incompatível = processador não serve. Nunca force encaixe!

---

## 🔌 CAPÍTULO 2: Placa Mãe (Motherboard) (Tópico 5.4)

A placa-mãe conecta todos os componentes. Entender sua arquitetura é fundamental para upgrades e diagnóstico.

### 2.1 Componentes da Placa-Mãe

| Componente | Função |
|------------|--------|
| **Soquete** | Encaixe do processador |
| **Slots RAM** | Encaixe da memória |
| **Chipset** | Controla comunicação |
| **Slots PCIe** | Placas de expansão |
| **Portas SATA/NVMe** | Armazenamento |
| **Portas I/O** | Conectores traseiros |
| **BIOS/UEFI** | Firmware de boot |
| **Conector Força** | Energia da fonte |
| **VRMs** | Reguladores de tensão |

### 2.2 Chipset

O chipset é o "gerente de tráfego" da placa-mãe:

| Série Intel | Características |
|------------|----------------|
| H (Entry) | Básica, sem overclock |
| B (Business) | Intermediária |
| Z (Performance) | Overclock, multi-GPU |
| X (Enthusiast) | Servidor/workstation |

| Série AMD | Características |
|----------|----------------|
| A | Entrada |
| B | Intermediária |
| X | High-end |
| TRX40 | Threadripper |

### 2.3 Slots de Memória (RAM)

**Tipos de memória no mercado brasileiro:**

| Geração | Velocidade | Voltagem | Disponível? |
|---------|------------|----------|-------------|
| DDR | 200-400 MT/s | 2.5V | Antigo (raro) |
| DDR2 | 400-1066 MT/s | 1.8V | Antigo (raro) |
| DDR3 | 800-2133 MT/s | 1.5V | ainda encontrado em usado |
| DDR4 | 2133-3200 MT/s | 1.2V | **Padrão atual** |
| DDR5 | 4800-8400 MT/s | 1.1V | 2024-2025 (novo) |

> **Dica:** DDR4 é o padrão em 2024-2025. Se for comprar PC novo, DDR5 ainda é mais caro!

**Dual Channel - Por que Importa?**

Colocar 2 pentes de RAM em vez de 1 DOBRA a velocidade de transferência!

```
Single Channel (1x8GB):    ~25 GB/s
Dual Channel (2x8GB):    ~50 GB/s
```

**Configuração ideal no Brasil:**
- Trabalho escritório: 2x8GB (16GB) em dual channel = R$ 250-400
- Trabalho pesado: 2x16GB (32GB) = R$ 500-800
- Edição de vídeo: 4x16GB (64GB) = R$ 1.000-1.500

**Marcas de memória confiáveis no Brasil:**
- Kingston ( Fury, ValueRAM)
- Corsair ( Vengeance, Dominator)
- Crucial (Ballistix)
- G.Skill (Trident)
- Samsung (original de fábrica)

### 2.4 Slots PCIe (Placas de Expansão)

| Slot | Slots | Largura de Banda |
|------|------|----------------|
| x1 | 1 | 1GB/s |
| x4 | 4 | 4GB/s |
| x8 | 8 | 8GB/s |
| x16 | 16 | 16GB/s (GEN3) |

**Gerações:**
- PCIe 1.0: 250MB/s por lane
- PCIe 2.0: 500MB/s por lane
- PCIe 3.0: 1GB/s por lane
- PCIe 4.0: 2GB/s por lane
- PCIe 5.0: 4GB/s por lane

**Usos:**
- x16: GPU dedicada
- x4: NVMe (SSD de alta velocidade)
- x4/x8: Placas de rede 10GbE
- x1: Placas de som, expansão USB

### 2.5 Portas e Interfaces

**Portas Traseiras Típicas:**
| Porta | Função |
|-------|-------|
| USB-A | Periféricos tradicionais |
| USB-C | Novo padrão (dados+vídeo+energia) |
| HDMI/DisplayPort | Vídeo |
| RJ-45 | Rede (1GbE ou 10GbE) |
| Áudio 3.5mm | Som |
| S/PDIF | Áudio óptico |

**Conectores Internos:**
| Conector | Função |
|---------|-------|
| SATA | HD/SSD (6Gb/s) |
| M.2 | SSD NVMe |
| USB Header | Portas frontais |
| Audio Header | Áudio frontal |
| PCIe Power | Placas de vídeo |

---

### 2.6 BIOS vs UEFI - Qual a Diferença?

**BIOS (Basic Input/Output System):**
- Interface de texto simples (tela azul/preta)
- Mais antigo (desde 1981)
- Suporta apenas HDs de até 2TB
- Inicialização mais lenta
- Não tem mouse

**UEFI (Unified Extensible Firmware Interface):**
- Interface gráfica moderna (com mouse!)
- Suporta HDs maiores de 2TB (GPT)
- Inicialização mais rápida
- Segurança melhor (Secure Boot)
- **É o padrão em computadores modernos!**

**Como acessar o BIOS/UEFI:**
1. Ligue o computador
2. Pressione Del, F2, F10 ou Esc (depende da marca)
3. Acesse a tela de configuração

**Marcas de placa-mãe mais vendidas no Brasil:**
| Marca | Preço | Características |
|-------|-------|----------------|
| **ASUS** | R$ 500 - R$ 3.000 | Qualidade premium, boa refrigeração |
| **Gigabyte** | R$ 400 - R$ 2.500 | Custo-benefício |
| **MSI** | R$ 500 - R$ 2.000 | Gaming e trabalho |
| **ASRock** | R$ 300 - R$ 1.500 | Entrada/intermediário |
| **Biostar** | R$ 250 - R$ 800 | Básica |

---

## 🔊 CAPÍTULO 3: Periféricos (Tópicos 5.1, 5.7, 5.8)

Periféricos são dispositivos externos que expandem a funcionalidade do computador.

### 3.1 Periféricos de Entrada

| Dispositivo | Função |
|------------|--------|
| **Teclado** | Entrada de texto |
| **Mouse** | Ponteiro gráfico |
| **Scanner** | Digitalização de documentos |
| **Leitor de Código** | Leitura de códigos |
| **Webcam** | Captura de vídeo |
| **Microfone** | Entrada de áudio |
| **Mesa Digitalizadora** | Desenho profissional |
| **Leitor de Impressão Digital** | Autenticação biométrica |

### 3.1.1 Periféricos no Mercado Brasileiro

**Teclados mais vendidos no Brasil:**
| Marca | Modelo | Preço | Características |
|-------|--------|-------|-----------------|
| **Logitech** | K380 | R$ 250 | Bluetooth, multiplataforma |
| **Logitech** | MX Keys | R$ 600 | Premium, iluminação |
| **Microsoft** | Keyboard 850 | R$ 150 | Básico confiável |
| **Multilaser** | TC204 | R$ 60 | Entrada, cabo USB |

**Mouse mais vendidos no Brasil:**
| Marca | Modelo | Preço | Uso |
|-------|--------|-------|-----|
| **Logitech** | M90 | R$ 40 | Básico |
| **Logitech** | MX Master 3 | R$ 700 | Premium, Flow |
| **Microsoft** | Sculpt | R$ 250 | Ergonômico |
| **Razer** | DeathAdder | R$ 300 | Gamer |

### 3.2 Periféricos de Saída

| Dispositivo | Função |
|------------|--------|
| **Monitor** | Exibição visual |
| **Impressora** | Impressão em papel |
| **Caixas de Som** | Saída de áudio |
| **Projetor** | Exibição em tela grande |
| **Plotter** | Impressão grande formato |

### 3.3 Periféricos de Entrada e Saída

| Dispositivo | Função |
|------------|--------|
| **Touchscreen** | Entrada + Saída (toque) |
| **Headset** | Áudio entrada + saída |
| Multifuncional | Impressão + scanner + cópia |
| **HUB USB** | Expansão de portas |

### 3.4 Interfaces de Conexão

| Interface | Velocidade | Uso |
|-----------|------------|------|
| **USB 2.0** | 480Mb/s | Teclado, mouse, impressão |
| **USB 3.0/3.1** | 5-10Gb/s | HDs externos, PENs |
| **USB 3.2/USB4** | 10-40Gb/s | Dispositivos modernos |
| **Thunderbolt 3/4** | 40Gb/s | docks, eGPUs |
| **Bluetooth** | 3Mb/s | Wireless (mouse, headset) |
| **Wi-Fi 6** | 9.6Gb/s | Rede wireless |
| **HDMI 2.1** | 48Gb/s | Vídeo 8K |
| **DisplayPort 2.1** | 80Gb/s | Vídeo múltiplos |

### 3.5 Padrões de Vídeo

| Padrão | Resolução Máx. | Uso |
|--------|----------------|-----|
| **VGA/D-Sub** | 640x480 | Antigo (evitar) |
| **DVI** | 2560x1600 | Legacy |
| **HDMI 1.4** | 3840x2160 (4K@30Hz) | TV/monitor |
| **HDMI 2.0** | 3840x2160 (4K@60Hz) | Gaming |
| **HDMI 2.1** | 7680x4320 (8K@60Hz) | Moderno |
| **DisplayPort 1.4** | 7680x4320 (8K@60Hz) | Monitor profissional |
| **DisplayPort 2.1** | 8K@120Hz | Tecnologia de ponta |

### 3.6 Placas de Expansão

| Placa | Função |
|-------|-------|
| **GPU Dedicada** | Processamento gráfico, IA |
| **Placa de Rede** | Rede 10GbE, dual |
| **Placa de Som** | Áudio profissional |
| **RAID Controller** | Arrays de disco |
| **USB Expansion** | Mais portas |

---

## 🔌 CAPÍTULO 4: Barramentos e Comunicação (Tópico 5.10)

Os barramentos são os "corredores" de dados entre componentes.

### 4.1 Hierarquia de Barramentos

```
CPU (via HyperTransport/Infinity Fabric)
    ↓ PCIe (x16/x8/x4/x1)
        GPU
        NVMe
        Placas de expansão
    ↓ DMI/Infinity Fabric
        Chipset
            ↓ DMI 4.0
                Portas SATA
                USB
                Áudio
```

### 4.2 Barramentos de Dados

| Barramento | Uso | Velocidade |
|------------|-----|-----------|
| **PCIe** | Expansão | 1-32GB/s |
| **SATA III** | Armazenamento | 6Gb/s |
| **NVMe** | SSD | 3.5-16GB/s |
| **USB 3.2** | Periféricos | 10-20Gb/s |
| **Thunderbolt** | docks, eGPU | 40Gb/s |
| **DDR5** | RAM | 38-102GB/s |

### 4.3 IRQ (Interrupt Request)

IRQs são "chamados de urgência" que componentes fazem para atrair a atenção da CPU:

| IRQ | Dispositivo Padrão |
|-----|-------------------|
| 0 | Timer do sistema |
| 1 | Teclado |
| 2 | Cascade (IRQ 9) |
| 3 | COM2 (Serial 2) |
| 4 | COM1 (Serial 1) |
| 5 | Paralelo / Placa de som |
| 6 | Controladora de floppy |
| 7 | Impressora |
| 8 | RTC (relógio) |
| 12 | Mouse PS/2 |
| 13 | Coprocessador matemático |
| 14 | Disco primário (IDE) |
| 15 | Disco secundário |

Dispositivos modernos usam **MSI (Message Signaled Interrupts)** em vez de IRQs fixos.

### 4.4 Endereçamento

| Tipo | Endereço |
|------|----------|
| **Porta I/O** | Endereços de 8/16 bits |
| **Endereço de Memória** | MMIO (MemoryMapped I/O) |
| ** IRQ** | Linhas de interrupção |
| **DMA** | Acesso direto à memória |

---

## 🔧 CAPÍTULO 5: Interfaces de Rede (Tópicos 5.8.6 a 5.8.8)

### 5.1 Placas de Rede (NIC)

| Tipo | Velocidade | Uso |
|------|------------|-----|
| **1GbE** | 1Gbps | Escritório |
| **2.5GbE** | 2.5Gbps | Upgrade |
| **10GbE** | 10Gbps | Servidor/datacenter |
| **25GbE+** | 25Gbps+ | Datacenter |

### 5.2 Interfaces Wireless

| Padrão | Velocidade | Frequência |
|--------|------------|------------|
| **Wi-Fi 4 (n)** | 600Mbps | 2.4GHz/5GHz |
| **Wi-Fi 5 (ac)** | 3.5Gbps | 5GHz |
| **Wi-Fi 6 (ax)** | 9.6Gbps | 2.4GHz/5GHz/6GHz |
| **Wi-Fi 6E** | 9.6GHz | 6GHz (nova frequência) |
| **Wi-Fi 7 (be)** | 46Gbps | Todas |

### 5.3 PoE (Power over Ethernet)

Permite energia + dados pelo cabo de rede:

- PoE: até 15.4W
- PoE+: até 25.5W
- PoE++: até 60W-90W

Uso: Câmeras IP, access points, telefones VoIP.

---

## 🔌 CAPÍTULO 6: Interfaces Legadas e Unidades Ópticas (Tópicos 5.6.2, 5.8.3, 5.8.4, 5.8.5, 5.8.8)

Embora USB e SSD tenham substituído a maioria dessas tecnologias, elas ainda aparecem em equipamentos industriais, sistemas legados e contextos específicos. Conhecê-las é essencial para diagnóstico e manutenção.

---

### 6.1 Unidades de Armazenamento Óptico (Tópico 5.6.2)

A unidade óptica usa feixes de laser para ler e gravar dados em discos reflexivos.

#### Anatomia da Unidade Óptica

| Componente | Função |
|-----------|--------|
| **Laser** | Emite feixe de luz para leitura/gravação |
| **Fotodiodo** | Detecta a luz refletida |
| **Motor** | Gira o disco em velocidades específicas |
| **Tray (bandeja)** | Suporte do disco |
| **Atuador** | Move a cabeça de leitura |
| **Buffer/Cache** | Memória temporária para dados |

#### Tipos de Discos e Velocidades

| Tipo | Capacidade | Uso | Velocidade Base |
|------|------------|-----|-----------------|
| **CD-ROM** | 700MB | Apenas leitura | 150 KB/s |
| **CD-R** | 700MB | Gravação única | 150 KB/s |
| **CD-RW** | 700MB | Regravável | 150 KB/s |
| **DVD-5** | 4.7GB | Leitura/gravação | 1.38 MB/s |
| **DVD-9** | 8.5GB | Camada dupla | 1.38 MB/s |
| **DVD-RW** | 4.7GB | Regravável | 1.38 MB/s |
| **Blu-ray** | 25GB | Alta densidade | 4.5 MB/s |
| **Blu-ray DL** | 50GB | Camada dupla | 4.5 MB/s |

#### Velocidades de Rotação

A velocidade é expressa como múltiplo de "1x":
- **1x CD** = 150 KB/s
- **4x CD** = 600 KB/s
- **8x DVD** = 11 MB/s
- **16x DVD** = 22 MB/s
- **6x Blu-ray** = 27 MB/s

#### Onde Ainda São Usados no Brasil

Embora obsoletos para uso geral, ainda aparecem em:
- **Leitura de manuais de equipamentos industriais** (alguns fornecedores ainda enviam drivers em CD)
- **Equipamentos médicos legados** (raio-X, tomógrafos antigos)
- **Sistemas de automação** (CLPs antigos com interface para CD)
- **Setores governamentais** (sistemas que exigem arquivamento em mídia física)
- **Retrofit** (atualização de máquinas antigas)

> **Dica de Professor:** Se você encontrar um equipamento com drive de CD/DVD, verifique se o disco está sujo ou arranhado. Muitos "problemas de leitura" são resolvidos com limpeza! Use um pano macio do centro para fora.

---

### 6.2 Interface Serial RS-232 (Tópico 5.8.4)

A porta serial é uma das interfaces mais antigas da computação. Permite comunicação bit a bit em sequência.

#### Características Técnicas

| Especificação | Descrição |
|--------------|-----------|
| **Conector** | DB9 (macho) ou DB25 |
| **Pinos ativos** | 2 (TX, RX) + Terra |
| **Taxa máxima** | 115.200 bps |
| **Distância máxima** | 15 metros |
| **Tipo de sinal** | Tensão (-15V a +15V) |

#### Pinagem DB9

| Pino | Função | Abreviação |
|------|--------|------------|
| 1 | Detecção de portadora | DCD |
| 2 | Receber dados | RXD |
| 3 | Transmitir dados | TXD |
| 4 | Terminal de dados pronto | DTR |
| 5 | Terra | GND |
| 6 | Dataset ready | DSR |
| 7 | Request to send | RTS |
| 8 | Clear to send | CTS |
| 9 | Ring indicator | RI |

#### Onde Ainda É Usada

- **Equipamentos de rede** (switches, roteadores - console de configuração)
- **Sistemas de automação industrial** (CLPs, CNCs)
- **Equipamentos médicos** (monitores de sinais vitais)
- **Caixas registradoras** (alguns modelos antigos)
- **Sistemas de controle de acesso** (catracas, cancelas)

#### Exemplo de Uso Industrial no Brasil

Em uma fábrica de usinagem em Sertãozinho, o CNC (Comando Numérico Computadorizado) de um torno pode ter porta serial para:
- Baixar programas de usinagem do computador
- Fazer backup de parâmetros
- Diagnosticar falhas

---

### 6.3 Interface Paralela (LPT) (Tópico 5.8.5)

A porta paralela transmitia 8 bits simultaneamente, sendo mais rápida que a serial para curtas distâncias.

#### Características Técnicas

| Especificação | Descrição |
|--------------|-----------|
| **Conector** | DB25 (fêmea) |
| **Pinos de dados** | 8 (bidirecional) |
| **Taxa máxima** | 2 MB/s (modo EPP) |
| **Distância máxima** | 2 metros |
| **Modo ECP/EPP** | Alta velocidade bidirecional |

#### Pinagem DB25

| Pino | Função |
|------|--------|
| 1 | Strobe |
| 2-9 | Dados (D0-D7) |
| 10 | Acknowledge |
| 11 | Busy |
| 12 | Paper end |
| 13 | Select |
| 14 | Auto feed |
| 15 | Error |
| 16 | Init |
| 17 | Select in |
| 18-25 | Terra (GND) |

#### Onde Ainda É Usada

- **Impressoras matriciais** (alguns setores ainda usam por economia de tinta)
- **Scanners antigos** (engenharias, cartórios)
- **PLCs antigos** (automação)
- **Portas de diagnóstico** (alguns equipamentos industriais)

> **Atenção:** A porta paralela foi praticamente abandonada após 2010. Se você encontrar um dispositivo com essa interface, provavelmente é equipamento antigo ou legado.

---

### 6.4 Modems (Tópico 5.8.3)

Modem = Modulador/Demodulador. Converte sinais digitais em analógicos para transmissão.

#### Tipos de Modem

| Tipo | Velocidade | Uso |
|------|------------|-----|
| **Discado (dial-up)** | 56 Kbps | Legacy (ainda existe em áreas rurais) |
| **ADSL** | Até 24 Mbps | Residências e pequenos negócios |
| **VDSL** | Até 100 Mbps | Fibra curta distância |
| **Módulo industrial** | 300 bps - 115 Kbps | Automação, telemetria |

#### Como Funciona

```
Computador (sinal digital) → MODEM → Linha telefônica (sinal analógico) → MODEM → Computador
```

#### Uso Industrial

- **SCADA (Supervisory Control and Data Acquisition):** Antigas redes de monitoramento usavam modem para comunicar dados de sensores distantes
- **Telemetria:** Medidores de energia elétrica antigos enviavam dados por linha telefônica
- **Automação de subestações:** Energia elétrica usava modem para comunicar status

#### Modems Industriais no Brasil

| Fabricante | Modelo | Uso |
|------------|--------|-----|
| **Multitech** | MultiModem | Industrial |
| **Siemens** | 0MC10 | Automação |
| **RAD** | SHM | Telecom |

---

### 6.5 Firewire (IEEE 1394) (Tópico 5.8.8)

Firewire era uma alternativa ao USB para alta velocidade.

#### Características Técnicas

| Especificação | Velocidade | Conector |
|--------------|------------|----------|
| **Firewire 400** | 400 Mbps | 6 pinos ou 4 pinos |
| **Firewire 800** | 800 Mbps | 9 pinos |
| **S3200** | 3.2 Gbps | Apenas beta |

#### Comparação com USB

| Característica | USB 2.0 | Firewire 400 |
|---------------|---------|--------------|
| **Velocidade** | 480 Mbps | 400 Mbps |
| **Hot swap** | Sim | Sim |
| **Conexão em rede** | Não (exceto USB OTG) | Sim (peer-to-peer) |
| **Alimentação** | 5V, 500mA | 30V, 1.5A |

#### Onde Era Usado

- **Captura de vídeo** (filmadoras profissionais usavam Firewire)
- **Edição de vídeo profissional** (conexão entre câmera e computador)
- **Scanners profissionais** (high-end)
- **Armazenamento externo** (DAFS - Direct Access File System)

> **Contexto Histórico:** O Firewire foi criado pela Apple em 1995 e competiu com USB. A Apple abandonou o Firewire em 2008, e o USB 3.0 tornou a tecnologia obsoleta. Hoje é raramente encontrado.

---

## 🔧 ATIVIDADE DE LABORATÓRIO 6: Identificação de Interfaces Legadas

**Objetivo:** Identificar portas legacy em equipamentos e entender sua aplicação.

**Passo a Passo:**

1. **Pesquisa de campo:**
   - Identificar em quais equipamentos do laboratório ou escola você encontra portas legadas
   - Fotografar os conectores DB9, DB25, Firewire se disponíveis

2. **Comparativo de velocidades:**
   - Criar tabela comparando as velocidades teóricas de cada interface

3. **Pesquisa de mercado:**
   - Verificar se ainda é possível comprar adaptadores (USB para Serial, USB para Paralela)
   - Qual o preço no Brasil (Kabum, Amazon)

**Questionário de entrega:**
1. Em que situação você ainda precisaria de uma porta serial RS-232?
2. Por que a porta USB substituiu a maioria das interfaces legadas?
3. Qual interface legacy você encontrou em equipamentos da escola?

---

**Pesquise em casa:** Quantos equipamentos da sua casa ou trabalho ainda têm portas DB9, DB25 ou Firewire?

---

## ⚠️ ERROS COMUNS EM HARDWARE (Evite Esses no Trabalho!)

1.  **Comprar memória DDR errada:** Se a placa-mãe aceita DDR4, um pente DDR5 não encaixa fisicamente. O chanfro é em posição diferente! Antes de comprar, verifique no manual ou no site da fabricante.
2.  **Ignorar o TDP do processador:** Se o processador é de 125W (TDP) e o cooler suporta apenas 65W, ele vai superaquecer e desligar sozinho. Sempre confira a compatibilidade!
3.  **Esquecer de ativar Dual Channel:** Muitos técnicos colocam 2 pentes de RAM nos slots errados (lado a lado). Dual Channel exige slots alternados (1 e 3, ou 2 e 4). Verifique o manual da placa-mãe!
4.  **Confundir PCIe x1 com x16:** Uma placa de vídeo não encaixa num slot x1. Ela precisa de x16. Parece óbvio, mas em placas-mãe compactas (mATX/ITX), os slots são muito próximos.
5.  **Não atualizar o BIOS antes de trocar o processador:** Se você comprar um Ryzen 5 7600 (AM5) e a placa-mãe veio com BIOS antigo, o processador pode não ser reconhecido. Atualize o BIOS ANTES de instalar!

---

## 🏭 CONTEXTO INDUSTRIAL: Hardware em Fábricas e Usinas

**Cenário Real — Linha de Produção em Fábrica de Auto Peças:**

Em uma fábrica, os computadores sofrem condições muito mais severas que em um escritório:

| Desafio | Solução Técnica |
|---------|------------------|
| **Poeira de metal** | Gabinetes selados (IP54), filtros industriais |
| **Vibração de máquinas** | SSDs (sem partes móveis) em vez de HDs |
| **Temperatura de 45°C+** | Coolers industriais, ar condicionado de precisão |
| **Picos de energia** | No-breaks senoidais, aterramento dedicado |
| **Ambiente úmido** | Revestimento conformal nas placas (coating) |

**Marcas de PCs industriais disponíveis no Brasil:**
- **Advantech** — Líder mundial em PCs industriais (representante no Brasil)
- **Siemens SIMATIC** — IPCs para automação (usados em usinas)
- **Dell Embedded Box** — PCs compactos para chão de fábrica
- **Preços:** R$ 5.000 a R$ 30.000 dependendo da classificação IP e especificações

> **Dica de Professor:** Se você trabalhar em uma fábrica de alimentos (como as de Sertãozinho), os PCs precisam ter certificação de higiene. Gabinetes de aço inox são obrigatórios em áreas de produção!

---

## 🧠 PROVA FINAL: Teste Seus Conhecimentos

**Questão 1:**
O que é Hyper-Threading?

a) Uma forma de overclock
b) Tecnologia que simula múltiplos threads por núcleo
c) Um tipo de memória
d) Uma porta USB

<details>
<summary>👀 Ver Resposta</summary>
<b>Resposta:</b> B) Tecnologia que simula múltiplos threads por núcleo<br>
<b>Explicação:</b> Hyper-Threading (Intel) permite que cada núcleo físico execute 2 threads simultâneos.
</details>

---

**Questão 2:**
Qual slot é usado para SSD NVMe?

a) SATA
b) PCIe x4
c) USB
d) DDR

<details>
<summary>👀 Ver Resposta</summary>
<b>Resposta:</b> B) PCIe x4<br>
<b>Explicação:</b> SSDs NVMe usam o barramento PCIe para performance máxima.
</details>

---

**Questão 3:**
O que é o chipset da placa-mãe?

a) O processador
b) O gerenciador de tráfego entre componentes
c) A memória RAM
d) A fonte de alimentação

<details>
<summary>👀 Ver Resposta</summary>
<b>Resposta:</b> B) O gerenciador de tráfego entre componentes<br>
<b>Explicação:</b> O chipset controla a comunicação entre CPU, RAM, armazenamento e periféricos.
</details>

---

**Questão 4:**
Qual velocidade máxima do USB 3.2?

a) 480Mb/s
b) 5Gb/s
c) 10Gb/s
d) 40Gb/s

<details>
<summary>👀 Ver Resposta</summary>
<b>Resposta:</b> C) 10Gb/s (USB 3.2 Gen 2)<br>
<b>Explicação:</b> USB 3.2 Gen 2 chega até 10Gb/s, sendo Gen 2x2 até 20Gb/s.
</details>

---

## 📚 Leituras Complementares Recomendadas

**Livros:**
- "Arquitetura e Montagem de Computadores" - SENAI Digital
- "Hardware: Versão Revisada e Atualizada" - Gabriel Torres
- "Manutenção de Micros na Prática" - Laércio Vasconcelos

**Canais do YouTube (em português):**
- "Bóson Treinamentos" - Hardware completo
- "Curso de Hardware" - Wr Studios
- "Informática de A a Z"

**Sites de referência:**
- www.hardware.com.br - Reviews e comparativos
- www.techtudo.com.br - Matérias de tecnologia
- www.pinifeste.com.br - Especificações de processadores

---

## 💡 Resumo do Capítulo: O Que Você Aprendeu

### 🧠 Processador (CPU)
- Anatomia: núcleos, threads, cache, clock
- Intel vs AMD: qual escolher para cada uso
- Soquetes: cuidado com incompatibilidade!
- Onde comprar no Brasil: Kabum, Pichau, Magazine Luiza

### 🔌 Placa-Mãe
- Chipset: H, B, Z (Intel) e A, B, X (AMD)
- Memória RAM: DDR4 (padrão atual), dual channel
- Slots PCIe: x1, x4, x8, x16
- BIOS vs UEFI: UEFI é mais moderno

### 🔊 Periféricos
- Entrada: teclado, mouse, scanner, webcam
- Saída: monitor, impressora, caixas de som
- Portas: USB-A, USB-C, HDMI, DisplayPort

### 🔌 Barramentos
- USB: 2.0, 3.0, 3.1, 3.2, USB-C
- PCIe: gerações 1.0 a 5.0

---

## 📎 Glossário Rápido

- **GHz:** Velocidade do processador (1 GHz = 1 bilhão de ciclos/segundo)
- **Núcleo:** Unidade de processamento dentro do processador
- **Thread:** Linha de execução virtual
- **Cache:** Memória rápida integrada ao processador
- **TDP:** Quantidade de calor gerado
- **Dual Channel:** Usar 2 pentes de RAM juntos
- **UEFI:** BIOS moderno com interface gráfica

---

## 🔍 Dicas para a Prova

1. **DDR4 = padrão atual em 2024** - DDR5 ainda é caro!
2. **Intel i5 = trabalho corporativo** - i3 é muito básico
3. **AMD Ryzen 5 rivaliza com Intel i7** - melhor custo-benefício!
4. **USB 3.0 = 5Gb/s** - muito mais rápido que 2.0 (480Mb/s)!
5. **Dual channel DOBRA a velocidade** - sempre use 2 pentes!

---

## 🎯 Próximos Passos

Antes de avançar para a Unidade 4:
- [x] Conhecer processadores Intel e AMD atuais
- [x] Entender o chipset e os soquetes
- [x] Saber escolher memória RAM
- [x] Conhecer periféricos e portas

**Prepare-se:** Na Unidade 4, você vai aprender sobre armazenamento: HD, SSD, NVMe! Qual é mais rápido? Quando usar cada um?

---

*Parabéns! Você completou a Unidade 3. Avance para a Unidade 4: Armazenamento.*