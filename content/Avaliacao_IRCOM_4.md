# 📝 Avaliação: Unidade 4 - IRCOM

**Tema:** Armazenamento, Fontes e Gabinetes

---

## Parte 1: Quiz Teórico (20 perguntas)

**1. Qual a principal vantagem do SSD NVMe sobre SATA SSD?**

a) Custo menor
b) Maior velocidade (GB/s vs MB/s)
c) Mais capacidade
d) Mais confiável

---

**2. O que significa "80+ Gold" em uma fonte?**

a) 80% de eficiência mínima
b) 85% de eficiência mínima
c) 80Watts
d) Garantia de 80 meses

---

**3. Qual sistema de arquivo do Windows suporta arquivos maiores que 4GB?**

a) FAT32
b) NTFS
c) exFAT
d) B e C

---

**4. Para um desktop com i5 + RTX 3060, qual fonte mínima recomendada?**

a) 300W
b) 400W
c) 450W
d) 750W

---

**5. Qual tecnologia de armazenamento não tem partes móveis?**

a) HD
b) Fita magnética
c) SSD
d) Disquete

---

**6. O que é memória flash?**

a) Um tipo de RAM volátil
b) Memória não-volátil usada em SSDs e pendrives
c) Um tipo de processador
d) Uma porta USB

---

**7. Qual a função da fonte de alimentação?**

a) Armazenar dados
b) Converter energia AC para DC e distribuir aos componentes
c) Processar informações
d) Conectar à internet

---

**8. O que é um SSD SATA?**

a) SSD que usa interface SATA
b) SSD sem interface
c) Um HD
d) Uma memória RAM

---

**9. Qual sistema de arquivo é padrão do Windows 10/11?**

a) FAT32
b) exFAT
c) NTFS
d) ext4

---

**10. O que significa "modular" em fontes?**

a) Pode ser reparada
b) Cabos podem ser removidos conforme necessidade
c) É mais potente
d) É mais cara

---

**11. Qual formato de SSD é comum em notebooks?**

a) 2.5 Polegadas
b) M.2
c) 3.5 Polegadas
d) PCIe

---

**12. O que é RAID?**

a) Um tipo de processador
b) Redundant Array of Independent Disks - array de discos redundantes
c) Um tipo de memória
d) Uma porta USB

---

**13. Qual tipo de cooler é mais eficiente?**

a) Air cooling básico
b) Water cooling (líquido)
c) Sem cooler
d) Qualquer um

---

**14. O que faz um gabinete?**

a) Processa dados
b) Protege componentes e permite instalação
c) Armazena energia
d) Conecta à rede

---

**15. Qual slot aceita SSD NVMe?**

a) SATA
b) DDR
c) PCIe x4
d) USB

---

**16. O que é 80+ Bronze?**

a) Fonte de 80W
b) Certificação de eficiência mínima de 80%
c) Garantia de 80 meses
d) Fonte para servidores

---

**17. Qual a capacidade típica de um HD desktop atual?**

a) 500GB a 18TB
b) 1GB a 10GB
c) 100GB a 500GB
d) 1TB a 2TB

---

**18. O que é pasta térmica?**

a) Material de embalagem
b) Substância que melhora transferência de calor entre processador e cooler
c) Um tipo de software
d) Um componente elétrico

---

**19. Qual RAID protege contra falha de 2 discos?**

a) RAID 0
b) RAID 1
c) RAID 5
d) RAID 6

---

**20. O que é M.2?**

a) Um tipo de memória RAM
b) Um formato de SSD
c) Um processador
d) Uma porta USB

---

## Parte 2: Rúbrica de Correção do Boss Fight
**Projeto Prático:** Promoção de Domain Controller e Implementação de GPOs

*Critérios para o professor avaliar o desempenho do aluno.*

| Critério de Avaliação | Excelente (100%) | Bom (70%) | Precisa Melhorar (30%) |
| :--- | :--- | :--- | :--- |
| **1. Instalação e Promoção do AD** *(Peso 2.5)* | Configurou o serviço Active Directory Domain Services e promoveu o servidor a Controlador de Domínio (Domain Controller) sem falhas. | Instalou o AD, mas errou no nome do domínio local ou teve dificuldades com a senha do DSRM. | Não conseguiu promover o servidor a Domain Controller. |
| **2. Estrutura de UOs e Usuários** *(Peso 2.5)* | Criou a estrutura de Unidades Organizacionais (UOs), grupos de segurança e contas de usuários seguindo as boas práticas da empresa. | Criou os usuários e UOs, mas errou nas heranças de grupo ou esqueceu de criar algum nível hierárquico. | Criou usuários e grupos soltos na raiz ou não conseguiu criá-los. |
| **3. Configuração de GPOs de Restrição** *(Peso 2.0)* | Vinculou e configurou GPOs restringindo acesso ao Painel de Controle e CMD para a UO correspondente, validando a aplicação. | Criou as GPOs, mas elas não aplicaram de primeira devido a problemas de escopo ou link de UO. | Não soube criar ou aplicar Políticas de Grupo (GPOs). |
| **4. Resolução de Nomes (DNS/DHCP)** *(Peso 1.5)* | Configurou o servidor DNS integrado ao AD e o escopo DHCP para fornecer concessões de IP corretamente na rede local. | Configurou o DNS básico, mas o escopo DHCP apresentou problemas de faixa ou gateway. | Deixou o servidor sem resolver nomes (DNS) ou sem distribuir IPs (DHCP). |
| **5. Auditoria e Logs de Eventos** *(Peso 1.5)* | Configurou as políticas de auditoria de logon e leu corretamente os logs no Visualizador de Eventos (Event Viewer). | Configurou a auditoria, mas teve dificuldades em filtrar os eventos específicos de login no log. | Não soube utilizar o Event Viewer para auditar as ações do sistema. |

**Nota Final do Aluno/Dupla:** ______ / 10,0

---

<details>
<summary><b>GABARITO</b></summary>
1. B 2. B 3. D 4. C 5. C 6. B 7. B 8. A 9. C 10. B 11. B 12. B 13. B 14. B 15. C 16. B 17. A 18. B 19. D 20. B
</details>