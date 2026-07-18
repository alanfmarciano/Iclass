# 🔧 IRCOM 5: Montagem, Desmontagem, Documentação Técnica e Instalação de Sistema Operacional

> **Carga Horária Estimada:** 24 Horas
> **Foco:** Procedimentos de montagem e desmontagem de microcomputadores, documentação técnica e instalação de sistemas operacionais.
> **Baseado nos Tópicos Oficiais do SENAI (IRCOM):** Tópico 6, Tópico 7, Tópico 8 e Tópico 9.

Este é o capítulo mais prático do módulo IRCOM. Aqui você aprenderá a montar, desmontar, documentar e instalar sistemas operacionais - habilidades fundamentais para qualquer profissional de T.I.

---

## 🔩 CAPÍTULO 1: Montagem e Desmontagem (Tópico 7)

### 1.1 Ferramentas Necessárias

| Ferramenta | Função |
|-----------|--------|
| **Chave Phillips** | Parafusos padrão |
| **Chave Torx** | Parafusos de segurança |
| **Alicate de bico** | Pegar pequenos componentes |
| **Pulseira antiestática** | Proteger componentes |
| **Lanterna** | Iluminação |
| **Pasta térmica** | Cooler do processador |
| **Limpa contatos** | Limpeza |
| **Organizador de parafusos** | Não perder peças |

### 1.2 Precauções de Segurança

**ESD (Descarga Eletrostática):**
- Usar pulseira antiestática
- Tocar a massa antes de mexer em componentes
- Não tocar pinos/dedos nos circuitos

**Equipamento de Proteção:**
- Não Trabalhar com energia
- Usar EPIs quando necessário

### 1.3 Processo de Montagem

#### Passo 1: Preparação
1. Escolha uma área limpa e iluminada
2. Organize ferramentas
3. Preparar os componentes a montar
4. Mantenha as peças em embalagem antiestática até o uso
5. Verificar MANUAL

#### Passo 2: Placa-Mãe
1. Inserir processador no soquete (alinhar triângulo)
2. Aplicar pasta térmica (gota pequena no centro)
3. Fixar cooler (presilhas diagonalmente)
4. Conectar cabo do cooler ao header

#### Passo 3: Memória RAM
1. Abrir clipes do slot
2. Alinhar chanfro (só entra de um jeito)
3. Pressionar firmemente até o clique
4. Verificar engajamento dos clipes

#### Passo 4: Placa-Mãe no Gabinete
1. Instalar backplate (se houver)
2. Inserir espaçadores nos furos corretos
3. Alinhar portas I/O no gabinete
4. Fixar com parafusos (não apertar demais)

#### Passo 5: Fonte
1. Posicionar (geralmente embaixo ou topo)
2. Fixar com parafusos
3. Conectar cabo 24-pin na placa-mãe
4. Conectar cabo CPU 8-pin

#### Passo 6: Placa de Vídeo (se dedicada)
1. Remover proteção do slot PCIe
2. Inserir no slot x16
3. Fixar com parafuso lateral
4. Conectar energia (se necessário)

#### Passo 7: Armazenamento
1. SSD 2.5": Fixar na bandeja
2. HD: Fixar com parafusos (4 pontos)
3. NVMe: Inserir no slot M.2
4. Conectar cabos SATA (dados + energia)

#### Passo 8: Cabling
1. Conectar USB, áudio frontais
2. Conectar LEDs e buttons
3. Organizar cabos (cable management)
4. Fechar o gabinete

### 1.4 Processo de Desmontagem

A desmontagem segue o processo inverso:

1. Desconectar energia
2. Remover cables
3. Remover placa de vídeo
4. Remover armazenamento
5. Remover cooler e RAM
6. Remover fonte
7. Remover placa-mãe

> **Importante:** Guardar parafusos organizados por tipo/local.

---

## 📋 CAPÍTULO 2: Documentação Técnica (Tópico 6)

A documentação é essencial para manutenção futura e conformidade.

### 2.1 Tipos de Documentação

| Tipo | Conteúdo |
|------|----------|
| **Manual do equipamento** | Especificações, procedimentos |
| **Ordem de serviço** | Descrição do trabalho |
| **Laudo técnico** | Diagnóstico e solução |
| **Termo de entrega** | Confirmação de serviço |

### 2.2 Ordem de Serviço

**Estrutura:**

```
1. Identificação
   - Data: __/__/____
   - Técnico: ____________
   - OS: ____________
   
2. Equipamento
   - Tipo: ____________
   - Marca/Modelo: ____________
   - Número de Série: ____________
   
3. Solicitação
   - Problema relatado: ____________
   
4. Serviço Executado
   - Diagnóstico: ____________
   - Solução aplicada: ____________
   - Peças substituídas: ____________
   
5. Testes
   - [ ] Boot normal
   - [ ] Periféricos OK
   - [ ] Sistema estável
   
6. Assinaturas
   - Técnico: ____________
   - Cliente: ____________
```

### 2.3 Informações Importantes para Documentar

- Configuração de hardware (specs)
- Versão do BIOS/UEFI
- Número de série
- Licenças de software
- Configurações de rede
- Backup realizado (s/n)
- Estado de conservação

### 2.4 NR-10 e Segurança

NR-10 aplica-se a trabalhos elétricos:

- Comutador deve estar DESLIGADO e travado
- Testar ausência de tensão
- Aterramento temporário quando necessário
- EPI adequado
- Apenas profissionais habilitados

---

## 💿 CAPÍTULO 3: Instalação de Sistema Operacional (Tópicos 8 e 9)

### 3.1 Tipos de Sistemas Operacionais

| Tipo | Exemplos | Características |
|------|----------|---------------|
| **Código Fechado** | Windows 10/11, macOS | Proprietário, suporte comercial |
| **Código Aberto** | Ubuntu, Debian, Fedora | Código disponível, gratuito |
| **Híbrido** | Chrome OS | Cloud-first |

### 3.2 Pré-instalação

**Verificações:**
1. Backup dos dados (se aplicável)
2. Verificar compatibilidade de hardware
3. Baixar mídia de instalação
4. Obter licenças necessárias
5. Verificar drivers disponíveis

**Mídia de Instalação:**
- USB bootável (recomendado)
- DVD (legado)
- Rede (PXE - corporativo)

### 3.3 Instalação Windows

#### Preparação BIOS/UEFI
1. Acessar BIOS (Del/F2/F10)
2. Definir boot order: USB primeiro
3. Desativar Secure Boot (se instalar Linux)
4. Ativar AHCI (não IDE/RAID)
5. Save and exit

#### Instalação
1. Bootar pela mídia
2. Selecionar idioma
3. Clicar "Instalar agora"
4. Aceitar licença
5. Selecionar "Personalizada"
6. Selecionar disco
7. Criar partições (se necessário)
8. Aguardar cópia de arquivos
9. Configurar região/usuário
10. Instalação concluída

#### Pós-instalação
1. Atualizar Windows Update
2. Instalar drivers (chipset, vídeo)
3. Instalar antivírus
4. Instalar programas essenciais
5. Configurar rede
6. Ativar Windows
7. Criar pontos de restauração

### 3.4 Instalação Linux

#### Escolha de Distribuição

| Uso | Distribuição Recomendada |
|----|----------------------------|
| **Iniciante** | Ubuntu, Linux Mint |
| **Servidor** | Ubuntu Server, Debian, Rocky |
| **Segurança** | Kali Linux |
| **LEVE** | Alpine, AntiX |

#### Instalação Ubuntu (Exemplo)

1. Bootar pelo USB
2. Selecionar "Install Ubuntu"
3. Escolher idioma
4. Atualizações e software de terceiros
5. Tipo de instalação:
   - "Apagar disco e instalar Ubuntu" (simples)
   - "Something else" (partições manual)
6. Definir fuso horário
7. Criar usuário
8. Copiar arquivos
9. Reiniciar

#### Instalação Avançada (Particionamento Manual)

```
/boot     - 512MB-1GB  (EFI or /boot)
/         - Raiz      - 20-40GB
/home    - Opcional   - restante
swap     - 2x RAM    - Hibernação
```

### 3.5 Particionamento

#### Conceitos

| Partição | Função |
|---------|--------|
| **EFI/ESP** | Bootloader UEFI (100-500MB) |
| **/** | Raiz (sistema) |
| **/home** | Arquivos do usuário |
| **swap** | Memória virtual |
| **/boot** | Arquivos de boot |

#### Ferramentas

| Ferramenta | Descrição |
|-----------|----------|
| **GParted** | Interface gráfica Linux |
| **diskpart** | Partition manager Windows |
| **fdisk/cfdisk** | CLI Linux |
| **Windows Setup** | Partições durante instalação |

### 3.6 Dual Boot (Windows + Linux)

Ordem de instalação:
1. Instalar Windows primeiro
2. Criar espaço não particionado
3. Instalar Linux
4. Linux detecta Windows e cria bootloader dual

**Importante:** Instale o Linux por último para evitar sobrescrita do bootloader.

---

## 🔒 CAPÍTULO 4: Instalação de Drivers e Atualizações (Tópicos 8.5 e 8.6)

### 4.1 Drivers Essenciais

| Driver | Fonte | Importância |
|--------|-------|-------------|
| **Chipset** | Site do fabricante da placa-mãe | CRÍTICA |
| **Vídeo** | Site NVIDIA/AMD/Intel | Alta |
| **Rede** | Site do fabricante | Alta |
| **Áudio** | Site do fabricante | Média |

### 4.2 Instalação de Drivers

#### Windows
1. Baixar do site do fabricante
2. Executar instalador OU
3. Device Manager > Atualizar driver

#### Linux
Geralmente automáticos (kernel).

Para drivers proprietários (NVIDIA):
```
sudo apt install nvidia-driver-535
sudo reboot
```

### 4.3 Windows Update

1. Settings > Update & Security > Windows Update
2. Check for updates
3. Baixar e instalar atualizações
4. Reiniciar se necessário
5. Repetir até não haver mais

### 4.4 Atualização de BIOS/UEFI

> **ATENÇÃO:** Atualização mal-sucedida = brick (placa-mãe inutilizável)

1. Baixar versão correta (modelo exato)
2. Ler notas de release
3. Copiar arquivo para USB
4. Acessar BIOS/UEFI
5. Localizar Flash utility
6. Selecionar arquivo
7. Não interromper
8. Esperar conclusão

---

## 🧪 CAPÍTULO 5: Testes e Validação (Tópicos 7.4 e 8.8)

### 5.1 Testes de Boot

| Teste | Descrição |
|-------|----------|
| **POST** | Verificação ao ligar |
| **Boot Sequence** | Inicialização completa |
| **Memória** | Teste de RAM |
| **Disco** | Health check |

### 5.2 Testes de Estabilidade

#### Stress Test

Ferramentas:
- Prime95 (Windows/Linux)
- AIDA64 (Windows)
- MemTest86 (Bootável)

Procedimento:
1. Executar durante 1-24 horas
2. Monitorar temperaturas
3. Verificar erros

#### Monitoramento

| Ferramenta | Métricas |
|-----------|----------|
| **CPU-Z** | CPU, RAM |
| **GPU-Z** | Vídeo |
| **CrystalDiskMark** | Disco |
| **HWiNFO** | Tudo |

### 5.3 Verificação de Periféricos

- Teclado
- Mouse
- Impressora
- Rede
- Vídeo (múltiplos monitors)

---

## 🔧 ATIVIDADE DE LABORATÓRIO 5: Instalação Completa

**Objetivo:** Realizar procedimento completo de montagem e instalação.

**Passo a Passo:**

1. **Pré-instalação:**
   - Verificar componentes
   - Montar sistema (se componentes disponíveis)
   - Verificar POST

2. **Instalação:**
   - Bootar mídia
   - Instalar SO
   - Criar partições

3. **Pós-instalação:**
   - Atualizar sistema
   - Instalar drivers
   - Instalar programas

4. **Testes:**
   - Verificar boot
   - Testar periféricos
   - Documentar

---

## 🧠 PROVA FINAL: Teste Seus Conhecimentos

**Questão 1:**
Qual é a primeira etapa ao montar um computador?

a) Conectar fonte
b) Preparação e organização de ferramentas
c) Instalar processador
d) Conectar cabos

<details>
<summary>👀 Ver Resposta</summary>
<b>Resposta:</b> B) Preparação e organização de ferramentas<br>
<b>Explicação:</b> Uma boa preparação evita danos e erros. Organize area, ferramentas e componentes antes de começar.
</details>

---

**Questão 2:**
O que faz a Ordem de Serviço?

a) Solicitar peças
b) Documentar o serviço realizado
c) Agendar cliente
d) Cobrar serviço

<details>
<summary>👀 Ver Resposta</summary>
<b>Resposta:</b> B) Documentar o serviço realizado<br>
<b>Explicação:</b> A Ordem de Serviço documenta o problema, solução e peças utilizadas.
</details>

---

**Questão 3:**
Qual driver deve ser instalado primeiro no Windows?

a) Vídeo
b) Rede
c) Chipset da placa-mãe
d) Áudio

<details>
<summary>👀 Ver Resposta</summary>
<b>Resposta:</b> C) Chipset da placa-mãe<br>
<b>Explicação:</b> O driver de chipset é fundamental e deve ser instalado primeiro.
</details>

---

**Questão 4:**
Qual a vantagem do Ubuntu Server sobre a versão Desktop?

a) Interface gráfica melhor
b) Menor consumo de recursos
c) Suporte a mais jogos
d) Nenhuma diferença

<details>
<summary>👀 Ver Resposta</summary>
<b>Resposta:</b> B) Menor consumo de recursos<br>
<b>Explicação:</b> Server Edition não tem interface gráfica (GUI), reduzindo overhead.
</details>

---

## 💼 CAPÍTULO 6: Softwares de Colaboração e Produtividade (Tópico 10)

Depois de montar e instalar o sistema operacional, você vai precisar instalar os programas que seus colegas vão usar todos os dias. Esses são os "softwares de colaboração e produtividade" - ferramentas que permitem trabalho em equipe e execução de tarefas do dia a dia.

### 6.1 Suítes de Escritório

Uma suite de escritório é um conjunto de programas essenciais para o trabalho de escritório. O padrão mais comum é o Microsoft Office, mas existem alternativas gratuitas.

**Microsoft Office (Pago)**
| Programa | Função |
|----------|--------|
| **Word** | Editores de texto (contratos, relatórios) |
| **Excel** | Planilhas (cálculos, relatórios) |
| **PowerPoint** | Apresentações |
| **Outlook** | E-mail e calendário |
| **Access** | Banco de dados simples |
| **OneNote** | Anotações |

**Alternativas Gratuitas**
| Programa | Alternativa a | Onde conseguir |
|----------|---------------|----------------|
| **LibreOffice** | Microsoft Office | libreoffice.org |
| **OpenOffice** | Microsoft Office | openoffice.org |
| **OnlyOffice** | Microsoft Office | onlyoffice.com |

> **Dica de Professor:** Se a empresa não tem orçamento para Microsoft Office, LibreOffice é uma alternativa muito boa. Abre arquivos .docx e .xlsx sem problema!

### 6.2 Instalação de Suítes de Escritório

**Instalando Microsoft Office:**
1. Acessar o portal Office 365 (office.com)
2. Fazer login com conta corporativa
3. Clicar em "Instalar Office"
4. Baixar e executar instalador
5. Ativar com conta corporativa

**Instalando LibreOffice:**
1. Acessar libreoffice.org
2. Baixar versão para Windows
3. Executar instalador
4. Escolher componentes (Writer, Calc, Impress)
5. Concluir instalação

### 6.3 Correios Eletrônicos (E-mail)

O e-mail corporativo é fundamental para comunicação profissional. Você vai configurar isso!

**Outlook (Microsoft)**
- Integração com Microsoft 365
- Calendário, contatos, tarefas
- Sincronização com celular

**Thunderbird (Mozilla)**
- Grátis e open source
- Múltiplas contas de e-mail
- Addons para organização

**Configuração de E-mail:**
Para configurar uma conta de e-mail no Outlook:
1. Abrir Outlook
2. Arquivo > Adicionar Conta
3. Digitar e-mail (fulano@empresa.com)
4. O Outlook geralmente configura automaticamente
5. Se não conseguir, precisa do servidor SMTP e POP3/IMAP

### 6.4 Antivírus

Todo computador precisa de proteção! Nem só de antivírus pagos vive a segurança.

| Antivírus | Tipo | Características |
|----------|------|-----------------|
| **Windows Defender** | Gratuito (já vem no Windows) | Bom, leve, integrado |
| **Malwarebytes** | Freemium | Excelente para malware |
| **Kaspersky** | Pago | Proteção robusta |
| **Norton** | Pago | Suite completa |

**Melhor Prática:**
- Usar Windows Defender + Malwarebytes Free
- Manter Windows sempre atualizado
- Não clicar em links suspeitos
- Não baixar arquivos de fontes desconhecidas

### 6.5 Compactadores de Arquivos

Às vezes você precisa mandar arquivos grandes por e-mail ou salvar espaço. Para isso serve compactar!

| Programa | Formatos Suportados | Tipo |
|----------|---------------------|------|
| **WinRAR** | RAR, ZIP (Trial) | Pago |
| **7-Zip** | 7z, ZIP, RAR, etc | Gratuito |
| **WinZip** | ZIP (Pago) | Pago |

> **Dica:** 7-Zip é gratuito e abre quase tudo. Recomendo!

### 6.6 Visualizadores de Multimídia

Para ver vídeos e ouvir músicas no trabalho:

| Tipo | Programa Recomendado |
|------|---------------------|
| **Vídeo** | VLC Player (gratuito, abre tudo) |
| **Áudio** | Spotify, Windows Media Player |
| **PDF** | Adobe Reader, Edge (já vem) |
| **Códigos** | Visual Studio Code |

### 6.7 Aplicativos Essenciais que Você Vai Instalar

Lista de programas que todo técnico de TI deveria ter instalado:

1. **Navegador** - Chrome ou Edge
2. **Visualizador de PDF** - Já vem no Windows
3. **Codecs de Vídeo** - K-Lite Codec Pack
4. **Compactador** - 7-Zip
5. **Antivírus** - Windows Defender
6. **TeamViewer** - Acesso remoto
7. **AnyDesk** - Alternative a TeamViewer
8. **VLC** - Reproduzir vídeos
9. **Notepad++** - Editor de texto avançado
10. **CPU-Z** - Ver especificações de hardware

> **Desafio:** Monte uma lista dos 10 programas que você mais usa no dia a dia!

---

## ⚖️ CAPÍTULO 7: Normas e Regulamentos (Tópico 11)

Como técnico de TI, você precisa conhecer as normas que regem sua área de trabalho. Isso evita acidentes e problemas legais!

### 7.1 NR-10: Segurança em Eletricidade

A NR-10 é obrigatória para quem trabalha com instalações elétricas. Como técnico de TI, você vai mexer com tomadas, cabos de energia e fontes!

**Regras principais:**
- DESLIGAR a energia antes de mexer dentro do PC
- Usar ferramentas isoladas
- Não trabalhar sozinho em instalações de risco
- ter treinamento atualizado (válido por 2 anos)

### 7.2 LGPD - Lei Geral de Proteção de Dados

A LGPD (Lei 13.709/2018) rege como empresas devem tratar dados pessoais dos clientes.

**O que você precisa saber:**
- Dados pessoais não podem ser compartilhados sem consentimento
- Em caso de vazamento, a empresa deve notificar a ANPD
- Dados devem ser protegidos com criptografia
- Backup também deve seguir a LGPD!

**Aplicação prática:**
- notebooks corporativos não devem ter dados pessoais sem proteção
- Usar BitLocker para criptografar disco
- Cuidado com senhas em redes públicas

### 7.3 Descarte de Equipamentos Eletrônicos

Equipamentos de TI contêm materiais tóxicos. Descartar erradamente é crime!

**O que NÃO fazer:**
- Jogar no lixo comum
- Queimar para separar peças
- Jogar em aterros

**O que FAZER:**
- Procurar ponto de coleta credenciado
- Empresas especializadas fazem coleta (Recycla, etc)
- Doar se ainda funciona!
- Apagar os dados antes de descartar

### 7.4 Normas de Segurança Física

**NR-6 - Equipamentos de Proteção Individual (EPI):**
- Luvas isolantes para trabalho elétrico
- Óculos de proteção (limpeza)
- Calçado de segurança

**NR-35 - Trabalho em Altura:**
- Se precisar trabalhar em locais altos (teto, rack), use cinto de segurança!

### 7.5 Resolução ANATEL

Se você for instalar ou configurar redes Wi-Fi, precisa conhecer a Resolução ANATEL:

- Potência máxima de transmissão é regulada
- Algumas frequências são restritas
- Equipamentos devem ser homologados

### 7.6 Boas Práticas de Segurança

Resumo das boas práticas que todo técnico deve seguir:

| Prática | Por quê |
|---------|--------|
| **Senhas fortes** | Evita acesso não autorizado |
| **2FA quando possível** | Camada extra de segurança |
| **Atualizar sistemas** | Corrige vulnerabilidades |
| **Backup regular** | Protege contra perda de dados |
| **Criptografar dados sensíveis** | Proteção LGPD |
| **Log de alterações** | Rastreabilidade |
| **Documentar tudo** | Facilita a manutenção futura |

> **Lembre-se:** Você é a primeira linha de defesa da segurança da empresa! Siga boas práticas sempre.

---

## 🧰 CHECKLIST DE FERRAMENTAS DO TÉCNICO (Marcas Disponíveis no Brasil)

Antes de montar ou desmontar qualquer computador, você precisa ter as ferramentas certas organizadas:

### Ferramentas Obrigatórias

| Ferramenta | Uso | Marca/Modelo Sugerido | Preço Aproximado |
|------------|-----|----------------------|-----------------|
| **Chave Phillips #1** | Parafusos de HD, gabinete | Tramontina PRO, Vonder | R$ 15 - R$ 30 |
| **Chave Phillips #0** | Parafusos de notebook, M.2 | Tramontina PRO | R$ 12 - R$ 25 |
| **Chave Torx T5/T6** | Parafusos de notebook Apple/Dell | Gedore, Vonder | R$ 20 - R$ 40 |
| **Pulseira antiestática** | Proteção contra ESD | Minipa, Hikari | R$ 15 - R$ 35 |
| **Pinça antiestática** | Manipular jumpers e cabos | Vonder | R$ 10 - R$ 20 |
| **Soprador de ar** | Limpeza de poeira (substitui ar comprimido) | Wap, Mondial | R$ 80 - R$ 150 |
| **Pasta térmica** | Entre processador e cooler | Arctic MX-4, Cooler Master | R$ 25 - R$ 60 |
| **Multímetro digital** | Testar tensão da fonte | Minipa ET-1002, Hikari HM-1100 | R$ 50 - R$ 120 |
| **Lanterna/LED** | Iluminar interior do gabinete | Qualquer LED portátil | R$ 15 - R$ 30 |
| **Pendrive 16GB+** | Boot, drivers, ferramentas | Kingston, SanDisk | R$ 25 - R$ 50 |

### Ferramentas Opcionais (Avançado)

| Ferramenta | Uso | Preço |
|------------|-----|-------|
| **Kit de espátulas plásticas** | Abrir notebooks sem riscar | R$ 15 - R$ 30 |
| **Testador de fonte ATX** | Verificar se a fonte está funcionando | R$ 30 - R$ 60 |
| **Testador de cabos de rede** | Verificar cabos RJ-45 | R$ 40 - R$ 80 |
| **Sugador de solda** | Reparos em placa (nível avançado) | R$ 20 - R$ 40 |

> **Dica de Professor:** Monte sua maleta aos poucos! Comece com chave Phillips, pulseira antiestática e pasta térmica. O restante você vai adquirindo conforme a demanda do trabalho. Uma boa maleta completa custa entre R$ 200 e R$ 400.

**Onde comprar no Brasil:**
- **Kabum** (kabum.com.br) — Pasta térmica, pendrives, acessórios
- **Kalunga** (kalunga.com.br) — Material de escritório e ferramentas básicas
- **Loja do Mecânico** (lojadomecanico.com.br) — Ferramentas Vonder, Gedore
- **Amazon Brasil** (amazon.com.br) — Kits completos importados

---

## 📎 Glossário Rápido

| Termo | Significado |
|-------|-------------|
| **ESD** | Electrostatic Discharge — descarga eletrostática que pode danificar componentes |
| **Pasta Térmica** | Substância que melhora a transferência de calor entre processador e cooler |
| **BIOS/UEFI** | Firmware que inicializa o hardware antes do sistema operacional |
| **Secure Boot** | Recurso do UEFI que só permite SO assinado digitalmente |
| **POST** | Power-On Self-Test — teste automático ao ligar o PC |
| **PXE Boot** | Boot pela rede — instalação remota de sistemas operacionais |
| **Dual Boot** | Dois sistemas operacionais no mesmo computador |
| **AHCI** | Modo de operação do controlador de disco (padrão para SSD) |
| **NR-10** | Norma regulamentadora de segurança em instalações elétricas |
| **LGPD** | Lei Geral de Proteção de Dados — proteção de dados pessoais |
| **BitLocker** | Ferramenta do Windows para criptografia de disco |
| **Rufus** | Software gratuito para criar pendrives bootáveis |
| **GParted** | Ferramenta Linux para criar e gerenciar partições |
| **Ordem de Serviço (OS)** | Documento que registra o serviço realizado no equipamento |
| **Cable Management** | Organização dos cabos internos para melhorar o fluxo de ar |

---

## 💡 Resumo do Capítulo: O Que Você Aprendeu

### 🔧 Montagem e Desmontagem
- Sequência correta: preparação → CPU → RAM → placa-mãe → armazenamento → fonte → cabos
- Sempre usar pulseira antiestática
- Organizar cabos (cable management) para fluxo de ar

### 📋 Documentação Técnica
- Ordem de Serviço: registrar tudo que foi feito
- NR-10: segurança elétrica obrigatória
- Inventário: mapear todos os equipamentos da empresa

### 💿 Instalação de Sistemas Operacionais
- Windows: Rufus → USB bootável → BIOS (boot USB) → instalação → drivers → atualizações
- Linux: GParted → partições (/boot, /, /home, swap) → instalação → configuração
- Dual Boot: instalar Windows primeiro, Linux depois

### 💼 Softwares de Produtividade
- Microsoft 365: Word, Excel, PowerPoint, Teams, Outlook
- LibreOffice: alternativa gratuita
- Compactadores: 7-Zip (grátis) é o melhor custo-benefício

### ⚖️ Normas e Regulamentos
- NR-10: desligar energia antes de abrir equipamentos
- LGPD: proteger dados pessoais (BitLocker, senhas fortes)
- Descarte: nunca jogar eletrônicos no lixo comum

---

## 🔍 Dicas para a Prova

1. **Primeira etapa da montagem = Preparação** — ferramentas, ESD, espaço limpo
2. **Driver do chipset é instalado primeiro** — antes de vídeo, áudio ou rede
3. **Rufus cria USB bootável** — não CMD, não Excel!
4. **Ubuntu Server = sem interface gráfica** — menor consumo de recursos
5. **ESD = Descarga Eletrostática** — pode queimar componentes silenciosamente
6. **NR-10 = Segurança Elétrica** — obrigatória para técnicos de TI
7. **Secure Boot = apenas SO assinado** — proteção contra malware no boot
8. **PXE Boot = pela rede** — usado para instalação em massa em empresas

---

*Parabéns! Você completou o módulo IRCOM — Instalação de Recursos Computacionais (120h).*

**Bibliografia Recomendada:**
- *SENAI — Arquitetura e Montagem de Computadores*
- *SENAI — Montagem e Manutenção de Computadores*
- *Torres, Gabriel — Hardware: Versão Revisada e Atualizada*
- *Vasconcelos, Laércio — Manutenção de Micros na Prática*
- *Battisti, Júlio — Windows Server 2022: Guia Prático*

*Curso completo: 5 unidades = 120h IRCOM.*