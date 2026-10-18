# 📖 MANUAL REVISADO — Criação de Novas Unidades, Apostilas, Atividades e Avaliações do LMS 4.0

> **Uso deste documento:** este manual deve orientar qualquer professor, admin, Antigravity, Codex ou IA que for criar novos conteúdos para o LMS 4.0. Ele define o padrão de qualidade para **material de estudos dos alunos**, **apostilas**, **atividades**, **avaliações**, **gabaritos**, **rubricas** e **integração técnica com o sistema**.

---

## 1. Objetivo do manual

Este manual existe para garantir que cada nova unidade criada no LMS tenha:

- conteúdo alinhado à referência curricular;
- apostila clara, completa e adequada ao nível dos alunos;
- atividades práticas conectadas ao mercado de trabalho;
- avaliação justa, corrigível e baseada apenas no que foi ensinado;
- gabarito seguro, sem exposição indevida ao aluno;
- arquivos com nomes padronizados para o sistema conseguir carregar o conteúdo corretamente;
- integração correta com módulos, unidades, avaliações e índice do curso.

A regra principal é:

> **Se está na avaliação, deve ter sido ensinado na apostila. Se está na referência curricular, deve estar coberto em alguma unidade.**

---

## 2. Papel deste manual dentro do LMS

Este documento não é apenas um tutorial de arquivos. Ele é um **contrato de produção pedagógica**.

Sempre que uma nova unidade for criada, a IA ou pessoa responsável deve seguir este fluxo:

```txt
Referência curricular oficial
        ↓
Mapa de tópicos da unidade
        ↓
Objetivos de aprendizagem
        ↓
Apostila do aluno
        ↓
Atividades práticas
        ↓
Avaliação objetiva
        ↓
Gabarito e rubrica
        ↓
Integração no LMS
```

Nenhuma avaliação deve ser criada antes da apostila estar pronta.
Nenhuma pergunta deve ser criada se o conteúdo correspondente não estiver explicado no material do aluno.

---

## 3. Público-alvo do conteúdo

O conteúdo deve ser escrito para alunos de cursos técnicos, especialmente alunos do SENAI.

### Perfil esperado

- Idade aproximada: **16 a 22 anos**.
- Formação: ensino médio ou técnico em andamento.
- Contexto: preparação para indústria, escritórios, manutenção, tecnologia, infraestrutura, programação, produtividade e mundo do trabalho.
- Necessidade: aprender com exemplos claros, linguagem direta e aplicação prática.

### Linguagem obrigatória

A apostila deve usar linguagem:

- natural;
- didática;
- acessível;
- profissional, mas sem excesso de termos difíceis;
- com explicações antes de termos técnicos;
- com exemplos práticos do Brasil;
- com analogias quando o assunto for abstrato;
- com tom de professor explicando em sala.

Evitar:

- linguagem excessivamente acadêmica;
- frases genéricas de IA;
- conteúdo superficial;
- listas enormes sem explicação;
- avaliações com pegadinhas injustas;
- perguntas sobre temas não ensinados.

---

## 4. Referências curriculares

O sistema usa arquivos de referência curricular para definir o que deve ser ensinado.

### Referências atuais

```txt
FUTEC.pdf.txt  → Fundamentos de TI — 80h
FECOP.pdf.txt  → Colaboração e Produtividade — 120h
IRCOM.pdf.txt  → Instalação de Recursos Computacionais — 120h
```

Cada referência deve ser tratada como fonte principal de tópicos.

### Estrutura esperada de uma nova referência

```txt
UNIDADE CURRICULAR: [Nome da Unidade Curricular] - XX horas
MÓDULO: [Nome do Módulo]

Objetivo Geral:
[Descrição do objetivo]

1. Tópico Principal
1.1. Subtópico
1.2. Subtópico

2. Tópico Principal
2.1. Subtópico
2.2. Subtópico
```

---

## 5. Mapeamento curricular antes de escrever

Antes de criar uma apostila, é obrigatório montar o mapa da unidade.

### Modelo de mapa

```markdown
# Mapa da Unidade X

## Unidade
Unidade X — [Título]

## Módulo
[FUTEC/FECOP/IRCOM/Novo módulo]

## Carga horária estimada
XX horas

## Tópicos oficiais cobertos
- Tópico 1: [nome]
- Tópico 1.1: [nome]
- Tópico 1.2: [nome]

## Objetivos de aprendizagem
Ao final desta unidade, o aluno deverá ser capaz de:
- explicar [conceito];
- identificar [elemento];
- aplicar [procedimento];
- resolver [situação prática];
- evitar [erro comum].

## Evidências de aprendizagem
O aluno demonstrará aprendizagem por meio de:
- atividade prática;
- checklist;
- quiz;
- avaliação objetiva;
- entrega ou resolução de problema.
```

---

## 6. Estrutura obrigatória da apostila

Cada apostila deve ser um material de estudo completo, não apenas um resumo.

### Tamanho mínimo

- Mínimo recomendado: **400 linhas reais de conteúdo**.
- O mínimo não deve ser atingido com repetição artificial.
- A qualidade vale mais que a quantidade, mas apostilas curtas demais não devem ser aceitas.

### Estrutura mínima

Toda apostila deve conter:

```markdown
# 📁 Unidade X: [Título da Unidade]

> **Módulo:** [Nome do módulo]
> **Carga Horária Estimada:** XX horas
> **Foco da Unidade:** [descrição curta]
> **Baseado nos Tópicos Oficiais:** [tópicos]

---

## 🎯 Objetivos de Aprendizagem

Ao final desta unidade, você será capaz de:
- ...
- ...
- ...

---

## 🧭 Por que este conteúdo importa?

[Explicação prática conectando o assunto com trabalho, escola, indústria ou tecnologia.]

---

## 📘 Capítulo 1: [Título] (Tópico X)

### 1.1 Explicação principal

### 1.2 Exemplo prático

### 1.3 Erros comuns

### 1.4 Checklist de entendimento

---

## 📘 Capítulo 2: [Título] (Tópico Y)

---

## 📘 Capítulo 3: [Título] (Tópico Z)

---

## 🛠️ Atividade prática guiada

---

## 🧪 Desafio de fixação

---

## 📌 Resumo da unidade

---

## 📚 Glossário

---

## ✅ Checklist final do aluno
```

---

## 7. Padrão de capítulos

Cada capítulo deve ensinar de verdade. Não basta citar o tema.

### Cada capítulo deve conter

- explicação do conceito;
- motivo pelo qual o conceito é importante;
- exemplo prático;
- analogia simples, quando útil;
- aplicação no trabalho;
- erros comuns;
- miniatividade ou pergunta de reflexão;
- conexão com o próximo assunto.

### Modelo de capítulo

```markdown
## 📘 Capítulo 1: Sistemas Operacionais (Tópico 1)

### O que é?
[Explicação simples.]

### Por que isso importa?
[Aplicação prática.]

### Exemplo do dia a dia
[Analogia ou situação real.]

### Exemplo no ambiente profissional
[Indústria, escritório, laboratório, manutenção, suporte técnico etc.]

### Erros comuns
- Erro 1: ...
- Erro 2: ...

### Atividade rápida
[Questão ou prática curta.]
```

---

## 8. Padrão de atividades práticas

Toda unidade deve ter pelo menos uma atividade prática.

### Tipos permitidos

- checklist de configuração;
- análise de caso;
- simulação de atendimento técnico;
- pesquisa orientada;
- prática em computador;
- preenchimento de tabela;
- comparação de tecnologias;
- resolução de problema;
- mini projeto;
- atividade em dupla ou grupo.

### Modelo de atividade prática

```markdown
## 🛠️ Atividade Prática: [Nome da atividade]

### Objetivo
[O que o aluno vai praticar.]

### Situação-problema
[Contexto realista.]

### Materiais necessários
- Computador
- Internet, se necessário
- Software X, se necessário

### Passo a passo
1. ...
2. ...
3. ...

### Entrega esperada
O aluno deve entregar:
- ...

### Critérios de sucesso
- [ ] Conseguiu executar o procedimento.
- [ ] Explicou o resultado.
- [ ] Evitou os erros principais.
```

---

## 9. Padrão de avaliação

As avaliações são parte do material dos alunos, mas precisam ser controladas pelo LMS.

### Regra principal

A prova deve avaliar o que foi ensinado na apostila.

Não criar perguntas sobre:

- conteúdo não explicado;
- curiosidades externas;
- detalhes irrelevantes;
- informações desatualizadas;
- pegadinhas ambíguas;
- assuntos que exigem internet se a aula não trabalhou isso.

### Quantidade de perguntas

Cada avaliação deve ter:

- **exatamente 20 questões**;
- múltipla escolha;
- alternativas `a`, `b`, `c`, `d`;
- apenas uma alternativa correta por questão;
- gabarito no final;
- rubrica ou Boss Fight quando houver atividade prática.

### Distribuição recomendada

```txt
Questões 1 a 5    → conceitos básicos
Questões 6 a 10   → compreensão e aplicação
Questões 11 a 15  → situações práticas
Questões 16 a 20  → análise, erros comuns e tomada de decisão
```

### Níveis de dificuldade

A avaliação deve ter equilíbrio:

```txt
30% fácil      → verifica compreensão básica
50% média      → exige aplicação do conteúdo
20% desafiadora → exige análise de cenário
```

---

## 10. Formato obrigatório da avaliação

```markdown
# 📝 Avaliação: Unidade X — [Título da Unidade]

> **Módulo:** [FUTEC/FECOP/IRCOM]
> **Tema:** [Tema]
> **Conteúdo-base:** [Apostila correspondente]
> **Quantidade de questões:** 20

---

## Parte 1: Quiz Teórico

**1. [Pergunta clara e objetiva]**

a) [Alternativa plausível]
b) [Alternativa plausível]
c) [Alternativa correta]
d) [Alternativa plausível]

**2. [Pergunta]**

a) ...
b) ...
c) ...
d) ...

[continuar até a questão 20]

---

<details>
<summary><b>GABARITO</b></summary>

1. c
2. a
3. d
4. b
5. a
6. c
7. b
8. d
9. a
10. c
11. b
12. d
13. a
14. c
15. b
16. d
17. a
18. b
19. c
20. d

</details>
```

---

## 11. Regras de qualidade das questões

Cada questão deve ser:

- clara;
- objetiva;
- sem dupla interpretação;
- conectada a um conteúdo da apostila;
- adequada ao nível técnico;
- contextualizada quando possível;
- corrigível automaticamente.

### Alternativas

As alternativas devem:

- ter tamanho parecido;
- ser plausíveis;
- evitar opções absurdas;
- evitar “todas as anteriores”;
- evitar “nenhuma das anteriores”, salvo necessidade real;
- não denunciar a correta por ser muito mais longa;
- não repetir a mesma letra correta em sequência excessiva.

### Cada questão deve ter rastreabilidade

Ao criar uma avaliação, a IA deve montar uma tabela de rastreabilidade:

```markdown
## 🔎 Mapa da Avaliação

| Questão | Tópico da apostila | Capítulo | Habilidade avaliada | Nível |
|--------|--------------------|----------|---------------------|-------|
| 1 | Sistemas Operacionais | Cap. 1 | Identificar conceito | Fácil |
| 2 | Hardware | Cap. 2 | Aplicar conceito | Médio |
```

Essa tabela pode ficar no arquivo de avaliação ou em uma área interna para revisão do professor.

---

## 12. Segurança do gabarito

O gabarito pode existir no markdown para importação e revisão, mas o sistema não deve exibir respostas corretas ao aluno antes da prova ser encerrada ou liberada para revisão.

### Regras

- O gabarito deve ficar no final do arquivo.
- Usar `<details>` apenas como padrão de organização do markdown.
- Em apostila (material do aluno), gabarito do professor só sob um título ou bloco "Gabarito do professor" (`## Gabarito do professor`, `**Gabarito do professor**` sozinho na linha ou `<details><summary>Gabarito do professor</summary>`): o sistema tira esse trecho da apostila do aluno. "Gabarito" sem a marca do professor (professor, prof., instrutor, docente, exclusivo) é tratado como autocorreção do aluno e aparece.
- No sistema real, a correção deve acontecer no servidor.
- O frontend não deve ser fonte única de validação.
- A prova só deve aparecer para o aluno quando liberada para a turma.

---

## 13. Boss Fight e rubrica

Quando a unidade tiver prática mais complexa, criar uma seção chamada **Boss Fight**.

### Modelo

```markdown
## 🏆 Boss Fight: [Desafio Final]

### Situação
[Problema realista.]

### Missão do aluno
[O que precisa resolver.]

### Entrega
- Arquivo, resposta, print, tabela ou explicação.

### Rubrica de avaliação

| Critério | Excelente | Adequado | Precisa melhorar | Pontos |
|---------|-----------|----------|------------------|--------|
| Entendimento | Explica com clareza | Explica parcialmente | Não explica | 0-2 |
| Execução | Executa corretamente | Executa com pequenos erros | Não conclui | 0-4 |
| Organização | Entrega bem organizada | Entrega aceitável | Entrega confusa | 0-2 |
| Justificativa | Justifica decisões | Justifica parcialmente | Não justifica | 0-2 |
```

---

## 14. Nomenclatura de arquivos

O sistema depende de nomes padronizados.

### Apostilas

```txt
Apostila_Missao_X.md
Apostila_Colaboracao_Missao_X.md
Apostila_IRCOM_Missao_X.md
```

### Avaliações

```txt
Avaliacao_Fundamentos_Missao_X.md
Avaliacao_Colaboracao_Missao_X.md
Avaliacao_IRCOM_Missao_X.md
```

### Regras

- Substituir `X` pelo número da unidade.
- Usar sempre “Unidade X” no título visível ao aluno.
- Evitar acentos e espaços no nome do arquivo.
- Não mudar o padrão sem atualizar o gerador/importador do sistema.

---

## 14.1 Padrão de imagens e mídia

As imagens usadas nas apostilas **não ficam soltas nem no frontend antigo**. Elas moram dentro do projeto, em uma pasta única e padronizada, para que qualquer professor saiba onde inserir o material e o sistema consiga servir tudo automaticamente.

### Onde as imagens ficam

```txt
IclassV3/content/imagens/<curso>/cap<N>/<arquivo>
```

- `<curso>` → sempre em minúsculas: `fecop`, `futec`, `ircom` (ou o código de um novo módulo).
- `cap<N>` → o capítulo da apostila ao qual a imagem pertence (`cap1`, `cap2`, ...).
- `<arquivo>` → nome descritivo, em minúsculas, sem acentos e sem espaços (usar hífen). Ex.: `modelo-osi.svg`, `cpu-hardware.jpg`.

Formatos aceitos: `.svg` (preferido para diagramas), `.png` e `.jpg`.

### Como referenciar dentro do markdown da apostila

Sempre com caminho **relativo começando em `imagens/`** (sem barra inicial, sem `content/`):

```markdown
![Descrição da imagem](imagens/futec/cap2/modelo-osi.svg)
```

O sistema resolve esse caminho sozinho:

```txt
imagens/futec/cap2/modelo-osi.svg          (no markdown)
        ↓  resolveContentUrl
/imagens/futec/cap2/modelo-osi.svg          (URL no navegador)
        ↓  Express (backend/server.js)
content/imagens/futec/cap2/modelo-osi.svg   (arquivo no disco)
```

### Regras

- Uma imagem por arquivo; nunca referenciar imagem que não exista em `content/imagens/`.
- Não usar caminho absoluto (`/imagens/...`) nem prefixo `content/` dentro do markdown — escrever sempre `imagens/<curso>/cap<N>/...`.
- Ao criar uma nova unidade, colocar as imagens na pasta do curso/capítulo **antes** de referenciá-las na apostila.
- Não alterar `resolveContentUrl` (`web/src/lib/contentMarkdown.js`), o mapeamento estático (`backend/server.js`) nem o proxy do Vite: já estão corretos.
- Uploads feitos pelo editor do admin vão para `data/uploads/` e são servidos em `/uploads/` — esse fluxo é separado das imagens fixas das apostilas.

### Checklist de imagens da unidade

- [ ] Todas as imagens estão em `content/imagens/<curso>/cap<N>/`.
- [ ] Os nomes estão em minúsculas, sem acento e sem espaço.
- [ ] Cada `![...](imagens/...)` da apostila aponta para um arquivo existente.
- [ ] A imagem aparece no portal do aluno e na prévia do editor.

---

## 15. Modelo completo de apostila

```markdown
# 📁 Unidade X: [Título da Unidade]

> **Módulo:** [Nome do módulo]
> **Carga Horária Estimada:** XX horas
> **Foco:** [Descrição breve]
> **Baseado nos Tópicos Oficiais:** [Tópico X, X.1, X.2]

---

## 🎯 Objetivos de Aprendizagem

Ao final desta unidade, você será capaz de:
- ...
- ...
- ...

---

## 🧭 Por que este conteúdo importa?

[Texto introdutório contextualizado.]

---

## 📘 Capítulo 1: [Título] (Tópico X)

### O que é?

### Por que isso importa?

### Exemplo prático

### Erros comuns

### Atividade rápida

---

## 📘 Capítulo 2: [Título] (Tópico Y)

---

## 📘 Capítulo 3: [Título] (Tópico Z)

---

## 🛠️ Atividade Prática Guiada

### Objetivo

### Situação-problema

### Passo a passo

### Entrega esperada

---

## 🧪 Desafio de Fixação

---

## 📌 Resumo da Unidade

---

## 📚 Glossário

| Termo | Significado |
|------|-------------|
| ... | ... |

---

## ✅ Checklist Final

- [ ] Entendi os conceitos principais.
- [ ] Consegui explicar com minhas palavras.
- [ ] Fiz a atividade prática.
- [ ] Sei evitar os erros comuns.
```

---

## 16. Modelo completo de avaliação

```markdown
# 📝 Avaliação: Unidade X — [Título da Unidade]

> **Módulo:** [Nome]
> **Tema:** [Tema]
> **Apostila-base:** [Nome do arquivo da apostila]
> **Quantidade de questões:** 20

---

## 🔎 Mapa da Avaliação

| Questão | Conteúdo avaliado | Capítulo da apostila | Dificuldade |
|--------|-------------------|----------------------|-------------|
| 1 | ... | Capítulo 1 | Fácil |
| 2 | ... | Capítulo 1 | Médio |

---

## Parte 1: Quiz Teórico

**1. [Pergunta]**

a) ...
b) ...
c) ...
d) ...

[Questões 2 a 20]

---

<details>
<summary><b>GABARITO</b></summary>

1. a
2. b
3. c
4. d
5. a
6. b
7. c
8. d
9. a
10. b
11. c
12. d
13. a
14. b
15. c
16. d
17. a
18. b
19. c
20. d

</details>
```

---

## 17. Atualização do índice do curso

Quando uma nova unidade for adicionada, atualizar o índice exibido no portal.

### Modelo

```html
<div class="module-index">
  <h4><span class="module-tag basics">FUTEC</span> Fundamentos de TI (80h)</h4>
  <table class="index-table">
    <tr>
      <td><strong>Unidade X</strong></td>
      <td>📝 [Tópicos abordados]</td>
    </tr>
  </table>
</div>
```

No LMS atualizado, se o índice for gerado dinamicamente pelo backend ou `data.js`, priorizar a fonte dinâmica e evitar duplicação manual no HTML.

---

## 18. Geração do `data.js`

Depois de criar ou alterar arquivos `.md`, executar:

```bash
node generate_data.js
```

Esse comando deve ler os arquivos de conteúdo e avaliação e atualizar os dados usados pelo portal.

### Verificações após gerar

- O título da unidade apareceu corretamente?
- A apostila abriu no portal do aluno?
- A avaliação foi reconhecida?
- O gabarito foi interpretado corretamente?
- A unidade aparece no módulo correto?
- A liberação pelo admin funciona?

---

## 20. Checklist para criar uma nova unidade

```markdown
# Checklist — Nova Unidade

## Planejamento
- [ ] Identifiquei o módulo correto.
- [ ] Consultei a referência curricular.
- [ ] Mapeei os tópicos oficiais.
- [ ] Defini objetivos de aprendizagem.
- [ ] Defini evidências de aprendizagem.

## Apostila
- [ ] Criei o arquivo da apostila com nome correto.
- [ ] A apostila tem no mínimo 3 capítulos.
- [ ] A apostila tem conteúdo suficiente e não superficial.
- [ ] Cada capítulo cita o tópico oficial correspondente.
- [ ] Incluí exemplos práticos.
- [ ] Incluí erros comuns.
- [ ] Incluí atividade prática.
- [ ] Incluí resumo.
- [ ] Incluí glossário.

## Avaliação
- [ ] Criei o arquivo da avaliação com nome correto.
- [ ] A avaliação tem exatamente 20 questões.
- [ ] Cada questão possui alternativas a, b, c, d.
- [ ] Cada questão possui apenas uma alternativa correta.
- [ ] O gabarito está no final.
- [ ] Conferi se todas as respostas estão corretas.
- [ ] Nenhuma questão cobra conteúdo não ensinado.
- [ ] Existe mapa da avaliação.

## Integração
- [ ] Executei `node generate_data.js`.
- [ ] Conferi se a unidade aparece no portal do aluno.
- [ ] Conferi se a avaliação aparece no admin.
- [ ] Conferi se a liberação por turma funciona.
- [ ] Conferi se a prova só aparece quando liberada.
- [ ] Conferi se a correção ocorre pelo servidor.
```

---

## 21. Checklist de revisão pedagógica

Antes de aprovar o conteúdo, responder:

```txt
1. O aluno consegue entender o assunto sem depender do professor?
2. A linguagem está adequada para 16 a 22 anos?
3. Existem exemplos próximos da realidade brasileira?
4. A apostila explica o porquê, não só o quê?
5. A atividade prática ajuda a fixar o conteúdo?
6. A avaliação cobra somente o que foi ensinado?
7. O gabarito está correto?
8. Existe equilíbrio de dificuldade?
9. A unidade tem começo, meio e fim?
10. O conteúdo está pronto para ser usado em sala?
```

---

## 22. Checklist de revisão técnica no LMS

```txt
1. O arquivo está com o nome correto?
2. O título está no formato correto?
3. O markdown renderiza sem quebrar?
4. O `data.js` foi gerado?
5. O portal do aluno carrega a unidade?
6. O admin consegue liberar/bloquear a unidade?
7. O admin consegue liberar/bloquear a avaliação?
8. O aluno não vê conteúdo bloqueado?
9. O aluno não vê gabarito antes da hora?
10. A submissão da prova é registrada corretamente?
```

---

## 23. Prompt padrão para pedir uma nova apostila à IA

```markdown
Você deve criar uma nova apostila para o LMS 4.0 seguindo rigorosamente o MANUAL REVISADO — Criação de Novas Unidades, Apostilas, Atividades e Avaliações.

Dados da unidade:
- Módulo: [FUTEC/FECOP/IRCOM]
- Unidade: [número]
- Título: [título]
- Carga horária: [horas]
- Tópicos oficiais: [listar tópicos]
- Público: alunos técnicos do SENAI, 16 a 22 anos

Requisitos:
- mínimo 3 capítulos;
- linguagem clara e didática;
- exemplos do Brasil;
- aplicação prática no mercado de trabalho;
- erros comuns;
- atividade prática guiada;
- desafio de fixação;
- resumo;
- glossário;
- checklist final;
- cada capítulo deve indicar qual tópico oficial está cobrindo.

Não crie avaliação ainda. Primeiro gere apenas a apostila completa.
```

---

## 24. Prompt padrão para pedir uma avaliação à IA

```markdown
Você deve criar a avaliação da Unidade [X] para o LMS 4.0 seguindo rigorosamente o MANUAL REVISADO — Criação de Novas Unidades, Apostilas, Atividades e Avaliações.

Use como base somente a apostila abaixo:
[colar a apostila ou indicar arquivo]

Requisitos:
- exatamente 20 questões;
- múltipla escolha com alternativas a, b, c, d;
- apenas uma alternativa correta;
- gabarito no final dentro de `<details>`;
- mapa da avaliação mostrando questão, capítulo, tópico e dificuldade;
- perguntas claras, sem pegadinhas;
- não cobrar nada que não esteja na apostila;
- distribuir dificuldade em fácil, média e desafiadora.

Antes de finalizar, verifique se cada pergunta tem resposta ensinada na apostila.
```

---

## 25. Prompt padrão para revisar apostila + prova

```markdown
Revise a apostila e a avaliação abaixo como auditor pedagógico do LMS 4.0.

Verifique:
- se todos os tópicos oficiais aparecem na apostila;
- se a apostila tem conteúdo suficiente;
- se a linguagem está adequada para alunos técnicos;
- se há exemplos práticos;
- se a avaliação cobra apenas o que foi ensinado;
- se o gabarito está correto;
- se existe questão ambígua;
- se há equilíbrio de dificuldade;
- se algum conteúdo precisa ser melhorado antes de liberar para alunos.

Entregue:
1. diagnóstico geral;
2. problemas encontrados;
3. correções obrigatórias;
4. sugestões de melhoria;
5. aprovação ou reprovação do material.
```

---

## 26. Regras finais obrigatórias

- Não criar prova antes de criar apostila.
- Não criar pergunta fora do conteúdo ensinado.
- Não usar gabarito como conteúdo visível para aluno antes da liberação correta.
- Não gerar conteúdo raso apenas para cumprir arquivo.
- Não alterar nomes de arquivos sem atualizar o sistema.
- Não esquecer de executar `node generate_data.js` após mudanças.
- Não confiar no frontend para esconder prova, gabarito ou conteúdo bloqueado.
- Sempre validar a liberação por turma no backend.

---

## 27. Resumo executivo

Para criar uma nova unidade com qualidade:

```txt
1. Leia a referência curricular.
2. Escolha os tópicos da unidade.
3. Defina objetivos de aprendizagem.
4. Crie apostila completa.
5. Crie atividade prática.
6. Crie avaliação com 20 questões.
7. Crie gabarito e mapa da avaliação.
8. Revise se tudo que cai na prova foi ensinado.
9. Rode o gerador de dados.
10. Teste no portal do aluno e no painel admin.
```

Este manual deve ser usado como fonte de verdade para produção de conteúdo educacional do LMS 4.0.

