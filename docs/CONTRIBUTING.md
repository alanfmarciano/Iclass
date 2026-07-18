# Guia de Contribuição — IClass V3

Como trabalhar neste repositório sem quebrar o que já funciona. Vale para desenvolvedores humanos e agentes de IA (Codex, Claude, Antigravity).

## Antes de começar

1. Leia [AI_CONTEXT_MELHORADO.md](./AI_CONTEXT_MELHORADO.md) (fonte de verdade do produto).
2. Leia o documento de padrão relevante à sua tarefa: [ARQUITETURA](./ARQUITETURA.md), [API](./API.md), [MODELO_DADOS](./MODELO_DADOS.md), [SEGURANCA](./SEGURANCA.md) ou [PADROES_UI](./PADROES_UI.md).
3. **Analise o código existente antes de alterar.** Onde a documentação divergir do código, o **código prevalece** — corrija a documentação junto.

## Princípios não negociáveis

- **Server-authoritative.** Toda regra de negócio, autenticação, liberação de conteúdo e correção de prova ficam no backend. O frontend só apresenta e chama a API.
- **Compatibilidade retroativa.** Dados antigos sem os campos novos devem funcionar com defaults seguros. Nunca faça uma migração que quebre `data/database.db` existente.
- **Preservar padrões existentes.** Reutilize `db.memory` + `db.save()`, `validateAdmin`, o design system em `web/src/components/ui/` e o cliente `lib/api.js`. Não introduza bibliotecas novas sem justificativa.
- **pt-BR na interface e nas mensagens de erro.** Sem anglicismos na UI.
- **Local-first.** Nada pode depender de internet para funcionar.

## Ambiente

- Node.js **20.19+**.
- Instalação: `npm run setup` (instala raiz + `web/`).
- O servidor recusa iniciar se o build estiver ausente ou desatualizado (ver `utils/buildIntegrity.js`). Rode `npm run build` após mudar o frontend.

## Fluxo de trabalho

1. Faça backup de `data/` antes de tarefas sensíveis (menu `[7]` do `.bat` ou cópia manual).
2. Implemente em **passos pequenos**, cada um terminando em estado funcional.
3. Escreva/atualize testes junto com a mudança (ver [TESTES.md](./TESTES.md)).
4. Rode a verificação completa antes de considerar a tarefa pronta:
   ```bash
   npm run check    # test:backend + test:web + build + test:e2e
   ```
5. Atualize a documentação afetada.

## Definição de "pronto"

Uma tarefa só está concluída quando:

- [ ] O comportamento existente não regrediu.
- [ ] `npm run check` passa (ou os testes afetados, quando o ambiente não roda todos).
- [ ] Não há regra de negócio nova no frontend.
- [ ] Dados antigos continuam carregando (compatibilidade retroativa).
- [ ] Textos de UI e erros em pt-BR.
- [ ] Documentação atualizada quando o padrão mudou.

## Commits

- Mensagens no **imperativo** e em pt-BR: `Adiciona limite de tentativas na prova`, `Corrige sanitização do gabarito`.
- Um commit por unidade lógica de mudança. Evite commits gigantes misturando refatoração e feature.
- Não versione `node_modules/`, `data/` (estado real) nem `web/dist/`.

## O que não fazer

- Não expor gabarito, token de prova ou senha ao cliente.
- Não remover funcionalidade existente sem justificativa registrada.
- Não editar `data/database.db` à mão.
- Não criar arquivos monolíticos no frontend (o projeto migrou justamente para sair disso).
