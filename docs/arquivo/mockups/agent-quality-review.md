# Revisão de qualidade — segunda interface IClass

Este documento define critérios objetivos para aprovar o novo **mockup HTML**, antes de qualquer implementação no aplicativo. O alvo é WCAG 2.2 nível AA. A análise considera os mockups atuais e as telas React de login, painel administrativo, seleção de curso, portal do aluno e Identidade Visual.

## Leitura da interface atual

- Os cinco mockups atuais têm linguagem visual consistente: fundo escuro, superfícies em camadas, vermelho como destaque, tipografia sóbria e hierarquia clara.
- Somente o login possui evidência mobile. Os mockups administrativo, cursos e aluno são imagens desktop; portanto, ainda não demonstram reflow, menu móvel nem priorização de conteúdo em telas estreitas.
- A aplicação possui duas arquiteturas principais que precisam continuar reconhecíveis: painel administrativo e portal do aluno, ambos com navegação lateral, barra superior e conteúdo central. O login também possui estados de aluno/instrutor, entrar/cadastrar/recuperar senha.
- A tela Identidade Visual já separa escopo (sistema, escola e curso), modo de cor (claro, escuro e automático) e cores da marca. A futura escolha de interface deve ser um controle separado, com nome/miniatura do estilo e herança por escopo.
- As cores de marca são configuráveis. Logo, nenhum mockup pode depender de uma cor primária específica para continuar legível.
- Há uma boa base técnica no aplicativo: foco visível global, modal com contenção e restauração de foco, menu móvel inerte quando fechado e fallback para `prefers-reduced-motion`.
- Pontos que o novo estilo não deve reproduzir: texto `subtle` sobre superfície escura fica próximo/abaixo do limite para texto normal (aproximadamente 4,43:1), e `subtle` sobre branco fica abaixo (aproximadamente 3,22:1). O vermelho claro padrão sobre branco também não serve como texto normal (aproximadamente 3,91:1). O contraste deve ser medido por combinação e não presumido pelo nome do token.

## Condições obrigatórias de aprovação

O mockup só pode ser recomendado para implementação se cumprir todas estas condições:

1. O aplicativo atual permanece intacto; nesta fase, somente arquivos dentro de `docs/mockups` podem ser criados ou alterados.
2. O HTML permite alternar ou visualizar claramente estados desktop e mobile sem depender de imagens estáticas.
3. As ações essenciais são operáveis somente com teclado, com foco sempre visível e ordem lógica.
4. Uma varredura axe para WCAG 2.2 A/AA não apresenta violações `critical` ou `serious`; violações restantes devem ser documentadas.
5. Texto, controles e foco atendem aos contrastes mínimos definidos abaixo, em claro e escuro.
6. Não há corte de conteúdo nem rolagem horizontal da página a 320 CSS px; tabelas extensas podem ter rolagem local identificada.
7. Com `prefers-reduced-motion: reduce`, movimentos decorativos são removidos e nenhuma informação se perde.
8. A proposta é visualmente diferente do tema premium atual, mas preserva rotas, papéis, dados e tarefas essenciais.

## Rubrica objetiva — 100 pontos

Pontuação mínima recomendada: **85/100**, além de todas as condições obrigatórias.

| Área | Pontos | Evidência exigida |
|---|---:|---|
| Fidelidade funcional e arquitetura | 20 | Navegação e ações críticas de administrador/aluno representadas; nenhum dado importante removido apenas por estética. |
| Qualidade visual e consistência | 20 | Hierarquia nítida, escala tipográfica coerente, espaçamento previsível, estados interativos e identidade própria. |
| Responsividade e toque | 20 | Evidência em 1440, 768, 390 e 320 px; reflow sem perda; alvos de toque adequados. |
| Acessibilidade WCAG 2.2 AA | 25 | Contraste medido, teclado completo, semântica/nomes acessíveis, zoom e reduced motion. |
| Movimento e desempenho | 10 | Animações leves, estáveis e opcionais; sem dependências pesadas sem justificativa; sem erros no console. |
| Compatibilidade com troca de interface | 5 | Prévia do seletor na Identidade Visual, separado de tema claro/escuro e cores da marca. |

## Critérios mensuráveis

### Visual e conteúdo

- Deve existir exatamente um `h1` claro por visão; subtítulos e seções seguem ordem lógica (`h2`, depois `h3`).
- Corpo de texto: mínimo recomendado de 14 px; metadados podem usar 12 px quando não essenciais e quando passarem contraste.
- Texto não pode depender de truncamento para comunicar nome, status ou ação essencial; deve haver quebra, expansão ou nome acessível completo.
- Estados padrão, hover, foco, ativo, selecionado, desabilitado, carregando, vazio e erro precisam ser distinguíveis.
- Cor não pode ser o único indicador de risco, progresso, seleção ou situação; combinar texto, ícone, padrão ou forma.
- Componentes equivalentes usam o mesmo raio, espaçamento, altura e comportamento. O efeito visual não pode competir com dados pedagógicos.

### Contraste e legibilidade

- Texto normal: contraste mínimo de **4,5:1**.
- Texto grande (24 px regular ou 18,66 px em negrito): mínimo de **3:1**.
- Limites de campos, ícones essenciais, seleção e indicador de foco: mínimo de **3:1** contra cores adjacentes.
- O indicador de foco deve ter ao menos 2 px, não ficar encoberto e permanecer visível em claro e escuro.
- Validar no mínimo as combinações: texto/fundo, texto/superfície, texto sutil/superfície, primária/fundo, texto da primária/primária, erro/superfície e foco/fundo.
- Repetir a validação com as paletas configuráveis atuais; se a cor da marca falhar como texto, usá-la apenas como preenchimento/decorativo ou derivar uma tonalidade acessível.

### Responsividade

- Viewports mínimos: **1440×900**, **1280×720**, **768×1024**, **390×844** e **320×568**.
- A 320 px e a 400% de zoom, o conteúdo deve refluír em uma coluna sem rolagem horizontal global.
- Sidebar vira navegação móvel; ao abrir, recebe foco coerente, impede interação com o fundo e fecha por botão, `Escape` e ação de navegação.
- Cards de métricas devem reordenar por prioridade, não apenas encolher. Gráficos devem manter rótulos ou alternativa textual.
- Formulários devem usar rolagem da página em telas baixas; evitar regiões internas pequenas que escondam campos ou prendam o usuário.
- Alvos interativos têm mínimo WCAG de 24×24 CSS px e meta de produto de **44×44 px** para ações principais no toque.

### Teclado, semântica e tecnologia assistiva

- Todo controle é alcançável por `Tab` e ativável por `Enter`/`Espaço`, sem `div` clicável.
- Ordem de foco acompanha a leitura visual; não usar `tabindex` positivo.
- Não pode existir armadilha de teclado. `Escape` fecha menus, popovers e diálogos; ao fechar, o foco retorna ao gatilho.
- Abas devem expor `tablist`, `tab`, `aria-selected` e `tabpanel`, com navegação por setas; seletores visuais devem anunciar a opção ativa.
- Inputs têm `label` persistente; ajuda e erro estão associados por `aria-describedby`; erros dinâmicos são anunciados.
- Usar landmarks (`header`, `nav`, `main`, `aside`) e nomes acessíveis distintos quando houver mais de uma navegação.
- Progresso e gráficos expõem valor/nome em texto; decoração usa `aria-hidden="true"`.
- Texto deve ampliar a 200% sem corte, sobreposição nem perda de função.

### Movimento e desempenho

- Transições de interação: preferência por 120–250 ms; entradas de visão até 400 ms, sem atrasar controles.
- Animar `transform` e `opacity`; evitar animação de layout, blur intenso contínuo e `will-change` permanente em muitos elementos.
- `prefers-reduced-motion: reduce` remove flutuação, parallax, entrada escalada e progresso animado; feedback imediato permanece visível.
- Nenhum conteúdo deve piscar mais de 3 vezes por segundo.
- Three.js só é aceitável se comunicar algo funcional que CSS/SVG não resolve. Se for apenas decoração, reprovar pela relação custo/benefício.
- O mockup deve abrir localmente sem erro no console, sem requisições quebradas e sem depender de CDN para sua estrutura principal.
- Meta para futura implementação: LCP até 2,5 s, CLS até 0,1 e INP até 200 ms no percentil 75; o mockup não deve introduzir arquitetura incompatível com essas metas.

### Troca de interface na Identidade Visual

- Mostrar um campo independente chamado, por exemplo, **Estilo da interface**, sem reutilizar o campo **Tema** (claro/escuro/automático).
- Cada opção apresenta nome, miniatura, descrição curta e estado selecionado perceptível por cor e por texto/ícone.
- Prever pelo menos **Premium atual** e o **novo estilo**, mantendo o atual como fallback seguro.
- A pré-visualização deve demonstrar a combinação: estilo de interface + claro/escuro + cor da marca.
- O mockup deve deixar explícita a herança por sistema, escola ou curso e a opção de restaurar o estilo herdado.
- A simples escolha no mockup não pode sugerir alteração imediata irreversível; indicar `Aplicar`/`Salvar` e fornecer confirmação visual.

## Checklist curto do mockup HTML

### Desktop e mobile

- [ ] 1440, 768, 390 e 320 px revisados; sem corte ou rolagem horizontal global.
- [ ] Menu, cards, gráficos e formulários mudam de composição por prioridade.
- [ ] Alvos principais têm 44×44 px; texto amplia a 200% sem perda.

### Contraste

- [ ] Texto normal ≥ 4,5:1; texto grande e componentes essenciais ≥ 3:1.
- [ ] Claro, escuro e pelo menos três cores primárias diferentes foram medidos.
- [ ] Status e seleção não dependem apenas de cor.

### Reduced motion

- [ ] `prefers-reduced-motion: reduce` elimina movimentos decorativos.
- [ ] Nenhuma informação ou feedback desaparece sem animação.
- [ ] Não há parallax obrigatório, piscadas ou animação contínua custosa.

### Navegação por teclado

- [ ] Toda ação funciona por teclado, com ordem lógica e foco visível.
- [ ] `Escape` fecha camadas; não há armadilhas; foco retorna ao gatilho.
- [ ] Abas, formulários, progresso e estados possuem semântica e nomes acessíveis.

## Evidência para a entrega

Anexar o arquivo HTML, capturas desktop/mobile, resultado axe, tabela de contrastes usada e uma nota curta descrevendo como o mockup se encaixará no seletor de interface da Identidade Visual. Esses artefatos permitem aprovação de estilo sem tocar no código do aplicativo.
