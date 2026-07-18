# Padrões de UI — IClass V3

Padrão visual e de interação da interface. Referência detalhada por tela em [ESPECIFICACAO_UI_PROVAS.md](./ESPECIFICACAO_UI_PROVAS.md) e a linguagem flagship em [PLANO_UIUX.md](./PLANO_UIUX.md). A tela-referência do padrão é o **Painel do aluno**.

## Regra de ouro

Use **somente** o design system existente em `web/src/components/ui/`. Não crie novos primitivos nem importe bibliotecas de UI.

Primitivos disponíveis: `Card`, `Button`, `Badge`, `Modal`, `Tabs`, `Table`, `Select`, `Switch`, `Input`, `Textarea`, `EmptyState`, `PageState`, `PageHeader`, `StatCard`, `Skeleton`, `Timeline`, `ProgressRing`, `MiniLineChart`, `MonthCalendar`, `ThemeToggle`.

## Linguagem visual (padrão travado)

- Página com **cabeçalho** padrão (`PageHeader`): título + subtítulo à esquerda, ações à direita.
- **KPIs** em cartões de indicador (`StatCard`) no topo quando fizer sentido.
- **Abas** (`Tabs`) para telas densas, em vez de scroll infinito.
- **Cartões de seção** (`Card`) com respiro; rótulos discretos, valores fortes.
- **Tabelas** limpas (`Table`) com busca; linhas clicáveis quando levam a detalhe.
- **Dado vira imagem**: `MiniLineChart`, `ProgressRing`, `Timeline`.
- **Uma cor de destaque** só; cores semânticas apenas para status.
- Espaçamento generoso, hierarquia clara, dois pesos de fonte.

## Tokens de cor (nunca hex hardcoded)

Use as classes de token já adotadas no projeto:

- Texto: `text-text`, `text-muted`, `text-subtle`.
- Superfície: `bg-surface`, `bg-surface-2`, `border-border`.
- Semânticas: `bg-primary-soft text-primary`, `bg-success-soft text-success`, `bg-warning-soft text-warning`, `bg-danger-soft text-danger`, `bg-info-soft text-info`.
- Dark/light e branding por escola/curso reagem automaticamente aos tokens (via `ThemeProvider` + `BrandingProvider`). Nunca fixe cor hexadecimal.

Componha classes com o helper `cn()` (`web/src/lib/cn.js`).

## Componentes semânticos

- **Badge**: `success` (aprovado/ok), `warning` (atenção/reprovado leve), `danger` (bloqueio/erro), `info` (informativo/em andamento), `neutral` (inativo/indefinido).
- **Toasts** via `useToast()`: `toast.success(...)`, `toast.info(...)`, e sempre `toast.error(e.message)` para erro de API.
- **Estados de página**: envolver conteúdo dependente de fetch inicial em `PageState` (padrão de `student/ProvasPage.jsx`); usar `Skeleton` no carregamento e `EmptyState` no vazio.

## Formatação de dados

- Datas: `toLocaleString('pt-BR')` / `toLocaleDateString('pt-BR')`.
- Notas em escala 0–10 com 1 casa: `(score/10).toFixed(1)`.

## Acessibilidade (mínimo obrigatório)

- Todo campo com `label`.
- Contadores/timers com `aria-live="polite"`.
- Botões só-ícone com `aria-label`.
- Foco visível preservado; modais fecham com `ESC` (o `Modal` já faz).

## Responsividade

- Grids colapsam para 1 coluna abaixo de `md`.
- Nenhuma tabela nova sem scroll horizontal em telas pequenas (`overflow-x-auto`).

## Idioma

- Todos os textos em **pt-BR**, sem anglicismos (`Tentativas`, não `Attempts`).

## Markdown de conteúdo

Apostilas e avaliações em Markdown são renderizadas via `web/src/lib/contentMarkdown.js` (usa `marked` + `dompurify`). Nunca injete HTML não sanitizado.

## Fluxo ao criar/alterar tela

1. **Mockup no chat** (antes/depois) com as cores reais → aprovar ou ajustar.
2. Implementar reusando primitivos e tokens.
3. Cobrir com teste de componente quando houver interação relevante (ver [TESTES.md](./TESTES.md)).
4. Não introduzir regra de negócio no frontend (ela vive no backend).
