# Proposta de arquitetura — interfaces selecionáveis

**Status:** proposta, não implementada  
**Data:** 13/07/2026  
**Escopo desta etapa:** análise arquitetural somente. O tema atual deve permanecer intacto e o segundo estilo só pode entrar no aplicativo após aprovação do mockup HTML.

## Decisão em uma frase

Manter `premium` como interface padrão e adicionar, depois da aprovação visual, um campo white-label herdável chamado `interfacePreset`; ele selecionará `premium` ou o candidato `lumen` por meio de uma camada de aparência, sem duplicar rotas, dados ou regras de negócio.

`lumen` é apenas o slug candidato do mockup. Ele só deve virar valor público e persistível depois da aprovação do usuário.

## Limites e vocabulário

Há três decisões visuais diferentes e elas não devem continuar misturadas sob a palavra “tema”:

| Conceito | Campo | Responsabilidade |
|---|---|---|
| Marca white-label | `primaryColor`, logos, nome etc. | Identidade da instituição |
| Modo de cor | `themeMode` | Claro, escuro ou automático |
| Interface | `interfacePreset` | Composição, navegação, profundidade, tipografia espacial e movimento |

A escolha de interface não pode substituir as cores, logos, favicon ou nomenclaturas da instituição. Os dois presets devem consumir os mesmos tokens semânticos de marca.

## Estado atual verificado

| Área | Comportamento atual | Implicação |
|---|---|---|
| Dados de branding | Sistema usa o singleton `memoryDB.branding`; escolas e cursos possuem `branding` embutido. | Um campo aditivo pode aproveitar a persistência existente. |
| Herança | `resolveEffectiveBranding` resolve Curso → Escola → Sistema → `DEFAULT_BRANDING`. | `interfacePreset` pode participar da mesma cascata. |
| Banco | Branding global é JSON na tabela `branding`; escola e curso também são persistidos como JSON. | Não é necessária alteração de schema SQLite para um campo novo. |
| API pública | `GET /api/branding` entrega a identidade efetiva e aceita `courseId`. | É o ponto adequado para entregar o preset efetivo em runtime. |
| Escrita global | `POST /api/branding` faz merge do body inteiro. | Deve passar por validação antes de expor enum de interface. |
| Escrita de escola | `extractBranding` filtra as chaves permitidas. | Basta incluir e validar o novo campo. |
| Escrita de curso | `PUT /api/courses/:id` aceita merge genérico do body. | A propriedade `branding` precisa ser filtrada ou escrita por endpoint específico. |
| Frontend | `BrandingProvider` busca a identidade pelo curso e aplica algumas CSS variables. | Pode fornecer os dados, mas a aplicação do preset deve ficar em uma camada de aparência. |
| Modo claro/escuro | `ThemeProvider` usa `localStorage` e sempre inicia em `dark`; `themeMode` do branding não é usado. | É necessário definir precedência e eliminar a competição entre os providers. |
| Tokens | Tailwind aponta para variáveis semânticas de `tokens.css`. | Essa base favorece múltiplas interfaces sem reescrever as páginas. |
| Tela de identidade | Edita sistema/escola/curso e possui preview hard-coded escuro. | O seletor deve usar cards com imagens do mockup e preview isolado, não mutar a aplicação antes de salvar. |

Pontos técnicos que merecem correção no mesmo ciclo futuro:

- Após salvar, `IdentidadePage` altera apenas `--primary`; o `BrandingProvider` não é atualizado, então o restante da aparência pode ficar obsoleto até recarregar.
- `BrandingProvider` só define algumas variáveis quando o valor é truthy. Ao trocar de curso, um valor anterior pode “vazar” se o próximo contexto herdar um valor vazio.
- No editor de escola, o “herdado” vem de `/api/branding` sem identificar a escola. No editor de curso, a resposta efetiva já inclui o próprio curso. Assim, o preview não separa com precisão `raw`, `herdado` e `efetivo`.
- Sem `courseId`, a API atual seleciona a primeira escola. Em instalações multiescola isso torna o contexto do login ambíguo.
- `--secondary` é escrito pelo provider, mas não possui mapeamento equivalente no Tailwind atual.

## ADR-UI-001 — Estratégia para duas interfaces

### Contexto

É necessário conservar a interface atual, oferecer uma segunda aparência realmente distinta e manter uma única aplicação funcional.

### Opções consideradas

| Opção | Vantagens | Desvantagens | Complexidade |
|---|---|---|---|
| Apenas CSS sob `data-interface` | Baixo risco e pouco código | Não sustenta navegações/composições muito diferentes | Baixa |
| Camada híbrida: tokens + variantes dos shells | Permite diferença forte sem duplicar negócio | Exige extrair contratos de layout e navegação | Média |
| Duplicar aplicação, rotas e páginas | Liberdade visual total | Drift funcional, dobro de manutenção e bugs | Muito alta |

### Decisão

Adotar a camada híbrida:

1. Diferenças de cor, raio, sombra, densidade, tipografia e movimento ficam em CSS variables selecionadas por `data-interface`.
2. Diferenças estruturais grandes ficam restritas aos limites de apresentação: login, shell administrativo, shell do aluno, sidebar/topbar e componentes de navegação.
3. Rotas, páginas de função, hooks, APIs, permissões e modelos continuam únicos e compartilhados.

### Consequências

- O candidato Lumen pode usar navegação horizontal e composição editorial sem copiar `App.jsx` ou páginas administrativas.
- Os conteúdos de navegação precisam sair dos shells e virar modelos compartilhados.
- Componentes que possuem cores e medidas hard-coded terão de ser auditados antes de prometer troca completa.
- Three.js não faz parte da arquitetura base. Ele só seria justificável em uma experiência isolada e aprovada; não deve entrar no shell operacional nem no carregamento comum.

## Modelo de dados proposto

Adicionar somente uma chave herdável:

```js
const INTERFACE_PRESETS = ['premium', 'lumen']

const DEFAULT_BRANDING = {
  // campos existentes
  interfacePreset: 'premium',
}
```

Exemplos de persistência:

```json
{
  "displayName": "IClass",
  "primaryColor": "#ef4444",
  "themeMode": "auto",
  "interfacePreset": "premium"
}
```

```json
{
  "id": "escola_123",
  "branding": {
    "primaryColor": "#2457ff",
    "interfacePreset": "lumen"
  }
}
```

```json
{
  "id": "curso_abc",
  "schoolId": "escola_123",
  "branding": {
    "interfacePreset": ""
  }
}
```

O valor vazio mantém a semântica atual de “herdar”. A resolução deve ser:

1. valor do curso, se válido e não vazio;
2. valor da escola, se válido e não vazio;
3. valor do sistema, se válido e não vazio;
4. `premium`.

Regras de proteção:

- Writes com valores desconhecidos devem retornar `400`, não armazenar strings arbitrárias.
- Reads de dados antigos, backups ou valores desconhecidos devem cair silenciosamente em `premium` e registrar aviso de diagnóstico.
- O frontend também deve normalizar para `premium`; nunca deve indexar o registry diretamente com valor não confiável.
- Não é necessário backfill imediato: registros sem a chave já resolvem para `premium`.

Uma única chave para admin e aluno é a opção inicial mais simples e coerente. Campos separados como `adminInterfacePreset` e `studentInterfacePreset` só devem ser considerados se uma necessidade real for aprovada posteriormente.

## Arquitetura de frontend proposta

### 1. Separar dados de branding da aplicação visual

Ordem futura dos providers:

```text
AuthProvider
└── BrandingProvider        (busca e disponibiliza a identidade efetiva)
    └── AppearanceProvider  (resolve modo + preset e aplica os atributos/tokens)
        └── aplicação
```

`BrandingProvider` deve expor pelo menos:

```js
{ branding, loading, refreshBranding }
```

`AppearanceProvider` deve:

- normalizar `interfacePreset`;
- aplicar `document.documentElement.dataset.interface`;
- resolver e aplicar `data-theme`;
- aplicar **todos** os tokens de marca a cada troca de contexto, inclusive fallbacks;
- remover/resetar valores que não existam no novo contexto;
- oferecer `useAppearance()` para os poucos componentes estruturais que precisam conhecer o preset.

### 2. Registry explícito de presets

```js
const PRESET_REGISTRY = {
  premium: {
    label: 'Premium',
    AdminShell: PremiumAdminShell,
    StudentShell: PremiumStudentShell,
    Login: PremiumLogin,
  },
  lumen: {
    label: 'Lumen',
    AdminShell: LumenAdminShell,
    StudentShell: LumenStudentShell,
    Login: LumenLogin,
  },
}
```

Esse registry é código local versionado. O backend persiste apenas o slug; jamais nomes de componentes, caminhos de import ou CSS remoto.

### 3. CSS e Tailwind permanecem semânticos

Estrutura sugerida:

```text
web/src/styles/
├── tokens.css                 # contrato semântico e defaults seguros
├── modes.css                  # claro/escuro
└── presets/
    ├── premium.css            # aparência atual preservada
    └── lumen.css              # aparência aprovada
```

Seletores:

```css
[data-interface='premium'] { /* tokens estruturais atuais */ }
[data-interface='lumen'] { /* tokens estruturais Lumen */ }
```

O Tailwind continua mapeando nomes estáveis, por exemplo `bg-surface`, `text-text`, `border-border`. Podem ser acrescentados tokens estruturais como:

```css
--shell-nav-height;
--content-max-width;
--card-radius;
--control-radius;
--space-section;
--shadow-card;
--motion-enter-duration;
--motion-enter-easing;
```

Os componentes de domínio não devem perguntar “sou Lumen?”. Eles devem consumir tokens e primitivas semânticas. Apenas shells/adapters podem selecionar composição por preset.

### 4. Contratos compartilhados para evitar duplicação

Extrair dos shells atuais:

- modelo de navegação e grupos;
- filtragem por permissões;
- breadcrumb/nomes de rota;
- seletor de curso;
- comandos de sessão, tema e logout.

Premium e Lumen apenas renderizam esse mesmo modelo de formas diferentes. `App.jsx` e todos os `<Route>` permanecem únicos.

### 5. Precedência do modo claro/escuro

Regra proposta:

- `themeMode = light` ou `dark`: configuração institucional fixa;
- `themeMode = auto`: respeita preferência local do usuário; sem preferência, usa `prefers-color-scheme`;
- o preset e o modo são ortogonais: `premium/light`, `premium/dark`, `lumen/light` e `lumen/dark` precisam ser válidos.

Se Lumen for inicialmente light-first, ele ainda precisa de fallback escuro legível antes de ser liberado para uma instituição configurada como `dark`.

## Pontos de integração

| Arquivo/área futura | Alteração planejada |
|---|---|
| `backend/utils/branding.js` | Adicionar enum, default e validação de `interfacePreset`. |
| `backend/routes/common.js` | Sanitizar writes; devolver preset efetivo; definir contexto sem depender implicitamente da primeira escola. |
| Escrita de escola/curso | Garantir `extractBranding` e validação iguais nos três níveis. |
| `BrandingProvider.jsx` | Expor refresh e deixar de ser responsável sozinho pela aplicação visual. |
| `ThemeProvider.jsx` | Ser absorvido/substituído por `AppearanceProvider`, ou ser aninhado depois do branding. |
| `tokens.css` / Tailwind | Separar tokens de marca, modo e preset sem mudar os nomes semânticos usados nas páginas. |
| `IdentidadePage.jsx` | Adicionar seletor “Estilo da interface” com Premium e Lumen, herança visível e preview isolado. |
| `AppShell.jsx`, `StudentShell.jsx`, `LoginPage.jsx` | Virar adapters ou delegar aos shells registrados. |
| `App.jsx` | Continuar com uma única árvore de rotas. |

## Edição e preview na tela de Identidade Visual

O seletor deve aparecer como dois cards com:

- nome e descrição curta;
- thumbnail estática produzida a partir do mockup aprovado;
- indicação “Atual”, “Selecionado” ou “Herdado de …”;
- botão de pré-visualização sem salvar;
- seleção desabilitada para quem não possui permissão.

Para preview completo, usar `iframe` com documento/rota de preview e dados fictícios. Isso impede que CSS de Lumen contamine a tela Premium ou vice-versa. O preview não deve alterar `document.documentElement`, `localStorage` nem a identidade efetiva durante a edição.

É recomendável criar futuramente um endpoint administrativo de contexto:

```http
GET /api/admin/branding-context?scope=school&targetId=escola_123
```

```json
{
  "scope": "school",
  "targetId": "escola_123",
  "raw": { "interfacePreset": "" },
  "inherited": { "interfacePreset": "premium" },
  "effective": { "interfacePreset": "premium" }
}
```

Isso corrige a ambiguidade atual do preview. Um `PATCH` administrativo equivalente pode validar o mesmo contrato nos três níveis; as rotas atuais podem permanecer temporariamente por compatibilidade.

Depois do save, a resposta deve retornar `raw` e `effective`, e a tela deve chamar `refreshBranding()` quando o contexto editado for o contexto ativo.

## Migração e rollout seguros

### Fase 0 — agora

- Produzir somente o mockup HTML Lumen.
- Não editar `web/src`, backend, banco ou `web/dist`.
- Aprovar visual, estados responsivos, claro/escuro e telas de referência.

### Fase 1 — compatibilidade invisível

- Adicionar o campo e a validação no backend.
- Definir `premium` como default para todo dado legado.
- Adicionar testes de herança e persistência.
- Ainda não mostrar o seletor na interface.

### Fase 2 — camada de aparência

- Introduzir `AppearanceProvider`, registry e `data-interface`.
- Registrar apenas `premium` e comprovar que o aplicativo fica visual e funcionalmente equivalente ao estado atual.
- Corrigir refresh/reset de tokens e precedência de `themeMode`.

### Fase 3 — Lumen atrás de disponibilidade controlada

- Implementar Lumen apenas nos limites de apresentação acordados.
- Adicionar testes visuais, responsivos, acessibilidade e fluxos críticos.
- Registrar `lumen`, mas manter todos os dados existentes como `premium`.

### Fase 4 — seletor público na Identidade Visual

- Liberar cards, preview isolado e persistência por sistema/escola/curso.
- Monitorar erros e permitir retorno imediato a Premium.

### Rollback

- Remover `lumen` do registry/da lista selecionável faz qualquer valor persistido cair em `premium`.
- Não apagar o campo do banco durante rollback; isso evita migração destrutiva.
- O mockup e as thumbnails permanecem artefatos independentes em `docs/mockups`.

## Riscos e mitigação

| Risco | Mitigação |
|---|---|
| CSS de um preset vazar para o outro | Seletores sob `data-interface`, tokens com defaults e preview em iframe. |
| Duas interfaces divergirem funcionalmente | Única árvore de rotas, modelos de navegação compartilhados e variantes só nos shells. |
| Valor antigo/inválido quebrar o app | Normalização dupla e fallback `premium`. |
| Flash de interface na carga | HTML inicia em `premium`; mostrar shell somente depois do branding ou usar bootstrap de aparência seguro. |
| Troca de curso manter tokens anteriores | Reaplicar o conjunto completo e resetar variáveis em toda mudança de contexto. |
| Escolha de tema institucional competir com localStorage | Precedência explícita no `AppearanceProvider` e chaves de storage versionadas. |
| Multi-escola usar identidade da escola errada | Contexto explícito por `courseId`/`schoolId`; não depender da primeira escola. |
| Write aceitar campos arbitrários | `extractBranding` e validação em sistema, escola e curso. |
| `customCss` romper isolamento ou segurança | Não usar `customCss` para presets; sanitizar ou restringir essa capacidade separadamente. |
| Aumento de bundle | CSS compartilhado e, se os shells crescerem, lazy loading do preset não ativo. |
| Animação causar desconforto | `prefers-reduced-motion`, movimento opcional e sem WebGL no shell. |

## Matriz mínima de testes antes da liberação

1. Registro legado sem `interfacePreset` abre exatamente em Premium.
2. Sistema = Lumen; escola vazia; curso vazio → Lumen.
3. Sistema = Lumen; escola = Premium; curso vazio → Premium.
4. Curso sobrescreve escola e a troca de curso atualiza a UI sem recarregar.
5. Valor desconhecido em backup cai em Premium.
6. Salvar como administrador persiste após reinício do servidor.
7. Usuário sem `branding.manage` não consegue alterar o preset.
8. Cores, logos, favicon e nomes white-label funcionam nos dois presets.
9. Cada preset passa nos fluxos login, dashboard, navegação, formulário, tabela, modal e portal do aluno.
10. Cada combinação suportada de preset/modo passa por contraste, teclado, leitores de tela e `prefers-reduced-motion`.
11. Testes de screenshot cobrem desktop, tablet e mobile sem comparação cruzada entre presets.
12. Build e testes atuais continuam verdes com `premium` como default.

## Critérios de aceite arquiteturais

- Nenhuma configuração existente muda de aparência sem ação explícita.
- A interface atual continua sendo um preset de primeira classe, não um “legado” descartável.
- A seleção persiste e respeita Curso → Escola → Sistema → Premium.
- O branding white-label é idêntico nos dois presets.
- Rotas, permissões, chamadas de API e regras de negócio não são duplicadas.
- Um preset indisponível nunca impede login ou navegação; Premium é sempre o caminho seguro.
- O mockup HTML é aprovado antes de qualquer implementação no aplicativo.

## Recomendação final

A mudança é viável sem trocar o banco nem reescrever a aplicação. O caminho mais seguro é preservar os componentes funcionais e introduzir uma fronteira de aparência composta por `interfacePreset`, `AppearanceProvider`, tokens selecionáveis e variantes somente nos shells. Lumen deve continuar sendo mockup independente até a aprovação; só então passa a integrar o registry e a tela de Identidade Visual.
