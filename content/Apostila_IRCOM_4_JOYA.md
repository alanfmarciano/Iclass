# 💾 IRCOM 4: Armazenamento, Fontes e Gabinetes

> **Carga Horária Estimada:** 24 Horas
> **Foco:** Tecnologias de armazenamento (HD, SSD), fontes de alimentação e gabinetes. Instalação e configuração.
> **Baseado nos Tópicos Oficiais do SENAI (IRCOM):** Tópico 5.6 e Tópico 5.9.

O armazenamento é onde ficam os dados. A escolha correta entre HD e SSD, entender as diferenças de tecnologias e saber configurar redundância são habilidades essenciais para qualquer profissional de T.I.

Este capítulo detalha as tecnologias de armazenamento, fontes de alimentação e gabinetes, permitindo escolhas informadas e instalação correta.

---

## 💿 CAPÍTULO 1: Unidades de Armazenamento (Tópicos 5.6.1 a 5.6.3)

### 1.1 HD (Hard Disk / Disco Rígido)

O HD tradicional usa discos magnéticos giratórios. É a tecnologia mais antiga ainda em uso.

#### Anatomia do HD

| Componente | Função |
|-----------|--------|
| **Prato** | Disco magnético para dados |
| **Eixo** | Gira os pratos |
| **Braço** | Move as cabeças de leitura |
| **Cabeça** | Lê/escreve magneticamente |
| **Atuador** | Controla o braço |
| **Motor** | Gira o eixo |
| **Controladora** | Controladora eletrônica do HD |
| **Cache/Buffer** | Memória temporária |

#### Especificações Técnicas

| Especificação | Descrição |
|--------------|----------|
| **Capacidade** | 500GB a 18TB |
| **RPM** | 5400, 7200, 10KRPM |
| **Cache** | 64MB a 512MB |
| **Interface** | SATA III (6Gb/s) |
| **Taxa de leitura** | 150-250MB/s |
| **Latência** | 2-5ms |
| **MTBF** | 1-2 milhões de horas |

#### Tipos de HD

| Tipo | Uso | Características |
|------|-----|---------------|
| **Desktop** | Uso geral | 7200RPM, boa performance |
| **NAS** | Storage em rede | Confiabilidade, 24/7 |
| **Datacenter** | Servidores | Alta confiabilidade, enterprise |
| **SMR** | Arquivo frio | Alta densidade, writes lentos |
| **SSHD** | Híbrido | SSD + HDD |

#### Vantagens e Desvantagens

| ✅ Vantagens | ❌ Desvantagens |
|--------------|---------------|
| Custo por GB baixo | Partes móveis = falha |
| Alta capacidade | Lento (vs SSD) |
| Boa longevidade | Ruído e calor |
| Recuperação possível | Consumo maior |

### 1.2 SSD (Solid State Drive)

SSD não tem partes móveis. Usa memória flash para armazenamento ultrarrápido.

#### Tecnologias de Memória Flash

| Tipo | Células | Endurance | Custo |
|------|--------|-----------|--------|
| **SLC** | 1 bit | 50K-100K ciclos | Alto |
| **MLC** | 2 bits | 3K-10K ciclos | Médio |
| **TLC** | 3 bits | 1K-3K ciclos | Baixo |
| **QLC** | 4 bits | ~1K ciclos | Muito baixo |

> **Nota:** TLC é o padrão atual. Os ciclos são suficientes para uso normal (anos).

#### Tipos de SSD

| Tipo | Interface | Velocidade | Uso |
|------|-----------|-----------|-----|
| **SATA SSD** | SATA III | ~550MB/s | Upgrade de HD |
| **M.2 SATA** | SATA III | ~550MB/s | Notebook |
| **M.2 NVMe** | PCIe x4 | 3-7GB/s | Performance |
| **M.2 NVMe Gen5** | PCIe x4 | 12GB/s+ | Cutting edge |
| **U.2** | PCIe x4 | 3-7GB/s | Servidor |

#### Comparativo de Performance

| Métrica | HD 7200RPM | SATA SSD | NVMe Gen4 |
|---------|-----------|---------|----------|
| **Leit. Seq.** | 200MB/s | 550MB/s | 7GB/s |
| **Escrita Seq.** | 200MB/s | 530MB/s | 5GB/s |
| **Leit. Rand.** | 1MB/s | 100MB/s | 1MB/s |
| **Latência** | 5ms | 0.1ms | 0.02ms |
| **IOPS** | 100 | 90K | 1M |

#### Especificações NVMe

| Geração | Bandwidth | IOPS |
|---------|----------|------|
| **Gen3** | 3.9GB/s | 500K |
| **Gen4** | 7.9GB/s | 1M |
| **Gen5** | 15.7GB/s | 2M |

#### Formatos Físicos

| Formato | Dimensões | Uso |
|---------|----------|-----|
| **2.5"** | 100x70x7mm | Desktop |
| **M.2 2280** | 22x80mm | Desktop/notebook |
| **M.2 2260** | 22x60mm | Compacto |
| **M.2 2242** | 22x42mm | Ultrabook |
| **U.2** | 2.5" | Servidor |

#### Vantagens e Desvantagens

| ✅ Vantagens | ❌ Desvantagens |
|--------------|---------------|
| Extremamente rápido | Custo por GB alto |
| Sem partes móveis | Recuperação difícil |
| Baixo tempo de acesso | Dados perdidos se falha |
| Silencioso | |
| Eficiente | |

### 1.3 NVMe vs SATA: Qual Escolher?

| Cenário | Recomendação |
|--------|-------------|
| Boot + Programas | NVMe (prioridade) |
| Jogos | NVMe |
| Arquivos grandes | NVMe ou SATA (custo) |
| Backup/frio | HD |
| Servidor | NVMe + HD |
| Notebook fino | M.2 SATA ou NVMe |

### 1.4 Instalação de SSD

#### SSD SATA

1. Conectar cabo SATA na PSU
2. Conectar SATA na placa-mãe (porta SATA)
3. Fixar com parafusos (se necessário)
4. Bootar e verificar no BIOS

#### SSD NVMe M.2

1. Identificar slot M.2 (ver manual)
2. Inserir no ângulo correto
3. Pressionar e fixar com parafuso
4. Verificar no BIOS

### 1.5 Sistemas de Arquivo

| Sistema | SO | Limite Arquivo | Limite Volume |
|---------|-----|-------------|-------------|
| **FAT32** | Todos | 4GB | 8TB |
| **exFAT** | Win/Mac | 16EB | 16EB |
| **NTFS** | Windows | 16TB | 256TB |
| **ext4** | Linux | 16TB | 1EB |
| **APFS** | macOS | 8EB | 256TB |
| **Btrfs** | Linux | 16EB | 16EB |

---

## ⚡ CAPÍTULO 2: Fontes de Alimentação (Tópico 5.9)

A fonte é o componente mais crítico. Uma fonte ruim pode destruir todos os outros componentes.

### 2.1 Funções da Fonte

- Converter AC (tomada) para DC (computador)
- Estabilizar a tensão
- Proteger contra picos
- Distribuir energia para componentes

### 2.2 Especificações

| Especificação | Descrição |
|--------------|----------|
| **Potência** | 300W a 1600W |
| **Entrada** | 110-240V AC |
| **Saídas** | +12V, +5V, +3.3V, -12V |
| **Eficiência** | 80+ Bronze a Titanium |
| **PFC** | Ativo ou Passivo |
| **Modular** | Total/semi/não |

### 2.3 Certificações de Eficiência

| Certificação | Eficiência Mínima | uso |
|-------------|-------------------|-----|
| **80+ White** | 70% | Básico |
| **80+ Bronze** | 80% | Entry |
| **80+ Silver** | 82% | intermediário |
| **80+ Gold** | 85% | Recomendado |
| **80+ Platinum** | 90% | high-end |
| **80+ Titanium** | 94% | Servidor |

> **Por que importa:** Fonte mais eficiente = menos calor, menos conta de luz, mais confiabilidade.

### 2.4 PFC (Power Factor Correction)

| Tipo | Descrição |
|------|----------|
| **Passivo** | Simples, menos eficiente |
| **Ativo** | Melhor correção, padrão atual |

Fontes com PFC ativo são recomendadas. Algumas são obrigatórias por lei (mais de 75W).

### 2.5 Cabos e Conectores

| Conector | Uso |
|---------|-----|
| **24-pin (20+4)** | Placa-mãe |
| **CPU (8-pin)** | Processador |
| **PCIe (6+2)** | GPU |
| **SATA** | HD/SSD |
| **Molex** | Legado (evitar) |
| **Floppy** | Legacy (raro) |

### 2.6 Cálculo de Potência

**Consumo Típico:**

| Componente | Consumo |
|-----------|----------|
| CPU | 35-250W |
| GPU dedicada | 50-600W |
| Placa-mãe | 50-100W |
| RAM | 5-10W |
| HD/SSD | 5-10W |
| Coolers/LEDs | 10-30W |

**Regra prática:** Fonte recomendada = consumo total × 1.5

**Exemplo:**
- i5 12400 (65W) + RTX 3060 (170W) = ~300W
- Fonte recomendada: 450-500W
- Com folga: 550W 80+ Gold

### 2.7 Qualidade de Fonte

| Marca Recomendada | Características |
|----------------|---------------|
| **Corsair** | Linha completa |
| **Seasonic** | Excelente qualidade |
| **EVGA** | Bom custo-benefício |
| **be quiet!** | Silencioso |
| **Thermaltake** | Opções diversas |
| **Cooler Master** | entry a high-end |

**Evitar:** Fontes genéricas, sem marca, com preço muito baixo.

---

## 🏠 CAPÍTULO 3: Gabinetes (Tópico 5.11)

O gabinete protege os componentes e influencia o cooling.

### 3.1 Tamanhos

| Tamanho | Dimensões | Características |
|---------|----------|---------------|
| **Full Tower** | >500mm | Máximo espaço |
| **Mid Tower** | ~450mm | Padrão |
| **Mini Tower** | ~350mm | Compacto |
| **SFF** | <300mm | Desktop |
| **HTPC** | Baixo perfil | Mídia center |

### 3.2 Fatores de Forma

| Fator | Placas Suportadas | Uso |
|-------|-----------------|-----|
| **ATX** | ATX, mATX, ITX | Desktop padrão |
| **mATX** | mATX, ITX | Compacto |
| **ITX** | ITX | Mini/HTPC |

### 3.3 Cooling

| Tipo | Descrição |
|------|----------|
| **Air Cooling** | Ventoinhas + coolers |
| **Water Cooling** | Líquido (AIO/Custom) |
| **Passivo** | Sem ventoinhas |

**Fluxo de Ar:**

| Configuração | Uso |
|------------|-----|
| **Intake frontal + Exaustão traseiro** | Pressão positiva (recomendado) |
| **Intake frontal + superior** | Alta performance |
| **Todos intake** | Evitar (aquece mais) |

### 3.4 Características Importantes

| Característica | Importância |
|---------------|------------|
| **Espaço interno** | Facilidade de upgrade |
| **Filtragem de poeira** | Longevidade |
| **Cable management** | Fluxo de ar, estética |
| **USB frontais** | Praticidade |
| **Janela** | Visual |
| **Root rack** | HDD/SSD |

### 3.5 Gabinetes Corporativos

| Uso | Características |
|-----|---------------|
| **Escritório** | Simples, funcional |
| **Workstation** | Espaço, cooling |
| **Servidor Tower** | Espaço, hot-swap |
| **Rack** | Datacenter |

---

## 🔧 CAPÍTULO 4: Configuração de Boot (Tópico 7)

### 4.1 Ordem de Boot

Configurar no BIOS/UEFI qual dispositivo iniciar primeiro:

```
1. NVMe/SSD (sistema)
2. DVD/USB (recuperação)
3. HD/SSD secundário
```

### 4.2 Modos de Boot

| Modo | Descrição |
|------|----------|
| **Legacy/CSM** | Modo BIOS antigo |
| **UEFI** | Modo moderno |
| **Secure Boot** | Apenas SO assinado |

**Recomendado:** UEFI + Secure Boot (quando disponível)

### 4.3 AHCI vs RAID vs IDE

| Modo | Uso |
|------|-----|
| **IDE** | Compatibilidade (evitar) |
| **AHCI** | Padrão para desktop |
| **RAID** | Arrays de disco |

### 4.4 NVMe/RAID no BIOS

Ativar Option ROM para boot de NVMe ou Controladora RAID.

---

## ⚠️ ERROS COMUNS EM ARMAZENAMENTO E FONTES

1.  **Comprar fonte genérica (sem certificação 80+):** Fontes baratas de R$ 50-80 são a maior causa de queima de componentes no Brasil. Elas não protegem contra picos de energia e podem fritar a placa-mãe, a GPU e até o SSD. Invista no mínimo em 80+ Bronze!
2.  **Não usar cabo SATA de dados + energia:** O SSD SATA precisa de DOIS cabos: um de dados (fino, vindo da placa-mãe) e um de energia (vindo da fonte). Muitos alunos esquecem o cabo de energia!
3.  **Formatar pendrive em NTFS para uso em TV:** TVs e consoles leem FAT32 ou exFAT. Se formatar em NTFS, a TV não reconhece.
4.  **Não calcular a potência da fonte:** Use a regra: (TDP do processador + TDP da GPU + 80W de outros) × 1.5 = potência mínima. Sempre arredonde para cima!
5.  **Instalar SSD NVMe sem parafuso de fixação:** O SSD M.2 precisa de um pequeno parafuso para ficar no lugar. Sem ele, o SSD fica solto e pode perder contato.

---

## 🏭 CONTEXTO INDUSTRIAL: Armazenamento em Ambientes Críticos

**Cenário Real — Servidor de CFTV em Fábrica:**

Um sistema de 64 câmeras gravando 24h precisa de armazenamento massivo e confiável:

| Componente | Especificação | Preço |
|------------|---------------|-------|
| HD WD Purple 4TB (vigilância) | Otimizado para gravação contínua | R$ 600 - R$ 900 |
| HD Seagate SkyHawk 8TB | Até 64 câmeras simultâneas | R$ 1.200 - R$ 1.800 |
| Fonte Corsair RM750 (80+ Gold) | Para servidor de vídeo | R$ 650 - R$ 900 |
| Gabinete com hot-swap | Troca de HD sem desligar | R$ 800 - R$ 2.000 |

**HDs de vigilância vs HDs comuns:**
- HDs comuns (WD Blue, Seagate Barracuda) são projetados para uso 8h/dia
- HDs de vigilância (WD Purple, Seagate SkyHawk) funcionam 24/7 sem superaquecer
- HDs de servidor (WD Gold, Seagate Exos) aguentam vibração de rack com vários discos

> **Dica de Professor:** Em Sertãozinho, muitas empresas ainda usam HDs comuns em servidores para "economizar". O resultado? Falha em 6 meses e perda de dados. Sempre especifique o HD correto para cada uso!

**Fontes em Ambientes Industriais:**
- Fábricas com instalação elétrica ruim causam picos constantes
- Fontes 80+ Gold ou superiores protegem melhor os componentes
- Sempre use no-break (UPS) senoidal em servidores e workstations
- Em regiões rurais (usinas), um estabilizador de linha é obrigatório

---

## 📚 Leituras Complementares Recomendadas

**Livros:**
- "Hardware: Versão Revisada e Atualizada" — Gabriel Torres
- "Manutenção de Micros na Prática" — Laércio Vasconcelos
- "Arquitetura e Montagem de Computadores" — SENAI Digital

**Canais do YouTube (em português):**
- "Peperaio Hardware" — Testes de fontes e armazenamento
- "Adrenaline" — Reviews de hardware com preços brasileiros
- "Bóson Treinamentos" — Teoria de RAID e sistemas de arquivo

**Sites de referência:**
- www.kabum.com.br — Preços atualizados de SSDs e fontes
- www.pichau.com.br — Configurações prontas com preços
- www.crystalmark.info — Download do CrystalDiskMark (benchmark de SSD)

---

## 📎 Glossário Rápido

| Termo | Significado |
|-------|-------------|
| **HD (HDD)** | Hard Disk Drive — disco rígido com partes móveis |
| **SSD** | Solid State Drive — armazenamento sem partes móveis |
| **NVMe** | Non-Volatile Memory Express — protocolo ultrarrápido para SSDs |
| **SATA** | Serial ATA — interface de armazenamento (até 6Gb/s) |
| **M.2** | Formato compacto de SSD (parece um chiclete) |
| **RAID** | Array de discos com redundância ou performance |
| **NTFS** | Sistema de arquivos padrão do Windows |
| **exFAT** | Sistema de arquivos para pendrives grandes |
| **80+ Gold** | Certificação de eficiência energética (≥85%) |
| **TDP** | Thermal Design Power — calor a dissipar em Watts |
| **Hot-Swap** | Trocar componente sem desligar |
| **Pasta Térmica** | Substância entre processador e cooler para transferência de calor |

---

## 💡 Resumo do Capítulo: O Que Você Aprendeu

### 💾 Armazenamento
- HD: barato, grande capacidade, lento
- SSD SATA: rápido, sem ruído, preço intermediário
- SSD NVMe: ultrarrápido (GB/s), ideal para sistema operacional
- RAID: 0 (velocidade), 1 (espelhamento), 5 (paridade), 6 (paridade dupla)

### ⚡ Fontes de Alimentação
- Sempre usar 80+ certificada (Bronze no mínimo!)
- Calcular potência: (CPU + GPU + outros) × 1.5
- Modular = cabos removíveis = organização

### 📦 Gabinetes
- ATX: desktop padrão
- mATX: compacto
- ITX: mini/HTPC
- Fluxo de ar: intake frontal + exaustão traseira

---

## 🔍 Dicas para a Prova

1. **NVMe usa PCIe** — velocidade em GB/s (muito mais rápido que SATA)
2. **NTFS suporta arquivos >4GB** — FAT32 não!
3. **80+ Gold = 85% eficiência** — não é potência!
4. **RAID 6 protege contra 2 falhas** — RAID 5 só 1
5. **SSD não tem partes móveis** — por isso é silencioso e resistente
6. **Pasta térmica** — OBRIGATÓRIA entre processador e cooler

---

## 🔧 ATIVIDADE DE LABORATÓRIO 4: Montagem de Sistema

**Objetivo:** Configurar armazenamento e fonte corretamente.

**Passo a Passo:**

1. **Identificar componentes:**
   - Verificar no sistema atual: tipo de armazenamento, capacidade da fonte
   - Abrir Gerenciador de Tarefas > Desempenho

2. **Testar performance:**
   - HD: CrystalDiskMark vs SSD NVMe
   - Notar diferença de velocidade

3. **Verificar fonte:**
   - Calcular consumo: CPU + GPU + demais componentes
   - Verificar se a fonte é adequada

4. **Verificar ordem de boot:**
   - Acessar BIOS (Del/F2/F10)
   - Verificar/modificar ordem

---

## 🧠 PROVA FINAL: Teste Seus Conhecimentos

**Questão 1:**
Qual a principal vantagem do SSD NVMe sobre SATA SSD?

a) Custo menor
b) Maior velocidade (GB/s vs MB/s)
c) Mais capacidade
d) Mais confiável

<details>
<summary>👀 Ver Resposta</summary>
<b>Resposta:</b> B) Maior velocidade (GB/s vs MB/s)<br>
<b>Explicação:</b> NVMe usa PCIe (GB/s), enquanto SATA usa apenas 6Gb/s (MB/s).
</details>

---

**Questão 2:**
O que significa "80+ Gold" em uma fonte?

a) 80% de eficiência mínima
b) 85% de eficiência mínima
c) 80Watts
d) Garantia de 80 meses

<details>
<summary>👀 Ver Resposta</summary>
<b>Resposta:</b> B) 85% de eficiência mínima<br>
<b>Explicação:</b> 80+ Gold certifica no mínimo 85% de eficiência em load típico.
</details>

---

**Questão 3:**
Qual sistema de arquivo do Windows suporta arquivos maiores que 4GB?

a) FAT32
b) NTFS
c) exFAT
d) B e C

<details>
<summary>👀 Ver Resposta</summary>
<b>Resposta:</b> D) B e C<br>
<b>Explicação:</b> NTFS e exFAT suportam arquivos muito maiores que 4GB. FAT32 não.
</details>

---

**Questão 4:**
Para um desktop com i5 + RTX 3060, qual fonte mínima recomendada?

a) 300W
b) 400W
c) 450W
d) 750W

<details>
<summary>👀 Ver Resposta</summary>
<b>Resposta:</b> C) 450W<br>
<i>Aproximado: i5 (65W) + RTX 3060 (170W) + outros (~80W) = ~315W × 1.5 = ~475W, mínimo 450W</i>
</details>

---

*Parabéns! Você completou a Unidade 4. Avance para a Unidade 5: Montagem, Desmontagem e Instalação de SO.*