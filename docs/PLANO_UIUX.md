# Plano de UI/UX — Padronização flagship das telas

Objetivo: aplicar em todo o sistema a linguagem visual que travamos no **Painel do aluno**
(a tela-referência), de forma consistente, testável e sem quebrar comportamento existente.

## Linguagem visual (o padrão travado)

- Página com **cabeçalho** padrão: título + subtítulo à esquerda, ações à direita.
- **KPIs** em cartões de indicador (StatCard) no topo quando fizer sentido.
- **Abas** para telas densas (em vez de scroll infinito).
- **Cartões de seção** com respiro; rótulos discretos, valores fortes.
- **Tabelas** limpas (DataTable com busca), linhas clicáveis quando levam a detalhe.
- **Mini-gráficos SVG** (linha, barras), **anel de progresso**, **timeline** — dado vira imagem.
- Uma cor de **destaque** só; cores semânticas apenas para status; dark/light via tokens
  (já reagem ao branding por escola/curso).
- Espaçamento generoso, hierarquia clara, dois pesos de fonte.

## Método por tela (o fluxo que já usamos)

1. **Mockup no chat** (antes/depois) com as cores reais → você aprova ou ajusta.
2. **Implemento** a tela usando os componentes do kit.
3. **Build** (opção 4 + 1) → você confere ao vivo.

Cada tela é um incremento isolado e reversível.

## Fase UI.0 — Kit compartilhado (fundação)

Antes de espalhar, garantir/expandir os componentes reutilizáveis para não reinventar:

- **PageHeader** padronizado (título, subtítulo, área de ações) — criar.
- Já existem e serão reaproveitados: `StatCard`, `Card`, `Tabs`, `DataTable`, `ProgressRing`,
  `MiniLineChart`, `Timeline`, `EmptyState`, `Skeleton`, `Badge`, `Modal`.
- Padrão de **estado de carregamento** (skeletons) e **estado vazio** consistentes.

Resultado: todas as telas seguintes montam sobre o mesmo alicerce.

## Ordem das telas (por impacto e dependência)

### UI.1 — Dashboard (porta de entrada)
KPIs gerais (alunos ativos, provas na semana, progresso médio, alertas), gráfico de
tendência e atalhos. Alto impacto, primeira impressão.

### UI.2 — Avaliações
- **Resultados**: tabela de notas por turma/prova, virando um boletim/analytics com filtros.
- **Provas**: lista e configuração, cartões mais limpos.
- **Monitor Online**: painel de acompanhamento em tempo real — só o visual, preservando a lógica.

### UI.3 — Conteúdo
- **Materiais & Liberação**: lista de itens com liberação clara por turma.
- **Editor de Conteúdo**: layout de edição mais organizado (sem mexer no motor de conteúdo).

### UI.4 — Gestão / Administração
- **Turmas**: gestão com cartões/tabela + vínculo de curso.
- **Contas de acesso** e **Sistema**: já simples; padronizar cabeçalho e espaçamento.
- **Identidade**: já refeita (referência de editor).

### UI.5 — Fórum & Dúvidas
Lista de tópicos/threads mais legível, com timeline de respostas.

### UI.6 — Portal do aluno
Início, Módulos, Provas, Caderno, Dúvidas — a experiência do aluno com a mesma linguagem
(cartões, progresso, leitura confortável da apostila).

### UI.7 — Login + varredura final
Polir o layout do login (centralizado/dividido, usando o branding) e uma passada final de
consistência em todas as telas.

## Critérios de aceite (por tela)

- Cabeçalho no padrão; densidade confortável; hierarquia clara.
- Usa os componentes do kit (nada de estilo solto divergente).
- Dark/light corretos; responsivo (desktop e tablet).
- Branding respeitado (cor/logo por escola/curso).
- Nenhuma funcionalidade existente quebrada (especialmente Monitor/Editor).
- Passa no build do Vite.

## Riscos e cuidados

- **Monitor** e **Editor** têm lógica complexa (tempo real, edição). Mexer só na camada
  visual, preservando comportamento e chamadas de API.
- Telas com muitos dados: preferir abas/paginação a scroll gigante.
- Evitar regressões de permissão: as telas já respeitam RBAC; manter os gates.

## Sequência sugerida de execução

UI.0 (kit) → UI.1 (Dashboard) → UI.2 (Resultados → Provas → Monitor) → UI.3 (Materiais → Editor)
→ UI.4 (Turmas → Contas/Sistema) → UI.5 (Fórum) → UI.6 (Portal do aluno) → UI.7 (Login + revisão final).
